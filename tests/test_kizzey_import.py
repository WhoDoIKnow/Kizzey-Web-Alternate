#!/usr/bin/env python3
"""Integration checks for Kizzey Android backup/config import."""
import atexit
import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = None


def free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


PORT = int(os.environ.get("KIZZEY_TEST_PORT") or 0) or free_port()
BASE = f"http://127.0.0.1:{PORT}"

checks = []


def safe_text(value):
    """Keep failure previews printable on consoles that are not UTF-8."""
    encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
    text = str(value)
    try:
        return text.encode(encoding, "replace").decode(encoding, "replace")
    except Exception:
        return text.encode("ascii", "replace").decode("ascii")


def check(condition, label, extra=""):
    checks.append(bool(condition))
    if not condition:
        print(safe_text(f"FAIL: {label}" + (f" — {extra}" if extra else "")))
    else:
        print(f"ok: {label}")


def png_1x1():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    header = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    raw = b"\x00\xff\x00\x00\xff"  # filter + RGBA red
    return header + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def request(method, path, payload=None):
    raw = None
    headers = {}
    if payload is not None:
        raw = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=raw, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode()
        try:
            return exc.code, json.loads(body)
        except Exception:
            return exc.code, {"raw": body}


def request_raw(method, path, payload=None):
    raw = None
    headers = {}
    if payload is not None:
        raw = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=raw, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers, exc.read()


def wait_server():
    for _ in range(80):
        try:
            status, data = request("GET", "/api/health")
            if status == 200 and data.get("ok"):
                return True
        except Exception:
            pass
        time.sleep(0.1)
    return False


def saved_names(state):
    return [p.get("name") for p in (state.get("savedConfigs") or []) if isinstance(p, dict)]


def find_saved(state, name):
    for row in state.get("savedConfigs") or []:
        if isinstance(row, dict) and row.get("name") == name:
            return row
    return None


