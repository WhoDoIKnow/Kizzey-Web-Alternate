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
const calls = { patches: [], nav: [], toasts: [], sheetsClosed: 0, states: [], confirms: [] };
let activeItem = null;
let savedState = [];
let apiCalls = [];
let nameInputValue = '';
let renders = 0;
const apiResponses = {};
const downloads = [];
const document = {
  createElement() {
    return {
      href: '', rel: '',
      click() { downloads.push(this.href); },
      remove() {},
    };
  },
  body: { appendChild() {} },
  getElementById(id) {
    return id === 'preset-name' ? { value: nameInputValue, focus() {} } : null;
  },
};
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
  sheet: options => { calls.sheet = options; },
  closeSheet: () => { calls.sheetsClosed++; },
  galleryItems: () => activeItem ? [activeItem] : [],
  field: options => `<input id="${options.id}" value="${options.value ?? ''}">`,
  api: async (url, options) => {
    apiCalls.push({ url, options });
    const handler = apiResponses[url];
    return handler ? handler(options) : { ok: true };
  },
  receiveState: state => {
    calls.states.push(state);
    if (state && Array.isArray(state.savedConfigs)) savedState = state.savedConfigs;
  },
  confirm: options => { calls.confirms.push(options); },
  render: () => { renders++; },
  presetLibrary: [],
};
const context = vm.createContext({
  window: { K }, K, console, setTimeout, clearTimeout, document,
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
  check(calls.sheetsClosed === 1, 'Custom RPC shelf closes the preset sheet', calls.sheetsClosed);
  check(shelf.timestampsStart === '1700000000000' && shelf.timestampsStop === '1700000060000', 'Custom RPC shelf applies absolute timestamps verbatim', shelf);
  check(shelf.status === 'dnd' && shelf.platform === 'android' && shelf.applicationId === '123456789012345678', 'Custom RPC shelf preserves status, platform and application ID');
  check(shelf.button1link === 'https://example.com/shelf' && shelf.largeUrl === 'https://example.com/shelf.png', 'Custom RPC shelf preserves buttons and artwork');

  // --- preset manager -------------------------------------------------
  savedState = [
    { id: 'p-one', name: 'Late Night', gradient: 'linear-gradient(#111,#222)', emoji: '🌙', custom: { name: 'Late Night', details: 'Two hours in', state: 'Vibing' } },
    { id: 'p-two', name: 'Deep Focus', custom: { name: 'Deep Focus', details: '', state: 'Working' } },
  ];
  K.presetLibrary = [{ name: 'Built-in Card', custom: { details: 'Library details' } }];
  await K.actions['open-preset-manager']();
  const manager = calls.sheet;
  check(manager && manager.title === 'Presets', 'preset manager opens a Presets sheet');
  check(/2 saved · 1 built-in/.test(manager.subtitle || ''), 'preset manager counts saved and built-in presets', manager.subtitle);
  check(/Late Night/.test(manager.body) && /Built-in Card/.test(manager.body), 'preset manager lists saved and built-in presets');
  check(/data-action="apply-preset" data-preset-id="p-one"/.test(manager.body) && /data-action="delete-preset" data-preset-id="p-two"/.test(manager.body), 'saved rows expose load, edit, download and delete');
  check(/data-action="download-preset" data-pack="1" ?>/.test(manager.body), 'pack download is enabled when presets exist');
  check(/Two hours in/.test(manager.body) && /Working/.test(manager.body), 'preset rows show the saved line', manager.body);

  savedState = [];
  await K.actions['open-preset-manager']();
  const emptyManager = calls.sheet;
  check(/Nothing saved yet/.test(emptyManager.body), 'empty shelf explains itself');
  check(/data-action="download-preset" data-pack="1" disabled/.test(emptyManager.body), 'empty shelf disables the pack download');
  K.presetLibrary = [];

  await K.actions['save-preset']();
  const saveSheet = calls.sheet;
  check(/Save and download \.json/.test(saveSheet.body) && (saveSheet.body.match(/data-action="save-preset-confirm"/g) || []).length === 2, 'save sheet offers save and save-and-download', saveSheet.body);

  apiCalls = [];
  nameInputValue = '   ';
  await K.actions['save-preset-confirm']({ dataset: {} });
  check(apiCalls.length === 0 && calls.toasts.at(-1).title === 'Give the preset a name', 'save refuses a blank preset name');

  const savedNext = [{ id: 'p-new', name: 'Night Drive', custom: { name: 'Night Drive' } }];
  apiResponses['/api/presets/save'] = () => ({ ok: true, preset: { id: 'p-new' }, created: true, state: { savedConfigs: savedNext } });
  apiCalls = []; calls.sheetsClosed = 0; downloads.length = 0; renders = 0;
  nameInputValue = 'Night Drive';
  await K.actions['save-preset-confirm']({ dataset: {} });
  check(apiCalls[0].url === '/api/presets/save' && apiCalls[0].options.body.name === 'Night Drive', 'save posts the preset name');
  check(apiCalls[0].options.body.custom.name === 'Old custom', 'save posts the current card fields', apiCalls[0].options.body.custom);
  check(calls.sheetsClosed === 1 && renders === 1 && downloads.length === 0, 'plain save closes and re-renders without a download');
  check(savedState === savedNext && calls.toasts.at(-1).title === 'Preset saved', 'save adopts the returned shelf');

  await K.actions['save-preset-confirm']({ dataset: { download: '1' } });
  check(downloads.at(-1) === '/api/presets/export?id=p-new', 'save and download exports the new preset', downloads);

  const renamedNext = [{ id: 'p-new', name: 'Night Drive v2', custom: { name: 'Night Drive' } }];
  apiResponses['/api/presets/save'] = () => ({ ok: true, preset: { id: 'p-new', name: 'Night Drive v2' }, renamed: true, state: { savedConfigs: renamedNext } });
  apiCalls = [];
  nameInputValue = 'Night Drive v2';
  await K.actions['preset-rename']({ dataset: { presetId: 'p-new' } });
  check(apiCalls[0].options.body.id === 'p-new' && !apiCalls[0].options.body.custom, 'rename posts only id and name', apiCalls[0].options.body);
  check(calls.toasts.at(-1).title === 'Preset renamed', 'rename confirms the change');
  check(calls.sheet.title === 'Presets' && /Night Drive v2/.test(calls.sheet.body), 'rename returns to the manager');

  apiCalls = [];
  await K.actions['preset-update']({ dataset: { presetId: 'p-new' } });
  check(apiCalls.at(-1).options.body.id === 'p-new' && apiCalls.at(-1).options.body.custom.name === 'Old custom', 'update posts the current card over the saved one', apiCalls.at(-1).options.body);

  apiCalls = [];
  nameInputValue = '';
  await K.actions['preset-update']({ dataset: { presetId: 'p-new' } });
  check(apiCalls.length === 0 && calls.toasts.at(-1).title === 'Give the preset a name', 'update refuses a blank name');

  downloads.length = 0;
  K.actions['download-preset']({ dataset: { current: '1' } });
  check(downloads.at(-1) === '/api/presets/export?current=1', 'current card download hits the export endpoint');
  K.actions['download-preset']({ dataset: { pack: '1' } });
  check(downloads.at(-1) === '/api/presets/export?pack=1', 'pack download hits the export endpoint');
  K.actions['download-preset']({ dataset: { presetId: 'p-new' } });
  check(downloads.at(-1) === '/api/presets/export?id=p-new', 'single preset download carries the id');
  K.actions['download-preset']({ dataset: { presetId: 'missing' } });
  check(calls.toasts.at(-1).title === 'Preset unavailable', 'unknown preset download warns instead of guessing');

  savedState = [{ id: 'p-new', name: 'Night Drive v2', custom: { name: 'Night Drive' } }];
  calls.confirms = [];
  K.actions['delete-preset']({ dataset: { presetId: 'p-new' } });
  const askConfirm = calls.confirms.at(-1);
  check(askConfirm && askConfirm.danger === true && askConfirm.title === 'Delete this preset?', 'delete asks a dangerous confirmation');
  apiResponses['/api/presets/delete'] = () => ({ ok: true, removed: true, state: { savedConfigs: [] } });
  apiCalls = [];
  await askConfirm.onConfirm();
  check(apiCalls.at(-1).url === '/api/presets/delete' && apiCalls.at(-1).options.body.id === 'p-new', 'delete posts the preset id');
  check(savedState.length === 0 && calls.sheet.title === 'Presets', 'delete refreshes the manager from the new state');

  savedState = [{ id: 'p-edit', name: 'Editable', custom: { name: 'Editable', details: 'Edit details' } }];
  await K.actions['edit-preset']({ dataset: { presetId: 'p-edit' } });
  const editSheet = calls.sheet;
  check(/data-action="preset-rename" data-preset-id="p-edit"/.test(editSheet.body) && /data-action="preset-update" data-preset-id="p-edit"/.test(editSheet.body), 'edit sheet offers rename and update');
  check(/data-action="download-preset" data-preset-id="p-edit"/.test(editSheet.body) && /Edit details/.test(editSheet.body), 'edit sheet shows the saved card and its download');
  await K.actions['edit-preset']({ dataset: { presetId: 'missing' } });
  check(calls.toasts.at(-1).title === 'Preset unavailable', 'editing a vanished preset warns instead of opening an empty sheet');

  console.log(`${checks - failed}/${checks} gallery apply checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
