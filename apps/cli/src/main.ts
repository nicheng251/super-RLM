
import { loadConfig, type RouterOptions } from "./config.ts";
import { runDev } from "./commands/dev.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runInit } from "./commands/init.ts";
import { runRouter } from "./commands/router.ts";
import { runTasks } from "./commands/tasks.ts";

function help(): void {
  console.log(`super-rlm 0.1.0

Usage:
  super-rlm [router] [--new] [--session <id>] [--project-id <id>] [--home <dir>] [pi args...]
  super-rlm dev                  Start Orchestrator and Worker
  super-rlm tasks [--json] [--limit <n>]
  super-rlm doctor [--json]
  super-rlm init                 Create .super-rlm-project.json
  super-rlm config               Print resolved configuration

Node is a host prerequisite (>= 22.19). The project owns Pi and Prime Agent.`);
}

function parseRouterArgs(args: string[]): RouterOptions & { projectId?: string; home?: string } {
  const extraArgs: string[] = [];
  let newSession = false;
  let sessionId: string | undefined;
  let projectId: string | undefined;
  let home: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--new") {
      newSession = true;
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
  return { newSession, sessionId, projectId, home, extraArgs };
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

  if (command === "router") {
    const parsed = parseRouterArgs(rest);
    const config = loadConfig({ projectId: parsed.projectId, home: parsed.home });
    return runRouter(config, parsed);
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
