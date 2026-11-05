import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { routerEnv, type CliConfig } from "../config.ts";
import { ensureAllServices } from "../services.ts";

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
  if (profilesConfig) env.SUPER_RLM_PROFILES_CONFIG = profilesConfig;
  return env;
}

export async function runTui(config: CliConfig): Promise<number> {
  const entry = tuiEntry(config);
  if (!existsSync(entry)) {
    console.error(`TUI entry not found: ${entry}\nThe L3 terminal UI is not installed in this build.`);
    return 1;
  }
  await ensureAllServices(config);
  return await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [entry], {
      cwd: process.cwd(),
      env: tuiEnv(config, process.cwd()),
      stdio: "inherit",
    });
    child.on("error", (error) => {
      console.error(`failed to launch TUI: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
