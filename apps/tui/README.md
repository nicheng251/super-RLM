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
  waiting ticket, `s` resumes, `t` retries, `c` cancels.
- **Workers** - `GET /v1/workers` (defensive; shows an error if the route is
  absent).
- **Events** - SSE `GET /v1/events?after=<cursor>` with reconnect and backoff.

Alt+1..4 is the only view-switching shortcut (Chat, Tasks, Workers, Events).
Task Detail is a subpage opened with Enter from Tasks, not a sidebar item.
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

`/model` opens a full-screen two-stage Model & Profiles page. On the Profile
page, Up/Down selects and Enter opens model selection; Esc closes. On the model
page, Up/Down selects a model, Left/Right adjusts thinking, Enter applies and
stays, and Esc returns to the Profile page. The page hides Chat and the sidebar
and disables Alt+1..4 while open. Router changes apply to the current session;
Worker profile changes persist to
`<SUPER_RLM_HOME>/profiles.overrides.json`.

View switching is `Alt+1..4` only. The Chat editor autocompletes slash commands after `/`.
