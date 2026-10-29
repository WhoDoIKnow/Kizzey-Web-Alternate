/* Kizzey Web — core runtime, icons, UI primitives */
(function () {
  'use strict';

  const K = window.K = window.K || {};
  K.screens = {};
  K.actions = {};
  K.afterModelChange = null;
  K.currentScreen = null;
  K.current = { route: 'home', params: {} };
  K.state = null;
  K.ready = false;
  K.modal = null;
  K.drawerOpen = false;
  K.pending = {};
  K.patchTimer = null;
  K.flushResolvers = [];
  K.clientId = localStorage.getItem('kizzey.clientId');
  if (!K.clientId) {
    K.clientId = 'web-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('kizzey.clientId', K.clientId);
  }
  K.local = {
    collapsed: new Set(JSON.parse(localStorage.getItem('kizzey.collapsed') || '[]')),
    activeRoom: localStorage.getItem('kizzey.room') || 'lounge',
    installPrompt: null,
  };

  // ---------------------------------------------------------------------
  // tiny helpers
  // ---------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  K.$ = $;
  K.$$ = $$;

  K.esc = function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  K.attr = K.esc;

  K.get = function get(path, fallback = undefined) {
    let obj = K.state;
    if (!obj) return fallback;
    for (const part of String(path).split('.')) {
      if (obj == null) return fallback;
      obj = obj[part];
    }
    return obj === undefined ? fallback : obj;
  };
  K.setLocal = function setLocal(path, value) {
    const parts = String(path).split('.');
    let obj = K.state;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (!obj[key] || typeof obj[key] !== 'object') obj[key] = {};
      obj = obj[key];
    }
    obj[parts[parts.length - 1]] = value;
  };
  K.patchObject = function patchObject(path, value) {
    const update = {};
    const parts = String(path).split('.');
    let obj = update;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]] = {};
    }
    obj[parts[parts.length - 1]] = value;
    return update;
  };
  K.deepMerge = function deepMerge(target, source) {
    for (const [key, value] of Object.entries(source || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
        deepMerge(target[key], value);
      } else {
        target[key] = value;
      }
    }
    return target;
  };
  K.clone = obj => JSON.parse(JSON.stringify(obj ?? null));

  K.now = () => Date.now();
  K.fmtTime = function fmtTime(ms) {
    if (!ms) return '--:--';
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  K.fmtDate = function fmtDate(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
  };
  K.fmtDateTime = function fmtDateTime(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  K.duration = function duration(ms) {
    const secs = Math.max(0, Math.floor((ms || 0) / 1000));
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m.toString().padStart(2, '0')}m`;
    if (m) return `${m}m ${s.toString().padStart(2, '0')}s`;
    return `${s}s`;
  };
  K.clockDuration = function clockDuration(ms) {
    const secs = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  K.relTime = function relTime(ms) {
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 45000) return 'now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return K.fmtDate(ms);
  };
  K.greeting = function greeting() {
    const hour = new Date().getHours();
    const base = hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const name = K.get('account.displayName') || K.get('chatProfile.name');
    const custom = K.get('settings.greeting');
    if (custom) return custom.replace(/\{\{\s*(name|user)\s*\}\}/gi, name || 'friend').replace(/\{\{\s*greeting\s*\}\}/gi, base);
    if (name && name !== 'You') return `${base}, ${name.split(' ')[0]}`;
    return base;
  };
  K.greetingBase = function () {
    const hour = new Date().getHours();
    return hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  };
  K.initials = function (name) {
    return String(name || 'K').trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase() || 'K';
  };
  K.random = arr => arr[Math.floor(Math.random() * arr.length)];
  K.uid = () => Math.random().toString(36).slice(2, 10);
  K.validUrl = value => /^https?:\/\/.+/i.test(String(value || '').trim());
  K.safeJson = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
  K.num = (value, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
  K.pad = n => String(n).padStart(2, '0');
  K.range = n => Array.from({ length: n }, (_, i) => i);
  K.capitalize = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
  K.stripTags = s => String(s || '').replace(/<[^>]*>/g, '');
  K.truncate = (s, n = 120) => String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || '');
  K.percent = (part, total) => total ? Math.max(0, Math.min(100, Math.round(part / total * 100))) : 0;
  K.isDone = (value) => value === true || value === 1 || value === '1';
  K.toDatetimeLocal = function (ms) {
    if (!ms) return '';
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return '';
    const offset = d.getTimezoneOffset();
    return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 16);
  };
  K.timeValue = function timeValue(value) {
    if (!value) return '';
    if (/^\\d{10,}$/.test(String(value))) return K.toDatetimeLocal(Number(value));
    return String(value);
  };
  K.fromDatetimeLocal = function (value) {
    if (!value) return '';
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? '' : String(ms);
  };
  K.statusLabel = s => ({ online: 'Online', idle: 'Idle', dnd: 'Do not disturb', invisible: 'Invisible', offline: 'Offline' }[s] || s || 'Online');
  K.typeLabel = t => ({ 0: 'Playing', 1: 'Streaming', 2: 'Listening to', 3: 'Watching', 5: 'Competing in' }[Number(t)] || 'Playing');
  K.expand = function expand(text) {
    if (!text) return '';
    const track = K.get('media.track', {}) || {};
    const weather = K.get('weather.last', {}) || {};
    const now = new Date();
    const screen = K.get('screenRead.lastFields', {}) || {};
    const values = {
      user: K.displayName(),
      username: K.get('account.username') || K.get('chatProfile.name', ''),
      name: K.displayName(),
      media_title: track.title || '',
      media_artist: track.artist || '',
      media_album: track.album || '',
      song: track.title || '',
      artist: track.artist || '',
      app_name: K.get('apps.selected.title', ''),
      weather: weather.desc || K.get('weather.place', ''),
      weather_temp: weather.temp != null ? `${weather.temp}°${String(K.get('weather.unit', 'c')).toUpperCase()}` : '',
      weather_feels: weather.feels != null ? `${weather.feels}°${String(K.get('weather.unit', 'c')).toUpperCase()}` : '',
      weather_desc: weather.desc || '',
      weather_emoji: weather.emoji || '',
      place: K.get('location.place', '') || K.get('weather.place', ''),
      steps: K.get('health.steps', 0),
      heart_rate: K.get('health.heart', 0),
      heart: K.get('health.heart', 0),
      sleep: K.get('health.sleep', 0),
      stress: K.get('health.stress', 0),
      screen_name: screen.screen_name || '',
      screen_score: screen.screen_score || '',
      nav_destination: K.get('navigation.destination', ''),
      nav_eta: K.get('navigation.durationText', ''),
      time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      date: now.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' }),
      date_full: now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    };
    return String(text).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => values[key] == null ? '' : String(values[key]));
  };
  K.presenceKinds = {
    custom: { label: 'Custom RPC', icon: 'sparkles', desc: 'Design and cycle your own presence', color: '#d3c0f6' },
    apps: { label: 'App Detection', icon: 'layout-grid', desc: 'Show what you are using, automatically', color: '#8fd6c3' },
    media: { label: 'Media RPC', icon: 'music', desc: 'Show the song you are listening to', color: '#f1b6d0' },
    console: { label: 'Console RPC', icon: 'gamepad', desc: 'PlayStation, Xbox, Switch and more', color: '#a7c7ff' },
    experimental: { label: 'Experimental RPC', icon: 'wand-sparkles', desc: 'Switch between apps and media', color: '#efc17a' },
    cycling: { label: 'RPC Cycling', icon: 'refresh', desc: 'Show several activity types at once', color: '#c4b5fd' },
    multiple: { label: 'Multiple RPC', icon: 'layers', desc: 'Run more than one source together', color: '#f0a6ca' },
    screen_read: { label: 'Screen Read', icon: 'scan', desc: 'Turn your screen into a presence', color: '#a8e6cf' },
    health: { label: 'Health', icon: 'heart-pulse', desc: 'Steps, heart rate, sleep and stress', color: '#ffbac8' },
    location: { label: 'Location', icon: 'map-pin', desc: 'Keep your place on your card', color: '#9fd7ff' },
    weather: { label: 'Weather', icon: 'cloud-sun', desc: 'Live conditions on RPC', color: '#ffd58a' },
    navigation: { label: 'Navigation', icon: 'navigation', desc: 'Directions from Maps on your card', color: '#9dd6b1' },
    android_auto: { label: 'Android Auto', icon: 'car', desc: 'A driving presence for the road', color: '#c3c8d8' },
    samsung: { label: 'Samsung RPC', icon: 'smartphone', desc: 'Galaxy-only presence', color: '#9db8ff' },
    emulation: { label: 'Emulation RPC', icon: 'gamepad', desc: 'Retro and emulator sessions', color: '#e6b8ff' },
  };

  K.currentPresence = () => K.get('presence.info') || null;
  K.runningKind = () => K.get('presence.active.kind') || null;
  K.isRunning = kind => K.runningKind() === kind;
  K.routeForKind = function routeForKind(kind) {
    return ({ screen_read: 'screen-read', android_auto: 'android-auto' }[kind] || kind || 'custom');
  };
  K.presenceArt = function presenceArt(p) {
    const kind = p?.kind;
    const state = K.state || {};
    let art = '';
    if (kind === 'custom' || kind === 'cycling') art = state.custom?.largeUrl || state.custom?.largeImg || '';
    else if (kind === 'media') art = state.media?.track?.art || '';
    else if (kind === 'apps') art = state.apps?.selected?.art || state.apps?.selected?.icon || '';
    else if (kind === 'console') art = state.console?.selected?.art || '';
    else if (kind === 'emulation') art = state.emulation?.art || '';
    else if (kind === 'screen_read') art = state.screenRead?.lastImage || '';
    else if (kind === 'weather' || kind === 'location' || kind === 'navigation') art = state.weather?.last?.iconUrl || '';
    if (!art || (!/^(https?:\/\/|data:image\/|\/)/i.test(String(art)))) return '';
    return art;
  };
  K.account = () => K.get('account');
  K.displayName = () => K.get('account.displayName') || K.get('chatProfile.name') || 'friend';
  K.avatarUrl = () => K.get('account.avatarUrl') || K.get('chatProfile.avatar') || '';
  K.gatewayConnected = () => !!K.get('gateway.connected');
  K.isSignedIn = () => !!K.get('account');
  K.hasUserToken = () => !!K.get('tokenSet', false);
  K.discordStatus = function () {
    const g = K.get('gateway', {});
    if (!K.isSignedIn()) return { key: 'signedout', text: 'Not connected', color: 'off' };
    if (!K.hasUserToken()) return { key: 'notoken', text: 'Token missing', color: 'warn' };
    if (g.connected) return { key: 'connected', text: 'Discord connected', color: 'good' };
    if (g.state === 'connecting') return { key: 'connecting', text: 'Connecting…', color: 'warn' };
    if (g.state === 'reconnecting') return { key: 'reconnecting', text: 'Reconnecting…', color: 'warn' };
    if (g.error) return { key: 'error', text: 'Connection error', color: 'warn' };
    return { key: 'online', text: 'Signed in', color: 'off' };
  };
  K.accountGateway = function (accountId) {
    const id = String(accountId || '');
    if (!id) return K.get('gateway', {}) || {};
    const all = K.get('gateways', {}) || {};
    return all[id] || {};
  };
  K.accountRunning = function (accountId) {
    const g = K.accountGateway(accountId);
    return !!g.connected || g.state === 'connecting' || g.state === 'reconnecting';
  };

  // ---------------------------------------------------------------------
  // API + state
  // ---------------------------------------------------------------------
  K.api = async function api(path, options = {}) {
    const opts = Object.assign({ headers: {} }, options);
    if (opts.body !== undefined && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    let response;
    try {
      response = await fetch(path, opts);
    } catch (err) {
      throw new Error('The server is unreachable.');
    }
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok || (data && data.ok === false)) {
      const error = new Error((data && data.error) || `Request failed (${response.status})`);
      error.status = response.status;
      error.data = data || {};
      throw error;
    }
    return data || {};
  };

  K.receiveState = function receiveState(next) {
    if (!next) return;
    K.state = next;
    K.ready = true;
    applyTheme();
    document.documentElement.lang = K.get('settings.language', 'en');
  };

  K.refresh = async function refresh() {
    const data = await K.api('/api/state');
    K.receiveState(data.state);
    return data.state;
  };

  K.queuePatch = function queuePatch(updates, delay = 160) {
    K.deepMerge(K.pending, updates);
    clearTimeout(K.patchTimer);
    const saved = new Promise(resolve => K.flushResolvers.push(resolve));
    K.patchTimer = setTimeout(() => K.flushPatch().catch(err => K.toast('Could not save', err.message, 'error')), delay);
    return saved;
  };

  K.flushPatch = function flushPatch() {
    clearTimeout(K.patchTimer);
    if (!Object.keys(K.pending).length) {
      const emptyResolvers = K.flushResolvers.splice(0);
      emptyResolvers.forEach(r => r());
      return Promise.resolve();
    }
    const updates = K.pending;
    K.pending = {};
    return K.api('/api/patch', { method: 'POST', body: { updates } })
      .then(data => {
        if (data.state) K.receiveState(data.state);
        const resolvers = K.flushResolvers.splice(0);
        resolvers.forEach(r => r());
        return data;
      })
      .catch(err => {
        K.pending = K.deepMerge(updates, K.pending);
        const resolvers = K.flushResolvers.splice(0);
        resolvers.forEach(r => r());
        throw err;
      });
  };

  K.flush = function flush() {
    return new Promise(resolve => {
      K.flushResolvers.push(resolve);
      K.flushPatch().catch(() => resolve());
    });
  };

  K.update = function update(path, value, opts = {}) {
    if (opts.rerender) { K.setLocal(path, value); K.queuePatch(K.patchObject(path, value)); K.render(); return; }
    K.setLocal(path, value);
    K.queuePatch(K.patchObject(path, value), opts.delay ?? 160);
    if (String(path).startsWith('settings.')) K.applyTheme();
    if (path === 'settings.notifications' && value) {
      K.ensureNotificationPermission().then(granted => {
        if (granted) return;
        K.setLocal(path, false);
        K.queuePatch(K.patchObject(path, false), 0);
        if (K.current.route === 'settings') K.render();
      });
    }
    if (typeof K.afterModelChange === 'function') {
      try { K.afterModelChange(path, value); } catch (err) { console.error(err); }
    }
  };

  K.set = function set(path, value, opts = {}) {
    K.setLocal(path, value);
    if (opts.save !== false) K.queuePatch(K.patchObject(path, value), opts.delay ?? 120);
    if (opts.rerender) K.render();
  };

  // ---------------------------------------------------------------------
  // toast + sheets
  // ---------------------------------------------------------------------
  K.toast = function toast(title, message = '', type = '') {
    const root = $('#toast-root');
    if (!root) return;
    const cls = type === 'error' ? 'error' : type === 'ok' || type === 'success' ? 'ok' : '';
    const ico = type === 'error' ? 'alert-circle' : type === 'ok' || type === 'success' ? 'check-circle' : 'info';
    const el = document.createElement('div');
    el.className = `toast ${cls}`;
    el.innerHTML = `${K.icon(ico, 'ti')}<div>${title ? `<b>${K.esc(title)}</b>` : ''}${message ? `<span>${K.esc(message)}</span>` : ''}</div>`;
    root.appendChild(el);
    setTimeout(() => {
      el.classList.add('hide');
      setTimeout(() => el.remove(), 220);
    }, type === 'error' ? 6200 : 4200);
  };

  K.ensureNotificationPermission = async function ensureNotificationPermission() {
    if (typeof Notification === 'undefined') {
      K.toast('Notifications are unsupported', 'This browser cannot show system notifications.', 'error');
      return false;
    }
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') {
      K.toast('Notifications are blocked', 'Allow notifications for this site in the browser settings.', 'error');
      return false;
    }
    let permission = 'denied';
    try {
      permission = await Notification.requestPermission();
    } catch {
      K.toast('Notifications unavailable', 'This page needs a secure browser context to ask for permission.', 'error');
      return false;
    }
    if (permission === 'granted') {
      K.toast('Notifications enabled', 'Chat updates can appear while the tab is hidden.', 'ok');
      return true;
    }
    K.toast('Notifications not enabled', 'Chat updates stay inside the app.', 'error');
    return false;
  };

  K.sheet = function sheet(opts = {}) {
    const root = $('#modal-root');
    if (!root) return;
    const body = typeof opts === 'string' ? opts : (opts.body || '');
    const title = opts.title || '';
    const sub = opts.subtitle || opts.sub || '';
    root.innerHTML = `<div class="modal-scrim" data-sheet-scrim>
      <section class="sheet" role="dialog" aria-modal="true" aria-label="${K.esc(K.stripTags(title) || 'Dialog')}">
        <div class="sheet-handle"></div>
        ${title || sub ? `<div class="sheet-head">
          <div><div class="sheet-title">${title}</div>${sub ? `<div class="sheet-sub">${sub}</div>` : ''}</div>
          <button class="sheet-close" data-close-sheet aria-label="Close">${K.icon('close', 'sm')}</button>
        </div>` : ''}
        <div class="sheet-content">${body}</div>
      </section>
    </div>`;
    document.body.classList.add('no-scroll');
    K.modal = opts;
    const scrim = $('[data-sheet-scrim]', root);
    scrim.addEventListener('click', event => { if (event.target === scrim) K.closeSheet(); });
    if (typeof opts.onMount === 'function') opts.onMount($('.sheet', root));
    const first = $('input, textarea, select', $('.sheet', root));
    if (opts.focus !== false && first && window.innerWidth > 600) setTimeout(() => first.focus({ preventScroll: true }), 200);
    return $('.sheet', root);
  };

  K.closeSheet = function closeSheet() {
    const root = $('#modal-root');
    if (!root) return;
    root.innerHTML = '';
    document.body.classList.remove('no-scroll');
    K.modal = null;
  };

  K.confirm = function confirm(opts = {}) {
    K.sheet({
      title: K.esc(opts.title || 'Are you sure?'),
      subtitle: K.esc(opts.subtitle || ''),
      body: `${opts.body ? `<div style="color:var(--text-dim);font-size:0.8125rem;line-height:1.55;margin-bottom:4px">${opts.body}</div>` : ''}
        <div class="modal-actions">
          <button class="btn btn-ghost" data-close-sheet>${K.esc(opts.cancel || 'Cancel')}</button>
          <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" id="confirm-sheet-btn">${K.esc(opts.confirm || 'Continue')}</button>
        </div>`,
      onMount(root) {
        $('#confirm-sheet-btn', root).addEventListener('click', async () => {
          K.closeSheet();
          if (typeof opts.onConfirm === 'function') await opts.onConfirm();
        });
      },
    });
  };

  // ---------------------------------------------------------------------
  // drawer wrapper
  // ---------------------------------------------------------------------
  K.openDrawer = function openDrawer() {
    K.drawerOpen = true;
    if (typeof K.renderDrawer === 'function') K.renderDrawer();
    requestAnimationFrame(() => {
      $('.scrim')?.classList.add('open');
      $('.drawer')?.classList.add('open');
    });
    document.body.classList.add('no-scroll');
  };
  K.closeDrawer = function closeDrawer() {
    K.drawerOpen = false;
    $('.scrim')?.classList.remove('open');
    $('.drawer')?.classList.remove('open');
    document.body.classList.remove('no-scroll');
    setTimeout(() => { if (!K.drawerOpen && typeof K.clearDrawer === 'function') K.clearDrawer(); }, 280);
  };
  K.toggleDrawer = () => K.drawerOpen ? K.closeDrawer() : K.openDrawer();

  // ---------------------------------------------------------------------
  // icons (Material/Lucide-flavoured, stroke based)
  // ---------------------------------------------------------------------
  const P = {
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-up': '<path d="m18 15-6-6-6 6"/>',
    'arrow-left': '<path d="M19 12H5m7 7-7-7 7-7"/>',
    'arrow-right': '<path d="M5 12h14m-7-7 7 7-7 7"/>',
    'arrow-up': '<path d="M12 19V5m-7 7 7-7 7 7"/>',
    'arrow-down': '<path d="M12 5v14m7-7-7 7-7-7"/>',
    'more-vert': '<circle cx="12" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none"/>',
    sparkles: '<path d="m12 3-1.9 4.8a2 2 0 0 1-1.1 1.1L4.2 10.8a.5.5 0 0 0 0 .9l4.8 1.9a2 2 0 0 1 1.1 1.1L12 19.5a.5.5 0 0 0 .9 0l1.9-4.8a2 2 0 0 1 1.1-1.1l4.8-1.9a.5.5 0 0 0 0-.9l-4.8-1.9a2 2 0 0 1-1.1-1.1L12 3Z"/><path d="M5 3v4M3 5h4M19 17v4m-2-2h4"/>',
    'battery-plus': '<rect x="2" y="7" width="16" height="10" rx="2"/><path d="M22 11v2M9 10v4M7 12h4"/>',
    battery: '<rect x="2" y="7" width="16" height="10" rx="2"/><path d="M22 11v2"/>',
    'battery-charging': '<path d="M2 8h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H2z"/><path d="M22 11v2"/><path d="m11 9-2 3h3l-2 3"/>',
    bell: '<path d="M10.3 21a1.9 1.9 0 0 0 3.4 0M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/>',
    'bell-ring': '<path d="M10.3 21a1.9 1.9 0 0 0 3.4 0M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M2 8a8 8 0 0 1 2-5M22 8a8 8 0 0 0-2-5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
    swap: '<path d="m7 4-4 4 4 4M3 8h13a4 4 0 0 1 0 8h-2M17 20l4-4-4-4M21 16H8a4 4 0 0 1 0-8h2"/>',
    'shield-off': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m4 4 16 16"/>',
    home: '<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 21v-8h6v8"/>',
    'message-circle': '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.8 9.8 0 0 1-4-.8L3 21l1.9-5A8.4 8.4 0 1 1 21 11.5Z"/>',
    message: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.8 9.8 0 0 1-4-.8L3 21l1.9-5A8.4 8.4 0 1 1 21 11.5Z"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21A5 5 0 0 0 6 22M14 14.66V17c0 .55.47.98.97 1.21A5 5 0 0 1 18 22M18 2H6v7a6 6 0 0 0 12 0Z"/>',
    images: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    'trending-up': '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    'bar-chart': '<path d="M12 20V10M18 20V4M6 20v-4"/>',
    'chart-no-axes': '<path d="M3 3v18h18M7 16v-4M12 16V8M17 16v-7"/>',
    columns: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M8 7h.01M16 7h.01"/>',
    insights: '<path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    timeline: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    'heart-pulse': '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/><path d="M3.5 12h4l1.5-2.5 2.5 5 1.5-2.5h5.5"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/>',
    navigation: '<path d="M3 11 22 2l-9 19-2-8-8-2Z"/>',
    'map-pin': '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z"/><path d="M9 3v15M15 6v15"/>',
    route: '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h4a3 3 0 0 0 3-3V9a3 3 0 0 1 3-3h-1"/>',
    car: '<path d="M5 17h14v-3.5L17 7H7L5 13.5Z"/><path d="M5 17v2M19 17v2M7 17h.01M17 17h.01M7 11h10"/>',
    'cloud-sun': '<path d="M12 2v2M4.9 4.9l1.4 1.4M2 12h2M19.1 4.9l-1.4 1.4"/><path d="M15.9 12a4 4 0 0 1 0 8H7a4 4 0 1 1 .7-7.94A6 6 0 0 1 19 12.5"/><path d="M16 12a4 4 0 0 0-4-4"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>',
    puzzle: '<path d="M19 13v5a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2v-1.5a2.5 2.5 0 1 0-5 0V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h1.5a2.5 2.5 0 1 0 0-5H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v1.5a2.5 2.5 0 1 0 5 0V3a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1.5a2.5 2.5 0 1 0 0 5H18a2 2 0 0 1 2 2Z"/>',
    bug: '<path d="m8 2 1.9 1.9M16 2l-1.9 1.9M9 7h6M12 20v-6"/><rect x="6" y="7" width="12" height="10" rx="6"/><path d="M6 13H2M6 17l-3 2M22 13h-4M18 17l3 2"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    'sliders-horizontal': '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
    palette: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.4-.3-.4-.5-.9-.5-1.4 0-1.1.9-2 2-2h2.5c2 0 3.5-1.6 3.5-3.5C21 6.4 17 2 12 2Z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20Z"/>',
    languages: '<path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
    'rotate-ccw': '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    play: '<path d="m8 5 14 7-14 7Z"/>',
    pause: '<path d="M9 4v16M15 4v16"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    'skip-back': '<path d="M19 20 9 12l10-8ZM5 19V5"/>',
    'skip-forward': '<path d="m5 4 10 8-10 8ZM19 5v14"/>',
    shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    'music-2': '<circle cx="8" cy="18" r="4"/><path d="M12 18V2l8 4"/>',
    headphones: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a1 1 0 0 1-1-1v-6a9 9 0 0 1 18 0v6a1 1 0 0 1-1 1h-2a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
    'headphones-off': '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a1 1 0 0 1-1-1v-6a9 9 0 0 1 14.5-7.3M21 14v6a1 1 0 0 1-1 1h-2a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3M2 2l20 20"/>',
    volume: '<path d="M11 5 6 9H2v6h4l5 4Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
    'volume-off': '<path d="M11 5 6 9H2v6h4l5 4ZM22 9l-6 6M16 9l6 6"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3"/>',
    'mic-off': '<path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.7-1.3M5 10v2a7 7 0 0 0 10 6.3M19 10v2a7 7 0 0 1-.6 2.8M12 19v3M8 22h8M2 2l20 20"/>',
    video: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4Z"/>',
    'screen-share': '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4M7 11l3-3 3 3 2-2 2 2"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    smartphone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M12 18h.01"/>',
    gamepad: '<path d="M6 12h4M8 10v4M15 13h.01M18 11h.01"/><path d="M17.3 5H6.7a4 4 0 0 0-3.8 5.3l1.6 5.2A3 3 0 0 0 9.9 17L12 15l2.1 2a3 3 0 0 0 5.4-1.5l1.6-5.2A4 4 0 0 0 17.3 5Z"/>',
    tv: '<rect x="2" y="7" width="20" height="13" rx="2"/><path d="m17 2-5 5-5-5"/>',
    cast: '<path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6M2 12a9 9 0 0 1 8 8M2 16a5 5 0 0 1 5 5M2 20h.01"/>',
    'map': '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z"/><path d="M9 3v15M15 6v15"/>',
    watch: '<circle cx="12" cy="12" r="6"/><path d="M12 10v2l1 1M9 3h6M9 21h6"/>',
    disc: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>',
    terminal: '<path d="m4 17 6-5-6-5M12 19h8"/>',
    code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.7-1.7l9.6-9.6A1 1 0 0 1 14.3 3L12 9h6a1 1 0 0 1 .7 1.7l-9.6 9.6A1 1 0 0 1 7.7 20L10 14Z"/>',
    'circle-dot': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
    radio: '<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2"/>',
    signal: '<path d="M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 20V4"/>',
    wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01"/>',
    'wifi-off': '<path d="M2 2l20 20M8.5 16a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4-2.4M15 10.1a10 10 0 0 1 4 2.4M2 9a15 15 0 0 1 4.2-2.7M13.8 6.1A15 15 0 0 1 22 9M12 20h.01"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2.1Z"/>',
    braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/>',
    discord: '<path d="M8.5 6.5A15 15 0 0 0 5 8.2 17 17 0 0 0 3 17.8a15 15 0 0 0 4.5 2.3l.9-1.5M15.5 6.5A15 15 0 0 1 19 8.2a17 17 0 0 1 2 9.6 15 15 0 0 1-4.5 2.3l-.9-1.5"/><path d="M8.5 6.5h7M8.5 6.5 7 4.8A13 13 0 0 1 10 4l.5 1.5M15.5 6.5 17 4.8A13 13 0 0 0 14 4l-.5 1.5"/><circle cx="9" cy="13" r="1.5"/><circle cx="15" cy="13" r="1.5"/><path d="M9.5 17.5a5 5 0 0 0 5 0"/>',
    server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
    'hard-drive': '<path d="M22 12H2M5.5 5h13l3.5 7v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5Z"/><path d="M6 16h.01M10 16h.01"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    share: '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    'check-circle': '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    'x-circle': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.4 1Z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    'external-link': '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 15a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    timer: '<path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="m2 2 20 20M6.7 6.7C3.9 8.4 2 12 2 12s3.5 7 10 7c2.2 0 4.1-.8 5.6-1.9M10.6 5.2A10 10 0 0 1 12 5c6.5 0 10 7 10 7a16.7 16.7 0 0 1-2.3 3.3M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3Z"/><circle cx="12" cy="13" r="4"/>',
    scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"/>',
    crosshair: '<circle cx="12" cy="12" r="9"/><path d="M22 12h-4M6 12H2M12 6V2M12 22v-4"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
    'shield-check': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    'alert-triangle': '<path d="M10.3 3.2 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    'alert-circle': '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
    'info-circle': '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2L5.8 21 7 14.2l-5-4.9 6.9-1Z"/>',
    bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/>',
    gift: '<rect x="3" y="8" width="18" height="13" rx="2"/><path d="M12 8v13M3 12h18M7.5 8a2.5 2.5 0 1 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 1 1 0 5"/>',
    coins: '<circle cx="8" cy="8" r="6"/><path d="M18.1 7.1A6 6 0 1 1 12 16M6 8h.01M10 8h.01M8 6v4"/>',
    crown: '<path d="m2 8 4 3 6-7 6 7 4-3-2 11H4Z"/><path d="M4 19h16"/>',
    flame: '<path d="M12 22c4.4 0 7-3.2 7-7.4 0-3.5-2.4-6.1-4.3-8.6C13 4 12 2 12 2s-.5 2.8-2.4 5.2C7.6 10 5 12.4 5 14.6 5 18.8 7.6 22 12 22Z"/><path d="M9 17c0 1.7 1.3 3 3 3s3-1.3 3-3c0-1.4-1-2.6-2-3.5-.5-.5-1-1.2-1-1.5 0 .3-.5 1-1 1.5-1 .9-2 2.1-2 3.5Z"/>',
    folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    'layout-grid': '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    layers: '<path d="m12.8 2.4 8.4 4.6a1 1 0 0 1 0 1.8l-8.4 4.6a1.6 1.6 0 0 1-1.6 0L2.8 8.8a1 1 0 0 1 0-1.8l8.4-4.6a1.6 1.6 0 0 1 1.6 0Z"/><path d="m22 12.5-9.2 5a1.6 1.6 0 0 1-1.6 0l-9.2-5M22 17.5l-9.2 5a1.6 1.6 0 0 1-1.6 0l-9.2-5"/>',
    'wand-sparkles': '<path d="m21.6 4.4-1-2-2 1-1-3-1.5 3-3 .5 2 2-1 3 3-1 2 2 .5-3 3-1.5Z"/><path d="m2 22 13-13 3 3L5 25Z" transform="translate(0 -2)"/>',
    wand: '<path d="m15 4 5 5M3 21 18 6l-3-3L2 16Z"/><path d="M9 12h.01M13 16h.01"/>',
    'panel-left': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
    grip: '<circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/>',
    hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
    paperclip: '<path d="m21.4 11.05-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
    reply: '<path d="m9 17-5-5 5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/>',
    'help-circle': '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 17h.01"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M10 14h4"/>',
    cast: '<path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6M2 12a9 9 0 0 1 8 8M2 16a5 5 0 0 1 5 5M2 20h.01"/>',
    'external': '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    refresh_cw: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
    'cloud-off': '<path d="M6.3 6.3A6 6 0 0 0 7 18h10a4 4 0 0 0 2.5-.9M3 3l18 18"/><path d="M9 5a6 6 0 0 1 10 4 4 4 0 0 1 2.5 6.5"/>',
    scale: '<path d="M12 3v18M5 7h14M7 7l-4 7h8L7 7ZM17 7l-4 7h8l-4-7ZM8 21h8"/>',
    'panel-top': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/>',
    rows: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/>',
    'external-link': '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    'list-filter': '<path d="M4 5h16M7 12h10M10 19h4"/>',
    'circle-dot': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2" fill="currentColor"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    'memory-stick': '<path d="M6 2v6M10 2v6M14 2v6M18 2v6"/><path d="M4 8h16v10a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z"/><path d="M8 15h.01M12 15h.01M16 15h.01"/>',
  };

  K.icon = function icon(name, cls = '') {
    let key = name;
    if (key === 'sparkle') key = 'sparkles';
    if (key === 'music-note') key = 'music';
    if (key === 'chart') key = 'bar-chart';
    if (key === 'help') key = 'help-circle';
    if (key === 'back') key = 'chevron-left';
    if (key === 'forward') key = 'chevron-right';
    if (key === 'gear') key = 'settings';
    if (key === 'play-filled') key = 'play';
    const markup = P[key] || P['circle-dot'];
    return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${markup}</svg>`;
  };

  // ---------------------------------------------------------------------
  // UI primitives
  // ---------------------------------------------------------------------
  K.avatar = function avatar(opts = {}) {
    const url = opts.url || '';
    const name = opts.name || 'Kizzey';
    const cls = ['avatar', opts.cls || ''].filter(Boolean).join(' ');
    const style = opts.style ? ` style="${K.esc(opts.style)}"` : '';
    const initials = K.esc(K.initials(name));
    if (url) {
      return `<span class="${cls}"${style}><img src="${K.esc(url)}" alt="${K.esc(name)}" loading="lazy" data-initials="${initials}" onerror="this.parentNode.classList.add('fallback');this.parentNode.textContent=this.dataset.initials"></span>`;
    }
    return `<span class="${cls} fallback"${style}>${initials}</span>`;
  };

  K.iconBtn = function iconBtn(icon, action = '', label = '', cls = '') {
    return `<button class="icon-btn ${cls}" ${action ? `data-action="${K.esc(action)}"` : ''} aria-label="${K.esc(label || icon)}" title="${K.esc(label || '')}">${K.icon(icon)}</button>`;
  };

  K.btn = function btn(label, opts = {}) {
    const cls = ['btn', opts.cls || ''].filter(Boolean).join(' ');
    const attrs = [];
    if (opts.action) attrs.push(`data-action="${K.esc(opts.action)}"`);
    if (opts.route) attrs.push(`data-route="${K.esc(opts.route)}"`);
    if (opts.id) attrs.push(`id="${K.esc(opts.id)}"`);
    if (opts.attrs) attrs.push(opts.attrs);
    if (opts.disabled) attrs.push('disabled');
    const ico = opts.icon ? K.icon(opts.icon, 'sm') : '';
    return `<button class="${cls}" ${attrs.join(' ')}>${ico}${label}</button>`;
  };

  K.chip = function chip(label, opts = {}) {
    const cls = ['chip', opts.active ? 'active' : '', opts.cls || ''].filter(Boolean).join(' ');
    const attrs = [];
    if (opts.action) attrs.push(`data-action="${K.esc(opts.action)}"`);
    if (opts.route) attrs.push(`data-route="${K.esc(opts.route)}"`);
    if (opts.value !== undefined) attrs.push(`data-value="${K.esc(opts.value)}"`);
    if (opts.title) attrs.push(`title="${K.esc(opts.title)}"`);
    return `<button class="${cls}" ${attrs.join(' ')}>${opts.icon ? K.icon(opts.icon, 'sm') : ''}${opts.avatar || ''}${label}</button>`;
  };

  K.field = function field(opts = {}) {
    const id = opts.id || `f-${K.uid()}`;
    const value = opts.value ?? '';
    const type = opts.type || 'text';
    const label = opts.label || '';
    const hint = opts.hint || '';
    const attrs = [
      `id="${id}"`,
      `class="input ${opts.inputClass || ''}"`,
      `data-model="${K.esc(opts.path || '')}"`,
      opts.placeholder ? `placeholder="${K.esc(opts.placeholder)}"` : '',
      opts.autocomplete ? `autocomplete="${K.esc(opts.autocomplete)}"` : 'autocomplete="off"',
      opts.maxlength ? `maxlength="${K.num(opts.maxlength, 0)}"` : '',
      opts.min !== undefined ? `min="${K.esc(opts.min)}"` : '',
      opts.max !== undefined ? `max="${K.esc(opts.max)}"` : '',
      opts.step !== undefined ? `step="${K.esc(opts.step)}"` : '',
      opts.readonly ? 'readonly' : '',
      opts.disabled ? 'disabled' : '',
      opts.required ? 'required' : '',
      type === 'range' ? 'data-type="number"' : '',
      opts.attrs || '',
    ].filter(Boolean);
    let input;
    if (type === 'textarea') {
      input = `<textarea ${attrs.join(' ')} rows="${opts.rows || 3}" ${opts.maxlength ? `maxlength="${opts.maxlength}"` : ''}>${K.esc(value)}</textarea>`;
    } else {
      input = `<input ${attrs.join(' ')} type="${K.esc(type)}" value="${K.esc(value)}">`;
    }
    const suffix = opts.suffix ? `<span class="input-suffix">${opts.suffix}</span>` : '';
    const right = opts.right ? `<span style="font-size:0.6875rem;color:var(--faint)">${opts.right}</span>` : '';
    return `<div class="field ${opts.cls || ''}">
      ${label ? `<label for="${id}"><span>${label}</span>${right}</label>` : ''}
      <div class="input-wrap">${input}${suffix}</div>
      ${hint ? `<div class="field-hint">${hint}</div>` : ''}
    </div>`;
  };

  K.textarea = function textarea(opts = {}) {
    return K.field(Object.assign({}, opts, { type: 'textarea' }));
  };

  K.select = function select(opts = {}) {
    const id = opts.id || `s-${K.uid()}`;
    const value = String(opts.value ?? '');
    const options = (opts.options || []).map(o => {
      const val = typeof o === 'object' ? String(o.value) : String(o);
      const label = typeof o === 'object' ? o.label : o;
      return `<option value="${K.esc(val)}" ${val === value ? 'selected' : ''}>${K.esc(label)}</option>`;
    }).join('');
    return `<div class="field ${opts.cls || ''}">
      ${opts.label ? `<label for="${id}">${opts.label}${opts.right ? `<span style="font-size:0.6875rem;color:var(--faint);font-weight:400">${opts.right}</span>` : ''}</label>` : ''}
      <select id="${id}" class="select" data-model="${K.esc(opts.path || '')}" ${opts.disabled ? 'disabled' : ''}>${options}</select>
      ${opts.hint ? `<div class="field-hint">${opts.hint}</div>` : ''}
    </div>`;
  };

  K.switch = function switchControl(path, checked, opts = {}) {
    const id = `sw-${K.uid()}`;
    return `<label class="switch" for="${id}" title="${K.esc(opts.title || '')}">
      <input id="${id}" type="checkbox" data-model="${K.esc(path)}" data-type="bool" ${checked ? 'checked' : ''} ${opts.attrs || ''}>
      <span class="track"></span><span class="thumb"></span>
    </label>`;
  };

  K.toggleRow = function toggleRow(opts = {}) {
    const inner = `<div class="setting-body">
      <div class="setting-title">${opts.title || ''}</div>
      ${opts.desc ? `<div class="setting-desc">${opts.desc}</div>` : ''}
    </div>${K.switch(opts.path, opts.checked)}`;
    return `<div class="setting-row ${opts.cls || ''}">${opts.icon ? `<div class="setting-icon">${K.icon(opts.icon)}</div>` : ''}${inner}</div>`;
  };

  K.tappableRow = function tappableRow(opts = {}) {
    return `<button class="setting-row tappable" style="width:100%;background:none;border-left:0;border-right:0;border-top:0;text-align:left" ${opts.action ? `data-action="${K.esc(opts.action)}"` : ''} ${opts.route ? `data-route="${K.esc(opts.route)}"` : ''}>
      ${opts.icon ? `<div class="setting-icon">${K.icon(opts.icon)}</div>` : ''}
      <div class="setting-body"><div class="setting-title">${opts.title}</div>${opts.desc ? `<div class="setting-desc">${opts.desc}</div>` : ''}</div>
      ${opts.end ?? K.icon('chevron-right', 'sm')}
    </button>`;
  };

  K.segmented = function segmented(path, value, options, opts = {}) {
    return `<div class="segmented ${opts.primary ? 'primary' : ''}" data-segment="${K.esc(path)}">
      ${options.map(o => {
        const val = typeof o === 'object' ? o.value : o;
        const label = typeof o === 'object' ? o.label : o;
        return `<button data-action="segment" data-path="${K.esc(path)}" data-value="${K.esc(val)}" class="${String(val) === String(value) ? 'active' : ''}">${K.esc(label)}</button>`;
      }).join('')}
    </div>`;
  };

  K.settingGroup = function settingGroup(title, inner) {
    return `${title ? `<div class="setting-group-title">${title}</div>` : ''}<div class="setting-group">${inner}</div>`;
  };

  K.empty = function empty(icon, title, copy, action = '') {
    return `<div class="empty"><div class="empty-icon">${K.icon(icon, 'lg')}</div><h3>${K.esc(title)}</h3><p>${K.esc(copy)}</p>${action ? `<div class="mt-16">${action}</div>` : ''}</div>`;
  };

  K.pageHead = function pageHead(opts = {}) {
    const back = opts.back === false ? '' : `<button class="icon-btn back" data-action="back" aria-label="Back">${K.icon('chevron-left')}</button>`;
    return `<div class="page-head">
      ${back}
      <div class="page-head-main">
        <h1 class="page-title">${opts.title || ''}</h1>
        ${opts.sub ? `<p class="page-sub">${opts.sub}</p>` : ''}
      </div>
      <div class="page-head-actions">${opts.actions || ''}</div>
    </div>`;
  };

  K.sectionLabel = function sectionLabel(label, right = '') {
    return `<div class="section-label"><span>${label}</span>${right}</div>`;
  };

  K.presenceIcon = function presenceIcon(kind, html = true) {
    const meta = K.presenceKinds[kind] || K.presenceKinds.custom;
    return html ? K.icon(meta.icon) : meta;
  };

  K.presenceCard = function presenceCard(opts = {}) {
    const p = K.currentPresence();
    const running = !!p;
    const start = p ? p.startedAt : Date.now();
    const meta = K.presenceKinds[p?.kind || 'custom'];
    if (!running) {
      return `<div class="live-card idle">
        <div class="live-top"><div class="live-label"><span class="dot off"></span>No presence running</div>${opts.compact ? '' : `<span class="live-time">Ready</span>`}</div>
        <div class="live-main">
          <div class="live-art">${K.icon('sparkles', 'lg')}</div>
          <div><div class="live-title">Your card is waiting.</div><div class="live-sub">Start with a custom card or let media take over.</div></div>
        </div>
        <div class="live-actions">
          <button class="btn btn-primary" data-route="custom">${K.icon('sparkles', 'sm')}Design a card</button>
          <button class="btn btn-ghost" data-route="quick">${K.icon('sliders', 'sm')}Quick controls</button>
        </div>
      </div>`;
    }
    const art = opts.artUrl || K.presenceArt(p);
    return `<div class="live-card">
      <div class="live-top">
        <div class="live-label"><span class="dot pulse"></span>${K.esc(meta.label)} live</div>
        <span class="live-time" data-live-start="${start}">${K.duration(Date.now() - start)}</span>
      </div>
      <div class="live-main">
        <div class="live-art">${art ? `<img src="${K.esc(art)}" alt="">` : K.icon(meta.icon, 'lg')}</div>
        <div style="min-width:0;flex:1"><div class="live-title">${K.esc(p.title || meta.label)}</div><div class="live-sub">${K.esc(p.subtitle || 'Rich presence is live')}</div></div>
      </div>
      <div class="live-actions">
        <button class="btn btn-quiet" data-action="share-presence">${K.icon('share', 'sm')}Share</button>
        <button class="btn btn-ghost" data-action="stop-all" style="flex:.7">${K.icon('stop', 'sm')}Stop</button>
        <button class="btn btn-quiet" data-route="${K.esc(K.routeForKind(p.kind))}" style="flex:.9">Edit</button>
      </div>
    </div>`;
  };

  K.presencePreview = function presencePreview(activity, opts = {}) {
    const a = activity || {};
    const art = opts.artUrl || '';
    const smallArt = opts.smallArtUrl || '';
    const type = K.typeLabel(a.type);
    const elapsedStart = a.timestamps?.start || opts.start || null;
    const elapsed = elapsedStart ? K.duration(Date.now() - elapsedStart) : '';
    const title = a.name || opts.placeholder || 'Your activity name';
    const details = a.details || opts.detailsPlaceholder || 'Details appear here';
    const state = a.state || '';
    const buttons = Array.isArray(a.buttons) ? a.buttons.slice(0, 2) : [];
    return `<div class="discord-preview">
      <div class="dp-top">
        <div class="dp-appicon">${opts.appIcon ? `<img src="${K.esc(opts.appIcon)}" alt="">` : K.icon('sparkles', 'sm')}</div>
        <div><div class="dp-appname">${K.esc(opts.appName || 'Kizzey')}</div><div class="dp-type">${K.esc(type)} ${K.esc(opts.typeSuffix || '')}</div></div>
      </div>
      <div class="dp-card">
        <div class="dp-text">
          <div class="dp-title">${K.esc(title)}</div>
          <div class="dp-line">${K.esc(details)}</div>
          ${state ? `<div class="dp-line">${K.esc(state)}</div>` : ''}
          ${elapsed ? `<div class="dp-elapsed">${K.esc(elapsed)} elapsed</div>` : ''}
        </div>
        <div class="dp-art">${art ? `<img src="${K.esc(art)}" alt="">` : K.icon('image', 'lg')}${smallArt ? `<span class="small-art"><img src="${K.esc(smallArt)}" alt=""></span>` : ''}</div>
      </div>
      ${buttons.length ? `<div class="dp-buttons">${buttons.map(b => `<button class="dp-button" type="button" data-action="presence-button" data-label="${K.esc(b)}">${K.esc(b)}</button>`).join('')}</div>` : ''}
    </div>`;
  };

  K.actions['presence-button'] = el => {
    K.toast('Presence button', el.dataset.label || 'This button opens its link inside Discord.', '');
  };

  K.actionButton = function actionButton(label, action, opts = {}) {
    return `<button class="btn ${opts.cls || ''}" data-action="${K.esc(action)}" ${opts.attrs || ''}>${opts.icon ? K.icon(opts.icon, 'sm') : ''}${label}</button>`;
  };

  K.copy = async function copy(text, message = 'Copied') {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
      K.toast(message, '', 'ok');
    } catch {
      K.toast('Could not copy', String(text).slice(0, 80), 'error');
    }
  };

  K.download = function download(filename, content, type = 'application/json') {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  K.bindFilePicker = function bindFilePicker(callback, accept = 'image/*') {
    const id = 'file-' + K.uid();
    const host = $('#file-inputs');
    host.insertAdjacentHTML('beforeend', `<input id="${id}" type="file" accept="${K.esc(accept)}" class="hidden">`);
    const input = $('#' + id);
    input.addEventListener('change', async () => {
      if (input.files && input.files[0]) await callback(input.files[0]);
      input.remove();
    });
    input.click();
  };

  K.uploadDataUrl = async function uploadDataUrl(file, opts = {}) {
    if (!file) return null;
    if (file.size > 12 * 1024 * 1024) throw new Error('That image is larger than 12 MB.');
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const body = { data, filename: file.name };
    if (opts.localOnly) body.localOnly = true;
    return K.api(opts.endpoint || '/api/upload', { method: 'POST', body });
  };

  K.timeAgoClock = function timeAgoClock(ms) {
    if (!ms) return '';
    return K.relTime(ms);
  };

  // theme application
  function hexToRgb(hex) {
    const h = String(hex || '#d3c0f6').replace('#', '');
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    return [parseInt(full.slice(0, 2), 16) || 0, parseInt(full.slice(2, 4), 16) || 0, parseInt(full.slice(4, 6), 16) || 0];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }
  function mix(hex, other, amount) {
    const a = hexToRgb(hex), b = hexToRgb(other);
    return rgbToHex(a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount);
  }

  K.lastArtUrl = K.lastArtUrl || '';
  K.artAccentUrl = K.artAccentUrl || '';
  K.artAccentColor = K.artAccentColor || '';
  K.artAccentPending = K.artAccentPending || '';

  function artPalette(url) {
    if (!url || K.artAccentUrl === url || K.artAccentPending === url) return;
    K.artAccentPending = url;
    const img = new Image();
    if (!url.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 36;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        const pixels = ctx.getImageData(0, 0, size, size).data;
        const bins = new Map();
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] < 160) continue;
          const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const l = (max + min) / 510;
          const s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
          if (s < .14 || l < .1 || l > .92) continue;
          const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
          const bin = bins.get(key) || { r: 0, g: 0, b: 0, n: 0, s: 0 };
          bin.r += r; bin.g += g; bin.b += b; bin.n += 1; bin.s += s;
          bins.set(key, bin);
        }
        let best = null, bestScore = 0;
        for (const bin of bins.values()) {
          const r = bin.r / bin.n, g = bin.g / bin.n, b = bin.b / bin.n;
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const l = (max + min) / 510;
          const sat = bin.s / bin.n;
          const score = sat * Math.sqrt(bin.n) * (1 - Math.min(.7, Math.abs(l - .58) * 1.35));
          if (score > bestScore) { bestScore = score; best = [r, g, b]; }
        }
        K.artAccentUrl = url;
        K.artAccentColor = best ? rgbToHex(...best) : '';
      } catch (error) {
        K.artAccentUrl = url;
        K.artAccentColor = '';
      } finally {
        K.artAccentPending = '';
        if (K.state) applyTheme();
      }
    };
    img.onerror = () => {
      K.artAccentUrl = url;
      K.artAccentColor = '';
      K.artAccentPending = '';
      if (K.state) applyTheme();
    };
    img.src = url;
  }

  function applyArtBackdrop(accentEnabled) {
    const backdrop = document.getElementById('art-backdrop');
    const active = !!K.get('settings.artBackground');
    const current = K.currentPresence();
    const art = current ? K.presenceArt(current) : '';
    if (art) K.lastArtUrl = art;
    const url = active ? (art || K.lastArtUrl) : '';
    if (backdrop) {
      backdrop.style.backgroundImage = url ? `url("${String(url).replace(/["\\\n\r]/g, ch => '\\' + ch)}")` : '';
      backdrop.style.setProperty('--art-blur', `${Math.max(0, Math.min(50, K.num(K.get('settings.artBackgroundBlur'), 24)))}px`);
      backdrop.style.setProperty('--art-shade', `${Math.max(0, Math.min(90, K.num(K.get('settings.artBackgroundDim'), 40))) / 100}`);
    }
    document.body.classList.toggle('art-on', active && !!url);
    if (accentEnabled) artPalette(url);
    return { url, active: active && !!url };
  }

  function applyTheme() {
    if (!K.state) return;
    for (const name of K.customThemeProps || []) {
      document.documentElement.style.removeProperty(name);
    }
    K.customThemeProps = new Set();
    let theme = K.get('settings.theme', 'dark');
    if (theme === 'system') theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    if (K.get('settings.amoled')) theme = 'amoled';
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = K.get('settings.accent', '#d3c0f6');
    document.documentElement.dataset.bubble = K.get('settings.chatBubble') === 'soft' ? 'soft' : '';
    document.documentElement.classList.toggle('reduce-motion', !!K.get('settings.reduceMotion'));
    const useArtAccent = !!K.get('settings.accentFromArt') && !!K.artAccentColor;
    const accent = useArtAccent ? K.artAccentColor : K.get('settings.accent', '#d3c0f6');
    applyArtBackdrop(!!K.get('settings.accentFromArt'));
    const dark = theme !== 'light';
    document.documentElement.style.setProperty('--primary', accent);
    document.documentElement.style.setProperty('--primary-strong', dark ? mix(accent, '#ffffff', .2) : mix(accent, '#000000', .18));
    document.documentElement.style.setProperty('--primary-container', dark ? mix(accent, '#24152f', .62) : mix(accent, '#ffffff', .7));
    document.documentElement.style.setProperty('--on-primary', dark ? mix(accent, '#1a1024', .82) : '#ffffff');
    document.documentElement.style.setProperty('--on-primary-container', dark ? mix(accent, '#ffffff', .6) : mix(accent, '#1a1024', .8));
    document.documentElement.style.setProperty('--secondary-container', dark ? mix(accent, '#33303b', .7) : mix(accent, '#ffffff', .78));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#141118';
    if (K.get('settings.highContrast')) {
      document.documentElement.style.setProperty('--muted', dark ? '#ddd5e5' : '#55495f');
      document.documentElement.style.setProperty('--text-dim', dark ? '#f0eaf6' : '#31283a');
    } else {
      document.documentElement.style.removeProperty('--muted');
      document.documentElement.style.removeProperty('--text-dim');
    }
    // imported CSS variables (custom themes)
    const customCss = K.get('settings.customThemeCss');
    let styleEl = document.getElementById('kizzey-custom-theme');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'kizzey-custom-theme';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = customCss ? (customCss.includes('{') ? customCss : `:root {\n${customCss}\n}`) : '';
    // A bare declaration block is also applied directly with priority, so it
    // can override the computed accent variables as the settings UI promises.
    for (const match of customCss.matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*([^;{}]+)/g)) {
      const name = match[1];
      const value = String(match[2] || '').trim();
      if (!value) continue;
      document.documentElement.style.setProperty(name, value, 'important');
      K.customThemeProps.add(name);
    }
    const fontScale = K.get('settings.fontScale', 1);
    document.documentElement.style.fontSize = `${Math.max(.82, Math.min(1.25, Number(fontScale) || 1)) * 16}px`;
  }
  K.applyTheme = applyTheme;

  // format relative timestamp updates
  setInterval(() => {
    $$('[data-live-start]').forEach(el => {
      const start = Number(el.dataset.liveStart);
      if (start) el.textContent = K.duration(Date.now() - start);
    });
    $$('[data-rel-time]').forEach(el => {
      el.textContent = K.relTime(Number(el.dataset.relTime));
    });
  }, 1000);

  // close sheet with escape
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (K.modal) K.closeSheet();
      else if (K.drawerOpen) K.closeDrawer();
    }
  });

  // System light-mode changes
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  mq.addEventListener?.('change', () => { if (K.get('settings.theme') === 'system') applyTheme(); });

  console.info('%cKizzey Web', 'color:#d3c0f6;font-weight:700', 'core ready');
})();
