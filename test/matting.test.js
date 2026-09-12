'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream')
const { MattingSession, install, selectionArgs } = require('../electron/matting')
function fixture() {
  const child = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.kill = () => { child.killed = true }
  return { child, session: new MattingSession('test', () => child) }
}
function reply(kind = 0) {
  const bytes = Buffer.alloc(16 + (kind ? 288 * 512 : 0))
  bytes.writeUInt32LE(kind); bytes.writeUInt32LE(288, 4); bytes.writeUInt32LE(512, 8); bytes.writeUInt32LE(42000, 12)
  if (kind) bytes.fill(255, 16)
  return bytes
}
test('guided selection accepts exactly two finite normalized points', () => {
  assert.deepEqual(selectionArgs(null), [])
  assert.deepEqual(selectionArgs([0, 1, .25, .5]), ['0', '1', '0.25', '0.5'])
  for (const points of [[], [0, 1], [0, 1, 0, NaN], [0, 1, 0, Infinity], [0, 1, -1, 0], [0, 1, 0, 2], ['0', 1, 0, 1], {}]) {
    assert.throws(() => selectionArgs(points), /inválida/)
  }
})
test('native protocol reassembles split masks and keeps input frame boundaries', async () => {
  const { child, session } = fixture()
  child.stdout.write(reply()); await session.ready
  const sent = []; child.stdin.on('data', b => sent.push(b))
  const result = session.frame(2, 1, new Uint8Array(8)), bytes = reply(1)
  child.stdout.write(bytes.subarray(0, 7)); child.stdout.write(bytes.subarray(7, 100))
  assert.ok(session.pending); child.stdout.write(bytes.subarray(100))
  const mask = await result
  assert.equal(mask.alpha.length, 288 * 512); assert.equal(mask.alpha[100], 255); assert.equal(mask.milliseconds, 42)
  assert.equal(Buffer.concat(sent).length, 16); assert.equal(sent[0].readUInt32LE(), 2)
  session.close()
})
test('invalid inputs and overlapping inference never enter the native process', async () => {
  const { child, session } = fixture(); child.stdout.write(reply()); await session.ready
  await assert.rejects(session.frame(2, 2, new Uint8Array(3)), /inválido/)
  await assert.rejects(session.frame(2000, 1, new Uint8Array(8000)), /inválido/)
  const pending = session.frame(1, 1, new Uint8Array(4))
  await assert.rejects(session.frame(1, 1, new Uint8Array(4)), /en proceso/)
  const rejected = assert.rejects(pending, /cerrada/); session.close(); await rejected
  assert.ok(child.killed)
})
test('reentry reports when the explicit chair selection needs renewing', async () => {
  const { child, session } = fixture(); child.stdout.write(reply()); await session.ready
  const pending = session.frame(1, 1, new Uint8Array(4)); child.stdout.write(reply(3))
  const result = await pending
  assert.equal(result.seeded, true); assert.equal(result.selectionLost, true)
  assert.equal(result.alpha.length, 288 * 512); session.close()
})
test('closing during initialization settles startup instead of leaving a child process', async () => {
  const { child, session } = fixture()
  const rejected = assert.rejects(session.ready, /cerrada/)
  session.close(); session.close(); await rejected; assert.ok(child.killed)
})
test('native crash rejects the pending frame with an explicit error', async () => {
  const { child, session } = fixture(); child.stdout.write(reply()); await session.ready
  const pending = session.frame(1, 1, new Uint8Array(4))
  const rejected = assert.rejects(pending, /se cerró/)
  child.emit('exit', 1); await rejected; assert.ok(session.closed)
})
test('malformed model dimensions reject initialization and terminate the process', async () => {
  const { child, session } = fixture(), bytes = reply(); bytes.writeUInt32LE(99999, 4)
  const rejected = assert.rejects(session.ready, /inválida/)
  child.stdout.write(bytes); await rejected; assert.ok(child.killed)
})
test('IPC rejects unowned session identifiers', async () => {
  const handlers = {}, app = new EventEmitter()
  install({ handle: (name, fn) => { handlers[name] = fn }, on: (name, fn) => { handlers[name] = fn } }, app)
  await assert.rejects(handlers['matting-frame']({ sender: {} }, { id: 'unknown', width: 1, height: 1, rgba: new Uint8Array(4) }), /inválida/)
  let error, closed = false
  handlers['matting-connect']({ sender: {}, ports: [{ postMessage: value => { error = value.error }, close: () => { closed = true } }] }, { id: 'unknown' })
  assert.match(error, /inválida/); assert.equal(closed, true)
  app.emit('will-quit')
})
