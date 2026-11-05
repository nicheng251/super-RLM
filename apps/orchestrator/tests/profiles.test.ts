
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { Orchestrator, OrchestratorError } from "../src/orchestrator.ts";
import type { DispatchFn } from "../src/orchestrator.ts";
import { defaultProfilesPath, loadProfiles, profileExecution, profileSummaries, updateProfile } from "../src/profiles.ts";
import { createOrchestratorServer, serverAddress } from "../src/server.ts";
import { testEnv } from "./env.ts";
import type { ExecutionRequest } from "../../../packages/protocol/ts/index.ts";

function writeProfiles(yaml: string): string {
  const directory = mkdtempSync(join(tmpdir(), "super-rlm-profiles-"));
  const path = join(directory, "profiles.yaml");
  writeFileSync(path, yaml, "utf8");
  return path;
}

test("config reads the project repository from the environment", () => {
  assert.equal(loadConfig(testEnv()).projectRepo, null);
  assert.equal(loadConfig(testEnv({ SUPER_RLM_PROJECT_REPO: "   " })).projectRepo, null);
  assert.equal(loadConfig(testEnv({ SUPER_RLM_PROJECT_REPO: " /tmp/repo " })).projectRepo, "/tmp/repo");
});

test("loads the repository profiles and resolves execution options", () => {
  const profiles = loadProfiles(defaultProfilesPath());
  assert.deepEqual(Object.keys(profiles.profiles).sort(), ["default", "git", "reviewer"]);

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
  assert.deepEqual(profiles.profiles.default.capabilities, ["code", "script", "docs"]);
  assert.equal(profiles.profiles.default.requires_repo, false);
  assert.equal(profiles.profiles.default.read_only, false);
  assert.equal(profiles.profiles.default.write_files, true);

  const gitExecution = profileExecution(profiles.profiles.git);
  assert.equal(gitExecution.workspace.agent_cwd, "repo");
  assert.match(gitExecution.prepare_command ?? "", /SUPER_RLM_PROJECT_REPO/);
  assert.match(gitExecution.prepare_command ?? "", /worktree add/);
  assert.deepEqual(gitExecution.blocked_commands, ["git", "gh"]);
  assert.match(gitExecution.workspace.metadata_command ?? "", /rev-parse/);
  assert.match(gitExecution.workspace.metadata_command ?? "", /"vcs":"git"/);
  assert.equal(gitExecution.delivery.mode, "none");
  assert.deepEqual(profiles.profiles.git.capabilities, ["code", "git", "refactor"]);
  assert.equal(profiles.profiles.git.requires_repo, true);
  assert.equal(profiles.profiles.git.read_only, false);
  assert.equal(profiles.profiles.git.write_files, true);

  const reviewer = profiles.profiles.reviewer;
  assert.equal(reviewer.thinking, "high");
  assert.equal(reviewer.timeout_s, 1800);
  assert.deepEqual(reviewer.capabilities, ["review", "analysis"]);
  assert.equal(reviewer.requires_repo, true);
  assert.equal(reviewer.read_only, true);
  assert.equal(reviewer.write_files, false);
  assert.match(reviewer.prepare_command ?? "", /worktree add/);
  assert.deepEqual(reviewer.blocked_commands, ["git", "gh"]);
  assert.equal(reviewer.delivery.mode, "none");

  const summaries = profileSummaries(profiles);
  assert.deepEqual(summaries.map((profile) => profile.name), ["default", "git", "reviewer"]);
  for (const summary of summaries) {
    assert.deepEqual(
      Object.keys(summary).sort(),
      [
        "capabilities", "description", "model", "name", "provider",
        "read_only", "requires_repo", "thinking", "write_files",
      ],
    );
  }
  assert.deepEqual(summaries[0].capabilities, ["code", "script", "docs"]);
  assert.equal(summaries[1].requires_repo, true);
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
    [`profiles:
  default:
    provider: p
    model: m
    read_only: true
    write_files: true
`, /default cannot be both read_only and write_files/],
    [`profiles:
  default:
    provider: p
    model: m
    capabilities: [code, code]
`, /default\.capabilities\[1\] duplicates code/],
    [`profiles:
  default:
    provider: p
    model: m
    requires_repo: "yes"
`, /default\.requires_repo must be a boolean/],
    [`profiles:
  default:
    provider: p
    model: m
    capabilities: code
`, /default\.capabilities must be an array/],
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
    projectRepo: "/tmp/super-rlm/repo",
    callbackUrl: null,
    callbackKey: "test-callback-key",
    profiles,
  }, dispatch);
  orchestrator.registerWorker({
    worker_id: "wrk_profiles",
    url: "http://fake-worker",
    max_concurrency: 4,
    version: "test",
  });
  const profileList = profileSummaries(profiles);
  const server = createOrchestratorServer(orchestrator, {
    routerToken: "router-token",
    workerToken: "worker-token",
    callbackKey: "callback-key",
    profiles: profileList,
    updateProfile: (name, patch) => {
      const updated = updateProfile(profiles, name, patch);
      const index = profileList.findIndex((profile) => profile.name === name);
      if (index >= 0) profileList[index] = updated;
      return updated;
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${serverAddress(server).port}`;
  const headers = { "content-type": "application/json", authorization: "Bearer router-token" };
  try {
    const listed = await fetch(`${base}/v1/profiles`, { headers });
    assert.equal(listed.status, 200);
    const body = await listed.json() as { profiles: Array<Record<string, unknown>> };
    assert.deepEqual(body.profiles.map((profile) => profile.name), ["default", "git", "reviewer"]);
    assert.equal(body.profiles[0].provider, "deepseek");
    assert.deepEqual(body.profiles[0].capabilities, ["code", "script", "docs"]);
    assert.equal(body.profiles[1].requires_repo, true);
    assert.equal(body.profiles[2].read_only, true);
    assert.equal(body.profiles[2].write_files, false);
    assert.equal("prepare_command" in body.profiles[1], false);
    assert.equal("blocked_commands" in body.profiles[1], false);

    const patched = await fetch(`${base}/v1/profiles/git`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ thinking: "high" }),
    });
    assert.equal(patched.status, 200);
    const patchedBody = await patched.json() as { thinking: string };
    assert.equal(patchedBody.thinking, "high");

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
    assert.equal(git.execution?.thinking, "high");
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
    projectRepo: null,
    callbackUrl: null,
    callbackKey: "test-callback-key",
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

test("requires_repo profiles need a configured project repository", async () => {
  const profiles = loadProfiles(defaultProfilesPath());
  const dispatch: DispatchFn = async (_worker, request) => ({
    ok: true,
    executionId: `exe_${request.ticket_id}`,
  });
  const build = (projectRepo: string | null, workerId: string) => {
    const store = new Store(":memory:");
    const orchestrator = new Orchestrator(store, {
      maxConcurrentTickets: 4,
      maxConcurrentTicketsPerTask: 2,
      priorityReserved: 1,
      workerLeaseMs: 30_000,
      dispatchTimeoutMs: 1000,
      workspaceRoot: "/tmp/super-rlm/workspaces",
      projectRepo,
      callbackUrl: null,
      callbackKey: "test-callback-key",
      profiles,
    }, dispatch);
    orchestrator.registerWorker({
      worker_id: workerId,
      url: "http://fake-worker",
      max_concurrency: 4,
      version: "test",
    });
    return { store, orchestrator };
  };

  const missing = build(null, "wrk_no_repo");
  try {
    await assert.rejects(
      missing.orchestrator.createTask({
        prompt: "review",
        tickets: [{ title: "review", prompt: "review the change", profile: "reviewer" }],
      }),
      (error: unknown) => error instanceof OrchestratorError && error.code === "profile_requires_repo",
    );
  } finally {
    missing.store.close();
  }

  const present = build("/tmp/super-rlm/repo", "wrk_repo");
  try {
    const created = await present.orchestrator.createTask({
      prompt: "review",
      tickets: [{ title: "review", prompt: "review the change", profile: "reviewer" }],
    });
    const view = present.orchestrator.getTask(created.task_id);
    assert.equal(view.tickets[0].profile, "reviewer");
    assert.equal(view.tickets[0].status, "running");
  } finally {
    present.store.close();
  }
});
