/**
 * `super-rlm gc`: remove runtime artifacts of finished Tickets.
 *
 * Safety rules, in order:
 * - The stack must be down. A healthy Orchestrator/Worker, a live daemon, a
 *   supervisor PID, or an unknown daemon state refuses the whole command.
 * - The Orchestrator database is the only source of truth for Ticket state.
 *   A resource is eligible only when its Ticket and Task are both terminal.
 *   Missing, unknown, and non-terminal rows are never deleted.
 * - Every delete is confined to its managed root (`tmp`, Prime sessions,
 *   workspaces) and is rejected when the entry is a symlink or escapes the
 *   root by path normalization.
 * - Git worktrees are enumerated with `git worktree list`. Only registered
 *   worktrees inside the workspace root are considered, and only clean ones
 *   are removed, through `git worktree remove` without `--force`.
 *
 * The default scope is `tmp`, `sessions`, and `workspaces`; `worktrees` is
 * opt-in because it changes git metadata. `--all` selects every scope.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  isTerminalTaskStatus,
  isTerminalTicketStatus,
  type TaskStatus,
  type TicketStatus,
} from "../../../../packages/protocol/ts/index.ts";
import type { CliConfig } from "../config.ts";
import {
  describeRunningStack,
  detectRunningStack,
  hasRunningStack,
  type RunningStack,
} from "../supervisor/detect.ts";

export const DEFAULT_OLDER_THAN_DAYS = 7;
export const GC_SCOPES = ["tmp", "sessions", "workspaces", "worktrees"] as const;
export type GcScope = (typeof GC_SCOPES)[number];

const DEFAULT_SCOPES: readonly GcScope[] = ["tmp", "sessions", "workspaces"];
const DAY_MS = 24 * 60 * 60 * 1000;
/** One plain path segment; Ticket ids never contain separators. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface GcOptions {
  apply?: boolean;
  olderThanDays?: number;
  scopes?: readonly GcScope[];
  dbPath?: string;
  now?: Date;
}

export type GcParseResult = { options: GcOptions } | { error: string };

export interface GcDeps {
  detectStack?: (config: CliConfig) => Promise<RunningStack>;
}

export interface TicketState {
  ticketStatus: string;
  taskStatus: string;
  terminal: boolean;
}

interface Candidate {
  kind: GcScope;
  path: string;
  ticketId: string | null;
  ageDays: number;
  action: "delete" | "skip";
  reason?: string;
  removed?: boolean;
}

interface WorktreeEntry {
  path: string;
  repo: string;
  locked: boolean;
  prunable: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatAge(days: number): string {
  if (days < 1 / 24) return "<1h";
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${Math.round(days)}d`;
}

/** True when `candidate` is strictly below `parent` after normalization. */
export function isStrictlyInside(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Return the managed child path for one directory name, or null when the name
 * is not a single safe segment or the result escapes `root`.
 */
export function managedChildPath(root: string, name: string): string | null {
  if (!SEGMENT.test(name) || name === "." || name === "..") return null;
  const path = resolve(root, name);
  return isStrictlyInside(root, path) ? path : null;
}

function normalizedKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** Newest mtime in a tree; symlinks contribute their own mtime and are not followed. */
export function latestMtimeMs(path: string): number {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) return stats.mtimeMs;
  let latest = stats.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    try {
      const childStats = lstatSync(child);
      if (childStats.isSymbolicLink()) {
        latest = Math.max(latest, childStats.mtimeMs);
      } else if (childStats.isDirectory()) {
        latest = Math.max(latest, latestMtimeMs(child));
      } else {
        latest = Math.max(latest, childStats.mtimeMs);
      }
    } catch {
      // An unreadable entry only makes the tree look newer, never older.
    }
  }
  return latest;
}

function listManagedDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const directories: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const path = managedChildPath(root, entry.name);
    if (!path) continue;
    try {
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
    } catch {
      continue;
    }
    directories.push(path);
  }
  return directories.sort();
}

/**
 * Read Ticket and Task terminality from the Orchestrator database.
 * Returns null when the database does not exist yet.
 */
