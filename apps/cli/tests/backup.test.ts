import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createBackup, readManifest, restoreBackup } from "../src/commands/backup.ts";
import { loadConfig } from "../src/config.ts";

function write(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function writeDatabase(home: string): void {
  const path = join(home, "orchestrator", "orchestrator.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("schema_version", "5");
  } finally {
    db.close();
  }
}

function configFor(home: string) {
  return loadConfig({ env: { SUPER_RLM_HOME: home }, cwd: tmpdir() });
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("backup copies the runtime, excludes secrets and transient files, and records checksums", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "super-rlm-backup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });

  write(home, "pi/agent/settings.json", JSON.stringify({ theme: "dark" }));
  write(home, "prime/sessions/tkt_1/session.jsonl", "{\"event\":\"start\"}\n");
  write(home, "workspaces/tkt_1/hello.txt", "hello");
  write(home, "secrets/providers.env", "DEEPSEEK_API_KEY=secret\n");
  write(home, "orchestrator/orchestrator.pid", "123");
  write(home, "orchestrator/orchestrator.lock", "123");
  write(home, "orchestrator/orchestrator.log", "log line\n");
  write(home, "prime/agent/logs/worker-1.stderr.log", "stderr\n");
  write(home, "prime/agent/daemon-workers/w/1.recovery.jsonl", "{}\n");
  write(home, "prime/agent/daemon-workers/w/1.recovery.jsonl.writer-lock", "");
  write(home, "prime/agent/session-leases/abc.lock/owner.json", "{}");
  write(home, "pi/agent/prime.sock", "");
  writeDatabase(home);

  const config = configFor(home);
  const now = new Date("2026-01-02T03:04:05.678Z");
  const result = await createBackup(config, join(root, "backups"), { checkServices: false, now });

  assert.equal(result.backupDir, join(root, "backups", "super-rlm-backup-2026-01-02T03-04-05-678Z"));
  const manifest = JSON.parse(readFileSync(join(result.backupDir, "manifest.json"), "utf8"));
  assert.equal(manifest.created_at, now.toISOString());
  assert.equal(manifest.super_rlm_version, "0.1.0");
  assert.equal(manifest.node_version, process.versions.node);
  const primePackage = JSON.parse(readFileSync(join(config.repoRoot, "runtime", "prime-agent", "package.json"), "utf8"));
  assert.equal(manifest.prime_agent_version, primePackage.version);
  assert.equal(manifest.schema_version, 5);
  assert.equal(manifest.included_secrets, false);

  const paths = manifest.files.map((file: { path: string }) => file.path);
  assert.ok(paths.includes("pi/agent/settings.json"));
  assert.ok(paths.includes("prime/sessions/tkt_1/session.jsonl"));
  assert.ok(paths.includes("workspaces/tkt_1/hello.txt"));
  assert.equal(paths.some((path: string) => path.startsWith("secrets/")), false);
  assert.equal(paths.some((path: string) => path.endsWith(".pid")), false);
  assert.equal(paths.some((path: string) => path.endsWith(".lock")), false);
  assert.equal(paths.some((path: string) => path.endsWith(".sock")), false);
  assert.equal(paths.some((path: string) => path.endsWith(".recovery.jsonl")), false);
  assert.equal(paths.some((path: string) => path.includes("/logs/")), false);
  assert.equal(paths.some((path: string) => path.includes(".lock/")), false);
  assert.equal(paths.some((path: string) => path.endsWith(".log")), false);

  for (const file of manifest.files) {
    const path = join(result.backupDir, ...file.path.split("/"));
    assert.equal(statSync(path).size, file.size);
    assert.equal(digest(path), file.sha256);
  }
});

test("restore round-trips files and keeps the previous runtime", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "super-rlm-restore-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const sourceHome = join(root, "source");
  mkdirSync(sourceHome, { recursive: true });
  write(sourceHome, "pi/agent/settings.json", "new settings");
  write(sourceHome, "workspaces/tkt_1/hello.txt", "hello from backup");
  writeDatabase(sourceHome);
  const backup = await createBackup(configFor(sourceHome), join(root, "backups"), { checkServices: false });

  const targetHome = join(root, "target");
  mkdirSync(targetHome, { recursive: true });
  write(targetHome, "pi/agent/settings.json", "old settings");
  write(targetHome, "workspaces/old.txt", "old file");

  const restored = await restoreBackup(configFor(targetHome), backup.backupDir, { checkServices: false });

  assert.equal(restored.home, targetHome);
  assert.equal(restored.restoredFiles, backup.manifest.files.length);
  assert.equal(readFileSync(join(targetHome, "pi", "agent", "settings.json"), "utf8"), "new settings");
  assert.equal(readFileSync(join(targetHome, "workspaces", "tkt_1", "hello.txt"), "utf8"), "hello from backup");
  assert.equal(existsSync(join(targetHome, "workspaces", "old.txt")), false);
  assert.ok(restored.previousHome);
  assert.equal(readFileSync(join(restored.previousHome, "pi", "agent", "settings.json"), "utf8"), "old settings");
  assert.equal(readFileSync(join(restored.previousHome, "workspaces", "old.txt"), "utf8"), "old file");
});

test("restore refuses a backup from a newer schema and leaves the runtime untouched", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "super-rlm-schema-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const sourceHome = join(root, "source");
  mkdirSync(sourceHome, { recursive: true });
  write(sourceHome, "pi/agent/settings.json", "from backup");
  writeDatabase(sourceHome);
  const backup = await createBackup(configFor(sourceHome), join(root, "backups"), { checkServices: false });

  const manifestPath = join(backup.backupDir, "manifest.json");
  const manifest = readManifest(backup.backupDir);
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, schema_version: 6 }, null, 2), "utf8");

  const targetHome = join(root, "target");
  mkdirSync(targetHome, { recursive: true });
  write(targetHome, "keep.txt", "keep");

  await assert.rejects(
    () => restoreBackup(configFor(targetHome), backup.backupDir, { checkServices: false }),
    /newer than this build/,
  );
  assert.equal(readFileSync(join(targetHome, "keep.txt"), "utf8"), "keep");
  assert.equal(readdirSync(dirname(targetHome)).some((name) => name.includes("pre-restore")), false);
});

test("restore preserves existing secrets when the backup excluded them", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "super-rlm-secrets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const sourceHome = join(root, "source");
  mkdirSync(sourceHome, { recursive: true });
  write(sourceHome, "pi/agent/settings.json", "from backup");
  write(sourceHome, "secrets/from-backup.env", "BACKUP_SECRET=1\n");
  const backup = await createBackup(configFor(sourceHome), join(root, "backups"), { checkServices: false });
  assert.equal(backup.manifest.included_secrets, false);

  const targetHome = join(root, "target");
  mkdirSync(targetHome, { recursive: true });
  write(targetHome, "secrets/keep.env", "KEEP_SECRET=1\n");

  await restoreBackup(configFor(targetHome), backup.backupDir, { checkServices: false });

  assert.equal(readFileSync(join(targetHome, "pi", "agent", "settings.json"), "utf8"), "from backup");
  assert.equal(readFileSync(join(targetHome, "secrets", "keep.env"), "utf8"), "KEEP_SECRET=1\n");
  assert.equal(existsSync(join(targetHome, "secrets", "from-backup.env")), false);
});
