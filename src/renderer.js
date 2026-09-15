'use strict'

// ----------------------------------------------------------------------------
// VibeTube — renderer (Home → Detail → Record)
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
  try { log(`⚠ error: ${e.message}`, 'err'); toast('⚠ Error: ' + e.message, 'err', 6000) } catch { /* log not ready */ }
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  console.error('[unhandledrejection]', (r && (r.stack || r.message)) || r)
  try { log(`⚠ promesa fallida: ${(r && r.message) || r}`, 'err'); toast('⚠ ' + ((r && r.message) || r), 'err', 6000) } catch { /* log not ready */ }
})

// Ajustes durables (userData/settings.json) — localStorage queda como caché de
// arranque para no esperar al IPC. `persist()` escribe en los dos.
function persist(obj) {
  for (const [k, v] of Object.entries(obj)) {
    try { if (v == null) localStorage.removeItem('rs_' + k); else localStorage.setItem('rs_' + k, typeof v === 'string' ? v : JSON.stringify(v)) } catch { /* lleno o bloqueado */ }
  }
  window.studio.settingsSet(obj).catch((e) => console.warn('[settings] no guardado:', e.message))
}
function setRoot(dir) { state.root = dir; persist({ root: dir }) }
// Carga los ajustes de main y pisa los de localStorage (fuente de verdad).
async function loadSettings() {
  let s = null
  try { s = await window.studio.settingsGet() } catch { return }
  if (!s) return
  state.agentProvider = s.agentProvider === 'codex' ? 'codex' : 'claude'
  el('agentProvider').value = state.agentProvider
  if (s.root) state.root = s.root
  if (s.channel) state.channel = s.channel
  if (s.cam) state.camId = s.cam
  if (s.mic) state.micId = s.mic
  if (typeof s.blur === 'boolean') state.blur = s.blur
  if (typeof s.rawrecord === 'boolean') state.rawRecord = s.rawrecord
  if (typeof s.finalBackground === 'boolean') state.finalBackground = s.finalBackground
  if (typeof s.blurlevel === 'number') state.blurLevel = s.blurlevel
  if (typeof s.bgpath === 'string') state.bgPath = s.bgpath
  if (typeof s.crop === 'boolean') state.crop = s.crop
  if (s.crop_rect && typeof s.crop_rect === 'object') state.cropRect = s.crop_rect
  if ('crop_ar' in s) state.cropAr = s.crop_ar && s.crop_ar !== 'free' ? parseFloat(s.crop_ar) : null
  if (typeof s.sysaudio === 'boolean') state.sysAudio = s.sysaudio
  if (typeof s.keepMainVisible === 'boolean') state.keepMainVisible = s.keepMainVisible
  state.recentRoots = s.recentRoots || []
}

