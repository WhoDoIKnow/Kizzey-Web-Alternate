# Kizzey Web-Alternate

A self-hosted browser recreation of the Kizzey Android app (`xyz.Kizzey` 8.4.4). It keeps the
Material 3 phone interface, the full presence editor set, and the community/tool screens while
using a Python standard-library server as the browser equivalent of the Android service.

The Discord token lives on the server. The browser never receives it, not even a hint.

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

### Options

| Option | Purpose |
| --- | --- |
| `--host 0.0.0.0` | Listen on every interface. Default. |
| `--port 8420` | HTTP port. Default `8420`. |
| `--no-gateway` | Restore the saved account without opening the Discord gateway at startup. |
| `KIZZEY_HOST` / `KIZZEY_PORT` | Environment equivalents for host and port. |

## Signing in

Open the welcome screen or the drawer and choose **Connect Discord**. Kizzey uses a Discord
user token because Rich Presence is sent through the user gateway, not a bot account. The sheet
explains where the token is in Discord's Local Storage; pasting it is the web equivalent of the
Android app's WebView sign-in.

The token is validated against Discord, stored in `data/secret.json`, and used server-side.
Public state, logs, API responses and state exports never include it. Use a token only on a
server you control, keep the server off untrusted networks, and remember that Discord user
tokens carry account risk.

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
- Optional album-art backdrop and artwork-sampled accent colour in Display settings
- Custom CSS variables, text scaling, themes, AMOLED mode and Material You-style accents

**Community and utilities**

- Kizzey Chat with rooms, replies, reactions, attachments, local notifications and SSE updates
- Voice-room roster, mute/deafen/speaking state, heartbeat and local microphone level test
- Moments, leaderboard, Discord friends list, presence browser, profile and usage/history screens
- KCoin wallet, shop, cosmetic equip actions and a no-payment Kizzey+ demo
- Weather/geocoding via Open-Meteo, driving routes via OSRM
- Local host diagnostics, plugins, bulk operations, backup/export/import and update checks
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
data/state.json     settings, presets, chat, history, wallet, UI state
data/secret.json    Discord token only
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

- `GET /api/state`, `GET /api/events`, `POST /api/patch`
- `POST /api/auth/token`, `/api/auth/logout`, `/api/account/refresh`, `/api/gateway/reconnect`
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
