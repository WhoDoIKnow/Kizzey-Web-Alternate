#!/usr/bin/env node
'use strict';

// Kizzey voice service (Node).
//
// Owns a Discord voice connection, plays music into a channel, records the
// call to per-speaker Opus/OGG files, and compresses recordings. Kizzey talks
// to it over a small JSON HTTP API; Discord tokens stay server-side.
//
// Voice uses @discordjs/voice 0.19 with DAVE end-to-end encryption. The
// gateway/authentication half comes from discord.js-selfbot-v13 so that a
// normal Discord account token (the RPC token) can be used instead of a bot
// token. Playback and recording never need Lavalink.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { PassThrough } = require('stream');

const APP_DIR = path.resolve(__dirname, '..');

let selfbot = null;
let voice = null;
let prism = null;
let voiceLoadError = null;

// On Android the native DAVE binding cannot be dlopen'ed from shared storage.
// Copy the prebuilt module into the app-private home directory and point the
// loader at it before the first require. scripts/postinstall.js does the same
// at install time; this covers installs that predate it.
function prepareNativeBinding() {
  if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH) return;
  if (process.platform !== 'android') return;
  const arm64 = process.arch === 'arm64';
  const pkg = arm64 ? '@snazzah/davey-android-arm64' : '@snazzah/davey-android-arm-eabi';
  const file = arm64 ? 'davey.android-arm64.node' : 'davey.android-arm-eabi.node';
  const source = [APP_DIR, path.join(APP_DIR, '..')]
    .map((base) => path.join(base, 'node_modules', ...pkg.split('/'), file))
    .find((candidate) => fs.existsSync(candidate));
  if (!source) return;
  try {
    const directory = path.join(os.homedir(), '.cache', 'kizzey');
    fs.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, file);
    fs.copyFileSync(source, destination);
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = destination;
  } catch {
    // Leave the default lookup in place; /health reports the load error.
  }
}

function loadVoiceStack() {
  if (voice) return true;
  prepareNativeBinding();
  try {
    selfbot = require('discord.js-selfbot-v13');
    voice = require('@discordjs/voice');
    prism = require('prism-media');
  } catch (error) {
    voiceLoadError = error;
    voice = null;
    return false;
  }
  return true;
}

function nowMs() {
  return Date.now();
}

function cleanToken(value) {
  let token = String(value || '').trim();
  const lowered = token.toLowerCase();
  for (const prefix of ['bearer ', 'bot ']) {
    if (lowered.startsWith(prefix)) {
      token = token.slice(prefix.length).trim();
      break;
    }
  }
  return token;
}

function clampBitrate(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return 32;
  return Math.max(8, Math.min(256, number));
}

function sanitizeLabel(value) {
  const cleaned = String(value || '')
    .replace(/[^A-Za-z0-9 _.-]+/g, '')
    .trim()
    .replace(/\s+/g, '_');
  return cleaned.slice(0, 48) || 'user';
}

const RECORDING_ID_RE = /^[A-Za-z0-9_.-]{1,160}$/;

function safeRecordingId(value) {
  const text = String(value || '');
  if (text === '.' || text === '..' || !RECORDING_ID_RE.test(text) || text.includes('/') || text.includes('\\')) {
    throw new Error('Invalid recording id.');
  }
  return text;
}

