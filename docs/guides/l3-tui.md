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

## Layout

```text
status bar
┌──────────────────────────────────────┬──────────────┐
│ main content / Chat transcript       │ sidebar      │
└──────────────────────────────────────┴──────────────┘
help line
full-width Chat editor
```

The editor spans the terminal width at the bottom. Chat and task content are
on the left; the view sidebar is on the right.

## Views

- Chat: Pi RPC transcript, streaming text, tool calls, abort/steer.
- Tasks: task list, status, waiting indicator.
- Task Detail: tickets, profile, question, error, workspace, branch/commit,
  delivered_to, delivery_error.
- Workers: `GET /v1/workers`.
- Events: SSE stream with cursor and reconnect.

## Keys

```text
Alt+1         Chat
Alt+2         Tasks
Alt+3         Workers
Alt+4         Events
Enter         open the selected Task's Detail subpage
Esc           in Task Detail, return to Tasks
/             command mode (type /command in Chat)
Ctrl+C        exit
Esc           back / abort Chat turn
j / k         move
Enter         send Chat / open Task
a             answer waiting Ticket
s             resume blocked Ticket
t             retry failed Ticket
c             cancel Ticket
q             back to Tasks
r             refresh
```

**Alt+1..4 is the only view-switching shortcut.** Task Detail is not a
top-level view; open it with Enter from Tasks. Ctrl+digit, F-keys, Tab, sidebar
digits, and slash commands are not view-switching methods. The Chat editor
autocompletes non-view slash commands after `/`.

Slash commands:

```text
/filter [all|waiting|running|terminal]
/search <text>
/clear
/refresh
/answer
/abort
/model
/quit
/help
```

`/model` opens a full-screen Model & Profiles page. It hides Chat and the
sidebar while open, but keeps the Chat input box visible at the bottom. Old text forms such as `/model list` and
`/model thinking <level>` are not supported.

Profile page:

```text
Model & Profiles
▸ Router                 deepseek/deepseek-flash  thinking:medium  ctx:1M
  Worker: default        deepseek/deepseek-flash  thinking:medium  ctx:1M
  Worker: git            deepseek/deepseek-flash  thinking:high    ctx:1M
```

```text
Up/Down   select Profile
Enter     open that Profile's model selection
Esc       close and return to Chat
```

Model page:

```text
Model · Worker: git
▸ deepseek/deepseek-flash  ctx:1M  *
  deepseek/deepseek-pro    ctx:2M
Thinking: ← medium →   ctx:1M
```

```text
Up/Down   select model
Left/Right adjust thinking level
Enter     apply and return to the Profile page
Esc       return to the Profile page without applying
```

While either page is open, Alt+1..4 view switching is disabled, and the input
box is not focused.
Router changes apply to the current Router session. Worker profile changes are
saved under `<SUPER_RLM_HOME>/profiles.overrides.json` and apply to subsequent
Tickets without restarting the Orchestrator. `config/profiles.yaml` remains the
base configuration. Model changes are rejected while a Router turn is running.

View switching is `Alt+1..4` only. Task Detail is a child page of Tasks.

`f` cycles the Tasks filter. `waiting` includes tasks with waiting/blocked
counts; `running` includes tasks with running tickets; `terminal` includes
succeeded/partial/failed/cancelled/timed_out.

## Limitations

- Live DeepSeek Chat E2E has passed (`docs/spikes/l3-chat-e2e.md`).
- `read_only` is not enforced by the TUI.
- Workers view depends on `GET /v1/workers`.
- Mouse support is limited to pi-tui defaults.
- `apps/tui` uses `file:` links into `runtime/pi/node_modules`; runtime/pi must
  be provisioned before `npm install`/run.
