# Router API Contract (v0 draft)

Status: draft v0.1  
Last updated: 2026-11-02

The Router talks to the Orchestrator through model-facing tools. The same operations exist as internal REST endpoints. The Orchestrator is the only state writer.

## 1. Tool surface

| Tool | Mutates | Purpose |
| --- | --- | --- |
| `profile_list` | no | List configured Worker profiles and their descriptions. |
| `task_create` | yes | Create a Task and its Tickets. |
| `task_list` | no | List Tasks. |
| `task_status` | no | Read one Task and its Tickets. |
| `task_wait` | no | Wait for a Task to settle or time out. |
| `ticket_result` | no | Read one Ticket's full result. |
| `ticket_answer` | yes | Answer a Ticket in `waiting`. |
| `ticket_resume` | yes | Resume a Ticket in `blocked`. |
| `ticket_retry` | yes | Retry a failed Ticket. |
| `ticket_cancel` | yes | Cancel one Ticket. |
| `task_cancel` | yes | Cancel a Task and its active Tickets. |

`task_events` is a read-only internal API for UI pages; it is not required as a Router tool.

## 2. profile_list

Request:

```json
{}
```

Response:

```json
{
  "profiles": [
    {
      "name": "default",
      "description": "General-purpose worker",
      "provider": "deepseek",
      "model": "deepseek-flash",
      "thinking": "medium"
    },
    {
      "name": "git",
      "description": "Ticket running in a dedicated git worktree",
      "provider": "deepseek",
      "model": "deepseek-flash",
      "thinking": "medium"
    }
  ]
}
```

The response never contains credentials.

## 3. task_create

The Router decides how to split. The Orchestrator does not split.

Request:

```json
{
  "prompt": "original user request",
  "tickets": [
    {
      "title": "short title",
      "prompt": "self-contained worker prompt",
      "profile": "default",
      "metadata": {}
    }
  ],
  "metadata": {}
}
```

Rules:

- `tickets` has at least one item.
- v0 limit: at most 16 Tickets per Task.
- `title` is at most 200 characters.
- `prompt` is non-empty.
- `profile` must name a configured profile; omitted means `default`.
- The HTTP layer supplies `Idempotency-Key`; the tool layer may generate one from the conversation and request.

Response:

```json
{
  "task_id": "tsk_...",
  "status": "queued",
  "tickets": [
    {
      "ticket_id": "tkt_...",
      "title": "short title",
      "status": "queued"
    }
  ]
}
```

## 4. task_list

Request:

```json
{
  "status": "running",
  "limit": 20,
  "cursor": null
}
```

Response:

```json
{
  "tasks": [
    {
      "task_id": "tsk_...",
      "status": "running",
      "prompt": "original user request",
      "ticket_count": 3,
      "running_count": 1,
      "waiting_count": 1,
      "created_at": "2026-11-02T12:00:00Z",
      "updated_at": "2026-11-02T12:01:00Z"
    }
  ],
  "next_cursor": null
}
```

## 5. task_status

Request:

```json
{ "task_id": "tsk_..." }
```

Response:

```json
{
  "task_id": "tsk_...",
  "status": "running",
  "prompt": "original user request",
  "created_at": "2026-11-02T12:00:00Z",
  "updated_at": "2026-11-02T12:01:00Z",
  "tickets": [
    {
      "ticket_id": "tkt_...",
      "title": "short title",
      "status": "waiting",
      "profile": "default",
      "summary": "needs a platform choice",
      "question": {
        "kind": "waiting",
        "text": "Linux or Windows?",
        "asked_at": "2026-11-02T12:01:00Z"
      },
      "error": null,
      "workspace": "/data/workspaces/tkt_...",
      "workspace_metadata": {
        "vcs": "git",
        "branch": "agent/tkt_...",
        "commit": "abc123"
      },
      "metadata_error": null,
      "branch": "agent/tkt_...",
      "commit": "abc123",
      "delivered_to": ["/home/user/output/out.md"],
      "delivery_error": null
    }
  ]
}
```

## 6. task_wait

