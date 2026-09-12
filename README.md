# Record Studio

Grabador **multicam** de escritorio (macOS / Electron): captura tu **pantalla** y tu
**webcam + micro** sincronizadas, organizadas en **proyectos con varios clips**, y
entrega una carpeta lista para que la skill
[`video-use`](https://github.com/browser-use/video-use) componga el vídeo final con
**planos automáticos** (full-cam / pantalla / PiP) e intros/overlays de
[**HyperFrames**](https://github.com/heygen-com/hyperframes).

```
record-studio (graba N clips)  ──►  video-use (decide planos + corta + subtítulos + HyperFrames)  ──►  edit/final.mp4
```

## Requisitos

- Node.js 22+ y npm
- macOS (usa `desktopCapturer` de Electron + permiso de Grabación de pantalla)
- `ffmpeg` en el sistema (para los posters del histórico; Homebrew recomendado)
- Para montajes y guiones con IA: **Claude Code o Codex CLI**, instalado e identificado
  con tu cuenta. La app usa la configuración y autenticación de la CLI elegida.
- Para la edición posterior: la skill `video-use` con `ffmpeg` y `ELEVENLABS_API_KEY`.
- Para la mejora de voz con IA: **NVIDIA Studio Voice NIM** (`NVIDIA_API_KEY` o `NGC_API_KEY` en `~/.config/record-studio/.env`).

## Uso

```bash
npm install
npm start
```

### Elegir Claude Code o Codex

En la barra superior, **Agente → Codex** selecciona Codex para los próximos montajes,
iteraciones, análisis de estilo y guiones. La elección se guarda al cerrar la app;
Claude Code sigue siendo la opción inicial. Las tareas y terminales ya abiertas
continúan con el agente con el que arrancaron.

Para usar Codex, instala su CLI si hace falta e inicia sesión desde una terminal:

```bash
npm install -g @openai/codex
codex login
```

La edición automática usa `codex exec --json` y la terminal integrada abre Codex
interactivo. Ambos usan `workspace-write` con red habilitada para investigación y
descargas; las tareas automáticas no solicitan aprobaciones y la terminal permite
aprobar acciones. El modelo se hereda de tu configuración de Codex. Consulta el
[modo no interactivo de Codex](https://learn.chatgpt.com/docs/non-interactive-mode).

Cada proyecto conserva una conversación por proveedor: al cambiar a Codex se crea
su propia conversación y puedes volver después a la de Claude. La terminal interactiva
continúa la última sesión del proveedor en esa carpeta. El brief de montaje se escribe
en `AGENTS.md` para Codex y en `CLAUDE.md` para Claude, preservando las instrucciones
existentes. Ambos reciben la ruta de la skill `video-use` incluida en esta app.

### Pestaña «Proyectos»
1. Elige la **carpeta raíz** donde vivirán todos los proyectos.
2. Escribe un nombre y **＋ Crear** un proyecto (se vuelve el proyecto activo).
3. El histórico muestra cada proyecto: nº de clips, duración, fecha, y su **edición
   final** (póster + ▶ para abrirla) si existe `edit/final.mp4`.

### Pestaña «Grabar»
1. **Elige** la pantalla o ventana (miniaturas en vivo).
2. Comprueba los **previews** de pantalla y webcam.
3. **● Grabar** → cuenta atrás **3·2·1** → habla/demuestra.
   - **⏸ Pausar / ▶ Seguir** dentro del mismo clip.
   - **■ Parar** finaliza el clip y lo añade al proyecto.
4. Repite: cada Grabar→Parar añade `clip_02`, `clip_03`… **al mismo proyecto**.

## Estructura de un proyecto

```
<raíz>/<proyecto>/
├── project.json                 ← metadatos + lista de clips
├── clips/
│   ├── clip_01/ screen.webm  webcam.webm  webcam_orig.webm  webcam_enhanced.wav  sync.json
│   ├── clip_02/ ...
│   └── ...
└── edit/                        ← lo escribe video-use (final.mp4, _poster.jpg)
    └── final.mp4
```

| Archivo | Qué es |
|---|---|
| `screen.webm` | captura de pantalla (sin audio) |
| `webcam.webm` | tu cámara **+ micro** (remuxada con audio de estudio si Studio Voice está activo) |
| `webcam_orig.webm` | copia de seguridad del audio/vídeo de cámara original sin procesar |
| `webcam_enhanced.wav` | pista de voz limpia a 48kHz generada con NVIDIA Studio Voice NIM |
| `sync.json` | offset entre pistas, duración, dimensiones reales y estado de mejora |
| `project.json` | nombre, fechas, y todos los clips con sus metadatos |

> **Permisos macOS:** la primera vez concede *Grabación de pantalla*, *Cámara* y
> *Micrófono* a la app (o a Electron en modo dev) en Ajustes → Privacidad y seguridad,
> y relanza. Si el preview de pantalla sale negro, es el permiso.

## Handoff a video-use

Abre la carpeta del proyecto con la skill `video-use` y pídele:

> "Edita esta grabación multicam: alterna entre mi cámara y la pantalla según lo que
> digo, PiP cuando explico sobre la demo, intro con HyperFrames y subtítulos."

El audio continuo sale siempre de `webcam.webm`; solo cambia el plano de vídeo.
Los detalles del contrato (mapear varios clips, formato del EDL multicam) están en
[`HANDOFF.md`](./HANDOFF.md).

## Mejora de voz con IA (NVIDIA Studio Voice NIM)

Record Studio integra **NVIDIA Studio Voice NIM (`48k-hq`)** vía gRPC para transformar automáticamente el audio del micrófono en voz con calidad de estudio profesional: suprime el eco de la habitación, ruidos de fondo, teclados y climatización, optimizando la presencia y claridad de la voz a 48 kHz.

### Modos de uso:
1. **Auto-mejora al grabar (segundo plano):** Tras parar una toma y validarse el clip, la app procesa el audio automáticamente. Se preserva una copia de seguridad (`webcam_orig.webm`) y se remuxa el audio limpio en `webcam.webm` sin re-codificar el vídeo.
2. **Bajo demanda en la interfaz (UI):**
   - **Por clip:** Botón ✨ en cada tarjeta de clip para procesar o re-procesar. Muestra el chip `✨ mejorando voz…` durante el cálculo y `✨ Studio Voice` al finalizar.
   - **Proyecto completo:** Botón **`Mejorar audio (IA)`** en la cabecera de la lista de clips para procesar todos los clips del proyecto a la vez.
   - **Barra de montaje:** Switch **`Voz de estudio (NVIDIA)`** (activo por defecto).
3. **Uso manual por CLI:**
   ```bash
   # Mejorar un clip específico:
   python video-use/helpers/enhance_voice.py --clip clips/clip_01

   # Mejorar todos los clips del proyecto actual:
   python video-use/helpers/enhance_voice.py --all

   # Mejorar un archivo suelto de audio o vídeo:
   python video-use/helpers/enhance_voice.py --input <archivo> --output <archivo_mejorado.wav>
   ```
   *Nota: El helper gestiona automáticamente la fragmentación con crossfade suave para tomas largas que superen los 4.5 minutos, respetando los límites de la API.*
4. **Transcripción Whisper optimizada:** `helpers/transcribe_whisper.py` prioriza transcribir desde `webcam_enhanced.wav` si existe, logrando mayor precisión léxica y timestamps más exactos para subtítulos y SFX.
5. **Configuración de clave API:** Guarda tu clave en `~/.config/record-studio/.env`:
   ```env
   NVIDIA_API_KEY=nvapi-...
   ```
   Si no se detecta clave o se está sin conexión, la app omite la mejora sin interrumpir la grabación ni el montaje.



## Guiones (pestaña «Guiones»)

1. **Mi estilo**: pega tu canal → el agente elegido (headless) baja ~15 transcripciones largas con
   `yt-dlp` y escribe `_scripts/style_profile.md` + `_scripts/pace.json` (palabras/min reales).
   «Actualizar» solo añade los vídeos nuevos al corpus.
2. **Nuevo guion**: tema (puede ser una URL) + brief (duración, formato, tipo, demo, CTA, evitar,
   puntos clave). El agente investiga en la web, escribe en tu voz con un objetivo de
   palabras calculado a tu ritmo, propone **3 ganchos** y deja las **fuentes** en
   `drafts/<id>.sources.md` para que compruebes las cifras.
3. **Guion**: editar, «Ganchos» (5 alternativas), «Reescribir» (guarda versión previa en
   `drafts/versions/`), «Grabar con este guion» → crea el proyecto con `script.md` y guarda el
   par borrador→final en `_scripts/feedback/`, que el agente usa en los siguientes guiones para
   aprender cómo corriges.

## Robustez de grabación

- El fondo usa **MatAnyone2Kit** en Apple Silicon cuando se ha ejecutado
  `npm run build:matting`. Conserva memoria entre fotogramas y usa la máscara
  completa de persona de Vision para inicializarse. Los demás equipos usan
  LiveKit Track Processors 0.8.0. No hay filtros propios de pelo o silla.
  La cámara, su grabación y la barra flotante comparten el resultado procesado.
  Los modelos se ejecutan localmente, sin cuenta ni envío de vídeo.
  La cámara original y su audio no se
  detienen al cerrar el efecto. Los errores del efecto se comunican; no se
  cambia silenciosamente a otro motor.
  El respaldo se conserva en las muestras probadas, pero no se garantiza para
  cualquier silla o iluminación. Siguen siendo posibles errores de recorte.
  Por defecto se graba la cámara procesada de la previsualización.
  «Guardar cámara original» permite conservar la habitación para aplicar el
  fondo después durante el montaje.
- **Calibrar persona y silla** permite señalar el torso y el respaldo en una
  imagen fija. Con EdgeSAM instalado, esa selección inicializa MatAnyone2 para
  conservar ambos. La cámara sigue visible mientras se calcula; cancelar no
  altera el recorte actual. Si sales y vuelves, se avisa para repetir la selección.
  Instalación de los modelos y pruebas: [native/README.md](native/README.md).
- Los chunks del MediaRecorder se escriben a disco cada ~1 s (`clips/clip_NN/*.part.webm`).
  Si la app muere grabando, el proyecto muestra la toma sin cerrar y permite **recuperarla**.
- Al guardar, `ffprobe` mide la duración real de cada pista y marca el clip `truncated`/`empty`
  si no coincide con lo esperado (chip rojo en la tarjeta). Un watchdog avisa en la barra
  flotante si un grabador deja de entregar datos >3 s.
- Aviso de espacio en disco (<2 GB) antes de grabar; confirmación al cerrar en mitad de una toma.
- Atajos: `⌘R` grabar/parar (vista Grabar), `⌘⇧P` pausar, `Esc` cerrar modales; durante la toma
  `⌘⇧1` pausa, `⌘⇧2` termina clip, `⌘⇧3` descarta y regraba.

## Agente headless

- Timeout de inactividad (15 min sin eventos) y tope de 3 h; cancelar mata el grupo de procesos
  (ffmpeg/python incluidos). Las ejecuciones se guardan en `project.json.agentRuns`
  con el proveedor, duración y métricas disponibles: coste/turnos para Claude y tokens
  para Codex (su CLI no comunica un coste en dólares). Log completo en `edit/_agent.log`
  (⋯ → «Ver log completo»).
- Los agentes huérfanos de una ejecución anterior se matan al arrancar (`userData/agents.json`).
- El modelo se hereda de la configuración de la CLI elegida (`~/.claude/settings.json`
  o `$CODEX_HOME/config.toml`, normalmente `~/.codex/config.toml`); no se fija con `--model`.
- La API key de HeyGen se lee de `~/.config/record-studio/.env` o, si no existe, del `.env` de avatar-muton.

## Desarrollo

```bash
npm run check   # node --check de todos los ficheros
npm test        # node:test (util, prompts, agent events, rsmedia)
npm run test:camera # efectos, cambio de fondo y recorte en Electron, sin cámara real
npm run build:camera # empaqueta LiveKit intacto y copia su WASM local
npm run build:matting # instala MatAnyone2 local para Apple Silicon (Swift/Core ML)
# Reprocesar una grabación local; no abre cámara ni micrófono:
./node_modules/.bin/electron test/manual/camera-replay.cjs muestra.webm /tmp/camera-check
# Probar desenfoque en vez de sustituir el fondo:
./node_modules/.bin/electron test/manual/camera-replay.cjs muestra.webm /tmp/camera-blur blur
```
MatAnyone2 requiere compilar Swift/Core ML una vez. Revisión, corrección de
inicialización y licencias del código y modelos: [native](native/README.md).
Alternativa para otros equipos: [LiveKit](src/vendor/livekit/README.md).
Ajustes de la app en `~/Library/Application Support/record-studio/settings.json`.
