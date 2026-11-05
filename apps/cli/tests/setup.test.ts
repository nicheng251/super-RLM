import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findRepoRoot, loadConfig } from "../src/config.ts";
import {
  parseSetupArgs,
  providerKeyPresent,
  providerKeyVariable,
  runSetup,
} from "../src/commands/setup.ts";

function writeModels(dir: string): string {
  const path = join(dir, "models.yaml");
  writeFileSync(path, `default:
  provider: local
  model: local-model
providers:
  local:
    name: Local
    api: openai-completions
    baseUrl: http://127.0.0.1:8000/v1
    apiKey: $LOCAL_API_KEY
    models:
      - id: local-model
        name: Local Model
  literal:
    name: Literal
    api: openai-completions
    apiKey: sk-literal
    models:
      - id: literal-model
`);
  return path;
}

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const warns: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
  return {
    logs,
    errors,
    warns,
    restore() {
      console.log = original.log;
      console.error = original.error;
      console.warn = original.warn;
    },
  };
}

test("parseSetupArgs accepts the documented flags", () => {
  assert.deepEqual(parseSetupArgs(["--provider", "deepseek", "--model", "deepseek-flash", "--allow-missing-key"]), {
    provider: "deepseek",
    model: "deepseek-flash",
    allowMissingKey: true,
    help: false,
  });
  assert.deepEqual(parseSetupArgs(["--provider=local", "--model=local-model"]), {
    provider: "local",
    model: "local-model",
    allowMissingKey: false,
    help: false,
  });
  const help = parseSetupArgs(["--help"]);
  assert.ok("help" in help && help.help);
  assert.match((parseSetupArgs(["--bogus"]) as { error: string }).error, /unknown argument: --bogus/);
  assert.match((parseSetupArgs(["--provider"]) as { error: string }).error, /--provider requires a value/);
  assert.match((parseSetupArgs(["--provider", "--model"]) as { error: string }).error, /--provider requires a value/);
});

test("providerKeyVariable follows the provider apiKey reference", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-rlm-setup-models-"));
  const path = writeModels(dir);
  assert.equal(providerKeyVariable(path, "local", "local-model"), "LOCAL_API_KEY");
  assert.equal(providerKeyVariable(path, "literal", "literal-model"), null);
  assert.throws(() => providerKeyVariable(path, "missing"), /provider 'missing' is not defined/);
  assert.throws(() => providerKeyVariable(path, "local", "missing-model"), /pass --model <id>/);
});

test("providerKeyPresent reads the providers env file but accepts a process value", () => {
  const home = mkdtempSync(join(tmpdir(), "super-rlm-setup-home-"));
  mkdirSync(join(home, "secrets"), { recursive: true });
  writeFileSync(join(home, "secrets", "providers.env"), "# comment\nLOCAL_API_KEY=file-key\n");
  assert.equal(providerKeyPresent(home, "LOCAL_API_KEY", {}), true);
  assert.equal(providerKeyPresent(home, "OTHER_KEY", {}), false);
  assert.equal(providerKeyPresent(home, "OTHER_KEY", { OTHER_KEY: "env-key" }), true);
});

test("setup creates the marker, bootstraps, syncs models, and runs doctor", async () => {
  const project = mkdtempSync(join(tmpdir(), "super-rlm-setup-project-"));
  const home = mkdtempSync(join(tmpdir(), "super-rlm-setup-home-"));
  const models = writeModels(home);
  mkdirSync(join(home, "secrets"), { recursive: true });
  writeFileSync(join(home, "secrets", "providers.env"), "LOCAL_API_KEY=abc\n");

  const events: string[] = [];
  const captured = captureConsole();
  try {
    const code = await runSetup([], {
      cwd: project,
      env: { SUPER_RLM_HOME: home, SUPER_RLM_MODELS_CONFIG: models },
      uvCheck: (path) => {
        assert.ok(path.endsWith("uv.exe") || path.endsWith("uv"));
        return true;
      },
      bootstrap: async (config) => {
        events.push("bootstrap");
        assert.equal(config.home, home);
        assert.equal(config.primeProvider, "local");
        return 0;
      },
      sync: (config) => {
        events.push("sync");
        assert.equal(config.home, home);
        return 0;
      },
      doctor: async () => {
        events.push("doctor");
        return 0;
      },
    });
    assert.equal(code, 0);
  } finally {
    captured.restore();
  }
  assert.deepEqual(events, ["bootstrap", "sync", "doctor"]);
  assert.ok(existsSync(join(project, ".super-rlm-project.json")));
  assert.match(readFileSync(join(project, ".gitignore"), "utf8"), /\.super-rlm-project\.json/);
  assert.match(captured.logs.join("\n"), /Next: run `super-rlm` from this project\./);
});

