
"""Per-Assignment Prime Agent ACP execution."""

from __future__ import annotations

import asyncio
import logging
import secrets
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from super_rlm_protocol import ExecutionRequest, ReportAck, ReportState, SkillReport

from . import acp_client
from .config import WorkerConfig
from .prime_agent import discover_session_ref, session_dir_for
from .reports import ReportForwarder, TERMINAL_STATES, build_worker_report

LOG = logging.getLogger("super_rlm_worker.executor")

ENFORCEMENT_PROMPT = (
    "Before ending, call super_rlm_report with the terminal state. "
    "Use completed only if the requested deliverable is done; otherwise use "
    "waiting, blocked, dropped, or failed."
)


class AtCapacity(RuntimeError):
    pass


class ExecutionNotFound(KeyError):
    pass


class InvalidReportToken(PermissionError):
    pass


@dataclass
class ExecutionState:
    execution_id: str
    ticket_id: str
    assignment_id: str
    prompt: str
    profile: str
    workspace: Path
    session_dir: Path
    report_token: str
    report_url: str
    resume_ref: str | None = None
    resume_message: str | None = None
    seq: int = 0
    session_id: str | None = None
    session_ref: str | None = None
    latest_report: SkillReport | None = None
    terminal_report: SkillReport | None = None
    error: str | None = None
    cancelled: bool = False
    done: asyncio.Event = field(default_factory=asyncio.Event)
    report_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    task: asyncio.Task[None] | None = None
    connection: Any | None = None
    process: Any | None = None

    @property
    def terminal(self) -> bool:
        return self.terminal_report is not None


