import assert from "node:assert/strict";
import test from "node:test";

import { parseSlashCommand, viewForCommand } from "../src/commands.ts";

test("parses view commands", () => {
  assert.deepEqual(parseSlashCommand("/tasks"), { name: "tasks" });
  assert.deepEqual(parseSlashCommand("/workers"), { name: "workers" });
  assert.equal(viewForCommand(parseSlashCommand("/events")!), "events");
});

test("parses detail with an optional task id", () => {
  assert.deepEqual(parseSlashCommand("/detail"), { name: "detail", taskId: undefined });
  assert.deepEqual(parseSlashCommand("/detail tsk_123"), { name: "detail", taskId: "tsk_123" });
  assert.deepEqual(parseSlashCommand("/task tsk_456"), { name: "detail", taskId: "tsk_456" });
});

test("parses actions and rejects unknown commands", () => {
  assert.deepEqual(parseSlashCommand("/refresh"), { name: "refresh" });
  assert.deepEqual(parseSlashCommand("/abort"), { name: "abort" });
  assert.deepEqual(parseSlashCommand("/quit"), { name: "quit" });
  assert.deepEqual(parseSlashCommand("/exit"), { name: "quit" });
  assert.deepEqual(parseSlashCommand("/answer"), { name: "answer" });
  assert.deepEqual(parseSlashCommand("/help"), { name: "help" });
  assert.deepEqual(parseSlashCommand("/nope"), { name: "unknown", raw: "/nope" });
  assert.equal(parseSlashCommand("hello"), null);
});
