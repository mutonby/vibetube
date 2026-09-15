'use strict'

// Grabación: fuentes, dispositivos, previews, blur/crop/mezcla, MediaRecorder por chunks.

window.installFloatPreview(window.studio, () => {
  return { source: rec.capturePipe ? el('camPreview') : state.pipe?.previewSource || el('camPreview'), rect: state.crop ? state.cropRect : null }
})

// ---- Source picker (record view) -------------------------------------------

// desktopCapturer puede colgarse (permiso pendiente, instancia anterior cerrándose):
// timeout + un reintento automático, y luego botón para reintentar a mano.
let sourceLoadVersion = 0
let sourceSelectionVersion = 0
let pendingSourceId = null
async function loadSources(attempt = 0) {
  const version = ++sourceLoadVersion
  const refresh = el('refreshSources')
  refresh.disabled = true
  if (!state.sources.length) el('sourcesGrid').innerHTML = '<div class="empty">Buscando pantallas y ventanas…</div>'
  let timer
  try {
    const sources = await Promise.race([window.studio.listSources(), new Promise((_r, reject) => {
      timer = setTimeout(() => reject(new Error('no response after 8 s')), 8000)
    })])
    if (version !== sourceLoadVersion) return
    state.sources = sources
    renderSources()
  } catch (e) {
    if (version !== sourceLoadVersion) return
    if (attempt < 1) return loadSources(attempt + 1)
    if (!state.sources.length) el('sourcesGrid').innerHTML = '<div class="empty">Could not load the sources. Check the Screen Recording permission in Settings and hit Refresh.</div>'
    log('error fuentes: ' + e.message, 'err'); toast('No se pudieron actualizar las fuentes', 'err')
  } finally {
    clearTimeout(timer)
    if (version === sourceLoadVersion) refresh.disabled = false
  }
}
function renderSources() {
  const grid = el('sourcesGrid'); grid.innerHTML = ''
  for (const kind of ['screen', 'window']) {
    const sources = state.sources.filter(s => s.kind === kind)
    if (!sources.length) continue
    const heading = document.createElement('div')
    heading.className = 'source-group-title'
    heading.textContent = `${kind === 'screen' ? 'Full screens' : 'Windows'} · ${sources.length}`
    grid.appendChild(heading)
    for (const s of sources) {
      const card = document.createElement('button')
      card.type = 'button'
      const sel = s.id === state.selectedSourceId
      const pending = s.id === pendingSourceId
      card.className = 'source-card' + (sel ? ' selected' : '')
      card.disabled = state.recording
      card.setAttribute('aria-pressed', String(sel))
      card.title = s.name
      const label = pending ? 'Opening…' : sel ? (state.recording ? (state.paused ? 'Paused' : 'Recording') : 'Selected') : ''
      card.innerHTML = `<span class="source-thumb">${icon(kind === 'screen' ? 'screen' : 'window')}<span class="source-no-preview">No thumbnail</span></span>
        <span class="source-info"><span class="source-name">${escapeHtml(s.name)}</span>
        <span class="source-detail">${escapeHtml(s.detail || (kind === 'screen' ? 'Everything visible on this screen' : 'This window only'))}</span>
        ${label ? `<span class="source-selection">${sel && !pending ? '● ' : ''}${label}</span>` : ''}</span>`
      if (s.thumbnail && s.thumbnail !== 'data:image/png;base64,') {
        const img = document.createElement('img'); img.alt = ''
        img.addEventListener('error', () => img.remove(), { once: true })
        img.src = s.thumbnail; card.querySelector('.source-thumb').appendChild(img)
      }
      card.addEventListener('click', () => selectSource(s.id))
      grid.appendChild(card)
    }
  }
  if (!state.sources.length) grid.innerHTML = '<div class="empty">No sources available. Hit Refresh to look again.</div>'
  updateScreenCaption()
}
function updateScreenCaption() {
  const cap = el('screenCap')
  if (!cap) return
  const s = state.sources.find(x => x.id === state.selectedSourceId) || state.selectedSource
  if (!s || !state.screenStream) { cap.textContent = 'Pick a screen or window on the left'; return }
  const status = state.recording ? (state.paused ? 'EN PAUSA' : 'GRABANDO') : 'PREVIEW · YOU ARE NOT RECORDING YET'
  cap.innerHTML = `<span class="screen-source-status">${status}</span><strong>${escapeHtml(s.name)}</strong><span class="screen-source-scope">${s.kind === 'screen' ? 'This whole screen will be recorded, including any window you open on it.' : 'This window will be recorded. Its content changes when you switch tabs.'}</span>`
  cap.title = s.name
}
async function selectSource(id) {
  if (state.recording || (id === state.selectedSourceId && state.screenStream?.active)) return
  const version = ++sourceSelectionVersion
  pendingSourceId = id; renderSources(); updateReady()
  try {
    const stream = await startScreenPreview(id)
    if (version !== sourceSelectionVersion || state.recording) { stopStream(stream); return }
    const source = state.sources.find(s => s.id === id)
    stopStream(state.screenStream)
    state.screenStream = stream; state.selectedSourceId = id; state.selectedSource = source
    el('screenPreview').srcObject = stream
    const track = stream.getVideoTracks()[0], st = track.getSettings()
    state.dims.screen = { width: st.width || 1920, height: st.height || 1080 }
    track.addEventListener('ended', () => {
      if (state.screenStream !== stream) return
      state.screenStream = null; state.selectedSourceId = null; state.selectedSource = null
      el('screenPreview').srcObject = null
      renderSources(); updateReady()
      toast('The screen source was closed. Pick another one to continue.', 'warn')
      if (state.recording) stopRecording()
    }, { once: true })
  } catch (e) {
    if (version === sourceSelectionVersion) { log('screen error: ' + e.message, 'err'); toast('No se pudo abrir esa fuente. Prueba otra o pulsa Actualizar.', 'err') }
  } finally {
    if (version === sourceSelectionVersion) { pendingSourceId = null; renderSources(); updateReady() }
  }
}

// ---- Devices + previews ----------------------------------------------------

async function listDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    fillSelect(el('camSelect'), devices.filter((d) => d.kind === 'videoinput'), state.camId, 'Camera')
    fillSelect(el('micSelect'), devices.filter((d) => d.kind === 'audioinput'), state.micId, 'Micro')
  } catch (e) { /* labels need permission, already granted */ }
}
function fillSelect(sel, devs, current, fallback) {
  sel.innerHTML = ''
  devs.forEach((d, i) => {
    const opt = document.createElement('option')
    opt.value = d.deviceId
    opt.textContent = d.label || `${fallback} ${i + 1}`
    sel.appendChild(opt)
  })
  if (current && devs.some((d) => d.deviceId === current)) sel.value = current
}

