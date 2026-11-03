# ADR 0025: Minimal Observability

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent is a single process with structured state, notices, a panel, and logs. super-RLM spans Orchestrator, Worker, Prime Agent, and RLM child sessions, so correlation across services is necessary.

A full OpenTelemetry/Prometheus/Grafana stack adds infrastructure before the core loop is proven.

## Decision

v0 uses minimal observability:

- structured JSON logs;
- correlation IDs across all layers;
- append-only SQLite `events` table;
- SSE event streams with replay;
- basic metrics;
- Worker logs for ACP lifecycle, tool calls, RLM child starts/stops, and session paths;
- no secrets or full prompts in logs;
- configurable event retention.

OpenTelemetry, Prometheus, and Grafana are deferred. The event and metric shapes are designed so they can be added later.

## Consequences

- Debugging and UI refresh work without extra infrastructure.
- The event table grows and needs retention.
- Log redaction is mandatory.
- Cross-service correlation depends on disciplined ID propagation.
- Full distributed tracing is a later addition.

## Alternatives considered

- Full observability stack in v0: too much infrastructure.
- Text logs only: insufficient for UI and cross-service debugging.
