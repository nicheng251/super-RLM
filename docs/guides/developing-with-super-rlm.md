# Developing an existing project with super-RLM

Status: current workflow  
Last updated: 2026-11-05

The Worker does not run in the directory where you launch the Router. It runs
in a per-Ticket runtime workspace:

```text
<SUPER_RLM_HOME>/workspaces/<ticket_id>/
```

For real project work, select the `git` profile. It prepares a dedicated
worktree and starts Prime Agent inside it.

## 1. Configure the project

Set the project runtime and the main checkout:

```powershell
$env:SUPER_RLM_HOME="C:\Users\15065\.super-rlm\projects\my-app"
$env:SUPER_RLM_PORT="18796"
$env:SUPER_RLM_WORKER_PORT="18087"
$env:SUPER_RLM_PROJECT_REPO="C:/Users/15065/Project/my-app"
```

Profiles live in:

```text
config/profiles.yaml
```

The checked-in profiles are:

- `default`: general worker, no prepare, delivery `artifacts`.
- `git`: creates `<workspace>/repo` as a git worktree, starts Prime Agent in
  `repo`, blocks Agent `git`/`gh`, reads branch/commit via `metadata_command`,
  delivery `none`.

The `git` profile uses:

```yaml
prepare_command: |
  set -e;
  repo="${SUPER_RLM_PROJECT_REPO:?SUPER_RLM_PROJECT_REPO is not set}";
  target="${SUPER_RLM_WORKSPACE:?SUPER_RLM_WORKSPACE is not set}/repo";
  branch="super-rlm/${SUPER_RLM_TICKET_ID}";
  ...
```

One-time setup:

```powershell
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts bootstrap
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts models sync
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts doctor
```

Models are selected from `config/models.yaml`:

```yaml
default:
  provider: deepseek
  model: deepseek-flash
  thinking: medium       # Router reasoning level
```

`SUPER_RLM_PRIME_PROVIDER` and `SUPER_RLM_PRIME_MODEL` still override the file.

### Router model vs Worker model

There are two independent model settings:

```text
config/models.yaml default
  -> Router model (the Pi session that talks to you)

config/profiles.yaml profiles.<name>.provider/model
  -> Worker model for Tickets that select that profile
```

The Router model is resolved by `loadConfig` in this order:

```text
SUPER_RLM_PRIME_PROVIDER / SUPER_RLM_PRIME_MODEL
  > config/models.yaml default
  > fake/fake-1
```

The Worker model is resolved per Assignment:

```text
profile.provider / profile.model / profile.thinking
  > Worker fallback SUPER_RLM_PRIME_PROVIDER / SUPER_RLM_PRIME_MODEL
```

The Router chooses a profile by name, not a raw model. The Orchestrator
validates the profile and sends `ExecutionOptions` to the Worker.

Task Detail shows the selected Worker configuration:

```text
profile: git
model: deepseek/deepseek-flash
thinking: medium
context: 1M
```

The context window is resolved from the matching model entry in
`config/models.yaml`.

The L3 status bar shows the Router model, reasoning level, and context window:

```text
router:DeepSeek V4.1 Flash  thinking:medium  ctx:1M
```

`DeepSeek V4.1 Flash` is the `name` of the model entry in
`config/models.yaml`. If no display name exists, it falls back to
`provider/model`. The context window comes from the same model entry:

```yaml
models:
  - id: deepseek-flash
    name: DeepSeek V4.1 Flash
    contextWindow: 1048576
```

`thinking` comes from `default.thinking`; `SUPER_RLM_PRIME_THINKING`
overrides it. The Router passes it to Pi as `--thinking`.

To add a Worker model:

```yaml
# config/models.yaml
providers:
  deepseek:
    models:
      - id: deepseek-flash
        name: DeepSeek V4.1 Flash

# config/profiles.yaml
profiles:
  default:
    provider: deepseek
    model: deepseek-flash
    thinking: medium
```

Then sync the project-local Pi/Prime model registry and restart services:

```powershell
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts models sync
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts down
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts up
```

`models sync` writes `<SUPER_RLM_HOME>/pi/agent/models.json` and
`<SUPER_RLM_HOME>/prime/agent/models.json`; it does not write user-global
config. Orchestrator and Worker must be restarted to pick up changed profiles
or model registries.

Useful checks:

```powershell
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts models sync --dry-run
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts profiles list
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts profiles show git
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts profiles validate
```

## 2. Start the Router

```powershell
cd C:\Users\15065\Project\my-app
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts
```

