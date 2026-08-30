/* ============================================================================
   relay.js — local WebSocket relay for the delt.io chat.
   ----------------------------------------------------------------------------
   WHY THIS EXISTS
   The delt.io chat server (wss://chat.delt.io) sits behind Cloudflare, which
   only accepts the WebSocket upgrade when the request's `Origin` header is the
   real delt.io origin. A browser CANNOT set/override `Origin` (it is forced to
   the page's origin, e.g. http://localhost), so a direct browser connection is
   rejected before it opens (the "WebSocket connection failed" you see).

   A Node process has no such restriction: it can set `Origin: https://delt.io`
   and the upgrade succeeds (verified — server returns the connectionID).

   So this relay runs locally, accepts the browser connection on
   ws://localhost:8787, opens the real connection to chat.delt.io with the
   correct Origin, and pipes the binary frames in both directions unchanged.
   The browser's chat.js connects to this relay instead of delt.io directly.

   USAGE
     1)  npm install ws        (one time; or: npm i)
     2)  node relay.js         (leave it running while you play)
     3)  open the game on localhost — chat connects automatically.

   Optional: PORT=9000 node relay.js   to change the port (then set
   window.ONYX_CHAT_RELAY = 'ws://localhost:9000' before chat.js, or edit
   RELAY_URL at the top of chat.js).
   ============================================================================ */
'use strict';
let WebSocket;
try { WebSocket = require('ws'); }
catch (e) {
  console.error('\n[relay] Missing "ws" package. Install once:  npm install ws\n        (or open this folder in a terminal and run:  npm i  )\n');
  process.exit(1);
}

const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 8787;
const UPSTREAM = 'wss://chat.delt.io/delta7?protocol=v1';
const ORIGIN = process.env.CHAT_ORIGIN || 'https://delt.io';
let UA = process.env.CHAT_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
let COOKIE = process.env.CHAT_COOKIE || '';

// Optional: if your IP is challenged by Cloudflare (HTTP 500 on connect), put a
// cf_clearance cookie + matching User-Agent here. See CHAT-LEXO-ME.txt.
// File format (relay.cookie.json):  { "cookie": "cf_clearance=...; ...", "ua": "Mozilla/5.0 ..." }
try {
  const cfgPath = path.join(__dirname, 'relay.cookie.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const fake = /VEDE_KETU|VENDOS_KETU|placeholder/i;
    if (cfg.cookie && !fake.test(cfg.cookie)) COOKIE = cfg.cookie;
    if (cfg.ua && !fake.test(cfg.ua)) UA = cfg.ua;
    console.log('[relay] loaded relay.cookie.json (cookie ' + (COOKIE ? 'set' : 'empty') + ')');
  }
} catch (e) { console.log('[relay] could not read relay.cookie.json: ' + e.message); }

function upstreamHeaders() {
  const h = { Origin: ORIGIN, 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' };
  if (COOKIE) h['Cookie'] = COOKIE;
  return h;
}

const server = new WebSocket.Server({ port: PORT });
console.log('[relay] listening on ws://localhost:' + PORT + '  ->  ' + UPSTREAM);
console.log('[relay] Origin=' + ORIGIN + '  cookie=' + (COOKIE ? 'YES' : 'no'));

server.on('connection', (browser, req) => {
  // Forward the exact subprotocol the browser requested (delt.io uses it as a
  // per-connection fingerprint), so the upstream handshake matches 1:1.
  const subproto = (req.headers['sec-websocket-protocol'] || '').split(',')[0].trim() || undefined;
  console.log('[relay] browser connected (subproto=' + subproto + ')');

  const upstream = new WebSocket(UPSTREAM, subproto, { headers: upstreamHeaders() });
  upstream.binaryType = 'arraybuffer';

  const queue = [];
  let upOpen = false;

  upstream.on('open', () => {
    upOpen = true;
    console.log('[relay] upstream OPEN (protocol=' + upstream.protocol + ')');
    while (queue.length) upstream.send(queue.shift());
  });
  upstream.on('message', (data) => { if (browser.readyState === WebSocket.OPEN) browser.send(data); });
  upstream.on('close', (c, r) => { console.log('[relay] upstream CLOSE ' + c); try { browser.close(c <= 4999 && c >= 1000 ? c : 1000); } catch (e) {} });
  upstream.on('error', (e) => {
    console.log('[relay] upstream ERROR ' + e.message);
    if (/\b(500|403|429|1015)\b/.test(e.message) && !COOKIE) {
      console.log('[relay] -> Cloudflare po e bllokon IP-n tende. Zgjidhje: hap https://delt.io ne Chrome,');
      console.log('[relay]    kalo kontrollin e Cloudflare, kopjo cookie "cf_clearance" + User-Agent ne');
      console.log('[relay]    skedarin relay.cookie.json (shih CHAT-LEXO-ME.txt). Ose provo VPN/rrjet tjeter.');
    }
    try { browser.close(); } catch (x) {}
  });

  browser.on('message', (data) => { if (upOpen) upstream.send(data); else queue.push(data); });
  browser.on('close', () => { try { upstream.close(); } catch (e) {} });
  browser.on('error', () => { try { upstream.close(); } catch (e) {} });
});

server.on('error', (e) => console.error('[relay] server error', e.message));
