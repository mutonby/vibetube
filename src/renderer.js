'use strict'

// ----------------------------------------------------------------------------
// Record Studio — renderer (Home → Detail → Record)
// ----------------------------------------------------------------------------

const el = (id) => document.getElementById(id)
// Tolerant wiring: a missing id logs instead of crashing the whole renderer.
const on = (id, ev, fn) => { const n = el(id); if (n) n.addEventListener(ev, fn); else console.warn('[wire] id ausente:', id) }
// Inline SVG icon from the sprite in index.html.
const icon = (name, cls = 'icon') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`

// Transient feedback toasts (bottom-center, auto-dismiss).
function toast(msg, kind = 'ok', ms = 3500) {
  const host = el('toastHost')
  if (!host) return
  const t = document.createElement('div')
  t.className = 'toast ' + kind
  t.textContent = msg
  host.appendChild(t)
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .25s'; setTimeout(() => t.remove(), 260) }, ms)
}

// Surface any uncaught error/rejection (forwarded to the terminal by main.js and
// shown in the in-app log) so recording bugs while the window is hidden aren't silent.
window.addEventListener('error', (e) => {
  console.error('[uncaught]', e.message, e.filename, e.lineno, e.error && e.error.stack)
  try { log(`⚠ error: ${e.message}`, 'err') } catch { /* log not ready */ }
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  console.error('[unhandledrejection]', (r && (r.stack || r.message)) || r)
  try { log(`⚠ promesa fallida: ${(r && r.message) || r}`, 'err') } catch { /* log not ready */ }
})

const state = {
  sources: [],
  selectedSourceId: null,
  root: localStorage.getItem('rs_root') || '',
  current: '',
  currentName: '',
  projects: [],
  detail: null,
  channel: localStorage.getItem('rs_channel') || '',
  scriptsBusy: false,
  currentScriptPath: '',
  camId: localStorage.getItem('rs_cam') || '',
  micId: localStorage.getItem('rs_mic') || '',
  blur: localStorage.getItem('rs_blur') === '1',
  blurLevel: Math.max(0, Math.min(100, parseInt(localStorage.getItem('rs_blurlevel') ?? '50', 10) || 50)),
  bgPath: localStorage.getItem('rs_bgpath') || '', // virtual background image (empty = blur mode)
  bgData: null, // { path, name, dataUrl } loaded on demand from bgPath
  crop: localStorage.getItem('rs_crop') === '1', // record only a sub-rectangle of the cam
  cropRect: loadCropRect(),                       // { x, y, w, h } normalised [0..1]
  cropAr: (() => { const v = localStorage.getItem('rs_crop_ar'); return v && v !== 'free' ? parseFloat(v) : null })(), // locked pixel w/h, null = free
  cropPipe: null,          // CamCrop instance, alive only while recording
  recWebcamDims: null,     // real dims of the recorded (possibly cropped) cam
  sysAudio: localStorage.getItem('rs_sysaudio') === '1', // mix desktop sound with the mic
  sysStream: null,         // loopback system-audio MediaStream
  mixNodes: null,          // { ctx, dest, micSrc, sysSrc } Web-Audio mixer graph
  mixedAudioTrack: null,   // mic+system combined track fed to the recorder
  rawCam: null,
  pipe: null,
  camStream: null,
  screenStream: null,
  recorders: [],
  chunks: { screen: [], webcam: [] },
  starts: { screen: 0, webcam: 0 },
  dims: { screen: null, webcam: null },
  recording: false,
  paused: false,
  discarding: false,
  tpVisible: false,
  tpScripts: [],
  tpLoadedPath: '',
  tStart: 0,
  pausedTotal: 0,
  pauseStart: 0,
  timerInt: null,
  composing: false,
  stage: 'grabar',       // etapa visible del hub: grabar | montar | resultado
  editorResume: true,    // el chip de sesión: continuar la conversación anterior
  hasSession: false,     // el proyecto tiene una conversación guardada
}

// Persisted crop rectangle (normalised). Defaults to a centred 60%-wide box.
function loadCropRect() {
  try {
    const r = JSON.parse(localStorage.getItem('rs_crop_rect') || 'null')
    if (r && [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number')) return r
  } catch { /* ignore */ }
  return { x: 0.2, y: 0.1, w: 0.6, h: 0.8 }
}

function log(msg, cls = '') {
  const box = el('log')
  if (!box) return
  const line = document.createElement('div')
  if (cls) line.className = cls
  line.textContent = msg
  box.appendChild(line)
  box.scrollTop = box.scrollHeight
}
function setStatus(text, cls = '') {
  el('status').textContent = text
  el('status').className = 'status' + (cls ? ' ' + cls : '')
}
// Breadcrumb con segmentos clicables: setCrumb('texto') o
// setCrumb([{label, go?}, …]) — el último segmento es la ubicación actual.
function setCrumb(parts) {
  const c = el('crumb'); c.innerHTML = ''
  if (!parts || !parts.length) return
  if (typeof parts === 'string') parts = [{ label: parts }]
  parts.forEach((p, i) => {
    if (i) { const s = document.createElement('span'); s.className = 'crumb-sep'; s.textContent = '›'; c.appendChild(s) }
    const seg = document.createElement('span')
    const isLast = i === parts.length - 1
    seg.className = isLast ? 'crumb-here' : 'crumb-seg'
    seg.textContent = p.label
    if (p.go && !isLast) seg.addEventListener('click', () => { if (!state.recording) p.go() })
    c.appendChild(seg)
  })
}

// ---- View navigation -------------------------------------------------------

function hideAll() {
  if (typeof closeTerminal === 'function') closeTerminal() // end any montage terminal when navigating away
  el('viewHome').classList.add('hidden')
  el('viewProject').classList.add('hidden')
  el('viewRecord').classList.add('hidden')
  el('viewScripts').classList.add('hidden')
  window.studio.hideTeleprompter()
}
function setNav(which) {
  el('navProjects').classList.toggle('active', which === 'projects')
  el('navScripts').classList.toggle('active', which === 'scripts')
}
function showHome() {
  stopCam()
  hideAll(); el('viewHome').classList.remove('hidden')
  el('timer').classList.add('hidden'); setCrumb(''); setStatus('listo'); setNav('projects'); loadHome()
}
async function openProject(dir, stage) {
  stopCam()
  const d = await window.studio.projectDetail(dir)
  if (!d) { return }
  state.current = d.dir; state.currentName = d.name; state.detail = d
  renderDetail(d)
  hideAll(); el('viewProject').classList.remove('hidden')
  el('timer').classList.add('hidden'); setStatus('listo'); setNav('projects')
  const job = await window.studio.agentStatus(dir)
  renderPipeline(d, job)
  const sess = await window.studio.agentSession(dir)
  updateSessionChip(!!(sess && sess.hasSession))
  // etapa automática: sin clips → grabar; clips sin final → montar; final → resultado;
  // un montaje en marcha siempre gana
  const isFinal = d.hasFinal || d.hasFinal9x16
  const auto = job && job.status === 'running' ? 'montar' : !d.clipCount ? 'grabar' : isFinal ? 'resultado' : 'montar'
  setStage(stage || auto)
  if (job) restoreEditor(job)
  else { setEditorRunning(false); feedClear() }
}

const STAGE_LABEL = { grabar: 'Grabar', montar: 'Montar', resultado: 'Resultado' }
function setStage(stage) {
  state.stage = stage
  document.querySelectorAll('#viewProject .stage-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.stage !== stage))
  document.querySelectorAll('#pipeline .pl-step').forEach((b) => b.classList.toggle('active', b.dataset.stage === stage))
  if (state.currentName) {
    setCrumb([
      { label: 'Proyectos', go: showHome },
      { label: state.currentName, go: () => openProject(state.current) },
      { label: STAGE_LABEL[stage] || '' },
    ])
  }
}
function renderPipeline(d, job) {
  const isFinal = d.hasFinal || d.hasFinal9x16
  const running = !!(job && job.status === 'running')
  el('plClips').textContent = d.clipCount ? `${d.clipCount} clip${d.clipCount > 1 ? 's' : ''}` : '—'
  el('plMontar').textContent = running ? 'montando…' : isFinal ? 'hecho ✓' : d.clipCount ? 'pendiente' : '—'
  el('plResult').textContent = isFinal ? (d.hasFinal && d.hasFinal9x16 ? '2 formatos' : '1 formato') : '—'
  document.querySelectorAll('#pipeline .pl-step').forEach((b) => {
    const s = b.dataset.stage
    b.classList.toggle('done', (s === 'grabar' && d.clipCount > 0) || ((s === 'montar' || s === 'resultado') && isFinal))
    if (s === 'montar') b.classList.toggle('busy', running)
  })
}
async function showRecord(dir, name) {
  state.current = dir; state.currentName = name
  el('recProjName').textContent = name
  updateClipsCta()
  hideAll(); el('viewRecord').classList.remove('hidden')
  el('timer').classList.remove('hidden'); setNav('projects')
  setCrumb([
    { label: 'Proyectos', go: showHome },
    { label: name, go: () => openProject(dir) },
    { label: 'Grabar' },
  ])
  const tp = state.detail && state.detail.dir === dir ? (state.detail.teleprompter || '') : ''
  el('tpText').value = tp
  el('tpEditor').classList.add('hidden')
  state.tpLoadedPath = ''
  state.tpScripts = state.root ? await window.studio.listScripts(state.root) : []
  if (tp) { window.studio.showTeleprompter(tpPayload(tp)); state.tpVisible = true } else { window.studio.hideTeleprompter(); state.tpVisible = false }
  updateTpToggle()
  renderRecClips()
  if (!state.camStream) await startCamPreview() // turn the camera on only here
  updateReady()
}

function tpPayload(text) {
  return {
    text,
    currentPath: state.tpLoadedPath || '',
    scripts: (state.tpScripts || []).map((s) => ({ title: s.title, path: s.path })),
  }
}
function updateTpToggle() {
  el('tpToggleLbl').textContent = state.tpVisible ? 'Ocultar teleprompter' : 'Mostrar teleprompter'
}
function toggleTeleprompter() {
  if (state.tpVisible) { window.studio.hideTeleprompter(); state.tpVisible = false }
  else { window.studio.showTeleprompter(tpPayload(el('tpText').value)); state.tpVisible = true } // open even if empty: you can load a guion
  updateTpToggle()
}
function toggleTpEditor() {
  el('tpEditor').classList.toggle('hidden')
  if (!el('tpEditor').classList.contains('hidden')) el('tpText').focus()
}
async function saveTeleprompter() {
  const text = el('tpText').value
  if (state.current) { await window.studio.setTeleprompter(state.current, text); if (state.detail) state.detail.teleprompter = text }
  if (state.tpVisible || text.trim()) { window.studio.showTeleprompter(tpPayload(text)); state.tpVisible = !!text.trim() }
  updateTpToggle()
  el('tpEditor').classList.add('hidden')
  log('teleprompter guardado', 'ok')
  toast('✓ Teleprompter guardado', 'ok')
}

async function renderRecClips() {
  if (!state.current) return
  const d = await window.studio.projectDetail(state.current)
  state.detail = d
  updateClipsCta()
  const box = el('recClips'); box.innerHTML = ''
  if (!d.clips.length) { box.innerHTML = '<div class="empty">Aún no has grabado clips.</div>'; return }
  d.clips.forEach((c, i) => {
    const card = document.createElement('div'); card.className = 'rec-clip'
    const thumb = c.thumbDataUrl ? `style="background-image:url('${c.thumbDataUrl}')"` : ''
    card.innerHTML = `
      <div class="rc-thumb" ${thumb}><button class="rc-play" title="reproducir">${icon('play', 'icon icon-sm')}</button><span class="dur-chip">${fmtDur(c.durationMs)}</span></div>
      <div class="rc-row"><span>Clip ${i + 1}</span><button class="rc-del danger" title="borrar">${icon('trash', 'icon icon-sm')}</button></div>`
    card.querySelector('.rc-play').addEventListener('click', () => openVideo(`rsmedia://media/${encodeURIComponent(c.webcamPath)}`))
    card.querySelector('.rc-del').addEventListener('click', async () => {
      const ok = await openConfirm('Borrar clip', `¿Borrar el Clip ${i + 1}? Se moverá a la papelera.`, { danger: true })
      if (!ok) return
      await window.studio.deleteClip(state.current, c.id)
      renderRecClips()
    })
    box.appendChild(card)
  })
}

