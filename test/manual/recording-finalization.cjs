'use strict'
// End-to-end app recording in isolated userData/project: no devices, agents or
// voice services. Verifies saved original, queued final and navigation ownership.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..'), output = process.argv[2] || '/tmp/rs-finalization-ui'
fs.mkdirSync(output, { recursive: true })
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-finalization-app-'))
app.setPath('userData', userData)
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ root: path.resolve(output), recentRoots: [path.resolve(output)], enhanceVoice: false, finalBackground: true }))
const timeout = setTimeout(() => { console.error('Recording finalization timeout'); app.exit(1) }, 120000)
require('../../electron/main')
app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
  win.webContents.session.webRequest.onBeforeRequest((request, callback) => callback({ cancel: /^https?:/.test(request.url) }))
  if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r))
  const result = await win.webContents.executeJavaScript(`(${run.toString()})(${JSON.stringify(path.resolve(output))})`)
  const project = JSON.parse(fs.readFileSync(path.join(result.dir, 'project.json'))), clip = project.clips[0]
  assert.ok(Math.abs(clip.offset_ms) < 10, 'Encoder startup notifications must not shift screen/camera sync');
  assert.equal(project.clips.length, 1); assert.equal(clip.camera_processing.status, 'done'); assert.equal(clip.cam.raw, false)
  const original = path.join(result.dir, clip.cam.original), final = path.join(result.dir, clip.webcam)
  assert.ok(fs.existsSync(path.join(result.dir, 'clips/clip_01/camera-seed.json')));
  assert.ok(fs.existsSync(original)); assert.ok(fs.existsSync(final))
  const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,width,height,nb_read_frames,r_frame_rate', '-of', 'json', final], { encoding: 'utf8' })).streams
  const video = streams.find(s => s.codec_type === 'video')
  assert.equal(video.width, 1920); assert.equal(video.height, 1080); assert.equal(video.r_frame_rate, '30/1'); assert.ok(Number(video.nb_read_frames) >= 75)
  assert.ok(streams.some(s => s.codec_type === 'audio')); assert.equal(result.previewStopped, true); assert.equal(result.previewResumed, true); assert.equal(result.audioDelay, 0)
  assert.equal(result.currentAfterSave, result.other); assert.equal(result.playDisabledWhilePending, true); assert.equal(result.playEnabledWhenDone, true)
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ...result, video, processing: clip.camera_processing }, null, 2))
  console.log('RECORDING FINALIZATION PASSED', { ...result, video })
  clearTimeout(timeout); app.quit()
}).catch(e => { console.error(e); app.exit(1) })
async function run(root) {
  // Wait for the initial source list/Home transition before installing fixtures.
  while (document.getElementById('refreshSources').disabled) await new Promise(r => setTimeout(r, 100))
  await new Promise(r => setTimeout(r, 100))
  const a = await window.studio.createProject(root, 'Prueba final'), b = await window.studio.createProject(root, 'Otro proyecto')
  state.projects = [a, b]; state.current = a.dir; state.currentName = a.name; state.detail = a
  const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#255f99'; ctx.fillRect(0, 0, 1920, 1080)
  const raw = canvas.captureStream(0), track = raw.getVideoTracks()[0]
  const pump = setInterval(() => { ctx.fillRect(0, 0, 1920, 1080); track.requestFrame() }, 33)
  const audio = new AudioContext(), tone = audio.createOscillator(), gain = audio.createGain(), dest = audio.createMediaStreamDestination()
  gain.gain.value = .03; tone.connect(gain).connect(dest); tone.start(); await audio.resume(); raw.addTrack(dest.stream.getAudioTracks()[0])
  state.rawCam = raw; state.camStream = raw; state.nativeCamera = true; state.finalBackground = true; state.rawRecord = false; state.blur = true; state.blurLevel = 0; state.crop = false
  state.bgPath = (await window.studio.listPresetBackgrounds())[0].path
  state.bgData = await window.studio.loadBackground(state.bgPath)
  let previewStopped = false, previewResumed = false; state.pipe = { engine: 'matanyone2', outputStream: raw, backend: { resumeAfterRecording: () => { previewResumed = true }, recordingSeed: async () => { previewStopped = true; return ({ width: 1920, height: 1080, pixels: new Uint8Array(ctx.getImageData(0, 0, 1920, 1080).data.buffer), alpha: new Uint8Array(288 * 512).fill(255) }) } }, stop: async () => { previewStopped = true } }
  el('camPreview').srcObject = raw; await el('camPreview').play()
  state.screenStream = new MediaStream([track.clone()]); el('screenPreview').srcObject = state.screenStream; await el('screenPreview').play()
  state.selectedSourceId = 'screen:fixture'; state.sources = [{ id: 'screen:fixture', name: 'Fixture', kind: 'screen' }]
  state.dims = { webcam: { width: 1920, height: 1080 }, screen: { width: 1920, height: 1080 } }; state.keepMainVisible = true
  await startRecording()
  await new Promise(r => setTimeout(r, 3000))
  state.current = b.dir; state.currentName = b.name; state.detail = b
  await stopRecording(false)
  const currentAfterSave = state.current, audioDelay = rec.audioDelayMs
  state.current = a.dir; state.currentName = a.name
  await renderRecClips()
  const playDisabledWhilePending = !!el('recClips').querySelector('.rc-play')?.disabled
  await finishFromFloat(); clearInterval(pump); track.stop(); state.screenStream.getTracks().forEach(t => t.stop()); await audio.close()
  let detail
  for (let i = 0; i < 700; i++) {
    detail = await window.studio.projectDetail(a.dir)
    const status = detail.clips[0]?.cameraProcessing
    if (status?.status === 'failed') throw Error(status.error)
    if (status?.status === 'done') break
    await new Promise(r => setTimeout(r, 100))
  }
  await renderRecClips()
  return { dir: a.dir, other: b.dir, currentAfterSave, previewStopped, previewResumed, audioDelay, playDisabledWhilePending, playEnabledWhenDone: !el('recClips').querySelector('.rc-play')?.disabled }
}
