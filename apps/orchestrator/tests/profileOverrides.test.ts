
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyProfileOverrides,
  loadProfileOverrides,
  parseProfileOverrides,
  resetProfileOverrides,
  saveProfileOverride,
} from "../src/profileOverrides.ts";
import { defaultProfilesPath, loadProfiles, profileExecution } from "../src/profiles.ts";

const mainEntry = join(import.meta.dirname, "..", "src", "main.ts");

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeOverrides(text: string): string {
  const path = join(tempDir("super-rlm-overrides-"), "profiles.overrides.json");
  writeFileSync(path, text, "utf8");
  return path;
}

test("saved overrides take precedence over profiles.yaml", () => {
  const profiles = loadProfiles(defaultProfilesPath());
  const overrides = parseProfileOverrides({
    default: { provider: "override-provider", model: "override-model", thinking: "low" },
    reviewer: { thinking: "max" },
  }, "test");
  applyProfileOverrides(profiles, overrides, "test");

  assert.equal(profiles.profiles.default.provider, "override-provider");
  assert.equal(profiles.profiles.default.model, "override-model");
  assert.equal(profiles.profiles.default.thinking, "low");
  // Fields missing from the override keep the config/profiles.yaml value.
  assert.equal(profiles.profiles.default.timeout_s, 3600);
  assert.equal(profiles.profiles.reviewer.thinking, "max");
  assert.equal(profiles.profiles.reviewer.model, "deepseek-flash");

  const execution = profileExecution(profiles.profiles.default);
  assert.equal(execution.provider, "override-provider");
  assert.equal(execution.model, "override-model");
  assert.equal(execution.thinking, "low");
});

test("override schema rejects malformed entries", () => {
  const cases: Array<[unknown, RegExp]> = [
    [[], /top level must be an object/],
    [null, /top level must be an object/],
    ["text", /top level must be an object/],
    [{ default: "text" }, /default must be an object/],
    [{ default: [] }, /default must be an object/],
    [{ default: {} }, /must set at least one of provider, model, thinking/],
    [{ default: { provider: "" } }, /default\.provider must be a non-empty string/],
    [{ default: { provider: "   " } }, /default\.provider must be a non-empty string/],
    [{ default: { provider: 7 } }, /default\.provider must be a non-empty string/],
    [{ default: { model: undefined } }, /default\.model must be a non-empty string/],
    [{ default: { thinking: "maximal" } }, /default\.thinking must be one of/],
    [{ default: { thinking: "" } }, /default\.thinking must be one of/],
    [{ default: { provider: "p", model: "m", timeout_s: 5 } }, /unknown field "timeout_s"/],
    [{ " ": { model: "m" } }, /profile name must be non-empty/],
  ];
  for (const [raw, pattern] of cases) {
    assert.throws(() => parseProfileOverrides(raw, "test.json"), pattern);
  }

  assert.deepEqual(
    parseProfileOverrides({ default: { provider: " p ", thinking: "high" } }, "test.json"),
    { default: { provider: "p", thinking: "high" } },
  );
});

test("unknown profile overrides are rejected without mutating loaded profiles", () => {
  const profiles = loadProfiles(defaultProfilesPath());
  assert.throws(
    () => applyProfileOverrides(profiles, parseProfileOverrides({
      default: { thinking: "low" },
      missing: { model: "m" },
    }, "test.json"), "test.json"),
    /unknown profile "missing"/,
  );
  // The known override is not applied when any name is unknown.
  assert.equal(profiles.profiles.default.thinking, "medium");
});

test("malformed override files fail loading with the file name", () => {
  const malformed = writeOverrides("{ not json");
  assert.throws(() => loadProfileOverrides(malformed), new RegExp(`invalid profile overrides .*malformed JSON`));
  assert.throws(() => loadProfileOverrides(writeOverrides("[]")), /top level must be an object/);
  assert.deepEqual(loadProfileOverrides(join(tempDir("super-rlm-overrides-empty-"), "missing.json")), {});
});

