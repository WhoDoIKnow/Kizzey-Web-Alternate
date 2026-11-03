'use strict';

// Port of presence_record / send_current_presence / Ticker / start / stop /
// refresh / resume from server.py. Every account owns a presence slot and a
// gateway socket, so multiple presences run side by side.

const rt = require('./runtime');
const { PRESENCE_KINDS } = require('./constants');
const { nowMs, safeInt, deepClone, deepMerge, cleanDiscordToken } = require('./util');
const { emptyPresence, defaultCustom } = require('./defaults');
const { publicState } = require('./state');
const {
  accountView,
  buildActivity,
  expandTemplate,
  normalizeStatus,
  presencePublic,
  presenceTitle,
} = require('./activities');

function store() {
  return rt.STORE;
}

function presenceRecord(accountId = '') {
  const s = store();
  if (!s) return null;
  accountId = String(accountId || '') || s.activeAccountId();
  if (!accountId) return null;
  const presences = (s.state.presences = s.state.presences || {});
  let record = presences[accountId];
  if (!record || typeof record !== 'object') {
    record = emptyPresence();
    presences[accountId] = record;
  }
  return record;
}

async function sendCurrentPresence({ force = false, cycleIndex = null, accountId = '' } = {}) {
  const s = store();
  if (!s) return null;
  accountId = String(accountId || '') || s.activeAccountId();
  if (!accountId) return null;
  const record = presenceRecord(accountId);
  if (!record) return null;
  if (!record.active) return null;
  const kind = record.active.kind;
  const started = record.startedAt || nowMs();
  if (cycleIndex !== null && cycleIndex !== undefined) record.cycleIndex = cycleIndex;
  const idx = cycleIndex !== null && cycleIndex !== undefined ? cycleIndex : record.cycleIndex || 0;
  const customCfg = deepClone(s.customFor(accountId));
  const view = accountView(s.state, accountId);
  const sources = kind === 'multiple' ? [...((s.state.multiple || {}).sources || [])] : [];
  const activities = [];
  try {
    if (kind === 'multiple') {
      for (const source of sources) {
        try {
          activities.push(await buildActivity(view, source, idx, customCfg));
        } catch (error) {
          s.log('WARN', 'Presence', `${source}: ${error.message}`);
        }
      }
    } else {
      activities.push(await buildActivity(view, kind, idx, customCfg));
    }
  } catch (error) {
    s.log('ERROR', 'Presence', `Could not build presence: ${error.message}`);
    return null;
  }
  if (!activities.length) {
    s.log('ERROR', 'Presence', 'Could not build presence: no working activity.');
    return null;
  }
  let status = normalizeStatus(
    kind === 'custom'
      ? customCfg.status
      : ((s.state.settings || {}).rpcStatus || 'online')
  );
  if (kind === 'experimental') {
    status = normalizeStatus((s.state.experimental || {}).status || status);
  }
  const payload = { since: 0, activities, status, afk: false };
  record.activities = activities;
  record.updatedAt = nowMs();
  record.info = presencePublic(kind, started, activities, idx);
  s.syncFocused();
  const focused = accountId === s.activeAccountId();
  const snapshot = focused ? deepClone(s.state.presence) : null;
  const gatewaySnapshot = focused ? deepClone(s.state.gateway) : null;
  // Opening the socket for a background account is fine: each account owns its
  // own connection, so several presences can run at the same time.
  rt.GATEWAY.ensure(accountId);
  rt.GATEWAY.sendPresence(payload, accountId);
  s.save();
  if (focused) {
    s.publish({ type: 'presence', presence: snapshot, gateway: gatewaySnapshot });
  } else {
    s.broadcastState();
  }
  return payload;
}

function stopPresence(kind = null, accountId = '', quiet = false) {
  const s = store();
  if (!s) return false;
  accountId = String(accountId || '') || s.activeAccountId();
  if (!accountId) return false;
  const record = (s.state.presences || {})[accountId];
  const active = (record || {}).active;
  if (!active) return false;
  if (kind && active.kind !== kind && kind !== 'all') return false;
  const started = (record || {}).startedAt;
  const title = active.title || ((record || {}).info || {}).title || '';
  s.addHistory(
    active.kind || 'custom',
    PRESENCE_KINDS[active.kind] || 'Rich Presence',
    title,
    Math.trunc(started || nowMs()),
    nowMs()
  );
  for (const key of Object.keys(record)) delete record[key];
  Object.assign(record, emptyPresence());
  record.updatedAt = nowMs();
  if (!quiet) {
    const custom = s.customFor(accountId);
    custom.status = 'online';
    if (accountId === s.activeAccountId()) s.state.custom = deepClone(custom);
    s.log('INFO', 'Presence', 'Stopped all rich presence.');
  }
  s.syncFocused();
  const focused = accountId === s.activeAccountId();
  const snapshot = focused ? deepClone(s.state.presence) : null;
  const gatewaySnapshot = focused ? deepClone(s.state.gateway) : null;
  rt.GATEWAY.sendPresence(null, accountId);
  s.save();
  // The account may have nothing left running, so its socket can close now.
  rt.GATEWAY.reconcile();
  if (focused) {
    s.publish({ type: 'presence', presence: snapshot, gateway: gatewaySnapshot });
  } else {
    s.broadcastState();
  }
  return true;
}

