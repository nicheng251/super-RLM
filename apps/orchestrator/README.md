# Orchestrator

Minimal v0 control plane for the vertical slice.

## Run

```bash
cd apps/orchestrator
npm install
SUPER_RLM_HOME="$HOME/.super-rlm/projects/prj_spike_local" \
SUPER_RLM_PORT=8787 \
SUPER_RLM_ROUTER_TOKEN=router-token \
SUPER_RLM_WORKER_TOKEN=worker-token \
npm run dev
```

`node:sqlite` is built into Node 22.5+; Node is a host prerequisite and is not
bundled by the project.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SUPER_RLM_HOST` | `127.0.0.1` | Bind address. |
| `SUPER_RLM_PORT` | `8787` | Bind port. |
| `SUPER_RLM_HOME` | `~/.super-rlm/projects/default` | Project runtime root. |
| `SUPER_RLM_DB` | `<home>/orchestrator/orchestrator.sqlite` | SQLite path. |
| `SUPER_RLM_WORKSPACES` | `<home>/workspaces` | Per-Ticket workspace root. |
| `SUPER_RLM_ROUTER_TOKEN` | `dev-router-token` | Router bearer token. |
| `SUPER_RLM_WORKER_TOKEN` | `dev-worker-token` | Worker/report bearer token. |
| `SUPER_RLM_CALLBACK_KEY` | `dev-callback-key` | HMAC-SHA256 key for Worker reports and user callbacks. |
| `SUPER_RLM_CALLBACK_URL` | unset | Optional HTTP endpoint for signed user callbacks. |
| `SUPER_RLM_MAX_CONCURRENT_TICKETS` | `4` | Global running limit. |
| `SUPER_RLM_MAX_CONCURRENT_TICKETS_PER_TASK` | `2` | Per-Task normal running limit. |
| `SUPER_RLM_PRIORITY_RESERVED` | `1` | Slots reserved for answer/resume. |
| `SUPER_RLM_WORKER_LEASE_MS` | `30000` | Heartbeat lease. |
| `SUPER_RLM_PROFILES_CONFIG` | `<repo>/config/profiles.yaml` | Named Worker profiles. |

## Profiles

`config/profiles.yaml` defines named capability profiles. The Orchestrator
validates each Ticket's `profile` (`default` when omitted), rejects unknown names
with `unknown_profile`, and sends the resolved provider/model/thinking, timeout,
prepare and blocked commands, workspace layout, and delivery policy as
`ExecutionRequest.execution`. `GET /v1/profiles` exposes only the sanitized
name, description, provider, model, thinking, capabilities, requires_repo,
read_only, and write_files fields.

## Routes

Router (bearer `SUPER_RLM_ROUTER_TOKEN`):

```text
GET  /v1/profiles
POST /v1/tasks
GET  /v1/tasks
GET  /v1/tasks/:id
GET  /v1/tasks/:id/wait
GET  /v1/tasks/:id/events
GET  /v1/tickets/:id/result
POST /v1/tickets/:id/answer
POST /v1/tickets/:id/resume
POST /v1/tickets/:id/retry
POST /v1/tickets/:id/cancel
POST /v1/tasks/:id/cancel
```

Worker (bearer `SUPER_RLM_WORKER_TOKEN`):

```text
POST /internal/v1/workers/register
POST /internal/v1/workers/:id/heartbeat
POST /internal/v1/assignments/:id/heartbeat
POST /internal/v1/reports
```

`GET /health` is unauthenticated.

## Implemented

- Task/Ticket/Assignment state machine and derived Task status.
- SQLite persistence with WAL and a schema-version row.
- Forward-only migrations with a schema-version row (currently v5) and an automatic `VACUUM INTO` backup before upgrading an existing DB.
- Single-instance lock file with stale-PID recovery.
- Startup recovery for assignments left open by a previous Orchestrator process.
- Global, per-Task, per-Worker, and priority slot accounting.
- Push dispatch to a registered Worker via `POST /v1/executions`.
- Report sequencing, idempotency, and state validation.
- HITL answer/resume/retry/cancel.
- Worker registry and heartbeat lease reaping.
- Events table, task-scoped event reads, SSE streaming, and cursor replay.
- Durable outbox with HMAC-signed user callbacks (`ticket.waiting`, `ticket.blocked`, `ticket.settled`, `task.settled`) and retry/backoff.
- Unit, integration, HTTP, dispatch, migration, and outbox tests.

## Deferred

- Scoped tokens and OIDC/mTLS.
- Callback SSRF/allowlist policy for public endpoints.
- Metrics and OpenTelemetry.

## Tests

```bash
npm test        # node:test, in-memory SQLite and fake Workers
npm run check   # tsc --noEmit
```
