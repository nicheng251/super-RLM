
import asyncio, json, os, sys, pathlib
import acp
from acp.schema import ClientCapabilities, Implementation, TextContentBlock

class C:
    def __init__(self): self.text=[]
    async def session_update(self, session_id, update, **kwargs):
        d = update.model_dump(by_alias=True, exclude_none=True) if hasattr(update, "model_dump") else update
        print("UPDATE", json.dumps(d, ensure_ascii=False)[:800], flush=True)
        # try to capture text chunks
        if isinstance(d, dict):
            c = d.get("content")
            if isinstance(c, dict) and c.get("type") == "text":
                self.text.append(c.get("text",""))
    async def request_permission(self, session_id, tool_call, options, **kwargs):
        print("PERM", session_id, tool_call, options, flush=True)
        opt = options[0]
        oid = getattr(opt, "option_id", None) or (opt.get("optionId") if isinstance(opt, dict) else None)
        return acp.RequestPermissionResponse(outcome={"outcome":"selected","optionId":oid})

async def main():
    home=pathlib.Path(sys.argv[1]); exe=sys.argv[2]
    env=os.environ.copy()
    for k,v in {
        "PRIME_AGENT_CODING_AGENT_DIR": home/"prime/agent",
        "PRIME_AGENT_SESSION_DIR": home/"prime/sessions",
        "PRIME_AGENT_DAEMON_SOCKET": home/"prime/daemon/official.sock",
        "PRIME_AGENT_KERNEL_VENV": home/"prime/kernel-venv",
        "PRIME_AGENT_KERNEL_PYTHON": home/"prime/kernel-venv/Scripts/python.exe",
    }.items(): env[k]=str(v)
    work=home/"workspaces/official"; work.mkdir(parents=True, exist_ok=True)
    c=C()
    async with acp.spawn_agent_process(
        c, exe, "--mode","acp","--cwd",str(work),"--provider","fake","--model","fake-1",
        "--session-dir",str(home/"prime/sessions"),"--daemon-socket",str(home/"prime/daemon/official.sock"),
        env=env, cwd=str(work),
    ) as (conn, process):
        init = await conn.initialize(protocol_version=1, client_capabilities=ClientCapabilities(), client_info=Implementation(name="probe", version="0.1"))
        print("INIT", init.model_dump(by_alias=True, exclude_none=True), flush=True)
        ns = await conn.new_session(cwd=str(work), mcp_servers=[])
        print("SESSION", ns.model_dump(by_alias=True, exclude_none=True), flush=True)
        res = await conn.prompt(ns.session_id, [TextContentBlock(type="text", text="Say hello.")])
        print("PROMPT", res.model_dump(by_alias=True, exclude_none=True), flush=True)
        print("TEXT", "".join(c.text), flush=True)
        await process.terminate()

asyncio.run(main())
