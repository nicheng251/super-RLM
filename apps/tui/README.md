# super-RLM TUI (L3)

Standalone alternate-screen terminal app for the L3 shell. It drives the existing
Pi Router through `RpcClient` and reads task/worker/event state from the
Orchestrator. It does not call a model directly.

Run:

```sh
npm install
npm run dev
```

or, once services are up:

```sh
super-rlm tui
```

## Views

- **Chat** - Pi Router session over RPC. Enter sends; while a turn runs, Enter
  steers it. Esc aborts a running turn.
- **Tasks** - `OrchestratorClient.listTasks`; j/k select, Enter opens the detail.
  `f` cycles the filter (all, waiting, running, terminal), and `/search <text>`
  matches task ids or prompts case-insensitively. The footer shows the active
  filter and search.
- **Task Detail** - tickets with profile, summary, question, error, workspace,
  branch, commit, and delivery fields. `a` answers a waiting ticket, `t` retries,
  `c` cancels, `q` goes back.
- **Workers** - `GET /v1/workers` (defensive; shows an error if the route is
  absent).
- **Events** - SSE `GET /v1/events?after=<cursor>` with reconnect and backoff.

Ctrl+1..5 jump to a view, Tab moves focus between the sidebar and the main area,
Ctrl+C exits.

## Notes

- Node 26 type stripping runs `src/main.ts` directly; there is no build step.
- `apps/tui` imports `OrchestratorClient`, `TasksPageModel`, and
  `TaskDetailPageModel` from `apps/router/src`, plus the exact CLI config
  helpers, by relative path instead of duplicating them. It does not modify
  either app.
- Pi stderr is captured while the app owns the alternate screen so
  child-process diagnostics do not corrupt the display.


## Commands

Type a slash command in the Chat editor, or press `/` from another view to open
command mode:

```text
/chat
/tasks
/detail [task_id]
/workers
/events
/filter [name]
/search <text>
/clear
/refresh
/answer
/abort
/quit
/help
```

`Alt+1..5` and, with the sidebar focused, `1..5` also switch views when a
terminal does not report Ctrl+digit.
