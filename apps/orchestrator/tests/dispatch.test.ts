
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { Store } from "../src/db.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import type { ExecutionRequest } from "../../../packages/protocol/ts/index.ts";

test("the default dispatch posts the ExecutionRequest contract to a Worker", async () => {
  const requests: ExecutionRequest[] = [];
  const worker = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ExecutionRequest);
    const data = Buffer.from(JSON.stringify({ execution_id: "exe_remote", status: "accepted" }));
    res.writeHead(202, { "content-type": "application/json", "content-length": String(data.length) });
    res.end(data);
  });
  worker.listen(0, "127.0.0.1");
  await once(worker, "listening");
  const address = worker.address();
  assert.ok(address && typeof address === "object");
  const workerUrl = `http://127.0.0.1:${address.port}`;

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
  });
  try {
    orchestrator.registerWorker({
      worker_id: "wrk_remote", url: workerUrl, max_concurrency: 2, version: "test",
    });
    const created = await orchestrator.createTask({
      prompt: "remote dispatch",
      tickets: [{ title: "remote", prompt: "do it" }],
      metadata: { origin_cwd: "/tmp/user/launch" },
    });
    assert.equal(requests.length, 1);
    const request = requests[0];
    const ticketId = created.tickets[0].ticket_id;
    assert.equal(request.ticket_id, ticketId);
    assert.equal(request.profile, "default");
    assert.equal(request.workspace, `/tmp/super-rlm/workspaces/${ticketId}`);
    assert.equal(request.origin_cwd, "/tmp/user/launch");

    const assignment = store.getActiveAssignment(ticketId);
    assert.ok(assignment);
    assert.equal(assignment.status, "running");
    assert.equal(assignment.execution_id, "exe_remote");
    assert.equal(orchestrator.getTask(created.task_id).status, "running");
  } finally {
    store.close();
    worker.close();
  }
});
