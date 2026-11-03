'use strict';

const rt = require('./runtime');
const { VERSION, SERVER_STARTED, ACCOUNT_LIMIT, MIRROR_RULE_LIMIT, VOICE_RECORDING_RE, VOICE_RECORDING_MIME } = require('./constants');
const { getLocalIp } = require('./util');
const { HOST_DEVICE } = require('./defaults');
const { sendJson, sendError, sendRaw } = require('./http');
const { publicState, publicMirrorState } = require('./state');
const { voiceServiceState, voiceServiceCall } = require('./voice');
const misc = require('./api-misc');

async function handleGet(req, res, url) {
  const path = url.pathname;
  const s = rt.STORE;

  if (path === '/api/state') return sendJson(res, { ok: true, state: publicState() });
  if (path === '/api/accounts') {
    return sendJson(res, {
      ok: true,
      accounts: s.publicAccounts(),
      activeAccountId: s.activeAccountId(),
      limit: ACCOUNT_LIMIT,
    });
  }
  if (path === '/api/mirror') {
    return sendJson(res, { ok: true, mirror: publicMirrorState(), limit: MIRROR_RULE_LIMIT });
  }
  if (path === '/api/events') return handleEvents(req, res);
  if (path === '/api/update') {
    const { updateFeed } = require('./discord');
    return sendJson(res, { ok: true, update: await updateFeed() });
  }
  if (path === '/api/hoststats') {
    const { hostStats } = require('./discord');
    return sendJson(res, { ok: true, stats: hostStats() });
  }
  if (path === '/api/weather') return misc.handleWeather(req, res, url);
  if (path === '/api/geocode') {
    const { offlineMode, geocode } = require('./discord');
    if (offlineMode()) return sendError(res, 'Offline mode is on. Turn it off in Settings to search places.', 503);
    try {
      const results = await geocode(url.searchParams.get('q') || '');
      return sendJson(res, { ok: true, results });
    } catch (error) {
      return sendError(res, `Could not search places: ${error.message}`, 502);
    }
  }
  if (path === '/api/route') return misc.handleRoute(req, res, url);
  if (path === '/api/friends') return misc.handleFriends(req, res);
  if (path === '/api/export') return misc.handleExport(req, res);
  if (path === '/api/presets/export') {
    try {
      return misc.handlePresetExport(req, res, url);
    } catch (error) {
      return sendError(res, error.message, 400);
    }
  }
  if (path === '/api/auth/browser/info') {
    return sendJson(res, {
      ok: true,
      browser: {
        mode: 'none',
        available: false,
        reason: 'Browser sign-in is not available in this Node build. Use Discord sign-in or a token.',
      },
    });
  }
  if (path === '/api/health') {
    return sendJson(res, {
      ok: true,
      version: VERSION,
      ip: getLocalIp(),
      device: HOST_DEVICE,
      uptime: Math.max(0, Math.trunc((Date.now() - SERVER_STARTED) / 1000)),
    });
  }
  if (path === '/api/logs') return sendJson(res, { ok: true, logs: s.logs });
  if (path === '/api/history') return sendJson(res, { ok: true, history: s.state.history || [] });
  if (path === '/api/voice') {
    return sendJson(res, { ok: true, voice: ((s.state.chat || {}).voice || {}) });
  }
  if (path === '/api/voice/discord/guilds') {
    const { listVoiceGuilds } = require('./voice-directory');
    try {
      return sendJson(res, { ok: true, guilds: await listVoiceGuilds() });
    } catch (error) {
      const status = error instanceof (require('./discord').DiscordError) ? error.status || 502 : 502;
      return sendError(res, error.message, status);
    }
  }
  if (path === '/api/voice/discord/channels') {
    const { listVoiceChannels } = require('./voice-directory');
    try {
      const channels = await listVoiceChannels(url.searchParams.get('guildId') || '');
      return sendJson(res, { ok: true, channels });
    } catch (error) {
      const status = error instanceof (require('./discord').DiscordError) ? error.status || 502 : 502;
      return sendError(res, error.message, status);
    }
  }
  if (path === '/api/voice/discord' || path === '/api/voice/discord/state') {
    return sendJson(res, await voiceServiceState());
  }
  if (path.startsWith('/api/voice/discord/recordings/')) {
    const recordingId = path.split('/').pop();
    if (!VOICE_RECORDING_RE.test(recordingId)) return sendError(res, 'Invalid recording id.', 400);
    const [body, contentType] = await voiceServiceCall(`/recordings/${recordingId}`, null, {
      raw: true,
      timeout: 120,
    });
    return sendRaw(
      res,
      body,
      {
        'Content-Type': contentType || VOICE_RECORDING_MIME,
        'Content-Disposition': `attachment; filename="${recordingId}.ogg"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
      200
    );
  }
  if (path.startsWith('/api/')) return sendError(res, 'Not found.', 404);
  return null;
}

function handleEvents(req, res) {
  const s = rt.STORE;
  if (!s) return sendError(res, 'Server not ready.', 503);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (type, payload) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  write('state', { type: 'hello', state: publicState() });
  const listener = (event) => {
    try {
      write(event.type || 'message', event);
    } catch {
      // client went away
    }
  };
  s.subscribe(listener);
  const keepalive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      // ignore
    }
  }, 18000);
  const cleanup = () => {
    clearInterval(keepalive);
    s.unsubscribe(listener);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  return undefined;
}

async function handle(req, res, url) {
  const path = url.pathname;
  if (req.method === 'GET' || req.method === 'HEAD') {
    const handled = await handleGet(req, res, url);
    if (handled !== null) return handled;
    const { serveStatic } = require('./http');
    return serveStatic(req, res, path);
  }
  if (req.method === 'POST') {
    const { handlePost } = require('./api-post');
    return handlePost(req, res, url);
  }
  return sendError(res, 'Method not allowed.', 405);
}

module.exports = { handle, handleGet, handleEvents };
