#!/usr/bin/env python3
"""Checks for Discord OAuth2 sign-in and its account boundaries.

The suite boots the real HTTP server in-process and replaces the Discord token
and identity endpoints with deterministic fakes, so no request leaves the
machine. Everything is written to a temporary data directory.
"""
import atexit
import json
import shutil
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = Path(tempfile.mkdtemp(prefix="kizzey-oauth-test-"))
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
    def __init__(self):
        self.starts = []
        self.stops = 0
        self.presences = []

    def start(self, token):
        self.starts.append(token)

    def stop(self):
        self.stops += 1

    def send_presence(self, presence):
        self.presences.append(presence)


IDENTITY = {
    "id": "100000000000000009",
    "username": "delta",
    "global_name": "Delta",
    "avatar": None,
    "discriminator": "0",
    "verified": True,
}

ACCESS_TOKENS = {"oauth-access-aaa", "oauth-access-ccc"}
SECRETS = {
    "client": "s3cret-value-abcdef",
    "access": "oauth-access-aaa",
    "refresh": "oauth-refresh-bbb",
}


def fake_exchange(code, verifier, redirect_uri):
    if code != "code-good":
        raise server.DiscordError(400, "invalid_grant")
    if not verifier or not redirect_uri.endswith("/api/auth/oauth/callback"):
        raise server.DiscordError(400, "invalid_request")
    return {
        "access_token": "oauth-access-aaa",
        "refresh_token": "oauth-refresh-bbb",
        "expires_in": 3600,
        "scope": "identify",
        "token_type": "Bearer",
    }


def fake_refresh(token):
    if token != "oauth-refresh-bbb":
        raise server.DiscordError(400, "invalid_grant")
    return {
        "access_token": "oauth-access-ccc",
        "refresh_token": "oauth-refresh-ddd",
        "expires_in": 3600,
        "scope": "identify",
        "token_type": "Bearer",
    }


def fake_identity(access):
    if access not in ACCESS_TOKENS:
        raise server.DiscordError(401, "401: Unauthorized")
    return server.normalize_user(dict(IDENTITY))


def no_discord_api(path, token, method="GET", body=None, timeout=20):
    raise AssertionError(f"unexpected Discord call: {method} {path}")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


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


def redirect_target(path):
    req = urllib.request.Request(BASE + path, method="GET")
    try:
        OPENER.open(req, timeout=20)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers.get("Location") or ""
    return 0, ""


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


def leaks(blob, values):
    raw = json.dumps(blob, ensure_ascii=False)
    return [value for value in values if value in raw]


def begin_sign_in():
    status, data = request("GET", "/api/auth/oauth/start")
    if status != 200 or not data.get("url"):
        return status, data, "", ""
    parsed = urllib.parse.urlparse(data["url"])
    query = {k: v[-1] for k, v in urllib.parse.parse_qs(parsed.query).items()}
    return status, data, parsed, query


