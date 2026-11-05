"""Prime Agent daemon lifecycle for the Worker.

The Worker owns exactly one Prime Agent daemon per project. The daemon is shared
by all Tickets; a Ticket ACP process must never own it. Every path in this
module uses the project socket's canonical string so the daemon, the ACP
clients, and the admin commands all address the same daemon.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import subprocess
from dataclasses import dataclass
from typing import Any, Sequence

from .config import WorkerConfig
from .prime_agent import strip_inherited_agent_env

LOG = logging.getLogger("super_rlm_worker.daemon")


class DaemonError(RuntimeError):
    """A Prime Agent daemon command failed or the daemon did not become ready."""


def canonical_socket(value: str | os.PathLike[str]) -> str:
    """Return the one socket string used for env, ACP, status, stop, shutdown.

    Prime Agent keys its daemon identity, logs, and state directory to the raw
    socket string. Relative paths and mixed separators therefore create extra
    daemons. Make the value absolute and, on Windows, normalize case and
    separators.
    """
    text = os.path.abspath(os.path.expanduser(os.fspath(value)))
    if os.name == "nt":
        text = os.path.normcase(text)
    return text


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str

    @property
    def output(self) -> str:
        return f"{self.stdout}\n{self.stderr}".strip()


def parse_json_output(text: str, context: str) -> Any:
    """Parse a command's JSON output, tolerating leading log lines."""
    stripped = text.strip()
    if not stripped:
        raise DaemonError(f"{context}: command returned no JSON output")
    try:
        return json.loads(stripped)
    except ValueError:
        pass
    starts = [index for index in (stripped.find("["), stripped.find("{")) if index >= 0]
    if not starts:
        raise DaemonError(f"{context}: output is not JSON: {_tail(stripped)!r}")
    try:
        value, _ = json.JSONDecoder().raw_decode(stripped[min(starts):])
    except ValueError as exc:
        raise DaemonError(f"{context}: output is not JSON: {_tail(stripped)!r}") from exc
    return value


def _tail(text: str, limit: int = 600) -> str:
    text = text.strip()
    return text if len(text) <= limit else "..." + text[-limit:]


def _entries(payload: Any, context: str) -> list[dict[str, Any]]:
    if payload is None:
        return []
    if isinstance(payload, list):
        return [entry for entry in payload if isinstance(entry, dict)]
    if isinstance(payload, dict):
        for key in ("daemons", "services", "statuses"):
            value = payload.get(key)
            if isinstance(value, list):
                return [entry for entry in value if isinstance(entry, dict)]
        return [payload]
    raise DaemonError(f"{context}: unexpected JSON shape: {type(payload).__name__}")


