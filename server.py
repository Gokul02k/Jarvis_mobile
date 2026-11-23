#!/usr/bin/env python3
"""
Jarvis phone server.

Serves the Jarvis web app (./web) and proxies AI requests so your API keys can
stay on this computer instead of your phone:

  /api/gemini/...      -> https://generativelanguage.googleapis.com/...
  /api/xai/...         -> https://api.x.ai/...
  /api/openjarvis/...  -> $OPENJARVIS_URL/...   (e.g. `jarvis serve --port 8000`)
  /api/config          -> which backends are configured (no secrets)

Usage:
  python3 server.py                 # http://0.0.0.0:8080
  python3 server.py --https         # self-signed HTTPS (needed for the mic on a phone over Wi-Fi)
  python3 server.py --port 9000

Keys are read from environment variables or a .env file next to this script:
  GEMINI_API_KEY, XAI_API_KEY, OPENJARVIS_URL, OPENJARVIS_API_KEY, JARVIS_TOKEN
"""
import argparse
import hmac
import ipaddress
import json
import os
import socket
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
CERTS = ROOT / "certs"


def load_env():
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()


def cfg(name):
    return os.environ.get(name, "").strip()


def routes():
    oj = cfg("OPENJARVIS_URL").rstrip("/")
    r = {
        "/api/gemini/": ("https://generativelanguage.googleapis.com/", "gemini"),
        "/api/xai/": ("https://api.x.ai/", "xai"),
    }
    if oj:
        r["/api/openjarvis/"] = (oj + "/", "openjarvis")
    return r


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s %s\n" % (self.command, self.path.split("?")[0]))

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ---- helpers -----------------------------------------------------------
    def send_json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        token = cfg("JARVIS_TOKEN")
        if not token:
            return True
        given = self.headers.get("X-Jarvis-Token", "")
        return hmac.compare_digest(given.encode(), token.encode())

    # ---- verbs -------------------------------------------------------------
    def do_GET(self):
        if self.path.startswith("/api/"):
            return self.handle_api("GET")
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self.handle_api("POST")
        self.send_error(405)

    def handle_api(self, method):
        if self.path.split("?")[0] == "/api/config":
            return self.send_json(200, {
                "server": True,
                "gemini": bool(cfg("GEMINI_API_KEY")),
                "xai": bool(cfg("XAI_API_KEY")),
                "openjarvis": bool(cfg("OPENJARVIS_URL")),
                "tokenRequired": bool(cfg("JARVIS_TOKEN")),
            })
        if not self.authorized():
            return self.send_json(401, {"error": {"message": "Bad or missing Jarvis server token (set it in Jarvis settings)."}})

        for prefix, (base, kind) in routes().items():
            if self.path.startswith(prefix):
                return self.proxy(method, base + self.path[len(prefix):], kind)
        return self.send_json(404, {"error": {"message": "Unknown API route or backend not configured on server."}})

    def proxy(self, method, url, kind):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {"Content-Type": self.headers.get("Content-Type", "application/json")}

        if kind == "gemini":
            key = self.headers.get("x-goog-api-key") or cfg("GEMINI_API_KEY")
            if key:
                headers["x-goog-api-key"] = key
        elif kind == "xai":
            auth = self.headers.get("Authorization") or (
                "Bearer " + cfg("XAI_API_KEY") if cfg("XAI_API_KEY") else "")
            if auth:
                headers["Authorization"] = auth
        elif kind == "openjarvis":
            if cfg("OPENJARVIS_API_KEY"):
                headers["Authorization"] = "Bearer " + cfg("OPENJARVIS_API_KEY")

        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                status, data = resp.status, resp.read()
                ctype = resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            status, data = e.code, e.read()
            ctype = e.headers.get("Content-Type", "application/json")
        except Exception as e:  # network error, timeout, ...
            return self.send_json(502, {"error": {"message": f"Upstream error: {e}"}})

        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip):
    CERTS.mkdir(exist_ok=True)
    cert, key = CERTS / "cert.pem", CERTS / "key.pem"
    if cert.exists() and key.exists():
        return cert, key
    try:
        ipaddress.ip_address(ip)
        san = f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}"
    except ValueError:
        san = "subjectAltName=DNS:localhost,IP:127.0.0.1"
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
        "-keyout", str(key), "-out", str(cert), "-subj", "/CN=jarvis.local", "-addext", san,
    ], check=True, capture_output=True)
    return cert, key


def main():
    ap = argparse.ArgumentParser(description="Jarvis phone server")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--https", action="store_true", help="serve with a self-signed certificate")
    args = ap.parse_args()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    scheme = "http"
    ip = lan_ip()
    if args.https:
        cert, key = ensure_cert(ip)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"

    print("\n  J.A.R.V.I.S. server running")
    print(f"  Computer : {scheme}://localhost:{args.port}")
    print(f"  Phone    : {scheme}://{ip}:{args.port}   (same Wi-Fi)")
    print("  Backends : " + ", ".join(
        f"{n}={'yes' if cfg(k) else 'no'}" for n, k in
        [("gemini", "GEMINI_API_KEY"), ("grok", "XAI_API_KEY"), ("openjarvis", "OPENJARVIS_URL")]))
    if cfg("JARVIS_TOKEN"):
        print("  Token    : required (enter JARVIS_TOKEN in the app's settings)")
    elif args.host == "0.0.0.0" and (cfg("GEMINI_API_KEY") or cfg("XAI_API_KEY")):
        print("  Warning  : anyone on your network can use your API keys. Set JARVIS_TOKEN in .env.")
    if not args.https:
        print("  Note     : phones only allow the microphone on HTTPS. Use --https for Wi-Fi access.")
    print()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
