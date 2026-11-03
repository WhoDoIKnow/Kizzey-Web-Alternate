'use strict';

const WebSocket = require('ws');
const rt = require('./runtime');
const { DISCORD_UA } = require('./constants');
const { HOST_DEVICE, defaultGatewayRecord } = require('./defaults');
const { nowMs, mono, cleanDiscordToken } = require('./util');
const { scrub } = require('./scrub');
const { normalizeUser } = require('./discord');

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

class GatewayClosed extends Error {
  constructor(message = '', code = null) {
    super(message);
    this.code = code;
  }
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return ['online', 'idle', 'dnd', 'invisible', 'offline'].includes(status) ? status : 'online';
}

function presenceTitle(presence) {
  if (!presence || typeof presence !== 'object') return '';
  const activities = Array.isArray(presence.activities) ? presence.activities : [];
  const first = activities[0];
  return first ? String(first.name || first.details || 'Presence') : String(presence.status || '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class DiscordGateway {
  constructor(accountId = '') {
    this.accountId = String(accountId || '');
    this.ws = null;
    this.token = '';
    this.ready = false;
    this.sequence = null;
    this.sessionId = null;
    this.lastPresence = null;
    this.heartbeatInterval = 41.25;
    this.lastAck = 0;
    this.lastHeartbeat = 0;
    this.startedAt = null;
    this.stopped = false;
    this.keepRunning = true;
    this.runPromise = null;
    this.heartbeatTimer = null;
  }

  get connected() {
    return Boolean(this.ready && this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  id() {
    return this.accountId || (rt.STORE ? rt.STORE.activeAccountId() : '');
  }

  gatewayRecord() {
    const store = rt.STORE;
    if (!store) return null;
    const accountId = this.id();
    if (!accountId) return null;
    const gateways = store.state.gateways || (store.state.gateways = {});
    let record = gateways[accountId];
    if (!record || typeof record !== 'object') {
      record = defaultGatewayRecord();
      gateways[accountId] = record;
    }
    return record;
  }

  setGatewayState(state, extra = {}) {
    const store = rt.STORE;
    const record = this.gatewayRecord();
    if (!record || !store) return;
    record.state = state;
    record.connected = this.connected;
    record.tokenSet = Boolean(this.token);
    Object.assign(record, extra);
    store.syncFocused();
    this.publishGateway();
  }

  publishGateway() {
    const store = rt.STORE;
    if (!store) return;
    const accountId = this.id();
    const focused = store.activeAccountId();
    if (accountId && accountId === focused) {
      store.publish({ type: 'gateway', gateway: JSON.parse(JSON.stringify(store.state.gateway)), accountId });
    } else {
      store.broadcastState();
    }
  }

  storeLatency(latency) {
    const store = rt.STORE;
    const record = this.gatewayRecord();
    if (!record || !store) return;
    record.latency = Math.max(0, Math.trunc(latency));
    store.syncFocused();
  }

  start(token) {
    this.stop();
    if (!token) return;
    this.token = token;
    this.stopped = false;
    this.keepRunning = true;
    this.ready = false;
    this.sequence = null;
    this.startedAt = nowMs();
    this.runPromise = this.run().catch((error) => {
      if (rt.STORE) rt.STORE.log('ERROR', 'Gateway', `Gateway loop stopped: ${scrub(error.message)}`);
    });
  }

  stop() {
    this.stopped = true;
    this.keepRunning = false;
    this.ready = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000);
      } catch {
        // ignore
      }
    }
    this.setGatewayState('offline', { latency: null });
  }

  sendPresence(presence) {
    this.lastPresence = presence;
    if (!presence) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.ready) {
      if (rt.STORE) rt.STORE.log('DEBUG', 'Gateway', 'Presence queued until Discord is ready.');
      return;
    }
    try {
      ws.send(JSON.stringify({ op: 3, d: presence }));
      if (rt.STORE) rt.STORE.log('INFO', 'Gateway', `Presence pushed: ${presenceTitle(presence)}`);
    } catch (error) {
      if (rt.STORE) rt.STORE.log('WARN', 'Gateway', `Could not push presence: ${error.message}`);
      this.ready = false;
      throw error;
    }
  }

  accountToken() {
    const store = rt.STORE;
    const accountId = this.id();
    if (!store || !accountId) return '';
    const account = store.accountById(accountId, true);
    return cleanDiscordToken((account || {}).token);
  }

  async run() {
    let backoff = 2;
    let first = true;
    while (!this.stopped) {
      try {
        await this.connectOnce();
        backoff = 2;
      } catch (error) {
        if (this.stopped) break;
        const fatal = error instanceof GatewayClosed && FATAL_CLOSE_CODES.has(error.code);
        const message = scrub(error.message);
        const store = rt.STORE;
        if (store) {
          store.log(fatal ? 'ERROR' : 'WARN', 'Gateway', `Connection lost: ${message}`);
          if (fatal) {
            const accountId = this.id();
            const errorText = 'Discord rejected the saved token. Add a fresh token in Discord accounts.';
            if (accountId) store.markAccountAuthFailed(accountId, errorText);
            const record = this.gatewayRecord();
            if (record) {
              Object.assign(record, {
                connected: false,
                state: 'error',
                error: errorText,
                latency: null,
                tokenSet: false,
              });
              store.syncFocused();
            }
            this.token = '';
            this.keepRunning = false;
            store.broadcastState();
            this.stopped = true;
            break;
          }
        }
        this.ready = false;
        if (store && store.state.settings && store.state.settings.keepAlive === false) {
          this.keepRunning = false;
          this.setGatewayState('offline', { error: message + ' Keep-alive is off.' });
          break;
        }
        this.setGatewayState('reconnecting', { error: message });
        const wait = first ? 0 : backoff;
        first = false;
        if (wait) await sleep(wait * 1000);
        if (this.stopped) break;
        backoff = Math.min(35, backoff * 1.8);
      } finally {
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        this.ready = false;
      }
    }
    this.setGatewayState(this.stopped && this.accountToken() ? 'offline' : 'error');
    // Clear the run handle so a later ensure()/reconcile() can bring this
    // account back up (for example after the operator pastes a fresh token).
    this.runPromise = null;
  }

  connectOnce() {
    this.setGatewayState('connecting', { error: '' });
    return new Promise((resolve, reject) => {
      let settled = false;
      let identified = false;
      const ws = new WebSocket(GATEWAY_URL, {
        headers: {
          'User-Agent': DISCORD_UA,
          Origin: 'https://discord.com',
        },
        handshakeTimeout: 25000,
      });
      this.ws = ws;

      const cleanup = () => {
        ws.off('message', onMessage);
        ws.off('close', onClose);
        ws.off('error', onError);
        ws.off('unexpected-response', onUnexpected);
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };

      const identify = () => {
        if (identified || !ws || ws.readyState !== WebSocket.OPEN) return;
        identified = true;
        const payload = {
          op: 2,
          d: {
            token: this.token,
            capabilities: 30717,
            compress: false,
            largeThreshold: 100,
            properties: {
              os: 'Android',
              browser: 'Discord Android',
              device: HOST_DEVICE.model || 'Android',
              system_locale: 'en-US',
              client_version: '267.0',
              release_channel: 'googleRelease',
              os_version: HOST_DEVICE.android || '14',
              client_build_number: 267206,
            },
          },
        };
        ws.send(JSON.stringify(payload));
      };

      const heartbeat = () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        this.lastHeartbeat = mono();
        try {
          ws.send(JSON.stringify({ op: 1, d: this.sequence }));
        } catch (error) {
          if (rt.STORE) rt.STORE.log('WARN', 'Gateway', `Heartbeat failed: ${error.message}`);
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
      };

      const onMessage = (data) => {
        let payload;
        try {
          payload = JSON.parse(data.toString());
        } catch {
          return;
        }
        const op = payload.op;
        if (typeof payload.s === 'number') this.sequence = payload.s;
        if (op === 10) {
          this.heartbeatInterval = Number((payload.d || {}).heartbeat_interval || 41250) / 1000;
          this.lastAck = mono();
          this.lastHeartbeat = 0;
          const interval = Math.max(5, this.heartbeatInterval);
          this.heartbeatTimer = setInterval(() => {
            if (!this.ready) return;
            if (mono() - this.lastAck > this.heartbeatInterval * 2.2) {
              try {
                ws.close();
              } catch {
                // ignore
              }
              return;
            }
            heartbeat();
          }, interval * 1000);
          // Jitter the first beat like the real client.
          setTimeout(() => {
            if (this.ready) heartbeat();
          }, Math.max(1000, this.heartbeatInterval * 0.45 * 1000));
          identify();
          if (rt.STORE) rt.STORE.log('INFO', 'Gateway', 'Connecting to Discord gateway...');
          return;
        }
        if (op === 11) {
          this.lastAck = mono();
          if (rt.STORE && this.lastHeartbeat) {
            this.storeLatency(Math.max(0, Math.trunc((mono() - this.lastHeartbeat) * 1000)));
          }
          return;
        }
        if (op === 1) {
          heartbeat();
          return;
        }
        if (op === 7) {
          finish(new GatewayClosed('Discord asked the client to reconnect'));
          try {
            ws.close();
          } catch {
            // ignore
          }
          return;
        }
        if (op === 9) {
          this.ready = false;
          identified = false;
          if (rt.STORE) rt.STORE.log('WARN', 'Gateway', 'Discord rejected the session; identifying again.');
          setTimeout(() => {
            if (!settled) identify();
          }, 2000);
          return;
        }
        if (op === 0) {
          const type = payload.t;
          const d = payload.d || {};
          if (type === 'READY') {
            this.ready = true;
            this.sessionId = d.session_id;
            const user = d.user || {};
            const store = rt.STORE;
            if (user && store && this.id() === store.activeAccountId()) {
              store.state.account = normalizeUser(user);
            }
            const record = this.gatewayRecord() || {};
            this.setGatewayState('connected', {
              connected: true,
              error: '',
              since: nowMs(),
              reconnects: record.reconnects || 0,
            });
            if (store) {
              store.log('INFO', 'Gateway', 'Discord gateway is ready.');
              store.broadcastState();
            }
            if (this.lastPresence) this.sendPresence(this.lastPresence);
            else this.sendIdlePresence();
          } else if (type === 'RESUMED') {
            this.ready = true;
            this.setGatewayState('connected', { connected: true, error: '', since: nowMs() });
            if (this.lastPresence) this.sendPresence(this.lastPresence);
          }
        }
      };

      const onClose = (code, reason) => {
        const text = reason ? reason.toString() : '';
        finish(
          new GatewayClosed(
            `gateway closed (${code || 'no code'})` + (text ? `: ${text.slice(0, 160)}` : ''),
            code
          )
        );
      };
      const onError = (error) => finish(error);
      const onUnexpected = (_request, response) => {
        finish(new GatewayClosed(`gateway handshake failed: HTTP ${response.statusCode}`, response.statusCode));
      };

      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);
      ws.on('unexpected-response', onUnexpected);
    });
  }

  sendIdlePresence() {
    const store = rt.STORE;
    if (!store) return;
    const status = (store.state.settings && store.state.settings.rpcStatus) || 'online';
    try {
      this.ws.send(
        JSON.stringify({
          op: 3,
          d: { since: 0, activities: [], status: normalizeStatus(status), afk: false },
        })
      );
    } catch {
      // ignore
    }
  }
}