// Discard the current take without saving; optionally restart a fresh recording.
async function discardTake(restart) {
  if (!state.recording || state.discarding) return
  state.discarding = true
  el('pauseBtn').disabled = true; el('stopBtn').disabled = true
  clearInterval(state.timerInt)
  await stopRecorders(state.recorders)
  teardownCrop()
  state.recording = false; state.paused = false; state.discarding = false
  state.chunks = { screen: [], webcam: [] }
  log('toma descartada (no guardada)', 'err')
  el('timer').textContent = '00:00'
  // The ↺ button always comes from the floating bar: re-record in place instead
  // of restoring the main window and running a (now-hidden) countdown.
  if (restart) startRecording(true)
  else { window.studio.recordingStopped(); setStatus('listo'); updateReady() }
}

async function recordWithScript() {
  if (!state.root) {
    const d = await window.studio.chooseDir('Carpeta raíz de proyectos')
    if (!d) return
    state.root = d; localStorage.setItem('rs_root', d)
  }
  const text = el('scriptOut').value.trim()
  if (!text) { el('scriptOut').focus(); return }
  if (state.currentScriptPath) await window.studio.saveScript(state.currentScriptPath, el('scriptOut').value)
  const defName = (text.split('\n').find((l) => l.trim()) || 'Guion').replace(/^#+\s*/, '').slice(0, 40)
  const name = await openPrompt('Nuevo proyecto para grabar con este guion', defName)
  if (name == null) return
  const summary = await window.studio.createProject(state.root, name.trim() || defName)
  await window.studio.setTeleprompter(summary.dir, text)
  state.projects.unshift(summary)
  const d = await window.studio.projectDetail(summary.dir)
  state.detail = d
  showRecord(d.dir, d.name)
}

// ---- Scripts (write in the user's voice) -----------------------------------

function showScripts() {
  stopCam()
  hideAll(); el('viewScripts').classList.remove('hidden')
  el('timer').classList.add('hidden'); setCrumb('Guiones'); setStatus('listo'); setNav('scripts')
  loadScripts()
}

async function loadScripts() {
  el('channelUrl').value = state.channel || ''
  if (!state.root) {
    el('profileStatus').textContent = 'Primero elige una carpeta en la pestaña Proyectos.'
    el('scriptsList').innerHTML = '<div class="empty">—</div>'
    return
  }
  const st = await window.studio.scriptsStatus(state.root)
  el('profileStatus').textContent = st.hasProfile ? '✓ Perfil de estilo listo. Ya puedes generar guiones.' : 'Sin perfil todavía. Pega tu canal y pulsa “Analizar mi canal”.'
  // restore in-flight jobs
  const sj = await window.studio.agentStatus('style')
  const gj = await window.studio.agentStatus('script')
  const running = (sj && sj.status === 'running') || (gj && gj.status === 'running')
  setScriptBusy(running)
  if (sj && sj.status === 'running') el('profileStatus').textContent = '· analizando…'
  if (gj && gj.status === 'running') el('genStatus').textContent = '· redactando…'
  renderScriptsList()
}

function setScriptBusy(b) {
  state.scriptsBusy = b
  el('analyzeBtn').disabled = b
  el('generateBtn').disabled = b
  el('rewriteBtn').disabled = b
  el('cancelScriptBtn').classList.toggle('hidden', !b)
}
function appendScriptLog(msg) {
  const pre = el('scriptLog')
  pre.textContent += (pre.textContent ? '\n' : '') + msg
  pre.scrollTop = pre.scrollHeight
}
function scriptProgress(key, msg) {
  el('toggleScriptLog').classList.remove('hidden')
  el('scriptLog').classList.remove('hidden')
  appendScriptLog(msg)
  if (key === 'style') el('profileStatus').textContent = '· ' + msg
  else el('genStatus').textContent = '· ' + msg
}
async function scriptDone(key, ok, result, error) {
  setScriptBusy(false)
  if (key === 'style') {
    el('profileStatus').textContent = ok ? '✓ Perfil de estilo listo. Ya puedes generar guiones.' : '✗ ' + (error || 'error')
    toast(ok ? '✓ Perfil de estilo listo' : '✗ El análisis falló', ok ? 'ok' : 'err')
  } else {
    el('genStatus').textContent = ok ? '✓ guion listo' : '✗ ' + (error || 'error')
    toast(ok ? '✓ Guion listo' : '✗ La generación falló', ok ? 'ok' : 'err')
    if (ok && result) {
      state.currentScriptPath = result.path
      el('scriptOut').value = plainText(result.text || '')
      el('scriptName').textContent = result.path.split('/').pop()
      renderScriptsList()
    }
  }
}

async function analyzeChannel() {
  if (state.scriptsBusy) return
  if (!state.root) {
    const d = await window.studio.chooseDir('Carpeta raíz de proyectos')
    if (!d) return
    state.root = d; localStorage.setItem('rs_root', d)
  }
  const ch = el('channelUrl').value.trim()
  if (!ch) { el('channelUrl').focus(); return }
  state.channel = ch; localStorage.setItem('rs_channel', ch)
  el('scriptLog').textContent = ''
  setScriptBusy(true); el('profileStatus').textContent = '· lanzando…'
  await window.studio.analyzeChannel(state.root, ch)
}
async function generateScript() {
  if (state.scriptsBusy || !state.root) return
  const topic = el('topicBox').value.trim()
  if (!topic) { el('topicBox').focus(); return }
  const opts = { duration: el('scrDuration').value, format: el('scrFormat').value }
  el('scriptLog').textContent = ''
  setScriptBusy(true); el('genStatus').textContent = '· redactando…'
  await window.studio.generateScript(state.root, topic, opts)
}
async function rewriteScript() {
  if (state.scriptsBusy || !state.currentScriptPath) return
  const fb = el('scriptFeedback').value.trim()
  if (!fb) { el('scriptFeedback').focus(); return }
  await window.studio.saveScript(state.currentScriptPath, el('scriptOut').value) // rewrite the latest edits
  const opts = { duration: el('scrDuration').value, format: el('scrFormat').value }
  setScriptBusy(true); el('genStatus').textContent = '· reescribiendo…'
  await window.studio.rewriteScript(state.root, state.currentScriptPath, fb, opts)
  el('scriptFeedback').value = ''
}
async function saveCurrentScript() {
  if (!state.currentScriptPath) { el('genStatus').textContent = 'genera un guion primero'; return }
  await window.studio.saveScript(state.currentScriptPath, el('scriptOut').value)
  toast('✓ Guion guardado', 'ok'); renderScriptsList()
}
async function copyScript() {
  try { await navigator.clipboard.writeText(el('scriptOut').value); toast('✓ Copiado al portapapeles', 'ok') } catch { /* ignore */ }
}
async function renderScriptsList() {
  if (!state.root) return
  const list = await window.studio.listScripts(state.root)
  const box = el('scriptsList'); box.innerHTML = ''
  if (!list.length) { box.innerHTML = '<div class="empty">Aún no hay guiones guardados.</div>'; return }
  for (const s of list) {
    const it = document.createElement('div'); it.className = 'script-item'
    it.innerHTML = `<div class="si-main"><div class="si-title">${escapeHtml(s.title)}</div><div class="si-prev">${escapeHtml(s.preview)}</div></div><button class="btn-secondary si-open">Abrir</button>`
    it.querySelector('.si-open').addEventListener('click', async () => {
      state.currentScriptPath = s.path
      el('scriptOut').value = plainText(await window.studio.readScript(s.path))
      el('scriptName').textContent = s.path.split('/').pop()
      el('scriptOut').scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    box.appendChild(it)
  }
}

function updateClipsCta() {
  const n = currentClipCount()
  el('clipCount').textContent = n ? `${n} clip${n > 1 ? 's' : ''} ›` : '0 clips'
  el('clipCount').classList.toggle('clickable', n > 0)
  el('doneBar').classList.toggle('hidden', n === 0)
}
function currentClipCount() {
  const p = state.projects.find((x) => x.dir === state.current)
  return p ? p.clipCount : (state.detail ? state.detail.clipCount : 0)
}

// ---- Home / gallery --------------------------------------------------------

async function chooseRoot() {
  const dir = await window.studio.chooseDir('Carpeta raíz de proyectos')
  if (!dir) return
  state.root = dir; localStorage.setItem('rs_root', dir); await loadHome()
}
async function loadHome() {
  const hasRoot = !!state.root
  el('onboarding').classList.toggle('hidden', hasRoot)
  el('projectsPanel').classList.toggle('hidden', !hasRoot)
  if (!hasRoot) return
  el('rootPath').textContent = state.root
  state.projects = await window.studio.listProjects(state.root)
  renderGallery()
}
function renderGallery() {
  const grid = el('projectsGrid'); grid.innerHTML = ''
  const addCard = document.createElement('div')
  addCard.className = 'project-card new-card'
  addCard.innerHTML = `<div class="poster add">${icon('plus', 'icon icon-lg')}</div><div class="info"><div class="pname">Nuevo proyecto</div><div class="meta">graba clips nuevos</div></div>`
  addCard.addEventListener('click', () => el('newName').focus())
  grid.appendChild(addCard)
  for (const p of state.projects) {
    const card = document.createElement('div')
    card.className = 'project-card'
    const posterStyle = p.previewDataUrl ? `style="background-image:url('${p.previewDataUrl}')"` : ''
    const isFinal = p.hasFinal || p.hasFinal9x16
    const badgeTxt = isFinal ? (p.hasFinal && p.hasFinal9x16 ? 'final ✓ +9:16' : 'final ✓') : 'borrador'
    const durChip = p.durationMs ? `<span class="dur-chip">${fmtDur(p.durationMs)}</span>` : ''
    card.innerHTML = `
      <div class="poster" ${posterStyle}>${p.previewDataUrl ? '' : 'sin preview'}${durChip}</div>
      <span class="badge ${isFinal ? 'final' : 'draft'}">${badgeTxt}</span>
      <div class="info">
        <div class="pname">${escapeHtml(p.name)}</div>
        <div class="meta">${p.clipCount} clip(s) · ${fmtDur(p.durationMs)} · ${fmtDate(p.created)}</div>
      </div>`
    card.addEventListener('click', () => openProject(p.dir))
    grid.appendChild(card)
    // flip the badge to "montando…" if this project's agent is running (async, best-effort)
    window.studio.agentStatus(p.dir).then((job) => {
      if (job && job.status === 'running') {
        const b = card.querySelector('.badge')
        if (b) { b.className = 'badge busy'; b.textContent = 'montando…' }
      }
    }).catch(() => {})
  }
}
async function createProject() {
  const name = el('newName').value.trim()
  if (!name) { el('newName').focus(); return }
  if (!state.root) {
    const dir = await window.studio.chooseDir('Carpeta raíz de proyectos')
    if (!dir) return
    state.root = dir; localStorage.setItem('rs_root', dir)
  }
  const summary = await window.studio.createProject(state.root, name)
  el('newName').value = ''
  state.projects.unshift(summary)
  state.detail = summary
  showRecord(summary.dir, summary.name)
}

// ---- Project detail --------------------------------------------------------

function renderDetail(d) {
  el('detailName').textContent = d.name
  const isFinal = d.hasFinal || d.hasFinal9x16
  el('detailBadge').textContent = isFinal ? (d.hasFinal && d.hasFinal9x16 ? 'final ✓ +9:16' : 'final ✓') : 'borrador'
  el('detailBadge').className = 'badge ' + (isFinal ? 'final' : 'draft')

  // compose options (siempre visibles en la barra de la etapa Montar)
  const o = d.composeOpts || {}
  // Los proyectos antiguos guardaban aspect '16:9' pero el montaje siempre generó
  // ambos formatos; sin el marcador aspectV2 ese valor significa 'both'.
  const aspect = o.aspect === '9:16' || o.aspect === 'both' ? o.aspect : o.aspectV2 && o.aspect === '16:9' ? '16:9' : 'both'
  setSegActive('aspectSeg', 'aspect', aspect)
  el('optSubs').checked = o.subtitles !== false
  el('optModel').value = o.model || 'medium'
  setSegActive('pipPicker', 'pip', o.pip || 'br')
  el('optCrop').checked = o.cropMenubar === true
  el('optSfx').checked = o.sfx === true
  el('optTone').value = o.tone || ''

  // final result (ambos aspectos)
  renderResult(d)

  // clips
  el('clipsTitle').textContent = `Clips (${d.clips.length})`
  const grid = el('clipsGrid'); grid.innerHTML = ''
  if (!d.clips.length) {
    grid.innerHTML = '<div class="empty">Sin clips todavía. Pulsa “● Grabar clip”.</div>'
  } else {
    d.clips.forEach((c, i) => {
      const card = document.createElement('div')
      card.className = 'clip-card'
      const thumbStyle = c.thumbDataUrl ? `style="background-image:url('${c.thumbDataUrl}')"` : ''
      card.innerHTML = `
        <div class="clip-thumb" ${thumbStyle}><button class="clip-play" title="reproducir">${icon('play', 'icon icon-sm')}</button><span class="dur-chip">${fmtDur(c.durationMs)}</span></div>
        <div class="clip-row">
          <span class="clip-meta">Clip ${i + 1}</span>
          <span class="clip-btns">
            <button data-a="up" title="subir" ${i === 0 ? 'disabled' : ''}>${icon('chevron-up', 'icon icon-sm')}</button>
            <button data-a="down" title="bajar" ${i === d.clips.length - 1 ? 'disabled' : ''}>${icon('chevron-down', 'icon icon-sm')}</button>
            <button data-a="del" class="danger" title="borrar">${icon('trash', 'icon icon-sm')}</button>
          </span>
        </div>`
      card.querySelector('.clip-play').addEventListener('click', () => openVideo(`rsmedia://media/${encodeURIComponent(c.webcamPath)}`))
      card.querySelector('[data-a="up"]').addEventListener('click', () => moveClip(c.id, -1))
      card.querySelector('[data-a="down"]').addEventListener('click', () => moveClip(c.id, 1))
      card.querySelector('[data-a="del"]').addEventListener('click', () => deleteClip(c.id, i + 1))
      grid.appendChild(card)
    })
  }
}

// Área de resultado: muestra los dos aspectos (16:9 YouTube y 9:16 Shorts/Reels).
function renderResult(d) {
  const finalArea = el('finalArea')
  const isFinal = d.hasFinal || d.hasFinal9x16
  if (!isFinal) {
    finalArea.className = 'final-area'
    finalArea.innerHTML = '<div class="empty">Aún no hay vídeo final. Graba algún clip y pulsa <b>Componer vídeo</b>: Claude Code editará la grabación con la skill <code>video-use</code>. Puede tardar varios minutos.</div>'
    return
  }
  finalArea.className = 'result-grid'
  const fig = (kind, has, filePath, poster) => {
    const label = kind === '169' ? `${icon('screen', 'icon icon-sm')} YouTube 16:9` : `${icon('window', 'icon icon-sm')} Shorts/Reels 9:16`
    if (!has) {
      return `<figure class="result r${kind}"><figcaption>${label}</figcaption><div class="empty">No pedido en este montaje.</div></figure>`
    }
    const src = `rsmedia://media/${encodeURIComponent(filePath)}`
    return `
      <figure class="result r${kind}">
        <figcaption>${label}
          <button class="ghost mini" data-open="${kind}" title="Abrir en reproductor">${icon('external', 'icon icon-sm')}</button>
          <button class="ghost mini" data-reveal="${kind}" title="Mostrar en Finder">${icon('folder', 'icon icon-sm')}</button>
        </figcaption>
        <video controls playsinline preload="metadata" ${poster ? `poster="${poster}"` : ''} src="${src}"></video>
      </figure>`
  }
  finalArea.innerHTML =
    fig('169', d.hasFinal, d.finalPath, d.previewDataUrl) +
    fig('916', d.hasFinal9x16, d.final9x16Path, d.preview9x16DataUrl)
  const paths = { 169: d.finalPath, 916: d.final9x16Path }
  finalArea.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => window.studio.openPath(paths[b.dataset.open])))
  finalArea.querySelectorAll('[data-reveal]').forEach((b) =>
    b.addEventListener('click', () => window.studio.revealPath(paths[b.dataset.reveal])))
}

// Controles tipo segmented/picker: valor = data-attr del botón .active.
function setSegActive(containerId, dataKey, value) {
  document.querySelectorAll(`#${containerId} button`).forEach((b) => b.classList.toggle('active', b.dataset[dataKey] === value))
}
function segValue(containerId, dataKey, fallback) {
  const b = document.querySelector(`#${containerId} button.active`)
  return (b && b.dataset[dataKey]) || fallback
}

function currentOpts() {
  return {
    aspect: segValue('aspectSeg', 'aspect', 'both'),
    aspectV2: true, // elegido con la UI nueva (los '16:9' antiguos significaban ambos)
    subtitles: el('optSubs').checked,
    model: el('optModel').value,
    pip: segValue('pipPicker', 'pip', 'br'),
    cropMenubar: el('optCrop').checked,
    sfx: el('optSfx').checked,
    tone: el('optTone').value.trim(),
  }
}
async function persistOpts() {
  if (state.current) await window.studio.setComposeOpts(state.current, currentOpts())
}

async function moveClip(clipId, delta) {
  const ids = state.detail.clips.map((c) => c.id)
  const idx = ids.indexOf(clipId)
  const j = idx + delta
  if (j < 0 || j >= ids.length) return
  ;[ids[idx], ids[j]] = [ids[j], ids[idx]]
  await window.studio.reorderClips(state.current, ids)
  await openProject(state.current, state.stage)
}
async function deleteClip(clipId, n) {
  const ok = await openConfirm('Borrar clip', `¿Borrar el Clip ${n}? Se moverá a la papelera.`, { danger: true })
  if (!ok) return
  await window.studio.deleteClip(state.current, clipId)
  await openProject(state.current, state.stage)
}
async function renameProject() {
  const name = await openPrompt('Renombrar proyecto', state.currentName)
  if (name == null) return
  const s = await window.studio.renameProject(state.current, name.trim() || state.currentName)
  const idx = state.projects.findIndex((p) => p.dir === s.dir); if (idx >= 0) state.projects[idx] = s
  await openProject(state.current, state.stage)
}
async function deleteProject() {
  const ok = await openConfirm('Borrar proyecto', `¿Borrar “${state.currentName}” entero? Se moverá a la papelera.`, { danger: true })
  if (!ok) return
  const res = await window.studio.deleteProject(state.current)
  if (res.ok) { state.projects = state.projects.filter((p) => p.dir !== state.current); showHome() }
}

// ---- Editor: superficie única del agente (headless-first) -------------------
// El feed muestra la conversación con el editor: mensajes del usuario, texto del
// asistente, grupos de actividad (herramientas/comandos) y tarjetas de resultado.
// El terminal xterm queda como vía avanzada en el menú ⋯.

function setEditorRunning(running) {
  state.composing = running
  el('composeBtn').disabled = running
  el('editorSend').disabled = running
  el('editorInput').disabled = running
  el('cancelBtn').classList.toggle('hidden', !running)
  el('recHere').disabled = running
  const montar = document.querySelector('#pipeline [data-stage="montar"]')
  if (montar) montar.classList.toggle('busy', running)
  if (running) el('editorStatus').textContent = '· montando…'
}

// log crudo (accesible desde ⋯ → Ver log crudo)
function appendComposeLog(msg) {
  const pre = el('composeLog')
  pre.textContent += (pre.textContent ? '\n' : '') + msg
  pre.scrollTop = pre.scrollHeight
}

// --- feed ---
let actGroup = null // grupo de actividad abierto (se cierra al llegar texto del asistente)
function feedBox() { return el('editorFeed') }
function feedShow() { feedBox().classList.remove('hidden') }
function feedScroll() { const f = feedBox(); f.scrollTop = f.scrollHeight }
function feedClear() { feedBox().innerHTML = ''; feedBox().classList.add('hidden'); actGroup = null }
function feedMsg(kind, text) {
  feedShow(); actGroup = null
  const d = document.createElement('div')
  d.className = 'msg ' + kind
  d.textContent = text
  feedBox().appendChild(d); feedScroll()
}
function feedActivity(line) {
  feedShow()
  if (!actGroup) {
    actGroup = document.createElement('details')
    actGroup.className = 'activity'
    actGroup.innerHTML = '<summary><span class="spinner"></span> <span>Trabajando…</span> <span class="act-last"></span></summary><div class="act-lines"></div>'
    feedBox().appendChild(actGroup)
  }
  actGroup.querySelector('.act-last').textContent = line
  const lines = actGroup.querySelector('.act-lines')
  lines.textContent += (lines.textContent ? '\n' : '') + line
  feedScroll()
}
function feedFinishActivity() {
  document.querySelectorAll('#editorFeed .activity .spinner').forEach((s) => s.remove())
  actGroup = null
}
function feedResult(kind, text, btnLabel, btnAction) {
  feedShow(); feedFinishActivity()
  const d = document.createElement('div')
  d.className = 'result-card ' + kind
  d.innerHTML = `<span>${escapeHtml(text)}</span><span class="grow-spacer"></span>`
  if (btnLabel) {
    const b = document.createElement('button')
    b.className = kind === 'ok' ? 'btn-primary mini' : 'btn-secondary mini'
    b.textContent = btnLabel
    b.addEventListener('click', btnAction)
    d.appendChild(b)
  }
  feedBox().appendChild(d); feedScroll()
}

// enruta un evento estructurado del agente al feed
function editorPush(ev) {
  if (!ev) return
  if (ev.kind === 'text') feedMsg('assistant', ev.label)
  else if (ev.kind === 'cmd') feedActivity('$ ' + ev.label)
  else if (ev.kind === 'tool') feedActivity('· ' + ev.label)
  else el('editorStatus').textContent = '· ' + ev.label
}

// resumen corto de opciones para el pseudo-mensaje inicial del feed
function optsSummary(o) {
  const parts = [o.aspect === 'both' ? '16:9 + 9:16' : o.aspect]
  parts.push(o.subtitles ? 'subs' : 'sin subs')
  if (o.sfx) parts.push('SFX')
  if (o.cropMenubar) parts.push('sin barra de menú')
  if (o.tone) parts.push(`“${o.tone.slice(0, 40)}”`)
  return parts.join(' · ')
}

// --- sesión (continuidad de la conversación del agente) ---
function sessionResumeWanted() { return state.hasSession ? state.editorResume : false }
function updateSessionChip(hasSession) {
  state.hasSession = hasSession
  const chip = el('sessionChip')
  chip.classList.remove('hidden')
  if (!hasSession) {
    chip.textContent = 'conversación nueva'
    chip.style.pointerEvents = 'none'
    chip.title = ''
    return
  }
  chip.style.pointerEvents = ''
  chip.textContent = state.editorResume ? '🧠 continuará la conversación' : 'empezará de cero'
  chip.title = 'Cambiar entre continuar la conversación anterior o empezar de cero'
}

async function startCompose() {
  if (state.composing || !state.current) return
  const opts = currentOpts()
  const extraMsg = el('editorInput').value.trim()
  if (extraMsg) { opts.tone = (opts.tone ? opts.tone + '. ' : '') + extraMsg; el('editorInput').value = '' }
  await persistOpts()
  feedClear()
  el('composeLog').textContent = ''
  feedMsg('user', `Montar vídeo (${optsSummary(opts)})`)
  setEditorRunning(true)
  await window.studio.composeProject(state.current, opts, sessionResumeWanted())
}

async function sendEditorMessage() {
  if (state.composing) return
  const fb = el('editorInput').value.trim()
  if (!fb) { el('editorInput').focus(); return }
  const isFinal = state.detail && (state.detail.hasFinal || state.detail.hasFinal9x16)
  if (!isFinal) return startCompose() // sin final todavía: el mensaje entra como dirección de estilo
  await persistOpts()
  el('editorInput').value = ''
  feedMsg('user', fb)
  setEditorRunning(true)
  await window.studio.iterateProject(state.current, fb, currentOpts(), sessionResumeWanted())
}

// Reconstruye el feed desde el estado del job (reattach tras navegar o recargar).
// Tolera jobs antiguos que solo tienen `log` (líneas planas).
function restoreEditor(job) {
  feedClear()
  el('composeLog').textContent = (job.log || []).join('\n')
  const evs = job.events && job.events.length
    ? job.events
    : (job.log || []).map((m) => (m.startsWith('$ ') ? { kind: 'cmd', label: m.slice(2) } : m.startsWith('· ') ? { kind: 'tool', label: m.slice(2) } : { kind: 'status', label: m }))
  for (const ev of evs) editorPush(ev)
  if (job.status === 'running') { setEditorRunning(true); return }
  setEditorRunning(false)
  if (job.status === 'done') { el('editorStatus').textContent = '✓ listo'; feedResult('ok', 'Vídeo listo', 'Ver resultado →', () => setStage('resultado')) }
  else if (job.status === 'cancelled') { el('editorStatus').textContent = ''; feedResult('cancelled', 'Montaje cancelado') }
  else { el('editorStatus').textContent = ''; feedResult('err', job.error || 'error') }
}

// ---- Embedded Claude Code terminal -----------------------------------------
// "✨ Componer" opens a REAL interactive claude in an xterm panel (Opus 4.8, plan
// mode, seeded). The user watches it plan+execute and can keep chatting after.
let term = null
let fitAddon = null
let termResizeObs = null
let termWired = false

async function openTerminal(resume) {
  if (!state.current) return
  if (typeof window.Terminal !== 'function') { log('xterm no cargó', 'err'); return }
  await persistOpts()
  el('termPanel').classList.remove('hidden')
  el('termProj').textContent = state.currentName || ''
  el('termStatus').textContent = '· iniciando…'

  if (term) { try { term.dispose() } catch { /* ignore */ } term = null }
  term = new window.Terminal({
    fontFamily: 'Menlo, Monaco, "SF Mono", monospace', fontSize: 13, cursorBlink: true,
    scrollback: 8000, theme: { background: '#0c0c12', foreground: '#e6e6ee' },
  })
  fitAddon = new window.FitAddon.FitAddon()
  term.loadAddon(fitAddon)
  term.open(el('term'))
  try { fitAddon.fit() } catch { /* not laid out yet */ }
  term.focus()
  term.onData((d) => window.studio.terminal.sendInput(d))

  // pty → term: attach the IPC listeners ONCE; they reference the latest `term`.
  if (!termWired) {
    window.studio.terminal.onData((d) => { if (term) term.write(d) })
    window.studio.terminal.onExit((code) => { el('termStatus').textContent = `· sesión terminada (código ${code})` })
    termWired = true
  }

  if (termResizeObs) termResizeObs.disconnect()
  termResizeObs = new ResizeObserver(() => {
    try { fitAddon.fit(); window.studio.terminal.resize(term.cols, term.rows) } catch { /* ignore */ }
  })
  termResizeObs.observe(el('term'))

  const res = await window.studio.terminal.start({ dir: state.current, resume, opts: currentOpts(), cols: term.cols, rows: term.rows })
  if (!res || !res.ok) {
    if (res && res.fallback === 'system-terminal') el('termStatus').textContent = '· abierto en la Terminal del sistema (PTY embebido no disponible)'
    else el('termStatus').textContent = '· error: ' + ((res && res.error) || 'no arrancó')
    return
  }
  el('termStatus').textContent = resume ? '· continuando la conversación…' : '· Opus 4.8 · modo plan — te propondrá el montaje'
  try { window.studio.terminal.resize(term.cols, term.rows) } catch { /* ignore */ }
}

function closeTerminal() {
  try { window.studio.terminal.kill() } catch { /* ignore */ }
  if (termResizeObs) { termResizeObs.disconnect(); termResizeObs = null }
  if (term) { try { term.dispose() } catch { /* ignore */ } term = null }
  const p = el('termPanel'); if (p) p.classList.add('hidden')
}
async function cancelCompose() {
  await window.studio.agentCancel(state.current)
  el('editorStatus').textContent = '· cancelando…'
}

// route headless-agent events: compose (key = project dir) or scripts (key = 'style'/'script')
window.studio.onAgentProgress(({ key, msg, ev }) => {
  if (key === state.current) {
    appendComposeLog(msg)
    editorPush(ev || { kind: 'status', label: msg })
  } else if (key === 'style' || key === 'script') scriptProgress(key, msg)
})
window.studio.onAgentDone(async ({ key, ok, result, error }) => {
  if (key === state.current) {
    setEditorRunning(false)
    feedFinishActivity()
    if (ok) {
      el('editorStatus').textContent = '✓ listo'
      const idx = state.projects.findIndex((p) => p.dir === key)
      if (idx >= 0 && result && result.summary) state.projects[idx] = result.summary
      // refresca los datos del proyecto sin resetear la etapa ni el feed
      const d = await window.studio.projectDetail(key)
      if (d && state.current === key) {
        state.detail = d
        renderDetail(d)
        renderPipeline(d, null)
        updateSessionChip(true)
      }
      feedResult('ok', 'Vídeo listo', 'Ver resultado →', () => setStage('resultado'))
      toast('✓ Vídeo montado', 'ok')
    } else if (error === 'cancelado') {
      el('editorStatus').textContent = ''
      feedResult('cancelled', 'Montaje cancelado')
    } else {
      el('editorStatus').textContent = ''
      feedResult('err', '✗ ' + (error || 'error'))
      toast('✗ El montaje falló', 'err')
    }
  } else if (key === 'style' || key === 'script') {
    scriptDone(key, ok, result, error)
  }
})

// ---- Source picker (record view) -------------------------------------------

async function loadSources() {
  el('sourcesGrid').innerHTML = '<div class="empty">Cargando fuentes…</div>'
  try { state.sources = await window.studio.listSources(); renderSources() }
  catch (e) { el('sourcesGrid').innerHTML = '<div class="empty">Error listando fuentes</div>'; log('error fuentes: ' + e.message, 'err') }
}
function renderSources() {
  const grid = el('sourcesGrid'); grid.innerHTML = ''
  for (const s of state.sources) {
    const card = document.createElement('div')
    const sel = s.id === state.selectedSourceId
    card.className = 'source-card' + (sel ? ' selected' : '') + (s.isApp ? ' is-app' : '')
    const kind = s.kind === 'screen' ? `${icon('screen', 'icon icon-sm')} pantalla` : `${icon('window', 'icon icon-sm')} ventana`
    const meta = s.detail ? `<span class="src-detail">${escapeHtml(s.detail)}</span>` : ''
    card.innerHTML = `<img src="${s.thumbnail}" alt="" />
      ${sel ? '<span class="src-live">● GRABANDO ESTO</span>' : ''}
      <div class="cap">
        <div class="kind">${kind}${meta}</div>
        <div class="src-name">${escapeHtml(s.name)}</div>
      </div>`
    card.addEventListener('click', () => selectSource(s.id))
    grid.appendChild(card)
  }
  updateScreenCaption()
}
// Reflect the chosen source right under the big preview so it's unmistakable.
function updateScreenCaption() {
  const cap = el('screenCap')
  if (!cap) return
  const s = state.sources.find((x) => x.id === state.selectedSourceId)
  if (!s) { cap.textContent = 'Pantalla — elige una fuente a la izquierda'; return }
  const extra = s.detail ? ` · ${s.detail}` : ''
  cap.textContent = `${s.kind === 'screen' ? 'Pantalla' : 'Ventana'} · ${s.name}${extra}`
}
async function selectSource(id) {
  if (state.recording) return
  state.selectedSourceId = id; renderSources()
  await startScreenPreview(id); updateReady()
}

// ---- Devices + previews ----------------------------------------------------

async function listDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    fillSelect(el('camSelect'), devices.filter((d) => d.kind === 'videoinput'), state.camId, 'Cámara')
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
  stopStream(state.screenStream)
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } },
    })
    state.screenStream = stream
    el('screenPreview').srcObject = stream
    const st = stream.getVideoTracks()[0].getSettings()
    state.dims.screen = { width: st.width || 1920, height: st.height || 1080 }
  } catch (e) { log('error pantalla: ' + e.message, 'err') }
}

