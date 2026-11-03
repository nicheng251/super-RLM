# ADR 0007: First-Class CLI Pages Are a Long-Term Requirement

Status: accepted (requirement); implementation choice open  
Date: 2026-11-02

## Context

Pi Agent extensions can render temporary custom screens with `ctx.ui.custom()`. This is useful for a dashboard or dialog, but the screen temporarily takes over the interactive area and returns to chat when it closes.

The project needs a persistent, switchable CLI workspace with pages such as Chat, Tasks, Task Detail, Workers, and Events. This is a product-level UI, not a single extension dialog.

## Decision

The long-term CLI must be a first-class page shell.

- The shell owns navigation, page lifecycle, focus, global keybindings, and the status bar.
- The Chat page hosts the Router Pi Agent session.
- The other pages read from the Orchestrator API and do not own task state.
- Pi Agent provides the agent engine and TUI primitives; it is not required to remain the top-level binary.
- A headless CLI path stays available for scripts and automation.

The implementation choice is still open:

1. Own TUI shell built on `@earendil-works/pi-tui` and the Pi Agent SDK.
2. Fork Pi's interactive mode and add a page manager.
3. Upstream a first-class page API to Pi.

## Consequences

- The UI is no longer limited to extension dialogs.
- The project owns more UI code: page manager, navigation, focus, status, data subscriptions.
- Pi's exported TUI components and SDK reduce the amount of chat UI that must be rebuilt.
- Pi versions must be pinned; a fork would require ongoing upstream merges.
- The Router remains one page, not the whole product.

## Alternatives considered

- Extension-only custom screens: fast to prototype, but not persistent first-class pages.
- Separate web UI: possible, but the requirement is a CLI workspace.
- Fork immediately without evaluating an own shell: higher long-term maintenance risk.
