'use strict';

// Port of the native Kizzey importer from server.py (1666-2790). It reads
// Kizzey settings backups, preset packs, Custom RPC configs and standalone
// card JSON, and never imports Discord credentials, tokens or Nitro data.

const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR } = require('./constants');
const { nowMs, uuidHex, safeInt } = require('./util');

const KIZZEY_BACKUP_FORMAT = 'kizzey-backup';
const KIZZEY_PRESET_FORMAT = 'kizzey-preset';
const KIZZEY_WEB_FORMAT = 'kizzey-web-backup';
const KIZZEY_PRESET_LIMIT = 300;
const KIZZEY_CONFIG_LIMIT = 300;
const KIZZEY_IMAGE_LIMIT = 64;
const KIZZEY_IMAGE_B64_LIMIT = 6 * 1024 * 1024;
const KIZZEY_IMAGE_BYTES_LIMIT = 4 * 1024 * 1024;
const KIZZEY_SAVED_LIMIT = 500;
const KIZZEY_WARNING_LIMIT = 20;
const KIZZEY_NOW_WINDOW_MS = 5 * 60 * 1000;
const KIZZEY_ACTIVITY_TYPES = new Set([0, 1, 2, 3, 5]);
const KIZZEY_STATUS_VALUES = new Set(['online', 'idle', 'dnd', 'invisible', 'offline']);
const KIZZEY_HOME_SECTIONS = {
  updates: 'updates',
  live: 'live',
  quick: 'quick',
  recent: 'recent',
  chat: 'chat',
  stats: 'stats',
  about: 'about',
};
const KIZZEY_LANGUAGE_TAGS = new Set([
  'en', 'pt-BR', 'ru', 'tr', 'vi', 'ar', 'de', 'es', 'fa', 'fil', 'fr', 'hi',
  'hr', 'in', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'th', 'zh-CN', 'zh-TW', 'he', 'my',
]);
const KIZZEY_LEGACY_LANGUAGES = {
  1: 'en', 2: 'tr', 3: 'nl', 4: 'ru', 5: 'pl', 6: 'pt-BR', 7: 'in', 8: 'zh-CN',
  9: 'zh-TW', 10: 'my', 11: 'vi', 12: 'it', 13: 'fil', 14: 'fr', 15: 'hr', 16: 'fa',
  17: 'de', 18: 'th', 19: 'ja', 20: 'ko', 21: 'ar', 22: 'es', 23: 'he',
};
const KIZZEY_CONFIG_MARKERS = [
  'largeImg', 'smallImg', 'button1', 'button2', 'button1link', 'button2link',
  'timestampsStart', 'timestampsStop', 'partyCurrentSize', 'partyMaxSize', 'platform',
];
const KIZZEY_WEB_STATE_MARKERS = [
  'settings', 'custom', 'savedConfigs', 'chatProfile', 'ui', 'apps', 'media',
];
const KIZZEY_PRESET_GRADIENTS = [
  'linear-gradient(135deg,#342748,#7b4f7c)',
  'linear-gradient(135deg,#1d3340,#3f7280)',
  'linear-gradient(135deg,#3b2432,#894d65)',
  'linear-gradient(135deg,#25332a,#5f8068)',
];

function kzClean(value, limit = 256) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' || typeof value === 'boolean') return '';
  return String(value).trim().slice(0, limit);
}

function kzBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(lowered)) return false;
  }
  return null;
}

function kzInt(value, low = null, high = null, fallback = null) {
  if (value === null || value === undefined || typeof value === 'boolean') return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  let number = Number.parseFloat(String(value));
  if (!Number.isFinite(number)) return fallback;
  number = Math.trunc(number);
  if (low !== null && low !== undefined) number = Math.max(low, number);
  if (high !== null && high !== undefined) number = Math.min(high, number);
  return number;
}

function kzFloat(value, low = null, high = null, fallback = null) {
  if (value === null || value === undefined || typeof value === 'boolean') return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  let number = Number.parseFloat(String(value));
  if (!Number.isFinite(number)) return fallback;
  if (low !== null && low !== undefined) number = Math.max(low, number);
  if (high !== null && high !== undefined) number = Math.min(high, number);
  return Math.round(number * 1000) / 1000;
}

function kzJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function kzColor(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    let match = text.match(/^#?([0-9a-fA-F]{6})$/);
    if (match) return '#' + match[1].toLowerCase();
    match = text.match(/^#?([0-9a-fA-F]{8})$/);
    if (match) return '#' + match[1].slice(-6).toLowerCase();
  }
  let number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number < -0x80000000 || number > 0xffffffff) return null;
  number = number >>> 0;
  if (number === 0) return null;
  return '#' + (number & 0xffffff).toString(16).padStart(6, '0');
}

function kzActivityType(value, fallback = '0') {
  const number = kzInt(value);
  return KIZZEY_ACTIVITY_TYPES.has(number) ? String(number) : fallback;
}

function kzStatus(value, fallback = 'online') {
  const text = kzClean(value, 16).toLowerCase();
  return KIZZEY_STATUS_VALUES.has(text) ? text : fallback;
}

function kzTimestamp(value) {
  const text = kzClean(value, 48);
  if (!text) return '';
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const number = Number.parseFloat(text);
    if (!Number.isFinite(number)) return '';
    return number > 0 ? String(Math.trunc(number)) : '';
  }
  if (/^\d{4}-\d{2}-\d{2}[T ][0-9:.+\-Z]+$/.test(text)) return text;
  return '';
}

function kzUrl(value) {
  const text = kzClean(value, 2048);
  return /^https?:\/\//i.test(text) ? text : '';
}

