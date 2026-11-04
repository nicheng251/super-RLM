# Router

Project-local Pi Agent extension. Control plane only.

## Run

```bash
cd apps/router
PI_CODING_AGENT_DIR="$HOME/.super-rlm/projects/<project_id>/pi/agent" \
PI_CODING_AGENT_SESSION_DIR="$HOME/.super-rlm/projects/<project_id>/pi/sessions" \
SUPER_RLM_ORCHESTRATOR_URL=http://127.0.0.1:8787 \
SUPER_RLM_ROUTER_TOKEN=router-token \
node ../../runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  --print -a --no-extensions -e ./extensions/super-rlm.ts \
  --no-skills --no-context-files --no-prompt-templates --no-themes --no-mcp -nbt \
  --session-dir "$HOME/.super-rlm/projects/<project_id>/pi/sessions" \
  "What should I do next?"
```

## Tools

```text
profile_list, task_create, task_list, task_status, task_wait, ticket_result,
ticket_answer, ticket_resume, ticket_retry, ticket_cancel, task_cancel
```

No `bash`, file, MCP, codemode, or skill tools are registered. A hallucinated
built-in tool call returns `Tool <name> not found`.

## L2 pages

```text
/tasks        Tasks page: list, select, open Task Detail
/task <id>    Task Detail page
```

Keys on Tasks: `↑↓` navigate, `Enter` open, `r` refresh, `q`/Esc close.

Keys on Task Detail: `↑↓` ticket, `a` answer a waiting Ticket, `b` resume a
blocked Ticket, `t` retry a failed/lost Ticket, `x` cancel a Ticket, `c` cancel
the Task, `r` refresh, `q`/Esc close.

Page state and actions live in `src/page-model.ts`; `extensions/pages.ts` only
renders with Pi TUI and forwards actions. The same model is intended for L3.

## Notifications

On `session_start`, the extension subscribes to `GET /v1/events`. It wakes the
Pi session with `pi.sendMessage` for `ticket.waiting`, `ticket.blocked`, and
`task.settled`. Reconnects resume from the last event cursor. Notifications are
throttled to one per 5 seconds.

## Notes

- `defaultTools: []` in `.pi/settings.json` is the primary guard; `-nbt` is a
  second guard.
- `-a` trusts the project `.pi` settings. Explicit `-e` still loads the
  extension without trust.
- The SSE notification path needs an interactive/RPC session; `--print` exits
  before a queued follow-up turn.
