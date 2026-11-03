
import assert from "node:assert/strict";
import test from "node:test";

import { Store } from "../src/db.ts";
import { Orchestrator, OrchestratorError } from "../src/orchestrator.ts";
import type { DispatchFn } from "../src/orchestrator.ts";
import type { ExecutionRequest, WorkerReport } from "../../../packages/protocol/ts/index.ts";

function harness() {
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
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

test("two tickets run within the per-task cap, then a waiting ticket resumes with priority", async () => {
  const { calls, orchestrator } = harness();
  const created = await orchestrator.createTask({
    prompt: "do two things",
    tickets: [
      { title: "first", prompt: "First task", profile: "default" },
      { title: "second", prompt: "Second task", profile: "default" },
    ],
  });

  assert.equal(calls.length, 2);
  assert.equal(orchestrator.getTask(created.task_id).status, "running");

  const firstTicket = created.tickets[0].ticket_id;
  const secondTicket = created.tickets[1].ticket_id;
  const firstAssignment = orchestrator.store.getActiveAssignment(firstTicket);
  assert.ok(firstAssignment);

  const completed = await orchestrator.handleReport(report(
    firstTicket, firstAssignment.assignment_id, 1, "completed",
    { summary: "first done", result: "ok" },
  ));
  assert.deepEqual(completed, { accepted: true });
  assert.equal(orchestrator.getTicketResult(firstTicket).status, "succeeded");

  const duplicate = await orchestrator.handleReport(report(
    firstTicket, firstAssignment.assignment_id, 1, "completed",
    { summary: "first done", result: "ok" },
  ));
  assert.deepEqual(duplicate, { accepted: true, reason: "duplicate" });

  const late = await orchestrator.handleReport(report(
    firstTicket, firstAssignment.assignment_id, 2, "completed",
    { summary: "late", result: "late" },
  ));
  assert.deepEqual(late, { accepted: false, reason: "assignment_ended" });

  const secondAssignment = orchestrator.store.getActiveAssignment(secondTicket);
  assert.ok(secondAssignment);
  await orchestrator.handleReport(report(
    secondTicket, secondAssignment.assignment_id, 1, "waiting",
    {
      summary: "need a platform",
      question: { kind: "waiting", text: "Linux or Windows?" },
      session_ref: "prime-session-second",
    },
  ));

  const waiting = orchestrator.getTask(created.task_id);
  assert.equal(waiting.status, "waiting");
  const waitingTicket = waiting.tickets.find((ticket) => ticket.ticket_id === secondTicket);
  assert.equal(waitingTicket?.status, "waiting");
  assert.equal(waitingTicket?.question?.text, "Linux or Windows?");

  const answered = await orchestrator.answerTicket(secondTicket, "Linux");
  assert.ok(["assigned", "running"].includes(answered.status));
  assert.equal(calls.length, 3);
  assert.equal(calls[2].resume?.session_ref, "prime-session-second");
  assert.equal(calls[2].resume?.message, "Linux");

  const resumedAssignment = orchestrator.store.getActiveAssignment(secondTicket);
  assert.ok(resumedAssignment);
  assert.equal(resumedAssignment.kind, "priority");

  await orchestrator.handleReport(report(
    secondTicket, resumedAssignment.assignment_id, 1, "completed",
    { summary: "second done", result: "ok", session_ref: "prime-session-second" },
  ));
  const finalTask = orchestrator.getTask(created.task_id);
  assert.equal(finalTask.status, "succeeded");
});

test("duplicate tickets are rejected", async () => {
  const { orchestrator } = harness();
  await assert.rejects(
    () => orchestrator.createTask({
      prompt: "duplicate",
      tickets: [
        { title: "same", prompt: "same prompt" },
        { title: "same", prompt: "same prompt" },
      ],
    }),
    (error: unknown) => error instanceof OrchestratorError && error.code === "duplicate_ticket",
  );
});

test("answering a non-waiting ticket returns ticket_not_waiting", async () => {
  const { orchestrator } = harness();
  const created = await orchestrator.createTask({
    prompt: "one",
    tickets: [{ title: "one", prompt: "one" }],
  });
  await assert.rejects(
    () => orchestrator.answerTicket(created.tickets[0].ticket_id, "too early"),
    (error: unknown) => error instanceof OrchestratorError && error.code === "ticket_not_waiting",
  );
});

test("the per-task cap leaves queued tickets for a later slot", async () => {
  const { calls, orchestrator } = harness();
  const created = await orchestrator.createTask({
    prompt: "three",
    tickets: [
      { title: "a", prompt: "a" },
      { title: "b", prompt: "b" },
      { title: "c", prompt: "c" },
    ],
  });
  assert.equal(calls.length, 2);
  const view = orchestrator.getTask(created.task_id);
  assert.equal(view.tickets.filter((ticket) => ticket.status === "running").length, 2);
  assert.equal(view.tickets.filter((ticket) => ticket.status === "queued").length, 1);
});

test("dropped reports settle the ticket as a no-op success", async () => {
  const { orchestrator } = harness();
  const created = await orchestrator.createTask({
    prompt: "drop",
    tickets: [{ title: "drop", prompt: "drop" }],
  });
  const ticketId = created.tickets[0].ticket_id;
  const assignment = orchestrator.store.getActiveAssignment(ticketId);
  assert.ok(assignment);
  await orchestrator.handleReport(report(
    ticketId, assignment.assignment_id, 1, "dropped",
    { summary: "nothing to do" },
  ));
  const result = orchestrator.getTicketResult(ticketId);
  assert.equal(result.status, "succeeded");
  assert.equal(result.outcome, "dropped");
  assert.equal(result.no_op, true);
  assert.equal(orchestrator.getTask(created.task_id).status, "succeeded");
});
