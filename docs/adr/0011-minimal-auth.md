# ADR 0011: Minimal Service Authentication

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent runs its Engine and Executor in one process, so it has no inter-service authentication. super-RLM separates Router, Orchestrator, and Worker, and may run them across Docker containers.

The boundaries still need basic protection against accidental or forged calls, without building a full identity system in v0.

## Decision

v0 uses minimal service authentication.

- Scoped bearer tokens for Router/UI and Worker.
- HMAC-signed Worker reports and user callbacks, with timestamp and nonce.
- Orchestrator binds `127.0.0.1` locally and a private Docker network remotely.
- Secrets live in `<stateDir>/secrets/` with 0600 permissions or Docker secrets.
- Tokens are never written to prompts, logs, or task results.
- No OIDC, JWT, mTLS, user accounts, or automatic rotation in v0.

## Consequences

- The implementation is small and language-neutral.
- Forged reports and callbacks are rejected without a full identity provider.
- Key rotation and multi-host trust are manual until a later ADR.
- Scopes can expand without changing the domain model.
- A public API, if added, will need a separate admission and rate-limit layer.

## Alternatives considered

- No authentication in v0: acceptable only for a local PoC, but creates rework.
- mTLS: stronger, but certificate management is too heavy for v0.
- OIDC/JWT: appropriate for multi-user or organizational deployment, not v0.