function kzFileStem(fileName) {
  let name = path.basename(String(fileName || '').replace(/\\/g, '/')).trim();
  if (name.toLowerCase().endsWith('.json')) name = name.slice(0, -5);
  return kzClean(name, 64);
}

function kzIds(value) {
  let rows;
  if (Array.isArray(value)) rows = value;
  else if (typeof value === 'string') {
    const parsed = kzJson(value);
    rows = Array.isArray(parsed) ? parsed : value.split(',');
  } else return [];
  const out = [];
  for (const row of rows) {
    const text = kzClean(row, 64).toLowerCase();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function kzHomeIds(value) {
  const out = [];
  for (const raw of kzIds(value)) {
    const target = KIZZEY_HOME_SECTIONS[raw];
    if (target && !out.includes(target)) out.push(target);
  }
  return out;
}

function kzDetectImage(blob) {
  if (blob.length >= 8 && blob.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (blob.length >= 3 && blob[0] === 0xff && blob[1] === 0xd8 && blob[2] === 0xff) return 'jpg';
  if (blob.length >= 6) {
    const head = blob.subarray(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  if (blob.length >= 12 && blob.subarray(0, 4).toString('latin1') === 'RIFF' && blob.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'webp';
  }
  return '';
}

function kzNewContext(payload) {
  const images = payload && typeof payload === 'object' ? payload.presetImages : {};
  const source = images && typeof images === 'object' ? images : {};
  const map = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') map[String(key)] = value;
  }
  return {
    images: map,
    image_urls: {},
    images_imported: 0,
    images_skipped: 0,
    local_image_misses: 0,
    image_errors: 0,
    config_errors: 0,
    entries_skipped: 0,
    bad_application_id: false,
    warnings: [],
  };
}

function kzSaveImage(ctx, key, encoded) {
  const base = path.basename(String(key || '').replace(/\\/g, '/')).trim();
  if (!base) return '';
  if (ctx.image_urls[base]) return ctx.image_urls[base];
  if (ctx.images_imported >= KIZZEY_IMAGE_LIMIT) {
    ctx.images_skipped += 1;
    return '';
  }
  let raw = String(encoded || '').trim();
  if (raw.startsWith('data:')) {
    const comma = raw.indexOf(',');
    raw = comma >= 0 ? raw.slice(comma + 1).trim() : '';
  }
  if (!raw || raw.length > KIZZEY_IMAGE_B64_LIMIT) {
    ctx.image_errors += 1;
    return '';
  }
  let blob;
  try {
    blob = Buffer.from(raw, 'base64');
  } catch {
    ctx.image_errors += 1;
    return '';
  }
  if (!blob.length || blob.length > KIZZEY_IMAGE_BYTES_LIMIT) {
    ctx.image_errors += 1;
    return '';
  }
  const extension = kzDetectImage(blob);
  if (!extension) {
    ctx.image_errors += 1;
    return '';
  }
  const name = uuidHex(16) + '.' + extension;
  try {
    fs.writeFileSync(path.join(UPLOAD_DIR, name), blob);
  } catch {
    ctx.image_errors += 1;
    return '';
  }
  ctx.images_imported += 1;
  const url = '/uploads/' + name;
  ctx.image_urls[base] = url;
  return url;
}

function kzImageRef(ctx, raw) {
  const value = kzClean(raw, 2048);
  if (!value) return ['', ''];
  if (/^https?:\/\//i.test(value)) return [value, 'url'];
  if (value.startsWith('mp:') || value.startsWith('external/') || value.startsWith('attachments/')) {
    return [value, 'asset'];
  }
  if (/^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return [value, 'url'];
  if (value.startsWith('/uploads/')) return ['', ''];
  if (value.startsWith('data:image/')) {
    const url = kzSaveImage(ctx, uuidHex(16), value);
    return url ? [url, 'url'] : ['', ''];
  }
  const base = path.basename(value.replace(/\\/g, '/'));
  if (base && base in ctx.images) {
    const url = kzSaveImage(ctx, base, ctx.images[base]);
    if (url) return [url, 'url'];
  }
  ctx.local_image_misses += 1;
  return ['', ''];
}

function kzCustomFromConfig(config, ctx) {
  const cfg = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const [largeValue, largeKind] = kzImageRef(ctx, cfg.largeImg || cfg.largeUrl);
  const [smallValue, smallKind] = kzImageRef(ctx, cfg.smallImg || cfg.smallUrl);
  const activityType = kzActivityType(cfg.type, '0');
  const button1link = kzUrl(cfg.button1link);
  const button2link = kzUrl(cfg.button2link);
  let appId = kzClean(cfg.applicationId, 32);
  if (appId && !/^\d{18,19}$/.test(appId)) {
    appId = '';
    ctx.bad_application_id = true;
  }
  return {
    name: kzClean(cfg.name, 128),
    details: kzClean(cfg.details, 128),
    state: kzClean(cfg.state, 128),
    partyCurrentSize: kzClean(cfg.partyCurrentSize, 8),
    partyMaxSize: kzClean(cfg.partyMaxSize, 8),
    timestampsStart: kzTimestamp(cfg.timestampsStart),
    timestampsStop: kzTimestamp(cfg.timestampsStop),
    platform: kzClean(cfg.platform, 32) || 'android',
    status: kzStatus(cfg.status, 'online'),
    button1: kzClean(cfg.button1, 32),
    button1link,
    button2: kzClean(cfg.button2, 32),
    button2link,
    largeImg: largeKind === 'asset' ? largeValue : '',
    largeText: kzClean(cfg.largeText || cfg.large_text, 128),
    smallImg: smallKind === 'asset' ? smallValue : '',
    smallText: kzClean(cfg.smallText || cfg.small_text, 128),
    type: activityType,
    url: kzUrl(cfg.url),
    applicationId: appId,
    statusDisplayType: -1,
    largeUrl: largeKind === 'url' ? largeValue : '',
    smallUrl: smallKind === 'url' ? smallValue : '',
  };
}

function kzCustomHasContent(custom) {
  if (!custom || typeof custom !== 'object') return false;
  const keys = [
    'name', 'details', 'state', 'largeImg', 'largeUrl', 'smallImg', 'smallUrl',
    'button1', 'button2', 'partyCurrentSize', 'timestampsStart',
  ];
  return keys.some((key) => Boolean(custom[key]));
}

function kzPreset(title, custom, number, sourceTitle = null) {
  const name = kzClean(title, 80) || kzClean(custom.name, 80) || `Imported preset ${number + 1}`;
  const start = kzClean(custom.timestampsStart, 48);
  const stop = kzClean(custom.timestampsStop, 48);
  const timestamp = start || stop ? { mode: 'absolute', start, stop } : { mode: 'none' };
  return {
    id: 'kz-' + uuidHex(6),
    name,
    custom,
    timestamp,
    sourceTitle: kzClean(sourceTitle === null ? title : sourceTitle, 80),
    createdAt: nowMs(),
    author: 'Kizzey import',
    tag: 'Imported',
    emoji: '📥',
    gradient: KIZZEY_PRESET_GRADIENTS[number % KIZZEY_PRESET_GRADIENTS.length],
  };
}

function kzPresetFromConfig(config, title, ctx, number) {
  const custom = kzCustomFromConfig(config, ctx);
  if (!kzCustomHasContent(custom)) return null;
  return kzPreset(title, custom, number, title);
}

function kzPresetFromText(entry, ctx, number) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const title = kzClean(entry.title, 80);
  const name = kzClean(entry.name, 128);
  const details = kzClean(entry.details, 128);
  const state = kzClean(entry.state, 128);
  const image = kzClean(entry.image, 2048);
  if (!title && !name && !details && !state && !image) return null;
  const timer = entry.timer && typeof entry.timer === 'object' && !Array.isArray(entry.timer) ? entry.timer : {};
  const mode = kzClean(timer.mode, 24);
  const start = kzTimestamp(timer.start);
  const stop = kzTimestamp(timer.stop);
  const duration = kzInt(timer.durationMs, 0, null, 0);
  const custom = kzCustomFromConfig(
    {
      name,
      details,
      state,
      largeImg: image,
      status: 'online',
      timestampsStart: mode === 'absolute' ? start : '',
      timestampsStop: mode === 'absolute' ? stop : '',
    },
    ctx
  );
  const preset = kzPreset(title || name || details || state, custom, number, title);
  if (mode === 'duration' && duration > 0) {
    const now = nowMs();
    custom.timestampsStart = String(now);
    custom.timestampsStop = String(now + duration);
    preset.timestamp = { mode: 'duration', durationMs: duration };
  } else if (mode === 'since_apply') {
    custom.timestampsStart = String(nowMs());
    custom.timestampsStop = '';
    preset.timestamp = { mode: 'since_apply' };
  }
  return preset;
}

function kzPresetFromTemplate(entry, ctx, number) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (kzClean(entry.source, 24) === 'builtin') return null;
  const config = entry.config && typeof entry.config === 'object' && !Array.isArray(entry.config) ? entry.config : {};
  const custom = kzCustomFromConfig(config, ctx);
  custom.largeImg = '';
  custom.largeUrl = '';
  custom.smallImg = '';
  custom.smallUrl = '';
  custom.timestampsStart = '';
  custom.timestampsStop = '';
  const title = kzClean(entry.title, 80);
  const appId = kzClean(entry.applicationId, 32);
  if (appId && /^\d{18,19}$/.test(appId)) custom.applicationId = appId;
  else if (appId) ctx.bad_application_id = true;

  const templateImage = (ref, slot) => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return;
    const kind = kzClean(ref.kind, 24);
    const value = ref.value;
    let imageValue = '';
    let imageKind = '';
    if (kind === 'url') {
      [imageValue, imageKind] = kzImageRef(ctx, value);
    } else if (kind === 'local_upload') {
      const base = path.basename(String(value || '').replace(/\\/g, '/'));
      if (base && base in ctx.images) {
        const url = kzSaveImage(ctx, base, ctx.images[base]);
        if (url) {
          imageValue = url;
          imageKind = 'url';
        }
      } else {
        ctx.local_image_misses += 1;
      }
    } else if (kind !== '' && kind !== 'none') {
      [imageValue, imageKind] = kzImageRef(ctx, value);
    }
    if (imageValue) {
      custom[slot + 'Img'] = imageKind === 'asset' ? imageValue : '';
      custom[slot + 'Url'] = imageKind === 'url' ? imageValue : '';
    }
  };
  templateImage(entry.largeImage, 'large');
  templateImage(entry.smallImage, 'small');

  const mode = kzClean(entry.timestampMode, 24);
  const duration = kzInt(entry.durationMs, 0);
  const startAbs = kzInt(entry.startAbsolute, 0);
  const stopAbs = kzInt(entry.stopAbsolute, 0);
  const updated = kzInt(entry.updatedTs, 0);
  const now = nowMs();
  let timestamp = { mode: 'none' };
  // Match RpcPresetApply: a captured absolute start wins over timestampMode.
  // Near the save time it was a live timer and restarts on apply; an older
  // value is a fixed date and is applied verbatim.
  if (startAbs && startAbs > 0) {
    if (updated && Math.abs(startAbs - updated) <= KIZZEY_NOW_WINDOW_MS) {
      custom.timestampsStart = String(now);
      if (stopAbs && stopAbs > startAbs) {
        custom.timestampsStop = String(now + (stopAbs - startAbs));
        timestamp = { mode: 'duration', durationMs: stopAbs - startAbs };
      } else {
        custom.timestampsStop = '';
        timestamp = { mode: 'since_apply' };
      }
    } else {
      custom.timestampsStart = String(startAbs);
      custom.timestampsStop = stopAbs && stopAbs > 0 ? String(stopAbs) : '';
      timestamp = {
        mode: 'absolute',
        start: String(startAbs),
        stop: stopAbs && stopAbs > 0 ? String(stopAbs) : '',
      };
    }
  } else if (mode === 'since_apply') {
    custom.timestampsStart = String(now);
    custom.timestampsStop = '';
    timestamp = { mode: 'since_apply' };
  } else if (mode === 'duration') {
    const length = Math.max(0, duration || 0);
    custom.timestampsStart = String(now);
    custom.timestampsStop = String(now + length);
    timestamp = { mode: 'duration', durationMs: length };
  }
  if (!kzCustomHasContent(custom)) return null;
  const preset = kzPreset(title || custom.name || '', custom, number, title);
  preset.timestamp = timestamp;
  return preset;
}

// __IMPORTER_PART2__

function kzSavedButtons(prefs) {
  const data = kzJson(prefs.saved_rpc_buttons_data);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const out = {};
  const mapping = {
    button1: ['button1', 32],
    button2: ['button2', 32],
    button1Url: ['button1link', 2048],
    button2Url: ['button2link', 2048],
  };
  for (const [source, [target, limit]] of Object.entries(mapping)) {
    let value = kzClean(data[source], limit);
    if (target.endsWith('link')) value = kzUrl(value);
    if (value) out[target] = value;
  }
  return out;
}

function kzUpdatesFromPrefs(prefs, ctx) {
  const updates = {};
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return updates;
  const settings = {};
  const media = {};
  const cycling = {};
  const counts = { settings: 0 };
  const putSetting = (key, value) => {
    if (value === null || value === undefined) return;
    settings[key] = value;
    counts.settings += 1;
  };
  const putMedia = (key, value) => {
    if (value === null || value === undefined) return;
    media[key] = value;
    counts.settings += 1;
  };
  const putCycling = (key, value) => {
    if (value === null || value === undefined) return;
    cycling[key] = value;
    counts.settings += 1;
  };

  const dark = kzInt(prefs.dark_theme_value);
  if (dark === 2) putSetting('theme', 'dark');
  else if (dark === 3) putSetting('theme', 'light');
  else if (dark === 1) putSetting('theme', 'system');

  const accent = kzColor(prefs.theme_color) || kzColor(prefs.custom_theme_color);
  if (accent) putSetting('accent', accent);
  const highContrast = kzBool(prefs.high_contrast);
  if (highContrast !== null) putSetting('highContrast', highContrast);
  const dynamic = kzBool(prefs.dynamic_color);
  if (dynamic !== null) putSetting('dynamicColor', dynamic);
  const accentArt = kzBool(prefs.accent_from_art);
  if (accentArt !== null) putSetting('accentFromArt', accentArt);
  const artBackground = kzBool(prefs.art_background);
  if (artBackground !== null) putSetting('artBackground', artBackground);
  const blur = kzInt(prefs.art_background_blur, 0, 50);
  if (blur !== null) putSetting('artBackgroundBlur', blur);
  const dim = kzInt(prefs.art_background_dim, 0, 90);
  if (dim !== null) putSetting('artBackgroundDim', dim);
  const scale = kzFloat(prefs.ui_scale, 0.85, 1.2);
  if (scale !== null) putSetting('fontScale', scale);

  const layoutList = kzBool(prefs.home_layout_list);
  if (layoutList !== null) putSetting('homeLayout', layoutList ? 'list' : 'grid');
  const columns = kzInt(prefs.home_grid_columns, 1, 2);
  if (columns !== null) putSetting('homeColumns', columns);
  if ('home_sections_order' in prefs) {
    const order = kzHomeIds(prefs.home_sections_order);
    if (order.length) putSetting('homeOrder', order);
  }
  if ('home_sections_hidden' in prefs) {
    const hidden = kzHomeIds(prefs.home_sections_hidden);
    putSetting('hiddenHome', hidden);
  }

  const greeting = kzClean(prefs.welcome_message, 160);
  if (greeting) putSetting('greeting', greeting);
  const activeNow = kzBool(prefs.show_active_now_on_home);
  if (activeNow !== null) putSetting('showLiveNow', activeNow);
  const chatPreview = kzBool(prefs.chat_home_preview_enabled);
  if (chatPreview !== null) putSetting('showChatPreview', chatPreview);
  const notifications = kzBool(prefs.realtime_notif_enabled);
  if (notifications !== null) putSetting('notifications', notifications);

  let language = kzClean(prefs.k844p1_language_tag, 20);
  if (!KIZZEY_LANGUAGE_TAGS.has(language)) {
    language = KIZZEY_LEGACY_LANGUAGES[kzInt(prefs.language)] || '';
  }
  if (KIZZEY_LANGUAGE_TAGS.has(language)) putSetting('language', language);

  const useButtons = kzBool(prefs.use_saved_rpc_buttons);
  if (useButtons !== null) putSetting('showButtons', useButtons);
  Object.assign(settings, kzSavedButtons(prefs));

  const custom = {};
  const rawLast = prefs.last_run_custom_rpc;
  const last = kzJson(rawLast);
  if (last && typeof last === 'object' && !Array.isArray(last)) {
    Object.assign(custom, kzCustomFromConfig(last, ctx));
  } else if (rawLast !== null && rawLast !== undefined && rawLast !== '' && typeof rawLast === 'string') {
    ctx.warnings.push('The saved active Custom RPC card could not be read, so only its separate settings were imported.');
  }

  const customType = kzInt(prefs.custom_activity_type);
  if (KIZZEY_ACTIVITY_TYPES.has(customType)) custom.type = String(customType);
  const customStatus = kzClean(prefs.custom_activity_status, 16).toLowerCase();
  if (KIZZEY_STATUS_VALUES.has(customStatus)) {
    custom.status = customStatus;
    putSetting('rpcStatus', customStatus);
  }
  const appId = kzClean(
    prefs['custom_activity_application_id_'] || prefs.custom_activity_application_id,
    32
  );
  if (appId) {
    if (/^\d{18,19}$/.test(appId)) custom.applicationId = appId;
    else ctx.bad_application_id = true;
  }
  const stream = kzUrl(prefs.custom_activity_stream_url);
  if (stream) custom.url = stream;
  const displayType = kzInt(prefs.custom_rpc_status_display_type, -1, 2);
  if (displayType !== null) {
    custom.statusDisplayType = displayType;
    putSetting('statusDisplay', displayType);
  }
  const roll = kzBool(prefs.custom_rpc_status_roll);
  if (roll !== null) putSetting('statusRoll', roll);
  const rollInterval = kzInt(prefs.custom_rpc_status_roll_interval, 1, 120);
  if (rollInterval !== null) putSetting('statusRollInterval', rollInterval);
  const rollRaw = prefs.k844_lyrics_roll_lines_custom;
  if (rollRaw !== null && rollRaw !== undefined && rollRaw !== '') {
    const rollData = kzJson(rollRaw);
    if (Array.isArray(rollData)) {
      const names = { 0: 'name', 1: 'state', 2: 'details' };
      const lines = rollData.map((row) => names[kzInt(row)]).filter(Boolean);
      if (lines.length) putSetting('statusRollLines', lines);
    }
  }
  if (Object.keys(custom).length && (kzCustomHasContent(custom) || custom.applicationId || custom.url)) {
    updates.custom = custom;
  }

  const showProgress = kzBool(prefs.enable_timestamps);
  if (showProgress !== null) putMedia('showProgress', showProgress);
  const hidePaused = kzBool(prefs.hide_on_pause);
  if (hidePaused !== null) putMedia('hideOnPause', hidePaused);
  const mediaType = kzInt(prefs.media_rpc_activity_type);
  if (KIZZEY_ACTIVITY_TYPES.has(mediaType)) putMedia('type', mediaType);
  const pauseStatus = kzClean(prefs.k844p2_rpc_media_pause_status, 16).toLowerCase();
  if (KIZZEY_STATUS_VALUES.has(pauseStatus)) putMedia('hiddenStatus', pauseStatus);
  const mediaCycling = kzBool(prefs.media_cycling_enabled);
  if (mediaCycling !== null) putCycling('enabled', mediaCycling);
  const cyclingTypes = kzJson(prefs.media_cycling_types);
  if (Array.isArray(cyclingTypes)) {
    const values = [];
    for (const row of cyclingTypes) {
      const number = kzInt(row);
      if (KIZZEY_ACTIVITY_TYPES.has(number) && !values.includes(number)) values.push(number);
    }
    if (values.length) putCycling('types', values);
  }
  const cyclingInterval = kzInt(prefs.media_cycling_interval, 1, 600);
  if (cyclingInterval !== null) putCycling('interval', cyclingInterval);
  const cyclingStream = kzUrl(prefs.media_cycling_stream_url);
  if (cyclingStream) putCycling('streamUrl', cyclingStream);

  if (prefs.custom_css_theme || prefs.custom_css_theme_enabled) {
    ctx.warnings.push("Kizzey's serialised custom CSS palette was not converted into web CSS variables.");
  }

  if (Object.keys(settings).length) updates.settings = settings;
  if (Object.keys(media).length) updates.media = media;
  if (Object.keys(cycling).length) updates.cycling = cycling;
  ctx.settings_count = counts.settings;
  return updates;
}

function kzAddPreset(presets, seen, preset, ctx) {
  if (!preset) return false;
  const key = savedMergeKey(preset);
  if (key && seen.has(key)) {
    ctx.duplicates = (ctx.duplicates || 0) + 1;
    return false;
  }
  if (presets.length >= KIZZEY_PRESET_LIMIT) {
    ctx.truncated = true;
    return false;
  }
  if (key) seen.add(key);
  presets.push(preset);
  return true;
}

function kzFinalWarnings(ctx, report) {
  const warnings = [...ctx.warnings];
  if (ctx.local_image_misses) {
    const count = ctx.local_image_misses;
    warnings.push(
      `${count} local Android image path${count !== 1 ? 's' : ''} could not be read. ` +
        'Export a full Kizzey settings backup to carry preset artwork, or add the image again here.'
    );
  }
  if (ctx.images_skipped) {
    const count = ctx.images_skipped;
    warnings.push(
      `Only ${KIZZEY_IMAGE_LIMIT} preset artwork files are imported at once; ` +
        `${count} more ${count !== 1 ? 'were' : 'was'} skipped.`
    );
  }
  if (ctx.image_errors) {
    const count = ctx.image_errors;
    warnings.push(
      `${count} preset image${count !== 1 ? 's' : ''} could not be decoded or stored and ${
        count !== 1 ? 'were' : 'was'
      } skipped.`
    );
  }
  if (ctx.duplicates) {
    const count = ctx.duplicates;
    warnings.push(`${count} duplicate preset title${count !== 1 ? 's were' : ' was'} merged.`);
  }
  if (ctx.truncated) warnings.push(`Only the first ${KIZZEY_PRESET_LIMIT} presets were imported.`);
  if (ctx.bad_application_id) {
    warnings.push('A Custom RPC application ID was not 18 or 19 digits, so it was omitted.');
  }
  if (ctx.config_errors > 3) {
    const count = ctx.config_errors;
    warnings.push(`${count} saved config files could not be read; the first few failures are listed above.`);
  }
  if (ctx.entries_skipped) {
    const count = ctx.entries_skipped;
    warnings.push(
      `${count} preset entr${count !== 1 ? 'ies were' : 'y was'} malformed or had no importable fields and ${
        count !== 1 ? 'were' : 'was'
      } skipped.`
    );
  }
  const seen = new Set();
  const out = [];
  for (const warning of warnings) {
    if (warning && !seen.has(warning)) {
      seen.add(warning);
      out.push(warning);
    }
  }
  report.warnings = out.slice(0, KIZZEY_WARNING_LIMIT);
  return out;
}

function buildKizzeyBackupImport(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('That Kizzey backup is not a JSON object.');
  }
  const ctx = kzNewContext(payload);
  const version = kzInt(payload.version, 1);
  const appVersion = kzClean(payload.appVersion, 40);
  if (version && version > 2) {
    ctx.warnings.push(
      `This is a version ${version} Kizzey backup. Known settings were imported and newer fields were ignored.`
    );
  }
  const prefs = payload.prefs && typeof payload.prefs === 'object' && !Array.isArray(payload.prefs)
    ? payload.prefs
    : {};
  const updates = kzUpdatesFromPrefs(prefs, ctx);

  const presets = [];
  const seen = new Set();
  let templateCount = 0;
  let configCount = 0;
  let textCount = 0;

  const rawTemplates = prefs.custom_rpc_template_presets;
  if (rawTemplates !== null && rawTemplates !== undefined && rawTemplates !== '') {
    const templates = kzJson(rawTemplates);
    if (Array.isArray(templates)) {
      if (templates.length > KIZZEY_PRESET_LIMIT) ctx.truncated = true;
      for (const entry of templates.slice(0, KIZZEY_PRESET_LIMIT)) {
        const preset = kzPresetFromTemplate(entry, ctx, presets.length);
        if (preset === null) {
          if (!(entry && typeof entry === 'object' && kzClean(entry.source, 24) === 'builtin')) {
            ctx.entries_skipped += 1;
          }
          continue;
        }
        if (kzAddPreset(presets, seen, preset, ctx)) templateCount += 1;
      }
    } else {
      ctx.warnings.push('The saved Custom RPC template presets could not be read.');
    }
  } else if ('custom_rpc_template_presets' in prefs) {
    ctx.warnings.push('The saved Custom RPC template presets were empty or unreadable.');
  }

  const rawConfigs = payload.configs;
  const configs = rawConfigs && typeof rawConfigs === 'object' && !Array.isArray(rawConfigs) ? rawConfigs : {};
  let index = 0;
  for (const [rawName, rawContent] of Object.entries(configs)) {
    if (index >= KIZZEY_CONFIG_LIMIT) {
      ctx.truncated = true;
      break;
    }
    index += 1;
    const title = kzFileStem(rawName);
    const content = kzJson(rawContent);
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      ctx.config_errors += 1;
      if (ctx.config_errors <= 3) ctx.warnings.push(`The saved config ${title || 'file'} could not be read.`);
      continue;
    }
    const preset = kzPresetFromConfig(content, title, ctx, presets.length);
    if (preset === null) ctx.entries_skipped += 1;
    else if (kzAddPreset(presets, seen, preset, ctx)) configCount += 1;
  }

  const rawPresets = prefs.rpc_presence_presets;
  if (rawPresets !== null && rawPresets !== undefined && rawPresets !== '') {
    const presetRows = kzJson(rawPresets);
    if (Array.isArray(presetRows)) {
      if (presetRows.length > KIZZEY_PRESET_LIMIT) ctx.truncated = true;
      for (const entry of presetRows.slice(0, KIZZEY_PRESET_LIMIT)) {
        const preset = kzPresetFromText(entry, ctx, presets.length);
        if (preset === null) ctx.entries_skipped += 1;
        else if (kzAddPreset(presets, seen, preset, ctx)) textCount += 1;
      }
    } else {
      ctx.warnings.push('The saved text presets could not be read.');
    }
  } else if ('rpc_presence_presets' in prefs) {
    ctx.warnings.push('The saved text presets were empty or unreadable.');
  }

  const accountIgnored = Boolean(payload.includesAccount) || (
    ['token', 'user_data', 'user_id', 'user_bio', 'user_nitro', 'multi_rpc_accounts'].some((key) => key in prefs)
  );
  if (accountIgnored) {
    ctx.warnings.push('Discord account and token fields from the Android backup were ignored.');
  }

  if (!Object.keys(updates).length && !presets.length) {
    throw new Error('That Kizzey backup has no settings or presets this web build can import.');
  }

  const report = {
    kind: 'kizzey-backup',
    label: 'Kizzey settings backup',
    settings: ctx.settings_count || 0,
    presets: presets.length,
    configs: configCount,
    templatePresets: templateCount,
    textPresets: textCount,
    images: ctx.images_imported,
    accountIgnored: Boolean(accountIgnored),
    sourceVersion: appVersion || (version ? `format ${version}` : ''),
    warnings: [],
  };
  kzFinalWarnings(ctx, report);
  return { updates, presets, report };
}

function buildKizzeyPresetImport(payload) {
  let entries;
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray(payload.presets)) {
    entries = payload.presets;
  } else if (looksLikeTextPreset(payload)) {
    entries = [payload];
  } else {
    entries = payload;
  }
  if (!Array.isArray(entries)) throw new Error('That Kizzey preset pack does not contain a presets list.');
  const ctx = kzNewContext(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {});
  if (entries.length > KIZZEY_PRESET_LIMIT) ctx.truncated = true;
  const presets = [];
  const seen = new Set();
  for (const entry of entries.slice(0, KIZZEY_PRESET_LIMIT)) {
    const preset = kzPresetFromText(entry, ctx, presets.length);
    if (preset === null) ctx.entries_skipped += 1;
    else kzAddPreset(presets, seen, preset, ctx);
  }
  if (!presets.length) throw new Error('That Kizzey preset pack contains no presets with usable text.');
  const report = {
    kind: 'kizzey-preset',
    label: 'Kizzey preset pack',
    settings: 0,
    presets: presets.length,
    configs: 0,
    templatePresets: 0,
    textPresets: presets.length,
    images: ctx.images_imported,
    accountIgnored: false,
    sourceVersion:
      payload && typeof payload === 'object' && !Array.isArray(payload) ? kzClean(payload.appVersion, 40) : '',
    warnings: [],
  };
  kzFinalWarnings(ctx, report);
  return { updates: {}, presets, report };
}

