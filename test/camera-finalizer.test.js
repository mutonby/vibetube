'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { Readable } = require('node:stream')
const { frames, outputCrop, CameraFinalizer } = require('../electron/camera-finalizer')
const { writeJson, readJson } = require('../electron/util')
test('frame reader preserves every frame across arbitrary pipe boundaries', async () => {
  const result = []
  for await (const frame of frames(Readable.from([Buffer.from('ab'), Buffer.from('cdefg'), Buffer.from('h')]), 4)) result.push(frame.toString())
  assert.deepEqual(result, ['abcd', 'efgh'])
  await assert.rejects(async () => { for await (const _ of frames(Readable.from([Buffer.from('abc')]), 4)) {} }, /incompleto/)
})
test('final crop retains native resolution and rejects coordinates outside the image', () => {
  assert.deepEqual(outputCrop(1920, 1080, null), { width: 1920, height: 1080, x: 0, y: 0 })
  assert.deepEqual(outputCrop(1920, 1080, { x: .1, y: .1, w: .723185911, h: .881036454 }), { x: 192, y: 108, width: 1388, height: 952 })
  assert.throws(() => outputCrop(1920, 1080, { x: .5, y: 0, w: 1, h: 1 }), /inválido/)
})
function fixture(t, process, capturing = () => false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-finalizer-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const clip = id => {
    const folder = path.join(dir, 'clips', id); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'webcam.webm'), 'original')
    writeJson(path.join(folder, 'sync.json'), { offset_ms: 12, sources: { webcam: { dims: { width: 1920, height: 1080 } } } })
    return { id, cam: { afterRecord: true, raw: true, background: '', blur_level: 0 }, dims: { webcam: { width: 1920, height: 1080 } }, camera_processing: { status: 'queued' } }
  }
  const read = () => readJson(path.join(dir, 'project.json')), write = (_, p) => writeJson(path.join(dir, 'project.json'), p)
  write(dir, { name: 'A', clips: [clip('clip_01'), clip('clip_02')] })
  const events = [], queue = new CameraFinalizer({ read, write, capturing, process, ffmpeg: () => 'ffmpeg', ffprobe: () => 'ffprobe', notify: e => events.push(e) })
  t.after(() => queue.close())
  return { dir, queue, read, write, events, file: (id, name) => path.join(dir, 'clips', id, name) }
}
test('processing keeps the original, updates only its clip and preserves sync offset', async t => {
  const f = fixture(t, async ({ source, destination, waitForCapture }) => {
    await waitForCapture(); assert.equal(fs.readFileSync(source, 'utf8'), 'original')
    const project = f.read(); project.name = 'Renamed while processing'; f.write(f.dir, project)
    fs.writeFileSync(destination, 'processed'); return { width: 1280, height: 720, frames: 60, fps: 30 }
  })
  await f.queue.enqueue(f.dir, 'clip_01')
  assert.equal(fs.readFileSync(f.file('clip_01', 'camera-original.webm'), 'utf8'), 'original')
  assert.equal(fs.readFileSync(f.file('clip_01', 'webcam.webm'), 'utf8'), 'processed')
  assert.equal(f.read().name, 'Renamed while processing'); assert.equal(f.read().clips[0].cam.raw, false)
  assert.equal(f.read().clips[1].camera_processing.status, 'queued')
  assert.equal(readJson(f.file('clip_01', 'sync.json')).offset_ms, 12)
})
test('failed output never replaces the original and a retry can complete', async t => {
  let attempts = 0
  const f = fixture(t, async ({ destination }) => {
    fs.writeFileSync(destination, 'partial')
    if (!attempts++) throw Error('verification failed')
    return { width: 1920, height: 1080, frames: 30, fps: 30 }
  })
  await f.queue.enqueue(f.dir, 'clip_01')
  assert.equal(f.read().clips[0].camera_processing.status, 'failed')
  assert.equal(fs.readFileSync(f.file('clip_01', 'webcam.webm'), 'utf8'), 'original')
  assert.equal(fs.existsSync(f.file('clip_01', 'camera-final.part.webm')), false)
  await f.queue.enqueue(f.dir, 'clip_01'); assert.equal(f.read().clips[0].camera_processing.status, 'done')
})
test('queue pauses inference during capture and cancellation leaves recoverable metadata', async t => {
  let capturing = true, entered
  const started = new Promise(r => { entered = r })
  const f = fixture(t, async ({ waitForCapture, destination }) => {
    entered(); await waitForCapture(); fs.writeFileSync(destination, 'processed'); return { width: 1920, height: 1080 }
  }, () => capturing)
  const job = f.queue.enqueue(f.dir, 'clip_01'); await started
  assert.equal(fs.readFileSync(f.file('clip_01', 'webcam.webm'), 'utf8'), 'original')
  f.queue.enqueue(f.dir, 'clip_02')
  await f.queue.cancel(f.dir, 'clip_02') // queued deletion must not wait for the active clip
  await f.queue.cancel(f.dir, 'clip_01'); await job
  assert.equal(f.read().clips[0].camera_processing.status, 'processing')
  assert.equal(fs.readFileSync(f.file('clip_01', 'webcam.webm'), 'utf8'), 'original')
})
