import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import type { OutboxRecord } from "../src/db.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import type { DispatchFn } from "../src/orchestrator.ts";
import {
  MAX_CALLBACK_ATTEMPTS,
  OutboxDispatcher,
  retryDelayMs,
  signCallback,
} from "../src/outbox.ts";
import type { ExecutionRequest, WorkerReport } from "../../../packages/protocol/ts/index.ts";

const NOW = new Date("2026-11-05T00:00:00.000Z");
const PUBLIC_ADDRESS = "93.184.216.34";
const resolvePublic = async () => [PUBLIC_ADDRESS];

function harness(callbackUrl: string | null = "http://callback.test/hook") {
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
    callbackUrl,
    callbackKey: "callback-secret",
  }, dispatch);
  orchestrator.registerWorker({
    worker_id: "wrk_test",
    url: "http://fake-worker",
    max_concurrency: 4,
    version: "test",
  });
  return { calls, orchestrator, store };
}

function report(
  ticketId: string,
  assignmentId: string,
  seq: number,
  state: WorkerReport["state"],
  extra: Partial<WorkerReport> = {},
): WorkerReport {
  return {
    ticket_id: ticketId,
    assignment_id: assignmentId,
    execution_id: `exe_${seq}`,
    seq,
    idempotency_key: `${assignmentId}:${seq}`,
    state,
    summary: null,
    result: null,
    artifacts: [],
    timestamp: NOW.toISOString(),
    ...extra,
  };
}

function outboxRecord(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    outbox_id: 1,
    event_id: 7,
    target: "http://callback.test/hook",
    payload: { event_id: 7, type: "ticket.waiting", ticket_id: "tkt_1" },
    attempts: 0,
    next_attempt_at: NOW.toISOString(),
    status: "pending",
    last_error: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    delivered_at: null,
    ...overrides,
  };
}

test("only important event types enqueue callbacks, with a full payload", async () => {
  const { orchestrator, store } = harness();
  const future = "2099-01-01T00:00:00.000Z";
  assert.deepEqual(store.dueOutbox(future, 100), []);

  const created = await orchestrator.createTask({
    prompt: "callback task",
    tickets: [{ title: "callback ticket", prompt: "do it" }],
  });
  assert.deepEqual(store.dueOutbox(future, 100), []);

  const ticketId = created.tickets[0].ticket_id;
  const assignment = store.getActiveAssignment(ticketId);
  assert.ok(assignment);
  await orchestrator.handleReport(report(
    ticketId, assignment.assignment_id, 1, "waiting",
    { summary: "need input", question: { kind: "waiting", text: "which platform?" } },
  ));

  const waitingRows = store.dueOutbox(future, 100);
  assert.equal(waitingRows.length, 1);
  const payload = waitingRows[0].payload as Record<string, unknown>;
  assert.equal(payload.event_id, waitingRows[0].event_id);
  assert.equal(payload.type, "ticket.waiting");
  assert.equal(payload.task_id, created.task_id);
  assert.equal(payload.ticket_id, ticketId);
  assert.equal(payload.assignment_id, null);
  assert.equal(payload.worker_id, null);
  assert.deepEqual(payload.data, { question: { kind: "waiting", text: "which platform?" } });
  assert.equal(typeof payload.created_at, "string");

  await orchestrator.answerTicket(ticketId, "Linux");
  const resumed = store.getActiveAssignment(ticketId);
  assert.ok(resumed);
  await orchestrator.handleReport(report(
    ticketId, resumed.assignment_id, 1, "completed", { summary: "done", result: "ok" },
  ));

  const settledTypes = store.dueOutbox(future, 100)
    .map((row) => (row.payload as Record<string, unknown>).type)
    .sort();
  assert.deepEqual(settledTypes, ["task.settled", "ticket.settled", "ticket.waiting"]);
  store.close();
});

