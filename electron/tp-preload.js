'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tp', {
  onInit: (cb) => ipcRenderer.on('tp-init', (_e, payload) => cb(payload)),
  onText: (cb) => ipcRenderer.on('tp-text', (_e, text) => cb(text)),
  onLoaded: (cb) => ipcRenderer.on('tp-loaded-window', (_e, payload) => cb(payload)),
  load: (path) => ipcRenderer.send('tp-load', path),
  save: (payload) => ipcRenderer.send('tp-save', payload),
  close: () => ipcRenderer.send('tp-close'),
})
