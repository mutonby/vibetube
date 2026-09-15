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
- `electron/main.js` — proceso principal: ventanas, IPC (proyectos, clips por chunks, guiones),
  guardas de ruta (`guardPath`/`guardRoot`: el renderer solo toca carpetas raíz elegidas).
- `electron/agent.js` — `runAgentJob()`: spawn de `claude -p` headless, timeouts, kill de grupo,
  coste, registro de huérfanos, log en `edit/_agent.log`.
- `electron/prompts.js` — todos los prompts (compose/iterate/montageBrief + analyze/generate/
  rewrite/hooks de guiones). Funciones puras, testeadas.
- `electron/media-protocol.js` — `rsmedia://` con Range, restringido a raíces permitidas.
- `electron/settings.js` — ajustes durables en `userData/settings.json`.
- `electron/awake.js` — impide que el Mac apague la pantalla o se bloquee por inactividad
  mientras hay una sesión de grabación (`prevent-display-sleep`, se suelta al terminar o si la
  ventana se va).
- `electron/util.js` — helpers puros (stamp, slugify, parseRange, isUnder, writeJson atómico…).
- `electron/preload.js` — puente `contextBridge` (`window.studio.*`).
- `electron/{float,tp}-preload.js` — overlays flotantes (cámara flotante / teleprompter).
- `src/renderer.js` — núcleo UI (estado, navegación, proyectos, editor/feed, terminal);
  `src/recording.js` — fuentes/dispositivos/blur/crop/MediaRecorder por chunks;
  `src/scripts-view.js` — vista Guiones; `src/wire.js` — cableado (se carga el último).
- `src/campipe.js` — selección del motor de cámara: MatAnyone2 local en Apple Silicon, LiveKit en otros equipos.
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

## Cámara en crudo + recorte de fondo offline

El efecto en tiempo real usa MatAnyone2Kit en Apple Silicon cuando está instalado
con `npm run build:matting`; LiveKit 0.8.0 queda para los demás equipos.
`native/README.md` fija la revisión, compilación y licencias. El usuario aprobó la
variante con máscara inicial completa de Vision: se elimina el recorte rectangular
que cortaba brazos/pelo; no se cambian pesos ni memoria temporal. `src/campipe.js`
selecciona el motor; `matanyone-campipe.js` transporta y compone fotogramas.
No añadir filtros de pelo, silla o máscaras por color. Mantener imagen y alpha
del mismo fotograma y una sola inferencia pendiente.

Desde el 14/09/2026, `state.finalBackground` está activado por defecto en Apple
Silicon: captura original y procesado automático posterior mediante
`electron/camera-finalizer.js`. Pausar el modelo de previsualización durante
la toma y reanudarlo al parar para conservar la calibración entre clips. Mantener el original `camera-original.webm`, la calibración emparejada
`camera-seed.*` y el fondo elegido `camera-background.*`. El nativo usa `--fps 30`
para que el reloj de seguimiento sea el del vídeo. La cola valida fotogramas,
dimensiones y hash de audio antes de sustituir `webcam.webm`; no cambiar el offset.
La mejora de voz y el montaje deben esperar a que `camera_processing` esté `done`.
El usuario puede desactivar «Fondo al terminar» para grabar el efecto en directo.
«Guardar cámara original» (`state.rawRecord`) conserva el modo manual sin procesado
automático. El helper RVM descrito a continuación es una utilidad manual antigua,
no el motor del procesado automático actual.

`_scripts/rematte_cam.py` usa **RobustVideoMatting** (recurrente → coherencia temporal de serie;
medido: 22-44 fps en un M1 Pro, 0,28% de variación de área entre fotogramas). Dos modos:

- `--background auto` (por defecto) — material YA COMPUESTO (lo grabado antes de este cambio).
  Reconstruye la placa de fondo del propio vídeo (mediana temporal de los píxeles que la máscara
  da por fondo) y luego **identifica cuál de `src/backgrounds/*.jpg` se usó**, ajustando escala,
  desenfoque y ganancia por canal contra esa placa. Se acepta por MARGEN sobre la segunda
  candidata, no por umbral absoluto (medido: 7,6 frente a 14,9 → 1,95x). Hace falta porque la
  placa medida tiene huecos justo detrás del cuerpo (~21% de píxeles) y rellenarlos por
  inpainting inventa manchas.
- Clips con `cam.raw` — no adivina nada: compone sobre el fondo que anotó el grabador.

Trampas: el `webcam.webm` de MediaRecorder es **fuertemente VFR** (deltas de 0 a 156 ms, >50% de
los fotogramas fuera de ±5% de la mediana), así que se decodifica con `fps=N` a CFR de forma
consciente —igual que hace `render.py` al pasarlo a 24 fps— y **el audio se copia sin tocar**,
que es la única fuente de sonido del proyecto. El script verifica duración, audio y dimensiones
de cada salida y se niega a tocar `project.json` (`--apply`) si algún clip no pasa.

## Grabación y blur de fondo (`src/campipe.js`, `src/renderer.js`)

- La cámara usa `pickCameraMime`: H.264 + Opus, después VP8/VP9 según soporte.
  VP9 en directo perdió muchos fotogramas con imagen USB real a 1080p, aunque
  pasaban las pruebas sintéticas. Chromium genera Matroska para H.264 + Opus;
  se mantienen las rutas `.webm` y se detecta el contenido por su cabecera.
  La pantalla y el procesado final conservan VP9. Medir siempre los fotogramas
  del original: un archivo CFR a 30 FPS puede contener imágenes repetidas.
- **Blur de fondo**: MatAnyone2 conserva la memoria temporal; composición en canvas
  con el alpha del modelo. No hay una EMA manual ni filtros de contorno propios.
- **Slider de intensidad**: `#blurLevel` (0-100), persistido en `localStorage rs_blurlevel`,
  aplicado en vivo con `setBlurAmount()`.
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
- Ejecutar la app: `npm start` (Electron). `npm test` / `npm run check` antes de dar por bueno un cambio.
  Verificación de UI sin manos: `./node_modules/.bin/electron . --remote-debugging-port=9333` + driver CDP.
- Los proyectos pesados no se versionan. `test/project.json` es un fixture: no dejarlo modificado.
