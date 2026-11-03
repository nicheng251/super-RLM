
"""Build and forward Worker reports to the Orchestrator."""

from __future__ import annotations

from datetime import datetime, timezone

import httpx

from super_rlm_protocol import ReportAck, ReportState, SkillReport, WorkerReport

TERMINAL_STATES = {
    ReportState.COMPLETED,
    ReportState.DROPPED,
    ReportState.WAITING,
    ReportState.BLOCKED,
    ReportState.FAILED,
    ReportState.CANCELLED,
}


class ReportForwardError(RuntimeError):
    pass


def build_worker_report(
    *,
    ticket_id: str,
    assignment_id: str,
    execution_id: str,
    seq: int,
    session_ref: str | None,
    report: SkillReport,
) -> WorkerReport:
    return WorkerReport(
        ticket_id=ticket_id,
        assignment_id=assignment_id,
        execution_id=execution_id,
        seq=seq,
        idempotency_key=f"{assignment_id}:{seq}",
        state=report.state,
        summary=report.summary,
        result=report.result,
        artifacts=report.artifacts,
        error=report.error,
        session_ref=session_ref,
        question=report.question,
        timestamp=datetime.now(timezone.utc),
    )


class ReportForwarder:
    def __init__(self, orchestrator_url: str, worker_token: str) -> None:
        self.orchestrator_url = orchestrator_url.rstrip("/")
        self.worker_token = worker_token

    async def forward(self, report: WorkerReport) -> ReportAck:
        headers = {"content-type": "application/json"}
        if self.worker_token:
            headers["authorization"] = f"Bearer {self.worker_token}"
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                f"{self.orchestrator_url}/internal/v1/reports",
                headers=headers,
                json=report.model_dump(mode="json"),
            )
        if response.status_code >= 400:
            raise ReportForwardError(f"Orchestrator rejected report: {response.status_code} {response.text}")
        return ReportAck.model_validate(response.json())
