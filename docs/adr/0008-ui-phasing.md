# ADR 0008: UI Phasing - L2 Extension Pages Now, L3 First-Class Shell Later

Status: accepted  
Date: 2026-11-02

## Context

First-class CLI pages are a long-term requirement, but building the full TUI shell immediately adds significant UI work before the core task/worker loop is proven.

Pi extensions can build switchable screens with `ctx.ui.custom()` now. These screens are temporary but sufficient for a concept proof.

## Decision

UI work is phased.

### Phase 1: L2 extension pages

- Build a Pi extension with commands such as `/tasks`, `/task`, `/workers`.
- Use `ctx.ui.custom()` for switchable, full-area screens.
- Prove the page model, data flow, keybindings, and actions.

### Phase 2: L3 first-class TUI shell

- Build a first-class page shell using Pi TUI and the Pi Agent SDK.
- Keep L2 as a fallback and lightweight path.

Both phases must share:

- the same page model / view-model;
- the same Orchestrator client;
- the same actions and permissions.

Business logic must not be embedded in Pi extension UI code.

## Consequences

- The project gets an early end-to-end UI without committing to a large TUI build.
- The page model is validated before the shell is written.
- Phase 2 can reuse the page model and data layer.
- Two UI implementations coexist temporarily; shared abstractions must stay small and real.
- L2 remains useful for debugging and environments where the full shell is unavailable.

## Alternatives considered

- Build L3 immediately: cleaner final architecture, but delays proof of the core system.
- Extension-only forever: rejected; not first-class pages.
