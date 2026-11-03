'use strict';

const rt = require('./runtime');
const { MAX_CHAT } = require('./constants');
const { nowMs, uuidHex, clamp } = require('./util');
const { scrub } = require('./scrub');

function store() {
  return rt.STORE;
}

function chatRoom(roomId) {
  const s = store();
  if (!s) return null;
  for (const room of ((s.state.chat || {}).rooms || [])) {
    if (room.id === roomId) return room;
  }
  return null;
}

function chatSend(roomId, text, attach = '', replyTo = null) {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  if (!chatRoom(roomId)) throw new Error('Room not found.');
  text = String(text || '').trim();
  if (!text && !attach) throw new Error('Type a message first.');
  if (text.length > 2000) throw new Error('Messages are limited to 2000 characters.');
  const profile = s.state.chatProfile || {};
  const msg = {
    id: uuidHex(16),
    author: profile.name || 'You',
    avatar: profile.avatar || '',
    color: profile.color || '#d0bcff',
    text,
    attach,
    time: nowMs(),
    reactions: {},
    replyTo: replyTo === undefined ? null : replyTo,
    local: true,
  };
  const messages = (s.state.chat.messages = s.state.chat.messages || {});
  const list = (messages[roomId] = messages[roomId] || []);
  list.push(msg);
  messages[roomId] = list.slice(-MAX_CHAT);
  s.save();
  s.publish({ type: 'chat', room: roomId, message: msg });
  return msg;
}

function chatReact(roomId, messageId, emoji) {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  const profile = (s.state.chatProfile || {}).name || 'You';
  emoji = String(emoji || '✨').slice(0, 8);
  const messages = ((s.state.chat || {}).messages || {})[roomId] || [];
  for (const msg of messages) {
    if (msg.id === messageId) {
      const reactions = (msg.reactions = msg.reactions || {});
      const people = (reactions[emoji] = reactions[emoji] || []);
      if (people.includes(profile)) {
        people.splice(people.indexOf(profile), 1);
        if (!people.length) delete reactions[emoji];
      } else {
        people.push(profile);
      }
      s.save();
      s.publish({ type: 'chat', room: roomId, message: msg });
      return msg;
    }
  }
  throw new Error('Message not found.');
}

function momentPost(text, tag = '') {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  text = String(text || '').trim();
  if (!text) throw new Error('Write something first.');
  const profile = s.state.chatProfile || {};
  const moment = {
    id: uuidHex(16),
    author: profile.name || 'You',
    color: profile.color || '#d0bcff',
    text: text.slice(0, 500),
    time: nowMs(),
    likes: [],
    tag: tag || 'moment',
  };
  const chat = (s.state.chat = s.state.chat || {});
  chat.moments = chat.moments || [];
  chat.moments.unshift(moment);
  chat.moments = chat.moments.slice(0, 80);
  s.save();
  s.publish({ type: 'moments', moments: chat.moments });
  return moment;
}

function momentLike(momentId) {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  const profile = (s.state.chatProfile || {}).name || 'You';
  for (const moment of ((s.state.chat || {}).moments || [])) {
    if (moment.id === momentId) {
      const likes = (moment.likes = moment.likes || []);
      const index = likes.indexOf(profile);
      if (index >= 0) likes.splice(index, 1);
      else likes.push(profile);
      s.save();
      s.publish({ type: 'moments', moments: s.state.chat.moments });
      return s.state.chat.moments;
    }
  }
  throw new Error('Moment not found.');
}

function walletDaily() {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  const now = Date.now() / 1000;
  const wallet = (s.state.wallet = s.state.wallet || {});
  const last = Number(wallet.daily || 0);
  if (now - last < 20 * 60 * 60) {
    const remaining = Math.trunc(20 * 60 * 60 - (now - last));
    const failure = new Error(
      `Come back in ${Math.max(1, Math.trunc(remaining / 60))} minutes for your next KCoin.`
    );
    failure.status = 409;
    throw failure;
  }
  const amount = 50 + Math.min(7, Math.trunc(Number(wallet.streak || 0))) * 5;
  wallet.kcoin = Math.trunc(Number(wallet.kcoin || 0)) + amount;
  wallet.daily = now;
  wallet.streak = Math.trunc(Number(wallet.streak || 0)) + 1;
  s.save();
  s.log('INFO', 'Wallet', `Daily reward claimed: +${amount} KCoin.`);
  s.broadcastState();
  return { amount, wallet };
}

const SHOP = {
  aurora: { name: 'Aurora', price: 0, kind: 'theme', color: '#d0bcff' },
  sunset: { name: 'Sunset rail', price: 180, kind: 'theme', color: '#f0a6ca' },
  ocean: { name: 'Deep ocean', price: 180, kind: 'theme', color: '#7dd3fc' },
  violet: { name: 'Violet hour', price: 240, kind: 'theme', color: '#c4b5fd' },
  'badge-flame': { name: 'Flame badge', price: 120, kind: 'badge', emoji: '🔥' },
  'badge-star': { name: 'Star badge', price: 120, kind: 'badge', emoji: '✦' },
  'bubble-soft': { name: 'Soft bubble', price: 90, kind: 'chat', emoji: '🫧' },
};