def main():
    global BASE
    store = server.Store()
    server.STORE = store
    fake_gateway = FakeGateway()
    server.GATEWAY = fake_gateway
    server.MIRROR = server.MessageMirror()
    server.discord_api = no_discord_api
    server.oauth_exchange_code = fake_exchange
    server.oauth_refresh_session = fake_refresh
    server.oauth_fetch_identity = fake_identity

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
        oauth = (state.get("auth") or {}).get("oauth") or {}
        check(status == 200 and initial.get("ok"), "state is available", str(initial)[:200])
        check(oauth.get("configured") is False, "OAuth starts unconfigured")
        check(str(oauth.get("redirectUri") or "").endswith("/api/auth/oauth/callback"), "state advertises the callback path")
        check("clientSecret" not in json.dumps(initial), "state never carries a client secret")

        status, bad = request("POST", "/api/auth/oauth/config", {"clientId": "abc", "clientSecret": "x"})
        check(status == 400 and "Client ID" in bad.get("error", ""), "a malformed Client ID is rejected", str(bad)[:200])

        status, saved = request(
            "POST",
            "/api/auth/oauth/config",
            {"clientId": "123456789012345678", "clientSecret": SECRETS["client"]},
        )
        saved_oauth = saved.get("oauth") or {}
        check(status == 200 and saved_oauth.get("configured") is True, "credentials are saved", str(saved)[:300])
        check(saved_oauth.get("hasSecret") is True, "saved config reports a stored secret")
        check(not leaks(saved, [SECRETS["client"]]), "saving never echoes the client secret")
        secret_file = json.loads(server.SECRET_FILE.read_text())
        check(secret_file.get("oauth", {}).get("clientSecret") == SECRETS["client"], "client secret lands in secret.json only")

        status, missing = request("POST", "/api/auth/oauth/config", {"clientId": "123456789012345678", "clientSecret": ""})
        check(status == 200 and (missing.get("oauth") or {}).get("configured") is True, "a blank secret keeps the saved one")

        status, started, parsed, query = begin_sign_in()
        check(status == 200 and started.get("ok"), "sign-in start returns a URL", str(started)[:200])
        check(parsed.netloc in ("discord.com", "www.discord.com") and parsed.path == "/oauth2/authorize", "sign-in targets Discord authorize")
        check(query.get("client_id") == "123456789012345678", "authorize URL carries the client id")
        check(query.get("response_type") == "code" and query.get("scope") == "identify", "authorize URL asks for an identify code")
        check(query.get("code_challenge_method") == "S256" and len(query.get("code_challenge") or "") >= 40, "authorize URL uses PKCE S256")
        check(query.get("state") and len(query.get("state")) >= 20, "authorize URL has a state token")
        check((query.get("redirect_uri") or "").endswith("/api/auth/oauth/callback"), "authorize URL pins the callback")
        check(query.get("prompt") == "consent", "authorize URL asks for explicit consent")
        first_state = query.get("state") or ""

        code, location = redirect_target("/api/auth/oauth/callback?state=bogus&code=code-good")
        check(code == 302 and "oauth=error" in location, "a forged state is rejected", f"{code} {location}")
        check(not store.secret.get("accounts"), "a forged state creates no account")

        code, location = redirect_target(f"/api/auth/oauth/callback?state={urllib.parse.quote(first_state)}&code=code-good")
        check(code == 302 and location.endswith("?oauth=success#/accounts"), "a good callback returns to the app", f"{code} {location}")

        status, accounts = request("GET", "/api/accounts")
        row = account_named({"accounts": accounts.get("accounts") or []}, "delta")
        check(row is not None, "the OAuth identity is saved", str(accounts)[:300])
        check(row.get("authKind") == "oauth" and row.get("oauthLinked") is True, "the row is marked as OAuth")
        check(row.get("tokenSet") is False and row.get("canGateway") is False, "an OAuth row has no gateway credentials")
        check(accounts.get("activeAccountId") == row.get("id"), "the new identity becomes active")

        status, after = request("GET", "/api/state")
        after_state = state_of(after)
        check(after_state.get("account", {}).get("username") == "delta", "the active identity is projected")
        check(after_state.get("tokenSet") is False, "public state reports no user token")
        check(fake_gateway.starts == [], "OAuth sign-in never opens a gateway")
        oauth_secret = json.loads(server.SECRET_FILE.read_text()).get("accounts", [{}])[0].get("oauth") or {}
        check(oauth_secret.get("accessToken") == "oauth-access-aaa", "the access token is stored server-side")
        check(oauth_secret.get("refreshToken") == "oauth-refresh-bbb", "the refresh token is stored server-side")
        private = [SECRETS["client"], SECRETS["access"], SECRETS["refresh"], "oauth-refresh-ddd"]
        check(not leaks(after, private), "public state exposes no OAuth secrets")
        check(not leaks(accounts, private), "account list exposes no OAuth secrets")
        status, exported = request("GET", "/api/export")
        check(status == 200 and not leaks(exported, private), "exports expose no OAuth secrets")

        status, presence = request("POST", "/api/rpc/start", {"kind": "custom"})
        check(status == 401 and "user token" in presence.get("error", ""), "presence explains the OAuth limitation", str(presence)[:220])
        check(presence.get("loginRequired") is True, "presence failure stays a login error")

        status, mirror = request(
            "POST",
            "/api/mirror/rules",
            {
                "sourceAccountId": row.get("id"),
                "sourceChannel": "111111111111111111",
                "destAccountId": row.get("id"),
                "destChannel": "222222222222222222",
            },
        )
        check(status == 400 and "OAuth" in mirror.get("error", ""), "mirroring rejects an OAuth-only account", str(mirror)[:220])

        status, again, parsed, query = begin_sign_in()
        code, location = redirect_target(
            f"/api/auth/oauth/callback?state={urllib.parse.quote(query.get('state') or '')}&code=code-good"
        )
        status, accounts = request("GET", "/api/accounts")
        check(code == 302 and len(accounts.get("accounts") or []) == 1, "signing in again updates the same row", str(accounts)[:200])

        status, refreshed = request("POST", "/api/account/refresh", {})
        check(status == 200 and (refreshed.get("user") or {}).get("username") == "delta", "account refresh works for OAuth", str(refreshed)[:200])
        oauth_secret = json.loads(server.SECRET_FILE.read_text()).get("accounts", [{}])[0].get("oauth") or {}
        check(oauth_secret.get("accessToken") == "oauth-access-ccc", "refresh rotates the access token")
        check(oauth_secret.get("refreshToken") == "oauth-refresh-ddd", "refresh rotates the refresh token")
        check(not leaks(state_of(refreshed), ["oauth-access-ccc", "oauth-refresh-ddd"]), "refresh response exposes no tokens")

        status, cleared = request("POST", "/api/auth/oauth/config", {"clientId": "", "clientSecret": ""})
        check(status == 200 and (cleared.get("oauth") or {}).get("configured") is False, "sign-in can be turned off")
        status, blocked = request("GET", "/api/auth/oauth/start")
        check(status == 400 and "Settings" in blocked.get("error", ""), "start explains how to configure sign-in", str(blocked)[:200])

        status, removed = request("POST", "/api/accounts/remove-all", {"confirm": "REMOVE ALL"})
        removed_state = state_of(removed)
        check(status == 200 and removed_state.get("accounts") == [], "remove-all clears OAuth identities too")
        check(removed_state.get("account") is None and removed_state.get("activeAccountId") == "", "remove-all ends the identity session")
        private_dump = json.dumps(json.loads(server.SECRET_FILE.read_text()))
        check("oauth-access-ccc" not in private_dump and "oauth-refresh-ddd" not in private_dump, "removal wipes stored OAuth tokens")

        print(f"\n{sum(checks)}/{len(checks)} OAuth login checks passed")
        return 0 if all(checks) else 1
    finally:
        httpd.shutdown()
        httpd.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
