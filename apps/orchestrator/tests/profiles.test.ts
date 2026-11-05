
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Store } from "../src/db.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import type { DispatchFn } from "../src/orchestrator.ts";
import { defaultProfilesPath, loadProfiles, profileExecution, profileSummaries } from "../src/profiles.ts";
import { createOrchestratorServer, serverAddress } from "../src/server.ts";
import type { ExecutionRequest } from "../../../packages/protocol/ts/index.ts";

function writeProfiles(yaml: string): string {
  const directory = mkdtempSync(join(tmpdir(), "super-rlm-profiles-"));
  const path = join(directory, "profiles.yaml");
  writeFileSync(path, yaml, "utf8");
  return path;
}

test("loads the repository profiles and resolves execution options", () => {
  const profiles = loadProfiles(defaultProfilesPath());
  assert.deepEqual(Object.keys(profiles.profiles).sort(), ["default", "git"]);

  const defaultExecution = profileExecution(profiles.profiles.default);
  assert.equal(defaultExecution.provider, "deepseek");
  assert.equal(defaultExecution.model, "deepseek-flash");
  assert.equal(defaultExecution.thinking, "medium");
  assert.equal(defaultExecution.timeout_s, 3600);
  assert.equal(defaultExecution.prepare_command, null);
  assert.deepEqual(defaultExecution.blocked_commands, []);
  assert.equal(defaultExecution.workspace.agent_cwd, ".");
  assert.equal(defaultExecution.workspace.artifact_root, ".");
  assert.equal(defaultExecution.workspace.metadata_command, null);
  assert.equal(defaultExecution.delivery.mode, "artifacts");
  assert.equal(defaultExecution.delivery.collision, "version");

  const gitExecution = profileExecution(profiles.profiles.git);
  assert.equal(gitExecution.workspace.agent_cwd, "repo");
  assert.match(gitExecution.prepare_command ?? "", /SUPER_RLM_PROJECT_REPO/);
  assert.match(gitExecution.prepare_command ?? "", /worktree add/);
  assert.deepEqual(gitExecution.blocked_commands, ["git", "gh"]);
  assert.match(gitExecution.workspace.metadata_command ?? "", /rev-parse/);
  assert.match(gitExecution.workspace.metadata_command ?? "", /"vcs":"git"/);
  assert.equal(gitExecution.delivery.mode, "none");

  const summaries = profileSummaries(profiles);
  assert.deepEqual(summaries.map((profile) => profile.name), ["default", "git"]);
  for (const summary of summaries) {
    assert.deepEqual(
      Object.keys(summary).sort(),
      ["description", "model", "name", "provider", "thinking"],
    );
  }
});

test("rejects invalid profile files", () => {
  const cases: Array<[string, RegExp]> = [
    [`profiles:
  other:
    provider: p
    model: m
`, /default profile is required/],
    [`profiles:
  - name: default
    provider: p
    model: m
  - name: default
    provider: p
    model: m
`, /duplicate profile name: default/],
    [`profiles:
  default:
    provider: p
    model: ""
`, /default\.model must be a non-empty string/],
    [`profiles:
  default:
    provider: p
    model: m
    thinking: maximal
`, /default\.thinking must be one of/],
    [`profiles:
  default:
    provider: p
    model: m
    timeout_s: 0
`, /timeout_s must be a positive integer/],
    [`profiles:
  default:
    provider: p
    model: m
    workspace:
      agent_cwd: ../escape
`, /agent_cwd must not contain '\.\.'/],
    [`profiles:
  default:
    provider: p
    model: m
    workspace:
      artifact_root: /tmp/out
`, /artifact_root must be relative/],
    [`profiles:
  default:
    provider: p
    model: m
    blocked_commands: ["rm -rf /"]
`, /blocked_commands\[0\] must be a simple command name/],
    [`profiles:
  default:
    provider: p
    model: m
    delivery:
      mode: copy
`, /delivery\.mode must be one of/],
    [`profiles:
  default:
    provider: p
    model: m
    delivery:
      collision: replace
`, /delivery\.collision must be one of/],
    [`default:
  provider: deepseek
  model: deepseek-flash
`, /profiles must be a mapping/],
  ];
  for (const [yaml, pattern] of cases) {
    assert.throws(() => loadProfiles(writeProfiles(yaml)), pattern);
  }
});

