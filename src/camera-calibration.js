'use strict'

window.addEventListener('camera-selection-lost', () => {
  const message = 'Has vuelto al encuadre. Usa «Calibrar persona y silla» para renovar la selección de la silla.'
  el('recalibrateHelp').textContent = message
  toast(message, 'warn', 7000)
  if (state.recording) window.studio.floatWarn('Recorte reiniciado: revisa la silla antes de la próxima toma.')
})

async function calibrateCameraSelection() {
  if (state.recording || state.recalibrating || state.selectingCamera || !state.blur || !state.rawCam?.active) return
  const raw = state.rawCam
  state.selectingCamera = true; updateReady()
  try {
    if (!await window.studio.matting.selectionAvailable()) throw Error('La calibración guiada no está instalada en este equipo')
    const calibration = await chooseCameraSelection(raw)
    if (calibration && state.rawCam === raw && !state.recording) await recalibrateBackground(calibration)
  } catch (error) { toast(error.message, 'err') }
  finally { state.selectingCamera = false; updateReady() }
}

async function chooseCameraSelection(stream) {
  const video = document.createElement('video')
  video.muted = true; video.playsInline = true
  video.srcObject = new MediaStream(stream.getVideoTracks())
  const frame = document.createElement('canvas')
  try {
    await video.play()
    frame.width = video.videoWidth; frame.height = video.videoHeight
    frame.getContext('2d').drawImage(video, 0, 0)
  } finally { video.pause(); video.srcObject = null }
  const dialog = el('cameraCalibration'), canvas = el('calibrationFrame'), context = canvas.getContext('2d')
  canvas.width = frame.width; canvas.height = frame.height
  let points = [], cursor = [.5, .5]
  const draw = () => {
    context.drawImage(frame, 0, 0)
    points.forEach(([x, y], i) => {
      context.beginPath(); context.arc(x * canvas.width, y * canvas.height, 14, 0, Math.PI * 2)
      context.fillStyle = '#f56624'; context.fill(); context.strokeStyle = '#fff'; context.lineWidth = 3; context.stroke()
      context.fillStyle = '#fff'; context.font = 'bold 18px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'
      context.fillText(String(i + 1), x * canvas.width, y * canvas.height)
    })
    el('calibrationStep').textContent = ['1. Pulsa dentro de tu camiseta o torso.', '2. Pulsa en una parte visible del respaldo de la silla.', 'Selección lista. Mantén la postura y pulsa «Aplicar recorte».'][points.length]
    el('calibrationApply').disabled = points.length !== 2
  }
  const select = point => { if (points.length < 2) { points.push(point); draw() } }
  canvas.onclick = event => {
    const rect = canvas.getBoundingClientRect()
    select([Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))])
  }
  canvas.onkeydown = event => {
    const move = { ArrowLeft: [-.01, 0], ArrowRight: [.01, 0], ArrowUp: [0, -.01], ArrowDown: [0, .01] }[event.key]
    if (move) {
      event.preventDefault(); cursor = cursor.map((v, i) => Math.max(0, Math.min(1, v + move[i]))); draw()
      context.strokeStyle = '#fff'; context.lineWidth = 2
      context.strokeRect(cursor[0] * canvas.width - 8, cursor[1] * canvas.height - 8, 16, 16)
    } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select([...cursor]) }
  }
  el('calibrationReset').onclick = () => { points = []; draw() }
  draw(); dialog.showModal()
  return new Promise(resolve => {
    const finish = result => {
      dialog.oncancel = null; canvas.onclick = null; canvas.onkeydown = null
      el('calibrationApply').onclick = el('calibrationCancel').onclick = el('calibrationReset').onclick = null
      dialog.close(); resolve(result)
    }
    dialog.oncancel = event => { event.preventDefault(); finish(null) }
    el('calibrationCancel').onclick = () => finish(null)
    el('calibrationApply').onclick = () => { if (points.length === 2) finish({ frame, points: points.flat() }) }
  })
}
