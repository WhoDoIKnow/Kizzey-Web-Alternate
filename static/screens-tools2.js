/* Kizzey Web — automation, account tools, host tools, plugins and logs */
(function () {
  'use strict';
  const K = window.K;
  const h = K.esc;

  const DAYS = [
    { value: 0, label: 'Mon' },
    { value: 1, label: 'Tue' },
    { value: 2, label: 'Wed' },
    { value: 3, label: 'Thu' },
    { value: 4, label: 'Fri' },
    { value: 5, label: 'Sat' },
    { value: 6, label: 'Sun' },
  ];
  const ACTION_OPTIONS = [
    { value: 'custom', label: 'Custom RPC' },
    { value: 'apps', label: 'App Detection' },
    { value: 'media', label: 'Media RPC' },
    { value: 'experimental', label: 'Experimental RPC' },
    { value: 'cycling', label: 'RPC Cycling' },
    { value: 'health', label: 'Health' },
    { value: 'weather', label: 'Weather' },
    { value: 'location', label: 'Location' },
    { value: 'navigation', label: 'Navigation' },
    { value: 'console', label: 'Console RPC' },
    { value: 'screen_read', label: 'Screen Read' },
  ];

  function pageHead(title, sub, actions = '') {
    return K.pageHead({ title, sub, actions });
  }

  function actionName(value) {
    return ACTION_OPTIONS.find(o => o.value === value)?.label || value;
  }

  function daysLabel(days) {
    if (!Array.isArray(days) || !days.length) return 'Every day';
    if (days.length === 7) return 'Every day';
    if (days.length === 5 && [0, 1, 2, 3, 4].every(d => days.includes(d))) return 'Weekdays';
    if (days.length === 2 && days.includes(5) && days.includes(6)) return 'Weekends';
    return days.slice().sort((a, b) => a - b).map(d => DAYS[d]?.label || '?').join(', ');
  }

  function nextRun(rule) {
    if (!rule.enabled) return '';
    const [hh, mm] = String(rule.time || '20:00').split(':').map(Number);
    const now = new Date();
    for (let offset = 0; offset < 14; offset++) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hh || 0, mm || 0, 0, 0);
      const pyDay = (day.getDay() + 6) % 7;
      if (day.getTime() <= now.getTime()) continue;
      if (rule.days && rule.days.length && !rule.days.map(Number).includes(pyDay)) continue;
      const label = offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : day.toLocaleDateString([], { weekday: 'long' });
      return `${label} at ${String(hh || 0).padStart(2, '0')}:${String(mm || 0).padStart(2, '0')}`;
    }
    return 'No upcoming run';
  }

  K.screens.automation = {
    title: 'Automation',
    render() {
      const auto = K.get('automation', {});
      const rules = auto.rules || [];
      const enabledCount = rules.filter(r => r.enabled).length;
      return `<div class="page">
        ${pageHead('Automation', 'Let your presence follow the day.', `<button class="icon-btn" data-action="rule-add" aria-label="Add rule">${K.icon('plus')}</button>`)}
        <div class="card soft" style="margin-bottom:14px">
          <div class="card-row"><div class="feature-icon" style="width:44px;height:44px;background:var(--surface-2);color:var(--primary)">${K.icon('clock')}</div><div style="flex:1"><div class="card-title">${auto.enabled ? 'Schedule is on' : 'Schedule is paused'}</div><div class="card-sub">${enabledCount} active rule${enabledCount === 1 ? '' : 's'} · server time ${h(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</div></div>${K.switch('automation.enabled', auto.enabled)}</div>
          <div class="field-hint mt-12">Rules run inside this server and never replace a presence you started by hand.</div>
        </div>
        ${rules.length ? `<div class="list">${rules.map(rule => {
          const upcoming = nextRun(rule);
          return `<div class="list-item" style="align-items:flex-start;padding:14px">
            <button class="list-icon" style="border:0;cursor:pointer;background:${rule.enabled ? 'color-mix(in srgb,var(--primary) 13%,var(--surface-2))' : 'var(--surface-2)'};color:${rule.enabled ? 'var(--primary)' : 'var(--muted)'}" data-action="rule-toggle" data-id="${h(rule.id)}" aria-label="Toggle rule">${K.icon('clock')}</button>
            <div class="list-body" style="gap:3px">
              <div class="card-row between"><span class="list-title">${h(rule.name || 'Untitled rule')}</span><span class="tiny ${rule.enabled ? 'good' : 'muted'}">${rule.enabled ? 'On' : 'Off'}</span></div>
              <span class="list-desc">${h(rule.time || '--:--')} · ${h(daysLabel(rule.days))}</span>
              <span class="list-desc">${h(actionName(rule.action))}${upcoming ? ' · next ' + h(upcoming) : ''}</span>
              <div class="card-row" style="gap:5px;margin-top:7px">
                <button class="btn btn-ghost btn-sm" data-action="rule-run" data-id="${h(rule.id)}">${K.icon('play', 'sm')}Run now</button>
                <button class="btn btn-ghost btn-sm" data-action="rule-edit" data-id="${h(rule.id)}">${K.icon('edit', 'sm')}Edit</button>
                <button class="icon-btn small" data-action="rule-delete" data-id="${h(rule.id)}" aria-label="Delete rule">${K.icon('trash', 'sm')}</button>
              </div>
            </div>
          </div>`;
        }).join('')}</div>` : K.empty('clock', 'No schedules yet', 'Add a rule for mornings, game nights or a quieter evening card.', `<button class="btn btn-primary" data-action="rule-add">${K.icon('plus', 'sm')}Add a rule</button>`)}
        <div class="section-label"><span>How schedules work</span></div>
        <div class="setting-group">
          <div class="setting-row"><div class="setting-icon">${K.icon('server')}</div><div class="setting-body"><div class="setting-title">Server local time</div><div class="setting-desc">Rules fire once per matching minute while Kizzey is running.</div></div></div>
          <div class="setting-row"><div class="setting-icon">${K.icon('shield')}</div><div class="setting-body"><div class="setting-title">Manual cards win</div><div class="setting-desc">A schedule is skipped while any presence is already live.</div></div></div>
          <div class="setting-row"><div class="setting-icon">${K.icon('wifi')}</div><div class="setting-body"><div class="setting-title">Discord must be connected</div><div class="setting-desc">A missing token or gateway keeps the schedule dormant.</div></div></div>
        </div>
        <div style="height:20px"></div>
        <button class="btn btn-tonal btn-block" data-action="rule-add">${K.icon('plus', 'sm')}New automation rule</button>
        <div style="height:20px"></div>
      </div>`;
    },
  };

  K.actions['rule-add'] = () => openRuleSheet(null);
  K.actions['rule-edit'] = el => {
    const rule = (K.get('automation.rules', []) || []).find(r => r.id === el.dataset.id);
    if (rule) openRuleSheet(rule);
  };

  function openRuleSheet(rule) {
    const draft = rule ? K.clone(rule) : {
      id: K.uid(),
      name: '',
      time: '20:00',
      days: [0, 1, 2, 3, 4],
      enabled: true,
      action: 'custom',
    };
    K.ruleDraft = draft;
    K.sheet({
      title: rule ? 'Edit schedule' : 'New schedule',
      subtitle: 'A small daily ritual for your card.',
      body: `<div class="field"><label for="rule-name">Rule name</label><div class="input-wrap"><input id="rule-name" class="input" value="${h(draft.name)}" placeholder="Evening listening"></div></div>
        <div class="two-col">
          <div class="field"><label for="rule-time">Time</label><div class="input-wrap"><input id="rule-time" class="input" type="time" value="${h(draft.time || '20:00')}"></div></div>
          <div class="field"><label for="rule-action">Start</label><select id="rule-action" class="select">${ACTION_OPTIONS.map(o => `<option value="${o.value}" ${o.value === draft.action ? 'selected' : ''}>${h(o.label)}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label>Days <span class="optional">server week</span></label><div class="chips" id="rule-days">${DAYS.map(d => `<button type="button" class="chip-toggle ${draft.days.includes(d.value) ? 'active' : ''}" data-action="rule-day" data-day="${d.value}">${d.label}</button>`).join('')}</div><div class="field-hint">No day selected means every day.</div></div>
        <label class="setting-row" style="border-radius:16px;background:var(--surface-2);padding:12px 14px;cursor:pointer"><div class="setting-body"><div class="setting-title">Enabled</div><div class="setting-desc">Run this rule on the selected days</div></div><input id="rule-enabled" type="checkbox" ${draft.enabled ? 'checked' : ''} style="width:20px;height:20px;accent-color:var(--primary)"></label>
        <div class="field-hint">The starting card uses the saved settings for the selected RPC type. Configure it first.</div>
        <div class="modal-actions"><button class="btn btn-ghost" data-close-sheet>Cancel</button><button class="btn btn-primary" data-action="rule-save">${K.icon('check', 'sm')}Save rule</button></div>`,
    });
  }

  K.actions['rule-day'] = el => {
    if (!K.ruleDraft) return;
    const day = Number(el.dataset.day);
    const days = K.ruleDraft.days || [];
    const idx = days.indexOf(day);
    if (idx >= 0) days.splice(idx, 1); else days.push(day);
    K.ruleDraft.days = days.sort((a, b) => a - b);
    el.classList.toggle('active', days.includes(day));
  };

  K.actions['rule-save'] = async () => {
    if (!K.ruleDraft) return;
    const name = document.getElementById('rule-name')?.value.trim();
    const time = document.getElementById('rule-time')?.value;
    const action = document.getElementById('rule-action')?.value;
    const enabled = !!document.getElementById('rule-enabled')?.checked;
    if (!name) { K.toast('Give the rule a name', '', 'error'); return; }
    if (!/^\d{2}:\d{2}$/.test(time || '')) { K.toast('Choose a time', '', 'error'); return; }
    const rule = Object.assign({}, K.ruleDraft, { name, time, action, enabled, lastFired: null });
    const rules = K.clone(K.get('automation.rules', []) || []);
    const idx = rules.findIndex(r => r.id === rule.id);
    if (idx >= 0) rules[idx] = rule; else rules.push(rule);
    K.setLocal('automation.rules', rules);
    await K.queuePatch({ automation: { rules } }, 0);
    K.closeSheet();
    K.toast('Schedule saved', `${name} · ${time}`, 'ok');
    K.render();
  };

  K.actions['rule-toggle'] = async el => {
    const rules = K.clone(K.get('automation.rules', []) || []);
    const rule = rules.find(r => r.id === el.dataset.id);
    if (!rule) return;
    rule.enabled = !rule.enabled;
    K.setLocal('automation.rules', rules);
    await K.queuePatch({ automation: { rules } }, 0);
    K.render();
  };

  K.actions['rule-delete'] = el => {
    const rule = (K.get('automation.rules', []) || []).find(r => r.id === el.dataset.id);
    if (!rule) return;
    K.confirm({
      title: 'Delete this schedule?',
      subtitle: rule.name,
      confirm: 'Delete', danger: true,
      onConfirm: async () => {
        const rules = (K.get('automation.rules', []) || []).filter(r => r.id !== rule.id);
        K.setLocal('automation.rules', rules);
        await K.queuePatch({ automation: { rules } }, 0);
        K.render();
      },
    });
  };

  K.actions['rule-run'] = async el => {
    const rule = (K.get('automation.rules', []) || []).find(r => r.id === el.dataset.id);
    if (!rule) return;
    if (!K.isSignedIn()) {
      K.loginSheet(() => K.rpcStart(rule.action), { subtitle: 'Connect Discord to run this schedule now.' });
      return;
    }
    await K.rpcStart(rule.action);
  };

  // ---------------------------------------------------------------------
  // bulk message removal
  // ---------------------------------------------------------------------
  K.bulkResult = K.bulkResult || null;
  K.bulkSelected = K.bulkSelected || new Set();

  K.screens.bulk = {
    title: 'Bulk message removal',
    render() {
      const bulk = K.get('bulk', {});
      const result = K.bulkResult;
      const messages = result?.messages || [];
      const selected = K.bulkSelected;
      return `<div class="page">
        ${pageHead('Bulk message removal', 'Clean up your own messages.', `<button class="icon-btn" data-action="bulk-help" aria-label="How it works">${K.icon('help-circle')}</button>`)}
        <div class="card soft" style="margin-bottom:14px">
          <div class="card-row"><div class="feature-icon" style="width:43px;height:43px;background:color-mix(in srgb,var(--warn) 12%,var(--surface-2));color:var(--warn)">${K.icon('trash')}</div><div style="flex:1"><div class="card-title">Your account, your messages</div><div class="card-sub">Scans a channel through the Discord REST API and only matches messages authored by you.</div></div></div>
        </div>
        <div class="field"><label for="bulk-channel">Channel ID</label><div class="input-wrap"><input id="bulk-channel" class="input" data-model="bulk.channel" value="${h(bulk.channel)}" placeholder="123456789012345678"><span class="input-suffix"><button class="icon-btn small" data-action="paste-clipboard" data-target="bulk-channel" aria-label="Paste">${K.icon('clipboard', 'sm')}</button></span></div><div class="field-hint">Enable Developer Mode in Discord, right-click a channel, then Copy Channel ID.</div></div>
        <div class="two-col">
          ${K.field({ label: 'Text filter', path: 'bulk.query', value: bulk.query, placeholder: 'Optional words to match' })}
          ${K.field({ label: 'Scan limit', path: 'bulk.limit', value: bulk.limit, type: 'number', min: 1, max: 500 })}
        </div>
        <button class="btn btn-primary btn-block" data-action="bulk-scan">${K.icon('search', 'sm')}Scan my messages</button>
        ${result ? `<div class="section-label"><span>Scan result</span><span class="tiny muted">${result.scanned} message${result.scanned === 1 ? '' : 's'} checked</span></div>
          ${messages.length ? `<div class="card-row" style="margin-bottom:9px"><button class="btn btn-ghost btn-sm" data-action="bulk-select-all">${K.icon('check-circle', 'sm')}Select all</button><button class="btn btn-ghost btn-sm" data-action="bulk-copy-ids">${K.icon('copy', 'sm')}Copy IDs</button><span class="badge plain" style="margin-left:auto">${selected.size} selected</span></div>
          <div class="list">${messages.map(message => `<div class="list-item" style="align-items:flex-start">
            <input type="checkbox" class="bulk-check" data-local="bulk-check" data-id="${h(message.id)}" ${selected.has(message.id) ? 'checked' : ''} style="margin-top:4px;width:18px;height:18px;accent-color:var(--primary);flex:none">
            <span class="list-body"><span class="list-title" style="font-weight:500;line-height:1.4">${h(message.content || 'No text content')}</span><span class="list-desc">${h(message.time ? K.fmtDateTime(new Date(message.time).getTime()) : '')} · ${message.attachments || 0} attachment${message.attachments === 1 ? '' : 's'}${message.pinned ? ' · pinned' : ''}</span></span>
            <button class="icon-btn small" data-copy="${h(message.id)}" aria-label="Copy message ID">${K.icon('copy', 'sm')}</button>
          </div>`).join('')}</div>
          <button class="btn btn-danger btn-block mt-16" data-action="bulk-delete" ${selected.size ? '' : 'disabled'}>${K.icon('trash', 'sm')}Delete ${selected.size || ''} selected</button>` : K.empty('check-circle', 'No matching messages', 'Nothing authored by you matched this scan.', '')}` : ''}
        <div class="field-hint" style="padding:16px 5px">Discord rate limits deletes to roughly one every half second. A scan never deletes anything until you confirm.</div>
      </div>`;
    },
    mount(root) {
      root.querySelectorAll('.bulk-check').forEach(box => {
        box.addEventListener('change', () => {
          const id = box.dataset.id;
          if (box.checked) K.bulkSelected.add(id); else K.bulkSelected.delete(id);
          const badge = root.querySelector('.badge.plain');
          if (badge && /selected/.test(badge.textContent)) badge.textContent = `${K.bulkSelected.size} selected`;
          const del = root.querySelector('[data-action="bulk-delete"]');
          if (del) { del.disabled = K.bulkSelected.size === 0; del.innerHTML = `${K.icon('trash', 'sm')}Delete ${K.bulkSelected.size || ''} selected`; }
        });
      });
    },
  };

  K.actions['bulk-help'] = () => {
    K.sheet({
      title: 'Bulk removal',
      subtitle: 'How the scan works',
      body: `<div class="setting-group" style="padding:6px 14px">
        <div class="setting-row"><div class="setting-icon">${K.icon('search')}</div><div class="setting-body"><div class="setting-title">1. Scan</div><div class="setting-desc">Kizzey reads up to 500 channel messages and keeps only those authored by your Discord ID.</div></div></div>
        <div class="setting-row"><div class="setting-icon">${K.icon('check-circle')}</div><div class="setting-body"><div class="setting-title">2. Choose</div><div class="setting-desc">Nothing is selected automatically. Review the text, attachments and pinned state.</div></div></div>
        <div class="setting-row"><div class="setting-icon">${K.icon('trash')}</div><div class="setting-body"><div class="setting-title">3. Confirm</div><div class="setting-desc">Type DELETE in the confirmation sheet. Kizzey deletes at a safe pace and reports failures.</div></div></div>
      </div>
      <div class="field-hint">Bulk deletion is permanent. Kizzey cannot restore removed messages.</div>
      <div class="modal-actions"><button class="btn btn-primary" data-close-sheet>Got it</button></div>`,
    });
  };

  K.actions['bulk-scan'] = async () => {
    if (!K.isSignedIn()) {
      K.loginSheet(() => K.actions['bulk-scan'](), { subtitle: 'Connect Discord to read your messages.' });
      return;
    }
    const bulk = K.get('bulk', {});
    const channel = String(bulk.channel || '').trim();
    if (!channel) { K.toast('Channel ID required', 'Paste a channel ID first.', 'error'); return; }
    await K.flush().catch(() => {});
    K.toast('Scanning channel…', 'Only your messages will be kept.', '');
    try {
      const data = await K.api('/api/bulk/scan', { method: 'POST', body: { channel, query: bulk.query || '', limit: K.num(bulk.limit, 100) } });
      K.bulkResult = data;
      K.bulkSelected.clear();
      K.toast('Scan complete', `${data.messages.length} matching message${data.messages.length === 1 ? '' : 's'} found.`, 'ok');
      K.render();
    } catch (error) {
      K.toast('Scan failed', error.message, 'error');
    }
  };

  K.actions['bulk-select-all'] = () => {
    const messages = K.bulkResult?.messages || [];
    const all = messages.every(m => K.bulkSelected.has(m.id));
    K.bulkSelected.clear();
    if (!all) messages.forEach(m => K.bulkSelected.add(m.id));
    K.render();
  };

  K.actions['bulk-copy-ids'] = () => {
    const ids = (K.bulkResult?.messages || []).map(m => m.id).join('\n');
    if (ids) K.copy(ids, 'Message IDs copied');
  };

  K.actions['bulk-delete'] = () => {
    const ids = Array.from(K.bulkSelected);
    if (!ids.length) return;
    const channel = String(K.get('bulk.channel', '') || '').trim();
    K.sheet({
      title: 'Delete messages?',
      subtitle: `${ids.length} message${ids.length === 1 ? '' : 's'} from your account`,
      body: `<div class="danger-zone"><div class="dz-title">This cannot be undone</div><p>Kizzey will call Discord's delete endpoint for each selected message. Rate limits may make the process take a while.</p></div>
        <div class="field"><label for="bulk-confirm">Type <b>DELETE</b> to confirm</label><div class="input-wrap"><input id="bulk-confirm" class="input" placeholder="DELETE" autocomplete="off"></div></div>
        <div class="modal-actions"><button class="btn btn-ghost" data-close-sheet>Cancel</button><button class="btn btn-danger" data-action="bulk-confirm">${K.icon('trash', 'sm')}Delete permanently</button></div>`,
    });
  };

  K.actions['bulk-confirm'] = async () => {
    const input = document.getElementById('bulk-confirm');
    if (!input || input.value.trim() !== 'DELETE') { K.toast('Type DELETE to confirm', '', 'error'); input?.focus(); return; }
    const ids = Array.from(K.bulkSelected);
    const channel = String(K.get('bulk.channel', '') || '').trim();
    if (!ids.length) return;
    K.closeSheet();
    K.toast('Deleting messages…', 'Discord rate limits are respected.', '');
    try {
      const data = await K.api('/api/bulk/delete', { method: 'POST', body: { ids, channel, confirm: 'DELETE' } });
      const deleted = new Set(ids);
      if (K.bulkResult) K.bulkResult.messages = (K.bulkResult.messages || []).filter(m => !deleted.has(m.id));
      K.bulkSelected.clear();
      K.toast('Messages deleted', `${data.deleted} removed${data.failed?.length ? ` · ${data.failed.length} failed` : ''}`, data.failed?.length ? '' : 'ok');
      K.render();
    } catch (error) {
      K.toast('Delete failed', error.message, 'error');
    }
  };

  // ---------------------------------------------------------------------
  // host tools ("Shizuku" analogue)
  // ---------------------------------------------------------------------
  K.hostStats = K.hostStats || null;
  K.hostLoading = false;

  async function loadHostStats(force = false) {
    if (K.hostLoading) return K.hostStats;
    if (K.hostStats && !force) return K.hostStats;
    K.hostLoading = true;
    try {
      const data = await K.api('/api/hoststats');
      K.hostStats = data.stats;
      const health = await K.api('/api/health').catch(() => null);
      K.hostHealth = health;
      return K.hostStats;
    } finally {
      K.hostLoading = false;
    }
  }

  function bytes(value, digits = 1) {
    const n = Number(value) || 0;
    if (n <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let idx = 0;
    let size = n;
    while (size >= 1024 && idx < units.length - 1) { size /= 1024; idx += 1; }
    return `${size.toFixed(idx === 0 ? 0 : digits)} ${units[idx]}`;
  }

  K.actions['host-refresh'] = async () => {
    await loadHostStats(true).catch(error => K.toast('Host stats failed', error.message, 'error'));
    if (K.current.route === 'shizuku') K.render();
  };

  K.actions['gateway-reconnect'] = async () => {
    try {
      const data = await K.api('/api/gateway/reconnect', { method: 'POST', body: {} });
      if (data.state) K.receiveState(data.state);
      K.toast('Gateway reconnecting', 'Discord will be back in a moment.', 'ok');
      K.render();
    } catch (error) {
      K.toast('Reconnect failed', error.message, 'error');
    }
  };

  K.actions['account-refresh'] = async () => {
    try {
      const data = await K.api('/api/account/refresh', { method: 'POST', body: {} });
      if (data.state) K.receiveState(data.state);
      K.toast('Discord account checked', K.displayName(), 'ok');
      K.render();
    } catch (error) {
      K.toast('Account check failed', error.message, 'error');
    }
  };

  K.actions['copy-server-url'] = () => K.copy(location.origin, 'Server URL copied');

  K.screens.shizuku = {
    title: 'Shizuku Tools',
    render() {
      const stats = K.hostStats;
      const health = K.hostHealth;
      const gw = K.get('gateway', {});
      const device = stats?.device || K.get('host', {});
      return `<div class="page">
        ${pageHead('Shizuku Tools', 'Host diagnostics for the web server.', `<button class="icon-btn" data-action="host-refresh" aria-label="Refresh">${K.icon('refresh')}</button>`)}
        <div class="card soft" style="margin-bottom:14px">
          <div class="card-row"><div class="feature-icon" style="width:44px;height:44px;background:var(--surface-2);color:var(--primary)">${K.icon('terminal')}</div><div style="flex:1"><div class="card-title">No privileged shell here</div><div class="card-sub">The browser can't grant Android shell access. This screen reads the real stats of the machine running Kizzey Web.</div></div></div>
        </div>
        ${stats ? `<div class="metric-grid">
          <div class="metric"><div class="metric-icon">${K.icon('cpu')}</div><div><b>${stats.cpu == null ? '—' : stats.cpu + '%'}</b><small>CPU usage</small></div><div class="metric-label">${h((stats.load || []).join(' / '))} load</div></div>
          <div class="metric"><div class="metric-icon">${K.icon('memory-stick')}</div><div><b>${bytes(stats.memory?.used)}</b><small>Memory used</small></div><div class="metric-label">${bytes(stats.memory?.total)} total</div></div>
          <div class="metric"><div class="metric-icon">${K.icon('hard-drive')}</div><div><b>${bytes(stats.disk?.free)}</b><small>Disk free</small></div><div class="metric-label">${bytes(stats.disk?.total)} total</div></div>
          <div class="metric"><div class="metric-icon">${K.icon('battery')}</div><div><b>${stats.battery == null ? '—' : stats.battery + '%'}</b><small>Battery</small></div><div class="metric-label">${stats.charging ? 'Charging' : stats.battery == null ? 'Unavailable' : 'On battery'}</div></div>
        </div>
        <div class="setting-group">
          <div class="setting-row"><div class="setting-icon">${K.icon('smartphone')}</div><div class="setting-body"><div class="setting-title">${h(device.model || 'Kizzey Web host')}</div><div class="setting-desc">${h([device.manufacturer, device.android ? 'Android ' + device.android : '', device.device].filter(Boolean).join(' · ') || 'Server environment')}</div></div></div>
          <div class="setting-row"><div class="setting-icon">${K.icon('clock')}</div><div class="setting-body"><div class="setting-title">Uptime</div><div class="setting-desc">${h(K.duration((stats.uptime || 0) * 1000))}</div></div></div>
          <div class="setting-row"><div class="setting-icon">${K.icon('users')}</div><div class="setting-body"><div class="setting-title">SSE sessions</div><div class="setting-desc">${stats.sessions ?? 0} connected page${stats.sessions === 1 ? '' : 's'}</div></div></div>
          <div class="setting-row"><div class="setting-icon">${K.icon('globe')}</div><div class="setting-body"><div class="setting-title">Server address</div><div class="setting-desc">${h(health?.ip || location.host)} · port ${h(health?.port || location.port || '8420')}</div></div><button class="icon-btn small" data-action="copy-server-url" aria-label="Copy URL">${K.icon('copy', 'sm')}</button></div>
        </div>` : `<div class="loading-line"><span></span></div>`}
        ${K.sectionLabel('Connectivity')}
        <div class="setting-group">
          <div class="setting-row"><div class="setting-icon">${K.icon('wifi')}</div><div class="setting-body"><div class="setting-title">Discord gateway</div><div class="setting-desc">${h(gw.connected ? 'Connected' : gw.state || 'Offline')}${gw.latency != null ? ' · ' + gw.latency + ' ms' : ''}${gw.error ? ' · ' + h(gw.error) : ''}</div></div><span class="badge ${gw.connected ? 'good' : 'plain'}">${gw.connected ? 'Live' : 'Idle'}</span></div>
          <div class="setting-row"><div class="setting-icon">${K.icon('refresh')}</div><div class="setting-body"><div class="setting-title">Restart gateway</div><div class="setting-desc">Drop and re-open the Discord WebSocket</div></div><button class="btn btn-ghost btn-sm" data-action="gateway-reconnect">Reconnect</button></div>
          <div class="setting-row"><div class="setting-icon">${K.icon('user')}</div><div class="setting-body"><div class="setting-title">REST check</div><div class="setting-desc">${K.isSignedIn() ? h(K.displayName()) + ' · token held by the server' : 'No Discord account connected'}</div></div><button class="btn btn-ghost btn-sm" data-action="account-refresh" ${K.isSignedIn() ? '' : 'disabled'}>Test</button></div>
        </div>
        ${K.sectionLabel('Background')}
        <div class="setting-group">
          <div class="setting-row"><div class="setting-icon">${K.icon('battery-charging')}</div><div class="setting-body"><div class="setting-title">Background presence</div><div class="setting-desc">The Python server owns the Discord gateway, so closing this browser tab does not stop an active presence. Keep the server or Termux session running; browsers cannot request Android battery-optimisation exemptions.</div></div><span class="badge good">Server-side</span></div>
        </div>
        <div class="quick-grid-2" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0">
          <button class="btn btn-tonal btn-sm" data-route="logs">${K.icon('terminal', 'sm')}Open logs</button>
          <button class="btn btn-ghost btn-sm" data-route="backup">${K.icon('database', 'sm')}Server backup</button>
        </div>
        <div class="field-hint">Shizuku itself is not available to a web page. Host monitoring is real; privileged Android actions remain in the native app.</div>
        <div style="height:20px"></div>
      </div>`;
    },
    mount() {
      if (K.hostStats || K.hostLoading) return;
      loadHostStats().then(stats => {
        if (stats && K.current.route === 'shizuku') K.render();
      }).catch(error => {
        if (K.current.route === 'shizuku') K.toast('Host stats failed', error.message, 'error');
      });
    },
  };

  // ---------------------------------------------------------------------
  // plugins
  // ---------------------------------------------------------------------
  const PLUGIN_META = {
    audiocord: { title: 'Audiocord', icon: 'music', color: '#73d99f', desc: 'A live audio visualizer that can ride along with Media RPC.' },
    callLinks: { title: 'Call links', icon: 'phone', color: '#8fd6c3', desc: 'Create a join link for your Kizzey voice room.' },
    presenceShare: { title: 'Presence share', icon: 'share', color: '#efc17a', desc: 'Bundle the current custom card into a portable share code.' },
    apiBridge: { title: 'API bridge', icon: 'braces', color: '#9db8ff', desc: 'Open a read-only JSON endpoint for the current Kizzey state.' },
  };

  K.screens.plugins = {
    title: 'Plugins',
    render() {
      const plugins = K.get('plugins', {});
      return `<div class="page">
        ${pageHead('Plugins', 'Small tools that make Kizzey yours.')}
        <div class="promo-card" style="margin-bottom:16px">
          <div class="promo-glow"></div>
          <span class="plan-badge">EXPERIMENTAL</span>
          <h2 style="font-size:1.625rem;letter-spacing:-.04em;margin:14px 0 6px">A little extra<br>under the hood.</h2>
          <p style="font-size:0.75rem;color:var(--muted);line-height:1.55;margin:0">Each plugin is local to this server. No third-party account or extension needed.</p>
        </div>
        <div class="feature-grid" style="grid-template-columns:1fr">
          ${Object.entries(PLUGIN_META).map(([id, meta]) => {
            const state = plugins[id] || {};
            const enabled = !!state.enabled;
            return `<div class="feature-tile ${enabled ? 'running' : ''}" style="min-height:auto;padding:15px;--tile-fg:${meta.color};--tile-bg:${meta.color}18;--tile-glow:${meta.color}22">
              <div class="feature-icon">${K.icon(meta.icon)}</div>
              <div class="feature-body"><div class="feature-name">${h(meta.title)}</div><div class="feature-desc">${h(meta.desc)}</div></div>
              <div class="feature-status"><button class="btn ${enabled ? 'btn-primary' : 'btn-ghost'} btn-sm" data-action="plugin-toggle" data-plugin="${id}">${enabled ? 'Enabled' : 'Enable'}</button></div>
              <button class="icon-btn small" data-action="plugin-config" data-plugin="${id}" aria-label="Configure ${h(meta.title)}">${K.icon('settings', 'sm')}</button>
            </div>`;
          }).join('')}
        </div>
        <div id="plugin-stage"></div>
        <div class="field-hint" style="padding:16px 5px">Plugins run in the browser. Closing the page stops any microphone visualizer immediately.</div>
      </div>`;
    },
    mount(root) {
      const stage = root.querySelector('#plugin-stage');
      if (stage && K.get('plugins.audiocord.enabled')) {
        stage.innerHTML = `<div class="section-label"><span>Audiocord visualizer</span></div><div class="card"><canvas id="audio-visualizer" width="800" height="180" style="width:100%;height:180px;border-radius:16px;background:var(--surface-2)"></canvas><div class="card-row" style="margin-top:8px"><button class="btn btn-tonal btn-sm" data-action="visualizer-start">${K.icon('mic', 'sm')}Start microphone</button><button class="btn btn-ghost btn-sm" data-action="visualizer-stop">${K.icon('stop', 'sm')}Stop</button><span class="tiny muted" style="margin-left:auto">Local audio only</span></div></div>`;
      }
    },
  };

  K.actions['plugin-toggle'] = async el => {
    const plugin = el.dataset.plugin;
    if (!plugin) return;
    const enabled = !K.get(`plugins.${plugin}.enabled`, false);
    K.setLocal(`plugins.${plugin}.enabled`, enabled);
    await K.queuePatch({ plugins: { [plugin]: { enabled } } }, 0);
    K.toast(enabled ? 'Plugin enabled' : 'Plugin disabled', PLUGIN_META[plugin]?.title || plugin, enabled ? 'ok' : '');
    K.render();
  };

  K.actions['plugin-config'] = el => {
    const id = el.dataset.plugin;
    if (id === 'audiocord') {
      const p = K.get('plugins.audiocord', {});
      K.sheet({
        title: 'Audiocord',
        subtitle: 'A local microphone visualizer.',
        body: `<div class="setting-group"><div class="setting-row"><div class="setting-icon">${K.icon('image')}</div><div class="setting-body"><div class="setting-title">Show album art</div><div class="setting-desc">Use the media artwork as visualizer background</div></div>${K.switch('plugins.audiocord.showArt', p.showArt)}</div>
          ${K.select({ label: 'Visualizer style', path: 'plugins.audiocord.visualizer', value: p.visualizer, options: [{ value: 'bars', label: 'Bars' }, { value: 'wave', label: 'Wave' }, { value: 'dots', label: 'Dots' }], cls: 'mt-8' })}</div>
          <div class="field-hint">The microphone stream stays in this tab and is never uploaded or recorded.</div>
          <div class="modal-actions"><button class="btn btn-ghost" data-close-sheet>Close</button><button class="btn btn-primary" data-action="visualizer-start">${K.icon('mic', 'sm')}Start microphone</button></div>`,
      });
    } else if (id === 'callLinks') {
      const p = K.get('plugins.callLinks', {});
      K.sheet({
        title: 'Call links',
        subtitle: 'A shareable link to your voice room.',
        body: `${K.field({ label: 'Button label', path: 'plugins.callLinks.label', value: p.label, placeholder: 'Join my call' })}
          ${K.field({ label: 'Link', id: 'call-link', value: p.url || callUrl(), readonly: true })}
          <div class="field-hint">This link opens the Kizzey Web voice room on this server.</div>
          <div class="modal-actions"><button class="btn btn-ghost" data-close-sheet>Close</button><button class="btn btn-tonal" data-action="generate-call-link">${K.icon('link', 'sm')}Generate</button><button class="btn btn-primary" data-action="share-call-link">${K.icon('share', 'sm')}Share</button></div>`,
      });
    } else if (id === 'presenceShare') {
      const p = K.get('plugins.presenceShare', {});
      const code = p.code || buildShareCode();
      K.sheet({
        title: 'Presence share',
        subtitle: 'A portable copy of the current custom card.',
        body: `<div class="card soft"><div class="tiny muted">Share code</div><div class="mono" style="font-size:0.625rem;word-break:break-all;max-height:160px;overflow:auto;margin-top:8px">${h(code)}</div></div>
          <div class="field-hint">The code contains the card text and fields — not your token, account or images.</div>
          <div class="modal-actions"><button class="btn btn-ghost" data-close-sheet>Close</button><button class="btn btn-primary" data-action="copy-share-code">${K.icon('copy', 'sm')}Copy code</button></div>`,
      });
    } else if (id === 'apiBridge') {
      const url = location.origin + '/api/state';
      K.sheet({
        title: 'API bridge',
        subtitle: 'Read-only state for your own tools.',
        body: `<div class="card soft"><div class="tiny muted">Endpoint</div><div class="mono" style="word-break:break-all;margin-top:8px">${h(url)}</div></div>
          <div class="field-hint">The state endpoint excludes the Discord token. Do not expose your Kizzey server to the public internet without adding access control.</div>
          <div class="modal-actions"><button class="btn btn-ghost" data-close-sheet>Close</button><button class="btn btn-primary" data-copy="${h(url)}">${K.icon('copy', 'sm')}Copy endpoint</button></div>`,
      });
    }
  };

  function callUrl() {
    return `${location.origin}${location.pathname}#/voice?room=lounge`;
  }

  function buildShareCode() {
    const c = K.get('custom', {});
    const data = {
      v: 1,
      name: c.name || '',
      details: c.details || '',
      state: c.state || '',
      type: c.type || '0',
      largeText: c.largeText || '',
      smallText: c.smallText || '',
      buttons: [c.button1, c.button1link, c.button2, c.button2link].filter(Boolean).slice(0, 4),
    };
    try { return btoa(unescape(encodeURIComponent(JSON.stringify(data)))); }
    catch { return ''; }
  }

  K.actions['generate-call-link'] = async () => {
    const url = callUrl();
    K.setLocal('plugins.callLinks.url', url);
    await K.queuePatch({ plugins: { callLinks: { url } } }, 0);
    const input = document.getElementById('call-link');
    if (input) input.value = url;
    K.copy(url, 'Call link copied');
  };

  K.actions['share-call-link'] = async () => {
    const url = callUrl();
    if (navigator.share) {
      try { await navigator.share({ title: 'Join me on Kizzey', text: K.get('plugins.callLinks.label', 'Join my call'), url }); return; } catch {}
    }
    K.copy(url, 'Call link copied');
  };

  K.actions['copy-share-code'] = async () => {
    const code = buildShareCode();
    K.setLocal('plugins.presenceShare.code', code);
    await K.queuePatch({ plugins: { presenceShare: { code } } }, 0);
    K.copy(code, 'Share code copied');
  };

  K.visualizer = null;
  function stopVisualizer() {
    if (!K.visualizer) return;
    const { stream, ctx, raf } = K.visualizer;
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach(t => t.stop());
    ctx?.close().catch(() => {});
    K.visualizer = null;
  }
  K.stopVisualizer = stopVisualizer;
  setInterval(() => {
    if (K.visualizer && K.current.route !== 'plugins') stopVisualizer();
  }, 2500);

  K.actions['visualizer-start'] = async () => {
    stopVisualizer();
    if (!navigator.mediaDevices?.getUserMedia) { K.toast('Microphone unavailable', 'This browser does not expose getUserMedia.', 'error'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      source.connect(analyser);
      K.visualizer = { stream, ctx, analyser, raf: 0 };
      K.closeSheet();
      if (K.current.route !== 'plugins') K.navigate('plugins');
      setTimeout(drawVisualizer, 180);
      K.toast('Microphone live', 'The visualizer is running locally.', 'ok');
    } catch (error) {
      K.toast('Microphone permission denied', error.message, 'error');
    }
  };

  function drawVisualizer() {
    if (!K.visualizer) return;
    const canvas = document.getElementById('audio-visualizer');
    if (!canvas) { K.stopVisualizer && K.stopVisualizer(); return; }
    const ctx2d = canvas.getContext('2d');
    const { analyser } = K.visualizer;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const style = K.get('plugins.audiocord.visualizer', 'bars');
    const draw = () => {
      if (!K.visualizer) return;
      if (!document.getElementById('audio-visualizer')) { stopVisualizer(); return; }
      K.visualizer.raf = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(data);
      const w = canvas.width, hgt = canvas.height;
      ctx2d.clearRect(0, 0, w, hgt);
      const grad = ctx2d.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#d0bcff'); grad.addColorStop(.55, '#edbad2'); grad.addColorStop(1, '#7ee0b8');
      ctx2d.fillStyle = grad;
      if (style === 'wave') {
        ctx2d.beginPath();
        ctx2d.lineWidth = 2.4; ctx2d.strokeStyle = grad;
        for (let i = 0; i < data.length; i++) {
          const x = i / (data.length - 1) * w;
          const y = hgt / 2 + (data[i] - 90) / 260 * hgt;
          if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
        }
        ctx2d.stroke();
      } else if (style === 'dots') {
        for (let i = 0; i < data.length; i += 2) {
          const x = i / data.length * w + 5;
          const y = hgt - (data[i] / 255) * hgt;
          ctx2d.beginPath();
          ctx2d.arc(x, y, 3, 0, Math.PI * 2);
          ctx2d.fill();
        }
      } else {
        const bars = Math.min(48, data.length);
        const gap = 5;
        const bw = (w - gap * (bars - 1)) / bars;
        for (let i = 0; i < bars; i++) {
          const bh = Math.max(5, data[i] / 255 * hgt * 0.9);
          const x = i * (bw + gap);
          ctx2d.beginPath();
          ctx2d.roundRect(x, hgt - bh, bw, bh, 4);
          ctx2d.fill();
        }
      }
    };
    draw();
  }

  K.actions['visualizer-stop'] = () => {
    stopVisualizer();
    K.toast('Visualizer stopped', '', 'ok');
    if (K.current.route === 'plugins') K.render();
  };

  // ---------------------------------------------------------------------
  // logs
  // ---------------------------------------------------------------------
  K.logFilter = K.logFilter || 'ALL';
  K.logSearch = K.logSearch || '';

  K.screens.logs = {
    title: 'Logs',
    render() {
      const logs = K.get('logs', []) || [];
      const filter = K.logFilter || 'ALL';
      const query = (K.logSearch || '').toLowerCase();
      const visible = logs.filter(log => {
        if (filter !== 'ALL' && log.level !== filter) return false;
        if (query && !(log.tag + ' ' + log.message).toLowerCase().includes(query)) return false;
        return true;
      });
      return `<div class="page">
        ${pageHead('Logs', 'What Kizzey is doing, quietly.', `<button class="icon-btn" data-action="log-download" aria-label="Download logs">${K.icon('download')}</button>`)}
        <div class="chips" style="margin-bottom:10px">
          ${['ALL', 'INFO', 'WARN', 'ERROR', 'DEBUG'].map(level => `<button class="chip-toggle ${filter === level ? 'active' : ''}" data-action="log-filter" data-level="${level}">${level}</button>`).join('')}
        </div>
        <div class="input-row" style="margin-bottom:12px">
          <div class="input-wrap" style="flex:1">${K.icon('search', 'sm')}<input id="log-search" class="input" style="padding-left:38px" data-local="log-search" value="${h(K.logSearch)}" placeholder="Filter tags and messages"></div>
          <button class="btn btn-ghost btn-sm" data-action="log-clear">${K.icon('trash', 'sm')}Clear</button>
        </div>
        <div class="card soft" style="padding:12px 14px">
          ${visible.length ? visible.map(log => `<div class="log-row" data-log-row data-search="${h((log.tag + ' ' + log.message).toLowerCase())}">
            <span class="lt">${K.esc(new Date(log.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</span>
            <span class="ll ${h(log.level)}">${h(log.level)}</span>
            <span class="lm"><span class="tag">[${h(log.tag)}]</span> ${h(log.message)}</span>
            <button class="icon-btn small" data-copy="${h(`[${log.level}] [${log.tag}] ${log.message}`)}" aria-label="Copy log">${K.icon('copy', 'sm')}</button>
          </div>`).join('') : K.empty('terminal', 'No logs here', filter === 'ALL' ? 'Kizzey will write its first event soon.' : 'Try another level or clear the search.', '')}
        </div>
        <div class="card-row between" style="margin-top:12px"><span class="tiny muted">${visible.length} of ${logs.length} entries · newest first</span><button class="btn btn-ghost btn-sm" data-action="log-download">${K.icon('download', 'sm')}Export</button></div>
        <div style="height:20px"></div>
      </div>`;
    },
    mount(root) {
      const input = root.querySelector('#log-search');
      input?.addEventListener('input', () => {
        K.logSearch = input.value;
        const q = input.value.trim().toLowerCase();
        root.querySelectorAll('[data-log-row]').forEach(row => {
          row.classList.toggle('hidden', !!q && !row.dataset.search.includes(q));
        });
      });
    },
    onLog() {
      if (K.current.route !== 'logs') return;
      if (document.activeElement?.matches('input, textarea, select')) return;
      K.render();
    },
  };

  K.actions['log-filter'] = el => {
    K.logFilter = el.dataset.level || 'ALL';
    K.render();
  };

  K.actions['log-clear'] = () => {
    K.confirm({
      title: 'Clear the in-app log?',
      subtitle: 'This does not delete your Discord account or presence settings.',
      confirm: 'Clear logs', danger: true,
      onConfirm: async () => {
        try {
          const data = await K.api('/api/logs/clear', { method: 'POST', body: {} });
          K.state.logs = data.logs || [];
          K.toast('Logs cleared', '', 'ok');
          K.render();
        } catch (error) { K.toast('Could not clear logs', error.message, 'error'); }
      },
    });
  };

  K.actions['log-download'] = () => {
    const logs = K.get('logs', []) || [];
    const text = logs.map(log => `${new Date(log.time).toISOString()} [${log.level}] [${log.tag}] ${log.message}`).join('\n');
    K.download(`kizzey-logs-${new Date().toISOString().slice(0, 10)}.txt`, text, 'text/plain');
    K.toast('Logs exported', `${logs.length} entries`, 'ok');
  };
})();
