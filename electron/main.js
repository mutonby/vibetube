'use strict'

const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, shell, protocol, net, globalShortcut, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')
const { spawnSync, spawn } = require('child_process')
const { Readable } = require('stream')

// Native PTY for the embedded Claude Code terminal. Rebuilt against Electron's
// ABI (see package.json postinstall). If it can't load, the terminal falls back
// to opening the system Terminal instead of breaking.
let pty = null
try { pty = require('node-pty-prebuilt-multiarch') }
catch (e) { console.error('[pty] node-pty no cargó, la terminal usará Terminal.app:', e.message) }

// The renderer is served over file:// (loadFile) and the background-blur
// library (vendor/vb) runs its segmenter in a Web Worker loaded by URL —
// Chromium blocks file:// workers unless this switch is set.
app.commandLine.appendSwitch('allow-file-access-from-files')

const MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.m4v': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.srt': 'text/plain',
}

let mainWindow = null
let floatWindow = null
let tpWindow = null
let ptyProc = null // the embedded Claude Code terminal's PTY (one at a time)
let FFMPEG = null
let CLAUDE = null

// key -> { status: 'running'|'done'|'error'|'cancelled', log: string[], child, error, result }
// key is a project dir (compose/iterate) or a scripts key ('style' / 'script').
const agentJobs = new Map()

protocol.registerSchemesAsPrivileged([
  { scheme: 'rsmedia', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#0a0a0f',
    title: 'Record Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
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
}

app.whenReady().then(() => {
  // Serve local media WITH HTTP Range support so the <video> player can seek.
  // (net.fetch on a file:// URL ignores Range and returns the whole file as 200,
  // which makes the scrub bar unable to jump forward.)
  protocol.handle('rsmedia', async (request) => {
    try {
      const u = new URL(request.url)
      const filePath = decodeURIComponent(u.pathname.replace(/^\//, ''))
      const stat = fs.statSync(filePath)
      const size = stat.size
      const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
      const range = request.headers.get('Range') || request.headers.get('range')

      const base = { 'Accept-Ranges': 'bytes', 'Content-Type': type, 'Cache-Control': 'no-cache' }

      const m = range && /bytes=(\d*)-(\d*)/.exec(range)
      if (m && (m[1] || m[2])) {
        let start = m[1] ? parseInt(m[1], 10) : 0
        let end = m[2] ? parseInt(m[2], 10) : size - 1
        if (m[1] === '' && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1 } // suffix range
        if (isNaN(start) || isNaN(end) || start > end || start >= size) {
          return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } })
        }
        end = Math.min(end, size - 1)
        const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end }))
        return new Response(stream, {
          status: 206,
          headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
        })
      }

      const stream = Readable.toWeb(fs.createReadStream(filePath))
      return new Response(stream, { status: 200, headers: { ...base, 'Content-Length': String(size) } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => { globalShortcut.unregisterAll(); stopTerminal() })
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ---- Floating recording bar + global shortcuts -----------------------------

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
  if (mainWindow) { try { mainWindow.setContentProtection(true) } catch { /* ignore */ } mainWindow.hide() }
  createFloating(payload)
  globalShortcut.register('CommandOrControl+Shift+1', () => relayControl('pause'))
  globalShortcut.register('CommandOrControl+Shift+2', () => relayControl('stop'))
})

ipcMain.on('recording-stopped', () => {
  globalShortcut.unregisterAll()
  destroyFloating()
  if (mainWindow) { try { mainWindow.setContentProtection(false) } catch { /* ignore */ } mainWindow.show(); mainWindow.focus() }
})

ipcMain.on('rec-elapsed', (_e, payload) => {
  if (floatWindow) floatWindow.webContents.send('rec-elapsed', payload)
})

// A clip was saved but the user stays in "floating" mode to record more clips:
// keep the main window hidden and just flip the floating bar to its idle UI.
ipcMain.on('float-idle', (_e, payload) => {
  if (floatWindow) floatWindow.webContents.send('float-idle', payload || {})
})

// from the floating bar buttons
ipcMain.on('float-control', (_e, which) => relayControl(which))

// ---- Embedded Claude Code terminal (interactive montage session) -----------
// The "✨ Componer" button opens a REAL interactive `claude` in the project dir
// via a PTY, streamed into an xterm panel. It starts in PLAN MODE with Opus 4.8
// and a seed prompt: Claude proposes the montage plan, the user approves, it
// executes, and the user can keep chatting in the SAME session afterwards.

function stopTerminal() {
  if (ptyProc) { try { ptyProc.kill() } catch { /* gone */ } ptyProc = null }
}

// Fallback when the native PTY isn't available: open the system Terminal running
// claude. Sources avatar-muton/.env so the HeyGen key is present without copying
// the secret into a new file.
function openSystemTerminal(dir, claude, args) {
  try {
    const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
    const line = `cd ${q(dir)} && ${q(claude)} ${args.map(q).join(' ')}`
    const script = '#!/bin/bash\n'
      + 'set -a; [ -f "$HOME/Documents/avatar-muton/.env" ] && . "$HOME/Documents/avatar-muton/.env"; set +a\n'
      + line + '\n'
    const f = path.join(app.getPath('temp'), `rs-terminal-${stamp()}.command`)
    fs.writeFileSync(f, script, { mode: 0o755 })
    shell.openPath(f)
    return true
  } catch (e) { console.error('[terminal] fallback Terminal falló:', e.message); return false }
}

function startTerminal({ dir, resume, opts, cols, rows } = {}) {
  const claude = claudePath()
  if (!claude) return { ok: false, error: 'No encuentro la CLI `claude` (Claude Code) en el PATH.' }
  if (!dir) return { ok: false, error: 'proyecto sin carpeta' }
  ensureProjectClaudeMd(dir, opts)
  stopTerminal()

  const seed = [
    'Eres el editor de este proyecto record-studio; sigue el CLAUDE.md de esta carpeta.',
    'Primero transcribe e inspecciona los clips y ENSÉÑAME EL PLAN de montaje (planos, gráficos,',
    'SFX/música, subtítulos por formato). Cuando lo apruebe, ejecútalo y genera edit/final.mp4',
    '(16:9, con .srt al lado) y edit/final_9x16.mp4 (9:16, subtítulos quemados). Habla en español.',
  ].join(' ')
  // Fresh compose → plan mode + seed. Continue → resume the SAME conversation.
  const args = resume
    ? ['--continue', '--model', 'opus']
    : [seed, '--model', 'opus', '--permission-mode', 'plan']
  const env = { ...process.env, ...heygenEnv(), TERM: 'xterm-256color', FORCE_COLOR: '1' }

  if (!pty) {
    const ok = openSystemTerminal(dir, claude, args)
    return { ok, fallback: 'system-terminal', error: ok ? null : 'no pude abrir Terminal' }
  }
  try {
    ptyProc = pty.spawn(claude, args, {
      name: 'xterm-256color', cols: cols || 100, rows: rows || 30, cwd: dir, env,
    })
  } catch (e) { return { ok: false, error: e.message } }
  ptyProc.onData((d) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal-data', d) })
  ptyProc.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal-exit', exitCode)
    ptyProc = null
  })
  return { ok: true }
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
  try { text = fs.readFileSync(scriptPath, 'utf8') } catch { text = '' }
  if (tpWindow) tpWindow.webContents.send('tp-loaded-window', { path: scriptPath, text })
  if (mainWindow) mainWindow.webContents.send('tp-loaded', { path: scriptPath, text })
})
ipcMain.on('tp-save', (_e, payload) => {
  if (mainWindow) mainWindow.webContents.send('tp-saved', payload)
})

