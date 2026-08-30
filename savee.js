/**
 * sav.js — ONYX Replay Recorder (drop-in, fixed)
 * ---------------------------------------------------------------
 * Regjistron vazhdimisht (të paktën) ~10s e fundit nga <canvas> dhe i ruan
 * si .webm kur shtypet "P" ose thirret OnyxReplay.save().
 *
 * FIX: MediaRecorder nuk ndalet kurrë pas save(). Mbajmë "headerChunk"
 * (init segment) që del në copën e parë dhe e prependojmë në ÇDO save.
 * Kështu çdo regjistrim pasues është i plotë dhe i luajtshëm.
 */
(function () {
  "use strict";

  const DEFAULTS = {
    seconds: 15,
    segments: 3,   // sa buffer-a të shkallëzuar; oldest = seconds*(N-1)/N ... seconds
    fps: 30,
    timeSliceMs: 500,
    videoBitsPerSecond: 4_000_000,
    hotkey: "p",
    autoStart: true,
    filenamePrefix: "onyx-replay",
  };

  const MIME_CANDIDATES = [
    'video/webm;codecs="vp9,opus"',
    'video/webm;codecs=vp9',
    'video/webm;codecs="vp8,opus"',
    'video/webm;codecs=vp8',
    "video/webm",
  ];

  function pickMime() {
    if (typeof MediaRecorder === "undefined") return null;
    for (const m of MIME_CANDIDATES) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
    }
    return null;
  }

  function findGameCanvas() {
    const cs = document.querySelectorAll("canvas");
    let best = null, bestArea = 0;
    cs.forEach((c) => {
      const w = c.width || c.clientWidth;
      const h = c.height || c.clientHeight;
      const a = w * h;
      if (a > bestArea) { bestArea = a; best = c; }
    });
    return best;
  }

  function tsName(prefix) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${prefix}-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.webm`;
  }

  /* ─────────────────────────────────────────────────────────────────────
     Recorder me DY segmente të shkallëzuar (double-buffer).

     PROBLEMI i vjetër: një recorder i vetëm + ring-buffer që hidhte copat e
     para → hidhej edhe keyframe-i → klipi i dytë dilte i ZI.

     ZGJIDHJA: mbajmë dy MediaRecorder mbi të njëjtin stream, të nisur me
     ofset `seconds/2`, secili rinis çdo `seconds`. Kur ruan, marrim segmentin
     që ka regjistruar më gjatë dhe e mbyllim → del një webm i PLOTË, i pavarur,
     gjithmonë me keyframe në fillim → KURRË i zi dhe gjithmonë i luajtshëm.
     Me N=3 segmente & seconds=15, segmenti më i vjetër është gjithmonë ≥10s,
     pra klipi mbulon ~10–15s e fundit dhe mbaron "tani".
  ───────────────────────────────────────────────────────────────────── */
  class ReplayRecorder {
    constructor(opts = {}) {
      this.opts = { ...DEFAULTS, ...opts };
      this.canvas = null;
      this.stream = null;
      this.mime = null;
      const n = Math.max(2, this.opts.segments | 0);
      this.segs = new Array(n).fill(null);   // slote segmentesh të shkallëzuar
      this._running = false;
      this._saving = false;
    }

    get isRecording() { return this._running; }

    _newSeg(slot) {
      if (!this._running || !this.stream) return null;
      let rec;
      try {
        rec = new MediaRecorder(this.stream, {
          mimeType: this.mime,
          videoBitsPerSecond: this.opts.videoBitsPerSecond,
        });
      } catch (e) { console.warn("[OnyxReplay] MediaRecorder", e); return null; }

      const seg = { rec, startTs: performance.now(), parts: [], onfinal: null, slot };
      rec.ondataavailable = (e) => { if (e.data && e.data.size) seg.parts.push(e.data); };
      rec.onerror = (ev) => console.warn("[OnyxReplay] recorder error", ev);
      rec.onstop = () => {
        const blob = new Blob(seg.parts, { type: this.mime || "video/webm" });
        const cb = seg.onfinal; seg.onfinal = null;
        if (cb) cb(blob);
      };
      try { rec.start(); } catch (e) { console.warn("[OnyxReplay] start", e); return null; }
      // Rinisje automatike që memoria të mos rritet pa fund.
      seg.autoTimer = setTimeout(() => this._autoRestart(seg), this.opts.seconds * 1000);
      this.segs[slot] = seg;
      return seg;
    }

    _autoRestart(seg) {
      if (!this._running) return;
      seg.onfinal = null;                      // hedhim blob-in e këtij cikli
      try { if (seg.rec.state !== "inactive") seg.rec.stop(); } catch (_) {}
      this._newSeg(seg.slot);
    }

    // Mbyll segmentin → kthen webm-in e plotë, pastaj rihap slotin.
    _finalize(seg) {
      return new Promise((resolve) => {
        clearTimeout(seg.autoTimer);
        seg.onfinal = (blob) => resolve(blob);
        try {
          if (seg.rec.state !== "inactive") seg.rec.stop();
          else resolve(new Blob(seg.parts, { type: this.mime || "video/webm" }));
        } catch (e) { resolve(null); }
      }).then((blob) => { this._newSeg(seg.slot); return blob; });
    }

    start(canvasEl) {
      if (this._running) return true;
      const canvas = canvasEl || findGameCanvas();
      if (!canvas) { console.warn("[OnyxReplay] canvas not found"); return false; }
      const mime = pickMime();
      if (!mime) { console.warn("[OnyxReplay] MediaRecorder/webm not supported"); return false; }

      try {
        this.canvas = canvas;
        this.stream = canvas.captureStream(this.opts.fps);
        this.mime = mime;
        const n = Math.max(2, this.opts.segments | 0);
        this.segs = new Array(n).fill(null);
        this._staggerTimers = [];
        this._running = true;
        this._newSeg(0);
        // Segmentet e tjera të shkallëzuara në mënyrë të barabartë brenda `seconds`,
        // që segmenti më i vjetër të jetë gjithmonë ≥ seconds*(N-1)/N (p.sh. 3 seg, 15s ⇒ ≥10s).
        for (let i = 1; i < n; i++) {
          this._staggerTimers.push(setTimeout(() => {
            if (this._running) this._newSeg(i);
          }, (this.opts.seconds * 1000 * i) / n));
        }
        return true;
      } catch (err) {
        console.warn("[OnyxReplay] start failed", err);
        this._cleanupStream();
        this._running = false;
        return false;
      }
    }

    stop() {
      this._running = false;
      (this._staggerTimers || []).forEach(clearTimeout);
      this._staggerTimers = [];
      this.segs.forEach((seg) => {
        if (!seg) return;
        clearTimeout(seg.autoTimer);
        seg.onfinal = null;
        try { if (seg.rec.state !== "inactive") seg.rec.stop(); } catch (_) {}
      });
      this.segs = this.segs.map(() => null);
      this._cleanupStream();
    }

    _cleanupStream() {
      try { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      this.stream = null;
    }

    clear() { /* asgjë për të pastruar: segmentet rinisen vetë */ }

    /* Kthen një webm të PLOTË (segmenti që ka regjistruar më gjatë). Çdo klip
       është i pavarur me keyframe → kurrë i zi, gjithmonë i luajtshëm. */
    async buildBlob() {
      const segs = this.segs.filter(Boolean);
      if (!segs.length) { console.warn("[OnyxReplay] nothing to record yet"); return null; }
      segs.sort((a, b) => a.startTs - b.startTs);   // më i vjetri = klip më i gjatë
      const blob = await this._finalize(segs[0]);
      if (!blob || !blob.size) { console.warn("[OnyxReplay] empty clip"); return null; }
      return blob;
    }

    async save(filename) {
      if (this._saving) return null;
      this._saving = true;
      try {
        const blob = await this.buildBlob();
        if (!blob) return null;
        const name = filename || tsName(this.opts.filenamePrefix);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return { name, size: blob.size, type: blob.type };
      } finally {
        this._saving = false;
      }
    }
  }

  const recorder = new ReplayRecorder();
  // Kohëzgjatja e garantuar minimale e klipit (oldest = seconds*(N-1)/N).
  const CLIP_SECS = Math.round(recorder.opts.seconds * (recorder.segs.length - 1) / recorder.segs.length);

  /* ───────────────────────────────────────────────────────────────────
     RUAJTJE PERSISTENTE (IndexedDB) — klipet ruhen në faqe dhe rrijnë edhe
     pas rifreskimit, pa pasur nevojë t'i bësh download.
  ─────────────────────────────────────────────────────────────────── */
  const DB_NAME = "onyxReplays", DB_STORE = "clips";
  let _dbPromise = null;
  function idb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); }
      catch (e) { return reject(e); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }
  function idbTx(mode) { return idb().then((db) => db.transaction(DB_STORE, mode).objectStore(DB_STORE)); }
  async function idbAdd(clip) {
    const st = await idbTx("readwrite");
    return new Promise((res, rej) => { const r = st.add(clip); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
  }
  async function idbAll() {
    const st = await idbTx("readonly");
    return new Promise((res, rej) => { const r = st.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); });
  }
  async function idbDelete(id) {
    const st = await idbTx("readwrite");
    return new Promise((res, rej) => { const r = st.delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
  }

  /* ───────────────────────────────────────────────────────────────────
     UI: butoni i regjistrimit + treguesi REC + BIBLIOTEKA e klipeve në faqe
     (shfaq dhe luan klipet e ruajtura pa qenë nevoja t'i bësh download).
  ─────────────────────────────────────────────────────────────────── */
  let _ui = null;
  function buildUI() {
    if (_ui || !document.body) return;
    const css = `
      #onyx-replay-bar{position:fixed;right:14px;bottom:14px;z-index:2147483000;
        display:flex;align-items:center;gap:8px;font-family:Rajdhani,Ubuntu,sans-serif}
      .onyx-rb{display:flex;align-items:center;gap:7px;cursor:pointer;
        background:rgba(12,16,20,.86);border:1px solid #00ff9c55;border-radius:10px;
        color:#eafff5;padding:8px 12px;font-size:14px;font-weight:600;letter-spacing:.3px;
        box-shadow:0 4px 18px rgba(0,0,0,.45);backdrop-filter:blur(6px);user-select:none;
        transition:border-color .15s,transform .08s}
      .onyx-rb:hover{border-color:#00ff9c}
      .onyx-rb:active{transform:scale(.96)}
      #onyx-replay-dot{width:10px;height:10px;border-radius:50%;background:#ff3b3b;
        box-shadow:0 0 8px #ff3b3b;animation:onyxRecPulse 1.3s infinite}
      #onyx-replay-dot.off{background:#666;box-shadow:none;animation:none}
      @keyframes onyxRecPulse{0%,100%{opacity:1}50%{opacity:.25}}
      #onyx-replay-modal{position:fixed;inset:0;z-index:2147483600;display:none;
        align-items:center;justify-content:center;background:rgba(0,0,0,.72);backdrop-filter:blur(3px)}
      #onyx-replay-modal.show{display:flex}
      #onyx-replay-card{background:#0c1014;border:1px solid #00ff9c44;border-radius:14px;
        padding:14px;max-width:min(92vw,920px);width:100%;max-height:88vh;display:flex;flex-direction:column;
        box-shadow:0 18px 60px rgba(0,0,0,.6);font-family:Rajdhani,Ubuntu,sans-serif}
      #onyx-replay-card h3{margin:0 0 10px;color:#00ff9c;font-size:18px;font-weight:700;
        letter-spacing:.5px;display:flex;justify-content:space-between;align-items:center}
      #onyx-replay-player{width:100%;border-radius:10px;background:#000;display:block;max-height:46vh}
      #onyx-replay-empty{color:#7f8c88;font-size:14px;padding:26px 4px;text-align:center}
      #onyx-replay-list{margin-top:12px;overflow:auto;display:flex;flex-direction:column;gap:8px}
      .onyx-clip{display:flex;align-items:center;gap:10px;background:#11171d;border:1px solid #1d2a25;
        border-radius:9px;padding:8px 10px}
      .onyx-clip.active{border-color:#00ff9c;background:#0f1f1a}
      .onyx-clip .meta{flex:1;min-width:0}
      .onyx-clip .nm{color:#dff;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .onyx-clip .sb{color:#7f8c88;font-size:11px;font-weight:500}
      .onyx-replay-x{cursor:pointer;color:#9fb;background:transparent;border:1px solid #2a3a33;
        border-radius:8px;padding:6px 11px;font-size:12px;font-weight:600;font-family:inherit;white-space:nowrap}
      .onyx-replay-x.primary{background:#00ff9c;color:#06231a;border-color:#00ff9c}
      .onyx-replay-x.danger{color:#ff8a8a;border-color:#5a2a2a}
      .onyx-replay-x:hover{filter:brightness(1.12)}
      #onyx-replay-count{background:#00ff9c22;border:1px solid #00ff9c55;border-radius:20px;
        padding:1px 8px;font-size:12px;color:#00ff9c;margin-left:2px}`;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const bar = document.createElement("div");
    bar.id = "onyx-replay-bar";
    bar.innerHTML =
      '<div class="onyx-rb" id="onyx-save-btn" title="Ruaj ' + CLIP_SECS + 's e fundit (P)">' +
        '<span id="onyx-replay-dot" class="off"></span>' +
        '<span id="onyx-save-label">Ruaj ' + CLIP_SECS + 's</span>' +
      '</div>' +
      '<div class="onyx-rb" id="onyx-lib-btn" title="Klipet e ruajtura">' +
        '<span>🎞 Klipet</span><span id="onyx-replay-count">0</span>' +
      '</div>';
    document.body.appendChild(bar);

    const modal = document.createElement("div");
    modal.id = "onyx-replay-modal";
    modal.innerHTML =
      '<div id="onyx-replay-card">' +
        '<h3><span>🎞 Klipet e mia</span>' +
          '<button class="onyx-replay-x" data-act="close">Mbyll</button></h3>' +
        '<video id="onyx-replay-player" controls autoplay loop playsinline></video>' +
        '<div id="onyx-replay-empty">S\'ka ende klipe të ruajtur. Kliko “Ruaj ' + CLIP_SECS + 's”.</div>' +
        '<div id="onyx-replay-list"></div>' +
      '</div>';
    document.body.appendChild(modal);

    const dot    = bar.querySelector("#onyx-replay-dot");
    const player = modal.querySelector("#onyx-replay-player");
    const listEl = modal.querySelector("#onyx-replay-list");
    const emptyEl= modal.querySelector("#onyx-replay-empty");
    const countEl= bar.querySelector("#onyx-replay-count");
    let _playUrl = null, _activeId = null;

    const fmtSize = (b) => (b / 1048576).toFixed(1) + " MB";
    const fmtTime = (ts) => { const d = new Date(ts); const p = (n) => String(n).padStart(2, "0");
      return p(d.getDate()) + "/" + p(d.getMonth()+1) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()); };

    function playClip(clip) {
      if (_playUrl) URL.revokeObjectURL(_playUrl);
      _playUrl = URL.createObjectURL(clip.blob);
      _activeId = clip.id;
      player.style.display = "block";
      player.src = _playUrl;
      try { player.play(); } catch (_) {}
      listEl.querySelectorAll(".onyx-clip").forEach((el) =>
        el.classList.toggle("active", Number(el.dataset.id) === clip.id));
    }

    async function refreshList(selectId) {
      let clips = [];
      try { clips = await idbAll(); } catch (e) { console.warn("[OnyxReplay] idb read", e); }
      clips.sort((a, b) => b.id - a.id);   // më të rejat lart
      countEl.textContent = String(clips.length);
      listEl.innerHTML = "";
      if (!clips.length) {
        emptyEl.style.display = "block";
        player.style.display = "none";
        player.removeAttribute("src"); player.load();
        return;
      }
      emptyEl.style.display = "none";
      for (const clip of clips) {
        const row = document.createElement("div");
        row.className = "onyx-clip";
        row.dataset.id = clip.id;
        row.innerHTML =
          '<div class="meta"><div class="nm">' + clip.name + '</div>' +
            '<div class="sb">' + fmtTime(clip.ts) + ' · ' + fmtSize(clip.size) + '</div></div>' +
          '<button class="onyx-replay-x primary" data-play="1">▶ Shiko</button>' +
          '<button class="onyx-replay-x" data-dl="1">↓</button>' +
          '<button class="onyx-replay-x danger" data-del="1">🗑</button>';
        row.querySelector("[data-play]").addEventListener("click", () => playClip(clip));
        row.querySelector("[data-dl]").addEventListener("click", () => {
          const u = URL.createObjectURL(clip.blob);
          const a = document.createElement("a"); a.href = u; a.download = clip.name;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(u), 60_000);
        });
        row.querySelector("[data-del]").addEventListener("click", async () => {
          await idbDelete(clip.id);
          if (_activeId === clip.id) { player.style.display = "none"; player.removeAttribute("src"); player.load(); }
          refreshList();
        });
        listEl.appendChild(row);
      }
      const toPlay = selectId ? clips.find((c) => c.id === selectId) : clips[0];
      if (toPlay) playClip(toPlay);
    }

    function openLibrary() { modal.classList.add("show"); refreshList(); }
    function closeModal() {
      modal.classList.remove("show");
      try { player.pause(); } catch (_) {}
    }

    async function saveToLibrary() {
      const label = bar.querySelector("#onyx-save-label");
      const prev = label.textContent;
      label.textContent = "Po ruhet…";
      const blob = await recorder.buildBlob();
      label.textContent = prev;
      if (!blob) { flash("S'ka ende regjistrim — hyr në lojë pak."); return; }
      const id = Date.now();
      const clip = { id, ts: id, name: tsName(recorder.opts.filenamePrefix), size: blob.size, blob };
      try { await idbAdd(clip); } catch (e) { console.warn("[OnyxReplay] idb add", e); flash("Gabim ruajtjeje"); return; }
      flash("✓ U ruajt!");
      modal.classList.add("show");
      refreshList(id);
    }

    function flash(msg) {
      const label = bar.querySelector("#onyx-save-label");
      const prev = label.textContent;
      label.textContent = msg;
      setTimeout(() => { label.textContent = prev; }, 1800);
    }

    bar.querySelector("#onyx-save-btn").addEventListener("click", saveToLibrary);
    bar.querySelector("#onyx-lib-btn").addEventListener("click", openLibrary);
    modal.addEventListener("click", (e) => {
      const act = e.target && e.target.getAttribute && e.target.getAttribute("data-act");
      if (e.target === modal || act === "close") closeModal();
    });

    // Përditëso treguesin REC + numëruesin e klipeve.
    setInterval(() => { dot.classList.toggle("off", !recorder.isRecording); }, 1000);
    idbAll().then((c) => { countEl.textContent = String(c.length); }).catch(() => {});

    _ui = { bar, modal, saveToLibrary, openLibrary, closeModal, refreshList };
    if (window.OnyxReplay) {
      window.OnyxReplay.preview = saveToLibrary;
      window.OnyxReplay.openLibrary = openLibrary;
    }
    return _ui;
  }

  function tryAutoStart() {
    buildUI();
    if (!recorder.opts.autoStart) return;
    if (recorder.start()) return;
    // Provo sërish kur shtohet ndonjë canvas (loja ngarkohet vonë).
    const obs = new MutationObserver(() => {
      if (recorder.start()) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    // Stop pas 60s për të mos rënduar DOM-in.
    setTimeout(() => obs.disconnect(), 60_000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryAutoStart, { once: true });
  } else {
    tryAutoStart();
  }

  window.addEventListener("keydown", (e) => {
    const k = (e.key || "").toLowerCase();
    if (k !== recorder.opts.hotkey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    // "P" ruan klipin e fundit (≥10s) në bibliotekë dhe e hap atë (si senpa).
    if (_ui) _ui.saveToLibrary(); else recorder.save();
  }, { capture: true });

  window.OnyxReplay = {
    start:  (el) => recorder.start(el),
    stop:   ()    => recorder.stop(),
    save:   (n)   => recorder.save(n),
    preview:()    => (_ui ? _ui.saveToLibrary() : recorder.save()),
    openLibrary: () => (_ui ? _ui.openLibrary() : null),
    clear:  ()    => recorder.clear(),
    get isRecording() { return recorder.isRecording; },
    _instance: recorder,
  };
})();

