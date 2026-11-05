import assert from "node:assert/strict";
import test from "node:test";

import type { Event, TaskListItem } from "../../../packages/protocol/ts/index.ts";
import {
  addEvent,
  createState,
  setView,
  waitingTaskCount,
} from "../src/state.ts";

function task(index: number, waiting = 0): TaskListItem {
  return {
    task_id: `tsk_${index}`,
    status: waiting > 0 ? "waiting" : "running",
    prompt: `task ${index}`,
    ticket_count: 2,
    running_count: 1,
    waiting_count: waiting,
    created_at: "2026-11-04T00:00:00Z",
    updated_at: "2026-11-04T00:00:01Z",
  };
}

test("views keep waiting indicators and event unread counters", () => {
  const state = createState();
  const tasks = [task(0, 2), task(1, 1)];
  assert.equal(waitingTaskCount(tasks), 3);

  const event = (id: number): Event => ({
    event_id: id,
    type: "ticket.updated",
    ticket_id: "tkt_1",
    data: { status: "running" },
    created_at: "2026-11-04T00:00:00Z",
  });
  addEvent(state, event(1));
  addEvent(state, event(2));
  assert.equal(state.eventCursor, 2);
  assert.equal(state.unreadEvents, 2);

  setView(state, "events");
  assert.equal(state.unreadEvents, 0);
  setView(state, "tasks");
  assert.equal(state.previousView, "events");
  addEvent(state, event(3));
  assert.equal(state.unreadEvents, 1);
});

test("event history is capped at 200 and cursor tracks the maximum", () => {
  const state = createState();
  for (let index = 1; index <= 205; index += 1) {
    addEvent(state, {
      event_id: index,
      type: "task.updated",
      task_id: "tsk_0",
      data: {},
      created_at: "2026-11-04T00:00:00Z",
    });
  }
  assert.equal(state.events.length, 200);
  assert.equal(state.events[0].event_id, 6);
  assert.equal(state.eventCursor, 205);
});
