'use strict';

const fs = require('fs');
const path = require('path');
const rt = require('./runtime');
const {
  STATE_FILE,
  SECRET_FILE,
  HISTORY_FILE,
  LOG_FILE,
  VERSION,
  ACCOUNT_LIMIT,
  PRESENCE_KINDS,
} = require('./constants');
const {
  nowMs,
  cleanDiscordToken,
  uuidHex,
  safeInt,
  isPlainObject,
  deepClone,
} = require('./util');
const {
  defaultState,
  defaultChat,
  defaultGatewayRecord,
  emptyPresence,
  defaultCustom,
  HOST_DEVICE,
} = require('./defaults');
const { accountPublic, scrub, safeAuthError } = require('./scrub');
const { normalizeMirrorState, coerceMirrorWebhook } = require('./mirror-normalize');

function coerceAccountRecord(raw, fallbackToken = '', fallbackAt = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const user = isPlainObject(raw.user) ? raw.user : {};
  const flat = {
    id: raw.userId || raw.id_ || '',
    username: raw.username || '',
    globalName: raw.globalName || '',
    displayName: raw.displayName || '',
    avatar: raw.avatar || '',
    avatarUrl: raw.avatarUrl || '',
  };
  const mergedUser = { ...user };
  for (const [key, value] of Object.entries(flat)) {
    if (value && !mergedUser[key]) mergedUser[key] = value;
  }
  const token = cleanDiscordToken(raw.token || fallbackToken);
  const uid = String(mergedUser.id || raw.userId || '');
  const username = String(mergedUser.username || '');
  const display = String(mergedUser.displayName || mergedUser.globalName || username || 'Discord account');
  const avatar = String(mergedUser.avatar || '');
  let avatarUrl = String(mergedUser.avatarUrl || '');
  if (!avatarUrl && uid) {
    if (avatar) {
      const ext = avatar.startsWith('a_') ? 'gif' : 'png';
      avatarUrl = `https://cdn.discordapp.com/avatars/${uid}/${avatar}.${ext}?size=128`;
    } else {
      let index = 0;
      try {
        index = Number(BigInt(uid) >> 22n) % 6;
      } catch {
        index = 0;
      }
      avatarUrl = `https://cdn.discordapp.com/embed/avatars/${index}.png`;
    }
  }
  mergedUser.id = uid;
  mergedUser.username = username;
  mergedUser.globalName = String(mergedUser.globalName || '');
  mergedUser.displayName = display;
  mergedUser.avatar = avatar;
  mergedUser.avatarUrl = avatarUrl;
  mergedUser.email = '';
  if (!token && !uid && !username) return null;
  let accountId = String(raw.id || '');
  if (!accountId.startsWith('acct_') || accountId.length < 8) accountId = 'acct_' + uuidHex(6);
  const now = nowMs();
  return {
    id: accountId,
    token,
    tokenSetAt: token ? raw.tokenSetAt : null,
    authKind: token ? 'token' : 'none',
    addedAt: raw.addedAt || fallbackAt || now,
    lastUsedAt: raw.lastUsedAt || null,
    needsAuth: Boolean(raw.needsAuth) || !token,
    authError: String(raw.authError || '').slice(0, 220),
    user: mergedUser,
  };
}

class Store {
  constructor() {
    this.subscribers = new Set();
    this.state = {};
    this.secret = {};
    this.history = [];
    this.logs = [];
    this.load();
  }

