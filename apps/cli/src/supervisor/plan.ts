import { join } from "node:path";

import { orchestratorEnv, workerEnv, type CliConfig } from "../config.ts";
import { primeAgentOverrides } from "../daemon.ts";
import { servicePaths, serviceUrl } from "../services.ts";

export interface SupervisorChildPlan {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdio: "inherit" | "log";
  log?: string;
  pid?: string;
  health_url?: string;
  startup_timeout_ms: number;
}

export interface SupervisorShutdownPlan {
  orchestrator_url: string;
  router_token: string;
  worker_url: string;
  worker_token: string;
  cancel_timeout_ms: number;
  session_stop_timeout_ms: number;
  prime_agent: string;
  prime_agent_env: Record<string, string>;
  prime_agent_env_strip: string[];
  prime_agent_timeout_ms: number;
  process_stop_timeout_ms: number;
}

export interface SupervisorPlan {
  version: 1;
  job_name: string;
  supervisor_pid_path: string;
  tui_child: string;
  children: SupervisorChildPlan[];
  shutdown: SupervisorShutdownPlan;
}

export interface BuildSupervisorPlanOptions {
  originCwd: string;
  tuiEntry: string;
  tuiEnv: NodeJS.ProcessEnv;
}

/**
 * Reduce an environment to only the values that differ from the base process.
 *
 * The Python supervisor inherits this process's environment, so unchanged
 * values (including provider credentials) are never written to the plan file.
 */
export function envOverrides(
  desired: NodeJS.ProcessEnv,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined || base[key] === value) continue;
    overrides[key] = value;
  }
  return overrides;
}

export function jobNameFor(config: CliConfig, stamp: number = Date.now()): string {
  const project = config.projectId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `super-rlm-${project}-${stamp}`;
}

export function buildSupervisorPlan(
  config: CliConfig,
  options: BuildSupervisorPlanOptions,
): SupervisorPlan {
  const orchestratorUrl = config.orchestratorUrl.replace(/\/$/, "");
  const workerUrl = `http://127.0.0.1:${config.workerPort}`;
  return {
    version: 1,
    job_name: jobNameFor(config),
    supervisor_pid_path: join(config.home, "supervisor.pid"),
    tui_child: "tui",
    children: [
      {
        name: "orchestrator",
        command: process.execPath,
        args: [config.orchestratorMain],
        cwd: config.repoRoot,
        env: envOverrides(orchestratorEnv(config)),
        stdio: "log",
        log: servicePaths(config, "orchestrator").log,
        pid: servicePaths(config, "orchestrator").pid,
        health_url: serviceUrl(config, "orchestrator"),
        startup_timeout_ms: 30_000,
      },
      {
        name: "worker",
        command: config.workerPython,
        args: ["-m", "super_rlm_worker.main"],
        cwd: config.workerDir,
        env: envOverrides(workerEnv(config)),
        stdio: "log",
        log: servicePaths(config, "worker").log,
        pid: servicePaths(config, "worker").pid,
        health_url: serviceUrl(config, "worker"),
        startup_timeout_ms: 45_000,
      },
      {
        name: "tui",
        command: process.execPath,
        args: [options.tuiEntry],
        cwd: options.originCwd,
        env: envOverrides(options.tuiEnv),
        stdio: "inherit",
        startup_timeout_ms: 0,
      },
    ],
    shutdown: {
      orchestrator_url: orchestratorUrl,
      router_token: config.routerToken,
      worker_url: workerUrl,
      worker_token: config.workerToken,
      cancel_timeout_ms: 15_000,
      session_stop_timeout_ms: 20_000,
      prime_agent: config.primeAgent,
      prime_agent_env: primeAgentOverrides(config),
      prime_agent_env_strip: ["PI_", "PRIME_AGENT_", "RLM_"],
      prime_agent_timeout_ms: 30_000,
      process_stop_timeout_ms: 5_000,
    },
  };
}
