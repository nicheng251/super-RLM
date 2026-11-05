# super-rlm CLI

Local launcher for the super-RLM vertical slice. Node.js `>= 22.19` is a host
prerequisite; it is not bundled in `runtime/`.

## Commands

```bash
super-rlm                 # one-command start: ensure services, then launch Router
super-rlm --no-services   # launch Router only
super-rlm up              # start Orchestrator + Worker in the background
super-rlm down            # stop background Orchestrator + Worker
super-rlm status          # show background service health and PIDs
super-rlm dev             # start Orchestrator + Worker in the foreground
super-rlm tasks           # headless task list
super-rlm doctor          # check project runtimes and services
super-rlm init            # create .super-rlm-project.json + gitignore entry
super-rlm bootstrap       # create the project kernel venv and install runtime/report skill
super-rlm models sync     # write project Pi/Prime models.json from config/models.yaml
super-rlm profiles list|show <name>|validate  # inspect config/profiles.yaml
super-rlm artifacts <ticket_id> [--to <dir>] [--all]  # copy Ticket artifacts
super-rlm backup <dir>    # offline backup of SUPER_RLM_HOME
super-rlm restore <dir>   # restore an offline backup
super-rlm config          # print resolved paths and tokens
```

The default Router session id is `super-rlm-router-<project_id>`.

`super-rlm` is the normal one-command entry point. It health-checks the
Orchestrator and Worker, starts any missing service as a detached background
process, then launches Pi in the foreground. Services keep running when the
Router exits, so long Tickets are not interrupted. Use `super-rlm down` to stop
them.

## Examples

```bash
# from the target project
super-rlm init
super-rlm doctor

# terminal 1
super-rlm dev

# terminal 2
super-rlm
```

Set a non-default runtime root explicitly:

```bash
SUPER_RLM_HOME="$HOME/.super-rlm/projects/prj_demo" super-rlm dev
SUPER_RLM_HOME="$HOME/.super-rlm/projects/prj_demo" super-rlm
```

## Bootstrap

`super-rlm bootstrap` creates `<home>/prime/kernel-venv` with `uv` and installs:

- `prime-agent-runtime` and its `mcp`/`tyro` dependencies
- the default kernel packages (`requests`, `httpx`, `pyyaml`, `tomli`, `python-dotenv`, `pandas`, `numpy`, `scipy`, `beautifulsoup4`, `lxml`)
- `apps/worker/skills/super-rlm-report` editable

Use `super-rlm bootstrap --dry-run` to print the commands without running them.
## Profiles

`config/profiles.yaml` defines named Worker capability profiles. A Ticket
selects one by name; the Orchestrator validates the name and sends the resolved
execution options (provider/model/thinking, timeout, prepare and blocked
commands, workspace layout, delivery policy) with the Assignment.

```bash
super-rlm profiles list
super-rlm profiles list --json
super-rlm profiles show git
super-rlm profiles validate
```

`list` and `validate` read the file directly; they do not require the
Orchestrator. Set `SUPER_RLM_PROFILES_CONFIG` or pass `--config <path>` to use a
different file. The default file is `config/profiles.yaml` at the repository
root and must contain a `default` profile.

## Models

`config/models.yaml` is the project model registry. `super-rlm models sync`
writes the resolved provider config to:

```text
<home>/pi/agent/models.json
<home>/prime/agent/models.json
```

`apiKey: $NAME` resolves from the process environment or
`<home>/secrets/providers.env`. A missing secret fails the sync. Use
`config/models.example.yaml` as the template for a real endpoint.

## Artifact copy-out

Ticket files stay in the runtime workspace. Read a Ticket's reported artifacts
and copy them with:

```bash
super-rlm artifacts tkt_...
super-rlm artifacts tkt_... --to C:/temp
super-rlm artifacts tkt_... --all --to C:/temp
```

Without `--to`, the destination is the current directory. By default the
command copies each artifact returned by `ticket_result` to
`<destination>/<artifact.path>`. `--all` copies the entire
`<workspaceRoot>/<ticket_id>` directory to `<destination>/<ticket_id>`; it omits
`.super-rlm-report.json`, `.super-rlm-prepared`, and `.git`.

