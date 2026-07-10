'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('studio', {
  // capture + folders
  listSources: () => ipcRenderer.invoke('list-sources'),
  chooseDir: (title) => ipcRenderer.invoke('choose-dir', title),

  // projects
  listProjects: (root) => ipcRenderer.invoke('list-projects', root),
  createProject: (root, name) => ipcRenderer.invoke('create-project', { root, name }),
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

  // compose + iterate (headless claude + video-use). `resume` continues the
  // SAME Claude Code conversation (remembers prior edits) instead of a new one.
  composeProject: (dir, opts, resume) => ipcRenderer.invoke('compose-project', { dir, opts, resume }),
  iterateProject: (dir, feedback, opts, resume) => ipcRenderer.invoke('iterate-project', { dir, feedback, opts, resume }),
  agentSession: (dir) => ipcRenderer.invoke('agent-session', dir),

  // generic headless-agent job events + control (keyed by project dir or 'style'/'script')
  agentStatus: (key) => ipcRenderer.invoke('agent-status', key),
  agentCancel: (key) => ipcRenderer.invoke('agent-cancel', key),
  onAgentProgress: (cb) => ipcRenderer.on('agent-progress', (_e, p) => cb(p)),
  onAgentDone: (cb) => ipcRenderer.on('agent-done', (_e, p) => cb(p)),

  // scripts (style profile + script writing)
  scriptsStatus: (root) => ipcRenderer.invoke('scripts-status', root),
  analyzeChannel: (root, channel) => ipcRenderer.invoke('analyze-channel', { root, channel }),
  generateScript: (root, topic, opts) => ipcRenderer.invoke('generate-script', { root, topic, opts }),
  rewriteScript: (root, scriptPath, feedback, opts) => ipcRenderer.invoke('rewrite-script', { root, scriptPath, feedback, opts }),
  listScripts: (root) => ipcRenderer.invoke('list-scripts', root),
  readScript: (p) => ipcRenderer.invoke('read-script', p),
  saveScript: (p, text) => ipcRenderer.invoke('save-script', { path: p, text }),
  deleteScript: (p) => ipcRenderer.invoke('delete-script', p),

  // recording lifecycle (floating bar + global shortcuts)
  // embedded Claude Code terminal (PTY <-> xterm)
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
  onRemoteControl: (cb) => ipcRenderer.on('remote-control', (_e, which) => cb(which)),

  // virtual background image
  pickBackground: () => ipcRenderer.invoke('pick-background'),
  loadBackground: (p) => ipcRenderer.invoke('load-background', p),
  listPresetBackgrounds: () => ipcRenderer.invoke('list-preset-backgrounds'),

  // misc
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
})