function shopBuy(itemId) {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  const item = SHOP[itemId];
  if (!item) throw new Error('That item is not in the shop.');
  const wallet = (s.state.wallet = s.state.wallet || {});
  const inv = (wallet.inventory = wallet.inventory || []);
  if (inv.includes(itemId)) throw new Error('You already own that.');
  const price = Math.trunc(item.price);
  if (Math.trunc(Number(wallet.kcoin || 0)) < price) throw new Error('Not enough KCoin yet.');
  wallet.kcoin = Math.trunc(Number(wallet.kcoin || 0)) - price;
  inv.push(itemId);
  s.save();
  s.log('INFO', 'Wallet', `Unlocked ${item.name}.`);
  s.broadcastState();
  return { wallet, item };
}

// -- in-app voice room (roster + mic state only) ---------------------------
function voiceContainer(s) {
  const chat = (s.state.chat = s.state.chat || {});
  return (chat.voice = chat.voice || { participants: [] });
}

function voiceJoin(room, clientId) {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  const profile = s.state.chatProfile || {};
  const now = nowMs();
  const voice = voiceContainer(s);
  const people = (voice.participants || []).filter(
    (p) => now - Number(p.seen || 0) < 90000 && p.clientId !== clientId
  );
  people.push({
    clientId,
    name: profile.name || 'You',
    color: profile.color || '#d0bcff',
    room,
    muted: false,
    deafened: false,
    seen: now,
    joinedAt: now,
  });
  voice.participants = people;
  s.save();
  s.broadcastState();
  return voice;
}

function voiceLeave(clientId) {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  const voice = voiceContainer(s);
  voice.participants = (voice.participants || []).filter((p) => p.clientId !== clientId);
  s.save();
  s.broadcastState();
  return voice;
}

function voiceHeartbeat(clientId) {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  const now = nowMs();
  const voice = voiceContainer(s);
  voice.participants = (voice.participants || []).filter((p) => now - Number(p.seen || 0) < 90000);
  for (const p of voice.participants) {
    if (p.clientId === clientId) p.seen = now;
  }
  s.save();
  return voice;
}

function voiceUpdate(clientId, patch) {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  const allowed = { muted: Boolean, deafened: Boolean, speaking: Boolean };
  const voice = voiceContainer(s);
  for (const p of voice.participants || []) {
    if (p.clientId === clientId) {
      for (const [key, caster] of Object.entries(allowed)) {
        if (key in patch) p[key] = caster(patch[key]);
      }
      break;
    }
  }
  s.save();
  s.broadcastState();
  return voice;
}

// -- bulk message removal (user's own messages) ----------------------------
async function bulkChannelScan(data, { delete: isDelete }) {
  const s = store();
  if (!s) throw new Error('Server not ready.');
  const { discordApi, DiscordError } = require('./discord');
  const token = s.activeToken();
  if (!token) {
    const error = new Error('Sign in to Discord first.');
    error.status = 401;
    throw error;
  }
  if (!isDelete) {
    const channel = String(data.channel || '').trim();
    if (!/^\d{5,25}$/.test(channel)) throw new Error('Enter a valid channel ID.');
    const limit = clamp(Number.isFinite(Number(data.limit)) ? Number(data.limit) : 100, 1, 500);
    const query = String(data.query || '').trim().toLowerCase();
    const me = (s.state.account || {}).id || '';
    const messages = [];
    let before = null;
    try {
      while (messages.length < limit) {
        let qs = `?limit=${Math.min(100, limit - messages.length)}`;
        if (before) qs += `&before=${before}`;
        const rows = (await discordApi(`/channels/${channel}/messages${qs}`, token)) || [];
        if (!rows.length) break;
        before = rows[rows.length - 1].id;
        messages.push(...rows);
        if (rows.length < 100) break;
      }
    } catch (error) {
      if (error instanceof DiscordError) {
        error.status = error.status || 502;
        throw error;
      }
      throw error;
    }
    const mine = [];
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const author = m.author || {};
      if (String(author.id) !== me) continue;
      const content = String(m.content || '');
      if (query && !content.toLowerCase().includes(query)) continue;
      mine.push({
        id: m.id,
        content: content.slice(0, 400),
        time: m.timestamp,
        attachments: (m.attachments || []).length,
        pinned: Boolean(m.pinned),
      });
    }
    return { messages: mine.slice(0, 100), scanned: messages.length, channel };
  }
  const ids = data.ids || [];
  if (!Array.isArray(ids)) throw new Error('ids must be a list.');
  if (data.confirm !== 'DELETE') throw new Error('Type DELETE in the confirmation box.');
  if (ids.length > 100) throw new Error('Delete at most 100 messages at once.');
  const channel = String(data.channel || '').trim();
  if (!/^\d{5,25}$/.test(channel)) throw new Error('Enter a valid channel ID.');
  let deleted = 0;
  const failed = [];
  for (const mid of ids.slice(0, 100)) {
    try {
      await discordApi(`/channels/${channel}/messages/${mid}`, token, 'DELETE');
      deleted += 1;
      await new Promise((r) => setTimeout(r, 550));
    } catch (error) {
      failed.push({ id: mid, error: scrub(error.message) });
    }
  }
  s.log('INFO', 'Bulk', "Deleted messages from the user's own account.");
  return { deleted, failed };
}

// -- presets ---------------------------------------------------------------
function savedPresetIndex(saved, presetId) {
  for (let i = 0; i < (saved || []).length; i += 1) {
    const row = saved[i];
    if (row && typeof row === 'object' && String(row.id || '') === String(presetId || '')) return i;
  }
  return -1;
}

module.exports = {
  chatRoom,
  chatSend,
  chatReact,
  momentPost,
  momentLike,
  walletDaily,
  shopBuy,
  SHOP,
  voiceJoin,
  voiceLeave,
  voiceHeartbeat,
  voiceUpdate,
  bulkChannelScan,
  savedPresetIndex,
};
