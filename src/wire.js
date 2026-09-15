'use strict'

// Cableado de la UI: se carga el último porque referencia funciones de todos los ficheros.

// ---- Wire up ---------------------------------------------------------------

el('chooseRoot').addEventListener('click', chooseRoot)
el('onbChoose').addEventListener('click', chooseRoot)
el('navProjects').addEventListener('click', showHome)
el('navScripts').addEventListener('click', showScripts)
el('analyzeBtn').addEventListener('click', () => analyzeChannel(false))
on('updateProfileBtn', 'click', () => analyzeChannel(true))
on('hooksBtn', 'click', proposeHooks)
on('versionSel', 'change', restoreVersion)
on('scriptOut', 'input', updateScriptMeta)
on('recentRoots', 'change', async () => { const d = el('recentRoots').value; if (d) { setRoot(d); await loadHome() } })
el('generateBtn').addEventListener('click', generateScript)
el('rewriteBtn').addEventListener('click', rewriteScript)
el('saveScriptBtn').addEventListener('click', saveCurrentScript)
el('copyScriptBtn').addEventListener('click', copyScript)
el('recordScriptBtn').addEventListener('click', recordWithScript)
el('cancelScriptBtn').addEventListener('click', async () => { for (const k of SCRIPT_KEYS) await window.studio.agentCancel(k) })
el('toggleScriptLog').addEventListener('click', () => {
  const hidden = el('scriptLog').classList.toggle('hidden')
  el('toggleScriptLog').textContent = hidden ? '▸ Show progress' : '▾ Ocultar progreso'
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
el('refreshSources').addEventListener('click', () => loadSources())
el('camSelect').addEventListener('change', changeCam)
el('micSelect').addEventListener('change', changeMic)
el('blurToggle').addEventListener('change', toggleBlur)
el('recalibrateBg').addEventListener('click', () => recalibrateBackground())
el('calibrateSelection').addEventListener('click', calibrateCameraSelection)
el('rawRecordToggle').addEventListener('change', toggleRawRecord)
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
el('keepMainVisible').addEventListener('change', (e) => {
  if (!state.recording) {
    state.keepMainVisible = e.target.checked
    persist({ keepMainVisible: state.keepMainVisible })
  }
  updateReady()
})
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
on('advAgentLog', 'click', () => { el('editorAdvMenu').classList.add('hidden'); showAgentLog(state.current) })

// --- stepper del pipeline ---
document.querySelectorAll('#pipeline .pl-step').forEach((b) => b.addEventListener('click', () => setStage(b.dataset.stage)))

// --- opciones de montaje (barra siempre visible) ---
document.querySelectorAll('#aspectSeg button').forEach((b) =>
  b.addEventListener('click', () => { setSegActive('aspectSeg', 'aspect', b.dataset.aspect); persistOpts() }))
document.querySelectorAll('#pipPicker button').forEach((b) =>
  b.addEventListener('click', () => { setSegActive('pipPicker', 'pip', b.dataset.pip); persistOpts() }))
;['optSubs', 'optModel', 'optCrop', 'optSfx', 'optVoice'].forEach((id) => on(id, 'change', persistOpts))
on('optTone', 'blur', persistOpts)
if (el('enhanceClipsBtn')) el('enhanceClipsBtn').addEventListener('click', enhanceAllClipsUi)
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
window.studio.onCameraFinalized(onCameraFinalized)
on('finalBackgroundToggle', 'change', async () => {
  if (state.recording || state.recordingBusy) { el('finalBackgroundToggle').checked = state.finalBackground; return }
  state.finalBackground = el('finalBackgroundToggle').checked
  persist({ finalBackground: state.finalBackground }); syncBlurUi()
  if (!state.finalBackground && state.blur && !state.pipe && state.rawCam?.active) await recalibrateBackground()
})
window.studio.onClipValidated(onClipValidated)
if (window.studio.onClipEnhancing) window.studio.onClipEnhancing(onClipEnhancing)
if (window.studio.onClipEnhanced) window.studio.onClipEnhanced(onClipEnhanced)

// Atajos de teclado: Esc cierra modales/vídeo; Cmd/Ctrl+R graba (vista Grabar) o
// para la grabación; Cmd/Ctrl+Shift+P pausa. (Durante la toma los globales
// Cmd+Shift+1/2/3 los gestiona main.)
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable)
  if (e.key === 'Escape') {
    if (!el('videoModal').classList.contains('hidden')) { closeVideo(); e.preventDefault(); return }
    if (!el('modal').classList.contains('hidden')) { closeModal(el('modalInput').classList.contains('hidden') ? false : null); e.preventDefault(); return }
    const menu = el('editorAdvMenu'); if (menu && !menu.classList.contains('hidden')) { menu.classList.add('hidden'); return }
    return
  }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'r') {
    if (el('viewRecord').classList.contains('hidden') || typing) return
    e.preventDefault()
    if (state.recording) stopRecording(true); else if (!el('recBtn').disabled) beginRecording()
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'p' && state.recording) { e.preventDefault(); pauseResume() }
})

// Cerrar/recargar la ventana en mitad de una toma pierde el clip: avisar.
window.addEventListener('beforeunload', (e) => {
  if (state.recording) { e.preventDefault(); e.returnValue = 'A recording is in progress.' }
})

window.studio.onTpClosed(() => { state.tpVisible = false; updateTpToggle() })
window.studio.onTpSaved(async ({ text, path }) => {
  el('tpText').value = text
  if (state.current) { await window.studio.setTeleprompter(state.current, text); if (state.detail) state.detail.teleprompter = text }
  if (path) await window.studio.saveScript(path, text) // auto-save back to the loaded script file
})
window.studio.onTpLoaded(async ({ path, text }) => {
  state.tpLoadedPath = path || ''
  el('tpText').value = text || ''
  if (state.current) { await window.studio.setTeleprompter(state.current, text || ''); if (state.detail) state.detail.teleprompter = text || '' }
  log('script loaded into the teleprompter', 'ok')
})

window.addEventListener('DOMContentLoaded', async () => {
  await loadSettings() // settings.json manda sobre la caché de localStorage
  loadBgPresets()
  await loadSources()
  showHome() // camera stays OFF until you enter the Record view
})
