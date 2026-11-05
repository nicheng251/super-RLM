#!/usr/bin/env python3
'''Windows Job Object and Prime Agent daemon lifecycle regression harness.

This script exercises the two process-lifecycle guarantees of P0-A1 without
calling a model:

1. ``apps/cli/supervisor/job_supervisor.py`` owns one Job Object with
   ``KILL_ON_JOB_CLOSE`` and starts dummy Orchestrator, Worker, and TUI children.
   Cases cover graceful TUI exit, failing TUI exit, a killed supervisor, and a
   startup failure.
2. The real Worker starts and shares one project Prime Agent daemon through a
   fake ``prime-agent`` executable. Cases cover Worker startup, canonical
   socket reuse, daemon survival after the Worker exits, zero-session explicit
   shutdown, and ``prime-agent stop <session>`` semantics.

Only the Python standard library is used. The Job cases need Windows. The
daemon cases use ``apps/worker/.venv/Scripts/python.exe`` so the real Worker
module is imported.

Usage (from the repository root):
    apps/worker/.venv/Scripts/python.exe scripts/regression/windows_lifecycle.py
    apps/worker/.venv/Scripts/python.exe scripts/regression/windows_lifecycle.py --case job_graceful
    apps/worker/.venv/Scripts/python.exe scripts/regression/windows_lifecycle.py --verbose
    apps/worker/.venv/Scripts/python.exe scripts/regression/windows_lifecycle.py --real-prime

Progress and PASS/FAIL lines go to stderr. One JSON summary goes to stdout.
Exit codes: 0 all selected cases passed, 1 any failure, 2 setup error, 130
interrupted. All child processes are cleaned up even when a case fails.
'''

from __future__ import annotations

import argparse
import asyncio
import ctypes
import ctypes.wintypes as wintypes
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
SUPERVISOR = REPO_ROOT / "apps" / "cli" / "supervisor" / "job_supervisor.py"
WORKER_DIR = REPO_ROOT / "apps" / "worker"
WORKER_SRC = WORKER_DIR / "src"
WORKER_PYTHON = WORKER_DIR / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
PRIME_AGENT = REPO_ROOT / "runtime" / "prime-agent" / (
    "prime-agent.exe" if os.name == "nt" else "prime-agent"
)

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_QUERY = 0x0004
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
STILL_ACTIVE = 259
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

REAL_PRIME_CASE = "real_prime_admin"
ALL_CASES = ("job_graceful", "job_failure", "job_kill", "job_startup_failure", "daemon_lifecycle", REAL_PRIME_CASE)


# ---------------------------------------------------------------------------
# small process and HTTP helpers
# ---------------------------------------------------------------------------

def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def assertion(name: str, ok: bool, detail: str = "") -> dict[str, Any]:
    return {"name": name, "ok": bool(ok), "detail": detail}


def _kernel32():
    return ctypes.WinDLL("kernel32", use_last_error=True)


def pid_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    kernel32 = _kernel32()
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return False
    try:
        code = wintypes.DWORD(0)
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def kill_pid(pid: int | None, timeout: float = 5.0) -> None:
    '''Kill exactly this process (not its tree) and wait briefly.'''
    if not pid_alive(pid):
        return
    try:
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/F"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
    except OSError:
        pass
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and pid_alive(pid):
        time.sleep(0.05)


def wait_until(predicate: Callable[[], Any], timeout: float, interval: float = 0.1) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if predicate():
                return True
        except Exception:  # noqa: BLE001 - polling probes are expected to fail early
            pass
        time.sleep(interval)
    try:
        return bool(predicate())
    except Exception:  # noqa: BLE001
        return False


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def http_json(
    method: str,
    url: str,
    token: str | None = None,
    body: Any = None,
    timeout: float = 5.0,
) -> Any:
    data = None
    headers: dict[str, str] = {}
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


