'use strict'

const t = document.getElementById('t')
const p = document.getElementById('p')
const self = document.getElementById('self')

let pipe = null
let cropPipe = null

document.getElementById('r').addEventListener('click', () => window.floatbar.control('restart'))
document.getElementById('p').addEventListener('click', () => window.floatbar.control('pause'))
document.getElementById('s').addEventListener('click', () => window.floatbar.control('stop'))
document.getElementById('rec').addEventListener('click', () => window.floatbar.control('record'))
document.getElementById('done').addEventListener('click', () => window.floatbar.control('done'))

// Any timer tick means we're recording → recording controls.
window.floatbar.onElapsed((payload) => {
  document.body.classList.remove('idle')
  if (payload.text) t.textContent = payload.text
  document.body.classList.toggle('paused', !!payload.paused)
  p.textContent = payload.paused ? '▶' : '⏸'
})

// A clip was saved but we stay floating → idle controls (grabar otro / terminar).
window.floatbar.onIdle((payload) => {
  document.body.classList.add('idle')
  document.body.classList.remove('paused')
  const n = (payload && payload.clips) || 0
  t.textContent = n === 1 ? '1 clip guardado' : `${n} clips guardados`
})

// Self-view: open the same camera (display only, no audio) and optionally blur.
window.floatbar.onInit(async (state) => {
  const constraints = {
    audio: false,
    video: state.camId ? { deviceId: { exact: state.camId } } : { width: { ideal: 640 }, height: { ideal: 360 } },
  }
  try {
    const raw = await navigator.mediaDevices.getUserMedia(constraints)
    let out = raw
    if (state.blur && window.CamPipe) {
      pipe = new window.CamPipe()
      out = await pipe.start(raw, {
        blur: true,
        blurAmount: typeof state.blurLevel === 'number' ? state.blurLevel / 100 : undefined,
        background: state.bg || null, // same virtual background as the recorder
      })
    }
    // Mirror the recorder's crop so the self-view shows the real framing.
    if (state.crop && state.cropRect && window.CamCrop) {
      cropPipe = new window.CamCrop()
      out = cropPipe.start(out, state.cropRect)
    }
    self.srcObject = out
  } catch (e) {
    // camera busy or denied — self-view stays black, recording is unaffected
  }
})
