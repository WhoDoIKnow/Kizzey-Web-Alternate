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
import copy
import datetime as dt
import hashlib
import json
import mimetypes
import os
import platform
import queue
import random
import re
import secrets
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

MAX_BODY = 64 * 1024 * 1024
MAX_CHAT = 250
ACCOUNT_LIMIT = 8
MIRROR_RULE_LIMIT = 20
MIRROR_SEEN_LIMIT = 180
MIRROR_MARK = "\u2063"
MIRROR_DEFAULT_INTERVAL = 12
MIRROR_MAX_MESSAGES = 30
MIRROR_MODES = ("normal", "webhook")
MIRROR_WEBHOOK_LOCK = threading.RLock()
SERVER_STARTED = time.monotonic()

# Discord sign-in posts the operator's own credentials straight to Discord from
# the machine running this server. Nothing is stored but the resulting token.
DISCORD_LOGIN_API = "https://discord.com/api/v9/auth/login"
DISCORD_MFA_API = "https://discord.com/api/v9/auth/mfa/totp"
DISCORD_LOGIN_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

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
    tokens: list[str] = []
    try:
        if STORE is not None:
            if STORE.secret.get("token"):
                tokens.append(str(STORE.secret["token"]))
            for account in STORE.secret.get("accounts", []) or []:
                if isinstance(account, dict) and account.get("token"):
                    tokens.append(str(account["token"]))
            webhooks = STORE.secret.get("mirrorWebhooks")
            if isinstance(webhooks, dict):
                for webhook in webhooks.values():
                    if isinstance(webhook, dict) and webhook.get("token"):
                        tokens.append(str(webhook["token"]))
    except Exception:
        pass
    for token in sorted(set(tokens), key=len, reverse=True):
        if len(token) > 8:
            text = text.replace(token, "••••••••")
    text = re.sub(r"[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}", "••••••••", text)
    text = re.sub(
        r"https://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9_.-]+",
        "••••••••",
        text,
    )
    return text


def safe_auth_error(message: str, token: str = "") -> str:
    text = _scrub(message)
    submitted = clean_discord_token(token)
    if submitted:
        text = text.replace(submitted, "••••••••")
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


def default_gateway_record() -> dict:
    """One gateway slot per account. `state["gateway"]` mirrors the focused one."""
    return {
        "connected": False,
        "state": "offline",
        "latency": None,
        "error": "",
        "reconnects": 0,
        "since": None,
        "tokenSet": False,
    }


