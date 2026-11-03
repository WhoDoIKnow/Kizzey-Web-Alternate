'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const rt = require('./runtime');
const {
  VERSION,
  UPLOAD_DIR,
  TMP_DIR,
  MAX_CHAT,
  KIZZEY_REPO,
} = require('./constants');
const { nowMs, nowIso, clamp, safeInt, uuidHex, isPlainObject, deepClone, deepMerge } = require('./util');
const { sendJson, sendError, sendRaw, readJsonBody, query } = require('./http');
const { publicState, visiblePatch, IMPORTABLE_STATE_GROUPS } = require('./state');
const { scrub } = require('./scrub');
const { defaultCustom } = require('./defaults');
const { prepareImportedMirror } = require('./mirror-normalize');

const execFileAsync = promisify(execFile);

const KIZZEY_PRESET_FORMAT = 'kizzey-preset';
const KIZZEY_WEB_FORMAT = 'kizzey-web-backup';
const KIZZEY_SAVED_LIMIT = 500;
const KIZZEY_WARNING_LIMIT = 20;

function store() {
  return rt.STORE;
}

// -- weather / navigation / friends ---------------------------------------
async function handleWeather(req, res, url) {
  const { offlineMode, fetchWeather } = require('./discord');
  if (offlineMode()) {
    return sendError(res, 'Offline mode is on. Turn it off in Settings to load weather.', 503);
  }
  const q = query(url);
  const lat = Number(q.lat || '51.5072');
  const lon = Number(q.lon || '-0.1276');
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return sendError(res, 'Invalid coordinates.', 400);
  const unit = String(q.unit || 'c').toLowerCase();
  try {
    const weather = await fetchWeather(lat, lon, unit);
    const s = store();
    if (s) {
      s.state.weather = s.state.weather || {};
      s.state.weather.last = weather;
      s.save();
      s.publish({ type: 'weather', weather });
    }
    return sendJson(res, { ok: true, weather });
  } catch (error) {
    return sendError(res, `Weather is unavailable: ${error.message}`, 502);
  }
}

async function handleRoute(req, res, url) {
  const { offlineMode, httpJson } = require('./discord');
  if (offlineMode()) {
    return sendError(res, 'Offline mode is on. Turn it off in Settings to calculate routes.', 503);
  }
  const q = query(url);
  const lat1 = Number(q.lat1);
  const lon1 = Number(q.lon1);
  const lat2 = Number(q.lat2);
  const lon2 = Number(q.lon2);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) {
    return sendError(res, 'Origin and destination coordinates are required.', 400);
  }
  const target =
    'https://router.project-osrm.org/route/v1/driving/' +
    `${lon1.toFixed(6)},${lat1.toFixed(6)};${lon2.toFixed(6)},${lat2.toFixed(6)}` +
    '?overview=false&alternatives=false&steps=false';
  try {
    const data = await httpJson(target, 20);
    const route = (data.routes || [{}])[0];
    const distance = Number(route.distance || 0);
    const duration = Number(route.duration || 0);
    return sendJson(res, {
      ok: true,
      distance,
      duration,
      distanceText: `${(distance / 1000).toFixed(1)} km`,
      durationText: `${Math.round(duration / 60)} min`,
      name: q.name || 'Destination',
    });
  } catch (error) {
    return sendError(res, `Could not calculate a route: ${error.message}`, 502);
  }
}

async function handleFriends(req, res) {
  const s = store();
  if (!s) return sendError(res, 'Server not ready.', 503);
  const { discordApi, normalizeRelationship, DiscordError } = require('./discord');
  const token = s.activeToken();
  if (!token) return sendJson(res, { ok: true, friends: [], signedIn: false });
  try {
    const rows = (await discordApi('/users/@me/relationships', token)) || [];
    let friends = rows.filter((r) => r && typeof r === 'object').map((r) => normalizeRelationship(r));
    friends = friends.filter((f) => f.user && f.user.username);
    return sendJson(res, { ok: true, friends, signedIn: true });
  } catch (error) {
    if (error instanceof DiscordError) return sendError(res, error.message, error.status || 502);
    return sendError(res, error.message, 502);
  }
}

