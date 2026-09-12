'use strict'
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs')
const source = fs.readFileSync(require.resolve('../src/recording.js'), 'utf8')
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
test('countdown keeps the project selected before navigating elsewhere', async () => {
  const state = { current: '/a', currentName: 'A' }
  let target
  const ctx = vm.createContext({ state, el: () => ({}), setStatus() {}, updateReady() {},
    window: { studio: { diskFree: async () => null } },
    runCountdown: async () => { state.current = '/b'; state.currentName = 'B' }, playStartBeep: async () => {},
    startRecording: async () => { target = state.recordingSession.dir; state.recording = true } })
  vm.runInContext(extract('async function beginRecording(', 'function enqueueChunk('), ctx)
  await ctx.beginRecording()
  assert.equal(target, '/a'); assert.equal(state.current, '/b'); assert.equal(state.recordingBusy, false)
})
test('navigation preserves camera between clips until the floating session ends', () => {
  let stops = 0
  const state = { recording: false, recordingSession: { dir: '/a' }, rawCam: {}, camStream: {}, pipe: { stop: () => { stops++ } } }
  const ctx = vm.createContext({ state, stopStream: () => { stops++ }, stopMeter() {}, disableSystemAudio() {}, el: () => ({}) })
  vm.runInContext(extract('function stopCam(', 'function actualDims('), ctx)
  ctx.stopCam(); assert.equal(stops, 0); assert.ok(state.camStream)
  state.recordingSession = null; ctx.stopCam(); assert.equal(stops, 3); assert.equal(state.camStream, null)
})
test('streamed and memory clips save to the recorder project without replacing the viewed project', async () => {
  for (const fallback of [false, true]) {
    let payload
    const detail = { dir: '/b', name: 'B', clips: [] }, summary = { dir: '/a', clipCount: 2 }
    const state = { current: '/b', detail, projects: [], starts: { screen: 0, webcam: 0 }, dims: {}, chunks: { screen: [new Blob(['screen'])], webcam: [new Blob(['camera'])] } }
    const rec = { projectDir: '/a', projectName: 'A', clip: fallback ? null : { clipDir: '/a/clips/clip_02' }, cam: { background: 'original.jpg' }, errors: [] }
    const studio = { clipFinish: async data => { payload = data; return summary }, appendClip: async data => { payload = data; return summary } }
    const ctx = vm.createContext({ state, rec, Blob, window: { studio }, el: () => ({}), actualDims: () => ({}), drainChunks: async () => {},
      updateClipsCta() { throw Error('Must not replace project B UI') }, renderRecClips() { throw Error('Must not replace project B UI') }, log() {}, toast() {} })
    vm.runInContext(extract('async function saveClip(', '// Discard the current take'), ctx)
    await ctx.saveClip(1000)
    assert.equal(fallback ? payload.dir : payload.clipDir, fallback ? '/a' : '/a/clips/clip_02')
    assert.equal(payload.cam.background, 'original.jpg'); assert.equal(state.detail, detail); assert.equal(rec.savedSummary, summary)
  }
})
