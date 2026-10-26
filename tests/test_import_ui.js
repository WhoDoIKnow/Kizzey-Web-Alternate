#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'screens-settings.js'), 'utf8');
let checks = 0;
let failed = 0;
function check(ok, label, extra = '') {
  checks++;
  if (ok) console.log('ok: ' + label);
  else { failed++; console.log('FAIL: ' + label + (extra ? ' — ' + extra : '')); }
}

const calls = { toasts: [], api: [], confirms: [], accepts: [], sheets: [] };
const K = {
  screens: {}, actions: {},
  state: { savedConfigs: [{ id: 'one' }], history: [{ id: 'h' }], settings: {} },
  esc: value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])),
  icon: () => '<svg></svg>',
  pageHead: ({ title, sub, actions }) => `<header>${title}${sub}${actions}</header>`,
  settingGroup: (title, body) => `<section><h2>${title}</h2>${body}</section>`,
  toggleRow: () => '<div></div>',
  tappableRow: () => '<div></div>',
  get: (path, fallback) => fallback,
  num: (value, fallback) => Number(value) || fallback,
  bindFilePicker(fn, accept) { calls.picker = fn; calls.accepts.push(accept); },
  confirm(opts) { calls.confirms.push(opts); return opts; },
  sheet(opts) { calls.sheets.push(opts); return opts; },
  toast(title, message, kind) { calls.toasts.push({ title, message, kind }); },
  receiveState(state) { calls.received = state; },
  applyTheme() { calls.theme = true; },
  render() { calls.rendered = true; },
  api: async (path, opts) => {
    calls.api.push({ path, opts });
    return calls.apiResult;
  },
};
calls.apiResult = {
  state: { settings: {}, savedConfigs: [] },
  import: { kind: 'kizzey-backup', label: 'Kizzey settings backup', settings: 8, presets: 2, images: 1, warnings: ['one note'] },
};
const context = vm.createContext({
  window: { K },
  K,
  console,
  setTimeout,
  clearTimeout,
  location: { origin: 'http://127.0.0.1:8420' },
  Blob,
});
vm.runInContext(source, context, { filename: 'screens-settings.js' });

