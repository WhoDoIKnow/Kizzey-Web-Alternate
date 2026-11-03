'use strict';

const {
  MIRROR_DEFAULT_INTERVAL,
  MIRROR_MODES,
  MIRROR_RULE_LIMIT,
} = require('./constants');
const { nowMs, uuidHex, clamp } = require('./util');

function mirrorBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Boolean(value);
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
    if (['false', '0', 'no', 'off'].includes(lowered)) return false;
  }
  return fallback;
}

function snowflakeText(value, limit = 32) {
  const text = String(value || '').trim();
  return /^\d+$/.test(text) && text.length <= limit ? text : '';
}

function normalizeMirrorMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return MIRROR_MODES.includes(mode) ? mode : 'normal';
}

function coerceMirrorWebhook(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const webhookId = snowflakeText(raw.id);
  const channelId = snowflakeText(raw.channelId);
  const token = String(raw.token || '').trim();
  if (!webhookId || !channelId || !token) return null;
  if (token.length > 200 || !/^[A-Za-z0-9_.-]{10,200}$/.test(token)) return null;
  const name = (String(raw.name || 'Kizzey mirror').trim() || 'Kizzey mirror').slice(0, 80);
  let created = raw.createdAt;
  if (typeof created !== 'number') created = nowMs();
  return { id: webhookId, token, channelId, name, createdAt: created };
}

function nonnegInt(value, fallback = 0, cap = 1000000000) {
  let number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  number = Math.trunc(number);
  return Math.max(0, Math.min(cap, number));
}

function defaultMirrorState() {
  return { enabled: false, interval: MIRROR_DEFAULT_INTERVAL, rules: [], lastRunAt: null, lastError: '' };
}

function normalizeMirrorRule(raw, fresh = false) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let ruleId = String(raw.id || '').trim();
  if (!ruleId.startsWith('mirror_') || ruleId.length > 40) ruleId = 'mirror_' + uuidHex(6);
  const sourceAccount = String(raw.sourceAccountId || '').trim().slice(0, 64);
  const destAccount = String(raw.destAccountId || '').trim().slice(0, 64);
  const sourceChannel = snowflakeText(raw.sourceChannel);
  const destChannel = snowflakeText(raw.destChannel);
  if (!sourceAccount || !destAccount || !sourceChannel || !destChannel) return null;
  if (sourceChannel === destChannel) return null;
  const now = nowMs();
  const name = String(raw.name || '').trim().slice(0, 80);
  const sourceLabel = String(raw.sourceLabel || '').trim().slice(0, 120);
  const destLabel = String(raw.destLabel || '').trim().slice(0, 120);
  const rule = {
    id: ruleId,
    name: name || 'Message relay',
    enabled: mirrorBool(raw.enabled, true),
    sourceAccountId: sourceAccount,
    sourceChannel,
    sourceLabel: sourceLabel || '#' + sourceChannel,
    destAccountId: destAccount,
    destChannel,
    destLabel: destLabel || '#' + destChannel,
    mode: normalizeMirrorMode(raw.mode),
    includeOwn: mirrorBool(raw.includeOwn, false),
    includeBots: mirrorBool(raw.includeBots, false),
    includeAttachments: mirrorBool(raw.includeAttachments, true),
    includeEmbeds: mirrorBool(raw.includeEmbeds, true),
    primed: mirrorBool(raw.primed, false),
    lastSeenId: snowflakeText(raw.lastSeenId),
    lastRunAt: typeof raw.lastRunAt === 'number' ? raw.lastRunAt : null,
    lastMirroredAt: typeof raw.lastMirroredAt === 'number' ? raw.lastMirroredAt : null,
    lastError: String(raw.lastError || '').slice(0, 260),
    mirrored: nonnegInt(raw.mirrored),
    skipped: nonnegInt(raw.skipped),
    failures: nonnegInt(raw.failures),
    retryAfter: nonnegInt(raw.retryAfter, 0, 1e15),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
  };
  if (fresh) {
    rule.primed = false;
    rule.lastSeenId = '';
    rule.lastError = '';
    rule.mirrored = 0;
    rule.skipped = 0;
    rule.failures = 0;
    rule.retryAfter = 0;
    rule.lastMirroredAt = null;
    rule.createdAt = now;
  }
  return rule;
}

function normalizeMirrorState(raw) {
  const state = defaultMirrorState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;
  state.enabled = mirrorBool(raw.enabled, false);
  const interval = Number(raw.interval || MIRROR_DEFAULT_INTERVAL);
  state.interval = Number.isFinite(interval)
    ? Math.trunc(clamp(interval, 5, 300))
    : MIRROR_DEFAULT_INTERVAL;
  state.lastRunAt = typeof raw.lastRunAt === 'number' ? raw.lastRunAt : null;
  state.lastError = String(raw.lastError || '').slice(0, 260);
  const rules = [];
  const seen = new Set();
  for (const item of (Array.isArray(raw.rules) ? raw.rules : []).slice(0, MIRROR_RULE_LIMIT)) {
    const rule = normalizeMirrorRule(item);
    if (!rule || seen.has(rule.id)) continue;
    rules.push(rule);
    seen.add(rule.id);
  }
  state.rules = rules;
  return state;
}

function prepareImportedMirror(value) {
  const mirror = normalizeMirrorState(value);
  const rawRules = value && typeof value === 'object' && Array.isArray(value.rules) ? value.rules : [];
  const rawCount = rawRules.length;
  mirror.enabled = false;
  mirror.lastError = '';
  mirror.lastRunAt = null;
  for (const rule of mirror.rules) {
    rule.enabled = false;
    rule.lastError = 'Imported paused. Review the relay, then enable it.';
  }
  const notes = [];
  if (mirror.rules.length) {
    const count = mirror.rules.length;
    notes.push(`${count} message mirror rule${count === 1 ? ' was' : 's were'} imported paused.`);
  }
  const dropped = Math.max(0, rawCount - mirror.rules.length);
  if (dropped) {
    notes.push(`${dropped} malformed message mirror rule${dropped === 1 ? ' was' : 's were'} dropped.`);
  }
  return { mirror, notes };
}

module.exports = {
  mirrorBool,
  snowflakeText,
  normalizeMirrorMode,
  coerceMirrorWebhook,
  nonnegInt,
  defaultMirrorState,
  normalizeMirrorRule,
  normalizeMirrorState,
  prepareImportedMirror,
};