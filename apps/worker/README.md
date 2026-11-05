# Worker

Python FastAPI adapter that runs one Prime Agent ACP process per Assignment.

## Run

```bash
cd apps/worker
uv venv --python 3.11 .venv
uv pip install --python .venv/Scripts/python.exe -e ".[dev]"

SUPER_RLM_HOME="$HOME/.super-rlm/projects/prj_slice" \
SUPER_RLM_ORCHESTRATOR_URL=http://127.0.0.1:8787 \
SUPER_RLM_WORKER_PORT=8080 \
SUPER_RLM_WORKER_TOKEN=worker-token \
SUPER_RLM_PRIME_AGENT="$PWD/../../runtime/prime-agent/prime-agent.exe" \
SUPER_RLM_KERNEL_VENV="$HOME/.super-rlm/projects/prj_slice/prime/kernel-venv" \
SUPER_RLM_KERNEL_PYTHON="$HOME/.super-rlm/projects/prj_slice/prime/kernel-venv/Scripts/python.exe" \
SUPER_RLM_REPORT_SKILL="$PWD/skills/super-rlm-report" \
SUPER_RLM_WORKER_PROMPT="$PWD/prompts/worker.md" \
SUPER_RLM_PRIME_PROVIDER=fake \
SUPER_RLM_PRIME_MODEL=fake-1 \
SUPER_RLM_MAX_CONCURRENCY=1 \
.venv/Scripts/python.exe -m super_rlm_worker.main
```

Node is not involved here. Prime Agent, its kernel venv, and the report skill are
project-owned assets. `PRIME_AGENT_KERNEL_VENV` and `PRIME_AGENT_KERNEL_PYTHON`
must point at a Python with `prime-agent-runtime`, `mcp`, `tyro`, and the
default Python packages.

## Routes

```text
GET  /v1/health
POST /v1/executions                    # Orchestrator -> Worker
POST /v1/executions/{id}/cancel
POST /v1/shutdown                      # Operator -> Worker (worker token)
POST /internal/assignments/{id}/report # super-rlm-report skill -> Worker
```

The report route requires the per-execution bearer token. The Worker writes
`<workspace>/.super-rlm-report.json` before every Assignment and sends its path
as `SUPER_RLM_REPORT_CONFIG`. The skill reads this file on every call because a
resident Prime Agent kernel keeps the first Assignment's environment across a
resume.

## Execution lifecycle

1. Create a per-Ticket workspace and session directory.
2. Resolve `ExecutionRequest.execution` into an execution plan, falling back to
   the Worker's global configuration when it is absent.
3. Run the one-time workspace preparation command, if configured.
4. Create `.super-rlm-bin` shims for blocked commands and prepend it to PATH.
5. Spawn `prime-agent --mode acp` with the profile provider/model/thinking,
   `agent_cwd` as its working directory, and the report skill.
6. `initialize` -> `session/new` -> `session/prompt`.
7. Record the durable `session_ref` from the session file.
8. The report skill posts `progress` / `waiting` / `blocked` / `completed` /
   `dropped` / `failed` / `cancelled` to the Worker.
9. On `completed`, the Worker normalizes artifact paths, runs the optional
   `metadata_command`, delivers results, and forwards the `WorkerReport`.
10. The Worker forwards a `WorkerReport` with a monotonic `seq`, idempotency key,
    and HMAC-SHA256 signature over `timestamp + nonce + raw body`.
11. A turn without a terminal report gets one enforcement prompt; still missing
    becomes `failed / missing_report`.
12. The Worker sends assignment heartbeats with the current phase.
13. `waiting` / `blocked` close ACP but keep the session file for `--resume`.

## Prime Agent daemon

The Worker starts one detached `prime-agent --mode daemon` per project at
startup and fails startup if the daemon cannot be reached. All Tickets share
that daemon; a Ticket ACP process is never the daemon owner, so finishing one
Ticket cannot stop the daemon for another.

The socket is canonicalized once (`abspath`, plus `normcase` on Windows) and the
same string is used for `PRIME_AGENT_DAEMON_SOCKET`, ACP `--daemon-socket`, and
every admin command. Admin commands (`status`, `stop`, `shutdown`) take the
socket from the environment only.