def _current(entries: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    for entry in entries:
        if str(entry.get("status", "")).lower() == "current":
            return entry
    return None


class PrimeDaemon:
    """Control one project Prime Agent daemon through the supported CLI."""

    def __init__(
        self,
        config: WorkerConfig,
        *,
        executable: Sequence[str] | None = None,
        autostart: bool | None = None,
    ) -> None:
        self.config = config
        self._executable = [str(part) for part in (executable or [config.prime_agent])]
        self._autostart = config.daemon_autostart if autostart is None else autostart
        self._process: subprocess.Popen[bytes] | None = None
        self._ensured = False
        self._lock = asyncio.Lock()

    @property
    def socket(self) -> str:
        return self.config.daemon_socket

    def admin_env(self) -> dict[str, str]:
        """Environment for admin subcommands. They never accept --daemon-socket."""
        env = strip_inherited_agent_env(dict(os.environ))
        env.update({
            "PRIME_AGENT_CODING_AGENT_DIR": str(self.config.home / "prime" / "agent"),
            "PRIME_AGENT_CODING_AGENT_SESSION_DIR": str(self.config.session_root),
            "PRIME_AGENT_SESSION_DIR": str(self.config.session_root),
            "PRIME_AGENT_DAEMON_SOCKET": self.socket,
            "PRIME_AGENT_KERNEL_VENV": str(self.config.kernel_venv),
            "PRIME_AGENT_KERNEL_PYTHON": str(self.config.kernel_python),
            "PRIME_AGENT_TELEMETRY": "0",
            "DO_NOT_TRACK": "1",
        })
        return env

    async def _run_admin(self, args: Sequence[str], timeout_s: float) -> CommandResult:
        argv = [*self._executable, *args]
        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                cwd=str(self.config.home),
                env=self.admin_env(),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as exc:
            raise DaemonError(f"could not execute {argv[0]!r}: {exc}") from exc
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_s)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            with contextlib.suppress(Exception):
                await process.wait()
            raise DaemonError(
                f"prime-agent {' '.join(args)} timed out after {timeout_s:g}s"
            ) from None
        return CommandResult(
            returncode=process.returncode or 0,
            stdout=stdout.decode("utf-8", errors="replace"),
            stderr=stderr.decode("utf-8", errors="replace"),
        )

    async def status(self) -> list[dict[str, Any]]:
        """Return the daemon status entries for the project socket."""
        result = await self._run_admin(["status", "--json"], self.config.daemon_command_timeout_s)
        if result.returncode != 0:
            raise DaemonError(
                f"prime-agent status failed (exit {result.returncode}): {_tail(result.output)!r}"
            )
        payload = parse_json_output(result.stdout or result.stderr, "prime-agent status")
        return _entries(payload, "prime-agent status")

    async def ensure(self) -> dict[str, Any] | None:
        """Reuse a live project daemon or start one and wait until it is ready."""
        async with self._lock:
            if self._ensured:
                return _current(await self.status())
            if not self._autostart:
                self._ensured = True
                LOG.info("Prime Agent daemon autostart is disabled")
                return None

            entries = await self.status()
            running = _current(entries)
            if running is not None:
                self._ensured = True
                LOG.info(
                    "using existing Prime Agent daemon pid %s on %s",
                    running.get("pid"),
                    self.socket,
                )
                return running

            if entries:
                LOG.warning("clearing stale Prime Agent daemon state on %s", self.socket)
                try:
                    await self.shutdown()
                except DaemonError as exc:
                    LOG.warning("could not clear stale daemon state: %s", exc)

            await self.start()
            running = await self._wait_ready()
            self._ensured = True
            return running

    async def start(self) -> None:
        """Start a detached project daemon. The daemon outlives the Worker."""
        args = ["--mode", "daemon", "--daemon-socket", self.socket]
        argv = [*self._executable, *args]
        kwargs: dict[str, Any] = {
            "cwd": str(self.config.home),
            "env": self.admin_env(),
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "close_fds": True,
        }
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        try:
            self._process = subprocess.Popen(argv, **kwargs)
        except OSError as exc:
            raise DaemonError(f"could not start Prime Agent daemon {argv[0]!r}: {exc}") from exc
        LOG.info("started Prime Agent daemon pid %s on %s", self._process.pid, self.socket)

    async def _wait_ready(self) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.config.daemon_start_timeout_s
        last_error: DaemonError | None = None
        while True:
            if self._process is not None:
                returncode = self._process.poll()
                if returncode is not None:
                    raise DaemonError(
                        f"Prime Agent daemon exited during startup with code {returncode}"
                    )
            try:
                running = _current(await self.status())
            except DaemonError as exc:
                last_error = exc
                running = None
            if running is not None:
                LOG.info(
                    "Prime Agent daemon ready pid %s on %s",
                    running.get("pid"),
                    self.socket,
                )
                return running
            remaining = deadline - loop.time()
            if remaining <= 0:
                detail = f" (last error: {last_error})" if last_error else ""
                raise DaemonError(
                    f"Prime Agent daemon on {self.socket} did not become ready within "
                    f"{self.config.daemon_start_timeout_s:g}s{detail}"
                )
            await asyncio.sleep(min(0.25, remaining))

    async def stop_session(self, session_id: str) -> bool:
        """Stop one daemon session. Return False when it was already stopped."""
        session_id = session_id.strip()
        if not session_id:
            raise DaemonError("cannot stop a session without a session id")
        result = await self._run_admin(
            ["stop", session_id, "--json"], self.config.daemon_command_timeout_s
        )
        if result.returncode == 0:
            if result.stdout.strip():
                payload = parse_json_output(result.stdout, "prime-agent stop")
                if isinstance(payload, dict) and payload.get("success") is False:
                    raise DaemonError(
                        f"prime-agent stop {session_id} did not succeed: {_tail(result.output)!r}"
                    )
            return True
        if "unknown active session" in result.output.lower():
            LOG.info("session %s is already stopped", session_id)
            return False
        raise DaemonError(
            f"prime-agent stop {session_id} failed (exit {result.returncode}): "
            f"{_tail(result.output)!r}"
        )

    async def shutdown(self) -> None:
        """Stop the project daemon and verify that no daemon is current."""
        result = await self._run_admin(
            ["shutdown", "--force", "--json"], self.config.daemon_shutdown_timeout_s
        )
        if result.returncode != 0:
            try:
                entries = await self.status()
            except DaemonError:
                entries = None
            if entries is not None and _current(entries) is None:
                LOG.info("Prime Agent daemon on %s is already stopped", self.socket)
                self._ensured = False
                return
            raise DaemonError(
                f"prime-agent shutdown failed (exit {result.returncode}): {_tail(result.output)!r}"
            )

        if result.stdout.strip():
            payload = parse_json_output(result.stdout, "prime-agent shutdown")
            if isinstance(payload, dict):
                failed = payload.get("failed") or []
                if failed:
                    raise DaemonError(f"prime-agent shutdown reported failures: {failed}")

        entries = await self.status()
        running = _current(entries)
        if running is not None:
            raise DaemonError(
                f"Prime Agent daemon is still current after shutdown "
                f"(pid {running.get('pid')}) on {self.socket}"
            )
        self._ensured = False
        LOG.info("Prime Agent daemon stopped on %s", self.socket)
