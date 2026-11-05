
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { buildRouterArgs, ensureDirs, routerEnv, type CliConfig, type RouterOptions } from "../config.ts";

export async function runRouter(config: CliConfig, options: RouterOptions = {}): Promise<number> {
  ensureDirs(config);
  if (!existsSync(config.piCli)) {
    console.error(`Pi CLI not found: ${config.piCli}\nRun the project bootstrap or check runtime/pi.`);
    return 1;
  }
  const models = join(config.home, "pi", "agent", "models.json");
  if (!existsSync(models)) {
    console.error(`warning: ${models} is missing; Pi needs a provider entry for ${config.primeProvider}/${config.primeModel}`);
  }
  const args = buildRouterArgs(config, options);
  return await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [config.piCli, ...args], {
      cwd: config.routerDir,
      env: routerEnv(config, process.cwd()),
      stdio: "inherit",
    });
    child.on("error", (error) => {
      console.error(`failed to launch Pi: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
