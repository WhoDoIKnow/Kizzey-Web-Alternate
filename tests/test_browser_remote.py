#!/usr/bin/env python3
"""Checks for browser sign-in without a local Chromium.

The remote path talks to a DevTools endpoint: HTTP for /json/version and
/json/list, WebSocket for Runtime.evaluate. A tiny fake endpoint is started on
localhost so the whole flow runs without Chrome, Docker or Discord.
"""
import base64
import hashlib
import json
import os
import shutil
import socket
import struct
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

TMP = Path(tempfile.mkdtemp(prefix="kizzey-browser-remote-"))
for sub in ("data", "uploads", "tmp"):
    (TMP / sub).mkdir(parents=True, exist_ok=True)

import server  # noqa: E402

server.DATA_DIR = TMP / "data"
server.UPLOAD_DIR = TMP / "uploads"
server.TMP_DIR = TMP / "tmp"
server.STATE_FILE = TMP / "data" / "state.json"
server.SECRET_FILE = TMP / "data" / "secret.json"
server.CHAT_FILE = TMP / "data" / "chat.json"
server.HISTORY_FILE = TMP / "data" / "history.json"
server.LOG_FILE = TMP / "data" / "kizzey.log"

checks = []


def check(condition, label, extra=""):
    checks.append(bool(condition))
    if condition:
        print(f"ok: {label}")
    else:
        print(f"FAIL: {label}" + (f" — {extra}" if extra else ""))


def clean_env():
    for key in ("KIZZEY_BROWSER", "KIZZEY_BROWSER_CDP", "KIZZEY_BROWSER_CDP_TOKEN"):
        os.environ.pop(key, None)


# --- endpoint parsing -----------------------------------------------------
clean_env()
check(server._remote_cdp() == ("", ""), "no endpoint configured means local browser")

os.environ["KIZZEY_BROWSER_CDP"] = "http://192.168.1.10:9222"
check(
    server._remote_cdp() == ("http://192.168.1.10:9222", ""),
    "an http DevTools address is used as-is",
)

os.environ["KIZZEY_BROWSER_CDP"] = "ws://browser:3000?token=secret"
origin, query = server._remote_cdp()
check(origin == "http://browser:3000" and query == "token=secret", "a ws url keeps its token query", f"{origin} {query}")

os.environ["KIZZEY_BROWSER_CDP"] = "wss://browser.example.com"
check(server._remote_cdp()[0] == "https://browser.example.com", "a wss url becomes an https endpoint")

os.environ["KIZZEY_BROWSER_CDP"] = "https://browser.example.com/path?token=x"
check(
    server._remote_cdp() == ("https://browser.example.com", "token=x"),
    "a path is dropped and the query is kept",
)

os.environ["KIZZEY_BROWSER_CDP"] = "192.168.1.10:9222"
check(server._remote_cdp()[0] == "http://192.168.1.10:9222", "a bare host defaults to http")

clean_env()
os.environ["KIZZEY_BROWSER"] = "ws://host:3000"
check(server._remote_cdp() == ("http://host:3000", ""), "KIZZEY_BROWSER may hold a DevTools url")

clean_env()
os.environ["KIZZEY_BROWSER"] = "/usr/bin/google-chrome"
check(server._remote_cdp() == ("", ""), "an executable in KIZZEY_BROWSER stays local")

os.environ["KIZZEY_BROWSER_CDP"] = "ftp://host:21"
try:
    server._remote_cdp()
    invalid_raised = False
except server.DiscordError as exc:
    invalid_raised = "KIZZEY_BROWSER_CDP" in exc.message
check(invalid_raised, "an unsupported scheme is rejected with a clear error")

# --- endpoint description -------------------------------------------------
clean_env()
original_find = server._find_browser
server._find_browser = lambda: ""
check(server.browser_endpoint_info() == {"mode": "none"}, "no browser and no endpoint reports none")

os.environ["KIZZEY_BROWSER_CDP"] = "http://127.0.0.1:9"
info = server.browser_endpoint_info()
check(info["mode"] == "remote" and info["address"] == "http://127.0.0.1:9", "a configured endpoint reports remote")
check(info["reachable"] is False, "an unreachable endpoint is reported as such")

os.environ["KIZZEY_BROWSER_CDP"] = "ftp://nope"
check(server.browser_endpoint_info()["mode"] == "invalid", "an invalid endpoint is reported as invalid")

server._find_browser = lambda: "/usr/bin/google-chrome"
clean_env()
info = server.browser_endpoint_info()
check(info["mode"] == "local" and info["browser"] == "google-chrome", "a local browser is reported by name")

server._find_browser = lambda: ""
try:
    server.browser_login(timeout=1)
    missing_raised = False
except server.DiscordError as exc:
    missing_raised = "KIZZEY_BROWSER_CDP" in exc.message and "password" in exc.message
check(missing_raised, "the no-browser error names both alternatives")
server._find_browser = original_find