async function startScreenPreview(sourceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } },
  })
}

async function startCamPreview() {
  // tear down any previous pipeline + streams
  if (state.pipe) { await state.pipe.stop(); state.pipe = null }
  if (state.camStream && state.camStream !== state.rawCam) stopStream(state.camStream)
  stopStream(state.rawCam)
  state.rawCam = null

  const RES = { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 30 }, resizeMode: 'none' }
  const AUD = { echoCancellation: true, noiseSuppression: true }
  // Robust acquisition: a saved deviceId can go stale (device unplugged/renamed)
  // and `{exact}` then throws OverconstrainedError. So we try the saved devices
  // first, but fall back to the system default instead of failing the recorder.
  async function acquire() {
    const wantVid = state.camId ? { deviceId: { exact: state.camId }, ...RES } : { ...RES }
    const wantAud = state.micId ? { deviceId: { exact: state.micId }, ...AUD } : { ...AUD }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: wantAud, video: wantVid })
    } catch (e1) {
      if (e1.name === 'OverconstrainedError' || e1.name === 'NotFoundError') {
        // The saved cam/mic is gone — retry with whatever default exists.
        log('the saved camera/mic are no longer connected; using the defaults', 'warn')
        state.camId = ''; state.micId = ''; persist({ cam: '', mic: '' }) // no volver a intentarlo en cada arranque
        return await navigator.mediaDevices.getUserMedia({ audio: AUD, video: { ...RES } })
      }
      throw e1
    }
  }
  try {
    const raw = await acquire()
    state.rawCam = raw
    let out = raw
    if (state.blur && window.CamPipe) {
      await ensureBgLoaded()
      state.pipe = new CamPipe()
      out = await state.pipe.start(raw, {
        blur: true,
        blurAmount: state.blurLevel / 100,
        background: state.bgData ? state.bgData.dataUrl : null,
      })
    }
    state.nativeCamera = state.pipe?.engine === 'matanyone2'
    state.camStream = out
    el('camPreview').srcObject = out
    const st = raw.getVideoTracks()[0].getSettings()
    state.dims.webcam = { width: st.width || 1280, height: st.height || 720 }
    el('blurToggle').checked = state.blur
    syncBlurUi()
    syncCropUi() // crop is a UI overlay on the full preview; it's applied at record time
    startMeter(raw)
    // Restore/rebuild the mic+system audio mix (the mic track just changed identity).
    el('sysAudioToggle').checked = state.sysAudio
    if (state.sysAudio) {
      if (!state.sysStream) { const ok = await enableSystemAudio(); if (!ok) { state.sysAudio = false; el('sysAudioToggle').checked = false } }
      else buildAudioMix()
    }
    await listDevices()
  } catch (e) {
    const hint = {
      NotReadableError: 'the camera or mic are IN USE by another app (Zoom, Photo Booth, QuickTime, Chrome…). Close it and try again.',
      NotAllowedError: 'permission denied. Grant Camera and Microphone access in System Settings › Privacy & Security.',
      OverconstrainedError: 'the selected device no longer exists. Pick another one from the dropdowns.',
      NotFoundError: 'no camera or microphone detected.',
      AbortError: 'the system interrupted the camera. Try again.',
    }[e.name]
    log(`error webcam/micro [${e.name}]: ${e.message}${hint ? ' — ' + hint : ''}`, 'err')
  } finally { updateReady() }
}

function syncBlurUi() {
  const finalRow = el('finalBackgroundRow'), finalToggle = el('finalBackgroundToggle'), finalHint = el('finalBackgroundHint')
  if (finalRow) finalRow.style.display = state.blur && state.nativeCamera ? '' : 'none'
  if (finalToggle) { finalToggle.checked = state.finalBackground; finalToggle.disabled = !!(state.recording || state.recordingBusy || state.rawRecord) }
  if (finalHint) finalHint.style.display = state.blur && state.nativeCamera && state.finalBackground && !state.rawRecord ? '' : 'none'

  // El interruptor de "record without background" solo tiene sentido si hay algo que
  // componer; sin blur, lo que se graba ya es el crudo.
  const rawRow = el('rawRecordRow')
  if (rawRow) rawRow.style.display = state.blur ? '' : 'none'
  const rawTgl = el('rawRecordToggle')
  if (rawTgl) rawTgl.checked = !!state.rawRecord
  const row = el('blurLevelRow')
  if (row) row.style.display = state.blur ? '' : 'none'
  const sl = el('blurLevel')
  if (sl) sl.value = String(state.blurLevel)
  const bgRow = el('bgRow')
  if (bgRow) bgRow.style.display = state.blur ? '' : 'none'
  const sel2 = el('bgSelect')
  const isPreset = sel2 && state.bgPath && [...sel2.options].some((o) => o.value === state.bgPath)
  if (sel2) sel2.value = isPreset ? state.bgPath : ''
  const name = el('bgName')
  if (name) name.textContent = state.bgPath && !isPreset ? (state.bgData?.name || state.bgPath.split('/').pop()) : ''
  const clear = el('bgClear')
  if (clear) clear.style.display = state.bgPath ? '' : 'none'
}

// Load the persisted background image (as data URL) the first time it's needed.
async function ensureBgLoaded() {
  if (!state.bgPath || state.bgData) return
  state.bgData = await window.studio.loadBackground(state.bgPath)
  if (!state.bgData) {
    log('the saved background image no longer exists, removing it', 'warn')
    state.bgPath = ''
    persist({ bgpath: '' })
  }
  syncBlurUi()
}

async function applyBackground(res) {
  state.bgPath = res.path
  state.bgData = res
  persist({ bgpath: res.path })
  syncBlurUi()
  if (state.pipe && state.pipe.setBackground) await state.pipe.setBackground(res.dataUrl)
}

async function pickBackground() {
  if (state.recording) return // fixed during capture
  const res = await window.studio.pickBackground()
  if (res) await applyBackground(res)
}

// Bundled presets (src/backgrounds/) → options in the #bgSelect dropdown.
async function loadBgPresets() {
  const sel = el('bgSelect')
  if (!sel || sel.options.length > 1) return
  try {
    for (const p of await window.studio.listPresetBackgrounds()) {
      const opt = document.createElement('option')
      opt.value = p.path
      opt.textContent = p.label
      sel.appendChild(opt)
    }
  } catch { /* sin presets */ }
}

async function onBgSelect(e) {
  if (state.recording) { syncBlurUi(); return }
  const p = e.target.value
  if (!p) return clearBackground()
  const res = await window.studio.loadBackground(p)
  if (res) await applyBackground(res)
}

