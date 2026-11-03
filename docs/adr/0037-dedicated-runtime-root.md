# ADR 0037: Dedicated Project Runtime Root

Status: accepted (supersedes ADR 0015)  
Date: 2026-11-02

## Context

ADR 0015 put runtime data in `<target-project>/.super-rlm`. dsh-superagent instead separates runtime state from the target repository:

- a dedicated Harness profile holds sessions;
- `stateDir` holds the database, locks, shims, git config, and ticket directories;
- the target repository is only the code checkout/worktree.

Putting databases, sessions, and workspaces inside the target repository pollutes it and ties history to the directory path.

## Decision

Runtime data lives in a dedicated root.

```text
SUPER_RLM_ROOT = ~/.super-rlm
project root   = $SUPER_RLM_ROOT/projects/<project_id>
SUPER_RLM_HOME = project root (overridable)
```

The target project holds only:

```text
.super-rlm-project.json
{ "project_id": "prj_..." }
```

- `super-rlm init` creates the marker when the target project is writable.
- If the marker is absent and cannot be created, `--project-id` or `SUPER_RLM_PROJECT_ID` is required.
- Router sessions, Worker sessions, Orchestrator SQLite, secrets, and workspaces live under the project runtime root.
- Docker mounts `SUPER_RLM_ROOT`.
- The target project is not used for runtime state.

## Consequences

- Target repositories stay clean.
- Project moves and renames do not break session identity.
- Backup is centralized under `SUPER_RLM_ROOT`.
- A project marker is required to map a target directory to its runtime root.
- Project-local runtime data remains possible via `SUPER_RLM_HOME` or `--project-home`.
- This matches dsh's separation of profile/stateDir from the target repository.

## Alternatives considered

- `<target-project>/.super-rlm`: portable, but pollutes the repository and ties identity to the path.
- Global single runtime root without project IDs: simpler, but projects collide.
