#!/usr/bin/env python3
"""Integration checks for saved Discord accounts and message mirroring.

The test boots the real HTTP server in-process, but replaces every outbound
Discord call with a deterministic fake. No token, channel or message touches
the network, and all state is written to a temporary directory.
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
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = Path(tempfile.mkdtemp(prefix="kizzey-accounts-test-"))
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


def fake_user(user_id, username, global_name):
    return {
        "id": user_id,
        "username": username,
        "global_name": global_name,
        "avatar": None,
        "discriminator": "0",
        "verified": True,
    }


USERS = {
    "tok-alpha-111": fake_user("100000000000000001", "alpha", "Alpha"),
    "tok-alpha-new444": fake_user("100000000000000001", "alpha", "Alpha"),
    "tok-beta-222": fake_user("100000000000000002", "beta", "Beta"),
    "tok-gamma-333": fake_user("100000000000000003", "gamma", "Gamma"),
    "tok-bad-secret-999": fake_user("100000000000000004", "bad", "Bad"),
}
BAD_TOKEN = "tok-bad-secret-999"


def fake_validate(token):
    if token == BAD_TOKEN:
        raise server.DiscordError(401, f"Discord rejected token {token}")
    user = USERS.get(token)
    if not user:
        raise server.DiscordError(401, "401: Unauthorized")
    return server.normalize_user(copy.deepcopy(user))


class FakeDiscord:
    def __init__(self):
        self.channels = {
            "111111111111111111": {
                "id": "111111111111111111",
                "name": "source-room",
                "type": 0,
                "guild_id": "900000000000000001",
            },
            "222222222222222222": {
                "id": "222222222222222222",
                "name": "dest-room",
                "type": 0,
                "guild_id": "900000000000000002",
            },
            "555555555555555555": {
                "id": "555555555555555555",
                "type": 1,
                "recipients": [{"id": "100000000000000001", "username": "alpha", "global_name": "Alpha"}],
            },
        }
        self.messages = [
            {
                "id": "8000",
                "type": 0,
                "content": "history before the relay",
                "author": {"id": "300000000000000000", "username": "old", "global_name": "Old"},
            }
        ]
        self.posts = []
        self.channel_tokens = []
        self.message_tokens = []
        self.fail_post = None
        self.webhooks = {}
        self.webhook_creates = []
        self.webhook_posts = []
        self.webhook_deletes = []
        self.webhook_counter = 0
        self.fail_webhook = None

    @staticmethod
    def author(user_id, username, display, bot=False, avatar=""):
        return {"id": user_id, "username": username, "global_name": display, "bot": bot, "avatar": avatar}

    def add_message(self, message):
        self.messages.append(message)

    def __call__(self, path, token, method="GET", body=None, timeout=20):
        parsed = urllib.parse.urlparse(path)
        route = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        if method == "GET" and route in (f"/channels/{cid}" for cid in self.channels):
            self.channel_tokens.append((route.split("/")[-1], token))
            return copy.deepcopy(self.channels[route.split("/")[-1]])
        if method == "GET" and route.startswith("/channels/") and route.endswith("/messages"):
            channel = route.split("/")[2]
            self.message_tokens.append((channel, token))
            if channel != "111111111111111111":
                raise server.DiscordError(404, "Unknown Channel")
            after = int((query.get("after") or ["0"])[0] or 0)
            limit = int((query.get("limit") or ["50"])[0] or 50)
            rows = [row for row in self.messages if int(row["id"]) > after]
            rows.sort(key=lambda row: int(row["id"]), reverse=True)
            return copy.deepcopy(rows[:limit])
        if method == "POST" and route == "/channels/222222222222222222/messages":
            if self.fail_post:
                raise self.fail_post
            if token != "tok-beta-222":
                raise server.DiscordError(403, "Wrong destination token")
            self.posts.append({"token": token, "body": copy.deepcopy(body)})
            return {"id": str(9000 + len(self.posts)), "content": (body or {}).get("content", "")}
        parts = route.strip("/").split("/")
        if method == "POST" and len(parts) == 3 and parts[0] == "channels" and parts[2] == "webhooks":
            if token != "tok-beta-222":
                raise server.DiscordError(403, "Wrong destination token")
            self.webhook_counter += 1
            webhook = {
                "id": str(700000000000000000 + self.webhook_counter),
                "token": f"wh_token_{self.webhook_counter}_abcdefghijklmnop",
                "channel_id": parts[1],
                "name": (body or {}).get("name") or "Relay",
            }
            self.webhooks[webhook["id"]] = webhook
            self.webhook_creates.append({"token": token, "body": copy.deepcopy(body), "webhook": copy.deepcopy(webhook)})
            return copy.deepcopy(webhook)
        if len(parts) == 3 and parts[0] == "webhooks":
            webhook = self.webhooks.get(parts[1])
            if not webhook or webhook.get("token") != parts[2]:
                raise server.DiscordError(404, "Unknown Webhook")
            if method == "POST":
                if self.fail_webhook:
                    raise self.fail_webhook
                if token:
                    raise server.DiscordError(401, "Webhook execution must not use an account token")
                self.webhook_posts.append(
                    {
                        "token": token,
                        "webhook": copy.deepcopy(webhook),
                        "body": copy.deepcopy(body),
                    }
                )
                return {"id": str(9500 + len(self.webhook_posts)), "content": (body or {}).get("content", "")}
            if method == "DELETE":
                self.webhook_deletes.append(webhook["id"])
                self.webhooks.pop(parts[1], None)
                return None
        raise server.DiscordError(404, f"Fake Discord has no route for {method} {path}")


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


def mirror_rule(state):
    rows = (state.get("mirror") or {}).get("rules") or []
    return rows[0] if rows else None


def mirror_rule_by_id(state, rule_id):
    rows = (state.get("mirror") or {}).get("rules") or []
    return next((row for row in rows if row.get("id") == rule_id), None)


def tokens_present(blob, tokens):
    raw = json.dumps(blob, ensure_ascii=False)
    return [token for token in tokens if token in raw]


def main():
    global BASE
    STORE = server.Store()
    server.STORE = STORE
    fake_gateway = FakeGateway()
    server.GATEWAY = fake_gateway
    server.MIRROR = server.MessageMirror()
    fake_discord = FakeDiscord()
    server.discord_api = fake_discord
    server.validate_token = fake_validate

    port = free_port()
    BASE = f"http://127.0.0.1:{port}"
    httpd = server.build_server("127.0.0.1", port)
    thread = threading.Thread(target=httpd.serve_forever, name="test-http", daemon=True)
    thread.start()
    try:
        if not wait_server():
            raise SystemExit("server did not start")
        tokens = list(USERS.keys())

        status, initial = request("GET", "/api/state")
        state = state_of(initial)
        check(status == 200 and initial.get("ok"), "initial account state available", str(initial)[:200])
        check(state.get("accounts") == [] and state.get("activeAccountId") == "", "state starts without accounts")
        check((state.get("mirror") or {}).get("enabled") is False, "message mirror starts disabled")

        status, alpha = request(
            "POST",
            "/api/accounts/add",
            {"token": "tok-alpha-111", "makeActive": True},
        )
        alpha_state = state_of(alpha)
        alpha_row = account_named(alpha_state, "alpha")
        check(status == 200 and alpha.get("created") is True and alpha_row, "first account is added", str(alpha)[:300])
        check(alpha_state.get("activeAccountId") == alpha_row.get("id"), "first account becomes active")
        check(alpha_state.get("account", {}).get("username") == "alpha", "active identity is projected")
        check(not tokens_present(alpha, ["tok-alpha-111"]), "add response never contains the token")

        status, beta = request(
            "POST",
            "/api/accounts/add",
            {"token": "tok-beta-222", "makeActive": False},
        )
        beta_state = state_of(beta)
        beta_row = account_named(beta_state, "beta")
        check(status == 200 and beta.get("created") is True and beta_row, "second account is added", str(beta)[:300])
        check(beta_state.get("activeAccountId") == alpha_row.get("id"), "adding without switch keeps the active account")
        check(fake_gateway.starts == ["tok-alpha-111"], "only the active account opens a gateway", fake_gateway.starts)

        status, duplicate = request(
            "POST",
            "/api/accounts/add",
            {"token": "tok-beta-222", "makeActive": False},
        )
        duplicate_state = state_of(duplicate)
        check(status == 200 and duplicate.get("created") is False, "re-adding a token updates the same account")
        check(len(duplicate_state.get("accounts") or []) == 2, "duplicate identity does not create another row")
        check(not tokens_present(duplicate, ["tok-alpha-111", "tok-beta-222"]), "duplicate response has no tokens")

        status, bad = request(
            "POST",
            "/api/accounts/add",
            {"token": BAD_TOKEN, "makeActive": False},
        )
        check(status == 401, "a rejected token returns 401", str(bad)[:200])
        check(BAD_TOKEN not in json.dumps(bad), "rejected token is scrubbed from the API response")
        state_after_bad = state_of(request("GET", "/api/state")[1])
        check(len(state_after_bad.get("accounts") or []) == 2, "a rejected token creates no account")

        status, switched = request("POST", "/api/accounts/switch", {"id": beta_row.get("id")})
        switched_state = state_of(switched)
        check(status == 200 and switched_state.get("activeAccountId") == beta_row.get("id"), "account switching activates the target")
        check(switched_state.get("account", {}).get("username") == "beta", "switching changes the projected identity")
        check(fake_gateway.starts[-1] == "tok-beta-222", "switching starts the target account gateway")
        check(not tokens_present(switched, ["tok-beta-222"]), "switch response has no token")

        status, listed = request("GET", "/api/accounts")
        check(status == 200 and len(listed.get("accounts") or []) == 2, "account list is available")
        check(not tokens_present(listed, ["tok-alpha-111", "tok-beta-222"]), "account list has no tokens")

        status, created = request(
            "POST",
            "/api/mirror/rules",
            {
                "name": "Alpha to beta",
                "sourceAccountId": alpha_row.get("id"),
                "sourceChannel": "111111111111111111",
                "destAccountId": beta_row.get("id"),
                "destChannel": "222222222222222222",
                "includeOwn": False,
                "includeBots": False,
                "includeAttachments": True,
                "includeEmbeds": True,
                "enabled": True,
            },
        )
        created_state = state_of(created)
        rule = mirror_rule(created_state)
        check(status == 200 and rule, "a mirror rule is created", str(created)[:400])
        check(created.get("warning") == "", "channel validation succeeds", created.get("warning"))
        check(rule.get("primed") is True and rule.get("lastSeenId") == "8000", "new rule primes at the newest message")
        check(rule.get("sourceLabel") == "#source-room" and rule.get("destLabel") == "#dest-room", "channel labels are resolved")
        check(not tokens_present(created, ["tok-alpha-111", "tok-beta-222"]), "mirror response has no tokens")
        check(
            ("111111111111111111", "tok-alpha-111") in fake_discord.channel_tokens
            and ("222222222222222222", "tok-beta-222") in fake_discord.channel_tokens,
            "each channel is checked with its own account token",
        )
        check(
            ("111111111111111111", "tok-alpha-111") in fake_discord.message_tokens,
            "the source cursor is primed with the source token",
        )

        loop_mark = server.MIRROR_MARK
        fake_discord.add_message(
            {
                "id": "8001",
                "type": 0,
                "content": "hello from source",
                "timestamp": "2026-10-27T12:00:00+00:00",
                "author": FakeDiscord.author("300000000000000001", "delta", "Delta"),
                "attachments": [{"url": "https://cdn.example/one.png"}],
                "embeds": [],
            }
        )
        fake_discord.add_message(
            {
                "id": "8002",
                "type": 0,
                "content": "my own message",
                "author": FakeDiscord.author("100000000000000001", "alpha", "Alpha"),
            }
        )
        fake_discord.add_message(
            {
                "id": "8003",
                "type": 0,
                "content": "bot message",
                "author": FakeDiscord.author("300000000000000002", "relaybot", "Relay Bot", bot=True),
            }
        )
        fake_discord.add_message(
            {
                "id": "8004",
                "type": 0,
                "content": loop_mark + "a forwarded message",
                "author": FakeDiscord.author("300000000000000003", "echo", "Echo"),
            }
        )
        fake_discord.add_message(
            {
                "id": "8005",
                "type": 0,
                "content": "second post",
                "author": FakeDiscord.author("300000000000000001", "delta", "Delta"),
                "embeds": [{"url": "https://example.com/read"}],
            }
        )
        fake_discord.add_message(
            {
                "id": "8006",
                "type": 1,
                "content": "system message",
                "author": FakeDiscord.author("300000000000000004", "system", "System"),
            }
        )

        status, run1 = request("POST", "/api/mirror/run", {"id": rule["id"]})
        run1_state = state_of(run1)
        run1_rule = mirror_rule(run1_state)
        check(status == 200 and run1.get("mirrored") == 2, "new messages are forwarded", str(run1)[:400])
        check(len(fake_discord.posts) == 2, "destination receives one post per eligible message", len(fake_discord.posts))
        first_post = fake_discord.posts[0]["body"]
        second_post = fake_discord.posts[1]["body"]
        check("**Delta**" in first_post.get("content", ""), "author attribution is included")
        check("<t:" in first_post.get("content", "") and ":f>" in first_post.get("content", ""), "the original sent time is included")
        check("hello from source" in first_post.get("content", ""), "message text is forwarded")
        check("https://cdn.example/one.png" in first_post.get("content", ""), "attachment URL is forwarded")
        check("https://example.com/read" in second_post.get("content", ""), "embed URL is forwarded")
        check(first_post.get("allowed_mentions") == {"parse": []}, "forwarded posts disable mentions")
        check(first_post.get("content", "").endswith(loop_mark), "forwarded posts carry the loop marker")
        check(all(post["token"] == "tok-beta-222" for post in fake_discord.posts), "destination posts use the destination token")
        check(run1_rule.get("lastSeenId") == "8006", "cursor advances to the newest message")
        check(run1_rule.get("mirrored") == 2 and run1_rule.get("skipped") == 4, "relay counters record forwarded and skipped messages", run1_rule)
        check(run1_rule.get("lastError") == "" and run1_rule.get("failures") == 0, "successful relay clears its error")

        status, run2 = request("POST", "/api/mirror/run", {"id": rule["id"]})
        check(status == 200 and run2.get("mirrored") == 0 and len(fake_discord.posts) == 2, "a second check is idempotent")

        fake_discord.add_message(
            {
                "id": "8007",
                "type": 0,
                "content": "third post",
                "author": FakeDiscord.author("300000000000000001", "delta", "Delta"),
            }
        )
        status, run3 = request("POST", "/api/mirror/run", {"id": rule["id"]})
        check(status == 200 and run3.get("mirrored") == 1 and len(fake_discord.posts) == 3, "later messages continue from the cursor")

        fake_discord.add_message(
            {
                "id": "8008",
                "type": 0,
                "content": "rate limited post",
                "author": FakeDiscord.author("300000000000000001", "delta", "Delta"),
            }
        )
        fake_discord.fail_post = server.DiscordError(
            429, "You are being rate limited for tok-beta-222.", {"retry_after": 0.25}
        )
        status, failed = request("POST", "/api/mirror/run", {"id": rule["id"]})
        failed_state = state_of(failed)
        failed_rule = mirror_rule(failed_state)
        check(status == 200 and failed.get("results", [{}])[0].get("error"), "rate limit is reported without crashing", str(failed)[:300])
        check("tok-beta-222" not in json.dumps(failed), "rate limit response scrubs a stored token")
        check("tok-beta-222" not in json.dumps(failed_state), "rate limit state scrubs a stored token")
        check(failed_rule.get("lastSeenId") == "8007", "a failed post does not advance the cursor")
        check(failed_rule.get("failures") == 1 and failed_rule.get("retryAfter", 0) > int(time.time() * 1000), "rate limit sets a retry cooldown", failed_rule)
        check(len(fake_discord.posts) == 3, "failed posts are not duplicated")

        fake_discord.fail_post = None
        status, recovered = request("POST", "/api/mirror/run", {"id": rule["id"]})
        recovered_state = state_of(recovered)
        recovered_rule = mirror_rule(recovered_state)
        check(status == 200 and recovered.get("mirrored") == 1 and len(fake_discord.posts) == 4, "manual run retries after a rate limit")
        check(recovered_rule.get("lastSeenId") == "8008", "retry advances the cursor after success")
        check(recovered_rule.get("lastError") == "" and recovered_rule.get("failures") == 0, "successful retry clears failure state")

        # Leave source account/channel unchanged so editing filters must not re-prime the cursor.
        status, edited = request(
            "POST",
            "/api/mirror/rules",
            {
                "id": rule["id"],
                "name": "Alpha to beta",
                "sourceAccountId": alpha_row.get("id"),
                "sourceChannel": "111111111111111111",
                "destAccountId": beta_row.get("id"),
                "destChannel": "222222222222222222",
                "includeOwn": True,
                "includeBots": True,
                "includeAttachments": True,
                "includeEmbeds": True,
                "enabled": True,
            },
        )
        edited_rule = mirror_rule(state_of(edited))
        check(status == 200 and edited_rule, "a mirror rule can be edited", str(edited)[:300])
        check(edited_rule.get("primed") is True and edited_rule.get("lastSeenId") == "8008", "editing filters keeps the cursor")

        fake_discord.add_message(
            {
                "id": "8009",
                "type": 0,
                "content": "own message now allowed",
                "author": FakeDiscord.author("100000000000000001", "alpha", "Alpha"),
            }
        )
        fake_discord.add_message(
            {
                "id": "8010",
                "type": 0,
                "content": "bot message now allowed",
                "author": FakeDiscord.author("300000000000000002", "relaybot", "Relay Bot", bot=True),
            }
        )
        status, run4 = request("POST", "/api/mirror/run", {"id": rule["id"]})
        check(status == 200 and run4.get("mirrored") == 2 and len(fake_discord.posts) == 6, "filter edits take effect")

        fake_discord.add_message(
            {
                "id": "8011",
                "type": 0,
                "content": loop_mark + "loop attempt",
                "author": FakeDiscord.author("300000000000000003", "echo", "Echo"),
            }
        )
        status, run5 = request("POST", "/api/mirror/run", {"id": rule["id"]})
        check(status == 200 and run5.get("mirrored") == 0 and len(fake_discord.posts) == 6, "loop marker prevents forwarding")
        run5_rule = mirror_rule(state_of(run5))
        check(run5_rule.get("lastSeenId") == "8011", "loop marker still advances the cursor")

        status, settings = request("POST", "/api/mirror/settings", {"enabled": True, "interval": 20})
        check(status == 200 and state_of(settings).get("mirror", {}).get("enabled") is True, "auto mirror can be enabled")
        check(state_of(settings).get("mirror", {}).get("interval") == 20, "mirror interval is saved")

        status, toggled = request(
            "POST", "/api/mirror/rules/toggle", {"id": rule["id"], "enabled": False}
        )
        toggled_rule = mirror_rule(state_of(toggled))
        check(status == 200 and toggled_rule.get("enabled") is False, "a mirror rule can be paused")
        paused_result = server.MIRROR.run_rule(rule["id"], manual=False)
        check(paused_result.get("disabled") is True, "the polling engine skips paused rules")

        status, toggled = request(
            "POST", "/api/mirror/rules/toggle", {"id": rule["id"], "enabled": True}
        )
        check(status == 200 and mirror_rule(state_of(toggled)).get("enabled") is True, "a mirror rule can be resumed")
        check(not tokens_present(toggled, ["tok-alpha-111", "tok-beta-222"]), "rule toggle response has no tokens")

        # Webhook mode recreates the source identity at the destination. The
        # managed webhook URL is a secret: only the server holds it.
        status, dm_rejected = request(
            "POST",
            "/api/mirror/rules",
            {
                "name": "Webhook into a DM",
                "sourceAccountId": alpha_row.get("id"),
                "sourceChannel": "111111111111111111",
                "destAccountId": beta_row.get("id"),
                "destChannel": "555555555555555555",
                "mode": "webhook",
                "enabled": False,
            },
        )
        check(status == 400 and "webhook mode needs a server" in dm_rejected.get("error", "").lower(), "webhook mode rejects private destinations", str(dm_rejected)[:300])
        check(fake_discord.webhook_creates == [], "a rejected webhook destination creates no webhook")

        status, hook_created = request(
            "POST",
            "/api/mirror/rules",
            {
                "name": "Identity relay",
                "sourceAccountId": alpha_row.get("id"),
                "sourceChannel": "111111111111111111",
                "destAccountId": beta_row.get("id"),
                "destChannel": "222222222222222222",
                "mode": "webhook",
                "enabled": False,
            },
        )
        hook_state = state_of(hook_created)
        hook_rule = mirror_rule_by_id(hook_state, (hook_created.get("rule") or {}).get("id"))
        hook_id = (hook_rule or {}).get("id")
        check(status == 200 and hook_rule and hook_rule.get("mode") == "webhook", "a webhook relay is created", str(hook_created)[:400])
        check(hook_rule and hook_rule.get("webhookSet") is True, "the public rule reports a ready webhook")
        check(len(fake_discord.webhook_creates) == 1 and fake_discord.webhook_creates[0]["token"] == "tok-beta-222", "the destination account creates the webhook")
        check(fake_discord.webhook_creates[0]["webhook"]["channel_id"] == "222222222222222222", "the webhook belongs to the destination channel")
        secret = json.loads((DATA / "secret.json").read_text())
        private_hook = (secret.get("mirrorWebhooks") or {}).get(hook_id) or {}
        check(bool(private_hook.get("token")), "the webhook token is stored privately")
        check(private_hook.get("token") not in json.dumps(hook_created), "the webhook token is not returned to the browser")

        fake_discord.add_message(
            {
                "id": "8012",
                "type": 0,
                "content": "webhook post",
                "author": FakeDiscord.author(
                    "300000000000000001", "delta", "Delta", avatar="abc123avatar"
                ),
            }
        )
        status, hook_run = request("POST", "/api/mirror/run", {"id": hook_id})
        check(status == 200 and hook_run.get("mirrored") == 1, "webhook mode forwards a message", str(hook_run)[:300])
        check(len(fake_discord.webhook_posts) == 1 and len(fake_discord.posts) == 6, "webhook mode does not post with the account")
        hook_post = fake_discord.webhook_posts[0]
        check(hook_post["token"] == "", "webhook execution sends no account token")
        check(hook_post["body"].get("username") == "Delta", "the webhook name is the sender display name")
        check("abc123avatar" in hook_post["body"].get("avatar_url", ""), "the webhook avatar is the sender avatar")
        check(hook_post["body"].get("content", "").startswith("webhook post") and hook_post["body"].get("content", "").endswith(loop_mark), "the webhook body is the message with the loop marker")
        check("**Delta**" not in hook_post["body"].get("content", ""), "webhook mode omits the normal author header")
        check(hook_post["body"].get("allowed_mentions") == {"parse": []}, "webhook posts disable mentions")
        hook_public = mirror_rule_by_id(state_of(request("GET", "/api/state")[1]), hook_id) or {}
        check(hook_public.get("webhookSet") is True, "public state confirms the webhook without a URL")
        check(private_hook.get("token") not in json.dumps(hook_public), "public state never contains the webhook token")

        fake_discord.add_message(
            {
                "id": "8013",
                "type": 0,
                "content": "webhook rate limited",
                "author": FakeDiscord.author("300000000000000001", "delta", "Delta"),
            }
        )
        secret_url = f"https://discord.com/api/webhooks/{private_hook.get('id')}/{private_hook.get('token')}"
        fake_discord.fail_webhook = server.DiscordError(
            429, f"You are being rate limited at {secret_url}", {"retry_after": 0.25}
        )
        status, hook_failed = request("POST", "/api/mirror/run", {"id": hook_id})
        failed_blob = json.dumps(hook_failed)
        check(status == 200 and (hook_failed.get("results") or [{}])[0].get("error"), "webhook rate limits are reported", failed_blob[:300])
        check(private_hook.get("token") not in failed_blob and secret_url not in failed_blob, "webhook errors scrub the private URL")
        failed_public = json.dumps(state_of(request("GET", "/api/state")[1]))
        check(private_hook.get("token") not in failed_public and secret_url not in failed_public, "webhook state scrubs the private URL")
        log_text = (DATA / "kizzey.log").read_text() if (DATA / "kizzey.log").exists() else ""
        check(private_hook.get("token") not in log_text and secret_url not in log_text, "webhook logs scrub the private URL")
        fake_discord.fail_webhook = None

        status, normal_edit = request("POST", "/api/mirror/rules", {"id": hook_id, "mode": "normal"})
        normal_rule = mirror_rule_by_id(state_of(normal_edit), hook_id)
        check(status == 200 and normal_rule and normal_rule.get("mode") == "normal", "a relay can switch back to normal mode", str(normal_edit)[:300])
        check(normal_rule and normal_rule.get("webhookSet") is False, "normal mode reports no managed webhook")
        check(fake_discord.webhook_deletes == [private_hook.get("id")], "switching to normal mode deletes the webhook")
        secret = json.loads((DATA / "secret.json").read_text())
        check(hook_id not in (secret.get("mirrorWebhooks") or {}), "switching to normal mode forgets the webhook token")

        status, hook_again = request("POST", "/api/mirror/rules", {"id": hook_id, "mode": "webhook"})
        again_rule = mirror_rule_by_id(state_of(hook_again), hook_id)
        again_hook = (json.loads((DATA / "secret.json").read_text()).get("mirrorWebhooks") or {}).get(hook_id) or {}
        check(status == 200 and again_rule and again_rule.get("webhookSet") is True, "switching back to webhook mode recreates the webhook")
        check(again_hook.get("id") and again_hook.get("id") != private_hook.get("id"), "recreated webhooks use a fresh identity")

        status, hook_deleted = request("POST", "/api/mirror/rules/delete", {"id": hook_id})
        check(status == 200 and mirror_rule_by_id(state_of(hook_deleted), hook_id) is None, "a webhook relay can be deleted")
        secret = json.loads((DATA / "secret.json").read_text())
        check(hook_id not in (secret.get("mirrorWebhooks") or {}), "deleting a relay removes its webhook token")
        check(again_hook.get("id") in fake_discord.webhook_deletes, "deleting a relay removes its Discord webhook")

        status, exported = request("GET", "/api/export")
        check(status == 200 and exported.get("format") == "kizzey-web-backup", "web backup remains available")
        blob = json.dumps(exported)
        check("tok-alpha-111" not in blob and "tok-beta-222" not in blob, "web backup excludes every token")
        check("account" not in (exported.get("state") or {}), "web backup excludes the active account projection")

        secret = json.loads((DATA / "secret.json").read_text())
        check(len(secret.get("accounts") or []) == 2, "both tokens are stored privately")
        check(secret.get("token") == "tok-beta-222", "the compatibility token follows the active account")
        state_file = (DATA / "state.json").read_text()
        check("tok-alpha-111" not in state_file and "tok-beta-222" not in state_file, "public state file contains no tokens")
        log_file = (DATA / "kizzey.log").read_text() if (DATA / "kizzey.log").exists() else ""
        check(BAD_TOKEN not in log_file, "rejected token is scrubbed from the server log")

        public_state = state_of(request("GET", "/api/state")[1])
        public_mirror = request("GET", "/api/mirror")[1]
        check(not tokens_present(public_state, ["tok-alpha-111", "tok-beta-222"]), "state endpoint has no tokens")
        check(not tokens_present(public_mirror, ["tok-alpha-111", "tok-beta-222"]), "mirror endpoint has no tokens")

        status, removed = request("POST", "/api/accounts/remove", {"id": beta_row.get("id")})
        removed_state = state_of(removed)
        removed_rule = mirror_rule(removed_state)
        check(status == 200 and removed.get("wasActive") is True, "removing the active account reports the transition")
        check(len(removed_state.get("accounts") or []) == 1, "removing an account leaves the other saved")
        check(removed_state.get("activeAccountId") == alpha_row.get("id"), "active removal falls back to the next saved token")
        check(removed_state.get("account", {}).get("username") == "alpha", "fallback identity is active")
        check(fake_gateway.starts[-1] == "tok-alpha-111", "fallback opens the next account gateway")
        check(removed_rule and removed_rule.get("enabled") is False, "rules using the removed account are paused")
        check(removed_rule and "removed" in removed_rule.get("lastError", "").lower(), "paused rule reports the removed account")

        status, refreshed = request(
            "POST",
            "/api/accounts/add",
            {"token": "tok-alpha-new444", "makeActive": False},
        )
        refreshed_state = state_of(refreshed)
        check(status == 200 and refreshed.get("created") is False, "a live account can replace its token", str(refreshed)[:300])
        check(len(refreshed_state.get("accounts") or []) == 1, "replacing a live token does not duplicate the account")
        check(refreshed_state.get("activeAccountId") == alpha_row.get("id"), "replacing a live token keeps the same active account")
        check(fake_gateway.starts[-1] == "tok-alpha-new444", "replacing a live token restarts its gateway")

        status, gamma = request(
            "POST", "/api/accounts/add", {"token": "tok-gamma-333", "makeActive": False}
        )
        gamma_state = state_of(gamma)
        check(status == 200 and account_named(gamma_state, "gamma"), "a third account can be saved")
        check(gamma_state.get("activeAccountId") == alpha_row.get("id"), "saving more accounts does not switch")

        status, declined = request("POST", "/api/accounts/remove-all", {"confirm": "nope"})
        check(status == 400, "remove-all requires explicit confirmation")
        check(len(state_of(request("GET", "/api/state")[1]).get("accounts") or []) == 2, "failed confirmation leaves accounts intact")

        status, removed_all = request("POST", "/api/accounts/remove-all", {"confirm": "REMOVE ALL"})
        removed_all_state = state_of(removed_all)
        check(status == 200 and removed_all.get("count") == 2, "remove-all deletes every saved token")
        check(removed_all_state.get("accounts") == [], "remove-all empties the account list")
        check(removed_all_state.get("activeAccountId") == "" and removed_all_state.get("account") is None, "remove-all ends the active session")
        check((removed_all_state.get("mirror") or {}).get("rules", [{}])[0].get("enabled") is False, "remove-all pauses account-backed relays")
        secret = json.loads((DATA / "secret.json").read_text())
        check(secret.get("accounts") == [] and secret.get("token") == "", "remove-all clears private tokens")

        imported_mirror = {
            "enabled": True,
            "interval": 9,
            "rules": [
                {
                    "id": "mirror_imported1",
                    "name": "Imported relay",
                    "enabled": True,
                    "sourceAccountId": "acct_missing1",
                    "sourceChannel": "111111111111111111",
                    "destAccountId": "acct_missing2",
                    "destChannel": "222222222222222222",
                    "mode": "webhook",
                    "primed": True,
                    "lastSeenId": "8011",
                }
            ],
        }
        status, imported = request(
            "POST",
            "/api/import",
            {
                "format": "kizzey-web-backup",
                "state": {"mirror": imported_mirror},
            },
        )
        imported_state = state_of(imported)
        imported_rule = mirror_rule(imported_state)
        check(status == 200, "web backup with mirror state imports", str(imported)[:300])
        check(imported_state.get("mirror", {}).get("enabled") is False, "imported auto mirror stays paused")
        check(imported_rule and imported_rule.get("enabled") is False, "imported relay stays paused")
        check(imported_rule and "imported paused" in imported_rule.get("lastError", "").lower(), "imported relay explains the pause")
        check(imported_rule and imported_rule.get("mode") == "webhook" and imported_rule.get("webhookSet") is False, "an imported webhook relay has no webhook until reviewed")
        check(any("mirror rule" in warning.lower() for warning in (imported.get("import") or {}).get("warnings", [])), "import reports the paused relay")
        check(imported_rule and imported_rule.get("lastSeenId") == "8011", "import preserves the cursor for review")

        status, deleted = request("POST", "/api/mirror/rules/delete", {"id": "mirror_imported1"})
        check(status == 200 and (state_of(deleted).get("mirror") or {}).get("rules") == [], "a mirror rule can be deleted")

        # A manually damaged store must not promote a tokenless row or reuse the
        # stale legacy compatibility token of a different identity.
        with server.STORE.lock:
            server.STORE.secret["accounts"] = [
                {
                    "id": "acct_tokenless1",
                    "token": "",
                    "needsAuth": True,
                    "user": {
                        "id": "100000000000000009",
                        "username": "tokenless",
                        "displayName": "Tokenless",
                        "email": "",
                    },
                }
            ]
            server.STORE.secret["activeId"] = "acct_tokenless1"
            server.STORE.secret["token"] = "tok-alpha-new444"
            server.STORE.save()
        public_tokenless = state_of(request("GET", "/api/state")[1])
        check(public_tokenless.get("activeAccountId") == "", "a tokenless row cannot remain active")
        check(public_tokenless.get("tokenSet") is False, "a stale compatibility token is not exposed as active")
        check(public_tokenless.get("gateway", {}).get("tokenSet") is False, "a tokenless active row reports no gateway credentials")

    finally:
        server.MIRROR.stop()
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=3)
        server.STORE = None

    passed = sum(1 for item in checks if item)
    total = len(checks)
    print(f"\n{passed}/{total} account and mirror checks passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
