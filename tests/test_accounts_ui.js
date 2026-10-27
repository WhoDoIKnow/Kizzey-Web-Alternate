#!/usr/bin/env node
'use strict';
/* Browser-side checks for the saved-account and message-mirror screens. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static', 'screens-accounts.js'), 'utf8');
let checks = 0;
let failed = 0;
function check(ok, label, extra = '') {
  checks++;
  if (ok) console.log('ok: ' + label);
  else { failed++; console.log('FAIL: ' + label + (extra ? ' — ' + extra : '')); }
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const calls = { api: [], sheets: [], confirms: [], toasts: [], renders: 0, closed: 0 };
let state = {};
let apiReply = null;

function readPath(object, dotted) {
  return dotted.split('.').reduce((value, key) => value == null ? undefined : value[key], object);
}

const K = {
  screens: {},
  actions: {},
  current: { route: 'accounts' },
  esc,
  icon: name => `<svg data-icon="${esc(name)}"></svg>`,
  pageHead: opts => `<header><h1>${esc(opts.title)}</h1><p>${esc(opts.sub)}</p>${opts.actions || ''}</header>`,
  get(dotted, fallback) {
    const value = readPath(state, dotted);
    return value === undefined ? fallback : value;
  },
  settingGroup(title, inner) {
    return `${title ? `<div class="setting-group-title">${title}</div>` : ''}<div class="setting-group">${inner}</div>`;
  },
  empty(icon, title, copy, action = '') {
    return `<div class="empty" data-icon="${esc(icon)}"><b>${esc(title)}</b><span>${esc(copy)}</span>${action}</div>`;
  },
  btn(label, opts = {}) {
    const attrs = [];
    if (opts.action) attrs.push(`data-action="${esc(opts.action)}"`);
    if (opts.route) attrs.push(`data-route="${esc(opts.route)}"`);
    if (opts.disabled) attrs.push('disabled');
    return `<button class="btn ${esc(opts.cls || '')}" ${attrs.join(' ')}>${opts.icon ? K.icon(opts.icon) : ''}${esc(label)}</button>`;
  },
  avatar(opts = {}) {
    return `<span class="avatar">${esc(K.initials(opts.name || 'Kizzey'))}</span>`;
  },
  initials(name) {
    return String(name || 'K').split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase();
  },
  field(opts = {}) {
    const attrs = [
      `id="${esc(opts.id)}"`,
      `type="${esc(opts.type || 'text')}"`,
      `value="${esc(opts.value || '')}"`,
      opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : '',
      opts.maxlength ? `maxlength="${opts.maxlength}"` : '',
      opts.attrs || '',
    ].filter(Boolean).join(' ');
    return `<div class="field"><label>${esc(opts.label || '')}</label><input ${attrs}>${opts.suffix || ''}${opts.hint ? `<div class="field-hint">${opts.hint}</div>` : ''}</div>`;
  },
  select(opts = {}) {
    const options = (opts.options || []).map(option => {
      const value = typeof option === 'object' ? option.value : option;
      const label = typeof option === 'object' ? option.label : option;
      return `<option value="${esc(value)}" ${String(value) === String(opts.value) ? 'selected' : ''}>${esc(label)}</option>`;
    }).join('');
    return `<div class="field"><label>${esc(opts.label || '')}</label><select id="${esc(opts.id)}">${options}</select></div>`;
  },
  sheet(opts) { calls.sheets.push(opts); return {}; },
  closeSheet() { calls.closed++; },
  confirm(opts) { calls.confirms.push(opts); },
  toast(title, message, type = '') { calls.toasts.push({ title, message, type }); },
  async api(endpoint, options = {}) {
    calls.api.push({ endpoint, options });
    if (apiReply instanceof Error) throw apiReply;
    return apiReply;
  },
  receiveState(next) { state = JSON.parse(JSON.stringify(next)); },
  render() { calls.renders++; },
  discordStatus() { return { color: 'good', text: 'Discord connected' }; },
  relTime() { return '2m ago'; },
  displayName() { return 'Alpha'; },
};

function input(value = '', checked = false) {
  return {
    value, checked, disabled: false, type: 'password', textContent: '', innerHTML: '',
    dataset: {}, classList: { remove() {}, add() {} },
    focus() {},
    addEventListener() {},
  };
}

let fields = {};
const document = {
  querySelector(selector) {
    return selector.startsWith('#') ? (fields[selector.slice(1)] || null) : null;
  },
};

const context = vm.createContext({
  window: { K }, K, document, console, setTimeout, clearTimeout,
  requestAnimationFrame: fn => fn(),
});
vm.runInContext(source, context, { filename: 'screens-accounts.js' });

function accountsState(overrides = {}) {
  const alpha = {
    id: 'acct_alpha1', userId: '100000000000000001', username: 'alpha',
    displayName: 'Alpha', avatarUrl: '', tokenSet: true, needsAuth: false,
    authError: '', addedAt: 1, lastUsedAt: Date.now(),
  };
  const beta = {
    id: 'acct_beta22', userId: '100000000000000002', username: 'beta',
    displayName: 'Beta', avatarUrl: '', tokenSet: true, needsAuth: false,
    authError: '', addedAt: 2, lastUsedAt: null,
  };
  return Object.assign({
    account: { id: alpha.userId, username: alpha.username, displayName: alpha.displayName, avatarUrl: '' },
    accounts: [alpha, beta],
    accountCount: 2,
    accountLimit: 8,
    activeAccountId: alpha.id,
    gateway: { connected: true, state: 'ready', tokenSet: true },
    mirrorRuleLimit: 20,
    mirror: {
      enabled: true, interval: 20, lastRunAt: Date.now(), lastError: '', rules: [{
        id: 'mirror_rule1', name: 'Support relay', enabled: true,
        sourceAccountId: alpha.id, sourceChannel: '111111111111111111',
        sourceLabel: '#source-room', destAccountId: beta.id,
        destChannel: '222222222222222222', destLabel: '#dest-room',
        includeOwn: false, includeBots: false, includeAttachments: true, includeEmbeds: true,
        primed: true, lastSeenId: '8000', mirrored: 4, skipped: 2,
        lastMirroredAt: Date.now() - 120000, lastRunAt: Date.now() - 60000,
        lastError: '', failures: 0, retryAfter: 0, createdAt: 1, updatedAt: 1,
      }],
    },
  }, overrides);
}

(async () => {
  check(typeof K.screens.accounts === 'object' && typeof K.screens.accounts.render === 'function', 'account screen is registered');
  check(typeof K.screens.mirror === 'object' && typeof K.screens.mirror.render === 'function', 'mirror screen is registered');

  state = accountsState();
  let html = K.screens.accounts.render();
  check(html.includes('Alpha') && html.includes('@alpha'), 'account screen shows the active identity');
  check(html.includes('IN USE') && html.includes('Token stored'), 'active account is marked and token state is summarised');
  check(html.includes('Beta') && html.includes('Switch'), 'inactive account offers a switch action');
  check(html.includes('2/8') && html.includes('Add account'), 'account list shows usage against the account limit');
  check(html.includes('data-route="mirror"'), 'account screen links to the message mirror');
  check(html.includes('data/secret.json'), 'account privacy copy names the private store');
  check(!html.includes('tok-'), 'account screen has no token value');

  state = accountsState({ activeAccountId: 'acct_beta22', account: { id: '100000000000000002', username: 'beta', displayName: 'Beta', avatarUrl: '' } });
  state.accounts[0].displayName = 'Alpha <img src=x onerror=alert(1)>';
  state.accounts[0].authError = '<script>alert(2)</script>';
  state.accounts[0].tokenSet = false;
  state.accounts[0].needsAuth = true;
  html = K.screens.accounts.render();
  check(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'account names are HTML escaped');
  check(html.includes('&lt;script&gt;alert(2)&lt;/script&gt;'), 'account authentication errors are HTML escaped');
  check(!html.includes('<img src=x') && !html.includes('<script>alert'), 'account screen rejects injected markup');
  check(html.includes('Token needed') && html.includes('Add token'), 'a tokenless account offers re-authentication');

  state = accountsState({ activeAccountId: '', account: null });
  html = K.screens.accounts.render();
  check(html.includes('No account active') && html.includes('signed out'), 'account screen handles a signed-out server');
  check(html.includes('Beta') && html.includes('Switch'), 'saved accounts remain visible when none is active');

  state = accountsState();
  html = K.screens.mirror.render();
  check(html.includes('Auto mirror is on') && html.includes('checks every 20s'), 'mirror screen shows the global state and interval');
  check(html.includes('1 relay enabled') && html.includes('1 of 20 relays used'), 'mirror screen shows usage against the rule limit');
  check(html.includes('Support relay') && html.includes('#source-room') && html.includes('#dest-room'), 'mirror rule shows its route');
  check(html.includes('Alpha') && html.includes('Beta'), 'mirror routes name both account owners');
  check(html.includes('Run now') && html.includes('Edit') && html.includes('aria-label="Delete relay"'), 'mirror rule offers run, edit and delete actions');
  check((html.match(/aria-pressed="true"/g) || []).length >= 2, 'global and per-rule switches reflect their enabled state');
  check(html.includes('data-action="mirror-interval" data-value="20"') && html.includes('>20s</button>'), 'active mirror interval is shown as a chip');

  state = accountsState();
  state.mirror.enabled = false;
  state.mirror.rules[0].enabled = true;
  state.mirror.rules[0].lastError = '<b>rate limit</b>';
  html = K.screens.mirror.render();
  check(html.includes('Auto mirror is off') && html.includes('Automatic mirroring is paused'), 'mirror screen shows paused auto mode');
  check(html.includes('Queued'), 'an enabled relay waits while auto mirror is off');
  check(html.includes('&lt;b&gt;rate limit&lt;/b&gt;'), 'relay errors are HTML escaped');

  state = accountsState();
  state.mirrorRuleLimit = 1;
  html = K.screens.mirror.render();
  check(html.includes('1 of 1 relay used') && html.includes('delete one before adding another'), 'mirror screen explains the rule limit');
  check((html.match(/data-action="mirror-add"[^>]*disabled/g) || []).length >= 2, 'add controls are disabled at the relay limit');
  const rendersBeforeLimit = calls.toasts.length;
  K.actions['mirror-add']();
  check(calls.toasts.length === rendersBeforeLimit + 1 && calls.toasts.at(-1).title === 'Relay limit reached', 'mirror add action rejects the limit');

  state = accountsState();
  state.accounts = [];
  state.account = null;
  state.activeAccountId = '';
  state.mirror.rules = [];
  html = K.screens.mirror.render();
  check(html.includes('An account token is required') && html.includes('No relays yet'), 'empty mirror screen asks for an account first');
  check((html.match(/data-action="mirror-add"[^>]*disabled/g) || []).length >= 2, 'relay creation is disabled without an account');

  state = accountsState({ accounts: [], account: null, activeAccountId: '' });
  K.actions['account-add']();
  let sheet = calls.sheets.at(-1);
  check(sheet && sheet.title === 'Add a Discord account', 'add-account action opens a sheet');
  check(sheet.body.includes('type="password"') && sheet.body.includes('data/secret.json'), 'account sheet uses a password field and private-store copy');
  check(sheet.body.includes('id="account-make-active" type="checkbox" checked'), 'the first account is active by default');
  check(sheet.body.includes('data-action="account-submit" data-id=""'), 'account sheet submits through the account API');
  check(!sheet.body.includes('value="tok-'), 'account sheet never embeds a token');

  state = accountsState();
  state.accounts[1].displayName = 'Beta <b>Bold</b>';
  state.accounts[1].needsAuth = true;
  state.accounts[1].tokenSet = false;
  K.actions['account-readd']({ dataset: { id: 'acct_beta22' } });
  sheet = calls.sheets.at(-1);
  check(sheet.title === 'Update Discord token' && sheet.body.includes('Replace token'), 're-authentication opens the token update sheet');
  check(sheet.subtitle.includes('&lt;b&gt;Bold&lt;/b&gt;'), 'token update subtitle escapes the account name');
  check(sheet.body.includes('id="account-make-active" type="checkbox"'), 'an inactive re-authentication does not force a switch');

  fields = {
    'account-add-token': input('tok-new-super-secret'),
    'account-make-active': input('', true),
    'account-add-error': input(),
  };
  apiReply = {
    ok: true,
    created: true,
    account: { id: 'acct_new333', displayName: 'Gamma', username: 'gamma', tokenSet: true },
    state: accountsState({ activeAccountId: 'acct_new333' }),
  };
  calls.api.length = 0;
  calls.toasts.length = 0;
  const submitButton = input();
  submitButton.dataset.id = '';
  await K.actions['account-submit'](submitButton);
  check(calls.api.at(-1).endpoint === '/api/accounts/add', 'account submission posts to the account API');
  check(calls.api.at(-1).options.body.token === 'tok-new-super-secret', 'account token is sent only in the request body');
  check(calls.api.at(-1).options.body.makeActive === true, 'account submission sends the active choice');
  check(calls.closed >= 1 && calls.renders >= 1, 'successful account submission closes the sheet and refreshes');
  check(calls.toasts.at(-1).title === 'Account switched' && !JSON.stringify(calls.toasts).includes('tok-new-super-secret'), 'account toast never contains the token');

  fields = {
    'account-add-token': input(''),
    'account-make-active': input('', false),
    'account-add-error': input(),
  };
  calls.api.length = 0;
  await K.actions['account-submit'](input());
  check(calls.api.length === 0, 'empty token is rejected before the API call');

  state = accountsState();
  calls.api.length = 0;
  await K.actions['account-switch']({ dataset: { id: 'acct_beta22' }, disabled: false });
  check(calls.api.at(-1).endpoint === '/api/accounts/switch' && calls.api.at(-1).options.body.id === 'acct_beta22', 'account switch posts the selected account ID');
  check(calls.toasts.at(-1).title === 'Switched account', 'account switch reports success');

  state = accountsState();
  K.actions['account-remove']({ dataset: { id: 'acct_alpha1' } });
  let confirm = calls.confirms.at(-1);
  check(confirm && confirm.title.includes('Alpha') && confirm.subtitle.includes('switches'), 'removing the active account warns about fallback');
  apiReply = { ok: true, wasActive: true, nextId: 'acct_beta22', state: accountsState({ activeAccountId: 'acct_beta22' }) };
  calls.api.length = 0;
  calls.toasts.length = 0;
  await confirm.onConfirm();
  check(calls.api.at(-1).endpoint === '/api/accounts/remove' && calls.api.at(-1).options.body.id === 'acct_alpha1', 'account removal posts the account ID');
  check(calls.toasts.at(-1).message.includes('Beta'), 'account removal reports the fallback account');

  state = accountsState();
  calls.toasts.length = 0;
  K.actions['mirror-add']();
  sheet = calls.sheets.at(-1);
  check(sheet && sheet.title === 'Create message relay', 'mirror add opens the relay sheet');
  check(sheet.body.includes('id="mirror-source-account"') && sheet.body.includes('id="mirror-dest-account"'), 'relay sheet exposes both account selectors');
  check(sheet.body.includes('value="acct_alpha1" selected') && sheet.body.includes('value="acct_beta22" selected'), 'relay sheet defaults to different source and destination accounts');
  check(sheet.body.includes('id="mirror-include-attachments" type="checkbox" checked'), 'attachments are copied by default');
  check(sheet.body.includes('id="mirror-include-embeds" type="checkbox" checked'), 'embeds are copied by default');
  check(sheet.body.includes('id="mirror-enabled" type="checkbox" checked'), 'new relays are enabled by default');
  check(sheet.body.includes('Copy numeric channel IDs'), 'relay sheet explains how to find channel IDs');

  state = accountsState();
  state.mirror.rules[0].includeOwn = true;
  state.mirror.rules[0].includeBots = true;
  K.actions['mirror-edit']({ dataset: { id: 'mirror_rule1' } });
  sheet = calls.sheets.at(-1);
  check(sheet.title === 'Edit message relay' && sheet.body.includes('Save relay'), 'mirror edit opens the existing relay');
  check(sheet.body.includes('value="111111111111111111"') && sheet.body.includes('value="222222222222222222"'), 'relay edit preserves channel IDs');
  check(sheet.body.includes('id="mirror-include-own" type="checkbox" checked') && sheet.body.includes('id="mirror-include-bots" type="checkbox" checked'), 'relay edit preserves filter choices');

  state = accountsState();
  fields = {
    'mirror-name': input('Edited relay'),
    'mirror-source-account': input('acct_alpha1'),
    'mirror-source-channel': input('111111111111111111'),
    'mirror-dest-account': input('acct_beta22'),
    'mirror-dest-channel': input('222222222222222222'),
    'mirror-include-own': input('', true),
    'mirror-include-bots': input('', false),
    'mirror-include-attachments': input('', true),
    'mirror-include-embeds': input('', false),
    'mirror-enabled': input('', true),
    'mirror-form-error': input(),
    'mirror-save-btn': input(),
  };
  apiReply = { ok: true, warning: '', state: accountsState() };
  calls.api.length = 0;
  calls.toasts.length = 0;
  const saveButton = input();
  saveButton.dataset.id = 'mirror_rule1';
  await K.actions['mirror-save'](saveButton);
  const savedBody = calls.api.at(-1).options.body;
  check(calls.api.at(-1).endpoint === '/api/mirror/rules', 'relay save posts to the mirror API');
  check(savedBody.id === 'mirror_rule1' && savedBody.sourceChannel === '111111111111111111' && savedBody.destChannel === '222222222222222222', 'relay save sends IDs and channels');
  check(savedBody.includeOwn === true && savedBody.includeBots === false && savedBody.includeEmbeds === false, 'relay save sends filter choices');
  check(calls.toasts.at(-1).title === 'Relay updated' && calls.renders >= 1, 'relay save reports success and refreshes');

  fields = {
    'mirror-name': input(''), 'mirror-source-account': input('acct_alpha1'),
    'mirror-source-channel': input('abc'), 'mirror-dest-account': input('acct_beta22'),
    'mirror-dest-channel': input('222222222222222222'), 'mirror-form-error': input(),
  };
  calls.api.length = 0;
  const beforeInvalid = calls.api.length;
  await K.actions['mirror-save'](input());
  check(calls.api.length === beforeInvalid, 'relay save rejects non-numeric channel IDs before the API');

  state = accountsState();
  calls.api.length = 0;
  await K.actions['mirror-toggle']({ disabled: false });
  check(calls.api.at(-1).endpoint === '/api/mirror/settings' && calls.api.at(-1).options.body.enabled === false, 'global mirror switch posts the inverse setting');

  state = accountsState();
  calls.api.length = 0;
  await K.actions['mirror-interval']({ dataset: { value: '60' } });
  check(calls.api.at(-1).options.body.interval === 60, 'interval chip posts the selected interval');

  state = accountsState();
  calls.api.length = 0;
  await K.actions['mirror-rule-toggle']({ dataset: { id: 'mirror_rule1' }, disabled: false });
  check(calls.api.at(-1).endpoint === '/api/mirror/rules/toggle' && calls.api.at(-1).options.body.enabled === false, 'rule switch posts the inverse state');

  state = accountsState();
  apiReply = {
    ok: true, mirrored: 0,
    results: [{ ruleId: 'mirror_rule1', mirrored: 0, skipped: 0, error: 'Could not read the source channel: 429' }],
    state: accountsState(),
  };
  calls.toasts.length = 0;
  const runButton = input();
  runButton.dataset.id = 'mirror_rule1';
  await K.actions['mirror-run'](runButton);
  check(calls.toasts.at(-1).title === 'Relay check failed', 'manual relay errors are surfaced');

  apiReply = {
    ok: true, mirrored: 0,
    results: [{ ruleId: 'mirror_rule1', mirrored: 0, skipped: 0, cooldown: Date.now() + 5000 }],
    state: accountsState(),
  };
  calls.toasts.length = 0;
  await K.actions['mirror-run'](input());
  check(calls.toasts.at(-1).title === 'Relay is cooling down' && /5s|4s/.test(calls.toasts.at(-1).message), 'manual run explains a cooldown');

  const index = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'static', 'app.js'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'static', 'screens-settings.js'), 'utf8');
  const serviceWorker = fs.readFileSync(path.join(root, 'static', 'sw.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'static', 'styles.css'), 'utf8');
  check(index.indexOf('/screens-accounts.js') > 0 && index.indexOf('/screens-accounts.js') < index.indexOf('/app.js'), 'account screen loads before the router');
  check(app.includes("accounts: 'Discord accounts'") && app.includes("mirror: 'Message mirror'"), 'router has titles for both new screens');
  check(app.includes("route: 'accounts'") && app.includes("route: 'mirror'"), 'drawer exposes both new screens');
  check(settings.includes("'Discord accounts'") && settings.includes("'Message mirror'"), 'settings hub links to both new screens');
  check(settings.includes("route: 'accounts'") && settings.includes("route: 'mirror'"), 'settings links target the new routes');
  check(serviceWorker.includes('/screens-accounts.js'), 'service worker caches the new screen');
  check(css.includes('.account-list-row') && css.includes('.mirror-route') && css.includes('.mirror-toggle'), 'new components have Material styles');

  console.log(`\n${checks - failed}/${checks} account and mirror UI checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
