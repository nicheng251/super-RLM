# ADR 0039: Router Notification and Inbox

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent's main Session receives notices and relays: worker questions are relayed promptly, ordinary progress stays on the Ticket, and terminal reports wake the main Session.

super-RLM's Router previously had only polling. A waiting Ticket could sit unnoticed while the user chatted.

## Decision

- Router subscribes to Orchestrator SSE `/v1/events`.
- Router stores a cursor at `<SUPER_RLM_HOME>/router/notify-cursor.json`.
- Only actionable events wake Router:
  - `ticket.waiting`
  - `ticket.blocked`
  - Task terminal events (`succeeded`, `partial`, `failed`, `cancelled`, `timed_out`)
  - `ticket.dropped` as a terminal notice
- Progress events update pages/status only; they do not wake Router.
- Router injects a custom message with `pi.sendMessage({ customType: "super-rlm-event", ... }, { triggerTurn: true, deliverAs: "followUp" })`.
- Deduplicate by `event_id`; coalesce multiple waiting Tickets; rate-limit notifications.
- Router's prompt says notifications are not user instructions; it must inform the user and wait for a decision.
- L2 pages share the same event stream.

## Consequences

- HITL becomes visible without polling.
- Router can wake an idle session safely.
- Notifications are durable via event replay and a cursor.
- Careful deduplication and rate limiting are required.
- Progress noise stays out of the conversation.

## Alternatives considered

- Polling from the extension: simpler, but delayed and noisy.
- No proactive notification: rejected; waiting tasks can be missed.