function wantedGateways() {
  const store = rt.STORE;
  if (!store) return new Map();
  const wanted = new Map();
  const presences = store.state.presences || {};
  for (const [accountId, record] of Object.entries(presences)) {
    if (record && record.active) wanted.set(String(accountId), '');
  }
  const mirror = store.state.mirror || {};
  if (mirror.enabled) {
    for (const rule of mirror.rules || []) {
      if (!rule || !rule.enabled) continue;
      for (const key of ['sourceAccountId', 'destAccountId']) {
        const accountId = String(rule[key] || '');
        if (accountId) wanted.set(accountId, wanted.get(accountId) || '');
      }
    }
  }
  for (const accountId of [...wanted.keys()]) {
    const account = store.accountById(accountId, true);
    const token = cleanDiscordToken((account || {}).token);
    if (token) wanted.set(accountId, token);
    else wanted.delete(accountId);
  }
  return wanted;
}

class GatewayPool {
  constructor() {
    this.gateways = new Map();
  }

  get(accountId = '') {
    accountId = String(accountId || '') || (rt.STORE ? rt.STORE.activeAccountId() : '');
    let gateway = this.gateways.get(accountId);
    if (!gateway || gateway.accountId !== accountId) {
      gateway = new DiscordGateway(accountId);
      this.gateways.set(accountId, gateway);
    }
    return gateway;
  }

