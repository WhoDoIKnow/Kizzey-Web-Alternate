'use strict';

// Port of the message mirror from server.py (4042-4903): managed relay
// webhooks, normal-mode relaying, priming, retries and rule CRUD.

const rt = require('./runtime');
const {
  MIRROR_RULE_LIMIT,
  MIRROR_MAX_MESSAGES,
  MIRROR_MARK,
  MIRROR_DEFAULT_INTERVAL,
} = require('./constants');
const { nowMs, clamp, sleep, cleanDiscordToken } = require('./util');
const { DiscordError, discordApi } = require('./discord');
const { scrub } = require('./scrub');
const {
  mirrorBool,
  snowflakeText,
  normalizeMirrorMode,
  coerceMirrorWebhook,
  defaultMirrorState,
  normalizeMirrorRule,
  normalizeMirrorState,
} = require('./mirror-normalize');
const { publicMirrorState, publicMirrorRule } = require('./state');

const MIRROR_WEBHOOK_LOCK = { busy: false };

function store() {
  return rt.STORE;
}

function withStore(fn) {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  return fn(s);
}

// -- channels / webhooks ---------------------------------------------------
async function fetchMirrorChannel(token, channelId) {
  channelId = snowflakeText(channelId);
  if (!channelId) {
    throw new Error('Channel IDs are numeric. Enable Developer Mode in Discord and copy the ID.');
  }
  const channel = await discordApi(`/channels/${channelId}`, token);
  if (!channel || typeof channel !== 'object') {
    throw new DiscordError(404, 'Discord did not return that channel.');
  }
  const channelType = Number(channel.type);
  const allowed = new Set([0, 1, 3, 5, 10, 11, 12, 15]);
  if (!allowed.has(channelType)) {
    throw new Error('Choose a text channel, announcement channel, thread or direct message.');
  }
  const recipients = channel.recipients || [];
  let label;
  if (channelType === 1 || channelType === 3) {
    const names = recipients
      .filter((item) => item && typeof item === 'object')
      .map((item) => String(item.global_name || item.username || 'Unknown'));
    if (channelType === 1) {
      label = 'DM · ' + (names[0] || 'Direct message');
    } else {
      label = 'Group DM · ' + (channel.name || names.slice(0, 3).join(', ') || 'Group');
    }
  } else {
    label = '#' + String(channel.name || channelId);
  }
  return {
    id: String(channel.id || channelId),
    label: label.slice(0, 120),
    name: String(channel.name || ''),
    type: channelType,
    guildId: String(channel.guild_id || ''),
  };
}

function mirrorWebhookFor(ruleId) {
  if (!ruleId) return null;
  const s = store();
  if (!s) return null;
  const webhooks = s.secret.mirrorWebhooks;
  const raw = webhooks && typeof webhooks === 'object' ? webhooks[ruleId] : null;
  const record = coerceMirrorWebhook(raw);
  return record ? { ...record } : null;
}

function storeMirrorWebhook(ruleId, record) {
  const s = withStore((st) => st);
  if (!s.secret.mirrorWebhooks || typeof s.secret.mirrorWebhooks !== 'object') {
    s.secret.mirrorWebhooks = {};
  }
  s.secret.mirrorWebhooks[ruleId] = { ...record };
  s.save();
}

function forgetMirrorWebhook(ruleId) {
  const s = store();
  if (!s) return;
  const webhooks = s.secret.mirrorWebhooks;
  if (webhooks && typeof webhooks === 'object' && ruleId in webhooks) {
    delete webhooks[ruleId];
    s.save();
  }
}

async function deleteDiscordWebhook(record) {
  const webhookId = snowflakeText((record || {}).id);
  const token = String((record || {}).token || '').trim();
  if (!webhookId || !token) return true;
  try {
    await discordApi(`/webhooks/${webhookId}/${token}`, '', 'DELETE', null, 6);
    return true;
  } catch (error) {
    if (error instanceof DiscordError) {
      if ([401, 403, 404].includes(error.status)) return true;
      const s = store();
      if (s) s.log('WARN', 'Mirror', `Could not delete a managed webhook: ${scrub(error.message)}`);
      return false;
    }
    const s = store();
    if (s) s.log('WARN', 'Mirror', `Could not delete a managed webhook: ${scrub(error.message || error)}`);
    return false;
  }
}