# --- fake DevTools endpoint ----------------------------------------------
TOKEN = "A" * 24 + "." + "B" * 8
WS_STOP = threading.Event()


def ws_read_exact(conn, count):
    data = b""
    while len(data) < count:
        chunk = conn.recv(count - len(data))
        if not chunk:
            raise OSError("closed")
        data += chunk
    return data


def ws_read_frame(conn):
    head = ws_read_exact(conn, 2)
    opcode = head[0] & 0x0F
    masked = bool(head[1] & 0x80)
    length = head[1] & 0x7F
    if length == 126:
        length = struct.unpack(">H", ws_read_exact(conn, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", ws_read_exact(conn, 8))[0]
    mask = ws_read_exact(conn, 4) if masked else b""
    payload = ws_read_exact(conn, length) if length else b""
    if masked:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return opcode, payload


def ws_send_text(conn, text):
    payload = text.encode()
    header = bytearray([0x81])
    if len(payload) < 126:
        header.append(len(payload))
    elif len(payload) < 65536:
        header.append(126)
        header.extend(struct.pack(">H", len(payload)))
    else:
        header.append(127)
        header.extend(struct.pack(">Q", len(payload)))
    conn.sendall(bytes(header) + payload)


def serve_page_socket(sock):
    sock.settimeout(15)
    while not WS_STOP.is_set():
        try:
            conn, _ = sock.accept()
        except socket.timeout:
            continue
        except OSError:
            return
        try:
            request = b""
            while b"\r\n\r\n" not in request:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                request += chunk
            headers = {}
            for line in request.decode("latin-1").split("\r\n")[1:]:
                if ":" in line:
                    name, value = line.split(":", 1)
                    headers[name.strip().lower()] = value.strip()
            key = headers.get("sec-websocket-key", "")
            accept = base64.b64encode(
                hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
            ).decode()
            conn.sendall(
                (
                    "HTTP/1.1 101 Switching Protocols\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
                ).encode()
            )
            opcode, payload = ws_read_frame(conn)
            if opcode == 0x8:
                continue
            message = json.loads(payload.decode("utf-8"))
            if message.get("method") != "Runtime.evaluate":
                continue
            ws_send_text(
                conn,
                json.dumps(
                    {
                        "id": message.get("id"),
                        "result": {"result": {"type": "string", "value": TOKEN}},
                    }
                ),
            )
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass


page_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
page_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
page_sock.bind(("127.0.0.1", 0))
page_sock.listen(4)
PAGE_PORT = page_sock.getsockname()[1]
threading.Thread(target=serve_page_socket, args=(page_sock,), daemon=True).start()


class FakeDevTools(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/json/version":
            body = {"Browser": "FakeChrome/1.0", "webSocketDebuggerUrl": f"ws://localhost:{self.server.server_port}/devtools/browser/fake"}
        elif path == "/json/list":
            body = [
                {
                    "id": "page-1",
                    "type": "page",
                    "url": "https://discord.com/channels/@me",
                    "webSocketDebuggerUrl": f"ws://127.0.0.1:{PAGE_PORT}/devtools/page/page-1",
                }
            ]
        else:
            self.send_response(404)
            self.end_headers()
            return
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args):
        pass


httpd = ThreadingHTTPServer(("127.0.0.1", 0), FakeDevTools)
HTTP_PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

origin = f"http://127.0.0.1:{HTTP_PORT}"
os.environ["KIZZEY_BROWSER_CDP"] = origin

check(server._cdp_ready_at(origin, ""), "the fake endpoint reports ready")
targets = server._cdp_targets_at(origin, "")
check(len(targets) == 1 and targets[0]["id"] == "page-1", "the fake browser lists its Discord tab")

browser_ws = server._cdp_browser_ws(origin, "")
check(
    browser_ws == f"ws://127.0.0.1:{HTTP_PORT}/devtools/browser/fake",
    "a ws://localhost address is rewritten to the configured host",
    browser_ws,
)

started = time.time()
result = server.browser_login(timeout=30)
check(result.get("status") == "ok" and result.get("token") == TOKEN, "remote sign-in reads the Discord token", json.dumps(result)[:120])
check(time.time() - started < 12, "remote sign-in does not wait for the full timeout", f"{time.time() - started:.1f}s")

# The HTTP layer also sees the token query from a browserless-style endpoint.
os.environ["KIZZEY_BROWSER_CDP"] = origin + "?token=abc"
check(server.browser_endpoint_info()["mode"] == "remote", "a token query is ignored when describing the endpoint")

WS_STOP.set()
page_sock.close()
httpd.shutdown()
httpd.server_close()
clean_env()

shutil.rmtree(TMP, ignore_errors=True)
passed = sum(1 for ok in checks if ok)
print(f"{passed}/{len(checks)} remote browser checks passed")
sys.exit(0 if passed == len(checks) else 1)
