'use strict'
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs')
function make(available, fail = false) {
  const used = []
  class Native {
    async start(stream) { used.push('native'); if (fail) throw Error('model failed'); return stream }
    async stop() { used.push('stop') }
  }
  class LiveKit extends Native { async start(stream) { used.push('livekit'); return stream } }
  const window = { studio: { matting: { available } }, MatAnyoneCamPipe: Native, LiveKitCamPipe: LiveKit }
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/campipe.js'), 'utf8'), { window })
  return { pipe: new window.CamPipe(), used }
}
test('installed native engine is selected, while unavailable platforms use LiveKit', async () => {
  for (const enabled of [true, false]) {
    const { pipe, used } = make(async () => enabled)
    await pipe.start({}, { blur: true }); assert.equal(used[0], enabled ? 'native' : 'livekit'); await pipe.stop()
  }
})
test('native failure never silently changes the recorded foreground to LiveKit', async () => {
  const { pipe, used } = make(async () => true, true)
  await assert.rejects(pipe.start({}, { blur: true }), /model failed/)
  assert.ok(!used.includes('livekit')); assert.ok(used.includes('stop'))
})
test('closing while checking availability never starts an effect', async () => {
  let resolve; const gate = new Promise(r => { resolve = r })
  const { pipe, used } = make(() => gate)
  const start = pipe.start({}, { blur: true }), stop = pipe.stop(); resolve(true)
  await Promise.all([start, stop]); assert.equal(used.length, 0)
})
