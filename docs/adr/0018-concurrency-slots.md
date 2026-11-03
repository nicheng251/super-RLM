# ADR 0018: Concurrency and Priority Slot

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent limits concurrent worker slots and reserves one extra slot for a person's message or status request. A Ticket holds its slot from launch through its active turn; a handoff to a person releases it.

super-RLM supports human-in-the-loop, so a user answer should not wait behind new Tasks.

## Decision

- `max_concurrent_tickets` is a global Orchestrator setting.
- Each Worker reports `max_concurrency`.
- Normal Tickets use normal slots.
- One priority slot is reserved for `ticket_answer` and `ticket_resume`.
- New Tasks and Tickets cannot use the priority slot.
- A Ticket holds a slot from Assignment start until terminal or handoff.
- `waiting`, `blocked`, and `lost` release the slot.
- Per-Task quotas are deferred.

## Consequences

- User answers and resumes can start even when normal slots are full.
- Slot accounting must distinguish priority from normal.
- Worker capacity still limits total execution.
- New work cannot starve human interaction.
- Per-Task fairness is a later addition.

## Alternatives considered

- Global limit only: simple, but human answers can be delayed.
- Global plus per-Worker without priority: fairer than global-only, but still no human priority.
- Per-Task quotas in v0: useful, but extra policy before the core loop is proven.
