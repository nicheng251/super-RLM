
import { loadConfig, type RouterOptions } from "./config.ts";
import { runBootstrap } from "./commands/bootstrap.ts";
import { runDev } from "./commands/dev.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runInit } from "./commands/init.ts";
import { syncModels } from "./commands/models.ts";
import { runRouter } from "./commands/router.ts";
import { runTasks } from "./commands/tasks.ts";
import { ensureAllServices, serviceState, stopAllServices } from "./services.ts";

function help(): void {
  console.log(`super-rlm 0.1.0

Usage:
  super-rlm [router] [--new] [--session <id>] [--no-services] [pi args...]
                                 Ensure Orchestrator/Worker, then launch Router
  super-rlm up                   Start Orchestrator and Worker in the background
  super-rlm down                 Stop background Orchestrator and Worker
  super-rlm status               Show background service health and PIDs
  super-rlm dev                  Start Orchestrator and Worker in the foreground
  super-rlm tasks [--json] [--limit <n>]
  super-rlm doctor [--json]
  super-rlm init                 Create .super-rlm-project.json
  super-rlm bootstrap [--dry-run]  Prepare the project kernel venv and report skill
  super-rlm models sync [--dry-run]  Write project Pi/Prime models.json from config/models.yaml
  super-rlm config               Print resolved configuration

Node is a host prerequisite (>= 22.19). The project owns Pi and Prime Agent.`);
}

function parseRouterArgs(args: string[]): RouterOptions & { projectId?: string; home?: string; noServices?: boolean } {
  const extraArgs: string[] = [];
  let newSession = false;
  let noServices = false;
  let sessionId: string | undefined;
  let projectId: string | undefined;
  let home: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--new") {
      newSession = true;
    } else if (arg === "--no-services") {
      noServices = true;
    } else if (arg === "--session" && args[index + 1]) {
      sessionId = args[++index];
    } else if (arg === "--project-id" && args[index + 1]) {
      projectId = args[++index];
    } else if (arg === "--home" && args[index + 1]) {
      home = args[++index];
    } else {
      extraArgs.push(arg);
    }
  }
  return { newSession, sessionId, projectId, home, noServices, extraArgs };
}

function serviceUrlForStatus(config: ReturnType<typeof loadConfig>, name: "orchestrator" | "worker"): string {
  return name === "orchestrator"
    ? `${config.orchestratorUrl}/health`
    : `http://127.0.0.1:${config.workerPort}/v1/health`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "router";
  const rest = command === "router" && argv[0] === command ? argv.slice(1) : argv;

  if (command === "help" || command === "--help" || command === "-h") {
    help();
    return 0;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    console.log("0.1.0");
    return 0;
  }
  if (command === "init") return runInit();
  if (command === "bootstrap") return runBootstrap(loadConfig(), { dryRun: rest.includes("--dry-run") });
  if (command === "models" && rest[1] === "sync") {
    return syncModels(loadConfig(), { dryRun: rest.includes("--dry-run") });
  }

  if (command === "router") {
    const parsed = parseRouterArgs(rest);
    const config = loadConfig({ projectId: parsed.projectId, home: parsed.home });
    if (!parsed.noServices) await ensureAllServices(config);
    return runRouter(config, parsed);
  }

  if (command === "up") {
    await ensureAllServices(loadConfig());
    return 0;
  }
  if (command === "down") {
    await stopAllServices(loadConfig());
    return 0;
  }
  if (command === "status") {
    const config = loadConfig();
    const states = await Promise.all([
      serviceState(config, "orchestrator"),
      serviceState(config, "worker"),
    ]);
    for (const state of states) {
      console.log(`${state.name.padEnd(13)} ${state.healthy ? "healthy" : "down"} pid=${state.pid ?? "-"} ${serviceUrlForStatus(config, state.name)}`);
    }
    return 0;
  }

  if (command === "dev") return runDev(loadConfig());
  if (command === "config") {
    console.log(JSON.stringify(loadConfig(), null, 2));
    return 0;
  }
  if (command === "tasks") {
    const json = rest.includes("--json");
    const limitIndex = rest.indexOf("--limit");
    const limit = limitIndex >= 0 && rest[limitIndex + 1] ? Number(rest[limitIndex + 1]) : undefined;
    return runTasks(loadConfig(), { json, limit });
  }
  if (command === "doctor") {
    return runDoctor(loadConfig(), { json: rest.includes("--json") });
  }

  console.error(`Unknown command: ${command}`);
  help();
  return 1;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
