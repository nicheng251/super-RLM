# Worker Report Skill Contract

Status: draft v0.1  
Last updated: 2026-11-02

## Purpose

The Worker must receive a structured handoff from the Prime Agent session, not parse natural language.

Prime Agent exposes the report as a project-owned Python-backed skill:

```text
super-rlm-report
```

## Skill layout

```text
apps/worker/skills/super-rlm-report/
  SKILL.md
  pyproject.toml
  src/super_rlm_report/__init__.py
```

The skill is loaded with an explicit `--skill` path. It is installed into the project-owned Prime Agent kernel venv, never a global venv.

## Call

```python
await super_rlm_report(
    state="completed",
    summary="Implemented the requested example.",
    question=None,
    result="...",
    artifacts=[{"type": "file", "path": "out.md"}],
)
```

## States

| State | Meaning | Requirement |
| --- | --- | --- |
| `progress` | Internal progress. | Optional. |
| `waiting` | Needs a user answer. | `question` required. |
| `blocked` | Needs an external action. | `question` required. |
| `completed` | Ticket succeeded. | `summary`; result or artifacts. |
| `dropped` | Nothing to do. | `summary`; no failure. |
| `failed` | Ticket failed. | `summary` and error description. |

## Delivery

- The skill reads `SUPER_RLM_REPORT_URL` and `SUPER_RLM_REPORT_TOKEN` from the environment.
- It posts the report to the Worker's per-assignment endpoint.
- The Worker validates the shape and state, then forwards it to the Orchestrator.
- The skill returns the Worker's acknowledgement to the kernel.
- The Worker rejects reports for an ended Assignment.

## Missing report

If the Prime Agent turn ends without a terminal report:

- the Worker reports `failed`;
- error code: `missing_report`;
- the Worker includes the last assistant text as context, not as a successful result.

This is fail-closed: a missing handoff never becomes a silent success.

## Skill prompt guidance

The skill's `SKILL.md` should tell the agent:

- call the skill before ending a turn;
- use `waiting` for a concrete user question;
- use `blocked` for an external blocker;
- use `completed` only when the requested deliverable is actually done;
- use `progress` for internal updates;
- never put a question only in prose.
