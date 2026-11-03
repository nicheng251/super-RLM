# ADR 0003: Worker Topology

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent gives each Ticket its own Executor Session and directory, with a configured number of worker slots. A Ticket holds a slot from launch through its active turn; background work keeps the slot. dsh does not use a pre-warmed worker pool.

Prime Agent's ACP mode creates a normal daemon-backed session. One `prime-agent --mode acp` process hosts one ACP session and can spawn RLM children internally.

## Decision

v0 uses:

- one Ticket = one Prime Agent ACP process/session;
- one workspace per Ticket;
- a shared Worker service that supervises per-Ticket ACP processes;
- a global concurrency limit enforced by the Orchestrator, not by the Worker;
- one shared Prime Agent daemon for v0.

The Worker service does not schedule Tickets. It accepts an assignment, starts the ACP session, reports progress, and exits the session when the Ticket ends.

## Consequences

- Each Ticket gets the same core Prime Agent capabilities as a normal daemon session: persistent kernel, tools, skills, `rlm.spawn`, compaction, goals.
- Ticket-level crash isolation: one ACP process/session failing does not stop other Tickets.
- Shared daemon remains a shared failure domain; per-Ticket daemon or container isolation is a later option.
- The Worker service must enforce per-Ticket workspace and process boundaries.
- The Orchestrator owns the global slot count and assignment leases.
- MCP servers, skills, model, and system prompt must be passed explicitly by the Worker for capability parity.

## Alternatives considered

- One Worker container per Ticket: stronger isolation, heavier v0.
- Pre-warmed Worker pool: lower latency, higher idle cost, and not the dsh model.
- Multiple Tickets sharing one Prime Agent session: rejected; session state would leak between Tickets.
