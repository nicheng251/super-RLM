import asyncio
from contextlib import asynccontextmanager

import pytest

from super_rlm_protocol import ExecutionRequest, ReportAck, ReportState
from super_rlm_worker import executor
from super_rlm_worker.config import WorkerConfig
from super_rlm_worker.daemon import DaemonError
from super_rlm_worker.executor import ExecutionManager, WorkerShuttingDown


class FakeForwarder:
    def __init__(self):
        self.reports = []

    async def forward(self, report):
        self.reports.append(report)
        return ReportAck(accepted=True)


class FakeDaemon:
    def __init__(self, events, stop_error=None):
        self.events = events
        self.stop_error = stop_error
        self.stopped = []

    async def stop_session(self, session_id):
        self.events.append("stop_session")
        if self.stop_error is not None:
            raise self.stop_error
        self.stopped.append(session_id)
        return True

    async def shutdown(self):
        self.events.append("daemon_shutdown")


class FakeProcess:
    def __init__(self, events):
        self.events = events
        self.terminated = False

    def terminate(self):
        self.terminated = True
        self.events.append("acp_terminate")

    async def wait(self):
        return 0

    def kill(self):
        self.events.append("acp_kill")


class FakeAcp:
    def __init__(self, events):
        self.events = events
        self.spawned = 0
        self.prompts = []
        self.cancels = 0
        self.process = None
        self.release = None
        self.prompt_started = None

    @asynccontextmanager
    async def open_prime_agent(self, config, workspace, session_dir, *args, **kwargs):
        self.spawned += 1
        (session_dir / "sess-1.jsonl").write_text("{}", encoding="utf-8")
        self.process = FakeProcess(self.events)
        yield object(), self.process, None

    async def initialize(self, connection):
        return None

    async def new_session(self, connection, workspace):
        return "acp-session-1"

    async def prompt(self, connection, session_id, text):
        self.prompts.append(text)
        self.prompt_started.set()
        await self.release.wait()
        return object()

    async def cancel(self, connection, session_id):
        self.cancels += 1
        self.events.append("acp_cancel")
        self.release.set()
        return None


@pytest.fixture
def acp(monkeypatch):
    events = []
    fake = FakeAcp(events)
    fake.release = None
    monkeypatch.setattr(executor.acp_client, "open_prime_agent", fake.open_prime_agent)
    monkeypatch.setattr(executor.acp_client, "initialize", fake.initialize)
    monkeypatch.setattr(executor.acp_client, "new_session", fake.new_session)
    monkeypatch.setattr(executor.acp_client, "prompt", fake.prompt)
    monkeypatch.setattr(executor.acp_client, "cancel", fake.cancel)
    return fake


def make_config(tmp_path, **env):
    return WorkerConfig.from_env({
        "SUPER_RLM_HOME": str(tmp_path / "home"),
        "SUPER_RLM_PRIME_AGENT": str(tmp_path / "prime-agent.exe"),
        "SUPER_RLM_KERNEL_VENV": str(tmp_path / "kernel"),
        "SUPER_RLM_WORKER_TOKEN": "test-worker-token",
        "SUPER_RLM_CALLBACK_KEY": "test-callback-key",
        "SUPER_RLM_WORKER_PORT": "0",
        "SUPER_RLM_DAEMON_AUTOSTART": "0",
        "SUPER_RLM_CANCEL_WAIT_S": "0.3",
        "SUPER_RLM_DAEMON_START_TIMEOUT_S": "0.5",
        **env,
    })


def make_request(tmp_path, execution=None):
    return ExecutionRequest(
        ticket_id="tkt_1",
        assignment_id="asg_1",
        prompt="do it",
        profile="default",
        workspace=str(tmp_path / "workspace"),
        execution=execution,
    )


def make_manager(config, events, forwarder, stop_error=None):
    daemon = FakeDaemon(events, stop_error=stop_error)
    return ExecutionManager(config, forwarder, daemon=daemon), daemon


@pytest.mark.asyncio
async def test_cancel_during_prepare_never_spawns_prime(tmp_path, monkeypatch, acp):
    events = acp.events
    forwarder = FakeForwarder()
    manager, daemon = make_manager(make_config(tmp_path), events, forwarder)
    prepare_started = asyncio.Event()

    async def slow_prepare(*args, **kwargs):
        prepare_started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(executor, "prepare_workspace", slow_prepare)
    state = await manager.start(make_request(tmp_path))
    await asyncio.wait_for(prepare_started.wait(), timeout=2)
    await manager.cancel(state.execution_id, "user cancelled")
    await asyncio.wait_for(state.done.wait(), timeout=2)

    assert acp.spawned == 0
    assert daemon.stopped == []
    states = [report.state for report in forwarder.reports]
    assert states == [ReportState.CANCELLED]

    await manager.cancel(state.execution_id, "again")
    assert len(forwarder.reports) == 1


