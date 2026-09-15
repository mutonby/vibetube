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

1. **Elige** la pantalla o ventana. Las fuentes se agrupan por tipo y muestran su
   nombre; la seleccionada queda señalada. **Actualizar** vuelve a cargar la lista
   y sus miniaturas. La previsualización grande muestra la captura activa.
2. Comprueba los **previews** de pantalla y webcam.
3. **● Grabar** → cuenta atrás **3·2·1** → habla/demuestra.
   - **⏸ Pausar / ▶ Seguir** dentro del mismo clip.
   - **■ Parar** finaliza el clip y lo añade al proyecto.
4. Repite: cada Grabar→Parar añade `clip_02`, `clip_03`… **al mismo proyecto**.

### Enseñar la propia app mientras grabas

Activa **Mantener interfaz visible al grabar**, junto al botón Grabar. La opción
se guarda entre sesiones: la ventana principal permanece abierta y capturable,
y los controles pequeños aparecen igualmente. Desactivada, la ventana principal
se oculta durante la toma. Selecciona la pantalla o la ventana de Record Studio
como fuente para incluir la interfaz en el vídeo.

Puedes salir del proyecto, abrir **Proyectos**, **Guiones** u otro proyecto sin
interrumpir la toma. El grabador conserva el proyecto donde empezaste la sesión,
independientemente de la pantalla de la app que estés mostrando. Su nombre se
muestra en los controles pequeños.

- **⏸ / ▶** pausa y reanuda la toma.
- **■** guarda el clip y deja el grabador pequeño preparado para otro.
- **●** inicia otro clip en el proyecto original, aunque estés viendo otro proyecto.
- **↺** descarta la toma actual y vuelve a grabar en ese mismo proyecto.
- **✓** termina la sesión del grabador.

La cámara y el micrófono permanecen disponibles también entre clips mientras
esa sesión siga abierta. La navegación no cambia el destino del guardado, ni
siquiera si se usa el guardado en memoria como alternativa al streaming a disco.
El proyecto de la sesión no se puede borrar hasta terminarla. Durante la cuenta
atrás y el guardado se bloquean arranques duplicados.

### Teleprompter

El teleprompter se abre en una ventana independiente que queda fuera de la
captura. Puedes cargar un guion, editarlo y reiniciar su lectura. Se corrigió el
desplazamiento que ocultaba las primeras líneas al reducir la altura de la ventana:
reiniciar o cargar texto vuelve al principio tanto del texto como del contenedor.
Se conservan los saltos de línea originales del guion.

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
> y relanza. Si la previsualización de pantalla sale negra, comprueba ese permiso
> y que la fuente seleccionada siga disponible.

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

- **Cámara Full HD:** se solicita 1920×1080 a 30 FPS sin escalado artificial del
  navegador. Se muestra la resolución real que acepta el dispositivo y, si hay
  recorte, la resolución del archivo resultante. Para conservar los 1920×1080
  completos, desactiva «Recortar cámara». Las cámaras con menos resolución
  conservan la que puedan entregar; el fondo con IA puede reducir los FPS.
- **Compresión de cámara:** el presupuesto de VP9 se adapta a los píxeles grabados,
  con unos 16,6 Mb/s para Full HD (antes se pedían 4 Mb/s para cualquier tamaño).
  El bitrate real depende del contenido y del codificador. El recorte declara
  desde el inicio las dimensiones pares que realmente se codifican.
- **Contorno del fondo:** Core Image refina el alpha de MatAnyone2 mediante
  `CIGuidedFilter`, usando el mismo fotograma de cámara como guía a un máximo
  de 960×540. Esto reduce los escalones al ampliar la máscara original de
  288×512. El RGB de la persona conserva la resolución de captura. No se
  añaden reglas de pelo/silla ni se altera la memoria temporal del modelo.

