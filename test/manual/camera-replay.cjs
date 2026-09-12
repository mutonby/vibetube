'use strict'
// Exercise the production adapter with a local clip. No camera, microphone,
// room connection or external model download is used.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs'), path = require('path'), os = require('os'), { pathToFileURL } = require('url')
require('../../electron/matting').install(ipcMain, app)
const root = path.resolve(__dirname, '../..'), source = process.argv[2], output = process.argv[3]
if (!source || !output) throw Error('Usage: electron test/manual/camera-replay.cjs input.webm output-directory [blur]')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-livekit-check-'))
app.setPath('userData', temp)
app.commandLine.appendSwitch('allow-file-access-from-files')
const timeout = setTimeout(() => { console.error('Camera replay timed out'); app.exit(1) }, 90000)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'electron/preload.js'), backgroundThrottling: false } })
  const floating = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'electron/float-preload.js'), backgroundThrottling: false } })
  let previews = 0, externalRequests = 0
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const external = /^https?:/.test(details.url)
    if (external) externalRequests++
    callback({ cancel: external })
  })
  ipcMain.on('float-preview-request', () => { if (!win.isDestroyed()) win.webContents.send('float-preview-request') })
  ipcMain.on('float-preview-frame', (_event, bytes) => { if (!floating.isDestroyed()) { previews++; floating.webContents.send('float-preview-frame', bytes) } })
  win.webContents.on('console-message', (_e, _level, message) => { if (!message.includes('Electron Security Warning')) console.log(message.slice(0, 500)) })
  const csp = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8').match(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/)[0]
  const page = path.join(temp, 'check.html')
  fs.writeFileSync(page, `${csp}<meta charset="utf-8"><base href="${pathToFileURL(root + '/src/').href}"><script src="vendor/livekit/livekit.js"></script><script src="livekit-campipe.js"></script><script src="matanyone-campipe.js"></script><script src="campipe.js"></script><script src="camcrop.js"></script><script src="float-preview.js"></script>`)
  await win.loadFile(page)
  await floating.loadFile(path.join(root, 'src/float.html'))
  const config = { source: pathToFileURL(path.resolve(source)).href, background: process.argv[4] === 'blur' ? null : pathToFileURL(path.join(root, 'src/backgrounds/mi-estudio.jpg')).href, points: process.argv[5] ? JSON.parse(process.argv[5]) : null }
  const result = await win.webContents.executeJavaScript(`(${run.toString()})(${JSON.stringify(config)})`)
  result.previews = previews
  result.externalRequests = externalRequests
  result.previewDrawn = await floating.webContents.executeJavaScript(`document.getElementById('self').getContext('2d').getImageData(0,0,1,1).data[3]===255`)
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, 'processed.webm'), Buffer.from(result.video.split(',')[1], 'base64'))
  delete result.video
  fs.writeFileSync(path.join(output, 'stats.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  if (result.fps < (result.engine === 'matanyone2' ? 12 : 24) || !result.previewDrawn || previews < 20 || externalRequests) throw Error('Camera replay failed: FPS, floating preview or local-only assets')
  clearTimeout(timeout)
  floating.destroy(); win.destroy(); app.quit()
}).catch(error => { console.error(error); app.exit(1) })

async function run(config) {
  const input = document.createElement('video'); input.muted = true; input.loop = true; input.src = config.source
  document.body.appendChild(input); await input.play()
  input.pause()
  const sourceCanvas = document.createElement('canvas'); sourceCanvas.width = input.videoWidth; sourceCanvas.height = input.videoHeight
  const sourceContext = sourceCanvas.getContext('2d'); sourceContext.drawImage(input, 0, 0)
  const raw = sourceCanvas.captureStream(0), original = raw.getVideoTracks()[0]
  const pump = setInterval(() => { sourceContext.drawImage(input, 0, 0); original.requestFrame() }, 33)
  window.addEventListener('camera-effect-error', event => { throw Error(event.detail) })
  const camera = new CamPipe()
  const stream = await camera.start(raw, { blur: true, blurAmount: config.background ? 0 : 0.35, background: config.background,
    calibration: config.points ? { frame: sourceCanvas, points: config.points } : null })
  if (await studio.matting.available() && camera.engine !== 'matanyone2') throw Error('Production did not use MatAnyone2')
  window.installFloatPreview(window.studio, () => ({ source: camera.previewSource, rect: { x: .1, y: .1, w: .8, h: .8 } }))
  const view = document.createElement('video'); view.muted = true; view.srcObject = stream; document.body.appendChild(view); await view.play()
  input.loop = false; input.currentTime = 0; await input.play()
  const chunks = [], recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 6000000 })
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
  const start = performance.now(), frames = camera.stats.frames
  recorder.start(250)
  await new Promise((resolve, reject) => { input.onended = resolve; input.onerror = reject })
  await new Promise(resolve => setTimeout(resolve, 100))
  await new Promise(resolve => { recorder.onstop = resolve; recorder.stop() })
  const elapsedMs = performance.now() - start
  const video = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(new Blob(chunks, { type: recorder.mimeType })) })
  const result = { video, engine: camera.engine, frames: camera.stats.frames - frames, elapsedMs, fps: (camera.stats.frames - frames) * 1000 / elapsedMs, meanSegmentationMs: camera.stats.segmentationMs / camera.stats.frames }
  const originalState = original.readyState
  await camera.stop()
  if (original.readyState !== originalState) throw Error('Stopping the effect stopped the source camera')
  clearInterval(pump); raw.getTracks().forEach(track => track.stop()); input.pause(); view.srcObject = null
  return result
}
