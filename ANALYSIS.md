# ANALIZË E PLOTË + PLAN INTEGRIMI — ONYX · EON · SENPA

> Qëllimi: analizë e plotë e tre klientëve (mod-ve) për lojën **senpa.io** (agar.io-style),
> identifikimi i implementimeve më të mira të secilit, dhe prodhimi i një skripti final të
> unifikuar (`onyx-unified.js`) me fokus maksimal te **multibox**.

---

## 0. ÇFARË JANË REALISHT KËTO TRE PROJEKTE (e rëndësishme)

Të tre arkivat janë **klientë/mod-e të kompiluar (build artifacts)** për lojën `senpa.io`, jo
kod burim i pastër. Kjo prek drejtpërdrejt çfarë mund të bashkohet "pastër":

| Projekt | Folder në zip | Natyra e kodit | Lexueshmëria |
|---|---|---|---|
| **ONYX** | `onlyforJasmina-main` | React build (minified) + `senpaobs.js`/`senpaobs1.js` (obfuscuar) + `bundle.wasm` | E ulët (minified/obfuscated) |
| **EON** | `Eon404-main` | Webpack `bundle.js` (minified, standard) + `wasmLoader.js` (obfuscuar) + CSS modulare + `key.js`/`chat.js` (të pastra) | Mesatare-e lartë |
| **SENPA**| `vetempermua-main` | `deo.onyx.beautified.js` (obfuscuar me string-array, por i beautify-uar) + `chat.js`/`savee.js` (të pastra) + WASM | Mesatare |

**Pasojë kyçe:** Motori i lojës dhe logjika më e thellë e sinkronizimit ndodhen në **WASM +
JS të obfuskuar**, prandaj NUK mund të "kopjohen" fjalë-për-fjalë në një skript të pastër.
Ato që JANË plotësisht të lexueshme dhe të ripërdorshme janë **shtresat e mod-it**:
key-gating, anti-tracking, chat, replay, settings, update-notifier, UI e multibox-it, dhe
**protokolli binar + logjika e sinkronizimit të multibox-it** (që e kemi rikuptuar nga
`deo.onyx.beautified.js` dhe `chat.js`).

Skripti final (`onyx-unified.js`) është pra një **rishkrim i pastër, i deobfuskuar dhe i
dokumentuar i shtresës mod + kontrollerit të multibox-it**, me **pika integrimi të qarta**
(`@requires engine`) atje ku duhet motori/WASM origjinal.

---

## FAZA 1 — HARTA E PROJEKTEVE

### 1.1 ONYX (`onlyforJasmina-main`)
```
index.html                      → bootstrap; reklama gameads; **multibox dual-nick inline** (window.__connNicks)
static/js/main.8569eac9.js      → React app (UI/menu/lobby) — arkitektura bazë (1.7MB, minified)
static/css/main.*.css           → stilet e UI
build/vendors.js                → libra (React/webpack vendors)
build/senpaobs.js               → mod loader (obfuscated)
build/senpaobs1.js              → mod kryesor: engine overlay + multibox dual-connection (obfuscated)
build/bundle.wasm / bundle.wasm → motori i lojës (WASM)
img/, build/resources/img/      → asete
```
**Roli në unifikim:** arkitektura bazë e UI (React), dhe modeli **single-page dual-connection**
i multibox-it (`window.__connNicks = [nick1, nick2]`).

### 1.2 EON (`Eon404-main`) — rishkrimi më modern dhe i pastër
```
index.html                      → HUD/lobby/minimap/reconnect/settings/skins/update-notifier;
                                  anti-tracking guard; chat bridge (postMessage nga delt.io)
key.js                          → **gating me licencë** (Cloudflare Worker) → ngarkon bundle.js
wasmLoader.js                   → ngarkues WASM (obfuscated)
bundle.js                       → webpack bundle: EventEmitter, WebSocket, reconnect,
                                  update-notifier, skins, profiles, mouse/spawn/writeUint8 (minified)
assets/css/*.css                → CSS modulare: chat, hud-layout, lobby, minimap, reconnect,
                                  settings, skins, update-notifier, styles
assets/images/cursors/*.cur     → kursorë
```
**Roli në unifikim:** **sistemi i hapjes (key-gating)**, **sistemi i patch-it (update-notifier)**,
**chat bridge**, anti-tracking, reconnect, profiles (1–10), dual-skin/dual-nick lobby.