// ---- utils -----------------------------------------------------------------

function ffmpegPath() {
  if (FFMPEG) return FFMPEG
  for (const c of ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    try {
      const r = spawnSync(c, ['-version'], { stdio: 'ignore' })
      if (!r.error && r.status === 0) { FFMPEG = c; return c }
    } catch { /* next */ }
  }
  FFMPEG = 'ffmpeg'
  return FFMPEG
}

function claudePath() {
  if (CLAUDE !== null) return CLAUDE || null
  const home = app.getPath('home')
  for (const c of ['claude', path.join(home, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    try {
      const r = spawnSync(c, ['--version'], { stdio: 'ignore' })
      if (!r.error && r.status === 0) { CLAUDE = c; return c }
    } catch { /* next */ }
  }
  CLAUDE = ''
  return null
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function slugify(name) {
  const s = (name || '')
    .toString()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 48)
  return s || 'proyecto'
}

function uniqueDir(root, slug) {
  let dir = path.join(root, slug)
  let n = 2
  while (fs.existsSync(dir)) { dir = path.join(root, `${slug}-${n}`); n += 1 }
  return dir
}

function readProjectJson(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')) } catch { return null }
}

function writeProjectJson(dir, proj) {
  proj.updated = stamp()
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(proj, null, 2))
}

function frameDataUrl(videoPath, outJpg, ss = 1) {
  try {
    if (!fs.existsSync(videoPath)) return null
    if (!fs.existsSync(outJpg)) {
      const r = spawnSync(ffmpegPath(), ['-y', '-ss', String(ss), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=480:-2', outJpg], { stdio: 'ignore' })
      if (r.status !== 0 || !fs.existsSync(outJpg)) return null
    }
    return `data:image/jpeg;base64,${fs.readFileSync(outJpg).toString('base64')}`
  } catch { return null }
}

function summarizeProject(dir) {
  const proj = readProjectJson(dir)
  if (!proj) return null
  const clips = proj.clips || []
  const durationMs = clips.reduce((a, c) => a + (c.duration_ms || 0), 0)
  const finalPath = path.join(dir, 'edit', 'final.mp4')
  const hasFinal = fs.existsSync(finalPath)
  const final9x16Path = path.join(dir, 'edit', 'final_9x16.mp4')
  const hasFinal9x16 = fs.existsSync(final9x16Path)
  let previewDataUrl = null
  let preview9x16DataUrl = null
  if (hasFinal9x16) {
    preview9x16DataUrl = frameDataUrl(final9x16Path, path.join(dir, 'edit', '_poster_9x16.jpg'), 1)
  }
  if (hasFinal) {
    previewDataUrl = frameDataUrl(finalPath, path.join(dir, 'edit', '_poster.jpg'), 1)
  } else if (hasFinal9x16) {
    previewDataUrl = preview9x16DataUrl
  } else if (clips.length) {
    const c0 = clips[0]
    previewDataUrl = frameDataUrl(path.join(dir, c0.webcam || `clips/${c0.id}/webcam.webm`), path.join(dir, 'clips', c0.id, '_thumb.jpg'), 0.5)
  }
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
    previewDataUrl,
    preview9x16DataUrl,
    composeOpts: proj.compose_opts || null,
  }
}

// ---- Agent brief builders --------------------------------------------------

const DEFAULT_OPTS = { aspect: 'both', subtitles: true, model: 'medium', pip: 'br', tone: '', cropMenubar: false, sfx: true }

// Normalize the aspect knob: anything that isn't an explicit single format means both.
function normAspect(opts) {
  const a = opts && opts.aspect
  return a === '16:9' || a === '9:16' ? a : 'both'
}
// Human list of the requested output file(s), for the prompt goal lines.
function aspectGoal(opts) {
  const a = normAspect(opts)
  if (a === '16:9') return '`edit/final.mp4` (16:9, 1920x1080)'
  if (a === '9:16') return '`edit/final_9x16.mp4` (9:16, 1080x1920)'
  return 'BOTH `edit/final.mp4` (16:9, 1920x1080) AND `edit/final_9x16.mp4` (9:16, 1080x1920)'
}

function optsLines(opts) {
  const o = { ...DEFAULT_OPTS, ...(opts || {}) }
  const aspect = normAspect(o)
  const aspectBlock = {
    'both': [
      '- Deliver BOTH resolutions (like avatar-muton does): `edit/final.mp4` in 1920x1080 (horizontal,',
      '  YouTube) AND `edit/final_9x16.mp4` in 1080x1920 (vertical, Shorts/Reels/TikTok). Same edit,',
      '  two canvases. render.py auto-reframes multicam for vertical: `fullcam` fills the frame, screen',
      '  segments (`fullscreen`/`pip`) get a blurred-fill background instead of black bars with a larger',
      '  cam PiP, and captions ride high above the Shorts/Reels UI — you just set the EDL "output" to',
      '  each size and render twice. Render any HyperFrames graphic at BOTH output sizes so the cut-in',
      '  segment matches each canvas.',
    ].join('\n'),
    '16:9': [
      '- Deliver ONLY `edit/final.mp4` in 1920x1080 (16:9 horizontal, YouTube). The user did NOT ask',
      '  for a vertical version this time — do NOT render `final_9x16.mp4`. Render HyperFrames graphics',
      '  at 1920x1080 only.',
    ].join('\n'),
    '9:16': [
      '- Deliver ONLY `edit/final_9x16.mp4` in 1080x1920 (9:16 vertical, Shorts/Reels/TikTok). The user',
      '  did NOT ask for a horizontal version this time — do NOT render `final.mp4`. render.py',
      '  auto-reframes multicam for vertical: `fullcam` fills the frame, screen segments',
      '  (`fullscreen`/`pip`) get a blurred-fill background, and captions ride high above the',
      '  Shorts/Reels UI. Render HyperFrames graphics at 1080x1920 only.',
    ].join('\n'),
  }[aspect]
  const subs169 = [
    '  * 16:9 `final.mp4` (YouTube): DO NOT burn subtitles into the picture. Render it with',
    '    `helpers/render.py … --subs-mode sidecar` so a `final.srt` is written NEXT TO the mp4 (a file,',
    '    not baked-in text). That is all YouTube needs.',
  ]
  const subs916 = [
    '  * 9:16 `final_9x16.mp4` (Shorts/Reels/TikTok): BURN Hormozi-style captions (big UPPERCASE words,',
    '    the ACTIVE word highlighted in an accent color, animated pop). Place them HIGH (~55-60% down the',
    '    frame) so they sit ABOVE the bottom-center PiP camera, never over the mouth. Build them as a',
    '    TRANSPARENT HyperFrames overlay synced to the Whisper WORD timestamps (start from a `caption-*`',
    '    registry example; scale word times to the real clip duration), render it to a transparent',
    '    WebM/MOV, add it to the EDL `overlays` for the VERTICAL render only, and render that canvas with',
    '    `--subs-mode off` (the captions come from the overlay, so ffmpeg must not also burn an SRT).',
    '    (This machine\'s ffmpeg has no libass, so the `subtitles` filter is unavailable — the HyperFrames',
    '    overlay is how you burn captions here; do NOT rely on `--subs-mode burn`.)',
  ]
  return [
    aspectBlock,
    o.subtitles ? [
      '- SUBTITLES — DIFFERENT PER FORMAT (user preference, important):',
      ...(aspect !== '9:16' ? subs169 : []),
      ...(aspect !== '16:9' ? subs916 : []),
    ].join('\n') : '- SUBTITLES: OFF — render with `--subs-mode off` and add no caption overlay.',
    `- Transcription: run \`helpers/transcribe_whisper.py --model ${o.model}\` on each clip's webcam.webm. Do NOT use ElevenLabs.`,
    `- Default PiP corner: ${o.pip}.`,
    o.cropMenubar ? [
      '- Remove the macOS menu bar from the screen track: set the EDL top-level `screen_crop` to',
      '  {"top": 0.04} as a STARTING point. Then VERIFY and ADJUST: after rendering, extract a frame from a',
      '  `fullscreen` or `pip` moment (`ffmpeg -ss <t> -i edit/final.mp4 -frames:v 1 /tmp/chk.png`) and LOOK',
      '  at the image (read the PNG). The macOS menu bar (the top strip with the clock and app menus) must be',
      '  FULLY gone, WITHOUT cropping real content. If a sliver of the bar still shows, increase',
      '  `screen_crop.top` (try 0.05, 0.06, up to ~0.08 on notch MacBooks) and re-render; if it ate into the',
      '  actual content, decrease it. Iterate until the bar is gone and the content is intact.',
    ].join('\n') : null,
    o.sfx ? [
      '- SOUND from the HeyGen library — FRESH per video, timed to the WORDS (like avatar-muton):',
      '  * The key is already in your ENVIRONMENT: `HEYGEN_API_KEY` (+ optional `HEYGEN_API_BASE`, default',
      '    https://api.heygen.com). Do NOT look for it in a .env; read it from the env. Query the library with',
      '    a SPECIFIC natural-language description and take the top-scoring match:',
      '      `GET $HEYGEN_API_BASE/v3/audio/sounds?type=sound_effects&query=<e.g. "punchy whoosh transition">`',
      '      header `x-api-key: $HEYGEN_API_KEY`. Download the pre-signed WAV into edit/sfx/.',
      '  * PICK NEW, DIFFERENT sounds for THIS video (do not recycle the same handful every time) — search',
      '    fresh queries that fit THIS content. Do NOT generate; these are professionally made.',
      '  * PLACE THEM ON THE WORD: use the Whisper word timestamps to fire each SFX exactly when the trigger',
      '    word is spoken (whoosh ON each shot change/transition, a pop/ding when a graphic element or key word',
      '    lands, a riser INTO a reveal, "cash/coins" when money is said, a chime on a notification). Add an',
      '    `sfx` array to the EDL: each {file, at (output-timeline seconds), gain_db (negative, sits UNDER the',
      '    voice, ~-10..-16)}. A FEW well-placed beats loud and constant.',
      '  * BACKGROUND MUSIC — decide PER VIDEO: if the piece wants energy (promo/story/hook), search',
      '    `type=music` for a fitting track, download to edit/music/, and set the EDL top-level',
      '    `music: {"file": "music/<name>.wav", "volume_db": -22}` (render.py ducks it under your voice',
      '    automatically). For tutorials/demos where music would fight the explanation, use SFX ONLY (no music).',
      '  * In the self-eval, confirm each SFX hits ON its word and adjust `at` if early/late.',
      '  (Only if HeyGen is unreachable, fall back to ElevenLabs `POST /v1/sound-generation` for SFX.)',
    ].join('\n') : null,
    o.tone && o.tone.trim() ? `- Editing direction from the user: ${o.tone.trim()}` : null,
  ].filter(Boolean)
}

function composePrompt(opts) {
  return [
    'You are running NON-INTERACTIVELY (headless). Use the **video-use** skill to edit the',
    'multicam screen-recording project in the current directory into one finished video.',
    '',
    'This is a record-studio project. Clips live in `clips/clip_NN/` and each clip has two',
    'SYNCHRONIZED tracks on one timeline: `screen.webm` (no audio) and `webcam.webm` (carries',
    'the mic — the only audio). `sync.json` has `offset_ms`. Use the skill\'s MULTICAM mode.',
    '',
    'MONTAGE STYLE — smooth & alive, NOT choppy (copy avatar-muton, which the user loves):',
    '  - The user DISLIKES hard "multicam" framing cuts. Favor CONTINUITY: keep the camera in a PiP over',
    '    the screen while demoing (both visible), and reserve full shots for real beats. Use `fullcam` only',
    '    when talking straight to the viewer (hook/CTA), `fullscreen` for a pure screen moment.',
    '  - NEVER let a shot sit static: a slow PUNCH-IN ZOOM is ON by default (render.py) on fullcam,',
    '    fullscreen AND the PiP camera — the camera is always gently moving. You may set a range\'s',
    '    `"zoom":[1.0,1.06]` (or `"pip":{"zoom":[1.0,1.05]}`) to punch harder on an emphasis beat.',
    '  - TRANSITIONS ARE CROSSFADES, not jump cuts: every range may carry `"transition":"fade"` (also',
    '    "dissolve"/"slide") and `"transition_after_sec":0.4`. Use a hard `"transition":"cut"` ONLY at a',
    '    genuine block change. Put a whoosh SFX on the bigger transitions (see SFX).',
    '  - VARY THE CAMERA across the video, and use a DIFFERENT pattern each video: change the PiP',
    '    `"pip":{"corner": …}` among `br/bl/tr/tl/bc/tc/cl/cr` and its `"scale"` (small ~0.24 up to a big',
    '    ~0.5 "side" look) so it is not always the same corner. Do not repeat the previous video\'s plan.',
    '',
    'OPTIONS:',
    ...optsLines(opts),
    '',
    `Do the FULL pipeline and WRITE ${aspectGoal(opts)}:`,
    '  1. transcribe each clip (Whisper) → pack → read the transcript',
    '  2. decide shots editorially and build a multicam EDL per clip',
    '  3. render each clip with `helpers/render.py` and concatenate them in clip order — once per',
    '     REQUESTED canvas (see OPTIONS: output 1920x1080 → final.mp4, output 1080x1920 → final_9x16.mp4)',
    '  4. ADD GRAPHICS with HyperFrames, generously, using the `graphic` LAYOUT (see rules below).',
    '',
    'GRAPHICS — dynamic like a pro edit, but SYNCED TO THE SCRIPT (this is what was wrong before):',
    '  - Use the PREDEFINED HyperFrames examples and pick the GOOD-LOOKING ones — do NOT default to',
    '    `blank`. List them with `hyperframes init --example <name>` (registry has warm-grain, swiss-grid,',
    '    kinetic-type, product-promo, logo-outro, caption-*, lt-* lower-thirds, transitions-*, vfx-*,',
    '    code-snippet-*, app-showcase, …). Choose the example that fits each beat, then fill its text from',
    '    the transcript.',
    '  - PUT THE FIRST GRAPHIC within the first ~5 SECONDS of the video (a hook/title card).',
    '  - A GRAPHIC COVERS ITS WHOLE NARRATION — this is the key fix. Its EDL range [start,end] must span the',
    '    ENTIRE sentence/idea it illustrates (start ~0.4s before the payoff word, end after the sentence',
    '    finishes), NEVER a 1-2s flash. Change graphic when the CONTENT changes (a new point), not on a fixed',
    '    every-few-seconds timer.',
    '  - SYNC THE ANIMATION TO THE VOICE: get the clip\'s Whisper word timestamps; each element inside the',
    '    graphic (bullet, number, chip, badge) should ANIMATE IN exactly when its word is spoken. Scale TTS/',
    '    transcript times to the real clip duration. A count-up/reveal should LAND on the spoken payoff word',
    '    (start it `reveal_duration` earlier). A graphic that ignores the word timing feels disconnected.',
    '  - Insert each graphic as an EDL range with {"layout":"graphic","graphic_file":"animations/slot_N/render.mp4"}.',
    '    render.py shows it FULL-FRAME BUT keeps YOUR VOICE (the webcam mic) playing under it, and now',
    '    CROSSFADES in/out (softer than the old hard cut-in). NEVER a silent/standalone clip — the voice must',
    '    always be heard. Do NOT overlay graphics on top of the live demo.',
    '  - Minimum readable: at least ~3-4s AND at least (its narration +1s); hold the final frame ~1s.',
    '  - Render every HyperFrames graphic at every REQUESTED output size (see OPTIONS) so the segment matches each canvas.',
    '',
    'Subtitles follow the per-format policy in OPTIONS.',
    '',
    'Because this is headless, DO NOT ask for confirmation and DO NOT stop to discuss strategy —',
    `pick sensible defaults and proceed. Keep going until ${aspectGoal(opts)} exists.`,
  ].join('\n')
}

// The montage brief written as the project's CLAUDE.md, so the INTERACTIVE
// terminal session auto-loads it and "knows everything" about how to edit this
// record-studio project. Reuses optsLines() (the same knobs as headless compose).
// The video-use SKILL.md (globally linked) carries the full craft; this file is
// the project-specific orchestration on top of it.
function montageBrief(opts) {
  return [
    '# Montar el vídeo de este proyecto (record-studio)',
    '',
    'Eres el **editor de vídeo** de este proyecto. Usa la skill **video-use** para montar los clips',
    'grabados en el vídeo final. Sigue el CRAFT completo de `video-use/SKILL.md` (continuidad multicam,',
    'zoom, crossfades, cámara variada, gráficos sincronizados a las palabras, SFX/música de HeyGen,',
    'subtítulos por formato) — aquí va SOLO lo específico de este proyecto.',
    '',
    'ESTRUCTURA: los clips están en `clips/clip_NN/` y cada uno tiene dos pistas SINCRONIZADAS en una',
    'misma línea de tiempo: `screen.webm` (sin audio) y `webcam.webm` (lleva el micro — el único audio).',
    '`sync.json` tiene `offset_ms`. Usa el modo MULTICAM de la skill (layouts `fullcam`/`fullscreen`/',
    '`pip`/`graphic` en la EDL, renderizando con `helpers/render.py`).',
    '',
    `OBJETIVO: generar ${aspectGoal(opts)} — mismo montaje, un render por lienzo pedido (cambia el \`output\` de la EDL).`,
    '',
    'OPCIONES DE ESTE PROYECTO:',
    ...optsLines(opts),
    '',
    'ESTILO (resumen — el detalle está en video-use/SKILL.md):',
    '- Montaje SUAVE, no choppy: cámara en PiP sobre la pantalla, **zoom lento siempre**, **crossfades**',
    '  entre planos (corte duro solo en cambios de bloque). Varía la posición/tamaño del PiP.',
    '- Gráficos HyperFrames que **cubren toda su narración** y con elementos animados **a la palabra**',
    '  (word-timestamps de Whisper). Primer gráfico en los ~5s.',
    '- SFX/música **nuevos por vídeo** de la librería de HeyGen, colocados en la palabra exacta.',
    '- Subtítulos: 16:9 → `.srt` al lado (NO quemados); 9:16 → quemados estilo Hormozi (overlay de',
    '  HyperFrames sincronizado a palabras, arriba, sobre la cámara).',
    '',
    'La `HEYGEN_API_KEY` (y `HEYGEN_API_BASE`) están en tu ENTORNO — úsalas para buscar/descargar sonidos.',
    'Todo en ESPAÑOL con el usuario.',
  ].join('\n')
}

// Write/refresh the project CLAUDE.md so the interactive session loads the brief.
function ensureProjectClaudeMd(dir, opts) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), montageBrief(opts) + '\n')
    return true
  } catch (e) { console.error('[terminal] no pude escribir CLAUDE.md:', e.message); return false }
}

