# ADR 0029: Strict Runtime Isolation from User Pi/Prime Configs

Status: accepted  
Date: 2026-11-02

## Context

The project bundles pinned Pi Agent and Prime Agent runtimes. Bundling alone does not prevent a process from reading the user's `~/.pi` or `~/.prime` configuration, inherited environment variables, or a globally installed binary.

The Router and Worker must use project-owned configuration and state. At the same time, local mode (A) intentionally runs as the operator OS user, so task tools can still read the operator's files.

## Decision

- Resolve `pi` and `prime-agent` from the bundled `runtime/`, never from `PATH`.
- Set project-owned agent dirs, session dirs, and the Prime daemon socket.
- Prime also requires project-owned `PRIME_AGENT_KERNEL_VENV` and `PRIME_AGENT_KERNEL_PYTHON`; otherwise it bootstraps under `~/.prime`.
- On Windows, set `PRIME_AGENT_BASH_SHELL` to an absolute POSIX shell path.
- Strip inherited `PI_*` and `PRIME_AGENT_*` variables; inject project values.
- Never read or write `~/.pi` or `~/.prime`.
- The project kernel venv must be prepared with `prime-agent-runtime`, `mcp`, `tyro`, and the default Python packages.
- Router loads only the project extension and disables global context files, skills, and prompt templates.
- Worker loads resources only from the project agent dir and explicit paths.
- `super-rlm doctor` verifies the isolation.
- Local mode (A) does not fake `HOME`; full filesystem isolation remains the hardened container mode (B).

## Consequences

- Pi/Prime configuration is reproducible and project-scoped.
- The user's normal Pi/Prime sessions and settings are untouched.
- Environment sanitization is mandatory; inherited variables are a real risk.
- Task tools can still read user files in local mode; this is a documented limitation, not a config leak.
- Container mode provides the stronger boundary.

## Alternatives considered

- Use global installs/configs: simple, but violates isolation and reproducibility.
- Fake `HOME` in local mode: stronger config isolation, but breaks git/ssh and other task tools.
- Container-only: safest, but slower for local development.
