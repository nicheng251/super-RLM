# Project Structure

Status: planned v0.1  
Last updated: 2026-11-02

This is the planned monorepo layout. It follows the accepted ADRs and keeps the Router, Orchestrator, Worker, and protocol packages decoupled.

## 1. Top-level tree

```text
super-RLM/
├── README.md
├── LICENSE
├── package.json                    # pnpm workspace root and scripts
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json
├── biome.json                      # formatter/linter
├── .gitignore
├── .env.example
├── docker-compose.yml
│
├── apps/
│   ├── orchestrator/               # TypeScript control plane
│   ├── router/                     # Pi Agent Router profile + extension
│   ├── worker/                     # Python FastAPI + Prime Agent ACP adapter
│   ├── cli/                        # super-rlm launcher and headless commands
│   └── tui/                        # L3 first-class shell (later)
│
├── packages/
│   ├── protocol/                   # OpenAPI/JSON Schema + generated clients
│   ├── page-model/                 # UI-agnostic page state and actions
│   ├── orchestrator-client/        # TypeScript client for Router/UI
│   ├── config/                     # Model Registry and profile schema/loader
│   └── test-fixtures/              # fake Orchestrator/Worker, sample data
│
├── config/                         # committed defaults, no secrets
│   ├── models.example.yaml
│   ├── profiles.yaml
│   ├── router-prompt.md
│   └── worker-prompt.md
│
├── runtime/                        # pinned/generated; binaries gitignored
│   ├── manifest.json
│   ├── pi/
│   └── prime-agent/
│
├── scripts/
│   ├── bootstrap-runtime.ts
│   ├── dev.ts
│   ├── models-sync.ts
│   ├── doctor.ts
│   └── package-release.ts
│
├── deploy/
│   ├── docker/
│   │   ├── Dockerfile.orchestrator
│   │   ├── Dockerfile.worker
│   │   └── entrypoint-worker.sh
│   └── compose/
│       └── docker-compose.yml
│
├── tests/
│   ├── contract/
│   ├── integration/
│   ├── e2e/
│   └── fault/
│
├── docs/
│   ├── README.md
│   ├── architecture.md
│   ├── project-structure.md
│   ├── adr/
│   ├── protocol/
│   └── spikes/
│
└── .super-rlm-project.json         # local project id marker, gitignored
```

## 2. Orchestrator

```text
apps/orchestrator/
├── package.json
├── tsconfig.json
├── src/
│   ├── main.ts
│   ├── app/
│   │   ├── server.ts               # Fastify composition root
│   │   ├── config.ts
│   │   └── wiring.ts
│   ├── domain/
│   │   ├── task.ts
│   │   ├── ticket.ts
│   │   ├── assignment.ts
│   │   ├── report.ts
│   │   ├── state-machine.ts
│   │   ├── scheduler.ts
│   │   ├── slots.ts
│   │   └── profile.ts
│   ├── api/
│   │   ├── tasks.ts
│   │   ├── tickets.ts
│   │   ├── workers.ts
│   │   ├── events.ts
│   │   └── internal.ts
│   ├── store/
│   │   ├── sqlite.ts
│   │   ├── migrations/
│   │   └── repositories/
│   ├── workers/
│   │   ├── registry.ts
│   │   └── dispatch.ts
│   ├── events/
│   │   ├── log.ts
│   │   └── sse.ts
│   ├── auth/
│   └── outbox/
└── tests/
```

Rules:

- It is the only writer of Task, Ticket, Assignment, and Report state.
- It contains no LLM calls and no task decomposition.
- It depends on `packages/protocol` and `packages/config`, not on Router or Worker implementation code.

## 3. Router / Pi profile

```text
apps/router/
├── package.json
├── .pi/
│   ├── settings.json               # defaultTools: [] + extension
│   └── extensions/
│       └── super-rlm.ts
├── prompts/
│   └── router.md
├── src/
│   ├── extension.ts                # registers commands and tools
│   ├── client.ts                   # OrchestratorClient
│   ├── tools/
│   │   ├── profile-list.ts
│   │   ├── task-create.ts
│   │   ├── task-list.ts
│   │   ├── task-status.ts
│   │   ├── task-wait.ts
│   │   ├── ticket-result.ts
│   │   ├── ticket-answer.ts
│   │   ├── ticket-resume.ts
│   │   ├── ticket-retry.ts
│   │   ├── ticket-cancel.ts
│   │   └── task-cancel.ts
│   └── pages/
│       ├── page-host.ts            # L2 custom-screen host
│       ├── tasks-page.ts
│       └── task-detail-page.ts
└── tests/
```

