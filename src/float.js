'use strict'

const t = document.getElementById('t')
const p = document.getElementById('p')
const self = document.getElementById('self')
const project = document.getElementById('project')
window.floatbar.onInit(payload => { project.textContent = payload.projectName || '' })


document.getElementById('r').addEventListener('click', () => window.floatbar.control('restart'))
document.getElementById('p').addEventListener('click', () => window.floatbar.control('pause'))
document.getElementById('s').addEventListener('click', () => window.floatbar.control('stop'))
document.getElementById('rec').addEventListener('click', () => window.floatbar.control('record'))
document.getElementById('done').addEventListener('click', () => window.floatbar.control('done'))

// Any timer tick means we're recording → recording controls.
window.floatbar.onElapsed((payload) => {
  if (payload.projectName) project.textContent = payload.projectName
  document.body.classList.remove('idle')
  document.body.classList.toggle('count', !!payload.count)
  document.body.classList.toggle('go', !!payload.go)
  if (payload.text) t.textContent = payload.text
  document.body.classList.toggle('paused', !!payload.paused)
  p.textContent = payload.paused ? '▶' : '⏸'
})

// A clip was saved but we stay floating → idle controls (grabar otro / terminar).
window.floatbar.onIdle((payload) => {
  if (payload?.projectName) project.textContent = payload.projectName
  document.body.classList.add('idle')
  document.body.classList.remove('paused')
  const n = (payload && payload.clips) || 0
  t.textContent = n === 1 ? '1 clip guardado' : `${n} clips guardados`
})

// Aviso crítico del grabador (la ventana principal está oculta): se muestra
// sobre la barra unos segundos.
let warnEl = null
let warnTimer = null
window.floatbar.onWarn((msg) => {
  if (!warnEl) {
    warnEl = document.createElement('div')
    warnEl.className = 'warn'
    document.body.appendChild(warnEl)
  }
  warnEl.textContent = msg
  warnEl.classList.add('show')
  clearTimeout(warnTimer)
  warnTimer = setTimeout(() => warnEl.classList.remove('show'), 6000)
})

// Pull only small, processed frames. At most one decode is in flight; recording
// remains at camera frame rate independently of this 10 fps thumbnail.
let decoding = false
window.floatbar.onPreview(async bytes => {
  if (decoding) return
  decoding = true
  let bitmap
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
    if (self.width !== bitmap.width || self.height !== bitmap.height) {
      self.width = bitmap.width; self.height = bitmap.height
    }
    self.getContext('2d').drawImage(bitmap, 0, 0)
  } finally { bitmap?.close(); decoding = false }
})
const previewTimer = setInterval(() => window.floatbar.requestPreview(), 100)
window.addEventListener('unload', () => clearInterval(previewTimer))
window.floatbar.requestPreview()