async function clearBackground() {
  if (state.recording) return
  state.bgPath = ''
  state.bgData = null
  persist({ bgpath: '' })
  syncBlurUi()
  if (state.pipe && state.pipe.setBackground) await state.pipe.setBackground(null)
}

async function toggleRawRecord() {
  if (state.recording) { el('rawRecordToggle').checked = !!state.rawRecord; return } // fijo durante la captura
  state.rawRecord = el('rawRecordToggle').checked
  persist({ rawrecord: !!state.rawRecord })
  syncBlurUi()
  if (!state.rawRecord && !state.finalBackground && state.blur && !state.pipe) await recalibrateBackground()
  log(state.rawRecord ? 'The original camera will be kept for editing' : state.finalBackground ? 'The background will be applied automatically when the take ends' : 'The preview background will be recorded')
}

async function toggleBlur() {
  if (state.recording) { el('blurToggle').checked = state.blur; return } // fixed during capture
  state.blur = el('blurToggle').checked
  persist({ blur: !!state.blur })
  syncBlurUi()
  await startCamPreview()
}

// Rebuild the model's initial mask from the settled camera, without reopening
// the device or changing its exposure, audio track or selected screen source.
async function recalibrateBackground(calibration = null) {
  if (state.recording || state.recalibrating || !state.blur || !state.rawCam?.active) return
  state.recalibrating = true
  const raw = state.rawCam, previous = state.pipe
  updateReady()
  const pipe = new CamPipe()
  try {
    const output = await pipe.start(raw, {
      blur: true, blurAmount: state.blurLevel / 100,
      background: state.bgData?.dataUrl || null,
      calibration,
    })
    if (state.pipe !== previous || state.rawCam !== raw) { await pipe.stop(); return }
    state.pipe = pipe
    state.camStream = output; el('camPreview').srcObject = output
    await previous?.stop()
    el('recalibrateHelp').textContent = 'If hair or the chair are cut out badly, use “Calibrate person and chair” before recording.'
    toast('Background recalibrated. Check the cut-out before recording.')
  } catch (error) { await pipe.stop(); log('Could not recalibrate the background: ' + error.message, 'err') }
  finally { state.recalibrating = false; updateReady() }
}

// Live blur-intensity slider — applies instantly to the running pipeline, no
// camera restart (so there's no flicker/black-frame while dragging).
function onBlurLevel(e) {
  state.blurLevel = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0))
  persist({ blurlevel: state.blurLevel })
  if (state.pipe) state.pipe.setBlurAmount(state.blurLevel / 100).catch(error => log('Could not set the background: ' + error.message, 'err'))
}

// ---- Camera crop -----------------------------------------------------------
// The preview always shows the FULL frame; a draggable/resizable box marks the
// sub-rectangle that gets recorded. The crop is applied at record time by CamCrop.

function teardownCrop() {
  if (state.cropPipe) { try { state.cropPipe.stop() } catch { /* ignore */ } state.cropPipe = null }
}

// Camera pixel aspect (w/h). Normalised space is 1×1 over a non-square frame, so
// a locked pixel ratio AR maps to a normalised ratio of AR × (frameH/frameW).
function frameAspect() {
  const d = state.dims.webcam
  return (d && d.width && d.height) ? d.width / d.height : 16 / 9
}

function saveCropRect() { persist({ crop_rect: state.cropRect }) }

function syncCropUi() {
  updateCameraResolution()
  const on = state.crop
  el('cropToggle').checked = on
  el('cropTools').style.display = on ? '' : 'none'
  el('cropOverlay').classList.toggle('hidden', !on)
  // reflect active aspect button
  document.querySelectorAll('#cropTools .ar-btn').forEach((b) => {
    const v = b.dataset.ar
    const active = (v === 'free' && state.cropAr == null) || (v !== 'free' && state.cropAr != null && Math.abs(parseFloat(v) - state.cropAr) < 0.001)
    b.classList.toggle('active', active)
  })
  if (on) positionCropBox()
}

// Place the box DOM element from the normalised rect (over the video element).
function positionCropBox() {
  updateCameraResolution()
  const box = el('cropBox')
  const r = state.cropRect
  box.style.left = (r.x * 100) + '%'
  box.style.top = (r.y * 100) + '%'
  box.style.width = (r.w * 100) + '%'
  box.style.height = (r.h * 100) + '%'
}

async function toggleCrop() {
  if (state.recording) { el('cropToggle').checked = state.crop; return } // fixed during capture
  state.crop = el('cropToggle').checked
  persist({ crop: !!state.crop })
  syncCropUi()
}

function setCropAspect(v) {
  if (state.recording) return
  state.cropAr = (v === 'free') ? null : parseFloat(v)
  persist({ crop_ar: v })
  if (state.cropAr != null) applyAspectToRect() // reshape the current box to the new ratio
  syncCropUi()
  saveCropRect()
}

// Reshape the current rect to the locked aspect, keeping its centre, clamped in.
function applyAspectToRect() {
  const r = { ...state.cropRect }
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2
  const nRatio = state.cropAr / frameAspect() // desired normalised w/h
  // keep area-ish: derive h from w
  let w = r.w
  let h = w / nRatio
  if (h > 1) { h = 1; w = h * nRatio }
  r.w = Math.min(w, 1); r.h = Math.min(h, 1)
  r.x = Math.max(0, Math.min(cx - r.w / 2, 1 - r.w))
  r.y = Math.max(0, Math.min(cy - r.h / 2, 1 - r.h))
  state.cropRect = r
}

function resetCrop() {
  if (state.recording) return
  state.cropRect = { x: 0, y: 0, w: 1, h: 1 }
  if (state.cropAr != null) applyAspectToRect()
  saveCropRect(); syncCropUi()
}

// Pointer-driven move/resize of the crop box over the camera preview.
function initCropInteractions() {
  const overlay = el('cropOverlay')
  const box = el('cropBox')
  let drag = null

  const frame = () => el('camPreview').getBoundingClientRect()
  const clamp01 = (v) => Math.max(0, Math.min(1, v))

  function onDown(e, mode) {
    if (state.recording) return
    e.preventDefault(); e.stopPropagation()
    const f = frame()
    drag = { mode, f, sx: e.clientX, sy: e.clientY, r0: { ...state.cropRect } }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }
  function onMove(e) {
    if (!drag) return
    const dx = (e.clientX - drag.sx) / drag.f.width
    const dy = (e.clientY - drag.sy) / drag.f.height
    const r = { ...drag.r0 }
    if (drag.mode === 'move') {
      r.x = clamp01(drag.r0.x + dx); r.y = clamp01(drag.r0.y + dy)
      if (r.x + r.w > 1) r.x = 1 - r.w
      if (r.y + r.h > 1) r.y = 1 - r.h
    } else {
      resizeRect(r, drag.mode, dx, dy)
    }
    state.cropRect = r
    positionCropBox()
  }
  function onUp() {
    drag = null
    window.removeEventListener('pointermove', onMove)
    saveCropRect()
  }

  box.addEventListener('pointerdown', (e) => onDown(e, 'move'))
  box.querySelectorAll('.ch').forEach((h) => {
    const mode = h.classList.contains('tl') ? 'tl' : h.classList.contains('tr') ? 'tr' : h.classList.contains('bl') ? 'bl' : 'br'
    h.addEventListener('pointerdown', (e) => onDown(e, mode))
  })
  // suppress the drag region so moving the box doesn't move the window
  overlay.addEventListener('pointerdown', (e) => e.stopPropagation())
}