function iteratePrompt(feedback, opts) {
  return [
    'You are running NON-INTERACTIVELY (headless). This record-studio project already has an',
    'edit at `edit/final.mp4` (and likely cached transcripts in `edit/transcripts/` and EDLs in',
    '`edit/`). Use the **video-use** skill in ITERATE mode: apply the user\'s feedback and',
    're-render, REUSING cached transcripts (never re-transcribe unless a source changed).',
    '',
    'USER FEEDBACK (apply this): ' + JSON.stringify(feedback || ''),
    '',
    'OPTIONS still apply:',
    ...optsLines(opts),
    '',
    'Keep the SMOOTH montage style: PiP base with a slow punch-in zoom, CROSSFADES between shots (not',
    'hard cuts — the user dislikes framing cuts), varied PiP position/size, graphics that span their whole',
    'narration with elements synced to the spoken words, and fresh HeyGen SFX/music timed to the words.',
    `Re-render ${aspectGoal(opts)}.`,
    'Do NOT ask for confirmation. Keep going until the updated final(s) exist.',
  ].join('\n')
}

// ---- Script-writing prompts (learn the user's voice, write in it) ----------

function analyzePrompt(channel) {
  return [
    'You are running NON-INTERACTIVELY (headless). GOAL: learn the user\'s personal video style',
    'from their YouTube channel so we can later write new scripts in THEIR voice.',
    '',
    `Channel: ${channel}`,
    '',
    'IMPORTANT: use only LONG-FORM videos, NOT Shorts (Shorts are the vertical clips ≤ 60s and live',
    'in the channel\'s /shorts tab). Use the channel\'s VIDEOS tab and skip anything under ~90s.',
    '',
    'Steps:',
    '1. With yt-dlp, list the channel\'s most recent ~15 LONG videos and fetch each TRANSCRIPT (auto-subs',
    '   are fine). Target the videos tab — if the URL is a channel/handle, append "/videos"',
    '   (e.g. https://youtube.com/@handle/videos); never use /shorts. Get the URLs, e.g.:',
    '   `yt-dlp --flat-playlist --playlist-end 30 --print "%(url)s" "<channel>/videos"`',
    '   Then for each, before transcribing, skip it if its duration is under ~90s (drop Shorts that',
    '   slipped through), and fetch the transcript for the rest until you have ~15:',
    '   `yt-dlp --skip-download --write-auto-subs --write-subs --sub-langs "es,en" --convert-subs srt -o "corpus/%(id)s.%(ext)s" "<videoUrl>"`',
    '   Then strip timestamps to plain text under corpus/.',
    '2. Read the transcripts and WRITE `style_profile.md` capturing the user\'s VOICE: tone, recurring',
    '   phrases / catchphrases, vocabulary, sentence rhythm, how they HOOK at the start, how they',
    '   structure a video, how they address the audience, their typical CTAs, pacing/length. Include',
    '   CONCRETE example phrases they actually say (real quotes). This file is the reference for',
    '   writing future scripts, so make it rich and specific.',
    '',
    'Write in the same language as their content (likely Spanish). Skip videos without subtitles.',
    'Do NOT ask questions. Keep going until `style_profile.md` exists with a genuinely useful profile.',
  ].join('\n')
}

