# ADR 0024: Bundled Pinned Runtime

Status: accepted  
Date: 2026-11-02

## Context

The project should be self-contained: a user should not need a global Pi Agent or Prime Agent install, and the project must not read or mutate the user's normal configurations.

Forking or vendoring source would provide maximum control but adds long-term maintenance.

## Decision

The project bundles pinned runtimes.

- Pi Agent is pinned through the project package lock.
- Prime Agent is a pinned release with a checksum.
- The Prime Agent kernel/runtime environment is part of the bundled runtime.
- `runtime/manifest.json` records versions and checksums.
- `bin/super-rlm` sets project-owned agent dirs, session dirs, and daemon socket.
- `super-rlm doctor` verifies the runtime.
- Docker images include the same runtime.
- The project does not use global `pi` or `prime-agent`, and does not touch `~/.pi` or `~/.prime`.
- v0 does not fork or vendor the source.

## Consequences

- Users need no global install.
- Builds are reproducible.
- Release artifacts are larger.
- Updating Pi/Prime is a project-level action.
- A `doctor` command is required.
- Forking remains an option only if a required change cannot be made through public APIs.

## Alternatives considered

- Global install: simplest, but not self-contained and risks version drift.
- Vendor source: more control, more build and sync work.
- Fork: maximum control, highest maintenance.
