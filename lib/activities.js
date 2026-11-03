'use strict';

// Port of the presence builders from server.py (4903-5478). Image resolution is
// asynchronous in Node, so the builders that resolve art return promises.

const { DEFAULT_APP_ID, PRESENCE_KINDS } = require('./constants');
const { nowMs, safeInt, parseTimestamp, sanitizeText, deepClone } = require('./util');
const { resolveImageAsset } = require('./discord');
const rt = require('./runtime');

function normalizeStatus(value) {
  value = String(value || 'online').toLowerCase();
  if (value === 'offline') return 'invisible';
  return ['online', 'idle', 'dnd', 'invisible'].includes(value) ? value : 'online';
}

function timeGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function featureState(state, kind) {
  const map = {
    custom: 'custom',
    apps: 'apps',
    media: 'media',
    console: 'console',
    experimental: 'experimental',
    cycling: 'cycling',
    multiple: 'multiple',
    samsung: 'samsung',
    emulation: 'emulation',
    health: 'health',
    location: 'location',
    weather: 'weather',
    navigation: 'navigation',
    android_auto: 'androidAuto',
    screen_read: 'screenRead',
  };
  const key = map[kind];
  return key ? state[key] || {} : {};
}

function templateValues(state) {
  const track = (state.media || {}).track || {};
  const weather = state.weather || {};
  const health = state.health || {};
  const location = state.location || {};
  const account = state.account || {};
  const screen = (state.screenRead || {}).lastFields || {};
  const nav = state.navigation || {};
  const now = new Date();
  const chatProfile = state.chatProfile || {};
  const values = {
    user: account.displayName || chatProfile.name || 'friend',
    username: account.username || chatProfile.name || 'friend',
    name: account.displayName || chatProfile.name || '',
    media_title: track.title || '',
    media_artist: track.artist || '',
    media_album: track.album || '',
    song: track.title || '',
    artist: track.artist || '',
    app_name:
      (state.apps || {}).selected && typeof (state.apps || {}).selected === 'object'
        ? (state.apps || {}).selected.title || ''
        : '',
    weather: weather.lastText || (state.weather || {}).place || '',
    weather_temp: '',
    weather_feels: '',
    weather_desc: '',
    weather_emoji: '',
    place: location.place || weather.place || '',
    steps: health.steps || 0,
    heart_rate: health.heart || 0,
    heart: health.heart || 0,
    sleep: health.sleep || 0,
    stress: health.stress || 0,
    screen_name: screen.screen_name || '',
    screen_score: screen.screen_score || '',
    nav_destination: nav.destination || '',
    nav_eta: nav.durationText || '',
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    date: now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }),
    date_full: now.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    }),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
  };
  const last = (state.weather || {}).last || {};
  if (last && Object.keys(last).length) {
    const unit = String((state.weather || {}).unit || 'c').toUpperCase();
    const temp = last.temp;
    const feels = last.feels;
    values.weather_temp = temp !== undefined && temp !== null ? `${temp}°${unit}` : '';
    values.weather_feels = feels !== undefined && feels !== null ? `${feels}°${unit}` : '';
    values.weather_desc = last.desc || '';
    values.weather_emoji = last.emoji || '';
    values.weather = last.desc || values.weather;
  }
  return values;
}

function expandTemplate(text, state) {
  if (!text) return '';
  const values = templateValues(state);
  return String(text).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const value = values[key.trim()];
    return value === undefined || value === null ? '' : String(value);
  });
}