def http_ok(url: str, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return 200 <= response.status < 300
    except Exception:  # noqa: BLE001
        return False


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def read_json(path: Path) -> Any:
    text = read_text(path)
    if not text.strip():
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def read_jsonl(path: Path) -> list[Any]:
    rows: list[Any] = []
    for line in read_text(path).splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except ValueError:
            rows.append({"unparsed": line})
    return rows


def tail(path: Path, lines: int = 40) -> str:
    body = read_text(path).splitlines()
    return "\n".join(body[-lines:])


# ---------------------------------------------------------------------------
# Job Object inspection
# ---------------------------------------------------------------------------

class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
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


def job_limit_flags(job_name: str) -> int | None:
    '''Open a running Job by name and return its LimitFlags, or None.'''
    kernel32 = _kernel32()
    kernel32.OpenJobObjectW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.OpenJobObjectW.restype = ctypes.c_void_p
    kernel32.QueryInformationJobObject.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.QueryInformationJobObject.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.OpenJobObjectW(JOB_OBJECT_QUERY, False, job_name)
    if not handle:
        return None
    try:
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        returned = wintypes.DWORD(0)
        ok = kernel32.QueryInformationJobObject(
            handle,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(info),
            ctypes.sizeof(info),
            ctypes.byref(returned),
        )
        if not ok:
            return None
        return int(info.BasicLimitInformation.LimitFlags)
    finally:
        kernel32.CloseHandle(handle)


# ---------------------------------------------------------------------------
# generated dummy child (Orchestrator / Worker / TUI)
# ---------------------------------------------------------------------------

DUMMY_CHILD = r'''#!/usr/bin/env python3
import argparse
import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def append(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(value) + "\n")


def write(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(target.suffix + ".tmp")
    temp.write_text(json.dumps(value), encoding="utf-8")
    os.replace(temp, target)


class Handler(BaseHTTPRequestHandler):
    server_version = "super-rlm-dummy/1"

    def log_message(self, *args):
        pass

    def _send(self, code, payload):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _record(self, body=None):
        append(self.server.state_dir / "requests.jsonl", {
            "method": self.command,
            "path": self.path,
            "body": body,
        })

    def do_GET(self):
        self._record()
        if self.path.startswith("/v1/tasks"):
            self._send(200, {"tasks": [{"task_id": "tsk_regression", "status": "running"}]})
            return
        if self.path in ("/health", "/v1/health"):
            self._send(200, {"status": "ok", "running": 0})
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("content-length") or "0")
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else None
        except ValueError:
            body = raw.decode("utf-8", "replace")
        self._record(body)
        if self.path.startswith("/v1/tasks/") and self.path.endswith("/cancel"):
            write(self.server.state_dir / "cancel.json", {"path": self.path})
            self._send(200, {"status": "cancelled"})
            return
        if self.path == "/v1/shutdown":
            write(self.server.state_dir / "shutdown.json", {"at": time.time()})
            self._send(200, {"status": "shutting_down"})
            return
        self._send(200, {"status": "ok"})


def serve(args):
    state_dir = Path(args.state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.state_dir = state_dir

    def stop(_signum, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    write(state_dir / "ready.json", {"pid": os.getpid(), "port": args.port, "role": args.role})
    server.serve_forever()
    server.server_close()
    write(state_dir / "stopped.json", {"pid": os.getpid()})


def tui(args):
    state_dir = Path(args.state_dir)
    write(state_dir / "started.json", {"pid": os.getpid(), "exit_code": args.exit_code})
    deadline = time.monotonic() + args.delay
    while time.monotonic() < deadline:
        time.sleep(0.05)
    write(state_dir / "exit.json", {"pid": os.getpid(), "exit_code": args.exit_code})
    return args.exit_code


def fail_start(args):
    state_dir = Path(args.state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    write(state_dir / "fail.json", {"pid": os.getpid(), "exit_code": args.exit_code})
    print("dummy child refuses to start", file=sys.stderr, flush=True)
    return args.exit_code


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="mode", required=True)
    serve_parser = sub.add_parser("serve")
    serve_parser.add_argument("--role", required=True)
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, required=True)
    serve_parser.add_argument("--state-dir", required=True)
    tui_parser = sub.add_parser("tui")
    tui_parser.add_argument("--exit-code", type=int, required=True)
    tui_parser.add_argument("--delay", type=float, default=1.0)
    tui_parser.add_argument("--state-dir", required=True)
    fail_parser = sub.add_parser("fail-start")
    fail_parser.add_argument("--exit-code", type=int, default=1)
    fail_parser.add_argument("--state-dir", required=True)
    args = parser.parse_args()
    if args.mode == "serve":
        serve(args)
        return 0
    if args.mode == "tui":
        return tui(args)
    if args.mode == "fail-start":
        return fail_start(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
'''


# ---------------------------------------------------------------------------
# generated fake prime-agent
# ---------------------------------------------------------------------------

FAKE_PRIME_AGENT = r'''#!/usr/bin/env python3
import ctypes
import json
import os
import sys
import time
from pathlib import Path

STATE_DIR = Path(os.environ["FAKE_AGENT_STATE"])
STATE_FILE = STATE_DIR / "state.json"
CALLS = STATE_DIR / "calls.jsonl"
STILL_ACTIVE = 259


def load():
    for _ in range(50):
        try:
            if not STATE_FILE.exists():
                return {"running": False, "pid": None, "sessions": [], "socket": None}
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            time.sleep(0.02)
    return {"running": False, "pid": None, "sessions": [], "socket": None}


def save(state):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temp = STATE_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(state), encoding="utf-8")
    os.replace(temp, STATE_FILE)


def record(args):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    row = {
        "args": args,
        "pid": os.getpid(),
        "socket": os.environ.get("PRIME_AGENT_DAEMON_SOCKET"),
        "time": time.time(),
    }
    with open(CALLS, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


def alive(pid):
    if not pid:
        return False
    kernel32 = ctypes.WinDLL("kernel32")
    handle = kernel32.OpenProcess(0x1000, False, int(pid))
    if not handle:
        return False
    try:
        code = ctypes.c_ulong(0)
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def main():
    args = sys.argv[1:]
    record(args)
    state = load()

    if args[:1] == ["status"]:
        if state.get("running"):
            print(json.dumps([{
                "socketPath": os.environ.get("PRIME_AGENT_DAEMON_SOCKET"),
                "pid": state.get("pid"),
                "status": "current",
                "sessionCount": len(state.get("sessions") or []),
            }]))
        else:
            print("[]")
        return 0

    if args[:2] == ["--mode", "daemon"]:
        socket_arg = None
        if "--daemon-socket" in args:
            index = args.index("--daemon-socket")
            if index + 1 < len(args):
                socket_arg = args[index + 1]
        state = load()
        state.update({
            "running": True,
            "pid": os.getpid(),
            "socket": socket_arg,
            "started_at": time.time(),
            "sessions": state.get("sessions") or [],
        })
        save(state)
        # A real daemon is long-lived. Stop when shutdown flips the flag.
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            time.sleep(0.05)
            current = load()
            if not current.get("running"):
                current["daemon_exited_at"] = time.time()
                save(current)
                return 0
        current = load()
        current["timed_out"] = True
        save(current)
        return 3

    if args[:1] == ["shutdown"]:
        state = load()
        pid = state.get("pid")
        state["running"] = False
        state["sessions"] = []
        state["shutdown_at"] = time.time()
        save(state)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and alive(pid):
            time.sleep(0.05)
        print(json.dumps({"stopped": [], "failed": []}))
        return 0

    if args[:1] == ["stop"]:
        if len(args) < 2:
            print("missing session", file=sys.stderr)
            return 2
        session_id = args[1]
        state = load()
        sessions = state.get("sessions") or []
        if state.get("running") and session_id in sessions:
            sessions.remove(session_id)
            state["sessions"] = sessions
            save(state)
            print(json.dumps({"type": "response", "command": "kill", "success": True, "id": "daemon_regression"}))
            return 0
        print("Error: Unknown active session: " + session_id, file=sys.stderr)
        return 1

    print("fake prime-agent got unexpected arguments: " + repr(args), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
'''


# ---------------------------------------------------------------------------
# generated fake Orchestrator for the Worker registration handshake
# ---------------------------------------------------------------------------

class FakeOrchestrator:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        if self._server is None:
            raise RuntimeError("fake Orchestrator is not started")
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def start(self) -> None:
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get("content-length") or "0")
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw.decode("utf-8")) if raw else None
                except ValueError:
                    body = raw.decode("utf-8", "replace")
                with owner._lock:
                    owner.requests.append({"path": self.path, "body": body})
                payload = {"status": "ok"}
                if self.path.endswith("/register"):
                    payload = {"worker_id": (body or {}).get("worker_id") if isinstance(body, dict) else None}
                raw_out = json.dumps(payload).encode("utf-8")
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(raw_out)))
                self.end_headers()
                self.wfile.write(raw_out)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        self._server = server
        self._thread = threading.Thread(target=server.serve_forever, name="fake-orchestrator", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None


# ---------------------------------------------------------------------------
# case context and cleanup
# ---------------------------------------------------------------------------

class CaseContext:
    def __init__(self, base: Path, name: str, fake_agent_state: Path | None = None) -> None:
        self.name = name
        self.dir = base / name
        self.logs = self.dir / "logs"
        self.state = self.dir / "state"
        self.run = self.dir / "run"
        for path in (self.dir, self.logs, self.state, self.run):
            path.mkdir(parents=True, exist_ok=True)
        self.dummy_child = self.dir / "dummy_child.py"
        self.dummy_child.write_text(DUMMY_CHILD, encoding="utf-8")
        self.fake_agent_state = fake_agent_state
        self.fake_agent = None
        if fake_agent_state is not None:
            fake_agent_state.mkdir(parents=True, exist_ok=True)
            self.fake_agent = self.dir / "prime-agent.cmd"
            self.fake_agent.write_text(
                "@echo off\r\n"
                f'set "FAKE_AGENT_STATE={fake_agent_state}"\r\n'
                f'"{sys.executable}" "{self.dir / "fake_prime_agent.py"}" %*\r\n',
                encoding="utf-8",
            )
            (self.dir / "fake_prime_agent.py").write_text(FAKE_PRIME_AGENT, encoding="utf-8")
        self.processes: list[subprocess.Popen[bytes]] = []
        self.extra_pids: set[int] = set()
        self.fake_orchestrator: FakeOrchestrator | None = None

    def track(self, process: subprocess.Popen[bytes]) -> subprocess.Popen[bytes]:
        self.processes.append(process)
        return process

    def track_pid(self, pid: int | None) -> None:
        if pid:
            self.extra_pids.add(int(pid))

    def cleanup(self) -> None:
        if self.fake_orchestrator is not None:
            try:
                self.fake_orchestrator.stop()
            except Exception:  # noqa: BLE001
                pass
        for process in reversed(self.processes):
            try:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
            except Exception:  # noqa: BLE001
                pass
        for pid in sorted(self.extra_pids):
            try:
                kill_pid(pid)
            except Exception:  # noqa: BLE001
                pass
        if self.fake_agent_state is not None:
            state = read_json(self.fake_agent_state / "state.json") or {}
            daemon_pid = state.get("pid") if isinstance(state, dict) else None
            # Only kill a daemon that still claims to be running; a stopped
            # fake daemon's PID may already belong to an unrelated process.
            if daemon_pid and isinstance(state, dict) and state.get("running"):
                try:
                    kill_pid(int(daemon_pid))
                except Exception:  # noqa: BLE001
                    pass

    def fake_calls(self) -> list[dict[str, Any]]:
        if self.fake_agent_state is None:
            return []
        return [row for row in read_jsonl(self.fake_agent_state / "calls.jsonl") if isinstance(row, dict)]


# ---------------------------------------------------------------------------
# supervisor plan and process
# ---------------------------------------------------------------------------

class SupervisorRun:
    def __init__(self, context: CaseContext, plan: dict[str, Any], label: str = "supervisor") -> None:
        self.context = context
        self.plan = plan
        self.plan_path = context.run / f"{label}-plan.json"
        self.log_path = context.logs / f"{label}.log"
        self.plan_path.write_text(json.dumps(plan, indent=2), encoding="utf-8")
        self.process: subprocess.Popen[bytes] | None = None
        self._log_handle = None

    def start(self) -> None:
        self._log_handle = open(self.log_path, "ab", buffering=0)
        self.process = subprocess.Popen(
            [sys.executable, str(SUPERVISOR), str(self.plan_path)],
            cwd=str(REPO_ROOT),
            stdin=subprocess.DEVNULL,
            stdout=self._log_handle,
            stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.context.track(self.process)

    def wait(self, timeout: float) -> int:
        if self.process is None:
            raise RuntimeError("supervisor was not started")
        return int(self.process.wait(timeout=timeout))

    def kill(self) -> None:
        if self.process is not None and self.process.poll() is None:
            self.process.kill()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass

    def tail(self, lines: int = 50) -> str:
        return tail(self.log_path, lines)


def make_http_child(
    context: CaseContext,
    name: str,
    role: str,
    port: int,
    *,
    startup_timeout_ms: int = 15_000,
) -> dict[str, Any]:
    child_state = context.state / name
    return {
        "name": name,
        "command": sys.executable,
        "args": [
            str(context.dummy_child), "serve",
            "--role", role,
            "--port", str(port),
            "--state-dir", str(child_state),
        ],
        "cwd": str(context.dir),
        "env": {},
        "stdio": "log",
        "log": str(context.logs / f"{name}.log"),
        "pid": str(context.run / f"{name}.pid"),
        "health_url": f"http://127.0.0.1:{port}/{'health' if role == 'orchestrator' else 'v1/health'}",
        "startup_timeout_ms": startup_timeout_ms,
    }


def make_tui_child(
    context: CaseContext,
    *,
    exit_code: int,
    delay: float,
    pid_name: str = "tui.pid",
) -> dict[str, Any]:
    return {
        "name": "tui",
        "command": sys.executable,
        "args": [
            str(context.dummy_child), "tui",
            "--exit-code", str(exit_code),
            "--delay", str(delay),
            "--state-dir", str(context.state / "tui"),
        ],
        "cwd": str(context.dir),
        "env": {},
        "stdio": "inherit",
        "pid": str(context.run / pid_name),
        "startup_timeout_ms": 0,
    }


def make_fail_child(context: CaseContext, name: str = "worker", port: int | None = None) -> dict[str, Any]:
    child = {
        "name": name,
        "command": sys.executable,
        "args": [
            str(context.dummy_child), "fail-start",
            "--exit-code", "1",
            "--state-dir", str(context.state / name),
        ],
        "cwd": str(context.dir),
        "env": {},
        "stdio": "log",
        "log": str(context.logs / f"{name}.log"),
        "pid": str(context.run / f"{name}.pid"),
        "startup_timeout_ms": 10_000,
    }
    if port is not None:
        child["health_url"] = f"http://127.0.0.1:{port}/v1/health"
    return child


def build_plan(
    context: CaseContext,
    job_name: str,
    orchestrator: dict[str, Any],
    worker: dict[str, Any],
    tui: dict[str, Any],
    *,
    orchestrator_port: int,
    worker_port: int,
) -> dict[str, Any]:
    if context.fake_agent is None:
        raise RuntimeError("this plan needs a fake prime-agent")
    return {
        "version": 1,
        "job_name": job_name,
        "supervisor_pid_path": str(context.run / "supervisor.pid"),
        "tui_child": "tui",
        "children": [orchestrator, worker, tui],
        "shutdown": {
            "orchestrator_url": f"http://127.0.0.1:{orchestrator_port}",
            "router_token": "regression-router-token",
            "worker_url": f"http://127.0.0.1:{worker_port}",
            "worker_token": "regression-worker-token",
            "cancel_timeout_ms": 3_000,
            "session_stop_timeout_ms": 3_000,
            "prime_agent": str(context.fake_agent),
            "prime_agent_env": {
                "PRIME_AGENT_DAEMON_SOCKET": canonical_socket(
                    context.dir / "daemon" / "worker.sock"
                ),
                "PRIME_AGENT_TELEMETRY": "0",
                "DO_NOT_TRACK": "1",
            },
            "prime_agent_env_strip": ["PI_", "PRIME_AGENT_", "RLM_"],
            "prime_agent_timeout_ms": 10_000,
            "process_stop_timeout_ms": 3_000,
        },
    }


def plan_pids(plan: dict[str, Any]) -> dict[str, int]:
    pids: dict[str, int] = {}
    for child in plan["children"]:
        path = child.get("pid")
        if not path:
            continue
        value = read_text(Path(path)).strip()
        try:
            pids[str(child["name"])] = int(value)
        except ValueError:
            continue
    return pids


def child_real_pids(context: CaseContext) -> dict[str, int]:
    """PIDs reported by the children themselves.

    A venv ``python.exe`` can be a launcher, so ``Popen.pid`` is not always the
    PID that runs the child script. Read the marker files the children write so
    the orphan check covers both the launcher and the real process.
    """
    markers = {
        "orchestrator": context.state / "orchestrator" / "ready.json",
        "worker": context.state / "worker" / "ready.json",
        "tui": context.state / "tui" / "started.json",
    }
    pids: dict[str, int] = {}
    for name, marker in markers.items():
        data = read_json(marker)
        pid = data.get("pid") if isinstance(data, dict) else None
        if isinstance(pid, int) and pid > 0:
            pids[name] = pid
            context.track_pid(pid)
    return pids


def merged_pids(launcher_pids: dict[str, int], real_pids: dict[str, int]) -> dict[str, int]:
    merged = dict(launcher_pids)
    merged.update({f"real_{name}": pid for name, pid in real_pids.items()})
    return merged


def all_gone(pids: dict[str, int], timeout: float) -> tuple[bool, dict[str, bool]]:
    def check() -> bool:
        return not any(pid_alive(pid) for pid in pids.values())

    wait_until(check, timeout)
    return check(), {name: pid_alive(pid) for name, pid in pids.items()}


# ---------------------------------------------------------------------------
# Job supervisor cases
# ---------------------------------------------------------------------------

def _job_flags_detail(flags: int | None) -> str:
    if flags is None:
        return "Job is not open (or cannot be opened)"
    return f"LimitFlags=0x{flags:08x}"


def _job_name(case: str) -> str:
    return f"super-rlm-regression-{case}-{uuid.uuid4().hex}"


def case_job_graceful(base: Path, verbose: bool) -> list[dict[str, Any]]:
    ctx = CaseContext(base, "job_graceful", fake_agent_state=base / "job_graceful" / "fake-agent")
    assertions: list[dict[str, Any]] = []
    try:
        orchestrator_port = free_port()
        worker_port = free_port()
        job_name = _job_name("graceful")
        plan = build_plan(
            ctx,
            job_name,
            make_http_child(ctx, "orchestrator", "orchestrator", orchestrator_port),
            make_http_child(ctx, "worker", "worker", worker_port),
            make_tui_child(ctx, exit_code=0, delay=2.0),
            orchestrator_port=orchestrator_port,
            worker_port=worker_port,
        )
        run = SupervisorRun(ctx, plan)
        run.start()

        if not wait_until(lambda: (ctx.state / "tui" / "started.json").exists(), 20):
            raise RuntimeError("TUI did not start\n" + run.tail())
        flags = job_limit_flags(job_name)
        pids = plan_pids(plan)
        real_pids = child_real_pids(ctx)
        code = run.wait(30)

        assertions.append(assertion("supervisor_exit_zero", code == 0, f"exit code {code}"))
        assertions.append(assertion(
            "job_kill_on_job_close",
            flags is not None and bool(flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE),
            _job_flags_detail(flags),
        ))
        assertions.append(assertion(
            "orchestrator_cancel_called",
            (ctx.state / "orchestrator" / "cancel.json").exists(),
            "POST /v1/tasks/tsk_regression/cancel marker",
        ))
        assertions.append(assertion(
            "worker_shutdown_called",
            (ctx.state / "worker" / "shutdown.json").exists(),
            "POST /v1/shutdown marker",
        ))
        fake_state = read_json(ctx.fake_agent_state / "state.json") or {}
        shutdown_rows = [
            row for row in ctx.fake_calls()
            if isinstance(row.get("args"), list) and row["args"][:1] == ["shutdown"]
        ]
        expected_daemon_socket = canonical_socket(ctx.dir / "daemon" / "worker.sock")
        assertions.append(assertion(
            "daemon_shutdown_called",
            isinstance(fake_state, dict)
            and fake_state.get("running") is False
            and bool(shutdown_rows),
            f"running={fake_state.get('running') if isinstance(fake_state, dict) else None}",
        ))
        assertions.append(assertion(
            "daemon_shutdown_env",
            len(shutdown_rows) == 1
            and shutdown_rows[0].get("socket") == expected_daemon_socket,
            f"socket={shutdown_rows[0].get('socket') if shutdown_rows else None} "
            f"expected={expected_daemon_socket}",
        ))
        gone, alive = all_gone(merged_pids(pids, real_pids), 10)
        assertions.append(assertion("children_stopped", gone, f"alive={alive}"))
        tui_exit = read_json(ctx.state / "tui" / "exit.json")
        assertions.append(assertion(
            "tui_exit_zero",
            isinstance(tui_exit, dict) and tui_exit.get("exit_code") == 0,
            f"marker={tui_exit}",
        ))
        pid_files = [Path(child["pid"]) for child in plan["children"] if child.get("pid")]
        supervisor_pid_file = Path(plan["supervisor_pid_path"])
        stale = [str(path) for path in [*pid_files, supervisor_pid_file] if path.exists()]
        assertions.append(assertion("pid_files_cleaned", not stale, f"remaining={stale}"))
        closed = wait_until(lambda: job_limit_flags(job_name) is None, 5)
        assertions.append(assertion("job_closed", closed, _job_flags_detail(job_limit_flags(job_name))))
        if verbose:
            log(run.tail(80))
        return assertions
    finally:
        ctx.cleanup()


def case_job_failure(base: Path, verbose: bool) -> list[dict[str, Any]]:
    ctx = CaseContext(base, "job_failure", fake_agent_state=base / "job_failure" / "fake-agent")
    assertions: list[dict[str, Any]] = []
    try:
        orchestrator_port = free_port()
        worker_port = free_port()
        job_name = _job_name("failure")
        plan = build_plan(
            ctx,
            job_name,
            make_http_child(ctx, "orchestrator", "orchestrator", orchestrator_port),
            make_http_child(ctx, "worker", "worker", worker_port),
            make_tui_child(ctx, exit_code=3, delay=1.5),
            orchestrator_port=orchestrator_port,
            worker_port=worker_port,
        )
        run = SupervisorRun(ctx, plan)
        run.start()

        if not wait_until(lambda: (ctx.state / "tui" / "started.json").exists(), 20):
            raise RuntimeError("TUI did not start\n" + run.tail())
        flags = job_limit_flags(job_name)
        pids = plan_pids(plan)
        real_pids = child_real_pids(ctx)
        code = run.wait(30)

        assertions.append(assertion("supervisor_returns_tui_code", code == 3, f"exit code {code}"))
        assertions.append(assertion(
            "job_kill_on_job_close",
            flags is not None and bool(flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE),
            _job_flags_detail(flags),
        ))
        assertions.append(assertion(
            "no_graceful_cancel",
            not (ctx.state / "orchestrator" / "cancel.json").exists(),
            "no cancel marker after a failed TUI",
        ))
        assertions.append(assertion(
            "no_worker_shutdown",
            not (ctx.state / "worker" / "shutdown.json").exists(),
            "no worker shutdown marker after a failed TUI",
        ))
        fake_args = [row.get("args") for row in ctx.fake_calls()]
        assertions.append(assertion(
            "no_daemon_shutdown",
            not any(isinstance(args, list) and args[:1] == ["shutdown"] for args in fake_args),
            f"calls={fake_args}",
        ))
        gone, alive = all_gone(merged_pids(pids, real_pids), 10)
        assertions.append(assertion("children_terminated", gone, f"alive={alive}"))
        pid_files = [Path(child["pid"]) for child in plan["children"] if child.get("pid")]
        supervisor_pid_file = Path(plan["supervisor_pid_path"])
        stale = [str(path) for path in [*pid_files, supervisor_pid_file] if path.exists()]
        assertions.append(assertion("pid_files_cleaned", not stale, f"remaining={stale}"))
        closed = wait_until(lambda: job_limit_flags(job_name) is None, 5)
        assertions.append(assertion("job_closed", closed, _job_flags_detail(job_limit_flags(job_name))))
        assertions.append(assertion(
            "failure_logged",
            "closing the Job" in run.tail(120) or "TUI exited with code" in run.tail(120),
            run.tail(5),
        ))
        if verbose:
            log(run.tail(80))
        return assertions
    finally:
        ctx.cleanup()


def case_job_kill(base: Path, verbose: bool) -> list[dict[str, Any]]:
    ctx = CaseContext(base, "job_kill", fake_agent_state=base / "job_kill" / "fake-agent")
    assertions: list[dict[str, Any]] = []
    try:
        orchestrator_port = free_port()
        worker_port = free_port()
        job_name = _job_name("kill")
        plan = build_plan(
            ctx,
            job_name,
            make_http_child(ctx, "orchestrator", "orchestrator", orchestrator_port),
            make_http_child(ctx, "worker", "worker", worker_port),
            make_tui_child(ctx, exit_code=0, delay=300.0),
            orchestrator_port=orchestrator_port,
            worker_port=worker_port,
        )
        run = SupervisorRun(ctx, plan)
        run.start()

        ready = wait_until(
            lambda: all(
                (ctx.state / name / "ready.json").exists()
                for name in ("orchestrator", "worker")
            ) and (ctx.state / "tui" / "started.json").exists()
            and (ctx.run / "supervisor.pid").exists(),
            25,
        )
        if not ready:
            raise RuntimeError("stack did not become ready\n" + run.tail())
        flags = job_limit_flags(job_name)
        pids = plan_pids(plan)
        real_pids = child_real_pids(ctx)
        supervisor_pid = run.process.pid if run.process is not None else None
        run.kill()

        supervisor_gone = wait_until(lambda: not pid_alive(supervisor_pid), 10)
        gone, alive = all_gone(merged_pids(pids, real_pids), 15)
        assertions.append(assertion("supervisor_terminated", supervisor_gone, f"pid={supervisor_pid}"))
        assertions.append(assertion(
            "job_kill_on_job_close",
            flags is not None and bool(flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE),
            _job_flags_detail(flags),
        ))
        assertions.append(assertion("tui_killed_by_job", not alive.get("tui"), f"alive={alive}"))
        assertions.append(assertion("orchestrator_killed_by_job", not alive.get("orchestrator"), f"alive={alive}"))
        assertions.append(assertion("worker_killed_by_job", not alive.get("worker"), f"alive={alive}"))
        assertions.append(assertion("no_orphans", gone, f"alive={alive}"))
        closed = wait_until(lambda: job_limit_flags(job_name) is None, 10)
        assertions.append(assertion("job_closed", closed, _job_flags_detail(job_limit_flags(job_name))))
        # A hard-killed supervisor cannot remove its own PID files. The CLI
        # tolerates them through its liveness check; record the observation.
        stale = [str(path) for path in ctx.run.glob("*.pid") if path.exists()]
        assertions.append(assertion(
            "hard_kill_stale_pid_files",
            True,
            f"remaining after hard kill (expected, liveness-gated): {stale}",
        ))
        if verbose:
            log(run.tail(80))
        return assertions
    finally:
        ctx.cleanup()


def case_job_startup_failure(base: Path, verbose: bool) -> list[dict[str, Any]]:
    ctx = CaseContext(base, "job_startup_failure", fake_agent_state=base / "job_startup_failure" / "fake-agent")
    assertions: list[dict[str, Any]] = []
    try:
        orchestrator_port = free_port()
        worker_port = free_port()
        job_name = _job_name("startup-failure")
        plan = build_plan(
            ctx,
            job_name,
            make_http_child(ctx, "orchestrator", "orchestrator", orchestrator_port),
            make_fail_child(ctx, "worker", worker_port),
            make_tui_child(ctx, exit_code=0, delay=0.1),
            orchestrator_port=orchestrator_port,
            worker_port=worker_port,
        )
        run = SupervisorRun(ctx, plan)
        run.start()
        code = run.wait(30)

        assertions.append(assertion("supervisor_exit_one", code == 1, f"exit code {code}"))
        assertions.append(assertion(
            "startup_failure_logged",
            "exited during startup" in run.tail(120),
            run.tail(5),
        ))
        orchestrator_pid = None
        worker_pid = None
        for child in plan["children"]:
            path = Path(child.get("pid") or "")
            if path.name == "orchestrator.pid":
                try:
                    orchestrator_pid = int(read_text(path).strip())
                except ValueError:
                    orchestrator_pid = None
            if path.name == "worker.pid":
                try:
                    worker_pid = int(read_text(path).strip())
                except ValueError:
                    worker_pid = None
        # Pid files may already be removed by the supervisor's finally block,
        # so also inspect the runtime state written by the dummy child.
        if orchestrator_pid is None:
            ready = read_json(ctx.state / "orchestrator" / "ready.json") or {}
            orchestrator_pid = ready.get("pid") if isinstance(ready, dict) else None
        assertions.append(assertion(
            "orchestrator_stopped",
            not pid_alive(orchestrator_pid),
            f"pid={orchestrator_pid}",
        ))
        assertions.append(assertion(
            "worker_never_ready",
            not (ctx.state / "worker" / "ready.json").exists(),
            f"worker pid file value={worker_pid}",
        ))
        assertions.append(assertion(
            "tui_never_started",
            not (ctx.state / "tui" / "started.json").exists(),
            "TUI must not start when a prerequisite fails",
        ))
        fake_args = [row.get("args") for row in ctx.fake_calls()]
        assertions.append(assertion(
            "no_daemon_shutdown_on_startup_failure",
            not any(isinstance(args, list) and args[:1] == ["shutdown"] for args in fake_args),
            f"calls={fake_args}",
        ))
        pid_files = [Path(child["pid"]) for child in plan["children"] if child.get("pid")]
        supervisor_pid_file = Path(plan["supervisor_pid_path"])
        stale = [str(path) for path in [*pid_files, supervisor_pid_file] if path.exists()]
        assertions.append(assertion("pid_files_cleaned", not stale, f"remaining={stale}"))
        closed = wait_until(lambda: job_limit_flags(job_name) is None, 5)
        assertions.append(assertion("job_closed", closed, _job_flags_detail(job_limit_flags(job_name))))
        if verbose:
            log(run.tail(80))
        return assertions
    finally:
        ctx.cleanup()


# ---------------------------------------------------------------------------
# daemon lifecycle case
# ---------------------------------------------------------------------------

def canonical_socket(path: Path | str) -> str:
    text = os.path.abspath(os.fspath(path))
    if os.name == "nt":
        text = os.path.normcase(text)
    return text


def worker_env(
    home: Path,
    fake_agent: Path,
    orchestrator_url: str,
    socket_value: str,
    port: int,
    worker_id: str,
    token: str,
) -> dict[str, str]:
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("PI_", "PRIME_AGENT_", "RLM_", "SUPER_RLM_"))
    }
    env.update({
        "SUPER_RLM_HOME": str(home),
        "SUPER_RLM_WORKSPACES": str(home / "workspaces"),
        "SUPER_RLM_ORCHESTRATOR_URL": orchestrator_url,
        "SUPER_RLM_WORKER_HOST": "127.0.0.1",
        "SUPER_RLM_WORKER_PORT": str(port),
        "SUPER_RLM_WORKER_ID": worker_id,
        "SUPER_RLM_WORKER_TOKEN": token,
        "SUPER_RLM_CALLBACK_KEY": "regression-callback-key",
        "SUPER_RLM_PRIME_AGENT": str(fake_agent),
        "SUPER_RLM_PRIME_DAEMON": socket_value,
        "SUPER_RLM_KERNEL_VENV": str(home / "kernel"),
        "SUPER_RLM_KERNEL_PYTHON": str(home / "kernel" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")),
        "SUPER_RLM_PRIME_PROVIDER": "fake",
        "SUPER_RLM_PRIME_MODEL": "fake-1",
        "SUPER_RLM_DAEMON_AUTOSTART": "1",
        "SUPER_RLM_DAEMON_START_TIMEOUT_S": "15",
        "SUPER_RLM_DAEMON_COMMAND_TIMEOUT_S": "15",
        "SUPER_RLM_DAEMON_SHUTDOWN_TIMEOUT_S": "15",
        "SUPER_RLM_HEARTBEAT_INTERVAL_S": "1",
        "SUPER_RLM_ASSIGNMENT_HEARTBEAT_INTERVAL_S": "1",
        "SUPER_RLM_MAX_CONCURRENCY": "1",
        "SUPER_RLM_REPORT_SKILL": str(WORKER_DIR / "skills" / "super-rlm-report"),
        "SUPER_RLM_WORKER_PROMPT": str(WORKER_DIR / "prompts" / "worker.md"),
    })
    return env


class WorkerProcess:
    def __init__(self, context: CaseContext, env: dict[str, str], port: int, label: str) -> None:
        self.context = context
        self.env = env
        self.port = port
        self.label = label
        self.log_path = context.logs / f"{label}.log"
        self.process: subprocess.Popen[bytes] | None = None
        self._log_handle = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> None:
        self._log_handle = open(self.log_path, "ab", buffering=0)
        self.process = subprocess.Popen(
            [str(WORKER_PYTHON), "-m", "super_rlm_worker.main"],
            cwd=str(WORKER_DIR),
            env=self.env,
            stdin=subprocess.DEVNULL,
            stdout=self._log_handle,
            stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.context.track(self.process)
        self.context.track_pid(self.process.pid)

    def wait_healthy(self, timeout: float = 45.0) -> bool:
        return wait_until(lambda: http_ok(f"{self.url}/v1/health", timeout=1.0), timeout)

    def wait_exit(self, timeout: float = 30.0) -> int:
        if self.process is None:
            raise RuntimeError("worker was not started")
        return int(self.process.wait(timeout=timeout))

    def kill(self) -> None:
        if self.process is not None and self.process.poll() is None:
            self.process.kill()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass

    def tail(self, lines: int = 60) -> str:
        return tail(self.log_path, lines)


def fake_agent_state(ctx: CaseContext) -> dict[str, Any]:
    if ctx.fake_agent_state is None:
        return {}
    value = read_json(ctx.fake_agent_state / "state.json")
    return value if isinstance(value, dict) else {}


def fake_agent_calls(ctx: CaseContext) -> list[list[str]]:
    calls: list[list[str]] = []
    for row in ctx.fake_calls():
        args = row.get("args")
        if isinstance(args, list):
            calls.append([str(item) for item in args])
    return calls


def daemon_start_calls(ctx: CaseContext) -> list[list[str]]:
    return [args for args in fake_agent_calls(ctx) if args[:2] == ["--mode", "daemon"]]


def daemon_shutdown_calls(ctx: CaseContext) -> list[list[str]]:
    return [args for args in fake_agent_calls(ctx) if args[:1] == ["shutdown"]]


def daemon_stop_calls(ctx: CaseContext) -> list[list[str]]:
    return [args for args in fake_agent_calls(ctx) if args[:1] == ["stop"]]


def run_fake_agent(ctx: CaseContext, args: list[str], socket_value: str) -> subprocess.CompletedProcess[str]:
    if ctx.fake_agent is None:
        raise RuntimeError("fake prime-agent is not configured")
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("PI_", "PRIME_AGENT_", "RLM_"))
    }
    env["PRIME_AGENT_DAEMON_SOCKET"] = socket_value
    return subprocess.run(
        [str(ctx.fake_agent), *args],
        cwd=str(ctx.dir),
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        check=False,
    )


