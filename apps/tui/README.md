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

## Layout

Status bar at the top, main content/Chat on the left, the view sidebar on the
right, and the Chat editor spanning the full terminal width at the bottom.

## Views

- **Chat** - Pi Router session over RPC. Enter sends; while a turn runs, Enter
  steers it. Esc aborts a running turn.
- **Tasks** - `OrchestratorClient.listTasks`; j/k select, Enter opens the detail.
  `f` cycles the filter (all, waiting, running, terminal), and `/search <text>`
  matches task ids or prompts case-insensitively. The footer shows the active
  filter and search.
- **Task Detail** - opened from Tasks with Enter; tickets with profile, summary,
  question, error, workspace, branch, commit, and delivery fields. `a` answers a
  waiting ticket, `s` resumes, `t` retries, `c` cancels, `v` opens a read-only
  session viewer.
- **Workers** - `GET /v1/workers` (defensive; shows an error if the route is
  absent).
- **Events** - SSE `GET /v1/events?after=<cursor>` with reconnect and backoff.

Alt+1..4 is the only view-switching shortcut (Chat, Tasks, Workers, Events).
Task Detail is a subpage opened with Enter from Tasks, not a sidebar item.
`v` opens the selected Ticket's Prime session read-only. Session view keeps the
sidebar and input hint visible, uses `j/k` to scroll, `r` to refresh, and `Esc`
to return to Task Detail. Alt+1..4 are disabled while it is open.
Ctrl+digit, F-keys, Tab, and sidebar navigation are not used for view switching.
Ctrl+C exits. The Chat editor autocompletes non-view slash commands.

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
/filter [name]
/search <text>
/clear
/refresh
/answer
/abort
/model
/quit
/help
```

`/model` opens a two-stage Model & Profiles page in the Chat content area. On
the Profile page, Up/Down selects and Enter opens model selection; Esc closes.
On the model page, Up/Down selects a model, Left/Right adjusts thinking, Enter
applies and returns to the Profile page, and Esc returns without applying. The
sidebar, the input-box hint, and the Chat input box remain visible and are not
covered; Chat content is replaced. Alt+1..4 is disabled while the page is open. Router changes apply to the current session;
Worker profile changes persist to
`<SUPER_RLM_HOME>/profiles.overrides.json`.

View switching is `Alt+1..4` only. The Chat editor autocompletes slash commands after `/`.