### 1.3 SENPA (`vetempermua-main`)
```
index.html                      → UI me settings shumë të pasura (multibox ring/shield/cellColor,
                                  active/inactive stroke, etj.) + turnstile
deo.onyx.beautified.js          → mod KRYESOR (obfuscated, beautified): hotkeys, multibox dual-conn,
deo.onyx.beautifieddddd.js        camera centroid, saigoWS (spy), render, settings (787KB)
chat.js                         → **klient chat i plotë & i pastër** (wss://chat.delt.io) + Writer/Reader binar
savee.js                        → **ONYX Replay Recorder** (i pastër, ring-buffer webm)
api.js                          → ngarkues Cloudflare Turnstile
assets/js/lib.js, vendors, runtime → webpack/libra
bundle.wasm, bundle2.wasm, 89.wasm → motorë WASM
vercel.json                     → CORS headers (deployment)
```
**Roli në unifikim:** veçoritë unike & optimizimet — **chat.js** (implementimi më i mirë i chat-it
me protokoll binar, anti-spam, mute, history, send-queue), **savee.js** (replay), dhe logjika e
plotë e **multibox sync** (rikuptuar nga `deo.onyx.beautified.js`).

---

## FAZA 2 — IMPORTE / EKSPORTE / EVENTE / HOOK-E / KLASA / FUNKSIONE

### Pikat globale të komunikimit (API surface) që lidhin modulet
| Simbol global | Burimi | Përdorimi |
|---|---|---|
| `window.multibox` | engine (ONYX/SENPA) | `.clients[]` — lista e lidhjeve; çdo `client` ka `clientID` |
| `window.__connNicks` | ONYX `index.html` | `[nick1, nick2]` — pseudonimet e dy lidhjeve |
| `window.OnyxReplay` | `savee.js` | `{ start, stop, save, clear }` |
| `localStorage 'tm_key'` | EON `key.js` | çelësi i licencës |
| `localStorage 'ZYNX:server'` | chat.js | serveri i zgjedhur |
| `postMessage` nga `https://delt.io` | EON index | mesazhe chat `DELTA_CHAT` |
| `wss://chat.delt.io/delta7` | chat.js | kanali i chat-it |

### Klasat/strukturat kyçe të motorit (nga `deo.onyx.beautified.js`)
- `myClientID`, `playersList: Map`, `cells: Map`
- `cellsIDTab1: Set`, `cellsIDTab2: Set` — qelizat e secilës lidhje
- `isAliveTab1`, `isAliveTab2` — gjendja gjallë/vdekur e secilës lidhje
- `parentClientID`, `parentClient`, `connectedTab2`, `handshakeDone2`, `isOwnTab`
- `saigoWS` — WebSocket i dytë "spy/spectate" për sinkronizim shtesë
- Metoda: `mouse(x, y, connId)`, `spawn()`, `multiboxTab()`, `split/feed/eject`

### Protokolli binar (nga `chat.js` — `Writer`/`Reader`)
- `Writer`: `writeUInt8/16/24/32`, `writeInt16/32`, `writeUTF16String[Zero|Length]`, `finalize()`
- `Reader`: `readUInt8/16/24/32`, `readInt16/32`, `readUTF16StringLength()`
- Little-endian; mesazhi i mouse-it: `writeUint8(5)` + `connId` + `float x` + `float y` + `uint32 seq`

---

## FAZA 3 — KODI KRITIK SIPAS SISTEMIT

### A. Motori + Menaxhimi i eventeve (ONYX bazë + EON EventEmitter)
- EON `bundle.js` përmban një `EventEmitter` standard (node-style: `on/emit/once/removeListener`).
  Ky është implementimi më i pastër i event-bus → e adoptojmë në unified si `EventBus`.
