#!/usr/bin/env python3
"""
Kizzey Web
==========
A self-contained Python web companion for the Kizzey Discord Rich Presence client.

The UI mirrors the Android app's dark Material 3 design. The server owns the Discord
token, maintains the gateway connection, stores presets/settings, and exposes a small
JSON API plus an SSE event stream to the browser.

Run:
    python3 server.py --host 0.0.0.0 --port 8420

Only the Python standard library is required.  OCR (optional) uses the `tesseract`
command if it is installed.
"""

from __future__ import annotations

import argparse
import base64
import collections
import datetime as dt
import hashlib
import json
import mimetypes
import os
import platform
import queue
import random
import re
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DATA_DIR = APP_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
TMP_DIR = DATA_DIR / "tmp"
STATE_FILE = DATA_DIR / "state.json"
SECRET_FILE = DATA_DIR / "secret.json"
CHAT_FILE = DATA_DIR / "chat.json"
HISTORY_FILE = DATA_DIR / "history.json"
LOG_FILE = DATA_DIR / "kizzey.log"

for directory in (DATA_DIR, UPLOAD_DIR, TMP_DIR):
    directory.mkdir(parents=True, exist_ok=True)

VERSION = "8.4.4"
DEFAULT_PORT = 8420
DEFAULT_APP_ID = "962990036020756480"
DISCORD_API = "https://discord.com/api/v10"
DISCORD_UA = "Discord-Android/267206;RNA"
KIZZY_IMAGE_API = "https://kizzy-api.cjjdxhdjd.workers.dev"
KIZZEY_RELEASES_API = "https://codeberg.org/api/v1/repos/UnpackedX/Kizzey/releases/latest"
KIZZEY_REPO = "https://codeberg.org/UnpackedX/Kizzey"

MAX_BODY = 32 * 1024 * 1024
MAX_CHAT = 250
SERVER_STARTED = time.monotonic()

MIME_OVERRIDES = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".webmanifest": "application/manifest+json; charset=utf-8",
}

PRESENCE_KINDS = {
    "custom": "Custom RPC",
    "apps": "App Detection",
    "media": "Media RPC",
    "console": "Console RPC",
    "experimental": "Experimental RPC",
    "multiple": "Multiple RPC",
    "cycling": "RPC Cycling",
    "samsung": "Samsung RPC",
    "emulation": "Emulation RPC",
    "health": "Health RPC",
    "location": "Location RPC",
    "weather": "Weather RPC",
    "navigation": "Navigation",
    "android_auto": "Android Auto",
    "screen_read": "Screen Read",
}


def now_ms() -> int:
    return int(time.time() * 1000)


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def mono() -> float:
    return time.monotonic()


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.3)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


def read_device_info() -> dict:
    def prop(name: str) -> str:
        try:
            out = subprocess.run(
                ["getprop", name], capture_output=True, text=True, timeout=2
            ).stdout.strip()
            return out
        except Exception:
            return ""

    manufacturer = prop("ro.product.manufacturer")
    model = prop("ro.product.model")
    device = prop("ro.product.device")
    android = prop("ro.build.version.release")
    sdk = prop("ro.build.version.sdk")
    battery = None
    for path in (
        "/sys/class/power_supply/battery/capacity",
        "/sys/class/power_supply/bms/capacity",
    ):
        try:
            battery = int(Path(path).read_text().strip())
            break
        except Exception:
            pass
    return {
        "platform": sys.platform,
        "python": platform.python_version(),
        "machine": platform.machine(),
        "node": platform.node(),
        "manufacturer": manufacturer or platform.machine(),
        "model": model or platform.node(),
        "device": device,
        "android": android,
        "sdk": sdk,
        "is_samsung": "samsung" in (manufacturer + model).lower(),
        "battery": battery,
    }


HOST_DEVICE = read_device_info()


# ---------------------------------------------------------------------------
# Logging and state
# ---------------------------------------------------------------------------


def _scrub(text: str) -> str:
    text = str(text)
    token = ""
    try:
        if STORE is not None:
            token = STORE.secret.get("token", "")
    except Exception:
        pass
    if token and len(token) > 8:
        text = text.replace(token, "••••••••")
    text = re.sub(r"[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}", "••••••••", text)
    return text


def default_chat() -> dict:
    t = now_ms()
    rooms = [
        {
            "id": "lounge",
            "name": "Lounge",
            "emoji": "🛋️",
            "topic": "Say hello. Share what you're listening to.",
            "members": 12,
        },
        {
            "id": "gaming",
            "name": "Gaming",
            "emoji": "🎮",
            "topic": "Squads, scores and late-night lobbies.",
            "members": 8,
        },
        {
            "id": "presence",
            "name": "Presences",
            "emoji": "✨",
            "topic": "Show off a card. Find something new to run.",
            "members": 6,
        },
        {
            "id": "dev",
            "name": "Dev corner",
            "emoji": "🛠️",
            "topic": "Kizzey Web, plugins and automation.",
            "members": 4,
        },
    ]
    messages = {
        "lounge": [
            {
                "id": "welcome-" + uuid.uuid4().hex[:8],
                "author": "Kizzey",
                "avatar": "",
                "color": "#d0bcff",
                "system": True,
                "text": "Welcome to Kizzey Chat. This room lives on your own server — open the page in another browser on your network and the conversation follows.",
                "time": t - 1000 * 60 * 38,
                "reactions": {},
            },
            {
                "id": "hello-" + uuid.uuid4().hex[:8],
                "author": "mint",
                "avatar": "",
                "color": "#7ee0b8",
                "text": "finally got my custom card looking right. tiny details, clean state line, no clutter.",
                "time": t - 1000 * 60 * 31,
                "reactions": {"✨": ["Kizzey"]},
            },
            {
                "id": "reply-" + uuid.uuid4().hex[:8],
                "author": "luma",
                "avatar": "",
                "color": "#f4b8d1",
                "text": "the update rail on home is such a nice touch. everything feels like one app instead of a pile of settings.",
                "time": t - 1000 * 60 * 26,
                "reactions": {"💜": ["mint"]},
            },
        ],
        "gaming": [
            {
                "id": "gaming-" + uuid.uuid4().hex[:8],
                "author": "koda",
                "avatar": "",
                "color": "#f7c873",
                "text": "who's running an Experimental card tonight? I want to see how the app / media switch feels live.",
                "time": t - 1000 * 60 * 19,
                "reactions": {"🎮": ["mint"]},
            }
        ],
        "presence": [
            {
                "id": "presence-" + uuid.uuid4().hex[:8],
                "author": "Kizzey",
                "avatar": "",
                "color": "#d0bcff",
                "system": True,
                "text": "Tip: press Preview on a Custom RPC to see exactly how the card lands on Discord before you run it.",
                "time": t - 1000 * 60 * 12,
                "reactions": {},
            }
        ],
        "dev": [
            {
                "id": "dev-" + uuid.uuid4().hex[:8],
                "author": "Kizzey",
                "avatar": "",
                "color": "#d0bcff",
                "system": True,
                "text": "Kizzey Web server is running. Settings, presets and chat are stored in data/ next to server.py.",
                "time": t - 1000 * 60 * 4,
                "reactions": {},
            }
        ],
    }
    moments = [
        {
            "id": uuid.uuid4().hex,
            "author": "Kizzey",
            "color": "#d0bcff",
            "text": "8.4.4 is here: presences in chat, live weather, stories, Health RPC and a calmer home. What are you running today?",
            "time": t - 1000 * 60 * 55,
            "likes": ["mint", "luma"],
            "tag": "release",
        },
        {
            "id": uuid.uuid4().hex,
            "author": "mint",
            "color": "#7ee0b8",
            "text": "Late night listening with the album art tinting the whole app. This is the cozy part of the internet.",
            "time": t - 1000 * 60 * 22,
            "likes": ["luma"],
            "tag": "listening",
        },
    ]
    return {
        "rooms": rooms,
        "messages": messages,
        "moments": moments,
        "voice": {"participants": []},
    }


def default_state() -> dict:
    t = now_ms()
    return {
        "version": VERSION,
        "firstRun": True,
        "startedAt": t,
        "startedIso": now_iso(),
        "host": HOST_DEVICE,
        "account": None,
        "gateway": {
            "connected": False,
            "state": "offline",
            "latency": None,
            "error": "",
            "reconnects": 0,
            "since": None,
        },
        "presence": {
            "active": None,
            "startedAt": None,
            "updatedAt": None,
            "activities": [],
        },
        "settings": {
            "theme": "dark",
            "accent": "#d0bcff",
            "amoled": False,
            "dynamicColor": False,
            "highContrast": False,
            "homeLayout": "grid",
            "homeColumns": 2,
            "greeting": "",
            "hiddenHome": [],
            "homeOrder": [
                "updates",
                "live",
                "quick",
                "recent",
                "features",
                "stats",
                "chat",
                "about",
            ],
            "language": "en",
            "reduceMotion": False,
            "autoStart": True,
            "keepAlive": True,
            "notifications": True,
            "notificationSound": False,
            "chatBubble": "",
            "rpcStatus": "online",
            "defaultType": 0,
            "showButtons": True,
            "button1": "Kizzey Web",
            "button1link": "",
            "button2": "",
            "button2link": "",
            "statusDisplay": -1,
            "statusRoll": False,
            "statusRollInterval": 5,
            "statusRollLines": ["name", "state", "details"],
            "closeToTray": True,
            "minimizeOnStart": False,
            "reconnect": True,
            "showActiveCounts": True,
            "analytics": False,
            "artBackground": False,
            "accentFromArt": False,
            "artBackgroundBlur": 24,
            "artBackgroundDim": 40,
            "customThemeCss": "",
            "customThemeName": "",
            "showUpdateRail": True,
            "showPresenceHistory": True,
            "showChatPreview": True,
            "showLiveNow": True,
            "offlineMode": False,
            "fontScale": 1.0,
        },
        "custom": {
            "name": "",
            "details": "",
            "state": "",
            "partyCurrentSize": "",
            "partyMaxSize": "",
            "timestampsStart": "",
            "timestampsStop": "",
            "platform": "android",
            "status": "online",
            "button1": "",
            "button1link": "",
            "button2": "",
            "button2link": "",
            "largeImg": "",
            "largeText": "",
            "smallImg": "",
            "smallText": "",
            "type": "0",
            "url": "",
            "applicationId": "",
            "statusDisplayType": -1,
            "largeUrl": "",
            "smallUrl": "",
        },
        "savedConfigs": [],
        "recent": [],
        "usage": {},
        "apps": {
            "enabled": False,
            "autoDetect": True,
            "selected": None,
            "detectedAt": None,
            "showButtons": False,
        },
        "media": {
            "enabled": False,
            "source": "manual",
            "track": {
                "title": "",
                "artist": "",
                "album": "",
                "art": "",
                "duration": 214,
                "position": 0,
                "playing": False,
            },
            "showProgress": True,
            "hideOnPause": False,
            "hiddenStatus": "online",
            "type": 2,
            "apps": ["Spotify", "YouTube Music", "Apple Music"],
        },
        "console": {
            "enabled": False,
            "device": "PlayStation 5",
            "selected": None,
            "game": "",
        },
        "experimental": {
            "enabled": False,
            "mode": "switch",
            "interval": 15,
            "sources": ["apps", "media"],
            "appIds": [],
            "mediaApps": ["Spotify", "YouTube Music"],
            "type": -1,
            "status": "online",
            "showWhenEmpty": False,
        },
        "cycling": {
            "enabled": False,
            "mode": "cycle",
            "types": [0, 2, 3],
            "interval": 30,
            "streamUrl": "",
        },
        "multiple": {
            "enabled": False,
            "sources": ["custom", "media"],
            "comments": "",
        },
        "health": {
            "enabled": False,
            "steps": 0,
            "goal": 8000,
            "heart": 0,
            "sleep": 0,
            "weight": 0,
            "stress": 0,
            "history": [],
            "show": ["steps", "heart", "sleep", "stress"],
            "label": "Health",
            "alerts": True,
        },
        "location": {
            "enabled": False,
            "useMyLocation": True,
            "place": "London",
            "lat": 51.5072,
            "lon": -0.1276,
            "privacy": True,
            "unit": "c",
            "template": "In {{place}}",
            "showWeather": True,
        },
        "weather": {
            "enabled": False,
            "source": "city",
            "place": "London",
            "lat": 51.5072,
            "lon": -0.1276,
            "unit": "c",
            "template": "{{weather_emoji}} {{weather_temp}} in {{place}}",
            "details": "Feels like {{weather_feels}}",
            "forecast": 3,
        },
        "navigation": {
            "enabled": False,
            "origin": "",
            "destination": "",
            "lat": None,
            "lon": None,
            "destLat": None,
            "destLon": None,
            "distance": None,
            "duration": None,
            "routeName": "",
        },
        "androidAuto": {
            "enabled": False,
            "connected": False,
            "template": "On the road",
            "details": "Android Auto",
            "showButtons": False,
        },
        "samsung": {"enabled": False, "game": ""},
        "emulation": {
            "enabled": False,
            "emulator": "RetroArch",
            "game": "",
            "core": "",
        },
        "screenRead": {
            "enabled": False,
            "preset": "Genshin Impact",
            "fields": {
                "name": "Genshin Impact",
                "details": "{{screen_name}}",
                "state": "{{screen_score}}",
            },
            "rules": {
                "name": r"(?:Player|Adventurer|Name)\s*[:\-]?\s*([A-Za-z0-9_]{2,20})",
                "score": r"(?:Score|AR|Level|Score)\s*[:\-]?\s*([0-9,]+)",
            },
            "lastText": "",
            "lastFields": {},
            "capturedAt": None,
        },
        "bulk": {"channel": "", "query": "", "limit": 100},
        "automation": {
            "rules": [
                {
                    "id": uuid.uuid4().hex[:10],
                    "name": "Evening listening",
                    "time": "20:00",
                    "days": [0, 1, 2, 3, 4],
                    "enabled": False,
                    "action": "media",
                }
            ],
            "enabled": False,
        },
        "quickControls": {
            "style": "modern",
            "showCustom": True,
            "name": "",
            "details": "",
            "state": "",
            "type": "0",
        },
        "plugins": {
            "audiocord": {"enabled": False, "showArt": True, "visualizer": "bars"},
            "callLinks": {"enabled": False, "label": "Join my call", "url": ""},
            "presenceShare": {"enabled": False, "code": ""},
            "apiBridge": {"enabled": False},
        },
        "gallery": {
            "liked": [],
            "submitted": [],
            "filter": "all",
        },
        "appCatalog": [
            {"title": "Visual Studio Code", "package": "com.microsoft.vscode", "icon": "code", "color": "#7db7ff", "details": "Writing code", "state": "In the editor", "platform": "desktop"},
            {"title": "Spotify", "package": "com.spotify.music", "icon": "music", "color": "#73d99f", "details": "Listening to music", "state": "On Spotify", "platform": "android"},
            {"title": "YouTube", "package": "com.google.android.youtube", "icon": "play", "color": "#ff8a91", "details": "Watching videos", "state": "On YouTube", "platform": "android"},
            {"title": "Discord", "package": "com.discord", "icon": "message-circle", "color": "#a7b5ff", "details": "Chatting", "state": "On Discord", "platform": "android"},
            {"title": "Chrome", "package": "com.android.chrome", "icon": "globe", "color": "#f2c66d", "details": "Browsing the web", "state": "In Chrome", "platform": "android"},
            {"title": "Genshin Impact", "package": "com.miHoYo.GenshinImpact", "icon": "sparkles", "color": "#9cd9ff", "details": "Exploring Teyvat", "state": "In game", "platform": "android"},
        ],
        "drawer": {"order": [], "hidden": [], "compact": False},
        "chatProfile": {
            "name": "You",
            "avatar": "",
            "color": "#d0bcff",
            "status": "online",
            "note": "Building a better presence.",
            "badge": "Member",
        },
        "wallet": {
            "kcoin": 250,
            "inventory": ["aurora"],
            "daily": 0,
            "streak": 0,
            "donated": 0,
        },
        "premium": {"tier": "free", "since": None, "demo": False},
        "ui": {"onboarded": False, "dismissedUpdate": False, "welcomeDebug": False},
        "history": [],
        "logs": [],
        "chat": default_chat(),
        "device": HOST_DEVICE,
    }