// Resize `r` in place by dragging corner `mode`; honour a locked aspect if set.
function resizeRect(r, mode, dx, dy) {
  const MIN = 0.05
  const ar = state.cropAr != null ? state.cropAr / frameAspect() : null // normalised w/h
  const left = mode === 'tl' || mode === 'bl'
  const top = mode === 'tl' || mode === 'tr'
  // anchor = the opposite corner (stays fixed)
  const ax = left ? r.x + r.w : r.x
  const ay = top ? r.y + r.h : r.y
  // moving edge, clamped to the frame
  let mx = Math.max(0, Math.min(1, (left ? r.x : r.x + r.w) + dx))
  let my = Math.max(0, Math.min(1, (top ? r.y : r.y + r.h) + dy))
  let w = Math.abs(mx - ax)
  let h = Math.abs(my - ay)
  if (ar) {
    // drive height from width to keep the ratio, then re-clamp
    h = w / ar
    if (top ? (ay - h < 0) : (ay + h > 1)) { h = top ? ay : 1 - ay; w = h * ar }
    if (left ? (ax - w < 0) : (ax + w > 1)) { w = left ? ax : 1 - ax; h = w / ar }
  }
  w = Math.max(MIN, w); h = Math.max(MIN, h)
  r.w = w; r.h = h
  r.x = left ? ax - w : ax
  r.y = top ? ay - h : ay
}

// ---- System audio (loopback) + mic mix ------------------------------------
// Captures desktop sound via getDisplayMedia (main.js hands back `loopback`
// audio) and mixes it with the mic into ONE track, so webcam.webm carries
// voice + system — the single audio source the editor already expects.

async function toggleSysAudio() {
  if (state.recording) { el('sysAudioToggle').checked = state.sysAudio; return } // fixed during capture
  const want = el('sysAudioToggle').checked
  if (want) {
    const ok = await enableSystemAudio()
    if (!ok) { el('sysAudioToggle').checked = false; return }
  } else {
    disableSystemAudio()
  }
  state.sysAudio = el('sysAudioToggle').checked
  persist({ sysaudio: !!state.sysAudio })
}

async function enableSystemAudio() {
  try {
    // video is mandatory for getDisplayMedia; we keep only the audio track.
    const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    disp.getVideoTracks().forEach((t) => t.stop())
    const sysTrack = disp.getAudioTracks()[0]
    if (!sysTrack) {
      log('this macOS/Electron did not deliver system audio (loopback unavailable)', 'err')
      disp.getTracks().forEach((t) => t.stop())
      return false
    }
    state.sysStream = new MediaStream([sysTrack])
    buildAudioMix()
    log('🔊 system sound on (mixed with your voice)', 'ok')
    return true
  } catch (e) {
    log(`could not capture system sound [${e.name}]: ${e.message}`, 'err')
    return false
  }
}

function disableSystemAudio() {
  teardownMix()
  if (state.sysStream) { stopStream(state.sysStream); state.sysStream = null }
}

// (Re)build the mic+system mixer. Called when enabling system audio and again
// whenever the camera/mic restarts (the mic track changes identity).
function buildAudioMix() {
  teardownMix()
  if (!state.sysAudio && !el('sysAudioToggle').checked) return
  const micTrack = state.rawCam && state.rawCam.getAudioTracks()[0]
  const sysTrack = state.sysStream && state.sysStream.getAudioTracks()[0]
  if (!micTrack || !sysTrack) return
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
  if (audioCtx.state === 'suspended') audioCtx.resume()
  const dest = audioCtx.createMediaStreamDestination()
  const micSrc = audioCtx.createMediaStreamSource(new MediaStream([micTrack]))
  const sysSrc = audioCtx.createMediaStreamSource(new MediaStream([sysTrack]))
  micSrc.connect(dest); sysSrc.connect(dest)
  state.mixNodes = { dest, micSrc, sysSrc }
  state.mixedAudioTrack = dest.stream.getAudioTracks()[0]
}

function teardownMix() {
  if (state.mixNodes) {
    try { state.mixNodes.micSrc.disconnect() } catch { /* ignore */ }
    try { state.mixNodes.sysSrc.disconnect() } catch { /* ignore */ }
    try { state.mixNodes.dest.disconnect() } catch { /* ignore */ }
    state.mixNodes = null
  }
  state.mixedAudioTrack = null
}

function stopStream(stream) { if (stream) for (const t of stream.getTracks()) t.stop() }

// Release the webcam + mic (turns off the camera light) when we leave the
// record view, unless the floating recorder still owns the capture session.
function stopCam() {
  if (state.recording || state.recordingSession) return
  if (state.pipe) { state.pipe.stop(); state.pipe = null }
  stopMeter()
  disableSystemAudio() // release the loopback capture (keeps the pref for next time)
  if (state.camStream && state.camStream !== state.rawCam) stopStream(state.camStream)
  stopStream(state.rawCam)
  state.camStream = null
  state.rawCam = null
  if (el('camPreview')) el('camPreview').srcObject = null
}
function actualDims(videoEl, fallback) {
  if (videoEl && videoEl.videoWidth && videoEl.videoHeight) return { width: videoEl.videoWidth, height: videoEl.videoHeight }
  return fallback
}

async function changeCam() { if (state.recording || state.recordingBusy) return; state.camId = el('camSelect').value; persist({ cam: state.camId }); await startCamPreview() }
async function changeMic() { if (state.recording || state.recordingBusy) return; state.micId = el('micSelect').value; persist({ mic: state.micId }); await startCamPreview() }

// ---- Mic VU meter ----------------------------------------------------------

let audioCtx = null
let meterRAF = null
function startMeter(stream) {
  stopMeter()
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const src = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser(); analyser.fftSize = 512
    const data = new Uint8Array(analyser.frequencyBinCount)
    src.connect(analyser)
    const loop = () => {
      analyser.getByteTimeDomainData(data)
      let peak = 0
      for (const v of data) { const d = Math.abs(v - 128); if (d > peak) peak = d }
      el('meterFill').style.width = Math.min(100, Math.round((peak / 128) * 180)) + '%'
      meterRAF = requestAnimationFrame(loop)
    }
    loop()
  } catch (e) { /* meter optional */ }
}
function stopMeter() { if (meterRAF) cancelAnimationFrame(meterRAF); meterRAF = null }

