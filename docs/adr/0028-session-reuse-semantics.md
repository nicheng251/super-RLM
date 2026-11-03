# ADR 0028: Session Reuse Follows dsh Semantics

Status: accepted (supersedes ADR 0022)  
Date: 2026-11-02

## Context

ADR 0022 framed session reuse as a technical availability check split between Orchestrator policy and Worker execution.

dsh-superagent does something simpler:

- each Ticket has a stable worker session ID (`worker-<ticketId>`);
- the Executor resolves or creates that session;
- the semantic decision is whether an interrupted/busy Assignment needs a recovery note, based on the last Report state and whether inputs arrived after it;
- session reuse itself is identity-based, not a separate policy gate.

## Decision

super-RLM follows the dsh model.

- Each Ticket has a stable logical session identity; `session_ref` is the Worker's opaque reference to the current Prime Agent session.
- The Orchestrator decides the semantic intent:
  - `waiting`/`blocked` + answer/resume: continue the session;
  - `failed`/`lost` and unfinished: recovery;
  - terminal: no new Assignment.
- The Worker resolves the session:
  - if `session_ref` exists, try `--resume`;
  - if it does not exist or resume fails, create a new session and send a recovery prompt;
  - report `resumed`, `recovery`, and the current `session_ref`.
- There is no separate `resume_eligible` policy gate. `resume_attempts` may bound fallback loops.
- The Orchestrator is not responsible for inspecting session files, locks, or Prime Agent compatibility.

## Consequences

- The design matches dsh's semantic/identity model.
- The Worker is the only component that performs session resolution.
- The Orchestrator stays free of Prime Agent internals.
- Resume failure is a normal fallback, not a policy decision.
- The report carries the outcome for audit and future scheduling.

## Alternatives considered

- Orchestrator preflight checks: stale and unnecessary.
- Worker deciding policy: mixes execution with task semantics.
