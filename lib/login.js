'use strict';

// Port of the Discord web password / MFA sign-in helpers from server.py.
// The password flow drives Discord's web client, so it identifies as the web
// client (Chrome UA + Windows super properties) rather than the Android app.

const crypto = require('crypto');
const {
  DISCORD_LOGIN_API,
  DISCORD_MFA_API,
  DISCORD_LOGIN_UA,
  DISCORD_CHROME_MAJOR,
  DISCORD_CLIENT_VERSION,
  DISCORD_CLIENT_BUILD,
} = require('./constants');
const { DiscordError } = require('./discord');
const { cleanDiscordToken } = require('./util');

const LOGIN_SOURCE = 'https://discord.com/login';

// A real client keeps one launch identity for the whole session and hands out
// the same values on every request. Discord's two-factor endpoint answers a
// *current* authenticator code with 60008 "Invalid two-factor code" when the
// request does not look like a live client launch, so the web shape is carried
// on both the password and the two-factor request. Regenerated per server run.
const WEB_LAUNCH_ID = crypto.randomUUID();
const WEB_LAUNCH_SIGNATURE = crypto.randomUUID();
const WEB_HEARTBEAT_SESSION_ID = crypto.randomUUID();

function webSuperProperties() {
  const props = {
    os: 'Windows',
    browser: 'Chrome',
    device: '',
    system_locale: 'en-US',
    has_client_mods: false,
    browser_user_agent: DISCORD_LOGIN_UA,
    browser_version: DISCORD_CLIENT_VERSION,
    os_version: '10',
    referrer: '',
    referring_domain: '',
    referrer_current: '',
    referring_domain_current: '',
    release_channel: 'stable',
    client_build_number: DISCORD_CLIENT_BUILD,
    client_event_source: null,
    client_launch_id: WEB_LAUNCH_ID,
    launch_signature: WEB_LAUNCH_SIGNATURE,
    client_heartbeat_session_id: WEB_HEARTBEAT_SESSION_ID,
    client_app_state: 'focused',
  };
  return Buffer.from(JSON.stringify(props), 'utf8').toString('base64');
}

function loginHeaders() {
  const major = DISCORD_CHROME_MAJOR;
  return {
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    Origin: 'https://discord.com',
    Referer: LOGIN_SOURCE,
    'User-Agent': DISCORD_LOGIN_UA,
    'X-Super-Properties': webSuperProperties(),
    'X-Discord-Locale': 'en-US',
    'X-Discord-Timezone': 'Europe/London',
    'Sec-Ch-Ua': `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not_A Brand";v="24"`,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
  };
}