async function startCamPreview() {
  // tear down any previous pipeline + streams
  if (state.pipe) { state.pipe.stop(); state.pipe = null }
  if (state.camStream && state.camStream !== state.rawCam) stopStream(state.camStream)
  stopStream(state.rawCam)
  state.rawCam = null

  const RES = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
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
        log('dispositivo guardado no disponible, usando el predeterminado…', 'warn')
        state.camId = null; state.micId = null
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
      NotReadableError: 'la cámara o el micro están EN USO por otra app (Zoom, Photo Booth, QuickTime, Chrome…). Ciérrala y reintenta.',
      NotAllowedError: 'permiso denegado. Da acceso a Cámara y Micrófono en Ajustes del sistema › Privacidad y seguridad.',
      OverconstrainedError: 'el dispositivo seleccionado ya no existe. Elige otro en los desplegables.',
      NotFoundError: 'no se detecta ninguna cámara/micrófono.',
      AbortError: 'el sistema interrumpió la cámara. Reintenta.',
    }[e.name]
    log(`error webcam/micro [${e.name}]: ${e.message}${hint ? ' — ' + hint : ''}`, 'err')
  }
}

function syncBlurUi() {
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
    log('la imagen de fondo guardada ya no existe, se quita', 'warn')
    state.bgPath = ''
    localStorage.removeItem('rs_bgpath')
  }
  syncBlurUi()
}

