'use strict';

const rt = require('./runtime');
const { cleanDiscordToken } = require('./util');

function scrub(text) {
  let value = String(text == null ? '' : text);
  const tokens = [];
  try {
    const store = rt.STORE;
    if (store) {
      if (store.secret && store.secret.token) tokens.push(String(store.secret.token));
      for (const account of (store.secret && store.secret.accounts) || []) {
        if (account && account.token) tokens.push(String(account.token));
      }
      const webhooks = store.secret && store.secret.mirrorWebhooks;
      if (webhooks && typeof webhooks === 'object') {
        for (const webhook of Object.values(webhooks)) {
          if (webhook && webhook.token) tokens.push(String(webhook.token));
        }
      }
    }
  } catch {
    // ignore
  }
  const unique = [...new Set(tokens)].filter((t) => t.length > 8).sort((a, b) => b.length - a.length);
  for (const token of unique) value = value.split(token).join('••••••••');
  value = value.replace(/[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}/g, '••••••••');
  value = value.replace(
    /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_.-]+/g,
    '••••••••'
  );
  return value;
}

function safeAuthError(message, token = '') {
  let text = scrub(message);
  const submitted = cleanDiscordToken(token);
  if (submitted) text = text.split(submitted).join('••••••••');
  return text;
}

function accountPublic(account) {
  const user = account && typeof account.user === 'object' && account.user ? account.user : {};
  const display = String(user.displayName || user.globalName || user.username || 'Discord account');
  const token = cleanDiscordToken(account && account.token);
  return {
    id: String((account && account.id) || ''),
    userId: String(user.id || ''),
    username: String(user.username || ''),
    displayName: display,
    avatar: String(user.avatar || ''),
    avatarUrl: String(user.avatarUrl || ''),
    tokenSet: Boolean(token),
    authKind: token ? 'token' : 'none',
    canGateway: Boolean(token) && !Boolean(account && account.needsAuth),
    needsAuth: Boolean(account && account.needsAuth),
    authError: scrub(String((account && account.authError) || '')).slice(0, 220),
    addedAt: account && account.addedAt,
    lastUsedAt: account && account.lastUsedAt,
  };
}

module.exports = { scrub, safeAuthError, accountPublic };