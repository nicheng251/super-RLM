
/**
 * super-RLM Router extension.
 *
 * Control plane only: every tool talks to the Orchestrator HTTP API.
 * This file must never import a shell, filesystem, or code-execution helper.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BASE = process.env.SUPER_RLM_ORCHESTRATOR_URL ?? "http://127.0.0.1:8787";
const TOKEN = process.env.SUPER_RLM_ROUTER_TOKEN ?? "";

type ToolResult = {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError?: boolean;
};

async function call(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "profile_list",
    label: "List Worker Profiles",
    description: "List the Worker profiles configured on the Orchestrator. Use this before choosing a profile for a Ticket.",
    parameters: Type.Object({}),
    async execute() {
      try { return ok(await call("GET", "/v1/profiles")); } catch (e) { return fail(e); }
    },
  });

  pi.registerTool({
    name: "task_create",
    label: "Create Task",
    description: "Create a Task with one or more independent Tickets. The Router decides the split; the Orchestrator does not.",
    parameters: Type.Object({
      task_prompt: Type.String({ description: "The original user request." }),
      tickets: Type.Array(Type.Object({
        title: Type.String({ description: "Short ticket title, at most 200 characters." }),
        prompt: Type.String({ description: "Self-contained Worker prompt." }),
        profile: Type.Optional(Type.String({ description: "Worker profile name; defaults to default." })),
      }), { minItems: 1, description: "Tickets to create." }),
    }),
    async execute(_id, params) {
      try {
        const body = {
          prompt: params.task_prompt,
          tickets: params.tickets.map((t) => ({ ...t, profile: t.profile ?? "default", metadata: {} })),
          metadata: {},
        };
        return ok(await call("POST", "/v1/tasks", body));
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
    label: "Wait for Task",
    description: "Wait until a Task settles or the timeout expires, then return its current TaskView.",
    parameters: Type.Object({
      task_id: Type.String(),
      timeout_s: Type.Optional(Type.Number({ description: "Timeout in seconds. Omit to use the Orchestrator default." })),
    }),
    async execute(_id, params) {
      try {
        const timeoutMs = Math.min(Math.max((params.timeout_s ?? 120) * 1000, 1000), 600_000);
        const q = params.timeout_s === undefined ? "" : `?timeout_s=${params.timeout_s}`;
        return ok(await call("GET", `/v1/tasks/${encodeURIComponent(params.task_id)}/wait${q}`, undefined, timeoutMs + 5_000));
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
}
