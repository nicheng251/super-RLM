import asyncio
import dataclasses
import json
import os
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from super_rlm_protocol import (
    Artifact,
    DeliveryOptions as ProtocolDelivery,
    ExecutionOptions,
    ExecutionRequest,
    ReportAck,
    ReportState,
    SkillReport,
    WorkspaceOptions,
)
from super_rlm_worker import executor as executor_module
from super_rlm_worker.blocked import BLOCKED_BIN_DIR, install_blocked_shims
from super_rlm_worker.config import WorkerConfig
from super_rlm_worker.delivery import DeliveryOptions, deliver_artifacts
from super_rlm_worker.execution_profile import (
    ExecutionConfigError,
    ExecutionPlan,
    normalize_artifacts,
    resolve_agent_cwd,
)
from super_rlm_worker.executor import ExecutionManager, ExecutionState
from super_rlm_worker.metadata import collect_workspace_metadata
from super_rlm_worker.prepare import (
    MARKER_NAME,
    PrepareError,
    prepare_workspace,
    shell_invocation,
)
from super_rlm_worker.prime_agent import build_args, build_env
from super_rlm_worker.prime_agent import prepend_path


def make_config(tmp_path: Path, **env: str) -> WorkerConfig:
    values = {
        "SUPER_RLM_HOME": str(tmp_path / "home"),
        "SUPER_RLM_PRIME_AGENT": str(tmp_path / "prime-agent.exe"),
        "SUPER_RLM_KERNEL_VENV": str(tmp_path / "kernel"),
    }
    values.update(env)
    return WorkerConfig.from_env(values)


def require_shell(config: WorkerConfig) -> str:
    try:
        argv = shell_invocation(config, "true")
    except PrepareError as exc:
        pytest.skip(str(exc))
    return argv[0]


def request_with_execution(
    tmp_path: Path,
    *,
    profile: str = "git",
    provider: str = "deepseek",
    model: str = "deepseek-flash",
    thinking: str = "high",
    timeout_s: int = 120,
    prepare_command: str | None = "echo prepared",
    blocked: list[str] | None = None,
    agent_cwd: str = "repo",
    artifact_root: str = ".",
    metadata_command: str | None = None,
    delivery: ProtocolDelivery | None = None,
) -> ExecutionRequest:
    return ExecutionRequest(
        ticket_id="tkt_profile",
        assignment_id="asg_profile",
        prompt="do the work",
        profile=profile,
        workspace=str(tmp_path / "workspace"),
        execution=ExecutionOptions(
            provider=provider,
            model=model,
            thinking=thinking,
            timeout_s=timeout_s,
            prepare_command=prepare_command,
            blocked_commands=blocked or ["npm", "pnpm"],
            workspace=WorkspaceOptions(
                agent_cwd=agent_cwd,
                artifact_root=artifact_root,
                metadata_command=metadata_command,
            ),
            delivery=delivery
            or ProtocolDelivery(
                mode="none", collision="error", strip_prefix="repo", workspace_subdir="out"
            ),
        ),
    )


def test_plan_uses_execution_options(tmp_path: Path) -> None:
    config = make_config(tmp_path)
    plan = ExecutionPlan.resolve(request_with_execution(tmp_path), config)

    assert plan.profile == "git"
    assert plan.provider == "deepseek"
    assert plan.model == "deepseek-flash"
    assert plan.thinking == "high"
    assert plan.timeout_s == 120
    assert plan.prepare_command == "echo prepared"
    assert plan.blocked_commands == ("npm", "pnpm")
    assert plan.agent_cwd == "repo"
    assert plan.artifact_root == "."
    assert plan.delivery == DeliveryOptions("none", "error", "repo", "out")


def test_plan_falls_back_to_worker_config(tmp_path: Path) -> None:
    config = make_config(
        tmp_path,
        SUPER_RLM_PRIME_PROVIDER="fallback-provider",
        SUPER_RLM_PRIME_MODEL="fallback-model",
        SUPER_RLM_PREPARE_COMMAND="echo global",
        SUPER_RLM_TURN_TIMEOUT_S="1800",
        SUPER_RLM_DELIVERY_MODE="workspace",
        SUPER_RLM_DELIVERY_COLLISION="overwrite",
        SUPER_RLM_DELIVERY_STRIP_PREFIX="global-prefix",
        SUPER_RLM_DELIVERY_WORKSPACE_SUBDIR=".deliveries",
    )
    request = ExecutionRequest(
        ticket_id="tkt", assignment_id="asg", prompt="p", workspace=str(tmp_path / "ws")
    )

    plan = ExecutionPlan.resolve(request, config)

    assert plan.profile == "default"
    assert plan.provider == "fallback-provider"
    assert plan.model == "fallback-model"
    assert plan.thinking is None
    assert plan.timeout_s == 1800
    assert plan.prepare_command == "echo global"
    assert plan.agent_cwd == "."
    assert plan.artifact_root == "."
    assert plan.delivery == DeliveryOptions("workspace", "overwrite", "global-prefix", ".deliveries")


