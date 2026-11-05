
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from super_rlm_protocol import ReportAck, SkillReport
from super_rlm_worker.api import create_app
from super_rlm_worker.config import WorkerConfig
from super_rlm_worker.executor import (
    AtCapacity,
    InvalidExecution,
    InvalidReportToken,
    WorkerShuttingDown,
)


class StubManager:
    def __init__(self):
        self.running = 0
        self.max_concurrency = 2
        self.full = False

    async def start(self, request):
        if self.full:
            raise AtCapacity("full")
        return SimpleNamespace(execution_id="exe_test")

    async def cancel(self, execution_id, reason=None):
        return None

    async def record_report(self, assignment_id, token, report):
        if token != "good-token":
            raise InvalidReportToken("bad token")
        return ReportAck(accepted=True)


def config(tmp_path):
    return WorkerConfig.from_env({
        "SUPER_RLM_HOME": str(tmp_path),
        "SUPER_RLM_PRIME_AGENT": str(tmp_path / "prime-agent.exe"),
        "SUPER_RLM_KERNEL_VENV": str(tmp_path / "kernel"),
        "SUPER_RLM_WORKER_ID": "wrk_test",
    })


def test_start_execution_returns_202(tmp_path):
    manager = StubManager()
    client = TestClient(create_app(manager, config(tmp_path)))
    response = client.post("/v1/executions", json={
        "ticket_id": "tkt_1",
        "assignment_id": "asg_1",
        "prompt": "do it",
        "profile": "default",
        "workspace": str(tmp_path / "workspace"),
    })
    assert response.status_code == 202
    assert response.json()["execution_id"] == "exe_test"


def test_at_capacity_is_409(tmp_path):
    manager = StubManager()
    manager.full = True
    client = TestClient(create_app(manager, config(tmp_path)))
    response = client.post("/v1/executions", json={
        "ticket_id": "tkt_1",
        "assignment_id": "asg_1",
        "prompt": "do it",
        "profile": "default",
        "workspace": str(tmp_path / "workspace"),
    })
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "at_capacity"


def test_invalid_execution_is_400(tmp_path):
    class InvalidManager(StubManager):
        async def start(self, request):
            raise InvalidExecution("thinking must be one of the allowed levels")

    client = TestClient(create_app(InvalidManager(), config(tmp_path)))
    response = client.post("/v1/executions", json={
        "ticket_id": "tkt_1",
        "assignment_id": "asg_1",
        "prompt": "do it",
        "profile": "default",
        "workspace": str(tmp_path / "workspace"),
    })
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_execution"


def test_worker_shutting_down_is_503(tmp_path):
    class StoppingManager(StubManager):
        async def start(self, request):
            raise WorkerShuttingDown("worker is shutting down")

    client = TestClient(create_app(StoppingManager(), config(tmp_path)))
    response = client.post("/v1/executions", json={
        "ticket_id": "tkt_1",
        "assignment_id": "asg_1",
        "prompt": "do it",
        "profile": "default",
        "workspace": str(tmp_path / "workspace"),
    })
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "shutting_down"


def test_report_requires_token(tmp_path):
    manager = StubManager()
    client = TestClient(create_app(manager, config(tmp_path)))
    body = {
        "state": "completed",
        "summary": "done",
        "result": "ok",
        "artifacts": [],
    }
    assert client.post("/internal/assignments/asg_1/report", json=body).status_code == 401
    bad = client.post(
        "/internal/assignments/asg_1/report",
        json=body,
        headers={"authorization": "Bearer bad"},
    )
    assert bad.status_code == 403
    good = client.post(
        "/internal/assignments/asg_1/report",
        json=body,
        headers={"authorization": "Bearer good-token"},
    )
    assert good.status_code == 200
    assert good.json()["accepted"] is True
