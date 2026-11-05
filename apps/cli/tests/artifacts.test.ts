import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { copyTicketArtifacts, runArtifacts } from "../src/commands/artifacts.ts";
import { loadConfig } from "../src/config.ts";

function fixture(): { config: ReturnType<typeof loadConfig>; workspaceRoot: string; workspace: string } {
  const home = mkdtempSync(join(tmpdir(), "super-rlm-home-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "super-rlm-workspaces-"));
  const workspace = join(workspaceRoot, "tkt_1");
  mkdirSync(join(workspace, "nested"), { recursive: true });
  writeFileSync(join(workspace, "out.md"), "result\n");
  writeFileSync(join(workspace, "nested", "report.json"), "{\"ok\":true}\n");
  writeFileSync(join(workspace, ".super-rlm-report.json"), "{\"token\":\"secret\"}");
  writeFileSync(join(workspace, ".super-rlm-prepared"), "{}");
  mkdirSync(join(workspace, ".super-rlm-bin"));
  writeFileSync(join(workspace, ".super-rlm-bin", "npm"), "#!/bin/sh\nexit 127\n");
  const config = loadConfig({
    env: { SUPER_RLM_HOME: home, SUPER_RLM_WORKSPACES: workspaceRoot },
    cwd: tmpdir(),
  });
  return { config, workspaceRoot, workspace };
}

test("copyTicketArtifacts copies files and nested artifacts", () => {
  const { config } = fixture();
  const destination = mkdtempSync(join(tmpdir(), "super-rlm-copy-"));
  const result = {
    artifacts: [
      { type: "file" as const, path: "out.md" },
      { type: "file" as const, path: "nested/report.json" },
    ],
    workspace_metadata: { vcs: "none", files: 2 },
    metadata_error: "optional metadata warning",
  };

  const copy = copyTicketArtifacts(config, "tkt_1", result, destination);
  assert.equal(copy.files, 2);
  assert.deepEqual(copy.workspace_metadata, { vcs: "none", files: 2 });
  assert.equal(copy.metadata_error, "optional metadata warning");
  assert.ok(existsSync(join(destination, "out.md")));
  assert.ok(existsSync(join(destination, "nested", "report.json")));
  assert.deepEqual(copy.copied, [
    join(destination, "out.md"),
    join(destination, "nested", "report.json"),
  ]);
});

test("copyTicketArtifacts refuses traversal and absolute artifact paths", () => {
  const { config } = fixture();
  const destination = mkdtempSync(join(tmpdir(), "super-rlm-copy-"));
  assert.throws(
    () => copyTicketArtifacts(config, "tkt_1", { artifacts: [{ type: "file", path: "../escape.txt" }] }, destination),
    /unsafe artifact path/,
  );
  assert.throws(
    () => copyTicketArtifacts(config, "tkt_1", { artifacts: [{ type: "file", path: "/tmp/escape.txt" }] }, destination),
    /unsafe artifact path/,
  );
});


test("copyTicketArtifacts falls back to the prepared repo checkout", () => {
  const home = mkdtempSync(join(tmpdir(), "super-rlm-home-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "super-rlm-workspaces-"));
  const workspace = join(workspaceRoot, "tkt_repo");
  mkdirSync(join(workspace, "repo", ".git"), { recursive: true });
  writeFileSync(join(workspace, "repo", "out.md"), "nested result\n");
  const config = loadConfig({
    env: { SUPER_RLM_HOME: home, SUPER_RLM_WORKSPACES: workspaceRoot },
    cwd: tmpdir(),
  });
  const destination = mkdtempSync(join(tmpdir(), "super-rlm-copy-"));

  const copy = copyTicketArtifacts(config, "tkt_repo", { artifacts: [{ type: "file", path: "out.md" }] }, destination);

  assert.equal(copy.files, 1);
  assert.ok(existsSync(join(destination, "out.md")));
});

test("copyTicketArtifacts --all copies the whole workspace", () => {
  const { config } = fixture();
  const destination = mkdtempSync(join(tmpdir(), "super-rlm-copy-"));
  const copy = copyTicketArtifacts(config, "tkt_1", { artifacts: [] }, destination, { all: true });
  const root = join(destination, "tkt_1");

  assert.equal(copy.destination, root);
  assert.equal(copy.files, 2);
  assert.equal(copy.workspace_metadata, null);
  assert.equal(copy.metadata_error, null);
  assert.ok(existsSync(join(root, "out.md")));
  assert.ok(existsSync(join(root, "nested", "report.json")));
  assert.equal(existsSync(join(root, ".super-rlm-report.json")), false);
  assert.equal(existsSync(join(root, ".super-rlm-prepared")), false);
  assert.equal(existsSync(join(root, ".super-rlm-bin")), false);
});

test("copyTicketArtifacts rejects a ticket without artifacts unless --all is set", () => {
  const { config } = fixture();
  const destination = mkdtempSync(join(tmpdir(), "super-rlm-copy-"));
  assert.throws(
    () => copyTicketArtifacts(config, "tkt_1", { artifacts: [] }, destination),
    /has no artifacts.*--all/,
  );
});

test("runArtifacts reads the Ticket result and copies its artifacts", async () => {
  const { config } = fixture();
  const destination = mkdtempSync(join(tmpdir(), "super-rlm-copy-"));
  const originalFetch = globalThis.fetch;
  let requested = "";
  let authorization = "";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requested = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({
      ticket_id: "tkt_1",
      status: "succeeded",
      artifacts: [{ type: "file", path: "out.md" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    assert.equal(await runArtifacts(config, "tkt_1", { to: destination }), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requested, `${config.orchestratorUrl}/v1/tickets/tkt_1/result`);
  assert.equal(authorization, `Bearer ${config.routerToken}`);
  assert.ok(existsSync(join(destination, "out.md")));
});