export function readTicketStates(dbPath: string): Map<string, TicketState> | null {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const taskRows = db.prepare("SELECT task_id, status FROM tasks").all() as unknown as Array<{
      task_id: unknown;
      status: unknown;
    }>;
    const taskStatuses = new Map<string, string>();
    for (const row of taskRows) taskStatuses.set(String(row.task_id), String(row.status));
    const ticketRows = db.prepare("SELECT ticket_id, task_id, status FROM tickets").all() as unknown as Array<{
      ticket_id: unknown;
      task_id: unknown;
      status: unknown;
    }>;
    const states = new Map<string, TicketState>();
    for (const row of ticketRows) {
      const ticketId = String(row.ticket_id);
      const ticketStatus = String(row.status);
      const taskStatus = taskStatuses.get(String(row.task_id)) ?? "unknown";
      const terminal = isTerminalTicketStatus(ticketStatus as TicketStatus)
        && isTerminalTaskStatus(taskStatus as TaskStatus);
      states.set(ticketId, { ticketStatus, taskStatus, terminal });
    }
    return states;
  } finally {
    db.close();
  }
}

function evaluateResource(input: {
  kind: GcScope;
  path: string;
  ticketId: string;
  states: Map<string, TicketState> | null;
  cutoffMs: number;
  nowMs: number;
  olderThanDays: number;
}): Candidate {
  const { kind, path, ticketId, states, cutoffMs, nowMs, olderThanDays } = input;
  let mtime: number;
  try {
    mtime = latestMtimeMs(path);
  } catch (error) {
    return { kind, path, ticketId, ageDays: 0, action: "skip", reason: `cannot inspect: ${errorMessage(error)}` };
  }
  const ageDays = Math.max(0, (nowMs - mtime) / DAY_MS);
  const base = { kind, path, ticketId, ageDays };
  const state = states?.get(ticketId);
  if (!state) {
    return {
      ...base,
      action: "skip",
      reason: states === null ? "no Orchestrator database; ticket state unknown" : "ticket is unknown to the Orchestrator",
    };
  }
  if (!state.terminal) {
    return { ...base, action: "skip", reason: `ticket ${state.ticketStatus}, task ${state.taskStatus}` };
  }
  if (mtime > cutoffMs) {
    return {
      ...base,
      action: "skip",
      reason: `modified ${formatAge(ageDays)} ago; younger than ${olderThanDays} day(s)`,
    };
  }
  return { ...base, action: "delete" };
}

function git(args: string[], cwd?: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch (error) {
    const detail = (error as { stderr?: Buffer | string }).stderr;
    const text = detail ? String(detail).trim() : errorMessage(error);
    throw new Error(`git ${args.join(" ")} failed: ${text.slice(0, 300)}`);
  }
}

function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/\\(.)/g, (_, character: string) => (
    character === "n" ? "\n" : character === "t" ? "\t" : character
  ));
}

