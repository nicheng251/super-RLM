# ADR 0040: Report Enforcement

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent prompts workers to call `orchestrator_report` and the Executor can report an idle/waiting state. A model can still finish without a report.

super-RLM uses the `super-rlm-report` Python skill. A missing terminal report cannot be treated as success.

## Decision

- When an ACP turn ends without a terminal report, the Worker sends one short follow-up prompt: call `super_rlm_report` with the terminal state.
- If the second turn still has no terminal report, the Worker reports `failed` with `missing_report`.
- The last assistant text is stored as `unreported_context`, not as a successful result.
- A `progress`-only turn follows the same enforcement.
- Report attempts are recorded for diagnosis.

## Consequences

- False failures are reduced.
- Every enforcement adds one extra turn in the failure path.
- Missing reports remain fail-closed.
- The spike should measure the frequency.

## Alternatives considered

- Immediate failure: too strict.
- Parse the final text as success: unsafe.
- Never fail: hides model/tool failures.
