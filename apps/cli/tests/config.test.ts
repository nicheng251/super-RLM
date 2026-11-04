
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildRouterArgs, loadConfig, readProjectId } from "../src/config.ts";

test("readProjectId prefers the environment and falls back to the marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-cli-"));
  writeFileSync(join(dir, ".super-rlm-project.json"), JSON.stringify({ project_id: "prj_test" }));
  assert.equal(readProjectId(dir, {}), "prj_test");
  assert.equal(readProjectId(dir, { SUPER_RLM_PROJECT_ID: "prj_env" }), "prj_env");
  assert.equal(readProjectId(tmpdir(), {}), "default");
});

test("buildRouterArgs pins the project session and control-plane guard flags", () => {
  const config = loadConfig({ env: { SUPER_RLM_HOME: "/tmp/super-rlm-home" }, cwd: tmpdir() });
  const args = buildRouterArgs(config, { extraArgs: ["hello"] });
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.includes("-e"));
  assert.ok(args.includes("--no-skills"));
  assert.ok(args.includes("-nbt"));
  assert.equal(args[args.indexOf("--session-id") + 1], "super-rlm-router-default");
  assert.equal(args.at(-1), "hello");
});

test("--new drops the fixed session id", () => {
  const config = loadConfig({ env: { SUPER_RLM_HOME: "/tmp/super-rlm-home" }, cwd: tmpdir() });
  const args = buildRouterArgs(config, { newSession: true });
  assert.equal(args.includes("--session-id"), false);
});

test("loadConfig derives project runtime paths", () => {
  const config = loadConfig({
    env: { SUPER_RLM_HOME: "/tmp/super-rlm-home", SUPER_RLM_PORT: "9999" },
    cwd: tmpdir(),
  });
  assert.equal(config.port, 9999);
  assert.equal(config.home, "/tmp/super-rlm-home");
  assert.equal(config.orchestratorUrl, "http://127.0.0.1:9999");
  assert.ok(config.reportSkill.endsWith("super-rlm-report"));
});
