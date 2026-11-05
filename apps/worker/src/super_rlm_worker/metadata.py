"""Optional per-profile workspace metadata collection."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import WorkerConfig
from .prepare import PrepareError, build_prepare_env, run_shell


async def collect_workspace_metadata(
    config: WorkerConfig,
    workspace: Path,
    agent_cwd: Path,
    *,
    command: str | None,
    ticket_id: str,
    assignment_id: str,
) -> tuple[dict[str, Any] | None, str | None]:
    """Run ``metadata_command`` in the agent cwd and parse its JSON stdout.

    Failures never change the Ticket state: they are returned as
    ``metadata_error`` and the caller still forwards the completed report.
    """
    if not command:
        return None, None

    env = build_prepare_env(config, workspace, ticket_id, assignment_id)
    try:
        returncode, output = await run_shell(
            config,
            command,
            cwd=agent_cwd,
            env=env,
            timeout_s=config.metadata_timeout_s,
        )
    except PrepareError as exc:
        return None, f"metadata_command failed: {exc}"

    if returncode != 0:
        tail = output[-2000:]
        message = f"metadata_command exited with code {returncode}"
        if tail:
            message = f"{message}: {tail}"
        return None, message

    text = output.strip()
    if not text:
        return None, "metadata_command produced no output"
    try:
        data = json.loads(text)
    except ValueError as exc:
        return None, f"metadata_command output is not valid JSON: {exc}"
    if not isinstance(data, dict):
        return None, "metadata_command output must be a JSON object"
    return data, None