Cancelling or timing out a Ticket stops only that session with
`prime-agent stop <session-id> --json`, then cancels and terminates its ACP
process. Worker shutdown stops active Tickets and then runs
`prime-agent shutdown --force --json` and verifies that no daemon is current.
`POST /v1/shutdown` requests the same graceful uvicorn shutdown; it does not
tear down state inside the request handler.

## Execution profiles

The Orchestrator resolves one named execution profile per Ticket and sends the
resolved values in `ExecutionRequest.execution`. The Worker never reads
`config/profiles.yaml`. Every field falls back to the global environment when
`execution` is absent.

| Field | Effect |
| --- | --- |
| `provider`, `model` | `--provider` / `--model` for Prime Agent. |
| `thinking` | `--thinking`; one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `timeout_s` | Per-ACP-turn timeout for the Ticket and its enforcement prompt. |
| `prepare_command` | Per-profile override of `SUPER_RLM_PREPARE_COMMAND`. |
| `blocked_commands` | Command-name shims in `<workspace>/.super-rlm-bin`, prepended to PATH. |
| `workspace.agent_cwd` | Prime Agent's working directory, relative to the workspace. |
| `workspace.artifact_root` | Base for reported artifact paths; normalized to workspace-relative paths. |
| `workspace.metadata_command` | Optional command whose JSON stdout becomes `workspace_metadata`. |
| `delivery.*` | Overrides `SUPER_RLM_DELIVERY_*` for this Assignment. |

`agent_cwd` must be a relative path inside the workspace and must exist after
workspace preparation. `artifact_root` is a safe relative path; an artifact
path that already starts with the root is not prefixed twice. The Worker adds a
short execution-profile note (workspace root, agent cwd, artifact root, blocked
commands) to Prime Agent's system prompt through `--append-system-prompt`.

`metadata_command` runs in `agent_cwd` after a `completed` report. A failure or
non-JSON output is recorded as `metadata_error`; the Ticket still succeeds.

`blocked_commands` are policy aids, not a sandbox. Each shim prints a message
and exits 127 when called by name. Absolute paths and unlisted interpreters
still bypass them. Preparation commands are not blocked.

## Workspace preparation

Set `SUPER_RLM_PROJECT_REPO` to an existing checkout and
`SUPER_RLM_PREPARE_COMMAND` to a shell command. The Worker runs that command
once per Ticket, with the Ticket workspace as the working directory, before it
starts Prime Agent. This lets a Ticket work in a real repository instead of an
empty workspace.

The command runs through `SUPER_RLM_BASH_SHELL` with `-lc` on POSIX. On
Windows the Worker uses `bash.exe -lc`; `sh -c` is used only when no bash is
configured. The command inherits the Worker environment plus
`SUPER_RLM_HOME`, `SUPER_RLM_TICKET_ID`, `SUPER_RLM_ASSIGNMENT_ID`,
`SUPER_RLM_WORKSPACE`, `SUPER_RLM_PROJECT_REPO`, and
`SUPER_RLM_PREPARE_COMMAND`.

Example: create a per-Ticket git worktree inside the workspace. Use `./repo` in Git Bash; `$SUPER_RLM_PROJECT_REPO` should be a path Git for Windows understands, preferably `C:/...`.

```bash
git -C "$SUPER_RLM_PROJECT_REPO" worktree add ./repo -b "agent/$SUPER_RLM_TICKET_ID" main
```

On success the Worker writes `<workspace>/.super-rlm-prepared` with JSON
`{ticket_id, prepared_at, command}`. The marker makes preparation idempotent:
resume, retry, and reassignment skip it. Delete the marker to run the command
again. A nonzero exit or a timeout fails the Ticket with error code
`prepare_failed`, and Prime Agent is never started.

## Result delivery

When a Ticket reports `completed`, the Worker copies its reported artifacts
back to the directory where the Router was launched (`origin_cwd`, carried in
the assignment). Delivery is best-effort: a failure is recorded in the report
as `delivery_error` and never changes the Ticket state.

- `artifacts` (default) copies each reported file, preserving its relative
  path after an optional prefix strip.
- `workspace` copies the whole Ticket workspace to
  `<origin_cwd>/.super-rlm/<ticket_id>/`, excluding `.git`,
  `.super-rlm-report.json`, and `.super-rlm-prepared`.
