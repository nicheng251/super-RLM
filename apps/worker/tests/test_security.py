import logging
import os
from pathlib import Path

import pytest

from super_rlm_worker.config import WorkerConfig, TICKET_TEMP_KEYS
from super_rlm_worker.prepare import PrepareError, build_prepare_env, prepare_workspace, shell_invocation
from super_rlm_worker.prime_agent import build_env
from super_rlm_worker.redact import REDACTED, redact_secrets


def base_env(tmp_path):
    return {
        "SUPER_RLM_HOME": str(tmp_path / "home"),
        "SUPER_RLM_PRIME_AGENT": str(tmp_path / "prime-agent.exe"),
        "SUPER_RLM_KERNEL_VENV": str(tmp_path / "kernel"),
        "SUPER_RLM_WORKER_ID": "wrk_test",
        "SUPER_RLM_WORKER_TOKEN": "test-worker-token",
        "SUPER_RLM_CALLBACK_KEY": "test-callback-key",
    }


def test_worker_accepts_only_loopback_hosts(tmp_path):
    config = WorkerConfig.from_env(base_env(tmp_path))
    assert config.host == "127.0.0.1"

    localhost = WorkerConfig.from_env({**base_env(tmp_path), "SUPER_RLM_WORKER_HOST": "localhost"})
    assert localhost.host == "127.0.0.1"

    ipv6 = WorkerConfig.from_env({**base_env(tmp_path), "SUPER_RLM_WORKER_HOST": "::1"})
    assert ipv6.host == "::1"


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "example.com", " "])
def test_worker_rejects_non_loopback_hosts(tmp_path, host):
    with pytest.raises(ValueError, match="127\\.0\\.0\\.1 or ::1"):
        WorkerConfig.from_env({**base_env(tmp_path), "SUPER_RLM_WORKER_HOST": host})


def test_build_env_scopes_temp_and_caches_per_ticket(tmp_path, monkeypatch):
    monkeypatch.setenv("TEMP", "C:/global-temp")
    monkeypatch.setenv("TMP", "C:/global-temp")
    config = WorkerConfig.from_env(base_env(tmp_path))
    env = build_env(
        config,
        workspace=tmp_path / "workspace",
        ticket_id="tkt_1",
        session_dir=tmp_path / "sessions" / "tkt_1",
        report_url="http://127.0.0.1:8080/report",
        report_token="secret",
        report_config=tmp_path / "workspace" / ".super-rlm-report.json",
    )
    ticket_tmp = config.home / "tmp" / "tkt_1"
    assert ticket_tmp.is_dir()
    for key in TICKET_TEMP_KEYS:
        assert env[key] == str(ticket_tmp)
    assert env.get("HOME") == os.environ.get("HOME")


def test_build_prepare_env_scopes_temp_and_caches_per_ticket(tmp_path):
    config = WorkerConfig.from_env(base_env(tmp_path))
    env = build_prepare_env(config, tmp_path / "workspace", "tkt_prepare", "asg_1")
    ticket_tmp = config.home / "tmp" / "tkt_prepare"
    assert ticket_tmp.is_dir()
    for key in TICKET_TEMP_KEYS:
        assert env[key] == str(ticket_tmp)
    assert env.get("HOME") == os.environ.get("HOME")


@pytest.mark.parametrize("key", ["SUPER_RLM_WORKER_TOKEN", "SUPER_RLM_CALLBACK_KEY"])
def test_worker_requires_api_secrets(tmp_path, key):
    env = base_env(tmp_path)
    env.pop(key)
    with pytest.raises(ValueError, match=key) as missing:
        WorkerConfig.from_env(env)
    assert "super-rlm" in str(missing.value)
    assert str(Path(env["SUPER_RLM_HOME"]) / "secrets" / "api.env") in str(missing.value)

    with pytest.raises(ValueError, match=key):
        WorkerConfig.from_env({**base_env(tmp_path), key: "   "})


def test_worker_uses_explicit_api_secrets(tmp_path):
    config = WorkerConfig.from_env({
        **base_env(tmp_path),
        "SUPER_RLM_WORKER_TOKEN": "explicit-worker-token",
        "SUPER_RLM_CALLBACK_KEY": "explicit-callback-key",
    })
    assert config.worker_token == "explicit-worker-token"
    assert config.callback_key == "explicit-callback-key"


def test_worker_from_empty_env_does_not_inherit_ambient_tokens(monkeypatch):
    monkeypatch.setenv("SUPER_RLM_WORKER_TOKEN", "ambient-worker-token")
    monkeypatch.setenv("SUPER_RLM_CALLBACK_KEY", "ambient-callback-key")
    with pytest.raises(ValueError, match="SUPER_RLM_WORKER_TOKEN"):
        WorkerConfig.from_env({})


def test_redact_secrets_replaces_known_values_and_authorization_headers():
    env = {
        "SUPER_RLM_WORKER_TOKEN": "tok_123456",
        "SUPER_RLM_CALLBACK_KEY": "key_abcdef",
        "SUPER_RLM_REPORT_SECRET": "report_secret_value",
        "PATH": "/usr/bin",
    }
    text = (
        "token=tok_123456 key=key_abcdef report=report_secret_value "
        "path=/usr/bin"
    )
    redacted = redact_secrets(text, env)
    assert "tok_123456" not in redacted
    assert "key_abcdef" not in redacted
    assert "report_secret_value" not in redacted
    assert "/usr/bin" in redacted
    assert redacted.count(REDACTED) == 3

    auth = redact_secrets("Authorization: Bearer abcdef123456", {})
    assert auth == "Authorization: Bearer [REDACTED]"
    assert redact_secrets("Authorization=Bearer xyz", {}) == "Authorization=Bearer [REDACTED]"


def test_redact_secrets_ignores_short_values():
    assert redact_secrets("the key is abc", {"SOME_KEY": "abc"}) == "the key is abc"


@pytest.mark.asyncio
async def test_prepare_failure_output_is_redacted(tmp_path, monkeypatch, caplog):
    monkeypatch.setenv("SUPER_RLM_WORKER_TOKEN", "tok_prepare_secret")
    env = {**base_env(tmp_path), "SUPER_RLM_PREPARE_COMMAND": "echo tok_prepare_secret; echo boom >&2; exit 3"}
    config = WorkerConfig.from_env(env)
    try:
        shell_invocation(config, "true")
    except PrepareError as exc:
        pytest.skip(str(exc))
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with caplog.at_level(logging.INFO):
        with pytest.raises(PrepareError) as info:
            await prepare_workspace(config, workspace, "tkt_redact", "asg_1")

    assert "tok_prepare_secret" not in str(info.value)
    assert REDACTED in str(info.value)
    assert "tok_prepare_secret" not in caplog.text
    assert "boom" in caplog.text