test("the dispatcher posts a signed payload and marks it delivered", async () => {
  const delivered: Array<{ id: number; now: string | undefined }> = [];
  const failures: unknown[] = [];
  const rows = [outboxRecord()];
  const store = {
    dueOutbox: (now: string, limit?: number) => rows.slice(0, limit ?? rows.length),
    markOutboxDelivered: (id: number, now?: string) => { delivered.push({ id, now }); },
    markOutboxFailed: (id: number, input: unknown) => { failures.push({ id, input }); },
  };
  const captured: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const dispatcher = new OutboxDispatcher(store, "http://callback.test/hook", "callback-secret", {
    now: () => NOW,
    resolveHost: resolvePublic,
  });
  const count = await dispatcher.flush(20, fakeFetch);

  assert.equal(count, 1);
  assert.equal(failures.length, 0);
  assert.deepEqual(delivered, [{ id: 1, now: NOW.toISOString() }]);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "http://callback.test/hook");
  assert.equal(captured[0].init.method, "POST");
  const body = String(captured[0].init.body);
  assert.deepEqual(JSON.parse(body), rows[0].payload);
  const headers = captured[0].init.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["x-superrlm-timestamp"], String(Math.floor(NOW.getTime() / 1000)));
  const expected = createHmac("sha256", "callback-secret")
    .update(headers["x-superrlm-timestamp"] + headers["x-superrlm-nonce"] + body)
    .digest("hex");
  assert.equal(headers["x-superrlm-signature"], expected);
});

test("signCallback signs timestamp + nonce + body", () => {
  const signed = signCallback("key", "body", 1234, "nonce");
  assert.equal(signed.timestamp, "1234");
  assert.equal(signed.nonce, "nonce");
  assert.equal(
    signed.signature,
    createHmac("sha256", "key").update("1234noncebody").digest("hex"),
  );
});

test("a failed delivery backs off, and the eighth failure marks it failed", async () => {
  const row = outboxRecord();
  const failures: Array<{ attempts: number; nextAttemptAt: string; error: string; status?: string }> = [];
  const store = {
    dueOutbox: () => [row],
    markOutboxDelivered: () => { throw new Error("unexpected delivery"); },
    markOutboxFailed: (_id: number, input: { attempts: number; nextAttemptAt: string; error: string; status?: "pending" | "failed" }) => {
      failures.push(input);
      row.attempts = input.attempts;
      if (input.status === "failed") row.status = "failed";
    },
  };
  const fakeFetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
  const dispatcher = new OutboxDispatcher(store, "http://callback.test/hook", "callback-secret", {
    now: () => NOW,
    resolveHost: resolvePublic,
  });

  for (let attempt = 1; attempt <= MAX_CALLBACK_ATTEMPTS; attempt += 1) {
    await dispatcher.flush(20, fakeFetch);
  }

  assert.equal(failures.length, MAX_CALLBACK_ATTEMPTS);
  assert.deepEqual(failures[0], {
    attempts: 1,
    nextAttemptAt: new Date(NOW.getTime() + 2_000).toISOString(),
    error: "callback returned 503",
  });
  assert.equal(failures[1].nextAttemptAt, new Date(NOW.getTime() + 5_000).toISOString());
  assert.equal(failures[2].nextAttemptAt, new Date(NOW.getTime() + 15_000).toISOString());
  assert.equal(failures[3].nextAttemptAt, new Date(NOW.getTime() + 60_000).toISOString());
  assert.equal(failures[4].nextAttemptAt, new Date(NOW.getTime() + 300_000).toISOString());
  assert.equal(failures[7].attempts, 8);
  assert.equal(failures[7].status, "failed");
  assert.equal(retryDelayMs(1), 2_000);
  assert.equal(retryDelayMs(4), 60_000);
  assert.equal(retryDelayMs(9), 300_000);
});

