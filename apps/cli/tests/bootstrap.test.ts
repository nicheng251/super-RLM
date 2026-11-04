
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";

import { bootstrapPlan } from "../src/commands/bootstrap.ts";
import { loadConfig } from "../src/config.ts";

test("bootstrap plans venv, runtime, defaults, and report skill", () => {
  const config = loadConfig({ env: { SUPER_RLM_HOME: "/tmp/super-rlm-bootstrap" }, cwd: tmpdir() });
  const plan = bootstrapPlan(config);
  assert.equal(plan.steps.length, 4);
  assert.equal(plan.python, config.kernelPython);
  assert.ok(plan.steps[0].args.includes(config.kernelVenv));
  assert.ok(plan.steps[1].args.some((arg) => arg.endsWith("prime-agent-runtime")));
  assert.ok(plan.steps[2].args.includes("pandas"));
  assert.ok(plan.steps[3].args.includes(config.reportSkill));
});
