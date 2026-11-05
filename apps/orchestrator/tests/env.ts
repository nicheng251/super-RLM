/** Explicit API secrets for tests; production never falls back to these. */
export const TEST_ROUTER_TOKEN = "test-router-token";
export const TEST_WORKER_TOKEN = "test-worker-token";
export const TEST_CALLBACK_KEY = "test-callback-key";

export function testEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SUPER_RLM_ROUTER_TOKEN: TEST_ROUTER_TOKEN,
    SUPER_RLM_WORKER_TOKEN: TEST_WORKER_TOKEN,
    SUPER_RLM_CALLBACK_KEY: TEST_CALLBACK_KEY,
    ...overrides,
  };
}