async function buildCustomActivity(state, cfg = null) {
  const custom = cfg && typeof cfg === 'object' ? cfg : state.custom || {};
  const name = sanitizeText(expandTemplate(custom.name, state), 128);
  let details = sanitizeText(expandTemplate(custom.details, state), 128);
  let stateLine = sanitizeText(expandTemplate(custom.state, state), 128);
  if (!name) throw new Error('Activity name is required. Discord drops a card with no name.');
  if (details && details.length < 2) details = null;
  if (stateLine && stateLine.length < 2) stateLine = null;
  let typeValue = safeInt(custom.type, 0);
  if (![0, 1, 2, 3, 5].includes(typeValue)) typeValue = 0;
  const start = parseTimestamp(custom.timestampsStart);
  const end = parseTimestamp(custom.timestampsStop);
  let timestamps = null;
  if (start || end) {
    timestamps = {};
    if (start) timestamps.start = start;
    if (end) timestamps.end = end;
  }
  const large = custom.largeImg || custom.largeUrl || '';
  const small = custom.smallImg || custom.smallUrl || '';
  const largeAsset = large ? await resolveImageAsset(large) : null;
  const smallAsset = small ? await resolveImageAsset(small) : null;
  let assets = null;
  if (largeAsset || smallAsset) {
    assets = {};
    if (largeAsset) assets.large_image = largeAsset;
    if (smallAsset) assets.small_image = smallAsset;
    const largeText = sanitizeText(expandTemplate(custom.largeText, state), 128);
    const smallText = sanitizeText(expandTemplate(custom.smallText, state), 128);
    if (largeText) assets.large_text = largeText;
    if (smallText) assets.small_text = smallText;
  }
  let party = null;
  const current = safeInt(custom.partyCurrentSize);
  const maximum = safeInt(custom.partyMaxSize);
  if (current && maximum && current > 0 && maximum >= current) {
    party = { id: 'kizzey', size: [current, maximum] };
  }
  const buttons = [];
  const buttonUrls = [];
  for (const [labelKey, urlKey] of [
    ['button1', 'button1link'],
    ['button2', 'button2link'],
  ]) {
    const label = sanitizeText(custom[labelKey], 32);
    const url = String(custom[urlKey] || '').trim();
    if (label && (url.startsWith('http://') || url.startsWith('https://'))) {
      buttons.push(label);
      buttonUrls.push(url.slice(0, 256));
    }
  }
  const appId = String(custom.applicationId || '').trim();
  if (appId && !/^\d{18,19}$/.test(appId)) {
    throw new Error("Application ID must be 18 or 19 digits, or blank for Kizzey's default app.");
  }
  const activity = {
    name,
    details,
    state: stateLine,
    type: typeValue,
    application_id: appId || DEFAULT_APP_ID,
  };
  if (timestamps) activity.timestamps = timestamps;
  if (assets) activity.assets = assets;
  if (party) activity.party = party;
  if (buttons.length) {
    activity.buttons = buttons.slice(0, 2);
    activity.metadata = { button_urls: buttonUrls.slice(0, 2) };
  }
  const platform = String(custom.platform || '').trim();
  if (platform) activity.platform = platform.slice(0, 32);
  const statusDisplay = safeInt(custom.statusDisplayType, -1);
  if ([0, 1, 2].includes(statusDisplay)) activity.status_display_type = statusDisplay;
  const stream = String(custom.url || '').trim();
  if (typeValue === 1 && (stream.startsWith('http://') || stream.startsWith('https://'))) {
    activity.url = stream.slice(0, 256);
  }
  if (typeValue === 1 && !activity.url) {
    throw new Error('Streaming requires a Twitch or YouTube URL.');
  }
  activity.created_at = nowMs();
  return Object.fromEntries(Object.entries(activity).filter(([, v]) => v !== null && v !== undefined));
}

function buildAppsActivity(state) {
  const app = (state.apps || {}).selected;
  if (!app || typeof app !== 'object' || !app.title) {
    throw new Error('Pick an app to share first.');
  }
  const title = sanitizeText(app.presenceName || app.title, 128);
  let typeValue = safeInt(app.type, 0);
  if (![0, 1, 2, 3, 5].includes(typeValue)) typeValue = 0;
  return {
    name: title,
    details: sanitizeText(app.details || app.title, 128),
    state: sanitizeText(app.state || 'Using App Detection', 128),
    type: typeValue,
    application_id: String(app.applicationId || DEFAULT_APP_ID),
    assets: app.iconAsset ? { large_image: app.iconAsset } : null,
    timestamps: { start: nowMs() },
    platform: 'android',
    created_at: nowMs(),
  };
}

