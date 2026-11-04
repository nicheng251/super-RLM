
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CliConfig {
  repoRoot: string;
  projectId: string;
  home: string;
  port: number;
  workerPort: number;
  orchestratorUrl: string;
  routerToken: string;
  workerToken: string;
  piCli: string;
  routerDir: string;
  routerExtension: string;
  primeAgent: string;
  orchestratorMain: string;
  workerDir: string;
  workerPython: string;
  kernelVenv: string;
  kernelPython: string;
  reportSkill: string;
  workerPrompt: string;
  primeProvider: string;
  primeModel: string;
  bashShell: string | null;
  maxConcurrency: number;
}

export function findRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function readProjectId(cwd = process.cwd(), env = process.env): string {
  if (env.SUPER_RLM_PROJECT_ID) return env.SUPER_RLM_PROJECT_ID;
  const marker = join(cwd, ".super-rlm-project.json");
  if (existsSync(marker)) {
    try {
      const parsed = JSON.parse(readFileSync(marker, "utf8")) as { project_id?: string };
      if (parsed.project_id) return parsed.project_id;
    } catch {
      // A broken marker falls through to the default project.
    }
  }
  return "default";
}

export function loadConfig(options: { cwd?: string; env?: NodeJS.ProcessEnv; projectId?: string; home?: string } = {}): CliConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = findRepoRoot();
  const projectId = options.projectId ?? readProjectId(cwd, env);
  const home = options.home ?? env.SUPER_RLM_HOME ?? join(homedir(), ".super-rlm", "projects", projectId);
  const port = Number(env.SUPER_RLM_PORT ?? "8787");
  const workerPort = Number(env.SUPER_RLM_WORKER_PORT ?? "8080");
  const kernelVenv = env.SUPER_RLM_KERNEL_VENV ?? join(home, "prime", "kernel-venv");
  const kernelPython = env.SUPER_RLM_KERNEL_PYTHON
    ?? join(kernelVenv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const bashShell = env.SUPER_RLM_BASH_SHELL
    ?? (process.platform === "win32" && existsSync("C:/Program Files/Git/bin/bash.exe")
      ? "C:/Program Files/Git/bin/bash.exe"
      : null);
  return {
    repoRoot,
    projectId,
    home,
    port,
    workerPort,
    orchestratorUrl: env.SUPER_RLM_ORCHESTRATOR_URL ?? `http://127.0.0.1:${port}`,
    routerToken: env.SUPER_RLM_ROUTER_TOKEN ?? "dev-router-token",
    workerToken: env.SUPER_RLM_WORKER_TOKEN ?? "dev-worker-token",
    piCli: join(repoRoot, "runtime", "pi", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
    routerDir: join(repoRoot, "apps", "router"),
    routerExtension: join(repoRoot, "apps", "router", "extensions", "super-rlm.ts"),
    primeAgent: join(repoRoot, "runtime", "prime-agent", process.platform === "win32" ? "prime-agent.exe" : "prime-agent"),
    orchestratorMain: join(repoRoot, "apps", "orchestrator", "src", "main.ts"),
    workerDir: join(repoRoot, "apps", "worker"),
    workerPython: join(repoRoot, "apps", "worker", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
    kernelVenv,
    kernelPython,
    reportSkill: join(repoRoot, "apps", "worker", "skills", "super-rlm-report"),
    workerPrompt: join(repoRoot, "apps", "worker", "prompts", "worker.md"),
    primeProvider: env.SUPER_RLM_PRIME_PROVIDER ?? "fake",
    primeModel: env.SUPER_RLM_PRIME_MODEL ?? "fake-1",
    bashShell,
    maxConcurrency: Number(env.SUPER_RLM_MAX_CONCURRENCY ?? "2"),
  };
}

export function ensureDirs(config: CliConfig): void {
  const dirs = [
    join(config.home, "pi", "agent"),
    join(config.home, "pi", "sessions"),
    join(config.home, "prime", "agent"),
    join(config.home, "prime", "sessions"),
    join(config.home, "prime", "daemon"),
    join(config.home, "orchestrator"),
    join(config.home, "workspaces"),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

export interface RouterOptions {
  newSession?: boolean;
  sessionId?: string;
  extraArgs?: string[];
}

export function buildRouterArgs(config: CliConfig, options: RouterOptions = {}): string[] {
  const args = [
    "--no-extensions",
    "-e", config.routerExtension,
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
    "--no-mcp",
    "-nbt",
    "--session-dir", join(config.home, "pi", "sessions"),
  ];
  if (!options.newSession) {
    args.push("--session-id", options.sessionId ?? `super-rlm-router-${config.projectId}`);
  } else if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }
  if (config.primeProvider && config.primeModel) {
    args.push("--provider", config.primeProvider, "--model", config.primeModel);
  }
  args.push(...(options.extraArgs ?? []));
  return args;
}

export function routerEnv(config: CliConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PI_CODING_AGENT_DIR: join(config.home, "pi", "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(config.home, "pi", "sessions"),
    SUPER_RLM_ORCHESTRATOR_URL: config.orchestratorUrl,
    SUPER_RLM_ROUTER_TOKEN: config.routerToken,
    SUPER_RLM_HOME: config.home,
  };
}

export function orchestratorEnv(config: CliConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SUPER_RLM_HOME: config.home,
    SUPER_RLM_PORT: String(config.port),
    SUPER_RLM_ROUTER_TOKEN: config.routerToken,
    SUPER_RLM_WORKER_TOKEN: config.workerToken,
    SUPER_RLM_MAX_CONCURRENT_TICKETS: process.env.SUPER_RLM_MAX_CONCURRENT_TICKETS ?? "4",
    SUPER_RLM_MAX_CONCURRENT_TICKETS_PER_TASK: process.env.SUPER_RLM_MAX_CONCURRENT_TICKETS_PER_TASK ?? "2",
  };
}

export function workerEnv(config: CliConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SUPER_RLM_HOME: config.home,
    SUPER_RLM_ORCHESTRATOR_URL: config.orchestratorUrl,
    SUPER_RLM_WORKER_PORT: String(config.workerPort),
    SUPER_RLM_WORKER_TOKEN: config.workerToken,
    SUPER_RLM_PRIME_AGENT: config.primeAgent,
    SUPER_RLM_PRIME_PROVIDER: config.primeProvider,
    SUPER_RLM_PRIME_MODEL: config.primeModel,
    SUPER_RLM_KERNEL_VENV: config.kernelVenv,
    SUPER_RLM_KERNEL_PYTHON: config.kernelPython,
    SUPER_RLM_REPORT_SKILL: config.reportSkill,
    SUPER_RLM_WORKER_PROMPT: config.workerPrompt,
    SUPER_RLM_MAX_CONCURRENCY: String(config.maxConcurrency),
  };
  if (config.bashShell) env.SUPER_RLM_BASH_SHELL = config.bashShell;
  return env;
}
