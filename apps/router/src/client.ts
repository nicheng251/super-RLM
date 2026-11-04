
import type {
  TaskListItem,
  TaskView,
  TicketActionResult,
  TicketResult,
  TaskCancelResponse,
} from "../../../packages/protocol/ts/index.ts";

export interface OrchestratorClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export class OrchestratorClient {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs: number;

  constructor(options: OrchestratorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    if (!response.ok) {
      const message = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      throw new Error(`Orchestrator ${response.status}: ${message}`);
    }
    return parsed as T;
  }

  async listTasks(limit = 20): Promise<TaskListItem[]> {
    const response = await this.call<{ tasks: TaskListItem[] }>("GET", `/v1/tasks?limit=${limit}`);
    return response.tasks;
  }

  async getTask(taskId: string): Promise<TaskView> {
    return this.call<TaskView>("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  async getTicketResult(ticketId: string, maxChars = 20_000): Promise<TicketResult> {
    return this.call<TicketResult>("GET", `/v1/tickets/${encodeURIComponent(ticketId)}/result?max_chars=${maxChars}`);
  }

  async answer(ticketId: string, message: string): Promise<TicketActionResult> {
    return this.call<TicketActionResult>("POST", `/v1/tickets/${encodeURIComponent(ticketId)}/answer`, { message });
  }

  async resume(ticketId: string, note?: string): Promise<TicketActionResult> {
    return this.call<TicketActionResult>("POST", `/v1/tickets/${encodeURIComponent(ticketId)}/resume`, { note: note ?? null });
  }

  async retry(ticketId: string, note?: string): Promise<TicketActionResult> {
    return this.call<TicketActionResult>("POST", `/v1/tickets/${encodeURIComponent(ticketId)}/retry`, { note: note ?? null });
  }

  async cancelTicket(ticketId: string, reason?: string): Promise<TicketActionResult> {
    return this.call<TicketActionResult>("POST", `/v1/tickets/${encodeURIComponent(ticketId)}/cancel`, { reason: reason ?? null });
  }

  async cancelTask(taskId: string, reason?: string): Promise<TaskCancelResponse> {
    return this.call<TaskCancelResponse>("POST", `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { reason: reason ?? null });
  }
}
