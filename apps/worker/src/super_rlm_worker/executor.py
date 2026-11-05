
"""Per-Assignment Prime Agent ACP execution."""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from super_rlm_protocol import ExecutionRequest, ReportAck, ReportState, SkillReport

from . import acp_client
from .blocked import install_blocked_shims
from .config import WorkerConfig
from .daemon import PrimeDaemon
from .delivery import deliver_artifacts
from .execution_profile import (
    ExecutionConfigError,
    ExecutionPlan,
    normalize_artifacts,
    resolve_agent_cwd,
)
from .metadata import collect_workspace_metadata
from .prepare import PrepareError, prepare_workspace
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


class InvalidExecution(ValueError):
    """The submitted execution options are malformed."""


class WorkerShuttingDown(RuntimeError):
    """The Worker has begun shutting down and accepts no new executions."""


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
    report_config: Path
    plan: ExecutionPlan | None = None
    origin_cwd: str | None = None
    delivered_to: list[str] = field(default_factory=list)
    delivery_error: str | None = None
    workspace_metadata: dict[str, Any] | None = None
    metadata_error: str | None = None
    metadata_done: bool = False
    resume_ref: str | None = None
    resume_message: str | None = None
    seq: int = 0
    session_id: str | None = None
    session_ref: str | None = None
    latest_report: SkillReport | None = None
    terminal_report: SkillReport | None = None
    error: str | None = None
    cancelled: bool = False
    cancel_reason: str | None = None
    timed_out: bool = False
    cleanup_error: str | None = None
    cleanup_done: bool = False
    cleanup_session_ref: str | None = None
    done: asyncio.Event = field(default_factory=asyncio.Event)
    report_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    cleanup_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    task: asyncio.Task[None] | None = None
    connection: Any | None = None
    process: Any | None = None

    @property
    def terminal(self) -> bool:
        return self.terminal_report is not None


