import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig, redactConfig } from "./config.ts";
import { daemonState, runningDaemons, shutdownProjectDaemon } from "./daemon.ts";
import { runArtifacts } from "./commands/artifacts.ts";
import { runBackup, runRestore } from "./commands/backup.ts";
import { runBootstrap } from "./commands/bootstrap.ts";
import { runDoctor } from "./commands/doctor.ts";
import { parseGcArgs, runGc } from "./commands/gc.ts";
import { runInit } from "./commands/init.ts";
import { syncModels } from "./commands/models.ts";
import { runProfiles } from "./commands/profiles.ts";
import { runSetup } from "./commands/setup.ts";
import { runTasks } from "./commands/tasks.ts";
import { runTui } from "./commands/tui.ts";
import { describeLogRotation, rotateServiceLogs } from "./maintenance.ts";
import { isProcessAlive, serviceState, serviceUrl, stopAllServices } from "./services.ts";
import { readSupervisorPid, stopSupervisor } from "./supervisor/pid.ts";

const RETIRED_COMMANDS = new Set(["up", "router", "dev"]);

export interface ParsedCommand {
  command: string;
  rest: string[];
  retired?: string;
  name?: string;
}

/** Parse the top-level command. No arguments start the TUI stack. */
export function parseCommand(argv: string[]): ParsedCommand {
  if (argv.length === 0) return { command: "tui", rest: [] };
  const [first, ...rest] = argv;
  if (first === "help" || first === "--help" || first === "-h") return { command: "help", rest };
  if (first === "version" || first === "--version" || first === "-v") return { command: "version", rest };
  if (RETIRED_COMMANDS.has(first) || first === "--no-services") {
    return { command: "retired", rest, retired: first };
  }
  if (first.startsWith("-")) return { command: "unknown", rest, name: first };
  return { command: first, rest };
}

function help(): void {
  console.log(`super-rlm 0.1.0

Usage:
  super-rlm                     Start the L3 terminal UI and its whole local stack
  super-rlm tui                 Alias for super-rlm
  super-rlm down                Stop the stack and the project Prime Agent daemon
  super-rlm status              Show Orchestrator, Worker, and daemon status
  super-rlm artifacts <ticket_id> [--to <destination-dir>] [--all]
                                 Copy Ticket artifacts (or the whole workspace)
  super-rlm backup <destination-dir> [--include-secrets]
                                 Offline backup of the project runtime
  super-rlm restore <backup-dir>
                                 Restore an offline backup
  super-rlm tasks [--json] [--limit <n>]
  super-rlm gc [--apply] [--older-than <days>] [--tmp] [--sessions]
               [--workspaces] [--worktrees] [--all]
                                 Delete artifacts of finished Tickets (dry run by default)
  super-rlm doctor [--json]
  super-rlm setup [--provider <name>] [--model <id>] [--allow-missing-key]
                                 Prepare this project for first use (never starts the TUI)
  super-rlm init                 Create .super-rlm-project.json
  super-rlm bootstrap [--dry-run]  Prepare the project kernel venv and report skill
  super-rlm models sync [--dry-run]  Write project Pi/Prime models.json from config/models.yaml
  super-rlm profiles list        List Worker profiles from config/profiles.yaml
  super-rlm profiles show <name> Show one Worker profile
  super-rlm profiles validate    Validate config/profiles.yaml
  super-rlm profiles reset <name>|--all
                                 Remove saved model overrides so config/profiles.yaml applies
  super-rlm config               Print resolved configuration

The TUI owns the Orchestrator, Worker, and Prime Agent daemon for its lifetime.
Background and standalone Router commands were removed. If a stack is already
running, use \`super-rlm down\` before starting again.

\`super-rlm gc\` is a dry run unless --apply is passed. It refuses while the
stack is running, and deletes only resources whose Ticket and Task are terminal
in the Orchestrator database. The default scope is --tmp --sessions
--workspaces (older than 7 days); --worktrees is opt-in and skips dirty
worktrees. --all selects every scope.

Starting the TUI rotates the closed Orchestrator/Worker logs above
SUPER_RLM_LOG_MAX_BYTES (default 10 MiB, keeping SUPER_RLM_LOG_KEEP=3) and runs
an applied GC for resources older than SUPER_RLM_GC_OLDER_THAN_DAYS=7. Set
SUPER_RLM_AUTO_MAINTENANCE=0 to skip that startup GC.

Node is a host prerequisite (>= 22.19). The project owns Pi and Prime Agent.`);
}

function formatDaemonLine(
  state: Awaited<ReturnType<typeof daemonState>>,
): string {
  if (!state.available) return "unavailable (prime-agent not found)";
  if (state.error) return `unknown (${state.error})`;
  const running = runningDaemons(state.entries);
  if (running.length === 0) return "down pid=-";
  return `running pid=${running.map((entry) => entry.pid).join(",")}`;
}