  running(accountId = '') {
    accountId = String(accountId || '') || (rt.STORE ? rt.STORE.activeAccountId() : '');
    const gateway = this.gateways.get(accountId);
    return Boolean(gateway && gateway.connected);
  }

  activeIds() {
    return [...this.gateways.entries()].filter(([, gateway]) => gateway.connected).map(([id]) => id);
  }

  static tokenFor(accountId) {
    if (!accountId || !rt.STORE) return '';
    const account = rt.STORE.accountById(accountId, true);
    return cleanDiscordToken((account || {}).token);
  }

  ensure(accountId = '') {
    accountId = String(accountId || '') || (rt.STORE ? rt.STORE.activeAccountId() : '');
    const gateway = this.get(accountId);
    if (accountId && !gateway.runPromise) {
      const token = GatewayPool.tokenFor(accountId);
      if (token) gateway.start(token);
    }
    return gateway;
  }

  start(token, accountId = '') {
    accountId = String(accountId || '') || (rt.STORE ? rt.STORE.activeAccountId() : '');
    this.get(accountId).start(token);
  }

  stop(accountId = '') {
    accountId = String(accountId || '') || (rt.STORE ? rt.STORE.activeAccountId() : '');
    const gateway = this.gateways.get(accountId);
    this.gateways.delete(accountId);
    if (gateway) gateway.stop();
  }

