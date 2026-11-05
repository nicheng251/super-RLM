import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { ensureDirs, findRepoRoot, loadConfig, type CliConfig } from "../config.ts";
import { runBootstrap } from "./bootstrap.ts";
import { nodeVersionOk, runDoctor } from "./doctor.ts";
import { runInit } from "./init.ts";
import { loadModelsConfig, readProviderSecrets, syncModels } from "./models.ts";

export const SETUP_USAGE = `Usage: super-rlm setup [--provider <name>] [--model <id>] [--allow-missing-key]

Prepare this project on first run:
  1. create .super-rlm-project.json
  2. check Node, uv, and the selected provider API key
  3. create the project kernel venv and Worker venv, install the runtime and report skill
  4. write <home>/pi/agent/models.json and <home>/prime/agent/models.json
  5. run doctor

It never starts the TUI. After setup, run: super-rlm`;

export interface SetupArgs {
  provider?: string;
  model?: string;
  allowMissingKey: boolean;
  help: boolean;
}

export function parseSetupArgs(argv: string[]): SetupArgs | { error: string } {
  const parsed: SetupArgs = { allowMissingKey: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--allow-missing-key") {
      parsed.allowMissingKey = true;
    } else if (arg === "--provider" || arg === "--model") {
      const value = argv[++index];
      if (!value || value.startsWith("-")) return { error: `${arg} requires a value` };
      if (arg === "--provider") parsed.provider = value;
      else parsed.model = value;
    } else if (arg.startsWith("--provider=") || arg.startsWith("--model=")) {
      const value = arg.slice(arg.indexOf("=") + 1);
      if (!value) return { error: `${arg.slice(0, arg.indexOf("="))} requires a value` };
      if (arg.startsWith("--provider=")) parsed.provider = value;
      else parsed.model = value;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return parsed;
}

type BootstrapFn = (config: CliConfig) => Promise<number>;
type SyncFn = (config: CliConfig) => number;
type DoctorFn = (config: CliConfig, options?: { json?: boolean }) => Promise<number>;

export interface SetupOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  provider?: string;
  model?: string;
  allowMissingKey?: boolean;
  /** Test hook: override the running Node version. */
  nodeVersion?: string;
  /** Test hook: report whether the uv executable can run. */
  uvCheck?: (path: string) => boolean;
  init?: (cwd: string) => number;
  bootstrap?: BootstrapFn;
  sync?: SyncFn;
  doctor?: DoctorFn;
}

/** Run `uv --version`; a bare command name resolves through PATH. */
export function uvAvailable(path: string): boolean {
  const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 15_000 });
  return result.status === 0;
}

/**
 * Read the provider's `apiKey` reference from the model registry.
 *
 * Returns the environment variable name when `apiKey` is `$NAME`, or null when
 * the provider needs no file-managed key. An unknown provider or model is an
 * error so setup fails before writing an unusable registry.
 */
export function providerKeyVariable(
  modelsConfigPath: string,
  provider: string,
  model?: string,
): string | null {
  const models = loadModelsConfig(modelsConfigPath);
  const entry = models.providers[provider];
  if (!entry) {
    const available = Object.keys(models.providers).join(", ") || "none";
    throw new Error(`provider '${provider}' is not defined in ${modelsConfigPath} (available: ${available})`);
  }
  if (model) {
    const ids = (entry.models as Array<{ id?: unknown }>)
      .map((item) => (typeof item?.id === "string" ? item.id : null))
      .filter((id): id is string => Boolean(id));
    if (!ids.includes(model)) {
      throw new Error(`model '${model}' is not defined for provider '${provider}'; pass --model <id> (available: ${ids.join(", ") || "none"})`);
    }
  }
  const apiKey = entry.apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) return null;
  const value = apiKey.trim();
  return value.startsWith("$") && value.length > 1 ? value.slice(1) : null;
}

export function providerKeyPresent(
  home: string,
  envName: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env[envName]?.trim() || readProviderSecrets(home)[envName]?.trim());
}

