#!/usr/bin/env python3
"""
Kizzey voice service
====================

A small, self-contained companion that gives the Kizzey web app real Discord
voice features:

* join a Discord voice channel as a bot (or user) account,
* play music into that channel from a URL or a search query,
* record the channel's audio,
* compress recordings to small Opus/OGG files.

The service deliberately owns the Discord connection itself.  Discord voice is
an always-on UDP/RTP session with its own gateway, so it cannot live inside the
standard-library-only Kizzey server process; instead Kizzey talks to this
service over a tiny JSON HTTP API and never hands the connection to the browser.

Run it next to Kizzey. Voice uses the Discord account token already saved for
RPC, so a local (loopback) run needs no extra secret:

    python3 voice_service.py --host 127.0.0.1 --port 8421

Then point Kizzey at it (``script_pull.py`` starts both and sets this for you):

    KIZZEY_VOICE_URL=http://127.0.0.1:8421 python3 server.py

Kizzey reads the active account token from ``data/secret.json`` and includes it
in each ``/join`` request. Account tokens are sent bare; py-cord normally adds a
``Bot `` prefix, which the service removes (set ``VOICE_USER_TOKEN=0`` to keep
the prefix for a real bot token). ``VOICE_TOKEN`` is only needed when the service
is reachable off loopback; it is a bearer token between the two processes, and it
must match ``KIZZEY_VOICE_TOKEN`` on the server.

Requires the packages in ``requirements.txt`` plus the ``ffmpeg`` binary.  Audio
receive additionally needs a DAVE-capable voice stack, because Discord encrypts
voice channels end to end; the service reports whether the active connection is
encrypted so the UI can explain a silent recording.

Only the Python standard library is used for the control plane.  Discord and
ffmpeg are the external runtime pieces.
"""

from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LOG = logging.getLogger("voice_service")

# Requesting the Server Members privileged intent lets the sink label a speaker
# with their name instead of their numeric id.  It is opt-in because Discord
# refuses the login when the intent is not enabled in the developer portal.
VOICE_MEMBERS_INTENT = str(os.environ.get("VOICE_MEMBERS_INTENT") or "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

# Kizzey authenticates with a Discord *account* token (the one that runs RPC),
# not a bot token. py-cord always sends ``Authorization: Bot <token>``, which
# Discord rejects for account tokens with "Improper token has been passed".
# Account tokens must be sent bare; bot-token users set VOICE_USER_TOKEN=0.
VOICE_USER_TOKEN = str(os.environ.get("VOICE_USER_TOKEN") or "1").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
)

MAX_BODY = 1 * 1024 * 1024
DEFAULT_PORT = 8421
DEFAULT_BITRATE = 32
MIN_BITRATE = 8
MAX_BITRATE = 256
RECORDING_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,160}$")

# The Discord imports are optional so this module can be imported for tests and
# for the pure helper functions on a machine without the voice stack.
#
# Two libraries can provide voice *receive* (and therefore DAVE decryption):
#
#   * py-cord (the ``py-cord`` package) ships receive in-tree as ``discord.sinks``
#     and decrypts DAVE frames through ``discord.opus.PacketDecoder``.  It is the
#     stack verified to work against a live DAVE-encrypted channel.
#   * discord.py plus ``discord-ext-voice-recv`` exposes ``discord.ext.voice_recv``.
#
# Both expose decoded 48 kHz stereo s16le PCM, so the recorder below is shared.
# ``VOICE_BACKEND`` records which one is active; everything degrades to pure
# helpers when neither is installed.
discord = None
voice_recv = None
discord_sinks = None
VOICE_BACKEND = None

try:  # pragma: no cover - depends on the deployment image
    import discord
except Exception as exc:  # pragma: no cover
    VOICE_IMPORT_ERROR = exc
else:
    VOICE_IMPORT_ERROR = None
    try:
        from discord import sinks as discord_sinks  # py-cord's in-tree receive
    except Exception:
        discord_sinks = None
    if discord_sinks is not None and hasattr(discord_sinks, "Sink"):
        VOICE_BACKEND = "pycord"
    else:
        try:
            from discord.ext import voice_recv  # discord.py + voice-recv
        except Exception as exc:
            voice_recv = None
            VOICE_IMPORT_ERROR = exc
        else:
            VOICE_BACKEND = "voice_recv"


def now_ms() -> int:
    return int(time.time() * 1000)


# py-cord writes ``Authorization: Bot <token>`` in HTTPClient.request. Account
# tokens are sent without that prefix, so a small aiohttp hook rewrites the
# header when Kizzey is using its RPC token. The rewrite is pure and tested.
_USER_TOKEN_ACTIVE = False
_USER_TOKEN_PATCHED = False


def user_auth_headers(headers: dict | None) -> dict | None:
    """Drop the ``Bot `` prefix from an Authorization header, if present."""
    if not headers:
        return headers
    for key in list(headers):
        if str(key).lower() != "authorization":
            continue
        value = headers.get(key)
        if isinstance(value, str) and value.startswith("Bot "):
            updated = dict(headers)
            updated[key] = value[4:]
            return updated
        return headers
    return headers


def clean_token(value) -> str:
    """Normalise a pasted token: no surrounding space, no Bearer/Bot prefix."""
    token = str(value or "").strip()
    lowered = token.lower()
    for prefix in ("bearer ", "bot "):
        if lowered.startswith(prefix):
            token = token[len(prefix):].strip()
            break
    return token


