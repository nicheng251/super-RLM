# ADR 0034: Model Selection Is Explicit in v0

Status: accepted  
Date: 2026-11-02

## Context

Task-aware model selection is valuable long-term: research, coding, review, and fast utility tasks may benefit from different models. In early development, automatic selection would be hard to evaluate and could obscure cost and quality issues.

## Decision

v0 uses explicit profile selection.

- The Router chooses a profile by name in `task_create`.
- Each profile maps to a fixed Model Registry alias.
- No automatic classifier or Orchestrator model routing in v0.
- `profile_list` exposes names, descriptions, and model aliases.
- Task-aware selection can later be added by improving how the Router chooses a profile, without changing the Ticket schema.

## Consequences

- Model choice is predictable and auditable.
- Cost and quality can be measured per profile before automation.
- The profile abstraction keeps the API stable for future routing.
- The Router must make an explicit choice; omitted profile uses `default`.

## Alternatives considered

- Automatic model routing now: premature and hard to evaluate.
- Direct per-Ticket model IDs: bypasses admin control and profile limits.