async function startPresence(kind, payload = null, accountId = '') {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  const { requireGatewayToken } = require('./account');
  const { visiblePatch } = require('./state');
  accountId = String(accountId || '') || s.activeAccountId();
  requireGatewayToken(accountId);
  if (!PRESENCE_KINDS[kind]) throw new Error('Unknown RPC type.');
  if (payload && typeof payload === 'object') {
    if (kind === 'custom' && payload.custom && typeof payload.custom === 'object') {
      const custom = s.customFor(accountId);
      deepMerge(custom, visiblePatch(payload.custom));
      if (accountId === s.activeAccountId()) s.state.custom = deepClone(custom);
    }
    for (const key of [
      'apps',
      'media',
      'console',
      'experimental',
      'cycling',
      'multiple',
      'health',
      'location',
      'weather',
      'navigation',
      'androidAuto',
      'samsung',
      'emulation',
      'screenRead',
    ]) {
      if (payload[key] && typeof payload[key] === 'object') {
        s.state[key] = s.state[key] || {};
        deepMerge(s.state[key], visiblePatch(payload[key]));
      }
    }
  }
  // Validate the new card before touching the running routine, so a typo in a
  // custom card cannot silently kill the presence already on Discord.
  let first;
  try {
    const snapshot = deepClone(s.state);
    const customCfg = deepClone(s.customFor(accountId));
    first = await buildActivity(accountView(snapshot, accountId), kind, 0, customCfg);
  } catch (error) {
    throw new Error(error.message);
  }
  stopPresence(null, accountId, true);
  const started = nowMs();
  const info = presencePublic(kind, started, [first]);
  const record = presenceRecord(accountId);
  for (const key of Object.keys(record)) delete record[key];
  Object.assign(record, {
    active: { kind, title: first.name, startedAt: started },
    startedAt: started,
    activities: [first],
    info,
    updatedAt: started,
    cycleIndex: 0,
  });
  s.state.usage = s.state.usage || {};
  s.state.usage[kind] = Math.trunc(s.state.usage[kind] || 0) + 1;
  const recent = [kind, ...((s.state.recent || []).filter((x) => x !== kind))];
  s.state.recent = recent.slice(0, 8);
  s.syncFocused();
  s.log(
    'INFO',
    'Presence',
    `${PRESENCE_KINDS[kind] || 'RPC'} started: ${info.title}` +
      (info.subtitle ? ` — ${info.subtitle}` : '')
  );
  s.save();
  const snapshot = deepClone(record);
  await sendCurrentPresence({ force: true, accountId });
  rt.GATEWAY.reconcile();
  s.broadcastState();
  return snapshot;
}

async function refreshPresence(accountId = '') {
  const s = store();
  if (!s) return null;
  accountId = String(accountId || '') || s.activeAccountId();
  if (!accountId) return null;
  const active = (presenceRecord(accountId) || {}).active;
  if (!active) return null;
  await sendCurrentPresence({ force: true, accountId });
  rt.GATEWAY.reconcile();
  s.log('INFO', 'Presence', 'Presence refreshed.');
  s.broadcastState();
  return deepClone(presenceRecord(accountId) || {});
}

async function resumeLivePresences() {
  const s = store();
  if (!s) return 0;
  const records = s.state.presences || {};
  const accountIds = Object.entries(records)
    .filter(([, record]) => record && typeof record === 'object' && record.active)
    .map(([id]) => id);
  let resumed = 0;
  for (const accountId of accountIds) {
    const account = s.accountById(accountId, true);
    if (!cleanDiscordToken((account || {}).token)) {
      const record = (s.state.presences || {})[accountId];
      if (record && typeof record === 'object') {
        for (const key of Object.keys(record)) delete record[key];
        Object.assign(record, emptyPresence());
      }
      s.syncFocused();
      s.log(
        'WARN',
        'Presence',
        'A saved presence could not resume because its account has no token.'
      );
      continue;
    }
    let payload = null;
    try {
      payload = await sendCurrentPresence({ force: true, accountId });
    } catch (error) {
      s.log('WARN', 'Presence', `Could not resume presence: ${error.message}`);
    }
    if (payload === null) {
      const record = (s.state.presences || {})[accountId];
      if (record && typeof record === 'object') {
        for (const key of Object.keys(record)) delete record[key];
        Object.assign(record, emptyPresence());
      }
      s.syncFocused();
      s.log('WARN', 'Presence', 'A saved presence could not be rebuilt and was cleared.');
      continue;
    }
    resumed += 1;
    s.log('INFO', 'Presence', `Resumed ${presenceTitle(payload)}.`);
  }
  if (resumed) {
    s.log(
      'INFO',
      'Presence',
      `Restored ${resumed} live presence${resumed !== 1 ? 's' : ''} from the previous session.`
    );
  }
  s.save();
  return resumed;
}

