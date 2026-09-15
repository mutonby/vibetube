'use strict'
// Native offline matting, FFmpeg composition and validation; never replaces input.
// Usage: node test/manual/camera-finalization.cjs input.webm output-directory [--opaque]
// --opaque is only for measuring known flash/tone A/V fixtures without segmentation.
const fs = require('node:fs'), path = require('node:path')
const { finalizeCamera } = require('../../electron/camera-finalizer')
const source = process.argv[2], out = process.argv[3]
if (!source || !out) throw Error('input and output directory required')
fs.mkdirSync(out, { recursive: true })
const opaque = process.argv.includes('--opaque')
const options = opaque ? { sessionFactory: () => ({ ready: Promise.resolve(), close() {}, frame: async (width, height) => {
  await new Promise(r => setTimeout(r, 45))
  const scale = Math.min(1, 960 / width, 540 / height)
  return { alpha: new Uint8Array(Math.round(width * scale) * Math.round(height * scale)).fill(255) }
} }) } : {}
const started = performance.now()
finalizeCamera({ source: path.resolve(source), destination: path.join(out, 'final.webm'),
  background: path.resolve(__dirname, '../../src/backgrounds/mi-estudio.jpg'), ...options,
  onProgress: frames => { if (frames % 60 === 0) console.log(`${frames} frames`) },
}).then(result => {
  result.processingSeconds = (performance.now() - started) / 1000
  result.native = !opaque
  fs.writeFileSync(path.join(out, 'stats.json'), JSON.stringify(result, null, 2)); console.log(result)
}).catch(e => { console.error(e); process.exitCode = 1 })
