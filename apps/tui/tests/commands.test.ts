import assert from "node:assert/strict";
import test from "node:test";

import { parseSlashCommand } from "../src/commands.ts";

test("view commands are not a second switching method", () => {
  assert.deepEqual(parseSlashCommand("/tasks"), { name: "unknown", raw: "/tasks" });
  assert.deepEqual(parseSlashCommand("/workers"), { name: "unknown", raw: "/workers" });
  assert.deepEqual(parseSlashCommand("/events"), { name: "unknown", raw: "/events" });
  assert.deepEqual(parseSlashCommand("/detail"), { name: "unknown", raw: "/detail" });
});

test("parses task filter, search, and clear commands", () => {
  assert.deepEqual(parseSlashCommand("/filter"), { name: "filter" });
  assert.deepEqual(parseSlashCommand("/filter waiting"), { name: "filter", filter: "waiting" });
  assert.deepEqual(parseSlashCommand("/filter TERMINAL"), { name: "filter", filter: "terminal" });
  assert.deepEqual(parseSlashCommand("/filter nope"), { name: "unknown", raw: "/filter nope" });
  assert.deepEqual(parseSlashCommand("/search hello world"), { name: "search", query: "hello world" });
  assert.deepEqual(parseSlashCommand("/search"), { name: "search", query: "" });
  assert.deepEqual(parseSlashCommand("/clear"), { name: "clear" });
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
