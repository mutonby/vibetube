'use strict'

const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, shell, globalShortcut, screen, powerSaveBlocker } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawnSync, spawn } = require('child_process')

const util = require('./util')
const { stamp, slugify, uniqueDir, findBin, readJson, writeJson, isUnder, freeBytes, fmtBytes, wordCount } = util
const media = require('./media-protocol')
const settings = require('./settings')
const providers = require('./providers')
const agent = require('./agent')
const prompts = require('./prompts')
const { AwakeLock } = require('./awake')
require('./matting').install(ipcMain, app)
const { DEFAULT_OPTS, normAspect } = prompts

// Native PTY for the embedded agent terminal. Rebuilt against Electron's
// ABI (see package.json postinstall). If it can't load, the terminal falls back
// to opening the system Terminal instead of breaking.
let pty = null
try { pty = require('node-pty-prebuilt-multiarch') }
catch (e) { console.error('[pty] node-pty failed to load, the terminal will use Terminal.app:', e.message) }

// Allow the file:// renderer to load the bundled camera model and WASM locally.
app.commandLine.appendSwitch('allow-file-access-from-files')

let mainWindow = null
let floatWindow = null
let tpWindow = null
let ptyProc = null // the embedded agent terminal's PTY (one at a time)

media.registerSchemes()

// ---- rutas permitidas (seguridad IPC) ---------------------------------------
// El renderer solo puede leer/escribir dentro de las carpetas raíz de proyectos
// que el usuario ha elegido (actual + recientes) y de los fondos de la app.

function allowedRoots() {
  const list = [settings.get('root'), ...(settings.get('recentRoots', []) || [])].filter(Boolean)
  return [...new Set(list)]
}
function registerRoot(dir) {
  if (!dir) return
  settings.touchRecentRoot(dir)
  media.allowRoot(dir)
}
function guardPath(p, what = 'ruta') {
  if (typeof p !== 'string' || !p) throw new Error(`${what} inválida`)
  if (!allowedRoots().some((r) => isUnder(r, p))) throw new Error(`${what} fuera de la carpeta de proyectos: ${p}`)
  return p
}
function guardRoot(root) {
  if (typeof root !== 'string' || !root) throw new Error('invalid root folder')
  if (!allowedRoots().includes(root)) registerRoot(root) // elegida con el diálogo → válida
  return root
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#0a0a0f',
    title: 'VibeTube',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep MediaRecorder/timers alive while hidden
    },
  })
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'))

  // Forward renderer console + errors to the main process stdout so recording
  // bugs (which happen while the window is hidden) show up in the terminal/log.
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const src = (sourceId || '').split('/').pop()
    console.log(`[renderer${level >= 2 ? ':ERR' : ''}] ${message}${line ? ` (${src}:${line})` : ''}`)
  })

  // System-audio loopback: when the renderer calls getDisplayMedia({audio:true}),
  // hand it a screen source + `loopback` audio so we can mix desktop sound with
  // the mic. `loopback` (not `loopbackWithMute`) keeps the sound audible on the
  // speakers. The renderer only keeps the AUDIO track and discards the video.
  mainWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
      .catch(() => callback({}))
  }, { useSystemPicker: false })

  // No cerrar la ventana en mitad de una grabación sin confirmar.
  mainWindow.on('close', (e) => {
    if (!recordingActive) return
    const r = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning', buttons: ['Seguir grabando', 'Descartar y cerrar'], defaultId: 0, cancelId: 0,
      message: 'A recording is in progress', detail: 'If you close now, the current take will be lost.',
    })
    if (r === 0) e.preventDefault()
  })

  // Si la ventana se va en mitad de una toma (descartar y cerrar, o un cuelgue
  // del renderer) nadie enviará `recording-stopped`: soltar el bloqueo aquí.
  mainWindow.on('closed', () => awake.release())
  mainWindow.webContents.on('render-process-gone', () => awake.release())
}

