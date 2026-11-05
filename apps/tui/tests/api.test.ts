import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { TicketSessionHttpError, TuiApi } from "../src/api.ts";

test("listWorkers reads the typed workers payload with bearer auth", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
    const data = Buffer.from(JSON.stringify({
      workers: [{
        worker_id: "w1",
        url: "http://127.0.0.1:8080",
        status: "healthy",
        running: 1,
        max_concurrency: 2,
        last_heartbeat: "2026-11-04T00:00:00Z",
        version: null,
      }],
    }));
    res.writeHead(200, { "content-type": "application/json", "content-length": String(data.length) });
    res.end(data);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const api = new TuiApi({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "secret",
    workerPort: 8080,
    workerToken: "worker-secret",
  });
  try {
    const workers = await api.listWorkers();
    assert.equal(workers.length, 1);
    assert.equal(workers[0].worker_id, "w1");
    assert.equal(workers[0].status, "healthy");
    assert.equal(workers[0].version, null);
    assert.deepEqual(seen, ["GET /v1/workers Bearer secret"]);
  } finally {
    server.close();
  }
});

test("listWorkers reports a missing workers route", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found", message: "no route" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const api = new TuiApi({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "secret",
    workerPort: 8080,
    workerToken: "worker-secret",
  });
  try {
    await assert.rejects(() => api.listWorkers(), /workers 404/);
  } finally {
    server.close();
  }
});

test("ticketSession calls the Worker endpoint with worker bearer auth and normalizes the payload", async () => {
  const seen: string[] = [];
  const session = {
    ticket_id: "tkt_1",
    session_ref: "C:/sessions/abc.jsonl",
    session_dir: "C:/sessions",
    session_id: "abc",
    session_file: "C:/sessions/abc.jsonl",
    daemon_socket: "C:/daemon/worker.sock",
    status: "running",
    running: true,
    worker_pid: 4321,
    exists: true,
  };
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
    const data = Buffer.from(JSON.stringify(session));
    res.writeHead(200, { "content-type": "application/json", "content-length": String(data.length) });
    res.end(data);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const api = new TuiApi({
    baseUrl: "http://127.0.0.1:1",
    token: "orchestrator-secret",
    workerPort: address.port,
    workerToken: "worker-secret",
  });
  try {
    const result = await api.ticketSession("tkt/one two");
    assert.deepEqual(result, session);
    assert.deepEqual(seen, ["GET /v1/tickets/tkt%2Fone%20two/session Bearer worker-secret"]);
  } finally {
    server.close();
  }
});

test("ticketSession preserves 404 so the viewer can show an empty state", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found", message: "no execution state" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const api = new TuiApi({
    baseUrl: "http://127.0.0.1:1",
    token: "orchestrator-secret",
    workerPort: address.port,
    workerToken: "worker-secret",
  });
  try {
    await assert.rejects(
      () => api.ticketSession("tkt_missing"),
      (error: unknown) => error instanceof TicketSessionHttpError && error.status === 404,
    );
  } finally {
    server.close();
  }
});
