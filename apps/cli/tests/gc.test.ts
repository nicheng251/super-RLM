import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { isStrictlyInside, managedChildPath, parseGcArgs, runGc } from "../src/commands/gc.ts";
import { loadConfig } from "../src/config.ts";
import type { RunningStack } from "../src/supervisor/detect.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const stoppedStack: RunningStack = {
  orchestrator: { name: "orchestrator", healthy: false, pid: null, alive: false },
  worker: { name: "worker", healthy: false, pid: null, alive: false },
  daemons: [],
  supervisorPid: null,
};

const runningStack: RunningStack = {
  orchestrator: { name: "orchestrator", healthy: true, pid: 4242, alive: true },
  worker: { name: "worker", healthy: false, pid: null, alive: false },
  daemons: [],
  supervisorPid: null,
};

function deps(stack: RunningStack) {
  return { detectStack: async () => stack };
}

interface Fixture {
  root: string;
  home: string;
  workspaceRoot: string;
  config: ReturnType<typeof loadConfig>;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "super-rlm-gc-"));
  const home = join(root, "home");
  const workspaceRoot = join(home, "workspaces");
  mkdirSync(home, { recursive: true });
  const config = loadConfig({
    env: { SUPER_RLM_HOME: home, SUPER_RLM_WORKSPACES: workspaceRoot },
    cwd: tmpdir(),
  });
  return { root, home, workspaceRoot, config };
}

function writeTickets(
  home: string,
  rows: Array<{ ticket: string; ticketStatus: string; task: string; taskStatus: string }>,
): void {
  const path = join(home, "orchestrator", "orchestrator.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE tasks (task_id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    db.exec("CREATE TABLE tickets (ticket_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL)");
    const task = db.prepare("INSERT INTO tasks (task_id, status) VALUES (?, ?)");
    const ticket = db.prepare("INSERT INTO tickets (ticket_id, task_id, status) VALUES (?, ?, ?)");
    const tasks = new Set<string>();
    for (const row of rows) {
      if (!tasks.has(row.task)) {
        task.run(row.task, row.taskStatus);
        tasks.add(row.task);
      }
      ticket.run(row.ticket, row.task, row.ticketStatus);
    }
  } finally {
    db.close();
  }
}

function makeDir(path: string): string {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "payload.txt"), "x\n");
  return path;
}

function ageTree(path: string, days: number): void {
  const stamp = new Date(Date.now() - days * DAY_MS);
  const stats = lstatSync(path);
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    for (const entry of readdirSync(path)) ageTree(join(path, entry), days);
  }
  utimesSync(path, stamp, stamp);
}

