# Design Audit vs dsh-superagent

Status: audit complete; follow-up decisions accepted (ADR 0039–0046)  
Date: 2026-11-02

## 1. Scope

This audit compares the current super-RLM architecture and ADRs with dsh-superagent's domain model, executor model, prompts, and storage design. It focuses on gaps, over-engineering, and decisions that may be wrong or premature.

## 2. Summary

The overall shape is sound:

- Router on Pi Agent;
- deterministic Orchestrator;
- one Prime Agent ACP session per Ticket;
- structured report handoff;
- independent Tickets;
- project-owned runtime.

The main risks are not in the domain model. They are in the **human handoff path**, **report enforcement**, **session identity**, and **early operational complexity**.

## 3. Critical findings

### C1. Router has no notification/inbox path

dsh's main Session receives notices and relays:

- a worker question is relayed promptly;
- ordinary progress stays on the Ticket;
- a report or follow-up can wake the main Session.

super-RLM currently has no equivalent. Router can call `task_status`/`task_wait`, and L2 pages poll, but a waiting Ticket does not proactively tell the Router or the user.

Consequence: a task can wait for input indefinitely while the user is chatting, unless they open Tasks or ask.

Recommendation:

- Router extension subscribes to Orchestrator SSE.
- On `ticket.waiting`/`ticket.blocked`, call Pi `pi.sendMessage` or `sendUserMessage` with `deliverAs: "followUp"` and `triggerTurn: true` (or a non-triggering notification plus a status badge).
- Deduplicate by event id; rate-limit; do not wake for every progress event.
- L2 pages can still poll.

This is the closest analog to dsh `reportRelay` / `eventNotice`.

### C2. No follow-up message API for a running or completed Ticket

dsh uses Threads and Subscriptions: a later human message reaches the Ticket, and the worker decides whether it belongs.

super-RLM only has:

- `ticket_answer` for `waiting`;
- `ticket_resume` for `blocked`;
- `ticket_retry` for `failed`/`lost`.

There is no `ticket_message` / `task_followup` to add context or ask a follow-up while a Ticket is running or after it completed.

Consequence: the user cannot say "also check X" without creating a new Task/Ticket.

Recommendation:

- Decide whether v0 needs follow-ups.
- If yes, add `ticket_message(ticket_id, message)` that:
  - appends a user message to the Ticket;
  - starts a new Assignment if idle/ended, or steers the running Assignment if supported;
  - keeps authority and state rules explicit.
- If no, document the limitation and make Router create a new Ticket for follow-ups.

### C3. Report skill can be skipped; fail-closed may be too strict

dsh's worker is strongly prompted to call `orchestrator_report`, and the Executor can also report `waiting` after an idle turn.

Our `super-rlm-report` skill is mandatory in the prompt, but a model can finish without calling it. We currently fail closed with `missing_report`.

Consequence: false failures and unnecessary retries when the work actually completed.

Recommendation:

- After the ACP turn ends without a terminal report, send one short follow-up prompt: "Before ending, call `super_rlm_report` with the terminal state."
- If still missing, fail closed with `missing_report`.
- Record the last assistant text as context, not as success.
- Spike should measure how often this happens.

### C4. Project marker commit policy is undefined

`.super-rlm-project.json` carries `project_id`. If committed, every clone shares the same ID and therefore the same runtime root on one machine; concurrent clones can collide. If gitignored, each clone gets a new ID and must be initialized.

Recommendation:

- Default: gitignore `.super-rlm-project.json`; treat it as local state.
- `super-rlm init` creates it.
- For shared/CI installations, allow an explicit project ID.
- Document the behavior clearly.

### C5. `session_ref` discovery and resume are underspecified

Prime Agent ACP `session/new` returns an ACP session ID, not necessarily the daemon session file. The Worker must discover a stable `session_ref` to resume later.

dsh avoids this by using a stable `worker-<ticketId>` session ID.

Consequence: resume may fail more often, causing recovery prompts and lost context.

Recommendation:

- Spike must verify the reliable way to identify the daemon session:
  - daemon session list/API;
  - session file under the project session dir;
  - or a stable Worker-side mapping.
