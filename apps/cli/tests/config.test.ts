
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildRouterArgs,
  ensureDirs,
  loadConfig,
  loadOrCreateSecrets,
  lookupModelInfo,
  orchestratorEnv,
  parseSecretsFile,
  readModelDefault,
  readProjectId,
  redactConfig,
  routerEnv,
  secretsFilePath,
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
  assert.equal(args[args.indexOf("--thinking") + 1], "medium");
  assert.equal(args.at(-1), "hello");
});

test("routerEnv records the directory the user launched from", () => {
  const config = loadConfig({ env: { SUPER_RLM_HOME: "/tmp/super-rlm-home" }, cwd: tmpdir() });
  assert.equal(routerEnv(config, "/tmp/user/launch").SUPER_RLM_ORIGIN_CWD, "/tmp/user/launch");
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
  thinking: high
providers:
  local:
    models:
      - id: local-model
        name: Local Model
        contextWindow: 131072
`;

test("loadConfig reads the default provider/model from models.yaml", () => {
  const modelsConfigPath = writeModelsYaml(modelsWithDefault);
  const config = loadConfig({ env: { SUPER_RLM_HOME: "/tmp/super-rlm-home" }, cwd: tmpdir(), modelsConfigPath });
  assert.equal(config.primeProvider, "local");
  assert.equal(config.primeModel, "local-model");
  assert.deepEqual(readModelDefault(modelsConfigPath), {
    provider: "local",
    model: "local-model",
    name: "Local Model",
    thinking: "high",
    contextWindow: 131072,
  });
  assert.equal(config.primeModelName, "Local Model");
  assert.equal(config.primeThinking, "high");
  assert.equal(config.primeContextWindow, 131072);
  assert.equal(config.modelsConfigPath, modelsConfigPath);
  assert.deepEqual(lookupModelInfo(modelsConfigPath, "local", "local-model"), {
    provider: "local",
    model: "local-model",
    name: "Local Model",
    contextWindow: 131072,
  });
  assert.equal(lookupModelInfo(modelsConfigPath, "local", "missing"), null);
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

test("loadConfig generates project API secrets once and reuses them", () => {
  const home = mkdtempSync(join(tmpdir(), "super-rlm-secrets-"));
  const config = loadConfig({ env: { SUPER_RLM_HOME: home }, cwd: tmpdir() });
  const file = secretsFilePath(home);

  assert.ok(existsSync(file));
  const parsed = parseSecretsFile(readFileSync(file, "utf8"));
  assert.match(parsed.SUPER_RLM_ROUTER_TOKEN ?? "", /^[0-9a-f]{64}$/);
  assert.match(parsed.SUPER_RLM_WORKER_TOKEN ?? "", /^[0-9a-f]{64}$/);
  assert.match(parsed.SUPER_RLM_CALLBACK_KEY ?? "", /^[0-9a-f]{64}$/);
  assert.equal(config.routerToken, parsed.SUPER_RLM_ROUTER_TOKEN);
  assert.equal(config.workerToken, parsed.SUPER_RLM_WORKER_TOKEN);
  assert.equal(config.callbackKey, parsed.SUPER_RLM_CALLBACK_KEY);
  assert.notEqual(config.routerToken, config.workerToken);
  assert.notEqual(config.workerToken, config.callbackKey);
  assert.ok(!["dev-router-token", "dev-worker-token", "dev-callback-key"].includes(config.routerToken));
  assert.equal(orchestratorEnv(config).SUPER_RLM_ROUTER_TOKEN, config.routerToken);
  assert.equal(orchestratorEnv(config).SUPER_RLM_WORKER_TOKEN, config.workerToken);
  assert.equal(orchestratorEnv(config).SUPER_RLM_CALLBACK_KEY, config.callbackKey);
  assert.equal(workerEnv(config).SUPER_RLM_WORKER_TOKEN, config.workerToken);
  assert.equal(workerEnv(config).SUPER_RLM_CALLBACK_KEY, config.callbackKey);
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o077, 0);
  }

  const again = loadConfig({ env: { SUPER_RLM_HOME: home }, cwd: tmpdir() });
  assert.equal(again.routerToken, config.routerToken);
  assert.equal(again.workerToken, config.workerToken);
  assert.equal(again.callbackKey, config.callbackKey);
});

test("explicit environment secrets override the secret file without breaking it", () => {
  const home = mkdtempSync(join(tmpdir(), "super-rlm-secrets-env-"));
  const config = loadConfig({
    env: {
      SUPER_RLM_HOME: home,
      SUPER_RLM_ROUTER_TOKEN: "env-router-token",
      SUPER_RLM_WORKER_TOKEN: "env-worker-token",
      SUPER_RLM_CALLBACK_KEY: "env-callback-key",
    },
    cwd: tmpdir(),
  });
  assert.equal(config.routerToken, "env-router-token");
  assert.equal(config.workerToken, "env-worker-token");
  assert.equal(config.callbackKey, "env-callback-key");
  assert.equal(orchestratorEnv(config).SUPER_RLM_CALLBACK_KEY, "env-callback-key");
  assert.equal(workerEnv(config).SUPER_RLM_CALLBACK_KEY, "env-callback-key");
  assert.equal(workerEnv(config).SUPER_RLM_WORKER_TOKEN, "env-worker-token");

  const fromFile = loadOrCreateSecrets(home, {});
  assert.match(fromFile.routerToken, /^[0-9a-f]{64}$/);
  assert.notEqual(fromFile.routerToken, "env-router-token");
});

test("a malformed or partial secret file is repaired without losing valid entries", () => {
  const home = mkdtempSync(join(tmpdir(), "super-rlm-secrets-partial-"));
  const file = secretsFilePath(home);
  ensureDirs(loadConfig({ env: { SUPER_RLM_HOME: home }, cwd: tmpdir() }));
  writeFileSync(join(home, "secrets", "api.env"), [
    "not a secret line",
    "SUPER_RLM_ROUTER_TOKEN=keep-me",
    "SUPER_RLM_WORKER_TOKEN=",
  ].join("\n"));

  const secrets = loadOrCreateSecrets(home, {});
  assert.equal(secrets.routerToken, "keep-me");
  assert.match(secrets.workerToken, /^[0-9a-f]{64}$/);
  assert.match(secrets.callbackKey, /^[0-9a-f]{64}$/);
  const parsed = parseSecretsFile(readFileSync(file, "utf8"));
  assert.equal(parsed.SUPER_RLM_ROUTER_TOKEN, "keep-me");
  assert.equal(parsed.SUPER_RLM_WORKER_TOKEN, secrets.workerToken);
});

test("redactConfig hides tokens and keys", () => {
  const home = mkdtempSync(join(tmpdir(), "super-rlm-redact-"));
  const config = loadConfig({ env: { SUPER_RLM_HOME: home }, cwd: tmpdir() });
  const redacted = redactConfig(config);
  assert.equal(redacted.routerToken, "[redacted]");
  assert.equal(redacted.workerToken, "[redacted]");
  assert.equal(redacted.callbackKey, "[redacted]");
  const printed = JSON.stringify(redacted);
  assert.ok(!printed.includes(config.routerToken));
  assert.ok(!printed.includes(config.workerToken));
  assert.ok(!printed.includes(config.callbackKey));
});

test("unreadable or unwritable secret files degrade to ephemeral secrets", () => {
  const home = mkdtempSync(join(tmpdir(), "super-rlm-secrets-broken-"));
  mkdirSync(join(home, "secrets", "api.env"), { recursive: true });
  const secrets = loadOrCreateSecrets(home, {});
  assert.match(secrets.routerToken, /^[0-9a-f]{64}$/);
  assert.match(secrets.workerToken, /^[0-9a-f]{64}$/);
  assert.match(secrets.callbackKey, /^[0-9a-f]{64}$/);
});
