'use strict'
// Native recovery regression. Inputs are full-resolution RGBA stills of a
// person before/after an appearance change. The intervening absence is synthetic.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { MattingSession } = require('../../electron/matting')
const [beforePath, returnedPath, output] = process.argv.slice(2)
if (!output) throw Error('Usage: node test/manual/matting-reentry.cjs before.rgba returned.rgba output-directory (1280x720 RGBA)')
const width = 1280, height = 720, before = fs.readFileSync(beforePath), returned = fs.readFileSync(returnedPath)
const empty = Buffer.alloc(width * height * 4, 120)
for (let i = 3; i < empty.length; i += 4) empty[i] = 255
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function hold(session, pixels, milliseconds) {
  const until = performance.now() + milliseconds
  let result
  do { result = await session.frame(width, height, pixels); await sleep(100) } while (performance.now() < until)
  return result
}
async function main() {
  fs.mkdirSync(output, { recursive: true })
  const session = new MattingSession()
  let alpha, diagnostics
  try {
    await session.ready
    await hold(session, before, 2500)
    await hold(session, empty, 2500)
    alpha = (await hold(session, returned, 3500)).alpha
    diagnostics = session.stderr
    assert.equal((diagnostics.match(/nueva sesión tras salir y volver/g) || []).length, 1, 'must reacquire once after the absence')
  } finally { session.close() }
  const fresh = new MattingSession()
  let reference
  try { await fresh.ready; reference = (await hold(fresh, returned, 3500)).alpha }
  finally { fresh.close() }
  // A return should converge to a fresh session, including opaque torso pixels.
  let solid = 0, covered = 0, error = 0
  for (let i = 0; i < alpha.length; i++) {
    error += Math.abs(alpha[i] - reference[i])
    if (reference[i] >= 250) { solid++; if (alpha[i] >= 230) covered++ }
  }
  const result = { resets: 1, solidReferencePixels: solid, opaqueRecovery: covered / solid, meanAlphaError: error / alpha.length }
  fs.writeFileSync(path.join(output, 'stats.json'), JSON.stringify(result, null, 2))
  fs.writeFileSync(path.join(output, 'native.log'), diagnostics)
  for (const [name, pixels] of [['recovered', alpha], ['fresh', reference]]) {
    fs.writeFileSync(path.join(output, name + '.pgm'), Buffer.concat([Buffer.from('P5\n288 512\n255\n'), pixels]))
  }
  assert.ok(solid > 1000, 'reference must contain a person')
  assert.ok(result.opaqueRecovery > .95, 'return must recover opaque foreground')
  assert.ok(result.meanAlphaError < 8, 'return must approach a fresh session')
  console.log(JSON.stringify(result, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
