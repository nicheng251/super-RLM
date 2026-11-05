
import assert from "node:assert/strict";
import test from "node:test";

import { Store } from "../src/db.ts";
import type { AssignmentRecord, TaskRecord, TicketRecord } from "../src/domain.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import type { DispatchFn } from "../src/orchestrator.ts";

function seed(retryCount = 0) {
  const store = new Store(":memory:");
  const now = "2026-11-04T00:00:00.000Z";
  const task: TaskRecord = {
    task_id: "tsk_1", prompt: "recover", status: "running", metadata: {},
    created_at: now, updated_at: now, cancel_requested: false, timeout_at: null,
  };
  const ticket: TicketRecord = {
    ticket_id: "tkt_1", task_id: "tsk_1", title: "t", prompt: "p", profile: "default",
    status: "running", summary: null, result: null, artifacts: [], usage: null, error: null,
    question: null, session_key: "tkt_1", session_ref: null, outcome: null, no_op: null,
    retry_count: retryCount, not_before: null, priority_next: false, resume_message: null,
    delivered_to: [], delivery_error: null,
    created_at: now, updated_at: now,
  };
  const assignment: AssignmentRecord = {
    assignment_id: "asg_1", ticket_id: "tkt_1", task_id: "tsk_1", worker_id: "wrk_1",
    execution_id: "exe_1", status: "running", end_reason: null, kind: "normal", last_seq: 0,
    resume_ref: null, resume_message: null, created_at: now, updated_at: now,
  };
  store.insertTask(task, [ticket]);
  store.insertAssignment(assignment);
  const dispatch: DispatchFn = async () => ({ ok: false, status: 0, error: "no worker", retryable: true });
  const orchestrator = new Orchestrator(store, {
    maxConcurrentTickets: 4, maxConcurrentTicketsPerTask: 2, priorityReserved: 1,
    workerLeaseMs: 30_000, dispatchTimeoutMs: 1000, workspaceRoot: "/tmp/super-rlm/workspaces",
  }, dispatch);
  return { store, orchestrator };
}

test("recover ends open assignments and retries lost tickets", () => {
  const { store, orchestrator } = seed(0);
  orchestrator.recover();
  const assignment = store.getAssignment("asg_1");
  assert.equal(assignment?.status, "ended");
  assert.equal(assignment?.end_reason, "lost");
  const ticket = store.getTicket("tkt_1");
  assert.equal(ticket?.status, "lost");
  assert.equal(ticket?.retry_count, 1);
  assert.equal(store.getTask("tsk_1")?.status, "queued");
  store.close();
});

test("recover fails a ticket after the retry budget", () => {
  const { store, orchestrator } = seed(3);
  orchestrator.recover();
  const ticket = store.getTicket("tkt_1");
  assert.equal(ticket?.status, "failed");
  assert.equal(ticket?.error?.code, "worker_lost");
  assert.equal(store.getTask("tsk_1")?.status, "failed");
  store.close();
});
