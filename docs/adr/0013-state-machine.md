# ADR 0013: State Machine and Report Protocol

Status: accepted  
Date: 2026-11-02

## Context

The system needs explicit Task, Ticket, and Assignment states, plus a Worker report protocol. dsh-superagent separates Assignment lifecycle from Report state and uses `waiting`/`blocked` to represent handoffs to a person.

super-RLM adds independent Tickets, slot release on handoff, and session resume.

## Decision

- Task states: `queued | running | waiting | succeeded | partial | failed | cancelled | timed_out`.
- `partial` is a derived terminal state, not manually set.
- Ticket states: `queued | assigned | running | waiting | blocked | succeeded | failed | cancelled | timed_out | lost`.
- Assignment states: `pending | running | ended` with `end_reason`.
- Report states: `progress | waiting | blocked | completed | failed`.
- `waiting` means the user must answer; `blocked` means an external condition or action is required. Both release the slot and preserve the session reference.
- The Orchestrator validates all transitions.

The detailed tables and transitions live in `docs/protocol/state-machine.md`.

## Consequences

- Lifecycle and outcome stay separate.
- The UI can distinguish "waiting for answer" from "blocked".
- Mixed Ticket outcomes are represented by `partial` without overloading `failed`.
- The Worker protocol stays small.
- The Orchestrator needs transition validation and derived Task status.

## Alternatives considered

- Explicit Assignment states for every outcome: more states, more duplication.
- No `partial`: simpler, but mixed outcomes become ambiguous.
- Only `waiting`, no `blocked`: simpler, but loses the distinction between a question and an external blocker.
