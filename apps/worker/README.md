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
POST /internal/assignments/{id}/report # super-rlm-report skill -> Worker
```

The report route requires the per-execution bearer token. The Worker writes
`<workspace>/.super-rlm-report.json` before every Assignment and sends its path
as `SUPER_RLM_REPORT_CONFIG`. The skill reads this file on every call because a
resident Prime Agent kernel keeps the first Assignment's environment across a
resume.

## Execution lifecycle

1. Create a per-Ticket workspace and session directory.
2. Spawn `prime-agent --mode acp` with project-owned paths and the report skill.
3. `initialize` -> `session/new` -> `session/prompt`.
4. Record the durable `session_ref` from the session file.
5. The report skill posts `progress` / `waiting` / `blocked` / `completed` /
   `dropped` / `failed` / `cancelled` to the Worker.
6. The Worker forwards a `WorkerReport` with a monotonic `seq` and idempotency key.
7. A turn without a terminal report gets one enforcement prompt; still missing
   becomes `failed / missing_report`.
8. `waiting` / `blocked` close ACP but keep the session file for `--resume`.

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
| `SUPER_RLM_PRIME_AGENT` | repo `runtime/prime-agent` | Prime Agent binary. |
| `SUPER_RLM_PRIME_PROVIDER` | `fake` | Model provider. |
| `SUPER_RLM_PRIME_MODEL` | `fake-1` | Model id. |
| `SUPER_RLM_KERNEL_VENV` | `<home>/prime/kernel-venv` | Project kernel venv. |
| `SUPER_RLM_KERNEL_PYTHON` | venv python | Python inside the kernel venv. |
| `SUPER_RLM_BASH_SHELL` | Git Bash on Windows | POSIX shell for Prime Agent bash. |
| `SUPER_RLM_REPORT_SKILL` | repo skill dir | `super-rlm-report` skill path. |
| `SUPER_RLM_WORKER_PROMPT` | repo prompt | Appended Worker system prompt. |
| `SUPER_RLM_TURN_TIMEOUT_S` | `3600` | Per-ACP-turn timeout. |

## Tests

```bash
.venv/Scripts/python.exe -m pytest -q
```

The suite includes a real Prime Agent ACP integration test. It uses a fake
OpenAI-compatible model server and skips if the project Prime Agent binary or
kernel venv is missing.

## Deferred

- HMAC-signed reports and per-Worker control tokens.
- Assignment heartbeat to the Orchestrator.
- Per-profile `prepare_command` / `blocked_commands`.
- Hardened container isolation.