async function buildMediaActivity(state) {
  const media = state.media || {};
  const track = media.track || {};
  const title = sanitizeText(track.title, 128);
  const artist = sanitizeText(track.artist, 128);
  const album = sanitizeText(track.album, 128);
  if (!title) throw new Error('Set a track title in Media RPC first.');
  const activity = {
    name: title,
    details: artist,
    state: album,
    type: safeInt(media.type, 2),
    application_id: DEFAULT_APP_ID,
    created_at: nowMs(),
    status_display_type: 0,
  };
  const typeValue = safeInt(activity.type, 2);
  activity.type = [0, 1, 2, 3, 5].includes(typeValue) ? typeValue : 2;
  if (media.showProgress) {
    const duration = safeInt(track.duration, 0) || 0;
    const position = safeInt(track.position, 0) || 0;
    const start = nowMs() - Math.max(0, position) * 1000;
    const timestamps = { start };
    if (duration > position && position > 0) timestamps.end = start + duration * 1000;
    activity.timestamps = timestamps;
  }
  const art = await resolveImageAsset(track.art || '');
  if (art) {
    activity.assets = {
      large_image: art,
      large_text: sanitizeText(track.album || title, 128) || title,
    };
  }
  return Object.fromEntries(Object.entries(activity).filter(([, v]) => v !== null && v !== undefined && v !== ''));
}

const CONSOLE_DEVICES = {
  'PlayStation 5': ['ps5', 'PlayStation 5'],
  'PlayStation 4': ['ps4', 'PlayStation 4'],
  'Xbox Series X|S': ['xbox', 'Xbox Series X|S'],
  'Xbox One': ['xbox', 'Xbox One'],
  'Nintendo Switch': ['nintendo', 'Nintendo Switch'],
  'Steam Deck': ['desktop', 'Steam Deck'],
  'Samsung Galaxy': ['samsung', 'Samsung Galaxy'],
};

async function buildConsoleActivity(state) {
  const console = state.console || {};
  const selected = console.selected && typeof console.selected === 'object' ? console.selected : {};
  const game = sanitizeText(console.game || selected.title, 128);
  if (!game) throw new Error('Choose a console game first.');
  const device = console.device || 'PlayStation 5';
  const [platform, pretty] = CONSOLE_DEVICES[device] || ['desktop', device];
  const art = selected && typeof selected === 'object' ? selected.art || '' : '';
  const assets = art ? { large_image: await resolveImageAsset(art) } : null;
  return {
    name: game,
    details: `Playing on ${pretty}`,
    state: sanitizeText(console.tidbit || 'Console RPC', 128),
    type: 0,
    platform,
    application_id: DEFAULT_APP_ID,
    assets,
    supported_platforms: [platform],
    timestamps: { start: nowMs() },
    created_at: nowMs(),
  };
}

function buildHealthActivity(state) {
  const health = state.health || {};
  const shown = health.show || [];
  const parts = [];
  if (shown.includes('steps')) parts.push(`${Number(health.steps || 0).toLocaleString('en-US')} steps`);
  if (shown.includes('heart')) parts.push(`${health.heart || 0} bpm`);
  if (shown.includes('sleep')) parts.push(`${health.sleep || 0}h sleep`);
  if (shown.includes('stress')) parts.push(`${health.stress || 0}% stress`);
  return {
    name: 'Health',
    details: parts.join(' · ').slice(0, 128) || 'Daily health',
    state: sanitizeText(health.label || 'Taking care of myself', 128),
    type: 2,
    application_id: DEFAULT_APP_ID,
    timestamps: { start: nowMs() },
    created_at: nowMs(),
    status_display_type: 2,
  };
}