class ExecutionManager:
    def __init__(self, config: WorkerConfig, forwarder: ReportForwarder) -> None:
        self.config = config
        self.forwarder = forwarder
        self._by_assignment: dict[str, ExecutionState] = {}
        self._by_execution: dict[str, ExecutionState] = {}
        self._running = 0

    @property
    def running(self) -> int:
        return self._running

    @property
    def max_concurrency(self) -> int:
        return self.config.max_concurrency

    def get(self, execution_id: str) -> ExecutionState:
        try:
            return self._by_execution[execution_id]
        except KeyError as exc:
            raise ExecutionNotFound(execution_id) from exc

    def get_by_assignment(self, assignment_id: str) -> ExecutionState:
        try:
            return self._by_assignment[assignment_id]
        except KeyError as exc:
            raise ExecutionNotFound(assignment_id) from exc

    async def start(self, request: ExecutionRequest) -> ExecutionState:
        existing = self._by_assignment.get(request.assignment_id)
        if existing is not None:
            return existing
        if self._running >= self.config.max_concurrency:
            raise AtCapacity(f"worker is at capacity ({self._running}/{self.config.max_concurrency})")

        self.config.ensure_dirs()
        workspace = self.config.workspace_root / request.ticket_id
        workspace.mkdir(parents=True, exist_ok=True)
        session_dir = session_dir_for(self.config, request.ticket_id)
        session_dir.mkdir(parents=True, exist_ok=True)

        execution_id = f"exe_{uuid.uuid4().hex[:20]}"
        report_token = secrets.token_urlsafe(24)
        host = "127.0.0.1" if self.config.host in {"0.0.0.0", "::"} else self.config.host
        report_url = f"http://{host}:{self.config.port}/internal/assignments/{request.assignment_id}/report"
        state = ExecutionState(
            execution_id=execution_id,
            ticket_id=request.ticket_id,
            assignment_id=request.assignment_id,
            prompt=request.prompt,
            profile=request.profile,
            workspace=workspace,
            session_dir=session_dir,
            report_token=report_token,
            report_url=report_url,
            resume_ref=request.resume.session_ref if request.resume else None,
            resume_message=request.resume.message if request.resume else None,
        )
        self._by_assignment[state.assignment_id] = state
        self._by_execution[state.execution_id] = state
        state.task = asyncio.create_task(self._run(state), name=f"execution:{state.assignment_id}")
        return state

    async def _run(self, state: ExecutionState) -> None:
        self._running += 1
        try:
            async with acp_client.open_prime_agent(
                self.config,
                state.workspace,
                state.session_dir,
                state.resume_ref,
                state.report_url,
                state.report_token,
                state.ticket_id,
                on_event=lambda event: self._on_event(state, event),
            ) as (connection, process, _client):
                state.connection = connection
                state.process = process
                await acp_client.initialize(connection)
                state.session_id = await acp_client.new_session(connection, state.workspace)
                state.session_ref = await discover_session_ref(state.session_dir, self.config.start_timeout_s)

                prompt_text = state.prompt
                if state.resume_message:
                    prompt_text = (
                        f"User answer / resume note:\n{state.resume_message}\n\n"
                        "Continue the original Ticket using this answer."
                    )
                await asyncio.wait_for(
                    acp_client.prompt(connection, state.session_id, prompt_text),
                    timeout=self.config.turn_timeout_s,
                )

                if state.terminal_report is None:
                    LOG.info("execution %s ended without a terminal report; enforcing", state.assignment_id)
                    await asyncio.wait_for(
                        acp_client.prompt(connection, state.session_id, ENFORCEMENT_PROMPT),
                        timeout=self.config.turn_timeout_s,
                    )
                    await asyncio.sleep(0.2)

                if state.terminal_report is None:
                    await self._report_terminal(
                        state,
                        SkillReport(
                            state=ReportState.FAILED,
                            summary="Prime Agent ended without a terminal report",
                            error={"code": "missing_report", "message": "no terminal super_rlm_report call"},
                        ),
                    )
        except asyncio.TimeoutError:
            await self._report_terminal(
                state,
                SkillReport(
                    state=ReportState.FAILED,
                    summary="Prime Agent turn timed out",
                    error={"code": "timeout", "message": "ACP turn exceeded the configured timeout"},
                ),
            )
        except asyncio.CancelledError:
            if state.terminal_report is None:
                await self._report_terminal(
                    state,
                    SkillReport(state=ReportState.CANCELLED, summary="execution cancelled"),
                )
            raise
        except Exception as exc:  # noqa: BLE001 - the Worker must report a stable failure
            state.error = str(exc)
            LOG.exception("execution %s failed", state.assignment_id)
            if state.terminal_report is None:
                await self._report_terminal(
                    state,
                    SkillReport(
                        state=ReportState.FAILED,
                        summary="Prime Agent execution failed",
                        error={"code": "prime_agent_protocol_error", "message": str(exc)},
                    ),
                )
        finally:
            self._running = max(0, self._running - 1)
            state.connection = None
            state.process = None
            state.done.set()

    async def _on_event(self, state: ExecutionState, event: dict[str, Any]) -> None:
        # Prime Agent events are logs, not Orchestrator state.
        kind = event.get("kind")
        if kind == "session_update":
            update = event.get("update") or {}
            session_update = update.get("sessionUpdate")
            if session_update in {"tool_call", "tool_call_update"}:
                LOG.info("execution %s tool %s %s", state.assignment_id, session_update, update.get("status"))
            elif session_update == "session_info_update":
                meta = (update.get("_meta") or {}).get("ai.primeintellect.prime-agent") or {}
                if "subagents" in meta or "quiescence" in meta:
                    LOG.info("execution %s meta %s", state.assignment_id, meta)
        elif kind == "permission_request":
            LOG.info("execution %s permission request", state.assignment_id)

    async def record_report(
        self,
        assignment_id: str,
        report_token: str,
        report: SkillReport,
    ) -> ReportAck:
        state = self.get_by_assignment(assignment_id)
        if not secrets.compare_digest(state.report_token, report_token):
            raise InvalidReportToken("invalid report token")
        async with state.report_lock:
            if state.terminal_report is not None:
                return ReportAck(accepted=True, reason="already_terminal")
            state.latest_report = report
            state.seq += 1
            worker_report = build_worker_report(
                ticket_id=state.ticket_id,
                assignment_id=state.assignment_id,
                execution_id=state.execution_id,
                seq=state.seq,
                session_ref=state.session_ref,
                report=report,
            )
            ack = await self.forwarder.forward(worker_report)
            if report.state in TERMINAL_STATES:
                state.terminal_report = report
            return ack

    async def cancel(self, execution_id: str, reason: str | None = None) -> None:
        state = self.get(execution_id)
        state.cancelled = True
        if state.connection is not None and state.session_id is not None:
            try:
                await acp_client.cancel(state.connection, state.session_id)
            except Exception:  # noqa: BLE001
                LOG.exception("execution %s ACP cancel failed", state.assignment_id)
        try:
            await asyncio.wait_for(state.done.wait(), timeout=10)
        except asyncio.TimeoutError:
            if state.process is not None:
                state.process.terminate()
            await self._report_terminal(
                state,
                SkillReport(state=ReportState.CANCELLED, summary=f"execution cancelled: {reason or 'no reason'}"),
            )

    async def _report_terminal(self, state: ExecutionState, report: SkillReport) -> None:
        async with state.report_lock:
            if state.terminal_report is not None:
                return
            state.seq += 1
            worker_report = build_worker_report(
                ticket_id=state.ticket_id,
                assignment_id=state.assignment_id,
                execution_id=state.execution_id,
                seq=state.seq,
                session_ref=state.session_ref,
                report=report,
            )
            try:
                await self.forwarder.forward(worker_report)
            except Exception:  # noqa: BLE001
                LOG.exception("execution %s failed to forward terminal report", state.assignment_id)
            state.terminal_report = report