- El fondo usa **MatAnyone2Kit** en Apple Silicon cuando se ha ejecutado
  `npm run build:matting`. Conserva memoria entre fotogramas y usa la máscara
  completa de persona de Vision para inicializarse. Los demás equipos usan
  LiveKit Track Processors 0.8.0. No hay filtros propios de pelo o silla.
  En el modo de fondo en directo, cámara, grabación y barra flotante comparten
  el resultado procesado.
  Los modelos se ejecutan localmente, sin cuenta ni envío de vídeo.
  La cámara original y su audio no se
  detienen al cerrar el efecto. Los errores del efecto se comunican; no se
  cambia silenciosamente a otro motor.
  El respaldo se conserva en las muestras probadas, pero no se garantiza para
  cualquier silla o iluminación. Siguen siendo posibles errores de recorte.
  En Apple Silicon, **«Fondo al terminar (máxima fluidez)» está activado por
  defecto**: se graba la cámara original y se aplica MatAnyone2 automáticamente
  después. Al desactivarlo se graba el efecto en directo. «Guardar cámara
  original» sigue disponible para dejar el fondo al montaje manual.
- **Calibrar persona y silla** permite señalar el torso y el respaldo en una
  imagen fija. Con EdgeSAM instalado, esa selección inicializa MatAnyone2 para
  conservar ambos. La cámara sigue visible mientras se calcula; cancelar no
  altera el recorte actual. Si sales y vuelves, se avisa para repetir la selección.
  Instalación de los modelos y pruebas: [native/README.md](native/README.md).
- **Recalibrar fondo** reinicia el seguimiento con la cámara actual y mantiene la
  imagen anterior hasta que el nuevo resultado esté listo. Al salir del encuadre
  y volver, el seguimiento se recupera; puede ser necesario volver a señalar la
  silla. La calibración se bloquea durante una toma.
- **Recorte de cámara:** se materializan los píxeles recortados antes de enviarlos
  al codificador. Esto corrige los clips VP9 negros que producía el recorte de una
  textura RGBA mediante `visibleRect`. El recorte funciona también con la ventana
  oculta y al detenerlo se conserva el track de cámara original. Los archivos ya
  grabados con fotogramas negros no recuperan su imagen con esta corrección.
- **Sincronización de audio:** al grabar la cámara procesada con MatAnyone2, se
  compensa el micrófono o la mezcla con sonido del sistema según la latencia
  medida del vídeo. El retardo se prepara antes de iniciar los grabadores y se
  libera al terminar. El offset frente a la pantalla descuenta ese retardo.
  La cámara original se graba sin esta compensación.
- **Fluidez:** se conserva solo el fotograma pendiente más reciente, manteniendo
  siempre juntos su imagen y su máscara. El transporte evita copias adicionales
  del puente de Electron y el lector nativo reduce las copias de datos. Se
  conservan el modelo y la resolución de salida. La captura de cámara prioriza
  H.264 + Opus, con VP8 y VP9 como alternativas; el fondo final se codifica en
  VP9 después de grabar. Las cámaras
  NV12 mantienen su formato nativo hasta Core Image para reducir las conversiones
  y las copias de píxeles a 1080p; se respeta su rango y matriz de color.
- Los chunks del MediaRecorder se escriben a disco cada ~1 s (`clips/clip_NN/*.part.webm`).
  Si la app muere grabando, el proyecto muestra la toma sin cerrar y permite **recuperarla**.
- Al guardar, `ffprobe` mide la duración real de cada pista y marca el clip `truncated`/`empty`
  si no coincide con lo esperado (chip rojo en la tarjeta). Un watchdog avisa en la barra
  flotante si un grabador deja de entregar datos >3 s.
- Aviso de espacio en disco (<2 GB) antes de grabar; confirmación al cerrar en mitad de una toma.
- Atajos: `⌘R` grabar/parar (vista Grabar), `⌘⇧P` pausar, `Esc` cerrar modales; durante la toma
  `⌘⇧1` pausa, `⌘⇧2` termina clip, `⌘⇧3` descarta y regraba.

### Rendimiento medido y trabajo pendiente

Validación del **13 de septiembre de 2026**: la cámara USB entrega 1920×1080 a
30 FPS. La prueba de codificación con imagen sintética Full HD conserva 90
fotogramas en tres segundos, tanto sin recortar como con recorte de 1388×952;
se comprueban píxeles decodificados para detectar salidas negras. Es una prueba
sin IA, no una medición de 30 FPS con MatAnyone2. La prueba de sincronización
sigue pasando (unos 40 ms de desfase medio con procesamiento simulado y la
cámara de la app activa). La composición Full HD con MatAnyone2 y VP9 quedó en
unos **10 FPS** y no supera el umbral de 12 FPS de la regresión manual. No se
considera resuelta la fluidez del fondo en directo. Resultados y muestras:
[`recordings/camera-quality-20260913/`](recordings/camera-quality-20260913/).


