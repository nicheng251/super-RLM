import assert from "node:assert/strict";
import test from "node:test";

import { SseParser, parseBlock } from "../src/sse.ts";

test("parses data, id, and event fields", () => {
  const message = parseBlock("id: 7\nevent: ticket.waiting\ndata: {\"ok\":true}");
  assert.deepEqual(message, { id: 7, event: "ticket.waiting", data: "{\"ok\":true}" });
  assert.equal(parseBlock(": keep-alive"), null);
});

test("joins multi-line data and ignores comments", () => {
  const message = parseBlock(": comment\ndata: line one\ndata: line two");
  assert.equal(message?.data, "line one\nline two");
});

test("buffers events split across chunks and handles CRLF", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.feed("id: 1\r\ndata: {\"a\""), []);
  const messages = parser.feed(":1}\r\n\r\nid: 2\ndata: {\"b\":2}\n\n");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, 1);
  assert.equal(messages[0].data, "{\"a\":1}");
  assert.equal(messages[1].id, 2);
});
