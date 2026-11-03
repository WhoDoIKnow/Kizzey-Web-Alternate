'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const rt = require('./runtime');
const {
  DISCORD_API,
  DISCORD_UA,
  KIZZY_IMAGE_API,
  KIZZEY_RELEASES_API,
  KIZZEY_REPO,
  DATA_DIR,
  UPLOAD_DIR,
  VERSION,
} = require('./constants');
const { HOST_DEVICE } = require('./defaults');
const { nowMs, mono, clamp, cleanDiscordToken } = require('./util');

class DiscordError extends Error {
  constructor(status, message, data = null) {
    super(message);
    this.status = status;
    this.message = message;
    this.data = data || {};
  }
}

function superProperties() {
  const props = {
    os: 'Android',
    browser: 'Discord Android',
    device: HOST_DEVICE.model || 'Android',
    system_locale: 'en-US',
    client_version: '267.0',
    release_channel: 'googleRelease',
    os_version: HOST_DEVICE.android || '14',
    client_build_number: 267206,
  };
  return Buffer.from(JSON.stringify(props)).toString('base64');
}

function discordHeaders(token = '', extra = null) {
  const headers = {
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': DISCORD_UA,
    'X-Super-Properties': superProperties(),
    'X-Discord-Locale': 'en-US',
    'X-Discord-Timezone': 'Europe/London',
  };
  if (token) headers.Authorization = token;
  if (extra) Object.assign(headers, extra);
  return headers;
}

