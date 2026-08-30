/**
 * Senpa auth paste — same flow as Agar24:
 * 1) Login on https://senpa.io/web
 * 2) Copy JWT (helper below)
 * 3) Paste here → localStorage "senpa_auth_token"
 * 4) Game WS sends opcode 0x0D + UTF-16 token
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'senpa_auth_token';
  var PROFILE_KEY = 'senpa_last_profile';
  // Token i nxjerrë nga senpa.io — pastuar automatikisht si Agar24
  var SEEDED_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjI0OTgxMywicm9sZSI6MSwiaWF0IjoxNzg0MzExNjU1fQ.Cd4GE-sHcuncpfCzlTp79RGrJC5ks9TC4DJHFJ8fBCw';

  var HELPER = `(async () => {
  const readToken = () => {
    const fromStorage =
      localStorage.getItem("authToken") ||
      localStorage.getItem("token") ||
      sessionStorage.getItem("authToken");
    if (fromStorage) return fromStorage;

    const cookie = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("authToken=") || part.startsWith("token="));
    if (cookie) return decodeURIComponent(cookie.split("=").slice(1).join("="));

    // Official senpa.io client stores JWT inside senpaio:account (UTF-16LE JSON)
    try {
      const raw = localStorage.getItem("senpaio:account");
      if (raw) {
        let text = raw;
        try {
          const bin = atob(raw);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          if (bytes.length >= 2 && bytes[1] === 0) {
            text = new TextDecoder("utf-16le").decode(bytes);
          }
        } catch (_) {}
        const data = JSON.parse(text);
        if (data && data.auth) return data.auth;
      }
    } catch (_) {}

    return null;
  };

  const token = readToken();
  if (!token) {
    console.warn("[ONYX] No Senpa auth token found. Make sure you are logged in on senpa.io.");
    return;
  }
  try {
    await navigator.clipboard.writeText(token);
    console.log("[ONYX] Senpa auth token copied to clipboard.");
  } catch {
    console.log("[ONYX] Token:", token);
  }
  return token;
})();`;

  function normalizeToken(raw) {
    return String(raw || '').trim().replace(/^["']|["']$/g, '');
  }

  function decodeJwtPayload(token) {
    var parts = token.split('.');
    if (parts.length < 2) return null;
    try {
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      var json = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='));
      return JSON.parse(json);
    } catch (_) {
      return null;
    }
  }

  function getToken() {
    try {
      return normalizeToken(localStorage.getItem(STORAGE_KEY));
    } catch (_) {
      return '';
    }
  }

  function setToken(token) {
    localStorage.setItem(STORAGE_KEY, token);
  }

  function clearToken() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PROFILE_KEY);
  }

  function getProfile() {
    try {
      return JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  function setProfile(profile) {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile || null));
  }

  function login(raw) {
    var token = normalizeToken(raw);
    if (!token || token.split('.').length < 3) {
      throw new Error('Paste a valid Senpa auth token (JWT)');
    }
    setToken(token);
    var profile = decodeJwtPayload(token) || { name: 'Senpa Player' };
    setProfile(profile);
    window.dispatchEvent(new CustomEvent('onyx:senpa-auth-changed', {
      detail: { token: token, profile: profile, isAuthenticated: true }
    }));
    return profile;
  }

  function logout() {
    clearToken();
    window.dispatchEvent(new CustomEvent('onyx:senpa-auth-changed', {
      detail: { token: null, profile: null, isAuthenticated: false }
    }));
  }

  function injectUI() {
    if (document.getElementById('onyx-game-auth')) return;

    var style = document.createElement('style');
    style.textContent = [
      '#onyx-auth-fab{position:fixed;top:14px;right:14px;z-index:2147483000;display:flex;align-items:center;gap:8px;padding:8px 12px;border:0;border-radius:8px;background:#12151c;color:#e8ecf3;font:600 12px/1.2 Segoe UI,system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35)}',
      '#onyx-auth-fab.ok{background:#163022;color:#b7f0c8}',
      '#onyx-auth-fab .dot{width:8px;height:8px;border-radius:50%;background:#f0b429}',
      '#onyx-auth-fab.ok .dot{background:#3ddc84}',
      '#onyx-game-auth{display:none;position:fixed;inset:0;z-index:2147483001;background:rgba(6,8,12,.72);align-items:center;justify-content:center;padding:20px}',
      '#onyx-game-auth.open{display:flex}',
      '#onyx-game-auth .card{width:min(520px,100%);background:#10141c;color:#e8ecf3;border:1px solid #2a3344;border-radius:12px;padding:18px 18px 16px;box-shadow:0 20px 50px rgba(0,0,0,.45);font:14px/1.45 Segoe UI,system-ui,sans-serif}',
      '#onyx-game-auth h2{margin:0 0 4px;font-size:16px;letter-spacing:.04em}',
      '#onyx-game-auth .sub{margin:0 0 14px;color:#9aa6b8;font-size:12px}',
      '#onyx-game-auth ol{margin:0 0 12px;padding-left:18px;color:#b7c0ce;font-size:12px}',
      '#onyx-game-auth textarea{width:100%;min-height:96px;resize:vertical;box-sizing:border-box;border:1px solid #2a3344;border-radius:8px;background:#0b0e14;color:#e8ecf3;padding:10px;font:12px/1.4 Consolas,monospace}',
      '#onyx-game-auth .row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}',
      '#onyx-game-auth button{border:0;border-radius:8px;padding:9px 12px;cursor:pointer;font:600 12px/1 Segoe UI,system-ui,sans-serif}',
      '#onyx-game-auth .login{background:#3b82f6;color:#fff}',
      '#onyx-game-auth .copy{background:#1e2633;color:#d7dee9}',
      '#onyx-game-auth .logout{background:#3a1d1d;color:#ffb4b4}',
      '#onyx-game-auth .close{background:#1e2633;color:#d7dee9;margin-left:auto}',
      '#onyx-game-auth .status{min-height:18px;margin-top:10px;font-size:12px;color:#9aa6b8}',
      '#onyx-game-auth .status.ok{color:#3ddc84}',
      '#onyx-game-auth .status.err{color:#ff7b7b}',
      '#onyx-game-auth .helper{margin-top:12px;padding:10px;border-radius:8px;background:#0b0e14;border:1px solid #2a3344;color:#8b97a8;font:11px/1.4 Consolas,monospace;white-space:pre-wrap;max-height:120px;overflow:auto}'
    ].join('');
    document.head.appendChild(style);

    var fab = document.createElement('button');
    fab.id = 'onyx-auth-fab';
    fab.type = 'button';
    fab.innerHTML = '<span class="dot"></span><span class="label">SENPA AUTH</span>';
    document.body.appendChild(fab);

    var panel = document.createElement('div');
    panel.id = 'onyx-game-auth';
    panel.innerHTML =
      '<div class="card">' +
        '<h2>AUTH LINK / SENPA ACCOUNT</h2>' +
        '<p class="sub">Same as Agar24 — paste Senpa JWT from senpa.io (not from localhost Turnstile).</p>' +
        '<ol>' +
          '<li>Open <b>https://senpa.io/web</b> and login</li>' +
          '<li>F12 → Console → paste helper (Copy helper) → Enter</li>' +
          '<li>Paste token below → LOGIN</li>' +
        '</ol>' +
        '<textarea class="auth-token-input" placeholder="Paste Senpa auth token here" spellcheck="false"></textarea>' +
        '<div class="row">' +
          '<button type="button" class="login auth-login-btn">LOGIN</button>' +
          '<button type="button" class="copy auth-copy-helper">Copy helper</button>' +
          '<button type="button" class="logout auth-logout-btn">Logout</button>' +
          '<button type="button" class="close auth-close-btn">Close</button>' +
        '</div>' +
        '<div class="status"></div>' +
        '<div class="helper auth-helper-code"></div>' +
      '</div>';
    document.body.appendChild(panel);

    var input = panel.querySelector('.auth-token-input');
    var status = panel.querySelector('.status');
    var helperEl = panel.querySelector('.auth-helper-code');
    helperEl.textContent = HELPER;

    function setStatus(msg, kind) {
      status.textContent = msg || '';
      status.className = 'status' + (kind ? ' ' + kind : '');
    }

    function refreshFab() {
      var token = getToken();
      var profile = getProfile();
      var name = (profile && (profile.username || profile.nickname || profile.name)) || '';
      fab.classList.toggle('ok', !!token);
      fab.querySelector('.label').textContent = token
        ? ('SENPA: ' + (name || 'logged in'))
        : 'SENPA AUTH — paste token';
      if (token && !input.value) input.value = token;
    }

    function open() {
      panel.classList.add('open');
      setStatus(getToken() ? 'Token saved. Connect to server when ready.' : 'Paste your auth token to login.', '');
      input.focus();
    }

    function close() {
      panel.classList.remove('open');
    }

    fab.addEventListener('click', open);
    panel.querySelector('.auth-close-btn').addEventListener('click', close);
    panel.addEventListener('click', function (e) {
      if (e.target === panel) close();
    });

    panel.querySelector('.auth-login-btn').addEventListener('click', function () {
      try {
        var profile = login(input.value);
        var name = profile.username || profile.nickname || profile.name || 'ok';
        setStatus('Login successful: ' + name, 'ok');
        refreshFab();
        setTimeout(close, 500);
      } catch (err) {
        setStatus(err.message || String(err), 'err');
      }
    });

    panel.querySelector('.auth-logout-btn').addEventListener('click', function () {
      logout();
      input.value = '';
      setStatus('Logged out.', '');
      refreshFab();
    });

    panel.querySelector('.auth-copy-helper').addEventListener('click', async function () {
      try {
        await navigator.clipboard.writeText(HELPER);
        setStatus('Helper copied. Paste it on senpa.io/web console.', 'ok');
      } catch (_) {
        setStatus('Copy failed — select helper text manually.', 'err');
      }
    });

    window.addEventListener('onyx:senpa-auth-changed', refreshFab);

    // Seed gjithmonë me të njëjtin key (nuk duhet paste tjetër)
    try {
      login(SEEDED_TOKEN);
      input.value = SEEDED_TOKEN;
      setStatus('Key fiks aktiv.', 'ok');
    } catch (_) {}

    refreshFab();
    // Mos hap panelin — key-i është tashmë brenda

    window.ONYXAuth.openSenpaPanel = open;
    window.ONYXAuth.closeSenpaPanel = close;
  }

  window.ONYXAuth = {
    getSenpaToken: getToken,
    getSenpaAuthPacket: function () {
      var t = getToken();
      return t ? { type: 'auth', token: t } : null;
    },
    isSenpaAuthenticated: function () { return !!getToken(); },
    login: login,
    logout: logout,
    openSenpaPanel: function () {},
    closeSenpaPanel: function () {},
    HELPER: HELPER
  };

  // Alias so game code can mirror Agar24 bridge name if needed
  window.Agar24Auth = window.Agar24Auth || {
    getSenpaToken: getToken,
    getSenpaAuthPacket: function () { return window.ONYXAuth.getSenpaAuthPacket(); },
    isSenpaAuthenticated: function () { return !!getToken(); },
    openSenpaPanel: function () { return window.ONYXAuth.openSenpaPanel(); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectUI);
  } else {
    injectUI();
  }
})();
