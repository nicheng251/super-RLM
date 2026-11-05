
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { Store } from "../src/db.ts";

function columns(store: Store): string[] {
  return (store.db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>).map((row) => row.name);
}

test("a fresh database is at schema v3", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-migrate-"));
  const store = new Store(join(dir, "db.sqlite"));
  const version = store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
  assert.equal(version.value, "3");
  assert.ok(columns(store).includes("priority_next"));
  assert.ok(columns(store).includes("resume_message"));
  assert.ok(columns(store).includes("delivered_to"));
  assert.ok(columns(store).includes("delivery_error"));
  store.close();
});

test("a v1 database gains the v2 and v3 columns without losing data", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-migrate-"));
  const path = join(dir, "db.sqlite");
  const first = new Store(path);
  first.db.exec("ALTER TABLE tickets DROP COLUMN priority_next");
  first.db.exec("ALTER TABLE tickets DROP COLUMN resume_message");
  first.db.exec("ALTER TABLE tickets DROP COLUMN delivered_to");
  first.db.exec("ALTER TABLE tickets DROP COLUMN delivery_error");
  first.db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
  first.db.prepare(`
    INSERT INTO tasks (task_id, prompt, status, metadata, created_at, updated_at, cancel_requested)
    VALUES ('tsk_old', 'old', 'queued', '{}', '2026-01-01', '2026-01-01', 0)
  `).run();
  first.close();

  const second = new Store(path);
  assert.ok(columns(second).includes("priority_next"));
  assert.ok(columns(second).includes("resume_message"));
  assert.ok(columns(second).includes("delivered_to"));
  assert.ok(columns(second).includes("delivery_error"));
  assert.equal(second.getTask("tsk_old")?.prompt, "old");
  second.close();
});

test("a v2 database gains the delivery columns without losing data", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-migrate-"));
  const path = join(dir, "db.sqlite");
  const first = new Store(path);
  first.db.exec("ALTER TABLE tickets DROP COLUMN delivered_to");
  first.db.exec("ALTER TABLE tickets DROP COLUMN delivery_error");
  first.db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
  first.db.prepare(`
    INSERT INTO tasks (task_id, prompt, status, metadata, created_at, updated_at, cancel_requested)
    VALUES ('tsk_old', 'old', 'queued', '{}', '2026-01-01', '2026-01-01', 0)
  `).run();
  first.close();

  const second = new Store(path);
  assert.ok(columns(second).includes("delivered_to"));
  assert.ok(columns(second).includes("delivery_error"));
  assert.equal(second.getTask("tsk_old")?.prompt, "old");
  second.close();
});

test("a newer database is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-migrate-"));
  const path = join(dir, "db.sqlite");
  const store = new Store(path);
  store.db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
  store.close();
  assert.throws(() => new Store(path), /newer than this build/);
});
