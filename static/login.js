/* Kizzey Web — shared Discord sign-in panel (OAuth2 + advanced user token) */
(function () {
  'use strict';
  const K = window.K;

  K.onLoginSuccess = null;

  K.oauthConfigured = function oauthConfigured() {
    return !!K.get('auth.oauth.configured', false);
  };

  K.oauthRedirectUri = function oauthRedirectUri() {
    return String(K.get('auth.oauth.redirectUri', '') || '');
  };

  /**
   * Markup for both entry points (onboarding and the sign-in sheet).
   * `prefix` keeps the element ids unique when two panels could be on screen.
   */
  K.loginPanel = function loginPanel(prefix = 'login', opts = {}) {
    const configured = K.oauthConfigured();
    const open = opts.tokenOpen != null ? !!opts.tokenOpen : !configured;
    const oauth = configured
      ? `<button class="btn btn-primary btn-block btn-lg" data-action="login-oauth" data-prefix="${prefix}">
          ${K.icon('discord', 'sm')}Continue with Discord
        </button>
        <div class="login-or"><span>or</span></div>
        <button class="btn btn-ghost btn-block btn-sm" data-action="login-token-toggle" data-prefix="${prefix}" aria-expanded="${open ? 'true' : 'false'}" data-open="${open ? 'true' : 'false'}">
          ${K.icon('key', 'sm')}Use a user token instead
        </button>`
      : `<div class="login-hint">
          ${K.icon('info', 'sm')}
          <div><b>Discord sign-in is not set up yet</b><span>Add your Discord application's Client ID and secret once, then everyone can use one-click sign-in.</span>
          <div class="mt-8"><button class="btn btn-ghost btn-sm" data-route="discord-login">${K.icon('settings', 'sm')}Set up Discord login</button></div></div>
        </div>`;
    return `<div class="login-card" data-login-panel="${prefix}" style="margin-top:0">
      ${oauth}
      <div class="login-token-block ${open ? '' : 'hidden'}" data-token-block="${prefix}">
        <div class="field">
          <label for="${prefix}-token"><span>Discord user token</span><span class="optional">stays on this server</span></label>
          <div class="input-wrap">
            <input id="${prefix}-token" class="input" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your token">
            <span class="input-suffix"><button class="icon-btn small" data-action="login-toggle" data-prefix="${prefix}" aria-label="Show token">${K.icon('eye', 'sm')}</button></span>
          </div>
          <div class="field-hint">Sent only to your Kizzey server. The browser never receives it back.</div>
        </div>
        <div id="${prefix}-error" class="field-error hidden"></div>
        <button class="btn ${configured ? 'btn-ghost' : 'btn-primary'} btn-block" data-action="login-connect" data-prefix="${prefix}" id="${prefix}-connect">Connect with token</button>
        <div class="login-steps">
          <span><b class="step-num">1</b><span>Open <a href="https://discord.com/login" target="_blank" rel="noopener">discord.com/login</a> and sign in.</span></span>
          <span><b class="step-num">2</b><span>In desktop DevTools, open <b>Application → Local Storage → discord.com</b> and copy the <b>token</b> value.</span></span>
          <span><b class="step-num">3</b><span>Paste it above. Kizzey keeps it in <span class="mono-copy">data/secret.json</span>.</span></span>
        </div>
      </div>
      <div class="login-note">
        ${K.icon('lock', 'sm')}
        <span>Discord sign-in confirms your identity. Rich Presence and the message mirror still need a user token — Discord does not give OAuth apps those permissions.</span>
      </div>
    </div>`;
  };

  function panelFor(el) {
    return (el && el.closest && el.closest('[data-login-panel]')) || document.querySelector('[data-login-panel]');
  }

  function showError(prefix, message) {
    const box = document.querySelector(`#${prefix}-error`);
    if (!box) { K.toast('Discord sign-in failed', message, 'error'); return; }
    box.textContent = message;
    box.classList.remove('hidden');
    document.querySelector(`#${prefix}-token`)?.focus();
  }

  K.actions['login-oauth'] = async function (el) {
    const prefix = (panelFor(el)?.dataset.loginPanel) || 'login';
    if (!K.oauthConfigured()) {
      K.toast('Discord sign-in is not configured', 'Add a Discord application Client ID and secret in Settings → Discord login.', 'error');
      return;
    }
    el.disabled = true;
    try {
      const data = await K.api('/api/auth/oauth/start');
      if (!data.url) throw new Error('The server did not return a Discord sign-in link.');
      const box = document.querySelector(`#${prefix}-error`);
      if (box) box.classList.add('hidden');
      window.location.assign(data.url);
    } catch (error) {
      el.disabled = false;
      showError(prefix, error.message);
    }
  };

  K.actions['login-token-toggle'] = function (el) {
    const panel = panelFor(el);
    const prefix = panel?.dataset.loginPanel || 'login';
    const block = document.querySelector(`[data-token-block="${prefix}"]`);
    if (!block) return;
    const open = block.classList.contains('hidden');
    block.classList.toggle('hidden', !open);
    if (el) {
      el.dataset.open = open ? 'true' : 'false';
      el.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (open) document.querySelector(`#${prefix}-token`)?.focus({ preventScroll: true });
  };

  K.actions['login-toggle'] = function (el) {
    const prefix = (panelFor(el)?.dataset.loginPanel) || 'login';
    const input = document.querySelector(`#${prefix}-token`);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  };

  K.actions['login-connect'] = async function (el) {
    const panel = panelFor(el);
    const prefix = panel?.dataset.loginPanel || 'login';
    const input = document.querySelector(`#${prefix}-token`);
    const button = document.querySelector(`#${prefix}-connect`);
    if (!input) return;
    const token = input.value.trim();
    if (!token) { showError(prefix, 'Paste your Discord token first.'); return; }
    if (button) { button.disabled = true; button.textContent = 'Checking with Discord…'; }
    try {
      const data = await K.api('/api/auth/token', { method: 'POST', body: { token } });
      K.receiveState(data.state || await K.refresh());
      K.closeSheet();
      K.toast('Discord connected', `Signed in as ${K.displayName()}.`, 'ok');
      const cb = K.onLoginSuccess;
      K.onLoginSuccess = null;
      if (typeof cb === 'function') cb(data);
      else K.render();
    } catch (error) {
      if (button) {
        button.disabled = false;
        button.textContent = 'Connect with token';
      }
      showError(prefix, error.message);
    }
  };

  K.actions['login-help'] = function () {
    K.sheet({
      title: 'Finding your token',
      subtitle: 'The same sign-in the Android app uses.',
      body: `<div class="setting-group" style="padding:16px">
        <p style="font-size:0.8125rem;line-height:1.6;color:var(--text-dim);margin:0 0 12px">Kizzey needs an account token, not a bot token. It connects to Discord's user gateway and sends presence updates as you.</p>
        <div class="login-steps">
          <span><b class="step-num">1</b><span>Open Discord in a desktop browser and sign in.</span></span>
          <span><b class="step-num">2</b><span>Press <kbd>F12</kbd> (or <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>I</kbd>), choose <b>Application</b>, then <b>Local Storage → https://discord.com</b>.</span></span>
          <span><b class="step-num">3</b><span>Copy the value of the key named <b>token</b>. It is a long string of letters, numbers and dots.</span></span>
          <span><b class="step-num">4</b><span>Paste it into Kizzey. The server validates it with Discord and stores it privately.</span></span>
        </div>
        <div class="danger-zone" style="margin-top:16px">
          <div class="dz-title">Keep it private</div>
          <p style="margin-bottom:0">A user token grants full access to the account. Only paste it into a Kizzey server you control, over a trusted connection.</p>
        </div>
      </div>
      <div class="modal-actions"><button class="btn btn-primary" data-close-sheet>Got it</button></div>`,
    });
  };
})();
