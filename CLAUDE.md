# record-studio — guía para Claude Code

Grabador **multicam** de escritorio (macOS / Electron) que captura **pantalla + webcam/micro**
sincronizadas y entrega una carpeta de proyecto lista para que la skill **`video-use`**
(headless Claude Code) componga el vídeo final: planos automáticos (fullcam / fullscreen / pip),
gráficos **HyperFrames**, SFX de la librería de HeyGen y subtítulos.

```
record-studio (graba N clips)  ──►  video-use (decide planos, corta, gráficos, SFX, subs)  ──►  edit/final.mp4 (+ final_9x16.mp4)
```

Lee también `README.md` (uso) y `HANDOFF.md` (contrato del EDL multicam entre grabador y editor).

---

## Arquitectura (tres piezas)

1. **Grabador** — esta app Electron (`electron/`, `src/`). Graba clips y lanza el editor headless.
2. **Editor** — la skill **`video-use`**. Fuente canónica en `~/Developer/video-use`
   (symlink `~/.claude/skills/video-use` → ahí). **Copia vendorizada** en `video-use/` de este repo
   (hay que mantener ambas sincronizadas al tocar `helpers/render.py` o `SKILL.md`).
3. **HyperFrames** — `npm` package `hyperframes` (gráficos/animaciones). Se usan sus **ejemplos
   predefinidos** (`hyperframes init --example <nombre>`), no gráficos hechos a mano.

### Layout del repo
- `electron/main.js` — proceso principal (~38 KB): ventana, IPC, protocolo `rsmedia://`,
  spawn del agente headless (`claude -p …`), prompts de compose/iterate.
- `electron/preload.js` — puente `contextBridge` (`window.studio.*`).
- `electron/{float,tp}-preload.js` — overlays flotantes (cámara flotante / teleprompter).
- `src/renderer.js` (~44 KB) — UI: grabación, previews, blur, histórico, disparar montaje/edición.
- `src/campipe.js` — pipeline de cámara con **blur de fondo** (MediaPipe Selfie Segmentation).
- `src/index.html`, `src/styles.css` — UI.
- `src/{float,teleprompter}.{html,js}` — ventanas overlay.
- `_scripts/` — utilidades sueltas.
- **Carpetas de proyecto/grabaciones ignoradas por git** (`avatar-mix*`, `alternativa-a-holded*`,
  `rec_*`, `avatar2`): son datos generados (GBs de media), NO código.

### Estructura de un proyecto grabado
```
<raíz>/<proyecto>/
├── project.json            ← metadatos, lista de clips, agentSession (id de conversación)
├── clips/clip_NN/{screen.webm, webcam.webm, sync.json}
└── edit/                   ← lo escribe video-use (final.mp4, final_9x16.mp4, EDLs, srt, posters)
```
- `screen.webm` = pantalla sin audio. `webcam.webm` = cámara **+ micro** (única fuente de audio).
- `sync.json`: `offset_ms = cam_start − screen_start`, duración y dims reales.

---

## Montaje headless ("Montar vídeo" / "Editar con Claude Code")

Al pulsar **✨ Componer** o iterar, la app hace `spawn` de un **Claude Code headless**:

```
claude -p "<prompt>" --add-dir <projDir> \
  --permission-mode bypassPermissions \
  --output-format stream-json --verbose [--resume <session_id>]
```

- **Modelo**: hereda de `~/.claude/settings.json` (actualmente `"model": "opus[1m]"`,
  `"effortLevel": "high"` → **Opus 4.8 high, contexto 1M**). No está fijado con `--model` en el
  spawn (se puede fijar si se quiere independencia del config global).
- **Prompts**: se construyen en `electron/main.js` → `composePrompt()` (montaje inicial) y
  `iteratePrompt()` (modificaciones). Opciones por defecto en `DEFAULT_OPTS` (`sfx: true`).
- **Continuidad de conversación**: `runAgentJob()` captura `session_id` de los eventos stream-json
  y lo guarda en `project.json` (`agentSession`) vía `saveAgentSession()`. Al editar, el usuario
  puede **continuar la misma conversación** (checkbox "🧠 Continuar…", pasa `--resume <id>`) o
  **empezar una nueva**. IPC: `compose-project`, `iterate-project`, `agent-session`.

