import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { CliConfig } from "./config.ts";

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
    ? `${config.orchestratorUrl.replace(/\/$/, "")}/health`
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

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
    if (!isProcessAlive(pid)) {
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
