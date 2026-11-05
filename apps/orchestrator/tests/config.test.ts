import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig, validateLoopbackHost } from "../src/config.ts";

test("the Orchestrator listens on loopback only", () => {
  assert.equal(validateLoopbackHost("127.0.0.1"), "127.0.0.1");
  assert.equal(validateLoopbackHost("::1"), "::1");
  assert.equal(validateLoopbackHost("[::1]"), "::1");
  assert.equal(validateLoopbackHost(" localhost "), "127.0.0.1");
  assert.equal(loadConfig({} as NodeJS.ProcessEnv).host, "127.0.0.1");
  assert.equal(loadConfig({ SUPER_RLM_HOST: "localhost" } as NodeJS.ProcessEnv).host, "127.0.0.1");

  for (const host of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "example.com", ""]) {
    assert.throws(() => validateLoopbackHost(host), /must be 127\.0\.0\.1 or ::1/);
    assert.throws(
      () => loadConfig({ SUPER_RLM_HOST: host } as NodeJS.ProcessEnv),
      /must be 127\.0\.0\.1 or ::1/,
    );
  }
});

test("callback private-address opt-in is explicit", () => {
  assert.equal(loadConfig({} as NodeJS.ProcessEnv).callbackAllowPrivate, false);
  assert.equal(loadConfig({ SUPER_RLM_CALLBACK_ALLOW_PRIVATE: "1" } as NodeJS.ProcessEnv).callbackAllowPrivate, true);
  assert.equal(loadConfig({ SUPER_RLM_CALLBACK_ALLOW_PRIVATE: "true" } as NodeJS.ProcessEnv).callbackAllowPrivate, false);
});