function buildKizzeyConfigImport(payload, fileName = '') {
  let entries = Array.isArray(payload) ? payload : [payload];
  const ctx = kzNewContext({});
  const filtered = entries.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
  ctx.entries_skipped += entries.length - filtered.length;
  entries = filtered;
  if (!entries.length) throw new Error('That file does not contain a Kizzey Custom RPC config.');
  const presets = [];
  const seen = new Set();
  const baseTitle = kzFileStem(fileName);
  if (entries.length > KIZZEY_CONFIG_LIMIT) ctx.truncated = true;
  entries.slice(0, KIZZEY_CONFIG_LIMIT).forEach((entry, index) => {
    let title = entries.length === 1 ? baseTitle : '';
    if (!title) {
      title = kzClean(entry.name, 80) || (baseTitle ? `${baseTitle} ${index + 1}` : `Imported config ${index + 1}`);
    }
    const preset = kzPresetFromConfig(entry, title, ctx, presets.length);
    if (preset === null) ctx.entries_skipped += 1;
    else kzAddPreset(presets, seen, preset, ctx);
  });
  if (!presets.length) throw new Error('That Kizzey config has no card fields this web build can import.');
  const report = {
    kind: 'kizzey-config',
    label: 'Kizzey Custom RPC config',
    settings: 0,
    presets: presets.length,
    configs: presets.length,
    templatePresets: 0,
    textPresets: 0,
    images: ctx.images_imported,
    accountIgnored: false,
    sourceVersion: '',
    warnings: [],
  };
  kzFinalWarnings(ctx, report);
  return { updates: {}, presets, report };
}

