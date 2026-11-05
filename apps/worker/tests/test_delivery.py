from pathlib import Path

import pytest

from super_rlm_protocol import Artifact, ReportAck, ReportState, SkillReport, WorkerReport
from super_rlm_worker.config import WorkerConfig
from super_rlm_worker.delivery import deliver_artifacts
from super_rlm_worker.executor import ExecutionManager, ExecutionState


def make_config(tmp_path: Path, **env: str) -> WorkerConfig:
    values = {
        "SUPER_RLM_HOME": str(tmp_path / "home"),
        "SUPER_RLM_PRIME_AGENT": str(tmp_path / "prime-agent.exe"),
        "SUPER_RLM_KERNEL_VENV": str(tmp_path / "kernel"),
    }
    values.update(env)
    return WorkerConfig.from_env(values)


@pytest.fixture
def config(tmp_path: Path) -> WorkerConfig:
    return make_config(tmp_path)


@pytest.fixture
def dirs(tmp_path: Path) -> tuple[Path, Path]:
    workspace = tmp_path / "workspace"
    origin = tmp_path / "origin"
    workspace.mkdir()
    origin.mkdir()
    return workspace, origin


def test_copies_one_artifact(config: WorkerConfig, dirs: tuple[Path, Path]) -> None:
    workspace, origin = dirs
    (workspace / "out.txt").write_text("hello", encoding="utf-8")

    result = deliver_artifacts(workspace, str(origin), [Artifact(path="out.txt")], config, "tkt_1")

    assert result.error is None
    assert (origin / "out.txt").read_text(encoding="utf-8") == "hello"
    assert result.delivered_to == [str((origin / "out.txt").resolve())]


def test_strips_configured_path_prefix(tmp_path: Path, dirs: tuple[Path, Path]) -> None:
    workspace, origin = dirs
    (workspace / "repo").mkdir()
    (workspace / "repo" / "hello.txt").write_text("hello", encoding="utf-8")
    config = make_config(tmp_path, SUPER_RLM_DELIVERY_STRIP_PREFIX="repo")

    result = deliver_artifacts(
        workspace, str(origin), [Artifact(path="repo/hello.txt")], config, "tkt_1"
    )

    assert result.error is None
    assert (origin / "hello.txt").exists()
    assert not (origin / "repo").exists()


def test_version_collision_keeps_both_files(config: WorkerConfig, dirs: tuple[Path, Path]) -> None:
    workspace, origin = dirs
    (workspace / "out.txt").write_text("new", encoding="utf-8")
    (origin / "out.txt").write_text("old", encoding="utf-8")

    result = deliver_artifacts(workspace, str(origin), [Artifact(path="out.txt")], config, "tkt_1")

    assert result.error is None
    assert (origin / "out.txt").read_text(encoding="utf-8") == "old"
    assert (origin / "out.super-rlm-tkt_1.txt").read_text(encoding="utf-8") == "new"


def test_overwrite_collision_replaces_file(tmp_path: Path, dirs: tuple[Path, Path]) -> None:
    workspace, origin = dirs
    (workspace / "out.txt").write_text("new", encoding="utf-8")
    (origin / "out.txt").write_text("old", encoding="utf-8")
    config = make_config(tmp_path, SUPER_RLM_DELIVERY_COLLISION="overwrite")

    result = deliver_artifacts(workspace, str(origin), [Artifact(path="out.txt")], config, "tkt_1")

    assert result.error is None
    assert (origin / "out.txt").read_text(encoding="utf-8") == "new"


def test_error_collision_reports_failure(tmp_path: Path, dirs: tuple[Path, Path]) -> None:
    workspace, origin = dirs
    (workspace / "out.txt").write_text("new", encoding="utf-8")
    (origin / "out.txt").write_text("old", encoding="utf-8")
    config = make_config(tmp_path, SUPER_RLM_DELIVERY_COLLISION="error")

    result = deliver_artifacts(workspace, str(origin), [Artifact(path="out.txt")], config, "tkt_1")

    assert result.delivered_to == []
    assert result.error is not None and "already exists" in result.error
    assert (origin / "out.txt").read_text(encoding="utf-8") == "old"


