# Callback outbox + migration backup E2E

Status: passed  
Date: 2026-11-05

## What was tested

A v4 Orchestrator database was opened by the current build. The Store created a
pre-migration backup, migrated to v5, and delivered a user callback with HMAC.

- Orchestrator: `127.0.0.1:18835`
- Callback receiver: `127.0.0.1:18836`
- Callback key: local test key
- Callback URL: `http://127.0.0.1:18836/callback`

## Migration backup

Before migration:

```text
pre-migration-v4-2026-11-05T09-14-49-944Z.sqlite
```

The backup existed, the current DB migrated to schema v5, and the outbox table
was created.

## Callback

A Task was created and cancelled. The outbox delivered:

```json
{
  "event_id": 3,
  "type": "ticket.settled",
  "task_id": "tsk_230bd447cdd64712af45",
  "ticket_id": "tkt_ae59f2d562aa450ab09b",
  "assignment_id": null,
  "worker_id": null,
  "data": {"status": "cancelled", "reason": "e2e"},
  "created_at": "2026-11-05T09:14:50.367Z"
}
```

The receiver verified:

```text
HMAC-SHA256(key, x-superrlm-timestamp + x-superrlm-nonce + raw_body)
```

The signature matched.

## Notes

- Callback rows are durable in the `outbox` table.
- Failed deliveries retry with backoff 2s, 5s, 15s, 60s, 300s; the 8th
  failure marks the row `failed`.
- Selected events: `ticket.waiting`, `ticket.blocked`, `ticket.settled`,
  `task.settled`.
- This is a local E2E; callback URL is trusted configuration. Public callback
  ingress still needs SSRF/allowlist controls.
