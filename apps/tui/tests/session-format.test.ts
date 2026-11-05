import assert from "node:assert/strict";
import test from "node:test";

import { parseSessionJsonl, summarizeToolOutput } from "../src/session-format.ts";

function record(value: unknown): string {
  return JSON.stringify(value);
}

test("parses messages, thinking, tool calls, and summarized tool results", () => {
  const jsonl = [
    record({ type: "session", id: "s1" }),
    record({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Fix the build" }] },
    }),
    record({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should inspect the logs." },
          { type: "text", text: "Looking now." },
          { type: "toolCall", name: "ipython", arguments: { code: "print(1)" } },
        ],
      },
    }),
    record({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "ipython",
        content: [{ text: "line1\nline2\nline3\nline4\nline5\nSECRET_TAIL" }],
      },
    }),
    "{not json",
    record({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "bash",
        isError: true,
        content: [{ text: "boom" }],
      },
    }),
  ].join("\n");

  const lines = parseSessionJsonl(jsonl, { maxToolChars: 40, maxToolLines: 2 });
  assert.deepEqual(lines.map((line) => line.kind), [
    "user", "thinking", "assistant", "tool", "tool", "tool",
  ]);
  assert.equal(lines[0].text, "Fix the build");
  assert.match(lines[1].text, /inspect the logs/);
  assert.equal(lines[2].text, "Looking now.");
  assert.match(lines[3].text, /^\u2699 ipython/);
  assert.match(lines[4].text, /^\u2713 ipython/);
  assert.match(lines[4].text, /line1\nline2/);
  assert.match(lines[4].text, /\+4 lines/);
  assert.ok(!lines[4].text.includes("SECRET_TAIL"));
  assert.match(lines[5].text, /^\u2717 bash/);
});

test("keeps only the most recent entries and accepts string content", () => {
  const jsonl = Array.from({ length: 5 }, (_, index) => record({
    type: "message",
    message: { role: "user", content: `message ${index}` },
  })).join("\n");

  const lines = parseSessionJsonl(jsonl, { limit: 2 });
  assert.deepEqual(lines.map((line) => line.text), ["message 3", "message 4"]);
  assert.deepEqual(parseSessionJsonl(jsonl, { limit: 0 }), []);
});

test("ignores malformed and unrelated records", () => {
  const jsonl = [
    "",
    "not json",
    record({ type: "model_change", provider: "p", modelId: "m" }),
    record({ type: "message", message: { role: "assistant", content: [] } }),
  ].join("\n");
  assert.deepEqual(parseSessionJsonl(jsonl), []);
});

test("summarizes a huge single-line tool result by character count", () => {
  const summary = summarizeToolOutput("x".repeat(500), 20, 4);
  assert.match(summary, /^x{20}/);
  assert.match(summary, /\+480 chars/);
  assert.ok(summary.length < 60);
});
