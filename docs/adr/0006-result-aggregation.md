# ADR 0006: Task Result Aggregation by the Router

Status: accepted  
Date: 2026-11-02

## Context

A Task may contain several independent Tickets. Each Worker returns a result for its Ticket. The system needs a final answer for the user, but the Orchestrator must remain deterministic and must not call an LLM.

dsh-superagent has no Task-level result aggregation: each Ticket reports through its own Channel, and the main Session relays or explains results to people.

## Decision

The Orchestrator stores per-Ticket facts:

- `summary`: a short, user-readable summary;
- `result`: the full result;
- `artifacts`: files, URLs, or other outputs;
- `usage`;
- `error`;
- `session_ref`.

The Router aggregates:

- `task_wait` returns Task status plus each Ticket's status and summary;
- `ticket_result` returns the full result for one Ticket;
- the Router decides how to summarize, compare, or report the results.

The Orchestrator does not concatenate results, does not create a finalizer Ticket, and does not call an LLM.

## Consequences

- The Orchestrator stays deterministic and testable.
- The Router can keep its context small by reading summaries first and full results only when needed.
- Results survive Pi CLI restarts.
- The Router is responsible for explaining partial failures and deciding whether to retry.
- A future finalizer Ticket is possible only if the Router creates it explicitly.

## Alternatives considered

- Orchestrator concatenates raw results: simple, but unstructured and still needs Router interpretation.
- Orchestrator creates a finalizer Ticket: violates the rule that only the Router splits work.
- Orchestrator calls an LLM: violates the no-LLM control-plane rule.
