# MatAnyone2 para la cámara

`npm run build:matting` descarga y compila la revisión
`d85a029870b5149af6aa122cbc13c90db11e5b35` de
[MatAnyone2Kit](https://github.com/flowtyone/MatAnyone2Kit). Requiere Apple Silicon,
macOS 14+ y las herramientas de Swift/Xcode. Los modelos se instalan en
`native/bin`; no hay descargas ni servicios externos durante la grabación.

La corrección al recorte automático retira la intersección de la máscara inicial
de Vision con un rectángulo de detección, que cortaba brazos y pelo. Se usa la
máscara completa de persona, igual que en la prueba aprobada por el usuario.
Modelo, memoria temporal, umbrales y filtrado son los de la librería. El script
lee el archivo original desde el commit fijado para que reconstruir sea idempotente.
También se expone `seedSelection`, una entrada a `engine.seed` para una máscara
explícita sobre el mismo fotograma. No cambia el cálculo del modelo.

`RecordMatte` mantiene una instancia del modelo mientras la persona permanece
en escena y recibe RGBA por
stdin. Responde con alpha8 de 288×512. Vision inicializa con el fotograma de cámara
completo. El renderer envía cada fotograma a resolución completa; Core Image
hace el redimensionado igual que en el programa de la comparativa. Hay una sola petición
en curso: imagen y máscara nunca se mezclan entre fotogramas. La cámara sin
persona muestra el fondo elegido o el desenfoque, sin publicar el primer frame
original mientras se carga el modelo.

El adaptador de Electron limita dimensiones, comprueba el dueño de la sesión,
aplica plazos de espera y cierra el proceso al parar la cámara, cerrar el renderer
o salir. El micrófono original se conserva. `CamPipe` selecciona MatAnyone2 cuando
está instalado, y LiveKit en las otras plataformas; un fallo de MatAnyone2 se
notifica explícitamente y no cambia de modelo durante la grabación.

Los archivos `.cache`, `.build` y `bin` son regenerables y están excluidos de git.
`native/bin/build.json` registra la revisión y el hash de la corrección aplicada.
El código y los modelos de terceros mantienen sus licencias: **MatAnyone2Kit es
GPL-3.0; sus pesos son S-Lab de uso no comercial**. Se copian los avisos originales
junto al ejecutable. La licencia MIT del proyecto no cambia esas condiciones.

Pruebas: `npm test`, `npm run test:camera` y
`electron test/manual/camera-replay.cjs /ruta/video.webm /tmp/prueba`.
La última ejecuta el mismo motor de producción, graba su salida y verifica la
previsualización flotante y que no se hagan peticiones HTTP.

## Validación de la integración

La primera integración, con redimensionado en el navegador, dio
17,52 fps (cabeza), 17,37 fps (brazos) y 18,22 fps (desenfoque).
Tras retirar ese redimensionado, la reproducción aislada de ocho segundos
da 16,73 fps en el M1 Pro de desarrollo. Conserva
salida 1280×720, vista flotante funcional y cero peticiones HTTP. Pasan 42 tests
unitarios y el smoke test de sustitución de fondo, intensidad, activación,
desactivación, recorte y propiedad del track original. No es una medición del
porcentaje de acierto visual ni una promesa de 30 fps.

Grabaciones y métricas: `recordings/matanyone2-20260911/integrated/`.
La app se abrió con el proyecto `record-studio`; se verificaron motor
`matanyone2`, stream activo y grabación detenida.

La comparación del mismo clip mostró que iniciar una sesión nueva recuperaba
zonas de silla perdidas en una sesión anterior. El resultado depende de la
primera máscara de Vision y de la memoria del modelo: no basta con usar los
mismos pesos para garantizar que dos sesiones recorten igual. «Recalibrar fondo»
reinicia el modelo con la cámara actual sin reabrir el dispositivo ni cambiar
los tracks de audio. Está bloqueado durante la grabación. No aplica umbrales ni
correcciones artesanales al pelo o a la silla.

## Salir del encuadre y volver

`PersonPresence` consulta `VNDetectHumanRectanglesRequest` dos veces por segundo.
Tras al menos un segundo de ausencia y medio segundo de detecciones consecutivas
al volver, sustituye la instancia de MatAnyone2 por una nueva. Así no reutiliza
la memoria de la ropa/silueta anterior. Los fallos de Vision no se interpretan
como ausencia; una detección perdida breve no reinicia el seguimiento. Este
control no modifica el alpha ni mezcla máscaras: la nueva sesión procesa el
mismo fotograma que se compone, sin reemplazar los tracks de cámara/audio.

La recuperación incluye la carga y el calentamiento originales del modelo, por
lo que puede producir una pausa breve al volver. No detecta un cambio de ropa
si la persona permanece continuamente visible, ni garantiza conservar la silla:
Vision inicializa una máscara de persona, no una selección explícita de muebles.

Pruebas de la recuperación:
`swift test -c release --package-path native/matanyone` y
`node test/manual/matting-reentry.cjs antes.rgba despues.rgba /tmp/reentrada`
(imágenes RGBA de 1280×720). La segunda introduce una ausencia sintética y compara
el alpha recuperado con una sesión nueva sobre la imagen de regreso. Es una
regresión de salida/reentrada y opacidad, no una prueba de estabilidad de la
silla durante cualquier movimiento.

## Calibración guiada: persona y silla

«Calibrar persona y silla» captura una imagen fija y pide dos puntos, uno en el
torso y otro en la parte visible del respaldo. EdgeSAM genera la selección y
MatAnyone2 la usa como máscara inicial. El primer alpha corresponde exactamente
a esa captura; los siguientes siguen la cámara. Se conserva la previsualización
anterior hasta que la nueva esté lista; cancelar o fallar no cierra la anterior.
Se bloquea la grabación mientras se selecciona o calcula.

EdgeSAM solo se ejecuta al calibrar. Los modelos Core ML se buscan junto al
ejecutable: `edge_sam_encoder.mlmodelc` y `edge_sam_decoder.mlmodelc`. Para
reconstruirlos, usar [EdgeSAM](https://github.com/chongzhou96/EdgeSAM), revisión
`d24d99671f41a9c0003061248bded64a481e9059`, el checkpoint oficial `edge_sam.pth`
y `_scripts/build-calibration.py` (PyTorch 2.5.1 / coremltools 8.3.0 en esta prueba).
El script usa el exportador de la librería, con tres puntos de entrada fijos:
los dos seleccionados y el punto de relleno de SAM. Compilar ambos paquetes con
`xcrun coremlcompiler compile <paquete.mlpackage> native/bin` y copiar la licencia
de EdgeSAM como `native/bin/EdgeSAM-LICENSE`. EdgeSAM usa la licencia S-Lab para
uso no comercial, al igual que los pesos de MatAnyone2; estos modelos no forman
parte de la licencia MIT de Record Studio.

Tras salir y volver, la recuperación automática puede reconstruir la persona,
pero la selección explícita de la silla deja de ser válida. Se avisa para repetir
la calibración guiada; no se reutilizan puntos de una imagen antigua sobre otra.
El protocolo usa `kind=3` para informar de esa pérdida sin interrumpir el stream.

## Fluidez y sincronización al grabar

El adaptador usa `MediaStreamTrackProcessor` y conserva solo el último fotograma
pendiente mientras MatAnyone2 procesa el anterior, como recomienda el pacer de
la librería. Cada máscara sigue componiéndose con su propia imagen. Un
`MessagePort` ligado al dueño de la sesión evita las copias de `contextBridge`;
en Electron 33 los buffers se clonan en el puerto, ya que transferir directamente
un `ArrayBuffer` produce un mensaje nulo en `MessagePortMain`. El lector nativo
llena una sola asignación y Accelerate permuta RGBA a BGRA sin cambiar los colores.

Aunque los `VideoFrame` conservan sus timestamps, el `MediaRecorder` probado
asigna tiempos de llegada al vídeo generado. `RecordingAudioSync` compensa el
micrófono o la mezcla con un `DelayNode` basado en la latencia medida, sin tocar
el track original. El retardo se prepara antes de arrancar los grabadores y se
libera después de vaciarlos. El offset guardado frente a la pantalla descuenta
ese retardo. La opción de cámara original no aplica esta compensación.

`electron test/manual/camera-sync.cjs /tmp/camera-sync` graba destellos y tonos
simultáneos con un modelo simulado que tarda 90 ms; analiza el VP9/Opus resultante
con FFmpeg y comprueba el desfase, además de preservar el track original.