const state = {
  agentProvider: 'claude',
  keepMainVisible: localStorage.getItem('rs_keepMainVisible') === 'true',
  recentRoots: [],
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
  // Native cameras default to automatic matting after capture. rawRecord is
  // the separate option to leave background editing to the manual montage.
  rawRecord: localStorage.getItem('rs_rawrecord') === '1',
  finalBackground: localStorage.getItem('rs_finalBackground') !== 'false',
  nativeCamera: false,
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
  recordingSession: null, // project owned by the floating recorder, independent of navigation
  recordingBusy: false, // countdown/startup or flushing a clip
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
  if (state.recording && !state.recordingBusy) {
    text = state.paused ? 'pausado' : 'grabando'
    cls = state.paused ? '' : 'recording'
    el('timer').classList.remove('hidden')
  }
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
    if (p.go && !isLast) seg.addEventListener('click', () => p.go())
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
  el('timer').classList.add('hidden'); setCrumb(''); setStatus('ready'); setNav('projects'); loadHome()
}
async function openProject(dir, stage) {
  stopCam()
  const d = await window.studio.projectDetail(dir)
  if (!d) { return }
  // Al cambiar de proyecto se descartan títulos, descripción y resultados del
  // anterior: si no, el panel de publicación enseña los del proyecto previo.
  if (state.current !== d.dir) resetPublish()
  state.current = d.dir; state.currentName = d.name; state.detail = d
  renderDetail(d)
  hideAll(); el('viewProject').classList.remove('hidden')
  el('timer').classList.add('hidden'); setStatus('ready'); setNav('projects')
  const job = await window.studio.agentStatus(dir)
  renderPipeline(d, job)
  renderOrphans(d)
  renderAgentCost(d)
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

const STAGE_LABEL = { grabar: 'Record', montar: 'Edit', resultado: 'Result' }
function setStage(stage) {
  state.stage = stage
  document.querySelectorAll('#viewProject .stage-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.stage !== stage))
  document.querySelectorAll('#pipeline .pl-step').forEach((b) => b.classList.toggle('active', b.dataset.stage === stage))
  if (state.currentName) {
    setCrumb([
      { label: 'Projects', go: showHome },
      { label: state.currentName, go: () => openProject(state.current) },
      { label: STAGE_LABEL[stage] || '' },
    ])
  }
}
function renderPipeline(d, job) {
  const isFinal = d.hasFinal || d.hasFinal9x16
  const running = !!(job && job.status === 'running')
  el('plClips').textContent = d.clipCount ? `${d.clipCount} clip${d.clipCount > 1 ? 's' : ''}` : '—'
  el('plMontar').textContent = running ? 'editing…' : isFinal ? 'done ✓' : d.clipCount ? 'pending' : '—'
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
    { label: 'Projects', go: showHome },
    { label: name, go: () => openProject(dir) },
    { label: 'Record' },
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
  loadSources()
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
  el('tpToggleLbl').textContent = state.tpVisible ? 'Hide teleprompter' : 'Show teleprompter'
}
function toggleTeleprompter() {
  if (state.tpVisible) { window.studio.hideTeleprompter(); state.tpVisible = false }
  else { window.studio.showTeleprompter(tpPayload(el('tpText').value)); state.tpVisible = true } // open even if empty: you can load a script
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
  const dir = state.current
  const d = await window.studio.projectDetail(dir)
  if (state.current !== dir) return
  state.detail = d
  updateClipsCta()
  const box = el('recClips'); box.innerHTML = ''
  if (!d.clips.length) { box.innerHTML = '<div class="empty">No clips recorded yet.</div>'; return }
  d.clips.forEach((c, i) => {
    const card = document.createElement('div'); card.className = 'rec-clip'; card.dataset.clip = c.id
    const thumb = c.thumbDataUrl ? `style="background-image:url('${c.thumbDataUrl}')"` : ''
    card.innerHTML = `
      <div class="rc-thumb" ${thumb}><button class="rc-play" title="reproducir">${icon('play', 'icon icon-sm')}</button><span class="dur-chip">${fmtDur(c.durationMs)}</span>${clipStatusChip(c)}</div>
      <div class="rc-row"><span>Clip ${i + 1}</span><button class="rc-del danger" title="delete">${icon('trash', 'icon icon-sm')}</button></div>`
    wireCameraPlayback(card, '.rc-play', c, d.dir)
    card.querySelector('.rc-del').addEventListener('click', async () => {
      const ok = await openConfirm('Delete clip', `Delete Clip ${i + 1}? It will be moved to the trash.`, { danger: true })
      if (!ok) return
      await window.studio.deleteClip(state.current, c.id)
      renderRecClips()
    })
    box.appendChild(card)
  })
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
  const dir = await window.studio.chooseDir('Root folder for projects')
  if (!dir) return
  setRoot(dir); await loadHome()
}
async function loadHome() {
  const hasRoot = !!state.root
  el('onboarding').classList.toggle('hidden', hasRoot)
  el('projectsPanel').classList.toggle('hidden', !hasRoot)
  if (!hasRoot) return
  el('rootPath').textContent = state.root
  renderRecentRoots()
  state.projects = await window.studio.listProjects(state.root)
  renderGallery()
}
function renderRecentRoots() {
  const sel = el('recentRoots')
  if (!sel) return
  const list = (state.recentRoots || []).filter((d) => d !== state.root)
  sel.classList.toggle('hidden', !list.length)
  sel.innerHTML = '<option value="">recent…</option>' + list.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d.split('/').slice(-2).join('/'))}</option>`).join('')
}
function renderGallery() {
  const grid = el('projectsGrid'); grid.innerHTML = ''
  const addCard = document.createElement('div')
  addCard.className = 'project-card new-card'
  addCard.innerHTML = `<div class="poster add">${icon('plus', 'icon icon-lg')}</div><div class="info"><div class="pname">New project</div><div class="meta">record new clips</div></div>`
  addCard.addEventListener('click', () => el('newName').focus())
  grid.appendChild(addCard)
  for (const p of state.projects) {
    const card = document.createElement('div')
    card.className = 'project-card'
    const posterStyle = p.previewDataUrl ? `style="background-image:url('${p.previewDataUrl}')"` : ''
    const isFinal = p.hasFinal || p.hasFinal9x16
    const badgeTxt = isFinal ? (p.hasFinal && p.hasFinal9x16 ? 'final ✓ +9:16' : 'final ✓') : 'draft'
    const durChip = p.durationMs ? `<span class="dur-chip">${fmtDur(p.durationMs)}</span>` : ''
    card.innerHTML = `
      <div class="poster" ${posterStyle}>${p.previewDataUrl ? '' : 'no preview'}${durChip}</div>
      <span class="badge ${isFinal ? 'final' : 'draft'}">${badgeTxt}</span>
      <div class="info">
        <div class="pname">${escapeHtml(p.name)}</div>
        <div class="meta">${p.clipCount} clip(s) · ${fmtDur(p.durationMs)} · ${fmtDate(p.created)}${p.warnings ? ` · <span class="st-bad">⚠ ${p.warnings}</span>` : ''}${p.orphanParts ? ' · <span class="st-warn">unfinished take</span>' : ''}${p.hasScript ? ' · script' : ''}</div>
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
    const dir = await window.studio.chooseDir('Root folder for projects')
    if (!dir) return
    setRoot(dir)
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
  el('detailBadge').textContent = isFinal ? (d.hasFinal && d.hasFinal9x16 ? 'final ✓ +9:16' : 'final ✓') : 'draft'
  el('detailBadge').className = 'badge ' + (isFinal ? 'final' : 'draft')

  // compose options (siempre visibles en la barra de la etapa Montar)
  const o = d.composeOpts || {}
  // Los proyectos antiguos guardaban aspect '16:9' pero el montaje siempre generó
  // ambos formatos; sin el marcador aspectV2 ese valor significa 'both'.
  const aspect = o.aspect === '9:16' || o.aspect === 'both' ? o.aspect : o.aspectV2 && o.aspect === '16:9' ? '16:9' : 'both'
  setSegActive('aspectSeg', 'aspect', aspect)
  el('optSubs').checked = o.subtitles !== false
  if (el('optVoice')) el('optVoice').checked = o.voiceEnhance !== false
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
    grid.innerHTML = '<div class="empty">No clips yet. Hit “● Record clip”.</div>'
  } else {
    d.clips.forEach((c, i) => {
      const card = document.createElement('div')
      card.className = 'clip-card'
      const thumbStyle = c.thumbDataUrl ? `style="background-image:url('${c.thumbDataUrl}')"` : ''
      card.dataset.clip = c.id
      card.innerHTML = `
        <div class="clip-thumb" ${thumbStyle}><button class="clip-play" title="reproducir">${icon('play', 'icon icon-sm')}</button><span class="dur-chip">${fmtDur(c.durationMs)}</span>${clipStatusChip(c)}</div>
        <div class="clip-row">
          <span class="clip-meta">Clip ${i + 1}</span>
          <span class="clip-btns">
            <button data-a="enhance" title="Enhance audio with NVIDIA Studio Voice">${icon('sparkle', 'icon icon-sm')}</button>
            <button data-a="up" title="subir" ${i === 0 ? 'disabled' : ''}>${icon('chevron-up', 'icon icon-sm')}</button>
            <button data-a="down" title="bajar" ${i === d.clips.length - 1 ? 'disabled' : ''}>${icon('chevron-down', 'icon icon-sm')}</button>
            <button data-a="del" class="danger" title="delete">${icon('trash', 'icon icon-sm')}</button>
          </span>
        </div>`
      wireCameraPlayback(card, '.clip-play', c, d.dir)
      card.querySelector('[data-a="enhance"]').addEventListener('click', async () => {
        toast(`Enhancing audio of ${c.id} with NVIDIA Studio Voice…`)
        card.querySelectorAll('.status-chip.st-check').forEach((n) => n.remove())
        card.querySelector('.clip-thumb').insertAdjacentHTML('beforeend', `<span class="status-chip st-check tmp-enh">✨ mejorando voz…</span>`)
        const res = await window.studio.clipEnhance(state.current, c.id, true)
        card.querySelectorAll('.tmp-enh').forEach((n) => n.remove())
        if (res && res.ok) {
          toast(`✨ Audio of ${c.id} enhanced successfully`, 'ok')
          await openProject(state.current, state.stage)
        } else {
          toast(`✗ Could not enhance audio: ${(res && res.error) || 'error'}`, 'err', 8000)
        }
      })
      card.querySelector('[data-a="up"]').addEventListener('click', () => moveClip(c.id, -1))
      card.querySelector('[data-a="down"]').addEventListener('click', () => moveClip(c.id, 1))
      card.querySelector('[data-a="del"]').addEventListener('click', () => deleteClip(c.id, i + 1))
      grid.appendChild(card)
    })
  }
}