def case_daemon_lifecycle(base: Path, verbose: bool) -> list[dict[str, Any]]:
    ctx = CaseContext(base, "daemon_lifecycle", fake_agent_state=base / "daemon_lifecycle" / "fake-agent")
    assertions: list[dict[str, Any]] = []
    workers: list[WorkerProcess] = []
    try:
        home = ctx.dir / "home"
        socket_path = home / "prime" / "daemon" / "worker.sock"
        expected_socket = canonical_socket(socket_path)
        token = "regression-worker-token"

        ctx.fake_orchestrator = FakeOrchestrator()
        ctx.fake_orchestrator.start()
        orchestrator_url = ctx.fake_orchestrator.url

        # Worker 1 starts the daemon.
        port1 = free_port()
        worker1 = WorkerProcess(
            ctx,
            worker_env(home, ctx.fake_agent, orchestrator_url, str(socket_path), port1, "wrk_reg_1", token),
            port1,
            "worker1",
        )
        workers.append(worker1)
        worker1.start()
        if not worker1.wait_healthy():
            raise RuntimeError("Worker 1 did not become healthy\n" + worker1.tail())
        state = fake_agent_state(ctx)
        starts = daemon_start_calls(ctx)
        daemon_pid = state.get("pid")
        ctx.track_pid(daemon_pid if isinstance(daemon_pid, int) else None)

        assertions.append(assertion(
            "worker_started_daemon",
            len(starts) == 1 and state.get("running") is True,
            f"starts={starts} state_running={state.get('running')}",
        ))
        assertions.append(assertion(
            "daemon_uses_canonical_socket",
            state.get("socket") == expected_socket
            and len(starts) == 1
            and starts[0][2:] == ["--daemon-socket", expected_socket],
            f"state_socket={state.get('socket')} expected={expected_socket}",
        ))
        assertions.append(assertion(
            "daemon_process_alive",
            pid_alive(daemon_pid if isinstance(daemon_pid, int) else None),
            f"daemon pid={daemon_pid}",
        ))
        heads = {args[0] for args in fake_agent_calls(ctx)}
        assertions.append(assertion(
            "no_model_prompts",
            heads <= {"status", "--mode", "shutdown", "stop"},
            f"command heads={sorted(heads)}",
        ))

        # Worker 2 sees the same daemon through a deliberately non-canonical
        # spelling and must reuse it.
        odd_socket = str(socket_path.parent / ".." / socket_path.parent.name / socket_path.name)
        odd_socket = odd_socket.replace("\\", "/")
        port2 = free_port()
        worker2 = WorkerProcess(
            ctx,
            worker_env(home, ctx.fake_agent, orchestrator_url, odd_socket, port2, "wrk_reg_2", token),
            port2,
            "worker2",
        )
        workers.append(worker2)
        worker2.start()
        if not worker2.wait_healthy():
            raise RuntimeError("Worker 2 did not become healthy\n" + worker2.tail())
        state_after_reuse = fake_agent_state(ctx)
        starts_after_reuse = daemon_start_calls(ctx)
        calls = ctx.fake_calls()
        socket_values = {row.get("socket") for row in calls if isinstance(row.get("socket"), str)}
        assertions.append(assertion(
            "canonical_socket_reuse",
            len(starts_after_reuse) == 1
            and state_after_reuse.get("pid") == daemon_pid
            and socket_values == {expected_socket},
            f"starts={len(starts_after_reuse)} pid={state_after_reuse.get('pid')} "
            f"call_sockets={sorted(socket_values)} odd_input={odd_socket!r}",
        ))

        # Killing the Workers must not kill the detached daemon.
        worker1.kill()
        worker2.kill()
        wait_until(lambda: not pid_alive(workers[0].process.pid if workers[0].process else None), 5)
        state_after_worker_exit = fake_agent_state(ctx)
        assertions.append(assertion(
            "daemon_survives_worker_exit",
            state_after_worker_exit.get("running") is True
            and pid_alive(daemon_pid if isinstance(daemon_pid, int) else None),
            f"state={state_after_worker_exit.get('running')} daemon_pid_alive="
            f"{pid_alive(daemon_pid if isinstance(daemon_pid, int) else None)}",
        ))

        # Worker 3 reuses the daemon, then explicitly shuts down the daemon
        # with zero sessions. Shutdown must use `shutdown`, not `stop`.
        port3 = free_port()
        worker3 = WorkerProcess(
            ctx,
            worker_env(home, ctx.fake_agent, orchestrator_url, str(socket_path), port3, "wrk_reg_3", token),
            port3,
            "worker3",
        )
        workers.append(worker3)
        worker3.start()
        if not worker3.wait_healthy():
            raise RuntimeError("Worker 3 did not become healthy\n" + worker3.tail())
        before_shutdown = fake_agent_state(ctx)
        assertions.append(assertion(
            "zero_session_daemon",
            before_shutdown.get("sessions") == [],
            f"sessions={before_shutdown.get('sessions')}",
        ))
        http_json("POST", f"{worker3.url}/v1/shutdown", token, {})
        try:
            exit_code = worker3.wait_exit(30)
        except subprocess.TimeoutExpired:
            exit_code = None
        stopped = wait_until(
            lambda: fake_agent_state(ctx).get("running") is False
            and not pid_alive(daemon_pid if isinstance(daemon_pid, int) else None),
            10,
        )
        shutdowns = daemon_shutdown_calls(ctx)
        stops = daemon_stop_calls(ctx)
        assertions.append(assertion(
            "worker_graceful_exit",
            exit_code == 0,
            f"exit code {exit_code}" + (f"\n{worker3.tail(20)}" if exit_code != 0 else ""),
        ))
        assertions.append(assertion(
            "explicit_daemon_shutdown",
            stopped and len(shutdowns) == 1,
            f"stopped={stopped} shutdown_calls={shutdowns}",
        ))
        assertions.append(assertion(
            "shutdown_not_stop",
            len(stops) == 0,
            f"stop_calls={stops}",
        ))
        status_result = run_fake_agent(ctx, ["status", "--json"], expected_socket)
        assertions.append(assertion(
            "status_empty_after_shutdown",
            status_result.returncode == 0 and (status_result.stdout or "").strip() == "[]",
            f"exit={status_result.returncode} stdout={status_result.stdout!r} stderr={status_result.stderr[-300:]!r}",
        ))

        # `prime-agent stop <session>` semantics through the product code.
        state = fake_agent_state(ctx)
        state["running"] = True
        state["sessions"] = ["sess_regression"]
        (ctx.fake_agent_state / "state.json").write_text(json.dumps(state), encoding="utf-8")
        sys.path.insert(0, str(WORKER_SRC))
        from super_rlm_worker.config import WorkerConfig  # noqa: PLC0415
        from super_rlm_worker.daemon import PrimeDaemon  # noqa: PLC0415

        config = WorkerConfig.from_env({
            "SUPER_RLM_HOME": str(home),
            "SUPER_RLM_PRIME_AGENT": str(ctx.fake_agent),
            "SUPER_RLM_KERNEL_VENV": str(home / "kernel"),
            "SUPER_RLM_PRIME_DAEMON": expected_socket,
            "SUPER_RLM_WORKER_TOKEN": token,
            "SUPER_RLM_CALLBACK_KEY": "regression-callback-key",
            "SUPER_RLM_DAEMON_COMMAND_TIMEOUT_S": "15",
            "SUPER_RLM_DAEMON_SHUTDOWN_TIMEOUT_S": "15",
        })

        async def stop_twice() -> tuple[bool, bool]:
            daemon = PrimeDaemon(config)
            first = await daemon.stop_session("sess_regression")
            second = await daemon.stop_session("sess_regression")
            return first, second

        first_stop, second_stop = asyncio.run(stop_twice())
        stop_calls = daemon_stop_calls(ctx)
        assertions.append(assertion(
            "stop_session_active",
            first_stop is True and stop_calls and stop_calls[-2][:3] == ["stop", "sess_regression", "--json"],
            f"first={first_stop} calls={stop_calls}",
        ))
        assertions.append(assertion(
            "stop_session_unknown_is_idempotent",
            second_stop is False and len(stop_calls) >= 2,
            f"second={second_stop} calls={stop_calls}",
        ))
        if verbose:
            log(worker1.tail(40))
            log(worker3.tail(40))
        return assertions
    finally:
        for worker in workers:
            worker.kill()
        ctx.cleanup()


