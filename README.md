# Kizzey Web-Alternate

A self-hosted browser recreation of the Kizzey Android app (`xyz.Kizzey` 8.4.4). It keeps the
Material 3 phone interface, the full presence editor set, and the community/tool screens while
using a Python standard-library server as the browser equivalent of the Android service.

The Discord token lives on the server. The browser never receives it, not even a hint.

> **It runs on your machine, and only on your machine.** There is no hosted Kizzey service and no
> telemetry of any kind. The server, the Discord traffic and the session token all stay on the
> computer you start `server.py` on. As long as the code came from this repository, it does nothing
> outside that machine: the only outbound requests are the Discord calls you ask for, and the token
> is written only to your own `data/secret.json`. Nothing phones home, and nothing here can reach
> into another install or take over an account. Reading every line you would run takes a few minutes
> — there is no third-party dependency, no obfuscation, no bundled binary, and nothing that can take
> a token off this disk and send it elsewhere.

Sign in the way you would on `discord.com`: click **Sign in with Discord** and a real Discord web
sign-in opens in a browser window on this computer. Sign in there exactly as you normally would —
password, two-factor, captcha, passkey, whatever Discord asks for — and Kizzey reads the session
Discord just created, saves the token in `data/secret.json`, and closes the window. Nothing is typed
into Kizzey and nothing is sent anywhere except to Discord itself. Email/password and token entry
remain available as fallbacks.

Accounts are not switched one at a time. Every saved account that has something switched on — a live
Rich Presence or a role in a message mirror rule — keeps its own gateway open alongside the others,
so several accounts can hold Rich Presence at once. An account with nothing switched on holds no
socket.

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

It clones into `./kizzey-web` when the script is not already inside a checkout, and forwards every
other flag to `server.py`. When the script is already inside a checkout it compares the local commit
with the tracked branch tip first: if they match it says so and starts straight away without a
fetch, otherwise it fetches and runs `git pull --ff-only`. Runtime data in `data/` is git-ignored,
so updates never delete accounts, settings or history.

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
| `--no-gateway` | Restore the saved accounts without opening any gateway socket at startup. |
| `--browser-cdp URL` | Drive a Chrome/Chromium DevTools endpoint on another machine instead of a local browser. |
| `KIZZEY_HOST` / `KIZZEY_PORT` | Environment equivalents for host and port. |
| `KIZZEY_BROWSER_CDP` | Environment equivalent for `--browser-cdp`, for example `http://127.0.0.1:9222` or `ws://browser:3000?token=…`. |
| `KIZZEY_BROWSER` | Path to a browser binary, or a DevTools URL (then it behaves like `KIZZEY_BROWSER_CDP`). |

## Signing in

### Sign in with Discord

This is the normal Discord web sign-in, not a lookalike form. The button starts a browser on this
machine — Chrome, Edge, Brave or Chromium, whichever is already installed — on
`https://discord.com/login`, using a throwaway profile in `data/tmp/`. That window is Discord's own
page: password, two-factor, captcha, "verify it's you" and passkeys all work, because Discord is
handling them.

When the sign-in lands and Discord stores its session token in that profile, Kizzey reads the token
over the browser's local debugging channel, verifies it against Discord, saves it to
`data/secret.json`, closes the window and deletes the temporary profile. The window is separate from
your everyday browser: it carries no cookies from it, writes nothing to it, and signing out there
does not affect it.

The token never leaves this machine and is never sent to the page. If the window cannot open (no
Chromium-family browser installed), or you would rather not use it, the fallbacks below still work.

### Headless server or container

Kizzey's own container needs no browser. Browser sign-in only needs a Chromium-family browser
*somewhere reachable over the network*, driven through its DevTools endpoint. Point
`KIZZEY_BROWSER_CDP` at it (or pass `--browser-cdp`):

```bash
# A Chrome on your desktop, started with a debugging port. You sign in on that
# screen, so no virtual display or VNC is needed.
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/kizzey-signin

python3 server.py --browser-cdp http://192.168.1.20:9222
```

