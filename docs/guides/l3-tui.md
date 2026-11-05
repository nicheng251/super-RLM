# L3 TUI

Status: vertical slice implemented  
Last updated: 2026-11-05

The L3 TUI is a standalone terminal app in `apps/tui`, not another Pi extension
page. L2 (`apps/router/extensions/pages.ts`) remains available as a fallback.

## Start

```powershell
cd C:\Users\15065\Project\super-RLM
node apps\cli\src\main.ts tui
```

`super-rlm tui`:

1. ensures Orchestrator and Worker are running;
2. starts the L3 app in the current directory;
3. the L3 app starts Pi in RPC mode with the existing Router extension.

The default `super-rlm` command still starts L2 for now.

## Architecture

```text
apps/tui
  ├─ @earendil-works/pi-tui
  │    TuiAltScreen / VStack / HStack / ScrollView / Editor
  ├─ @earendil-works/pi-coding-agent RpcClient
  │    └─ Pi Router session (--mode rpc)
  ├─ OrchestratorClient
  │    ├─ Tasks / Task Detail
  │    ├─ Workers
  │    └─ ticket actions
  └─ SSE /v1/events
```

Shared code:

```text
apps/router/src/client.ts
apps/router/src/page-model.ts
apps/cli/src/config.ts
```

## Views

- Chat: Pi RPC transcript, streaming text, tool calls, abort/steer.
- Tasks: task list, status, waiting indicator.
- Task Detail: tickets, profile, question, error, workspace, branch/commit,
  delivered_to, delivery_error.
- Workers: `GET /v1/workers`.
- Events: SSE stream with cursor and reconnect.

## Keys

```text
Ctrl+1..5     switch Chat/Tasks/Detail/Workers/Events
Ctrl+C        exit
Esc           back / abort Chat turn
Tab           focus sidebar or editor
j / k         move
Enter         send Chat / open Task
a             answer waiting Ticket
s             resume blocked Ticket
t             retry failed Ticket
c             cancel Ticket
q             back to Tasks
r             refresh
```

Ctrl+digit depends on Kitty keyboard protocol support. On legacy terminals use
the sidebar (Tab + j/k + Enter).

## Limitations

- Chat RPC startup is smoke-tested; a full live DeepSeek Chat E2E is still to
  be added.
- `read_only` is not enforced by the TUI.
- Workers view depends on `GET /v1/workers`.
- Mouse support is limited to pi-tui defaults.
- `apps/tui` uses `file:` links into `runtime/pi/node_modules`; runtime/pi must
  be provisioned before `npm install`/run.
