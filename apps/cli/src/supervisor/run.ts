import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliConfig } from "../config.ts";
import type { SupervisorPlan } from "./plan.ts";

export interface ResolveSupervisorPythonOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

export interface SupervisorInvocation {
  command: string;
  args: string[];
}

export function supervisorHelperPath(config: CliConfig): string {
  return join(config.repoRoot, "apps", "cli", "supervisor", "job_supervisor.py");
}

/**
 * Pick the Python used only for the Windows Job supervisor.
 *
 * The Worker venv is the project-owned interpreter and is therefore the
 * default. `SUPER_RLM_SUPERVISOR_PYTHON` overrides it; `python` from PATH is the
 * last resort. The helper fails closed when the Job APIs are unavailable.
 */
export function resolveSupervisorPython(
  config: CliConfig,
  options: ResolveSupervisorPythonOptions = {},
): string {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const override = env.SUPER_RLM_SUPERVISOR_PYTHON?.trim();
  if (override) return override;
  if (exists(config.workerPython)) return config.workerPython;
  return process.platform === "win32" ? "python" : "python3";
}

export function buildSupervisorInvocation(
  config: CliConfig,
  planPath: string,
  options: ResolveSupervisorPythonOptions = {},
): SupervisorInvocation {
  return {
    command: resolveSupervisorPython(config, options),
    args: [supervisorHelperPath(config), planPath],
  };
}

export async function runSupervisor(
  plan: SupervisorPlan,
  config: CliConfig,
  options: ResolveSupervisorPythonOptions = {},
): Promise<number> {
  const helper = supervisorHelperPath(config);
  if (!existsSync(helper)) {
    throw new Error(`Job supervisor helper not found: ${helper}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-supervisor-"));
  const planPath = join(dir, "plan.json");
  try {
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const invocation = buildSupervisorInvocation(config, planPath, options);
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: config.repoRoot,
        env: process.env,
        stdio: "inherit",
        windowsHide: false,
      });
      child.on("error", (error) => reject(error));
      child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
