import json
import os
import sys
from pathlib import Path

import pytest

from super_rlm_worker.config import WorkerConfig
from super_rlm_worker.daemon import DaemonError, PrimeDaemon, canonical_socket

FAKE_AGENT_SOURCE = r"""
import json
import os
import sys
import time
from pathlib import Path

STATE_DIR = Path(__STATE_DIR__)
STATE = STATE_DIR / "state.json"
CALLS = STATE_DIR / "calls.jsonl"


def load():
    if not STATE.exists():
        return {"running": False, "pid": 4242, "sessions": []}
    return json.loads(STATE.read_text(encoding="utf-8"))


def save(state):
    STATE.write_text(json.dumps(state), encoding="utf-8")


def main():
    args = sys.argv[1:]
    CALLS.parent.mkdir(parents=True, exist_ok=True)
    with CALLS.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(args) + "\n")
    state = load()
    if args[:1] == ["status"]:
        if state.get("bad_json"):
            print("daemon log noise, not json")
            return 0
        if state.get("stale") and not state.get("running"):
            print(json.dumps([{
                "socketPath": os.environ.get("PRIME_AGENT_DAEMON_SOCKET"),
                "status": "unreachable",
                "hasTrackedWorkers": True,
            }]))
            return 0
        if state.get("running"):
            print(json.dumps([{
                "socketPath": os.environ.get("PRIME_AGENT_DAEMON_SOCKET"),
                "pid": state.get("pid", 4242),
                "status": "current",
                "sessionCount": len(state.get("sessions", [])),
            }]))
        else:
            print("[]")
        return 0
    if args[:2] == ["--mode", "daemon"]:
        if state.get("fail_start"):
            print("failed to start", file=sys.stderr)
            return 1
        state["running"] = True
        state["pid"] = 4242
        state.setdefault("sessions", [])
        save(state)
        # Stay alive like the real supervisor until shutdown clears the state.
        for _ in range(600):
            time.sleep(0.05)
            try:
                if not load().get("running"):
                    return 0
            except (OSError, ValueError):
                pass
        return 0
    if args[:1] == ["stop"]:
        if len(args) < 2:
            print("missing session", file=sys.stderr)
            return 2
        session_id = args[1]
        sessions = state.get("sessions", [])
        if state.get("running") and session_id in sessions:
            sessions.remove(session_id)
            state["sessions"] = sessions
            save(state)
            print(json.dumps({
                "type": "response", "command": "kill", "success": True, "id": "daemon_1",
            }))
            return 0
        print("Error: Unknown active session: " + session_id, file=sys.stderr)
        return 1
    if args[:1] == ["shutdown"]:
        if state.get("shutdown_failed"):
            print(json.dumps({"stopped": [], "failed": [{"reason": "boom"}]}))
            return 0
        state["running"] = False
        state["sessions"] = []
        save(state)
        print(json.dumps({"stopped": [], "failed": []}))
        return 0
    print("unknown args: " + repr(args), file=sys.stderr)
    return 2


sys.exit(main())
"""


def make_fake_agent(tmp_path: Path) -> tuple[Path, Path]:
    state_dir = tmp_path / "fake-agent-state"
    state_dir.mkdir()
    script = tmp_path / "fake_agent.py"
    script.write_text(
        FAKE_AGENT_SOURCE.replace("__STATE_DIR__", repr(str(state_dir))),
        encoding="utf-8",
    )
    if os.name == "nt":
        wrapper = tmp_path / "prime-agent.cmd"
        wrapper.write_text(
            f'@echo off\r\n"{sys.executable}" "{script}" %*\r\n',
            encoding="utf-8",
        )
    else:
        wrapper = tmp_path / "prime-agent"
        wrapper.write_text(
            f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n',
            encoding="utf-8",
        )
        wrapper.chmod(0o755)
    return wrapper, state_dir


def write_state(state_dir: Path, **values) -> None:
    (state_dir / "state.json").write_text(json.dumps(values), encoding="utf-8")


def read_calls(state_dir: Path) -> list[list[str]]:
    path = state_dir / "calls.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def make_daemon(tmp_path: Path, **env):
    agent, state_dir = make_fake_agent(tmp_path)
    config = WorkerConfig.from_env({
        "SUPER_RLM_HOME": str(tmp_path / "home"),
        "SUPER_RLM_PRIME_AGENT": str(agent),
        "SUPER_RLM_KERNEL_VENV": str(tmp_path / "kernel"),
        "SUPER_RLM_PRIME_DAEMON": str(tmp_path / "daemon" / "worker.sock"),
        "SUPER_RLM_DAEMON_START_TIMEOUT_S": "5",
        "SUPER_RLM_DAEMON_COMMAND_TIMEOUT_S": "5",
        "SUPER_RLM_DAEMON_SHUTDOWN_TIMEOUT_S": "5",
        **env,
    })
    config.ensure_dirs()
    return PrimeDaemon(config), config, state_dir


