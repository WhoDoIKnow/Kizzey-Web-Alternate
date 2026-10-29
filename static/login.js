/* Kizzey Web — Discord sign-in panel (email/username + password, with a token fallback) */
(function () {
  'use strict';
  const K = window.K;

  K.onLoginSuccess = null;

  // MFA tickets are short-lived; keep them per panel so two panels can coexist.
  const mfaTickets = {};
  const busy = {};

  /**
   * Markup for both entry points (onboarding and the sign-in sheet).
   * `prefix` keeps the element ids unique when two panels could be on screen.
   */
  K.loginPanel = function loginPanel(prefix = 'login', opts = {}) {
    const tokenOpen = !!opts.tokenOpen;
    return `<div class="login-card" data-login-panel="${prefix}" style="margin-top:0">
      <form data-login-step="credentials" data-submit-action="login-submit" novalidate>
        <div class="field">
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
        <button class="btn btn-primary btn-block btn-lg" type="submit" data-action="login-submit" data-prefix="${prefix}" id="${prefix}-submit">Log In</button>
      </form>

      <form data-login-step="mfa" class="hidden" data-submit-action="login-mfa">
        <div class="login-hint" style="margin-bottom:14px">
          ${K.icon('shield-check', 'sm')}
          <div><b>Two-factor is on</b><span>Enter the 6-digit code from your authenticator app to finish signing in.</span></div>
        </div>
        <div class="field">
          <label for="${prefix}-code"><span>Code</span></label>
          <div class="input-wrap">
            <input id="${prefix}-code" class="input mono-copy" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="123456" style="letter-spacing:.32em">
          </div>
        </div>
        <div id="${prefix}-mfa-error" class="field-error hidden"></div>
        <button class="btn btn-primary btn-block btn-lg" type="submit" data-action="login-mfa" data-prefix="${prefix}" id="${prefix}-mfa-submit">Verify</button>
        <div class="text-center mt-8"><button class="btn btn-ghost btn-sm" type="button" data-action="login-back" data-prefix="${prefix}">Use a different account</button></div>
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
    if (step === 'credentials') mfaTickets[prefix] = '';
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

  function setBusy(prefix, id, on, label, busyLabel) {
    const button = document.querySelector(`#${prefix}-${id}`);
    busy[prefix] = !!on;
    if (!button) return;
    button.disabled = !!on;
    button.textContent = on ? busyLabel : label;
  }

  function finish(data) {
    K.receiveState(data.state || K.state);
    K.closeSheet();
    K.toast('Discord connected', `Signed in as ${K.displayName()}.`, 'ok');
    const cb = K.onLoginSuccess;
    K.onLoginSuccess = null;
    if (typeof cb === 'function') cb(data);
    else K.render();
  }

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
    setBusy(prefix, 'submit', true, 'Log In', 'Signing in…');
    try {
      const data = await K.api('/api/auth/login', { method: 'POST', body: { login, password } });
      if (data.status === 'mfa') {
        mfaTickets[prefix] = data.ticket || '';
        setStep(prefix, 'mfa');
        setTimeout(() => document.querySelector(`#${prefix}-code`)?.focus({ preventScroll: true }), 40);
        return;
      }
      finish(data);
    } catch (error) {
      const captcha = !!(error.data && error.data.captcha);
      showError(prefix, error.message);
      if (captcha) {
        // Discord blocked the password path; the token route is the way through.
        revealTokenBlock(prefix, true);
        setTimeout(() => document.querySelector(`#${prefix}-token`)?.focus({ preventScroll: true }), 40);
      } else if (error.status === 401) {
        passwordInput.select();
        passwordInput.focus();
      }
    } finally {
      setBusy(prefix, 'submit', false, 'Log In', 'Signing in…');
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
    setBusy(prefix, 'mfa-submit', true, 'Verify', 'Checking…');
    try {
      const data = await K.api('/api/auth/mfa', { method: 'POST', body: { ticket, code } });
      finish(data);
    } catch (error) {
      showError(`${prefix}-mfa`, error.message);
      input.select();
      input.focus();
    } finally {
      busy[`${prefix}-mfa`] = false;
      setBusy(prefix, 'mfa-submit', false, 'Verify', 'Checking…');
    }
  };

  K.actions['login-back'] = function (el) {
    const prefix = prefixOf(el);
    mfaTickets[prefix] = '';
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
    setBusy(prefix, 'connect', true, 'Connect with token', 'Checking with Discord…');
    try {
      const data = await K.api('/api/auth/token', { method: 'POST', body: { token } });
      finish(data);
    } catch (error) {
      showError(`${prefix}-token`, error.message);
      input.select();
      input.focus();
    } finally {
      setBusy(prefix, 'connect', false, 'Connect with token', 'Checking with Discord…');
    }
  };

  K.actions['login-help'] = function () {
    K.sheet({
      title: 'Getting a token instead',
      subtitle: 'For when a password sign-in hits a captcha.',
      body: `<div class="setting-group" style="padding:16px">
        <p style="font-size:0.8125rem;line-height:1.6;color:var(--text-dim);margin:0 0 12px">A user token is the same credential the Discord app itself uses. Kizzey needs it for Rich Presence and the message mirror — never a bot token.</p>
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
