
import asyncio
import os
from pathlib import Path

import pytest

from super_rlm_worker.config import WorkerConfig
from super_rlm_worker.prime_agent import (
    build_args,
    build_env,
    discover_session_ref,
    strip_inherited_agent_env,
)


def test_strip_inherited_agent_env_removes_pi_prime_and_rlm_keys():
    env = {
        "PATH": "/bin",
        "PI_CODING_AGENT_DIR": "/global/pi",
        "PRIME_AGENT_SESSION_DIR": "/global/prime",
        "RLM_SESSION_DIR": "/global/rlm",
        "OTHER": "ok",
    }
    cleaned = strip_inherited_agent_env(env)
    assert cleaned == {"PATH": "/bin", "OTHER": "ok"}


def test_build_env_uses_project_paths(tmp_path):
    config = WorkerConfig.from_env({
        "SUPER_RLM_HOME": str(tmp_path),
        "SUPER_RLM_PRIME_AGENT": str(tmp_path / "prime-agent.exe"),
        "SUPER_RLM_KERNEL_VENV": str(tmp_path / "kernel"),
        "SUPER_RLM_KERNEL_PYTHON": str(tmp_path / "kernel" / "python.exe"),
        "SUPER_RLM_BASH_SHELL": "C:/Program Files/Git/bin/bash.exe",
    })
    env = build_env(
        config,
        workspace=tmp_path / "workspace",
        ticket_id="tkt_1",
        session_dir=tmp_path / "sessions" / "tkt_1",
        report_url="http://127.0.0.1:8080/report",
        report_token="secret",
        report_config=tmp_path / "workspace" / ".super-rlm-report.json",
    )
    assert env["PRIME_AGENT_CODING_AGENT_DIR"] == str(tmp_path / "prime" / "agent")
    assert env["PRIME_AGENT_SESSION_DIR"] == str(tmp_path / "sessions" / "tkt_1")
    assert env["PRIME_AGENT_KERNEL_VENV"] == str(tmp_path / "kernel")
    assert env["SUPER_RLM_REPORT_TOKEN"] == "secret"
    assert env["SUPER_RLM_REPORT_CONFIG"] == str(tmp_path / "workspace" / ".super-rlm-report.json")
    assert env["PRIME_AGENT_BASH_SHELL"] == "C:/Program Files/Git/bin/bash.exe"
    assert "PI_CODING_AGENT_DIR" not in env


def test_build_args_adds_resume_and_report_skill(tmp_path):
    config = WorkerConfig.from_env({
        "SUPER_RLM_HOME": str(tmp_path),
        "SUPER_RLM_PRIME_AGENT": str(tmp_path / "prime-agent.exe"),
        "SUPER_RLM_KERNEL_VENV": str(tmp_path / "kernel"),
        "SUPER_RLM_REPORT_SKILL": str(tmp_path / "skill"),
        "SUPER_RLM_WORKER_PROMPT": str(tmp_path / "worker.md"),
    })
    args = build_args(
        config,
        workspace=tmp_path / "workspace",
        session_dir=tmp_path / "sessions" / "tkt_1",
        session_ref=str(tmp_path / "sessions" / "tkt_1" / "s.jsonl"),
    )
    assert "--skill" in args
    assert "--no-skills" in args
    assert "--resume" in args
    assert args[args.index("--mode") + 1] == "acp"


@pytest.mark.asyncio
async def test_discover_session_ref_returns_newest_file(tmp_path):
    session_dir = tmp_path / "sessions"
    session_dir.mkdir()
    first = session_dir / "first.jsonl"
    second = session_dir / "second.jsonl"
    first.write_text("{}", encoding="utf-8")
    second.write_text("{}", encoding="utf-8")
    os.utime(first, (1, 1))
    os.utime(second, (2, 2))
    assert await discover_session_ref(session_dir, timeout_s=1) == str(second)
