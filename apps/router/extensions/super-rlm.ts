
/**
 * super-RLM Router extension.
 *
 * Control plane only: every tool talks to the Orchestrator HTTP API.
 * This file must never import a shell, filesystem, or code-execution helper.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerPageCommands } from "./pages.ts";

const BASE = process.env.SUPER_RLM_ORCHESTRATOR_URL ?? "http://127.0.0.1:8787";
const TOKEN = process.env.SUPER_RLM_ROUTER_TOKEN ?? "";

type ToolResult = {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError?: boolean;
};

async function call(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
  idempotencyKey?: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN}`,
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    if (!res.ok) {
      throw new Error(`Orchestrator ${res.status}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: {} };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], details: {}, isError: true };
}

type SuperRlmEvent = {
  event_id?: number;
  type?: string;
  task_id?: string | null;
  ticket_id?: string | null;
  data?: Record<string, unknown>;
};

function actionable(event: SuperRlmEvent): boolean {
  return event.type === "ticket.waiting"
    || event.type === "ticket.blocked"
    || event.type === "task.settled";
}

function eventText(event: SuperRlmEvent): string {
  const task = event.task_id ? `Task ${event.task_id}` : "A Task";
  const ticket = event.ticket_id ? `Ticket ${event.ticket_id}` : "A Ticket";
  if (event.type === "ticket.waiting" || event.type === "ticket.blocked") {
    const question = (event.data?.question as { text?: string } | undefined)?.text;
    const label = event.type === "ticket.waiting" ? "needs an answer" : "is blocked";
    return `${ticket} ${label}${question ? `: ${question}` : "."} (${task})`;
  }
  const status = (event.data?.status as string | undefined) ?? "settled";
  return `${task} ${status}. Use task_status or ticket_result to read the result.`;
}

async function runEventLoop(pi: ExtensionAPI, signal: AbortSignal): Promise<void> {
  let cursor = 0;
  let lastNotify = 0;
  while (!signal.aborted) {
    try {
      const response = await fetch(`${BASE}/v1/events?after=${cursor}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal,
      });
      if (!response.ok || !response.body) throw new Error(`event stream ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          let event: SuperRlmEvent;
          try { event = JSON.parse(dataLine.slice(6)) as SuperRlmEvent; } catch { continue; }
          if (typeof event.event_id === "number") cursor = Math.max(cursor, event.event_id);
          if (!actionable(event)) continue;
          const now = Date.now();
          if (now - lastNotify < 5_000) continue;
          lastNotify = now;
          pi.sendMessage(
            { customType: "super-rlm", content: eventText(event), display: true },
            { deliverAs: "followUp", triggerTurn: true },
          );
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "profile_list",
    label: "List Worker Profiles",
    description: "List the Worker profiles configured on the Orchestrator. Use capabilities, requires_repo, and read_only to choose a profile for each Ticket before task_create.",
    parameters: Type.Object({}),
    async execute() {
      try { return ok(await call("GET", "/v1/profiles")); } catch (e) { return fail(e); }
    },
  });

  pi.registerTool({
    name: "task_create",
    label: "Create Task",
    description: "Create a Task with one or more independent Tickets. Choose each Ticket's profile from profile_list: match its capabilities, and use requires_repo/read_only when they apply; use default when unsure. Returns immediately. After this call, report the IDs and return control; do not call task_wait. The SSE loop will notify you when the Task settles.",
    parameters: Type.Object({
      task_prompt: Type.String({ description: "The original user request." }),
      tickets: Type.Array(Type.Object({
        title: Type.String({ description: "Short ticket title, at most 200 characters." }),
        prompt: Type.String({ description: "Self-contained Worker prompt." }),
        profile: Type.Optional(Type.String({ description: "Worker profile name from profile_list; defaults to default." })),
        profile_reason: Type.Optional(Type.String({ description: "Short reason for choosing this profile." })),
      }), { minItems: 1, description: "Tickets to create." }),
    }),
    async execute(_id, params) {
      try {
        const body = {
          prompt: params.task_prompt,
          tickets: params.tickets.map((t) => ({
            title: t.title,
            prompt: t.prompt,
            profile: t.profile ?? "default",
            metadata: {},
          })),
          metadata: {
            origin_cwd: process.env.SUPER_RLM_ORIGIN_CWD ?? null,
            profile_reasons: params.tickets.map((t) => t.profile_reason ?? null),
          },
        };
        const created = await call("POST", "/v1/tasks", body) as Record<string, unknown>;
        return ok({
          ...created,
          router_hint: "Return control now. Do not call task_wait; the SSE loop will notify you when this Task settles.",
        });
      } catch (e) { return fail(e); }
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "List Tasks",
    description: "List Tasks, optionally filtered by status.",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "Filter by Task status." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of Tasks, default 20." })),
    }),
    async execute(_id, params) {
      try {
        const q = new URLSearchParams();
        if (params.status) q.set("status", params.status);
        if (params.limit) q.set("limit", String(params.limit));
        return ok(await call("GET", `/v1/tasks${q.size ? `?${q}` : ""}`));
      } catch (e) { return fail(e); }
    },
  });

  pi.registerTool({
    name: "task_status",
    label: "Task Status",
    description: "Read one Task and its Tickets.",
    parameters: Type.Object({ task_id: Type.String() }),
    async execute(_id, params) {
      try { return ok(await call("GET", `/v1/tasks/${encodeURIComponent(params.task_id)}`)); } catch (e) { return fail(e); }
    },
  });

  pi.registerTool({
    name: "task_wait",
    label: "Wait for Task (blocking)",
    description: "Blocking wait. Use only when the user explicitly asks you to wait for completion; otherwise return after task_create and wait for the SSE notification. Long waits freeze the Router TUI.",
    parameters: Type.Object({
      task_id: Type.String(),
      timeout_s: Type.Optional(Type.Number({ description: "Timeout in seconds, default 15, maximum 60." })),
    }),
    async execute(_id, params) {
      try {
        const timeoutSeconds = Math.min(Math.max(params.timeout_s ?? 15, 1), 60);
        return ok(await call(
          "GET",
          `/v1/tasks/${encodeURIComponent(params.task_id)}/wait?timeout_s=${timeoutSeconds}`,
          undefined,
          timeoutSeconds * 1000 + 5_000,
        ));
      } catch (e) { return fail(e); }
    },
  });

  pi.registerTool({
    name: "ticket_result",
    label: "Ticket Result",
    description: "Read one Ticket's full result, bounded by max_chars.",
    parameters: Type.Object({
      ticket_id: Type.String(),
      max_chars: Type.Optional(Type.Number({ description: "Maximum result characters, default 20000." })),
    }),
    async execute(_id, params) {
      try {
        const q = params.max_chars === undefined ? "" : `?max_chars=${params.max_chars}`;
        return ok(await call("GET", `/v1/tickets/${encodeURIComponent(params.ticket_id)}/result${q}`));
      } catch (e) { return fail(e); }
    },
  });

  pi.registerTool({
    name: "ticket_answer",
    label: "Answer Ticket",
    description: "Answer a Ticket in waiting state. The answer is stored and the same Prime Agent session is resumed.",
    parameters: Type.Object({
      ticket_id: Type.String(),
      message: Type.String({ description: "The user's answer." }),
    }),
    async execute(_id, params) {
      try {
        return ok(await call(
          "POST", `/v1/tickets/${encodeURIComponent(params.ticket_id)}/answer`,
          { message: params.message }, 30_000, randomUUID(),
        ));
      } catch (e) { return fail(e); }
    },
  });

  pi.registerTool({
    name: "ticket_resume",
    label: "Resume Ticket",
    description: "Resume a Ticket in blocked state after the external condition is resolved.",
    parameters: Type.Object({
      ticket_id: Type.String(),
      note: Type.Optional(Type.String({ description: "What changed." })),
    }),
    async execute(_id, params) {
      try {
        return ok(await call(
          "POST", `/v1/tickets/${encodeURIComponent(params.ticket_id)}/resume`,
          { note: params.note ?? null }, 30_000, randomUUID(),
        ));
      } catch (e) { return fail(e); }
    },
  });

  pi.registerTool({
    name: "ticket_retry",
    label: "Retry Ticket",
    description: "Retry a Ticket in failed or lost state.",
    parameters: Type.Object({
      ticket_id: Type.String(),
      note: Type.Optional(Type.String({ description: "Extra context for the retry." })),
    }),
    async execute(_id, params) {
      try {
        return ok(await call(
          "POST", `/v1/tickets/${encodeURIComponent(params.ticket_id)}/retry`,
          { note: params.note ?? null }, 30_000, randomUUID(),
        ));
      } catch (e) { return fail(e); }
    },
  });

  pi.registerTool({
    name: "ticket_cancel",
    label: "Cancel Ticket",
    description: "Cancel one Ticket and its active Assignment.",
    parameters: Type.Object({
      ticket_id: Type.String(),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      try {
        return ok(await call(
          "POST", `/v1/tickets/${encodeURIComponent(params.ticket_id)}/cancel`,
          { reason: params.reason ?? null }, 30_000, randomUUID(),
        ));
      } catch (e) { return fail(e); }
    },
  });

  pi.registerTool({
    name: "task_cancel",
    label: "Cancel Task",
    description: "Cancel a Task and all of its active Tickets.",
    parameters: Type.Object({
      task_id: Type.String(),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      try {
        return ok(await call(
          "POST", `/v1/tasks/${encodeURIComponent(params.task_id)}/cancel`,
          { reason: params.reason ?? null }, 30_000, randomUUID(),
        ));
      } catch (e) { return fail(e); }
    },
  });

  let eventAbort: AbortController | null = null;
  pi.on("session_start", async () => {
    eventAbort?.abort();
    eventAbort = new AbortController();
    void runEventLoop(pi, eventAbort.signal);
  });
  pi.on("session_shutdown", async () => {
    eventAbort?.abort();
    eventAbort = null;
  });

  registerPageCommands(pi);
}
