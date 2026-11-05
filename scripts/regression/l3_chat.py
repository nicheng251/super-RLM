#!/usr/bin/env python3
"""Manual L3 Chat live end-to-end harness for super-RLM.

This script starts a local Orchestrator and Worker, starts Pi in RPC mode with
the super-RLM Router extension, sends one real Chat prompt, waits for the Router
to delegate it, and verifies the Worker's file reaches the launch directory.

It is an explicit/manual test: it is not imported by the unit suites and it
spends real DeepSeek API money when run.

Usage:
    python scripts/regression/l3_chat.py --help
    python scripts/regression/l3_chat.py --kernel-venv <path-to-kernel-venv>

The JSON summary is printed to stdout. Progress and diagnostics go to stderr.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import secrets
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]

# The harness reuses the plain HTTP and process helpers from the direct
# Orchestrator regression harness. Both files live in the same directory.
sys.path.insert(0, str(SCRIPT_DIR))

from real_model import (  # noqa: E402
    DEFAULT_HOME,
    MODEL,
    PROVIDER,
    ROUTER_TOKEN,
    TERMINAL_TASK_STATUSES,
    HarnessError,
    Service,
    base_env,
    http_json,
    load_deepseek_key,
    log,
    orchestrator_env,
    validate_runtime,
    wait_health,
    worker_env,
)

SESSION_ID = "super-rlm-l3-chat-e2e"
EXPECTED_CONTENT = "hello from l3 chat"
CHAT_TURN_TIMEOUT_S = 180.0
WORKER_REGISTER_TIMEOUT_S = 30.0
POLL_INTERVAL_S = 1.0
_TIMEOUT = object()


@dataclass(frozen=True)
class Options:
    home: Path
    orchestrator_port: int
    worker_port: int
    timeout: float
    kernel_venv: Path
    log_dir: Path
    run_id: str

    @property
    def repo_root(self) -> Path:
        return REPO_ROOT

    @property
    def orchestrator_url(self) -> str:
        return f"http://127.0.0.1:{self.orchestrator_port}"

    @property
    def worker_url(self) -> str:
        return f"http://127.0.0.1:{self.worker_port}"

    @property
    def kernel_python(self) -> Path:
        return self.kernel_venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

    @property
    def prime_agent(self) -> Path:
        name = "prime-agent.exe" if os.name == "nt" else "prime-agent"
        return self.repo_root / "runtime" / "prime-agent" / name

    @property
    def worker_python(self) -> Path:
        return self.repo_root / "apps" / "worker" / ".venv" / (
            "Scripts/python.exe" if os.name == "nt" else "bin/python"
        )

    @property
    def report_skill(self) -> Path:
        return self.repo_root / "apps" / "worker" / "skills" / "super-rlm-report"

    @property
    def worker_prompt(self) -> Path:
        return self.repo_root / "apps" / "worker" / "prompts" / "worker.md"

    @property
    def pi_cli(self) -> Path:
        return (
            self.repo_root
            / "runtime"
            / "pi"
            / "node_modules"
            / "@earendil-works"
            / "pi-coding-agent"
            / "dist"
            / "bundle"
            / "cli.js"
        )

    @property
    def router_extension(self) -> Path:
        return self.repo_root / "apps" / "router" / "extensions" / "super-rlm.ts"

    @property
    def router_prompt(self) -> Path:
        return self.repo_root / "apps" / "router" / "prompts" / "router.md"

    @property
    def origin_dir(self) -> Path:
        return self.log_dir / "origin"

    @property
    def pi_log(self) -> Path:
        return self.log_dir / "pi.log"


def _require_file(path: Path, description: str, hint: str = "") -> None:
    if not path.exists():
        detail = f"{description} not found: {path}"
        if hint:
            detail += f" ({hint})"
        raise HarnessError(detail)


def _clip(value: Any, limit: int = 2000) -> Any:
    if value is None:
        return None
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    if len(text) <= limit:
        return text
    return text[:limit] + "...<truncated>"


def _assertion(name: str, ok: bool, detail: str = "") -> dict[str, Any]:
    return {"name": name, "ok": bool(ok), "detail": detail}


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            completed = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        except OSError:
            return True
        return str(pid) in (completed.stdout or "")
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _check_single_instance(options: Options) -> None:
    lock = options.home / "orchestrator" / "orchestrator.lock"
    if not lock.exists():
        return
    try:
        pid = int(lock.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return
    if _pid_alive(pid):
        raise HarnessError(
            f"Orchestrator is already running with pid {pid} for home {options.home}. "
            "Stop it with `super-rlm down` (or point --home at a disposable test home) "
            "before running this harness."
        )


def validate_chat_runtime(options: Options) -> None:
    _require_file(
        options.pi_cli,
        "Pi CLI bundle",
        "run `npm install` in apps/router or restore runtime/pi",
    )
    _require_file(options.router_extension, "super-RLM Router extension")
    _require_file(
        options.router_prompt,
        "Router system prompt",
        "the L3 TUI appends apps/router/prompts/router.md",
    )
    _require_file(
        options.home / "pi" / "agent" / "models.json",
        "Pi model registry",
        "run `super-rlm models sync` for this project",
    )
    _check_single_instance(options)


def _message_text(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return ""


def _tool_result_text(result: Any) -> str:
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = [
                block.get("text", "")
                for block in content
                if isinstance(block, dict)
                and block.get("type") == "text"
                and isinstance(block.get("text"), str)
            ]
            return "".join(parts)
    if result is None:
        return ""
    return json.dumps(result, ensure_ascii=False)


def _parse_tool_json(result: Any) -> Any:
    text = _tool_result_text(result).strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _content_matches(text: str) -> bool:
    """Accept the requested text with zero or one trailing newline."""
    if text.endswith("\r\n"):
        text = text[:-2]
    elif text.endswith("\n"):
        text = text[:-1]
    return text == EXPECTED_CONTENT


def _is_hello_path(value: Any) -> bool:
    if not isinstance(value, (str, os.PathLike)):
        return False
    name = Path(str(value)).name
    return name == "hello.txt" or (name.startswith("hello.super-rlm-") and name.endswith(".txt"))


def _reports_hello(result: dict[str, Any]) -> bool:
    artifacts = result.get("artifacts")
    if not isinstance(artifacts, list):
        return False
    return any(isinstance(item, dict) and _is_hello_path(item.get("path")) for item in artifacts)


def _records_hello(result: dict[str, Any]) -> bool:
    delivered = result.get("delivered_to")
    if not isinstance(delivered, list):
        return False
    for item in delivered:
        if _is_hello_path(item):
            return True
        if isinstance(item, str):
            try:
                path = Path(item)
                if path.is_dir() and (path / "hello.txt").is_file():
                    return True
            except OSError:
                continue
    return False


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def _find_delivered_file(origin: Path, result: dict[str, Any]) -> Path | None:
    candidates: list[Path] = []
    for item in result.get("delivered_to") or []:
        if isinstance(item, str):
            candidates.append(Path(item))
    candidates.append(origin / "hello.txt")
    for pattern in ("hello.txt", "hello.super-rlm-*.txt"):
        try:
            candidates.extend(origin.rglob(pattern))
        except OSError:
            pass
    for candidate in candidates:
        try:
            if candidate.is_file() and _inside(candidate, origin):
                return candidate
        except OSError:
            continue
    return None


class PiProcess:
    """Minimal JSONL RPC client for a long-lived Pi process."""

    def __init__(
        self,
        command: list[str],
        cwd: Path,
        env: dict[str, str],
        log_path: Path,
    ) -> None:
        self.command = command
        self.cwd = cwd
        self.env = env
        self.log_path = log_path
        self.process: subprocess.Popen[bytes] | None = None
        self.events: queue.Queue[Any] = queue.Queue()
        self.responses: dict[str, dict[str, Any]] = {}
        self.response_events: dict[str, threading.Event] = {}
        self.parse_errors: list[str] = []
        self._counter = 0
        self._write_lock = threading.Lock()
        self._closed = threading.Event()
        self._reader: threading.Thread | None = None
        self._log_handle: Any = None

    def start(self) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._log_handle = self.log_path.open("wb")
        kwargs: dict[str, Any] = {}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        self.process = subprocess.Popen(
            self.command,
            cwd=str(self.cwd),
            env=self.env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._log_handle,
            **kwargs,
        )
        self._reader = threading.Thread(target=self._read_stdout, name="pi-rpc-reader", daemon=True)
        self._reader.start()

    def _read_stdout(self) -> None:
        stdout = self.process.stdout if self.process is not None else None
        if stdout is None:
            self._closed.set()
            self.events.put(None)
            return
        try:
            while True:
                raw = stdout.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as exc:
                    self.parse_errors.append(f"{exc}: {line[:300]}")
                    continue
                if not isinstance(record, dict):
                    continue
                if record.get("type") == "response":
                    request_id = record.get("id")
                    if isinstance(request_id, str):
                        self.responses[request_id] = record
                        waiter = self.response_events.get(request_id)
                        if waiter is not None:
                            waiter.set()
                        continue
                self.events.put(record)
        except Exception as exc:  # noqa: BLE001 - surface reader failures in the summary
            self.parse_errors.append(f"reader: {type(exc).__name__}: {exc}")
        finally:
            self._closed.set()
            self.events.put(None)

    def _write(self, command: dict[str, Any]) -> None:
        payload = json.dumps(command, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        with self._write_lock:
            process = self.process
            if process is None or process.stdin is None:
                raise HarnessError("Pi process is not running")
            try:
                process.stdin.write(payload)
                process.stdin.flush()
            except OSError as exc:
                raise HarnessError(f"could not write to Pi stdin: {exc}") from exc

    def _new_id(self, prefix: str) -> str:
        self._counter += 1
        return f"{prefix}-{self._counter}"

    def request_raw(self, command: dict[str, Any], timeout: float) -> dict[str, Any]:
        request_id = command.get("id")
        if not isinstance(request_id, str) or not request_id:
            request_id = self._new_id(str(command.get("type") or "req"))
            command["id"] = request_id
        waiter = threading.Event()
        self.response_events[request_id] = waiter
        try:
            self._write(command)
            deadline = time.monotonic() + timeout
            while True:
                if waiter.wait(0.1):
                    break
                if self._closed.is_set():
                    raise HarnessError(
                        f"Pi exited while waiting for {command.get('type')}; "
                        f"see {self.log_path}"
                    )
                if time.monotonic() >= deadline:
                    raise HarnessError(
                        f"Pi did not answer {command.get('type')} within {timeout:g}s; "
                        f"see {self.log_path}"
                    )
            return self.responses.pop(request_id)
        finally:
            self.response_events.pop(request_id, None)

    def request(self, command: dict[str, Any], timeout: float) -> dict[str, Any]:
        response = self.request_raw(command, timeout)
        if not response.get("success"):
            raise HarnessError(
                f"Pi rejected {command.get('type')}: {response.get('error') or response}"
            )
        data = response.get("data")
        return data if isinstance(data, dict) else {}

    def next_event(self, timeout: float) -> Any:
        try:
            return self.events.get(timeout=timeout)
        except queue.Empty:
            return _TIMEOUT

    def log_tail(self, limit: int = 2000) -> str:
        try:
            text = self.log_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""
        return text[-limit:]

    def stop(self) -> None:
        process = self.process
        if process is not None and process.poll() is None:
            try:
                if process.stdin is not None:
                    process.stdin.close()
            except OSError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=False,
                        timeout=15,
                    )
                else:
                    process.kill()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
        if self._log_handle is not None:
            try:
                self._log_handle.close()
            except OSError:
                pass
            self._log_handle = None


def pi_env(options: Options, api_key: str, origin: Path) -> dict[str, str]:
    env = base_env()
    env.update(
        {
            "PI_CODING_AGENT_DIR": str(options.home / "pi" / "agent"),
            "PI_CODING_AGENT_SESSION_DIR": str(options.home / "pi" / "sessions"),
            "SUPER_RLM_HOME": str(options.home),
            "SUPER_RLM_ORCHESTRATOR_URL": options.orchestrator_url,
            "SUPER_RLM_ROUTER_TOKEN": ROUTER_TOKEN,
            "SUPER_RLM_ORIGIN_CWD": str(origin),
            "SUPER_RLM_PROJECT_ID": "l3-chat-e2e",
            "SUPER_RLM_PORT": str(options.orchestrator_port),
            "SUPER_RLM_WORKER_PORT": str(options.worker_port),
            "SUPER_RLM_WORKSPACES": str(options.home / "workspaces"),
            "SUPER_RLM_PRIME_PROVIDER": PROVIDER,
            "SUPER_RLM_PRIME_MODEL": MODEL,
            "DEEPSEEK_API_KEY": api_key,
        }
    )
    return env


def pi_command(options: Options, node: str) -> list[str]:
    command = [
        node,
        str(options.pi_cli),
        "--mode",
        "rpc",
        "--no-extensions",
        "-e",
        str(options.router_extension),
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--no-themes",
        "--no-mcp",
        "-nbt",
        "--session-dir",
        str(options.home / "pi" / "sessions"),
        "--session-id",
        SESSION_ID,
        "--provider",
        PROVIDER,
        "--model",
        MODEL,
    ]
    # The L3 TUI always appends this policy prompt. Keep the live test on the
    # same Chat backend as the TUI instead of testing a bare extension load.
    if options.router_prompt.exists():
        command += ["--append-system-prompt", str(options.router_prompt)]
    return command


def build_chat_prompt(marker: str) -> str:
    return f"""L3 Chat regression run {marker}.

