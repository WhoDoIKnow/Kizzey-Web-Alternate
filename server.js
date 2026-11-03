'use strict';

const http = require('http');
const os = require('os');
const rt = require('./lib/runtime');
const { VERSION, DEFAULT_PORT, DATA_DIR, VOICE_SERVICE_TOKEN } = require('./lib/constants');
const { getLocalIp, cleanDiscordToken, sleep } = require('./lib/util');
const { Store } = require('./lib/store');

function parseArgs(argv) {
  const args = { host: process.env.KIZZEY_HOST || '0.0.0.0', port: Number(process.env.KIZZEY_PORT || DEFAULT_PORT), noGateway: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host' && argv[i + 1]) args.host = argv[++i];
    else if (arg.startsWith('--host=')) args.host = arg.slice(7);
    else if (arg === '--port' && argv[i + 1]) args.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) args.port = Number(arg.slice(7));
    else if (arg === '--no-gateway') args.noGateway = true;
  }
  if (!Number.isFinite(args.port) || args.port <= 0) args.port = DEFAULT_PORT;
  return args;
}

function banner(host, port) {
  const ip = getLocalIp();
  console.log('');
  console.log('  ✦ Kizzey Web');
  console.log(`  version ${VERSION} · Node ${process.version}`);
  console.log(`  http://127.0.0.1:${port}`);
  if (host === '0.0.0.0' || host === '::') console.log(`  http://${ip}:${port}   (LAN)`);
  console.log('  Your Discord token stays on this server. Ctrl+C to stop.');
  console.log('');
}

function hasLivePresence(store) {
  return Object.values(store.state.presences || {}).some((record) => record && record.active);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  rt.STORE = new Store();
  const store = rt.STORE;

  // The voice companion shares the Discord token that already drives RPC.
  if (!VOICE_SERVICE_TOKEN) {
    try {
      const { setVoiceToken } = require('./lib/voice');
      setVoiceToken(store.activeToken());
    } catch {
      // no account yet
    }
  }

  const { GatewayPool } = require('./lib/gateway');
  rt.GATEWAY = new GatewayPool();

  store.log('INFO', 'Server', `Kizzey Web ${VERSION} starting on ${args.host}:${args.port} (data: ${DATA_DIR}).`);

  const savedLive = Object.entries(store.state.presences || {}).filter(([, r]) => r && r.active);
  if (savedLive.length) {
    store.log(
      'INFO',
      'Presence',
      `Found ${savedLive.length} live presence${savedLive.length !== 1 ? 's' : ''} in the saved session.`
    );
  }

  const { validateToken } = require('./lib/discord');
  const { DiscordError } = require('./lib/discord');

  if (!args.noGateway) {
    const accounts = store.secret.accounts || [];
    const activeId = store.activeAccountId();
    const candidates = accounts
      .filter((row) => cleanDiscordToken(row.token))
      .sort((a, b) => (a.id === activeId ? -1 : 1) - (b.id === activeId ? -1 : 1));
    let focused = false;
    for (const account of candidates) {
      const accountId = String(account.id || '');
      const token = cleanDiscordToken(account.token);
      try {
        const me = await validateToken(token);
        store.activateAccount(accountId, me);
        store.log('INFO', 'Account', `Restored Discord session for ${me.displayName}.`);
        focused = true;
        break;
      } catch (error) {
        if (error instanceof DiscordError && error.status === 401) {
          store.markAccountAuthFailed(accountId, 'Discord rejected this saved token. Add a fresh token.');
          store.log(
            'WARN',
            'Account',
            `Saved account “${(account.user || {}).displayName || 'Discord'}” needs a fresh token.`
          );
          continue;
        }
        store.log('WARN', 'Account', `Saved Discord session could not be verified: ${error.message}`);
        store.activateAccount(accountId);
        focused = true;
        break;
      }
    }
    if (!focused && candidates.length) {
      store.secret.token = '';
      store.secret.tokenSetAt = null;
      store.state.account = null;
      store.syncFocused();
      store.state.gateway.error =
        'Every saved Discord token was rejected. Add a fresh token in Discord accounts.';
    }
    store.save();
  }

  if (args.noGateway) {
    const had = hasLivePresence(store);
    store.state.presences = {};
    const { emptyPresence } = require('./lib/defaults');
    store.state.presence = emptyPresence();
    if (had) store.log('INFO', 'Presence', 'Session resume is skipped because --no-gateway is set.');
    store.save();
  } else {
    const { resumeLivePresences } = require('./lib/presence');
    await resumeLivePresences();
  }

  rt.GATEWAY.reconcile();

  try {
    const { Ticker } = require('./lib/presence');
    rt.TICKER = new Ticker();
    rt.TICKER.start();
  } catch (error) {
    store.log('WARN', 'Presence', `Presence ticker not started: ${error.message}`);
  }

  try {
    const { MessageMirror } = require('./lib/mirror');
    rt.MIRROR = new MessageMirror();
    rt.MIRROR.start();
  } catch (error) {
    store.log('WARN', 'Mirror', `Message mirror not started: ${error.message}`);
  }

  const { handle } = require('./lib/api');

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }
    Promise.resolve(handle(req, res, url)).catch((error) => {
      try {
        const { sendError } = require('./lib/http');
        sendError(res, error.message || 'Server error', 500);
      } catch {
        res.destroy();
      }
    });
  });

  server.on('clientError', (err, socket) => {
    if (err.code === 'ECONNRESET' || !socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.port, args.host, resolve);
  });

  banner(args.host, args.port);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n  ${signal} received, saving session…`);
    try {
      if (rt.MIRROR) rt.MIRROR.stop();
    } catch {
      // ignore
    }
    try {
      if (rt.TICKER) rt.TICKER.stop();
    } catch {
      // ignore
    }
    try {
      rt.GATEWAY.stopAll();
    } catch {
      // ignore
    }
    try {
      store.save();
    } catch {
      // ignore
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    store.log('ERROR', 'Server', `Uncaught exception: ${error.message}`);
  });
  process.on('unhandledRejection', (error) => {
    store.log('ERROR', 'Server', `Unhandled rejection: ${(error && error.message) || error}`);
  });
}

main().catch((error) => {
  console.error(`Could not start Kizzey Web: ${error.message}`);
  process.exit(1);
});
