# ADR 0021: HITL Timeout and Duplicate Answer Policy

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent lets a Ticket wait for a person indefinitely. super-RLM exposes an explicit `ticket_answer` operation, so duplicate and late answers must be defined.

## Decision

- `waiting_timeout_s` defaults to `0` (no automatic timeout).
- A non-zero timeout marks the Ticket `timed_out` and emits an event.
- The first `ticket_answer` wins atomically.
- The answer request carries an `Idempotency-Key`; a retry with the same key returns the original assignment.
- A different answer after the Ticket left `waiting` returns `ticket_not_waiting`.
- Late answers after timeout or cancellation are rejected.
- Answers are stored in Ticket history and included in the resume prompt.
- Waiting Tickets hold no slot.

## Consequences

- Waiting Tickets can accumulate; admin/UI needs a stale-waiting view.
- Network retries are safe.
- Users cannot accidentally overwrite an answer.
- Additional user input after an answer is not supported in v0; it needs a separate follow-up mechanism.
- A future timeout policy can be enabled without changing the API.

## Alternatives considered

- Default 24-hour timeout: prevents accumulation, but can expire legitimate human work.
- Queue later answers as follow-ups: useful, but mixes answer and new instructions in v0.
- Last answer wins: simple, but loses information and is not idempotent.