Delegate this to exactly one Worker Ticket. Do not do the work yourself and do
not call task_wait.

Call task_create with:
- task_prompt: this message.
- exactly one ticket:
  - title: "L3 chat file delivery"
  - profile: "default"
  - profile_reason: "standalone file creation; no repository required"
  - prompt: "Create a file named hello.txt in the current working directory (the Ticket workspace). Its entire content must be exactly the text `hello from l3 chat` with no extra blank lines. Do not create other files. Then call the super_rlm_report skill with state='completed', summary='wrote hello.txt', result='hello.txt created', and artifacts=[{{'type': 'file', 'path': 'hello.txt'}}]."

After task_create returns, report the Task and Ticket IDs to the user and return
immediately. The SSE loop will notify you when the Task settles."""


def send_chat_prompt(pi: PiProcess, message: str) -> tuple[str | None, bool]:
    base = {"type": "prompt", "message": message}
    response = pi.request_raw(dict(base), 30.0)
    if response.get("success"):
        data = response.get("data") or {}
        return data.get("disposition"), False
    error = str(response.get("error") or response)
    lowered = error.lower()
    if any(token in lowered for token in ("stream", "busy", "running")):
        queued = {**base, "streamingBehavior": "followUp"}
        response = pi.request_raw(queued, 30.0)
        if response.get("success"):
            data = response.get("data") or {}
            return data.get("disposition"), True
        raise HarnessError(f"Pi rejected the follow-up prompt: {response.get('error') or response}")
    raise HarnessError(f"Pi rejected the prompt: {error}")


def collect_turn(pi: PiProcess, marker: str, timeout: float) -> dict[str, Any]:
    started = time.monotonic()
    deadline = started + timeout
    result: dict[str, Any] = {
        "prompt_seen": False,
        "settled": False,
        "aborted": None,
        "tool_names": [],
        "tool_errors": [],
        "assistant_text": "",
        "task_create": None,
        "task_create_args": None,
        "extension_errors": [],
        "auto_retry": [],
        "event_count": 0,
        "duration_s": 0.0,
        "error": None,
    }
    assistant_parts: list[str] = []
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                result["error"] = "timed out waiting for the Chat turn to settle"
                break
            record = pi.next_event(min(1.0, remaining))
            if record is None:
                result["error"] = "Pi exited during the Chat turn"
                break
            if record is _TIMEOUT:
                continue
            result["event_count"] += 1
            event_type = record.get("type")

            if event_type in {"message_start", "message_end"}:
                message = record.get("message")
                if isinstance(message, dict):
                    role = message.get("role")
                    text = _message_text(message)
                    if role == "user" and marker in text:
                        result["prompt_seen"] = True
                    elif role == "assistant" and result["prompt_seen"] and event_type == "message_end":
                        if text.strip():
                            assistant_parts.append(text)
            elif event_type == "tool_execution_start" and result["prompt_seen"]:
                name = record.get("toolName") or "?"
                result["tool_names"].append(name)
                if name == "task_create":
                    result["task_create_args"] = _clip(record.get("args"), 3000)
            elif event_type == "tool_execution_end" and result["prompt_seen"]:
                name = record.get("toolName") or "?"
                is_error = bool(record.get("isError"))
                if is_error:
                    result["tool_errors"].append(
                        {
                            "tool": name,
                            "error": _clip(_tool_result_text(record.get("result")), 1000),
                        }
                    )
                if name == "task_create" and not is_error:
                    payload = _parse_tool_json(record.get("result"))
                    if isinstance(payload, dict) and payload.get("task_id"):
                        result["task_create"] = payload
            elif event_type == "extension_error":
                result["extension_errors"].append(
                    {
                        "event": record.get("event"),
                        "error": _clip(record.get("error"), 1000),
                    }
                )
            elif event_type in {"auto_retry_start", "auto_retry_end"}:
                result["auto_retry"].append(_clip(record, 800))
            elif event_type == "agent_settled":
                if result["prompt_seen"]:
                    result["settled"] = True
                    result["aborted"] = bool(record.get("aborted"))
                    break
    finally:
        result["assistant_text"] = "\n".join(assistant_parts).strip()
        result["duration_s"] = round(time.monotonic() - started, 2)
    return result


def wait_worker_registered(options: Options, worker_id: str, timeout: float = WORKER_REGISTER_TIMEOUT_S) -> None:
    deadline = time.monotonic() + timeout
    last = "no workers"
    while time.monotonic() < deadline:
        status, body = http_json(
            "GET",
            f"{options.orchestrator_url}/v1/workers",
            token=ROUTER_TOKEN,
            timeout=10.0,
        )
        if status == 200 and isinstance(body, dict):
            workers = body.get("workers")
            if isinstance(workers, list):
                for worker in workers:
                    if not isinstance(worker, dict):
                        continue
                    if worker.get("worker_id") == worker_id and worker.get("status") == "healthy":
                        return
                last = f"{len(workers)} workers, none healthy with id {worker_id}"
        else:
            last = f"HTTP {status}: {_clip(body, 300)}"
        time.sleep(0.25)
    raise HarnessError(f"Worker {worker_id} did not register within {timeout:g}s ({last})")


def find_task_by_marker(options: Options, marker: str, timeout: float = 20.0) -> str | None:
    deadline = time.monotonic() + timeout
    while True:
        status, body = http_json(
            "GET",
            f"{options.orchestrator_url}/v1/tasks?limit=200",
            token=ROUTER_TOKEN,
            timeout=15.0,
        )
        if status == 200 and isinstance(body, dict):
            tasks = body.get("tasks")
            if isinstance(tasks, list):
                for task in tasks:
                    if isinstance(task, dict) and marker in str(task.get("prompt") or ""):
                        task_id = task.get("task_id")
                        if isinstance(task_id, str):
                            return task_id
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.5)


def choose_ticket_result(results: list[dict[str, Any]]) -> dict[str, Any]:
    for result in results:
        if _reports_hello(result) or _records_hello(result):
            return result
    return results[0] if results else {}


def _positive_float(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"not a number: {value!r}") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Manual L3 Chat live E2E harness for super-RLM. Starts an "
            "Orchestrator and Worker, sends one real Chat prompt through Pi "
            "RPC, and verifies a Worker file reaches the launch directory. "
            "WARNING: this spends real API money."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--home",
        type=Path,
        default=DEFAULT_HOME,
        help="super-RLM project home (contains secrets/, pi/, prime/, orchestrator/, workspaces/)",
    )
    parser.add_argument(
        "--orchestrator-port",
        type=int,
        default=18840,
        help="local Orchestrator port",
    )
    parser.add_argument(
        "--worker-port",
        type=int,
        default=18098,
        help="local Worker port",
    )
    parser.add_argument(
        "--timeout",
        type=_positive_float,
        default=300.0,
        help="deadline in seconds for the delegated Task, after the Chat turn",
    )
    parser.add_argument(
        "--kernel-venv",
        type=Path,
        default=argparse.SUPPRESS,
        help="Prime Agent kernel venv; default: <home>/prime/kernel-venv",
    )
    parser.add_argument(
        "--log-dir",
        type=Path,
        default=argparse.SUPPRESS,
        help="child process and origin directory; default: <home>/regression/logs/<run_id>",
    )
    return parser.parse_args(argv)


def make_options(args: argparse.Namespace) -> Options:
    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"_{os.getpid()}"
    home = args.home.expanduser().resolve()
    kernel_arg = getattr(args, "kernel_venv", None)
    log_arg = getattr(args, "log_dir", None)
    kernel_venv = kernel_arg.expanduser().resolve() if kernel_arg else home / "prime" / "kernel-venv"
    log_dir = log_arg.expanduser().resolve() if log_arg else home / "regression" / "logs" / run_id
    return Options(
        home=home,
        orchestrator_port=args.orchestrator_port,
        worker_port=args.worker_port,
        timeout=args.timeout,
        kernel_venv=kernel_venv,
        log_dir=log_dir,
        run_id=run_id,
    )


def run(options: Options, summary: dict[str, Any]) -> None:
    print(
        "[l3-chat] WARNING: this harness calls the live DeepSeek API and spends "
        "real money. It runs one Chat turn and one Worker Ticket.",
        file=sys.stderr,
        flush=True,
    )
    api_key = load_deepseek_key(options.home)
    node = validate_runtime(options)
    validate_chat_runtime(options)

    options.log_dir.mkdir(parents=True, exist_ok=True)
    origin = options.origin_dir
    origin.mkdir(parents=True, exist_ok=False)
    summary["origin_dir"] = str(origin)
    summary["pi_log"] = str(options.pi_log)

    marker = f"L3CHAT_{secrets.token_hex(4)}"
    summary["marker"] = marker
    prompt = build_chat_prompt(marker)
    summary["prompt"] = _clip(prompt, 2000)

    worker_id = f"wrk_regression_{os.getpid()}"
    orchestrator = Service(
        name="Orchestrator",
        command=[node, str(options.repo_root / "apps" / "orchestrator" / "src" / "main.ts")],
        cwd=options.repo_root,
        env=orchestrator_env(options),
        log_path=options.log_dir / "orchestrator.log",
    )
    worker = Service(
        name="Worker",
        command=[str(options.worker_python), "-m", "super_rlm_worker.main"],
        cwd=options.repo_root / "apps" / "worker",
        env=worker_env(options, api_key),
        log_path=options.log_dir / "worker.log",
    )
    command = pi_command(options, node)
    pi = PiProcess(command=command, cwd=origin, env=pi_env(options, api_key, origin), log_path=options.pi_log)

    task_id: str | None = None
    task: dict[str, Any] = {}
    assertions: list[dict[str, Any]] = []
    try:
        orchestrator.start()
        log(f"Orchestrator started on {options.orchestrator_url} (log: {orchestrator.log_path})")
        wait_health(orchestrator, f"{options.orchestrator_url}/health")

        worker.start()
        log(f"Worker started on {options.worker_url} (log: {worker.log_path})")
        wait_health(worker, f"{options.worker_url}/v1/health")
        wait_worker_registered(options, worker_id)
        log(f"Worker {worker_id} registered")

        log(f"starting Pi RPC (cwd={origin}, session={SESSION_ID})")
        pi.start()
        state = pi.request({"type": "get_state"}, 60.0)
        model_info = state.get("model")
        model_label = None
        if isinstance(model_info, dict):
            model_label = model_info.get("id") or model_info.get("name")
        elif isinstance(model_info, str):
            model_label = model_info
        summary["pi_state"] = {
            "session_id": state.get("sessionId"),
            "session_file": state.get("sessionFile"),
            "model": model_label,
            "thinking_level": state.get("thinkingLevel"),
        }
        log(f"Pi RPC ready: session={state.get('sessionId')}")
        if pi.parse_errors:
            summary["pi_parse_errors"] = list(pi.parse_errors)

        disposition, follow_up = send_chat_prompt(pi, prompt)
        summary["prompt_disposition"] = disposition
        summary["follow_up_used"] = follow_up
        log(f"prompt accepted (disposition={disposition}, follow_up={follow_up})")
        if disposition == "handled":
            raise HarnessError(
                "Pi handled the prompt without starting a Chat turn; the prompt did not reach the model"
            )

        turn = collect_turn(pi, marker, min(CHAT_TURN_TIMEOUT_S, options.timeout))
        summary["turn"] = turn
        tool_names = set(turn.get("tool_names") or [])
        chat_assertions = [
            _assertion(
                "chat_prompt_delivered",
                bool(turn.get("prompt_seen")),
                f"marker={marker}",
            ),
            _assertion(
                "chat_turn_settled",
                bool(turn.get("settled")) and not turn.get("aborted"),
                f"settled={turn.get('settled')} aborted={turn.get('aborted')} error={turn.get('error')!r}",
            ),
            _assertion(
                "chat_task_create_used",
                "task_create" in tool_names,
                f"tools={sorted(tool_names)}",
            ),
            _assertion(
                "chat_task_wait_not_used",
                "task_wait" not in tool_names,
                f"tools={sorted(tool_names)}",
            ),
            _assertion(
                "chat_assistant_replied",
                bool(str(turn.get("assistant_text") or "").strip()),
                f"assistant_text={_clip(turn.get('assistant_text'), 500)!r}",
            ),
            _assertion(
                "chat_no_extension_error",
                not turn.get("extension_errors"),
                f"errors={_clip(turn.get('extension_errors'), 500)}",
            ),
        ]
        assertions.extend(chat_assertions)

        created = turn.get("task_create")
        if isinstance(created, dict):
            value = created.get("task_id")
            if isinstance(value, str):
                task_id = value
        if not task_id:
            log("task_create returned no task_id; searching task list by marker")
            task_id = find_task_by_marker(options, marker)
        summary["task_id"] = task_id
        if not task_id:
            assertions.append(
                _assertion(
                    "task_created",
                    False,
                    "Router did not create a Task (no task_create result and no matching task list entry)",
                )
            )
            summary["assertions"] = assertions
            summary["ok"] = False
            summary["error"] = "Router did not create a Task"
            return

        log(f"Task {task_id} created; waiting for terminal state")
        deadline = time.monotonic() + options.timeout
        while True:
            status, body = http_json(
                "GET",
                f"{options.orchestrator_url}/v1/tasks/{task_id}",
                token=ROUTER_TOKEN,
                timeout=15.0,
            )
            if status != 200 or not isinstance(body, dict):
                raise HarnessError(f"task status failed (HTTP {status}): {_clip(body, 500)}")
            task = body
            summary["task_status"] = task.get("status")
            if task.get("status") in TERMINAL_TASK_STATUSES:
                break
            if time.monotonic() >= deadline:
                raise HarnessError(
                    f"timed out after {options.timeout:g}s waiting for a terminal Task "
                    f"(last status: {task.get('status')!r})"
                )
            time.sleep(POLL_INTERVAL_S)

        tickets = task.get("tickets") if isinstance(task.get("tickets"), list) else []
        summary["tickets"] = [
            {
                "ticket_id": ticket.get("ticket_id"),
                "status": ticket.get("status"),
                "profile": ticket.get("profile"),
                "summary": ticket.get("summary"),
                "delivery_error": ticket.get("delivery_error"),
                "delivered_to": ticket.get("delivered_to"),
            }
            for ticket in tickets
            if isinstance(ticket, dict)
        ]

        results: list[dict[str, Any]] = []
        for ticket in tickets:
            if not isinstance(ticket, dict):
                continue
            ticket_id_value = ticket.get("ticket_id")
            if not isinstance(ticket_id_value, str):
                continue
            result_status, result_body = http_json(
                "GET",
                f"{options.orchestrator_url}/v1/tickets/{ticket_id_value}/result",
                token=ROUTER_TOKEN,
                timeout=15.0,
            )
            if result_status == 200 and isinstance(result_body, dict):
                results.append(result_body)
            else:
                results.append(
                    {
                        "ticket_id": ticket_id_value,
                        "status": ticket.get("status"),
                        "error": f"HTTP {result_status}: {_clip(result_body, 300)}",
                    }
                )

        chosen = choose_ticket_result(results)
        summary["ticket"] = {
            "ticket_id": chosen.get("ticket_id"),
            "status": chosen.get("status"),
            "summary": chosen.get("summary"),
            "result": _clip(chosen.get("result"), 2000),
            "artifacts": chosen.get("artifacts"),
            "delivered_to": chosen.get("delivered_to"),
            "delivery_error": chosen.get("delivery_error"),
            "error": chosen.get("error"),
        }
        ticket_summary = next(
            (t for t in tickets if isinstance(t, dict) and t.get("ticket_id") == chosen.get("ticket_id")),
            {},
        )
        delivered_file = _find_delivered_file(origin, chosen)
        content = ""
        read_error = ""
        if delivered_file is not None:
            try:
                content = delivered_file.read_text(encoding="utf-8")
            except OSError as exc:
                read_error = str(exc)

        ticket_status = chosen.get("status") or ticket_summary.get("status")
        profile = ticket_summary.get("profile")
        delivery_error = chosen.get("delivery_error") or ticket_summary.get("delivery_error")
        assertions.extend(
            [
                _assertion("task_created", True, f"task_id={task_id}"),
                _assertion(
                    "task_succeeded",
                    task.get("status") == "succeeded",
                    f"task status={task.get('status')!r}",
                ),
                _assertion(
                    "ticket_succeeded",
                    ticket_status == "succeeded",
                    f"ticket status={ticket_status!r} error={_clip(chosen.get('error'), 500)}",
                ),
                _assertion(
                    "ticket_profile_default",
                    profile == "default",
                    f"profile={profile!r}",
                ),
                _assertion(
                    "artifact_reported",
                    _reports_hello(chosen),
                    f"artifacts={_clip(chosen.get('artifacts'), 500)}",
                ),
                _assertion(
                    "delivery_error_absent",
                    not delivery_error,
                    f"delivery_error={delivery_error!r}",
                ),
                _assertion(
                    "delivered_file_recorded",
                    _records_hello(chosen),
                    f"delivered_to={_clip(chosen.get('delivered_to'), 500)}",
                ),
                _assertion(
                    "file_exists_in_origin",
                    delivered_file is not None,
                    f"origin={origin}; path={delivered_file}",
                ),
                _assertion(
                    "file_content_matches",
                    delivered_file is not None
                    and not read_error
                    and _content_matches(content),
                    f"path={delivered_file}; content={_clip(content, 500)!r}; read_error={read_error!r}",
                ),
            ]
        )
        summary["delivered_file"] = str(delivered_file) if delivered_file is not None else None
        summary["delivered_content"] = _clip(content, 500)
        summary["assertions"] = assertions
        summary["ok"] = bool(assertions) and all(item["ok"] for item in assertions)
        if not summary["ok"]:
            summary["error"] = "assertion failed: " + ", ".join(
                item["name"] for item in assertions if not item["ok"]
            )
        else:
            log(f"PASS: Task {task_id} delivered {delivered_file}")
    except Exception as exc:  # noqa: BLE001 - always emit a summary and clean up
        if not assertions:
            assertions = []
        summary["assertions"] = assertions
        summary["ok"] = False
        summary["error"] = f"{type(exc).__name__}: {exc}"
        summary["pi_stderr_tail"] = pi.log_tail()
        if task_id:
            try:
                http_json(
                    "POST",
                    f"{options.orchestrator_url}/v1/tasks/{task_id}/cancel",
                    token=ROUTER_TOKEN,
                    body={"reason": "l3 chat regression aborted"},
                    timeout=10.0,
                )
            except HarnessError:
                pass
    finally:
        if pi.parse_errors:
            summary["pi_parse_errors"] = list(pi.parse_errors)
        try:
            log("stopping Pi")
            pi.stop()
        except Exception as exc:  # noqa: BLE001 - cleanup must continue
            log(f"failed to stop Pi: {exc}")
        for service in (worker, orchestrator):
            try:
                log(f"stopping {service.name}")
                service.stop()
            except Exception as exc:  # noqa: BLE001 - cleanup must not skip siblings
                log(f"failed to stop {service.name}: {exc}")


def _install_cleanup_signals() -> None:
    def interrupt(_signum: int, _frame: Any) -> None:
        raise KeyboardInterrupt

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), interrupt)


def main(argv: list[str] | None = None) -> int:
    _install_cleanup_signals()
    args = parse_args(argv)
    options = make_options(args)
    summary: dict[str, Any] = {
        "ok": False,
        "run_id": options.run_id,
        "home": str(options.home),
        "orchestrator_url": options.orchestrator_url,
        "worker_url": options.worker_url,
        "provider": PROVIDER,
        "model": MODEL,
        "kernel_venv": str(options.kernel_venv),
        "timeout_s": options.timeout,
        "log_dir": str(options.log_dir),
        "origin_dir": None,
        "session_id": SESSION_ID,
        "marker": None,
        "prompt": None,
        "prompt_disposition": None,
        "follow_up_used": None,
        "pi_state": None,
        "turn": None,
        "task_id": None,
        "task_status": None,
        "tickets": [],
        "ticket": None,
        "delivered_file": None,
        "delivered_content": None,
        "assertions": [],
        "error": None,
    }
    exit_code = 1
    try:
        run(options, summary)
    except KeyboardInterrupt:
        summary["error"] = "interrupted"
        summary["ok"] = False
        exit_code = 130
    except HarnessError as exc:
        summary["error"] = str(exc)
        summary["ok"] = False
    except Exception as exc:  # noqa: BLE001 - always emit a JSON summary
        summary["error"] = f"{type(exc).__name__}: {exc}"
        summary["ok"] = False

    if summary["error"] is not None:
        summary["ok"] = False
    if summary["ok"]:
        exit_code = 0
    elif exit_code != 130:
        exit_code = 1

    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
