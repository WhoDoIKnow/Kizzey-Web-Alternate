/* Kizzey Web — Discord voice: join a channel, play music, record the call.
   The heavy lifting happens in the optional voice_service companion; this
   screen only reads and writes the JSON endpoints the Kizzey server proxies. */
(function () {
  'use strict';
  const K = window.K;
  const h = K.esc;

  K.discordVoice = K.discordVoice || {
    loaded: false,
    configured: false,
    reachable: false,
    error: '',
    health: null,
    state: null,
    recordings: [],
    timer: 0,
    form: { guildId: '', channelId: '', query: '', mode: 'mix', bitrate: '32', mix: true },
  };

  function D() { return K.discordVoice; }

  function fmtBytes(value) {
    const n = Number(value || 0);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function fmtDate(ms) {
    if (!ms) return '';
    try { return new Date(Number(ms)).toLocaleString(); } catch { return ''; }
  }

  function tone(active) { return active ? 'good' : ''; }

  async function refresh() {
    let data = null;
    try {
      data = await K.api('/api/voice/discord');
    } catch (error) {
      D().loaded = true;
      D().reachable = false;
      D().configured = false;
      D().error = error.message || 'The voice service is unavailable.';
      paint();
      return;
    }
    D().loaded = true;
    D().configured = !!data.configured;
    D().reachable = !!data.reachable;
    D().error = data.error || '';
    D().health = data.health || null;
    D().state = data.state || null;
    D().recordings = data.recordings || [];
    paint();
  }

  function statusMarkup(state) {
    if (!D().configured) {
      return `<div class="card soft"><div class="card-row"><div class="feature-icon" style="width:40px;height:40px;background:var(--surface-2);color:var(--primary)">${K.icon('info')}</div><div><div class="card-title" style="font-size:0.8125rem">Voice service not configured</div><div class="card-sub">Start the voice companion from <b>voice_service/</b> (the launcher does this) and point <b>KIZZEY_VOICE_URL</b> at it. Voice reuses the Discord token already saved for RPC.</div></div></div></div>`;
    }
    if (!D().reachable) {
      return `<div class="card soft"><div class="card-row"><div class="feature-icon" style="width:40px;height:40px;background:rgba(255,120,120,.14);color:#ffb4ab">${K.icon('alert-circle')}</div><div><div class="card-title" style="font-size:0.8125rem">Voice service unreachable</div><div class="card-sub">${h(D().error || 'The server could not reach the voice service.')}</div></div></div><div style="margin-top:10px"><button class="btn btn-tonal btn-sm" data-action="dv-refresh">${K.icon('refresh', 'sm')}Try again</button></div></div>`;
    }
    const health = D().health || {};
    const chips = [
      `<span class="chip ${tone(state.ready)}">${state.ready ? 'Discord ready' : 'Discord starting'}</span>`,
      `<span class="chip ${tone(health.ffmpeg)}">${health.ffmpeg ? 'ffmpeg' : 'no ffmpeg'}</span>`,
      `<span class="chip ${tone(!!(state.ytdlp || health.ytdlp))}">${state.ytdlp || health.ytdlp ? 'yt-dlp' : 'no yt-dlp'}</span>`,
      `<span class="chip ${state.dave === true ? 'good' : state.dave === false ? 'bad' : ''}">${state.dave === true ? 'DAVE encrypted' : state.dave === false ? 'no DAVE' : 'DAVE n/a'}</span>`,
      `<span class="chip ${state.backend === 'pycord' ? 'good' : state.backend ? 'warn' : 'bad'}">${state.backend === 'pycord' ? 'py-cord receive' : state.backend ? state.backend.replace('_', '-') + ' receive' : 'no receive'}</span>`,
    ].join(' ');
    return `<div class="card soft"><div class="card-row between"><div><div class="card-title" style="font-size:0.8125rem">Voice service</div><div class="card-sub">${h(D().url || '')}</div></div><button class="btn btn-ghost btn-sm" data-action="dv-refresh">${K.icon('refresh', 'sm')}Refresh</button></div><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">${chips}</div></div>`;
  }

  function connectionMarkup(state) {
    if (state.connected) {
      return `<div class="card-row between"><div><div class="tiny good">Connected${state.channelName ? ' · ' + h(state.channelName) : ''}</div><div class="mono tiny muted">${h(state.channelId || '')}</div></div><button class="btn btn-ghost btn-sm" data-action="dv-leave">${K.icon('phone', 'sm')}Leave</button></div>`;
    }
    return `<button class="btn btn-primary btn-sm" data-action="dv-join">${K.icon('phone', 'sm')}Join channel</button>`;
  }

  function nowMarkup(state) {
    const current = state.current;
    const playing = !!state.playing;
    const paused = !!state.paused;
    const queue = state.queue || [];
    const controls = `<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button class="btn btn-tonal btn-sm" data-action="dv-toggle">${playing ? K.icon('pause', 'sm') + 'Pause' : K.icon('play', 'sm') + (paused ? 'Resume' : 'Play')}</button>
      <button class="btn btn-ghost btn-sm" data-action="dv-skip">${K.icon('skip-forward', 'sm')}Skip</button>
      <button class="btn btn-ghost btn-sm" data-action="dv-stop">${K.icon('stop', 'sm')}Stop</button>
      <span class="tiny muted" style="margin-left:auto;align-self:center">${Math.round((state.volume || 1) * 100)}%</span>
      <input type="range" min="0" max="150" value="${Math.round((state.volume || 1) * 100)}" data-dv-volume style="width:120px">
    </div>`;
    if (!current && !queue.length) {
      return `<div class="tiny muted">Nothing is playing. Paste a URL or search for a track above.</div>`;
    }
    let body = '';
    if (current) {
      body += `<div class="list-item" style="border:0;padding-left:0"><span class="list-icon">${K.icon('music')}</span><span class="list-body"><span class="list-title">${h(current.title || current.query || 'Track')}</span><span class="list-desc">${playing ? 'Playing' : paused ? 'Paused' : 'Queued'}</span></span></div>`;
    }
    if (queue.length) {
      body += `<div class="tiny muted" style="margin-top:4px">${queue.length} track${queue.length === 1 ? '' : 's'} queued</div>`;
      body += queue.slice(0, 8).map(item => `<div class="tiny muted" style="margin-top:2px">· ${h(item.title || item.query || 'Track')}</div>`).join('');
    }
    return body + controls;
  }

  function recordMarkup(state) {
    const recording = state.recording || {};
    if (recording.active) {
      const tracks = recording.tracks || [];
      const speakers = tracks.filter(t => t.userId !== 'music');
      const hasMusic = tracks.some(t => t.userId === 'music');
      const detail = `${speakers.length} speaker${speakers.length === 1 ? '' : 's'}${hasMusic ? ' · music' : ''}`;
      return `<div class="card-row between"><div><div class="tiny good">Recording · ${h(recording.mode || 'mix')} · ${h(String(recording.bitrate || 32))} kbps</div><div class="tiny muted">Started ${h(fmtDate(recording.startedAt))}${tracks.length ? ' · ' + h(detail) : ''}</div></div><button class="btn btn-ghost btn-sm" data-action="dv-record-stop">${K.icon('stop', 'sm')}Stop</button></div>`;
    }
    return `<button class="btn btn-primary btn-sm" data-action="dv-record-start">${K.icon('radio', 'sm')}Start recording</button>`;
  }

  function recordingsMarkup() {
    const items = D().recordings || [];
    if (!items.length) {
      return `<div class="tiny muted">No recordings yet.</div>`;
    }
    return items.map(item => {
      const label = item.kind === 'mix' ? 'Mixed call' : item.kind === 'compressed' ? 'Compressed' : item.user === 'music' ? 'Music' : (item.user || 'Speaker');
      return `<div class="list-item" style="border-left:0;border-right:0;padding-left:0;padding-right:0">
        <span class="list-icon">${K.icon(item.kind === 'mix' ? 'users' : 'mic')}</span>
        <span class="list-body"><span class="list-title">${h(label)}</span><span class="list-desc">${h(fmtDate(item.created))} · ${h(fmtBytes(item.size))}${item.bitrate ? ' · ' + h(String(item.bitrate)) + ' kbps' : ''}</span></span>
        <a class="icon-btn small" href="/api/voice/discord/recordings/${h(item.id)}" download aria-label="Download">${K.icon('download', 'sm')}</a>
        <button class="icon-btn small" data-action="dv-compress" data-id="${h(item.id)}" title="Compress smaller">${K.icon('refresh', 'sm')}</button>
        <button class="icon-btn small" data-action="dv-delete" data-id="${h(item.id)}" title="Delete">${K.icon('trash', 'sm')}</button>
      </div>`;
    }).join('');
  }

  function paint() {
    const status = document.getElementById('dv-status');
    if (!status) return;
    const state = D().state || {};
    status.innerHTML = statusMarkup(state);
    const conn = document.getElementById('dv-conn');
    if (conn) conn.innerHTML = connectionMarkup(state);
    const now = document.getElementById('dv-now');
    if (now) now.innerHTML = nowMarkup(state);
    const record = document.getElementById('dv-record');
    if (record) record.innerHTML = recordMarkup(state);
    const list = document.getElementById('dv-recordings');
    if (list) list.innerHTML = recordingsMarkup();
  }

  async function act(fn) {
    try {
      await fn();
    } catch (error) {
      K.toast('Voice service', error.message || 'The request failed.', 'error');
    }
    await refresh().catch(() => {});
  }

  K.screens['discord-voice'] = {
    title: 'Discord voice',
    render() {
      const f = D().form;
      return `<div class="page">
        ${K.pageHead({ title: 'Discord voice', sub: 'Join a call, play music and record it — the voice service owns the Discord connection.' })}
        <div id="dv-status" style="margin-bottom:14px">${statusMarkup(D().state || {})}</div>

        <div class="card" style="margin-bottom:14px">
          <div class="card-row" style="margin-bottom:10px"><div class="feature-icon" style="width:40px;height:40px;background:var(--surface-2);color:var(--primary)">${K.icon('phone')}</div><div><div class="card-title" style="font-size:0.875rem">Voice channel</div><div class="card-sub">A bot (or user) account joins the channel. Guild is optional — the channel id is enough.</div></div></div>
          <div id="dv-conn" style="margin-bottom:10px">${connectionMarkup(D().state || {})}</div>
          <div class="field-row" style="display:flex;gap:10px;flex-wrap:wrap">
            <div class="field" style="flex:1;min-width:150px"><label><span>Channel ID</span></label><div class="input-wrap"><input class="input" data-dv="channelId" value="${h(f.channelId)}" placeholder="123456789012345678" autocomplete="off"></div></div>
            <div class="field" style="flex:1;min-width:150px"><label><span>Guild ID (optional)</span></label><div class="input-wrap"><input class="input" data-dv="guildId" value="${h(f.guildId)}" placeholder="Optional" autocomplete="off"></div></div>
          </div>
        </div>

        <div class="card" style="margin-bottom:14px">
          <div class="card-row" style="margin-bottom:10px"><div class="feature-icon" style="width:40px;height:40px;background:var(--surface-2);color:var(--primary)">${K.icon('music')}</div><div><div class="card-title" style="font-size:0.875rem">Music from the web</div><div class="card-sub">Paste a direct audio/video URL, a local path, or a search query.</div></div></div>
          <div class="field"><div class="input-wrap"><input class="input" data-dv="query" value="${h(f.query)}" placeholder="https://… or a song name" autocomplete="off"></div></div>
          <div style="margin-top:10px"><button class="btn btn-primary btn-sm" data-action="dv-play">${K.icon('play', 'sm')}Play</button></div>
          <div id="dv-now" style="margin-top:12px;border-top:1px solid var(--outline);padding-top:10px">${nowMarkup(D().state || {})}</div>
        </div>

        <div class="card" style="margin-bottom:14px">
          <div class="card-row" style="margin-bottom:10px"><div class="feature-icon" style="width:40px;height:40px;background:var(--surface-2);color:var(--primary)">${K.icon('radio')}</div><div><div class="card-title" style="font-size:0.875rem">Record the call</div><div class="card-sub">Each speaker is captured to its own Opus/OGG file. Mixing and extra compression are optional.</div></div></div>
          <div class="field-row" style="display:flex;gap:10px;flex-wrap:wrap">
            <div class="field" style="flex:1;min-width:130px"><label><span>Mode</span></label><select class="select" data-dv="mode"><option value="mix" ${D().form.mode === 'mix' ? 'selected' : ''}>Per speaker + mix</option><option value="tracks" ${D().form.mode === 'tracks' ? 'selected' : ''}>Per speaker only</option></select></div>
            <div class="field" style="flex:1;min-width:110px"><label><span>Opus bitrate</span></label><select class="select" data-dv="bitrate"><option value="16" ${D().form.bitrate === '16' ? 'selected' : ''}>16 kbps · tiny</option><option value="24" ${D().form.bitrate === '24' ? 'selected' : ''}>24 kbps</option><option value="32" ${D().form.bitrate === '32' ? 'selected' : ''}>32 kbps · default</option><option value="48" ${D().form.bitrate === '48' ? 'selected' : ''}>48 kbps</option><option value="64" ${D().form.bitrate === '64' ? 'selected' : ''}>64 kbps</option></select></div>
          </div>
          <div id="dv-record" style="margin-top:10px">${recordMarkup(D().state || {})}</div>
          <div class="field-hint" style="margin-top:8px">Discord encrypts voice end to end (DAVE). If the encryption chip above says <b>no DAVE</b>, recordings will be silent until the voice service is updated.</div>
        </div>

        <div class="section-label"><span>Recordings</span></div>
        <div class="card" id="dv-recordings" style="margin-bottom:14px">${recordingsMarkup()}</div>

        <div class="card soft">
          <div class="card-row"><div class="feature-icon" style="width:40px;height:40px;background:var(--surface-2);color:var(--primary)">${K.icon('info')}</div><div><div class="card-title" style="font-size:0.8125rem">How this works</div><div class="card-sub">Kizzey proxies to a small companion service that joins Discord voice and runs ffmpeg. The Discord token and service token stay on the server, and your browser never receives them. Recordings are Opus/OGG — about 240 KB per minute per speaker at 32 kbps.</div></div></div>
        </div>
        <div style="height:20px"></div>
      </div>`;
    },
    mount(root) {
      root.querySelectorAll('[data-dv]').forEach(el => {
        if (el.dataset.dvBound) return;
        el.dataset.dvBound = '1';
        el.addEventListener('input', () => {
          D().form[el.dataset.dv] = el.type === 'checkbox' ? el.checked : el.value;
        });
        el.addEventListener('change', () => {
          D().form[el.dataset.dv] = el.type === 'checkbox' ? el.checked : el.value;
        });
      });
      if (!root.dataset.dvVolumeBound) {
        root.dataset.dvVolumeBound = '1';
        root.addEventListener('change', event => {
          const slider = event.target.closest('[data-dv-volume]');
          if (!slider) return;
          K.api('/api/voice/discord/control', { method: 'POST', body: { action: 'volume', value: Number(slider.value) / 100 } })
            .then(() => refresh())
            .catch(() => {});
        });
      }
      paint();
      refresh().catch(() => {});
      if (!D().timer) {
        D().timer = setInterval(() => {
          if (K.current.route !== 'discord-voice' || document.hidden) return;
          refresh().catch(() => {});
        }, 6000);
      }
    },
  };

  K.actions['dv-refresh'] = () => refresh();

  K.actions['dv-join'] = () => act(async () => {
    const f = D().form;
    if (!f.channelId) { K.toast('Channel ID needed', 'Paste a voice channel id first.', 'error'); return; }
    await K.api('/api/voice/discord/join', { method: 'POST', body: { channelId: String(f.channelId).trim(), guildId: String(f.guildId || '').trim() } });
    K.toast('Joined Discord voice', '', 'ok');
  });

  K.actions['dv-leave'] = () => act(async () => {
    await K.api('/api/voice/discord/leave', { method: 'POST', body: {} });
    K.toast('Left the voice channel', '', 'ok');
  });

  K.actions['dv-play'] = () => act(async () => {
    const query = String(D().form.query || '').trim();
    if (!query) { K.toast('Nothing to play', 'Paste a URL or search for a track.', 'error'); return; }
    await K.api('/api/voice/discord/play', { method: 'POST', body: { query, volume: 1 } });
  });

  K.actions['dv-toggle'] = () => act(async () => {
    const state = D().state || {};
    const action = state.playing ? 'pause' : 'resume';
    await K.api('/api/voice/discord/control', { method: 'POST', body: { action } });
  });

  K.actions['dv-skip'] = () => act(() => K.api('/api/voice/discord/control', { method: 'POST', body: { action: 'skip' } }));

  K.actions['dv-stop'] = () => act(() => K.api('/api/voice/discord/control', { method: 'POST', body: { action: 'stop' } }));

  K.actions['dv-record-start'] = () => act(async () => {
    const f = D().form;
    await K.api('/api/voice/discord/record', { method: 'POST', body: { action: 'start', mode: f.mode, bitrate: Number(f.bitrate) || 32, mix: f.mode !== 'tracks' } });
    K.toast('Recording the call', 'Files land in the recordings list as you talk.', 'ok');
  });

  K.actions['dv-record-stop'] = () => act(async () => {
    await K.api('/api/voice/discord/record', { method: 'POST', body: { action: 'stop' } });
    K.toast('Recording saved', 'Compressed Opus/OGG is ready to download.', 'ok');
  });

  K.actions['dv-compress'] = el => {
    const id = el.dataset.id;
    const bitrate = Number(window.prompt('Compress this recording to which bitrate (kbps)?', '24')) || 24;
    return act(async () => {
      await K.api('/api/voice/discord/recordings/compress', { method: 'POST', body: { id, bitrate } });
      K.toast('Recording compressed', bitrate + ' kbps Opus added.', 'ok');
    });
  };

  K.actions['dv-delete'] = el => act(async () => {
    await K.api('/api/voice/discord/recordings/delete', { method: 'POST', body: { id: el.dataset.id } });
  });
})();
