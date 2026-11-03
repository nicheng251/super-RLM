# ADR 0017: Worker Registration, Heartbeat, and Push Dispatch

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent launches Executor sessions inside the Harness process, so it has no network dispatch problem. super-RLM separates Orchestrator and Worker.

A static worker list is simple but requires configuration changes for every new worker. Pull dispatch is resilient but adds polling latency and a claim protocol.

## Decision

v0 uses push dispatch with worker self-registration.

- Worker registers with `POST /internal/v1/workers/register`.
- Worker sends periodic heartbeats with `running` and `max_concurrency`.
- Orchestrator stores worker URL, capacity, running count, and last heartbeat.
- Orchestrator pushes `POST /v1/executions` to a worker with free capacity.
- `202` accepts; `409` means full, so the Orchestrator tries another worker.
- A missed heartbeat marks the worker `lost`; its assignments become `lost` and follow retry policy.
- No pull mode in v0.

## Consequences

- New workers join without editing Orchestrator configuration.
- Dispatch latency is low.
- The Orchestrator needs a worker registry table and heartbeat timeout handling.
- Worker URLs must be reachable on the internal network.
- Lost workers can cause assignment retries; idempotency is required.
- A pull mode can be added later as a fallback.

## Alternatives considered

- Static worker list: simplest, but poor for dynamic scaling.
- Pull dispatch: resilient, but higher latency and a claim/lease protocol.
- Hybrid push/pull: more complexity than v0 needs.
