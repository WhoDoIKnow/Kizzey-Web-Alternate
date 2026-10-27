/* Kizzey Web — saved Discord accounts and the message mirror */
(function () {
  'use strict';
  const K = window.K;
  const h = K.esc;

  function page(title, sub, body, actions = '') {
    return `<div class="page">${K.pageHead({ title, sub, actions })}${body}<div style="height:20px"></div></div>`;
  }

  function accountList() {
    const rows = K.get('accounts', []);
    return Array.isArray(rows) ? rows.filter(row => row && row.id) : [];
  }

  function accountById(id) {
    return accountList().find(row => row.id === id) || null;
  }

  function accountName(row) {
    if (!row) return 'Missing account';
    return row.displayName || row.username || 'Discord account';
  }

  function activeAccount() {
    return accountById(K.get('activeAccountId', ''));
  }

  function mirrorState() {
    const raw = K.get('mirror', {});
    const rows = raw && Array.isArray(raw.rules) ? raw.rules.filter(rule => rule && rule.id) : [];
    const interval = Math.max(5, Math.min(300, Number(raw?.interval) || 12));
    return {
      enabled: !!raw?.enabled,
      interval,
      rules: rows,
      lastRunAt: raw?.lastRunAt || null,
      lastError: raw?.lastError || '',
    };
  }

  function statusBadge(text, tone = 'plain') {
    return `<span class="badge ${tone}">${h(text)}</span>`;
  }

  function accountAvatar(row, cls = '') {
    return K.avatar({
      name: accountName(row),
      url: row?.avatarUrl || '',
      cls,
      style: 'width:48px;height:48px;font-size:1rem',
    });
  }

  function helpButton() {
    return `<button class="icon-btn" data-action="mirror-help" aria-label="How the mirror works">${K.icon('help-circle')}</button>`;
  }

  function channelIdText(value) {
    const text = String(value || '');
    return text ? `<span class="mono-copy">${h(text)}</span>` : '<span class="tiny muted">No channel ID</span>';
  }

  // ---------------------------------------------------------------------
  // accounts
  // ---------------------------------------------------------------------
  K.screens.accounts = {
    title: 'Discord accounts',
    render() {
      const rows = accountList();
      const active = activeAccount();
      const limit = Number(K.get('accountLimit', 8)) || 8;
      const status = K.discordStatus();
      const hero = active
        ? `<div class="account-hero">
            ${K.avatar({ name: accountName(active), url: active.avatarUrl || '', cls: '', style: 'width:54px;height:54px;font-size:1.125rem' })}
            <div style="flex:1;min-width:0">
              <div class="account-name" style="font-size:1.1875rem">${h(accountName(active))}</div>
              <div class="account-handle">${active.username ? '@' + h(active.username) : 'Discord account'}</div>
              <div class="account-meta" style="margin-top:5px"><span class="badge ${status.color === 'good' ? 'good' : 'plain'}">${h(status.text)}</span><span class="pill">active</span><span class="pill">${rows.length}/${limit}</span></div>
            </div>
            <button class="icon-btn" data-action="account-refresh" aria-label="Refresh active account">${K.icon('refresh', 'sm')}</button>
          </div>`
        : `<div class="account-hero">
            <span class="avatar fallback" style="width:54px;height:54px">K</span>
            <div style="flex:1;min-width:0">
              <div class="account-name" style="font-size:1.1875rem">No account active</div>
              <div class="account-handle">Add a token to open the Discord gateway.</div>
              <div class="account-meta" style="margin-top:5px"><span class="badge plain">signed out</span><span class="pill">${rows.length}/${limit}</span></div>
            </div>
            <button class="btn btn-primary btn-sm" data-action="account-add">${K.icon('plus', 'sm')}Add</button>
          </div>`;

      const list = rows.length
        ? `<div class="account-list">${rows.map(row => {
            const isActive = row.id === K.get('activeAccountId', '');
            const tokenMissing = !row.tokenSet || row.needsAuth;
            return `<div class="account-list-row ${isActive ? 'active' : ''}">
              ${accountAvatar(row)}
              <div class="account-list-body">
                <div class="account-list-name">${h(accountName(row))} ${isActive ? '<span class="dot good" style="width:6px;height:6px"></span>' : ''}</div>
                <div class="account-list-sub">${row.username ? '@' + h(row.username) : 'Discord account'}${row.userId ? ` · <span class="mono">${h(row.userId)}</span>` : ''}</div>
                <div class="account-list-tags">
                  ${isActive ? statusBadge('Active', 'good') : statusBadge(row.lastUsedAt ? 'Used ' + K.relTime(row.lastUsedAt) : 'Saved')}
                  ${tokenMissing ? statusBadge('Token needed', 'plain') : statusBadge('Token stored')}
                </div>
                ${tokenMissing && row.authError ? `<div class="mirror-error">${h(row.authError)}</div>` : ''}
              </div>
              <div class="account-list-actions">
                ${isActive
                  ? '<span class="badge good">IN USE</span>'
                  : tokenMissing
                    ? `<button class="btn btn-ghost btn-sm" data-action="account-readd" data-id="${h(row.id)}">${K.icon('key', 'sm')}Add token</button>`
                    : `<button class="btn btn-ghost btn-sm" data-action="account-switch" data-id="${h(row.id)}">${K.icon('swap', 'sm')}Switch</button>`}
                <button class="icon-btn small" data-action="account-remove" data-id="${h(row.id)}" aria-label="Remove ${h(accountName(row))}">${K.icon('trash', 'sm')}</button>
              </div>
            </div>`;
          }).join('')}</div>`
        : K.empty(
            'users',
            'No Discord accounts saved',
            'Add a user token once. Kizzey keeps it on this server and can switch accounts without asking the browser for credentials again.',
            K.btn('Add account', { cls: 'btn-primary', action: 'account-add', icon: 'plus' })
          );

      const footer = rows.length
        ? `<div class="danger-zone">
            <div class="dz-title">Remove every account</div>
            <p>This deletes every saved token from <span class="mono-copy">data/secret.json</span>, stops the gateway, clears the live presence and pauses mirror rules that need an account. Settings and presets stay.</p>
            <button class="btn btn-danger btn-sm" data-action="account-remove-all">${K.icon('shield-off', 'sm')}Remove all accounts</button>
          </div>`
        : '';

      return page(
        'Discord accounts',
        'One gateway, several saved identities. Tokens never enter the browser.',
        `${hero}
        ${K.settingGroup('Saved accounts', list)}
        <div class="quick-grid-2" style="margin-top:14px">
          <button class="btn btn-primary" data-action="account-add" ${rows.length >= limit ? 'disabled' : ''}>${K.icon('user-plus', 'sm')}Add account</button>
          <button class="btn btn-ghost" data-route="mirror">${K.icon('repeat', 'sm')}Message mirror</button>
        </div>
        ${K.settingGroup('How switching works', `
          <div class="account-info-row">${K.icon('key', 'sm')}<div><b>Per-account tokens</b><span>Each saved account has its own private entry in data/secret.json. State, logs and API responses carry only identity metadata.</span></div></div>
          <div class="account-info-row">${K.icon('swap', 'sm')}<div><b>One live session</b><span>Switching stops the running presence, closes the old gateway and opens a new session for the selected account. Mirror rules keep their own account references.</span></div></div>
          <div class="account-info-row">${K.icon('shield-check', 'sm')}<div><b>Fallback stays predictable</b><span>Removing the active account switches to the next saved token with credentials. If none remains, Kizzey signs out cleanly.</span></div></div>
        `)}
        ${footer}`,
        `<button class="icon-btn" data-action="account-add" aria-label="Add account" ${rows.length >= limit ? 'disabled' : ''}>${K.icon('plus')}</button>`
      );
    },
  };

  function accountSheet(accountId = '') {
    const existing = accountId ? accountById(accountId) : null;
    const hasActive = !!activeAccount();
    const makeActive = existing ? (existing.id === K.get('activeAccountId', '') || !hasActive) : !hasActive;
    const title = existing ? 'Update Discord token' : 'Add a Discord account';
    const subtitle = existing
      ? `Replace the saved token for ${h(accountName(existing))}.`
      : hasActive
        ? 'The current account stays active unless you choose otherwise.'
        : 'The first saved account becomes the live session.';
    const body = `<div class="login-card" style="margin-top:0">
      ${existing ? `<div class="card soft" style="margin-bottom:14px"><div class="card-row">${accountAvatar(existing, '')}<div style="min-width:0"><div class="card-title" style="font-size:0.875rem">${h(accountName(existing))}</div><div class="card-sub">${existing.username ? '@' + h(existing.username) : 'Saved Discord identity'}</div></div></div></div>` : ''}
      ${K.field({
        id: 'account-add-token',
        label: 'Discord account token',
        type: 'password',
        value: '',
        placeholder: 'Paste a user token',
        hint: 'Validated with Discord, then written only to data/secret.json. It is never returned to the browser.',
        suffix: `<button class="icon-btn small" data-action="account-toggle-token" aria-label="Show token">${K.icon('eye', 'sm')}</button>`,
        attrs: 'spellcheck="false" autocomplete="off"',
      })}
      <div id="account-add-error" class="field-error hidden"></div>
      <div class="setting-row" style="margin-top:4px;border-bottom:0">
        <div class="setting-icon">${K.icon('swap')}</div>
        <div class="setting-body"><div class="setting-title">Make this the active account</div><div class="setting-desc">Switching restarts the Discord gateway and stops any running presence.</div></div>
        <label class="switch"><input id="account-make-active" type="checkbox" ${makeActive ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label>
      </div>
      <div class="login-steps">
        <span><b class="step-num">1</b><span>Sign in at <a href="https://discord.com/login" target="_blank" rel="noopener">discord.com/login</a> in a desktop browser.</span></span>
        <span><b class="step-num">2</b><span>Open DevTools → <b>Application → Local Storage → discord.com</b> and copy the <b>token</b> value.</span></span>
        <span><b class="step-num">3</b><span>Paste it here. Add each account separately; one token never unlocks another account row.</span></span>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-close-sheet>Cancel</button>
      <button class="btn btn-primary" id="account-add-btn" data-action="account-submit" data-id="${h(existing?.id || '')}">${K.icon('check', 'sm')}${existing ? 'Replace token' : 'Save account'}</button>
    </div>`;
    K.sheet({
      title,
      subtitle,
      body,
      onMount(root) {
        const input = root.querySelector('#account-add-token');
        input?.focus({ preventScroll: true });
        input?.addEventListener('keydown', event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            K.actions['account-submit'](root.querySelector('#account-add-btn'));
          }
        });
      },
    });
  }

  function showAccountError(message) {
    const box = document.querySelector('#account-add-error');
    if (!box) {
      K.toast('Could not save account', message, 'error');
      return;
    }
    box.textContent = message;
    box.classList.remove('hidden');
    document.querySelector('#account-add-token')?.focus();
  }

  K.actions['account-add'] = () => accountSheet('');
  K.actions['account-readd'] = el => accountSheet(el.dataset.id || '');

  K.actions['account-toggle-token'] = () => {
    const input = document.querySelector('#account-add-token');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  };

  K.actions['account-submit'] = async el => {
    const input = document.querySelector('#account-add-token');
    const button = el || document.querySelector('#account-add-btn');
    const token = input?.value.trim() || '';
    if (!token) {
      showAccountError('Paste a Discord account token first.');
      return;
    }
    const makeActive = !!document.querySelector('#account-make-active')?.checked;
    if (button) {
      button.disabled = true;
      button.textContent = 'Checking with Discord…';
    }
    try {
      const data = await K.api('/api/accounts/add', { method: 'POST', body: { token, makeActive } });
      if (data.state) K.receiveState(data.state);
      K.closeSheet();
      const switched = data.state?.activeAccountId === data.account?.id;
      K.toast(
        switched ? 'Account switched' : 'Account saved',
        switched
          ? `Kizzey is now using ${accountName(data.account)}.`
          : `${accountName(data.account)} is ready in Discord accounts.`,
        'ok'
      );
      K.render();
    } catch (error) {
      if (button) {
        button.disabled = false;
        button.innerHTML = `${K.icon('check', 'sm')}${button.dataset.id ? 'Replace token' : 'Save account'}`;
      }
      showAccountError(error.message);
    }
  };

  K.actions['account-switch'] = async el => {
    const id = el.dataset.id || '';
    if (!id) return;
    const row = accountById(id);
    el.disabled = true;
    try {
      const data = await K.api('/api/accounts/switch', { method: 'POST', body: { id } });
      if (data.state) K.receiveState(data.state);
      K.toast('Switched account', `Now using ${accountName(row)}.`, 'ok');
      K.render();
    } catch (error) {
      el.disabled = false;
      K.toast('Could not switch account', error.message, 'error');
    }
  };

  K.actions['account-refresh'] = async () => {
    try {
      const data = await K.api('/api/account/refresh', { method: 'POST', body: {} });
      if (data.state) K.receiveState(data.state);
      K.toast('Account refreshed', K.displayName(), 'ok');
      K.render();
    } catch (error) {
      K.toast('Could not refresh account', error.message, 'error');
    }
  };

  K.actions['account-remove'] = el => {
    const id = el.dataset.id || '';
    const row = accountById(id);
    if (!row) return;
    const isActive = id === K.get('activeAccountId', '');
    K.confirm({
      title: `Remove ${accountName(row)}?`,
      subtitle: isActive
        ? 'The saved token is deleted. Kizzey switches to another saved account, or signs out if none remains.'
        : 'The saved token is deleted from this server. Other accounts are untouched.',
      confirm: 'Remove account',
      danger: true,
      onConfirm: async () => {
        try {
          const data = await K.api('/api/accounts/remove', { method: 'POST', body: { id } });
          if (data.state) K.receiveState(data.state);
          const next = data.nextId ? accountById(data.nextId) : null;
          K.toast(
            isActive ? 'Account removed' : 'Saved account removed',
            isActive ? (next ? `Kizzey switched to ${accountName(next)}.` : 'No Discord account is active now.') : accountName(row),
            'ok'
          );
          K.render();
        } catch (error) {
          K.toast('Could not remove account', error.message, 'error');
        }
      },
    });
  };

  K.actions['account-remove-all'] = () => {
    K.confirm({
      title: 'Remove every Discord account?',
      subtitle: 'All saved tokens will be deleted. The gateway stops, presence clears, and account-backed mirror rules pause.',
      confirm: 'Remove all accounts',
      danger: true,
      onConfirm: async () => {
        try {
          const data = await K.api('/api/accounts/remove-all', { method: 'POST', body: { confirm: 'REMOVE ALL' } });
          if (data.state) K.receiveState(data.state);
          K.toast('Discord accounts removed', `${data.count || 0} saved token${data.count === 1 ? '' : 's'} deleted.`, 'ok');
          K.render();
        } catch (error) {
          K.toast('Could not remove accounts', error.message, 'error');
        }
      },
    });
  };

  // ---------------------------------------------------------------------
  // mirror screen
  // ---------------------------------------------------------------------
  function mirrorSwitch(enabled, action, id = '', small = false) {
    return `<button class="mirror-toggle ${enabled ? 'on' : ''} ${small ? 'sm' : ''}" data-action="${h(action)}" ${id ? `data-id="${h(id)}"` : ''} aria-pressed="${enabled ? 'true' : 'false'}" aria-label="${enabled ? 'Disable' : 'Enable'}"><span class="mirror-track"><span class="mirror-thumb"></span></span></button>`;
  }

  function ruleStatus(rule, mirror) {
    if (!rule.enabled) return statusBadge('Paused');
    if (!mirror.enabled) return statusBadge('Queued', 'plain');
    return statusBadge('Watching', 'good');
  }

  function ruleCard(rule) {
    const mirror = mirrorState();
    const sourceAccount = accountById(rule.sourceAccountId);
    const destAccount = accountById(rule.destAccountId);
    const missingSource = !sourceAccount || !sourceAccount.tokenSet || sourceAccount.needsAuth;
    const missingDest = !destAccount || !destAccount.tokenSet || destAccount.needsAuth;
    const webhookMode = rule.mode === 'webhook';
    const webhookMissing = webhookMode && !rule.webhookSet;
    const counts = [
      rule.mirrored ? `${rule.mirrored} forwarded` : 'No messages yet',
      rule.skipped ? `${rule.skipped} skipped` : '',
      rule.lastMirroredAt ? `last ${K.relTime(rule.lastMirroredAt)}` : '',
    ].filter(Boolean).join(' · ');
    return `<section class="card mirror-rule ${rule.enabled ? '' : 'paused'}">
      <div class="mirror-rule-head">
        <div class="mirror-rule-icon">${K.icon('repeat')}</div>
        <div class="mirror-rule-title">
          <div class="card-title">${h(rule.name || 'Message relay')}</div>
          <div class="card-sub">${ruleStatus(rule, mirror)} · ${webhookMode ? 'Webhook identity' : 'Normal message'}${mirror.enabled && rule.enabled ? ` · checks every ${mirror.interval}s` : ''}</div>
        </div>
        ${mirrorSwitch(rule.enabled, 'mirror-rule-toggle', rule.id, true)}
      </div>
      <div class="mirror-route">
        <div class="mirror-end">
          <span class="mirror-end-label">From</span>
          <b>${h(rule.sourceLabel || rule.sourceChannel)}</b>
          <span>${h(accountName(sourceAccount))}</span>
          ${channelIdText(rule.sourceChannel)}
        </div>
        <div class="mirror-route-arrow">${K.icon('arrow-right')}</div>
        <div class="mirror-end">
          <span class="mirror-end-label">To</span>
          <b>${h(rule.destLabel || rule.destChannel)}</b>
          <span>${h(accountName(destAccount))}</span>
          ${channelIdText(rule.destChannel)}
        </div>
      </div>
      <div class="mirror-meta">${h(counts)}${rule.lastRunAt ? ` · checked ${K.relTime(rule.lastRunAt)}` : ''}</div>
      ${missingSource || missingDest ? `<div class="mirror-error">${missingSource ? 'The source account needs a token. ' : ''}${missingDest ? 'The destination account needs a token.' : ''}</div>` : ''}
      ${webhookMissing ? '<div class="mirror-error">The relay webhook is not ready yet. Enable or save this relay to create it.</div>' : ''}
      ${rule.lastError ? `<div class="mirror-error">${h(rule.lastError)}</div>` : ''}
      <div class="mirror-rule-actions">
        <button class="btn btn-ghost btn-sm" data-action="mirror-run" data-id="${h(rule.id)}">${K.icon('play', 'sm')}Run now</button>
        <button class="btn btn-ghost btn-sm" data-action="mirror-edit" data-id="${h(rule.id)}">${K.icon('edit', 'sm')}Edit</button>
        <button class="icon-btn small" data-action="mirror-delete" data-id="${h(rule.id)}" aria-label="Delete relay">${K.icon('trash', 'sm')}</button>
      </div>
    </section>`;
  }

  K.screens.mirror = {
    title: 'Message mirror',
    render() {
      const mirror = mirrorState();
      const accounts = accountList();
      const sourceReady = accounts.filter(row => row.tokenSet && !row.needsAuth);
      const activeRules = mirror.rules.filter(rule => rule.enabled).length;
      const ruleLimit = Math.max(1, Number(K.get('mirrorRuleLimit', 20)) || 20);
      const atLimit = mirror.rules.length >= ruleLimit;
      const canAdd = sourceReady.length > 0 && !atLimit;
      const statusText = mirror.enabled
        ? `${activeRules} relay${activeRules === 1 ? '' : 's'} enabled · scans every ${mirror.interval}s`
        : mirror.rules.length
          ? 'Automatic mirroring is paused.'
          : 'Add a relay to begin.';
      const intervalOptions = Array.from(new Set([5, 12, 30, 60, mirror.interval])).sort((a, b) => a - b);
      return page(
        'Message mirror',
        'Forward new Discord messages between channels and accounts.',
        `<div class="card mirror-status">
          <div class="mirror-rule-head">
            <div class="mirror-rule-icon ${mirror.enabled ? 'live' : ''}">${K.icon('repeat')}</div>
            <div class="mirror-rule-title">
              <div class="card-title">${mirror.enabled ? 'Auto mirror is on' : 'Auto mirror is off'}</div>
              <div class="card-sub">${h(statusText)}${mirror.lastRunAt ? ` · last scan ${K.relTime(mirror.lastRunAt)}` : ''}</div>
            </div>
            ${mirrorSwitch(mirror.enabled, 'mirror-toggle')}
          </div>
          <div class="mirror-intervals">
            <span class="tiny muted">Check interval</span>
            ${intervalOptions.map(value => `<button class="chip-toggle ${mirror.interval === value ? 'active' : ''}" data-action="mirror-interval" data-value="${value}">${value < 60 ? value + 's' : Math.round(value / 60) + 'm'}</button>`).join('')}
          </div>
          <div class="mirror-meta">${mirror.rules.length} of ${ruleLimit} relay${ruleLimit === 1 ? '' : 's'} used${atLimit ? ' · delete one before adding another' : ''}</div>
          ${mirror.lastError ? `<div class="mirror-error">${h(mirror.lastError)}</div>` : ''}
        </div>
        ${sourceReady.length ? '' : `<div class="card soft" style="margin-bottom:14px"><div class="card-row"><div class="setting-icon" style="width:40px;height:40px;border-radius:13px;background:var(--surface-2);color:var(--primary)">${K.icon('key')}</div><div><div class="card-title" style="font-size:0.8125rem">An account token is required</div><div class="card-sub">Relays read with the source account and post with the destination account. Add a token before creating a rule.</div></div></div><div class="quick-grid-2 mt-12"><button class="btn btn-primary btn-sm" data-action="account-add">${K.icon('user-plus', 'sm')}Add account</button><button class="btn btn-ghost btn-sm" data-route="accounts">${K.icon('users', 'sm')}Accounts</button></div></div>`}
        ${mirror.rules.length
          ? `<div class="mirror-rule-list">${mirror.rules.map(ruleCard).join('')}</div>`
          : K.empty(
              'repeat',
              'No relays yet',
              'A relay watches one channel and posts new messages into another using the accounts you choose.',
              K.btn('Create a relay', { cls: 'btn-primary', action: 'mirror-add', icon: 'plus', disabled: !canAdd })
            )}
        <div class="quick-grid-2" style="margin-top:14px">
          <button class="btn btn-primary" data-action="mirror-add" ${!canAdd ? 'disabled' : ''}>${K.icon('plus', 'sm')}Add relay</button>
          <button class="btn btn-ghost" data-action="mirror-run-all" ${!mirror.rules.some(rule => rule.enabled) ? 'disabled' : ''}>${K.icon('play', 'sm')}Check enabled</button>
        </div>
        ${K.settingGroup('What gets forwarded', `
          <div class="account-info-row">${K.icon('message-circle', 'sm')}<div><b>Two post formats</b><span>Normal messages show the sender name, sent time and message with the destination account. Webhook identity recreates the sender avatar and display name and posts the message through a managed webhook.</span></div></div>
          <div class="account-info-row">${K.icon('paperclip', 'sm')}<div><b>New messages only</b><span>Each rule starts at the newest message in the source. Edits, deletes, reactions and typing do not sync. Use Run now to check immediately.</span></div></div>
          <div class="account-info-row">${K.icon('clock', 'sm')}<div><b>Content and links</b><span>Message text, attachment URLs, embed URLs and sticker names are included. Long posts are trimmed to Discord's 2,000-character limit.</span></div></div>
          <div class="account-info-row">${K.icon('shield-check', 'sm')}<div><b>No mention pings</b><span>Mentions are disabled on forwarded posts. An invisible marker stops the same message bouncing between relays.</span></div></div>
          <div class="account-info-row">${K.icon('clock', 'sm')}<div><b>Rate limits respected</b><span>Posts are paced, errors back off automatically, and the last delivered message ID survives a server restart.</span></div></div>
        `)}
        <div class="danger-zone">
          <div class="dz-title">Before you turn it on</div>
          <p>Mirroring uses user tokens and the Discord HTTP API. Message forwarding is a self-bot behaviour and may conflict with Discord's terms. Keep relays inside channels you control, and do not use them to evade moderation.</p>
          <button class="btn btn-ghost btn-sm" data-action="mirror-help">${K.icon('info', 'sm')}Read the relay guide</button>
        </div>`,
        `<button class="icon-btn" data-action="mirror-add" aria-label="Add relay" ${!canAdd ? 'disabled' : ''}>${K.icon('plus')}</button>`
      );
    },
  };

  function channelOption(value, label, selected) {
    return `<option value="${h(value)}" ${value === selected ? 'selected' : ''}>${h(label)}</option>`;
  }

  function accountOptions(selected) {
    return accountList().map(row => channelOption(
      row.id,
      `${accountName(row)}${row.username ? ' (@' + row.username + ')' : ''}${row.tokenSet ? '' : ' — token needed'}`,
      selected
    )).join('');
  }

  function mirrorOption(id, title, desc, checked) {
    return `<div class="setting-row" style="border-bottom:0;padding:10px 0">
      <div class="setting-body"><div class="setting-title">${h(title)}</div><div class="setting-desc">${h(desc)}</div></div>
      <label class="switch"><input id="${h(id)}" type="checkbox" ${checked ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label>
    </div>`;
  }

  function mirrorSheet(rule = null) {
    const accounts = accountList().filter(row => row.tokenSet && !row.needsAuth);
    if (!accounts.length) {
      K.toast('Add a Discord account first', 'A relay needs a source and destination token.', 'error');
      return;
    }
    const current = rule || {};
    const sourceAccount = current.sourceAccountId || accounts[0]?.id || '';
    const destAccount = current.destAccountId || accounts[1]?.id || accounts[0]?.id || '';
    const body = `<div class="card soft" style="margin-bottom:14px">
      <div class="card-row" style="align-items:flex-start">
        <div class="mirror-rule-icon">${K.icon('repeat')}</div>
        <div><div class="card-title" style="font-size:0.875rem">${current.id ? 'Edit this relay' : 'New message relay'}</div><div class="card-sub">The source is read with its account; the destination post is sent by its account. Copy numeric channel IDs from Discord with Developer Mode enabled.</div></div>
      </div>
    </div>
    ${K.field({ id: 'mirror-name', label: 'Relay name', value: current.name || '', placeholder: 'Support relay', maxlength: 80 })}
    <div class="field-grid">
      ${K.select({ id: 'mirror-source-account', label: 'Source account', value: sourceAccount, options: accountList().filter(row => row.tokenSet && !row.needsAuth).map(row => ({ value: row.id, label: `${accountName(row)}${row.username ? ' (@' + row.username + ')' : ''}` })) })}
      ${K.field({ id: 'mirror-source-channel', label: 'Source channel ID', value: current.sourceChannel || '', placeholder: '123456789012345678', attrs: 'inputmode="numeric" spellcheck="false"' })}
    </div>
    <div class="field-grid">
      ${K.select({ id: 'mirror-dest-account', label: 'Destination account', value: destAccount, options: accountList().filter(row => row.tokenSet && !row.needsAuth).map(row => ({ value: row.id, label: `${accountName(row)}${row.username ? ' (@' + row.username + ')' : ''}` })) })}
      ${K.field({ id: 'mirror-dest-channel', label: 'Destination channel ID', value: current.destChannel || '', placeholder: '987654321098765432', attrs: 'inputmode="numeric" spellcheck="false"' })}
    </div>
    ${K.select({ id: 'mirror-mode', label: 'Post format', value: current.mode || 'normal', options: [
      { value: 'normal', label: 'Normal message — sender, sent time, then text' },
      { value: 'webhook', label: 'Webhook identity — sender avatar and name' },
    ] })}
    <div class="field-hint" style="margin-top:-4px;margin-bottom:12px">Webhook identity needs the destination account to have Manage Webhooks in a server text or announcement channel. Kizzey creates one private relay webhook and keeps its URL off the browser.</div>
    <div class="mirror-form-options">
      ${mirrorOption('mirror-include-own', 'Include your own messages', 'Forward messages written by the source account as well as everyone else.', !!current.includeOwn)}
      ${mirrorOption('mirror-include-bots', 'Include bots and webhooks', 'Bots are skipped by default to keep relay noise down.', !!current.includeBots)}
      ${mirrorOption('mirror-include-attachments', 'Copy attachment links', 'Post Discord CDN links for files and images.', current.includeAttachments !== false)}
      ${mirrorOption('mirror-include-embeds', 'Copy embed links', 'Add the URL of link previews and rich embeds.', current.includeEmbeds !== false)}
    </div>
    <div class="setting-row" style="border-bottom:0;padding-top:2px">
      <div class="setting-icon">${K.icon('play')}</div>
      <div class="setting-body"><div class="setting-title">Enable this relay</div><div class="setting-desc">The global auto-mirror switch still has to be on for background checks.</div></div>
      <label class="switch"><input id="mirror-enabled" type="checkbox" ${current.enabled !== false ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label>
    </div>
    <div id="mirror-form-error" class="field-error hidden"></div>
    <div class="field-hint">Saving checks both channels with Discord and starts watching from the newest message. Existing history is not backfilled.</div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-close-sheet>Cancel</button>
      <button class="btn btn-primary" id="mirror-save-btn" data-action="mirror-save" data-id="${h(current.id || '')}">${K.icon('check', 'sm')}${current.id ? 'Save relay' : 'Create relay'}</button>
    </div>`;
    K.sheet({
      title: current.id ? 'Edit message relay' : 'Create message relay',
      subtitle: 'Source → destination, using saved Discord accounts.',
      body,
      onMount(root) {
        root.querySelector('#mirror-name')?.focus({ preventScroll: true });
      },
    });
  }

  K.actions['mirror-add'] = () => {
    const limit = Math.max(1, Number(K.get('mirrorRuleLimit', 20)) || 20);
    if (mirrorState().rules.length >= limit) {
      K.toast('Relay limit reached', `Delete a relay before adding another. The limit is ${limit}.`, 'error');
      return;
    }
    mirrorSheet(null);
  };
  K.actions['mirror-edit'] = el => {
    const rule = mirrorState().rules.find(item => item.id === el.dataset.id);
    if (rule) mirrorSheet(rule);
  };

  K.actions['mirror-save'] = async el => {
    const read = id => document.querySelector('#' + id);
    const draft = {
      id: el?.dataset.id || '',
      name: read('mirror-name')?.value.trim() || '',
      sourceAccountId: read('mirror-source-account')?.value || '',
      sourceChannel: read('mirror-source-channel')?.value.trim() || '',
      destAccountId: read('mirror-dest-account')?.value || '',
      destChannel: read('mirror-dest-channel')?.value.trim() || '',
      mode: read('mirror-mode')?.value || 'normal',
      includeOwn: !!read('mirror-include-own')?.checked,
      includeBots: !!read('mirror-include-bots')?.checked,
      includeAttachments: !!read('mirror-include-attachments')?.checked,
      includeEmbeds: !!read('mirror-include-embeds')?.checked,
      enabled: !!read('mirror-enabled')?.checked,
    };
    const errorBox = read('mirror-form-error');
    if (!draft.sourceAccountId || !draft.destAccountId) {
      if (errorBox) { errorBox.textContent = 'Choose a source and destination account.'; errorBox.classList.remove('hidden'); }
      return;
    }
    if (!/^\d{5,25}$/.test(draft.sourceChannel) || !/^\d{5,25}$/.test(draft.destChannel)) {
      if (errorBox) { errorBox.textContent = 'Channel IDs are numeric. Copy both IDs from Discord.'; errorBox.classList.remove('hidden'); }
      return;
    }
    if (draft.sourceChannel === draft.destChannel) {
      if (errorBox) { errorBox.textContent = 'Source and destination must be different channels.'; errorBox.classList.remove('hidden'); }
      return;
    }
    const button = el || read('mirror-save-btn');
    if (button) { button.disabled = true; button.textContent = draft.mode === 'webhook' ? 'Preparing webhook…' : 'Checking channels…'; }
    try {
      const data = await K.api('/api/mirror/rules', { method: 'POST', body: draft });
      if (data.state) K.receiveState(data.state);
      K.closeSheet();
      K.toast(
        data.warning ? 'Relay saved with a warning' : draft.id ? 'Relay updated' : 'Relay created',
        data.warning || (draft.id ? 'The rule changes are live.' : draft.mode === 'webhook' ? 'The relay webhook is ready. Watching begins at the newest source message.' : 'Watching begins at the newest source message.'),
        data.warning ? '' : 'ok'
      );
      K.render();
    } catch (error) {
      if (button) {
        button.disabled = false;
        button.innerHTML = `${K.icon('check', 'sm')}${draft.id ? 'Save relay' : 'Create relay'}`;
      }
      if (errorBox) {
        errorBox.textContent = error.message;
        errorBox.classList.remove('hidden');
      } else {
        K.toast('Could not save relay', error.message, 'error');
      }
    }
  };

  K.actions['mirror-toggle'] = async el => {
    const next = !mirrorState().enabled;
    el.disabled = true;
    try {
      const data = await K.api('/api/mirror/settings', { method: 'POST', body: { enabled: next } });
      if (data.state) K.receiveState(data.state);
      K.toast(next ? 'Auto mirror enabled' : 'Auto mirror paused', next ? 'Enabled relays will scan on the server.' : 'Relays keep their progress.', 'ok');
      K.render();
    } catch (error) {
      el.disabled = false;
      K.toast('Could not update mirror', error.message, 'error');
    }
  };

  K.actions['mirror-interval'] = async el => {
    const value = Number(el.dataset.value) || 12;
    try {
      const data = await K.api('/api/mirror/settings', { method: 'POST', body: { interval: value } });
      if (data.state) K.receiveState(data.state);
      K.toast('Mirror interval updated', `Checking every ${value}s.`, 'ok');
      K.render();
    } catch (error) {
      K.toast('Could not set interval', error.message, 'error');
    }
  };

  K.actions['mirror-rule-toggle'] = async el => {
    const id = el.dataset.id || '';
    const rule = mirrorState().rules.find(item => item.id === id);
    if (!rule) return;
    el.disabled = true;
    try {
      const data = await K.api('/api/mirror/rules/toggle', { method: 'POST', body: { id, enabled: !rule.enabled } });
      if (data.state) K.receiveState(data.state);
      const isOn = !!(data.rule && data.rule.enabled);
      if (data.warning && !isOn) K.toast('Relay could not start', data.warning, 'error');
      else if (data.warning) K.toast('Relay enabled with a warning', data.warning, '');
      else K.toast(isOn ? 'Relay enabled' : 'Relay paused', rule.name || '', 'ok');
      K.render();
    } catch (error) {
      el.disabled = false;
      K.toast('Could not update relay', error.message, 'error');
    }
  };

  K.actions['mirror-run'] = async el => {
    const id = el.dataset.id || '';
    const original = el.innerHTML;
    el.disabled = true;
    el.textContent = 'Checking…';
    try {
      const data = await K.api('/api/mirror/run', { method: 'POST', body: { id } });
      if (data.state) K.receiveState(data.state);
      const result = data.results?.[0] || {};
      if (result.error) K.toast('Relay check failed', result.error, 'error');
      else if (result.primed) K.toast('Watching from now', 'The rule starts at the newest source message.', 'ok');
      else if (result.cooldown) K.toast('Relay is cooling down', `It will retry in ${Math.max(1, Math.ceil((result.cooldown - Date.now()) / 1000))}s.`, '');
      else if (data.mirrored) K.toast('Messages forwarded', `${data.mirrored} posted to the destination.`, 'ok');
      else K.toast('No new messages', 'The relay is up to date.', 'ok');
      K.render();
    } catch (error) {
      el.disabled = false;
      el.innerHTML = original;
      K.toast('Could not run relay', error.message, 'error');
    }
  };

  K.actions['mirror-run-all'] = async el => {
    const original = el.innerHTML;
    el.disabled = true;
    el.textContent = 'Checking relays…';
    try {
      const data = await K.api('/api/mirror/run', { method: 'POST', body: {} });
      if (data.state) K.receiveState(data.state);
      const errors = (data.results || []).filter(item => item.error).length;
      if (errors) K.toast('Some relays need attention', `${errors} rule${errors === 1 ? '' : 's'} reported an error.`, 'error');
      else K.toast('Relays checked', `${data.mirrored || 0} message${data.mirrored === 1 ? '' : 's'} forwarded.`, 'ok');
      K.render();
    } catch (error) {
      el.disabled = false;
      el.innerHTML = original;
      K.toast('Could not run relays', error.message, 'error');
    }
  };

  K.actions['mirror-delete'] = el => {
    const id = el.dataset.id || '';
    const rule = mirrorState().rules.find(item => item.id === id);
    if (!rule) return;
    K.confirm({
      title: 'Delete this relay?',
      subtitle: `“${rule.name || 'Message relay'}” will stop checking. Messages already forwarded are not removed.`,
      confirm: 'Delete relay',
      danger: true,
      onConfirm: async () => {
        try {
          const data = await K.api('/api/mirror/rules/delete', { method: 'POST', body: { id } });
          if (data.state) K.receiveState(data.state);
          K.toast('Relay deleted', '', 'ok');
          K.render();
        } catch (error) {
          K.toast('Could not delete relay', error.message, 'error');
        }
      },
    });
  };

  K.actions['mirror-help'] = () => {
    const body = `<div class="policy-prose">
      <h3>What a relay does</h3>
      <p>It reads new messages from the source channel with the source account, then posts a plain-text copy into the destination channel with the destination account. One rule can cross servers or accounts.</p>
      <h3>Starting point</h3>
      <p>When a rule is created, Kizzey records the newest source message as a cursor. Only messages after that point are copied. Existing channel history is never backfilled, so adding a relay cannot dump an old conversation into another channel.</p>
      <h3>Post formats</h3>
      <p><b>Normal message</b> posts with the destination account and includes the sender's display name and username, the original sent time in Discord timestamp format, then the message text and any links.</p>
      <p><b>Webhook identity</b> posts through a webhook managed by Kizzey. Each message uses the sender's display name and avatar, so the destination sees the original identity instead of the destination account. This mode only works in a server text or announcement channel and needs Manage Webhooks permission. Mirroring into a DM, group DM or thread must use normal mode.</p>
      <h3>What is copied</h3>
      <p>Message text, attachment links, embed links and sticker names. System messages, bots and your own messages are skipped unless the rule says otherwise. Every forwarded post gets an invisible marker so another relay can recognise it and avoid a loop.</p>
      <h3>What is not copied</h3>
      <p>Edits, deletions, reactions, reply chains, typing indicators, threads and voice state are not synchronised. A deleted source message stays in the destination. Mention parsing is disabled, so forwarded text cannot ping a role or user.</p>
      <h3>Limits and failures</h3>
      <p>The source is polled on the configured interval. Discord rate limits are paced; temporary failures back off up to five minutes. The destination account needs permission to send messages, and both accounts need to read their respective channels. Progress survives a server restart.</p>
      <h3>Privacy</h3>
      <p>Rules store numeric channel IDs, account IDs, labels, the post format and the last processed message ID. They contain no Discord tokens. Account tokens and managed webhook URLs stay in <span class="mono-copy">data/secret.json</span> on the server; the browser only receives a <span class="mono-copy">webhookSet</span> flag. Deleting a relay removes its managed webhook.</p>
    </div>
    <div class="modal-actions"><button class="btn btn-primary" data-close-sheet>Got it</button></div>`;
    K.sheet({ title: 'How message mirror works', subtitle: 'Forwarding, limits and the fine print.', body });
  };
})();
