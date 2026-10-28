# Kizzey Web-Alternate

A self-hosted browser recreation of the Kizzey Android app (`xyz.Kizzey` 8.4.4). It keeps the
Material 3 phone interface, the full presence editor set, and the community/tool screens while
using a Python standard-library server as the browser equivalent of the Android service.

The Discord token lives on the server. The browser never receives it, not even a hint.

Two sign-in paths are available: a normal **Sign in with Discord** OAuth2 flow for your identity,
and an advanced user token for Rich Presence and anything that reads or writes messages. Discord
does not grant OAuth applications gateway or channel access, so both paths exist on purpose and
neither pretends to be the other.

## Run it

Requirements:

- Python 3.10 or newer
- A modern browser
- Optional: `tesseract` on the server for Screen Read OCR

No pip or npm packages are needed.

```bash
cd /storage/emulated/0/Download/Illegal/kizzey_web
python3 server.py --host 0.0.0.0 --port 8420
```

Then open **http://127.0.0.1:8420** on the device running the server, or the printed LAN address
from another device.

`127.0.0.1`/`localhost` is a browser secure context, so installation, notifications, microphone,
location and browser screen capture are available there. On a plain-HTTP LAN address those
features may be blocked by the browser; put a TLS reverse proxy in front of Kizzey if you need
them from another device.

### Pull and run

`script_pull.py` clones or updates the checkout and then starts the server, so a fresh machine
needs one command:

```bash
python3 script_pull.py --host 0.0.0.0 --port 8420
```

It clones into `./kizzey-web` when the script is not already inside a checkout, runs
`git pull --ff-only` when it is, and forwards every other flag to `server.py`. Runtime data in
`data/` is git-ignored, so updates never delete accounts, settings or history.

| Launcher option | Purpose |
| --- | --- |
| `--dir PATH` | Checkout to clone or update. Defaults to this script's folder. |
| `--repo URL` / `--branch NAME` | Remote and branch to track. |
| `--no-pull` | Start the current checkout without touching git. |
| `--update-only` | Pull and exit. |

A private remote needs an authenticated git helper first (`gh auth login`, an SSH key, or a
credential helper). When the working tree has local edits, the fast-forward pull stops and says so
instead of discarding them.

### Options

| Option | Purpose |
| --- | --- |
| `--host 0.0.0.0` | Listen on every interface. Default. |
| `--port 8420` | HTTP port. Default `8420`. |
| `--no-gateway` | Restore the saved account without opening the Discord gateway at startup. |
| `KIZZEY_HOST` / `KIZZEY_PORT` | Environment equivalents for host and port. |
| `--discord-client-id` / `--discord-client-secret` | Discord application credentials for OAuth sign-in. |
| `KIZZEY_DISCORD_CLIENT_ID` / `KIZZEY_DISCORD_CLIENT_SECRET` | Environment equivalents; they override values saved in the UI. |
| `KIZZEY_PUBLIC_URL` | Public origin used to build the OAuth redirect URI, e.g. `https://kizzey.example.com`. |

## Signing in

### Sign in with Discord (OAuth2)

**Settings → Discord login** turns on a normal Discord sign-in screen. Create an application at
<https://discord.com/developers/applications>, add the redirect URI shown on that screen, and paste
the application's Client ID and Client Secret into Kizzey. The welcome screen and the sign-in sheet
then offer **Continue with Discord**.

The flow is a standard authorization-code exchange with PKCE and a single-use `state` value,
completed entirely on the server:

1. The browser is sent to `discord.com/oauth2/authorize` with the `identify` scope.
2. Discord redirects to `/api/auth/oauth/callback`.
3. The server exchanges the code, reads `/users/@me`, stores the identity, and returns to the app.

Access and refresh tokens are written to `data/secret.json`, refreshed automatically when they
expire, and never appear in public state, API responses, logs or exports. The client secret stays
server-side too. Credentials saved in the UI are used only when the environment variables are not
set.

Discord does not let OAuth applications open a gateway session, read channel history or send Rich
Presence. An OAuth account therefore shows as an **OAuth identity** with no gateway, and presence,
chat tools and message mirroring explain that they need a user token for that account. Adding a
token later keeps the OAuth identity linked to the same row.

For a hosted instance, set `KIZZEY_PUBLIC_URL` (or use the exact host and port people open) so the
redirect URI registered at Discord matches the one Kizzey sends.

