import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.ts";
import { runTui, tuiEntry, tuiEnv } from "../src/commands/tui.ts";
import type { RunningStack } from "../src/supervisor/detect.ts";

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


function stack(overrides: Partial<RunningStack> = {}): RunningStack {
  return {
    orchestrator: { name: "orchestrator", healthy: false, pid: null, alive: false },
    worker: { name: "worker", healthy: false, pid: null, alive: false },
    daemons: [],
    ...overrides,
  };
}

test("runTui refuses to attach to an existing stack and tells the user to run down", async () => {
  const config = loadConfig({
    env: { SUPER_RLM_HOME: mkdtempSync(join(tmpdir(), "super-rlm-tui-")) },
    cwd: tmpdir(),
  });
  let started = false;
  const originalError = console.error;
  const stderr: string[] = [];
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(" ")); };
  try {
    const code = await runTui(config, {
      platform: "win32",
      detect: async () => stack({
        orchestrator: { name: "orchestrator", healthy: true, pid: 1234, alive: true },
        daemons: [{ pid: 5678, status: "current", socketPath: config.primeDaemonSocket, sessionCount: 0 }],
      }),
      start: async () => {
        started = true;
        return 0;
      },
    });
    assert.equal(code, 1);
  } finally {
    console.error = originalError;
  }
  assert.equal(started, false);
  assert.match(stderr.join("\n"), /refusing to start/);
  assert.match(stderr.join("\n"), /orchestrator \(pid 1234\)/);
  assert.match(stderr.join("\n"), /Prime Agent daemon \(pid 5678\)/);
  assert.match(stderr.join("\n"), /super-rlm down/);
});

test("runTui builds and starts the Job supervisor plan when the stack is idle", async () => {
  const config = loadConfig({
    env: { SUPER_RLM_HOME: mkdtempSync(join(tmpdir(), "super-rlm-tui-")) },
    cwd: tmpdir(),
  });
  let plan: unknown;
  const code = await runTui(config, {
    platform: "win32",
    detect: async () => stack(),
    start: async (built) => {
      plan = built;
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.ok(plan && typeof plan === "object");
  assert.equal((plan as { tui_child: string }).tui_child, "tui");
  assert.equal((plan as { children: unknown[] }).children.length, 3);
});

test("runTui fails closed when the Windows Job API is unavailable", async () => {
  const config = loadConfig({
    env: { SUPER_RLM_HOME: mkdtempSync(join(tmpdir(), "super-rlm-tui-")) },
    cwd: tmpdir(),
  });
  const originalError = console.error;
  const stderr: string[] = [];
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(" ")); };
  try {
    assert.equal(await runTui(config, { platform: "linux" }), 1);
  } finally {
    console.error = originalError;
  }
  assert.match(stderr.join("\n"), /Windows Job Object/);
});