class ExecutionManager:
    def __init__(
        self,
        config: WorkerConfig,
        forwarder: ReportForwarder,
        daemon: PrimeDaemon | None = None,
    ) -> None:
        self.config = config
        self.forwarder = forwarder
        self.daemon = daemon if daemon is not None else PrimeDaemon(config)
        self._by_assignment: dict[str, ExecutionState] = {}
        self._by_execution: dict[str, ExecutionState] = {}
        self._running = 0
        self._shutting_down = False

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

    def active_executions(self) -> list[ExecutionState]:
        return [state for state in self._by_execution.values() if not state.done.is_set()]

    def phase(self, state: ExecutionState) -> str:
        if state.terminal_report is not None:
            if state.terminal_report.state.value == "waiting":
                return "waiting"
            if state.terminal_report.state.value == "blocked":
                return "blocked"
        return "running"

    async def start(self, request: ExecutionRequest) -> ExecutionState:
        if self._shutting_down:
            raise WorkerShuttingDown("worker is shutting down")
        existing = self._by_assignment.get(request.assignment_id)
        if existing is not None:
            return existing
        if self._running >= self.config.max_concurrency:
            raise AtCapacity(f"worker is at capacity ({self._running}/{self.config.max_concurrency})")

        try:
            plan = ExecutionPlan.resolve(request, self.config)
        except ExecutionConfigError as exc:
            raise InvalidExecution(str(exc)) from exc

        self.config.ensure_dirs()
        workspace = self.config.workspace_root / request.ticket_id
        workspace.mkdir(parents=True, exist_ok=True)
        session_dir = session_dir_for(self.config, request.ticket_id)
        session_dir.mkdir(parents=True, exist_ok=True)

        execution_id = f"exe_{uuid.uuid4().hex[:20]}"
        report_token = secrets.token_urlsafe(24)
        host = "127.0.0.1" if self.config.host in {"0.0.0.0", "::"} else self.config.host
        report_url = f"http://{host}:{self.config.port}/internal/assignments/{request.assignment_id}/report"
        report_config = workspace / ".super-rlm-report.json"
        report_config.write_text(
            json.dumps({
                "url": report_url,
                "token": report_token,
                "assignment_id": request.assignment_id,
                "ticket_id": request.ticket_id,
            }),
            encoding="utf-8",
        )
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
            report_config=report_config,
            plan=plan,
            origin_cwd=getattr(request, "origin_cwd", None),
            resume_ref=request.resume.session_ref if request.resume else None,
            resume_message=request.resume.message if request.resume else None,
        )
        self._by_assignment[state.assignment_id] = state
        self._by_execution[state.execution_id] = state
        state.task = asyncio.create_task(self._run(state), name=f"execution:{state.assignment_id}")
        return state

    async def _run(self, state: ExecutionState) -> None:
        self._running += 1
        plan = state.plan or ExecutionPlan.from_config(self.config, profile=state.profile)
        try:
            try:
                await prepare_workspace(
                    self.config,
                    state.workspace,
                    state.ticket_id,
                    state.assignment_id,
                    prepare_command=plan.prepare_command,
                    profile=plan.profile,
                )
                agent_cwd = resolve_agent_cwd(state.workspace, plan.agent_cwd)
            except PrepareError as exc:
                if state.cancelled:
                    await self._report_terminal(state, self._cancelled_report(state))
                    return
                state.error = str(exc)
                LOG.error("execution %s workspace preparation failed: %s", state.assignment_id, exc)
                await self._report_terminal(
                    state,
                    SkillReport(
                        state=ReportState.FAILED,
                        summary=f"Workspace preparation failed for ticket {state.ticket_id}",
                        error={"code": "prepare_failed", "message": str(exc)},
                    ),
                )
                return
            except ExecutionConfigError as exc:
                if state.cancelled:
                    await self._report_terminal(state, self._cancelled_report(state))
                    return
                state.error = str(exc)
                await self._report_terminal(
                    state,
                    SkillReport(
                        state=ReportState.FAILED,
                        summary=f"Execution profile is invalid for ticket {state.ticket_id}",
                        error={"code": "invalid_execution", "message": str(exc)},
                    ),
                )
                return

            if state.cancelled:
                # Cancellation during preparation must never spawn Prime Agent.
                await self._cleanup_session(state)
                await self._report_terminal(state, self._cancelled_report(state))
                return

            blocked_bin = install_blocked_shims(state.workspace, plan.blocked_commands)
            async with acp_client.open_prime_agent(
                self.config,
                state.workspace,
                state.session_dir,
                state.resume_ref,
                state.report_url,
                state.report_token,
                state.report_config,
                state.ticket_id,
                on_event=lambda event: self._on_event(state, event),
                agent_cwd=agent_cwd,
                provider=plan.provider,
                model=plan.model,
                thinking=plan.thinking,
                system_prompt_note=plan.prompt_preamble(state.workspace),
                blocked_bin=blocked_bin,
            ) as (connection, process, _client):
                state.connection = connection
                state.process = process
                await acp_client.initialize(connection)
                state.session_id = await acp_client.new_session(connection, agent_cwd)
                state.session_ref = await discover_session_ref(state.session_dir, self.config.start_timeout_s)

                if state.cancelled:
                    await self._cleanup_session(state)
                    await self._report_terminal(state, self._cancelled_report(state))
                    return

                prompt_text = state.prompt
                if state.resume_message:
                    prompt_text = (
                        f"User answer / resume note:\n{state.resume_message}\n\n"
                        "Continue the original Ticket using this answer."
                    )
                await asyncio.wait_for(
                    acp_client.prompt(connection, state.session_id, prompt_text),
                    timeout=plan.timeout_s,
                )

                if state.cancelled:
                    await self._cleanup_session(state)
                    await self._report_terminal(state, self._cancelled_report(state))
                    return

                if state.terminal_report is None:
                    LOG.info("execution %s ended without a terminal report; enforcing", state.assignment_id)
                    await asyncio.wait_for(
                        acp_client.prompt(connection, state.session_id, ENFORCEMENT_PROMPT),
                        timeout=plan.timeout_s,
                    )
                    if state.cancelled:
                        await self._cleanup_session(state)
                        await self._report_terminal(state, self._cancelled_report(state))
                        return
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
            state.timed_out = True
            state.error = "ACP turn exceeded the configured timeout"
            await self._cleanup_session(state)
            if state.cancelled:
                await self._report_terminal(state, self._cancelled_report(state))
            else:
                await self._report_terminal(
                    state,
                    SkillReport(
                        state=ReportState.FAILED,
                        summary="Prime Agent turn timed out",
                        error={"code": "timeout", "message": "ACP turn exceeded the configured timeout"},
                    ),
                )
        except asyncio.CancelledError:
            await self._cleanup_session(state)
            await self._report_terminal(state, self._cancelled_report(state))
            raise
        except Exception as exc:  # noqa: BLE001 - the Worker must report a stable failure
            state.error = str(exc)
            LOG.exception("execution %s failed", state.assignment_id)
            await self._cleanup_session(state)
            if state.cancelled:
                await self._report_terminal(state, self._cancelled_report(state))
            else:
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

    def _cancelled_report(self, state: ExecutionState) -> SkillReport:
        reason = state.cancel_reason or "no reason"
        return SkillReport(
            state=ReportState.CANCELLED,
            summary=f"execution cancelled: {reason[:500]}",
        )

    async def _cleanup_session(self, state: ExecutionState) -> None:
        """Stop the Ticket's daemon session, then cancel and terminate ACP."""
        async with state.cleanup_lock:
            if state.cleanup_done and (
                state.session_ref is None or state.session_ref == state.cleanup_session_ref
            ):
                return
            errors: list[str] = []
            if state.session_ref and state.session_ref != state.cleanup_session_ref:
                session_id = Path(state.session_ref).stem
                try:
                    stopped = await self.daemon.stop_session(session_id)
                    state.cleanup_session_ref = state.session_ref
                    LOG.info(
                        "execution %s session %s %s",
                        state.assignment_id,
                        session_id,
                        "stopped" if stopped else "already stopped",
                    )
                except Exception as exc:  # noqa: BLE001 - cleanup must not hide the original error
                    errors.append(f"stop_session: {exc}")
                    LOG.warning("execution %s stop_session failed: %s", state.assignment_id, exc)

            if not state.cleanup_done:
                if state.connection is not None and state.session_id is not None:
                    timeout = min(5.0, max(1.0, self.config.cancel_wait_s))
                    try:
                        await asyncio.wait_for(
                            acp_client.cancel(state.connection, state.session_id),
                            timeout=timeout,
                        )
                    except asyncio.TimeoutError:
                        LOG.warning("execution %s ACP cancel timed out", state.assignment_id)
                    except Exception as exc:  # noqa: BLE001
                        LOG.warning("execution %s ACP cancel failed: %s", state.assignment_id, exc)

                process = state.process
                if process is not None:
                    try:
                        process.terminate()
                    except ProcessLookupError:
                        pass
                    except Exception as exc:  # noqa: BLE001
                        errors.append(f"ACP terminate: {exc}")
                    else:
                        try:
                            await asyncio.wait_for(
                                process.wait(),
                                timeout=min(5.0, max(1.0, self.config.cancel_wait_s)),
                            )
                        except asyncio.TimeoutError:
                            try:
                                process.kill()
                            except Exception:  # noqa: BLE001
                                pass
                        except Exception:  # noqa: BLE001 - process already gone
                            pass

            state.cleanup_done = True
            if errors:
                message = "; ".join(errors)
                state.cleanup_error = (
                    f"{state.cleanup_error}; {message}" if state.cleanup_error else message
                )

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
            if state.cancelled:
                return ReportAck(accepted=False, reason="execution_cancelled")
            state.latest_report = report
            state.seq += 1
            if report.state is ReportState.COMPLETED:
                plan = state.plan or ExecutionPlan.from_config(self.config, profile=state.profile)
                report = report.model_copy(
                    update={
                        "artifacts": normalize_artifacts(
                            state.workspace, plan.artifact_root, report.artifacts
                        )
                    }
                )
                if not state.metadata_done:
                    try:
                        agent_cwd = resolve_agent_cwd(state.workspace, plan.agent_cwd)
                    except ExecutionConfigError as exc:
                        metadata: dict[str, Any] | None = None
                        metadata_error: str | None = f"metadata skipped: {exc}"
                    else:
                        metadata, metadata_error = await collect_workspace_metadata(
                            self.config,
                            state.workspace,
                            agent_cwd,
                            command=plan.metadata_command,
                            ticket_id=state.ticket_id,
                            assignment_id=state.assignment_id,
                        )
                    state.workspace_metadata = metadata
                    state.metadata_error = metadata_error
                    state.metadata_done = True
                delivery = deliver_artifacts(
                    state.workspace,
                    state.origin_cwd,
                    report.artifacts,
                    self.config,
                    state.ticket_id,
                    options=plan.delivery,
                )
                state.delivered_to = delivery.delivered_to
                state.delivery_error = delivery.error
            worker_report = build_worker_report(
                ticket_id=state.ticket_id,
                assignment_id=state.assignment_id,
                execution_id=state.execution_id,
                seq=state.seq,
                session_ref=state.session_ref,
                report=report,
                delivered_to=state.delivered_to,
                delivery_error=state.delivery_error,
                workspace_metadata=state.workspace_metadata,
                metadata_error=state.metadata_error,
            )
            ack = await self.forwarder.forward(worker_report)
            if report.state in TERMINAL_STATES:
                state.terminal_report = report
            return ack

    async def cancel(self, execution_id: str, reason: str | None = None) -> None:
        state = self.get(execution_id)
        state.cancelled = True
        state.cancel_reason = reason or state.cancel_reason
        await self._cleanup_session(state)

        if not state.done.is_set():
            try:
                await asyncio.wait_for(state.done.wait(), timeout=self.config.cancel_wait_s)
            except asyncio.TimeoutError:
                task = state.task
                if task is not None and not task.done():
                    task.cancel()
                    try:
                        await asyncio.wait_for(task, timeout=self.config.cancel_wait_s)
                    except (asyncio.TimeoutError, asyncio.CancelledError):
                        pass
        await self._report_terminal(state, self._cancelled_report(state))

    async def shutdown(self) -> None:
        """Cancel active Tickets; the caller stops the shared daemon afterwards."""
        self._shutting_down = True
        active = self.active_executions()
        if not active:
            return
        results = await asyncio.gather(
            *(self.cancel(state.execution_id, "worker shutdown") for state in active),
            return_exceptions=True,
        )
        for state, result in zip(active, results):
            if isinstance(result, BaseException):
                LOG.warning(
                    "execution %s failed to stop during worker shutdown: %s",
                    state.assignment_id,
                    result,
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
                delivered_to=state.delivered_to,
                delivery_error=state.delivery_error,
                workspace_metadata=state.workspace_metadata,
                metadata_error=state.metadata_error,
            )
            try:
                await self.forwarder.forward(worker_report)
            except Exception:  # noqa: BLE001
                LOG.exception("execution %s failed to forward terminal report", state.assignment_id)
            state.terminal_report = report
