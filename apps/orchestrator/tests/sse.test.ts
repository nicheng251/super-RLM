
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { Store } from "../src/db.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import type { DispatchFn } from "../src/orchestrator.ts";
import { createOrchestratorServer, serverAddress } from "../src/server.ts";
import type { ExecutionRequest } from "../../../packages/protocol/ts/index.ts";

test("SSE streams task events with cursors", async () => {
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
    callbackUrl: null,
    callbackKey: "test-callback-key",
  }, dispatch);
  orchestrator.registerWorker({ worker_id: "wrk_sse", url: "http://fake", max_concurrency: 2, version: "test" });
  const server = createOrchestratorServer(orchestrator, {
    routerToken: "router-token",
    workerToken: "worker-token",
    callbackKey: "callback-key",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${serverAddress(server).port}`;
  const controller = new AbortController();
  try {
    await orchestrator.createTask({
      prompt: "sse task",
      tickets: [{ title: "sse", prompt: "do it" }],
    });
    const response = await fetch(`${base}/v1/events?after=0`, {
      headers: { authorization: "Bearer router-token" },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const seen = new Set<string>();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(seen.has("task.created") && seen.has("assignment.started"))) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6)) as { type: string };
        seen.add(event.type);
      }
    }
    assert.ok(seen.has("task.created"), [...seen].join(","));
    assert.ok(seen.has("assignment.started"), [...seen].join(","));
  } finally {
    controller.abort();
    server.close();
    store.close();
  }
});