async function status(): Promise<number> {
  const config = loadConfig();
  const [orchestrator, worker, daemon] = await Promise.all([
    serviceState(config, "orchestrator"),
    serviceState(config, "worker"),
    daemonState(config),
  ]);
  for (const state of [orchestrator, worker]) {
    const health = state.healthy ? "healthy" : "down";
    console.log(`${state.name.padEnd(13)} ${health.padEnd(7)} pid=${state.pid ?? "-"} ${serviceUrl(config, state.name)}`);
  }
  const supervisorPid = readSupervisorPid(config);
  const supervisor = supervisorPid !== null && isProcessAlive(supervisorPid) ? `running pid=${supervisorPid}` : "down pid=-";
  console.log(`supervisor    ${supervisor}`);
  console.log(`daemon        ${formatDaemonLine(daemon)}`);
  return 0;
}

async function down(): Promise<number> {
  const config = loadConfig();
  const supervisor = await stopSupervisor(config);
  console.log(`supervisor:   ${supervisor.stopped ? `stopped (${supervisor.pid})` : "not running"}`);
  await stopAllServices(config);
  for (const rotated of rotateServiceLogs(config)) {
    if (rotated.rotated) {
      console.log(`logs:         rotated ${describeLogRotation(rotated)}`);
    } else if (rotated.error) {
      console.error(`logs:         could not rotate ${rotated.name ?? rotated.path}: ${rotated.error}`);
    }
  }
  const daemon = await shutdownProjectDaemon(config);
  if (daemon.ran) {
    console.log("daemon:       stopped");
    return 0;
  }
  if (daemon.error) {
    console.error(`daemon:       not stopped (${daemon.error})`);
    return 1;
  }
  console.log("daemon:       not running");
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseCommand(argv);

  if (parsed.command === "help") {
    help();
    return 0;
  }
  if (parsed.command === "version") {
    console.log("0.1.0");
    return 0;
  }
  if (parsed.command === "retired") {
    console.error(`super-rlm: '${parsed.retired}' is no longer supported. Start the TUI with \`super-rlm\`; use \`super-rlm status\` or \`super-rlm down\` for diagnostics.`);
    return 1;
  }
  if (parsed.command === "tui") {
    return runTui(loadConfig());
  }
  if (parsed.command === "status") return status();
  if (parsed.command === "down") return down();

  const rest = parsed.rest;
  if (parsed.command === "setup") return runSetup(rest);
  if (parsed.command === "init") return runInit();
  if (parsed.command === "bootstrap") {
    return runBootstrap(loadConfig(), { dryRun: rest.includes("--dry-run") });
  }
  if (parsed.command === "models" && rest[0] === "sync") {
    return syncModels(loadConfig(), { dryRun: rest.includes("--dry-run") });
  }
  if (parsed.command === "profiles") {
    return runProfiles(loadConfig(), rest);
  }
  if (parsed.command === "artifacts") {
    let ticketId: string | undefined;
    let to: string | undefined;
    let all = false;
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index];
      if (arg === "--all") {
        all = true;
      } else if (arg === "--to") {
        to = rest[++index];
      } else if (arg.startsWith("--to=")) {
        to = arg.slice("--to=".length);
      } else if (!arg.startsWith("-")) {
        ticketId = arg;
      }
    }
    return runArtifacts(loadConfig(), ticketId, { to, all });
  }
  if (parsed.command === "backup") {
    const includeSecrets = rest.includes("--include-secrets");
    const destination = rest.find((arg) => arg !== "--include-secrets" && !arg.startsWith("-"));
    if (!destination) {
      console.error("Usage: super-rlm backup <destination-dir> [--include-secrets]");
      return 1;
    }
    return runBackup(loadConfig(), destination, { includeSecrets });
  }
  if (parsed.command === "restore") {
    const backupDir = rest.find((arg) => !arg.startsWith("-"));
    if (!backupDir) {
      console.error("Usage: super-rlm restore <backup-dir>");
      return 1;
    }
    return runRestore(loadConfig(), backupDir);
  }
  if (parsed.command === "config") {
    console.log(JSON.stringify(redactConfig(loadConfig()), null, 2));
    return 0;
  }
  if (parsed.command === "tasks") {
    const json = rest.includes("--json");
    const limitIndex = rest.indexOf("--limit");
    const limit = limitIndex >= 0 && rest[limitIndex + 1] ? Number(rest[limitIndex + 1]) : undefined;
    return runTasks(loadConfig(), { json, limit });
  }
  if (parsed.command === "doctor") {
    return runDoctor(loadConfig(), { json: rest.includes("--json") });
  }
  if (parsed.command === "gc") {
    const parsedGc = parseGcArgs(rest);
    if ("error" in parsedGc) {
      console.error(`super-rlm gc: ${parsedGc.error}`);
      return 1;
    }
    return runGc(loadConfig(), parsedGc.options);
  }

  console.error(`Unknown command: ${parsed.name ?? parsed.command}`);
  help();
  return 1;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
