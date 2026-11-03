# Worker API Contract (v0 draft)

Status: draft v0.1  
Last updated: 2026-11-02

The Orchestrator pushes Assignments to Workers. Workers report facts back. The Orchestrator is the only writer of Task, Ticket, and Assignment state.

## 1. Endpoints

### Worker -> Orchestrator

```text
POST /internal/v1/workers/register
POST /internal/v1/workers/{worker_id}/heartbeat
POST /internal/v1/reports
POST /internal/v1/assignments/{assignment_id}/heartbeat
```

### Orchestrator -> Worker

```text
POST /v1/executions
POST /v1/executions/{execution_id}/cancel
GET  /v1/health
```

## 2. Registration

```json
{
  "worker_id": "wrk_...",
  "url": "http://worker:8080",
  "max_concurrency": 4,
  "version": "0.1.0"
}
```

The Orchestrator stores the URL, capacity, running count, and last heartbeat.

## 3. Worker heartbeat

```json
{
  "running": 2,
  "max_concurrency": 4,
  "status": "healthy"
}
```

Suggested values:

- heartbeat interval: 10 seconds;
- worker lease timeout: 30 seconds.

A missed worker heartbeat marks the worker `lost`. Its active Assignments become `lost` and follow retry policy.

## 4. Start an execution

```json
{
  "ticket_id": "tkt_...",
  "assignment_id": "asg_...",
  "prompt": "worker prompt",
  "profile": "default",
  "workspace": "/data/workspaces/tkt_...",
  "deadline": "2026-11-02T12:15:00Z",
  "resume": null
}
```

Resume after a question or blocker:

```json
{
  "resume": {
    "session_ref": "prime-session-...",
    "message": "Linux"
  }
}
```

Response:

```json
{
  "execution_id": "exe_...",
  "status": "accepted"
}
```

- `202`: accepted.
- `409`: at capacity.
- `4xx`: invalid profile, prompt, token, or request.

Starting the same `assignment_id` twice is idempotent: return the existing `execution_id`. A different assignment for the same execution is a conflict.

## 5. Worker reports

```http
POST /internal/v1/reports
```

Headers:

```text
Authorization: Bearer <worker.token>
X-SuperRLM-Timestamp: <unix seconds>
X-SuperRLM-Nonce: <unique nonce>
X-SuperRLM-Signature: HMAC-SHA256(secret, timestamp + nonce + body)
```

Body:

```json
{
  "ticket_id": "tkt_...",
  "assignment_id": "asg_...",
  "execution_id": "exe_...",
  "seq": 1,
  "idempotency_key": "asg_...:1",
  "state": "progress | waiting | blocked | completed | dropped | failed | cancelled",
  "summary": "short summary",
  "result": null,
  "artifacts": [],
  "usage": {},
  "error": null,
  "session_ref": "prime-session-...",
  "resumed": true,
  "recovery": false,
  "question": null,
  "timestamp": "2026-11-02T12:01:00Z"
}
```

### Report states

| State | Meaning | Assignment result |
| --- | --- | --- |
| `progress` | Non-terminal update. | Stays running. |
| `waiting` | Needs a user answer. | Ends with `waiting`. |
| `blocked` | Needs an external action. | Ends with `blocked`. |
| `completed` | Ticket succeeded. | Ends with `completed`. |
| `dropped` | Nothing to do. | Ends with `completed`; Ticket records `outcome=dropped`, `no_op=true`. |
| `failed` | Ticket failed. | Ends with `failed`. |
| `cancelled` | Worker stopped due to a cancel request. | Ends with `cancelled`. |

`waiting` and `blocked` must include:

```json
{
  "question": {
    "kind": "waiting | blocked",
    "text": "Linux or Windows?"
  },
  "session_ref": "prime-session-..."
}
```

`completed` must include `summary`, `result` or artifacts, and optionally `usage`.

`failed` must include:

```json
{
  "error": {
    "code": "model_not_configured",
    "message": "..."
  }
}
```

## 6. Sequencing and idempotency

- `seq` starts at 1 and increases within one Assignment.
- `idempotency_key` is unique per report, e.g. `assignment_id:seq`.
- A duplicate or stale report returns success without changing state.
- A report for an Assignment that already ended returns:

```json
{
  "accepted": false,
  "reason": "assignment_ended"
}
```

The Worker must stop the execution when it receives this response.

## 7. Assignment heartbeat

```json
{
  "execution_id": "exe_...",
  "phase": "running | waiting | blocked"
}
```

- Send periodically while the execution is active.
- The Orchestrator marks the Assignment `lost` after the lease timeout.
- A `410 assignment_lost` response tells the Worker to stop and clean up.

## 8. Cancellation

```http
POST /v1/executions/{execution_id}/cancel
```

```json
{ "reason": "user_cancelled" }
```

- The Orchestrator is authoritative for cancellation.
- It marks the Assignment `ended(cancelled)` and the Ticket `cancelled`.
- The Worker cancels the ACP session and stops.
- A later `cancelled` report is accepted as an audit fact if the Assignment is still open; otherwise it is ignored.
- Cancellation does not require a Worker terminal report for correctness.

## 9. Result size

- `summary`: at most 2 KiB.
- `result`: at most 64 KiB inline.
- Larger output must be written to the workspace and reported as `artifacts`.
- `artifacts` entries are relative paths inside the workspace:

```json
[
  { "type": "file", "path": "out.md", "mime": "text/markdown" }
]
```

The Orchestrator stores metadata, not the file contents. `ticket_result` can return the inline result or artifact metadata.

## 10. Timeout

- The Orchestrator sets `deadline`.
- The Worker enforces it and reports `failed` with `error.code = "timeout"` when possible.
- The Orchestrator also has a timer: when the deadline passes, it marks the Ticket `timed_out` and sends a cancel.
- The Orchestrator's decision wins.

## 11. Worker shutdown

- A graceful Worker stops accepting new executions.
- It sends a final worker heartbeat with `status: "draining"`.
- Active Assignments are allowed to finish until the Worker shutdown deadline.
- On forced shutdown, active Assignments become `lost` after heartbeat expiry.

## 12. Errors

Stable error codes are part of the contract:

```text
at_capacity
invalid_profile
invalid_prompt
invalid_token
assignment_ended
assignment_lost
timeout
model_not_configured
workspace_error
prime_agent_start_failed
prime_agent_protocol_error
```