# ---------------------------------------------------------------------------
# optional real prime-agent admin smoke (no model, isolated socket)
# ---------------------------------------------------------------------------

def case_real_prime_admin(base: Path, verbose: bool) -> list[dict[str, Any]]:
    ctx = CaseContext(base, "real_prime_admin")
    assertions: list[dict[str, Any]] = []
    try:
        if not PRIME_AGENT.exists():
            return [assertion("prime_agent_available", False, f"not found: {PRIME_AGENT}")]
        home = ctx.dir / "home"
        home.mkdir(parents=True, exist_ok=True)
        socket_value = canonical_socket(home / "prime" / "daemon" / "worker.sock")
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("PI_", "PRIME_AGENT_", "RLM_"))
        }
        env.update({
            "PRIME_AGENT_CODING_AGENT_DIR": str(home / "agent"),
            "PRIME_AGENT_CODING_AGENT_SESSION_DIR": str(home / "sessions"),
            "PRIME_AGENT_SESSION_DIR": str(home / "sessions"),
            "PRIME_AGENT_DAEMON_SOCKET": socket_value,
            "PRIME_AGENT_TELEMETRY": "0",
            "DO_NOT_TRACK": "1",
        })

        def run_admin(args: list[str]) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [str(PRIME_AGENT), *args],
                cwd=str(ctx.dir),
                env=env,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=30,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                check=False,
            )

        status = run_admin(["status", "--json"])
        try:
            status_payload = json.loads((status.stdout or status.stderr).strip() or "null")
        except ValueError:
            status_payload = None
        assertions.append(assertion(
            "real_status_json",
            status.returncode == 0 and isinstance(status_payload, (list, dict)),
            f"exit={status.returncode} stdout={status.stdout[:300]!r} stderr={status.stderr[:300]!r}",
        ))

        shutdown = run_admin(["shutdown", "--force", "--json"])
        try:
            shutdown_payload = json.loads((shutdown.stdout or shutdown.stderr).strip() or "null")
        except ValueError:
            shutdown_payload = None
        assertions.append(assertion(
            "real_shutdown_clean",
            shutdown.returncode == 0
            and isinstance(shutdown_payload, dict)
            and not shutdown_payload.get("failed"),
            f"exit={shutdown.returncode} payload={shutdown_payload}",
        ))

        stop_missing = run_admin(["stop", "sess_regression_missing", "--json"])
        detail = (stop_missing.stderr or stop_missing.stdout).lower()
        assertions.append(assertion(
            "real_stop_targets_isolated_socket",
            stop_missing.returncode != 0 and ("daemon" in detail or socket_value.lower() in detail),
            f"exit={stop_missing.returncode} detail={detail[-400:]!r}",
        ))
        assertions.append(assertion(
            "real_admin_no_model_calls",
            True,
            "only status/shutdown/stop were invoked; no ACP or prompt command",
        ))
        if verbose:
            log(f"real prime-agent home: {home}")
        return assertions
    finally:
        ctx.cleanup()