// Chip de estado del clip (validación ffprobe tras guardar y mejora de voz).
const CLIP_STATUS = {
  checking: ['comprobando…', 'st-check'], truncated: ['⚠ truncado', 'st-bad'], empty: ['✗ empty', 'st-bad'], warning: ['⚠ avisos', 'st-warn'],
}
function clipStatusChip(c) {
  const camera = c.cameraProcessing
  if (camera && camera.status !== 'done') {
    const label = camera.status === 'failed' ? 'Background pending · Retry' : camera.status === 'queued' ? 'Fondo en cola…' : `Preparando fondo… ${Math.min(99, Math.round((camera.frames || 0) / Math.max(1, c.durationMs * .03) * 100))}%`
    return `<span class="status-chip ${camera.status === 'failed' ? 'st-warn' : 'st-check'}" title="${escapeHtml(camera.error || 'The original is saved. You can keep recording.')}">${label}</span>`
  }
  if (c.enhancing) return `<span class="status-chip st-check" title="Mejorando audio con NVIDIA Studio Voice NIM">✨ mejorando voz…</span>`
  const s = CLIP_STATUS[c.status]
  const base = s ? `<span class="status-chip ${s[1]}" title="${escapeHtml(c.statusNote || '')}">${s[0]}</span>` : ''
  const enh = c.enhanced ? `<span class="status-chip st-ok" title="Audio de estudio (NVIDIA Studio Voice NIM)">✨ Studio Voice</span>` : ''
  return enh + base
}
function wireCameraPlayback(card, selector, clip, dir) {
  const button = card.querySelector(selector)
  button.disabled = !!clip.cameraProcessing && clip.cameraProcessing.status !== 'done'
  button.addEventListener('click', () => openVideo(`rsmedia://media/${encodeURIComponent(clip.webcamPath)}`))
  const retry = document.createElement('button'); retry.className = 'btn-tertiary camera-retry'; retry.textContent = 'Reintentar fondo'
  retry.hidden = clip.cameraProcessing?.status !== 'failed'
  retry.addEventListener('click', async () => {
    retry.disabled = true
    try { await window.studio.retryCameraFinalization({ dir, clipId: clip.id }); retry.hidden = true }
    catch (e) { toast(e.message, 'err') }
    finally { retry.disabled = false }
  })
  card.appendChild(retry)
}
async function onCameraFinalized(payload) {
  if (state.current !== payload.dir) return
  const clip = state.detail?.clips?.find(c => c.id === payload.clipId)
  if (clip) clip.cameraProcessing = payload
  for (const card of document.querySelectorAll(`[data-clip="${payload.clipId}"]`)) {
    card.querySelectorAll('.status-chip').forEach(node => node.remove())
    card.querySelector('.clip-thumb, .rc-thumb')?.insertAdjacentHTML('beforeend', clipStatusChip(clip || { cameraProcessing: payload }))
    const play = card.querySelector('.clip-play, .rc-play'); if (play) play.disabled = payload.status !== 'done'
    const retry = card.querySelector('.camera-retry'); if (retry) retry.hidden = payload.status !== 'failed'
  }
  if (payload.status === 'done') {
    toast(`✓ Fondo listo: ${payload.clipId}`)
    const dir = state.current, detail = await window.studio.projectDetail(dir)
    if (state.current !== dir) return
    const fresh = detail.clips.find(c => c.id === payload.clipId)
    if (fresh?.thumbDataUrl) document.querySelectorAll(`[data-clip="${payload.clipId}"] .clip-thumb, [data-clip="${payload.clipId}"] .rc-thumb`).forEach(node => { node.style.backgroundImage = `url('${fresh.thumbDataUrl}')` })
  }
}
// Actualiza el chip de un clip cuando main termina de validarlo.
function onClipValidated({ dir, clipId, status, note }) {
  if (state.current !== dir) return
  if (state.detail && state.detail.dir === dir && state.detail.clips) {
    const c = state.detail.clips.find((x) => x.id === clipId)
    if (c) { c.status = status; c.statusNote = note }
  }
  document.querySelectorAll(`[data-clip="${clipId}"] .status-chip:not(.st-ok)`).forEach((n) => n.remove())
  document.querySelectorAll(`[data-clip="${clipId}"] .clip-thumb, [data-clip="${clipId}"] .rc-thumb`).forEach((n) => { n.insertAdjacentHTML('beforeend', clipStatusChip(state.detail?.clips?.find(c => c.id === clipId) || { status, statusNote: note })) })
  if (status === 'truncated' || status === 'empty') toast(`⚠ ${clipId}: ${note}`, 'err', 8000)
  else if (status === 'warning') toast(`⚠ ${clipId}: ${note}`, 'warn', 6000)
}

