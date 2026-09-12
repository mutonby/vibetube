'use strict'
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const root = path.resolve(__dirname, '..'), output = path.join(root, 'src/vendor/livekit')
async function build() {
  fs.mkdirSync(output, { recursive: true })
  const bundle = await require('esbuild').build({
    entryPoints: [require.resolve('@livekit/track-processors')],
    bundle: true, platform: 'browser', format: 'iife', globalName: 'LiveKitProcessors',
    minify: true, outfile: path.join(output, 'livekit.js'), legalComments: 'linked', metafile: true,
  })
  const packages = new Map()
  for (const file of Object.keys(bundle.metafile.inputs)) {
    let dir = path.dirname(path.resolve(file))
    while (dir !== path.dirname(dir) && !fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir)
    if (!dir.includes('node_modules')) continue
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')))
    const license = fs.readdirSync(dir).find(f => /^licen[sc]e(?:\.(?:md|txt))?$/i.test(f))
    packages.set(pkg.name, `${pkg.name}@${pkg.version}\nLicense: ${pkg.license}\n${license ? fs.readFileSync(path.join(dir, license), 'utf8') : 'See the upstream repository and LICENSE-APACHE-2.0.txt.'}`)
  }
  fs.writeFileSync(path.join(output, 'THIRD-PARTY-NOTICES.txt'), [...packages.values()].join('\n\n--------------------\n\n') + '\n')
  const fromLiveKit = require('module').createRequire(require.resolve('@livekit/track-processors/package.json'))
  const vision = path.dirname(fromLiveKit.resolve('@mediapipe/tasks-vision'))
  fs.cpSync(path.join(vision, 'wasm'), path.join(output, 'wasm'), { recursive: true })
  const files = ['livekit.js', 'selfie_segmenter.tflite', ...fs.readdirSync(path.join(output, 'wasm')).map(f => 'wasm/' + f)]
  const hashes = Object.fromEntries(files.map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(output, f))).digest('hex')]))
  fs.writeFileSync(path.join(output, 'assets.json'), JSON.stringify({
    livekit: require('@livekit/track-processors/package.json').version,
    mediapipe: JSON.parse(fs.readFileSync(path.join(vision, 'package.json'))).version,
    sha256: hashes,
  }, null, 2) + '\n')
  console.log('LiveKit y sus recursos locales preparados, sin parches.')
}
build().catch(error => { console.error(error); process.exitCode = 1 })
