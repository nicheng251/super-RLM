# ADR 0038: Local-First Development

Status: accepted  
Date: 2026-11-02

## Context

The architecture is ready for implementation, but release packaging, installers, and cross-platform distribution add work before the core loop is proven.

## Decision

v0 is local-first.

- Run Orchestrator, Worker, and Router from source or local processes.
- Use project-owned runtime paths under `~/.super-rlm/projects/<project_id>`.
- Docker Compose is optional.
- Do not build release packages, installers, or auto-update in v0.
- Revisit packaging after the two spikes and the first local end-to-end slice.

## Consequences

- Faster path to a working system.
- Packaging decisions remain open.
- Local runtime bootstrap must still be reproducible.
- Distribution can be added without changing domain contracts.

## Alternatives considered

- Package now: delays the core loop.
- Docker-only: conflicts with the host CLI/TUI experience.