function onClipEnhancing({ dir, clipId }) {
  if (state.detail && state.detail.dir === dir && state.detail.clips) {
    const c = state.detail.clips.find((x) => x.id === clipId)
    if (c) c.enhancing = true
  }
  document.querySelectorAll(`[data-clip="${clipId}"] .tmp-enh`).forEach((n) => n.remove())
  document.querySelectorAll(`[data-clip="${clipId}"] .clip-thumb, [data-clip="${clipId}"] .rc-thumb`).forEach((n) => {
    n.insertAdjacentHTML('beforeend', `<span class="status-chip st-check tmp-enh">✨ mejorando voz…</span>`)
  })
}

function onClipEnhanced({ dir, clipId, status, enhanced, error }) {
  if (state.detail && state.detail.dir === dir && state.detail.clips) {
    const c = state.detail.clips.find((x) => x.id === clipId)
    if (c) {
      c.enhancing = false
      if (enhanced) c.enhanced = true
    }
  }
  document.querySelectorAll(`[data-clip="${clipId}"] .tmp-enh`).forEach((n) => n.remove())
  if (status === 'ok') {
    toast(`✨ Audio of ${clipId} enhanced with NVIDIA Studio Voice`, 'ok')
    if (state.detail && state.detail.dir === dir) openProject(dir, state.stage)
  } else if (error && !error.includes('no NVIDIA_API_KEY')) {
    toast(`⚠ Could not enhance audio of ${clipId}: ${error}`, 'err', 6000)
  }
}

