'use strict';

const rt = require('./runtime');
const { ACCOUNT_LIMIT, MIRROR_RULE_LIMIT } = require('./constants');
const { cleanDiscordToken, uuidHex, isPlainObject, deepClone, deepMerge } = require('./util');
const { sendJson, sendError, readJsonBody } = require('./http');
const { publicState, publicMirrorState, visiblePatch } = require('./state');
const { DiscordError } = require('./discord');
const misc = require('./api-misc');
const social = require('./social');
const voice = require('./voice');

function mirrorBool(value, fallback = false) {
  const { mirrorBool: fn } = require('./mirror-normalize');
  return fn(value, fallback);
}

async function handlePost(req, res, url) {
  const path = url.pathname;
  const s = rt.STORE;
  try {
    if (path === '/api/patch') return await misc.handlePatch(req, res);
    if (path === '/api/upload') return await misc.handleUpload(req, res);
    if (path === '/api/chat/upload') return await misc.handleChatUpload(req, res);
    if (path === '/api/ocr') return await misc.handleOcr(req, res);
    if (path === '/api/import') return await misc.handleImport(req, res);
    if (path === '/api/presets/save') return await misc.handlePresetSave(req, res);
    if (path === '/api/presets/delete') return await misc.handlePresetDelete(req, res);

    if (path === '/api/auth/login') {
      const { loginWithPassword, captchaText, captchaChallenge } = require('./login');
      const data = await readJsonBody(req);
      const login = String(data.login || data.email || data.username || '');
      const password = String(data.password || '');
      const captchaKey = captchaText(data.captchaKey || data.captcha_key || '');
      let captcha = null;
      if (captchaKey) {
        captcha = {
          key: captchaKey,
          sessionId: data.captchaSessionId || data.captcha_session_id || '',
          rqtoken: data.captchaRqToken || data.captcha_rqtoken || '',
        };
      }
      try {
        const result = await loginWithPassword(login, password, captcha);
        if (result.status === 'mfa') {
          return sendJson(res, {
            ok: true,
            status: 'mfa',
            ticket: result.ticket,
            methods: result.methods,
            loginInstanceId: result.loginInstanceId || '',
          });
        }
        return sendJson(res, { ok: true, status: 'ok', user: result.user, state: publicState() });
      } catch (error) {
        if (error instanceof DiscordError) {
          s.log('WARN', 'Account', `Password sign-in failed: ${String(error.message).slice(0, 160)}`);
          const extra = {
            captcha: Boolean(
              (error.data || {}).captcha_key || (error.data || {}).captcha_sitekey
            ),
          };
          const challenge = captchaChallenge(error.data || {});
          if (challenge && Object.keys(challenge).length) extra.challenge = challenge;
          return sendError(res, error.message, error.status || 401, extra);
        }
        throw error;
      }
    }

    if (path === '/api/auth/mfa') {
      const { loginWithMfa, captchaText, captchaChallenge } = require('./login');
      const data = await readJsonBody(req);
      const captchaKey = captchaText(data.captchaKey || data.captcha_key || '');
      let captcha = null;
      if (captchaKey) {
        captcha = {
          key: captchaKey,
          sessionId: data.captchaSessionId || data.captcha_session_id || '',
          rqtoken: data.captchaRqToken || data.captcha_rqtoken || '',
        };
      }
      try {
        const result = await loginWithMfa(
          String(data.ticket || ''),
          String(data.code || ''),
          String(data.loginInstanceId || data.login_instance_id || ''),
          captcha
        );
        return sendJson(res, { ok: true, status: 'ok', user: result.user, state: publicState() });
      } catch (error) {
        if (error instanceof DiscordError) {
          s.log('WARN', 'Account', `Two-factor sign-in failed: ${String(error.message).slice(0, 160)}`);
          const extra = {};
          if (error.reason) extra.reason = error.reason;
          const info = error.data && typeof error.data === 'object' ? error.data : {};
          const challenge = captchaChallenge(info);
          if (challenge && Object.keys(challenge).length) {
            // Discord wants the captcha solved before it will check the code.
            // Hand the challenge to the browser and keep the ticket if Discord
            // refreshed it, so the solved token can finish the same challenge.
            extra.captcha = true;
            extra.challenge = challenge;
            if (info.ticket) extra.ticket = String(info.ticket);
          }
          return sendError(res, error.message, error.status || 401, Object.keys(extra).length ? extra : null);
        }
        throw error;
      }
    }

    if (path === '/api/auth/token') {
      const { signIn } = require('./account');
      const { safeAuthError } = require('./scrub');
      const data = await readJsonBody(req);
      const token = String(data.token || '');
      try {
        const user = await signIn(token);
        return sendJson(res, { ok: true, user, state: publicState() });
      } catch (error) {
        if (error instanceof DiscordError) {
          const safe = safeAuthError(error.message, token);
          s.log('WARN', 'Account', `Discord sign-in failed: ${safe}`);
          return sendError(res, safe, error.status || 401);
        }
        throw error;
      }
    }

    if (path === '/api/auth/browser') {
      await readJsonBody(req);
      return sendError(
        res,
        'Browser sign-in is not available in this Node build. Use Discord sign-in or paste an account token.',
        501
      );
    }
    if (path === '/api/auth/browser/cancel') {
      await readJsonBody(req);
      return sendJson(res, { ok: true });
    }
    if (path === '/api/auth/logout') {
      const { signOut } = require('./account');
      await readJsonBody(req);
      await signOut();
      return sendJson(res, { ok: true, state: publicState() });
    }

    if (path === '/api/accounts/add') {
      const { saveDiscordAccount } = require('./account');
      const { accountPublic, safeAuthError } = require('./scrub');
      const data = await readJsonBody(req);
      const makeActive = mirrorBool(data.makeActive, true);
      const submitted = cleanDiscordToken(String(data.token || ''));
      try {
        const result = await saveDiscordAccount(submitted, { makeActive });
        return sendJson(res, {
          ok: true,
          account: accountPublic(result.account),
          created: result.created,
          user: result.user,
          state: publicState(),
        });
      } catch (error) {
        if (error instanceof DiscordError) {
          const safe = safeAuthError(error.message, submitted);
          s.log('WARN', 'Account', `Account validation failed: ${safe}`);
          return sendError(res, safe, error.status || 401);
        }
        throw error;
      }
    }

    if (path === '/api/accounts/switch') {
      const { activateDiscordAccount } = require('./account');
      const { accountPublic } = require('./scrub');
      const data = await readJsonBody(req);
      const account = await activateDiscordAccount(String(data.id || ''), { verify: true });
      return sendJson(res, { ok: true, account: accountPublic(account), state: publicState() });
    }

    if (path === '/api/accounts/remove') {
      const { removeDiscordAccount } = require('./account');
      const data = await readJsonBody(req);
      const result = await removeDiscordAccount(String(data.id || ''));
      return sendJson(res, { ok: true, ...result, state: publicState() });
    }

    if (path === '/api/accounts/remove-all') {
      const data = await readJsonBody(req);
      if (String(data.confirm || '') !== 'REMOVE ALL') {
        return sendError(res, 'Type REMOVE ALL to clear every saved account.', 400);
      }
      const { stopPresence } = require('./presence');
      const { purgeMirrorWebhooks } = require('./mirror');
      await stopPresence(null, '', true);
      rt.GATEWAY.stopAll();
      await purgeMirrorWebhooks({ forgetOnFailure: true });
      const count = s.removeAllAccounts();
      s.state.presences = {};
      s.state.gateways = {};
      s.syncFocused();
      s.save();
      s.log('INFO', 'Account', `Removed all ${count} saved Discord account(s).`);
      if (rt.MIRROR) rt.MIRROR.kick();
      s.broadcastState();
      return sendJson(res, { ok: true, count, state: publicState() });
    }

    if (path === '/api/account/refresh') {
      const { requireGatewayToken, validatedAccountUser } = require('./account');
      const activeId = s.activeAccountId();
      if (!activeId) return sendError(res, 'Not signed in.', 401);
      try {
        const token = requireGatewayToken(activeId);
        const me = await validatedAccountUser(token, activeId);
        s.activateAccount(activeId, me);
        s.broadcastState();
        return sendJson(res, { ok: true, user: me, state: publicState() });
      } catch (error) {
        if (error instanceof DiscordError) {
          s.broadcastState();
          return sendError(res, error.message, error.status || 401);
        }
        throw error;
      }
    }

    if (path === '/api/gateway/reconnect') {
      const { requireGatewayToken } = require('./account');
      const activeId = s.activeAccountId();
      try {
        requireGatewayToken(activeId);
      } catch (error) {
        return sendError(res, error.message, error.status || 401);
      }
      rt.GATEWAY.stop(activeId);
      rt.GATEWAY.ensure(activeId);
      rt.GATEWAY.reconcile();
      s.log('INFO', 'Gateway', 'Connection restart requested from the web UI.');
      return sendJson(res, { ok: true, state: publicState() });
    }

    if (path === '/api/mirror/settings') {
      const { setMirrorSettings } = require('./mirror');
      const data = await readJsonBody(req);
      const mirror = setMirrorSettings(data);
      return sendJson(res, { ok: true, mirror, state: publicState() });
    }
    if (path === '/api/mirror/rules') {
      const { saveMirrorRule } = require('./mirror');
      const data = await readJsonBody(req);
      const { rule, warning } = await saveMirrorRule(data);
      return sendJson(res, { ok: true, rule, warning, state: publicState() });
    }
    if (path === '/api/mirror/rules/toggle') {
      const { toggleMirrorRule } = require('./mirror');
      const data = await readJsonBody(req);
      const result = await toggleMirrorRule(String(data.id || ''), mirrorBool(data.enabled, true));
      return sendJson(res, { ok: true, ...result, state: publicState() });
    }
    if (path === '/api/mirror/rules/delete') {
      const { deleteMirrorRule } = require('./mirror');
      const data = await readJsonBody(req);
      await deleteMirrorRule(String(data.id || ''));
      return sendJson(res, { ok: true, state: publicState() });
    }
    if (path === '/api/mirror/run') {
      const data = await readJsonBody(req);
      const ruleId = String(data.id || '').trim();
      const results = [];
      if (ruleId) {
        if (!rt.MIRROR) throw new Error('Message mirror is not running.');
        results.push(await rt.MIRROR.runRule(ruleId, { manual: true }));
      } else {
        const { normalizeMirrorState } = require('./mirror-normalize');
        const ids = normalizeMirrorState(s.state.mirror)
          .rules.filter((rule) => rule.enabled)
          .map((rule) => rule.id);
        for (const id of ids) {
          try {
            results.push(await rt.MIRROR.runRule(id, { manual: true }));
          } catch (error) {
            const { mirrorRuleById } = require('./mirror');
            const rule = mirrorRuleById(id) || {};
            results.push({
              ruleId: id,
              mirrored: 0,
              skipped: 0,
              error: `${rule.name || 'Relay'}: ${error.message}`,
            });
          }
        }
      }
      return sendJson(res, {
        ok: true,
        results,
        mirrored: results.reduce((sum, item) => sum + Number(item.mirrored || 0), 0),
        state: publicState(),
      });
    }

    if (path === '/api/rpc/start') {
      const { startPresence } = require('./presence');
      const data = await readJsonBody(req);
      const kind = String(data.kind || 'custom');
      try {
        const presence = await startPresence(kind, data, String(data.accountId || ''));
        return sendJson(res, { ok: true, presence, state: publicState() });
      } catch (error) {
        if (error instanceof DiscordError) {
          return sendError(res, error.message, error.status || 400, { loginRequired: error.status === 401 });
        }
        return sendError(res, error.message, 400);
      }
    }

    if (path === '/api/rpc/stop') {
      const { stopPresence } = require('./presence');
      let data = await readJsonBody(req);
      if (!isPlainObject(data)) data = {};
      const kind = data.kind || null;
      const accountId = String(data.accountId || '');
      if (!accountId && !('kind' in data)) {
        const ids = (s.secret.accounts || []).map((row) => String(row.id || '')).filter(Boolean);
        const stoppedAccounts = [];
        for (const id of ids) {
          if (await stopPresence(null, id)) stoppedAccounts.push(id);
        }
        return sendJson(res, {
          ok: true,
          stopped: stoppedAccounts.length > 0,
          stoppedAccounts,
          state: publicState(),
        });
      }
      const stopped = await stopPresence(kind, accountId);
      return sendJson(res, { ok: true, stopped, state: publicState() });
    }

    if (path === '/api/rpc/refresh') {
      const { refreshPresence } = require('./presence');
      const data = await readJsonBody(req);
      const presence = await refreshPresence(String(data.accountId || ''));
      if (presence === null) return sendError(res, 'No presence is running.', 409);
      return sendJson(res, { ok: true, presence, state: publicState() });
    }

    if (path === '/api/rpc/preview') {
      const { buildCustomActivity, buildActivity, accountView } = require('./activities');
      const data = await readJsonBody(req);
      const kind = String(data.kind || 'custom');
      const cfg = data.config;
      const accountId = s.activeAccountId();
      let activity;
      if (kind === 'custom' && isPlainObject(cfg)) {
        const merged = deepClone(s.customFor(accountId) || {});
        deepMerge(merged, visiblePatch(cfg));
        activity = await buildCustomActivity(accountView(s.state, accountId), merged);
      } else {
        activity = await buildActivity(accountView(s.state, accountId), kind);
      }
      return sendJson(res, { ok: true, activity });
    }

    if (path === '/api/image') {
      const { resolveImageAsset, offlineMode } = require('./discord');
      const data = await readJsonBody(req);
      const image = String(data.url || '');
      if (offlineMode() && image && !/^(mp:|external\/|attachments\/)/.test(image)) {
        return sendError(res, 'Offline mode is on. Turn it off in Settings to resolve new Discord artwork.', 503);
      }
      const asset = await resolveImageAsset(image);
      if (!asset) return sendError(res, 'That image could not be resolved.', 422);
      return sendJson(res, { ok: true, asset });
    }

    if (path === '/api/chat/send') {
      const data = await readJsonBody(req);
      const msg = social.chatSend(
        String(data.room || 'lounge'),
        String(data.text || ''),
        String(data.attach || ''),
        data.replyTo === undefined ? null : data.replyTo
      );
      return sendJson(res, { ok: true, message: msg });
    }
    if (path === '/api/chat/react') {
      const data = await readJsonBody(req);
      const msg = social.chatReact(
        String(data.room || 'lounge'),
        String(data.id || ''),
        String(data.emoji || '✨')
      );
      return sendJson(res, { ok: true, message: msg });
    }
    if (path === '/api/moments/post') {
      const data = await readJsonBody(req);
      const moment = social.momentPost(String(data.text || ''), String(data.tag || ''));
      return sendJson(res, { ok: true, moment });
    }
    if (path === '/api/moments/like') {
      const data = await readJsonBody(req);
      return sendJson(res, { ok: true, moments: social.momentLike(String(data.id || '')) });
    }
    if (path === '/api/wallet/daily') {
      await readJsonBody(req);
      return sendJson(res, { ok: true, ...social.walletDaily() });
    }
    if (path === '/api/shop/buy') {
      const data = await readJsonBody(req);
      return sendJson(res, { ok: true, ...social.shopBuy(String(data.id || '')) });
    }

    if (path === '/api/premium/unlock') {
      await readJsonBody(req);
      const profile = (s.state.chatProfile = s.state.chatProfile || {});
      const previous = profile.badge !== 'Plus' ? profile.badge : 'Member';
      s.state.premium = { tier: 'plus', since: Date.now(), demo: true, previousBadge: previous || 'Member' };
      profile.badge = 'Plus';
      s.save();
      s.log('INFO', 'Premium', 'Local demo premium unlocked.');
      s.broadcastState();
      return sendJson(res, { ok: true, premium: s.state.premium, state: publicState() });
    }
    if (path === '/api/premium/reset') {
      await readJsonBody(req);
      const profile = (s.state.chatProfile = s.state.chatProfile || {});
      const previous = (s.state.premium || {}).previousBadge || 'Member';
      if (profile.badge === 'Plus') profile.badge = previous;
      s.state.premium = { tier: 'free', since: null, demo: false };
      s.save();
      s.log('INFO', 'Premium', 'Local demo premium turned off.');
      s.broadcastState();
      return sendJson(res, { ok: true, premium: s.state.premium, state: publicState() });
    }

    if (path === '/api/voice/join') {
      const data = await readJsonBody(req);
      return sendJson(res, {
        ok: true,
        voice: social.voiceJoin(String(data.room || 'lounge'), String(data.clientId || uuidHex(16))),
      });
    }
    if (path === '/api/voice/leave') {
      const data = await readJsonBody(req);
      return sendJson(res, { ok: true, voice: social.voiceLeave(String(data.clientId || '')) });
    }
    if (path === '/api/voice/heartbeat') {
      const data = await readJsonBody(req);
      return sendJson(res, { ok: true, voice: social.voiceHeartbeat(String(data.clientId || '')) });
    }
    if (path === '/api/voice/state') {
      const data = await readJsonBody(req);
      return sendJson(res, { ok: true, voice: social.voiceUpdate(String(data.clientId || ''), data) });
    }

    if (path === '/api/voice/discord/join') {
      const data = await readJsonBody(req);
      const payload = voice.voiceJoinPayload(data);
      const result = await voice.voiceServicePost('/join', payload);
      const channel = ((result.state || {}).channelName) || payload.channelId;
      s.log('INFO', 'Voice', `Joined Discord voice channel ${channel}.`);
      return sendJson(res, { ok: true, state: result.state });
    }
    if (path === '/api/voice/discord/leave') {
      await readJsonBody(req);
      const result = await voice.voiceServicePost('/leave');
      s.log('INFO', 'Voice', 'Left the Discord voice channel.');
      return sendJson(res, { ok: true, state: result.state });
    }
    if (path === '/api/voice/discord/play') {
      const data = await readJsonBody(req);
      const result = await voice.voiceServicePost('/play', {
        query: String(data.query || ''),
        volume: data.volume === undefined ? 1.0 : data.volume,
      });
      s.log('INFO', 'Voice', `Discord voice play: ${String(data.query || '').slice(0, 120)}`);
      const { ok, ...rest } = result;
      return sendJson(res, { ok: true, ...rest });
    }
    if (path === '/api/voice/discord/control') {
      const data = await readJsonBody(req);
      const result = await voice.voiceServicePost('/control', {
        action: String(data.action || ''),
        value: data.value,
      });
      return sendJson(res, { ok: true, state: result.state });
    }
    if (path === '/api/voice/discord/record') {
      const data = await readJsonBody(req);
      let result;
      if (String(data.action || 'start') === 'stop') {
        result = await voice.voiceServicePost('/record/stop');
        s.log('INFO', 'Voice', 'Stopped the Discord call recording.');
      } else {
        result = await voice.voiceServicePost('/record/start', {
          mode: String(data.mode || 'mix'),
          bitrate: data.bitrate === undefined ? 32 : data.bitrate,
          mix: data.mix === undefined ? true : Boolean(data.mix),
        });
        s.log('INFO', 'Voice', 'Started recording the Discord call.');
      }
      return sendJson(res, { ok: true, state: result.state });
    }
    if (path === '/api/voice/discord/recordings/compress') {
      const data = await readJsonBody(req);
      const result = await voice.voiceServicePost('/recordings/compress', {
        id: String(data.id || ''),
        bitrate: data.bitrate === undefined ? 32 : data.bitrate,
      });
      return sendJson(res, { ok: true, recording: result.recording });
    }
    if (path === '/api/voice/discord/recordings/delete') {
      const data = await readJsonBody(req);
      const result = await voice.voiceServicePost('/recordings/delete', { id: String(data.id || '') });
      return sendJson(res, { ok: true, deleted: result.deleted });
    }

    if (path === '/api/log') {
      const data = await readJsonBody(req);
      s.log(String(data.level || 'INFO'), String(data.tag || 'Web'), String(data.message || ''));
      return sendJson(res, { ok: true });
    }
    if (path === '/api/logs/clear') {
      await readJsonBody(req);
      s.logs.length = 0;
      s.state.logs = [];
      s.save();
      s.log('INFO', 'Logs', 'In-app log cleared.');
      return sendJson(res, { ok: true, logs: s.logs });
    }
    if (path === '/api/history/clear') {
      await readJsonBody(req);
      s.history = [];
      s.state.history = [];
      s.save();
      s.log('INFO', 'History', 'Presence history cleared.');
      s.broadcastState();
      return sendJson(res, { ok: true, state: publicState() });
    }

    if (path === '/api/bulk/scan' || path === '/api/bulk/delete') {
      const data = await readJsonBody(req);
      const result = await social.bulkChannelScan(data, { delete: path === '/api/bulk/delete' });
      return sendJson(res, { ok: true, ...result });
    }

    return sendError(res, 'Not found.', 404);
  } catch (error) {
    const message = String((error && error.message) || error || 'Server error');
    if (error instanceof DiscordError) {
      return sendError(res, error.message, error.status || 502);
    }
    if (error && Number.isFinite(error.status)) {
      return sendError(res, message, error.status);
    }
    // Anything that failed to reach another service is a gateway problem, not a
    // bad request from the browser.
    if (/not reachable|Could not reach Discord|took too long|unreadable|usable webhook|usable account|^HTTP \d+/i.test(message)) {
      if (s) s.log('WARN', 'Web', `${path}: ${message}`);
      return sendError(res, message, 502);
    }
    if (/^(Server not ready\.|Message mirror is not running\.)$/.test(message)) {
      if (s) s.log('ERROR', 'Web', `${path}: ${message}`);
      return sendError(res, message, 500);
    }
    // Everything else thrown by the handlers is a validation message. The
    // browser shows it verbatim, so it stays a clean 400 instead of a 500.
    return sendError(res, message || 'Server error', 400);
  }
}

module.exports = { handlePost };
