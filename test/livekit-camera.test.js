'use strict'
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function setup({ init, frame = true, update } = {}) {
  const elements = [], processors = []
  class Stream {
    constructor(tracks = []) { this.tracks = tracks }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video') }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio') }
  }
  const owned = { kind: 'video', stopped: false, stop() { this.stopped = true } }
  const original = { kind: 'video', stopped: false, clone: () => owned, stop() { this.stopped = true } }
  const audio = { kind: 'audio' }, stream = new Stream([original, audio])
  const library = {
    supportsBackgroundProcessors: () => true,
    BackgroundProcessor(options) {
      const p = {
        options, calls: [], processedTrack: { kind: 'video' }, canvas: {}, destroyed: false, released: false,
        transformer: { async destroy() { p.released = true } },
        async init() { await init?.(); if (frame) options.onFrameProcessed({ segmentationTimeMs: 2 }) },
        async updateTransformerOptions(value) { p.calls.push(value); await update?.(value) },
        async destroy() { p.destroyed = true },
      }
      processors.push(p); return p
    },
  }
  const document = {
    baseURI: 'file:///app/src/index.html', body: { appendChild() {} },
    createElement() { const e = { style: {}, async play() {}, pause() {}, remove() { this.removed = true } }; elements.push(e); return e },
  }
  const window = { LiveKitProcessors: library }
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/livekit-campipe.js'), 'utf8'), { window, document, URL, MediaStream: Stream, setTimeout, clearTimeout, console })
  return { pipe: new window.LiveKitCamPipe(), stream, original, owned, audio, processors, elements, library }
}
test('disabled effects pass through without loading a model or owning the input tracks', async () => {
  const s = setup(); assert.equal(await s.pipe.start(s.stream), s.stream)
  await s.pipe.stop(); assert.equal(s.processors.length, 0); assert.equal(s.original.stopped, false)
})
test('LiveKit receives a clone; microphone and original camera survive effect shutdown', async () => {
  const s = setup(), out = await s.pipe.start(s.stream, { blur: true, background: 'image' })
  assert.equal(out.getAudioTracks()[0], s.audio)
  assert.equal(out.getVideoTracks()[0], s.processors[0].processedTrack)
  await s.pipe.stop(); await s.pipe.stop()
  assert.equal(s.owned.stopped, true); assert.equal(s.original.stopped, false)
  assert.equal(s.processors[0].destroyed, true)
  assert.ok(s.elements.every(e => e.removed && e.srcObject === null))
})
test('startup waits for processed output instead of publishing the library warm-up frame', async () => {
  const s = setup({ frame: false }); let published = false
  const pending = s.pipe.start(s.stream, { blur: true }).then(() => { published = true })
  await tick(); assert.equal(published, false)
  s.processors[0].options.onFrameProcessed({ segmentationTimeMs: 2 })
  await pending; assert.equal(published, true); await s.pipe.stop()
})
test('closing during model initialization releases the late processor and owned camera', async () => {
  const gate = deferred(), s = setup({ init: () => gate.promise })
  const start = s.pipe.start(s.stream, { blur: true }); await tick()
  const stop = s.pipe.stop(); gate.resolve(); await Promise.all([start, stop])
  assert.equal(s.processors[0].destroyed, true); assert.equal(s.owned.stopped, true); assert.equal(s.original.stopped, false)
  assert.equal(s.pipe.outputStream, null)
})
test('model startup failure is explicit and releases resources, without falling back to another engine', async () => {
  const s = setup({ init: async () => { throw Error('model unavailable') } })
  await assert.rejects(s.pipe.start(s.stream, { blur: true }), /model unavailable/)
  assert.equal(s.processors[0].released, true); assert.equal(s.owned.stopped, true); assert.equal(s.original.stopped, false)
})
test('background loads are ordered and a failed selection does not poison later updates', async () => {
  const gate = deferred(), seen = []
  const s = setup({ update: async value => { if (value.imagePath === 'slow') await gate.promise; if (value.imagePath === 'bad') throw Error('bad image'); seen.push(value.imagePath) } })
  await s.pipe.start(s.stream, { blur: true })
  const a = s.pipe.setBackground('slow'), b = s.pipe.setBackground('new')
  await tick(); assert.ok(!seen.includes('new')); gate.resolve(); await Promise.all([a, b])
  assert.deepEqual(seen.slice(-2), ['slow', 'new'])
  await assert.rejects(s.pipe.setBackground('bad'), /bad image/)
  await s.pipe.setBackground('good'); assert.equal(seen.at(-1), 'good'); await s.pipe.stop()
})
test('zero intensity disables blur but keeps a selected replacement background enabled', async () => {
  const s = setup(); await s.pipe.start(s.stream, { blur: true, blurAmount: 0 })
  assert.equal(s.processors[0].calls.at(-1).backgroundDisabled, true)
  await s.pipe.setBackground('image')
  assert.equal(s.processors[0].calls.at(-1).backgroundDisabled, false)
  assert.equal(s.processors[0].calls.at(-1).blurRadius, 0)
  await s.pipe.stop()
})
