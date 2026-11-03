# ADR 0016: Named Worker Profiles

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent configures its Executor globally: worker model, concurrency, ticket directory root, prepare command, and blocked commands. super-RLM's Router splits work, so different Tickets may need different capability levels.

Letting the Router choose arbitrary models, thinking levels, or limits would create cost and permission risks. Letting the Orchestrator choose with an LLM would violate the no-LLM control-plane rule.

## Decision

Worker capabilities are admin-defined named profiles.

- The Router selects a profile by name in `task_create`.
- A read-only `profile_list` tool returns names and descriptions.
- Profiles reference Model Registry aliases, not raw API keys.
- Profile fields in v0: `model`, `thinking`, `max_depth`, `timeout_s`, `prepare_command`, `blocked_commands`.
- `concurrency` is global to the Orchestrator, not per profile.
- Unknown profile names are rejected by the Orchestrator.
- Profiles contain no credentials.

## Consequences

- The Router can choose capability, not arbitrary provider configuration.
- Cost, model, and recursion limits stay under admin control.
- The Router needs the profile list in its tool surface or prompt.
- Model Registry aliases decouple profiles from provider credentials.
- Adding a profile does not change the API schema.

## Alternatives considered

- One default profile: simplest, but no capability differentiation.
- Router supplies arbitrary model/thinking/limits: too much cost and permission risk.
- Orchestrator auto-selects: requires rules or an LLM, violating the control-plane boundary.
