'use strict'
// Reproducible local build. The reviewed seed correction removes a bounding-box
// crop; it does not alter the model or add any foreground heuristics.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..'), native = path.join(root, 'native')
const revision = 'd85a029870b5149af6aa122cbc13c90db11e5b35'
const cache = path.join(native, '.cache'), repo = path.join(cache, 'MatAnyone2Kit')
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.log('MatAnyone2 requiere macOS Apple Silicon; se conserva LiveKit.'); process.exit(0)
}
fs.mkdirSync(cache, { recursive: true })
if (!fs.existsSync(repo)) run('git', ['clone', 'https://github.com/flowtyone/MatAnyone2Kit.git', repo])
run('git', ['checkout', '--detach', revision], repo)
const bridge = path.join(repo, 'Sources/MatAnyoneKitCoreML/CoreMLFrameBridge.swift')
// Read the pinned blob rather than reapplying the change to an edited cache.
let source = execFileSync('git', ['show', `${revision}:Sources/MatAnyoneKitCoreML/CoreMLFrameBridge.swift`], { cwd: repo, encoding: 'utf8' })
const begin = source.indexOf('        // Intersect with the closest (largest) human box, if any.')
const end = source.indexOf('\n        return mask\n', begin)
if (begin < 0 || end < 0) throw Error('La fuente de MatAnyone2 no coincide con la revisión probada')
source = source.slice(0, begin) + source.slice(end)
source = source.replace('        let human = VNDetectHumanRectanglesRequest()\n', '').replace('handler.perform([seg, human])', 'handler.perform([seg])')
fs.writeFileSync(bridge, source)
const facadePath = 'Sources/MatAnyoneKitCoreML/MatAnyoneMatte.swift'
let facade = execFileSync('git', ['show', `${revision}:${facadePath}`], { cwd: repo, encoding: 'utf8' })
const entry = '    public func matte(_ pixelBuffer: CVPixelBuffer, completion: (MatteFrame) -> Void) {'
if (!facade.includes(entry)) throw Error('La API de MatAnyone2 no coincide con la revisión probada')
facade = facade.replace(entry, fs.readFileSync(path.join(native, 'matanyone/InitialSelection.swift.txt'), 'utf8') + '\n' + entry)
fs.writeFileSync(path.join(repo, facadePath), facade)
const pkg = path.join(native, 'matanyone')
run('swift', ['build', '-c', 'release', '--package-path', pkg])
const built = path.join(pkg, '.build/release'), bin = path.join(native, 'bin')
fs.mkdirSync(bin, { recursive: true })
// Replace the inode: overwriting a running signed Mach-O can leave macOS's
// signature cache referring to the previous executable.
const nextBinary = path.join(bin, 'RecordMatte.next')
fs.copyFileSync(path.join(built, 'RecordMatte'), nextBinary)
fs.chmodSync(nextBinary, 0o755)
fs.renameSync(nextBinary, path.join(bin, 'RecordMatte'))
for (const item of fs.readdirSync(built).filter(name => name.endsWith('.bundle'))) {
  fs.cpSync(path.join(built, item), path.join(bin, item), { recursive: true })
}
for (const name of ['LICENSE', 'NOTICE.md']) fs.copyFileSync(path.join(repo, name), path.join(bin, name))
fs.writeFileSync(path.join(bin, 'build.json'), JSON.stringify({ engine: 'matanyone2', revision, seed: 'complete-vision-person-mask', bridgeSha256: crypto.createHash('sha256').update(source).digest('hex') }, null, 2))
console.log('MatAnyone2 compilado y disponible para Record Studio.')
