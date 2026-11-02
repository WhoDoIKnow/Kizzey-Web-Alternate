# Kizzey voice service

A small HTTP service that gives Kizzey Web real Discord voice features:

- **Join** a Discord voice channel with a bot (or user) account.
- **Play music** into that channel from a URL or a search query.
- **Record** the channel, one compressed Opus/OGG file per speaker plus an
  optional mixed-down track. The bot's own music playback is recorded too.
- **Compress** existing recordings further with ffmpeg.

Kizzey itself never changes: the web app calls the Kizzey server, which proxies
to this service over a token-protected JSON API. The Discord token and the
service token stay on the server.

---

## Requirements

- Python 3.12 (3.13+ needs the `audioop-lts` package, already listed).
- The `ffmpeg` binary on `PATH`.
- The `libopus` shared library (installed with `ffmpeg` on Debian/Ubuntu, or
  `libopus0`; py-cord/discord.py load it for voice).
- A Discord **bot token** (recommended) or a user token, and for the bot:
  - the **Server Members Intent** is optional: enable it *and* set
    `VOICE_MEMBERS_INTENT=1` to label recordings with names instead of ids,
  - the bot must be in the guild and have **Connect** permission on the channel,
  - enable the **Voice States** and **Guilds** gateway intents in the Developer
    Portal if your library asks for them (they are non-privileged).

Install:

```bash
cd voice_service
pip install -r requirements.txt
```

## Run

```bash
VOICE_TOKEN=change-me \
DISCORD_TOKEN=your-bot-token \
python3 voice_service.py --host 0.0.0.0 --port 8421
```

Then start Kizzey pointed at it:

```bash
KIZZEY_VOICE_URL=http://127.0.0.1:8421 \
KIZZEY_VOICE_TOKEN=change-me \
python3 server.py --host 0.0.0.0 --port 8420
```

`VOICE_TOKEN` is required whenever the service is bound to anything other than
loopback. Kizzey sends it as a bearer token and never exposes it to the browser.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `VOICE_HOST` | `127.0.0.1` | Bind address. |
| `VOICE_PORT` | `8421` | Port. |
| `VOICE_TOKEN` | *(empty)* | Shared secret. Required off loopback. |
| `DISCORD_TOKEN` | *(empty)* | Default bot/user token. A token can also be sent per `/join`. |
| `VOICE_RECORDINGS_DIR` | `data/voice_recordings` | Where OGG recordings are stored. |
| `VOICE_FFMPEG` | `ffmpeg` | ffmpeg binary. |
| `VOICE_YTDLP` | `yt-dlp` | yt-dlp binary used when the Python module is missing. |
| `VOICE_MEMBERS_INTENT` | *(off)* | Opt in to the privileged Server Members intent for named speakers. |
| `VOICE_LOG_LEVEL` | `INFO` | Log level. |

## Docker

From the repository root:

```bash
docker compose up --build
```

The compose file runs Kizzey and the voice service side by side, with the
recordings in a named volume. Set `DISCORD_TOKEN` and `KIZZEY_VOICE_TOKEN` in a
`.env` file next to `docker-compose.yml`.

## Recording and Discord's DAVE encryption

Since 2026 Discord encrypts voice channels end to end with the **DAVE** protocol.
*Sending* audio (music playback) is unaffected. *Receiving* audio — which
recording needs — only works when the voice library decrypts DAVE.

The default `requirements.txt` pins **py-cord** to a commit on the
`fix/voice-rec-2` branch, whose receive path decrypts DAVE through
`discord.opus.PacketDecoder`. Stock releases of every library still silently drop
encrypted receive audio. The service auto-detects either stack:

| Backend | Detection | Receive call |
| --- | --- | --- |
| `pycord` | `discord.sinks.Sink` exists | `voice.start_recording(sink)` |
| `voice_recv` | `discord.ext.voice_recv` imports | `voice.listen(sink)` |

`GET /health` and `GET /state` report the active `backend`. If a recording comes
back silent or sounds like noise:

1. Check the **encryption** badge on the Discord voice panel in Kizzey. `n/a`
   means the connected library does not report DAVE support.
2. Confirm the service logged `receive backend: pycord`. If it says `none`, the
   voice stack did not import.
3. Make sure the service is not joining deaf — it connects with `self_deaf=False`
   deliberately, because Discord sends no audio to a deafened client.

## HTTP API

All endpoints except `GET /health` require `Authorization: Bearer <VOICE_TOKEN>`.

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
