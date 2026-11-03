
"""Tiny mock Orchestrator for the Pi Router extension spike."""
import argparse, json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ARGS = None
STATE = {"created": 0, "status_calls": 0}


def log(entry):
    with open(ARGS.log, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _auth_ok(self):
        return self.headers.get("authorization") == f"Bearer {ARGS.token}"

    def do_GET(self):
        log({"method": "GET", "path": self.path, "auth": self._auth_ok()})
        if not self._auth_ok():
            return self._send(401, {"error": {"code": "invalid_token", "message": "bad token"}})
        if self.path.startswith("/v1/events"):
            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("cache-control", "no-cache")
            self.send_header("connection", "close")
            self.end_headers()
            self.wfile.write(b": connected\n\n")
            event = {
                "event_id": 1,
                "type": "ticket.waiting",
                "task_id": "tsk_mock_1",
                "ticket_id": "tkt_mock_1",
                "data": {"question": {"kind": "waiting", "text": "Linux or Windows?"}},
                "created_at": "2026-11-03T00:00:00Z",
            }
            self.wfile.write(("id: 1\ndata: " + json.dumps(event) + "\n\n").encode())
            self.wfile.flush()
            time.sleep(30)
            return
        if self.path == "/v1/profiles":
            return self._send(200, {"profiles": [
                {"name": "default", "description": "General-purpose worker", "model": "default", "thinking": "medium"}
            ]})
        if self.path == "/v1/tasks/tsk_mock_1":
            STATE["status_calls"] += 1
            status = "running" if STATE["status_calls"] == 1 else "succeeded"
            return self._send(200, {
                "task_id": "tsk_mock_1", "status": status, "prompt": "Create a hello file",
                "created_at": "2026-11-03T00:00:00Z", "updated_at": "2026-11-03T00:00:01Z",
                "tickets": [{
                    "ticket_id": "tkt_mock_1", "title": "hello", "status": "succeeded" if status == "succeeded" else "running",
                    "profile": "default", "summary": "wrote hello.txt", "question": None, "error": None
                }],
            })
        if self.path.startswith("/v1/tasks/tsk_mock_1/wait"):
            time.sleep(0.2)
            return self._send(200, {
                "task_id": "tsk_mock_1", "status": "succeeded", "prompt": "Create a hello file",
                "created_at": "2026-11-03T00:00:00Z", "updated_at": "2026-11-03T00:00:02Z",
                "tickets": [{
                    "ticket_id": "tkt_mock_1", "title": "hello", "status": "succeeded",
                    "profile": "default", "summary": "wrote hello.txt", "question": None, "error": None
                }],
            })
        if self.path == "/v1/tickets/tkt_mock_1/result":
            return self._send(200, {
                "ticket_id": "tkt_mock_1", "status": "succeeded", "summary": "wrote hello.txt",
                "result": "hello mock result", "artifacts": [], "usage": {"tokens": 10},
                "error": None, "session_ref": "sess_mock",
            })
        return self._send(404, {"error": {"code": "not_found", "message": self.path}})

    def do_POST(self):
        body = self._read_body()
        log({"method": "POST", "path": self.path, "auth": self._auth_ok(), "body": body})
        if not self._auth_ok():
            return self._send(401, {"error": {"code": "invalid_token", "message": "bad token"}})
        if self.path == "/v1/tasks":
            STATE["created"] += 1
            return self._send(201, {
                "task_id": "tsk_mock_1", "status": "queued",
                "tickets": [{"ticket_id": "tkt_mock_1", "title": body["tickets"][0]["title"], "status": "queued"}],
            })
        return self._send(404, {"error": {"code": "not_found", "message": self.path}})

    def _read_body(self):
        n = int(self.headers.get("content-length", 0) or 0)
        raw = self.rfile.read(n)
        try:
            return json.loads(raw)
        except Exception:
            return {"_raw": raw.decode("utf-8", "replace")}


def main():
    global ARGS
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--token", required=True)
    p.add_argument("--log", required=True)
    ARGS = p.parse_args()
    ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