function scriptOptsLines(opts) {
  const o = opts || {}
  return [
    o.duration ? `- Target length: about ${o.duration}.` : '- Target length: short-form unless the style suggests otherwise.',
    o.format ? `- Format/platform: ${o.format}.` : null,
    '- Language: match the user\'s channel (Spanish if their videos are in Spanish).',
  ].filter(Boolean)
}

function generatePrompt(topic, opts, draftPath) {
  return [
    'You are running NON-INTERACTIVELY (headless). Write a NEW video script in the USER\'S OWN VOICE.',
    '',
    'CRITICAL — two SEPARATE inputs, never confuse them:',
    '  • `style_profile.md` + `corpus/` define HOW the user talks (tone, phrases, rhythm, hooks,',
    '    structure). Use them ONLY for voice/style. Do NOT borrow the topic or content of past videos.',
    '  • The TOPIC below defines WHAT this video is about. The substance comes from it.',
    '',
    'TOPIC (what the video is about):',
    `"""${topic}"""`,
    '',
    'RESEARCH FIRST (mandatory) — gather real, current facts before writing:',
    '  • If the topic contains any URL, OPEN and READ it (WebFetch tool; for a GitHub repo read its README;',
    '    if WebFetch fails try `curl -sL <url>` or `gh repo view <owner/repo> --json name,description,...`).',
    '  • ALSO use the WebSearch tool to fill gaps and get UP-TO-DATE information: anything you are unsure',
    '    about, recent developments, context, real names/numbers/dates. Trust current web results over your',
    '    own memory (which may be outdated).',
    '  Base the script on what you ACTUALLY find: the real product name, what it really does, its real',
    '  features and how it works. NEVER invent facts and NEVER reuse an unrelated past video as if it were',
    '  this topic. If you truly cannot verify something, leave a short TODO note in the script instead of',
    '  making it up.',
    '',
    'Then read `style_profile.md` (skim 1-2 `corpus/` files only to copy phrasing/rhythm) and write the',
    'script ABOUT the real topic above.',
    '',
    'Constraints:',
    ...scriptOptsLines(opts),
    '',
    'Sound like THEM (their hooks, phrases, rhythm, CTA) but about the REAL subject. Structure it for',
    'video (hook → desarrollo → cierre/CTA), ready to read aloud as a teleprompter.',
    '',
    'OUTPUT FORMAT: PLAIN TEXT ONLY. No Markdown whatsoever — no asterisks (**), no #, no backticks, no',
    'bullet symbols, no bold/italics. If you label sections, put a simple UPPERCASE word on its own line',
    '(e.g. GANCHO, DESARROLLO, CIERRE) with a blank line around it. Just the spoken words, clean.',
    '',
    `Write ONLY the finished script to this EXACT file: ${draftPath}`,
    'Do NOT ask questions and do not write anything else.',
  ].join('\n')
}