The Router will:

1. health-check Orchestrator and Worker;
2. start missing services in the background;
3. launch the Pi TUI.

List or validate profiles without starting the Orchestrator:

```powershell
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts profiles list
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts profiles show git
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts profiles validate
```


## Router profile selection

Profiles carry capability metadata:

```yaml
capabilities: [code, git, refactor]
requires_repo: true
read_only: false
write_files: true
```

The Router prompt tells it to:

1. call `profile_list` before `task_create`;
2. choose one profile per Ticket:
   - `requires_repo: true` for existing repository/worktree work;
   - `read_only: true` for review/analysis;
   - `default` for standalone scripts, answers, and general work;
3. use `default` when uncertain;
4. record a short reason in `task metadata.profile_reasons`.

The Orchestrator rejects a profile with `requires_repo: true` when
`SUPER_RLM_PROJECT_REPO` is missing.

`read_only` is currently policy metadata used for selection, not a hard
filesystem sandbox. Do not treat it as a security boundary.

## 3. Create a Ticket with the git profile

Ask the Router for a `git` profile Ticket, or create it through the API/CLI with:

```text
profile: git
```

The Ticket prompt should tell the Agent where the prepared checkout is:

```text
The project checkout is available at ./repo inside the current workspace.
Work ONLY inside ./repo. Do not modify anything outside it.

Implement <change>.
Run the relevant tests.
Do not run git; the Worker owns the worktree and metadata.
Then call super_rlm_report with:
  state=completed
  summary="..."
  result="..."
  artifacts=[{"type":"file","path":"repo/<file>"}]
```

The `git` profile blocks `git` and `gh` for the Agent. That keeps the
worktree/Repository under Worker control. If your workflow needs the Agent to
run git itself, create a profile with a smaller `blocked_commands` list.

`task_create` returns immediately. Do not call `task_wait`; the Router receives
an SSE notification when the Task settles.

## 4. Review and merge

The result includes:

```json
{
  "workspace": "C:\\...\\workspaces\\tkt_...",
  "workspace_metadata": {
    "vcs": "git",
    "branch": "super-rlm/tkt_...",
    "commit": "..."
  },
  "branch": "super-rlm/tkt_...",
  "commit": "...",
  "delivered_to": []
}
```

Review in the main checkout:

```powershell
cd C:\Users\15065\Project\my-app
git worktree list
git -C C:\Users\15065\.super-rlm\projects\my-app\workspaces\<ticket_id>\repo diff
git -C ... status
```

The Agent is blocked from running git, so the worktree normally has uncommitted
changes. Review, then commit and merge manually:

```powershell
git -C <worktree> add -A
git -C <worktree> -c user.name=super-rlm -c user.email=super-rlm@example.invalid commit -m "..."
git merge --no-ff super-rlm/tkt_...
```

Clean up:

```powershell
git worktree remove "<worktree>"
git branch -d super-rlm/tkt_...
```

## Result delivery

The CLI captures the directory where you launched it as `SUPER_RLM_ORIGIN_CWD`.
The Worker delivers a completed Ticket according to its profile:

```yaml
delivery:
  mode: artifacts      # artifacts | workspace | none
  collision: version   # version | overwrite | error
  strip_prefix: repo   # optional
```

- `artifacts` copies reported files to the launch directory.
- `workspace` copies the whole workspace to
  `<origin>/<workspace_subdir>/<ticket_id>/`.
- `none` disables automatic delivery.
- `version` keeps existing files and writes
  `<name>.super-rlm-<ticket_id><suffix>` instead.

The global fallbacks are:

```powershell
$env:SUPER_RLM_DELIVERY_MODE="artifacts"
$env:SUPER_RLM_DELIVERY_COLLISION="version"
$env:SUPER_RLM_DELIVERY_STRIP_PREFIX="repo"
```

Delivery failures do not fail the Ticket; they appear as `delivery_error`.

## 5. Copy artifacts manually

Artifacts are relative paths inside the Ticket workspace:

```powershell
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts artifacts tkt_... --to C:\temp
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts artifacts tkt_... --all --to C:\temp
```

`--all` omits `.git`, `.super-rlm-report.json`, `.super-rlm-prepared`, and
`.super-rlm-bin`.

## Current limits

- The Worker is not a security sandbox; it runs as your user. Use a dedicated
  OS account or container when untrusted code is involved.
- `blocked_commands` is a PATH shim, not a hard security boundary; absolute
  paths can bypass it.
- The `git` profile leaves changes uncommitted; commit them yourself before
  merging.
