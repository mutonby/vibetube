'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const u = require('../electron/util')

test('slugify normaliza acentos, espacios y longitud', () => {
  assert.equal(u.slugify('  Mi Vídeo: ¡Guay!  '), 'mi-video-guay')
  assert.equal(u.slugify(''), 'proyecto')
  assert.equal(u.slugify('a'.repeat(100)).length, 48)
})

test('stamp tiene formato YYYYMMDD_HHMMSS', () => {
  assert.match(u.stamp(new Date(2026, 7, 26, 9, 5, 3)), /^20260826_090503$/)
})

test('parseRange cubre a-b, a-, -n, inválidos', () => {
  assert.deepEqual(u.parseRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(u.parseRange('bytes=500-', 1000), { start: 500, end: 999 })
  assert.deepEqual(u.parseRange('bytes=-100', 1000), { start: 900, end: 999 })
  assert.deepEqual(u.parseRange('bytes=0-5000', 1000), { start: 0, end: 999 })
  assert.equal(u.parseRange(null, 1000), null)
  assert.equal(u.parseRange('bytes=-', 1000), null)
  assert.deepEqual(u.parseRange('bytes=1000-', 1000), { invalid: true })
  assert.deepEqual(u.parseRange('bytes=50-10', 1000), { invalid: true })
})

test('isUnder solo acepta rutas dentro de la raíz', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'))
  fs.mkdirSync(path.join(root, 'p'))
  assert.equal(u.isUnder(root, path.join(root, 'p', 'x.webm')), true)
  assert.equal(u.isUnder(root, root), true)
  assert.equal(u.isUnder(root, path.join(root, '..', 'otro')), false)
  assert.equal(u.isUnder(root, '/etc/passwd'), false)
  assert.equal(u.isUnder('', '/x'), false)
})

test('writeJson es atómico (no deja .tmp) y readJson tolera basura', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'))
  const f = path.join(dir, 'a.json')
  u.writeJson(f, { a: 1 })
  assert.deepEqual(u.readJson(f), { a: 1 })
  assert.deepEqual(fs.readdirSync(dir), ['a.json'])
  fs.writeFileSync(f, '{oops')
  assert.equal(u.readJson(f, 'fb'), 'fb')
})

test('wordCount y fmtBytes', () => {
  assert.equal(u.wordCount('Hola, ¿qué tal? Esto es un guion.'), 7)
  assert.equal(u.wordCount(''), 0)
  assert.equal(u.fmtBytes(1536), '2 KB')
  assert.equal(u.fmtBytes(3 * 1024 ** 3), '3.0 GB')
  assert.equal(u.fmtBytes(null), '?')
})
