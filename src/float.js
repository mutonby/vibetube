'use strict'

const t = document.getElementById('t')
const p = document.getElementById('p')
const self = document.getElementById('self')

let pipe = null

document.getElementById('r').addEventListener('click', () => window.floatbar.control('restart'))
document.getElementById('p').addEventListener('click', () => window.floatbar.control('pause'))
document.getElementById('s').addEventListener('click', () => window.floatbar.control('stop'))

window.floatbar.onElapsed((payload) => {
  if (payload.text) t.textContent = payload.text
  document.body.classList.toggle('paused', !!payload.paused)
  p.textContent = payload.paused ? '▶' : '⏸'
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
      out = await pipe.start(raw, { blur: true })
    }
    self.srcObject = out
  } catch (e) {
    // camera busy or denied — self-view stays black, recording is unaffected
  }
})