// __IMPORTER_PART3__

function looksLikeRpcConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.state && typeof value.state === 'object') return false;
  if (KIZZEY_CONFIG_MARKERS.some((marker) => marker in value)) return true;
  return (
    ['name', 'details', 'state'].some((key) => key in value) &&
    !['title', 'image', 'presets', 'prefs'].some((key) => key in value)
  );
}

function looksLikeTextPreset(value) {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ['title', 'name', 'details', 'state', 'image'].some((key) => key in value) &&
    !looksLikeRpcConfig(value)
  );
}

function detectImportKind(payload) {
  if (Array.isArray(payload)) {
    if (payload.some((row) => looksLikeRpcConfig(row))) return 'kizzey-config';
    if (payload.some((row) => looksLikeTextPreset(row))) return 'kizzey-preset';
    return 'unknown';
  }
  if (!payload || typeof payload !== 'object') return 'unknown';
  const fmt = kzClean(payload.format, 48);
  if (fmt === KIZZEY_BACKUP_FORMAT) return 'kizzey-backup';
  if (fmt === KIZZEY_PRESET_FORMAT) return 'kizzey-preset';
  if (fmt === KIZZEY_WEB_FORMAT) return 'web';
  if (fmt) return 'unknown';
  if (
    (payload.prefs && typeof payload.prefs === 'object') ||
    (payload.configs && typeof payload.configs === 'object')
  ) {
    return 'kizzey-backup';
  }
  if (KIZZEY_WEB_STATE_MARKERS.some((key) => key in payload)) return 'web';
  if (payload.state && typeof payload.state === 'object') return 'web';
  if (Array.isArray(payload.presets)) return 'kizzey-preset';
  if (looksLikeTextPreset(payload) && ('title' in payload || 'image' in payload)) return 'kizzey-preset';
  if (looksLikeRpcConfig(payload)) return 'kizzey-config';
  // Preserve the original import contract: an object with no Kizzey marker is
  // treated as a raw web state, even when only one state group is present.
  return 'web';
}