- Render loop & WASM bridge → mbeten te motori origjinal (pikë integrimi `@requires engine`).

### B. Chat-i (SENPA `chat.js` — më i miri)
- WebSocket `wss://chat.delt.io/delta7?protocol=v1`, reconnect me backoff eksponencial
  (`RECONNECT_BASE_MS`→`RECONNECT_MAX_MS`).
- `getFallbackClientId()`: zgjidh bug-un ku mesazhet dilnin para se `window.multibox.clients`
  të kishte një `clientID` (gjeneron ID stabël në `sessionStorage`).
- Anti-spam (`SPAM_MIN_MS`, `SPAM_BURST_MAX`, `SPAM_WINDOW_MS`), mute list, history, send-queue.
- EON ka një bridge alternativ (postMessage nga delt.io) — i dobishëm si fallback.

### C. Patch / Update (EON `update-notifier`)
- Modal "What's New" me `version`/`date`/`content`; shfaqet kur ndryshon versioni i ruajtur lokalisht.
- `key.js` = sistemi i hapjes: verifikon `tm_key` te Cloudflare Worker; vetëm pas OK ngarkon `bundle.js`.

### D. Multibox (shih Faza 3.1 — seksioni i dedikuar)

### E. Komunikimi me serverin
- WebSocket binar drejt `wss://<region>.senpa.io:2001` (p.sh. `eu.senpa.io:2001`).
- Çdo "tab" logjik = një lidhje WebSocket e veçantë nga e njëjta faqe.

---

## FAZA 3.1 — MULTIBOX (PRIORITET MAKSIMAL): ANALIZË E THELLË

### Si funksionon multibox-i në secilin projekt

**ONYX — single-page, dual-connection (dual-nick)**
- `index.html` shton një input të dytë "Cell 2 nickname"; ruan çiftin në
  `localStorage["cell2Nick:<nick1>"]` dhe vendos `window.__connNicks = [nick1, nick2]`.
- Motori (`senpaobs1.js`) hap **dy lidhje WebSocket** nga e njëjta faqe, një për çdo pseudonim.
- **Avantazh:** thjeshtësi, një faqe e vetme, zero sinkronizim ndër-tab.
- **Mangësi:** UI minimale, pa rregulla vizuale të pasura, e fshehur në obfuscated.

**SENPA — single-page, dual-connection me kontroll të plotë + spy WS** (implementimi më i plotë)
- Mban dy lidhje logjike: **Tab1** dhe **Tab2** (`isAliveTab1`, `isAliveTab2`,
  `cellsIDTab1`, `cellsIDTab2`).
- **Tab aktiv**: input-i (mouse/split/feed) shkon te lidhja aktive; `multiboxTab()` (hotkey)
  ndërron tab-in aktiv.
- **Mouse routing**: koordinatat shkruhen për lidhje specifike —
  `writeUint8(5); writeUint8(connId); writeFloat(x); writeFloat(y); writeUint32(seq)`
  (`mouse(x,y,connId)`). Mund të dërgohet te të dyja lidhjet njëkohësisht (auto-mode).
- **Camera centroid**: `x = (x1 + x2)/2` kur të dyja gjallë; përndryshe ndjek të gjallën
  (`this.x = isAliveTab1 && isAliveTab2 ? (x1+x2)/2 : isAliveTab1 ? x1 : x2`).
- **`saigoWS`**: një WebSocket i dytë "spy/spectate" që ndihmon të shihen/sinkronizohen qelizat
  e partnerit kur opsioni `spySaigo` është on.
- **Ndihma vizuale**: `multiboxRing` (basic/thin/thick/mish + width), `multiboxShield`,
  `multiboxCellColor`, ngjyra stroke për qelizën aktive/joaktive (`multiboxActive`/`multiboxInactive`).
- **Avantazh:** kontroll i plotë, ndarje e qartë e gjendjes, ndihma vizuale, centroid-camera,
  routing fleksibël te një/të dyja lidhjet.
- **Mangësi:** i obfuskuar, i ndërthurur fort me render-in, vështirë për mirëmbajtje.

