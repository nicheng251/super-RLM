import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { canonicalDaemonSocket, loadConfig } from "../src/config.ts";
import { parseDaemonStatus, runningDaemons } from "../src/daemon.ts";
import { describeRunningStack, hasRunningStack, type RunningStack } from "../src/supervisor/detect.ts";
import { buildSupervisorPlan, envOverrides, jobNameFor } from "../src/supervisor/plan.ts";
import { readSupervisorPid } from "../src/supervisor/pid.ts";
import { buildSupervisorInvocation, resolveSupervisorPython } from "../src/supervisor/run.ts";

function testConfig(extraEnv: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    env: {
      SUPER_RLM_HOME: mkdtempSync(join(tmpdir(), "super-rlm-supervisor-")),
      SUPER_RLM_PORT: "9999",
      SUPER_RLM_WORKER_PORT: "9090",
      SUPER_RLM_PRIME_PROVIDER: "deepseek",
      SUPER_RLM_PRIME_MODEL: "deepseek-flash",
      ...extraEnv,
    },
    cwd: tmpdir(),
  });
}

test("envOverrides keeps only values that differ from the inherited environment", () => {
  assert.deepEqual(
    envOverrides({ A: "1", B: "2", C: undefined }, { A: "1" }),
    { B: "2" },
  );
  assert.deepEqual(envOverrides({ A: "1" }, { A: "1" }), {});
});

test("buildSupervisorPlan starts Orchestrator, Worker, then the TUI", () => {
  const config = testConfig({
    SUPER_RLM_PRIME_DAEMON: "C:/temp/Project/Worker.sock",
  });
  const plan = buildSupervisorPlan(config, {
    originCwd: "/launch/here",
    tuiEntry: join(config.repoRoot, "apps", "tui", "src", "main.ts"),
    tuiEnv: {
      SUPER_RLM_HOME: config.home,
      SUPER_RLM_PORT: "9999",
      SUPER_RLM_ORIGIN_CWD: "/launch/here",
    },
  });

  assert.equal(plan.version, 1);
  assert.equal(plan.tui_child, "tui");
  assert.deepEqual(plan.children.map((child) => child.name), ["orchestrator", "worker", "tui"]);
  assert.equal(plan.job_name, jobNameFor(config, Number(plan.job_name.split("-").at(-1))));
  assert.match(plan.job_name, /^super-rlm-default-\d+$/);
  assert.equal(plan.supervisor_pid_path, join(config.home, "supervisor.pid"));

  const [orchestrator, worker, tui] = plan.children;
  assert.deepEqual(orchestrator.args, [config.orchestratorMain]);
  assert.equal(orchestrator.stdio, "log");
  assert.match(orchestrator.log ?? "", /orchestrator\.log$/);
  assert.match(orchestrator.pid ?? "", /orchestrator\.pid$/);
  assert.equal(orchestrator.health_url, "http://127.0.0.1:9999/health");
  assert.equal(orchestrator.env.SUPER_RLM_HOME, config.home);

  assert.equal(worker.command, config.workerPython);
  assert.deepEqual(worker.args, ["-m", "super_rlm_worker.main"]);
  assert.equal(worker.cwd, config.workerDir);
  assert.match(worker.pid ?? "", /worker\.pid$/);
  assert.equal(worker.health_url, "http://127.0.0.1:9090/v1/health");
  assert.equal(worker.env.SUPER_RLM_PRIME_DAEMON, config.primeDaemonSocket);

  assert.deepEqual(tui.args, [join(config.repoRoot, "apps", "tui", "src", "main.ts")]);
  assert.equal(tui.cwd, "/launch/here");
  assert.equal(tui.stdio, "inherit");
  assert.equal(tui.env.SUPER_RLM_ORIGIN_CWD, "/launch/here");

  const expectedSocket = process.platform === "win32"
    ? resolve("C:/temp/Project/Worker.sock").toLowerCase().replaceAll("/", "\\")
    : resolve("C:/temp/Project/Worker.sock");
  assert.equal(config.primeDaemonSocket, expectedSocket);
  assert.equal(plan.shutdown.prime_agent_env.PRIME_AGENT_DAEMON_SOCKET, expectedSocket);
  assert.deepEqual(plan.shutdown.prime_agent_env_strip, ["PI_", "PRIME_AGENT_", "RLM_"]);
  assert.equal(plan.shutdown.router_token, config.routerToken);
  assert.equal(plan.shutdown.worker_url, "http://127.0.0.1:9090");
});

