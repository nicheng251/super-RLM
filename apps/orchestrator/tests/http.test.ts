
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

import { Store } from "../src/db.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import type { DispatchFn } from "../src/orchestrator.ts";
import { createOrchestratorServer, serverAddress } from "../src/server.ts";
import type { ExecutionRequest } from "../../../packages/protocol/ts/index.ts";

async function harness() {
  const calls: ExecutionRequest[] = [];
  const dispatch: DispatchFn = async (_worker, request) => {
    calls.push(request);
    return { ok: true, executionId: `exe_${calls.length}` };
  };
  const store = new Store(":memory:");
  const orchestrator = new Orchestrator(store, {
    maxConcurrentTickets: 4,
    maxConcurrentTicketsPerTask: 2,
    priorityReserved: 1,
    workerLeaseMs: 30_000,
    dispatchTimeoutMs: 1000,
    workspaceRoot: "/tmp/super-rlm/workspaces",
    projectRepo: null,
  }, dispatch);
  const server = createOrchestratorServer(orchestrator, {
    routerToken: "router-token",
    workerToken: "worker-token",
    callbackKey: "callback-key",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${serverAddress(server).port}`;
  return { base, calls, orchestrator, store, server };
}

function jsonHeaders(token: string): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

function signedHeaders(token: string, body: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "nonce-1";
  const signature = createHmac("sha256", "callback-key")
    .update(timestamp + nonce + body)
    .digest("hex");
  return {
    ...jsonHeaders(token),
    "x-superrlm-timestamp": timestamp,
    "x-superrlm-nonce": nonce,
    "x-superrlm-signature": signature,
  };
}

async function post(base: string, path: string, token: string, body: unknown): Promise<Response> {
  return fetch(base + path, { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(body) });
}

test("HTTP router and worker routes complete a ticket", async () => {
  const { base, calls, orchestrator, store, server } = await harness();
  try {
    const registration = await post(base, "/internal/v1/workers/register", "worker-token", {
      worker_id: "wrk_http", url: "http://fake-worker", max_concurrency: 4, version: "test",
    });
    assert.equal(registration.status, 201);

    const createdResponse = await post(base, "/v1/tasks", "router-token", {
      prompt: "http task",
      tickets: [{ title: "http ticket", prompt: "do it" }],
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { task_id: string; tickets: Array<{ ticket_id: string }> };
    assert.equal(calls.length, 1);

    const statusResponse = await fetch(`${base}/v1/tasks/${created.task_id}`, {
      headers: { authorization: "Bearer router-token" },
    });
    assert.equal(statusResponse.status, 200);
    const view = await statusResponse.json() as { status: string };
    assert.equal(view.status, "running");

    const ticketId = created.tickets[0].ticket_id;
    const assignment = store.getActiveAssignment(ticketId);
    assert.ok(assignment);
    const reportBody = JSON.stringify({
      ticket_id: ticketId,
      assignment_id: assignment.assignment_id,
      execution_id: "exe_1",
      seq: 1,
      idempotency_key: "http:1",
      state: "completed",
      summary: "done",
      result: "ok",
      artifacts: [],
      delivered_to: ["/tmp/user/launch/out.txt"],
      delivery_error: "one artifact was skipped",
      timestamp: new Date().toISOString(),
    });
    const unsigned = await fetch(`${base}/internal/v1/reports`, {
      method: "POST",
      headers: jsonHeaders("worker-token"),
      body: reportBody,
    });
    assert.equal(unsigned.status, 401);
    const reportResponse = await fetch(`${base}/internal/v1/reports`, {
      method: "POST",
      headers: signedHeaders("worker-token", reportBody),
      body: reportBody,
    });
    assert.equal(reportResponse.status, 200);
    assert.deepEqual(await reportResponse.json(), { accepted: true });

    const resultResponse = await fetch(`${base}/v1/tickets/${ticketId}/result`, {
      headers: { authorization: "Bearer router-token" },
    });
    const result = await resultResponse.json() as {
      status: string; result: string; delivered_to: string[]; delivery_error: string | null;
    };
    assert.equal(result.status, "succeeded");
    assert.equal(result.result, "ok");
    assert.deepEqual(result.delivered_to, ["/tmp/user/launch/out.txt"]);
    assert.equal(result.delivery_error, "one artifact was skipped");

    const unauthorized = await fetch(`${base}/v1/tasks/${created.task_id}`);
    assert.equal(unauthorized.status, 401);
  } finally {
    server.close();
    store.close();
  }
});

test("HTTP answer resumes a waiting ticket with a priority assignment", async () => {
  const { base, calls, orchestrator, store, server } = await harness();
  try {
    await post(base, "/internal/v1/workers/register", "worker-token", {
      worker_id: "wrk_http", url: "http://fake-worker", max_concurrency: 4, version: "test",
    });
    const createdResponse = await post(base, "/v1/tasks", "router-token", {
      prompt: "waiting task",
      tickets: [{ title: "waiting ticket", prompt: "ask a question" }],
    });
    const created = await createdResponse.json() as { task_id: string; tickets: Array<{ ticket_id: string }> };
    const ticketId = created.tickets[0].ticket_id;
    const assignment = store.getActiveAssignment(ticketId);
    assert.ok(assignment);

    const waitingBody = JSON.stringify({
      ticket_id: ticketId,
      assignment_id: assignment.assignment_id,
      execution_id: "exe_1",
      seq: 1,
      idempotency_key: "waiting:1",
      state: "waiting",
      summary: "need input",
      question: { kind: "waiting", text: "Which platform?" },
      session_ref: "session-1",
      artifacts: [],
      timestamp: new Date().toISOString(),
    });
    const waiting = await fetch(`${base}/internal/v1/reports`, {
      method: "POST",
      headers: signedHeaders("worker-token", waitingBody),
      body: waitingBody,
    });
    assert.deepEqual(await waiting.json(), { accepted: true });

    const answer = await post(base, `/v1/tickets/${ticketId}/answer`, "router-token", { message: "Linux" });
    assert.equal(answer.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].resume?.session_ref, "session-1");
    assert.equal(calls[1].resume?.message, "Linux");
  } finally {
    server.close();
    store.close();
  }
});
