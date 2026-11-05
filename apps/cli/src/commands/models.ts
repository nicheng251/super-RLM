
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";

import type { CliConfig } from "../config.ts";

export interface ModelsConfig {
  providers: Record<string, Record<string, unknown>>;
}

/** Parse `<home>/secrets/providers.env`; comments and malformed lines are ignored. */
export function readProviderSecrets(home: string): Record<string, string> {
  const path = join(home, "secrets", "providers.env");
  if (!existsSync(path)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return result;
}

function readSecrets(config: CliConfig): Record<string, string> {
  return readProviderSecrets(config.home);
}

function resolveSecrets(value: unknown, env: NodeJS.ProcessEnv, secrets: Record<string, string>): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    const name = value.slice(1);
    const resolved = env[name] ?? secrets[name];
    if (!resolved) throw new Error(`missing secret: ${name}`);
    return resolved;
  }
  if (Array.isArray(value)) return value.map((item) => resolveSecrets(item, env, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveSecrets(item, env, secrets)]));
  }
  return value;
}

export function loadModelsConfig(path: string): ModelsConfig {
  if (!existsSync(path)) throw new Error(`models config not found: ${path}`);
  const parsed = parse(readFileSync(path, "utf8")) as ModelsConfig | null;
  if (!parsed || typeof parsed !== "object" || !parsed.providers || typeof parsed.providers !== "object") {
    throw new Error("models config must contain a providers object");
  }
  for (const [name, provider] of Object.entries(parsed.providers)) {
    if (!provider || typeof provider !== "object") throw new Error(`provider ${name} must be an object`);
    if (!Array.isArray((provider as { models?: unknown }).models)) {
      throw new Error(`provider ${name} must have a models array`);
    }
  }
  return parsed;
}

export function syncModels(config: CliConfig, options: { configPath?: string; dryRun?: boolean; env?: NodeJS.ProcessEnv } = {}): number {
  const configPath = options.configPath ?? process.env.SUPER_RLM_MODELS_CONFIG ?? join(config.repoRoot, "config", "models.yaml");
  let models: ModelsConfig;
  try {
    models = loadModelsConfig(configPath);
  } catch (error) {
    console.error(`[models] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const secrets = readSecrets(config);
  let resolved: ModelsConfig;
  try {
    // models.json is consumed by Pi/Prime, which only understand `providers`.
    // The CLI-only `default` section stays in config/models.yaml.
    resolved = { providers: resolveSecrets(models.providers, options.env ?? process.env, secrets) as ModelsConfig["providers"] };
  } catch (error) {
    console.error(`[models] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const body = JSON.stringify(resolved, null, 2) + "\n";
  const targets = [
    join(config.home, "pi", "agent", "models.json"),
    join(config.home, "prime", "agent", "models.json"),
  ];
  if (options.dryRun) {
    console.log(`[models] source: ${configPath}`);
    for (const target of targets) console.log(`[models] would write ${target}`);
    return 0;
  }
  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(target, 0o600); } catch { /* Windows */ }
  }
  console.log(`[models] wrote ${targets.length} models.json files from ${configPath}`);
  for (const [name, provider] of Object.entries(resolved.providers)) {
    const modelIds = (provider.models as Array<{ id?: string }>).map((model) => model.id).filter(Boolean);
    console.log(`  ${name}: ${modelIds.join(", ")}`);
  }
  return 0;
}
