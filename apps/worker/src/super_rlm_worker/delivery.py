"""Deliver a completed Ticket's results to the user's launch directory."""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

from super_rlm_protocol import Artifact

from .config import WorkerConfig

WORKSPACE_EXCLUDES = (".git", ".super-rlm-report.json", ".super-rlm-prepared")


class DeliveryPathError(ValueError):
    """An artifact path cannot be delivered safely."""


@dataclass
class DeliveryResult:
    delivered_to: list[str] = field(default_factory=list)
    error: str | None = None


def deliver_artifacts(
    workspace: Path,
    origin_cwd: str | None,
    artifacts: list[Artifact],
    config: WorkerConfig,
    ticket_id: str,
) -> DeliveryResult:
    """Copy a completed Ticket's artifacts into ``origin_cwd``.

    Delivery is best-effort: expected failures are returned in ``error`` and
    never change the Ticket's state.
    """
    mode = config.delivery_mode
    if mode == "none" or not origin_cwd:
        return DeliveryResult()

    origin = Path(origin_cwd).expanduser()
    try:
        origin = origin.resolve(strict=True)
    except OSError as exc:
        return DeliveryResult(error=f"origin directory is not accessible: {origin_cwd}: {exc}")
    if not origin.is_dir():
        return DeliveryResult(error=f"origin path is not a directory: {origin}")
    if not workspace.is_dir():
        return DeliveryResult(error=f"workspace is not a directory: {workspace}")
    workspace = workspace.resolve()

    if mode == "workspace":
        return _deliver_workspace(workspace, origin, config, ticket_id)
    return _deliver_artifact_files(workspace, origin, artifacts, config, ticket_id)


def _deliver_artifact_files(
    workspace: Path,
    origin: Path,
    artifacts: list[Artifact],
    config: WorkerConfig,
    ticket_id: str,
) -> DeliveryResult:
    delivered: list[str] = []
    errors: list[str] = []
    for artifact in artifacts:
        try:
            source, relative = _source_path(workspace, artifact.path)
            destination_relative = _strip_prefix(relative, config.delivery_strip_prefix)
            if not destination_relative.parts:
                raise DeliveryPathError("artifact path is empty after stripping its prefix")
            destination = _destination_path(origin, destination_relative)
            destination = _choose_destination(destination, config.delivery_collision, ticket_id)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            delivered.append(str(destination))
        except (DeliveryPathError, OSError) as exc:
            errors.append(f"{artifact.path}: {exc}")
    return DeliveryResult(delivered_to=delivered, error="; ".join(errors) or None)


def _source_path(workspace: Path, artifact_path: str) -> tuple[Path, Path]:
    relative = _safe_relative(artifact_path)
    source = (workspace / relative).resolve()
    try:
        source.relative_to(workspace)
    except ValueError as exc:
        raise DeliveryPathError("artifact path escapes the workspace") from exc
    if not source.is_file():
        raise DeliveryPathError("artifact is not an existing file")
    return source, relative


def _safe_relative(path_text: str) -> Path:
    path = Path(path_text)
    if path.is_absolute() or path.drive:
        raise DeliveryPathError("artifact path must be relative")
    parts = path.parts
    if not parts:
        raise DeliveryPathError("artifact path is empty")
    if ".." in parts:
        raise DeliveryPathError("artifact path must not contain '..'")
    return path


def _strip_prefix(path: Path, prefix: str) -> Path:
    prefix_parts = tuple(part for part in Path(prefix).parts if part not in {"", "."}) if prefix else ()
    if not prefix_parts:
        return path
    parts = path.parts
    if parts[: len(prefix_parts)] == prefix_parts:
        return Path(*parts[len(prefix_parts):])
    return path


def _destination_path(origin: Path, relative: Path) -> Path:
    destination = (origin / relative).resolve()
    try:
        destination.relative_to(origin)
    except ValueError as exc:
        raise DeliveryPathError("destination escapes the origin directory") from exc
    if destination == origin:
        raise DeliveryPathError("destination is the origin directory")
    return destination


def _choose_destination(destination: Path, collision: str, ticket_id: str) -> Path:
    if not destination.exists():
        return destination
    if collision == "overwrite":
        if destination.is_dir():
            raise DeliveryPathError("destination is a directory")
        return destination
    if collision == "error":
        raise DeliveryPathError("destination already exists")
    return _versioned_path(destination, ticket_id)


def _versioned_path(destination: Path, ticket_id: str) -> Path:
    base = destination.with_name(f"{destination.stem}.super-rlm-{ticket_id}{destination.suffix}")
    candidate = base
    counter = 2
    while candidate.exists():
        candidate = base.with_name(f"{base.stem}-{counter}{base.suffix}")
        counter += 1
    return candidate


def _deliver_workspace(
    workspace: Path,
    origin: Path,
    config: WorkerConfig,
    ticket_id: str,
) -> DeliveryResult:
    base = origin / ".super-rlm" / ticket_id
    destination = _choose_workspace_destination(base, config.delivery_collision)
    if isinstance(destination, DeliveryResult):
        return destination
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            workspace,
            destination,
            ignore=shutil.ignore_patterns(*WORKSPACE_EXCLUDES),
        )
    except OSError as exc:
        return DeliveryResult(error=f"could not copy workspace: {exc}")
    return DeliveryResult(delivered_to=[str(destination)])


def _choose_workspace_destination(base: Path, collision: str) -> Path | DeliveryResult:
    if not base.exists():
        return base
    if collision == "error":
        return DeliveryResult(error=f"destination already exists: {base}")
    if collision == "overwrite":
        try:
            if base.is_dir():
                shutil.rmtree(base)
            else:
                base.unlink()
        except OSError as exc:
            return DeliveryResult(error=f"could not replace {base}: {exc}")
        return base
    candidate = base
    counter = 2
    while candidate.exists():
        candidate = base.with_name(f"{base.name}-{counter}")
        counter += 1
    return candidate
