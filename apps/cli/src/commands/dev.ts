
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { ensureDirs, orchestratorEnv, workerEnv, type CliConfig } from "../config.ts";

function prefix(label: string, child: { stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null }): void {
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[${label}] ${chunk.toString()}`));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[${label}] ${chunk.toString()}`));
}

export async function runDev(config: CliConfig): Promise<number> {
  ensureDirs(config);
  if (!existsSync(config.orchestratorMain)) {
    console.error(`Orchestrator entry not found: ${config.orchestratorMain}`);
    return 1;
  }
  if (!existsSync(config.workerPython)) {
    console.error(`Worker venv not found: ${config.workerPython}\nRun: cd apps/worker && uv venv --python 3.11 .venv && uv pip install --python .venv/Scripts/python.exe -e ".[dev]"`);
    return 1;
  }

  const orchestrator = spawn(process.execPath, [config.orchestratorMain], {
    env: orchestratorEnv(config),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const worker = spawn(config.workerPython, ["-m", "super_rlm_worker.main"], {
    cwd: config.workerDir,
    env: workerEnv(config),
    stdio: ["ignore", "pipe", "pipe"],
  });
  prefix("orchestrator", orchestrator);
  prefix("worker", worker);

  console.log(`Orchestrator: http://127.0.0.1:${config.port}`);
  console.log(`Worker:       http://127.0.0.1:${config.workerPort}`);
  console.log(`Runtime:      ${config.home}`);

  return await new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (code: number): void => {
      if (stopping) return;
      stopping = true;
      orchestrator.kill();
      worker.kill();
      setTimeout(() => resolve(code), 300).unref();
    };
    orchestrator.on("exit", (code) => stop(code ?? 1));
    worker.on("exit", (code) => stop(code ?? 1));
    process.on("SIGINT", () => stop(0));
    process.on("SIGTERM", () => stop(0));
  });
}