// -- uploads / OCR ---------------------------------------------------------
function decodeDataUrl(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('data:image/')) return null;
  const comma = raw.indexOf(',');
  if (comma < 0) return null;
  const header = raw.slice(0, comma);
  const b64 = raw.slice(comma + 1);
  let ext = 'png';
  if (header.includes('jpeg') || header.includes('jpg')) ext = 'jpg';
  else if (header.includes('gif')) ext = 'gif';
  else if (header.includes('webp')) ext = 'webp';
  return { ext, blob: Buffer.from(b64, 'base64') };
}

async function handleUpload(req, res) {
  const s = store();
  const data = await readJsonBody(req);
  const decoded = decodeDataUrl(String(data.data || ''));
  if (!decoded) return sendError(res, 'Expected an image data URL.', 400);
  const { ext, blob } = decoded;
  if (blob.length > 12 * 1024 * 1024) return sendError(res, 'Image is larger than 12 MB.', 413);
  if (!blob.length) return sendError(res, 'Empty image.', 400);
  const name = uuidHex(16) + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), blob);
  let asset = null;
  if (data.localOnly !== true) {
    const { uploadImageBytes } = require('./discord');
    asset = await uploadImageBytes(blob, name);
  }
  if (s) {
    s.log(
      'INFO',
      'Images',
      `Uploaded ${name} (${Math.trunc(blob.length / 1024)} KB)` + (asset ? ' with a Discord asset.' : '.')
    );
  }
  return sendJson(res, {
    ok: true,
    url: '/uploads/' + name,
    asset,
    filename: String(data.filename || name),
  });
}

async function handleChatUpload(req, res) {
  const data = await readJsonBody(req);
  const decoded = decodeDataUrl(String(data.data || ''));
  if (!decoded) return sendError(res, 'Expected an image data URL.', 400);
  if (decoded.blob.length > 8 * 1024 * 1024) return sendError(res, 'Images are limited to 8 MB.', 413);
  const name = uuidHex(16) + '.' + decoded.ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), decoded.blob);
  return sendJson(res, { ok: true, url: '/uploads/' + name });
}

