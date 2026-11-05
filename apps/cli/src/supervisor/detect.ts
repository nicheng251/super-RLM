import { daemonState, runningDaemons, type DaemonEntry } from "../daemon.ts";
import type { CliConfig } from "../config.ts";
import { isProcessAlive, serviceState, type ServiceState } from "../services.ts";
import { readSupervisorPid } from "./pid.ts";

export interface ServiceSnapshot extends ServiceState {
  alive: boolean;
}

export interface RunningStack {
  orchestrator: ServiceSnapshot;
  worker: ServiceSnapshot;
  daemons: DaemonEntry[];
  supervisorPid?: number | null;
  daemonError?: string;
}

async function snapshot(config: CliConfig, name: "orchestrator" | "worker"): Promise<ServiceSnapshot> {
  const state = await serviceState(config, name);
  return { ...state, alive: state.pid !== null && isProcessAlive(state.pid) };
}

export async function detectRunningStack(config: CliConfig): Promise<RunningStack> {
  const [orchestrator, worker, daemon] = await Promise.all([
    snapshot(config, "orchestrator"),
    snapshot(config, "worker"),
    daemonState(config),
  ]);
  const supervisorPid = readSupervisorPid(config);
  const stack: RunningStack = {
    orchestrator,
    worker,
    daemons: runningDaemons(daemon.entries),
    supervisorPid: supervisorPid !== null && isProcessAlive(supervisorPid) ? supervisorPid : null,
  };
  if (daemon.error) stack.daemonError = daemon.error;
  return stack;
}

export function hasRunningStack(stack: RunningStack): boolean {
  return Boolean(
    stack.orchestrator.healthy
    || stack.orchestrator.alive
    || stack.worker.healthy
    || stack.worker.alive
    || stack.daemons.length > 0
    || Boolean(stack.supervisorPid)
    || stack.daemonError,
  );
}

export function describeRunningStack(stack: RunningStack): string[] {
  const lines: string[] = [];
  if (stack.orchestrator.healthy || stack.orchestrator.alive) {
    lines.push(stack.orchestrator.pid ? `orchestrator (pid ${stack.orchestrator.pid})` : "orchestrator (health endpoint)");
  }
  if (stack.worker.healthy || stack.worker.alive) {
    lines.push(stack.worker.pid ? `worker (pid ${stack.worker.pid})` : "worker (health endpoint)");
  }
  for (const daemon of stack.daemons) {
    lines.push(`Prime Agent daemon (pid ${daemon.pid})`);
  }
  if (stack.supervisorPid) {
    lines.push(`TUI supervisor (pid ${stack.supervisorPid})`);
  }
  if (stack.daemonError) lines.push(`Prime Agent daemon status is unavailable: ${stack.daemonError}`);
  return lines;
}

export function describeDaemonStatus(stack: RunningStack): string {
  if (stack.daemonError) return `unknown (${stack.daemonError})`;
  if (stack.daemons.length === 0) return "down";
  return stack.daemons.map((daemon) => `running pid=${daemon.pid}`).join(", ");
}