Request:

```json
{
  "task_id": "tsk_...",
  "timeout_s": 120
}
```

Response: the same `TaskView` shape as `task_status`, with the current status at return time. If the timeout expires, the response is the current non-terminal TaskView.

The HTTP endpoint may stream progress with SSE while the tool waits. The tool response is still the final TaskView.

## 7. ticket_result

Request:

```json
{
  "ticket_id": "tkt_...",
  "max_chars": 20000
}
```

Response:

```json
{
  "ticket_id": "tkt_...",
  "status": "succeeded",
  "summary": "short summary",
  "result": "full result text",
  "artifacts": [
    { "type": "file", "path": "out.md" }
  ],
  "usage": { "tokens": 1234 },
  "error": null,
  "session_ref": "prime-session-...",
  "workspace": "/data/workspaces/tkt_...",
  "workspace_metadata": {
    "vcs": "git",
    "branch": "agent/tkt_...",
    "commit": "abc123"
  },
  "metadata_error": null,
  "branch": "agent/tkt_...",
  "commit": "abc123",
  "delivered_to": ["/home/user/output/out.md"],
  "delivery_error": null
}
```

`max_chars` bounds the returned `result`; the full result remains in Orchestrator storage.
`workspace` is the runtime workspace path. `workspace_metadata` is the JSON
object produced by the profile's optional `metadata_command`; `branch` and
`commit` are compatibility views when `workspace_metadata.vcs == "git"`.
`delivered_to` lists files copied to the Task's `origin_cwd`; `delivery_error`
is non-null when that copy failed.

## 8. ticket_answer

For Tickets in `waiting`.

Request:

```json
{
  "ticket_id": "tkt_...",
  "message": "Linux"
}
```

The HTTP layer supplies `Idempotency-Key`. A retry with the same key returns the original `assignment_id`. A different answer after the Ticket left `waiting` returns `ticket_not_waiting`.

Response:

```json
{
  "ticket_id": "tkt_...",
  "status": "queued",
  "assignment_id": "asg_..."
}
```

## 9. ticket_resume

For Tickets in `blocked`.

Request:

```json
{
  "ticket_id": "tkt_...",
  "note": "Credentials are now configured."
}
```

Response: same shape as `ticket_answer`.

## 10. ticket_retry

For Tickets in `failed` or `lost`.

Request:

```json
{
  "ticket_id": "tkt_...",
  "note": "Retry with the updated input."
}
```

Response: same shape as `ticket_answer`.

## 11. ticket_cancel

Request:

```json
{
  "ticket_id": "tkt_...",
  "reason": "No longer needed"
}
```

Response:

```json
{
  "ticket_id": "tkt_...",
  "status": "cancelled"
}
```

## 12. task_cancel

Request:

```json
{
  "task_id": "tsk_...",
  "reason": "No longer needed"
}
```

Response:

```json
{
  "task_id": "tsk_...",
  "status": "cancelled"
}
```

## 13. Internal REST mapping

```text
POST   /v1/tasks
GET    /v1/tasks
GET    /v1/tasks/{task_id}
GET    /v1/tasks/{task_id}/wait
GET    /v1/tasks/{task_id}/events
GET    /v1/tickets/{ticket_id}/result
POST   /v1/tickets/{ticket_id}/answer
POST   /v1/tickets/{ticket_id}/resume
POST   /v1/tickets/{ticket_id}/retry
POST   /v1/tickets/{ticket_id}/cancel
POST   /v1/tasks/{task_id}/cancel
```

All endpoints are internal and require a scoped bearer token. SSE endpoints use the same token.

## 14. Error envelope

```json
{
  "error": {
    "code": "ticket_not_waiting",
    "message": "Ticket tkt_... is running, not waiting",
    "details": {}
  }
}
```

Stable error codes are part of the contract. Messages are for humans.

## 15. Open questions

- Should `task_create` allow a `callback_url` in v0, or only the CLI?
- Should `ticket_result` support pagination for very large results?
- Should `task_list` include ended Tasks by default, or require a filter?
