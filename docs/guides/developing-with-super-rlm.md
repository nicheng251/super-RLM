# Developing an existing project with super-RLM

Status: current workflow  
Last updated: 2026-11-05

The Worker does not run in the directory where you launch the Router. It runs
in a per-Ticket runtime workspace:

```text
<SUPER_RLM_HOME>/workspaces/<ticket_id>/
```

For real project work, prepare that workspace as a git worktree of your
project. Do not let the Worker modify your main checkout.

## 1. Configure the project

Use a project-specific runtime root:

```powershell
$env:SUPER_RLM_HOME="C:\Users\15065\.super-rlm\projects\my-app"
$env:SUPER_RLM_PORT="18796"
$env:SUPER_RLM_WORKER_PORT="18087"
$env:SUPER_RLM_PROJECT_REPO="C:/Users/15065/Project/my-app"
$env:SUPER_RLM_PREPARE_COMMAND='git -C "$SUPER_RLM_PROJECT_REPO" worktree add ./repo -b "agent/$SUPER_RLM_TICKET_ID" main'
```

Notes:

- `SUPER_RLM_PROJECT_REPO` must be the path to the main checkout.
- In Git Bash, use forward slashes in the path.
- The prepare command runs with cwd set to the Ticket workspace.
- `./repo` is a convention: the Worker writes `<workspace>/.super-rlm-prepared`
  after it succeeds, and later resume/retry skips preparation.
- The branch name uses the Ticket ID, so concurrent Tickets get different
  branches.

One-time setup for the project runtime:

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
```

`SUPER_RLM_PRIME_PROVIDER` and `SUPER_RLM_PRIME_MODEL` still override the file.

## 2. Start the Router

```powershell
cd C:\Users\15065\Project\my-app
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts
```

The Router will:

1. health-check Orchestrator and Worker;
2. start missing services in the background;
3. launch the Pi TUI.

## 3. Create a Ticket

The Ticket prompt must tell the Worker where the prepared checkout is. Example:

```text
The project checkout is available at ./repo inside the current workspace.
Work ONLY inside ./repo. Do not modify anything outside it.

Implement <change>.
Run the relevant tests.
Commit the result:
  git -C repo add -A
  git -C repo -c user.name=super-rlm -c user.email=super-rlm@example.invalid commit -m "..."
Then call super_rlm_report with:
  state=completed
  summary="..."
  result="..."
  artifacts=[{"type":"file","path":"repo/<file>"}]
```

`task_create` returns immediately. Do not call `task_wait`; the Router receives
an SSE notification when the Task settles.

## 4. Review and merge

The result includes:

```json
{
  "workspace": "C:\\...\\workspaces\\tkt_...",
  "branch": "agent/tkt_...",
  "commit": "abc123"
}
```

Review in the main checkout:

```powershell
cd C:\Users\15065\Project\my-app
git worktree list
git diff main...agent/tkt_...
git log --oneline main..agent/tkt_...
```

Merge:

```powershell
git merge --no-ff agent/tkt_...
```

Clean up the worktree:

```powershell
git worktree remove "C:\Users\15065\.super-rlm\projects\my-app\workspaces\<ticket_id>\repo"
git branch -d agent/tkt_...
```

## 5. Copy artifacts

Artifacts are relative paths inside the Ticket workspace. Copy them to a chosen
directory:

```powershell
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts artifacts tkt_... --to C:\temp
```

Copy the whole workspace instead:

```powershell
node C:\Users\15065\Project\super-RLM\apps\cli\src\main.ts artifacts tkt_... --all --to C:\temp
```

`--all` omits `.git`, `.super-rlm-report.json`, and `.super-rlm-prepared`.

## Current limits

- Preparation is global (`SUPER_RLM_PREPARE_COMMAND`), not yet per profile.
- There is no automatic artifact copy-out after a Task settles; use the
  `artifacts` command.
- The Worker is not a security sandbox; it runs as your user. Use a dedicated
  OS account or container when untrusted code is involved.