The included `Dockerfile` is Python-only, with no Chromium in the image:

```bash
docker build -t kizzey-web .
docker run --rm -p 8420:8420 -v kizzey-data:/app/data \
  -e KIZZEY_BROWSER_CDP=http://192.168.1.20:9222 \
  kizzey-web
```

Kizzey asks the endpoint for its tabs, opens `discord.com/login` in a new tab, waits while you sign
in on that machine, reads the session token over the same debugging channel, and closes that tab.
Chrome binds the debugging port to `127.0.0.1` by default. Reach it with an SSH tunnel
(`ssh -L 9222:127.0.0.1:9222 user@desktop`) and use `http://127.0.0.1:9222`, run Kizzey with host
networking on that machine, or use a Chromium container on the same Docker network.

For a hosted browser service, the `ws://` or `wss://` form keeps its query string:

```bash
KIZZEY_BROWSER_CDP='wss://browser.example.com?token=SECRET' python3 server.py
```

A headless Chromium (for example a browserless container) can open the tab but gives you no screen to
sign in on; use it only if you can view that browser (VNC, a live-view URL) or if the profile is
already signed in and the token can be read straight away. Otherwise the password and token
fallbacks below work with no browser at all.

The DevTools endpoint is remote control of a real browser: keep it on localhost, a private Docker
network or an SSH tunnel, and never publish it to the internet. Set `KIZZEY_BROWSER_CDP_TOKEN` if
your endpoint expects `Authorization: Bearer …`. A local browser on a display-less host stays
invisible and unusable, so headless mode there is opt-in with `KIZZEY_BROWSER_HEADLESS=1`; containers
automatically get `--no-sandbox` because a throwaway profile cannot start as root otherwise.

### Email or username and password

The fallback sign-in screen works the way `discord.com` does: type the email or username and password
for the account, and Kizzey performs the same login request the website performs, from the server.
Discord answers with a session token, or with a two-factor challenge — when it asks for a code,
Kizzey shows the two-factor field and posts the current code from your authenticator app back to
Discord.

The password is used only for that one login request, is never logged and is never written anywhere;
only the session token Discord returns is kept, in `data/secret.json`. If Discord answers with a
captcha challenge, the sheet reveals the token block and asks you to paste a token instead, because a
captcha cannot be solved by the server on your behalf.

### Use a token instead

Rich Presence is sent through the user gateway, not a bot account, so the presence and message
features need a Discord user token. The sign-in sheet keeps that path behind **Use a token instead**:
open Discord in a desktop browser, copy the `token` value from Local Storage, and paste it once.
This is the web equivalent of the Android app's WebView session, and it is also the fallback when a
login hits a captcha or a two-factor method the server cannot drive.

The token is validated against Discord, stored in `data/secret.json`, and used server-side. Public
state, logs, API responses and state exports never include it. A token is a live credential to the
account, so treat it like a password: keep it on this machine and out of anything you share.

### Multiple Discord accounts

Open **Settings → Discord accounts**, or choose the same item in the drawer, to add, focus and remove
identities. Up to eight accounts are kept in a private `accounts` array in `data/secret.json`; the
legacy `token` field remains as a compatibility copy of the focused account's token. The browser only
receives account IDs, usernames, display names, avatars, timestamps, the credential kind
(`token`/`none`), and boolean token and gateway status — never a token, token fragment or hint.

Accounts do not replace one another. Every account whose presence is running, or which is named by an
enabled message-mirror rule, keeps its own gateway open at the same time, so several accounts can
hold Rich Presence at once and a mirror source and destination can each stay connected
independently. An account with nothing switched on holds no socket: adding an account only validates
and stores the token.

Focus selects which account the editor and the status screens act on; it never stops the others.
Switching focus to a second account leaves the first account's presence and socket running, and
switching back changes nothing. Stopping a presence closes that account's gateway, except while a
mirror rule still needs it. An account whose token Discord rejects — a revoked token, a banned or
deleted account — has only its own token cleared; the other accounts keep running. **Remove all
accounts** clears every token and closes every socket.

