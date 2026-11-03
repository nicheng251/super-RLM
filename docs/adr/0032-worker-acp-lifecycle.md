# ADR 0032: Worker ACP Lifecycle

Status: accepted  
Date: 2026-11-02

## Context

Prime Agent ACP is a per-connection session client. Resident sessions survive client EOF and can be resumed with `--resume`.

dsh-superagent keeps a persistent worker session per Ticket and hands off by reporting a terminal state; the session survives across Assignments.

## Decision

- Each Assignment starts one ACP process.
- Launch flags include workspace, project session dir, profile model/thinking, explicit report skill, and worker system prompt.
- Resume adds `--resume <session_ref>`.
- Sequence: `initialize` -> `session/new` (empty MCP list) -> `session/prompt`.
- ACP `session/prompt` returns after terminal quiescence, including spawned RLM children.
- `rlm.collect()` snapshots can return `running`; do not use it as the only completion signal.
- `--print` mode is unsuitable for the report-skill lifecycle; use ACP and close the process after a terminal report.
- Tool events and child-session metadata are logs, not Orchestrator state.
- Reports come from the `super-rlm-report` skill.
- A turn without a terminal report fails as `missing_report`.
- `waiting`/`blocked` closes ACP, keeps the resident session, and releases the slot.
- Cancellation and timeout are Orchestrator-authoritative; the Worker sends `session/cancel`.
- Tool events are logged, not reported individually.
- No ACP process is shared across Tickets.

## Consequences

- Process lifecycle is simple and isolated per Assignment.
- Resident sessions provide continuity across handoffs.
- The Worker must discover/store `session_ref`.
- Missing reports are failures, not silent successes.
- High-frequency events stay in logs, not Orchestrator state.

## Alternatives considered

- Long-lived ACP process across waiting: holds resources and complicates cancellation.
- Parse final assistant text: fragile and cannot report mid-turn.
- Share one ACP session across Tickets: leaks context and state.