def test_rejects_traversal_and_absolute_artifacts(config: WorkerConfig, dirs: tuple[Path, Path]) -> None:
    workspace, origin = dirs
    (workspace / "out.txt").write_text("hello", encoding="utf-8")

    traversal = deliver_artifacts(
        workspace, str(origin), [Artifact(path="../escape.txt")], config, "tkt_1"
    )
    absolute = deliver_artifacts(
        workspace, str(origin), [Artifact(path=str(origin / "abs.txt"))], config, "tkt_1"
    )

    assert traversal.delivered_to == [] and traversal.error
    assert absolute.delivered_to == [] and absolute.error
    assert not (origin.parent / "escape.txt").exists()
    assert not (origin / "abs.txt").exists()


def test_missing_origin_is_noop(config: WorkerConfig, dirs: tuple[Path, Path]) -> None:
    workspace, _ = dirs
    (workspace / "out.txt").write_text("hello", encoding="utf-8")

    result = deliver_artifacts(workspace, None, [Artifact(path="out.txt")], config, "tkt_1")

    assert result.delivered_to == []
    assert result.error is None


def test_workspace_mode_excludes_markers_and_git(
    tmp_path: Path, dirs: tuple[Path, Path]
) -> None:
    workspace, origin = dirs
    (workspace / "repo").mkdir()
    (workspace / "repo" / "hello.txt").write_text("hello", encoding="utf-8")
    (workspace / ".git").mkdir()
    (workspace / ".git" / "config").write_text("git", encoding="utf-8")
    (workspace / ".super-rlm-report.json").write_text("{}", encoding="utf-8")
    (workspace / ".super-rlm-prepared").write_text("{}", encoding="utf-8")
    (workspace / ".super-rlm-bin").mkdir()
    (workspace / ".super-rlm-bin" / "npm").write_text("shim", encoding="utf-8")
    config = make_config(tmp_path, SUPER_RLM_DELIVERY_MODE="workspace")

    result = deliver_artifacts(workspace, str(origin), [], config, "tkt_1")

    destination = origin / ".super-rlm" / "tkt_1"
    assert result.error is None
    assert result.delivered_to == [str(destination)]
    assert (destination / "repo" / "hello.txt").exists()
    assert not (destination / ".git").exists()
    assert not (destination / ".super-rlm-report.json").exists()
    assert not (destination / ".super-rlm-prepared").exists()
    assert not (destination / ".super-rlm-bin").exists()


class FakeForwarder:
    def __init__(self) -> None:
        self.reports: list[WorkerReport] = []

    async def forward(self, report: WorkerReport) -> ReportAck:
        self.reports.append(report)
        return ReportAck(accepted=True)


@pytest.mark.asyncio
async def test_record_report_delivers_and_attaches_fields(
    tmp_path: Path, dirs: tuple[Path, Path]
) -> None:
    workspace, origin = dirs
    (workspace / "out.txt").write_text("hello", encoding="utf-8")
    config = make_config(tmp_path)
    forwarder = FakeForwarder()
    manager = ExecutionManager(config, forwarder)
    state = ExecutionState(
        execution_id="exe_1",
        ticket_id="tkt_1",
        assignment_id="asg_1",
        prompt="prompt",
        profile="default",
        workspace=workspace,
        session_dir=tmp_path / "sessions",
        report_token="token",
        report_url="http://127.0.0.1/report",
        report_config=workspace / ".super-rlm-report.json",
        origin_cwd=str(origin),
    )
    manager._by_assignment[state.assignment_id] = state
    manager._by_execution[state.execution_id] = state
    report = SkillReport(
        state=ReportState.COMPLETED,
        summary="done",
        result="ok",
        artifacts=[Artifact(path="out.txt")],
    )

    ack = await manager.record_report("asg_1", "token", report)

    assert ack.accepted is True
    assert (origin / "out.txt").exists()
    forwarded = forwarder.reports[0]
    assert forwarded.delivered_to == [str((origin / "out.txt").resolve())]
    assert forwarded.delivery_error is None
