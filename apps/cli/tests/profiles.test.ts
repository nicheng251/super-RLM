
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runProfiles } from "../src/commands/profiles.ts";
import type { CliConfig } from "../src/config.ts";

function profilesFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "super-rlm-cli-profiles-"));
  const path = join(directory, "profiles.yaml");
  writeFileSync(path, `profiles:
  default:
    description: General-purpose worker
    provider: deepseek
    model: deepseek-flash
    thinking: medium
    timeout_s: 3600
    workspace:
      agent_cwd: "."
      artifact_root: "."
    delivery:
      mode: artifacts
      collision: version
  git:
    description: Git worktree
    provider: deepseek
    model: deepseek-flash
    thinking: high
    timeout_s: 7200
    blocked_commands: [git]
    workspace:
      agent_cwd: repo
      artifact_root: "."
      metadata_command: "git rev-parse HEAD"
    delivery:
      mode: none
`, "utf8");
  return path;
}

function config(repoRoot: string): CliConfig {
  return { repoRoot } as CliConfig;
}

function capture(run: () => number): { code: number; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(" ")); };
  try {
    return { code: run(), stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("profiles validate and list read the file directly", () => {
  const path = profilesFile();
  const validate = capture(() => runProfiles(config("unused"), ["validate", "--config", path]));
  assert.equal(validate.code, 0);
  assert.match(validate.stdout.join("\n"), /valid: default, git/);

  const list = capture(() => runProfiles(config("unused"), ["list", "--config", path]));
  assert.equal(list.code, 0);
  const output = list.stdout.join("\n");
  assert.match(output, /default\s+deepseek\/deepseek-flash\s+medium\s+General-purpose worker/);
  assert.match(output, /git\s+deepseek\/deepseek-flash\s+high\s+Git worktree/);

  const json = capture(() => runProfiles(config("unused"), ["list", "--json", "--config", path]));
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.stdout.join("\n")) as Array<{ name: string; provider: string }>;
  assert.deepEqual(parsed.map((profile) => profile.name), ["default", "git"]);
  assert.equal(parsed[0].provider, "deepseek");
});

test("profiles show prints one profile and rejects an unknown name", () => {
  const path = profilesFile();
  const show = capture(() => runProfiles(config("unused"), ["show", "git", "--config", path]));
  assert.equal(show.code, 0);
  const output = show.stdout.join("\n");
  assert.match(output, /model:\s+deepseek-flash/);
  assert.match(output, /workspace\.agent_cwd:\s+repo/);
  assert.match(output, /delivery\.mode:\s+none/);
  assert.match(output, /blocked_commands:\s+git/);

  const json = capture(() => runProfiles(config("unused"), ["show", "git", "--json", "--config", path]));
  const profile = JSON.parse(json.stdout.join("\n")) as { name: string; workspace: { agent_cwd: string } };
  assert.equal(profile.name, "git");
  assert.equal(profile.workspace.agent_cwd, "repo");

  const missing = capture(() => runProfiles(config("unused"), ["show", "missing", "--config", path]));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr.join("\n"), /unknown profile: missing/);
});

test("profiles uses SUPER_RLM_PROFILES_CONFIG and reports invalid files", () => {
  const path = profilesFile();
  const viaEnv = capture(() => runProfiles(config("/does/not/exist"), ["list"], {
    env: { SUPER_RLM_PROFILES_CONFIG: path },
  }));
  assert.equal(viaEnv.code, 0);
  assert.match(viaEnv.stdout.join("\n"), /default/);

  const directory = mkdtempSync(join(tmpdir(), "super-rlm-cli-profiles-bad-"));
  const broken = join(directory, "profiles.yaml");
  writeFileSync(broken, "profiles:\n  other:\n    provider: p\n    model: m\n", "utf8");
  const invalid = capture(() => runProfiles(config(directory), ["validate", "--config", broken]));
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr.join("\n"), /default profile is required/);
});
