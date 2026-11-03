# ADR 0022: Prime Agent Session Resume

Status: superseded by ADR 0028  
Date: 2026-11-02

## Context

HITL releases the Worker slot and closes the ACP connection. The Ticket must continue in the same Prime Agent session so context, files, and RLM work are not lost.

Prime Agent supports resident sessions and `--resume` with a project session directory.

## Decision

- Use resident Prime Agent sessions, not `--no-session`.
- The Worker reports an opaque `session_ref`.
- The Orchestrator stores `session_ref` and never parses it.
- On resume, the Worker starts a new ACP process with the project `--session-dir` and `--resume <session_ref>`, then sends the user's answer as a prompt.
- If resume fails, the Worker starts a new session with a recovery prompt containing the original task, last summary, question, and answer.
- A new session replaces the old `session_ref`.
- Reports include `resumed` and `recovery` booleans.
- If both paths fail, report `failed` with `resume_failed`.

## Consequences

- Context survives a handoff and a Worker restart when the session is available.
- The Orchestrator stays decoupled from Prime Agent session internals.
- Resume failure is handled gracefully with a lossy recovery prompt.
- Session files must live under the project-owned session directory.
- Session locking and cleanup need tests.

## Alternatives considered

- Always start a new session: simpler, but loses context.
- Keep the ACP process alive while waiting: holds a slot and violates the HITL slot policy.
