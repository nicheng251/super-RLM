# super-RLM Architecture

Status: implementation started; local-first  
Last updated: 2026-11-03

## 0. Handoff snapshot

Current phase: two local spikes passed; local-first implementation.

The architecture has 46 recorded ADRs (44 accepted, 2 superseded). Both local spikes are documented:

1. Pi Router extension: custom tools only, no built-in tools (`docs/spikes/pi-router.md`).
2. Prime Agent ACP: recursive `rlm.spawn`, structured report skill, session resume, and final result (`docs/spikes/prime-acp.md`).

The spikes confirmed four implementation requirements:

- Prime Agent needs project-owned `PRIME_AGENT_KERNEL_VENV` and `PRIME_AGENT_KERNEL_PYTHON` in addition to agent/session/daemon paths.
- The project kernel venv must be prepared with `prime-agent-runtime`, `mcp`, `tyro`, and the default Python packages.
- The durable `session_ref` is the session file path, not the ACP `sessionId`; a per-Ticket session directory is the simplest discovery mechanism.
- `--resume` requires the same daemon socket; a lease failure is a normal fallback to a new session.

Release packaging and distribution are deferred.

Audit follow-ups are recorded in ADR 0039–0046 and `docs/audit/design-audit.md`.

Confirmed:

- the user talks to the Router through the Pi Agent CLI;
- the Router splits the request into Worker tasks;
- Tickets are independent, following dsh-superagent's model; v0 has no Ticket DAG;
- sequencing inside a Ticket belongs to Prime Agent and is opaque to the rest of the system;
- each Ticket gets its own Prime Agent ACP process/session and workspace;
- a shared Worker service supervises per-Ticket ACP sessions, while the Orchestrator enforces the global concurrency slots;
- the Orchestrator is a separate long-lived service and the only task-state writer;
- v0 supports human-in-the-loop: a Worker may report `waiting`/`blocked` with a question, release its slot, and resume the same Prime Agent session after the user answers;
- the Orchestrator stores per-Ticket summaries and full results; the Router aggregates and summarizes for the user;
- the long-term CLI is a first-class page shell (Chat, Tasks, Task Detail, Workers, Events), not only an extension dialog;
- phase 1 uses L2 Pi extension custom screens for the concept proof; phase 2 builds the first-class TUI shell; L2 stays as a fallback/lightweight path;
- v0 persists Orchestrator state in one SQLite database with a directory lock, schema migrations, and a durable outbox; repositories stay replaceable;
- service boundaries use HTTP/JSON for commands and SSE for event streams, versioned under `/v1`;
- v0 uses minimal service authentication: scoped bearer tokens, HMAC-signed Worker reports and user callbacks, localhost/private-network binding, and 0600 secret files;
- v0 has a CLI-only ingress; the Orchestrator API is internal, and a public task API is deferred;
- the Task/Ticket/Assignment state machine separates lifecycle from outcome and is documented in `docs/protocol/state-machine.md`;
- Router tools and the internal REST contract are documented in `docs/protocol/router-api.md`; `task_create` accepts a Tickets list, and `ticket_answer`/`ticket_resume` are separate;
- runtime data lives in a dedicated project runtime root (`SUPER_RLM_HOME`, default `~/.super-rlm/projects/<project_id>/`); the target project only holds a small `.super-rlm-project.json` marker, and the user's normal Pi/Prime config is never touched;
- v0 is local-first: no release packaging or distribution yet; development runs from source with project-owned runtime paths;
- audit follow-ups are accepted: Router SSE notifications, report enforcement, session_ref discovery, local project marker, no v0 follow-up API, dropped/no-op outcome, per-Task quota, and duplicate checks;
- Workers use admin-defined named profiles; the Router selects a profile by name and never supplies raw model credentials or arbitrary limits;
- Workers self-register, send heartbeats, and the Orchestrator pushes Assignments to workers with free capacity;
- concurrency is global plus per-Worker, with one priority slot reserved for user answers/resumes;
- Worker execution/report contracts use HTTP POST, monotonic `seq`, idempotency keys, and an explicit `cancelled` report state;
- deployment supports a host CLI with Docker services, plus an all-local development mode; the TUI is not run inside a container;
- HITL waits indefinitely by default, with an optional `waiting_timeout_s`; the first answer wins atomically, retries are idempotent, and later answers are rejected with `ticket_not_waiting`;
- waiting/blocked Tickets resume the same resident Prime Agent session by opaque `session_ref`; if resume fails, the Worker starts a new session with a recovery prompt;
- v0 uses trusted-local Worker isolation (A); a hardened Worker container (B) is planned as the future security baseline;
- the project bundles pinned Pi Agent and Prime Agent runtimes and does not require or use the user's global installations;
- v0 uses minimal observability: JSON logs, a SQLite event log, SSE, basic metrics, and correlation IDs; OpenTelemetry/Prometheus are deferred;
- Pi and Prime Agent runtimes read only project-owned config, session, auth, and daemon paths; inherited user `PI_*`/`PRIME_AGENT_*` settings are stripped and global installs are never used;
- Worker status handoff uses a project-owned Python skill (`super-rlm-report`) installed into the Prime Agent kernel, not MCP; missing terminal reports fail closed as `missing_report`;
- Router uses one persistent project-local Pi session; its profile is project-owned and reads no user global Pi resources; task facts are always queried from the Orchestrator;
- each Assignment uses one ACP process; waiting/blocked closes ACP while the resident Prime Agent session persists; a turn without a terminal report fails as `missing_report`;
- model selection is explicit in v0: the Router chooses a named profile, and each profile maps to a fixed Model Registry alias; task-aware routing is deferred;
- retries are error-classified: transient/worker-loss/startup failures retry with exponential backoff; config/workspace/timeout/cancel do not; `missing_report` retries at most once;
- v0 backup/restore is offline; schema migrations are forward-only with an automatic pre-migration backup; secrets are excluded by default;
- layers should be decoupled through narrow contracts;
- when dsh-superagent has an equivalent design, prefer it; add new concepts only when it does not;
- decisions and design must be written down in this repository.