async function applyBackground(res) {
  state.bgPath = res.path
  state.bgData = res
  localStorage.setItem('rs_bgpath', res.path)
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
  localStorage.removeItem('rs_bgpath')
  syncBlurUi()
  if (state.pipe && state.pipe.setBackground) await state.pipe.setBackground(null)
}

async function toggleBlur() {
  if (state.recording) { el('blurToggle').checked = state.blur; return } // fixed during capture
  state.blur = el('blurToggle').checked
  localStorage.setItem('rs_blur', state.blur ? '1' : '0')
  syncBlurUi()
  await startCamPreview()
}

// Live blur-intensity slider — applies instantly to the running pipeline, no
// camera restart (so there's no flicker/black-frame while dragging).
function onBlurLevel(e) {
  state.blurLevel = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0))
  localStorage.setItem('rs_blurlevel', String(state.blurLevel))
  if (state.pipe && state.pipe.setBlurAmount) state.pipe.setBlurAmount(state.blurLevel / 100)
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

function saveCropRect() { localStorage.setItem('rs_crop_rect', JSON.stringify(state.cropRect)) }

function syncCropUi() {
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
  localStorage.setItem('rs_crop', state.crop ? '1' : '0')
  syncCropUi()
}

function setCropAspect(v) {
  if (state.recording) return
  state.cropAr = (v === 'free') ? null : parseFloat(v)
  localStorage.setItem('rs_crop_ar', v)
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
  localStorage.setItem('rs_sysaudio', state.sysAudio ? '1' : '0')
}

