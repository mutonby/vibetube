# Fondos de cámara: auditoría de implementaciones de GitHub

Revisión: 11 de septiembre de 2026. Se descargaron archivos de código y licencias de las revisiones enlazadas. Esta revisión es estática: no acredita calidad visual ni rendimiento de los candidatos sobre nuestros vídeos. En el momento de esta auditoría, la app usaba LiveKit 0.8.0.

Actualización posterior: se ha ejecutado la [prueba local de MatAnyone2Kit](matanyone2-trial.md) sobre tres grabaciones. Allí constan las modificaciones de prueba, resultados visuales, tiempos y limitaciones. Tras revisar el vídeo, el usuario aprobó activar MatAnyone2; la integración está documentada en [native/README.md](../native/README.md).

## Hallazgo en el motor instalado

`node_modules/@livekit/track-processors/src/transformers/BackgroundTransformer.ts:77` solicita `outputCategoryMask: true` y desactiva `outputConfidenceMasks`. Cada resultado de `segmentForVideo` actualiza directamente la textura de máscara. `compositeShader.ts:25` suaviza el borde con derivadas espaciales y `smoothstep`. Ese recorrido no contiene historial de máscaras ni un modelo recurrente explícito.

Esto identifica una limitación del motor; no demuestra que sea la única causa de todos los defectos. Los aproximadamente 30 fps y los tests funcionales de la integración anterior prueban funcionamiento y velocidad, no estabilidad de pelo/silla.

## Implementaciones relevantes

### MatAnyone2Kit: candidato diferente y específico para Apple

