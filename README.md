# ONYX UNIFIED

Klient i unifikuar për `senpa.io`, i ndërtuar duke marrë implementimet më të mira nga tre
projektet: **EON** (Eon404), **ONYX** (onlyforJasmina) dhe **SENPA** (vetempermua).

- `onyx-unified.js` — skripti final i unifikuar (shtresa mod + kontrolleri i multibox-it).
- `ANALYSIS.md` — analiza e plotë (harta, modulet, multibox deep-dive, krahasim, diagram,
  data-flow, plani i integrimit, verifikimi: leaks/race/broken-refs).

## Çfarë merr nga ku
| Sistem | Burimi | Modul në `onyx-unified.js` |
|---|---|---|
| Hapja / key-gating | EON `key.js` | `verifyLicense`, `boot()` |
| Anti-tracking | EON `index.html` | `installAntiTracking()` |
| Event bus | EON `bundle.js` | `EventBus` |
| Protokoll binar | SENPA `chat.js` | `Writer` / `Reader` |
| **Multibox core** | SENPA + ONYX + EON | `MultiboxController`, `MultiboxClient`, `InputRouter` |
| Chat | SENPA `chat.js` | `ChatClient` |
| Replay | SENPA `savee.js` | `ReplayRecorder` |
| Patch / update | EON update-notifier | `UpdateNotifier` |
| Settings / profiles | EON | `SettingsStore`, `ProfileManager` |
| Hotkeys | të treja | `HotkeyManager` |

## Si funksionon multibox-i (përmbledhje)
Një faqe e vetme mban **N lidhje WebSocket** (Tab1, Tab2). Çdo lidhje ka `clientID`, qelizat e
veta dhe gjendje `alive`. Input-i shkon te **tab-i aktiv** (ose te të dyja në auto-mode);
`switchTab()` (hotkey `Tab`) ndërron tab-in. Mouse-i dërgohet per-lidhje me opcode `5`
(`connId + x + y + seq`). Kamera ndjek **centroid-in** e qelizave të gjalla. Shih ANALYSIS.md §3.1.

## Integrimi (loading order i sugjeruar në index.html)
```html
<script src="./onyx-unified.js"></script>
<script>
  ONYX.boot({
    // skipLicense: true,        // vetëm për dev/test pa server licence
    wasmUrl: './bundle.wasm',    // motori real (@requires engine)
  }).then(api => {
    // lidh UI -> api.play() kur shtypet "Play"
    document.querySelector('.btn-play')?.addEventListener('click', () => api.play());
  });
</script>
```

### Pikat e integrimit me motorin (`@requires engine`)
Motori i lojës (vendim-marrja, dekodimi i botës, render) është në WASM dhe **nuk** përfshihet
këtu. Lidhe atë te `EngineAdapter`:
- `loadWasm(url)` → ngarko & instanco WASM (përdor `wasmLoader.js` real të EON).
- `decodeWorld(reader)` → dekodo paketat e botës nga `bus.on('client:packet', ...)`.
- `renderFrame()` → vizato qelizat + unazat/mburojën e multibox-it.

Të gjitha modulet e tjera (boot, anti-track, chat, replay, settings, update-notifier, hotkeys)
janë **plotësisht funksionale** pa motorin.

## API publike (`window.ONYX` pas boot)
```js
const api = await ONYX.boot();
api.play(profile?)   // hap lidhjet multibox + chat + input + replay
api.stop()           // mbyll gjithçka (cleanup pa leaks)
api.multibox         // MultiboxController (clients[], switchTab, routeMouse, ...)
api.chat             // ChatClient
api.replay           // ReplayRecorder (P = ruaj 15s e fundit)
api.settings         // SettingsStore (export/import/reset)
api.profiles         // ProfileManager (10 profile)
window.multibox      // alias për pajtueshmëri me chat.js origjinal
window.OnyxReplay    // alias për replay-n
```

## Rregullime të aplikuara (nga FAZA 7 e ANALYSIS.md)
- **Broken ref**: EON `index.html` ngarkonte `./b` (404) — këtu loading-u është i konsoliduar.
- **Race condition**: `spawn` bëhet vetëm pas handshake; chat ka send-queue + fallback clientId.
- **Memory leaks**: `removeEventListener` para reconnect; `ReplayRecorder.dispose()`; pa
  `setInterval` të pa-pastruar.
- **Konflikte globale**: gjithçka nën një namespace `window.ONYX`.

## Testim i shpejtë (logjika e pastër, pa browser)
```bash
node --check onyx-unified.js     # syntax
```
EventBus, Writer/Reader (roundtrip), camera centroid dhe switchTab janë testuar dhe kalojnë.

## Shënim
Të tre projektet origjinale janë build artifacts (minified/obfuscated + WASM). Logjika e thellë
e motorit nuk mund të kopjohej fjalë-për-fjalë; këtu është rishkruar pastër shtresa mod +
sinkronizimi i multibox-it (i rikuptuar nga `deo.onyx.beautified.js` dhe `chat.js`), me pika
integrimi të qarta për motorin WASM.