### Connect with a user token

Rich Presence is sent through the user gateway, not a bot account, so the presence and message
features need a Discord user token. The sign-in sheet keeps that path behind **Use a user token
instead**: open Discord in a desktop browser, copy the `token` value from Local Storage, and paste
it once. This is the web equivalent of the Android app's WebView session.

The token is validated against Discord, stored in `data/secret.json`, and used server-side. Public
state, logs, API responses and state exports never include it. Use a token only on a server you
control, keep the server off untrusted networks, and remember that Discord user tokens carry
account risk.

### Multiple Discord accounts

Open **Settings → Discord accounts**, or choose the same item in the drawer, to save and switch
identities. Up to eight accounts are kept in a private `accounts` array in `data/secret.json`;
the legacy `token` field remains as a compatibility copy of the active token. The browser only
receives account IDs, usernames, display names, avatars, timestamps, the credential kind
(`token`/`oauth`), and boolean token and gateway status — never a token, OAuth token, token
fragment or hint.

An account can hold an OAuth identity, a user token, or both. OAuth-only rows can be selected and
labelled, but they do not open a gateway or back a mirror rule until a token is added.

One gateway and one live presence run at a time. Switching validates the target token, stops the
old presence and socket, then opens the target session. Replacing the token of the live account
restarts its gateway too. Removing the active account falls back to the next saved account that
has a token; if none remains, the server has no active session. **Remove all accounts** clears
every token and pauses account-backed relays. Tokens remain server-only, so each saved identity
can be switched from any browser that can reach this server.

This is sequential account switching, not simultaneous Rich Presence for several accounts. The
Android app's **Multiple Account RPC** concerns several RPC sources; Kizzey Web instead offers
saved-account switching plus the message forwarder below.

## Message mirror

**Settings → Message mirror** forwards new messages from a source channel to a destination
channel. Each rule selects a source account, source channel ID, destination account, destination
channel ID, a post format and optional own-message, bot, attachment and embed filters. Copy
numeric channel IDs from Discord with Developer Mode enabled.

Two post formats are available per rule:

- **Normal message** posts with the destination account. The post shows the sender's display
  name and username, the original sent time as a Discord timestamp, then the message text and
  links. It works with server channels, threads, DMs and group DMs.
- **Webhook identity** posts each message through a webhook managed by Kizzey. The webhook uses
  the sender's display name and avatar, and the webhook content is the message text and links.
  Discord displays the relay's post time. The destination must be a server text or announcement
  channel, and the destination account needs **Manage Webhooks**. The webhook is created when the
  rule is saved, reused on later checks, deleted when the rule switches to normal mode or is
  removed, and purged when every account is removed. DMs, group DMs and threads cannot use
  webhook mode.

The server is a poller, not a gateway listener. A new rule records the newest source message as
its starting cursor, so existing history is never backfilled. Only messages after that cursor
are copied. The cursor and delivery counters persist across restarts. At most 30 messages are
processed per rule per check, posts are paced at roughly one per second, and Discord 429
responses set a retry cooldown. Background checks need both the global auto-mirror switch and the
individual rule enabled. **Run now** bypasses both pause switches and the retry cooldown so an
operator can test a rule deliberately.

Forwarded posts include message text, attachment URLs, embed URLs and sticker names, use
`allowed_mentions: {parse: []}` so text cannot ping anyone, and end with an invisible `U+2063`
marker. System messages, bots and the source account's own messages are skipped by default; the
marker prevents a relay from forwarding its own output again. Edits, deletes, reactions, replies,
threads and voice state are not synchronised.

The limits are 20 rules, a 5–300 second interval (default 12), and eight saved accounts. Rules
store account IDs, channel IDs, labels, the post format, counters and the last message ID — never
tokens or webhook URLs. Managed webhook URLs are stored only in `data/secret.json`; public state
exposes a `webhookSet` flag. A web backup can carry mirror configuration, but every imported rule
is restored paused until it is reviewed. Imported webhook rules have no webhook until they are
saved or enabled. Forwarding with user tokens is self-bot behaviour and may conflict with
Discord's terms; use relays only in channels you control.

## Importing from Kizzey for Android

**Backup & restore** reads the JSON files the Android app writes:

