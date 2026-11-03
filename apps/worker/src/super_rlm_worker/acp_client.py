
"""Thin wrapper around the official ACP client for Prime Agent."""

from __future__ import annotations

import inspect
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Awaitable, Callable

import acp
from acp.schema import ClientCapabilities, Implementation, TextContentBlock

from .config import WorkerConfig
from .prime_agent import build_args, build_env


EventCallback = Callable[[dict[str, Any]], Awaitable[None] | None]


class PrimeClient:
    """ACP client callbacks. Prime Agent only needs session updates and permissions."""

    def __init__(self, on_event: EventCallback | None = None) -> None:
        self.on_event = on_event
        self.text_parts: list[str] = []
        self.events: list[dict[str, Any]] = []
        self.session_updates: list[dict[str, Any]] = []

    async def _emit(self, event: dict[str, Any]) -> None:
        self.events.append(event)
        if self.on_event is not None:
            result = self.on_event(event)
            if inspect.isawaitable(result):
                await result

    async def session_update(self, session_id: str, update: Any, **kwargs: Any) -> None:
        data = update.model_dump(by_alias=True, exclude_none=True) if hasattr(update, "model_dump") else update
        if not isinstance(data, dict):
            return
        self.session_updates.append(data)
        if data.get("sessionUpdate") == "agent_message_chunk":
            content = data.get("content") or {}
            if isinstance(content, dict) and content.get("type") == "text":
                self.text_parts.append(str(content.get("text", "")))
        await self._emit({"kind": "session_update", "update": data})

    async def request_permission(
        self,
        session_id: str,
        tool_call: Any,
        options: list[Any],
        **kwargs: Any,
    ) -> acp.RequestPermissionResponse:
        option_id = None
        if options:
            first = options[0]
            option_id = getattr(first, "option_id", None)
            if option_id is None and isinstance(first, dict):
                option_id = first.get("optionId")
        await self._emit({
            "kind": "permission_request",
            "session_id": session_id,
            "tool_call": tool_call.model_dump(by_alias=True, exclude_none=True)
            if hasattr(tool_call, "model_dump") else str(tool_call),
            "option_id": option_id,
        })
        if option_id is None:
            return acp.RequestPermissionResponse(outcome={"outcome": "cancelled"})
        return acp.RequestPermissionResponse(outcome={"outcome": "selected", "optionId": option_id})

    @property
    def text(self) -> str:
        return "".join(self.text_parts)


@asynccontextmanager
async def open_prime_agent(
    config: WorkerConfig,
    workspace: Path,
    session_dir: Path,
    session_ref: str | None,
    report_url: str,
    report_token: str,
    ticket_id: str,
    on_event: EventCallback | None = None,
):
    client = PrimeClient(on_event=on_event)
    env = build_env(config, workspace, ticket_id, session_dir, report_url, report_token)
    args = build_args(config, workspace, session_dir, session_ref)
    async with acp.spawn_agent_process(
        client,
        str(config.prime_agent),
        *args,
        env=env,
        cwd=str(workspace),
    ) as (connection, process):
        yield connection, process, client


async def initialize(connection: Any) -> None:
    await connection.initialize(
        protocol_version=1,
        client_capabilities=ClientCapabilities(),
        client_info=Implementation(name="super-rlm-worker", version="0.1.0"),
    )


async def new_session(connection: Any, workspace: Path) -> str:
    response = await connection.new_session(cwd=str(workspace), mcp_servers=[])
    return response.session_id


async def prompt(connection: Any, session_id: str, text: str) -> Any:
    return await connection.prompt(session_id, [TextContentBlock(type="text", text=text)])


async def cancel(connection: Any, session_id: str) -> None:
    await connection.cancel(session_id)