Next action: set the first profile defaults and run the two local spikes.

## 1. Goal

Build a meta-agent system in which:

- a human talks to a **Router** through the **Pi Agent CLI**;
- the Router splits a request into one or more worker tasks;
- the Orchestrator schedules each task on a Worker;
- each Worker runs a **Prime Agent RLM** session;
- Prime Agent may recursively spawn its own child agents.

The Router does not execute work. The Orchestrator does not reason about the task. The Worker does not own task state. Prime Agent's internal recursion is opaque to the rest of the system.

## 2. Roles

### Router: Pi Agent CLI

The Router is a Pi Agent session with a custom extension. It is the only component the user talks to.

Responsibilities:

- understand the user's request;
- ask clarifying questions when needed;
- split the request into one or more Tickets;
- submit Tickets through Orchestrator tools;
- report progress and summarize results;
- decide whether to retry, cancel, or ask the user.

Non-responsibilities:

- no shell, file editing, or code execution;
- no direct Worker calls;
- no direct database writes;
- no knowledge of Prime Agent's internal child agents.

### Orchestrator

The Orchestrator is the deterministic control plane and the only writer of task state.

Responsibilities:

- persist Tasks, Tickets, Assignments, and Reports;
- validate Router tool calls;
- schedule Tickets on Workers;
- enforce concurrency, leases, timeouts, and retries;
- expose status and results to the Router;
- deliver user callbacks when configured.

Non-responsibilities:

- no LLM calls;
- no task decomposition;
- no execution logic;
- no knowledge of Prime Agent's internal RLM tree.

### Worker

The Worker is a thin execution adapter around Prime Agent.

Responsibilities:

- accept one Ticket assignment;
- start a Prime Agent session with the ticket prompt and workspace;
- stream progress and report terminal results;
- cancel the session when asked.

Non-responsibilities:

- no task planning;
- no Task/Ticket state ownership;
- no direct database access.

### Prime Agent RLM

Prime Agent is the execution kernel.

- It owns the persistent IPython kernel and the model loop.
- It may call `rlm.spawn()` and manage child agents internally.
- Its internal decomposition, child count, and child lifecycle are its own concern.
- Only the final ticket result and high-level progress are exposed upward.

## 3. Boundaries and dependency direction

```text
User
  │ Pi Agent CLI
  ▼
Router (Pi Agent extension)
  │ Orchestrator tool API
  ▼
Orchestrator (task state, scheduling)
  │ Worker API
  ▼
Worker (Prime Agent adapter)
  │ ACP over stdio
  ▼
Prime Agent (RLM kernel; child agents internal)
```

Rules:

- Router knows only the Orchestrator tool API.
- Orchestrator knows only the Worker API.
- Worker knows only the Prime Agent ACP surface.
- Prime Agent's RLM tree is not modeled by the Orchestrator.
- No shared database or shared process between layers.
- Each boundary has a versioned JSON schema.
- Transport is an implementation detail. v0 uses HTTP/JSON for service boundaries and ACP/JSON-RPC for Prime Agent.

## 4. User flow

1. User runs `pi` in the Router workspace.
2. User describes a task.
3. Router asks clarifying questions if necessary.
4. Router calls `task_create` with one or more Tickets.
5. Orchestrator persists the Task and Tickets, then schedules them.
6. Worker starts Prime Agent for each Ticket.
7. Prime Agent may spawn RLM children internally.
8. Worker reports progress and terminal results.
9. Router calls `task_wait` or `task_status`, reads results, and summarizes for the user.

## 5. Domain model

### Task

One user request. A Task contains one or more Tickets.

States:

`queued | running | waiting | succeeded | partial | failed | cancelled | timed_out`

`partial` is a derived terminal state: at least one Ticket succeeded and at least one did not. It is never set manually.

### Ticket

One unit of work assigned to one Worker session.

Tickets are independent, as in dsh-superagent. v0 has no Ticket-to-Ticket dependencies. A multi-step task that must run in order is either:

- kept inside one Ticket, where Prime Agent plans and sequences it; or
- split by the Router into successive rounds of independent Tickets.

A Ticket may enter `waiting` when the Worker asks the user a question. The Orchestrator releases the assignment's slot. `ticket_answer` creates a new assignment and the Worker resumes the same Prime Agent session.

States:

`queued | assigned | running | waiting | blocked | succeeded | failed | cancelled | timed_out | lost`

