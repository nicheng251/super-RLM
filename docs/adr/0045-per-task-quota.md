# ADR 0045: Per-Task Concurrency Quota

Status: accepted  
Date: 2026-11-02

## Context

A Task can create up to 16 Tickets. Without a per-Task limit, one Task can occupy all global slots.

## Decision

- Add `max_concurrent_tickets_per_task` (default 2).
- Normal Tickets of a Task beyond the quota stay `queued`.
- The priority slot for `ticket_answer`/`ticket_resume` is not blocked by the per-Task quota.
- The global and per-Worker limits still apply.

## Consequences

- One Task cannot starve others.
- Large Tasks progress in waves.
- The Router should prefer fewer, larger Tickets.
- Quota values are configurable.

## Alternatives considered

- No per-Task quota: one Task can hog capacity.
- Strict per-Task serial execution: too slow.
