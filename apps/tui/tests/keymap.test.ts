import assert from "node:assert/strict";
import test from "node:test";

import { mapKey, type KeyContext } from "../src/keymap.ts";

const base: KeyContext = { view: "chat", focus: "editor", piRunning: false };

test("global keys exit and switch views", () => {
  assert.deepEqual(mapKey("\x03", base), { kind: "exit" });
  assert.deepEqual(mapKey("\x1b[50;5u", base), { kind: "view", view: "tasks" });
  assert.deepEqual(mapKey("\x1b[53;5u", base), { kind: "view", view: "events" });
});

test("chat editor keeps plain text but yields focus and abort", () => {
  assert.equal(mapKey("j", base), null);
  assert.equal(mapKey("hello", base), null);
  assert.deepEqual(mapKey("\t", base), { kind: "focus", area: "sidebar" });
  assert.equal(mapKey("\x1b", base), null);
  assert.deepEqual(mapKey("\x1b", { ...base, piRunning: true }), { kind: "abort" });
});

test("navigation and ticket actions depend on the active view", () => {
  const tasks: KeyContext = { view: "tasks", focus: "main", piRunning: false };
  assert.deepEqual(mapKey("j", tasks), { kind: "move", delta: 1 });
  assert.deepEqual(mapKey("k", tasks), { kind: "move", delta: -1 });
  assert.deepEqual(mapKey("\r", tasks), { kind: "activate" });
  assert.deepEqual(mapKey("\x1b", tasks), { kind: "view", view: "chat" });

  const detail: KeyContext = { view: "detail", focus: "main", piRunning: false };
  assert.deepEqual(mapKey("a", detail), { kind: "answer" });
  assert.deepEqual(mapKey("s", detail), { kind: "resume" });
  assert.deepEqual(mapKey("t", detail), { kind: "retry" });
  assert.deepEqual(mapKey("c", detail), { kind: "cancel" });
  assert.deepEqual(mapKey("q", detail), { kind: "back" });
  assert.deepEqual(mapKey("r", detail), { kind: "refresh" });

  const workers: KeyContext = { view: "workers", focus: "main", piRunning: false };
  assert.deepEqual(mapKey("j", workers), { kind: "scroll", delta: 1 });
});

test("slash opens command mode and sidebar digits switch views", () => {
  const tasks: KeyContext = { view: "tasks", focus: "main", piRunning: false };
  assert.deepEqual(mapKey("/", tasks), { kind: "command" });
  assert.deepEqual(mapKey("f", tasks), { kind: "cycle-filter" });
  assert.equal(mapKey("f", base), null);
  assert.equal(mapKey("f", { view: "detail", focus: "main", piRunning: false }), null);
  const sidebar: KeyContext = { view: "tasks", focus: "sidebar", piRunning: false };
  assert.deepEqual(mapKey("4", sidebar), { kind: "view", view: "workers" });
  assert.deepEqual(mapKey("/", sidebar), { kind: "command" });
});
