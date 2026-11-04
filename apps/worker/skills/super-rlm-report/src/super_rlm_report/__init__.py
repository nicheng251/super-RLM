
"""Structured Ticket report for super-RLM Workers."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx

TERMINAL = {"completed", "dropped", "waiting", "blocked", "failed"}
STATES = TERMINAL | {"progress"}


async def run(
    state: str,
    summary: str | None = None,
    result: str | None = None,
    question: str | None = None,
    artifacts: list[dict[str, Any]] | None = None,
    error: dict[str, Any] | str | None = None,
) -> dict[str, Any]:
    """Post one structured report to the Worker's per-assignment endpoint.

    Args:
        state: completed, dropped, waiting, blocked, failed, or progress.
        summary: Short human-readable summary.
        result: Full result text for completed/dropped.
        question: The concrete question for waiting or blocked.
        artifacts: Relative artifact paths inside the workspace.
        error: Error object or message for failed.
    """
    if state not in STATES:
        raise ValueError(f"invalid state: {state}")
    if state in {"waiting", "blocked"} and not question:
        raise ValueError(f"{state} requires question")
    if state == "completed" and not (summary and (result or artifacts)):
        raise ValueError("completed requires summary and a result or artifacts")
    if state == "dropped" and not summary:
        raise ValueError("dropped requires summary")
    if state == "failed" and not (summary and error):
        raise ValueError("failed requires summary and error")

    payload: dict[str, Any] = {"state": state}
    if summary is not None:
        payload["summary"] = summary
    if result is not None:
        payload["result"] = result
    if question is not None:
        payload["question"] = {"kind": state, "text": question}
    if artifacts is not None:
        payload["artifacts"] = artifacts
    if error is not None:
        payload["error"] = error if isinstance(error, dict) else {"message": error}

    url = os.environ.get("SUPER_RLM_REPORT_URL")
    token = os.environ.get("SUPER_RLM_REPORT_TOKEN")
    config_path = os.environ.get("SUPER_RLM_REPORT_CONFIG")
    if config_path:
        # A resident Prime Agent kernel keeps the environment from the first
        # Assignment. The Worker rewrites this file before every Assignment so
        # a resumed session posts to the current report endpoint.
        try:
            config = json.loads(Path(config_path).read_text(encoding="utf-8"))
            url = config.get("url") or url
            token = config.get("token") or token
        except FileNotFoundError:
            pass
    if not url:
        raise RuntimeError("SUPER_RLM_REPORT_URL is not set")
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(url, json=payload, headers=headers)
    try:
        body = response.json()
    except Exception:
        body = {"raw": response.text}
    if response.status_code >= 400:
        raise RuntimeError(f"report rejected ({response.status_code}): {body}")
    return body
