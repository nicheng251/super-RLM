# super-RLM

**A local-first agent runtime for long-running work.**

super-RLM lets you give one task to a planning agent, split it into smaller
Tickets, run them in parallel, and keep track of every result, session, and
delivered file.

It is built on top of [Pi](https://github.com/earendil-works/pi) and
[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), but adds the
part those tools do not provide by themselves: a task queue, isolated workers,
profiles, human-in-the-loop answers, resumable sessions, and a terminal UI for
watching the whole thing.

Current version: **v0.1.0** · Windows 10/11 x64

---

## Why

A single agent session gets messy when a task is large:

- one long conversation mixes several jobs together;
- a failure in one step blocks everything;
- parallel work is hard to track;
- results and files end up in random places;
- restarting means losing context;
- every job runs with the same model and permissions.

super-RLM separates the work:

```text
You
 ↓
Router          plans the work and creates Tickets
 ↓
Orchestrator    queues, schedules, retries, records state
 ↓
Worker          prepares a workspace and runs one Ticket
 ↓
Prime Agent     does the actual work, including RLM subagents
 ↓
Report          structured result, files, and session reference
```

---

## Features

- **Plan once, run many parts** — the Router turns a request into Tasks and
  Tickets.
- **Parallel execution** — independent Tickets run at the same time.
- **Per-Ticket profiles** — choose model, reasoning level, workspace, and
  delivery behaviour for each kind of work.
- **Human in the loop** — answer a waiting Ticket and resume it later.
- **Resumable sessions** — Prime Agent sessions survive interruptions.
- **Real file delivery** — results can be copied back to the directory where
  you started.
- **A terminal UI** — watch Chat, Tasks, Workers, and Events in one place.
- **Session viewer** — inspect what a Worker actually did, read-only.
- **Clean lifecycle** — the Windows installer/runtime owns its processes and
  shuts them down when the UI exits.

---

## Requirements

- Windows 10 or 11, x64
- Node.js **22.19 or newer**
- PowerShell 5.1 or newer
- Network access during install (npm) and first-time setup (PyPI)

Node is a host prerequisite; it is not bundled.

---

## Install

Download and extract a release ZIP, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\super-rlm-v0.1.0-win-x64\installer\install.ps1
```

The installer puts the app under:

```text
%LOCALAPPDATA%\Programs\super-RLM\
```

and adds `super-rlm` to your user `PATH`. Open a new terminal afterwards.

Verify:

```powershell
super-rlm --version
```

### From source

```powershell
git clone https://github.com/nicheng251/super-RLM.git
cd super-RLM
npm ci --prefix runtime/pi
npm ci --prefix apps/cli
npm ci --prefix apps/orchestrator
npm ci --prefix apps/router
npm ci --prefix apps/tui
```

---

## First run

Run setup once inside the project you want the agents to work on:

```powershell
cd C:\path\to\your-project
super-rlm setup
```

The setup command:

- creates the project runtime;
- checks Node and `uv`;
- installs the Worker and Prime Agent runtime;
- writes the local model registry;
- checks for a provider API key.

If the key is missing, it prints the exact line to add to:

```text
<SUPER_RLM_HOME>\secrets\providers.env
```

Then run setup again:

```powershell
super-rlm setup
super-rlm
```

`super-rlm` starts the terminal UI and the local stack. Closing the UI stops the
stack; there is no background service mode.

---

## Usage

### Start

```powershell
super-rlm
```

or, equivalently:

```powershell
super-rlm tui
```

### Main views

```text
Alt+1  Chat
Alt+2  Tasks
Alt+3  Workers
Alt+4  Events
```

- `Enter` in Tasks opens Task Detail.
- `Esc` goes back one level.
- `v` in Task Detail opens a read-only Ticket session.
- `/model` opens the model and profile selector.

### Common chat commands

```text
/filter [all|waiting|running|terminal]
/search <text>
/refresh
/answer
/abort
/model
/quit
/help
```

### Check or stop

```powershell
super-rlm status
super-rlm down
```

---

## Configuration

Two files control what runs:

```text
config/models.yaml     provider and model registry
config/profiles.yaml   Worker profiles
```

A profile is a named execution policy. For example:

```yaml
profiles:
  default:
    provider: deepseek
    model: deepseek-flash
    thinking: medium
    capabilities: [code, script, docs]
    delivery:
      mode: artifacts
```

The Router chooses a profile by name; it never chooses a raw model or receives
an API key.

Secrets stay outside the repository:

```text
<SUPER_RLM_HOME>\secrets\providers.env
<SUPER_RLM_HOME>\secrets\api.env
```

`providers.env` contains your provider key. `api.env` is generated
automatically and contains local service tokens.

Sync model changes with:

```powershell
super-rlm models sync
```

---

## Useful commands

```text
super-rlm setup              first-time project setup
super-rlm status             show the local stack
super-rlm down               stop the stack
super-rlm doctor             check the environment
super-rlm models sync        update Pi/Prime model registries
super-rlm profiles list      list Worker profiles
super-rlm tasks              list Tasks
super-rlm artifacts <id>     copy Ticket artifacts
super-rlm gc                 clean old resources (dry-run by default)
super-rlm backup <dir>       back up the local runtime
super-rlm restore <dir>      restore a backup
```

---

## Security

super-RLM is designed for a **trusted local machine** and a **trusted
repository**.

The current release provides process isolation, local tokens, loopback-only
services, per-Ticket temporary directories, and basic callback protection. It
does **not** provide a full filesystem sandbox, network egress policy, or
credential proxy.

Do not use it to run untrusted code or untrusted prompts yet.

See [docs/architecture.md](docs/architecture.md) for the current boundaries.

---

## Development

Run the test suites:

```powershell
cd packages/protocol/python; .venv\Scripts\python.exe -m pytest -q
cd apps/orchestrator; npm test; npm run check
cd apps/worker; .venv\Scripts\python.exe -m pytest -q
cd apps/cli; npm test; npm run check
cd apps/router; npm test; npm run check
cd apps/tui; npm test; npm run check
```

Windows lifecycle regression:

```powershell
apps\worker\.venv\Scripts\python.exe scripts\regression\windows_lifecycle.py
```

Real-model tests are opt-in and cost money:

```powershell
apps\worker\.venv\Scripts\python.exe scripts\regression\real_model.py --help
```

---

## Project layout

```text
apps/router          Router extension: planning tools and SSE
apps/orchestrator    Task/Ticket state machine and scheduler
apps/worker          Prime Agent ACP adapter
apps/cli             super-rlm launcher, setup, and maintenance
apps/tui             L3 terminal UI
packages/protocol    Shared schemas and types
config/              Model and profile configuration
installer/           Windows installer
docs/                Architecture, guides, ADRs, and E2E evidence
```

---

## Status

- v0.1.0
- Windows 10/11 x64
- Real TUI + Windows Job + DeepSeek E2E passed
- 316 tests passing
- Installer, lifecycle regression, session viewer, and cleanup tools included

Not included yet:

- MSI / code signing / auto-update
- CI
- cross-platform process isolation
- interactive `prime-agent attach`
- full filesystem sandbox / credential proxy

---

## Documentation

- [Architecture](docs/architecture.md)
- [Project structure](docs/project-structure.md)
- [Development guide](docs/guides/developing-with-super-rlm.md)
- [L3 TUI guide](docs/guides/l3-tui.md)
- [Windows installer](installer/README.md)
- [ADRs](docs/adr/)
- [Spikes and E2E evidence](docs/spikes/)
