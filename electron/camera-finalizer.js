'use strict'
const fs = require('node:fs'), path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { MattingSession } = require('./matting')

async function* frames(readable, size) {
  let frame = Buffer.allocUnsafe(size), offset = 0
  for await (const chunk of readable) {
    let cursor = 0
    while (cursor < chunk.length) {
      const n = Math.min(size - offset, chunk.length - cursor)
      chunk.copy(frame, offset, cursor, cursor + n); offset += n; cursor += n
      if (offset === size) { yield frame; frame = Buffer.allocUnsafe(size); offset = 0 }
    }
  }
  if (offset) throw Error('Fotograma original incompleto')
}
function processFile(command, args, signal, stdio = ['ignore', 'pipe', 'pipe']) {
  const child = spawn(command, args, { signal, stdio })
  let errorText = ''
  child.stderr.on('data', b => { errorText = (errorText + b).slice(-3000) })
  child.stdin?.on('error', () => {}) // completion reports the failed encoder
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(Error(errorText || `Proceso de vídeo cerrado (${code})`)))
  })
  done.catch(() => {}) // consumed after the streaming loop, even on early failure
  return { child, done }
}
async function capture(command, args, signal) {
  const proc = processFile(command, args, signal), chunks = []
  for await (const b of proc.child.stdout) chunks.push(b)
  await proc.done
  return Buffer.concat(chunks).toString()
}
async function probe(file, ffprobe, signal) {
  return JSON.parse(await capture(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,nb_read_frames', '-of', 'json', file], signal)).streams
}
function outputCrop(width, height, rect) {
  if (!rect) return { width, height, x: 0, y: 0 }
  if (['x', 'y', 'w', 'h'].some(k => !Number.isFinite(rect[k])) || rect.x < 0 || rect.y < 0 || rect.w <= 0 || rect.h <= 0 || rect.x + rect.w > 1.000001 || rect.y + rect.h > 1.000001) throw Error('Recorte de cámara inválido')
  const x = Math.min(width - 2, Math.round(rect.x * width)) & ~1, y = Math.min(height - 2, Math.round(rect.y * height)) & ~1
  return { x, y, width: Math.max(2, Math.min(width - x, Math.round(rect.w * width)) & ~1), height: Math.max(2, Math.min(height - y, Math.round(rect.h * height)) & ~1) }
}

// Consume every decoded frame in order; processing speed never becomes playback
// speed. FFmpeg uses the same CFR timeline for source RGB and its native alpha.
async function finalizeCamera({ source, destination, background = '', blurLevel = 0, crop = null,
  seed = null, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', signal, onProgress = () => {}, waitForCapture = async () => {}, sessionFactory = () => new MattingSession(undefined, undefined, null, { fps: 30 }) }) {
  if (path.resolve(source) === path.resolve(destination)) throw Error('El resultado debe tener una ruta distinta al original')
  await waitForCapture()
  const streams = await probe(source, ffprobe, signal), video = streams.find(s => s.codec_type === 'video')
  if (!video || video.width > 1920 || video.height > 1080 || video.width < 2 || video.height < 2) throw Error('Resolución de cámara no compatible')
  if (background && !fs.existsSync(background)) throw Error('La imagen de fondo ya no existe')
  const { width, height } = video, size = outputCrop(width, height, crop)
  const scale = Math.min(1, 960 / width, 540 / height), mw = Math.round(width * scale), mh = Math.round(height * scale)
  const fps = 'fps=30:start_time=0', sigma = background ? blurLevel / 100 * 16 : 6 + blurLevel / 100 * 54
  const bgFilter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1${sigma ? `,gblur=sigma=${sigma.toFixed(3)}` : ''}`
  const graph = [
    `[0:v]${fps},format=rgba,split=2[fg][room]`,
    background ? `[room]nullsink;[2:v]${bgFilter}[bg]` : `[room]${bgFilter}[bg]`,
    `[1:v]scale=${width}:${height}:flags=bilinear[mask]`,
    '[fg][mask]alphamerge[person]',
    `[bg][person]overlay=shortest=1:format=auto,crop=${size.width}:${size.height}:${size.x}:${size.y},format=yuv420p[out]`,
  ].join(';')
  let native, decoder, encoder, count = 0
  const abortNative = () => native?.close()
  signal?.addEventListener('abort', abortNative, { once: true })
  try {
    await waitForCapture(); signal?.throwIfAborted()
    native = sessionFactory(); await native.ready
    if (seed) await native.frame(seed.width, seed.height, seed.pixels, 'RGBA', {}, seed.alpha)
    decoder = processFile(ffmpeg, ['-v', 'error', '-i', source, '-an', '-vf', fps, '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'], signal)
    const args = ['-v', 'error', '-y', '-i', source, '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${mw}x${mh}`, '-r', '30', '-i', 'pipe:0']
    if (background) args.push('-framerate', '30', '-loop', '1', '-i', background)
    args.push('-filter_complex', graph, '-map', '[out]', '-map', '0:a?', '-c:v', 'libvpx-vp9', '-crf', '18', '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-threads', '4', '-c:a', 'copy', destination)
    encoder = processFile(ffmpeg, args, signal, ['pipe', 'ignore', 'pipe'])
    for await (const pixels of frames(decoder.child.stdout, width * height * 4)) {
      await waitForCapture(); signal?.throwIfAborted()
      const reply = await native.frame(width, height, pixels)
      if (!encoder.child.stdin.write(reply.alpha)) await Promise.race([once(encoder.child.stdin, 'drain', { signal }), encoder.done.then(() => { throw Error('El codificador terminó antes de recibir todos los fotogramas') })])
      count++; if (count % 15 === 0) onProgress(count)
    }
    await decoder.done; encoder.child.stdin.end(); await encoder.done
    const result = await probe(destination, ffprobe, signal), out = result.find(s => s.codec_type === 'video')
    if (!count || out?.width !== size.width || out?.height !== size.height || Number(out.nb_read_frames) !== count) throw Error('La comprobación del vídeo procesado no coincide con el original')
    if (streams.some(s => s.codec_type === 'audio')) {
      const hash = file => capture(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', 'pipe:1'], signal)
      if (!result.some(s => s.codec_type === 'audio') || await hash(source) !== await hash(destination)) throw Error('El audio del original no se ha conservado')
    }
    return { width: size.width, height: size.height, frames: count, fps: 30, durationMs: count * 1000 / 30 }
  } finally {
    signal?.removeEventListener('abort', abortNative); native?.close()
    for (const p of [decoder, encoder]) if (p && p.child.exitCode == null) p.child.kill()
    await Promise.allSettled([decoder?.done, encoder?.done].filter(Boolean))
  }
}

class CameraFinalizer {
  constructor({ read, write, notify, ffmpeg, ffprobe, capturing, process = finalizeCamera }) {
    Object.assign(this, { read, write, notify, ffmpeg, ffprobe, capturing, process })
    this.jobs = new Map(); this.tail = Promise.resolve(); this.closed = false
  }
  enqueue(dir, clipId) {
    if (!/^clip_\d+$/.test(clipId)) return
    const key = path.join(dir, clipId)
    if (this.closed || this.jobs.has(key)) return
    const controller = new AbortController()
    const job = { controller }; this.jobs.set(key, job)
    job.done = this.tail = this.tail.catch(() => {}).then(async () => {
      job.started = true
      const clipDir = path.join(dir, 'clips', clipId), source = path.join(clipDir, 'camera-original.webm'), target = path.join(clipDir, 'webcam.webm'), temp = path.join(clipDir, 'camera-final.part.webm')
      const update = processing => {
        const project = this.read(dir), clip = project?.clips?.find(c => c.id === clipId)
        if (!clip || controller.signal.aborted) return
        clip.camera_processing = processing; this.write(dir, project); this.notify({ dir, clipId, ...processing })
      }
      try {
        controller.signal.throwIfAborted()
        const clip = this.read(dir)?.clips?.find(c => c.id === clipId)
        if (!clip?.cam?.afterRecord) return
        if (clip.cam.background && path.dirname(path.resolve(clip.cam.background)) !== path.resolve(clipDir)) throw Error('La copia del fondo no está dentro del clip')
        if (!fs.existsSync(source)) fs.copyFileSync(target, source, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE)
        update({ status: 'processing', frames: 0 })
        const waitForCapture = async () => {
          while (this.capturing()) {
            controller.signal.throwIfAborted()
            await new Promise(r => setTimeout(r, 100))
          }
        }
        let seed = null
        const seedInfo = path.join(clipDir, 'camera-seed.json')
        if (fs.existsSync(seedInfo)) seed = { ...JSON.parse(fs.readFileSync(seedInfo)), pixels: fs.readFileSync(path.join(clipDir, 'camera-seed.rgba')), alpha: fs.readFileSync(path.join(clipDir, 'camera-seed.alpha')) }
        const result = await this.process({ source, destination: temp, seed, background: clip.cam.background, blurLevel: clip.cam.blur_level, crop: clip.cam.crop,
          ffmpeg: this.ffmpeg(), ffprobe: this.ffprobe(), signal: controller.signal, waitForCapture,
          onProgress: frames => update({ status: 'processing', frames }) })
        controller.signal.throwIfAborted()
        const project = this.read(dir), current = project?.clips?.find(c => c.id === clipId)
        if (!current) return
        fs.renameSync(temp, target)
        current.cam.raw = false; current.cam.original = `clips/${clipId}/camera-original.webm`
        current.dims.webcam = { width: result.width, height: result.height }
        current.camera_processing = { status: 'done', ...result }
        this.write(dir, project)
        const syncPath = path.join(clipDir, 'sync.json')
        if (fs.existsSync(syncPath)) {
          const sync = JSON.parse(fs.readFileSync(syncPath)); sync.sources.webcam.dims = current.dims.webcam
          require('./util').writeJson(syncPath, sync)
        }
        fs.rmSync(path.join(clipDir, '_thumb.jpg'), { force: true })
        this.notify({ dir, clipId, status: 'done', ...result })
      } catch (e) {
        if (!controller.signal.aborted) update({ status: 'failed', error: e.message })
      } finally {
        fs.rmSync(temp, { force: true }); if (this.jobs.get(key) === job) this.jobs.delete(key)
      }
    })
    return job.done
  }
  async cancel(dir, clipId) {
    const jobs = [...this.jobs.entries()].filter(([key]) => clipId ? key === path.join(dir, clipId) : key.startsWith(dir + path.sep)).map(([, job]) => job)
    jobs.forEach(job => job.controller.abort())
    for (const [key, job] of this.jobs) if (jobs.includes(job) && !job.started) this.jobs.delete(key)
    await Promise.allSettled(jobs.filter(job => job.started).map(job => job.done))
  }
  close() { this.closed = true; for (const job of this.jobs.values()) job.controller.abort() }
}
module.exports = { finalizeCamera, CameraFinalizer, frames, outputCrop }