Rich Presence on several accounts is possible at once. The Android app's **Multiple Account RPC**
instead concerns several RPC sources for one account; Kizzey Web offers per-account presence plus the
message forwarder below.

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

The server is a poller, not a gateway listener: messages are read over the REST API on an interval,
so an enabled rule keeps the gateways of the accounts it names open but never takes its messages
from them. A new rule records the newest source message as its starting cursor, so existing history
is never backfilled. Only messages after that cursor
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

## Presets

**Presets** on the Custom RPC screen keeps cards on a shelf and moves them between installs. The
manager lists your saved cards plus the built-in ones, and each saved row can be loaded, edited,
downloaded or deleted.

- **Save current card** stores the form you have open under a name, optionally downloading it in the
  same step. Names are required; an empty card is rejected.
- **Edit** renames the card or replaces it with whatever the Custom RPC form holds right now. Both
  keep the preset's id and creation time.
- **Download .json** writes a single card. **All presets** writes a dated pack. **Current card**
  writes the form without saving it.

A single card downloads as a stand-alone Kizzey `RpcConfig`, the same shape the Android app's
**Save config** produces, so it imports back into Kizzey or into this server unchanged. Party sizes
and timestamps are written as numbers when the card sets them and left blank otherwise, the activity
type is clamped to Kizzey's list, and an application ID is kept only when it is a valid 18–19 digit
snowflake. A pack downloads as a `kizzey-preset` bundle carrying every saved card with its name,
details, state line, timers and artwork, and re-imports through **Backup & restore**.

Presets live in `data/state.json` alongside the rest of the saved-card library, capped at 500. The
endpoints write under the store lock and return the new state, so the browser never has to guess
what the shelf looks like.

## Checks

The runtime has no dependencies, but the repository includes regression checks for the native
import path. Node is optional and only used to exercise the browser-side actions with stubs.

```bash
python3 -m py_compile server.py
for file in static/*.js; do node --check "$file"; done
python3 tests/test_kizzey_import.py
python3 tests/test_accounts_mirror.py
python3 tests/test_password_login.py
python3 tests/test_browser_remote.py
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
- Up to eight saved Discord accounts, each able to hold its own live Rich Presence at once
- Discord web sign-in in a local browser or a remote Chrome DevTools endpoint, plus email/password with two-factor and a user-token fallback
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
| Simultaneous multi-account RPC | Each account with a running presence holds its own gateway; several run at once |
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
- `POST /api/auth/login`, `/api/auth/mfa`, `/api/auth/token`, `/api/auth/logout`
- `POST /api/account/refresh`, `/api/gateway/reconnect`
- `POST /api/accounts/{add,switch,remove,remove-all}`
- `POST /api/mirror/settings`, `/api/mirror/rules`, `/api/mirror/rules/{toggle,delete}`, `/api/mirror/run`
- `POST /api/rpc/{start,stop,refresh,preview}`
- `POST /api/presets/{save,delete}`; `GET /api/presets/export` (`?id=`, `?current=1`, `?pack=1`)
- `GET /api/weather`, `/api/geocode`, `/api/route`, `/api/friends`, `/api/hoststats`, `/api/update`
- `POST /api/upload`, `/api/image`, `/api/ocr`, `/api/chat/*`, `/api/voice/*`, `/api/moments/*`
- `POST /api/wallet/daily`, `/api/shop/buy`, `/api/premium/{unlock,reset}`
- `GET /api/export`, `/api/logs`, `/api/history`; `POST /api/import`, `/api/logs/clear`, `/api/history/clear`

Unknown `/api/*` paths return JSON 404s. SSE recovers in the browser. Gateways are opened on demand:
one starts for an account as soon as its presence runs or an enabled mirror rule needs it, and closes
again when neither is true. Keep gateway alive only controls whether the socket retries while the
server process runs; startup restores the focused account and opens sockets only for accounts an
enabled mirror rule still references, so an idle install holds none.

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
