# Spike Plan

Status: both spikes passed on 2026-11-03. Results: `pi-router.md` and `prime-acp.md`.

## Spike 1: Pi Router extension

Question: can a Pi Agent extension run with only control-plane tools and reliably call the Orchestrator API?

Scope:

- project-local Pi extension;
- `defaultTools: []` or `noTools: "builtin"`;
- custom tools: `profile_list`, `task_create`, `task_status`, `task_wait`, `ticket_result`;
- mocked Orchestrator HTTP server;
- confirm the model never tries shell/file tools.

Deliverable: `docs/spikes/pi-router.md`

## Spike 2: Prime Agent ACP

Question: can a Python ACP client drive a Prime Agent session that recursively spawns RLM children and returns a final result?

Scope:

- launch `prime-agent --mode acp` with project-owned agent/session dirs;
- `initialize` -> `session/new` -> `session/prompt`;
- prompt asks for two `rlm.spawn` children in parallel;
- collect streamed events and final answer;
- verify subagent completion and session file location.

Deliverable: `docs/spikes/prime-acp.md`

## Rules

- Use faux/scripted providers where possible; do not spend real model budget without approval.
- Write findings and blockers to the deliverable file.
- Do not start the full implementation until both spikes pass or their blockers are understood.