**EON — UI/lobby më i pastër për multibox**
- Lobby me `Player 1`/`Player 2`, `Skin URL 1`/`Skin URL 2`, 10 profile (`data-profile`),
  `Set Primary`/`Set Secondary` për skin-e.
- Logjika e lidhjes në `bundle.js` (minified, standard webpack) → më e qartë se obfuscated.
- **Avantazh:** UX/struktura më e mirë, profile, dual-skin.
- **Mangësi:** detajet e sync brenda bundle minified.

### Rrjedha e plotë e të dhënave të multibox-it (data flow)
```
[Lobby UI]  Player1/Player2 + Skin1/Skin2 + Server
   │  (Play)
   ▼
[MultiboxController.connect()]  ── hap 2 WebSocket (conn0=Tab1, conn1=Tab2)
   │                               secili: handshake → spawn(nick_i, skin_i)
   ▼
[InputRouter]  mouse/keyboard ──► tab aktiv (ose të dyja në auto)
   │     mouse(x,y,connId)
   ▼
[Protocol.Writer]  opcode 5 + connId + x + y + seq ──► conn.send(bytes)
   ▲                                              │
   │                                              ▼
[Engine/WASM]  ◄── conn.onmessage (Reader) ── world state (cells, players)
   │  përditëson cellsIDTab1/Tab2, isAliveTab1/2
   ▼
[Camera] centroid (x1+x2)/2  ──►  [Renderer]  ──►  rings/shield/cellColor te qelizat e veta
```

### Si komunikojnë modulet me njëri-tjetrin
- `MultiboxController` mban `clients[]` dhe i ekspozon te `window.multibox` (që e lexon `ChatClient`).
- `InputRouter` → `MultiboxController.sendMouse/sendAction(connId)`.
- `EventBus` transmeton evente: `multibox:tab`, `client:alive`, `client:dead`, `reconnect`, `patch:show`.
- `ChatClient` lexon `window.multibox.clients[].clientID` për të zgjidhur ID-në e dërguesit.

---

## FAZA 4 — DIAGRAMI LOGJIK I ARKITEKTURËS (UNIFIED)

```
                         ┌──────────────────────────────────────────┐
                         │              EonBoot (HAPJA)               │
                         │  key-gating · anti-tracking · WASM load    │
                         └───────────────┬──────────────────────────-┘
                                         │ (verified)
        ┌────────────────────────────────┼───────────────────────────────-┐
        ▼                                ▼                                 ▼
┌───────────────┐               ┌──────────────────┐              ┌────────────────┐
│   EventBus    │◄──────────────│ MultiboxController│─────────────►│  Engine/WASM   │
│ (EON emitter) │   events      │  clients[] (2x)   │  send/recv   │  (@requires)   │
└──────┬────────┘               │  InputRouter      │              └───────┬────────┘
       │                        │  Camera centroid  │                      │ world state
       │                        │  Protocol Writer/R│◄─────────────────────┘
       │                        └─────────┬─────────┘
       │                                  │ window.multibox.clients
   ┌───┴───────────┬───────────┬──────────┴────────┬───────────────┬─────────────┐
   ▼               ▼           ▼                    ▼               ▼             ▼
┌────────┐   ┌──────────┐ ┌──────────┐      ┌─────────────┐  ┌──────────┐  ┌──────────┐
│ChatClnt│   │ Replay   │ │ Hotkeys  │      │ Settings +  │  │ Update   │  │  HUD +   │
│chat.js │   │savee.js  │ │ Manager  │      │ Profiles    │  │ Notifier │  │ Reconnect│
└────────┘   └──────────┘ └──────────┘      └─────────────┘  │ (patch)  │  └──────────┘
                                                             └──────────┘
```

---

## FAZA 5 — PLAN INTEGRIMI (cili implementim merret nga ku dhe PSE)

