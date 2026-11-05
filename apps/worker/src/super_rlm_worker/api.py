
"""FastAPI surface for the Worker."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from super_rlm_protocol import ExecutionRequest, ExecutionResponse, ReportAck, SkillReport

from .config import WorkerConfig
from .executor import (
    AtCapacity,
    ExecutionManager,
    ExecutionNotFound,
    InvalidExecution,
    InvalidReportToken,
)


class CancelRequest(BaseModel):
    reason: str | None = None


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    prefix = "Bearer "
    return header[len(prefix):] if header.startswith(prefix) else None


def create_app(
    manager: ExecutionManager,
    config: WorkerConfig,
    lifespan=None,
) -> FastAPI:
    app = FastAPI(title="super-RLM Worker", version="0.1.0", lifespan=lifespan)

    @app.exception_handler(AtCapacity)
    async def _at_capacity(_request: Request, exc: AtCapacity):
        return JSONResponse(status_code=409, content={"error": {"code": "at_capacity", "message": str(exc)}})

    @app.exception_handler(ExecutionNotFound)
    async def _not_found(_request: Request, exc: ExecutionNotFound):
        return JSONResponse(status_code=404, content={"error": {"code": "execution_not_found", "message": str(exc)}})

    @app.exception_handler(InvalidExecution)
    async def _invalid_execution(_request: Request, exc: InvalidExecution):
        return JSONResponse(status_code=400, content={"error": {"code": "invalid_execution", "message": str(exc)}})

    @app.exception_handler(InvalidReportToken)
    async def _invalid_token(_request: Request, exc: InvalidReportToken):
        return JSONResponse(status_code=403, content={"error": {"code": "invalid_report_token", "message": str(exc)}})

    @app.get("/v1/health")
    async def health():
        return {
            "status": "ok",
            "worker_id": config.worker_id,
            "running": manager.running,
            "max_concurrency": manager.max_concurrency,
        }

    @app.post("/v1/executions", status_code=202)
    async def start_execution(request: ExecutionRequest):
        state = await manager.start(request)
        return JSONResponse(
            status_code=202,
            content=ExecutionResponse(execution_id=state.execution_id).model_dump(mode="json"),
        )

    @app.post("/v1/executions/{execution_id}/cancel")
    async def cancel_execution(execution_id: str, body: CancelRequest | None = None):
        await manager.cancel(execution_id, body.reason if body else None)
        return {"status": "cancelled", "execution_id": execution_id}

    @app.post("/internal/assignments/{assignment_id}/report")
    async def report(assignment_id: str, report: SkillReport, request: Request):
        token = _bearer(request)
        if not token:
            raise HTTPException(status_code=401, detail={"code": "invalid_report_token", "message": "missing token"})
        ack: ReportAck = await manager.record_report(assignment_id, token, report)
        return ack.model_dump(mode="json")

    return app
