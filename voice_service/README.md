# Kizzey voice service

A small Node HTTP service that gives Kizzey Web real Discord voice features:

- **Join** a Discord voice channel with an account token (or a bot token).
- **Play music** into that channel from a URL, a local file or a search query.
- **Record** the channel, one compressed Opus/OGG file per speaker plus an
  optional mixed-down track. The account's own music playback is recorded too.
- **Compress** existing recordings further with ffmpeg.

Kizzey itself proxies to this service over a token-protected JSON API. The
Discord token and the service token stay on the server and never reach the
browser.

---

## Requirements

- Node.js 20.18 or newer (Node 22 LTS recommended).
- The repository's npm packages (`npm install` from the checkout root).
- The `ffmpeg` binary on `PATH`, or `ffmpeg-static` installed, or `VOICE_FFMPEG`
  pointing at a binary.
- Optional: `yt-dlp` for searching music by name. Direct URLs and local files
  work without it.
- A Discord **account token** (the one Kizzey uses for RPC) or a bot token.
  Account tokens are the default; set `VOICE_USER_TOKEN=0` (or pass
  `--bot-token`) when using a bot token.

Install from the checkout root:

```bash
npm install
```

On Android shared storage npm may be unable to create `node_modules/.bin`
symlinks; use `npm install --no-bin-links`. `scripts/postinstall.js` (run
automatically by `npm install`/`npm ci`) copies the prebuilt
`@snazzah/davey` binding into app-private storage and patches the loader so
`NAPI_RS_NATIVE_LIBRARY_PATH` is honoured; the companion repeats the copy at
startup if the install script did not run. Both steps are no-ops on ordinary
Linux and in containers.

## Run

The companion uses the same Discord account token that Kizzey already stores for
RPC. When you join from the Kizzey screen, the server reads the active account
token from `data/secret.json` and sends it to the companion over the local
socket, so there is no second token to paste. Sign in through Kizzey first, or
pass `DISCORD_TOKEN` if you want the companion to connect at startup.

```bash
# loopback only: no shared secret needed
node voice_service/index.js --host 127.0.0.1 --port 8421

# Kizzey (the launcher starts both for you: node script_pull.js)
KIZZEY_VOICE_URL=http://127.0.0.1:8421 node server.js --host 0.0.0.0 --port 8420
```

`VOICE_TOKEN` is required whenever the service is bound to anything other than
loopback. Then set the same value as `KIZZEY_VOICE_TOKEN` on Kizzey; it is a
bearer token between the two processes, not the Discord token. Kizzey never
exposes it to the browser.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `VOICE_HOST` | `127.0.0.1` | Bind address. |
| `VOICE_PORT` | `8421` | Port. |
| `VOICE_TOKEN` | *(empty)* | Shared secret. Required off loopback. |
| `VOICE_USER_TOKEN` | `1` | `1` treats the token as an account token; `0` keeps the `Bot ` prefix for a bot token. |
| `DISCORD_TOKEN` | *(empty)* | Optional default token. Kizzey normally sends the saved RPC token per `/join`. |
| `VOICE_RECORDINGS_DIR` | `data/voice_recordings` | Where OGG recordings and `recordings.json` live. |
| `VOICE_FFMPEG` | `ffmpeg` | ffmpeg binary. `ffmpeg-static` is used when installed and this is unset. |
| `VOICE_YTDLP` | `yt-dlp` | yt-dlp binary for search queries. |
| `NAPI_RS_NATIVE_LIBRARY_PATH` | *(auto)* | Path to the DAVE native binding when the default lookup cannot load it. |

## Docker

From the repository root:

```bash
docker compose up --build
```

The compose file runs Kizzey and the voice service side by side, with the
recordings in a named volume. The two containers are not on loopback, so set
`KIZZEY_VOICE_TOKEN` in a `.env` file next to `docker-compose.yml`. `DISCORD_TOKEN`
is optional; Kizzey forwards the saved RPC token when you join.

## Recording and Discord's DAVE encryption

Since 2026 Discord encrypts voice channels end to end with the **DAVE** protocol.
*Sending* audio (music playback) is unaffected. *Receiving* audio — which
recording needs — only works when the voice library decrypts DAVE.

This service uses **`@discordjs/voice` 0.19**, which negotiates DAVE through
`@snazzah/davey`, for both playback and receive. `discord.js-selfbot-v13`
provides the account-token gateway and the voice-server/state adapter; no bot
token and no Lavalink are involved.

`GET /health` and `GET /state` report `backend: "discordjs-voice"` when the
stack loaded. If the native binding cannot load, `/health` returns
`backend: null` and the load error, and the service still answers the control
plane so the screen can explain the failure.

If a recording comes back silent or sounds like noise:

1. Check the **encryption** badge on the Discord voice panel in Kizzey. `n/a`
   means the connected stack could not report DAVE support.
2. Check `/health` for `backend` and `error`.
3. Make sure the service is not joining deaf — it connects with `selfDeaf: false`
   deliberately, because Discord sends no audio to a deafened client.

## HTTP API

`GET /` and `GET /health` are unauthenticated liveness probes. Other endpoints
require `Authorization: Bearer <VOICE_TOKEN>` or `X-Voice-Token`; when
`VOICE_TOKEN` is empty, only loopback requests are accepted.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| `GET` | `/health` | — | Liveness and dependency flags. |
| `GET` | `/state` | — | Connection, playback, queue, recording state. |
| `POST` | `/join` | `{guildId?, channelId, token?}` | Join a voice channel. |
| `POST` | `/leave` | — | Disconnect and stop everything. |
| `POST` | `/play` | `{query, volume?}` | Play a URL, file or search query; queues if busy. |
| `POST` | `/control` | `{action, value?}` | `pause`, `resume`, `stop`, `skip`, `volume`, `clear`. |
| `POST` | `/record/start` | `{mode?, bitrate?, mix?}` | Start recording to per-speaker OGG/Opus. |
| `POST` | `/record/stop` | — | Stop, mix if requested, index the files. |
| `GET` | `/recordings` | — | List recordings. |
| `GET` | `/recordings/<id>` | — | Download an OGG/Opus recording. |
| `POST` | `/recordings/compress` | `{id, bitrate}` | Re-encode smaller. |
| `POST` | `/recordings/delete` | `{id}` | Delete a recording. |

Successful responses are `{ "ok": true, ... }`; errors are
`{ "ok": false, "error": "..." }` with a 4xx/5xx status. The companion sends
`Cache-Control: no-store` and `X-Content-Type-Options: nosniff` on every JSON
response. Recordings are served as `audio/ogg` only through an authenticated
request, and Kizzey proxies them so the voice port can stay private.

## Files

```text
voice_service/index.js        Node companion (primary)
voice_service/voice_service.py Python reference implementation
voice_service/requirements.txt Python reference dependencies
voice_service/Dockerfile      Node voice image
```