- `none` disables delivery.

Absolute paths, `..` path segments, and paths that resolve outside the
workspace or origin directory are rejected. The default `version` collision
policy writes `<name>.super-rlm-<ticket_id><suffix>` instead of overwriting.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SUPER_RLM_ORCHESTRATOR_URL` | `http://127.0.0.1:8787` | Orchestrator base URL. |
| `SUPER_RLM_WORKER_ID` | host + pid | Worker identity. |
| `SUPER_RLM_WORKER_TOKEN` | `dev-worker-token` | Registration/heartbeat/report bearer token. |
| `SUPER_RLM_WORKER_HOST` | `127.0.0.1` | Bind address. |
| `SUPER_RLM_WORKER_PORT` | `8080` | Bind port. |
| `SUPER_RLM_MAX_CONCURRENCY` | `2` | Concurrent ACP processes. |
| `SUPER_RLM_HOME` | `~/.super-rlm/projects/default` | Project runtime root. |
| `SUPER_RLM_PRIME_DAEMON` | `<home>/prime/daemon/worker.sock` | Canonical project daemon socket. |
| `SUPER_RLM_DAEMON_AUTOSTART` | `true` | Start the project daemon when none is running. |
| `SUPER_RLM_DAEMON_START_TIMEOUT_S` | `30` | Daemon startup readiness timeout. |
| `SUPER_RLM_DAEMON_COMMAND_TIMEOUT_S` | `30` | Admin CLI command timeout. |
| `SUPER_RLM_DAEMON_SHUTDOWN_TIMEOUT_S` | `60` | Daemon shutdown timeout. |
| `SUPER_RLM_CANCEL_WAIT_S` | `10` | ACP cancel grace before terminating. |
| `SUPER_RLM_PRIME_AGENT` | repo `runtime/prime-agent` | Prime Agent binary. |
| `SUPER_RLM_PRIME_PROVIDER` | `fake` | Model provider. |
| `SUPER_RLM_PRIME_MODEL` | `fake-1` | Model id. |
| `SUPER_RLM_KERNEL_VENV` | `<home>/prime/kernel-venv` | Project kernel venv. |
| `SUPER_RLM_KERNEL_PYTHON` | venv python | Python inside the kernel venv. |
| `SUPER_RLM_BASH_SHELL` | Git Bash on Windows | POSIX shell for Prime Agent bash and workspace preparation. |
| `SUPER_RLM_PROJECT_REPO` | unset | Source checkout used by workspace preparation. |
| `SUPER_RLM_PREPARE_COMMAND` | unset | One-time workspace preparation command. |
| `SUPER_RLM_PREPARE_TIMEOUT_S` | `600` | Workspace preparation timeout. |
| `SUPER_RLM_DELIVERY_MODE` | `artifacts` | `artifacts`, `workspace`, or `none`. |
| `SUPER_RLM_DELIVERY_COLLISION` | `version` | `version`, `overwrite`, or `error`. |
| `SUPER_RLM_DELIVERY_STRIP_PREFIX` | unset | Artifact path prefix removed on delivery. |
| `SUPER_RLM_DELIVERY_WORKSPACE_SUBDIR` | `.super-rlm` | Subdirectory for `workspace` delivery. |
| `SUPER_RLM_METADATA_TIMEOUT_S` | `60` | `metadata_command` timeout. |
| `SUPER_RLM_REPORT_SKILL` | repo skill dir | `super-rlm-report` skill path. |
| `SUPER_RLM_WORKER_PROMPT` | repo prompt | Appended Worker system prompt. |
| `SUPER_RLM_TURN_TIMEOUT_S` | `3600` | Per-ACP-turn timeout. |
| `SUPER_RLM_CALLBACK_KEY` | `dev-callback-key` | HMAC-SHA256 key for report callbacks. |
| `SUPER_RLM_ASSIGNMENT_HEARTBEAT_INTERVAL_S` | `10` | Assignment heartbeat interval. |

## Tests

```bash
.venv/Scripts/python.exe -m pytest -q
```

The suite includes a real Prime Agent ACP integration test. It uses a fake
OpenAI-compatible model server and skips if the project Prime Agent binary or
kernel venv is missing.

## Deferred

- Per-Worker control tokens and scoped bearer tokens.
- Hardened container isolation.