function buildLocationActivity(state) {
  const loc = state.location || {};
  const place = loc.place || 'somewhere';
  return {
    name: 'Location',
    details:
      sanitizeText(expandTemplate(loc.template || 'In {{place}}', state), 128) || `In ${place}`,
    state: 'Using Location RPC',
    type: 3,
    application_id: DEFAULT_APP_ID,
    timestamps: { start: nowMs() },
    created_at: nowMs(),
    status_display_type: 0,
  };
}

function buildWeatherActivity(state) {
  const weather = state.weather || {};
  const last = weather.last || {};
  if (!last || !Object.keys(last).length) {
    throw new Error('Look up a city or refresh the weather first.');
  }
  const unit = String(weather.unit || 'c').toUpperCase();
  const temp = last.temp;
  const feels = last.feels;
  const desc = last.desc || 'Weather';
  const emoji = last.emoji || '';
  const values = {
    place: weather.place || '',
    temp: temp !== undefined && temp !== null ? `${temp}°${unit}` : '',
    feels: feels !== undefined && feels !== null ? `${feels}°${unit}` : '',
    desc,
    emoji,
  };
  const fmt = (template, fallback) => {
    let out = template || '';
    for (const [key, value] of Object.entries(values)) {
      out = out.split(`{{weather_${key}}}`).join(String(value));
    }
    return sanitizeText(out, 128) || fallback;
  };
  return {
    name: fmt(expandTemplate(weather.template || 'Weather', state), desc),
    details: values.feels
      ? fmt(expandTemplate(weather.details || '', state), `Feels like ${values.feels}`)
      : desc,
    state: sanitizeText(weather.place, 128),
    type: 3,
    application_id: DEFAULT_APP_ID,
    timestamps: { start: nowMs() },
    created_at: nowMs(),
  };
}

function buildNavigationActivity(state) {
  const nav = state.navigation || {};
  const destination = sanitizeText(nav.destination, 128);
  if (!destination) throw new Error('Set a destination in Navigation first.');
  const eta = nav.durationText || '';
  const distance = nav.distanceText || '';
  return {
    name: 'Navigation',
    details: sanitizeText(`Driving to ${destination}`, 128),
    state: sanitizeText([eta, distance].filter(Boolean).join(' · ') || 'On the way', 128),
    type: 3,
    application_id: DEFAULT_APP_ID,
    timestamps: { start: nowMs() },
    created_at: nowMs(),
  };
}

function buildAndroidAutoActivity(state) {
  const auto = state.androidAuto || {};
  return {
    name: sanitizeText(auto.template || 'On the road', 128),
    details: sanitizeText(auto.details || 'Android Auto', 128),
    state: 'Android Auto',
    type: 3,
    platform: 'android',
    application_id: DEFAULT_APP_ID,
    timestamps: { start: nowMs() },
    created_at: nowMs(),
  };
}

function buildSamsungActivity(state) {
  const sam = state.samsung || {};
  const game = sanitizeText(sam.game || 'a Galaxy game', 128);
  return {
    name: game,
    details: 'Playing on Samsung Galaxy',
    state: 'Samsung RPC',
    type: 0,
    platform: 'samsung',
    application_id: DEFAULT_APP_ID,
    timestamps: { start: nowMs() },
    created_at: nowMs(),
    supported_platforms: ['samsung'],
  };
}

function buildEmulationActivity(state) {
  const emu = state.emulation || {};
  const game = sanitizeText(emu.game || 'an emulated game', 128);
  return {
    name: game,
    details: sanitizeText(`Playing on ${emu.emulator || 'RetroArch'}`, 128),
    state: sanitizeText(emu.core || 'Emulation RPC', 128),
    type: 0,
    platform: 'android',
    application_id: DEFAULT_APP_ID,
    timestamps: { start: nowMs() },
    created_at: nowMs(),
  };
}