def main():
    global WORK
    WORK = Path(tempfile.mkdtemp(prefix="kizzey-import-test-"))
    atexit.register(shutil.rmtree, WORK, ignore_errors=True)
    shutil.copy2(ROOT / "server.py", WORK / "server.py")
    child_env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    proc = subprocess.Popen(
        [sys.executable, "server.py", "--host", "127.0.0.1", "--port", str(PORT), "--no-gateway"],
        cwd=str(WORK), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding="utf-8", errors="replace", env=child_env,
    )
    try:
        if not wait_server():
            print(proc.stdout.read() if proc.poll() is not None else "server did not start")
            raise SystemExit(1)
        status, initial = request("GET", "/api/state")
        check(status == 200 and initial.get("ok"), "initial state available")
        state0 = initial["state"]
        check(state0.get("savedConfigs") == [], "clean saved presets")

        art = base64.b64encode(png_1x1()).decode()
        now = int(time.time() * 1000)
        active_config = {
            "name": "Active Card",
            "details": "details from the active card",
            "state": "state from the active card",
            "type": "2",
            "status": "idle",
            "platform": "android",
            "timestampsStart": str(now - 60000),
            "largeImg": "https://example.com/active.png",
            "large_text": "Active cover",
            "button1": "Active",
            "button1link": "https://example.com/active",
        }
        saved_config = {
            "name": "Night Drive",
            "details": "Listening with Kizzey",
            "state": "the web build",
            "type": "2",
            "status": "dnd",
            "platform": "android",
            "timestampsStart": "1700000000000",
            "largeImg": "https://example.com/cover.png",
            "large_text": "Cover text",
            "smallImg": "mp:external/abc",
            "small_text": "Small text",
            "button1": "Open",
            "button1link": "https://example.com/open",
            "button2": "Second",
            "button2link": "https://example.com/second",
            "partyCurrentSize": "2",
            "partyMaxSize": "5",
        }
        template = {
            "id": "template-one",
            "title": "Imported Template",
            "config": {
                "name": "Template Card",
                "details": "Full template details",
                "state": "Full template state",
                "type": "3",
                "status": "online",
                "platform": "android",
                "button1": "Template",
                "button1link": "https://example.com/template",
            },
            "applicationId": "123456789012345678",
            "largeImage": {
                "kind": "local_upload",
                "value": "/data/user/0/xyz.Kizzey/files/rpc_preset_images/art.png",
                "lastUpload": "",
            },
            "smallImage": {"kind": "url", "value": "https://example.com/small.png"},
            "timestampMode": "since_apply",
            "updatedTs": now,
        }
        text_presets = [
            {
                "title": "Late Night",
                "name": "Album",
                "details": "Quiet hours",
                "state": "One more song",
                "image": "https://example.com/preset.png",
            },
            {"title": "", "name": "No title preset", "details": "", "state": "", "image": ""},
            {"title": "", "name": "", "details": "", "state": "", "image": ""},
        ]
        prefs = {
            "token": "TOP-SECRET-TOKEN-VALUE",
            "user_data": '{"username":"RealPerson","global_name":"Real Person"}',
            "user_id": "999999999999999999",
            "user_bio": "private bio",
            "dark_theme_value": 3,
            "high_contrast": True,
            "dynamic_color": True,
            "accent_from_art": True,
            "art_background": True,
            "art_background_blur": 32,
            "art_background_dim": 55,
            "theme_color": -5254415,
            "ui_scale": 1.5,
            "home_layout_list": True,
            "home_grid_columns": 3,
            "home_sections_order": "progress,recommended,updates,promo,quick,pinned,recent,gallery,chat,contribute,stats,support,categories,devwall,about",
            "home_sections_hidden": "about,progress,recommended",
            "welcome_message": "Hello {{user}}",
            "show_active_now_on_home": False,
            "chat_home_preview_enabled": False,
            "realtime_notif_enabled": True,
            "k844p1_language_tag": "pl",
            "use_saved_rpc_buttons": True,
            "saved_rpc_buttons_data": json.dumps({
                "button1": "Listen",
                "button1Url": "https://example.com/listen",
                "button2": "",
                "button2Url": "",
            }),
            "last_run_custom_rpc": json.dumps(active_config),
            "custom_activity_type": 2,
            "custom_activity_status": "idle",
            "custom_activity_application_id_": "123456789012345678",
            "custom_activity_stream_url": "https://example.com/live",
            "custom_rpc_status_display_type": 2,
            "custom_rpc_status_roll": True,
            "custom_rpc_status_roll_interval": 7,
            "k844_lyrics_roll_lines_custom": "[0,2]",
            "enable_timestamps": False,
            "hide_on_pause": True,
            "media_rpc_activity_type": 2,
            "k844p2_rpc_media_pause_status": "idle",
            "media_cycling_enabled": True,
            "media_cycling_types": "[0,2,5]",
            "media_cycling_interval": 12,
            "media_cycling_stream_url": "https://example.com/stream",
            "custom_css_theme": "{\"scheme\":{}}",
            "custom_rpc_template_presets": json.dumps([template]),
            "rpc_presence_presets": json.dumps(text_presets),
        }
        backup = {
            "format": "kizzey-backup",
            "version": 2,
            "appVersion": "8.4.4",
            "appVersionCode": 99,
            "exportedAt": now,
            "includesAccount": True,
            "prefs": prefs,
            "configs": {"Saved Config.json": json.dumps(saved_config)},
            "presetImages": {"art.png": art},
        }
        status, data = request("POST", "/api/import", {"backup": backup, "fileName": "Kizzey-settings-test.json"})
        check(status == 200 and data.get("ok"), "Kizzey settings backup imports", str(data)[:300])
        state = data.get("state", {})
        report = data.get("import", {})
        settings = state.get("settings", {})
        custom = state.get("custom", {})
        media = state.get("media", {})
        cycling = state.get("cycling", {})
        check(settings.get("theme") == "light", "dark theme value 3 maps to light")
        check(settings.get("accent") == "#afd2f1", "ARGB theme colour maps to accent", settings.get("accent"))
        check(settings.get("highContrast") is True and settings.get("dynamicColor") is True, "contrast and dynamic colour map")
        check(settings.get("fontScale") == 1.2, "UI scale clamps to web maximum", settings.get("fontScale"))
        check(settings.get("homeLayout") == "list" and settings.get("homeColumns") == 2, "Home layout maps")
        check(settings.get("homeOrder") == ["updates", "quick", "recent", "chat", "stats", "about"], "Home section order filters to web sections", settings.get("homeOrder"))
        check(settings.get("hiddenHome") == ["about"], "Home hidden sections map", settings.get("hiddenHome"))
        check(settings.get("greeting") == "Hello {{user}}", "welcome message maps to greeting")
        check(settings.get("notifications") is True and settings.get("showChatPreview") is False, "notification and chat preview toggles map")
        check(settings.get("language") == "pl", "language tag maps")
        check(settings.get("showButtons") is True and settings.get("button1") == "Listen", "saved RPC buttons map")
        check(settings.get("button1link") == "https://example.com/listen", "saved RPC button URL maps")
        check(custom.get("name") == "Active Card" and custom.get("details") == "details from the active card", "active Custom RPC card maps")
        check(custom.get("type") == "2" and custom.get("status") == "idle", "custom type and status map")
        check(custom.get("applicationId") == "123456789012345678", "custom application ID maps")
        check(custom.get("url") == "https://example.com/live", "stream URL maps")
        check(custom.get("statusDisplayType") == 2 and settings.get("statusDisplay") == 2, "status display maps")
        check(settings.get("statusRoll") is True and settings.get("statusRollInterval") == 7, "status roll settings map")
        check(settings.get("statusRollLines") == ["name", "details"], "status roll lines map")
        check(media.get("showProgress") is False and media.get("hideOnPause") is True, "media toggles map")
        check(media.get("type") == 2 and media.get("hiddenStatus") == "idle", "media type and pause status map")
        check(cycling.get("enabled") is True and cycling.get("types") == [0, 2, 5], "media cycling maps")
        check(cycling.get("interval") == 12 and cycling.get("streamUrl") == "https://example.com/stream", "media cycling interval and URL map")
        names = saved_names(state)
        check(names[:4] == ["Imported Template", "Saved Config", "Late Night", "No title preset"], "template, config and text presets all import", names)
        check(report.get("configs") == 1 and report.get("templatePresets") == 1 and report.get("textPresets") == 2, "import report counts source types", report)
        check(report.get("images") == 1, "embedded preset artwork imports", report)
        check(report.get("accountIgnored") is True, "account inclusion is reported")
        check(any("account" in warning.lower() for warning in report.get("warnings", [])), "account warning present", report.get("warnings"))
        check(any("custom CSS" in warning for warning in report.get("warnings", [])), "custom CSS palette warning present", report.get("warnings"))
        check(any("preset entry was malformed" in warning for warning in report.get("warnings", [])), "malformed preset entries are reported", report.get("warnings"))
        template_row = find_saved(state, "Imported Template")
        check(template_row and template_row["custom"].get("applicationId") == "123456789012345678", "template application ID preserved")
        check(template_row and template_row["custom"].get("largeUrl", "").startswith("/uploads/"), "template local artwork becomes a local upload")
        art_name = template_row["custom"]["largeUrl"].split("/")[-1] if template_row else ""
        check((WORK / "data" / "uploads" / art_name).exists(), "template artwork file exists on disk", art_name)
        check(template_row and template_row["custom"].get("smallUrl") == "https://example.com/small.png", "template URL artwork preserved")
        check(template_row and template_row["custom"].get("timestampsStart", "").isdigit(), "template since-apply timestamp materialises")
        check(template_row and template_row.get("timestamp") == {"mode": "since_apply"}, "template since-apply mode survives application", template_row.get("timestamp") if template_row else None)

        # A fixed date stored in startAbsolute wins over timestampMode, matching RpcPresetApply.
        fixed_start = now - 30 * 24 * 60 * 60 * 1000
        fixed_stop = fixed_start + 60 * 60 * 1000
        fixed_backup = {
            "format": "kizzey-backup",
            "version": 2,
            "prefs": {
                "custom_rpc_template_presets": json.dumps([{
                    "title": "Anniversary",
                    "source": "user",
                    "updatedTs": now,
                    "startAbsolute": fixed_start,
                    "stopAbsolute": fixed_stop,
                    "timestampMode": "duration",
                    "durationMs": fixed_stop - fixed_start,
                    "largeImage": {"kind": "none", "value": ""},
                    "smallImage": {"kind": "none", "value": ""},
                    "config": {"name": "Anniversary", "details": "A fixed date"},
                }]),
            },
        }
        status, fixed_data = request("POST", "/api/import", {"backup": fixed_backup, "fileName": "fixed-date.json"})
        fixed_row = find_saved(fixed_data.get("state", {}), "Anniversary")
        expected_fixed = {"mode": "absolute", "start": str(fixed_start), "stop": str(fixed_stop)}
        check(status == 200 and fixed_row is not None, "fixed-date template imports", str(fixed_data)[:300])
        check(fixed_row and fixed_row.get("timestamp") == expected_fixed, "fixed date wins over a restarted duration mode", fixed_row.get("timestamp") if fixed_row else None)
        check(fixed_row and fixed_row.get("custom", {}).get("timestampsStart") == str(fixed_start), "fixed-date template keeps its absolute start")

        config_row = find_saved(state, "Saved Config")
        check(config_row and config_row.get("timestamp") == {"mode": "absolute", "start": "1700000000000", "stop": ""}, "saved config absolute timestamps survive application", config_row.get("timestamp") if config_row else None)
        ccfg = config_row["custom"] if config_row else {}
        check(ccfg.get("largeUrl") == "https://example.com/cover.png", "saved config external artwork preserved")
        check(ccfg.get("smallImg") == "mp:external/abc", "saved config display asset preserved")
        check(ccfg.get("button1link") == "https://example.com/open" and ccfg.get("button2link") == "https://example.com/second", "saved config buttons preserved")
        check(ccfg.get("partyCurrentSize") == "2" and ccfg.get("partyMaxSize") == "5", "saved config party preserved")
        check(ccfg.get("largeText") == "Cover text" and ccfg.get("smallText") == "Small text", "saved config asset text preserved")
        text_row = find_saved(state, "Late Night")
        check(text_row and text_row["custom"].get("largeUrl") == "https://example.com/preset.png", "text preset image preserved")
        check(text_row and text_row.get("timestamp") == {"mode": "none"}, "text presets carry no stale timestamps")
        check("TOP-SECRET-TOKEN-VALUE" not in json.dumps(data), "token never appears in import response")
        raw_state = (WORK / "data" / "state.json").read_text(encoding="utf-8")
        check("TOP-SECRET-TOKEN-VALUE" not in raw_state and "RealPerson" not in raw_state, "account/token fields are not written to state")
        check("TOP-SECRET-TOKEN-VALUE" not in (WORK / "data" / "kizzey.log").read_text(encoding="utf-8"), "token never appears in server log")

        # Stand-alone Kizzey RpcConfig.
        single = {
            "name": "Road Trip",
            "details": "Miles ahead",
            "state": "Somewhere north",
            "type": "0",
            "status": "online",
            "platform": "android",
            "largeImg": "https://example.com/road.png",
            "smallImg": "/data/user/0/xyz.Kizzey/files/rpc_images/local.png",
            "button1": "Route",
            "button1link": "https://example.com/route",
        }
        status, data2 = request("POST", "/api/import", {"backup": single, "fileName": "Road Trip.json"})
        check(status == 200 and data2.get("ok"), "stand-alone RPC config imports", str(data2)[:300])
        state2 = data2.get("state", {})
        row = find_saved(state2, "Road Trip")
        check(row is not None and row["custom"].get("details") == "Miles ahead", "stand-alone card title and fields preserved")
        check(data2.get("import", {}).get("kind") == "kizzey-config", "stand-alone import is reported as an RPC config")
        check(any("local Android image" in warning for warning in data2.get("import", {}).get("warnings", [])), "stand-alone local image path warning", data2.get("import", {}).get("warnings"))
        check("local.png" not in json.dumps(state2), "stand-alone local image path is not stored")

        # Preset pack: same title replaces local card, new title adds one.
        pack = {
            "format": "kizzey-preset",
            "version": 1,
            "appVersion": "8.4.4",
            "exportedAt": now,
            "presets": [
                {"title": "Late Night", "name": "Replaced Album", "details": "New details", "state": "", "image": "https://example.com/new.png"},
                {"title": "Sunrise", "name": "Morning", "details": "Early light", "state": "", "image": ""},
            ],
        }
        before_count = len(state2.get("savedConfigs") or [])
        status, data3 = request("POST", "/api/import", {"backup": pack, "fileName": "Kizzey-presets-test.json"})
        check(status == 200 and data3.get("ok"), "Kizzey preset pack imports", str(data3)[:300])
        state3 = data3.get("state", {})
        names3 = saved_names(state3)
        check(len(names3) == before_count + 1, "same-title preset replaces rather than duplicates", names3)
        check(find_saved(state3, "Late Night")["custom"].get("details") == "New details", "imported preset copy wins")
        check(data3.get("import", {}).get("kind") == "kizzey-preset", "preset pack reported as preset file")
        check(data3.get("import", {}).get("presets") == 2, "preset pack count is reported")

        # Duplicate titles inside a Kizzey backup and newer format version.
        dup_backup = {
            "format": "kizzey-backup",
            "version": 99,
            "appVersion": "9.0.0",
            "prefs": {
                "theme_color": "#112233",
                "rpc_presence_presets": json.dumps([
                    {"title": "Same", "name": "One", "details": "", "state": ""},
                    {"title": "Same", "name": "Two", "details": "", "state": ""},
                ]),
            },
            "configs": {},
            "presetImages": {},
        }
        status, data4 = request("POST", "/api/import", {"backup": dup_backup, "fileName": "newer.json"})
        check(status == 200, "newer Kizzey backup imports with a warning", str(data4)[:300])
        r4 = data4.get("import", {})
        check(r4.get("presets") == 1 and any("duplicate" in w.lower() for w in r4.get("warnings", [])), "duplicate titles are merged", r4)
        check(any("version 99" in w for w in r4.get("warnings", [])), "newer format warning present", r4.get("warnings"))

        # Raw config and preset arrays are accepted at the top level.
        raw_configs = [
            {"name": "Raw Config One", "details": "First raw card", "button1": "Open", "button1link": "https://example.com/raw"},
            {"name": "Raw Config Two", "details": "Second raw card", "largeImg": "https://example.com/raw.png"},
        ]
        status, raw_data = request("POST", "/api/import", raw_configs)
        check(status == 200 and raw_data.get("import", {}).get("kind") == "kizzey-config", "raw config array imports", str(raw_data)[:300])
        check(raw_data.get("import", {}).get("presets") == 2, "raw config array reports both cards")
        status, raw_data = request("POST", "/api/import", [{"title": "Raw Preset", "name": "Raw Album", "details": "Raw details"}])
        check(status == 200 and raw_data.get("import", {}).get("kind") == "kizzey-preset", "raw preset array imports", str(raw_data)[:300])
        status, raw_data = request("POST", "/api/import", {"image": "https://example.com/image-only.png"})
        check(status == 200 and raw_data.get("import", {}).get("kind") == "kizzey-preset", "image-only raw preset is recognised", str(raw_data)[:300])
        status, raw_error = request("POST", "/api/import", "just a string")
        check(status == 400, "a non-object JSON body is rejected", str(raw_error))

        # Untitled presets are appended, even when their display names collide.
        untitled_pack = {
            "format": "kizzey-preset",
            "version": 1,
            "presets": [
                {"title": "", "name": "Twin", "details": "First untitled", "state": "One"},
                {"title": "", "name": "Twin", "details": "Second untitled", "state": "Two"},
            ],
        }
        status, untitled_data = request("POST", "/api/import", {"backup": untitled_pack, "fileName": "untitled.json"})
        twins = [row for row in untitled_data.get("state", {}).get("savedConfigs", []) if row.get("name") == "Twin"]
        check(status == 200 and len(twins) == 2, "untitled presets with the same display name are all imported", untitled_data.get("import"))
        check(all(row.get("sourceTitle") == "" for row in twins), "untitled presets carry an empty merge title")
        status, untitled_data = request("POST", "/api/import", {"backup": untitled_pack, "fileName": "untitled-again.json"})
        twins = [row for row in untitled_data.get("state", {}).get("savedConfigs", []) if row.get("name") == "Twin"]
        check(status == 200 and len(twins) == 4, "re-importing untitled presets appends rather than replaces", len(twins))

        # A per-file preset cap is reported rather than silently truncating.
        limit_pack = {
            "format": "kizzey-preset",
            "version": 1,
            "presets": [
                {"title": f"Limit {index}", "name": "Cap", "details": "Limit test"}
                for index in range(301)
            ],
        }
        status, limit_data = request("POST", "/api/import", {"backup": limit_pack, "fileName": "limit.json"})
        limit_report = limit_data.get("import", {})
        check(status == 200 and limit_report.get("presets") == 300, "preset packs cap at 300", limit_report)
        check(any("first 300" in warning for warning in limit_report.get("warnings", [])), "preset truncation is reported", limit_report.get("warnings"))

        # Raw config arrays have their own per-file cap, and the saved-card store has a hard cap.
        limit_configs = [
            {"name": f"Config limit {index}", "details": "Cap", "state": "Config test"}
            for index in range(301)
        ]
        status, limit_data = request("POST", "/api/import", limit_configs)
        limit_report = limit_data.get("import", {})
        check(status == 200 and limit_report.get("presets") == 300, "raw config arrays cap at 300", limit_report)
        check(any("first 300" in warning for warning in limit_report.get("warnings", [])), "config truncation is reported", limit_report.get("warnings"))
        check(any("local limit of 500" in warning for warning in limit_report.get("warnings", [])), "older saved cards are dropped at the local cap", limit_report.get("warnings"))

        # Unsafe relative upload paths are not treated as imported artwork references.
        unsafe = {"name": "Unsafe Art", "details": "Should not keep a traversal path", "largeImg": "/uploads/../state.json"}
        status, unsafe_data = request("POST", "/api/import", {"backup": unsafe})
        unsafe_row = find_saved(unsafe_data.get("state", {}), "Unsafe Art")
        check(status == 200 and unsafe_row is not None, "config with an unsafe image path still imports", str(unsafe_data)[:300])
        check(unsafe_row and "state.json" not in json.dumps(unsafe_row.get("custom", {})), "unsafe /uploads path is discarded", unsafe_row.get("custom") if unsafe_row else None)

        # Template artwork comes only from the image refs, never the ignored config fields.
        no_art = {
            "format": "kizzey-backup",
            "version": 2,
            "prefs": {
                "custom_rpc_template_presets": json.dumps([{
                    "title": "No Art",
                    "config": {
                        "name": "No Art",
                        "details": "Ignore stale config artwork",
                        "largeImg": "https://example.com/ignored.png",
                        "timestampsStart": "1700000000000",
                        "timestampsStop": "1700000060000",
                    },
                    "largeImage": {"kind": "none", "value": ""},
                }]),
            },
        }
        status, no_art_data = request("POST", "/api/import", {"backup": no_art, "fileName": "no-art.json"})
        no_art_row = find_saved(no_art_data.get("state", {}), "No Art")
        check(status == 200 and no_art_row is not None, "template with no image ref imports")
        check(no_art_row and not no_art_row.get("custom", {}).get("largeUrl") and not no_art_row.get("custom", {}).get("largeImg"), "template ignores stale config.largeImg when the image ref is none")
        check(no_art_row and no_art_row.get("timestamp") == {"mode": "none"} and not no_art_row.get("custom", {}).get("timestampsStart"), "template ignores stale config timestamps when no timestamp fields are set")
        unsafe_data = no_art_data

        # Many malformed config files are summarised instead of hiding other notes.
        malformed_backup = {
            "format": "kizzey-backup",
            "version": 2,
            "prefs": {
                "rpc_presence_presets": json.dumps([{"title": "Still Here", "name": "Kept", "details": "Valid preset", "state": ""}]),
            },
            "configs": {f"broken-{index}.json": "{not json" for index in range(4)},
        }
        status, malformed_data = request("POST", "/api/import", {"backup": malformed_backup, "fileName": "malformed-configs.json"})
        malformed_report = malformed_data.get("import", {})
        check(status == 200 and malformed_report.get("presets") == 1, "valid data still imports beside malformed configs", malformed_report)
        check(any("4 saved config files could not be read" in warning for warning in malformed_report.get("warnings", [])), "malformed configs are summarised in the result", malformed_report.get("warnings"))
        check(sum("saved config" in warning and "could not be read" in warning for warning in malformed_report.get("warnings", [])) == 4, "only the first malformed config names are listed individually", malformed_report.get("warnings"))
        status, log_data = request("GET", "/api/logs")
        check(status == 200 and any("4 saved config files could not be read" in entry.get("message", "") for entry in log_data.get("logs", [])), "import warnings are written to Logs")
        unsafe_data = malformed_data

        # Empty / unsupported / account-only input must not change state.
        state_before_error = unsafe_data.get("state", {})
        status, err = request("POST", "/api/import", {"backup": {"format": "not-kizzey"}, "fileName": "x.json"})
        check(status == 400, "unknown format is rejected", str(err))
        status, err = request("POST", "/api/import", {"backup": {"format": "kizzey-preset", "presets": []}, "fileName": "empty.json"})
        check(status == 400, "empty preset pack is rejected")
        status, err = request("POST", "/api/import", {
            "backup": {
                "format": "kizzey-backup",
                "version": 2,
                "prefs": {"token": "NOPE", "user_data": "{}", "user_id": "1"},
                "configs": {},
                "presetImages": {},
            },
            "fileName": "account-only.json",
        })
        check(status == 400, "account-only backup is rejected as having no importable data")
        status, after_errors = request("GET", "/api/state")
        check(after_errors.get("state", {}).get("savedConfigs") == state_before_error.get("savedConfigs"), "failed imports do not alter presets")
        check(after_errors.get("state", {}).get("settings") == state_before_error.get("settings"), "failed imports do not alter settings")

        # Existing Web backup path still works and reports its type.
        web_payload = {
            "format": "kizzey-web-backup",
            "version": "8.4.4",
            "exportedAt": "2026-10-26T00:00:00Z",
            "state": {
                "settings": {"accent": "#123456", "fontScale": 0.9},
                "savedConfigs": [{"id": "web-one", "name": "Web Card", "custom": {"name": "Web Card"}}],
            },
        }
        status, data5 = request("POST", "/api/import", {"backup": web_payload, "fileName": "web.json"})
        check(status == 200 and data5.get("import", {}).get("kind") == "web", "web backup import remains supported", str(data5)[:300])
        web_state = data5.get("state", {})
        check(web_state.get("settings", {}).get("accent") == "#123456", "web backup state applies")
        check(saved_names(web_state) == ["Web Card"], "web backup saved presets apply")

        # Direct raw state import (previous API shape) still works.
        status, data6 = request("POST", "/api/import", {"settings": {"accent": "#abcdef"}, "savedConfigs": []})
        check(status == 200 and data6.get("import", {}).get("kind") == "web", "raw web state import remains supported")
        check(data6.get("state", {}).get("settings", {}).get("accent") == "#abcdef", "raw web state applies")

        # Saved presets: create, rename, update, download, delete.
        save_custom = {
            "name": "Preset Card",
            "details": "details line",
            "state": "state line",
            "type": "2",
            "status": "idle",
            "partyCurrentSize": "3",
            "partyMaxSize": "5",
            "button1": "Join",
            "button1link": "https://example.com/join",
            "largeUrl": "https://example.com/art.png",
            "smallText": "tiny",
            "timestampsStart": "1700000000000",
            "timestampsStop": "1700000060000",
            "applicationId": "123456789012345678",
            "url": "https://example.com/me",
        }
        status, save1 = request("POST", "/api/presets/save", {"name": "My Preset", "custom": save_custom})
        check(status == 200 and save1.get("ok"), "preset save creates a preset", str(save1)[:300])
        preset1 = save1.get("preset") or {}
        preset1_id = str(preset1.get("id") or "")
        check(save1.get("created") is True and save1.get("dropped") == 0, "new preset reports a create", save1.get("created"))
        check(preset1_id.startswith("kz-") and len(preset1_id) == 15, "saved preset gets a kz id", preset1_id)
        check(preset1.get("name") == "My Preset" and preset1.get("sourceTitle") == "My Preset", "preset keeps its name and merge title", preset1.get("name"))
        check(preset1.get("author") == "You" and preset1.get("tag") == "Saved" and bool(preset1.get("emoji")), "preset gets the local card style", (preset1.get("author"), preset1.get("tag"), preset1.get("emoji")))
        check(bool(preset1.get("gradient")), "preset gets a shelf gradient", preset1.get("gradient"))
        check(preset1.get("custom", {}).get("type") == "2", "saved card is normalised to the import shape", preset1.get("custom"))
        check(preset1.get("custom", {}).get("largeUrl") == "https://example.com/art.png" and preset1.get("custom", {}).get("largeImg") == "", "saved card keeps remote artwork in the url slot", preset1.get("custom"))
        check(preset1.get("timestamp") == {"mode": "absolute", "start": "1700000000000", "stop": "1700000060000"}, "saved card tracks its timers", preset1.get("timestamp"))
        check(saved_names(save1.get("state", {})) == ["My Preset"], "saved preset appears in state", saved_names(save1.get("state", {})))

        # A preset needs a name and at least one card field.
        status, err = request("POST", "/api/presets/save", {"custom": save_custom})
        check(status == 400, "preset save requires a name", str(err)[:200])
        status, err = request("POST", "/api/presets/save", {"name": "Blank Preset", "custom": {}})
        check(status == 400, "preset save rejects an empty card", str(err)[:200])
        status, err = request("POST", "/api/presets/save", {"id": "kz-000000000000", "name": "Ghost"})
        check(status == 400, "updating a missing preset is rejected", str(err)[:200])

        # Rename only: the stored card and its identity stay intact.
        status, rename = request("POST", "/api/presets/save", {"id": preset1_id, "name": "Renamed Preset"})
        check(status == 200 and rename.get("created") is False and rename.get("renamed") is True, "rename reports an update", str(rename)[:300])
        renamed = rename.get("preset") or {}
        check(renamed.get("id") == preset1_id and renamed.get("name") == "Renamed Preset", "rename keeps the preset id", renamed.get("id"))
        check(renamed.get("createdAt") == preset1.get("createdAt"), "rename keeps the creation time", renamed.get("createdAt"))
        check(renamed.get("custom", {}).get("details") == "details line", "rename keeps the stored card", renamed.get("custom"))
        check(renamed.get("author") == "You" and renamed.get("tag") == "Saved", "rename keeps the preset styling", (renamed.get("author"), renamed.get("tag")))

        # Update from the live card: fields are replaced, identity is not.
        updated_custom = {"name": "Preset Card v2", "details": "updated details", "state": "updated state", "type": "0"}
        status, update = request("POST", "/api/presets/save", {"id": preset1_id, "name": "Renamed Preset", "custom": updated_custom})
        check(status == 200 and update.get("created") is False and update.get("renamed") is False, "update reports an in-place edit", str(update)[:300])
        updated = update.get("preset") or {}
        check(updated.get("custom", {}).get("details") == "updated details" and updated.get("custom", {}).get("name") == "Preset Card v2", "update replaces the stored card", updated.get("custom"))
        check(updated.get("id") == preset1_id and updated.get("createdAt") == preset1.get("createdAt"), "update keeps the preset id and creation time")
        check(updated.get("timestamp") == {"mode": "none"}, "update clears timers the card no longer has", updated.get("timestamp"))
        check(updated.get("custom", {}).get("largeUrl") == "", "update drops artwork the card no longer has", updated.get("custom"))

        # Single preset download is a Kizzey RpcConfig named after the preset.
        status, headers, body = request_raw("GET", f"/api/presets/export?id={preset1_id}")
        check(status == 200 and headers.get("Content-Disposition") == 'attachment; filename="kizzey-preset-renamed-preset.json"', "preset download names the file after the preset", headers.get("Content-Disposition"))
        status, headers, body = request_raw("GET", f"/api/presets/export?id={preset1_id}")
        exported = json.loads(body.decode())
        check(exported.get("details") == "updated details" and exported.get("name") == "Preset Card v2", "preset download carries the card text", exported)
        check(exported.get("type") == 0 and exported.get("statusDisplayType") == -1, "preset download writes numeric activity fields", (exported.get("type"), exported.get("statusDisplayType")))
        check(exported.get("applicationId") == "" and exported.get("partyCurrentSize") == "", "preset download blanks fields the card does not have", exported)

        # The downloaded file must re-import through the public import route.
        status, reimport = request("POST", "/api/import", {"backup": exported, "fileName": "kizzey-preset-renamed-preset.json"})
        check(status == 200 and reimport.get("import", {}).get("kind") == "kizzey-config", "downloaded preset re-imports as a Kizzey config", str(reimport)[:300])
        round_trip = find_saved(reimport.get("state", {}), "kizzey-preset-renamed-preset")
        check(round_trip is not None, "downloaded preset imports under its file title", saved_names(reimport.get("state", {})))
        check(round_trip and round_trip.get("custom", {}).get("details") == "updated details" and round_trip.get("custom", {}).get("name") == "Preset Card v2", "downloaded preset round-trips its card", round_trip.get("custom") if round_trip else None)

        # The current card and the whole shelf download through the same route.
        status, headers, body = request_raw("GET", "/api/presets/export?current=1")
        live_config = json.loads(body.decode())
        check(status == 200 and headers.get("Content-Disposition") == 'attachment; filename="kizzey-preset-current.json"', "current card download is named for the card", headers.get("Content-Disposition"))
        check(isinstance(live_config, dict) and "statusDisplayType" in live_config, "current card download is a Kizzey config", str(live_config)[:200])
        status, headers, body = request_raw("GET", "/api/presets/export?pack=1")
        pack = json.loads(body.decode())
        check(status == 200 and pack.get("format") == "kizzey-preset", "preset pack download uses the preset format", pack.get("format"))
        check(len(pack.get("presets") or []) == 2, "preset pack lists every saved preset", len(pack.get("presets") or []))
        check(headers.get("Content-Disposition", "").startswith('attachment; filename="kizzey-presets-'), "preset pack download is dated", headers.get("Content-Disposition"))
        status, pack_import = request("POST", "/api/import", {"backup": pack, "fileName": "kizzey-presets.json"})
        check(status == 200 and pack_import.get("import", {}).get("kind") == "kizzey-preset", "downloaded pack re-imports as a preset pack", str(pack_import)[:300])

        # Shelf timers survive a downloaded pack: every entry carries its timer,
        # so re-importing restores the same apply behaviour.
        timed_pack = {
            "format": "kizzey-preset",
            "appVersion": "8.4.4",
            "presets": [
                {
                    "title": "Absolute Timer",
                    "name": "Absolute Timer",
                    "timer": {"mode": "absolute", "start": "1700000000000", "stop": "1700003600000"},
                },
                {
                    "title": "Duration Timer",
                    "name": "Duration Timer",
                    "timer": {"mode": "duration", "durationMs": 3600000},
                },
                {"title": "Since Apply", "name": "Since Apply", "timer": {"mode": "since_apply"}},
            ],
        }
        status, timed = request("POST", "/api/import", {"backup": timed_pack, "fileName": "timed.json"})
        check(status == 200 and timed.get("import", {}).get("presets") == 3, "timed preset pack imports", str(timed)[:300])
        timed_state = timed.get("state", {})
        absolute_row = find_saved(timed_state, "Absolute Timer") or {}
        check(
            absolute_row.get("timestamp") == {"mode": "absolute", "start": "1700000000000", "stop": "1700003600000"},
            "absolute timer import keeps its dates",
            absolute_row.get("timestamp"),
        )
        duration_row = find_saved(timed_state, "Duration Timer") or {}
        check(duration_row.get("timestamp") == {"mode": "duration", "durationMs": 3600000}, "duration timer import keeps its length", duration_row.get("timestamp"))
        duration_custom = duration_row.get("custom") or {}
        check(
            str(duration_custom.get("timestampsStop", "")).isdigit()
            and int(duration_custom.get("timestampsStop", "0")) - int(duration_custom.get("timestampsStart", "0")) == 3600000,
            "duration timer starts fresh from now",
            duration_custom,
        )
        since_row = find_saved(timed_state, "Since Apply") or {}
        check(since_row.get("timestamp") == {"mode": "since_apply"}, "since-apply timer import keeps its mode", since_row.get("timestamp"))
        check(since_row.get("custom", {}).get("timestampsStop") == "" and bool(since_row.get("custom", {}).get("timestampsStart")), "since-apply timer imports an open clock", since_row.get("custom"))

        status, headers, body = request_raw("GET", "/api/presets/export?pack=1")
        timed_download = json.loads(body.decode())
        timed_entries = {entry.get("title"): entry for entry in timed_download.get("presets") or [] if isinstance(entry, dict)}
        check(
            timed_entries.get("Absolute Timer", {}).get("timer") == {"mode": "absolute", "start": "1700000000000", "stop": "1700003600000"},
            "pack download keeps the absolute timer",
            timed_entries.get("Absolute Timer"),
        )
        check(timed_entries.get("Duration Timer", {}).get("timer") == {"mode": "duration", "durationMs": 3600000}, "pack download keeps the duration timer", timed_entries.get("Duration Timer"))
        check(timed_entries.get("Since Apply", {}).get("timer") == {"mode": "since_apply"}, "pack download keeps the since-apply timer", timed_entries.get("Since Apply"))
        check("timer" not in (timed_entries.get("Renamed Preset") or {}), "pack download leaves untimed presets alone", timed_entries.get("Renamed Preset"))

        status, timed_again = request("POST", "/api/import", {"backup": timed_download, "fileName": "kizzey-presets-timed.json"})
        again_state = timed_again.get("state", {})
        check(
            status == 200 and (find_saved(again_state, "Absolute Timer") or {}).get("timestamp") == {"mode": "absolute", "start": "1700000000000", "stop": "1700003600000"},
            "re-imported pack restores the absolute timer",
            (find_saved(again_state, "Absolute Timer") or {}).get("timestamp"),
        )
        check(
            (find_saved(again_state, "Duration Timer") or {}).get("timestamp") == {"mode": "duration", "durationMs": 3600000},
            "re-imported pack restores the duration timer",
            (find_saved(again_state, "Duration Timer") or {}).get("timestamp"),
        )
        check((find_saved(again_state, "Since Apply") or {}).get("timestamp") == {"mode": "since_apply"}, "re-imported pack restores the since-apply timer", (find_saved(again_state, "Since Apply") or {}).get("timestamp"))

        status, _, err = request_raw("GET", "/api/presets/export")
        check(status == 400, "preset download needs a selection", str(err[:120]))
        status, _, err = request_raw("GET", "/api/presets/export?id=kz-000000000000")
        check(status == 400, "downloading a missing preset is rejected", str(err[:120]))

        # Re-importing the pack rebuilds the shelf, so resolve the id it produced.
        # The timed pack above re-saved the same titles, so read the latest state.
        pack_row = find_saved(again_state, "Renamed Preset") or {}
        doomed_id = str(pack_row.get("id") or "")
        check(bool(doomed_id), "downloaded pack restores the renamed preset", saved_names(again_state))

        # Delete removes the preset and reports it.
        status, deleted = request("POST", "/api/presets/delete", {"id": doomed_id})
        check(status == 200 and deleted.get("removed", {}).get("id") == doomed_id, "preset delete removes the preset", str(deleted)[:300])
        check("Renamed Preset" not in saved_names(deleted.get("state", {})), "deleted preset leaves the state", saved_names(deleted.get("state", {})))
        status, err = request("POST", "/api/presets/delete", {"id": doomed_id})
        check(status == 400, "deleting a missing preset is rejected", str(err)[:200])
        status, err = request("POST", "/api/presets/delete", {})
        check(status == 400, "preset delete requires an id", str(err)[:200])

        remaining = [row for row in (deleted.get("state", {}).get("savedConfigs") or []) if isinstance(row, dict)]
        for row in remaining:
            status, _ = request("POST", "/api/presets/delete", {"id": row.get("id")})
            check(status == 200, "remaining presets delete cleanly", row.get("name"))
        status, empty = request("GET", "/api/state")
        check(empty.get("state", {}).get("savedConfigs") == [], "deleting every preset leaves an empty shelf", empty.get("state", {}).get("savedConfigs"))
        status, _, err = request_raw("GET", "/api/presets/export?pack=1")
        check(status == 400, "empty pack download is rejected", str(err[:120]))

        status, log_data = request("GET", "/api/logs")
        messages = [entry.get("message", "") for entry in log_data.get("logs", [])]
        check(any("Preset saved: My Preset" in message for message in messages), "preset saves are logged", messages[-5:])
        check(any("Preset updated: Renamed Preset" in message for message in messages), "preset updates are logged", messages[-5:])
        check(any("Preset deleted: Renamed Preset" in message for message in messages), "preset deletes are logged", messages[-5:])

        # Invalid JSON body.
        req = urllib.request.Request(BASE + "/api/import", data=b"{not json", headers={"Content-Type": "application/json"}, method="POST")
        try:
            urllib.request.urlopen(req, timeout=10)
            invalid_status = 200
        except urllib.error.HTTPError as exc:
            invalid_status = exc.code
        check(invalid_status == 400, "invalid JSON body is rejected")

        check(all(checks), f"all {len(checks)} import checks passed")
        failed = [i + 1 for i, ok in enumerate(checks) if not ok]
        if failed:
            print("Failed check numbers:", failed)
            return 1
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