# ---------------------------------------------------------------------------
# runner
# ---------------------------------------------------------------------------

CASE_FUNCTIONS: dict[str, Callable[[Path, bool], list[dict[str, Any]]]] = {
    "job_graceful": case_job_graceful,
    "job_failure": case_job_failure,
    "job_kill": case_job_kill,
    "job_startup_failure": case_job_startup_failure,
    "daemon_lifecycle": case_daemon_lifecycle,
    REAL_PRIME_CASE: case_real_prime_admin,
}

CASE_TITLES = {
    "job_graceful": "Job: TUI exit 0 runs graceful shutdown",
    "job_failure": "Job: TUI nonzero closes Job with terminate",
    "job_kill": "Job: killed supervisor kills its children",
    "job_startup_failure": "Job: startup failure leaves no orphan",
    "daemon_lifecycle": "Daemon: Worker startup, reuse, shutdown, stop",
    REAL_PRIME_CASE: "Real prime-agent: isolated status/shutdown/stop admin",
}


def run_one_case(name: str, base: Path, verbose: bool) -> dict[str, Any]:
    started = time.monotonic()
    log(f"[RUN ] {name}: {CASE_TITLES[name]}")
    error: str | None = None
    try:
        assertions = CASE_FUNCTIONS[name](base, verbose)
    except KeyboardInterrupt:
        raise
    except Exception as exc:  # noqa: BLE001 - one case failure must not stop the rest
        error = f"{type(exc).__name__}: {exc}"
        assertions = [assertion("case_completed_without_exception", False, error)]
        if verbose:
            log(traceback.format_exc())
    ok = bool(assertions) and all(item["ok"] for item in assertions)
    duration = time.monotonic() - started
    label = "PASS" if ok else "FAIL"
    log(f"[{label}] {name} ({duration:.1f}s)")
    for item in assertions:
        mark = "ok" if item["ok"] else "FAIL"
        detail = f": {item['detail']}" if item.get("detail") else ""
        log(f"  [{mark}] {item['name']}{detail}")
    return {
        "case": name,
        "title": CASE_TITLES[name],
        "ok": ok,
        "duration_s": round(duration, 2),
        "assertions": assertions,
        "error": error,
    }