def _install_user_token_patch() -> None:
    """Teach py-cord's aiohttp session to send account tokens bare."""
    global _USER_TOKEN_PATCHED
    if _USER_TOKEN_PATCHED:
        return
    try:
        import aiohttp
    except Exception:  # pragma: no cover - aiohttp ships with py-cord
        return
    original = aiohttp.ClientSession.request

    def request(self, method, url, **kwargs):
        if _USER_TOKEN_ACTIVE:
            headers = kwargs.get("headers")
            rewritten = user_auth_headers(headers)
            if rewritten is not headers:
                kwargs["headers"] = rewritten
        return original(self, method, url, **kwargs)

    aiohttp.ClientSession.request = request
    _USER_TOKEN_PATCHED = True


def set_user_token_mode(active: bool) -> None:
    """Choose whether Discord tokens are account tokens (bare) or bot tokens."""
    global _USER_TOKEN_ACTIVE
    _USER_TOKEN_ACTIVE = bool(active)
    if _USER_TOKEN_ACTIVE:
        _install_user_token_patch()


def clamp_bitrate(value) -> int:
    try:
        bitrate = int(value)
    except (TypeError, ValueError):
        return DEFAULT_BITRATE
    return max(MIN_BITRATE, min(MAX_BITRATE, bitrate))


def sanitize_label(value) -> str:
    """Turn a display name into a filename-safe fragment."""
    cleaned = re.sub(r"[^A-Za-z0-9 _.-]+", "", str(value or "")).strip()
    cleaned = re.sub(r"\s+", "_", cleaned)
    return (cleaned[:48] or "user")


def safe_recording_id(value) -> str:
    text = str(value or "")
    if text in (".", "..") or not RECORDING_ID_RE.match(text) or "/" in text or "\\" in text:
        raise ValueError("Invalid recording id.")
    return text


def recordings_dir() -> Path:
    directory = Path(os.environ.get("VOICE_RECORDINGS_DIR", "data/voice_recordings"))
    directory.mkdir(parents=True, exist_ok=True)
    return directory


_INDEX_LOCK = threading.Lock()


def _index_path(directory: Path) -> Path:
    return directory / "recordings.json"


def load_index(directory: Path | None = None) -> list[dict]:
    directory = directory or recordings_dir()
    path = _index_path(directory)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text("utf-8"))
    except Exception:
        return []
    return data if isinstance(data, list) else []