Rules:

- Pi built-in tools are disabled.
- The Router has control-plane tools only.
- Page rendering uses Pi TUI; page logic lives in `packages/page-model`.
- It never calls Worker directly.

## 4. Worker

```text
apps/worker/
├── pyproject.toml
├── uv.lock
├── src/
│   └── super_rlm_worker/
│       ├── main.py
│       ├── config.py
│       ├── api.py                  # FastAPI endpoints
│       ├── executor.py             # one execution per Ticket
│       ├── acp_client.py           # ACP JSON-RPC over stdio
│       ├── prime_agent.py          # process/session lifecycle
│       ├── profiles.py             # profile -> Prime Agent flags
│       ├── workspace.py
│       ├── reports.py              # seq/idempotency + HMAC
│       ├── heartbeat.py
│       └── logging.py
└── tests/
```

Rules:

- One Ticket = one ACP process/session.
- It never writes Task/Ticket state.
- It reports facts and heartbeats.
- It uses the project-owned Prime Agent session directory.
- It imports the generated Python protocol client, not Orchestrator code.

## 5. CLI

```text
apps/cli/
├── package.json
├── src/
│   ├── main.ts
│   ├── launch-router.ts            # set env, launch Pi in apps/router
│   ├── doctor.ts
│   ├── models-sync.ts
│   └── config.ts
└── bin/
    └── super-rlm
```

Commands:

```text
super-rlm                 # launch Router TUI
super-rlm tasks           # headless task list
super-rlm doctor
super-rlm models sync
super-rlm
```

## 6. Packages

```text
packages/protocol/
├── openapi.yaml
├── schemas/
│   ├── task.schema.json
│   ├── ticket.schema.json
│   ├── report.schema.json
│   └── event.schema.json
├── ts/                             # generated TypeScript client/types
└── python/                         # generated Python client package
```

```text
packages/page-model/
├── src/
│   ├── page-model.ts               # state/actions, no Pi/TUI imports
│   ├── tasks-page.ts
│   └── task-detail-page.ts
└── tests/
```

```text
packages/orchestrator-client/
├── src/
│   ├── client.ts
│   └── sse.ts
└── tests/

packages/config/
├── src/
│   ├── models.ts                   # Model Registry schema/loader
│   ├── profiles.ts
│   └── sync.ts
└── tests/
```

```text
packages/test-fixtures/
├── src/
│   ├── fake-orchestrator.ts
│   ├── fake-worker.ts
│   └── sample-tasks.ts
```

## 7. Config and runtime

```text
config/
  models.example.yaml               # committed template, no secrets
  profiles.yaml                     # committed default profiles
  router-prompt.md
  worker-prompt.md

runtime/
  manifest.json                     # pinned versions/checksums
  pi/                               # generated/pinned, gitignored
  prime-agent/                      # generated/pinned, gitignored
```

`super-rlm models sync` writes only project-owned files:

```text
<SUPER_RLM_HOME>/pi/agent/models.json
<SUPER_RLM_HOME>/prime/agent/models.json
```

Project runtime root:

```text
SUPER_RLM_ROOT = ~/.super-rlm
<SUPER_RLM_HOME> = $SUPER_RLM_ROOT/projects/<project_id>
```

The target project holds only `.super-rlm-project.json`. Runtime isolation: bundled binaries only, project-owned agent/session/daemon paths, inherited `PI_*`/`PRIME_AGENT_*` stripped, no `~/.pi` or `~/.prime`.

## 8. Tests

```text
tests/
├── contract/                       # OpenAPI/schema/client checks
├── integration/                    # Orchestrator + fake Worker, Worker + fake ACP
├── e2e/                            # CLI -> Router -> Orchestrator -> Worker -> Prime ACP
└── fault/                          # kill Worker, lease expiry, restart, resume
```

Unit tests live beside the code in each app/package.

## 9. Dependency direction

```text
apps/cli
  -> apps/router
  -> packages/orchestrator-client
  -> packages/config

apps/router
  -> packages/orchestrator-client
  -> packages/page-model
  -> packages/protocol

apps/orchestrator
  -> packages/protocol
  -> packages/config

apps/worker
  -> packages/protocol/python
  -> Prime Agent ACP

packages/page-model
  -> packages/orchestrator-client
  -> packages/protocol
  -> no Pi imports
  -> no TUI imports
```

No app imports another app's source. Cross-app contracts go through `packages/protocol`.
