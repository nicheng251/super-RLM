import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { CliConfig } from "./config.ts";

export interface DaemonEntry {
  pid: number;
  status: string;
  socketPath: string | null;
  sessionCount: number | null;
}

export interface DaemonState {
  available: boolean;
  running: boolean;
  entries: DaemonEntry[];
  error?: string;
}

const NON_RUNNING_STATUSES = new Set(["unreachable", "stale", "stopped", "dead", "offline"]);

/**
 * Environment for project-scoped Prime Agent admin commands.
 *
 * Admin commands (`status`, `shutdown`) do not accept `--daemon-socket`; they
 * read `PRIME_AGENT_DAEMON_SOCKET`. Inherited `PI_*` / `PRIME_AGENT_*` / `RLM_*`
 * settings are stripped so the user's normal daemon is never touched.
 */
export function primeAgentOverrides(config: CliConfig): Record<string, string> {
  const sessions = process.env.SUPER_RLM_PRIME_SESSIONS ?? join(config.home, "prime", "sessions");
  return {
    PRIME_AGENT_CODING_AGENT_DIR: join(config.home, "prime", "agent"),
    PRIME_AGENT_CODING_AGENT_SESSION_DIR: sessions,
    PRIME_AGENT_SESSION_DIR: sessions,
    PRIME_AGENT_DAEMON_SOCKET: config.primeDaemonSocket,
    PRIME_AGENT_KERNEL_VENV: config.kernelVenv,
    PRIME_AGENT_KERNEL_PYTHON: config.kernelPython,
    PRIME_AGENT_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
  };
}

export function primeAgentEnv(config: CliConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PI_|PRIME_AGENT_|RLM_)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, primeAgentOverrides(config));
  return env;
}

/** Parse `prime-agent status --json`; tolerate leading log lines. */
export function parseDaemonStatus(text: string): DaemonEntry[] {
  const stripped = text.trim();
  if (!stripped) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const starts = [stripped.indexOf("["), stripped.indexOf("{")].filter((index) => index >= 0);
    if (starts.length === 0) throw new Error(`prime-agent status returned non-JSON output: ${stripped.slice(-300)}`);
    parsed = JSON.parse(stripped.slice(Math.min(...starts)));
  }
  let rows: unknown[];
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (parsed && typeof parsed === "object") {
    const object = parsed as Record<string, unknown>;
    const list = object.daemons ?? object.services ?? object.statuses;
    rows = Array.isArray(list) ? list : [parsed];
  } else {
    throw new Error("prime-agent status returned an unexpected JSON value");
  }
  return rows.flatMap((row): DaemonEntry[] => {
    if (!row || typeof row !== "object") return [];
    const entry = row as Record<string, unknown>;
    const pid = Number(entry.pid);
    if (!Number.isFinite(pid) || pid <= 0) return [];
    return [{
      pid,
      status: typeof entry.status === "string" ? entry.status.toLowerCase() : "unknown",
      socketPath: typeof entry.socketPath === "string" ? entry.socketPath : null,
      sessionCount: Number.isFinite(Number(entry.sessionCount)) ? Number(entry.sessionCount) : null,
    }];
  });
}

export function runningDaemons(entries: DaemonEntry[]): DaemonEntry[] {
  return entries.filter((entry) => entry.pid > 0 && !NON_RUNNING_STATUSES.has(entry.status));
}

interface CommandOutput {
  stdout: string;
  stderr: string;
}

export async function runPrimeAgent(
  config: CliConfig,
  args: string[],
  timeoutMs = 30_000,
): Promise<CommandOutput> {
  return await new Promise<CommandOutput>((resolve, reject) => {
    execFile(
      config.primeAgent,
      args,
      {
        env: primeAgentEnv(config),
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const enriched = error as Error & { stdout?: string; stderr?: string };
          enriched.stdout = String(stdout ?? "");
          enriched.stderr = String(stderr ?? "");
          reject(enriched);
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

export async function daemonState(config: CliConfig): Promise<DaemonState> {
  if (!existsSync(config.primeAgent)) {
    return { available: false, running: false, entries: [] };
  }
  try {
    const result = await runPrimeAgent(config, ["status", "--json"], 15_000);
    const entries = parseDaemonStatus(result.stdout || result.stderr);
    return { available: true, running: runningDaemons(entries).length > 0, entries };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { available: true, running: false, entries: [], error: detail };
  }
}

export async function shutdownProjectDaemon(
  config: CliConfig,
): Promise<{ ran: boolean; error?: string }> {
  if (!existsSync(config.primeAgent)) {
    return { ran: false, error: `prime-agent not found: ${config.primeAgent}` };
  }
  try {
    const result = await runPrimeAgent(config, ["shutdown", "--force", "--json"], 30_000);
    const output = result.stdout.trim() || result.stderr.trim();
    if (output) {
      const parsed = JSON.parse(output) as { failed?: unknown };
      if (Array.isArray(parsed.failed) && parsed.failed.length > 0) {
        return { ran: true, error: `prime-agent shutdown reported failures: ${JSON.stringify(parsed.failed)}` };
      }
    }
    return { ran: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ran: false, error: detail };
  }
}