async function enableSystemAudio() {
  try {
    // video is mandatory for getDisplayMedia; we keep only the audio track.
    const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    disp.getVideoTracks().forEach((t) => t.stop())
    const sysTrack = disp.getAudioTracks()[0]
    if (!sysTrack) {
      log('este macOS/Electron no entregó audio del sistema (loopback no disponible)', 'err')
      disp.getTracks().forEach((t) => t.stop())
      return false
    }
    state.sysStream = new MediaStream([sysTrack])
    buildAudioMix()
    log('🔊 sonido del sistema activado (se mezcla con tu voz)', 'ok')
    return true
  } catch (e) {
    log(`no se pudo capturar el sonido del sistema [${e.name}]: ${e.message}`, 'err')
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
// record view. Never while actually recording.
function stopCam() {
  if (state.recording) return
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

async function changeCam() { state.camId = el('camSelect').value; localStorage.setItem('rs_cam', state.camId); await startCamPreview() }
async function changeMic() { state.micId = el('micSelect').value; localStorage.setItem('rs_mic', state.micId); await startCamPreview() }

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
  const ready = state.selectedSourceId && state.camStream && state.current && !state.recording
  el('recBtn').disabled = !ready
  if (state.selectedSourceId && !state.recording) el('recHint').textContent = `Grabarás en: ${state.currentName}`
}

// ---- Countdown -------------------------------------------------------------

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
      else if (n === 0) show('¡YA!', true)
      else { clearInterval(iv); el('countdown').classList.add('hidden'); resolve() }
    }, 900)
  })
}

