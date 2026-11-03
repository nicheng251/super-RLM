# ADR 0027: L2 Page Scope and Shared Page Model

Status: accepted  
Date: 2026-11-02

## Context

L2 uses Pi extension custom screens for the concept proof. The long-term L3 shell will be a first-class TUI. Without a shared model, page logic would be written twice.

## Decision

L2 ships three pages:

- Chat;
- Tasks;
- Task Detail.

A UI-agnostic `PageModel` and `OrchestratorClient` are shared by L2 and L3.

- `PageModel` owns page state and actions.
- `OrchestratorClient` owns HTTP/SSE access.
- L2 adapters render with Pi TUI components and poll for refresh.
- L3 adapters render with the first-class shell and use SSE.
- Business logic does not live in either UI adapter.

Workers and Events pages are deferred.

## Consequences

- L2 proves navigation, data, HITL, and result viewing.
- L3 can reuse the page model instead of rewriting behavior.
- L2 uses polling; L3 uses SSE.
- Workers/Events remain later additions.
- The page model must stay free of Pi and TUI imports.

## Alternatives considered

- Chat + Tasks only: too little to prove HITL and results.
- All five pages: more UI work before the core loop is proven.
