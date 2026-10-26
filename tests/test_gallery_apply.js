#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const rpcSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'screens-rpc.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'screens-social2.js'), 'utf8');
let checks = 0;
let failed = 0;
function check(ok, label, extra = '') {
  checks++;
  if (ok) console.log('ok: ' + label);
  else { failed++; console.log('FAIL: ' + label + (extra ? ' — ' + extra : '')); }
}
const calls = { patches: [], nav: [], toasts: [] };
let activeItem = null;
let savedState = [];
const K = {
  screens: {}, actions: {},
  esc: value => String(value ?? ''),
  icon: () => '<svg></svg>',
  pageHead: () => '',
  get(path, fallback) {
    if (path === 'custom') return { name: 'Old custom', timestampsStart: '111', timestampsStop: '222', platform: 'desktop', applicationId: '111111111111111111' };
    if (path === 'settings.rpcStatus') return 'idle';
    if (path === 'custom.platform') return 'desktop';
    if (path === 'custom.applicationId') return '111111111111111111';
    if (path === 'savedConfigs') return savedState;
    if (path === 'gallery') return {};
    return fallback;
  },
  setLocal() {},
  clone: value => JSON.parse(JSON.stringify(value)),
  queuePatch: async updates => { calls.patches.push(updates); },
  navigate: route => calls.nav.push(route),
  toast: (title, message) => calls.toasts.push({ title, message }),
  galleryItems: () => activeItem ? [activeItem] : [],
};
const context = vm.createContext({
  window: { K }, K, console, setTimeout, clearTimeout,
  setInterval: () => 0, clearInterval: () => {},
});
vm.runInContext(rpcSource, context, { filename: 'screens-rpc.js' });
vm.runInContext(source, context, { filename: 'screens-social2.js' });
const sourceGalleryItems = K.galleryItems;

async function apply(timestamp, custom) {
  activeItem = {
    id: 'saved-one', name: 'Imported card', source: 'saved',
    custom: Object.assign({
      name: 'Imported card', details: 'Details', state: 'State',
      status: 'dnd', platform: 'android', applicationId: '123456789012345678',
      button1: 'Open', button1link: 'https://example.com/open',
      largeUrl: 'https://example.com/art.png', smallUrl: '',
      largeImg: '', smallImg: 'mp:external/asset',
      timestampsStart: '1700000000000', timestampsStop: '',
    }, custom || {}),
    timestamp,
  };
  await K.actions['gallery-use']({ dataset: { id: 'saved-one' } });
  return calls.patches.at(-1).custom;
}

(async () => {
  savedState = [{
    id: 'saved-one', name: 'Imported card', timestamp: { mode: 'since_apply' },
    custom: { name: 'Imported card', details: 'D', state: 'S' },
  }];
  const items = sourceGalleryItems();
  const savedItem = items.find(item => item.id === 'saved-saved-one');
  check(savedItem && savedItem.timestamp.mode === 'since_apply', 'saved gallery item carries timestamp metadata', JSON.stringify(items));
  savedState = [];
  K.galleryItems = () => activeItem ? [activeItem] : [];

  const before = Date.now();
  const since = await apply({ mode: 'since_apply' });
  const sinceStart = Number(since.timestampsStart);
  check(sinceStart >= before && sinceStart <= Date.now() + 1000 && since.timestampsStop === '', 'since_apply restarts from now');
  check(since.status === 'dnd' && since.platform === 'android' && since.applicationId === '123456789012345678', 'imported status, platform and application ID survive apply');
  check(since.button1link === 'https://example.com/open' && since.smallImg === 'mp:external/asset', 'imported buttons and assets survive apply');

  const beforeDuration = Date.now();
  const duration = await apply({ mode: 'duration', durationMs: 60000 });
  check(Number(duration.timestampsStart) >= beforeDuration, 'duration restarts from now');
  check(Number(duration.timestampsStop) - Number(duration.timestampsStart) === 60000, 'duration preserves its length');

  const absolute = await apply({ mode: 'absolute', start: '1700000000000', stop: '1700000060000' });
  check(absolute.timestampsStart === '1700000000000' && absolute.timestampsStop === '1700000060000', 'absolute timestamps apply verbatim');

  const none = await apply({ mode: 'none' });
  check(none.timestampsStart === '' && none.timestampsStop === '', 'none clears stale timestamps');

  const legacy = await apply(null);
  check(/^\d+$/.test(legacy.timestampsStart) && legacy.timestampsStop === '', 'web presets without metadata keep apply-now behaviour');

  check(calls.nav.at(-1) === 'custom', 'apply opens the Custom RPC screen');

  check(typeof K.customFromPreset === 'function' && typeof K.actions['apply-preset'] === 'function', 'Custom RPC preset application helper is available');
  savedState = [{
    id: 'saved-apply', name: 'Shelf Card', timestamp: { mode: 'absolute', start: '1700000000000', stop: '1700000060000' },
    custom: {
      name: 'Shelf Card', details: 'Shelf details', state: 'Shelf state',
      status: 'dnd', platform: 'android', applicationId: '123456789012345678',
      button1: 'Open', button1link: 'https://example.com/shelf',
      largeUrl: 'https://example.com/shelf.png', largeImg: '', smallUrl: '', smallImg: '',
      timestampsStart: '1700000000000', timestampsStop: '1700000060000',
    },
  }];
  await K.actions['apply-preset']({ dataset: { presetId: 'saved-apply', presetIndex: '' } });
  const shelf = calls.patches.at(-1).custom;
  check(shelf.timestampsStart === '1700000000000' && shelf.timestampsStop === '1700000060000', 'Custom RPC shelf applies absolute timestamps verbatim', shelf);
  check(shelf.status === 'dnd' && shelf.platform === 'android' && shelf.applicationId === '123456789012345678', 'Custom RPC shelf preserves status, platform and application ID');
  check(shelf.button1link === 'https://example.com/shelf' && shelf.largeUrl === 'https://example.com/shelf.png', 'Custom RPC shelf preserves buttons and artwork');
  console.log(`${checks - failed}/${checks} gallery apply checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
