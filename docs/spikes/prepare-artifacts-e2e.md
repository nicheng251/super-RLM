# Prepare + artifacts E2E

Status: passed  
Date: 2026-11-05

## What was tested

A real DeepSeek Worker prepared an existing git repository as a per-Ticket
worktree, changed it, committed the change, reported the artifact, and the CLI
copied the artifact out.

- Provider: `deepseek/deepseek-flash`
- Orchestrator: `127.0.0.1:18831`
- Worker: `127.0.0.1:18095`
- Project checkout: a temporary git repository
- Prepare command:

```bash
git -C "$SUPER_RLM_PROJECT_REPO" worktree add ./repo -b "agent/$SUPER_RLM_TICKET_ID" main
```

## Result

```text
Task:   tsk_19178d670a9f41759178
Ticket: tkt_a0512119a8634aeea5f7
Task:   succeeded
Ticket: succeeded
```

Ticket result:

```json
{
  "workspace": "...\\home\\workspaces\\tkt_a0512119a8634aeea5f7",
  "branch": "agent/tkt_a0512119a8634aeea5f7",
  "commit": "f573c3eafce65abb3a97fa3a64ed0de63bd703b7"
}
```

Workspace:

```text
workspace/repo/hello.txt
hello from prepared worktree
```

The file was committed in the prepared worktree.

## Artifact copy

```bash
node apps/cli/src/main.ts artifacts tkt_a0512119a8634aeea5f7 --to ...\\copied
```

Output:

```text
copied ...\\copied\\repo\\hello.txt
Ticket tkt_a0512119a8634aeea5f7: 1 file(s)
workspace: ...
branch:    agent/tkt_a0512119a8634aeea5f7
commit:    f573c3eafce65abb3a97fa3a64ed0de63bd703b7
```

`copied/repo/hello.txt` existed with the expected content.

## Notes

- The marker `<workspace>/.super-rlm-prepared` was written after prepare.
- The worktree lives at `<workspace>/repo`; branch and commit are read from that
  nested checkout.
- Artifact paths are workspace-relative. A model may report either
  `repo/hello.txt` or `hello.txt`; the CLI falls back to the prepared `repo`
  checkout for bare artifact paths.
- This is a manual, paid check; it is not part of the unit suites.
