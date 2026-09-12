'use strict'
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs')
const source = fs.readFileSync(require.resolve('../src/recording.js'), 'utf8')
const save = source.slice(source.indexOf('async function saveClip('), source.indexOf('// Discard the current take'))
test('saved screen offset accounts for the processed camera and delayed audio', async () => {
  for (const delay of [0, 80]) {
    let payload
    const summary = { dir: '/project', clipCount: 1 }
    const state = { starts: { webcam: 110, screen: 100 }, dims: {}, projects: [], chunks: {} }
    const rec = { clip: { clipDir: '/project/clips/clip_01' }, audioDelayMs: delay, errors: [] }
    const ctx = vm.createContext({ state, rec, window: { studio: { clipFinish: async data => { payload = data; return summary } } },
      el: () => ({}), actualDims: () => ({}), camMeta: () => ({}), drainChunks: async () => {},
      updateClipsCta() {}, renderRecClips() {}, log() {}, toast() {} })
    vm.runInContext(save, ctx); await ctx.saveClip(1000)
    assert.equal(payload.offsetMs, 10 - delay)
    assert.equal(payload.durationMs, 1000)
  }
})
