# ADR 0002: Independent Tickets, no Ticket DAG

Status: accepted  
Date: 2026-11-02

## Context

The Router splits a user request into Worker tasks. The first design question was whether Tickets should support dependencies (`depends_on`) and form a DAG, or remain independent.

dsh-superagent, the reference for the control-plane model, uses independent Tickets:

- a Thread may carry several Tickets;
- Tickets are units of authorized work, not workflow nodes;
- there is no `depends_on`, parent/child Ticket, or topological scheduling;
- multi-step work lives inside the Executor session;
- Thread subscriptions and pull-request follows provide event-driven continuation, not Ticket dependencies.

The project principle is to prefer dsh-superagent's design when it covers the need.

## Decision

v0 uses independent Tickets. There is no Ticket DAG.

- The Router may create multiple Tickets for one Task.
- Those Tickets run independently and concurrently, subject to Worker capacity.
- A multi-step task that must run in order is either kept inside one Ticket, where Prime Agent plans and sequences it, or split by the Router into successive rounds of independent Tickets.
- The Orchestrator does not implement dependency edges, readiness propagation, or failure propagation between Tickets.

## Consequences

- The Orchestrator state machine stays small: queue, assign, run, report, retry, cancel.
- Prime Agent remains responsible for internal sequencing and recursion.
- The Router must decide when a request is one Ticket versus several independent Tickets.
- Cross-Ticket ordering is not automatically enforced; the Router must use multiple rounds or keep the work in one Ticket.
- A future requirement for cross-Worker ordering should be handled by a new ADR, not by silently extending the Ticket model.

## Alternatives considered

- Minimal Ticket DAG with `depends_on` and topological scheduling: more expressive, but adds a workflow-engine concept that dsh deliberately avoids.
- A separate workflow service: rejected for v0; too much coupling and overhead.