class Store:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.subscribers: set[queue.Queue] = set()
        self.state: dict = {}
        self.secret: dict = {}
        self.history: list = []
        self.logs: collections.deque = collections.deque(maxlen=400)
        self.load()

    # -- persistence -----------------------------------------------------
    def load(self) -> None:
        self.state = self._read_json(STATE_FILE, default_state())
        self.secret = self._read_json(SECRET_FILE, {"token": "", "tokenSetAt": None})
        self.state["host"] = HOST_DEVICE
        self.state["device"] = HOST_DEVICE
        self.history = self._read_json(HISTORY_FILE, [])
        if not isinstance(self.history, list):
            self.history = []
        self.state["history"] = self.history[-120:][::-1]
        chat = self.state.get("chat")
        if not isinstance(chat, dict) or "rooms" not in chat:
            self.state["chat"] = default_chat()
        for room in self.state["chat"].get("rooms", []):
            if room.get("id") not in self.state["chat"].setdefault("messages", {}):
                self.state["chat"]["messages"][room.get("id")] = []
        # The server always owns these runtime fields.
        self.state.setdefault("presence", {"active": None, "startedAt": None, "activities": []})
        self.state.setdefault("gateway", {"connected": False, "state": "offline"})
        self.state["gateway"]["connected"] = False
        self.state["gateway"]["state"] = "offline"
        self.state["version"] = VERSION
        self.state["logs"] = []
        self.save()

    @staticmethod
    def _read_json(path: Path, fallback):
        try:
            if path.exists():
                with path.open("r", encoding="utf-8") as fh:
                    return json.load(fh)
        except Exception as exc:
            print(f"[state] could not read {path.name}: {exc}", file=sys.stderr)
        return fallback

    @staticmethod
    def _atomic_write(path: Path, data) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, path)

    def save(self) -> None:
        with self.lock:
            self._atomic_write(STATE_FILE, self.state)
            self._atomic_write(SECRET_FILE, self.secret)
            try:
                os.chmod(SECRET_FILE, 0o600)
            except OSError:
                pass
            self._atomic_write(HISTORY_FILE, self.history[-300:])

    # -- events ----------------------------------------------------------
    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=32)
        with self.lock:
            self.subscribers.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self.lock:
            self.subscribers.discard(q)

    def publish(self, event: dict) -> None:
        with self.lock:
            subs = list(self.subscribers)
        for q in subs:
            try:
                q.put_nowait(event)
            except queue.Full:
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except Exception:
                    pass

    def broadcast_state(self) -> None:
        self.publish({"type": "state", "state": public_state()})

    # -- logs ------------------------------------------------------------
    def log(self, level: str, tag: str, message: str) -> None:
        message = _scrub(message)
        entry = {
            "id": uuid.uuid4().hex[:10],
            "time": now_ms(),
            "level": level.upper(),
            "tag": tag,
            "message": message,
        }
        with self.lock:
            self.logs.appendleft(entry)
            self.state["logs"] = list(self.logs)[:200]
        try:
            with LOG_FILE.open("a", encoding="utf-8") as fh:
                stamp = dt.datetime.now().strftime("%H:%M:%S")
                fh.write(f"{stamp} [{entry['level']:<5}] {tag}: {message}\n")
        except Exception:
            pass
        self.publish({"type": "log", "log": entry})
        if level.upper() in ("ERROR", "WARN"):
            print(f"[{entry['level']}] {tag}: {message}", file=sys.stderr)

    # -- helpers ---------------------------------------------------------
    def touch(self, broadcast: bool = True) -> None:
        self.save()
        if broadcast:
            self.broadcast_state()

    def add_history(self, kind: str, label: str, title: str, started_at: int, ended_at: int) -> None:
        if not started_at:
            return
        if ended_at <= started_at:
            return
        if not self.state.get("settings", {}).get("showPresenceHistory", True):
            return
        entry = {
            "id": uuid.uuid4().hex[:10],
            "kind": kind,
            "label": label,
            "title": title,
            "startedAt": started_at,
            "endedAt": ended_at,
            "seconds": max(1, int((ended_at - started_at) / 1000)),
        }
        with self.lock:
            self.history.append(entry)
            self.history = self.history[-300:]
            self.state["history"] = self.history[-120:][::-1]
        self.save()


STORE: Store | None = None


def public_state() -> dict:
    if STORE is None:
        return {}
    with STORE.lock:
        # the token lives only in secret.json and is never handed to the browser
        data = json.loads(json.dumps(STORE.state, ensure_ascii=False))
        data["tokenSet"] = bool(STORE.secret.get("token"))
        data["serverTime"] = now_ms()
        data["version"] = VERSION
        data["gateway"]["tokenSet"] = bool(STORE.secret.get("token"))
        data["host"] = HOST_DEVICE
        data["logs"] = list(STORE.logs)[:120]
        return data



def deep_merge(dst: dict, src: dict, depth: int = 0) -> dict:
    if depth > 8:
        return dst
    for key, value in src.items():
        if value is None and key in dst:
            continue
        if isinstance(value, dict) and isinstance(dst.get(key), dict):
            deep_merge(dst[key], value, depth + 1)
        else:
            dst[key] = value
    return dst


PROTECTED_PATCH_KEYS = {
    "account",
    "gateway",
    "presence",
    "history",
    "logs",
    "version",
    "host",
    "device",
    "startedAt",
    "startedIso",
    "firstRun",
    "chat",
    "tokenSet",
    "tokenHint",
    "serverTime",
}


def visible_patch(obj: dict) -> dict:
    if not isinstance(obj, dict):
        return {}
    return {k: v for k, v in obj.items() if k not in PROTECTED_PATCH_KEYS}


# ---------------------------------------------------------------------------
# HTTP + Discord helpers
# ---------------------------------------------------------------------------


