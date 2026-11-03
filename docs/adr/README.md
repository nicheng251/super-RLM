# Architecture Decision Records

| ADR | Status | Title |
| --- | --- | --- |
| [0001](0001-router-on-pi-agent.md) | accepted | Router runs on Pi Agent CLI |
| [0002](0002-independent-ticket-model.md) | accepted | Independent Tickets, no Ticket DAG |
| [0003](0003-worker-topology.md) | accepted | Worker topology: one ACP session per Ticket |
| [0004](0004-orchestrator-service.md) | accepted | Orchestrator is a separate service |
| [0005](0005-human-in-the-loop.md) | accepted | Human-in-the-loop releases the slot and resumes the session |
| [0006](0006-result-aggregation.md) | accepted | Task result aggregation by the Router |
| [0007](0007-first-class-cli-pages.md) | accepted | First-class CLI pages are a long-term requirement |
| [0008](0008-ui-phasing.md) | accepted | UI phasing: L2 now, L3 later |
| [0009](0009-sqlite-v0.md) | accepted | SQLite v0 with replaceable repositories |
| [0010](0010-transport.md) | accepted | HTTP/JSON + SSE transport |
| [0011](0011-minimal-auth.md) | accepted | Minimal service authentication |
| [0012](0012-cli-only-ingress.md) | accepted | CLI-only ingress in v0 |
| [0013](0013-state-machine.md) | accepted | State machine and report protocol |
| [0014](0014-router-api.md) | accepted | Router tool surface and internal API contract |
| [0015](0015-project-runtime-root.md) | superseded | Project-owned runtime and configuration root (superseded by 0037) |
| [0016](0016-named-profiles.md) | accepted | Named Worker profiles |
| [0017](0017-worker-dispatch.md) | accepted | Worker registration, heartbeat, and push dispatch |
| [0018](0018-concurrency-slots.md) | accepted | Concurrency and priority slot |
| [0019](0019-worker-contract.md) | accepted | Worker execution and report contract |
| [0020](0020-deployment-modes.md) | accepted | Deployment modes |
| [0021](0021-hitl-policy.md) | accepted | HITL timeout and duplicate answer policy |
| [0022](0022-session-resume.md) | superseded | Prime Agent session resume (superseded by 0028) |
| [0023](0023-isolation.md) | accepted | Trusted-local isolation now, hardened container later |
| [0024](0024-bundled-runtime.md) | accepted | Bundled pinned runtime |
| [0025](0025-observability.md) | accepted | Minimal observability |
| [0026](0026-testing.md) | accepted | Testing strategy |
| [0027](0027-l2-pages.md) | accepted | L2 page scope and shared page model |
| [0028](0028-session-reuse-semantics.md) | accepted | Session reuse follows dsh semantics |
| [0029](0029-runtime-isolation.md) | accepted | Strict runtime isolation from user Pi/Prime configs |
| [0030](0030-report-skill.md) | accepted | Worker report uses a Python skill, not MCP |
| [0031](0031-router-profile.md) | accepted | Router conversation persistence and project-local Pi profile |
| [0032](0032-worker-acp-lifecycle.md) | accepted | Worker ACP lifecycle |
| [0033](0033-model-registry.md) | accepted | Model Registry and `models sync` |
| [0034](0034-explicit-model-selection.md) | accepted | Model selection is explicit in v0 |
| [0035](0035-retry-policy.md) | accepted | Retry, backoff, and error taxonomy |
| [0036](0036-backup-restore.md) | accepted | Offline backup/restore and forward-only migrations |
| [0037](0037-dedicated-runtime-root.md) | accepted | Dedicated project runtime root |
| [0038](0038-local-first.md) | accepted | Local-first development |
| [0039](0039-router-notifications.md) | accepted | Router notification and inbox |
| [0040](0040-report-enforcement.md) | accepted | Report enforcement |
| [0041](0041-session-ref-discovery.md) | accepted | Session ref discovery |
| [0042](0042-project-marker-policy.md) | accepted | Project marker is local by default |
| [0043](0043-no-followup-v0.md) | accepted | No general follow-up API in v0 |
| [0044](0044-dropped-outcome.md) | accepted | Dropped / no-op outcome |
| [0045](0045-per-task-quota.md) | accepted | Per-Task concurrency quota |
| [0046](0046-duplicate-overlap.md) | accepted | Duplicate and overlap prevention |

Status values: `proposed`, `accepted`, `superseded`.
