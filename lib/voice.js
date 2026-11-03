'use strict';

const rt = require('./runtime');
const {
  VOICE_SERVICE_URL,
  VOICE_SERVICE_TOKEN,
  VOICE_SERVICE_TIMEOUT,
  VERSION,
} = require('./constants');
const { scrub } = require('./scrub');

let token = VOICE_SERVICE_TOKEN || '';

function setVoiceToken(value) {
  token = String(value || '').trim();
}

function voiceServiceUrl() {
  return VOICE_SERVICE_URL;
}

async function voiceServiceCall(path, payload = null, opts = {}) {
  const { method = null, timeout = null, raw = false } = opts;
  if (!VOICE_SERVICE_URL) {
    const failure = new Error('The Discord voice service is not configured.');
    failure.status = 503;
    throw failure;
  }
  const url = VOICE_SERVICE_URL + (path.startsWith('/') ? path : '/' + path);
  const headers = { Accept: 'application/json', 'User-Agent': `KizzeyWeb/${VERSION}` };
  if (token) headers.Authorization = 'Bearer ' + token;
  let body;
  if (payload !== null && payload !== undefined) {
    body = JSON.stringify(payload);
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeout || VOICE_SERVICE_TIMEOUT) * 1000);
  let response;
  try {
    response = await fetch(url, {
      method: method || (body !== undefined ? 'POST' : 'GET'),
      headers,
      body,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const failure = new Error(
      `The voice service at ${VOICE_SERVICE_URL} is not reachable. Start the Node voice service and set KIZZEY_VOICE_URL.`
    );
    failure.status = 502;
    throw failure;
  }
  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      let message = `Voice service returned HTTP ${response.status}.`;
      try {
        const detail = JSON.parse(buffer.toString('utf8'));
        if (detail && detail.error) message = String(detail.error);
      } catch {
        // keep default
      }
      const failure = new Error(scrub(message));
      failure.status = response.status >= 400 && response.status < 500 ? response.status : 502;
      throw failure;
    }
    if (raw) return [buffer, response.headers.get('content-type') || ''];
    let parsed = {};
    if (buffer.length) {
      try {
        parsed = JSON.parse(buffer.toString('utf8'));
      } catch {
        const failure = new Error('The voice service returned an unreadable response.');
        failure.status = 502;
        throw failure;
      }
    }
    if (parsed && typeof parsed === 'object' && parsed.ok === false && parsed.error) {
      const failure = new Error(scrub(String(parsed.error)));
      failure.status = 502;
      throw failure;
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function voiceServiceState() {
  const info = {
    ok: true,
    configured: Boolean(VOICE_SERVICE_URL),
    url: VOICE_SERVICE_URL,
    reachable: false,
    ready: false,
    error: '',
    state: null,
    health: null,
    recordings: [],
  };
  if (!VOICE_SERVICE_URL) {
    info.error = 'Set KIZZEY_VOICE_URL to the address of the voice service.';
    return info;
  }
  try {
    info.health = await voiceServiceCall('/health', null, { timeout: 4 });
  } catch (error) {
    info.error = error.message;
    return info;
  }
  info.reachable = true;
  try {
    const result = await voiceServiceCall('/state', null, { timeout: 8 });
    info.state = result && typeof result === 'object' ? result.state : null;
    info.ready = Boolean((info.state || {}).ready);
  } catch (error) {
    info.error = error.message;
  }
  try {
    const listing = await voiceServiceCall('/recordings', null, { timeout: 8 });
    if (listing && typeof listing === 'object') info.recordings = listing.recordings || [];
  } catch {
    // recordings listing is best-effort
  }
  return info;
}

async function voiceServicePost(path, payload = null) {
  return voiceServiceCall(path, payload && typeof payload === 'object' ? payload : {}, { method: 'POST' });
}

function voiceJoinPayload(data) {
  data = data && typeof data === 'object' ? data : {};
  const payload = {
    guildId: String(data.guildId || ''),
    channelId: String(data.channelId || ''),
    userToken: true,
  };
  const s = rt.STORE;
  if (s) {
    try {
      const active = s.activeToken();
      if (active) payload.token = active;
    } catch {
      // not signed in
    }
  }
  return payload;
}

module.exports = {
  voiceServiceCall,
  voiceServiceState,
  voiceServicePost,
  voiceJoinPayload,
  setVoiceToken,
  voiceServiceUrl,
};
