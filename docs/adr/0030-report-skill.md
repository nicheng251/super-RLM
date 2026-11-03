# ADR 0030: Worker Report Uses a Python Skill, Not MCP

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent gives its worker an `orchestrator_report` tool with structured state, summary, and human-action fields.

Prime Agent supports MCP tools, but it is an RLM whose native control surface is Python code in a persistent kernel. A Python-backed skill is simpler and more idiomatic than running an MCP server.

## Decision

The Worker report handoff uses a project-owned Python-backed skill:

```text
super-rlm-report
```

- The skill is loaded with an explicit `--skill` path.
- It installs into the project-owned kernel venv.
- The agent calls `await super_rlm_report(state=..., summary=..., ...)`.
- States: `completed | waiting | blocked | failed | progress`.
- `waiting` and `blocked` require a question.
- The skill posts to the Worker's per-assignment report endpoint with a local token.
- The Worker validates and forwards the report to the Orchestrator.
- A turn without a terminal report fails closed as `missing_report`.

## Consequences

- No MCP server or MCP configuration is needed.
- The handoff follows Prime Agent's code-as-control model.
- The skill and Worker endpoint are independently testable.
- Prompt and skill guidance must make the call mandatory.
- Missing reports are failures, not silent successes.

## Alternatives considered

- MCP `report_status`: structured, but adds a protocol surface and server lifecycle.
- Final JSON envelope: fragile parsing and no mid-turn reports.
- Natural-language heuristics: rejected as unreliable.
