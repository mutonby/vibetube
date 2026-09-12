'use strict'

// Protocolo `rsmedia://` — sirve media local CON soporte de HTTP Range para que el
// <video> pueda hacer seek. Solo sirve ficheros dentro de las raíces permitidas
// (la carpeta de proyectos y los fondos de la app), nunca cualquier ruta del disco.

const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const { protocol } = require('electron')
const { MIME, parseRange, isUnder } = require('./util')

const allowedRoots = new Set()

function allowRoot(dir) { if (dir) allowedRoots.add(path.resolve(dir)) }
function isAllowed(filePath) {
  for (const r of allowedRoots) if (isUnder(r, filePath)) return true
  return false
}

function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'rsmedia', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ])
}

function handleRequest(request) {
  try {
    const u = new URL(request.url)
    const filePath = decodeURIComponent(u.pathname.replace(/^\//, ''))
    if (!isAllowed(filePath)) return new Response('forbidden', { status: 403 })
    const ext = path.extname(filePath).toLowerCase()
    const type = MIME[ext]
    if (!type) return new Response('unsupported type', { status: 415 })
    const stat = fs.statSync(filePath)
    const size = stat.size
    const rangeHdr = request.headers.get('Range') || request.headers.get('range')
    const base = { 'Accept-Ranges': 'bytes', 'Content-Type': type, 'Cache-Control': 'no-cache' }

    const range = parseRange(rangeHdr, size)
    if (range && range.invalid) {
      return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } })
    }
    if (range) {
      const { start, end } = range
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
}

function install() { protocol.handle('rsmedia', handleRequest) }

module.exports = { registerSchemes, install, allowRoot, isAllowed }
