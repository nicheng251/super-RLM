
import json
from pathlib import Path

import jsonschema
import pytest

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = json.loads((ROOT / "schemas" / "super-rlm.schema.json").read_text(encoding="utf-8"))


def validator(name: str):
    schema = {
        "$schema": SCHEMA["$schema"],
        "$id": SCHEMA["$id"],
        "$defs": SCHEMA["$defs"],
        "$ref": f"#/$defs/{name}",
    }
    return jsonschema.Draft202012Validator(schema)


def report_payload(**overrides):
    payload = {
        "ticket_id": "tkt_1",
        "assignment_id": "asg_1",
        "execution_id": "exe_1",
        "seq": 1,
        "idempotency_key": "asg_1:1",
        "state": "completed",
        "summary": "done",
        "result": "ok",
        "artifacts": [],
        "timestamp": "2026-11-03T00:00:00Z",
    }
    payload.update(overrides)
    return payload


def test_schema_has_core_definitions():
    for name in [
        "TaskView", "TicketResult", "WorkerReport", "ExecutionRequest",
        "Event", "TaskCreateRequest", "SkillReport",
    ]:
        assert name in SCHEMA["$defs"]


def test_task_view_schema_accepts_valid_payload():
    payload = {
        "task_id": "tsk_1",
        "status": "running",
        "prompt": "do it",
        "created_at": "2026-11-03T00:00:00Z",
        "updated_at": "2026-11-03T00:00:01Z",
        "tickets": [{
            "ticket_id": "tkt_1",
            "title": "hello",
            "status": "running",
            "profile": "default",
        }],
    }
    validator("TaskView").validate(payload)


def test_task_view_schema_rejects_unknown_status():
    payload = {
        "task_id": "tsk_1",
        "status": "nonsense",
        "prompt": "do it",
        "created_at": "2026-11-03T00:00:00Z",
        "updated_at": "2026-11-03T00:00:01Z",
        "tickets": [],
    }
    with pytest.raises(jsonschema.ValidationError):
        validator("TaskView").validate(payload)


def test_worker_report_schema_accepts_completed():
    validator("WorkerReport").validate(report_payload())


def test_worker_report_schema_requires_question_for_waiting():
    with pytest.raises(jsonschema.ValidationError):
        validator("WorkerReport").validate(report_payload(
            state="waiting", summary="need input", result=None,
        ))
    validator("WorkerReport").validate(report_payload(
        state="waiting",
        summary="need input",
        result=None,
        question={"kind": "waiting", "text": "Which platform?"},
    ))


def test_worker_report_schema_requires_result_or_artifacts_for_completed():
    with pytest.raises(jsonschema.ValidationError):
        validator("WorkerReport").validate(report_payload(result=None, artifacts=[]))
    validator("WorkerReport").validate(report_payload(
        result=None, artifacts=[{"type": "file", "path": "out.md"}],
    ))


def test_worker_report_schema_requires_error_for_failed():
    with pytest.raises(jsonschema.ValidationError):
        validator("WorkerReport").validate(report_payload(state="failed", summary="boom"))


def test_skill_report_schema_requires_question_for_blocked():
    payload = {"state": "blocked", "summary": "waiting on credentials"}
    with pytest.raises(jsonschema.ValidationError):
        validator("SkillReport").validate(payload)
    validator("SkillReport").validate({
        "state": "blocked",
        "summary": "waiting on credentials",
        "question": {"kind": "blocked", "text": "Configure the token."},
    })

def test_schema_exposes_delivery_fields():
    report_schema = SCHEMA["$defs"]["WorkerReport"]["properties"]
    assert "delivered_to" in report_schema
    assert "delivery_error" in report_schema
    ticket_schema = SCHEMA["$defs"]["TicketSummary"]["properties"]
    assert "delivered_to" in ticket_schema
    assert "delivery_error" in ticket_schema
    execution_schema = SCHEMA["$defs"]["ExecutionRequest"]["properties"]
    assert "origin_cwd" in execution_schema
    validator("WorkerReport").validate(report_payload(
        delivered_to=["/tmp/user/launch/out.txt"], delivery_error="skipped",
    ))
