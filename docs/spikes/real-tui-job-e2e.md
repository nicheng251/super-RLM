# Real TUI + Job + DeepSeek E2E

Status: passed (one content caveat, see Delivered file)
Date: 2026-11-05

## What was tested

The real `super-rlm` TUI stack: CLI -> Windows Job supervisor -> Orchestrator +
Worker + Pi Router TUI, with the Worker running a DeepSeek Prime Agent session.
The TUI ran in a real Windows ConPTY (pywinpty), not a pipe or a mocked UI.

## Environment

- Temp home: `C:/Users/15065/Project/super-RLM/.tmp/real-tui-e2e-20261105T211416/home`
- Disposable origin: `.../real-tui-e2e-20261105T211416/origin`
- Orchestrator: `127.0.0.1:57241`
- Worker: `127.0.0.1:57242`
- Prime daemon socket: `<home>/prime/daemon/worker.sock`
- Kernel venv: reused `C:/Users/15065/.super-rlm/projects/prj_deepseek/prime/kernel-venv`
- Model: `deepseek/deepseek-flash`, thinking `medium` (Router and Worker default profile)
- Secrets: copied from the user project without printing; the CLI generated
  `<home>/secrets/api.env`. No user daemon (16140, 13960) was touched.

## Exact commands

Launcher (real PTY, no args = TUI stack):

```bash
cd C:/Users/15065/Project/super-RLM
uv run --with pywinpty -- python <temp>/drive_tui.py \
  --env-json <temp>/env.json \
  --message-file <temp>/message.txt \
  --root <temp> --cwd <temp>/origin
```

The driver spawned `node apps/cli/src/main.ts` with:

```text
SUPER_RLM_HOME=<temp>/home
SUPER_RLM_PORT=57241
SUPER_RLM_WORKER_PORT=57242
SUPER_RLM_PRIME_DAEMON=<temp>/home/prime/daemon/worker.sock
SUPER_RLM_KERNEL_VENV=C:/Users/15065/.super-rlm/projects/prj_deepseek/prime/kernel-venv
SUPER_RLM_ORIGIN_CWD=<temp>/origin
```

One chat prompt was typed into the TUI editor and sent with Enter. It asked for
one default-profile Ticket that writes `hello.txt` with content
`hello from super-rlm job e2e` and reports it as an artifact.

The TUI became ready in 4 s (`Pi Router ready.`), the Router created the Task,
and the IDs appeared in the TUI chat.

## Task / Ticket

```text
Task:   tsk_7ffd560efe3a48fca7fe  succeeded
Ticket: tkt_b66191c9ff394d17a242  succeeded  (profile: default)
```

Ticket result: `summary` reported completion, `artifacts` = `hello.txt`,
`delivered_to` = `<origin>/hello.txt`, `delivery_error` = null.
Worker log shows `POST /v1/executions` 202 and an `asg_...` assignment; the
Prime session JSONL records `provider: deepseek`, `modelId: deepseek-flash`,
`thinkingLevel: medium`, so this was a real model run.

## Delivered file

```text
<origin>/hello.txt
b'hello from super-rlm job e2e\n'
```

The bytes match the requested line, but the file ends with one LF. Strict
byte equality against the no-newline literal fails. The Router had rewritten
the Ticket prompt to say "no trailing extra lines beyond the final newline of
the line itself", and the Worker wrote exactly that. This is prompt
normalization, not a delivery defect; delivery used `copy2` and preserved the
workspace bytes.

## Job supervisor evidence

Supervisor pid 16400; TUI pid 13232, Orchestrator 14820, Worker 18504 were its
direct children. Job name: `super-rlm-default-1793884487396`.

`IsProcessInJob` against the named job returned true for all of:

```text
tui 13232, router pi 13036, worker 18504, worker python 12844,
prime daemon 20444, daemon worker 15268, kernel repl 12452, kernel python 2272
```

The supervisor itself returned false, as expected. This confirms the TUI and
every descendant (Router Pi, daemon, kernel) inherited the Job with
`KILL_ON_JOB_CLOSE`.

## Shutdown

`/quit` was typed into the TUI. TUI exit code 0; supervisor log:

```text
[super-rlm] no active tasks to cancel
[super-rlm] worker accepted shutdown
[super-rlm] Prime Agent daemon stopped
[super-rlm] worker stopped
[super-rlm] orchestrator stopped
```

Post-shutdown checks for the temp home:

```text
orchestrator  down    pid=- http://127.0.0.1:57241/health
worker        down    pid=- http://127.0.0.1:57242/v1/health
supervisor    down pid=-
daemon        down pid=-
```

- All recorded PIDs were gone.
- Ports had no LISTENING sockets (only TIME_WAIT).
- `<home>/supervisor.pid`, `orchestrator/orchestrator.pid`, `worker/worker.pid`
  were removed.
- The temp daemon socket did not exist.
- No process command line contained the temp home path (apart from the check
  itself).

## Product bugs

None found. The stack started, dispatched, executed, delivered, and shut down
cleanly. The only caveat is the Router's lossy rewrite of "exact content" to
allow a final newline; if byte-exact output is required, the Router prompt
should be tightened or the check should compare line content.
