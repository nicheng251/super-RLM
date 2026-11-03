# ADR 0001: Router runs on Pi Agent CLI

Status: accepted  
Date: 2026-11-02

## Context

The original design borrowed dsh-superagent's Engine and main-session concepts, but dsh-superagent is a DeepSeek Harness plugin. Keeping it would couple super-RLM to a specific harness and its event model.

The project needs a user-facing agent that can:

- talk to a human in a terminal;
- decide how to split work;
- call control-plane tools;
- avoid executing work itself.

Pi Agent already provides a mature CLI, session management, model runtime, extensions, and custom tools. It can be configured with no built-in execution tools.

## Decision

The Router is a Pi Agent CLI session with a super-RLM extension.

- The extension registers only control-plane tools.
- Built-in tools are disabled.
- The Router never executes tasks, reads files, or runs shell commands.
- The Router talks to the Orchestrator through its tool API.

## Consequences

- The user gets a familiar Pi CLI experience.
- The Router's agent loop and UI are maintained by Pi.
- The super-RLM codebase focuses on control-plane and execution integration.
- The Router must be protected from accidentally enabling built-in tools.
- Pi Agent versions must be pinned and tested.

## Alternatives considered

- Build a custom TS chat UI on the Pi SDK: more control, more maintenance.
- Keep dsh-superagent's main session: strong coupling to DeepSeek Harness.
- Use a plain HTTP API only: loses conversational clarification and status reporting.
