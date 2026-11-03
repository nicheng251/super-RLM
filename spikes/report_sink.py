
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
LOG=None
class H(BaseHTTPRequestHandler):
    protocol_version="HTTP/1.1"
    def log_message(self,*a): pass
    def do_POST(self):
        n=int(self.headers.get("content-length",0) or 0); raw=self.rfile.read(n)
        try: body=json.loads(raw)
        except Exception: body={"raw":raw.decode("utf-8","replace")}
        with open(LOG,"a",encoding="utf-8") as f: f.write(json.dumps({"path":self.path,"body":body,"auth":self.headers.get("authorization")})+"\n")
        data=json.dumps({"accepted":True,"report_id":"rep_1"}).encode()
        self.send_response(200); self.send_header("content-type","application/json"); self.send_header("content-length",str(len(data))); self.end_headers(); self.wfile.write(data)
def main():
    global LOG
    LOG=sys.argv[2]
    ThreadingHTTPServer(("127.0.0.1",int(sys.argv[1])),H).serve_forever()
if __name__=="__main__": main()
