import asyncio

import pytest
from fastapi.testclient import TestClient

from super_rlm_worker import main
from super_rlm_worker.config import WorkerConfig
from super_rlm_worker.daemon import DaemonError


class FakeDaemon:
    def __init__(self, events, fail=False):
        self.events = events
        self.fail = fail

    async def ensure(self):
        self.events.append("daemon_ensure")
        if self.fail:
            raise DaemonError("daemon startup failed")

    async def shutdown(self):
        self.events.append("daemon_shutdown")


def make_config(tmp_path):
    return WorkerConfig.from_env({
        "SUPER_RLM_HOME": str(tmp_path / "home"),
        "SUPER_RLM_PRIME_AGENT": str(tmp_path / "prime-agent.exe"),
        "SUPER_RLM_KERNEL_VENV": str(tmp_path / "kernel"),
        "SUPER_RLM_WORKER_PORT": "0",
        "SUPER_RLM_DAEMON_AUTOSTART": "0",
    })


@pytest.fixture
def quiet_background(monkeypatch):
    events = []

    async def fake_register(config):
        events.append("register")

    async def fake_loop(config, manager):
        await asyncio.Event().wait()

    monkeypatch.setattr(main, "register_with_retry", fake_register)
    monkeypatch.setattr(main, "heartbeat_loop", fake_loop)
    monkeypatch.setattr(main, "assignment_heartbeat_loop", fake_loop)
    return events


def test_lifespan_ensures_daemon_before_register_and_shuts_it_down(tmp_path, quiet_background):
    events = quiet_background
    app = main.build_app(make_config(tmp_path), daemon=FakeDaemon(events))
    with TestClient(app) as client:
        assert client.get("/v1/health").status_code == 200
        assert events == ["daemon_ensure", "register"]
    assert events == ["daemon_ensure", "register", "daemon_shutdown"]


def test_lifespan_fails_startup_when_daemon_fails(tmp_path, quiet_background):
    events = quiet_background
    app = main.build_app(make_config(tmp_path), daemon=FakeDaemon(events, fail=True))
    with pytest.raises(DaemonError, match="daemon startup failed"):
        with TestClient(app):
            pass
    assert "register" not in events


def test_shutdown_route_requires_token_and_requests_graceful_shutdown(tmp_path, quiet_background):
    events = quiet_background
    app = main.build_app(make_config(tmp_path), daemon=FakeDaemon(events))
    with TestClient(app) as client:
        assert client.post("/v1/shutdown").status_code == 401
        assert client.post(
            "/v1/shutdown", headers={"authorization": "Bearer wrong"}
        ).status_code == 403

        requested = []
        app.state.request_shutdown = lambda: requested.append("requested")
        response = client.post(
            "/v1/shutdown", headers={"authorization": "Bearer dev-worker-token"}
        )
        assert response.status_code == 200
        assert response.json() == {"status": "shutting_down"}
        assert requested == ["requested"]

        again = client.post(
            "/v1/shutdown", headers={"authorization": "Bearer dev-worker-token"}
        )
        assert again.status_code == 200
        assert requested == ["requested"]
    assert "daemon_shutdown" in events


@pytest.mark.asyncio
async def test_runtime_shutdown_stops_manager_then_daemon(tmp_path):
    events = []

    class FakeManager:
        async def shutdown(self):
            events.append("manager_shutdown")

    fake_daemon = FakeDaemon(events)
    runtime = main.WorkerRuntime(make_config(tmp_path), FakeManager(), fake_daemon)
    await runtime.shutdown()
    await runtime.shutdown()
    assert events == ["manager_shutdown", "daemon_shutdown"]
    assert runtime.shutting_down is True
