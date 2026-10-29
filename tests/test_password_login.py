#!/usr/bin/env python3
"""Checks for Discord password sign-in, MFA and token fallback.

The suite boots the real HTTP server in-process and replaces the Discord login
endpoint and the identity endpoint with deterministic fakes, so no request
leaves the machine. Everything is written to a temporary data directory.
"""
import atexit
import copy
import json
import shutil
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = Path(tempfile.mkdtemp(prefix="kizzey-login-test-"))
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
BASE = ""


def check(condition, label, extra=""):
    checks.append(bool(condition))
    if condition:
        print(f"ok: {label}")
    else:
        print(f"FAIL: {label}" + (f" — {extra}" if extra else ""))


def free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class FakeGateway:
    """Pool stand-in: one simulated socket per account id.

    Mirrors `server.GatewayPool`: `start`/`send_presence` take an optional
    account id, `stop`/`ensure`/`restart` take one, and `reconcile` opens and
    closes sockets so they match `server.wanted_gateways()`.
    """

    def __init__(self):
        self.starts = []  # (account_id, token) in start order
        self.stops = []  # account ids in stop order
        self.presences = []  # (account_id, presence)
        self.sockets = {}  # account_id -> token

    @staticmethod
    def _resolve(account_id=""):
        return str(account_id or "") or (server.STORE.active_account_id() if server.STORE else "")

    def get(self, account_id=""):
        return self._resolve(account_id)

    def running(self, account_id=""):
        return self._resolve(account_id) in self.sockets

    def active_ids(self):
        return sorted(self.sockets)

    @staticmethod
    def token_for(account_id):
        if not account_id or server.STORE is None:
            return ""
        account = server.STORE.account_by_id(account_id, include_token=True)
        return server.clean_discord_token((account or {}).get("token"))

    def ensure(self, account_id=""):
        account_id = self._resolve(account_id)
        token = self.token_for(account_id)
        if account_id and token and account_id not in self.sockets:
            self.start(token, account_id)
        return account_id

    def start(self, token, account_id=""):
        account_id = self._resolve(account_id)
        self.starts.append((account_id, token))
        self.sockets[account_id] = token

    def stop(self, account_id=""):
        account_id = self._resolve(account_id)
        self.stops.append(account_id)
        self.sockets.pop(account_id, None)

    def stop_all(self):
        for account_id in list(self.sockets):
            self.stop(account_id)

    def restart(self, account_id=""):
        account_id = self._resolve(account_id)
        if not account_id:
            return
        if account_id in self.sockets:
            self.stop(account_id)
        self.reconcile()

    def send_presence(self, presence, account_id=""):
        self.presences.append((self._resolve(account_id), presence))

    def reconcile(self):
        wanted = server.wanted_gateways()
        for account_id in list(self.sockets):
            if account_id not in wanted:
                self.stop(account_id)
        for account_id, token in wanted.items():
            if account_id not in self.sockets:
                self.start(token, account_id)

    def tokens_for(self, account_id):
        return [token for owner, token in self.starts if owner == account_id]


def fake_user(user_id, username, global_name):
    return {
        "id": user_id,
        "username": username,
        "global_name": global_name,
        "avatar": None,
        "discriminator": "0",
        "verified": True,
    }


DELTA_ID = "100000000000000009"
GAMMA_ID = "100000000000000003"

USERS = {
    "tok-delta-pw-111": fake_user(DELTA_ID, "delta", "Delta"),
    "tok-delta-mfa-222": fake_user(DELTA_ID, "delta", "Delta"),
    "tok-gamma-333": fake_user(GAMMA_ID, "gamma", "Gamma"),
}
BAD_TOKEN = "tok-bad-999"

MFA_CODE = "123456"

LOGIN_CALLS = []


