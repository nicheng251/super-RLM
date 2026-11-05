
"""Worker configuration from environment variables."""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass
from pathlib import Path


def _bool_env(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _default_bash_shell() -> str | None:
    if os.name == "nt":
        candidate = Path("C:/Program Files/Git/bin/bash.exe")
        if candidate.exists():
            return str(candidate)
    return os.environ.get("SHELL")


def _repo_root() -> Path:
    # apps/worker/src/super_rlm_worker/config.py -> repository root
    return Path(__file__).resolve().parents[4]


@dataclass(frozen=True)
class WorkerConfig:
    orchestrator_url: str
    worker_id: str
    worker_token: str
    host: str
    port: int
    max_concurrency: int
    home: Path
    prime_agent: Path
    prime_provider: str
    prime_model: str
    kernel_venv: Path
    kernel_python: Path
    bash_shell: str | None
    prepare_command: str | None
    prepare_timeout_s: float
    project_repo: str | None
    report_skill: Path
    worker_prompt: Path
    workspace_root: Path
    session_root: Path
    daemon_socket: Path
    heartbeat_interval_s: float
    start_timeout_s: float
    turn_timeout_s: float
    report_token_ttl_s: float
    callback_key: str
    assignment_heartbeat_interval_s: float

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "WorkerConfig":
        source = env or os.environ
        home = Path(source.get("SUPER_RLM_HOME", str(Path.home() / ".super-rlm" / "projects" / "default")))
        kernel_venv = Path(source.get("SUPER_RLM_KERNEL_VENV", home / "prime" / "kernel-venv"))
        kernel_python = source.get("SUPER_RLM_KERNEL_PYTHON")
        if not kernel_python:
            kernel_python = str(kernel_venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))
        prime_agent = Path(source.get(
            "SUPER_RLM_PRIME_AGENT",
            _repo_root() / "runtime" / "prime-agent" / ("prime-agent.exe" if os.name == "nt" else "prime-agent"),
        ))
        worker_id = source.get("SUPER_RLM_WORKER_ID", f"wrk_{socket.gethostname().lower()}_{os.getpid()}")
        return cls(
            orchestrator_url=source.get("SUPER_RLM_ORCHESTRATOR_URL", "http://127.0.0.1:8787").rstrip("/"),
            worker_id=worker_id,
            worker_token=source.get("SUPER_RLM_WORKER_TOKEN", "dev-worker-token"),
            host=source.get("SUPER_RLM_WORKER_HOST", "127.0.0.1"),
            port=int(source.get("SUPER_RLM_WORKER_PORT", "8080")),
            max_concurrency=max(1, int(source.get("SUPER_RLM_MAX_CONCURRENCY", "2"))),
            home=home,
            prime_agent=prime_agent,
            prime_provider=source.get("SUPER_RLM_PRIME_PROVIDER", "fake"),
            prime_model=source.get("SUPER_RLM_PRIME_MODEL", "fake-1"),
            kernel_venv=kernel_venv,
            kernel_python=Path(kernel_python),
            bash_shell=source.get("SUPER_RLM_BASH_SHELL") or _default_bash_shell(),
            prepare_command=source.get("SUPER_RLM_PREPARE_COMMAND") or None,
            prepare_timeout_s=float(source.get("SUPER_RLM_PREPARE_TIMEOUT_S", "600")),
            project_repo=source.get("SUPER_RLM_PROJECT_REPO") or None,
            report_skill=Path(source.get("SUPER_RLM_REPORT_SKILL", _repo_root() / "apps" / "worker" / "skills" / "super-rlm-report")),
            worker_prompt=Path(source.get("SUPER_RLM_WORKER_PROMPT", _repo_root() / "apps" / "worker" / "prompts" / "worker.md")),
            workspace_root=Path(source.get("SUPER_RLM_WORKSPACES", home / "workspaces")),
            session_root=Path(source.get("SUPER_RLM_PRIME_SESSIONS", home / "prime" / "sessions")),
            daemon_socket=Path(source.get("SUPER_RLM_PRIME_DAEMON", home / "prime" / "daemon" / "worker.sock")),
            heartbeat_interval_s=float(source.get("SUPER_RLM_HEARTBEAT_INTERVAL_S", "10")),
            start_timeout_s=float(source.get("SUPER_RLM_START_TIMEOUT_S", "30")),
            turn_timeout_s=float(source.get("SUPER_RLM_TURN_TIMEOUT_S", "3600")),
            report_token_ttl_s=float(source.get("SUPER_RLM_REPORT_TOKEN_TTL_S", "7200")),
            callback_key=source.get("SUPER_RLM_CALLBACK_KEY", "dev-callback-key"),
            assignment_heartbeat_interval_s=float(source.get("SUPER_RLM_ASSIGNMENT_HEARTBEAT_INTERVAL_S", "10")),
        )

    def ensure_dirs(self) -> None:
        for path in (
            self.home,
            self.workspace_root,
            self.session_root,
            self.daemon_socket.parent,
        ):
            path.mkdir(parents=True, exist_ok=True)