| Sistem | Marrë nga | Pse |
|---|---|---|
| Hapja / key-gating | **EON** `key.js` | I vetmi me verifikim licencë server-side; i pastër |
| Anti-tracking | **EON** `index.html` | Bllokon vpnapi/db-ip; mbron fetch/XHR/beacon |
| Event bus | **EON** `bundle.js` (EventEmitter) | API standard node-style, i provuar |
| Protokolli binar | **SENPA** `chat.js` (Writer/Reader) | I pastër, i plotë, little-endian, i testuar |
| **Multibox core** | **SENPA** `deo.onyx` (rikuptuar) + **ONYX** dual-nick + **EON** lobby | Kombinim: sync nga SENPA, thjeshtësia e dual-nick nga ONYX, UX nga EON |
| Chat | **SENPA** `chat.js` | Anti-spam, mute, history, send-queue, fallback clientId |
| Replay | **SENPA** `savee.js` | Ring-buffer webm me header-chunk fix |
| Patch/Update | **EON** update-notifier | Modal "What's New" me versionim |
| Settings/Profiles | **EON** | 10 profile, export/import/reset, dual-skin |
| Reconnect/HUD | **EON** | Overlay i pastër, CSS modulare |

---

## FAZA 7 — VERIFIKIMI (varësi, funksione të munguara, konflikte, leaks, race conditions, referenca të prishura)

### Referenca të prishura (broken refs) të gjetura
1. **EON `index.html:337`** → `<script src="./b"></script>` — referencë e prishur/e cunguar
   (ndoshta duhej `./bundle.js`). Bundle-i real ngarkohet nga `key.js` pas verifikimit, kështu që
   `./b` jep 404. **Rregullim:** hiqe ose korrigjoje në `./bundle.js`.
2. **EON loading order**: `wasmLoader.js` → `./b` (404) → `key.js` (ngarkon `bundle.js`) → `chat.js`.
   `chat.js` mund të niset para se `window.multibox.clients` të ekzistojë → trajtohet nga
   `getFallbackClientId()` (tashmë i adresuar te SENPA chat.js).
3. **EON `index.html:8`** → `favicon.png` referohet por nuk gjendet në zip (`assets/images/`).

### Race conditions
- **Chat para multibox-it**: chat.js dërgon para `clientID` → zgjidhur me send-queue + fallback id.
- **Handshake i Tab2**: `handshakeDone2`/`connectedTab2` duhet të jenë `true` para se të dërgohet
  `spawn` për lidhjen e dytë. Unified e bën `spawn` vetëm pas event-it `open`+handshake.
- **Reconnect i dyfishtë**: nëse të dyja lidhjet riprovojnë njëkohësisht → backoff i pavarur për çdo client.

### Memory leaks (potenciale)
- `setInterval(apply, 150)` te ONYX dual-nick inline → kurrë s'pastrohet. Unified përdor
  `MutationObserver` + cleanup.
- `MediaRecorder` te replay: `savee.js` e mban stream-in gjallë qëllimisht; unified shton `dispose()`.
- WebSocket listeners pa `removeEventListener` te reconnect → unified i heq para rilidhjes.

### Funksione të munguara / varësi
- Motori real (`spawn`, render, world-decode) është në WASM → unified e shënon si
  `@requires engine` dhe ofron adapter `EngineAdapter` me metoda që duhen lidhur.
- `chat.js` varet nga `window.multibox` → unified e siguron këtë kontratë.

### Konflikte
- Të tre përdorin emrin global `ONYX`/`window.multibox` → unified i konsolidon në një namespace
  të vetëm `window.ONYX` me nën-objekte (`ONYX.multibox`, `ONYX.chat`, `ONYX.replay`, ...).
- Hotkey-t mbivendosen (p.sh. `P` = replay te savee.js, por edhe veprime te SENPA) →
  `HotkeyManager` i centralizon dhe shmang dyfishimet.

---

## PËRMBLEDHJE
Skripti final `onyx-unified.js` është rishkrim i pastër i shtresës mod + kontrollerit të
multibox-it, që merr: **hapjen/patch/anti-track/HUD nga EON**, **chat/replay/protokoll/sync nga
SENPA**, dhe **modelin dual-connection nga ONYX**, me pika integrimi të dokumentuara për motorin
WASM. Shih `onyx-unified.js` dhe `README.md` për përdorim dhe lidhjen me motorin.
