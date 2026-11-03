# ADR 0046: Duplicate and Overlap Prevention

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent's Eval avoids duplicate Tickets. super-RLM's Router can split overlapping work into multiple Tickets.

## Decision

- Router prompt: prefer one Ticket when unsure; do not create overlapping Tickets.
- Orchestrator rejects exact duplicate titles/prompts within one Task.
- Near-duplicate detection is a warning, not an automatic rejection.
- A future plan-review step can improve semantic deduplication.

## Consequences

- Obvious duplicates are stopped at creation.
- Semantic overlap remains a Router responsibility.
- The Router should explain why multiple Tickets are independent.

## Alternatives considered

- Automatic semantic deduplication: needs an LLM or embedding service.
- No checks: wastes slots and creates conflicts.
