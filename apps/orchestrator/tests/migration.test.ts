import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { Store } from "../src/db.ts";

function columns(store: Store): string[] {
  return (store.db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>).map((row) => row.name);
}

function tableNames(store: Store): string[] {
  return (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function metaVersion(store: Store): string | undefined {
  const row = store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row?.value;
}

function assertMigrated(store: Store): void {
  assert.equal(metaVersion(store), "5");
  assert.ok(tableNames(store).includes("outbox"));
}

interface MigrationSidecar {
  source: string;
  old_version: number;
  target_version: number;
  created_at: string;
}

function assertPreMigrationBackup(dbPath: string, oldVersion: number): void {
  const backupDir = join(dirname(dbPath), "backups");
  assert.ok(existsSync(backupDir), `missing backup directory ${backupDir}`);
  const names = readdirSync(backupDir).sort();
  const matches = names.filter((name) => name.startsWith(`pre-migration-v${oldVersion}-`) && name.endsWith(".sqlite"));
  assert.equal(matches.length, 1, `expected one v${oldVersion} backup, got ${names.join(", ")}`);
  const backupPath = join(backupDir, matches[0]);
  const sidecar = JSON.parse(readFileSync(`${backupPath}.json`, "utf8")) as MigrationSidecar;
  assert.equal(sidecar.source, resolve(dbPath));
  assert.equal(sidecar.old_version, oldVersion);
  assert.equal(sidecar.target_version, 5);
  assert.equal(typeof sidecar.created_at, "string");
  assert.ok(!Number.isNaN(Date.parse(sidecar.created_at)));

  const backupDb = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const row = backupDb.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    assert.equal(row?.value, String(oldVersion));
  } finally {
    backupDb.close();
  }
}

test("a fresh database is at schema v5 and creates no pre-migration backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-migrate-"));
  const store = new Store(join(dir, "db.sqlite"));
  assert.equal(metaVersion(store), "5");
  assert.ok(columns(store).includes("priority_next"));
  assert.ok(columns(store).includes("resume_message"));
  assert.ok(columns(store).includes("delivered_to"));
  assert.ok(columns(store).includes("delivery_error"));
  assert.ok(columns(store).includes("workspace_metadata"));
  assert.ok(columns(store).includes("metadata_error"));
  assert.ok(tableNames(store).includes("outbox"));
  assert.equal(existsSync(join(dir, "backups")), false);
  store.close();
});

test("a v1 database is backed up and gains the v2-v5 schema without losing data", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-migrate-"));
  const path = join(dir, "db.sqlite");
  const first = new Store(path);
  first.db.exec("ALTER TABLE tickets DROP COLUMN priority_next");
  first.db.exec("ALTER TABLE tickets DROP COLUMN resume_message");
  first.db.exec("ALTER TABLE tickets DROP COLUMN delivered_to");
  first.db.exec("ALTER TABLE tickets DROP COLUMN delivery_error");
  first.db.exec("ALTER TABLE tickets DROP COLUMN workspace_metadata");
  first.db.exec("ALTER TABLE tickets DROP COLUMN metadata_error");
  first.db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
  first.db.prepare(`
    INSERT INTO tasks (task_id, prompt, status, metadata, created_at, updated_at, cancel_requested)
    VALUES ('tsk_old', 'old', 'queued', '{}', '2026-01-01', '2026-01-01', 0)
  `).run();
  first.close();

  const second = new Store(path);
  assertMigrated(second);
  assert.ok(columns(second).includes("priority_next"));
  assert.ok(columns(second).includes("resume_message"));
  assert.ok(columns(second).includes("delivered_to"));
  assert.ok(columns(second).includes("delivery_error"));
  assert.ok(columns(second).includes("workspace_metadata"));
  assert.ok(columns(second).includes("metadata_error"));
  assert.equal(second.getTask("tsk_old")?.prompt, "old");
  second.close();
  assertPreMigrationBackup(path, 1);
});

test("a v2 database is backed up and gains the v3-v5 schema without losing data", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-migrate-"));
  const path = join(dir, "db.sqlite");
  const first = new Store(path);
  first.db.exec("ALTER TABLE tickets DROP COLUMN delivered_to");
  first.db.exec("ALTER TABLE tickets DROP COLUMN delivery_error");
  first.db.exec("ALTER TABLE tickets DROP COLUMN workspace_metadata");
  first.db.exec("ALTER TABLE tickets DROP COLUMN metadata_error");
  first.db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
  first.db.prepare(`
    INSERT INTO tasks (task_id, prompt, status, metadata, created_at, updated_at, cancel_requested)
    VALUES ('tsk_old', 'old', 'queued', '{}', '2026-01-01', '2026-01-01', 0)
  `).run();
  first.close();

  const second = new Store(path);
  assertMigrated(second);
  assert.ok(columns(second).includes("delivered_to"));
  assert.ok(columns(second).includes("delivery_error"));
  assert.ok(columns(second).includes("workspace_metadata"));
  assert.ok(columns(second).includes("metadata_error"));
  assert.equal(second.getTask("tsk_old")?.prompt, "old");
  second.close();
  assertPreMigrationBackup(path, 2);
});

