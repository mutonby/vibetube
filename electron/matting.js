'use strict'
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs'), path = require('node:path')
const executable = path.join(__dirname, '../native/bin/RecordMatte')
const available = () => process.platform === 'darwin' && process.arch === 'arm64' && fs.existsSync(executable)
const selectionAvailable = () => available() && ['encoder', 'decoder'].every(part => fs.existsSync(path.join(path.dirname(executable), `edge_sam_${part}.mlmodelc`)))
function selectionArgs(points) {
  if (points == null) return []
  if (!Array.isArray(points) || points.length !== 4 || points.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) throw Error('Selección de cámara inválida')
  return points.map(String)
}

class MattingSession {
  constructor(command = executable, spawnProcess = spawn, points = null) {
    this.bytes = Buffer.alloc(0); this.stderr = ''; this.closed = false
    this.child = spawnProcess(command, selectionArgs(points), { stdio: ['pipe', 'pipe', 'pipe'] })
    this.ready = this.waitForReply(60000)
    this.child.stdout.on('data', bytes => this.receive(bytes))
    this.child.stderr.on('data', bytes => { this.stderr = (this.stderr + bytes).slice(-2000) })
    this.child.on('error', error => this.close(error))
    this.child.stdin.on('error', error => this.close(error))
    this.child.on('exit', code => this.close(Error(`MatAnyone2 se cerró (${code}): ${this.stderr}`)))
  }
  waitForReply(timeout) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
      this.timer = setTimeout(() => this.close(Error('MatAnyone2 no responde')), timeout)
    })
  }
  receive(bytes) {
    if (this.closed) return
    this.bytes = Buffer.concat([this.bytes, bytes])
    while (this.bytes.length >= 16) {
      const kind = this.bytes.readUInt32LE(0), width = this.bytes.readUInt32LE(4), height = this.bytes.readUInt32LE(8)
      if (kind > 3 || width !== 288 || height !== 512 || !this.pending) {
        this.close(Error('Respuesta de MatAnyone2 inválida')); return
      }
      const length = kind ? width * height : 0
      if (this.bytes.length < 16 + length) return
      const reply = { width, height, seeded: kind === 1 || kind === 3, selectionLost: kind === 3, milliseconds: this.bytes.readUInt32LE(12) / 1000, alpha: new Uint8Array(this.bytes.subarray(16, 16 + length)) }
      this.bytes = this.bytes.subarray(16 + length)
      clearTimeout(this.timer)
      const pending = this.pending; this.pending = null; pending.resolve(reply)
    }
  }
  frame(width, height, rgba) {
    if (this.closed) return Promise.reject(Error('La sesión de cámara está cerrada'))
    if (this.pending) return Promise.reject(Error('Ya hay un fotograma en proceso'))
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1920 || height > 1080 ||
        !(rgba instanceof Uint8Array) || rgba.byteLength !== width * height * 4) return Promise.reject(Error('Fotograma de cámara inválido'))
    const pending = this.waitForReply(15000)
    const header = Buffer.alloc(8); header.writeUInt32LE(width); header.writeUInt32LE(height, 4)
    this.child.stdin.write(header)
    this.child.stdin.write(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength))
    return pending
  }
  close(error = Error('Cámara cerrada')) {
    if (this.closed) return
    this.intentionalClose = arguments.length === 0
    this.closed = true; clearTimeout(this.timer)
    this.pending?.reject(error); this.pending = null
    this.child.stdin.destroy(); this.child.kill()
  }
}

function install(ipcMain, app) {
  const sessions = new Map()
  const owned = (event, id) => {
    const entry = sessions.get(id)
    if (!entry || entry.owner !== event.sender) throw Error('Sesión de cámara inválida')
    return entry.session
  }
  ipcMain.handle('matting-available', () => available())
  ipcMain.handle('matting-selection-available', () => selectionAvailable())
  ipcMain.handle('matting-start', async (event, points = null) => {
    if (!available()) throw Error('MatAnyone2 no está instalado. Ejecuta npm run build:matting')
    selectionArgs(points)
    if (points != null && !selectionAvailable()) throw Error('La calibración guiada no está instalada')
    const owner = event.sender, id = randomUUID(), session = new MattingSession(executable, spawn, points)
    const dispose = () => {
      sessions.get(id)?.port?.close()
      session.close(); sessions.delete(id)
      owner.removeListener('destroyed', dispose); owner.removeListener('render-process-gone', dispose)
    }
    sessions.set(id, { owner, session, dispose })
    owner.once('destroyed', dispose); owner.once('render-process-gone', dispose)
    try { await session.ready; return id } catch (error) { dispose(); throw error }
  })
  ipcMain.handle('matting-frame', async (event, { id, width, height, rgba }) => {
    const session = owned(event, id)
    try { return await session.frame(width, height, rgba) }
    catch (error) { if (session.intentionalClose) return null; throw error }
  })
  ipcMain.on('matting-connect', (event, { id }) => {
    const port = event.ports[0]
    if (!port) return
    let session
    try { session = owned(event, id) }
    catch (error) { port.postMessage({ error: error.message }); port.close(); return }
    const entry = sessions.get(id)
    entry.port?.close(); entry.port = port
    port.on('message', async ({ data }) => {
      try {
        const reply = await session.frame(data?.width, data?.height, data?.rgba)
        port.postMessage(reply)
      } catch (error) { port.postMessage({ error: error.message }) }
    })
    port.start()
  })
  ipcMain.handle('matting-stop', (event, id) => { if (sessions.has(id)) { owned(event, id); sessions.get(id).dispose() } })
  app.on('will-quit', () => { for (const { dispose } of [...sessions.values()]) dispose() })
}
module.exports = { install, available, MattingSession, selectionArgs }