- Full settings backups (`Kizzey-settings-*.json`, format `kizzey-backup`, version 2).
- Preset packs (`Kizzey-presets-*.json`, format `kizzey-preset`, version 1).
- Stand-alone Custom RPC configs saved by **Save config** (`RpcConfig` JSON).

The importer also accepts a raw JSON array of configs or presets, or a wrapped payload from a
script. Kizzey's own exports use the object formats above.

Mapped look, Home, Custom RPC and media preferences are merged into this server. Android
`Save config` files, full Custom RPC template presets and text presets become saved cards in the
Gallery. A full settings backup can also carry preset artwork; those bytes are copied into
`data/uploads` and used when a card is applied. A stand-alone config cannot carry Android-local
images, so those paths are reported as skipped.

Discord account, token, profile and Nitro fields are never imported, even when the Android backup
was exported with account data included. Android-only controls with no browser equivalent are
ignored, as are raw MMKV files and app-private files that are not present in the backup JSON.
Titled imported presets merge by title; the imported copy replaces a local card with the same
title. Untitled presets are appended, as they are in Kizzey. Imported timers keep Kizzey's meaning:
a from-now timer restarts on apply, a duration keeps its length, and a fixed absolute date is
applied verbatim. A single native file imports at most 300 cards and 64 artwork files; the local
saved-card library is capped at 500. The result sheet and Logs report anything skipped, including
Android-local image paths, malformed entries, merged duplicate titles and discarded older cards.

## Checks

The runtime has no dependencies, but the repository includes regression checks for the native
import path. Node is optional and only used to exercise the browser-side actions with stubs.

```bash
python3 -m py_compile server.py
for file in static/*.js; do node --check "$file"; done
python3 tests/test_kizzey_import.py
python3 tests/test_accounts_mirror.py
python3 tests/test_oauth_login.py
python3 tests/test_launcher.py
node tests/test_import_ui.js
node tests/test_gallery_apply.js
node tests/test_accounts_ui.js
```

The Python integration tests boot temporary server state and replace Discord with deterministic
fakes, so they do not touch `data/` or use a real token. The browser tests run the screen code
against a stubbed Material runtime.

## What is included

**Presence modes**

- Custom RPC with images, buttons, party, timestamps, activity type and platform
- App Detection with a browser app catalogue and manual selection
- Media RPC with local artwork upload, progress and pause behaviour
- Console RPC, Experimental switching, Multiple activities and RPC Cycling
- Health, Location, Weather, Navigation, Android Auto, Samsung and Emulation presences
- Screen Read with browser capture/upload plus real Tesseract OCR
- Start, stop, refresh, preview, status display type and status-line rolling
- Persistent history, server logs and usage counters
- Saved presets, a gallery with local submissions, and automation schedules
- Up to eight saved Discord accounts with server-side token isolation and active fallback
- Normal **Sign in with Discord** OAuth2 flow with PKCE, state, server-side refresh and no token capture
- A real, rate-limited message mirror with normal and managed-webhook identity formats
- Optional album-art backdrop and artwork-sampled accent colour in Display settings
- Custom CSS variables, text scaling, themes, AMOLED mode and Material You-style accents

**Community and utilities**

- Kizzey Chat with rooms, replies, reactions, attachments, local notifications and SSE updates
- Voice-room roster, mute/deafen/speaking state, heartbeat and local microphone level test
- Moments, leaderboard, Discord friends list, presence browser, profile and usage/history screens
- KCoin wallet, shop, cosmetic equip actions and a no-payment Kizzey+ demo
- Weather/geocoding via Open-Meteo, driving routes via OSRM
- Local host diagnostics, plugins, bulk operations, update checks and Web/Kizzey Android backup import
- Installable PWA shell with offline fallback for the interface

## Browser substitutions

The web build is a functional recreation, not an Android privileged clone. These substitutions
are deliberate and shown honestly in the interface:

| Android capability | Web implementation |
| --- | --- |
| Foreground-app detection | Manual app catalogue/selection |
| Notification-listener media detection | Manual media fields and local artwork upload |
| Health Connect | Manual readings, JSON import and approximate device-motion steps |
| Shizuku shell | Host statistics from the Python server |
| System screen capture + OCR | Browser tab/window capture or image upload, OCR'd server-side |
| Native chat/voice backend | Local persisted rooms and voice state; microphone test has no live audio relay |
| Android overlays, tiles, Android Auto | UI controls and honest preview/state analogues |
| APK/system installer | PWA "Add to Home screen" |
| Simultaneous multi-account RPC | One live gateway, saved-account switching and a message mirror |
| Stripe checkout | Local Kizzey+ and KCoin demo mechanisms |

