#!/usr/bin/env node
'use strict';

/**
 * Kizzey Web launcher (Node.js)
 *
 *   node script_pull.js
 *   node script_pull.js --host 0.0.0.0 --port 8420
 *   node script_pull.js --no-pull --no-voice
 *   node script_pull.js --voice-install
 *
 * Pulls the checkout, installs the required npm packages (always, so a fresh
 * clone runs), optionally starts the Discord voice companion, then supervises
 * both processes. Runtime data in data/ is never touched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_REPO = 'https://github.com/WhoDoIKnow/Kizzey-Web-Alternate';
const DEFAULT_BRANCH = 'main';
const DEFAULT_VOICE_PORT = 8421;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function note(message) {
  console.log(`  ${message}`);
}

function fail(message) {
  console.error(`  ${message}`);
  process.exit(1);
}

function which(binary) {
  if (process.platform === 'win32') {
    const found = spawnSync('where', [binary], { encoding: 'utf8' });
    return found.status === 0 ? String(found.stdout || '').split(/\r?\n/)[0].trim() : '';
  }
  const result = spawnSync('sh', ['-c', `command -v ${binary}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function runGit(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function localHead(target) {
  const rev = runGit(['rev-parse', 'HEAD'], target);
  return rev.status === 0 ? rev.stdout.trim() : '';
}

function remoteHead(target, repo, branch) {
  const listed = runGit(['ls-remote', repo, `refs/heads/${branch}`], target);
  if (listed.status !== 0) return '';
  for (const line of String(listed.stdout || '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === `refs/heads/${branch}`) return parts[0];
  }
  return '';
}

function defaultDir(scriptDir) {
  if (fs.existsSync(path.join(scriptDir, 'server.js'))) return scriptDir;
  return path.join(process.cwd(), 'kizzey-web');
}

function pull(target, repo, branch) {
  if (!fs.existsSync(path.join(target, '.git'))) {
    let entries = [];
    try {
      entries = fs.readdirSync(target);
    } catch {
      entries = [];
    }
    if (entries.length) {
      if (fs.existsSync(path.join(target, 'server.js'))) {
        note(`${target} is not a git checkout; starting it as-is.`);
        return 0;
      }
      fail(`${target} exists and is not empty. Choose another --dir.`);
    }
    if (!which('git')) {
      fail('git is not installed. Install git, or clone the repository yourself.');
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    note(`Cloning ${repo} (${branch}) into ${target}`);
    const cloned = spawnSync('git', ['clone', '--depth', '1', '--branch', branch, repo, target], {
      stdio: 'inherit',
    });
    if (cloned.status !== 0) {
      fail('Clone failed. For a private repository, sign in first and try again.');
    }
    return 0;
  }
  note(`Checking ${target}`);
  const local = localHead(target);
  let ahead = remoteHead(target, repo, branch);
  if (ahead && local && ahead === local) {
    note('Already up to date; nothing to pull.');
    return 0;
  }
  const fetched = runGit(['fetch', '--prune', 'origin', branch], target);
  if (fetched.status !== 0) {
    process.stderr.write(String(fetched.stdout || fetched.stderr || ''));
    fail('Could not fetch from origin. Check your network and repository access.');
  }
  if (!ahead) {
    const tracked = runGit(['rev-parse', `origin/${branch}`], target);
    ahead = tracked.status === 0 ? tracked.stdout.trim() : '';
  }
  if (ahead && local && ahead === local) {
    note('Already up to date; nothing to pull.');
    return 0;
  }
  const merged = runGit(['merge', '--ff-only', `origin/${branch}`], target);
  if (merged.status !== 0) {
    process.stderr.write(String(merged.stdout || merged.stderr || ''));
    fail('The checkout could not fast-forward. Commit or stash local changes, then retry.');
  }
  note('Updated to the latest sources.');
  return 0;
}

function npmInstall(target) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  note('Installing required npm packages…');
  // --no-bin-links keeps npm usable on Android shared storage, where creating
  // symlinks inside node_modules/.bin fails with EACCES. It is harmless on
  // ordinary Linux and in containers.
  const args = ['install', '--no-audit', '--no-fund'];
  if (process.platform === 'android') args.push('--no-bin-links');
  const result = spawnSync(npm, args, {
    cwd: target,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    note('npm install reported a problem. Core dependencies may already be present; continuing.');
    return false;
  }
  return true;
}

function rpcToken(target) {
  const file = path.join(target, 'data', 'secret.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return '';
  }
  const clean = (value) => {
    let token = String(value || '').trim();
    const lowered = token.toLowerCase();
    for (const prefix of ['bearer ', 'bot ']) {
      if (lowered.startsWith(prefix)) return token.slice(prefix.length).trim();
    }
    return token;
  };
  const token = clean(data.token);
  if (token) return token;
  for (const account of data.accounts || []) {
    if (!account || typeof account !== 'object') continue;
    const candidate = clean(account.token);
    if (candidate) return candidate;
  }
  return '';
}

function hasVoiceDeps(target) {
  const required = [
    'discord.js-selfbot-v13',
    '@discordjs/voice',
    '@snazzah/davey',
    'prism-media',
    'libsodium-wrappers',
  ];
  for (const name of required) {
    if (!fs.existsSync(path.join(target, 'node_modules', ...name.split('/')))) return false;
  }
  return true;
}

// Native N-API modules cannot always be dlopen'ed from Android shared storage
// (the linker refuses paths outside the app sandbox). Copy davey's prebuilt
// binding into the home directory and let @snazzah/davey load it directly.
function daveyNativeOverride(target) {
  if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH) return process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
  if (process.platform !== 'android') return '';
  const arm64 = process.arch === 'arm64';
  const pkg = arm64 ? '@snazzah/davey-android-arm64' : '@snazzah/davey-android-arm-eabi';
  const file = arm64 ? 'davey.android-arm64.node' : 'davey.android-arm-eabi.node';
  const source = path.join(target, 'node_modules', ...pkg.split('/'), file);
  if (!fs.existsSync(source)) return '';
  const directory = path.join(os.homedir(), '.cache', 'kizzey');
  const destination = path.join(directory, file);
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(source, destination);
    return destination;
  } catch {
    return '';
  }
}

function ffmpegPath(target) {
  try {
    const staticPath = require(path.join(target, 'node_modules', 'ffmpeg-static'));
    if (typeof staticPath === 'string' && fs.existsSync(staticPath)) return staticPath;
  } catch {
    // fall through to PATH
  }
  return which('ffmpeg');
}

function probeVoiceHealth(host, port, child, timeout = 20000) {
  return new Promise((resolve) => {
    const probeHost = ['', '0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
    const url = `http://${probeHost}:${port}/health`;
    const deadline = Date.now() + timeout;
    const tick = async () => {
      if (child && child.exitCode !== null) return resolve(false);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(700) });
        if (response.ok) return resolve(true);
      } catch {
        // not up yet
      }
      if (Date.now() >= deadline) return resolve(!child || child.exitCode === null);
      setTimeout(tick, 250);
    };
    tick();
  });
}

function startVoice(target, opts, accountToken) {
  const script = path.join(target, 'voice_service', 'index.js');
  if (!fs.existsSync(script)) {
    note('Voice companion not found in this checkout; starting Kizzey alone.');
    return null;
  }
  if (!hasVoiceDeps(target)) {
    note('Voice packages are not installed. Run with --voice-install to set them up.');
    return null;
  }
  if (!ffmpegPath(target)) {
    note('ffmpeg is not available; music playback and compression will be limited.');
  }
  const voiceToken = opts.voiceToken || accountToken;
  const discordToken = opts.discordToken || accountToken;
  const env = {
    ...process.env,
    VOICE_HOST: opts.voiceHost,
    VOICE_PORT: String(opts.voicePort),
    VOICE_RECORDINGS_DIR: process.env.VOICE_RECORDINGS_DIR || path.join(target, 'data', 'voice_recordings'),
  };
  if (voiceToken) env.VOICE_TOKEN = voiceToken;
  if (discordToken) env.DISCORD_TOKEN = discordToken;
  if (!opts.discordToken && accountToken) env.VOICE_USER_TOKEN = '1';
  const davey = daveyNativeOverride(target);
  if (davey) env.NAPI_RS_NATIVE_LIBRARY_PATH = davey;
  const ffmpeg = ffmpegPath(target);
  if (ffmpeg) env.VOICE_FFMPEG = ffmpeg;
  note(`Starting voice service: node ${script} --host ${opts.voiceHost} --port ${opts.voicePort}`);
  return spawn(process.execPath, [script, '--host', opts.voiceHost, '--port', String(opts.voicePort)], {
    cwd: target,
    env,
    stdio: 'inherit',
  });
}

function parseArgs(argv) {
  const opts = {
    dir: '',
    repo: DEFAULT_REPO,
    branch: DEFAULT_BRANCH,
    noPull: false,
    updateOnly: false,
    voice: false,
    noVoice: false,
    voiceRequired: false,
    voiceInstall: false,
    voiceHost: process.env.VOICE_HOST || '127.0.0.1',
    voicePort: Number(process.env.VOICE_PORT || DEFAULT_VOICE_PORT),
    voiceToken: process.env.VOICE_TOKEN || process.env.KIZZEY_VOICE_TOKEN || '',
    discordToken: process.env.DISCORD_TOKEN || '',
    forwarded: [],
  };
  const takesValue = new Set(['--dir', '--repo', '--branch', '--voice-host', '--voice-port', '--voice-token', '--discord-token']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (takesValue.has(arg) && argv[i + 1] !== undefined) {
      const value = argv[++i];
      if (arg === '--dir') opts.dir = value;
      else if (arg === '--repo') opts.repo = value;
      else if (arg === '--branch') opts.branch = value;
      else if (arg === '--voice-host') opts.voiceHost = value;
      else if (arg === '--voice-port') opts.voicePort = Number(value);
      else if (arg === '--voice-token') opts.voiceToken = value;
      else if (arg === '--discord-token') opts.discordToken = value;
      continue;
    }
    if (arg === '--no-pull') opts.noPull = true;
    else if (arg === '--update-only') opts.updateOnly = true;
    else if (arg === '--voice') opts.voice = true;
    else if (arg === '--no-voice') opts.noVoice = true;
    else if (arg === '--voice-required') opts.voiceRequired = true;
    else if (arg === '--voice-install') opts.voiceInstall = true;
    else opts.forwarded.push(arg);
  }
  if (!Number.isFinite(opts.voicePort) || opts.voicePort <= 0) opts.voicePort = DEFAULT_VOICE_PORT;
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const scriptDir = __dirname;
  const target = opts.dir ? path.resolve(opts.dir.replace(/^~(?=$|\/)/, os.homedir())) : defaultDir(scriptDir);

  if (!opts.noPull) {
    if (!which('git')) note('git is not installed; starting the current checkout.');
    else if (pull(target, opts.repo, opts.branch)) return 1;
  } else {
    note(`Using ${target} without pulling.`);
  }

  if (!fs.existsSync(path.join(target, 'server.js'))) fail(`${target}/server.js was not found.`);
  if (opts.updateOnly) {
    note(`Sources are ready in ${target}`);
    return 0;
  }

  npmInstall(target);

  let voiceChild = null;
  const extraEnv = {};
  if (!opts.noVoice) {
    const configured = String(process.env.KIZZEY_VOICE_URL || '').trim();
    if (configured) {
      note(`KIZZEY_VOICE_URL is set to ${configured}; not starting a local voice service.`);
    } else {
      const accountToken = rpcToken(target);
      if (accountToken && !opts.discordToken) note('Using the Discord account token already saved for RPC.');
      voiceChild = startVoice(target, opts, accountToken);
      if (voiceChild) {
        const healthy = await probeVoiceHealth(opts.voiceHost, opts.voicePort, voiceChild);
        if (!healthy) {
          if (voiceChild.exitCode !== null) {
            if (opts.voiceRequired) fail('The voice service exited during startup.');
            note('Voice service exited during startup; continuing without it.');
            voiceChild = null;
          } else {
            note('Voice service did not answer /health yet; continuing anyway.');
          }
        }
        if (voiceChild) {
          extraEnv.KIZZEY_VOICE_URL = `http://127.0.0.1:${opts.voicePort}`;
          if (opts.voiceToken || rpcToken(target)) extraEnv.KIZZEY_VOICE_TOKEN = opts.voiceToken || rpcToken(target);
        }
      } else if (opts.voiceRequired) {
        fail('Cannot start the voice service: missing voice_service/index.js or its npm packages.');
      }
    }
  }

  const forwarded = opts.forwarded.filter((a) => a !== '--no-voice' && a !== '--voice');
  const env = { ...process.env, ...extraEnv };
  note(`Starting: node ${path.join(target, 'server.js')} ${forwarded.join(' ')}`.trim());
  console.log('');
  const server = spawn(process.execPath, [path.join(target, 'server.js'), ...forwarded], {
    cwd: target,
    env,
    stdio: 'inherit',
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const child of [voiceChild, server]) {
      if (child && child.exitCode === null) {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }
    setTimeout(() => {
      for (const child of [voiceChild, server]) {
        if (child && child.exitCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }
    }, 8000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  server.on('exit', async (code) => {
    await stop();
    if (voiceChild && voiceChild.exitCode === null) {
      setTimeout(() => process.exit(code == null ? 0 : code), 500);
    } else {
      process.exit(code == null ? 0 : code);
    }
  });
  voiceChild?.on('exit', () => {
    if (!stopping) note('Voice service stopped.');
  });
}

main().catch((error) => fail(error.message));