@pytest.mark.asyncio
async def test_cancel_after_spawn_stops_session_and_skips_enforcement(tmp_path, acp):
    events = acp.events
    forwarder = FakeForwarder()
    manager, daemon = make_manager(make_config(tmp_path), events, forwarder)

    acp.release = asyncio.Event()
    acp.prompt_started = asyncio.Event()
    state = await manager.start(make_request(tmp_path))
    await asyncio.wait_for(acp.prompt_started.wait(), timeout=2)
    await manager.cancel(state.execution_id, "user cancelled")
    await asyncio.wait_for(state.done.wait(), timeout=2)

    assert len(acp.prompts) == 1, "cancelled turn must not get the enforcement prompt"
    assert daemon.stopped == ["sess-1"]
    assert acp.cancels == 1
    assert acp.process.terminated is True
    assert state.cleanup_error is None
    states = [report.state for report in forwarder.reports]
    assert states == [ReportState.CANCELLED]
    assert forwarder.reports[0].cleanup_error is None

    await manager.cancel(state.execution_id, "again")
    assert len(forwarder.reports) == 1
    assert daemon.stopped == ["sess-1"]


@pytest.mark.asyncio
async def test_timeout_stops_session_then_cancels_and_terminates_acp(tmp_path, acp):
    events = acp.events
    forwarder = FakeForwarder()
    manager, daemon = make_manager(
        make_config(tmp_path, SUPER_RLM_TURN_TIMEOUT_S="0.05"), events, forwarder
    )

    acp.release = asyncio.Event()
    acp.prompt_started = asyncio.Event()
    state = await manager.start(make_request(tmp_path))
    await asyncio.wait_for(state.done.wait(), timeout=3)

    assert state.timed_out is True
    assert daemon.stopped == ["sess-1"]
    assert events.index("stop_session") < events.index("acp_cancel")
    assert events.index("acp_cancel") < events.index("acp_terminate")
    assert acp.process.terminated is True
    failed = [report for report in forwarder.reports if report.state is ReportState.FAILED]
    assert len(failed) == 1
    assert failed[0].error is not None and failed[0].error.code == "timeout"


@pytest.mark.asyncio
async def test_stop_session_failure_is_recorded_as_cleanup_error(tmp_path, acp):
    events = acp.events
    forwarder = FakeForwarder()
    manager, daemon = make_manager(
        make_config(tmp_path, SUPER_RLM_TURN_TIMEOUT_S="0.05"),
        events,
        forwarder,
        stop_error=DaemonError("daemon unreachable"),
    )

    acp.release = asyncio.Event()
    acp.prompt_started = asyncio.Event()
    state = await manager.start(make_request(tmp_path))
    await asyncio.wait_for(state.done.wait(), timeout=3)

    assert state.cleanup_error is not None
    assert "stop_session" in state.cleanup_error
    assert "daemon unreachable" in state.cleanup_error
    assert acp.process.terminated is True
    failed = [report for report in forwarder.reports if report.state is ReportState.FAILED]
    assert len(failed) == 1
    assert failed[0].cleanup_error == state.cleanup_error


@pytest.mark.asyncio
async def test_cancelled_report_carries_cleanup_error_when_stop_session_fails(tmp_path, acp):
    events = acp.events
    forwarder = FakeForwarder()
    manager, _ = make_manager(
        make_config(tmp_path),
        events,
        forwarder,
        stop_error=DaemonError("daemon unreachable"),
    )

    acp.release = asyncio.Event()
    acp.prompt_started = asyncio.Event()
    state = await manager.start(make_request(tmp_path))
    await asyncio.wait_for(acp.prompt_started.wait(), timeout=2)
    await manager.cancel(state.execution_id, "user cancelled")
    await asyncio.wait_for(state.done.wait(), timeout=2)

    assert state.cleanup_error is not None
    cancelled = [report for report in forwarder.reports if report.state is ReportState.CANCELLED]
    assert len(cancelled) == 1
    assert cancelled[0].cleanup_error == state.cleanup_error
    assert "daemon unreachable" in cancelled[0].cleanup_error


@pytest.mark.asyncio
async def test_worker_shutdown_rejects_new_executions(tmp_path):
    manager, _ = make_manager(make_config(tmp_path), [], FakeForwarder())
    await manager.shutdown()
    with pytest.raises(WorkerShuttingDown):
        await manager.start(make_request(tmp_path))