`waiting` means the user must answer a question. `blocked` means an external condition or action is required. Both release the slot and persist the Prime Agent session.

### Assignment

One attempt to run a Ticket on a Worker.

States:

`pending | running | ended`

`ended` carries `end_reason`: `completed | failed | waiting | blocked | cancelled | lost`.

### Report

A fact reported by a Worker. The Orchestrator decides the resulting state.

States:

`progress | waiting | blocked | completed | failed`

## 6. Router tools (v0 proposal)

The Router extension registers only control-plane tools:

- `task_create(task_prompt, tickets[])`
- `task_status(task_id)`
- `task_wait(task_id, timeout_s?)`
- `task_cancel(task_id, reason?)`
- `ticket_result(ticket_id)`
- `ticket_retry(ticket_id)`
- `ticket_answer(ticket_id, message)`

The Router has no `bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`, MCP, or skill tools.

`task_create` accepts a list because the Router is responsible for splitting. The Orchestrator does not split.

## 7. Worker protocol (v0 proposal)

### Orchestrator -> Worker

`POST /v1/executions`

```json
{
  "ticket_id": "...",
  "assignment_id": "...",
  "prompt": "...",
  "profile": "default",
  "workspace": "/data/workspaces/<ticket_id>",
  "callback_base": "http://orchestrator/internal"
}
```

### Worker -> Orchestrator

`POST /internal/v1/reports`

```json
{
  "ticket_id": "...",
  "assignment_id": "...",
  "seq": 1,
  "idempotency_key": "...",
  "state": "progress | waiting | blocked | completed | failed",
  "summary": "...",
  "result": "...",
  "artifacts": [],
  "usage": {},
  "error": null
}
```

The Orchestrator is the only writer of Ticket state.

## 8. Transport

- Router/UI -> Orchestrator: HTTP/JSON.
- Orchestrator -> Worker: HTTP/JSON.
- Worker -> Orchestrator: HTTP/JSON reports.
- UI event stream: SSE.
- User callbacks: HTTP/JSON with signed payloads.
- All endpoints use a `/v1` prefix.
- Contracts are described by OpenAPI or JSON Schema; TypeScript and Python clients are generated or checked against it.
- Commands carry `Idempotency-Key`; internal requests carry a request ID for tracing.
- v0 has no gRPC and no message queue. A queue may be added behind the same contract if Worker scale requires it.

## 9. Worker profiles and Model Registry

The Router chooses a Worker capability profile by name. It never supplies raw model names, API keys, or arbitrary limits.

Profile fields (v0):

```text
model          # Model Registry alias
thinking       # reasoning level
max_depth      # RLM recursion depth
timeout_s      # wall-clock limit per assignment
prepare_command
blocked_commands
```

`concurrency` is global to the Orchestrator, not per profile.

The Model Registry maps aliases to providers, models, and credential references. It is project-owned:

```text
config/models.yaml          # committed defaults, no secrets
<SUPER_RLM_HOME>/secrets/   # credentials
```

`super-rlm models sync` writes project-local Pi and Prime Agent configuration. It never touches `~/.pi` or `~/.prime`.

The Router sees profiles through the read-only `profile_list` tool. Unknown profile names are rejected by the Orchestrator.

v0 model selection is explicit: the Router chooses a profile by name, and each profile maps to a fixed model alias. There is no automatic task-aware model routing yet. The profile abstraction is kept so task-aware selection can be added later without changing the Ticket API.

## 10. Concurrency and slots

- `max_concurrent_tickets` is a global Orchestrator setting.
- Each Worker reports `max_concurrency` at registration and heartbeat.
- A Ticket holds a slot from Assignment start until it reaches a terminal state or hands off to the user.
- `waiting`, `blocked`, and `lost` release the slot.
- One priority slot is reserved for `ticket_answer` and `ticket_resume`.
- New Tasks and Tickets use normal slots only.
- If the priority slot is occupied, user actions queue behind it.
- Per-Task quotas are deferred to a later version.

## 11. Worker dispatch

v0 uses push dispatch with worker registration.

- Worker starts and calls `POST /internal/v1/workers/register`.
- Worker sends periodic heartbeats with `running` and `max_concurrency`.
- Orchestrator keeps a worker registry with URL, capacity, running count, and last heartbeat.
- Orchestrator pushes `POST /v1/executions` to a worker with free capacity.
- `202` accepts the assignment; `409` means the worker is full, so the Orchestrator tries another.
- A missed heartbeat marks the worker `lost`; its active assignments become `lost` and follow retry policy.
- There is no pull mode in v0.

## 12. Deployment modes

Primary mode:

```text
Host:
  super-rlm / pi CLI
    -> 127.0.0.1:8787
Docker:
  orchestrator
  worker
```

- Orchestrator publishes only to `127.0.0.1` on the host.
- Worker publishes no host port.
- Both services share a data volume for `SUPER_RLM_HOME`.
- Secrets live under the shared data volume.

Development mode:

```text
Host:
  pnpm dev (Orchestrator)
  uv run worker (Worker)
  super-rlm / pi CLI
```

The TUI is never run inside a container. Both modes use the same HTTP/SSE contracts.

## 13. Human-in-the-loop policy

