# Result delivery E2E

Status: passed  
Date: 2026-11-05

## What was tested

A real DeepSeek Worker prepared a git worktree, created a file, reported it as
an artifact, and the Worker copied it back to the Task's `origin_cwd`.

- Provider: `deepseek/deepseek-flash`
- Orchestrator: `127.0.0.1:18832`
- Worker: `127.0.0.1:18096`
- Delivery mode: `artifacts`
- Collision policy: `version`
- Strip prefix: `repo`
- Prepare command:

```bash
git -C "$SUPER_RLM_PROJECT_REPO" worktree add ./repo -b "agent/$SUPER_RLM_TICKET_ID" main
```

The Task was created with:

```json
{"metadata": {"origin_cwd": "...\\origin"}}
```

## Result

```text
Task:   tsk_eaebc44e1d1243bbb4e4
Ticket: tkt_114fdb08461249db9599
Task:   succeeded
Ticket: succeeded
```

Ticket result:

```json
{
  "workspace": "...\\workspaces\\tkt_114fdb08461249db9599",
  "branch": "agent/tkt_114fdb08461249db9599",
  "commit": "c2e038b6978f5d8694d3322d6564f57dd88fb141",
  "delivered_to": ["...\\origin\\hello.txt"],
  "delivery_error": null
}
```

Delivered file:

```text
origin/hello.txt
hello from delivery
```

The `repo/` artifact prefix was stripped, so the file landed directly in
`origin/hello.txt`.

## Notes

- Delivery runs only after a `completed` report.
- Delivery failure does not change the Ticket state; `delivery_error` is
  recorded and the workspace remains available.
- The default collision policy is `version`; existing files are not silently
  overwritten.
- This is a manual, paid check; it is not part of the unit suites.
