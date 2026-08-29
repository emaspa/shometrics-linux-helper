from http.server import BaseHTTPRequestHandler, HTTPServer
import sys
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode(errors="replace")
        print(body, flush=True)
        self.send_response(204); self.end_headers()
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", 8766), H).serve_forever()