async function deleteMirrorWebhook(ruleId, { remote = true, forgetOnFailure = false } = {}) {
  if (MIRROR_WEBHOOK_LOCK.busy) {
    // Serialise webhook housekeeping without a blocking lock.
    for (let i = 0; i < 100 && MIRROR_WEBHOOK_LOCK.busy; i += 1) await sleep(20);
  }
  MIRROR_WEBHOOK_LOCK.busy = true;
  try {
    const record = mirrorWebhookFor(ruleId);
    if (!record) return;
    if (remote && !(await deleteDiscordWebhook(record))) {
      if (forgetOnFailure) forgetMirrorWebhook(ruleId);
      return;
    }
    forgetMirrorWebhook(ruleId);
  } finally {
    MIRROR_WEBHOOK_LOCK.busy = false;
  }
}

async function purgeMirrorWebhooks({ forgetOnFailure = false } = {}) {
  let count = 0;
  const s = store();
  if (!s) return 0;
  const webhooks = s.secret.mirrorWebhooks;
  const ruleIds = webhooks && typeof webhooks === 'object' ? Object.keys(webhooks) : [];
  for (const ruleId of ruleIds) {
    await deleteMirrorWebhook(String(ruleId), { remote: true, forgetOnFailure });
    count += 1;
  }
  return count;
}

async function executeDiscordWebhook(record, payload) {
  const webhookId = snowflakeText((record || {}).id);
  const token = String((record || {}).token || '').trim();
  if (!webhookId || !token) {
    throw new Error('The relay webhook is missing. Edit the relay and save it again.');
  }
  return discordApi(`/webhooks/${webhookId}/${token}?wait=true`, '', 'POST', payload, 20);
}

async function ensureMirrorWebhook(rule, destToken, destInfo = null) {
  const s = withStore((st) => st);
  const ruleId = String((rule || {}).id || '');
  const destChannel = snowflakeText((rule || {}).destChannel);
  if (!ruleId || !destChannel) {
    throw new Error('That mirror rule is missing its destination.');
  }
  let existing = mirrorWebhookFor(ruleId);
  if (existing && String(existing.channelId || '') === destChannel) return existing;
  if (existing) {
    await deleteMirrorWebhook(ruleId, { remote: true });
    if (mirrorWebhookFor(ruleId)) {
      throw new Error('The old relay webhook could not be removed. Delete it in Discord and try again.');
    }
  }
  if (!destToken) {
    throw new Error('The destination account needs a Discord token for webhook mode.');
  }
  if (!destInfo) destInfo = await fetchMirrorChannel(destToken, destChannel);
  if (![0, 5].includes(Number(destInfo.type || 0))) {
    throw new Error(
      'Webhook mode needs a server text or announcement channel as the destination. ' +
        'Use normal mode for DMs, group DMs and threads.'
    );
  }
  let name = `Kizzey · ${rule.name || 'Message relay'}`.replace(/[\u0000-\u001f\u007f]/g, '');
  name = name.split(/\s+/).join(' ').trim().slice(0, 80) || 'Kizzey mirror';
  let created;
  try {
    created = await discordApi(`/channels/${destChannel}/webhooks`, destToken, 'POST', { name }, 15);
  } catch (error) {
    if (error instanceof DiscordError && [401, 403, 404].includes(error.status)) {
      throw new Error(
        'Webhook mode could not create a webhook in the destination channel. ' +
          'The destination account needs Manage Webhooks permission.'
      );
    }
    throw error;
  }
  const record = coerceMirrorWebhook({
    id: created && created.id,
    token: created && created.token,
    channelId: (created && created.channel_id) || destChannel,
    name: (created && created.name) || name,
  });
  if (!record) throw new DiscordError(0, 'Discord did not return a usable webhook.');
  storeMirrorWebhook(ruleId, record);
  s.log('INFO', 'Mirror', 'Created a managed webhook for a relay.');
  return { ...record };
}

// -- message rendering -----------------------------------------------------
function mirrorShouldSkip(message, rule, sourceUserId = '') {
  if (!message || typeof message !== 'object') return [true, 'malformed'];
  const author = message.author && typeof message.author === 'object' ? message.author : {};
  const content = String(message.content || '');
  if (content.includes(MIRROR_MARK)) return [true, 'loop'];
  if (![0, 19].includes(Number(message.type || 0))) return [true, 'system'];
  if (!rule.includeBots && (author.bot || author.system)) return [true, 'bot'];
  if (!rule.includeOwn && sourceUserId && String(author.id || '') === sourceUserId) {
    return [true, 'own'];
  }
  return [false, ''];
}