class Ticker {
  constructor() {
    this.timer = null;
    this.lastSent = new Map();
    this.lastTemplate = new Map();
    this.lastCycle = new Map();
    this.stopped = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.stopped) return;
      this.tick().catch((error) => {
        const s = store();
        if (s) s.log('WARN', 'Ticker', error.message);
      });
    }, 5000);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    const s = store();
    if (!s) return;
    await this.runAutomation();
    const accountIds = Object.keys(s.state.presences || {});
    for (const accountId of accountIds) {
      try {
        await this.tickAccount(accountId);
      } catch (error) {
        s.log('WARN', 'Ticker', error.message);
      }
    }
  }

  async tickAccount(accountId) {
    const s = store();
    const presence = (s.state.presences || {})[accountId] || {};
    const active = presence.active;
    if (!active) {
      this.lastSent.delete(accountId);
      this.lastTemplate.delete(accountId);
      this.lastCycle.delete(accountId);
      return;
    }
    const kind = active.kind;
    const started = presence.startedAt || nowMs();
    const cfg = { ...(s.customFor(accountId) || {}) };
    const view = accountView(s.state, accountId);
    let interval = 0;
    if (kind === 'cycling') {
      const cyc = s.state.cycling || {};
      if (cyc.mode === 'cycle') interval = Math.max(15, safeInt(cyc.interval, 30) || 30);
    } else if (kind === 'experimental') {
      const exp = s.state.experimental || {};
      if (exp.mode === 'switch') interval = Math.max(5, safeInt(exp.interval, 15) || 15);
    }
    if (interval) {
      const elapsed = Math.max(0, (nowMs() - started) / 1000);
      const idx = Math.trunc(elapsed / interval);
      if (idx !== (this.lastCycle.has(accountId) ? this.lastCycle.get(accountId) : -1)) {
        this.lastCycle.set(accountId, idx);
        await sendCurrentPresence({ cycleIndex: idx, accountId });
        return;
      }
    }
    // Refresh dynamic clock/date tokens once a minute when running.
    const now = Date.now();
    if (kind === 'custom' && now - (this.lastSent.get(accountId) || 0) >= 60000) {
      const rendered =
        expandTemplate(cfg.name || '', view) +
        '|' +
        expandTemplate(cfg.details || '', view) +
        '|' +
        expandTemplate(cfg.state || '', view);
      if (rendered !== (this.lastTemplate.get(accountId) || '')) {
        this.lastTemplate.set(accountId, rendered);
        this.lastSent.set(accountId, now);
        await sendCurrentPresence({ force: true, accountId });
      }
    }
  }

  async runAutomation() {
    const s = store();
    if (!s) return;
    const focused = s.activeAccountId();
    if (!focused || !s.activeToken()) return;
    const data = s.state.automation || {};
    if (!data.enabled) return;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const minuteKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
      now.getHours()
    )}:${pad(now.getMinutes())}`;
    const focusedRecord = (s.state.presences || {})[focused] || {};
    if (focusedRecord.active) return;
    for (const rule of data.rules || []) {
      if (!rule || typeof rule !== 'object' || !rule.enabled) continue;
      if (rule.lastFired === minuteKey) continue;
      const days = rule.days || [];
      const weekday = (now.getDay() + 6) % 7;
      if (days.length && !days.map((d) => safeInt(d, -1)).includes(weekday)) continue;
      if (String(rule.time || '') !== `${pad(now.getHours())}:${pad(now.getMinutes())}`) continue;
      const action = String(rule.action || 'custom');
      if (!PRESENCE_KINDS[action]) continue;
      rule.lastFired = minuteKey;
      s.save();
      const name = rule.name || action;
      try {
        await startPresence(action, { automation: name });
        s.log('INFO', 'Automation', `Started “${name}” on schedule.`);
      } catch (error) {
        s.log('WARN', 'Automation', `Could not run “${name}”: ${error.message}`);
      }
      break;
    }
  }
}

module.exports = {
  presenceRecord,
  sendCurrentPresence,
  stopPresence,
  startPresence,
  refreshPresence,
  resumeLivePresences,
  Ticker,
};
