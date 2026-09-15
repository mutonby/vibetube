'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// Transfer a dedicated camera port out of the isolated preload. Pixel buffers
// then bypass contextBridge's extra copies; no generic IPC is exposed.
window.addEventListener('message', event => {
  if (event.source !== window || event.data?.type !== 'matting-connect' || event.ports.length !== 1) return
  ipcRenderer.postMessage('matting-connect', { id: event.data.id }, [event.ports[0]])
})

contextBridge.exposeInMainWorld('studio', {
  matting: {
    available: () => ipcRenderer.invoke('matting-available'),
    selectionAvailable: () => ipcRenderer.invoke('matting-selection-available'),
    start: points => ipcRenderer.invoke('matting-start', points),
    frame: payload => ipcRenderer.invoke('matting-frame', payload),
    stop: id => ipcRenderer.invoke('matting-stop', id),
  },
  // capture + folders
  listSources: () => ipcRenderer.invoke('list-sources'),
  chooseDir: (title) => ipcRenderer.invoke('choose-dir', title),

  // projects
  listProjects: (root) => ipcRenderer.invoke('list-projects', root),
  createProject: (root, name, script) => ipcRenderer.invoke('create-project', { root, name, script }),
  diskFree: (p) => ipcRenderer.invoke('disk-free', p),

  // grabación por chunks (a disco según llegan) + recuperación de tomas a medias
  clipBegin: (dir) => ipcRenderer.invoke('clip-begin', { dir }),
  clipChunk: (clipDir, track, data) => ipcRenderer.invoke('clip-chunk', { clipDir, track, data }),
  retryCameraFinalization: (payload) => ipcRenderer.invoke('camera-finalize-retry', payload),
  onCameraFinalized: (cb) => ipcRenderer.on('camera-finalized', (_e, payload) => cb(payload)),
  clipCameraSeed: (payload) => ipcRenderer.invoke('clip-camera-seed', payload),
  clipFinish: (payload) => ipcRenderer.invoke('clip-finish', payload),
  clipAbort: (clipDir) => ipcRenderer.invoke('clip-abort', { clipDir }),
  clipRecover: (dir, clipId) => ipcRenderer.invoke('clip-recover', { dir, clipId }),
  clipDiscardPart: (dir, clipId) => ipcRenderer.invoke('clip-discard-part', { dir, clipId }),
  clipEnhance: (dir, clipId, force) => ipcRenderer.invoke('clip-enhance', { dir, clipId, force }),
  projectEnhanceClips: (dir, force) => ipcRenderer.invoke('project-enhance-clips', { dir, force }),
  onClipValidated: (cb) => ipcRenderer.on('clip-validated', (_e, p) => cb(p)),
  onClipEnhancing: (cb) => ipcRenderer.on('clip-enhancing', (_e, p) => cb(p)),
  onClipEnhanced: (cb) => ipcRenderer.on('clip-enhanced', (_e, p) => cb(p)),
  onProjectClipsEnhanced: (cb) => ipcRenderer.on('project-clips-enhanced', (_e, p) => cb(p)),
  projectDetail: (dir) => ipcRenderer.invoke('project-detail', dir),
  appendClip: (payload) => ipcRenderer.invoke('append-clip', payload),
  deleteClip: (dir, clipId) => ipcRenderer.invoke('delete-clip', { dir, clipId }),
  reorderClips: (dir, orderedIds) => ipcRenderer.invoke('reorder-clips', { dir, orderedIds }),
  renameProject: (dir, name) => ipcRenderer.invoke('rename-project', { dir, name }),
  setTeleprompter: (dir, text) => ipcRenderer.invoke('set-teleprompter', { dir, text }),
  showTeleprompter: (payload) => ipcRenderer.send('show-teleprompter', payload),
  hideTeleprompter: () => ipcRenderer.send('hide-teleprompter'),
  onTpClosed: (cb) => ipcRenderer.on('tp-closed', () => cb()),
  onTpSaved: (cb) => ipcRenderer.on('tp-saved', (_e, payload) => cb(payload)),
  onTpLoaded: (cb) => ipcRenderer.on('tp-loaded', (_e, payload) => cb(payload)),
  deleteProject: (dir) => ipcRenderer.invoke('delete-project', dir),
  setComposeOpts: (dir, opts) => ipcRenderer.invoke('set-compose-opts', { dir, opts }),

  // compose + iterate (headless agent + video-use). `resume` continues the
  // SAME provider conversation (remembers prior edits) instead of a new one.
  composeProject: (dir, opts, resume) => ipcRenderer.invoke('compose-project', { dir, opts, resume }),
  iterateProject: (dir, feedback, opts, resume) => ipcRenderer.invoke('iterate-project', { dir, feedback, opts, resume }),
  agentSession: (dir) => ipcRenderer.invoke('agent-session', dir),

  // generic headless-agent job events + control (keyed by project dir or 'style'/'script')
  agentStatus: (key) => ipcRenderer.invoke('agent-status', key),
  agentCancel: (key) => ipcRenderer.invoke('agent-cancel', key),
  agentLog: (key) => ipcRenderer.invoke('agent-log', key),
  onAgentProgress: (cb) => ipcRenderer.on('agent-progress', (_e, p) => cb(p)),
  onAgentDone: (cb) => ipcRenderer.on('agent-done', (_e, p) => cb(p)),

  // scripts (style profile + script writing)
  scriptsStatus: (root) => ipcRenderer.invoke('scripts-status', root),
  analyzeChannel: (root, channel, incremental) => ipcRenderer.invoke('analyze-channel', { root, channel, incremental }),
  hooksScript: (root, scriptPath) => ipcRenderer.invoke('hooks-script', { root, scriptPath }),
  scriptVersions: (p) => ipcRenderer.invoke('script-versions', p),
  scriptFeedback: (root, scriptPath, finalText) => ipcRenderer.invoke('script-feedback', { root, scriptPath, finalText }),
  generateScript: (root, topic, opts) => ipcRenderer.invoke('generate-script', { root, topic, opts }),
  rewriteScript: (root, scriptPath, feedback, opts) => ipcRenderer.invoke('rewrite-script', { root, scriptPath, feedback, opts }),
  listScripts: (root) => ipcRenderer.invoke('list-scripts', root),
  readScript: (p) => ipcRenderer.invoke('read-script', p),
  saveScript: (p, text) => ipcRenderer.invoke('save-script', { path: p, text }),
  deleteScript: (p) => ipcRenderer.invoke('delete-script', p),

  // recording lifecycle (floating bar + global shortcuts)
  // embedded agent terminal (PTY <-> xterm)
  terminal: {
    start: (payload) => ipcRenderer.invoke('terminal-start', payload),
    onData: (cb) => ipcRenderer.on('terminal-data', (_e, d) => cb(d)),
    onExit: (cb) => ipcRenderer.on('terminal-exit', (_e, code) => cb(code)),
    sendInput: (data) => ipcRenderer.send('terminal-input', data),
    resize: (cols, rows) => ipcRenderer.send('terminal-resize', { cols, rows }),
    kill: () => ipcRenderer.send('terminal-kill'),
  },

  recordingStarted: (payload) => ipcRenderer.send('recording-started', payload),
  recordingStopped: () => ipcRenderer.send('recording-stopped'),
  floatIdle: (payload) => ipcRenderer.send('float-idle', payload), // clip saved, stay floating
  sendElapsed: (payload) => ipcRenderer.send('rec-elapsed', payload),
  floatWarn: (msg) => ipcRenderer.send('float-warn', msg),
  onPreviewRequest: cb => ipcRenderer.on('float-preview-request', () => cb()),
  sendPreview: bytes => ipcRenderer.send('float-preview-frame', bytes),
  onRemoteControl: (cb) => ipcRenderer.on('remote-control', (_e, which) => cb(which)),

  // virtual background image
  pickBackground: () => ipcRenderer.invoke('pick-background'),
  loadBackground: (p) => ipcRenderer.invoke('load-background', p),
  listPresetBackgrounds: () => ipcRenderer.invoke('list-preset-backgrounds'),

  // ajustes persistentes (userData/settings.json)
  settingsGet: () => ipcRenderer.invoke('settings-get'),
  settingsSet: (obj) => ipcRenderer.invoke('settings-set', obj),

  // misc
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  exportFile: (p) => ipcRenderer.invoke('export-file', p),
})