function rewritePrompt(scriptPath, feedback, opts) {
  return [
    'You are running NON-INTERACTIVELY (headless). There is an existing script at:',
    `${scriptPath}`,
    '',
    'Rewrite it applying this feedback, while KEEPING the user\'s voice (see `style_profile.md`):',
    `"""${feedback}"""`,
    '',
    'Keep all facts accurate: if the script is about a product/URL, do not invent features — re-check the',
    'source (WebFetch / curl / gh) and use WebSearch for anything new or uncertain if the feedback touches',
    'the substance. Use the corpus only for VOICE.',
    '',
    'Constraints still apply:',
    ...scriptOptsLines(opts),
    '',
    'Keep it PLAIN TEXT (no Markdown, no asterisks, no #, no backticks). Section labels, if any, are a',
    'simple UPPERCASE word on its own line.',
    '',
    `Overwrite the SAME file (${scriptPath}) with the improved script. Do NOT ask questions.`,
  ].join('\n')
}

// ---- Agent job manager (compose + iterate) ---------------------------------

// Structured progress event {kind:'cmd'|'tool'|'text'|'status', label} so the
// renderer can group tool activity and show assistant text as chat bubbles.
function progressFromEvent(ev) {
  if (!ev || typeof ev !== 'object') return null
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'tool_use') {
        const name = block.name || 'tool'
        if (name === 'Bash' && block.input && block.input.command) {
          return { kind: 'cmd', label: String(block.input.command).split('\n')[0].slice(0, 120) }
        }
        return { kind: 'tool', label: name }
      }
      if (block.type === 'text' && block.text && block.text.trim()) {
        return { kind: 'text', label: block.text.trim().replace(/\s+/g, ' ').slice(0, 400) }
      }
    }
  }
  if (ev.type === 'result') return { kind: 'status', label: ev.is_error ? 'error en el agente' : 'agente terminado' }
  return null
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(channel, payload) } catch { /* gone */ }
  }
}

