# ADR 0014: Router Tool Surface and Internal API Contract

Status: accepted  
Date: 2026-11-02

## Context

The Router needs a small, explicit tool surface. The Orchestrator needs matching internal REST endpoints. The Worker protocol is separate.

The Router is responsible for splitting work, so it must submit a list of Tickets. The Orchestrator must not split.

`waiting` and `blocked` have different user actions, so they need separate resume operations.

## Decision

The Router tool surface is:

- `task_create`
- `task_list`
- `task_status`
- `task_wait`
- `ticket_result`
- `ticket_answer`
- `ticket_resume`
- `ticket_retry`
- `ticket_cancel`
- `task_cancel`

`task_create` accepts a `tickets` list. The Orchestrator validates limits and stores the Tickets.

`ticket_answer` handles `waiting` Tickets. `ticket_resume` handles `blocked` Tickets. Both create a new Assignment and resume the same Prime Agent session when possible.

The full request/response shapes and internal REST mapping live in `docs/protocol/router-api.md`.

## Consequences

- The Router's responsibilities are explicit in its tool schema.
- The Orchestrator never plans or splits tasks.
- The UI can reuse the same read tools/endpoints.
- `waiting` and `blocked` remain distinguishable through the entire stack.
- Tool schemas and REST handlers must stay in sync; OpenAPI/schema checks are required.

## Alternatives considered

- `task_create` accepting a single prompt and letting the Orchestrator split: rejected; the Router owns splitting.
- One `ticket_resume` for both waiting and blocked: simpler, but hides different user actions.