function savedMergeKey(preset) {
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) return '';
  const value = Object.prototype.hasOwnProperty.call(preset, 'sourceTitle') ? preset.sourceTitle : preset.name;
  return String(value || '').trim().toLowerCase();
}

function mergeSavedConfigs(existing, incoming) {
  const current = Array.isArray(existing) ? existing : [];
  const incomingKeys = new Set(
    (incoming || []).map((preset) => savedMergeKey(preset)).filter(Boolean)
  );
  const kept = current.filter((preset) => !incomingKeys.has(savedMergeKey(preset)));
  const merged = [...(incoming || []), ...kept];
  const dropped = Math.max(0, merged.length - KIZZEY_SAVED_LIMIT);
  return { saved: merged.slice(0, KIZZEY_SAVED_LIMIT), dropped };
}

function kzConfigImage(custom, slot) {
  const url = kzClean(custom[slot + 'Url'], 2048);
  if (url && (/^https?:\/\//i.test(url) || /^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url))) {
    return url;
  }
  const asset = kzClean(custom[slot + 'Img'], 2048);
  if (asset.startsWith('mp:') || asset.startsWith('external/') || asset.startsWith('attachments/')) {
    return asset;
  }
  return '';
}

function kzConfigCount(value) {
  const number = kzInt(value, 0);
  return number ? number : '';
}

function kzConfigTimestamp(value) {
  const text = kzTimestamp(value);
  if (!text) return '';
  return /^\d+$/.test(text) ? Number(text) : text;
}

function kzConfigFromCustom(custom) {
  const cfg = custom && typeof custom === 'object' && !Array.isArray(custom) ? custom : {};
  let activityType = kzInt(cfg.type, 0);
  if (!KIZZEY_ACTIVITY_TYPES.has(activityType)) activityType = 0;
  let appId = kzClean(cfg.applicationId, 32);
  if (appId && !/^\d{18,19}$/.test(appId)) appId = '';
  return {
    name: kzClean(cfg.name, 128),
    details: kzClean(cfg.details, 128),
    state: kzClean(cfg.state, 128),
    partyCurrentSize: kzConfigCount(cfg.partyCurrentSize),
    partyMaxSize: kzConfigCount(cfg.partyMaxSize),
    timestampsStart: kzConfigTimestamp(cfg.timestampsStart),
    timestampsStop: kzConfigTimestamp(cfg.timestampsStop),
    platform: kzClean(cfg.platform, 32) || 'android',
    status: kzStatus(cfg.status, 'online'),
    button1: kzClean(cfg.button1, 32),
    button1link: kzUrl(cfg.button1link),
    button2: kzClean(cfg.button2, 32),
    button2link: kzUrl(cfg.button2link),
    largeImg: kzConfigImage(cfg, 'large'),
    largeText: kzClean(cfg.largeText, 128),
    smallImg: kzConfigImage(cfg, 'small'),
    smallText: kzClean(cfg.smallText, 128),
    type: activityType,
    url: kzUrl(cfg.url),
    applicationId: appId,
    statusDisplayType: -1,
  };
}

function kzFileSlug(value, fallback = 'preset') {
  const text = kzClean(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return text.slice(0, 48) || fallback;
}

function savedPresetIndex(saved, presetId) {
  if (!presetId) return -1;
  const rows = Array.isArray(saved) ? saved : [];
  for (let index = 0; index < rows.length; index += 1) {
    const preset = rows[index];
    if (preset && typeof preset === 'object' && String(preset.id || '') === presetId) return index;
  }
  return -1;
}

function kzSavedPreset(payload, custom, existing = null, number = 0) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const name = kzClean(payload.name, 80) || kzClean(base.name, 80);
  if (!name) throw new Error('Give the preset a name.');
  const normalised = kzCustomFromConfig(custom, kzNewContext({}));
  if (!kzCustomHasContent(normalised)) {
    throw new Error('Fill in the Custom RPC card before saving a preset.');
  }
  const start = kzClean(normalised.timestampsStart, 48);
  const stop = kzClean(normalised.timestampsStop, 48);
  const created = base.createdAt;
  const now = nowMs();
  return {
    id: kzClean(base.id, 64) || 'kz-' + uuidHex(6),
    name,
    custom: normalised,
    timestamp: start || stop ? { mode: 'absolute', start, stop } : { mode: 'none' },
    sourceTitle: name,
    createdAt: Number.isFinite(created) ? created : now,
    updatedAt: now,
    author: kzClean(base.author, 40) || 'You',
    tag: kzClean(base.tag, 24) || 'Saved',
    emoji: kzClean(base.emoji, 8) || '⭐',
    gradient:
      kzClean(base.gradient, 160) ||
      KIZZEY_PRESET_GRADIENTS[number % KIZZEY_PRESET_GRADIENTS.length],
  };
}

module.exports = {
  KIZZEY_BACKUP_FORMAT,
  KIZZEY_PRESET_FORMAT,
  KIZZEY_WEB_FORMAT,
  KIZZEY_PRESET_LIMIT,
  KIZZEY_SAVED_LIMIT,
  kzClean,
  kzBool,
  kzInt,
  kzFloat,
  kzJson,
  kzColor,
  kzActivityType,
  kzStatus,
  kzTimestamp,
  kzUrl,
  kzFileStem,
  kzIds,
  kzHomeIds,
  kzDetectImage,
  kzNewContext,
  kzSaveImage,
  kzImageRef,
  kzCustomFromConfig,
  kzCustomHasContent,
  kzPreset,
  kzPresetFromConfig,
  kzPresetFromText,
  kzPresetFromTemplate,
  kzSavedButtons,
  kzUpdatesFromPrefs,
  kzAddPreset,
  kzFinalWarnings,
  buildKizzeyBackupImport,
  buildKizzeyPresetImport,
  buildKizzeyConfigImport,
  looksLikeRpcConfig,
  looksLikeTextPreset,
  detectImportKind,
  savedMergeKey,
  mergeSavedConfigs,
  kzConfigImage,
  kzConfigCount,
  kzConfigTimestamp,
  kzConfigFromCustom,
  kzFileSlug,
  savedPresetIndex,
  kzSavedPreset,
};
