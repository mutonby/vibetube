'use strict'

// Vista Guiones + "Record with this script" (comparte state/el/toast/log con renderer.js).
//
// Flujo: perfil de estilo (canal → style_profile.md + pace.json) → brief
// estructurado → borrador con 3 ganchos + fuentes → el usuario edita / reescribe /
// pide ganchos → "Record with this script" crea el proyecto con script.md y guarda
// el par borrador→final en _scripts/feedback/ para que el agente aprenda.

const SCRIPT_KEYS = ['style', 'script', 'hooks']
let scriptsStatus = null // último scripts-status (wpm, corpus, feedback…)
let scriptsList = []

function wordsOf(text) { return ((text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length }
function currentWpm() { return (scriptsStatus && scriptsStatus.pace && scriptsStatus.pace.wpm) || 150 }
function estDuration(words) {
  const s = Math.round((words / currentWpm()) * 60)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// ---- ganchos: parsear el bloque GANCHOS / OPCIÓN n y aplicar uno -----------

function parseHooks(text) {
  const m = /^GANCHOS\s*\n([\s\S]*?)(?=^\s*(?:GANCHO|DESARROLLO|INTRO|CONTEXTO)\s*$)/mi.exec(text || '')
  if (!m) return []
  return m[1].split(/^\s*OPCI[ÓO]N\s*\d+\s*$/mi).map((s) => s.trim()).filter(Boolean)
}
function stripHooksBlock(text) {
  return (text || '').replace(/^GANCHOS\s*\n[\s\S]*?(?=^\s*(?:GANCHO|DESARROLLO|INTRO|CONTEXTO)\s*$)/mi, '').replace(/^\s+/, '')
}
function applyHook(text, hook) {
  let t = stripHooksBlock(text)
  // Sustituye el cuerpo de la sección GANCHO (hasta la siguiente etiqueta en mayúsculas).
  const re = /^(GANCHO\s*\n)([\s\S]*?)(?=^\s*[A-ZÁÉÍÓÚÑ0-9 ]{3,}\s*$)/m
  if (re.test(t)) t = t.replace(re, (_m, label) => `${label}\n${hook.trim()}\n\n`)
  else t = `GANCHO\n\n${hook.trim()}\n\n${t}`
  return t
}

// ---- UI: estado del script actual --------------------------------------------

function setScriptText(text, path) {
  state.currentScriptPath = path || state.currentScriptPath
  el('scriptOut').value = plainText(text || '')
  el('scriptName').textContent = state.currentScriptPath ? state.currentScriptPath.split('/').pop() : ''
  updateScriptMeta()
  renderHooks(parseHooks(el('scriptOut').value))
  loadVersions()
}
function updateScriptMeta() {
  const w = wordsOf(el('scriptOut').value)
  el('scriptMeta').textContent = w ? `${w} palabras · ~${estDuration(w)} a ${currentWpm()} ppm` : ''
}
function renderHooks(hooks) {
  const box = el('hooksBox')
  if (!hooks.length) { box.classList.add('hidden'); box.innerHTML = ''; return }
  box.classList.remove('hidden')
  box.innerHTML = '<div class="card-head"><h4>Pick the hook</h4><span class="card-help">Replaces the script HOOK and removes the options block.</span></div>'
  hooks.forEach((h, i) => {
    const d = document.createElement('div'); d.className = 'hook-opt'
    d.innerHTML = `<div class="hook-txt">${escapeHtml(h)}</div><button class="btn-secondary mini">Use option ${i + 1}</button>`
    d.querySelector('button').addEventListener('click', () => {
      el('scriptOut').value = applyHook(el('scriptOut').value, h)
      renderHooks([]); updateScriptMeta(); saveCurrentScript()
    })
    box.appendChild(d)
  })
}
function renderScriptSources(text) {
  const box = el('sourcesBox')
  if (!text || !text.trim()) { box.classList.add('hidden'); return }
  box.classList.remove('hidden')
  el('sourcesText').textContent = text
}
async function loadVersions() {
  const sel = el('versionSel')
  sel.innerHTML = '<option value="">versions…</option>'
  if (!state.currentScriptPath) { sel.classList.add('hidden'); return }
  let list = []
  try { list = await window.studio.scriptVersions(state.currentScriptPath) } catch { list = [] }
  sel.classList.toggle('hidden', !list.length)
  for (const v of list) {
    const o = document.createElement('option'); o.value = v.path; o.textContent = `${v.label} · ${fmtDate(stampFromMs(v.mtime))}`
    sel.appendChild(o)
  }
}
function stampFromMs(ms) {
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function setScriptBusy(b) {
  state.scriptsBusy = b
  ;['analyzeBtn', 'updateProfileBtn', 'generateBtn', 'rewriteBtn', 'hooksBtn'].forEach((id) => { const n = el(id); if (n) n.disabled = b })
  el('cancelScriptBtn').classList.toggle('hidden', !b)
}
function appendScriptLog(msg) {
  const pre = el('scriptLog')
  pre.textContent += (pre.textContent ? '\n' : '') + msg
  pre.scrollTop = pre.scrollHeight
}
function scriptProgress(key, msg) {
  el('toggleScriptLog').classList.remove('hidden')
  appendScriptLog(msg)
  if (key === 'style') el('profileStatus').textContent = '· ' + msg
  else el('genStatus').textContent = '· ' + msg
}
async function scriptDone(key, ok, result, error, cost) {
  setScriptBusy(false)
  const costTxt = cost && cost.cost != null ? ` · $${cost.cost.toFixed(2)}` : ''
  if (key === 'style') {
    await refreshProfileStatus()
    toast(ok ? '✓ Style profile ready' + costTxt : '✗ Analysis failed: ' + (error || ''), ok ? 'ok' : 'err', ok ? 3500 : 7000)
  } else if (key === 'hooks') {
    el('genStatus').textContent = ok ? '✓ ganchos listos' + costTxt : '✗ ' + (error || 'error')
    if (ok && result) {
      const hooks = result.text.split(/^\s*OPCI[ÓO]N\s*\d+\s*$/mi).map((s) => s.trim()).filter(Boolean)
      renderHooks(hooks)
      toast('✓ Ganchos propuestos: elige uno', 'ok')
    } else toast('✗ Could not propose hooks', 'err')
  } else {
    el('genStatus').textContent = ok ? '✓ script ready' + costTxt : '✗ ' + (error || 'error')
    toast(ok ? '✓ Script ready' + costTxt : '✗ Generation failed: ' + (error || ''), ok ? 'ok' : 'err', ok ? 3500 : 7000)
    if (ok && result) {
      setScriptText(result.text, result.path)
      renderScriptSources(result.sources)
      renderScriptsList()
    }
  }
}

// ---- perfil de estilo -----------------------------------------------------------

async function refreshProfileStatus() {
  if (!state.root) return
  scriptsStatus = await window.studio.scriptsStatus(state.root)
  const st = scriptsStatus
  const upd = el('updateProfileBtn')
  if (st.hasProfile) {
    const parts = [`✓ Perfil listo`]
    if (st.corpus) parts.push(`${st.corpus} videos`)
    if (st.pace && st.pace.wpm) parts.push(`${st.pace.wpm} palabras/min`)
    if (st.feedbackPairs) parts.push(`${st.feedbackPairs} script${st.feedbackPairs > 1 ? 'es' : ''} aprendido${st.feedbackPairs > 1 ? 's' : ''} of your edits`)
    if (st.profileMtime) parts.push(`actualizado ${fmtDate(stampFromMs(st.profileMtime))}`)
    el('profileStatus').textContent = parts.join(' · ')
    upd.classList.remove('hidden')
  } else {
    el('profileStatus').textContent = 'No profile yet. Paste your channel and hit “Analyse my channel”.'
    upd.classList.add('hidden')
  }
  updateScriptMeta()
}

async function ensureRoot() {
  if (state.root) return true
  const d = await window.studio.chooseDir('Root folder for projects')
  if (!d) return false
  setRoot(d)
  return true
}

async function analyzeChannel(incremental = false) {
  if (state.scriptsBusy) return
  if (!(await ensureRoot())) return
  const ch = el('channelUrl').value.trim()
  if (!ch) { el('channelUrl').focus(); return }
  state.channel = ch; persist({ channel: ch })
  el('scriptLog').textContent = ''
  setScriptBusy(true); el('profileStatus').textContent = incremental ? '· updating with new videos…' : '· lanzando…'
  const r = await window.studio.analyzeChannel(state.root, ch, incremental)
  if (r && r.started === false && !r.already) { setScriptBusy(false); toast('✗ ' + (r.error || 'did not start'), 'err') }
}

// ---- brief → generar / reescribir / ganchos --------------------------------------

function scriptBrief() {
  return {
    duration: el('scrDuration').value,
    format: el('scrFormat').value,
    goal: el('scrGoal').value,
    demo: el('scrDemo').value,
    cta: el('scrCta').value.trim(),
    avoid: el('scrAvoid').value.trim(),
    keyPoints: el('keyPoints').value.trim(),
  }
}
async function generateScript() {
  if (state.scriptsBusy) return
  if (!(await ensureRoot())) return
  const topic = el('topicBox').value.trim()
  if (!topic) { el('topicBox').focus(); return }
  el('scriptLog').textContent = ''
  setScriptBusy(true); el('genStatus').textContent = '· redactando…'
  const r = await window.studio.generateScript(state.root, topic, scriptBrief())
  if (r && r.started === false && !r.already) { setScriptBusy(false); toast('✗ ' + (r.error || 'did not start'), 'err') }
}
async function rewriteScript() {
  if (state.scriptsBusy || !state.currentScriptPath) return
  const fb = el('scriptFeedback').value.trim()
  if (!fb) { el('scriptFeedback').focus(); return }
  await window.studio.saveScript(state.currentScriptPath, el('scriptOut').value) // rewrite the latest edits
  setScriptBusy(true); el('genStatus').textContent = '· reescribiendo…'
  const r = await window.studio.rewriteScript(state.root, state.currentScriptPath, fb, scriptBrief())
  if (r && r.started === false && !r.already) { setScriptBusy(false); toast('✗ ' + (r.error || 'did not start'), 'err') }
  el('scriptFeedback').value = ''
}
async function proposeHooks() {
  if (state.scriptsBusy || !state.currentScriptPath) { if (!state.currentScriptPath) toast('Generate or open a script first', 'warn'); return }
  await window.studio.saveScript(state.currentScriptPath, el('scriptOut').value)
  setScriptBusy(true); el('genStatus').textContent = '· proponiendo ganchos…'
  const r = await window.studio.hooksScript(state.root, state.currentScriptPath)
  if (r && r.started === false && !r.already) { setScriptBusy(false); toast('✗ ' + (r.error || 'did not start'), 'err') }
}
async function saveCurrentScript() {
  if (!state.currentScriptPath) { el('genStatus').textContent = 'generate a script first'; return }
  await window.studio.saveScript(state.currentScriptPath, el('scriptOut').value)
  updateScriptMeta()
  toast('✓ Script saved', 'ok'); renderScriptsList()
}
async function copyScript() {
  try { await navigator.clipboard.writeText(el('scriptOut').value); toast('✓ Copied to the clipboard', 'ok') }
  catch (e) { toast('✗ Could not copy: ' + e.message, 'err') }
}
async function restoreVersion() {
  const p = el('versionSel').value
  if (!p) return
  const ok = await openConfirm('Restore version', 'The current text will be replaced by that version (the current one is saved as a new version).', {})
  el('versionSel').value = ''
  if (!ok) return
  const text = await window.studio.readScript(p)
  if (!text) { toast('✗ Could not read the version', 'err'); return }
  el('scriptOut').value = plainText(text)
  await saveCurrentScript()
}
async function renderScriptsList() {
  if (!state.root) return
  scriptsList = await window.studio.listScripts(state.root)
  const box = el('scriptsList'); box.innerHTML = ''
  if (!scriptsList.length) { box.innerHTML = '<div class="empty">No saved scripts yet.</div>'; return }
  for (const s of scriptsList) {
    const it = document.createElement('div'); it.className = 'script-item'
    const meta = `${s.words} palabras · ~${estDuration(s.words)}${s.hasSources ? ' · fuentes' : ''}`
    it.innerHTML = `<div class="si-main"><div class="si-title">${escapeHtml(s.title)}</div><div class="si-prev">${escapeHtml(s.preview)}</div><div class="si-meta">${meta}</div></div>
      <button class="btn-secondary si-open">Abrir</button><button class="btn-secondary danger mini si-del" title="borrar">${icon('trash', 'icon icon-sm')}</button>`
    it.querySelector('.si-open').addEventListener('click', async () => {
      const text = await window.studio.readScript(s.path)
      setScriptText(text, s.path)
      renderScriptSources(s.hasSources ? await window.studio.readScript(s.path.replace(/\.md$/, '.sources.md')) : '')
      el('scriptOut').scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    it.querySelector('.si-del').addEventListener('click', async () => {
      const ok = await openConfirm('Delete script', `Delete “${s.title}”? It will be moved to the trash.`, { danger: true })
      if (!ok) return
      await window.studio.deleteScript(s.path)
      if (state.currentScriptPath === s.path) { state.currentScriptPath = ''; el('scriptOut').value = ''; el('scriptName').textContent = ''; updateScriptMeta(); renderHooks([]); renderScriptSources('') }
      renderScriptsList()
    })
    box.appendChild(it)
  }
}

// ---- grabar con este script --------------------------------------------------------

async function recordWithScript() {
  if (!(await ensureRoot())) return
  let text = el('scriptOut').value.trim()
  if (!text) { el('scriptOut').focus(); return }
  if (parseHooks(text).length) {
    const go = await openConfirm('No hook chosen', 'The script still has the 3-hook block. Record with the main hook and discard the options?', {})
    if (!go) return
    text = stripHooksBlock(text)
    el('scriptOut').value = text
  }
  if (state.currentScriptPath) {
    await window.studio.saveScript(state.currentScriptPath, text)
    // Par borrador→final para que el agente aprenda de tus correcciones.
    try { const fb = await window.studio.scriptFeedback(state.root, state.currentScriptPath, text); if (fb && fb.ok) log('learning pair saved: ' + fb.id, 'ok') } catch { /* opcional */ }
  }
  const defName = (text.split('\n').find((l) => l.trim() && !/^[A-ZÁÉÍÓÚÑ0-9 ]{3,}$/.test(l.trim())) || 'Script').replace(/^#+\s*/, '').slice(0, 40)
  const name = await openPrompt('New project to record with this script', defName)
  if (name == null) return
  const summary = await window.studio.createProject(state.root, name.trim() || defName, { text, path: state.currentScriptPath || null })
  state.projects.unshift(summary)
  const d = await window.studio.projectDetail(summary.dir)
  state.detail = d
  showRecord(d.dir, d.name)
}

// ---- vista ---------------------------------------------------------------------

function showScripts() {
  stopCam()
  hideAll(); el('viewScripts').classList.remove('hidden')
  el('timer').classList.add('hidden'); setCrumb('Scripts'); setStatus('ready'); setNav('scripts')
  loadScripts()
}

async function loadScripts() {
  el('channelUrl').value = state.channel || ''
  if (!state.root) {
    el('profileStatus').textContent = 'Pick a folder in the Projects tab first.'
    el('scriptsList').innerHTML = '<div class="empty">—</div>'
    return
  }
  await refreshProfileStatus()
  // restore in-flight jobs
  const jobs = await Promise.all(SCRIPT_KEYS.map((k) => window.studio.agentStatus(k)))
  const running = jobs.some((j) => j && j.status === 'running')
  setScriptBusy(running)
  if (jobs[0] && jobs[0].status === 'running') el('profileStatus').textContent = '· analizando…'
  if (jobs[1] && jobs[1].status === 'running') el('genStatus').textContent = '· redactando…'
  if (jobs[2] && jobs[2].status === 'running') el('genStatus').textContent = '· proponiendo ganchos…'
  renderScriptsList()
}
