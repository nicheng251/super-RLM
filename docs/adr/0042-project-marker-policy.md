# ADR 0042: Project Marker Is Local by Default

Status: accepted  
Date: 2026-11-02

## Context

`.super-rlm-project.json` maps a target directory to a runtime root. If committed, every clone shares `project_id` and may collide on one machine.

## Decision

- `.super-rlm-project.json` is local state and is gitignored by default.
- `super-rlm init` creates it.
- Each clone gets its own project ID unless the user explicitly supplies one.
- Shared/CI installs use `--project-id` or `SUPER_RLM_PROJECT_ID`.
- A committed marker is not supported in v0.

## Consequences

- Clones do not accidentally share databases or sessions.
- Moving a project keeps the marker and project ID.
- Shared environments must pass an explicit ID.
- Users must run `super-rlm init` once per clone.

## Alternatives considered

- Commit the marker: clones collide.
- Derive from git remote: shared across clones but not per-installation.
