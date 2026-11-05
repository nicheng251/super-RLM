
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
  callbackAllowPrivate: boolean;
  projectRepo: string | null;
  maxConcurrentTickets: number;
  maxConcurrentTicketsPerTask: number;
  priorityReserved: number;
  workerLeaseMs: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

/**
 * Accept only a loopback listen address. "localhost" is normalized so the
 * bound address is deterministic. Anything else (0.0.0.0, ::, LAN addresses,
 * hostnames) would expose the unauthenticated-by-network control plane.
 */
export function validateLoopbackHost(value: string): string {
  const host = value.trim().toLowerCase();
  if (!host) throw new Error("SUPER_RLM_HOST must be 127.0.0.1 or ::1");
  if (host === "localhost") return "127.0.0.1";
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!LOOPBACK_HOSTS.has(bare)) {
    throw new Error(`SUPER_RLM_HOST must be 127.0.0.1 or ::1, got ${JSON.stringify(value)}`);
  }
  return bare;
}

/**
 * Read a required API secret. Direct service startup must fail closed: an
 * absent or blank value is a deployment error, never a built-in default.
 */
export function requiredSecret(env: NodeJS.ProcessEnv, name: string, home: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required. Run \`super-rlm\` to generate local secrets, or add ${name} to ${join(home, "secrets", "api.env")}.`,
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const home = env.SUPER_RLM_HOME ?? join(homedir(), ".super-rlm", "projects", "default");
  return {
    host: validateLoopbackHost(env.SUPER_RLM_HOST ?? "127.0.0.1"),
    port: Number(env.SUPER_RLM_PORT ?? "8787"),
    dbPath: env.SUPER_RLM_DB ?? join(home, "orchestrator", "orchestrator.sqlite"),
    workspaceRoot: env.SUPER_RLM_WORKSPACES ?? join(home, "workspaces"),
    profileOverridesPath: env.SUPER_RLM_PROFILE_OVERRIDES ?? join(home, "profiles.overrides.json"),
    routerToken: requiredSecret(env, "SUPER_RLM_ROUTER_TOKEN", home),
    workerToken: requiredSecret(env, "SUPER_RLM_WORKER_TOKEN", home),
    callbackUrl: env.SUPER_RLM_CALLBACK_URL?.trim() || null,
    callbackKey: requiredSecret(env, "SUPER_RLM_CALLBACK_KEY", home),
    callbackAllowPrivate: env.SUPER_RLM_CALLBACK_ALLOW_PRIVATE === "1",
    projectRepo: env.SUPER_RLM_PROJECT_REPO?.trim() || null,
    maxConcurrentTickets: Number(env.SUPER_RLM_MAX_CONCURRENT_TICKETS ?? "4"),
    maxConcurrentTicketsPerTask: Number(env.SUPER_RLM_MAX_CONCURRENT_TICKETS_PER_TASK ?? "2"),
    priorityReserved: Number(env.SUPER_RLM_PRIORITY_RESERVED ?? "1"),
    workerLeaseMs: Number(env.SUPER_RLM_WORKER_LEASE_MS ?? "30000"),
  };
}
