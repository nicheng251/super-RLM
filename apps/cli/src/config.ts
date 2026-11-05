
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface CliConfig {
  repoRoot: string;
  projectId: string;
  home: string;
  workspaceRoot: string;
  port: number;
  workerPort: number;
  orchestratorUrl: string;
  routerToken: string;
  workerToken: string;
  callbackKey: string;
  piCli: string;
  routerDir: string;
  routerExtension: string;
  routerPrompt: string;
  primeAgent: string;
  /** Project Prime Agent daemon socket, canonicalized the same way as the Worker. */
  primeDaemonSocket: string;
  orchestratorMain: string;
  workerDir: string;
  workerPython: string;
  kernelVenv: string;
  kernelPython: string;
  /** uv executable: SUPER_RLM_UV, the bundled runtime uv, or PATH. */
  uvPath: string;
  reportSkill: string;
  workerPrompt: string;
  primeProvider: string;
  primeModel: string;
  primeModelName: string | null;
  primeThinking: string | null;
  primeContextWindow: number | null;
  modelsConfigPath: string;
  bashShell: string | null;
  maxConcurrency: number;
}

export function findRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/**
 * Resolve uv for the packaged install.
 *
 * Order: explicit `SUPER_RLM_UV`, then the bundled runtime (`runtime/bin`),
 * then the PATH command name. The override is used verbatim so a user can
 * point at any executable, including one with spaces.
 */
export function resolveUvPath(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  const override = env.SUPER_RLM_UV?.trim();
  if (override) return override;
  const bundled = join(repoRoot, "runtime", "bin", platform === "win32" ? "uv.exe" : "uv");
  if (exists(bundled)) return bundled;
  return platform === "win32" ? "uv.exe" : "uv";
}

/**
 * Return the one daemon socket string used by the Worker, status, and shutdown.
 *
 * Prime Agent keys daemon identity to the raw socket path string. The Worker
 * canonicalizes with `os.path.abspath` + `os.path.normcase`; on Windows that is
 * an absolute, lower-cased, backslash-separated path. Admin commands must use
 * the same spelling or they target a different daemon.
 */
export function canonicalDaemonSocket(value: string): string {
  const absolute = resolve(value);
  return process.platform === "win32"
    ? absolute.toLowerCase().replaceAll("/", "\\")
    : absolute;
}

export interface ModelDefault {
  provider: string;
  model: string;
  /** Human-readable model name from config/models.yaml, when present. */
  name?: string;
  /** Router thinking level from the CLI-only default section. */
  thinking?: string;
  /** Context window of the default model, when the registry declares it. */
  contextWindow?: number;
}

/** Reads the CLI-only `default` section from a models config. A missing, unreadable, or malformed file yields null. */
export function readModelDefault(path: string): ModelDefault | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const section = (parsed as { default?: unknown }).default;
  if (!section || typeof section !== "object") return null;
  const provider = (section as { provider?: unknown }).provider;
  const model = (section as { model?: unknown }).model;
  if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) return null;
  const result: ModelDefault = { provider, model };
  const thinking = (section as { thinking?: unknown }).thinking;
  if (typeof thinking === "string" && thinking.trim()) result.thinking = thinking;
  const providers = (parsed as { providers?: unknown }).providers;
  if (providers && typeof providers === "object") {
    const providerEntry = (providers as Record<string, unknown>)[provider];
    if (providerEntry && typeof providerEntry === "object") {
      const models = (providerEntry as { models?: unknown }).models;
      if (Array.isArray(models)) {
        const match = models.find((entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === model);
        if (match && typeof (match as { name?: unknown }).name === "string") {
          result.name = (match as { name: string }).name;
        }
        const contextWindow = match && typeof match === "object"
          ? (match as { contextWindow?: unknown }).contextWindow
          : undefined;
        if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
          result.contextWindow = contextWindow;
        }
      }
    }
  }
  return result;
}

export interface ModelInfo {
  provider: string;
  model: string;
  name?: string;
  contextWindow?: number;
}

/** Looks up display metadata for a provider/model in a models config. */
export function lookupModelInfo(path: string, provider: string, model: string): ModelInfo | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const providers = (parsed as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object") return null;
  const providerEntry = (providers as Record<string, unknown>)[provider];
  if (!providerEntry || typeof providerEntry !== "object") return null;
  const models = (providerEntry as { models?: unknown }).models;
  if (!Array.isArray(models)) return null;
  const match = models.find((entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === model);
  if (!match || typeof match !== "object") return null;
  const info: ModelInfo = { provider, model };
  if (typeof (match as { name?: unknown }).name === "string") info.name = (match as { name: string }).name;
  const contextWindow = (match as { contextWindow?: unknown }).contextWindow;
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
    info.contextWindow = contextWindow;
  }
  return info;
}

export const SECRET_ENV_KEYS = [
  "SUPER_RLM_ROUTER_TOKEN",
  "SUPER_RLM_WORKER_TOKEN",
  "SUPER_RLM_CALLBACK_KEY",
] as const;