async function handleOcr(req, res) {
  const data = await readJsonBody(req);
  const raw = String(data.image || '');
  let file;
  let temporary = false;
  if (raw.startsWith('/uploads/')) {
    file = path.join(UPLOAD_DIR, path.basename(raw));
  } else if (raw.startsWith('data:image/')) {
    const decoded = decodeDataUrl(raw);
    if (!decoded) return sendError(res, 'Could not decode image.', 400);
    file = path.join(TMP_DIR, uuidHex(8) + '.' + decoded.ext);
    fs.writeFileSync(file, decoded.blob);
    temporary = true;
  } else {
    return sendError(res, 'Expected an uploaded image or image data URL.', 400);
  }
  if (!fs.existsSync(file)) return sendError(res, 'Image not found.', 404);
  let tesseract = null;
  for (const candidate of ['/usr/bin/tesseract', '/usr/local/bin/tesseract', '/data/data/com.termux/files/usr/bin/tesseract']) {
    if (fs.existsSync(candidate)) {
      tesseract = candidate;
      break;
    }
  }
  if (!tesseract) {
    try {
      const which = await execFileAsync('sh', ['-c', 'command -v tesseract']);
      tesseract = which.stdout.trim() || null;
    } catch {
      tesseract = null;
    }
  }
  if (!tesseract) {
    return sendError(res, 'OCR is not installed on this server. Install the tesseract package to read screens.', 501);
  }
  try {
    const result = await execFileAsync(tesseract, [file, 'stdout', '-l', 'eng', '--psm', '6'], {
      timeout: 35000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const text = String(result.stdout || '').trim();
    return sendJson(res, { ok: true, text, chars: text.length });
  } catch (error) {
    return sendError(res, `OCR failed: ${String(error.stderr || error.message).slice(0, 300)}`, 500);
  } finally {
    if (temporary) {
      try {
        fs.unlinkSync(file);
      } catch {
        // already gone
      }
    }
  }
}

// -- export ---------------------------------------------------------------
function sendAttachment(res, payload, fileName) {
  const raw = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  sendRaw(
    res,
    raw,
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
    200
  );
}

function handleExport(req, res) {
  const s = store();
  const excluded = new Set(['account', 'gateway', 'presence', 'logs', 'history', 'tokenSet', 'tokenHint', 'serverTime']);
  const state = {};
  for (const [key, value] of Object.entries(s.state)) {
    if (!excluded.has(key)) state[key] = value;
  }
  const payload = {
    format: KIZZEY_WEB_FORMAT,
    version: VERSION,
    exportedAt: nowIso(),
    state,
    savedConfigs: s.state.savedConfigs || [],
  };
  return sendAttachment(res, payload, `kizzey-web-${new Date().toISOString().slice(0, 10)}.json`);
}

function handlePresetExport(req, res, url) {
  const s = store();
  const importer = require('./importer');
  const q = query(url);
  const pack = ['1', 'true', 'yes', 'on'].includes(String(q.pack || '').toLowerCase());
  const presetId = importer.kzClean(q.id, 64);
  const current = ['1', 'true', 'yes', 'on'].includes(String(q.current || '').toLowerCase());
  const saved = Array.isArray(s.state.savedConfigs) ? s.state.savedConfigs : [];
  let payload;
  let fileName;
  if (pack) {
    const entries = [];
    for (const preset of saved) {
      if (!preset || typeof preset !== 'object') continue;
      const custom = isPlainObject(preset.custom) ? preset.custom : {};
      const timer = isPlainObject(preset.timestamp) ? preset.timestamp : {};
      const mode = importer.kzClean(timer.mode, 24) || 'none';
      const entry = {
        title: importer.kzClean(preset.name, 80),
        name: importer.kzClean(custom.name, 128),
        details: importer.kzClean(custom.details, 128),
        state: importer.kzClean(custom.state, 128),
        image: importer.kzConfigImage(custom, 'large'),
      };
      if (mode === 'absolute') {
        entry.timer = {
          mode,
          start: importer.kzClean(timer.start, 48),
          stop: importer.kzClean(timer.stop, 48),
        };
      } else if (mode === 'duration') {
        entry.timer = { mode, durationMs: importer.kzInt(timer.durationMs, 0, null, 0) };
      } else if (mode === 'since_apply') {
        entry.timer = { mode };
      }
      entries.push(entry);
    }
    if (!entries.length) throw new Error('There are no saved presets to download yet.');
    payload = { format: KIZZEY_PRESET_FORMAT, appVersion: VERSION, presets: entries };
    fileName = `kizzey-presets-${new Date().toISOString().slice(0, 10)}.json`;
  } else if (presetId) {
    const index = importer.savedPresetIndex(saved, presetId);
    if (index < 0) throw new Error('That preset is no longer saved.');
    payload = importer.kzConfigFromCustom(saved[index].custom);
    fileName = `kizzey-preset-${importer.kzFileSlug(saved[index].name)}.json`;
  } else if (current) {
    payload = importer.kzConfigFromCustom(s.state.custom);
    fileName = 'kizzey-preset-current.json';
  } else {
    throw new Error('Choose a preset to download.');
  }
  return sendAttachment(res, payload, fileName);
}

// -- presets ---------------------------------------------------------------
async function handlePresetSave(req, res) {
  const s = store();
  const importer = require('./importer');
  const data = await readJsonBody(req);
  const presetId = importer.kzClean(data.id, 64);
  let saved = Array.isArray(s.state.savedConfigs) ? [...s.state.savedConfigs] : [];
  const index = importer.savedPresetIndex(saved, presetId);
  const existing = index >= 0 ? saved[index] : null;
  if (presetId && existing === null) throw new Error('That preset is no longer saved.');
  let custom = data.custom;
  if (!isPlainObject(custom)) {
    if (existing && isPlainObject(existing.custom)) custom = existing.custom;
    else custom = s.state.custom;
  }
  const preset = importer.kzSavedPreset(data, custom, existing, saved.length);
  let dropped = 0;
  if (existing !== null) {
    saved[index] = preset;
  } else {
    saved = [preset, ...saved];
    dropped = Math.max(0, saved.length - KIZZEY_SAVED_LIMIT);
  }
  saved = saved.slice(0, KIZZEY_SAVED_LIMIT);
  s.state.savedConfigs = saved;
  s.save();
  s.log('INFO', 'Presets', `${existing === null ? 'Saved' : 'Updated'}: ${preset.name}`);
  s.broadcastState();
  return sendJson(res, {
    ok: true,
    preset,
    created: existing === null,
    renamed: Boolean(existing) && existing.name !== preset.name,
    dropped,
    state: publicState(),
  });
}

async function handlePresetDelete(req, res) {
  const s = store();
  const importer = require('./importer');
  const data = await readJsonBody(req);
  const presetId = importer.kzClean(data.id, 64);
  if (!presetId) throw new Error('Choose a preset to delete.');
  const saved = Array.isArray(s.state.savedConfigs) ? [...s.state.savedConfigs] : [];
  const index = importer.savedPresetIndex(saved, presetId);
  if (index < 0) throw new Error('That preset is no longer saved.');
  const removed = saved.splice(index, 1)[0];
  s.state.savedConfigs = saved;
  s.save();
  s.log('INFO', 'Presets', `Deleted: ${importer.kzClean(removed.name, 80) || presetId}`);
  s.broadcastState();
  return sendJson(res, { ok: true, removed, state: publicState() });
}

// -- import ---------------------------------------------------------------
async function handleImport(req, res) {
  const s = store();
  const importer = require('./importer');
  const { purgeMirrorWebhooks } = require('./mirror');
  const data = await readJsonBody(req, { allowList: true });
  let payload;
  let fileName = '';
  if (Array.isArray(data)) {
    payload = data;
  } else {
    const wrapped = isPlainObject(data.backup) || Array.isArray(data.backup);
    payload = wrapped ? data.backup : data;
    fileName = wrapped ? String(data.fileName || '').trim().slice(0, 240) : '';
  }
  const kind = importer.detectImportKind(payload);
  if (kind === 'unknown') {
    return sendError(
      res,
      'Expected a Kizzey Web backup, a Kizzey settings backup, a Kizzey preset pack or a Custom RPC config JSON file.',
      400
    );
  }
  if (kind === 'web') {
    const incoming = isPlainObject(payload) && isPlainObject(payload.state) ? payload.state : payload;
    if (!isPlainObject(incoming)) return sendError(res, 'That backup does not contain a state object.', 400);
    const warnings = [];
    if ('mirror' in incoming && IMPORTABLE_STATE_GROUPS.has('mirror')) {
      await purgeMirrorWebhooks({ forgetOnFailure: true });
    }
    for (const [key, value] of Object.entries(incoming)) {
      if (!IMPORTABLE_STATE_GROUPS.has(key)) continue;
      if (key === 'mirror') {
        const prepared = prepareImportedMirror(value);
        s.state.mirror = prepared.mirror;
        warnings.push(...prepared.notes);
        continue;
      }
      if (key === 'customs') {
        if (!isPlainObject(value)) continue;
        if (!isPlainObject(s.state.customs)) s.state.customs = {};
        for (const [accountId, card] of Object.entries(value)) {
          if (!isPlainObject(card)) continue;
          const current = s.state.customs[String(accountId)];
          if (isPlainObject(current)) deepMerge(current, card);
          else s.state.customs[String(accountId)] = deepClone(card);
        }
        continue;
      }
      if (isPlainObject(value) && isPlainObject(s.state[key])) deepMerge(s.state[key], value);
      else s.state[key] = value;
    }
    if ('custom' in incoming) s.adoptFocusedCustom();
    s.save();
    const savedCount = (s.state.savedConfigs || []).length;
    s.log('INFO', 'Backup', 'Settings imported from a Kizzey Web backup.');
    for (const warning of warnings.slice(0, KIZZEY_WARNING_LIMIT)) s.log('WARN', 'Import', warning);
    s.broadcastState();
    return sendJson(res, {
      ok: true,
      state: publicState(),
      import: {
        kind: 'web',
        label: 'Kizzey Web backup',
        settings: 0,
        presets: savedCount,
        images: 0,
        warnings: warnings.slice(0, KIZZEY_WARNING_LIMIT),
      },
    });
  }

  let bundle;
  if (kind === 'kizzey-backup') bundle = importer.buildKizzeyBackupImport(payload, fileName);
  else if (kind === 'kizzey-preset') bundle = importer.buildKizzeyPresetImport(payload, fileName);
  else bundle = importer.buildKizzeyConfigImport(payload, fileName);

  const report = bundle.report;
  if ('mirror' in bundle.updates) await purgeMirrorWebhooks({ forgetOnFailure: true });
  for (const [key, value] of Object.entries(bundle.updates)) {
    if (!IMPORTABLE_STATE_GROUPS.has(key) || key === 'savedConfigs') continue;
    if (key === 'mirror') {
      const prepared = prepareImportedMirror(value);
      s.state.mirror = prepared.mirror;
      for (const note of prepared.notes) {
        if (!report.warnings.includes(note)) report.warnings = [...report.warnings, note].slice(0, KIZZEY_WARNING_LIMIT);
      }
      continue;
    }
    if (isPlainObject(value) && isPlainObject(s.state[key])) deepMerge(s.state[key], value);
    else s.state[key] = value;
  }
  if (bundle.presets && bundle.presets.length) {
    const merged = importer.mergeSavedConfigs(s.state.savedConfigs, bundle.presets);
    s.state.savedConfigs = merged.saved;
    if (merged.dropped) {
      const note = `${merged.dropped} older saved preset${merged.dropped !== 1 ? 's were' : ' was'} dropped at the local limit of ${KIZZEY_SAVED_LIMIT}.`;
      if (!report.warnings.includes(note)) report.warnings = [...report.warnings, note].slice(0, KIZZEY_WARNING_LIMIT);
    }
  }
  s.adoptFocusedCustom();
  s.save();
  const parts = [];
  if (report.settings) parts.push(`${report.settings} setting${report.settings !== 1 ? 's' : ''}`);
  if (report.presets) parts.push(`${report.presets} preset${report.presets !== 1 ? 's' : ''}`);
  if (report.configs) parts.push(`${report.configs} config${report.configs !== 1 ? 's' : ''}`);
  if (report.images) parts.push(`${report.images} image${report.images !== 1 ? 's' : ''}`);
  s.log('INFO', 'Import', `${report.label} imported: ${parts.join(', ') || 'no countable changes'}.`);
  for (const warning of (report.warnings || []).slice(0, KIZZEY_WARNING_LIMIT)) s.log('WARN', 'Import', warning);
  s.broadcastState();
  return sendJson(res, { ok: true, state: publicState(), import: report });
}

// -- patch ----------------------------------------------------------------
const PATCH_KEYS = new Set([
  'settings', 'apps', 'media', 'console', 'experimental', 'cycling', 'multiple', 'health',
  'location', 'weather', 'navigation', 'androidAuto', 'samsung', 'emulation', 'screenRead',
  'automation', 'drawer', 'chatProfile', 'wallet', 'quickControls', 'ui', 'recent', 'usage',
  'savedConfigs', 'bulk', 'plugins', 'gallery', 'appCatalog',
]);

async function handlePatch(req, res) {
  const s = store();
  const data = await readJsonBody(req);
  const updates = visiblePatch(isPlainObject(data.updates) ? data.updates : data);
  if (!Object.keys(updates).length) return sendError(res, 'Nothing to update.', 400);
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'custom') {
      if (!isPlainObject(value)) continue;
      const accountId = s.activeAccountId();
      if (accountId) {
        const target = s.customFor(accountId);
        deepMerge(target, value);
        s.state.custom = deepClone(target);
      } else {
        if (!isPlainObject(s.state.custom)) s.state.custom = defaultCustom();
        deepMerge(s.state.custom, value);
      }
      continue;
    }
    if (PATCH_KEYS.has(key)) {
      if (isPlainObject(value) && isPlainObject(s.state[key])) deepMerge(s.state[key], value);
      else s.state[key] = value;
    }
  }
  s.save();
  s.publish({ type: 'state', state: publicState() });
  return sendJson(res, { ok: true, state: publicState() });
}

module.exports = {
  handleWeather,
  handleRoute,
  handleFriends,
  handleUpload,
  handleChatUpload,
  handleOcr,
  handleExport,
  handlePresetExport,
  handlePresetSave,
  handlePresetDelete,
  handleImport,
  handlePatch,
  sendAttachment,
};