- `waiting_timeout_s` defaults to `0` (no automatic timeout).
- A non-zero timeout marks a waiting Ticket `timed_out` and emits an event.
- The first `ticket_answer` wins atomically: `waiting -> queued`, then a new Assignment.
- The answer request carries an `Idempotency-Key`; a retry with the same key returns the original assignment.
- A different answer for a Ticket that is no longer `waiting` returns `ticket_not_waiting`.
- Late answers after timeout or cancellation are rejected.
- Answers are stored in Ticket history and included in the resume prompt.
- Waiting Tickets do not hold a slot; administrators can list and cancel stale ones.

## 14. Prime Agent session reuse

Session reuse follows dsh's semantic/identity model.

- Prime Agent runs with a resident session, not `--no-session`.
- The Worker reports an opaque `session_ref` after the session starts.
- The Orchestrator stores `session_ref`; it never parses it.
- The Orchestrator decides semantic intent: continue after a question/blocker, recovery after an unfinished failure, or no new Assignment for a terminal Ticket.
- The Worker resolves the session:
  - try `--resume <session_ref>` when present;
  - on failure or absence, create a new session and send a recovery prompt;
  - report `resumed`, `recovery`, and the current `session_ref`.
- There is no separate `resume_eligible` policy gate; `resume_attempts` may bound fallback loops.
- A new session replaces the old `session_ref`.
- If both resume and fallback fail, the Worker reports `failed` with `resume_failed`.

## 15. Worker isolation

v0 uses trusted-local isolation (A):

- Worker runs as the operator OS user.
- Each Ticket has its own workspace.
- This is not a security boundary.
- The documentation must state this explicitly.

Future security baseline (B):

- Worker runs in a hardened container.
- non-root, read-only root filesystem, tmpfs `/tmp`.
- Only the project runtime root, workspaces, and read-only secrets are mounted.
- No host home, no Docker socket.
- `no-new-privileges`, dropped capabilities, CPU/memory/PID limits.
- One ACP process per Ticket.

Per-Ticket containers remain a later option for untrusted or multi-tenant execution.

## 16. Bundled runtime

The project ships its own runtime instead of relying on global installations.

```text
runtime/
  pi/                     # pinned Pi Agent CLI/package
  prime-agent/            # pinned Prime Agent binary + kernel runtime
  manifest.json           # versions and checksums
bin/super-rlm             # launcher that sets project-owned env vars
```

- Pi Agent is pinned in the project's package lock.
- Prime Agent is a pinned release with a checksum.
- Node.js `>= 22.19` is a host prerequisite in v0, provided by the user; the project does not bundle Node.
- The kernel/runtime environment is part of the bundled runtime.
- `bin/super-rlm` sets the project's Pi/Prime agent dirs, session dirs, and daemon socket.
- `super-rlm doctor` verifies versions, checksums, and required paths.
- Docker images include the same runtime.
- The project does not read or mutate `~/.pi` or `~/.prime`.
- The project does not fork Pi or Prime Agent in v0.

## 17. Runtime isolation contract

The bundled Pi and Prime Agent runtimes must not fall back to the user's normal installation or configuration.

Rules:

- Resolve binaries from `runtime/`, never from `PATH`.
- Set project-owned `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PRIME_AGENT_CODING_AGENT_DIR`, `PRIME_AGENT_CODING_AGENT_SESSION_DIR`, `PRIME_AGENT_SESSION_DIR`, `PRIME_AGENT_DAEMON_SOCKET`, `PRIME_AGENT_KERNEL_VENV`, and `PRIME_AGENT_KERNEL_PYTHON`.
- On Windows, set `PRIME_AGENT_BASH_SHELL` to an absolute POSIX shell path for the `bash` tool.
- Strip inherited `PI_*` and `PRIME_AGENT_*` variables, then inject the project values.
- Never read or write `~/.pi` or `~/.prime`.
- Router disables global resources: `--no-context-files`, `--no-skills`, `--no-prompt-templates`, `defaultTools: []`, and only the explicit super-rlm extension.
- Worker loads resources only from the project agent dir and explicit paths.
- `super-rlm doctor` verifies paths and warns on global fallback.
- Local mode (A) does not fake `HOME`; task tools can still read the operator's files by design.
- Full filesystem isolation is the hardened container mode (B).

## 18. Testing

v0 uses a test pyramid.

- Unit tests: state machine, Task derivation, slot accounting, report deduplication, profile validation, repositories.
- Contract tests: OpenAPI/JSON Schema, Router tool schemas, Worker report schemas, generated TS/Python clients.
- Integration tests: Orchestrator + fake Worker; Worker + fake ACP; SQLite temp directories; HTTP/SSE.
- Small E2E: Pi Router extension with a mocked Orchestrator; real Orchestrator + Worker + Prime Agent ACP with a faux provider.
- Fault tests: kill Worker, heartbeat expiry, lease loss, resume fallback, duplicate/out-of-order reports, Orchestrator restart, SQLite migrations.
- CI uses fake/faux providers and no real model keys.
- Real-model E2E is a later effectiveness-validation phase, not a per-PR gate.

## 19. Observability