def fake_login_post(url, body, timeout=25):
    LOGIN_CALLS.append((url, dict(body or {})))
    if url == server.DISCORD_MFA_API:
        code = str((body or {}).get("data") or "")
        if code != MFA_CODE:
            info = {"message": "Invalid two-factor code", "code": 50035}
            raise server.DiscordError(401, server._login_error_message(401, info), info)
        return {"token": "tok-delta-mfa-222"}
    if url != server.DISCORD_LOGIN_API:
        raise AssertionError(f"unexpected login URL: {url}")
    password = str((body or {}).get("password") or "")
    if password == "right-password":
        return {"token": "tok-delta-pw-111"}
    if password == "mfa-password":
        return {"ticket": "ticket-abc", "mfa": ["totp"]}
    if password == "wrong-password":
        info = {"message": "Invalid Form Body", "code": 50035}
        raise server.DiscordError(401, server._login_error_message(401, info), info)
    if password == "captcha-password":
        info = {
            "captcha_key": ["captcha-required"],
            "captcha_sitekey": "site-key-abc",
            "message": "Invalid Form Body",
        }
        raise server.DiscordError(400, server._login_error_message(400, info), info)
    if password == "slow-password":
        info = {"message": "You are being rate limited.", "retry_after": 8.0, "global": False}
        raise server.DiscordError(429, server._login_error_message(429, info), info)
    if password == "empty-password":
        return {}
    raise AssertionError(f"unexpected password: {password!r}")


def fake_discord_api(path, token, method="GET", body=None, timeout=20):
    if path != "/users/@me":
        raise AssertionError(f"unexpected Discord API call: {method} {path}")
    user = USERS.get(token)
    if not user:
        raise server.DiscordError(401, "401: Unauthorized")
    return copy.deepcopy(user)


def request(method, path, payload=None):
    raw = None
    headers = {}
    if payload is not None:
        raw = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=raw, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode()
            return resp.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode()
        try:
            return exc.code, json.loads(body)
        except Exception:
            return exc.code, {"raw": body}


def wait_server():
    for _ in range(80):
        try:
            status, data = request("GET", "/api/health")
            if status == 200 and data.get("ok"):
                return True
        except Exception:
            pass
        time.sleep(0.05)
    return False


def state_of(data):
    return data.get("state") or {}


def account_named(state, username):
    for row in state.get("accounts") or []:
        if row.get("username") == username:
            return row
    return None


def accounts():
    _status, data = request("GET", "/api/accounts")
    return data


def secret_dump():
    return server.SECRET_FILE.read_text(encoding="utf-8")


def leaks(blob, values):
    raw = json.dumps(blob, ensure_ascii=False)
    return [value for value in values if value in raw]


def data_files_containing(needles):
    hits = []
    for path in sorted(DATA.rglob("*")):
        if not path.is_file():
            continue
        try:
            blob = path.read_bytes()
        except OSError:
            continue
        for needle in needles:
            if needle.encode() in blob:
                hits.append((path.name, needle))
    return hits


PRIVATE = [
    "tok-delta-pw-111",
    "tok-delta-mfa-222",
    "tok-gamma-333",
    BAD_TOKEN,
]


