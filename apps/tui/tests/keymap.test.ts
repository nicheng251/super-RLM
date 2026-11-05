import assert from "node:assert/strict";
import test from "node:test";

import { mapKey, type KeyContext } from "../src/keymap.ts";

const base: KeyContext = { view: "chat", focus: "editor", piRunning: false };

test("global keys exit and Alt+digit switches views", () => {
  assert.deepEqual(mapKey("\x03", base), { kind: "exit" });
  assert.deepEqual(mapKey("\x1b2", base), { kind: "view", view: "tasks" });
  assert.deepEqual(mapKey("\x1b3", base), { kind: "view", view: "workers" });
  assert.deepEqual(mapKey("\x1b4", base), { kind: "view", view: "events" });
});

test("chat editor keeps plain text and has no Tab focus", () => {
  assert.equal(mapKey("j", base), null);
  assert.equal(mapKey("hello", base), null);
  assert.equal(mapKey("\t", base), null);
  assert.equal(mapKey("\x1b", base), null);
  assert.deepEqual(mapKey("\x1b", { ...base, piRunning: true }), { kind: "abort" });
});

test("navigation and ticket actions depend on the active view", () => {
  const tasks: KeyContext = { view: "tasks", focus: "main", piRunning: false };
  assert.deepEqual(mapKey("j", tasks), { kind: "move", delta: 1 });
  assert.deepEqual(mapKey("k", tasks), { kind: "move", delta: -1 });
  assert.deepEqual(mapKey("\r", tasks), { kind: "activate" });
  assert.equal(mapKey("\x1b", tasks), null);

  const detail: KeyContext = { view: "detail", focus: "main", piRunning: false };
  assert.deepEqual(mapKey("\x1b", detail), { kind: "view", view: "tasks" });
  assert.deepEqual(mapKey("a", detail), { kind: "answer" });
  assert.deepEqual(mapKey("s", detail), { kind: "resume" });
  assert.deepEqual(mapKey("t", detail), { kind: "retry" });
  assert.deepEqual(mapKey("c", detail), { kind: "cancel" });
  assert.equal(mapKey("q", detail), null);
  assert.deepEqual(mapKey("r", detail), { kind: "refresh" });

  const workers: KeyContext = { view: "workers", focus: "main", piRunning: false };
  assert.deepEqual(mapKey("j", workers), { kind: "scroll", delta: 1 });
});

test("slash opens command mode; f filters Tasks", () => {
  const tasks: KeyContext = { view: "tasks", focus: "main", piRunning: false };
  assert.deepEqual(mapKey("/", tasks), { kind: "command" });
  assert.deepEqual(mapKey("f", tasks), { kind: "cycle-filter" });
  assert.equal(mapKey("f", base), null);
  assert.equal(mapKey("f", { view: "detail", focus: "main", piRunning: false }), null);
});

test("Task Detail opens the session view, which locks Alt switching and owns Esc", () => {
  const detail: KeyContext = { view: "detail", focus: "main", piRunning: false };
  assert.deepEqual(mapKey("v", detail), { kind: "open-session" });
  assert.equal(mapKey("v", { view: "tasks", focus: "main", piRunning: false }), null);

  const session: KeyContext = { view: "session", focus: "main", piRunning: false };
  assert.deepEqual(mapKey("\x1b", session), { kind: "view", view: "detail" });
  assert.deepEqual(mapKey("j", session), { kind: "scroll", delta: 1 });
  assert.deepEqual(mapKey("k", session), { kind: "scroll", delta: -1 });
  assert.deepEqual(mapKey("\x1b[B", session), { kind: "scroll", delta: 1 });
  assert.deepEqual(mapKey("r", session), { kind: "refresh" });
  assert.equal(mapKey("\x1b2", session), null);
  assert.equal(mapKey("\x1b3", session), null);
  assert.equal(mapKey("/", session), null);
  assert.deepEqual(mapKey("\x03", session), { kind: "exit" });
});
