
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { acquireLock, type LockHandle } from "./lock.ts";
import { Orchestrator } from "./orchestrator.ts";
import { loadProfiles, profileSummaries, updateProfile, type ProfilesConfig } from "./profiles.ts";
import { createOrchestratorServer, serverAddress } from "./server.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  let profiles: ProfilesConfig;
  try {
    profiles = loadProfiles();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  applyProfileOverrides(profiles, config.profileOverridesPath);
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
    projectRepo: config.projectRepo,
    callbackUrl: config.callbackUrl,
    callbackKey: config.callbackKey,
    profiles,
  });
  orchestrator.recover();
  await orchestrator.schedule();

  if (config.callbackUrl) {
    await orchestrator.flushOutbox();
    setInterval(() => {
      void orchestrator.flushOutbox().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
      });
    }, 1000).unref();
  }

  const profileList = profileSummaries(profiles);
  const server = createOrchestratorServer(orchestrator, {
    routerToken: config.routerToken,
    workerToken: config.workerToken,
    callbackKey: config.callbackKey,
    profiles: profileList,
    updateProfile: (name, patch) => {
      const updated = updateProfile(profiles, name, patch);
      const index = profileList.findIndex((profile) => profile.name === name);
      if (index >= 0) profileList[index] = updated;
      saveProfileOverride(config.profileOverridesPath, updated);
      return updated;
    },
  });

  server.listen(config.port, config.host, () => {
    const address = serverAddress(server);
    console.log(JSON.stringify({
      event: "orchestrator.started",
      host: address.address,
      port: address.port,
      db: config.dbPath,
      workspaces: config.workspaceRoot,
      profiles: profileSummaries(profiles).map((profile) => profile.name),
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

function applyProfileOverrides(profiles: ProfilesConfig, path: string): void {
  if (!existsSync(path)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`ignoring unreadable profile overrides ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  for (const [name, patch] of Object.entries(parsed as Record<string, unknown>)) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) continue;
    try {
      updateProfile(profiles, name, patch as Record<string, unknown>);
    } catch (error) {
      console.error(`ignoring invalid override for profile ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function saveProfileOverride(path: string, profile: ReturnType<typeof updateProfile>): void {
  let overrides: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) overrides = parsed as Record<string, unknown>;
    } catch {
      // A broken override file is replaced by the next successfully saved update.
    }
  }
  overrides[profile.name] = {
    provider: profile.provider,
    model: profile.model,
    thinking: profile.thinking,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(overrides, null, 2)}\n`, "utf8");
}

await main();
