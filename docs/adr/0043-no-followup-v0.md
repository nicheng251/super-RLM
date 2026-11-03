# ADR 0043: No General Follow-Up API in v0

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent supports later human messages through Threads and Subscriptions. super-RLM currently exposes `ticket_answer`, `ticket_resume`, and `ticket_retry`.

## Decision

v0 does not add a general `ticket_message` API.

- `waiting` uses `ticket_answer`.
- `blocked` uses `ticket_resume`.
- `failed`/`lost` uses `ticket_retry`.
- New work after a terminal Ticket creates a new Ticket/Task.
- Mid-run steering and terminal-Ticket follow-ups are deferred.

## Consequences

- The state machine and Worker steering path stay simple.
- Users cannot add context to a running or completed Ticket in v0.
- The UI must explain that new work means a new Ticket.
- A future subscription/thread model can add follow-ups.

## Alternatives considered

- Add `ticket_message` now: requires steering, terminal resume, and authority rules.
- Pretend answer/resume covers follow-ups: misleading.
