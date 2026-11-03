# Spike 1: Pi Router Extension

Status: passed, with one environment caveat  
Date: 2026-11-03

## Question

Can a project-local Pi Agent extension run with only control-plane tools, call a mock Orchestrator, and keep all shell/file tools unavailable?

## Environment

- Windows 11.
- Node.js 26.13.0 (user-provided host prerequisite; not part of the project runtime; Pi requires >= 22.19).
- Pi coding agent 1.5.0, installed project-locally under `runtime/pi/` from npm.
- Project runtime root: `~/.super-rlm/projects/prj_spike_local`.
- Mock Orchestrator: `spikes/mock_orchestrator.py`.
- Fake OpenAI-compatible model: `spikes/fake_llm.py` (`pi_router` and `pi_router_full` modes).

No user Pi configuration was read. `~/.pi` does not exist.

## Setup

`apps/router/.pi/settings.json`:

```json
{
  "defaultTools": [],
  "extensions": ["./extensions/super-rlm.ts"]
}
```

The extension registers six control-plane tools and uses only `fetch`:

- `profile_list`
- `task_create`
- `task_list`
- `task_status`
- `task_wait`
- `ticket_result`

The launch command used defense in depth:

```bash
cd apps/router
PI_CODING_AGENT_DIR="$HOME/.super-rlm/projects/prj_spike_local/pi/agent" \
PI_CODING_AGENT_SESSION_DIR="$HOME/.super-rlm/projects/prj_spike_local/pi/sessions" \
SUPER_RLM_ORCHESTRATOR_URL=http://127.0.0.1:18911 \
SUPER_RLM_ROUTER_TOKEN=spike-token \
node runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  --print -a --no-extensions -e ./extensions/super-rlm.ts \
  --no-skills --no-context-files --no-prompt-templates --no-themes --no-mcp -nbt \
  --provider fake --model fake-1 \
  --session-dir "$HOME/.super-rlm/projects/prj_spike_local/pi/sessions" \
  --session-id super-rlm-router-prj_spike_full \
  "Create a hello file and report the result."
```

## Results

### Tool surface

Every model request declared exactly these tools:

```text
profile_list, task_create, task_list, task_status, task_wait, ticket_result
```

No `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, `codemode`, `tool_search`, or MCP tools were declared.

### End-to-end calls

The scripted model called all scoped tools. The mock Orchestrator observed:

```text
GET  /v1/profiles
POST /v1/tasks
GET  /v1/tasks/tsk_mock_1
GET  /v1/tasks/tsk_mock_1/wait?timeout_s=30
GET  /v1/tickets/tkt_mock_1/result?max_chars=20000
```

The final assistant text was returned by the scripted model, and `--print` exited with code 0.

### Built-in tool rejection

A second script made the model emit a `bash` tool call. Pi returned:

```json
{"role": "tool", "content": "Tool bash not found"}
```

No shell command ran. This is the expected fail-closed behavior when a model hallucinates a tool that is not registered.

### Session persistence

Pi created a persistent project-local session:

```text
~/.super-rlm/projects/prj_spike_local/pi/sessions/
  2026-11-03T13-15-03-579Z_super-rlm-router-prj_spike_full.jsonl
```

The session file lives under the project runtime root. No global Pi state was touched.

## Findings

1. `defaultTools: []` removes all built-in tools but does not remove extension tools. `-nbt` is a useful second guard.
2. `--no-extensions -e <path>` loads only the explicit Router extension and excludes built-in MCP/codemode/tool-search extensions.
3. `-a` (approve) is needed if project `.pi/settings.json` should load. The explicit `-e` path is enough to load the extension even without project settings, but the settings file is still the right place for `defaultTools`.
4. A local OpenAI-compatible fake provider works well for deterministic extension tests. It records the exact `tools` array, which is stronger evidence than reading the prompt.
5. The Router extension is dependency-free: `fetch` and `typebox` are enough. No npm packages need to be installed in `apps/router`.

## Caveat

Pi needs a Node.js runtime. Node is a user-provided host prerequisite and is not bundled into the project runtime. A launch wrapper must still verify the Node version.

## Verdict

Pass. The Router can run with control-plane tools only, call the Orchestrator contract, and reject built-in tool calls.
