"""Tests for the read-only Ticket session view."""

import os

import pytest

from super_rlm_protocol import ReportAck, ReportState, SkillReport
from super_rlm_worker.config import WorkerConfig
from super_rlm_worker.executor import ExecutionManager, ExecutionNotFound, ExecutionState


class FakeForwarder:
    async def forward(self, report):
        return ReportAck(accepted=True)


class FakeDaemon:
    async def stop_session(self, session_id):
        return True


def make_config(tmp_path):
    return WorkerConfig.from_env({
        "SUPER_RLM_HOME": str(tmp_path / "home"),
        "SUPER_RLM_PRIME_AGENT": str(tmp_path / "prime-agent.exe"),
        "SUPER_RLM_KERNEL_VENV": str(tmp_path / "kernel"),
        "SUPER_RLM_WORKER_TOKEN": "test-worker-token",
        "SUPER_RLM_CALLBACK_KEY": "test-callback-key",
        "SUPER_RLM_WORKER_PORT": "0",
        "SUPER_RLM_DAEMON_AUTOSTART": "0",
    })


def make_manager(tmp_path):
    return ExecutionManager(make_config(tmp_path), FakeForwarder(), daemon=FakeDaemon())


def make_state(tmp_path, *, ticket_id="tkt_1", execution_id="exe_1", session_ref=None):
    session_dir = tmp_path / "sessions"
    session_dir.mkdir(parents=True, exist_ok=True)
    return ExecutionState(
        execution_id=execution_id,
        ticket_id=ticket_id,
        assignment_id=f"asg_{execution_id}",
        prompt="do it",
        profile="default",
        workspace=tmp_path / "workspace",
        session_dir=session_dir,
        report_token="secret-report-token",
        report_url="http://127.0.0.1/report",
        report_config=tmp_path / "report.json",
        session_ref=session_ref,
    )


def test_session_view_returns_latest_execution_for_ticket(tmp_path):
    manager = make_manager(tmp_path)
    session_dir = tmp_path / "sessions"
    session_dir.mkdir(parents=True, exist_ok=True)
    session_file = session_dir / "sess-2.jsonl"
    session_file.write_text("{}", encoding="utf-8")
    older = make_state(tmp_path, execution_id="exe_1", session_ref=str(tmp_path / "sessions" / "sess-1.jsonl"))
    latest = make_state(tmp_path, execution_id="exe_2", session_ref=str(session_file))
    manager._by_execution[older.execution_id] = older
    manager._by_execution[latest.execution_id] = latest

    view = manager.session_view("tkt_1")

    assert view.ticket_id == "tkt_1"
    assert view.session_ref == str(session_file)
    assert view.session_dir == str(tmp_path / "sessions")
    assert view.session_id == "sess-2"
    assert view.session_file == str(session_file)
    assert view.daemon_socket == manager.config.daemon_socket
    assert view.status == "running"
    assert view.running is True
    assert view.worker_pid == os.getpid()
    assert view.exists is True


def test_session_view_terminal_status(tmp_path):
    manager = make_manager(tmp_path)
    state = make_state(tmp_path)
    state.done.set()
    state.terminal_report = SkillReport(state=ReportState.COMPLETED, summary="done", result="ok")
    manager._by_execution[state.execution_id] = state

    view = manager.session_view("tkt_1")

    assert view.status == "completed"
    assert view.running is False


def test_session_view_without_session_ref(tmp_path):
    manager = make_manager(tmp_path)
    state = make_state(tmp_path)
    state.done.set()
    state.terminal_report = SkillReport(state=ReportState.DROPPED, summary="dropped")
    manager._by_execution[state.execution_id] = state

    view = manager.session_view("tkt_1")

    assert view.session_ref is None
    assert view.session_id is None
    assert view.session_file is None
    assert view.status == "dropped"
    assert view.exists is False


def test_session_view_done_without_report_is_unknown(tmp_path):
    manager = make_manager(tmp_path)
    state = make_state(tmp_path)
    state.done.set()
    manager._by_execution[state.execution_id] = state

    assert manager.session_view("tkt_1").status == "unknown"


def test_session_view_unknown_ticket_raises(tmp_path):
    manager = make_manager(tmp_path)

    with pytest.raises(ExecutionNotFound):
        manager.session_view("tkt_missing")
