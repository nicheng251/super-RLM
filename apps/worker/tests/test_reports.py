
import hashlib
import hmac
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from super_rlm_protocol import ReportState, WorkerReport
from super_rlm_worker.reports import ReportForwarder


def report() -> WorkerReport:
    return WorkerReport(
        ticket_id="tkt_1",
        assignment_id="asg_1",
        execution_id="exe_1",
        seq=1,
        idempotency_key="asg_1:1",
        state=ReportState.COMPLETED,
        summary="done",
        result="ok",
        artifacts=[],
        timestamp="2026-11-04T00:00:00Z",
    )


class Capture(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    received = None

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        body = self.rfile.read(length).decode("utf-8")
        type(self).received = {"headers": dict(self.headers), "body": body, "path": self.path}
        data = json.dumps({"accepted": True}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.mark.asyncio
async def test_report_forwarder_signs_the_raw_body():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Capture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        forwarder = ReportForwarder(f"http://127.0.0.1:{port}", "worker-token", "callback-key")
        ack = await forwarder.forward(report())
        assert ack.accepted is True
        received = Capture.received
        assert received["path"] == "/internal/v1/reports"
        assert received["headers"]["authorization"] == "Bearer worker-token"
        timestamp = received["headers"]["x-superrlm-timestamp"]
        nonce = received["headers"]["x-superrlm-nonce"]
        expected = hmac.new(
            b"callback-key",
            (timestamp + nonce + received["body"]).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        assert received["headers"]["x-superrlm-signature"] == expected
        assert json.loads(received["body"])["state"] == "completed"
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.asyncio
async def test_report_forwarder_omits_hmac_when_no_key_is_configured():
    Capture.received = None
    server = ThreadingHTTPServer(("127.0.0.1", 0), Capture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        forwarder = ReportForwarder(f"http://127.0.0.1:{server.server_address[1]}", "worker-token", "")
        await forwarder.forward(report())
        assert "x-superrlm-signature" not in Capture.received["headers"]
    finally:
        server.shutdown()
        server.server_close()
