'use strict'
// Stub mínimo de `electron` para poder cargar los módulos de main bajo node:test.
const Module = require('module')
const os = require('os')
const path = require('path')
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: (k) => (k === 'home' ? os.homedir() : path.join(os.tmpdir(), 'record-studio-test')), getName: () => 'record-studio' },
      BrowserWindow: { getAllWindows: () => [] },
      ipcMain: { handle() {}, on() {} },
      protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    }
  }
  return origLoad.call(this, request, ...rest)
}