test("HTTP profiles, unknown profile rejection, and dispatch execution options", async () => {
  const calls: ExecutionRequest[] = [];
  const dispatch: DispatchFn = async (_worker, request) => {
    calls.push(request);
    return { ok: true, executionId: `exe_${calls.length}` };
  };
  const profiles = loadProfiles(defaultProfilesPath());
  const store = new Store(":memory:");
  const orchestrator = new Orchestrator(store, {
    maxConcurrentTickets: 4,
    maxConcurrentTicketsPerTask: 2,
    priorityReserved: 1,
    workerLeaseMs: 30_000,
    dispatchTimeoutMs: 1000,
    workspaceRoot: "/tmp/super-rlm/workspaces",
    profiles,
  }, dispatch);
  orchestrator.registerWorker({
    worker_id: "wrk_profiles",
    url: "http://fake-worker",
    max_concurrency: 4,
    version: "test",
  });
  const server = createOrchestratorServer(orchestrator, {
    routerToken: "router-token",
    workerToken: "worker-token",
    callbackKey: "callback-key",
    profiles: profileSummaries(profiles),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${serverAddress(server).port}`;
  const headers = { "content-type": "application/json", authorization: "Bearer router-token" };
  try {
    const listed = await fetch(`${base}/v1/profiles`, { headers });
    assert.equal(listed.status, 200);
    const body = await listed.json() as { profiles: Array<Record<string, unknown>> };
    assert.deepEqual(body.profiles.map((profile) => profile.name), ["default", "git"]);
    assert.equal(body.profiles[0].provider, "deepseek");
    assert.equal("prepare_command" in body.profiles[1], false);
    assert.equal("blocked_commands" in body.profiles[1], false);

    const unknown = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "unknown profile",
        tickets: [{ title: "x", prompt: "do it", profile: "missing" }],
      }),
    });
    assert.equal(unknown.status, 400);
    const unknownBody = await unknown.json() as { error: { code: string } };
    assert.equal(unknownBody.error.code, "unknown_profile");

    const created = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "profiles",
        tickets: [
          { title: "plain", prompt: "plain work", profile: "default" },
          { title: "git work", prompt: "git work", profile: "git" },
        ],
      }),
    });
    assert.equal(created.status, 201);
    assert.equal(calls.length, 2);

    const plain = calls.find((request) => request.profile === "default");
    assert.ok(plain);
    assert.equal(plain.execution?.workspace.agent_cwd, ".");
    assert.equal(plain.execution?.delivery.mode, "artifacts");

    const git = calls.find((request) => request.profile === "git");
    assert.ok(git);
    assert.equal(git.execution?.provider, "deepseek");
    assert.equal(git.execution?.model, "deepseek-flash");
    assert.equal(git.execution?.workspace.agent_cwd, "repo");
    assert.equal(git.execution?.delivery.mode, "none");
    assert.match(git.execution?.workspace.metadata_command ?? "", /rev-parse/);
  } finally {
    server.close();
    store.close();
  }
});

test("an Orchestrator without profiles keeps the legacy env fallback", async () => {
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
    worker_id: "wrk_legacy",
    url: "http://fake-worker",
    max_concurrency: 4,
    version: "test",
  });
  try {
    const created = await orchestrator.createTask({
      prompt: "legacy",
      tickets: [{ title: "legacy", prompt: "run legacy", profile: "custom" }],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].profile, "custom");
    assert.equal(calls[0].execution, undefined);
    assert.equal(orchestrator.getTask(created.task_id).status, "running");
  } finally {
    store.close();
  }
});
