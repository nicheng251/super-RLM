
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

COUNTS = {}

def last_user(messages):
    for m in reversed(messages):
        if m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, str): return c
            if isinstance(c, list): return "\n".join(p.get("text","") for p in c if isinstance(p, dict))
    return ""

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def do_POST(self):
        n=int(self.headers.get("content-length",0) or 0)
        body=json.loads(self.rfile.read(n))
        messages=body.get("messages",[])
        key=last_user(messages)[:300]
        count=COUNTS.get(key,0); COUNTS[key]=count+1
        if "User answer / resume note" in key:
            if count == 0:
                code='await super_rlm_report(state="completed", summary="chose Linux", result="platform=Linux")\nprint("reported")\n'
                kind="tool"
            else:
                code=None; kind="text"
        elif count==0:
            code='await super_rlm_report(state="waiting", summary="need a platform", question="Linux or Windows?")\nprint("asked")\n'
            kind="tool"
        else:
            code=None; kind="text"
        base={"id":"chatcmpl-hitl","object":"chat.completion.chunk","created":int(time.time()),"model":body.get("model","fake-1")}
        self.send_response(200); self.send_header("content-type","text/event-stream"); self.send_header("cache-control","no-cache"); self.send_header("connection","close"); self.end_headers()
        def send(o):
            self.wfile.write(("data: "+json.dumps(o)+"\n\n").encode()); self.wfile.flush()
        if kind=="tool":
            delta={"role":"assistant","tool_calls":[{"index":0,"id":f"call_hitl_{count}","type":"function","function":{"name":"ipython","arguments":json.dumps({"code":code})}}]}
            send(dict(base,choices=[{"index":0,"delta":delta,"finish_reason":None}]))
            send(dict(base,choices=[{"index":0,"delta":{},"finish_reason":"tool_calls"}]))
        else:
            send(dict(base,choices=[{"index":0,"delta":{"role":"assistant","content":"waiting for the answer" if "Linux" not in key else "done"},"finish_reason":None}]))
            send(dict(base,choices=[{"index":0,"delta":{},"finish_reason":"stop"}]))
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush(); self.close_connection=True

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1",int(sys.argv[1])), H).serve_forever()