app.whenReady().then(() => {
  media.install()
  for (const r of allowedRoots()) media.allowRoot(r)
  media.allowRoot(path.join(__dirname, '..', 'src', 'backgrounds'))
  settings.installIpc()
  agent.cleanupOrphans()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => { globalShortcut.unregisterAll(); stopTerminal(); agent.cancelAll(); awake.release() })
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ---- Floating recording bar + global shortcuts -----------------------------

let recordingActive = false
const awake = new AwakeLock(powerSaveBlocker)

function createFloating(initState) {
  if (floatWindow) return
  floatWindow = new BrowserWindow({
    width: 300,
    height: 230,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'float-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  floatWindow.setAlwaysOnTop(true, 'screen-saver')
  floatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  try { floatWindow.setContentProtection(true) } catch { /* unsupported */ }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  floatWindow.setPosition(width - 320, height - 250)
  floatWindow.loadFile(path.join(__dirname, '..', 'src', 'float.html'))
  floatWindow.webContents.on('did-finish-load', () => {
    try { floatWindow.webContents.send('float-init', initState || {}) } catch { /* gone */ }
  })
}

function destroyFloating() {
  if (floatWindow) { try { floatWindow.close() } catch { /* gone */ } floatWindow = null }
}

function relayControl(which) {
  if (mainWindow) mainWindow.webContents.send('remote-control', which)
}

ipcMain.on('recording-started', (_e, payload) => {
  recordingActive = true
  awake.acquire() // la pantalla no puede apagarse ni bloquearse en mitad de la toma
  if (mainWindow && !payload?.continuing) {
    const keepVisible = payload?.keepMainVisible === true
    try { mainWindow.setContentProtection(!keepVisible) } catch { /* ignore */ }
    if (keepVisible) mainWindow.show()
    else mainWindow.hide()
  }
  createFloating(payload)
  globalShortcut.register('CommandOrControl+Shift+1', () => relayControl('pause'))
  globalShortcut.register('CommandOrControl+Shift+2', () => relayControl('stop'))
  globalShortcut.register('CommandOrControl+Shift+3', () => relayControl('restart'))
})

ipcMain.on('recording-stopped', () => {
  recordingActive = false
  awake.release()
  globalShortcut.unregisterAll()
  destroyFloating()
  if (mainWindow) { try { mainWindow.setContentProtection(false) } catch { /* ignore */ } mainWindow.show(); mainWindow.focus() }
})

ipcMain.on('rec-elapsed', (_e, payload) => {
  if (floatWindow) floatWindow.webContents.send('rec-elapsed', payload)
})

// A clip was saved but the user stays in "floating" mode to record more clips:
// preserve main-window visibility and flip the floating bar to its idle UI.
ipcMain.on('float-idle', (_e, payload) => {
  recordingActive = false
  if (floatWindow) floatWindow.webContents.send('float-idle', payload || {})
})

// Avisos críticos durante la toma (la ventana principal está oculta).
ipcMain.on('float-warn', (_e, msg) => {
  if (floatWindow) { try { floatWindow.webContents.send('float-warn', String(msg || '')) } catch { /* gone */ } }
})

// from the floating bar buttons
ipcMain.on('float-control', (_e, which) => relayControl(which))

ipcMain.on('float-preview-request', event => {
  if (floatWindow && event.sender === floatWindow.webContents && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('float-preview-request')
  }
})
ipcMain.on('float-preview-frame', (event, bytes) => {
  if (mainWindow && event.sender === mainWindow.webContents && floatWindow && !floatWindow.isDestroyed() &&
      bytes instanceof ArrayBuffer && bytes.byteLength <= 512 * 1024) {
    floatWindow.webContents.send('float-preview-frame', bytes)
  }
})

// ---- Embedded agent terminal (interactive montage session) ----------------
// Starts the selected CLI in the project directory with its montage brief.
// Each provider inherits its own model configuration.

function stopTerminal() {
  if (ptyProc) { try { ptyProc.kill() } catch { /* gone */ } ptyProc = null }
}

// Fallback when the native PTY isn't available: open the system Terminal running
// the selected CLI. Sources the .env so the HeyGen key is present without copying the secret.
function openSystemTerminal(dir, binary, args) {
  try {
    const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
    const line = `cd ${q(dir)} && ${q(binary)} ${args.map(q).join(' ')}`
    const script = '#!/bin/bash\n'
      + 'set -a; [ -f "$HOME/.config/record-studio/.env" ] && . "$HOME/.config/record-studio/.env"; [ -f "$HOME/Documents/avatar-muton/.env" ] && . "$HOME/Documents/avatar-muton/.env"; set +a\n'
      + line + '\n'
    const f = path.join(app.getPath('temp'), `rs-terminal-${stamp()}.command`)
    fs.writeFileSync(f, script, { mode: 0o755 })
    shell.openPath(f)
    return true
  } catch (e) { console.error('[terminal] Terminal fallback failed:', e.message); return false }
}

function startTerminal({ dir, resume, opts, cols, rows } = {}) {
  const provider = agent.selectedProvider()
  const binary = agent.agentPath(provider)
  if (!binary) return { ok: false, error: `No encuentro la CLI \`${provider}\`. Instálala e inicia sesión en una terminal.` }
  if (!dir) return { ok: false, error: 'proyecto sin carpeta' }
  guardPath(dir, 'carpeta del proyecto')
  try { providers.writeProjectInstructions(dir, provider, prompts.montageBrief(opts)) }
  catch (e) { return { ok: false, error: `No pude guardar las instrucciones: ${e.message}` } }
  stopTerminal()

  const seed = [
    `Eres el editor de este proyecto record-studio; sigue el ${providers.instructionsFile(provider)} de esta carpeta.`,
    'Primero transcribe e inspecciona los clips y ENSÉÑAME EL PLAN de montaje (planos, gráficos,',
    `SFX/música, subtítulos por formato). Espera mi aprobación antes de montar. Cuando lo apruebe, genera ${prompts.aspectGoal(opts)}. Habla en español.`,
  ].join(' ')
  // Fresh compose → request a plan. Continue → resume the provider's conversation.
  const args = providers.terminalArgs(provider, { resume, seed })
  const env = { ...process.env, ...agent.heygenEnv(), TERM: 'xterm-256color', FORCE_COLOR: '1' }

  if (!pty) {
    const ok = openSystemTerminal(dir, binary, args)
    return { ok, provider, fallback: 'system-terminal', error: ok ? null : 'no pude abrir Terminal' }
  }
  try {
    ptyProc = pty.spawn(binary, args, {
      name: 'xterm-256color', cols: cols || 100, rows: rows || 30, cwd: dir, env,
    })
  } catch (e) { return { ok: false, error: e.message } }
  ptyProc.onData((d) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal-data', d) })
  ptyProc.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal-exit', exitCode)
    ptyProc = null
  })
  return { ok: true, provider }
}

ipcMain.handle('terminal-start', (_e, payload) => startTerminal(payload || {}))
ipcMain.on('terminal-input', (_e, data) => { if (ptyProc) try { ptyProc.write(data) } catch { /* gone */ } })
ipcMain.on('terminal-resize', (_e, { cols, rows } = {}) => {
  if (ptyProc) try { ptyProc.resize(Math.max(2, cols | 0), Math.max(2, rows | 0)) } catch { /* gone */ }
})
ipcMain.on('terminal-kill', () => stopTerminal())

// ---- Teleprompter window (content-protected, near the camera) --------------

function showTeleprompter(payload) {
  const data = typeof payload === 'string' ? { text: payload } : (payload || {})
  const wa = screen.getPrimaryDisplay().workAreaSize
  const w = Math.min(900, wa.width - 80)
  if (!tpWindow) {
    tpWindow = new BrowserWindow({
      width: w,
      height: 250,
      frame: false,
      resizable: true,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'tp-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    tpWindow.setAlwaysOnTop(true, 'screen-saver')
    tpWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    try { tpWindow.setContentProtection(true) } catch { /* unsupported */ }
    tpWindow.setPosition(Math.round(wa.width / 2 - w / 2), 40)
    tpWindow.loadFile(path.join(__dirname, '..', 'src', 'teleprompter.html'))
    tpWindow.webContents.on('did-finish-load', () => {
      try { tpWindow.webContents.send('tp-init', data) } catch { /* gone */ }
    })
    tpWindow.on('closed', () => { tpWindow = null })
  } else {
    tpWindow.webContents.send('tp-init', data)
    tpWindow.show()
  }
}

function hideTeleprompter() {
  if (tpWindow) { try { tpWindow.close() } catch { /* gone */ } tpWindow = null }
}

ipcMain.on('show-teleprompter', (_e, payload) => showTeleprompter(payload))
ipcMain.on('hide-teleprompter', () => hideTeleprompter())
ipcMain.on('tp-close', () => {
  hideTeleprompter()
  if (mainWindow) mainWindow.webContents.send('tp-closed')
})
ipcMain.on('tp-load', (_e, scriptPath) => {
  let text = ''
  try { guardPath(scriptPath, 'guion'); text = fs.readFileSync(scriptPath, 'utf8') } catch { text = '' }
  if (tpWindow) tpWindow.webContents.send('tp-loaded-window', { path: scriptPath, text })
  if (mainWindow) mainWindow.webContents.send('tp-loaded', { path: scriptPath, text })
})
ipcMain.on('tp-save', (_e, payload) => {
  if (mainWindow) mainWindow.webContents.send('tp-saved', payload)
})

// ---- utils -----------------------------------------------------------------

function ffmpegPath() {
  return findBin('ffmpeg', ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'], '-version') || 'ffmpeg'
}
function ffprobePath() {
  return findBin('ffprobe', ['ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'], '-version')
}

function readProjectJson(dir) { return readJson(path.join(dir, 'project.json'), null) }
function writeProjectJson(dir, proj) {
  proj.updated = stamp()
  delete proj._dir
  writeJson(path.join(dir, 'project.json'), proj)
}

// Poster/thumbnail as an rsmedia:// URL (generated once with ffmpeg and cached
// next to the media). Antes se devolvía base64 en cada list-projects.
function frameUrl(videoPath, outJpg, ss = 1) {
  try {
    if (!fs.existsSync(videoPath)) return null
    if (!fs.existsSync(outJpg)) {
      const r = spawnSync(ffmpegPath(), ['-y', '-ss', String(ss), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=480:-2', outJpg], { stdio: 'ignore' })
      if (r.status !== 0 || !fs.existsSync(outJpg)) return null
    }
    return `rsmedia://media/${encodeURIComponent(outJpg)}?v=${Math.floor(fs.statSync(outJpg).mtimeMs)}`
  } catch { return null }
}

// El .srt que video-use deja junto al mp4 (final.srt, o el primero que haya en edit/).
function findSrt(dir, base) {
  const exact = path.join(dir, 'edit', base + '.srt')
  if (fs.existsSync(exact)) return exact
  if (base !== 'final') return null
  try {
    const any = fs.readdirSync(path.join(dir, 'edit')).filter((f) => f.endsWith('.srt')).sort()
    return any.length ? path.join(dir, 'edit', any[0]) : null
  } catch { return null }
}

function summarizeProject(dir) {
  const proj = readProjectJson(dir)
  if (!proj) return null
  resumeCameraJobs(dir, proj)
  const clips = proj.clips || []
  const durationMs = clips.reduce((a, c) => a + (c.duration_ms || 0), 0)
  const finalPath = path.join(dir, 'edit', 'final.mp4')
  const hasFinal = fs.existsSync(finalPath)
  const final9x16Path = path.join(dir, 'edit', 'final_9x16.mp4')
  const hasFinal9x16 = fs.existsSync(final9x16Path)
  let previewDataUrl = null
  let preview9x16DataUrl = null
  if (hasFinal9x16) preview9x16DataUrl = frameUrl(final9x16Path, path.join(dir, 'edit', '_poster_9x16.jpg'), 1)
  if (hasFinal) previewDataUrl = frameUrl(finalPath, path.join(dir, 'edit', '_poster.jpg'), 1)
  else if (hasFinal9x16) previewDataUrl = preview9x16DataUrl
  else if (clips.length) {
    const c0 = clips[0]
    previewDataUrl = c0.cam?.afterRecord && c0.camera_processing?.status !== 'done' ? null : frameUrl(path.join(dir, c0.webcam || `clips/${c0.id}/webcam.webm`), path.join(dir, 'clips', c0.id, '_thumb.jpg'), 0.5)
  }
  const runs = proj.agentRuns || []
  const totalCost = runs.reduce((a, r) => a + (r.cost || 0), 0)
  return {
    dir,
    name: proj.name || path.basename(dir),
    created: proj.created || '',
    updated: proj.updated || proj.created || '',
    clipCount: clips.length,
    durationMs,
    hasFinal,
    finalPath: hasFinal ? finalPath : null,
    hasFinal9x16,
    final9x16Path: hasFinal9x16 ? final9x16Path : null,
    srtPath: findSrt(dir, 'final'),
    srt9x16Path: findSrt(dir, 'final_9x16'),
    previewDataUrl,
    preview9x16DataUrl,
    composeOpts: proj.compose_opts || null,
    hasScript: fs.existsSync(path.join(dir, 'script.md')),
    warnings: clips.filter((c) => c.status && c.status !== 'ok' && c.status !== 'checking').length,
    orphanParts: listOrphanParts(dir).length,
    agentCost: totalCost,
    agentRuns: runs.length,
  }
}

// ---- IPC: capture sources --------------------------------------------------

ipcMain.handle('list-sources', async () => {
  // Request displays and windows separately: on macOS either list can arrive
  // with empty thumbnails during desktop reconfiguration. Retry that list once.
  async function list(kind) {
    const options = { types: [kind], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: true }
    const first = await desktopCapturer.getSources(options)
    if (first.length && first.some(s => !s.thumbnail.isEmpty())) return first
    await new Promise(resolve => setTimeout(resolve, 200))
    const retry = await desktopCapturer.getSources(options)
    return retry.length ? retry : first
  }
  const sources = [...await list('screen'), ...await list('window')]
  // Map screen capture-sources to real displays so the UI can say *which*
  // monitor it is (nº, principal, resolución) instead of just "Entire screen".
  const displays = screen.getAllDisplays()
  const primaryId = screen.getPrimaryDisplay().id
  const appName = app.getName()
  return sources.map((s) => {
    const isScreen = s.id.startsWith('screen')
    let name = s.name
    let detail = ''
    if (isScreen) {
      const di = displays.findIndex((d) => String(d.id) === String(s.display_id))
      const disp = di >= 0 ? displays[di] : null
      const num = di >= 0 ? di + 1 : (displays.length > 1 ? '?' : 1)
      const isPrimary = disp ? disp.id === primaryId : displays.length <= 1
      name = `Pantalla ${num}${isPrimary ? ' · principal' : ''}`
      if (disp) {
        const { width, height } = disp.size
        detail = `${Math.round(width * disp.scaleFactor)}×${Math.round(height * disp.scaleFactor)}`
      }
    } else {
      detail = s.name.toLowerCase().includes(appName.toLowerCase()) ? 'This app · mirror effect' : 'This window only'
    }
    return {
      id: s.id,
      name,
      title: s.name,
      detail,
      kind: isScreen ? 'screen' : 'window',
      isApp: !isScreen && s.name.toLowerCase().includes(appName.toLowerCase()),
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }
  })
})

// ---- IPC: folders ----------------------------------------------------------

ipcMain.handle('choose-dir', async (_e, title) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: title || 'Choose folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (res.canceled || !res.filePaths[0]) return null
  registerRoot(res.filePaths[0])
  return res.filePaths[0]
})

// Espacio libre en el disco de la carpeta (para avisar antes de grabar).
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024
ipcMain.handle('disk-free', async (_e, p) => {
  const bytes = freeBytes(p || settings.get('root') || app.getPath('home'))
  return { bytes, human: fmtBytes(bytes), low: bytes != null && bytes < MIN_FREE_BYTES, minHuman: fmtBytes(MIN_FREE_BYTES) }
})

// ---- IPC: projects ---------------------------------------------------------

ipcMain.handle('list-projects', async (_e, root) => {
  if (!root || !fs.existsSync(root)) return []
  guardRoot(root)
  const out = []
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const summary = summarizeProject(path.join(root, e.name))
    if (summary) out.push(summary)
  }
  out.sort((a, b) => (b.created || '').localeCompare(a.created || ''))
  return out
})

ipcMain.handle('create-project', async (_e, { root, name, script }) => {
  guardRoot(root)
  fs.mkdirSync(root, { recursive: true })
  const dir = uniqueDir(root, slugify(name))
  fs.mkdirSync(path.join(dir, 'clips'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'edit'), { recursive: true })
  const project = {
    version: 2,
    name: name || path.basename(dir),
    slug: path.basename(dir),
    created: stamp(),
    updated: stamp(),
    audio_source: 'webcam',
    compose_opts: { ...DEFAULT_OPTS },
    clips: [],
    agentRuns: [],
  }
  if (script && script.text) {
    fs.writeFileSync(path.join(dir, 'script.md'), script.text)
    project.teleprompter = script.text
    project.script = { source: script.path || null, words: wordCount(script.text) }
  }
  writeJson(path.join(dir, 'project.json'), project)
  return summarizeProject(dir)
})

function clipDetail(dir, c) {
  const webcamPath = path.join(dir, c.webcam || `clips/${c.id}/webcam.webm`)
  const sync = readJson(path.join(dir, 'clips', c.id, 'sync.json'), null)
  const enhanced = !!(c.enhanced || (sync && sync.enhanced === 'nvidia_studio_voice'))
  return {
    id: c.id,
    durationMs: c.duration_ms || 0,
    offsetMs: c.offset_ms || 0,
    created: c.created || '',
    status: c.status || 'ok',
    statusNote: c.status_note || '',
    enhanced,
    webcamPath,
    cameraProcessing: c.camera_processing || null,
    thumbDataUrl: c.cam?.afterRecord && c.camera_processing?.status !== 'done' ? null : frameUrl(webcamPath, path.join(dir, 'clips', c.id, '_thumb.jpg'), 0.5),
  }
}

ipcMain.handle('project-detail', async (_e, dir) => {
  guardPath(dir, 'carpeta del proyecto')
  const summary = summarizeProject(dir)
  if (!summary) return null
  const proj = readProjectJson(dir)
  const clips = (proj.clips || []).map((c) => clipDetail(dir, c))
  return { ...summary, clips, teleprompter: proj.teleprompter || '', orphans: listOrphanParts(dir), script: proj.script || null }
})

ipcMain.handle('set-teleprompter', async (_e, { dir, text }) => {
  guardPath(dir, 'carpeta del proyecto')
  const proj = readProjectJson(dir)
  if (!proj) throw new Error('project.json no encontrado')
  proj.teleprompter = text || ''
  writeProjectJson(dir, proj)
  return summarizeProject(dir)
})

// ---- IPC: grabación por chunks -----------------------------------------------
// El renderer envía cada chunk del MediaRecorder según llega (cada ~1 s) y aquí
// se APPENDEA a `clips/clip_NN/{screen,webcam}.part.webm`. Si la app muere a mitad
// de toma, lo grabado hasta entonces sigue en disco y se puede recuperar.

const openClips = new Map() // clipDir -> { fds: {screen, webcam}, bytes: {screen, webcam} }
const cameraFinalizer = new (require('./camera-finalizer').CameraFinalizer)({
  read: readProjectJson, write: writeProjectJson, ffmpeg: ffmpegPath, ffprobe: ffprobePath,
  capturing: () => recordingActive || openClips.size > 0,
  notify: payload => {
    agent.broadcast('camera-finalized', payload)
    if (payload.status === 'done') enhanceClipAsync(payload.dir, payload.clipId).catch(console.error)
  },
})
app.on('will-quit', () => cameraFinalizer.close())
function resumeCameraJobs(dir, project) {
  for (const clip of project.clips || []) {
    if (clip.cam?.afterRecord && ['queued', 'processing'].includes(clip.camera_processing?.status)) cameraFinalizer.enqueue(dir, clip.id)
  }
}
function requireFinishedCameras(dir) {
  if (readProjectJson(dir)?.clips?.some(c => c.cam?.afterRecord && c.camera_processing?.status !== 'done')) {
    throw Error('Wait for the clip backgrounds to finish. If any failed, hit Retry background.')
  }
}
ipcMain.handle('camera-finalize-retry', async (_event, { dir, clipId }) => {
  guardPath(dir)
  const project = readProjectJson(dir), clip = project?.clips?.find(c => c.id === clipId)
  if (!clip?.cam?.afterRecord || clip.camera_processing?.status !== 'failed') throw Error('This clip has no pending background to retry')
  clip.camera_processing = { status: 'queued' }; writeProjectJson(dir, project)
  cameraFinalizer.enqueue(dir, clipId)
  return { ok: true }
})


function nextClipId(dir, proj) {
  const used = new Set((proj.clips || []).map((c) => c.id))
  let n = (proj.clips || []).length + 1
  let id = `clip_${String(n).padStart(2, '0')}`
  while (used.has(id) || fs.existsSync(path.join(dir, 'clips', id))) { n += 1; id = `clip_${String(n).padStart(2, '0')}` }
  return id
}

ipcMain.handle('clip-begin', async (_e, { dir }) => {
  guardPath(dir, 'carpeta del proyecto')
  const proj = readProjectJson(dir)
  if (!proj) throw new Error('project.json no encontrado en ' + dir)
  const clipId = nextClipId(dir, proj)
  const clipDir = path.join(dir, 'clips', clipId)
  fs.mkdirSync(clipDir, { recursive: true })
  const fds = {
    screen: fs.openSync(path.join(clipDir, 'screen.part.webm'), 'w'),
    webcam: fs.openSync(path.join(clipDir, 'webcam.part.webm'), 'w'),
  }
  writeJson(path.join(clipDir, 'recording.json'), { started: stamp(), clipId, status: 'recording' })
  openClips.set(clipDir, { fds, bytes: { screen: 0, webcam: 0 }, clipId, dir })
  return { clipId, clipDir }
})

function saveCameraSeed(clipDir, { width, height, pixels, alpha }) {
  if ( !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1920 || height > 1080 ||
      !(pixels instanceof Uint8Array) || pixels.length !== width * height * 4 || !(alpha instanceof Uint8Array) || alpha.length !== 288 * 512) throw Error('Invalid camera calibration')
  fs.writeFileSync(path.join(clipDir, 'camera-seed.rgba'), pixels)
  fs.writeFileSync(path.join(clipDir, 'camera-seed.alpha'), alpha)
  writeJson(path.join(clipDir, 'camera-seed.json'), { width, height })
}
ipcMain.handle('clip-camera-seed', (_e, { clipDir, ...seed }) => {
  if (!openClips.has(clipDir)) throw Error('Clip no abierto')
  saveCameraSeed(clipDir, seed)
})

ipcMain.handle('clip-chunk', async (_e, { clipDir, track, data }) => {
  const oc = openClips.get(clipDir)
  if (!oc || !oc.fds[track]) throw new Error('clip no abierto: ' + clipDir)
  const buf = Buffer.from(data)
  fs.writeSync(oc.fds[track], buf)
  oc.bytes[track] += buf.length
  return oc.bytes[track]
})

function closeClipFds(oc) {
  for (const k of Object.keys(oc.fds)) { try { fs.closeSync(oc.fds[k]) } catch { /* closed */ } }
}

ipcMain.handle('clip-abort', async (_e, { clipDir }) => {
  const oc = openClips.get(clipDir)
  if (oc) { closeClipFds(oc); openClips.delete(clipDir) }
  try { guardPath(clipDir, 'clip'); fs.rmSync(clipDir, { recursive: true, force: true }) } catch { /* ignore */ }
  return { ok: true }
})

function writeSyncJson(clipDir, { durationMs, offsetMs, dims, pauses, firstData }) {
  const sync = {
    version: 2, created: stamp(), audio_source: 'webcam',
    duration_ms: Math.round(durationMs), offset_ms: Math.round(offsetMs),
    note: 'offset_ms = webcam_start - screen_start; align by trimming the head of the later source.',
    first_data_ms: firstData || null, // primer chunk real de cada recorder relativo al inicio (alternativa al offset por onstart)
    pauses_ms: pauses || [],          // intervalos [start,end] relativos al inicio en los que se pausó
    sources: { screen: { file: 'screen.webm', dims: dims.screen }, webcam: { file: 'webcam.webm', dims: dims.webcam } },
  }
  writeJson(path.join(clipDir, 'sync.json'), sync)
  return sync
}

function finalizeClip(dir, clipId, meta) {
  const clipDir = path.join(dir, 'clips', clipId)
  for (const t of ['screen', 'webcam']) {
    const part = path.join(clipDir, `${t}.part.webm`)
    if (fs.existsSync(part)) fs.renameSync(part, path.join(clipDir, `${t}.webm`))
  }
  try { fs.unlinkSync(path.join(clipDir, 'recording.json')) } catch { /* none */ }
  let cameraError = ''
  try {
  if (meta.cam?.afterRecord && meta.cam.background) {
    const image = meta.cam.background
    if (!isUnder(path.join(__dirname, '..', 'src/backgrounds'), image) && !(settings.get('bgAllowed', []) || []).includes(image)) throw Error('Camera background not allowed')
    if (!BG_MIME[path.extname(image).toLowerCase()]) throw Error('Unsupported background format')
    const saved = path.join(clipDir, 'camera-background' + path.extname(image).toLowerCase())
    fs.copyFileSync(image, saved); meta.cam = { ...meta.cam, background: saved }
  }
  } catch (error) { cameraError = error.message }
  const sync = writeSyncJson(clipDir, meta)
  const proj = readProjectJson(dir)
  proj.clips = (proj.clips || []).filter((c) => c.id !== clipId)
  proj.clips.push({
    id: clipId, created: sync.created, duration_ms: sync.duration_ms, offset_ms: sync.offset_ms,
    screen: `clips/${clipId}/screen.webm`, webcam: `clips/${clipId}/webcam.webm`, dims: meta.dims,
    status: 'checking', recorder_errors: meta.errors || [],
    ...(meta.cam?.afterRecord ? { camera_processing: cameraError ? { status: 'failed', error: cameraError } : { status: 'queued' } } : {}),
    // Qué se grabó y sobre qué fondo hay que recomponer. `cam.raw` = la pista de
    // cámara NO lleva el fondo cocido; `_scripts/rematte_cam.py` lo compone
    // después con un modelo mejor que el de tiempo real.
    ...(meta.cam ? { cam: meta.cam } : {}),
  })
  writeProjectJson(dir, proj)
  validateClipAsync(dir, clipId, sync.duration_ms, meta.errors || [])
}

ipcMain.handle('clip-finish', async (_e, { clipDir, durationMs, offsetMs, dims, pauses, firstData, errors, cam }) => {
  const oc = openClips.get(clipDir)
  if (!oc) throw new Error('clip no abierto: ' + clipDir)
  closeClipFds(oc); openClips.delete(clipDir)
  const meta = { durationMs, offsetMs, dims, pauses, firstData, errors, cam }
  if (!oc.bytes.screen && !oc.bytes.webcam) {
    fs.rmSync(clipDir, { recursive: true, force: true })
    throw new Error('the recording produced no data (0 bytes on both tracks)')
  }
  finalizeClip(oc.dir, oc.clipId, meta)
  return summarizeProject(oc.dir)
})

// Duración real de un webm (MediaRecorder no escribe la duración en la cabecera,
// así que se lee el pts del último paquete). Asíncrono: no bloquea el guardado.
function probeDurationMs(file) {
  return new Promise((resolve) => {
    const ffprobe = ffprobePath()
    if (!ffprobe || !fs.existsSync(file)) return resolve(null)
    const p = spawn(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file])
    let tail = ''
    p.stdout.on('data', (d) => {
      tail += d.toString()
      if (tail.length > 4096) tail = tail.slice(-4096)
    })
    p.on('close', () => {
      const lines = tail.trim().split('\n').filter(Boolean)
      const v = parseFloat(lines[lines.length - 1] || '')
      resolve(Number.isFinite(v) ? Math.round(v * 1000) : null)
    })
    p.on('error', () => resolve(null))
  })
}

async function validateClipAsync(dir, clipId, expectedMs, errors) {
  const clipDir = path.join(dir, 'clips', clipId)
  const probed = {}
  for (const t of ['screen', 'webcam']) probed[t] = await probeDurationMs(path.join(clipDir, `${t}.webm`))
  const sizes = {}
  for (const t of ['screen', 'webcam']) { try { sizes[t] = fs.statSync(path.join(clipDir, `${t}.webm`)).size } catch { sizes[t] = 0 } }
  let status = 'ok'
  const notes = []
  for (const t of ['screen', 'webcam']) {
    const label = t === 'screen' ? 'pantalla' : 'cámara'
    if (!sizes[t]) { status = 'empty'; notes.push(`${label}: fichero vacío`); continue }
    if (probed[t] == null) { notes.push(`${label}: no se pudo medir`); continue }
    if (expectedMs && probed[t] < expectedMs - 2000) {
      if (status !== 'empty') status = 'truncated'
      notes.push(`${label}: ${(probed[t] / 1000).toFixed(1)}s of ${(expectedMs / 1000).toFixed(1)}s expected`)
    }
  }
  if (errors && errors.length && status === 'ok') { status = 'warning'; notes.push('the recorder reported errors: ' + errors.join('; ')) }
  const proj = readProjectJson(dir)
  if (!proj) return
  const c = (proj.clips || []).find((x) => x.id === clipId)
  if (!c) return
  c.status = status
  c.status_note = notes.join(' · ')
  c.probed_ms = probed
  writeProjectJson(dir, proj)
  try {
    const sync = readJson(path.join(clipDir, 'sync.json'), null)
    if (sync) { sync.probed_ms = probed; sync.status = status; writeJson(path.join(clipDir, 'sync.json'), sync) }
  } catch { /* ignore */ }
  agent.broadcast('clip-validated', { dir, clipId, status, note: c.status_note, probed })
  if (c.cam?.afterRecord && c.camera_processing?.status !== 'done') {
    if (['queued', 'processing'].includes(c.camera_processing?.status)) cameraFinalizer.enqueue(dir, clipId)
  } else if (status === 'ok' || status === 'warning') {
    enhanceClipAsync(dir, clipId).catch((err) => console.error(`[voice] error en auto-mejora de ${clipId}:`, err.message))
  }
}

// ---- Mejora de voz automática con NVIDIA Studio Voice NIM -------------------
function voiceEnhanceScript() {
  const p = path.join(__dirname, '..', 'video-use', 'helpers', 'enhance_voice.py')
  return fs.existsSync(p) ? p : null
}
function voicePythonBin() {
  const venvPy = path.join(__dirname, '..', 'video-use', '.venv', 'bin', 'python')
  if (fs.existsSync(venvPy)) return venvPy
  const editVenvPy = path.join(__dirname, '..', 'record-studio', 'edit', '.venv', 'bin', 'python')
  if (fs.existsSync(editVenvPy)) return editVenvPy
  return findBin('python3', ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'])
}

async function enhanceClipAsync(dir, clipId, force = false) {
  const camera = readProjectJson(dir)?.clips?.find(c => c.id === clipId)
  if (camera?.cam?.afterRecord && (camera.camera_processing?.status !== 'done' || camera.status === 'checking')) return { ok: false, error: 'Wait for the clip background to finish' }
  const script = voiceEnhanceScript()
  if (!script) return { ok: false, error: 'script enhance_voice.py no encontrado' }
  const py = voicePythonBin()
  if (!py) return { ok: false, error: 'python3 no encontrado' }

  const env = { ...process.env, ...agent.serviceEnv() }
  const hasKey = !!(env.NVIDIA_API_KEY || env.NGC_API_KEY)
  const enabled = settings.get('enhanceVoice', true)
  if (!hasKey || !enabled) {
    return { ok: false, skipped: true, error: !hasKey ? 'sin NVIDIA_API_KEY' : 'desactivado en ajustes' }
  }

  const clipDir = path.join(dir, 'clips', clipId)
  if (!fs.existsSync(clipDir)) return { ok: false, error: 'clip no existe' }

  agent.broadcast('clip-enhancing', { dir, clipId, status: 'enhancing' })

  return new Promise((resolve) => {
    const args = [script, '--clip', clipDir]
    if (force) args.push('--force')
    const child = spawn(py, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (d) => { output += d.toString() })
    child.stderr.on('data', (d) => { output += d.toString() })
    child.on('close', (code) => {
      const ok = code === 0
      if (ok) {
        const proj = readProjectJson(dir)
        if (proj) {
          const c = (proj.clips || []).find((x) => x.id === clipId)
          if (c) c.enhanced = true
          writeProjectJson(dir, proj)
        }
        agent.broadcast('clip-enhanced', { dir, clipId, status: 'ok', enhanced: true })
        resolve({ ok: true, enhanced: true })
      } else {
        const tail = output.trim().split('\n').slice(-2).join(' ')
        console.warn(`[voice] fallo al mejorar audio de ${clipId} (código ${code}): ${tail}`)
        agent.broadcast('clip-enhanced', { dir, clipId, status: 'err', error: tail })
        resolve({ ok: false, error: tail })
      }
    })
    child.on('error', (err) => {
      console.warn(`[voice] error al ejecutar ${py}:`, err.message)
      agent.broadcast('clip-enhanced', { dir, clipId, status: 'err', error: err.message })
      resolve({ ok: false, error: err.message })
    })
  })
}

async function enhanceAllClipsAsync(dir, force = false) {
  requireFinishedCameras(dir)
  const script = voiceEnhanceScript()
  if (!script) return { ok: false, error: 'script enhance_voice.py no encontrado' }
  const py = voicePythonBin()
  if (!py) return { ok: false, error: 'python3 no encontrado' }
  const env = { ...process.env, ...agent.serviceEnv() }
  const hasKey = !!(env.NVIDIA_API_KEY || env.NGC_API_KEY)
  if (!hasKey) return { ok: false, error: 'NVIDIA_API_KEY was not found in the environment or in ~/.config/record-studio/.env' }

  return new Promise((resolve) => {
    const args = [script, '--all', '--dir', dir]
    if (force) args.push('--force')
    const child = spawn(py, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (d) => { output += d.toString() })
    child.stderr.on('data', (d) => { output += d.toString() })
    child.on('close', (code) => {
      const ok = code === 0
      const proj = readProjectJson(dir)
      if (proj && ok) {
        for (const c of proj.clips || []) c.enhanced = true
        writeProjectJson(dir, proj)
      }
      agent.broadcast('project-clips-enhanced', { dir, ok, output })
      resolve({ ok, output })
    })
    child.on('error', (err) => resolve({ ok: false, error: err.message }))
  })
}

ipcMain.handle('clip-enhance', async (_e, { dir, clipId, force }) => {
  guardPath(dir, 'carpeta del proyecto')
  return enhanceClipAsync(dir, clipId, force)
})
ipcMain.handle('project-enhance-clips', async (_e, { dir, force }) => {
  guardPath(dir, 'carpeta del proyecto')
  return enhanceAllClipsAsync(dir, force)
})


// Tomas a medias de una sesión anterior (la app murió grabando).
function listOrphanParts(dir) {
  const out = []
  const clipsDir = path.join(dir, 'clips')
  if (!fs.existsSync(clipsDir)) return out
  for (const e of fs.readdirSync(clipsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const clipDir = path.join(clipsDir, e.name)
    if (openClips.has(clipDir)) continue
    const parts = ['screen', 'webcam'].filter((t) => fs.existsSync(path.join(clipDir, `${t}.part.webm`)))
    if (!parts.length) continue
    const bytes = parts.reduce((a, t) => a + fs.statSync(path.join(clipDir, `${t}.part.webm`)).size, 0)
    const rec = readJson(path.join(clipDir, 'recording.json'), {}) || {}
    out.push({ clipId: e.name, clipDir, parts, bytes, human: fmtBytes(bytes), started: rec.started || '' })
  }
  return out
}

ipcMain.handle('clip-recover', async (_e, { dir, clipId }) => {
  guardPath(dir, 'carpeta del proyecto')
  const clipDir = path.join(dir, 'clips', clipId)
  const oc = openClips.get(clipDir)
  if (oc) { closeClipFds(oc); openClips.delete(clipDir) }
  const probed = {}
  for (const t of ['screen', 'webcam']) probed[t] = await probeDurationMs(path.join(clipDir, `${t}.part.webm`))
  const durationMs = Math.max(probed.screen || 0, probed.webcam || 0)
  if (!durationMs) throw new Error('the take has no readable video; it can only be discarded')
  finalizeClip(dir, clipId, { durationMs, offsetMs: 0, dims: { screen: null, webcam: null }, pauses: [], errors: ['recuperado tras un cierre inesperado'] })
  return summarizeProject(dir)
})

ipcMain.handle('clip-discard-part', async (_e, { dir, clipId }) => {
  guardPath(dir, 'carpeta del proyecto')
  const clipDir = path.join(dir, 'clips', clipId)
  try { await shell.trashItem(clipDir) } catch { fs.rmSync(clipDir, { recursive: true, force: true }) }
  return summarizeProject(dir)
})

// Compatibilidad: guardado "todo de golpe" (fallback si el streaming falla).
ipcMain.handle('append-clip', async (_e, payload) => {
  const { dir, screenBuf, webcamBuf, durationMs, offsetMs, dims, cam } = payload
  guardPath(dir, 'carpeta del proyecto')
  const proj = readProjectJson(dir)
  if (!proj) throw new Error('project.json no encontrado en ' + dir)
  const clipId = nextClipId(dir, proj)
  const clipDir = path.join(dir, 'clips', clipId)
  fs.mkdirSync(clipDir, { recursive: true })
  fs.writeFileSync(path.join(clipDir, 'screen.webm'), Buffer.from(screenBuf))
  fs.writeFileSync(path.join(clipDir, 'webcam.webm'), Buffer.from(webcamBuf))
  if (payload.seed && cam?.afterRecord) saveCameraSeed(clipDir, payload.seed)
  finalizeClip(dir, clipId, { durationMs, offsetMs, dims, pauses: [], errors: [], cam })
  return summarizeProject(dir)
})

ipcMain.handle('delete-clip', async (_e, { dir, clipId }) => {
  guardPath(dir, 'carpeta del proyecto')
  await cameraFinalizer.cancel(dir, clipId)
  const proj = readProjectJson(dir)
  if (!proj) throw new Error('project.json no encontrado')
  proj.clips = (proj.clips || []).filter((c) => c.id !== clipId)
  writeProjectJson(dir, proj)
  try { await shell.trashItem(path.join(dir, 'clips', clipId)) } catch { /* maybe gone */ }
  return summarizeProject(dir)
})

ipcMain.handle('reorder-clips', async (_e, { dir, orderedIds }) => {
  guardPath(dir, 'carpeta del proyecto')
  const proj = readProjectJson(dir)
  if (!proj) throw new Error('project.json no encontrado')
  const byId = new Map((proj.clips || []).map((c) => [c.id, c]))
  proj.clips = orderedIds.map((id) => byId.get(id)).filter(Boolean)
  writeProjectJson(dir, proj)
  return summarizeProject(dir)
})

ipcMain.handle('rename-project', async (_e, { dir, name }) => {
  guardPath(dir, 'carpeta del proyecto')
  const proj = readProjectJson(dir)
  if (!proj) throw new Error('project.json no encontrado')
  proj.name = name || proj.name
  writeProjectJson(dir, proj)
  return summarizeProject(dir)
})

ipcMain.handle('delete-project', async (_e, dir) => {
  try { guardPath(dir, 'carpeta del proyecto'); await cameraFinalizer.cancel(dir); await shell.trashItem(dir); return { ok: true } } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('set-compose-opts', async (_e, { dir, opts }) => {
  guardPath(dir, 'carpeta del proyecto')
  const proj = readProjectJson(dir)
  if (!proj) throw new Error('project.json no encontrado')
  proj.compose_opts = { ...DEFAULT_OPTS, ...(proj.compose_opts || {}), ...(opts || {}) }
  writeProjectJson(dir, proj)
  return proj.compose_opts
})

// ---- IPC: compose / iterate (headless agent + video-use) -------------

// Success = the REQUESTED final(s) exist (per opts.aspect). Invalidates both
// cached posters so the new render gets fresh thumbnails.
function composeSuccess(dir, opts) {
  const aspect = normAspect(opts)
  return () => {
    const p169 = path.join(dir, 'edit', 'final.mp4')
    const p916 = path.join(dir, 'edit', 'final_9x16.mp4')
    if (aspect !== '9:16' && !fs.existsSync(p169)) return null
    if (aspect !== '16:9' && !fs.existsSync(p916)) return null
    try { fs.unlinkSync(path.join(dir, 'edit', '_poster.jpg')) } catch { /* none */ }
    try { fs.unlinkSync(path.join(dir, 'edit', '_poster_9x16.jpg')) } catch { /* none */ }
    return { summary: summarizeProject(dir) }
  }
}

// Persist each provider's session id so a later edit can resume
// the SAME conversation (remembers prior changes).
function saveAgentSession(dir, provider) {
  return (id) => {
    const proj = readProjectJson(dir)
    if (!proj) return
    providers.setSession(proj, provider, id)
    writeProjectJson(dir, proj)
  }
}
// Histórico de coste por proyecto (evento `result` del agente).
function saveAgentRun(dir, kind, provider) {
  return (info) => {
    const proj = readProjectJson(dir)
    if (!proj) return
    proj.agentRuns = proj.agentRuns || []
    proj.agentRuns.push({ kind, provider, at: stamp(), ...info })
    writeProjectJson(dir, proj)
  }
}
function resumeIdFor(dir, resume, provider) {
  if (!resume) return null
  const proj = readProjectJson(dir)
  return providers.sessionFor(proj, provider)
}
function projectCtx(dir) {
  return { hasScript: fs.existsSync(path.join(dir, 'script.md')), skillContext: providers.skillContext() }
}

ipcMain.handle('compose-project', async (_e, { dir, opts, resume }) => {
  guardPath(dir, 'carpeta del proyecto')
  requireFinishedCameras(dir)
  const provider = agent.selectedProvider()
  return agent.runAgentJob(dir, dir, prompts.composePrompt(opts, projectCtx(dir)), composeSuccess(dir, opts), 'Iniciando montaje (video-use)…', {
    provider, resumeId: resumeIdFor(dir, resume, provider), onSession: saveAgentSession(dir, provider), onResult: saveAgentRun(dir, 'compose', provider),
    logDir: path.join(dir, 'edit'), maxTurns: 400,
  })
})
ipcMain.handle('iterate-project', async (_e, { dir, feedback, opts, resume }) => {
  guardPath(dir, 'carpeta del proyecto')
  requireFinishedCameras(dir)
  const provider = agent.selectedProvider()
  return agent.runAgentJob(dir, dir, prompts.iteratePrompt(feedback, opts, projectCtx(dir)), composeSuccess(dir, opts), 'Aplicando cambios…', {
    provider, resumeId: resumeIdFor(dir, resume, provider), onSession: saveAgentSession(dir, provider), onResult: saveAgentRun(dir, 'iterate', provider),
    logDir: path.join(dir, 'edit'), maxTurns: 300,
  })
})

// Does this project already have a saved conversation to continue?
ipcMain.handle('agent-session', async (_e, dir) => {
  const proj = readProjectJson(dir)
  const provider = agent.selectedProvider()
  return { hasSession: !!providers.sessionFor(proj, provider), provider }
})

ipcMain.handle('agent-status', async (_e, key) => agent.status(key))
ipcMain.handle('agent-cancel', async (_e, key) => agent.cancel(key))
ipcMain.handle('agent-log', async (_e, key) => {
  const st = agent.status(key)
  if (!st || !st.logFile) return ''
  try { const t = fs.readFileSync(st.logFile, 'utf8'); return t.slice(-20000) } catch { return '' }
})

// ---- IPC: scripts (style profile + script writing) -------------------------

function scriptsDir(root) { return path.join(root, '_scripts') }
function pace(root) { return readJson(path.join(scriptsDir(root), 'pace.json'), null) }
function feedbackPairs(root) {
  const fd = path.join(scriptsDir(root), 'feedback')
  if (!fs.existsSync(fd)) return []
  return fs.readdirSync(fd).filter((f) => f.endsWith('.final.md')).map((f) => f.replace(/\.final\.md$/, '')).sort().reverse()
}
function scriptCtx(root) { return { pace: pace(root), feedbackPairs: feedbackPairs(root) } }

ipcMain.handle('scripts-status', async (_e, root) => {
  if (!root) return { hasProfile: false }
  guardRoot(root)
  const sd = scriptsDir(root)
  const hasProfile = fs.existsSync(path.join(sd, 'style_profile.md'))
  let corpus = 0
  try { corpus = fs.readdirSync(path.join(sd, 'corpus')).filter((f) => f.endsWith('.txt')).length } catch { /* none */ }
  let profileMtime = 0
  try { profileMtime = fs.statSync(path.join(sd, 'style_profile.md')).mtimeMs } catch { /* none */ }
  return { hasProfile, corpus, profileMtime, pace: pace(root), feedbackPairs: feedbackPairs(root).length }
})

ipcMain.handle('analyze-channel', async (_e, { root, channel, incremental }) => {
  guardRoot(root)
  const sd = scriptsDir(root)
  fs.mkdirSync(path.join(sd, 'corpus'), { recursive: true })
  const inc = !!incremental && fs.existsSync(path.join(sd, 'style_profile.md'))
  return agent.runAgentJob('style', sd, prompts.analyzePrompt(channel, { incremental: inc }),
    () => (fs.existsSync(path.join(sd, 'style_profile.md')) ? { ok: true, pace: pace(root) } : null),
    inc ? 'Updating your profile with the new videos…' : 'Analysing your channel with yt-dlp…', { maxTurns: 150 })
})

function scriptResult(p) {
  return () => {
    if (!fs.existsSync(p)) return null
    const text = fs.readFileSync(p, 'utf8')
    const srcPath = p.replace(/\.md$/, '.sources.md')
    const sources = fs.existsSync(srcPath) ? fs.readFileSync(srcPath, 'utf8') : ''
    return { path: p, text, sources, words: wordCount(text) }
  }
}

ipcMain.handle('generate-script', async (_e, { root, topic, opts }) => {
  guardRoot(root)
  const sd = scriptsDir(root)
  fs.mkdirSync(path.join(sd, 'drafts'), { recursive: true })
  const draftPath = path.join(sd, 'drafts', `g_${stamp()}.md`)
  writeJson(draftPath.replace(/\.md$/, '.brief.json'), { topic, opts, created: stamp() })
  return agent.runAgentJob('script', sd, prompts.generatePrompt(topic, opts, draftPath, scriptCtx(root)),
    scriptResult(draftPath), 'Redactando guion en tu estilo…', { maxTurns: 120 })
})

// Antes de reescribir se guarda una versión (drafts/versions/<name>.vN.md).
function snapshotVersion(scriptPath) {
  try {
    const vd = path.join(path.dirname(scriptPath), 'versions')
    fs.mkdirSync(vd, { recursive: true })
    const base = path.basename(scriptPath, '.md')
    const n = fs.readdirSync(vd).filter((f) => f.startsWith(base + '.v')).length + 1
    const out = path.join(vd, `${base}.v${n}.md`)
    fs.copyFileSync(scriptPath, out)
    return out
  } catch { return null }
}

ipcMain.handle('rewrite-script', async (_e, { root, scriptPath, feedback, opts }) => {
  guardRoot(root); guardPath(scriptPath, 'guion')
  const sd = scriptsDir(root)
  snapshotVersion(scriptPath)
  return agent.runAgentJob('script', sd, prompts.rewritePrompt(scriptPath, feedback, opts, scriptCtx(root)),
    scriptResult(scriptPath), 'Reescribiendo el guion…', { maxTurns: 120 })
})

ipcMain.handle('hooks-script', async (_e, { root, scriptPath }) => {
  guardRoot(root); guardPath(scriptPath, 'guion')
  const sd = scriptsDir(root)
  const out = scriptPath.replace(/\.md$/, '.hooks.md')
  return agent.runAgentJob('hooks', sd, prompts.hooksPrompt(scriptPath, out, scriptCtx(root)),
    () => (fs.existsSync(out) ? { path: out, text: fs.readFileSync(out, 'utf8') } : null), 'Proponiendo ganchos…', { maxTurns: 60 })
})

ipcMain.handle('script-versions', async (_e, scriptPath) => {
  guardPath(scriptPath, 'guion')
  const vd = path.join(path.dirname(scriptPath), 'versions')
  const base = path.basename(scriptPath, '.md')
  if (!fs.existsSync(vd)) return []
  const num = (s) => parseInt((/\.v(\d+)\.md$/.exec(s) || [])[1] || '0', 10)
  return fs.readdirSync(vd).filter((f) => f.startsWith(base + '.v')).sort((a, b) => num(b) - num(a))
    .map((f) => ({ path: path.join(vd, f), label: 'v' + num(f), mtime: fs.statSync(path.join(vd, f)).mtimeMs }))
})

ipcMain.handle('list-scripts', async (_e, root) => {
  if (!root) return []
  guardRoot(root)
  const dd = path.join(scriptsDir(root), 'drafts')
  if (!fs.existsSync(dd)) return []
  const out = []
  for (const f of fs.readdirSync(dd)) {
    if (!f.endsWith('.md') || /\.(sources|hooks)\.md$/.test(f)) continue
    const p = path.join(dd, f)
    const st = fs.statSync(p)
    const text = fs.readFileSync(p, 'utf8')
    const brief = readJson(p.replace(/\.md$/, '.brief.json'), null)
    const firstLine = text.split('\n').find((l) => l.trim() && !/^[A-ZÁÉÍÓÚÑ0-9 ]{3,}$/.test(l.trim())) || f
    const title = (brief && brief.topic ? brief.topic.split('\n')[0] : firstLine).replace(/^#+\s*/, '').slice(0, 80)
    out.push({ path: p, title, mtime: st.mtimeMs, preview: text.slice(0, 180), words: wordCount(text), hasSources: fs.existsSync(p.replace(/\.md$/, '.sources.md')) })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
})

ipcMain.handle('read-script', async (_e, p) => { try { guardPath(p, 'guion'); return fs.readFileSync(p, 'utf8') } catch { return '' } })
ipcMain.handle('save-script', async (_e, { path: p, text }) => { guardPath(p, 'guion'); util.writeFileAtomic(p, text); return { ok: true } })
ipcMain.handle('delete-script', async (_e, p) => {
  try {
    guardPath(p, 'guion'); await shell.trashItem(p)
    for (const side of ['.sources.md', '.hooks.md', '.brief.json']) { try { fs.unlinkSync(p.replace(/\.md$/, side)) } catch { /* none */ } }
    return { ok: true }
  } catch { return { ok: false } }
})

// Cuando el usuario graba con un guion, la versión que realmente leyó es la
// "final" y el borrador original del agente el "draft": el par se guarda en
// _scripts/feedback/ y se usa como referencia en los siguientes prompts.
ipcMain.handle('script-feedback', async (_e, { root, scriptPath, finalText }) => {
  guardRoot(root); if (scriptPath) guardPath(scriptPath, 'guion')
  const fd = path.join(scriptsDir(root), 'feedback')
  fs.mkdirSync(fd, { recursive: true })
  const id = scriptPath ? path.basename(scriptPath, '.md') : `g_${stamp()}`
  // El borrador original es la v1 guardada (si existió reescritura) o el fichero tal cual.
  let draft = ''
  const v1 = scriptPath ? path.join(path.dirname(scriptPath), 'versions', `${id}.v1.md`) : null
  if (v1 && fs.existsSync(v1)) draft = fs.readFileSync(v1, 'utf8')
  else if (scriptPath && fs.existsSync(scriptPath)) draft = fs.readFileSync(scriptPath, 'utf8')
  if (!draft || draft.trim() === (finalText || '').trim()) return { ok: false, reason: 'sin cambios respecto al borrador' }
  fs.writeFileSync(path.join(fd, `${id}.draft.md`), draft)
  fs.writeFileSync(path.join(fd, `${id}.final.md`), finalText || '')
  return { ok: true, id }
})

// ---- IPC: open in Finder / external player ---------------------------------

const OPEN_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v', '.mp3', '.wav', '.m4a', '.srt', '.md', '.txt', '.log', '.json', '.jpg', '.png'])
ipcMain.handle('open-path', async (_e, p) => {
  if (!p) return
  guardPath(p, 'ruta')
  if (!OPEN_EXT.has(path.extname(p).toLowerCase())) throw new Error('tipo de fichero no permitido')
  await shell.openPath(p)
})
ipcMain.handle('export-file', async (_e, p) => {
  guardPath(p, 'fichero')
  const r = await dialog.showSaveDialog(mainWindow, { title: 'Guardar como…', defaultPath: path.basename(p) })
  if (r.canceled || !r.filePath) return { ok: false }
  fs.copyFileSync(p, r.filePath)
  return { ok: true, path: r.filePath }
})
ipcMain.handle('reveal-path', async (_e, p) => { if (p) { guardPath(p, 'ruta'); shell.showItemInFolder(p) } })

// ---- IPC: virtual background image ------------------------------------------
// The renderer runs sandboxed over file://, so images are handed over as data:
// URLs (small, ≤30 MB) instead of raw paths — the CSP allows img-src data:.

const BG_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

function backgroundDataUrl(p) {
  const mime = BG_MIME[path.extname(p).toLowerCase()]
  if (!mime) return null
  if (fs.statSync(p).size > 30 * 1024 * 1024) return null
  return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`
}

ipcMain.handle('pick-background', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a background image',
    properties: ['openFile'],
    filters: [{ name: 'Imágenes', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  })
  if (r.canceled || !r.filePaths[0]) return null
  try {
    const p = r.filePaths[0]
    const saved = (settings.get('bgAllowed', []) || []).filter((x) => x !== p)
    settings.set('bgAllowed', [...saved, p].slice(-20))
    const dataUrl = backgroundDataUrl(p)
    return dataUrl ? { path: p, name: path.basename(p), dataUrl } : null
  } catch { return null }
})

ipcMain.handle('load-background', (_e, p) => {
  try {
    if (!p) return null
    const presetDir = path.join(__dirname, '..', 'src', 'backgrounds')
    const saved = settings.get('bgAllowed', []) || []
    if (!isUnder(presetDir, p) && !saved.includes(p)) return null
    const dataUrl = backgroundDataUrl(p)
    return dataUrl ? { path: p, name: path.basename(p), dataUrl } : null
  } catch { return null }
})

// Bundled preset backgrounds (src/backgrounds/*.jpg|png|webp), label from filename.
ipcMain.handle('list-preset-backgrounds', () => {
  try {
    const dir = path.join(__dirname, '..', 'src', 'backgrounds')
    return fs.readdirSync(dir)
      .filter((f) => BG_MIME[path.extname(f).toLowerCase()])
      .sort()
      .map((f) => {
        const base = f.replace(/\.[^.]+$/, '')
        const label = base.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
        return { label, path: path.join(dir, f) }
      })
  } catch { return [] }
})
