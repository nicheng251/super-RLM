import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { TuiApi } from "../src/api.ts";

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
  });
  try {
    await assert.rejects(() => api.listWorkers(), /workers 404/);
  } finally {
    server.close();
  }
});