function mirrorAuthor(message) {
  return message && typeof message === 'object' && message.author && typeof message.author === 'object'
    ? message.author
    : {};
}

function mirrorSentMarkup(message) {
  const { parseTimestamp } = require('./util');
  const sent = parseTimestamp((message || {}).timestamp);
  if (!sent) return '';
  return `<t:${Math.trunc(sent / 1000)}:f>`;
}

function mirrorAuthorAvatarUrl(message) {
  const author = mirrorAuthor(message);
  const userId = String(author.id || '').trim();
  const avatar = String(author.avatar || '').trim();
  if (!userId) return '';
  if (avatar) {
    const ext = avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.${ext}?size=128`;
  }
  let index = 0;
  try {
    index = (Number(BigInt(userId)) >> 22n) % 6n;
  } catch {
    index = 0;
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function mirrorWebhookUsername(message) {
  const author = mirrorAuthor(message);
  let name = String(author.global_name || author.username || 'Discord user');
  name = name.replace(/[\u0000-\u001f\u007f]/g, '');
  name = name.split(/\s+/).join(' ').trim().slice(0, 80);
  return name || 'Discord user';
}

function mirrorExtraParts(message, rule) {
  const body = String((message || {}).content || '').trim();
  const extras = [];
  if (rule.includeAttachments !== false) {
    for (const attachment of (message || {}).attachments || []) {
      if (!attachment || typeof attachment !== 'object') continue;
      const url = String(attachment.url || attachment.proxy_url || '').trim();
      if (url && !body.includes(url)) extras.push(`<${url}>`);
    }
  }
  if (rule.includeEmbeds !== false) {
    for (const embed of (message || {}).embeds || []) {
      if (!embed || typeof embed !== 'object') continue;
      const url = String(embed.url || '').trim();
      if (url && !body.includes(url) && !extras.some((item) => item.includes(url))) {
        extras.push(`<${url}>`);
      }
    }
  }
  const stickers = [];
  for (const sticker of (message || {}).sticker_items || []) {
    if (sticker && typeof sticker === 'object' && sticker.name) stickers.push(String(sticker.name));
  }
  if (stickers.length) extras.push('[Sticker: ' + stickers.slice(0, 3).join(', ') + ']');
  return extras;
}

function finishMirrorContent(parts) {
  let content = parts.filter(Boolean).join('\n').trim();
  if (!content) return '';
  const limit = 1988 - MIRROR_MARK.length;
  if (content.length > limit) content = content.slice(0, limit).replace(/\s+$/, '');
  return content + MIRROR_MARK;
}

function buildMirrorContent(message, rule) {
  const author = mirrorAuthor(message);
  const display = String(author.global_name || author.username || 'Discord user').trim();
  const username = String(author.username || '').trim();
  let label = display || 'Discord user';
  if (username && !label.toLowerCase().includes(username.toLowerCase())) label += ` (@${username})`;
  const sent = mirrorSentMarkup(message);
  const header = `**${label}**` + (sent ? ` · ${sent}` : '');
  const body = String((message || {}).content || '').trim();
  const extras = mirrorExtraParts(message, rule);
  if (!body && !extras.length) return '';
  return finishMirrorContent([header, body, ...extras]);
}

function buildMirrorWebhookPayload(message, rule) {
  const body = String((message || {}).content || '').trim();
  const extras = mirrorExtraParts(message, rule);
  if (!body && !extras.length) return null;
  const content = finishMirrorContent([body, ...extras]);
  if (!content) return null;
  const payload = {
    username: mirrorWebhookUsername(message),
    content,
    allowed_mentions: { parse: [] },
  };
  const avatar = mirrorAuthorAvatarUrl(message);
  if (avatar) payload.avatar_url = avatar;
  return payload;
}

function mirrorRuleById(ruleId) {
  const s = store();
  if (!s) return null;
  const mirror = normalizeMirrorState(s.state.mirror);
  const rule = (mirror.rules || []).find((item) => item.id === ruleId);
  return rule ? { ...rule } : null;
}

// -- mirror loop -----------------------------------------------------------
class MessageMirror {
  constructor() {
    this.running = false;
    this.stopped = false;
    this.wakeResolve = null;
    this.lastPostAt = 0;
    this.runChain = Promise.resolve();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.loop();
  }

  stop() {
    this.stopped = true;
    this.kick();
  }

  kick() {
    if (this.wakeResolve) {
      const resolve = this.wakeResolve;
      this.wakeResolve = null;
      resolve();
    }
  }

  waiter(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeResolve = null;
        resolve();
      }, ms);
      this.wakeResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async loop() {
    while (!this.stopped) {
      let wait = MIRROR_DEFAULT_INTERVAL;
      try {
        const s = store();
        if (s) {
          const mirror = normalizeMirrorState(s.state.mirror);
          wait = Math.trunc(mirror.interval || MIRROR_DEFAULT_INTERVAL);
          if (mirror.enabled) {
            for (const rule of mirror.rules || []) {
              if (this.stopped) break;
              if (!rule.enabled) continue;
              try {
                await this.runRule(rule.id, { manual: false });
              } catch (error) {
                const current = mirrorRuleById(rule.id) || {};
                s.log('WARN', 'Mirror', `${current.name || 'Relay'}: ${scrub(error.message || error)}`);
              }
            }
          }
        }
      } catch (error) {
        const s = store();
        if (s) s.log('ERROR', 'Mirror', `Mirror loop failed: ${scrub(error.message || error)}`);
      }
      if (this.stopped) break;
      await this.waiter(Math.max(5, Math.min(300, wait)) * 1000);
    }
    this.running = false;
  }

  ruleSnapshot(ruleId) {
    const s = store();
    if (!s) return null;
    const mirror = normalizeMirrorState(s.state.mirror);
    const rule = (mirror.rules || []).find((item) => item.id === ruleId);
    if (!rule) return null;
    const result = { ...rule };
    const source = s.accountById(result.sourceAccountId, true);
    const dest = s.accountById(result.destAccountId, true);
    result._sourceToken = cleanDiscordToken((source || {}).token);
    result._destToken = cleanDiscordToken((dest || {}).token);
    result._sourceUserId = String(((source || {}).user || {}).id || '');
    result._sourceName = String(((source || {}).user || {}).displayName || 'Source account');
    result._destName = String(((dest || {}).user || {}).displayName || 'Destination account');
    return result;
  }

  updateRule(ruleId, changes) {
    const s = store();
    if (!s) return null;
    const mirror = normalizeMirrorState(s.state.mirror);
    const rule = (mirror.rules || []).find((item) => item.id === ruleId);
    if (!rule) return null;
    Object.assign(rule, changes);
    rule.updatedAt = nowMs();
    mirror.lastRunAt = nowMs();
    if (changes.lastError === '') mirror.lastError = '';
    s.state.mirror = mirror;
    s.save();
    return { ...rule };
  }

  recordError(rule, message, { retrySeconds = null } = {}) {
    const s = store();
    message = scrub(message);
    const failures = Math.trunc(rule.failures || 0) + 1;
    if (retrySeconds === null || retrySeconds === undefined) {
      retrySeconds = Math.min(300, 15 * 2 ** Math.min(4, failures - 1));
    }
    const retryAfter = nowMs() + Math.trunc(Math.max(5, retrySeconds) * 1000);
    const previous = String(rule.lastError || '');
    const updated =
      this.updateRule(rule.id, {
        lastError: message.slice(0, 260),
        failures,
        retryAfter,
        lastRunAt: nowMs(),
      }) || rule;
    if (s) {
      const mirror = normalizeMirrorState(s.state.mirror);
      mirror.lastError = message.slice(0, 260);
      mirror.lastRunAt = nowMs();
      s.state.mirror = mirror;
      s.save();
      if (message !== previous) {
        s.log('WARN', 'Mirror', `${rule.name || 'Relay'}: ${message}`);
      }
    }
    return updated;
  }

  async primeRule(ruleId) {
    const snapshot = this.ruleSnapshot(ruleId);
    if (!snapshot) throw new Error('That mirror rule no longer exists.');
    if (!snapshot._sourceToken) throw new Error('The source account needs a Discord token.');
    const source = snapshot.sourceChannel;
    let rows;
    try {
      rows = await discordApi(`/channels/${source}/messages?limit=1`, snapshot._sourceToken, 'GET', null, 15);
    } catch (error) {
      if (error instanceof DiscordError) {
        this.recordError(snapshot, `Could not read the source channel: ${error.message}`, {
          retrySeconds: 20,
        });
      }
      throw error;
    }
    let latest = '';
    if (Array.isArray(rows) && rows.length) latest = snowflakeText((rows[0] || {}).id);
    this.updateRule(ruleId, {
      primed: true,
      lastSeenId: latest,
      lastRunAt: nowMs(),
      lastError: '',
      failures: 0,
      retryAfter: 0,
    });
    return { ruleId, primed: true, lastSeenId: latest, mirrored: 0, skipped: 0 };
  }

  async runRule(ruleId, { manual = false } = {}) {
    const s = store();
    if (!s) throw new Error('Server not ready.');
    // Serialise runs per process so a manual run cannot overlap the loop.
    const previous = this.runChain;
    let release;
    this.runChain = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.runRuleInner(ruleId, manual);
    } finally {
      release();
    }
  }

  async runRuleInner(ruleId, manual) {
    const s = store();
    const snapshot = this.ruleSnapshot(ruleId);
    if (!snapshot) throw new Error('That mirror rule no longer exists.');
    if (!manual) {
      if (!snapshot.enabled) return { ruleId, mirrored: 0, skipped: 0, disabled: true };
      const retryAfter = Math.trunc(snapshot.retryAfter || 0);
      if (retryAfter && retryAfter > nowMs()) {
        return { ruleId, mirrored: 0, skipped: 0, cooldown: retryAfter };
      }
    }
    if (!snapshot._sourceToken) {
      this.recordError(snapshot, 'The source account needs a token.', { retrySeconds: 60 });
      throw new Error('The source account needs a Discord token.');
    }
    if (!snapshot._destToken) {
      this.recordError(snapshot, 'The destination account needs a token.', { retrySeconds: 60 });
      throw new Error('The destination account needs a Discord token.');
    }
    if (!snapshot.primed) {
      const result = await this.primeRule(ruleId);
      result.manual = manual;
      return result;
    }

    const mode = normalizeMirrorMode(snapshot.mode);
    let webhook = null;
    if (mode === 'webhook') {
      try {
        webhook = await ensureMirrorWebhook(snapshot, snapshot._destToken);
      } catch (error) {
        const message = error instanceof DiscordError ? error.message : String(error.message || error);
        const updated = this.recordError(snapshot, `Webhook mode is not ready: ${scrub(message)}`, {
          retrySeconds: 30,
        });
        return {
          ruleId,
          mirrored: 0,
          skipped: 0,
          error: updated.lastError,
          retryAfter: updated.retryAfter,
        };
      }
    }

    const source = snapshot.sourceChannel;
    let cursor = snapshot.lastSeenId || '';
    let path = `/channels/${source}/messages?limit=50`;
    if (cursor) path += `&after=${cursor}`;
    let rows;
    try {
      rows = await discordApi(path, snapshot._sourceToken, 'GET', null, 15);
    } catch (error) {
      let retry = null;
      if (error instanceof DiscordError && error.status === 429 && error.data) {
        const parsed = Number.parseFloat(String(error.data.retry_after || 0));
        retry = Number.isFinite(parsed) ? parsed : null;
      }
      const message =
        error instanceof DiscordError ? error.message : String(error.message || error);
      const updated = this.recordError(snapshot, `Could not read the source channel: ${message}`, {
        retrySeconds: retry,
      });
      return {
        ruleId,
        mirrored: 0,
        skipped: 0,
        error: updated.lastError,
        retryAfter: updated.retryAfter,
      };
    }
    if (!Array.isArray(rows)) rows = [];
    rows = rows.filter((row) => row && typeof row === 'object' && snowflakeText(row.id));
    rows.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
    rows = rows.slice(0, MIRROR_MAX_MESSAGES);
    let mirrored = 0;
    let skipped = 0;
    let currentCursor = cursor;
    for (const message of rows) {
      const messageId = snowflakeText(message.id);
      if (!messageId) continue;
      const [skip] = mirrorShouldSkip(message, snapshot, snapshot._sourceUserId || '');
      let payload = null;
      let content = '';
      if (!skip) {
        if (mode === 'webhook') {
          payload = buildMirrorWebhookPayload(message, snapshot);
          content = String((payload || {}).content || '');
        } else {
          content = buildMirrorContent(message, snapshot);
        }
      }
      if (skip || !content) {
        currentCursor = messageId;
        skipped += 1;
        this.updateRule(ruleId, {
          lastSeenId: currentCursor,
          skipped: Math.trunc(snapshot.skipped || 0) + skipped,
          lastRunAt: nowMs(),
          lastError: '',
          failures: 0,
          retryAfter: 0,
        });
        continue;
      }
      // A message being posted must still belong to the active rule
      // configuration and its accounts must still hold the same tokens;
      // removing or replacing an account mid-run must stop delivery now.
      const delay = 1.05 - (Date.now() / 1000 - this.lastPostAt);
      if (delay > 0 && rows.length > 1) await sleep(delay * 1000);
      const latestRule = this.ruleSnapshot(ruleId);
      if (
        !latestRule ||
        (!manual && !latestRule.enabled) ||
        latestRule.sourceChannel !== source ||
        latestRule.destChannel !== snapshot.destChannel ||
        normalizeMirrorMode(latestRule.mode) !== mode ||
        latestRule._sourceToken !== snapshot._sourceToken ||
        latestRule._destToken !== snapshot._destToken
      ) {
        break;
      }
      try {
        if (mode === 'webhook') {
          await executeDiscordWebhook(webhook, payload);
        } else {
          await discordApi(
            `/channels/${snapshot.destChannel}/messages`,
            snapshot._destToken,
            'POST',
            { content, allowed_mentions: { parse: [] } },
            20
          );
        }
        this.lastPostAt = Date.now() / 1000;
        mirrored += 1;
        currentCursor = messageId;
        this.updateRule(ruleId, {
          lastSeenId: currentCursor,
          mirrored: Math.trunc(snapshot.mirrored || 0) + mirrored,
          lastMirroredAt: nowMs(),
          lastRunAt: nowMs(),
          lastError: '',
          failures: 0,
          retryAfter: 0,
        });
      } catch (error) {
        let retry = null;
        if (error instanceof DiscordError && error.status === 429 && error.data) {
          const parsed = Number.parseFloat(String(error.data.retry_after || 0));
          retry = Number.isFinite(parsed) ? parsed : null;
        }
        if (mode === 'webhook' && error instanceof DiscordError && error.status === 404) {
          await deleteMirrorWebhook(ruleId, { remote: false });
        }
        const where = mode === 'webhook' ? 'the relay webhook' : 'the destination channel';
        const message = error instanceof DiscordError ? error.message : String(error.message || error);
        const updated = this.recordError(snapshot, `Could not post to ${where}: ${message}`, {
          retrySeconds: retry,
        });
        return {
          ruleId,
          mirrored,
          skipped,
          error: updated.lastError,
          retryAfter: updated.retryAfter,
        };
      }
    }
    this.updateRule(ruleId, { lastRunAt: nowMs(), lastError: '', failures: 0, retryAfter: 0 });
    if (mirrored) {
      s.log(
        'INFO',
        'Mirror',
        `${snapshot.name || 'Relay'} forwarded ${mirrored} message(s) to ${snapshot.destLabel}.`
      );
    }
    return { ruleId, mirrored, skipped, lastSeenId: currentCursor, manual };
  }
}

// -- rule CRUD -------------------------------------------------------------
function mirrorTokenMessage(account, role) {
  return `The ${role} account needs a fresh Discord token.`;
}

async function saveMirrorRule(data) {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  if (!data || typeof data !== 'object') throw new Error('A mirror rule object is required.');
  const ruleId = String(data.id || '').trim();
  const existing = ruleId ? mirrorRuleById(ruleId) : null;
  if (ruleId && !existing) throw new Error('That mirror rule no longer exists.');
  const sourceAccountId = String(data.sourceAccountId || (existing || {}).sourceAccountId || '');
  const destAccountId = String(data.destAccountId || (existing || {}).destAccountId || '');
  const sourceAccount = s.accountById(sourceAccountId, true);
  const destAccount = s.accountById(destAccountId, true);
  if (!sourceAccount) throw new Error('Choose a saved source account.');
  if (!destAccount) throw new Error('Choose a saved destination account.');
  const sourceToken = cleanDiscordToken(sourceAccount.token);
  const destToken = cleanDiscordToken(destAccount.token);
  if (!sourceToken) throw new Error(mirrorTokenMessage(sourceAccount, 'source'));
  if (!destToken) throw new Error(mirrorTokenMessage(destAccount, 'destination'));
  const sourceChannel = snowflakeText(data.sourceChannel || (existing || {}).sourceChannel);
  const destChannel = snowflakeText(data.destChannel || (existing || {}).destChannel);
  if (!sourceChannel || !destChannel) {
    throw new Error('Enter numeric channel IDs for both sides of the mirror.');
  }
  if (sourceChannel === destChannel) {
    throw new Error('Source and destination must be different channels.');
  }
  const sourceInfo = await fetchMirrorChannel(sourceToken, sourceChannel);
  const destInfo = await fetchMirrorChannel(destToken, destChannel);
  const base = existing || {};
  const mode = normalizeMirrorMode('mode' in data ? data.mode : base.mode);
  const enabled = mirrorBool(data.enabled, base.enabled === undefined ? true : Boolean(base.enabled));
  const sourceChanged =
    !existing ||
    sourceChannel !== String(existing.sourceChannel || '') ||
    sourceAccountId !== String(existing.sourceAccountId || '');
  const draft = {
    ...base,
    sourceAccountId,
    sourceChannel,
    sourceLabel: sourceInfo.label,
    destAccountId,
    destChannel,
    destLabel: destInfo.label,
    mode,
    enabled,
    includeOwn: mirrorBool(data.includeOwn, base.includeOwn === undefined ? false : Boolean(base.includeOwn)),
    includeBots: mirrorBool(data.includeBots, base.includeBots === undefined ? false : Boolean(base.includeBots)),
    includeAttachments: mirrorBool(
      data.includeAttachments,
      base.includeAttachments === undefined ? true : Boolean(base.includeAttachments)
    ),
    includeEmbeds: mirrorBool(
      data.includeEmbeds,
      base.includeEmbeds === undefined ? true : Boolean(base.includeEmbeds)
    ),
  };
  if ('name' in data) draft.name = String(data.name || '').trim().slice(0, 80);
  if (!draft.name) draft.name = `${sourceInfo.label} → ${destInfo.label}`.slice(0, 80);
  if (sourceChanged) {
    draft.primed = false;
    draft.lastSeenId = '';
    draft.lastError = '';
    draft.lastMirroredAt = null;
    draft.mirrored = 0;
    draft.skipped = 0;
    draft.failures = 0;
    draft.retryAfter = 0;
  }
  const rule = normalizeMirrorRule(draft, !existing);
  if (!rule) throw new Error('Mirror rule details are invalid.');
  if (!existing) {
    const current = normalizeMirrorState(s.state.mirror);
    if ((current.rules || []).length >= MIRROR_RULE_LIMIT) {
      throw new Error(`You can save up to ${MIRROR_RULE_LIMIT} mirror rules.`);
    }
  }
  if (rule.mode === 'webhook') {
    if (![0, 5].includes(Number(destInfo.type || 0))) {
      throw new Error(
        'Webhook mode needs a server text or announcement channel as the destination. ' +
          'Use normal mode for DMs, group DMs and threads.'
      );
    }
    // Create or reuse the managed webhook before committing the rule, so a
    // permissions failure leaves the old rule untouched.
    await ensureMirrorWebhook(rule, destToken, destInfo);
  }
  const mirror = normalizeMirrorState(s.state.mirror);
  let rules = mirror.rules || [];
  if (existing) {
    rules = rules.map((item) => (item.id === rule.id ? rule : item));
  } else {
    if (rules.length >= MIRROR_RULE_LIMIT) {
      throw new Error(`You can save up to ${MIRROR_RULE_LIMIT} mirror rules.`);
    }
    rules.push(rule);
  }
  mirror.rules = rules;
  mirror.lastError = '';
  s.state.mirror = mirror;
  s.save();
  if (rule.mode !== 'webhook' && mirrorWebhookFor(rule.id)) {
    await deleteMirrorWebhook(rule.id, { remote: true });
  }
  let warning = '';
  if (sourceChanged || !rule.primed) {
    try {
      await rt.MIRROR.primeRule(rule.id);
    } catch (error) {
      const message = error instanceof DiscordError ? error.message : String(error.message || error);
      warning = `Rule saved, but the source could not be read yet: ${scrub(message)}`;
    }
  }
  rt.MIRROR.kick();
  rt.GATEWAY.reconcile();
  s.log(
    'INFO',
    'Mirror',
    `${existing ? 'Updated' : 'Added'} relay “${rule.name}” (${sourceInfo.label} → ${destInfo.label}).`
  );
  s.broadcastState();
  return { rule: publicMirrorRule(mirrorRuleById(rule.id) || rule), warning };
}

function setMirrorSettings(data) {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  const mirror = normalizeMirrorState(s.state.mirror);
  const oldEnabled = mirror.enabled;
  if (data && 'enabled' in data) mirror.enabled = mirrorBool(data.enabled, mirror.enabled);
  if (data && 'interval' in data) {
    const value = Math.trunc(Number(data.interval || mirror.interval));
    if (!Number.isFinite(value)) throw new Error('Mirror interval must be between 5 and 300 seconds.');
    const value2 = clamp(value, 5, 300);
    if (value2 !== value) throw new Error('Mirror interval must be between 5 and 300 seconds.');
    mirror.interval = value;
  }
  s.state.mirror = mirror;
  s.save();
  if (mirror.enabled !== oldEnabled) {
    s.log(
      'INFO',
      'Mirror',
      mirror.enabled ? 'Automatic mirroring enabled.' : 'Automatic mirroring paused.'
    );
  }
  if (mirror.enabled) rt.MIRROR.kick();
  rt.GATEWAY.reconcile();
  s.broadcastState();
  return publicMirrorState();
}

async function deleteMirrorRule(ruleId) {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  const mirror = normalizeMirrorState(s.state.mirror);
  const before = (mirror.rules || []).length;
  mirror.rules = (mirror.rules || []).filter((rule) => rule.id !== ruleId);
  if (mirror.rules.length === before) throw new Error('That mirror rule no longer exists.');
  s.state.mirror = mirror;
  s.save();
  await deleteMirrorWebhook(ruleId, { remote: true });
  rt.GATEWAY.reconcile();
  s.log('INFO', 'Mirror', 'A message relay was removed.');
  s.broadcastState();
}

async function toggleMirrorRule(ruleId, enabled) {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  let warning = '';
  let mirror = normalizeMirrorState(s.state.mirror);
  let rule = (mirror.rules || []).find((item) => item.id === ruleId);
  if (!rule) throw new Error('That mirror rule no longer exists.');
  const mode = normalizeMirrorMode(rule.mode);
  if (enabled && mode === 'webhook') {
    const snapshot = rt.MIRROR.ruleSnapshot(ruleId);
    if (!snapshot) throw new Error('That mirror rule no longer exists.');
    try {
      await ensureMirrorWebhook(snapshot, snapshot._destToken || '');
    } catch (error) {
      const message = error instanceof DiscordError ? error.message : String(error.message || error);
      warning = scrub(message);
      enabled = false;
    }
  }
  mirror = normalizeMirrorState(s.state.mirror);
  rule = (mirror.rules || []).find((item) => item.id === ruleId);
  if (!rule) throw new Error('That mirror rule no longer exists.');
  rule.enabled = Boolean(enabled);
  if (enabled) {
    rule.lastError = '';
    rule.failures = 0;
    rule.retryAfter = 0;
  } else if (warning) {
    rule.lastError = warning.slice(0, 260);
  }
  s.state.mirror = mirror;
  s.save();
  if (enabled && !(mirrorRuleById(ruleId) || {}).primed) {
    try {
      await rt.MIRROR.primeRule(ruleId);
    } catch (error) {
      const message = error instanceof DiscordError ? error.message : String(error.message || error);
      warning = scrub(message);
    }
  }
  rt.MIRROR.kick();
  rt.GATEWAY.reconcile();
  s.log('INFO', 'Mirror', `Relay ${enabled ? 'resumed' : 'paused'}.`);
  s.broadcastState();
  const updated = publicMirrorRule(mirrorRuleById(ruleId) || {});
  return { rule: updated, warning };
}

module.exports = {
  fetchMirrorChannel,
  mirrorWebhookFor,
  storeMirrorWebhook,
  forgetMirrorWebhook,
  deleteDiscordWebhook,
  deleteMirrorWebhook,
  purgeMirrorWebhooks,
  executeDiscordWebhook,
  ensureMirrorWebhook,
  mirrorShouldSkip,
  mirrorAuthor,
  mirrorSentMarkup,
  mirrorAuthorAvatarUrl,
  mirrorWebhookUsername,
  mirrorExtraParts,
  buildMirrorContent,
  buildMirrorWebhookPayload,
  MessageMirror,
  mirrorRuleById,
  saveMirrorRule,
  setMirrorSettings,
  deleteMirrorRule,
  toggleMirrorRule,
};
