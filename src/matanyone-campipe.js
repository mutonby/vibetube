'use strict'

// One request at a time, on a port owned by this native session. Pixel buffers
// bypass the extra copies through the isolated context bridge.
class MattingConnection {
  constructor(id) {
    const { port1, port2 } = new MessageChannel()
    this.port = port1
    port1.onmessage = ({ data }) => {
      const pending = this.pending; this.pending = null
      if (!pending) return
      clearTimeout(pending.timer)
      if (data.error) pending.reject(Error(data.error)); else pending.resolve(data)
    }
    port1.onmessageerror = () => this.close()
    window.postMessage({ type: 'matting-connect', id }, '*', [port2])
  }
  frame(payload) {
    if (this.closed || this.pending) return Promise.reject(Error('Canal de cámara no disponible'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), 15000)
      this.pending = { resolve, reject, timer }
      // Electron 33 MessagePortMain cannot deserialize transferred ArrayBuffers.
      this.port.postMessage(payload)
    })
  }
  close() {
    this.closed = true; this.port.close()
    if (this.pending) {
      clearTimeout(this.pending.timer); this.pending.reject(Error('Se cerró el canal de cámara'))
      this.pending = null
    }
  }
}

// MatAnyone2 owns the mask and temporal memory. Composite each alpha with the
// exact camera frame that produced it; keep only one inference in flight.
class MatAnyoneCamPipe {
  constructor() {
    this.stats = { frames: 0, segmentationMs: 0 }
    this.updates = Promise.resolve(); this.api = window.studio.matting
  }
  start(stream, { blur = true, blurAmount = .5, background = null, calibration = null } = {}) {
    this.calibration = calibration
    this.blur = blur; this.blurAmount = this.amount(blurAmount)
    this.setup = this.initialize(stream, background)
    return this.setup.catch(async error => { await this.stop(); throw error })
  }
  async initialize(stream, background) {
    this.source = stream.getVideoTracks()[0].clone()
    // Keep capture timestamps through transforms. MediaRecorder's remaining
    // arrival-time latency is measured below and compensated in recorded audio.
    this.reader = new MediaStreamTrackProcessor({ track: this.source, maxBufferSize: 1 }).readable.getReader()
    const { value: first, done } = await this.reader.read()
    if (done || this.stopped) { first?.close(); return stream }
    this.firstFrame = first
    const receivedAt = performance.now()
    const scale = Math.min(1, 1920 / first.displayWidth, 1080 / first.displayHeight)
    this.width = Math.round(first.displayWidth * scale); this.height = Math.round(first.displayHeight * scale)
    this.frame = this.canvas(this.width, this.height, true)
    this.foreground = this.canvas(this.width, this.height)
    this.outputCanvas = this.canvas(this.width, this.height)
    this.mask = this.canvas(288, 512); this.maskPixels = this.mask.ctx.createImageData(288, 512)
    this.maskPixels.data.fill(255)
    await this.setBackground(background)
    if (this.stopped) return stream
    this.session = await this.api.start(this.calibration?.points)
    if (this.stopped) { await this.api.stop(this.session); return stream }
    this.connection = new MattingConnection(this.session)
    this.track = new MediaStreamTrackGenerator({ kind: 'video' })
    this.writer = this.track.writable.getWriter()
    this.output = new MediaStream([this.track, ...stream.getAudioTracks()])
    this.firstFrame = null
    await this.processFrame(first, receivedAt)
    if (!this.stopped) this.reading = this.readFrames()
    console.info('[campipe] MatAnyone2 activo')
    return this.output
  }
  canvas(width, height, read = false) {
    const c = document.createElement('canvas'); c.width = width; c.height = height
    c.ctx = c.getContext('2d', { willReadFrequently: read }); return c
  }
  amount(value) { return Math.max(0, Math.min(1, Number(value) || 0)) }
  get effectEnabled() { return this.blur && (!!this.background || this.blurAmount > 0) }
  get previewSource() { return this.outputCanvas }
  get outputStream() { return this.output }
  async readFrames() {
    try {
      while (!this.stopped) {
        const { value: frame, done } = await this.reader.read()
        if (done) break
        if (this.stopped) { frame.close(); break }
        const input = { frame, receivedAt: performance.now() }
        if (this.busy) {
          this.latest?.frame.close()
          this.latest = input
        } else {
          this.busy = true
          this.processing = this.drainFrames(input)
        }
      }
    } catch (error) { this.fail(error) }
  }
  async drainFrames(input) {
    try {
      while (input) {
        await this.processFrame(input.frame, input.receivedAt)
        input = this.latest; this.latest = null
      }
    } catch (error) { this.fail(error) }
    finally { this.busy = false }
  }
  fail(error) {
    if (!this.stopped) {
      this.stop()
      window.dispatchEvent(new CustomEvent('camera-effect-error', { detail: error.message }))
    }
  }
  async processFrame(frame, receivedAt = performance.now()) {
    const started = performance.now()
    try {
      this.frame.ctx.drawImage(this.calibration?.frame || frame, 0, 0, this.width, this.height)
      if (this.effectEnabled) {
        // Keep the same Core Image preprocessing on every frame as the approved
        // offline runner. Browser resizing changes the recurrent model's input.
        const input = this.frame
        const rgba = input.ctx.getImageData(0, 0, input.width, input.height).data
        const reply = await this.connection.frame({ width: input.width, height: input.height, rgba: new Uint8Array(rgba.buffer) })
        if (this.stopped) return
        if (reply.alpha.length !== 288 * 512) throw Error('MatAnyone2 devolvió una máscara incompleta')
        if (reply.selectionLost && !this.selectionLost) {
          this.selectionLost = true
          window.dispatchEvent(new CustomEvent('camera-selection-lost'))
        }
        for (let i = 0; i < reply.alpha.length; i++) {
          const p = i * 4
          this.maskPixels.data[p+3] = reply.alpha[i]
        }
        this.mask.ctx.putImageData(this.maskPixels, 0, 0)
        this.stats.segmentationMs += reply.milliseconds
        this.composite()
        this.calibration = null
      } else this.outputCanvas.ctx.drawImage(this.frame, 0, 0)
      if (this.stopped) return
      const output = new VideoFrame(this.outputCanvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined })
      try { await this.writer.write(output) } finally { output.close() }
      this.stats.frames++
      this.stats.processingMs = performance.now() - started
      // Exclude model startup/seed time from the steady-state audio delay.
      if (this.stats.frames > 1) {
        const latency = performance.now() - receivedAt
        this.stats.latencyMs = this.stats.latencyMs == null ? latency : this.stats.latencyMs * .9 + latency * .1
      }
    } finally { frame.close() }
  }
  composite() {
    const { width: w, height: h } = this, fg = this.foreground.ctx, out = this.outputCanvas.ctx
    fg.clearRect(0, 0, w, h); fg.drawImage(this.frame, 0, 0)
    fg.globalCompositeOperation = 'destination-in'; fg.drawImage(this.mask, 0, 0, w, h)
    fg.globalCompositeOperation = 'source-over'
    out.save()
    const radius = this.background ? this.blurAmount * 16 : 6 + this.blurAmount * 54
    out.filter = radius ? `blur(${radius}px)` : 'none'
    const margin = Math.ceil(radius * 3), image = this.background || this.frame
    const scale = Math.max((w + 2 * margin) / image.width, (h + 2 * margin) / image.height)
    const dw = image.width * scale, dh = image.height * scale
    out.drawImage(image, (w-dw)/2, (h-dh)/2, dw, dh)
    out.restore(); out.drawImage(this.foreground, 0, 0)
  }
  setBackground(url) {
    this.updates = this.updates.catch(() => {}).then(async () => {
      let image = null
      if (url) { image = new Image(); image.src = url; await image.decode() }
      if (!this.stopped) this.background = image
    })
    return this.updates
  }
  setBlur(on) { this.blur = !!on; return Promise.resolve() }
  setBlurAmount(value) { this.blurAmount = this.amount(value); return Promise.resolve() }
  stop() {
    this.stopped = true
    this.connection?.close()
    this.reader?.cancel().catch(() => {})
    this.writer?.abort().catch(() => {})
    this.firstFrame?.close(); this.firstFrame = null
    this.latest?.frame.close(); this.latest = null
    const closing = this.session ? this.api.stop(this.session).catch(() => {}) : Promise.resolve()
    return this.cleanup ||= (async () => {
      await closing; await this.setup?.catch(() => {}); await this.updates.catch(() => {})
      this.track?.stop(); this.source?.stop()
      await this.reading?.catch(() => {})
      await this.processing?.catch(() => {})
      this.output = null
    })()
  }
}
window.MatAnyoneCamPipe = MatAnyoneCamPipe