export async function runSetup(argv: string[], options: SetupOptions = {}): Promise<number> {
  const parsed = parseSetupArgs(argv);
  if ("error" in parsed) {
    console.error(`super-rlm setup: ${parsed.error}\n\n${SETUP_USAGE}`);
    return 1;
  }
  if (parsed.help) {
    console.log(SETUP_USAGE);
    return 0;
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  if (!nodeVersionOk(options.nodeVersion ?? process.versions.node)) {
    console.error(`super-rlm setup: Node >= 22.19 is required (found ${options.nodeVersion ?? process.versions.node}).`);
    return 1;
  }
  if (cwd === findRepoRoot()) {
    console.error("super-rlm setup: run this command from your project directory, not the super-RLM install directory.");
    return 1;
  }

  const init = options.init ?? runInit;
  const bootstrap = options.bootstrap ?? ((config: CliConfig) => runBootstrap(config));
  const sync = options.sync ?? ((config: CliConfig) => syncModels(config));
  const doctor = options.doctor ?? runDoctor;
  const uvCheck = options.uvCheck ?? uvAvailable;

  init(cwd);

  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const provider = parsed.provider ?? options.provider;
  const model = parsed.model ?? options.model;
  if (provider) env.SUPER_RLM_PRIME_PROVIDER = provider;
  if (model) env.SUPER_RLM_PRIME_MODEL = model;
  const config = loadConfig({ cwd, env });
  const allowMissingKey = parsed.allowMissingKey || Boolean(options.allowMissingKey);

  if (!uvCheck(config.uvPath)) {
    console.error(`super-rlm setup: uv was not found or is not executable: ${config.uvPath}\nInstall uv, or set SUPER_RLM_UV to the uv executable.`);
    return 1;
  }
  ensureDirs(config);

  let keyName: string | null;
  try {
    keyName = providerKeyVariable(config.modelsConfigPath, config.primeProvider, config.primeModel);
  } catch (error) {
    console.error(`super-rlm setup: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  // Check before bootstrap and models sync: sync cannot resolve a missing
  // key, so a later check would surface a generic models error instead of the
  // exact line to add to providers.env.
  const keyPresent = keyName === null || providerKeyPresent(config.home, keyName, env);
  const providersFile = join(config.home, "secrets", "providers.env");
  if (!keyPresent && !allowMissingKey) {
    console.error([
      `super-rlm setup: no API key for provider '${config.primeProvider}'.`,
      `Add this line to ${providersFile}:`,
      `  ${keyName}=<your ${config.primeProvider} API key>`,
      "",
      "Then run: super-rlm setup",
      `To register the models without a key, run: super-rlm setup --allow-missing-key`,
    ].join("\n"));
    return 1;
  }
  if (!keyPresent) {
    console.warn(`[setup] warning: ${keyName} is missing from ${providersFile}; add it before starting.`);
  }

  console.log("[setup] preparing kernel venv and report skill");
  const bootstrapCode = await bootstrap(config);
  if (bootstrapCode !== 0) {
    console.error("super-rlm setup: bootstrap failed; fix the error above, then run `super-rlm setup` again.");
    return bootstrapCode || 1;
  }

  console.log("[setup] syncing models");
  const syncCode = sync(config);
  if (syncCode !== 0) {
    if (!keyPresent && allowMissingKey) {
      console.warn("[setup] models sync skipped the missing provider key; add the key, then run `super-rlm models sync`.");
    } else {
      console.error("super-rlm setup: models sync failed; fix the error above, then run `super-rlm setup` again.");
      return syncCode || 1;
    }
  }

  console.log("[setup] running doctor");
  let doctorCode = 1;
  try {
    doctorCode = await doctor(config, { json: false });
  } catch (error) {
    console.warn(`[setup] doctor could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (doctorCode !== 0) {
    console.warn("[setup] doctor reported issues; run `super-rlm doctor` after fixing them.");
  }

  console.log("\n[setup] done.");
  if (!keyPresent) {
    console.warn(`[setup] ${keyName} is still missing; add it to ${providersFile} before starting.`);
  }
  console.log("Next: run `super-rlm` from this project.");
  return 0;
}