Discord's relationship endpoint returns friends but not their live activities. Live friend
activities require presence data Kizzey does not request. Music detection, media-session capture,
and foreground-app detection cannot be reproduced from a regular web page.

## How it works

- `server.py` owns persistence, Discord REST/gateway, SSE, OCR, uploads and all browser APIs.
- `static/core.js` is the shared runtime: state, API/patch queue, icon set, fields, sheets, themes.
- `static/app.js` is the router/shell, onboarding, Home and drawer.
- `static/screens-*.js` register screens into `K.screens` and actions into `K.actions`.
- `static/styles.css` contains the Material 3 visual system and responsive phone shell.
- `static/sw.js` provides the installable shell cache; the server is still required for live data.

State is JSON under `data/`:

```text
data/state.json     settings, presets, mirror rules, chat, history, wallet, UI state
data/secret.json    private Discord tokens, active-account ID and managed webhook URLs
data/history.json   presence-history mirror
data/kizzey.log     server event log
data/uploads/       local chat images, avatars and screen captures
```

Screen captures, avatars and chat attachments stay on this server. Only artwork explicitly used
on a Discord card is sent to the public Kizzy image resolver so Discord can display it; external
artwork URLs are resolved the same way.

### Reset

Stop the server, remove `data/state.json`, `data/history.json`, `data/secret.json`,
`data/kizzey.log` and the files in `data/uploads/`, then start it again. A fresh neutral state is
created automatically. Removing `secret.json` signs the server out of Discord.

## API sketch

The frontend uses JSON endpoints and an SSE stream. The main groups are:

- `GET /api/state`, `/api/events`, `/api/accounts`, `/api/mirror`; `POST /api/patch`
- `POST /api/auth/token`, `/api/auth/logout`, `/api/account/refresh`, `/api/gateway/reconnect`
- `GET /api/auth/oauth/config`, `/api/auth/oauth/start`, `/api/auth/oauth/callback`; `POST /api/auth/oauth/config`
- `POST /api/accounts/{add,switch,remove,remove-all}`
- `POST /api/mirror/settings`, `/api/mirror/rules`, `/api/mirror/rules/{toggle,delete}`, `/api/mirror/run`
- `POST /api/rpc/{start,stop,refresh,preview}`
- `GET /api/weather`, `/api/geocode`, `/api/route`, `/api/friends`, `/api/hoststats`, `/api/update`
- `POST /api/upload`, `/api/image`, `/api/ocr`, `/api/chat/*`, `/api/voice/*`, `/api/moments/*`
- `POST /api/wallet/daily`, `/api/shop/buy`, `/api/premium/{unlock,reset}`
- `GET /api/export`, `/api/logs`, `/api/history`; `POST /api/import`, `/api/logs/clear`, `/api/history/clear`

Unknown `/api/*` paths return JSON 404s. SSE recovers in the browser; the gateway reconnects only
while Keep gateway alive is enabled. Auto-start separately controls restoration when the server
launches.

## Credits and licence

Kizzey Web is an unofficial companion recreation of the Kizzey fork of
[Kizzy](https://github.com/dead8309/Kizzy). Kizzy was created by **dead8309**; the Kizzey fork is
maintained by **UnpackedX** at <https://codeberg.org/UnpackedX/Kizzey>. The interface follows the
publicly available Kizzey source and the installed 8.4.4 APK resources.

The app icon comes from the Kizzey APK. Weather/geocoding data is provided by Open-Meteo, routing
by OSRM, icons follow the Lucide language, and Discord Rich Presence is a Discord platform feature.
Discord and its logo belong to Discord Inc. This project is not affiliated with Discord, Kizzy or
Kizzey.

The original source in this repository is released under the **MIT License**. See [LICENSE](LICENSE).
Kizzey, Kizzy, their names, icons and upstream code remain under their original
**GPL-3.0** terms and belong to their respective authors. The MIT grant applies to this web
companion's original implementation, not to upstream components or assets.
