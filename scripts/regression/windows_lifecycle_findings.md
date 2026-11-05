# Windows lifecycle regression findings

Run date: 2026-11-05

Command:

```bash
apps/worker/.venv/Scripts/python.exe scripts/regression/windows_lifecycle.py --real-prime
```

Result: **6/6 cases passed** in about 18 seconds, including the opt-in real
`prime-agent` admin smoke. No model calls were made.

## Finding 1: Worker PID files record the venv launcher, not the Worker PID

Severity: low (diagnostics and fallback cleanup). Not a P0-A1 lifecycle failure.

`job_supervisor.py` writes the PID returned by `subprocess.Popen`:

```python
process = subprocess.Popen([...], creationflags=flags, ...)
...
self._write_pid(child.get("pid"), process.pid)
```

On this Windows setup, the Worker venv uses a `python.exe` launcher. The
launcher starts the real Python interpreter, so `Popen.pid` and
`os.getpid()` inside the Worker differ:

```bash
apps/worker/.venv/Scripts/python.exe -c "import subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import os;print(os.getpid())'],stdout=subprocess.PIPE,text=True); print('Popen.pid',p.pid); print('child pid',p.communicate()[0].strip())"
```

Observed output:

```text
Popen.pid 18108
child pid 16216
```

The regression harness sees the same split. In `job_graceful`,
`run/worker.pid` and `run/tui.pid` contain the launcher PIDs, while the dummy
children report different PIDs in `state/worker/ready.json` and
`state/tui/started.json`. With the real Worker, the launcher PID in
`worker.pid` differs from the PID in the uvicorn log line
`Started server process [...]`.

Impact:

- `super-rlm status` and `super-rlm down` print the launcher PID, not the PID
  of the process that serves `/v1/health`.
- `apps/cli/src/services.ts::stopService` signals the PID from the file. On this
  host, killing the launcher also ended the real child, so the fallback still
  worked in testing. The primary path is unaffected: the Job owns both
  processes and `KILL_ON_JOB_CLOSE` kills both.
- Tooling that expects the PID file to identify the Worker image or process
  tree sees the launcher instead.

Follow-up: the Worker now writes its own `worker.pid` from the serving
interpreter during lifespan startup and removes it on graceful shutdown. The
supervisor's launcher-PID file is overwritten by the real Worker PID. The
hard-kill path still leaves stale PID files, which `status`/`down` gate on
liveness.

## Finding 2: A hard-killed supervisor leaves stale PID files

Severity: informational. This is existing behavior, not a regression.

When the supervisor is terminated with `TerminateProcess`, its `finally` block
cannot run, so `supervisor.pid`, `orchestrator.pid`, `worker.pid`, and
`tui.pid` remain. The Job still kills every child. The CLI gates these files on
`isProcessAlive`, so `status` does not report a running stack and `down` removes
them. The harness records the remaining files as an observation and does not
fail the case.

## Validation summary

- Job `KILL_ON_JOB_CLOSE` flag observed as `LimitFlags=0x00002000` in the
  graceful and kill cases.
- TUI exit 0 ran the graceful path: active Task cancel, Worker shutdown, and
  `prime-agent shutdown --force --json`.
- TUI exit 3 closed the Job with terminate and returned 3.
- Terminating the supervisor killed the TUI, Orchestrator, Worker launcher, and
  real Worker/child PIDs.
- Worker startup failure never started the TUI and left no orphan; the healthy
  Orchestrator was killed.
- Worker startup started one fake daemon; a second Worker reused it through a
  non-canonical socket spelling; the daemon survived both Workers; explicit
  shutdown stopped the zero-session daemon with `shutdown`, not `stop`;
  `PrimeDaemon.stop_session` returned true for an active session and false for
  an unknown one.
