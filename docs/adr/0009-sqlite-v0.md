# ADR 0009: SQLite v0 with Replaceable Repositories

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent uses one SQLite file, `<stateDir>/orchestrator.sqlite`, with a directory lock, schema versioning, migrations, and a SQLite-backed outbox. This keeps the single-writer model simple and backup-friendly.

super-RLM's Orchestrator is a separate service, but it can follow the same persistence model.

## Decision

v0 uses one SQLite database.

- WAL mode.
- One Orchestrator process; a directory lock prevents a second writer.
- Schema version and forward migrations.
- A durable outbox in the same database for callbacks and asynchronous effects.
- Repository interfaces for Tasks, Tickets, Assignments, Reports, and the Outbox.
- Business code does not depend on SQLite-specific details beyond the repository implementation.

PostgreSQL is a later option if multi-instance or higher write concurrency is needed.

## Consequences

- Deployment and backup are simple: one database file plus the workspace volume.
- The single-writer model is enforced by the process and the lock.
- Tests can use temporary SQLite files.
- Migrations must be maintained from the first schema.
- Do not add a second Orchestrator writer in v0.
- Repository interfaces must stay small and driven by real operations, not speculative future backends.

## Alternatives considered

- PostgreSQL from day one: better multi-instance support, but unnecessary v0 complexity.
- Embedded in-memory store: not durable.