class DiscordError(Exception):
    def __init__(self, status: int, message: str, data=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.data = data or {}


def super_properties() -> str:
    props = {
        "os": "Android",
        "browser": "Discord Android",
        "device": HOST_DEVICE.get("model") or "Android",
        "system_locale": "en-US",
        "client_version": "267.0",
        "release_channel": "googleRelease",
        "os_version": HOST_DEVICE.get("android") or "14",
        "client_build_number": 267206,
    }
    raw = json.dumps(props, separators=(",", ":")).encode()
    return base64.b64encode(raw).decode()


def discord_headers(token: str = "", extra: dict | None = None) -> dict:
    headers = {
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": DISCORD_UA,
        "X-Super-Properties": super_properties(),
        "X-Discord-Locale": "en-US",
        "X-Discord-Timezone": "Europe/London",
    }
    if token:
        headers["Authorization"] = token
    if extra:
        headers.update(extra)
    return headers


def discord_api(path: str, token: str, method: str = "GET", body=None, timeout: float = 20):
    url = DISCORD_API + path
    data = None
    headers = discord_headers(token)
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if not raw:
                return None
            try:
                return json.loads(raw)
            except Exception:
                return raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        info = {}
        try:
            info = json.loads(raw)
        except Exception:
            info = {"message": raw.decode("utf-8", "replace")[:300]}
        message = info.get("message") or f"Discord returned HTTP {exc.code}"
        raise DiscordError(exc.code, message, info) from None
    except urllib.error.URLError as exc:
        raise DiscordError(0, f"Could not reach Discord: {exc.reason}") from None
    except TimeoutError:
        raise DiscordError(0, "Discord took too long to answer.") from None


def validate_token(token: str) -> dict:
    me = discord_api("/users/@me", token)
    if not isinstance(me, dict) or "id" not in me:
        raise DiscordError(401, "Discord did not return an account.")
    return normalize_user(me)


def normalize_user(user: dict) -> dict:
    uid = str(user.get("id", ""))
    avatar_hash = user.get("avatar") or ""
    animated = bool(avatar_hash.startswith("a_"))
    if avatar_hash:
        avatar_url = f"https://cdn.discordapp.com/avatars/{uid}/{avatar_hash}.{'gif' if animated else 'png'}?size=128"
    else:
        try:
            index = (int(uid) >> 22) % 6
        except Exception:
            index = 0
        avatar_url = f"https://cdn.discordapp.com/embed/avatars/{index}.png"
    return {
        "id": uid,
        "username": user.get("username", ""),
        "globalName": user.get("global_name") or "",
        "displayName": user.get("global_name") or user.get("username") or "friend",
        "discriminator": user.get("discriminator", "0"),
        "avatar": avatar_hash,
        "avatarUrl": avatar_url,
        "banner": user.get("banner"),
        "accent": user.get("accent_color"),
        "premium": bool(user.get("premium_type")),
        "verified": bool(user.get("verified")),
        "email": "",  # never pass through to the browser
    }


def normalize_relationship(item: dict) -> dict:
    user = normalize_user(item.get("user") or {})
    return {
        "id": user["id"],
        "user": user,
        "type": item.get("type"),
        "nickname": item.get("nickname") or "",
        "since": item.get("since"),
    }


# ---------------------------------------------------------------------------
# Images, weather, update feed
# ---------------------------------------------------------------------------

IMAGE_CACHE: dict[str, str] = {}
IMAGE_CACHE_LOCK = threading.Lock()


def image_api_get(url: str) -> str | None:
    endpoint = f"{KIZZY_IMAGE_API}/image?url={urllib.parse.quote(url, safe='')}"
    req = urllib.request.Request(
        endpoint,
        headers={
            "User-Agent": "Kizzey-Web/1.0 (+https://codeberg.org/UnpackedX/Kizzey)",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=18) as resp:
            raw = resp.read().decode("utf-8", "replace").strip()
        try:
            data = json.loads(raw)
            asset = data.get("id") if isinstance(data, dict) else None
            if not asset and isinstance(data, dict):
                asset = data.get("mp")
                if asset and not str(asset).startswith("mp:"):
                    asset = "mp:" + str(asset)
            return str(asset) if asset else None
        except Exception:
            if raw.startswith("mp:"):
                return raw
    except Exception as exc:
        if STORE:
            STORE.log("WARN", "Images", f"Could not resolve image: {exc}")
    return None


def upload_image_bytes(data: bytes, filename: str) -> str | None:
    ext = Path(filename).suffix.lower().lstrip(".") or "jpg"
    if ext not in {"png", "jpg", "jpeg", "gif", "webp"}:
        ext = "jpg"
    boundary = "----KizzeyWeb" + uuid.uuid4().hex
    mime = f"image/{'jpeg' if ext in ('jpg', 'jpeg') else ext}"
    parts = [
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="temp"; filename="temp_file.{ext}"\r\n'.encode(),
        f"Content-Type: {mime}\r\n\r\n".encode(),
        data,
        f"\r\n--{boundary}--\r\n".encode(),
    ]
    body = b"".join(parts)
    req = urllib.request.Request(
        KIZZY_IMAGE_API + "/upload",
        data=body,
        headers={
            "User-Agent": "Kizzey-Web/1.0",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw = resp.read().decode("utf-8", "replace").strip()
        try:
            parsed = json.loads(raw)
            asset = parsed.get("id") if isinstance(parsed, dict) else None
            if asset and not str(asset).startswith("mp:"):
                asset = "mp:" + str(asset)
            return str(asset) if asset else None
        except Exception:
            return raw if raw.startswith("mp:") else None
    except Exception as exc:
        if STORE:
            STORE.log("WARN", "Images", f"Image upload failed: {exc}")
        return None


def resolve_image_asset(value: str, local_base: str = "") -> str | None:
    if not value:
        return None
    value = value.strip()
    if value.startswith("mp:"):
        return value
    if value.startswith("external/") or value.startswith("attachments/"):
        return "mp:" + value
    with IMAGE_CACHE_LOCK:
        cached = IMAGE_CACHE.get(value)
    if cached:
        return cached
    asset = None
    if value.startswith("http://") or value.startswith("https://"):
        asset = image_api_get(value)
    elif value.startswith("/uploads/"):
        local = UPLOAD_DIR / Path(value).name
        if local.exists() and local.stat().st_size <= 12 * 1024 * 1024:
            asset = upload_image_bytes(local.read_bytes(), local.name)
    if asset:
        with IMAGE_CACHE_LOCK:
            IMAGE_CACHE[value] = asset
            if len(IMAGE_CACHE) > 400:
                # drop a few oldest entries
                for key in list(IMAGE_CACHE)[:80]:
                    IMAGE_CACHE.pop(key, None)
    return asset


WEATHER_CACHE: dict[str, tuple[float, dict]] = {}
WEATHER_LOCK = threading.Lock()
WEATHER_CODES = {
    0: ("Clear sky", "☀️"),
    1: ("Mostly clear", "🌤️"),
    2: ("Partly cloudy", "⛅"),
    3: ("Overcast", "☁️"),
    45: ("Fog", "🌫️"),
    48: ("Icy fog", "🌫️"),
    51: ("Light drizzle", "🌦️"),
    53: ("Drizzle", "🌦️"),
    55: ("Heavy drizzle", "🌧️"),
    56: ("Freezing drizzle", "🌧️"),
    57: ("Freezing drizzle", "🌧️"),
    61: ("Light rain", "🌦️"),
    63: ("Rain", "🌧️"),
    65: ("Heavy rain", "🌧️"),
    66: ("Freezing rain", "🌧️"),
    67: ("Freezing rain", "🌧️"),
    71: ("Light snow", "🌨️"),
    73: ("Snow", "❄️"),
    75: ("Heavy snow", "❄️"),
    77: ("Snow grains", "🌨️"),
    80: ("Rain showers", "🌦️"),
    81: ("Rain showers", "🌧️"),
    82: ("Heavy showers", "⛈️"),
    85: ("Snow showers", "🌨️"),
    86: ("Snow showers", "❄️"),
    95: ("Thunderstorm", "⛈️"),
    96: ("Thunder and hail", "⛈️"),
    99: ("Thunder and hail", "⛈️"),
}


def http_json(url: str, timeout: float = 15, headers: dict | None = None):
    req = urllib.request.Request(
        url,
        headers=headers
        or {
            "User-Agent": "Kizzey-Web/1.0",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def weather_description(code: int) -> tuple[str, str]:
    return WEATHER_CODES.get(int(code or 0), ("Weather", "🌡️"))


def fetch_weather(lat: float, lon: float, unit: str = "c") -> dict:
    key = f"{round(lat, 2)}:{round(lon, 2)}"
    with WEATHER_LOCK:
        cached = WEATHER_CACHE.get(key)
        if cached and time.time() - cached[0] < 600:
            return cached[1]
    temp_unit = "fahrenheit" if unit == "f" else "celsius"
    url = (
        "https://api.open-meteo.com/v1/forecast?"
        f"latitude={lat}&longitude={lon}"
        "&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,"
        "precipitation,weather_code,wind_speed_10m,wind_direction_10m"
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,"
        "precipitation_probability_max&timezone=auto&forecast_days=7"
        f"&temperature_unit={temp_unit}&wind_speed_unit=kmh"
    )
    data = http_json(url, timeout=18)
    current = data.get("current", {})
    daily = data.get("daily", {})
    desc, emoji = weather_description(current.get("weather_code", 0))
    daily_items = []
    for i, date in enumerate(daily.get("time", [])):
        ddesc, demoji = weather_description(daily.get("weather_code", [0])[i] if i < len(daily.get("weather_code", [])) else 0)
        daily_items.append(
            {
                "date": date,
                "code": daily.get("weather_code", [0])[i] if i < len(daily.get("weather_code", [])) else 0,
                "desc": ddesc,
                "emoji": demoji,
                "max": daily.get("temperature_2m_max", [None])[i] if i < len(daily.get("temperature_2m_max", [])) else None,
                "min": daily.get("temperature_2m_min", [None])[i] if i < len(daily.get("temperature_2m_min", [])) else None,
                "rain": daily.get("precipitation_probability_max", [None])[i] if i < len(daily.get("precipitation_probability_max", [])) else None,
            }
        )
    result = {
        "lat": lat,
        "lon": lon,
        "unit": unit,
        "temp": current.get("temperature_2m"),
        "feels": current.get("apparent_temperature"),
        "humidity": current.get("relative_humidity_2m"),
        "wind": current.get("wind_speed_10m"),
        "windDir": current.get("wind_direction_10m"),
        "precip": current.get("precipitation"),
        "code": current.get("weather_code"),
        "desc": desc,
        "emoji": emoji,
        "isDay": bool(current.get("is_day", 1)),
        "timezone": data.get("timezone"),
        "daily": daily_items,
        "updatedAt": now_ms(),
    }
    with WEATHER_LOCK:
        if len(WEATHER_CACHE) > 80:
            WEATHER_CACHE.clear()
        WEATHER_CACHE[key] = (time.time(), result)
    return result


def geocode(query: str) -> list[dict]:
    if not query.strip():
        return []
    url = (
        "https://geocoding-api.open-meteo.com/v1/search?"
        f"name={urllib.parse.quote(query)}&count=8&language=en&format=json"
    )
    data = http_json(url, timeout=15)
    results = []
    for row in data.get("results") or []:
        results.append(
            {
                "name": row.get("name"),
                "admin": row.get("admin1"),
                "country": row.get("country"),
                "countryCode": row.get("country_code"),
                "lat": row.get("latitude"),
                "lon": row.get("longitude"),
                "timezone": row.get("timezone"),
            }
        )
    return results


def offline_mode() -> bool:
    return bool(STORE and STORE.state.get("settings", {}).get("offlineMode"))


def update_feed() -> dict:
    if offline_mode():
        return {
            "tag": VERSION,
            "name": f"Kizzey {VERSION}",
            "body": "Offline mode is on. External update checks are paused; Discord RPC and the local gateway keep running.",
            "url": KIZZEY_REPO + "/releases",
            "assets": [],
            "publishedAt": None,
            "source": "offline",
            "live": False,
        }
    try:
        data = http_json(
            KIZZEY_RELEASES_API,
            timeout=15,
            headers={"User-Agent": "Kizzey-Web/1.0", "Accept": "application/json"},
        )
        assets = []
        for a in data.get("assets") or []:
            assets.append(
                {
                    "name": a.get("name"),
                    "size": a.get("size"),
                    "url": a.get("browser_download_url"),
                }
            )
        return {
            "tag": data.get("tag_name") or VERSION,
            "name": data.get("name") or data.get("tag_name") or f"Kizzey {VERSION}",
            "body": data.get("body") or "",
            "url": data.get("html_url") or KIZZEY_REPO + "/releases/latest",
            "assets": assets,
            "publishedAt": data.get("published_at"),
            "source": "codeberg",
            "live": True,
        }
    except Exception as exc:
        return {
            "tag": VERSION,
            "name": f"Kizzey {VERSION}",
            "body": (
                "Everything from the 8.4.3 betas, a remastered Kizzey Chat, live lyrics, "
                "Health RPC, weather, stories and a calmer Home."
            ),
            "url": KIZZEY_REPO + "/releases",
            "assets": [],
            "publishedAt": None,
            "source": "bundled",
            "live": False,
            "error": str(exc),
        }


HOST_STATS_LOCK = threading.Lock()
HOST_STATS_PREV = {"cpu": None, "time": 0.0}


def host_stats() -> dict:
    def read(path: str, default: str = "") -> str:
        try:
            return Path(path).read_text().strip()
        except Exception:
            return default

    load1, load5, load15 = (0.0, 0.0, 0.0)
    try:
        load1, load5, load15 = os.getloadavg()
    except Exception:
        pass
    cpu = None
    try:
        parts = read("/proc/stat").splitlines()[0].split()[1:]
        vals = [int(v) for v in parts]
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
        total = sum(vals)
        with HOST_STATS_LOCK:
            prev = HOST_STATS_PREV.get("cpu")
            prev_t = HOST_STATS_PREV.get("time", 0)
            if prev and mono() - prev_t > 0.8:
                dt_ = mono() - prev_t
                dtotal = total - prev[0]
                didle = idle - prev[1]
                cpu = clamp(100.0 * (1.0 - didle / dtotal), 0, 100) if dtotal > 0 else None
            HOST_STATS_PREV["cpu"] = (total, idle)
            HOST_STATS_PREV["time"] = mono()
    except Exception:
        pass
    mem_total = mem_avail = 0
    try:
        for line in read("/proc/meminfo").splitlines():
            if line.startswith("MemTotal:"):
                mem_total = int(line.split()[1]) * 1024
            elif line.startswith("MemAvailable:"):
                mem_avail = int(line.split()[1]) * 1024
    except Exception:
        pass
    uptime = 0.0
    try:
        uptime = float(read("/proc/uptime").split()[0])
    except Exception:
        pass
    battery = HOST_DEVICE.get("battery")
    charging = None
    for path in ("/sys/class/power_supply/battery/status", "/sys/class/power_supply/bms/status"):
        st = read(path)
        if st:
            charging = st.lower() in ("charging", "full")
            break
    try:
        disk = shutil.disk_usage(str(DATA_DIR))
        disk_data = {"total": disk.total, "free": disk.free, "used": disk.used}
    except Exception:
        disk_data = {}
    with STORE.lock if STORE else _nullctx():
        sessions = len(STORE.subscribers) if STORE else 0
    return {
        "cpu": round(cpu, 1) if cpu is not None else None,
        "load": [round(load1, 2), round(load5, 2), round(load15, 2)],
        "memory": {"total": mem_total, "available": mem_avail, "used": max(0, mem_total - mem_avail)},
        "uptime": int(uptime),
        "battery": battery,
        "charging": charging,
        "disk": disk_data,
        "sessions": sessions,
        "device": HOST_DEVICE,
        "serverTime": now_ms(),
    }


class _nullctx:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


# ---------------------------------------------------------------------------
# Discord gateway
# ---------------------------------------------------------------------------


class GatewayClosed(Exception):
    def __init__(self, message: str = "", code: int | None = None):
        super().__init__(message)
        self.code = code


class WSClient:
    """Tiny RFC 6455 client: only what Discord's gateway needs."""

    def __init__(self, url: str, token: str = ""):
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("wss", "ws"):
            raise ValueError("gateway URL must be ws(s)")
        self.host = parsed.hostname or "gateway.discord.gg"
        self.port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        self.path = parsed.path or "/"
        if parsed.query:
            self.path += "?" + parsed.query
        self.sock = None
        self.buf = b""
        self.send_lock = threading.Lock()
        self.headers = {
            "Host": self.host,
            "User-Agent": DISCORD_UA,
            "Origin": "https://discord.com",
            "X-Super-Properties": super_properties(),
            "Accept-Language": "en-US,en;q=0.9",
        }
        raw = socket.create_connection((self.host, self.port), timeout=25)
        raw.settimeout(35)
        if parsed.scheme == "wss":
            ctx = ssl.create_default_context()
            self.sock = ctx.wrap_socket(raw, server_hostname=self.host)
        else:
            self.sock = raw
        self._handshake()
        self.sock.settimeout(35)

    def _handshake(self) -> None:
        key = base64.b64encode(os.urandom(16)).decode()
        lines = [
            f"GET {self.path} HTTP/1.1",
            f"Host: {self.host}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
        ]
        for k, v in self.headers.items():
            if k.lower() != "host":
                lines.append(f"{k}: {v}")
        request = "\r\n".join(lines) + "\r\n\r\n"
        self.sock.sendall(request.encode("utf-8"))
        raw = b""
        while b"\r\n\r\n" not in raw:
            chunk = self.sock.recv(8192)
            if not chunk:
                raise GatewayClosed("gateway closed during handshake")
            raw += chunk
            if len(raw) > 128 * 1024:
                raise GatewayClosed("gateway handshake too large")
        head, rest = raw.split(b"\r\n\r\n", 1)
        status_line = head.split(b"\r\n", 1)[0].decode("latin1", "replace")
        if " 101 " not in status_line:
            raise GatewayClosed(f"gateway handshake failed: {status_line[:200]}")
        self.buf = rest

    def _read_exact(self, count: int) -> bytes:
        while len(self.buf) < count:
            chunk = self.sock.recv(max(4096, count - len(self.buf)))
            if not chunk:
                raise GatewayClosed("gateway connection closed")
            self.buf += chunk
        out, self.buf = self.buf[:count], self.buf[count:]
        return out

    def send_frame(self, opcode: int, payload: bytes) -> None:
        if not self.sock:
            raise GatewayClosed("socket is closed")
        header = bytearray()
        header.append(0x80 | (opcode & 0x0F))
        length = len(payload)
        mask_bit = 0x80
        if length < 126:
            header.append(mask_bit | length)
        elif length < 65536:
            header.append(mask_bit | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(mask_bit | 127)
            header.extend(struct.pack("!Q", length))
        mask = os.urandom(4)
        header.extend(mask)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        with self.send_lock:
            self.sock.sendall(bytes(header) + masked)

    def send_json(self, obj: dict) -> None:
        self.send_frame(1, json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode())

    def recv(self) -> str:
        fragments = []
        while True:
            b1, b2 = self._read_exact(2)
            fin = bool(b1 & 0x80)
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8))[0]
            if length > 16 * 1024 * 1024:
                raise GatewayClosed("gateway frame too large")
            mask_key = self._read_exact(4) if masked else b""
            payload = self._read_exact(length)
            if masked:
                payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
            if opcode == 0x9:  # ping
                self.send_frame(0xA, payload)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode == 0x8:
                code = None
                reason = ""
                if len(payload) >= 2:
                    code = struct.unpack("!H", payload[:2])[0]
                    reason = payload[2:].decode("utf-8", "replace")
                raise GatewayClosed(
                    f"gateway closed ({code or 'no code'})"
                    + (f": {reason[:160]}" if reason else ""),
                    code,
                )
            if opcode == 0x1:
                fragments.append(payload)
                if fin:
                    return b"".join(fragments).decode("utf-8", "replace")
            elif opcode == 0x2:
                fragments.append(payload)
                if fin:
                    return b"".join(fragments).decode("utf-8", "replace")
            elif opcode == 0x0:
                fragments.append(payload)
                if fin:
                    return b"".join(fragments).decode("utf-8", "replace")
            # unknown opcodes are ignored

    def close(self) -> None:
        try:
            self.send_frame(0x8, struct.pack("!H", 1000))
        except Exception:
            pass
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass
        self.sock = None


class DiscordGateway:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.ws: WSClient | None = None
        self.token = ""
        self.ready = False
        self.sequence = None
        self.session_id = None
        self.last_presence: dict | None = None
        self.heartbeat_interval = 41.25
        self.last_ack = 0.0
        self.last_heartbeat = 0.0
        self.started_at = None
        self.hb_thread = None

    @property
    def connected(self) -> bool:
        return bool(self.ready and self.ws is not None)

    def set_gateway_state(self, state: str, **kwargs) -> None:
        if not STORE:
            return
        with STORE.lock:
            g = STORE.state["gateway"]
            g["state"] = state
            g["connected"] = bool(self.connected)
            for key, value in kwargs.items():
                g[key] = value
        STORE.publish({"type": "gateway", "gateway": STORE.state["gateway"]})

    def start(self, token: str) -> None:
        with self.lock:
            self.stop_locked()
            if not token:
                return
            self.token = token
            self.stop_event = threading.Event()
            self.ready = False
            self.sequence = None
            self.started_at = now_ms()
            self.thread = threading.Thread(target=self.run, name="discord-gateway", daemon=True)
            self.thread.start()

    def stop(self) -> None:
        with self.lock:
            self.stop_locked()

    def stop_locked(self) -> None:
        self.stop_event.set()
        self.ready = False
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass
        self.ws = None
        if self.thread and self.thread.is_alive() and self.thread is not threading.current_thread():
            self.thread.join(timeout=2)
        self.thread = None
        if STORE:
            with STORE.lock:
                STORE.state["gateway"].update(
                    {"connected": False, "state": "offline", "latency": None}
                )
            STORE.publish({"type": "gateway", "gateway": STORE.state["gateway"]})
        self.set_gateway_state("offline")

    def send_presence(self, presence: dict | None) -> None:
        self.last_presence = presence
        if not presence:
            return
        ws = self.ws
        if not ws or not self.ready:
            if STORE:
                STORE.log("DEBUG", "Gateway", "Presence queued until Discord is ready.")
            return
        payload = {"op": 3, "d": presence}
        try:
            ws.send_json(payload)
            if STORE:
                STORE.log("INFO", "Gateway", f"Presence pushed: {presence_title(presence)}")
        except Exception as exc:
            if STORE:
                STORE.log("WARN", "Gateway", f"Could not push presence: {exc}")
            self.ready = False
            raise

    def run(self) -> None:
        backoff = 2.0
        first = True
        while not self.stop_event.is_set():
            try:
                self._connect_once()
                backoff = 2.0
            except GatewayClosed as exc:
                if self.stop_event.is_set():
                    break
                fatal = exc.code in (4004, 4010, 4011, 4012, 4013, 4014)
                msg = _scrub(str(exc))
                if STORE:
                    STORE.log("ERROR" if fatal else "WARN", "Gateway", f"Connection lost: {msg}")
                    if fatal:
                        with STORE.lock:
                            STORE.secret["token"] = ""
                            STORE.secret["tokenSetAt"] = None
                            STORE.state["account"] = None
                            STORE.state["gateway"].update(
                                {
                                    "connected": False,
                                    "state": "error",
                                    "error": "Discord rejected the saved token. Sign in again.",
                                    "latency": None,
                                }
                            )
                            STORE.save()
                        STORE.broadcast_state()
                        self.stop_event.set()
                        break
                self.ready = False
                if STORE and not STORE.state.get("settings", {}).get("keepAlive", True):
                    self.set_gateway_state("offline", error=msg + " Keep-alive is off.")
                    break
                self.set_gateway_state("reconnecting", error=msg)
                wait = 0 if first else backoff
                first = False
                if self.stop_event.wait(wait):
                    break
                backoff = min(35.0, backoff * 1.8)
            except Exception as exc:
                if self.stop_event.is_set():
                    break
                msg = _scrub(str(exc))
                if STORE:
                    STORE.log("WARN", "Gateway", f"Connection lost: {msg}")
                self.ready = False
                if STORE and not STORE.state.get("settings", {}).get("keepAlive", True):
                    self.set_gateway_state("offline", error=msg + " Keep-alive is off.")
                    break
                self.set_gateway_state("reconnecting", error=msg)
                wait = 0 if first else backoff
                first = False
                if self.stop_event.wait(wait):
                    break
                backoff = min(35.0, backoff * 1.8)
            finally:
                try:
                    if self.ws:
                        self.ws.close()
                except Exception:
                    pass
                self.ws = None
                self.ready = False
        self.set_gateway_state("offline" if self.stop_event.is_set() and STORE and STORE.secret.get("token") else "error")

    def _connect_once(self) -> None:
        self.stop_event.clear()
        self.set_gateway_state("connecting", error="")
        ws = WSClient("wss://gateway.discord.gg/?v=10&encoding=json")
        self.ws = ws
        hello = None
        deadline = time.time() + 12
        while time.time() < deadline:
            raw = ws.recv()
            try:
                payload = json.loads(raw)
            except Exception:
                continue
            if payload.get("op") == 10:
                hello = payload
                break
        if not hello:
            raise GatewayClosed("Discord did not send HELLO")
        self.heartbeat_interval = float(hello.get("d", {}).get("heartbeat_interval", 41250)) / 1000.0
        self.last_ack = mono()
        self.last_heartbeat = 0.0
        self.hb_thread = threading.Thread(target=self._heartbeat_loop, name="discord-heartbeat", daemon=True)
        self.hb_thread.start()
        identify = {
            "op": 2,
            "d": {
                "token": self.token,
                "capabilities": 30717,
                "compress": False,
                "largeThreshold": 100,
                "properties": {
                    "os": "Android",
                    "browser": "Discord Android",
                    "device": HOST_DEVICE.get("model") or "Android",
                    "system_locale": "en-US",
                    "client_version": "267.0",
                    "release_channel": "googleRelease",
                    "os_version": HOST_DEVICE.get("android") or "14",
                    "client_build_number": 267206,
                },
            },
        }
        ws.send_json(identify)
        if STORE:
            STORE.log("INFO", "Gateway", "Connecting to Discord gateway…")
        ws.sock.settimeout(0.7)  # type: ignore[union-attr]
        ready_deadline = time.time() + 28
        while not self.stop_event.is_set() and time.time() < ready_deadline:
            try:
                raw = ws.recv()
            except socket.timeout:
                continue
            except Exception as exc:
                if self.stop_event.is_set():
                    return
                raise exc
            try:
                payload = json.loads(raw)
            except Exception:
                continue
            op = payload.get("op")
            seq = payload.get("s")
            if isinstance(seq, int):
                self.sequence = seq
            if op == 11:
                self.last_ack = mono()
                if STORE:
                    with STORE.lock:
                        latency = max(0, int((mono() - self.last_heartbeat) * 1000))
                        STORE.state["gateway"]["latency"] = latency
                continue
            if op == 1:
                self._heartbeat()
                continue
            if op == 7:
                raise GatewayClosed("Discord asked the client to reconnect")
            if op == 9:
                self.ready = False
                if STORE:
                    STORE.log("WARN", "Gateway", "Discord rejected the session; identifying again.")
                if self.stop_event.wait(2.0):
                    return
                ws.send_json(identify)
                ready_deadline = time.time() + 28
                continue
            if op == 0:
                t = payload.get("t")
                data = payload.get("d") or {}
                if t == "READY":
                    self.ready = True
                    self.session_id = data.get("session_id")
                    user = data.get("user") or {}
                    if user and STORE:
                        with STORE.lock:
                            STORE.state["account"] = normalize_user(user)
                    self.set_gateway_state(
                        "connected",
                        connected=True,
                        error="",
                        since=now_ms(),
                        reconnects=STORE.state["gateway"].get("reconnects", 0) if STORE else 0,
                    )
                    if STORE:
                        STORE.log("INFO", "Gateway", "Discord gateway is ready.")
                        STORE.broadcast_state()
                    if self.last_presence:
                        self.send_presence(self.last_presence)
                    else:
                        self._send_idle_presence()
                    break
                if t == "RESUMED":
                    self.ready = True
                    self.set_gateway_state("connected", connected=True, error="", since=now_ms())
                    if self.last_presence:
                        self.send_presence(self.last_presence)
                    break
                if t == "PRESENCE_UPDATE":
                    # Useful for a future friends panel; don't leak private activity to logs.
                    continue
            if op == 4:
                continue
        ws.sock.settimeout(35)  # type: ignore[union-attr]
        while not self.stop_event.is_set() and self.ready:
            try:
                raw = ws.recv()
            except socket.timeout:
                if mono() - self.last_ack > self.heartbeat_interval * 2.2:
                    raise GatewayClosed("heartbeat was not acknowledged")
                continue
            try:
                payload = json.loads(raw)
            except Exception:
                continue
            op = payload.get("op")
            seq = payload.get("s")
            if isinstance(seq, int):
                self.sequence = seq
            if op == 11:
                self.last_ack = mono()
                if STORE and self.last_heartbeat:
                    with STORE.lock:
                        STORE.state["gateway"]["latency"] = max(
                            0, int((mono() - self.last_heartbeat) * 1000)
                        )
            elif op == 1:
                self._heartbeat()
            elif op in (7, 9):
                raise GatewayClosed("gateway asked to reconnect")
            elif op == 0 and payload.get("t") == "READY":
                self.set_gateway_state("connected", connected=True, error="")
            # Other dispatched events (presence, typing, etc.) are intentionally ignored.

    def _send_idle_presence(self) -> None:
        if not STORE:
            return
        with STORE.lock:
            status = STORE.state.get("settings", {}).get("rpcStatus", "online")
        try:
            self.ws.send_json(
                {
                    "op": 3,
                    "d": {
                        "since": 0,
                        "activities": [],
                        "status": normalize_status(status),
                        "afk": False,
                    },
                }
            )
        except Exception:
            pass

    def _heartbeat_loop(self) -> None:
        # jitter the first beat the way the real client does
        if self.stop_event.wait(self.heartbeat_interval * random.uniform(0.25, 0.8)):
            return
        while not self.stop_event.wait(max(5.0, self.heartbeat_interval)):
            if not self.ready:
                continue
            if mono() - self.last_ack > self.heartbeat_interval * 2.2:
                try:
                    if self.ws:
                        self.ws.close()
                except Exception:
                    pass
                return
            self._heartbeat()

    def _heartbeat(self) -> None:
        if not self.ws or not self.ready:
            return
        try:
            self.last_heartbeat = mono()
            self.ws.send_json({"op": 1, "d": self.sequence})
        except Exception as exc:
            if STORE:
                STORE.log("WARN", "Gateway", f"Heartbeat failed: {exc}")
            try:
                self.ws.close()
            except Exception:
                pass


GATEWAY = DiscordGateway()


# ---------------------------------------------------------------------------
# Presence construction
# ---------------------------------------------------------------------------


def normalize_status(value: str) -> str:
    value = (value or "online").lower()
    if value == "offline":
        return "invisible"
    return value if value in ("online", "idle", "dnd", "invisible") else "online"


def sanitize_text(value, max_len: int = 128) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text[:max_len]


def safe_int(value, default=None):
    try:
        if value is None or str(value).strip() == "":
            return default
        return int(float(str(value)))
    except Exception:
        return default


def parse_timestamp(value) -> int | None:
    if value in (None, "", 0, "0"):
        return None
    try:
        number = int(float(str(value)))
    except Exception:
        try:
            parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            return int(parsed.timestamp() * 1000)
        except Exception:
            return None
    if number < 10_000_000_000:
        number *= 1000
    return number


def time_greeting() -> str:
    hour = dt.datetime.now().hour
    if hour < 12:
        return "Good morning"
    if hour < 18:
        return "Good afternoon"
    return "Good evening"


def feature_state(state: dict, kind: str) -> dict:
    if kind == "custom":
        return state.get("custom", {})
    if kind == "apps":
        return state.get("apps", {})
    if kind == "media":
        return state.get("media", {})
    if kind == "console":
        return state.get("console", {})
    if kind == "experimental":
        return state.get("experimental", {})
    if kind == "cycling":
        return state.get("cycling", {})
    if kind == "multiple":
        return state.get("multiple", {})
    if kind == "samsung":
        return state.get("samsung", {})
    if kind == "emulation":
        return state.get("emulation", {})
    if kind == "health":
        return state.get("health", {})
    if kind == "location":
        return state.get("location", {})
    if kind == "weather":
        return state.get("weather", {})
    if kind == "navigation":
        return state.get("navigation", {})
    if kind == "android_auto":
        return state.get("androidAuto", {})
    if kind == "screen_read":
        return state.get("screenRead", {})
    return {}


def template_values(state: dict) -> dict:
    track = state.get("media", {}).get("track", {}) or {}
    weather = state.get("weather", {}) or {}
    health = state.get("health", {}) or {}
    location = state.get("location", {}) or {}
    account = state.get("account") or {}
    screen = state.get("screenRead", {}).get("lastFields", {}) or {}
    nav = state.get("navigation", {}) or {}
    now = dt.datetime.now()
    values = {
        "user": account.get("displayName") or state.get("chatProfile", {}).get("name") or "friend",
        "username": account.get("username") or state.get("chatProfile", {}).get("name") or "friend",
        "name": account.get("displayName") or state.get("chatProfile", {}).get("name") or "",
        "media_title": track.get("title", ""),
        "media_artist": track.get("artist", ""),
        "media_album": track.get("album", ""),
        "song": track.get("title", ""),
        "artist": track.get("artist", ""),
        "app_name": state.get("apps", {}).get("selected", {}).get("title", "")
        if isinstance(state.get("apps", {}).get("selected"), dict)
        else "",
        "weather": weather.get("lastText") or state.get("weather", {}).get("place", ""),
        "weather_temp": "",
        "weather_feels": "",
        "weather_desc": "",
        "weather_emoji": "",
        "place": location.get("place") or weather.get("place", ""),
        "steps": health.get("steps", 0),
        "heart_rate": health.get("heart", 0),
        "heart": health.get("heart", 0),
        "sleep": health.get("sleep", 0),
        "stress": health.get("stress", 0),
        "screen_name": screen.get("screen_name", ""),
        "screen_score": screen.get("screen_score", ""),
        "nav_destination": nav.get("destination", ""),
        "nav_eta": nav.get("durationText", ""),
        "time": now.strftime("%H:%M"),
        "date": now.strftime("%a, %d %b"),
        "date_full": now.strftime("%A, %d %B %Y"),
        "timezone": now.astimezone().tzname() or "",
    }
    # last weather payload is cached in state under weather.last, if present
    wlast = state.get("weather", {}).get("last") or {}
    if wlast:
        unit = (state.get("weather", {}).get("unit") or "c").upper()
        temp = wlast.get("temp")
        feels = wlast.get("feels")
        values["weather_temp"] = f"{temp}°{unit}" if temp is not None else ""
        values["weather_feels"] = f"{feels}°{unit}" if feels is not None else ""
        values["weather_desc"] = wlast.get("desc", "")
        values["weather_emoji"] = wlast.get("emoji", "")
        values["weather"] = wlast.get("desc", values["weather"])
    return values


def expand_template(text, state: dict) -> str:
    if not text:
        return ""
    text = str(text)
    values = template_values(state)

    def repl(match):
        key = match.group(1).strip()
        value = values.get(key)
        return "" if value is None else str(value)

    return re.sub(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}", repl, text)


def build_custom_activity(state: dict, cfg: dict | None = None) -> dict:
    custom = cfg if isinstance(cfg, dict) else state.get("custom", {})
    name = sanitize_text(expand_template(custom.get("name"), state), 128)
    details = sanitize_text(expand_template(custom.get("details"), state), 128)
    state_line = sanitize_text(expand_template(custom.get("state"), state), 128)
    if not name:
        raise ValueError("Activity name is required. Discord drops a card with no name.")
    # Discord validates details/state at 2..128 and silently drops the activity if one is a single char.
    if details and len(details) < 2:
        details = None
    if state_line and len(state_line) < 2:
        state_line = None
    type_value = safe_int(custom.get("type"), 0)
    if type_value not in (0, 1, 2, 3, 5):
        type_value = 0
    start = parse_timestamp(custom.get("timestampsStart"))
    end = parse_timestamp(custom.get("timestampsStop"))
    timestamps = None
    if start or end:
        timestamps = {}
        if start:
            timestamps["start"] = start
        if end:
            timestamps["end"] = end
    assets = None
    large = custom.get("largeImg") or custom.get("largeUrl") or ""
    small = custom.get("smallImg") or custom.get("smallUrl") or ""
    large_asset = resolve_image_asset(large) if large else None
    small_asset = resolve_image_asset(small) if small else None
    if large_asset or small_asset:
        assets = {}
        if large_asset:
            assets["large_image"] = large_asset
        if small_asset:
            assets["small_image"] = small_asset
        large_text = sanitize_text(expand_template(custom.get("largeText"), state), 128)
        small_text = sanitize_text(expand_template(custom.get("smallText"), state), 128)
        if large_text:
            assets["large_text"] = large_text
        if small_text:
            assets["small_text"] = small_text
    party = None
    current = safe_int(custom.get("partyCurrentSize"))
    maximum = safe_int(custom.get("partyMaxSize"))
    if current and maximum and current > 0 and maximum >= current:
        party = {"id": "kizzey", "size": [current, maximum]}
    buttons = []
    for label_key, url_key in (("button1", "button1link"), ("button2", "button2link")):
        label = sanitize_text(custom.get(label_key), 32)
        url = str(custom.get(url_key) or "").strip()
        if label and url.startswith(("http://", "https://")):
            buttons.append(label)
    button_urls = []
    for label_key, url_key in (("button1", "button1link"), ("button2", "button2link")):
        label = sanitize_text(custom.get(label_key), 32)
        url = str(custom.get(url_key) or "").strip()
        if label and url.startswith(("http://", "https://")):
            button_urls.append(url[:256])
    app_id = str(custom.get("applicationId") or "").strip()
    if app_id and not re.fullmatch(r"\d{18,19}", app_id):
        raise ValueError("Application ID must be 18 or 19 digits, or blank for Kizzey's default app.")
    activity = {
        "name": name,
        "details": details,
        "state": state_line,
        "type": type_value,
        "application_id": app_id or DEFAULT_APP_ID,
    }
    if timestamps:
        activity["timestamps"] = timestamps
    if assets:
        activity["assets"] = assets
    if party:
        activity["party"] = party
    if buttons:
        activity["buttons"] = buttons[:2]
        activity["metadata"] = {"button_urls": button_urls[:2]}
    platform = str(custom.get("platform") or "").strip()
    if platform:
        activity["platform"] = platform[:32]
    status_display = safe_int(custom.get("statusDisplayType"), -1)
    if status_display in (0, 1, 2):
        activity["status_display_type"] = status_display
    stream = str(custom.get("url") or "").strip()
    if type_value == 1 and stream.startswith(("http://", "https://")):
        activity["url"] = stream[:256]
    if type_value == 1 and not activity.get("url"):
        raise ValueError("Streaming requires a Twitch or YouTube URL.")
    activity["created_at"] = now_ms()
    return {k: v for k, v in activity.items() if v is not None}


def build_apps_activity(state: dict) -> dict:
    app = state.get("apps", {}).get("selected")
    if not isinstance(app, dict) or not app.get("title"):
        raise ValueError("Pick an app to share first.")
    title = sanitize_text(app.get("presenceName") or app.get("title"), 128)
    return {
        "name": title,
        "details": sanitize_text(app.get("details") or app.get("title"), 128),
        "state": sanitize_text(app.get("state") or "Using App Detection", 128),
        "type": safe_int(app.get("type"), 0) if safe_int(app.get("type"), 0) in (0, 1, 2, 3, 5) else 0,
        "application_id": str(app.get("applicationId") or DEFAULT_APP_ID),
        "assets": {"large_image": app.get("iconAsset")} if app.get("iconAsset") else None,
        "timestamps": {"start": now_ms()},
        "platform": "android",
        "created_at": now_ms(),
    }


def build_media_activity(state: dict) -> dict:
    media = state.get("media", {})
    track = media.get("track") or {}
    title = sanitize_text(track.get("title"), 128)
    artist = sanitize_text(track.get("artist"), 128)
    album = sanitize_text(track.get("album"), 128)
    if not title:
        raise ValueError("Set a track title in Media RPC first.")
    activity = {
        "name": title,
        "details": artist,
        "state": album,
        "type": safe_int(media.get("type"), 2),
        "application_id": DEFAULT_APP_ID,
        "created_at": now_ms(),
        "status_display_type": 0,
    }
    if media.get("showProgress"):
        duration = safe_int(track.get("duration"), 0) or 0
        position = safe_int(track.get("position"), 0) or 0
        start = now_ms() - max(0, position) * 1000
        timestamps = {"start": start}
        if duration > position > 0:
            timestamps["end"] = start + duration * 1000
        activity["timestamps"] = timestamps
    art = resolve_image_asset(track.get("art") or "")
    if art:
        activity["assets"] = {
            "large_image": art,
            "large_text": sanitize_text(track.get("album") or title, 128) or title,
        }
    return {k: v for k, v in activity.items() if v not in (None, "")}


CONSOLE_DEVICES = {
    "PlayStation 5": ("ps5", "PlayStation 5"),
    "PlayStation 4": ("ps4", "PlayStation 4"),
    "Xbox Series X|S": ("xbox", "Xbox Series X|S"),
    "Xbox One": ("xbox", "Xbox One"),
    "Nintendo Switch": ("nintendo", "Nintendo Switch"),
    "Steam Deck": ("desktop", "Steam Deck"),
    "Samsung Galaxy": ("samsung", "Samsung Galaxy"),
}


def build_console_activity(state: dict) -> dict:
    console = state.get("console", {})
    selected = console.get("selected") if isinstance(console.get("selected"), dict) else {}
    game = sanitize_text(console.get("game") or selected.get("title"), 128)
    if not game:
        raise ValueError("Choose a console game first.")
    device = console.get("device") or "PlayStation 5"
    platform, pretty = CONSOLE_DEVICES.get(device, ("desktop", device))
    art = ""
    if isinstance(console.get("selected"), dict):
        art = console["selected"].get("art") or ""
    assets = {"large_image": resolve_image_asset(art)} if art else None
    return {
        "name": game,
        "details": f"Playing on {pretty}",
        "state": sanitize_text(console.get("tidbit") or "Console RPC", 128),
        "type": 0,
        "platform": platform,
        "application_id": DEFAULT_APP_ID,
        "assets": assets,
        "supported_platforms": [platform],
        "timestamps": {"start": now_ms()},
        "created_at": now_ms(),
    }


def build_health_activity(state: dict) -> dict:
    health = state.get("health", {})
    shown = health.get("show") or []
    parts = []
    if "steps" in shown:
        parts.append(f"{health.get('steps', 0):,} steps")
    if "heart" in shown:
        parts.append(f"{health.get('heart', 0)} bpm")
    if "sleep" in shown:
        parts.append(f"{health.get('sleep', 0)}h sleep")
    if "stress" in shown:
        parts.append(f"{health.get('stress', 0)}% stress")
    return {
        "name": "Health",
        "details": " · ".join(parts)[:128] or "Daily health",
        "state": sanitize_text(health.get("label") or "Taking care of myself", 128),
        "type": 2,
        "application_id": DEFAULT_APP_ID,
        "timestamps": {"start": now_ms()},
        "created_at": now_ms(),
        "status_display_type": 2,
    }


def build_location_activity(state: dict) -> dict:
    loc = state.get("location", {})
    place = loc.get("place") or "somewhere"
    return {
        "name": "Location",
        "details": sanitize_text(expand_template(loc.get("template") or "In {{place}}", state), 128) or f"In {place}",
        "state": "Using Location RPC",
        "type": 3,
        "application_id": DEFAULT_APP_ID,
        "timestamps": {"start": now_ms()},
        "created_at": now_ms(),
        "status_display_type": 0,
    }


def build_weather_activity(state: dict) -> dict:
    weather = state.get("weather", {})
    last = weather.get("last") or {}
    if not last:
        raise ValueError("Look up a city or refresh the weather first.")
    unit = (weather.get("unit") or "c").upper()
    temp = last.get("temp")
    feels = last.get("feels")
    desc = last.get("desc", "Weather")
    emoji = last.get("emoji", "")
    values = {
        "place": weather.get("place", ""),
        "temp": f"{temp}°{unit}" if temp is not None else "",
        "feels": f"{feels}°{unit}" if feels is not None else "",
        "desc": desc,
        "emoji": emoji,
    }
    def fmt(template: str, fallback: str) -> str:
        out = template or ""
        for key, value in values.items():
            out = out.replace("{{weather_" + key + "}}", str(value))
        return sanitize_text(out, 128) or fallback
    return {
        "name": fmt(expand_template(weather.get("template") or "Weather", state), desc),
        "details": fmt(expand_template(weather.get("details") or "", state), f"Feels like {values['feels']}") if values["feels"] else desc,
        "state": sanitize_text(weather.get("place"), 128),
        "type": 3,
        "application_id": DEFAULT_APP_ID,
        "timestamps": {"start": now_ms()},
        "created_at": now_ms(),
    }


def build_navigation_activity(state: dict) -> dict:
    nav = state.get("navigation", {})
    destination = sanitize_text(nav.get("destination"), 128)
    if not destination:
        raise ValueError("Set a destination in Navigation first.")
    eta = nav.get("durationText") or ""
    distance = nav.get("distanceText") or ""
    return {
        "name": "Navigation",
        "details": sanitize_text(f"Driving to {destination}", 128),
        "state": sanitize_text(" · ".join(x for x in (eta, distance) if x) or "On the way", 128),
        "type": 3,
        "application_id": DEFAULT_APP_ID,
        "timestamps": {"start": now_ms()},
        "created_at": now_ms(),
    }


def build_android_auto_activity(state: dict) -> dict:
    auto = state.get("androidAuto", {})
    return {
        "name": sanitize_text(auto.get("template") or "On the road", 128),
        "details": sanitize_text(auto.get("details") or "Android Auto", 128),
        "state": "Android Auto",
        "type": 3,
        "platform": "android",
        "application_id": DEFAULT_APP_ID,
        "timestamps": {"start": now_ms()},
        "created_at": now_ms(),
    }


def build_samsung_activity(state: dict) -> dict:
    sam = state.get("samsung", {})
    game = sanitize_text(sam.get("game") or "a Galaxy game", 128)
    return {
        "name": game,
        "details": "Playing on Samsung Galaxy",
        "state": "Samsung RPC",
        "type": 0,
        "platform": "samsung",
        "application_id": DEFAULT_APP_ID,
        "timestamps": {"start": now_ms()},
        "created_at": now_ms(),
        "supported_platforms": ["samsung"],
    }


def build_emulation_activity(state: dict) -> dict:
    emu = state.get("emulation", {})
    game = sanitize_text(emu.get("game") or "an emulated game", 128)
    return {
        "name": game,
        "details": sanitize_text(f"Playing on {emu.get('emulator') or 'RetroArch'}", 128),
        "state": sanitize_text(emu.get("core") or "Emulation RPC", 128),
        "type": 0,
        "platform": "android",
        "application_id": DEFAULT_APP_ID,
        "timestamps": {"start": now_ms()},
        "created_at": now_ms(),
    }


def build_screen_read_activity(state: dict) -> dict:
    sr = state.get("screenRead", {})
    fields = sr.get("lastFields") or {}
    name = sanitize_text(fields.get("screen_name") or sr.get("preset") or "Screen Read", 128)
    score = sanitize_text(fields.get("screen_score") or "Reading the screen", 128)
    return {
        "name": name,
        "details": sanitize_text(expand_template(sr.get("fields", {}).get("details") if isinstance(sr.get("fields"), dict) else "{{screen_name}}", state), 128) or name,
        "state": sanitize_text(expand_template(sr.get("fields", {}).get("state") if isinstance(sr.get("fields"), dict) else "{{screen_score}}", state), 128) or score,
        "type": 0,
        "application_id": DEFAULT_APP_ID,
        "timestamps": {"start": now_ms()},
        "created_at": now_ms(),
    }


def build_activity(state: dict, kind: str, cycling_index: int = 0) -> dict:
    if kind == "custom":
        return build_custom_activity(state)
    if kind == "apps":
        return build_apps_activity(state)
    if kind == "media":
        return build_media_activity(state)
    if kind == "console":
        return build_console_activity(state)
    if kind == "experimental":
        exp = state.get("experimental", {})
        sources = exp.get("sources") or ["apps", "media"]
        if "apps" in sources and state.get("apps", {}).get("selected"):
            return build_apps_activity(state)
        return build_media_activity(state)
    if kind == "multiple":
        sources = state.get("multiple", {}).get("sources") or []
        for source in sources:
            try:
                return build_activity(state, source)
            except Exception:
                continue
        raise ValueError("Choose at least one working source for Multiple RPC.")
    if kind == "cycling":
        cyc = state.get("cycling", {})
        types = cyc.get("types") or [0]
        type_value = int(types[cycling_index % len(types)]) if types else 0
        cfg = dict(state.get("custom", {}))
        cfg["type"] = str(type_value)
        cfg["name"] = cfg.get("name") or "RPC Cycling"
        if type_value == 1:
            cfg["url"] = cyc.get("streamUrl") or cfg.get("url") or ""
        return build_custom_activity(state, cfg)
    if kind == "samsung":
        return build_samsung_activity(state)
    if kind == "emulation":
        return build_emulation_activity(state)
    if kind == "health":
        return build_health_activity(state)
    if kind == "location":
        return build_location_activity(state)
    if kind == "weather":
        return build_weather_activity(state)
    if kind == "navigation":
        return build_navigation_activity(state)
    if kind == "android_auto":
        return build_android_auto_activity(state)
    if kind == "screen_read":
        return build_screen_read_activity(state)
    raise ValueError("Unknown presence kind.")


def presence_title(payload: dict) -> str:
    acts = payload.get("activities") or []
    if not acts:
        return "no activity"
    first = acts[0] or {}
    bits = [first.get("name"), first.get("details"), first.get("state")]
    return " · ".join(str(b) for b in bits if b)


def presence_public(kind: str, started_at: int | None, activities: list[dict], cycle_index: int = 0) -> dict:
    label = PRESENCE_KINDS.get(kind, "Rich Presence")
    first = activities[0] if activities else {}
    subtitle_bits = [first.get("details"), first.get("state")]
    return {
        "kind": kind,
        "label": label,
        "title": first.get("name") or label,
        "subtitle": " · ".join(str(b) for b in subtitle_bits if b),
        "startedAt": started_at,
        "activity": first,
        "activities": activities,
        "cycleIndex": cycle_index,
    }


def send_current_presence(store: Store, *, force: bool = False, cycle_index: int | None = None) -> dict | None:
    with store.lock:
        active = store.state.get("presence", {}).get("active")
        if not active:
            return None
        kind = active.get("kind")
        started = store.state["presence"].get("startedAt") or now_ms()
        if cycle_index is not None:
            store.state["presence"]["cycleIndex"] = cycle_index
        idx = cycle_index if cycle_index is not None else store.state["presence"].get("cycleIndex", 0)
        sources = []
        if kind == "multiple":
            sources = list(store.state.get("multiple", {}).get("sources") or [])
        activities = []
        try:
            if kind == "multiple":
                for source in sources:
                    try:
                        activities.append(build_activity(store.state, source))
                    except Exception as exc:
                        store.log("WARN", "Presence", f"{source}: {exc}")
            else:
                activities.append(build_activity(store.state, kind, idx))
        except Exception as exc:
            store.log("ERROR", "Presence", f"Could not build presence: {exc}")
            return None
        status = normalize_status(
            store.state.get("custom", {}).get("status")
            if kind == "custom"
            else store.state.get("settings", {}).get("rpcStatus", "online")
        )
        if kind == "experimental":
            status = normalize_status(store.state.get("experimental", {}).get("status") or status)
        payload = {
            "since": 0,
            "activities": activities,
            "status": status,
            "afk": False,
        }
        store.state["presence"]["activities"] = activities
        store.state["presence"]["updatedAt"] = now_ms()
        store.state["presence"]["info"] = presence_public(kind, started, activities, idx)
        GATEWAY.send_presence(payload)
        store.save()
    store.publish({"type": "presence", "presence": store.state["presence"], "gateway": store.state["gateway"]})
    return payload


# ---------------------------------------------------------------------------
# Ticker
# ---------------------------------------------------------------------------


class Ticker:
    def __init__(self) -> None:
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, name="kizzey-ticker", daemon=True)
        self.last_sent = 0.0
        self.last_template = ""
        self.last_cycle = -1

    def start(self) -> None:
        self.thread.start()

    def run(self) -> None:
        while not self.stop_event.wait(5):
            if not STORE:
                continue
            try:
                self.tick()
            except Exception:
                if STORE:
                    STORE.log("WARN", "Ticker", traceback.format_exc(limit=2))

    def tick(self) -> None:
        assert STORE is not None
        self.run_automation()
        with STORE.lock:
            presence = STORE.state.get("presence") or {}
            active = presence.get("active")
            if not active:
                return
            kind = active.get("kind")
            started = presence.get("startedAt") or now_ms()
            cfg = dict(STORE.state.get("custom") or {})
            next_cycle = None
            interval = 0
            if kind == "cycling":
                cyc = STORE.state.get("cycling") or {}
                if cyc.get("mode") == "cycle":
                    interval = max(15, safe_int(cyc.get("interval"), 30) or 30)
            elif kind == "experimental":
                exp = STORE.state.get("experimental") or {}
                if exp.get("mode") == "switch":
                    interval = max(5, safe_int(exp.get("interval"), 15) or 15)
            if interval:
                elapsed = max(0, (now_ms() - started) / 1000.0)
                idx = int(elapsed // interval)
                if idx != self.last_cycle:
                    self.last_cycle = idx
                    send_current_presence(STORE, cycle_index=idx)
                    return
            # Refresh dynamic clock/date tokens once a minute when running.
            now = time.time()
            if kind == "custom" and now - self.last_sent >= 60:
                rendered = expand_template(cfg.get("name", ""), STORE.state) + "|" + expand_template(
                    cfg.get("details", ""), STORE.state
                ) + "|" + expand_template(cfg.get("state", ""), STORE.state)
                if rendered != self.last_template:
                    self.last_template = rendered
                    self.last_sent = now
                    send_current_presence(STORE, force=True)

    def run_automation(self) -> None:
        """Start a scheduled presence when its weekday/time matches.

        Automations are intentionally conservative: an already-running presence
        is never replaced, so a hand-started card always wins over a schedule.
        """
        assert STORE is not None
        if not STORE.secret.get("token"):
            return
        data = STORE.state.get("automation") or {}
        if not data.get("enabled"):
            return
        now = dt.datetime.now()
        minute_key = now.strftime("%Y-%m-%dT%H:%M")
        with STORE.lock:
            if (STORE.state.get("presence") or {}).get("active"):
                return
            for rule in data.get("rules") or []:
                if not isinstance(rule, dict) or not rule.get("enabled"):
                    continue
                if rule.get("lastFired") == minute_key:
                    continue
                days = rule.get("days") or []
                if days and now.weekday() not in [safe_int(d, -1) for d in days]:
                    continue
                if str(rule.get("time") or "") != now.strftime("%H:%M"):
                    continue
                action = str(rule.get("action") or "custom")
                if action not in PRESENCE_KINDS:
                    continue
                rule["lastFired"] = minute_key
                STORE.save()
                name = rule.get("name") or action
                try:
                    start_presence(action, {"automation": name})
                    STORE.log("INFO", "Automation", f"Started “{name}” on schedule.")
                except Exception as exc:
                    STORE.log("WARN", "Automation", f"Could not run “{name}”: {exc}")
                break


TICKER = Ticker()


# ---------------------------------------------------------------------------
# Auth / presence operations
# ---------------------------------------------------------------------------


def sign_in(token: str) -> dict:
    assert STORE is not None
    token = token.strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    if not token:
        raise DiscordError(401, "Paste a Discord account token first.")
    user = validate_token(token)
    with STORE.lock:
        STORE.secret["token"] = token
        STORE.secret["tokenSetAt"] = now_ms()
        STORE.secret["authError"] = ""
        STORE.state["account"] = user
        STORE.state["gateway"]["error"] = ""
        STORE.state["gateway"]["tokenSet"] = True
    STORE.save()
    STORE.log("INFO", "Account", f"Signed in as {user['displayName']}.")
    GATEWAY.start(token)
    STORE.broadcast_state()
    return user


def sign_out() -> None:
    assert STORE is not None
    GATEWAY.stop()
    stop_presence(None, quiet=True)
    with STORE.lock:
        STORE.secret["token"] = ""
        STORE.secret["tokenSetAt"] = None
        STORE.state["account"] = None
        STORE.state["gateway"].update(
            {"connected": False, "state": "offline", "error": "", "latency": None}
        )
    STORE.save()
    STORE.log("INFO", "Account", "Signed out of Discord.")
    STORE.broadcast_state()


def stop_presence(kind: str | None = None, quiet: bool = False) -> bool:
    assert STORE is not None
    with STORE.lock:
        active = STORE.state.get("presence", {}).get("active")
        started = STORE.state.get("presence", {}).get("startedAt")
        if not active:
            return False
        if kind and active.get("kind") != kind and kind != "all":
            return False
        title = active.get("title") or (STORE.state.get("presence", {}).get("info", {}) or {}).get("title") or ""
        STORE.add_history(
            active.get("kind") or "custom",
            PRESENCE_KINDS.get(active.get("kind"), "Rich Presence"),
            title,
            int(started or now_ms()),
            now_ms(),
        )
        STORE.state["presence"] = {
            "active": None,
            "startedAt": None,
            "activities": [],
            "updatedAt": now_ms(),
            "info": None,
        }
        STORE.state["custom"]["status"] = "online"
        if not quiet:
            STORE.log("INFO", "Presence", "Stopped all rich presence.")
        GATEWAY.send_presence(None)
        STORE.save()
    STORE.publish({"type": "presence", "presence": STORE.state["presence"], "gateway": STORE.state["gateway"]})
    return True


def start_presence(kind: str, payload: dict | None = None) -> dict:
    assert STORE is not None
    if not STORE.secret.get("token"):
        raise DiscordError(401, "Sign in to Discord in Settings before starting a presence.")
    if kind not in PRESENCE_KINDS:
        raise ValueError("Unknown RPC type.")
    if payload and isinstance(payload, dict):
        # Feature-specific quick updates from the client.
        with STORE.lock:
            if kind == "custom" and isinstance(payload.get("custom"), dict):
                deep_merge(STORE.state["custom"], visible_patch(payload["custom"]))
            for key in (
                "apps",
                "media",
                "console",
                "experimental",
                "cycling",
                "multiple",
                "health",
                "location",
                "weather",
                "navigation",
                "androidAuto",
                "samsung",
                "emulation",
                "screenRead",
            ):
                if key in payload and isinstance(payload[key], dict):
                    deep_merge(STORE.state[key], visible_patch(payload[key]))
    # Validate the new card before touching the running routine, so a typo in
    # a custom card cannot silently kill the presence already on Discord.
    try:
        with STORE.lock:
            snapshot = json.loads(json.dumps(STORE.state, ensure_ascii=False))
        first = build_activity(snapshot, kind)
    except Exception as exc:
        raise ValueError(str(exc)) from exc
    # stop the previous routine, mirroring the Android RoutineController
    stop_presence(None, quiet=True)
    with STORE.lock:
        started = now_ms()
        info = presence_public(kind, started, [first])
        STORE.state["presence"] = {
            "active": {"kind": kind, "title": first.get("name"), "startedAt": started},
            "startedAt": started,
            "activities": [first],
            "info": info,
            "updatedAt": started,
            "cycleIndex": 0,
        }
        STORE.state.setdefault("usage", {})[kind] = int(STORE.state.get("usage", {}).get(kind, 0)) + 1
        recent = [kind] + [x for x in STORE.state.get("recent", []) if x != kind]
        STORE.state["recent"] = recent[:8]
        STORE.log(
            "INFO",
            "Presence",
            f"{PRESENCE_KINDS.get(kind, 'RPC')} started: {info['title']}"
            + (f" — {info['subtitle']}" if info.get("subtitle") else ""),
        )
        STORE.save()
    send_current_presence(STORE, force=True)
    STORE.broadcast_state()
    return STORE.state["presence"]


def refresh_presence() -> dict | None:
    assert STORE is not None
    with STORE.lock:
        active = STORE.state.get("presence", {}).get("active")
    if not active:
        return None
    send_current_presence(STORE, force=True)
    STORE.log("INFO", "Presence", "Presence refreshed.")
    STORE.broadcast_state()
    return STORE.state.get("presence")


# ---------------------------------------------------------------------------
# Chat / wallet operations
# ---------------------------------------------------------------------------


def chat_room(room_id: str) -> dict | None:
    assert STORE is not None
    for room in STORE.state.get("chat", {}).get("rooms", []):
        if room.get("id") == room_id:
            return room
    return None


def chat_send(room_id: str, text: str, attach: str = "", reply_to: str | None = None) -> dict:
    assert STORE is not None
    if not chat_room(room_id):
        raise ValueError("Room not found.")
    text = (text or "").strip()
    if not text and not attach:
        raise ValueError("Type a message first.")
    if len(text) > 2000:
        raise ValueError("Messages are limited to 2000 characters.")
    profile = STORE.state.get("chatProfile", {})
    msg = {
        "id": uuid.uuid4().hex,
        "author": profile.get("name") or "You",
        "avatar": profile.get("avatar") or "",
        "color": profile.get("color") or "#d0bcff",
        "text": text,
        "attach": attach,
        "time": now_ms(),
        "reactions": {},
        "replyTo": reply_to,
        "local": True,
    }
    with STORE.lock:
        messages = STORE.state["chat"].setdefault("messages", {}).setdefault(room_id, [])
        messages.append(msg)
        STORE.state["chat"]["messages"][room_id] = messages[-MAX_CHAT:]
        STORE.save()
    STORE.publish({"type": "chat", "room": room_id, "message": msg})
    return msg


def chat_react(room_id: str, message_id: str, emoji: str) -> dict:
    assert STORE is not None
    profile = STORE.state.get("chatProfile", {}).get("name") or "You"
    emoji = (emoji or "✨")[:8]
    with STORE.lock:
        messages = STORE.state["chat"].get("messages", {}).get(room_id, [])
        for msg in messages:
            if msg.get("id") == message_id:
                reactions = msg.setdefault("reactions", {})
                people = reactions.setdefault(emoji, [])
                if profile in people:
                    people.remove(profile)
                    if not people:
                        reactions.pop(emoji, None)
                else:
                    people.append(profile)
                STORE.save()
                STORE.publish({"type": "chat", "room": room_id, "message": msg})
                return msg
    raise ValueError("Message not found.")


def moment_post(text: str, tag: str = "") -> dict:
    assert STORE is not None
    text = (text or "").strip()
    if not text:
        raise ValueError("Write something first.")
    profile = STORE.state.get("chatProfile", {})
    moment = {
        "id": uuid.uuid4().hex,
        "author": profile.get("name") or "You",
        "color": profile.get("color") or "#d0bcff",
        "text": text[:500],
        "time": now_ms(),
        "likes": [],
        "tag": tag or "moment",
    }
    with STORE.lock:
        STORE.state["chat"].setdefault("moments", []).insert(0, moment)
        STORE.state["chat"]["moments"] = STORE.state["chat"]["moments"][:80]
        STORE.save()
    STORE.publish({"type": "moments", "moments": STORE.state["chat"]["moments"]})
    return moment


def moment_like(moment_id: str) -> list[dict]:
    assert STORE is not None
    profile = STORE.state.get("chatProfile", {}).get("name") or "You"
    with STORE.lock:
        for moment in STORE.state.get("chat", {}).get("moments", []):
            if moment.get("id") == moment_id:
                likes = moment.setdefault("likes", [])
                if profile in likes:
                    likes.remove(profile)
                else:
                    likes.append(profile)
                STORE.save()
                STORE.publish({"type": "moments", "moments": STORE.state["chat"]["moments"]})
                return STORE.state["chat"]["moments"]
    raise ValueError("Moment not found.")


def wallet_daily() -> dict:
    assert STORE is not None
    now = time.time()
    with STORE.lock:
        wallet = STORE.state.setdefault("wallet", {})
        last = float(wallet.get("daily") or 0)
        if now - last < 20 * 60 * 60:
            remaining = int(20 * 60 * 60 - (now - last))
            raise ValueError(f"Come back in {max(1, remaining // 60)} minutes for your next KCoin.")
        amount = 50 + min(7, int(wallet.get("streak") or 0)) * 5
        wallet["kcoin"] = int(wallet.get("kcoin") or 0) + amount
        wallet["daily"] = now
        wallet["streak"] = int(wallet.get("streak") or 0) + 1
        STORE.save()
    STORE.log("INFO", "Wallet", f"Daily reward claimed: +{amount} KCoin.")
    STORE.broadcast_state()
    return {"amount": amount, "wallet": wallet}


SHOP = {
    "aurora": {"name": "Aurora", "price": 0, "kind": "theme", "color": "#d0bcff"},
    "sunset": {"name": "Sunset rail", "price": 180, "kind": "theme", "color": "#f0a6ca"},
    "ocean": {"name": "Deep ocean", "price": 180, "kind": "theme", "color": "#7dd3fc"},
    "violet": {"name": "Violet hour", "price": 240, "kind": "theme", "color": "#c4b5fd"},
    "badge-flame": {"name": "Flame badge", "price": 120, "kind": "badge", "emoji": "🔥"},
    "badge-star": {"name": "Star badge", "price": 120, "kind": "badge", "emoji": "✦"},
    "bubble-soft": {"name": "Soft bubble", "price": 90, "kind": "chat", "emoji": "🫧"},
}


def shop_buy(item_id: str) -> dict:
    assert STORE is not None
    item = SHOP.get(item_id)
    if not item:
        raise ValueError("That item is not in the shop.")
    with STORE.lock:
        wallet = STORE.state.setdefault("wallet", {})
        inv = wallet.setdefault("inventory", [])
        if item_id in inv:
            raise ValueError("You already own that.")
        price = int(item["price"])
        if int(wallet.get("kcoin") or 0) < price:
            raise ValueError("Not enough KCoin yet.")
        wallet["kcoin"] = int(wallet.get("kcoin") or 0) - price
        inv.append(item_id)
        STORE.save()
    STORE.log("INFO", "Wallet", f"Unlocked {item['name']}.")
    STORE.broadcast_state()
    return {"wallet": wallet, "item": item}


def voice_join(room: str, client_id: str) -> dict:
    assert STORE is not None
    profile = STORE.state.get("chatProfile", {})
    now = now_ms()
    with STORE.lock:
        voice = STORE.state.setdefault("chat", {}).setdefault("voice", {"participants": []})
        people = [p for p in voice.get("participants", []) if now - p.get("seen", 0) < 90_000 and p.get("clientId") != client_id]
        people.append(
            {
                "clientId": client_id,
                "name": profile.get("name") or "You",
                "color": profile.get("color") or "#d0bcff",
                "room": room,
                "muted": False,
                "deafened": False,
                "seen": now,
                "joinedAt": now,
            }
        )
        voice["participants"] = people
        STORE.save()
    STORE.broadcast_state()
    return voice


def voice_leave(client_id: str) -> dict:
    assert STORE is not None
    with STORE.lock:
        voice = STORE.state.setdefault("chat", {}).setdefault("voice", {"participants": []})
        voice["participants"] = [p for p in voice.get("participants", []) if p.get("clientId") != client_id]
        STORE.save()
    STORE.broadcast_state()
    return voice


def voice_heartbeat(client_id: str) -> dict:
    assert STORE is not None
    now = now_ms()
    with STORE.lock:
        voice = STORE.state.setdefault("chat", {}).setdefault("voice", {"participants": []})
        voice["participants"] = [
            p for p in voice.get("participants", []) if now - p.get("seen", 0) < 90_000
        ]
        for p in voice["participants"]:
            if p.get("clientId") == client_id:
                p["seen"] = now
        STORE.save()
    return voice

def voice_update(client_id: str, patch: dict) -> dict:
    assert STORE is not None
    allowed = {"muted": bool, "deafened": bool, "speaking": bool}
    with STORE.lock:
        voice = STORE.state.setdefault("chat", {}).setdefault("voice", {"participants": []})
        for p in voice.get("participants", []):
            if p.get("clientId") == client_id:
                for key, caster in allowed.items():
                    if key in patch:
                        p[key] = caster(patch[key])
                break
        STORE.save()
    STORE.broadcast_state()
    return voice


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = "KizzeyWeb/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # Keep the terminal quiet; structured events go to the in-app log.
        return

    def end_headers(self):
        # These are added to every response, including SSE and static files.
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(self), geolocation=(self)")
        super().end_headers()

    # -- response helpers -------------------------------------------------
    def send_json(self, data, status: int = 200, headers: dict | None = None):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if headers:
            for key, value in headers.items():
                self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_error_json(self, message: str, status: int = 400, **extra):
        self.send_json({"ok": False, "error": message, **extra}, status=status)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("Request is too large.")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            raise ValueError("Invalid JSON body.")
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object.")
        return data

    def query(self) -> dict:
        parsed = urllib.parse.urlparse(self.path)
        return {k: v[-1] for k, v in urllib.parse.parse_qs(parsed.query).items()}

    def route_path(self) -> str:
        return urllib.parse.urlparse(self.path).path

    # -- routing ----------------------------------------------------------
    def do_GET(self):
        path = self.route_path()
        if path == "/api/state":
            return self.send_json({"ok": True, "state": public_state()})
        if path == "/api/events":
            return self.handle_events()
        if path == "/api/update":
            return self.send_json({"ok": True, "update": update_feed()})
        if path == "/api/hoststats":
            return self.send_json({"ok": True, "stats": host_stats()})
        if path == "/api/weather":
            return self.handle_weather()
        if path == "/api/geocode":
            if offline_mode():
                return self.send_error_json("Offline mode is on. Turn it off in Settings to search places.", 503)
            q = self.query().get("q", "")
            try:
                return self.send_json({"ok": True, "results": geocode(q)})
            except Exception as exc:
                return self.send_error_json(f"Could not search places: {exc}", 502)
        if path == "/api/route":
            if offline_mode():
                return self.send_error_json("Offline mode is on. Turn it off in Settings to calculate routes.", 503)
            return self.handle_route()
        if path == "/api/friends":
            return self.handle_friends()
        if path == "/api/export":
            return self.handle_export()
        if path == "/api/health":
            return self.send_json(
                {
                    "ok": True,
                    "version": VERSION,
                    "ip": get_local_ip(),
                    "device": HOST_DEVICE,
                    "uptime": max(0, int(time.monotonic() - SERVER_STARTED)),
                }
            )
        if path == "/api/logs":
            return self.send_json({"ok": True, "logs": list(STORE.logs) if STORE else []})
        if path == "/api/history":
            return self.send_json(
                {"ok": True, "history": (STORE.state.get("history") or []) if STORE else []}
            )
        if path == "/api/voice":
            return self.send_json(
                {"ok": True, "voice": STORE.state.get("chat", {}).get("voice", {}) if STORE else {}}
            )
        if path.startswith("/api/"):
            return self.send_error_json("Not found.", 404)
        return self.handle_static(path)

    def do_POST(self):
        path = self.route_path()
        try:
            if path == "/api/patch":
                return self.handle_patch()
            if path == "/api/auth/token":
                data = self.read_json()
                token = str(data.get("token") or "")
                try:
                    user = sign_in(token)
                    return self.send_json({"ok": True, "user": user, "state": public_state()})
                except DiscordError as exc:
                    STORE.log("WARN", "Account", f"Discord sign-in failed: {exc.message}")
                    return self.send_error_json(exc.message, exc.status or 401)
            if path == "/api/auth/logout":
                sign_out()
                return self.send_json({"ok": True, "state": public_state()})
            if path == "/api/account/refresh":
                if not STORE.secret.get("token"):
                    return self.send_error_json("Not signed in.", 401)
                try:
                    me = normalize_user(discord_api("/users/@me", STORE.secret["token"]))
                except DiscordError as exc:
                    return self.send_error_json(exc.message, exc.status or 401)
                STORE.state["account"] = me
                STORE.touch()
                STORE.broadcast_state()
                return self.send_json({"ok": True, "user": me, "state": public_state()})
            if path == "/api/gateway/reconnect":
                if not STORE.secret.get("token"):
                    return self.send_error_json("Not signed in.", 401)
                GATEWAY.start(STORE.secret["token"])
                STORE.log("INFO", "Gateway", "Connection restart requested from the web UI.")
                return self.send_json({"ok": True, "state": public_state()})
            if path == "/api/rpc/start":
                data = self.read_json()
                kind = str(data.get("kind") or "custom")
                try:
                    presence = start_presence(kind, data)
                    return self.send_json({"ok": True, "presence": presence, "state": public_state()})
                except DiscordError as exc:
                    return self.send_error_json(exc.message, exc.status or 400, loginRequired=exc.status == 401)
                except ValueError as exc:
                    return self.send_error_json(str(exc), 400)
            if path == "/api/rpc/stop":
                data = self.read_json()
                stopped = stop_presence(data.get("kind") or None)
                return self.send_json({"ok": True, "stopped": stopped, "state": public_state()})
            if path == "/api/rpc/refresh":
                presence = refresh_presence()
                if presence is None:
                    return self.send_error_json("No presence is running.", 409)
                return self.send_json({"ok": True, "presence": presence, "state": public_state()})
            if path == "/api/rpc/preview":
                data = self.read_json()
                kind = str(data.get("kind") or "custom")
                cfg = data.get("config")
                with STORE.lock:
                    if kind == "custom" and isinstance(cfg, dict):
                        merged = dict(STORE.state.get("custom") or {})
                        deep_merge(merged, visible_patch(cfg))
                        activity = build_custom_activity(STORE.state, merged)
                    else:
                        activity = build_activity(STORE.state, kind)
                return self.send_json({"ok": True, "activity": activity})
            if path == "/api/upload":
                return self.handle_upload()
            if path == "/api/image":
                data = self.read_json()
                image = str(data.get("url") or "")
                if offline_mode() and image and not image.startswith(("mp:", "external/", "attachments/")):
                    return self.send_error_json("Offline mode is on. Turn it off in Settings to resolve new Discord artwork.", 503)
                asset = resolve_image_asset(image)
                if not asset:
                    return self.send_error_json("That image could not be resolved.", 422)
                return self.send_json({"ok": True, "asset": asset})
            if path == "/api/ocr":
                return self.handle_ocr()
            if path == "/api/chat/send":
                data = self.read_json()
                msg = chat_send(
                    str(data.get("room") or "lounge"),
                    str(data.get("text") or ""),
                    str(data.get("attach") or ""),
                    data.get("replyTo"),
                )
                return self.send_json({"ok": True, "message": msg})
            if path == "/api/chat/react":
                data = self.read_json()
                msg = chat_react(str(data.get("room") or "lounge"), str(data.get("id") or ""), str(data.get("emoji") or "✨"))
                return self.send_json({"ok": True, "message": msg})
            if path == "/api/chat/upload":
                return self.handle_chat_upload()
            if path == "/api/moments/post":
                data = self.read_json()
                moment = moment_post(str(data.get("text") or ""), str(data.get("tag") or ""))
                return self.send_json({"ok": True, "moment": moment})
            if path == "/api/moments/like":
                data = self.read_json()
                return self.send_json({"ok": True, "moments": moment_like(str(data.get("id") or ""))})
            if path == "/api/wallet/daily":
                try:
                    return self.send_json({"ok": True, **wallet_daily()})
                except ValueError as exc:
                    return self.send_error_json(str(exc), 409)
            if path == "/api/shop/buy":
                data = self.read_json()
                try:
                    return self.send_json({"ok": True, **shop_buy(str(data.get("id") or ""))})
                except ValueError as exc:
                    return self.send_error_json(str(exc), 400)
            if path == "/api/premium/unlock":
                with STORE.lock:
                    profile = STORE.state.setdefault("chatProfile", {})
                    previous = profile.get("badge") if profile.get("badge") != "Plus" else "Member"
                    STORE.state["premium"] = {
                        "tier": "plus",
                        "since": now_ms(),
                        "demo": True,
                        "previousBadge": previous or "Member",
                    }
                    profile["badge"] = "Plus"
                    STORE.save()
                STORE.log("INFO", "Premium", "Local demo premium unlocked.")
                STORE.broadcast_state()
                return self.send_json({"ok": True, "premium": STORE.state["premium"], "state": public_state()})
            if path == "/api/premium/reset":
                with STORE.lock:
                    profile = STORE.state.setdefault("chatProfile", {})
                    previous = (STORE.state.get("premium") or {}).get("previousBadge") or "Member"
                    if profile.get("badge") == "Plus":
                        profile["badge"] = previous
                    STORE.state["premium"] = {"tier": "free", "since": None, "demo": False}
                    STORE.save()
                STORE.log("INFO", "Premium", "Local demo premium turned off.")
                STORE.broadcast_state()
                return self.send_json({"ok": True, "premium": STORE.state["premium"], "state": public_state()})
            if path == "/api/voice/join":
                data = self.read_json()
                return self.send_json(
                    {"ok": True, "voice": voice_join(str(data.get("room") or "lounge"), str(data.get("clientId") or uuid.uuid4().hex))}
                )
            if path == "/api/voice/leave":
                data = self.read_json()
                return self.send_json({"ok": True, "voice": voice_leave(str(data.get("clientId") or ""))})
            if path == "/api/voice/heartbeat":
                data = self.read_json()
                return self.send_json({"ok": True, "voice": voice_heartbeat(str(data.get("clientId") or ""))})
            if path == "/api/voice/state":
                data = self.read_json()
                return self.send_json({"ok": True, "voice": voice_update(str(data.get("clientId") or ""), data)})
            if path == "/api/import":
                return self.handle_import()
            if path == "/api/log":
                data = self.read_json()
                STORE.log(str(data.get("level") or "INFO"), str(data.get("tag") or "Web"), str(data.get("message") or ""))
                return self.send_json({"ok": True})
            if path == "/api/logs/clear":
                with STORE.lock:
                    STORE.logs.clear()
                    STORE.state["logs"] = []
                    STORE.save()
                STORE.log("INFO", "Logs", "In-app log cleared.")
                return self.send_json({"ok": True, "logs": list(STORE.logs)})
            if path == "/api/history/clear":
                with STORE.lock:
                    STORE.history = []
                    STORE.state["history"] = []
                    STORE.save()
                STORE.log("INFO", "History", "Presence history cleared.")
                STORE.broadcast_state()
                return self.send_json({"ok": True, "state": public_state()})
            if path == "/api/bulk/scan":
                return self.handle_bulk(delete=False)
            if path == "/api/bulk/delete":
                return self.handle_bulk(delete=True)
            return self.send_error_json("Not found.", 404)
        except ValueError as exc:
            return self.send_error_json(str(exc), 400)
        except DiscordError as exc:
            return self.send_error_json(exc.message, exc.status or 502)
        except Exception as exc:
            if STORE:
                STORE.log("ERROR", "Web", f"{path}: {exc}")
            return self.send_error_json(_scrub(str(exc)) or "Server error", 500)

    # -- static -----------------------------------------------------------
    def handle_static(self, path: str):
        if path in ("", "/"):
            file = STATIC_DIR / "index.html"
        elif path.startswith("/uploads/"):
            file = UPLOAD_DIR / Path(path).name
        else:
            relative = path.lstrip("/")
            if ".." in Path(relative).parts:
                return self.send_error_json("Not found.", 404)
            file = STATIC_DIR / relative
            if not file.exists() and not Path(relative).suffix:
                file = STATIC_DIR / "index.html"
        if not file.exists() or not file.is_file():
            return self.send_json({"ok": False, "error": "Not found"}, 404)
        try:
            stat = file.stat()
            etag = f'"{int(stat.st_mtime)}-{stat.st_size}"'
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.end_headers()
                return
            mime = MIME_OVERRIDES.get(file.suffix.lower()) or mimetypes.guess_type(file.name)[0] or "application/octet-stream"
            with file.open("rb") as fh:
                raw = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-cache" if file.suffix in (".html", ".js", ".css", ".webmanifest") else "public, max-age=3600")
            self.send_header("ETag", etag)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # -- SSE --------------------------------------------------------------
    def handle_events(self):
        q = STORE.subscribe() if STORE else None
        if not q:
            return self.send_error_json("Server not ready.", 503)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            hello = json.dumps({"type": "hello", "state": public_state()}, ensure_ascii=False)
            self.wfile.write(f"event: state\ndata: {hello}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    event = q.get(timeout=18)
                    raw = json.dumps(event, ensure_ascii=False)
                    self.wfile.write(f"event: {event.get('type', 'message')}\ndata: {raw}\n\n".encode())
                    self.wfile.flush()
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            STORE.unsubscribe(q)

    # -- image / OCR ------------------------------------------------------
    def handle_upload(self):
        data = self.read_json()
        raw = str(data.get("data") or "")
        if not raw.startswith("data:image/"):
            return self.send_error_json("Expected an image data URL.", 400)
        header, _, b64 = raw.partition(",")
        ext = "png"
        if "jpeg" in header or "jpg" in header:
            ext = "jpg"
        elif "gif" in header:
            ext = "gif"
        elif "webp" in header:
            ext = "webp"
        try:
            blob = base64.b64decode(b64, validate=False)
        except Exception:
            return self.send_error_json("That image could not be decoded.", 400)
        if len(blob) > 12 * 1024 * 1024:
            return self.send_error_json("Image is larger than 12 MB.", 413)
        if not blob:
            return self.send_error_json("Empty image.", 400)
        name = uuid.uuid4().hex + "." + ext
        (UPLOAD_DIR / name).write_bytes(blob)
        # Screen captures and other private images stay on this server. Only
        # artwork destined for a Discord card is sent to the image resolver.
        asset = None if data.get("localOnly") is True else upload_image_bytes(blob, name)
        url = "/uploads/" + name
        if STORE:
            STORE.log("INFO", "Images", f"Uploaded {name} ({len(blob) // 1024} KB)" + (" with a Discord asset." if asset else "."))
        return self.send_json(
            {"ok": True, "url": url, "asset": asset, "filename": str(data.get("filename") or name)}
        )

    def handle_chat_upload(self):
        data = self.read_json()
        raw = str(data.get("data") or "")
        if not raw.startswith("data:image/"):
            return self.send_error_json("Expected an image data URL.", 400)
        header, _, b64 = raw.partition(",")
        ext = "png"
        for candidate in ("jpeg", "jpg", "gif", "webp"):
            if candidate in header:
                ext = candidate
                break
        try:
            blob = base64.b64decode(b64)
        except Exception:
            return self.send_error_json("Image could not be decoded.", 400)
        if len(blob) > 8 * 1024 * 1024:
            return self.send_error_json("Images are limited to 8 MB.", 413)
        name = uuid.uuid4().hex + "." + ext
        (UPLOAD_DIR / name).write_bytes(blob)
        return self.send_json({"ok": True, "url": "/uploads/" + name})

    def handle_ocr(self):
        data = self.read_json()
        raw = str(data.get("image") or "")
        if raw.startswith("/uploads/"):
            path = UPLOAD_DIR / Path(raw).name
            temp = path
        elif raw.startswith("data:image/"):
            _, _, b64 = raw.partition(",")
            try:
                blob = base64.b64decode(b64)
            except Exception:
                return self.send_error_json("Could not decode image.", 400)
            fd, temp_name = tempfile.mkstemp(dir=str(TMP_DIR), suffix=".png")
            os.close(fd)
            Path(temp_name).write_bytes(blob)
            path = Path(temp_name)
        else:
            return self.send_error_json("Expected an uploaded image or image data URL.", 400)
        if not path.exists():
            return self.send_error_json("Image not found.", 404)
        tesseract = shutil.which("tesseract")
        if not tesseract:
            return self.send_error_json("OCR is not installed on this server. Install the tesseract package to read screens.", 501)
        try:
            proc = subprocess.run(
                [tesseract, str(path), "stdout", "-l", "eng", "--psm", "6"],
                capture_output=True,
                text=True,
                timeout=35,
            )
            text = proc.stdout.strip()
            if proc.returncode != 0 and not text:
                return self.send_error_json(f"OCR failed: {proc.stderr.strip()[:300]}", 500)
            return self.send_json({"ok": True, "text": text, "chars": len(text)})
        finally:
            if raw.startswith("data:image/"):
                try:
                    path.unlink(missing_ok=True)
                except Exception:
                    pass

    # -- weather / navigation --------------------------------------------
    def handle_weather(self):
        if offline_mode():
            return self.send_error_json("Offline mode is on. Turn it off in Settings to load weather.", 503)
        q = self.query()
        try:
            lat = float(q.get("lat", "51.5072"))
            lon = float(q.get("lon", "-0.1276"))
        except ValueError:
            return self.send_error_json("Invalid coordinates.", 400)
        unit = q.get("unit", "c").lower()
        try:
            weather = fetch_weather(lat, lon, unit)
            if STORE:
                with STORE.lock:
                    STORE.state.setdefault("weather", {})["last"] = weather
                    STORE.save()
                STORE.publish({"type": "weather", "weather": weather})
            return self.send_json({"ok": True, "weather": weather})
        except Exception as exc:
            return self.send_error_json(f"Weather is unavailable: {exc}", 502)

    def handle_route(self):
        q = self.query()
        try:
            lat1, lon1 = float(q.get("lat1")), float(q.get("lon1"))
            lat2, lon2 = float(q.get("lat2")), float(q.get("lon2"))
        except (TypeError, ValueError):
            return self.send_error_json("Origin and destination coordinates are required.", 400)
        url = (
            "https://router.project-osrm.org/route/v1/driving/"
            f"{lon1:.6f},{lat1:.6f};{lon2:.6f},{lat2:.6f}?overview=false&alternatives=false&steps=false"
        )
        try:
            data = http_json(url, timeout=20)
            route = (data.get("routes") or [{}])[0]
            distance = float(route.get("distance") or 0)
            duration = float(route.get("duration") or 0)
            return self.send_json(
                {
                    "ok": True,
                    "distance": distance,
                    "duration": duration,
                    "distanceText": f"{distance / 1000:.1f} km",
                    "durationText": f"{round(duration / 60)} min",
                    "name": q.get("name", "Destination"),
                }
            )
        except Exception as exc:
            return self.send_error_json(f"Could not calculate a route: {exc}", 502)

    def handle_friends(self):
        assert STORE is not None
        if not STORE.secret.get("token"):
            return self.send_json({"ok": True, "friends": [], "signedIn": False})
        try:
            rows = discord_api("/users/@me/relationships", STORE.secret["token"])
            friends = [normalize_relationship(r) for r in (rows or []) if isinstance(r, dict)]
            friends = [f for f in friends if f.get("user", {}).get("username")]
            return self.send_json({"ok": True, "friends": friends, "signedIn": True})
        except DiscordError as exc:
            return self.send_error_json(exc.message, exc.status or 502)

    # -- backup / import --------------------------------------------------
    def handle_export(self):
        assert STORE is not None
        with STORE.lock:
            payload = {
                "format": "kizzey-web-backup",
                "version": VERSION,
                "exportedAt": now_iso(),
                "state": {k: v for k, v in STORE.state.items() if k not in ("account", "gateway", "presence", "logs", "history", "tokenSet", "tokenHint", "serverTime")},
                "savedConfigs": STORE.state.get("savedConfigs", []),
            }
        raw = json.dumps(payload, ensure_ascii=False, indent=2).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Disposition", f'attachment; filename="kizzey-web-{dt.date.today().isoformat()}.json"')
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def handle_import(self):
        data = self.read_json()
        payload = data.get("backup") if isinstance(data.get("backup"), dict) else data
        incoming = payload.get("state") if isinstance(payload.get("state"), dict) else payload
        if not isinstance(incoming, dict):
            return self.send_error_json("That backup does not contain a state object.", 400)
        with STORE.lock:
            for key, value in visible_patch(incoming).items():
                if key in ("settings", "custom", "apps", "media", "console", "experimental", "cycling", "multiple", "health", "location", "weather", "navigation", "androidAuto", "samsung", "emulation", "screenRead", "automation", "drawer", "chatProfile", "wallet", "premium", "quickControls", "ui", "recent", "usage", "savedConfigs", "bulk", "plugins", "gallery", "appCatalog"):
                    if isinstance(value, dict) and isinstance(STORE.state.get(key), dict):
                        deep_merge(STORE.state[key], value)
                    else:
                        STORE.state[key] = value
            STORE.save()
        STORE.log("INFO", "Backup", "Settings imported from a backup.")
        STORE.broadcast_state()
        return self.send_json({"ok": True, "state": public_state()})

    # -- patch ------------------------------------------------------------
    def handle_patch(self):
        data = self.read_json()
        updates = data.get("updates") if isinstance(data.get("updates"), dict) else data
        updates = visible_patch(updates)
        if not updates:
            return self.send_error_json("Nothing to update.", 400)
        with STORE.lock:
            for key, value in updates.items():
                if key in ("settings", "custom", "apps", "media", "console", "experimental", "cycling", "multiple", "health", "location", "weather", "navigation", "androidAuto", "samsung", "emulation", "screenRead", "automation", "drawer", "chatProfile", "wallet", "quickControls", "ui", "recent", "usage", "savedConfigs", "bulk", "plugins", "gallery", "appCatalog"):
                    if isinstance(value, dict) and isinstance(STORE.state.get(key), dict):
                        deep_merge(STORE.state[key], value)
                    else:
                        STORE.state[key] = value
                elif key == "premium":
                    # premium is only changed through the local unlock endpoint
                    continue
            STORE.save()
        STORE.publish({"type": "state", "state": public_state()})
        return self.send_json({"ok": True, "state": public_state()})

    # -- bulk message removal --------------------------------------------
    def handle_bulk(self, delete: bool = False):
        assert STORE is not None
        if not STORE.secret.get("token"):
            return self.send_error_json("Sign in to Discord first.", 401)
        data = self.read_json()
        if delete:
            ids = data.get("ids") or []
            if not isinstance(ids, list):
                return self.send_error_json("ids must be a list.", 400)
            if data.get("confirm") != "DELETE":
                return self.send_error_json('Type DELETE in the confirmation box.', 400)
            if len(ids) > 100:
                return self.send_error_json("Delete at most 100 messages at once.", 400)
            channel = str(data.get("channel") or "").strip()
            if not re.fullmatch(r"\d{5,25}", channel):
                return self.send_error_json("Enter a valid channel ID.", 400)
            deleted = 0
            failed = []
            for mid in ids[:100]:
                try:
                    discord_api(f"/channels/{channel}/messages/{mid}", STORE.secret["token"], method="DELETE")
                    deleted += 1
                    time.sleep(0.55)
                except DiscordError as exc:
                    failed.append({"id": mid, "error": exc.message})
            STORE.log("INFO", "Bulk", f"Deleted {deleted} message(s) from the user's own account.")
            return self.send_json({"ok": True, "deleted": deleted, "failed": failed})
        channel = str(data.get("channel") or "").strip()
        if not re.fullmatch(r"\d{5,25}", channel):
            return self.send_error_json("Enter a valid channel ID.", 400)
        limit = int(clamp(safe_int(data.get("limit"), 100) or 100, 1, 500))
        query = str(data.get("query") or "").strip().lower()
        me = (STORE.state.get("account") or {}).get("id") or ""
        try:
            messages = []
            before = None
            while len(messages) < limit:
                qs = f"?limit={min(100, limit - len(messages))}"
                if before:
                    qs += f"&before={before}"
                rows = discord_api(f"/channels/{channel}/messages{qs}", STORE.secret["token"]) or []
                if not rows:
                    break
                before = rows[-1].get("id")
                messages.extend(rows)
                if len(rows) < 100:
                    break
            mine = []
            for m in messages:
                if not isinstance(m, dict):
                    continue
                author = m.get("author") or {}
                if str(author.get("id")) != me:
                    continue
                content = str(m.get("content") or "")
                if query and query not in content.lower():
                    continue
                mine.append(
                    {
                        "id": m.get("id"),
                        "content": content[:400],
                        "time": m.get("timestamp"),
                        "attachments": len(m.get("attachments") or []),
                        "pinned": bool(m.get("pinned")),
                    }
                )
            return self.send_json(
                {"ok": True, "messages": mine[:100], "scanned": len(messages), "channel": channel}
            )
        except DiscordError as exc:
            return self.send_error_json(exc.message, exc.status or 502)


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------


def build_server(host: str, port: int) -> ThreadingHTTPServer:
    class Server(ThreadingHTTPServer):
        allow_reuse_address = True
        daemon_threads = True

        def handle_error(self, request, client_address):
            exc = sys.exc_info()[1]
            if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
                return
            super().handle_error(request, client_address)

    httpd = Server((host, port), Handler)
    return httpd


def banner(host: str, port: int) -> None:
    ip = get_local_ip()
    print()
    print("  ✦ Kizzey Web")
    print(f"  version {VERSION} · Python {platform.python_version()}")
    print(f"  http://127.0.0.1:{port}")
    if host in ("0.0.0.0", "::"):
        print(f"  http://{ip}:{port}   (LAN)")
    print("  Your Discord token stays on this server. Ctrl+C to stop.")
    print()


def main() -> int:
    global STORE
    parser = argparse.ArgumentParser(description="Kizzey Web — Discord Rich Presence for your browser")
    parser.add_argument("--host", default=os.environ.get("KIZZEY_HOST", "0.0.0.0"), help="Bind address (default 0.0.0.0)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("KIZZEY_PORT", DEFAULT_PORT)), help="Port (default 8420)")
    parser.add_argument("--no-gateway", action="store_true", help="Do not auto-connect to Discord on startup")
    args = parser.parse_args()

    STORE = Store()
    STORE.log("INFO", "Server", f"Kizzey Web {VERSION} starting on {args.host}:{args.port}.")
    if STORE.secret.get("token") and not args.no_gateway:
        try:
            me = validate_token(STORE.secret["token"])
            STORE.state["account"] = me
            STORE.log("INFO", "Account", f"Restored Discord session for {me['displayName']}.")
            if STORE.state.get("settings", {}).get("autoStart", True):
                GATEWAY.start(STORE.secret["token"])
        except Exception as exc:
            STORE.log("WARN", "Account", f"Saved Discord session could not be restored: {exc}")
            with STORE.lock:
                STORE.secret["token"] = ""
                STORE.state["account"] = None
                STORE.state["gateway"]["error"] = str(exc)
            STORE.save()
    if STORE.state.get("presence", {}).get("active"):
        # A previous server run did not stop its presence; start clean.
        STORE.state["presence"] = {"active": None, "startedAt": None, "activities": [], "updatedAt": now_ms()}
        STORE.save()
    TICKER.start()

    try:
        httpd = build_server(args.host, args.port)
    except OSError as exc:
        print(f"Could not bind {args.host}:{args.port}: {exc}", file=sys.stderr)
        return 1
    banner(args.host, args.port)
    try:
        httpd.serve_forever(poll_interval=0.4)
    except KeyboardInterrupt:
        print("\n  Stopping…")
    finally:
        try:
            GATEWAY.send_presence(None)
            GATEWAY.stop()
        except Exception:
            pass
        httpd.server_close()
        if STORE:
            STORE.save()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
