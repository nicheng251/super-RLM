
import pytest
from pydantic import ValidationError

from super_rlm_protocol import models as m


def make_ticket_summary(**overrides):
    data = {
        "ticket_id": "tkt_1",
        "title": "hello",
        "status": "running",
        "profile": "default",
        "summary": None,
        "question": None,
        "error": None,
    }
    data.update(overrides)
    return data


def make_report(**overrides):
    data = {
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
    data.update(overrides)
    return data


def test_task_create_requires_a_ticket():
    with pytest.raises(ValidationError):
        m.TaskCreateRequest.model_validate({"prompt": "x", "tickets": []})


def test_task_create_bounds_title_and_ticket_count():
    with pytest.raises(ValidationError):
        m.TaskCreateRequest.model_validate({
            "prompt": "x",
            "tickets": [{"title": "x" * 201, "prompt": "y"}],
        })
    with pytest.raises(ValidationError):
        m.TaskCreateRequest.model_validate({
            "prompt": "x",
            "tickets": [{"title": f"t{i}", "prompt": "y"} for i in range(17)],
        })


def test_task_view_accepts_waiting_ticket():
    view = m.TaskView.model_validate({
        "task_id": "tsk_1",
        "status": "waiting",
        "prompt": "do it",
        "created_at": "2026-11-03T00:00:00Z",
        "updated_at": "2026-11-03T00:00:01Z",
        "tickets": [make_ticket_summary(
            status="waiting",
            question={"kind": "waiting", "text": "Linux or Windows?"},
        )],
    })
    assert view.status is m.TaskStatus.WAITING
    assert view.tickets[0].question.kind is m.QuestionKind.WAITING


def test_completed_report_needs_summary_and_result_or_artifacts():
    assert m.WorkerReport.model_validate(make_report()).state is m.ReportState.COMPLETED
    with pytest.raises(ValidationError):
        m.WorkerReport.model_validate(make_report(result=None, artifacts=[]))
    with pytest.raises(ValidationError):
        m.WorkerReport.model_validate(make_report(summary=None))


def test_waiting_report_needs_question():
    with pytest.raises(ValidationError):
        m.WorkerReport.model_validate(make_report(state="waiting", summary="need input"))
    report = m.WorkerReport.model_validate(make_report(
        state="waiting",
        summary="need input",
        question={"kind": "waiting", "text": "Which platform?"},
    ))
    assert report.question.text == "Which platform?"


def test_failed_report_needs_error():
    with pytest.raises(ValidationError):
        m.WorkerReport.model_validate(make_report(state="failed", summary="boom"))
    report = m.WorkerReport.model_validate(make_report(
        state="failed", summary="boom", error={"code": "timeout", "message": "timed out"},
    ))
    assert report.error.code == "timeout"


def test_dropped_report_needs_summary():
    with pytest.raises(ValidationError):
        m.WorkerReport.model_validate(make_report(state="dropped", summary=None, result=None))
    report = m.WorkerReport.model_validate(make_report(
        state="dropped", summary="nothing to do", result=None,
    ))
    assert report.state is m.ReportState.DROPPED


def test_event_requires_positive_id():
    with pytest.raises(ValidationError):
        m.Event.model_validate({
            "event_id": 0,
            "type": "ticket.waiting",
            "created_at": "2026-11-03T00:00:00Z",
        })

def test_execution_request_origin_cwd_defaults_to_none():
    request = m.ExecutionRequest.model_validate({
        "ticket_id": "tkt_1",
        "assignment_id": "asg_1",
        "prompt": "do it",
        "workspace": "/tmp/workspaces/tkt_1",
    })
    assert request.origin_cwd is None
    explicit = m.ExecutionRequest.model_validate({
        "ticket_id": "tkt_1",
        "assignment_id": "asg_1",
        "prompt": "do it",
        "workspace": "/tmp/workspaces/tkt_1",
        "origin_cwd": "/tmp/user/launch",
    })
    assert explicit.origin_cwd == "/tmp/user/launch"


def test_execution_options_defaults_and_profile_summary():
    options = m.ExecutionOptions.model_validate({"provider": "deepseek", "model": "deepseek-flash"})
    assert options.thinking == "medium"
    assert options.timeout_s == 3600
    assert options.prepare_command is None
    assert options.blocked_commands == []
    assert options.workspace.agent_cwd == "."
    assert options.workspace.artifact_root == "."
    assert options.workspace.metadata_command is None
    assert options.delivery.mode == "artifacts"
    assert options.delivery.collision == "version"

    request = m.ExecutionRequest.model_validate({
        "ticket_id": "tkt_1",
        "assignment_id": "asg_1",
        "prompt": "do it",
        "workspace": "/tmp/workspaces/tkt_1",
        "execution": {
            "provider": "deepseek",
            "model": "deepseek-flash",
            "thinking": "high",
            "timeout_s": 60,
            "prepare_command": "prepare",
            "blocked_commands": ["git"],
            "workspace": {"agent_cwd": "repo", "artifact_root": ".", "metadata_command": "meta"},
            "delivery": {"mode": "none", "collision": "error", "strip_prefix": "out"},
        },
    })
    assert request.execution.thinking == "high"
    assert request.execution.workspace.agent_cwd == "repo"
    assert request.execution.delivery.mode == "none"

    summary = m.ProfileSummary.model_validate({
        "name": "default",
        "provider": "deepseek",
        "model": "deepseek-flash",
        "thinking": "medium",
    })
    assert summary.description == ""


def test_execution_options_reject_bad_values():
    with pytest.raises(ValidationError):
        m.ExecutionOptions.model_validate({"provider": "", "model": "m"})
    with pytest.raises(ValidationError):
        m.ExecutionOptions.model_validate({"provider": "p", "model": "m", "thinking": "turbo"})
    with pytest.raises(ValidationError):
        m.ExecutionOptions.model_validate({"provider": "p", "model": "m", "timeout_s": 0})
    with pytest.raises(ValidationError):
        m.DeliveryOptions.model_validate({"mode": "copy"})


def test_report_and_ticket_results_default_delivery_fields():
    report = m.WorkerReport.model_validate(make_report())
    assert report.delivered_to == []
    assert report.delivery_error is None
    delivered = m.WorkerReport.model_validate(make_report(
        delivered_to=["/tmp/user/launch/out.txt"],
        delivery_error="one artifact was skipped",
    ))
    assert delivered.delivered_to == ["/tmp/user/launch/out.txt"]
    assert delivered.delivery_error == "one artifact was skipped"

    summary = m.TicketSummary.model_validate(make_ticket_summary())
    assert summary.delivered_to == []
    assert summary.delivery_error is None
    assert summary.workspace_metadata is None
    assert summary.metadata_error is None
    result = m.TicketResult.model_validate({
        "ticket_id": "tkt_1",
        "status": "succeeded",
        "artifacts": [],
    })
    assert result.delivered_to == []
    assert result.delivery_error is None
    assert result.workspace_metadata is None
    assert result.metadata_error is None


def test_reports_and_ticket_views_carry_workspace_metadata():
    report = m.WorkerReport.model_validate(make_report(
        workspace_metadata={"vcs": "git", "branch": "b", "commit": "c"},
        metadata_error="partial metadata",
    ))
    assert report.workspace_metadata == {"vcs": "git", "branch": "b", "commit": "c"}
    assert report.metadata_error == "partial metadata"

    summary = m.TicketSummary.model_validate(make_ticket_summary(
        workspace_metadata={"vcs": "none"}, metadata_error="missing git",
    ))
    assert summary.workspace_metadata == {"vcs": "none"}
    assert summary.metadata_error == "missing git"

    result = m.TicketResult.model_validate({
        "ticket_id": "tkt_1",
        "status": "succeeded",
        "workspace_metadata": {"vcs": "git", "branch": "b", "commit": "c"},
        "metadata_error": None,
    })
    assert result.workspace_metadata == {"vcs": "git", "branch": "b", "commit": "c"}
