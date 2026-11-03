# ADR 0031: Router Conversation Persistence and Project-Local Pi Profile

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent keeps a long-lived main Session for routing and conversation, while Ticket facts live in the Engine/Store.

Pi Agent already persists sessions as JSONL and supports session IDs, resume, and compaction. The project must not use the user's global Pi configuration.

## Decision

- One persistent Router session per project.
- Fixed session ID: `super-rlm-router-<project_id>`.
- `super-rlm` opens it; `--new` creates a new session; `--session <id>` opens a specific session.
- Pi uses project-owned agent and session directories.
- Router disables global context files, skills, and prompt templates; only the explicit super-rlm extension loads.
- Task facts are always queried from the Orchestrator; chat history is not authoritative.
- Explicit `--skill`/`--extension` can add resources.

## Consequences

- Router conversation is continuous across CLI restarts.
- Pi compaction handles long sessions.
- Task state survives even if the Router session is lost.
- The user's normal Pi configuration is untouched.
- `super-rlm doctor` checks the profile paths.

## Alternatives considered

- Ephemeral Router session: no continuity.
- Per-Task Router session: breaks cross-task conversation and the main-session model.
- Use global Pi profile: convenient, but violates isolation.