// Flat one-line form of an event, kept for the raw log / old renderers.
function evToMsg(ev) {
  if (ev.kind === 'cmd') return `$ ${ev.label}`
  if (ev.kind === 'tool') return `· ${ev.label}`
  return ev.label
}
function pushEvent(key, ev) {
  const msg = evToMsg(ev)
  const job = agentJobs.get(key)
  if (job) {
    job.log.push(msg); if (job.log.length > 600) job.log.shift()
    job.events = job.events || []
    job.events.push(ev); if (job.events.length > 300) job.events.shift()
  }
  broadcast('agent-progress', { key, msg, ev })
}
function pushLog(key, msg) { pushEvent(key, { kind: 'status', label: msg }) }

// The HeyGen API key/base live in avatar-muton's `.env` (canonical, per CLAUDE.md).
// Inject them into the headless agent's environment so it can pull NEW sound
// effects / music from the HeyGen library per video (REST). Never logged/printed.
// Returns {} if the file or keys are missing (agent then falls back to ElevenLabs).
function heygenEnv() {
  try {
    const envPath = path.join(process.env.HOME || '', 'Documents', 'avatar-muton', '.env')
    const txt = fs.readFileSync(envPath, 'utf8')
    const out = {}
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*(HEYGEN_API_KEY|HEYGEN_API_BASE)\s*=\s*(.*)$/.exec(line)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
    return out
  } catch { return {} }
}

// Run a headless `claude -p` agent. successCheck() returns a result object on
// success, or null on failure. Generic over compose/iterate and scripts.
function runAgentJob(key, cwd, prompt, successCheck, startMsg, extra = {}) {
  const existing = agentJobs.get(key)
  if (existing && existing.status === 'running') return { started: false, already: true }

  const claude = claudePath()
  const job = { status: 'running', log: [], events: [], child: null, error: null, result: null, sessionId: null }
  agentJobs.set(key, job)

  if (!claude) {
    job.status = 'error'
    job.error = 'no encuentro la CLI `claude` (Claude Code) en el PATH.'
    pushLog(key, 'Error: ' + job.error)
    broadcast('agent-done', { key, ok: false, error: job.error })
    return { started: false, error: job.error }
  }

  fs.mkdirSync(cwd, { recursive: true })
  pushLog(key, startMsg || 'Lanzando Claude Code…')

  const args = ['-p', prompt, '--add-dir', cwd, '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose']
  // Resume a previous Claude Code session so it REMEMBERS earlier edits in this
  // project, instead of starting a fresh conversation each time.
  if (extra.resumeId) {
    args.push('--resume', extra.resumeId)
    pushLog(key, '↻ Continuando la conversación anterior…')
  }
  let child
  try {
    child = spawn(claude, args, { cwd, env: { ...process.env, ...heygenEnv() }, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    job.status = 'error'; job.error = err.message
    pushLog(key, 'Error: ' + err.message)
    broadcast('agent-done', { key, ok: false, error: err.message })
    return { started: false, error: err.message }
  }
  job.child = child

  let buf = ''
  let lastErr = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        const ev = JSON.parse(line)
        if (ev && ev.session_id && ev.session_id !== job.sessionId) {
          job.sessionId = ev.session_id
          try { extra.onSession && extra.onSession(ev.session_id) } catch { /* ignore */ }
        }
        const m = progressFromEvent(ev); if (m) pushEvent(key, m)
      } catch { /* non-json */ }
    }
  })
  child.stderr.on('data', (d) => { lastErr += d.toString(); if (lastErr.length > 4000) lastErr = lastErr.slice(-4000) })
  child.on('error', (err) => {
    job.status = 'error'; job.error = err.message
    pushLog(key, 'Error: ' + err.message)
    broadcast('agent-done', { key, ok: false, error: err.message })
  })
  child.on('close', (code) => {
    if (job.status === 'cancelled') {
      pushLog(key, 'Cancelado.')
      broadcast('agent-done', { key, ok: false, error: 'cancelado' })
      return
    }
    let result = null
    try { result = successCheck() } catch { result = null }
    if (result) {
      job.status = 'done'; job.result = result
      pushLog(key, 'Listo ✓')
      broadcast('agent-done', { key, ok: true, result })
    } else {
      job.status = 'error'
      job.error = `el agente terminó (código ${code}) sin el resultado esperado. ${lastErr.slice(-200)}`
      pushLog(key, 'Error: sin resultado esperado')
      broadcast('agent-done', { key, ok: false, error: job.error })
    }
  })
  return { started: true }
}

