# ADR 0019: Worker Execution and Report Contract

Status: accepted  
Date: 2026-11-02

## Context

The Orchestrator pushes Assignments to Workers. Workers must report progress, questions, blockers, completion, failure, and cancellation without owning Task state.

Reports can be retried, reordered, or arrive after the Assignment ended. Results can be large. Cancellation is initiated by the Orchestrator.

## Decision

- Workers report with HTTP POST.
- Each report has a monotonic `seq` and an `idempotency_key`.
- Duplicate or stale reports are accepted idempotently without changing state.
- Reports for ended Assignments return `assignment_ended`; the Worker stops.
- Cancellation is Orchestrator-authoritative; a Worker `cancelled` report is an audit fact, not required for correctness.
- `summary` is capped at 2 KiB.
- `result` is capped at 64 KiB inline; larger output goes to workspace artifacts.
- Artifact entries are relative paths inside the workspace.
- Workers send Assignment heartbeats; a missed lease marks the Assignment `lost`.
- The Orchestrator's timeout decision wins over the Worker's.

The full contract is in `docs/protocol/worker-api.md`.

## Consequences

- Reports are safe to retry.
- Large results do not bloat SQLite or JSON responses.
- Cancellation remains correct even if the Worker is unresponsive.
- Workers must maintain per-Assignment sequence numbers.
- The Orchestrator must deduplicate and handle late reports.

## Alternatives considered

- No sequence numbers: simpler, but retries and reordering are ambiguous.
- Requiring a Worker terminal report for cancellation: brittle if the Worker is dead.
- Unlimited inline results: risks DB and API bloat.
