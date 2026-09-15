'use strict'

// Una toma en curso no puede quedar a merced del bloqueo por inactividad: si el
// Mac apaga la pantalla, `screen.webm` se lleva el salvapantallas o la pantalla
// de bloqueo y la cámara se va a negro. `prevent-display-sleep` desactiva el
// temporizador de inactividad de la pantalla (y con él el salvapantallas y el
// bloqueo automático) mientras dura la sesión de grabación.
//
// No evita —ni debe— el bloqueo manual (Ctrl+Cmd+Q) ni cerrar la tapa.
class AwakeLock {
  constructor(blocker) { this.blocker = blocker; this.id = null }
  get active() { return this.id !== null && this.blocker.isStarted(this.id) }
  // Idempotente: varias tomas seguidas comparten el mismo bloqueo. Si macOS lo
  // hubiera soltado por su cuenta, se vuelve a pedir en lugar de darlo por vivo.
  acquire() {
    if (!this.active) this.id = this.blocker.start('prevent-display-sleep')
    return this.id
  }
  release() {
    const id = this.id
    this.id = null
    if (id !== null && this.blocker.isStarted(id)) this.blocker.stop(id)
  }
}

module.exports = { AwakeLock }
