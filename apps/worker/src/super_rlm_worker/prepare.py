"""One-time workspace preparation before Prime Agent starts."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import shutil
import signal
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import WorkerConfig, apply_ticket_temp_env
from .redact import redact_secrets

LOG = logging.getLogger("super_rlm_worker.prepare")

MARKER_NAME = ".super-rlm-prepared"
_WINDOWS_BASH_PATHS = (
    Path("C:/Program Files/Git/bin/bash.exe"),
    Path("C:/Program Files/Git/usr/bin/bash.exe"),
    Path("C:/Program Files (x86)/Git/bin/bash.exe"),
)


class PrepareError(RuntimeError):
    """Workspace preparation failed; the Ticket must not start Prime Agent."""


def marker_path(workspace: Path) -> Path:
    return workspace / MARKER_NAME


def read_marker(workspace: Path) -> dict[str, Any] | None:
    path = marker_path(workspace)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def build_prepare_env(
    config: WorkerConfig,
    workspace: Path,
    ticket_id: str,
    assignment_id: str,
) -> dict[str, str]:
    env = dict(os.environ)
    apply_ticket_temp_env(env, config.home, ticket_id)
    env.update({
        "SUPER_RLM_HOME": str(config.home),
        "SUPER_RLM_TICKET_ID": ticket_id,
        "SUPER_RLM_ASSIGNMENT_ID": assignment_id,
        "SUPER_RLM_WORKSPACE": str(workspace),
        "SUPER_RLM_PROJECT_REPO": config.project_repo or "",
        "SUPER_RLM_PREPARE_COMMAND": config.prepare_command or "",
    })
    return env


def _find_bash() -> str | None:
    if os.name != "nt":
        return shutil.which("bash")
    for candidate in _WINDOWS_BASH_PATHS:
        if candidate.exists():
            return str(candidate)
    for name in ("bash.exe", "bash"):
        found = shutil.which(name)
        if found and "system32" not in str(Path(found).resolve()).lower():
            return found
    return None


def shell_invocation(config: WorkerConfig, command: str) -> list[str]:
    """Build the argv for a shell command, preferring bash with ``-lc``."""
    shell = config.bash_shell
    if not shell:
        shell = _find_bash()
    if shell:
        name = Path(shell).name.lower()
        if name in {"bash", "bash.exe"} or os.name != "nt":
            return [shell, "-lc", command]
        return [shell, "-c", command]
    if os.name == "nt":
        sh = shutil.which("sh")
        if sh:
            return [sh, "-c", command]
        raise PrepareError("no bash or sh found; set SUPER_RLM_BASH_SHELL")
    return ["sh", "-c", command]


async def run_shell(
    config: WorkerConfig,
    command: str,
    *,
    cwd: Path,
    env: dict[str, str],
    timeout_s: float,
) -> tuple[int, str]:
    """Run one shell command to completion and return (exit code, output)."""
    argv = shell_invocation(config, command)
    try:
        process = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(cwd),
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            **({} if os.name == "nt" else {"start_new_session": True}),
        )
    except OSError as exc:
        raise PrepareError(f"could not start shell {argv[0]!r}: {exc}") from exc

    try:
        output_bytes, _ = await asyncio.wait_for(process.communicate(), timeout=timeout_s)
    except asyncio.TimeoutError:
        await _kill(process)
        raise PrepareError(
            f"command timed out after {timeout_s:g}s: {redact_secrets(command)}"
        ) from None
    except asyncio.CancelledError:
        await _kill(process)
        raise

    return process.returncode, output_bytes.decode("utf-8", errors="replace").strip()


async def prepare_workspace(
    config: WorkerConfig,
    workspace: Path,
    ticket_id: str,
    assignment_id: str,
    *,
    prepare_command: str | None = None,
    profile: str | None = None,
) -> dict[str, Any] | None:
    """Run the configured preparation command once per workspace.

    ``prepare_command`` is the per-Assignment profile override; when omitted the
    Worker's global ``SUPER_RLM_PREPARE_COMMAND`` is used. Returns the marker
    payload when the workspace is prepared (now or before), or ``None`` when no
    preparation command is configured.
    """
    existing = read_marker(workspace)
    if existing is not None:
        LOG.info("workspace %s already prepared; skipping", workspace)
        return existing

    command = prepare_command if prepare_command is not None else config.prepare_command
    if not command:
        return None

    env = build_prepare_env(config, workspace, ticket_id, assignment_id)
    LOG.info("preparing workspace %s: %s", workspace, redact_secrets(command))
    returncode, output = await run_shell(
        config,
        command,
        cwd=workspace,
        env=env,
        timeout_s=config.prepare_timeout_s,
    )
    safe_output = redact_secrets(output)
    if safe_output:
        LOG.info("prepare output for %s:\n%s", workspace, safe_output[-4000:])
    if returncode != 0:
        tail = safe_output[-2000:]
        message = f"prepare_command exited with code {returncode}"
        if tail:
            message = f"{message}: {tail}"
        raise PrepareError(message)

    payload: dict[str, Any] = {
        "ticket_id": ticket_id,
        "prepared_at": datetime.now(timezone.utc).isoformat(),
        "command": command,
    }
    if profile:
        payload["profile"] = profile
    marker_path(workspace).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return payload


async def _kill(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    try:
        if os.name != "nt":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    except (ProcessLookupError, PermissionError):
        pass
    with contextlib.suppress(Exception):
        await process.wait()
