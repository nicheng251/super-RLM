
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    capabilities: [code, script, docs]
    requires_repo: false
    read_only: false
    write_files: true
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
    capabilities: [code, git]
    requires_repo: true
    read_only: false
    write_files: true
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
  const parsed = JSON.parse(json.stdout.join("\n")) as Array<{
    name: string;
    provider: string;
    capabilities: string[];
    requires_repo: boolean;
    read_only: boolean;
    write_files: boolean;
  }>;
  assert.deepEqual(parsed.map((profile) => profile.name), ["default", "git"]);
  assert.equal(parsed[0].provider, "deepseek");
  assert.deepEqual(parsed[0].capabilities, ["code", "script", "docs"]);
  assert.equal(parsed[0].requires_repo, false);
  assert.equal(parsed[1].requires_repo, true);
  assert.equal(parsed[1].read_only, false);
  assert.equal(parsed[1].write_files, true);
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
  assert.match(output, /capabilities:\s+code, git/);
  assert.match(output, /requires_repo:\s+true/);
  assert.match(output, /read_only:\s+false/);
  assert.match(output, /write_files:\s+true/);

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

test("profiles reset removes one override or all overrides", () => {
  const directory = mkdtempSync(join(tmpdir(), "super-rlm-cli-overrides-"));
  const overridesPath = join(directory, "profiles.overrides.json");
  writeFileSync(overridesPath, JSON.stringify({
    default: { provider: "p", model: "m", thinking: "low" },
    git: { thinking: "high" },
  }), "utf8");
  const config = { repoRoot: join(directory, "no-such-repo"), home: directory } as CliConfig;
  const env = { SUPER_RLM_PROFILE_OVERRIDES: overridesPath };

  // Reset does not read config/profiles.yaml, so a stale or missing YAML does not block it.
  const single = capture(() => runProfiles(config, ["reset", "default"], { env }));
  assert.equal(single.code, 0);
  assert.match(single.stdout.join("\n"), /removed overrides for default/);
  assert.match(single.stdout.join("\n"), /config\/profiles\.yaml/);
  assert.deepEqual(JSON.parse(readFileSync(overridesPath, "utf8")), { git: { thinking: "high" } });

  const missing = capture(() => runProfiles(config, ["reset", "missing"], { env }));
  assert.equal(missing.code, 0);
  assert.match(missing.stdout.join("\n"), /no override for missing/);

  const all = capture(() => runProfiles(config, ["reset", "--all"], { env }));
  assert.equal(all.code, 0);
  assert.match(all.stdout.join("\n"), /removed overrides for git/);
  assert.equal(existsSync(overridesPath), false);

  const again = capture(() => runProfiles(config, ["reset", "--all"], { env }));
  assert.equal(again.code, 0);
  assert.match(again.stdout.join("\n"), /no overrides file/);
});

test("profiles reset rejects ambiguous arguments and reports malformed files", () => {
  const directory = mkdtempSync(join(tmpdir(), "super-rlm-cli-overrides-bad-"));
  const overridesPath = join(directory, "profiles.overrides.json");
  writeFileSync(overridesPath, "{ not json", "utf8");
  const config = { repoRoot: directory, home: directory } as CliConfig;
  const env = { SUPER_RLM_PROFILE_OVERRIDES: overridesPath };

  const malformed = capture(() => runProfiles(config, ["reset", "default"], { env }));
  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr.join("\n"), /malformed JSON/);
  assert.equal(readFileSync(overridesPath, "utf8"), "{ not json");

  const ambiguous = capture(() => runProfiles(config, ["reset", "default", "--all"], { env }));
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr.join("\n"), /use either a profile name or --all/);

  const noName = capture(() => runProfiles(config, ["reset"], { env }));
  assert.equal(noName.code, 1);
  assert.match(noName.stderr.join("\n"), /super-rlm profiles reset <name>\|--all/);

  // --all is the repair path for a malformed file.
  const repaired = capture(() => runProfiles(config, ["reset", "--all"], { env }));
  assert.equal(repaired.code, 0);
  assert.equal(existsSync(overridesPath), false);
});
