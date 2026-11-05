#!/usr/bin/env python3
"""Windows Job Object supervisor for the super-rlm TUI stack.

The supervisor owns one Job with KILL_ON_JOB_CLOSE. It starts the Orchestrator,
the Worker, and the TUI as Job members, waits for the TUI, runs the graceful
shutdown sequence, then closes the Job. If this process exits for any reason,
Windows closes the Job handle and kills every remaining member.

Run from the CLI:
    python job_supervisor.py <plan.json>

Exit codes:
    0  TUI exited normally and shutdown completed
    1  startup or TUI failure; the Job was closed
    2  the Job API is unavailable or the plan is invalid (fail closed)
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import json
import os
import signal
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9

CREATE_SUSPENDED = 0x00000004
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000

PROCESS_TERMINATE = 0x0001
PROCESS_SET_QUOTA = 0x0100
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_SUSPEND_RESUME = 0x0800

TERMINAL_TASK_STATUSES = {"succeeded", "partial", "failed", "cancelled", "timed_out"}
HANDLE = ctypes.c_void_p
DWORD = wintypes.DWORD
BOOL = wintypes.BOOL


class JobUnavailable(RuntimeError):
    """The Windows Job Object API could not be used."""


class StartupError(RuntimeError):
    """A required child could not start or become healthy."""


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", DWORD),
        ("SchedulingClass", DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def _win_error(prefix: str) -> str:
    code = ctypes.get_last_error()
    try:
        detail = ctypes.FormatError(code).strip()
    except Exception:  # noqa: BLE001 - diagnostics must not mask the failure
        detail = ""
    return f"{prefix} (Windows error {code}{': ' + detail if detail else ''})"


class JobApi:
    """The small, mockable surface over kernel32/ntdll."""

    def __init__(self) -> None:
        if os.name != "nt":
            raise JobUnavailable("Windows Job Objects are required; this platform is not Windows")
        try:
            self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            self.ntdll = ctypes.WinDLL("ntdll", use_last_error=True)
        except OSError as exc:
            raise JobUnavailable(f"could not load the Windows Job Object libraries: {exc}") from exc

        self.kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
        self.kernel32.CreateJobObjectW.restype = HANDLE
        self.kernel32.SetInformationJobObject.argtypes = [
            HANDLE, ctypes.c_int, ctypes.c_void_p, DWORD,
        ]
        self.kernel32.SetInformationJobObject.restype = BOOL
        self.kernel32.AssignProcessToJobObject.argtypes = [HANDLE, HANDLE]
        self.kernel32.AssignProcessToJobObject.restype = BOOL
        self.kernel32.OpenProcess.argtypes = [DWORD, BOOL, DWORD]
        self.kernel32.OpenProcess.restype = HANDLE
        self.kernel32.TerminateJobObject.argtypes = [HANDLE, wintypes.UINT]
        self.kernel32.TerminateJobObject.restype = BOOL
        self.kernel32.CloseHandle.argtypes = [HANDLE]
        self.kernel32.CloseHandle.restype = BOOL
        self.ntdll.NtResumeProcess.argtypes = [HANDLE]
        self.ntdll.NtResumeProcess.restype = ctypes.c_long

    def create_job(self, name: str) -> int:
        handle = self.kernel32.CreateJobObjectW(None, name)
        if not handle:
            raise JobUnavailable(_win_error("CreateJobObjectW failed"))
        return int(handle)

    def kill_on_close(self, job: int, *, die_on_unhandled: bool = False) -> None:
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if die_on_unhandled:
            flags |= JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
        info.BasicLimitInformation.LimitFlags = flags
        if not self.kernel32.SetInformationJobObject(
            HANDLE(job),
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(info),
            ctypes.sizeof(info),
        ):
            raise JobUnavailable(_win_error("SetInformationJobObject failed"))

    def assign_and_resume(self, job: int, pid: int) -> None:
        access = (
            PROCESS_TERMINATE
            | PROCESS_SET_QUOTA
            | PROCESS_QUERY_INFORMATION
            | PROCESS_SUSPEND_RESUME
        )
        process = self.kernel32.OpenProcess(access, False, pid)
        if not process:
            raise JobUnavailable(_win_error(f"OpenProcess failed for pid {pid}"))
        try:
            if not self.kernel32.AssignProcessToJobObject(HANDLE(job), process):
                raise JobUnavailable(_win_error(f"AssignProcessToJobObject failed for pid {pid}"))
            status = self.ntdll.NtResumeProcess(process)
            if status != 0:
                raise JobUnavailable(f"NtResumeProcess failed for pid {pid} (NTSTATUS 0x{status & 0xFFFFFFFF:08x})")
        finally:
            self.kernel32.CloseHandle(process)

    def terminate_job(self, job: int) -> None:
        self.kernel32.TerminateJobObject(HANDLE(job), 1)

    def close(self, job: int) -> None:
        self.kernel32.CloseHandle(HANDLE(job))


@dataclass
class RunningChild:
    plan: dict[str, Any]
    process: subprocess.Popen[bytes]
    log_handle: Any = None


def log(message: str) -> None:
    print(f"[super-rlm] {message}", flush=True)


def warn(message: str) -> None:
    print(f"[super-rlm] warning: {message}", file=sys.stderr, flush=True)


def load_plan(path: str) -> dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            plan = json.load(handle)
    except (OSError, ValueError) as exc:
        raise JobUnavailable(f"could not read supervisor plan {path!r}: {exc}") from exc
    if not isinstance(plan, dict) or plan.get("version") != 1:
        raise JobUnavailable("supervisor plan has an unsupported version")
    children = plan.get("children")
    if not isinstance(children, list) or not children:
        raise JobUnavailable("supervisor plan has no children")
    names = {child.get("name") for child in children if isinstance(child, dict)}
    if plan.get("tui_child") not in names:
        raise JobUnavailable("supervisor plan does not contain the TUI child")
    if plan.get("tui_child") not in {child.get("name") for child in children}:
        raise JobUnavailable("supervisor plan has an invalid tui_child")
    return plan


def merged_env(overrides: dict[str, str] | None) -> dict[str, str]:
    env = dict(os.environ)
    if overrides:
        env.update({str(key): str(value) for key, value in overrides.items()})
    return env


def stripped_env(prefixes: list[str], overrides: dict[str, str] | None) -> dict[str, str]:
    env = {
        key: value
        for key, value in os.environ.items()
        if not any(key.startswith(prefix) for prefix in prefixes)
    }
    if overrides:
        env.update({str(key): str(value) for key, value in overrides.items()})
    return env


def tail(path: str | None, lines: int = 25) -> str:
    if not path:
        return ""
    try:
        body = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(body[-lines:])


def http_ok(url: str, timeout: float = 0.75) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return 200 <= response.status < 300
    except Exception:  # noqa: BLE001 - a health probe is expected to fail while starting
        return False


def request_json(
    method: str,
    url: str,
    token: str | None,
    body: Any = None,
    timeout: float = 3.0,
) -> Any:
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    if token:
        headers["authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


class Supervisor:
    def __init__(self, plan: dict[str, Any], api: JobApi) -> None:
        self.plan = plan
        self.api = api
        self.job = 0
        self.job_open = False
        self.supervisor_pid_path = str(plan.get("supervisor_pid_path") or "")
        self.children: list[RunningChild] = []
        self.tui: RunningChild | None = None
        self.stop_requested = False

    # -- process startup ---------------------------------------------------

    def _write_pid(self, path: str | None, pid: int) -> None:
        if not path:
            return
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(pid), encoding="utf-8")

    def _remove_pid(self, path: str | None) -> None:
        if not path:
            return
        try:
            Path(path).unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass

    def create_job(self) -> None:
        self.job = self.api.create_job(str(self.plan.get("job_name") or "super-rlm"))
        self.job_open = True
        try:
            self.api.kill_on_close(self.job)
        except Exception:
            self.api.close(self.job)
            self.job_open = False
            raise
        self._write_pid(self.supervisor_pid_path, os.getpid())

    def _spawn(self, child: dict[str, Any]) -> RunningChild:
        name = str(child.get("name"))
        command = child.get("command")
        args = child.get("args") or []
        cwd = child.get("cwd")
        if not command or not isinstance(args, list) or not cwd:
            raise StartupError(f"invalid supervisor child plan for {name!r}")
        flags = CREATE_SUSPENDED
        log_handle = None
        if child.get("stdio") == "log":
            log_path = Path(str(child.get("log") or ""))
            if not child.get("log"):
                raise StartupError(f"{name} has no log path")
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_handle = open(log_path, "ab", buffering=0)
            flags |= CREATE_NO_WINDOW
            kwargs: dict[str, Any] = {
                "stdin": subprocess.DEVNULL,
                "stdout": log_handle,
                "stderr": subprocess.STDOUT,
            }
        else:
            kwargs = {"stdin": None, "stdout": None, "stderr": None}
        try:
            process = subprocess.Popen(
                [str(command), *[str(arg) for arg in args]],
                cwd=str(cwd),
                env=merged_env(child.get("env")),
                creationflags=flags,
                **kwargs,
            )
        except OSError as exc:
            if log_handle is not None:
                log_handle.close()
            raise StartupError(f"could not start {name}: {exc}") from exc
        try:
            self.api.assign_and_resume(self.job, process.pid)
        except Exception:
            try:
                process.kill()
                process.wait(timeout=5)
            except Exception:  # noqa: BLE001
                pass
            if log_handle is not None:
                log_handle.close()
            raise
        self._write_pid(child.get("pid"), process.pid)
        return RunningChild(plan=child, process=process, log_handle=log_handle)

    def wait_healthy(self, running: RunningChild) -> None:
        child = running.plan
        url = child.get("health_url")
        if not url:
            return
        timeout_s = max(1.0, float(child.get("startup_timeout_ms") or 30_000) / 1000.0)
        deadline = time.monotonic() + timeout_s
        name = str(child.get("name"))
        while time.monotonic() < deadline:
            code = running.process.poll()
            if code is not None:
                detail = tail(child.get("log"))
                raise StartupError(
                    f"{name} exited during startup with code {code}"
                    + (f"\n{detail}" if detail else "")
                )
            if http_ok(str(url)):
                log(f"{name} ready (pid {running.process.pid})")
                return
            time.sleep(0.25)
        detail = tail(child.get("log"))
        raise StartupError(
            f"{name} did not become healthy within {timeout_s:g}s"
            + (f"\n{detail}" if detail else "")
        )

    def start_stack(self) -> None:
        for child in self.plan["children"]:
            if child.get("name") == self.plan["tui_child"]:
                continue
            running = self._spawn(child)
            self.children.append(running)
            self.wait_healthy(running)
        for child in self.plan["children"]:
            if child.get("name") != self.plan["tui_child"]:
                continue
            self.tui = self._spawn(child)
            self.children.append(self.tui)
            log(f"TUI started (pid {self.tui.process.pid})")
            return
        raise StartupError("TUI child is missing from the plan")

    # -- TUI lifetime ------------------------------------------------------

    def _install_signal_handlers(self) -> None:
        def handler(_signum: int, _frame: Any) -> None:
            self.stop_requested = True

        for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
            signum = getattr(signal, name, None)
            if signum is None:
                continue
            try:
                signal.signal(signum, handler)
            except (OSError, ValueError):
                pass

    def wait_for_tui(self) -> tuple[int, bool]:
        if self.tui is None:
            raise StartupError("TUI child is missing")
        self._install_signal_handlers()
        process = self.tui.process
        while True:
            code = process.poll()
            if code is not None:
                return code, self.stop_requested
            if self.stop_requested:
                deadline = time.monotonic() + 5.0
                while time.monotonic() < deadline:
                    code = process.poll()
                    if code is not None:
                        return code, True
                    time.sleep(0.2)
                warn("TUI did not exit after an interrupt; terminating it")
                self._terminate(process, 5.0)
                return process.poll() or 0, True
            time.sleep(0.2)

    # -- graceful shutdown -------------------------------------------------

    def cancel_tasks(self, shutdown: dict[str, Any]) -> None:
        base = str(shutdown.get("orchestrator_url") or "").rstrip("/")
        token = shutdown.get("router_token")
        if not base:
            return
        try:
            payload = request_json("GET", f"{base}/v1/tasks?limit=1000", token, timeout=3.0)
        except Exception as exc:  # noqa: BLE001 - shutting down must continue
            warn(f"could not list tasks for cancellation: {exc}")
            return
        tasks = payload.get("tasks") if isinstance(payload, dict) else None
        if not isinstance(tasks, list):
            return
        targets = [
            task for task in tasks
            if isinstance(task, dict)
            and task.get("task_id")
            and task.get("status") not in TERMINAL_TASK_STATUSES
        ]
        if not targets:
            log("no active tasks to cancel")
            return
        log(f"cancelling {len(targets)} active task(s)")
        deadline = time.monotonic() + max(0.0, float(shutdown.get("cancel_timeout_ms") or 15_000) / 1000.0)
        for task in targets:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                warn("task cancellation deadline reached")
                return
            task_id = urllib.parse.quote(str(task["task_id"]), safe="")
            try:
                request_json(
                    "POST",
                    f"{base}/v1/tasks/{task_id}/cancel",
                    token,
                    {"reason": "TUI exited"},
                    timeout=min(5.0, remaining),
                )
            except Exception as exc:  # noqa: BLE001
                warn(f"could not cancel task {task['task_id']}: {exc}")

    def request_worker_shutdown(self, shutdown: dict[str, Any]) -> None:
        base = str(shutdown.get("worker_url") or "").rstrip("/")
        if not base:
            return
        timeout_s = max(1.0, float(shutdown.get("session_stop_timeout_ms") or 20_000) / 1000.0)
        try:
            request_json("POST", f"{base}/v1/shutdown", shutdown.get("worker_token"), timeout=timeout_s)
            log("worker accepted shutdown")
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 405):
                log("worker has no shutdown endpoint; continuing with process cleanup")
            else:
                warn(f"worker shutdown request failed with HTTP {exc.code}")
        except Exception as exc:  # noqa: BLE001
            warn(f"worker shutdown request failed: {exc}")

    def wait_for_worker_idle(self, shutdown: dict[str, Any]) -> None:
        base = str(shutdown.get("worker_url") or "").rstrip("/")
        if not base:
            return
        token = shutdown.get("worker_token")
        deadline = time.monotonic() + max(0.0, float(shutdown.get("session_stop_timeout_ms") or 20_000) / 1000.0)
        last_running: int | None = None
        while time.monotonic() < deadline:
            try:
                payload = request_json("GET", f"{base}/v1/health", token, timeout=2.0)
            except Exception:  # noqa: BLE001 - the worker may already be gone
                return
            running = payload.get("running") if isinstance(payload, dict) else None
            if not isinstance(running, int):
                return
            last_running = running
            if running <= 0:
                return
            time.sleep(0.25)
        if last_running:
            warn(f"worker still reports {last_running} running execution(s); forcing shutdown")

    def shutdown_daemon(self, shutdown: dict[str, Any]) -> None:
        executable = str(shutdown.get("prime_agent") or "")
        if not executable or not Path(executable).exists():
            warn(f"prime-agent not found: {executable or '<empty>'}")
            return
        env = stripped_env(
            [str(prefix) for prefix in (shutdown.get("prime_agent_env_strip") or [])],
            shutdown.get("prime_agent_env"),
        )
        timeout_s = max(1.0, float(shutdown.get("prime_agent_timeout_ms") or 30_000) / 1000.0)
        creationflags = CREATE_NO_WINDOW if os.name == "nt" else 0
        try:
            result = subprocess.run(
                [executable, "shutdown", "--force", "--json"],
                cwd=str(Path(executable).parent),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout_s,
                creationflags=creationflags,
            )
        except subprocess.TimeoutExpired:
            warn(f"prime-agent shutdown timed out after {timeout_s:g}s")
            return
        except OSError as exc:
            warn(f"could not run prime-agent shutdown: {exc}")
            return
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).decode("utf-8", errors="replace").strip()
            warn(f"prime-agent shutdown exited {result.returncode}: {detail[-500:]}")
            return
        log("Prime Agent daemon stopped")

    def _terminate(self, process: subprocess.Popen[bytes], timeout_s: float) -> None:
        if process.poll() is not None:
            return
        try:
            process.terminate()
        except OSError:
            return
        try:
            process.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
                process.wait(timeout=timeout_s)
            except (OSError, subprocess.TimeoutExpired):
                pass

    def stop_children(self, shutdown: dict[str, Any]) -> None:
        timeout_s = max(1.0, float(shutdown.get("process_stop_timeout_ms") or 5_000) / 1000.0)
        for running in reversed(self.children):
            name = str(running.plan.get("name"))
            if name == self.plan["tui_child"]:
                continue
            self._terminate(running.process, timeout_s)
            self._remove_pid(running.plan.get("pid"))
            log(f"{name} stopped")
            if running.log_handle is not None:
                try:
                    running.log_handle.close()
                except OSError:
                    pass

    def graceful_shutdown(self) -> None:
        shutdown = self.plan.get("shutdown") or {}
        self.cancel_tasks(shutdown)
        self.request_worker_shutdown(shutdown)
        self.wait_for_worker_idle(shutdown)
        self.shutdown_daemon(shutdown)
        self.stop_children(shutdown)

    # -- lifecycle ---------------------------------------------------------

    def close_job(self, *, terminate: bool = False) -> None:
        if not self.job_open:
            return
        if terminate:
            try:
                self.api.terminate_job(self.job)
            except Exception:  # noqa: BLE001
                pass
        try:
            self.api.close(self.job)
        finally:
            self.job_open = False
            self.job = 0

    def remove_pid_files(self) -> None:
        self._remove_pid(self.supervisor_pid_path)
        for running in self.children:
            self._remove_pid(running.plan.get("pid"))

    def run(self) -> int:
        self.create_job()
        try:
            return self._run_with_job()
        finally:
            self.remove_pid_files()

    def _run_with_job(self) -> int:
        try:
            self.start_stack()
            code, interrupted = self.wait_for_tui()
        except StartupError as exc:
            warn(str(exc))
            self.close_job(terminate=True)
            return 1
        except JobUnavailable as exc:
            warn(str(exc))
            self.close_job(terminate=True)
            return 2
        except Exception:  # noqa: BLE001 - a supervisor crash must still kill the stack
            traceback.print_exc()
            self.close_job(terminate=True)
            return 1

        if code == 0 or interrupted:
            try:
                self.graceful_shutdown()
            except Exception:  # noqa: BLE001 - closing the Job is the final guarantee
                traceback.print_exc()
            self.close_job()
            return 0 if code == 0 or interrupted else code

        warn(f"TUI exited with code {code}; closing the Job")
        self.close_job(terminate=True)
        return code if code > 0 else 1


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: job_supervisor.py <plan.json>", file=sys.stderr)
        return 2
    try:
        plan = load_plan(argv[1])
        api = JobApi()
    except JobUnavailable as exc:
        print(f"[super-rlm] cannot start the Windows Job supervisor: {exc}", file=sys.stderr)
        return 2
    return Supervisor(plan, api).run()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
