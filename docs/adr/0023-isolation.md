# ADR 0023: Trusted-Local Isolation Now, Hardened Container Later

Status: accepted  
Date: 2026-11-02

## Context

dsh-superagent runs Workers as the operator OS user and explicitly states that ticket directories and command shims are not a security boundary.

super-RLM can choose:

- A: trusted-local, same OS user;
- B: hardened shared Worker container;
- C: per-Ticket container.

A is the fastest path and matches dsh. B reduces host blast radius. C is strongest but heavy.

## Decision

v0 uses A: trusted-local Worker isolation.

- Worker runs as the operator OS user.
- Each Ticket has its own workspace.
- Documentation must state that this is not a security boundary.
- The Worker contract does not depend on the isolation mode.

B is the planned future security baseline:

- hardened shared Worker container;
- non-root, read-only root, tmpfs, capability drop, resource limits;
- no host home, no Docker socket;
- one ACP process per Ticket.

C remains a later option for untrusted or multi-tenant execution.

## Consequences

- PoC and local development stay fast.
- A compromised Worker has the operator's permissions.
- The project must warn users and avoid exposing A to untrusted input.
- Moving to B later changes deployment, not the domain or Worker API.
- B still does not isolate Tickets from each other; C is required for that.

## Alternatives considered

- B immediately: safer, but adds image, volume, and permission work before the core loop is proven.
- C immediately: strongest isolation, but too heavy for v0.
