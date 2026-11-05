
"""super-RLM v0 protocol models.

These models are the authoring source for the checked-in JSON Schema.
The schema under ``packages/protocol/schemas/super-rlm.schema.json`` is
generated from them and is the language-neutral contract.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Id = Annotated[str, StringConstraints(min_length=1, max_length=200)]
ShortText = Annotated[str, StringConstraints(min_length=1, max_length=2048)]


class TaskStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    WAITING = "waiting"
    SUCCEEDED = "succeeded"
    PARTIAL = "partial"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMED_OUT = "timed_out"


class TicketStatus(str, Enum):
    QUEUED = "queued"
    ASSIGNED = "assigned"
    RUNNING = "running"
    WAITING = "waiting"
    BLOCKED = "blocked"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMED_OUT = "timed_out"
    LOST = "lost"


class AssignmentStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    ENDED = "ended"


class AssignmentEndReason(str, Enum):
    COMPLETED = "completed"
    FAILED = "failed"
    WAITING = "waiting"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"
    LOST = "lost"


class ReportState(str, Enum):
    PROGRESS = "progress"
    WAITING = "waiting"
    BLOCKED = "blocked"
    COMPLETED = "completed"
    DROPPED = "dropped"
    FAILED = "failed"
    CANCELLED = "cancelled"


class QuestionKind(str, Enum):
    WAITING = "waiting"
    BLOCKED = "blocked"


class ErrorSource(str, Enum):
    PRIME_AGENT = "prime_agent"
    WORKER = "worker"
    ORCHESTRATOR = "orchestrator"


class EventType(str, Enum):
    TASK_CREATED = "task.created"
    TASK_UPDATED = "task.updated"
    TASK_SETTLED = "task.settled"
    TICKET_CREATED = "ticket.created"
    TICKET_UPDATED = "ticket.updated"
    TICKET_WAITING = "ticket.waiting"
    TICKET_BLOCKED = "ticket.blocked"
    TICKET_SETTLED = "ticket.settled"
    ASSIGNMENT_STARTED = "assignment.started"
    ASSIGNMENT_ENDED = "assignment.ended"
    WORKER_REGISTERED = "worker.registered"
    WORKER_LOST = "worker.lost"
    REPORT_ACCEPTED = "report.accepted"
    REPORT_REJECTED = "report.rejected"


class ErrorObject(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=1)
    message: str
    retryable: bool | None = None
    source: ErrorSource | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class Question(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: QuestionKind
    text: str = Field(min_length=1)
    asked_at: datetime | None = None


class Artifact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["file"] = "file"
    path: str = Field(min_length=1)
    mime: str | None = None


class Usage(BaseModel):
    model_config = ConfigDict(extra="allow")

    total_tokens: int | None = Field(default=None, ge=0)
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    cost_usd: float | None = Field(default=None, ge=0)


class TicketSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticket_id: Id
    title: str = Field(min_length=1, max_length=200)
    status: TicketStatus
    profile: str = "default"
    summary: str | None = None
    question: Question | None = None
    error: ErrorObject | None = None
    outcome: str | None = None
    no_op: bool | None = None
    workspace: str | None = None
    branch: str | None = None
    commit: str | None = None


class TicketResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticket_id: Id
    status: TicketStatus
    summary: str | None = None
    result: str | None = None
    artifacts: list[Artifact] = Field(default_factory=list)
    usage: Usage | None = None
    error: ErrorObject | None = None
    session_ref: str | None = None
    outcome: str | None = None
    no_op: bool | None = None
    workspace: str | None = None
    branch: str | None = None
    commit: str | None = None


class TaskView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: Id
    status: TaskStatus
    prompt: str
    created_at: datetime
    updated_at: datetime
    tickets: list[TicketSummary] = Field(default_factory=list)


class TaskListItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: Id
    status: TaskStatus
    prompt: str
    ticket_count: int = Field(ge=0)
    running_count: int = Field(ge=0)
    waiting_count: int = Field(ge=0)
    created_at: datetime
    updated_at: datetime


class TicketCreateSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=200)
    prompt: str = Field(min_length=1)
    profile: str = "default"
    metadata: dict[str, Any] = Field(default_factory=dict)


class TaskCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(min_length=1)
    tickets: list[TicketCreateSpec] = Field(min_length=1, max_length=16)
    metadata: dict[str, Any] = Field(default_factory=dict)


class CreatedTicket(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticket_id: Id
    title: str
    status: TicketStatus


class TaskCreateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: Id
    status: TaskStatus
    tickets: list[CreatedTicket]


class TaskListRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: TaskStatus | None = None
    limit: int = Field(default=20, ge=1, le=100)
    cursor: str | None = None


class TaskListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tasks: list[TaskListItem]
    next_cursor: str | None = None


class TaskWaitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: Id
    timeout_s: int | None = Field(default=120, ge=0, le=3600)


class TicketActionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticket_id: Id
    status: TicketStatus
    assignment_id: Id | None = None


class TicketAnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticket_id: Id
    message: str = Field(min_length=1)


class TicketResumeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticket_id: Id
    note: str | None = None


class TicketRetryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticket_id: Id
    note: str | None = None


class TicketCancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticket_id: Id
    reason: str | None = None


class TicketCancelResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticket_id: Id
    status: TicketStatus


class TaskCancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: Id
    reason: str | None = None


class TaskCancelResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: Id
    status: TaskStatus


class ResumeSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_ref: str = Field(min_length=1)
    message: str | None = None


class ExecutionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticket_id: Id
    assignment_id: Id
    prompt: str = Field(min_length=1)
    profile: str = "default"
    workspace: str = Field(min_length=1)
    deadline: datetime | None = None
    resume: ResumeSpec | None = None


class ExecutionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    execution_id: Id
    status: Literal["accepted"] = "accepted"


class WorkerRegistration(BaseModel):
    model_config = ConfigDict(extra="forbid")

    worker_id: Id
    url: str = Field(min_length=1)
    max_concurrency: int = Field(ge=1)
    version: str


class WorkerHeartbeat(BaseModel):
    model_config = ConfigDict(extra="forbid")

    running: int = Field(ge=0)
    max_concurrency: int = Field(ge=1)
    status: Literal["healthy", "draining"] = "healthy"


class AssignmentHeartbeat(BaseModel):
    model_config = ConfigDict(extra="forbid")

    execution_id: Id
    phase: Literal["running", "waiting", "blocked"] = "running"


class WorkerReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticket_id: Id
    assignment_id: Id
    execution_id: Id
    seq: int = Field(ge=1)
    idempotency_key: str = Field(min_length=1)
    state: ReportState
    summary: str | None = Field(default=None, max_length=2048)
    result: str | None = Field(default=None, max_length=65536)
    artifacts: list[Artifact] = Field(default_factory=list)
    usage: Usage | None = None
    error: ErrorObject | None = None
    session_ref: str | None = None
    resumed: bool | None = None
    recovery: bool | None = None
    question: Question | None = None
    timestamp: datetime

    @model_validator(mode="after")
    def _state_requirements(self) -> "WorkerReport":
        if self.state in (ReportState.WAITING, ReportState.BLOCKED) and self.question is None:
            raise ValueError(f"{self.state.value} requires question")
        if self.state is ReportState.COMPLETED and not (self.summary and (self.result or self.artifacts)):
            raise ValueError("completed requires summary and a result or artifacts")
        if self.state is ReportState.DROPPED and not self.summary:
            raise ValueError("dropped requires summary")
        if self.state is ReportState.FAILED and self.error is None:
            raise ValueError("failed requires error")
        return self


class ReportAck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    accepted: bool
    reason: str | None = None


class SkillReport(BaseModel):
    """Payload posted by the super-rlm-report skill to the Worker."""

    model_config = ConfigDict(extra="forbid")

    state: ReportState
    summary: str | None = Field(default=None, max_length=2048)
    result: str | None = Field(default=None, max_length=65536)
    question: Question | None = None
    artifacts: list[Artifact] = Field(default_factory=list)
    error: ErrorObject | None = None

    @model_validator(mode="after")
    def _state_requirements(self) -> "SkillReport":
        if self.state in (ReportState.WAITING, ReportState.BLOCKED) and self.question is None:
            raise ValueError(f"{self.state.value} requires question")
        if self.state is ReportState.COMPLETED and not (self.summary and (self.result or self.artifacts)):
            raise ValueError("completed requires summary and a result or artifacts")
        if self.state is ReportState.DROPPED and not self.summary:
            raise ValueError("dropped requires summary")
        if self.state is ReportState.FAILED and self.error is None:
            raise ValueError("failed requires error")
        return self


class Event(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: int = Field(ge=1)
    type: EventType
    task_id: Id | None = None
    ticket_id: Id | None = None
    assignment_id: Id | None = None
    worker_id: Id | None = None
    data: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class EventPage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    events: list[Event]
    next_cursor: str | None = None
