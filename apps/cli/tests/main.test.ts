import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseCommand } from "../src/main.ts";

const mainEntry = join(import.meta.dirname, "..", "src", "main.ts");

function run(args: string[]) {
  return spawnSync(process.execPath, [mainEntry, ...args], {
    encoding: "utf8",
    env: { ...process.env, SUPER_RLM_HOME: mkdtempSync(join(tmpdir(), "super-rlm-main-")) },
  });
}

test("no arguments and 'tui' dispatch to the TUI stack", () => {
  assert.deepEqual(parseCommand([]), { command: "tui", rest: [] });
  assert.deepEqual(parseCommand(["tui"]), { command: "tui", rest: [] });
});

test("retired background and standalone Router commands are rejected", () => {
  for (const name of ["up", "router", "dev", "--no-services"]) {
    assert.deepEqual(parseCommand([name]), { command: "retired", rest: [], retired: name });
  }
  const response = run(["up"]);
  assert.equal(response.status, 1);
  assert.match(response.stderr, /'up' is no longer supported/);
  assert.match(response.stderr, /super-rlm down/);
});

test("maintenance commands keep their arguments", () => {
  assert.deepEqual(parseCommand(["status"]), { command: "status", rest: [] });
  assert.deepEqual(parseCommand(["setup", "--provider", "local", "--allow-missing-key"]), {
    command: "setup",
    rest: ["--provider", "local", "--allow-missing-key"],
  });
  assert.deepEqual(parseCommand(["down"]), { command: "down", rest: [] });
  assert.deepEqual(parseCommand(["artifacts", "tkt_1", "--all"]), {
    command: "artifacts",
    rest: ["tkt_1", "--all"],
  });
  assert.deepEqual(parseCommand(["help"]), { command: "help", rest: [] });
});

test("unknown flags are rejected without treating them as the TUI", () => {
  assert.deepEqual(parseCommand(["--no-services"]), { command: "retired", rest: [], retired: "--no-services" });
  assert.deepEqual(parseCommand(["--session", "x"]), { command: "unknown", rest: ["x"], name: "--session" });
});

test("help no longer lists background services or the standalone Router", () => {
  const response = run(["help"]);
  assert.equal(response.status, 0);
  assert.match(response.stdout, /super-rlm tui\s+Alias/);
  assert.match(response.stdout, /super-rlm down/);
  assert.match(response.stdout, /super-rlm setup \[--provider <name>\]/);
  assert.doesNotMatch(response.stdout, /super-rlm up\b/);
  assert.doesNotMatch(response.stdout, /super-rlm dev\b/);
  assert.doesNotMatch(response.stdout, /--no-services/);
  assert.doesNotMatch(response.stdout, /super-rlm \[router\]/);
});

test("status works with a freshly generated secrets file", () => {
  const home = mkdtempSync(join(tmpdir(), "super-rlm-main-status-"));
  const env: NodeJS.ProcessEnv = { ...process.env, SUPER_RLM_HOME: home };
  for (const key of ["SUPER_RLM_ROUTER_TOKEN", "SUPER_RLM_WORKER_TOKEN", "SUPER_RLM_CALLBACK_KEY"]) {
    delete env[key];
  }
  const response = spawnSync(process.execPath, [mainEntry, "status"], { encoding: "utf8", env });
  assert.equal(response.status, 0, response.stderr);
  assert.ok(existsSync(join(home, "secrets", "api.env")));
});

test("gc is listed in help and rejects unknown flags before touching the stack", () => {
  const help = run(["help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /super-rlm gc \[--apply\]/);

  const response = run(["gc", "--bogus"]);
  assert.equal(response.status, 1);
  assert.match(response.stderr, /super-rlm gc: unknown argument: --bogus/);
});

test("the config command prints redacted token and key fields", () => {
  const home = mkdtempSync(join(tmpdir(), "super-rlm-main-config-"));
  const response = spawnSync(process.execPath, [mainEntry, "config"], {
    encoding: "utf8",
    env: { ...process.env, SUPER_RLM_HOME: home },
  });
  assert.equal(response.status, 0);
  const parsed = JSON.parse(response.stdout) as Record<string, unknown>;
  assert.equal(parsed.routerToken, "[redacted]");
  assert.equal(parsed.workerToken, "[redacted]");
  assert.equal(parsed.callbackKey, "[redacted]");
  assert.doesNotMatch(response.stdout, /[0-9a-f]{64}/);
});

test("setup rejects unknown flags before touching the project", () => {
  const response = run(["setup", "--bogus"]);
  assert.equal(response.status, 1);
  assert.match(response.stderr, /super-rlm setup: unknown argument: --bogus/);
  assert.match(response.stderr, /Usage: super-rlm setup/);
});
