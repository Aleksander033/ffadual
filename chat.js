/* ============================================================================
   chat.js — delt.io chat, ported 1:1 from the working bundle (bundle.js).
   ----------------------------------------------------------------------------
   This is a faithful extraction of the chat system from a functional senpa
   client: the binary protocol (Writer/Reader), the chat networking class,
   the ChatBox UI (messages, emoji picker, resize, Enter/Esc shortcuts) and
   every dependency the chat relies on (flags, player model, event emitter).

   Onyx uses a different game engine (deo.onyx) than the source project, so the
   source `app` object does not exist here. Instead of touching any game logic
   we provide a thin ADAPTER (`buildApp()`) that supplies exactly the surface
   the chat needs (settings, player nick/server, a connection/client and a few
   helpers), sourced from Onyx's existing DOM/state. Nothing in the game engine
   is modified.
   ============================================================================ */
(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────────
     0.  CONFIG + small utils
     ───────────────────────────────────────────────────────────────────────── */
  var CHAT_WS_URL = 'wss://chat.delt.io/delta7?protocol=v1';
  // Default local relay (see relay.js). A browser cannot set the Origin header
  // that Cloudflare requires, so on localhost we go through the relay; on a
  // deployed/allowed origin we can connect to delt.io directly.
  var CHAT_RELAY_URL = 'ws://localhost:8787';

  // Resolve the URL to connect to. Override order:
  //   window.ONYX_CHAT_WS_URL  -> use exactly this
  //   window.ONYX_CHAT_DIRECT  -> force direct delt.io (no relay)
  //   window.ONYX_CHAT_RELAY   -> use this relay URL
  //   otherwise: relay on localhost/file://, direct elsewhere.
  function resolveChatUrl() {
    if (window.ONYX_CHAT_WS_URL) return window.ONYX_CHAT_WS_URL;
    if (window.ONYX_CHAT_DIRECT === true) return CHAT_WS_URL;
    if (window.ONYX_CHAT_RELAY) return window.ONYX_CHAT_RELAY;
    var h = location.hostname;
    var isLocal = location.protocol === 'file:' || h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '' || /^192\.168\./.test(h) || /^10\./.test(h);
    return isLocal ? CHAT_RELAY_URL : CHAT_WS_URL;
  }

  var dlog = function () { if (window.__CHAT_DEBUG !== false) console.log.apply(console, ['[ONYX-CHAT]'].concat([].slice.call(arguments))); };

  function clean(v, fb) { v = (v == null ? '' : String(v)).trim(); return v.length ? v : (fb || ''); }
  var qs = function (sel, root) { return (root || document).querySelector(sel); };

  /* ─────────────────────────────────────────────────────────────────────────
     1.  BINARY PROTOCOL  (Writer W / Reader R) — verbatim from bundle.
         A single shared 1 MB scratch buffer, little-endian, like the source.
     ───────────────────────────────────────────────────────────────────────── */
  var SCRATCH = new ArrayBuffer(1048576);
  var U8 = new Uint8Array(SCRATCH);
  var DV = new DataView(SCRATCH);

  function Writer(le) { this.offset = 0; this.le = le === undefined ? true : le; this.view = DV; }
  Writer.prototype.writeUInt8 = function (t) { this.view.setUint8(this.offset++, t); };
  Writer.prototype.writeInt8 = function (t) { this.view.setInt8(this.offset++, t); };
  Writer.prototype.writeUInt16 = function (t) { this.view.setUint16(this.offset, t, this.le); this.offset += 2; };
  Writer.prototype.writeInt16 = function (t) { this.view.setInt16(this.offset, t, this.le); this.offset += 2; };
  Writer.prototype.writeUInt24 = function (t) { this.writeUInt8((16711680 & t) >>> 16); this.writeUInt8((65280 & t) >>> 8); this.writeUInt8((255 & t) >>> 0); };
  Writer.prototype.writeUInt32 = function (t) { this.view.setUint32(this.offset, t, this.le); this.offset += 4; };
  Writer.prototype.writeInt32 = function (t) { this.view.setInt32(this.offset, t, this.le); this.offset += 4; };
  Writer.prototype.writeUTF16String = function (t) { for (var e = 0; e < t.length; e++) this.writeUInt16(t.charCodeAt(e)); };
  Writer.prototype.writeUTF16StringZero = function (t) { this.writeUTF16String(t); this.writeUInt16(0); };
  Writer.prototype.writeUTF16StringLength = function (t) { if (t.length > 255) t = t.substring(0, 255); this.writeUInt8(t.length); this.writeUTF16String(t); };
  Writer.prototype.finalize = function () { return U8.subarray(0, this.offset); };

  function Reader(view, le) { this.view = view; this.offset = 0; this.le = le === undefined ? true : le; }
  Reader.prototype.readUInt8 = function () { return this.view.getUint8(this.offset++); };
  Reader.prototype.readInt8 = function () { return this.view.getInt8(this.offset++); };
  Reader.prototype.readUInt16 = function () { var t = this.view.getUint16(this.offset, this.le); this.offset += 2; return t; };
  Reader.prototype.readInt16 = function () { var t = this.view.getInt16(this.offset, this.le); this.offset += 2; return t; };
  Reader.prototype.readUInt24 = function () { return (this.readUInt8() << 16) | (this.readUInt8() << 8) | this.readUInt8(); };
  Reader.prototype.readUInt32 = function () { var t = this.view.getUint32(this.offset, this.le); this.offset += 4; return t; };
  Reader.prototype.readInt32 = function () { var t = this.view.getInt32(this.offset, this.le); this.offset += 4; return t; };
  Reader.prototype.readUTF16String = function (t) {
    if (t == null) t = this.view.byteLength - this.offset; t = Math.max(0, t);
    var n = '', r = 0; while (r < t) { r++; n += String.fromCharCode(this.readUInt16()); } return n;
  };
  Reader.prototype.readUTF16StringLength = function () { return this.readUTF16String(this.readUInt8()); };

  /* ─────────────────────────────────────────────────────────────────────────
     2.  EVENT EMITTER  (replaces bundle's node `events` dependency)
     ───────────────────────────────────────────────────────────────────────── */
  function Emitter() { this._h = Object.create(null); }
  Emitter.prototype.on = function (ev, fn) { (this._h[ev] || (this._h[ev] = [])).push(fn); return this; };
  Emitter.prototype.once = function (ev, fn) { var self = this; function g() { self.off(ev, g); fn.apply(null, arguments); } g._orig = fn; return this.on(ev, g); };
  Emitter.prototype.off = function (ev, fn) { var a = this._h[ev]; if (!a) return this; this._h[ev] = a.filter(function (f) { return f !== fn && f._orig !== fn; }); return this; };
  Emitter.prototype.emit = function (ev) { var a = this._h[ev]; if (!a) return false; var args = [].slice.call(arguments, 1); a.slice().forEach(function (f) { try { f.apply(null, args); } catch (e) { console.error(e); } }); return true; };

  function Logger(o) { o = o || {}; this.prefix = o.prefix || 'Chat'; }
  Logger.prototype.log = function () { dlog.apply(null, arguments); };
  Logger.prototype.error = function () { console.warn.apply(console, ['[ONYX-CHAT]'].concat([].slice.call(arguments))); };

  /* ─────────────────────────────────────────────────────────────────────────
     3.  COLOR HELPERS  (bundle uses ot.temp.fromINT / fromHSL → getHEX)
     ───────────────────────────────────────────────────────────────────────── */
  function intToHex(i) { return '#' + ((i >>> 0) & 0xffffff).toString(16).padStart(6, '0'); }
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    var k = function (n) { return (n + h / 30) % 12; };
    var a = s * Math.min(l, 1 - l);
    var f = function (n) { var c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return Math.round(255 * c); };
    return '#' + [f(0), f(8), f(4)].map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  }

  /* ─────────────────────────────────────────────────────────────────────────
     4.  FLAGS (Ut)  + PLAYER (Ft) — verbatim from bundle.
     ───────────────────────────────────────────────────────────────────────── */
  var F = { Join: 1, CoordsMass: 2, Color: 4, CColor: 8, Skin: 16, CSkin: 32, IsPlay: 64, AccountId: 128, Nick: 256, Quadrant: 512, Protocol: 1024 };
  function Flags() { this.flags = 0; }
  Flags.prototype.has = function (t) { return 0 !== (this.flags & t); };
  Flags.prototype.set = function (t, e) { if (e) this.flags |= t; else this.flags &= ~t; };
  Flags.prototype.reset = function () { this.flags = 0; };
  Flags.prototype.all = function () { this.flags = 2047; };
  [['join', F.Join], ['coordsmass', F.CoordsMass], ['color', F.Color], ['ccolor', F.CColor],
   ['skin', F.Skin], ['cskin', F.CSkin], ['isplay', F.IsPlay], ['accountid', F.AccountId],
   ['nick', F.Nick], ['quadrant', F.Quadrant], ['protocol', F.Protocol]].forEach(function (p) {
    Object.defineProperty(Flags.prototype, p[0], {
      get: function () { return this.has(p[1]); },
      set: function (v) { this.set(p[1], v); }
    });
  });

  function Player(id) { this.playerId = id; }
  Player.prototype.update = function (t) {
    if (t.clientId !== undefined) this.clientId = t.clientId;
    if (t.nick !== undefined) this.nick = t.nick;
    if (t.customSkin !== undefined) this.customSkin = t.customSkin;
    if (t.customColor !== undefined) this.customColor = t.customColor;
    if (t.pColor !== undefined) this.pColor = t.pColor;
    if (t.tabId !== undefined) this.tabId = t.tabId;
    if (t.position !== undefined) this.position = t.position;
    if (t.isAlive !== undefined) this.isAlive = t.isAlive;
  };
  Player.prototype.updatePosition = function (x, y, mass) {
    if (this.minimapOldX === undefined) { this.minimapOldX = x; this.minimapOldY = y; }
    this.minimapTargetX = x; this.minimapTargetY = y; this.position = { x: x, y: y, mass: mass };
  };

  /* ─────────────────────────────────────────────────────────────────────────
     5.  CHAT NETWORKING CLASS (Bt) — verbatim from bundle.
     ───────────────────────────────────────────────────────────────────────── */
  function Chat(app) {
    this.app = app;
    this.logger = new Logger({ prefix: 'Chat' });
    this.url = CHAT_WS_URL;
    this.protocol = null;
    this.socket = null;
    this.connectionID = null;
    this.userID = null;
    this.players = new Map();
    this.playersByTabId = new Map();
    this.clientsQueue = [];
    this.registered = new Map();
    this.events = new Emitter();
  }
  Object.defineProperty(Chat.prototype, 'isConnected', {
    get: function () { return this.socket && this.socket.readyState === WebSocket.OPEN; }
  });
  Chat.prototype.cleanup = function () {
    this.protocol = null; this.connectionID = null; this.socket = null;
    this.players.clear(); this.playersByTabId.clear();
    if (this.registered.size > 0) {
      this.clientsQueue = Array.from(this.registered.values()).map(function (t) { return t.clientOrigin; });
      this.registered.clear();
    }
  };
  // protocol fingerprint — identical algorithm to the source.
  function genProtocol() {
    var t = crypto.getRandomValues(new Uint8Array(16));
    var e = Object.values(t).map(function (t) { return t.toString(16).padStart(2, '0'); }).join('');
    return t ? e.match(/.{2}/g).map(function (t) { return parseInt(t, 16); })
      .map(function (t, e, n) { return e % 5 == 0 ? n[e + 3] ^ n[e + 2] : t; })
      .map(function (t) { return t.toString(16).padStart(2, '0'); }).join('') : '';
  }
  Chat.prototype.connect = function () {
    if (this.socket) this.close();
    this.protocol = genProtocol();
    this.url = resolveChatUrl();
    dlog('connecting', this.url);
    this.socket = new WebSocket(this.url, this.protocol);
    this.socket.binaryType = 'arraybuffer';
    this.socket.onopen = this.onOpen.bind(this);
    this.socket.onmessage = this.onMessage.bind(this);
    this.socket.onclose = this.onClose.bind(this);
    this.socket.onerror = this.onError.bind(this);
  };
  Chat.prototype.close = function () {
    var s = this.socket;
    if (!s) return;
    if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING || s.readyState === WebSocket.CLOSING) s.close();
  };
  Chat.prototype.handshake = function () { var t = new Writer(); t.writeUInt16(0); this.sendMessage(t); };
  Chat.prototype.onOpen = function () {
    var e = this;
    this.logger.log('WebSocket opened');
    this.handshake();
    this.clientsQueue.slice().forEach(function (t) { e.registerClient(t); });
    var n = setInterval(function () { e.sendPlayerUpdates(false); }, 100);
    if (this.socket) this.socket.addEventListener('close', function () { clearInterval(n); });
  };
  Chat.prototype.onMessage = function (t) {
    var e = new Reader(new DataView(t.data));
    switch (e.readUInt8()) {
      case 0:
        this.connectionID = e.readUInt16();
        this.events.emit('connectionID', this.connectionID);
        break;
      case 1: {
        var n = e.readUInt32(), r = e.readUInt16();
        this.logger.log('Server registered tab', { tabID: n, chatId: r });
        this.events.emit('registerTab-' + n, r);
        break;
      }
      case 12:
        this.removePlayers(e);
        break;
      case 15: case 41: case 42:
        break;
      case 16:
        this.updatePlayers(this.readPlayerUpdates(e));
        break;
      case 25: {
        var o = this.parseMessage(e);
        this.events.emit('message', { type: o.type, playerID: o.playerID, nick: o.nick, text: o.text });
        break;
      }
      case 45: {
        var u = this.parseWave(e);
        var v = hslToHex(Math.abs((u.playerID % 360 << 314159) % 360), 95, 46);
        this.events.emit('wave', { userID: u.userID, playerID: u.playerID, type: u.type, x: u.x, y: u.y, color: v });
        break;
      }
    }
  };
  Chat.prototype.onClose = function () {
    var t = this; this.logger.log('WebSocket closed'); this.cleanup();
    setTimeout(function () { t.connect(); }, 5000);
  };
  Chat.prototype.onError = function (t) { this.logger.error('WebSocket error', t); };
  Chat.prototype.sendMessage = function (t) {
    if (!this.isConnected) return;
    if (t instanceof Writer) this.socket.send(t.finalize()); else this.socket.send(t);
  };
  Chat.prototype.enterRoom = function (t, e, n, r, i) {
    var o = new Writer(), a = 0;
    o.writeUInt8(9); o.writeUInt8(0);
    var fields = [{ value: t, bit: 1 }, { value: e, bit: 2 }, { value: n, bit: 4 }, { value: r, bit: 8 }, { value: i, bit: 16 }];
    for (var s = 0; s < fields.length; s++) {
      var u = fields[s].value, h = fields[s].bit;
      if (typeof u === 'string') { a |= h; o.writeUTF16StringZero(u); }
    }
    o.view.setUint8(1, a);
    this.sendMessage(o);
  };
  Chat.prototype.createChatID = function (t) { var e = new Writer(); e.writeUInt8(1); e.writeUInt32(t); this.sendMessage(e); };
  Chat.prototype.removeChatID = function (t) { var e = new Writer(); e.writeUInt8(2); e.writeUInt16(t); this.sendMessage(e); };
  Chat.prototype.parseMessage = function (t) {
    var e = t.readUInt8();
    return {
      type: 1 === e ? 'msg' : 2 === e ? 'cmd' : '' + e,
      userID: t.readUInt16(),
      playerID: t.readUInt16(),
      targetID: t.readUInt16(),
      nick: t.readUTF16StringLength(),
      text: t.readUTF16StringLength()
    };
  };
  Chat.prototype.parseWave = function (t) {
    return { userID: t.readUInt16(), playerID: t.readUInt16(), type: t.readUInt8(), x: t.readInt32(), y: t.readInt32() };
  };
  Chat.prototype.sendWave = function (t, e, n) {
    if (this.connectionID) {
      var r = new Writer();
      r.writeUInt8(45); r.writeUInt16(this.connectionID); r.writeUInt16(t); r.writeUInt8(4); r.writeInt32(e); r.writeInt32(n);
      this.sendMessage(r);
    } else this.logger.error('Failed to send wave: Connection ID is not set..');
  };
  Chat.prototype.sendChatMessage = function (t) {
    var e = t.type, n = t.userID, r = t.playerID, i = t.targetID,
      a = t.nick === undefined ? 'noname' : t.nick, s = t.text,
      c = new Writer(), l = 'msg' === e ? 1 : 'cmd' === e ? 2 : e;
    c.writeUInt8(25); c.writeUInt8(l); c.writeUInt16(n); c.writeUInt16(r); c.writeUInt16(i);
    c.writeUTF16StringLength(a); c.writeUTF16StringLength(s);
    return this.sendMessage(c);
  };
  Chat.prototype.registerClient = function (t) {
    var e = this;
    if (!t.clientId) { this.logger.error('Client tab ID is not set..'); var ix = this.clientsQueue.indexOf(t); if (ix !== -1) this.clientsQueue.splice(ix, 1); return; }
    if (this.isConnected) {
      this.events.once('registerTab-' + t.clientId, function (n) {
        var r = { flags: new Flags(), chatId: n, clientOrigin: t, connection: e };
        t.chatTab = r; e.registered.set(t.clientId, r); e.sendPlayerUpdates(true);
        e.clientsQueue = e.clientsQueue.filter(function (q) { return q.clientId !== t.clientId; });
      });
      this.createChatID(t.clientId);
    } else this.clientsQueue.push(t);
  };
  Chat.prototype.removeClient = function (t) {
    if (t.chatTab && t.clientId) { this.removeChatID(t.chatTab.chatId); this.registered.delete(t.clientId); }
  };
  Chat.prototype.readPlayerUpdates = function (t) {
    var e = [];
    for (;;) {
      var n = t.readUInt16();
      if (0 === n) break;
      var r = t.readUInt8();
      if (0 !== r) {
        var i, o, a, s, c, u, h;
        if (1 & r) {
          var f = t.readUInt8();
          if (1 & f) i = t.readUInt16();
          if (2 & f) o = t.readUTF16StringLength();
          if (4 & f) a = t.readUTF16StringLength();
          if (8 & f) s = t.readUInt24();
          if (16 & f) t.readUTF16StringLength();
          if (32 & f) c = t.readUInt24();
          if (64 & f) u = t.readUInt32();
        }
        var pos;
        if (2 & r) pos = { x: t.readInt16(), y: t.readInt16(), mass: t.readUInt32() };
        if (4 & r) h = 0 !== t.readUInt8();
        if (8 & r) t.readInt8();
        e.push({ playerId: n, clientId: i, nick: o, customSkin: a, customColor: s, pColor: c, tabId: u, position: pos, isAlive: h });
      }
    }
    return e;
  };
  Chat.prototype.updatePlayers = function (t) {
    var e = this;
    t.forEach(function (t) {
      var n = t.playerId;
      if (n !== undefined) {
        var r = e.players.get(n);
        if (!r) { r = new Player(n); e.players.set(n, r); }
        r.update(t);
        if (t.position) r.updatePosition(t.position.x, t.position.y, t.position.mass);
        if (t.tabId !== undefined) e.playersByTabId.set(t.tabId, r);
      }
    });
  };
  Chat.prototype.getPlayerByTabId = function (t) { return this.playersByTabId.get(t); };
  Chat.prototype.removePlayers = function (t) {
    for (;;) {
      var e = t.readUInt16();
      if (0 === e) break;
      var n = this.players.get(e);
      if (n) { if (n.tabId) this.playersByTabId.delete(n.tabId); this.players.delete(e); }
    }
  };
  Chat.prototype.writePlayerUpdates = function (t, e) {
    var wAlive = function (t, e) { t.writeUInt8(e ? 1 : 0); };
    var wPos = function (t, e, n, r) { t.writeInt16(e); t.writeInt16(n); t.writeUInt32(r); };
    var wQuad = function (t, e) { t.writeUInt8(e); };
    t.writeUInt8(16);
    var a = 0;
    for (var s = e.length - 1; s >= 0; s--) {
      var c = e[s], l = 0;
      if (c.flags.nick) l |= 2;
      if (c.flags.cskin) l |= 4;
      if (c.flags.ccolor) l |= 8;
      if (c.flags.skin) l |= 16;
      if (c.flags.color) l |= 32;
      if (c.flags.accountid) l |= 64;
      if (l > 0) l |= 1;
      var g = 0;
      if (l) g |= 1;
      if (c.flags.coordsmass) g |= 2;
      if (c.flags.isplay) g |= 4;
      if (c.flags.quadrant) g |= 8;
      if (0 !== g) {
        a++;
        t.writeUInt16(c.playerID); t.writeUInt8(g);
        if (1 & g) {
          t.writeUInt8(l);
          if (1 & l) t.writeUInt16(c.clientID != null ? c.clientID : 0);
          if (2 & l) t.writeUTF16StringLength(c.nick != null ? c.nick : '');
          if (4 & l) t.writeUTF16StringLength(c.customSkin != null ? c.customSkin : '');
          if (8 & l) t.writeUTF16StringLength(c.customColor != null ? c.customColor : 0);
          if (16 & l) t.writeUTF16StringLength(c.pSkin != null ? c.pSkin : '');
          if (32 & l) t.writeUInt24(c.pColor != null ? c.pColor : 0);
          if (64 & l) t.writeUInt32(c.accountID != null ? c.accountID : 0);
        }
        if (2 & g) wPos(t, c.position.x, c.position.y, c.position.mass);
        if (4 & g) wAlive(t, c.isAlive);
        if (8 & g) wQuad(t, c.quadrant);
      }
    }
    t.writeUInt16(0);
    return a;
  };
  Chat.prototype.sendPlayerUpdates = function (force) {
    var e = this, n = Array.from(this.registered.values()), r = [], i = new Writer();
    n.forEach(function (n) {
      if (!n.clientOrigin) return;
      var chatId = n.chatId, o = n.clientOrigin, a = n.flags, s = o.lastData;
      a.reset();
      var c = '', l = '';
      if (o.type === 'Primary') { c = e.app.player.skin1; l = e.app.player.nickname1; }
      else { c = e.app.player.skin2; l = e.app.player.nickname2; }
      var u = e.app.stage.border, h = -(u.left + u.right) / 2, f = -(u.top + u.bottom) / 2;
      var d = {
        flags: a, playerID: chatId, clientID: e.connectionID, nick: l, customSkin: c,
        customColor: 100000, pSkin: '', pColor: o.player.colorInt, accountID: o.clientId,
        position: { x: o.player.x + h, y: o.player.y + f, mass: o.player.totalMass },
        isAlive: o.isAlive, quadrant: 1
      };
      if (d.nick !== s.nick) a.nick = true;
      if (d.customSkin !== s.customSkin) a.cskin = true;
      if (d.customColor !== s.customColor) a.ccolor = true;
      if (d.pSkin !== s.pSkin) a.skin = true;
      if (d.pColor !== s.pColor) a.color = true;
      if (d.accountID !== s.accountID) a.accountid = true;
      if (!(d.position.x === s.position.x && d.position.y === s.position.y)) a.coordsmass = true;
      if (d.isAlive !== s.isAlive) a.isplay = true;
      if (d.quadrant !== s.quadrant) a.quadrant = true;
      if (force) a.all();
      Object.assign(s, d);
      r.push(d);
    });
    if (this.writePlayerUpdates(i, r)) this.sendMessage(i.finalize());
  };
  Chat.prototype.sendClientDead = function (t) {
    if (t.chatTab) {
      var e = new Writer(), n = t.chatTab.flags;
      n.reset(); n.isplay = true;
      var r = { flags: n, playerID: t.chatTab.chatId, isAlive: false, position: { x: 0, y: 0, mass: 0 } };
      this.writePlayerUpdates(e, [r]); this.sendMessage(e.finalize());
    }
  };

  /* ─────────────────────────────────────────────────────────────────────────
     6.  CHAT UI (ChatBox $e) — verbatim from bundle (emojis, resize, shortcuts).
     ───────────────────────────────────────────────────────────────────────── */
  var EMOJIS = [
    { char: '🙂', shortcuts: [':)'] }, { char: '😁', shortcuts: [':D', '=D'] }, { char: '😂', shortcuts: [":')"] },
    { char: '🤣', shortcuts: [] }, { char: '😉', shortcuts: [';)'] }, { char: '🥰', shortcuts: [] },
    { char: '😎', shortcuts: ['B)'] }, { char: '🤔', shortcuts: [':thinking:'] }, { char: '😐', shortcuts: [':|'] },
    { char: '😮', shortcuts: [':O', ':o'] }, { char: '😴', shortcuts: ['zzz'] }, { char: '😭', shortcuts: [":'("] },
    { char: '😡', shortcuts: [':@', '>:('] }, { char: '🤬', shortcuts: [':!@#'] }, { char: '💀', shortcuts: [':skull:'] },
    { char: '🤡', shortcuts: [':clown:'] }, { char: '👍', shortcuts: [':+1:'] }, { char: '👎', shortcuts: [':-1:'] },
    { char: '👋', shortcuts: [':wave:'] }, { char: '👌', shortcuts: [':ok:'] }, { char: '✌', shortcuts: [':peace:'] },
    { char: '🤞', shortcuts: [':cross:'] }, { char: '❤', shortcuts: ['<3'] }, { char: '🧡', shortcuts: ['<3O'] },
    { char: '💛', shortcuts: ['<3Y'] }, { char: '💚', shortcuts: ['<3G'] }, { char: '💙', shortcuts: ['<3B'] },
    { char: '🖤', shortcuts: ['<3K'] }, { char: '🤍', shortcuts: ['<3W'] }, { char: '😘', shortcuts: [':*', ':-*'] },
    { char: '🔥', shortcuts: [':fire:'] }, { char: '✨', shortcuts: [':star:'] }, { char: '💯', shortcuts: [':100:'] },
    { char: '💩', shortcuts: [':poop:'] }, { char: '🎉', shortcuts: [':tada:'] }, { char: '👀', shortcuts: [':eyes:'] },
    { char: '👑', shortcuts: [':crown:'] }, { char: '💎', shortcuts: [':gem:'] }, { char: '🚀', shortcuts: [':rocket:'] },
    { char: '⚽', shortcuts: [':soccer:'] }, { char: '🤝', shortcuts: [':shake:'] }, { char: '🙏', shortcuts: [':pray:'] },
    { char: '💪', shortcuts: [':muscle:'] }, { char: '🧠', shortcuts: [':brain:'] }
  ];

  function ChatBox(app) {
    var n = this;
    this.app = app;
    this.isResizing = false; this.isVisible = false;
    this.resizeStartX = 0; this.resizeStartY = 0; this.resizeStartWidth = 0; this.resizeStartHeight = 0; this.resizeScale = 1;
    this.emojis = EMOJIS;
    this.container = document.getElementById('chat-container');
    this.messagesContainer = document.getElementById('chat-messages');
    this.resizeHandle = document.getElementById('chat-resize');
    this.inputContainer = document.getElementById('chat-input-container');
    this.inputField = document.getElementById('chat-input');
    this.initResize(); this.initInput(); this.initEmojiPicker();
    var r = function () {
      if (n.container) {
        var t = n.app.settings.get('showChat') && n.app.settings.get('showHUD');
        n.container.style.setProperty('display', t ? 'flex' : 'none', 'important');
      }
    };
    this.app.settings.on('change:showChat', r); this.app.settings.on('change:showHUD', r); r();
    this.applyEventIsolation();
  }
  Object.defineProperty(ChatBox.prototype, 'isInputActive', { get: function () { return this.isVisible; } });
  Object.defineProperty(ChatBox.prototype, 'hasFocus', { get: function () { return document.activeElement === this.inputField; } });
  ChatBox.prototype.clear = function () { if (this.messagesContainer) this.messagesContainer.innerHTML = ''; };
  ChatBox.prototype.applyEventIsolation = function () {
    var t = this, e = ['mousedown', 'mouseup', 'mousemove', 'click', 'keydown', 'keyup', 'touchstart', 'touchend', 'touchmove'];
    var n = function (t) { return t.stopPropagation(); };
    if (this.container) e.forEach(function (e) { t.container.addEventListener(e, n); });
    if (this.inputContainer) e.forEach(function (e) { t.inputContainer.addEventListener(e, n); });
  };
  ChatBox.prototype.initResize = function () {
    var t = this;
    if (!this.resizeHandle || !this.container) return;
    this.resizeHandle.addEventListener('mousedown', function (e) {
      if (!t.container) return;
      t.isResizing = true; t.resizeStartX = e.clientX; t.resizeStartY = e.clientY;
      t.resizeStartWidth = t.container.offsetWidth; t.resizeStartHeight = t.container.offsetHeight;
      t.resizeScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--scale')) || 1;
      document.body.style.cursor = 'nesw-resize'; e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (t.isResizing && t.container) {
        var n = e.clientX - t.resizeStartX, r = e.clientY - t.resizeStartY;
        var i = n / t.resizeScale, o = -r / t.resizeScale;
        var a = Math.max(200, Math.min(window.innerWidth / t.resizeScale * 0.8, t.resizeStartWidth + i));
        var s = Math.max(150, Math.min(window.innerHeight / t.resizeScale * 0.8, t.resizeStartHeight + o));
        t.container.style.width = a + 'px'; t.container.style.height = s + 'px';
      }
    });
    window.addEventListener('mouseup', function () { if (t.isResizing) { t.isResizing = false; document.body.style.cursor = 'default'; } });
  };
  ChatBox.prototype.initInput = function () {
    var t = this;
    window.addEventListener('keydown', function (e) {
      if ('Enter' === e.key) {
        var ae = document.activeElement;
        if (ae && 'INPUT' === ae.tagName && ae !== t.inputField) return;
        if (!t.hasFocus) t.toggleInput();
      } else if ('Escape' === e.key && t.hasFocus) {
        t.hideInput();
      }
    });
    if (this.inputField) this.inputField.addEventListener('keydown', function (e) { if ('Enter' === e.key) t.toggleInput(); });
  };
  ChatBox.prototype.toggleInput = function () {
    if (!this.inputContainer || !this.inputField || this.app.lobby.isVisible) return;
    if (this.isVisible) {
      if (this.hasFocus) {
        var t = this.inputField.value.trim();
        if (t.length > 0) { this.sendMessage(t); this.inputField.value = ''; } else this.hideInput();
      } else this.hideInput();
    } else this.showInput();
  };
  ChatBox.prototype.showInput = function () {
    if (this.inputContainer && this.inputField) { this.inputContainer.classList.add('active'); this.inputField.value = ''; this.inputField.focus(); this.isVisible = true; }
  };
  ChatBox.prototype.hideInput = function () {
    if (this.inputContainer && this.inputField) {
      this.inputContainer.classList.remove('active'); this.inputField.blur(); this.isVisible = false;
      var gc = document.getElementById('gameCanvas') || document.getElementById('canvas');
      if (gc) gc.focus();
      var e = document.getElementById('emoji-picker'); if (e) e.classList.remove('active');
    }
  };
  ChatBox.prototype.hide = function () { if (this.container) this.container.style.setProperty('display', 'none', 'important'); };
  ChatBox.prototype.show = function () { if (this.container) this.container.style.setProperty('display', 'flex', 'important'); };
  ChatBox.prototype.sendMessage = function (t) {
    var n = this.app.dualConnectionHandler.current, e;
    if (n && n.chatTab && n.chatTab.connection) {
      e = n.type === 'Primary' ? this.app.player.nickname1 : this.app.player.nickname2;
      n.chatTab.connection.sendChatMessage({ type: 'msg', userID: 0, playerID: n.chatTab.chatId, targetID: 0, nick: e, text: this.processShortcuts(t) });
    } else {
      this.app.toasts.show('Chat not ready yet…', 'error', 1500);
    }
  };
  ChatBox.prototype.addMessage = function (t, e, n, r, i, o) {
    if (o === undefined) o = new Date();
    if (!this.messagesContainer) return;
    var a = document.createElement('div');
    a.className = 'chat-message-row';
    if ('cmd' === n || 2 === n) a.classList.add('cmd');
    var s = this.formatTime(o);
    var c = this.app.settings.get('chatShowPlayerId') && r ? '[' + r + ']' : '';
    a.innerHTML = '<span class="chat-time">' + s + '</span><span class="chat-id">' + c + '</span><span class="chat-nick"></span> <span class="chat-text"></span>';
    var u = a.querySelector('.chat-nick'), h = a.querySelector('.chat-text');
    if (u) { u.textContent = t ? t + ':' : ''; if (i && this.app.settings.get('chatUseCellColor')) u.style.color = i; else u.style.color = this.app.settings.get('chatNickColor'); }
    if (h) { h.textContent = e; h.style.color = ('cmd' === n || 2 === n) ? this.app.settings.get('chatCommandColor') : this.app.settings.get('chatMessageColor'); }
    // newest goes to the BOTTOM; keep history (up to 200) so the user can scroll up.
    var mc = this.messagesContainer;
    var atBottom = (mc.scrollHeight - mc.scrollTop - mc.clientHeight) < 28;
    mc.appendChild(a);
    while (mc.children.length > 200) { var l = mc.firstElementChild; if (l) l.remove(); else break; }
    if (atBottom) mc.scrollTop = mc.scrollHeight;   // stick to bottom unless user scrolled up
  };
  ChatBox.prototype.formatTime = function (t) {
    var e = t.getHours().toString().padStart(2, '0'), n = t.getMinutes().toString().padStart(2, '0');
    return e + ':' + n;
  };
  ChatBox.prototype.initEmojiPicker = function () {
    var t = this, e = document.getElementById('emoji-toggle'), n = document.getElementById('emoji-picker');
    if (!e || !n) return;
    n.innerHTML = '';
    this.emojis.forEach(function (e2) {
      var r = document.createElement('div');
      r.className = 'emoji-item'; r.textContent = e2.char;
      var i = e2.char; if (e2.shortcuts.length) i += ' (' + e2.shortcuts.join(', ') + ')'; r.title = i;
      r.onclick = function () { t.insertEmoji(e2.char); if (t.inputField) t.inputField.focus(); };
      n.appendChild(r);
    });
    e.addEventListener('mousedown', function (ev) { ev.preventDefault(); ev.stopPropagation(); n.classList.toggle('active'); });
    window.addEventListener('mousedown', function (ev) { if (!n.contains(ev.target) && !e.contains(ev.target)) n.classList.remove('active'); });
  };
  ChatBox.prototype.insertEmoji = function (t) {
    if (!this.inputField) return;
    var e = this.inputField.selectionStart || this.inputField.value.length;
    var n = this.inputField.selectionEnd || this.inputField.value.length;
    var r = this.inputField.value;
    this.inputField.value = r.substring(0, e) + t + r.substring(n);
    this.inputField.selectionStart = this.inputField.selectionEnd = e + t.length;
  };
  ChatBox.prototype.processShortcuts = function (t) {
    var e = t;
    this.emojis.forEach(function (em) {
      em.shortcuts.forEach(function (sc) {
        var r = sc.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        var i = new RegExp('(?<=\\s|^)' + r + '(?=\\s|$)', 'g');
        e = e.replace(i, em.char);
      });
    });
    return e;
  };

  /* ─────────────────────────────────────────────────────────────────────────
     7.  CHAT DOM + CSS  (the source's chat markup, recreated for Onyx)
     ───────────────────────────────────────────────────────────────────────── */
  function injectStyles() {
    if (document.getElementById('onyx-chat-styles')) return;
    // Static, transparent overlay: no box/background so it never blocks the game;
    // clicks pass through (pointer-events:none) except the input line while typing.
    var css = ''
      + '#chat-container{position:fixed;left:12px;bottom:72px;width:320px;max-width:36vw;height:178px;z-index:9000;'
      + 'display:flex;flex-direction:column;justify-content:flex-end;font-family:Inter,Roboto,Arial,sans-serif;'
      + 'visibility:visible !important;opacity:1 !important;'
      + 'background:transparent;border:none;box-shadow:none;pointer-events:none;overflow:hidden;}'
      + '#chat-messages{flex:1;overflow-y:auto;overflow-x:hidden;padding:0 6px 0 2px;display:flex;flex-direction:column;'
      + 'gap:1px;pointer-events:auto;'
      + 'scrollbar-width:thin;scrollbar-color:rgba(224,168,46,.55) transparent;}'
      + '#chat-messages .chat-message-row:first-child{margin-top:auto;}'
      + '#chat-messages::-webkit-scrollbar{width:6px;}'
      + '#chat-messages::-webkit-scrollbar-thumb{background:rgba(224,168,46,.55);border-radius:4px;}'
      + '#chat-messages::-webkit-scrollbar-track{background:transparent;}'
      + '.chat-message-row{flex:0 0 auto;font-size:13px;line-height:1.3;word-break:break-word;white-space:pre-wrap;pointer-events:none;'
      + 'text-shadow:0 1px 2px #000,0 0 3px #000,1px 1px 1px #000;}'
      + '.chat-message-row .chat-time{display:none;}'
      + '.chat-message-row .chat-id{color:#cdbb88;font-size:11px;margin-right:3px;}'
      + '.chat-message-row .chat-nick{font-weight:700;margin-right:5px;}'
      + '.chat-message-row.cmd{font-style:italic;opacity:.95;}'
      + '#chat-resize{display:none !important;}'
      + '#chat-input-container{display:none;align-items:center;gap:6px;padding:5px 8px;margin-top:4px;border-radius:8px;'
      + 'background:rgba(0,0,0,.55);border:1px solid rgba(224,168,46,.4);pointer-events:auto;}'
      + '#chat-input-container.active{display:flex;}'
      + '#chat-input{flex:1;background:transparent;border:none;color:#fff;font-size:14px;padding:2px;outline:none;pointer-events:auto;'
      + 'text-shadow:0 1px 2px #000;}'
      + '#chat-input::placeholder{color:#cfcfcf;}'
      + '#emoji-toggle{cursor:pointer;font-size:18px;line-height:1;user-select:none;padding:2px 4px;border-radius:6px;pointer-events:auto;}'
      + '#emoji-toggle:hover{background:rgba(224,168,46,.18);}'
      + '#emoji-picker{display:none;position:absolute;right:8px;bottom:52px;width:268px;max-height:180px;overflow-y:auto;'
      + 'background:rgba(20,20,26,.97);border:1px solid rgba(224,168,46,.4);border-radius:10px;padding:8px;z-index:3;'
      + 'grid-template-columns:repeat(8,1fr);gap:2px;box-shadow:0 6px 24px rgba(0,0,0,.5);pointer-events:auto;}'
      + '#emoji-picker.active{display:grid;}'
      + '.emoji-item{cursor:pointer;font-size:20px;text-align:center;border-radius:6px;padding:3px 0;user-select:none;pointer-events:auto;}'
      + '.emoji-item:hover{background:rgba(224,168,46,.22);}';
    var st = document.createElement('style');
    st.id = 'onyx-chat-styles'; st.textContent = css;
    document.head.appendChild(st);
  }

  function buildDOM() {
    if (document.getElementById('chat-container')) return;
    var c = document.createElement('div');
    c.id = 'chat-container';
    c.innerHTML =
      '<div id="chat-resize"></div>' +
      '<div id="chat-messages"></div>' +
      '<div id="chat-input-container">' +
        '<input id="chat-input" type="text" maxlength="200" placeholder="Type a message…" autocomplete="off" spellcheck="false">' +
        '<span id="emoji-toggle" title="Emoji">😊</span>' +
      '</div>' +
      '<div id="emoji-picker"></div>';
    document.body.appendChild(c);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     8.  ONYX ADAPTER  — supplies the `app` surface the chat expects, sourced
         from Onyx DOM/state. No game-engine code is touched.
     ───────────────────────────────────────────────────────────────────────── */
  function nicknameEl() {
    return qs('#nick') || qs('#nickname') || qs('input[name="nick"]') || qs('input[name="nickname"]')
      || qs('input[placeholder*="nick" i]') || qs('input[placeholder*="name" i]');
  }
  function detectNick() { return clean(nicknameEl() && nicknameEl().value, 'player') || 'player'; }
  function detectTag() { var el = qs('#tag') || qs('input[placeholder*="tag" i]'); return clean(el && el.value).toUpperCase(); }
  function selectedServerUrl() {
    var sel = qs('#servers');
    var raw = clean((sel && sel.value) || localStorage.getItem('ZYNX:server') || 'eu.senpa.io:2001');
    if (raw.indexOf('ws') !== 0) raw = 'wss://' + raw;
    return raw.replace(/\/+$/, '');
  }
  function chatRoomUrl() { return selectedServerUrl().replace(/senpa\.io/gi, 'mi.com'); }
  function tokenFromUrl(url) { var m = clean(url).replace(/\/+$/, '').match(/^wss?:\/\/(.+)/i); return m ? btoa(m[1]) : ''; }

  // stable, positive, non-zero uint32 client id (persists per tab session)
  function stableClientId() {
    var KEY = 'ONYX_CHAT_CLIENT_ID';
    var id = parseInt(sessionStorage.getItem(KEY), 10);
    if (!id || id <= 0) { id = (crypto.getRandomValues(new Uint32Array(1))[0] % 0x7fffffff) + 1; sessionStorage.setItem(KEY, String(id)); }
    return id;
  }

  // best-effort live read of the Onyx player's world coords / mass / color.
  function readOnyxPlayerState() {
    var x = 0, y = 0, mass = 0, colorInt = 0xe0a82e;
    try {
      var mb = window.ONYX && window.ONYX.multibox;
      if (mb && mb.camera && typeof mb.camera.x === 'number') { x = mb.camera.x; y = mb.camera.y; }
      var t = JSON.parse(localStorage.getItem('ONYXPROD540-theme') || '{}');
      if (t && t.selfColor) colorInt = parseInt(String(t.selfColor).replace('#', ''), 16) || colorInt;
    } catch (e) {}
    return { x: x, y: y, mass: mass, colorInt: colorInt };
  }

  function isLobbyVisible() {
    // chat input shouldn't steal Enter while the start menu / lobby is on screen.
    var menu = qs('#menu') || qs('.menu-wrapper') || qs('#startMenu') || qs('#main-menu');
    if (menu && getComputedStyle(menu).display !== 'none' && menu.offsetParent !== null) return true;
    return false;
  }

  function makeSettings() {
    var DEFAULTS = {
      showChat: true, showHUD: true, chatShowPlayerId: false, chatUseCellColor: false,
      chatNickColor: '#4fecff', chatMessageColor: '#DDDDDD', chatCommandColor: '#FFCC00'
    };
    var KEY = 'ONYX_CHAT_SETTINGS';
    var store; try { store = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { store = {}; }
    var em = new Emitter();
    return {
      get: function (k) { return store[k] !== undefined ? store[k] : DEFAULTS[k]; },
      set: function (k, v) { store[k] = v; try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {} em.emit('change:' + k, v); },
      on: function (ev, cb) { em.on(ev, cb); }
    };
  }

  function makeToasts() {
    var wrap = null;
    function ensure() {
      if (wrap) return wrap;
      wrap = document.createElement('div');
      wrap.id = 'onyx-chat-toasts';
      wrap.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:10000;display:flex;flex-direction:column;gap:6px;pointer-events:none;';
      document.body.appendChild(wrap);
      return wrap;
    }
    var colors = { info: '#4fa3ff', success: '#32d17c', error: '#ff5a5a' };
    return {
      show: function (text, type, ms) {
        var el = document.createElement('div');
        el.textContent = text;
        el.style.cssText = 'background:rgba(20,20,26,.95);color:' + (colors[type] || '#ddd') + ';border:1px solid ' + (colors[type] || '#444') + ';padding:7px 14px;border-radius:8px;font:13px Inter,Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);';
        ensure().appendChild(el);
        if (ms !== 0) setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, ms || 2000);
        return el;
      },
      remove: function (el) { if (el && el.parentNode) el.parentNode.removeChild(el); }
    };
  }

  function buildApp() {
    var clientId = stableClientId();
    // a single synthetic "connection" representing the Onyx player tab.
    var onyxClient = {
      clientId: clientId,
      type: 'Primary',
      isAlive: true,
      lastData: { position: { x: 0, y: 0, mass: 0 } },
      chatTab: null,
      get player() { var s = readOnyxPlayerState(); return { x: s.x, y: s.y, totalMass: s.mass, colorInt: s.colorInt }; }
    };

    var app = {
      settings: makeSettings(),
      toasts: makeToasts(),
      player: {
        chat: null,
        get nickname1() { return detectNick(); },
        get nickname2() { return detectNick(); },
        get skin1() { return ''; },
        get skin2() { return ''; },
        get tag() { return detectTag(); },
        get serverUrl() { return selectedServerUrl(); }
      },
      stage: { get border() { return { left: 0, right: 0, top: 0, bottom: 0 }; }, createWave: function () {} },
      lobby: { get isVisible() { return isLobbyVisible(); } },
      dualConnectionHandler: {
        list: [onyxClient],
        get current() { return onyxClient; },
        get primary() { return onyxClient; },
        forEachClient: function (fn) { fn(onyxClient); }
      },
      chatBox: null,
      _onyxClient: onyxClient
    };
    return app;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     9.  BOOTSTRAP — mirrors the source GameManager wiring (initChat,
         updateChatRoom, message/wave routing, client registration).
     ───────────────────────────────────────────────────────────────────────── */
  var app = null;

  var _lastRoomKey = null;
  function updateChatRoom(force) {
    if (!(app.player.chat && app.player.chat.isConnected)) return;
    var room = chatRoomUrl();                 // wss://eu.mi.com:2001
    var token = tokenFromUrl(room);           // btoa("eu.mi.com:2001")
    var tag = app.player.tag;                 // clanTag -> the server scopes the
                                              // chat room BY this tag, so a non-empty
                                              // tag = private chat among same-tag players.
    var key = token + '|' + tag;
    if (!force && key === _lastRoomKey) return;
    _lastRoomKey = key;
    app.player.chat.enterRoom(token, tag, 1, '', room);
    dlog('enterRoom', { token: token, tag: tag, room: room, private: !!tag });
  }

  function initChat() {
    app.player.chat = new Chat(app);
    app.player.chat.connect();
    // register our single Onyx tab (queues until socket opens).
    app.player.chat.registerClient(app._onyxClient);

    app.player.chat.events.on('connectionID', function () {
      if (!app.player.chat) return;
      _lastRoomKey = null;          // fresh socket/tab: always (re)enter the room
      updateChatRoom(true);
      app.toasts.show('Connected to chat', 'success', 1000);
    });
    app.player.chat.events.on('message', function (e) {
      var color, pid = e.playerID ? e.playerID.toString() : '';
      if (app.player.chat && app.player.chat.players) {
        var p = app.player.chat.players.get(e.playerID);
        if (p && p.pColor) { try { color = intToHex(p.pColor); } catch (x) {} }
      }
      var nick = e.nick;
      if (!nick || nick.trim().length === 0) nick = 'unnamed#' + e.playerID;
      app.chatBox.addMessage(nick, e.text, e.type, pid, color);
    });
    app.player.chat.events.on('wave', function (e) { app.stage.createWave(e.x, e.y, e.color); });
  }

  function reconnectChat() {
    if (app.player.chat) {
      app.player.chat.close();
      app.toasts.show('Reconnecting to Chat...', 'info', 2000);
      setTimeout(initChat, 500);
    } else initChat();
  }

  function start() {
    injectStyles();
    buildDOM();
    app = buildApp();
    app.chatBox = new ChatBox(app);
    initChat();

    // re-enter the room when the player switches server in the menu.
    var serversSel = qs('#servers');
    if (serversSel) serversSel.addEventListener('change', function () { setTimeout(updateChatRoom, 50); });

    // re-enter the room when the player sets/changes their TAG (clan). The server
    // scopes the chat room by clanTag, so this is what makes tag-only chat work:
    // a non-empty tag => you only talk to same-tag players. Listen on the field and
    // also poll, so it stays in sync no matter how the tag is set (typing, spawn, etc).
    var tagEl = qs('#tag');
    if (tagEl) { ['input', 'change', 'blur'].forEach(function (ev) { tagEl.addEventListener(ev, function () { setTimeout(updateChatRoom, 30); }); }); }
    setInterval(function () { updateChatRoom(false); }, 1500);

    // public API (debug / external scripts) — keeps backward-compatible names.
    window.ONYXChat = {
      app: app, chat: function () { return app.player.chat; },
      send: function (t) { app.chatBox.sendMessage(t); },
      reconnect: reconnectChat, addMessage: function () { app.chatBox.addMessage.apply(app.chatBox, arguments); }
    };
    window.ZMDeltaChat = window.ONYXChat;
    dlog('chat ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
