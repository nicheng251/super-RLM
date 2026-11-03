
import assert from "node:assert/strict";
import test from "node:test";

import {
  canStart,
  deriveTaskStatus,
  isTerminalTicket,
  reportOutcome,
} from "../src/domain.ts";
import type { SlotCounts, SlotPolicy, TicketStatus } from "../src/domain.ts";

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