test("saving preserves other overrides and leaves no temporary file", () => {
  const path = writeOverrides(JSON.stringify({ git: { provider: "p", model: "m", thinking: "high" } }));
  saveProfileOverride(path, "default", { provider: "p2", model: "m2", thinking: "low" });
  saveProfileOverride(path, "default", { provider: "p3", model: "m3", thinking: "medium" });

  const saved = loadProfileOverrides(path);
  assert.deepEqual(saved, {
    git: { provider: "p", model: "m", thinking: "high" },
    default: { provider: "p3", model: "m3", thinking: "medium" },
  });
  assert.deepEqual(
    readdirSync(join(path, "..")).filter((entry) => entry.endsWith(".tmp")),
    [],
  );
  assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(saved, null, 2)}\n`);
});

test("a failed save leaves the previous file unchanged", () => {
  const malformed = writeOverrides("{ not json");
  assert.throws(
    () => saveProfileOverride(malformed, "default", { thinking: "low" }),
    /invalid profile overrides .*malformed JSON/,
  );
  assert.equal(readFileSync(malformed, "utf8"), "{ not json");

  const directory = tempDir("super-rlm-overrides-fail-");
  const parentFile = join(directory, "not-a-directory");
  writeFileSync(parentFile, "keep", "utf8");
  assert.throws(
    () => saveProfileOverride(join(parentFile, "profiles.overrides.json"), "default", { thinking: "low" }),
    /cannot write profile overrides/,
  );
  assert.equal(readFileSync(parentFile, "utf8"), "keep");
  assert.deepEqual(readdirSync(directory), ["not-a-directory"]);
});

test("reset removes one override or all overrides", () => {
  const path = writeOverrides(JSON.stringify({
    default: { provider: "p", model: "m", thinking: "low" },
    git: { thinking: "high" },
  }));

  const first = resetProfileOverrides(path, "default");
  assert.deepEqual(first, { removed: ["default"], fileRemoved: false });
  assert.deepEqual(loadProfileOverrides(path), { git: { thinking: "high" } });

  const missing = resetProfileOverrides(path, "missing");
  assert.deepEqual(missing, { removed: [], fileRemoved: false });
  assert.deepEqual(loadProfileOverrides(path), { git: { thinking: "high" } });

  const last = resetProfileOverrides(path, "git");
  assert.deepEqual(last, { removed: ["git"], fileRemoved: true });
  assert.equal(existsSync(path), false);

  assert.deepEqual(resetProfileOverrides(path, null), { removed: [], fileRemoved: false });
});

test("reset --all recovers from a malformed override file", () => {
  const path = writeOverrides("{ not json");
  assert.throws(() => resetProfileOverrides(path, "default"), /malformed JSON/);
  assert.equal(readFileSync(path, "utf8"), "{ not json");
  assert.deepEqual(resetProfileOverrides(path, null), { removed: [], fileRemoved: true });
  assert.equal(existsSync(path), false);
});

interface StartedOrchestrator {
  port: number;
  close(): Promise<void>;
}

async function startOrchestrator(home: string, overridesPath: string): Promise<StartedOrchestrator> {
  const child = spawn(process.execPath, [mainEntry], {
    env: {
      ...process.env,
      SUPER_RLM_HOME: home,
      SUPER_RLM_PORT: "0",
      SUPER_RLM_PROFILE_OVERRIDES: overridesPath,
      SUPER_RLM_ROUTER_TOKEN: "test-router-token",
      SUPER_RLM_WORKER_TOKEN: "test-worker-token",
      SUPER_RLM_CALLBACK_KEY: "test-callback-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`orchestrator did not start: ${stderr}`)), 10_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/).find((entry) => entry.includes('"orchestrator.started"'));
      if (!line) return;
      clearTimeout(timer);
      resolve((JSON.parse(line) as { port: number }).port);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`orchestrator exited early (${code}): ${stderr}`));
    });
  });
  return {
    port,
    close: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill();
    }),
  };
}

test("startup applies valid overrides and PATCH preserves other entries", async () => {
  const home = tempDir("super-rlm-overrides-start-");
  const overridesPath = join(home, "profiles.overrides.json");
  writeFileSync(overridesPath, JSON.stringify({
    git: { provider: "override-provider", model: "override-model", thinking: "low" },
  }), "utf8");
  const orchestrator = await startOrchestrator(home, overridesPath);
  const headers = { "content-type": "application/json", authorization: "Bearer test-router-token" };
  try {
    const response = await fetch(`http://127.0.0.1:${orchestrator.port}/v1/profiles`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json() as { profiles: Array<{ name: string; provider: string; model: string; thinking: string }> };
    const git = body.profiles.find((profile) => profile.name === "git");
    assert.ok(git);
    assert.equal(git.provider, "override-provider");
    assert.equal(git.model, "override-model");
    assert.equal(git.thinking, "low");

    const patched = await fetch(`http://127.0.0.1:${orchestrator.port}/v1/profiles/default`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ thinking: "xhigh" }),
    });
    assert.equal(patched.status, 200);

    const saved = JSON.parse(readFileSync(overridesPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(saved).sort(), ["default", "git"]);
    assert.deepEqual(saved.default, { provider: "deepseek", model: "deepseek-flash", thinking: "xhigh" });
    assert.deepEqual(saved.git, { provider: "override-provider", model: "override-model", thinking: "low" });
  } finally {
    await orchestrator.close();
  }
});

test("startup fails closed for malformed and stale overrides", async () => {
  const cases: Array<[string, RegExp]> = [
    ["{ not json", /malformed JSON/],
    [JSON.stringify({ missing: { model: "m" } }), /unknown profile "missing"/],
    [JSON.stringify({ default: { thinking: "maximal" } }), /default\.thinking must be one of/],
  ];
  for (const [contents, pattern] of cases) {
    const home = tempDir("super-rlm-overrides-bad-start-");
    const overridesPath = join(home, "profiles.overrides.json");
    writeFileSync(overridesPath, contents, "utf8");
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [mainEntry], {
        env: {
          ...process.env,
          SUPER_RLM_HOME: home,
          SUPER_RLM_PORT: "0",
          SUPER_RLM_PROFILE_OVERRIDES: overridesPath,
          SUPER_RLM_ROUTER_TOKEN: "test-router-token",
          SUPER_RLM_WORKER_TOKEN: "test-worker-token",
          SUPER_RLM_CALLBACK_KEY: "test-callback-key",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.on("exit", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, pattern);
    assert.match(result.stderr, /profiles\.overrides\.json/);
  }
});