test("network errors are recorded as retryable failures", async () => {
  const failures: Array<{ error: string; attempts: number }> = [];
  const store = {
    dueOutbox: () => [outboxRecord()],
    markOutboxDelivered: () => { throw new Error("unexpected delivery"); },
    markOutboxFailed: (_id: number, input: { attempts: number; error: string }) => { failures.push(input); },
  };
  const fakeFetch = (async () => { throw new Error("connection refused"); }) as typeof fetch;
  const dispatcher = new OutboxDispatcher(store, "http://callback.test/hook", "callback-secret", {
    now: () => NOW,
    resolveHost: resolvePublic,
  });

  await dispatcher.flush(20, fakeFetch);
  assert.deepEqual(failures, [{ attempts: 1, error: "connection refused", nextAttemptAt: new Date(NOW.getTime() + 2_000).toISOString() }]);
});

test("no callback URL means the dispatcher is a no-op", async () => {
  let dueCalls = 0;
  const store = {
    dueOutbox: () => { dueCalls += 1; return [outboxRecord()]; },
    markOutboxDelivered: () => {},
    markOutboxFailed: () => {},
  };
  let fetchCalls = 0;
  const fakeFetch = (async () => { fetchCalls += 1; return new Response(""); }) as typeof fetch;
  const dispatcher = new OutboxDispatcher(store, null, "callback-secret", { now: () => NOW });
  assert.equal(await dispatcher.flush(20, fakeFetch), 0);
  assert.equal(dueCalls, 0);
  assert.equal(fetchCalls, 0);

  const { orchestrator, store: realStore } = harness(null);
  await orchestrator.flushOutbox();
  assert.equal((realStore.db.prepare("SELECT COUNT(*) AS count FROM outbox").get() as { count: number }).count, 0);
  realStore.close();
});

test("config parses callback URL and key from the environment", () => {
  const defaults = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(defaults.callbackUrl, null);
  assert.equal(defaults.callbackKey, "dev-callback-key");

  const configured = loadConfig({
    SUPER_RLM_CALLBACK_URL: "  http://callback.test/hook  ",
    SUPER_RLM_CALLBACK_KEY: "secret",
  } as NodeJS.ProcessEnv);
  assert.equal(configured.callbackUrl, "http://callback.test/hook");
  assert.equal(configured.callbackKey, "secret");

  assert.equal(loadConfig({ SUPER_RLM_CALLBACK_URL: "   " } as NodeJS.ProcessEnv).callbackUrl, null);
});

interface CapturedFailure {
  id: number;
  input: { attempts: number; nextAttemptAt: string; error: string; status?: string };
}

function callbackStore(rows: OutboxRecord[]) {
  const failures: CapturedFailure[] = [];
  const delivered: number[] = [];
  return {
    failures,
    delivered,
    store: {
      dueOutbox: () => rows,
      markOutboxDelivered: (id: number) => { delivered.push(id); },
      markOutboxFailed: (id: number, input: CapturedFailure["input"]) => { failures.push({ id, input }); },
    },
  };
}

