import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { loadConfig, validateLoopbackHost } from "../src/config.ts";
import { testEnv } from "./env.ts";

test("the Orchestrator listens on loopback only", () => {
  assert.equal(validateLoopbackHost("127.0.0.1"), "127.0.0.1");
  assert.equal(validateLoopbackHost("::1"), "::1");
  assert.equal(validateLoopbackHost("[::1]"), "::1");
  assert.equal(validateLoopbackHost(" localhost "), "127.0.0.1");
  assert.equal(loadConfig(testEnv()).host, "127.0.0.1");
  assert.equal(loadConfig(testEnv({ SUPER_RLM_HOST: "localhost" })).host, "127.0.0.1");

  for (const host of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "example.com", ""]) {
    assert.throws(() => validateLoopbackHost(host), /must be 127\.0\.0\.1 or ::1/);
    assert.throws(
      () => loadConfig(testEnv({ SUPER_RLM_HOST: host })),
      /must be 127\.0\.0\.1 or ::1/,
    );
  }
});

test("callback private-address opt-in is explicit", () => {
  assert.equal(loadConfig(testEnv()).callbackAllowPrivate, false);
  assert.equal(loadConfig(testEnv({ SUPER_RLM_CALLBACK_ALLOW_PRIVATE: "1" })).callbackAllowPrivate, true);
  assert.equal(loadConfig(testEnv({ SUPER_RLM_CALLBACK_ALLOW_PRIVATE: "true" })).callbackAllowPrivate, false);
});

test("required API secrets fail closed with a setup hint", () => {
  const home = join("tmp-test-home", "super-rlm");
  const secretKeys = ["SUPER_RLM_ROUTER_TOKEN", "SUPER_RLM_WORKER_TOKEN", "SUPER_RLM_CALLBACK_KEY"] as const;

  for (const key of secretKeys) {
    const missing = testEnv({ SUPER_RLM_HOME: home });
    delete missing[key];
    for (const env of [missing, testEnv({ SUPER_RLM_HOME: home, [key]: "   " })]) {
      assert.throws(
        () => loadConfig(env),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(key));
          assert.match(error.message, /super-rlm/);
          assert.ok(error.message.includes(join(home, "secrets", "api.env")));
          return true;
        },
      );
    }
  }
});

test("explicit API secrets are used as given", () => {
  const config = loadConfig(testEnv({
    SUPER_RLM_ROUTER_TOKEN: "router-secret",
    SUPER_RLM_WORKER_TOKEN: "worker-secret",
    SUPER_RLM_CALLBACK_KEY: "callback-secret",
  }));
  assert.equal(config.routerToken, "router-secret");
  assert.equal(config.workerToken, "worker-secret");
  assert.equal(config.callbackKey, "callback-secret");
});