function buildScreenReadActivity(state) {
  const sr = state.screenRead || {};
  const fields = sr.lastFields || {};
  const name = sanitizeText(fields.screen_name || sr.preset || 'Screen Read', 128);
  const score = sanitizeText(fields.screen_score || 'Reading the screen', 128);
  const cfgFields = sr.fields && typeof sr.fields === 'object' ? sr.fields : {};
  return {
    name,
    details:
      sanitizeText(
        expandTemplate(cfgFields.details !== undefined ? cfgFields.details : '{{screen_name}}', state),
        128
      ) || name,
    state:
      sanitizeText(
        expandTemplate(cfgFields.state !== undefined ? cfgFields.state : '{{screen_score}}', state),
        128
      ) || score,
    type: 0,
    application_id: DEFAULT_APP_ID,
    timestamps: { start: nowMs() },
    created_at: nowMs(),
  };
}

function accountView(state, accountId = '') {
  const store = rt.STORE;
  const account = store && accountId ? store.accountById(accountId) : null;
  if (!account) return state;
  const view = { ...state };
  view.account = deepClone((account && account.user) || {});
  return view;
}

async function buildActivity(state, kind, cyclingIndex = 0, customCfg = null) {
  switch (kind) {
    case 'custom':
      return buildCustomActivity(state, customCfg);
    case 'apps':
      return buildAppsActivity(state);
    case 'media':
      return buildMediaActivity(state);
    case 'console':
      return buildConsoleActivity(state);
    case 'experimental': {
      const exp = state.experimental || {};
      const sources = exp.sources || ['apps', 'media'];
      if (sources.includes('apps') && (state.apps || {}).selected) return buildAppsActivity(state);
      return buildMediaActivity(state);
    }
    case 'multiple': {
      const sources = (state.multiple || {}).sources || [];
      for (const source of sources) {
        try {
          return await buildActivity(state, source, cyclingIndex, customCfg);
        } catch {
          // try the next source
        }
      }
      throw new Error('Choose at least one working source for Multiple RPC.');
    }
    case 'cycling': {
      const cyc = state.cycling || {};
      const types = cyc.types || [0];
      const typeValue = types.length ? safeInt(types[cyclingIndex % types.length], 0) : 0;
      const cfg = { ...(customCfg || state.custom || {}) };
      cfg.type = String(typeValue);
      cfg.name = cfg.name || 'RPC Cycling';
      if (typeValue === 1) cfg.url = cyc.streamUrl || cfg.url || '';
      return buildCustomActivity(state, cfg);
    }
    case 'samsung':
      return buildSamsungActivity(state);
    case 'emulation':
      return buildEmulationActivity(state);
    case 'health':
      return buildHealthActivity(state);
    case 'location':
      return buildLocationActivity(state);
    case 'weather':
      return buildWeatherActivity(state);
    case 'navigation':
      return buildNavigationActivity(state);
    case 'android_auto':
      return buildAndroidAutoActivity(state);
    case 'screen_read':
      return buildScreenReadActivity(state);
    default:
      throw new Error('Unknown presence kind.');
  }
}

function presenceTitle(payload) {
  const acts = (payload && payload.activities) || [];
  if (!acts.length) return 'no activity';
  const first = acts[0] || {};
  return [first.name, first.details, first.state].filter(Boolean).join(' · ');
}

function presencePublic(kind, startedAt, activities, cycleIndex = 0) {
  const label = PRESENCE_KINDS[kind] || 'Rich Presence';
  const first = (activities && activities[0]) || {};
  const subtitle = [first.details, first.state].filter(Boolean).join(' · ');
  return {
    kind,
    label,
    title: first.name || label,
    subtitle,
    startedAt,
    activity: first,
    activities: activities || [],
    cycleIndex,
  };
}

module.exports = {
  normalizeStatus,
  timeGreeting,
  featureState,
  templateValues,
  expandTemplate,
  buildCustomActivity,
  buildAppsActivity,
  buildMediaActivity,
  buildConsoleActivity,
  buildHealthActivity,
  buildLocationActivity,
  buildWeatherActivity,
  buildNavigationActivity,
  buildAndroidAutoActivity,
  buildSamsungActivity,
  buildEmulationActivity,
  buildScreenReadActivity,
  accountView,
  buildActivity,
  presenceTitle,
  presencePublic,
};
