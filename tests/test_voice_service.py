#!/usr/bin/env python3
"""Checks for the Discord voice bridge.

The real Discord voice connection needs a token, ffmpeg and the voice stack, so
this suite covers the parts that can be tested deterministically:

* Kizzey's HTTP proxy to the voice service (auth, JSON, raw downloads, errors),
* the voice service's filename/index/ffmpeg-command helpers.

The companion module is imported with no Discord packages installed; it is
designed to degrade to pure helpers in that case.
"""
import importlib.util
import inspect
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = Path(tempfile.mkdtemp(prefix="kizzey-voice-test-"))
sys.path.insert(0, str(ROOT))

import server  # noqa: E402

checks = []


def check(condition, label, extra=""):
    checks.append(bool(condition))
    if condition:
        print(f"ok: {label}")
    else:
        print(f"FAIL: {label}" + (f" — {extra}" if extra else ""))


# ---------------------------------------------------------------------------
# fake voice service
# ---------------------------------------------------------------------------
class FakeVoice:
    def __init__(self):
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                return

            def _record(self, body=None):
                outer.requests.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "auth": self.headers.get("Authorization"),
                        "body": body,
                    }
                )

            def _json(self, payload, status=200):
                raw = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                self._record()
                if self.path == "/health":
                    return self._json({"ok": True, "service": "kizzey-voice", "ready": True, "ffmpeg": True})
                if self.path == "/state":
                    return self._json({"ok": True, "state": {"ready": True, "connected": False}})
                if self.path == "/recordings":
                    return self._json({"ok": True, "recordings": [{"id": "abc", "name": "a.ogg", "size": 3}]})
                if self.path == "/recordings/abc":
                    raw = b"OggS"
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/ogg")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    return
                return self._json({"ok": False, "error": "missing"}, 404)

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length).decode() or "{}") if length else {}
                self._record(body)
                if self.path == "/join":
                    return self._json({"ok": True, "state": {"connected": True, "channelName": "Lounge"}})
                if self.path == "/record/stop":
                    return self._json({"ok": True, "state": {"recording": {"active": False}}})
                if self.path == "/record/start":
                    return self._json({"ok": True, "state": {"recording": {"active": True}}})
                if self.path == "/play":
                    return self._json({"ok": True, "queued": False, "state": {"playing": True}})
                if self.path == "/boom":
                    return self._json({"ok": False, "error": "No channel here."}, 400)
                return self._json({"ok": True, "state": {}})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


fake = FakeVoice()
server.VOICE_SERVICE_URL = fake.url
server.VOICE_SERVICE_TOKEN = "test-secret"
server.VOICE_SERVICE_TIMEOUT = 5

# -- proxy: health/state ----------------------------------------------------
state = server.voice_service_state()
check(state["reachable"] is True, "state marks a reachable voice service")
check(state["ready"] is True, "state carries the service ready flag")
check(state["state"]["connected"] is False, "state carries the live voice state")
check(len(state["recordings"]) == 1, "state carries the recordings list")
check(any(r["path"] == "/health" for r in fake.requests), "state probes /health")
check(all(r["auth"] == "Bearer test-secret" for r in fake.requests), "proxy sends the service bearer token")

# -- proxy: POST ------------------------------------------------------------
result = server.voice_service_post("/join", {"guildId": "1", "channelId": "2"})
check(result["state"]["connected"] is True, "POST /join returns the service state")
join = [r for r in fake.requests if r["path"] == "/join"][-1]
check(join["method"] == "POST", "proxy uses POST for commands")
check(join["body"] == {"guildId": "1", "channelId": "2"}, "proxy forwards the JSON body")
check(join["auth"].startswith("Bearer "), "proxy sends the service bearer token")
check("test-secret" not in json.dumps(join["body"]), "proxy keeps the token out of the body")

# -- join payload: the saved RPC token is injected server-side --------------
class FakeStore:
    def __init__(self, token):
        self._token = token

    def active_token(self):
        return self._token


original_store = server.STORE
server.STORE = FakeStore("acct-token")
payload = server.voice_join_payload({"guildId": "g", "channelId": "c", "token": "browser-token"})
check(payload["token"] == "acct-token", "join uses the saved RPC token")
check("browser-token" not in payload.values(), "join ignores a browser-supplied token")
check(payload["guildId"] == "g" and payload["channelId"] == "c", "join keeps the channel ids")
server.STORE = FakeStore("")
check("token" not in server.voice_join_payload({"channelId": "c"}), "join omits the token before sign-in")
server.STORE = None
check("token" not in server.voice_join_payload({"channelId": "c"}), "join works without a store")
server.STORE = original_store

# -- proxy: raw download ----------------------------------------------------
body, content_type = server.voice_service_call("/recordings/abc", raw=True)
check(body == b"OggS", "raw proxy returns the recording bytes")
check("audio/ogg" in content_type, "raw proxy keeps the audio content type")

# -- proxy: errors ----------------------------------------------------------
try:
    server.voice_service_post("/boom", {"x": 1})
    check(False, "service errors are surfaced")
