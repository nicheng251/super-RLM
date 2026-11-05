import assert from "node:assert/strict";
import test from "node:test";

import { ModelSelector, type SelectorModel, type SelectorProfile } from "../src/ui/model-selector.ts";

const profiles: SelectorProfile[] = [
  { key: "router", label: "Router", kind: "router", provider: "deepseek", model: "deepseek-flash", thinking: "medium", contextWindow: 1048576 },
  { key: "git", label: "Worker: git", kind: "worker", provider: "deepseek", model: "deepseek-flash", thinking: "medium", contextWindow: 1048576 },
];
const models: SelectorModel[] = [
  { provider: "deepseek", id: "deepseek-flash", contextWindow: 1048576, reasoning: true },
  { provider: "deepseek", id: "deepseek-pro", contextWindow: 2097152, reasoning: true },
];

test("left/right adjusts thinking", () => {
  const selector = new ModelSelector(profiles, models);
  selector.handleInput("\x1b[D");
  assert.equal(selector.profiles[0].thinking, "low");
  selector.handleInput("\x1b[C");
  selector.handleInput("\x1b[C");
  assert.equal(selector.profiles[0].thinking, "high");
});

test("Tab selects the model pane and Enter applies the selected model", () => {
  const selector = new ModelSelector(profiles, models);
  const applied: SelectorProfile[] = [];
  selector.onApply = (profile) => { applied.push(profile); };
  selector.handleInput("\t");
  selector.handleInput("\x1b[B");
  selector.handleInput("\r");
  assert.equal(applied[0]?.model, "deepseek-pro");
  assert.equal(applied[0]?.contextWindow, 2097152);
});

test("Esc closes and Alt sequences do not switch or apply", () => {
  const selector = new ModelSelector(profiles, models);
  let closed = false;
  let applied = false;
  selector.onClose = () => { closed = true; };
  selector.onApply = () => { applied = true; };
  selector.handleInput("\x1b2");
  assert.equal(closed, false);
  assert.equal(applied, false);
  selector.handleInput("\x1b");
  assert.equal(closed, true);
});
