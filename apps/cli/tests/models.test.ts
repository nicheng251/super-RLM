
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadModelsConfig, syncModels } from "../src/commands/models.ts";
import { loadConfig } from "../src/config.ts";

function writeConfig(dir: string, key: string): string {
  const path = join(dir, "models.yaml");
  writeFileSync(path, `providers:\n  local:\n    name: Local\n    api: openai-completions\n    baseUrl: http://127.0.0.1:8000/v1\n    apiKey: ${key}\n    models:\n      - id: local-model\n        name: Local\n        api: openai-completions\n        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }\n`);
  return path;
}

test("syncModels writes both project models.json files", () => {
  const home = mkdtempSync(join(tmpdir(), "super-rlm-models-"));
  const config = loadConfig({ env: { SUPER_RLM_HOME: home, TEST_MODEL_KEY: "secret-key" }, cwd: tmpdir() });
  const path = writeConfig(home, "$TEST_MODEL_KEY");
  assert.equal(syncModels(config, { configPath: path, env: { TEST_MODEL_KEY: "secret-key" } }), 0);
  const pi = JSON.parse(readFileSync(join(home, "pi", "agent", "models.json"), "utf8"));
  const prime = JSON.parse(readFileSync(join(home, "prime", "agent", "models.json"), "utf8"));
  assert.equal(pi.providers.local.apiKey, "secret-key");
  assert.deepEqual(pi, prime);
});

test("syncModels rejects a missing secret", () => {
  const home = mkdtempSync(join(tmpdir(), "super-rlm-models-"));
  const config = loadConfig({ env: { SUPER_RLM_HOME: home }, cwd: tmpdir() });
  const path = writeConfig(home, "$MISSING_KEY");
  assert.equal(syncModels(config, { configPath: path, env: {} }), 1);
});

test("loadModelsConfig validates the provider shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-models-"));
  const path = join(dir, "bad.yaml");
  writeFileSync(path, "providers: {}\n");
  assert.deepEqual(loadModelsConfig(path).providers, {});
  writeFileSync(path, "providers:\n  broken:\n    name: Broken\n");
  assert.throws(() => loadModelsConfig(path), /models array/);
});