export type SecretEnvKey = (typeof SECRET_ENV_KEYS)[number];

const SECRET_KEY_SET: ReadonlySet<string> = new Set(SECRET_ENV_KEYS);

export interface CliSecrets {
  routerToken: string;
  workerToken: string;
  callbackKey: string;
  file: string;
}

export function secretsFilePath(home: string): string {
  return join(home, "secrets", "api.env");
}

/** Parse the small KEY=VALUE secret file. Unknown keys and malformed lines are ignored. */
export function parseSecretsFile(text: string): Partial<Record<SecretEnvKey, string>> {
  const parsed: Partial<Record<SecretEnvKey, string>> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!SECRET_KEY_SET.has(key)) continue;
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) parsed[key as SecretEnvKey] = value;
  }
  return parsed;
}

function randomSecret(): string {
  return randomBytes(32).toString("hex");
}

function writeSecretsFile(file: string, values: Record<SecretEnvKey, string>): void {
  const body = [
    "# super-RLM local API secrets. Generated on first use; keep this file private.",
    ...SECRET_ENV_KEYS.map((key) => `${key}=${values[key]}`),
    "",
  ].join("\n");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort: Windows and some filesystems do not model POSIX modes.
  }
}

/**
 * Load the project API secrets, generating missing values on first use.
 *
 * The file is the normal production source. Explicit environment values win
 * for the returned config (useful for tests and intentional rotation), but they
 * are not persisted; generated values are written with owner-only permissions
 * where the platform supports it. Failures to read or write the file degrade to
 * ephemeral values so `status` and `down` keep working.
 */
export function loadOrCreateSecrets(home: string, env: NodeJS.ProcessEnv = process.env): CliSecrets {
  const file = secretsFilePath(home);
  let fromFile: Partial<Record<SecretEnvKey, string>> = {};
  try {
    if (existsSync(file)) fromFile = parseSecretsFile(readFileSync(file, "utf8"));
  } catch {
    fromFile = {};
  }

  const fileValues = {} as Record<SecretEnvKey, string>;
  let changed = !existsSync(file);
  for (const key of SECRET_ENV_KEYS) {
    const current = fromFile[key];
    if (current) {
      fileValues[key] = current;
    } else {
      fileValues[key] = randomSecret();
      changed = true;
    }
  }
  if (changed) {
    try {
      writeSecretsFile(file, fileValues);
    } catch {
      // Read-only or otherwise unavailable home: keep working in memory.
    }
  }

  const valueFor = (key: SecretEnvKey): string => env[key]?.trim() || fileValues[key];
  return {
    routerToken: valueFor("SUPER_RLM_ROUTER_TOKEN"),
    workerToken: valueFor("SUPER_RLM_WORKER_TOKEN"),
    callbackKey: valueFor("SUPER_RLM_CALLBACK_KEY"),
    file,
  };
}

export const REDACTED = "[redacted]";

