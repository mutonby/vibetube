'use strict'
// Smoke test of the selected production camera adapter with synthetic video. No devices.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs'), path = require('path'), os = require('os'), { pathToFileURL } = require('url')
require('../../electron/matting').install(ipcMain, app)
const root = path.resolve(__dirname, '../..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-camera-smoke-'))
app.setPath('userData', temp)
app.commandLine.appendSwitch('allow-file-access-from-files')
const timeout = setTimeout(() => { console.error('Camera smoke test timed out'); app.exit(1) }, 45000)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'electron/preload.js'), backgroundThrottling: false } })
  let external = 0
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const remote = /^https?:/.test(details.url); if (remote) external++
    callback({ cancel: remote })
  })
  win.webContents.on('console-message', (_event, _level, message) => { if (!message.includes('Electron Security Warning')) console.log(message.slice(0, 400)) })
  const csp = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8').match(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/)[0]
  const page = path.join(temp, 'check.html')
  fs.writeFileSync(page, csp + '<base href="' + pathToFileURL(root + '/src/').href + '"><script src="vendor/livekit/livekit.js"></script><script src="livekit-campipe.js"></script><script src="matanyone-campipe.js"></script><script src="campipe.js"></script><script src="camcrop.js"></script>')
  await win.loadFile(page)
  const result = await win.webContents.executeJavaScript('(' + run.toString() + ')()')
  if (external) throw Error('Effect attempted an external request')
  console.log(JSON.stringify({ ...result, externalRequests: external }))
  clearTimeout(timeout); win.destroy(); app.quit()
}).catch(error => { console.error(error); app.exit(1) })
async function run() {
  const assert = (condition, message) => { if (!condition) throw Error(message) }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const source = document.createElement('canvas'); source.width = 640; source.height = 360
  const ctx = source.getContext('2d'); ctx.fillStyle = '#b02030'; ctx.fillRect(0, 0, 640, 360)
  const raw = source.captureStream(0), rawTrack = raw.getVideoTracks()[0]
  const pump = setInterval(() => { ctx.fillRect(0, 0, 640, 360); rawTrack.requestFrame() }, 33)
  const image = colour => { const c = document.createElement('canvas'); c.width = c.height = 32; c.getContext('2d').fillStyle = colour; c.getContext('2d').fillRect(0, 0, 32, 32); return c.toDataURL() }
  const pipe = new CamPipe()
  const output = await pipe.start(raw, { blur: true, background: image('#0000ff'), blurAmount: 0 })
  const video = document.createElement('video'); video.muted = true; video.srcObject = output; document.body.appendChild(video); await video.play()
  const sample = () => { const c = document.createElement('canvas'); c.width = c.height = 1; c.getContext('2d').drawImage(video, 10, 10, 1, 1, 0, 0, 1, 1); return [...c.getContext('2d').getImageData(0, 0, 1, 1).data] }
  const moreFrames = async () => { const target = pipe.stats.frames + 4, start = performance.now(); while (pipe.stats.frames < target) { assert(performance.now() - start < 5000, 'No processed frames'); await sleep(30) } await sleep(100) }
  await moreFrames()
  if (pipe.engine === 'matanyone2') {
    await pipe.backend.recordingSeed()
    const pausedFrames = pipe.stats.frames
    await sleep(250); assert(pipe.stats.frames === pausedFrames, 'Preview inference continued during raw recording')
    pipe.backend.resumeAfterRecording(); await moreFrames()
  }
  const blue = sample(); assert(blue[2] > 220 && blue[0] < 20, 'Blue replacement failed')
  await pipe.setBackground(image('#00ff00')); await moreFrames(); const green = sample(); assert(green[1] > 220 && green[2] < 20, 'Background switch retained stale image')
  await pipe.setBackground(null); await pipe.setBlurAmount(.5); await moreFrames()
  await pipe.setBlur(false); await sleep(250); const untouched = sample()
  assert(Math.abs(untouched[0] - 176) < 6 && Math.abs(untouched[1] - 32) < 6, 'Disabling effect did not restore original pixels')
  await pipe.setBlur(true); await pipe.setBackground(image('#0000ff')); await moreFrames()
  const crop = new CamCrop(), cropped = crop.start(output, { x: .25, y: .25, w: .5, h: .5 })
  const croppedVideo = document.createElement('video'); croppedVideo.muted = true; croppedVideo.srcObject = cropped; document.body.appendChild(croppedVideo); await croppedVideo.play(); await sleep(150)
  assert(croppedVideo.videoWidth === 320 && croppedVideo.videoHeight === 180, 'Processed video crop dimensions changed')
  crop.stop(); croppedVideo.srcObject = null; croppedVideo.remove()
  const frames = pipe.stats.frames; await pipe.stop()
  assert(rawTrack.readyState === 'live', 'Effect shutdown stopped original input')
  clearInterval(pump); rawTrack.stop(); video.srcObject = null
  assert(!document.querySelector('video[style]'), 'Hidden effect video elements leaked')
  return { engine: pipe.engine, frames, replacement: 'passed', modeSwitches: 'passed', crop: '320x180', originalTrackOwnership: 'passed' }
}