- Structured JSON logs from Orchestrator and Worker.
- Correlation fields: `request_id`, `task_id`, `ticket_id`, `assignment_id`, `execution_id`, `worker_id`, `session_ref`.
- Append-only SQLite `events` table.
- SSE endpoints: `/v1/events` and `/v1/tasks/{task_id}/events`, with `after` replay.
- Basic metrics: queue depth, running/waiting counts, worker capacity, success/failure counts, duration, token usage.
- Worker logs capture ACP lifecycle, tool calls, RLM child starts/stops, and session paths.
- No tokens, API keys, or full prompts in logs.
- OpenTelemetry/Prometheus/Grafana are deferred; the event and metric shapes are designed to allow them later.
- Event retention is configurable; old events are archived or deleted.

## 20. Router conversation and profile

- One persistent Router session per project.
- Fixed session ID: `super-rlm-router-<project_id>`.
- `super-rlm` opens it; `super-rlm --new` creates a new one; `super-rlm --session <id>` opens a specific one.
- Pi profile is project-owned: `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` point under `SUPER_RLM_HOME`.
- Router disables global context files, skills, and prompt templates; only the explicit super-rlm extension loads.
- Task facts are always read from the Orchestrator through tools; chat history is not authoritative.

## 21. Project runtime and configuration

The project must not touch the user's normal Pi Agent or Prime Agent state.

Two roots:

```text
SUPER_RLM_ROOT
  default: ~/.super-rlm
  holds: projects/<project_id>/

SUPER_RLM_HOME
  default: $SUPER_RLM_ROOT/projects/<project_id>
  override: environment variable or --project-home
```

Project identity comes from a small marker in the target project:

```text
<target-project>/.super-rlm-project.json
  { "project_id": "prj_..." }
```

`super-rlm init` creates the marker if the target project is writable. If the marker is absent and cannot be created, `super-rlm` requires `--project-id` or `SUPER_RLM_PROJECT_ID`.

Layout of a project runtime root:

```text
<SUPER_RLM_HOME>/
  pi/
    agent/          # PI_CODING_AGENT_DIR
    sessions/       # PI_CODING_AGENT_SESSION_DIR
  prime/
    agent/          # PRIME_AGENT_CODING_AGENT_DIR
    sessions/       # PRIME_AGENT_SESSION_DIR
    daemon/         # PRIME_AGENT_DAEMON_SOCKET
    kernel-venv/    # PRIME_AGENT_KERNEL_VENV / PRIME_AGENT_KERNEL_PYTHON
  orchestrator/
    orchestrator.sqlite
  secrets/
    router.token
    worker.token
    callback.key
    providers.env
  workspaces/
    <ticket_id>/
```

Committed defaults live under `config/` and contain no secrets:

```text
config/
  models.example.yaml
  profiles.yaml
  router-prompt.md
  worker-prompt.md
```

Isolation and placement rules:

- The target project holds only `.super-rlm-project.json`; no database, sessions, or workspaces.
- The project never writes to `~/.pi` or `~/.prime`.
- `models sync` writes only inside `<SUPER_RLM_HOME>/pi/agent` and `<SUPER_RLM_HOME>/prime/agent`.
- The Prime daemon uses its own socket, not the user's normal daemon.
- Sessions and workspaces live under `<SUPER_RLM_HOME>`.
- Secrets are 0600 and never committed or logged.
- Docker mounts `SUPER_RLM_ROOT` (or a dedicated data volume) for Orchestrator and Worker.

## 22. Authentication

v0 uses the minimum service-to-service trust model.

- Orchestrator binds `127.0.0.1` locally and a private Docker network remotely.
- Router/UI authenticate with a scoped bearer token.
- Workers authenticate with a worker token.
- Worker reports are HMAC-signed with a timestamp and nonce.
- User callbacks are HMAC-signed.
- Secrets live in `<stateDir>/secrets/` with 0600 permissions, or Docker secrets.
- Tokens never appear in prompts, logs, or task results.
- v0 has no OIDC, JWT, mTLS, user accounts, or automatic key rotation.

## 23. Ingress

v0 is CLI-first.

- The Pi CLI / super-RLM CLI is the only user ingress.
- The Orchestrator HTTP API is internal: Router/UI and Worker only.
- Orchestrator binds `127.0.0.1` locally and a private Docker network remotely.
- There is no public `POST /v1/tasks` in v0.
- A future public API should sit behind a separate admission/API gateway, with API keys, rate limits, quotas, and callback SSRF protection.

## 24. Prime Agent integration

v0 recommendation: Worker drives `prime-agent --mode acp` over stdio.

Reasons:

- ACP is a documented JSON-RPC surface.
- It is daemon-backed and supports multi-turn interaction.
- ACP prompts wait for spawned subagents to finish.
- It supports cancellation and session resume.
- It avoids reimplementing Prime Agent's RLM loop.

Worker maps a ticket profile to Prime Agent flags such as:

- `--cwd <workspace>`
- `--session-dir <sessions>`
- `--model <model>`
- `--thinking <level>`
- `--append-system-prompt <worker contract>`

Prime Agent's `rlm.spawn()` tree remains internal.

## 25. Worker report skill

Prime Agent's structured handoff uses a project-owned Python-backed skill, not MCP.

Skill layout:

```text
apps/worker/skills/super-rlm-report/
  SKILL.md
  pyproject.toml
  src/super_rlm_report/__init__.py
```

