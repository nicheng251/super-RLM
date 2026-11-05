
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";

import { bootstrapPlan } from "../src/commands/bootstrap.ts";
import { loadConfig } from "../src/config.ts";

test("bootstrap plans venv, runtime, defaults, report skill, and Worker venv", () => {
  const config = loadConfig({ env: { SUPER_RLM_HOME: "/tmp/super-rlm-bootstrap" }, cwd: tmpdir() });
  const plan = bootstrapPlan(config);
  assert.equal(plan.steps.length, 6);
  assert.equal(plan.python, config.kernelPython);
  assert.ok(plan.steps.every((step) => step.command === config.uvPath));
  assert.ok(plan.steps[0].args.includes(config.kernelVenv));
  assert.ok(plan.steps[1].args.some((arg) => arg.endsWith("prime-agent-runtime")));
  assert.ok(plan.steps[2].args.includes("pandas"));
  assert.ok(plan.steps[3].args.includes(config.reportSkill));
  assert.ok(plan.steps[4].args.includes(config.workerDir + "/.venv") || plan.steps[4].args.includes(config.workerDir + "\\.venv"));
  assert.ok(plan.steps[5].args.includes(config.workerPython));
  assert.ok(plan.steps[5].args.includes(config.workerDir));
});

test("bootstrap uses SUPER_RLM_UV when set", () => {
  const config = loadConfig({
    env: { SUPER_RLM_HOME: "/tmp/super-rlm-bootstrap", SUPER_RLM_UV: "C:/tools/uv.exe" },
    cwd: tmpdir(),
  });
  const plan = bootstrapPlan(config);
  assert.ok(plan.steps.every((step) => step.command === "C:/tools/uv.exe"));
});