- Repositorio: [flowtyone/MatAnyone2Kit](https://github.com/flowtyone/MatAnyone2Kit/tree/d85a029870b5149af6aa122cbc13c90db11e5b35).
- [MatAnyoneMatte.swift](https://github.com/flowtyone/MatAnyone2Kit/blob/d85a029870b5149af6aa122cbc13c90db11e5b35/Sources/MatAnyoneKitCoreML/MatAnyoneMatte.swift): obtiene una semilla de Apple Vision y posteriormente llama al motor persistente, sin volver a segmentar con Vision cada fotograma.
- [MatAnyoneCoreMLEngine.swift](https://github.com/flowtyone/MatAnyone2Kit/blob/d85a029870b5149af6aa122cbc13c90db11e5b35/Sources/MatAnyoneKitCoreML/MatAnyoneCoreMLEngine.swift#L78): API pública `seed(image:seedMask:warmup:)` y `step(image:)`, calentamiento del primer fotograma, memoria de características y máscaras. Permite ensayar una semilla persona+silla sin inventar un clasificador de silla.
- Su inicializador automático selecciona **persona**, no persona+silla. Pasar una semilla conjunta es una hipótesis a probar: no garantiza que un modelo de matting humano preserve cualquier silla.
- Incluye un [ejecutable para procesar vídeos](https://github.com/flowtyone/MatAnyone2Kit/blob/d85a029870b5149af6aa122cbc13c90db11e5b35/scripts/matte-demo/Sources/MatteVideo/main.swift) y modelos Core ML. Ese ejecutable usa la semilla automática; no expone una opción CLI para una máscara personalizada.
- Limitaciones: modelos fijos de **288×512 vertical**, macOS 14+, rendimiento publicado de 30 fps en iPhone 16, no medido aquí en Mac ni en cámara horizontal. El puente redimensiona la entrada al tamaño fijo: no asumir que cambiar dimensiones de cámara cambia las dimensiones del modelo.
- [Licencias declaradas](https://github.com/flowtyone/MatAnyone2Kit/blob/d85a029870b5149af6aa122cbc13c90db11e5b35/NOTICE.md): código GPL-3.0; pesos S-Lab de uso no comercial. No es una dependencia comercial intercambiable con LiveKit.

### MatAnyone2: referencia original con memoria y máscara inicial

- [pq-yang/MatAnyone2](https://github.com/pq-yang/MatAnyone2/tree/0079197acd6d16a741f71558809c06c586c579e0), enlaza el port anterior como proyecto de terceros.
- [inference_matanyone2.py](https://github.com/pq-yang/MatAnyone2/blob/0079197acd6d16a741f71558809c06c586c579e0/inference_matanyone2.py): carga una máscara inicial, repite el primer fotograma para calentamiento y propaga el resultado con un procesador persistente.
- [inference_core.py](https://github.com/pq-yang/MatAnyone2/blob/0079197acd6d16a741f71558809c06c586c579e0/matanyone2/inference/inference_core.py): mantiene memoria sensorial, memoria de objetos y última máscara; produce alpha continuo.
- [device.py](https://github.com/pq-yang/MatAnyone2/blob/0079197acd6d16a741f71558809c06c586c579e0/matanyone2/utils/device.py) contempla CUDA, MPS y CPU. Esto demuestra una ruta para Apple, no su velocidad o compatibilidad integral en nuestro equipo. Licencia S-Lab no comercial.

### OBS Background Removal: implementación de producción para contrastar

- [royshil/obs-backgroundremoval](https://github.com/royshil/obs-backgroundremoval/tree/ac26a4abaa34c9e5a8a346c2f92bb9fa3e8d5808).
- En el [camino general](https://github.com/royshil/obs-backgroundremoval/blob/ac26a4abaa34c9e5a8a346c2f92bb9fa3e8d5808/src/background-filter.cpp#L603), mezcla la máscara nueva con la anterior mediante `addWeighted`. El valor predeterminado 0.85 corresponde a **85 % actual y 15 % anterior**, no al revés. También hay umbrales y filtros de contornos: no es un modelo mágico libre de postprocesado.
- [ModelRVM.hpp](https://github.com/royshil/obs-backgroundremoval/blob/ac26a4abaa34c9e5a8a346c2f92bb9fa3e8d5808/src/models/ModelRVM.hpp#L88) devuelve estados recurrentes a las entradas del siguiente fotograma.
- Atención a plataforma: [FilterContext.cpp](https://github.com/royshil/obs-backgroundremoval/blob/ac26a4abaa34c9e5a8a346c2f92bb9fa3e8d5808/src/macos/BackgroundRemoval/FilterContext.cpp) selecciona MediaPipe Landscape para el camino nativo macOS. [MediaPipeLandscapePipeline.mm](https://github.com/royshil/obs-backgroundremoval/blob/ac26a4abaa34c9e5a8a346c2f92bb9fa3e8d5808/src/macos/BackgroundRemoval/MediaPipeLandscapePipeline.mm) usa Core ML y operaciones espaciales. No atribuir automáticamente a ese camino todo lo observado en el camino general/RVM. Código GPL-3.0-or-later.

### Volcomix: referencia web para composición y bordes

- [Volcomix/virtual-background](https://github.com/Volcomix/virtual-background/tree/99dfe4a912573a1440236a9762dcb415b86d216a).
- [jointBilateralFilterStage.ts](https://github.com/Volcomix/virtual-background/blob/99dfe4a912573a1440236a9762dcb415b86d216a/src/pipelines/webgl2/jointBilateralFilterStage.ts): ajusta la máscara usando distancia espacial y similitud de color de la imagen. Es refinamiento espacial, no seguimiento temporal del sujeto.
- [backgroundImageStage.ts](https://github.com/Volcomix/virtual-background/blob/99dfe4a912573a1440236a9762dcb415b86d216a/src/pipelines/webgl2/backgroundImageStage.ts) incorpora luz del fondo en los bordes para integrar mejor la composición.
- Útil como referencia WebGL; insuficiente por sí mismo para decidir consistentemente conservar una silla. Código Apache-2.0. Su README advierte dudas sobre los términos del antiguo modelo de Meet incluido; no confundir licencia del código con la del modelo.

### RobustVideoMatting: memoria recurrente, ya probado en este proyecto

- [PeterL1n/RobustVideoMatting](https://github.com/PeterL1n/RobustVideoMatting/tree/53d74c6826735f01f4406b5ca9075eee27bec094).
- La [inferencia oficial](https://github.com/PeterL1n/RobustVideoMatting/blob/53d74c6826735f01f4406b5ca9075eee27bec094/documentation/inference.md) exige reciclar los cuatro estados y refina a alta resolución. Subir `downsample_ratio` no siempre mejora el resultado.
- Revisado también el antiguo `native/person-matte.swift` archivado en `/tmp/rs-livekit-trial/legacy-camera.tgz`: **sí conservaba los cuatro estados**. No sería correcto presentar RVM como algo nunca probado ni atribuir sus fallos a un reinicio por fotograma.
- Puede servir para comparar la implementación oficial con aquella conversión fija de 640×360, pero no demuestra que RVM resuelva la silla. Código GPL-3.0.

### BackgroundMattingV2: alternativa con fondo de referencia

- [PeterL1n/BackgroundMattingV2](https://github.com/PeterL1n/BackgroundMattingV2/tree/a8e82df9f594578edf287dbb2b289ebcc50fbf00).
- [inference_webcam.py](https://github.com/PeterL1n/BackgroundMattingV2/blob/a8e82df9f594578edf287dbb2b289ebcc50fbf00/inference_webcam.py): captura el fondo al pulsar B y pasa `src` y `bgr` al modelo. Requiere una referencia bien alineada con la cámara.
- Para ensayar conservar persona+silla, la referencia tendría que mostrar el fondo **sin persona ni silla**. Las tomas locales de silla vacía no son esa referencia. Preservar silla sigue siendo una hipótesis que debe validarse con el modelo.
- Código MIT; demo webcam usa CUDA explícitamente, por lo que no se ejecuta tal cual en Mac.

### Plugin Apple Vision

- [qshiqshi/vision-background-removal](https://github.com/qshiqshi/vision-background-removal/tree/70da0aaf41373fe1d76699d5a1007c3051bdf450).
- [background-removal-filter.mm](https://github.com/qshiqshi/vision-background-removal/blob/70da0aaf41373fe1d76699d5a1007c3051bdf450/src/background-removal-filter.mm) reutiliza una petición de segmentación de persona de Vision; aplica gamma y desenfoque gaussiano al borde. El ajuste `smoothing` es espacial, no un historial propio de máscaras. No permite deducir cómo funciona temporalmente Vision internamente.
- Apple Vision ya fue probado aquí. Encontrar otro envoltorio no acredita una mejora sobre esas pruebas.

## Qué significa «como Google Meet»

Google describió en [2020](https://research.google/blog/background-features-in-google-meet-powered-by-web-ml/) segmentación, refinamiento y composición WebGL. En [2022](https://research.google/blog/high-definition-segmentation-in-google-meet/) documentó un modelo GPU de 512×288 frente al anterior CPU de 256×144, con una arquitectura y capacidad diferentes. Un paquete que use MediaPipe no proporciona necesariamente ese modelo ni reproduce la calidad de Meet. Estas publicaciones históricas tampoco acreditan todos los detalles de la versión actual de Meet.

## Decisión derivada de esta revisión

El candidato más distinto para una prueba local es **MatAnyone2/MatAnyone2Kit**, por la selección inicial y la memoria persistente. No está aprobado como solución final: faltan comparación visual, rendimiento en nuestro Mac y prueba de persona+silla; el port tiene formato fijo vertical y pesos no comerciales.

La prueba debe usar los mismos vídeos originales de cabeza y brazos, comparar alpha además de composición y comprobar inicio, oclusiones y reaparición de silla. Hay que conservar el emparejamiento exacto entre fotograma y máscara, y medir latencia además de fps. Si la semilla automática excluye la silla, comparar una semilla conjunta con el motor público antes de introducir detectores adicionales. Integrar en la app solo tras observar una mejora clara; ningún resultado de esta auditoría justifica prometer «99 %».