// ---- IPC: capture sources --------------------------------------------------

ipcMain.handle('list-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: false,
  })
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
      // desktopCapturer gives `display_id` as a string; match it to a display.
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
      // A window: flag our own app so the user doesn't record the recorder.
      detail = new RegExp(appName, 'i').test(s.name) ? 'esta app (record-studio)' : 'ventana'
    }
    return {
      id: s.id,
      name,
      title: s.name, // original OS title, kept for windows
      detail,
      kind: isScreen ? 'screen' : 'window',
      isApp: !isScreen && new RegExp(appName, 'i').test(s.name),
      thumbnail: s.thumbnail.toDataURL(),
    }
  })
})

// ---- IPC: folders ----------------------------------------------------------

ipcMain.handle('choose-dir', async (_e, title) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: title || 'Elegir carpeta',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (res.canceled || !res.filePaths[0]) return null
  return res.filePaths[0]
})

// ---- IPC: projects ---------------------------------------------------------

ipcMain.handle('list-projects', async (_e, root) => {
  if (!root || !fs.existsSync(root)) return []
  const out = []
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const summary = summarizeProject(path.join(root, e.name))
    if (summary) out.push(summary)
  }
  out.sort((a, b) => (b.created || '').localeCompare(a.created || ''))
  return out
})

ipcMain.handle('create-project', async (_e, { root, name }) => {
  fs.mkdirSync(root, { recursive: true })
  const dir = uniqueDir(root, slugify(name))
  fs.mkdirSync(path.join(dir, 'clips'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'edit'), { recursive: true })
  const project = {
    version: 1,
    name: name || path.basename(dir),
    slug: path.basename(dir),
    created: stamp(),
    updated: stamp(),
    audio_source: 'webcam',
    compose_opts: { ...DEFAULT_OPTS },
    clips: [],
  }
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2))
  return summarizeProject(dir)
})

ipcMain.handle('project-detail', async (_e, dir) => {
  const summary = summarizeProject(dir)
  if (!summary) return null
  const proj = readProjectJson(dir)
  const clips = (proj.clips || []).map((c) => {
    const webcamPath = path.join(dir, c.webcam || `clips/${c.id}/webcam.webm`)
    return {
      id: c.id,
      durationMs: c.duration_ms || 0,
      offsetMs: c.offset_ms || 0,
      created: c.created || '',
      webcamPath,
      thumbDataUrl: frameDataUrl(webcamPath, path.join(dir, 'clips', c.id, '_thumb.jpg'), 0.5),
    }
  })
  return { ...summary, clips, teleprompter: proj.teleprompter || '' }
})

ipcMain.handle('set-teleprompter', async (_e, { dir, text }) => {
  const proj = readProjectJson(dir)
  if (!proj) throw new Error('project.json no encontrado')
  proj.teleprompter = text || ''
  writeProjectJson(dir, proj)
  return summarizeProject(dir)
})

ipcMain.handle('append-clip', async (_e, payload) => {
  const { dir, screenBuf, webcamBuf, durationMs, offsetMs, dims } = payload
  const proj = readProjectJson(dir)
  if (!proj) throw new Error('project.json no encontrado en ' + dir)

  const n = (proj.clips || []).length + 1
  const clipId = `clip_${String(n).padStart(2, '0')}`
  const clipDir = path.join(dir, 'clips', clipId)
  fs.mkdirSync(clipDir, { recursive: true })
  fs.writeFileSync(path.join(clipDir, 'screen.webm'), Buffer.from(screenBuf))
  fs.writeFileSync(path.join(clipDir, 'webcam.webm'), Buffer.from(webcamBuf))

  const sync = {
    version: 1, created: stamp(), audio_source: 'webcam',
    duration_ms: Math.round(durationMs), offset_ms: Math.round(offsetMs),
    note: 'offset_ms = webcam_start - screen_start; align by trimming the head of the later source.',
    sources: { screen: { file: 'screen.webm', dims: dims.screen }, webcam: { file: 'webcam.webm', dims: dims.webcam } },
  }
  fs.writeFileSync(path.join(clipDir, 'sync.json'), JSON.stringify(sync, null, 2))

  proj.clips = proj.clips || []
  proj.clips.push({
    id: clipId, created: sync.created, duration_ms: sync.duration_ms, offset_ms: sync.offset_ms,
    screen: `clips/${clipId}/screen.webm`, webcam: `clips/${clipId}/webcam.webm`, dims,
  })
  writeProjectJson(dir, proj)
  return summarizeProject(dir)
})

ipcMain.handle('delete-clip', async (_e, { dir, clipId }) => {
  const proj = readProjectJson(dir)
  if (!proj) throw new Error('project.json no encontrado')
  proj.clips = (proj.clips || []).filter((c) => c.id !== clipId)
  writeProjectJson(dir, proj)
  try { await shell.trashItem(path.join(dir, 'clips', clipId)) } catch { /* maybe gone */ }
  return summarizeProject(dir)
})

ipcMain.handle('reorder-clips', async (_e, { dir, orderedIds }) => {
  const proj = readProjectJson(dir)
  if (!proj) throw new Error('project.json no encontrado')
  const byId = new Map((proj.clips || []).map((c) => [c.id, c]))
  proj.clips = orderedIds.map((id) => byId.get(id)).filter(Boolean)
  writeProjectJson(dir, proj)
  return summarizeProject(dir)
})