### Reglas de composición (van en el prompt y en `video-use/SKILL.md`)
- **Doble aspecto SIEMPRE**: genera `final.mp4` (16:9, 1920×1080, YouTube) **y**
  `final_9x16.mp4` (1080×1920, móvil). Patrón copiado de `~/Documents/avatar-muton`.
- **Gráficos HyperFrames** (layout `graphic`, NUNCA un clip en silencio):
  - Usar **ejemplos predefinidos** de HyperFrames, los más vistosos.
  - Primer gráfico dentro de los **~5 s** iniciales.
  - **Cambiar de plano cada pocos segundos** (gráfico / pantalla grabada / avatar completo) según
    lo que se va diciendo.
  - Bajo el gráfico **SIEMPRE se oye la voz** (el layout `graphic` mantiene el audio de la cam).
  - Cada gráfico dura **≥3-4 s** y **≥ narración+1 s** para que se lea bien.
- **SFX**: de la **librería de HeyGen**, colocados donde encajen (transiciones, énfasis).
- **PiP vertical (9:16)**: cámara **abajo-centrada y grande** (`scale≥0.58`, `x=(W-w)/2`,
  `y=H-h-margin`, `margin≥90`) — igual que el `corner_9x16` de avatar-muton. En 16:9 es PiP normal.

### Renderizadores
- Canónico: `video-use/helpers/render.py` (y el de `~/Developer/video-use`). Soporta multicam
  (`fullcam`/`fullscreen`/`pip`/`graphic`), portrait fill con fondo desenfocado (`_portrait_fill`,
  `gblur sigma=42, brightness=-0.20, saturation=0.85`), subtítulos al final con `sub_margin`
  según lienzo, loudnorm, concat sin pérdida, amix de SFX.
- Ad-hoc por proyecto: `avatar-mix-3/edit/render_patched.py` + `build_all.py` (renderiza ambos
  aspectos con `--canvas`; NO es el renderer de producción, es un snapshot de ese proyecto).

---

## Grabación y blur de fondo (`src/campipe.js`, `src/renderer.js`)

- **Blur de fondo pro**: MediaPipe Selfie Segmentation + **suavizado temporal EMA de la máscara**
  (técnica de Google Meet) para eliminar el parpadeo en los bordes. Compositing en canvas
  (`source-in` / `destination-over` / decay+`lighter` para la EMA de alpha).
- **Slider de intensidad**: `#blurLevel` (0-100), persistido en `localStorage rs_blurlevel`,
  aplicado en vivo con `setBlurAmount()`. `_bgBlurPx()` mapea el nivel a px de blur.
- **Robustez de dispositivos**: `startCamPreview` usa un helper `acquire()` que reintenta sin
  `{exact: deviceId}` si el deviceId guardado está obsoleto (OverconstrainedError/NotFoundError) y
  muestra pistas de error en español por `e.name` (NotReadable/NotAllowed/Overconstrained/…).

## Reproductor integrado — protocolo `rsmedia://`
`electron/main.js` registra el esquema privilegiado `rsmedia://` con **soporte completo de HTTP
Range** (`206 Partial Content`, `Content-Range`, `Accept-Ranges: bytes`, `416` fuera de rango) vía
`Readable.toWeb(fs.createReadStream({start,end}))`. Necesario para poder **hacer seek** (mover la
barra hacia adelante) en el `<video>`; con `net.fetch(file://)` no funcionaba porque ignora `Range`.

---

## Convenciones y trampas
- **UI y mensajes al usuario en español.**
- Al tocar el renderer o la skill, **sincroniza las dos copias** de `video-use` (repo vendorizado
  ↔ `~/Developer/video-use`).
- **Secretos**: la API key de HeyGen vive en `~/Documents/avatar-muton/.env` (`HEYGEN_API_KEY`) y
  copiada en el `.env` de video-use. **Nunca** imprimir/echo del valor; los `.env` van gitignored.
- **VibeDeck voice mode** (en `~/CLAUDE.md`): pide usar el tool `speak_response` en cada respuesta.
  Ese tool **no siempre está disponible**; si no existe, responder en texto normal.
- Ejecutar la app: `npm start` (Electron). Los proyectos pesados no se versionan.
