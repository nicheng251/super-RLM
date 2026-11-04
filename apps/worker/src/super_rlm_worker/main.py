
"""Worker entry point."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

import uvicorn

from .api import create_app
from .config import WorkerConfig
from .executor import ExecutionManager
from .heartbeat import assignment_heartbeat_loop, heartbeat_loop, register_with_retry
from .reports import ReportForwarder


def build_app(config: WorkerConfig):
    forwarder = ReportForwarder(config.orchestrator_url, config.worker_token, config.callback_key)
    manager = ExecutionManager(config, forwarder)

    @asynccontextmanager
    async def lifespan(_app):
        config.ensure_dirs()
        await register_with_retry(config)
        heartbeat = asyncio.create_task(heartbeat_loop(config, manager), name="worker-heartbeat")
        assignment_heartbeat = asyncio.create_task(
            assignment_heartbeat_loop(config, manager), name="assignment-heartbeat"
        )
        try:
            yield
        finally:
            for task in (heartbeat, assignment_heartbeat):
                task.cancel()
            for task in (heartbeat, assignment_heartbeat):
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    return create_app(manager, config, lifespan=lifespan)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    config = WorkerConfig.from_env()
    app = build_app(config)
    uvicorn.run(app, host=config.host, port=config.port, log_level="info")


if __name__ == "__main__":
    main()