async function discordApi(apiPath, token, method = 'GET', body = null, timeout = 20) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const headers = discordHeaders(token);
    let payload;
    if (body !== null && body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(DISCORD_API + apiPath, {
      method,
      headers,
      body: payload,
      signal: controller.signal,
    });
    const raw = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      let info = {};
      try {
        info = JSON.parse(raw.toString('utf8'));
      } catch {
        info = { message: raw.toString('utf8').slice(0, 300) };
      }
      throw new DiscordError(
        response.status,
        info.message || `Discord returned HTTP ${response.status}`,
        info
      );
    }
    if (!raw.length) return null;
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return raw.toString('utf8');
    }
  } catch (error) {
    if (error instanceof DiscordError) throw error;
    if (error && error.name === 'AbortError') {
      throw new DiscordError(0, 'Discord took too long to answer.');
    }
    throw new DiscordError(0, `Could not reach Discord: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function validateToken(token) {
  const me = await discordApi('/users/@me', token);
  if (!me || typeof me !== 'object' || !('id' in me)) {
    throw new DiscordError(401, 'Discord did not return an account.');
  }
  return normalizeUser(me);
}

function normalizeUser(user) {
  const uid = String(user.id || '');
  const avatarHash = user.avatar || '';
  const animated = avatarHash.startsWith('a_');
  let avatarUrl;
  if (avatarHash) {
    avatarUrl = `https://cdn.discordapp.com/avatars/${uid}/${avatarHash}.${animated ? 'gif' : 'png'}?size=128`;
  } else {
    let index = 0;
    try {
      index = Number(BigInt(uid) >> 22n) % 6;
    } catch {
      index = 0;
    }
    avatarUrl = `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  }
  return {
    id: uid,
    username: user.username || '',
    globalName: user.global_name || '',
    displayName: user.global_name || user.username || 'friend',
    discriminator: user.discriminator || '0',
    avatar: avatarHash,
    avatarUrl,
    banner: user.banner,
    accent: user.accent_color,
    premium: Boolean(user.premium_type),
    verified: Boolean(user.verified),
    email: '',
  };
}

function normalizeRelationship(item) {
  const user = normalizeUser(item.user || {});
  return {
    id: user.id,
    user,
    type: item.type,
    nickname: item.nickname || '',
    since: item.since,
  };
}

// -- images ----------------------------------------------------------------
const IMAGE_CACHE = new Map();

async function imageApiGet(url) {
  const endpoint = `${KIZZY_IMAGE_API}/image?url=${encodeURIComponent(url)}`;
  try {
    const response = await fetch(endpoint, {
      headers: {
        'User-Agent': 'Kizzey-Web/1.0 (+https://codeberg.org/UnpackedX/Kizzey)',
        Accept: 'application/json',
      },
    });
    const raw = (await response.text()).trim();
    try {
      const data = JSON.parse(raw);
      let asset = data && typeof data === 'object' ? data.id : null;
      if (!asset && data && typeof data === 'object') {
        asset = data.mp;
        if (asset && !String(asset).startsWith('mp:')) asset = 'mp:' + String(asset);
      }
      return asset ? String(asset) : null;
    } catch {
      if (raw.startsWith('mp:')) return raw;
    }
  } catch (error) {
    if (rt.STORE) rt.STORE.log('WARN', 'Images', `Could not resolve image: ${error.message}`);
  }
  return null;
}

async function uploadImageBytes(data, filename) {
  let ext = path.extname(filename || '').slice(1).toLowerCase() || 'jpg';
  if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) ext = 'jpg';
  const boundary = '----KizzeyWeb' + crypto.randomBytes(8).toString('hex');
  const mime = `image/${ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="temp"; filename="temp_file.${ext}"\r\n`),
    Buffer.from(`Content-Type: ${mime}\r\n\r\n`),
    Buffer.from(data),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  try {
    const response = await fetch(KIZZY_IMAGE_API + '/upload', {
      method: 'POST',
      headers: {
        'User-Agent': 'Kizzey-Web/1.0',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Accept: 'application/json',
      },
      body,
    });
    const raw = (await response.text()).trim();
    try {
      const parsed = JSON.parse(raw);
      let asset = parsed && typeof parsed === 'object' ? parsed.id : null;
      if (asset && !String(asset).startsWith('mp:')) asset = 'mp:' + String(asset);
      return asset ? String(asset) : null;
    } catch {
      return raw.startsWith('mp:') ? raw : null;
    }
  } catch (error) {
    if (rt.STORE) rt.STORE.log('WARN', 'Images', `Image upload failed: ${error.message}`);
    return null;
  }
}

async function resolveImageAsset(value) {
  if (!value) return null;
  value = String(value).trim();
  if (value.startsWith('mp:')) return value;
  if (value.startsWith('external/') || value.startsWith('attachments/')) return 'mp:' + value;
  if (IMAGE_CACHE.has(value)) return IMAGE_CACHE.get(value);
  let asset = null;
  if (value.startsWith('http://') || value.startsWith('https://')) {
    asset = await imageApiGet(value);
  } else if (value.startsWith('/uploads/')) {
    const local = path.join(UPLOAD_DIR, path.basename(value));
    try {
      const stat = fs.statSync(local);
      if (stat.isFile() && stat.size <= 12 * 1024 * 1024) {
        asset = await uploadImageBytes(fs.readFileSync(local), local);
      }
    } catch {
      // missing upload
    }
  }
  if (asset) {
    IMAGE_CACHE.set(value, asset);
    if (IMAGE_CACHE.size > 400) {
      for (const key of [...IMAGE_CACHE.keys()].slice(0, 80)) IMAGE_CACHE.delete(key);
    }
  }
  return asset;
}

// -- weather / geocode -----------------------------------------------------
const WEATHER_CACHE = new Map();
const WEATHER_CODES = {
  0: ['Clear sky', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Icy fog', '🌫️'], 51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'],
  55: ['Heavy drizzle', '🌧️'], 56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'], 66: ['Freezing rain', '🌧️'],
  67: ['Freezing rain', '🌧️'], 71: ['Light snow', '🌨️'], 73: ['Snow', '❄️'], 75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨️'], 80: ['Rain showers', '🌦️'], 81: ['Rain showers', '🌧️'],
  82: ['Heavy showers', '⛈️'], 85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunder and hail', '⛈️'], 99: ['Thunder and hail', '⛈️'],
};

async function httpJson(url, timeout = 15, headers = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const response = await fetch(url, {
      headers: headers || { 'User-Agent': 'Kizzey-Web/1.0', Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function weatherDescription(code) {
  return WEATHER_CODES[Number(code || 0)] || ['Weather', '🌡️'];
}

async function fetchWeather(lat, lon, unit = 'c') {
  const key = `${Number(lat).toFixed(2)}:${Number(lon).toFixed(2)}`;
  const cached = WEATHER_CACHE.get(key);
  if (cached && Date.now() / 1000 - cached[0] < 600) return cached[1];
  const tempUnit = unit === 'f' ? 'fahrenheit' : 'celsius';
  const url =
    'https://api.open-meteo.com/v1/forecast?' +
    `latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,' +
    'precipitation,weather_code,wind_speed_10m,wind_direction_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,' +
    'precipitation_probability_max&timezone=auto&forecast_days=7' +
    `&temperature_unit=${tempUnit}&wind_speed_unit=kmh`;
  const data = await httpJson(url, 18);
  const current = data.current || {};
  const daily = data.daily || {};
  const [desc, emoji] = weatherDescription(current.weather_code || 0);
  const dailyItems = [];
  for (let i = 0; i < (daily.time || []).length; i += 1) {
    const [ddesc, demoji] = weatherDescription((daily.weather_code || [0])[i] || 0);
    dailyItems.push({
      date: daily.time[i],
      code: (daily.weather_code || [0])[i] || 0,
      desc: ddesc,
      emoji: demoji,
      max: (daily.temperature_2m_max || [null])[i] ?? null,
      min: (daily.temperature_2m_min || [null])[i] ?? null,
      rain: (daily.precipitation_probability_max || [null])[i] ?? null,
    });
  }
  const result = {
    lat, lon, unit,
    temp: current.temperature_2m,
    feels: current.apparent_temperature,
    humidity: current.relative_humidity_2m,
    wind: current.wind_speed_10m,
    windDir: current.wind_direction_10m,
    precip: current.precipitation,
    code: current.weather_code,
    desc, emoji,
    isDay: Boolean(current.is_day ?? 1),
    timezone: data.timezone,
    daily: dailyItems,
    updatedAt: nowMs(),
  };
  if (WEATHER_CACHE.size > 80) WEATHER_CACHE.clear();
  WEATHER_CACHE.set(key, [Date.now() / 1000, result]);
  return result;
}

async function geocode(query) {
  if (!String(query || '').trim()) return [];
  const url =
    'https://geocoding-api.open-meteo.com/v1/search?' +
    `name=${encodeURIComponent(query)}&count=8&language=en&format=json`;
  const data = await httpJson(url, 15);
  return (data.results || []).map((row) => ({
    name: row.name,
    admin: row.admin1,
    country: row.country,
    countryCode: row.country_code,
    lat: row.latitude,
    lon: row.longitude,
    timezone: row.timezone,
  }));
}

function offlineMode() {
  const store = rt.STORE;
  return Boolean(store && store.state.settings && store.state.settings.offlineMode);
}

async function updateFeed() {
  if (offlineMode()) {
    return {
      tag: VERSION,
      name: `Kizzey ${VERSION}`,
      body: 'Offline mode is on. External update checks are paused; Discord RPC and the local gateway keep running.',
      url: KIZZEY_REPO + '/releases',
      assets: [],
      publishedAt: null,
      source: 'offline',
      live: false,
    };
  }
  try {
    const data = await httpJson(KIZZEY_RELEASES_API, 15, {
      'User-Agent': 'Kizzey-Web/1.0',
      Accept: 'application/json',
    });
    return {
      tag: data.tag_name || VERSION,
      name: data.name || data.tag_name || `Kizzey ${VERSION}`,
      body: data.body || '',
      url: data.html_url || KIZZEY_REPO + '/releases/latest',
      assets: (data.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
      publishedAt: data.published_at,
      source: 'codeberg',
      live: true,
    };
  } catch (error) {
    return {
      tag: VERSION,
      name: `Kizzey ${VERSION}`,
      body:
        'Everything from the 8.4.3 betas, a remastered Kizzey Chat, live lyrics, ' +
        'Health RPC, weather, stories and a calmer Home.',
      url: KIZZEY_REPO + '/releases',
      assets: [],
      publishedAt: null,
      source: 'bundled',
      live: false,
      error: error.message,
    };
  }
}

// -- host stats ------------------------------------------------------------
const HOST_STATS_PREV = { cpu: null, time: 0 };

function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return fallback;
  }
}

function hostStats() {
  let load = [0, 0, 0];
  try {
    load = os.loadavg();
  } catch {
    // ignore
  }
  let cpu = null;
  try {
    const parts = readText('/proc/stat').split('\n')[0].split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    const prev = HOST_STATS_PREV.cpu;
    const prevTime = HOST_STATS_PREV.time;
    if (prev && mono() - prevTime > 0.8) {
      const dTotal = total - prev[0];
      const dIdle = idle - prev[1];
      cpu = dTotal > 0 ? clamp(100 * (1 - dIdle / dTotal), 0, 100) : null;
    }
    HOST_STATS_PREV.cpu = [total, idle];
    HOST_STATS_PREV.time = mono();
  } catch {
    // ignore
  }
  let memTotal = os.totalmem ? os.totalmem() : 0;
  let memAvail = os.freemem ? os.freemem() : 0;
  try {
    for (const line of readText('/proc/meminfo').split('\n')) {
      if (line.startsWith('MemTotal:')) memTotal = Number(line.split(/\s+/)[1]) * 1024;
      else if (line.startsWith('MemAvailable:')) memAvail = Number(line.split(/\s+/)[1]) * 1024;
    }
  } catch {
    // ignore
  }
  let uptime = 0;
  try {
    uptime = Number(readText('/proc/uptime').split(/\s+/)[0]) || 0;
  } catch {
    uptime = os.uptime ? os.uptime() : 0;
  }
  const battery = HOST_DEVICE.battery;
  let charging = null;
  for (const file of ['/sys/class/power_supply/battery/status', '/sys/class/power_supply/bms/status']) {
    const status = readText(file);
    if (status) {
      charging = ['charging', 'full'].includes(status.toLowerCase());
      break;
    }
  }
  let disk = {};
  try {
    const stat = fs.statfsSync(DATA_DIR);
    const total = stat.blocks * stat.bsize;
    const free = stat.bfree * stat.bsize;
    disk = { total, free, used: total - free };
  } catch {
    disk = {};
  }
  const sessions = rt.STORE ? rt.STORE.subscribers.size : 0;
  return {
    cpu: cpu === null ? null : Math.round(cpu * 10) / 10,
    load: load.map((n) => Math.round(n * 100) / 100),
    memory: { total: memTotal, available: memAvail, used: Math.max(0, memTotal - memAvail) },
    uptime: Math.trunc(uptime),
    battery,
    charging,
    disk,
    sessions,
    device: HOST_DEVICE,
    serverTime: nowMs(),
  };
}

module.exports = {
  DiscordError,
  superProperties,
  discordHeaders,
  discordApi,
  validateToken,
  normalizeUser,
  normalizeRelationship,
  imageApiGet,
  uploadImageBytes,
  resolveImageAsset,
  httpJson,
  weatherDescription,
  fetchWeather,
  geocode,
  offlineMode,
  updateFeed,
  hostStats,
  cleanDiscordToken,
};