Call:

```python
await super_rlm_report(
    state="completed",
    summary="...",
    question=None,
    result="...",
    artifacts=[],
)
```

States: `completed | waiting | blocked | failed | progress`.

- `waiting` and `blocked` require `question`.
- The skill posts to the Worker's per-assignment report endpoint using a local token from environment.
- The Worker validates the report and forwards it to the Orchestrator.
- A turn that ends without a terminal report is reported as `failed` with `missing_report`.

## 26. Worker ACP lifecycle

- Each Assignment starts one `prime-agent --mode acp` process.
- Launch flags: `--cwd <workspace>`, `--session-dir <project>/prime/sessions`, profile model/thinking, explicit report skill, worker system prompt.
- Resume adds `--resume <session_ref>`.
- Sequence: `initialize` -> `session/new` (empty MCP list) -> `session/prompt`.
- The report skill may post `progress`, `waiting`, `blocked`, `completed`, or `failed` during the turn.
- The Worker keeps the latest report and forwards it at turn end.
- A turn ending without a terminal report becomes `failed / missing_report`.
- `waiting`/`blocked` closes the ACP process, keeps the resident session, and releases the slot.
- Cancellation and timeout are Orchestrator-authoritative; the Worker sends `session/cancel`, waits for settlement, and closes.
- Tool events and agent messages are logged; they are not sent as individual reports.
- One ACP process at a time per Ticket; no ACP process is shared across Tickets.

## 27. Retry and error taxonomy

Errors use a stable object:

```json
{
  "code": "provider_unavailable",
  "message": "...",
  "retryable": true,
  "source": "prime_agent | worker | orchestrator",
  "details": {}
}
```

Categories: `transient`, `worker_lost`, `startup`, `missing_report`, `config`, `workspace`, `protocol`, `timeout`, `cancelled`.

Automatic retry:

- `transient`, `worker_lost`, `startup`: up to 3 attempts, backoff 2s/5s/15s with jitter.
- `missing_report`: at most one retry.
- `config`, `workspace`, `timeout`, `cancelled`: no automatic retry.

Retries create a new Assignment but keep the Ticket's `session_ref`. The retry prompt includes a recovery note: inspect state, do not repeat completed external actions, finish the original assignment.

Provider-level retries inside Prime Agent remain; the Orchestrator does not duplicate them aggressively.

## 28. Backup, restore, and migration

v0 uses offline backup and restore.

```text
super-rlm backup <path>
super-rlm restore <path>
```

- Backup requires Orchestrator and Worker to be stopped.
- The backup contains `SUPER_RLM_HOME` and a manifest with timestamp, versions, schema version, and checksums.
- `secrets/` is excluded unless `--include-secrets` is passed.
- Restore verifies the manifest, checks runtime compatibility, restores, migrates, and runs `doctor`.
- A failed restore leaves the original directory untouched.
- Schema migrations are forward-only.
- A newer database is refused by an older build.
- A pre-migration backup is created automatically.
- Pi/Prime session-format incompatibility is reported, not silently migrated.

## 29. Local-first development

v0 does not ship a release package or installer.

Local development uses:

```bash
pnpm install
uv sync
super-rlm bootstrap        # fetch/verify project runtime
super-rlm models sync
pnpm dev                   # Orchestrator
uv run worker              # Worker
super-rlm                  # Router CLI
```

- Runtime data lives under `~/.super-rlm/projects/<project_id>`.
- The target project holds only `.super-rlm-project.json`.
- Docker Compose is optional for local service isolation, not required for v0.
- Release packaging, installers, and multi-OS distribution are deferred.

## 30. Decisions

