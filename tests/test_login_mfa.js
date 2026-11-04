#!/usr/bin/env node
'use strict';

// Checks the Discord password / two-factor sign-in helpers in lib/login.js.
// global.fetch is stubbed so no request leaves the machine.

const { DiscordError } = require('../lib/discord');
const login = require('../lib/login');

const LOGIN_URL = 'https://discord.com/api/v9/auth/login';
const MFA_URL = 'https://discord.com/api/v9/auth/mfa/totp';
const UUID = '01234567-89ab-cdef-0123-456789abcdef';

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
function installFetch(reply) {
  calls.length = 0;
  global.fetch = async (url, options = {}) => {
    const body = options && options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body, headers: options.headers || {} });
    const result = typeof reply === 'function' ? reply(url, body) : reply;
    const status = result.status || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(result.body || {}),
    };
  };
}

async function main() {
  // login_instance_id is now validated to exactly 36 characters by Discord.
  check(login.loginInstance('') === '', 'an empty login instance is dropped');
  check(login.loginInstance(' instance-abc ') === '', 'a short login instance is dropped');
  check(login.loginInstance(UUID) === UUID, 'a 36 character login instance is kept');

  // A malformed instance id must never reach Discord, or the whole form 400s.
  installFetch((url) => (url === MFA_URL ? { status: 200, body: { token: 'tok-1' } } : { status: 500 }));
  let token = await login.discordMfaLogin('ticket-1', '123456', 'instance-abc');
  check(token === 'tok-1', 'the MFA login returns the token', String(token));
  check(calls.length === 1 && calls[0].body.login_instance_id === undefined, 'a short login instance is not sent', JSON.stringify(calls));
  check(calls[0].body.code === '123456' && calls[0].body.ticket === 'ticket-1', 'the MFA body carries the code and ticket');
  // Discord answers a *current* authenticator code with 60008 unless the
  // two-factor request carries a full web fingerprint, client_launch_id
  // included. This is the fix for "code not accepted" when Discord's own site
  // accepts it.
  let mfaProps = {};
  try { mfaProps = JSON.parse(Buffer.from(calls[0].headers['X-Super-Properties'], 'base64').toString('utf8')); } catch {}
  check(
    Boolean(mfaProps.client_launch_id) && Boolean(mfaProps.launch_signature)
      && Boolean(mfaProps.client_heartbeat_session_id)
      && mfaProps.release_channel === 'stable' && mfaProps.has_client_mods === false,
    'the two-factor request carries a full web fingerprint',
    JSON.stringify(mfaProps)
  );
  check(mfaProps.browser === 'Chrome' && mfaProps.browser_user_agent === calls[0].headers['User-Agent'], 'the fingerprint names the same client as the request');

  // The ticket alone is enough, which is what Discord's own clients send.
  installFetch(() => ({ status: 200, body: { token: 'tok-2' } }));
  token = await login.discordMfaLogin('ticket-1', '123456', UUID);
  check(token === 'tok-2' && calls.length === 1, 'the MFA sign-in finishes on the first try', JSON.stringify(calls));
  check(calls[0].body.login_instance_id === undefined, 'the first MFA try omits the login instance', JSON.stringify(calls[0].body));

  // A shape Discord does not accept the code against is retried with the
  // echoed login instance before giving up.
  installFetch((url, body) =>
    url !== MFA_URL
      ? { status: 500 }
      : body.login_instance_id
        ? { status: 200, body: { token: 'tok-3' } }
        : { status: 400, body: { message: 'Invalid two-factor code', code: 60008 } }
  );
  token = await login.discordMfaLogin('ticket-2', '123456', UUID);
  check(token === 'tok-3' && calls.length === 2, 'a rejected ticket-only try is retried with the login instance', JSON.stringify(calls));
  check(calls[0].body.login_instance_id === undefined && calls[1].body.login_instance_id === UUID, 'the retry adds the login instance');

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

  // A genuinely wrong code keeps the code-specific message.
  installFetch(() => ({ status: 400, body: { message: 'Invalid two factor auth code.', code: 60008 } }));
  let badCode = null;
  try {
    await login.discordMfaLogin('ticket-4', '000000');
  } catch (error) {
    badCode = error;
  }
  check(badCode && /code was not accepted/i.test(badCode.message), 'a rejected code says the code was not accepted', badCode && badCode.message);
  check(badCode && !badCode.reason, 'a rejected code is not reported as an expired step', badCode && badCode.reason);

  // Discord can hand back the MFA ticket on a non-2xx password response.
  installFetch((url) =>
    url === LOGIN_URL
      ? { status: 400, body: { message: 'Two factor is required', mfa: ['totp'], ticket: 'ticket-non2xx', login_instance_id: UUID } }
      : { status: 500 }
  );
  const challenge = await login.discordPasswordLogin('user@example.com', 'pw');
  check(challenge.status === 'mfa' && challenge.ticket === 'ticket-non2xx', 'a non-2xx MFA challenge is treated as MFA', JSON.stringify(challenge));
  check(challenge.loginInstanceId === UUID, 'the non-2xx challenge carries its login instance');

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
  installFetch(() => ({ status: 200, body: { mfa: ['totp'], ticket: 'ticket-5', login_instance_id: 'instance-abc' } }));
  const shortInstance = await login.discordPasswordLogin('user@example.com', 'pw');
  check(shortInstance.status === 'mfa' && shortInstance.loginInstanceId === undefined, 'a short login instance from Discord is not forwarded', JSON.stringify(shortInstance));

  // A captcha must win over a ticket in the same reply: the ticket is bound to
  // the unsolved check, so collapsing it into the MFA step is what made a valid
  // authenticator code look wrong.
  installFetch(() => ({
    status: 400,
    body: { captcha_key: ['captcha-required'], captcha_sitekey: 'site-key', captcha_service: 'hcaptcha', mfa: ['totp'], ticket: 'ticket-captcha' },
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
    body: { captcha_key: ['captcha-required'], captcha_sitekey: 'site-key', captcha_service: 'hcaptcha', mfa: ['totp'], ticket: 'ticket-captcha-2' },
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
            mfa: ['totp'],
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
  check(calls[0].headers['X-Captcha-Key'] === 'solved-mfa', 'the solved token is sent in the captcha header', JSON.stringify(calls[0].headers));
  check(calls[0].body.captcha_key === undefined, 'the solved token is not put in the JSON body');

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
