# Handoff: record-studio → video-use (multicam)

Contrato entre el **grabador** (este repo) y el **editor**
([`video-use`](https://github.com/browser-use/video-use), extendido a multicam).

## Qué entrega record-studio

Un proyecto = una carpeta con uno o más clips sincronizados:

```
<proyecto>/
├── project.json
├── clips/clip_NN/{screen.webm, webcam.webm, sync.json}
└── edit/                 ← video-use escribe AQUÍ (Hard Rule 12 de la skill)
```

- **`screen.webm`** — vídeo de pantalla, sin audio.
- **`webcam.webm`** — cámara **+ micro**. Es la **única fuente de audio**.
- **`sync.json`** — `offset_ms = webcam_start − screen_start`, duración y dims reales.
- **`project.json`** — lista ordenada de clips con su `duration_ms` y `offset_ms`.

Ambas pistas de un clip cubren **la misma línea de tiempo**. El editor no elige “la
mejor toma”: elige **qué plano mostrar** segundo a segundo.

## Cómo lo consume video-use

`render.py` ya soporta **modo multicam** (auto-detectado por `multicam: true` o por
un `layout` en cualquier range). Para un clip, el EDL es:

```json
{
  "version": 1,
  "multicam": true,
  "sources": { "screen": "clips/clip_01/screen.webm", "cam": "clips/clip_01/webcam.webm" },
  "audio_source": "cam",
  "sync": { "offset_ms": 38 },
  "output": { "width": 1920, "height": 1080 },
  "ranges": [
    {"start": 0.0,  "end": 6.2,  "layout": "fullcam",  "beat": "HOOK"},
    {"start": 6.2,  "end": 40.0, "layout": "pip",
     "pip": {"corner": "br", "scale": 0.26, "margin": 40}, "beat": "DEMO"},
    {"start": 40.0, "end": 52.0, "layout": "fullscreen", "beat": "DETAIL"}
  ],
  "grade": "auto",
  "overlays": [],
  "subtitles": "edit/master.srt"
}
```

### Planos (`layout`)
- `fullcam` — webcam a pantalla completa (hablas a cámara).
- `fullscreen` — pantalla a pantalla completa, **audio de la cam**.
- `pip` — pantalla de fondo + webcam en una esquina (`corner`: `br|bl|tr|tl`,
  `scale` = ancho del inset como fracción del lienzo, `margin` en px).

### Varios clips en un proyecto
Cada clip es su propia timeline. Dos opciones:
1. Renderiza un EDL por clip y concatena los `final.mp4` resultantes, o
2. Pon todos los clips en `sources` y desplaza los `start/end` de cada clip por el
   offset acumulado (suma de duraciones de los clips previos).

La opción 1 es la más simple y robusta (cada clip mantiene su propio `sync.offset_ms`).

## Sincronía

`sync.offset_ms = cam_start − screen_start`. Un instante τ del reloj de la cam
corresponde a τ + `offset_ms/1000` en la pantalla. `render.py` aplica ese desfase al
hacer `-ss` sobre `screen.webm` en los planos `fullscreen` y `pip`.

## Estado

- ✅ `render.py` — extracción multicam (`fullcam`/`fullscreen`/`pip`) + concat sin
  pérdida + reglas de producción (fades 30 ms, subtítulos al final, loudnorm).
- ✅ `SKILL.md` — sección **“Multicam (screen + webcam, one synced timeline)”**.
- ✅ Verificado: render de prueba sobre una grabación real (PiP compuesto correcto).