test("--provider/--model select the checked provider and a literal key needs no file", async () => {
  const project = mkdtempSync(join(tmpdir(), "super-rlm-setup-project-"));
  const home = mkdtempSync(join(tmpdir(), "super-rlm-setup-home-"));
  const models = writeModels(home);
  let selected: { provider: string; model: string } | null = null;

  const captured = captureConsole();
  try {
    const code = await runSetup(["--provider", "literal", "--model", "literal-model"], {
      cwd: project,
      env: { SUPER_RLM_HOME: home, SUPER_RLM_MODELS_CONFIG: models },
      uvCheck: () => true,
      bootstrap: async (config) => {
        selected = { provider: config.primeProvider, model: config.primeModel };
        return 0;
      },
      sync: () => 0,
      doctor: async () => 0,
    });
    assert.equal(code, 0);
  } finally {
    captured.restore();
  }
  assert.deepEqual(selected, { provider: "literal", model: "literal-model" });
});

test("setup stops when uv is unavailable", async () => {
  const project = mkdtempSync(join(tmpdir(), "super-rlm-setup-project-"));
  const home = mkdtempSync(join(tmpdir(), "super-rlm-setup-home-"));
  const models = writeModels(home);
  let bootstrapped = false;

  const captured = captureConsole();
  try {
    const code = await runSetup([], {
      cwd: project,
      env: { SUPER_RLM_HOME: home, SUPER_RLM_MODELS_CONFIG: models, SUPER_RLM_UV: "C:/missing/uv.exe" },
      uvCheck: () => false,
      bootstrap: async () => {
        bootstrapped = true;
        return 0;
      },
      sync: () => 0,
      doctor: async () => 0,
    });
    assert.equal(code, 1);
  } finally {
    captured.restore();
  }
  assert.equal(bootstrapped, false);
  assert.match(captured.errors.join("\n"), /uv was not found or is not executable: C:\/missing\/uv\.exe/);
  assert.match(captured.errors.join("\n"), /SUPER_RLM_UV/);
});

test("a missing provider key prints exact instructions and skips bootstrap", async () => {
  const project = mkdtempSync(join(tmpdir(), "super-rlm-setup-project-"));
  const home = mkdtempSync(join(tmpdir(), "super-rlm-setup-home-"));
  const models = writeModels(home);
  let bootstrapped = false;
  let synced = false;

  const captured = captureConsole();
  try {
    const code = await runSetup([], {
      cwd: project,
      env: { SUPER_RLM_HOME: home, SUPER_RLM_MODELS_CONFIG: models },
      uvCheck: () => true,
      bootstrap: async () => {
        bootstrapped = true;
        return 0;
      },
      sync: () => {
        synced = true;
        return 0;
      },
      doctor: async () => 0,
    });
    assert.equal(code, 1);
  } finally {
    captured.restore();
  }
  assert.equal(bootstrapped, false);
  assert.equal(synced, false);
  const stderr = captured.errors.join("\n");
  assert.match(stderr, /no API key for provider 'local'/);
  assert.match(stderr, new RegExp(`Add this line to .*secrets[/\\\\]providers\\.env:`));
  assert.match(stderr, /LOCAL_API_KEY=<your local API key>/);
  assert.match(stderr, /Then run: super-rlm setup/);
  assert.match(stderr, /super-rlm setup --allow-missing-key/);
});

