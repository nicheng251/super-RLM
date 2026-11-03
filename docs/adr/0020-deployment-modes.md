# ADR 0020: Deployment Modes

Status: accepted  
Date: 2026-11-02

## Context

Router is an interactive CLI/TUI. Orchestrator and Worker are long-running services.

Running the TUI inside a container complicates TTY behavior, clipboard, keybindings, and file access. Running everything on the host is convenient for development but not a one-command deployment.

## Decision

Support two deployment modes:

1. **Primary: host CLI + Docker services**
   - User runs the CLI on the host.
   - Orchestrator and Worker run in Docker Compose.
   - Orchestrator publishes only to `127.0.0.1`.
   - Worker publishes no host port.
   - Both share a `SUPER_RLM_HOME` data volume.

2. **Development: all-local processes**
   - Orchestrator via `pnpm dev`.
   - Worker via `uv run worker`.
   - CLI on the host.

The TUI is never containerized. Both modes use the same HTTP/SSE contracts.

## Consequences

- Daily use has a good terminal experience.
- Development is fast and debuggable.
- Docker Compose covers the one-command deployment requirement.
- The CLI needs a configurable Orchestrator URL and token path.
- Volume permissions and UID mapping need documentation.
- Deployment parity between modes must be tested.

## Alternatives considered

- All-in-Docker including the TUI: poor terminal UX and cross-platform complexity.
- All-local only: simple, but not a one-command deployment.