The workspace root is `SUPER_RLM_WORKSPACES` when set, otherwise
`<home>/workspaces`. Artifact paths must stay inside the workspace; parents and
absolute paths are rejected. The command prints the Ticket's reported
`workspace_metadata` when present; git branch and commit are no longer read from
the workspace.

## Backup and restore

Backup and restore are offline. Stop both services first:

```bash
super-rlm down
super-rlm backup D:/backups
super-rlm backup D:/backups --include-secrets
super-rlm restore D:/backups/super-rlm-backup-2026-11-04T09-30-00-000Z
```

`backup` refuses to run while the Orchestrator or Worker health endpoint is
reachable, then copies `SUPER_RLM_HOME` into
`<destination>/super-rlm-backup-<timestamp>/`.

The copy excludes `secrets/` unless `--include-secrets` is passed. It also
excludes transient files: `*.pid`, `*.lock`, `*.writer-lock`, `*.sock`,
`*.log`, `logs/`, `*.recovery.jsonl`, and `*.orphans.jsonl`.

`manifest.json` records `created_at`, `super_rlm_version`, `node_version`,
`prime_agent_version`, `schema_version`, `included_secrets`, and every file's
size and SHA-256.

`restore` validates the manifest and all checksums before changing the current
runtime. It refuses a schema newer than the running build (v4), stages the
backup in a temporary directory, renames the current home to
`<home>.pre-restore-<timestamp>`, then moves the staged copy into place. If the
backup excluded secrets, the current `<home>/secrets` is copied into the
restored home.

## Background services

`up` writes:

```text
<home>/orchestrator/orchestrator.pid
<home>/orchestrator/orchestrator.log
<home>/worker/worker.pid
<home>/worker/worker.log
```

`status` checks `/health` and `/v1/health`; `down` sends SIGTERM and removes the
PID files.

## What `dev` starts

```text
Orchestrator: node apps/orchestrator/src/main.ts
Worker:       apps/worker/.venv/Scripts/python.exe -m super_rlm_worker.main
```

Both inherit the resolved `SUPER_RLM_*` configuration. `super-rlm dev` does not
create the project kernel venv; `super-rlm doctor` reports when it is missing.

## Router isolation

The Router launch uses:

```text
--no-extensions -e apps/router/extensions/super-rlm.ts
--no-skills --no-context-files --no-prompt-templates --no-themes --no-mcp -nbt
--append-system-prompt apps/router/prompts/router.md
PI_CODING_AGENT_DIR=<home>/pi/agent
PI_CODING_AGENT_SESSION_DIR=<home>/pi/sessions
```

No built-in tools are registered. The extension is the only tool source.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `SUPER_RLM_HOME` | `~/.super-rlm/projects/<project_id>` | Project runtime root. |
| `SUPER_RLM_WORKSPACES` | `<home>/workspaces` | Ticket workspace root. |
| `SUPER_RLM_PROJECT_ID` | marker or `default` | Project identity. |
| `SUPER_RLM_PORT` | `8787` | Orchestrator port. |
| `SUPER_RLM_WORKER_PORT` | `8080` | Worker port. |
| `SUPER_RLM_ROUTER_TOKEN` | `dev-router-token` | Router bearer token. |
| `SUPER_RLM_WORKER_TOKEN` | `dev-worker-token` | Worker bearer token. |
| `SUPER_RLM_PRIME_PROVIDER` | `fake` | Prime model provider. |
| `SUPER_RLM_PRIME_MODEL` | `fake-1` | Prime model id. |
| `SUPER_RLM_KERNEL_VENV` | `<home>/prime/kernel-venv` | Prime kernel venv. |
| `SUPER_RLM_KERNEL_PYTHON` | venv python | Prime kernel Python. |
| `NODE_BIN` | `node` | Node executable for `bin/super-rlm`. |

## Tests

```bash
npm test
npm run check
```
