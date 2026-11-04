#!/usr/bin/env node
'use strict';

// Checks the Discord password / two-factor sign-in helpers in lib/login.js.
// global.fetch is stubbed so no request leaves the machine.

const fs = require('fs');
const { DiscordError } = require('../lib/discord');
const { LOGIN_CLIENT_FILE } = require('../lib/constants');
const login = require('../lib/login');

const LOGIN_URL = 'https://discord.com/api/v9/auth/login';
const MFA_URL = 'https://discord.com/api/v9/auth/mfa/totp';
const BACKUP_URL = 'https://discord.com/api/v9/auth/mfa/backup';
const SMS_URL = 'https://discord.com/api/v9/auth/mfa/sms';
const EXP_URL = 'https://discord.com/api/v9/experiments?with_guild_experiments=true';
const UUID = '01234567-89ab-cdef-0123-456789abcdef';

// A leftover identity from a previous run would stop /experiments being
// called and make the call-shape checks depend on run order.
login.resetClientIdentity();

const checks = [];
function check(condition, label, extra = '') {
  checks.push(Boolean(condition));
  if (condition) {
    console.log(`ok: ${label}`);
  } else {
    console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

const calls = [];
function installFetch(reply, experiments = null) {
  calls.length = 0;
  global.fetch = async (url, options = {}) => {
    const body = options && options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: (options && options.method) || 'GET', body, headers: options.headers || {} });
    let result;
    if (String(url).startsWith(EXP_URL)) {
      result = experiments || { status: 500, body: {} };
    } else {
      result = typeof reply === 'function' ? reply(url, body) : reply;
    }
    const status = result.status || 200;
    const setCookies = result.setCookies || [];
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { getSetCookie: () => setCookies },
      text: async () => JSON.stringify(result.body || {}),
    };
  };
}

function sent(url) {
  return calls.filter((call) => call.url === url);
}

