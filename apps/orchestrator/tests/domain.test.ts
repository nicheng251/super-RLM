
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canStart,
  deriveTaskStatus,
  isTerminalTicket,
  reportOutcome,
  ticketResult,
  ticketSummary,
} from "../src/domain.ts";
import type { SlotCounts, SlotPolicy, TicketRecord, TicketStatus } from "../src/domain.ts";

function tickets(...statuses: TicketStatus[]) {
  return statuses.map((status) => ({ status }));
}

test("task derivation follows the documented order", () => {
  assert.equal(deriveTaskStatus({ cancelled: true, timedOut: true, tickets: tickets("running") }), "cancelled");
  assert.equal(deriveTaskStatus({ cancelled: false, timedOut: true, tickets: tickets("running") }), "timed_out");
  assert.equal(deriveTaskStatus({ cancelled: false, timedOut: false, tickets: tickets("running", "queued") }), "running");
  assert.equal(deriveTaskStatus({ cancelled: false, timedOut: false, tickets: tickets("queued", "waiting") }), "queued");
  assert.equal(deriveTaskStatus({ cancelled: false, timedOut: false, tickets: tickets("waiting", "blocked") }), "waiting");
  assert.equal(deriveTaskStatus({ cancelled: false, timedOut: false, tickets: tickets("succeeded", "succeeded") }), "succeeded");
  assert.equal(deriveTaskStatus({ cancelled: false, timedOut: false, tickets: tickets("succeeded", "failed") }), "partial");
  assert.equal(deriveTaskStatus({ cancelled: false, timedOut: false, tickets: tickets("cancelled", "cancelled") }), "cancelled");
  assert.equal(deriveTaskStatus({ cancelled: false, timedOut: false, tickets: tickets("failed", "succeeded") }), "partial");
  assert.equal(deriveTaskStatus({ cancelled: false, timedOut: false, tickets: tickets("failed", "cancelled") }), "failed");
  assert.equal(deriveTaskStatus({ cancelled: false, timedOut: false, tickets: tickets("timed_out", "cancelled") }), "timed_out");
});

test("lost and queued tickets keep the task non-terminal", () => {
  assert.equal(isTerminalTicket("lost"), false);
  assert.equal(isTerminalTicket("queued"), false);
  assert.equal(isTerminalTicket("succeeded"), true);
  assert.equal(deriveTaskStatus({ cancelled: false, timedOut: false, tickets: tickets("lost") }), "queued");
});

test("report outcomes match the report protocol", () => {
  assert.equal(reportOutcome("progress"), null);
  assert.deepEqual(reportOutcome("waiting"), { ticketStatus: "waiting", endReason: "waiting" });
  assert.deepEqual(reportOutcome("blocked"), { ticketStatus: "blocked", endReason: "blocked" });
  assert.deepEqual(reportOutcome("completed"), { ticketStatus: "succeeded", endReason: "completed" });
  assert.deepEqual(reportOutcome("dropped"), {
    ticketStatus: "succeeded", endReason: "completed", outcome: "dropped", noOp: true,
  });
  assert.deepEqual(reportOutcome("failed"), { ticketStatus: "failed", endReason: "failed" });
  assert.deepEqual(reportOutcome("cancelled"), { ticketStatus: "cancelled", endReason: "cancelled" });
});

const policy: SlotPolicy = { globalMax: 4, perTaskMax: 2, priorityReserved: 1 };

function counts(overrides: Partial<SlotCounts> = {}): SlotCounts {
  return { totalRunning: 0, normalRunning: 0, priorityRunning: 0, taskNormalRunning: 0, ...overrides };
}

test("normal slots stop at the reserve boundary", () => {
  assert.equal(canStart("normal", counts(), policy, 0, 4), true);
  assert.equal(canStart("normal", counts({ totalRunning: 3, normalRunning: 3 }), policy, 0, 4), false);
  assert.equal(canStart("normal", counts({ totalRunning: 2, normalRunning: 2, taskNormalRunning: 2 }), policy, 0, 4), false);
  assert.equal(canStart("normal", counts({ totalRunning: 0 }), policy, 4, 4), false);
});

test("the priority slot is reserved but never doubled", () => {
  assert.equal(canStart("priority", counts({ totalRunning: 3, normalRunning: 3 }), policy, 0, 4), true);
  assert.equal(canStart("priority", counts({ totalRunning: 3, normalRunning: 3, priorityRunning: 1 }), policy, 0, 4), false);
  assert.equal(canStart("priority", counts({ totalRunning: 4, normalRunning: 3, priorityRunning: 1 }), policy, 0, 4), false);
});

function ticketRecord(ticketId: string): TicketRecord {
  return {
    ticket_id: ticketId,
    task_id: "tsk_1",
    title: "ticket",
    prompt: "do it",
    profile: "default",
    status: "succeeded",
    summary: "done",
    result: "ok",
    artifacts: [],
    usage: null,
    error: null,
    question: null,
    session_key: ticketId,
    session_ref: null,
    outcome: null,
    no_op: null,
    retry_count: 0,
    not_before: null,
    priority_next: false,
    resume_message: null,
    delivered_to: [],
    delivery_error: null,
    workspace_metadata: null,
    metadata_error: null,
    created_at: "2026-11-05T00:00:00Z",
    updated_at: "2026-11-05T00:00:01Z",
  };
}

test("ticket results expose the workspace under the configured root", () => {
  const root = mkdtempSync(join(tmpdir(), "super-rlm-workspaces-"));
  const result = ticketResult(ticketRecord("tkt_missing"), 20_000, root);
  assert.equal(result.workspace, join(root, "tkt_missing"));
  assert.equal(result.branch, null);
  assert.equal(result.commit, null);
  assert.equal(result.workspace_metadata, null);
  assert.equal(result.metadata_error, null);
});

test("ticket views return reported workspace metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "super-rlm-workspaces-"));
  const ticket = ticketRecord("tkt_meta");
  ticket.workspace_metadata = {
    vcs: "git",
    branch: "ticket/output",
    commit: "0123456789abcdef",
    files: 3,
  };
  ticket.metadata_error = "ignored extra metadata";

  const result = ticketResult(ticket, 20_000, root);
  assert.deepEqual(result.workspace_metadata, ticket.workspace_metadata);
  assert.equal(result.metadata_error, "ignored extra metadata");
  assert.equal(result.branch, "ticket/output");
  assert.equal(result.commit, "0123456789abcdef");

  const summary = ticketSummary(ticket, root);
  assert.deepEqual(summary.workspace_metadata, ticket.workspace_metadata);
  assert.equal(summary.metadata_error, "ignored extra metadata");
  assert.equal(summary.branch, "ticket/output");
  assert.equal(summary.commit, "0123456789abcdef");
});

test("non-git workspace metadata exposes no branch or commit", () => {
  const root = mkdtempSync(join(tmpdir(), "super-rlm-workspaces-"));
  const ticket = ticketRecord("tkt_plain");
  ticket.workspace_metadata = { vcs: "none", files: 2 };

  const result = ticketResult(ticket, 20_000, root);
  assert.deepEqual(result.workspace_metadata, { vcs: "none", files: 2 });
  assert.equal(result.branch, null);
  assert.equal(result.commit, null);
  assert.equal(ticketSummary(ticket, root).branch, null);
});

test("git metadata without branch and commit yields nulls", () => {
  const ticket = ticketRecord("tkt_git");
  ticket.workspace_metadata = { vcs: "git" };

  const result = ticketResult(ticket);
  assert.equal(result.branch, null);
  assert.equal(result.commit, null);
});