ipcMain.handle('rename-project', async (_e, { dir, name }) => {
  const proj = readProjectJson(dir)
  if (!proj) throw new Error('project.json no encontrado')
  proj.name = name || proj.name
  writeProjectJson(dir, proj)
  return summarizeProject(dir)
})

ipcMain.handle('delete-project', async (_e, dir) => {
  try { await shell.trashItem(dir); return { ok: true } } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('set-compose-opts', async (_e, { dir, opts }) => {
  const proj = readProjectJson(dir)
  if (!proj) throw new Error('project.json no encontrado')
  proj.compose_opts = { ...DEFAULT_OPTS, ...(proj.compose_opts || {}), ...(opts || {}) }
  writeProjectJson(dir, proj)
  return proj.compose_opts
})

// ---- IPC: compose / iterate (headless Claude Code + video-use) -------------

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

// Persist the Claude Code session id on the project so a later edit can resume
// the SAME conversation (remembers prior changes).
function saveAgentSession(dir) {
  return (id) => {
    const proj = readProjectJson(dir)
    if (!proj) return
    proj.agentSession = id
    writeProjectJson(dir, proj)
  }
}
function resumeIdFor(dir, resume) {
  if (!resume) return null
  const proj = readProjectJson(dir)
  return (proj && proj.agentSession) || null
}

ipcMain.handle('compose-project', async (_e, { dir, opts, resume }) =>
  runAgentJob(dir, dir, composePrompt(opts), composeSuccess(dir, opts), 'Lanzando Claude Code (video-use)…',
    { resumeId: resumeIdFor(dir, resume), onSession: saveAgentSession(dir) }))
ipcMain.handle('iterate-project', async (_e, { dir, feedback, opts, resume }) =>
  runAgentJob(dir, dir, iteratePrompt(feedback, opts), composeSuccess(dir, opts), 'Aplicando cambios…',
    { resumeId: resumeIdFor(dir, resume), onSession: saveAgentSession(dir) }))

// Does this project already have a saved conversation to continue?
ipcMain.handle('agent-session', async (_e, dir) => {
  const proj = readProjectJson(dir)
  return { hasSession: !!(proj && proj.agentSession) }
})

ipcMain.handle('agent-status', async (_e, key) => {
  const job = agentJobs.get(key)
  if (!job) return null
  return {
    status: job.status,
    log: job.log.slice(-200),
    events: (job.events || []).slice(-200),
    error: job.error || null,
    result: job.result || null,
  }
})

ipcMain.handle('agent-cancel', async (_e, key) => {
  const job = agentJobs.get(key)
  if (job && job.child && job.status === 'running') {
    job.status = 'cancelled'
    try { job.child.kill('SIGTERM') } catch { /* gone */ }
    return { ok: true }
  }
  return { ok: false }
})

// ---- IPC: scripts (style profile + script writing) -------------------------

function scriptsDir(root) { return path.join(root, '_scripts') }

ipcMain.handle('scripts-status', async (_e, root) => {
  if (!root) return { hasProfile: false }
  return { hasProfile: fs.existsSync(path.join(scriptsDir(root), 'style_profile.md')) }
})

ipcMain.handle('analyze-channel', async (_e, { root, channel }) => {
  const sd = scriptsDir(root)
  fs.mkdirSync(path.join(sd, 'corpus'), { recursive: true })
  return runAgentJob('style', sd, analyzePrompt(channel),
    () => (fs.existsSync(path.join(sd, 'style_profile.md')) ? { ok: true } : null),
    'Analizando tu canal con yt-dlp…')
})

ipcMain.handle('generate-script', async (_e, { root, topic, opts }) => {
  const sd = scriptsDir(root)
  fs.mkdirSync(path.join(sd, 'drafts'), { recursive: true })
  const draftPath = path.join(sd, 'drafts', `g_${stamp()}.md`)
  return runAgentJob('script', sd, generatePrompt(topic, opts, draftPath),
    () => (fs.existsSync(draftPath) ? { path: draftPath, text: fs.readFileSync(draftPath, 'utf8') } : null),
    'Redactando guion en tu estilo…')
})

ipcMain.handle('rewrite-script', async (_e, { root, scriptPath, feedback, opts }) => {
  const sd = scriptsDir(root)
  return runAgentJob('script', sd, rewritePrompt(scriptPath, feedback, opts),
    () => (fs.existsSync(scriptPath) ? { path: scriptPath, text: fs.readFileSync(scriptPath, 'utf8') } : null),
    'Reescribiendo el guion…')
})

ipcMain.handle('list-scripts', async (_e, root) => {
  if (!root) return []
  const dd = path.join(scriptsDir(root), 'drafts')
  if (!fs.existsSync(dd)) return []
  const out = []
  for (const f of fs.readdirSync(dd)) {
    if (!f.endsWith('.md')) continue
    const p = path.join(dd, f)
    const st = fs.statSync(p)
    const text = fs.readFileSync(p, 'utf8')
    const title = (text.split('\n').find((l) => l.trim()) || f).replace(/^#+\s*/, '').slice(0, 80)
    out.push({ path: p, title, mtime: st.mtimeMs, preview: text.slice(0, 180) })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
})

ipcMain.handle('read-script', async (_e, p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } })
ipcMain.handle('save-script', async (_e, { path: p, text }) => { fs.writeFileSync(p, text); return { ok: true } })
ipcMain.handle('delete-script', async (_e, p) => { try { await shell.trashItem(p); return { ok: true } } catch { return { ok: false } } })

// ---- IPC: open in Finder / external player ---------------------------------

ipcMain.handle('open-path', async (_e, p) => { if (p) await shell.openPath(p) })
ipcMain.handle('reveal-path', async (_e, p) => { if (p) shell.showItemInFolder(p) })

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
    title: 'Elige una imagen de fondo',
    properties: ['openFile'],
    filters: [{ name: 'Imágenes', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  })
  if (r.canceled || !r.filePaths[0]) return null
  try {
    const p = r.filePaths[0]
    const dataUrl = backgroundDataUrl(p)
    return dataUrl ? { path: p, name: path.basename(p), dataUrl } : null
  } catch { return null }
})

ipcMain.handle('load-background', (_e, p) => {
  try {
    const dataUrl = p ? backgroundDataUrl(p) : null
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