- Store both a logical `session_key` (ticket id) and the concrete `session_ref`.
- Treat failure to resolve as a normal fallback, not an exception.

## 4. Should fix or improve

### S1. Add `dropped` / `no_op` reporting

dsh has `dropped`: nothing to do, close without treating it as a failure.

super-RLM currently has `completed` and `failed`; "nothing to do" becomes `failed` or `completed` with an empty result.

Recommendation: add `dropped` (or `no_op`) to the report and Ticket outcome, mapping to a terminal task result without failure.

### S2. Align `waiting` / `blocked` semantics with dsh

dsh's `waiting` means the worker is idle waiting for a trigger; `blocked` + human_action is the question path.

Our `waiting` means "needs a user answer"; `blocked` means "external action".

This is reasonable for a CLI, but it diverges from dsh naming. Document the mapping and use consistent UI text.

### S3. Add per-Task quotas or a stronger split limit

A Task can create up to 16 Tickets. Without per-Task concurrency or quota, one Task can occupy all slots.

Recommendation: add `max_concurrent_tickets_per_task` or a per-Task slot cap before exposing multi-Ticket splitting.

### S4. Add duplicate/overlap detection for Router splits

dsh's Eval avoids duplicate Tickets from the same Thread.

Our Router can split overlapping work into multiple Tickets. There is no duplicate check.

Recommendation:

- Router prompt: do not create overlapping Tickets; prefer one Ticket when unsure.
- Orchestrator: optional title/prompt similarity warning, not automatic rejection.
- Future: a plan review step.

### S5. Event retention and notification deduplication

SSE events and SQLite event logs need retention and dedupe rules.

Recommendation:

- Keep event IDs monotonic.
- Retain a bounded window; archive older events.
- Deduplicate notifications by `event_id` in the Router extension.

### S6. Task aggregate is not in dsh

dsh has Tickets, not Tasks. Our Task aggregate adds:

- result aggregation;
- partial state;
- per-Task limits;
- a grouping for Router output.

This is justified by the Router-first product, but keep Task thin. Avoid turning it into a workflow engine.

## 5. Over-engineering / simplification candidates

### O1. Too many network boundaries before the core loop works

Current v0 has:

- Router (Pi CLI) -> Orchestrator (HTTP) -> Worker (HTTP) -> Prime Agent (ACP), plus auth, HMAC, scopes, SSE, repository abstraction, and Model Registry.

dsh runs Engine and Executor in one process.

For local-first v0, consider:

- running Orchestrator and Worker in one process, or
- using a local Unix/loopback transport without HMAC/scopes until the loop works.

Keep the contracts, but reduce operational surface for the first slice.

### O2. Model Registry may be heavier than v0 needs

Explicit profile -> fixed model is good. But a full registry with sync, custom-provider secret fallback, and doctor checks can wait.

Minimum v0:

- one `profiles.yaml`;
- one model per profile;
- env API keys;
- no custom-provider fallback.

Add the registry when multi-model selection is real.

### O3. L2 page model is reasonable, not over-engineered

The shared `PageModel` avoids rewriting L3. Keep it.

## 6. Justified divergences from dsh

- No Sources, Triggers, Eval, Policy, IM/GitHub adapters: the product is API/CLI-driven.
- Task aggregate: needed for Router task splitting and result aggregation.
- Named profiles and Model Registry: dsh has one global worker model; super-RLM supports multiple capabilities.
- Separate Orchestrator: Pi CLI is not a long-lived Harness process.
- Bundled runtime and strict isolation: dsh relies on Harness installation; super-RLM is standalone.
- Structured report skill instead of `orchestrator_report`: Prime Agent's native extension surface is Python code, not a tool API.

## 7. Recommended order

1. Fix C1 (Router notification) and C3 (report enforcement) before the first end-to-end test.
2. Resolve C5 (session_ref discovery) in the Prime ACP spike.
3. Decide C4 (project marker policy) and C2 (follow-ups) before the L2 UI.
4. Add S1 (`dropped`) and S3 (per-Task quota) before multi-Ticket use.
5. Consider O1/O2 simplification for the first local slice.
