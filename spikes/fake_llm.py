
"""Local OpenAI-compatible fake model server for super-RLM spikes.

Modes:
  pi_router   scripted Router tool calls (task_create -> task_wait -> final text)
  prime_acp   parent agent spawns two rlm children, then summarizes; children return text

Every request body is appended to --log as one JSON line. Start with:
  python fake_llm.py --port 18901 --mode pi_router --log ...
"""
import argparse, json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ARGS = None


def last_user_text(messages):
    for m in reversed(messages):
        if m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, str):
                return c
            if isinstance(c, list):
                return "\n".join(p.get("text", "") for p in c if isinstance(p, dict))
    return ""


def tool_call_count(messages):
    n = 0
    for m in messages:
        if m.get("role") == "assistant":
            n += len(m.get("tool_calls") or [])
    return n


def tool_result_count(messages):
    return sum(1 for m in messages if m.get("role") == "tool")


def pi_router_script(messages):
    calls = tool_call_count(messages)
    if calls == 0:
        return {"tool": ("task_create", {
            "task_prompt": "Create a hello file",
            "tickets": [{"title": "hello", "prompt": "Write hello.txt", "profile": "default"}],
        })}
    if calls == 1:
        return {"tool": ("task_wait", {"task_id": "tsk_mock_1", "timeout_s": 30})}
    return {"text": "Task tsk_mock_1 finished. The mock result is available."}


def prime_parent_script(messages):
    txt = last_user_text(messages).lower()
    if "return the word alpha" in txt:
        return {"text": "ALPHA"}
    if "return the word beta" in txt:
        return {"text": "BETA"}
    calls = tool_call_count(messages)
    if calls == 0:
        code = (
            "import json\na = await rlm.spawn('Return the word ALPHA.', name='alpha')\n"
            "b = await rlm.spawn('Return the word BETA.', name='beta')\nawait asyncio.sleep(2)\n"
            "rows = await rlm.collect(timeout_ms=120000)\n"
            "print(json.dumps([{'name': r.session_name, 'status': r.status, 'answer': r.answer_preview} for r in rows]))\n"
        )
        return {"tool": ("ipython", {"code": code})}
    return {"text": "Spike complete: two RLM children were spawned and collected."}


def prime_child_script(messages):
    txt = last_user_text(messages).lower()
    if "alpha" in txt:
        return {"text": "ALPHA"}
    if "beta" in txt:
        return {"text": "BETA"}
    return {"text": "child done"}


def pi_router_full_script(messages):
    calls = tool_call_count(messages)
    if calls == 0:
        return {"tool": ("profile_list", {})}
    if calls == 1:
        return {"tool": ("task_create", {
            "task_prompt": "Create a hello file",
            "tickets": [{"title": "hello", "prompt": "Write hello.txt", "profile": "default"}],
        })}
    if calls == 2:
        return {"tool": ("task_status", {"task_id": "tsk_mock_1"})}
    if calls == 3:
        return {"tool": ("task_wait", {"task_id": "tsk_mock_1", "timeout_s": 30})}
    if calls == 4:
        return {"tool": ("ticket_result", {"ticket_id": "tkt_mock_1", "max_chars": 20000})}
    return {"text": "Task tsk_mock_1 succeeded; ticket result was read."}


def pi_router_bash_script(messages):
    calls = tool_call_count(messages)
    if calls == 0:
        return {"tool": ("bash", {"command": "echo should-not-run"})}
    return {"text": "Finished after the unavailable-tool check."}


def script_for(messages):
    if ARGS.mode == "pi_router":
        return pi_router_script(messages)
    if ARGS.mode == "pi_router_full":
        return pi_router_full_script(messages)
    if ARGS.mode == "pi_router_bash":
        return pi_router_bash_script(messages)
    if ARGS.mode == "prime_acp":
        # The root prompt is the tripwire; children get the spawn prompts.
        joined = json.dumps(messages).lower()
        if "return the word alpha" in joined or "return the word beta" in joined:
            # Both root and child see the spawn prompt; children have no ipython tool.
            pass
        return prime_parent_script(messages)
    return {"text": "unknown mode"}


def sse(obj):
    return ("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _body(self):
        n = int(self.headers.get("content-length", 0) or 0)
        raw = self.rfile.read(n)
        try:
            return json.loads(raw)
        except Exception:
            return {"_raw": raw.decode("utf-8", "replace")}

    def do_POST(self):
        body = self._body()
        body["_path"] = self.path
        body["_mode"] = ARGS.mode
        with open(ARGS.log, "a", encoding="utf-8") as f:
            f.write(json.dumps(body, ensure_ascii=False) + "\n")

        messages = body.get("messages", [])
        script = script_for(messages)
        model = body.get("model", "fake-1")
        base = {"id": "chatcmpl-fake", "object": "chat.completion.chunk",
                "created": int(time.time()), "model": model}

        if not body.get("stream"):
            if "tool" in script:
                name, args = script["tool"]
                msg = {"role": "assistant", "content": None, "tool_calls": [
                    {"id": "call_fake_1", "type": "function",
                     "function": {"name": name, "arguments": json.dumps(args)}}]}
                finish = "tool_calls"
            else:
                msg = {"role": "assistant", "content": script.get("text", "")}
                finish = "stop"
            data = json.dumps({"id": "chatcmpl-fake", "object": "chat.completion",
                               "created": int(time.time()), "model": model,
                               "choices": [{"index": 0, "message": msg, "finish_reason": finish}]}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        self.send_response(200)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()

        if "tool" in script:
            name, args = script["tool"]
            delta = {"role": "assistant", "tool_calls": [{
                "index": 0, "id": "call_fake_1", "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)}}]}
            self.wfile.write(sse(dict(base, choices=[{"index": 0, "delta": delta, "finish_reason": None}])))
            self.wfile.write(sse(dict(base, choices=[{"index": 0, "delta": {}, "finish_reason": "tool_calls"}])))
        else:
            text = script.get("text", "")
            self.wfile.write(sse(dict(base, choices=[{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}])))
            self.wfile.write(sse(dict(base, choices=[{"index": 0, "delta": {}, "finish_reason": "stop"}])))
        self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True


def main():
    global ARGS
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--mode", choices=["pi_router", "pi_router_full", "pi_router_bash", "prime_acp"], required=True)
    p.add_argument("--log", required=True)
    ARGS = p.parse_args()
    ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
