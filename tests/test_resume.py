#!/usr/bin/env python3
"""Checks that live presences survive a server restart.

The test uses the real Store, presence builders and restart helper, with every
outbound Discord socket replaced by a fake pool. It never touches the network.
"""
import atexit
import copy
import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = Path(tempfile.mkdtemp(prefix="kizzey-resume-test-"))
atexit.register(shutil.rmtree, WORK, ignore_errors=True)
sys.path.insert(0, str(ROOT))

import server  # noqa: E402

DATA = WORK / "data"
UPLOADS = DATA / "uploads"
TMP = DATA / "tmp"
for directory in (DATA, UPLOADS, TMP):
    directory.mkdir(parents=True, exist_ok=True)
server.DATA_DIR = DATA
server.UPLOAD_DIR = UPLOADS
server.TMP_DIR = TMP
server.STATE_FILE = DATA / "state.json"
server.SECRET_FILE = DATA / "secret.json"
server.CHAT_FILE = DATA / "chat.json"
server.HISTORY_FILE = DATA / "history.json"
server.LOG_FILE = DATA / "kizzey.log"

checks = []


def check(condition, label, extra=""):
    checks.append(bool(condition))
    if condition:
        print(f"ok: {label}")
    else:
        print(f"FAIL: {label}" + (f" — {extra}" if extra else ""))


class FakeGateway:
    """Minimal GatewayPool: records starts and queued presence payloads."""

    def __init__(self):
        self.ensured = []
        self.presences = []

    @staticmethod
    def _resolve(account_id=""):
        return str(account_id or "") or (server.STORE.active_account_id() if server.STORE else "")

    def ensure(self, account_id=""):
        account_id = self._resolve(account_id)
        self.ensured.append(account_id)
        return account_id

    def send_presence(self, presence, account_id=""):
        self.presences.append((self._resolve(account_id), copy.deepcopy(presence)))

    def reconcile(self):
        pass

    def stop_all(self):
        pass


def user(user_id, username, display):
    return {
        "id": str(user_id),
        "username": username,
        "global_name": display,
        "displayName": display,
        "avatar": None,
        "discriminator": "0",
        "verified": True,
    }


def set_card(store, account_id, name, details, status):
    with store.lock:
        card = store.custom_for(account_id)
        card["name"] = name
        card["details"] = details
        card["state"] = f"{name} state"
        card["status"] = status
        store.save()


def active_sends(fake):
    return [item for item in fake.presences if item[1] is not None]


# ---------------------------------------------------------------------------
# Start two accounts with different cards, then reload the store as a restart.
# ---------------------------------------------------------------------------
server.GATEWAY = FakeGateway()
store = server.Store()
server.STORE = store
alpha, _ = store.upsert_account("tok-alpha-111", user(100000000000000001, "alpha", "Alpha"))
beta, _ = store.upsert_account("tok-beta-222", user(100000000000000002, "beta", "Beta"))
store.activate_account(alpha["id"], user(100000000000000001, "alpha", "Alpha"))
set_card(store, alpha["id"], "Alpha restarts", "Alpha survives", "idle")
set_card(store, beta["id"], "Beta restarts", "Beta survives", "dnd")

server.start_presence("custom", account_id=alpha["id"])
server.start_presence("custom", account_id=beta["id"])
alpha_started = store.state["presences"][alpha["id"]]["startedAt"]
beta_started = store.state["presences"][beta["id"]]["startedAt"]
saved = json.loads(server.STATE_FILE.read_text(encoding="utf-8"))
check(
    saved["presences"][alpha["id"]]["active"]["kind"] == "custom"
    and saved["presences"][beta["id"]]["active"]["kind"] == "custom",
    "active presences are written to the state file",
)

server.GATEWAY = FakeGateway()
store = server.Store()
server.STORE = store
check(
    sorted(store.state["presences"]) == sorted([alpha["id"], beta["id"]]),
    "a fresh Store restores both live presences",
)
check(
    not store.state.get("gateways"),
    "gateway socket records stay runtime-only after a restart",
)
check(
    store.state["presences"][alpha["id"]]["startedAt"] == alpha_started
    and store.state["presences"][beta["id"]]["startedAt"] == beta_started,
    "resume keeps each card's original start time",
)

resumed = server.resume_live_presences()
check(resumed == 2, "resume_live_presences queues both active accounts", str(resumed))
sends = active_sends(server.GATEWAY)
check(
    [account_id for account_id, _ in sends]
    == [alpha["id"], beta["id"]],
    "each account gets its own resumed gateway payload",
    str([account_id for account_id, _ in sends]),
)
check(
    sends[0][1]["activities"][0]["name"] == "Alpha restarts"
    and sends[0][1]["activities"][0]["details"] == "Alpha survives",
    "alpha resumes its own Custom RPC card",
)
check(
    sends[1][1]["activities"][0]["name"] == "Beta restarts"
    and sends[1][1]["activities"][0]["details"] == "Beta survives",
    "beta resumes its own Custom RPC card",
)
check(
    sends[0][1]["status"] == "idle" and sends[1][1]["status"] == "dnd",
    "each resumed account keeps its own presence status",
)
check(
    store.state["presence"]["active"]["kind"] == "custom"
    and store.state["presence"]["info"]["title"] == "Alpha restarts",
    "the focused account's UI state is rebuilt after resume",
)

# A second restart must not duplicate or lose the same live cards.
server.GATEWAY = FakeGateway()
store = server.Store()
server.STORE = store
check(
    server.resume_live_presences() == 2
    and len(active_sends(server.GATEWAY)) == 2,
    "resume is idempotent across repeated restarts",
)

# ---------------------------------------------------------------------------
# Explicitly stopped cards must not come back.
# ---------------------------------------------------------------------------
server.stop_presence(None, account_id=alpha["id"])
server.stop_presence(None, account_id=beta["id"])
server.GATEWAY = FakeGateway()
store = server.Store()
server.STORE = store
check(
    server.resume_live_presences() == 0 and not active_sends(server.GATEWAY),
    "stopped accounts stay stopped after a restart",
)

# ---------------------------------------------------------------------------
# A saved presence with no token is not resurrected.
# ---------------------------------------------------------------------------
set_card(store, alpha["id"], "Valid again", "This one starts", "online")
server.start_presence("custom", account_id=alpha["id"])
with store.lock:
    store.state["presences"]["acct_without_token"] = copy.deepcopy(
        store.state["presences"][alpha["id"]]
    )
    store.save()
server.GATEWAY = FakeGateway()
store = server.Store()
server.STORE = store
check(
    "acct_without_token" not in store.state["presences"]
    and alpha["id"] in store.state["presences"],
    "presence records without a usable account token are dropped",
)

# ---------------------------------------------------------------------------
# A card that can no longer be built is cleared instead of showing as live.
# ---------------------------------------------------------------------------
with store.lock:
    store.custom_for(alpha["id"])["name"] = ""
    store.save()
server.GATEWAY = FakeGateway()
store = server.Store()
server.STORE = store
resumed = server.resume_live_presences()
check(
    resumed == 0
    and not active_sends(server.GATEWAY)
    and not (store.state["presences"].get(alpha["id"]) or {}).get("active"),
    "an unbuildable saved card is cleared on resume",
)

passed = sum(1 for item in checks if item)
print(f"\n{passed}/{len(checks)} resume checks passed")
if passed != len(checks):
    raise SystemExit(1)