def test_canonical_socket_is_absolute_and_stable(tmp_path):
    raw = str(tmp_path / "rel" / ".." / "daemon" / "worker.sock")
    canonical = canonical_socket(raw)
    expected = os.path.abspath(raw)
    if os.name == "nt":
        expected = os.path.normcase(expected)
    assert canonical == expected
    assert canonical == canonical_socket(canonical)
    assert os.path.isabs(canonical)


def test_admin_env_uses_the_canonical_socket(tmp_path):
    daemon, config, _ = make_daemon(tmp_path)
    assert daemon.admin_env()["PRIME_AGENT_DAEMON_SOCKET"] == config.daemon_socket
    assert config.daemon_socket == canonical_socket(config.daemon_socket)


@pytest.mark.asyncio
async def test_ensure_reuses_a_running_daemon(tmp_path):
    daemon, config, state_dir = make_daemon(tmp_path)
    write_state(state_dir, running=True, pid=111, sessions=[])
    entry = await daemon.ensure()
    assert entry is not None
    assert entry["pid"] == 111
    calls = read_calls(state_dir)
    assert calls and calls[0] == ["status", "--json"]
    assert not any("--mode" in call for call in calls)


@pytest.mark.asyncio
async def test_ensure_starts_one_detached_daemon(tmp_path):
    daemon, config, state_dir = make_daemon(tmp_path)
    write_state(state_dir, running=False, sessions=[])
    try:
        entry = await daemon.ensure()
        assert entry is not None
        assert entry["pid"] == 4242
        calls = read_calls(state_dir)
        starts = [call for call in calls if call[:2] == ["--mode", "daemon"]]
        assert len(starts) == 1
        assert starts[0][2:] == ["--daemon-socket", config.daemon_socket]
        for call in calls:
            if call[:2] != ["--mode", "daemon"]:
                assert "--daemon-socket" not in call
    finally:
        await daemon.shutdown()


@pytest.mark.asyncio
async def test_ensure_clears_stale_state_before_starting(tmp_path):
    daemon, _, state_dir = make_daemon(tmp_path)
    write_state(state_dir, running=False, sessions=[], stale=True)
    try:
        entry = await daemon.ensure()
        assert entry is not None
        calls = read_calls(state_dir)
        shutdown_index = next(i for i, call in enumerate(calls) if call[:1] == ["shutdown"])
        start_index = next(i for i, call in enumerate(calls) if call[:2] == ["--mode", "daemon"])
        assert shutdown_index < start_index
    finally:
        await daemon.shutdown()


@pytest.mark.asyncio
async def test_ensure_failure_when_daemon_exits(tmp_path):
    daemon, _, state_dir = make_daemon(tmp_path)
    write_state(state_dir, running=False, sessions=[], fail_start=True)
    with pytest.raises(DaemonError, match="exited during startup"):
        await daemon.ensure()


@pytest.mark.asyncio
async def test_ensure_autostart_can_be_disabled(tmp_path):
    daemon, _, state_dir = make_daemon(tmp_path, SUPER_RLM_DAEMON_AUTOSTART="0")
    assert await daemon.ensure() is None
    assert read_calls(state_dir) == []


@pytest.mark.asyncio
async def test_stop_session_unknown_means_already_stopped(tmp_path):
    daemon, _, state_dir = make_daemon(tmp_path)
    write_state(state_dir, running=True, pid=4242, sessions=["sess-1"])
    assert await daemon.stop_session("sess-1") is True
    assert await daemon.stop_session("sess-1") is False
    assert read_calls(state_dir)[-1] == ["stop", "sess-1", "--json"]


@pytest.mark.asyncio
async def test_shutdown_stops_and_verifies(tmp_path):
    daemon, _, state_dir = make_daemon(tmp_path)
    write_state(state_dir, running=True, pid=4242, sessions=["sess-1"])
    await daemon.shutdown()
    calls = read_calls(state_dir)
    assert ["shutdown", "--force", "--json"] in calls
    assert json.loads((state_dir / "state.json").read_text(encoding="utf-8"))["running"] is False
    assert await daemon.status() == []


@pytest.mark.asyncio
async def test_shutdown_reports_failed_entries(tmp_path):
    daemon, _, state_dir = make_daemon(tmp_path)
    write_state(state_dir, running=True, pid=4242, sessions=[], shutdown_failed=True)
    with pytest.raises(DaemonError, match="reported failures"):
        await daemon.shutdown()


@pytest.mark.asyncio
async def test_status_rejects_non_json_output(tmp_path):
    daemon, _, state_dir = make_daemon(tmp_path)
    write_state(state_dir, running=True, pid=4242, sessions=[], bad_json=True)
    with pytest.raises(DaemonError, match="not JSON"):
        await daemon.status()