function updateReady() {
  const ready = state.selectedSourceId && state.screenStream?.active && !pendingSourceId && state.camStream && state.current && !state.recording && !state.recalibrating && !state.selectingCamera
  updateScreenCaption()
  updateCameraResolution()
  el('recBtn').disabled = !ready || !!state.recordingSession || state.recordingBusy
  el('camSelect').disabled = el('micSelect').disabled = !!(state.recording || state.recordingBusy)
  el('keepMainVisible').checked = state.keepMainVisible
  el('keepMainVisible').disabled = state.recording
  el('recalibrateBg').disabled = !!(state.recording || state.recalibrating || !state.blur || !state.rawCam?.active)
  el('calibrateSelection').disabled = el('recalibrateBg').disabled || !!state.selectingCamera
  el('recalibrateBg').textContent = state.recalibrating ? 'Recalibrando…' : 'Recalibrate background'
  el('recalibrateBg').setAttribute('aria-busy', String(!!state.recalibrating))
  el('recalibrateHelp').hidden = !state.blur
  if (state.recordingSession) el('recHint').textContent = `The recorder saves to: ${state.recordingSession.name}`
  else if (state.selectedSourceId && !state.recording) el('recHint').textContent = `You will record into: ${state.currentName}`
}

function updateCameraResolution() {
  const settings = state.rawCam?.getVideoTracks()[0]?.getSettings()
  if (!settings?.width || !settings?.height) { el('camCap').textContent = 'Camera'; return }
  let text = `Camera · ${settings.width} × ${settings.height}`
  if (state.crop && state.cropRect) {
    const r = state.cropRect
    const width = Math.max(2, Math.round(settings.width * r.w)) & ~1
    const height = Math.max(2, Math.round(settings.height * r.h)) & ~1
    text += ` · Recorte: ${width} × ${height}`
  }
  el('camCap').textContent = text
}

// ---- Countdown -------------------------------------------------------------

// Pitido de "¡ya!" por los altavoces justo ANTES de arrancar los grabadores, así
// nunca entra en la toma (ni por el micro ni por el loopback del sistema).
let beepCtx = null
function playStartBeep() {
  return new Promise((resolve) => {
    try {
      beepCtx = beepCtx || new AudioContext()
      const ctx = beepCtx
      const t0 = ctx.currentTime
      ;[[880, 0, 0.09], [1320, 0.12, 0.14]].forEach(([f, at, dur]) => {
        const o = ctx.createOscillator(); const g = ctx.createGain()
        o.type = 'sine'; o.frequency.value = f
        g.gain.setValueAtTime(0.0001, t0 + at); g.gain.exponentialRampToValueAtTime(0.25, t0 + at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur)
        o.connect(g).connect(ctx.destination); o.start(t0 + at); o.stop(t0 + at + dur + 0.02)
      })
      setTimeout(resolve, 330) // el segundo tono acaba a ~260 ms; margen para que no se cuele
    } catch { resolve() }
  })
}

// Cuenta atrás en la barra flotante (la ventana principal está oculta).
function runFloatCountdown(from = 3) {
  return new Promise((resolve) => {
    let n = from
    window.studio.sendElapsed({ text: String(n), count: true })
    const iv = setInterval(() => {
      n -= 1
      if (n > 0) window.studio.sendElapsed({ text: String(n), count: true })
      else { clearInterval(iv); window.studio.sendElapsed({ text: 'GO!', count: true, go: true }); resolve() }
    }, 900)
  })
}

function runCountdown(from = 3) {
  return new Promise((resolve) => {
    el('countdown').classList.remove('hidden')
    const show = (txt, go = false) => {
      el('countNum').textContent = txt
      el('countNum').classList.remove('tick'); void el('countNum').offsetWidth
      el('countNum').className = go ? 'tick go' : 'tick'
    }
    let n = from; show(n)
    const iv = setInterval(() => {
      n -= 1
      if (n > 0) show(n)
      else if (n === 0) show('GO!', true)
      else { clearInterval(iv); el('countdown').classList.add('hidden'); resolve() }
    }, 900)
  })
}

// ---- Recording -------------------------------------------------------------
// Los chunks del MediaRecorder se envían a main según llegan (cada ~1 s) y se
// escriben a disco en `clips/clip_NN/*.part.webm`: si la app muere a mitad de
// toma, lo grabado sigue en disco y el proyecto ofrece recuperarlo. Solo si el
// streaming falla se vuelve al modo antiguo (todo en memoria hasta parar).

function pickMime(withAudio) {
  const cs = withAudio
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  for (const c of cs) if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c
  return 'video/webm'
}

function cameraVideoBitrate(width, height) {
  // Preserve detail at the actual recorded resolution instead of using the
  // same 4 Mbps budget for both a small crop and a full-HD camera.
  return Math.round(Math.max(6_000_000, Math.min(20_000_000, width * height * 8)))
}

