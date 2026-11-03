'use strict';

// Port of the account lifecycle helpers from server.py:
// _validated_account_user, save_discord_account, activate_discord_account,
// sign_in, remove_discord_account, sign_out and require_gateway_token.

const rt = require('./runtime');
const { DiscordError, validateToken } = require('./discord');
const { safeAuthError } = require('./scrub');
const { cleanDiscordToken } = require('./util');

async function validatedAccountUser(token, accountId = '') {
  try {
    return await validateToken(token);
  } catch (exc) {
    if (!(exc instanceof DiscordError)) throw exc;
    const safe = safeAuthError(exc.message, token);
    if (exc.status === 401 && accountId) {
      rt.STORE.markAccountAuthFailed(
        accountId,
        'Discord rejected this token. Add a fresh token for the account.'
      );
    }
    throw new DiscordError(exc.status, safe, exc.data);
  }
}

async function saveDiscordAccount(token, { makeActive = true } = {}) {
  const store = rt.STORE;
  token = cleanDiscordToken(token);
  if (!token) {
    throw new DiscordError(401, 'Paste a Discord account token first.');
  }
  const user = await validatedAccountUser(token);
  const { account, created } = store.upsertAccount(token, user);
  if (makeActive || store.activeAccountId() === account.id) {
    // Replacing the token of the live account must restart the gateway even
    // when the caller did not ask to switch; otherwise the old socket would
    // keep using credentials that no longer exist.
    await activateDiscordAccount(account.id, { user, verify: false });
    rt.GATEWAY.restart(account.id);
  } else {
    store.broadcastState();
  }
  const action = created ? 'Added' : 'Updated';
  store.log('INFO', 'Account', `${action} Discord account ${user.displayName}.`);
  return { account, created, user };
}

async function activateDiscordAccount(accountId, { user = null, verify = true } = {}) {
  const store = rt.STORE;
  let account = store.accountById(accountId, true);
  if (!account) {
    throw new DiscordError(404, 'That Discord account is not saved.');
  }
  const token = cleanDiscordToken(account.token);
  if (!token) {
    throw new DiscordError(401, 'That account needs a fresh Discord token.');
  }
  if (verify || !user) {
    try {
      user = await validatedAccountUser(token, accountId);
    } catch (exc) {
      // The failed account was marked as needing a fresh token; push the
      // updated public account list so every open client drops the stale row.
      store.broadcastState();
      throw exc;
    }
  }
  account = store.activateAccount(accountId, user);
  // Switching focus only changes which account the UI mirrors. Every account
  // owns its own socket, so nothing that is already running gets stopped.
  store.syncFocused();
  rt.GATEWAY.reconcile();
  const display = ((account.user || {}).displayName) || 'Discord account';
  store.log('INFO', 'Account', `Switched to ${display}.`);
  store.broadcastState();
  return account;
}

async function signIn(token) {
  const { user } = await saveDiscordAccount(token, { makeActive: true });
  rt.STORE.log('INFO', 'Account', `Signed in as ${user.displayName}.`);
  return user;
}

function removeDiscordAccount(accountId) {
  const store = rt.STORE;
  const account = store.accountById(accountId);
  if (!account) {
    const error = new Error('That Discord account is not saved.');
    error.status = 400;
    throw error;
  }
  const activeId = store.activeAccountId();
  const wasActive = accountId === activeId;
  // The account's presence and socket die with it; other accounts keep running.
  const presences = store.state.presences || {};
  delete presences[accountId];
  const gateways = store.state.gateways || {};
  delete gateways[accountId];
  const result = store.removeAccount(accountId) || {};
  rt.GATEWAY.stop(accountId);
  if (wasActive) store.syncFocused();
  rt.GATEWAY.reconcile();
  const display = ((account.user || {}).displayName) || 'Discord account';
  const nextId = result.nextId || '';
  const nextAccount = nextId ? store.accountById(nextId) : null;
  if (wasActive && nextAccount) {
    const nextName = ((nextAccount.user || {}).displayName) || 'the next account';
    store.log('INFO', 'Account', `Removed ${display}; switched to ${nextName}.`);
  } else if (wasActive) {
    store.log('INFO', 'Account', `Removed ${display}; no Discord account is active.`);
  } else {
    store.log('INFO', 'Account', `Removed saved Discord account ${display}.`);
  }
  store.broadcastState();
  return result;
}

function signOut() {
  const store = rt.STORE;
  const activeId = store.activeAccountId();
  if (activeId) {
    removeDiscordAccount(activeId);
    return;
  }
  rt.GATEWAY.stopAll();
  store.secret.token = '';
  store.secret.tokenSetAt = null;
  store.secret.activeId = '';
  store.state.account = null;
  store.syncFocused();
  store.save();
  store.log('INFO', 'Account', 'Signed out of Discord.');
  store.broadcastState();
}

function requireGatewayToken(accountId = '') {
  const store = rt.STORE;
  accountId = String(accountId || '') || store.activeAccountId();
  const account = accountId ? store.accountById(accountId, true) : null;
  const token = cleanDiscordToken((account || {}).token);
  if (token) return token;
  throw new DiscordError(401, 'Connect Discord before starting a presence.');
}

module.exports = {
  validatedAccountUser,
  saveDiscordAccount,
  activateDiscordAccount,
  signIn,
  removeDiscordAccount,
  signOut,
  requireGatewayToken,
};
