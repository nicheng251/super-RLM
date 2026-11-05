import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { loadConfig, type CliConfig } from "../src/config.ts";
import { servicePaths } from "../src/services.ts";
import {
  DEFAULT_LOG_KEEP,
  DEFAULT_LOG_MAX_BYTES,
  autoMaintenanceEnabled,
  describeLogRotation,
  formatBytes,
  logRotationOptionsFromEnv,
  maintenanceGcOlderThanDays,
  rotateLogFile,
  rotateServiceLogs,
  runStartupMaintenance,
} from "../src/maintenance.ts";
import type { RunningStack } from "../src/supervisor/detect.ts";

function tempConfig(): CliConfig {
  const home = mkdtempSync(join(tmpdir(), "super-rlm-maintenance-"));
  return loadConfig({ env: { SUPER_RLM_HOME: home }, cwd: tmpdir() });
}

function stack(overrides: Partial<RunningStack> = {}): RunningStack {
  return {
    orchestrator: { name: "orchestrator", healthy: false, pid: null, alive: false },
    worker: { name: "worker", healthy: false, pid: null, alive: false },
    daemons: [],
    ...overrides,
  };
}

function writeLog(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

test("log rotation defaults and env parsing", () => {
  assert.equal(DEFAULT_LOG_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(DEFAULT_LOG_KEEP, 3);
  assert.equal(maintenanceGcOlderThanDays({}), 7);
  assert.equal(maintenanceGcOlderThanDays({ SUPER_RLM_GC_OLDER_THAN_DAYS: "0" }), 0);
  assert.equal(maintenanceGcOlderThanDays({ SUPER_RLM_GC_OLDER_THAN_DAYS: "bad" }), 7);
  assert.equal(autoMaintenanceEnabled({}), true);
  assert.equal(autoMaintenanceEnabled({ SUPER_RLM_AUTO_MAINTENANCE: "0" }), false);
  assert.equal(autoMaintenanceEnabled({ SUPER_RLM_AUTO_MAINTENANCE: "1" }), true);
  assert.deepEqual(logRotationOptionsFromEnv({}), {
    maxBytes: DEFAULT_LOG_MAX_BYTES,
    keep: DEFAULT_LOG_KEEP,
  });
  assert.deepEqual(logRotationOptionsFromEnv({
    SUPER_RLM_LOG_MAX_BYTES: "2048",
    SUPER_RLM_LOG_KEEP: "5",
  }), { maxBytes: 2048, keep: 5 });
  assert.deepEqual(logRotationOptionsFromEnv({
    SUPER_RLM_LOG_MAX_BYTES: "0",
    SUPER_RLM_LOG_KEEP: "-1",
  }), { maxBytes: DEFAULT_LOG_MAX_BYTES, keep: DEFAULT_LOG_KEEP });
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KiB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MiB");
});

test("a missing log is left alone", () => {
  const config = tempConfig();
  const path = servicePaths(config, "orchestrator").log;
  const result = rotateLogFile(path);
  assert.equal(result.rotated, false);
  assert.equal(result.error, undefined);
  assert.equal(existsSync(path), false);
});

test("a log at or below the threshold is not rotated", () => {
  const config = tempConfig();
  const path = servicePaths(config, "worker").log;
  writeLog(path, "1234567890");
  assert.equal(rotateLogFile(path, { maxBytes: 10, keep: 2 }).rotated, false);
  assert.equal(existsSync(path), true);
  assert.equal(existsSync(`${path}.1`), false);
  assert.equal(rotateLogFile(path, { maxBytes: 9, keep: 2 }).rotated, true);
  assert.equal(readFileSync(`${path}.1`, "utf8"), "1234567890");
  assert.equal(existsSync(path), false);
});

test("rotation preserves the current log and shifts kept rotations", () => {
  const config = tempConfig();
  const path = servicePaths(config, "orchestrator").log;
  writeLog(path, "current");
  writeLog(`${path}.1`, "one");
  writeLog(`${path}.2`, "two");
  writeLog(`${path}.3`, "three");
  const result = rotateLogFile(path, { maxBytes: 1, keep: 3 });
  assert.equal(result.rotated, true);
  assert.equal(result.size, "current".length);
  assert.equal(readFileSync(`${path}.1`, "utf8"), "current");
  assert.equal(readFileSync(`${path}.2`, "utf8"), "one");
  assert.equal(readFileSync(`${path}.3`, "utf8"), "two");
  assert.equal(existsSync(`${path}.4`), false);
  assert.equal(existsSync(path), false);
});

test("keep=1 replaces the only rotation", () => {
  const config = tempConfig();
  const path = servicePaths(config, "worker").log;
  writeLog(path, "new");
  writeLog(`${path}.1`, "old");
  assert.equal(rotateLogFile(path, { maxBytes: 1, keep: 1 }).rotated, true);
  assert.equal(readFileSync(`${path}.1`, "utf8"), "new");
  assert.equal(existsSync(`${path}.2`), false);
});

test("rotation reports a non-regular log path", () => {
  const config = tempConfig();
  const dir = servicePaths(config, "worker").dir;
  mkdirSync(dir, { recursive: true });
  const result = rotateLogFile(dir, { maxBytes: 1 });
  assert.equal(result.rotated, false);
  assert.match(result.error ?? "", /not a regular file/);
});

test("rotateServiceLogs covers both service logs and describes them", () => {
  const config = tempConfig();
  for (const name of ["orchestrator", "worker"] as const) {
    writeLog(servicePaths(config, name).log, "0123456789");
  }
  const results = rotateServiceLogs(config, { maxBytes: 1, keep: 1 });
  assert.deepEqual(results.map((result) => result.name), ["orchestrator", "worker"]);
  assert.equal(results.every((result) => result.rotated), true);
  assert.equal(readFileSync(servicePaths(config, "orchestrator").log + ".1", "utf8"), "0123456789");
  assert.equal(readFileSync(servicePaths(config, "worker").log + ".1", "utf8"), "0123456789");
  assert.match(describeLogRotation(results[0]!), /^orchestrator \(10 B\)$/);
});

test("startup maintenance refuses to touch anything while the stack is running", async () => {
  const config = tempConfig();
  const events: string[] = [];
  const result = await runStartupMaintenance(config, {
    detect: async () => stack({
      daemons: [{ pid: 4321, status: "current", socketPath: "sock", sessionCount: 1 }],
    }),
    rotateLogs: () => {
      events.push("rotate");
      return [];
    },
    gc: async () => {
      events.push("gc");
      return 0;
    },
    log: () => {},
  });
  assert.equal(result.ran, false);
  assert.equal(result.skipped, "stack-running");
  assert.deepEqual(events, []);
});

test("startup maintenance fails closed when the stack state is unknown", async () => {
  const config = tempConfig();
  const events: string[] = [];
  const result = await runStartupMaintenance(config, {
    detect: async () => {
      throw new Error("daemon status unavailable");
    },
    rotateLogs: () => {
      events.push("rotate");
      return [];
    },
    gc: async () => {
      events.push("gc");
      return 0;
    },
    log: () => {},
  });
  assert.equal(result.ran, false);
  assert.equal(result.skipped, "stack-unknown");
  assert.deepEqual(events, []);
  assert.match(result.errors[0] ?? "", /daemon status unavailable/);
});

test("startup maintenance rotates logs before running GC with env settings", async () => {
  const config = tempConfig();
  const events: string[] = [];
  const result = await runStartupMaintenance(config, {
    detect: async () => {
      events.push("detect");
      return stack();
    },
    env: {
      SUPER_RLM_LOG_MAX_BYTES: "123",
      SUPER_RLM_LOG_KEEP: "5",
      SUPER_RLM_GC_OLDER_THAN_DAYS: "3",
    },
    rotateLogs: (_config, options) => {
      events.push(`rotate:${options?.maxBytes}:${options?.keep}`);
      return [];
    },
    gc: async (_config, options, deps) => {
      events.push(`gc:${options?.apply}:${options?.olderThanDays}`);
      assert.equal(deps, undefined);
      return 0;
    },
    log: () => {},
  });
  assert.equal(result.ran, true);
  assert.equal(result.gcCode, 0);
  assert.deepEqual(events, ["detect", "rotate:123:5", "gc:true:3"]);
});

test("SUPER_RLM_AUTO_MAINTENANCE=0 keeps log rotation but skips GC", async () => {
  const config = tempConfig();
  const events: string[] = [];
  const result = await runStartupMaintenance(config, {
    detect: async () => stack(),
    env: { SUPER_RLM_AUTO_MAINTENANCE: "0" },
    rotateLogs: () => {
      events.push("rotate");
      return [];
    },
    gc: async () => {
      events.push("gc");
      return 0;
    },
    log: () => {},
  });
  assert.equal(result.ran, true);
  assert.equal(result.gcCode, null);
  assert.deepEqual(events, ["rotate"]);
});

test("startup maintenance reports rotation errors but still runs GC", async () => {
  const config = tempConfig();
  const messages: string[] = [];
  const events: string[] = [];
  const result = await runStartupMaintenance(config, {
    detect: async () => stack(),
    rotateLogs: () => [{
      name: "worker",
      path: servicePaths(config, "worker").log,
      rotated: false,
      error: "access denied",
    }],
    gc: async () => {
      events.push("gc");
      return 0;
    },
    log: (message) => messages.push(message),
  });
  assert.equal(result.ran, true);
  assert.deepEqual(events, ["gc"]);
  assert.match(messages.join("\n"), /could not rotate worker: access denied/);
  assert.deepEqual(result.errors, ["access denied"]);
});

test("startup maintenance tolerates a missing log file set", async () => {
  const config = tempConfig();
  const result = await runStartupMaintenance(config, {
    detect: async () => stack(),
    gc: async () => 0,
    log: () => {},
  });
  assert.equal(result.ran, true);
  assert.equal(result.rotated.length, 2);
  assert.equal(result.rotated.every((rotation) => rotation.rotated === false), true);
  assert.deepEqual(result.errors, []);
});