| ID | Status | Decision |
| --- | --- | --- |
| D1 | accepted | The user interacts with the Router through the Pi Agent CLI. |
| D2 | accepted | The Router is responsible for splitting work into Worker tasks. |
| D3 | accepted | Prime Agent's internal RLM decomposition is opaque to the Router and Orchestrator. |
| D4 | accepted | Layers are decoupled through narrow, versioned contracts. |
| D5 | accepted | All architectural decisions are recorded in this repository. |
| D6 | accepted | The Orchestrator is a separate long-lived, deterministic service and the only task-state writer. |
| D7 | accepted | The Worker is a Prime Agent ACP adapter; it does not reimplement the RLM loop. |
| D8 | accepted | v0 supports multiple independent Tickets per Task, following dsh-superagent; no Ticket DAG. |
| D9 | accepted | v0 uses one SQLite database (WAL, directory lock, migrations, outbox) behind replaceable repository interfaces; PostgreSQL is a later option. |
| D10 | accepted | Every material decision and design change is documented in this repository. |
| D11 | accepted | When dsh-superagent has an equivalent design, prefer it; add new concepts only when it does not. |
| D12 | accepted | Worker topology: one Ticket gets one Prime Agent ACP session/workspace; a shared Worker service supervises sessions; the Orchestrator enforces global concurrency slots. |
| D13 | accepted | Human-in-the-loop: `waiting`/`blocked` releases the slot; the user's answer creates a new assignment and resumes the same Prime Agent session. |
| D14 | accepted | The Orchestrator stores per-Ticket summary/result/artifacts; the Router aggregates and summarizes for the user; the Orchestrator does not call an LLM. |
| D15 | accepted | UI is phased: L2 Pi extension pages for the proof of concept, then an L3 first-class TUI shell; L2 remains a fallback. |
| D16 | accepted | Service transport is HTTP/JSON for commands and SSE for events, versioned under `/v1`; no gRPC or message queue in v0. |
| D17 | accepted | Minimal service auth: scoped bearer tokens, HMAC for Worker reports and user callbacks, localhost/private-network binding, 0600 secret files; no OIDC or mTLS in v0. |
| D18 | accepted | v0 has a CLI-only ingress; the Orchestrator API is internal; a public task API is deferred behind a future admission/API gateway. |
| D19 | accepted | Assignment uses `pending|running|ended` plus `end_reason`; Task adds a derived `partial` terminal state; `waiting` and `blocked` are distinct Ticket states. |
| D20 | accepted | Router tools follow `docs/protocol/router-api.md`; `task_create` accepts a Tickets list; `ticket_answer` and `ticket_resume` are separate. |
| D21 | accepted | The project owns an isolated runtime/config root and never mutates the user's normal Pi or Prime Agent configuration. |
| D22 | accepted | Workers use admin-defined named profiles; the Router selects by name; profiles reference Model Registry aliases and contain no credentials. |
| D23 | accepted | Workers self-register and heartbeat; the Orchestrator pushes Assignments to workers with free capacity; no pull mode in v0. |
| D24 | accepted | Concurrency is global plus per-Worker, with one priority slot reserved for user answers/resumes; new work uses normal slots only. |
| D25 | accepted | Worker reports use HTTP POST with monotonic `seq` and idempotency keys; cancellation is Orchestrator-authoritative; `result` is capped at 64 KiB inline and larger outputs go to artifacts. |
| D26 | accepted | Deployment supports host CLI + Docker services as the primary mode, plus an all-local development mode; the TUI is not containerized. |
| D27 | accepted | HITL waits indefinitely by default with optional `waiting_timeout_s`; the first answer wins atomically, retries are idempotent, and later answers return `ticket_not_waiting`. |
| D28 | superseded | Superseded by D34: session reuse follows dsh's identity-based, semantic continue/recovery model. |
| D29 | accepted | v0 uses trusted-local Worker isolation (A); a hardened Worker container (B) is the planned future security baseline; per-Ticket containers remain a later option. |
| D30 | accepted | The project bundles pinned Pi Agent and Prime Agent runtimes, with a version manifest and project-owned config/session paths; no global install is required. |
| D31 | accepted | v0 uses minimal observability: JSON logs, SQLite event log, SSE, basic metrics, correlation IDs; OpenTelemetry/Prometheus are deferred. |
| D32 | accepted | Testing uses a pyramid now (unit, contract, integration, small E2E, fault tests); real end-to-end effectiveness tests come later. |
| D33 | accepted | L2 proof ships Chat + Tasks + Task Detail; a UI-agnostic `PageModel` and `OrchestratorClient` are shared by L2 and L3; L2 polls, L3 uses SSE. |
| D34 | accepted | Session reuse follows dsh semantics: Orchestrator decides semantic continue/recovery; Worker resolves/creates the session and reports the outcome; no `resume_eligible` policy gate. |
| D35 | accepted | Strict runtime isolation: bundled binaries, project-owned Pi/Prime agent dirs, sessions, auth, and daemon socket; inherited user `PI_*`/`PRIME_AGENT_*` settings are stripped; global installs and user configs are never used. |
| D36 | accepted | Worker status handoff uses a project-owned Python-backed skill `super-rlm-report` in the Prime Agent kernel, not MCP; missing terminal reports fail closed as `missing_report`. |
| D37 | accepted | Router uses one persistent project-local Pi session with a fixed session ID; its Pi profile is project-owned and reads no global Pi resources; `--new` and `--session` are explicit overrides. |
| D38 | accepted | Each Assignment uses one ACP process; waiting/blocked closes ACP and keeps the resident session; missing terminal reports fail as `missing_report`; tool events are logged, not reported individually. |
| D39 | accepted | Model Registry uses `config/models.yaml`, `config/router.yaml`, `config/profiles.yaml`, and `secrets/providers.env`; `models sync` writes only project-local Pi/Prime configs; Prime custom providers may use a 0600 project-local models.json. |
| D40 | accepted | v0 model selection is explicit profile selection with fixed model aliases; task-aware/automatic model routing is deferred until the explicit path is stable. |
| D41 | accepted | Errors carry a stable code and `retryable` class; transient/worker-loss/startup retry with 3 attempts and 2s/5s/15s jittered backoff; config/workspace/timeout/cancel do not; `missing_report` retries once. |
| D42 | accepted | v0 backup/restore is offline; schema migrations are forward-only with an automatic pre-migration backup; a newer database is refused by older builds; secrets are excluded by default. |
| D43 | accepted | Runtime data lives under a dedicated `SUPER_RLM_ROOT` (`~/.super-rlm`) with per-project `projects/<project_id>` roots; the target project holds only `.super-rlm-project.json`; `SUPER_RLM_HOME` can override the project runtime root. |
| D44 | accepted | v0 is local-first; release packaging, installers, and distribution are deferred until the core loop works locally. |
| D45 | accepted | Router subscribes to Orchestrator SSE and wakes via `pi.sendMessage` with a cursor, deduplication, and actionable-event filtering. |
| D46 | accepted | A turn without a terminal report gets one enforcement prompt, then fails as `missing_report`. |
| D47 | accepted | Ticket stores a logical `session_key = ticket_id`; Worker discovers an opaque `session_ref` and falls back safely when ambiguous. |
| D48 | accepted | `.super-rlm-project.json` is local and gitignored by default; each clone gets its own project ID unless explicitly supplied. |
| D49 | accepted | v0 has no general follow-up API; new work after a terminal Ticket creates a new Ticket. |
| D50 | accepted | `dropped` is a report outcome; the Ticket ends `succeeded` with `outcome = dropped` and `no_op = true`. |
| D51 | accepted | Add `max_concurrent_tickets_per_task` (default 2); the priority slot is not blocked by it. |
| D52 | accepted | Reject exact duplicate titles/prompts within a Task; near-duplicates are warnings; Router prefers fewer Tickets. |

