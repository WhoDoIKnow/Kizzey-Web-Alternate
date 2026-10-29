/* Kizzey Web — settings, about, backup, update, policies and diagnostics */
(function () {
  'use strict';
  const K = window.K;
  const h = K.esc;

  const ACCENTS = ['#d0bcff', '#7ee0b8', '#f1b6d0', '#9fd7ff', '#f7c873', '#ff9c9c', '#c4b5fd', '#a8e6cf'];
  const LANGUAGES = [
    { code: 'en', name: 'English', native: 'English', progress: 100 },
    { code: 'pt-BR', name: 'Portuguese (Brazil)', native: 'Português (Brasil)', progress: 94 },
    { code: 'ru', name: 'Russian', native: 'Русский', progress: 94 },
    { code: 'tr', name: 'Turkish', native: 'Türkçe', progress: 95 },
    { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt', progress: 21 },
    { code: 'ar', name: 'Arabic', native: 'العربية', progress: 14 },
    { code: 'de', name: 'German', native: 'Deutsch', progress: 14 },
    { code: 'es', name: 'Spanish', native: 'Español', progress: 14 },
    { code: 'fa', name: 'Persian', native: 'فارسی', progress: 14 },
    { code: 'fil', name: 'Filipino', native: 'Filipino', progress: 14 },
    { code: 'fr', name: 'French', native: 'Français', progress: 14 },
    { code: 'hi', name: 'Hindi', native: 'हिन्दी', progress: 14 },
    { code: 'hr', name: 'Croatian', native: 'Hrvatski', progress: 14 },
    { code: 'in', name: 'Indonesian', native: 'Bahasa Indonesia', progress: 14 },
    { code: 'it', name: 'Italian', native: 'Italiano', progress: 14 },
    { code: 'ja', name: 'Japanese', native: '日本語', progress: 14 },
    { code: 'ko', name: 'Korean', native: '한국어', progress: 14 },
    { code: 'nl', name: 'Dutch', native: 'Nederlands', progress: 14 },
    { code: 'pl', name: 'Polish', native: 'Polski', progress: 14 },
    { code: 'pt', name: 'Portuguese', native: 'Português', progress: 14 },
    { code: 'th', name: 'Thai', native: 'ไทย', progress: 14 },
    { code: 'zh-CN', name: 'Chinese (Simplified)', native: '简体中文', progress: 14 },
    { code: 'zh-TW', name: 'Chinese (Traditional)', native: '繁體中文', progress: 14 },
    { code: 'he', name: 'Hebrew', native: 'עברית', progress: 4 },
    { code: 'my', name: 'Burmese', native: 'မြန်မာ', progress: 4 },
  ];

  function page(title, sub, body, actions = '') {
    return `<div class="page">${K.pageHead({ title, sub, actions })}${body}<div style="height:20px"></div></div>`;
  }

  function group(title, inner) {
    return K.settingGroup(title, inner);
  }

  function toggle(title, desc, path, icon = '') {
    return K.toggleRow({ title, desc, path, checked: !!K.get(path, false), icon });
  }

  function tappable(title, desc, opts = {}) {
    return K.tappableRow(Object.assign({ title, desc, icon: opts.icon }, opts));
  }

  function infoRow(icon, title, desc, end = '') {
    return `<div class="setting-row"><div class="setting-icon">${K.icon(icon)}</div><div class="setting-body"><div class="setting-title">${title}</div><div class="setting-desc">${desc}</div></div>${end}</div>`;
  }

  function fmtBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return (bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + units[i];
  }

  // ---------------------------------------------------------------------
  // settings hub
  // ---------------------------------------------------------------------
  K.screens.settings = {
    title: 'Settings',
    render() {
      const account = K.get('account');
      const status = K.discordStatus();
      const settings = K.get('settings', {});
      const accounts = K.get('accounts', []);
      const mirror = K.get('mirror', {});
      const mirrorRules = Array.isArray(mirror?.rules) ? mirror.rules : [];
      const enabledRules = mirrorRules.filter(rule => rule?.enabled).length;
      const discordGroup = K.settingGroup('Discord', [
        tappable('Discord accounts', accounts.length ? `${accounts.length} saved · ${account ? h(account.displayName) : 'no active account'}` : 'Add a token and switch identities safely', { route: 'accounts', icon: 'users' }),
        tappable('Discord login', 'Email and password, straight to Discord — or paste a token', { action: 'account-add', icon: 'shield-check' }),
        tappable('Message mirror', mirrorRules.length ? `${enabledRules} of ${mirrorRules.length} relays enabled${mirror.enabled ? '' : ' · auto paused'}` : 'Forward new messages between channels', { route: 'mirror', icon: 'repeat' }),
      ].join(''));
      const pieces = [
        tappable('RPC Settings', 'Connection, status and presence defaults', { route: 'rpc-settings', icon: 'sliders-horizontal' }),
        tappable('Display', 'Theme, accent, motion and home layout', { route: 'display', icon: 'palette' }),
        tappable('Language', 'Choose the language for Kizzey', { route: 'language', icon: 'languages' }),
        tappable('Backup & restore', 'Export or import this server’s state', { route: 'backup', icon: 'database' }),
        tappable('Updates', 'Check Codeberg for a newer release', { route: 'update', icon: 'refresh' }),
        tappable('Changelog', 'What changed in recent builds', { route: 'changelog', icon: 'file-text' }),
        tappable('Policies', 'Privacy, terms and open-source licences', { route: 'policies', icon: 'shield-check' }),
        tappable('Logs', 'Server events for bug reports', { route: 'logs', icon: 'bug' }),
        tappable('About & diagnostics', 'Version, credits and debug tools', { route: 'about', icon: 'info' }),
      ].join('');
      return page('Settings', 'One place for how Kizzey behaves.', `
        <div class="account-hero">
          ${K.avatar({ name: account?.displayName || K.get('chatProfile.name', 'You'), url: account?.avatarUrl || K.get('chatProfile.avatar', ''), cls: '', style: 'width:54px;height:54px;font-size:1.125rem' })}
          <div style="flex:1;min-width:0"><div class="account-name" style="font-size:1.1875rem">${h(account?.displayName || K.get('chatProfile.name', 'You'))}</div><div class="account-handle">${account ? '@' + h(account.username || '') : 'Kizzey Web on this server'}</div><div class="account-meta" style="margin-top:5px"><span class="badge ${status.color === 'good' ? 'good' : 'plain'}">${h(status.text)}</span><span class="pill">${h(settings.theme || 'dark')}</span>${accounts.length ? `<span class="pill">${accounts.length} account${accounts.length === 1 ? '' : 's'}</span>` : ''}</div></div>
          ${account ? `<button class="icon-btn" data-route="accounts" aria-label="Manage accounts">${K.icon('users', 'sm')}</button><button class="icon-btn" data-action="logout" aria-label="Sign out">${K.icon('logout', 'sm')}</button>` : `<button class="btn btn-primary btn-sm" data-action="retry-login">Connect</button>`}
        </div>
        ${discordGroup}
        ${K.settingGroup('General', pieces)}
        ${group('Notifications', toggle('Notifications', 'Ask the browser for permission and show chat updates while the tab is in the background.', 'settings.notifications', 'bell') + toggle('Sound', 'Play a short notification sound with chat notifications.', 'settings.notificationSound', 'volume'))}
        ${group('Connection', toggle('Offline mode', 'Pause update checks, weather/routes and new artwork resolution. The Discord gateway keeps running.', 'settings.offlineMode', 'wifi-off') + toggle('Reconnect notices', 'Show a toast while the server retries the Discord gateway after a drop.', 'settings.reconnect', 'refresh') + tappable('Gateway diagnostics', K.gatewayConnected() ? `Connected · ${K.get('gateway.latency') != null ? K.get('gateway.latency') + ' ms' : 'latency unavailable'}` : status.text, { route: 'logs', icon: 'wifi' }))}
        <div class="quick-grid-2" style="margin-top:14px"><button class="btn btn-ghost" data-route="debug">${K.icon('bug', 'sm')}Debug</button><button class="btn btn-ghost" data-route="credits">${K.icon('heart', 'sm')}Credits</button></div>
        <div class="field-hint" style="padding:16px 5px;text-align:center">Kizzey Web ${h(K.get('version'))} · local server state</div>
      `);
    },
  };

  // ---------------------------------------------------------------------
  // RPC settings
  // ---------------------------------------------------------------------
  K.screens['rpc-settings'] = {
    title: 'RPC Settings',
    render() {
      const s = K.get('settings', {});
      const g = K.get('gateway', {});
      return page('RPC Settings', 'How presence behaves on this server.', '', `<button class="icon-btn" data-action="settings-refresh-presence" aria-label="Refresh presence">${K.icon('refresh')}</button>`) + `
        <div class="card soft" style="margin-bottom:16px">
          <div class="card-row between"><div><div class="metric-label">Discord gateway</div><b style="font-size:1.125rem;display:block;margin-top:4px">${h(K.discordStatus().text)}</b><small>${K.isSignedIn() ? (g.connected ? 'Session live' : 'Token saved, session idle') : 'Connect Discord to run presences'}</small></div><div class="metric-icon" style="width:43px;height:43px;border-radius:14px;background:var(--surface-2);color:${g.connected ? 'var(--good)' : 'var(--muted)'}">${K.icon('wifi')}</div></div>
          <div class="quick-grid-2" style="margin-top:14px"><button class="btn btn-ghost btn-sm" data-action="settings-reconnect-gateway">${K.icon('refresh', 'sm')}Reconnect</button><button class="btn btn-ghost btn-sm" data-action="settings-refresh-account">${K.icon('user', 'sm')}Refresh account</button></div>
        </div>
        ${group('Presence defaults',
          `<div class="setting-row vertical"><div class="setting-icon">${K.icon('circle-dot')}</div><div class="setting-body"><div class="setting-title">Default status</div><div class="setting-desc">Used by media, apps, console and account presences.</div><div class="mt-8">${K.segmented('settings.rpcStatus', s.rpcStatus || 'online', [{ value: 'online', label: 'Online' }, { value: 'idle', label: 'Idle' }, { value: 'dnd', label: 'DND' }, { value: 'invisible', label: 'Hidden' }])}</div></div></div>
          <div class="setting-row vertical">${K.select({ label: 'Default activity type', path: 'settings.defaultType', value: s.defaultType ?? 0, options: [{ value: '0', label: 'Playing' }, { value: '1', label: 'Streaming' }, { value: '2', label: 'Listening' }, { value: '3', label: 'Watching' }, { value: '5', label: 'Competing' }] })}</div>
          ${toggle('Show link buttons', 'Allow presences and templates to carry up to two link buttons.', 'settings.showButtons', 'external-link')}
          ${toggle('Presence history', 'Record a session in history when a presence stops or is replaced.', 'settings.showPresenceHistory', 'history')}`
        )}
        ${group('Home and chat',
          `${toggle('Chat preview on Home', 'Show the latest message in the Home chat card.', 'settings.showChatPreview', 'message-circle')}
           ${toggle('Show update rail', 'Show the release card on Home.', 'settings.showUpdateRail', 'refresh')}`
        )}
        ${group('Startup and background',
          `${toggle('Keep the gateway alive', 'Retry the socket while the server process is running.', 'settings.keepAlive', 'activity')}
           ${toggle('Reconnect notices', 'Show a toast while the server retries the Discord gateway after a drop.', 'settings.reconnect', 'refresh')}
           ${toggle('Close to tray', 'Desktop-app preference; kept in server state for parity.', 'settings.closeToTray', 'monitor')}
           <div class="field-hint" style="padding:10px 16px 16px">Gateways open only for accounts that have a presence running or take part in an enabled mirror rule. Switching accounts never closes a presence that is already running.</div>`
        )}
        ${group('Privacy and diagnostics',
          `${toggle('Local analytics', 'Keep local feature adoption counters; nothing is sent to Kizzey.', 'settings.analytics', 'bar-chart')}
           ${toggle('Offline mode', 'Pause external lookups and new artwork resolution. The Discord gateway remains available.', 'settings.offlineMode', 'wifi-off')}`
        )}
        ${group('Advanced actions',
          `${tappable('Reconnect gateway', 'Drop and reopen the Discord WebSocket.', { action: 'settings-reconnect-gateway', icon: 'wifi' })}
           ${tappable('Refresh running presence', 'Rebuild and resend the current activity.', { action: 'settings-refresh-presence', icon: 'rotate-ccw' })}
           ${tappable('Open logs', 'Inspect gateway and presence events.', { route: 'logs', icon: 'bug' })}`
        )}
        <div class="field-hint" style="padding:14px 5px">Some Android-only preferences (tray behaviour, minimizing, system startup) are kept for parity; a browser cannot control the host operating system from here.</div>
        <div style="height:20px"></div>`;
    },
    onModelChange(path) {
      if (path.startsWith('settings.')) K.applyTheme();
    },
  };

  K.actions['settings-reconnect-gateway'] = async () => {
    if (!K.isSignedIn()) { K.toast('Connect Discord first', '', 'error'); return; }
    try {
      const data = await K.api('/api/gateway/reconnect', { method: 'POST', body: {} });
      if (data.state) K.receiveState(data.state);
      K.toast('Gateway reconnecting', '', 'ok');
      if (K.current.route === 'rpc-settings') K.render();
    } catch (error) { K.toast('Could not reconnect', error.message, 'error'); }
  };

  K.actions['settings-refresh-account'] = async () => {
    if (!K.isSignedIn()) { K.toast('Connect Discord first', '', 'error'); return; }
    try {
      const data = await K.api('/api/account/refresh', { method: 'POST', body: {} });
      if (data.state) K.receiveState(data.state);
      K.toast('Discord account refreshed', K.displayName(), 'ok');
      if (K.current.route === 'rpc-settings' || K.current.route === 'settings' || K.current.route === 'debug') K.render();
    } catch (error) { K.toast('Could not refresh account', error.message, 'error'); }
  };

  K.actions['settings-refresh-presence'] = async () => {
    if (!K.currentPresence()) { K.toast('No presence is running', '', 'error'); return; }
    try {
      const data = await K.api('/api/rpc/refresh', { method: 'POST', body: {} });
      if (data.state) K.receiveState(data.state);
      K.toast('Presence refreshed', '', 'ok');
      K.render();
    } catch (error) { K.toast('Could not refresh presence', error.message, 'error'); }
  };

  // ---------------------------------------------------------------------
  // display
  // ---------------------------------------------------------------------
  K.screens.display = {
    title: 'Display',
    render() {
      const s = K.get('settings', {});
      const current = s.theme || 'dark';
      const themes = [
        { value: 'dark', label: 'Dark', desc: 'Plum surfaces, lavender light', icon: 'moon' },
        { value: 'light', label: 'Light', desc: 'Soft paper and violet ink', icon: 'sun' },
        { value: 'amoled', label: 'AMOLED', desc: 'True black, made for OLED', icon: 'smartphone' },
        { value: 'system', label: 'System', desc: 'Follow the browser preference', icon: 'monitor' },
      ];
      return page('Display', 'Make the app feel like yours.', `
        ${K.settingGroup('Theme', `<div class="theme-grid">${themes.map(theme => `<button class="theme-option ${current === theme.value ? 'active' : ''}" data-action="display-theme" data-theme="${theme.value}">
          <span class="theme-preview ${theme.value}" data-theme-preview="${theme.value}"><span class="tp-bar"></span><span class="tp-card"></span><span class="tp-card short"></span></span>
          <span class="to-name">${theme.label}</span><span class="to-desc">${theme.desc}</span>
        </button>`).join('')}</div>`)}
        ${K.settingGroup('Colour', `<div class="setting-row vertical"><div class="setting-icon">${K.icon('palette')}</div><div class="setting-body"><div class="setting-title">Accent</div><div class="setting-desc">Used for buttons, active states and the greeting glow.</div><div class="accent-grid mt-8">${ACCENTS.map(color => `<button class="color-dot ${String(s.accent || '').toLowerCase() === color.toLowerCase() ? 'active' : ''}" style="background:${color}" data-action="display-accent" data-color="${color}" aria-label="${color}"></button>`).join('')}</div><div class="card-row mt-12" style="gap:8px"><input type="color" id="accent-picker" value="${h(/^#[0-9a-f]{6}$/i.test(s.accent || '') ? s.accent : '#d0bcff')}" style="width:42px;height:36px;border:0;background:transparent;padding:0" aria-label="Custom accent"><button class="btn btn-ghost btn-sm" data-action="display-accent-custom">${K.icon('check', 'sm')}Apply custom colour</button></div></div></div>
          ${toggle('AMOLED black', 'Use pure black instead of the plum background.', 'settings.amoled', 'moon')}
          ${K.toggleRow({ title: 'Dynamic colour', desc: 'Android Material You is unavailable in a browser; this stores the preference for parity.', path: 'settings.dynamicColor', checked: !!s.dynamicColor, icon: 'sparkles' })}
          ${toggle('High contrast', 'Strengthen muted and secondary text.', 'settings.highContrast', 'contrast')}`)}
        ${K.settingGroup('Layout', `
          <div class="setting-row vertical"><div class="setting-icon">${K.icon('layout-grid')}</div><div class="setting-body"><div class="setting-title">Home layout</div><div class="setting-desc">Feature cards can use a grid or a single rail.</div><div class="mt-8">${K.segmented('settings.homeLayout', s.homeLayout || 'grid', [{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }])}</div></div></div>
          <div class="setting-row vertical"><div class="setting-icon">${K.icon('columns')}</div><div class="setting-body"><div class="setting-title">Feature columns</div><div class="setting-desc">How many feature cards sit side by side.</div><div class="mt-8">${K.segmented('settings.homeColumns', s.homeColumns ?? 2, [{ value: '1', label: 'One' }, { value: '2', label: 'Two' }])}</div></div></div>
          ${K.field({ label: 'Greeting', path: 'settings.greeting', value: s.greeting, placeholder: 'Use the time of day', hint: 'Leave empty for a greeting based on the time.' })}
          <div class="quick-grid-2" style="margin:12px 0 4px"><button class="btn btn-ghost btn-sm" data-action="arrange-home">${K.icon('layout-grid', 'sm')}Arrange home</button><button class="btn btn-ghost btn-sm" data-action="display-reset">${K.icon('rotate-ccw', 'sm')}Reset display</button></div>`
        )}
        ${K.settingGroup('Album art theme', `
          ${toggle('Album art background', 'Fill the app with the current RPC art, blurred behind the interface.', 'settings.artBackground', 'images')}
          ${toggle('Accent from album art', 'Use a colour sampled from the current artwork for buttons and highlights.', 'settings.accentFromArt', 'palette')}
          ${K.field({ label: 'Background blur', path: 'settings.artBackgroundBlur', type: 'range', value: s.artBackgroundBlur ?? 24, min: 0, max: 50, step: 1, hint: '0 is sharp; 50 is a soft wash.' })}
          ${K.field({ label: 'Background dim', path: 'settings.artBackgroundDim', type: 'range', value: s.artBackgroundDim ?? 40, min: 0, max: 90, step: 1, hint: 'Keeps cards readable over brighter artwork.' })}
        `)}
        ${K.settingGroup('Motion and type', `
          ${toggle('Reduce motion', 'Disable decorative transitions and animated entrances.', 'settings.reduceMotion', 'activity')}
          ${K.field({ label: 'Text size', path: 'settings.fontScale', type: 'range', value: s.fontScale ?? 1, min: 0.85, max: 1.2, step: 0.05, hint: 'Scales text from 85% to 120%. Spacing stays put so controls never collide.' })}
        `)}
        ${K.settingGroup('Custom theme', `
          <div class="setting-row vertical"><div class="setting-icon">${K.icon('code')}</div><div class="setting-body"><div class="setting-title">CSS variables</div><div class="setting-desc">Advanced: a short block of CSS variables injected after the theme. It is stored only on your server.</div><textarea id="custom-theme-css" class="textarea mt-8" rows="5" spellcheck="false" placeholder="--primary: #d0bcff;&#10;--radius-lg: 28px;">${h(s.customThemeCss || '')}</textarea><div class="card-row mt-8" style="gap:7px"><button class="btn btn-primary btn-sm" data-action="display-save-css">${K.icon('check', 'sm')}Apply CSS</button><button class="btn btn-ghost btn-sm" data-action="display-clear-css">${K.icon('trash', 'sm')}Clear</button></div></div></div>
        `)}
        <div style="height:20px"></div>`);
    },
    onModelChange(path) {
      if (path === 'settings.artBackground' && !K.get('settings.artBackground')) K.lastArtUrl = '';
      if (path.startsWith('settings.')) K.applyTheme();
    },
  };

  K.actions['display-theme'] = async el => {
    const theme = el.dataset.theme || 'dark';
    K.setLocal('settings.theme', theme);
    K.setLocal('settings.amoled', theme === 'amoled');
    await K.queuePatch({ settings: { theme, amoled: theme === 'amoled' } }, 0);
    K.applyTheme();
    K.render();
  };

  K.actions['display-accent'] = async el => {
    const color = el.dataset.color;
    K.setLocal('settings.accent', color);
    K.setLocal('settings.dynamicColor', false);
    await K.queuePatch({ settings: { accent: color, dynamicColor: false } }, 0);
    K.applyTheme();
    K.render();
  };

  K.actions['display-accent-custom'] = async () => {
    const value = document.getElementById('accent-picker')?.value || '#d0bcff';
    K.setLocal('settings.accent', value);
    await K.queuePatch({ settings: { accent: value } }, 0);
    K.applyTheme();
    K.toast('Accent updated', value, 'ok');
    K.render();
  };

  K.actions['display-save-css'] = async () => {
    const css = document.getElementById('custom-theme-css')?.value || '';
    K.setLocal('settings.customThemeCss', css);
    await K.queuePatch({ settings: { customThemeCss: css } }, 0);
    K.applyTheme();
    K.toast(css.trim() ? 'Custom theme applied' : 'Custom theme cleared', '', 'ok');
  };

  K.actions['display-clear-css'] = async () => {
    const box = document.getElementById('custom-theme-css');
    if (box) box.value = '';
    K.setLocal('settings.customThemeCss', '');
    await K.queuePatch({ settings: { customThemeCss: '' } }, 0);
    K.applyTheme();
    K.toast('Custom theme cleared', '', 'ok');
  };

  K.actions['display-reset'] = () => {
    K.confirm({
      title: 'Reset display settings?', subtitle: 'Theme, accent, layout, motion and custom CSS return to defaults.', confirm: 'Reset display', danger: true,
      onConfirm: async () => {
        const display = {
          theme: 'dark', accent: '#d0bcff', amoled: false, dynamicColor: false, highContrast: false,
          homeLayout: 'grid', homeColumns: 2, reduceMotion: false, fontScale: 1, artBackground: false, accentFromArt: false,
          artBackgroundBlur: 24, artBackgroundDim: 40, customThemeCss: '', customThemeName: '',
        };
        Object.entries(display).forEach(([key, value]) => K.setLocal('settings.' + key, value));
        await K.queuePatch({ settings: display }, 0);
        K.applyTheme();
        K.toast('Display reset', '', 'ok');
        K.render();
      },
    });
  };

  // ---------------------------------------------------------------------
  // language
  // ---------------------------------------------------------------------
  K.languageQuery = K.languageQuery || '';

  K.screens.language = {
    title: 'Language',
    render() {
      const selected = K.get('settings.language', 'en');
      const q = K.languageQuery.toLowerCase();
      const rows = LANGUAGES.filter(row => !q || (row.name + ' ' + row.native + ' ' + row.code).toLowerCase().includes(q));
      return page('Language', 'The Android app is translated by the community on Weblate.', `
        <div class="input-wrap">${K.icon('search', 'sm')}<input id="language-search" class="input" data-local="language-search" style="padding-left:38px" placeholder="Search languages"></div>
        <div class="list mt-12">${rows.map(row => `<button class="list-item language-row" data-language-row data-search="${h((row.name + ' ' + row.native + ' ' + row.code).toLowerCase())}" data-action="language-set" data-code="${h(row.code)}">
          <span class="list-icon" style="font-size:0.9375rem;font-weight:700;color:var(--primary)">${h(row.code.split('-')[0].slice(0, 2).toUpperCase())}</span>
          <span class="list-body"><span class="list-title">${h(row.native)}</span><span class="list-desc">${h(row.name)} · ${row.progress}% on Android</span></span>
          <span class="list-end">${row.code === selected ? `<span class="badge good">${K.icon('check', 'sm')}</span>` : `<span class="tiny muted">${row.code}</span>`}</span>
        </button>`).join('')}</div>
        <div class="card soft" style="margin-top:14px"><div class="card-row"><div class="feature-icon" style="width:40px;height:40px;background:var(--surface-2);color:var(--primary)">${K.icon('languages')}</div><div><div class="card-title" style="font-size:0.8125rem">Web translation status</div><div class="card-sub">This companion's interface is currently English. The selected language is stored in settings and applied to the page's language metadata; the native Android translations are not bundled here.</div></div></div></div>
        <div class="quick-grid-2" style="margin-top:14px"><a class="btn btn-ghost" href="https://hosted.weblate.org/projects/kizzey/" target="_blank" rel="noopener">${K.icon('external-link', 'sm')}Weblate</a><button class="btn btn-ghost" data-route="settings">${K.icon('settings', 'sm')}Settings</button></div>
        <div style="height:20px"></div>`);
    },
    mount(root) {
      const input = root.querySelector('#language-search');
      input?.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        root.querySelectorAll('[data-language-row]').forEach(row => row.classList.toggle('hidden', !!q && !row.dataset.search.includes(q)));
      });
    },
  };

  K.actions['language-set'] = async el => {
    const code = el.dataset.code || 'en';
    const lang = LANGUAGES.find(row => row.code === code);
    K.setLocal('settings.language', code);
    document.documentElement.lang = code;
    await K.queuePatch({ settings: { language: code } }, 0);
    K.toast('Language selected', lang?.native || code, 'ok');
    K.render();
  };

  // ---------------------------------------------------------------------
  // about
  // ---------------------------------------------------------------------
  K.screens.about = {
    title: 'About',
    render() {
      const offline = K.get('settings.offlineMode', false);
      const body = `
        <div class="about-logo"><img src="/icon.png" alt="Kizzey"></div>
        <h1 class="about-title">Kizzey</h1>
        <div class="about-version">Web ${h(K.get('version'))} · <span class="badge plain">UNOFFICIAL</span></div>
        <p class="about-copy">A mobile web companion for Kizzey, the Discord Rich Presence client. Every presence, chat message, preset and setting on this page is served by your own Python process. Discord credentials stay on the server.</p>
        <div class="stats-strip" style="margin-bottom:16px">
          <div class="stat-mini"><b>${K.get('savedConfigs', []).length}</b><span>Presets</span></div>
          <div class="stat-mini"><b>${K.get('history', []).length}</b><span>Sessions</span></div>
          <div class="stat-mini"><b>${K.isSignedIn() ? 'Live' : 'Idle'}</b><span>Discord</span></div>
        </div>
        ${K.settingGroup('This install', infoRow('server', 'Server', `${h(K.get('host.device') || 'Web')} · ${h(K.get('host.platform') || '')}`, '<span class="badge good">SERVING</span>') + infoRow('wifi', 'Address', `Open this server from another device at port ${h(location.port || '8420')}.`, `<span class="mono-copy">${h(location.host)}</span>`) + infoRow('database', 'Data folder', 'State, token, history, logs and uploads live beside server.py.', '<span class="badge plain">LOCAL</span>'))}
        ${K.settingGroup('Privacy', K.toggleRow({ title: 'Offline mode', desc: 'Pause external lookups and new artwork resolution. Discord RPC keeps running.', path: 'settings.offlineMode', checked: offline, icon: 'wifi-off' }) + infoRow('shield-check', 'Your Discord token', 'Stored only in data/secret.json. It is never included in the public state or exported backups.', '') + tappable('Policies', 'Privacy, terms and open-source licences', { route: 'policies', icon: 'file-text' }))}
        ${K.settingGroup('Project', tappable('Update check', 'Read the latest Codeberg release', { route: 'update', icon: 'refresh' }) + tappable('Changelog', 'Recent releases and highlights', { route: 'changelog', icon: 'file-text' }) + tappable('Credits', 'Kizzey, Kizzy and the libraries behind this build', { route: 'credits', icon: 'heart' }) + tappable('Debug', 'Runtime details and diagnostics', { route: 'debug', icon: 'bug' }))}
        <div class="quick-grid-2" style="margin-top:14px"><a class="btn btn-ghost" href="https://github.com/WhoDoIKnow/Kizzey-Web-Alternate" target="_blank" rel="noopener">${K.icon('code', 'sm')}Source</a><button class="btn btn-ghost" data-action="about-copy-version">${K.icon('copy', 'sm')}Copy version</button></div>
        <div class="field-hint" style="padding:16px 5px;text-align:center">Kizzey Web-Alternate is an unofficial companion to Kizzey, a Kizzy fork. Not affiliated with Discord Inc. · MIT License</div>
        <div style="height:20px"></div>`;
      return page('About', 'The Kizzey experience for every screen.', body, `<button class="icon-btn" data-action="open-update" aria-label="Updates">${K.icon('download')}</button>`);
    },
  };

  K.actions['about-copy-version'] = () => K.copy(`Kizzey Web ${K.get('version')} · server ${location.origin}`, 'Version copied');

  // ---------------------------------------------------------------------
  // credits
  // ---------------------------------------------------------------------
  K.screens.credits = {
    title: 'Credits',
    render() {
      const rows = [
        { initials: 'UX', name: 'UnpackedX', role: 'Kizzey fork, app and community', url: 'https://codeberg.org/UnpackedX' },
        { initials: '83', name: 'dead8309', role: 'Original Kizzy project', url: 'https://github.com/dead8309/Kizzy' },
        { initials: 'DC', name: 'Discord', role: 'Gateway and Rich Presence platform', url: 'https://discord.com/developers/docs/topics/rich-presence' },
        { initials: 'T', name: 'Tesseract OCR', role: 'On-device screen text recognition', url: 'https://github.com/tesseract-ocr/tesseract' },
        { initials: 'OM', name: 'Open-Meteo', role: 'Weather and geocoding', url: 'https://open-meteo.com/' },
        { initials: 'OS', name: 'OSRM', role: 'Route geometry and travel times', url: 'https://project-osrm.org/' },
        { initials: 'MI', name: 'Lucide', role: 'Icon language used by the web interface', url: 'https://lucide.dev/' },
        { initials: 'PY', name: 'Python', role: 'Standard-library web server and gateway client', url: 'https://www.python.org/' },
      ];
      return page('Credits', 'The work behind this small surface.', `
        <div class="about-logo" style="width:58px;height:58px;border-radius:19px"><img src="/icon-fg.png" alt=""></div>
        <p class="about-copy">Kizzey is built by people who care about small details on a presence card. The web companion follows the Android app's structure and visual language, adapted to browser capabilities.</p>
        <div class="setting-group">${rows.map(row => `<a class="credit-row" href="${row.url}" target="_blank" rel="noopener" style="color:inherit"><span class="credit-avatar">${row.initials}</span><span style="flex:1"><span class="credit-name" style="display:block">${h(row.name)}</span><span class="credit-role">${h(row.role)}</span></span>${K.icon('external-link', 'sm')}</a>`).join('')}</div>
        ${K.settingGroup('Licence', infoRow('shield-check', 'MIT License', 'The Kizzey Web-Alternate source is MIT-licensed. Upstream Kizzey and Kizzy remain GPL-3.0.', '<a class="icon-btn small" href="https://github.com/WhoDoIKnow/Kizzey-Web-Alternate/blob/main/LICENSE" target="_blank" rel="noopener">' + K.icon('external-link', 'sm') + '</a>') + infoRow('heart', 'No affiliation', 'Discord and the Discord logo belong to Discord Inc. Kizzy belongs to its original authors.', ''))}
        <div class="quick-grid-2"><button class="btn btn-ghost" data-route="about">${K.icon('info', 'sm')}About</button><button class="btn btn-ghost" data-route="policies">${K.icon('file-text', 'sm')}Policies</button></div>
        <div style="height:20px"></div>`);
    },
  };

  // ---------------------------------------------------------------------
  // changelog
  // ---------------------------------------------------------------------
  const RELEASES = [
    {
      version: '8.4.4', current: true, title: 'Chat remastered',
      intro: 'Everything from the 8.4.3 betas, with a remastered Kizzey Chat and a long list of presence fixes.',
      added: ['Live now and Who’s active', 'Status notes and presence pills', 'Live lyrics on Discord and in chat', 'Pop-out chat and bubble controls', 'Moments and profile showcases'],
      fixed: ['RPC that was on but never appeared on Discord', 'Presence switch flickering back off', 'Sign-out keeping the old Discord session', 'Reactions resetting through lyrics', 'Small-screen chat room'],
    },
    {
      version: '8.4.3', title: 'Keep the card honest',
      intro: 'Spoofs stayed where they were put, chat became faster, and presences gained more to show.',
      added: ['Presence privacy switches', 'Weather in Kizzey Chat', 'Native BPM tapping', 'Custom theme sheet'],
      fixed: ['Spoof settings leaking between simultaneous presences', 'Spotify spoof identity under Multiple RPC', 'Stale settings on the active card'],
    },
  ];

  K.screens.changelog = {
    title: 'Changelog',
    render() {
      return page('Changelog', 'What changed, newest first.', `
        ${RELEASES.map((release, index) => `<div class="release-log">
          <div class="release-head"><div><span class="badge ${release.current ? 'good' : 'plain'}">${release.current ? 'THIS SERVER' : 'RELEASE'}</span><h2>${h(release.version)}</h2><div class="release-title">${h(release.title)}</div></div><span class="tiny muted">${release.current ? 'current' : index === 1 ? 'stable' : 'previous'}</span></div>
          <p class="release-intro">${h(release.intro)}</p>
          <div class="release-section"><div class="release-label good">Added</div><ul>${release.added.map(item => `<li>${h(item)}</li>`).join('')}</ul></div>
          <div class="release-section"><div class="release-label">Fixed</div><ul>${release.fixed.map(item => `<li>${h(item)}</li>`).join('')}</ul></div>
        </div>`).join('')}
        <div class="card soft"><div class="card-row"><div class="feature-icon" style="width:40px;height:40px;background:var(--surface-2);color:var(--primary)">${K.icon('info')}</div><div><div class="card-title" style="font-size:0.8125rem">Highlights only</div><div class="card-sub">The complete release history lives in CHANGELOG.md in the Kizzey source.</div></div></div></div>
        <div class="quick-grid-2" style="margin-top:14px"><a class="btn btn-ghost" href="https://codeberg.org/UnpackedX/Kizzey/src/branch/main/CHANGELOG.md" target="_blank" rel="noopener">${K.icon('external-link', 'sm')}Full changelog</a><button class="btn btn-ghost" data-route="update">${K.icon('refresh', 'sm')}Check updates</button></div>
        <div style="height:20px"></div>`);
    },
  };

  // ---------------------------------------------------------------------
  // policies
  // ---------------------------------------------------------------------
  K.policyTab = K.policyTab || 'privacy';

  K.screens.policies = {
    title: 'Policies',
    render() {
      const tab = K.policyTab;
      const tabs = [['privacy', 'Privacy'], ['terms', 'Terms'], ['licences', 'Licences']];
      let body = '';
      if (tab === 'privacy') {
        body = `<div class="policy-prose">
          <p>This Kizzey Web companion runs on a Python server controlled by whoever installed it. It is not the Android Kizzey service and does not send data to the Kizzey Network.</p>
          <h3>What is stored</h3>
          <p>Your Discord token is written to <span class="mono-copy">data/secret.json</span> on the server. It is used only to talk to Discord's API and gateway. It is never included in the public state API, exported backups, logs or chat messages. The state file holds presences, settings, chat rooms, moments, history, wallet and community profile.</p>
          <h3>What leaves this server</h3>
          <p>Discord receives your token and presence updates. Codeberg receives update-check requests. Open-Meteo receives weather and place queries. OSRM receives route coordinates. The Kizzy image API receives card artwork, as an external URL or an uploaded image, only when that artwork is resolved for Discord; chat images, avatars and screen captures are not sent to it. Tesseract runs locally. The browser's microphone and screen-share streams stay in the browser; only captured screen images you choose to process are uploaded for OCR.</p>
          <h3>What the browser receives</h3>
          <p>The public state includes your Discord display name, avatar, account id and presence card, but never the token. Chat and moments are visible to anyone who can reach this server on its network. There is no password on the included server; run it on a trusted network.</p>
          <h3>Retention</h3>
          <p>State, history and uploads stay until you delete them from the data folder or use Backup & restore. Logs are capped in memory. The token is removed by signing out. Backups do not include the token.</p>
          <h3>Contact</h3>
          <p>Kizzey's Android privacy policy is maintained by UnpackedX. For this web build, contact the person operating the server.</p>
        </div>`;
      } else if (tab === 'terms') {
        body = `<div class="policy-prose">
          <p>Kizzey Web is an unofficial companion built for the operator's own use. It is not endorsed by Discord Inc. or by the original Kizzy project.</p>
          <h3>Your account</h3>
          <p>You are responsible for the Discord token supplied to the server and for any presence, message, reaction or bulk-deletion action taken with it. Self-bot automation may violate Discord's terms. Understand that before connecting an account.</p>
          <h3>No warranty</h3>
          <p>The software is provided as-is under the MIT License, without warranty. Presence delivery depends on Discord, gateway behaviour and network availability. The browser cannot reproduce every Android capability.</p>
          <h3>Payments and cosmetics</h3>
          <p>KCoin and Kizzey+ are local demo state. No payment is taken and nothing is sold. Do not enter real payment credentials anywhere in this web build.</p>
          <h3>Acceptable use</h3>
          <p>Do not expose this server to the public internet without adding authentication and transport security. Do not use it to harass people, evade moderation or process images you have no right to read.</p>
        </div>`;
      } else {
        body = `<div class="policy-prose">
          <p>The Kizzey Web-Alternate implementation is licensed under the MIT License. Kizzey and Kizzy remain under the GNU General Public License, version 3; their names, icons and upstream source are not relicensed by this project.</p>
          <h3>Components</h3>
          <ul>
            <li>Kizzey Web-Alternate — MIT License.</li>
            <li>Kizzey fork — UnpackedX, GPL-3.0.</li>
            <li>Kizzy — dead8309 and contributors, GPL-3.0.</li>
            <li>Tesseract OCR — Apache License 2.0.</li>
            <li>Open-Meteo and OSRM data services — their respective terms.</li>
            <li>Lucide icon geometry — ISC License, rendered inline as SVG.</li>
            <li>Python standard library — PSF License.</li>
          </ul>
          <p>Discord is a trademark of Discord Inc. This project is not affiliated with Discord.</p>
        </div>`;
      }
      return page('Policies', 'The small print, without a wall of text.', `
        <div class="segmented" style="margin-bottom:16px">${tabs.map(([value, label]) => `<button class="${tab === value ? 'active' : ''}" data-action="policy-tab" data-tab="${value}">${label}</button>`).join('')}</div>
        ${body}
        <div class="quick-grid-2" style="margin-top:16px"><a class="btn btn-ghost" href="https://codeberg.org/UnpackedX/Kizzey" target="_blank" rel="noopener">${K.icon('code', 'sm')}Project source</a><button class="btn btn-ghost" data-route="about">${K.icon('info', 'sm')}About</button></div>
        <div class="field-hint" style="padding:16px 5px">Last updated for Kizzey ${h(K.get('version'))} · web policy written for this deployment.</div>
        <div style="height:20px"></div>`);
    },
  };

  K.actions['policy-tab'] = el => { K.policyTab = el.dataset.tab || 'privacy'; K.render(); };

  // ---------------------------------------------------------------------
  // backup & restore
  // ---------------------------------------------------------------------
  K.screens.backup = {
    title: 'Backup & restore',
    render() {
      const state = K.state || {};
      let bytes = 0;
      try { bytes = new Blob([JSON.stringify(state)]).size; } catch {}
      return page('Backup & restore', 'Take your settings with you.', `
        ${K.settingGroup('Export', infoRow('download', 'Download a backup', 'All client state, presets, chat profile, gallery, history and wallet. Discord tokens and server logs are excluded.', `<a class="btn btn-primary btn-sm" href="/api/export" download>${K.icon('download', 'sm')}Export</a>`) + infoRow('database', 'Current state', `${fmtBytes(bytes)} · ${(state.savedConfigs || []).length} presets · ${(state.history || []).length} sessions`, ''))}
        ${K.settingGroup('Restore', infoRow('upload', 'Import a backup or config', 'Kizzey Web backup, Kizzey settings backup, Kizzey preset pack or a stand-alone Custom RPC config JSON. The Discord token is never imported.', `<button class="btn btn-ghost btn-sm" data-action="backup-import">${K.icon('upload', 'sm')}Choose file</button>`) + infoRow('smartphone', 'From the Android app', 'Reads Kizzey-settings-*.json, Kizzey-presets-*.json and Save config files. Account and token fields, APK-private data and Android-only switches stay behind.', '<span class="badge plain">KIZZEY</span>') + infoRow('shield', 'Protected fields', 'Account, gateway, token, live presence, logs and server history are not replaced by an import.', '<span class="badge plain">SAFE</span>'))}
        <div class="danger-zone">
          <div class="dz-title">Before restoring</div>
          <p>A Kizzey Web backup can replace settings, presets and chat profile. For Android files, titled cards replace a local card with the same title; untitled presets are appended. Take a fresh export first; unsupported files are rejected before settings or presets change.</p>
          <div class="card-row" style="gap:8px"><a class="btn btn-ghost btn-sm" href="/api/export" download>${K.icon('download', 'sm')}Export now</a><button class="btn btn-ghost btn-sm" data-action="backup-import">${K.icon('upload', 'sm')}Restore</button></div>
        </div>
        ${K.settingGroup('Private data', infoRow('key', 'Discord token', 'Lives separately in data/secret.json. Never exported. Sign out from Settings to erase it.', `<button class="btn btn-ghost btn-sm" data-route="settings">Settings</button>`) + infoRow('image', 'Uploaded images', 'Stored under data/uploads and referenced by URL. Web backups contain URLs; a full Kizzey settings backup can also carry preset artwork bytes.', '<span class="badge plain">FILES</span>') + infoRow('history', 'History file', 'data/history.json is written whenever a presence stops. The public state carries the most recent 120 entries.', ''))}
        <div class="field-hint" style="padding:14px 5px">To make a complete copy, stop the server and copy the entire data/ folder. The JSON export is for settings and community state only. Android MMKV files and the app's private data directory cannot be read directly.</div>
        <div style="height:20px"></div>`);
    },
  };

  function kzPresetList(raw) {
    if (Array.isArray(raw)) return raw;
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  }

  function kzLooksConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.state && typeof value.state === 'object') return false;
    const markers = ['largeImg', 'smallImg', 'button1', 'button2', 'button1link', 'button2link', 'timestampsStart', 'timestampsStop', 'partyCurrentSize', 'partyMaxSize', 'platform'];
    if (markers.some(key => key in value)) return true;
    return ['name', 'details', 'state'].some(key => key in value)
      && !['title', 'image', 'presets', 'prefs', 'settings', 'savedConfigs'].some(key => key in value);
  }

  function kzLooksPreset(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.state && typeof value.state === 'object') return false;
    return !kzLooksConfig(value)
      && ['title', 'name', 'details', 'state', 'image'].some(key => key in value);
  }

  function kzCount(value, singular, plural = singular + 's') {
    const number = Number(value) || 0;
    return `${number} ${number === 1 ? singular : plural}`;
  }

  function importPreview(payload, file) {
    if (Array.isArray(payload)) {
      if (payload.some(kzLooksConfig)) {
        return {
          mode: 'kizzey',
          title: 'Import these Custom RPC configs?',
          subtitle: `${kzCount(payload.length, 'RPC card')} in ${file.name}`,
          confirm: 'Import configs',
          body: '<p class="about-copy" style="margin-top:0">Each RPC card is saved as a local preset. Open Gallery and look under <b>Your cards</b> to apply one.</p><p class="about-copy">Android-local artwork paths are skipped because those bytes live in the app\'s private folder. Public artwork URLs are kept.</p>',
        };
      }
      if (payload.some(kzLooksPreset)) {
        return {
          mode: 'kizzey',
          title: 'Import these Kizzey presets?',
          subtitle: `${kzCount(payload.length, 'preset')} in ${file.name}`,
          confirm: 'Import presets',
          body: '<p class="about-copy" style="margin-top:0">Titled presets replace a local preset with the same title; untitled presets are appended.</p>',
        };
      }
      throw new Error('No Kizzey presets or RPC configs were found in that list.');
    }
    if (!payload || typeof payload !== 'object') throw new Error('That file does not contain a backup or config object.');
    const format = typeof payload.format === 'string' ? payload.format : '';

    if (format === 'kizzey-backup' || (!format && payload.prefs && typeof payload.prefs === 'object')) {
      const prefs = payload.prefs && typeof payload.prefs === 'object' ? payload.prefs : {};
      const configs = payload.configs && typeof payload.configs === 'object' ? payload.configs : {};
      const images = payload.presetImages && typeof payload.presetImages === 'object' ? payload.presetImages : {};
      const templates = kzPresetList(prefs.custom_rpc_template_presets);
      const textPresets = kzPresetList(prefs.rpc_presence_presets);
      const summary = [
        kzCount(Object.keys(prefs).length, 'preference'),
        kzCount(Object.keys(configs).length, 'config file'),
        kzCount(templates.length + textPresets.length, 'preset'),
        Object.keys(images).length ? kzCount(Object.keys(images).length, 'artwork file') : '',
        payload.appVersion ? `Kizzey ${payload.appVersion}` : '',
      ].filter(Boolean).join(' · ');
      return {
        mode: 'kizzey',
        title: 'Import this Kizzey backup?',
        subtitle: summary || file.name,
        confirm: 'Import backup',
        body: '<p class="about-copy" style="margin-top:0">Mapped look, Home, Custom RPC and media settings are merged into this server. Saved RPC configs, template presets and text presets become local saved cards; titled cards replace local cards with the same title, and untitled presets are appended.</p><p class="about-copy">Discord account and token fields, Android-only switches and MMKV data are ignored. Artwork is copied only when the bytes are present in the settings backup.</p>',
      };
    }

    if (format === 'kizzey-preset' || (Array.isArray(payload.presets) && !payload.prefs)) {
      const presets = Array.isArray(payload.presets) ? payload.presets : [];
      if (!presets.length) throw new Error('That Kizzey preset pack is empty.');
      return {
        mode: 'kizzey',
        title: 'Import this Kizzey preset pack?',
        subtitle: `${kzCount(presets.length, 'preset')}${payload.appVersion ? ` · Kizzey ${payload.appVersion}` : ''}`,
        confirm: 'Import presets',
        body: '<p class="about-copy" style="margin-top:0">Presets are merged by title, and an imported copy replaces a local preset with the same title. Untitled presets are appended. Only public https artwork URLs can travel in a preset pack.</p>',
      };
    }

    if (format && format !== 'kizzey-web-backup') {
      throw new Error(`The file format "${format}" is not supported.`);
    }

    if (kzLooksPreset(payload) && !kzLooksConfig(payload)) {
      return {
        mode: 'kizzey',
        title: 'Import this Kizzey preset?',
        subtitle: payload.title || payload.name || file.name,
        confirm: 'Import preset',
        body: '<p class="about-copy" style="margin-top:0">The preset is saved as a local card. Public https artwork is kept.</p>',
      };
    }

    if (kzLooksConfig(payload)) {
      return {
        mode: 'kizzey',
        title: 'Import this Custom RPC config?',
        subtitle: `${payload.name || file.name}${payload.platform ? ` · ${payload.platform}` : ''}`,
        confirm: 'Import config',
        body: '<p class="about-copy" style="margin-top:0">The card becomes a local saved preset. Open Gallery and look under <b>Your cards</b> to apply it. Android-local artwork paths are skipped because a stand-alone config does not carry image bytes.</p>',
      };
    }

    const state = payload.state || payload;
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('No state object was found.');
    const summary = [
      state.savedConfigs ? kzCount(state.savedConfigs.length, 'preset') : '',
      state.history ? `${state.history.length} history entries` : '',
      state.chatProfile ? `profile ${state.chatProfile.name || ''}` : '',
      payload.exportedAt ? `exported ${new Date(payload.exportedAt).toLocaleString()}` : '',
    ].filter(Boolean).join(' · ');
    return {
      mode: 'web',
      title: 'Restore this backup?',
      subtitle: summary || file.name,
      confirm: 'Restore backup',
      body: '<p class="about-copy" style="margin-top:0">Settings and community data will be merged into this server. The Discord token, gateway and server history stay untouched.</p>',
    };
  }

  function finishKizzeyImport(info) {
    const bits = [];
    if (info.settings) bits.push(kzCount(info.settings, 'setting'));
    if (info.presets) bits.push(kzCount(info.presets, 'preset'));
    if (info.images) bits.push(kzCount(info.images, 'artwork file'));
    const summary = [info.label || 'Kizzey import', bits.join(' · ')].filter(Boolean).join(' · ');
    const warnings = Array.isArray(info.warnings) ? info.warnings.filter(Boolean) : [];
    if (!warnings.length) {
      K.toast('Kizzey import complete', [summary, info.presets ? 'Saved cards are in Gallery → Your cards.' : ''].filter(Boolean).join(' — '), 'ok');
      return;
    }
    K.sheet({
      title: 'Kizzey import complete',
      subtitle: K.esc(summary),
      body: `<div class="card soft" style="margin-bottom:12px">
          <div class="card-title" style="margin-bottom:8px">Import notes</div>
          <ul style="margin:0;padding-left:18px">${warnings.map(warning => `<li style="margin:0 0 9px;color:var(--text-dim);font-size:0.8125rem;line-height:1.5">${K.esc(warning)}</li>`).join('')}</ul>
        </div>
        ${info.presets ? '<p class="about-copy">Saved cards are in Gallery → Your cards.</p>' : ''}
        <p class="field-hint">These notes are also kept in Logs.</p>
        <div class="modal-actions"><button class="btn btn-primary" data-close-sheet>Done</button></div>`,
    });
  }

  K.actions['backup-import'] = () => {
    K.bindFilePicker(async file => {
      try {
        const text = await file.text();
        let payload;
        try { payload = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
        const preview = importPreview(payload, file);
        K.confirm({
          title: preview.title,
          subtitle: preview.subtitle,
          confirm: preview.confirm,
          body: preview.body,
          onConfirm: async () => {
            try {
              const data = await K.api('/api/import', { method: 'POST', body: { backup: payload, fileName: file.name } });
              if (data.state) K.receiveState(data.state);
              K.applyTheme();
              K.render();
              if (preview.mode === 'web') {
                K.toast('Backup restored', 'The current session has been refreshed.', 'ok');
              } else {
                finishKizzeyImport(data.import || {});
              }
            } catch (error) { K.toast('Import failed', error.message, 'error'); }
          },
        });
      } catch (error) {
        K.toast('Could not read file', error.message, 'error');
      }
    }, 'application/json,.json');
  };

  // ---------------------------------------------------------------------
  // updates
  // ---------------------------------------------------------------------
  function releaseNotes(body) {
    const clean = K.stripTags(String(body || '')).replace(/\r/g, '').trim();
    if (!clean) return '<p class="about-copy">No release notes were provided.</p>';
    const lines = clean.split('\n').slice(0, 90);
    let html = '';
    let list = false;
    const closeList = () => { if (list) { html += '</ul>'; list = false; } };
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { closeList(); continue; }
      if (/^#{1,4}\s+/.test(line)) {
        closeList();
        html += `<h3>${h(line.replace(/^#{1,4}\s+/, ''))}</h3>`;
      } else if (/^[-*]\s+/.test(line)) {
        if (!list) { html += '<ul>'; list = true; }
        html += `<li>${h(line.replace(/^[-*]\s+/, ''))}</li>`;
      } else {
        closeList();
        html += `<p>${h(line)}</p>`;
      }
    }
    closeList();
    return html;
  }

  K.screens.update = {
    title: 'Updates',
    render() {
      const info = K.updateInfo;
      const current = K.get('version');
      return page('Updates', 'Release checks come from Codeberg.', '', `<button class="icon-btn" data-action="check-update" aria-label="Check again">${K.icon('refresh')}</button>`) + `
        <div class="card soft" style="margin-bottom:16px">
          <div class="card-row"><div class="feature-icon" style="width:48px;height:48px;background:linear-gradient(135deg,var(--primary-container),var(--surface-2));color:var(--primary)">${K.icon('download')}</div><div style="flex:1;min-width:0"><div class="card-title">Kizzey ${h(current)}</div><div class="card-sub">This server is running the web companion.</div></div><span class="badge good">CURRENT</span></div>
        </div>
        ${info ? `<div class="update-card" style="margin-bottom:16px">
          <div class="card-row between"><div><div class="update-eyebrow">${info.live ? 'LATEST ON CODEBERG' : 'BUNDLED RELEASE DATA'}</div><h2 style="margin:5px 0 3px">${h(info.tag || current)}</h2><div class="card-sub">${h(info.name || '')}</div></div><div class="update-icon">${K.icon('sparkles')}</div></div>
          <div class="release-notes">${releaseNotes(info.body)}</div>
          <div class="modal-actions"><a class="btn btn-primary" href="${K.esc(info.url || 'https://codeberg.org/UnpackedX/Kizzey/releases')}" target="_blank" rel="noopener">${K.icon('external-link', 'sm')}Open release</a><button class="btn btn-ghost" data-action="check-update">${K.icon('refresh', 'sm')}Check again</button></div>
        </div>` : `<div class="loading-line"><span></span></div>`}
        ${info?.assets?.length ? `<div class="setting-group"><div class="setting-group-title">Assets</div>${info.assets.slice(0, 6).map(asset => `<a class="credit-row" href="${K.esc(asset.url || '#')}" target="_blank" rel="noopener" style="color:inherit"><span class="credit-avatar">${K.icon('download', 'sm')}</span><span style="flex:1"><span class="credit-name" style="display:block">${h(asset.name || 'Asset')}</span><span class="credit-role">${asset.size ? fmtBytes(asset.size) : 'release file'}</span></span>${K.icon('external-link', 'sm')}</a>`).join('')}</div>` : ''}
        <div class="card soft"><div class="card-row"><div class="feature-icon" style="width:40px;height:40px;background:var(--surface-2);color:var(--primary)">${K.icon('info')}</div><div><div class="card-title" style="font-size:0.8125rem">Updating the web build</div><div class="card-sub">This is not an APK installer. Replace the Python and static files, then restart the server. Your data/ folder and settings survive.</div></div></div></div>
        <div class="quick-grid-2" style="margin-top:14px"><button class="btn btn-ghost" data-route="changelog">${K.icon('file-text', 'sm')}Changelog</button><button class="btn btn-ghost" data-route="about">${K.icon('info', 'sm')}About</button></div>
        <div style="height:20px"></div>`;
    },
    mount() {
      if (!K.updateInfo) {
        K.loadUpdate().then(() => {
          if (K.current.route === 'update') K.render();
        }).catch(error => {
          if (K.current.route === 'update') K.toast('Update check failed', error.message, 'error');
        });
      }
    },
  };

  // ---------------------------------------------------------------------
  // debug
  // ---------------------------------------------------------------------
  K.screens.debug = {
    title: 'Debug',
    render() {
      const nav = navigator;
      const conn = nav.connection || nav.mozConnection || nav.webkitConnection || {};
      const state = K.state || {};
      let bytes = 0;
      try { bytes = new Blob([JSON.stringify(state)]).size; } catch {}
      const rows = [
        ['App version', K.get('version')],
        ['Server device', `${K.get('host.device') || '—'} · ${K.get('host.platform') || '—'}`],
        ['Server uptime', K.duration(Date.now() - (K.get('startedAt') || Date.now()))],
        ['Browser', nav.userAgent],
        ['Viewport', `${window.innerWidth} × ${window.innerHeight} @ ${window.devicePixelRatio || 1}x`],
        ['Language', `${nav.language} · ${nav.languages?.join(', ') || ''}`],
        ['Timezone', Intl.DateTimeFormat().resolvedOptions().timeZone],
        ['Network', conn.effectiveType ? `${conn.effectiveType} · ${conn.downlink || '?'} Mb/s` : (nav.onLine ? 'online' : 'offline')],
        ['Service worker', 'serviceWorker' in nav ? (nav.serviceWorker.controller ? 'controlled' : 'registered, idle') : 'unsupported'],
        ['Media devices', nav.mediaDevices ? 'available' : 'unavailable'],
        ['Display capture', nav.mediaDevices?.getDisplayMedia ? 'available' : 'unavailable'],
        ['Notifications', typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'],
        ['Discord gateway', `${K.discordStatus().text}${K.get('gateway.latency') != null ? ' · ' + K.get('gateway.latency') + ' ms' : ''}`],
        ['State payload', fmtBytes(bytes)],
        ['Screen count', Object.keys(K.screens).length],
        ['Action count', Object.keys(K.actions).length],
      ];
      return page('Debug', 'Runtime facts for a bug report.', `
        ${K.settingGroup('Environment', rows.map(([label, value]) => infoRow('terminal', label, `<span style="overflow-wrap:anywhere">${h(String(value ?? ''))}</span>`, '')).join(''))}
        ${K.settingGroup('Actions', tappable('Copy diagnostics', 'Version, gateway, viewport, network and state size.', { action: 'debug-copy', icon: 'copy' }) + tappable('Download state JSON', 'Public state only; the Discord token is excluded.', { action: 'debug-download', icon: 'download' }) + tappable('Refresh state from server', 'Fetch /api/state and re-render the current screen.', { action: 'debug-refresh', icon: 'refresh' }) + tappable('Open server logs', 'Inspect the latest gateway and presence events.', { route: 'logs', icon: 'bug' }))}
        ${K.settingGroup('Recovery', tappable('Replay onboarding', 'Show the welcome flow again without touching your data.', { action: 'debug-onboarding', icon: 'sparkles' }) + tappable('Clear browser preferences', 'Remove selected room, collapsed cards and local tab notices. Server state stays intact.', { action: 'debug-clear-local', icon: 'trash' }) + tappable('Reconnect gateway', 'Close and reopen the Discord WebSocket.', { action: 'settings-reconnect-gateway', icon: 'wifi' }))}
        <div class="danger-zone"><div class="dz-title">Keep it on this machine</div><p>The API allows anyone who can reach it to control the saved Discord sessions, send chat messages and scan or delete your Discord messages. There is no HTTP login in front of the API, and signing in through Discord does not lock it. Run Kizzey on your own computer and leave the port closed to the internet.</p></div>
        <div class="field-hint" style="padding:16px 5px">Debug output never includes the Discord token. Public state strips it on the server before it reaches the browser.</div>
        <div style="height:20px"></div>`);
    },
  };

  K.actions['debug-copy'] = () => {
    const info = {
      generatedAt: new Date().toISOString(),
      version: K.get('version'),
      gateway: K.get('gateway', {}),
      account: K.get('account') ? { id: K.get('account.id'), username: K.get('account.username'), displayName: K.get('account.displayName') } : null,
      host: K.get('host', {}),
      route: K.current.route,
      viewport: [window.innerWidth, window.innerHeight, window.devicePixelRatio],
      userAgent: navigator.userAgent,
      language: navigator.language,
      online: navigator.onLine,
      stateBytes: (() => { try { return new Blob([JSON.stringify(K.state)]).size; } catch { return 0; } })(),
    };
    K.copy(JSON.stringify(info, null, 2), 'Diagnostics copied');
  };

  K.actions['debug-download'] = () => {
    K.download(`kizzey-state-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(K.state, null, 2));
    K.toast('State downloaded', 'Token excluded', 'ok');
  };

  K.actions['debug-refresh'] = async () => {
    try {
      await K.refresh();
      K.applyTheme();
      K.toast('State refreshed', '', 'ok');
      K.render();
    } catch (error) { K.toast('Could not refresh state', error.message, 'error'); }
  };

  K.actions['debug-onboarding'] = () => {
    K.confirm({
      title: 'Replay onboarding?', subtitle: 'This sets ui.onboarded to false. Your account, presets and chat stay.', confirm: 'Show welcome',
      onConfirm: async () => {
        K.setLocal('ui.onboarded', false);
        await K.queuePatch({ ui: { onboarded: false } }, 0);
        K.navigate('welcome');
      },
    });
  };

  K.actions['debug-clear-local'] = () => {
    ['kizzey.room', 'kizzey.collapsed', 'kizzey.drawer.notice', 'kizzey.theme'].forEach(key => localStorage.removeItem(key));
    K.local.activeRoom = 'lounge';
    K.local.collapsed = new Set();
    K.toast('Browser preferences cleared', '', 'ok');
  };
})();
