# Real-model regression harness

Manual, opt-in regression tests that drive the real local stack
(Orchestrator -> Worker -> Prime Agent) against the live DeepSeek API.

This harness is **not** part of the unit test suites and is not run by CI. It
exists for deliberate end-to-end checks before a release or after a runtime
change.

## Cost warning

These cases call the real DeepSeek API with provider `deepseek` and model
`deepseek-flash`. Each selected case creates a real Task and Ticket, runs a
Prime Agent session, and may spawn subagents inside that session. A full run
(three cases) can make several model calls and costs real money. Run it
sparingly and prefer `--case report` for a cheap smoke test.

## Requirements

- Windows host with Git Bash available (the Worker uses it for Prime Agent
  `bash`).
- Python 3.11 or newer to run this script.
- Node.js >= 22.19 on `PATH` (required by the Orchestrator).
- Worker virtualenv: `apps/worker/.venv/Scripts/python.exe`.
- Prime Agent binary: `runtime/prime-agent/prime-agent.exe`.
- Prime Agent kernel venv at `<home>/prime/kernel-venv`, or a complete venv
  passed explicitly with `--kernel-venv`. There is no silent fallback.
- `<home>/prime/agent/models.json` with the `deepseek` provider and
  `deepseek-flash` model (for example from `super-rlm models sync`).
- `DEEPSEEK_API_KEY` in the process environment or in
  `<home>/secrets/providers.env`. The harness reads it and passes it only to
  the Worker environment. It never prints or writes the key.
- Ports 18810 and 18090 free. Stop any `super-rlm up` instance for the same
  home first: the Orchestrator holds a single-instance lock in the home.
- The Router is not started by this harness. It talks to the Orchestrator HTTP
  API directly.

## Test home

Point `--home` at a disposable test project. Runs append real Tasks, Tickets,
workspaces, Prime sessions, and logs to that home. Never point this harness at a
production home. Existing completed Tasks do not affect a run; every case gets
new Task and Ticket IDs. Run only one Orchestrator or harness per home at a time
because the Orchestrator holds a directory lock.

## Usage

```bash
python scripts/regression/real_model.py --help

# Full run against the prepared DeepSeek home.
python scripts/regression/real_model.py

# The project home has no kernel venv in some setups; pass one explicitly.
python scripts/regression/real_model.py \
  --kernel-venv C:/Users/15065/.super-rlm/projects/prj_spike_local/prime/kernel-venv

# Cheap single case.
python scripts/regression/real_model.py --case report --timeout 300

# Continue after a failed case.
python scripts/regression/real_model.py --keep-going --timeout 600
```

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--home` | `~/.super-rlm/projects/prj_deepseek` | Project home with `secrets/`, `prime/`, `orchestrator/`, `workspaces/`. |
| `--orchestrator-port` | `18810` | Local Orchestrator port. |
| `--worker-port` | `18090` | Local Worker port. |
| `--case` | all | Repeatable case name: `report`, `file`, `hitl`. |
| `--keep-going` | off | Run the remaining cases after a failure. Without it the run stops at the first failure. |
| `--timeout` | `900` | Per-case deadline in seconds, including the HITL waiting phase. |
| `--kernel-venv` | `<home>/prime/kernel-venv` | Prime Agent kernel venv. Pass the spike venv explicitly if the project venv is absent. |
| `--log-dir` | `<home>/regression/logs/<run_id>` | Child process logs. |

## Cases

| Case | What it does | Assertions |
| --- | --- | --- |
| `report` | Tells the Ticket to call `super_rlm_report(state='completed', ...)` with a run-specific marker. | Task and Ticket `succeeded`; Ticket result contains the marker. |
| `file` | Tells the Ticket to create `hello.txt` in its workspace with exactly `super-rlm-regression-hello` and one trailing newline, then report completed. | Task and Ticket `succeeded`; file exists; content matches exactly (one trailing newline allowed). |
| `hitl` | Tells the Ticket to report `waiting` with question `Linux or Windows?`; the harness posts `ticket_answer` with `Linux` and waits. | Waiting was observed; answer accepted; Task and Ticket `succeeded`; Ticket result mentions Linux. |

The Worker's report enforcement prompt still applies: a turn that ends without
a terminal report gets one enforcement prompt.

## L3 Chat

`l3_chat.py` is a separate manual test for the L3 Chat path. It starts the
same Orchestrator and Worker, starts Pi in RPC mode with the Router extension,
sends one real Chat prompt, and verifies that the Router delegates a Ticket
whose Worker file is delivered to the launch directory.

The harness creates a fresh launch directory at `<log-dir>/origin` and sets
`SUPER_RLM_ORIGIN_CWD` to it. It accepts `hello.txt` with the exact content
`hello from l3 chat` and at most one trailing newline.

Cost: one Chat turn (Router model) plus one Worker Ticket (Worker model). Stop
any `super-rlm up` instance for the same `--home` first; the Orchestrator
single-instance lock prevents a second instance, even on a different port.

Usage:

```bash
python scripts/regression/l3_chat.py --help

