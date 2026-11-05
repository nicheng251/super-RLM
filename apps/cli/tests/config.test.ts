
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildRouterArgs,
  ensureDirs,
  loadConfig,
  orchestratorEnv,
  readModelDefault,
  readProjectId,
  workerEnv,
} from "../src/config.ts";

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
  assert.ok(args.includes("--append-system-prompt"));
  assert.ok(args[args.indexOf("--append-system-prompt") + 1].endsWith("router.md"));
  assert.equal(args[args.indexOf("--session-id") + 1], "super-rlm-router-default");
  assert.equal(args.at(-1), "hello");
});

test("--new drops the fixed session id", () => {
  const config = loadConfig({ env: { SUPER_RLM_HOME: "/tmp/super-rlm-home" }, cwd: tmpdir() });
  const args = buildRouterArgs(config, { newSession: true });
  assert.equal(args.includes("--session-id"), false);
});

function writeModelsYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-models-"));
  const path = join(dir, "models.yaml");
  writeFileSync(path, content);
  return path;
}

const modelsWithDefault = `default:
  provider: local
  model: local-model
providers:
  local:
    models:
      - id: local-model
`;

test("loadConfig reads the default provider/model from models.yaml", () => {
  const modelsConfigPath = writeModelsYaml(modelsWithDefault);
  const config = loadConfig({ env: { SUPER_RLM_HOME: "/tmp/super-rlm-home" }, cwd: tmpdir(), modelsConfigPath });
  assert.equal(config.primeProvider, "local");
  assert.equal(config.primeModel, "local-model");
  assert.deepEqual(readModelDefault(modelsConfigPath), { provider: "local", model: "local-model" });
});

test("environment provider/model override the models.yaml default", () => {
  const modelsConfigPath = writeModelsYaml(modelsWithDefault);
  const config = loadConfig({
    env: {
      SUPER_RLM_HOME: "/tmp/super-rlm-home",
      SUPER_RLM_PRIME_PROVIDER: "env-provider",
      SUPER_RLM_PRIME_MODEL: "env-model",
    },
    cwd: tmpdir(),
    modelsConfigPath,
  });
  assert.equal(config.primeProvider, "env-provider");
  assert.equal(config.primeModel, "env-model");
});

test("missing, malformed, or defaultless models.yaml falls back to fake", () => {
  const home = { SUPER_RLM_HOME: "/tmp/super-rlm-home" };
  const missing = loadConfig({ env: home, cwd: tmpdir(), modelsConfigPath: join(tmpdir(), "no-such-models.yaml") });
  assert.equal(missing.primeProvider, "fake");
  assert.equal(missing.primeModel, "fake-1");

  const malformed = writeModelsYaml("default: [unclosed\n");
  assert.equal(readModelDefault(malformed), null);
  const fromMalformed = loadConfig({ env: home, cwd: tmpdir(), modelsConfigPath: malformed });
  assert.equal(fromMalformed.primeProvider, "fake");
  assert.equal(fromMalformed.primeModel, "fake-1");

  const defaultless = writeModelsYaml("providers:\n  local:\n    models:\n      - id: local-model\n");
  const fromDefaultless = loadConfig({ env: home, cwd: tmpdir(), modelsConfigPath: defaultless });
  assert.equal(fromDefaultless.primeProvider, "fake");
  assert.equal(fromDefaultless.primeModel, "fake-1");
});

test("loadConfig derives project runtime paths", () => {
  const config = loadConfig({
    env: { SUPER_RLM_HOME: "/tmp/super-rlm-home", SUPER_RLM_PORT: "9999" },
    cwd: tmpdir(),
  });
  assert.equal(config.port, 9999);
  assert.equal(config.home, "/tmp/super-rlm-home");
  assert.equal(config.workspaceRoot, join("/tmp/super-rlm-home", "workspaces"));
  assert.equal(config.orchestratorUrl, "http://127.0.0.1:9999");
  assert.ok(config.reportSkill.endsWith("super-rlm-report"));
});

test("workspace root defaults under home and honors SUPER_RLM_WORKSPACES", () => {
  const home = mkdtempSync(join(tmpdir(), "super-rlm-home-"));
  const customRoot = mkdtempSync(join(tmpdir(), "super-rlm-workspaces-"));
  const defaultConfig = loadConfig({ env: { SUPER_RLM_HOME: home }, cwd: tmpdir() });
  assert.equal(defaultConfig.workspaceRoot, join(home, "workspaces"));
  ensureDirs(defaultConfig);
  assert.ok(existsSync(join(home, "workspaces")));

  const customConfig = loadConfig({
    env: { SUPER_RLM_HOME: home, SUPER_RLM_WORKSPACES: customRoot },
    cwd: tmpdir(),
  });
  assert.equal(customConfig.workspaceRoot, customRoot);
  assert.equal(orchestratorEnv(customConfig).SUPER_RLM_WORKSPACES, customRoot);
  assert.equal(workerEnv(customConfig).SUPER_RLM_WORKSPACES, customRoot);
  ensureDirs(customConfig);
  assert.ok(existsSync(customRoot));
});
