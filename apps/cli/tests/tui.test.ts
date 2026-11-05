import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.ts";
import { runTui, tuiEntry, tuiEnv } from "../src/commands/tui.ts";

test("tui entry points at apps/tui and inherits the resolved config", () => {
  const home = mkdtempSync(join(tmpdir(), "super-rlm-tui-"));
  const config = loadConfig({
    env: {
      SUPER_RLM_HOME: home,
      SUPER_RLM_PORT: "9999",
      SUPER_RLM_WORKER_PORT: "9090",
      SUPER_RLM_PRIME_PROVIDER: "deepseek",
      SUPER_RLM_PRIME_MODEL: "deepseek-flash",
      SUPER_RLM_PROFILES_CONFIG: "C:/config/profiles.yaml",
    },
    cwd: tmpdir(),
  });
  assert.ok(tuiEntry(config).endsWith(join("apps", "tui", "src", "main.ts")));
  const env = tuiEnv(config, "/tmp/launch", "C:/config/profiles.yaml");
  assert.equal(env.SUPER_RLM_HOME, home);
  assert.equal(env.SUPER_RLM_ORIGIN_CWD, "/tmp/launch");
  assert.equal(env.SUPER_RLM_PORT, "9999");
  assert.equal(env.SUPER_RLM_WORKER_PORT, "9090");
  assert.equal(env.SUPER_RLM_PRIME_PROVIDER, "deepseek");
  assert.equal(env.SUPER_RLM_PRIME_MODEL, "deepseek-flash");
  assert.equal(env.SUPER_RLM_WORKSPACES, join(home, "workspaces"));
  assert.equal(env.SUPER_RLM_PROFILES_CONFIG, "C:/config/profiles.yaml");
});

test("runTui reports a missing TUI entry without starting services", async () => {
  const config = loadConfig({
    env: { SUPER_RLM_HOME: mkdtempSync(join(tmpdir(), "super-rlm-tui-")) },
    cwd: tmpdir(),
  });
  const missing = { ...config, repoRoot: mkdtempSync(join(tmpdir(), "super-rlm-empty-")) };
  const originalError = console.error;
  const stderr: string[] = [];
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(" ")); };
  try {
    assert.equal(await runTui(missing), 1);
  } finally {
    console.error = originalError;
  }
  assert.match(stderr.join("\n"), /TUI entry not found/);
});

test("help lists the tui command", () => {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "..", "src", "main.ts"), "help"], {
    encoding: "utf8",
    env: { ...process.env, SUPER_RLM_HOME: mkdtempSync(join(tmpdir(), "super-rlm-tui-")) },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /super-rlm tui/);
});