// ---- Recording -------------------------------------------------------------

function pickMime(withAudio) {
  const cs = withAudio
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  for (const c of cs) if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c
  return 'video/webm'
}
async function beginRecording() {
  if (state.recording || !state.current) return
  el('recBtn').disabled = true; setStatus('preparando')
  await runCountdown(3); startRecording()
}
// `fromFloat`: the recording was (re)started from the floating bar, so the main
// window is already hidden and the bar + shortcuts are already up — don't re-arm them.
function startRecording(fromFloat = false) {
  if (!state.screenStream || !state.camStream) { log('faltan streams', 'err'); return }
  state.chunks = { screen: [], webcam: [] }
  // The preview keeps showing the FULL frame; the recorder gets the cropped one.
  let camForRec = state.camStream
  state.recWebcamDims = null
  if (state.crop && state.cropRect && window.CamCrop) {
    try {
      state.cropPipe = new CamCrop()
      camForRec = state.cropPipe.start(state.camStream, state.cropRect)
      state.recWebcamDims = state.cropPipe.outDims
      log(`✂️ grabando recorte ${state.recWebcamDims.width}×${state.recWebcamDims.height}`)
    } catch (e) { log('recorte falló, grabo cámara completa: ' + e.message, 'warn'); camForRec = state.camStream; state.cropPipe = null }
  }
  // Pick the audio track for the cam recorder: the mic+system MIX when enabled,
  // otherwise the plain mic. webcam.webm stays the single audio source.
  const recVideoTrack = camForRec.getVideoTracks()[0]
  const recAudioTrack = (state.sysAudio && state.mixedAudioTrack) ? state.mixedAudioTrack : state.camStream.getAudioTracks()[0]
  if (recVideoTrack && recAudioTrack) camForRec = new MediaStream([recVideoTrack, recAudioTrack])
  if (state.sysAudio && state.mixedAudioTrack) log('🔊 grabando voz + sonido del sistema')
  console.log('[rec] cam tracks', camForRec.getTracks().map((t) => `${t.kind}:${t.readyState}`).join(','),
    '| screen', state.screenStream.getTracks().map((t) => `${t.kind}:${t.readyState}`).join(','))
  // If a recorded track ends mid-take (a stalled crop/mix generator), that's the
  // classic "stop does nothing" freeze — log it loudly.
  camForRec.getTracks().forEach((t) => t.addEventListener('ended', () => { console.error('[rec] cam track ENDED mid-recording:', t.kind); log(`⚠ pista ${t.kind} se cortó durante la grabación`, 'err') }))
  const screenRec = new MediaRecorder(state.screenStream, { mimeType: pickMime(false), videoBitsPerSecond: 8_000_000 })
  const camRec = new MediaRecorder(camForRec, { mimeType: pickMime(true), videoBitsPerSecond: 4_000_000 })
  screenRec.ondataavailable = (e) => { if (e.data.size) state.chunks.screen.push(e.data) }
  camRec.ondataavailable = (e) => { if (e.data.size) state.chunks.webcam.push(e.data) }
  screenRec.onstart = () => { state.starts.screen = performance.now() }
  camRec.onstart = () => { state.starts.webcam = performance.now() }
  screenRec.onerror = (e) => { console.error('[rec] screenRec error', e.error); log('⚠ error grabador pantalla: ' + (e.error && e.error.message), 'err') }
  camRec.onerror = (e) => { console.error('[rec] camRec error', e.error); log('⚠ error grabador cámara: ' + (e.error && e.error.message), 'err') }
  state.recorders = [screenRec, camRec]
  try { screenRec.start(1000); camRec.start(1000) } catch (e) { console.error('[rec] start() falló', e); log('⚠ no se pudo iniciar la grabación: ' + e.message, 'err') }

  state.recording = true; state.paused = false; state.pausedTotal = 0; state.tStart = performance.now()
  setStatus('grabando', 'recording')
  el('pauseBtn').disabled = false; el('pauseBtn').textContent = 'Pausar'; el('pauseBtn').className = 'pause'
  el('stopBtn').disabled = false; el('recHint').textContent = ''
  log('● grabando…')
  if (!fromFloat) window.studio.recordingStarted({ camId: state.camId, blur: state.blur, blurLevel: state.blurLevel, bg: state.bgData ? state.bgData.dataUrl : null, crop: state.crop, cropRect: state.crop ? state.cropRect : null }) // hide window + self-view bar + shortcuts
  else window.studio.sendElapsed({ text: '00:00', paused: false }) // flip the floating bar back to recording mode at once
  state.timerInt = setInterval(updateTimer, 250)
}
function pauseResume() {
  if (!state.recording) return
  if (!state.paused) {
    state.recorders.forEach((r) => r.state === 'recording' && r.pause())
    state.paused = true; state.pauseStart = performance.now()
    setStatus('pausado'); el('pauseBtn').textContent = 'Seguir'; el('pauseBtn').className = 'pause resume'; log('⏸ pausado')
  } else {
    state.pausedTotal += performance.now() - state.pauseStart
    state.recorders.forEach((r) => r.state === 'paused' && r.resume())
    state.paused = false; setStatus('grabando', 'recording'); el('pauseBtn').textContent = 'Pausar'; el('pauseBtn').className = 'pause'; log('▶ seguir')
  }
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
  window.studio.sendElapsed({ text: txt, paused: state.paused })
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
    setTimeout(finish, 5000)
  })))
}

