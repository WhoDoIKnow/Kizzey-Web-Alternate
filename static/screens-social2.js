/* Kizzey Web — gallery, friends, profile, usage, history, wallet and premium */
(function () {
  'use strict';
  const K = window.K;
  const h = K.esc;

  function card(title, sub, body, opts = {}) {
    return `<section class="card ${opts.cls || ''}" style="margin-bottom:14px;${opts.style || ''}">
      ${title ? `<div class="card-row" style="margin-bottom:12px"><div><div class="card-title">${title}</div>${sub ? `<div class="card-sub">${sub}</div>` : ''}</div>${opts.end || ''}</div>` : ''}
      ${body}
    </section>`;
  }

  function head(title, sub, actions = '') {
    return K.pageHead({ title, sub, actions });
  }

  function kindMeta(kind) {
    return K.presenceKinds[kind] || { label: 'Presence', icon: 'sparkles', color: '#d0bcff' };
  }

  // ---------------------------------------------------------------------
  // gallery
  // ---------------------------------------------------------------------
  const GALLERY_GRADIENTS = [
    'linear-gradient(135deg,#342748,#7b4f7c)',
    'linear-gradient(135deg,#1d3340,#3f7280)',
    'linear-gradient(135deg,#3b2432,#894d65)',
    'linear-gradient(135deg,#25332a,#5f8068)',
    'linear-gradient(135deg,#332d20,#8c7442)',
  ];

  K.galleryItems = function galleryItems() {
    const gallery = K.get('gallery', {});
    const liked = gallery.liked || [];
    const staticItems = (K.presetLibrary || []).map((preset, index) => ({
      id: 'library-' + index,
      index,
      name: preset.name,
      tag: preset.tag,
      emoji: preset.emoji,
      gradient: preset.gradient,
      custom: preset.custom,
      author: 'Kizzey',
      description: preset.custom?.details || 'Community preset',
      baseLikes: 28 + index * 17,
      liked: liked.includes('library-' + index),
      source: 'library',
    }));
    const saved = (K.get('savedConfigs', []) || []).map((preset, index) => ({
      id: 'saved-' + (preset.id || index),
      name: preset.name || preset.custom?.name || 'Saved preset',
      tag: 'Yours',
      emoji: '✦',
      gradient: GALLERY_GRADIENTS[index % GALLERY_GRADIENTS.length],
      custom: preset.custom || preset,
      author: 'You',
      description: preset.custom?.details || 'Saved on this server',
      baseLikes: 0,
      liked: liked.includes('saved-' + (preset.id || index)),
      source: 'saved',
      savedId: preset.id,
    }));
    const submitted = (gallery.submitted || []).map((item, index) => ({
      id: item.id,
      name: item.name || item.custom?.name || 'Shared card',
      tag: item.tag || 'Community',
      emoji: item.emoji || '✨',
      gradient: item.gradient || GALLERY_GRADIENTS[(index + 1) % GALLERY_GRADIENTS.length],
      custom: item.custom || {},
      author: item.author || 'You',
      description: item.description || item.custom?.details || 'Shared from this server',
      baseLikes: item.likes || 0,
      liked: liked.includes(item.id),
      source: 'submitted',
    }));
    return [...submitted, ...saved, ...staticItems];
  };

  K.screens.gallery = {
    title: 'Preset Gallery',
    render() {
      const gallery = K.get('gallery', {});
      const items = K.galleryItems();
      const filter = gallery.filter || 'all';
      const filters = ['all', 'music', 'gaming', 'focus', 'yours'];
      const visible = items.filter(item => {
        if (filter === 'all') return true;
        if (filter === 'yours') return item.author === 'You' || item.source !== 'library';
        if (filter === 'music') return /music|listening/i.test(item.tag + ' ' + item.name);
        if (filter === 'gaming') return /game/i.test(item.tag + ' ' + item.name);
        if (filter === 'focus') return /focus|quiet|dev/i.test(item.tag + ' ' + item.name);
        return true;
      });
      return `<div class="page">
        ${head('Preset Gallery', 'Cards worth borrowing.', `<button class="icon-btn" data-action="gallery-submit" aria-label="Share a preset">${K.icon('plus')}</button>`)}
        <div class="gallery-hero" style="margin-bottom:14px">
          <div class="gh-art">✨</div>
          <div class="gh-body"><div class="tiny" style="text-transform:uppercase;letter-spacing:.1em;font-weight:700;color:var(--primary)">Kizzey gallery</div><h2>Find a mood.<br>Make it yours.</h2><p>${items.length} cards from the bundled library and this server.</p></div>
        </div>
        <div class="chips" style="margin-bottom:14px">${filters.map(value => `<button class="chip-toggle ${filter === value ? 'active' : ''}" data-action="gallery-filter" data-filter="${value}">${value === 'all' ? 'All' : value === 'yours' ? 'Your cards' : value[0].toUpperCase() + value.slice(1)}</button>`).join('')}</div>
        ${visible.length ? `<div class="gallery-grid">${visible.map(item => `<div class="gallery-card">
          <div class="gallery-art" style="background:${h(item.gradient)}"><span class="gtag">${h(item.tag)}</span><span class="ge">${h(item.emoji)}</span></div>
          <div class="gallery-body">
            <div class="gallery-name">${h(item.name)}</div>
            <div class="gallery-sub">${h(item.author)} · ${h(item.description)}</div>
            <div class="gallery-stats"><span>♥ ${item.baseLikes + (item.liked ? 1 : 0)}</span><span>·</span><span>${h(item.source === 'library' ? 'bundled' : 'this server')}</span></div>
            <div class="card-row" style="margin-top:9px;gap:5px">
              <button class="btn btn-primary btn-sm" style="flex:1;min-height:34px;padding:6px 9px" data-action="gallery-use" data-id="${h(item.id)}">Use</button>
              <button class="icon-btn small" data-action="gallery-like" data-id="${h(item.id)}" aria-label="Like">${K.icon(item.liked ? 'heart' : 'heart-pulse', 'sm')}</button>
              <button class="icon-btn small" data-action="gallery-share" data-id="${h(item.id)}" aria-label="Share">${K.icon('share', 'sm')}</button>
            </div>
          </div>
        </div>`).join('')}</div>` : K.empty('images', 'Nothing in this filter', 'Try another tag, or share a card of your own.', `<button class="btn btn-primary" data-action="gallery-submit">${K.icon('plus', 'sm')}Share a preset</button>`)}
        <div class="field-hint" style="padding:16px 5px">Bundled cards are local. Your shared cards and likes are persisted in data/state.json. Applying a card never starts a presence by itself.</div>
        <div style="height:20px"></div>
      </div>`;
    },
  };

  K.actions['gallery-filter'] = async el => {
    const filter = el.dataset.filter || 'all';
    K.setLocal('gallery.filter', filter);
    await K.queuePatch({ gallery: { filter } }, 0);
    K.render();
  };

  K.actions['gallery-like'] = async el => {
    const id = el.dataset.id;
    const liked = K.clone(K.get('gallery.liked', []) || []);
    const idx = liked.indexOf(id);
    if (idx >= 0) liked.splice(idx, 1); else liked.push(id);
    K.setLocal('gallery.liked', liked);
    await K.queuePatch({ gallery: { liked } }, 0);
    K.render({ preserveScroll: true });
  };

  K.actions['gallery-use'] = async el => {
    const item = K.galleryItems().find(row => row.id === el.dataset.id);
    if (!item) return;
    const next = Object.assign({}, K.get('custom', {}), K.clone(item.custom || {}), {
      name: item.custom?.name || item.name,
      timestampsStart: String(Date.now()),
      timestampsStop: '',
      status: K.get('settings.rpcStatus', 'online'),
      platform: K.get('custom.platform', 'android'),
      applicationId: K.get('custom.applicationId', ''),
      largeUrl: item.custom?.largeUrl || '',
      largeImg: item.custom?.largeImg || '',
      smallUrl: item.custom?.smallUrl || '',
      smallImg: item.custom?.smallImg || '',
    });
    K.setLocal('custom', next);
    await K.queuePatch({ custom: next }, 0);
    K.navigate('custom');
    K.toast('Preset loaded', item.name, 'ok');
  };

  K.actions['gallery-share'] = el => {
    const item = K.galleryItems().find(row => row.id === el.dataset.id);
    if (!item) return;
    const text = `${item.name} — ${item.description}\n${item.custom?.details || ''}${item.custom?.state ? '\n' + item.custom.state : ''}\n\nFrom Kizzey Web`;
    K.copy(text, 'Preset text copied');
  };

  K.actions['gallery-submit'] = () => {
    const c = K.get('custom', {});
    if (!c.name) { K.toast('Make a card first', 'The current Custom RPC has no name.', 'error'); return; }
    K.sheet({
      title: 'Share this card',
      subtitle: 'Add it to this server’s gallery.',
      body: `<div class="card soft" style="margin-bottom:14px"><div class="card-row"><div class="feature-icon" style="width:44px;height:44px;background:var(--surface-2);color:var(--primary)">${K.icon('sparkles')}</div><div><div class="card-title">${h(c.name)}</div><div class="card-sub">${h([c.details, c.state].filter(Boolean).join(' · ') || 'Custom card')}</div></div></div></div>
        <div class="field"><label for="gallery-name">Gallery name</label><div class="input-wrap"><input id="gallery-name" class="input" value="${h(c.name)}" maxlength="60"></div></div>
        ${K.field({ id: 'gallery-description', label: 'Short description', value: c.details || '', placeholder: 'A quiet room, one more song' })}
        <div class="field"><label for="gallery-tag">Tag</label><select id="gallery-tag" class="select">${['Community', 'Music', 'Focus', 'Gaming', 'Quiet', 'Travel'].map(tag => `<option value="${tag}">${tag}</option>`).join('')}</select></div>
        <div class="field-hint">The gallery stores the card text and fields, never your Discord token or uploaded images.</div>
        <div class="modal-actions"><button class="btn btn-ghost" data-close-sheet>Cancel</button><button class="btn btn-primary" data-action="gallery-submit-confirm">${K.icon('plus', 'sm')}Add to gallery</button></div>`,
    });
  };

  K.actions['gallery-submit-confirm'] = async () => {
    const name = document.getElementById('gallery-name')?.value.trim();
    const description = document.getElementById('gallery-description')?.value.trim();
    const tag = document.getElementById('gallery-tag')?.value || 'Community';
    if (!name) { K.toast('Name required', '', 'error'); return; }
    const c = K.get('custom', {});
    const custom = {
      name,
      details: description || c.details || '',
      state: c.state || '',
      type: String(c.type ?? '0'),
      largeText: c.largeText || '',
      smallText: c.smallText || '',
    };
    const item = {
      id: 'gallery-' + K.uid(),
      name,
      tag,
      emoji: '✨',
      gradient: GALLERY_GRADIENTS[(K.get('gallery.submitted', []) || []).length % GALLERY_GRADIENTS.length],
      description: description || custom.details,
      custom,
      author: K.get('chatProfile.name', 'You'),
      time: Date.now(),
      likes: 0,
    };
    const submitted = [item, ...(K.get('gallery.submitted', []) || [])].slice(0, 48);
    K.setLocal('gallery.submitted', submitted);
    await K.queuePatch({ gallery: { submitted } }, 0);
    K.closeSheet();
    K.toast('Shared to the gallery', name, 'ok');
    K.render();
  };

  // ---------------------------------------------------------------------
  // trending
  // ---------------------------------------------------------------------
  K.screens.trending = {
    title: 'Trending',
    render() {
      const items = K.galleryItems();
      const presets = items.slice().sort((a, b) => (b.baseLikes + (b.liked ? 1 : 0)) - (a.baseLikes + (a.liked ? 1 : 0))).slice(0, 5);
      const moments = (K.get('chat.moments', []) || []).slice().sort((a, b) => (b.likes || []).length - (a.likes || []).length).slice(0, 3);
      const messages = Object.values(K.get('chat.messages', {}) || {}).flat();
      return `<div class="page">
        ${head('Trending', 'What the room is reaching for.', `<button class="icon-btn" data-action="network-sheet" aria-label="Network">${K.icon('sparkles')}</button>`)}
        <div class="promo-card" style="margin-bottom:16px">
          <div class="promo-glow"></div>
          <span class="plan-badge">RIGHT NOW</span>
          <h2 style="font-size:1.6875rem;letter-spacing:-.04em;margin:14px 0 5px">Small signals,<br>real momentum.</h2>
          <p style="font-size:0.75rem;color:var(--muted);line-height:1.5;margin:0">${messages.length} chat messages · ${moments.length} active moments · ${items.length} shared cards</p>
        </div>
        ${K.sectionLabel('Top presets', `<button class="link-btn" data-route="gallery">Gallery</button>`)}
        <div class="trend-list" style="margin-bottom:16px">${presets.map((item, index) => `<div class="trend-card">
          <div class="trend-rank">${index + 1}</div>
          <div class="trend-art" style="background:${h(item.gradient)}">${h(item.emoji)}</div>
          <div class="trend-body"><div class="trend-title">${h(item.name)}</div><div class="trend-sub">${h(item.description)}</div><div class="trend-meta"><span>♥ ${item.baseLikes + (item.liked ? 1 : 0)}</span><span>${h(item.tag)}</span><span>by ${h(item.author)}</span></div></div>
          <button class="icon-btn small" data-action="gallery-use" data-id="${h(item.id)}" aria-label="Use preset">${K.icon('arrow-right', 'sm')}</button>
        </div>`).join('')}</div>
        ${moments.length ? `${K.sectionLabel('Loudest moments', `<button class="link-btn" data-route="moments">Open moments</button>`)}
          <div style="margin-bottom:16px">${moments.map(moment => `<div class="moment" style="margin-bottom:8px"><div class="moment-head">${K.avatar({ name: moment.author, url: moment.avatar || '', cls: '', style: `background:${moment.color || '#d0bcff'}22;color:${moment.color || '#d0bcff'}` })}<div style="flex:1"><div class="moment-author">${h(moment.author)}</div><div class="moment-time">${h(K.relTime(moment.time))} · ${h(moment.tag || 'moment')}</div></div><span class="badge plain">♥ ${(moment.likes || []).length}</span></div><div class="moment-text">${h(moment.text)}</div></div>`).join('')}</div>` : ''}
        ${K.sectionLabel('Community pulse')}
        <div class="stats-strip" style="margin-bottom:14px">
          <div class="stat-mini"><b>${K.get('chat.rooms', []).reduce((sum, room) => sum + (room.members || 0), 0)}</b><span>Members</span></div>
          <div class="stat-mini"><b>${messages.length}</b><span>Messages</span></div>
          <div class="stat-mini"><b>${(K.get('history', []) || []).length}</b><span>Sessions</span></div>
        </div>
        <div class="quick-grid-2"><button class="btn btn-primary" data-route="chat">${K.icon('message-circle', 'sm')}Join the room</button><button class="btn btn-ghost" data-route="leaderboard">${K.icon('trophy', 'sm')}Leaderboard</button></div>
        <div style="height:20px"></div>
      </div>`;
    },
  };

  // ---------------------------------------------------------------------
  // Discord friends / presences
  // ---------------------------------------------------------------------
  K.friends = K.friends || null;
  K.friendsLoading = false;
  K.friendsTab = K.friendsTab || 'friends';
  K.friendsError = '';

  async function loadFriends(force = false) {
    if (K.friendsLoading) return;
    if (K.friends && !force) return;
    if (!K.isSignedIn()) { K.friends = []; return; }
    K.friendsLoading = true;
    try {
      const data = await K.api('/api/friends');
      K.friends = data.friends || [];
      K.friendsError = '';
    } catch (error) {
      K.friendsError = error.message;
      K.friends = K.friends || [];
    } finally {
      K.friendsLoading = false;
    }
  }

  K.actions['friends-refresh'] = async () => {
    await loadFriends(true);
    if (K.current.route === 'presences') K.render();
  };

  K.screens.presences = {
    title: 'Discord Presences',
    render() {
      const signedIn = K.isSignedIn();
      const friends = K.friends || [];
      const tab = K.friendsTab;
      const typeOf = row => row.type === 1 ? 'friends' : row.type === 3 ? 'incoming' : row.type === 4 ? 'outgoing' : row.type === 2 ? 'blocked' : 'friends';
      const filtered = friends.filter(row => tab === 'friends' ? typeOf(row) === 'friends' : typeOf(row) === tab);
      return `<div class="page">
        ${head('Discord Presences', 'Your people, synced from Discord.', `<button class="icon-btn" data-action="friends-refresh" aria-label="Refresh">${K.icon('refresh')}</button>`)}
        ${!signedIn ? `<div class="card soft" style="margin-bottom:14px"><div class="card-row"><div class="feature-icon" style="width:44px;height:44px;background:var(--surface-2);color:var(--primary)">${K.icon('discord')}</div><div style="flex:1"><div class="card-title">Connect Discord</div><div class="card-sub">Friends and relationship lists come from the account token on your server.</div></div><button class="btn btn-primary btn-sm" data-action="retry-login">Connect</button></div></div>` : ''}
        ${signedIn ? `<div class="segmented" style="margin-bottom:14px">${[['friends', 'Friends'], ['incoming', 'Requests'], ['blocked', 'Blocked']].map(([value, label]) => `<button class="${tab === value ? 'active' : ''}" data-action="friends-tab" data-tab="${value}">${label}</button>`).join('')}</div>` : ''}
        ${signedIn ? `<div class="input-row" style="margin-bottom:12px"><div class="input-wrap" style="flex:1">${K.icon('search', 'sm')}<input id="friend-search" class="input" data-local="friend-search" style="padding-left:38px" placeholder="Find a friend"></div><span class="badge plain">${filtered.length}</span></div>` : ''}
        ${signedIn && K.friendsLoading && !K.friends ? '<div class="loading-line"><span></span></div>' : ''}
        ${signedIn && K.friendsError ? `<div class="card soft" style="border-color:color-mix(in srgb,var(--warn) 28%,transparent)"><div class="card-row"><div class="feature-icon" style="width:40px;height:40px;background:var(--surface-2);color:var(--warn)">${K.icon('wifi-off')}</div><div><div class="card-title">Could not load friends</div><div class="card-sub">${h(K.friendsError)}</div></div></div></div>` : ''}
        ${signedIn && filtered.length ? `<div class="list">${filtered.map(row => {
          const u = row.user || {};
          return `<div class="list-item" data-friend-row data-search="${h(((u.displayName || '') + ' ' + (u.username || '') + ' ' + (row.nickname || '')).toLowerCase())}">
            ${K.avatar({ name: u.displayName || u.username || 'Friend', url: u.avatarUrl || '', cls: '', style: `background:${u.accentColor || '#d0bcff'}22;color:${u.accentColor || '#d0bcff'}` })}
            <span class="list-body"><span class="list-title">${h(u.displayName || u.username || 'Friend')}${row.nickname ? ` <span class="tiny muted">(${h(row.nickname)})</span>` : ''}</span><span class="list-desc">@${h(u.username || 'unknown')} · ${h(typeOf(row))}</span></span>
            <a class="icon-btn small" href="https://discord.com/users/${encodeURIComponent(u.id || '')}" target="_blank" rel="noopener" aria-label="Open in Discord">${K.icon('external-link', 'sm')}</a>
          </div>`;
        }).join('')}</div>` : (signedIn && !K.friendsLoading ? K.empty('users', tab === 'incoming' ? 'No pending requests' : 'No friends to show', tab === 'blocked' ? 'Nothing is blocked.' : 'Discord returned an empty relationship list.', `<button class="btn btn-ghost" data-action="friends-refresh">${K.icon('refresh', 'sm')}Refresh</button>`) : '')}
        <div class="card soft" style="margin-top:14px">
          <div class="card-row"><div class="feature-icon" style="width:40px;height:40px;background:var(--surface-2);color:var(--primary)">${K.icon('info')}</div><div><div class="card-title" style="font-size:0.8125rem">About friend presences</div><div class="card-sub">Discord's relationship endpoint lists your friends but does not include their live activities. The native app reads those from gateway presence events; this web build shows the synced relationship list instead.</div></div></div>
        </div>
        <div class="quick-grid-2" style="margin-top:14px"><button class="btn btn-ghost" data-route="profile">${K.icon('user', 'sm')}Your profile</button><button class="btn btn-ghost" data-route="chat">${K.icon('message-circle', 'sm')}Kizzey chat</button></div>
        <div style="height:20px"></div>
      </div>`;
    },
    mount(root) {
      if (K.isSignedIn() && !K.friends) {
        loadFriends().then(() => { if (K.current.route === 'presences') K.render(); });
      }
      const input = root.querySelector('#friend-search');
      input?.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        root.querySelectorAll('[data-friend-row]').forEach(row => row.classList.toggle('hidden', !!q && !row.dataset.search.includes(q)));
      });
    },
  };

  K.actions['friends-tab'] = el => { K.friendsTab = el.dataset.tab || 'friends'; K.render(); };

  // ---------------------------------------------------------------------
  // profile
  // ---------------------------------------------------------------------
  const PROFILE_COLORS = ['#d0bcff', '#7ee0b8', '#f4b8d1', '#9fd7ff', '#f7c873', '#ff9c9c'];

  K.screens.profile = {
    title: 'Your profile',
    render() {
      const p = K.get('chatProfile', {});
      const messages = Object.values(K.get('chat.messages', {}) || {}).flat().filter(m => m.local).length;
      const moments = (K.get('chat.moments', []) || []).filter(m => (m.author || '') === (p.name || 'You')).length;
      const initials = K.initials(p.name || 'You');
      return `<div class="page">
        ${head('Your profile', 'How you appear around the community.')}
        <div class="account-hero" style="flex-direction:column;text-align:center;gap:12px;padding:8px 0 18px">
          <div style="position:relative">${K.avatar({ name: p.name || 'You', url: p.avatar || '', cls: '', style: `width:86px;height:86px;font-size:1.75rem;background:${p.color || '#d0bcff'}22;color:${p.color || '#d0bcff'}` })}
            <button class="icon-btn small" data-action="profile-avatar" style="position:absolute;right:-3px;bottom:-2px;background:var(--surface-3)" aria-label="Change avatar">${K.icon('camera', 'sm')}</button>
          </div>
          <div><div class="account-name">${h(p.name || 'You')}</div><div class="account-handle">${h(p.note || 'Building a better presence.')}</div>
            <div class="account-meta" style="justify-content:center"><span class="pill">${h(p.badge || 'Member')}</span><span class="pill">${messages} messages</span><span class="pill">${moments} moments</span></div>
          </div>
        </div>
        <div class="stats-strip" style="margin-bottom:14px">
          <div class="stat-mini"><b>${K.get('wallet.kcoin', 0)}</b><span>KCoin</span></div>
          <div class="stat-mini"><b>${(K.get('history', []) || []).length}</b><span>Sessions</span></div>
          <div class="stat-mini"><b>${(K.get('savedConfigs', []) || []).length}</b><span>Presets</span></div>
        </div>
        ${card('Community profile', 'Used in chat, moments and the leaderboard.', `
          ${K.field({ label: 'Display name', path: 'chatProfile.name', value: p.name, placeholder: 'Your name', maxlength: 32 })}
          ${K.field({ label: 'Status note', path: 'chatProfile.note', value: p.note, placeholder: 'A small line about you', maxlength: 80 })}
          <div class="two-col">
            ${K.select({ label: 'Status', path: 'chatProfile.status', value: p.status, options: [{ value: 'online', label: 'Online' }, { value: 'idle', label: 'Idle' }, { value: 'dnd', label: 'Do not disturb' }, { value: 'invisible', label: 'Invisible' }] })}
            ${K.select({ label: 'Badge', path: 'chatProfile.badge', value: p.badge, options: [...new Set(['Member', 'Supporter', 'Artist', 'Builder', 'Listener', p.badge].filter(Boolean))].map(v => ({ value: v, label: v })) })}
          </div>
          <div class="field"><label>Accent colour</label><div class="chips">${PROFILE_COLORS.map(color => `<button class="color-dot ${p.color === color ? 'active' : ''}" style="background:${color}" data-action="profile-color" data-color="${color}" aria-label="${color}"></button>`).join('')}</div></div>
          <div class="card-row" style="gap:7px;margin-top:6px"><button class="btn btn-ghost btn-sm" data-action="profile-avatar">${K.icon('upload', 'sm')}Change avatar</button>${p.avatar ? `<button class="btn btn-ghost btn-sm" data-action="profile-avatar-remove">${K.icon('trash', 'sm')}Remove</button>` : ''}</div>
        `)}
        ${K.isSignedIn() ? card('Discord identity', 'Use your Discord avatar and display name in the community.', `<div class="card-row">${K.avatar({ name: K.displayName(), url: K.avatarUrl(), cls: '' })}<div style="flex:1"><div class="card-title">${h(K.displayName())}</div><div class="card-sub">@${h(K.get('account.username', ''))} · token held by the server</div></div><button class="btn btn-ghost btn-sm" data-action="profile-use-discord">Use</button></div>`) : ''}
        <div class="quick-grid-2" style="margin-top:14px"><button class="btn btn-primary" data-route="chat">${K.icon('message-circle', 'sm')}Open chat</button><button class="btn btn-ghost" data-route="moments">${K.icon('sparkles', 'sm')}Moments</button><button class="btn btn-ghost" data-route="shop">${K.icon('coins', 'sm')}KCoin shop</button><button class="btn btn-ghost" data-route="premium">${K.icon('crown', 'sm')}Kizzey+</button></div>
        <div style="height:20px"></div>
      </div>`;
    },
  };

  K.actions['profile-avatar'] = () => {
    K.bindFilePicker(async file => {
      try {
        const data = await K.uploadDataUrl(file, { localOnly: true });
        K.setLocal('chatProfile.avatar', data.url);
        await K.queuePatch({ chatProfile: { avatar: data.url } }, 0);
        K.toast('Avatar updated', '', 'ok');
        K.render();
      } catch (error) { K.toast('Could not upload avatar', error.message, 'error'); }
    }, 'image/*');
  };

  K.actions['profile-avatar-remove'] = async () => {
    K.setLocal('chatProfile.avatar', '');
    await K.queuePatch({ chatProfile: { avatar: '' } }, 0);
    K.render();
  };

  K.actions['profile-color'] = async el => {
    const color = el.dataset.color;
    K.setLocal('chatProfile.color', color);
    await K.queuePatch({ chatProfile: { color } }, 0);
    K.render();
  };

  K.actions['profile-use-discord'] = async () => {
    const name = K.displayName();
    const avatar = K.avatarUrl();
    K.setLocal('chatProfile.name', name);
    K.setLocal('chatProfile.avatar', avatar);
    await K.queuePatch({ chatProfile: { name, avatar } }, 0);
    K.toast('Profile synced', name, 'ok');
    K.render();
  };

  // ---------------------------------------------------------------------
  // usage stats
  // ---------------------------------------------------------------------
  K.screens.usage = {
    title: 'Usage stats',
    render() {
      const usage = K.get('usage', {}) || {};
      const history = K.get('history', []) || [];
      const live = K.currentPresence();
      const total = Object.values(usage).reduce((sum, value) => sum + K.num(value, 0), 0);
      const seconds = history.reduce((sum, row) => sum + K.num(row.seconds, 0), 0) + (live ? Math.max(0, (Date.now() - (live.startedAt || Date.now())) / 1000) : 0);
      const top = Object.entries(usage).sort((a, b) => b[1] - a[1])[0];
      const max = Math.max(1, ...Object.values(usage).map(value => K.num(value, 0)));
      const kinds = Object.entries(usage).sort((a, b) => b[1] - a[1]);
      return `<div class="page">
        ${head('Usage stats', 'What this server has actually run.', `<button class="icon-btn" data-action="usage-reset" aria-label="Reset stats">${K.icon('refresh')}</button>`)}
        <div class="stats-strip" style="margin-bottom:14px">
          <div class="stat-mini"><b>${total}</b><span>Presences started</span></div>
          <div class="stat-mini"><b>${K.duration(seconds * 1000)}</b><span>Total live time</span></div>
          <div class="stat-mini"><b>${history.length ? Math.round(seconds / history.length / 60) + 'm' : '—'}</b><span>Average session</span></div>
        </div>
        <div class="card soft" style="margin-bottom:14px">
          <div class="card-row between"><div><div class="metric-label">Most used</div><b style="font-size:1.5rem;display:block;margin-top:5px">${h(top ? kindMeta(top[0]).label : 'No sessions yet')}</b><small>${top ? top[1] + ' starts' : 'Start a presence to fill this chart'}</small></div><div class="metric-icon" style="width:46px;height:46px;border-radius:15px;background:var(--surface-2);color:var(--primary)">${K.icon(top ? kindMeta(top[0]).icon : 'bar-chart')}</div></div>
        </div>
        ${kinds.length ? `${K.sectionLabel('Presence types')}<div class="bar-chart" style="margin-bottom:16px">${kinds.map(([kind, count]) => `<div class="bar-row"><span class="bar-label">${h(kindMeta(kind).label)}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.max(4, count / max * 100)}%"></span></span><span class="bar-value">${count}</span></div>`).join('')}</div>` : K.empty('bar-chart', 'No usage yet', 'Every started presence adds to this chart.', `<button class="btn btn-primary" data-route="custom">${K.icon('sparkles', 'sm')}Start a card</button>`)}
        ${history.length ? `${K.sectionLabel('Recent sessions', `<button class="link-btn" data-route="history">All history</button>`)}<div class="timeline">${history.slice(0, 5).map(row => `<div class="timeline-item"><div class="timeline-title">${h(row.title || row.label || 'Presence')}</div><div class="timeline-sub">${h(row.label || kindMeta(row.kind).label)} · ${K.duration(row.seconds * 1000)}</div><div class="timeline-time">${h(K.fmtDateTime(row.startedAt))}</div></div>`).join('')}</div>` : ''}
        <div class="field-hint" style="padding:16px 5px">Counts live in this server's state file. Resetting clears the counters only; history and saved configurations are untouched.</div>
        <div class="quick-grid-2" style="margin-top:4px"><button class="btn btn-ghost" data-route="history">${K.icon('history', 'sm')}Presence history</button><button class="btn btn-ghost" data-route="kizzey-stats">${K.icon('bar-chart', 'sm')}Kizzey stats</button></div>
        <div style="height:20px"></div>
      </div>`;
    },
  };

  K.actions['usage-reset'] = () => {
    K.confirm({
      title: 'Reset usage counters?',
      subtitle: 'History, presences and settings stay intact.',
      confirm: 'Reset counters', danger: true,
      onConfirm: async () => {
        K.setLocal('usage', {});
        await K.queuePatch({ usage: {} }, 0);
        K.toast('Usage counters reset', '', 'ok');
        K.render();
      },
    });
  };

  // ---------------------------------------------------------------------
  // presence history
  // ---------------------------------------------------------------------
  K.historyFilter = K.historyFilter || 'all';

  K.screens.history = {
    title: 'Presence history',
    render() {
      const history = K.get('history', []) || [];
      const live = K.get('presence.active');
      const filter = K.historyFilter;
      const filtered = filter === 'all' ? history : history.filter(row => row.kind === filter);
      const kinds = [...new Set(history.map(row => row.kind))];
      const groups = [];
      for (const row of filtered) {
        const label = new Date(row.endedAt || row.startedAt).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
        let group = groups.find(g => g.label === label);
        if (!group) { group = { label, rows: [] }; groups.push(group); }
        group.rows.push(row);
      }
      return `<div class="page">
        ${head('Presence history', 'The cards you lived in.', `<button class="icon-btn" data-action="history-export" aria-label="Export history">${K.icon('download')}</button>`)}
        ${live ? `<div class="card soft" style="border-color:color-mix(in srgb,var(--good) 24%,transparent);margin-bottom:14px"><div class="card-row"><div class="feature-icon" style="width:42px;height:42px;background:color-mix(in srgb,var(--good) 12%,var(--surface-2));color:var(--good)">${K.icon(kindMeta(live.kind).icon)}</div><div style="flex:1"><div class="card-title">${h(live.title || kindMeta(live.kind).label)}</div><div class="card-sub">Live now · ${h(K.get('presence.info.subtitle', ''))}</div></div><span class="badge good">Live</span></div></div>` : ''}
        ${history.length ? `<div class="chips" style="margin-bottom:14px"><button class="chip-toggle ${filter === 'all' ? 'active' : ''}" data-action="history-filter" data-kind="all">All</button>${kinds.map(kind => `<button class="chip-toggle ${filter === kind ? 'active' : ''}" data-action="history-filter" data-kind="${h(kind)}">${h(kindMeta(kind).label)}</button>`).join('')}</div>` : ''}
        ${groups.length ? groups.map(group => `<div class="section-label"><span>${h(group.label)}</span><span class="tiny muted">${group.rows.length} session${group.rows.length === 1 ? '' : 's'}</span></div><div class="timeline" style="margin-bottom:12px">${group.rows.map(row => `<div class="timeline-item">
          <div class="card-row between"><div class="timeline-title">${h(row.title || row.label || 'Presence')}</div><button class="icon-btn small" data-route="${h(K.routeForKind(row.kind))}" aria-label="Run again">${K.icon('play', 'sm')}</button></div>
          <div class="timeline-sub">${h(row.label || kindMeta(row.kind).label)} · ${K.duration(row.seconds * 1000)}</div>
          <div class="timeline-time">${h(K.fmtTime(row.startedAt))} – ${h(K.fmtTime(row.endedAt))} · ${h(K.fmtDate(row.startedAt))}</div>
        </div>`).join('')}</div>`).join('') : K.empty('history', 'No presence history', 'Start and stop a card and it will appear here.', `<button class="btn btn-primary" data-route="custom">${K.icon('sparkles', 'sm')}Design a card</button>`)}
        <div class="card-row" style="margin-top:14px;gap:8px"><button class="btn btn-ghost btn-sm" data-action="history-export">${K.icon('download', 'sm')}Export JSON</button><button class="btn btn-danger btn-sm" data-action="history-clear" ${history.length ? '' : 'disabled'}>${K.icon('trash', 'sm')}Clear history</button></div>
        <div class="field-hint" style="padding:16px 5px">History entries are written when a presence stops or is replaced. The running card stays pinned above and is not duplicated.</div>
        <div style="height:20px"></div>
      </div>`;
    },
  };

  K.actions['history-filter'] = el => { K.historyFilter = el.dataset.kind || 'all'; K.render(); };

  K.actions['history-clear'] = () => {
    K.confirm({
      title: 'Clear presence history?', subtitle: 'Every saved session entry will be removed.', confirm: 'Clear history', danger: true,
      onConfirm: async () => {
        try {
          const data = await K.api('/api/history/clear', { method: 'POST', body: {} });
          if (data.state) K.receiveState(data.state);
          K.toast('History cleared', '', 'ok');
          K.render();
        } catch (error) { K.toast('Could not clear history', error.message, 'error'); }
      },
    });
  };

  K.actions['history-export'] = () => {
    const history = K.get('history', []) || [];
    K.download(`kizzey-history-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(history, null, 2), 'application/json');
    K.toast('History exported', `${history.length} sessions`, 'ok');
  };

  // ---------------------------------------------------------------------
  // Kizzey stats
  // ---------------------------------------------------------------------
  K.screens['kizzey-stats'] = {
    title: 'Kizzey Stats',
    render() {
      const state = K.state || {};
      const history = state.history || [];
      const usage = state.usage || {};
      const started = state.startedAt || Date.now();
      const messages = Object.values(state.chat?.messages || {}).flat();
      const rooms = state.chat?.rooms || [];
      const totalUsage = Object.values(usage).reduce((sum, v) => sum + K.num(v, 0), 0);
      const topKinds = Object.entries(usage).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const max = Math.max(1, ...topKinds.map(row => row[1]));
      const features = [
        ['custom', 'Custom RPC'], ['media', 'Media RPC'], ['weather', 'Weather'], ['health', 'Health'], ['automation', 'Automation'], ['plugins', 'Plugins'],
      ];
      return `<div class="page">
        ${head('Kizzey Stats', 'A local snapshot of this build.', `<button class="icon-btn" data-action="stats-export" aria-label="Download report">${K.icon('download')}</button>`)}
        <div class="promo-card" style="margin-bottom:14px">
          <div class="promo-glow"></div>
          <span class="plan-badge">LIVE FROM YOUR SERVER</span>
          <h2 style="font-size:1.75rem;letter-spacing:-.04em;margin:14px 0 5px">Kizzey ${h(state.version || '')}</h2>
          <p style="font-size:0.75rem;color:var(--muted);line-height:1.5;margin:0">Up ${h(K.duration(Date.now() - started))} · ${h(K.get('host.model', 'Kizzey Web'))}</p>
        </div>
        <div class="stats-strip" style="margin-bottom:14px">
          <div class="stat-mini"><b>${totalUsage}</b><span>Cards started</span></div>
          <div class="stat-mini"><b>${messages.length}</b><span>Messages</span></div>
          <div class="stat-mini"><b>${history.length}</b><span>Sessions</span></div>
        </div>
        <div class="metric-grid">
          <div class="metric"><div class="metric-icon">${K.icon('wifi')}</div><div><b>${K.get('gateway.connected') ? 'Live' : 'Idle'}</b><small>Discord gateway</small></div><div class="metric-label">${K.get('gateway.latency') != null ? K.get('gateway.latency') + ' ms' : 'No latency'}</div></div>
          <div class="metric"><div class="metric-icon">${K.icon('server')}</div><div><b>${h(K.get('host.device') || 'Web')}</b><small>Server host</small></div><div class="metric-label">${h(K.get('host.platform', ''))}</div></div>
          <div class="metric"><div class="metric-icon">${K.icon('users')}</div><div><b>${rooms.reduce((sum, room) => sum + (room.members || 0), 0)}</b><small>Network members</small></div><div class="metric-label">${rooms.length} rooms</div></div>
          <div class="metric"><div class="metric-icon">${K.icon('coins')}</div><div><b>${K.get('wallet.kcoin', 0)}</b><small>KCoin</small></div><div class="metric-label">${h(K.get('premium.tier', 'free'))} tier</div></div>
        </div>
        ${topKinds.length ? card('Feature adoption', 'Counts since this state file was created.', `<div class="bar-chart">${topKinds.map(([kind, count]) => `<div class="bar-row"><span class="bar-label">${h(kindMeta(kind).label)}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.max(4, count / max * 100)}%"></span></span><span class="bar-value">${count}</span></div>`).join('')}</div>`) : ''}
        ${K.sectionLabel('This build')}
        <div class="setting-group">
          <div class="setting-row"><div class="setting-icon">${K.icon('info')}</div><div class="setting-body"><div class="setting-title">Version ${h(state.version || '')}</div><div class="setting-desc">Kizzey Web · ${h(K.get('host.android') ? 'Android host' : 'server build')}</div></div></div>
          <div class="setting-row"><div class="setting-icon">${K.icon('image')}</div><div class="setting-body"><div class="setting-title">${(state.gallery?.submitted || []).length} gallery submissions</div><div class="setting-desc">${(state.savedConfigs || []).length} private presets · ${Object.keys(state.appCatalog || {}).length} app catalogue entries</div></div></div>
          <div class="setting-row"><div class="setting-icon">${K.icon('message-circle')}</div><div class="setting-body"><div class="setting-title">${(state.chat?.moments || []).length} moments</div><div class="setting-desc">${messages.filter(m => m.local).length} messages authored here</div></div></div>
          <div class="setting-row"><div class="setting-icon">${K.icon('database')}</div><div class="setting-body"><div class="setting-title">Local data</div><div class="setting-desc">State, token, uploads, logs and history live in data/ next to server.py</div></div><button class="btn btn-ghost btn-sm" data-route="backup">Backup</button></div>
        </div>
        <div class="quick-grid-2" style="margin-top:14px"><button class="btn btn-ghost" data-route="shizuku">${K.icon('activity', 'sm')}Host tools</button><button class="btn btn-ghost" data-route="usage">${K.icon('bar-chart', 'sm')}Usage charts</button><button class="btn btn-ghost" data-route="logs">${K.icon('terminal', 'sm')}Logs</button><button class="btn btn-ghost" data-route="about">${K.icon('info', 'sm')}About</button></div>
        <div style="height:20px"></div>
      </div>`;
    },
  };

  K.actions['stats-export'] = () => {
    const report = {
      generatedAt: new Date().toISOString(),
      version: K.get('version'),
      uptimeSeconds: Math.round((Date.now() - (K.get('startedAt') || Date.now())) / 1000),
      usage: K.get('usage', {}),
      historyCount: (K.get('history', []) || []).length,
      savedConfigs: (K.get('savedConfigs', []) || []).length,
      gallerySubmissions: (K.get('gallery.submitted', []) || []).length,
      wallet: K.get('wallet', {}),
      gateway: K.get('gateway', {}),
      host: K.get('host', {}),
    };
    K.download(`kizzey-stats-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(report, null, 2));
    K.toast('Stats report downloaded', '', 'ok');
  };

  // ---------------------------------------------------------------------
  // KCoin shop
  // ---------------------------------------------------------------------
  const SHOP_ITEMS = [
    { id: 'aurora', name: 'Aurora', price: 0, kind: 'Theme', color: '#d0bcff', emoji: '🌌', desc: 'The default lavender glow.' },
    { id: 'sunset', name: 'Sunset rail', price: 180, kind: 'Theme', color: '#f0a6ca', emoji: '🌅', desc: 'Warm rose across the rail.' },
    { id: 'ocean', name: 'Deep ocean', price: 180, kind: 'Theme', color: '#7dd3fc', emoji: '🌊', desc: 'Cool blue surfaces.' },
    { id: 'violet', name: 'Violet hour', price: 240, kind: 'Theme', color: '#c4b5fd', emoji: '🌆', desc: 'The lavender after dark.' },
    { id: 'badge-flame', name: 'Flame badge', price: 120, kind: 'Badge', emoji: '🔥', badge: 'Flame', desc: 'A small flame on your profile.' },
    { id: 'badge-star', name: 'Star badge', price: 120, kind: 'Badge', emoji: '✦', badge: 'Star', desc: 'A quiet constellation.' },
    { id: 'bubble-soft', name: 'Soft bubble', price: 90, kind: 'Chat', emoji: '🫧', desc: 'A softer chat accent.' },
  ];

  K.screens.shop = {
    title: 'KCoin Shop',
    render() {
      const wallet = K.get('wallet', {});
      const inventory = wallet.inventory || [];
      const daily = wallet.daily ? Math.max(0, 20 * 3600 * 1000 - (Date.now() - wallet.daily)) : 0;
      return `<div class="page">
        ${head('KCoin Shop', 'Little things, earned locally.')}
        <div class="wallet-card" style="margin-bottom:14px">
          <div class="card-row between"><div><div class="tiny" style="color:rgba(255,255,255,.55);text-transform:uppercase;letter-spacing:.1em;font-weight:700">Your wallet</div><div class="wallet-balance">${K.num(wallet.kcoin, 0).toLocaleString()} <span>KCoin</span></div><div class="tiny" style="color:rgba(255,255,255,.55)">${wallet.streak || 0} day streak</div></div><div class="wallet-coin">◈</div></div>
          <button class="btn wallet-claim" data-action="shop-daily">${K.icon('gift', 'sm')}${daily ? `Next reward in ${Math.ceil(daily / 3600000)}h` : 'Claim daily KCoin'}</button>
        </div>
        <div class="segmented" style="margin-bottom:14px"><button class="active">Themes & badges</button></div>
        <div class="shop-grid">${SHOP_ITEMS.map(item => {
          const owned = item.id === 'aurora' || inventory.includes(item.id);
          const active = item.kind === 'Theme'
            ? K.get('settings.accent') === item.color
            : item.kind === 'Badge'
              ? K.get('chatProfile.badge') === item.badge
              : item.kind === 'Chat' && K.get('settings.chatBubble') === 'soft';
          const action = !owned ? 'shop-buy' : item.kind === 'Badge' ? 'shop-equip-badge' : 'shop-use';
          const label = !owned ? `Unlock · ${item.price} ◈` : active ? (item.kind === 'Badge' ? 'Remove badge' : item.kind === 'Chat' ? 'Turn off' : 'Equipped') : item.kind === 'Theme' ? 'Use theme' : item.kind === 'Badge' ? 'Equip badge' : 'Use bubble';
          return `<div class="shop-item">
            <div class="shop-art" style="background:${item.color ? `linear-gradient(135deg,${item.color}33,${item.color}12)` : 'var(--surface-2)'}">${item.emoji}</div>
            <div class="shop-name">${h(item.name)}</div>
            <div class="shop-kind">${h(item.kind)}</div>
            <div class="shop-price">${owned ? 'Owned' : item.price ? item.price + ' ◈' : 'Free'}</div>
            <button class="btn ${active ? 'btn-primary' : owned ? 'btn-ghost' : 'btn-tonal'} btn-sm btn-block" data-action="${action}" data-id="${item.id}" ${active && item.kind === 'Theme' ? 'disabled' : ''}>${label}</button>
          </div>`;
        }).join('')}</div>
        ${K.sectionLabel('Inventory')}
        <div class="chips">${inventory.length ? inventory.map(id => { const item = SHOP_ITEMS.find(i => i.id === id); return `<span class="badge plain">${item ? item.emoji + ' ' + h(item.name) : h(id)}</span>`; }).join('') : '<span class="tiny muted">No cosmetics yet.</span>'}</div>
        <div class="field-hint" style="padding:16px 5px">KCoin is a local cosmetic economy. The daily reward and purchases are persisted in data/state.json; no real payment is involved.</div>
        <div class="quick-grid-2" style="margin-top:4px"><button class="btn btn-ghost" data-route="premium">${K.icon('crown', 'sm')}Kizzey+ demo</button><button class="btn btn-ghost" data-route="profile">${K.icon('user', 'sm')}Your profile</button></div>
        <div style="height:20px"></div>
      </div>`;
    },
  };

  K.actions['shop-daily'] = async () => {
    try {
      const data = await K.api('/api/wallet/daily', { method: 'POST', body: {} });
      if (K.state) K.state.wallet = data.wallet;
      K.toast('Daily reward claimed', `+${data.amount} KCoin`, 'ok');
      K.render();
    } catch (error) {
      K.toast('No reward yet', error.message, 'error');
    }
  };

  K.actions['shop-buy'] = el => {
    const item = SHOP_ITEMS.find(i => i.id === el.dataset.id);
    if (!item) return;
    K.confirm({
      title: `Unlock ${item.name}?`,
      subtitle: `${item.price} KCoin · ${item.kind}`,
      confirm: `Unlock for ${item.price} ◈`,
      body: `<div class="card soft"><div class="card-row"><div class="feature-icon" style="width:42px;height:42px;background:var(--surface-2);color:var(--primary)">${item.emoji}</div><div><div class="card-title">${h(item.name)}</div><div class="card-sub">${h(item.desc)}</div></div></div></div>`,
      onConfirm: async () => {
        try {
          const data = await K.api('/api/shop/buy', { method: 'POST', body: { id: item.id } });
          if (K.state) K.state.wallet = data.wallet;
          K.toast('Unlocked', item.name, 'ok');
          K.render();
        } catch (error) {
          K.toast('Purchase failed', error.message, 'error');
        }
      },
    });
  };

  K.actions['shop-use'] = async el => {
    const item = SHOP_ITEMS.find(i => i.id === el.dataset.id);
    if (!item) return;
    if (item.kind === 'Chat') {
      const active = K.get('settings.chatBubble') === 'soft';
      K.setLocal('settings.chatBubble', active ? '' : 'soft');
      await K.queuePatch({ settings: { chatBubble: active ? '' : 'soft' } }, 0);
      K.applyTheme();
      K.toast(active ? 'Bubble turned off' : 'Soft bubble applied', item.name, 'ok');
    } else if (item.color) {
      K.setLocal('settings.accent', item.color);
      await K.queuePatch({ settings: { accent: item.color } }, 0);
      K.applyTheme();
      K.toast('Theme applied', item.name, 'ok');
    }
    K.render();
  };

  K.actions['shop-equip-badge'] = async el => {
    const item = SHOP_ITEMS.find(i => i.id === el.dataset.id);
    if (!item?.badge) return;
    const active = K.get('chatProfile.badge') === item.badge;
    const badge = active ? 'Member' : item.badge;
    K.setLocal('chatProfile.badge', badge);
    await K.queuePatch({ chatProfile: { badge } }, 0);
    K.toast(active ? 'Badge removed' : 'Badge equipped', item.name, 'ok');
    K.render();
  };

  // ---------------------------------------------------------------------
  // Kizzey+
  // ---------------------------------------------------------------------
  K.screens.premium = {
    title: 'Kizzey+',
    render() {
      const premium = K.get('premium', {});
      const active = premium.tier === 'plus';
      return `<div class="page">
        ${head('Kizzey+', 'Support the build. Unlock cosmetics.')}
        <div class="promo-card" style="margin-bottom:14px">
          <div class="promo-glow"></div>
          <span class="plan-badge">${active ? 'ACTIVE · DEMO' : 'LOCAL DEMO'}</span>
          <h2 style="font-size:2.125rem;letter-spacing:-.05em;margin:14px 0 7px">${active ? 'Thank you,<br>supporter.' : 'A softer edge,<br>a louder card.'}</h2>
          <p style="font-size:0.78125rem;color:var(--muted);line-height:1.55;margin:0 0 16px">${active ? 'Demo premium is unlocked on this server. No payment was taken and no external subscription exists.' : 'Kizzey+ is a local demo of the supporter screen. It unlocks cosmetics and a Plus badge in this state file.'}</p>
          <div class="price-row"><b>${active ? 'Plus' : '$0'}</b><span>${active ? 'demo tier' : 'demo only'}</span></div>
          <button class="btn btn-primary btn-block" data-action="${active ? 'premium-manage' : 'premium-unlock'}">${active ? 'Manage demo tier' : 'Unlock local demo'}</button>
        </div>
        ${K.sectionLabel('What is included')}
        <div class="list">
          ${[
            ['sparkles', 'Plus badge', 'A tiny mark next to your community profile.'],
            ['palette', 'Cosmetic themes', 'Use owned KCoin themes across the app.'],
            ['image', 'Preset gallery', 'Share and collect cards on this server.'],
            ['cloud-sun', 'Every RPC type', 'All current presence features stay free.'],
            ['heart', 'Support the build', 'Kizzey is open source. This screen doesn\'t charge anyone.'],
          ].map(([icon, title, desc]) => `<div class="list-item"><span class="list-icon">${K.icon(icon)}</span><span class="list-body"><span class="list-title">${title}</span><span class="list-desc">${desc}</span></span><span class="badge good">Included</span></div>`).join('')}
        </div>
        <div class="card soft" style="margin-top:14px">
          <div class="card-row"><div class="feature-icon" style="width:40px;height:40px;background:var(--surface-2);color:var(--primary)">${K.icon('shield')}</div><div><div class="card-title" style="font-size:0.8125rem">No payment path</div><div class="card-sub">Stripe cannot run inside this stdlib Python build because no keys or webhook endpoint were provided. Unlocking is a real state change, not a fake charge.</div></div></div>
        </div>
        ${active ? `<div class="card-row" style="margin-top:14px;justify-content:center"><span class="badge good">${K.icon('check', 'sm')} Plus since ${h(K.fmtDate(premium.since))}</span></div>` : ''}
        <div class="quick-grid-2" style="margin-top:14px"><button class="btn btn-ghost" data-route="shop">${K.icon('coins', 'sm')}KCoin shop</button><button class="btn btn-ghost" data-route="display">${K.icon('palette', 'sm')}Display</button></div>
        <div style="height:20px"></div>
      </div>`;
    },
  };

  K.actions['premium-unlock'] = async () => {
    try {
      const data = await K.api('/api/premium/unlock', { method: 'POST', body: {} });
      if (data.state) K.receiveState(data.state);
      K.toast('Kizzey+ demo unlocked', 'No payment was taken.', 'ok');
      K.render();
    } catch (error) { K.toast('Could not unlock', error.message, 'error'); }
  };

  K.actions['premium-reset'] = () => {
    K.confirm({
      title: 'Turn off Kizzey+ demo?',
      subtitle: 'The Plus badge and demo tier will be removed. Your cosmetics stay owned.',
      confirm: 'Turn off demo', danger: true,
      onConfirm: async () => {
        try {
          const data = await K.api('/api/premium/reset', { method: 'POST', body: {} });
          if (data.state) K.receiveState(data.state);
          K.toast('Kizzey+ demo turned off', 'No payment details were involved.', 'ok');
          K.render();
        } catch (error) { K.toast('Could not change tier', error.message, 'error'); }
      },
    });
  };

  K.actions['premium-manage'] = () => {
    K.sheet({
      title: 'Kizzey+ demo',
      subtitle: 'This server toggles a local cosmetic tier.',
      body: `<div class="setting-group"><div class="setting-row"><div class="setting-icon">${K.icon('crown')}</div><div class="setting-body"><div class="setting-title">Tier</div><div class="setting-desc">Plus · demo · ${h(K.fmtDate(K.get('premium.since')))}</div></div><span class="badge good">Active</span></div></div>
        <div class="field-hint">The native Kizzey app uses Stripe for supporter purchases. This web companion intentionally has no payment credentials, so the only honest action here is a local demo unlock.</div>
        <div class="modal-actions"><button class="btn btn-ghost" data-close-sheet>Close</button><button class="btn btn-danger" data-action="premium-reset">Turn off demo</button><button class="btn btn-primary" data-route="shop">${K.icon('coins', 'sm')}Open shop</button></div>`,
    });
  };
})();
