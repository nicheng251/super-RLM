# ADR 0005: Human-in-the-Loop Releases the Slot and Resumes the Session

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent's handoff model releases the worker slot when a Ticket needs a person. The Ticket keeps a Report and an Attention question; the person's answer later resumes the Ticket under a new Assignment.

Prime Agent's ACP sessions are daemon-backed and saved unless `--no-session` is used. A later ACP process can reopen a saved session with the resume flags.

## Decision

v0 supports human-in-the-loop.

- A Worker may report `waiting` or `blocked` with a structured question.
- The Orchestrator marks the Ticket `waiting`, records the question, and releases the assignment's concurrency slot.
- The Worker closes its ACP connection but leaves the Prime Agent session persisted.
- The Router sees the waiting Ticket through `task_status`/`task_wait`, asks the user, and calls `ticket_answer(ticket_id, message)`.
- The Orchestrator creates a new Assignment and the Worker reopens the saved Prime Agent session, sends the answer as a new prompt, and resumes execution.
- If the session cannot be resumed, the Worker starts a new session with a recovery note that includes the question and the user's answer.

## Consequences

- Waiting Tickets do not consume concurrency slots.
- The system needs a stable `prime_session_ref` (session id and/or file) on the Assignment/Ticket.
- Worker must support saved sessions and resume flags.
- The state machine needs `waiting`, an attention/question record, and duplicate-answer protection.
- A Ticket can remain waiting indefinitely unless a timeout policy is added.
- The Router must be able to show open questions to the user.

## Alternatives considered

- Terminal-only v0: simpler, but no mid-task clarification and not dsh-like.
- Hold the slot while waiting: simpler resume, but waiting Tickets block capacity and diverge from dsh.