test("--allow-missing-key continues when models sync cannot resolve the key", async () => {
  const project = mkdtempSync(join(tmpdir(), "super-rlm-setup-project-"));
  const home = mkdtempSync(join(tmpdir(), "super-rlm-setup-home-"));
  const models = writeModels(home);
  const events: string[] = [];

  const captured = captureConsole();
  try {
    const code = await runSetup(["--allow-missing-key"], {
      cwd: project,
      env: { SUPER_RLM_HOME: home, SUPER_RLM_MODELS_CONFIG: models },
      uvCheck: () => true,
      bootstrap: async () => {
        events.push("bootstrap");
        return 0;
      },
      sync: () => {
        events.push("sync");
        return 1;
      },
      doctor: async () => {
        events.push("doctor");
        return 0;
      },
    });
    assert.equal(code, 0);
  } finally {
    captured.restore();
  }
  assert.deepEqual(events, ["bootstrap", "sync", "doctor"]);
  assert.match(captured.warns.join("\n"), /models sync skipped the missing provider key/);
  assert.match(captured.warns.join("\n"), /LOCAL_API_KEY is missing/);
});

test("setup rejects an unknown provider before running steps", async () => {
  const project = mkdtempSync(join(tmpdir(), "super-rlm-setup-project-"));
  const home = mkdtempSync(join(tmpdir(), "super-rlm-setup-home-"));
  const models = writeModels(home);
  let bootstrapped = false;

  const captured = captureConsole();
  try {
    const code = await runSetup(["--provider", "nope"], {
      cwd: project,
      env: { SUPER_RLM_HOME: home, SUPER_RLM_MODELS_CONFIG: models },
      uvCheck: () => true,
      bootstrap: async () => {
        bootstrapped = true;
        return 0;
      },
      sync: () => 0,
      doctor: async () => 0,
    });
    assert.equal(code, 1);
  } finally {
    captured.restore();
  }
  assert.equal(bootstrapped, false);
  assert.match(captured.errors.join("\n"), /provider 'nope' is not defined.*available: local, literal/s);
});

test("setup fails on old Node and from the install directory", async () => {
  const project = mkdtempSync(join(tmpdir(), "super-rlm-setup-project-"));
  const home = mkdtempSync(join(tmpdir(), "super-rlm-setup-home-"));
  const models = writeModels(home);
  let initialized = false;

  const captured = captureConsole();
  try {
    const oldNode = await runSetup([], {
      cwd: project,
      env: { SUPER_RLM_HOME: home, SUPER_RLM_MODELS_CONFIG: models },
      nodeVersion: "22.18.0",
      init: () => {
        initialized = true;
        return 0;
      },
    });
    assert.equal(oldNode, 1);
    assert.equal(initialized, false);
    assert.match(captured.errors.join("\n"), /Node >= 22\.19 is required \(found 22\.18\.0\)/);

    captured.errors.length = 0;
    const installDir = await runSetup([], {
      cwd: findRepoRoot(),
      env: { SUPER_RLM_HOME: home, SUPER_RLM_MODELS_CONFIG: models },
      init: () => {
        initialized = true;
        return 0;
      },
    });
    assert.equal(installDir, 1);
    assert.equal(initialized, false);
    assert.match(captured.errors.join("\n"), /run this command from your project directory/);
  } finally {
    captured.restore();
  }
});

test("setup help prints usage without running steps", async () => {
  const captured = captureConsole();
  try {
    assert.equal(await runSetup(["--help"]), 0);
  } finally {
    captured.restore();
  }
  assert.match(captured.logs.join("\n"), /Usage: super-rlm setup/);
  assert.match(captured.logs.join("\n"), /--allow-missing-key/);
});

test("loadConfig exposes uvPath for setup and bootstrap", () => {
  const config = loadConfig({
    env: { SUPER_RLM_HOME: "/tmp/super-rlm-home", SUPER_RLM_UV: "C:/tools/uv.exe" },
    cwd: tmpdir(),
  });
  assert.equal(config.uvPath, "C:/tools/uv.exe");
});