async function enhanceAllClipsUi() {
  if (!state.current) return
  const btn = el('enhanceClipsBtn')
  if (btn) btn.disabled = true
  toast('Enhancing audio for every clip with NVIDIA Studio Voice…')
  try {
    const res = await window.studio.projectEnhanceClips(state.current, false)
    if (res && res.ok) {
      toast('✓ Every clip processed with NVIDIA Studio Voice', 'ok')
      await openProject(state.current, state.stage)
    } else {
      toast(`✗ Error: ${(res && res.error) || 'no se pudo completar'}`, 'err', 8000)
    }
  } catch (err) {
    toast('✗ ' + err.message, 'err')
  } finally {
    if (btn) btn.disabled = false
  }
}

// Tomas a medias de una sesión anterior (la app murió grabando): recuperar o descartar.
function renderOrphans(d) {
  const box = el('orphansBox')
  if (!box) return
  const list = d.orphans || []
  box.classList.toggle('hidden', !list.length)
  box.innerHTML = ''
  for (const o of list) {
    const row = document.createElement('div'); row.className = 'orphan-row'
    row.innerHTML = `<span>⚠ Unfinished take <b>${escapeHtml(o.clipId)}</b> (${escapeHtml(o.human)}${o.started ? ', ' + fmtDate(o.started) : ''}) — la app se cerró grabando.</span>
      <button class="btn-secondary mini" data-a="rec">Recover</button><button class="btn-secondary danger mini" data-a="del">Discard</button>`
    row.querySelector('[data-a="rec"]').addEventListener('click', async () => {
      try { await window.studio.clipRecover(d.dir, o.clipId); toast('✓ Toma recuperada como clip', 'ok'); await openProject(d.dir, state.stage) }
      catch (e) { toast('✗ ' + e.message, 'err', 6000) }
    })
    row.querySelector('[data-a="del"]').addEventListener('click', async () => {
      const ok = await openConfirm('Discard take', `Discard ${o.clipId}? It will be moved to the trash.`, { danger: true })
      if (!ok) return
      await window.studio.clipDiscardPart(d.dir, o.clipId); await openProject(d.dir, state.stage)
    })
    box.appendChild(row)
  }
}
function renderAgentCost(d) {
  const n = el('editorCost')
  if (!n) return
  n.textContent = d.agentRuns ? `${d.agentRuns} run${d.agentRuns > 1 ? 'es' : ''} · ${(d.agentCost || 0).toFixed(2)}` : ''
}

