# ADR 0004: Orchestrator Is a Separate Service

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent keeps its Engine in the long-lived Harness process. The Engine is the single writer of task state, but it is a module boundary, not a process boundary.

super-RLM's Router runs inside the Pi Agent CLI. The CLI is opened and closed by the user, so it cannot host durable task state. If the Orchestrator lived in the Router process, closing the CLI would stop scheduling and lose the queue.

## Decision

The Orchestrator is a separate, long-lived service.

- It is the only writer of Task, Ticket, Assignment, and Report state.
- It contains no LLM calls and no task decomposition.
- It owns scheduling, concurrency slots, leases, retries, timeouts, and callbacks.
- The Router extension calls it through a narrow tool/API contract.
- The Worker service calls it through a narrow report API.
- v0 implementation is TypeScript/Node with SQLite WAL.
- Transport is HTTP/JSON for v0; it can later become a Unix socket or gRPC without changing the domain contract.

## Consequences

- Tasks survive Pi CLI restarts.
- Multiple Router sessions can share one Orchestrator.
- The Router extension becomes a thin client.
- A local service lifecycle is required: manual `docker-compose up` first, optional auto-start later.
- Authentication between Router, Orchestrator, and Worker becomes necessary.
- The Orchestrator can be scaled or moved independently.

## Alternatives considered

- Embed the Orchestrator in the Router process: simpler, but not durable across CLI exits.
- Omit the Orchestrator and let the Router call Workers directly: shortest path, but no reliable task state, queue, or recovery.
