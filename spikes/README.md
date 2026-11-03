# Spike Harness

Host prerequisite: Node.js `>= 22.19` is provided by the user; it is not part of `runtime/`.

These scripts reproduce the two local spikes. They are development fixtures, not production code.

## Pi Router

```bash
# terminal 1: fake model
python spikes/fake_llm.py --port 18901 --mode pi_router_full --log spikes/logs/fake.jsonl

# terminal 2: mock Orchestrator
python spikes/mock_orchestrator.py --port 18911 --token spike-token --log spikes/logs/orch.jsonl

# terminal 3: Pi
cd apps/router
PI_CODING_AGENT_DIR="$HOME/.super-rlm/projects/prj_spike_local/pi/agent" \
PI_CODING_AGENT_SESSION_DIR="$HOME/.super-rlm/projects/prj_spike_local/pi/sessions" \
SUPER_RLM_ORCHESTRATOR_URL=http://127.0.0.1:18911 \
SUPER_RLM_ROUTER_TOKEN=spike-token \
node ../runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  --print -a --no-extensions -e ./extensions/super-rlm.ts \
  --no-skills --no-context-files --no-prompt-templates --no-themes --no-mcp -nbt \
  --provider fake --model fake-1 \
  --session-dir "$HOME/.super-rlm/projects/prj_spike_local/pi/sessions" \
  --session-id super-rlm-router-prj_spike_full \
  "Create a hello file and report the result."
```

Set `--mode pi_router_bash` to test that a hallucinated `bash` call is rejected.

## Prime Agent ACP

`acp_probe.py` drives a two-child `rlm.spawn` turn. `resume_probe.py` tests `session_ref` resume. `acp_report_probe.py` tests a report and the enforcement prompt.

The ACP probes expect:

```text
PRIME_AGENT_CODING_AGENT_DIR
PRIME_AGENT_CODING_AGENT_SESSION_DIR
PRIME_AGENT_SESSION_DIR
PRIME_AGENT_DAEMON_SOCKET
PRIME_AGENT_KERNEL_VENV
PRIME_AGENT_KERNEL_PYTHON
```

and a project `models.json` with an `openai-completions` provider pointing at `spikes/fake_llm.py --mode prime_acp`.

See `docs/spikes/prime-acp.md` for the full setup and findings.