@pytest.mark.parametrize(
    "execution, message",
    [
        (SimpleNamespace(thinking="ultra"), "thinking must be one of"),
        (SimpleNamespace(blocked_commands=["bad name"]), "invalid blocked command"),
        (SimpleNamespace(workspace={"agent_cwd": "../escape"}), "must not contain"),
        (SimpleNamespace(workspace={"agent_cwd": "C:/absolute"}), "must be relative"),
        (SimpleNamespace(timeout_s=0), "timeout_s must be positive"),
        (SimpleNamespace(delivery={"mode": "everywhere"}), "delivery mode"),
    ],
)
def test_plan_rejects_invalid_options(tmp_path: Path, execution, message: str) -> None:
    config = make_config(tmp_path)
    request = SimpleNamespace(profile="bad", execution=execution)

    with pytest.raises(ExecutionConfigError, match=message):
        ExecutionPlan.resolve(request, config)


def test_build_args_uses_profile_model_and_thinking(tmp_path: Path) -> None:
    config = make_config(tmp_path)
    args = build_args(
        config,
        workspace=tmp_path,
        session_dir=tmp_path / "sessions",
        session_ref=None,
        provider="deepseek",
        model="deepseek-flash",
        thinking="high",
        system_prompt_note="Execution profile: git",
    )
    assert args[args.index("--provider") + 1] == "deepseek"
    assert args[args.index("--model") + 1] == "deepseek-flash"
    assert args[args.index("--thinking") + 1] == "high"
    notes = [args[index + 1] for index, value in enumerate(args) if value == "--append-system-prompt"]
    assert "Execution profile: git" in notes


def test_build_env_prepends_blocked_bin_to_path(tmp_path: Path) -> None:
    config = make_config(tmp_path)
    blocked_bin = tmp_path / "workspace" / BLOCKED_BIN_DIR
    env = build_env(
        config,
        tmp_path / "workspace",
        "tkt",
        tmp_path / "sessions",
        "http://127.0.0.1/report",
        "token",
        tmp_path / "workspace" / ".super-rlm-report.json",
        blocked_bin=blocked_bin,
    )
    path_key = next(key for key in env if key.upper() == "PATH")
    assert env[path_key].split(os.pathsep)[0] == str(blocked_bin)


def test_prepend_path_preserves_existing_key_case(tmp_path: Path) -> None:
    env = {"Path": "/bin"}
    blocked = tmp_path / "blocked"
    prepend_path(env, blocked)
    assert env == {"Path": str(blocked) + os.pathsep + "/bin"}


def test_install_blocked_shims_exit_127(tmp_path: Path) -> None:
    config = make_config(tmp_path)
    shell = require_shell(config)
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    bin_dir = install_blocked_shims(workspace, ["npm", "pnpm"])

    assert bin_dir == workspace / BLOCKED_BIN_DIR
    assert (bin_dir / "npm").exists()
    completed = subprocess.run(
        [shell, (bin_dir / "npm").as_posix()], capture_output=True, text=True
    )
    assert completed.returncode == 127
    assert "blocked by super-rlm profile: npm" in completed.stderr

    assert install_blocked_shims(workspace, []) is None
    assert not bin_dir.exists()


