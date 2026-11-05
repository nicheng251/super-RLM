
"""Worker configuration from environment variables."""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass
from pathlib import Path


def _bool_env(source: dict[str, str], name: str, default: bool = False) -> bool:
    value = source.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _choice_env(source: dict[str, str], name: str, default: str, allowed: set[str]) -> str:
    value = source.get(name, default).strip().lower()
    if value not in allowed:
        raise ValueError(f"{name} must be one of {sorted(allowed)}, got {value!r}")
    return value


LOOPBACK_HOSTS = {"127.0.0.1", "::1"}


def loopback_host(value: str) -> str:
    """Normalize and validate a listen host; only loopback addresses are allowed."""
    host = value.strip().lower()
    if not host:
        raise ValueError("SUPER_RLM_WORKER_HOST must be 127.0.0.1 or ::1")
    if host == "localhost":
        return "127.0.0.1"
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    if host not in LOOPBACK_HOSTS:
        raise ValueError(f"SUPER_RLM_WORKER_HOST must be 127.0.0.1 or ::1, got {value!r}")
    return host


TICKET_TEMP_KEYS = ("TEMP", "TMP", "PIP_CACHE_DIR", "NPM_CONFIG_CACHE", "XDG_CACHE_HOME")


def ticket_temp_dir(home: Path, ticket_id: str) -> Path:
    """Return the private scratch/cache directory for one Ticket."""
    name = ticket_id.strip()
    if (
        not name
        or name in {".", ".."}
        or "/" in name
        or "\\" in name
        or ":" in name
        or "\x00" in name
    ):
        raise ValueError(f"invalid ticket id for a temp directory: {ticket_id!r}")
    return Path(home) / "tmp" / name


def apply_ticket_temp_env(env: dict[str, str], home: Path, ticket_id: str) -> Path:
    """Point temp and package-cache variables at a per-Ticket directory."""
    directory = ticket_temp_dir(home, ticket_id)
    directory.mkdir(parents=True, exist_ok=True)
    for key in [key for key in env if key.upper() in TICKET_TEMP_KEYS]:
        del env[key]
    for key in TICKET_TEMP_KEYS:
        env[key] = str(directory)
    return directory


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
    delivery_mode: str
    delivery_collision: str
    delivery_strip_prefix: str
    delivery_workspace_subdir: str
    report_skill: Path
    worker_prompt: Path
    workspace_root: Path
    session_root: Path
    daemon_socket: str
    daemon_autostart: bool
    daemon_start_timeout_s: float
    daemon_command_timeout_s: float
    daemon_shutdown_timeout_s: float
    cancel_wait_s: float
    heartbeat_interval_s: float
    start_timeout_s: float
    turn_timeout_s: float
    metadata_timeout_s: float
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
        # Imported here so config stays importable without loading daemon.py at
        # module import time (daemon.py imports this module).
        from .daemon import canonical_socket

        daemon_socket = canonical_socket(
            source.get("SUPER_RLM_PRIME_DAEMON", home / "prime" / "daemon" / "worker.sock")
        )
        return cls(
            orchestrator_url=source.get("SUPER_RLM_ORCHESTRATOR_URL", "http://127.0.0.1:8787").rstrip("/"),
            worker_id=worker_id,
            worker_token=source.get("SUPER_RLM_WORKER_TOKEN", "dev-worker-token"),
            host=loopback_host(source.get("SUPER_RLM_WORKER_HOST", "127.0.0.1")),
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
            delivery_mode=_choice_env(source, "SUPER_RLM_DELIVERY_MODE", "artifacts", {"artifacts", "workspace", "none"}),
            delivery_collision=_choice_env(source, "SUPER_RLM_DELIVERY_COLLISION", "version", {"version", "overwrite", "error"}),
            delivery_strip_prefix=source.get("SUPER_RLM_DELIVERY_STRIP_PREFIX", ""),
            delivery_workspace_subdir=source.get("SUPER_RLM_DELIVERY_WORKSPACE_SUBDIR", ".super-rlm"),
            report_skill=Path(source.get("SUPER_RLM_REPORT_SKILL", _repo_root() / "apps" / "worker" / "skills" / "super-rlm-report")),
            worker_prompt=Path(source.get("SUPER_RLM_WORKER_PROMPT", _repo_root() / "apps" / "worker" / "prompts" / "worker.md")),
            workspace_root=Path(source.get("SUPER_RLM_WORKSPACES", home / "workspaces")),
            session_root=Path(source.get("SUPER_RLM_PRIME_SESSIONS", home / "prime" / "sessions")),
            daemon_socket=daemon_socket,
            daemon_autostart=_bool_env(source, "SUPER_RLM_DAEMON_AUTOSTART", True),
            daemon_start_timeout_s=float(source.get("SUPER_RLM_DAEMON_START_TIMEOUT_S", "30")),
            daemon_command_timeout_s=float(source.get("SUPER_RLM_DAEMON_COMMAND_TIMEOUT_S", "30")),
            daemon_shutdown_timeout_s=float(source.get("SUPER_RLM_DAEMON_SHUTDOWN_TIMEOUT_S", "60")),
            cancel_wait_s=float(source.get("SUPER_RLM_CANCEL_WAIT_S", "10")),
            heartbeat_interval_s=float(source.get("SUPER_RLM_HEARTBEAT_INTERVAL_S", "10")),
            start_timeout_s=float(source.get("SUPER_RLM_START_TIMEOUT_S", "30")),
            turn_timeout_s=float(source.get("SUPER_RLM_TURN_TIMEOUT_S", "3600")),
            metadata_timeout_s=float(source.get("SUPER_RLM_METADATA_TIMEOUT_S", "60")),
            report_token_ttl_s=float(source.get("SUPER_RLM_REPORT_TOKEN_TTL_S", "7200")),
            callback_key=source.get("SUPER_RLM_CALLBACK_KEY", "dev-callback-key"),
            assignment_heartbeat_interval_s=float(source.get("SUPER_RLM_ASSIGNMENT_HEARTBEAT_INTERVAL_S", "10")),
        )

    @property
    def daemon_socket_path(self) -> Path:
        return Path(self.daemon_socket)

    def ensure_dirs(self) -> None:
        for path in (
            self.home,
            self.workspace_root,
            self.session_root,
            self.daemon_socket_path.parent,
            self.home / "tmp",
        ):
            path.mkdir(parents=True, exist_ok=True)
