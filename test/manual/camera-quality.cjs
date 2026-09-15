'use strict'
// Full HD recording through the production bitrate and crop code. Synthetic
// pixels make black frames and silent downscaling detectable without a camera.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..'), output = process.argv[2] || '/tmp/rs-camera-quality'
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'rs-quality-')))
const timeout = setTimeout(() => app.exit(1), 45000)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  await win.loadURL('about:blank')
  const recording = fs.readFileSync(path.join(root, 'src/recording.js'), 'utf8')
  const bitrate = recording.match(/function cameraVideoBitrate\([^]*?\n}/)[0]
  const cameraMime = recording.match(/function pickCameraMime\([^]*?\n}/)[0]
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'src/camcrop.js'), 'utf8') + '\n' + bitrate + '\n' + cameraMime + '\nvoid 0')
  const results = await win.webContents.executeJavaScript(`(${run.toString()})()`)
  fs.mkdirSync(output, { recursive: true })
  for (const result of results) {
    const filename = path.join(output, result.name + '.webm')
    fs.writeFileSync(filename, Buffer.from(result.video.split(';base64,')[1], 'base64')); delete result.video
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'json', filename], { encoding: 'utf8' })).streams[0]
    assert.equal(probe.width, result.expected.width); assert.equal(probe.height, result.expected.height)
    assert.equal(result.dims.width, probe.width); assert.equal(result.dims.height, probe.height)
    assert.ok(Number(probe.nb_read_frames) >= 70, 'Full HD capture should retain at least 23 FPS in this 3 second fixture')
    assert.ok(result.samples.every(p => p[1] > 120 && p[0] < 60), 'Encoded image must retain the source pixels')
    assert.ok(result.originalLive, 'Cropping must preserve the source track')
    result.probe = probe
  }
  fs.writeFileSync(path.join(output, 'stats.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results, null, 2))
  clearTimeout(timeout); win.destroy(); app.quit()
}).catch(error => { console.error(error); app.exit(1) })

async function run() {
  const results = []
  for (const cropped of [false, true]) {
    const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080
    const ctx = canvas.getContext('2d'), raw = canvas.captureStream(0), track = raw.getVideoTracks()[0]
    let count = 0
    const timer = setInterval(() => {
      ctx.fillStyle = 'rgb(20,170,100)'; ctx.fillRect(0, 0, 1920, 1080)
      ctx.fillStyle = 'white'; ctx.font = '24px sans-serif'; ctx.fillText('1920 × 1080 · Detalle de cámara', 600, 100)
      for (let x = 600; x < 1200; x += 4) ctx.fillRect(x, 120, 1, 200)
      ctx.fillRect(count++ % 100, 0, 20, 1080); track.requestFrame()
    }, 33)
    const crop = new CamCrop(), stream = cropped ? crop.start(raw, { x: .1, y: .1, w: .723185911, h: .881036454 }) : raw
    const dims = cropped ? crop.outDims : { width: 1920, height: 1080 }
    const chunks = [], recorder = new MediaRecorder(stream, { mimeType: pickCameraMime(false), videoBitsPerSecond: cameraVideoBitrate(dims.width, dims.height) })
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }; recorder.start(250)
    await new Promise(r => setTimeout(r, 3000)); await new Promise(r => { recorder.onstop = r; recorder.stop() })
    crop.stop(); const originalLive = track.readyState === 'live'; clearInterval(timer); track.stop()
    const blob = new Blob(chunks, { type: recorder.mimeType }), url = URL.createObjectURL(blob), player = document.createElement('video')
    player.muted = true; player.src = url; await player.play()
    const samples = []
    for (let i = 0; i < 3; i++) { await new Promise(r => setTimeout(r, 200)); ctx.drawImage(player, 0, 0); samples.push([...ctx.getImageData(200, 400, 1, 1).data]) }
    player.pause(); URL.revokeObjectURL(url)
    const video = await new Promise(r => { const reader = new FileReader(); reader.onload = () => r(reader.result); reader.readAsDataURL(blob) })
    results.push({ name: cropped ? 'cropped' : '1080p', video, samples, dims, expected: cropped ? { width: 1388, height: 952 } : { width: 1920, height: 1080 }, originalLive, bitrate: recorder.videoBitsPerSecond })
  }
  return results
}