async function loginPost(url, body, timeout = 25, extraHeaders = null) {
  const headers = loginHeaders();
  for (const [name, value] of Object.entries(extraHeaders || {})) {
    headers[String(name)] = String(value);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  let text;
  let status;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    status = response.status;
    text = await response.text();
    if (!response.ok) {
      let info = {};
      try {
        info = JSON.parse(text);
      } catch {
        info = { message: String(text || '').slice(0, 300) };
      }
      if (!info || typeof info !== 'object') info = {};
      throw new DiscordError(status, loginErrorMessage(status, info), info);
    }
  } catch (error) {
    if (error instanceof DiscordError) throw error;
    if (error.name === 'AbortError') {
      throw new DiscordError(0, 'Discord took too long to answer. Check your connection and try again.');
    }
    throw new DiscordError(0, `Could not reach Discord: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!text) return {};
  try {
    const payload = JSON.parse(text);
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    throw new DiscordError(502, 'Discord returned an unreadable login response.');
  }
}

function loginErrorMessage(status, info) {
  info = info && typeof info === 'object' ? info : {};
  const retryAfter = info.retry_after;
  if (status === 429 || retryAfter) {
    let wait = 0;
    if (retryAfter !== undefined && retryAfter !== null) {
      const parsed = Number.parseFloat(String(retryAfter));
      wait = Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
    }
    wait = wait || 60;
    return `Discord is rate limiting this sign-in. Wait ${wait} seconds and try again.`;
  }
  if (info.captcha_key || info.captcha_sitekey) {
    const service = String(info.captcha_service || '').trim().toLowerCase() || 'hcaptcha';
    if (service === 'hcaptcha' && info.captcha_sitekey) {
      return (
        'Discord wants a captcha before it will finish this sign-in. ' +
        'Solve the check in the sign-in sheet, or use a token instead.'
      );
    }
    return 'Discord wants a captcha this app cannot display. Use a token instead.';
  }
  const message = String(info.message || '').trim();
  const lowered = message.toLowerCase();
  if (
    lowered.includes('two factor') ||
    lowered.includes('two-factor') ||
    lowered.includes('2fa') ||
    lowered.includes('mfa')
  ) {
    return 'That two-factor code was not accepted. Try the current code from your authenticator app.';
  }
  if (status === 401 || lowered.includes('invalid')) {
    return 'Wrong email/username or password.';
  }
  if (info.mfa || info.mfa_required) return 'Discord needs your two-factor code.';
  if (message) return message.slice(0, 220);
  if (status === 400) return 'Discord rejected that sign-in. Check the email/username and password.';
  return `Discord returned HTTP ${status}.`;
}

function captchaText(value, limit = 8192) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text || text.length > limit || text.includes('\r') || text.includes('\n')) return '';
  return text;
}

function captchaErrors(info) {
  const raw = info && typeof info === 'object' ? info.captcha_key : null;
  if (!Array.isArray(raw)) return [];
  const codes = [];
  for (const value of raw.slice(0, 4)) {
    const text = captchaText(value, 120);
    if (text && !codes.includes(text)) codes.push(text);
  }
  return codes;
}

function captchaChallenge(info) {
  if (!info || typeof info !== 'object' || !(info.captcha_key || info.captcha_sitekey)) return {};
  const service = String(info.captcha_service || '').trim().toLowerCase() || 'hcaptcha';
  const sitekey = captchaText(info.captcha_sitekey, 256);
  if (service !== 'hcaptcha' || !sitekey) return {};
  return {
    service,
    sitekey,
    sessionId: captchaText(info.captcha_session_id, 512),
    rqdata: captchaText(info.captcha_rqdata, 8192),
    rqtoken: captchaText(info.captcha_rqtoken, 8192),
    invisible: Boolean(info.should_serve_invisible),
    errors: captchaErrors(info),
  };
}

function captchaHeaders(captcha) {
  if (!captcha || typeof captcha !== 'object') return {};
  const key = captchaText(captcha.key);
  if (!key) return {};
  const headers = { 'X-Captcha-Key': key };
  const sessionId = captchaText(captcha.sessionId, 512);
  if (sessionId) headers['X-Captcha-Session-Id'] = sessionId;
  const rqtoken = captchaText(captcha.rqtoken);
  if (rqtoken) headers['X-Captcha-Rqtoken'] = rqtoken;
  return headers;
}

// Discord's /auth/mfa/totp validates login_instance_id as a fixed 36 character
// id (a UUID). Echoing anything else makes Discord answer 400 "Invalid Form
// Body" for that field *before* it ever looks at the authenticator code, so an
// unusable value is dropped. The ticket alone is enough to finish the challenge
// (that is all the upstream Kizzey client sends).
function loginInstance(value) {
  const text = String(value || '').trim();
  return text.length === 36 ? text : '';
}

function mfaChallenge(payload) {
  payload = payload && typeof payload === 'object' ? payload : {};
  const ticket = String(payload.ticket || '');
  if (!ticket) return null;
  const methods = Array.isArray(payload.mfa) ? payload.mfa.map((m) => String(m)) : [];
  const result = { status: 'mfa', ticket, methods };
  const instanceId = loginInstance(payload.login_instance_id);
  if (instanceId) result.loginInstanceId = instanceId;
  return result;
}

function discordFieldErrors(info) {
  const errors = info && typeof info === 'object' ? info.errors : null;
  return errors && typeof errors === 'object' ? errors : {};
}

function hasCaptcha(info) {
  return Boolean(
    info && typeof info === 'object' && (info.captcha_key || info.captcha_sitekey)
  );
}

// One line per Discord answer, with field *names* only — never a token, ticket
// or Enterprise request value — so a failing sign-in can be diagnosed from the
// Logs screen without leaking anything. The password and code never appear.
function logDiscordShape(step, status, info) {
  try {
    const rt = require('./runtime');
    if (!rt.STORE) return;
    const source = info && typeof info === 'object' ? info : {};
    const fields = Object.keys(source).filter((key) => !/token|password|code|secret/i.test(key));
    // `code` here is Discord's numeric error code (e.g. 60008), never the
    // authenticator code, so it is safe and is the one field worth keeping.
    const errorCode = typeof source.code === 'number' ? source.code : 'n/a';
    rt.STORE.log(
      'INFO',
      'Account',
      `Discord ${step}: HTTP ${status}; fields [${fields.join(', ') || 'none'}]; ` +
        `captcha=${hasCaptcha(source)} mfa=${Boolean(source.mfa)} ` +
        `ticket=${Boolean(source.ticket)} session=${Boolean(source.token)} code=${errorCode}`
    );
  } catch {
    // diagnostics are best effort and must never break a sign-in
  }
}

// The MFA endpoint's only meaningful inputs are the ticket and the code, so a
// 400/401 is reported against whichever field Discord names, rather than always
// blaming the code.
function mfaError(error) {
  if (!(error instanceof DiscordError)) return error;
  const info = error.data && typeof error.data === 'object' ? error.data : {};
  if (info.captcha_key || info.captcha_sitekey) return error;
  const fields = discordFieldErrors(info);
  const status = error.status || 401;
  if (fields.ticket || /MFA_INVALID_TICKET/i.test(JSON.stringify(info))) {
    const expired = new DiscordError(
      status,
      'That two-factor step expired before Discord checked the code. Sign in again to get a fresh one.',
      info
    );
    expired.reason = 'mfa-expired';
    return expired;
  }
  if (fields.login_instance_id) {
    const rejected = new DiscordError(
      status,
      'Discord rejected that two-factor request. Sign in again and retry.',
      info
    );
    rejected.reason = 'mfa-expired';
    return rejected;
  }
  const suffix = typeof info.code === 'number' ? ` (Discord said ${info.code})` : '';
  return new DiscordError(
    status,
    'That two-factor code was not accepted. Try the current code from your authenticator app.' + suffix,
    info
  );
}

async function discordPasswordLogin(login, password, captcha = null) {
  login = String(login || '').trim();
  password = String(password || '');
  if (!login) throw new DiscordError(400, 'Enter your Discord email or username.');
  if (!password) throw new DiscordError(400, 'Enter your Discord password.');
  const headers = captchaHeaders(captcha);
  const body = {
    login,
    password,
    undelete: false,
    login_source: null,
    gift_code_sku_id: null,
  };
  if (!Object.keys(headers).length) body.captcha_key = null;
  let payload;
  try {
    payload = await loginPost(DISCORD_LOGIN_API, body, 25, headers);
    logDiscordShape('password login', 200, payload);
  } catch (error) {
    if (error instanceof DiscordError) logDiscordShape('password login', error.status, error.data);
    // Discord can attach the MFA ticket to a non-2xx answer. A captcha in the
    // same reply must still be solved first: the ticket it carries is bound to
    // that unsolved challenge, so it can never be collapsed into the MFA step.
    if (error instanceof DiscordError && error.data && typeof error.data === 'object') {
      if (!hasCaptcha(error.data)) {
        const challenge = mfaChallenge(error.data);
        if (challenge) return challenge;
      }
    }
    throw error;
  }
  // The same ordering applies when Discord answers 2xx for an MFA account that
  // still owes a captcha: solve the captcha, then exchange the ticket.
  if (hasCaptcha(payload)) {
    throw new DiscordError(400, loginErrorMessage(400, payload), payload);
  }
  const token = cleanDiscordToken(payload.token);
  if (token) return { status: 'ok', token };
  const challenge = mfaChallenge(payload);
  if (challenge) return challenge;
  throw new DiscordError(502, 'Discord did not return a session for that sign-in.');
}

async function discordMfaLogin(ticket, code, loginInstanceId = '', captcha = null) {
  ticket = String(ticket || '');
  code = String(code || '').trim().replace(/\s+/g, '');
  if (!ticket) throw new DiscordError(400, 'That two-factor step expired. Sign in again.');
  if (!code) throw new DiscordError(400, 'Enter the 6-digit code from your authenticator app.');
  const instanceId = loginInstance(loginInstanceId);
  const headers = captchaHeaders(captcha);

  // Discord's own clients finish the challenge with the ticket alone. Echoing
  // the login_instance_id is the one difference the web client adds, and a
  // stale or mismatched id makes Discord answer 60008 for a *current* code, so
  // the ticket-only shape goes first and the echoed id is only a second attempt
  // when the first came back without a captcha and without a dead ticket.
  const bodies = [{ code, ticket, login_source: null, gift_code_sku_id: null }];
  if (instanceId) {
    bodies.push({
      code,
      ticket,
      login_source: null,
      gift_code_sku_id: null,
      login_instance_id: instanceId,
    });
  }

  let payload = null;
  let failure = null;
  for (const body of bodies) {
    try {
      payload = await loginPost(DISCORD_MFA_API, body, 25, headers);
      logDiscordShape('two-factor check', 200, payload);
      failure = null;
      break;
    } catch (error) {
      if (!(error instanceof DiscordError)) throw error;
      logDiscordShape('two-factor check', error.status, error.data);
      failure = error;
      const info = error.data && typeof error.data === 'object' ? error.data : {};
      // A captcha has to be solved before the code is even looked at, and a
      // dead ticket cannot be revived by a second shape. Do not burn an attempt.
      if (info.captcha_key || info.captcha_sitekey) throw error;
      if (discordFieldErrors(info).ticket || /MFA_INVALID_TICKET/i.test(JSON.stringify(info))) break;
    }
  }
  if (failure) throw mfaError(failure);
  const token = cleanDiscordToken(payload.token);
  if (!token) throw new DiscordError(401, 'Discord did not accept that two-factor code.');
  return token;
}

async function loginWithPassword(login, password, captcha = null) {
  const { signIn } = require('./account');
  const rt = require('./runtime');
  const result = await discordPasswordLogin(login, password, captcha);
  if (result.status === 'mfa') {
    rt.STORE.log('INFO', 'Account', 'Discord asked for a two-factor code.');
    const challenge = { status: 'mfa', ticket: result.ticket, methods: result.methods };
    if (result.loginInstanceId) challenge.loginInstanceId = result.loginInstanceId;
    return challenge;
  }
  const user = await signIn(result.token);
  rt.STORE.log('INFO', 'Account', `Signed in with a password as ${user.displayName}.`);
  return { status: 'ok', user, account: rt.STORE.activeAccountId() };
}

async function loginWithMfa(ticket, code, loginInstanceId = '', captcha = null) {
  const { signIn } = require('./account');
  const rt = require('./runtime');
  const token = await discordMfaLogin(ticket, code, loginInstanceId, captcha);
  const user = await signIn(token);
  rt.STORE.log('INFO', 'Account', `Signed in with a password as ${user.displayName}.`);
  return { status: 'ok', user, account: rt.STORE.activeAccountId() };
}

module.exports = {
  loginHeaders,
  webSuperProperties,
  loginPost,
  loginErrorMessage,
  captchaText,
  captchaChallenge,
  captchaErrors,
  captchaHeaders,
  discordPasswordLogin,
  loginInstance,
  discordMfaLogin,
  loginWithPassword,
  loginWithMfa,
};
