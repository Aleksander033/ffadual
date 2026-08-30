/* ============================================================================
   ONYX × RYUTEN — tinguj butonash (hover/click) si te ryuten.io
   ----------------------------------------------------------------------------
   Krejt shtesë: NUK prek motorin, lidhjen, as logjikën e lojës.
   I bashkëngjit tinguj VETËM butonave të menusë. Mbrojtur me try/catch.
   ============================================================================ */
(function () {
  'use strict';
  try {
    var BASE = 'assets/ryuten/sfx/';
    var hoverSrc = BASE + 'button-hover-1.wav';
    var clickSrc = BASE + 'button-click-1.wav';

    function play(src, vol) {
      try {
        var a = new Audio(src);
        a.volume = vol;
        a.play().catch(function () { /* autoplay bllok deri te interaksioni i parë */ });
      } catch (_) { /* ignore */ }
    }

    var SELECTOR = '.bar-button:not(.dummy), .menu-bar-button, .material-button, .btn-reconnect, .minimap-button';

    document.addEventListener('mouseover', function (e) {
      var t = e.target.closest ? e.target.closest(SELECTOR) : null;
      if (t && !t.__ryHover) { t.__ryHover = 1; play(hoverSrc, 0.18); }
    }, true);

    document.addEventListener('mouseout', function (e) {
      var t = e.target.closest ? e.target.closest(SELECTOR) : null;
      if (t) t.__ryHover = 0;
    }, true);

    document.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest(SELECTOR) : null;
      if (t) play(clickSrc, 0.30);
    }, true);
  } catch (_) { /* asgjë: tingujt s'janë kritikë */ }
})();