test("callback targets with private addresses, bad schemes, or credentials are rejected before delivery", async () => {
  const cases: Array<{ target: string; resolveHost: () => Promise<string[]> }> = [
    { target: "http://127.0.0.1/hook", resolveHost: resolvePublic },
    { target: "http://10.1.2.3/hook", resolveHost: resolvePublic },
    { target: "http://172.16.4.5/hook", resolveHost: resolvePublic },
    { target: "http://169.254.169.254/latest/meta-data", resolveHost: resolvePublic },
    { target: "http://[::1]/hook", resolveHost: resolvePublic },
    { target: "http://[::ffff:127.0.0.1]/hook", resolveHost: resolvePublic },
    { target: "ftp://callback.test/hook", resolveHost: resolvePublic },
    { target: "http://user:pass@callback.test/hook", resolveHost: resolvePublic },
    { target: "http://internal.test/hook", resolveHost: async () => ["10.0.0.7"] },
  ];

  for (const testCase of cases) {
    const { store, failures, delivered } = callbackStore([outboxRecord({ target: testCase.target })]);
    let fetchCalls = 0;
    const fakeFetch = (async () => {
      fetchCalls += 1;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const dispatcher = new OutboxDispatcher(store, "https://public.test/hook", "callback-secret", {
      now: () => NOW,
      resolveHost: testCase.resolveHost,
    });

    await dispatcher.flush(20, fakeFetch);

    assert.equal(fetchCalls, 0, testCase.target);
    assert.equal(delivered.length, 0, testCase.target);
    assert.equal(failures.length, 1, testCase.target);
    assert.match(failures[0].input.error, /^callback target rejected:/, testCase.target);
  }
});

test("a public callback target is delivered with redirects disabled", async () => {
  const { store, failures, delivered } = callbackStore([outboxRecord()]);
  const captured: RequestInit[] = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured.push(init ?? {});
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const dispatcher = new OutboxDispatcher(store, "https://public.test/hook", "callback-secret", {
    now: () => NOW,
    resolveHost: resolvePublic,
  });

  assert.equal(await dispatcher.flush(20, fakeFetch), 1);
  assert.deepEqual(failures, []);
  assert.deepEqual(delivered, [1]);
  assert.equal(captured[0].redirect, "manual");
  assert.ok(captured[0].signal instanceof AbortSignal);
});

test("redirect responses are treated as failures, not followed", async () => {
  const { store, failures } = callbackStore([outboxRecord()]);
  const captured: RequestInit[] = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured.push(init ?? {});
    return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
  }) as typeof fetch;
  const dispatcher = new OutboxDispatcher(store, "https://public.test/hook", "callback-secret", {
    now: () => NOW,
    resolveHost: resolvePublic,
  });

  await dispatcher.flush(20, fakeFetch);

  assert.equal(captured[0].redirect, "manual");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].input.error, "callback returned 302");
});

test("each row target is validated independently", async () => {
  const rows = [
    outboxRecord({ outbox_id: 1, target: "http://127.0.0.1/hook" }),
    outboxRecord({ outbox_id: 2, target: "https://public.test/hook" }),
  ];
  const { store, failures, delivered } = callbackStore(rows);
  const urls: string[] = [];
  const fakeFetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const dispatcher = new OutboxDispatcher(store, "https://fallback.test/hook", "callback-secret", {
    now: () => NOW,
    resolveHost: resolvePublic,
  });

  assert.equal(await dispatcher.flush(20, fakeFetch), 1);
  assert.deepEqual(urls, ["https://public.test/hook"]);
  assert.deepEqual(delivered, [2]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].id, 1);
});

test("private callback targets require an explicit opt-in", async () => {
  const { store, failures, delivered } = callbackStore([outboxRecord({ target: "http://127.0.0.1/hook" })]);
  let fetchCalls = 0;
  const fakeFetch = (async () => {
    fetchCalls += 1;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const dispatcher = new OutboxDispatcher(store, "http://127.0.0.1/hook", "callback-secret", {
    now: () => NOW,
    allowPrivate: true,
  });

  assert.equal(await dispatcher.flush(20, fakeFetch), 1);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(failures, []);
  assert.deepEqual(delivered, [1]);
});

test("oversized callback responses are rejected", async () => {
  const { store, failures, delivered } = callbackStore([outboxRecord()]);
  const fakeFetch = (async () => new Response("x".repeat(200), {
    status: 200,
    headers: { "content-length": "200" },
  })) as typeof fetch;
  const dispatcher = new OutboxDispatcher(store, "https://public.test/hook", "callback-secret", {
    now: () => NOW,
    resolveHost: resolvePublic,
    maxResponseBytes: 100,
  });

  await dispatcher.flush(20, fakeFetch);

  assert.deepEqual(delivered, []);
  assert.equal(failures.length, 1);
  assert.match(failures[0].input.error, /callback response rejected: .*exceeded 100 bytes/);
});