En las pruebas locales del **11 de septiembre de 2026**, con el M1 Pro de
desarrollo, la previsualización pasó de unos **15 a 18 FPS**. La prueba con cámara,
pantalla y controles flotantes simultáneos quedó en unos **13 FPS**; el clip de
referencia anterior tenía unos **11 FPS**. MatAnyone2 todavía no alcanza 30 FPS
en esa configuración. Las pruebas con VP8 y H.264 no justificaron cambiar el códec.

La prueba sintética de destellos y tonos, con 90 ms de procesamiento simulado,
pasó de unos **124 ms de desfase medio a unos 9 ms en valor absoluto** con la
compensación. Esto comprueba el archivo codificado; no mide el desfase físico de
cualquier combinación de cámara USB y micrófono. Las muestras y métricas están en
[`recordings/camera-sync-20260911/`](recordings/camera-sync-20260911/).

Desde el **14 de septiembre de 2026**, el fondo se aplica automáticamente al
terminar por defecto en Apple Silicon. La cámara se captura directamente a
1080p; el modelo de la previsualización se pausa durante la toma y la vista
muestra la imagen original. El original, el fondo elegido y la calibración
(imagen y alpha del mismo fotograma) quedan guardados junto al clip.

La cola procesa todos los fotogramas a una línea de tiempo de 30 FPS, aunque
calcularlos tarde más. El seguimiento usa el tiempo del vídeo, no el tiempo de
procesado. Los trabajos ceden el paso al empezar otra grabación. Puedes seguir
usando la interfaz y el grabador flotante; el clip muestra «Preparando fondo»
hasta que se hayan verificado dimensiones, número de fotogramas y audio. El
audio se copia sin recodificar y se comprueba su hash antes de sustituir el vídeo.
La mejora de voz y el montaje esperan a que el fondo termine.

Una comprobación posterior del 14 de septiembre con imagen real de la USB
detectó que VP9 en directo guardaba solo 120 fotogramas en unos 18 segundos
(6,6 FPS), aunque el archivo procesado indicaba 30 FPS por repetición. La
pantalla sí conservaba unos 29 FPS. En una comparación de seis segundos por
códec, H.264 guardó todos los 140 fotogramas recibidos; VP9 guardó 53 de 80 y
VP8, 132 de 150. Por eso la cámara prioriza ahora H.264. Chromium lo encapsula
con Opus en Matroska, manteniendo las rutas `.webm` del proyecto; el reproductor
y FFmpeg leen la cabecera del archivo. Las muestras están en
`recordings/usb-codecs-20260914/`. La tasa real sigue dependiendo de la cámara
y la carga del equipo; convertir a 30 FPS no recupera imágenes perdidas.
La prueba completa posterior con USB y pantalla simultáneas guardó 502 imágenes
en 19,993 segundos (25,06 FPS reales), sin huecos superiores a 81 ms y sin
recortar el final de la cámara. Está en el proyecto local «Prueba fluidez USB».

**30 FPS reales todavía pendientes en esta USB.** Una medición posterior sin
IA ni codificación dio 25 FPS en Electron 33, tanto con `ideal: 30` como con
`exact: 30`. Electron 44.3.0 / Chromium 152, probado aparte sin actualizar la
app, dio aproximadamente 27,7 FPS con y sin H.264. Omitir el límite, solicitar
60 FPS ideales, usar la frecuencia nativa de 30,00003 FPS o bajar a 720p no
alcanzó 30 FPS. AVFoundation directo, fijando la frecuencia después del arranque,
dio unos 27,2 FPS. Acortar la exposición y probar otro modo antiparpadeo tampoco
resolvió el límite; se restauraron exposición automática, tiempo 157 y 50 Hz.
No se ha demostrado todavía si el límite restante está en el dispositivo,
su conexión o la ruta de captura de macOS. No se sustituye esta medición por
los 30 FPS nominales del archivo final.

