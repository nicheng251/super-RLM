# ADR 0015: Project-Owned Runtime and Configuration Root

Status: superseded by ADR 0037  
Date: 2026-11-02

## Context

Pi Agent and Prime Agent normally store configuration and sessions under the user's home directory. super-RLM needs its own models, sessions, workspaces, secrets, and daemon state without affecting the user's normal Pi/Prime usage.

Both runtimes support environment overrides for their agent directories and session directories. Prime Agent also supports a daemon socket override.

## Decision

The project owns an isolated runtime root, `SUPER_RLM_HOME`, defaulting to `<project>/.super-rlm` and overridable by environment variable.

- Pi Router:
  - `PI_CODING_AGENT_DIR=<SUPER_RLM_HOME>/pi/agent`
  - `PI_CODING_AGENT_SESSION_DIR=<SUPER_RLM_HOME>/pi/sessions`
- Prime Worker:
  - `PRIME_AGENT_CODING_AGENT_DIR=<SUPER_RLM_HOME>/prime/agent`
  - `PRIME_AGENT_SESSION_DIR=<SUPER_RLM_HOME>/prime/sessions`
  - `PRIME_AGENT_DAEMON_SOCKET=<SUPER_RLM_HOME>/prime/daemon/daemon.sock`
- Orchestrator state: `<SUPER_RLM_HOME>/orchestrator/orchestrator.sqlite`.
- Secrets: `<SUPER_RLM_HOME>/secrets/`, 0600, gitignored.
- Workspaces: `<SUPER_RLM_HOME>/workspaces/<ticket_id>/`.

Committed defaults live under `config/` with no secrets.

## Consequences

- The user's normal Pi and Prime Agent state is untouched.
- Multiple projects can have independent models, sessions, and daemons.
- Configuration sync writes to the project root, not the home directory.
- Docker mounts one project root or data volume.
- Backup and cleanup are scoped to the project.

## Alternatives considered

- Use the user's home directories: convenient, but risks conflicts and accidental mutation.
- One global super-RLM root for all projects: simpler, but project isolation is weaker.
