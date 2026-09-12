'use strict'
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs')
const source = fs.readFileSync(require.resolve('../src/recording.js'), 'utf8')
const controller = source.slice(source.indexOf('async function recalibrateBackground('), source.indexOf('// Live blur-intensity slider'))
function fixture() {
  let resolve, reject, previousStops = 0, nextStops = 0
  const starting = new Promise((a, b) => { resolve = a; reject = b })
  const oldStream = { active: true }, raw = { active: true }, output = { active: true }
  const previous = { stop: async () => { previousStops++ } }, next = { start: () => starting, stop: async () => { nextStops++ } }
  const state = { blur: true, rawCam: raw, camStream: oldStream, pipe: previous, blurLevel: 0 }
  const elements = { camPreview: { srcObject: oldStream }, recalibrateHelp: {} }
  const ctx = vm.createContext({ state, CamPipe: function () { return next }, el: id => elements[id], updateReady() {}, toast() {}, log() {} })
  vm.runInContext(controller, ctx)
  return { state, previous, next, output, oldStream, elements, run: () => ctx.recalibrateBackground(), resolve, reject,
    get previousStops() { return previousStops }, get nextStops() { return nextStops } }
}
test('calibration keeps the old picture until the replacement is ready', async () => {
  const f = fixture(), pending = f.run()
  assert.equal(f.state.camStream, f.oldStream); assert.equal(f.elements.camPreview.srcObject, f.oldStream)
  assert.equal(f.previousStops, 0); assert.equal(f.state.recalibrating, true)
  f.resolve(f.output); await pending
  assert.equal(f.state.camStream, f.output); assert.equal(f.elements.camPreview.srcObject, f.output)
  assert.equal(f.state.pipe, f.next); assert.equal(f.previousStops, 1); assert.equal(f.state.recalibrating, false)
})
test('a calibration failure leaves the working camera alive', async () => {
  const f = fixture(), pending = f.run()
  f.reject(Error('model failed')); await pending
  assert.equal(f.state.camStream, f.oldStream); assert.equal(f.state.pipe, f.previous)
  assert.equal(f.previousStops, 0); assert.equal(f.nextStops, 1); assert.equal(f.state.recalibrating, false)
})
test('a result from a replaced camera is discarded', async () => {
  const f = fixture(), pending = f.run()
  f.state.rawCam = { active: true }; const other = { active: true }; f.state.camStream = other
  f.resolve(f.output); await pending
  assert.equal(f.state.camStream, other); assert.equal(f.nextStops, 1); assert.equal(f.previousStops, 0)
})
test('recording blocks recalibration', async () => {
  const f = fixture(); f.state.recording = true; await f.run()
  assert.equal(f.state.camStream, f.oldStream); assert.equal(f.previousStops, 0); assert.equal(f.nextStops, 0)
})