// Área de resultado: muestra los dos aspectos (16:9 YouTube y 9:16 Shorts/Reels).
function renderResult(d) {
  const finalArea = el('finalArea')
  const isFinal = d.hasFinal || d.hasFinal9x16
  if (!isFinal) {
    finalArea.className = 'final-area'
    finalArea.innerHTML = '<div class="empty">No final video yet. Record a clip and hit <b>Compose video</b>: the chosen agent will edit the recording with the skill <code>video-use</code>. Puede tardar varios minutos.</div>'
    return
  }
  finalArea.className = 'result-grid'
  const fig = (kind, has, filePath, poster, srt) => {
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
          ${srt ? `<button class="ghost mini srt-btn" data-srt="${kind}" title="Descargar subtítulos (.srt)">${icon('file-text', 'icon icon-sm')} SRT</button>` : ''}
        </figcaption>
        <video controls playsinline preload="metadata" ${poster ? `poster="${poster}"` : ''} src="${src}"></video>
      </figure>`
  }
  finalArea.innerHTML =
    fig('169', d.hasFinal, d.finalPath, d.previewDataUrl, d.srtPath) +
    fig('916', d.hasFinal9x16, d.final9x16Path, d.preview9x16DataUrl, d.srt9x16Path)
  const paths = { 169: d.finalPath, 916: d.final9x16Path }
  const srts = { 169: d.srtPath, 916: d.srt9x16Path }
  finalArea.querySelectorAll('[data-srt]').forEach((b) =>
    b.addEventListener('click', async () => {
      const res = await window.studio.exportFile(srts[b.dataset.srt])
      if (res && res.ok) toast('✓ Subtitles saved to ' + res.path.split('/').pop(), 'ok')
    }))
  finalArea.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => window.studio.openPath(paths[b.dataset.open])))
  finalArea.querySelectorAll('[data-reveal]').forEach((b) =>
    b.addEventListener('click', () => window.studio.revealPath(paths[b.dataset.reveal])))
  renderPublish(d)
}

// ---- publicación (Upload-Post) ---------------------------------------------------

// Estado vivo del panel: perfiles de la cuenta, metadatos generados por el agente
// y la elección actual. No se persiste: publish.json en edit/ es la fuente.
const publish = { profiles: null, error: null, meta: null, titleIdx: 0, busy: false, results: null }

function resetPublish() {
  publish.meta = null; publish.titleIdx = 0; publish.titleEdited = null
  publish.descEdited = null; publish.results = null; publish.busy = false
  // profiles/error/platforms son de la cuenta, no del proyecto: se conservan.
}

function publishFiles(d) {
  const out = []
  if (d.hasFinal) out.push({ aspect: '169', label: '16:9 · YouTube', path: d.finalPath })
  if (d.hasFinal9x16) out.push({ aspect: '916', label: '9:16 · Shorts/Reels/TikTok', path: d.final9x16Path })
  return out
}

async function renderPublish(d) {
  const card = el('publishCard')
  const body = el('publishBody')
  if (!card || !body) return
  const files = publishFiles(d)
  card.classList.toggle('hidden', !files.length)
  if (!files.length) return

  if (!publish.profiles && !publish.error) {
    body.innerHTML = '<div class="empty">Checking your Upload-Post account…</div>'
    const r = await window.studio.uploadPostProfiles()
    if (r.ok) { publish.profiles = r.profiles; publish.platforms = r.platforms; publish.account = r.account }
    else { publish.error = r.error; publish.platforms = r.platforms || [] }
  }
  if (publish.meta === null) {
    const cached = await window.studio.publishMetaRead(d.dir)
    publish.meta = cached && cached.ok ? cached.meta : false
  }

  if (publish.error) {
    body.innerHTML = `<div class="empty">Publishing is off: <b>${escapeHtml(publish.error)}</b><br>
      Add <code>UPLOAD_POST_API_KEY=…</code> to <code>~/.config/record-studio/.env</code> and reopen the project.
      You can get the key at <code>upload-post.com</code>.</div>`
    return
  }

  const profiles = publish.profiles || []
  if (!profiles.length) {
    body.innerHTML = '<div class="empty">Your Upload-Post account has no profiles with connected accounts yet.</div>'
    return
  }
  const sel = publish.profile && profiles.find((p) => p.username === publish.profile)
  const prof = sel || profiles[0]
  publish.profile = prof.username
  const meta = publish.meta || null
  const titles = (meta && meta.titles) || []
  const chosenTitle = publish.titleEdited != null ? publish.titleEdited : (titles[publish.titleIdx] || d.name)

  body.innerHTML = `
    <div class="pub-row">
      <label class="opt">Profile
        <select id="pubProfile">${profiles.map((p) =>
          `<option value="${escapeHtml(p.username)}"${p.username === prof.username ? ' selected' : ''}>${escapeHtml(p.username)} · ${p.platforms.length} connected</option>`).join('')}</select>
      </label>
      <label class="opt">File
        <select id="pubFile">${files.map((f, i) =>
          `<option value="${f.aspect}"${i === 0 ? ' selected' : ''}>${escapeHtml(f.label)}</option>`).join('')}</select>
      </label>
      <label class="opt">YouTube visibility
        <select id="pubPrivacy">
          <option value="private" selected>private</option>
          <option value="unlisted">unlisted</option>
          <option value="public">public</option>
        </select>
      </label>
    </div>
    <div class="pub-platforms">${(publish.platforms || [])
      .filter((pl) => prof.platforms.includes(pl.id))
      .map((pl) => `<label class="chip"><input type="checkbox" data-pf="${pl.id}"${pl.id === 'youtube' ? ' checked' : ''}> ${escapeHtml(pl.label)}</label>`).join('')
      || '<span class="muted">This profile has no video platform connected.</span>'}</div>
    ${titles.length ? `<div class="pub-titles">${titles.map((t, i) =>
      `<label class="chip"><input type="radio" name="pubTitle" data-ti="${i}"${i === publish.titleIdx ? ' checked' : ''}> ${escapeHtml(t)}</label>`).join('')}</div>` : ''}
    <input id="pubTitleInput" type="text" placeholder="Title" value="${escapeHtml(chosenTitle)}">
    <textarea id="pubDesc" rows="8" placeholder="Description. Hit “Titles &amp; description” and the agent writes it from the subtitles, chapters included.">${escapeHtml((publish.descEdited != null ? publish.descEdited : (meta && meta.description)) || '')}</textarea>
    <div class="pub-actions">
      <button id="pubGo" class="btn-primary"${publish.busy ? ' disabled' : ''}>${publish.busy ? 'Publishing…' : 'Publish'}</button>
      <span id="pubMsg" class="muted">${publish.busy ? 'Upload queued, waiting for the platforms…' : ''}</span>
    </div>
    ${publish.results ? `<div class="pub-results">${publish.results.map((r) =>
      r.ok ? `<div class="ok">✓ ${escapeHtml(r.platform)} — <a href="#" data-url="${escapeHtml(r.url || '')}">${escapeHtml(r.url || 'published')}</a></div>`
           : `<div class="bad">✗ ${escapeHtml(r.platform)} — ${escapeHtml(r.error || 'failed')}</div>`).join('')}</div>` : ''}`

  el('pubProfile').addEventListener('change', (e) => { publish.profile = e.target.value; renderPublish(d) })
  body.querySelectorAll('[data-ti]').forEach((r) => r.addEventListener('change', () => {
    publish.titleIdx = Number(r.dataset.ti); publish.titleEdited = null; renderPublish(d)
  }))
  el('pubTitleInput').addEventListener('input', (e) => { publish.titleEdited = e.target.value })
  el('pubDesc').addEventListener('input', (e) => { publish.descEdited = e.target.value })
  body.querySelectorAll('[data-url]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault(); if (a.dataset.url) window.studio.openExternal(a.dataset.url)
  }))
  el('pubGo').addEventListener('click', () => doPublish(d, files))
}

async function doPublish(d, files) {
  const platforms = [...document.querySelectorAll('[data-pf]')].filter((c) => c.checked).map((c) => c.dataset.pf)
  if (!platforms.length) return toast('Pick at least one platform', 'bad')
  const aspect = el('pubFile').value
  const file = files.find((f) => f.aspect === aspect)
  const title = el('pubTitleInput').value.trim()
  if (!title) return toast('The title cannot be empty', 'bad')
  const okToPublish = await openConfirm('Publish', `Publish “${title}” to ${platforms.join(', ')}?`
    + ` (${file.label}, YouTube visibility: ${el('pubPrivacy').value})`, { danger: true })
  if (!okToPublish) return

  publish.busy = true; publish.results = null; renderPublish(d)
  const res = await window.studio.uploadPostPublish({
    profile: publish.profile,
    platforms,
    title,
    description: el('pubDesc').value,
    tags: (publish.meta && publish.meta.tags) || [],
    youtubePrivacy: el('pubPrivacy').value,
    videoPath: file.path,
  })
  if (!res.ok) {
    publish.busy = false; renderPublish(d)
    return toast('✗ ' + res.error, 'bad')
  }
  // La subida es asíncrona: se consulta hasta que deja de estar en proceso.
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const st = await window.studio.uploadPostStatus(res.requestId)
    if (!st.ok) continue
    const msg = el('pubMsg'); if (msg) msg.textContent = `${st.completed}/${st.total} platforms done…`
    if (st.done) {
      publish.busy = false; publish.results = st.results; renderPublish(d)
      const bad = st.results.filter((r) => !r.ok)
      return toast(bad.length ? `✗ ${bad.length} platform(s) failed` : '✓ Published', bad.length ? 'bad' : 'ok')
    }
  }
  publish.busy = false; renderPublish(d)
  toast('Still processing on Upload-Post — check it on their dashboard', 'warn')
}

async function generatePublishMeta(d) {
  const btn = el('pubMetaBtn')
  if (btn) { btn.disabled = true; btn.textContent = 'Writing…' }
  const r = await window.studio.publishMeta(d.dir, false)
  if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="icon icon-sm"><use href="#i-sparkle"/></svg> Titles &amp; description' }
  if (!r || r.ok === false) return toast('✗ ' + ((r && r.error) || 'could not generate the metadata'), 'bad')
  const cached = await window.studio.publishMetaRead(d.dir)
  publish.meta = cached && cached.ok ? cached.meta : false
  publish.titleIdx = 0; publish.titleEdited = null; publish.descEdited = null
  renderPublish(d)
  toast('✓ Titles and description ready', 'ok')
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
    voiceEnhance: el('optVoice') ? el('optVoice').checked : true,
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
  const ok = await openConfirm('Delete clip', `Delete Clip ${n}? It will be moved to the trash.`, { danger: true })
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
  if (state.recordingSession?.dir === state.current) {
    toast('End the recorder session before deleting this project.', 'warn'); return
  }
  const ok = await openConfirm('Borrar proyecto', `Delete “${state.currentName}” entirely? It will be moved to the trash.`, { danger: true })
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
  if (btnLabel && btnAction) {
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
  parts.push(o.subtitles ? 'subs' : 'no subs')
  if (o.sfx) parts.push('SFX')
  if (o.cropMenubar) parts.push('menu bar cropped')
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
    chip.textContent = 'new conversation'
    chip.style.pointerEvents = 'none'
    chip.title = ''
    return
  }
  chip.style.pointerEvents = ''
  chip.textContent = state.editorResume ? '🧠 will resume the conversation' : 'will start fresh'
  chip.title = 'Switch between resuming the previous conversation and starting fresh'
}

async function startCompose() {
  if (state.composing || !state.current) return
  const opts = currentOpts()
  const extraMsg = el('editorInput').value.trim()
  if (extraMsg) { opts.tone = (opts.tone ? opts.tone + '. ' : '') + extraMsg; el('editorInput').value = '' }
  await persistOpts()
  feedClear()
  el('composeLog').textContent = ''
  feedMsg('user', `Edit video (${optsSummary(opts)})`)
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
  if (job.status === 'done') { el('editorStatus').textContent = '✓ listo'; feedResult('ok', 'Video ready', 'View result →', () => setStage('resultado')) }
  else if (job.status === 'cancelled') { el('editorStatus').textContent = ''; feedResult('cancelled', 'Montaje cancelado') }
  else { el('editorStatus').textContent = ''; feedResult('err', job.error || 'error') }
}

// ---- Embedded agent terminal ----------------------------------------------
// Compose starts the selected CLI with the montage brief; the user can keep chatting.
let term = null
let fitAddon = null
let termResizeObs = null
let termWired = false

async function openTerminal(resume) {
  if (!state.current) return
  if (typeof window.Terminal !== 'function') { log('xterm failed to load', 'err'); return }
  await persistOpts()
  el('termPanel').classList.remove('hidden')
  el('termProj').textContent = state.currentName || ''
  el('termAgent').textContent = state.agentProvider === 'codex' ? 'Codex' : 'Claude Code'
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
    window.studio.terminal.onExit((code) => { el('termStatus').textContent = `· session ended (code ${code})` })
    termWired = true
  }

  if (termResizeObs) termResizeObs.disconnect()
  termResizeObs = new ResizeObserver(() => {
    try { fitAddon.fit(); window.studio.terminal.resize(term.cols, term.rows) } catch { /* ignore */ }
  })
  termResizeObs.observe(el('term'))

  const res = await window.studio.terminal.start({ dir: state.current, resume, opts: currentOpts(), cols: term.cols, rows: term.rows })
  if (!res || !res.ok) {
    el('termStatus').textContent = '· error: ' + ((res && res.error) || 'did not start')
    return
  }
  el('termAgent').textContent = res.provider === 'codex' ? 'Codex' : 'Claude Code'
  if (res.fallback === 'system-terminal') {
    el('termStatus').textContent = '· opened in the system Terminal (embedded PTY unavailable)'
    return
  }
  el('termStatus').textContent = resume ? '· resuming the conversation…' : '· it will propose the edit plan'
  try { window.studio.terminal.resize(term.cols, term.rows) } catch { /* ignore */ }
}

function closeTerminal() {
  try { window.studio.terminal.kill() } catch { /* ignore */ }
  if (termResizeObs) { termResizeObs.disconnect(); termResizeObs = null }
  if (term) { try { term.dispose() } catch { /* ignore */ } term = null }
  const p = el('termPanel'); if (p) p.classList.add('hidden')
}
on('agentProvider', 'change', async (event) => {
  const select = event.target
  const previous = state.agentProvider
  const provider = select.value === 'codex' ? 'codex' : 'claude'
  select.disabled = true
  try {
    await window.studio.settingsSet({ agentProvider: provider })
    state.agentProvider = provider
    toast(`${provider === 'codex' ? 'Codex' : 'Claude Code'} para los próximos montajes y scriptes`)
  } catch (error) {
    select.value = previous
    toast('Could not switch agent: ' + error.message, 'err')
  } finally { select.disabled = false }
  if (state.current) {
    try { updateSessionChip((await window.studio.agentSession(state.current)).hasSession) } catch { /* refreshed when project opens */ }
  }
})
async function cancelCompose() {
  await window.studio.agentCancel(state.current)
  el('editorStatus').textContent = '· cancelando…'
}

// route headless-agent events: compose (key = project dir) or scripts (key = 'style'/'script')
window.studio.onAgentProgress(({ key, msg, ev }) => {
  if (key === state.current) {
    appendComposeLog(msg)
    editorPush(ev || { kind: 'status', label: msg })
  } else if (key === 'style' || key === 'script' || key === 'hooks') scriptProgress(key, msg)
})
// Log completo (stderr + eventos) del agente de este proyecto, desde ⋯ o tras un error.
async function showAgentLog(key) {
  const txt = await window.studio.agentLog(key || state.current)
  el('composeLog').textContent = txt || '(no log)'
  el('composeLog').classList.remove('hidden')
  el('composeLog').scrollTop = el('composeLog').scrollHeight
}
window.studio.onAgentDone(async ({ key, ok, result, error, cost, logFile }) => {
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
        const session = await window.studio.agentSession(key)
        if (state.current === key) updateSessionChip(session.hasSession)
      }
      const costTxt = cost && cost.cost != null ? ` · ${cost.cost.toFixed(2)}${cost.turns ? ` · ${cost.turns} turnos` : ''}` : ''
      feedResult('ok', 'Video ready' + costTxt, 'View result →', () => setStage('resultado'))
      toast('✓ Video edited' + costTxt, 'ok')
      if (d) renderAgentCost(d)
    } else if (error === 'cancelado') {
      el('editorStatus').textContent = ''
      feedResult('cancelled', 'Montaje cancelado')
    } else {
      el('editorStatus').textContent = ''
      feedResult('err', '✗ ' + (error || 'error'), logFile ? 'Ver log' : null, logFile ? () => showAgentLog(key) : null)
      toast('✗ The edit failed', 'err', 6000)
    }
  } else if (key === 'style' || key === 'script' || key === 'hooks') {
    scriptDone(key, ok, result, error, cost)
  }
})

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
    el('modalOk').textContent = opts.danger ? opts.okLabel || 'Delete' : 'OK'
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
  const v = el('modalVideo')
  v.onerror = () => { toast('✗ Could not play the video (file moved or damaged?)', 'err', 6000); closeVideo() }
  v.src = src
  el('videoModal').classList.remove('hidden')
  v.play().catch(() => {})
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