def preflight() -> str | None:
    if os.name != "nt":
        return "this regression harness needs Windows Job Objects"
    if not SUPERVISOR.exists():
        return f"supervisor helper not found: {SUPERVISOR}"
    if not WORKER_PYTHON.exists():
        return (
            f"Worker venv not found: {WORKER_PYTHON}. "
            "Run: cd apps/worker && uv venv --python 3.11 .venv && "
            'uv pip install --python .venv/Scripts/python.exe -e ".[dev]"'
        )
    if not WORKER_SRC.exists():
        return f"Worker source not found: {WORKER_SRC}"
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--case",
        action="append",
        choices=ALL_CASES,
        dest="cases",
        help="run only this case (repeatable)",
    )
    parser.add_argument("--verbose", action="store_true", help="print child logs and tracebacks")
    parser.add_argument(
        "--real-prime",
        action="store_true",
        help="also run the opt-in real prime-agent admin smoke (isolated socket, no model)",
    )
    parser.add_argument("--keep-temp", action="store_true", help="keep the temporary run directory")
    parser.add_argument(
        "--clean-temp",
        action="store_true",
        help="remove the temporary run directory even when a case fails",
    )
    parser.add_argument(
        "--temp-root",
        help="put case directories under this existing directory instead of a new temp directory",
    )
    args = parser.parse_args(argv)

    problem = preflight()
    if problem:
        log(f"[FAIL] setup: {problem}")
        print(json.dumps({"ok": False, "error": problem, "cases": []}, indent=2))
        return 2

    selected = args.cases or [name for name in ALL_CASES if name != REAL_PRIME_CASE]
    if args.real_prime and REAL_PRIME_CASE not in selected:
        selected.append(REAL_PRIME_CASE)
    # Keep the order stable even when the user repeats or reorders --case.
    selected = [name for name in ALL_CASES if name in selected]
    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"_{os.getpid()}"
    if args.temp_root:
        parent = Path(args.temp_root)
        parent.mkdir(parents=True, exist_ok=True)
        base = Path(tempfile.mkdtemp(prefix="super-rlm-lifecycle-", dir=parent))
    else:
        base = Path(tempfile.mkdtemp(prefix="super-rlm-lifecycle-"))
    log(f"[info] run {run_id}")
    log(f"[info] temp {base}")
    log(f"[info] cases: {', '.join(selected)}")

    results: list[dict[str, Any]] = []
    try:
        for name in selected:
            results.append(run_one_case(name, base, args.verbose))
    except KeyboardInterrupt:
        log("[warn] interrupted; child processes were cleaned up per case")
        summary = {
            "ok": False,
            "run_id": run_id,
            "temp_dir": str(base),
            "interrupted": True,
            "cases": results,
        }
        print(json.dumps(summary, indent=2))
        return 130

    ok = all(result["ok"] for result in results) and len(results) == len(selected)
    summary = {
        "ok": ok,
        "run_id": run_id,
        "temp_dir": str(base),
        "cases": results,
    }
    print(json.dumps(summary, indent=2))
    log(f"[{'PASS' if ok else 'FAIL'}] {sum(1 for r in results if r['ok'])}/{len(results)} cases passed")

    remove = args.clean_temp or (ok and not args.keep_temp)
    if remove:
        try:
            shutil.rmtree(base, ignore_errors=True)
            log(f"[info] removed {base}")
        except OSError:
            pass
    else:
        log(f"[info] kept {base} for diagnostics")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