function pickCameraMime(withAudio = true) {
  // Full-HD USB noise/detail overwhelms the live VP9 encoder on some Macs.
  // Chromium muxes H.264 + Opus as Matroska; playback and FFmpeg detect the
  // container from its header, including our existing .webm clip paths.
  for (const codec of ['h264', 'vp8', 'vp9']) {
    const mime = `video/webm;codecs=${codec}${withAudio ? ',opus' : ''}`
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return 'video/webm'
}

const rec = {
  clip: null,                 // { clipDir, clipId } abierto en main
  queue: { screen: Promise.resolve(), webcam: Promise.resolve() },
  streamFail: false,          // el streaming a disco falló → fallback en memoria
  lastData: { screen: 0, webcam: 0 },
  firstData: { screen: null, webcam: null },
  warned: { screen: false, webcam: false },
  errors: [],
  pauses: [],
  watchdog: null,
}

async function beginRecording() {
  if (state.recording || state.recordingSession || state.recordingBusy || !state.current) return
  state.recordingSession = { dir: state.current, name: state.currentName }
  state.recordingBusy = true
  try {
    el('recBtn').disabled = true; setStatus('preparando')
    // Aviso de disco antes de empezar (una toma de 10 min son ~1 GB).
    try {
      const df = await window.studio.diskFree(state.recordingSession.dir)
      if (df && df.low) {
        const go = await openConfirm('Poco espacio en disco', `Only ${df.human} free (recommended ≥ ${df.minHuman}). Record anyway?`, { danger: true, okLabel: 'Record' })
        if (!go) { setStatus('ready'); updateReady(); return }
      }
    } catch { /* sin dato de disco */ }
    await runCountdown(3); await playStartBeep(); await startRecording()
  } finally {
    state.recordingBusy = false
    if (!state.recording) state.recordingSession = null
    updateReady()
  }
}

function enqueueChunk(track, blob) {
  if (rec.streamFail || !rec.clip) { state.chunks[track].push(blob); return }
  const clipDir = rec.clip.clipDir
  rec.queue[track] = rec.queue[track].then(async () => {
    try {
      const buf = await blob.arrayBuffer()
      await window.studio.clipChunk(clipDir, track, buf)
    } catch (e) {
      if (!rec.streamFail) {
        rec.streamFail = true
        rec.errors.push('writing to disk failed: ' + e.message)
        console.error('[rec] chunk write failed, falling back to memory', e)
        log('⚠ no puedo escribir en disco en vivo; guardo en memoria hasta parar', 'err')
        window.studio.floatWarn('⚠ Writing to disk failed — the take is buffered in memory')
      }
      state.chunks[track].push(blob)
    }
  })
}
function drainChunks() { return Promise.all([rec.queue.screen, rec.queue.webcam]) }

// `fromFloat` preserves main-window visibility and the session's project.
async function startRecording(fromFloat = false) {
  if (state.recording || state.recalibrating || state.selectingCamera) return
  if (!state.screenStream?.active || pendingSourceId || !state.camStream) { log('streams are missing or the source is still opening', 'err'); setStatus('ready'); updateReady(); return }
  state.chunks = { screen: [], webcam: [] }
  rec.clip = null; rec.streamFail = false; rec.errors = []; rec.pauses = []
  rec.audioDelayMs = 0; rec.cameraSeed = null; rec.capturePipe = null
  state.recordingSession ||= { dir: state.current, name: state.currentName }
  rec.projectDir = state.recordingSession.dir
  rec.projectName = state.recordingSession.name
  rec.cam = camMeta()
  rec.lastData = { screen: 0, webcam: 0 }; rec.firstData = { screen: null, webcam: null }; rec.warned = { screen: false, webcam: false }
  rec.queue = { screen: Promise.resolve(), webcam: Promise.resolve() }
  try { rec.clip = await window.studio.clipBegin(rec.projectDir) }
  catch (e) { rec.streamFail = true; rec.errors.push('could not open the clip on disk: ' + e.message); log('⚠ ' + e.message + ' — grabo en memoria', 'err') }

  // Capture original frames for automatic final matting. The live model pauses
  // during capture so it cannot compete with the video encoder.
  if (rec.cam.afterRecord && state.pipe) {
    const pipe = state.pipe
    try {
      if (pipe.backend?.recordingSeed) {
        rec.cameraSeed = await pipe.backend.recordingSeed()
        if (rec.cameraSeed && rec.clip) {
          await window.studio.clipCameraSeed({ clipDir: rec.clip.clipDir, ...rec.cameraSeed })
          rec.cameraSeed = null
        }
      }
    } catch (error) {
      if (pipe.backend) pipe.backend.paused = false
      if (rec.clip) { await window.studio.clipAbort(rec.clip.clipDir); rec.clip = null }
      endRecordingSession(); throw error
    }
    rec.capturePipe = pipe
    state.camStream = state.rawCam; el('camPreview').srcObject = state.rawCam
    log('Recording the original at 1080p; the background is applied when the take ends')
  }
  const camBase = ((state.rawRecord || rec.cam.afterRecord) && state.rawCam) ? state.rawCam : state.camStream
  let camForRec = camBase
  state.recWebcamDims = null
  if (!rec.cam.afterRecord && state.crop && state.cropRect && window.CamCrop) {
    try {
      state.cropPipe = new CamCrop()
      camForRec = state.cropPipe.start(camBase, state.cropRect)
      state.recWebcamDims = state.cropPipe.outDims
      log(`✂️ grabando recorte ${state.recWebcamDims.width}×${state.recWebcamDims.height}`)
    } catch (e) { log('cropping failed, recording the full camera: ' + e.message, 'warn'); camForRec = camBase; state.cropPipe = null }
  }
  if (state.rawRecord && state.rawCam && state.camStream !== state.rawCam) {
    log('🎥 recording the camera WITHOUT background (recomposed at edit time)')
  }
  // Pick the audio track for the cam recorder: the mic+system MIX when enabled,
  // otherwise the plain mic. webcam.webm stays the single audio source.
  const recVideoTrack = camForRec.getVideoTracks()[0]
  let recAudioTrack = (state.sysAudio && state.mixedAudioTrack) ? state.mixedAudioTrack : state.camStream.getAudioTracks()[0]
  if (recAudioTrack && !rec.cam.afterRecord && !state.rawRecord && state.pipe?.engine === 'matanyone2') {
    rec.audioSync = new RecordingAudioSync()
    recAudioTrack = await rec.audioSync.start(recAudioTrack, () => state.pipe?.stats.latencyMs || 0)
  }
  if (recVideoTrack && recAudioTrack) camForRec = new MediaStream([recVideoTrack, recAudioTrack])
  if (state.sysAudio && state.mixedAudioTrack) log('🔊 recording voice + system sound')
  console.log('[rec] cam tracks', camForRec.getTracks().map((t) => `${t.kind}:${t.readyState}`).join(','),
    '| screen', state.screenStream.getTracks().map((t) => `${t.kind}:${t.readyState}`).join(','))
  // If a recorded track ends mid-take (a stalled crop/mix generator), that's the
  // classic "stop does nothing" freeze — log it loudly.
  camForRec.getTracks().forEach((t) => t.addEventListener('ended', () => {
    console.error('[rec] cam track ENDED mid-recording:', t.kind)
    rec.errors.push(`camera track ${t.kind} was cut off`)
    log(`⚠ ${t.kind} track was cut off during recording`, 'err'); window.studio.floatWarn(`⚠ La pista ${t.kind} de la cámara se ha cortado`)
  }))
  state.screenStream.getTracks().forEach((t) => t.addEventListener('ended', () => {
    rec.errors.push('screen track was cut off')
    log('⚠ the screen capture was cut off', 'err'); window.studio.floatWarn('⚠ La captura de pantalla se ha cortado')
  }))

  const screenRec = new MediaRecorder(state.screenStream, { mimeType: pickMime(false), videoBitsPerSecond: 8_000_000 })
  const camSize = state.recWebcamDims || recVideoTrack.getSettings()
  state.recWebcamDims = { width: camSize.width || state.dims.webcam.width, height: camSize.height || state.dims.webcam.height }
  const camRec = new MediaRecorder(camForRec, { mimeType: pickCameraMime(!!recAudioTrack), videoBitsPerSecond: cameraVideoBitrate(camSize.width || 1920, camSize.height || 1080) })
  console.log('[rec] camera encoder', camRec.mimeType, camRec.videoBitsPerSecond, 'bps')
  const onData = (track) => (e) => {
    if (!e.data || !e.data.size) return
    const now = performance.now()
    rec.lastData[track] = now
    if (rec.firstData[track] == null) rec.firstData[track] = Math.round(now - state.tStart)
    enqueueChunk(track, e.data)
  }
  screenRec.ondataavailable = onData('screen')
  camRec.ondataavailable = onData('webcam')
  const onErr = (label) => (e) => {
    const m = (e.error && e.error.message) || 'error desconocido'
    console.error(`[rec] ${label} error`, e.error)
    rec.errors.push(`${label}: ${m}`)
    log(`⚠ error grabador ${label}: ${m}`, 'err'); window.studio.floatWarn(`⚠ Error en el grabador de ${label}: ${m}`)
  }
  screenRec.onerror = onErr('pantalla')
  camRec.onerror = onErr('cámara')
  state.recorders = [screenRec, camRec]
  state.tStart = performance.now()
  try {
    // onstart is delivered after encoder startup and can lag by many frames.
    // Measure the capture requests, not the notification delivery times.
    state.starts.screen = performance.now(); screenRec.start(1000)
    state.starts.webcam = performance.now(); camRec.start(1000)
  } catch (error) {
    await stopRecorders(state.recorders); await drainChunks()
    rec.audioSync?.stop(); rec.audioSync = null; teardownCrop()
    if (rec.clip) { await window.studio.clipAbort(rec.clip.clipDir); rec.clip = null }
    resumeRecordingPreview(); endRecordingSession(); throw error
  }

  state.recording = true; state.paused = false; state.pausedTotal = 0
  updateReady()
  renderSources()
  setStatus('grabando', 'recording')
  el('pauseBtn').disabled = false; el('pauseBtn').textContent = 'Pause'; el('pauseBtn').className = 'pause'
  el('stopBtn').disabled = false; el('recHint').textContent = `Grabando en: ${rec.projectName}`
  log('● grabando…' + (rec.clip ? ` (${rec.clip.clipId}, a disco)` : ' (en memoria)'))
  window.studio.recordingStarted({ continuing: fromFloat, projectName: rec.projectName, keepMainVisible: state.keepMainVisible, camId: state.camId, blur: state.blur, blurLevel: state.blurLevel, bg: state.bgData ? state.bgData.dataUrl : null, crop: state.crop, cropRect: state.crop ? state.cropRect : null })
  window.studio.sendElapsed({ text: '00:00', paused: false, projectName: rec.projectName })
  state.timerInt = setInterval(updateTimer, 250)
  // Watchdog: un grabador que lleva >3 s sin entregar datos está muerto (la
  // toma seguirá "grabando" pero el fichero se habrá congelado).
  rec.lastData = { screen: performance.now(), webcam: performance.now() }
  clearInterval(rec.watchdog)
  rec.watchdog = setInterval(() => {
    if (!state.recording || state.paused) return
    const now = performance.now()
    for (const track of ['screen', 'webcam']) {
      if (now - rec.lastData[track] > 3000 && !rec.warned[track]) {
        rec.warned[track] = true
        const label = track === 'screen' ? 'pantalla' : 'cámara'
        rec.errors.push(`${label}: no data for >3 s`)
        log(`⚠ the ${label} recorder has delivered no data for >3 s`, 'err')
        window.studio.floatWarn(`⚠ The ${label} stopped recording — stop and start again`)
      } else if (now - rec.lastData[track] <= 3000) rec.warned[track] = false
    }
  }, 1000)
}
function pauseResume() {
  if (!state.recording) return
  if (!state.paused) {
    state.recorders.forEach((r) => r.state === 'recording' && r.pause())
    state.paused = true; state.pauseStart = performance.now()
    setStatus('pausado'); el('pauseBtn').textContent = 'Seguir'; el('pauseBtn').className = 'pause resume'; log('⏸ pausado')
  } else {
    const now = performance.now()
    state.pausedTotal += now - state.pauseStart
    rec.pauses.push([Math.round(state.pauseStart - state.tStart), Math.round(now - state.tStart)])
    state.recorders.forEach((r) => r.state === 'paused' && r.resume())
    rec.lastData = { screen: now, webcam: now }
    state.paused = false; setStatus('grabando', 'recording'); el('pauseBtn').textContent = 'Pause'; el('pauseBtn').className = 'pause'; log('▶ seguir')
  }
  renderSources()
}
function elapsedMs() {
  if (!state.recording) return 0
  const now = performance.now()
  const extra = state.paused ? now - state.pauseStart : 0
  return now - state.tStart - state.pausedTotal - extra
}
function updateTimer() {
  const s = Math.floor(elapsedMs() / 1000)
  const txt = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  el('timer').textContent = txt
  window.studio.sendElapsed({ text: txt, paused: state.paused, projectName: rec.projectName })
}
// Stop every recorder and wait for its final data — but never hang: if a
// recorder's `onstop` never fires (e.g. a stalled crop/mix track), a timeout
// resolves it so the UI/window always recovers.
function stopRecorders(recorders) {
  return Promise.all(recorders.map((r) => new Promise((res) => {
    let done = false
    const finish = () => { if (!done) { done = true; res() } }
    try {
      if (!r || r.state === 'inactive') return finish()
      r.onstop = finish
      r.stop()
    } catch { finish() }
    setTimeout(() => { if (!done) rec.errors.push('a recorder did not confirm shutdown (onstop) within 5 s'); finish() }, 5000)
  })))
}

// `returnToMain=false` (the floating ■ button): finalize + save the clip but stay
// in floating mode so the user can immediately grab another clip. `true` (from the
// main window, or the floating ✓): also restore the main window.
async function stopRecording(returnToMain = true) {
  if (!state.recording || state.recordingBusy) return
  state.recordingBusy = true
  el('pauseBtn').disabled = true; el('stopBtn').disabled = true; setStatus('procesando')
  clearInterval(state.timerInt); clearInterval(rec.watchdog)
  if (state.paused) { rec.pauses.push([Math.round(state.pauseStart - state.tStart), Math.round(performance.now() - state.tStart)]) }
  const durationMs = elapsedMs()
  await stopRecorders(state.recorders)
  rec.audioDelayMs = rec.audioSync?.delayMs || 0
  rec.audioSync?.stop(); rec.audioSync = null
  teardownCrop() // stop the crop pipeline once the recorder has flushed its last frame
  state.recording = false; state.paused = false
  resumeRecordingPreview()
  renderSources()
  updateReady()
  try { await saveClip(durationMs) } // sets the post-save hint last, so it isn't overwritten
  catch (e) { log('✗ could not save the clip: ' + e.message, 'err'); toast('✗ No se pudo guardar el clip: ' + e.message, 'err', 6000); setStatus('error', 'err'); state.recordingBusy = false; endRecordingSession(); return }
  state.recordingBusy = false
  if (!returnToMain) window.studio.floatIdle({ clips: rec.savedSummary?.clipCount || 0, projectName: rec.projectName })
  else endRecordingSession()
  updateReady()
  setStatus('hecho', 'done')
}
function resumeRecordingPreview() {
  const pipe = rec.capturePipe; rec.capturePipe = null
  if (pipe && state.pipe === pipe && state.rawCam?.active) {
    pipe.backend.resumeAfterRecording()
    state.camStream = pipe.outputStream
    el('camPreview').srcObject = state.camStream
  }
}
// Floating ● button: start the next clip without reopening the main window.
let floatArming = false
async function recordFromFloat() {
  if (state.recording || state.recordingBusy || floatArming || !state.recordingSession) return
  if (!state.screenStream?.active || pendingSourceId || !state.camStream) { log('streams are missing or the source is still opening', 'err'); setStatus('ready'); updateReady(); return }
  floatArming = true; state.recordingBusy = true
  try { await runFloatCountdown(3); await playStartBeep(); await startRecording(true) }
  finally { floatArming = false; state.recordingBusy = false; updateReady() }
}
// Floating ✓ button: end the session and go back to the main window
// (saving the in-progress clip first if we're still recording).
async function finishFromFloat() {
  if (state.recordingBusy) return
  if (state.recording) await stopRecording(true)
  else endRecordingSession()
}
function endRecordingSession() {
  state.recordingSession = null
  window.studio.recordingStopped()
  if (el('viewRecord').classList.contains('hidden')) stopCam()
  updateReady()
}
// Qué se grabó y sobre qué fondo hay que recomponerlo. Sin esto, el paso
// offline tendría que adivinar la imagen y el nivel de desenfoque.
function camMeta() {
  const afterRecord = !!(state.finalBackground && state.nativeCamera && state.blur && !state.rawRecord && state.rawCam && (state.bgPath || state.blurLevel > 0))
  return {
    afterRecord,
    ...(afterRecord && state.crop ? { crop: { ...state.cropRect } } : {}),
    raw: afterRecord || !!(state.rawRecord && state.rawCam && state.camStream !== state.rawCam),
    blur: !!state.blur,
    blur_level: state.blurLevel,
    background: state.bgPath || '',
  }
}

async function saveClip(durationMs) {
  // Camera picture + compensated audio represent an earlier capture instant
  // than their delivery time. Keep screen actions on that same timeline.
  const offsetMs = state.starts.webcam - state.starts.screen - (rec.audioDelayMs || 0)
  const dims = { screen: actualDims(el('screenPreview'), state.dims.screen), webcam: state.recWebcamDims || actualDims(el('camPreview'), state.dims.webcam) }
  log('guardando clip…')
  await drainChunks()
  let summary
  if (rec.clip && !rec.streamFail) {
    summary = await window.studio.clipFinish({ clipDir: rec.clip.clipDir, durationMs, offsetMs, dims, pauses: rec.pauses, firstData: rec.firstData, errors: rec.errors, cam: rec.cam })
  } else {
    // Fallback: lo que haya en memoria (y lo que se llegó a escribir se descarta para no mezclar).
    if (rec.clip) { try { await window.studio.clipAbort(rec.clip.clipDir) } catch { /* ignore */ } }
    const screenBlob = new Blob(state.chunks.screen, { type: 'video/webm' })
    const camBlob = new Blob(state.chunks.webcam, { type: 'video/webm' })
    summary = await window.studio.appendClip({ dir: rec.projectDir, screenBuf: await screenBlob.arrayBuffer(), webcamBuf: await camBlob.arrayBuffer(), durationMs, offsetMs, dims, cam: rec.cam, seed: rec.cameraSeed })
  }
  rec.clip = null; rec.cameraSeed = null
  state.chunks = { screen: [], webcam: [] }
  const idx = state.projects.findIndex((p) => p.dir === summary.dir)
  if (idx >= 0) state.projects[idx] = summary; else state.projects.unshift(summary)
  rec.savedSummary = summary
  if (state.current === summary.dir) {
    state.detail = summary
    updateClipsCta()
    renderRecClips()
  }
  const secs = (durationMs / 1000).toFixed(1)
  el('doneMsg').textContent = `✓ Clip ${summary.clipCount} guardado (${secs}s)` + (rec.cam?.afterRecord ? ' · Preparando fondo…' : '')
  el('recHint').textContent = `Listo. Tienes ${summary.clipCount} clip${summary.clipCount > 1 ? 's' : ''}.`
  log(`✓ ${summary.clipCount}º clip guardado (${secs}s)` + (rec.errors.length ? ` — with warnings: ${rec.errors.join('; ')}` : ''), rec.errors.length ? 'warn' : 'ok')
  toast(`✓ Clip ${summary.clipCount} guardado en ${rec.projectName} (${secs}s)` + (rec.errors.length ? ' — check the warnings' : ''), rec.errors.length ? 'warn' : 'ok')
}

// Discard the current take without saving; optionally restart a fresh recording.
async function discardTake(restart) {
  if (!state.recording || state.discarding || state.recordingBusy) return
  state.discarding = true; state.recordingBusy = true
  el('pauseBtn').disabled = true; el('stopBtn').disabled = true
  clearInterval(state.timerInt); clearInterval(rec.watchdog)
  await stopRecorders(state.recorders)
  rec.audioSync?.stop(); rec.audioSync = null
  teardownCrop()
  await drainChunks()
  if (rec.clip) { try { await window.studio.clipAbort(rec.clip.clipDir) } catch { /* ignore */ } rec.clip = null }
  state.recording = false; state.paused = false; state.discarding = false; state.recordingBusy = false
  resumeRecordingPreview()
  renderSources()
  state.chunks = { screen: [], webcam: [] }
  log('toma descartada (no guardada)', 'err')
  el('timer').textContent = '00:00'
  // The ↺ button always comes from the floating bar: re-record in place instead
  // of restoring the main window and running a (now-hidden) countdown.
  if (restart) recordFromFloat()
  else { endRecordingSession(); setStatus('ready'); updateReady() }
}

// Stop a failed effect explicitly instead of recording a frozen camera frame.
window.addEventListener('camera-effect-error', async event => {
  log('Camera effect error: ' + event.detail, 'err')
  if (state.recording) await stopRecording()
  stopCam()
  updateReady()
})