// `returnToMain=false` (the floating ■ button): finalize + save the clip but stay
// in floating mode so the user can immediately grab another clip. `true` (from the
// main window, or the floating ✓): also restore the main window.
async function stopRecording(returnToMain = true) {
  if (!state.recording) return
  el('pauseBtn').disabled = true; el('stopBtn').disabled = true; setStatus('procesando')
  clearInterval(state.timerInt)
  const durationMs = elapsedMs()
  await stopRecorders(state.recorders)
  teardownCrop() // stop the crop pipeline once the recorder has flushed its last frame
  state.recording = false; state.paused = false
  if (returnToMain) window.studio.recordingStopped() // restore window, kill floating bar + shortcuts
  updateReady()
  await saveClip(durationMs) // sets the post-save hint last, so it isn't overwritten
  if (!returnToMain) window.studio.floatIdle({ clips: state.detail ? state.detail.clipCount : 0 }) // stay floating, flip bar to idle
  setStatus('hecho', 'done')
}
// Floating ● button: start the next clip without reopening the main window.
function recordFromFloat() {
  if (state.recording || !state.current) return
  if (!state.screenStream || !state.camStream) { log('faltan streams', 'err'); return }
  startRecording(true)
}
// Floating ✓ button: end the session and go back to the main window
// (saving the in-progress clip first if we're still recording).
async function finishFromFloat() {
  if (state.recording) await stopRecording(true)
  else window.studio.recordingStopped()
}
async function saveClip(durationMs) {
  const screenBlob = new Blob(state.chunks.screen, { type: 'video/webm' })
  const camBlob = new Blob(state.chunks.webcam, { type: 'video/webm' })
  const offsetMs = state.starts.webcam - state.starts.screen
  log('guardando clip…')
  const summary = await window.studio.appendClip({
    dir: state.current,
    screenBuf: await screenBlob.arrayBuffer(),
    webcamBuf: await camBlob.arrayBuffer(),
    durationMs, offsetMs,
    dims: { screen: actualDims(el('screenPreview'), state.dims.screen), webcam: state.recWebcamDims || actualDims(el('camPreview'), state.dims.webcam) },
  })
  const idx = state.projects.findIndex((p) => p.dir === summary.dir)
  if (idx >= 0) state.projects[idx] = summary; else state.projects.unshift(summary)
  state.detail = summary
  updateClipsCta()
  renderRecClips() // refresh the strip at the bottom of the record view
  el('doneMsg').textContent = `✓ Clip ${summary.clipCount} guardado (${(durationMs / 1000).toFixed(1)}s)`
  el('recHint').textContent = `Listo. Tienes ${summary.clipCount} clip${summary.clipCount > 1 ? 's' : ''}.`
  log(`✓ ${summary.clipCount}º clip guardado (${(durationMs / 1000).toFixed(1)}s)`, 'ok')
  toast(`✓ Clip ${summary.clipCount} guardado (${(durationMs / 1000).toFixed(1)}s)`, 'ok')
}

// ---- Modals ----------------------------------------------------------------

let modalResolver = null
function openPrompt(title, value = '') {
  return new Promise((resolve) => {
    modalResolver = resolve
    el('modalTitle').textContent = title
    el('modalText').classList.add('hidden')
    const input = el('modalInput'); input.classList.remove('hidden'); input.value = value
    el('modal').classList.remove('hidden'); input.focus(); input.select()
  })
}
function openConfirm(title, text, opts = {}) {
  return new Promise((resolve) => {
    modalResolver = resolve
    el('modalTitle').textContent = title
    el('modalText').textContent = text; el('modalText').classList.remove('hidden')
    el('modalInput').classList.add('hidden')
    const card = el('modal').querySelector('.modal-card')
    card.classList.toggle('danger', !!opts.danger)
    el('modalOk').textContent = opts.danger ? opts.okLabel || 'Borrar' : 'OK'
    el('modal').classList.remove('hidden')
  })
}
function closeModal(result) {
  el('modal').classList.add('hidden')
  const card = el('modal').querySelector('.modal-card')
  card.classList.remove('danger')
  el('modalOk').textContent = 'OK'
  const r = modalResolver; modalResolver = null
  if (r) r(result)
}
function openVideo(src) {
  el('modalVideo').src = src
  el('videoModal').classList.remove('hidden')
  el('modalVideo').play().catch(() => {})
}
function closeVideo() {
  el('modalVideo').pause(); el('modalVideo').removeAttribute('src'); el('modalVideo').load()
  el('videoModal').classList.add('hidden')
}