La versión nueva incorpora una [corrección oficial de Chromium para formatos
de cámaras USB en Tahoe](https://chromium.googlesource.com/chromium/src/+/a839ed4be785be91aaa79175ee31536938fefca7),
pero la prueba local no basta para dar por resuelto el objetivo. Resultados y
programa de medición: `recordings/usb-30fps-20260914/`.

El original se conserva como `camera-original.webm`; el resultado validado
sustituye `webcam.webm` de forma atómica. Si algo falla se conserva el original y
aparece «Reintentar fondo». Al volver a abrir el proyecto se retoman los trabajos
interrumpidos desde el original. La calibración se guarda en `camera-seed.*` y
la imagen de fondo en `camera-background.*`. No se reprocesan clips antiguos.

Validación: la prueba completa de la app graba 90 fotogramas en tres segundos a
1920×1080, conserva audio y calibración, permite navegar a otro proyecto y
habilita el reproductor al terminar. La muestra de persona de unos ocho segundos
mantiene 30 FPS y tardó unos 42 segundos en procesarse en el M1 Pro de prueba.
El coste depende del equipo y de la carga; 30 FPS de salida no garantiza recuperar
fotogramas que la cámara ya hubiera perdido. El recorte de pelo/silla sigue
siendo el de MatAnyone2 y puede necesitar calibración.

El offset entre pantalla y cámara se mide al solicitar el arranque, evitando
atribuir al vídeo el retraso de la notificación del codificador. El postprocesado
no cambia ese offset ni ralentiza el audio.

La navegación durante la grabación tiene pruebas automatizadas de conservación
de cámara, destino del clip y guardado en otro proyecto visible. La comprobación
manual completa en la app quedó pendiente cuando el usuario decidió probarla.

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
npx electron test/manual/camera-quality.cjs /tmp/camera-quality # archivos Full HD y recortado
npx electron test/manual/recording-finalization.cjs /tmp/camera-final # grabar → cola → vídeo final
node test/manual/camera-finalization.cjs entrada.webm /tmp/fondo-final # MatAnyone2 + FFmpeg
# Reprocesar una grabación local; no abre cámara ni micrófono:
./node_modules/.bin/electron test/manual/camera-replay.cjs muestra.webm /tmp/camera-check
# Probar desenfoque en vez de sustituir el fondo:
./node_modules/.bin/electron test/manual/camera-replay.cjs muestra.webm /tmp/camera-blur blur
# Regresión de clips negros al recortar (sin cámara real):
./node_modules/.bin/electron test/manual/crop-encoding.cjs /tmp/camera-crop
# Sincronización del vídeo/audio codificados, con destellos y tonos sintéticos:
./node_modules/.bin/electron test/manual/camera-sync.cjs /tmp/camera-sync
# Primeras líneas del teleprompter en ventanas de distintas dimensiones:
./node_modules/.bin/electron test/manual/teleprompter.cjs
# Destino del grabador independiente del proyecto mostrado:
node --test test/recording-navigation.test.js test/recording-sync.test.js
```
MatAnyone2 requiere compilar Swift/Core ML una vez. Revisión, corrección de
inicialización y licencias del código y modelos: [native](native/README.md).
Alternativa para otros equipos: [LiveKit](src/vendor/livekit/README.md).
Ajustes de la app en `~/Library/Application Support/record-studio/settings.json`.

## Licencia

Record Studio se publica bajo licencia **MIT** (ver [LICENSE](LICENSE)).

Componentes de terceros incluidos en el repositorio, cada uno con **su propia licencia**:

| Componente | Ruta | Licencia |
| --- | --- | --- |
| `video-use` (skill de edición, Browser Use) | `video-use/` | MIT — [LICENSE](video-use/LICENSE) |
| LiveKit track-processors + MediaPipe | `src/vendor/livekit/` | Apache-2.0 — [LICENSE](src/vendor/livekit/LICENSE-APACHE-2.0.txt), [avisos](src/vendor/livekit/THIRD-PARTY-NOTICES.txt) |
| xterm.js | `src/vendor/xterm/` | MIT |
| MatAnyone2Kit, EdgeSAM y sus pesos | se descargan al compilar | no son MIT — condiciones en [native/README.md](native/README.md) |

Los efectos de sonido y la música se descargan **en tiempo de ejecución** desde la
librería de HeyGen con tu propia clave: no se redistribuyen con este repositorio y
se rigen por las condiciones de HeyGen.
