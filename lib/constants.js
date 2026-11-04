'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const APP_DIR = path.resolve(__dirname, '..');
const STATIC_DIR = path.join(APP_DIR, 'static');
const DATA_DIR = path.join(APP_DIR, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const LOG_FILE = path.join(DATA_DIR, 'kizzey.log');
// Stable browser identity for the password flow: the fingerprint and
// installation id Discord hands out, plus its device cookies. The real web
// client sends these on every call, including the two-factor one.
const LOGIN_CLIENT_FILE = path.join(DATA_DIR, 'login-client.json');

for (const directory of [DATA_DIR, UPLOAD_DIR, TMP_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

const VERSION = '8.4.4';
const DEFAULT_PORT = 8420;
const DEFAULT_APP_ID = '962990036020756480';
const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_UA = 'Discord-Android/267206;RNA';
const KIZZY_IMAGE_API = 'https://kizzy-api.cjjdxhdjd.workers.dev';
const KIZZEY_RELEASES_API = 'https://codeberg.org/api/v1/repos/UnpackedX/Kizzey/releases/latest';
const KIZZEY_REPO = 'https://codeberg.org/UnpackedX/Kizzey';

const MAX_BODY = 64 * 1024 * 1024;
const MAX_CHAT = 250;
const ACCOUNT_LIMIT = 8;
const MIRROR_RULE_LIMIT = 20;
const MIRROR_SEEN_LIMIT = 180;
const MIRROR_MARK = '\u2063';
const MIRROR_DEFAULT_INTERVAL = 12;
const MIRROR_MAX_MESSAGES = 30;
const MIRROR_MODES = ['normal', 'webhook'];
const SERVER_STARTED = Date.now();

const VOICE_SERVICE_URL = String(process.env.KIZZEY_VOICE_URL || 'http://127.0.0.1:8421').trim().replace(/\/+$/, '');
const VOICE_SERVICE_TOKEN = String(process.env.KIZZEY_VOICE_TOKEN || '').trim();
const VOICE_SERVICE_TIMEOUT = Number(process.env.KIZZEY_VOICE_TIMEOUT || 30) || 30;
const VOICE_RECORDING_RE = /^[A-Za-z0-9_.-]{1,160}$/;
const VOICE_RECORDING_MIME = 'audio/ogg';

const DISCORD_LOGIN_API = 'https://discord.com/api/v9/auth/login';
const DISCORD_MFA_API = 'https://discord.com/api/v9/auth/mfa/totp';
const DISCORD_MFA_BACKUP_API = 'https://discord.com/api/v9/auth/mfa/backup';
const DISCORD_MFA_SMS_API = 'https://discord.com/api/v9/auth/mfa/sms';
const DISCORD_EXPERIMENTS_API = 'https://discord.com/api/v9/experiments?with_guild_experiments=true';
const DISCORD_LOGIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const DISCORD_CHROME_MAJOR = '146';
const DISCORD_CLIENT_VERSION = '146.0.0.0';
const DISCORD_CLIENT_BUILD = 661871;

const MIME_OVERRIDES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const PRESENCE_KINDS = {
  custom: 'Custom RPC',
  apps: 'App Detection',
  media: 'Media RPC',
  console: 'Console RPC',
  experimental: 'Experimental RPC',
  multiple: 'Multiple RPC',
  cycling: 'RPC Cycling',
  samsung: 'Samsung RPC',
  emulation: 'Emulation RPC',
  health: 'Health RPC',
  location: 'Location RPC',
  weather: 'Weather RPC',
  navigation: 'Navigation',
  android_auto: 'Android Auto',
  screen_read: 'Screen Read',
};

module.exports = {
  APP_DIR,
  STATIC_DIR,
  DATA_DIR,
  UPLOAD_DIR,
  TMP_DIR,
  STATE_FILE,
  SECRET_FILE,
  CHAT_FILE,
  HISTORY_FILE,
  LOG_FILE,
  LOGIN_CLIENT_FILE,
  VERSION,
  DEFAULT_PORT,
  DEFAULT_APP_ID,
  DISCORD_API,
  DISCORD_UA,
  KIZZY_IMAGE_API,
  KIZZEY_RELEASES_API,
  KIZZEY_REPO,
  MAX_BODY,
  MAX_CHAT,
  ACCOUNT_LIMIT,
  MIRROR_RULE_LIMIT,
  MIRROR_SEEN_LIMIT,
  MIRROR_MARK,
  MIRROR_DEFAULT_INTERVAL,
  MIRROR_MAX_MESSAGES,
  MIRROR_MODES,
  SERVER_STARTED,
  VOICE_SERVICE_URL,
  VOICE_SERVICE_TOKEN,
  VOICE_SERVICE_TIMEOUT,
  VOICE_RECORDING_RE,
  VOICE_RECORDING_MIME,
  DISCORD_LOGIN_API,
  DISCORD_MFA_API,
  DISCORD_MFA_BACKUP_API,
  DISCORD_MFA_SMS_API,
  DISCORD_EXPERIMENTS_API,
  DISCORD_LOGIN_UA,
  DISCORD_CHROME_MAJOR,
  DISCORD_CLIENT_VERSION,
  DISCORD_CLIENT_BUILD,
  MIME_OVERRIDES,
  PRESENCE_KINDS,
  HOSTNAME: os.hostname(),
};