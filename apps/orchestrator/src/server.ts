
/**
 * Minimal HTTP surface for the Orchestrator.
 *
 * Router and Worker routes are separated by path and bearer token. The server
 * stays dependency-free so the vertical slice can run on Node alone.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import type { WorkerHeartbeat, WorkerRegistration, WorkerReport } from "../../../packages/protocol/ts/index.ts";
import { Orchestrator, OrchestratorError } from "./orchestrator.ts";

export interface ServerOptions {
  routerToken: string;
  workerToken: string;
  profiles?: Array<{ name: string; description: string; model: string; thinking: string }>;
  bodyLimitBytes?: number;
}

const NOT_FOUND = { error: { code: "not_found", message: "route not found" } };

export function createOrchestratorServer(orchestrator: Orchestrator, options: ServerOptions): Server {
  const profiles = options.profiles ?? [
    { name: "default", description: "General-purpose worker", model: "default", thinking: "medium" },
  ];
  const bodyLimit = options.bodyLimitBytes ?? 1_000_000;

  return createServer(async (req, res) => {
    try {
      await route(req, res, orchestrator, options, profiles, bodyLimit);
    } catch (error) {
      sendError(res, error);
    }
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  orchestrator: Orchestrator,
  options: ServerOptions,
  profiles: NonNullable<ServerOptions["profiles"]>,
  bodyLimit: number,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const segments = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  if (segments[0] === "internal") {
    if (!authorized(req, options.workerToken)) return sendJson(res, 401, unauthorized());
    return routeWorker(req, res, url, segments, orchestrator, bodyLimit);
  }

  if (segments[0] === "v1") {
    if (!authorized(req, options.routerToken)) return sendJson(res, 401, unauthorized());
    return routeRouter(req, res, url, segments, orchestrator, profiles, bodyLimit);
  }

  return sendJson(res, 404, NOT_FOUND);
}

async function routeRouter(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  segments: string[],
  orchestrator: Orchestrator,
  profiles: NonNullable<ServerOptions["profiles"]>,
  bodyLimit: number,
): Promise<void> {
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/v1/profiles") {
    return sendJson(res, 200, { profiles });
  }

  if (method === "POST" && url.pathname === "/v1/tasks") {
    const body = await readJson(req, bodyLimit) as Record<string, unknown>;
    const created = await orchestrator.createTask(body as never);
    return sendJson(res, 201, created);
  }

  if (method === "GET" && url.pathname === "/v1/tasks") {
    const status = url.searchParams.get("status") ?? undefined;
    const limit = url.searchParams.get("limit");
    return sendJson(res, 200, {
      tasks: orchestrator.listTasks({ status, limit: limit ? Number(limit) : undefined }),
      next_cursor: null,
    });
  }

  if (segments[1] === "tasks" && segments[2] && segments.length === 3) {
    if (method === "GET") return sendJson(res, 200, orchestrator.getTask(segments[2]));
  }

  if (segments[1] === "tasks" && segments[2] && segments[3] === "wait" && method === "GET") {
    const timeout = Number(url.searchParams.get("timeout_s") ?? "120");
    return sendJson(res, 200, await orchestrator.waitForTask(segments[2], Number.isFinite(timeout) ? timeout : 120));
  }

  if (method === "GET" && url.pathname === "/v1/events") {
    return streamEvents(req, res, orchestrator, undefined, Number(url.searchParams.get("after") ?? "0"));
  }

  if (segments[1] === "tasks" && segments[2] && segments[3] === "events" && method === "GET") {
    return streamEvents(req, res, orchestrator, segments[2], Number(url.searchParams.get("after") ?? "0"));
  }

  if (segments[1] === "tasks" && segments[2] && segments[3] === "cancel" && method === "POST") {
    const body = await readJson(req, bodyLimit) as { reason?: string | null };
    return sendJson(res, 200, await orchestrator.cancelTask(segments[2], body.reason ?? null));
  }

  if (segments[1] === "tickets" && segments[2]) {
    const ticketId = segments[2];
    const action = segments[3];
    if (action === "result" && method === "GET") {
      const maxChars = Number(url.searchParams.get("max_chars") ?? "20000");
      return sendJson(res, 200, orchestrator.getTicketResult(ticketId, Number.isFinite(maxChars) ? maxChars : 20000));
    }
    if (method === "POST" && action === "answer") {
      const body = await readJson(req, bodyLimit) as { message?: string };
      if (!body.message) throw new OrchestratorError("invalid_message", "message is required");
      return sendJson(res, 200, await orchestrator.answerTicket(ticketId, body.message));
    }
    if (method === "POST" && action === "resume") {
      const body = await readJson(req, bodyLimit) as { note?: string | null };
      return sendJson(res, 200, await orchestrator.resumeTicket(ticketId, body.note ?? null));
    }
    if (method === "POST" && action === "retry") {
      const body = await readJson(req, bodyLimit) as { note?: string | null };
      return sendJson(res, 200, await orchestrator.retryTicket(ticketId, body.note ?? null));
    }
    if (method === "POST" && action === "cancel") {
      const body = await readJson(req, bodyLimit) as { reason?: string | null };
      return sendJson(res, 200, await orchestrator.cancelTicket(ticketId, body.reason ?? null));
    }
  }

  return sendJson(res, 404, NOT_FOUND);
}

async function routeWorker(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  segments: string[],
  orchestrator: Orchestrator,
  bodyLimit: number,
): Promise<void> {
  const method = req.method ?? "GET";

  if (method === "POST" && url.pathname === "/internal/v1/workers/register") {
    const body = await readJson(req, bodyLimit) as WorkerRegistration;
    return sendJson(res, 201, orchestrator.registerWorker(body));
  }

  if (method === "POST" && segments[2] === "workers" && segments[3] && segments[4] === "heartbeat") {
    const body = await readJson(req, bodyLimit) as WorkerHeartbeat;
    return sendJson(res, 200, await orchestrator.heartbeatWorker(segments[3], body));
  }

  if (method === "POST" && url.pathname === "/internal/v1/reports") {
    const body = await readJson(req, bodyLimit) as WorkerReport;
    return sendJson(res, 200, await orchestrator.handleReport(body));
  }

  if (method === "POST" && segments[2] === "assignments" && segments[3] && segments[4] === "heartbeat") {
    orchestrator.assignmentHeartbeat(segments[3]);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, NOT_FOUND);
}

async function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  orchestrator: Orchestrator,
  taskId: string | undefined,
  afterInput: number,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
  res.write(": connected\n\n");
  let after = Number.isFinite(afterInput) ? afterInput : 0;
  let closed = false;
  req.on("close", () => { closed = true; });
  while (!closed) {
    const events = orchestrator.store.listEvents(taskId, after, 100);
    for (const event of events) {
      res.write(`id: ${event.event_id}\ndata: ${JSON.stringify(event)}\n\n`);
      after = Number(event.event_id);
    }
    await sleep(500);
  }
  res.end();
}

function authorized(req: IncomingMessage, expected: string): boolean {
  if (!expected) return true;
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] === expected;
}

function unauthorized() {
  return { error: { code: "invalid_token", message: "invalid or missing bearer token" } };
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new OrchestratorError("payload_too_large", "request body is too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new OrchestratorError("invalid_json", "request body is not valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(data.length),
  });
  res.end(data);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof OrchestratorError) {
    const status = error.code.endsWith("_not_found") ? 404
      : error.code === "duplicate_ticket" ? 409
      : error.code.startsWith("ticket_not_") ? 409
      : error.code.startsWith("invalid_") ? 400
      : 500;
    sendJson(res, status, { error: { code: error.code, message: error.message, details: error.details } });
    return;
  }
  sendJson(res, 500, {
    error: { code: "internal_error", message: error instanceof Error ? error.message : String(error) },
  });
}

export function serverAddress(server: Server): AddressInfo {
  return server.address() as AddressInfo;
}
