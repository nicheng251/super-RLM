#!/usr/bin/env python3
"""Manual real-model regression harness for super-RLM.

This script starts a local Orchestrator and Worker, submits real Tickets to the
DeepSeek provider, and checks the structured Task/Ticket results. It is an
explicit/manual test: it is not imported by the unit suites and it spends real
API money when run.

Usage:
    python scripts/regression/real_model.py --help
    python scripts/regression/real_model.py --kernel-venv <path-to-kernel-venv>

The JSON summary is printed to stdout. Progress and diagnostics go to stderr.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

DEFAULT_HOME = Path.home() / ".super-rlm" / "projects" / "prj_deepseek"
REPO_ROOT = Path(__file__).resolve().parents[2]

ROUTER_TOKEN = "dev-router-token"
WORKER_TOKEN = "dev-worker-token"
CALLBACK_KEY = "dev-callback-key"

PROVIDER = "deepseek"
MODEL = "deepseek-flash"

TERMINAL_TASK_STATUSES = {"succeeded", "partial", "failed", "cancelled", "timed_out"}
CASES = ("report", "file", "hitl")

FILE_CONTENT = "super-rlm-regression-hello"
POLL_INTERVAL_S = 1.0
HEALTH_TIMEOUT_S = 60.0

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class HarnessError(RuntimeError):
    """A setup or infrastructure failure, not a case assertion failure."""


@dataclass(frozen=True)
class Options:
    home: Path
    orchestrator_port: int
    worker_port: int
    cases: list[str]
    keep_going: bool
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
        return venv_python(self.kernel_venv)

    @property
    def prime_agent(self) -> Path:
        name = "prime-agent.exe" if os.name == "nt" else "prime-agent"
        return self.repo_root / "runtime" / "prime-agent" / name

    @property
    def worker_python(self) -> Path:
        return venv_python(self.repo_root / "apps" / "worker" / ".venv")

    @property
    def report_skill(self) -> Path:
        return self.repo_root / "apps" / "worker" / "skills" / "super-rlm-report"

    @property
    def worker_prompt(self) -> Path:
        return self.repo_root / "apps" / "worker" / "prompts" / "worker.md"


@dataclass
class Service:
    name: str
    command: list[str]
    cwd: Path
    env: dict[str, str]
    log_path: Path
    process: subprocess.Popen[bytes] | None = None
    _log_handle: Any = field(default=None, repr=False)

    def start(self) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._log_handle = self.log_path.open("wb")
        kwargs: dict[str, Any] = {}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        try:
            self.process = subprocess.Popen(
                self.command,
                cwd=str(self.cwd),
                env=self.env,
                stdin=subprocess.DEVNULL,
                stdout=self._log_handle,
                stderr=subprocess.STDOUT,
                **kwargs,
            )
        except Exception:
            self._log_handle.close()
            self._log_handle = None
            raise

    def stop(self) -> None:
        process = self.process
        try:
            if process is not None and process.poll() is None:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=False,
                        timeout=15,
                    )
                else:
                    process.terminate()
            if process is not None:
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    if os.name != "nt":
                        process.kill()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
        finally:
            if self._log_handle is not None:
                self._log_handle.close()
                self._log_handle = None


@dataclass
class CaseData:
    task: dict[str, Any]
    ticket: dict[str, Any]
    result: dict[str, Any]
    workspace: Path | None
    waiting_seen: bool
    waiting_question: str | None
    answer_status: int | None
    answer_body: Any


@dataclass(frozen=True)
class CaseDefinition:
    name: str
    title: str
    prompt: str
    hitl: bool
    verify: Callable[[CaseData], list[dict[str, Any]]]


def venv_python(venv: Path) -> Path:
    return venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def _json_body(raw: bytes) -> Any:
    if not raw:
        return None
    text = raw.decode("utf-8", "replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def http_json(
    method: str,
    url: str,
    *,
    token: str | None = None,
    body: Any = None,
    timeout: float = 15.0,
) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("accept", "application/json")
    if data is not None:
        request.add_header("content-type", "application/json")
    if token:
        request.add_header("authorization", f"Bearer {token}")
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            return response.status, _json_body(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, _json_body(exc.read())
    except urllib.error.URLError as exc:
        raise HarnessError(f"{method} {url} failed: {exc.reason}") from exc


def _clip(value: Any, limit: int = 8000) -> Any:
    if value is None:
        return None
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    if len(text) <= limit:
        return text
    return text[:limit] + "...<truncated>"


def _assertion(name: str, ok: bool, detail: str = "") -> dict[str, Any]:
    return {"name": name, "ok": bool(ok), "detail": detail}


def log(message: str) -> None:
    print(f"[regression] {message}", file=sys.stderr, flush=True)


def load_deepseek_key(home: Path) -> str:
    if os.environ.get("DEEPSEEK_API_KEY"):
        return os.environ["DEEPSEEK_API_KEY"]
    env_path = home / "secrets" / "providers.env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key.startswith("export "):
                key = key[len("export "):].strip()
            if key == "DEEPSEEK_API_KEY":
                value = value.strip().strip('"').strip("'")
                if value:
                    return value
    raise HarnessError(
        "DEEPSEEK_API_KEY is not set in the process environment or in "
        f"{env_path} (the key was not printed)."
    )


def base_env() -> dict[str, str]:
    """Host environment without inherited project or agent configuration."""
    blocked_prefixes = ("PI_", "PRIME_AGENT_", "RLM_", "SUPER_RLM_")
    blocked_names = {"DEEPSEEK_API_KEY"}
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in blocked_names and not key.startswith(blocked_prefixes)
    }
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def orchestrator_env(options: Options) -> dict[str, str]:
    env = base_env()
    env.update(
        {
            "SUPER_RLM_HOME": str(options.home),
            "SUPER_RLM_HOST": "127.0.0.1",
            "SUPER_RLM_PORT": str(options.orchestrator_port),
            "SUPER_RLM_ROUTER_TOKEN": ROUTER_TOKEN,
            "SUPER_RLM_WORKER_TOKEN": WORKER_TOKEN,
            "SUPER_RLM_CALLBACK_KEY": CALLBACK_KEY,
            "SUPER_RLM_MAX_CONCURRENT_TICKETS": "4",
            "SUPER_RLM_MAX_CONCURRENT_TICKETS_PER_TASK": "2",
        }
    )
    return env


def worker_env(options: Options, api_key: str) -> dict[str, str]:
    env = base_env()
    env.update(
        {
            "SUPER_RLM_HOME": str(options.home),
            "SUPER_RLM_ORCHESTRATOR_URL": options.orchestrator_url,
            "SUPER_RLM_WORKER_HOST": "127.0.0.1",
            "SUPER_RLM_WORKER_PORT": str(options.worker_port),
            "SUPER_RLM_WORKER_ID": f"wrk_regression_{os.getpid()}",
            "SUPER_RLM_WORKER_TOKEN": WORKER_TOKEN,
            "SUPER_RLM_CALLBACK_KEY": CALLBACK_KEY,
            "SUPER_RLM_PRIME_AGENT": str(options.prime_agent),
            "SUPER_RLM_PRIME_PROVIDER": PROVIDER,
            "SUPER_RLM_PRIME_MODEL": MODEL,
            "SUPER_RLM_KERNEL_VENV": str(options.kernel_venv),
            "SUPER_RLM_KERNEL_PYTHON": str(options.kernel_python),
            "SUPER_RLM_REPORT_SKILL": str(options.report_skill),
            "SUPER_RLM_WORKER_PROMPT": str(options.worker_prompt),
            "SUPER_RLM_MAX_CONCURRENCY": "2",
            "SUPER_RLM_TURN_TIMEOUT_S": f"{max(60.0, options.timeout):g}",
            "DEEPSEEK_API_KEY": api_key,
        }
    )
    bash_shell = Path("C:/Program Files/Git/bin/bash.exe")
    if os.name == "nt" and bash_shell.exists():
        env["SUPER_RLM_BASH_SHELL"] = str(bash_shell)
    return env


def _require_file(path: Path, description: str, hint: str = "") -> None:
    if not path.exists():
        detail = f"{description} not found: {path}"
        if hint:
            detail += f" ({hint})"
        raise HarnessError(detail)


def _check_node_version(node: str) -> None:
    try:
        completed = subprocess.run(
            [node, "--version"], capture_output=True, text=True, timeout=15, check=False
        )
    except OSError as exc:
        raise HarnessError(f"could not run node: {exc}") from exc
    output = (completed.stdout or completed.stderr).strip()
    match = re.search(r"v?(\d+)\.(\d+)\.(\d+)", output)
    if not match:
        raise HarnessError(f"could not parse Node.js version from {output!r}")
    version = tuple(int(part) for part in match.groups())
    if version[:2] < (22, 19):
        raise HarnessError(
            f"Node.js >= 22.19 is required; found {output}. "
            "The Orchestrator uses node:sqlite and TypeScript type stripping."
        )


def validate_runtime(options: Options) -> str:
    node = shutil.which("node")
    if not node:
        raise HarnessError("Node.js is not on PATH; Node.js >= 22.19 is required.")
    _check_node_version(node)

    _require_file(
        options.repo_root / "apps" / "orchestrator" / "src" / "main.ts",
        "Orchestrator entry point",
    )
    _require_file(
        options.worker_python,
        "Worker virtualenv Python",
        'create it with: cd apps/worker && uv venv --python 3.11 .venv && '
        'uv pip install --python .venv/Scripts/python.exe -e ".[dev]"',
    )
    _require_file(options.prime_agent, "Prime Agent binary")
    _require_file(options.report_skill / "SKILL.md", "super-rlm-report skill")
    _require_file(options.worker_prompt, "Worker prompt")
    _require_file(
        options.kernel_venv,
        "Prime Agent kernel venv",
        "pass --kernel-venv <path> explicitly if the project venv is absent",
    )
    _require_file(
        options.kernel_python,
        "Prime Agent kernel Python",
        "pass --kernel-venv pointing at a complete venv",
    )
    _require_file(
        options.home / "prime" / "agent" / "models.json",
        "Prime Agent model registry",
        "run `super-rlm models sync` for this project",
    )

    for name, port in (
        ("orchestrator", options.orchestrator_port),
        ("worker", options.worker_port),
    ):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                raise HarnessError(
                    f"{name} port {port} is already in use; stop existing super-RLM "
                    "services or choose different --orchestrator-port/--worker-port."
                )
    return node


def wait_health(service: Service, url: str, timeout: float = HEALTH_TIMEOUT_S) -> Any:
    deadline = time.monotonic() + timeout
    last = "no response"
    while time.monotonic() < deadline:
        process = service.process
        if process is not None and process.poll() is not None:
            raise HarnessError(
                f"{service.name} exited with code {process.returncode}; see {service.log_path}"
            )
        try:
            status, body = http_json("GET", url, timeout=2.0)
            if status == 200:
                return body
            last = f"HTTP {status}: {_clip(body, 300)}"
        except HarnessError as exc:
            last = str(exc)
        time.sleep(0.25)
    raise HarnessError(
        f"timed out after {timeout:g}s waiting for {service.name} health at {url} "
        f"(last: {last}); see {service.log_path}"
    )


def _task_ticket(task: dict[str, Any]) -> dict[str, Any]:
    tickets = task.get("tickets") or []
    return tickets[0] if tickets else {}


def _result_text(data: CaseData) -> str:
    return str(data.result.get("result") or "")


def _verify_report(marker: str) -> Callable[[CaseData], list[dict[str, Any]]]:
    def verify(data: CaseData) -> list[dict[str, Any]]:
        ticket_status = data.result.get("status") or data.ticket.get("status")
        result_text = _result_text(data)
        return [
            _assertion(
                "task_succeeded",
                data.task.get("status") == "succeeded",
                f"task status={data.task.get('status')!r}",
            ),
            _assertion(
                "ticket_succeeded",
                ticket_status == "succeeded",
                f"ticket status={ticket_status!r}",
            ),
            _assertion(
                "result_contains_marker",
                marker in result_text,
                f"marker={marker!r}; result={_clip(result_text, 500)!r}",
            ),
        ]

    return verify


def _content_matches(text: str) -> bool:
    """Accept the requested text with zero or one trailing newline."""
    if text.endswith("\r\n"):
        text = text[:-2]
    elif text.endswith("\n"):
        text = text[:-1]
    return text == FILE_CONTENT


def _verify_file(data: CaseData) -> list[dict[str, Any]]:
    path = data.workspace / "hello.txt" if data.workspace is not None else None
    exists = bool(path is not None and path.exists())
    content = ""
    read_error = ""
    if exists and path is not None:
        try:
            content = path.read_text(encoding="utf-8")
        except OSError as exc:
            read_error = str(exc)
    ticket_status = data.result.get("status") or data.ticket.get("status")
    return [
        _assertion(
            "task_succeeded",
            data.task.get("status") == "succeeded",
            f"task status={data.task.get('status')!r}",
        ),
        _assertion(
            "ticket_succeeded",
            ticket_status == "succeeded",
            f"ticket status={ticket_status!r}",
        ),
        _assertion("file_exists", exists, f"path={path}"),
        _assertion(
            "file_content_matches",
            exists and not read_error and _content_matches(content),
            f"path={path}; content={_clip(content, 500)!r}; read_error={read_error!r}",
        ),
    ]


def _verify_hitl(data: CaseData) -> list[dict[str, Any]]:
    ticket_status = data.result.get("status") or data.ticket.get("status")
    result_text = _result_text(data)
    question = data.waiting_question or ""
    return [
        _assertion(
            "task_waiting_observed",
            data.waiting_seen,
            f"question={question!r}",
        ),
        _assertion(
            "question_asked",
            "linux" in question.lower() or "windows" in question.lower(),
            f"question={question!r}",
        ),
        _assertion(
            "answer_accepted",
            data.answer_status == 200,
            f"status={data.answer_status!r}; body={_clip(data.answer_body, 300)}",
        ),
        _assertion(
            "task_succeeded",
            data.task.get("status") == "succeeded",
            f"task status={data.task.get('status')!r}",
        ),
        _assertion(
            "ticket_succeeded",
            ticket_status == "succeeded",
            f"ticket status={ticket_status!r}",
        ),
        _assertion(
            "result_mentions_linux",
            "linux" in result_text.lower(),
            f"result={_clip(result_text, 500)!r}",
        ),
    ]


def build_cases(marker: str) -> dict[str, CaseDefinition]:
    defs = [
        CaseDefinition(
            name="report",
            title="structured completed report",
            prompt=(
                "Call the super_rlm_report skill exactly once with "
                "state='completed', summary='regression report case', and "
                f"result='{marker}'. Do not do any other work."
            ),
            hitl=False,
            verify=_verify_report(marker),
        ),
        CaseDefinition(
            name="file",
            title="create hello.txt in the workspace",
            prompt=(
                "Create a file named hello.txt in the current working directory "
                "(the Ticket workspace). Its entire content must be exactly the "
                f"text `{FILE_CONTENT}` followed by one newline. Do not create "
                "other files. Then call the super_rlm_report skill with "
                "state='completed', summary='wrote hello.txt', and "
                f"result='hello.txt contains {FILE_CONTENT}'."
            ),
            hitl=False,
            verify=_verify_file,
        ),
        CaseDefinition(
            name="hitl",
            title="ask the user a question and resume with the answer",
            prompt=(
                "Before doing anything else, ask the user one question by calling "
                "the super_rlm_report skill with state='waiting' and "
                "question='Linux or Windows?'. Do not answer the question "
                "yourself. After the user answers, call super_rlm_report again "
                "with state='completed', summary='received the user answer', and "
                "a result that states the user's answer verbatim. The result must "
                "mention Linux."
            ),
            hitl=True,
            verify=_verify_hitl,
        ),
    ]
    return {case.name: case for case in defs}


def create_task(options: Options, case: CaseDefinition) -> tuple[str, str]:
    body = {
        "prompt": f"Real-model regression case: {case.name}.",
        "tickets": [{"title": f"regression {case.name}", "prompt": case.prompt}],
        "metadata": {
            "source": "scripts/regression/real_model.py",
            "case": case.name,
            "run_id": options.run_id,
        },
    }
    status, response = http_json(
        "POST",
        f"{options.orchestrator_url}/v1/tasks",
        token=ROUTER_TOKEN,
        body=body,
        timeout=20.0,
    )
    if status != 201 or not isinstance(response, dict):
        raise HarnessError(f"task creation failed (HTTP {status}): {_clip(response, 800)}")
    task_id = response.get("task_id")
    tickets = response.get("tickets") or []
    ticket_id = tickets[0].get("ticket_id") if tickets else None
    if not task_id or not ticket_id:
        raise HarnessError(f"task creation returned no ids: {_clip(response, 800)}")
    return str(task_id), str(ticket_id)


def run_case(options: Options, case: CaseDefinition) -> dict[str, Any]:
    started = time.monotonic()
    record: dict[str, Any] = {
        "case": case.name,
        "title": case.title,
        "ok": False,
        "duration_s": 0.0,
        "task_id": None,
        "ticket_id": None,
        "task_status": None,
        "ticket_status": None,
        "ticket_summary": None,
        "ticket_result": None,
        "ticket_error": None,
        "waiting_question": None,
        "answer_status": None,
        "workspace": None,
        "assertions": [],
        "error": None,
    }

    task: dict[str, Any] = {}
    ticket: dict[str, Any] = {}
    result: dict[str, Any] = {}
    waiting_seen = False
    waiting_question: str | None = None
    answer_status: int | None = None
    answer_body: Any = None
    timed_out = False
    abort_error: str | None = None
    task_id: str | None = None
    ticket_id: str | None = None

    log(f"case {case.name}: creating Task")
    try:
        task_id, ticket_id = create_task(options, case)
        record["task_id"] = task_id
        record["ticket_id"] = ticket_id
        log(f"case {case.name}: task={task_id} ticket={ticket_id}")

        deadline = time.monotonic() + options.timeout
        while True:
            status, response = http_json(
                "GET",
                f"{options.orchestrator_url}/v1/tasks/{task_id}",
                token=ROUTER_TOKEN,
                timeout=15.0,
            )
            if status != 200 or not isinstance(response, dict):
                raise HarnessError(
                    f"task status failed (HTTP {status}): {_clip(response, 500)}"
                )
            task = response
            ticket = _task_ticket(task)
            task_status = task.get("status")

            if case.hitl and not waiting_seen and task_status == "waiting":
                waiting_seen = True
                question = ticket.get("question") or {}
                waiting_question = question.get("text") if isinstance(question, dict) else None
                log(f"case {case.name}: waiting question={waiting_question!r}")
                answer_status, answer_body = http_json(
                    "POST",
                    f"{options.orchestrator_url}/v1/tickets/{ticket_id}/answer",
                    token=ROUTER_TOKEN,
                    body={"message": "Linux"},
                    timeout=20.0,
                )
                log(f"case {case.name}: answer HTTP {answer_status}")
                if answer_status != 200:
                    abort_error = (
                        f"ticket_answer failed (HTTP {answer_status}): "
                        f"{_clip(answer_body, 500)}"
                    )
                    break

            if task_status in TERMINAL_TASK_STATUSES:
                break
            if time.monotonic() >= deadline:
                timed_out = True
                break
            time.sleep(POLL_INTERVAL_S)

        if ticket_id:
            status, response = http_json(
                "GET",
                f"{options.orchestrator_url}/v1/tickets/{ticket_id}/result",
                token=ROUTER_TOKEN,
                timeout=15.0,
            )
            if status == 200 and isinstance(response, dict):
                result = response
            elif status != 200:
                log(f"case {case.name}: ticket result HTTP {status}")

        if timed_out or abort_error:
            try:
                http_json(
                    "POST",
                    f"{options.orchestrator_url}/v1/tasks/{task_id}/cancel",
                    token=ROUTER_TOKEN,
                    body={"reason": "regression timeout" if timed_out else "regression abort"},
                    timeout=10.0,
                )
            except HarnessError as exc:
                log(f"case {case.name}: cancel failed: {exc}")

        if timed_out:
            record["error"] = (
                f"timed out after {options.timeout:g}s waiting for a terminal Task "
                f"(last task status: {task.get('status')!r})"
            )
        elif abort_error:
            record["error"] = abort_error

        data = CaseData(
            task=task,
            ticket=ticket,
            result=result,
            workspace=(options.home / "workspaces" / ticket_id) if ticket_id else None,
            waiting_seen=waiting_seen,
            waiting_question=waiting_question,
            answer_status=answer_status,
            answer_body=answer_body,
        )
        try:
            assertions = case.verify(data)
        except Exception as exc:  # noqa: BLE001 - surface verifier bugs as case failures
            assertions = [_assertion("verifier_ran", False, f"{type(exc).__name__}: {exc}")]
        if timed_out:
            assertions.append(_assertion("finished_within_timeout", False, "timed out"))
        record["assertions"] = assertions
        record["ok"] = bool(assertions) and all(a["ok"] for a in assertions) and not timed_out
        if not record["ok"] and record["error"] is None:
            failed = [a["name"] for a in assertions if not a["ok"]]
            record["error"] = "assertion failed: " + ", ".join(failed)

    except Exception as exc:  # noqa: BLE001 - one case must not hide the others
        record["ok"] = False
        record["error"] = f"{type(exc).__name__}: {exc}"
        if task_id is not None:
            try:
                http_json(
                    "POST",
                    f"{options.orchestrator_url}/v1/tasks/{task_id}/cancel",
                    token=ROUTER_TOKEN,
                    body={"reason": "regression aborted"},
                    timeout=10.0,
                )
            except HarnessError:
                pass

    finally:
        record["duration_s"] = round(time.monotonic() - started, 2)
        record["task_status"] = task.get("status")
        record["ticket_status"] = result.get("status") or ticket.get("status")
        record["ticket_summary"] = result.get("summary") or ticket.get("summary")
        record["ticket_result"] = _clip(result.get("result"), 8000)
        record["ticket_error"] = result.get("error") if result.get("error") is not None else ticket.get("error")
        record["waiting_question"] = waiting_question
        record["answer_status"] = answer_status
        record["workspace"] = (
            str(options.home / "workspaces" / ticket_id) if ticket_id else None
        )
        log(
            f"case {case.name}: {'PASS' if record['ok'] else 'FAIL'} "
            f"in {record['duration_s']:g}s"
        )

    return record


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
            "Manual real-model regression harness for super-RLM. Starts an "
            "Orchestrator and Worker, runs real DeepSeek Tasks, and prints a JSON "
            "summary. WARNING: this spends real API money."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--home",
        type=Path,
        default=DEFAULT_HOME,
        help="super-RLM project home (contains secrets/, prime/, orchestrator/, workspaces/)",
    )
    parser.add_argument(
        "--orchestrator-port",
        type=int,
        default=18810,
        help="local Orchestrator port",
    )
    parser.add_argument(
        "--worker-port",
        type=int,
        default=18090,
        help="local Worker port",
    )
    parser.add_argument(
        "--case",
        dest="cases",
        action="append",
        choices=CASES,
        metavar="CASE",
        default=argparse.SUPPRESS,
        help=f"case to run, repeatable ({', '.join(CASES)}); default: all",
    )
    parser.add_argument(
        "--keep-going",
        action="store_true",
        help="run remaining cases after a case failure",
    )
    parser.add_argument(
        "--timeout",
        type=_positive_float,
        default=900.0,
        help="per-case deadline in seconds, including a HITL answer",
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
        help="child process log directory; default: <home>/regression/logs/<run_id>",
    )
    return parser.parse_args(argv)


def make_options(args: argparse.Namespace) -> Options:
    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"_{os.getpid()}"
    home = args.home.expanduser()
    kernel_arg = getattr(args, "kernel_venv", None)
    log_arg = getattr(args, "log_dir", None)
    case_args = getattr(args, "cases", None)
    kernel_venv = kernel_arg.expanduser() if kernel_arg else home / "prime" / "kernel-venv"
    log_dir = log_arg.expanduser() if log_arg else home / "regression" / "logs" / run_id
    cases = list(dict.fromkeys(case_args)) if case_args else list(CASES)
    return Options(
        home=home,
        orchestrator_port=args.orchestrator_port,
        worker_port=args.worker_port,
        cases=cases,
        keep_going=args.keep_going,
        timeout=args.timeout,
        kernel_venv=kernel_venv,
        log_dir=log_dir,
        run_id=run_id,
    )


def run(options: Options, summary: dict[str, Any]) -> None:
    print(
        "[regression] WARNING: this harness calls the live DeepSeek API and "
        "spends real money. Each selected case runs one real Ticket.",
        file=sys.stderr,
        flush=True,
    )
    api_key = load_deepseek_key(options.home)
    node = validate_runtime(options)
    summary["log_dir"] = str(options.log_dir)
    summary["kernel_venv"] = str(options.kernel_venv)

    workspace_root = options.home / "workspaces"
    workspace_root.mkdir(parents=True, exist_ok=True)

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

    marker = f"REGRESSION_OK_{secrets.token_hex(4)}"
    summary["marker"] = marker
    cases = build_cases(marker)

    try:
        orchestrator.start()
        log(f"Orchestrator started on {options.orchestrator_url} (log: {orchestrator.log_path})")
        wait_health(orchestrator, f"{options.orchestrator_url}/health")

        worker.start()
        log(f"Worker started on {options.worker_url} (log: {worker.log_path})")
        wait_health(worker, f"{options.worker_url}/v1/health")
        log("both services are healthy; Worker registration is automatic")

        for index, name in enumerate(options.cases):
            case = cases[name]
            record = run_case(options, case)
            summary["cases"].append(record)
            if not record["ok"] and not options.keep_going:
                summary["skipped_cases"] = options.cases[index + 1:]
                break
    finally:
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
        "selected_cases": options.cases,
        "skipped_cases": [],
        "marker": None,
        "cases": [],
        "log_dir": str(options.log_dir),
        "error": None,
    }
    exit_code = 1
    try:
        run(options, summary)
    except KeyboardInterrupt:
        summary["error"] = "interrupted"
        exit_code = 130
    except HarnessError as exc:
        summary["error"] = str(exc)
    except Exception as exc:  # noqa: BLE001 - always emit a JSON summary
        summary["error"] = f"{type(exc).__name__}: {exc}"

    summary["ok"] = (
        summary["error"] is None
        and len(summary["cases"]) == len(summary["selected_cases"])
        and all(item["ok"] for item in summary["cases"])
    )
    if summary["ok"]:
        exit_code = 0
    elif exit_code != 130:
        exit_code = 1

    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
