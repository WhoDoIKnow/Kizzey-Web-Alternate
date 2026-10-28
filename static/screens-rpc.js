/* Kizzey Web — rich presence editors */
(function () {
  'use strict';
  const K = window.K;

  const STATUSES = [
    { value: 'online', label: 'Online' },
    { value: 'idle', label: 'Idle' },
    { value: 'dnd', label: 'Do not disturb' },
    { value: 'invisible', label: 'Invisible' },
  ];
  const TYPES = [
    { value: '0', label: 'Playing' },
    { value: '1', label: 'Streaming' },
    { value: '2', label: 'Listening' },
    { value: '3', label: 'Watching' },
    { value: '5', label: 'Competing' },
  ];
  const PLATFORMS = [
    { value: 'android', label: 'Android' },
    { value: 'ios', label: 'iOS' },
    { value: 'desktop', label: 'Desktop' },
    { value: 'web', label: 'Web' },
    { value: 'samsung', label: 'Samsung' },
    { value: 'xbox', label: 'Xbox' },
    { value: 'ps5', label: 'PlayStation' },
  ];
  const PLATFORM_LABEL = { android: 'Android', ios: 'iOS', desktop: 'Desktop', web: 'Web', samsung: 'Samsung', xbox: 'Xbox', ps5: 'PlayStation' };

  K.customFromPreset = function customFromPreset(preset, fallbackName = 'Preset') {
    const source = K.clone(preset?.custom || preset || {});
    const now = Date.now();
    let timestampsStart = String(now);
    let timestampsStop = '';
    const timestamp = preset?.timestamp;
    if (timestamp && typeof timestamp === 'object') {
      if (timestamp.mode === 'none') {
        timestampsStart = '';
        timestampsStop = '';
      } else if (timestamp.mode === 'duration') {
        const duration = Math.max(0, Number(timestamp.durationMs) || 0);
        timestampsStart = String(now);
        timestampsStop = String(now + duration);
      } else if (timestamp.mode === 'absolute') {
        timestampsStart = timestamp.start ? String(timestamp.start) : '';
        timestampsStop = timestamp.stop ? String(timestamp.stop) : '';
      } else if (timestamp.mode === 'since_apply') {
        timestampsStart = String(now);
        timestampsStop = '';
      }
    }
    return Object.assign({}, K.get('custom', {}), source, {
      name: source.name || preset?.name || fallbackName,
      timestampsStart,
      timestampsStop,
      status: source.status || K.get('settings.rpcStatus', 'online'),
      platform: source.platform || K.get('custom.platform', 'android'),
      applicationId: source.applicationId || K.get('custom.applicationId', ''),
      largeUrl: source.largeUrl || '',
      largeImg: source.largeImg || '',
      smallUrl: source.smallUrl || '',
      smallImg: source.smallImg || '',
    });
  };

  K.presetLibrary = [
    {
      name: 'Midnight listening',
      tag: 'Music',
      emoji: '🎧',
      gradient: 'linear-gradient(135deg,#33234b,#71467e)',
      custom: { name: 'Midnight listening', details: 'A quiet room, one more song', state: 'Lost in the mix', type: '2', largeText: 'Late night', smallText: 'Kizzey' },
    },
    {
      name: 'In the stars',
      tag: 'Chill',
      emoji: '🌌',
      gradient: 'linear-gradient(135deg,#172d45,#335f88)',
      custom: { name: 'In the stars', details: 'Looking up for a while', state: 'Somewhere far away', type: '3', largeText: 'Stargazing' },
    },
    {
      name: 'Deep work',
      tag: 'Focus',
      emoji: '🖥️',
      gradient: 'linear-gradient(135deg,#1d2c2d,#3d6158)',
      custom: { name: 'Deep work', details: 'Building something small', state: 'Do not disturb, softly', type: '0', largeText: 'Focus mode' },
    },
    {
      name: 'One more game',
      tag: 'Gaming',
      emoji: '🎮',
      gradient: 'linear-gradient(135deg,#3d2130,#8b4761)',
      custom: { name: 'One more game', details: 'Just one. Probably.', state: 'Ranked, unfortunately', type: '0', largeText: 'Game night' },
    },
    {
      name: 'Coffee & code',
      tag: 'Dev',
      emoji: '☕',
      gradient: 'linear-gradient(135deg,#3e2b20,#8a6248)',
      custom: { name: 'Coffee & code', details: 'Fixing the thing that broke', state: 'One commit at a time', type: '0', largeText: 'Caffeinated' },
    },
    {
      name: 'On the road',
      tag: 'Travel',
      emoji: '🚗',
      gradient: 'linear-gradient(135deg,#21303a,#4e6f7f)',
      custom: { name: 'On the road', details: 'Windows down, music up', state: 'Heading somewhere', type: '3', largeText: 'Road trip' },
    },
    {
      name: 'Soft launch',
      tag: 'Social',
      emoji: '✨',
      gradient: 'linear-gradient(135deg,#3a2340,#a45b7e)',
      custom: { name: 'Soft launch', details: 'Around, if you need me', state: 'Talking to the internet', type: '2', largeText: 'Online' },
    },
    {
      name: 'Reading hours',
      tag: 'Quiet',
      emoji: '📖',
      gradient: 'linear-gradient(135deg,#2b2921,#6e674f)',
      custom: { name: 'Reading hours', details: 'Another chapter before bed', state: 'Quiet company', type: '3', largeText: 'Off the screen' },
    },
  ];

  // ---------------------------------------------------------------------
  // shared rpc machinery
  // ---------------------------------------------------------------------
  K.rpcStart = async function rpcStart(kind) {
    if (!K.isSignedIn()) {
      K.loginSheet(() => K.rpcStart(kind), { subtitle: 'Connect Discord to send this presence.' });
      return;
    }
    await K.flush().catch(() => {});
    try {
      const data = await K.api('/api/rpc/start', { method: 'POST', body: { kind } });
      if (data.state) K.receiveState(data.state);
      const p = data.presence?.info || K.currentPresence();
      K.toast(`${K.presenceKinds[kind]?.label || 'Presence'} is live`, p?.title || '', 'ok');
      K.render();
    } catch (error) {
      if (error.status === 401 || error.data?.loginRequired) {
        K.loginSheet(() => K.rpcStart(kind), {
          subtitle: K.isSignedIn() && !K.hasUserToken()
            ? K.esc(error.message)
            : 'Connect Discord to send this presence.',
          tokenOpen: K.isSignedIn() && !K.hasUserToken(),
        });
        return;
      }
      K.toast('Could not start presence', error.message, 'error');
    }
  };

  K.rpcStop = async function rpcStop(kind) {
    try {
      const data = await K.api('/api/rpc/stop', { method: 'POST', body: { kind: kind || null } });
      if (data.state) K.receiveState(data.state);
      K.toast('Presence stopped', '', 'ok');
      K.render();
    } catch (error) {
      K.toast('Could not stop presence', error.message, 'error');
    }
  };

  K.actions['start-rpc'] = el => K.rpcStart(el.dataset.kind || 'custom');
  K.actions['stop-rpc'] = el => K.rpcStop(el.dataset.kind || null);

  K.actions['rpc-preview'] = async function (el) {
    const kind = el.dataset.kind || 'custom';
    await K.flush().catch(() => {});
    try {
      const data = await K.api('/api/rpc/preview', {
        method: 'POST',
        body: { kind, config: kind === 'custom' ? K.get('custom', {}) : undefined },
      });
      const art = kind === 'custom' ? customArt() : K.presenceArt({ kind });
      K.sheet({
        title: 'Presence preview',
        subtitle: 'Exactly what Kizzey will send to Discord.',
        body: `${K.presencePreview(data.activity, {
          artUrl: art,
          smallArtUrl: kind === 'custom' ? smallArt() : '',
          appIcon: '/icon.png',
          appName: 'Kizzey',
        })}
        <details class="mt-16"><summary class="small muted" style="cursor:pointer">Raw activity payload</summary><pre class="ocr-result mt-8">${K.esc(JSON.stringify(data.activity, null, 2))}</pre></details>
        <div class="modal-actions"><button class="btn btn-primary" data-close-sheet>Done</button></div>`,
      });
    } catch (error) {
      K.toast('Preview failed', error.message, 'error');
    }
  };

  K.actions['rpc-help'] = () => {
    const tokens = [
      ['{{user}}', 'Your Discord display name'],
      ['{{media_title}}', 'The current media title'],
      ['{{media_artist}}', 'The current media artist'],
      ['{{app_name}}', 'The selected app'],
      ['{{weather_temp}}', 'Live temperature'],
      ['{{weather_emoji}}', 'Current condition emoji'],
      ['{{place}}', 'Weather or location city'],
      ['{{steps}}', 'Health step count'],
      ['{{heart_rate}}', 'Latest heart rate'],
      ['{{screen_name}}', 'OCR player/name field'],
      ['{{screen_score}}', 'OCR score/level field'],
      ['{{nav_destination}}', 'Navigation destination'],
      ['{{nav_eta}}', 'Estimated drive time'],
      ['{{time}}', 'Server local time'],
      ['{{date}}', 'Today, short form'],
    ];
    K.sheet({
      title: 'Template tokens',
      subtitle: 'Fallbacks are live, so cards keep moving.',
      body: `<div class="setting-group" style="padding:6px 14px">
        ${tokens.map(([token, desc]) => `<div class="setting-row" style="min-height:46px;padding:10px 0"><div class="setting-body"><div class="setting-title mono" style="font-size:0.71875rem">${K.esc(token)}</div><div class="setting-desc">${K.esc(desc)}</div></div><button class="icon-btn small" data-copy="${K.esc(token)}" aria-label="Copy">${K.icon('copy', 'sm')}</button></div>`).join('')}
      </div>
      <div class="field-hint">Tokens work in custom names, details, state, button labels, image descriptions and many feature templates.</div>
      <div class="modal-actions"><button class="btn btn-primary" data-close-sheet>Done</button></div>`,
    });
  };

  K.actions['save-preset'] = () => {
    const custom = K.get('custom', {});
    K.sheet({
      title: 'Save as preset',
      subtitle: 'Keep this card in your gallery.',
      body: `${K.field({ id: 'preset-name', label: 'Preset name', value: custom.name || 'My presence', placeholder: 'Late night listening' })}
        <div class="field-hint">The card fields and images are saved. You can edit them again any time.</div>
        <div class="modal-actions"><button class="btn btn-ghost" data-close-sheet>Cancel</button><button class="btn btn-primary" data-action="save-preset-confirm">${K.icon('bookmark', 'sm')}Save preset</button></div>`,
    });
  };

  K.actions['save-preset-confirm'] = async () => {
    const input = document.getElementById('preset-name');
    const name = input?.value.trim();
    if (!name) { K.toast('Give the preset a name', '', 'error'); input?.focus(); return; }
    const preset = {
      id: K.uid(),
      name,
      custom: K.clone(K.get('custom', {})),
      createdAt: Date.now(),
      author: K.get('chatProfile.name', 'You'),
      tag: 'Custom',
      emoji: '✨',
      gradient: 'linear-gradient(135deg,#3d2a51,#7f5f9d)',
    };
    const configs = K.clone(K.get('savedConfigs', []) || []);
    configs.unshift(preset);
    K.setLocal('savedConfigs', configs);
    await K.api('/api/patch', { method: 'POST', body: { updates: { savedConfigs: configs } } })
      .then(data => { if (data.state) K.receiveState(data.state); })
      .catch(error => K.toast('Could not save preset', error.message, 'error'));
    K.closeSheet();
    K.toast('Preset saved', name, 'ok');
    K.render();
  };

  K.actions['apply-preset'] = async function (el) {
    const id = el.dataset.presetId;
    const index = Number(el.dataset.presetIndex);
    let preset;
    if (id) preset = (K.get('savedConfigs', []) || []).find(p => p.id === id);
    else preset = K.presetLibrary[index];
    if (!preset) return;
    const next = K.customFromPreset(preset, preset.name);
    K.setLocal('custom', next);
    await K.queuePatch({ custom: next }, 0);
    K.navigate('custom');
    K.toast('Preset loaded', preset.name, 'ok');
  };

  K.actions['delete-preset'] = function (el) {
    const id = el.dataset.presetId;
    const preset = (K.get('savedConfigs', []) || []).find(p => p.id === id);
    if (!preset) return;
    K.confirm({
      title: 'Delete this preset?',
      subtitle: preset.name,
      confirm: 'Delete', danger: true,
      onConfirm: async () => {
        const configs = (K.get('savedConfigs', []) || []).filter(p => p.id !== id);
        K.setLocal('savedConfigs', configs);
        await K.queuePatch({ savedConfigs: configs }, 0);
        K.toast('Preset deleted', '', 'ok');
        K.render();
      },
    });
  };

  // ---------------------------------------------------------------------
  // images
  // ---------------------------------------------------------------------
  function imageUrl(urlPath, assetPath) {
    const url = K.get(urlPath, '');
    return /^(https?:\/\/|data:image\/|\/uploads\/)/i.test(String(url)) ? url : '';
  }
  function customArt() {
    return imageUrl('custom.largeUrl', 'custom.largeImg');
  }
  function smallArt() {
    return imageUrl('custom.smallUrl', 'custom.smallImg');
  }

  K.actions['upload-image'] = function (el) {
    const target = el.dataset.target;
    K.bindFilePicker(async file => {
      try {
        K.toast('Uploading image…', 'Resolving a Discord asset.', '');
        const data = await K.uploadDataUrl(file);
        const updates = {};
        if (target === 'custom-large') {
          updates.custom = { largeUrl: data.url, largeImg: data.asset || '' };
        } else if (target === 'custom-small') {
          updates.custom = { smallUrl: data.url, smallImg: data.asset || '' };
        } else if (target === 'media-art') {
          updates.media = { track: { ...K.get('media.track', {}), art: data.url } };
        } else if (target === 'apps-icon') {
          updates.apps = { selected: { ...K.get('apps.selected', {}), icon: data.url } };
        } else if (target === 'console-art') {
          updates.console = { selected: { ...(K.get('console.selected') || {}), art: data.url } };
        } else if (target === 'emulation-art') {
          updates.emulation = { art: data.url };
        } else if (target === 'profile-avatar') {
          updates.chatProfile = { avatar: data.url };
        }
        K.deepMerge(K.state, updates);
        await K.queuePatch(updates, 0);
        K.toast('Image ready', data.asset ? 'Discord asset resolved.' : 'Uploaded to this server.', 'ok');
        K.render();
      } catch (error) {
        K.toast('Upload failed', error.message, 'error');
      }
    });
  };

  K.actions['clear-image'] = async function (el) {
    const target = el.dataset.target;
    const updates = {};
    if (target === 'custom-large') updates.custom = { largeUrl: '', largeImg: '' };
    else if (target === 'custom-small') updates.custom = { smallUrl: '', smallImg: '' };
    else if (target === 'media-art') updates.media = { track: { ...K.get('media.track', {}), art: '' } };
    else if (target === 'apps-icon') updates.apps = { selected: { ...K.get('apps.selected', {}), icon: '' } };
    else if (target === 'console-art') updates.console = { selected: { ...(K.get('console.selected') || {}), art: '' } };
    else if (target === 'emulation-art') updates.emulation = { art: '' };
    K.deepMerge(K.state, updates);
    await K.queuePatch(updates, 0);
    K.render();
  };

  K.actions['resolve-images'] = async function () {
    const c = K.get('custom', {});
    const tasks = [];
    if (K.validUrl(c.largeUrl)) tasks.push(['large', c.largeUrl]);
    if (K.validUrl(c.smallUrl)) tasks.push(['small', c.smallUrl]);
    if (!tasks.length) { K.toast('Add an image URL first', '', ''); return; }
    try {
      const results = await Promise.all(tasks.map(async ([key, url]) => {
        const data = await K.api('/api/image', { method: 'POST', body: { url } });
        return [key, data.asset];
      }));
      const updates = {};
      for (const [key, asset] of results) updates[key === 'large' ? 'largeImg' : 'smallImg'] = asset;
      K.deepMerge(K.state, { custom: updates });
      await K.queuePatch({ custom: updates }, 0);
      K.toast('Images resolved', 'Discord can display both assets.', 'ok');
      K.render();
    } catch (error) {
      K.toast('Could not resolve image', error.message, 'error');
    }
  };

  function imageField(opts) {
    const url = K.get(opts.urlPath, '') || '';
    const asset = K.get(opts.assetPath, '') || '';
    const preview = imageUrl(opts.urlPath, opts.assetPath);
    return `<div class="card soft" style="padding:13px;margin-bottom:12px">
      <div class="card-row">
        <div style="width:54px;height:54px;border-radius:15px;overflow:hidden;flex:none;background:var(--surface-3);display:flex;align-items:center;justify-content:center;color:var(--faint)">
          ${preview ? `<img src="${K.esc(preview)}" alt="" style="width:100%;height:100%;object-fit:cover">` : K.icon('image')}
        </div>
        <div style="flex:1;min-width:0">
          <div class="card-title" style="font-size:0.78125rem">${K.esc(opts.label)}</div>
          <div class="card-sub" style="font-size:0.65625rem">${asset ? 'Discord asset ready' : url ? 'URL attached — resolved when started' : 'No image selected'}</div>
        </div>
        <button class="icon-btn small" data-action="upload-image" data-target="${K.esc(opts.target)}" aria-label="Upload image">${K.icon('upload', 'sm')}</button>
        ${url ? `<button class="icon-btn small" data-action="clear-image" data-target="${K.esc(opts.target)}" aria-label="Clear image">${K.icon('trash', 'sm')}</button>` : ''}
      </div>
      <div class="input-row mt-8">
        <input class="input" data-model="${K.esc(opts.urlPath)}" value="${K.esc(url)}" placeholder="https://… or upload">
        ${opts.resolve ? `<button class="btn btn-tonal btn-sm" data-action="resolve-images">${K.icon('link', 'sm')}Resolve</button>` : ''}
      </div>
      ${opts.hint ? `<div class="field-hint mt-4">${opts.hint}</div>` : ''}
    </div>`;
  }

  // ---------------------------------------------------------------------
  // custom rpc
  // ---------------------------------------------------------------------
  function customActivity(custom, opts = {}) {
    const c = custom || K.get('custom', {});
    const name = K.expand(c.name || opts.fallbackName || '');
    const details = K.expand(c.details || '');
    const stateLine = K.expand(c.state || '');
    const type = K.num(c.type, 0);
    const buttons = [];
    if (c.button1 && K.validUrl(c.button1link)) buttons.push(c.button1);
    if (c.button2 && K.validUrl(c.button2link)) buttons.push(c.button2);
    const start = c.timestampsStart ? (Number(c.timestampsStart) > 0 ? Number(c.timestampsStart) : new Date(c.timestampsStart).getTime()) : undefined;
    return {
      name: name || opts.fallbackName || 'Your activity name',
      details: details.length >= 2 ? details : '',
      state: stateLine.length >= 2 ? stateLine : '',
      type,
      buttons,
      timestamps: start && !Number.isNaN(start) ? { start } : undefined,
      url: type === 1 ? c.url : undefined,
    };
  }

  function customPreview(custom, opts = {}) {
    const c = custom || K.get('custom', {});
    return K.presencePreview(customActivity(c, opts), {
      artUrl: imageUrl(c.largeUrl || '', c.largeImg || ''),
      smallArtUrl: imageUrl(c.smallUrl || '', c.smallImg || ''),
      appIcon: '/icon.png',
      appName: opts.appName || 'Kizzey',
      typeSuffix: c.applicationId ? '· custom app' : '',
    });
  }

  K.customPreview = customPreview;
  K.customActivity = customActivity;

  function rpcHeader(kind, title, sub, actions = '') {
    const running = K.isRunning(kind);
    return K.pageHead({
      title,
      sub,
      actions: `${running ? '<span class="badge good" style="margin-top:9px">Live</span>' : ''}${actions}`,
    });
  }

  function rpcDock(kind, label = 'Start RPC') {
    const running = K.isRunning(kind);
    const other = K.runningKind();
    if (running) {
      return `<div class="action-dock">
        <button class="btn btn-primary" data-action="refresh-rpc">${K.icon('refresh', 'sm')}Refresh</button>
        <button class="btn btn-ghost" data-action="rpc-preview" data-kind="${K.esc(kind)}">${K.icon('eye', 'sm')}Preview</button>
        <button class="btn btn-danger" data-action="stop-rpc" data-kind="${K.esc(kind)}">${K.icon('stop', 'sm')}Stop</button>
      </div>`;
    }
    return `<div class="action-dock">
      <button class="btn btn-primary" data-action="start-rpc" data-kind="${K.esc(kind)}">${K.icon('play', 'sm')}${other ? 'Replace & start' : label}</button>
      <button class="btn btn-ghost" data-action="rpc-preview" data-kind="${K.esc(kind)}">${K.icon('eye', 'sm')}Preview</button>
      <button class="btn btn-ghost btn-round" data-action="rpc-help" aria-label="Template tokens">${K.icon('help-circle', 'sm')}</button>
    </div>`;
  }

  function statusCard(kind, label, desc) {
    const running = K.isRunning(kind);
    const other = K.runningKind();
    return `<div class="rpc-toggle-card ${running ? 'running' : ''}">
      <div class="status-icon" style="${running ? '' : 'background:var(--surface-2);color:var(--muted)'}">${K.icon(running ? 'radio' : (K.presenceKinds[kind]?.icon || 'activity'))}</div>
      <div style="flex:1;min-width:0"><div class="title">${running ? K.esc(label) + ' is live' : K.esc(label)}</div><div class="desc">${running ? `Since ${K.fmtTime(K.currentPresence()?.startedAt)} · ${K.duration(Date.now() - (K.currentPresence()?.startedAt || Date.now()))}` : other ? `Currently live: ${K.esc(K.presenceKinds[other]?.label || other)}` : K.esc(desc)}</div></div>
      ${running ? `<button class="btn btn-danger btn-sm" data-action="stop-rpc" data-kind="${K.esc(kind)}">Stop</button>` : `<span class="badge plain">Ready</span>`}
    </div>`;
  }

  function sec(id, title, subtitle, icon, body, opts = {}) {
    const closed = K.local.collapsed.has(id) && !opts.open;
    return `<section class="section-card ${closed ? 'collapsed' : ''}">
      <div class="section-card-head" data-section-toggle="${K.esc(id)}">
        <span class="sec-icon">${K.icon(icon)}</span>
        <div class="section-card-title">${title}${subtitle ? `<small>${subtitle}</small>` : ''}</div>
        ${K.icon('chevron-down', 'sm sec-chevron')}
      </div>
      <div class="section-card-body">${body}</div>
    </section>`;
  }

  function presetShelf() {
    return `<div class="preset-shelf">${K.presetLibrary.map((p, i) => `<button class="preset-card" data-action="apply-preset" data-preset-index="${i}">
      <div class="preset-art" style="background:${p.gradient}"><span class="p-emoji">${p.emoji}</span><span class="p-tag">${K.esc(p.tag)}</span></div>
      <div class="preset-body"><div class="preset-name">${K.esc(p.name)}</div><div class="preset-sub">${K.esc(p.custom.details || 'Custom card')}</div></div>
    </button>`).join('')}</div>`;
  }

  K.screens.custom = {
    title: 'Custom RPC',
    render() {
      const c = K.get('custom', {});
      return `<div class="page">
        ${rpcHeader('custom', 'Custom RPC', 'Build a card that feels like you.', `<button class="icon-btn" data-action="save-preset" aria-label="Save preset">${K.icon('bookmark')}</button>`)}
        ${statusCard('custom', 'Custom RPC', 'All changes save as you type.')}
        <div class="preview-wrap" id="rpc-preview">${customPreview(c)}</div>
        ${K.sectionLabel('Start from a preset', `<span style="font-size:0.65625rem;color:var(--faint);text-transform:none;letter-spacing:0">${K.presetLibrary.length} cards</span>`)}
        ${presetShelf()}
        ${sec('custom-basics', 'The card', 'Name, lines and activity type', 'edit',
          `${K.field({ label: 'Activity name', path: 'custom.name', value: c.name, placeholder: 'What should Discord show?', maxlength: 128, right: '<span class="counter">128 max</span>', hint: 'Required. Tokens like {{user}} and {{media_title}} work here.' })}
           ${K.field({ label: 'Details', path: 'custom.details', value: c.details, placeholder: 'A second line', maxlength: 128 })}
           ${K.field({ label: 'State', path: 'custom.state', value: c.state, placeholder: 'A quieter third line', maxlength: 128 })}
           <div class="two-col">
             ${K.select({ label: 'Activity type', path: 'custom.type', value: c.type, options: TYPES })}
             ${K.select({ label: 'Presence status', path: 'custom.status', value: c.status, options: STATUSES })}
           </div>
           ${K.field({ label: 'Stream URL', path: 'custom.url', value: c.url, placeholder: 'https://twitch.tv/yourchannel', hint: 'Only used when type is Streaming. Must be a valid URL.' })}
           <div class="mt-8"><button class="btn btn-ghost btn-sm" data-action="rpc-help">${K.icon('code', 'sm')}Template tokens</button></div>`,
          { open: !c.name }
        )}
        ${sec('custom-images', 'Artwork', 'Large and small images', 'image',
          `${imageField({ label: 'Large image', urlPath: 'custom.largeUrl', assetPath: 'custom.largeImg', target: 'custom-large', resolve: true, hint: 'Uploads are sent to the Kizzy image API and become a Discord mp: asset.' })}
           ${K.field({ label: 'Large image text', path: 'custom.largeText', value: c.largeText, placeholder: 'Shown when hovering' })}
           ${imageField({ label: 'Small image', urlPath: 'custom.smallUrl', assetPath: 'custom.smallImg', target: 'custom-small' })}
           ${K.field({ label: 'Small image text', path: 'custom.smallText', value: c.smallText, placeholder: 'Shown when hovering' })}`
        )}
        ${sec('custom-buttons', 'Buttons', 'Two links below the card', 'link',
          `${K.field({ label: 'Button 1 label', path: 'custom.button1', value: c.button1, maxlength: 32, placeholder: 'Open my site' })}
           ${K.field({ label: 'Button 1 URL', path: 'custom.button1link', value: c.button1link, type: 'url', placeholder: 'https://…' })}
           ${K.field({ label: 'Button 2 label', path: 'custom.button2', value: c.button2, maxlength: 32, placeholder: 'Second link' })}
           ${K.field({ label: 'Button 2 URL', path: 'custom.button2link', value: c.button2link, type: 'url', placeholder: 'https://…' })}`
        )}
        ${sec('custom-time', 'Party & timers', 'Elapsed time, countdown and party size', 'timer',
          `<div class="two-col">
            ${K.field({ label: 'Start time', path: 'custom.timestampsStart', value: K.timeValue(c.timestampsStart), type: 'datetime-local' })}
            ${K.field({ label: 'Stop time', path: 'custom.timestampsStop', value: K.timeValue(c.timestampsStop), type: 'datetime-local' })}
          </div>
          <div class="two-col">
            ${K.field({ label: 'Party size', path: 'custom.partyCurrentSize', value: c.partyCurrentSize, type: 'number', min: 0, placeholder: '2' })}
            ${K.field({ label: 'Party max', path: 'custom.partyMaxSize', value: c.partyMaxSize, type: 'number', min: 0, placeholder: '5' })}
          </div>
          <div class="field-hint">Party size only appears when both numbers are set and max is at least the current size.</div>`
        )}
        ${sec('custom-app', 'Application & platform', 'Display through another Discord app', 'layers',
          `${K.field({ label: 'Application ID', path: 'custom.applicationId', value: c.applicationId, placeholder: '962990036020756480', hint: 'Leave blank to use Kizzey’s default application.' })}
           ${K.select({ label: 'Platform', path: 'custom.platform', value: c.platform, options: PLATFORMS })}
           ${K.select({ label: 'Status display', path: 'custom.statusDisplayType', value: c.statusDisplayType ?? -1, options: [{ value: -1, label: 'Automatic' }, { value: 0, label: 'Show name' }, { value: 1, label: 'Show state' }, { value: 2, label: 'Show details' }] })}`
        )}
        <details class="section-card" style="padding:16px">
          <summary class="card-title" style="cursor:pointer;font-size:0.8125rem">More customisation</summary>
          <div class="mt-12">
            <div class="field-hint mb-12">Status display and platform tags map to Discord's newer presence fields. Older clients may ignore them.</div>
            <button class="btn btn-ghost btn-block" data-action="reset-custom">Reset custom card</button>
          </div>
        </details>
        <div style="height:12px"></div>
        ${rpcDock('custom', 'Start Custom RPC')}
      </div>`;
    },
    mount() {
      K.afterModelChange = (path, value) => {
        if (path.startsWith('custom.')) {
          if (path === 'custom.largeUrl') {
            if (K.get('custom.largeImg')) { K.setLocal('custom.largeImg', ''); K.queuePatch({ custom: { largeImg: '' } }); }
          }
          if (path === 'custom.smallUrl') {
            if (K.get('custom.smallImg')) { K.setLocal('custom.smallImg', ''); K.queuePatch({ custom: { smallImg: '' } }); }
          }
          const preview = document.getElementById('rpc-preview');
          if (preview) preview.innerHTML = customPreview(K.get('custom', {}));
        }
      };
    },
    onModelChange(path, value) {
      if (path.startsWith('custom.')) {
        if (path === 'custom.largeUrl' && K.get('custom.largeImg')) { K.setLocal('custom.largeImg', ''); K.queuePatch({ custom: { largeImg: '' } }); }
        if (path === 'custom.smallUrl' && K.get('custom.smallImg')) { K.setLocal('custom.smallImg', ''); K.queuePatch({ custom: { smallImg: '' } }); }
        const preview = document.getElementById('rpc-preview');
        if (preview) preview.innerHTML = customPreview(K.get('custom', {}));
      }
    },
  };

  K.actions['reset-custom'] = () => {
    K.confirm({
      title: 'Reset the custom card?',
      subtitle: 'Name, lines, timers, buttons and artwork will be cleared.',
      confirm: 'Reset', danger: true,
      onConfirm: async () => {
        const defaults = {
          name: '', details: '', state: '', partyCurrentSize: '', partyMaxSize: '',
          timestampsStart: '', timestampsStop: '', status: K.get('settings.rpcStatus', 'online'),
          button1: '', button1link: '', button2: '', button2link: '',
          largeImg: '', largeText: '', smallImg: '', smallText: '', type: '0', url: '',
          applicationId: '', statusDisplayType: -1, largeUrl: '', smallUrl: '', platform: 'android',
        };
        K.setLocal('custom', defaults);
        await K.queuePatch({ custom: defaults }, 0);
        K.toast('Custom card reset', '', 'ok');
        K.render();
      },
    });
  };

  // ---------------------------------------------------------------------
  // app detection
  // ---------------------------------------------------------------------
  function appColor(app) {
    return app?.color || '#d3c0f6';
  }

  K.screens.apps = {
    title: 'App Detection',
    render() {
      const apps = K.get('apps', {});
      const selected = apps.selected || null;
      const catalog = K.get('appCatalog', []) || [];
      const query = (K.appSearch || '').toLowerCase();
      return `<div class="page">
        ${rpcHeader('apps', 'App Detection', 'Show what you are using, hands-free.')}
        ${statusCard('apps', 'App Detection', 'Pick an app and keep it visible.')}
        <div class="card soft" style="margin-bottom:14px">
          <div class="card-row"><div class="setting-icon" style="width:38px;height:38px;border-radius:13px;background:var(--surface-2);display:flex;align-items:center;justify-content:center;color:var(--primary)">${K.icon('monitor', 'sm')}</div><div style="flex:1"><div class="card-title" style="font-size:0.8125rem">A browser is not a phone</div><div class="card-sub">You can detect this browser or pick any app manually. For Android foreground detection, run Kizzey on the phone.</div></div></div>
          <div class="quick-grid-2 mt-12">
            <button class="btn btn-tonal btn-sm" data-action="detect-browser">${K.icon('search', 'sm')}Detect this browser</button>
            <button class="btn btn-ghost btn-sm" data-action="add-app">${K.icon('plus', 'sm')}Add an app</button>
          </div>
        </div>
        ${selected ? `<div class="setting-group-title">Selected app</div>
          <div class="card" style="margin-bottom:14px">
            <div class="card-row">
              <div class="list-icon" style="width:47px;height:47px;border-radius:15px;background:${K.esc(appColor(selected))}22;color:${K.esc(appColor(selected))}">
                ${selected.icon && /^(\/|https?:|data:image)/.test(selected.icon) ? `<img src="${K.esc(selected.icon)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">` : K.icon(selected.icon || 'layout-grid')}
              </div>
              <div style="flex:1;min-width:0"><div class="card-title">${K.esc(selected.presenceName || selected.title)}</div><div class="card-sub">${K.esc(selected.package || 'Manual app')} · ${K.esc(PLATFORM_LABEL[selected.platform] || 'App')}</div></div>
              <button class="icon-btn small" data-action="clear-app" aria-label="Clear app">${K.icon('close', 'sm')}</button>
            </div>
            <div class="setting-group-title" style="margin-top:16px">Card text</div>
            ${K.field({ label: 'Activity name', path: 'apps.selected.presenceName', value: selected.presenceName || selected.title, placeholder: selected.title || 'App name' })}
            <div class="two-col">
              ${K.field({ label: 'Details', path: 'apps.selected.details', value: selected.details, placeholder: 'Writing code' })}
              ${K.field({ label: 'State', path: 'apps.selected.state', value: selected.state, placeholder: 'In the editor' })}
            </div>
            <div class="two-col">
              ${K.select({ label: 'Activity type', path: 'apps.selected.type', value: selected.type ?? 0, options: TYPES })}
              ${K.field({ label: 'Application ID', path: 'apps.selected.applicationId', value: selected.applicationId, placeholder: 'Optional' })}
            </div>
            <div class="card-row between mt-8"><span class="small muted">App icon / artwork</span><button class="btn btn-ghost btn-sm" data-action="upload-image" data-target="apps-icon">${K.icon('upload', 'sm')}Upload icon</button></div>
            ${selected.icon ? `<div class="card-row mt-8"><img src="${K.esc(selected.icon)}" alt="" style="width:34px;height:34px;border-radius:9px;object-fit:cover"><span class="tiny muted ellipsis">${K.esc(selected.icon)}</span></div>` : ''}
          </div>` : ''}
        <div class="setting-group-title">Apps on this device</div>
        <div class="field"><div class="input-wrap">${K.icon('search', 'sm')}<input id="app-search" class="input" style="padding-left:38px" data-local="app-search" placeholder="Search apps" value="${K.esc(K.appSearch || '')}"></div></div>
        <div class="list" id="app-list">
          ${catalog.map(app => `<button class="list-item app-result ${selected && selected.title === app.title ? 'active' : ''}" data-action="select-app" data-app-title="${K.esc(app.title)}" data-name="${K.esc((app.title + ' ' + (app.package || '')).toLowerCase())}" style="${selected && selected.title === app.title ? 'border-color:color-mix(in srgb,var(--primary) 35%,transparent);background:color-mix(in srgb,var(--primary) 6%,var(--surface-1))' : ''}">
            <span class="list-icon" style="background:${K.esc(appColor(app))}1f;color:${K.esc(appColor(app))}">${app.icon && /^(\/|https?:|data:image)/.test(app.icon) ? `<img src="${K.esc(app.icon)}" alt="">` : K.icon(app.icon || 'layout-grid')}</span>
            <span class="list-body"><span class="list-title">${K.esc(app.title)}</span><span class="list-desc">${K.esc(app.package || 'Manual')} · ${K.esc(PLATFORM_LABEL[app.platform] || 'App')}</span></span>
            <span class="list-end">${selected && selected.title === app.title ? K.icon('check', 'sm') : K.icon('chevron-right', 'sm')}</span>
          </button>`).join('')}
        </div>
        <div class="setting-group-title">Detection</div>
        <div class="setting-group">
          ${K.toggleRow({ title: 'Auto-detect apps', desc: 'On Android this watches the foreground app. In the browser it only sets a manual default.', path: 'apps.autoDetect', checked: apps.autoDetect, icon: 'activity' })}
          ${K.toggleRow({ title: 'Show app buttons', desc: 'Attach the app link to the presence card when available', path: 'apps.showButtons', checked: apps.showButtons, icon: 'link' })}
        </div>
        <div style="height:4px"></div>
        ${rpcDock('apps', 'Start App Detection')}
      </div>`;
    },
    mount(root) {
      const search = root.querySelector('#app-search');
      const filter = () => {
        const q = search.value.trim().toLowerCase();
        K.appSearch = q;
        root.querySelectorAll('.app-result').forEach(el => el.classList.toggle('hidden', q && !el.dataset.name.includes(q)));
      };
      if (search) {
        search.addEventListener('input', filter);
        if (K.appSearch) filter();
      }
    },
    onModelChange(path) {
      if (path.startsWith('apps.selected.')) K.queuePatch(K.patchObject(path, K.get(path)), 200);
    },
  };

  K.actions['select-app'] = async function (el) {
    const title = el.dataset.appTitle;
    const app = (K.get('appCatalog', []) || []).find(a => a.title === title);
    if (!app) return;
    const selected = Object.assign({}, app, {
      presenceName: app.presenceName || app.title,
      type: app.type ?? 0,
      applicationId: app.applicationId || '',
    });
    K.setLocal('apps.selected', selected);
    K.setLocal('apps.enabled', true);
    await K.queuePatch({ apps: { selected, enabled: true } }, 0);
    K.toast('App selected', app.title, 'ok');
    K.render();
  };

  K.actions['clear-app'] = async () => {
    K.setLocal('apps.selected', null);
    K.setLocal('apps.enabled', false);
    await K.queuePatch({ apps: { selected: null, enabled: false } }, 0);
    K.render();
  };

  K.actions['detect-browser'] = async () => {
    const ua = navigator.userAgent;
    let title = 'Chrome';
    let icon = 'globe';
    if (/Firefox/i.test(ua)) title = 'Firefox';
    else if (/Edg/i.test(ua)) title = 'Microsoft Edge';
    else if (/SamsungBrowser/i.test(ua)) title = 'Samsung Internet';
    else if (/Safari/i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua)) title = 'Safari';
    else if (/Chrome|Chromium/i.test(ua)) title = 'Chrome';
    const catalog = K.clone(K.get('appCatalog', []) || []);
    let app = catalog.find(a => a.title === title);
    if (!app) {
      app = { title, package: 'browser', icon, color: '#f2c66d', details: 'Browsing the web', state: 'In ' + title, platform: 'web', type: 0 };
      catalog.push(app);
      K.setLocal('appCatalog', catalog);
      await K.queuePatch({ appCatalog: catalog }, 0);
    }
    const selected = Object.assign({}, app, { presenceName: app.title, details: 'Browsing the web', state: 'In ' + app.title, type: 0 });
    K.setLocal('apps.selected', selected);
    K.setLocal('apps.enabled', true);
    await K.queuePatch({ apps: { selected, enabled: true } }, 0);
    K.toast('Browser detected', title, 'ok');
    K.render();
  };

  K.actions['add-app'] = () => {
    K.sheet({
      title: 'Add an app',
      subtitle: 'Any app can become a presence card.',
      body: `${K.field({ id: 'new-app-title', label: 'App name', placeholder: 'Notion' })}
        ${K.field({ id: 'new-app-package', label: 'Package / identifier', placeholder: 'com.example.app' })}
        <div class="two-col">${K.field({ id: 'new-app-details', label: 'Details', placeholder: 'Writing a doc' })}${K.field({ id: 'new-app-state', label: 'State', placeholder: 'Heads down' })}</div>
        ${K.field({ id: 'new-app-id', label: 'Discord application ID', placeholder: 'Optional' })}
        ${K.select({ id: 'new-app-platform', label: 'Platform', value: 'android', options: PLATFORMS })}
        <div class="modal-actions"><button class="btn btn-ghost" data-close-sheet>Cancel</button><button class="btn btn-primary" data-action="add-app-confirm">${K.icon('plus', 'sm')}Add app</button></div>`,
    });
  };

  K.actions['add-app-confirm'] = async () => {
    const title = document.getElementById('new-app-title')?.value.trim();
    if (!title) { K.toast('App name required', '', 'error'); return; }
    const app = {
      title,
      package: document.getElementById('new-app-package')?.value.trim() || 'manual',
      details: document.getElementById('new-app-details')?.value.trim() || 'Using ' + title,
      state: document.getElementById('new-app-state')?.value.trim() || 'On ' + title,
      applicationId: document.getElementById('new-app-id')?.value.trim() || '',
      platform: document.getElementById('new-app-platform')?.value || 'android',
      icon: 'layout-grid',
      color: '#d3c0f6',
      type: 0,
      custom: true,
    };
    const catalog = K.clone(K.get('appCatalog', []) || []);
    catalog.unshift(app);
    K.setLocal('appCatalog', catalog);
    await K.queuePatch({ appCatalog: catalog }, 0);
    K.closeSheet();
    K.toast('App added', title, 'ok');
    K.render();
  };

  // ---------------------------------------------------------------------
  // media
  // ---------------------------------------------------------------------
  K.mediaObjectUrl = K.mediaObjectUrl || '';

  K.screens.media = {
    title: 'Media RPC',
    render() {
      const media = K.get('media', {});
      const track = media.track || {};
      const art = /^(https?:|\/uploads\/|data:image)/i.test(track.art || '') ? track.art : '';
      const duration = Math.max(1, K.num(track.duration, 214));
      const position = Math.max(0, Math.min(duration, K.num(track.position, 0)));
      const pct = Math.min(100, position / duration * 100);
      return `<div class="page">
        ${rpcHeader('media', 'Media RPC', 'The song, the album, the late-night loop.')}
        ${statusCard('media', 'Media RPC', 'Upload a file or type in what you are playing.')}
        <div class="media-stage">
          <div class="media-art">${art ? `<img src="${K.esc(art)}" alt="">` : `<span class="empty-art">${K.icon('music', 'xl')}</span>`}</div>
          <div class="media-meta">
            <div class="media-title">${K.esc(K.expand(track.title || 'Nothing playing yet'))}</div>
            <div class="media-artist">${K.esc(K.expand(track.artist || 'Add a track below'))}</div>
            <div class="media-progress">
              <input type="range" min="0" max="${duration}" value="${position}" data-model="media.track.position" data-type="number" id="media-progress">
              <div class="media-times"><span data-media-time>${K.clockDuration(position * 1000)}</span><span data-media-duration>${K.clockDuration(duration * 1000)}</span></div>
            </div>
            <div class="media-controls">
              <button class="mc" data-action="media-seek-zero" aria-label="Restart">${K.icon('skip-back', 'sm')}</button>
              <button class="mc play" data-action="media-toggle" aria-label="${track.playing ? 'Pause' : 'Play'}">${K.icon(track.playing ? 'pause' : 'play', 'lg')}</button>
              <button class="mc" data-action="media-next" aria-label="Next">${K.icon('skip-forward', 'sm')}</button>
            </div>
            <div class="media-source-row">
              <button class="chip" data-action="pick-media-file">${K.icon('upload', 'sm')}Play a local file</button>
              <button class="chip" data-action="media-demo">${K.icon('sparkles', 'sm')}Fill a demo track</button>
            </div>
            <div class="field-hint mt-12" style="color:#b9a8c5">Browsers cannot see other apps' media. This player is real; it can play your file and send its metadata to Discord.</div>
          </div>
        </div>
        ${K.mediaObjectUrl ? `<audio id="media-audio" src="${K.esc(K.mediaObjectUrl)}" preload="metadata" style="display:none"></audio>` : ''}
        ${K.sectionLabel('Track details')}
        <div class="card">
          ${K.field({ label: 'Title', path: 'media.track.title', value: track.title, placeholder: 'Song title' })}
          <div class="two-col">
            ${K.field({ label: 'Artist', path: 'media.track.artist', value: track.artist, placeholder: 'Artist' })}
            ${K.field({ label: 'Album', path: 'media.track.album', value: track.album, placeholder: 'Album' })}
          </div>
          <div class="two-col">
            ${K.field({ label: 'Duration (seconds)', path: 'media.track.duration', value: track.duration, type: 'number', min: 1 })}
            ${K.select({ label: 'Activity type', path: 'media.type', value: media.type, options: TYPES })}
          </div>
          ${imageField({ label: 'Album art', urlPath: 'media.track.art', assetPath: 'media.track.asset', target: 'media-art', hint: 'Use a square image for the best Discord card.' })}
        </div>
        ${K.sectionLabel('Behaviour')}
        <div class="setting-group">
          ${K.toggleRow({ title: 'Show progress bar', desc: 'Timestamps use the position and duration above', path: 'media.showProgress', checked: media.showProgress, icon: 'timer' })}
          ${K.toggleRow({ title: 'Hide when paused', desc: 'Clear the presence when playback stops', path: 'media.hideOnPause', checked: media.hideOnPause, icon: 'pause' })}
          <div class="setting-row">
            <div class="setting-icon">${K.icon('mic', 'sm')}</div>
            <div class="setting-body"><div class="setting-title">Hidden status</div><div class="setting-desc">Status to use while paused and hidden</div></div>
            ${K.select({ path: 'media.hiddenStatus', value: media.hiddenStatus, options: STATUSES, cls: '' })}
          </div>
        </div>
        <div style="height:4px"></div>
        ${rpcDock('media', 'Start Media RPC')}
      </div>`;
    },
    mount(root) {
      const audio = root.querySelector('#media-audio');
      const progress = root.querySelector('#media-progress');
      if (audio) {
        audio.volume = .7;
        audio.addEventListener('timeupdate', () => {
          const track = K.get('media.track', {});
          if (!track.playing) return;
          K.setLocal('media.track.position', Math.floor(audio.currentTime));
          updateMediaDom();
        });
        audio.addEventListener('ended', () => {
          K.setLocal('media.track.playing', false);
          K.queuePatch({ media: { track: { playing: false } } });
          updateMediaDom();
        });
        if (K.get('media.track.playing')) audio.play().catch(() => {});
      }
      progress?.addEventListener('change', () => {
        if (audio) audio.currentTime = Number(progress.value);
        updateMediaDom();
      });
      updateMediaDom();
    },
    onModelChange(path, value) {
      if (path === 'media.track.position') {
        const audio = document.getElementById('media-audio');
        if (audio) audio.currentTime = Number(value);
        updateMediaDom();
      }
      if (path === 'media.track.duration') updateMediaDom();
    },
  };

  function updateMediaDom() {
    if (K.current.route !== 'media') return;
    const track = K.get('media.track', {});
    const duration = Math.max(1, K.num(track.duration, 214));
    const position = Math.max(0, Math.min(duration, K.num(track.position, 0)));
    const time = document.querySelector('[data-media-time]');
    if (time) time.textContent = K.clockDuration(position * 1000);
    const dur = document.querySelector('[data-media-duration]');
    if (dur) dur.textContent = K.clockDuration(duration * 1000);
    const prog = document.getElementById('media-progress');
    if (prog && document.activeElement !== prog) prog.value = position;
  }

  // A single lightweight ticker keeps both simulated and real playback moving.
  let mediaTick = 0;
  setInterval(() => {
    if (K.current.route !== 'media') return;
    const track = K.get('media.track', {});
    if (!track.playing) return;
    const audio = document.getElementById('media-audio');
    const duration = Math.max(1, K.num(track.duration, 214));
    let position = K.num(track.position, 0);
    if (audio && !audio.paused) position = audio.currentTime;
    else position += 1;
    if (position >= duration) {
      position = 0;
      K.setLocal('media.track.playing', false);
      K.setLocal('media.track.position', 0);
      K.queuePatch({ media: { track: { playing: false, position: 0 } } }, 0);
      K.render();
      return;
    }
    K.setLocal('media.track.position', Math.floor(position));
    updateMediaDom();
    mediaTick += 1;
    if (mediaTick % 5 === 0) K.queuePatch({ media: { track: { position: Math.floor(position) } } }, 0);
    const icon = document.querySelector('[data-action="media-toggle"]');
    if (icon && !track.playing) icon.innerHTML = K.icon('play', 'lg');
  }, 1000);

  K.actions['media-toggle'] = async function () {
    const track = K.get('media.track', {});
    if (!track.title) { K.toast('Add a track first', 'A title is required before playback.', 'error'); return; }
    const playing = !track.playing;
    let position = K.num(track.position, 0);
    if (position >= K.num(track.duration, 214)) position = 0;
    K.setLocal('media.track.playing', playing);
    K.setLocal('media.track.position', position);
    await K.queuePatch({ media: { track: { playing, position } } }, 0);
    K.render();
    if (playing) {
      const audio = document.getElementById('media-audio');
      if (audio) audio.play().catch(() => {});
    }
  };

  K.actions['media-seek-zero'] = () => {
    K.setLocal('media.track.position', 0);
    K.queuePatch({ media: { track: { position: 0 } } }, 0);
    const audio = document.getElementById('media-audio');
    if (audio) audio.currentTime = 0;
    updateMediaDom();
  };

  K.actions['media-next'] = () => {
    const duration = K.num(K.get('media.track.duration'), 214);
    K.setLocal('media.track.position', duration);
    K.setLocal('media.track.playing', false);
    K.queuePatch({ media: { track: { position: duration, playing: false } } }, 0);
    K.render();
  };

  K.actions['pick-media-file'] = function () {
    K.bindFilePicker(async file => {
      try {
        if (K.mediaObjectUrl) URL.revokeObjectURL(K.mediaObjectUrl);
        K.mediaObjectUrl = URL.createObjectURL(file);
        const title = file.name.replace(/\\.[^.]+$/, '').replace(/[_-]+/g, ' ');
        const duration = await new Promise(resolve => {
          const audio = new Audio();
          audio.src = K.mediaObjectUrl;
          audio.addEventListener('loadedmetadata', () => resolve(Math.round(audio.duration) || 214), { once: true });
          audio.addEventListener('error', () => resolve(214), { once: true });
          setTimeout(() => resolve(214), 2500);
        });
        const patch = { track: { title, artist: K.get('media.track.artist', ''), album: '', duration, position: 0, playing: true }, source: 'local' };
        K.deepMerge(K.state, { media: patch });
        await K.queuePatch({ media: patch }, 0);
        K.render();
        setTimeout(() => document.getElementById('media-audio')?.play().catch(() => {}), 80);
      } catch (error) { K.toast('Could not open audio', error.message, 'error'); }
    }, 'audio/*');
  };

  K.actions['media-demo'] = async () => {
    const tracks = [
      { title: 'Sleeptalk', artist: 'NEEDTOBREATHE', album: 'HARD LOVE', duration: 234 },
      { title: 'Space Song', artist: 'Beach House', album: 'Depression Cherry', duration: 320 },
      { title: 'Lavender Haze', artist: 'Taylor Swift', album: 'Midnights', duration: 202 },
    ];
    const t = K.random(tracks);
    const patch = { track: { ...t, art: K.get('media.track.art', ''), position: 0, playing: true }, source: 'manual' };
    K.deepMerge(K.state, { media: patch });
    await K.queuePatch({ media: patch }, 0);
    K.render();
  };

  // ---------------------------------------------------------------------
  // console
  // ---------------------------------------------------------------------
  const CONSOLES = ['PlayStation 5', 'PlayStation 4', 'Xbox Series X|S', 'Xbox One', 'Nintendo Switch', 'Steam Deck', 'Samsung Galaxy'];
  const GAMES = {
    'PlayStation 5': ['Marvel’s Spider-Man 2', 'Astro Bot', 'Helldivers 2', 'Gran Turismo 7'],
    'PlayStation 4': ['Bloodborne', 'God of War', 'The Last of Us Part II', 'Ghost of Tsushima'],
    'Xbox Series X|S': ['Forza Horizon 5', 'Halo Infinite', 'Sea of Thieves', 'Starfield'],
    'Xbox One': ['Minecraft', 'Rocket League', 'Halo 5', 'Forza Motorsport 7'],
    'Nintendo Switch': ['The Legend of Zelda', 'Animal Crossing', 'Splatoon 3', 'Mario Kart 8'],
    'Steam Deck': ['Hades II', 'Balatro', 'Stardew Valley', 'Elden Ring'],
    'Samsung Galaxy': ['Genshin Impact', 'PUBG Mobile', 'Call of Duty Mobile', 'Roblox'],
  };

  K.screens.console = {
    title: 'Console RPC',
    render() {
      const c = K.get('console', {});
      const selected = c.selected || null;
      const games = GAMES[c.device] || GAMES['PlayStation 5'];
      return `<div class="page">
        ${rpcHeader('console', 'Console RPC', 'Bring the couch into your card.')}
        ${statusCard('console', c.connected ? 'Console connected' : 'Console RPC', c.connected ? 'Ready to show a game.' : 'Choose a device, then a game.')}
        <div class="card soft" style="margin-bottom:14px">
          <div class="card-row"><div class="feature-icon" style="width:44px;height:44px;background:var(--surface-2);color:var(--primary)">${K.icon('gamepad')}</div><div style="flex:1"><div class="card-title" style="font-size:0.8125rem">${K.esc(c.device || 'PlayStation 5')}</div><div class="card-sub">${c.connected ? 'Console presence is ready' : 'Browsers cannot scan your console network'}</div></div><button class="btn btn-ghost btn-sm" data-action="console-connect">${c.connected ? 'Disconnect' : 'Connect'}</button></div>
          <div class="field-hint mt-12">Use Connect to mark this console ready, or run Kizzey Android for automatic console detection.</div>
        </div>
        ${sec('console-device', 'Device', 'Where you are playing', 'tv', `<div class="chips">${CONSOLES.map(d => `<button class="chip-toggle ${c.device === d ? 'active' : ''}" data-action="select-console" data-device="${K.esc(d)}">${K.esc(d)}</button>`).join('')}</div>`, { open: true })}
        ${sec('console-game', 'Game', 'What is in the disc tray', 'gamepad',
          `${K.field({ label: 'Game name', path: 'console.game', value: c.game, placeholder: 'Choose a game or type one' })}
           <div class="chips">${games.map(g => `<button class="chip-toggle ${c.game === g ? 'active' : ''}" data-action="select-game" data-game="${K.esc(g)}">${K.esc(g)}</button>`).join('')}</div>
           ${imageField({ label: 'Game artwork', urlPath: 'console.selected.art', assetPath: 'console.selected.art', target: 'console-art', hint: 'Optional artwork for the Discord card.' })}`,
          { open: true })}
        <div class="field-hint" style="margin:0 3px 14px">Console presence is manual in the browser. The Android build can detect a connected console through its own plugins.</div>
        ${rpcDock('console', 'Start Console RPC')}
      </div>`;
    },
    onModelChange(path, value) {
      if (path === 'console.game') {
        if (!K.get('console.selected')) K.setLocal('console.selected', { title: value, art: '' });
        else K.setLocal('console.selected.title', value);
      }
    },
  };

  K.actions['select-console'] = async el => {
    const device = el.dataset.device;
    K.setLocal('console.device', device);
    await K.queuePatch({ console: { device } }, 0);
    K.render();
  };
  K.actions['select-game'] = async el => {
    const game = el.dataset.game;
    K.setLocal('console.game', game);
    K.setLocal('console.selected', { ...(K.get('console.selected') || {}), title: game });
    await K.queuePatch({ console: { game, selected: { ...(K.get('console.selected') || {}), title: game } } }, 0);
    K.render();
  };
  K.actions['console-connect'] = async () => {
    const connected = !K.get('console.connected', false);
    K.setLocal('console.connected', connected);
    await K.queuePatch({ console: { connected } }, 0);
    K.toast(connected ? 'Console ready' : 'Console disconnected', connected ? 'Pick a game when you are ready.' : '', connected ? 'ok' : '');
    K.render();
  };

  // ---------------------------------------------------------------------
  // experimental
  // ---------------------------------------------------------------------
  K.screens.experimental = {
    title: 'Experimental RPC',
    render() {
      const x = K.get('experimental', {});
      const sources = x.sources || [];
      const sourceOptions = [
        { id: 'apps', label: 'Apps', icon: 'layout-grid' },
        { id: 'media', label: 'Media', icon: 'music' },
      ];
      return `<div class="page">
        ${rpcHeader('experimental', 'Experimental RPC', 'Let the card switch with you.')}
        ${statusCard('experimental', 'Experimental RPC', 'Mix apps and media in one presence.')}
        <div class="card soft" style="margin-bottom:14px">
          <div class="card-row"><div class="feature-icon" style="width:42px;height:42px;background:color-mix(in srgb,var(--warn) 14%,var(--surface-2));color:var(--warn)">${K.icon('wand-sparkles')}</div><div><div class="card-title" style="font-size:0.8125rem">Automatic fallback</div><div class="card-sub">When both sources are on, an active app wins. Media takes over when no app is available.</div></div></div>
        </div>
        ${K.sectionLabel('Sources')}
        <div class="feature-grid" style="grid-template-columns:1fr 1fr">
          ${sourceOptions.map(o => `<button class="feature-tile ${sources.includes(o.id) ? 'running' : ''}" data-action="toggle-source" data-path="experimental.sources" data-value="${o.id}" style="min-height:112px;--tile-fg:var(--primary);--tile-bg:var(--surface-2)">
            <div class="feature-icon">${K.icon(o.icon)}</div><div><div class="feature-name">${o.label}</div><div class="feature-desc">${o.id === 'apps' ? 'Use the selected App Detection entry' : 'Use the current Media RPC track'}</div></div><div class="feature-status">${sources.includes(o.id) ? 'Included' : 'Off'}</div>
          </button>`).join('')}
        </div>
        ${K.settingGroup('Switching',
          `${K.segmented('experimental.mode', x.mode, [{ value: 'switch', label: 'Switch automatically' }, { value: 'prefer', label: 'Prefer one' }], { primary: true })}
           <div class="field mt-12"><label>Switch interval <span class="optional" style="font-size:0.625rem">seconds</span></label><input class="input" type="range" min="5" max="120" step="5" data-model="experimental.interval" data-type="number" value="${K.esc(x.interval)}"><div class="field-hint">${x.interval}s between automatic checks in switch mode.</div></div>
           ${K.select({ label: 'Presence status', path: 'experimental.status', value: x.status, options: STATUSES })}
           ${K.select({ label: 'Activity type', path: 'experimental.type', value: x.type ?? -1, options: [{ value: -1, label: 'Automatic' }, ...TYPES] })}`
        )}
        <div class="setting-group">
          ${K.toggleRow({ title: 'Show when sources are empty', desc: 'Keep a quiet fallback card instead of clearing the presence', path: 'experimental.showWhenEmpty', checked: x.showWhenEmpty, icon: 'eye' })}
        </div>
        <div class="field-hint" style="padding:0 4px 16px">Apps and media are chosen from their own screens. Configure both first for the best results.</div>
        ${rpcDock('experimental', 'Start Experimental RPC')}
      </div>`;
    },
  };

  // ---------------------------------------------------------------------
  // cycling
  // ---------------------------------------------------------------------
  K.screens.cycling = {
    title: 'RPC Cycling',
    render() {
      const c = K.get('cycling', {});
      const types = (c.types || []).map(Number);
      return `<div class="page">
        ${rpcHeader('cycling', 'RPC Cycling', 'One card, several moods.')}
        ${statusCard('cycling', 'RPC Cycling', 'Uses your Custom RPC card and rotates its type.')}
        <div class="preview-wrap">${customPreview(K.get('custom', {}), { fallbackName: 'RPC Cycling' })}</div>
        ${K.settingGroup('Rhythm',
          `${K.segmented('cycling.mode', c.mode, [{ value: 'cycle', label: 'Cycle automatically' }, { value: 'manual', label: 'Manual only' }], { primary: true })}
           <div class="field mt-12"><label>Interval <span class="optional" style="font-size:0.625rem">seconds</span></label><input class="input" type="range" min="15" max="180" step="5" data-model="cycling.interval" data-type="number" value="${K.esc(c.interval)}"><div class="field-hint" id="cycle-interval-hint">${c.interval}s between activity types.</div></div>`
        )}
        ${K.sectionLabel('Types in rotation')}
        <div class="chips" style="margin-bottom:16px">
          ${TYPES.map(t => `<button class="chip-toggle ${types.includes(Number(t.value)) ? 'active' : ''}" data-action="toggle-source-number" data-path="cycling.types" data-value="${t.value}">${K.esc(t.label)}</button>`).join('')}
        </div>
        ${K.field({ label: 'Stream URL', path: 'cycling.streamUrl', value: c.streamUrl, type: 'url', placeholder: 'https://twitch.tv/…', hint: 'Used when Streaming is one of the cycling types.' })}
        <div class="card soft" style="margin-bottom:14px">
          <div class="card-row"><div class="feature-icon" style="width:40px;height:40px;background:var(--surface-2);color:var(--primary)">${K.icon('edit')}</div><div style="flex:1"><div class="card-title" style="font-size:0.8125rem">The card itself</div><div class="card-sub">Name, details, state and artwork come from Custom RPC.</div></div><button class="btn btn-ghost btn-sm" data-route="custom">Edit card</button></div>
        </div>
        ${rpcDock('cycling', 'Start Cycling')}
      </div>`;
    },
    onModelChange(path, value) {
      if (path === 'cycling.interval') {
        const hint = document.getElementById('cycle-interval-hint');
        if (hint) hint.textContent = `${value}s between activity types.`;
      }
    },
  };

  // ---------------------------------------------------------------------
  // multiple
  // ---------------------------------------------------------------------
  const MULTI_OPTIONS = [
    { id: 'custom', label: 'Custom RPC', icon: 'sparkles', state: () => K.get('custom.name') ? 'Ready' : 'Needs a name' },
    { id: 'apps', label: 'App Detection', icon: 'layout-grid', state: () => K.get('apps.selected') ? K.get('apps.selected.title') : 'Needs an app' },
    { id: 'media', label: 'Media RPC', icon: 'music', state: () => K.get('media.track.title') || 'No track' },
    { id: 'console', label: 'Console RPC', icon: 'gamepad', state: () => K.get('console.game') || 'No game' },
    { id: 'health', label: 'Health', icon: 'heart-pulse', state: () => `${K.get('health.steps', 0)} steps` },
    { id: 'location', label: 'Location', icon: 'map-pin', state: () => K.get('location.place') || 'No place' },
    { id: 'weather', label: 'Weather', icon: 'cloud-sun', state: () => K.get('weather.last.desc') || 'No weather' },
    { id: 'navigation', label: 'Navigation', icon: 'navigation', state: () => K.get('navigation.destination') || 'No destination' },
    { id: 'screen_read', label: 'Screen Read', icon: 'scan', state: () => K.get('screenRead.lastText') ? 'Screen captured' : 'No screen yet' },
    { id: 'emulation', label: 'Emulation', icon: 'disc', state: () => K.get('emulation.game') || 'No game' },
  ];

  K.screens.multiple = {
    title: 'Multiple RPC',
    render() {
      const m = K.get('multiple', {});
      const sources = m.sources || [];
      const first = sources.find(s => {
        const opt = MULTI_OPTIONS.find(o => o.id === s);
        if (!opt) return false;
        const text = opt.state();
        return !/^(Needs|No )/.test(text);
      });
      return `<div class="page">
        ${rpcHeader('multiple', 'Multiple RPC', 'Several activities, one card.')}
        ${statusCard('multiple', 'Multiple RPC', 'Stack more than one source.')}
        <div class="card soft" style="margin-bottom:14px">
          <div class="card-row"><div class="feature-icon" style="width:42px;height:42px;background:var(--surface-2);color:var(--primary)">${K.icon('layers')}</div><div><div class="card-title" style="font-size:0.8125rem">Pick your stack</div><div class="card-sub">Sources are evaluated top to bottom. Broken or empty sources are skipped.</div></div></div>
        </div>
        <div class="list">
          ${MULTI_OPTIONS.map(o => {
            const active = sources.includes(o.id);
            const status = o.state();
            return `<button class="list-item" data-action="toggle-source" data-path="multiple.sources" data-value="${o.id}" style="${active ? 'border-color:color-mix(in srgb,var(--primary) 35%,transparent);background:color-mix(in srgb,var(--primary) 5%,var(--surface-1))' : ''}">
              <span class="list-icon">${K.icon(o.icon)}</span>
              <span class="list-body"><span class="list-title">${o.label}</span><span class="list-desc">${K.esc(status)}</span></span>
              <span class="list-end">${active ? K.icon('check-circle', 'sm') : `<span class="tiny muted">Add</span>`}</span>
            </button>`;
          }).join('')}
        </div>
        ${K.field({ label: 'Stack note', path: 'multiple.comments', value: m.comments, type: 'textarea', rows: 2, placeholder: 'Optional note for yourself', cls: 'mt-16' })}
        ${first ? `<div class="preview-wrap">${K.presencePreview({ name: MULTI_OPTIONS.find(o => o.id === first)?.label, details: 'First source in the stack', state: MULTI_OPTIONS.find(o => o.id === first)?.state() }, { artUrl: K.presenceArt({ kind: first }), appIcon: '/icon.png', appName: 'Kizzey' })}</div>` : ''}
        <div class="field-hint" style="padding:0 4px 16px">${sources.length < 2 ? 'Add at least two sources for a true multiple presence.' : `Currently stacking ${sources.length} sources.`}</div>
        ${rpcDock('multiple', 'Start Multiple RPC')}
      </div>`;
    },
  };

  // ---------------------------------------------------------------------
  // quick controls page
  // ---------------------------------------------------------------------
  K.screens.quick = {
    title: 'Quick Controls',
    render() {
      const qc = K.get('quickControls', {});
      const status = K.get('settings.rpcStatus', 'online');
      const p = K.currentPresence();
      return `<div class="page">
        ${K.pageHead({ title: 'Quick Controls', sub: 'A small card for small moments.', actions: `<button class="icon-btn" data-action="quick-controls" aria-label="Open pop-up">${K.icon('rows', 'sm')}</button>` })}
        <div class="quick-sheet-status">
          <div class="qs-icon">${K.icon(p ? (K.presenceKinds[p.kind]?.icon || 'activity') : 'sparkles')}</div>
          <div style="flex:1;min-width:0"><div class="qs-title">${p ? K.esc(p.title) : 'No presence running'}</div><div class="qs-sub">${p ? K.esc(p.subtitle || K.presenceKinds[p.kind]?.label) : 'Start something small, right here.'}</div></div>
          ${p ? '<span class="badge good">Live</span>' : ''}
        </div>
        <div class="preview-wrap" id="quick-preview">${customPreview(Object.assign({}, qc, { timestampsStart: String(Date.now()) }), { fallbackName: 'Quick RPC', appName: 'Kizzey' })}</div>
        <div class="setting-group-title">Presence</div>
        <div class="setting-group">
          ${K.toggleRow({ title: 'Use quick card', desc: 'Start a custom card from the fields below', path: 'quickControls.showCustom', checked: qc.showCustom, icon: 'zap' })}
          <div class="setting-row vertical">
            <div class="setting-body"><div class="setting-title">Status</div><div class="setting-desc">Online, idle, DND or invisible</div></div>
            ${K.segmented('settings.rpcStatus', status, STATUSES)}
          </div>
          ${K.select({ label: 'Activity type', path: 'quickControls.type', value: qc.type ?? '0', options: TYPES })}
          ${K.field({ label: 'Name', path: 'quickControls.name', value: qc.name, placeholder: 'What are you doing?' })}
          <div class="two-col">
            ${K.field({ label: 'Details', path: 'quickControls.details', value: qc.details, placeholder: 'A little more' })}
            ${K.field({ label: 'State', path: 'quickControls.state', value: qc.state, placeholder: 'Optional' })}
          </div>
        </div>
        <div class="setting-group">
          ${K.toggleRow({ title: 'Keep gateway alive', desc: 'Retry the Discord socket while the Python server is running', path: 'settings.keepAlive', checked: K.get('settings.keepAlive', true), icon: 'battery-plus' })}
          ${K.toggleRow({ title: 'Notifications', desc: 'Show browser notifications for new chat messages', path: 'settings.notifications', checked: K.get('settings.notifications', true), icon: 'bell' })}
        </div>
        <div class="card soft">
          <div class="card-row"><div class="feature-icon" style="width:40px;height:40px;background:var(--surface-2);color:var(--primary)">${K.icon('panel-left')}</div><div style="flex:1"><div class="card-title" style="font-size:0.8125rem">The Kizzey pop-up</div><div class="card-sub">On Android this appears above other apps. On the web, open it as a sheet from home.</div></div><button class="btn btn-ghost btn-sm" data-action="quick-controls">Open</button></div>
        </div>
        <div style="height:4px"></div>
        <div class="action-dock">
          <button class="btn btn-primary" data-action="quick-start">${K.icon('play', 'sm')}Start quick RPC</button>
          <button class="btn btn-ghost" data-action="stop-all">${K.icon('stop', 'sm')}Stop all</button>
        </div>
      </div>`;
    },
    mount() {
      K.afterModelChange = path => {
        if (path.startsWith('quickControls.')) {
          const el = document.getElementById('quick-preview');
          if (el) el.innerHTML = customPreview(Object.assign({}, K.get('quickControls', {}), { timestampsStart: String(Date.now()) }), { fallbackName: 'Quick RPC' });
        }
      };
    },
    onModelChange(path) {
      if (path.startsWith('quickControls.')) {
        const el = document.getElementById('quick-preview');
        if (el) el.innerHTML = customPreview(Object.assign({}, K.get('quickControls', {}), { timestampsStart: String(Date.now()) }), { fallbackName: 'Quick RPC' });
      }
    },
  };

  K.rpcDock = rpcDock;
  K.rpcHeader = rpcHeader;
  K.rpcStatusCard = statusCard;
  K.rpcSection = sec;
  K.imageField = imageField;
  K.imageUrl = imageUrl;

  // ---------------------------------------------------------------------
  // shared list/array toggles
  // ---------------------------------------------------------------------
  K.actions['toggle-source'] = async function (el) {
    const path = el.dataset.path;
    const value = el.dataset.value;
    if (!path || !value) return;
    const current = K.clone(K.get(path, []) || []);
    const idx = current.indexOf(value);
    if (idx >= 0) current.splice(idx, 1); else current.push(value);
    K.setLocal(path, current);
    await K.queuePatch(K.patchObject(path, current), 0);
    K.render();
  };

  K.actions['toggle-source-number'] = async function (el) {
    const path = el.dataset.path;
    const value = Number(el.dataset.value);
    const current = (K.clone(K.get(path, []) || [])).map(Number);
    const idx = current.indexOf(value);
    if (idx >= 0) { if (current.length > 1) current.splice(idx, 1); }
    else current.push(value);
    K.setLocal(path, current);
    await K.queuePatch(K.patchObject(path, current), 0);
    K.render();
  };
})();
