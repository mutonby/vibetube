'use strict'

// Ajustes persistentes de la app en `userData/settings.json` (sobreviven a
// limpiar la caché del renderer, a diferencia de localStorage). El renderer los
// lee/escribe por IPC (`settings-get` / `settings-set`) y mantiene una copia en
// memoria; localStorage queda solo como caché de arranque.

const path = require('path')
const fs = require('fs')
const { app, ipcMain } = require('electron')
const { readJson, writeJson } = require('./util')

let cache = null
function file() { return path.join(app.getPath('userData'), 'settings.json') }

function load() {
  if (cache) return cache
  cache = readJson(file(), {}) || {}
  return cache
}
function get(key, fallback) {
  const s = load()
  return key in s ? s[key] : fallback
}
function set(key, value) {
  const s = load()
  if (value === undefined || value === null) delete s[key]
  else s[key] = value
  try { fs.mkdirSync(path.dirname(file()), { recursive: true }); writeJson(file(), s) } catch (e) { console.error('[settings] no pude guardar:', e.message) }
  return s
}
function setMany(obj) {
  for (const [k, v] of Object.entries(obj || {})) set(k, v)
  return load()
}

// Lista de carpetas raíz recientes (la actual primero, máx. 8).
function touchRecentRoot(dir) {
  if (!dir) return
  const list = (get('recentRoots', []) || []).filter((d) => d !== dir)
  list.unshift(dir)
  set('recentRoots', list.slice(0, 8))
  set('root', dir)
}

function installIpc() {
  ipcMain.handle('settings-get', () => load())
  ipcMain.handle('settings-set', (_e, obj) => setMany(obj))
}

module.exports = { load, get, set, setMany, touchRecentRoot, installIpc }
