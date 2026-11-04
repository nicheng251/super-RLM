
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireLock } from "../src/lock.ts";

test("the lock rejects a second live owner and releases cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-lock-"));
  const lock = acquireLock(dir, process.pid);
  assert.throws(() => acquireLock(dir, process.pid + 1), /already running/);
  lock.release();
  const again = acquireLock(dir, process.pid);
  again.release();
});

test("a stale lock file is replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-lock-"));
  writeFileSync(join(dir, "orchestrator.lock"), "999999");
  const lock = acquireLock(dir, process.pid);
  assert.equal(lock.pid, process.pid);
  lock.release();
});
