
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  dbPath: string;
  workspaceRoot: string;
  profileOverridesPath: string;
  routerToken: string;
  workerToken: string;
  callbackUrl: string | null;
  callbackKey: string;
  projectRepo: string | null;
  maxConcurrentTickets: number;
  maxConcurrentTicketsPerTask: number;
  priorityReserved: number;
  workerLeaseMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const home = env.SUPER_RLM_HOME ?? join(homedir(), ".super-rlm", "projects", "default");
  return {
    host: env.SUPER_RLM_HOST ?? "127.0.0.1",
    port: Number(env.SUPER_RLM_PORT ?? "8787"),
    dbPath: env.SUPER_RLM_DB ?? join(home, "orchestrator", "orchestrator.sqlite"),
    workspaceRoot: env.SUPER_RLM_WORKSPACES ?? join(home, "workspaces"),
    profileOverridesPath: env.SUPER_RLM_PROFILE_OVERRIDES ?? join(home, "profiles.overrides.json"),
    routerToken: env.SUPER_RLM_ROUTER_TOKEN ?? "dev-router-token",
    workerToken: env.SUPER_RLM_WORKER_TOKEN ?? "dev-worker-token",
    callbackUrl: env.SUPER_RLM_CALLBACK_URL?.trim() || null,
    callbackKey: env.SUPER_RLM_CALLBACK_KEY ?? "dev-callback-key",
    projectRepo: env.SUPER_RLM_PROJECT_REPO?.trim() || null,
    maxConcurrentTickets: Number(env.SUPER_RLM_MAX_CONCURRENT_TICKETS ?? "4"),
    maxConcurrentTicketsPerTask: Number(env.SUPER_RLM_MAX_CONCURRENT_TICKETS_PER_TASK ?? "2"),
    priorityReserved: Number(env.SUPER_RLM_PRIORITY_RESERVED ?? "1"),
    workerLeaseMs: Number(env.SUPER_RLM_WORKER_LEASE_MS ?? "30000"),
  };
}