async function capture(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(" ")); };
  try {
    const code = await run();
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function gitAvailable(): boolean {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

test("parseGcArgs defaults to a dry run over tmp, sessions, and workspaces", () => {
  assert.deepEqual(parseGcArgs([]), {
    options: { apply: false, olderThanDays: 7, scopes: ["tmp", "sessions", "workspaces"] },
  });
  assert.deepEqual(parseGcArgs(["--apply", "--older-than", "2", "--all"]), {
    options: { apply: true, olderThanDays: 2, scopes: ["tmp", "sessions", "workspaces", "worktrees"] },
  });
  assert.deepEqual(parseGcArgs(["--worktrees", "--older-than=3"]), {
    options: { apply: false, olderThanDays: 3, scopes: ["worktrees"] },
  });
  assert.deepEqual(parseGcArgs(["--dry-run", "--apply", "--dry-run"]), {
    options: { apply: false, olderThanDays: 7, scopes: ["tmp", "sessions", "workspaces"] },
  });
  assert.match((parseGcArgs(["--older-than", "soon"]) as { error: string }).error, /non-negative number/);
  assert.match((parseGcArgs(["--nope"]) as { error: string }).error, /unknown argument/);
});

test("path guards reject traversal, the root itself, and multi-segment names", () => {
  const root = resolve(tmpdir(), "super-rlm-gc-guard");
  assert.equal(managedChildPath(root, ".."), null);
  assert.equal(managedChildPath(root, "../escape"), null);
  assert.equal(managedChildPath(root, join("a", "b")), null);
  assert.equal(managedChildPath(root, ".hidden"), null);
  assert.equal(managedChildPath(root, "tkt_ok"), resolve(root, "tkt_ok"));
  assert.equal(isStrictlyInside(root, root), false);
  assert.equal(isStrictlyInside(root, resolve(root, "..", "escape")), false);
  assert.equal(isStrictlyInside(root, resolve(root, "child")), true);
});

test("dry run reports finished resources and deletes nothing", async (t) => {
  const { root, home, workspaceRoot, config } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTickets(home, [
    { ticket: "tkt_done", ticketStatus: "succeeded", task: "tsk_done", taskStatus: "succeeded" },
    { ticket: "tkt_live", ticketStatus: "running", task: "tsk_live", taskStatus: "running" },
    { ticket: "tkt_recent", ticketStatus: "succeeded", task: "tsk_recent", taskStatus: "succeeded" },
  ]);
  const done = [
    makeDir(join(home, "tmp", "tkt_done")),
    makeDir(join(home, "prime", "sessions", "tkt_done")),
    makeDir(join(workspaceRoot, "tkt_done")),
  ];
  for (const path of done) ageTree(path, 30);
  const live = [
    makeDir(join(home, "tmp", "tkt_live")),
    makeDir(join(workspaceRoot, "tkt_live")),
  ];
  for (const path of live) ageTree(path, 30);
  const recent = makeDir(join(home, "tmp", "tkt_recent"));
  const ghost = makeDir(join(home, "tmp", "tkt_ghost"));
  ageTree(ghost, 30);

  const result = await capture(() => runGc(config, {}, deps(stoppedStack)));
  assert.equal(result.code, 0);
  assert.match(result.stdout, /dry run/);
  assert.match(result.stdout, /would delete\s+tmp\s+.*tkt_done/);
  assert.match(result.stdout, /would delete\s+sessions\s+.*tkt_done/);
  assert.match(result.stdout, /would delete\s+workspaces\s+.*tkt_done/);
  assert.match(result.stdout, /tkt_live — ticket running, task running/);
  assert.match(result.stdout, /tkt_recent — modified .* younger than 7 day/);
  assert.match(result.stdout, /tkt_ghost — ticket is unknown to the Orchestrator/);
  assert.match(result.stdout, /3 would be deleted, 4 skipped/);

  for (const path of [...done, ...live, recent, ghost]) assert.ok(existsSync(path), path);
});

test("apply deletes only terminal, old, known resources", async (t) => {
  const { root, home, workspaceRoot, config } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTickets(home, [
    { ticket: "tkt_done", ticketStatus: "failed", task: "tsk_done", taskStatus: "failed" },
    { ticket: "tkt_task_live", ticketStatus: "succeeded", task: "tsk_live", taskStatus: "running" },
    { ticket: "tkt_queued", ticketStatus: "queued", task: "tsk_queued", taskStatus: "queued" },
  ]);
  const done = [
    makeDir(join(home, "tmp", "tkt_done")),
    makeDir(join(home, "prime", "sessions", "tkt_done")),
    makeDir(join(workspaceRoot, "tkt_done")),
  ];
  const kept = [
    makeDir(join(home, "tmp", "tkt_task_live")),
    makeDir(join(home, "tmp", "tkt_queued")),
    makeDir(join(home, "tmp", "tkt_ghost")),
  ];
  for (const path of [...done, ...kept]) ageTree(path, 30);

  const result = await capture(() => runGc(config, { apply: true }, deps(stoppedStack)));
  assert.equal(result.code, 0);
  assert.match(result.stdout, /3 deleted, 3 skipped/);
  for (const path of done) assert.equal(existsSync(path), false, path);
  for (const path of kept) assert.ok(existsSync(path), path);
});

test("a running stack refuses to delete anything", async (t) => {
  const { root, home, config } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTickets(home, [
    { ticket: "tkt_done", ticketStatus: "succeeded", task: "tsk_done", taskStatus: "succeeded" },
  ]);
  const path = makeDir(join(home, "tmp", "tkt_done"));
  ageTree(path, 30);

  const result = await capture(() => runGc(config, { apply: true }, deps(runningStack)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /stack is running/);
  assert.match(result.stderr, /orchestrator \(pid 4242\)/);
  assert.match(result.stderr, /super-rlm down/);
  assert.ok(existsSync(path));
});

test("a symbolic link under a managed root cannot redirect deletion", async (t) => {
  const { root, home, config } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTickets(home, [
    { ticket: "tkt_link", ticketStatus: "succeeded", task: "tsk_link", taskStatus: "succeeded" },
  ]);
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "keep.txt"), "keep\n");
  mkdirSync(join(home, "tmp"), { recursive: true });
  const link = join(home, "tmp", "tkt_link");
  try {
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("cannot create a directory link on this platform");
    return;
  }
  const stamp = new Date(Date.now() - 30 * DAY_MS);
  utimesSync(outside, stamp, stamp);

  const result = await capture(() => runGc(config, { apply: true, scopes: ["tmp"] }, deps(stoppedStack)));
  assert.equal(result.code, 0);
  assert.ok(existsSync(join(outside, "keep.txt")));
  assert.match(result.stdout, /No matching resources/);
});

test("worktrees: clean finished worktrees are removed, dirty ones are skipped", async (t) => {
  if (!gitAvailable()) {
    t.skip("git is not available");
    return;
  }
  const { root, home, workspaceRoot, config } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTickets(home, [
    { ticket: "tkt_clean", ticketStatus: "succeeded", task: "tsk_clean", taskStatus: "succeeded" },
    { ticket: "tkt_dirty", ticketStatus: "succeeded", task: "tsk_dirty", taskStatus: "succeeded" },
    { ticket: "tkt_live", ticketStatus: "running", task: "tsk_live", taskStatus: "running" },
  ]);

  const repo = join(root, "main-repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q", repo]);
  git(["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);

  const worktrees = new Map<string, string>();
  for (const ticket of ["tkt_clean", "tkt_dirty", "tkt_live"]) {
    const workspace = join(workspaceRoot, ticket);
    const worktree = join(workspace, "repo");
    mkdirSync(workspace, { recursive: true });
    git(["-C", repo, "worktree", "add", "-q", "-b", `super-rlm/${ticket}`, worktree]);
    ageTree(worktree, 30);
    worktrees.set(ticket, worktree);
  }
  writeFileSync(join(worktrees.get("tkt_dirty")!, "dirty.txt"), "uncommitted\n");
  ageTree(worktrees.get("tkt_dirty")!, 30);

  const result = await capture(() => runGc(
    config,
    { apply: true, scopes: ["worktrees"] },
    deps(stoppedStack),
  ));
  assert.equal(result.code, 0);
  assert.match(result.stdout, /1 deleted, 2 skipped/);
  assert.equal(existsSync(worktrees.get("tkt_clean")!), false);
  assert.ok(existsSync(join(worktrees.get("tkt_dirty")!, "dirty.txt")));
  assert.match(result.stdout, /tkt_dirty.*worktree is dirty/);
  assert.match(result.stdout, /tkt_live.*ticket running/);
  assert.ok(existsSync(repo));

  const listed = git(["-C", repo, "worktree", "list", "--porcelain"]);
  assert.doesNotMatch(listed, /tkt_clean/);
  assert.match(listed, /tkt_dirty/);

  // The dirty workspace must not be deleted when workspace cleanup also runs.
  // Re-age it: removing the clean sibling worktree just touched this parent.
  ageTree(join(workspaceRoot, "tkt_dirty"), 30);
  const guarded = await capture(() => runGc(
    config,
    { apply: true, scopes: ["workspaces", "worktrees"] },
    deps(stoppedStack),
  ));
  assert.equal(guarded.code, 0);
  assert.ok(existsSync(join(workspaceRoot, "tkt_dirty")));
  assert.match(guarded.stdout, /git worktree not removed: worktree is dirty/);
});

test("workspaces with worktrees are skipped unless --worktrees is selected", async (t) => {
  const { root, home, workspaceRoot, config } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTickets(home, [
    { ticket: "tkt_done", ticketStatus: "succeeded", task: "tsk_done", taskStatus: "succeeded" },
  ]);
  const workspace = makeDir(join(workspaceRoot, "tkt_done"));
  mkdirSync(join(workspace, "repo"), { recursive: true });
  writeFileSync(join(workspace, "repo", ".git"), "gitdir: somewhere\n");
  ageTree(workspace, 30);

  const result = await capture(() => runGc(config, { apply: true, scopes: ["workspaces"] }, deps(stoppedStack)));
  assert.equal(result.code, 0);
  assert.ok(existsSync(join(workspace, "repo", ".git")));
  assert.match(result.stdout, /contains a git worktree; include --worktrees/);
});
