"""Worker entry point."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

import uvicorn

from .api import create_app
from .config import WorkerConfig
from .daemon import PrimeDaemon
from .executor import ExecutionManager
from .heartbeat import assignment_heartbeat_loop, heartbeat_loop, register_with_retry
from .reports import ReportForwarder

LOG = logging.getLogger("super_rlm_worker.main")


class WorkerRuntime:
    """Ordered Worker shutdown: Tickets first, then the shared daemon."""

    def __init__(self, config: WorkerConfig, manager: ExecutionManager, daemon: PrimeDaemon) -> None:
        self.config = config
        self.manager = manager
        self.daemon = daemon
        self._lock = asyncio.Lock()
        self._shutdown_done = False

    @property
    def shutting_down(self) -> bool:
        return self._shutdown_done

    async def shutdown(self) -> None:
        async with self._lock:
            if self._shutdown_done:
                return
            self._shutdown_done = True
            try:
                await self.manager.shutdown()
            finally:
                try:
                    await self.daemon.shutdown()
                except Exception:  # noqa: BLE001 - the Worker must still exit
                    LOG.exception("failed to stop the Prime Agent daemon")


def build_app(config: WorkerConfig, daemon: PrimeDaemon | None = None):
    forwarder = ReportForwarder(config.orchestrator_url, config.worker_token, config.callback_key)
    daemon = daemon if daemon is not None else PrimeDaemon(config)
    manager = ExecutionManager(config, forwarder, daemon)
    runtime = WorkerRuntime(config, manager, daemon)

    @asynccontextmanager
    async def lifespan(_app):
        config.ensure_dirs()
        # The shared daemon must exist before this Worker registers or accepts work.
        await daemon.ensure()
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
            await runtime.shutdown()

    app = create_app(manager, config, lifespan=lifespan)
    app.state.daemon = daemon
    app.state.manager = manager
    app.state.runtime = runtime
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    config = WorkerConfig.from_env()
    app = build_app(config)
    server = uvicorn.Server(uvicorn.Config(app, host=config.host, port=config.port, log_level="info"))
    # POST /v1/shutdown only flips the server flag. Uvicorn then runs the normal
    # lifespan shutdown, so the request never races the final teardown.
    app.state.request_shutdown = lambda: setattr(server, "should_exit", True)
    server.run()


if __name__ == "__main__":
    main()
