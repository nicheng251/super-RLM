
"""Generate the language-neutral JSON Schema from the pydantic models."""

from __future__ import annotations

import json
from pathlib import Path

from pydantic.json_schema import models_json_schema

from super_rlm_protocol import models as m

MODELS = [
    m.ErrorObject,
    m.Question,
    m.Artifact,
    m.Usage,
    m.TicketSummary,
    m.TicketResult,
    m.TaskView,
    m.TaskListItem,
    m.TicketCreateSpec,
    m.TaskCreateRequest,
    m.CreatedTicket,
    m.TaskCreateResponse,
    m.TaskListRequest,
    m.TaskListResponse,
    m.TaskWaitRequest,
    m.TicketActionResult,
    m.TicketAnswerRequest,
    m.TicketResumeRequest,
    m.TicketRetryRequest,
    m.TicketCancelRequest,
    m.TicketCancelResponse,
    m.TaskCancelRequest,
    m.TaskCancelResponse,
    m.ResumeSpec,
    m.WorkspaceOptions,
    m.DeliveryOptions,
    m.ExecutionOptions,
    m.ProfileSummary,
    m.ExecutionRequest,
    m.ExecutionResponse,
    m.WorkerRegistration,
    m.WorkerHeartbeat,
    m.AssignmentHeartbeat,
    m.WorkerReport,
    m.ReportAck,
    m.SkillReport,
    m.Event,
    m.EventPage,
]

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "schemas"



def report_conditions() -> list[dict]:
    """JSON Schema mirror of the report state requirements."""
    return [
        {
            "if": {"properties": {"state": {"const": "waiting"}}, "required": ["state"]},
            "then": {"required": ["question"], "properties": {"question": {"type": "object"}}},
        },
        {
            "if": {"properties": {"state": {"const": "blocked"}}, "required": ["state"]},
            "then": {"required": ["question"], "properties": {"question": {"type": "object"}}},
        },
        {
            "if": {"properties": {"state": {"const": "completed"}}, "required": ["state"]},
            "then": {
                "required": ["summary"],
                "properties": {"summary": {"type": "string", "minLength": 1}},
                "anyOf": [
                    {"required": ["result"], "properties": {"result": {"type": "string", "minLength": 1}}},
                    {"required": ["artifacts"], "properties": {"artifacts": {"minItems": 1}}},
                ],
            },
        },
        {
            "if": {"properties": {"state": {"const": "dropped"}}, "required": ["state"]},
            "then": {"required": ["summary"], "properties": {"summary": {"type": "string", "minLength": 1}}},
        },
        {
            "if": {"properties": {"state": {"const": "failed"}}, "required": ["state"]},
            "then": {"required": ["error"], "properties": {"error": {"type": "object"}}},
        },
    ]


def main() -> None:
    _, definitions = models_json_schema(
        [(model, "validation") for model in MODELS],
        title="super-RLM protocol",
        description="Language-neutral v0 contract for super-RLM.",
    )
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://super-rlm.local/schemas/super-rlm.schema.json",
        "title": "super-RLM protocol",
        "description": "Language-neutral v0 contract for super-RLM.",
        "$defs": definitions["$defs"],
    }
    for name in ("WorkerReport", "SkillReport"):
        schema["$defs"][name]["allOf"] = report_conditions()
    SCHEMAS.mkdir(parents=True, exist_ok=True)
    (SCHEMAS / "super-rlm.schema.json").write_text(
        json.dumps(schema, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    wrappers = {
        "task.schema.json": "TaskView",
        "ticket.schema.json": "TicketResult",
        "assignment.schema.json": "ExecutionRequest",
        "report.schema.json": "WorkerReport",
        "event.schema.json": "Event",
        "router-api.schema.json": "TaskCreateRequest",
        "worker-api.schema.json": "WorkerReport",
    }
    for filename, definition in wrappers.items():
        wrapper = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": f"https://super-rlm.local/schemas/{filename}",
            "$ref": f"super-rlm.schema.json#/$defs/{definition}",
        }
        (SCHEMAS / filename).write_text(
            json.dumps(wrapper, indent=2) + "\n", encoding="utf-8"
        )

    print(f"wrote {len(MODELS)} definitions to {SCHEMAS / 'super-rlm.schema.json'}")


if __name__ == "__main__":
    main()
