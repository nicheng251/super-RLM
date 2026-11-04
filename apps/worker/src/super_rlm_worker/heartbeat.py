
"""Worker registration and heartbeat."""

from __future__ import annotations

import asyncio
import logging

import httpx

from .config import WorkerConfig
from .executor import ExecutionManager, ExecutionState

LOG = logging.getLogger("super_rlm_worker.heartbeat")


def _headers(config: WorkerConfig) -> dict[str, str]:
    headers = {"content-type": "application/json"}
    if config.worker_token:
        headers["authorization"] = f"Bearer {config.worker_token}"
    return headers


async def register_with_retry(config: WorkerConfig) -> None:
    payload = {
        "worker_id": config.worker_id,
        "url": f"http://{config.host}:{config.port}",
        "max_concurrency": config.max_concurrency,
        "version": "0.1.0",
    }
    while True:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.post(
                    f"{config.orchestrator_url}/internal/v1/workers/register",
                    headers=_headers(config),
                    json=payload,
                )
            if response.status_code < 400:
                LOG.info("registered worker %s at %s", config.worker_id, payload["url"])
                return
            LOG.warning("worker registration failed: %s %s", response.status_code, response.text)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("worker registration unavailable: %s", exc)
        await asyncio.sleep(5)


async def heartbeat_loop(config: WorkerConfig, manager: ExecutionManager) -> None:
    while True:
        payload = {
            "running": manager.running,
            "max_concurrency": manager.max_concurrency,
            "status": "healthy",
        }
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.post(
                    f"{config.orchestrator_url}/internal/v1/workers/{config.worker_id}/heartbeat",
                    headers=_headers(config),
                    json=payload,
                )
            if response.status_code >= 400:
                LOG.warning("heartbeat failed: %s %s", response.status_code, response.text)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("heartbeat unavailable: %s", exc)
        await asyncio.sleep(config.heartbeat_interval_s)


async def assignment_heartbeat_loop(config: WorkerConfig, manager: ExecutionManager) -> None:
    while True:
        active = manager.active_executions()
        if active:
            async with httpx.AsyncClient(timeout=10) as client:
                for state in active:
                    payload = {"execution_id": state.execution_id, "phase": manager.phase(state)}
                    try:
                        response = await client.post(
                            f"{config.orchestrator_url}/internal/v1/assignments/{state.assignment_id}/heartbeat",
                            headers=_headers(config),
                            json=payload,
                        )
                        if response.status_code >= 400:
                            LOG.warning("assignment heartbeat failed: %s %s", response.status_code, response.text)
                    except Exception as exc:  # noqa: BLE001
                        LOG.warning("assignment heartbeat unavailable: %s", exc)
        await asyncio.sleep(config.assignment_heartbeat_interval_s)
