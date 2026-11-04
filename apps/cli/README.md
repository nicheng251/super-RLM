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
PI_CODING_AGENT_DIR=<home>/pi/agent
PI_CODING_AGENT_SESSION_DIR=<home>/pi/sessions
```

No built-in tools are registered. The extension is the only tool source.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `SUPER_RLM_HOME` | `~/.super-rlm/projects/<project_id>` | Project runtime root. |
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
