import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { CliConfig } from "../config.ts";
import { isProcessAlive } from "../services.ts";

/** PID file owned by the TUI's Job supervisor for its lifetime. */
export function supervisorPidPath(config: CliConfig): string {
  return join(config.home, "supervisor.pid");
}

export function readSupervisorPid(config: CliConfig): number | null {
  const path = supervisorPidPath(config);
  if (!existsSync(path)) return null;
  const value = Number(readFileSync(path, "utf8").trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Force-stop a running TUI-owned stack by terminating its supervisor.
 *
 * The supervisor holds the Job handle, so terminating it closes the Job and
 * KILL_ON_JOB_CLOSE removes the TUI, Worker, daemon, and Orchestrator. This is
 * the escape hatch for `super-rlm down`; normal exits stop children gracefully.
 */
export async function stopSupervisor(config: CliConfig): Promise<{ stopped: boolean; pid: number | null }> {
  const path = supervisorPidPath(config);
  const pid = readSupervisorPid(config);
  if (!pid) {
    if (existsSync(path)) unlinkSync(path);
    return { stopped: false, pid: null };
  }
  const wasAlive = isProcessAlive(pid);
  if (wasAlive) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(250);
      if (!isProcessAlive(pid)) break;
    }
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  if (existsSync(path)) unlinkSync(path);
  return { stopped: wasAlive, pid };
}
