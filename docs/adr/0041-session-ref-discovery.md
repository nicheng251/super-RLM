# ADR 0041: Session Ref Discovery

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent uses a stable `worker-<ticketId>` session ID. Prime Agent ACP `session/new` returns an ACP session ID, not necessarily the daemon session file needed for `--resume`.

## Decision

- Store a logical `session_key = ticket_id` on the Ticket.
- `session_ref` is an opaque Worker-discovered reference to the concrete Prime Agent session.
- Discovery order, confirmed by the Prime ACP spike:
  1. Give each Ticket a dedicated session directory: `<project>/prime/sessions/<ticket_id>/`.
  2. After `session/new`, pick the only or newest `*.jsonl` file in that directory.
  3. Store the durable session-file path as `session_ref`.
  4. If the directory is ambiguous, cross-check `prime-agent sessions --json --all` by `cwd` and creation time.
- `session_ref` is the durable session file, not the ACP `sessionId`.
- Never trust an Orchestrator-supplied path.
- `--resume` requires the same daemon socket that holds the session lease; a lease failure falls back to a new session + recovery prompt.

## Consequences

- Resume has a concrete reference when discovery works.
- Ambiguous discovery falls back safely instead of guessing.
- `session_key` preserves the logical identity even when `session_ref` is missing.
- The spike determines whether a supported daemon API can replace directory scanning.

## Alternatives considered

- Assume the ACP session ID is the resume key: unverified.
- Scan by newest file alone: racy.
- Drop resume entirely: loses context.
