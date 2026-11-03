# ADR 0044: Dropped / No-Op Outcome

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent has a `dropped` report: nothing to do, close without treating it as a failure.

super-RLM otherwise turns "nothing to do" into `failed` or an empty `completed`.

## Decision

- Add `dropped` to Worker report states and the `super-rlm-report` skill.
- A `dropped` report sets the Ticket to terminal `succeeded` with `outcome = "dropped"` and `no_op = true`.
- Task derivation treats dropped Tickets as successful/no-op.
- UI displays "dropped" rather than "succeeded" when `outcome = "dropped"`.

## Consequences

- No-op work is not a failure.
- The Ticket state set stays small.
- Task `succeeded` can contain no-op Tickets.
- Reports and UI must carry `outcome`/`no_op`.

## Alternatives considered

- Add a separate Ticket `dropped` state: more state complexity.
- Treat dropped as failed: incorrect.
