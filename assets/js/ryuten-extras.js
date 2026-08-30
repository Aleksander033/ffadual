/* ============================================================================
   ryuten-extras.js — shtesa kozmetike nga ryuten te ONYX (1+2+3+4)
   ----------------------------------------------------------------------------
   Ngarkohet PAS motorit (deo.onyx). NUK prek lidhjen (s'e prek window.WebSocket)
   as logjikën e lojës. Vetëm pamja:
     (4) ikonat e menusë → iconfont i ryuten
     (2) disconnect/reconnect screen i stilit ryuten (overlay, pointer-events:none)
     (1)+(3) trajtohen me CSS (loading screen + rrethi i skinit)
   ============================================================================ */
(function () {
  'use strict';

  /* ── (4) Ikonat e menusë → iconfont i ryuten ──────────────────────────── */
  var ICON_MAP = [
    ['#button-settings i', 'ryf ryf-settings'],
    ['#button-play i',     'ryf ryf-play'],
    ['#button-spectate i', 'ryf ryf-person'],
    ['#button-inputs i',   'ryf ryf-gamepad'],
    ['#button-theme i',    'ryf ryf-edit'],
    ['#reconnectSAIGO i',  'ryf ryf-spinner']
  ];

  function swapIcons() {
    for (var i = 0; i < ICON_MAP.length; i++) {
      var el = document.querySelector(ICON_MAP[i][0]);
      if (el && el.className !== ICON_MAP[i][1]) {
        el.className = ICON_MAP[i][1];
        el.textContent = '';            // hiq emrin material-icons (p.sh. "play_circle_filled")
      }
    }
  }

  /* ── (2) Disconnect / reconnect overlay ───────────────────────────────── */
  var dc = null;
  function buildOverlay() {
    if (dc) return;
    dc = document.createElement('div');
    dc.id = 'ryuten-dc';
    dc.innerHTML =
      '<i class="ryf ryf-spinner"></i>' +
      '<div class="ryuten-dc-title">Connection lost</div>' +
      '<div class="ryuten-dc-sub">Reconnecting to server…</div>';
    document.body.appendChild(dc);
  }

  function isVisible(el) {
    if (!el) return false;
    var cs = getComputedStyle(el);
    return cs.display !== 'none' &&
           cs.visibility !== 'hidden' &&
           parseFloat(cs.opacity) !== 0;
  }

  function isInGame() {
    var mo = document.getElementById('menu-overlay');
    if (!mo) return false;
    // në lojë motori e fsheh menu-overlay (display/visibility/opacity).
    // KUJDES: mos përdor offsetParent — është null edhe për position:fixed kur duket.
    if (isVisible(mo)) return false;
    // gjatë ngarkimit fillestar (loading screen) menu-overlay është i fshehur,
    // por NUK jemi në lojë → mos shfaq disconnect overlay.
    if (isVisible(document.getElementById('loading-screen'))) return false;
    if (isVisible(document.getElementById('fake-loading-screen'))) return false;
    return true;
  }

  function refreshOverlay() {
    if (!dc) return;
    var tab1 = document.getElementById('rctab1');
    var lost = tab1 && tab1.classList.contains('disconnected');
    // shfaq VETËM kur tab-i kryesor humb lidhjen GJATË lojës (jo në meny)
    if (lost && isInGame()) dc.classList.add('show');
    else dc.classList.remove('show');
  }

  function init() {
    swapIcons();
    buildOverlay();
    refreshOverlay();

    // ri-apliko ikonat nëse motori i rikrijon elementet
    var icoObs = new MutationObserver(swapIcons);
    icoObs.observe(document.body, { childList: true, subtree: true });

    // vëzhgo gjendjen e lidhjes së tab-it kryesor
    var tab1 = document.getElementById('rctab1');
    if (tab1) {
      var dcObs = new MutationObserver(refreshOverlay);
      dcObs.observe(tab1, { attributes: true, attributeFilter: ['class'] });
    }
    // fallback i lehtë (menu-overlay s'jep mutacion gjithmonë)
    setInterval(refreshOverlay, 700);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
