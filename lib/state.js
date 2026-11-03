'use strict';

const rt = require('./runtime');
const { VERSION, ACCOUNT_LIMIT, MIRROR_RULE_LIMIT } = require('./constants');
const { nowMs, deepClone, isPlainObject } = require('./util');
const { HOST_DEVICE } = require('./defaults');
const { normalizeMirrorState, normalizeMirrorMode } = require('./mirror-normalize');

function publicMirrorRule(rule) {
  const result = deepClone(rule || {});
  result.mode = normalizeMirrorMode(result.mode);
  const ruleId = String(result.id || '');
  const store = rt.STORE;
  const record = store && store.secret && store.secret.mirrorWebhooks
    ? store.secret.mirrorWebhooks[ruleId]
    : null;
  result.webhookSet = Boolean(
    result.mode === 'webhook' && record && String(record.channelId || '') === String(result.destChannel || '')
  );
  return result;
}

function publicMirrorState() {
  const store = rt.STORE;
  const mirror = normalizeMirrorState(store ? store.state.mirror : null);
  mirror.rules = (mirror.rules || []).map((rule) => publicMirrorRule(rule));
  return mirror;
}

function publicState() {
  const store = rt.STORE;
  if (!store) return {};
  store.syncFocused();
  const data = deepClone(store.state);
  const accounts = store.publicAccounts();
  data.accounts = accounts;
  data.mirror = publicMirrorState();
  data.accountCount = accounts.length;
  data.accountLimit = ACCOUNT_LIMIT;
  data.mirrorRuleLimit = MIRROR_RULE_LIMIT;
  data.activeAccountId = store.activeAccountId();
  data.tokenSet = Boolean(store.activeToken());
  data.serverTime = nowMs();
  data.version = VERSION;
  data.gateway = data.gateway || {};
  data.gateway.tokenSet = Boolean(store.activeToken());
  data.host = HOST_DEVICE;
  data.logs = store.logs.slice(0, 120);
  return data;
}

const PROTECTED_PATCH_KEYS = new Set([
  'account', 'accounts', 'accountCount', 'activeAccountId', 'gateway', 'gateways',
  'presence', 'presences', 'history', 'logs', 'version', 'host', 'device',
  'startedAt', 'startedIso', 'firstRun', 'chat', 'mirror', 'customs',
  'tokenSet', 'tokenHint', 'serverTime',
]);

function visiblePatch(obj) {
  if (!isPlainObject(obj)) return {};
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !PROTECTED_PATCH_KEYS.has(key)));
}

function deepMergePatch(dst, src, depth = 0) {
  if (depth > 8 || !isPlainObject(dst) || !isPlainObject(src)) return dst;
  for (const [key, value] of Object.entries(src)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (value === null && key in dst) continue;
    if (isPlainObject(value) && isPlainObject(dst[key])) {
      deepMergePatch(dst[key], value, depth + 1);
    } else {
      dst[key] = deepClone(value);
    }
  }
  return dst;
}

const IMPORTABLE_STATE_GROUPS = new Set([
  'settings', 'custom', 'customs', 'apps', 'media', 'console', 'experimental', 'cycling',
  'multiple', 'health', 'location', 'weather', 'navigation', 'androidAuto',
  'samsung', 'emulation', 'screenRead', 'automation', 'drawer', 'chatProfile',
  'wallet', 'premium', 'quickControls', 'ui', 'recent', 'usage', 'savedConfigs',
  'bulk', 'plugins', 'gallery', 'appCatalog', 'mirror',
]);

module.exports = {
  publicState,
  publicMirrorState,
  publicMirrorRule,
  visiblePatch,
  deepMergePatch,
  PROTECTED_PATCH_KEYS,
  IMPORTABLE_STATE_GROUPS,
};