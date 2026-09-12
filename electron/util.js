'use strict'

// Helpers puros y utilidades de fichero compartidas por los módulos de main.
// Sin dependencias de Electron para que se puedan testear con node:test.

const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')

const MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.m4v': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.srt': 'text/plain',
  '.vtt': 'text/vtt', '.json': 'application/json', '.md': 'text/plain', '.txt': 'text/plain',
}

function stamp(d = new Date()) {
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

// Busca el primer binario que responda a `--version` (o al flag dado).
const BIN_CACHE = new Map()
function findBin(name, candidates, flag = '--version') {
  if (BIN_CACHE.has(name)) return BIN_CACHE.get(name)
  for (const c of candidates) {
    try {
      const r = spawnSync(c, [flag], { stdio: 'ignore' })
      if (!r.error && r.status === 0) { BIN_CACHE.set(name, c); return c }
    } catch { /* siguiente */ }
  }
  BIN_CACHE.set(name, null)
  return null
}

// Escritura atómica: fichero temporal + rename, para no dejar un JSON a medias
// si la app muere en mitad de la escritura.
function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, obj) { writeFileAtomic(file, JSON.stringify(obj, null, 2)) }

// ¿`target` está dentro de `root` (o es `root`)? Resuelve symlinks cuando existen.
function isUnder(root, target) {
  if (!root || !target) return false
  // realpath del ancestro existente más profundo + el resto tal cual, para que
  // una ruta aún no creada bajo un symlink (/var → /private/var) compare bien.
  const real = (p) => {
    let cur = path.resolve(p)
    const rest = []
    while (!fs.existsSync(cur)) {
      const parent = path.dirname(cur)
      if (parent === cur) return path.resolve(p)
      rest.unshift(path.basename(cur)); cur = parent
    }
    try { cur = fs.realpathSync(cur) } catch { /* keep */ }
    return path.join(cur, ...rest)
  }
  const r = real(root)
  const t = real(target)
  const rel = path.relative(r, t)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// Parsea una cabecera HTTP Range ("bytes=a-b", "bytes=a-", "bytes=-n") para un
// fichero de `size` bytes. Devuelve {start,end} o null si no hay rango, y
// {invalid:true} si está fuera de rango (→ 416).
function parseRange(header, size) {
  const m = header && /bytes=(\d*)-(\d*)/.exec(header)
  if (!m || (!m[1] && !m[2])) return null
  let start = m[1] ? parseInt(m[1], 10) : 0
  let end = m[2] ? parseInt(m[2], 10) : size - 1
  if (m[1] === '' && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1 }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return { invalid: true }
  return { start, end: Math.min(end, size - 1) }
}

// Bytes libres en el volumen que contiene `p` (null si no se puede saber).
function freeBytes(p) {
  try {
    const st = fs.statfsSync(p)
    return Number(st.bavail) * Number(st.bsize)
  } catch { return null }
}

function fmtBytes(n) {
  if (n == null) return '?'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1 }
  return `${n.toFixed(i >= 3 ? 1 : 0)} ${u[i]}`
}

// Palabras de un texto (para estimar duración de guiones).
function wordCount(text) {
  return ((text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length
}

module.exports = {
  MIME, stamp, slugify, uniqueDir, findBin, writeFileAtomic, readJson, writeJson,
  isUnder, parseRange, freeBytes, fmtBytes, wordCount,
}