// ---------------------------------------------------------------------------
// recordings index
// ---------------------------------------------------------------------------
function recordingsDir() {
  const directory = path.resolve(process.env.VOICE_RECORDINGS_DIR || path.join(APP_DIR, 'data', 'voice_recordings'));
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function indexPath(directory) {
  return path.join(directory, 'recordings.json');
}

function loadIndex(directory = recordingsDir()) {
  try {
    const data = JSON.parse(fs.readFileSync(indexPath(directory), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

let indexChain = Promise.resolve();

function withIndexLock(fn) {
  const previous = indexChain;
  let release;
  indexChain = new Promise((resolve) => { release = resolve; });
  return previous.then(fn).finally(release);
}

function saveIndex(items, directory = recordingsDir()) {
  const target = indexPath(directory);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items.slice(0, 500), null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

async function addIndex(entry, directory = recordingsDir()) {
  return withIndexLock(() => {
    const items = loadIndex(directory);
    const item = { id: entry.id || crypto.randomBytes(16).toString('hex'), created: entry.created || nowMs(), ...entry };
    items.unshift(item);
    saveIndex(items, directory);
    return item;
  });
}

function findIndex(recordingId, directory = recordingsDir()) {
  return loadIndex(directory).find((item) => item.id === recordingId) || null;
}

async function deleteIndex(recordingId, directory = recordingsDir()) {
  return withIndexLock(() => {
    const items = loadIndex(directory);
    const found = items.find((item) => item.id === recordingId) || null;
    if (found) saveIndex(items.filter((item) => item.id !== recordingId), directory);
    return found;
  });
}

function resolveRecordingPath(entry, directory = recordingsDir()) {
  const base = path.resolve(directory);
  const name = String((entry || {}).name || '');
  if (!name || name.includes('/') || name.includes('\\')) return null;
  const candidate = path.resolve(base, name);
  return path.dirname(candidate) === base ? candidate : null;
}

// ---------------------------------------------------------------------------
// ffmpeg / yt-dlp
// ---------------------------------------------------------------------------
function resolveFfmpeg() {
  const configured = String(process.env.VOICE_FFMPEG || 'ffmpeg').trim() || 'ffmpeg';
  if (configured.includes(path.sep)) return fs.existsSync(configured) ? configured : '';
  try {
    const stat = require('ffmpeg-static');
    if (stat && fs.existsSync(stat)) return stat;
  } catch {
    // optional dependency; fall through to PATH lookup
  }
  const probe = spawnSync(configured, ['-version'], { stdio: 'ignore' });
  return probe.status === 0 ? configured : '';
}

let ffmpegProbe = null;

function ffmpegAvailable(bin) {
  if (!bin) return false;
  if (ffmpegProbe && ffmpegProbe.bin === bin) return ffmpegProbe.ok;
  const probe = spawnSync(bin, ['-version'], { stdio: 'ignore' });
  const ok = probe.status === 0;
  ffmpegProbe = { bin, ok };
  return ok;
}

function resolveYtdlp() {
  const configured = String(process.env.VOICE_YTDLP || 'yt-dlp').trim() || 'yt-dlp';
  const probe = spawnSync(configured, ['--version'], { stdio: 'ignore' });
  return probe.status === 0 ? configured : '';
}

function buildRecorderCommand(ffmpegBin, output, bitrate) {
  return [
    ffmpegBin, '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
    '-ac', '1', '-c:a', 'libopus', '-b:a', `${clampBitrate(bitrate)}k`,
    '-application', 'audio', '-f', 'ogg', '-y', output,
  ];
}

function buildMixCommand(ffmpegBin, inputs, output, bitrate) {
  const args = [ffmpegBin, '-hide_banner', '-loglevel', 'error', '-nostdin'];
  for (const input of inputs) args.push('-i', input);
  args.push(
    '-filter_complex',
    `amix=inputs=${inputs.length}:duration=longest:dropout_transition=0:normalize=1`,
    '-ac', '1', '-c:a', 'libopus', '-b:a', `${clampBitrate(bitrate)}k`,
    '-f', 'ogg', '-y', output
  );
  return args;
}

function buildCompressCommand(ffmpegBin, source, output, bitrate) {
  return [
    ffmpegBin, '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', source, '-ac', '1', '-c:a', 'libopus', '-b:a', `${clampBitrate(bitrate)}k`,
    '-application', 'audio', '-f', 'ogg', '-y', output,
  ];
}

function runProcess(command, args, { timeout = 900000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error('ffmpeg timed out.'));
    }, timeout);
    timer.unref?.();
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with ${code}.`));
    });
  });
}

function looksLikeUrl(text) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text);
}

async function resolveSource(query, ytdlpBin) {
  const text = String(query || '').trim();
  if (!text) throw new Error('Give me a URL, a file, or something to search for.');
  if (looksLikeUrl(text)) return { url: text, title: text };
  if (fs.existsSync(text)) {
    const resolved = path.resolve(text);
    return { url: resolved, title: path.basename(resolved) };
  }
  if (!ytdlpBin) {
    throw new Error(
      "Search needs the 'yt-dlp' command. Use a direct audio/video URL instead, or install yt-dlp."
    );
  }
  const search = text.startsWith('ytsearch') ? text : `ytsearch1:${text}`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(ytdlpBin, ['-f', 'bestaudio/best', '--no-playlist', '--no-warnings', '-g', search], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { err = (err + chunk.toString()).slice(-2000); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      reject(new Error('yt-dlp took too long to resolve that search.'));
    }, 90000);
    timer.unref?.();
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = out.split('\n').map((line) => line.trim()).filter(Boolean);
      if (code === 0 && lines.length) resolve(lines[0]);
      else reject(new Error(err.trim().split('\n').pop() || 'yt-dlp could not resolve that search.'));
    });
  });
  return { url: result, title: text };
}

// ---------------------------------------------------------------------------
// live recorder: one ffmpeg per speaker, OGG/Opus output
// ---------------------------------------------------------------------------
class Recorder {
  constructor(directory, bitrate, stamp, ffmpegBin) {
    this.directory = directory;
    this.bitrate = clampBitrate(bitrate);
    this.stamp = stamp;
    this.ffmpegBin = ffmpegBin;
    this.tracks = new Map();
    this.finishing = null;
    this.closed = false;
  }

  ensureTrack(key, label) {
    if (this.closed) return null;
    const existing = this.tracks.get(key);
    if (existing) return existing;
    if (!this.ffmpegBin) throw new Error('ffmpeg is not available, so recording cannot start.');
    const safe = sanitizeLabel(label);
    const name = `${this.stamp}__${safe}__${key}.ogg`;
    const output = path.join(this.directory, name);
    const process = spawn(this.ffmpegBin, buildRecorderCommand(this.ffmpegBin, output, this.bitrate), {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const track = { user: safe, userId: key, name, process, bytes: 0, error: false };
    process.on('error', () => { track.error = true; });
    process.stdin.on('error', () => { track.error = true; });
    this.tracks.set(key, track);
    return track;
  }

  writePcm(key, label, pcm) {
    if (!pcm || !pcm.length) return;
    let track;
    try {
      track = this.ensureTrack(key, label);
    } catch {
      return;
    }
    if (!track || track.error) return;
    try {
      track.process.stdin.write(pcm);
      track.bytes += pcm.length;
    } catch {
      track.error = true;
    }
  }

  writeMusic(pcm) {
    this.writePcm('music', 'music', pcm);
  }

  snapshot() {
    return [...this.tracks.values()].map((track) => ({
      user: track.user,
      userId: track.userId,
      bytes: track.bytes,
    }));
  }

  async cleanup() {
    if (this.finishing) return this.finishing;
    this.closed = true;
    const tracks = [...this.tracks.values()];
    this.finishing = (async () => {
      await Promise.all(tracks.map((track) => new Promise((resolve) => {
        const process = track.process;
        if (!process) return resolve();
        if (process.exitCode !== null) return resolve();
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        process.once('close', finish);
        try { process.stdin.end(); } catch { /* already closed */ }
        const timer = setTimeout(() => {
          try { process.kill('SIGKILL'); } catch { /* gone */ }
          finish();
        }, 15000);
        timer.unref?.();
      })));
      return tracks.map((track) => ({ ...track, process: null }));
    })();
    return this.finishing;
  }
}

class VoiceManager {
  constructor({ defaultToken = '', ffmpegBin = '', ytdlpBin = '', recordings = null, userToken = true } = {}) {
    this.defaultToken = defaultToken;
    this.ffmpegBin = ffmpegBin || resolveFfmpeg();
    this.ytdlpBin = ytdlpBin || resolveYtdlp();
    this.recordings = recordings || recordingsDir();
    this.userToken = Boolean(userToken);
    this.client = null;
    this.token = '';
    this.connection = null;
    this.player = null;
    this.adapters = new Map();
    this.current = null;
    this.queue = [];
    this.recorder = null;
    this.recordMeta = null;
    this.recordStreams = new Map();
    this.ffmpegChild = null;
    this.resource = null;
    this.stopping = false;
    this._idleBound = false;
  }

  async ensureClient(token = '', userToken = null) {
    if (userToken === false || this.userToken === false) {
      throw new Error('The Node voice companion uses Discord account tokens only; start the Python reference for bot tokens.');
    }
    if (!loadVoiceStack()) {
      throw new Error(
        `Voice dependencies are missing: ${voiceLoadError ? voiceLoadError.message : 'install @discordjs/voice'}`
      );
    }
    const chosen = cleanToken(token || this.defaultToken || '');
    if (!chosen) throw new Error('No Discord token is configured for the voice service.');
    if (this.client && this.token === chosen && this.client.isReady()) return this.client;
    if (this.client) await this.closeClient();
    this.token = chosen;

    const client = new selfbot.Client({ checkUpdate: false });
    this.client = client;
    client.on('error', (error) => {
      console.error('[voice] Discord client error:', error.message || error);
    });
    await Promise.race([
      client.login(chosen),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out while connecting to Discord.')), 45000)),
    ]);
    if (!client.isReady()) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The Discord client did not become ready.')), 30000);
        client.once('ready', () => { clearTimeout(timer); resolve(); });
      });
    }
    console.log(`[voice] Discord client ready as ${client.user ? client.user.tag || client.user.username : 'unknown'}`);
    return client;
  }

  async closeClient() {
    try {
      await this.stopRecording();
    } catch {
      // best effort
    }
    await this.leave();
    if (this.client) {
      try {
        await this.client.destroy();
      } catch {
        // already gone
      }
      this.client = null;
    }
  }

  _adapterCreator(guild) {
    return (methods) => {
      this.adapters.set(guild.id, methods);
      if (this.client) this.client.voice.adapters.set(guild.id, methods);
      return {
        sendPayload: (payload) => {
          const shard = guild.shard || (this.client && this.client.ws.shards.first());
          if (!shard) return false;
          try {
            shard.send(payload);
            return true;
          } catch {
            return false;
          }
        },
        destroy: () => {
          this.adapters.delete(guild.id);
          if (this.client) this.client.voice.adapters.delete(guild.id);
        },
      };
    };
  }

  async join(guildId, channelId, token = '', userToken = null) {
    const client = await this.ensureClient(token, userToken);
    if (!loadVoiceStack()) throw new Error(`Voice dependencies are missing: ${voiceLoadError?.message || ''}`);
    const id = String(channelId || '').trim();
    if (!/^\d{16,20}$/.test(id)) throw new Error('That channel id is not valid.');
    let channel = client.channels.cache.get(id);
    if (!channel) {
      try {
        channel = await client.channels.fetch(id);
      } catch {
        channel = null;
      }
    }
    if (!channel) throw new Error('I cannot see that channel. Check the id and the account access.');
    if (![2, 13].includes(Number(channel.type))) throw new Error('That is not a voice channel.');
    if (guildId && String(channel.guild.id) !== String(guildId)) {
      throw new Error('That channel is not in the server you chose.');
    }
    if (this.connection && this.connection.joinConfig.channelId === channel.id &&
        this.connection.state.status !== voice.VoiceConnectionStatus.Destroyed) {
      return this.state();
    }
    if (this.connection) {
      try { this.connection.destroy(); } catch { /* already gone */ }
      this.connection = null;
    }
    const guild = channel.guild;
    this.connection = voice.joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: this._adapterCreator(guild),
      selfDeaf: false,
      selfMute: false,
      daveEncryption: true,
      debug: false,
    });
    this.connection.on('error', (error) => {
      console.error('[voice] connection error:', error.message || error);
    });
    this.connection.on('stateChange', (from, to) => {
      if (to.status === voice.VoiceConnectionStatus.Disconnected) {
        console.warn('[voice] voice connection disconnected');
      }
    });
    await voice.entersState(this.connection, voice.VoiceConnectionStatus.Ready, 30000);
    if (!this.player) {
      this.player = voice.createAudioPlayer();
      this.player.on('error', (error) => {
        console.error('[voice] player error:', error.message || error);
      });
      this._bindIdle();
    }
    this.connection.subscribe(this.player);
    this.connection.receiver.speaking.on('start', (userId) => this._onSpeakingStart(userId));
    return this.state();
  }

  _bindIdle() {
    if (!this.player || this._idleBound) return;
    this._idleBound = true;
    this.player.on(voice.AudioPlayerStatus.Idle, () => {
      if (this.stopping) return;
      this._killFfmpeg();
      this.resource = null;
      this.current = null;
      this._advance().catch((error) => console.error('[voice] queue error:', error.message || error));
    });
  }

  async leave() {
    this.queue = [];
    this.current = null;
    this._killFfmpeg();
    if (this.player) {
      try { this.player.stop(true); } catch { /* already stopped */ }
    }
    if (this.connection) {
      try { this.connection.destroy(); } catch { /* already gone */ }
    }
    this.connection = null;
    this.resource = null;
    return this.state();
  }

  async play(query, volume = 1.0) {
    if (!this.connection || this.connection.state.status !== voice.VoiceConnectionStatus.Ready) {
      throw new Error('Join a voice channel first.');
    }
    const { url, title } = await resolveSource(query, this.ytdlpBin);
    let amount = Number(volume);
    if (!Number.isFinite(amount)) amount = 1;
    amount = Math.max(0, Math.min(2, amount));
    const track = { query, title: title || query, url, volume: amount, startedAt: nowMs() };
    if (this.current) {
      this.queue.push(track);
      return { queued: true, position: this.queue.length, state: this.state() };
    }
    await this._startTrack(track);
    return { queued: false, state: this.state() };
  }

  async _startTrack(track) {
    if (!this.ffmpegBin) throw new Error('ffmpeg is not available, so playback cannot start.');
    if (!this.player) throw new Error('Join a voice channel first.');
    this._killFfmpeg();
    const args = [
      this.ffmpegBin, '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', track.url, '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
    ];
    const child = spawn(this.ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.ffmpegChild = child;
    const pcm = new PassThrough();
    child.stdout.pipe(pcm);
    child.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (line) console.warn('[voice] ffmpeg:', line.slice(0, 300));
    });
    child.on('error', (error) => {
      console.error('[voice] playback process error:', error.message || error);
    });
    pcm.on('data', (chunk) => {
      if (this.recorder) {
        try { this.recorder.writeMusic(chunk); } catch { /* recording stopped */ }
      }
    });
    const resource = voice.createAudioResource(pcm, {
      inputType: voice.StreamType.Raw,
      inlineVolume: true,
    });
    if (resource.volume) resource.volume.setVolume(track.volume);
    this.resource = resource;
    this.current = track;
    this.player.play(resource);
  }

  async _advance() {
    if (this.current) return;
    if (!this.queue.length) return;
    const track = this.queue.shift();
    try {
      await this._startTrack(track);
    } catch (error) {
      console.error('[voice] could not start queued track:', error.message || error);
      this.current = null;
      await this._advance();
    }
  }

  _killFfmpeg() {
    const child = this.ffmpegChild;
    this.ffmpegChild = null;
    if (child) {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  }

  control(action, value) {
    action = String(action || '').toLowerCase();
    if (action === 'volume') {
      const amount = Number(value);
      if (!Number.isFinite(amount)) throw new Error('Volume must be a number between 0 and 2.');
      const clamped = Math.max(0, Math.min(2, amount));
      if (this.resource && this.resource.volume) this.resource.volume.setVolume(clamped);
      if (this.current) this.current.volume = clamped;
      else if (this.queue.length) this.queue[this.queue.length - 1].volume = clamped;
      return this.state();
    }
    if (action === 'pause') {
      if (this.player && this.player.state.status === voice.AudioPlayerStatus.Playing) this.player.pause();
      return this.state();
    }
    if (action === 'resume') {
      if (this.player && this.player.state.status === voice.AudioPlayerStatus.Paused) this.player.unpause();
      return this.state();
    }
    if (action === 'stop') {
      this.queue = [];
      this.current = null;
      this._killFfmpeg();
      if (this.player) {
        try { this.player.stop(true); } catch { /* already stopped */ }
      }
      this.resource = null;
      return this.state();
    }
    if (action === 'skip') {
      if (this.player && this.current) {
        try { this.player.stop(); } catch { /* already stopped */ }
      } else if (this.queue.length) {
        this._advance().catch(() => {});
      }
      return this.state();
    }
    if (action === 'clear') {
      this.queue = [];
      return this.state();
    }
    throw new Error('Unknown playback control.');
  }

  _onSpeakingStart(userId) {
    if (!this.recorder || this.recordStreams.has(userId)) return;
    if (this.client && this.client.user && String(userId) === String(this.client.user.id)) return;
    this._subscribe(userId);
  }

  _speakerLabel(userId) {
    const client = this.client;
    if (!client) return String(userId);
    const user = client.users.cache.get(String(userId));
    if (user) return user.displayName || user.username || String(userId);
    const guildId = this.connection && this.connection.joinConfig.guildId;
    const guild = guildId ? client.guilds.cache.get(guildId) : null;
    const member = guild ? guild.members.cache.get(String(userId)) : null;
    return (member && (member.displayName || member.user?.username)) || String(userId);
  }

  _subscribe(userId) {
    if (!this.connection) return;
    try {
      const stream = this.connection.receiver.subscribe(userId, {
        end: { behavior: voice.EndBehaviorType.Manual },
      });
      const decoder = new prism.opus.Decoder({ channels: 2, rate: 48000, frameSize: 960 });
      stream.pipe(decoder);
      decoder.on('data', (pcm) => {
        if (this.recorder) this.recorder.writePcm(String(userId), this._speakerLabel(userId), pcm);
      });
      const cleanup = () => {
        const entry = this.recordStreams.get(String(userId));
        if (entry && entry.stream === stream) this.recordStreams.delete(String(userId));
      };
      stream.on('error', cleanup);
      stream.on('end', cleanup);
      decoder.on('error', cleanup);
      this.recordStreams.set(String(userId), { stream, decoder });
    } catch (error) {
      console.warn('[voice] could not listen to a speaker:', error.message || error);
    }
  }

  startRecording(mode = 'mix', bitrate = 32, mix = true) {
    if (!this.connection || this.connection.state.status !== voice.VoiceConnectionStatus.Ready) {
      throw new Error('Join a voice channel first.');
    }
    if (this.recorder) throw new Error('A recording is already running.');
    if (!loadVoiceStack()) throw new Error('Voice receive is unavailable; install the voice dependencies.');
    if (!this.ffmpegBin) throw new Error('ffmpeg is not available, so recording cannot start.');
    const normalized = ['mix', 'tracks'].includes(String(mode || '').toLowerCase())
      ? String(mode).toLowerCase()
      : 'mix';
    const stamp = formatStamp(new Date());
    this.recorder = new Recorder(this.recordings, bitrate, stamp, this.ffmpegBin);
    this.recordMeta = { mode: normalized, bitrate: clampBitrate(bitrate), mix: Boolean(mix), startedAt: nowMs(), stamp };
    this.recordStreams.clear();
    const guildId = this.connection.joinConfig.guildId;
    const channelId = this.connection.joinConfig.channelId;
    const guild = this.client && this.client.guilds.cache.get(guildId);
    const channel = guild && guild.channels.cache.get(channelId);
    const members = channel ? channel.members : null;
    if (members && typeof members.forEach === 'function') {
      members.forEach((member) => {
        if (String(member.id) === String(this.client.user?.id || '')) return;
        this._subscribe(member.id);
      });
    }
    return this.state();
  }

  async stopRecording() {
    if (!this.recorder) return this.state();
    for (const [, entry] of this.recordStreams) {
      try { entry.decoder.destroy(); } catch { /* gone */ }
      try { entry.stream.destroy(); } catch { /* gone */ }
    }
    this.recordStreams.clear();
    const recorder = this.recorder;
    const meta = this.recordMeta || {};
    this.recorder = null;
    this.recordMeta = null;
    const tracks = await recorder.cleanup();
    await this._finalise(tracks, meta);
    return this.state();
  }

  async _finalise(tracks, meta) {
    const entries = [];
    for (const track of tracks) {
      if (!track.bytes) {
        const empty = path.join(this.recordings, String(track.name || ''));
        try { await fsp.unlink(empty); } catch { /* no file */ }
        continue;
      }
      const entry = {
        id: crypto.randomBytes(16).toString('hex'),
        kind: 'track',
        name: track.name,
        user: track.user,
        userId: track.userId,
        bitrate: meta.bitrate || 32,
        created: nowMs(),
        bytes: await fsp.stat(path.join(this.recordings, String(track.name))).then((stat) => stat.size).catch(() => track.bytes),
      };
      await addIndex(entry, this.recordings);
      entries.push(entry);
    }
    if (meta.mix && entries.length > 1 && this.ffmpegBin) {
      const outputName = `${meta.stamp || 'mix'}__mix.ogg`;
      const output = path.join(this.recordings, outputName);
      const inputs = entries.map((entry) => path.join(this.recordings, String(entry.name)));
      try {
        await runProcess(this.ffmpegBin, buildMixCommand(this.ffmpegBin, inputs, output, meta.bitrate || 32));
        const stat = await fsp.stat(output).catch(() => null);
        const entry = {
          id: crypto.randomBytes(16).toString('hex'),
          kind: 'mix',
          name: outputName,
          user: 'mix',
          userId: null,
          bitrate: meta.bitrate || 32,
          created: nowMs(),
          bytes: stat ? stat.size : 0,
        };
        await addIndex(entry, this.recordings);
        entries.push(entry);
      } catch (error) {
        console.warn('[voice] could not mix the recording:', error.message || error);
      }
    }
    return entries;
  }

  async compressRecording(recordingId, bitrate = 32) {
    const entry = findIndex(safeRecordingId(recordingId), this.recordings);
    if (!entry) throw new Error('Recording not found.');
    const source = resolveRecordingPath(entry, this.recordings);
    if (!source || !fs.existsSync(source)) throw new Error('The recording file is missing.');
    if (!this.ffmpegBin) throw new Error('ffmpeg is not available, so compression cannot run.');
    const rate = clampBitrate(bitrate);
    let outputName = `${path.parse(source).name}__compressed_${rate}k.ogg`;
    let output = path.join(this.recordings, outputName);
    if (fs.existsSync(output)) {
      outputName = `${path.parse(source).name}__compressed_${rate}k_${crypto.randomBytes(2).toString('hex')}.ogg`;
      output = path.join(this.recordings, outputName);
    }
    await runProcess(this.ffmpegBin, buildCompressCommand(this.ffmpegBin, source, output, rate));
    const stat = await fsp.stat(output).catch(() => null);
    const newEntry = {
      id: crypto.randomBytes(16).toString('hex'),
      kind: 'compressed',
      name: outputName,
      user: entry.user,
      userId: entry.userId,
      bitrate: rate,
      created: nowMs(),
      bytes: stat ? stat.size : 0,
      sourceId: recordingId,
    };
    await addIndex(newEntry, this.recordings);
    return newEntry;
  }

  async deleteRecording(recordingId) {
    const entry = await deleteIndex(safeRecordingId(recordingId), this.recordings);
    if (!entry) throw new Error('Recording not found.');
    const target = resolveRecordingPath(entry, this.recordings);
    if (target && fs.existsSync(target)) {
      try { await fsp.unlink(target); } catch { /* already gone */ }
    }
    return entry;
  }

  listRecordings() {
    return loadIndex(this.recordings).map((entry) => {
      const target = resolveRecordingPath(entry, this.recordings);
      const exists = Boolean(target && fs.existsSync(target));
      let size = Number(entry.bytes || 0);
      if (exists) {
        try { size = fs.statSync(target).size; } catch { /* keep index size */ }
      }
      return { ...entry, exists, size };
    });
  }

  state() {
    const connected = Boolean(
      this.connection && this.connection.state.status === voice?.VoiceConnectionStatus?.Ready
    );
    const channelId = this.connection ? this.connection.joinConfig.channelId : null;
    const guildId = this.connection ? this.connection.joinConfig.guildId : null;
    const channel = channelId && this.client ? this.client.channels.cache.get(channelId) : null;
    const status = this.player ? this.player.state.status : '';
    return {
      ready: Boolean(this.client && this.client.isReady()),
      user: this.client && this.client.user ? this.client.user.tag || this.client.user.username : null,
      connected,
      guildId: connected ? String(guildId) : null,
      channelId: connected ? String(channelId) : null,
      channelName: connected && channel ? channel.name : null,
      playing: status === (voice?.AudioPlayerStatus?.Playing || 'playing'),
      paused: status === (voice?.AudioPlayerStatus?.Paused || 'paused'),
      listening: Boolean(this.recorder),
      dave: connected ? true : null,
      backend: voice ? 'discordjs-voice' : null,
      volume: this.resource && this.resource.volume ? this.resource.volume.volume : (this.current ? this.current.volume : 1),
      current: this.current ? { ...this.current } : null,
      queue: this.queue.map((track) => ({ ...track })),
      recording: {
        active: Boolean(this.recorder),
        mode: (this.recordMeta || {}).mode || null,
        bitrate: (this.recordMeta || {}).bitrate || null,
        startedAt: (this.recordMeta || {}).startedAt || null,
        tracks: this.recorder ? this.recorder.snapshot() : [],
      },
      ffmpeg: ffmpegAvailable(this.ffmpegBin),
      ytdlp: Boolean(this.ytdlpBin),
      recordingCount: loadIndex(this.recordings).length,
    };
  }
}

function formatStamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// HTTP control plane
// ---------------------------------------------------------------------------
const MAX_BODY = 1024 * 1024;

function constantEquals(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isLoopback(address) {
  const text = String(address || '').replace(/^::ffff:/, '');
  return text === '127.0.0.1' || text === '::1' || text === 'localhost';
}

function sendJson(res, status, payload) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': raw.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(raw);
}

function sendError(res, message, status = 400) {
  sendJson(res, status, { ok: false, error: message });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim() || '{}';
      try {
        const data = JSON.parse(raw);
        resolve(data && typeof data === 'object' && !Array.isArray(data) ? data : {});
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function authorised(req, token) {
  if (!token) return isLoopback(req.socket.remoteAddress);
  let supplied = String(req.headers.authorization || '');
  if (supplied.toLowerCase().startsWith('bearer ')) supplied = supplied.slice(7);
  if (!supplied) supplied = String(req.headers['x-voice-token'] || '');
  return constantEquals(supplied, token);
}

function statusForError(error) {
  const message = String((error && error.message) || error || '');
  if (error && error.status) return error.status;
  if (/Join a voice channel first|already running|not ready|unavailable|Voice dependencies|ffmpeg is not available|Timed out while connecting/i.test(message)) {
    return 503;
  }
  return 400;
}

async function handleGet(req, res, manager, token) {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;
  const parts = route.split('/').filter(Boolean);
  if (!parts.length || parts[0] === 'health') {
    const state = manager ? manager.state() : {};
    return sendJson(res, 200, {
      ok: true,
      service: 'kizzey-voice',
      ready: Boolean(state.ready),
      backend: state.backend || null,
      ffmpeg: manager ? Boolean(manager.ffmpegBin && ffmpegAvailable(manager.ffmpegBin)) : false,
      ytdlp: Boolean(manager && manager.ytdlpBin),
      error: voiceLoadError ? String(voiceLoadError.message || voiceLoadError) : '',
    });
  }
  if (!authorised(req, token)) return sendError(res, 'Unauthorized.', 401);
  if (parts[0] === 'state') return sendJson(res, 200, { ok: true, state: manager.state() });
  if (parts[0] === 'recordings' && parts.length === 1) {
    return sendJson(res, 200, { ok: true, recordings: manager.listRecordings() });
  }
  if (parts[0] === 'recordings' && parts.length === 2) {
    let recordingId;
    try {
      recordingId = safeRecordingId(decodeURIComponent(parts[1]));
    } catch (error) {
      return sendError(res, error.message, 400);
    }
    const entry = findIndex(recordingId, manager.recordings);
    if (!entry) return sendError(res, 'Recording not found.', 404);
    const target = resolveRecordingPath(entry, manager.recordings);
    if (!target || !fs.existsSync(target)) return sendError(res, 'Recording file is missing.', 404);
    let stat;
    try { stat = fs.statSync(target); } catch { return sendError(res, 'Recording file is missing.', 404); }
    res.writeHead(200, {
      'Content-Type': 'audio/ogg',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${path.basename(target)}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const stream = fs.createReadStream(target);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return;
  }
  return sendError(res, 'Not found.', 404);
}

async function handlePost(req, res, manager, token) {
  if (!authorised(req, token)) return sendError(res, 'Unauthorized.', 401);
  const route = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
  let data;
  try {
    data = await readJson(req);
  } catch (error) {
    return sendError(res, error.message, 400);
  }
  try {
    if (route === '/join') {
      const state = await manager.join(
        data.guildId ? String(data.guildId) : '',
        String(data.channelId || ''),
        data.token,
        data.userToken === undefined ? true : Boolean(data.userToken)
      );
      return sendJson(res, 200, { ok: true, state });
    }
    if (route === '/leave') {
      return sendJson(res, 200, { ok: true, state: await manager.leave() });
    }
    if (route === '/play') {
      const result = await manager.play(String(data.query || ''), data.volume === undefined ? 1.0 : data.volume);
      return sendJson(res, 200, { ok: true, ...result });
    }
    if (route === '/control') {
      const state = manager.control(String(data.action || ''), data.value);
      return sendJson(res, 200, { ok: true, state });
    }
    if (route === '/record/start') {
      const state = manager.startRecording(
        String(data.mode || 'mix'),
        data.bitrate === undefined ? 32 : data.bitrate,
        data.mix === undefined ? true : Boolean(data.mix)
      );
      return sendJson(res, 200, { ok: true, state });
    }
    if (route === '/record/stop') {
      return sendJson(res, 200, { ok: true, state: await manager.stopRecording() });
    }
    if (route === '/recordings/delete') {
      const entry = await manager.deleteRecording(safeRecordingId(String(data.id || '')));
      return sendJson(res, 200, { ok: true, deleted: entry });
    }
    if (route === '/recordings/compress') {
      const entry = await manager.compressRecording(
        safeRecordingId(String(data.id || '')),
        data.bitrate === undefined ? 32 : data.bitrate
      );
      return sendJson(res, 200, { ok: true, recording: entry });
    }
    return sendError(res, 'Not found.', 404);
  } catch (error) {
    const status = statusForError(error);
    if (status >= 500) console.error('[voice] request failed:', error.message || error);
    return sendError(res, String(error.message || error || 'Voice service error.'), status);
  }
}

function buildServer(manager, host, port, token) {
  const server = http.createServer((req, res) => {
    const method = req.method || 'GET';
    if (method === 'GET') {
      handleGet(req, res, manager, token).catch((error) => {
        console.error('[voice] GET failed:', error.message || error);
        if (!res.headersSent) sendError(res, 'Voice service error.', 500);
      });
      return;
    }
    if (method === 'POST') {
      handlePost(req, res, manager, token).catch((error) => {
        console.error('[voice] POST failed:', error.message || error);
        if (!res.headersSent) sendError(res, 'Voice service error.', 500);
      });
      return;
    }
    sendError(res, 'Method not allowed.', 405);
  });
  server.keepAliveTimeout = 65000;
  server.listen(port, host);
  return server;
}

function parseArgs(argv) {
  const args = {
    host: process.env.VOICE_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.VOICE_PORT || '8421', 10),
    token: process.env.VOICE_TOKEN || '',
    discordToken: process.env.DISCORD_TOKEN || '',
    userToken: String(process.env.VOICE_USER_TOKEN || '1').toLowerCase() !== '0',
    ffmpeg: process.env.VOICE_FFMPEG || '',
    ytdlp: process.env.VOICE_YTDLP || '',
    recordings: process.env.VOICE_RECORDINGS_DIR || '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === '--host') args.host = next();
    else if (arg === '--port') args.port = Number.parseInt(next(), 10);
    else if (arg === '--token') args.token = next();
    else if (arg === '--discord-token') args.discordToken = next();
    else if (arg === '--user-token') args.userToken = true;
    else if (arg === '--bot-token') args.userToken = false;
    else if (arg === '--ffmpeg') args.ffmpeg = next();
    else if (arg === '--ytdlp') args.ytdlp = next();
    else if (arg === '--recordings') args.recordings = next();
    else if (arg === '--log-level') next();
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node voice_service/index.js [--host H] [--port P] [--token T] [--discord-token T]');
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!Number.isFinite(args.port) || args.port <= 0) args.port = 8421;
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const directory = path.resolve(args.recordings || path.join(APP_DIR, 'data', 'voice_recordings'));
  fs.mkdirSync(directory, { recursive: true });

  const manager = new VoiceManager({
    defaultToken: args.discordToken,
    ffmpegBin: args.ffmpeg,
    ytdlpBin: args.ytdlp,
    recordings: directory,
    userToken: args.userToken,
  });

  if (!args.token && !['127.0.0.1', '::1', 'localhost'].includes(args.host)) {
    console.warn('[voice] VOICE_TOKEN is not set and the service is not bound to loopback; non-local requests will be rejected.');
  }
  if (!ffmpegAvailable(manager.ffmpegBin)) {
    console.warn('[voice] ffmpeg was not found; playback and recording will fail.');
  }
  if (!loadVoiceStack()) {
    console.warn(`[voice] Discord voice stack not available: ${voiceLoadError?.message || 'unknown error'}`);
  }

  if (args.discordToken) {
    manager.ensureClient().catch((error) => {
      console.warn('[voice] could not connect to Discord at startup:', error.message || error);
    });
  }

  const server = buildServer(manager, args.host, args.port, args.token);
  server.on('error', (error) => {
    console.error('[voice] server error:', error.message || error);
    process.exit(1);
  });
  console.log(`[voice] Kizzey voice service listening on http://${args.host}:${args.port}`);
  console.log(`[voice] receive backend: ${voice ? 'discordjs-voice (DAVE)' : 'unavailable'}`);

  const shutdown = async () => {
    console.log('[voice] shutting down');
    server.close();
    try { await manager.closeClient(); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[voice] fatal:', error.message || error);
    process.exit(1);
  });
}

module.exports = {
  VoiceManager,
  Recorder,
  clampBitrate,
  sanitizeLabel,
  safeRecordingId,
  cleanToken,
  resolveSource,
  resolveFfmpeg,
  buildRecorderCommand,
  buildMixCommand,
  buildCompressCommand,
  loadIndex,
  addIndex,
  findIndex,
  deleteIndex,
  resolveRecordingPath,
  buildServer,
  parseArgs,
};
