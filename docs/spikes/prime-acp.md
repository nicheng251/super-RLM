# Spike 2: Prime Agent ACP

Status: passed, with concrete integration constraints  
Date: 2026-11-03

## Question

Can a Python ACP client drive a project-local Prime Agent session that recursively spawns RLM children, returns a final result, and delivers a structured report skill?

## Environment

- Prime Agent 0.10.2, copied project-locally to `runtime/prime-agent/`.
- Python 3.11 kernel venv: `~/.super-rlm/projects/prj_spike_local/prime/kernel-venv`.
- ACP over stdio: `prime-agent --mode acp`.
- Fake OpenAI-compatible provider at `127.0.0.1:18902` (`spikes/fake_llm.py`, mode `prime_acp`).
- Report sink at `127.0.0.1:18903` (`spikes/report_sink.py`).
- No user Prime Agent configuration was read or written.

## Required environment

Prime Agent needs more project-owned paths than the original architecture listed:

```text
PRIME_AGENT_CODING_AGENT_DIR
PRIME_AGENT_CODING_AGENT_SESSION_DIR
PRIME_AGENT_SESSION_DIR
PRIME_AGENT_DAEMON_SOCKET
PRIME_AGENT_KERNEL_VENV
PRIME_AGENT_KERNEL_PYTHON
PRIME_AGENT_BASH_SHELL          # Windows: absolute path to a POSIX shell
```

`PRIME_AGENT_CODING_AGENT_DIR` alone is not enough. Without `PRIME_AGENT_KERNEL_VENV` and `PRIME_AGENT_KERNEL_PYTHON`, the ACP daemon tries to bootstrap a kernel under `~/.prime/agent/kernel-venv`.

The project kernel venv must contain:

- `prime-agent-runtime` (editable from `runtime/prime-agent/prime-agent-runtime`)
- `mcp>=2,<3`
- `tyro`
- the default packages Prime Agent checks for: `requests`, `httpx`, `pyyaml`, `tomli`, `python-dotenv`, `pandas`, `numpy`, `scipy`, `beautifulsoup4`, `lxml`

Without those packages the kernel refuses to start with a specific missing-package error.

## ACP sequence

```text
initialize
  -> protocolVersion 1
  -> agentCapabilities: loadSession=false, sessionCapabilities.close
session/new {cwd, mcpServers: []}
  -> sessionId (ACP id), configOptions
session/prompt {sessionId, prompt}
  -> session/update notifications
  -> result {stopReason: "end_turn"}
```

`--cwd <workspace>` sets the session working directory. The session file records the requested workspace, not the process cwd.

## Recursive spawn

The fake model called the `ipython` tool with:

```python
a = await rlm.spawn("Return the word ALPHA.", name="alpha")
b = await rlm.spawn("Return the word BETA.", name="beta")
await asyncio.sleep(2)
rows = await rlm.collect(timeout_ms=120000)
print(json.dumps([...]))
```

Observed ACP events:

```text
session_info_update  subagents: alpha running
session_info_update  subagents: beta running
session_info_update  subagents: alpha done
session_info_update  subagents: beta done
terminalQuiescence   outstandingSubagents: 0
```

The ACP prompt result returned only after terminal quiescence. The root final text was delivered as `agent_message_chunk`.

Child sessions were stored under:

```text
prime/agent/session-artifacts/<root-session-id>/sub-<child-id>/<child-session-id>.jsonl
```

They are Prime Agent internals and were not exposed as Orchestrator state.

## Report skill

`apps/worker/skills/super-rlm-report/` is a Python-backed skill:

- `SKILL.md` with `name: super-rlm-report`
- `pyproject.toml` with hatchling `src/super_rlm_report`
- `run(state, summary, result, question, artifacts, error)`

It was installed editable into the project kernel venv:

```bash
uv pip install -e apps/worker/skills/super-rlm-report
```

Prime Agent was launched with `--skill <dir> -ns`.

Observed reports:

```json
{"state": "completed", "summary": "Spike report done", "result": "hello from prime"}
{"state": "waiting", "summary": "Need a platform",
 "question": {"kind": "waiting", "text": "Linux or Windows?"}}
```

The skill posted to `SUPER_RLM_REPORT_URL` with `Authorization: Bearer <SUPER_RLM_REPORT_TOKEN>`.

### Enforcement prompt

A turn that ended with text only produced no terminal report. A second `session/prompt` on the same ACP session with:

> Before ending, call super_rlm_report with the terminal state.

produced a `completed` report. This confirms the Worker's one-shot enforcement policy is implementable.

## Session ref discovery

This is the important constraint.

- `session/new` returns an ACP `sessionId` such as `7754bda3-d11e-...`.
- The durable session file is a different id, such as `01a1a191-fc4b-....jsonl`.
- The ACP `sessionId` is not directly listed by `prime-agent sessions --json --all`.
- `prime-agent sessions --json --all` does expose `activeSessionId`, `sessionId`, `sessionFile`, `cwd`, `created`, and `modified`.

Recommended Worker approach:

1. Give each Ticket its own session directory:
   `<project>/prime/sessions/<ticket_id>/`.
2. After `session/new`, pick the only or newest `*.jsonl` file in that directory.
3. Store that absolute path as the durable `session_ref`.
4. On resume, start ACP with `--resume <session_ref>` and the same daemon socket.
5. After the first turn, or if the session dir is ambiguous, cross-check with `prime-agent sessions --json --all` and match `cwd` plus `created`.

### Resume

`--resume <sessionFile>` reuses the conversation. In the test, the second ACP process received a new ACP `sessionId`, but the model answered with the prior turn's word (`PINEAPPLE`). No new session file was created.

Resume requires the **same daemon socket** that holds the session lease. Using a different daemon socket failed with:

```text
This session is currently open in another Rust build of Prime Agent ...
```

That failure is a normal fallback trigger: start a new session and send a recovery prompt.

## Other findings

- `rlm.collect(timeout_ms=120000)` returned `running` snapshots before the children settled. The ACP turn still waited and reported child completion. The Worker should not use `collect()` as the only completion signal; it should rely on the ACP `terminalQuiescence` event or its own process wait.
- In `--print` mode, a session that loaded the report skill did not exit within 45–90 seconds after the report. ACP mode is the correct integration; the Worker should close the ACP process after a terminal report.
- `session/update` includes `promptTurnId`, `eventSequence`, `phase`, and `subagents` metadata. These are useful for logs and progress, but child events must not become Orchestrator task state.
- Prime Agent's `faux` provider works in `--print` mode but is unknown to the ACP daemon. The ACP spike used a project `models.json` custom `openai-completions` provider instead.

## Verdict

Pass, with four integration requirements:

1. Set all Prime Agent project paths, including the kernel venv and Python.
2. Discover `session_ref` as the durable session file, not the ACP session id.
3. Resume with the same daemon socket, and fall back to a new session on lease failure.
4. Install Python-backed skills editable into the project kernel venv before launch.
