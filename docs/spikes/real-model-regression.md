# Real-model regression run

Status: passed  
Date: 2026-11-04  
Run: `20261104T092740Z_5348`

## Environment

- Orchestrator on `127.0.0.1:18810`
- Worker on `127.0.0.1:18090`
- Provider `deepseek`, model `deepseek-flash`
- Home: `C:/Users/15065/.super-rlm/projects/prj_deepseek`
- Kernel venv: `<home>/prime/kernel-venv` (created with `super-rlm bootstrap`)
- Router not started; the harness uses the Orchestrator HTTP API directly.

## Results

| Case | Result | Task / Ticket | Time |
| --- | --- | --- | --- |
| `report` | passed | `succeeded` / `succeeded` | 11.20s |
| `file` | passed | `succeeded` / `succeeded` | 9.17s |
| `hitl` | passed | `succeeded` / `succeeded` | 9.19s |

Ticket results:

```text
report: REGRESSION_OK_483db64c
file:   hello.txt contains super-rlm-regression-hello
hitl:   The user answered verbatim: "Linux" - platform answer: Linux.
```

HITL observed the question `Linux or Windows?`, posted `ticket_answer` with
`Linux`, and the resumed Prime Agent session reported completed.

## Reproduce

```bash
cd C:/Users/15065/Project/super-RLM
python scripts/regression/real_model.py --timeout 600
```

The harness starts and stops both services, prints one JSON summary to stdout,
and writes child logs under `<home>/regression/logs/<run_id>/`.

This is a manual, paid check. It is not part of the unit test suites.