def save_index(items: list[dict], directory: Path | None = None) -> None:
    directory = directory or recordings_dir()
    path = _index_path(directory)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(items[:500], ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(path)


def add_index(entry: dict, directory: Path | None = None) -> dict:
    directory = directory or recordings_dir()
    entry = dict(entry)
    entry.setdefault("id", uuid.uuid4().hex)
    entry.setdefault("created", now_ms())
    with _INDEX_LOCK:
        items = load_index(directory)
        items.insert(0, entry)
        save_index(items, directory)
    return entry


def find_index(recording_id: str, directory: Path | None = None) -> dict | None:
    directory = directory or recordings_dir()
    for item in load_index(directory):
        if item.get("id") == recording_id:
            return item
    return None


def delete_index(recording_id: str, directory: Path | None = None) -> dict | None:
    directory = directory or recordings_dir()
    with _INDEX_LOCK:
        items = load_index(directory)
        found = None
        kept = []
        for item in items:
            if item.get("id") == recording_id:
                found = item
            else:
                kept.append(item)
        if found is not None:
            save_index(kept, directory)
        return found


def resolve_recording_path(entry: dict, directory: Path | None = None) -> Path | None:
    """Return a path only when the stored name stays inside the recordings dir."""
    directory = (directory or recordings_dir()).resolve()
    name = str(entry.get("name") or "")
    if not name or "/" in name or "\\" in name:
        return None
    candidate = (directory / name).resolve()
    if candidate.parent != directory:
        return None
    return candidate


def resolve_source(query: str, ytdlp_bin: str = "yt-dlp") -> tuple[str, str]:
    """Resolve a URL, a local file, or a search query into a playable URL.

    Returns ``(url, title)``.  Search uses the ``yt_dlp`` module when it is
    installed and falls back to the ``yt-dlp`` command line so a plain
    container with only the binary still works.
    """
    text = str(query or "").strip()
    if not text:
        raise ValueError("Give me a URL, a file, or something to search for.")
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", text):
        return text, text
    if Path(text).expanduser().exists():
        path = Path(text).expanduser().resolve()
        return str(path), path.name

    search = text if text.startswith("ytsearch") else f"ytsearch1:{text}"
    try:
        import yt_dlp  # type: ignore
    except Exception:
        yt_dlp = None
    if yt_dlp is not None:
        options = {
            "format": "bestaudio/best",
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
        }
        with yt_dlp.YoutubeDL(options) as ydl:  # type: ignore[attr-defined]
            info = ydl.extract_info(search, download=False)
        if isinstance(info, dict) and info.get("entries"):
            entries = list(info["entries"])
            info = entries[0] if entries else {}
        if not isinstance(info, dict) or not (info.get("url") or info.get("webpage_url")):
            raise ValueError("Nothing playable was found for that search.")
        return str(info.get("url") or info.get("webpage_url")), str(info.get("title") or text)

    if not shutil.which(ytdlp_bin):
        raise ValueError(
            "Search needs the 'yt-dlp' command or the yt_dlp Python module. "
            "Use a direct audio/video URL instead, or install yt-dlp."
        )
    proc = subprocess.run(
        [ytdlp_bin, "-f", "bestaudio/best", "--no-playlist", "-g", search],
        capture_output=True,
        text=True,
        timeout=90,
    )
    url = (proc.stdout or "").strip().splitlines()
    if proc.returncode != 0 or not url:
        detail = (proc.stderr or "").strip().splitlines()
        raise ValueError(detail[-1] if detail else "yt-dlp could not resolve that search.")
    return url[0], text


def ffmpeg_available(ffmpeg_bin: str = "ffmpeg") -> bool:
    return shutil.which(ffmpeg_bin) is not None


def build_recorder_command(ffmpeg_bin: str, output: str, bitrate: int) -> list[str]:
    """Build the ffmpeg command that turns Discord PCM into a small Opus file."""
    return [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-i",
        "pipe:0",
        "-ac",
        "1",
        "-c:a",
        "libopus",
        "-b:a",
        f"{clamp_bitrate(bitrate)}k",
        "-application",
        "audio",
        "-f",
        "ogg",
        "-y",
        output,
    ]


def build_mix_command(ffmpeg_bin: str, inputs: list[str], output: str, bitrate: int) -> list[str]:
    args = [ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-nostdin"]
    for path in inputs:
        args += ["-i", path]
    args += [
        "-filter_complex",
        f"amix=inputs={len(inputs)}:duration=longest:dropout_transition=0:normalize=1",
        "-ac",
        "1",
        "-c:a",
        "libopus",
        "-b:a",
        f"{clamp_bitrate(bitrate)}k",
        "-f",
        "ogg",
        "-y",
        output,
    ]
    return args


def build_compress_command(ffmpeg_bin: str, source: str, output: str, bitrate: int) -> list[str]:
    return [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        source,
        "-ac",
        "1",
        "-c:a",
        "libopus",
        "-b:a",
        f"{clamp_bitrate(bitrate)}k",
        "-application",
        "audio",
        "-f",
        "ogg",
        "-y",
        output,
    ]


if VOICE_BACKEND == "pycord":
    _SINK_BASE = discord_sinks.Sink
elif VOICE_BACKEND == "voice_recv":
    _SINK_BASE = voice_recv.AudioSink
else:
    _SINK_BASE = None


if _SINK_BASE is not None:  # pragma: no cover - requires the voice stack

    class OpusRecorder(_SINK_BASE):
        """Sink that writes each speaker to their own small Opus file live.

        The receiver hands us decoded PCM (48 kHz stereo s16le) and we pipe every
        speaker into their own ffmpeg process, so the on-disk file is already
        compressed while the call is happening.  Both the py-cord and voice-recv
        sinks are supported; the caller order of ``write`` differs between them.
        """

        def __init__(self, directory: Path, bitrate: int, stamp: str, ffmpeg_bin: str = "ffmpeg"):
            super().__init__()
            self.directory = directory
            self.bitrate = clamp_bitrate(bitrate)
            self.stamp = stamp
            self.ffmpeg_bin = ffmpeg_bin
            self.lock = threading.Lock()
            self.tracks: dict[str, dict] = {}
            # The receiver calls cleanup() from its own stopper thread.  Both
            # paths funnel through this flag so files are finalised exactly once
            # and whoever asks second waits for the first to finish.
            self._finished = False
            self._cleaned: list[dict] = []
            self._to_close: list[dict] = []
            self.done = threading.Event()

        def wants_opus(self) -> bool:  # voice-recv
            return False

        def is_opus(self) -> bool:  # py-cord
            return False

        def _open_track(self, key: str, label: str) -> dict:
            # Caller holds self.lock.
            safe = sanitize_label(label)
            name = f"{self.stamp}__{safe}__{key}.ogg"
            output = str(self.directory / name)
            process = subprocess.Popen(
                build_recorder_command(self.ffmpeg_bin, output, self.bitrate),
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            track = {
                "user": safe,
                "userId": key,
                "name": name,
                "process": process,
                "bytes": 0,
                "error": False,
            }
            self.tracks[key] = track
            return track

        def _write_pcm(self, key: str, label: str, pcm: bytes) -> None:
            with self.lock:
                track = self.tracks.get(key)
                if track is None:
                    try:
                        track = self._open_track(key, label)
                    except Exception as exc:
                        LOG.warning("Could not start a recorder for %s: %s", key, exc)
                        return
                if track.get("error"):
                    return
                try:
                    track["process"].stdin.write(pcm)  # type: ignore[union-attr]
                    track["bytes"] += len(pcm)
                except Exception as exc:
                    track["error"] = True
                    LOG.warning("Recorder write failed for %s: %s", key, exc)

        def write(self, *args) -> None:  # type: ignore[override]
            # py-cord calls write(data, user); voice-recv calls write(user, data).
            if len(args) < 2:
                return
            if VOICE_BACKEND == "pycord":
                data, user = args[0], args[1]
            else:
                user, data = args[0], args[1]
            pcm = getattr(data, "pcm", None)
            if pcm is None and isinstance(data, (bytes, bytearray)):
                pcm = bytes(data)
            if not pcm:
                return
            key = str(getattr(user, "id", None) or "unknown")
            label = (
                getattr(user, "display_name", None)
                or getattr(user, "name", None)
                or self._resolve_label(key)
                or key
            )
            self._write_pcm(key, label, pcm)

        def _resolve_label(self, key: str) -> str | None:
            # py-cord falls back to a bare Object(id=...) when the guild member
            # is not cached, so the sink tries the voice client's guild too.
            if not key.isdigit():
                return None
            voice = getattr(self, "vc", None)
            guild = getattr(voice, "guild", None)
            if guild is None:
                return None
            try:
                member = guild.get_member(int(key))
            except Exception:
                return None
            if member is None:
                return None
            return getattr(member, "display_name", None) or getattr(member, "name", None)

        def write_music(self, pcm: bytes) -> None:
            """Tap the bot's own playback so the call recording includes music."""
            if pcm:
                self._write_pcm("music", "music", pcm)

        def snapshot(self) -> list[dict]:
            with self.lock:
                return [
                    {"user": t["user"], "userId": t["userId"], "bytes": t["bytes"]}
                    for t in self.tracks.values()
                ]

        def cleanup(self) -> list[dict]:
            owner = False
            with self.lock:
                if not self._finished:
                    self._finished = True
                    self._to_close = list(self.tracks.values())
                    self.tracks = {}
                    owner = True
            if hasattr(self, "finished"):
                self.finished = True
            if owner:
                for track in self._to_close:
                    process = track.get("process")
                    if not process:
                        continue
                    try:
                        if process.stdin:
                            process.stdin.close()
                    except Exception:
                        pass
                    try:
                        process.wait(timeout=15)
                    except Exception:
                        try:
                            process.kill()
                        except Exception:
                            pass
                self._cleaned = self._to_close
                self.done.set()
            else:
                self.done.wait(timeout=60)
            return list(self._cleaned)

else:  # pragma: no cover
    OpusRecorder = None  # type: ignore[assignment]


if VOICE_BACKEND is not None:  # pragma: no cover - requires the voice stack

    class TeeSource(discord.AudioSource):
        """Forwards PCM to the player and to an optional tap.

        Discord does not echo the bot's own playback back through the receive
        path, so recording the music needs a tap on the outgoing source.  The
        tap is a no-op unless a recording is active.
        """

        def __init__(self, inner, tap=None):
            self.inner = inner
            self.tap = tap

        def read(self) -> bytes:
            data = self.inner.read()
            if data and self.tap is not None:
                try:
                    self.tap(data)
                except Exception:
                    pass
            return data

        def is_opus(self) -> bool:
            return False

        @property
        def volume(self):
            return getattr(self.inner, "volume", 1.0)

        @volume.setter
        def volume(self, value):
            if hasattr(self.inner, "volume"):
                self.inner.volume = value

        def cleanup(self) -> None:
            try:
                self.inner.cleanup()
            except Exception:
                pass

else:  # pragma: no cover
    TeeSource = None  # type: ignore[assignment]


class VoiceManager:
    """Owns the Discord client, the voice connection, playback and recording."""

    def __init__(
        self,
        default_token: str = "",
        ffmpeg_bin: str = "ffmpeg",
        ytdlp_bin: str = "yt-dlp",
        recordings: Path | None = None,
        user_token: bool | None = None,
    ):
        self.default_token = default_token
        self.ffmpeg_bin = ffmpeg_bin
        self.ytdlp_bin = ytdlp_bin
        self.recordings = recordings or recordings_dir()
        self.user_token = VOICE_USER_TOKEN if user_token is None else bool(user_token)
        self.loop = asyncio.new_event_loop()
        self.thread: threading.Thread | None = None
        self.client = None
        self.token = None
        self.ready = threading.Event()
        self.error: str | None = None
        self._client_lock = threading.RLock()
        self._voice = None
        self._current: dict | None = None
        self._queue: list[dict] = []
        self._recorder = None
        self._record_meta: dict | None = None
        self._stopping = False

    # -- lifecycle --------------------------------------------------------
    def start(self) -> None:
        if self.thread is not None:
            return
        self.thread = threading.Thread(target=self._run_loop, name="voice-discord", daemon=True)
        self.thread.start()

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def _run(self, coro, timeout: float = 60.0):
        future = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return future.result(timeout=timeout)

    def shutdown(self) -> None:
        self._stopping = True
        try:
            self._run(self._shutdown_async(), timeout=60)
        except Exception:
            pass
        try:
            self.loop.call_soon_threadsafe(self.loop.stop)
        except Exception:
            pass

    async def _shutdown_async(self) -> None:
        await self._stop_recording_async()
        try:
            if self._voice is not None:
                await self._voice.disconnect(force=True)
        except Exception:
            pass
        self._voice = None
        if self.client is not None:
            try:
                await self.client.close()
            except Exception:
                pass
            self.client = None

    # -- client -----------------------------------------------------------
    def ensure_client(self, token: str | None = None, user_token: bool | None = None) -> None:
        if discord is None or VOICE_BACKEND is None:
            raise RuntimeError(f"Voice dependencies are missing: {VOICE_IMPORT_ERROR}")
        chosen = clean_token(token or self.default_token or "")
        if not chosen:
            raise ValueError("No Discord token is configured for the voice service.")
        use_user_token = self.user_token if user_token is None else bool(user_token)
        with self._client_lock:
            if self.client is not None:
                try:
                    self._run(self._close_client_async(), timeout=20)
                except Exception:
                    pass
            set_user_token_mode(use_user_token)
            self.token = chosen
            self.ready.clear()
            self.error = None
            self.loop.call_soon_threadsafe(lambda: self.loop.create_task(self._client_main(chosen)))
        if not self.ready.wait(timeout=45):
            raise RuntimeError("Timed out while connecting to Discord.")
        if self.error:
            raise RuntimeError(self.error)
        if self.client is None or not self.client.is_ready():
            raise RuntimeError("The Discord client did not become ready.")

    async def _client_main(self, token: str) -> None:
        intents = discord.Intents.none()
        intents.guilds = True
        intents.voice_states = True
        if VOICE_MEMBERS_INTENT:
            intents.members = True
        client = discord.Client(intents=intents)
        self.client = client

        @client.event
        async def on_ready():  # pragma: no cover - runtime only
            LOG.info("Discord client ready as %s", client.user)
            self.ready.set()

        try:
            await client.start(token)
        except Exception as exc:  # pragma: no cover - runtime only
            self.error = str(exc)
            self.ready.set()
            LOG.error("Discord client stopped: %s", exc)

    async def _close_client_async(self) -> None:
        await self._stop_recording_async()
        await self._leave_async(quiet=True)
        if self.client is not None:
            try:
                await self.client.close()
            except Exception:
                pass
            self.client = None

    # -- helpers ----------------------------------------------------------
    def _require_voice(self):
        if self._voice is None or not self._voice.is_connected():
            raise RuntimeError("Join a voice channel first.")
        return self._voice

    # -- receive adapter (py-cord in-tree sinks vs discord-ext-voice-recv) --
    def _listen(self, voice, sink) -> None:
        if VOICE_BACKEND == "pycord":
            voice.start_recording(sink, None)
        else:
            voice.listen(sink)

    def _stop_listening(self, voice) -> None:
        if VOICE_BACKEND == "pycord":
            voice.stop_recording()
        else:
            voice.stop_listening()

    def _is_listening(self, voice) -> bool:
        try:
            if VOICE_BACKEND == "pycord":
                return bool(voice.is_recording())
            return bool(voice.is_listening())
        except Exception:
            return False

    def _advance(self) -> None:
        if self._queue:
            track = self._queue.pop(0)
            try:
                self._start_track(track)
            except Exception as exc:
                LOG.warning("Could not start queued track: %s", exc)
                self._current = None
                self._advance()
        else:
            self._current = None

    def _start_track(self, track: dict) -> None:
        voice = self._voice
        if voice is None or not voice.is_connected():
            raise RuntimeError("The voice connection closed.")
        before = "-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -nostdin"
        source = discord.FFmpegPCMAudio(track["url"], before_options=before, options="-vn")
        source = discord.PCMVolumeTransformer(source, volume=float(track.get("volume", 1.0)))
        if TeeSource is not None:
            source = TeeSource(source, self._tap_music)
        self._current = track
        voice.play(source, after=self._after_track)

    def _tap_music(self, pcm: bytes) -> None:
        recorder = self._recorder
        if recorder is not None:
            try:
                recorder.write_music(pcm)
            except Exception:
                pass

    def _after_track(self, error) -> None:  # called from the player thread
        if error:
            LOG.warning("Playback error: %s", error)
        if self._stopping:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._advance_async(), self.loop)
        except Exception:
            pass

    async def _advance_async(self) -> None:
        # The player thread calls its after-callback just before it finishes;
        # give it a moment so voice.play() does not see the old player.
        await asyncio.sleep(0.25)
        self._advance()

    # -- async commands ---------------------------------------------------
    async def _join_async(self, guild_id: str | None, channel_id: str) -> dict:
        if self.client is None or not self.client.is_ready():
            raise RuntimeError("The Discord client is not ready yet.")
        try:
            channel = self.client.get_channel(int(channel_id))
        except (TypeError, ValueError):
            raise ValueError("That channel id is not valid.")
        if channel is None:
            try:
                channel = await self.client.fetch_channel(int(channel_id))
            except Exception:
                raise ValueError("I cannot see that channel. Check the id and the bot's access.")
        if not isinstance(channel, discord.VoiceChannel):
            raise ValueError("That is not a voice channel.")
        if guild_id and str(getattr(channel.guild, "id", "")) != str(guild_id):
            raise ValueError("That channel is not in the guild you gave me.")

        existing = channel.guild.voice_client
        if (
            VOICE_BACKEND == "voice_recv"
            and existing is not None
            and not isinstance(existing, voice_recv.VoiceRecvClient)
        ):
            # A plain discord.py VoiceClient cannot receive audio.
            try:
                await existing.disconnect(force=True)
            except Exception:
                pass
            existing = None
        if existing is not None:
            if existing.channel and existing.channel.id == channel.id:
                self._voice = existing
            else:
                await existing.move_to(channel)
                self._voice = existing
        else:
            # self_deaf must stay False or Discord sends no audio to receive.
            # py-cord's connect() takes no self_deaf/self_mute and defaults both
            # to False; discord.py accepts them explicitly.
            connect_kwargs: dict = {"reconnect": True}
            if VOICE_BACKEND == "voice_recv":
                connect_kwargs["self_deaf"] = False
                connect_kwargs["self_mute"] = False
                connect_kwargs["cls"] = voice_recv.VoiceRecvClient
            self._voice = await channel.connect(**connect_kwargs)
        return self.state()

    async def _leave_async(self, quiet: bool = False) -> dict:
        if self._recorder is not None and not quiet:
            await self._stop_recording_async()
        self._queue.clear()
        self._current = None
        voice = self._voice
        if voice is not None:
            try:
                if voice.is_playing() or voice.is_paused():
                    voice.stop()
            except Exception:
                pass
            try:
                await voice.disconnect(force=True)
            except Exception:
                pass
        self._voice = None
        return self.state()

    async def _play_async(self, query: str, volume: float = 1.0) -> dict:
        voice = self._require_voice()
        url, title = await asyncio.to_thread(resolve_source, query, self.ytdlp_bin)
        try:
            volume = max(0.0, min(2.0, float(volume)))
        except (TypeError, ValueError):
            volume = 1.0
        track = {"query": query, "title": title or query, "url": url, "volume": volume, "startedAt": now_ms()}
        if voice.is_playing() or voice.is_paused():
            self._queue.append(track)
            return {"queued": True, "position": len(self._queue), "state": self.state()}
        self._start_track(track)
        return {"queued": False, "state": self.state()}

    async def _control_async(self, action: str, value=None) -> dict:
        voice = self._voice
        action = str(action or "").lower()
        if action == "volume":
            try:
                amount = max(0.0, min(2.0, float(value)))
            except (TypeError, ValueError):
                raise ValueError("Volume must be a number between 0 and 2.")
            if voice is not None and voice.source is not None and hasattr(voice.source, "volume"):
                voice.source.volume = amount
            elif self._current is not None:
                self._current["volume"] = amount
            elif self._queue:
                self._queue[-1]["volume"] = amount
        elif action == "pause":
            if voice is not None and voice.is_playing():
                voice.pause()
        elif action == "resume":
            if voice is not None and voice.is_paused():
                voice.resume()
        elif action == "stop":
            self._queue.clear()
            self._current = None
            if voice is not None and (voice.is_playing() or voice.is_paused()):
                voice.stop()
        elif action == "skip":
            if voice is not None and (voice.is_playing() or voice.is_paused()):
                voice.stop()
            elif self._queue:
                self._advance()
        elif action == "clear":
            self._queue.clear()
        else:
            raise ValueError("Unknown playback control.")
        return self.state()

    async def _start_recording_async(self, mode: str = "mix", bitrate: int = DEFAULT_BITRATE, mix: bool = True) -> dict:
        voice = self._require_voice()
        if self._recorder is not None:
            raise RuntimeError("A recording is already running.")
        if OpusRecorder is None:
            raise RuntimeError(
                "Voice receive is unavailable; install py-cord[voice] or discord.py with discord-ext-voice-recv."
            )
        mode = "mix" if str(mode or "").lower() not in ("mix", "tracks") else str(mode).lower()
        stamp = time.strftime("%Y%m%d-%H%M%S")
        self._recorder = OpusRecorder(self.recordings, bitrate, stamp, self.ffmpeg_bin)
        self._record_meta = {"mode": mode, "bitrate": clamp_bitrate(bitrate), "mix": bool(mix), "startedAt": now_ms(), "stamp": stamp}
        self._listen(voice, self._recorder)
        return self.state()

    def _finalise_recording(self, tracks: list[dict], meta: dict) -> list[dict]:
        """Index the finished per-speaker files and optionally mix them.

        Runs in a worker thread: ffmpeg can take a while and must never block
        the Discord event loop.
        """
        entries: list[dict] = []
        for track in tracks:
            if not track.get("bytes"):
                path = self.recordings / str(track.get("name") or "")
                if path.exists():
                    try:
                        path.unlink()
                    except OSError:
                        pass
                continue
            entry = {
                "id": uuid.uuid4().hex,
                "kind": "track",
                "name": track.get("name"),
                "user": track.get("user"),
                "userId": track.get("userId"),
                "bitrate": meta.get("bitrate", DEFAULT_BITRATE),
                "created": now_ms(),
                "bytes": int(track.get("bytes") or 0),
            }
            add_index(entry, self.recordings)
            entries.append(entry)
        if meta.get("mix") and len(entries) > 1:
            output_name = f"{meta.get('stamp', 'mix')}__mix.ogg"
            output = self.recordings / output_name
            inputs = [str(self.recordings / str(e["name"])) for e in entries]
            try:
                subprocess.run(
                    build_mix_command(self.ffmpeg_bin, inputs, str(output), meta.get("bitrate", DEFAULT_BITRATE)),
                    check=True,
                    timeout=900,
                )
            except Exception as exc:
                LOG.warning("Could not mix the recording: %s", exc)
            else:
                entry = {
                    "id": uuid.uuid4().hex,
                    "kind": "mix",
                    "name": output_name,
                    "user": "mix",
                    "userId": None,
                    "bitrate": meta.get("bitrate", DEFAULT_BITRATE),
                    "created": now_ms(),
                    "bytes": output.stat().st_size if output.exists() else 0,
                }
                add_index(entry, self.recordings)
                entries.append(entry)
        return entries

    async def _stop_recording_async(self) -> dict:
        recorder = self._recorder
        if recorder is None:
            return self.state()
        voice = self._voice
        try:
            if voice is not None and self._is_listening(voice):
                self._stop_listening(voice)
        except Exception:
            pass
        self._recorder = None
        meta = self._record_meta or {}
        self._record_meta = None
        # The receiver finalises the sink on its own stopper thread.
        # cleanup() is idempotent and makes the second caller wait for the
        # first, so the file list is never lost and ffmpeg is never truncated.
        tracks = await asyncio.to_thread(recorder.cleanup)
        await asyncio.to_thread(self._finalise_recording, tracks, meta)
        return self.state()

    # -- public sync API --------------------------------------------------
    def join(self, guild_id: str | None, channel_id: str, token: str | None = None, user_token: bool = True) -> dict:
        # Kizzey sends the account token that already drives RPC, so treat it
        # as an account token unless a caller explicitly says otherwise.
        self.ensure_client(token, user_token=user_token)
        return self._run(self._join_async(guild_id, channel_id), timeout=60)

    def leave(self) -> dict:
        if self.client is None:
            return self.state()
        return self._run(self._leave_async(), timeout=30)

    def play(self, query: str, volume: float = 1.0) -> dict:
        return self._run(self._play_async(query, volume), timeout=120)

    def control(self, action: str, value=None) -> dict:
        return self._run(self._control_async(action, value), timeout=30)

    def start_recording(self, mode: str = "mix", bitrate: int = DEFAULT_BITRATE, mix: bool = True) -> dict:
        return self._run(self._start_recording_async(mode, bitrate, mix), timeout=30)

    def stop_recording(self) -> dict:
        return self._run(self._stop_recording_async(), timeout=900)

    def compress_recording(self, recording_id: str, bitrate: int = DEFAULT_BITRATE) -> dict:
        entry = find_index(recording_id, self.recordings)
        if entry is None:
            raise ValueError("Recording not found.")
        source = resolve_recording_path(entry, self.recordings)
        if source is None or not source.exists():
            raise ValueError("The recording file is missing.")
        bitrate = clamp_bitrate(bitrate)
        output_name = f"{source.stem}__compressed_{bitrate}k.ogg"
        output = self.recordings / output_name
        if output.exists():
            output_name = f"{source.stem}__compressed_{bitrate}k_{uuid.uuid4().hex[:4]}.ogg"
            output = self.recordings / output_name
        subprocess.run(
            build_compress_command(self.ffmpeg_bin, str(source), str(output), bitrate),
            check=True,
            timeout=900,
        )
        new_entry = {
            "id": uuid.uuid4().hex,
            "kind": "compressed",
            "name": output_name,
            "user": entry.get("user"),
            "userId": entry.get("userId"),
            "bitrate": bitrate,
            "created": now_ms(),
            "bytes": output.stat().st_size if output.exists() else 0,
            "sourceId": recording_id,
        }
        add_index(new_entry, self.recordings)
        return new_entry

    def delete_recording(self, recording_id: str) -> dict:
        entry = delete_index(recording_id, self.recordings)
        if entry is None:
            raise ValueError("Recording not found.")
        path = resolve_recording_path(entry, self.recordings)
        if path is not None and path.exists():
            try:
                path.unlink()
            except OSError:
                pass
        return entry

    def list_recordings(self) -> list[dict]:
        output = []
        for entry in load_index(self.recordings):
            item = dict(entry)
            path = resolve_recording_path(item, self.recordings)
            item["exists"] = bool(path and path.exists())
            item["size"] = path.stat().st_size if item["exists"] else int(item.get("bytes") or 0)
            output.append(item)
        return output

    def state(self) -> dict:
        voice = self._voice
        connected = bool(voice is not None and voice.is_connected())
        dave = None
        if connected:
            try:
                if hasattr(voice, "is_dave_connection"):
                    dave = bool(voice.is_dave_connection())
                else:
                    session = getattr(getattr(voice, "_connection", None), "dave_session", None)
                    dave = session is not None
            except Exception:
                dave = None
        listening = False
        if voice is not None:
            listening = self._is_listening(voice)
        volume = 1.0
        if voice is not None and voice.source is not None and hasattr(voice.source, "volume"):
            volume = float(voice.source.volume)
        return {
            "ready": bool(self.client is not None and self.client.is_ready()),
            "user": str(self.client.user) if self.client is not None and self.client.user else None,
            "connected": connected,
            "guildId": str(voice.guild.id) if connected and voice.guild else None,
            "channelId": str(voice.channel.id) if connected and voice.channel else None,
            "channelName": voice.channel.name if connected and voice.channel else None,
            "playing": bool(voice is not None and voice.is_playing()),
            "paused": bool(voice is not None and voice.is_paused()),
            "listening": listening,
            "dave": dave,
            "backend": VOICE_BACKEND,
            "volume": volume,
            "current": dict(self._current) if self._current else None,
            "queue": [dict(item) for item in self._queue],
            "recording": {
                "active": self._recorder is not None,
                "mode": (self._record_meta or {}).get("mode"),
                "bitrate": (self._record_meta or {}).get("bitrate"),
                "startedAt": (self._record_meta or {}).get("startedAt"),
                "tracks": self._recorder.snapshot() if self._recorder is not None else [],
            },
            "ffmpeg": ffmpeg_available(self.ffmpeg_bin),
            "ytdlp": shutil.which(self.ytdlp_bin) is not None,
            "recordingCount": len(load_index(self.recordings)),
        }


class VoiceHTTPHandler(BaseHTTPRequestHandler):
    server_version = "KizzeyVoice/1.0"
    protocol_version = "HTTP/1.1"

    # wired up by build_server
    manager: VoiceManager = None  # type: ignore[assignment]
    token: str = ""

    def log_message(self, fmt, *args) -> None:
        LOG.debug("%s - %s", self.address_string(), fmt % args)

    # -- helpers ----------------------------------------------------------
    def _authorized(self) -> bool:
        # /health is a liveness probe for Docker and uptime checks; it exposes
        # only boolean dependency flags, never state or recordings.
        if self.path.split("?")[0] in ("", "/", "/health"):
            return True
        if not self.token:
            return self.client_address[0] in ("127.0.0.1", "::1", "localhost")
        supplied = self.headers.get("Authorization") or ""
        if supplied.lower().startswith("bearer "):
            supplied = supplied[7:]
        if not supplied:
            supplied = self.headers.get("X-Voice-Token") or ""
        return hmac.compare_digest(supplied, self.token)

    def _send_json(self, data: dict, status: int = 200) -> None:
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_error(self, message: str, status: int = 400) -> None:
        self._send_json({"ok": False, "error": message}, status=status)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("Request is too large.")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            raise ValueError("Invalid JSON body.")
        return data if isinstance(data, dict) else {}

    def _send_file(self, path: Path) -> None:
        try:
            stat = path.stat()
        except OSError:
            return self._send_error("Recording not found.", 404)
        self.send_response(200)
        self.send_header("Content-Type", "audio/ogg")
        self.send_header("Content-Length", str(stat.st_size))
        self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            with path.open("rb") as handle:
                shutil.copyfileobj(handle, self.wfile)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    # -- routing ----------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        if not self._authorized():
            return self._send_error("Unauthorized.", 401)
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        if not parts or parts[0] == "health":
            state = self.manager.state() if self.manager else {}
            return self._send_json(
                {
                    "ok": True,
                    "service": "kizzey-voice",
                    "ready": bool(state.get("ready")),
                    "backend": state.get("backend") or VOICE_BACKEND,
                    "ffmpeg": ffmpeg_available(self.manager.ffmpeg_bin) if self.manager else False,
                    "ytdlp": shutil.which(self.manager.ytdlp_bin) if self.manager else None,
                }
            )
        if parts[0] == "state":
            return self._send_json({"ok": True, "state": self.manager.state()})
        if parts[0] == "recordings" and len(parts) == 1:
            return self._send_json({"ok": True, "recordings": self.manager.list_recordings()})
        if parts[0] == "recordings" and len(parts) == 2:
            try:
                recording_id = safe_recording_id(parts[1])
            except ValueError as exc:
                return self._send_error(str(exc), 400)
            entry = find_index(recording_id, self.manager.recordings)
            if entry is None:
                return self._send_error("Recording not found.", 404)
            path = resolve_recording_path(entry, self.manager.recordings)
            if path is None or not path.exists():
                return self._send_error("Recording file is missing.", 404)
            return self._send_file(path)
        return self._send_error("Not found.", 404)

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            return self._send_error("Unauthorized.", 401)
        route = self.path.split("?")[0].rstrip("/") or "/"
        try:
            data = self._read_json()
            if route == "/join":
                state = self.manager.join(
                    data.get("guildId"),
                    str(data.get("channelId") or ""),
                    data.get("token"),
                    user_token=bool(data.get("userToken", True)),
                )
                return self._send_json({"ok": True, "state": state})
            if route == "/leave":
                return self._send_json({"ok": True, "state": self.manager.leave()})
            if route == "/play":
                result = self.manager.play(str(data.get("query") or ""), data.get("volume", 1.0))
                return self._send_json({"ok": True, **result})
            if route == "/control":
                state = self.manager.control(str(data.get("action") or ""), data.get("value"))
                return self._send_json({"ok": True, "state": state})
            if route == "/record/start":
                state = self.manager.start_recording(
                    str(data.get("mode") or "mix"),
                    data.get("bitrate", DEFAULT_BITRATE),
                    bool(data.get("mix", True)),
                )
                return self._send_json({"ok": True, "state": state})
            if route == "/record/stop":
                state = self.manager.stop_recording()
                return self._send_json({"ok": True, "state": state})
            if route == "/recordings/delete":
                entry = self.manager.delete_recording(safe_recording_id(str(data.get("id") or "")))
                return self._send_json({"ok": True, "deleted": entry})
            if route == "/recordings/compress":
                entry = self.manager.compress_recording(
                    safe_recording_id(str(data.get("id") or "")),
                    data.get("bitrate", DEFAULT_BITRATE),
                )
                return self._send_json({"ok": True, "recording": entry})
            return self._send_error("Not found.", 404)
        except ValueError as exc:
            return self._send_error(str(exc), 400)
        except RuntimeError as exc:
            return self._send_error(str(exc), 503)
        except subprocess.CalledProcessError as exc:
            return self._send_error(f"ffmpeg failed: {exc}", 500)
        except Exception as exc:  # pragma: no cover - defensive
            LOG.exception("Voice service error")
            return self._send_error(str(exc) or "Voice service error.", 500)


def build_server(manager: VoiceManager, host: str, port: int, token: str) -> ThreadingHTTPServer:
    handler = type("BoundVoiceHandler", (VoiceHTTPHandler,), {"manager": manager, "token": token})
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Kizzey Discord voice service")
    parser.add_argument("--host", default=os.environ.get("VOICE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("VOICE_PORT", str(DEFAULT_PORT))))
    parser.add_argument("--token", default=os.environ.get("VOICE_TOKEN", ""))
    parser.add_argument("--discord-token", default=os.environ.get("DISCORD_TOKEN", ""))
    parser.add_argument(
        "--user-token",
        dest="user_token",
        action="store_true",
        default=None,
        help="Send the Discord token bare (account token; default).",
    )
    parser.add_argument(
        "--bot-token",
        dest="user_token",
        action="store_false",
        help="Send the Discord token as a bot token (Authorization: Bot ...).",
    )
    parser.add_argument("--ffmpeg", default=os.environ.get("VOICE_FFMPEG", "ffmpeg"))
    parser.add_argument("--ytdlp", default=os.environ.get("VOICE_YTDLP", "yt-dlp"))
    parser.add_argument("--recordings", default=os.environ.get("VOICE_RECORDINGS_DIR", "data/voice_recordings"))
    parser.add_argument("--log-level", default=os.environ.get("VOICE_LOG_LEVEL", "INFO"))
    args = parser.parse_args(argv)

    logging.basicConfig(level=getattr(logging, str(args.log_level).upper(), logging.INFO), format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    directory = Path(args.recordings)
    directory.mkdir(parents=True, exist_ok=True)

    if VOICE_IMPORT_ERROR is not None:
        LOG.error("The Discord voice stack is not installed: %s", VOICE_IMPORT_ERROR)
        LOG.error("Install voice_service/requirements.txt and run again.")
        return 2
    if not ffmpeg_available(args.ffmpeg):
        LOG.warning("ffmpeg was not found as '%s'; playback and recording will fail.", args.ffmpeg)

    manager = VoiceManager(
        default_token=args.discord_token,
        ffmpeg_bin=args.ffmpeg,
        ytdlp_bin=args.ytdlp,
        recordings=directory,
        user_token=args.user_token,
    )
    manager.start()

    if args.discord_token:
        def warm_up():
            try:
                manager.ensure_client()
            except Exception as exc:  # pragma: no cover - depends on the token
                LOG.warning("Could not connect to Discord at startup: %s", exc)

        threading.Thread(target=warm_up, name="voice-warmup", daemon=True).start()

    server = build_server(manager, args.host, args.port, args.token)
    if not args.token and args.host not in ("127.0.0.1", "localhost", "::1"):
        LOG.warning("VOICE_TOKEN is not set and the service is not bound to loopback; non-local requests will be rejected.")

    LOG.info(
        "Kizzey voice service listening on http://%s:%s (receive backend: %s)",
        args.host,
        args.port,
        VOICE_BACKEND or "none",
    )
    thread = threading.Thread(target=server.serve_forever, name="voice-http", daemon=True)
    thread.start()

    stop = threading.Event()

    def request_stop(signum, frame):  # noqa: ARG001
        LOG.info("Stopping voice service (signal %s).", signum)
        stop.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, request_stop)
        except (ValueError, OSError):
            pass

    try:
        while not stop.is_set():
            stop.wait(1)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        manager.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
