
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { OrchestratorClient } from "../src/client.ts";
import { TaskDetailPageModel, TasksPageModel } from "../src/page-model.ts";

function taskList() {
  return {
    tasks: [{
      task_id: "tsk_1", status: "running", prompt: "do it", ticket_count: 1,
      running_count: 1, waiting_count: 0, created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:01Z",
    }],
    next_cursor: null,
  };
}

function taskView() {
  return {
    task_id: "tsk_1", status: "waiting", prompt: "do it",
    created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:01Z",
    tickets: [{
      ticket_id: "tkt_1", title: "ticket", status: "waiting", profile: "default",
      summary: "need input", question: { kind: "waiting", text: "Which platform?" },
      error: null, outcome: null, no_op: null,
    }],
  };
}

test("page models load tasks and details through the Orchestrator client", async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const body = req.url?.startsWith("/v1/tasks/") ? taskView() : taskList();
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(200, { "content-type": "application/json", "content-length": String(data.length) });
    res.end(data);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new OrchestratorClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: "token" });
  try {
    const tasks = new TasksPageModel(client);
    await tasks.load();
    assert.equal(tasks.state.tasks.length, 1);
    assert.equal(tasks.selectedTask()?.task_id, "tsk_1");

    const detail = new TaskDetailPageModel(client, "tsk_1");
    await detail.load();
    assert.equal(detail.state.task?.status, "waiting");
    assert.equal(detail.selectedTicket()?.ticket_id, "tkt_1");
    assert.equal(detail.selectedTicket()?.question?.text, "Which platform?");
    assert.deepEqual(requests, ["GET /v1/tasks?limit=20", "GET /v1/tasks/tsk_1"]);
  } finally {
    server.close();
  }
});

test("task selection is clamped", () => {
  const client = new OrchestratorClient({ baseUrl: "http://127.0.0.1:1", token: "token" });
  const model = new TasksPageModel(client);
  model.state.tasks = taskList().tasks as never;
  model.move(10);
  assert.equal(model.state.selected, 0);
  model.state.selected = 0;
  model.move(1);
  assert.equal(model.state.selected, 0);
});
