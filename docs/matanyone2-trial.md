# Prueba local de MatAnyone2Kit — 11 de septiembre de 2026

Estado histórico de la prueba offline: terminó con mejora visual y límites de detalle/rendimiento. **Después de revisar la comparación, el usuario aprobó activar MatAnyone2**. La integración actual está descrita en [native/README.md](../native/README.md); las cifras de abajo corresponden a esta prueba previa, no a la cámara integrada. No se ha demostrado una calidad del 99 %.

## Configuración

- Apple M1 Pro, macOS 26.3, compilación Swift `release`.
- [MatAnyone2Kit d85a029](https://github.com/flowtyone/MatAnyone2Kit/tree/d85a029870b5149af6aa122cbc13c90db11e5b35), seis modelos Core ML incluidos, resolución interna fija 288×512.
- Tres vídeos originales locales: cabeza, brazos y camiseta. Se reprocesaron grabaciones existentes, sin audio ni nuevas capturas de cámara, y sin subirlas a ningún servicio.
- Biblioteca inicialmente intacta, con su ejecutable `scripts/matte-demo`. Después se instrumentó únicamente ese ejecutable para medir tiempos y guardar máscaras.
- Configuración rápida: `.cpuAndNeuralEngine`, con `objsummary` en `.cpuAndGPU`, tal como recomienda el paquete.

## Defecto de inicialización reproducido

La versión intacta corta brazos y parte del pelo en el primer fotograma y propaga ese error. `CoreMLPersonSeeder` intersecta la máscara de persona de Vision con un rectángulo de `VNDetectHumanRectanglesRequest`.

Se hizo una variante acotada: retirar esa intersección y usar la máscara completa de persona que entrega Vision. Se eliminaron la petición de rectángulos y su bloque de recorte. No se modificaron pesos, memoria temporal, inferencia, umbrales de binarización ni filtros de bordes. No se añadieron detectores de silla, reglas de color ni suavizados propios.

Esta variante evita el recorte grande observado, pero **ya no es la biblioteca intacta**. Su semilla es para una escena de una sola persona; no conserva la selección automática de la persona más cercana del paquete original. La silla no es un objetivo explícito: el modelo la conserva en las tomas oscuras y la elimina en la toma con camiseta.

## Mediciones

Los fps de esta tabla son rendimiento de procesamiento offline, incluyendo composición/escritura. La latencia de inferencia incluye preparación de imagen, inferencia y conversión de alpha; excluye el primer fotograma de calentamiento. No son fps de una integración en Electron.

| Variante | Clip | Fotogramas | Procesamiento fps | Inferencia media / p95 |
|---|---|---:|---:|---:|
| Semilla original | Cabeza | 554 | 21,52 | 43,47 / 55,64 ms |
| Semilla original | Brazos | 555 | 21,13 | 44,55 / 55,64 ms |
| Semilla completa | Cabeza | 554 | 20,36 | 46,21 / 60,72 ms |
| Semilla completa | Brazos | 555 | 21,61 | 43,52 / 53,30 ms |
| Semilla completa | Camiseta | 451 | 21,04 | 44,39 / 57,13 ms |
| Semilla completa, compute `.all` | Cabeza | 554 | 9,93 | 91,98 / 99,87 ms |

Todas esas pasadas terminaron y entregaron alpha en cada fotograma. Eso comprueba ejecución, no precisión de la máscara. El calentamiento inicial con la configuración rápida fue de aproximadamente 0,48–0,58 s, aparte de cargar modelos. La primera ejecución sin cachés tardó 41,73 s de reloj, de los cuales 30,5 s correspondieron al procesamiento de vídeo.

## Revisión visual y decisión

Se inspeccionaron imágenes originales y procesadas a resolución completa, contactos de las tres tomas y una secuencia más densa del movimiento de cabeza/brazos. La variante completa elimina las amputaciones artificiales del primer ensayo y presenta contornos más consistentes en las imágenes revisadas. Sigue suavizando o perdiendo detalles finos, especialmente con el modelo vertical aplicado al vídeo horizontal. No se ha cuantificado una reducción porcentual del parpadeo ni se dispone de máscaras de referencia anotadas.

La configuración `.all` empeora mucho el rendimiento. Inicialmente se mantuvo la prueba separada para que el usuario revisara la mejora. Después de ver la comparación, el usuario pidió activar MatAnyone2. La integración utiliza la variante de semilla completa y la configuración de aceleración rápida; su validación está en [native/README.md](../native/README.md).

## Artefactos y reproducción

- `recordings/matanyone2-20260911/comparacion-completa.mp4`: cabeza, brazos y camiseta, en columnas original / LiveKit / MatAnyone2 con semilla completa.
- `head-fullseed.mp4`, `arms-fullseed.mp4`, `shirt-fullseed.mp4`: resultados individuales de 1280×720.
- `evidence/results.json`: métricas sin redondear; también logs, contactos, revisión exacta y licencias.
- `evidence/complete-person-seed.patch`: cambio de semilla. `diagnostics-runner.patch`: instrumentación y selección opcional de aceleración.
- Checkout compilado y entradas: `/tmp/rs-matanyone2-trial/MatAnyone2Kit` y `/tmp/rs-matanyone2-trial/inputs`.

Para reproducir desde un checkout de la revisión anterior, aplicar los dos patches y ejecutar `swift build -c release --package-path scripts/matte-demo`. Después, usar `.build/release/MatteVideo` dentro de ese paquete con `entrada.mp4 salida.mp4 --bg fondo.jpg`. `RS_COMPUTE=all` reproduce la variante de aceleración lenta; sin esa variable se usan los valores originales del paquete. `RS_SAVE_ALPHA=1` guarda además el alpha como fotogramas gray8 de 288×512 concatenados.

Las comparaciones normalizan el inicio de cada vídeo y su cadencia de reproducción a 30 fps; no constituyen una comparación exacta píxel a píxel. **El archivo se reproduce fluido porque está calculado previamente**, aunque el cálculo haya tardado más que su duración. Se conservan las licencias originales: código GPL-3.0 y modelos S-Lab de uso no comercial. No se han incluido modelos o código del paquete en la distribución de Record Studio.
