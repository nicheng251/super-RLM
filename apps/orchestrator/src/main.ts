
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { acquireLock, type LockHandle } from "./lock.ts";
import { Orchestrator } from "./orchestrator.ts";
import { createOrchestratorServer, serverAddress } from "./server.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(dirname(config.dbPath), { recursive: true });
  mkdirSync(config.workspaceRoot, { recursive: true });

  let lock: LockHandle;
  try {
    lock = acquireLock(dirname(config.dbPath));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const store = new Store(config.dbPath);
  const orchestrator = new Orchestrator(store, {
    maxConcurrentTickets: config.maxConcurrentTickets,
    maxConcurrentTicketsPerTask: config.maxConcurrentTicketsPerTask,
    priorityReserved: config.priorityReserved,
    workerLeaseMs: config.workerLeaseMs,
    dispatchTimeoutMs: 10_000,
    workspaceRoot: config.workspaceRoot,
  });
  orchestrator.recover();
  await orchestrator.schedule();

  const server = createOrchestratorServer(orchestrator, {
    routerToken: config.routerToken,
    workerToken: config.workerToken,
  });

  server.listen(config.port, config.host, () => {
    const address = serverAddress(server);
    console.log(JSON.stringify({
      event: "orchestrator.started",
      host: address.address,
      port: address.port,
      db: config.dbPath,
      workspaces: config.workspaceRoot,
    }));
  });

  function shutdown(signal: string): void {
    console.log(JSON.stringify({ event: "orchestrator.stopping", signal }));
    server.close(() => {
      store.close();
      lock.release();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

await main();