(async () => {
  check(typeof K.actions['backup-import'] === 'function', 'backup import action registered');
  const rendered = K.screens.backup.render();
  check(rendered.includes('From the Android app'), 'backup screen names Android compatibility');
  check(rendered.includes('Kizzey-settings-*.json'), 'backup screen lists settings backups');
  check(rendered.includes('Kizzey-presets-*.json'), 'backup screen lists preset packs');
  check(rendered.includes('Save config'), 'backup screen lists saved RPC configs');
  check(rendered.includes('MMKV'), 'backup screen states MMKV limitation');

  const prefBackup = {
    format: 'kizzey-backup', version: 2, appVersion: '8.4.4',
    prefs: { theme_color: 1, custom_rpc_template_presets: '[{}]', rpc_presence_presets: '[{},{}]' },
    configs: { 'One.json': '{}', 'Two.json': '{}' },
    presetImages: { 'a.png': 'x' },
  };
  K.actions['backup-import']();
  check(calls.accepts.at(-1).includes('.json'), 'file picker accepts JSON');
  await calls.picker({ name: 'Kizzey-settings-test.json', text: async () => JSON.stringify(prefBackup) });
  const confirm1 = calls.confirms.at(-1);
  check(!!confirm1, 'Kizzey backup opens confirmation');
  check(confirm1.title === 'Import this Kizzey backup?', 'Kizzey backup confirmation title');
  check(confirm1.subtitle.includes('3 preferences') && confirm1.subtitle.includes('2 config files'), 'Kizzey confirmation counts formats', confirm1.subtitle);
  check(confirm1.subtitle.includes('3 presets') && confirm1.subtitle.includes('1 artwork file'), 'Kizzey confirmation counts presets and art', confirm1.subtitle);
  check(confirm1.body.includes('account and token fields'), 'Kizzey confirmation explains account exclusion');
  await confirm1.onConfirm();
  check(calls.api.at(-1).path === '/api/import', 'Kizzey import posts to /api/import');
  check(calls.api.at(-1).opts.body.backup.format === 'kizzey-backup' && calls.api.at(-1).opts.body.backup.prefs.theme_color === 1, 'Kizzey import wraps the original payload');
  check(calls.api.at(-1).opts.body.fileName === 'Kizzey-settings-test.json', 'Kizzey import passes the file name');
  const resultSheet = calls.sheets.at(-1);
  check(resultSheet && resultSheet.title === 'Kizzey import complete', 'Kizzey import with warnings opens a result sheet');
  check(resultSheet.subtitle.includes('8 settings'), 'Kizzey sheet reports mapped settings', resultSheet.subtitle);
  check(resultSheet.subtitle.includes('2 presets'), 'Kizzey sheet reports presets');
  check(resultSheet.body.includes('one note'), 'Kizzey sheet shows the warning text');
  check(resultSheet.body.includes('Gallery'), 'Kizzey sheet points to the Gallery');
  check(calls.received && calls.theme && calls.rendered, 'Kizzey import refreshes state, theme and UI');

  const config = { name: 'Night Drive', details: 'Quiet hours', state: 'the web', type: '2', largeImg: '/data/local.png', button1: 'Open', button1link: 'https://example.com' };
  K.actions['backup-import']();
  await calls.picker({ name: 'Night Drive.json', text: async () => JSON.stringify(config) });
  const confirm2 = calls.confirms.at(-1);
  check(confirm2.title === 'Import this Custom RPC config?', 'stand-alone config confirmation title');
  check(confirm2.body.includes('stand-alone config does not carry image bytes'), 'stand-alone config explains local artwork limit');
  calls.apiResult = {
    state: { settings: {}, savedConfigs: [] },
    import: { kind: 'kizzey-config', label: 'Kizzey Custom RPC config', settings: 0, presets: 1, images: 0, warnings: [] },
  };
  const sheetsBefore = calls.sheets.length;
  await confirm2.onConfirm();
  check(calls.sheets.length === sheetsBefore, 'warning-free import does not open a result sheet');
  check(calls.toasts.at(-1).title === 'Kizzey import complete', 'warning-free import shows a success toast');
  check(calls.toasts.at(-1).message.includes('1 preset') && calls.toasts.at(-1).message.includes('Gallery'), 'success toast reports the preset and Gallery');

  const pack = { format: 'kizzey-preset', version: 1, appVersion: '8.4.4', presets: [{ title: 'A' }, { title: 'B' }] };
  K.actions['backup-import']();
  await calls.picker({ name: 'Kizzey-presets-test.json', text: async () => JSON.stringify(pack) });
  const confirm3 = calls.confirms.at(-1);
  check(confirm3.title === 'Import this Kizzey preset pack?', 'preset pack confirmation title');
  check(confirm3.subtitle.includes('2 presets'), 'preset pack confirmation count');

  const web = { format: 'kizzey-web-backup', state: { savedConfigs: [{ id: 'x' }], history: [1], chatProfile: { name: 'You' } }, exportedAt: '2026-10-26T00:00:00Z' };
  K.actions['backup-import']();
  await calls.picker({ name: 'kizzey-web.json', text: async () => JSON.stringify(web) });
  const confirm4 = calls.confirms.at(-1);
  check(confirm4.title === 'Restore this backup?', 'web backup confirmation remains');
  check(confirm4.subtitle.includes('1 preset'), 'web confirmation counts presets');

  const beforeUnsupported = calls.confirms.length;
  K.actions['backup-import']();
  await calls.picker({ name: 'other.json', text: async () => JSON.stringify({ format: 'something-else' }) });
  check(calls.confirms.length === beforeUnsupported, 'unknown format does not open confirmation');
  check(calls.toasts.at(-1).title === 'Could not read file', 'unknown format shows an error toast');
  check(calls.toasts.at(-1).message.includes('something-else'), 'unknown format error names the format');

  K.actions['backup-import']();
  await calls.picker({
    name: 'configs.json',
    text: async () => JSON.stringify([
      { name: 'One', details: 'First', state: 'Web' },
      { name: 'Two', details: 'Second', largeImg: 'https://example.com/two.png' },
    ]),
  });
  const rawConfigConfirm = calls.confirms.at(-1);
  check(rawConfigConfirm.title === 'Import these Custom RPC configs?', 'raw config array opens the config confirmation');
  check(rawConfigConfirm.subtitle.includes('2 RPC cards'), 'raw config confirmation counts cards');

  K.actions['backup-import']();
  await calls.picker({ name: 'image-only.json', text: async () => JSON.stringify({ image: 'https://example.com/only.png' }) });
  const imagePresetConfirm = calls.confirms.at(-1);
  check(imagePresetConfirm.title === 'Import this Kizzey preset?', 'image-only raw preset opens the preset confirmation');
  check(imagePresetConfirm.body.includes('artwork'), 'image-only preset confirmation mentions artwork');

  K.actions['backup-import']();
  await calls.picker({ name: 'broken.json', text: async () => '{not json' });
  check(calls.toasts.at(-1).message === 'That file is not valid JSON.', 'invalid JSON shows a clear error');

  console.log(`${checks - failed}/${checks} UI import checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
