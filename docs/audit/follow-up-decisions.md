# Audit Follow-Up Decisions

Status: accepted  
Date: 2026-11-02

| Finding | ADR | Decision |
| --- | --- | --- |
| C1 Router notification | [0039](../adr/0039-router-notifications.md) | SSE + Pi `sendMessage`, cursor/dedupe, actionable events only |
| C3 Report enforcement | [0040](../adr/0040-report-enforcement.md) | One enforcement prompt, then `missing_report` |
| C5 session_ref discovery | [0041](../adr/0041-session-ref-discovery.md) | `session_key=ticket_id`; discover opaque `session_ref`; safe fallback |
| C4 project marker | [0042](../adr/0042-project-marker-policy.md) | Local, gitignored marker; explicit ID for shared installs |
| C2 follow-ups | [0043](../adr/0043-no-followup-v0.md) | No general follow-up API in v0 |
| S1 dropped/no-op | [0044](../adr/0044-dropped-outcome.md) | `dropped` report; Ticket `succeeded` + `outcome=dropped` |
| S3 per-Task quota | [0045](../adr/0045-per-task-quota.md) | `max_concurrent_tickets_per_task` default 2 |
| S4 duplicate/overlap | [0046](../adr/0046-duplicate-overlap.md) | Reject exact duplicates; near-duplicates warn |
