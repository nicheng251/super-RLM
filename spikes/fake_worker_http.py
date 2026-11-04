
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
COUNT=0
class H(BaseHTTPRequestHandler):
    protocol_version="HTTP/1.1"
    def log_message(self,*a): pass
    def do_POST(self):
        n=int(self.headers.get("content-length",0) or 0); body=self.rfile.read(n)
        global COUNT
        if self.path == "/v1/executions":
            COUNT+=1
            data=json.dumps({"execution_id":f"exe_fake_{COUNT}","status":"accepted"}).encode()
            self.send_response(202); self.send_header("content-type","application/json"); self.send_header("content-length",str(len(data))); self.end_headers(); self.wfile.write(data); return
        data=json.dumps({"status":"cancelled"}).encode()
        self.send_response(200); self.send_header("content-type","application/json"); self.send_header("content-length",str(len(data))); self.end_headers(); self.wfile.write(data)
if __name__=="__main__":
    ThreadingHTTPServer(("127.0.0.1",int(sys.argv[1])),H).serve_forever()
