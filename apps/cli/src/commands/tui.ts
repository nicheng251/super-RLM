import { existsSync } from "node:fs";
import { join } from "node:path";

import { ensureDirs, routerEnv, type CliConfig } from "../config.ts";
import { runStartupMaintenance, type StartupMaintenanceOptions, type StartupMaintenanceResult } from "../maintenance.ts";
import { detectRunningStack, describeRunningStack, hasRunningStack, type RunningStack } from "../supervisor/detect.ts";
import { buildSupervisorPlan, type SupervisorPlan } from "../supervisor/plan.ts";
import { runSupervisor } from "../supervisor/run.ts";

export interface RunTuiOptions {
  platform?: NodeJS.Platform;
  cwd?: string;
  detect?: (config: CliConfig) => Promise<RunningStack>;
  /** Test hook: return first-run setup gaps instead of reading the filesystem. */
  setupIssues?: (config: CliConfig, cwd: string, env: NodeJS.ProcessEnv) => string[];
  maintain?: (
    config: CliConfig,
    options: StartupMaintenanceOptions,
  ) => Promise<StartupMaintenanceResult>;
  start?: (plan: SupervisorPlan, config: CliConfig) => Promise<number>;
}

export function tuiEntry(config: CliConfig): string {
  return join(config.repoRoot, "apps", "tui", "src", "main.ts");
}

export function tuiEnv(
  config: CliConfig,
  originCwd: string = process.cwd(),
  profilesConfig: string | undefined = process.env.SUPER_RLM_PROFILES_CONFIG,
): NodeJS.ProcessEnv {
  const env = routerEnv(config, originCwd);
  env.SUPER_RLM_PROJECT_ID = config.projectId;
  env.SUPER_RLM_PORT = String(config.port);
  env.SUPER_RLM_WORKER_PORT = String(config.workerPort);
  env.SUPER_RLM_WORKSPACES = config.workspaceRoot;
  env.SUPER_RLM_PRIME_PROVIDER = config.primeProvider;
  env.SUPER_RLM_PRIME_MODEL = config.primeModel;
  env.SUPER_RLM_PRIME_MODEL_NAME = config.primeModelName ?? "";
  env.SUPER_RLM_PRIME_THINKING = config.primeThinking ?? "";
  env.SUPER_RLM_PRIME_CONTEXT_WINDOW = config.primeContextWindow ? String(config.primeContextWindow) : "";
  if (profilesConfig) env.SUPER_RLM_PROFILES_CONFIG = profilesConfig;
  return env;
}

function fail(message: string): number {
  console.error(`super-rlm: ${message}`);
  return 1;
}

/** First-run resources that `super-rlm setup` creates for this project. */
export function startupSetupIssues(
  config: CliConfig,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const issues: string[] = [];
  if (!env.SUPER_RLM_PROJECT_ID && !existsSync(join(cwd, ".super-rlm-project.json"))) {
    issues.push(`project marker ${join(cwd, ".super-rlm-project.json")}`);
  }
  if (!existsSync(config.kernelPython)) issues.push(`kernel venv ${config.kernelVenv}`);
  if (!existsSync(config.reportSkill)) issues.push(`report skill ${config.reportSkill}`);
  for (const path of [
    join(config.home, "pi", "agent", "models.json"),
    join(config.home, "prime", "agent", "models.json"),
  ]) {
    if (!existsSync(path)) issues.push(`models ${path}`);
  }
  return issues;
}

export async function runTui(config: CliConfig, options: RunTuiOptions = {}): Promise<number> {
  const entry = tuiEntry(config);
  if (!existsSync(entry)) {
    return fail(`TUI entry not found: ${entry}\nThe L3 terminal UI is not installed in this build.`);
  }
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return fail("the TUI stack must run inside a Windows Job Object; Job APIs are unavailable on this platform.");
  }
  const detect = options.detect ?? detectRunningStack;
  let stack: RunningStack;
  try {
    stack = await detect(config);
  } catch (error) {
    return fail(`could not determine whether services are running: ${error instanceof Error ? error.message : String(error)}\nRun \`super-rlm down\` before starting.`);
  }
  if (hasRunningStack(stack)) {
    const detail = describeRunningStack(stack).map((line) => `  - ${line}`).join("\n");
    return fail(`refusing to start because super-RLM is already running:\n${detail}\nRun \`super-rlm down\`, then start again.`);
  }

  const setupIssues = (options.setupIssues ?? startupSetupIssues)(
    config,
    options.cwd ?? process.cwd(),
    process.env,
  );
  if (setupIssues.length > 0) {
    const detail = setupIssues.map((line) => `  - missing ${line}`).join("\n");
    return fail(`first-run setup is incomplete for this project:\n${detail}\nRun \`super-rlm setup\` from this project, then start again.`);
  }

  if (!existsSync(config.orchestratorMain)) {
    return fail(`Orchestrator entry not found: ${config.orchestratorMain}`);
  }
  if (!existsSync(config.workerPython)) {
    return fail(`Worker venv not found: ${config.workerPython}\nRun: cd apps/worker && uv venv --python 3.11 .venv && uv pip install --python .venv/Scripts/python.exe -e ".[dev]"`);
  }
  if (!existsSync(config.primeAgent)) {
    return fail(`Prime Agent not found: ${config.primeAgent}`);
  }

  ensureDirs(config);
  const maintain = options.maintain ?? runStartupMaintenance;
  try {
    await maintain(config, {});
  } catch (error) {
    console.error(`super-rlm: startup maintenance failed: ${error instanceof Error ? error.message : String(error)}; continuing`);
  }

  const originCwd = process.cwd();
  const plan = buildSupervisorPlan(config, {
    originCwd,
    tuiEntry: entry,
    tuiEnv: tuiEnv(config, originCwd),
  });
  const start = options.start ?? runSupervisor;
  try {
    return await start(plan, config);
  } catch (error) {
    return fail(`could not start the TUI supervisor: ${error instanceof Error ? error.message : String(error)}`);
  }
}