async function main() {
  // login_instance_id is validated to exactly 36 characters by Discord.
  check(login.loginInstance('') === '', 'an empty login instance is dropped');
  check(login.loginInstance(' instance-abc ') === '', 'a short login instance is dropped');
  check(login.loginInstance(UUID) === UUID, 'a 36 character login instance is kept');

  // `mfa` is a boolean; the factors are individual booleans. Order matches the
  // web client: webauthn, totp, backup, sms.
  check(
    JSON.stringify(login.mfaMethods({ mfa: true, totp: true, sms: true, backup: true, webauthn: '{}' }))
      === JSON.stringify(['webauthn', 'totp', 'backup', 'sms']),
    'the method list is built from the factor booleans'
  );
  check(
    JSON.stringify(login.mfaMethods({ mfa: ['totp'] })) === JSON.stringify(['totp']),
    'an array shaped mfa list still parses'
  );
  check(
    JSON.stringify(login.mfaMethods({ mfa: true })) === JSON.stringify([]),
    'a bare mfa boolean yields no methods'
  );

  // Backup codes go to their own endpoint, six digit codes to /totp.
  check(login.mfaEndpointFor('123456', ['totp', 'backup']).url === MFA_URL, 'a six digit code uses /totp');
  check(login.mfaEndpointFor('ABCD1234', ['totp', 'backup']).url === BACKUP_URL, 'an eight character code uses /backup');
  check(login.mfaEndpointFor('123456', ['sms']).url === SMS_URL, 'sms-only accounts use /sms');

  // A malformed instance id must never reach Discord, or the whole form 400s.
  installFetch((url) => (url === MFA_URL ? { status: 200, body: { token: 'tok-1' } } : { status: 500 }));
  let token = await login.discordMfaLogin('ticket-1', '123456', 'instance-abc');
  check(token === 'tok-1', 'the MFA login returns the token', String(token));
  check(sent(MFA_URL).length === 1 && sent(MFA_URL)[0].body.login_instance_id === undefined, 'a short login instance is not sent', JSON.stringify(sent(MFA_URL)));
  check(sent(MFA_URL)[0].body.code === '123456' && sent(MFA_URL)[0].body.ticket === 'ticket-1', 'the MFA body carries the code and ticket');
  // The web client reports launch_signature as null until libdiscore loads, so
  // a random UUID here was a claim the browser never makes.
  let mfaProps = {};
  try { mfaProps = JSON.parse(Buffer.from(sent(MFA_URL)[0].headers['X-Super-Properties'], 'base64').toString('utf8')); } catch {}
  check(
    Boolean(mfaProps.client_launch_id) && mfaProps.launch_signature === null
      && Boolean(mfaProps.client_heartbeat_session_id)
      && mfaProps.release_channel === 'stable' && mfaProps.has_client_mods === false,
    'the two-factor request carries the web fingerprint',
    JSON.stringify(mfaProps)
  );
  check(mfaProps.browser === 'Chrome' && mfaProps.browser_user_agent === sent(MFA_URL)[0].headers['User-Agent'], 'the fingerprint names the same client as the request');

  // The web client always echoes the login instance on the one attempt it makes.
  installFetch(() => ({ status: 200, body: { token: 'tok-2' } }));
  token = await login.discordMfaLogin('ticket-1', '123456', UUID);
  check(token === 'tok-2' && sent(MFA_URL).length === 1, 'the MFA sign-in finishes on the first try', JSON.stringify(sent(MFA_URL)));
  check(sent(MFA_URL)[0].body.login_instance_id === UUID, 'the single MFA try includes the login instance', JSON.stringify(sent(MFA_URL)[0].body));

  // A rejected code must not be retried with another body: that burns an
  // attempt and shortens the ticket without changing the code.
  installFetch(() => ({ status: 400, body: { message: 'Invalid two-factor code', code: 60008 } }));
  let rejected = null;
  try {
    await login.discordMfaLogin('ticket-2', '123456', UUID);
  } catch (error) {
    rejected = error;
  }
  check(rejected && /code was not accepted/i.test(rejected.message), 'a rejected code says the code was not accepted', rejected && rejected.message);
  check(sent(MFA_URL).length === 1, 'a rejected code is not retried', String(sent(MFA_URL).length));

  // A malformed instance id is the one shape worth a second try.
  installFetch((url, body) =>
    url !== MFA_URL
      ? { status: 500 }
      : body.login_instance_id
        ? { status: 400, body: { message: 'Invalid Form Body', code: 50035, errors: { login_instance_id: { _errors: [{ code: 'BASE_TYPE_BAD_LENGTH' }] } } } }
        : { status: 200, body: { token: 'tok-3' } }
  );
  token = await login.discordMfaLogin('ticket-2', '123456', UUID);
  check(token === 'tok-3' && sent(MFA_URL).length === 2, 'a rejected instance id is retried without it', JSON.stringify(sent(MFA_URL)));
  check(sent(MFA_URL)[0].body.login_instance_id === UUID && sent(MFA_URL)[1].body.login_instance_id === undefined, 'the retry drops the login instance');

  // A dead ticket is reported as an expired step, not a bad code.
  installFetch(() => ({
    status: 400,
    body: { message: 'Invalid Form Body', code: 50035, errors: { ticket: { _errors: [{ code: 'MFA_INVALID_TICKET', message: 'Invalid two-factor auth ticket' }] } } },
  }));
  let expired = null;
  try {
    await login.discordMfaLogin('ticket-3', '123456');
  } catch (error) {
    expired = error;
  }
  check(expired instanceof DiscordError && expired.reason === 'mfa-expired', 'an invalid ticket is an expired step', String(expired));
  check(expired && /expired/i.test(expired.message), 'the expired message says the step expired', expired && expired.message);

  // 60009 is an expired session, also not a bad code.
  installFetch(() => ({ status: 400, body: { message: 'Invalid two-factor session', code: 60009 } }));
  let session = null;
  try {
    await login.discordMfaLogin('ticket-4', '123456');
  } catch (error) {
    session = error;
  }
  check(session && session.reason === 'mfa-expired' && /session expired/i.test(session.message), '60009 is reported as an expired session', session && session.message);

  // Discord can hand back the MFA ticket on a non-2xx password response.
  installFetch((url) =>
    url === LOGIN_URL
      ? { status: 400, body: { message: 'Two factor is required', mfa: true, totp: true, ticket: 'ticket-non2xx', login_instance_id: UUID } }
      : { status: 500 }
  );
  const challenge = await login.discordPasswordLogin('user@example.com', 'pw');
  check(challenge.status === 'mfa' && challenge.ticket === 'ticket-non2xx', 'a non-2xx MFA challenge is treated as MFA', JSON.stringify(challenge));
  check(challenge.loginInstanceId === UUID, 'the non-2xx challenge carries its login instance');
  check(JSON.stringify(challenge.methods) === JSON.stringify(['totp']), 'the non-2xx challenge carries its factors', JSON.stringify(challenge.methods));

  // A 200 token answer still works.
  installFetch(() => ({ status: 200, body: { token: 'tok-pw' } }));
  const ok = await login.discordPasswordLogin('user@example.com', 'pw');
  check(ok.status === 'ok' && ok.token === 'tok-pw', 'a token answer returns ok');

  // A captcha challenge stays an error for the browser to solve.
  installFetch(() => ({
    status: 400,
    body: { captcha_key: ['captcha-required'], captcha_sitekey: 'site-key', captcha_service: 'hcaptcha', message: 'Invalid Form Body' },
  }));
  let captcha = null;
  try {
    await login.discordPasswordLogin('user@example.com', 'pw');
  } catch (error) {
    captcha = error;
  }
  check(captcha instanceof DiscordError && captcha.data.captcha_sitekey === 'site-key', 'a captcha challenge is still an error');

  // A short login instance from Discord is not forwarded either.
  installFetch(() => ({ status: 200, body: { mfa: true, totp: true, ticket: 'ticket-5', login_instance_id: 'instance-abc' } }));
  const shortInstance = await login.discordPasswordLogin('user@example.com', 'pw');
  check(shortInstance.status === 'mfa' && shortInstance.loginInstanceId === undefined, 'a short login instance from Discord is not forwarded', JSON.stringify(shortInstance));

  // A captcha must win over a ticket in the same reply: the ticket is bound to
  // the unsolved check, so collapsing it into the MFA step is what made a valid
  // authenticator code look wrong.
  installFetch(() => ({
    status: 400,
    body: { captcha_key: ['captcha-required'], captcha_sitekey: 'site-key', captcha_service: 'hcaptcha', mfa: true, totp: true, ticket: 'ticket-captcha' },
  }));
  let both = null;
  try {
    await login.discordPasswordLogin('user@example.com', 'pw');
  } catch (error) {
    both = error;
  }
  check(both instanceof DiscordError && both.data.captcha_sitekey === 'site-key', 'a captcha and ticket together stay a captcha error', String(both));

  // The same reply on a 2xx answer is still a captcha to solve first.
  installFetch(() => ({
    status: 200,
    body: { captcha_key: ['captcha-required'], captcha_sitekey: 'site-key', captcha_service: 'hcaptcha', mfa: true, totp: true, ticket: 'ticket-captcha-2' },
  }));
  let both2xx = null;
  try {
    await login.discordPasswordLogin('user@example.com', 'pw');
  } catch (error) {
    both2xx = error;
  }
  check(both2xx instanceof DiscordError && both2xx.data.captcha_sitekey === 'site-key', 'a 2xx captcha is still an error so the sheet can solve it', String(both2xx));

  // Discord can put the captcha on the two-factor step instead of the password
  // step. It has to survive mfaError and carry the refreshed ticket so the
  // solved token can finish the same challenge.
  installFetch((url) =>
    url === MFA_URL
      ? {
          status: 400,
          body: {
            captcha_key: ['captcha-required'],
            captcha_sitekey: 'site-key',
            captcha_service: 'hcaptcha',
            captcha_session_id: 'session-mfa',
            captcha_rqdata: 'rqdata-mfa',
            captcha_rqtoken: 'rqtoken-mfa',
            mfa: true,
            totp: true,
            ticket: 'ticket-mfa-new',
          },
        }
      : { status: 500 }
  );
  let mfaCaptcha = null;
  try {
    await login.discordMfaLogin('ticket-mfa', '123456');
  } catch (error) {
    mfaCaptcha = error;
  }
  check(mfaCaptcha instanceof DiscordError && mfaCaptcha.data.captcha_sitekey === 'site-key', 'a two-factor captcha stays a captcha error', String(mfaCaptcha));
  check(mfaCaptcha && mfaCaptcha.data.ticket === 'ticket-mfa-new', 'the refreshed ticket rides along with the captcha', String(mfaCaptcha));

  // The solved token is sent back as captcha headers, not in the body.
  installFetch((url) => (url === MFA_URL ? { status: 200, body: { token: 'tok-captcha-mfa' } } : { status: 500 }));
  const captchaToken = await login.discordMfaLogin('ticket-mfa-new', '123456', '', {
    key: 'solved-mfa',
    sessionId: 'session-mfa',
    rqtoken: 'rqtoken-mfa',
  });
  check(captchaToken === 'tok-captcha-mfa', 'the two-factor check finishes after the captcha', String(captchaToken));
  check(sent(MFA_URL)[sent(MFA_URL).length - 1].headers['X-Captcha-Key'] === 'solved-mfa', 'the solved token is sent in the captcha header', JSON.stringify(sent(MFA_URL)));
  check(sent(MFA_URL)[sent(MFA_URL).length - 1].body.captcha_key === undefined, 'the solved token is not put in the JSON body');

  // The client identity from /experiments is replayed on the auth calls, with
  // the device cookies Discord set. This is the difference between a session
  // Discord recognises and one it treats as a stranger.
  login.resetClientIdentity();
  installFetch(
    () => ({ status: 200, body: { token: 'tok-identity' } }),
    {
      status: 200,
      body: { fingerprint: 'fp-123', installation: 'inst-456' },
      setCookies: [
        '__dcfduid=abc123; Expires=Mon, 03-Nov-2031 03:23:55 GMT; Max-Age=157680000; Secure; HttpOnly; Path=/; SameSite=Lax',
        '__sdcfduid=def456; Max-Age=157680000; Path=/',
      ],
    }
  );
  token = await login.discordMfaLogin('ticket-6', '123456', UUID);
  const mfaCall = sent(MFA_URL)[0];
  check(token === 'tok-identity', 'the MFA sign-in still finishes with an identity', String(token));
  check(mfaCall.headers['X-Fingerprint'] === 'fp-123', 'the fingerprint is sent on the MFA request', JSON.stringify(mfaCall.headers));
  check(mfaCall.headers['X-Installation-ID'] === 'inst-456', 'the installation id is sent on the MFA request', JSON.stringify(mfaCall.headers));
  check(/__dcfduid=abc123/.test(mfaCall.headers.Cookie || '') && /__sdcfduid=def456/.test(mfaCall.headers.Cookie || ''), 'the device cookies are carried forward', String(mfaCall.headers.Cookie));
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(LOGIN_CLIENT_FILE, 'utf8')); } catch {}
  check(saved && saved.fingerprint === 'fp-123' && saved.installation === 'inst-456', 'the identity is persisted for the next sign-in', JSON.stringify(saved));

  console.log(`\n${checks.filter(Boolean).length}/${checks.length} login checks passed`);
  return checks.every(Boolean) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