  // -- persistence -------------------------------------------------------
  static readJson(file, fallback) {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      console.error(`[state] could not read ${path.basename(file)}: ${error.message}`);
    }
    return fallback;
  }

  static atomicWrite(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A unique temp name keeps two processes from clobbering each other's
    // half-written file if they ever share a data directory.
    const tmp = `${file}.${process.pid}.${(Store.writeSeq = (Store.writeSeq || 0) + 1)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
      throw error;
    }
  }

  load() {
    this.state = Store.readJson(STATE_FILE, defaultState());
    this.secret = Store.readJson(SECRET_FILE, { token: '', tokenSetAt: null });
    if (!isPlainObject(this.state)) this.state = defaultState();
    if (!isPlainObject(this.secret)) this.secret = { token: '', tokenSetAt: null };
    this.state.host = HOST_DEVICE;
    this.state.device = HOST_DEVICE;
    this.history = Store.readJson(HISTORY_FILE, []);
    if (!Array.isArray(this.history)) this.history = [];
    this.state.history = this.history.slice(-120).reverse();
    const chat = this.state.chat;
    if (!isPlainObject(chat) || !('rooms' in chat)) this.state.chat = defaultChat();
    this.state.chat.messages = isPlainObject(this.state.chat.messages) ? this.state.chat.messages : {};
    for (const room of this.state.chat.rooms || []) {
      if (!(room.id in this.state.chat.messages)) this.state.chat.messages[room.id] = [];
    }
    this.state.gateway = defaultGatewayRecord();
    this.state.gateways = {};
    this.state.mirror = normalizeMirrorState(this.state.mirror);
    const rawWebhooks = this.secret.mirrorWebhooks;
    const webhooks = {};
    if (isPlainObject(rawWebhooks)) {
      for (const [ruleId, raw] of Object.entries(rawWebhooks)) {
        const record = coerceMirrorWebhook(raw);
        if (record && String(ruleId).startsWith('mirror_')) webhooks[String(ruleId)] = record;
      }
    }
    this.secret.mirrorWebhooks = webhooks;
    this.state.version = VERSION;
    this.state.logs = [];
    this.normalizeAccounts();
    this.normalizeCustoms();
    this.restorePresences();
    this.syncFocused();
    this.save();
  }

  save() {
    Store.atomicWrite(STATE_FILE, this.state);
    Store.atomicWrite(SECRET_FILE, this.secret);
    try {
      fs.chmodSync(SECRET_FILE, 0o600);
    } catch {
      // shared Android storage rejects chmod
    }
    Store.atomicWrite(HISTORY_FILE, this.history.slice(-300));
  }

  // -- accounts ----------------------------------------------------------
  normalizeAccounts() {
    const rawAccounts = Array.isArray(this.secret.accounts) ? this.secret.accounts : [];
    let accounts = [];
    const byUser = new Map();
    const byToken = new Map();
    for (const raw of rawAccounts) {
      const account = coerceAccountRecord(raw);
      if (!account) continue;
      const userId = String(account.user.id || '');
      const token = String(account.token || '');
      let existing = userId ? byUser.get(userId) : null;
      if (!existing && token) existing = byToken.get(token);
      if (existing) {
        if (token) {
          existing.token = token;
          existing.tokenSetAt = account.tokenSetAt || existing.tokenSetAt;
          existing.needsAuth = false;
          existing.authError = '';
          byToken.set(token, existing);
        }
        if (account.lastUsedAt) existing.lastUsedAt = account.lastUsedAt;
        existing.user = { ...existing.user, ...Object.fromEntries(Object.entries(account.user).filter(([, v]) => v)) };
        continue;
      }
      accounts.push(account);
      if (userId) byUser.set(userId, account);
      if (token) byToken.set(token, account);
    }

    const legacyToken = cleanDiscordToken(this.secret.token || '');
    const legacyUser = isPlainObject(this.state.account) ? this.state.account : {};
    if (legacyToken && !byToken.has(legacyToken)) {
      const legacyId = String(legacyUser.id || '');
      const match = legacyId ? byUser.get(legacyId) : null;
      if (match) {
        match.token = legacyToken;
        match.tokenSetAt = this.secret.tokenSetAt || nowMs();
        match.needsAuth = false;
        match.authError = '';
        byToken.set(legacyToken, match);
      } else {
        const account = coerceAccountRecord(
          {
            token: legacyToken,
            tokenSetAt: this.secret.tokenSetAt,
            addedAt: this.secret.tokenSetAt || nowMs(),
            user: legacyUser,
          },
          legacyToken
        );
        if (account) {
          accounts.push(account);
          byToken.set(legacyToken, account);
          if (account.user.id) byUser.set(String(account.user.id), account);
        }
      }
    }

    if (accounts.length > ACCOUNT_LIMIT) {
      const activeHint = String(this.secret.activeId || '');
      const keep = accounts.slice(0, ACCOUNT_LIMIT);
      if (activeHint) {
        const activeRecord = accounts.find((account) => account.id === activeHint);
        if (activeRecord && !keep.includes(activeRecord)) keep[keep.length - 1] = activeRecord;
      }
      accounts = keep;
    }

    const activeId = String(this.secret.activeId || '');
    let active = accounts.find((account) => account.id === activeId) || null;
    if (!active && legacyToken) active = byToken.get(legacyToken) || null;
    if (!active || !cleanDiscordToken(active.token)) {
      active = accounts.find((account) => cleanDiscordToken(account.token)) || null;
    }
    if (active) {
      this.secret.activeId = active.id;
      this.secret.token = cleanDiscordToken(active.token);
      this.secret.tokenSetAt = this.secret.token ? active.tokenSetAt : null;
      this.state.account = deepClone(active.user);
      if (cleanDiscordToken(active.token)) this.secret.authError = '';
    } else {
      this.secret.activeId = '';
      this.secret.token = '';
      this.secret.tokenSetAt = null;
      this.state.account = null;
    }
    this.secret.accounts = accounts;
    this.state.gateway = this.state.gateway || {};
    this.state.gateway.tokenSet = Boolean(this.secret.token);
    if (!('authError' in this.secret)) this.secret.authError = '';
  }

  restorePresences() {
    const raw = isPlainObject(this.state.presences) ? this.state.presences : {};
    const accounts = new Map(
      (this.secret.accounts || []).filter((row) => row && row.id).map((row) => [String(row.id), row])
    );
    const restored = {};
    for (const [accountIdRaw, record] of Object.entries(raw)) {
      const accountId = String(accountIdRaw || '');
      const account = accounts.get(accountId);
      if (!account || !cleanDiscordToken(account.token)) continue;
      if (!isPlainObject(record)) continue;
      const active = record.active;
      if (!isPlainObject(active)) continue;
      const kind = String(active.kind || '');
      if (!(kind in PRESENCE_KINDS)) continue;
      const started =
        safeInt(record.startedAt, 0) ||
        safeInt(active.startedAt, 0) ||
        nowMs();
      const cleaned = emptyPresence();
      cleaned.active = { kind, title: String(active.title || '').slice(0, 200), startedAt: started };
      cleaned.startedAt = started;
      cleaned.updatedAt = safeInt(record.updatedAt, null);
      cleaned.cycleIndex = Math.max(0, safeInt(record.cycleIndex, 0) || 0);
      restored[accountId] = cleaned;
    }
    this.state.presences = restored;
    const activeId = String(this.secret.activeId || '');
    this.state.presence = deepClone(restored[activeId] || emptyPresence());
  }

  normalizeCustoms() {
    let customs = this.state.customs;
    if (!isPlainObject(customs)) customs = {};
    const seed = isPlainObject(this.state.custom) ? this.state.custom : defaultCustom();
    const accountIds = (this.secret.accounts || [])
      .map((row) => String(row.id || ''))
      .filter(Boolean);
    const active = String(this.secret.activeId || '');
    if (active && !accountIds.includes(active)) accountIds.push(active);
    for (const accountId of accountIds) {
      if (!isPlainObject(customs[accountId])) customs[accountId] = deepClone(seed);
    }
    this.state.customs = customs;
    if (active) {
      const chosen = customs[active];
      this.state.custom = deepClone(isPlainObject(chosen) ? chosen : seed);
    } else if (!isPlainObject(this.state.custom)) {
      this.state.custom = deepClone(seed);
    }
  }

  customSeed() {
    return isPlainObject(this.state.custom) ? deepClone(this.state.custom) : defaultCustom();
  }

  customFor(accountId = '') {
    accountId = String(accountId || '') || this.activeAccountId();
    let customs = this.state.customs;
    if (!isPlainObject(customs)) {
      customs = {};
      this.state.customs = customs;
    }
    let record = accountId ? customs[accountId] : null;
    if (!isPlainObject(record)) {
      if (accountId) {
        record = this.customSeed();
        customs[accountId] = record;
      } else {
        record = isPlainObject(this.state.custom) ? this.state.custom : defaultCustom();
      }
    }
    return record;
  }

  adoptFocusedCustom() {
    const accountId = this.activeAccountId();
    const custom = this.state.custom;
    if (!accountId || !isPlainObject(custom)) return;
    let customs = this.state.customs;
    if (!isPlainObject(customs)) {
      customs = {};
      this.state.customs = customs;
    }
    customs[accountId] = deepClone(custom);
  }

  publicAccounts() {
    return (this.secret.accounts || []).map((account) => accountPublic(account));
  }

  activeAccountId() {
    const activeId = String(this.secret.activeId || '');
    for (const account of this.secret.accounts || []) {
      if (account.id === activeId && cleanDiscordToken(account.token)) return activeId;
    }
    return '';
  }

  activeAccount(includeToken = false) {
    const activeId = String(this.secret.activeId || '');
    for (const account of this.secret.accounts || []) {
      if (account.id === activeId) {
        const result = deepClone(account);
        if (!includeToken) delete result.token;
        return result;
      }
    }
    return null;
  }

  accountById(accountId, includeToken = false) {
    accountId = String(accountId || '');
    for (const account of this.secret.accounts || []) {
      if (account.id === accountId) {
        const result = deepClone(account);
        if (!includeToken) delete result.token;
        return result;
      }
    }
    return null;
  }

  activeToken() {
    const account = this.activeAccount(true);
    if (account && cleanDiscordToken(account.token)) return cleanDiscordToken(account.token);
    if (String(this.secret.activeId || '')) return '';
    return cleanDiscordToken(this.secret.token || '');
  }

  upsertAccount(token, user) {
    token = cleanDiscordToken(token);
    if (!token) throw new Error('Paste a Discord account token first.');
    user = { ...(user || {}) };
    const userId = String(user.id || '');
    const accounts = this.secret.accounts || (this.secret.accounts = []);
    let existing = null;
    for (const account of accounts) {
      if (userId && String((account.user || {}).id || '') === userId) {
        existing = account;
        break;
      }
      if (cleanDiscordToken(account.token) === token) {
        existing = account;
        break;
      }
    }
    let created = false;
    if (!existing) {
      if (accounts.length >= ACCOUNT_LIMIT) {
        throw new Error(`You can save up to ${ACCOUNT_LIMIT} Discord accounts.`);
      }
      existing = coerceAccountRecord({ token, user });
      if (!existing) throw new Error('Discord did not return a usable account.');
      accounts.push(existing);
      created = true;
    } else {
      const oldToken = cleanDiscordToken(existing.token);
      existing.token = token;
      if (oldToken !== token || !existing.tokenSetAt) existing.tokenSetAt = nowMs();
      existing.user = { ...(existing.user || {}), ...user, email: '' };
      existing.authKind = 'token';
      existing.needsAuth = false;
      existing.authError = '';
    }
    this.customFor(existing.id);
    this.save();
    return { account: deepClone(existing), created };
  }

  activateAccount(accountId, user = null) {
    const account = (this.secret.accounts || []).find((row) => row.id === accountId);
    if (!account || !cleanDiscordToken(account.token)) {
      throw new Error('That account has no saved token. Add it again.');
    }
    const token = cleanDiscordToken(account.token);
    if (user) account.user = { ...(account.user || {}), ...user, email: '' };
    account.needsAuth = false;
    account.authError = '';
    account.lastUsedAt = nowMs();
    this.secret.activeId = account.id;
    this.secret.token = token;
    this.secret.tokenSetAt = token ? account.tokenSetAt : null;
    this.secret.authError = '';
    this.state.account = deepClone(account.user || {});
    const gateway = this.state.gateway || (this.state.gateway = {});
    gateway.tokenSet = Boolean(token);
    gateway.error = '';
    this.save();
    return deepClone(account);
  }

  markAccountAuthFailed(accountId, message) {
    const account = (this.secret.accounts || []).find((row) => row.id === accountId);
    const safe = safeAuthError(
      message || 'Discord rejected this token.',
      cleanDiscordToken((account || {}).token)
    ).slice(0, 220);
    if (account) {
      account.token = '';
      account.tokenSetAt = null;
      account.needsAuth = true;
      account.authError = safe;
    }
    if (String(this.secret.activeId || '') === accountId) {
      this.secret.token = '';
      this.secret.tokenSetAt = null;
      this.secret.activeId = '';
      this.secret.authError = safe;
      this.state.account = null;
      const gateway = this.state.gateway || (this.state.gateway = {});
      gateway.tokenSet = false;
      gateway.error = safe;
    }
    this.save();
  }

  removeAccount(accountId) {
    const accounts = this.secret.accounts || [];
    const removed = accounts.find((row) => row.id === accountId) || null;
    if (!removed) return null;
    const wasActive = String(this.secret.activeId || '') === accountId;
    this.secret.accounts = accounts.filter((row) => row.id !== accountId);
    const customs = this.state.customs;
    if (isPlainObject(customs)) delete customs[accountId];
    const rules = (this.state.mirror && this.state.mirror.rules) || [];
    for (const rule of rules) {
      if ([rule.sourceAccountId, rule.destAccountId].includes(accountId)) {
        rule.enabled = false;
        rule.lastError = 'A Discord account used by this rule was removed.';
      }
    }
    if (wasActive) {
      const next = (this.secret.accounts || []).find((row) => cleanDiscordToken(row.token)) || null;
      if (next) {
        this.secret.activeId = next.id;
        this.secret.token = cleanDiscordToken(next.token);
        this.secret.tokenSetAt = next.tokenSetAt;
        this.secret.authError = '';
        this.state.account = deepClone(next.user || {});
        this.state.gateway.tokenSet = true;
      } else {
        this.secret.activeId = '';
        this.secret.token = '';
        this.secret.tokenSetAt = null;
        this.secret.authError = '';
        this.state.account = null;
        this.state.gateway.tokenSet = false;
      }
    }
    this.save();
    return {
      removed: accountPublic(removed),
      wasActive,
      nextId: String(this.secret.activeId || ''),
    };
  }

  removeAllAccounts() {
    const count = (this.secret.accounts || []).length;
    this.secret.accounts = [];
    this.secret.activeId = '';
    this.secret.token = '';
    this.secret.tokenSetAt = null;
    this.secret.authError = '';
    this.state.account = null;
    this.state.gateway.tokenSet = false;
    this.state.customs = {};
    for (const rule of (this.state.mirror && this.state.mirror.rules) || []) {
      rule.enabled = false;
      rule.lastError = 'No Discord account is available.';
    }
    this.save();
    return count;
  }

  // -- focused-account mirror --------------------------------------------
  syncFocused() {
    const accountId = String(this.secret.activeId || '');
    const gateways = this.state.gateways || (this.state.gateways = {});
    const presences = this.state.presences || (this.state.presences = {});
    const record = deepClone(gateways[accountId] || defaultGatewayRecord());
    record.tokenSet = Boolean(this.activeToken());
    if (!accountId) record.connected = false;
    this.state.gateway = record;
    this.state.presence = deepClone(presences[accountId] || emptyPresence());
    if (accountId) {
      let customs = this.state.customs;
      if (!isPlainObject(customs)) {
        customs = {};
        this.state.customs = customs;
      }
      let custom = customs[accountId];
      if (!isPlainObject(custom)) {
        custom = this.customSeed();
        customs[accountId] = custom;
      }
      this.state.custom = deepClone(custom);
    } else if (!isPlainObject(this.state.custom)) {
      this.state.custom = defaultCustom();
    }
  }

  // -- events ------------------------------------------------------------
  subscribe(callback) {
    this.subscribers.add(callback);
    return callback;
  }

  unsubscribe(callback) {
    this.subscribers.delete(callback);
  }

  publish(event) {
    for (const callback of [...this.subscribers]) {
      try {
        callback(event);
      } catch {
        // a dead SSE connection should not break the others
      }
    }
  }

  broadcastState() {
    const { publicState } = require('./state');
    this.publish({ type: 'state', state: publicState() });
  }

  // -- logs --------------------------------------------------------------
  log(level, tag, message) {
    const safe = scrub(message);
    const entry = {
      id: uuidHex(5),
      time: nowMs(),
      level: String(level || 'INFO').toUpperCase(),
      tag: String(tag || 'Web'),
      message: safe,
    };
    this.logs.unshift(entry);
    if (this.logs.length > 400) this.logs.length = 400;
    this.state.logs = this.logs.slice(0, 200);
    try {
      const stamp = new Date().toTimeString().slice(0, 8);
      fs.appendFileSync(LOG_FILE, `${stamp} [${entry.level.padEnd(5)}] ${entry.tag}: ${entry.message}\n`, 'utf8');
    } catch {
      // best effort
    }
    this.publish({ type: 'log', log: entry });
    if (['ERROR', 'WARN'].includes(entry.level)) {
      console.error(`[${entry.level}] ${entry.tag}: ${entry.message}`);
    }
  }

  touch(broadcast = true) {
    this.save();
    if (broadcast) this.broadcastState();
  }

  addHistory(kind, label, title, startedAt, endedAt) {
    if (!startedAt || endedAt <= startedAt) return;
    if (this.state.settings && this.state.settings.showPresenceHistory === false) return;
    const entry = {
      id: uuidHex(5),
      kind,
      label,
      title,
      startedAt,
      endedAt,
      seconds: Math.max(1, Math.trunc((endedAt - startedAt) / 1000)),
    };
    this.history.push(entry);
    this.history = this.history.slice(-300);
    this.state.history = this.history.slice(-120).reverse();
    this.save();
  }
}

module.exports = { Store, coerceAccountRecord, accountPublic };