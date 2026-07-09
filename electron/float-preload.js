'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('floatbar', {
  control: (which) => ipcRenderer.send('float-control', which),
  onElapsed: (cb) => ipcRenderer.on('rec-elapsed', (_e, p) => cb(p)),
  onInit: (cb) => ipcRenderer.on('float-init', (_e, p) => cb(p)),
  onIdle: (cb) => ipcRenderer.on('float-idle', (_e, p) => cb(p)),
})