except ValueError as exc:
    check("No channel here." in str(exc), "service errors are surfaced", str(exc))

# -- proxy: unreachable -----------------------------------------------------
probe = socket.socket()
probe.bind(("127.0.0.1", 0))
closed_port = probe.getsockname()[1]
probe.close()
server.VOICE_SERVICE_URL = f"http://127.0.0.1:{closed_port}"
try:
    server.voice_service_call("/health", timeout=2)
    check(False, "unreachable service raises")
except ValueError as exc:
    check("not reachable" in str(exc), "unreachable service raises a friendly error", str(exc))

fake.stop()
server.VOICE_SERVICE_URL = "http://127.0.0.1:8421"
server.VOICE_SERVICE_TOKEN = ""

# ---------------------------------------------------------------------------
# voice service helpers (imported without the Discord stack)
# ---------------------------------------------------------------------------
spec = importlib.util.spec_from_file_location("kizzey_voice_service", ROOT / "voice_service" / "voice_service.py")
os.environ.pop("VOICE_USER_TOKEN", None)
voice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(voice)

check(voice.sanitize_label("  Alice / Admin  ") == "Alice_Admin", "labels are filename safe")
check(voice.sanitize_label("") == "user", "empty labels fall back")
check(voice.clamp_bitrate(1) == 8, "bitrate floor")
check(voice.clamp_bitrate(999) == 256, "bitrate ceiling")
check(voice.clamp_bitrate("32") == 32, "bitrate parses strings")
try:
    voice.safe_recording_id("../secret")
    check(False, "recording ids reject traversal")
except ValueError:
    check(True, "recording ids reject traversal")
try:
    voice.safe_recording_id("..")
    check(False, "recording ids reject dot-dot")
except ValueError:
    check(True, "recording ids reject dot-dot")
check(voice.safe_recording_id("abc-123.ogg") == "abc-123.ogg", "recording ids accept normal names")

# -- account-token auth -----------------------------------------------------
check(
    voice.user_auth_headers({"Authorization": "Bot abc.def"})["Authorization"] == "abc.def",
    "account tokens drop the Bot prefix",
)
check(
    voice.user_auth_headers({"authorization": "Bot abc.def"})["authorization"] == "abc.def",
    "the prefix is dropped regardless of header case",
)
check(
    voice.user_auth_headers({"Authorization": "abc.def"})["Authorization"] == "abc.def",
    "bare tokens are left alone",
)
check(
    voice.user_auth_headers({"User-Agent": "x"}) == {"User-Agent": "x"},
    "headers without auth are unchanged",
)
check(voice.user_auth_headers(None) is None, "missing headers pass through")
check(voice.clean_token("  Bearer abc.def  ") == "abc.def", "a pasted Bearer prefix is removed")
check(voice.clean_token("Bot abc.def") == "abc.def", "a pasted Bot prefix is removed")
check(voice.clean_token("abc.def") == "abc.def", "plain tokens are unchanged")
check(voice.VOICE_USER_TOKEN is True, "account tokens are the default token kind")
voice.set_user_token_mode(True)
check(voice._USER_TOKEN_ACTIVE is True, "user-token mode can be enabled")
voice.set_user_token_mode(False)
check(voice._USER_TOKEN_ACTIVE is False, "bot-token mode can be enabled")
check(
    inspect.signature(voice.VoiceManager.join).parameters["user_token"].default is True,
    "join treats Kizzey tokens as account tokens by default",
)

# -- aiohttp hook -----------------------------------------------------------
import types

original_aiohttp = sys.modules.get("aiohttp")
original_patched = voice._USER_TOKEN_PATCHED
fake_aiohttp = types.ModuleType("aiohttp")


class FakeSession:
    def request(self, method, url, **kwargs):
        return kwargs.get("headers")


fake_aiohttp.ClientSession = FakeSession
sys.modules["aiohttp"] = fake_aiohttp
try:
    voice._USER_TOKEN_PATCHED = False
    voice.set_user_token_mode(True)
    sent = FakeSession().request("GET", "/x", headers={"Authorization": "Bot abc"})
    check(sent["Authorization"] == "abc", "the aiohttp hook sends account tokens bare")
    voice.set_user_token_mode(False)
    sent = FakeSession().request("GET", "/x", headers={"Authorization": "Bot abc"})
    check(sent["Authorization"] == "Bot abc", "bot mode keeps the Bot prefix")
finally:
    voice._USER_TOKEN_PATCHED = original_patched
    voice.set_user_token_mode(False)
    if original_aiohttp is not None:
        sys.modules["aiohttp"] = original_aiohttp
    else:
        sys.modules.pop("aiohttp", None)

url, title = voice.resolve_source("https://example.com/song.mp3")
check(url == "https://example.com/song.mp3", "direct audio URLs pass through")
check(title == url, "direct URLs use themselves as the title")

local = WORK / "clip.ogg"
local.write_bytes(b"x")
url, title = voice.resolve_source(str(local))
check(url == str(local), "local files pass through")
check(title == "clip.ogg", "local files use their basename as the title")

