# ADR 0036: Offline Backup/Restore and Forward-Only Migrations

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent backs up its `stateDir`, uses schema versioning, and only migrates forward. A database from a newer version is refused, and rollback requires the pre-upgrade backup.

super-RLM stores SQLite state plus Pi/Prime sessions, workspaces, and secrets under `SUPER_RLM_HOME`.

## Decision

v0 uses offline backup and restore.

- `super-rlm backup <path>` requires Orchestrator and Worker to be stopped.
- Backup includes `SUPER_RLM_HOME` and a manifest with timestamp, runtime versions, schema version, and checksums.
- `secrets/` is excluded by default; `--include-secrets` includes it.
- `super-rlm restore <path>` verifies the manifest, checks runtime compatibility, restores, migrates, and runs `doctor`.
- A failed restore leaves the original directory untouched.
- Migrations are forward-only; an older build refuses a newer database.
- A pre-migration backup is automatic.
- Pi/Prime session-format incompatibility is reported, not silently migrated.

## Consequences

- Backups are consistent and simple.
- Restore is safe and verifiable.
- Online hot backup is deferred.
- Secrets require a separate backup decision.
- Runtime version compatibility becomes part of restore validation.

## Alternatives considered

- Online quiesced backup: better uptime, more complexity.
- Copying a live directory: can produce inconsistent SQLite/session/workspace state.