def test_resolve_agent_cwd_validates_and_requires_directory(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    (workspace / "repo").mkdir(parents=True)

    assert resolve_agent_cwd(workspace, "repo") == (workspace / "repo").resolve()
    assert resolve_agent_cwd(workspace, ".") == workspace.resolve()
    with pytest.raises(ExecutionConfigError, match="does not exist"):
        resolve_agent_cwd(workspace, "missing")
    with pytest.raises(ExecutionConfigError, match="must not contain"):
        resolve_agent_cwd(workspace, "../escape")
    with pytest.raises(ExecutionConfigError, match="must be relative"):
        resolve_agent_cwd(workspace, str(tmp_path))


def test_normalize_artifacts_uses_artifact_root_without_double_prefix(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    (workspace / "repo").mkdir(parents=True)
    artifacts = [Artifact(path="hello.txt"), Artifact(path="repo/other.txt")]

    normalized = normalize_artifacts(workspace, "repo", artifacts)

    assert [artifact.path for artifact in normalized] == ["repo/hello.txt", "repo/other.txt"]


def test_normalize_artifacts_keeps_invalid_paths_for_delivery_to_reject(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    artifacts = [Artifact(path="../escape.txt")]

    normalized = normalize_artifacts(workspace, ".", artifacts)

    assert normalized[0].path == "../escape.txt"


@pytest.mark.asyncio
async def test_metadata_command_parses_json_and_reports_errors(tmp_path: Path) -> None:
    config = make_config(tmp_path)
    require_shell(config)
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    assert await collect_workspace_metadata(
        config, workspace, workspace, command="echo '{\"vcs\":\"none\"}'", ticket_id="t", assignment_id="a"
    ) == ({"vcs": "none"}, None)

    data, error = await collect_workspace_metadata(
        config, workspace, workspace, command="echo not-json", ticket_id="t", assignment_id="a"
    )
    assert data is None and error is not None and "not valid JSON" in error

    data, error = await collect_workspace_metadata(
        config, workspace, workspace, command="exit 3", ticket_id="t", assignment_id="a"
    )
    assert data is None and error is not None and "exited with code 3" in error

    assert await collect_workspace_metadata(
        config, workspace, workspace, command=None, ticket_id="t", assignment_id="a"
    ) == (None, None)


@pytest.mark.asyncio
async def test_prepare_command_override_and_marker_profile(tmp_path: Path) -> None:
    config = make_config(tmp_path, SUPER_RLM_PREPARE_COMMAND="echo global > global.txt")
    require_shell(config)
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    payload = await prepare_workspace(
        config,
        workspace,
        "tkt",
        "asg",
        prepare_command="echo profile > profile.txt",
        profile="git",
    )

    assert (workspace / "profile.txt").exists()
    assert not (workspace / "global.txt").exists()
    marker = json.loads((workspace / MARKER_NAME).read_text(encoding="utf-8"))
    assert marker == payload
    assert marker["profile"] == "git"
    assert marker["command"] == "echo profile > profile.txt"


def test_delivery_options_override_global_config(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    origin = tmp_path / "origin"
    workspace.mkdir()
    origin.mkdir()
    (workspace / "out.txt").write_text("new", encoding="utf-8")
    config = make_config(tmp_path, SUPER_RLM_DELIVERY_MODE="none")

    skipped = deliver_artifacts(
        workspace,
        str(origin),
        [Artifact(path="out.txt")],
        config,
        "tkt",
        options=DeliveryOptions("artifacts", "overwrite", "", ".deliveries"),
    )
    assert skipped.error is None
    assert (origin / "out.txt").read_text(encoding="utf-8") == "new"

    delivered = deliver_artifacts(
        workspace,
        str(origin),
        [],
        config,
        "tkt",
        options=DeliveryOptions("workspace", "version", "", "custom"),
    )
    assert delivered.error is None
    assert (origin / "custom" / "tkt" / "out.txt").exists()


class FakeForwarder:
    def __init__(self) -> None:
        self.reports = []

    async def forward(self, report):
        self.reports.append(report)
        return ReportAck(accepted=True)


@pytest.mark.asyncio
async def test_record_report_normalizes_artifacts_metadata_and_delivery(tmp_path: Path) -> None:
    config = make_config(tmp_path)
    require_shell(config)
    workspace = tmp_path / "workspace"
    origin = tmp_path / "origin"
    (workspace / "repo").mkdir(parents=True)
    (workspace / "repo" / "hello.txt").write_text("hello", encoding="utf-8")
    origin.mkdir()

    state = ExecutionState(
        execution_id="exe_1",
        ticket_id="tkt_1",
        assignment_id="asg_1",
        prompt="prompt",
        profile="git",
        workspace=workspace,
        session_dir=tmp_path / "sessions",
        report_token="token",
        report_url="http://127.0.0.1/report",
        report_config=workspace / ".super-rlm-report.json",
        origin_cwd=str(origin),
    )
    state.plan = dataclasses.replace(
        ExecutionPlan.from_config(config),
        artifact_root="repo",
        metadata_command="echo '{\"vcs\":\"git\",\"commit\":\"abc\"}'",
    )
    manager = ExecutionManager(config, FakeForwarder())
    manager._by_assignment[state.assignment_id] = state
    manager._by_execution[state.execution_id] = state

    ack = await manager.record_report(
        "asg_1",
        "token",
        SkillReport(
            state=ReportState.COMPLETED,
            summary="done",
            result="ok",
            artifacts=[Artifact(path="hello.txt")],
        ),
    )

    assert ack.accepted is True
    forwarded = manager.forwarder.reports[0]
    assert forwarded.artifacts[0].path == "repo/hello.txt"
    assert forwarded.workspace_metadata == {"vcs": "git", "commit": "abc"}
    assert forwarded.metadata_error is None
    assert (origin / "repo" / "hello.txt").exists()


@pytest.mark.asyncio
async def test_metadata_error_does_not_fail_completed_ticket(tmp_path: Path) -> None:
    config = make_config(tmp_path)
    require_shell(config)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
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
    )
    state.plan = dataclasses.replace(
        ExecutionPlan.from_config(config), metadata_command="echo not-json"
    )
    manager = ExecutionManager(config, FakeForwarder())
    manager._by_assignment[state.assignment_id] = state
    manager._by_execution[state.execution_id] = state

    await manager.record_report(
        "asg_1",
        "token",
        SkillReport(state=ReportState.COMPLETED, summary="done", result="ok"),
    )

    forwarded = manager.forwarder.reports[0]
    assert forwarded.state is ReportState.COMPLETED
    assert forwarded.workspace_metadata is None
    assert forwarded.metadata_error is not None and "not valid JSON" in forwarded.metadata_error


@pytest.mark.asyncio
async def test_execution_uses_plan_for_cwd_model_timeout_and_shims(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = make_config(tmp_path)
    workspace = config.workspace_root / "tkt_profile"
    (workspace / "repo").mkdir(parents=True)

    recorded = {}
    prompts: list[str] = []
    timeouts: list[float] = []

    @asynccontextmanager
    async def fake_open(*args, **kwargs):
        recorded.update(kwargs)
        yield object(), object(), object()

    async def fake_initialize(connection):
        return None

    async def fake_new_session(connection, cwd):
        recorded["new_session_cwd"] = cwd
        return "session-1"

    async def fake_prompt(connection, session_id, text):
        prompts.append(text)
        return None

    async def fake_discover(session_dir, timeout_s=10.0):
        return None

    real_wait_for = asyncio.wait_for

    async def recording_wait_for(awaitable, timeout):
        timeouts.append(timeout)
        return await real_wait_for(awaitable, timeout=timeout)

    monkeypatch.setattr(executor_module.acp_client, "open_prime_agent", fake_open)
    monkeypatch.setattr(executor_module.acp_client, "initialize", fake_initialize)
    monkeypatch.setattr(executor_module.acp_client, "new_session", fake_new_session)
    monkeypatch.setattr(executor_module.acp_client, "prompt", fake_prompt)
    monkeypatch.setattr(executor_module, "discover_session_ref", fake_discover)
    monkeypatch.setattr(asyncio, "wait_for", recording_wait_for)

    request = request_with_execution(
        tmp_path,
        timeout_s=90,
        prepare_command=None,
        blocked=["npm"],
        metadata_command="echo '{}'",
    )
    manager = ExecutionManager(config, FakeForwarder())

    state = await manager.start(request)
    await state.done.wait()

    assert state.terminal_report is not None
    assert recorded["provider"] == "deepseek"
    assert recorded["model"] == "deepseek-flash"
    assert recorded["thinking"] == "high"
    assert recorded["agent_cwd"] == (workspace / "repo").resolve()
    assert recorded["blocked_bin"] == workspace / BLOCKED_BIN_DIR
    assert (workspace / BLOCKED_BIN_DIR / "npm").exists()
    assert recorded["new_session_cwd"] == (workspace / "repo").resolve()
    assert "Execution profile: git" in recorded["system_prompt_note"]
    assert "Blocked commands: npm" in recorded["system_prompt_note"]
    assert prompts[0] == "do the work"
    assert timeouts and all(timeout == 90 for timeout in timeouts)
