'use strict';

// Server-side directory lookups for the Discord voice picker. The browser asks
// for names and ids only; the account token never leaves this server.

const rt = require('./runtime');
const { DiscordError, discordApi } = require('./discord');
const { cleanDiscordToken, nowMs } = require('./util');

const CACHE_TTL = 10000;
const guildCache = new Map();
const channelCache = new Map();

function activeToken() {
  const store = rt.STORE;
  if (!store) throw new DiscordError(503, 'Server not ready.');
  const token = cleanDiscordToken(store.activeToken());
  if (!token) throw new DiscordError(401, 'Connect Discord before choosing a voice server.');
  return token;
}

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (nowMs() - hit.at > CACHE_TTL) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(map, key, value) {
  map.set(key, { at: nowMs(), value });
  return value;
}

async function listVoiceGuilds(token = '') {
  token = token || activeToken();
  const cached = cacheGet(guildCache, token.slice(-12));
  if (cached) return cached;
  const rows = await discordApi('/users/@me/guilds', token, 'GET', null, 15);
  const guilds = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === 'object' && row.id)
    .map((row) => ({
      id: String(row.id),
      name: String(row.name || 'Server'),
      icon: row.icon ? String(row.icon) : '',
      iconUrl: row.icon
        ? `https://cdn.discordapp.com/icons/${row.id}/${row.icon}.${String(row.icon).startsWith('a_') ? 'gif' : 'png'}?size=64`
        : '',
      owner: Boolean(row.owner),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return cacheSet(guildCache, token.slice(-12), guilds);
}

async function listVoiceChannels(guildId, token = '') {
  guildId = String(guildId || '').trim();
  if (!/^\d{16,20}$/.test(guildId)) {
    throw new DiscordError(400, 'Choose a server first.');
  }
  token = token || activeToken();
  const key = token.slice(-12) + ':' + guildId;
  const cached = cacheGet(channelCache, key);
  if (cached) return cached;
  const rows = await discordApi(`/guilds/${guildId}/channels`, token, 'GET', null, 15);
  const parents = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && Number(row.type) === 4) parents.set(String(row.id), String(row.name || ''));
  }
  const channels = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && [2, 13].includes(Number(row.type)))
    .map((row) => ({
      id: String(row.id),
      name: String(row.name || 'Voice'),
      type: Number(row.type),
      position: Number(row.position || 0),
      parentId: String(row.parent_id || ''),
      parentName: parents.get(String(row.parent_id || '')) || '',
      userLimit: Number(row.user_limit || 0),
    }))
    .sort((a, b) => {
      if (a.parentName !== b.parentName) return a.parentName.localeCompare(b.parentName);
      if (a.position !== b.position) return a.position - b.position;
      return a.name.localeCompare(b.name);
    });
  return cacheSet(channelCache, key, channels);
}

function clearVoiceDirectoryCache() {
  guildCache.clear();
  channelCache.clear();
}

module.exports = { listVoiceGuilds, listVoiceChannels, clearVoiceDirectoryCache };
