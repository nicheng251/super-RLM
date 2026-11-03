# ADR 0026: Testing Strategy

Status: accepted  
Date: 2026-11-02

## Context

super-RLM spans Orchestrator, Worker, Prime Agent, and RLM child sessions. Real-model tests are slow, costly, and non-deterministic, but the system's effectiveness ultimately needs real end-to-end validation.

## Decision

v0 uses a test pyramid:

- unit tests for domain logic and repositories;
- contract tests for OpenAPI/JSON schemas and generated clients;
- integration tests with fake Worker/ACP;
- small E2E with Prime Agent faux providers;
- fault tests for worker loss, leases, resume, duplicate reports, and restarts.

CI uses fake/faux providers and no real model keys.

Real-model E2E is a later effectiveness-validation phase, not a per-PR gate.

## Consequences

- Fast, deterministic CI.
- The core state machine and protocols are covered before real models.
- Fakes must be kept faithful to the real contracts.
- Real-model behavior is validated later, with its own budget and flakiness policy.
- Fault injection becomes a first-class test category.

## Alternatives considered

- Heavy real E2E in every PR: too slow, expensive, and flaky.
- Manual-only testing: insufficient for a concurrent, stateful system.
