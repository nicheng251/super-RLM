/**
 * Offline backup and restore for the project runtime.
 *
 * A backup is a byte-for-byte copy of SUPER_RLM_HOME plus a manifest of
 * checksums. Services must be stopped: SQLite WAL files are copied as-is and
 * the daemon must not be writing sessions while the tree is read.
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CliConfig } from "../config.ts";

export const SUPER_RLM_VERSION = "0.1.0";
export const CURRENT_SCHEMA_VERSION = 3;
const MANIFEST_NAME = "manifest.json";

export interface BackupManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  created_at: string;
  super_rlm_version: string;
  node_version: string;
  prime_agent_version: string | null;
  schema_version: number | null;
  included_secrets: boolean;
  files: BackupManifestFile[];
}

export interface BackupOptions {
  includeSecrets?: boolean;
  checkServices?: boolean;
  now?: Date;
}

export interface BackupResult {
  backupDir: string;
  manifest: BackupManifest;
}

export interface RestoreOptions {
  checkServices?: boolean;
  now?: Date;
}

export interface RestoreResult {
  home: string;
  previousHome: string | null;
  restoredFiles: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function uniquePath(base: string): string {
  if (!existsSync(base)) return base;
  for (let index = 1; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existsSync(candidate)) return candidate;
  }
}

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function urlHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function assertServicesStopped(config: CliConfig): Promise<void> {
  const services = [
    { name: "Orchestrator", url: `${config.orchestratorUrl}/health` },
    { name: "Worker", url: `http://127.0.0.1:${config.workerPort}/v1/health` },
  ];
  const running: string[] = [];
  for (const service of services) {
    if (await urlHealthy(service.url)) running.push(`${service.name} (${service.url})`);
  }
  if (running.length > 0) {
    throw new Error(`${running.join(" and ")} still running. Run \`super-rlm down\` before continuing.`);
  }
}

function readPrimeAgentVersion(repoRoot: string): string | null {
  const path = join(repoRoot, "runtime", "prime-agent", "package.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export function readSchemaVersion(home: string): number | null {
  const path = join(home, "orchestrator", "orchestrator.sqlite");
  if (!existsSync(path)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!row) return null;
    const version = Number(row.value);
    return Number.isInteger(version) ? version : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function isExcluded(relPath: string, isDirectory: boolean, includeSecrets: boolean): boolean {
  const parts = relPath.split("/");
  if (!includeSecrets && parts[0] === "secrets") return true;
  if (parts.some((part) => part === "logs")) return true;
  const name = parts.at(-1) ?? "";
  if (name.endsWith(".pid") || name.endsWith(".lock") || name.endsWith(".writer-lock")) return true;
  if (name.endsWith(".sock")) return true;
  if (name.endsWith(".recovery.jsonl") || name.endsWith(".orphans.jsonl")) return true;
  if (!isDirectory && name.endsWith(".log")) return true;
  return false;
}

function listBackupFiles(home: string, includeSecrets: boolean): string[] {
  const files: string[] = [];
  function walk(relDir: string): void {
    const absolute = relDir ? join(home, ...relDir.split("/")) : home;
    const entries = readdirSync(absolute, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (isExcluded(relPath, entry.isDirectory(), includeSecrets)) continue;
      if (entry.isDirectory()) {
        walk(relPath);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  }
  walk("");
  return files;
}

function toNativePath(root: string, relPath: string): string {
  return join(root, ...relPath.split("/"));
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
    stream.on("error", rejectPromise);
  });
}

async function describeFile(root: string, relPath: string): Promise<BackupManifestFile> {
  const path = toNativePath(root, relPath);
  const stats = statSync(path);
  return { path: relPath, size: stats.size, sha256: await sha256File(path) };
}

function normalizeManifestPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Backup manifest contains an unsafe path: ${value}`);
  }
  const parts = normalized.split("/");
  if (normalized === MANIFEST_NAME || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Backup manifest contains an unsafe path: ${value}`);
  }
  return normalized;
}

export function parseManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== "object") throw new Error("Backup manifest is not an object.");
  const raw = value as Record<string, unknown>;
  if (typeof raw.created_at !== "string") throw new Error("Backup manifest has no created_at.");
  if (typeof raw.super_rlm_version !== "string") throw new Error("Backup manifest has no super_rlm_version.");
  if (typeof raw.node_version !== "string") throw new Error("Backup manifest has no node_version.");
  if (raw.prime_agent_version !== null && typeof raw.prime_agent_version !== "string") {
    throw new Error("Backup manifest has an invalid prime_agent_version.");
  }
  if (raw.schema_version !== null && !Number.isInteger(raw.schema_version)) {
    throw new Error("Backup manifest has an invalid schema_version.");
  }
  if (typeof raw.included_secrets !== "boolean") throw new Error("Backup manifest has no included_secrets.");
  if (!Array.isArray(raw.files)) throw new Error("Backup manifest has no files list.");

  const seen = new Set<string>();
  const files: BackupManifestFile[] = raw.files.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Backup manifest has an invalid file entry.");
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string") throw new Error("Backup manifest file has no path.");
    const path = normalizeManifestPath(file.path);
    if (seen.has(path)) throw new Error(`Backup manifest lists ${path} twice.`);
    seen.add(path);
    if (typeof file.size !== "number" || !Number.isFinite(file.size) || file.size < 0) {
      throw new Error(`Backup manifest has an invalid size for ${path}.`);
    }
    if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(file.sha256)) {
      throw new Error(`Backup manifest has an invalid sha256 for ${path}.`);
    }
    return { path, size: file.size, sha256: file.sha256.toLowerCase() };
  });

  return {
    created_at: raw.created_at,
    super_rlm_version: raw.super_rlm_version,
    node_version: raw.node_version,
    prime_agent_version: raw.prime_agent_version as string | null,
    schema_version: raw.schema_version as number | null,
    included_secrets: raw.included_secrets,
    files,
  };
}

export function readManifest(backupDir: string): BackupManifest {
  const path = join(backupDir, MANIFEST_NAME);
  if (!existsSync(path)) throw new Error(`Not a super-RLM backup: ${path} is missing.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${errorMessage(error)}`);
  }
  return parseManifest(parsed);
}

async function verifyFiles(root: string, files: BackupManifestFile[], label: string): Promise<void> {
  for (const file of files) {
    const path = toNativePath(root, file.path);
    if (!existsSync(path)) throw new Error(`${label} is missing ${file.path}.`);
    const stats = statSync(path);
    if (!stats.isFile()) throw new Error(`${label} has a non-file at ${file.path}.`);
    if (stats.size !== file.size) throw new Error(`${label} size mismatch for ${file.path}.`);
    const digest = await sha256File(path);
    if (digest !== file.sha256) throw new Error(`${label} checksum mismatch for ${file.path}.`);
  }
}

export async function createBackup(
  config: CliConfig,
  destinationDir: string,
  options: BackupOptions = {},
): Promise<BackupResult> {
  const includeSecrets = options.includeSecrets ?? false;
  const now = options.now ?? new Date();
  if (options.checkServices !== false) await assertServicesStopped(config);

  const home = resolve(config.home);
  if (!existsSync(home) || !statSync(home).isDirectory()) {
    throw new Error(`SUPER_RLM_HOME does not exist or is not a directory: ${home}`);
  }
  const destination = resolve(destinationDir);
  if (isInside(home, destination)) {
    throw new Error(`Backup destination must be outside SUPER_RLM_HOME (${home}).`);
  }

  mkdirSync(destination, { recursive: true });
  const backupDir = uniquePath(join(destination, `super-rlm-backup-${fileTimestamp(now)}`));
  mkdirSync(backupDir, { recursive: true });

  const relFiles = listBackupFiles(home, includeSecrets);
  try {
    for (const relPath of relFiles) {
      const target = toNativePath(backupDir, relPath);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(toNativePath(home, relPath), target);
    }

    const files: BackupManifestFile[] = [];
    for (const relPath of relFiles) files.push(await describeFile(backupDir, relPath));
    const manifest: BackupManifest = {
      created_at: now.toISOString(),
      super_rlm_version: SUPER_RLM_VERSION,
      node_version: process.versions.node,
      prime_agent_version: readPrimeAgentVersion(config.repoRoot),
      schema_version: readSchemaVersion(home),
      included_secrets: includeSecrets,
      files,
    };
    writeFileSync(join(backupDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { backupDir, manifest };
  } catch (error) {
    rmSync(backupDir, { recursive: true, force: true });
    throw error;
  }
}

function copySecretsFromHome(home: string, targetHome: string): boolean {
  const secrets = join(home, "secrets");
  if (!existsSync(secrets) || !statSync(secrets).isDirectory()) return false;
  cpSync(secrets, join(targetHome, "secrets"), { recursive: true });
  return true;
}

export async function restoreBackup(
  config: CliConfig,
  backupDir: string,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const now = options.now ?? new Date();
  if (options.checkServices !== false) await assertServicesStopped(config);

  const source = resolve(backupDir);
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`Backup directory does not exist: ${source}`);
  }
  const manifest = readManifest(source);
  if (manifest.schema_version !== null && manifest.schema_version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Backup schema v${manifest.schema_version} is newer than this build (v${CURRENT_SCHEMA_VERSION}).`,
    );
  }
  await verifyFiles(source, manifest.files, "Backup");

  const home = resolve(config.home);
  const parent = dirname(home);
  mkdirSync(parent, { recursive: true });
  const tempHome = uniquePath(join(parent, `.${basename(home)}.restore-${fileTimestamp(now)}`));
  let previousHome: string | null = null;

  try {
    mkdirSync(tempHome, { recursive: true });
    for (const file of manifest.files) {
      const sourcePath = toNativePath(source, file.path);
      const targetPath = toNativePath(tempHome, file.path);
      mkdirSync(dirname(targetPath), { recursive: true });
      cpSync(sourcePath, targetPath);
    }
    await verifyFiles(tempHome, manifest.files, "Staged restore");

    if (!manifest.included_secrets) copySecretsFromHome(home, tempHome);

    if (existsSync(home)) {
      previousHome = uniquePath(join(parent, `${basename(home)}.pre-restore-${fileTimestamp(now)}`));
      renameSync(home, previousHome);
    }
    try {
      renameSync(tempHome, home);
    } catch (error) {
      if (previousHome !== null) renameSync(previousHome, home);
      throw error;
    }
    return { home, previousHome, restoredFiles: manifest.files.length };
  } catch (error) {
    if (existsSync(tempHome)) rmSync(tempHome, { recursive: true, force: true });
    throw error;
  }
}

export async function runBackup(
  config: CliConfig,
  destinationDir: string,
  options: Pick<BackupOptions, "includeSecrets"> = {},
): Promise<number> {
  try {
    const result = await createBackup(config, destinationDir, options);
    console.log(`Backup written to ${result.backupDir}`);
    console.log(`Files: ${result.manifest.files.length}; secrets: ${result.manifest.included_secrets ? "included" : "excluded"}`);
    return 0;
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }
}

export async function runRestore(config: CliConfig, backupDir: string): Promise<number> {
  try {
    const result = await restoreBackup(config, backupDir);
    console.log(`Restored ${result.restoredFiles} files into ${result.home}`);
    if (result.previousHome) console.log(`Previous runtime kept at ${result.previousHome}`);
    return 0;
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }
}
