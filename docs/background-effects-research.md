> Estado actual: los motores y filtros propios descritos abajo se retiraron. La app usa [LiveKit sin modificar](../src/vendor/livekit/README.md). El resto del documento conserva el historial de pruebas.

# Fondo de cámara: investigación y pruebas (11-09-2026)

## Referencias revisadas

- [Google Meet, implementación de 2020](https://research.google/blog/background-features-in-google-meet-powered-by-web-ml/): MediaPipe, segmentación, refinado de máscara y composición en navegador.
- [Google Meet, segmentación HD de 2022](https://research.google/blog/high-definition-segmentation-in-google-meet/): modelo GPU EfficientNet-Lite + MLP de 512×288; no equivale al pequeño modelo público binario de MediaPipe. No se ha copiado ni se afirma usar el modelo privado de Meet.
- [Jitsi, migración a MediaPipe/TFLite](https://jitsi.org/blog/march-update-new-toolbar-ui-virtual-backgrounds-and-more/): el cambio de modelo y WASM SIMD permitieron mejorar el fondo.
- [Twilio Video Processors](https://twilio.github.io/twilio-video-processors.js/): arquitectura local con modelo, WASM y workers; su familia de segmentación también está basada en MediaPipe.
- [Modelos oficiales de MediaPipe](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter) y [ficha del modelo multiclase](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Multiclass%20Segmentation.pdf): seis categorías, incluyendo accesorios; 256×256 publicado. La ficha describe también 512×512, pero no se ha encontrado una descarga pública oficial.
- [RVM](https://github.com/PeterL1n/RobustVideoMatting): matting recurrente de persona y color de borde.
- [MODNet](https://github.com/ZHKKKe/MODNet): modelo específico de webcam, probado con pesos verificados del espejo de Intel Open Model Zoo.

## Comparación sobre muestras locales

Se grabaron cuatro muestras USB nuevas de 20 segundos sin audio. También se reutilizaron
la muestra USB con visor VR y una anterior con camiseta blanca. Los vídeos personales
quedan en `/tmp/rs-background-research`, fuera del repositorio.

| Variante | Observación visual en estas muestras |
| --- | --- |
| RVM MobileNetV3 + retención anterior | Respaldo ambiguo; transparencias/manchas especialmente al inicio. La mejora de una métrica de zona quieta no resolvía el fallo visual. |
| MediaPipe binario cuadrado | Conserva silla y deja fragmentos de fondo. |
| MediaPipe binario panorámico | En la muestra con visor falla incluso la detección de la cabeza. |
| MODNet webcam | Conserva silla; quedan fragmentos detrás del pelo. |
| MediaPipe multiclase, suma de todas las clases de persona | Elimina la silla de forma mucho más consistente y conserva accesorios. Es la opción elegida. |

La última versión del worker se verificó con estas reproducciones, guardadas en
`/tmp/rs-background-research/final-*`. Todas comprobaron también composición,
marcas de tiempo, propiedad del stream original y la vista flotante con la ventana
principal oculta:

| Muestra | FPS | Máscaras evaluadas | Persona ausente |
| --- | ---: | ---: | ---: |
| USB, 20 s | 30,01 | 608 | 0 fotogramas |
| Visor VR, 12 s | 30,04 | 367 | 0 fotogramas |
| Camiseta y manos en movimiento, 15 s | 29,97 | 457 | 0 fotogramas |
| Silla vacía, 12 s | 30,02 | 366 | 366 fotogramas, cero píxeles de primer plano |

La tasa de fotogramas y presencia son comprobaciones de funcionamiento, no medidas
de precisión del contorno. Las mediciones son de este Mac y de estas muestras,
no garantías para todos los equipos.

La cuarta captura USB en vivo obtuvo 27,46 fps a 1280×720. Contiene una escena
vacía seguida de la entrada de la persona de pie, y detectó el último caso descrito
abajo. El vídeo de revisión con las tres muestras sentadas está guardado en
`recordings/background-check-20260911/fondo-corregido.mp4` (sin audio; ignorado por Git).

## Criterios de validación

Revisar el arranque, ambos hombros, pelo, manos, giros e inclinación; comprobar también
la grabación con la ventana principal oculta. Una bajada de variación temporal por sí
sola no prueba que el recorte sea correcto. No hay máscaras manuales de referencia
para certificar una exactitud del 99 %: no se presenta ese número como medido.

La corrección de producción cambia la segmentación de base y elimina la retención
oscura del camino principal. No se colorean ni se reconstruyen partes de la persona.

## Iteraciones posteriores

La prueba con visor reveló una proyección estrecha del respaldo clasificada como
pelo. Se añadió apertura morfológica de la contribución de pelo, preservando las
probabilidades del resto de clases para no eliminar dedos ni accesorios.
La silla vacía todavía producía falsos positivos de ropa: se añadió evidencia
mínima de las categorías semánticas de piel/cara (no umbrales de color RGB).
La revisión visual posterior encontró una isla de pelo aún visible con el visor y
un fragmento de silla clasificado como ropa en la muestra con camiseta. Se añadió
conectividad con la persona a través de primer plano fiable, y se elevó la
confianza exigida a la ropa ambigua. Se descartó endurecer todas las categorías:
esa variante borraba parte de la cabeza con visor. El tratamiento final conserva
las probabilidades de piel/accesorios y el pelo conectado a la persona.

El refinado completo a 640×360 bajaba a 20 fps y falló la prueba de fluidez. Reducir
solo las máscaras a 320×180 antes del refinado recuperó los 30 fps; la composición
sigue usando la imagen de cámara original. No se mantiene ninguna máscara anterior.
Las pruebas unitarias cubren proyecciones, islas, ropa ambigua, piel/accesorios finos,
dimensiones impares, cancelación y escenas vacías. `npm run check` y 63 pruebas pasan.

Al entrar de pie en la cuarta captura, un detalle aislado de silla se clasificaba
como accesorio y anclaba una mancha de ropa. El anclaje final exige una pequeña
región semántica de piel/cara; un accesorio o un píxel aislado de piel no basta.
El visor sigue conectado al cuerpo, y las tres muestras sentadas se volvieron a
verificar con este cambio. En las muestras de entrada a 16,5, 18 y 19 segundos,
el recorte final tiene cero píxeles en la mitad derecha, donde estaba la silla.
La reproducción completa de entrada mantiene 30,05 fps; 508 de sus 607 máscaras
son vacías antes de entrar la persona. Persisten recortes puntuales al entrar muy
cerca del objetivo y parcialmente fuera de cuadro (cuello/brazo). Ese caso no se
considera perfecto ni queda oculto en la evaluación: su extracto se conserva en
`recordings/background-check-20260911/entrada-camara.mp4`.

## Parpadeo alrededor de la cabeza: nueva prueba

El aviso posterior del usuario se reprodujo en una nueva toma USB de 20 segundos,
`/tmp/rs-head-flicker/live-before`: no era solo ruido fino del contorno, también
había una parte del respaldo que alternaba con la clase de pelo junto a la cabeza.

La corrección añade estabilización temporal de las probabilidades **antes** de la
conectividad y los umbrales. El peso depende del tiempo transcurrido (constante de
65 ms) y de los cambios de color en cada zona de cámara. Movimiento, reinicio de
fuente, ausencia de persona, cambio de tamaño o saltos de tiempo liberan el historial.
También se eleva la confianza exigida al pelo ambiguo. La evidencia de accesorios
frente a cara, con histéresis, conserva el pelo de menor confianza al llevar visor.

Se descartó una variante que aprendía una referencia persistente del fondo: aunque
quitaba silla, podía agujerear el pelo oscuro al pasar por delante del respaldo.
Esa variante no está en producción.

La comparación aplica ambas versiones a **la misma predicción del modelo y al mismo
fotograma de entrada**, no a dos grabaciones distintas. Se guardaron 299 pares a
15 fps en `recordings/head-flicker-check-20260911/antes-y-ahora.mp4`. En la región de
cabeza, restringida a píxeles con poco cambio de imagen, la suma de variación de alpha
bajó de 1.903.744 a 1.084.999 (43 %), y los cambios mayores de 64/255 pasaron de 9.774
a 5.750. Son indicadores de parpadeo, **no una medida de exactitud del recorte**.
La revisión visual de los pares confirma la eliminación del fragmento grande de
respaldo, por ejemplo a los 18,05 s. El vídeo de producción de esa misma toma se
reprodujo a 29,87 fps, sin desapariciones de persona y con vista flotante activa.

`npm run check` y 69 pruebas pasan, incluyendo respuesta inmediata al descubrir
fondo, borrado de historial, estabilidad independiente de FPS y pelo con visor.

La validación final volvió a reproducir las muestras de USB, visor, camiseta y silla
vacía a 29,04 / 29,21 / 29,76 / 30,07 fps respectivamente. No desapareció la persona
en las tomas sentadas; la silla vacía produjo cero píxeles de primer plano en sus
367 máscaras. Una segunda captura USB nueva, en segundo plano y sin audio, obtuvo
27,52 fps a 1280×720 (`/tmp/rs-head-flicker/live-after`).

## Cambio solicitado: conservar también la silla

El usuario descartó el enfoque de eliminar la silla y pidió conservarla entera
con la persona. Los resultados anteriores de «silla vacía = cero píxeles» son
históricos y ya no describen el comportamiento deseado.

Se compararon localmente YOLO11n-seg y YOLO11s-seg, la segmentación de objetos de
Apple Vision, GrabCut, expansión por color, EdgeSAM y MobileSAM. Los detectores
YOLO pequeños perdían sillas muy tapadas por la persona; GrabCut y el color por
sí solos incorporaban objetos del fondo. EdgeSAM permitió seleccionar el
respaldo, pero no se distribuye: se eligió la alternativa Apache-2.0 MobileSAM.
La inferencia de MobileSAM a resolución reducida empeoró visiblemente los bordes
y también se descartó.

Fuentes y procedencia:

- [MobileSAM y pesos oficiales](https://github.com/ChaoningZhang/MobileSAM).
- [EdgeSAM](https://github.com/chongzhou96/EdgeSAM) y su licencia S-Lab.
- [YOLO11](https://github.com/ultralytics/ultralytics/blob/main/docs/en/models/yolo11.md).
- [Segmentación de objetos en Vision](https://developer.apple.com/documentation/vision/vngenerateforegroundinstancemaskrequest).
- [Flujo óptico de Vision](https://developer.apple.com/documentation/vision/vngenerateopticalflowrequest).

La versión nueva une la máscara de persona con una máscara explícita del objeto.
El detector de objetos trabaja en CPU, en segundo plano, y el seguimiento por
bloques mantiene la máscara alineada entre detecciones sin competir con el
worker GPU de persona. La búsqueda del respaldo se limita a una zona cercana al
cuerpo, se adapta a la iluminación y se actualiza a menor frecuencia. La fusión
conserva píxeles oscuros estables cuando alternan entre pelo y silla, elimina
fragmentos sueltos y repara huecos oscuros dentro de la envolvente detectada.
Se descartó suavizar el color usado por el seguimiento: reducía ruido, pero
podía admitir manchas del fondo. Una apertura morfológica elimina ramas finas
pegadas al borde; después se suaviza la transición sin rellenar huecos de fondo
y se eliminan de nuevo los fragmentos que hayan quedado separados.
Cambios de color, reinicios y saltos de tiempo liberan el historial. Una máscara
que selecciona casi toda la habitación se descarta.

La selección inicial por color sirve para localizar el punto del respaldo; el
modelo determina su máscara. Hay límites: respaldo oscuro, proximidad al cuerpo,
contraste con la habitación y movimientos moderados. No se ha demostrado una
precisión del 99 %, y ni la ausencia de cuadros vacíos ni el número de FPS son
medidas de esa precisión.

### Verificación y límites de la medición

Se guardaron sucesivas pasadas de los mismos vídeos de cabeza, brazo levantado,
visor, camiseta y silla vacía. Se revisaron las imágenes resultantes y se
corrigieron tanto selecciones de objetos erróneos como huecos en el respaldo.
La captura nueva de la cámara USB fue de 20 segundos, 1280×720, sin audio; encontró
la silla vacía y una habitación muy oscura, no una persona moviéndose. Alcanzó
27,16 FPS. La reproducción corregida de esa escena oscura conservó la silla y
alcanzó 27,95 FPS, con la barra flotante activa.

Los benchmarks de vídeos con persona no alcanzaron siempre el objetivo fijo de
24 FPS del diagnóstico. En un control contemporáneo, el motor anterior también
produjo 21,66 FPS; las cuatro pasadas finales con persona dieron 18,67–19,12 FPS.
La silla vacía con poca luz dio 25,16 FPS en esta última versión. Esto no valida un objetivo
de fluidez sostenida con una persona presente: requiere repetir la captura real
con el usuario delante. Los fallos de ese umbral se conservan en los registros;
no se ha rebajado el umbral para marcar las pruebas como exitosas.

Los diagnósticos de esta iteración están en `/tmp/rs-person-chair/`; los vídeos
para revisar se copian a `recordings/persona-y-silla-20260911/`. La exportación
reproducible y las licencias están documentadas en `native/models/README.md`.

La pasada final está en `/tmp/rs-person-chair/release-check/`. Se conservaron
los cinco registros y estadísticas en la carpeta del vídeo de revisión.
Pasaron 84 pruebas unitarias, la comprobación de sintaxis y la compilación nativa.
Quedan artefactos en contornos difíciles y movimientos; no se considera resuelto
al 99 % ni validado todavía con una nueva toma del usuario presente.

## Sustitución por una librería intacta: LiveKit 0.8.0

Se probó primero el paquete oficial con su modelo binario predeterminado, sin
los clasificadores ni los ajustes anteriores. Cabeza y brazos alcanzaron
29,97 y 30,02 FPS. Mejoraron los contornos observados, aunque aparecieron
algunos objetos de fondo y errores puntuales: no se considera una garantía
de conservar la silla ni de calidad del 99 %.

La integración de producción obtuvo 30,01 / 30,02 / 30,05 / 29,95 / 30,00 FPS
para cabeza, brazos, visor, camiseta y blur. Cada prueba comprobó también la
barra flotante y bloqueó HTTP; hubo cero peticiones externas. Pasaron 33 pruebas
unitarias y el smoke test real de Electron: cambio azul/verde, blur, vídeo
original al desactivar, recorte 320×180 y propiedad de la cámara original.

Se retiraron las clases de máscara, los dos helpers Swift, sus modelos, los
IPC asociados y la biblioteca antigua parcheada. Su copia de diagnóstico está
en `/tmp/rs-livekit-trial/legacy-camera.tgz`. El adaptador actual solo gestiona
tracks, opciones, arranque y cierre. La librería y sus modelos no se modifican.

Vídeo y resultados: `recordings/livekit-20260911/`. Estas pruebas reutilizan las
grabaciones existentes; no validan una nueva toma del usuario presente.
