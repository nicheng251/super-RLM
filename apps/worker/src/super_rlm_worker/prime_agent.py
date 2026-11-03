
"""Prime Agent process construction and project-local environment isolation."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from .config import WorkerConfig


def strip_inherited_agent_env(env: dict[str, str]) -> dict[str, str]:
    return {
        key: value
        for key, value in env.items()
        if not key.startswith(("PI_", "PRIME_AGENT_", "RLM_"))
    }


def build_env(
    config: WorkerConfig,
    workspace: Path,
    ticket_id: str,
    session_dir: Path,
    report_url: str,
    report_token: str,
) -> dict[str, str]:
    env = strip_inherited_agent_env(dict(os.environ))
    env.update({
        "PRIME_AGENT_CODING_AGENT_DIR": str(config.home / "prime" / "agent"),
        "PRIME_AGENT_CODING_AGENT_SESSION_DIR": str(session_dir),
        "PRIME_AGENT_SESSION_DIR": str(session_dir),
        "PRIME_AGENT_DAEMON_SOCKET": str(config.daemon_socket),
        "PRIME_AGENT_KERNEL_VENV": str(config.kernel_venv),
        "PRIME_AGENT_KERNEL_PYTHON": str(config.kernel_python),
        "PRIME_AGENT_TELEMETRY": "0",
        "DO_NOT_TRACK": "1",
        "RLM_SESSION_DIR": str(session_dir),
        "RLM_HARNESS_STATE_DIR": str(config.home / "prime" / "harness" / ticket_id),
        "SUPER_RLM_REPORT_URL": report_url,
        "SUPER_RLM_REPORT_TOKEN": report_token,
    })
    if config.bash_shell:
        env["PRIME_AGENT_BASH_SHELL"] = config.bash_shell
    return env


def build_args(
    config: WorkerConfig,
    workspace: Path,
    session_dir: Path,
    session_ref: str | None,
) -> list[str]:
    args = [
        "--mode", "acp",
        "--cwd", str(workspace),
        "--provider", config.prime_provider,
        "--model", config.prime_model,
        "--session-dir", str(session_dir),
        "--daemon-socket", str(config.daemon_socket),
        "--skill", str(config.report_skill),
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--no-themes",
    ]
    if config.worker_prompt.exists():
        args += ["--append-system-prompt", str(config.worker_prompt)]
    if session_ref:
        args += ["--resume", session_ref]
    return args


def session_dir_for(config: WorkerConfig, ticket_id: str) -> Path:
    return config.session_root / ticket_id


async def discover_session_ref(session_dir: Path, timeout_s: float = 10.0) -> str | None:
    """Return the newest persisted session file in a per-Ticket session dir.

    Prime Agent's ACP session id is not the durable session id. The session
    file is the durable ref used by ``--resume``.
    """
    session_dir.mkdir(parents=True, exist_ok=True)
    deadline = asyncio.get_running_loop().time() + timeout_s
    while True:
        files = sorted(session_dir.glob("*.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True)
        if files:
            return str(files[0])
        if asyncio.get_running_loop().time() >= deadline:
            return None
        await asyncio.sleep(0.1)
