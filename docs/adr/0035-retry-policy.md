# ADR 0035: Retry, Backoff, and Error Taxonomy

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent retries transient provider/network failures with a growing backoff, retries launch failures, and does not retry prepare/config failures. Host restarts create a new Assignment with a recovery note.

super-RLM needs a small, explicit taxonomy so transient failures recover without creating infinite loops or duplicating external actions.

## Decision

- Every error carries `code`, `message`, `retryable`, `source`, and `details`.
- Categories: `transient`, `worker_lost`, `startup`, `missing_report`, `config`, `workspace`, `protocol`, `timeout`, `cancelled`.
- `transient`, `worker_lost`, `startup`: up to 3 attempts, backoff 2s/5s/15s with jitter.
- `missing_report`: at most one retry.
- `config`, `workspace`, `timeout`, `cancelled`: no automatic retry.
- Retries create a new Assignment but keep `session_ref`.
- Retry prompts include a recovery note: inspect state, do not repeat completed external actions, finish the original assignment.
- The Orchestrator owns assignment-level retry; Prime Agent keeps provider-level retries.

## Consequences

- Transient failures recover without user action.
- Configuration and cancellation failures fail fast.
- External side effects are not automatically repeated.
- Retry storms are bounded.
- Error codes become part of the API contract.

## Alternatives considered

- No automatic retries: too fragile.
- Unlimited retries: can loop forever.
- A large per-error matrix: unnecessary for v0.
