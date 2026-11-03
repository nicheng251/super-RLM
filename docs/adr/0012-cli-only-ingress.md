# ADR 0012: CLI-Only Ingress in v0

Status: accepted  
Date: 2026-11-02

## Context

The original design was API-first: external systems submit tasks through `POST /v1/tasks`.

The project direction changed: the user interacts with the Router through the Pi Agent CLI. dsh-superagent also has no public task-submission API; it is an event-driven plugin with a panel.

A public API adds admission, API keys, rate limits, quotas, abuse controls, callback SSRF protection, and audit requirements. Those are platform concerns that should not block the core execution loop.

## Decision

v0 is CLI-only.

- The Pi CLI / super-RLM CLI is the only user ingress.
- The Orchestrator HTTP API is internal: Router/UI and Worker only.
- Orchestrator binds `127.0.0.1` locally and a private Docker network remotely.
- No public `POST /v1/tasks` is exposed.
- The internal API shape should remain compatible with a future public API.
- A future public API must sit behind a separate admission/API gateway.

## Consequences

- v0 authentication stays minimal.
- No public rate limiting, quotas, or abuse handling are needed yet.
- External systems cannot submit tasks directly until the public API is added.
- The Orchestrator must not be exposed directly when a public API is introduced.
- The internal API can be reused by the gateway.

## Alternatives considered

- CLI + public API in v0: adds platform work before the core loop is proven.
- API-first with the CLI as a client: clean, but still requires public admission and abuse controls in v0.