test("supervisor python resolution honors the override and the Worker venv", () => {
  const config = testConfig();
  assert.equal(
    resolveSupervisorPython(config, {
      env: { SUPER_RLM_SUPERVISOR_PYTHON: "C:/custom/python.exe" },
      exists: () => false,
    }),
    "C:/custom/python.exe",
  );
  assert.equal(resolveSupervisorPython(config, { env: {}, exists: () => true }), config.workerPython);
});

test("buildSupervisorInvocation runs the helper with the plan path", () => {
  const config = testConfig();
  const invocation = buildSupervisorInvocation(config, "C:/tmp/plan.json", {
    env: { SUPER_RLM_SUPERVISOR_PYTHON: "C:/custom/python.exe" },
    exists: () => true,
  });
  assert.equal(invocation.command, "C:/custom/python.exe");
  assert.equal(invocation.args.length, 2);
  assert.equal(invocation.args[0], join(config.repoRoot, "apps", "cli", "supervisor", "job_supervisor.py"));
  assert.equal(invocation.args[1], "C:/tmp/plan.json");
});

test("parseDaemonStatus reads current daemons and ignores stale unreachable entries", () => {
  const entries = parseDaemonStatus(JSON.stringify([
    { socketPath: "C:/x/worker.sock", pid: 123, status: "current", sessionCount: 2 },
    { socketPath: "C:/x/worker.sock", pid: 456, status: "unreachable" },
  ]));
  assert.equal(entries.length, 2);
  assert.deepEqual(runningDaemons(entries).map((entry) => entry.pid), [123]);
  assert.deepEqual(parseDaemonStatus("[]"), []);
  assert.deepEqual(parseDaemonStatus(""), []);
});

test("describeRunningStack explains each running component", () => {
  const empty: RunningStack = {
    orchestrator: { name: "orchestrator", healthy: false, pid: null, alive: false },
    worker: { name: "worker", healthy: false, pid: null, alive: false },
    daemons: [],
  };
  assert.equal(hasRunningStack(empty), false);
  assert.deepEqual(describeRunningStack(empty), []);

  const running: RunningStack = {
    orchestrator: { name: "orchestrator", healthy: true, pid: 11, alive: true },
    worker: { name: "worker", healthy: true, pid: 22, alive: true },
    daemons: [{ pid: 33, status: "current", socketPath: "x", sessionCount: 0 }],
  };
  assert.equal(hasRunningStack(running), true);
  assert.deepEqual(describeRunningStack(running), [
    "orchestrator (pid 11)",
    "worker (pid 22)",
    "Prime Agent daemon (pid 33)",
  ]);
  assert.equal(hasRunningStack({ ...empty, supervisorPid: 44 }), true);
  assert.match(describeRunningStack({ ...empty, supervisorPid: 44 }).join("\n"), /TUI supervisor \(pid 44\)/);

  const unknown: RunningStack = { ...empty, daemonError: "status failed" };
  assert.equal(hasRunningStack(unknown), true);
  assert.match(describeRunningStack(unknown).join("\n"), /status is unavailable: status failed/);
});

test("readSupervisorPid reads only a positive numeric pid", () => {
  const config = testConfig();
  assert.equal(readSupervisorPid(config), null);
  writeFileSync(join(config.home, "supervisor.pid"), "4321\n");
  assert.equal(readSupervisorPid(config), 4321);
  writeFileSync(join(config.home, "supervisor.pid"), "not-a-pid");
  assert.equal(readSupervisorPid(config), null);
});

test("canonical daemon socket is absolute and stable", () => {
  const config = testConfig();
  const expected = process.platform === "win32"
    ? resolve("C:/temp/Project/Worker.sock").toLowerCase().replaceAll("/", "\\")
    : resolve("C:/temp/Project/Worker.sock");
  assert.equal(canonicalDaemonSocket("C:/temp/Project/Worker.sock"), expected);
  assert.equal(canonicalDaemonSocket(config.primeDaemonSocket), config.primeDaemonSocket);
});
