# Profiles, generic workspace, and per-profile delivery E2E

Status: passed  
Date: 2026-11-05

## What was tested

Two real DeepSeek Tickets selected different profiles from
`config/profiles.yaml`:

- `default`: general worker, delivery `artifacts`.
- `git`: git worktree preparation, `agent_cwd: repo`, blocked `git`/`gh`,
  `metadata_command` for git branch/commit, delivery `none`.

- Orchestrator: `127.0.0.1:18833`
- Worker: `127.0.0.1:18097`
- Provider/model: `deepseek/deepseek-flash`
- Task metadata: `origin_cwd` set to a temporary output directory.

## `default` profile

```text
Task:   tsk_0aa13d533a7f4107a550
Ticket: tkt_5a1615aad01f4889866c
status: succeeded
```

Result:

```json
{
  "delivered_to": ["...\\origin\\hello.txt"],
  "delivery_error": null
}
```

`origin/hello.txt` contained:

```text
hello from default profile
```

## `git` profile

```text
Task:   tsk_6ed5d219de3d4eecaf3e
Ticket: tkt_fdb69581714a45f4a538
status: succeeded
```

Result:

```json
{
  "workspace_metadata": {
    "vcs": "git",
    "branch": "super-rlm/tkt_fdb69581714a45f4a538",
    "commit": "4cb1214527c5cf6dd7baa16e43319defe8e297d4"
  },
  "branch": "super-rlm/tkt_fdb69581714a45f4a538",
  "commit": "4cb1214527c5cf6dd7baa16e43319defe8e297d4",
  "delivered_to": [],
  "delivery_error": null
}
```

The file existed only in the prepared worktree:

```text
<workspace>/repo/hello-git.txt
hello from git profile
```

It was not copied to `origin`, because the git profile uses delivery `none`.

## Notes

- `GET /v1/profiles` returned the sanitized `default` and `git` profiles.
- The git profile's `prepare_command` created `<workspace>/repo`.
- `agent_cwd: repo` made Prime Agent start inside the worktree.
- `blocked_commands: [git, gh]` created PATH shims for the Agent; the
  `metadata_command` still read git metadata because metadata commands are not
  blocked.
- This is a manual, paid check; it is not part of the unit suites.
