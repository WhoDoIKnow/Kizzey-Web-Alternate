/* Kizzey Web — application shell, routing, home and onboarding */
(function () {
  'use strict';
  const K = window.K;

  K.updateInfo = null;
  K.updatePromise = null;
  K.liveRoutes = new Set(['home', 'logs', 'history', 'usage', 'kizzey-stats', 'leaderboard', 'gallery', 'trending', 'presences']);
  K.routeTitles = {
    home: 'Home',
    welcome: 'Welcome',
    profile: 'Profile',
    accounts: 'Discord accounts',
    mirror: 'Message mirror',
    chat: 'Kizzey Chat',
    voice: 'Voice',
    moments: 'Moments',
    leaderboard: 'Leaderboard',
    gallery: 'Preset Gallery',
    trending: 'Trending',
    presences: 'Discord Presences',
    usage: 'Usage stats',
    history: 'Presence history',
    'kizzey-stats': 'Kizzey Stats',
    custom: 'Custom RPC',
    apps: 'App Detection',
    media: 'Media RPC',
    console: 'Console RPC',
    experimental: 'Experimental RPC',
    cycling: 'RPC Cycling',
    multiple: 'Multiple RPC',
    'screen-read': 'Screen Read',
    health: 'Health',
    location: 'Location',
    weather: 'Weather',
    navigation: 'Navigation',
    'android-auto': 'Android Auto',
    samsung: 'Samsung RPC',
    emulation: 'Emulation RPC',
    quick: 'Quick Controls',
    automation: 'Automation',
    bulk: 'Bulk message removal',
    shizuku: 'Shizuku Tools',
    plugins: 'Plugins',
    logs: 'Logs',
    'rpc-settings': 'RPC Settings',
    display: 'Display',
    language: 'Language',
    about: 'About',
    changelog: 'Changelog',
    policies: 'Policies',
    backup: 'Backup & restore',
    update: 'Updates',
    shop: 'KCoin Shop',
    premium: 'Kizzey+',
    settings: 'Settings',
    credits: 'Credits',
    debug: 'Debug',
  };

  // ---------------------------------------------------------------------
  // routing
  // ---------------------------------------------------------------------
  function parseHash() {
    const raw = (location.hash || '').replace(/^#\/?/, '');
    const [pathPart, queryPart] = raw.split('?');
    const route = (pathPart || 'home').replace(/\/+$/, '') || 'home';
    const params = {};
    if (queryPart) {
      for (const [k, v] of new URLSearchParams(queryPart)) params[k] = v;
    }
    return { route, params };
  }

  K.navigate = function navigate(route, params = {}, opts = {}) {
    route = String(route || 'home').replace(/^#?\/?/, '');
    K.closeSheet();
    if (K.drawerOpen) K.closeDrawer();
    const query = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') query.set(key, value);
    });
    const hash = `#/${route}${query.toString() ? '?' + query.toString() : ''}`;
    const same = location.hash === hash;
    if (same) {
      K.current = { route, params };
      K.render();
    } else {
      location.hash = hash;
    }
    if (opts.replace) history.replaceState(null, '', hash);
  };

  K.back = function back() {
    if (history.length > 1) history.back();
    else K.navigate('home');
  };

  K.navigateRoute = K.navigate;

  // ---------------------------------------------------------------------
  // startup / server-sent events
  // ---------------------------------------------------------------------
  async function init() {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    try {
      const data = await K.api('/api/state');
      K.receiveState(data.state);
    } catch (error) {
      document.getElementById('app').innerHTML = `<div class="onboard" style="justify-content:center">
        <div class="onboard-logo"><img src="/icon.png" alt=""></div>
        <h1 style="font-size:1.9375rem">Can't reach Kizzey.</h1>
        <p class="onboard-copy">${K.esc(error.message)} Start the Python server with <span class="mono-copy">python3 server.py</span>, then reload this page.</p>
        <div class="mt-20">${K.btn('Try again', { cls: 'btn-primary btn-lg', action: 'reload' })}</div>
      </div>`;
      return;
    }
    const parsed = parseHash();
    K.current = parsed;
    K.render();
    connectEvents();
    setTimeout(() => loadUpdate().catch(() => {}), 700);
    // A quiet refresh catches changes from another tab if SSE ever drops.
    setInterval(() => {
      if (document.hidden) return;
      K.refresh().then(() => {
        if (K.current.route === 'home' && !K.modal) refreshHomeRuntime();
      }).catch(() => {});
    }, 60000);
  }

  function connectEvents() {
    if (!window.EventSource) return;
    let es;
    try { es = new EventSource('/api/events'); } catch { return; }
    es.addEventListener('state', event => {
      try {
        const data = JSON.parse(event.data);
        if (data.state) {
          K.receiveState(data.state);
          onServerState();
        }
      } catch (err) { console.warn(err); }
    });
    es.addEventListener('gateway', event => {
      try {
        const data = JSON.parse(event.data);
        if (!data.gateway || !K.state) return;
        const id = String(data.accountId || '');
        const focused = id && id === String(K.state.activeAccountId || '');
        // Background accounts keep their own socket; never let their state
        // overwrite the focused account's badge on screen.
        if (id) {
          K.state.gateways = K.state.gateways || {};
          K.state.gateways[id] = data.gateway;
        }
        if (!id || focused) {
          const previous = K.state.gateway?.state;
          K.state.gateway = data.gateway;
          if (data.gateway.state === 'reconnecting' && previous !== 'reconnecting' && K.get('settings.reconnect', true)) {
            K.toast('Reconnecting to Discord', 'The gateway dropped; the server is retrying.', 'warn');
          }
        }
        if (K.current.route === 'home') refreshHomeRuntime();
      } catch {}
    });
    es.addEventListener('presence', event => {
      try {
        const data = JSON.parse(event.data);
        if (!K.state) return;
        if (data.presence) K.state.presence = data.presence;
        if (data.gateway) K.state.gateway = data.gateway;
        if (K.current.route === 'home' && !K.modal) refreshHomeRuntime();
      } catch {}
    });
    es.addEventListener('log', event => {
      try {
        const data = JSON.parse(event.data);
        if (data.log && K.state) {
          K.state.logs = K.state.logs || [];
          if (!K.state.logs.some(l => l.id === data.log.id)) K.state.logs.unshift(data.log);
          if (K.state.logs.length > 200) K.state.logs.length = 200;
          if (K.current.route === 'logs' && typeof K.currentScreen?.onLog === 'function') K.currentScreen.onLog(data.log);
        }
      } catch {}
    });
    es.addEventListener('chat', event => {
      try {
        const data = JSON.parse(event.data);
        if (!K.state || !data.room || !data.message) return;
        const roomMessages = (K.state.chat.messages[data.room] = K.state.chat.messages[data.room] || []);
        const idx = roomMessages.findIndex(m => m.id === data.message.id);
        if (idx >= 0) roomMessages[idx] = data.message;
        else roomMessages.push(data.message);
        if (roomMessages.length > 250) roomMessages.splice(0, roomMessages.length - 250);
        if (typeof K.onChatEvent === 'function') K.onChatEvent(data);
      } catch (err) { console.warn(err); }
    });
    es.addEventListener('moments', event => {
      try {
        const data = JSON.parse(event.data);
        if (K.state && data.moments) K.state.chat.moments = data.moments;
        if (K.current.route === 'moments' && typeof K.currentScreen?.onMoments === 'function') K.currentScreen.onMoments(data.moments);
      } catch {}
    });
    es.addEventListener('weather', event => {
      try {
        const data = JSON.parse(event.data);
        if (K.state && data.weather) K.state.weather.last = data.weather;
        if (typeof K.onWeatherEvent === 'function') K.onWeatherEvent(data.weather);
      } catch {}
    });
    es.onerror = () => { /* EventSource reconnects on its own */ };
  }

  function onServerState() {
    K.applyTheme();
    if (K.modal) return;
    if (K.liveRoutes.has(K.current.route) && !document.activeElement?.matches('input, textarea, select')) {
      K.render({ preserveScroll: true });
    }
  }

  function loadUpdate() {
    if (K.updatePromise) return K.updatePromise;
    K.updatePromise = K.api('/api/update').then(data => {
      K.updateInfo = data.update || null;
      const rail = document.getElementById('update-rail');
      if (rail && K.current.route === 'home') rail.innerHTML = homeUpdateCard();
      return K.updateInfo;
    }).catch(error => {
      K.updatePromise = null;
      throw error;
    });
    return K.updatePromise;
  }
  K.loadUpdate = loadUpdate;

  // ---------------------------------------------------------------------
  // global events
  // ---------------------------------------------------------------------
  document.addEventListener('click', async event => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const scrim = target.closest('[data-drawer-scrim]');
    if (scrim) { K.closeDrawer(); return; }
    if (target.closest('[data-close-sheet]')) { event.preventDefault(); K.closeSheet(); return; }

    const copyEl = target.closest('[data-copy]');
    if (copyEl && !copyEl.dataset.action) {
      event.preventDefault();
      await K.copy(copyEl.dataset.copy, copyEl.dataset.copyMessage || 'Copied');
      return;
    }

    const external = target.closest('a[href]');
    if (external && !external.getAttribute('href').startsWith('#') && external.target !== '_self') return;

    const routeEl = target.closest('[data-route]');
    if (routeEl && !routeEl.hasAttribute('disabled')) {
      event.preventDefault();
      K.navigate(routeEl.dataset.route);
      return;
    }

    const actionEl = target.closest('[data-action]');
    if (actionEl && !actionEl.hasAttribute('disabled')) {
      event.preventDefault();
      const action = actionEl.dataset.action;
      const fn = K.actions[action];
      if (typeof fn === 'function') {
        try {
          await fn(actionEl, event);
        } catch (error) {
          console.error(error);
          if (error && error.message) K.toast('Something went wrong', error.message, 'error');
        }
      } else {
        console.warn('No action registered:', action);
      }
      return;
    }

    const sectionHead = target.closest('[data-section-toggle]');
    if (sectionHead) {
      const card = sectionHead.closest('.section-card');
      if (card) {
        card.classList.toggle('collapsed');
        const key = sectionHead.dataset.sectionToggle;
        if (key) {
          if (card.classList.contains('collapsed')) K.local.collapsed.add(key);
          else K.local.collapsed.delete(key);
          localStorage.setItem('kizzey.collapsed', JSON.stringify([...K.local.collapsed]));
        }
      }
    }
  });

  document.addEventListener('input', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement)) return;
    if (input.id === 'drawer-search') {
      filterDrawer(input.value);
      return;
    }
    if (input.id === 'chat-input') return;
    if (input.dataset.local !== undefined) return;
    if (!input.dataset.model) return;
    let value;
    if (input.type === 'checkbox') value = input.checked;
    else if (input.dataset.type === 'number') value = input.value === '' ? '' : Number(input.value);
    else if (input.dataset.type === 'array') value = input.value.split(',').map(x => x.trim()).filter(Boolean);
    else value = input.value;
    K.update(input.dataset.model, value);
    const counter = input.parentElement?.querySelector('.counter');
    if (counter && input.maxLength > 0) counter.textContent = `${input.value.length}/${input.maxLength}`;
    if (input.type === 'range') {
      const out = input.parentElement?.querySelector('[data-range-value]');
      if (out) out.textContent = input.value;
    }
  });

  document.addEventListener('change', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)) return;
    if (!input.dataset.model) return;
    if (input.dataset.rerender === 'true') {
      setTimeout(() => K.render(), 30);
    }
  });

  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    const action = form.dataset.submitAction;
    if (action && K.actions[action]) K.actions[action](form, event);
  });

  // ---------------------------------------------------------------------
  // login helpers
  // ---------------------------------------------------------------------
  K.loginSheet = function loginSheet(onSuccess, opts = {}) {
    K.onLoginSuccess = typeof onSuccess === 'function' ? onSuccess : null;
    K.sheet({
      title: opts.title || 'Sign in to Discord',
      subtitle: opts.subtitle || 'Your presence, sent from this server.',
      body: `${K.loginPanel('sheet', opts)}
        <div class="text-center mt-12"><button class="btn btn-ghost" data-action="login-help">Where do I find my token?</button></div>`,
    });
  };

  K.ensureLogin = function ensureLogin(callback) {
    if (K.isSignedIn() && K.hasUserToken()) {
      if (typeof callback === 'function') callback();
      return true;
    }
    if (K.isSignedIn() && !K.hasUserToken()) {
      K.toast(
        'Sign in again',
        'This account has no session token saved, so Rich Presence cannot start. Log in with your Discord password, or add a token.',
        'warn'
      );
      K.navigate('accounts');
      return false;
    }
    K.loginSheet(typeof callback === 'function' ? callback : null, { subtitle: 'Connect Discord to publish this presence.' });
    return false;
  };

  // ---------------------------------------------------------------------
  // shared actions
  // ---------------------------------------------------------------------
  K.actions['reload'] = () => location.reload();
  K.actions['back'] = () => K.back();
  K.actions['open-drawer'] = () => K.openDrawer();
  K.actions['close-drawer'] = () => K.closeDrawer();
  K.actions['noop'] = () => {};

  K.actions['segment'] = function (el) {
    const path = el.dataset.path;
    const raw = el.dataset.value;
    if (!path) return;
    let value = raw;
    if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (raw !== '' && !Number.isNaN(Number(raw)) && String(Number(raw)) === raw) value = Number(raw);
    const wrap = el.closest('.segmented');
    wrap?.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === el));
    if (path.startsWith('quick-status')) return;
    if (path.startsWith('quickControls.')) {
      K.update(path, value, { rerender: false });
      return;
    }
    K.update(path, value, { rerender: false });
  };

  K.actions['retry-login'] = () => K.loginSheet();

  K.actions['logout'] = function () {
    const count = Array.isArray(K.get('accounts', [])) ? K.get('accounts', []).length : 0;
    const fallback = count > 1;
    K.confirm({
      title: 'Sign out this account?',
      subtitle: fallback
        ? 'The active token is removed and Kizzey switches to the next saved account. Remove all accounts from Discord accounts to leave every session.'
        : 'Presence updates stop and the active token is removed from this server.',
      confirm: 'Sign out',
      danger: true,
      onConfirm: async () => {
        try {
          await K.flush();
          const data = await K.api('/api/auth/logout', { method: 'POST', body: {} });
          K.receiveState(data.state);
          const next = K.get('account');
          K.toast(
            next ? 'Switched account' : 'Signed out',
            next ? `Kizzey is now using ${next.displayName || 'another saved account'}.` : 'Your token was removed.',
            'ok'
          );
          K.render();
        } catch (error) { K.toast('Could not sign out', error.message, 'error'); }
      },
    });
  };

  K.actions['stop-all'] = async function () {
    try {
      const data = await K.api('/api/rpc/stop', { method: 'POST', body: {} });
      if (data.state) K.receiveState(data.state);
      K.toast('Presence stopped', 'Every active RPC has been cleared.', 'ok');
      K.render();
    } catch (error) { K.toast('Could not stop presence', error.message, 'error'); }
  };

  K.actions['refresh-rpc'] = async function () {
    if (!K.currentPresence()) { K.toast('Nothing is running', 'Start a presence first.', ''); return; }
    try {
      const data = await K.api('/api/rpc/refresh', { method: 'POST', body: {} });
      if (data.state) K.receiveState(data.state);
      K.toast('Presence updated', 'Your card was pushed to Discord again.', 'ok');
      if (K.current.route === 'home') refreshHomeRuntime();
    } catch (error) { K.toast('Could not update RPC', error.message, 'error'); }
  };

  K.actions['share-presence'] = async function () {
    const p = K.currentPresence();
    if (!p) return;
    const text = `${p.title}${p.subtitle ? ' — ' + p.subtitle : ''} · ${K.presenceKinds[p.kind]?.label || 'Kizzey'}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Kizzey presence', text }); return; } catch {}
    }
    await K.copy(text, 'Presence copied');
  };

  K.actions['toggle-secret'] = el => {
    const input = el.closest('.input-wrap')?.querySelector('input');
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
  };

  K.actions['paste-clipboard'] = async el => {
    const target = document.getElementById(el.dataset.target || '');
    if (!target) return;
    target.focus({ preventScroll: true });
    if (!navigator.clipboard?.readText) {
      K.toast('Clipboard unavailable', 'Long-press the field and paste, or use HTTPS for clipboard access.', 'error');
      return;
    }
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) { K.toast('Clipboard is empty', '', 'error'); return; }
      target.value = text;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      if (target.dataset.model) K.update(target.dataset.model, text);
      K.toast('Pasted', '', 'ok');
    } catch (error) {
      K.toast('Clipboard blocked', 'Allow clipboard access, or long-press the field to paste.', 'error');
    }
  };

  K.actions['install-app'] = async function () {
    if (K.local.installPrompt) {
      K.local.installPrompt.prompt();
      const result = await K.local.installPrompt.userChoice;
      if (result.outcome === 'accepted') K.toast('Kizzey installed', 'Open it from your home screen.', 'ok');
      K.local.installPrompt = null;
      return;
    }
    K.sheet({
      title: 'Add Kizzey to your home screen',
      subtitle: 'The closest thing to a system installer in a browser.',
      body: `<div class="setting-group" style="padding:16px">
        <div class="login-steps">
          <span><b class="step-num">1</b><span>Open the browser menu (<b>⋮</b> or <b>Share</b>).</span></span>
          <span><b class="step-num">2</b><span>Tap <b>Add to Home screen</b> / <b>Install app</b>.</span></span>
          <span><b class="step-num">3</b><span>Launch Kizzey from your home screen. It runs full screen and keeps your server URL.</span></span>
        </div>
      </div>
      <div class="modal-actions"><button class="btn btn-primary" data-close-sheet>Close</button></div>`,
    });
  };

  K.actions['toggle-theme'] = () => {
    const current = K.get('settings.theme', 'dark');
    K.set('settings.theme', current === 'light' ? 'dark' : 'light', { save: true });
    K.applyTheme();
    K.render();
  };

  K.actions['check-update'] = async function () {
    K.updatePromise = null;
    try {
      K.toast('Checking Codeberg…', '', '');
      const info = await loadUpdate();
      K.toast('Update check complete', info?.tag ? `Latest release: ${info.tag}` : '', 'ok');
      if (K.current.route === 'update') K.render();
    } catch (error) {
      K.toast('Could not check for updates', error.message, 'error');
    }
  };

  K.actions['open-update'] = () => {
    const info = K.updateInfo;
    const body = `<div class="setting-group" style="padding:16px">
      <div class="card-row" style="gap:12px">
        <div class="update-icon" style="width:52px;height:52px;border-radius:17px;margin:0">${K.icon('download', 'lg')}</div>
        <div><div class="card-title">Kizzey ${K.esc(info?.tag || K.get('version'))}</div><div class="card-sub">${info?.source === 'codeberg' ? 'Latest Codeberg release' : 'Bundled with this web build'}</div></div>
      </div>
      <div class="about-copy" style="margin-bottom:4px">${K.esc(K.stripTags(info?.body || 'The Kizzey experience for every screen — presence, chat, health, weather and automation in one calm place.').slice(0, 900))}</div>
      <div class="modal-actions">
        <a class="btn btn-ghost" href="${K.esc(info?.url || 'https://codeberg.org/UnpackedX/Kizzey/releases')}" target="_blank" rel="noopener">${K.icon('external-link', 'sm')}Release page</a>
        <button class="btn btn-primary" data-action="check-update">${K.icon('refresh', 'sm')}Check again</button>
      </div>
      <div class="field-hint mt-12">This is the web companion. It stays current with the server files; Android builds live on Codeberg.</div>
    </div>`;
    K.sheet({ title: 'Updates', subtitle: `You're on ${K.get('version')}`, body });
  };

  // ---------------------------------------------------------------------
  // render
  // ---------------------------------------------------------------------
  K.render = function render(opts = {}) {
    const root = document.getElementById('app');
    if (!root) return;
    if (!K.state) return;
    const parsed = K.current || parseHash();
    let screen = K.screens[parsed.route];
    if (!K.get('ui.onboarded', false) && !K.isSignedIn()) {
      screen = K.screens.welcome;
    }
    if (!screen) screen = K.screens.notfound;
    const html = screen.render ? screen.render({ route: parsed.route, params: parsed.params || {} }) : '';
    const oldScroll = window.scrollY;
    root.innerHTML = html;
    K.currentScreen = screen;
    K.afterModelChange = null;
    if (typeof screen.mount === 'function') {
      try { screen.mount(root, { route: parsed.route, params: parsed.params || {} }); } catch (err) { console.error('mount', err); }
    }
    if (typeof screen.onModelChange === 'function') K.afterModelChange = screen.onModelChange;
    if (opts.preserveScroll) window.scrollTo({ top: oldScroll, behavior: 'instant' });
    else window.scrollTo({ top: 0, behavior: 'instant' });
    document.title = `${screen.title || K.routeTitles[parsed.route] || 'Kizzey'} · Kizzey`;
    K.applyTheme();
    refreshHomeRuntime();
  };

  function refreshHomeRuntime() {
    if (!K.state) return;
    const live = document.getElementById('home-live');
    if (live) live.innerHTML = K.presenceCard();
    const greet = document.getElementById('home-greeting');
    if (greet) greet.textContent = K.greeting();
    const av = document.getElementById('home-avatar');
    if (av) av.innerHTML = K.avatar({ url: K.avatarUrl(), name: K.displayName(), cls: '' });
    const status = document.getElementById('home-gateway-note');
    if (status) {
      const s = K.discordStatus();
      status.innerHTML = `<span class="dot ${s.color === 'good' ? '' : s.color === 'warn' ? 'warn' : 'off'}"></span>${K.esc(s.text)}`;
    }
    const chips = document.getElementById('home-recent');
    if (chips) chips.innerHTML = recentChips();
  }
  K.refreshHomeRuntime = refreshHomeRuntime;

  // ---------------------------------------------------------------------
  // onboarding
  // ---------------------------------------------------------------------
  K.screens.welcome = {
    title: 'Welcome',
    render() {
      const step = K.welcomeStep || 0;
      if (step === 1) return renderWelcomeLogin();
      return `<div class="onboard">
        <div class="onboard-top">
          <div class="brand"><img src="/icon.png" alt=""> Kizzey</div>
          <button class="skip-link" data-action="welcome-skip">Skip</button>
        </div>
        <div class="onboard-hero">
          <div class="onboard-logo"><img src="/icon.png" alt="Kizzey"></div>
          <div class="eyebrow">Discord rich presence, rebuilt</div>
          <h1>Your Discord,<br><em>alive.</em></h1>
          <p class="onboard-copy">A calmer home for everything your presence can be. Design a card, show your music, read your screen, or let the app do the talking.</p>
          <div class="onboard-features">
            <div class="onboard-feature"><div class="ofi">${K.icon('sparkles', 'sm')}</div><div><b>Every Kizzey mode, in one place</b><span>Custom, apps, media, console, cycling and multiple RPC.</span></div></div>
            <div class="onboard-feature"><div class="ofi">${K.icon('message-circle', 'sm')}</div><div><b>A community that follows you</b><span>Chat, moments, galleries and a shared leaderboard.</span></div></div>
            <div class="onboard-feature"><div class="ofi">${K.icon('shield-check', 'sm')}</div><div><b>Your token stays yours</b><span>The server holds it. The browser never sees it again.</span></div></div>
          </div>
        </div>
        <div class="onboard-bottom">
          <button class="btn btn-primary btn-lg btn-block" data-action="welcome-next">${K.icon('discord', 'sm')}Sign in with Discord</button>
          <div class="text-center mt-12"><button class="btn btn-ghost btn-sm" data-action="welcome-skip">Explore without connecting</button></div>
          <div class="welcome-footer">${K.icon('lock', 'sm')} Local-first · your server · no third-party cloud</div>
        </div>
      </div>`;
    },
    mount() {
      K.welcomeStep = K.welcomeStep || 0;
      if (K.welcomeStep === 1) {
        K.onLoginSuccess = async () => {
          if (K.currentScreen !== K.screens.welcome) return;
          K.setLocal('ui.onboarded', true);
          await K.queuePatch({ ui: { onboarded: true } }, 0);
          K.welcomeStep = 0;
          K.navigate('home');
          setTimeout(() => {
            K.toast('You are connected', `Welcome, ${K.displayName()}.`, 'ok');
            K.render();
          }, 80);
        };
      }
    },
  };

  function renderWelcomeLogin() {
    return `<div class="onboard">
      <div class="onboard-top">
        <button class="icon-btn" data-action="welcome-back">${K.icon('chevron-left')}</button>
        <div class="brand"><img src="/icon.png" alt=""> Kizzey</div>
        <button class="skip-link" data-action="welcome-skip">Skip</button>
      </div>
      <div style="margin-top:38px">
        <div class="eyebrow">One connection, every account</div>
        <h1 style="font-size:2.0625rem;line-height:1.04;letter-spacing:-.045em;margin:0 0 10px">Sign in with <em>Discord.</em></h1>
        <p class="onboard-copy" style="max-width:36ch">Log in the way you would on discord.com. The session token stays on this machine, the browser never sees it again, and you can add more accounts later — each one keeps its own presence running.</p>
        ${K.loginPanel('welcome')}
        <button class="btn btn-ghost btn-block mt-12" data-action="welcome-skip">Explore Kizzey without connecting</button>
        <div class="welcome-footer">${K.icon('info', 'sm')} You can connect later from Settings.</div>
      </div>
    </div>`;
  }

  K.actions['welcome-next'] = () => { K.welcomeStep = 1; K.render(); };
  K.actions['welcome-back'] = () => { K.welcomeStep = 0; K.render(); };
  K.actions['welcome-skip'] = async () => {
    K.setLocal('ui.onboarded', true);
    await K.queuePatch({ ui: { onboarded: true } }, 0);
    K.welcomeStep = 0;
    K.navigate('home');
    setTimeout(() => K.render(), 50);
  };

  // ---------------------------------------------------------------------
  // home
  // ---------------------------------------------------------------------
  const featureSections = [
    {
      title: 'Automatic RPC',
      desc: 'Shows what you are using, hands-free',
      kinds: ['apps', 'media', 'experimental', 'screen_read'],
    },
    {
      title: 'Manual RPC',
      desc: 'Design and cycle your own presence',
      kinds: ['custom', 'cycling', 'multiple', 'console'],
    },
    {
      title: 'Account tools',
      desc: 'Automation and utilities for your presence',
      kinds: ['health', 'location', 'weather', 'navigation', 'android_auto', 'emulation', 'samsung'],
    },
  ];

  function homeUpdateCard() {
    const info = K.updateInfo;
    const version = K.get('version', '8.4.4').replace(/^Kizzey\s*/i, '');
    return `<article class="update-card">
      <div class="card-row" style="align-items:flex-start;gap:15px">
        <div class="update-icon" style="margin-bottom:0;flex:none;width:58px;height:58px;border-radius:19px">${K.icon('download')}</div>
        <div style="flex:1;min-width:0">
          <h2 class="update-title" style="font-size:1.4375rem;line-height:1.16;margin:0 0 7px">Kizzey ${K.esc(version)} is ready</h2>
          <p class="update-copy" style="margin:0;font-size:0.8125rem;line-height:1.45">Update in a tap. Your settings and presences stay as they are.</p>
        </div>
      </div>
      <div class="update-kicker" style="margin-top:15px"><span class="badge">${K.icon('download', 'sm')} Web build</span><span class="badge beta">Beta</span><span class="badge">${K.icon('shield-check', 'sm')} Token stays local</span></div>
      <div class="update-actions" style="margin-top:10px">
        <button class="btn btn-primary btn-sm" data-action="open-update">Update</button>
        <button class="btn btn-quiet btn-sm" data-route="changelog">What's new</button>
      </div>
      <button class="installer" style="border:0;background:none;font-size:0.75rem;color:#d9c5e9;padding:14px 0 0" data-action="install-app">${K.icon('download', 'sm')} Install web app</button>
    </article>`;
  }

  function recentChips() {
    const recent = (K.get('recent', []) || []).filter(kind => K.presenceKinds[kind]);
    if (!recent.length) return `<span class="chip" data-route="custom">${K.icon('sparkles', 'sm')}Try your first card</span>`;
    return recent.slice(0, 6).map(kind => {
      const meta = K.presenceKinds[kind];
      return `<button class="chip" data-route="${K.esc(K.routeForKind(kind))}">${K.icon(meta.icon, 'sm')}${K.esc(meta.label)}</button>`;
    }).join('');
  }

  function featureTile(kind) {
    const meta = K.presenceKinds[kind];
    const running = K.isRunning(kind);
    const layout = K.get('settings.homeLayout', 'grid');
    return `<button class="feature-tile ${running ? 'running' : ''} ${layout === 'list' ? 'list' : ''}" data-route="${K.routeForKind(kind)}" style="--tile-fg:${meta.color};--tile-bg:${meta.color}1f;--tile-glow:${meta.color}2b">
      <div class="feature-icon">${K.icon(meta.icon)}</div>
      <div class="feature-body">
        <div class="feature-name">${K.esc(meta.label)}</div>
        <div class="feature-desc">${K.esc(meta.desc)}</div>
      </div>
      <div class="feature-status">${running ? `<span class="dot" style="width:5px;height:5px"></span>Live` : `<span class="dot off" style="width:5px;height:5px"></span>Ready`}</div>
    </button>`;
  }

  function homeStats() {
    const usage = K.get('usage', {}) || {};
    const total = Object.values(usage).reduce((sum, n) => sum + (Number(n) || 0), 0);
    const history = K.get('history', []) || [];
    const seconds = history.reduce((sum, h) => sum + (Number(h.seconds) || 0), 0);
    const liveTime = K.currentPresence() ? K.duration(Date.now() - K.currentPresence().startedAt) : (seconds ? K.duration(seconds * 1000) : '0m');
    const wallet = K.get('wallet.kcoin', 250);
    return `<div class="stats-strip">
      <div class="stat-mini"><b>${K.esc(liveTime)}</b><span>${K.currentPresence() ? 'This session' : 'Total live time'}</span></div>
      <div class="stat-mini"><b>${total}</b><span>Presences started</span></div>
      <div class="stat-mini"><b>${wallet}</b><span>KCoin</span></div>
    </div>`;
  }

  function homeChatPeek() {
    const messages = K.get('chat.messages.lounge', []) || [];
    const latest = messages[messages.length - 1];
    const count = K.get('chat.rooms', []).reduce((sum, r) => sum + (r.members || 0), 0);
    if (!latest) return '';
    if (!K.get('settings.showChatPreview', true)) {
      return `<button class="card clickable" data-route="chat" style="width:100%;text-align:left;margin-top:12px">
        <div class="chat-peek"><span class="list-icon" style="font-size:1.1875rem">${K.icon('message-circle')}</span><div class="msg"><b>Kizzey Chat</b><p>Open the room to see what the server is saying.</p></div><span class="pill">${count} members</span></div>
      </button>`;
    }
    return `<button class="card clickable" data-route="chat" style="width:100%;text-align:left;margin-top:12px">
      <div class="chat-peek">
        ${K.avatar({ name: latest.author, url: latest.avatar, cls: 'tiny' })}
        <div class="msg"><b>${K.esc(latest.author)}</b><p>${K.esc(latest.text)}</p></div>
        <span class="pill">${K.icon('message-circle', 'sm')} ${count}</span>
      </div>
    </button>`;
  }

  const HOME_SECTION_DEFS = [
    { id: 'updates', title: 'Update rail', desc: 'Release banner and install shortcut', icon: 'download' },
    { id: 'live', title: 'Live presence', desc: 'The running card and its controls', icon: 'activity' },
    { id: 'quick', title: 'Quick actions', desc: 'Update, controls, stop and arrange', icon: 'zap' },
    { id: 'recent', title: 'Recently used', desc: 'Shortcuts to recent RPC types', icon: 'history' },
    { id: 'features', title: 'Presence features', desc: 'All automatic, manual and account tools', icon: 'layout-grid' },
    { id: 'stats', title: 'Your stage', desc: 'Usage, time live and KCoin', icon: 'bar-chart' },
    { id: 'chat', title: 'Kizzey Network', desc: 'Chat preview and community links', icon: 'message-circle' },
    { id: 'about', title: 'Version footer', desc: 'A small build card', icon: 'info' },
  ];
  const DEFAULT_HOME_ORDER = HOME_SECTION_DEFS.map(sec => sec.id);
  function homeSectionOrder() {
    const valid = new Set(DEFAULT_HOME_ORDER);
    const saved = (K.get('settings.homeOrder', []) || []).filter(id => valid.has(id));
    return [...new Set(saved), ...DEFAULT_HOME_ORDER.filter(id => !saved.includes(id))];
  }

  K.screens.home = {
    title: 'Home',
    render() {
      const s = K.discordStatus();
      const account = K.account();
      const hidden = K.get('settings.hiddenHome', []) || [];
      const show = key => !hidden.includes(key);
      const layout = K.get('settings.homeLayout', 'grid');
      const sectionBody = id => {
        if (id === 'updates') return show('updates') && K.get('settings.showUpdateRail', true) ? `<div id="update-rail">${homeUpdateCard()}</div>` : '';
        if (id === 'live') return show('live') ? `<div id="home-live">${K.presenceCard()}</div>` : '';
        if (id === 'quick') return show('quick') ? `
          <div class="quick-label"><span>Quick Actions</span><button data-route="quick" style="border:0;background:none;color:var(--muted);font-size:0.6875rem">Customize</button></div>
          <div class="quick-grid">
            <button class="quick-action" data-action="refresh-rpc"><span class="quick-icon">${K.icon('refresh')}</span><span>Update RPC</span></button>
            <button class="quick-action" data-action="quick-controls"><span class="quick-icon">${K.icon('sliders')}</span><span>Quick Controls</span></button>
            <button class="quick-action danger" data-action="stop-all"><span class="quick-icon">${K.icon('stop')}</span><span>Stop all</span></button>
            <button class="quick-action" data-action="arrange-home"><span class="quick-icon">${K.icon('layout-grid')}</span><span>Arrange Home</span></button>
          </div>` : '';
        if (id === 'recent') return show('recent') ? `<div class="quick-label"><span>Recently used</span><button data-route="gallery" style="border:0;background:none;color:var(--primary);font-size:0.6875rem">Gallery</button></div>
          <div class="chip-row" id="home-recent">${recentChips()}</div>` : '';
        if (id === 'features') return show('features') ? featureSections.map(section => {
          const kinds = section.kinds.filter(k => !(hidden.includes('feature:' + k)));
          if (!kinds.length) return '';
          return `<div class="quick-label"><span>${section.title}</span><span style="text-transform:none;letter-spacing:0;font-size:0.65625rem;color:var(--faint);font-weight:500">${section.desc}</span></div>
            <div class="feature-grid ${layout === 'list' || Number(K.get('settings.homeColumns', 2)) === 1 ? 'cols-1' : ''}">${kinds.map(featureTile).join('')}</div>`;
        }).join('') : '';
        if (id === 'stats') return show('stats') ? `<div class="quick-label"><span>Your stage</span><button data-route="usage" style="border:0;background:none;color:var(--primary);font-size:0.6875rem">Usage</button></div>${homeStats()}` : '';
        if (id === 'chat') return show('chat') ? `<div class="quick-label"><span>Kizzey Network</span><button data-route="chat" style="border:0;background:none;color:var(--primary);font-size:0.6875rem">Open</button></div>${homeChatPeek()}` : '';
        if (id === 'about') return show('about') ? `<div class="card soft" style="margin-top:14px;padding:15px">
          <div class="card-row between">
            <div class="card-row"><img src="/icon.png" style="width:33px;height:33px;border-radius:11px" alt=""><div><div class="card-title" style="font-size:0.78125rem">Kizzey Web ${K.esc(K.get('version', ''))}</div><div class="card-sub" style="font-size:0.65625rem">A Kizzy fork, rebuilt for the browser</div></div></div>
            <button class="icon-btn small" data-route="about">${K.icon('chevron-right', 'sm')}</button>
          </div>
        </div>` : '';
        return '';
      };
      return `<div class="page home-page">
        <header class="topbar">
          <div class="topbar-left">
            <button class="icon-btn" data-action="open-drawer" aria-label="Open menu">${K.icon('menu')}</button>
          </div>
          <div class="topbar-right">
            <button class="icon-btn" data-action="power-sheet" title="Keep alive and server status" aria-label="Power and keep alive">${K.icon('battery-plus')}</button>
            <button class="icon-btn primary" data-action="network-sheet" title="Kizzey Network" aria-label="Kizzey Network">${K.icon('sparkles')}</button>
            <button class="avatar" id="home-avatar" data-action="open-drawer" aria-label="Profile">${account?.avatarUrl ? `<img src="${K.esc(account.avatarUrl)}" alt="${K.esc(account.displayName)}">` : K.esc(K.initials(K.displayName()))}</button>
          </div>
        </header>
        <h1 class="greeting" id="home-greeting">${K.esc(K.greeting())}</h1>
        <div class="home-sub" id="home-gateway-note"><span class="dot ${s.color === 'good' ? '' : s.color === 'warn' ? 'warn' : 'off'}"></span>${K.esc(s.text)}</div>
        ${homeSectionOrder().map(sectionBody).join('')}
      </div>`;
    },
    mount() { K.afterModelChange = null; },
  };

  // ---------------------------------------------------------------------
  // sheet actions
  // ---------------------------------------------------------------------
  K.actions['arrange-home'] = () => {
    const hidden = K.get('settings.hiddenHome', []) || [];
    const order = homeSectionOrder();
    const defs = Object.fromEntries(HOME_SECTION_DEFS.map(sec => [sec.id, sec]));
    const rows = () => order.map(id => {
      const sec = defs[id];
      return `<div class="setting-row" data-arrange-id="${sec.id}" style="min-height:54px">
        <div class="setting-icon">${K.icon(sec.icon, 'sm')}</div>
        <div class="setting-body"><div class="setting-title">${sec.title}</div><div class="setting-desc">${sec.desc}</div></div>
        <div class="arrange-controls">
          <button class="icon-btn small" data-arrange-move="up" aria-label="Move ${sec.title} up">${K.icon('chevron-up', 'sm')}</button>
          <button class="icon-btn small" data-arrange-move="down" aria-label="Move ${sec.title} down">${K.icon('chevron-down', 'sm')}</button>
          ${K.switch('dummy', !hidden.includes(sec.id), { attrs: `data-local="arrange" data-arrange-toggle="${sec.id}"` })}
        </div>
      </div>`;
    }).join('');
    const list = K.get('settings.homeLayout', 'grid');
    const columns = Number(K.get('settings.homeColumns', 2));
    const body = `<div class="setting-group" style="padding:13px">
      <div class="setting-row" style="border-bottom:0">
        <div class="setting-body"><div class="setting-title">Home layout</div><div class="setting-desc">Tiles or a compact list</div></div>
      </div>
      ${K.segmented('settings.homeLayout', list, [{ value: 'grid', label: 'Tiles' }, { value: 'list', label: 'List' }], { primary: true })}
      <div class="toggle-pair" style="padding:15px 0 2px"><span style="font-size:0.75rem;color:var(--text-dim)">Tiles per row</span><span style="font-size:0.75rem;color:var(--primary)">${columns}</span></div>
      ${K.segmented('settings.homeColumns', columns, [{ value: 1, label: '1' }, { value: 2, label: '2' }])}
    </div>
    <div class="setting-group-title">Sections</div>
    <div class="setting-group" style="padding:0 16px">${rows()}</div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-action="reset-home-arrange">Reset</button>
      <button class="btn btn-primary" data-action="save-home-arrange">Done</button>
    </div>`;
    K.sheet({ title: 'Arrange Home', subtitle: 'Move sections, hide what you do not need, then tap Done.', body });
    const refreshMoveButtons = () => {
      const listEls = [...document.querySelectorAll('[data-arrange-id]')];
      listEls.forEach((row, index) => {
        row.querySelector('[data-arrange-move="up"]').disabled = index === 0;
        row.querySelector('[data-arrange-move="down"]').disabled = index === listEls.length - 1;
      });
    };
    document.querySelectorAll('[data-arrange-move]').forEach(btn => btn.addEventListener('click', () => {
      const row = btn.closest('[data-arrange-id]');
      if (!row) return;
      if (btn.dataset.arrangeMove === 'up' && row.previousElementSibling) {
        row.parentNode.insertBefore(row, row.previousElementSibling);
      } else if (btn.dataset.arrangeMove === 'down' && row.nextElementSibling) {
        row.parentNode.insertBefore(row.nextElementSibling, row);
      }
      refreshMoveButtons();
    }));
    refreshMoveButtons();
  };

  K.actions['save-home-arrange'] = async () => {
    const hidden = new Set(K.get('settings.hiddenHome', []) || []);
    document.querySelectorAll('[data-arrange-toggle]').forEach(input => {
      const id = input.dataset.arrangeToggle;
      if (input.checked) hidden.delete(id);
      else hidden.add(id);
    });
    const order = [...document.querySelectorAll('[data-arrange-id]')].map(row => row.dataset.arrangeId);
    K.setLocal('settings.hiddenHome', [...hidden]);
    K.setLocal('settings.homeOrder', order);
    await K.queuePatch({ settings: { hiddenHome: [...hidden], homeOrder: order } }, 0);
    K.closeSheet();
    K.toast('Home arranged', 'Your layout is saved.', 'ok');
    K.render();
  };

  K.actions['reset-home-arrange'] = () => {
    K.setLocal('settings.hiddenHome', []);
    K.setLocal('settings.homeOrder', [...DEFAULT_HOME_ORDER]);
    K.queuePatch({ settings: { hiddenHome: [], homeOrder: [...DEFAULT_HOME_ORDER] } }, 0);
    K.closeSheet();
    K.toast('Home reset', 'Every section is visible again.', 'ok');
    K.render();
  };

  K.actions['quick-controls'] = () => {
    const qc = K.get('quickControls', {}) || {};
    const status = K.get('settings.rpcStatus', 'online');
    const p = K.currentPresence();
    const body = `<div class="quick-sheet-status">
      <div class="qs-icon">${p ? K.icon(K.presenceKinds[p.kind]?.icon || 'activity') : K.icon('sparkles')}</div>
      <div style="flex:1;min-width:0"><div class="qs-title">${p ? K.esc(p.title) : 'No presence running'}</div><div class="qs-sub">${p ? K.esc(p.subtitle || K.presenceKinds[p.kind]?.label) : 'Start something small, right here.'}</div></div>
      ${p ? `<span class="badge good">Live</span>` : ''}
    </div>
    <div class="field"><label>Presence status</label>${K.segmented('quick-status', status, [{ value: 'online', label: 'Online' }, { value: 'idle', label: 'Idle' }, { value: 'dnd', label: 'DND' }, { value: 'invisible', label: 'Hidden' }])}</div>
    <div class="field"><label>Activity</label>${K.select('', { path: 'quickControls.type', value: qc.type ?? '0', options: [{ value: '0', label: 'Playing' }, { value: '1', label: 'Streaming' }, { value: '2', label: 'Listening' }, { value: '3', label: 'Watching' }, { value: '5', label: 'Competing' }] })}</div>
    ${K.field({ label: 'Name', path: 'quickControls.name', value: qc.name, placeholder: 'What are you doing?' })}
    <div class="two-col">${K.field({ label: 'Details', path: 'quickControls.details', value: qc.details, placeholder: 'A little more' })}${K.field({ label: 'State', path: 'quickControls.state', value: qc.state, placeholder: 'Optional' })}</div>
    <div class="quick-grid-2">
      <button class="btn btn-primary" data-action="quick-start">${K.icon('play', 'sm')}Start quick RPC</button>
      <button class="btn btn-ghost" data-action="stop-all">${K.icon('stop', 'sm')}Stop all</button>
    </div>
    <div class="quick-grid-2 mt-8">
      <button class="btn btn-ghost" data-route="custom">${K.icon('edit', 'sm')}Full editor</button>
      <button class="btn btn-ghost" data-route="quick">${K.icon('sliders', 'sm')}Quick settings</button>
    </div>
    ${!K.isSignedIn() ? `<div class="field-hint mt-12" style="text-align:center"><button class="btn btn-ghost btn-sm" data-action="retry-login">Sign in with Discord first</button></div>` : ''}`;
    K.sheet({ title: 'Quick Controls', subtitle: 'Your presence, without leaving home.', body });
    document.querySelectorAll('[data-segment="quick-status"] button').forEach(btn => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.value;
        K.setLocal('settings.rpcStatus', value);
        K.queuePatch({ settings: { rpcStatus: value } }, 0);
        document.querySelectorAll('[data-segment="quick-status"] button').forEach(b => b.classList.toggle('active', b === btn));
      });
    });
  };

  K.actions['quick-start'] = async () => {
    const qc = K.get('quickControls', {});
    if (!qc.name) { K.toast('Name required', 'Give your activity a name first.', 'error'); return; }
    if (!K.ensureLogin()) return;
    await K.flush();
    try {
      const data = await K.api('/api/rpc/start', {
        method: 'POST',
        body: {
          kind: 'custom',
          custom: {
            name: qc.name,
            details: qc.details || '',
            state: qc.state || '',
            type: String(qc.type ?? '0'),
            status: K.get('settings.rpcStatus', 'online'),
          },
        },
      });
      if (data.state) K.receiveState(data.state);
      K.closeSheet();
      K.toast('Quick RPC started', qc.name, 'ok');
      K.render();
    } catch (error) { K.toast('Could not start RPC', error.message, 'error'); }
  };

  K.actions['power-sheet'] = async () => {
    const status = K.discordStatus();
    const stats = await K.api('/api/hoststats').then(d => d.stats).catch(() => null);
    const device = stats?.device || K.get('host', {});
    const body = `<div class="quick-sheet-status">
      <div class="qs-icon">${K.icon(status.color === 'good' ? 'battery-charging' : 'battery')}</div>
      <div style="flex:1"><div class="qs-title">${K.esc(status.text)}</div><div class="qs-sub">${K.isSignedIn() ? `Signed in as ${K.esc(K.displayName())}` : 'Connect Discord to send presence'}</div></div>
      ${K.switch('settings.keepAlive', K.get('settings.keepAlive', true))}
    </div>
    <div class="setting-group" style="padding:0 14px">
      ${K.toggleRow({ title: 'Keep gateway alive', desc: 'Retry the Discord socket while the server process is running', path: 'settings.keepAlive', checked: K.get('settings.keepAlive', true), icon: 'battery-plus' })}
      ${K.toggleRow({ title: 'Notifications', desc: 'Show browser notifications for new chat messages', path: 'settings.notifications', checked: K.get('settings.notifications', true), icon: 'bell' })}
      ${K.toggleRow({ title: 'Analytics', desc: 'Native analytics preference; this build has no analytics endpoint and sends nothing', path: 'settings.analytics', checked: K.get('settings.analytics', false), icon: 'bar-chart' })}
    </div>
    <div class="card soft mt-12">
      <div class="card-row between"><span class="small muted">Host</span><span class="small">${K.esc(device.model || 'Kizzey Web')}</span></div>
      <div class="card-row between mt-8"><span class="small muted">Battery</span><span class="small">${stats?.battery != null ? stats.battery + '%' + (stats.charging ? ' · charging' : '') : 'unknown'}</span></div>
      <div class="card-row between mt-8"><span class="small muted">Gateway latency</span><span class="small">${K.get('gateway.latency') != null ? K.get('gateway.latency') + ' ms' : '—'}</span></div>
      <div class="card-row between mt-8"><span class="small muted">Server sessions</span><span class="small">${stats?.sessions ?? '—'}</span></div>
    </div>
    <div class="modal-actions"><button class="btn btn-ghost" data-route="shizuku">${K.icon('activity', 'sm')}Host tools</button><button class="btn btn-primary" data-route="rpc-settings">RPC settings</button></div>`;
    K.sheet({ title: 'Power & connection', subtitle: 'The quiet machinery behind your card.', body });
  };

  K.actions['network-sheet'] = () => {
    const stats = {
      members: K.get('chat.rooms', []).reduce((sum, r) => sum + (r.members || 0), 0),
      moments: K.get('chat.moments', []).length,
      coins: K.get('wallet.kcoin', 250),
    };
    const body = `<div class="promo-card" style="margin-bottom:14px">
      <div class="promo-glow"></div>
      <span class="plan-badge">KIZZEY NETWORK</span>
      <h2 style="font-size:1.5625rem;letter-spacing:-.04em;margin:14px 0 6px">A little corner<br>of the internet.</h2>
      <p style="font-size:0.75rem;color:var(--muted);line-height:1.5;margin:0 0 16px">Chat, moments, presets and a leaderboard — all served from your own Kizzey.</p>
      <div class="stats-strip" style="margin:0">
        <div class="stat-mini"><b>${stats.members}</b><span>Members</span></div>
        <div class="stat-mini"><b>${stats.moments}</b><span>Moments</span></div>
        <div class="stat-mini"><b>${stats.coins}</b><span>KCoin</span></div>
      </div>
    </div>
    <div class="quick-grid-2">
      <button class="btn btn-primary" data-route="chat">${K.icon('message-circle', 'sm')}Open chat</button>
      <button class="btn btn-ghost" data-route="moments">${K.icon('sparkles', 'sm')}Moments</button>
      <button class="btn btn-ghost" data-route="gallery">${K.icon('images', 'sm')}Preset gallery</button>
      <button class="btn btn-ghost" data-route="leaderboard">${K.icon('trophy', 'sm')}Leaderboard</button>
    </div>`;
    K.sheet({ title: 'Kizzey Network', subtitle: 'Community, without a different app.', body });
  };

  // ---------------------------------------------------------------------
  // drawer
  // ---------------------------------------------------------------------
  const menu = [
    {
      label: 'Kizzey',
      items: [
        { route: 'home', icon: 'home', title: 'Home', sub: 'Your stage, at a glance' },
        { route: 'profile', icon: 'user', title: 'Your profile', sub: 'How you appear to the community' },
        { route: 'accounts', icon: 'users', title: 'Discord accounts', sub: 'Switch saved identities on this server' },
        { route: 'mirror', icon: 'repeat', title: 'Message mirror', sub: 'Forward new messages between channels' },
        { route: 'chat', icon: 'message-circle', title: 'Kizzey Chat', sub: 'Talk with the community', badge: 'LIVE', badgeClass: 'good' },
        { route: 'moments', icon: 'sparkles', title: 'Moments', sub: 'Small updates, shared' },
        { route: 'leaderboard', icon: 'trophy', title: 'Leaderboard', sub: 'Top members and supporters' },
        { route: 'gallery', icon: 'images', title: 'Preset Gallery', sub: 'Browse and share presets' },
        { route: 'trending', icon: 'trending-up', title: 'Trending', sub: 'Hot presets, posts and streaks' },
        { route: 'presences', icon: 'users', title: 'Discord Presences', sub: 'See what your friends are playing', badge: 'BETA', badgeClass: 'beta' },
      ],
    },
    {
      label: 'Rich Presence',
      items: [
        { route: 'custom', icon: 'sparkles', title: 'Custom RPC', sub: 'Design and cycle your own presence', dot: 'custom' },
        { route: 'apps', icon: 'layout-grid', title: 'App Detection', sub: 'Show the app you are using', dot: 'apps' },
        { route: 'media', icon: 'music', title: 'Media RPC', sub: 'Show what you are listening to', dot: 'media' },
        { route: 'console', icon: 'gamepad', title: 'Console RPC', sub: 'PlayStation, Xbox and Switch', dot: 'console' },
        { route: 'experimental', icon: 'wand-sparkles', title: 'Experimental RPC', sub: 'Switch between apps and media', dot: 'experimental' },
        { route: 'cycling', icon: 'refresh', title: 'RPC Cycling', sub: 'Several activity types at once', dot: 'cycling' },
        { route: 'multiple', icon: 'layers', title: 'Multiple RPC', sub: 'Run more than one source', dot: 'multiple' },
        { route: 'screen-read', icon: 'scan', title: 'Screen Read', sub: 'Turn the screen into a presence', badge: 'OCR', badgeClass: 'plain' },
      ],
    },
    {
      label: 'Account tools',
      items: [
        { route: 'health', icon: 'heart-pulse', title: 'Health', sub: 'Steps and heart rate on RPC', dot: 'health' },
        { route: 'location', icon: 'map-pin', title: 'Location', sub: 'Keep your place on your card', dot: 'location' },
        { route: 'weather', icon: 'cloud-sun', title: 'Weather', sub: 'Live conditions for RPC', dot: 'weather' },
        { route: 'navigation', icon: 'navigation', title: 'Navigation', sub: 'Directions from Maps on RPC', dot: 'navigation' },
        { route: 'android-auto', icon: 'car', title: 'Android Auto', sub: 'A driving presence', dot: 'android_auto' },
        { route: 'samsung', icon: 'smartphone', title: 'Samsung RPC', sub: 'Galaxy-only presence', dot: 'samsung' },
        { route: 'emulation', icon: 'disc', title: 'Emulation RPC', sub: 'Retro and emulator sessions', dot: 'emulation' },
        { route: 'automation', icon: 'zap', title: 'Automation', sub: 'Rules for your presence' },
        { route: 'bulk', icon: 'trash', title: 'Bulk message removal', sub: 'Clean up your own messages' },
      ],
    },
    {
      label: 'Tools',
      items: [
        { route: 'quick', icon: 'sliders', title: 'Quick Controls', sub: 'Your presence in a pop-up' },
        { route: 'shizuku', icon: 'shield', title: 'Shizuku Tools', sub: 'Power tools through your host' },
        { route: 'plugins', icon: 'puzzle', title: 'Plugins', sub: 'Audiocord and call links' },
        { route: 'logs', icon: 'bug', title: 'Logs', sub: 'Details for bug reports' },
      ],
    },
    {
      label: 'Settings',
      items: [
        { route: 'settings', icon: 'settings', title: 'Settings', sub: 'All preferences in one place' },
        { route: 'rpc-settings', icon: 'sliders-horizontal', title: 'RPC Settings', sub: 'How your presence behaves' },
        { route: 'display', icon: 'palette', title: 'Display', sub: 'Theme, colours and layout' },
        { route: 'language', icon: 'languages', title: 'Language', sub: 'Change the app language' },
        { route: 'backup', icon: 'database', title: 'Backup & restore', sub: 'Take your settings with you' },
        { route: 'update', icon: 'refresh', title: 'Updates', sub: 'Release notes and checks' },
        { route: 'changelog', icon: 'file-text', title: 'Changelog', sub: 'What changed in each version' },
        { route: 'policies', icon: 'shield-check', title: 'Policies', sub: 'Privacy, terms and licences' },
        { route: 'about', icon: 'info', title: 'About', sub: 'Version, credits and debug' },
      ],
    },
  ];
  K.drawerMenu = menu;

  K.renderDrawer = function renderDrawer() {
    const root = document.getElementById('drawer-root');
    if (!root) return;
    const account = K.account();
    const status = K.discordStatus();
    const drawProfile = account
      ? `<div class="drawer-profile">
          ${K.avatar({ name: account.displayName, url: account.avatarUrl, cls: '' })}
          <div style="flex:1;min-width:0"><div class="dp-name ellipsis">${K.esc(account.displayName)}</div><div class="dp-sub"><span class="dot ${status.color === 'good' ? '' : 'off'}" style="width:5px;height:5px"></span>${K.esc(account.username ? '@' + account.username : 'Discord')}</div></div>
          <button class="icon-btn" data-route="accounts" title="Manage accounts">${K.icon('users', 'sm')}</button>
          <button class="icon-btn" data-action="logout" title="Sign out">${K.icon('logout', 'sm')}</button>
        </div>`
      : `<button class="drawer-profile" data-action="retry-login" style="width:100%;text-align:left;border:1px solid var(--hairline)">
          <span class="avatar fallback">K</span>
          <span style="flex:1;min-width:0"><span class="dp-name" style="display:block">Sign in with Discord</span><span class="dp-sub" style="display:flex"><span class="dot off" style="width:5px;height:5px"></span>Presence needs a token</span></span>
          ${K.icon('chevron-right', 'sm')}
        </button>`;
    const items = menu.map(group => `<div class="drawer-section">
      <div class="drawer-section-label">${group.label}</div>
      ${group.items.map(item => {
        const active = K.current.route === item.route;
        return `<button class="drawer-item ${active ? 'active' : ''}" data-route="${item.route}" data-search-text="${K.esc((item.title + ' ' + item.sub).toLowerCase())}">
          <span class="di-icon">${K.icon(item.icon)}</span>
          <span class="di-body"><span class="di-title">${K.esc(item.title)}${item.badge ? `<span class="badge ${item.badgeClass || 'plain'}">${item.badge}</span>` : ''}</span><span class="di-sub">${K.esc(item.sub)}</span></span>
          ${item.dot && K.isRunning(item.dot) ? '<span class="di-badge"></span>' : ''}
        </button>`;
      }).join('')}
    </div>`).join('');
    root.innerHTML = `<div class="scrim" data-drawer-scrim></div>
      <aside class="drawer" aria-label="Navigation">
        <div class="drawer-head">
          ${drawProfile}
          <div class="drawer-search">${K.icon('search')}<input class="input" id="drawer-search" placeholder="Search Kizzey" autocomplete="off"></div>
        </div>
        <div class="drawer-scroll">${items}
          <div class="drawer-section">
            <div class="drawer-section-label">Support</div>
            <button class="drawer-item" data-route="premium"><span class="di-icon">${K.icon('crown')}</span><span class="di-body"><span class="di-title">Kizzey+ <span class="badge plain">DEMO</span></span><span class="di-sub">Support the build, unlock cosmetics</span></span></button>
            <button class="drawer-item" data-route="shop"><span class="di-icon">${K.icon('coins')}</span><span class="di-body"><span class="di-title">KCoin Shop</span><span class="di-sub">${K.get('wallet.kcoin', 250)} KCoin available</span></span></button>
          </div>
        </div>
        <div class="drawer-footer"><span>Kizzey Web <b>${K.esc(K.get('version', ''))}</b></span><span style="display:flex;align-items:center;gap:5px"><span class="dot ${status.color === 'good' ? '' : status.color === 'warn' ? 'warn' : 'off'}"></span>${K.esc(status.text)}</span></div>
      </aside>`;
  };

  function filterDrawer(query) {
    const q = String(query || '').trim().toLowerCase();
    document.querySelectorAll('.drawer-item[data-search-text]').forEach(el => {
      el.classList.toggle('hidden', q && !el.dataset.searchText.includes(q));
    });
    document.querySelectorAll('.drawer-section').forEach(section => {
      const visible = [...section.querySelectorAll('.drawer-item')].some(el => !el.classList.contains('hidden'));
      section.classList.toggle('hidden', !visible);
    });
  }

  K.clearDrawer = function () {
    const root = document.getElementById('drawer-root');
    if (root) root.innerHTML = '';
  };

  // Onboarding is not a route; the welcome state still has route home behind it.
  K.screens.notfound = {
    title: 'Not found',
    render() {
      return `<div class="page">${K.pageHead({ title: 'Not found', sub: 'That Kizzey screen does not exist (yet).' })}
        ${K.empty('map', 'Lost in the network', 'The page you asked for is not part of this build.', K.btn('Go home', { cls: 'btn-primary', route: 'home' }))}</div>`;
    },
  };

  // Start after all screen modules have registered.
  window.addEventListener('hashchange', () => {
    const parsed = parseHash();
    K.current = parsed;
    K.render();
  });

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    K.local.installPrompt = event;
  });

  window.addEventListener('online', () => K.toast('Back online', 'Kizzey will pick up where it left off.', 'ok'));
  window.addEventListener('offline', () => K.toast('You are offline', 'Local features still work; Discord updates are paused.', 'error'));

  K.boot = init;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
