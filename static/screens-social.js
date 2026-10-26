/* Kizzey Web — chat, voice, moments and community ranking */
(function () {
  'use strict';
  const K = window.K;
  const h = K.esc;

  // ---------------------------------------------------------------------
  // chat
  // ---------------------------------------------------------------------
  K.chatAttach = K.chatAttach || '';
  K.chatReply = K.chatReply || null;
  K.chatRoomsOpen = false;

  function activeRoom() {
    const rooms = K.get('chat.rooms', []) || [];
    let room = rooms.find(r => r.id === K.local.activeRoom);
    if (!room && rooms.length) {
      room = rooms[0];
      K.local.activeRoom = room.id;
    }
    return room || { id: 'lounge', name: 'Lounge', emoji: '🛋️', topic: '', members: 0 };
  }

  function roomMessages(roomId) {
    return K.get(`chat.messages.${roomId}`, []) || [];
  }

  function findMessage(roomId, id) {
    return roomMessages(roomId).find(m => m.id === id) || null;
  }

  function messageMarkup(message, roomId) {
    const me = K.get('chatProfile.name', 'You');
    const replied = message.replyTo ? findMessage(roomId, message.replyTo) : null;
    const reactions = Object.entries(message.reactions || {}).map(([emoji, people]) => {
      const mine = (people || []).includes(me);
      return `<button class="reaction ${mine ? 'mine' : ''}" data-action="chat-react" data-id="${h(message.id)}" data-emoji="${h(emoji)}" title="${h((people || []).join(', '))}">${h(emoji)} <span>${(people || []).length}</span></button>`;
    }).join('');
    const attach = message.attach ? `<div class="message-attach" style="margin-top:7px;border-radius:14px;overflow:hidden;max-width:280px;border:1px solid var(--hairline)"><img src="${h(message.attach)}" alt="Attachment" style="display:block;width:100%;max-height:260px;object-fit:cover" loading="lazy"></div>` : '';
    return `<div class="message ${message.system ? 'system' : ''} ${message.replyTo ? 'reply' : ''} ${message.local ? 'mine' : ''}" data-message-id="${h(message.id)}">
      ${K.avatar({ name: message.author || 'Kizzey', url: message.avatar || '', cls: '', style: `background:${message.color || '#d0bcff'}22;color:${message.color || '#d0bcff'}` })}
      <div class="message-body">
        <div class="message-head"><span class="message-author" style="color:${h(message.color || 'var(--text)')}">${h(message.author || 'Kizzey')}</span><span class="message-time">${h(K.relTime(message.time))}</span>${message.local ? '<span class="badge plain" style="font-size:0.4375rem;padding:1px 4px">YOU</span>' : ''}</div>
        ${replied ? `<div class="tiny muted" style="margin-top:2px">↳ ${h(replied.author)} · ${h((replied.text || 'attachment').slice(0, 70))}</div>` : ''}
        ${message.text ? `<div class="message-text">${h(message.text)}</div>` : ''}
        ${attach}
        ${reactions ? `<div class="message-actions">${reactions}</div>` : ''}
        <div class="message-actions">
          <button class="msg-action" data-action="chat-react-picker" data-id="${h(message.id)}" aria-label="Add reaction">＋ react</button>
          <button class="msg-action" data-action="chat-reply" data-id="${h(message.id)}" aria-label="Reply">reply</button>
          <button class="msg-action" data-copy="${h(message.text || message.attach || '')}" aria-label="Copy message">copy</button>
        </div>
      </div>
    </div>`;
  }

  function scrollChatDown(smooth = false) {
    const el = document.getElementById('chat-messages');
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
  }

  function chatFloaters() {
    let box = document.getElementById('chat-floaters');
    if (!box) {
      box = document.createElement('div');
      box.id = 'chat-floaters';
      box.className = 'chat-floaters';
      document.querySelector('.chat-shell')?.appendChild(box);
    }
    return box;
  }

  function tidyFloaters() {
    const box = document.getElementById('chat-floaters');
    if (box && !box.children.length) box.remove();
  }

  function updateReplyPreview() {
    let preview = document.getElementById('chat-reply-preview');
    if (!K.chatReply) { preview?.remove(); tidyFloaters(); return; }
    if (!preview) {
      preview = document.createElement('div');
      preview.id = 'chat-reply-preview';
      preview.className = 'chat-reply-preview';
      chatFloaters().appendChild(preview);
    }
    preview.innerHTML = `<div style="flex:1;min-width:0"><div class="tiny" style="color:var(--primary)">Replying to ${h(K.chatReply.author)}</div><div class="tiny muted ellipsis">${h((K.chatReply.text || 'Attachment').slice(0, 90))}</div></div><button class="icon-btn small" data-action="chat-reply-clear" aria-label="Cancel reply">${K.icon('close', 'sm')}</button>`;
  }

  function updateAttachPreview() {
    let el = document.getElementById('chat-attach-preview');
    if (!K.chatAttach) { el?.remove(); tidyFloaters(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'chat-attach-preview';
      el.className = 'chat-attach-preview';
      chatFloaters().appendChild(el);
    }
    el.innerHTML = `<img src="${h(K.chatAttach)}" alt=""><div style="flex:1"><div class="tiny">Image ready</div><div class="tiny muted">Press send to share</div></div><button class="icon-btn small" data-action="chat-attach-remove" aria-label="Remove attachment">${K.icon('close', 'sm')}</button>`;
  }

  function upsertMessage(roomId, message) {
    if (!K.state?.chat?.messages) return;
    const list = K.state.chat.messages[roomId] = K.state.chat.messages[roomId] || [];
    const idx = list.findIndex(m => m.id === message.id);
    if (idx >= 0) list[idx] = message; else list.push(message);
    if (list.length > 250) list.splice(0, list.length - 250);
    if (K.current.route !== 'chat' || K.local.activeRoom !== roomId) return;
    const current = document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
    if (current) {
      current.outerHTML = messageMarkup(message, roomId);
    } else {
      document.getElementById('chat-messages')?.insertAdjacentHTML('beforeend', messageMarkup(message, roomId));
      scrollChatDown(true);
    }
  }

  K.onChatEvent = data => {
    if (!data?.room || !data?.message) return;
    const message = data.message;
    if (
      document.hidden &&
      K.get('settings.notifications', false) &&
      K.get('chatProfile.status', 'online') !== 'dnd' &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    ) {
      try {
        const roomName = (K.get('chat.rooms', []) || []).find(r => r.id === data.room)?.name || data.room;
        const note = new Notification(`${message.author || 'Kizzey Chat'} in ${roomName}`, {
          body: String(message.text || 'Sent an image').slice(0, 140),
          icon: '/icon.png',
          tag: 'kizzey-' + data.room,
          silent: !K.get('settings.notificationSound', true),
        });
        note.onclick = () => { window.focus(); location.hash = '#/chat'; note.close(); };
      } catch {}
    }
    if (K.current.route !== 'chat') return;
    upsertMessage(data.room, message);
  };

  async function sendChat() {
    const room = activeRoom();
    const input = document.getElementById('chat-input');
    const text = input ? input.value.trim() : '';
    if (!text && !K.chatAttach) { input?.focus(); return; }
    try {
      const data = await K.api('/api/chat/send', {
        method: 'POST',
        body: { room: room.id, text, attach: K.chatAttach, replyTo: K.chatReply?.id || null },
      });
      if (input) input.value = '';
      K.chatAttach = '';
      K.chatReply = null;
      document.getElementById('chat-reply-preview')?.remove();
      document.getElementById('chat-attach-preview')?.remove();
      tidyFloaters();
      upsertMessage(room.id, data.message);
      scrollChatDown(true);
    } catch (error) {
      K.toast('Message not sent', error.message, 'error');
    }
  }
  K.sendChat = sendChat;

  K.screens.chat = {
    title: 'Kizzey Chat',
    render() {
      const room = activeRoom();
      const rooms = K.get('chat.rooms', []) || [];
      const messages = roomMessages(room.id);
      const online = rooms.reduce((sum, item) => sum + (item.members || 0), 0);
      return `<div class="page"><div class="chat-shell">
        <div class="chat-head">
          <button class="icon-btn" data-action="open-drawer" aria-label="Open menu">${K.icon('menu')}</button>
          <div class="chat-title"><h1>${h(room.name)}</h1><div class="online"><span class="dot"></span>${online} members · ${h(room.topic || 'Say hello')}</div></div>
          <button class="icon-btn" data-action="chat-rooms" aria-label="Switch room">${K.icon('hash')}</button>
          <button class="icon-btn" data-route="voice" aria-label="Voice room">${K.icon('mic')}</button>
        </div>
        <div class="room-strip">${rooms.map(item => `<button class="room-pill ${item.id === room.id ? 'active' : ''}" data-action="chat-room" data-room="${h(item.id)}">${h(item.emoji || '')} ${h(item.name)}</button>`).join('')}</div>
        <div class="messages" id="chat-messages">
          <div class="chat-intro">${h(room.topic || 'This room lives on your Kizzey server.')} · messages sync over SSE.</div>
          ${messages.map(message => messageMarkup(message, room.id)).join('')}
        </div>
        <div class="chat-composer">
          <button class="icon-btn" data-action="chat-attach" aria-label="Attach image">${K.icon('plus')}</button>
          <input id="chat-input" class="input" autocomplete="off" placeholder="Message #${h(room.id)}" maxlength="2000">
          <button class="btn send" data-action="chat-send" aria-label="Send">${K.icon('send')}</button>
        </div>
      </div></div>`;
    },
    mount(root) {
      scrollChatDown(false);
      const input = root.querySelector('#chat-input');
      input?.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChat(); }
      });
      setTimeout(() => input?.focus({ preventScroll: true }), 220);
      updateReplyPreview();
      updateAttachPreview();
    },
    onChatEvent(data) {
      K.onChatEvent(data);
    },
  };

  K.actions['chat-room'] = async el => {
    const room = el.dataset.room || 'lounge';
    K.local.activeRoom = room;
    localStorage.setItem('kizzey.room', room);
    K.chatAttach = '';
    K.chatReply = null;
    K.closeSheet();
    K.render();
  };

  K.actions['chat-rooms'] = () => {
    const rooms = K.get('chat.rooms', []) || [];
    K.sheet({
      title: 'Rooms',
      subtitle: 'Every room is hosted by this Kizzey server.',
      body: `<div class="list">${rooms.map(room => {
        const count = roomMessages(room.id).length;
        return `<button class="list-item" data-action="chat-room" data-room="${h(room.id)}">
          <span class="list-icon" style="font-size:1.125rem">${h(room.emoji || '#')}</span>
          <span class="list-body"><span class="list-title">${h(room.name)}</span><span class="list-desc">${h(room.topic || '')} · ${count} messages</span></span>
          <span class="list-end">${room.id === activeRoom().id ? K.icon('check', 'sm') : K.icon('chevron-right', 'sm')}</span>
        </button>`;
      }).join('')}</div>
      <div class="modal-actions"><button class="btn btn-ghost" data-route="voice">${K.icon('mic', 'sm')}Voice rooms</button><button class="btn btn-primary" data-close-sheet>Done</button></div>`,
    });
  };

  K.actions['chat-send'] = () => sendChat();

  K.actions['chat-attach'] = () => {
    K.bindFilePicker(async file => {
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const data = await K.api('/api/chat/upload', { method: 'POST', body: { data: dataUrl, filename: file.name } });
        K.chatAttach = data.url;
        updateAttachPreview();
        document.getElementById('chat-input')?.focus({ preventScroll: true });
        K.toast('Image attached', 'Press send to put it in the room.', 'ok');
      } catch (error) {
        K.toast('Could not attach image', error.message, 'error');
      }
    }, 'image/*');
  };

  K.actions['chat-attach-remove'] = () => { K.chatAttach = ''; updateAttachPreview(); };

  K.actions['chat-reply'] = el => {
    const room = activeRoom();
    const msg = findMessage(room.id, el.dataset.id);
    if (!msg) return;
    K.chatReply = msg;
    updateReplyPreview();
    document.getElementById('chat-input')?.focus({ preventScroll: true });
  };

  K.actions['chat-reply-clear'] = () => { K.chatReply = null; updateReplyPreview(); };

  K.actions['chat-react'] = async el => {
    const room = activeRoom();
    const id = el.dataset.id;
    const emoji = el.dataset.emoji || '✨';
    try {
      const data = await K.api('/api/chat/react', { method: 'POST', body: { room: room.id, id, emoji } });
      K.closeSheet();
      upsertMessage(room.id, data.message);
    } catch (error) {
      K.toast('Reaction failed', error.message, 'error');
    }
  };

  K.actions['chat-react-picker'] = el => {
    const id = el.dataset.id;
    K.sheet({
      title: 'Add a reaction',
      subtitle: 'A small signal, delivered to everyone in the room.',
      body: `<div class="chips" style="justify-content:center">${['✨', '💜', '🔥', '🎮', '🎧', '😂', '👏', '🫶'].map(emoji => `<button class="reaction" style="font-size:1.375rem;padding:9px 13px" data-action="chat-react" data-id="${h(id)}" data-emoji="${h(emoji)}">${emoji}</button>`).join('')}</div>`,
    });
  };

  // ---------------------------------------------------------------------
  // voice room
  // ---------------------------------------------------------------------
  K.voiceRoom = K.voiceRoom || 'lounge';
  K.voice = K.voice || { joined: false, stream: null, ctx: null, analyser: null, raf: 0, heartbeat: null, poll: null, speaking: false };

  function voiceParticipants(roomId) {
    return ((K.get('chat.voice.participants', []) || [])).filter(p => p.room === roomId && (Date.now() - (p.seen || 0) < 90_000));
  }

  function voiceTilesMarkup(participants, roomId) {
    const all = participants.slice();
    if (!all.length) {
      return `<div class="empty" style="padding:20px 8px;grid-column:1/-1"><div class="empty-icon">${K.icon('mic', 'lg')}</div><h3>No one else here</h3><p>Join the room. Your mic test stays on this device.</p></div>`;
    }
    return all.map(p => {
      const self = p.clientId === K.clientId;
      const speaking = self ? K.voice.speaking : p.speaking;
      return `<div class="voice-tile ${speaking ? 'speaking' : ''}" data-voice-client="${h(p.clientId)}">
        ${K.avatar({ name: p.name || 'Friend', url: p.avatar || '', cls: '', style: `background:${p.color || '#d0bcff'}22;color:${p.color || '#d0bcff'}` })}
        <span class="vname">${h(p.name || 'Friend')}${self ? ' · you' : ''}</span>
        <span class="tiny ${p.muted ? 'muted' : 'good'}">${p.deafened ? K.icon('headphones-off', 'sm') : p.muted ? K.icon('mic-off', 'sm') : K.icon('mic', 'sm')} ${p.deafened ? 'Deafened' : p.muted ? 'Muted' : 'Mic on'}</span>
      </div>`;
    }).join('');
  }

  function updateVoiceTiles() {
    const el = document.getElementById('voice-tiles');
    if (!el) return;
    el.innerHTML = voiceTilesMarkup(voiceParticipants(K.voiceRoom), K.voiceRoom);
  }

  function voiceUrl(room) {
    return `${location.origin}${location.pathname}#/voice?room=${encodeURIComponent(room)}`;
  }

  async function joinVoice(room) {
    const data = await K.api('/api/voice/join', { method: 'POST', body: { room, clientId: K.clientId } });
    K.state.chat.voice = data.voice;
    K.voice.joined = true;
    clearInterval(K.voice.heartbeat);
    clearInterval(K.voice.poll);
    K.voice.heartbeat = setInterval(async () => {
      if (!K.voice.joined || document.hidden) return;
      try {
        const res = await K.api('/api/voice/heartbeat', { method: 'POST', body: { clientId: K.clientId } });
        if (res.voice && K.state?.chat) K.state.chat.voice = res.voice;
        updateVoiceTiles();
      } catch {}
    }, 20000);
    K.voice.poll = setInterval(() => {
      if (!K.voice.joined || document.hidden || K.current.route !== 'voice') return;
      fetch('/api/voice').then(r => r.json()).then(res => {
        if (res.voice && K.state?.chat) {
          K.state.chat.voice = res.voice;
          updateVoiceTiles();
        }
      }).catch(() => {});
    }, 12000);
  }

  K.leaveVoice = async function leaveVoice(silent = false) {
    clearInterval(K.voice.heartbeat);
    clearInterval(K.voice.poll);
    K.voice.heartbeat = null;
    K.voice.poll = null;
    stopMic(false);
    if (!K.voice.joined) return;
    K.voice.joined = false;
    try {
      const data = await K.api('/api/voice/leave', { method: 'POST', body: { clientId: K.clientId } });
      if (K.state?.chat) K.state.chat.voice = data.voice;
    } catch {}
    if (!silent && K.current.route === 'voice') K.render();
  };

  K.actions['voice-join'] = async () => {
    try {
      await joinVoice(K.voiceRoom);
      K.toast('Joined the room', 'Presence only · audio is not relayed in this build.', 'ok');
      K.render();
    } catch (error) {
      K.toast('Could not join', error.message, 'error');
    }
  };

  K.actions['voice-leave'] = () => K.leaveVoice(false);

  K.actions['voice-room'] = async el => {
    const room = el.dataset.room || 'lounge';
    K.voiceRoom = room;
    if (K.voice.joined) {
      try { await joinVoice(room); } catch (error) { K.toast('Room switch failed', error.message, 'error'); }
    }
    K.render();
  };

  K.actions['voice-copy'] = () => K.copy(voiceUrl(K.voiceRoom), 'Voice room link copied');

  K.actions['voice-mute'] = async () => {
    if (!K.voice.joined) { K.toast('Join the room first', '', 'error'); return; }
    const participant = voiceParticipants(K.voiceRoom).find(p => p.clientId === K.clientId);
    const muted = !participant?.muted;
    try {
      const data = await K.api('/api/voice/state', { method: 'POST', body: { clientId: K.clientId, muted } });
      K.state.chat.voice = data.voice;
      if (muted) stopMic(false);
      updateVoiceTiles();
      if (K.current.route === 'voice') K.render();
      K.toast(muted ? 'Microphone muted' : 'Microphone unmuted', '', 'ok');
    } catch (error) { K.toast('Could not update mic', error.message, 'error'); }
  };

  K.actions['voice-deafen'] = async () => {
    if (!K.voice.joined) { K.toast('Join the room first', '', 'error'); return; }
    const participant = voiceParticipants(K.voiceRoom).find(p => p.clientId === K.clientId);
    const deafened = !participant?.deafened;
    try {
      const data = await K.api('/api/voice/state', { method: 'POST', body: { clientId: K.clientId, deafened } });
      K.state.chat.voice = data.voice;
      if (deafened) stopMic(false);
      updateVoiceTiles();
      K.render();
    } catch (error) { K.toast('Could not update audio', error.message, 'error'); }
  };

  function sendSpeaking(value) {
    if (!K.voice.joined) return;
    const now = Date.now();
    if (K.voice.lastSpeaking === value || now - (K.voice.lastSent || 0) < 900) return;
    K.voice.lastSpeaking = value;
    K.voice.lastSent = now;
    K.api('/api/voice/state', { method: 'POST', body: { clientId: K.clientId, speaking: value } }).catch(() => {});
    const tile = document.querySelector('.voice-tile[data-voice-client="' + CSS.escape(K.clientId) + '"]');
    tile?.classList.toggle('speaking', value);
  }

  function stopMic(render = true) {
    if (K.voice.raf) cancelAnimationFrame(K.voice.raf);
    K.voice.raf = 0;
    K.voice.stream?.getTracks().forEach(track => track.stop());
    K.voice.stream = null;
    K.voice.ctx?.close().catch(() => {});
    K.voice.ctx = null;
    K.voice.analyser = null;
    K.voice.speaking = false;
    sendSpeaking(false);
    const meter = document.querySelector('.mic-meter span');
    if (meter) meter.style.width = '0%';
    if (render && K.current.route === 'voice') K.render();
  }
  K.stopVoiceMic = stopMic;

  K.actions['voice-mic'] = async () => {
    if (K.voice.stream) { stopMic(); return; }
    const me = K.voice.joined ? voiceParticipants(K.voiceRoom).find(p => p.clientId === K.clientId) : null;
    if (me?.muted || me?.deafened) { K.toast('Microphone is off', 'Unmute yourself before starting the local mic test.', 'error'); return; }
    if (!navigator.mediaDevices?.getUserMedia) { K.toast('Microphone unavailable', 'This browser has no getUserMedia.', 'error'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      K.voice.stream = stream;
      K.voice.ctx = ctx;
      K.voice.analyser = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!K.voice.stream) return;
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((s, v) => s + v, 0) / data.length;
        const pct = Math.min(100, Math.round(avg / 120 * 100));
        const meter = document.querySelector('.mic-meter span');
        if (meter) meter.style.width = pct + '%';
        const speaking = avg > 24;
        if (speaking !== K.voice.speaking) {
          K.voice.speaking = speaking;
          sendSpeaking(speaking);
        }
        K.voice.raf = requestAnimationFrame(tick);
      };
      tick();
      K.toast('Mic test on', 'The meter is local; voice audio is not transmitted.', 'ok');
      K.render();
    } catch (error) {
      K.toast('Microphone permission denied', error.message, 'error');
    }
  };

  K.screens.voice = {
    title: 'Voice',
    render(opts = {}) {
      if (opts.params?.room) K.voiceRoom = opts.params.room;
      const rooms = K.get('chat.rooms', []) || [];
      const participants = voiceParticipants(K.voiceRoom);
      const self = participants.find(p => p.clientId === K.clientId);
      const me = voiceParticipants(K.voiceRoom);
      if (K.voice.joined && !self) K.voice.joined = false;
      return `<div class="page">
        ${K.pageHead({ title: 'Voice', sub: 'A room, a mic test, and no live audio relay.', actions: `<button class="icon-btn" data-action="voice-copy" aria-label="Copy invite">${K.icon('share')}</button>` })}
        <div class="voice-stage">
          <div class="card-row between"><div><div class="tiny" style="color:rgba(255,255,255,.5);text-transform:uppercase;letter-spacing:.1em;font-weight:700">Voice room</div><h2 style="font-size:1.75rem;letter-spacing:-.04em;margin:5px 0 3px;color:#fff8ff">${h(rooms.find(r => r.id === K.voiceRoom)?.name || K.voiceRoom)}</h2><div class="tiny" style="color:rgba(255,255,255,.55)">${participants.length} in the room · presence syncs through your server</div></div><div class="feature-icon" style="width:48px;height:48px;background:rgba(255,255,255,.08);color:#f1dcff">${K.icon('mic')}</div></div>
          <div class="voice-tiles" id="voice-tiles">${voiceTilesMarkup(participants, K.voiceRoom)}</div>
          <div class="mic-meter"><span></span></div>
          <div class="voice-controls">
            <button class="vc ${self?.muted ? 'off' : ''}" data-action="voice-mute" title="Mute">${self?.muted ? K.icon('mic-off') : K.icon('mic')}</button>
            <button class="vc ${self?.deafened ? 'off' : ''}" data-action="voice-deafen" title="Deafen">${self?.deafened ? K.icon('headphones-off') : K.icon('headphones')}</button>
            <button class="vc ${K.voice.stream ? 'off' : ''}" data-action="voice-mic" title="Mic test">${K.voice.stream ? K.icon('mic-off') : K.icon('activity')}</button>
            ${K.voice.joined ? `<button class="vc leave" data-action="voice-leave">Leave</button>` : `<button class="vc" style="width:auto;padding:0 17px;background:var(--primary);color:var(--on-primary);border:0;font-size:0.75rem;font-weight:650" data-action="voice-join">Join room</button>`}
          </div>
        </div>
        <div class="room-strip" style="margin-bottom:14px">${rooms.map(room => `<button class="room-pill ${room.id === K.voiceRoom ? 'active' : ''}" data-action="voice-room" data-room="${h(room.id)}">${h(room.emoji || '')} ${h(room.name)}</button>`).join('')}</div>
        <div class="list">
          <div class="list-item"><span class="list-icon">${K.icon('users')}</span><span class="list-body"><span class="list-title">Community room</span><span class="list-desc">Join from another browser on your network and the participant list updates live.</span></span></div>
          <button class="list-item" data-route="chat"><span class="list-icon">${K.icon('message-circle')}</span><span class="list-body"><span class="list-title">Chat instead</span><span class="list-desc">The room has a text channel too.</span></span>${K.icon('chevron-right', 'sm')}</button>
          <button class="list-item" data-action="voice-copy"><span class="list-icon">${K.icon('share')}</span><span class="list-body"><span class="list-title">Copy invite link</span><span class="list-desc">Share a direct link to this voice room.</span></span>${K.icon('copy', 'sm')}</button>
        </div>
        <div class="card soft" style="margin-top:14px">
          <div class="card-row"><div class="feature-icon" style="width:40px;height:40px;background:var(--surface-2);color:var(--primary)">${K.icon('info')}</div><div><div class="card-title" style="font-size:0.8125rem">About voice</div><div class="card-sub">The room roster, mute state and mic meter are real. Live voice transmission needs a WebRTC signaling backend, which this Python build does not include.</div></div></div>
        </div>
        <div style="height:20px"></div>
      </div>`;
    },
    mount() {
      updateVoiceTiles();
    },
  };

  setInterval(() => {
    if (K.voice.joined && K.current.route !== 'voice') K.leaveVoice(true);
  }, 2000);

  window.addEventListener('beforeunload', () => {
    if (!K.voice.joined) return;
    try {
      fetch('/api/voice/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: K.clientId }), keepalive: true });
    } catch {}
  });

  // ---------------------------------------------------------------------
  // moments
  // ---------------------------------------------------------------------
  K.momentTag = K.momentTag || 'moment';
  const MOMENT_TAGS = [
    { value: 'moment', label: 'Moment' },
    { value: 'listening', label: 'Listening' },
    { value: 'game', label: 'Gaming' },
    { value: 'release', label: 'Release' },
    { value: 'win', label: 'Win' },
  ];

  function momentsList(moments) {
    const me = K.get('chatProfile.name', 'You');
    if (!moments.length) return K.empty('sparkles', 'No moments yet', 'Share a small update with the community.', '');
    return moments.map(moment => {
      const liked = (moment.likes || []).includes(me);
      return `<article class="moment">
        <div class="moment-head">
          ${K.avatar({ name: moment.author || 'Kizzey', url: moment.avatar || '', cls: '', style: `background:${moment.color || '#d0bcff'}22;color:${moment.color || '#d0bcff'}` })}
          <div style="flex:1;min-width:0"><div class="moment-author">${h(moment.author || 'Kizzey')}</div><div class="moment-time">${h(K.relTime(moment.time))} · ${h(moment.tag || 'moment')}</div></div>
          <span class="badge plain">${h(moment.tag || 'moment')}</span>
        </div>
        <div class="moment-text">${h(moment.text)}</div>
        <div class="moment-foot">
          <button class="${liked ? 'liked' : ''}" data-action="moment-like" data-id="${h(moment.id)}">${liked ? '♥' : '♡'} ${(moment.likes || []).length}</button>
          <button data-action="moment-share" data-id="${h(moment.id)}">${K.icon('share', 'sm')}Share</button>
          <button data-route="chat">Reply in chat</button>
        </div>
      </article>`;
    }).join('');
  }

  function replaceMomentList() {
    const box = document.getElementById('moment-list');
    if (box) box.innerHTML = momentsList(K.get('chat.moments', []) || []);
  }

  K.screens.moments = {
    title: 'Moments',
    render() {
      const moments = K.get('chat.moments', []) || [];
      return `<div class="page">
        ${K.pageHead({ title: 'Moments', sub: 'Small updates, shared with the room.', actions: `<button class="icon-btn" data-action="network-sheet" aria-label="Network">${K.icon('sparkles')}</button>` })}
        <div class="compose">
          ${K.avatar({ name: K.get('chatProfile.name', 'You'), url: K.get('chatProfile.avatar', ''), cls: '', style: `background:${K.get('chatProfile.color', '#d0bcff')}22;color:${K.get('chatProfile.color', '#d0bcff')}` })}
          <textarea id="moment-text" class="textarea" maxlength="500" rows="2" placeholder="What is keeping you company today?"></textarea>
          <button class="send-moment" data-action="moment-post" aria-label="Post moment">${K.icon('send')}</button>
        </div>
        <div class="chips" style="margin-bottom:14px">${MOMENT_TAGS.map(tag => `<button class="chip-toggle ${K.momentTag === tag.value ? 'active' : ''}" data-action="moment-tag" data-tag="${tag.value}">${tag.label}</button>`).join('')}</div>
        <div id="moment-list">${momentsList(moments)}</div>
        <div style="height:20px"></div>
      </div>`;
    },
    onMoments(moments) {
      if (K.current.route !== 'moments') return;
      replaceMomentList();
    },
  };

  K.actions['moment-tag'] = el => {
    K.momentTag = el.dataset.tag || 'moment';
    document.querySelectorAll('[data-action="moment-tag"]').forEach(btn => btn.classList.toggle('active', btn.dataset.tag === K.momentTag));
  };

  K.actions['moment-post'] = async () => {
    const box = document.getElementById('moment-text');
    const text = box?.value.trim();
    if (!text) { box?.focus(); return; }
    const button = document.querySelector('[data-action="moment-post"]');
    if (button) button.disabled = true;
    try {
      const data = await K.api('/api/moments/post', { method: 'POST', body: { text, tag: K.momentTag } });
      if (box) box.value = '';
      if (K.state?.chat) {
        K.state.chat.moments = [data.moment, ...(K.state.chat.moments || [])];
        replaceMomentList();
      }
      K.toast('Moment posted', '', 'ok');
    } catch (error) {
      K.toast('Could not post moment', error.message, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  };

  K.actions['moment-like'] = async el => {
    try {
      const data = await K.api('/api/moments/like', { method: 'POST', body: { id: el.dataset.id } });
      if (K.state?.chat) K.state.chat.moments = data.moments;
      replaceMomentList();
    } catch (error) {
      K.toast('Could not like that', error.message, 'error');
    }
  };

  K.actions['moment-share'] = el => {
    const moment = (K.get('chat.moments', []) || []).find(m => m.id === el.dataset.id);
    if (!moment) return;
    K.copy(`${moment.author}: ${moment.text}`, 'Moment copied');
  };

  // ---------------------------------------------------------------------
  // leaderboard
  // ---------------------------------------------------------------------
  K.leaderTab = K.leaderTab || 'presence';
  const DEMO_LEADERS = [
    { name: 'mint', color: '#7ee0b8', note: 'Always in the right room', p: 4820, c: 132, s: 980 },
    { name: 'luma', color: '#f4b8d1', note: 'Late-night listening club', p: 4410, c: 168, s: 1210 },
    { name: 'koda', color: '#f7c873', note: 'Experimental RPC enjoyer', p: 3980, c: 96, s: 540 },
    { name: 'ivy', color: '#9fd7ff', note: 'Weather card perfectionist', p: 3310, c: 74, s: 310 },
    { name: 'sol', color: '#c0a6ff', note: 'Quietly running Deep work', p: 2890, c: 61, s: 720 },
  ];

  function leaderData(which) {
    const me = K.displayName() || K.get('chatProfile.name', 'You');
    const messages = Object.values(K.get('chat.messages', {}) || {}).flat();
    const mine = messages.filter(m => m.local).length;
    const moments = (K.get('chat.moments', []) || []).filter(m => (m.author || '') === K.get('chatProfile.name', 'You')).length;
    const usage = Object.values(K.get('usage', {}) || {}).reduce((a, b) => a + K.num(b, 0), 0);
    const historySeconds = (K.get('history', []) || []).reduce((sum, row) => sum + K.num(row.seconds, 0), 0);
    const wallet = K.get('wallet', {});
    const myScores = {
      presence: Math.round(historySeconds / 6) + usage * 34 + 280,
      chat: mine * 45 + moments * 90 + 120,
      supporters: K.num(wallet.donated, 0) * 3 + K.num(wallet.kcoin, 0) / 2 + (K.get('premium.tier') === 'plus' ? 500 : 0),
    };
    const rows = DEMO_LEADERS.map((row, index) => ({
      name: row.name,
      color: row.color,
      note: row.note,
      score: which === 'presence' ? row.p : which === 'chat' ? row.c * 18 : row.s,
      mine: false,
      avatar: '',
    }));
    rows.push({ name: me, color: K.get('chatProfile.color', '#d0bcff'), note: which === 'chat' ? `${mine} messages · ${moments} moments` : which === 'supporters' ? 'KCoin and support' : 'Your local server activity', score: Math.round(myScores[which]), mine: true, avatar: K.avatarUrl() });
    rows.sort((a, b) => b.score - a.score);
    return rows;
  }

  K.screens.leaderboard = {
    title: 'Leaderboard',
    render() {
      const which = K.leaderTab;
      const rows = leaderData(which);
      const podium = [rows[1], rows[0], rows[2]].filter(Boolean);
      const labels = { presence: 'Presence time', chat: 'Conversation', supporters: 'Supporters' };
      return `<div class="page">
        ${K.pageHead({ title: 'Leaderboard', sub: 'The people making this place feel lived in.' })}
        <div class="segmented" style="margin-bottom:16px">${Object.entries(labels).map(([value, label]) => `<button class="${which === value ? 'active' : ''}" data-action="leader-tab" data-tab="${value}">${label}</button>`).join('')}</div>
        <div class="card soft" style="padding-top:4px;margin-bottom:14px">
          <div class="podium">
            ${podium.map((row, index) => {
              const actual = rows.indexOf(row) + 1;
              const cls = actual === 1 ? 'one' : actual === 2 ? 'two' : 'three';
              return `<div class="podium-person ${cls}" style="${index === 0 ? 'margin-bottom:0' : index === 1 ? 'margin-bottom:18px' : ''}">
                ${K.avatar({ name: row.name, url: row.avatar, cls: '', style: `background:${row.color}22;color:${row.color}` })}
                <span class="podium-name">${h(row.mine ? row.name + ' (you)' : row.name)}</span>
                <span class="podium-coins">${row.score.toLocaleString()} pts</span>
              </div>`;
            }).join('')}
          </div>
          <div class="tiny muted text-center" style="padding-bottom:12px">This week · ${which === 'presence' ? 'server activity and live sessions' : which === 'chat' ? 'messages and moments' : 'KCoin support'}</div>
        </div>
        <div class="rank-list">${rows.map((row, index) => `<div class="rank-row ${row.mine ? 'me' : ''}">
          <span class="rank">${index + 1}</span>
          ${K.avatar({ name: row.name, url: row.avatar, cls: '', style: `background:${row.color}22;color:${row.color}` })}
          <div><div class="rn">${h(row.name)}${row.mine ? ' <span class="badge plain">YOU</span>' : ''}</div><div class="rs">${h(row.note)}</div></div>
          <span class="rc">${row.score.toLocaleString()}</span>
        </div>`).join('')}</div>
        <div class="field-hint" style="padding:16px 5px">Demo community members are bundled with the web build. Your row uses real local messages, moments, presence history and KCoin.</div>
        <div class="quick-grid-2" style="margin-top:6px"><button class="btn btn-ghost" data-route="gallery">${K.icon('images', 'sm')}Preset gallery</button><button class="btn btn-ghost" data-route="shop">${K.icon('coins', 'sm')}KCoin shop</button></div>
        <div style="height:20px"></div>
      </div>`;
    },
  };

  K.actions['leader-tab'] = el => { K.leaderTab = el.dataset.tab || 'presence'; K.render(); };
})();
