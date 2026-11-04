
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { orchestratorEnv, workerEnv, type CliConfig } from "./config.ts";

export type ServiceName = "orchestrator" | "worker";

export interface ServicePaths {
  dir: string;
  pid: string;
  log: string;
}

export interface ServiceState {
  name: ServiceName;
  healthy: boolean;
  pid: number | null;
}

export function servicePaths(config: CliConfig, name: ServiceName): ServicePaths {
  const dir = join(config.home, name);
  return {
    dir,
    pid: join(dir, `${name}.pid`),
    log: join(dir, `${name}.log`),
  };
}

export function serviceUrl(config: CliConfig, name: ServiceName): string {
  return name === "orchestrator"
    ? `${config.orchestratorUrl}/health`
    : `http://127.0.0.1:${config.workerPort}/v1/health`;
}

export async function isHealthy(config: CliConfig, name: ServiceName): Promise<boolean> {
  try {
    const response = await fetch(serviceUrl(config, name), { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

export function readPid(config: CliConfig, name: ServiceName): number | null {
  const paths = servicePaths(config, name);
  if (!existsSync(paths.pid)) return null;
  const value = Number(readFileSync(paths.pid, "utf8").trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readLogTail(path: string, lines = 25): string {
  if (!existsSync(path)) return "";
  const body = readFileSync(path, "utf8").split(/\r?\n/);
  return body.slice(-lines).join("\n");
}

async function waitForHealth(config: CliConfig, name: ServiceName, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(config, name)) return true;
    await sleep(250);
  }
  return false;
}

function spawnService(config: CliConfig, name: ServiceName): number {
  const paths = servicePaths(config, name);
  mkdirSync(paths.dir, { recursive: true });
  const logFd = openSync(paths.log, "a");
  const child = name === "orchestrator"
    ? spawn(process.execPath, [config.orchestratorMain], {
        env: orchestratorEnv(config),
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      })
    : spawn(config.workerPython, ["-m", "super_rlm_worker.main"], {
        cwd: config.workerDir,
        env: workerEnv(config),
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      });
  closeSync(logFd);
  child.unref();
  if (!child.pid) throw new Error(`failed to start ${name}`);
  writeFileSync(paths.pid, String(child.pid), "utf8");
  return child.pid;
}

export async function ensureService(config: CliConfig, name: ServiceName): Promise<{ started: boolean; pid: number | null }> {
  if (await isHealthy(config, name)) {
    return { started: false, pid: readPid(config, name) };
  }
  if (name === "worker" && !existsSync(config.workerPython)) {
    throw new Error(`Worker venv not found: ${config.workerPython}\nRun: cd apps/worker && uv venv --python 3.11 .venv && uv pip install --python .venv/Scripts/python.exe -e ".[dev]"`);
  }
  const pid = spawnService(config, name);
  const healthy = await waitForHealth(config, name);
  if (!healthy) {
    const paths = servicePaths(config, name);
    throw new Error(`${name} did not become healthy. See ${paths.log}\n${readLogTail(paths.log)}`);
  }
  return { started: true, pid };
}

export async function ensureAllServices(config: CliConfig): Promise<void> {
  const orchestrator = await ensureService(config, "orchestrator");
  const worker = await ensureService(config, "worker");
  console.log(`orchestrator: ${orchestrator.started ? "started" : "already running"} (${serviceUrl(config, "orchestrator")})`);
  console.log(`worker:       ${worker.started ? "started" : "already running"} (${serviceUrl(config, "worker")})`);
}

export async function serviceState(config: CliConfig, name: ServiceName): Promise<ServiceState> {
  return { name, healthy: await isHealthy(config, name), pid: readPid(config, name) };
}

export async function stopService(config: CliConfig, name: ServiceName): Promise<{ stopped: boolean; pid: number | null }> {
  const pid = readPid(config, name);
  if (!pid) {
    if (await isHealthy(config, name)) {
      throw new Error(`${name} is running but ${servicePaths(config, name).pid} has no PID`);
    }
    return { stopped: false, pid: null };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(250);
    if (!(await isHealthy(config, name))) {
      const paths = servicePaths(config, name);
      if (existsSync(paths.pid)) unlinkSync(paths.pid);
      return { stopped: true, pid };
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  const paths = servicePaths(config, name);
  if (existsSync(paths.pid)) unlinkSync(paths.pid);
  return { stopped: true, pid };
}

export async function stopAllServices(config: CliConfig): Promise<void> {
  const worker = await stopService(config, "worker");
  const orchestrator = await stopService(config, "orchestrator");
  console.log(`worker:       ${worker.stopped ? `stopped (${worker.pid})` : "not running"}`);
  console.log(`orchestrator: ${orchestrator.stopped ? `stopped (${orchestrator.pid})` : "not running"}`);
}
