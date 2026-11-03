---
name: super-rlm-report
description: Report the structured status of a super-RLM Ticket to the Worker. Use before ending every turn. States are completed, dropped, waiting, blocked, failed, progress.
---

# super-rlm-report

Call this skill before ending a turn. Natural language is not a report.

```python
await super_rlm_report(
    state="completed",
    summary="Short summary",
    result="Full result text",
    artifacts=[{"type": "file", "path": "out.md"}],
)
```

Rules:

- `waiting` means the user must answer a concrete question; include `question`.
- `blocked` means an external action is required; include `question`.
- `completed` means the requested deliverable is done; include `summary` and a result or artifacts.
- `dropped` means there was nothing to do; include `summary`.
- `failed` means the Ticket cannot succeed; include `summary` and `error`.
- `progress` is a non-terminal update.
- Never put the only copy of a question in prose. It must be in `question`.