def empty_presence() -> dict:
    """One Rich Presence slot per account."""
    return {
        "active": None,
        "startedAt": None,
        "updatedAt": None,
        "activities": [],
        "info": {},
        "cycleIndex": 0,
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
        "gateway": default_gateway_record(),
        "gateways": {},
        "presence": empty_presence(),
        "presences": {},
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
        "mirror": {
            "enabled": False,
            "interval": MIRROR_DEFAULT_INTERVAL,
            "rules": [],
            "lastRunAt": None,
            "lastError": "",
        },
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


def clean_discord_token(token: str) -> str:
    token = str(token or "").strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    return token


def _account_public(account: dict) -> dict:
    user = account.get("user") if isinstance(account.get("user"), dict) else {}
    display = str(user.get("displayName") or user.get("globalName") or user.get("username") or "Discord account")
    token = clean_discord_token(account.get("token"))
    auth_kind = "token" if token else "none"
    return {
        "id": str(account.get("id") or ""),
        "userId": str(user.get("id") or ""),
        "username": str(user.get("username") or ""),
        "displayName": display,
        "avatar": str(user.get("avatar") or ""),
        "avatarUrl": str(user.get("avatarUrl") or ""),
        "tokenSet": bool(token),
        "authKind": auth_kind,
        "canGateway": bool(token) and not bool(account.get("needsAuth")),
        "needsAuth": bool(account.get("needsAuth")),
        "authError": _scrub(str(account.get("authError") or ""))[:220],
        "addedAt": account.get("addedAt"),
        "lastUsedAt": account.get("lastUsedAt"),
    }


def _mirror_bool(value, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("true", "1", "yes", "on"):
            return True
        if lowered in ("false", "0", "no", "off"):
            return False
    return default


def _snowflake_text(value, limit: int = 32) -> str:
    text = str(value or "").strip()
    return text if text.isdigit() and len(text) <= limit else ""


def normalize_mirror_mode(value) -> str:
    mode = str(value or "").strip().lower()
    return mode if mode in MIRROR_MODES else "normal"


def _coerce_mirror_webhook(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    webhook_id = _snowflake_text(raw.get("id"))
    channel_id = _snowflake_text(raw.get("channelId"))
    token = str(raw.get("token") or "").strip()
    if not webhook_id or not channel_id or not token:
        return None
    if len(token) > 200 or not re.fullmatch(r"[A-Za-z0-9_.-]{10,200}", token):
        return None
    name = str(raw.get("name") or "Kizzey mirror").strip()[:80] or "Kizzey mirror"
    created = raw.get("createdAt")
    if not isinstance(created, (int, float)):
        created = now_ms()
    return {
        "id": webhook_id,
        "token": token,
        "channelId": channel_id,
        "name": name,
        "createdAt": created,
    }


def _nonneg_int(value, default: int = 0, cap: int = 1_000_000_000) -> int:
    try:
        number = int(float(value))
    except Exception:
        return default
    return max(0, min(cap, number))


def _default_mirror_state() -> dict:
    return {
        "enabled": False,
        "interval": MIRROR_DEFAULT_INTERVAL,
        "rules": [],
        "lastRunAt": None,
        "lastError": "",
    }


def normalize_mirror_rule(raw: dict, *, fresh: bool = False) -> dict | None:
    if not isinstance(raw, dict):
        return None
    rule_id = str(raw.get("id") or "").strip()
    if not rule_id.startswith("mirror_") or len(rule_id) > 40:
        rule_id = "mirror_" + uuid.uuid4().hex[:12]
    source_account = str(raw.get("sourceAccountId") or "").strip()[:64]
    dest_account = str(raw.get("destAccountId") or "").strip()[:64]
    source_channel = _snowflake_text(raw.get("sourceChannel"))
    dest_channel = _snowflake_text(raw.get("destChannel"))
    if not source_account or not dest_account or not source_channel or not dest_channel:
        return None
    if source_channel == dest_channel:
        return None
    now = now_ms()
    name = str(raw.get("name") or "").strip()[:80]
    source_label = str(raw.get("sourceLabel") or "").strip()[:120]
    dest_label = str(raw.get("destLabel") or "").strip()[:120]
    rule = {
        "id": rule_id,
        "name": name or "Message relay",
        "enabled": _mirror_bool(raw.get("enabled"), True),
        "sourceAccountId": source_account,
        "sourceChannel": source_channel,
        "sourceLabel": source_label or ("#" + source_channel),
        "destAccountId": dest_account,
        "destChannel": dest_channel,
        "destLabel": dest_label or ("#" + dest_channel),
        "mode": normalize_mirror_mode(raw.get("mode")),
        "includeOwn": _mirror_bool(raw.get("includeOwn"), False),
        "includeBots": _mirror_bool(raw.get("includeBots"), False),
        "includeAttachments": _mirror_bool(raw.get("includeAttachments"), True),
        "includeEmbeds": _mirror_bool(raw.get("includeEmbeds"), True),
        "primed": _mirror_bool(raw.get("primed"), False),
        "lastSeenId": _snowflake_text(raw.get("lastSeenId")),
        "lastRunAt": raw.get("lastRunAt") if isinstance(raw.get("lastRunAt"), (int, float)) else None,
        "lastMirroredAt": raw.get("lastMirroredAt") if isinstance(raw.get("lastMirroredAt"), (int, float)) else None,
        "lastError": str(raw.get("lastError") or "")[:260],
        "mirrored": _nonneg_int(raw.get("mirrored")),
        "skipped": _nonneg_int(raw.get("skipped")),
        "failures": _nonneg_int(raw.get("failures")),
        "retryAfter": _nonneg_int(raw.get("retryAfter"), cap=10**15),
        "createdAt": raw.get("createdAt") if isinstance(raw.get("createdAt"), (int, float)) else now,
        "updatedAt": raw.get("updatedAt") if isinstance(raw.get("updatedAt"), (int, float)) else now,
    }
    if fresh:
        rule["primed"] = False
        rule["lastSeenId"] = ""
        rule["lastError"] = ""
        rule["mirrored"] = 0
        rule["skipped"] = 0
        rule["failures"] = 0
        rule["retryAfter"] = 0
        rule["lastMirroredAt"] = None
        rule["createdAt"] = now
    return rule


def normalize_mirror_state(raw) -> dict:
    state = _default_mirror_state()
    if not isinstance(raw, dict):
        return state
    state["enabled"] = _mirror_bool(raw.get("enabled"), False)
    try:
        state["interval"] = int(clamp(int(raw.get("interval") or MIRROR_DEFAULT_INTERVAL), 5, 300))
    except Exception:
        state["interval"] = MIRROR_DEFAULT_INTERVAL
    state["lastRunAt"] = raw.get("lastRunAt") if isinstance(raw.get("lastRunAt"), (int, float)) else None
    state["lastError"] = str(raw.get("lastError") or "")[:260]
    rules = []
    seen = set()
    for item in (raw.get("rules") if isinstance(raw.get("rules"), list) else [])[:MIRROR_RULE_LIMIT]:
        rule = normalize_mirror_rule(item)
        if not rule or rule["id"] in seen:
            continue
        rules.append(rule)
        seen.add(rule["id"])
    state["rules"] = rules
    return state


def prepare_imported_mirror(value) -> tuple[dict, list[str]]:
    """Imported relays never run until the operator reviews them."""
    mirror = normalize_mirror_state(value)
    raw_rules = value.get("rules") if isinstance(value, dict) else []
    raw_count = len(raw_rules) if isinstance(raw_rules, list) else 0
    mirror["enabled"] = False
    mirror["lastError"] = ""
    mirror["lastRunAt"] = None
    for rule in mirror.get("rules", []):
        rule["enabled"] = False
        rule["lastError"] = "Imported paused. Review the relay, then enable it."
    notes = []
    if mirror.get("rules"):
        count = len(mirror["rules"])
        notes.append(
            f"{count} message mirror rule{'s were' if count != 1 else ' was'} imported paused."
        )
    dropped = max(0, raw_count - len(mirror.get("rules", [])))
    if dropped:
        notes.append(f"{dropped} malformed message mirror rule{'s were' if dropped != 1 else ' was'} dropped.")
    return mirror, notes


def _coerce_account_record(raw: dict, fallback_token: str = "", fallback_at=None) -> dict | None:
    if not isinstance(raw, dict):
        return None
    user = raw.get("user") if isinstance(raw.get("user"), dict) else {}
    flat = {
        "id": raw.get("userId") or raw.get("id_") or "",
        "username": raw.get("username") or "",
        "globalName": raw.get("globalName") or "",
        "displayName": raw.get("displayName") or "",
        "avatar": raw.get("avatar") or "",
        "avatarUrl": raw.get("avatarUrl") or "",
    }
    merged_user = dict(user)
    for key, value in flat.items():
        if value and not merged_user.get(key):
            merged_user[key] = value
    token = clean_discord_token(raw.get("token") or fallback_token)
    uid = str(merged_user.get("id") or raw.get("userId") or "")
    username = str(merged_user.get("username") or "")
    display = str(
        merged_user.get("displayName")
        or merged_user.get("globalName")
        or username
        or "Discord account"
    )
    avatar = str(merged_user.get("avatar") or "")
    avatar_url = str(merged_user.get("avatarUrl") or "")
    if not avatar_url and uid:
        if avatar:
            ext = "gif" if avatar.startswith("a_") else "png"
            avatar_url = f"https://cdn.discordapp.com/avatars/{uid}/{avatar}.{ext}?size=128"
        else:
            try:
                index = (int(uid) >> 22) % 6
            except Exception:
                index = 0
            avatar_url = f"https://cdn.discordapp.com/embed/avatars/{index}.png"
    merged_user.update({
        "id": uid,
        "username": username,
        "globalName": str(merged_user.get("globalName") or ""),
        "displayName": display,
        "avatar": avatar,
        "avatarUrl": avatar_url,
        "email": "",
    })
    if not token and not uid and not username:
        return None
    account_id = str(raw.get("id") or "")
    if not account_id.startswith("acct_") or len(account_id) < 8:
        account_id = "acct_" + uuid.uuid4().hex[:12]
    now = now_ms()
    return {
        "id": account_id,
        "token": token,
        "tokenSetAt": raw.get("tokenSetAt") if token else None,
        "authKind": "token" if token else "none",
        "addedAt": raw.get("addedAt") or fallback_at or now,
        "lastUsedAt": raw.get("lastUsedAt"),
        "needsAuth": bool(raw.get("needsAuth")) or not token,
        "authError": str(raw.get("authError") or "")[:220],
        "user": merged_user,
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
        if not isinstance(self.state, dict):
            self.state = default_state()
        if not isinstance(self.secret, dict):
            self.secret = {"token": "", "tokenSetAt": None}
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
        self.state["presence"] = empty_presence()
        self.state["presences"] = {}
        self.state["gateway"] = default_gateway_record()
        self.state["gateways"] = {}
        self.state["mirror"] = normalize_mirror_state(self.state.get("mirror"))
        raw_webhooks = self.secret.get("mirrorWebhooks")
        webhooks = {}
        if isinstance(raw_webhooks, dict):
            for rule_id, raw in raw_webhooks.items():
                record = _coerce_mirror_webhook(raw)
                if record and str(rule_id).startswith("mirror_"):
                    webhooks[str(rule_id)] = record
        self.secret["mirrorWebhooks"] = webhooks
        self.state["version"] = VERSION
        self.state["logs"] = []
        self._normalize_accounts()
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

    # -- accounts --------------------------------------------------------
    def _normalize_accounts(self) -> None:
        """Migrate the single-token file into a private account list."""
        with self.lock:
            raw_accounts = self.secret.get("accounts")
            if not isinstance(raw_accounts, list):
                raw_accounts = []
            accounts: list[dict] = []
            by_user: dict[str, dict] = {}
            by_token: dict[str, dict] = {}
            for raw in raw_accounts:
                account = _coerce_account_record(raw)
                if not account:
                    continue
                user_id = str(account["user"].get("id") or "")
                token = str(account.get("token") or "")
                existing = by_user.get(user_id) if user_id else None
                if not existing and token:
                    existing = by_token.get(token)
                if existing:
                    if token:
                        existing["token"] = token
                        existing["tokenSetAt"] = account.get("tokenSetAt") or existing.get("tokenSetAt")
                        existing["needsAuth"] = False
                        existing["authError"] = ""
                        by_token[token] = existing
                    if account.get("lastUsedAt"):
                        existing["lastUsedAt"] = account.get("lastUsedAt")
                    existing["user"].update({k: v for k, v in account["user"].items() if v})
                    continue
                accounts.append(account)
                if user_id:
                    by_user[user_id] = account
                if token:
                    by_token[token] = account

            legacy_token = clean_discord_token(self.secret.get("token") or "")
            legacy_user = self.state.get("account") if isinstance(self.state.get("account"), dict) else {}
            if legacy_token and legacy_token not in by_token:
                legacy_id = str(legacy_user.get("id") or "")
                match = by_user.get(legacy_id) if legacy_id else None
                if match:
                    match["token"] = legacy_token
                    match["tokenSetAt"] = self.secret.get("tokenSetAt") or now_ms()
                    match["needsAuth"] = False
                    match["authError"] = ""
                    by_token[legacy_token] = match
                else:
                    account = _coerce_account_record(
                        {
                            "token": legacy_token,
                            "tokenSetAt": self.secret.get("tokenSetAt"),
                            "addedAt": self.secret.get("tokenSetAt") or now_ms(),
                            "user": legacy_user,
                        }
                    )
                    if account:
                        accounts.append(account)
                        by_token[legacy_token] = account
                        if account["user"].get("id"):
                            by_user[str(account["user"]["id"])] = account

            if len(accounts) > ACCOUNT_LIMIT:
                active_hint = str(self.secret.get("activeId") or "")
                keep = [
                    account for account in accounts[:ACCOUNT_LIMIT]
                ]
                if active_hint:
                    active_record = next((account for account in accounts if account["id"] == active_hint), None)
                    if active_record and active_record not in keep:
                        keep[-1] = active_record
                accounts = keep

            active_id = str(self.secret.get("activeId") or "")
            active = next((account for account in accounts if account["id"] == active_id), None)
            if not active and legacy_token:
                active = by_token.get(legacy_token)
            if not active or not clean_discord_token(active.get("token")):
                active = next(
                    (account for account in accounts if clean_discord_token(account.get("token"))),
                    None,
                )
            if active:
                self.secret["activeId"] = active["id"]
                self.secret["token"] = clean_discord_token(active.get("token"))
                self.secret["tokenSetAt"] = active.get("tokenSetAt") if self.secret["token"] else None
                self.state["account"] = copy.deepcopy(active["user"])
                if clean_discord_token(active.get("token")):
                    self.secret["authError"] = ""
            else:
                self.secret["activeId"] = ""
                self.secret["token"] = ""
                self.secret["tokenSetAt"] = None
                self.state["account"] = None
            self.secret["accounts"] = accounts
            self.state["gateway"] = self.state.get("gateway") or {}
            self.state["gateway"]["tokenSet"] = bool(self.secret.get("token"))
            self.secret.setdefault("authError", "")

    def public_accounts(self) -> list[dict]:
        with self.lock:
            return [_account_public(account) for account in self.secret.get("accounts", []) or []]

    def active_account_id(self) -> str:
        with self.lock:
            active_id = str(self.secret.get("activeId") or "")
            for account in self.secret.get("accounts", []) or []:
                if account.get("id") == active_id and clean_discord_token(account.get("token")):
                    return active_id
            return ""

    def active_account(self, include_token: bool = False) -> dict | None:
        with self.lock:
            active_id = str(self.secret.get("activeId") or "")
            for account in self.secret.get("accounts", []) or []:
                if account.get("id") == active_id:
                    result = copy.deepcopy(account)
                    if not include_token:
                        result.pop("token", None)
                    return result
            return None

    def account_by_id(self, account_id: str, include_token: bool = False) -> dict | None:
        account_id = str(account_id or "")
        with self.lock:
            for account in self.secret.get("accounts", []) or []:
                if account.get("id") == account_id:
                    result = copy.deepcopy(account)
                    if not include_token:
                        result.pop("token", None)
                    return result
            return None

    def active_token(self) -> str:
        with self.lock:
            account = self.active_account(include_token=True)
            if account and clean_discord_token(account.get("token")):
                return clean_discord_token(account.get("token"))
            # A designated but credential-less account must never fall through
            # to the legacy compatibility token of a different identity.
            if str(self.secret.get("activeId") or ""):
                return ""
            return clean_discord_token(self.secret.get("token") or "")

    def upsert_account(self, token: str, user: dict) -> tuple[dict, bool]:
        token = clean_discord_token(token)
        if not token:
            raise ValueError("Paste a Discord account token first.")
        user = dict(user or {})
        user_id = str(user.get("id") or "")
        with self.lock:
            accounts = self.secret.setdefault("accounts", [])
            existing = None
            for account in accounts:
                if user_id and str((account.get("user") or {}).get("id") or "") == user_id:
                    existing = account
                    break
                if clean_discord_token(account.get("token")) == token:
                    existing = account
                    break
            if existing is None:
                if len(accounts) >= ACCOUNT_LIMIT:
                    raise ValueError(f"You can save up to {ACCOUNT_LIMIT} Discord accounts.")
                existing = _coerce_account_record({"token": token, "user": user})
                if existing is None:
                    raise ValueError("Discord did not return a usable account.")
                accounts.append(existing)
                created = True
            else:
                created = False
                old_token = clean_discord_token(existing.get("token"))
                existing["token"] = token
                if old_token != token or not existing.get("tokenSetAt"):
                    existing["tokenSetAt"] = now_ms()
                existing["user"] = {**(existing.get("user") or {}), **user, "email": ""}
                existing["authKind"] = "token"
                existing["needsAuth"] = False
                existing["authError"] = ""
            self.save()
            return copy.deepcopy(existing), created

    def activate_account(self, account_id: str, user: dict | None = None) -> dict:
        with self.lock:
            account = next(
                (row for row in self.secret.get("accounts", []) or [] if row.get("id") == account_id),
                None,
            )
            if not account or not clean_discord_token(account.get("token")):
                raise ValueError("That account has no saved token. Add it again.")
            token = clean_discord_token(account.get("token"))
            if user:
                account["user"] = {**(account.get("user") or {}), **user, "email": ""}
            account["needsAuth"] = False
            account["authError"] = ""
            account["lastUsedAt"] = now_ms()
            self.secret["activeId"] = account["id"]
            self.secret["token"] = token
            self.secret["tokenSetAt"] = account.get("tokenSetAt") if token else None
            self.secret["authError"] = ""
            self.state["account"] = copy.deepcopy(account.get("user") or {})
            gateway = self.state.setdefault("gateway", {})
            gateway["tokenSet"] = bool(token)
            gateway["error"] = ""
            self.save()
            return copy.deepcopy(account)

    def mark_account_auth_failed(self, account_id: str, message: str) -> None:
        with self.lock:
            account = next(
                (row for row in self.secret.get("accounts", []) or [] if row.get("id") == account_id),
                None,
            )
            safe = safe_auth_error(
                message or "Discord rejected this token.",
                clean_discord_token((account or {}).get("token")),
            )[:220]
            if account:
                account["token"] = ""
                account["tokenSetAt"] = None
                account["needsAuth"] = True
                account["authError"] = safe
            if str(self.secret.get("activeId") or "") == account_id:
                self.secret["token"] = ""
                self.secret["tokenSetAt"] = None
                self.secret["activeId"] = ""
                self.secret["authError"] = safe
                self.state["account"] = None
                gateway = self.state.setdefault("gateway", {})
                gateway["tokenSet"] = False
                gateway["error"] = safe
            self.save()

    def remove_account(self, account_id: str) -> dict | None:
        with self.lock:
            accounts = self.secret.get("accounts", []) or []
            removed = next((row for row in accounts if row.get("id") == account_id), None)
            if not removed:
                return None
            was_active = str(self.secret.get("activeId") or "") == account_id
            self.secret["accounts"] = [row for row in accounts if row.get("id") != account_id]
            rules = self.state.setdefault("mirror", {}).get("rules", []) or []
            for rule in rules:
                if account_id in (rule.get("sourceAccountId"), rule.get("destAccountId")):
                    rule["enabled"] = False
                    rule["lastError"] = "A Discord account used by this rule was removed."
            if was_active:
                next_account = next(
                    (row for row in self.secret["accounts"] if clean_discord_token(row.get("token"))),
                    None,
                )
                if next_account:
                    self.secret["activeId"] = next_account["id"]
                    self.secret["token"] = clean_discord_token(next_account.get("token"))
                    self.secret["tokenSetAt"] = next_account.get("tokenSetAt")
                    self.secret["authError"] = ""
                    self.state["account"] = copy.deepcopy(next_account.get("user") or {})
                    self.state["gateway"]["tokenSet"] = True
                else:
                    self.secret["activeId"] = ""
                    self.secret["token"] = ""
                    self.secret["tokenSetAt"] = None
                    self.secret["authError"] = ""
                    self.state["account"] = None
                    self.state["gateway"]["tokenSet"] = False
            self.save()
            return {
                "removed": _account_public(removed),
                "wasActive": was_active,
                "nextId": str(self.secret.get("activeId") or ""),
            }

    def remove_all_accounts(self) -> int:
        with self.lock:
            count = len(self.secret.get("accounts", []) or [])
            self.secret["accounts"] = []
            self.secret["activeId"] = ""
            self.secret["token"] = ""
            self.secret["tokenSetAt"] = None
            self.secret["authError"] = ""
            self.state["account"] = None
            self.state["gateway"]["tokenSet"] = False
            for rule in self.state.setdefault("mirror", {}).get("rules", []) or []:
                rule["enabled"] = False
                rule["lastError"] = "No Discord account is available."
            self.save()
            return count

    # -- focused-account mirror ------------------------------------------
    def sync_focused(self) -> None:
        """Point the legacy single-account slots at the focused account.

        `state["gateway"]` and `state["presence"]` still drive the UI, but the real
        records live per account in `state["gateways"]` / `state["presences"]`.
        """
        with self.lock:
            account_id = str(self.secret.get("activeId") or "")
            gateways = self.state.setdefault("gateways", {})
            presences = self.state.setdefault("presences", {})
            record = copy.deepcopy(gateways.get(account_id) or default_gateway_record())
            record["tokenSet"] = bool(self.active_token())
            if not account_id:
                record["connected"] = False
            self.state["gateway"] = record
            self.state["presence"] = copy.deepcopy(presences.get(account_id) or empty_presence())

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
    STORE.sync_focused()
    with STORE.lock:
        # Tokens live only in secret.json and are never handed to the browser.
        data = json.loads(json.dumps(STORE.state, ensure_ascii=False))
        accounts = STORE.public_accounts()
        data["accounts"] = accounts
        data["mirror"] = public_mirror_state()
        data["accountCount"] = len(accounts)
        data["accountLimit"] = ACCOUNT_LIMIT
        data["mirrorRuleLimit"] = MIRROR_RULE_LIMIT
        data["activeAccountId"] = STORE.active_account_id()
        data["tokenSet"] = bool(STORE.active_token())
        data["serverTime"] = now_ms()
        data["version"] = VERSION
        data["gateway"]["tokenSet"] = bool(STORE.active_token())
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
    "accounts",
    "accountCount",
    "activeAccountId",
    "gateway",
    "gateways",
    "presence",
    "presences",
    "history",
    "logs",
    "version",
    "host",
    "device",
    "startedAt",
    "startedIso",
    "firstRun",
    "chat",
    "mirror",
    "tokenSet",
    "tokenHint",
    "serverTime",
}


def visible_patch(obj: dict) -> dict:
    if not isinstance(obj, dict):
        return {}
    return {k: v for k, v in obj.items() if k not in PROTECTED_PATCH_KEYS}


IMPORTABLE_STATE_GROUPS = {
    "settings", "custom", "apps", "media", "console", "experimental", "cycling",
    "multiple", "health", "location", "weather", "navigation", "androidAuto",
    "samsung", "emulation", "screenRead", "automation", "drawer", "chatProfile",
    "wallet", "premium", "quickControls", "ui", "recent", "usage", "savedConfigs",
    "bulk", "plugins", "gallery", "appCatalog", "mirror",
}


# ---------------------------------------------------------------------------
# Kizzey Android backup/config compatibility
# ---------------------------------------------------------------------------

KIZZEY_BACKUP_FORMAT = "kizzey-backup"
KIZZEY_PRESET_FORMAT = "kizzey-preset"
KIZZEY_WEB_FORMAT = "kizzey-web-backup"
KIZZEY_PRESET_LIMIT = 300
KIZZEY_CONFIG_LIMIT = 300
KIZZEY_IMAGE_LIMIT = 64
KIZZEY_IMAGE_B64_LIMIT = 6 * 1024 * 1024
KIZZEY_IMAGE_BYTES_LIMIT = 4 * 1024 * 1024
KIZZEY_SAVED_LIMIT = 500
KIZZEY_WARNING_LIMIT = 20
KIZZEY_NOW_WINDOW_MS = 5 * 60 * 1000
KIZZEY_ACTIVITY_TYPES = {0, 1, 2, 3, 5}
KIZZEY_STATUS_VALUES = {"online", "idle", "dnd", "invisible", "offline"}
KIZZEY_HOME_SECTIONS = {
    "updates": "updates",
    "live": "live",
    "quick": "quick",
    "recent": "recent",
    "chat": "chat",
    "stats": "stats",
    "about": "about",
}
KIZZEY_LANGUAGE_TAGS = {
    "en", "pt-BR", "ru", "tr", "vi", "ar", "de", "es", "fa", "fil", "fr", "hi",
    "hr", "in", "it", "ja", "ko", "nl", "pl", "pt", "th", "zh-CN", "zh-TW", "he", "my",
}
KIZZEY_LEGACY_LANGUAGES = {
    1: "en", 2: "tr", 3: "nl", 4: "ru", 5: "pl", 6: "pt-BR", 7: "in", 8: "zh-CN",
    9: "zh-TW", 10: "my", 11: "vi", 12: "it", 13: "fil", 14: "fr", 15: "hr", 16: "fa",
    17: "de", 18: "th", 19: "ja", 20: "ko", 21: "ar", 22: "es", 23: "he",
}
KIZZEY_CONFIG_MARKERS = (
    "largeImg", "smallImg", "button1", "button2", "button1link", "button2link",
    "timestampsStart", "timestampsStop", "partyCurrentSize", "partyMaxSize", "platform",
)
KIZZEY_WEB_STATE_MARKERS = ("settings", "custom", "savedConfigs", "chatProfile", "ui", "apps", "media")
KIZZEY_PRESET_GRADIENTS = (
    "linear-gradient(135deg,#342748,#7b4f7c)",
    "linear-gradient(135deg,#1d3340,#3f7280)",
    "linear-gradient(135deg,#3b2432,#894d65)",
    "linear-gradient(135deg,#25332a,#5f8068)",
)


def _kz_clean(value, limit: int = 256) -> str:
    if value is None or isinstance(value, (dict, list, tuple, bool)):
        return ""
    return str(value).strip()[:limit]


def _kz_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("1", "true", "yes", "on"):
            return True
        if lowered in ("0", "false", "no", "off", ""):
            return False
    return None


def _kz_int(value, low=None, high=None, fallback=None):
    try:
        if value is None or isinstance(value, bool) or (isinstance(value, str) and not value.strip()):
            return fallback
        number = int(float(value))
    except Exception:
        return fallback
    if low is not None:
        number = max(low, number)
    if high is not None:
        number = min(high, number)
    return number


def _kz_float(value, low=None, high=None, fallback=None):
    try:
        if value is None or isinstance(value, bool) or (isinstance(value, str) and not value.strip()):
            return fallback
        number = float(value)
        if number != number:
            return fallback
    except Exception:
        return fallback
    if low is not None:
        number = max(low, number)
    if high is not None:
        number = min(high, number)
    return round(number, 3)


def _kz_json(value):
    if isinstance(value, (dict, list)):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return json.loads(value)
    except Exception:
        return None


def _kz_color(value):
    if isinstance(value, str):
        text = value.strip()
        match = re.fullmatch(r"#?([0-9a-fA-F]{6})", text)
        if match:
            return "#" + match.group(1).lower()
        match = re.fullmatch(r"#?([0-9a-fA-F]{8})", text)
        if match:
            return "#" + match.group(1)[-6:].lower()
    try:
        number = int(value)
    except Exception:
        return None
    if number < -0x80000000 or number > 0xFFFFFFFF:
        return None
    number &= 0xFFFFFFFF
    if number == 0:
        return None
    return f"#{number & 0xFFFFFF:06x}"


def _kz_activity_type(value, fallback: str = "0") -> str:
    number = _kz_int(value)
    return str(number) if number in KIZZEY_ACTIVITY_TYPES else fallback


def _kz_status(value, fallback: str = "online") -> str:
    text = _kz_clean(value, 16).lower()
    return text if text in KIZZEY_STATUS_VALUES else fallback


def _kz_timestamp(value) -> str:
    text = _kz_clean(value, 48)
    if not text:
        return ""
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        try:
            number = float(text)
        except Exception:
            return ""
        return str(int(number)) if number > 0 else ""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}[T ][0-9:.+\-Z]+", text):
        return text
    return ""


def _kz_url(value) -> str:
    text = _kz_clean(value, 2048)
    return text if re.match(r"^https?://", text, re.I) else ""


def _kz_file_stem(file_name: str) -> str:
    name = Path(str(file_name or "").replace("\\", "/")).name.strip()
    if name.lower().endswith(".json"):
        name = name[:-5]
    return _kz_clean(name, 64)


def _kz_ids(value) -> list[str]:
    if isinstance(value, list):
        rows = value
    elif isinstance(value, str):
        parsed = _kz_json(value)
        rows = parsed if isinstance(parsed, list) else value.split(",")
    else:
        return []
    out = []
    for row in rows:
        text = _kz_clean(row, 64).lower()
        if text and text not in out:
            out.append(text)
    return out


def _kz_home_ids(value) -> list[str]:
    out = []
    for raw in _kz_ids(value):
        target = KIZZEY_HOME_SECTIONS.get(raw)
        if target and target not in out:
            out.append(target)
    return out


def _kz_detect_image(blob: bytes) -> str:
    if blob.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if blob.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if blob.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if len(blob) >= 12 and blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return "webp"
    return ""


def _kz_new_context(payload: dict) -> dict:
    images = payload.get("presetImages") if isinstance(payload, dict) else {}
    if not isinstance(images, dict):
        images = {}
    return {
        "images": {str(k): v for k, v in images.items() if isinstance(v, str)},
        "image_urls": {},
        "images_imported": 0,
        "images_skipped": 0,
        "local_image_misses": 0,
        "image_errors": 0,
        "config_errors": 0,
        "entries_skipped": 0,
        "bad_application_id": False,
        "warnings": [],
    }


def _kz_save_image(ctx: dict, key: str, encoded: str) -> str:
    base = Path(str(key or "").replace("\\", "/")).name.strip()
    if not base:
        return ""
    if base in ctx["image_urls"]:
        return ctx["image_urls"][base]
    if ctx["images_imported"] >= KIZZEY_IMAGE_LIMIT:
        ctx["images_skipped"] += 1
        return ""
    raw = str(encoded or "").strip()
    if raw.startswith("data:"):
        raw = raw.partition(",")[2].strip()
    if not raw or len(raw) > KIZZEY_IMAGE_B64_LIMIT:
        ctx["image_errors"] += 1
        return ""
    try:
        blob = base64.b64decode(raw, validate=False)
    except Exception:
        ctx["image_errors"] += 1
        return ""
    if not blob or len(blob) > KIZZEY_IMAGE_BYTES_LIMIT:
        ctx["image_errors"] += 1
        return ""
    extension = _kz_detect_image(blob)
    if not extension:
        ctx["image_errors"] += 1
        return ""
    name = uuid.uuid4().hex + "." + extension
    try:
        (UPLOAD_DIR / name).write_bytes(blob)
    except Exception:
        ctx["image_errors"] += 1
        return ""
    ctx["images_imported"] += 1
    url = "/uploads/" + name
    ctx["image_urls"][base] = url
    return url


def _kz_image_ref(ctx: dict, raw) -> tuple[str, str]:
    """Return (web value, kind) where kind is url, asset or blank."""
    value = _kz_clean(raw, 2048)
    if not value:
        return "", ""
    if re.match(r"^https?://", value, re.I):
        return value, "url"
    if value.startswith(("mp:", "external/", "attachments/")):
        return value, "asset"
    if re.fullmatch(r"/uploads/[A-Za-z0-9][A-Za-z0-9._-]*", value):
        return value, "url"
    if value.startswith("/uploads/"):
        return "", ""
    if value.startswith("data:image/"):
        url = _kz_save_image(ctx, uuid.uuid4().hex, value)
        return (url, "url") if url else ("", "")
    base = Path(value.replace("\\", "/")).name
    if base and base in ctx["images"]:
        url = _kz_save_image(ctx, base, ctx["images"][base])
        if url:
            return url, "url"
    ctx["local_image_misses"] += 1
    return "", ""


def _kz_custom_from_config(config, ctx: dict) -> dict:
    cfg = config if isinstance(config, dict) else {}
    large_value, large_kind = _kz_image_ref(ctx, cfg.get("largeImg") or cfg.get("largeUrl"))
    small_value, small_kind = _kz_image_ref(ctx, cfg.get("smallImg") or cfg.get("smallUrl"))
    activity_type = _kz_activity_type(cfg.get("type"), "0")
    button1link = _kz_url(cfg.get("button1link"))
    button2link = _kz_url(cfg.get("button2link"))
    app_id = _kz_clean(cfg.get("applicationId"), 32)
    if app_id and not re.fullmatch(r"\d{18,19}", app_id):
        app_id = ""
        ctx["bad_application_id"] = True
    return {
        "name": _kz_clean(cfg.get("name"), 128),
        "details": _kz_clean(cfg.get("details"), 128),
        "state": _kz_clean(cfg.get("state"), 128),
        "partyCurrentSize": _kz_clean(cfg.get("partyCurrentSize"), 8),
        "partyMaxSize": _kz_clean(cfg.get("partyMaxSize"), 8),
        "timestampsStart": _kz_timestamp(cfg.get("timestampsStart")),
        "timestampsStop": _kz_timestamp(cfg.get("timestampsStop")),
        "platform": _kz_clean(cfg.get("platform"), 32) or "android",
        "status": _kz_status(cfg.get("status"), "online"),
        "button1": _kz_clean(cfg.get("button1"), 32),
        "button1link": button1link,
        "button2": _kz_clean(cfg.get("button2"), 32),
        "button2link": button2link,
        "largeImg": large_value if large_kind == "asset" else "",
        "largeText": _kz_clean(cfg.get("largeText") or cfg.get("large_text"), 128),
        "smallImg": small_value if small_kind == "asset" else "",
        "smallText": _kz_clean(cfg.get("smallText") or cfg.get("small_text"), 128),
        "type": activity_type,
        "url": _kz_url(cfg.get("url")),
        "applicationId": app_id,
        "statusDisplayType": -1,
        "largeUrl": large_value if large_kind == "url" else "",
        "smallUrl": small_value if small_kind == "url" else "",
    }


def _kz_custom_has_content(custom: dict) -> bool:
    if not isinstance(custom, dict):
        return False
    keys = (
        "name", "details", "state", "largeImg", "largeUrl", "smallImg", "smallUrl",
        "button1", "button2", "partyCurrentSize", "timestampsStart",
    )
    return any(custom.get(key) for key in keys)


def _kz_preset(title: str, custom: dict, number: int, source_title: str | None = None) -> dict:
    name = _kz_clean(title, 80) or _kz_clean(custom.get("name"), 80) or f"Imported preset {number + 1}"
    start = _kz_clean(custom.get("timestampsStart"), 48)
    stop = _kz_clean(custom.get("timestampsStop"), 48)
    timestamp = (
        {"mode": "absolute", "start": start, "stop": stop}
        if start or stop
        else {"mode": "none"}
    )
    return {
        "id": "kz-" + uuid.uuid4().hex[:12],
        "name": name,
        "custom": custom,
        "timestamp": timestamp,
        "sourceTitle": _kz_clean(title if source_title is None else source_title, 80),
        "createdAt": now_ms(),
        "author": "Kizzey import",
        "tag": "Imported",
        "emoji": "📥",
        "gradient": KIZZEY_PRESET_GRADIENTS[number % len(KIZZEY_PRESET_GRADIENTS)],
    }


def _kz_preset_from_config(config, title: str, ctx: dict, number: int) -> dict | None:
    custom = _kz_custom_from_config(config, ctx)
    if not _kz_custom_has_content(custom):
        return None
    return _kz_preset(title, custom, number, source_title=title)


def _kz_preset_from_text(entry, ctx: dict, number: int) -> dict | None:
    if not isinstance(entry, dict):
        return None
    title = _kz_clean(entry.get("title"), 80)
    name = _kz_clean(entry.get("name"), 128)
    details = _kz_clean(entry.get("details"), 128)
    state = _kz_clean(entry.get("state"), 128)
    image = _kz_clean(entry.get("image"), 2048)
    if not any((title, name, details, state, image)):
        return None
    # A timer block is optional and only this server writes it, so a downloaded
    # pack keeps the shelf's apply behaviour. Kizzey's own packs never carry one.
    timer = entry.get("timer") if isinstance(entry.get("timer"), dict) else {}
    mode = _kz_clean(timer.get("mode"), 24)
    start = _kz_timestamp(timer.get("start"))
    stop = _kz_timestamp(timer.get("stop"))
    duration = _kz_int(timer.get("durationMs"), 0, None, 0)
    custom = _kz_custom_from_config(
        {
            "name": name,
            "details": details,
            "state": state,
            "largeImg": image,
            "status": "online",
            "timestampsStart": start if mode == "absolute" else "",
            "timestampsStop": stop if mode == "absolute" else "",
        },
        ctx,
    )
    preset = _kz_preset(title or name or details or state, custom, number, source_title=title)
    if mode == "duration" and duration > 0:
        now = now_ms()
        custom["timestampsStart"] = str(now)
        custom["timestampsStop"] = str(now + duration)
        preset["timestamp"] = {"mode": "duration", "durationMs": duration}
    elif mode == "since_apply":
        custom["timestampsStart"] = str(now_ms())
        custom["timestampsStop"] = ""
        preset["timestamp"] = {"mode": "since_apply"}
    return preset


def _kz_preset_from_template(entry, ctx: dict, number: int) -> dict | None:
    if not isinstance(entry, dict):
        return None
    if _kz_clean(entry.get("source"), 24) == "builtin":
        return None
    config = entry.get("config") if isinstance(entry.get("config"), dict) else {}
    custom = _kz_custom_from_config(config, ctx)
    # Template images and timers come only from the image refs and timestamp
    # fields. Kizzey ignores the stored config's volatile fields on apply.
    custom["largeImg"] = ""
    custom["largeUrl"] = ""
    custom["smallImg"] = ""
    custom["smallUrl"] = ""
    custom["timestampsStart"] = ""
    custom["timestampsStop"] = ""
    title = _kz_clean(entry.get("title"), 80)
    app_id = _kz_clean(entry.get("applicationId"), 32)
    if app_id and re.fullmatch(r"\d{18,19}", app_id):
        custom["applicationId"] = app_id
    elif app_id:
        ctx["bad_application_id"] = True

    def template_image(ref, slot: str):
        if not isinstance(ref, dict):
            return
        kind = _kz_clean(ref.get("kind"), 24)
        value = ref.get("value")
        image_value, image_kind = "", ""
        if kind == "url":
            image_value, image_kind = _kz_image_ref(ctx, value)
        elif kind == "local_upload":
            base = Path(str(value or "").replace("\\", "/")).name
            if base and base in ctx["images"]:
                url = _kz_save_image(ctx, base, ctx["images"][base])
                if url:
                    image_value, image_kind = url, "url"
            else:
                ctx["local_image_misses"] += 1
        elif kind not in ("", "none"):
            image_value, image_kind = _kz_image_ref(ctx, value)
        if image_value:
            custom[slot + "Img"] = image_value if image_kind == "asset" else ""
            custom[slot + "Url"] = image_value if image_kind == "url" else ""

    template_image(entry.get("largeImage"), "large")
    template_image(entry.get("smallImage"), "small")

    mode = _kz_clean(entry.get("timestampMode"), 24)
    duration = _kz_int(entry.get("durationMs"), 0)
    start_abs = _kz_int(entry.get("startAbsolute"), 0)
    stop_abs = _kz_int(entry.get("stopAbsolute"), 0)
    updated = _kz_int(entry.get("updatedTs"), 0)
    now = now_ms()
    timestamp = {"mode": "none"}
    # Match RpcPresetApply: a captured absolute start wins over timestampMode.
    # Near the save time it was a live timer and restarts on apply; an older
    # value is a fixed date and is applied verbatim.
    if start_abs and start_abs > 0:
        if updated and abs(start_abs - updated) <= KIZZEY_NOW_WINDOW_MS:
            custom["timestampsStart"] = str(now)
            if stop_abs and stop_abs > start_abs:
                custom["timestampsStop"] = str(now + (stop_abs - start_abs))
                timestamp = {"mode": "duration", "durationMs": stop_abs - start_abs}
            else:
                custom["timestampsStop"] = ""
                timestamp = {"mode": "since_apply"}
        else:
            custom["timestampsStart"] = str(start_abs)
            custom["timestampsStop"] = str(stop_abs) if stop_abs and stop_abs > 0 else ""
            timestamp = {
                "mode": "absolute",
                "start": str(start_abs),
                "stop": str(stop_abs) if stop_abs and stop_abs > 0 else "",
            }
    elif mode == "since_apply":
        custom["timestampsStart"] = str(now)
        custom["timestampsStop"] = ""
        timestamp = {"mode": "since_apply"}
    elif mode == "duration":
        length = max(0, duration or 0)
        custom["timestampsStart"] = str(now)
        custom["timestampsStop"] = str(now + length)
        timestamp = {"mode": "duration", "durationMs": length}
    if not _kz_custom_has_content(custom):
        return None
    preset = _kz_preset(title or custom.get("name", ""), custom, number, source_title=title)
    preset["timestamp"] = timestamp
    return preset


def _kz_saved_buttons(prefs: dict) -> dict:
    data = _kz_json(prefs.get("saved_rpc_buttons_data"))
    if not isinstance(data, dict):
        return {}
    out = {}
    mapping = {
        "button1": ("button1", 32),
        "button2": ("button2", 32),
        "button1Url": ("button1link", 2048),
        "button2Url": ("button2link", 2048),
    }
    for source, (target, limit) in mapping.items():
        value = _kz_clean(data.get(source), limit)
        if target.endswith("link"):
            value = _kz_url(value)
        if value:
            out[target] = value
    return out


def _kz_updates_from_prefs(prefs: dict, ctx: dict) -> dict:
    updates = {}
    if not isinstance(prefs, dict):
        return updates

    settings = {}
    media = {}
    cycling = {}
    counts = {"settings": 0}

    def put_setting(key: str, value):
        if value is None:
            return
        settings[key] = value
        counts["settings"] += 1

    def put_media(key: str, value):
        if value is None:
            return
        media[key] = value
        counts["settings"] += 1

    def put_cycling(key: str, value):
        if value is None:
            return
        cycling[key] = value
        counts["settings"] += 1

    dark = _kz_int(prefs.get("dark_theme_value"))
    if dark == 2:
        put_setting("theme", "dark")
    elif dark == 3:
        put_setting("theme", "light")
    elif dark == 1:
        put_setting("theme", "system")

    accent = _kz_color(prefs.get("theme_color")) or _kz_color(prefs.get("custom_theme_color"))
    if accent:
        put_setting("accent", accent)
    high_contrast = _kz_bool(prefs.get("high_contrast"))
    if high_contrast is not None:
        put_setting("highContrast", high_contrast)
    dynamic = _kz_bool(prefs.get("dynamic_color"))
    if dynamic is not None:
        put_setting("dynamicColor", dynamic)
    accent_art = _kz_bool(prefs.get("accent_from_art"))
    if accent_art is not None:
        put_setting("accentFromArt", accent_art)
    art_background = _kz_bool(prefs.get("art_background"))
    if art_background is not None:
        put_setting("artBackground", art_background)
    blur = _kz_int(prefs.get("art_background_blur"), 0, 50)
    if blur is not None:
        put_setting("artBackgroundBlur", blur)
    dim = _kz_int(prefs.get("art_background_dim"), 0, 90)
    if dim is not None:
        put_setting("artBackgroundDim", dim)
    scale = _kz_float(prefs.get("ui_scale"), 0.85, 1.2)
    if scale is not None:
        put_setting("fontScale", scale)

    layout_list = _kz_bool(prefs.get("home_layout_list"))
    if layout_list is not None:
        put_setting("homeLayout", "list" if layout_list else "grid")
    columns = _kz_int(prefs.get("home_grid_columns"), 1, 2)
    if columns is not None:
        put_setting("homeColumns", columns)
    if "home_sections_order" in prefs:
        order = _kz_home_ids(prefs.get("home_sections_order"))
        if order:
            put_setting("homeOrder", order)
    if "home_sections_hidden" in prefs:
        hidden = _kz_home_ids(prefs.get("home_sections_hidden"))
        put_setting("hiddenHome", hidden)

    greeting = _kz_clean(prefs.get("welcome_message"), 160)
    if greeting:
        put_setting("greeting", greeting)
    active_now = _kz_bool(prefs.get("show_active_now_on_home"))
    if active_now is not None:
        put_setting("showLiveNow", active_now)
    chat_preview = _kz_bool(prefs.get("chat_home_preview_enabled"))
    if chat_preview is not None:
        put_setting("showChatPreview", chat_preview)
    notifications = _kz_bool(prefs.get("realtime_notif_enabled"))
    if notifications is not None:
        put_setting("notifications", notifications)

    language = _kz_clean(prefs.get("k844p1_language_tag"), 20)
    if language not in KIZZEY_LANGUAGE_TAGS:
        language = KIZZEY_LEGACY_LANGUAGES.get(_kz_int(prefs.get("language")), "")
    if language in KIZZEY_LANGUAGE_TAGS:
        put_setting("language", language)

    use_buttons = _kz_bool(prefs.get("use_saved_rpc_buttons"))
    if use_buttons is not None:
        put_setting("showButtons", use_buttons)
    settings.update(_kz_saved_buttons(prefs))

    custom = {}
    raw_last = prefs.get("last_run_custom_rpc")
    last = _kz_json(raw_last)
    if isinstance(last, dict):
        custom.update(_kz_custom_from_config(last, ctx))
    elif raw_last not in (None, "") and isinstance(raw_last, str):
        ctx["warnings"].append("The saved active Custom RPC card could not be read, so only its separate settings were imported.")

    custom_type = _kz_int(prefs.get("custom_activity_type"))
    if custom_type in KIZZEY_ACTIVITY_TYPES:
        custom["type"] = str(custom_type)
    custom_status = _kz_clean(prefs.get("custom_activity_status"), 16).lower()
    if custom_status in KIZZEY_STATUS_VALUES:
        custom["status"] = custom_status
        put_setting("rpcStatus", custom_status)
    app_id = _kz_clean(
        prefs.get("custom_activity_application_id_") or prefs.get("custom_activity_application_id"),
        32,
    )
    if app_id:
        if re.fullmatch(r"\d{18,19}", app_id):
            custom["applicationId"] = app_id
        else:
            ctx["bad_application_id"] = True
    stream = _kz_url(prefs.get("custom_activity_stream_url"))
    if stream:
        custom["url"] = stream
    display_type = _kz_int(prefs.get("custom_rpc_status_display_type"), -1, 2)
    if display_type is not None:
        custom["statusDisplayType"] = display_type
        put_setting("statusDisplay", display_type)
    roll = _kz_bool(prefs.get("custom_rpc_status_roll"))
    if roll is not None:
        put_setting("statusRoll", roll)
    roll_interval = _kz_int(prefs.get("custom_rpc_status_roll_interval"), 1, 120)
    if roll_interval is not None:
        put_setting("statusRollInterval", roll_interval)
    roll_raw = prefs.get("k844_lyrics_roll_lines_custom")
    if roll_raw not in (None, ""):
        roll_data = _kz_json(roll_raw)
        if isinstance(roll_data, list):
            names = {0: "name", 1: "state", 2: "details"}
            lines = [names[value] for value in (_kz_int(row) for row in roll_data) if value in names]
            if lines:
                put_setting("statusRollLines", lines)
    if custom and (_kz_custom_has_content(custom) or custom.get("applicationId") or custom.get("url")):
        updates["custom"] = custom

    show_progress = _kz_bool(prefs.get("enable_timestamps"))
    if show_progress is not None:
        put_media("showProgress", show_progress)
    hide_paused = _kz_bool(prefs.get("hide_on_pause"))
    if hide_paused is not None:
        put_media("hideOnPause", hide_paused)
    media_type = _kz_int(prefs.get("media_rpc_activity_type"))
    if media_type in KIZZEY_ACTIVITY_TYPES:
        put_media("type", media_type)
    pause_status = _kz_clean(prefs.get("k844p2_rpc_media_pause_status"), 16).lower()
    if pause_status in KIZZEY_STATUS_VALUES:
        put_media("hiddenStatus", pause_status)
    media_cycling = _kz_bool(prefs.get("media_cycling_enabled"))
    if media_cycling is not None:
        put_cycling("enabled", media_cycling)
    cycling_types = _kz_json(prefs.get("media_cycling_types"))
    if isinstance(cycling_types, list):
        values = []
        for row in cycling_types:
            number = _kz_int(row)
            if number in KIZZEY_ACTIVITY_TYPES and number not in values:
                values.append(number)
        if values:
            put_cycling("types", values)
    cycling_interval = _kz_int(prefs.get("media_cycling_interval"), 1, 600)
    if cycling_interval is not None:
        put_cycling("interval", cycling_interval)
    cycling_stream = _kz_url(prefs.get("media_cycling_stream_url"))
    if cycling_stream:
        put_cycling("streamUrl", cycling_stream)

    if prefs.get("custom_css_theme") or prefs.get("custom_css_theme_enabled"):
        ctx["warnings"].append("Kizzey's serialised custom CSS palette was not converted into web CSS variables.")

    if settings:
        updates["settings"] = settings
    if media:
        updates["media"] = media
    if cycling:
        updates["cycling"] = cycling
    ctx["settings_count"] = counts["settings"]
    return updates


def _kz_add_preset(presets: list, seen: set, preset: dict | None, ctx: dict) -> bool:
    if not preset:
        return False
    key = _saved_merge_key(preset)
    if key and key in seen:
        ctx["duplicates"] = ctx.get("duplicates", 0) + 1
        return False
    if len(presets) >= KIZZEY_PRESET_LIMIT:
        ctx["truncated"] = True
        return False
    if key:
        seen.add(key)
    presets.append(preset)
    return True


def _kz_final_warnings(ctx: dict, report: dict) -> list[str]:
    warnings = list(ctx["warnings"])
    if ctx["local_image_misses"]:
        count = ctx["local_image_misses"]
        warnings.append(
            f"{count} local Android image path{'s' if count != 1 else ''} could not be read. "
            "Export a full Kizzey settings backup to carry preset artwork, or add the image again here."
        )
    if ctx["images_skipped"]:
        count = ctx["images_skipped"]
        warnings.append(
            f"Only {KIZZEY_IMAGE_LIMIT} preset artwork files are imported at once; "
            f"{count} more {'were' if count != 1 else 'was'} skipped."
        )
    if ctx["image_errors"]:
        count = ctx["image_errors"]
        warnings.append(f"{count} preset image{'s' if count != 1 else ''} could not be decoded or stored and {'were' if count != 1 else 'was'} skipped.")
    if ctx.get("duplicates"):
        count = ctx["duplicates"]
        warnings.append(f"{count} duplicate preset title{'s were' if count != 1 else ' was'} merged.")
    if ctx.get("truncated"):
        warnings.append(f"Only the first {KIZZEY_PRESET_LIMIT} presets were imported.")
    if ctx.get("bad_application_id"):
        warnings.append("A Custom RPC application ID was not 18 or 19 digits, so it was omitted.")
    if ctx.get("config_errors", 0) > 3:
        count = ctx["config_errors"]
        warnings.append(f"{count} saved config files could not be read; the first few failures are listed above.")
    if ctx.get("entries_skipped"):
        count = ctx["entries_skipped"]
        warnings.append(
            f"{count} preset entr{'ies were' if count != 1 else 'y was'} malformed or had no importable fields and {'were' if count != 1 else 'was'} skipped."
        )
    seen = set()
    out = []
    for warning in warnings:
        if warning and warning not in seen:
            seen.add(warning)
            out.append(warning)
    report["warnings"] = out[:KIZZEY_WARNING_LIMIT]
    return out


def build_kizzey_backup_import(payload: dict, file_name: str = "") -> dict:
    if not isinstance(payload, dict):
        raise ValueError("That Kizzey backup is not a JSON object.")
    ctx = _kz_new_context(payload)
    version = _kz_int(payload.get("version"), 1)
    app_version = _kz_clean(payload.get("appVersion"), 40)
    if version and version > 2:
        ctx["warnings"].append(
            f"This is a version {version} Kizzey backup. Known settings were imported and newer fields were ignored."
        )
    prefs = payload.get("prefs") if isinstance(payload.get("prefs"), dict) else {}
    updates = _kz_updates_from_prefs(prefs, ctx)

    presets = []
    seen = set()
    template_count = 0
    config_count = 0
    text_count = 0

    raw_templates = prefs.get("custom_rpc_template_presets")
    if raw_templates not in (None, ""):
        templates = _kz_json(raw_templates)
        if isinstance(templates, list):
            if len(templates) > KIZZEY_PRESET_LIMIT:
                ctx["truncated"] = True
            for entry in templates[:KIZZEY_PRESET_LIMIT]:
                preset = _kz_preset_from_template(entry, ctx, len(presets))
                if preset is None:
                    if not (isinstance(entry, dict) and _kz_clean(entry.get("source"), 24) == "builtin"):
                        ctx["entries_skipped"] += 1
                    continue
                if _kz_add_preset(presets, seen, preset, ctx):
                    template_count += 1
        else:
            ctx["warnings"].append("The saved Custom RPC template presets could not be read.")
    elif "custom_rpc_template_presets" in prefs:
        ctx["warnings"].append("The saved Custom RPC template presets were empty or unreadable.")

    raw_configs = payload.get("configs")
    configs = raw_configs if isinstance(raw_configs, dict) else {}
    for index, (raw_name, raw_content) in enumerate(configs.items()):
        if index >= KIZZEY_CONFIG_LIMIT:
            ctx["truncated"] = True
            break
        title = _kz_file_stem(raw_name)
        content = _kz_json(raw_content)
        if not isinstance(content, dict):
            ctx["config_errors"] += 1
            if ctx["config_errors"] <= 3:
                ctx["warnings"].append(f"The saved config {title or 'file'} could not be read.")
            continue
        preset = _kz_preset_from_config(content, title, ctx, len(presets))
        if preset is None:
            ctx["entries_skipped"] += 1
        elif _kz_add_preset(presets, seen, preset, ctx):
            config_count += 1

    raw_presets = prefs.get("rpc_presence_presets")
    if raw_presets not in (None, ""):
        preset_rows = _kz_json(raw_presets)
        if isinstance(preset_rows, list):
            if len(preset_rows) > KIZZEY_PRESET_LIMIT:
                ctx["truncated"] = True
            for entry in preset_rows[:KIZZEY_PRESET_LIMIT]:
                preset = _kz_preset_from_text(entry, ctx, len(presets))
                if preset is None:
                    ctx["entries_skipped"] += 1
                elif _kz_add_preset(presets, seen, preset, ctx):
                    text_count += 1
        else:
            ctx["warnings"].append("The saved text presets could not be read.")
    elif "rpc_presence_presets" in prefs:
        ctx["warnings"].append("The saved text presets were empty or unreadable.")

    account_ignored = bool(payload.get("includesAccount")) or any(
        key in prefs for key in ("token", "user_data", "user_id", "user_bio", "user_nitro", "multi_rpc_accounts")
    )
    if account_ignored:
        ctx["warnings"].append("Discord account and token fields from the Android backup were ignored.")

    if not updates and not presets:
        raise ValueError(
            "That Kizzey backup has no settings or presets this web build can import."
        )

    report = {
        "kind": "kizzey-backup",
        "label": "Kizzey settings backup",
        "settings": ctx.get("settings_count", 0),
        "presets": len(presets),
        "configs": config_count,
        "templatePresets": template_count,
        "textPresets": text_count,
        "images": ctx["images_imported"],
        "accountIgnored": bool(account_ignored),
        "sourceVersion": app_version or (f"format {version}" if version else ""),
        "warnings": [],
    }
    _kz_final_warnings(ctx, report)
    return {"updates": updates, "presets": presets, "report": report}


def build_kizzey_preset_import(payload, file_name: str = "") -> dict:
    if isinstance(payload, dict) and isinstance(payload.get("presets"), list):
        entries = payload["presets"]
    elif _looks_like_text_preset(payload):
        entries = [payload]
    else:
        entries = payload
    if not isinstance(entries, list):
        raise ValueError("That Kizzey preset pack does not contain a presets list.")
    ctx = _kz_new_context(payload if isinstance(payload, dict) else {})
    if len(entries) > KIZZEY_PRESET_LIMIT:
        ctx["truncated"] = True
    presets = []
    seen = set()
    for entry in entries[:KIZZEY_PRESET_LIMIT]:
        preset = _kz_preset_from_text(entry, ctx, len(presets))
        if preset is None:
            ctx["entries_skipped"] += 1
        else:
            _kz_add_preset(presets, seen, preset, ctx)
    if not presets:
        raise ValueError("That Kizzey preset pack contains no presets with usable text.")
    report = {
        "kind": "kizzey-preset",
        "label": "Kizzey preset pack",
        "settings": 0,
        "presets": len(presets),
        "configs": 0,
        "templatePresets": 0,
        "textPresets": len(presets),
        "images": ctx["images_imported"],
        "accountIgnored": False,
        "sourceVersion": _kz_clean(payload.get("appVersion"), 40) if isinstance(payload, dict) else "",
        "warnings": [],
    }
    _kz_final_warnings(ctx, report)
    return {"updates": {}, "presets": presets, "report": report}


def build_kizzey_config_import(payload, file_name: str = "") -> dict:
    entries = payload if isinstance(payload, list) else [payload]
    ctx = _kz_new_context({})
    filtered = [entry for entry in entries if isinstance(entry, dict)]
    ctx["entries_skipped"] += len(entries) - len(filtered)
    entries = filtered
    if not entries:
        raise ValueError("That file does not contain a Kizzey Custom RPC config.")
    presets = []
    seen = set()
    base_title = _kz_file_stem(file_name)
    if len(entries) > KIZZEY_CONFIG_LIMIT:
        ctx["truncated"] = True
    for index, entry in enumerate(entries[:KIZZEY_CONFIG_LIMIT]):
        title = base_title if len(entries) == 1 else ""
        if not title:
            title = _kz_clean(entry.get("name"), 80) or (f"{base_title} {index + 1}" if base_title else f"Imported config {index + 1}")
        preset = _kz_preset_from_config(entry, title, ctx, len(presets))
        if preset is None:
            ctx["entries_skipped"] += 1
        else:
            _kz_add_preset(presets, seen, preset, ctx)
    if not presets:
        raise ValueError("That Kizzey config has no card fields this web build can import.")
    report = {
        "kind": "kizzey-config",
        "label": "Kizzey Custom RPC config",
        "settings": 0,
        "presets": len(presets),
        "configs": len(presets),
        "templatePresets": 0,
        "textPresets": 0,
        "images": ctx["images_imported"],
        "accountIgnored": False,
        "sourceVersion": "",
        "warnings": [],
    }
    _kz_final_warnings(ctx, report)
    return {"updates": {}, "presets": presets, "report": report}


def _looks_like_rpc_config(value) -> bool:
    if not isinstance(value, dict):
        return False
    if isinstance(value.get("state"), dict):
        return False
    if any(marker in value for marker in KIZZEY_CONFIG_MARKERS):
        return True
    return any(key in value for key in ("name", "details", "state")) and not any(
        key in value for key in ("title", "image", "presets", "prefs")
    )


def _looks_like_text_preset(value) -> bool:
    return isinstance(value, dict) and any(
        key in value for key in ("title", "name", "details", "state", "image")
    ) and not _looks_like_rpc_config(value)


def detect_import_kind(payload) -> str:
    if isinstance(payload, list):
        if any(_looks_like_rpc_config(row) for row in payload):
            return "kizzey-config"
        if any(_looks_like_text_preset(row) for row in payload):
            return "kizzey-preset"
        return "unknown"
    if not isinstance(payload, dict):
        return "unknown"
    fmt = _kz_clean(payload.get("format"), 48)
    if fmt == KIZZEY_BACKUP_FORMAT:
        return "kizzey-backup"
    if fmt == KIZZEY_PRESET_FORMAT:
        return "kizzey-preset"
    if fmt == KIZZEY_WEB_FORMAT:
        return "web"
    if fmt:
        return "unknown"
    if isinstance(payload.get("prefs"), dict) or isinstance(payload.get("configs"), dict):
        return "kizzey-backup"
    if any(key in payload for key in KIZZEY_WEB_STATE_MARKERS):
        return "web"
    if isinstance(payload.get("state"), dict):
        return "web"
    if isinstance(payload.get("presets"), list):
        return "kizzey-preset"
    if _looks_like_text_preset(payload) and any(key in payload for key in ("title", "image")):
        return "kizzey-preset"
    if _looks_like_rpc_config(payload):
        return "kizzey-config"
    # Preserve the original import contract: an object with no Kizzey marker is
    # treated as a raw web state, even when only one state group is present.
    return "web"


def _saved_merge_key(preset) -> str:
    if not isinstance(preset, dict):
        return ""
    value = preset.get("sourceTitle") if "sourceTitle" in preset else preset.get("name")
    return str(value or "").strip().casefold()


def merge_saved_configs(existing, incoming: list) -> tuple[list, int]:
    current = existing if isinstance(existing, list) else []
    incoming_keys = {_saved_merge_key(preset) for preset in incoming if _saved_merge_key(preset)}
    kept = [preset for preset in current if _saved_merge_key(preset) not in incoming_keys]
    merged = list(incoming) + kept
    dropped = max(0, len(merged) - KIZZEY_SAVED_LIMIT)
    return merged[:KIZZEY_SAVED_LIMIT], dropped


def _kz_config_image(custom: dict, slot: str) -> str:
    """Return the single image value for a slot that survives a re-import."""
    url = _kz_clean(custom.get(slot + "Url"), 2048)
    if url and (
        re.match(r"^https?://", url, re.I)
        or re.fullmatch(r"/uploads/[A-Za-z0-9][A-Za-z0-9._-]*", url)
    ):
        return url
    asset = _kz_clean(custom.get(slot + "Img"), 2048)
    if asset.startswith(("mp:", "external/", "attachments/")):
        return asset
    return ""


def _kz_config_count(value):
    """Party sizes export as numbers; blank stays blank so cards gain no content."""
    number = _kz_int(value, low=0)
    return number if number else ""


def _kz_config_timestamp(value):
    """Epoch timestamps export as numbers, ISO strings stay strings, else blank."""
    text = _kz_timestamp(value)
    if not text:
        return ""
    return int(text) if text.isdigit() else text


def _kz_config_from_custom(custom) -> dict:
    """Inverse of _kz_custom_from_config: emit a Kizzey RpcConfig for a web card."""
    cfg = custom if isinstance(custom, dict) else {}
    activity_type = _kz_int(cfg.get("type"), low=0)
    if activity_type not in KIZZEY_ACTIVITY_TYPES:
        activity_type = 0
    app_id = _kz_clean(cfg.get("applicationId"), 32)
    if app_id and not re.fullmatch(r"\d{18,19}", app_id):
        app_id = ""
    return {
        "name": _kz_clean(cfg.get("name"), 128),
        "details": _kz_clean(cfg.get("details"), 128),
        "state": _kz_clean(cfg.get("state"), 128),
        "partyCurrentSize": _kz_config_count(cfg.get("partyCurrentSize")),
        "partyMaxSize": _kz_config_count(cfg.get("partyMaxSize")),
        "timestampsStart": _kz_config_timestamp(cfg.get("timestampsStart")),
        "timestampsStop": _kz_config_timestamp(cfg.get("timestampsStop")),
        "platform": _kz_clean(cfg.get("platform"), 32) or "android",
        "status": _kz_status(cfg.get("status"), "online"),
        "button1": _kz_clean(cfg.get("button1"), 32),
        "button1link": _kz_url(cfg.get("button1link")),
        "button2": _kz_clean(cfg.get("button2"), 32),
        "button2link": _kz_url(cfg.get("button2link")),
        "largeImg": _kz_config_image(cfg, "large"),
        "largeText": _kz_clean(cfg.get("largeText"), 128),
        "smallImg": _kz_config_image(cfg, "small"),
        "smallText": _kz_clean(cfg.get("smallText"), 128),
        "type": activity_type,
        "url": _kz_url(cfg.get("url")),
        "applicationId": app_id,
        "statusDisplayType": -1,
    }


def _kz_file_slug(value, fallback: str = "preset") -> str:
    text = re.sub(r"[^a-z0-9]+", "-", _kz_clean(value, 80).casefold()).strip("-")
    return text[:48] or fallback


def _saved_preset_index(saved, preset_id: str) -> int:
    if not preset_id:
        return -1
    for index, preset in enumerate(saved if isinstance(saved, list) else []):
        if isinstance(preset, dict) and str(preset.get("id") or "") == preset_id:
            return index
    return -1


def _kz_saved_preset(payload, custom, existing=None, number: int = 0) -> dict:
    """Normalise a client preset into the shape the Kizzey importer produces."""
    base = existing if isinstance(existing, dict) else {}
    name = _kz_clean(payload.get("name"), 80) or _kz_clean(base.get("name"), 80)
    if not name:
        raise ValueError("Give the preset a name.")
    normalised = _kz_custom_from_config(custom, _kz_new_context({}))
    if not _kz_custom_has_content(normalised):
        raise ValueError("Fill in the Custom RPC card before saving a preset.")
    start = _kz_clean(normalised.get("timestampsStart"), 48)
    stop = _kz_clean(normalised.get("timestampsStop"), 48)
    created = base.get("createdAt")
    now = now_ms()
    return {
        "id": _kz_clean(base.get("id"), 64) or "kz-" + uuid.uuid4().hex[:12],
        "name": name,
        "custom": normalised,
        "timestamp": (
            {"mode": "absolute", "start": start, "stop": stop}
            if start or stop
            else {"mode": "none"}
        ),
        "sourceTitle": name,
        "createdAt": created if isinstance(created, (int, float)) else now,
        "updatedAt": now,
        "author": _kz_clean(base.get("author"), 40) or "You",
        "tag": _kz_clean(base.get("tag"), 24) or "Saved",
        "emoji": _kz_clean(base.get("emoji"), 8) or "⭐",
        "gradient": _kz_clean(base.get("gradient"), 160)
        or KIZZEY_PRESET_GRADIENTS[number % len(KIZZEY_PRESET_GRADIENTS)],
    }


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
    """One Discord gateway socket, owned by exactly one saved account."""

    def __init__(self, account_id: str = "") -> None:
        self.account_id = str(account_id or "")
        self.lock = threading.RLock()
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.keep_running = True
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

    def _id(self) -> str:
        if self.account_id:
            return self.account_id
        return STORE.active_account_id() if STORE else ""

    def gateway_record(self) -> dict | None:
        """The per-account gateway record, created on first use."""
        if not STORE:
            return None
        account_id = self._id()
        if not account_id:
            return None
        with STORE.lock:
            gateways = STORE.state.setdefault("gateways", {})
            record = gateways.get(account_id)
            if not isinstance(record, dict):
                record = default_gateway_record()
                gateways[account_id] = record
            return record

    def set_gateway_state(self, state: str, **kwargs) -> None:
        record = self.gateway_record()
        if record is None:
            return
        with STORE.lock:
            record["state"] = state
            record["connected"] = bool(self.connected)
            record["tokenSet"] = bool(self.token)
            for key, value in kwargs.items():
                record[key] = value
            STORE.sync_focused()
        self._publish_gateway()

    def _publish_gateway(self) -> None:
        """Push a live update; only the focused account may drive the UI slot."""
        if not STORE:
            return
        account_id = self._id()
        focused = STORE.active_account_id()
        if account_id and account_id == focused:
            with STORE.lock:
                snapshot = copy.deepcopy(STORE.state["gateway"])
            STORE.publish({"type": "gateway", "gateway": snapshot, "accountId": account_id})
        else:
            # Background sockets still update the account list, so send full state.
            STORE.broadcast_state()

    def _store_latency(self, latency: int) -> None:
        record = self.gateway_record()
        if record is None:
            return
        with STORE.lock:
            record["latency"] = max(0, int(latency))
            STORE.sync_focused()

    def start(self, token: str) -> None:
        with self.lock:
            self.stop_locked()
            if not token:
                return
            self.token = token
            self.keep_running = True
            self.stop_event = threading.Event()
            self.ready = False
            self.sequence = None
            self.started_at = now_ms()
            self.thread = threading.Thread(
                target=self.run, name=f"discord-gateway-{self._id() or 'main'}", daemon=True
            )
            self.thread.start()

    def stop(self) -> None:
        with self.lock:
            self.stop_locked()

    def stop_locked(self) -> None:
        self.stop_event.set()
        self.keep_running = False
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
        self.set_gateway_state("offline", latency=None)

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
                        account_id = self._id()
                        error_text = "Discord rejected the saved token. Add a fresh token in Discord accounts."
                        if account_id:
                            STORE.mark_account_auth_failed(account_id, error_text)
                        record = self.gateway_record()
                        if record is not None:
                            with STORE.lock:
                                record.update(
                                    {
                                        "connected": False,
                                        "state": "error",
                                        "error": error_text,
                                        "latency": None,
                                        "tokenSet": False,
                                    }
                                )
                                STORE.sync_focused()
                        self.token = ""
                        self.keep_running = False
                        STORE.broadcast_state()
                        self.stop_event.set()
                        break
                self.ready = False
                if STORE and not STORE.state.get("settings", {}).get("keepAlive", True):
                    self.keep_running = False
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
                    self.keep_running = False
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
        self.set_gateway_state("offline" if self.stop_event.is_set() and self._account_token() else "error")

    def _account_token(self) -> str:
        account_id = self._id()
        if not account_id or not STORE:
            return ""
        account = STORE.account_by_id(account_id, include_token=True)
        return clean_discord_token((account or {}).get("token"))

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
                if STORE and self.last_heartbeat:
                    self._store_latency(max(0, int((mono() - self.last_heartbeat) * 1000)))
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
                    if user and STORE and self._id() == STORE.active_account_id():
                        # Only the focused account owns the legacy identity slot.
                        with STORE.lock:
                            STORE.state["account"] = normalize_user(user)
                    record = self.gateway_record() or {}
                    self.set_gateway_state(
                        "connected",
                        connected=True,
                        error="",
                        since=now_ms(),
                        reconnects=record.get("reconnects", 0),
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
                    self._store_latency(max(0, int((mono() - self.last_heartbeat) * 1000)))
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


def wanted_gateways() -> dict[str, str]:
    """Accounts that must hold a gateway socket right now.

    An account needs a live gateway only when it is pushing Rich Presence or is
    referenced by an enabled mirror relay. Everything else stays disconnected so
    idle accounts never sit in Discord's session list.
    """
    if STORE is None:
        return {}
    wanted: dict[str, str] = {}
    with STORE.lock:
        presences = STORE.state.get("presences") or {}
        for account_id, record in presences.items():
            if isinstance(record, dict) and record.get("active"):
                wanted[str(account_id)] = ""
        mirror = STORE.state.get("mirror") or {}
        if mirror.get("enabled"):
            for rule in mirror.get("rules") or []:
                if not isinstance(rule, dict) or not rule.get("enabled"):
                    continue
                for key in ("sourceAccountId", "destAccountId"):
                    account_id = str(rule.get(key) or "")
                    if account_id:
                        wanted.setdefault(account_id, "")
    for account_id in list(wanted):
        account = STORE.account_by_id(account_id, include_token=True)
        token = clean_discord_token((account or {}).get("token"))
        if token:
            wanted[account_id] = token
        else:
            wanted.pop(account_id, None)
    return wanted


class GatewayPool:
    """Owns one `DiscordGateway` socket per account that needs one."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.gateways: dict[str, DiscordGateway] = {}

    # -- lookups ----------------------------------------------------------
    def get(self, account_id: str = "") -> DiscordGateway:
        account_id = str(account_id or "") or (STORE.active_account_id() if STORE else "")
        with self.lock:
            gateway = self.gateways.get(account_id)
            if gateway is None or gateway.account_id != account_id:
                gateway = DiscordGateway(account_id)
                self.gateways[account_id] = gateway
            return gateway

    def running(self, account_id: str = "") -> bool:
        account_id = str(account_id or "") or (STORE.active_account_id() if STORE else "")
        with self.lock:
            gateway = self.gateways.get(account_id)
        return bool(gateway and gateway.connected)

    def active_ids(self) -> list[str]:
        with self.lock:
            items = list(self.gateways.items())
        return [account_id for account_id, gateway in items if gateway.connected]

    @staticmethod
    def token_for(account_id: str) -> str:
        if not account_id or STORE is None:
            return ""
        account = STORE.account_by_id(account_id, include_token=True)
        return clean_discord_token((account or {}).get("token"))

    # -- lifecycle --------------------------------------------------------
    def ensure(self, account_id: str = "") -> DiscordGateway:
        """Return the account's socket, starting it if the account has a token."""
        account_id = str(account_id or "") or (STORE.active_account_id() if STORE else "")
        gateway = self.get(account_id)
        if account_id and not gateway.thread:
            token = self.token_for(account_id)
            if token:
                gateway.start(token)
        return gateway

    def start(self, token: str, account_id: str = "") -> None:
        account_id = str(account_id or "") or (STORE.active_account_id() if STORE else "")
        self.get(account_id).start(token)

    def stop(self, account_id: str = "") -> None:
        account_id = str(account_id or "") or (STORE.active_account_id() if STORE else "")
        with self.lock:
            gateway = self.gateways.pop(account_id, None)
        if gateway:
            gateway.stop()

    def stop_all(self) -> None:
        with self.lock:
            gateways = list(self.gateways.values())
            self.gateways.clear()
        for gateway in gateways:
            gateway.stop()

    def restart(self, account_id: str = "") -> None:
        """Drop an account's socket so the next reconcile reconnects with its token."""
        account_id = str(account_id or "") or (STORE.active_account_id() if STORE else "")
        if not account_id:
            return
        with self.lock:
            gateway = self.gateways.get(account_id)
        if gateway and (gateway.thread or gateway.token):
            self.stop(account_id)
        self.reconcile()

    def send_presence(self, presence: dict | None, account_id: str = "") -> None:
        account_id = str(account_id or "") or (STORE.active_account_id() if STORE else "")
        gateway = self.get(account_id)
        gateway.send_presence(presence)

    def reconcile(self) -> None:
        """Start and stop sockets so the pool matches `wanted_gateways()`.

        Never call this while holding `STORE.lock`: stopping a socket joins its
        thread, which itself needs that lock to publish state.
        """
        wanted = wanted_gateways()
        with self.lock:
            stale = [
                account_id
                for account_id, gateway in self.gateways.items()
                if account_id not in wanted or (not gateway.keep_running and not gateway.thread)
            ]
            missing = [
                (account_id, token)
                for account_id, token in wanted.items()
                if account_id not in self.gateways
                or (self.gateways[account_id].keep_running and not self.gateways[account_id].thread)
            ]
        for account_id in stale:
            with self.lock:
                gateway = self.gateways.pop(account_id, None)
            if gateway:
                gateway.stop()
        for account_id, token in missing:
            self.get(account_id).start(token)


GATEWAY = GatewayPool()


# ---------------------------------------------------------------------------
# Message mirror
# ---------------------------------------------------------------------------


def fetch_mirror_channel(token: str, channel_id: str) -> dict:
    channel_id = _snowflake_text(channel_id)
    if not channel_id:
        raise ValueError("Channel IDs are numeric. Enable Developer Mode in Discord and copy the ID.")
    channel = discord_api(f"/channels/{channel_id}", token)
    if not isinstance(channel, dict):
        raise DiscordError(404, "Discord did not return that channel.")
    channel_type = channel.get("type")
    allowed = {0, 1, 3, 5, 10, 11, 12, 15}
    if channel_type not in allowed:
        raise ValueError("Choose a text channel, announcement channel, thread or direct message.")
    recipients = channel.get("recipients") or []
    if channel_type in (1, 3):
        names = [
            str(item.get("global_name") or item.get("username") or "Unknown")
            for item in recipients
            if isinstance(item, dict)
        ]
        if channel_type == 1:
            label = "DM · " + (names[0] if names else "Direct message")
        else:
            label = "Group DM · " + (channel.get("name") or ", ".join(names[:3]) or "Group")
    else:
        name = str(channel.get("name") or channel_id)
        label = "#" + name
    return {
        "id": str(channel.get("id") or channel_id),
        "label": label[:120],
        "name": str(channel.get("name") or ""),
        "type": channel_type,
        "guildId": str(channel.get("guild_id") or ""),
    }


def _mirror_webhook_for(rule_id: str) -> dict | None:
    if not rule_id or STORE is None:
        return None
    with STORE.lock:
        webhooks = STORE.secret.get("mirrorWebhooks")
        raw = webhooks.get(rule_id) if isinstance(webhooks, dict) else None
        record = _coerce_mirror_webhook(raw)
        return copy.deepcopy(record) if record else None


def _store_mirror_webhook(rule_id: str, record: dict) -> None:
    assert STORE is not None
    with STORE.lock:
        webhooks = STORE.secret.setdefault("mirrorWebhooks", {})
        if not isinstance(webhooks, dict):
            webhooks = {}
            STORE.secret["mirrorWebhooks"] = webhooks
        webhooks[rule_id] = copy.deepcopy(record)
        STORE.save()


def _forget_mirror_webhook(rule_id: str) -> None:
    assert STORE is not None
    with STORE.lock:
        webhooks = STORE.secret.get("mirrorWebhooks")
        if isinstance(webhooks, dict) and rule_id in webhooks:
            webhooks.pop(rule_id, None)
            STORE.save()


def _delete_discord_webhook(record: dict) -> bool:
    """Delete a webhook with its own token. True means local cleanup is safe."""
    webhook_id = _snowflake_text((record or {}).get("id"))
    token = str((record or {}).get("token") or "").strip()
    if not webhook_id or not token:
        return True
    try:
        discord_api(f"/webhooks/{webhook_id}/{token}", "", method="DELETE", timeout=6)
        return True
    except DiscordError as exc:
        if exc.status in (401, 403, 404):
            return True
        if STORE:
            STORE.log("WARN", "Mirror", f"Could not delete a managed webhook: {_scrub(exc.message)}")
        return False
    except Exception as exc:
        if STORE:
            STORE.log("WARN", "Mirror", f"Could not delete a managed webhook: {_scrub(exc)}")
        return False


def delete_mirror_webhook(rule_id: str, *, remote: bool = True, forget_on_failure: bool = False) -> None:
    with MIRROR_WEBHOOK_LOCK:
        record = _mirror_webhook_for(rule_id)
        if not record:
            return
        if remote and not _delete_discord_webhook(record):
            if forget_on_failure:
                _forget_mirror_webhook(rule_id)
            return
        _forget_mirror_webhook(rule_id)


def purge_mirror_webhooks(*, forget_on_failure: bool = False) -> int:
    count = 0
    with MIRROR_WEBHOOK_LOCK:
        if STORE is None:
            return 0
        with STORE.lock:
            webhooks = STORE.secret.get("mirrorWebhooks")
            rule_ids = list(webhooks.keys()) if isinstance(webhooks, dict) else []
        for rule_id in rule_ids:
            delete_mirror_webhook(str(rule_id), remote=True, forget_on_failure=forget_on_failure)
            count += 1
    return count


def execute_discord_webhook(record: dict, payload: dict) -> dict | None:
    webhook_id = _snowflake_text((record or {}).get("id"))
    token = str((record or {}).get("token") or "").strip()
    if not webhook_id or not token:
        raise ValueError("The relay webhook is missing. Edit the relay and save it again.")
    return discord_api(
        f"/webhooks/{webhook_id}/{token}?wait=true",
        "",
        method="POST",
        body=payload,
        timeout=20,
    )


def ensure_mirror_webhook(rule: dict, dest_token: str, dest_info: dict | None = None) -> dict:
    assert STORE is not None
    rule_id = str((rule or {}).get("id") or "")
    dest_channel = _snowflake_text((rule or {}).get("destChannel"))
    if not rule_id or not dest_channel:
        raise ValueError("That mirror rule is missing its destination.")
    with MIRROR_WEBHOOK_LOCK:
        existing = _mirror_webhook_for(rule_id)
        if existing and str(existing.get("channelId") or "") == dest_channel:
            return existing
        if existing:
            delete_mirror_webhook(rule_id, remote=True)
            if _mirror_webhook_for(rule_id):
                raise ValueError("The old relay webhook could not be removed. Delete it in Discord and try again.")
        if not dest_token:
            raise ValueError("The destination account needs a Discord token for webhook mode.")
        if dest_info is None:
            dest_info = fetch_mirror_channel(dest_token, dest_channel)
        if int(dest_info.get("type") or 0) not in (0, 5):
            raise ValueError(
                "Webhook mode needs a server text or announcement channel as the destination. "
                "Use normal mode for DMs, group DMs and threads."
            )
        name = re.sub(r"[\x00-\x1f\x7f]", "", f"Kizzey · {rule.get('name') or 'Message relay'}")
        name = " ".join(name.split()).strip()[:80] or "Kizzey mirror"
        try:
            created = discord_api(
                f"/channels/{dest_channel}/webhooks",
                dest_token,
                method="POST",
                body={"name": name},
                timeout=15,
            )
        except DiscordError as exc:
            if exc.status in (401, 403, 404):
                raise ValueError(
                    "Webhook mode could not create a webhook in the destination channel. "
                    "The destination account needs Manage Webhooks permission."
                ) from None
            raise
        record = _coerce_mirror_webhook(
            {
                "id": (created or {}).get("id") if isinstance(created, dict) else "",
                "token": (created or {}).get("token") if isinstance(created, dict) else "",
                "channelId": (created or {}).get("channel_id") if isinstance(created, dict) else dest_channel,
                "name": (created or {}).get("name") if isinstance(created, dict) else name,
            }
        )
        if not record:
            raise DiscordError(0, "Discord did not return a usable webhook.")
        _store_mirror_webhook(rule_id, record)
        STORE.log("INFO", "Mirror", "Created a managed webhook for a relay.")
        return copy.deepcopy(record)


def public_mirror_rule(rule: dict) -> dict:
    result = copy.deepcopy(rule or {})
    result["mode"] = normalize_mirror_mode(result.get("mode"))
    rule_id = str(result.get("id") or "")
    record = _mirror_webhook_for(rule_id) if result["mode"] == "webhook" else None
    result["webhookSet"] = bool(
        record and str(record.get("channelId") or "") == str(result.get("destChannel") or "")
    )
    return result


def public_mirror_state() -> dict:
    with STORE.lock:
        mirror = normalize_mirror_state(STORE.state.get("mirror"))
    mirror["rules"] = [public_mirror_rule(rule) for rule in mirror.get("rules", [])]
    return mirror


def mirror_should_skip(message: dict, rule: dict, source_user_id: str = "") -> tuple[bool, str]:
    if not isinstance(message, dict):
        return True, "malformed"
    author = message.get("author") if isinstance(message.get("author"), dict) else {}
    content = str(message.get("content") or "")
    if MIRROR_MARK in content:
        return True, "loop"
    if int(message.get("type") or 0) not in (0, 19):
        return True, "system"
    if not rule.get("includeBots") and (author.get("bot") or author.get("system")):
        return True, "bot"
    if not rule.get("includeOwn") and source_user_id and str(author.get("id") or "") == source_user_id:
        return True, "own"
    return False, ""


def mirror_author(message: dict) -> dict:
    author = message.get("author") if isinstance(message, dict) else None
    return author if isinstance(author, dict) else {}


def mirror_sent_markup(message: dict) -> str:
    sent = parse_timestamp((message or {}).get("timestamp"))
    if not sent:
        return ""
    return f"<t:{int(sent / 1000)}:f>"


def mirror_author_avatar_url(message: dict) -> str:
    author = mirror_author(message)
    user_id = str(author.get("id") or "").strip()
    avatar = str(author.get("avatar") or "").strip()
    if not user_id:
        return ""
    if avatar:
        ext = "gif" if avatar.startswith("a_") else "png"
        return f"https://cdn.discordapp.com/avatars/{user_id}/{avatar}.{ext}?size=128"
    try:
        index = (int(user_id) >> 22) % 6
    except Exception:
        index = 0
    return f"https://cdn.discordapp.com/embed/avatars/{index}.png"


def mirror_webhook_username(message: dict) -> str:
    author = mirror_author(message)
    name = str(author.get("global_name") or author.get("username") or "Discord user")
    name = re.sub(r"[\x00-\x1f\x7f]", "", name)
    name = " ".join(name.split()).strip()[:80]
    return name or "Discord user"


def mirror_extra_parts(message: dict, rule: dict) -> list[str]:
    body = str(message.get("content") or "").strip()
    extras: list[str] = []
    if rule.get("includeAttachments", True):
        for attachment in message.get("attachments") or []:
            if not isinstance(attachment, dict):
                continue
            url = str(attachment.get("url") or attachment.get("proxy_url") or "").strip()
            if url and url not in body:
                extras.append(f"<{url}>")
    if rule.get("includeEmbeds", True):
        for embed in message.get("embeds") or []:
            if not isinstance(embed, dict):
                continue
            url = str(embed.get("url") or "").strip()
            if url and url not in body and all(url not in item for item in extras):
                extras.append(f"<{url}>")
    stickers = []
    for sticker in message.get("sticker_items") or []:
        if isinstance(sticker, dict) and sticker.get("name"):
            stickers.append(str(sticker["name"]))
    if stickers:
        extras.append("[Sticker: " + ", ".join(stickers[:3]) + "]")
    return extras


def _finish_mirror_content(parts: list[str]) -> str:
    content = "\n".join(part for part in parts if part).strip()
    if not content:
        return ""
    limit = 1988 - len(MIRROR_MARK)
    if len(content) > limit:
        content = content[:limit].rstrip()
    return content + MIRROR_MARK


def build_mirror_content(message: dict, rule: dict) -> str:
    author = mirror_author(message)
    display = str(author.get("global_name") or author.get("username") or "Discord user").strip()
    username = str(author.get("username") or "").strip()
    label = display or "Discord user"
    if username and username.lower() not in label.lower():
        label += f" (@{username})"
    sent = mirror_sent_markup(message)
    header = f"**{label}**" + (f" · {sent}" if sent else "")
    body = str(message.get("content") or "").strip()
    extras = mirror_extra_parts(message, rule)
    if not body and not extras:
        return ""
    return _finish_mirror_content([header, body, *extras])


def build_mirror_webhook_payload(message: dict, rule: dict) -> dict | None:
    body = str(message.get("content") or "").strip()
    extras = mirror_extra_parts(message, rule)
    if not body and not extras:
        return None
    content = _finish_mirror_content([body, *extras])
    if not content:
        return None
    payload = {
        "username": mirror_webhook_username(message),
        "content": content,
        "allowed_mentions": {"parse": []},
    }
    avatar = mirror_author_avatar_url(message)
    if avatar:
        payload["avatar_url"] = avatar
    return payload


class MessageMirror:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.run_lock = threading.RLock()
        self.stop_event = threading.Event()
        self.wake = threading.Event()
        self.thread: threading.Thread | None = None
        self._last_post_at = 0.0

    def start(self) -> None:
        with self.lock:
            if self.thread and self.thread.is_alive():
                return
            self.stop_event.clear()
            self.thread = threading.Thread(target=self._run, name="message-mirror", daemon=True)
            self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.wake.set()
        thread = self.thread
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=3)
        self.thread = None

    def kick(self) -> None:
        self.wake.set()

    def _run(self) -> None:
        while not self.stop_event.is_set():
            wait = MIRROR_DEFAULT_INTERVAL
            try:
                with STORE.lock:
                    mirror = normalize_mirror_state(STORE.state.get("mirror"))
                    wait = int(mirror.get("interval") or MIRROR_DEFAULT_INTERVAL)
                    enabled = bool(mirror.get("enabled"))
                    rule_ids = [rule["id"] for rule in mirror.get("rules", []) if rule.get("enabled")]
                if enabled:
                    for rule_id in rule_ids:
                        if self.stop_event.is_set():
                            break
                        try:
                            self.run_rule(rule_id, manual=False)
                        except Exception as exc:
                            rule = _mirror_rule_by_id(rule_id) or {}
                            if STORE:
                                STORE.log(
                                    "WARN",
                                    "Mirror",
                                    f"{rule.get('name') or 'Relay'}: {_scrub(exc)}",
                                )
                self.wake.wait(timeout=max(5, min(300, wait)))
                self.wake.clear()
            except Exception as exc:
                if STORE:
                    STORE.log("ERROR", "Mirror", f"Mirror loop failed: {_scrub(exc)}")
                if self.stop_event.wait(15):
                    break

    def _rule_snapshot(self, rule_id: str) -> dict | None:
        with STORE.lock:
            for rule in STORE.state.setdefault("mirror", _default_mirror_state()).get("rules", []):
                if rule.get("id") == rule_id:
                    result = copy.deepcopy(rule)
                    source = STORE.account_by_id(result.get("sourceAccountId", ""), include_token=True)
                    dest = STORE.account_by_id(result.get("destAccountId", ""), include_token=True)
                    result["_sourceToken"] = clean_discord_token((source or {}).get("token"))
                    result["_destToken"] = clean_discord_token((dest or {}).get("token"))
                    result["_sourceUserId"] = str(((source or {}).get("user") or {}).get("id") or "")
                    result["_sourceName"] = str(((source or {}).get("user") or {}).get("displayName") or "Source account")
                    result["_destName"] = str(((dest or {}).get("user") or {}).get("displayName") or "Destination account")
                    return result
        return None

    def _update_rule(self, rule_id: str, **changes) -> dict | None:
        with STORE.lock:
            for rule in STORE.state.setdefault("mirror", _default_mirror_state()).get("rules", []):
                if rule.get("id") == rule_id:
                    rule.update(changes)
                    rule["updatedAt"] = now_ms()
                    mirror = STORE.state.setdefault("mirror", _default_mirror_state())
                    mirror["lastRunAt"] = now_ms()
                    if changes.get("lastError") == "":
                        mirror["lastError"] = ""
                    STORE.save()
                    return copy.deepcopy(rule)
        return None

    def _record_error(self, rule: dict, message: str, *, retry_seconds: float | None = None) -> dict:
        message = _scrub(message)
        failures = int(rule.get("failures") or 0) + 1
        if retry_seconds is None:
            retry_seconds = min(300, 15 * (2 ** min(4, failures - 1)))
        retry_after = now_ms() + int(max(5, retry_seconds) * 1000)
        previous = str(rule.get("lastError") or "")
        updated = self._update_rule(
            rule["id"],
            lastError=message[:260],
            failures=failures,
            retryAfter=retry_after,
            lastRunAt=now_ms(),
        ) or rule
        with STORE.lock:
            mirror = STORE.state.setdefault("mirror", _default_mirror_state())
            mirror["lastError"] = message[:260]
            mirror["lastRunAt"] = now_ms()
            STORE.save()
        if STORE and message != previous:
            STORE.log("WARN", "Mirror", f"{rule.get('name') or 'Relay'}: {message}")
        return updated

    def prime_rule(self, rule_id: str) -> dict:
        snapshot = self._rule_snapshot(rule_id)
        if not snapshot:
            raise ValueError("That mirror rule no longer exists.")
        if not snapshot.get("_sourceToken"):
            raise ValueError("The source account needs a Discord token.")
        source = snapshot["sourceChannel"]
        token = snapshot["_sourceToken"]
        try:
            rows = discord_api(f"/channels/{source}/messages?limit=1", token, timeout=15)
        except DiscordError as exc:
            self._record_error(snapshot, f"Could not read the source channel: {exc.message}", retry_seconds=20)
            raise
        latest = ""
        if isinstance(rows, list) and rows:
            latest = _snowflake_text((rows[0] or {}).get("id"))
        self._update_rule(
            rule_id,
            primed=True,
            lastSeenId=latest,
            lastRunAt=now_ms(),
            lastError="",
            failures=0,
            retryAfter=0,
        )
        return {"ruleId": rule_id, "primed": True, "lastSeenId": latest, "mirrored": 0, "skipped": 0}

    def run_rule(self, rule_id: str, manual: bool = False) -> dict:
        with self.run_lock:
            snapshot = self._rule_snapshot(rule_id)
            if not snapshot:
                raise ValueError("That mirror rule no longer exists.")
            if not manual:
                if not snapshot.get("enabled"):
                    return {"ruleId": rule_id, "mirrored": 0, "skipped": 0, "disabled": True}
                retry_after = int(snapshot.get("retryAfter") or 0)
                if retry_after and retry_after > now_ms():
                    return {"ruleId": rule_id, "mirrored": 0, "skipped": 0, "cooldown": retry_after}
            if not snapshot.get("_sourceToken"):
                self._record_error(snapshot, "The source account needs a token.", retry_seconds=60)
                raise ValueError("The source account needs a Discord token.")
            if not snapshot.get("_destToken"):
                self._record_error(snapshot, "The destination account needs a token.", retry_seconds=60)
                raise ValueError("The destination account needs a Discord token.")
            if not snapshot.get("primed"):
                result = self.prime_rule(rule_id)
                result["manual"] = manual
                return result

            mode = normalize_mirror_mode(snapshot.get("mode"))
            webhook = None
            if mode == "webhook":
                try:
                    webhook = ensure_mirror_webhook(snapshot, snapshot["_destToken"])
                except (DiscordError, ValueError) as exc:
                    message = exc.message if isinstance(exc, DiscordError) else str(exc)
                    updated = self._record_error(
                        snapshot, f"Webhook mode is not ready: {_scrub(message)}", retry_seconds=30
                    )
                    return {
                        "ruleId": rule_id,
                        "mirrored": 0,
                        "skipped": 0,
                        "error": updated.get("lastError"),
                        "retryAfter": updated.get("retryAfter"),
                    }

            source = snapshot["sourceChannel"]
            cursor = snapshot.get("lastSeenId") or ""
            path = f"/channels/{source}/messages?limit=50"
            if cursor:
                path += f"&after={cursor}"
            try:
                rows = discord_api(path, snapshot["_sourceToken"], timeout=15)
            except DiscordError as exc:
                retry = None
                if exc.status == 429 and isinstance(exc.data, dict):
                    try:
                        retry = float(exc.data.get("retry_after") or 0)
                    except Exception:
                        retry = None
                updated = self._record_error(snapshot, f"Could not read the source channel: {exc.message}", retry_seconds=retry)
                return {"ruleId": rule_id, "mirrored": 0, "skipped": 0, "error": updated.get("lastError"), "retryAfter": updated.get("retryAfter")}
            if not isinstance(rows, list):
                rows = []
            rows = [row for row in rows if isinstance(row, dict) and _snowflake_text(row.get("id"))]
            rows.sort(key=lambda row: int(row.get("id")))
            rows = rows[:MIRROR_MAX_MESSAGES]
            mirrored = 0
            skipped = 0
            current_cursor = cursor
            for message in rows:
                message_id = _snowflake_text(message.get("id"))
                if not message_id:
                    continue
                skip, reason = mirror_should_skip(message, snapshot, snapshot.get("_sourceUserId", ""))
                payload = None
                content = ""
                if not skip:
                    if mode == "webhook":
                        payload = build_mirror_webhook_payload(message, snapshot)
                        content = str((payload or {}).get("content") or "")
                    else:
                        content = build_mirror_content(message, snapshot)
                if skip or not content:
                    current_cursor = message_id
                    skipped += 1
                    self._update_rule(
                        rule_id,
                        lastSeenId=current_cursor,
                        skipped=int(snapshot.get("skipped") or 0) + skipped,
                        lastRunAt=now_ms(),
                        lastError="",
                        failures=0,
                        retryAfter=0,
                    )
                    continue
                # A message being posted must still belong to the active rule
                # configuration and its accounts must still hold the same
                # tokens; removing or replacing an account mid-run must stop
                # further delivery immediately.
                delay = 1.05 - (time.monotonic() - self._last_post_at)
                if delay > 0 and len(rows) > 1:
                    time.sleep(delay)
                latest_rule = self._rule_snapshot(rule_id)
                if (
                    not latest_rule
                    or (not manual and not latest_rule.get("enabled"))
                    or latest_rule.get("sourceChannel") != source
                    or latest_rule.get("destChannel") != snapshot.get("destChannel")
                    or normalize_mirror_mode(latest_rule.get("mode")) != mode
                    or latest_rule.get("_sourceToken") != snapshot.get("_sourceToken")
                    or latest_rule.get("_destToken") != snapshot.get("_destToken")
                ):
                    break
                try:
                    if mode == "webhook":
                        execute_discord_webhook(webhook, payload)
                    else:
                        discord_api(
                            f"/channels/{snapshot['destChannel']}/messages",
                            snapshot["_destToken"],
                            method="POST",
                            body={"content": content, "allowed_mentions": {"parse": []}},
                            timeout=20,
                        )
                    self._last_post_at = time.monotonic()
                    mirrored += 1
                    current_cursor = message_id
                    self._update_rule(
                        rule_id,
                        lastSeenId=current_cursor,
                        mirrored=int(snapshot.get("mirrored") or 0) + mirrored,
                        lastMirroredAt=now_ms(),
                        lastRunAt=now_ms(),
                        lastError="",
                        failures=0,
                        retryAfter=0,
                    )
                except DiscordError as exc:
                    retry = None
                    if exc.status == 429 and isinstance(exc.data, dict):
                        try:
                            retry = float(exc.data.get("retry_after") or 0)
                        except Exception:
                            retry = None
                    if mode == "webhook" and exc.status == 404:
                        delete_mirror_webhook(rule_id, remote=False)
                    where = "the relay webhook" if mode == "webhook" else "the destination channel"
                    updated = self._record_error(snapshot, f"Could not post to {where}: {exc.message}", retry_seconds=retry)
                    return {
                        "ruleId": rule_id,
                        "mirrored": mirrored,
                        "skipped": skipped,
                        "error": updated.get("lastError"),
                        "retryAfter": updated.get("retryAfter"),
                    }
                except Exception as exc:
                    updated = self._record_error(snapshot, f"Mirror delivery failed: {_scrub(exc)}")
                    return {
                        "ruleId": rule_id,
                        "mirrored": mirrored,
                        "skipped": skipped,
                        "error": updated.get("lastError"),
                        "retryAfter": updated.get("retryAfter"),
                    }
            self._update_rule(rule_id, lastRunAt=now_ms(), lastError="", failures=0, retryAfter=0)
            if mirrored and STORE:
                STORE.log(
                    "INFO",
                    "Mirror",
                    f"{snapshot.get('name') or 'Relay'} forwarded {mirrored} message(s) to {snapshot.get('destLabel')}.",
                )
            return {
                "ruleId": rule_id,
                "mirrored": mirrored,
                "skipped": skipped,
                "lastSeenId": current_cursor,
                "manual": manual,
            }

    def run_rule_public(self, rule_id: str, manual: bool = True) -> dict:
        return self.run_rule(rule_id, manual=manual)


MIRROR = MessageMirror()


def _mirror_rule_by_id(rule_id: str) -> dict | None:
    with STORE.lock:
        for rule in STORE.state.setdefault("mirror", _default_mirror_state()).get("rules", []):
            if rule.get("id") == rule_id:
                return copy.deepcopy(rule)
    return None


def _mirror_token_message(account: dict, role: str) -> str:
    return f"The {role} account needs a fresh Discord token."


def save_mirror_rule(data: dict) -> tuple[dict, str]:
    if not isinstance(data, dict):
        raise ValueError("A mirror rule object is required.")
    rule_id = str(data.get("id") or "").strip()
    existing = _mirror_rule_by_id(rule_id) if rule_id else None
    if rule_id and not existing:
        raise ValueError("That mirror rule no longer exists.")
    source_account_id = str(data.get("sourceAccountId") or (existing or {}).get("sourceAccountId") or "")
    dest_account_id = str(data.get("destAccountId") or (existing or {}).get("destAccountId") or "")
    source_account = STORE.account_by_id(source_account_id, include_token=True)
    dest_account = STORE.account_by_id(dest_account_id, include_token=True)
    if not source_account:
        raise ValueError("Choose a saved source account.")
    if not dest_account:
        raise ValueError("Choose a saved destination account.")
    source_token = clean_discord_token(source_account.get("token"))
    dest_token = clean_discord_token(dest_account.get("token"))
    if not source_token:
        raise ValueError(_mirror_token_message(source_account, "source"))
    if not dest_token:
        raise ValueError(_mirror_token_message(dest_account, "destination"))
    source_channel = _snowflake_text(data.get("sourceChannel") or (existing or {}).get("sourceChannel"))
    dest_channel = _snowflake_text(data.get("destChannel") or (existing or {}).get("destChannel"))
    if not source_channel or not dest_channel:
        raise ValueError("Enter numeric channel IDs for both sides of the mirror.")
    if source_channel == dest_channel:
        raise ValueError("Source and destination must be different channels.")
    source_info = fetch_mirror_channel(source_token, source_channel)
    dest_info = fetch_mirror_channel(dest_token, dest_channel)
    base = existing or {}
    mode = normalize_mirror_mode(data.get("mode") if "mode" in data else base.get("mode"))
    enabled = _mirror_bool(data.get("enabled"), bool(base.get("enabled", True)))
    source_changed = (
        not existing
        or source_channel != str(existing.get("sourceChannel") or "")
        or source_account_id != str(existing.get("sourceAccountId") or "")
    )
    draft = {
        **base,
        "sourceAccountId": source_account_id,
        "sourceChannel": source_channel,
        "sourceLabel": source_info["label"],
        "destAccountId": dest_account_id,
        "destChannel": dest_channel,
        "destLabel": dest_info["label"],
        "mode": mode,
        "enabled": enabled,
        "includeOwn": _mirror_bool(data.get("includeOwn"), bool(base.get("includeOwn", False))),
        "includeBots": _mirror_bool(data.get("includeBots"), bool(base.get("includeBots", False))),
        "includeAttachments": _mirror_bool(
            data.get("includeAttachments"), bool(base.get("includeAttachments", True))
        ),
        "includeEmbeds": _mirror_bool(data.get("includeEmbeds"), bool(base.get("includeEmbeds", True))),
    }
    if "name" in data:
        draft["name"] = str(data.get("name") or "").strip()[:80]
    if not draft.get("name"):
        draft["name"] = f"{source_info['label']} → {dest_info['label']}"[:80]
    if source_changed:
        draft["primed"] = False
        draft["lastSeenId"] = ""
        draft["lastError"] = ""
        draft["lastMirroredAt"] = None
        draft["mirrored"] = 0
        draft["skipped"] = 0
        draft["failures"] = 0
        draft["retryAfter"] = 0
    rule = normalize_mirror_rule(draft, fresh=not existing)
    if not rule:
        raise ValueError("Mirror rule details are invalid.")
    if not existing:
        with STORE.lock:
            if len(normalize_mirror_state(STORE.state.get("mirror")).get("rules", [])) >= MIRROR_RULE_LIMIT:
                raise ValueError(f"You can save up to {MIRROR_RULE_LIMIT} mirror rules.")
    if rule.get("mode") == "webhook":
        if int(dest_info.get("type") or 0) not in (0, 5):
            raise ValueError(
                "Webhook mode needs a server text or announcement channel as the destination. "
                "Use normal mode for DMs, group DMs and threads."
            )
        # Create or reuse the managed webhook before committing the rule, so a
        # permissions failure leaves the old rule untouched.
        ensure_mirror_webhook(rule, dest_token, dest_info)
    with STORE.lock:
        mirror = normalize_mirror_state(STORE.state.get("mirror"))
        rules = mirror["rules"]
        if existing:
            rules = [rule if item.get("id") == rule["id"] else item for item in rules]
        else:
            if len(rules) >= MIRROR_RULE_LIMIT:
                raise ValueError(f"You can save up to {MIRROR_RULE_LIMIT} mirror rules.")
            rules.append(rule)
        mirror["rules"] = rules
        mirror["lastError"] = ""
        STORE.state["mirror"] = mirror
        STORE.save()
    if rule.get("mode") != "webhook" and _mirror_webhook_for(rule["id"]):
        delete_mirror_webhook(rule["id"], remote=True)
    warning = ""
    if source_changed or not rule.get("primed"):
        try:
            MIRROR.prime_rule(rule["id"])
        except (DiscordError, ValueError) as exc:
            message = exc.message if isinstance(exc, DiscordError) else str(exc)
            warning = f"Rule saved, but the source could not be read yet: {_scrub(message)}"
    MIRROR.kick()
    # An enabled rule holds gateways open for both of its accounts.
    GATEWAY.reconcile()
    STORE.log(
        "INFO",
        "Mirror",
        f"{'Updated' if existing else 'Added'} relay “{rule['name']}” ({source_info['label']} → {dest_info['label']}).",
    )
    STORE.broadcast_state()
    return public_mirror_rule(_mirror_rule_by_id(rule["id"]) or rule), warning


def set_mirror_settings(data: dict) -> dict:
    with STORE.lock:
        mirror = normalize_mirror_state(STORE.state.get("mirror"))
        old_enabled = mirror["enabled"]
        if "enabled" in data:
            mirror["enabled"] = _mirror_bool(data.get("enabled"), mirror["enabled"])
        if "interval" in data:
            try:
                mirror["interval"] = int(clamp(int(data.get("interval") or mirror["interval"]), 5, 300))
            except Exception:
                raise ValueError("Mirror interval must be between 5 and 300 seconds.")
        STORE.state["mirror"] = mirror
        STORE.save()
    if mirror["enabled"] != old_enabled:
        STORE.log(
            "INFO",
            "Mirror",
            "Automatic mirroring enabled." if mirror["enabled"] else "Automatic mirroring paused.",
        )
    if mirror["enabled"]:
        MIRROR.kick()
    # Enabling or pausing mirroring changes which accounts need a socket.
    GATEWAY.reconcile()
    STORE.broadcast_state()
    return public_mirror_state()


def delete_mirror_rule(rule_id: str) -> None:
    with STORE.lock:
        mirror = normalize_mirror_state(STORE.state.get("mirror"))
        before = len(mirror["rules"])
        mirror["rules"] = [rule for rule in mirror["rules"] if rule.get("id") != rule_id]
        if len(mirror["rules"]) == before:
            raise ValueError("That mirror rule no longer exists.")
        STORE.state["mirror"] = mirror
        STORE.save()
    delete_mirror_webhook(rule_id, remote=True)
    # The accounts this rule referenced may no longer need a socket.
    GATEWAY.reconcile()
    STORE.log("INFO", "Mirror", "A message relay was removed.")
    STORE.broadcast_state()


def toggle_mirror_rule(rule_id: str, enabled: bool) -> dict:
    warning = ""
    with STORE.lock:
        mirror = normalize_mirror_state(STORE.state.get("mirror"))
        rule = next((item for item in mirror["rules"] if item.get("id") == rule_id), None)
        if not rule:
            raise ValueError("That mirror rule no longer exists.")
        mode = normalize_mirror_mode(rule.get("mode"))
    if enabled and mode == "webhook":
        snapshot = MIRROR._rule_snapshot(rule_id)
        if not snapshot:
            raise ValueError("That mirror rule no longer exists.")
        try:
            ensure_mirror_webhook(snapshot, snapshot.get("_destToken") or "")
        except (DiscordError, ValueError) as exc:
            warning = _scrub(exc.message if isinstance(exc, DiscordError) else str(exc))
            enabled = False
    with STORE.lock:
        mirror = normalize_mirror_state(STORE.state.get("mirror"))
        rule = next((item for item in mirror["rules"] if item.get("id") == rule_id), None)
        if not rule:
            raise ValueError("That mirror rule no longer exists.")
        rule["enabled"] = bool(enabled)
        if enabled:
            rule["lastError"] = ""
            rule["failures"] = 0
            rule["retryAfter"] = 0
        elif warning:
            rule["lastError"] = warning[:260]
        STORE.state["mirror"] = mirror
        STORE.save()
    if enabled and not (_mirror_rule_by_id(rule_id) or {}).get("primed"):
        try:
            MIRROR.prime_rule(rule_id)
        except (DiscordError, ValueError) as exc:
            warning = _scrub(exc.message if isinstance(exc, DiscordError) else str(exc))
    MIRROR.kick()
    GATEWAY.reconcile()
    STORE.log("INFO", "Mirror", f"Relay {'resumed' if enabled else 'paused'}.")
    STORE.broadcast_state()
    updated = public_mirror_rule(_mirror_rule_by_id(rule_id) or {})
    return {"rule": updated, "warning": warning}


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


def presence_record(account_id: str = "") -> dict | None:
    """Return the Rich Presence slot for one account, creating it if needed."""
    assert STORE is not None
    account_id = str(account_id or "") or STORE.active_account_id()
    if not account_id:
        return None
    presences = STORE.state.setdefault("presences", {})
    record = presences.get(account_id)
    if not isinstance(record, dict):
        record = empty_presence()
        presences[account_id] = record
    return record


def send_current_presence(
    store: Store, *, force: bool = False, cycle_index: int | None = None, account_id: str = ""
) -> dict | None:
    account_id = str(account_id or "") or store.active_account_id()
    if not account_id:
        return None
    with store.lock:
        record = presence_record(account_id)
        if record is None:
            return None
        active = record.get("active")
        if not active:
            return None
        kind = active.get("kind")
        started = record.get("startedAt") or now_ms()
        if cycle_index is not None:
            record["cycleIndex"] = cycle_index
        idx = cycle_index if cycle_index is not None else record.get("cycleIndex", 0)
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
        record["activities"] = activities
        record["updatedAt"] = now_ms()
        record["info"] = presence_public(kind, started, activities, idx)
        store.sync_focused()
        focused = account_id == store.active_account_id()
        snapshot = copy.deepcopy(store.state["presence"]) if focused else None
        gateway_snapshot = copy.deepcopy(store.state["gateway"]) if focused else None
    # Opening the socket for a background account is fine: each account owns its
    # own connection, so several presences can run at the same time.
    GATEWAY.ensure(account_id)
    GATEWAY.send_presence(payload, account_id)
    store.save()
    if focused:
        store.publish({"type": "presence", "presence": snapshot, "gateway": gateway_snapshot})
    else:
        store.broadcast_state()
    return payload


# ---------------------------------------------------------------------------
# Ticker
# ---------------------------------------------------------------------------


class Ticker:
    def __init__(self) -> None:
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, name="kizzey-ticker", daemon=True)
        # Per-account bookkeeping: every running presence rotates on its own clock.
        self.last_sent: dict[str, float] = {}
        self.last_template: dict[str, str] = {}
        self.last_cycle: dict[str, int] = {}

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
            account_ids = [str(key) for key in (STORE.state.get("presences") or {})]
        for account_id in account_ids:
            try:
                self._tick_account(account_id)
            except Exception:
                STORE.log("WARN", "Ticker", traceback.format_exc(limit=2))

    def _tick_account(self, account_id: str) -> None:
        assert STORE is not None
        with STORE.lock:
            presence = (STORE.state.get("presences") or {}).get(account_id) or {}
            active = presence.get("active")
            if not active:
                self.last_sent.pop(account_id, None)
                self.last_template.pop(account_id, None)
                self.last_cycle.pop(account_id, None)
                return
            kind = active.get("kind")
            started = presence.get("startedAt") or now_ms()
            cfg = dict(STORE.state.get("custom") or {})
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
                if idx != self.last_cycle.get(account_id, -1):
                    self.last_cycle[account_id] = idx
                    send_current_presence(STORE, cycle_index=idx, account_id=account_id)
                    return
            # Refresh dynamic clock/date tokens once a minute when running.
            now = time.time()
            if kind == "custom" and now - self.last_sent.get(account_id, 0.0) >= 60:
                rendered = expand_template(cfg.get("name", ""), STORE.state) + "|" + expand_template(
                    cfg.get("details", ""), STORE.state
                ) + "|" + expand_template(cfg.get("state", ""), STORE.state)
                if rendered != self.last_template.get(account_id, ""):
                    self.last_template[account_id] = rendered
                    self.last_sent[account_id] = now
                    send_current_presence(STORE, force=True, account_id=account_id)

    def run_automation(self) -> None:
        """Start a scheduled presence when its weekday/time matches.

        Automations are intentionally conservative: an already-running presence
        is never replaced, so a hand-started card always wins over a schedule.
        Schedules only ever drive the focused account.
        """
        assert STORE is not None
        focused = STORE.active_account_id()
        if not focused or not STORE.active_token():
            return
        data = STORE.state.get("automation") or {}
        if not data.get("enabled"):
            return
        now = dt.datetime.now()
        minute_key = now.strftime("%Y-%m-%dT%H:%M")
        with STORE.lock:
            focused_record = (STORE.state.get("presences") or {}).get(focused) or {}
            if focused_record.get("active"):
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


def _validated_account_user(token: str, account_id: str = "") -> dict:
    try:
        return validate_token(token)
    except DiscordError as exc:
        safe = safe_auth_error(exc.message, token)
        if exc.status == 401 and account_id:
            STORE.mark_account_auth_failed(
                account_id, "Discord rejected this token. Add a fresh token for the account."
            )
        raise DiscordError(exc.status, safe, exc.data) from None


def save_discord_account(token: str, make_active: bool = True) -> tuple[dict, bool, dict]:
    assert STORE is not None
    token = clean_discord_token(token)
    if not token:
        raise DiscordError(401, "Paste a Discord account token first.")
    user = _validated_account_user(token)
    account, created = STORE.upsert_account(token, user)
    if make_active or STORE.active_account_id() == account["id"]:
        # Replacing the token of the live account must restart the gateway even
        # when the caller did not ask to switch; otherwise the old socket would
        # keep using credentials that no longer exist.
        activate_discord_account(account["id"], user=user, verify=False)
        GATEWAY.restart(account["id"])
    else:
        STORE.broadcast_state()
    action = "Added" if created else "Updated"
    STORE.log("INFO", "Account", f"{action} Discord account {user['displayName']}.")
    return account, created, user


def activate_discord_account(account_id: str, user: dict | None = None, verify: bool = True) -> dict:
    assert STORE is not None
    account = STORE.account_by_id(account_id, include_token=True)
    if not account:
        raise DiscordError(404, "That Discord account is not saved.")
    token = clean_discord_token(account.get("token"))
    if not token:
        raise DiscordError(401, "That account needs a fresh Discord token.")
    if verify or not user:
        try:
            user = _validated_account_user(token, account_id)
        except DiscordError:
            # The failed account was marked as needing a fresh token; push the
            # updated public account list so every open client drops the stale row.
            STORE.broadcast_state()
            raise
    account = STORE.activate_account(account_id, user=user)
    # Switching focus only changes which account the UI mirrors. Every account
    # owns its own socket, so nothing that is already running gets stopped.
    with STORE.lock:
        STORE.sync_focused()
    GATEWAY.reconcile()
    display = (account.get("user") or {}).get("displayName") or "Discord account"
    STORE.log("INFO", "Account", f"Switched to {display}.")
    STORE.broadcast_state()
    return account


def sign_in(token: str) -> dict:
    account, _created, user = save_discord_account(token, make_active=True)
    STORE.log("INFO", "Account", f"Signed in as {user['displayName']}.")
    return user


def remove_discord_account(account_id: str) -> dict:
    assert STORE is not None
    account = STORE.account_by_id(account_id)
    if not account:
        raise ValueError("That Discord account is not saved.")
    active_id = STORE.active_account_id()
    was_active = account_id == active_id
    # The account's presence and socket die with it; other accounts keep running.
    with STORE.lock:
        (STORE.state.get("presences") or {}).pop(account_id, None)
        (STORE.state.get("gateways") or {}).pop(account_id, None)
    result = STORE.remove_account(account_id) or {}
    GATEWAY.stop(account_id)
    if was_active:
        with STORE.lock:
            STORE.sync_focused()
    GATEWAY.reconcile()
    display = (account.get("user") or {}).get("displayName") or "Discord account"
    next_account = STORE.account_by_id(result.get("nextId", "")) if result.get("nextId") else None
    if was_active and next_account:
        next_name = (next_account.get("user") or {}).get("displayName") or "the next account"
        STORE.log("INFO", "Account", f"Removed {display}; switched to {next_name}.")
    elif was_active:
        STORE.log("INFO", "Account", f"Removed {display}; no Discord account is active.")
    else:
        STORE.log("INFO", "Account", f"Removed saved Discord account {display}.")
    STORE.broadcast_state()
    return result


def sign_out() -> None:
    assert STORE is not None
    active_id = STORE.active_account_id()
    if active_id:
        remove_discord_account(active_id)
        return
    GATEWAY.stop_all()
    with STORE.lock:
        STORE.secret["token"] = ""
        STORE.secret["tokenSetAt"] = None
        STORE.secret["activeId"] = ""
        STORE.state["account"] = None
        STORE.sync_focused()
    STORE.save()
    STORE.log("INFO", "Account", "Signed out of Discord.")
    STORE.broadcast_state()


# ---------------------------------------------------------------------------
# Discord login (email/username + password)
#
# This mirrors what discord.com itself posts when you sign in: the credentials
# go straight to Discord from this machine, and only the resulting user token is
# kept. Discord may answer with a captcha demand or an MFA ticket; both are
# surfaced as normal errors instead of being swallowed.
# ---------------------------------------------------------------------------

LOGIN_SOURCE = "https://discord.com/login"


def _login_headers() -> dict:
    return {
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/json",
        "Origin": "https://discord.com",
        "Referer": LOGIN_SOURCE,
        "User-Agent": DISCORD_LOGIN_UA,
        "X-Super-Properties": super_properties(),
        "X-Discord-Locale": "en-US",
        "X-Discord-Timezone": "Europe/London",
    }


def _login_post(url: str, body: dict, timeout: float = 25) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=_login_headers(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        info = {}
        try:
            info = json.loads(raw)
        except Exception:
            info = {"message": raw.decode("utf-8", "replace")[:300]}
        if not isinstance(info, dict):
            info = {}
        raise DiscordError(exc.code, _login_error_message(exc.code, info), info) from None
    except urllib.error.URLError as exc:
        raise DiscordError(0, f"Could not reach Discord: {exc.reason}") from None
    except TimeoutError:
        raise DiscordError(0, "Discord took too long to answer. Check your connection and try again.") from None
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except Exception:
        raise DiscordError(502, "Discord returned an unreadable login response.") from None
    return payload if isinstance(payload, dict) else {}


def _login_error_message(status: int, info: dict) -> str:
    retry_after = info.get("retry_after")
    if status == 429 or retry_after:
        try:
            wait = int(float(retry_after)) if retry_after is not None else 0
        except Exception:
            wait = 0
        wait = wait or 60
        return f"Discord is rate limiting this sign-in. Wait {wait} seconds and try again."
    if info.get("captcha_key") or info.get("captcha_sitekey"):
        return (
            "Discord wants a captcha for this sign-in, which this app cannot solve. "
            "Sign in at discord.com in your browser, then paste the token instead."
        )
    message_text = str(info.get("message") or "").strip()
    lowered = message_text.lower()
    if "two factor" in lowered or "two-factor" in lowered or "2fa" in lowered or "mfa" in lowered:
        return "That two-factor code was not accepted. Try the current code from your authenticator app."
    if status == 401 or "invalid" in lowered:
        return "Wrong email/username or password."
    if info.get("mfa") or info.get("mfa_required"):
        return "Discord needs your two-factor code."
    if message_text:
        return message_text[:220]
    if status == 400:
        return "Discord rejected that sign-in. Check the email/username and password."
    return f"Discord returned HTTP {status}."


def discord_password_login(login: str, password: str) -> dict:
    """Sign in with email/username + password.

    Returns ``{"status": "ok", "token": ...}`` or
    ``{"status": "mfa", "ticket": ..., "methods": [...]}``.
    """
    login = str(login or "").strip()
    password = str(password or "")
    if not login:
        raise DiscordError(400, "Enter your Discord email or username.")
    if not password:
        raise DiscordError(400, "Enter your Discord password.")
    payload = _login_post(
        DISCORD_LOGIN_API,
        {
            "login": login,
            "password": password,
            "undelete": False,
            "login_source": None,
            "gift_code_sku_id": None,
            "captcha_key": None,
        },
    )
    token = clean_discord_token(payload.get("token"))
    if token:
        return {"status": "ok", "token": token}
    ticket = str(payload.get("ticket") or "")
    if ticket:
        methods = payload.get("mfa") if isinstance(payload.get("mfa"), list) else []
        return {"status": "mfa", "ticket": ticket, "methods": [str(m) for m in methods]}
    raise DiscordError(502, "Discord did not return a session for that sign-in.")


def discord_mfa_login(ticket: str, code: str) -> str:
    """Finish a login that Discord answered with an MFA ticket."""
    ticket = str(ticket or "")
    code = str(code or "").strip().replace(" ", "")
    if not ticket:
        raise DiscordError(400, "That two-factor step expired. Sign in again.")
    if not code:
        raise DiscordError(400, "Enter the 6-digit code from your authenticator app.")
    payload = _login_post(
        DISCORD_MFA_API,
        {"ticket": ticket, "mfa_type": "totp", "data": code},
    )
    token = clean_discord_token(payload.get("token"))
    if not token:
        raise DiscordError(401, "Discord did not accept that two-factor code.")
    return token


def login_with_password(login: str, password: str) -> dict:
    """Sign in and save the account. Returns the MFA challenge or the user."""
    result = discord_password_login(login, password)
    if result["status"] == "mfa":
        STORE.log("INFO", "Account", "Discord asked for a two-factor code.")
        return {"status": "mfa", "ticket": result["ticket"], "methods": result["methods"]}
    user = sign_in(result["token"])
    STORE.log("INFO", "Account", f"Signed in with a password as {user['displayName']}.")
    return {"status": "ok", "user": user, "account": STORE.active_account_id()}


def login_with_mfa(ticket: str, code: str) -> dict:
    token = discord_mfa_login(ticket, code)
    user = sign_in(token)
    STORE.log("INFO", "Account", f"Signed in with a password as {user['displayName']}.")
    return {"status": "ok", "user": user, "account": STORE.active_account_id()}


def require_gateway_token(account_id: str = "") -> str:
    """Return the account's user token, or explain why Rich Presence is unavailable."""
    assert STORE is not None
    account_id = str(account_id or "") or STORE.active_account_id()
    account = STORE.account_by_id(account_id, include_token=True) if account_id else None
    token = clean_discord_token((account or {}).get("token"))
    if token:
        return token
    raise DiscordError(401, "Connect Discord before starting a presence.")


def stop_presence(kind: str | None = None, quiet: bool = False, account_id: str = "") -> bool:
    assert STORE is not None
    account_id = str(account_id or "") or STORE.active_account_id()
    if not account_id:
        return False
    with STORE.lock:
        record = (STORE.state.get("presences") or {}).get(account_id)
        active = (record or {}).get("active")
        if not active:
            return False
        if kind and active.get("kind") != kind and kind != "all":
            return False
        started = (record or {}).get("startedAt")
        title = active.get("title") or (((record or {}).get("info") or {}).get("title") or "")
        STORE.add_history(
            active.get("kind") or "custom",
            PRESENCE_KINDS.get(active.get("kind"), "Rich Presence"),
            title,
            int(started or now_ms()),
            now_ms(),
        )
        record.clear()
        record.update(empty_presence())
        record["updatedAt"] = now_ms()
        STORE.state["custom"]["status"] = "online"
        if not quiet:
            STORE.log("INFO", "Presence", "Stopped all rich presence.")
        STORE.sync_focused()
        focused = account_id == STORE.active_account_id()
        snapshot = copy.deepcopy(STORE.state["presence"]) if focused else None
        gateway_snapshot = copy.deepcopy(STORE.state["gateway"]) if focused else None
    GATEWAY.send_presence(None, account_id)
    STORE.save()
    # The account may have nothing left running, so its socket can close now.
    GATEWAY.reconcile()
    if focused:
        STORE.publish({"type": "presence", "presence": snapshot, "gateway": gateway_snapshot})
    else:
        STORE.broadcast_state()
    return True


def start_presence(kind: str, payload: dict | None = None, account_id: str = "") -> dict:
    assert STORE is not None
    account_id = str(account_id or "") or STORE.active_account_id()
    require_gateway_token(account_id)
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
    # stop the previous routine for this account, mirroring the Android
    # RoutineController. Other accounts keep running untouched.
    stop_presence(None, quiet=True, account_id=account_id)
    with STORE.lock:
        started = now_ms()
        info = presence_public(kind, started, [first])
        record = presence_record(account_id)
        record.clear()
        record.update(
            {
                "active": {"kind": kind, "title": first.get("name"), "startedAt": started},
                "startedAt": started,
                "activities": [first],
                "info": info,
                "updatedAt": started,
                "cycleIndex": 0,
            }
        )
        STORE.state.setdefault("usage", {})[kind] = int(STORE.state.get("usage", {}).get(kind, 0)) + 1
        recent = [kind] + [x for x in STORE.state.get("recent", []) if x != kind]
        STORE.state["recent"] = recent[:8]
        STORE.sync_focused()
        STORE.log(
            "INFO",
            "Presence",
            f"{PRESENCE_KINDS.get(kind, 'RPC')} started: {info['title']}"
            + (f" — {info['subtitle']}" if info.get("subtitle") else ""),
        )
        STORE.save()
        snapshot = copy.deepcopy(record)
    send_current_presence(STORE, force=True, account_id=account_id)
    GATEWAY.reconcile()
    STORE.broadcast_state()
    return snapshot


def refresh_presence(account_id: str = "") -> dict | None:
    assert STORE is not None
    account_id = str(account_id or "") or STORE.active_account_id()
    if not account_id:
        return None
    with STORE.lock:
        active = (presence_record(account_id) or {}).get("active")
    if not active:
        return None
    send_current_presence(STORE, force=True, account_id=account_id)
    GATEWAY.reconcile()
    STORE.log("INFO", "Presence", "Presence refreshed.")
    STORE.broadcast_state()
    with STORE.lock:
        return copy.deepcopy(presence_record(account_id) or {})


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
        self.send_json({"ok": False, "error": _scrub(message), **extra}, status=status)

    def read_json(self, allow_list: bool = False):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("Request is too large.")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            raise ValueError("Invalid JSON body.")
        if not isinstance(data, dict) and not (allow_list and isinstance(data, list)):
            raise ValueError("JSON body must be an object or list." if allow_list else "JSON body must be an object.")
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
        if path == "/api/accounts":
            return self.send_json(
                {
                    "ok": True,
                    "accounts": STORE.public_accounts(),
                    "activeAccountId": STORE.active_account_id(),
                    "limit": ACCOUNT_LIMIT,
                }
            )
        if path == "/api/mirror":
            return self.send_json({"ok": True, "mirror": public_mirror_state(), "limit": MIRROR_RULE_LIMIT})
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
        if path == "/api/presets/export":
            try:
                return self.handle_preset_export()
            except ValueError as exc:
                return self.send_error_json(str(exc), 400)
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
            if path == "/api/auth/login":
                data = self.read_json()
                login = str(data.get("login") or data.get("email") or data.get("username") or "")
                password = str(data.get("password") or "")
                try:
                    result = login_with_password(login, password)
                except DiscordError as exc:
                    STORE.log("WARN", "Account", f"Password sign-in failed: {_scrub(exc.message)[:160]}")
                    return self.send_error_json(exc.message, exc.status or 401, captcha=bool(exc.data.get("captcha_key")))
                if result.get("status") == "mfa":
                    return self.send_json(
                        {
                            "ok": True,
                            "status": "mfa",
                            "ticket": result["ticket"],
                            "methods": result["methods"],
                        }
                    )
                return self.send_json({"ok": True, "status": "ok", "user": result["user"], "state": public_state()})
            if path == "/api/auth/mfa":
                data = self.read_json()
                try:
                    result = login_with_mfa(str(data.get("ticket") or ""), str(data.get("code") or ""))
                except DiscordError as exc:
                    STORE.log("WARN", "Account", f"Two-factor sign-in failed: {_scrub(exc.message)[:160]}")
                    return self.send_error_json(exc.message, exc.status or 401)
                return self.send_json({"ok": True, "status": "ok", "user": result["user"], "state": public_state()})
            if path == "/api/auth/token":
                data = self.read_json()
                token = str(data.get("token") or "")
                try:
                    user = sign_in(token)
                    return self.send_json({"ok": True, "user": user, "state": public_state()})
                except DiscordError as exc:
                    safe = safe_auth_error(exc.message, token)
                    STORE.log("WARN", "Account", f"Discord sign-in failed: {safe}")
                    return self.send_error_json(safe, exc.status or 401)
            if path == "/api/auth/logout":
                sign_out()
                return self.send_json({"ok": True, "state": public_state()})
            if path == "/api/accounts/add":
                data = self.read_json()
                make_active = _mirror_bool(data.get("makeActive"), True)
                submitted = clean_discord_token(str(data.get("token") or ""))
                try:
                    account, created, user = save_discord_account(submitted, make_active=make_active)
                except DiscordError as exc:
                    safe = safe_auth_error(exc.message, submitted)
                    STORE.log("WARN", "Account", f"Account validation failed: {safe}")
                    return self.send_error_json(safe, exc.status or 401)
                return self.send_json(
                    {
                        "ok": True,
                        "account": _account_public(account),
                        "created": created,
                        "user": user,
                        "state": public_state(),
                    }
                )
            if path == "/api/accounts/switch":
                data = self.read_json()
                account = activate_discord_account(str(data.get("id") or ""), verify=True)
                return self.send_json(
                    {
                        "ok": True,
                        "account": _account_public(account),
                        "state": public_state(),
                    }
                )
            if path == "/api/accounts/remove":
                data = self.read_json()
                result = remove_discord_account(str(data.get("id") or ""))
                return self.send_json({"ok": True, **result, "state": public_state()})
            if path == "/api/accounts/remove-all":
                data = self.read_json()
                if str(data.get("confirm") or "") != "REMOVE ALL":
                    return self.send_error_json("Type REMOVE ALL to clear every saved account.", 400)
                stop_presence(None, quiet=True)
                GATEWAY.stop_all()
                purge_mirror_webhooks(forget_on_failure=True)
                count = STORE.remove_all_accounts()
                with STORE.lock:
                    STORE.state["presences"] = {}
                    STORE.state["gateways"] = {}
                    STORE.sync_focused()
                    STORE.save()
                STORE.log("INFO", "Account", f"Removed all {count} saved Discord account(s).")
                MIRROR.kick()
                STORE.broadcast_state()
                return self.send_json({"ok": True, "count": count, "state": public_state()})
            if path == "/api/account/refresh":
                active_id = STORE.active_account_id()
                if not active_id:
                    return self.send_error_json("Not signed in.", 401)
                try:
                    token = require_gateway_token(active_id)
                    me = _validated_account_user(token, active_id)
                except DiscordError as exc:
                    STORE.broadcast_state()
                    return self.send_error_json(exc.message, exc.status or 401)
                STORE.activate_account(active_id, user=me)
                STORE.broadcast_state()
                return self.send_json({"ok": True, "user": me, "state": public_state()})
            if path == "/api/gateway/reconnect":
                active_id = STORE.active_account_id()
                try:
                    require_gateway_token(active_id)
                except DiscordError as exc:
                    return self.send_error_json(exc.message, exc.status or 401)
                # Restart just this account's socket; other accounts stay online.
                GATEWAY.stop(active_id)
                GATEWAY.ensure(active_id)
                GATEWAY.reconcile()
                STORE.log("INFO", "Gateway", "Connection restart requested from the web UI.")
                return self.send_json({"ok": True, "state": public_state()})
            if path == "/api/mirror/settings":
                data = self.read_json()
                mirror = set_mirror_settings(data)
                return self.send_json({"ok": True, "mirror": mirror, "state": public_state()})
            if path == "/api/mirror/rules":
                data = self.read_json()
                rule, warning = save_mirror_rule(data)
                return self.send_json({"ok": True, "rule": rule, "warning": warning, "state": public_state()})
            if path == "/api/mirror/rules/toggle":
                data = self.read_json()
                rule_id = str(data.get("id") or "")
                result = toggle_mirror_rule(rule_id, _mirror_bool(data.get("enabled"), True))
                return self.send_json({"ok": True, **result, "state": public_state()})
            if path == "/api/mirror/rules/delete":
                data = self.read_json()
                delete_mirror_rule(str(data.get("id") or ""))
                return self.send_json({"ok": True, "state": public_state()})
            if path == "/api/mirror/run":
                data = self.read_json()
                rule_id = str(data.get("id") or "").strip()
                if rule_id:
                    summaries = [MIRROR.run_rule(rule_id, manual=True)]
                else:
                    with STORE.lock:
                        ids = [
                            rule["id"]
                            for rule in normalize_mirror_state(STORE.state.get("mirror")).get("rules", [])
                            if rule.get("enabled")
                        ]
                    summaries = []
                    for item in ids:
                        try:
                            summaries.append(MIRROR.run_rule(item, manual=True))
                        except Exception as exc:
                            rule = _mirror_rule_by_id(item) or {}
                            summaries.append(
                                {
                                    "ruleId": item,
                                    "mirrored": 0,
                                    "skipped": 0,
                                    "error": f"{rule.get('name') or 'Relay'}: {exc}",
                                }
                            )
                return self.send_json(
                    {
                        "ok": True,
                        "results": summaries,
                        "mirrored": sum(int(item.get("mirrored") or 0) for item in summaries),
                        "state": public_state(),
                    }
                )
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
            if path == "/api/presets/save":
                return self.handle_preset_save()
            if path == "/api/presets/delete":
                return self.handle_preset_delete()
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
    def redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()

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
        token = STORE.active_token()
        if not token:
            return self.send_json({"ok": True, "friends": [], "signedIn": False})
        try:
            rows = discord_api("/users/@me/relationships", token)
            friends = [normalize_relationship(r) for r in (rows or []) if isinstance(r, dict)]
            friends = [f for f in friends if f.get("user", {}).get("username")]
            return self.send_json({"ok": True, "friends": friends, "signedIn": True})
        except DiscordError as exc:
            return self.send_error_json(exc.message, exc.status or 502)

    # -- presets ----------------------------------------------------------
    def send_attachment(self, payload, file_name: str):
        raw = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{file_name}"')
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def handle_preset_save(self):
        assert STORE is not None
        data = self.read_json()
        preset_id = _kz_clean(data.get("id"), 64)
        with STORE.lock:
            saved = list(STORE.state.get("savedConfigs") or [])
            index = _saved_preset_index(saved, preset_id)
            existing = saved[index] if index >= 0 else None
            if preset_id and existing is None:
                raise ValueError("That preset is no longer saved.")
            custom = data.get("custom")
            if not isinstance(custom, dict):
                if existing is not None and isinstance(existing.get("custom"), dict):
                    custom = existing["custom"]
                else:
                    custom = STORE.state.get("custom")
            preset = _kz_saved_preset(data, custom, existing, len(saved))
            if existing is not None:
                saved[index] = preset
                dropped = 0
            else:
                merged = [preset] + saved
                dropped = max(0, len(merged) - KIZZEY_SAVED_LIMIT)
                saved = merged
            saved = saved[:KIZZEY_SAVED_LIMIT]
            STORE.state["savedConfigs"] = saved
            STORE.save()
        if existing is None:
            STORE.log("INFO", "Presets", f"Preset saved: {preset['name']}")
        else:
            STORE.log("INFO", "Presets", f"Preset updated: {preset['name']}")
        STORE.broadcast_state()
        return self.send_json(
            {
                "ok": True,
                "preset": preset,
                "created": existing is None,
                "renamed": bool(existing) and existing.get("name") != preset["name"],
                "dropped": dropped,
                "state": public_state(),
            }
        )

    def handle_preset_delete(self):
        assert STORE is not None
        data = self.read_json()
        preset_id = _kz_clean(data.get("id"), 64)
        if not preset_id:
            raise ValueError("Choose a preset to delete.")
        with STORE.lock:
            saved = list(STORE.state.get("savedConfigs") or [])
            index = _saved_preset_index(saved, preset_id)
            if index < 0:
                raise ValueError("That preset is no longer saved.")
            removed = saved.pop(index)
            STORE.state["savedConfigs"] = saved
            STORE.save()
        STORE.log("INFO", "Presets", f"Preset deleted: {_kz_clean(removed.get('name'), 80) or preset_id}")
        STORE.broadcast_state()
        return self.send_json({"ok": True, "removed": removed, "state": public_state()})

    def handle_preset_export(self):
        assert STORE is not None
        query = self.query()
        pack = _kz_clean(query.get("pack"), 8).lower() in ("1", "true", "yes", "on")
        preset_id = _kz_clean(query.get("id"), 64)
        current = _kz_clean(query.get("current"), 8).lower() in ("1", "true", "yes", "on")
        with STORE.lock:
            saved = list(STORE.state.get("savedConfigs") or [])
            if pack:
                entries = []
                for preset in saved:
                    if not isinstance(preset, dict):
                        continue
                    custom = preset.get("custom") if isinstance(preset.get("custom"), dict) else {}
                    timer = preset.get("timestamp") if isinstance(preset.get("timestamp"), dict) else {}
                    mode = _kz_clean(timer.get("mode"), 24) or "none"
                    entry = {
                        "title": _kz_clean(preset.get("name"), 80),
                        "name": _kz_clean(custom.get("name"), 128),
                        "details": _kz_clean(custom.get("details"), 128),
                        "state": _kz_clean(custom.get("state"), 128),
                        "image": _kz_config_image(custom, "large"),
                    }
                    if mode == "absolute":
                        entry["timer"] = {
                            "mode": mode,
                            "start": _kz_clean(timer.get("start"), 48),
                            "stop": _kz_clean(timer.get("stop"), 48),
                        }
                    elif mode == "duration":
                        entry["timer"] = {"mode": mode, "durationMs": _kz_int(timer.get("durationMs"), 0, None, 0)}
                    elif mode == "since_apply":
                        entry["timer"] = {"mode": mode}
                    entries.append(entry)
                if not entries:
                    raise ValueError("There are no saved presets to download yet.")
                payload = {
                    "format": KIZZEY_PRESET_FORMAT,
                    "appVersion": VERSION,
                    "presets": entries,
                }
                file_name = f"kizzey-presets-{dt.date.today().isoformat()}.json"
            elif preset_id:
                index = _saved_preset_index(saved, preset_id)
                if index < 0:
                    raise ValueError("That preset is no longer saved.")
                preset = saved[index]
                payload = _kz_config_from_custom(preset.get("custom"))
                file_name = f"kizzey-preset-{_kz_file_slug(preset.get('name'))}.json"
            elif current:
                payload = _kz_config_from_custom(STORE.state.get("custom"))
                file_name = "kizzey-preset-current.json"
            else:
                raise ValueError("Choose a preset to download.")
        return self.send_attachment(payload, file_name)

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
        assert STORE is not None
        data = self.read_json(allow_list=True)
        if isinstance(data, list):
            wrapped = False
            payload = data
            file_name = ""
        else:
            wrapped = isinstance(data.get("backup"), (dict, list))
            payload = data.get("backup") if wrapped else data
            file_name = str(data.get("fileName") or "").strip()[:240] if wrapped else ""
        kind = detect_import_kind(payload)

        if kind == "unknown":
            return self.send_error_json(
                "Expected a Kizzey Web backup, a Kizzey settings backup, a Kizzey preset pack "
                "or a Custom RPC config JSON file.",
                400,
            )

        if kind == "web":
            incoming = payload.get("state") if isinstance(payload, dict) and isinstance(payload.get("state"), dict) else payload
            if not isinstance(incoming, dict):
                return self.send_error_json("That backup does not contain a state object.", 400)
            web_warnings = []
            if "mirror" in incoming and "mirror" in IMPORTABLE_STATE_GROUPS:
                purge_mirror_webhooks(forget_on_failure=True)
            with STORE.lock:
                # Import only the whitelisted setting groups. Do not route this
                # through visible_patch: mirror is protected from direct client
                # patches, but web backups deliberately carry it and must pass
                # through prepare_imported_mirror below.
                for key, value in incoming.items():
                    if key not in IMPORTABLE_STATE_GROUPS:
                        continue
                    if key == "mirror":
                        imported_mirror, mirror_notes = prepare_imported_mirror(value)
                        STORE.state["mirror"] = imported_mirror
                        web_warnings.extend(mirror_notes)
                        continue
                    if isinstance(value, dict) and isinstance(STORE.state.get(key), dict):
                        deep_merge(STORE.state[key], value)
                    else:
                        STORE.state[key] = value
                STORE.save()
                saved_count = len(STORE.state.get("savedConfigs") or [])
            STORE.log("INFO", "Backup", "Settings imported from a Kizzey Web backup.")
            for warning in web_warnings[:KIZZEY_WARNING_LIMIT]:
                STORE.log("WARN", "Import", warning)
            STORE.broadcast_state()
            return self.send_json(
                {
                    "ok": True,
                    "state": public_state(),
                    "import": {
                        "kind": "web",
                        "label": "Kizzey Web backup",
                        "settings": 0,
                        "presets": saved_count,
                        "images": 0,
                        "warnings": web_warnings[:KIZZEY_WARNING_LIMIT],
                    },
                }
            )

        try:
            if kind == "kizzey-backup":
                bundle = build_kizzey_backup_import(payload, file_name)
            elif kind == "kizzey-preset":
                bundle = build_kizzey_preset_import(payload, file_name)
            else:
                bundle = build_kizzey_config_import(payload, file_name)
        except ValueError as exc:
            return self.send_error_json(str(exc), 400)

        report = bundle["report"]
        if "mirror" in bundle["updates"]:
            purge_mirror_webhooks(forget_on_failure=True)
        with STORE.lock:
            for key, value in bundle["updates"].items():
                if key not in IMPORTABLE_STATE_GROUPS or key == "savedConfigs":
                    continue
                if key == "mirror":
                    imported_mirror, mirror_notes = prepare_imported_mirror(value)
                    STORE.state["mirror"] = imported_mirror
                    for note in mirror_notes:
                        if note not in report["warnings"]:
                            report["warnings"] = (report["warnings"] + [note])[:KIZZEY_WARNING_LIMIT]
                    continue
                if isinstance(value, dict) and isinstance(STORE.state.get(key), dict):
                    deep_merge(STORE.state[key], value)
                else:
                    STORE.state[key] = value
            if bundle["presets"]:
                merged, dropped = merge_saved_configs(STORE.state.get("savedConfigs"), bundle["presets"])
                STORE.state["savedConfigs"] = merged
                if dropped:
                    note = f"{dropped} older saved preset{'s were' if dropped != 1 else ' was'} dropped at the local limit of {KIZZEY_SAVED_LIMIT}."
                    if note not in report["warnings"]:
                        report["warnings"] = (report["warnings"] + [note])[:KIZZEY_WARNING_LIMIT]
            STORE.save()

        detail_parts = []
        if report.get("settings"):
            detail_parts.append(f"{report['settings']} setting{'s' if report['settings'] != 1 else ''}")
        if report.get("presets"):
            detail_parts.append(f"{report['presets']} preset{'s' if report['presets'] != 1 else ''}")
        if report.get("configs"):
            detail_parts.append(f"{report['configs']} config{'s' if report['configs'] != 1 else ''}")
        if report.get("images"):
            detail_parts.append(f"{report['images']} image{'s' if report['images'] != 1 else ''}")
        STORE.log("INFO", "Import", f"{report['label']} imported: {', '.join(detail_parts) or 'no countable changes'}.")
        for warning in report.get("warnings", []):
            STORE.log("WARN", "Import", warning)
        STORE.broadcast_state()
        return self.send_json({"ok": True, "state": public_state(), "import": report})

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
        token = STORE.active_token()
        if not token:
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
                    discord_api(f"/channels/{channel}/messages/{mid}", token, method="DELETE")
                    deleted += 1
                    time.sleep(0.55)
                except DiscordError as exc:
                    failed.append({"id": mid, "error": _scrub(exc.message)})
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
                rows = discord_api(f"/channels/{channel}/messages{qs}", token) or []
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
    if not args.no_gateway:
        accounts = STORE.secret.get("accounts", []) or []
        active_id = STORE.active_account_id()
        candidates = sorted(
            [row for row in accounts if clean_discord_token(row.get("token"))],
            key=lambda row: 0 if row.get("id") == active_id else 1,
        )
        focused = False
        for account in candidates:
            account_id = str(account.get("id") or "")
            token = clean_discord_token(account.get("token"))
            try:
                me = validate_token(token)
            except DiscordError as exc:
                if exc.status == 401:
                    STORE.mark_account_auth_failed(
                        account_id, "Discord rejected this saved token. Add a fresh token."
                    )
                    STORE.log(
                        "WARN",
                        "Account",
                        f"Saved account “{(account.get('user') or {}).get('displayName') or 'Discord'}” needs a fresh token.",
                    )
                    continue
                STORE.log("WARN", "Account", f"Saved Discord session could not be verified: {exc.message}")
                STORE.activate_account(account_id)
                focused = True
                break
            except Exception as exc:
                STORE.log("WARN", "Account", f"Saved Discord session could not be verified: {_scrub(exc)}")
                STORE.activate_account(account_id)
                focused = True
                break
            STORE.activate_account(account_id, user=me)
            STORE.log("INFO", "Account", f"Restored Discord session for {me['displayName']}.")
            focused = True
            break
        if not focused and candidates:
            with STORE.lock:
                STORE.secret["token"] = ""
                STORE.secret["tokenSetAt"] = None
                STORE.state["account"] = None
                STORE.sync_focused()
                STORE.state["gateway"]["error"] = (
                    "Every saved Discord token was rejected. Add a fresh token in Discord accounts."
                )
            STORE.save()
    # Nothing is running yet: every per-account presence starts empty, so no
    # gateway socket opens until an account actually toggles something on.
    GATEWAY.reconcile()
    TICKER.start()
    MIRROR.start()

    try:
        httpd = build_server(args.host, args.port)
    except OSError as exc:
        print(f"Could not bind {args.host}:{args.port}: {exc}", file=sys.stderr)
        MIRROR.stop()
        return 1
    banner(args.host, args.port)
    try:
        httpd.serve_forever(poll_interval=0.4)
    except KeyboardInterrupt:
        print("\n  Stopping…")
    finally:
        MIRROR.stop()
        try:
            GATEWAY.stop_all()
        except Exception:
            pass
        httpd.server_close()
        if STORE:
            STORE.save()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
