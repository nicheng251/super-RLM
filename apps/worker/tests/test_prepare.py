import asyncio
import json

import pytest

from super_rlm_protocol import ExecutionRequest, ReportAck
from super_rlm_worker.config import WorkerConfig
from super_rlm_worker.executor import ExecutionManager
from super_rlm_worker.prepare import (
    MARKER_NAME,
    PrepareError,
    build_prepare_env,
    prepare_workspace,
    shell_invocation,
)

PREPARE_COMMAND = (
    "printf '%s\\n' "
    '"$SUPER_RLM_HOME" "$SUPER_RLM_TICKET_ID" "$SUPER_RLM_ASSIGNMENT_ID" '
    '"$SUPER_RLM_WORKSPACE" "$SUPER_RLM_PROJECT_REPO" "$SUPER_RLM_PREPARE_COMMAND" '
    "> env.txt"
)


def make_config(tmp_path, prepare_command=None, prepare_timeout_s=None):
    env = {
        "SUPER_RLM_HOME": str(tmp_path / "home"),
        "SUPER_RLM_PRIME_AGENT": str(tmp_path / "prime-agent.exe"),
        "SUPER_RLM_KERNEL_VENV": str(tmp_path / "kernel"),
        "SUPER_RLM_WORKER_ID": "wrk_test",
        "SUPER_RLM_WORKER_TOKEN": "test-worker-token",
        "SUPER_RLM_CALLBACK_KEY": "test-callback-key",
        "SUPER_RLM_PROJECT_REPO": str(tmp_path / "repo"),
    }
    if prepare_command is not None:
        env["SUPER_RLM_PREPARE_COMMAND"] = prepare_command
    if prepare_timeout_s is not None:
        env["SUPER_RLM_PREPARE_TIMEOUT_S"] = str(prepare_timeout_s)
    return WorkerConfig.from_env(env)


def require_shell(config):
    try:
        shell_invocation(config, "true")
    except PrepareError as exc:
        pytest.skip(str(exc))


class FakeForwarder:
    def __init__(self):
        self.reports = []

    async def forward(self, report):
        self.reports.append(report)
        return ReportAck(accepted=True)


def test_prepare_config_defaults(tmp_path):
    config = make_config(tmp_path)
    assert config.prepare_command is None
    assert config.prepare_timeout_s == 600
    assert config.project_repo == str(tmp_path / "repo")


@pytest.mark.asyncio
async def test_prepare_writes_marker_and_receives_env(tmp_path):
    config = make_config(tmp_path, prepare_command=PREPARE_COMMAND)
    require_shell(config)
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    payload = await prepare_workspace(config, workspace, "tkt_1", "asg_1")

    marker = json.loads((workspace / MARKER_NAME).read_text(encoding="utf-8"))
    assert marker == payload
    assert marker["ticket_id"] == "tkt_1"
    assert marker["command"] == PREPARE_COMMAND
    assert marker["prepared_at"]

    values = (workspace / "env.txt").read_text(encoding="utf-8").splitlines()
    assert values == [
        str(config.home),
        "tkt_1",
        "asg_1",
        str(workspace),
        str(tmp_path / "repo"),
        PREPARE_COMMAND,
    ]


@pytest.mark.asyncio
async def test_prepare_failure_fails_ticket_without_marker(tmp_path):
    config = make_config(tmp_path, prepare_command="echo boom >&2; exit 3")
    require_shell(config)
    forwarder = FakeForwarder()
    manager = ExecutionManager(config, forwarder)
    workspace = config.workspace_root / "tkt_fail"

    state = await manager.start(ExecutionRequest(
        ticket_id="tkt_fail",
        assignment_id="asg_fail",
        prompt="do it",
        profile="default",
        workspace=str(workspace),
    ))
    await asyncio.wait_for(state.done.wait(), timeout=30)

    assert state.session_ref is None
    assert state.process is None
    assert state.terminal_report is not None
    assert state.terminal_report.state.value == "failed"
    assert state.terminal_report.error.code == "prepare_failed"
    assert "boom" in state.terminal_report.error.message
    assert not (workspace / MARKER_NAME).exists()
    assert forwarder.reports[-1].state.value == "failed"
    assert forwarder.reports[-1].error.code == "prepare_failed"


@pytest.mark.asyncio
async def test_existing_marker_skips_preparation(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    payload = {
        "ticket_id": "tkt_1",
        "prepared_at": "2026-01-01T00:00:00+00:00",
        "command": "older command",
    }
    (workspace / MARKER_NAME).write_text(json.dumps(payload), encoding="utf-8")
    config = make_config(tmp_path, prepare_command="echo ran > ran.txt; exit 7")
    require_shell(config)

    result = await prepare_workspace(config, workspace, "tkt_1", "asg_1")

    assert result == payload
    assert not (workspace / "ran.txt").exists()


@pytest.mark.asyncio
async def test_prepare_timeout_raises_without_marker(tmp_path):
    config = make_config(tmp_path, prepare_command="sleep 5", prepare_timeout_s=0.2)
    require_shell(config)
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with pytest.raises(PrepareError, match="timed out"):
        await prepare_workspace(config, workspace, "tkt_1", "asg_1")

    assert not (workspace / MARKER_NAME).exists()


@pytest.mark.asyncio
async def test_prepare_cancellation_kills_the_shell(tmp_path):
    config = make_config(tmp_path, prepare_command="sleep 5")
    require_shell(config)
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    task = asyncio.create_task(prepare_workspace(config, workspace, "tkt_1", "asg_1"))
    await asyncio.sleep(0.3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert not (workspace / MARKER_NAME).exists()


def test_build_prepare_env_inherits_process_env(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPER_RLM_PREPARE_TEST_INHERITED", "yes")
    config = make_config(tmp_path)
    env = build_prepare_env(config, tmp_path / "workspace", "tkt_1", "asg_1")
    assert env["SUPER_RLM_PREPARE_TEST_INHERITED"] == "yes"
    assert env["SUPER_RLM_HOME"] == str(tmp_path / "home")
    assert env["SUPER_RLM_TICKET_ID"] == "tkt_1"
    assert env["SUPER_RLM_ASSIGNMENT_ID"] == "asg_1"
    assert env["SUPER_RLM_WORKSPACE"] == str(tmp_path / "workspace")
    assert env["SUPER_RLM_PROJECT_REPO"] == str(tmp_path / "repo")
    assert env["SUPER_RLM_PREPARE_COMMAND"] == ""