## 31. Decision roadmap and open questions

Resolved and recorded as ADRs: Ticket model, worker topology, Orchestrator, HITL, result aggregation, UI phasing, SQLite, transport, auth, ingress, state machine, Router API, runtime root, profiles, dispatch, slots, Worker contract, deployment, HITL policy, session resume, isolation, bundled runtime, observability, testing.

Remaining P0 decisions before the spikes:

- None. The architecture baseline is ready for the two spikes.

Remaining P1 decisions before v0 implementation:

- First profile set and defaults.

Deferred:

- Release packaging and installers.

Deferred decisions:

- Phase 2 TUI implementation choice (own shell, Pi fork, upstream API).
- Public task-submission API and its admission gateway.
- Per-Task quotas.
- Hardened container/per-Ticket container.
- OpenTelemetry/Prometheus/Grafana.

## 32. UI direction: first-class pages

The CLI is delivered in two UI phases.

### Phase 1: L2 Pi extension pages

Ship three L2 pages:

- Chat (the normal Pi session);
- Tasks (task list with status and ticket counts);
- Task Detail (tickets, summaries, results, questions, errors, and answer/retry/cancel actions).

Use Pi extension commands and `ctx.ui.custom()` for Tasks and Task Detail. L2 refreshes by polling. The shared `PageModel` and `OrchestratorClient` are UI-agnostic. An L2 adapter renders the model with Pi TUI components; an L3 adapter will render the same model in the first-class shell.

### Phase 2: L3 first-class TUI shell

Build a first-class page shell on top of Pi TUI and the Pi Agent SDK. L2 remains available as a fallback and lightweight path.

Both phases share the same page model, Orchestrator client, and actions. Business logic must not live inside Pi extension UI code.

The long-term CLI is a first-class page shell, not a set of temporary extension dialogs.

Pages:

- **Chat**: the Router Pi Agent session.
- **Tasks**: task list with status and ticket counts.
- **Task Detail**: tickets, summaries, results, questions, errors.
- **Workers**: capacity, running assignments, health.
- **Events**: recent events and logs.

Pi's extension `ctx.ui.custom()` is useful for prototypes, but it temporarily takes over the interactive area and returns to chat. It is not a persistent top-level page system.

To get first-class pages, the project needs one of:

1. an own TUI shell built on `@earendil-works/pi-tui` and the Pi Agent SDK;
2. a fork of Pi's interactive mode with a page manager;
3. an upstream Pi API for first-class pages.

The shell owns navigation, page lifecycle, focus, global keybindings, and the status bar. Pi Agent remains the engine behind the Chat page. The Orchestrator remains the source of task facts.

The CLI is TUI-first: `super-rlm` starts the TUI and owns the stack in a Windows Job. There is no background/headless `up` path; `status` and `down` remain for diagnostics and cleanup.

"Role" in this document means a tool/permission profile inside the same CLI, not a separate agent, process, or model. Multiple profiles become useful only for multi-user or least-privilege deployments. The Orchestrator API can add scopes later without changing the domain model.

## 33. Context management and documentation rules

This project is expected to be large. The following rules keep work recoverable after context compaction.

- `docs/architecture.md` is the current source of truth.
- Each material decision gets an ADR under `docs/adr/` with status `proposed`, `accepted`, or `superseded`.
- The handoff snapshot at the top of this document is updated at every milestone.
- Independent research or implementation work is delegated to subagents. Each subagent writes its findings or changes to a file under `docs/research/` or the relevant module.
- The root agent reads those files for fan-in instead of relying on long chat history.
- Before starting a new phase, re-read this document and the ADR index.
- Do not encode a decision only in chat; write it down first or immediately after the discussion.

## 34. Next steps

1. Local spike: Pi Router extension with `defaultTools: []` and only control tools, plus a mock Orchestrator.
2. Local spike: Prime Agent ACP with recursive `rlm.spawn` and the `super-rlm-report` skill.
3. Build the minimal Orchestrator + Worker vertical slice.
4. Run the first end-to-end local task: CLI -> Router -> Orchestrator -> Worker -> Prime Agent -> result.
5. Add the L2 Chat/Tasks/Task Detail pages.
