#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let checks = 0;
let failed = 0;
function check(ok, label, extra = '') {
  checks++;
  if (ok) console.log('ok: ' + label);
  else { failed++; console.log('FAIL: ' + label + (extra ? ' — ' + extra : '')); }
}

const calls = { api: [], toasts: [] };
const K = {
  screens: {},
  actions: {},
  state: {},
  current: { route: 'discord-voice', params: {} },
  esc: value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])),
  icon: () => '<svg></svg>',
  pageHead: ({ title, sub }) => `<header>${title}${sub || ''}</header>`,
  get: (key, fallback) => fallback,
  api: async (url, opts) => {
    calls.api.push({ url, opts });
    if (url === '/api/voice/discord') {
      return {
        configured: true,
        reachable: true,
        ready: true,
        health: { ffmpeg: true, ytdlp: true },
        state: { ready: true, connected: true, channelName: 'Lounge', channelId: '2', playing: true, volume: 1, current: { title: 'Track' }, queue: [], recording: { active: false }, dave: true, backend: 'pycord' },
        recordings: [{ id: 'rec1', name: 'call.ogg', kind: 'mix', size: 2048, created: 1, bitrate: 32 }],
      };
    }
    return { ok: true, state: {} };
  },
  toast: (title, message, kind) => calls.toasts.push({ title, message, kind }),
  render: () => { calls.rendered = true; },
};

const context = vm.createContext({
  window: { K, prompt: () => '24' },
  K,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  document: { getElementById: () => null, querySelectorAll: () => [] },
});
vm.runInContext(fs.readFileSync(path.join(root, 'static', 'screens-discord-voice.js'), 'utf8'), context, { filename: 'screens-discord-voice.js' });

(async () => {
  check(!!K.screens['discord-voice'], 'discord voice screen registered');
  const html = K.screens['discord-voice'].render();
  check(html.includes('Discord voice'), 'screen title present');
  check(html.includes('Voice channel'), 'channel card present');
  check(html.includes('Channel ID'), 'channel id field present');
  check(html.includes('Music from the web'), 'music card present');
  check(html.includes('Record the call'), 'recording card present');
  check(html.includes('Opus bitrate'), 'bitrate selector present');
  check(html.includes('Start recording'), 'record start control present');
  check(html.includes('dv-recordings'), 'recordings container present');
  check(html.includes('DAVE'), 'DAVE caveat present');
  check(html.includes('screens-discord-voice') === false, 'screen does not leak its filename');

  await K.actions['dv-refresh']();
  const statusHtml = K.screens['discord-voice'].render();
  check(statusHtml.includes('py-cord receive'), 'status shows the py-cord receive backend');
  check(statusHtml.includes('DAVE encrypted'), 'status shows the DAVE chip');

  const actions = ['dv-refresh', 'dv-join', 'dv-leave', 'dv-play', 'dv-toggle', 'dv-skip', 'dv-stop', 'dv-record-start', 'dv-record-stop', 'dv-compress', 'dv-delete'];
  actions.forEach(name => check(typeof K.actions[name] === 'function', `action ${name} registered`));

  K.discordVoice.form.channelId = ' 123 ';
  K.discordVoice.form.guildId = ' 456 ';
  await K.actions['dv-join']();
  const join = calls.api.filter(c => c.url === '/api/voice/discord/join').pop();
  check(!!join, 'join calls the discord voice endpoint');
  check(join && join.opts.body.channelId === '123', 'join trims the channel id');
  check(join && join.opts.body.guildId === '456', 'join trims the guild id');

  K.discordVoice.form.query = 'lofi beats';
  await K.actions['dv-play']();
  const play = calls.api.filter(c => c.url === '/api/voice/discord/play').pop();
  check(!!play, 'play calls the discord voice endpoint');
  check(play && play.opts.body.query === 'lofi beats', 'play forwards the query');

  K.discordVoice.form.mode = 'mix';
  K.discordVoice.form.bitrate = '24';
  await K.actions['dv-record-start']();
  const record = calls.api.filter(c => c.url === '/api/voice/discord/record').pop();
  check(!!record && record.opts.body.action === 'start', 'record start sends the start action');
  check(record && record.opts.body.bitrate === 24, 'record start forwards the bitrate');
  check(record && record.opts.body.mix === true, 'mix mode requests the mixed track');

  await K.actions['dv-record-stop']();
  const stop = calls.api.filter(c => c.url === '/api/voice/discord/record').pop();
  check(stop && stop.opts.body.action === 'stop', 'record stop sends the stop action');

  await K.actions['dv-compress']({ dataset: { id: 'rec1' } });
  const compress = calls.api.filter(c => c.url === '/api/voice/discord/recordings/compress').pop();
  check(!!compress && compress.opts.body.id === 'rec1', 'compress targets the recording');
  check(compress && compress.opts.body.bitrate === 24, 'compress forwards the bitrate');

  await K.actions['dv-delete']({ dataset: { id: 'rec2' } });
  const del = calls.api.filter(c => c.url === '/api/voice/discord/recordings/delete').pop();
  check(!!del && del.opts.body.id === 'rec2', 'delete targets the recording');

  // -- static wiring ------------------------------------------------------
  const index = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
  check(index.includes('screens-discord-voice.js'), 'shell loads the discord voice screen');
  check(index.includes('?b=v13'), 'shell cache key was bumped');
  const sw = fs.readFileSync(path.join(root, 'static', 'sw.js'), 'utf8');
  check(sw.includes("BUILD = 'v13'"), 'service worker build was bumped');
  check(sw.includes('screens-discord-voice.js'), 'service worker caches the screen');
  const app = fs.readFileSync(path.join(root, 'static', 'app.js'), 'utf8');
  check(app.includes("route: 'discord-voice'"), 'navigation exposes the screen');
  const social = fs.readFileSync(path.join(root, 'static', 'screens-social.js'), 'utf8');
  check(social.includes('data-route="discord-voice"'), 'voice room links to the screen');

  const server = fs.readFileSync(path.join(root, 'server.py'), 'utf8');
  check(server.includes('/api/voice/discord/join'), 'server proxies join');
  check(server.includes('/api/voice/discord/play'), 'server proxies play');
  check(server.includes('/api/voice/discord/record'), 'server proxies recording');
  check(server.includes('/api/voice/discord/recordings/compress'), 'server proxies compression');
  check(server.includes('KIZZEY_VOICE_URL'), 'server reads the voice service url');
  check(server.includes('KIZZEY_VOICE_TOKEN'), 'server reads the voice service token');
  check(server.includes('def voice_service_state'), 'server builds voice state');
  check(!server.includes('VOICE_SERVICE_TOKEN = "'), 'voice token is never hard-coded');

  console.log(`\n${checks - failed}/${checks} voice UI checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});