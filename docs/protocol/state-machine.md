# State Machine and Report Protocol

Status: draft v0.1  
Last updated: 2026-11-02

## 1. Principles

- The Orchestrator is the only writer of Task, Ticket, and Assignment state.
- Worker reports are facts, not state transitions.
- Lifecycle and outcome are separate.
- Ticket states are explicit; Assignment uses lifecycle plus `end_reason`.
- A Ticket may have several Assignments over time: first run, resume after a question, retry after failure.

## 2. Task states

```text
queued | running | waiting | succeeded | partial | failed | cancelled | timed_out
```

| State | Meaning |
| --- | --- |
| `queued` | Created; no active Ticket yet. |
| `running` | At least one Ticket is assigned or running. |
| `waiting` | No Ticket is running or queued; at least one Ticket is waiting or blocked. |
| `succeeded` | All Tickets succeeded. |
| `partial` | At least one Ticket succeeded and at least one did not. |
| `failed` | No Ticket succeeded; at least one failed. |
| `cancelled` | Task cancelled by the user. |
| `timed_out` | Task-level timeout. |

`partial` is derived, not manually set.

### Task derivation order

1. If the Task was cancelled: `cancelled`.
2. If the Task-level timeout fired: `timed_out`.
3. If any Ticket is `assigned` or `running`: `running`.
4. If any Ticket is `queued`: `queued`.
5. If any Ticket is `waiting` or `blocked`: `waiting`.
6. All Tickets terminal:
   - all `succeeded`: `succeeded`
   - any `succeeded` and any non-succeeded: `partial`
   - all `cancelled`: `cancelled`
   - any `failed`: `failed`
   - else: `timed_out`

## 3. Ticket states

```text
queued | assigned | running | waiting | blocked | succeeded | failed | cancelled | timed_out | lost
```

| State | Meaning |
| --- | --- |
| `queued` | Waiting for Worker capacity. |
| `assigned` | An Assignment is being started. |
| `running` | The Worker is executing. |
| `waiting` | The Worker asked the user a question; the slot is released. |
| `blocked` | An external condition or action is required; the slot is released. |
| `succeeded` | Final success. |
| `failed` | Final failure. |
| `cancelled` | Cancelled by the user or Task. |
| `timed_out` | Ticket-level timeout. |
| `lost` | The Assignment disappeared; retry or fail next. |

`lost` is transient:

- retry allowed: back to `queued`
- retry not allowed: `failed`

## 4. Assignment states

```text
pending | running | ended
```

`ended` carries:

```text
completed | failed | waiting | blocked | cancelled | lost
```

| End reason | Ticket result |
| --- | --- |
| `completed` | `succeeded` |
| `failed` | `failed` (or retry) |
| `waiting` | `waiting` |
| `blocked` | `blocked` |
| `cancelled` | `cancelled` |
| `lost` | `lost` (retry) or `failed` |

## 5. Report states

```text
progress | waiting | blocked | completed | dropped | failed | cancelled
```

| State | Meaning |
| --- | --- |
| `progress` | Non-terminal update. Assignment stays running. |
| `waiting` | Needs an answer. Assignment ends with `waiting`. |
| `blocked` | Needs an external action. Assignment ends with `blocked`. |
| `completed` | Ticket succeeded. Assignment ends with `completed`. |
| `dropped` | Nothing to do. Ticket ends `succeeded` with `outcome = "dropped"` and `no_op = true`. |
| `failed` | Ticket failed. Assignment ends with `failed`. |
| `cancelled` | Worker stopped after a cancel request. Assignment ends with `cancelled`; Orchestrator cancellation remains authoritative. |

`waiting` and `blocked` both carry a structured description and a Prime Agent `session_ref` so the session can be resumed.

## 6. Transitions

```text
Task created
  -> Task queued
  -> Tickets queued

Scheduler assigns Ticket
  -> Assignment pending
  -> Assignment running
  -> Ticket assigned
  -> Ticket running

Worker progress
  -> Assignment running
  -> Ticket running

Worker waiting
  -> Assignment ended (waiting)
  -> Ticket waiting
  -> slot released

Worker blocked
  -> Assignment ended (blocked)
  -> Ticket blocked
  -> slot released

User answers / unblocks
  -> Ticket queued
  -> new Assignment pending
  -> Worker resumes session
  -> Assignment running
  -> Ticket running

Worker completed
  -> Assignment ended (completed)
  -> Ticket succeeded

Worker failed
  -> Assignment ended (failed)
  -> Ticket failed
  -> Router may retry

Cancel
  -> Assignment ended (cancelled)
  -> Ticket cancelled

Lease timeout
  -> Assignment ended (lost)
  -> Ticket lost
  -> retry or failed
```

## 7. Slot rules

- A Ticket holds a slot from Assignment start until it becomes terminal or hands off.
- `waiting` and `blocked` release the slot.
- One priority slot is reserved for `ticket_answer` and `ticket_resume`.
- New Tasks and Tickets use normal slots only.
- A Worker's `max_concurrency` is enforced by both the Worker and the Orchestrator.
- `max_concurrent_tickets_per_task` (default 2) limits normal Tickets of one Task; the priority slot is exempt.

## 8. Invariants

- A Ticket has at most one active Assignment.
- An Assignment belongs to exactly one Ticket.
- A Ticket in `waiting` or `blocked` has no active Assignment and holds no slot.
- A resumed Assignment targets the same Prime Agent session when possible.
- A Task never has a manual `partial`; it is derived from Ticket outcomes.
- Dropped Tickets count as no-op success in Task derivation.
- The Orchestrator validates every transition; Worker reports cannot write state directly.