  stopAll() {
    const gateways = [...this.gateways.values()];
    this.gateways.clear();
    for (const gateway of gateways) gateway.stop();
  }

  restart(accountId = '') {
    accountId = String(accountId || '') || (rt.STORE ? rt.STORE.activeAccountId() : '');
    if (!accountId) return;
    const gateway = this.gateways.get(accountId);
    if (gateway && (gateway.runPromise || gateway.token)) this.stop(accountId);
    this.reconcile();
  }

  sendPresence(presence, accountId = '') {
    accountId = String(accountId || '') || (rt.STORE ? rt.STORE.activeAccountId() : '');
    this.get(accountId).sendPresence(presence);
  }

  reconcile() {
    const wanted = wantedGateways();
    const stale = [];
    for (const [accountId, gateway] of this.gateways.entries()) {
      if (!wanted.has(accountId) || (!gateway.keepRunning && !gateway.runPromise)) stale.push(accountId);
    }
    const missing = [];
    for (const [accountId, token] of wanted.entries()) {
      const existing = this.gateways.get(accountId);
      if (!existing || (existing.keepRunning && !existing.runPromise)) missing.push([accountId, token]);
    }
    for (const accountId of stale) {
      const gateway = this.gateways.get(accountId);
      this.gateways.delete(accountId);
      if (gateway) gateway.stop();
    }
    for (const [accountId, token] of missing) this.get(accountId).start(token);
  }
}

module.exports = {
  GatewayClosed,
  DiscordGateway,
  GatewayPool,
  wantedGateways,
  normalizeStatus,
  presenceTitle,
};