/** Copy of the CLI config safe to print: token and key fields are replaced. */
export function redactConfig(config: CliConfig): Record<string, unknown> {
  return {
    ...config,
    routerToken: REDACTED,
    workerToken: REDACTED,
    callbackKey: REDACTED,
  };
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

export function loadConfig(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  projectId?: string;
  home?: string;
  modelsConfigPath?: string;
} = {}): CliConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = findRepoRoot();
  const modelsConfigPath = options.modelsConfigPath ?? env.SUPER_RLM_MODELS_CONFIG ?? join(repoRoot, "config", "models.yaml");
  const modelDefault = readModelDefault(modelsConfigPath);
  const projectId = options.projectId ?? readProjectId(cwd, env);
  const home = options.home ?? env.SUPER_RLM_HOME ?? join(homedir(), ".super-rlm", "projects", projectId);
  const secrets = loadOrCreateSecrets(home, env);
  const workspaceRoot = env.SUPER_RLM_WORKSPACES ?? join(home, "workspaces");
  const port = Number(env.SUPER_RLM_PORT ?? "8787");
  const workerPort = Number(env.SUPER_RLM_WORKER_PORT ?? "8080");
  const kernelVenv = env.SUPER_RLM_KERNEL_VENV ?? join(home, "prime", "kernel-venv");
  const kernelPython = env.SUPER_RLM_KERNEL_PYTHON
    ?? join(kernelVenv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const bashShell = env.SUPER_RLM_BASH_SHELL
    ?? (process.platform === "win32" && existsSync("C:/Program Files/Git/bin/bash.exe")
      ? "C:/Program Files/Git/bin/bash.exe"
      : null);
  const modelChanged = Boolean(env.SUPER_RLM_PRIME_PROVIDER || env.SUPER_RLM_PRIME_MODEL);
  const primeProvider = env.SUPER_RLM_PRIME_PROVIDER ?? modelDefault?.provider ?? "fake";
  const primeModel = env.SUPER_RLM_PRIME_MODEL ?? modelDefault?.model ?? "fake-1";
  const contextRaw = env.SUPER_RLM_PRIME_CONTEXT_WINDOW;
  const contextOverride = contextRaw ? Number(contextRaw) : null;
  const primeContextWindow = contextOverride && Number.isFinite(contextOverride) && contextOverride > 0
    ? contextOverride
    : modelChanged ? null : modelDefault?.contextWindow ?? null;
  return {
    repoRoot,
    projectId,
    home,
    workspaceRoot,
    port,
    workerPort,
    orchestratorUrl: env.SUPER_RLM_ORCHESTRATOR_URL ?? `http://127.0.0.1:${port}`,
    routerToken: secrets.routerToken,
    workerToken: secrets.workerToken,
    callbackKey: secrets.callbackKey,
    piCli: join(repoRoot, "runtime", "pi", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
    routerDir: join(repoRoot, "apps", "router"),
    routerExtension: join(repoRoot, "apps", "router", "extensions", "super-rlm.ts"),
    routerPrompt: join(repoRoot, "apps", "router", "prompts", "router.md"),
    primeAgent: join(repoRoot, "runtime", "prime-agent", process.platform === "win32" ? "prime-agent.exe" : "prime-agent"),
    primeDaemonSocket: canonicalDaemonSocket(
      env.SUPER_RLM_PRIME_DAEMON ?? join(home, "prime", "daemon", "worker.sock"),
    ),
    orchestratorMain: join(repoRoot, "apps", "orchestrator", "src", "main.ts"),
    workerDir: join(repoRoot, "apps", "worker"),
    workerPython: join(repoRoot, "apps", "worker", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
    kernelVenv,
    kernelPython,
    uvPath: resolveUvPath(repoRoot, env),
    reportSkill: join(repoRoot, "apps", "worker", "skills", "super-rlm-report"),
    workerPrompt: join(repoRoot, "apps", "worker", "prompts", "worker.md"),
    primeProvider,
    primeModel,
    primeModelName: env.SUPER_RLM_PRIME_MODEL_NAME || (modelChanged ? null : modelDefault?.name ?? null),
    primeThinking: env.SUPER_RLM_PRIME_THINKING || modelDefault?.thinking || null,
    primeContextWindow,
    modelsConfigPath,
    bashShell,
    maxConcurrency: Number(env.SUPER_RLM_MAX_CONCURRENCY ?? "2"),
  };
}

export function ensureDirs(config: CliConfig): void {
  const dirs = [
    join(config.home, "secrets"),
    join(config.home, "pi", "agent"),
    join(config.home, "pi", "sessions"),
    join(config.home, "prime", "agent"),
    join(config.home, "prime", "sessions"),
    join(config.home, "prime", "daemon"),
    join(config.home, "orchestrator"),
    config.workspaceRoot,
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
  if (config.primeThinking) args.push("--thinking", config.primeThinking);
  if (existsSync(config.routerPrompt)) args.push("--append-system-prompt", config.routerPrompt);
  args.push(...(options.extraArgs ?? []));
  return args;
}

export function routerEnv(config: CliConfig, originCwd: string = process.cwd()): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PI_CODING_AGENT_DIR: join(config.home, "pi", "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(config.home, "pi", "sessions"),
    SUPER_RLM_ORCHESTRATOR_URL: config.orchestratorUrl,
    SUPER_RLM_ROUTER_TOKEN: config.routerToken,
    SUPER_RLM_HOME: config.home,
    SUPER_RLM_ORIGIN_CWD: originCwd,
  };
}

export function orchestratorEnv(config: CliConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SUPER_RLM_HOME: config.home,
    SUPER_RLM_WORKSPACES: config.workspaceRoot,
    SUPER_RLM_PORT: String(config.port),
    SUPER_RLM_ROUTER_TOKEN: config.routerToken,
    SUPER_RLM_WORKER_TOKEN: config.workerToken,
    SUPER_RLM_CALLBACK_KEY: config.callbackKey,
    SUPER_RLM_MAX_CONCURRENT_TICKETS: process.env.SUPER_RLM_MAX_CONCURRENT_TICKETS ?? "4",
    SUPER_RLM_MAX_CONCURRENT_TICKETS_PER_TASK: process.env.SUPER_RLM_MAX_CONCURRENT_TICKETS_PER_TASK ?? "2",
  };
}

export function workerEnv(config: CliConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SUPER_RLM_HOME: config.home,
    SUPER_RLM_WORKSPACES: config.workspaceRoot,
    SUPER_RLM_ORCHESTRATOR_URL: config.orchestratorUrl,
    SUPER_RLM_WORKER_PORT: String(config.workerPort),
    SUPER_RLM_WORKER_TOKEN: config.workerToken,
    SUPER_RLM_CALLBACK_KEY: config.callbackKey,
    SUPER_RLM_PRIME_AGENT: config.primeAgent,
    SUPER_RLM_PRIME_DAEMON: config.primeDaemonSocket,
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
