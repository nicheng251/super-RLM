"""Resolve per-Assignment execution options sent by the Orchestrator.

The Worker never reads ``config/profiles.yaml``. ``ExecutionRequest.execution``
carries the already-resolved profile; every field falls back to the Worker's
global configuration so older requests keep working.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import WorkerConfig
from .delivery import COLLISION_MODES, DELIVERY_MODES, DeliveryOptions

THINKING_LEVELS = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}
_BLOCKED_COMMAND = re.compile(r"^[A-Za-z0-9._-]+$")


class ExecutionConfigError(ValueError):
    """The Assignment's execution options cannot be applied safely."""


def _field(obj: Any, name: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def validate_blocked_commands(commands: Any) -> tuple[str, ...]:
    result: list[str] = []
    for raw in commands or []:
        name = str(raw).strip()
        if not name:
            continue
        if name in {".", ".."} or not _BLOCKED_COMMAND.fullmatch(name):
            raise ExecutionConfigError(f"invalid blocked command name: {name!r}")
        if name not in result:
            result.append(name)
    return tuple(result)


def safe_relative_path(value: Any, *, default: str = ".") -> Path:
    text = _text(value) or default
    path = Path(text)
    if path.is_absolute() or path.drive:
        raise ExecutionConfigError(f"path must be relative to the workspace: {text!r}")
    parts = tuple(part for part in path.parts if part not in {"", "."})
    if ".." in parts:
        raise ExecutionConfigError(f"path must not contain '..': {text!r}")
    return Path(*parts) if parts else Path(".")


def resolve_agent_cwd(workspace: Path, value: Any) -> Path:
    relative = safe_relative_path(value)
    base = workspace.resolve()
    candidate = (base / relative).resolve()
    try:
        candidate.relative_to(base)
    except ValueError as exc:
        raise ExecutionConfigError("agent_cwd escapes the workspace") from exc
    if not candidate.is_dir():
        raise ExecutionConfigError(f"agent_cwd does not exist: {relative.as_posix()}")
    return candidate


def _delivery_mode(value: Any, name: str) -> str | None:
    text = _text(value)
    if text is None:
        return None
    text = text.lower()
    if text not in DELIVERY_MODES:
        raise ExecutionConfigError(f"delivery {name} must be one of {sorted(DELIVERY_MODES)}")
    return text


def _delivery_collision(value: Any) -> str | None:
    text = _text(value)
    if text is None:
        return None
    text = text.lower()
    if text not in COLLISION_MODES:
        raise ExecutionConfigError(
            f"delivery collision must be one of {sorted(COLLISION_MODES)}"
        )
    return text


def _artifact_relative(path_text: str) -> Path:
    path = Path(path_text)
    if path.is_absolute() or path.drive:
        raise ExecutionConfigError("artifact path must be relative")
    parts = tuple(part for part in path.parts if part not in {"", "."})
    if not parts:
        raise ExecutionConfigError("artifact path is empty")
    if ".." in parts:
        raise ExecutionConfigError("artifact path must not contain '..'")
    return Path(*parts)


def normalize_artifacts(workspace: Path, artifact_root: str, artifacts: list[Any]) -> list[Any]:
    """Rewrite report artifact paths to be workspace-relative.

    Artifacts are reported relative to ``artifact_root``. A path that already
    starts with the root is left as-is so a model cannot double-prefix it.
    Paths that cannot be normalized are kept unchanged and rejected later by
    delivery, which never fails the Ticket.
    """
    root = safe_relative_path(artifact_root)
    root_parts = () if root == Path(".") else root.parts
    base = workspace.resolve()
    normalized: list[Any] = []
    for artifact in artifacts:
        try:
            relative = _artifact_relative(artifact.path)
            if root_parts and relative.parts[: len(root_parts)] == root_parts:
                workspace_relative = relative
            else:
                workspace_relative = Path(*root_parts, *relative.parts)
            (base / workspace_relative).resolve().relative_to(base)
        except (ExecutionConfigError, ValueError):
            normalized.append(artifact)
            continue
        normalized.append(artifact.model_copy(update={"path": workspace_relative.as_posix()}))
    return normalized


@dataclass(frozen=True)
class ExecutionPlan:
    profile: str
    provider: str
    model: str
    thinking: str | None
    timeout_s: float
    prepare_command: str | None
    blocked_commands: tuple[str, ...]
    agent_cwd: str
    artifact_root: str
    metadata_command: str | None
    delivery: DeliveryOptions

    @classmethod
    def from_config(cls, config: WorkerConfig, *, profile: str = "default") -> "ExecutionPlan":
        return cls(
            profile=profile,
            provider=config.prime_provider,
            model=config.prime_model,
            thinking=None,
            timeout_s=config.turn_timeout_s,
            prepare_command=config.prepare_command,
            blocked_commands=(),
            agent_cwd=".",
            artifact_root=".",
            metadata_command=None,
            delivery=DeliveryOptions.from_config(config),
        )

    @classmethod
    def resolve(cls, request: Any, config: WorkerConfig) -> "ExecutionPlan":
        options = _field(request, "execution")
        profile = _text(_field(request, "profile")) or "default"

        thinking = _text(_field(options, "thinking"))
        if thinking is not None and thinking not in THINKING_LEVELS:
            raise ExecutionConfigError(
                f"thinking must be one of {sorted(THINKING_LEVELS)}, got {thinking!r}"
            )

        timeout_raw = _field(options, "timeout_s")
        timeout_s = config.turn_timeout_s if timeout_raw is None else float(timeout_raw)
        if timeout_s <= 0:
            raise ExecutionConfigError("timeout_s must be positive")

        workspace_options = _field(options, "workspace")
        agent_cwd = safe_relative_path(_field(workspace_options, "agent_cwd", "."))
        artifact_root = safe_relative_path(_field(workspace_options, "artifact_root", "."))

        delivery_options = _field(options, "delivery")
        mode = _delivery_mode(_field(delivery_options, "mode"), "mode") or config.delivery_mode
        collision = (
            _delivery_collision(_field(delivery_options, "collision"))
            or config.delivery_collision
        )
        strip_raw = _field(delivery_options, "strip_prefix")
        if delivery_options is not None and strip_raw is not None:
            strip_prefix = str(strip_raw).strip()
        else:
            strip_prefix = config.delivery_strip_prefix
        subdir = (
            _text(_field(delivery_options, "workspace_subdir"))
            or config.delivery_workspace_subdir
        )

        prepare_raw = _field(options, "prepare_command")
        prepare_command = (
            _text(prepare_raw) if prepare_raw is not None else None
        ) or config.prepare_command

        return cls(
            profile=profile,
            provider=_text(_field(options, "provider")) or config.prime_provider,
            model=_text(_field(options, "model")) or config.prime_model,
            thinking=thinking,
            timeout_s=timeout_s,
            prepare_command=prepare_command,
            blocked_commands=validate_blocked_commands(_field(options, "blocked_commands", [])),
            agent_cwd=agent_cwd.as_posix(),
            artifact_root=artifact_root.as_posix(),
            metadata_command=_text(_field(workspace_options, "metadata_command")),
            delivery=DeliveryOptions(
                mode=mode,
                collision=collision,
                strip_prefix=strip_prefix,
                workspace_subdir=subdir,
            ),
        )

    def prompt_preamble(self, workspace: Path | None = None) -> str:
        lines = [f"Execution profile: {self.profile}"]
        if workspace is not None:
            lines.append(f"Workspace root: {workspace}")
        if self.agent_cwd != ".":
            lines.append(f"Agent working directory, relative to the workspace: {self.agent_cwd}")
        lines.append(
            "Report artifact paths relative to the workspace, using the artifact root "
            f"{self.artifact_root!r} as the base."
        )
        if self.blocked_commands:
            lines.append("Blocked commands: " + ", ".join(self.blocked_commands))
        return "\n".join(lines)