recorder = voice.build_recorder_command("ffmpeg", "/tmp/out.ogg", 32)
check(recorder[0] == "ffmpeg", "recorder uses ffmpeg")
check("libopus" in recorder, "recorder encodes Opus")
check("32k" in recorder, "recorder applies the requested bitrate")
check("s16le" in recorder, "recorder reads Discord PCM")
check("pipe:0" in recorder, "recorder reads from stdin")

mix = voice.build_mix_command("ffmpeg", ["a.ogg", "b.ogg"], "/tmp/mix.ogg", 24)
check("amix=inputs=2" in " ".join(mix), "mixer combines every speaker")
check("24k" in mix, "mixer honours the bitrate")

compress = voice.build_compress_command("ffmpeg", "in.ogg", "out.ogg", 16)
check("16k" in compress, "compressor honours the bitrate")
check("out.ogg" == compress[-1], "compressor writes the requested file")

# -- recording index --------------------------------------------------------
library = WORK / "recordings"
library.mkdir()
entry = voice.add_index(
    {"name": "call.ogg", "kind": "mix", "user": "mix", "bytes": 12},
    library,
)
check(bool(entry["id"]), "index assigns an id")
check(voice.find_index(entry["id"], library)["name"] == "call.ogg", "index finds a recording by id")
check(len(voice.load_index(library)) == 1, "index persists")

resolved = voice.resolve_recording_path({"name": "call.ogg"}, library)
check(resolved == (library / "call.ogg").resolve(), "recording paths resolve inside the library")
check(voice.resolve_recording_path({"name": "../call.ogg"}, library) is None, "recording paths reject traversal")
check(voice.resolve_recording_path({"name": "/etc/passwd"}, library) is None, "recording paths reject absolute paths")

deleted = voice.delete_index(entry["id"], library)
check(deleted["id"] == entry["id"], "index deletes a recording")
check(voice.load_index(library) == [], "index is empty after delete")

# -- receive backend adapter -------------------------------------------------
class FakeVoice:
    def __init__(self):
        self.calls = []

    def start_recording(self, sink, callback=None):
        self.calls.append(("start_recording", sink))

    def stop_recording(self):
        self.calls.append(("stop_recording",))

    def is_recording(self):
        return True

    def listen(self, sink):
        self.calls.append(("listen", sink))

    def stop_listening(self):
        self.calls.append(("stop_listening",))

    def is_listening(self):
        return True


adapter = voice.VoiceManager(recordings=WORK / "adapter-recordings")
original_backend = voice.VOICE_BACKEND
try:
    voice.VOICE_BACKEND = "pycord"
    fake = FakeVoice()
    adapter._listen(fake, "sink")
    adapter._stop_listening(fake)
    check(adapter._is_listening(fake) is True, "py-cord adapter reports listening")
    check(
        [call[0] for call in fake.calls] == ["start_recording", "stop_recording"],
        "py-cord adapter uses start_recording/stop_recording",
        str(fake.calls),
    )
    voice.VOICE_BACKEND = "voice_recv"
    fake = FakeVoice()
    adapter._listen(fake, "sink")
    adapter._stop_listening(fake)
    check(
        [call[0] for call in fake.calls] == ["listen", "stop_listening"],
        "voice-recv adapter uses listen/stop_listening",
        str(fake.calls),
    )
finally:
    voice.VOICE_BACKEND = original_backend
    adapter.loop.close()

check(original_backend is None, "no receive backend is present in the test import")

# -- service HTTP layer -----------------------------------------------------
service = voice.VoiceManager(recordings=WORK / "svc-recordings")
service_httpd = voice.build_server(service, "127.0.0.1", 0, "svc-secret")
service_thread = threading.Thread(target=service_httpd.serve_forever, daemon=True)
service_thread.start()
service_url = f"http://127.0.0.1:{service_httpd.server_address[1]}"
try:
    with urllib.request.urlopen(service_url + "/health", timeout=5) as response:
        health = json.loads(response.read().decode())
    check(health.get("ok") is True, "service health needs no token")
    try:
        urllib.request.urlopen(service_url + "/state", timeout=5)
        check(False, "service state requires the token")
    except urllib.error.HTTPError as exc:
        check(exc.code == 401, "service state requires the token", str(exc.code))
    authed = urllib.request.Request(service_url + "/state", headers={"Authorization": "Bearer svc-secret"})
    with urllib.request.urlopen(authed, timeout=5) as response:
        state_body = json.loads(response.read().decode())
    check(state_body.get("ok") is True, "service state accepts the token")
    check(state_body.get("state", {}).get("connected") is False, "service reports a disconnected state")
finally:
    service_httpd.shutdown()
    service_httpd.server_close()
    service.loop.close()

# -- import degradation -----------------------------------------------------
check(voice.OpusRecorder is None, "voice receive degrades when the Discord stack is absent")

shutil.rmtree(WORK, ignore_errors=True)

passed = sum(1 for item in checks if item)
print(f"\n{passed}/{len(checks)} voice checks passed")
sys.exit(0 if passed == len(checks) else 1)