test("a v3 database is backed up and gains the workspace metadata columns without losing data", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-migrate-"));
  const path = join(dir, "db.sqlite");
  const first = new Store(path);
  first.db.exec("ALTER TABLE tickets DROP COLUMN workspace_metadata");
  first.db.exec("ALTER TABLE tickets DROP COLUMN metadata_error");
  first.db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
  first.db.prepare(`
    INSERT INTO tasks (task_id, prompt, status, metadata, created_at, updated_at, cancel_requested)
    VALUES ('tsk_old', 'old', 'queued', '{}', '2026-01-01', '2026-01-01', 0)
  `).run();
  first.close();

  const second = new Store(path);
  assertMigrated(second);
  assert.ok(columns(second).includes("workspace_metadata"));
  assert.ok(columns(second).includes("metadata_error"));
  assert.equal(second.getTask("tsk_old")?.prompt, "old");
  second.close();
  assertPreMigrationBackup(path, 3);
});

test("a v4 database is backed up and gains the outbox table without losing data", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-migrate-"));
  const path = join(dir, "db.sqlite");
  const first = new Store(path);
  first.db.exec("DROP TABLE outbox");
  first.db.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run();
  first.db.prepare(`
    INSERT INTO tasks (task_id, prompt, status, metadata, created_at, updated_at, cancel_requested)
    VALUES ('tsk_old', 'old', 'queued', '{}', '2026-01-01', '2026-01-01', 0)
  `).run();
  first.close();

  const second = new Store(path);
  assertMigrated(second);
  assert.equal(second.getTask("tsk_old")?.prompt, "old");
  const indexes = (second.db.prepare("PRAGMA index_list(outbox)").all() as Array<{ name: string }>).map((row) => row.name);
  assert.ok(indexes.includes("outbox_status_next_idx"));
  second.close();
  assertPreMigrationBackup(path, 4);
});

test("a newer database is refused without a backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-migrate-"));
  const path = join(dir, "db.sqlite");
  const store = new Store(path);
  store.db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
  store.close();
  assert.throws(() => new Store(path), /newer than this build/);
  assert.equal(existsSync(join(dir, "backups")), false);
});

test("outbox enqueue is idempotent and due/delivery/failure transitions work", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-outbox-"));
  const store = new Store(join(dir, "db.sqlite"));

  store.enqueueOutbox({ eventId: 7, target: "router:callback", payload: { task_id: "tsk_1" }, now: "2026-01-01T00:00:00.000Z" });
  store.enqueueOutbox({ eventId: 7, target: "router:callback", payload: { task_id: "duplicate" }, now: "2026-01-01T00:00:00.000Z" });
  store.enqueueOutbox({ eventId: 7, target: "router:events", payload: { task_id: "tsk_1" }, now: "2026-01-01T00:00:00.000Z" });
  const count = store.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number };
  assert.equal(Number(count.n), 2);

  const due = store.dueOutbox("2026-01-01T00:00:00.000Z");
  assert.equal(due.length, 2);
  assert.deepEqual(due.map((row) => row.target), ["router:callback", "router:events"]);
  assert.deepEqual(due[0].payload, { task_id: "tsk_1" });
  assert.equal(due[0].status, "pending");
  assert.equal(due[0].attempts, 0);
  assert.equal(due[0].delivered_at, null);
  assert.equal(due[0].last_error, null);

  store.markOutboxDelivered(due[0].outbox_id, "2026-01-01T00:01:00.000Z");
  const delivered = store.getOutbox(due[0].outbox_id);
  assert.equal(delivered?.status, "delivered");
  assert.equal(delivered?.delivered_at, "2026-01-01T00:01:00.000Z");
  assert.equal(delivered?.updated_at, "2026-01-01T00:01:00.000Z");

  store.markOutboxFailed(
    due[1].outbox_id,
    { attempts: 3, nextAttemptAt: "2026-01-01T00:05:00.000Z", error: "connect ECONNREFUSED" },
    "2026-01-01T00:02:00.000Z",
  );
  const retry = store.getOutbox(due[1].outbox_id);
  assert.equal(retry?.status, "pending");
  assert.equal(retry?.attempts, 3);
  assert.equal(retry?.next_attempt_at, "2026-01-01T00:05:00.000Z");
  assert.equal(retry?.last_error, "connect ECONNREFUSED");
  assert.deepEqual(store.dueOutbox("2026-01-01T00:04:00.000Z"), []);
  assert.deepEqual(store.dueOutbox("2026-01-01T00:06:00.000Z").map((row) => row.outbox_id), [due[1].outbox_id]);

  store.markOutboxFailed(due[1].outbox_id, {
    attempts: 8,
    nextAttemptAt: "2026-01-01T00:06:00.000Z",
    error: "gave up",
    status: "failed",
  });
  const dead = store.getOutbox(due[1].outbox_id);
  assert.equal(dead?.status, "failed");
  assert.equal(dead?.attempts, 8);
  assert.deepEqual(store.dueOutbox("2026-01-02T00:00:00.000Z"), []);

  store.close();
});
