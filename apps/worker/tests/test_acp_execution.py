
import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import uvicorn

from super_rlm_protocol import ExecutionRequest, ReportAck
from super_rlm_worker.api import create_app
from super_rlm_worker.config import WorkerConfig
from super_rlm_worker.executor import ExecutionManager

REPO = Path(__file__).resolve().parents[3]
PRIME_AGENT = REPO / "runtime" / "prime-agent" / "prime-agent.exe"
KERNEL_VENV = Path.home() / ".super-rlm" / "projects" / "prj_spike_local" / "prime" / "kernel-venv"

pytestmark = pytest.mark.skipif(
    not PRIME_AGENT.exists() or not KERNEL_VENV.exists(),
    reason="project Prime Agent runtime or kernel venv is not available",
)


class FakeModelHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length", 0) or 0)
        body = json.loads(self.rfile.read(length))
        messages = body.get("messages", [])
        tool_calls = sum(len(m.get("tool_calls") or []) for m in messages if m.get("role") == "assistant")
        base = {
            "id": "chatcmpl-test", "object": "chat.completion.chunk",
            "created": int(time.time()), "model": body.get("model", "fake-1"),
        }
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()

        def send(obj):
            self.wfile.write(("data: " + json.dumps(obj) + "\n\n").encode())
            self.wfile.flush()

        if tool_calls == 0:
            code = (
                'await super_rlm_report(state="completed", '
                'summary="integration done", result="ok")\n'
            )
            delta = {"role": "assistant", "tool_calls": [{
                "index": 0, "id": "call_test_1", "type": "function",
                "function": {"name": "ipython", "arguments": json.dumps({"code": code})},
            }]}
            send(dict(base, choices=[{"index": 0, "delta": delta, "finish_reason": None}]))
            send(dict(base, choices=[{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]))
        else:
            send(dict(base, choices=[{"index": 0, "delta": {"role": "assistant", "content": "done"}, "finish_reason": None}]))
            send(dict(base, choices=[{"index": 0, "delta": {}, "finish_reason": "stop"}]))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True


class FakeForwarder:
    def __init__(self):
        self.reports = []

    async def forward(self, report):
        self.reports.append(report)
        return ReportAck(accepted=True)


def free_port() -> int:
    import socket
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


@pytest.mark.asyncio
async def test_worker_runs_prime_agent_and_forwards_a_report(tmp_path):
    model_port = free_port()
    model_server = ThreadingHTTPServer(("127.0.0.1", model_port), FakeModelHandler)
    threading.Thread(target=model_server.serve_forever, daemon=True).start()

    home = tmp_path / "home"
    agent_dir = home / "prime" / "agent"
    agent_dir.mkdir(parents=True)
    (agent_dir / "models.json").write_text(json.dumps({
        "providers": {
            "fake": {
                "name": "Fake local model",
                "api": "openai-completions",
                "baseUrl": f"http://127.0.0.1:{model_port}/v1",
                "apiKey": "fake-key",
                "authHeader": False,
                "models": [{
                    "id": "fake-1", "name": "Fake 1", "api": "openai-completions",
                    "reasoning": False, "input": ["text"],
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                    "contextWindow": 128000, "maxTokens": 8192,
                }],
            }
        }
    }), encoding="utf-8")

    worker_port = free_port()
    config = WorkerConfig.from_env({
        "SUPER_RLM_HOME": str(home),
        "SUPER_RLM_PRIME_AGENT": str(PRIME_AGENT),
        "SUPER_RLM_PRIME_PROVIDER": "fake",
        "SUPER_RLM_PRIME_MODEL": "fake-1",
        "SUPER_RLM_KERNEL_VENV": str(KERNEL_VENV),
        "SUPER_RLM_KERNEL_PYTHON": str(KERNEL_VENV / "Scripts" / "python.exe"),
        "SUPER_RLM_REPORT_SKILL": str(REPO / "apps" / "worker" / "skills" / "super-rlm-report"),
        "SUPER_RLM_WORKER_PROMPT": str(REPO / "apps" / "worker" / "prompts" / "worker.md"),
        "SUPER_RLM_WORKER_HOST": "127.0.0.1",
        "SUPER_RLM_WORKER_PORT": str(worker_port),
        "SUPER_RLM_WORKER_TOKEN": "test-worker-token",
        "SUPER_RLM_CALLBACK_KEY": "test-callback-key",
        "SUPER_RLM_MAX_CONCURRENCY": "1",
    })
    config.ensure_dirs()

    forwarder = FakeForwarder()
    manager = ExecutionManager(config, forwarder)
    app = create_app(manager, config)
    server = uvicorn.Server(uvicorn.Config(app, host=config.host, port=config.port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started and time.time() < deadline:
        await asyncio.sleep(0.05)
    assert server.started

    try:
        request = ExecutionRequest(
            ticket_id="tkt_test",
            assignment_id="asg_test",
            prompt="Run the Worker integration test.",
            profile="default",
            workspace=str(config.workspace_root / "tkt_test"),
        )
        state = await manager.start(request)
        await asyncio.wait_for(state.done.wait(), timeout=120)
        assert state.session_ref is not None
        assert Path(state.session_ref).exists()
        assert state.session_ref.endswith(".jsonl")
        assert forwarder.reports, "Worker did not forward a report"
        completed = [r for r in forwarder.reports if r.state.value == "completed"]
        assert completed, [r.model_dump() for r in forwarder.reports]
        assert completed[0].summary == "integration done"
        assert completed[0].result == "ok"
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        model_server.shutdown()
        model_server.server_close()
