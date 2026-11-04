/* Kizzey Web — Discord sign-in panel (real discord.com sign-in in a browser, password and token fallbacks) */
(function () {
  'use strict';
  const K = window.K;

  K.onLoginSuccess = null;

  // MFA tickets are short-lived; keep them per panel so two panels can coexist.
  const mfaTickets = {};
  const mfaInstances = {};
  const mfaCodes = {};
  // Which factors Discord said this account has (`totp`, `backup`, `sms`,
  // `webauthn`). The six-digit authenticator and the eight-character backup
  // code go to different endpoints, so the sheet must send this back.
  const mfaMethods = {};
  const busy = {};
  let mfaClockTimer = null;

  // A captcha challenge belongs to one password attempt: the site key is
  // per-request and the solved token is single-use, so each panel keeps its
  // own widget and challenge until the retry comes back.
  const captchas = {};
  // Which request the current challenge belongs to: the password sign-in, or
  // the two-factor check Discord is guarding. The solved token is posted back
  // to whichever one asked.
  const captchaStage = {};
  // A sign-in that did not need a captcha still stops on the check step; this
  // holds the result Discord already returned so Continue can advance.
  const pending = {};
  let hcaptchaLoader = null;

  function captchaState(prefix) {
    if (!captchas[prefix]) {
      captchas[prefix] = { challenge: null, widget: null, token: '', submitting: false };
    }
    return captchas[prefix];
  }

  function clearCaptcha(prefix) {
    const state = captchas[prefix];
    if (!state) return;
    if (state.widget !== null && window.hcaptcha) {
      try { window.hcaptcha.remove(state.widget); } catch (err) {}
    }
    state.widget = null;
    state.token = '';
    state.challenge = null;
  }

  function loadHCaptcha() {
    if (window.hcaptcha) return Promise.resolve(window.hcaptcha);
    if (hcaptchaLoader) return hcaptchaLoader;
    hcaptchaLoader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      // Discord's challenge is minted for discord.com. Tell hCaptcha the host
      // explicitly, the same way the mobile SDK does inside a webview, so the
      // solved token is not stamped with this server's LAN address.
      script.src = 'https://js.hcaptcha.com/1/api.js?render=explicit&hl=en&host=discord.com';
      script.async = true;
      script.defer = true;
      // A stalled script would otherwise leave the sheet on "Loading..." for
      // ever; fail after a few seconds so the step can say what happened.
      const timer = setTimeout(() => {
        reject(new Error('hCaptcha took too long to load.'));
      }, 12000);
      const settle = (fn, value) => {
        clearTimeout(timer);
        fn(value);
      };
      script.onload = () => {
        if (window.hcaptcha) settle(resolve, window.hcaptcha);
        else settle(reject, new Error('hCaptcha did not start.'));
      };
      script.onerror = () => settle(reject, new Error('hCaptcha could not be loaded.'));
      document.head.appendChild(script);
    }).catch(error => {
      hcaptchaLoader = null;
      throw error;
    });
    return hcaptchaLoader;
  }

  // Browser sign-in runs locally or against KIZZEY_BROWSER_CDP; the panel asks
  // the server which one so the hint matches what the button will actually do.
  let browserInfo = null;
  let browserInfoRequest = null;

  function browserCopy(info) {
    if (info.mode === 'remote') {
      return {
        title: `Uses the browser at ${info.address}`,
        body: 'Kizzey opens discord.com in a tab there, waits for the sign-in, then closes that tab.',
      };
    }
    if (info.mode === 'local') {
      return {
        title: `Opens discord.com in ${info.browser || 'a browser window'}`,
        body: 'It uses a temporary profile and closes it afterwards, so your everyday browser is untouched.',
      };
    }
    if (info.mode === 'invalid') {
      return {
        title: 'The browser endpoint is misconfigured',
        body: info.error || 'Check KIZZEY_BROWSER_CDP.',
      };
    }
    return {
      title: 'No browser on this server',
      body: 'Use the password or token sign-in below, or point KIZZEY_BROWSER_CDP at a Chrome on another machine.',
    };
  }

  function paintBrowserHint(info) {
    const copy = browserCopy(info || { mode: 'none' });
    const unavailable = !info || info.mode === 'none' || info.available === false;
    document.querySelectorAll('[data-browser-title]').forEach(node => { node.textContent = copy.title; });
    document.querySelectorAll('[data-browser-copy]').forEach(node => { node.textContent = copy.body; });
    // Without a browser the primary button cannot do anything, so get it out of
    // the way and open the password sheet, which is the working sign-in path.
    document.querySelectorAll('[data-login-panel]').forEach(panel => {
      const button = panel.querySelector('[data-action="login-browser"]');
      if (button) button.classList.toggle('hidden', unavailable);
      const prefix = panel.dataset.loginPanel;
      if (prefix && unavailable) revealPasswordBlock(prefix, true);
    });
    document.querySelectorAll('[data-login-panel] [data-action="login-password-toggle"]').forEach(toggle => {
      toggle.classList.toggle('hidden', unavailable);
    });
  }

  function refreshBrowserHint() {
    if (!document.querySelector('[data-browser-copy]')) return;
    if (!browserInfoRequest) {
      browserInfoRequest = K.api('/api/auth/browser/info')
        .then(data => { browserInfo = (data && data.browser) || { mode: 'none' }; })
        .catch(() => { browserInfo = null; })
        .finally(() => { browserInfoRequest = null; });
    }
    browserInfoRequest.then(() => paintBrowserHint(browserInfo));
  }

  /**
   * Markup for both entry points (onboarding and the sign-in sheet).
   * `prefix` keeps the element ids unique when two panels could be on screen.
   *
   * The primary action opens Discord's own login page in a browser window on
   * this machine and picks up the session afterwards. The email/password form
   * and the manual token box stay available but tucked away.
   */
  K.loginPanel = function loginPanel(prefix = 'login', opts = {}) {
    const tokenOpen = !!opts.tokenOpen;
    const html = `<div class="login-card" data-login-panel="${prefix}" style="margin-top:0">
      <form data-login-step="credentials" data-submit-action="login-submit" novalidate>
        <button class="btn btn-primary btn-block btn-lg" type="button" data-action="login-browser" data-prefix="${prefix}" id="${prefix}-browser">${K.icon('login', 'sm')}Sign in with Discord</button>
        <div class="login-hint" style="margin-top:12px">
          ${K.icon('shield-check', 'sm')}
          <div><b data-browser-title>Opens discord.com in a browser window</b><span data-browser-copy>Sign in there like you normally would. Kizzey picks up the session when you are done.</span></div>
        </div>
        <div id="${prefix}-browser-error" class="field-error hidden"></div>

        <div class="mt-8"></div>
        <button class="btn btn-ghost btn-block btn-sm" type="button" data-action="login-password-toggle" data-prefix="${prefix}" aria-expanded="false">${K.icon('key', 'sm')}Use email and password instead</button>

        <div class="hidden" data-password-block="${prefix}">
          <div class="field" style="margin-top:14px">
            <label for="${prefix}-login"><span>Email or username</span></label>
            <div class="input-wrap">
              <input id="${prefix}-login" class="input" type="text" autocomplete="username" spellcheck="false" autocapitalize="none" placeholder="Email or username">
            </div>
          </div>
          <div class="field">
            <label for="${prefix}-password"><span>Password</span></label>
            <div class="input-wrap">
              <input id="${prefix}-password" class="input" type="password" autocomplete="current-password" placeholder="Password">
              <span class="input-suffix"><button class="icon-btn small" type="button" data-action="login-reveal" data-prefix="${prefix}" aria-label="Show password">${K.icon('eye', 'sm')}</button></span>
            </div>
          </div>
          <div id="${prefix}-error" class="field-error hidden"></div>
          <button class="btn btn-primary btn-block btn-lg" type="submit" data-action="login-submit" data-prefix="${prefix}" id="${prefix}-submit">Sign in</button>
        </div>

        <div class="hidden" data-browser-block="${prefix}">
          <div class="login-hint" style="margin-top:14px">
            ${K.icon('external-link', 'sm')}
            <div><b>Waiting for the Discord sign-in</b><span>Finish signing in to Discord in the tab that opened. Kizzey reads the session and closes it afterwards.</span></div>
          </div>
          <button class="btn btn-ghost btn-block btn-sm" type="button" data-action="login-browser-cancel" data-prefix="${prefix}" id="${prefix}-browser-cancel">Cancel</button>
        </div>
      </form>

      <form data-login-step="mfa" class="hidden" data-submit-action="login-mfa">
        <div class="login-hint" style="margin-bottom:14px">
          ${K.icon('shield-check', 'sm')}
          <div><b>Two-factor is on</b><span data-mfa-copy>Enter the 6-digit code from your authenticator app to finish signing in.</span></div>
        </div>
        <div class="field">
          <label for="${prefix}-code"><span data-mfa-label>Code</span></label>
          <div class="input-wrap">
            <input id="${prefix}-code" class="input mono-copy" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="123456" style="letter-spacing:.32em">
          </div>
          <div id="${prefix}-mfa-clock" class="hidden" style="margin-top:8px;opacity:.7;font-size:12px"></div>
        </div>
        <div id="${prefix}-mfa-error" class="field-error hidden"></div>
        <button class="btn btn-primary btn-block btn-lg" type="submit" data-action="login-mfa" data-prefix="${prefix}" id="${prefix}-mfa-submit">Verify</button>
        <div class="text-center mt-8"><button class="btn btn-ghost btn-sm" type="button" data-action="login-back" data-prefix="${prefix}">Use a different account</button></div>
      </form>

      <form data-login-step="captcha" class="hidden" data-submit-action="login-captcha" novalidate>
        <div class="login-hint" style="margin-bottom:14px">
          ${K.icon('shield-check', 'sm')}
          <div><b data-captcha-title>Discord security check</b><span data-captcha-copy>Solve the check below, then press Continue.</span></div>
        </div>
        <div class="captcha-slot" data-captcha-slot="${prefix}"></div>
        <div id="${prefix}-captcha-error" class="field-error hidden"></div>
        <button class="btn btn-primary btn-block btn-lg" type="submit" data-action="login-captcha" data-prefix="${prefix}" id="${prefix}-captcha-submit" disabled>Continue</button>
        <div class="text-center mt-8">
          <button class="btn btn-ghost btn-sm hidden" type="button" data-action="login-captcha-reload" data-prefix="${prefix}" id="${prefix}-captcha-reload">Reload the check</button>
          <button class="btn btn-ghost btn-sm" type="button" data-action="login-back" data-prefix="${prefix}">Use a different account</button>
        </div>
      </form>

      <div class="login-or"><span>or</span></div>
      <button class="btn btn-ghost btn-block btn-sm" type="button" data-action="login-token-toggle" data-prefix="${prefix}" aria-expanded="${tokenOpen ? 'true' : 'false'}" data-open="${tokenOpen ? 'true' : 'false'}">
        ${K.icon('key', 'sm')}Use a token instead
      </button>

      <div class="login-token-block ${tokenOpen ? '' : 'hidden'}" data-token-block="${prefix}">
        <div class="field">
          <label for="${prefix}-token"><span>Discord user token</span><span class="optional">stays on this machine</span></label>
          <div class="input-wrap">
            <input id="${prefix}-token" class="input" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your token">
            <span class="input-suffix"><button class="icon-btn small" type="button" data-action="login-toggle" data-prefix="${prefix}" aria-label="Show token">${K.icon('eye', 'sm')}</button></span>
          </div>
          <div class="field-hint">Handy when Discord wants a captcha for a password sign-in.</div>
        </div>
        <div id="${prefix}-token-error" class="field-error hidden"></div>
        <button class="btn btn-ghost btn-block" type="button" data-action="login-connect" data-prefix="${prefix}" id="${prefix}-connect">Connect with token</button>
      </div>

      <div class="login-note">
        ${K.icon('lock', 'sm')}
        <span>Kizzey runs on your own machine only. Your password goes straight to Discord from this computer; only the session token is kept, and it never leaves your disk.</span>
      </div>
    </div>`;
    browserInfo = null;
    setTimeout(refreshBrowserHint, 0);
    return html;
  };

  function panelFor(el) {
    return (el && el.closest && el.closest('[data-login-panel]')) || document.querySelector('[data-login-panel]');
  }

  function prefixOf(el) {
    const panel = panelFor(el);
    return (panel && panel.dataset.loginPanel) || 'login';
  }

  function setStep(prefix, step) {
    const panel = document.querySelector(`[data-login-panel="${prefix}"]`);
    if (!panel) return;
    panel.querySelectorAll('[data-login-step]').forEach(node => {
      node.classList.toggle('hidden', node.dataset.loginStep !== step);
    });
    if (step !== 'mfa') stopMfaClock();
    if (step === 'credentials') {
      mfaTickets[prefix] = '';
      mfaInstances[prefix] = '';
      mfaMethods[prefix] = [];
      pending[prefix] = null;
    }
  }

  // Authenticator codes are only valid for the current 30 second window. The
  // captcha step can easily eat a window, so show how long the displayed code
  // has left instead of letting a just-expired code look "wrong".
  function stopMfaClock() {
    if (mfaClockTimer) {
      clearInterval(mfaClockTimer);
      mfaClockTimer = null;
    }
    document.querySelectorAll('[data-mfa-clock]').forEach(node => node.classList.add('hidden'));
  }

  function startMfaClock(prefix) {
    stopMfaClock();
    const el = document.querySelector(`#${prefix}-mfa-clock`);
    if (!el) return;
    const tick = () => {
      const left = 30 - (Math.floor(Date.now() / 1000) % 30);
      el.textContent = left <= 5
        ? `A new code appears in ${left}s — wait for it, then type it.`
        : `This code has ${left}s left. Codes rotate every 30s.`;
    };
    el.classList.remove('hidden');
    tick();
    mfaClockTimer = setInterval(tick, 500);
  }

  function applyMfaHint(prefix) {
    const panel = document.querySelector(`[data-login-panel="${prefix}"]`);
    if (!panel) return;
    const methods = mfaMethods[prefix] || [];
    const usesTotp = methods.includes('totp');
    const usesBackup = methods.includes('backup');
    const usesSms = methods.includes('sms');
    const copy = panel.querySelector('[data-mfa-copy]');
    const label = panel.querySelector('[data-mfa-label]');
    const input = panel.querySelector(`#${prefix}-code`);
    if (usesTotp) {
      if (copy) copy.textContent = 'Enter the current 6-digit code from your authenticator app.';
      if (label) label.textContent = 'Authenticator code';
      if (input) { input.placeholder = '123456'; input.maxLength = 8; input.inputMode = 'numeric'; }
    } else if (usesBackup) {
      if (copy) copy.textContent = 'Enter one of your 8-character Discord backup codes.';
      if (label) label.textContent = 'Backup code';
      if (input) { input.placeholder = 'XXXXXXXX'; input.maxLength = 8; input.inputMode = 'text'; }
    } else if (usesSms) {
      if (copy) copy.textContent = 'Enter the 6-digit code Discord sent to your phone.';
      if (label) label.textContent = 'Texted code';
      if (input) { input.placeholder = '123456'; input.maxLength = 8; input.inputMode = 'numeric'; }
    } else {
      if (copy) copy.textContent = 'Enter the code from your two-factor app, or an 8-character backup code.';
      if (label) label.textContent = 'Code';
      if (input) { input.placeholder = '123456'; input.maxLength = 8; input.inputMode = 'text'; }
    }
    if (usesTotp) startMfaClock(prefix);
    else stopMfaClock();
  }

  function enterMfa(prefix, data) {
    mfaTickets[prefix] = (data && data.ticket) || '';
    mfaInstances[prefix] = (data && data.loginInstanceId) || '';
    mfaMethods[prefix] = Array.isArray(data && data.methods) ? data.methods.map(String) : [];
    setStep(prefix, 'mfa');
    applyMfaHint(prefix);
    setTimeout(() => document.querySelector(`#${prefix}-code`)?.focus({ preventScroll: true }), 40);
  }

  function showError(id, message) {
    const box = document.querySelector(`#${id}-error`);
    if (!box) {
      K.toast('Discord sign-in failed', message, 'error');
      return;
    }
    box.textContent = message;
    box.classList.remove('hidden');
  }

  function clearError(id) {
    document.querySelector(`#${id}-error`)?.classList.add('hidden');
  }

  function revealTokenBlock(prefix, open) {
    const block = document.querySelector(`[data-token-block="${prefix}"]`);
    const toggle = document.querySelector(`[data-login-panel="${prefix}"] [data-action="login-token-toggle"]`);
    if (!block) return;
    block.classList.toggle('hidden', !open);
    if (toggle) {
      toggle.dataset.open = open ? 'true' : 'false';
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  }

  function revealPasswordBlock(prefix, open) {
    const block = document.querySelector(`[data-password-block="${prefix}"]`);
    const toggle = document.querySelector(`[data-login-panel="${prefix}"] [data-action="login-password-toggle"]`);
    if (!block) return;
    block.classList.toggle('hidden', !open);
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function setBusy(prefix, id, on, label, busyLabel) {
    const button = document.querySelector(`#${prefix}-${id}`);
    busy[prefix] = !!on;
    if (!button) return;
    button.disabled = !!on;
    button.textContent = on ? busyLabel : label;
  }

  // The browser request stays open for as long as the sign-in window does, so
  // the panel shows a waiting row with a cancel button instead of freezing.
  function setBrowserBusy(prefix, on) {
    busy[prefix] = !!on;
    const button = document.querySelector(`#${prefix}-browser`);
    if (button) button.disabled = !!on;
    const toggle = document.querySelector(`[data-login-panel="${prefix}"] [data-action="login-password-toggle"]`);
    if (toggle) toggle.disabled = !!on;
    const block = document.querySelector(`[data-browser-block="${prefix}"]`);
    if (block) block.classList.toggle('hidden', !on);
    const cancel = document.querySelector(`#${prefix}-browser-cancel`);
    if (cancel) {
      cancel.disabled = false;
      cancel.textContent = 'Cancel';
    }
  }

  function finish(data) {
    Object.keys(captchas).forEach(clearCaptcha);
    Object.keys(pending).forEach(key => { pending[key] = null; });
    K.receiveState(data.state || K.state);
    K.closeSheet();
    K.toast('Discord connected', `Signed in as ${K.displayName()}.`, 'ok');
    const cb = K.onLoginSuccess;
    K.onLoginSuccess = null;
    if (typeof cb === 'function') cb(data);
    else K.render();
  }

  // -- captcha relay --------------------------------------------------------
  //
  // Discord answers a datacenter password sign-in with an hCaptcha demand. The
  // server cannot solve that, so the challenge is handed to whichever browser
  // is using Kizzey: the site key and Enterprise request data come from the
  // 400 response, the widget runs here, and only the solved response token goes
  // back. Nothing is outsourced to a solver service.

  function captchaRetryBody(prefix, token) {
    const state = captchaState(prefix);
    const challenge = state.challenge || {};
    const login = (document.querySelector(`#${prefix}-login`)?.value || '').trim();
    const password = document.querySelector(`#${prefix}-password`)?.value || '';
    return {
      login,
      password,
      captchaKey: token,
      captchaSessionId: challenge.sessionId || '',
      captchaRqToken: challenge.rqtoken || '',
    };
  }

  async function submitCaptcha(prefix, token) {
    const state = captchaState(prefix);
    if (state.submitting) return;
    if (!token) {
      showError(`${prefix}-captcha`, 'Solve the check first.');
      return;
    }
    const stage = captchaStage[prefix] === 'mfa' ? 'mfa' : 'login';
    const body = stage === 'mfa'
      ? {
          ticket: mfaTickets[prefix] || '',
          code: mfaCodes[prefix] || '',
          loginInstanceId: mfaInstances[prefix] || '',
          methods: mfaMethods[prefix] || [],
          captchaKey: token,
          captchaSessionId: (state.challenge || {}).sessionId || '',
          captchaRqToken: (state.challenge || {}).rqtoken || '',
        }
      : captchaRetryBody(prefix, token);
    if (stage === 'login' && (!body.login || !body.password)) {
      setStep(prefix, 'credentials');
      showError(prefix, 'Enter your Discord email and password again.');
      return;
    }
    state.submitting = true;
    setBusy(prefix, 'captcha-submit', true, 'Continue', 'Checking...');
    try {
      const data = await K.api(stage === 'mfa' ? '/api/auth/mfa' : '/api/auth/login', { method: 'POST', body });
      if (data.status === 'mfa') {
        enterMfa(prefix, data);
        return;
      }
      finish(data);
    } catch (error) {
      const next = error.data && error.data.challenge;
      if (next && next.sitekey) {
        // The token was rejected or the password was wrong; Discord issued a
        // fresh challenge. Render that one instead of reusing the dead token.
        if (error.data.ticket) mfaTickets[prefix] = String(error.data.ticket);
        await showCaptcha(prefix, next);
        const codes = (next.errors || []).filter(code => code && code !== 'captcha-required');
        showError(
          `${prefix}-captcha`,
          codes.length ? `${error.message} Discord said: ${codes.join(', ')}.` : error.message
        );
        return;
      }
      if (stage === 'mfa') {
        setStep(prefix, 'mfa');
        showError(`${prefix}-mfa`, error.message);
        return;
      }
      setStep(prefix, 'credentials');
      showError(prefix, error.message);
      if (error.status === 401) {
        const password = document.querySelector(`#${prefix}-password`);
        if (password) {
          password.select();
          password.focus();
        }
      } else {
        revealTokenBlock(prefix, true);
      }
    } finally {
      state.submitting = false;
      setBusy(prefix, 'captcha-submit', false, 'Continue', 'Checking...');
    }
  }

  // The check step is always shown after a password sign-in, so Discord's
  // captcha is visible when it asks for one. Three shapes:
  //   * a challenge -> draw the hCaptcha box, wait for the solve, then Continue
  //   * no challenge -> Discord did not ask; Continue advances the result the
  //                     server already returned (MFA step or signed in)
  //   * notice -> Discord wants a check this browser cannot draw; explain and
  //               point at the token route
  async function showCaptcha(prefix, challenge, notice = '') {
    const state = captchaState(prefix);
    if (state.widget !== null && window.hcaptcha) {
      try { window.hcaptcha.remove(state.widget); } catch (err) {}
    }
    state.widget = null;
    state.token = '';
    state.challenge = challenge || null;
    setStep(prefix, 'captcha');
    clearError(`${prefix}-captcha`);
    const slot = document.querySelector(`[data-captcha-slot="${prefix}"]`);
    const button = document.querySelector(`#${prefix}-captcha-submit`);
    const reload = document.querySelector(`#${prefix}-captcha-reload`);
    const title = document.querySelector(`[data-login-panel="${prefix}"] [data-captcha-title]`);
    const copy = document.querySelector(`[data-login-panel="${prefix}"] [data-captcha-copy]`);
    if (reload) reload.classList.add('hidden');
    if (!challenge) {
      if (slot) slot.innerHTML = '';
      if (notice) {
        if (title) title.textContent = 'Discord wants a check this browser cannot show';
        if (copy) copy.textContent = 'Use a token instead, or try again from a secure (HTTPS) address.';
        if (button) button.disabled = true;
        showError(`${prefix}-captcha`, notice);
        revealTokenBlock(prefix, true);
      } else {
        if (title) title.textContent = 'Discord did not ask for a check';
        if (copy) copy.textContent = 'Press Continue to finish signing in.';
        if (button) button.disabled = !pending[prefix];
      }
      return;
    }
    if (title) title.textContent = 'Discord wants a quick check';
    if (copy) copy.textContent = 'Solve the check below, then press Continue.';
    if (!slot) {
      showError(`${prefix}-captcha`, 'The captcha could not start. Use a token instead.');
      revealTokenBlock(prefix, true);
      return;
    }
    if (button) button.disabled = true;
    slot.innerHTML = '<div class="captcha-loading">Loading the check…</div>';
    let api;
    try {
      api = await loadHCaptcha();
    } catch (error) {
      slot.innerHTML = '';
      if (reload) reload.classList.remove('hidden');
      showError(
        `${prefix}-captcha`,
        'The captcha could not be loaded here. Open Kizzey over HTTPS or localhost so the check can run, or use a token instead.'
      );
      revealTokenBlock(prefix, true);
      return;
    }
    if (state.widget !== null) {
      try { api.remove(state.widget); } catch (err) {}
      state.widget = null;
    }
    slot.innerHTML = '';
    // Discord says whether the check may run silently (`should_serve_invisible`).
    // When it may not, draw the real hCaptcha checkbox so the operator can see
    // and solve it. A hardcoded invisible widget is why the box never appeared.
    const invisible = Boolean(challenge.invisible);
    const options = {
      sitekey: challenge.sitekey,
      theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
      size: invisible ? 'invisible' : 'normal',
      rqdata: challenge.rqdata || undefined,
      callback: token => {
        state.token = token;
        clearError(`${prefix}-captcha`);
        if (button) button.disabled = false;
        // Check the box, then press Continue. An invisible widget has no box to
        // click, so finish it straight away.
        if (invisible) submitCaptcha(prefix, token);
      },
      'expired-callback': () => {
        state.token = '';
        if (button) button.disabled = true;
        showError(`${prefix}-captcha`, 'That check expired. Solve it again.');
        runCaptcha(prefix);
      },
      'close-callback': () => {
        if (!state.token) {
          showError(`${prefix}-captcha`, 'The check was closed before it finished. Try again.');
        }
      },
      'error-callback': () => {
        state.token = '';
        if (button) button.disabled = true;
        if (reload) reload.classList.remove('hidden');
        showError(
          `${prefix}-captcha`,
          'The captcha could not run in this browser. Open Kizzey over HTTPS or localhost, or use a token instead.'
        );
        revealTokenBlock(prefix, true);
      },
    };
    try {
      state.widget = api.render(slot, options);
    } catch (error) {
      if (reload) reload.classList.remove('hidden');
      showError(`${prefix}-captcha`, 'The captcha could not start. Use a token instead.');
      revealTokenBlock(prefix, true);
      return;
    }
    // The Enterprise request data travels with the solve whether the widget is
    // invisible or the operator is clicking a visible checkbox.
    if (challenge.rqdata && typeof api.setData === 'function') {
      try { api.setData(state.widget, { rqdata: challenge.rqdata }); } catch (err) {}
    }
    if (invisible) runCaptcha(prefix);
  }

  function runCaptcha(prefix) {
    const state = captchaState(prefix);
    if (state.widget === null || !window.hcaptcha) return;
    const data = {};
    if (state.challenge && state.challenge.rqdata) data.rqdata = state.challenge.rqdata;
    // execute() carries rqdata into hCaptcha's challenge request. setData()
    // covers builds that read Enterprise data from the widget instead.
    if (data.rqdata && typeof window.hcaptcha.setData === 'function') {
      try { window.hcaptcha.setData(state.widget, { rqdata: data.rqdata }); } catch (err) {}
    }
    try { window.hcaptcha.execute(state.widget, data); } catch (err) {}
  }

  K.actions['login-captcha'] = function (el) {
    const prefix = prefixOf(el);
    const state = captchaState(prefix);
    if (state.submitting) return;
    if (!state.challenge) {
      // No check was needed on this attempt: Continue advances the result the
      // server already returned.
      const result = pending[prefix];
      pending[prefix] = null;
      if (!result) {
        setStep(prefix, 'credentials');
        return;
      }
      if (result.status === 'mfa') {
        enterMfa(prefix, result);
        return;
      }
      finish(result);
      return;
    }
    if (state.token) {
      submitCaptcha(prefix, state.token);
      return;
    }
    if (state.widget !== null) {
      runCaptcha(prefix);
      return;
    }
    showError(`${prefix}-captcha`, 'The check is still loading. Try again in a moment.');
  };

  K.actions['login-captcha-reload'] = function (el) {
    const prefix = prefixOf(el);
    const state = captchaState(prefix);
    if (!state.challenge) return;
    showCaptcha(prefix, state.challenge);
  };

  K.actions['login-browser'] = async function (el) {
    const prefix = prefixOf(el);
    if (busy[prefix]) return;
    clearError(prefix);
    clearError(`${prefix}-browser`);
    setBrowserBusy(prefix, true);
    try {
      // No body: the server opens discord.com/login and holds this request open
      // until the operator finishes (or cancels) in that window.
      const data = await K.api('/api/auth/browser', { method: 'POST', body: {} });
      if (data && data.cancelled) {
        K.toast('Sign-in cancelled', 'No account was added.', 'info');
        return;
      }
      finish(data);
    } catch (error) {
      showError(`${prefix}-browser`, error.message);
      if (/no chrome|no browser|browser sign-in is not available|KIZZEY_BROWSER_CDP|devtools/i.test(error.message || '')) {
        revealPasswordBlock(prefix, true);
        refreshBrowserHint();
      }
    } finally {
      setBrowserBusy(prefix, false);
    }
  };

  K.actions['login-browser-cancel'] = function (el) {
    const prefix = prefixOf(el);
    if (el) {
      el.disabled = true;
      el.textContent = 'Closing the window...';
    }
    // Fire and forget: the waiting request returns with `cancelled: true`.
    K.api('/api/auth/browser/cancel', { method: 'POST', body: {} }).catch(() => {});
    clearError(`${prefix}-browser`);
  };

  K.actions['login-password-toggle'] = function (el) {
    const prefix = prefixOf(el);
    const block = document.querySelector(`[data-password-block="${prefix}"]`);
    if (!block) return;
    const open = block.classList.contains('hidden');
    revealPasswordBlock(prefix, open);
    if (open) document.querySelector(`#${prefix}-login`)?.focus({ preventScroll: true });
  };

  K.actions['login-reveal'] = function (el) {
    const prefix = prefixOf(el);
    const input = document.querySelector(`#${prefix}-password`);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    if (el) el.innerHTML = K.icon(show ? 'eye-off' : 'eye', 'sm');
    if (el) el.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  };

  K.actions['login-submit'] = async function (el) {
    const prefix = prefixOf(el);
    if (busy[prefix]) return;
    const loginInput = document.querySelector(`#${prefix}-login`);
    const passwordInput = document.querySelector(`#${prefix}-password`);
    if (!loginInput || !passwordInput) return;
    const login = loginInput.value.trim();
    const password = passwordInput.value;
    clearError(prefix);
    if (!login) {
      showError(prefix, 'Enter your Discord email or username.');
      loginInput.focus();
      return;
    }
    if (!password) {
      showError(prefix, 'Enter your Discord password.');
      passwordInput.focus();
      return;
    }
    setBusy(prefix, 'submit', true, 'Sign in', 'Signing in...');
    captchaStage[prefix] = 'login';
    pending[prefix] = null;
    try {
      const data = await K.api('/api/auth/login', { method: 'POST', body: { login, password } });
      // Discord may or may not ask for a check. Either way stop on the check
      // step: with a challenge the operator solves it, without one they press
      // Continue and the answer Discord already gave is used.
      pending[prefix] = data;
      await showCaptcha(prefix, null);
      return;
    } catch (error) {
      const challenge = error.data && error.data.challenge;
      if (challenge && challenge.sitekey) {
        captchaStage[prefix] = 'login';
        await showCaptcha(prefix, challenge);
        return;
      }
      if (error.data && error.data.captcha) {
        // Discord wants a check this browser cannot draw (or the challenge was
        // malformed). Still show the step so the failure is visible, and point
        // at the token route.
        captchaStage[prefix] = 'login';
        await showCaptcha(prefix, null, error.message);
        return;
      }
      showError(prefix, error.message);
      if (error.status === 401) {
        passwordInput.select();
        passwordInput.focus();
      }
    } finally {
      setBusy(prefix, 'submit', false, 'Sign in', 'Signing in...');
    }
  };

  K.actions['login-mfa'] = async function (el) {
    const prefix = prefixOf(el);
    if (busy[`${prefix}-mfa`]) return;
    const input = document.querySelector(`#${prefix}-code`);
    if (!input) return;
    const code = input.value.trim();
    const ticket = mfaTickets[prefix];
    clearError(`${prefix}-mfa`);
    if (!ticket) {
      showError(`${prefix}-mfa`, 'That two-factor step expired. Sign in again.');
      setStep(prefix, 'credentials');
      return;
    }
    if (!code) {
      showError(`${prefix}-mfa`, 'Enter the code from your authenticator app.');
      input.focus();
      return;
    }
    busy[`${prefix}-mfa`] = true;
    setBusy(prefix, 'mfa-submit', true, 'Verify', 'Checking...');
    try {
      const data = await K.api('/api/auth/mfa', {
        method: 'POST',
        body: { ticket, code, loginInstanceId: mfaInstances[prefix] || '', methods: mfaMethods[prefix] || [] },
      });
      finish(data);
    } catch (error) {
      if (error.data && error.data.reason === 'mfa-expired') {
        // The ticket is dead; the code can never be accepted against it.
        setStep(prefix, 'credentials');
        showError(prefix, error.message);
        return;
      }
      const challenge = error.data && error.data.challenge;
      if (challenge && challenge.sitekey) {
        // Discord wants the captcha solved before it checks the code. Keep the
        // code and hand the challenge to the sheet, then retry the same step.
        mfaCodes[prefix] = code;
        if (error.data.ticket) mfaTickets[prefix] = String(error.data.ticket);
        captchaStage[prefix] = 'mfa';
        await showCaptcha(prefix, challenge);
        return;
      }
      showError(`${prefix}-mfa`, error.message);
      input.select();
      input.focus();
    } finally {
      busy[`${prefix}-mfa`] = false;
      setBusy(prefix, 'mfa-submit', false, 'Verify', 'Checking...');
    }
  };

  K.actions['login-back'] = function (el) {
    const prefix = prefixOf(el);
    mfaTickets[prefix] = '';
    mfaInstances[prefix] = '';
    mfaCodes[prefix] = '';
    mfaMethods[prefix] = [];
    stopMfaClock();
    captchaStage[prefix] = '';
    pending[prefix] = null;
    clearCaptcha(prefix);
    clearError(`${prefix}-captcha`);
    const code = document.querySelector(`#${prefix}-code`);
    if (code) code.value = '';
    clearError(`${prefix}-mfa`);
    setStep(prefix, 'credentials');
    setTimeout(() => document.querySelector(`#${prefix}-login`)?.focus({ preventScroll: true }), 40);
  };

  K.actions['login-token-toggle'] = function (el) {
    const prefix = prefixOf(el);
    const block = document.querySelector(`[data-token-block="${prefix}"]`);
    if (!block) return;
    const open = block.classList.contains('hidden');
    revealTokenBlock(prefix, open);
    if (open) document.querySelector(`#${prefix}-token`)?.focus({ preventScroll: true });
  };

  K.actions['login-toggle'] = function (el) {
    const prefix = prefixOf(el);
    const input = document.querySelector(`#${prefix}-token`);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  };

  K.actions['login-connect'] = async function (el) {
    const prefix = prefixOf(el);
    const input = document.querySelector(`#${prefix}-token`);
    if (!input) return;
    const token = input.value.trim();
    clearError(`${prefix}-token`);
    if (!token) {
      showError(`${prefix}-token`, 'Paste your Discord token first.');
      input.focus();
      return;
    }
    setBusy(prefix, 'connect', true, 'Connect with token', 'Checking with Discord...');
    try {
      const data = await K.api('/api/auth/token', { method: 'POST', body: { token } });
      finish(data);
    } catch (error) {
      showError(`${prefix}-token`, error.message);
      input.select();
      input.focus();
    } finally {
      setBusy(prefix, 'connect', false, 'Connect with token', 'Checking with Discord...');
    }
  };

  K.actions['login-help'] = function () {
    K.sheet({
      title: 'How Discord sign-in works',
      subtitle: 'One click, then Discord does the rest.',
      body: `<div class="setting-group" style="padding:16px">
        <p style="font-size:0.8125rem;line-height:1.6;color:var(--text-dim);margin:0 0 12px"><b>Sign in with Discord</b> opens discord.com/login in a browser window on this machine. Sign in there exactly as you normally would. When you are done Kizzey reads the session Discord just created, saves the token on this machine, and closes the window. Nothing is typed into Kizzey and nothing is sent anywhere except to Discord.</p>
        <div class="login-hint">
          ${K.icon('info-circle', 'sm')}
          <div><b>Nothing to install</b><span>Kizzey uses Chrome, Edge, or Brave if one is already on this computer, in a temporary profile it deletes afterwards.</span></div>
        </div>
      </div>
      <div class="setting-group" style="padding:16px;padding-top:0">
        <p style="font-size:0.8125rem;line-height:1.6;color:var(--text-dim);margin:0 0 12px">If the window cannot open, use <b>Use email and password instead</b> or paste a token by hand. When Discord asks for a captcha on the password path, it appears in this sheet and you solve it on the device you are using. A user token is the same credential the Discord app itself uses — Kizzey needs it for Rich Presence and the message mirror, never a bot token.</p>
        <div class="login-steps">
          <span><b class="step-num">1</b><span>Open <a href="https://discord.com/login" target="_blank" rel="noopener">discord.com/login</a> in a desktop browser and sign in.</span></span>
          <span><b class="step-num">2</b><span>Press <kbd>F12</kbd>, open <b>Application</b>, then <b>Local Storage → https://discord.com</b>.</span></span>
          <span><b class="step-num">3</b><span>Copy the value of the key named <b>token</b>.</span></span>
          <span><b class="step-num">4</b><span>Paste it into Kizzey. It is checked with Discord once and then stored on this machine only.</span></span>
        </div>
        <div class="danger-zone" style="margin-top:16px">
          <div class="dz-title">Keep it private</div>
          <p style="margin-bottom:0">A user token gives full access to the account. Kizzey runs on your own machine and never sends it anywhere but Discord.</p>
        </div>
      </div>
      <div class="modal-actions"><button class="btn btn-primary" data-close-sheet>Got it</button></div>`,
    });
  };
})();