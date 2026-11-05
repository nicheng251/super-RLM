# super-rlm CLI

Local launcher for the super-RLM vertical slice. Node.js `>= 22.19` is a host
prerequisite; it is not bundled in `runtime/`.

## Commands

```bash
super-rlm                 # start the L3 terminal UI and its whole local stack
super-rlm tui             # alias for super-rlm
super-rlm down            # stop Orchestrator, Worker, and the project Prime daemon
super-rlm status          # show Orchestrator, Worker, and Prime daemon status
super-rlm tasks           # headless task list
super-rlm doctor          # check project runtimes and services
super-rlm init            # create .super-rlm-project.json + gitignore entry
super-rlm bootstrap       # create the project kernel venv and install runtime/report skill
super-rlm models sync     # write project Pi/Prime models.json from config/models.yaml
super-rlm profiles list|show <name>|validate  # inspect config/profiles.yaml
super-rlm artifacts <ticket_id> [--to <dir>] [--all]  # copy Ticket artifacts
super-rlm backup <dir>    # offline backup of SUPER_RLM_HOME
super-rlm restore <dir>   # restore an offline backup
super-rlm config          # print resolved paths (token/key fields redacted)
```

`super-rlm` is the normal entry point. It refuses to start when an Orchestrator,
Worker, or project Prime Agent daemon is already running; run
`super-rlm down` first. It never attaches to an existing stack.

The TUI owns the stack for its whole lifetime. There is no background start:
closing or crashing the TUI stops the services. `up`, `router`, `dev`, and
`--no-services` were removed. `status` and `down` remain for diagnostics and
cleanup.

## Examples

```bash
# from the target project
super-rlm init
super-rlm doctor
super-rlm
```

Set a non-default runtime root explicitly:

```bash
SUPER_RLM_HOME="$HOME/.super-rlm/projects/prj_demo" super-rlm
```

## Terminal UI

`super-rlm` starts the Orchestrator and Worker, then launches the standalone L3
terminal UI from `apps/tui`. The UI reads the same `SUPER_RLM_*` configuration
as the CLI and chats with the Router through the project Pi runtime.

On Windows, a Python Job supervisor creates a Job Object with
`KILL_ON_JOB_CLOSE` and starts the Orchestrator, Worker, and TUI inside it. The
Worker starts the Prime Agent daemon, so the daemon inherits the Job. When the
TUI exits normally, the supervisor cancels active Tasks, asks the Worker to
stop its sessions, runs `prime-agent shutdown --force`, stops the Worker and
Orchestrator, and closes the Job. If the TUI crashes, closing the Job kills every
remaining member. If the Job APIs are unavailable, startup fails closed.

The supervisor Python defaults to the Worker venv. Override it with
`SUPER_RLM_SUPERVISOR_PYTHON`.

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
super-rlm profiles reset git          # drop the saved git override
super-rlm profiles reset --all        # drop every saved override
```

`list` and `validate` read the file directly; they do not require the
Orchestrator. Set `SUPER_RLM_PROFILES_CONFIG` or pass `--config <path>` to use a
different file. The default file is `config/profiles.yaml` at the repository
root and must contain a `default` profile.

The Model & Profiles page saves Worker model choices to
`<home>/profiles.overrides.json`. The Orchestrator validates that file at
startup and applies the overrides on top of `config/profiles.yaml`. An invalid
or stale override (malformed JSON, unknown profile, empty provider/model,
invalid thinking level, or unknown field) stops startup with an explicit error
instead of being ignored. Fix the file or run `profiles reset --all`, then
restart the Orchestrator. `profiles reset` edits only the overrides file; use
`--overrides <path>` or `SUPER_RLM_PROFILE_OVERRIDES` when it is not under the
project home.

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
runtime. It refuses a schema newer than the running build (v5), stages the
backup in a temporary directory, renames the current home to
`<home>.pre-restore-<timestamp>`, then moves the staged copy into place. If the
backup excluded secrets, the current `<home>/secrets` is copied into the
restored home.

## Diagnostics and cleanup

`status` checks `/health` and `/v1/health`, reports the PIDs from the last run,
and reads `prime-agent status --json` with the project daemon environment.
It also shows the TUI supervisor PID while a TUI-owned stack is running.

`down` first terminates a running TUI supervisor. Closing its Job removes the
TUI and all of its children, including the Prime Agent daemon. It then stops any
leftover Worker and Orchestrator, removes their PID files, rotates their closed
logs, and runs `prime-agent shutdown --force` for the project daemon.

Starting the TUI also performs startup maintenance after confirming that the
stack is down: it rotates `orchestrator/orchestrator.log` and
`worker/worker.log` when they exceed `SUPER_RLM_LOG_MAX_BYTES` (default
10 MiB), keeping `SUPER_RLM_LOG_KEEP` rotations (default 3). It then runs
`gc --apply` for resources older than `SUPER_RLM_GC_OLDER_THAN_DAYS` (default
7). Set `SUPER_RLM_AUTO_MAINTENANCE=0` to skip the startup GC; log rotation
still runs. Maintenance is best effort and never runs while the stack is up.

The supervisor starts:

```text
Orchestrator: node apps/orchestrator/src/main.ts
Worker:       apps/worker/.venv/Scripts/python.exe -m super_rlm_worker.main
TUI:          node apps/tui/src/main.ts
```

All three inherit the resolved `SUPER_RLM_*` configuration. Neither start nor
`down` creates the project kernel venv; `super-rlm doctor` reports when it is
missing.

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
| `SUPER_RLM_ROUTER_TOKEN` | generated in `<home>/secrets/api.env` | Router bearer token; an explicit env value overrides the file. |
| `SUPER_RLM_WORKER_TOKEN` | generated in `<home>/secrets/api.env` | Worker bearer token; an explicit env value overrides the file. |
| `SUPER_RLM_CALLBACK_KEY` | generated in `<home>/secrets/api.env` | HMAC key shared by Worker reports and the Orchestrator outbox. |
| `SUPER_RLM_PRIME_PROVIDER` | `fake` | Prime model provider. |
| `SUPER_RLM_PRIME_MODEL` | `fake-1` | Prime model id. |
| `SUPER_RLM_KERNEL_VENV` | `<home>/prime/kernel-venv` | Prime kernel venv. |
| `SUPER_RLM_KERNEL_PYTHON` | venv python | Prime kernel Python. |
| `SUPER_RLM_PRIME_DAEMON` | `<home>/prime/daemon/worker.sock` | Project Prime daemon socket. |
| `SUPER_RLM_SUPERVISOR_PYTHON` | Worker venv python | Python used for the Windows Job supervisor. |
| `NODE_BIN` | `node` | Node executable for `bin/super-rlm`. |

## Tests

```bash
npm test
npm run check
```
