# ADR 0010: HTTP/JSON + SSE Transport

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent is in-process, so it has no network transport between Engine, Executor, and the main Session. super-RLM separates Router, Orchestrator, and Worker, and spans TypeScript and Python.

The boundaries need:

- request/response commands;
- server-to-client progress events;
- easy debugging;
- cross-container operation;
- a path to future scale.

## Decision

v0 uses HTTP/JSON for commands and SSE for event streams.

- Router/UI -> Orchestrator: HTTP/JSON.
- Orchestrator -> Worker: HTTP/JSON.
- Worker -> Orchestrator reports: HTTP/JSON.
- UI event stream: SSE.
- User callbacks: HTTP/JSON with signed payloads.
- All endpoints are versioned under `/v1`.
- Contracts are described by OpenAPI or JSON Schema.
- Commands carry `Idempotency-Key`; requests carry a request ID for tracing.
- v0 has no gRPC and no message queue.

## Consequences

- TS and Python can both use the same contract.
- `curl` and browser tools can debug the API.
- SSE needs reconnect and replay handling.
- Payload size and frequency are less efficient than gRPC, but acceptable for v0.
- A message queue can be added later behind the Orchestrator-to-Worker contract.
- gRPC remains an option if strong typed bidirectional streaming becomes necessary.

## Alternatives considered

- HTTP/JSON with polling: simpler, but worse real-time behavior and more requests.
- gRPC: stronger typing and streaming, but more setup and maintenance for v0.
- Unix socket: local-only and poor Windows/Docker portability.
- Message queue: useful later, but extra infrastructure for v0.