def main():
    global BASE
    store = server.Store()
    server.STORE = store
    fake_gateway = FakeGateway()
    server.GATEWAY = fake_gateway
    server.MIRROR = server.MessageMirror()
    server.discord_api = fake_discord_api
    server._login_post = fake_login_post

    port = free_port()
    BASE = f"http://127.0.0.1:{port}"
    httpd = server.build_server("127.0.0.1", port)
    thread = threading.Thread(target=httpd.serve_forever, name="test-http", daemon=True)
    thread.start()
    try:
        if not wait_server():
            raise SystemExit("server did not start")

        status, initial = request("GET", "/api/state")
        state = state_of(initial)
        check(status == 200 and initial.get("ok"), "state is available", str(initial)[:200])
        check((state.get("auth") or {}) is None or "oauth" not in (state.get("auth") or {}), "no OAuth surface remains")
        check("oauth" not in json.dumps(initial).lower(), "state never mentions OAuth")
        check(state.get("accounts") == [], "a fresh install has no accounts")

        # --- input validation -------------------------------------------------
        status, blank_login = request("POST", "/api/auth/login", {"login": "", "password": "x"})
        check(status == 400 and "email or username" in blank_login.get("error", ""), "a blank login is rejected", str(blank_login)[:200])
        status, blank_password = request("POST", "/api/auth/login", {"login": "delta", "password": ""})
        check(status == 400 and "password" in blank_password.get("error", ""), "a blank password is rejected", str(blank_password)[:200])

        # --- wrong password ---------------------------------------------------
        status, wrong = request("POST", "/api/auth/login", {"login": "delta", "password": "wrong-password"})
        check(status == 401, "a wrong password is a 401", str(wrong)[:200])
        check(wrong.get("error") == "Wrong email/username or password.", "a wrong password gets the generic message", str(wrong)[:200])
        check(accounts().get("accounts") == [], "a wrong password creates no account")

        # --- captcha demand ---------------------------------------------------
        status, captcha = request("POST", "/api/auth/login", {"login": "delta", "password": "captcha-password"})
        check(status == 400, "a captcha demand is a 400", str(captcha)[:200])
        check("captcha" in captcha.get("error", "").lower(), "a captcha demand is explained", str(captcha)[:220])
        check(captcha.get("captcha") is True, "a captcha demand sets the captcha flag")
        check(accounts().get("accounts") == [], "a captcha demand creates no account")

        # --- rate limiting ----------------------------------------------------
        status, slow = request("POST", "/api/auth/login", {"login": "delta", "password": "slow-password"})
        check(status == 429, "a rate limit is a 429", str(slow)[:200])
        check("rate limiting" in slow.get("error", "") and "8 seconds" in slow.get("error", ""), "a rate limit states the wait", str(slow)[:220])

        # --- Discord answering with nothing ----------------------------------
        status, nothing = request("POST", "/api/auth/login", {"login": "delta", "password": "empty-password"})
        check(status == 502, "an empty login response is a bad gateway", str(nothing)[:200])
        check(accounts().get("accounts") == [], "an empty login response creates no account")

        # --- successful password sign-in -------------------------------------
        status, signed = request("POST", "/api/auth/login", {"login": "delta@example.com", "password": "right-password"})
        signed_state = state_of(signed)
        check(status == 200 and signed.get("ok") and signed.get("status") == "ok", "a good password signs in", str(signed)[:220])
        row = account_named(signed_state, "delta")
        check(row is not None, "the password identity is saved", str(signed)[:300])
        check(row.get("authKind") == "token" and row.get("tokenSet") is True, "the row is marked as a token account")
        check(row.get("canGateway") is True, "the row can open a gateway")
        check(signed_state.get("activeAccountId") == row.get("id"), "the new identity becomes active")
        check(signed_state.get("tokenSet") is True, "public state reports a token is set")
        check(signed_state.get("account", {}).get("username") == "delta", "the active identity is projected")
        check(fake_gateway.sockets == {}, "password sign-in never opens a gateway")

        stored = json.loads(secret_dump())
        stored_accounts = stored.get("accounts") or []
        check(len(stored_accounts) == 1 and stored_accounts[0].get("token") == "tok-delta-pw-111", "the token lands in secret.json", secret_dump()[:200])
        status, exported = request("GET", "/api/export")
        check(status == 200 and not leaks(exported, PRIVATE), "exports expose no tokens")
        check(not leaks(signed, PRIVATE), "the login response exposes no token")
        check(not leaks(accounts(), PRIVATE), "the account list exposes no token")
        check(not leaks(request("GET", "/api/state")[1], PRIVATE), "public state exposes no token")
        check(data_files_containing(["right-password", "wrong-password", "captcha-password", "slow-password"]) == [], "no password text is written to disk")

        delta_id = row.get("id")

        # --- MFA challenge ----------------------------------------------------
        status, challenge = request("POST", "/api/auth/login", {"login": "delta@example.com", "password": "mfa-password"})
        check(status == 200 and challenge.get("status") == "mfa", "an MFA account returns a challenge", str(challenge)[:220])
        check(challenge.get("ticket") == "ticket-abc" and challenge.get("methods") == ["totp"], "the challenge carries its ticket and methods")
        check(len(accounts().get("accounts") or []) == 1, "an MFA challenge creates no new account")
        check(not leaks(challenge, PRIVATE), "the MFA challenge exposes no token")

        status, bad_code = request("POST", "/api/auth/mfa", {"ticket": "ticket-abc", "code": "000000"})
        check(status == 401, "a bad MFA code is a 401", str(bad_code)[:200])
        check("two-factor" in bad_code.get("error", "").lower(), "a bad MFA code is explained", str(bad_code)[:220])

        status, good_code = request("POST", "/api/auth/mfa", {"ticket": "ticket-abc", "code": MFA_CODE})
        good_state = state_of(good_code)
        check(status == 200 and good_code.get("status") == "ok", "a good MFA code signs in", str(good_code)[:220])
        check(good_state.get("activeAccountId") == delta_id, "the MFA sign-in keeps the same account")
        check(len(good_state.get("accounts") or []) == 1, "the MFA sign-in adds no duplicate row")
        stored = json.loads(secret_dump())
        check((stored.get("accounts") or [{}])[0].get("token") == "tok-delta-mfa-222", "the MFA sign-in replaces the stored token")
        check(fake_gateway.sockets == {}, "the MFA sign-in never opens a gateway")

        # --- token fallback ---------------------------------------------------
        status, token_add = request("POST", "/api/auth/token", {"token": "tok-gamma-333"})
        token_state = state_of(token_add)
        check(status == 200 and token_add.get("ok"), "the token fallback signs in", str(token_add)[:220])
        gamma = account_named(token_state, "gamma")
        check(gamma is not None and gamma.get("authKind") == "token", "the token fallback saves a token account")
        check(token_state.get("activeAccountId") == gamma.get("id"), "the token fallback focuses the new account")
        check(len(token_state.get("accounts") or []) == 2, "the token fallback keeps the earlier account")
        check(fake_gateway.sockets == {}, "the token fallback never opens a gateway")

        status, rejected = request("POST", "/api/auth/token", {"token": BAD_TOKEN})
        check(status == 401, "a rejected token is a 401", str(rejected)[:200])
        check(not leaks(rejected, [BAD_TOKEN]), "a rejected token is never echoed back")
        check(len(accounts().get("accounts") or []) == 2, "a rejected token adds no account")

        # --- Rich Presence drives the socket ---------------------------------
        gamma_id = gamma.get("id")
        status, started = request("POST", "/api/rpc/start", {"kind": "custom", "custom": {"name": "Kizzey test presence"}})
        check(status == 200 and started.get("ok"), "the focused account can start Rich Presence", str(started)[:220])
        check(fake_gateway.sockets.get(gamma_id) == "tok-gamma-333", "the gateway socket uses the account's own token", str(fake_gateway.sockets)[:200])
        check(fake_gateway.tokens_for(gamma_id) == ["tok-gamma-333"], "only the focused account connects")

        status, switched = request("POST", "/api/accounts/switch", {"id": delta_id})
        check(status == 200 and state_of(switched).get("activeAccountId") == delta_id, "focus can move to another account")
        check(fake_gateway.active_ids() == [gamma_id], "moving focus leaves the running presence alone")
        check(delta_id not in fake_gateway.sockets, "an account with nothing running holds no socket")

        status, back = request("POST", "/api/accounts/switch", {"id": gamma_id})
        status, stopped = request("POST", "/api/rpc/stop", {})
        check(status == 200 and stopped.get("stopped") is True, "Rich Presence can be stopped", str(stopped)[:220])
        check(fake_gateway.sockets == {}, "stopping Rich Presence closes the socket")
        check(not leaks(stopped, PRIVATE), "the stop response exposes no token")

        # --- removal wipes tokens --------------------------------------------
        status, removed = request("POST", "/api/accounts/remove-all", {"confirm": "REMOVE ALL"})
        removed_state = state_of(removed)
        check(status == 200 and removed_state.get("accounts") == [], "remove-all clears every account")
        check(removed_state.get("account") is None and removed_state.get("activeAccountId") == "", "remove-all ends the session")
        check(fake_gateway.sockets == {}, "remove-all closes every socket")
        dump = secret_dump()
        check(all(value not in dump for value in PRIVATE), "removal wipes stored tokens", dump[:200])

        login_urls = {url for url, _body in LOGIN_CALLS}
        check(login_urls <= {server.DISCORD_LOGIN_API, server.DISCORD_MFA_API}, "every login call targets Discord", str(login_urls))

        print(f"\n{sum(checks)}/{len(checks)} password login checks passed")
        return 0 if all(checks) else 1
    finally:
        httpd.shutdown()
        httpd.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
