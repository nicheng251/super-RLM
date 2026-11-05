import type { ProfileSummary, TaskListItem, TaskView, TicketActionResult, WorkerView } from "../../../packages/protocol/ts/index.ts";
import { OrchestratorClient } from "../../router/src/client.ts";

export interface TicketSessionView {
  ticket_id: string;
  session_ref: string | null;
  session_dir: string | null;
  session_id: string | null;
  session_file: string | null;
  daemon_socket: string | null;
  status: string;
  running: boolean;
  worker_pid: number | null;
  exists: boolean;
}

export class TicketSessionHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TicketSessionHttpError";
    this.status = status;
  }
}

export interface TuiApiOptions {
  baseUrl: string;
  token: string;
  workerPort: number;
  workerToken: string;
}

/** Thin wrapper over OrchestratorClient plus the endpoints the L3 shell needs. */
export class TuiApi {
  readonly client: OrchestratorClient;
  readonly baseUrl: string;
  readonly token: string;
  readonly workerPort: number;
  readonly workerToken: string;

  constructor(options: TuiApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.workerPort = options.workerPort;
    this.workerToken = options.workerToken;
    this.client = new OrchestratorClient({ baseUrl: this.baseUrl, token: this.token });
  }

  listTasks(limit = 30): Promise<TaskListItem[]> {
    return this.client.listTasks(limit);
  }

  getTask(taskId: string): Promise<TaskView> {
    return this.client.getTask(taskId);
  }

  answer(ticketId: string, message: string): Promise<TicketActionResult> {
    return this.client.answer(ticketId, message);
  }

  resume(ticketId: string, note?: string): Promise<TicketActionResult> {
    return this.client.resume(ticketId, note);
  }

  retry(ticketId: string, note?: string): Promise<TicketActionResult> {
    return this.client.retry(ticketId, note);
  }

  cancelTicket(ticketId: string, reason?: string): Promise<TicketActionResult> {
    return this.client.cancelTicket(ticketId, reason);
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    const response = await fetch(`${this.baseUrl}/v1/profiles`, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`profiles ${response.status}: ${text}`);
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* keep null */ }
    const raw = Array.isArray(parsed) ? parsed : (parsed as { profiles?: unknown } | null)?.profiles;
    return Array.isArray(raw) ? raw as ProfileSummary[] : [];
  }

  async updateProfile(name: string, patch: { provider: string; model: string; thinking: string }): Promise<ProfileSummary> {
    const response = await fetch(`${this.baseUrl}/v1/profiles/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`profile update ${response.status}: ${text}`);
    return JSON.parse(text) as ProfileSummary;
  }

  async listWorkers(): Promise<WorkerView[]> {
    const response = await fetch(`${this.baseUrl}/v1/workers`, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* keep null */ }
    if (!response.ok) throw new Error(`workers ${response.status}: ${text}`);
    const raw = Array.isArray(parsed) ? parsed : (parsed as { workers?: unknown } | null)?.workers;
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeWorker).filter((worker): worker is WorkerView => worker !== null);
  }

  async ticketSession(ticketId: string): Promise<TicketSessionView> {
    const response = await fetch(
      `http://127.0.0.1:${this.workerPort}/v1/tickets/${encodeURIComponent(ticketId)}/session`,
      {
        headers: { authorization: `Bearer ${this.workerToken}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new TicketSessionHttpError(response.status, `ticket session ${response.status}: ${text}`);
    }
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* handled below */ }
    return normalizeTicketSession(parsed, ticketId);
  }

  async health(path: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  orchestratorHealthy(): Promise<boolean> {
    return this.health("/health");
  }

  async workerHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.workerPort}/v1/health`, {
        signal: AbortSignal.timeout(1500),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

function normalizeTicketSession(input: unknown, ticketId: string): TicketSessionView {
  if (!input || typeof input !== "object") {
    throw new Error(`ticket session: invalid payload for ${ticketId}`);
  }
  const raw = input as Record<string, unknown>;
  const str = (value: unknown): string | null => typeof value === "string" ? value : null;
  return {
    ticket_id: typeof raw.ticket_id === "string" ? raw.ticket_id : ticketId,
    session_ref: str(raw.session_ref),
    session_dir: str(raw.session_dir),
    session_id: str(raw.session_id),
    session_file: str(raw.session_file),
    daemon_socket: str(raw.daemon_socket),
    status: typeof raw.status === "string" ? raw.status : "unknown",
    running: raw.running === true,
    worker_pid: typeof raw.worker_pid === "number" ? raw.worker_pid : null,
    exists: raw.exists === true,
  };
}

function normalizeWorker(input: unknown): WorkerView | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.worker_id !== "string") return null;
  const status = raw.status === "healthy" || raw.status === "draining" || raw.status === "lost"
    ? raw.status
    : "lost";
  return {
    worker_id: raw.worker_id,
    url: typeof raw.url === "string" ? raw.url : "",
    status,
    running: Number(raw.running ?? 0),
    max_concurrency: Number(raw.max_concurrency ?? 0),
    last_heartbeat: typeof raw.last_heartbeat === "string" ? raw.last_heartbeat : "",
    version: typeof raw.version === "string" ? raw.version : null,
  };
}
