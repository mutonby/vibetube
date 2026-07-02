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
- Para la edición posterior: la skill `video-use` con `ffmpeg` y `ELEVENLABS_API_KEY`.

## Uso

```bash
npm install
npm start
```

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
│   ├── clip_01/ screen.webm  webcam.webm  sync.json
│   ├── clip_02/ ...
│   └── ...
└── edit/                        ← lo escribe video-use (final.mp4, _poster.jpg)
    └── final.mp4
```

| Archivo | Qué es |
|---|---|
| `screen.webm` | captura de pantalla (sin audio) |
| `webcam.webm` | tu cámara **+ micro** (la pista de audio maestra) |
| `sync.json` | offset entre pistas, duración, dimensiones reales |
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