export function parseWorktreeList(text: string): Array<{ path: string; locked: boolean; prunable: boolean }> {
  const entries: Array<{ path: string; locked: boolean; prunable: boolean }> = [];
  let current: { path: string; locked: boolean; prunable: boolean } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: unquoteGitPath(line.slice("worktree ".length)), locked: false, prunable: false };
    } else if (current && (line === "locked" || line.startsWith("locked "))) {
      current.locked = true;
    } else if (current && (line === "prunable" || line.startsWith("prunable "))) {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** Registered worktrees that live under the managed workspace root. */
export function discoverWorktrees(workspaceRoot: string): WorktreeEntry[] {
  const root = resolve(workspaceRoot);
  const repos = new Map<string, string>();
  for (const workspace of listManagedDirectories(root)) {
    const repoCheckout = join(workspace, "repo");
    if (!existsSync(join(repoCheckout, ".git"))) continue;
    try {
      const common = resolve(repoCheckout, git(["rev-parse", "--git-common-dir"], repoCheckout));
      repos.set(normalizedKey(common), dirname(common));
    } catch {
      // A broken worktree cannot be enumerated; the workspace is skipped later.
    }
  }

  const found = new Map<string, WorktreeEntry>();
  for (const repo of repos.values()) {
    let text: string;
    try {
      text = git(["worktree", "list", "--porcelain"], repo);
    } catch {
      continue;
    }
    for (const entry of parseWorktreeList(text)) {
      const path = resolve(entry.path);
      if (!isStrictlyInside(root, path)) continue;
      found.set(normalizedKey(path), { path, repo, locked: entry.locked, prunable: entry.prunable });
    }
  }
  return [...found.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function worktreeTicketId(workspaceRoot: string, path: string): string | null {
  const rel = relative(resolve(workspaceRoot), resolve(path));
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return null;
  return SEGMENT.test(parts[0]) ? parts[0] : null;
}

function evaluateWorktree(input: {
  entry: WorktreeEntry;
  workspaceRoot: string;
  states: Map<string, TicketState> | null;
  cutoffMs: number;
  nowMs: number;
  olderThanDays: number;
}): Candidate & { entry?: WorktreeEntry } {
  const { entry, workspaceRoot, states, cutoffMs, nowMs, olderThanDays } = input;
  const ticketId = worktreeTicketId(workspaceRoot, entry.path);
  if (!ticketId) {
    return {
      kind: "worktrees",
      path: entry.path,
      ticketId: null,
      ageDays: 0,
      action: "skip",
      reason: "not a managed workspace worktree",
    };
  }
  const evaluated = evaluateResource({
    kind: "worktrees",
    path: entry.path,
    ticketId,
    states,
    cutoffMs,
    nowMs,
    olderThanDays,
  });
  if (evaluated.action === "skip") return { ...evaluated, entry };
  if (entry.locked) return { ...evaluated, action: "skip", reason: "worktree is locked", entry };
  if (entry.prunable) return { ...evaluated, action: "skip", reason: "worktree metadata is prunable", entry };
  try {
    const stats = lstatSync(entry.path);
    if (stats.isSymbolicLink()) return { ...evaluated, action: "skip", reason: "worktree path is a symbolic link", entry };
  } catch (error) {
    return { ...evaluated, action: "skip", reason: `cannot inspect: ${errorMessage(error)}`, entry };
  }
  try {
    const dirty = git(["status", "--porcelain", "--untracked-files=normal"], entry.path);
    if (dirty) {
      const lines = dirty.split(/\r?\n/).filter(Boolean).length;
      return {
        ...evaluated,
        action: "skip",
        reason: `worktree is dirty (${lines} change${lines === 1 ? "" : "s"})`,
        entry,
      };
    }
  } catch (error) {
    return { ...evaluated, action: "skip", reason: `cannot check worktree status: ${errorMessage(error)}`, entry };
  }
  return { ...evaluated, entry };
}

function removeWorktree(candidate: Candidate & { entry?: WorktreeEntry }): { ok: boolean; reason?: string } {
  if (!candidate.entry) return { ok: false, reason: "missing worktree metadata" };
  try {
    git(["worktree", "remove", candidate.entry.path], candidate.entry.repo);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function removeManagedDirectory(
  kind: GcScope,
  root: string,
  path: string,
  repositories: readonly string[],
): { ok: boolean; reason?: string } {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (!isStrictlyInside(resolvedRoot, resolvedPath)) {
    return { ok: false, reason: "path escapes its managed root" };
  }
  if (containsProtectedRepository(resolvedPath, repositories)) {
    return { ok: false, reason: "path contains a protected project repository" };
  }
  let stats;
  try {
    stats = lstatSync(resolvedPath);
  } catch (error) {
    return { ok: false, reason: `cannot inspect: ${errorMessage(error)}` };
  }
  if (stats.isSymbolicLink()) return { ok: false, reason: "path is a symbolic link" };
  if (!stats.isDirectory()) return { ok: false, reason: "path is not a directory" };
  if (kind === "workspaces") {
    if (existsSync(join(resolvedPath, ".git"))) {
      return { ok: false, reason: "workspace contains a git repository at its root" };
    }
  }
  try {
    rmSync(resolvedPath, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function rootFor(config: CliConfig, kind: GcScope): string {
  switch (kind) {
    case "tmp":
      return join(config.home, "tmp");
    case "sessions":
      return process.env.SUPER_RLM_PRIME_SESSIONS ?? join(config.home, "prime", "sessions");
    case "workspaces":
      return config.workspaceRoot;
    case "worktrees":
      return config.workspaceRoot;
  }
}

/** True when `path` is or contains one of the protected repository roots. */
function containsProtectedRepository(path: string, repositories: readonly string[]): boolean {
  const resolved = resolve(path);
  return repositories.some((repo) => resolved === repo || isStrictlyInside(resolved, repo));
}

function applyWorkspaceGuard(
  candidate: Candidate,
  input: {
    scopes: readonly GcScope[];
    apply: boolean;
    worktrees: Map<string, Candidate & { entry?: WorktreeEntry }>;
    repositories: readonly string[];
  },
): Candidate {
  if (candidate.action === "skip") return candidate;
  const { scopes, apply, worktrees, repositories } = input;
  if (containsProtectedRepository(candidate.path, repositories)) {
    return { ...candidate, action: "skip", reason: "contains a protected project repository" };
  }
  if (existsSync(join(candidate.path, ".git"))) {
    return { ...candidate, action: "skip", reason: "workspace contains a git repository at its root" };
  }
  const repoCheckout = join(candidate.path, "repo");
  if (!existsSync(join(repoCheckout, ".git"))) return candidate;
  if (!scopes.includes("worktrees")) {
    return { ...candidate, action: "skip", reason: "contains a git worktree; include --worktrees" };
  }
  const worktree = worktrees.get(normalizedKey(repoCheckout));
  if (!worktree) {
    return { ...candidate, action: "skip", reason: "contains a repository that is not a registered worktree" };
  }
  if (worktree.action !== "delete") {
    return { ...candidate, action: "skip", reason: `git worktree not removed: ${worktree.reason ?? "skipped"}` };
  }
  if (apply && !worktree.removed) {
    return { ...candidate, action: "skip", reason: "git worktree was not removed" };
  }
  return candidate;
}

function printCandidate(candidate: Candidate, apply: boolean): void {
  const label = candidate.action === "delete"
    ? (apply ? "deleted" : "would delete")
    : "skip";
  const detail = candidate.action === "delete"
    ? ` (${formatAge(candidate.ageDays)} old)`
    : candidate.reason ? ` — ${candidate.reason}` : "";
  console.log(`  ${label.padEnd(12)} ${candidate.kind.padEnd(10)} ${candidate.path}${detail}`);
}

export function parseGcArgs(argv: string[]): GcParseResult {
  let apply = false;
  let all = false;
  let olderThanDays = DEFAULT_OLDER_THAN_DAYS;
  const selected = new Set<GcScope>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--dry-run") {
      apply = false;
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--tmp") {
      selected.add("tmp");
    } else if (arg === "--sessions") {
      selected.add("sessions");
    } else if (arg === "--workspaces") {
      selected.add("workspaces");
    } else if (arg === "--worktrees") {
      selected.add("worktrees");
    } else if (arg === "--older-than") {
      const value = argv[index + 1];
      if (value === undefined) return { error: "--older-than requires a number of days" };
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) return { error: `--older-than must be a non-negative number, got ${value}` };
      olderThanDays = parsed;
      index += 1;
    } else if (arg.startsWith("--older-than=")) {
      const value = arg.slice("--older-than=".length);
      const parsed = Number(value);
      if (!value || !Number.isFinite(parsed) || parsed < 0) return { error: `--older-than must be a non-negative number, got ${value}` };
      olderThanDays = parsed;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }

  const scopes: readonly GcScope[] = all
    ? GC_SCOPES
    : selected.size > 0
      ? GC_SCOPES.filter((scope) => selected.has(scope))
      : DEFAULT_SCOPES;
  return { options: { apply, olderThanDays, scopes: [...scopes] } };
}

export async function runGc(
  config: CliConfig,
  options: GcOptions = {},
  deps: GcDeps = {},
): Promise<number> {
  const apply = options.apply === true;
  const olderThanDays = options.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS;
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    console.error(`super-rlm gc: --older-than must be a non-negative number, got ${olderThanDays}`);
    return 1;
  }
  const now = options.now ?? new Date();
  const scopes = options.scopes ?? DEFAULT_SCOPES;
  const dbPath = options.dbPath ?? process.env.SUPER_RLM_DB ?? join(config.home, "orchestrator", "orchestrator.sqlite");
  const cutoffMs = now.getTime() - olderThanDays * DAY_MS;

  const detect = deps.detectStack ?? detectRunningStack;
  let stack: RunningStack;
  try {
    stack = await detect(config);
  } catch (error) {
    console.error(`super-rlm gc: cannot determine whether the stack is running: ${errorMessage(error)}`);
    return 1;
  }
  if (hasRunningStack(stack)) {
    const detail = describeRunningStack(stack).map((line) => `  - ${line}`).join("\n");
    console.error(
      "super-rlm gc: the stack is running; refusing to delete anything.\n"
      + `${detail}\n`
      + "Run `super-rlm down` first.",
    );
    return 1;
  }

  let states: Map<string, TicketState> | null;
  try {
    states = readTicketStates(dbPath);
  } catch (error) {
    console.error(`super-rlm gc: cannot read the Orchestrator database at ${dbPath}: ${errorMessage(error)}`);
    return 1;
  }

  console.log(`super-rlm gc: ${apply ? "apply" : "dry run (nothing is deleted; pass --apply to delete)"}`);
  console.log(`scopes: ${scopes.join(", ")}; older than ${olderThanDays} day(s)`);
  console.log(`database: ${states === null ? `${dbPath} (not found; no resource is known terminal)` : dbPath}`);
  console.log("");

  const results: Candidate[] = [];
  const workspaceRoot = resolve(config.workspaceRoot);
  const projectRepo = process.env.SUPER_RLM_PROJECT_REPO;
  const repositories = [resolve(config.repoRoot)];
  if (projectRepo) repositories.push(resolve(projectRepo));

  if (scopes.includes("worktrees")) {
    const worktrees: Array<Candidate & { entry?: WorktreeEntry }> = [];
    for (const entry of discoverWorktrees(workspaceRoot)) {
      const candidate = evaluateWorktree({
        entry,
        workspaceRoot,
        states,
        cutoffMs,
        nowMs: now.getTime(),
        olderThanDays,
      });
      if (candidate.action === "delete" && containsProtectedRepository(candidate.path, repositories)) {
        candidate.action = "skip";
        candidate.reason = "contains a protected project repository";
      }
      if (candidate.action === "delete" && apply) {
        const removal = removeWorktree(candidate);
        if (removal.ok) {
          candidate.removed = true;
        } else {
          candidate.action = "skip";
          candidate.reason = `git worktree remove failed: ${removal.reason ?? "unknown error"}`;
        }
      }
      worktrees.push(candidate);
    }
    results.push(...worktrees);
  }

  const worktreeByPath = new Map<string, Candidate & { entry?: WorktreeEntry }>();
  for (const candidate of results) {
    if (candidate.kind === "worktrees") worktreeByPath.set(normalizedKey(candidate.path), candidate as Candidate & { entry?: WorktreeEntry });
  }

  for (const kind of ["tmp", "sessions", "workspaces"] as const) {
    if (!scopes.includes(kind)) continue;
    const root = rootFor(config, kind);
    for (const path of listManagedDirectories(root)) {
      const ticketId = basename(path);
      let candidate = evaluateResource({
        kind,
        path,
        ticketId,
        states,
        cutoffMs,
        nowMs: now.getTime(),
        olderThanDays,
      });
      if (kind === "workspaces") {
        candidate = applyWorkspaceGuard(candidate, {
          scopes,
          apply,
          worktrees: worktreeByPath,
          repositories,
        });
      }
      if (candidate.action === "delete" && apply) {
        const removal = removeManagedDirectory(kind, root, path, repositories);
        if (removal.ok) {
          candidate.removed = true;
        } else {
          candidate.action = "skip";
          candidate.reason = removal.reason ?? "deletion failed";
        }
      }
      results.push(candidate);
    }
  }

  if (results.length === 0) {
    console.log("No matching resources.");
    return 0;
  }
  for (const candidate of results) printCandidate(candidate, apply);

  const deletable = results.filter((candidate) => candidate.action === "delete").length;
  const removed = results.filter((candidate) => candidate.removed === true).length;
  const skipped = results.filter((candidate) => candidate.action === "skip").length;
  console.log("");
  if (apply) {
    console.log(`${removed} deleted, ${skipped} skipped.`);
  } else {
    console.log(`${deletable} would be deleted, ${skipped} skipped (dry run; nothing deleted).`);
  }
  return 0;
}