python scripts/regression/l3_chat.py \
  --kernel-venv C:/Users/15065/.super-rlm/projects/prj_spike_local/prime/kernel-venv

# Use a disposable home if you do not want to stop the normal services.
python scripts/regression/l3_chat.py --home <disposable-home> --log-dir <dir>
```

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--home` | `~/.super-rlm/projects/prj_deepseek` | Prepared project home with `secrets/`, `pi/agent/models.json`, `prime/agent/models.json`, and a kernel venv. |
| `--orchestrator-port` | `18840` | Local Orchestrator port. |
| `--worker-port` | `18098` | Local Worker port. |
| `--timeout` | `300` | Deadline in seconds for the delegated Task, after the Chat turn. |
| `--kernel-venv` | `<home>/prime/kernel-venv` | Prime Agent kernel venv. |
| `--log-dir` | `<home>/regression/logs/<run_id>` | Child logs and the `origin/` launch directory. |

Assertions:

- The Chat prompt reaches Pi (`prompt_seen`) and the turn settles without an abort.
- The Router calls `task_create`, does not call `task_wait`, returns assistant
  text, and raises no extension error.
- The Task is `succeeded`, the chosen Ticket is `succeeded` with profile
  `default`, the artifact is reported, and delivery has no error.
- `hello.txt` exists under the launch directory and contains exactly
  `hello from l3 chat` (one trailing newline allowed).

The harness appends `apps/router/prompts/router.md` exactly as the L3 TUI's
`buildRouterArgs` does. It prints one JSON summary on stdout; child logs are
under `--log-dir`. Exit codes are `0` pass, `1` setup/assertion/timeout failure,
`130` interrupted.

## Lifecycle and cleanup

1. Validate Node.js, the Worker venv, Prime Agent, the kernel venv, the model
   registry, the API key, and port availability.
2. Start the Orchestrator (`node apps/orchestrator/src/main.ts`) and the Worker
   (`apps/worker/.venv/Scripts/python.exe -m super_rlm_worker.main`) with
   project-local `SUPER_RLM_*` environment values.
3. Wait for `GET /health` and `GET /v1/health`. Worker registration happens
   automatically at startup.
4. Create one Task with one Ticket per selected case and poll
   `GET /v1/tasks/:id` with the per-case deadline.
5. On failure, read `GET /v1/tickets/:id/result` so the JSON summary includes
   the Ticket error, summary, and result. Timed-out and aborted Tasks are
   cancelled best-effort.
6. In all exit paths, kill the Worker process tree and then the Orchestrator
   process tree. On Windows this uses `taskkill /T /F`.

## Output and exit codes

Progress goes to stderr. stdout is a single JSON object:

```json
{
  "ok": false,
  "run_id": "20261104T120000Z_1234",
  "home": "...",
  "provider": "deepseek",
  "model": "deepseek-flash",
  "selected_cases": ["report", "file", "hitl"],
  "skipped_cases": [],
  "cases": [
    {
      "case": "report",
      "ok": true,
      "duration_s": 12.3,
      "task_id": "tsk_...",
      "ticket_id": "tkt_...",
      "task_status": "succeeded",
      "ticket_status": "succeeded",
      "ticket_summary": "...",
      "ticket_result": "...",
      "ticket_error": null,
      "assertions": [{"name": "task_succeeded", "ok": true, "detail": "..."}],
      "error": null
    }
  ],
  "error": null
}
```

Exit codes: `0` all selected cases passed; `1` setup error, assertion failure,
or timeout; `130` interrupted (cleanup still runs). `ticket_result` is clipped
to 8000 characters in the summary.

Child logs are written under the log directory, for example
`<home>/regression/logs/<run_id>/orchestrator.log` and `worker.log`. Logs are
not printed because they may contain provider diagnostics. The harness does not
write the key to these logs; treat them as sensitive anyway.

## How to add a case

Keep cases explicit and structured:

1. Add the name to `CASES` in `real_model.py`.
2. Add a `CaseDefinition` in `build_cases()`. Give it a short title, a prompt
   that tells the Ticket to use `super_rlm_report`, and a verifier function.
3. The verifier receives `CaseData` (`task`, `ticket`, `result`, `workspace`,
   and HITL fields) and returns a list made with `_assertion(name, ok, detail)`.
   Assert Task/Ticket status and structured result/file fields. Do not infer
   success from prose in the Ticket summary.
4. Mark `hitl=True` only if the case reports `waiting` and needs an answer.
   The generic loop posts `ticket_answer` once.
5. Add the case to the table above.

Do not add real-model cases to `apps/worker/tests` or the Orchestrator
`node:test` suites. This harness stays manual.