// ---- helpers ---------------------------------------------------------------

function fmtDur(ms) { const s = Math.round((ms || 0) / 1000); const m = Math.floor(s / 60); return m ? `${m}m ${s % 60}s` : `${s}s` }
function fmtDate(st) { if (!st || st.length < 15) return ''; return `${st.slice(6, 8)}/${st.slice(4, 6)}/${st.slice(0, 4)} ${st.slice(9, 11)}:${st.slice(11, 13)}` }
function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }

// Strip leftover Markdown so scripts show as clean plain text.
function plainText(s) {
  return (s || '')
    .replace(/^\s*#{1,6}\s*/gm, '')          // headings
    .replace(/\*\*(.*?)\*\*/g, '$1')          // **bold**
    .replace(/(?<!\*)\*(?!\*)(.*?)\*/g, '$1') // *italic*
    .replace(/`([^`]*)`/g, '$1')              // `code`
    .replace(/^\s*[-*]\s+/gm, '')             // - bullets
    .replace(/^\s*\[([^\]]+)\]\s*$/gm, '$1')  // [HOOK] label line -> HOOK
}

// ---- Wire up ---------------------------------------------------------------

el('chooseRoot').addEventListener('click', chooseRoot)
el('onbChoose').addEventListener('click', chooseRoot)
el('navProjects').addEventListener('click', showHome)
el('navScripts').addEventListener('click', showScripts)
el('analyzeBtn').addEventListener('click', analyzeChannel)
el('generateBtn').addEventListener('click', generateScript)
el('rewriteBtn').addEventListener('click', rewriteScript)
el('saveScriptBtn').addEventListener('click', saveCurrentScript)
el('copyScriptBtn').addEventListener('click', copyScript)
el('recordScriptBtn').addEventListener('click', recordWithScript)
el('cancelScriptBtn').addEventListener('click', async () => { await window.studio.agentCancel('style'); await window.studio.agentCancel('script') })
el('toggleScriptLog').addEventListener('click', () => {
  const hidden = el('scriptLog').classList.toggle('hidden')
  el('toggleScriptLog').textContent = hidden ? '▸ Ver progreso' : '▾ Ocultar progreso'
})
el('createProj').addEventListener('click', createProject)
el('newName').addEventListener('keydown', (e) => { if (e.key === 'Enter') createProject() })
el('backHome').addEventListener('click', showHome)
el('renameProj').addEventListener('click', renameProject)
el('deleteProj').addEventListener('click', deleteProject)
el('openFolder').addEventListener('click', () => window.studio.revealPath(state.current))
el('recHere').addEventListener('click', () => showRecord(state.current, state.currentName))
el('backProject').addEventListener('click', () => openProject(state.current))
el('doneRec').addEventListener('click', () => openProject(state.current))
on('doneAgain', 'click', beginRecording)
el('tpToggle').addEventListener('click', toggleTeleprompter)
el('tpEdit').addEventListener('click', toggleTpEditor)
el('tpSave').addEventListener('click', saveTeleprompter)
el('clipCount').addEventListener('click', () => { if (currentClipCount() > 0) openProject(state.current) })
el('refreshSources').addEventListener('click', loadSources)
el('camSelect').addEventListener('change', changeCam)
el('micSelect').addEventListener('change', changeMic)
el('blurToggle').addEventListener('change', toggleBlur)
el('blurLevel').addEventListener('input', onBlurLevel)
el('bgPick').addEventListener('click', pickBackground)
el('bgClear').addEventListener('click', clearBackground)
el('bgSelect').addEventListener('change', onBgSelect)
el('sysAudioToggle').addEventListener('change', toggleSysAudio)
el('cropToggle').addEventListener('change', toggleCrop)
el('cropReset').addEventListener('click', resetCrop)
document.querySelectorAll('#cropTools .ar-btn').forEach((b) => b.addEventListener('click', () => setCropAspect(b.dataset.ar)))
initCropInteractions()
el('recBtn').addEventListener('click', beginRecording)
el('pauseBtn').addEventListener('click', pauseResume)
el('stopBtn').addEventListener('click', () => stopRecording(true))

// --- Editor (etapa Montar) ---
on('composeBtn', 'click', startCompose)
on('editorSend', 'click', sendEditorMessage)
on('editorInput', 'keydown', (e) => { if (e.key === 'Enter') sendEditorMessage() })
on('cancelBtn', 'click', cancelCompose)
on('termClose', 'click', closeTerminal)
on('sessionChip', 'click', () => { state.editorResume = !state.editorResume; updateSessionChip(state.hasSession) })
on('editorAdv', 'click', (e) => { e.stopPropagation(); el('editorAdvMenu').classList.toggle('hidden') })
document.addEventListener('click', (e) => {
  const m = el('editorAdvMenu')
  if (m && !m.classList.contains('hidden') && !m.contains(e.target) && e.target !== el('editorAdv')) m.classList.add('hidden')
})
on('advTermNew', 'click', () => { el('editorAdvMenu').classList.add('hidden'); openTerminal(false) })
on('advTermCont', 'click', () => { el('editorAdvMenu').classList.add('hidden'); openTerminal(true) })
on('advRawLog', 'click', () => { el('editorAdvMenu').classList.add('hidden'); el('composeLog').classList.toggle('hidden') })

// --- stepper del pipeline ---
document.querySelectorAll('#pipeline .pl-step').forEach((b) => b.addEventListener('click', () => setStage(b.dataset.stage)))

// --- opciones de montaje (barra siempre visible) ---
document.querySelectorAll('#aspectSeg button').forEach((b) =>
  b.addEventListener('click', () => { setSegActive('aspectSeg', 'aspect', b.dataset.aspect); persistOpts() }))
document.querySelectorAll('#pipPicker button').forEach((b) =>
  b.addEventListener('click', () => { setSegActive('pipPicker', 'pip', b.dataset.pip); persistOpts() }))
;['optSubs', 'optModel', 'optCrop', 'optSfx'].forEach((id) => on(id, 'change', persistOpts))
on('optTone', 'blur', persistOpts)
el('modalOk').addEventListener('click', () => closeModal(el('modalInput').classList.contains('hidden') ? true : el('modalInput').value))
el('modalCancel').addEventListener('click', () => closeModal(el('modalInput').classList.contains('hidden') ? false : null))
el('modalInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') closeModal(el('modalInput').value) })
el('videoModalClose').addEventListener('click', closeVideo)

// global shortcut / floating bar control routed from main
window.studio.onRemoteControl((which) => {
  // `record` / `done` act while idle (between clips); the rest need an active take.
  if (which === 'record') return recordFromFloat()
  if (which === 'done') return finishFromFloat()
  if (!state.recording) return
  if (which === 'pause') pauseResume()
  else if (which === 'stop') stopRecording(false) // save clip, keep floating
  else if (which === 'restart') discardTake(true)
})
window.studio.onTpClosed(() => { state.tpVisible = false; updateTpToggle() })
window.studio.onTpSaved(async ({ text, path }) => {
  el('tpText').value = text
  if (state.current) { await window.studio.setTeleprompter(state.current, text); if (state.detail) state.detail.teleprompter = text }
  if (path) await window.studio.saveScript(path, text) // auto-save back to the loaded guion file
})
window.studio.onTpLoaded(async ({ path, text }) => {
  state.tpLoadedPath = path || ''
  el('tpText').value = text || ''
  if (state.current) { await window.studio.setTeleprompter(state.current, text || ''); if (state.detail) state.detail.teleprompter = text || '' }
  log('guion cargado en el teleprompter', 'ok')
})

window.addEventListener('DOMContentLoaded', async () => {
  loadBgPresets()
  await loadSources()
  showHome() // camera stays OFF until you enter the Record view
})
