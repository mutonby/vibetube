'use strict'

// ----------------------------------------------------------------------------
// CamPipe — shared webcam processor with optional real-time background blur
// (MediaPipe Selfie Segmentation), drawn to an offscreen canvas.
//
// Used by both the recorder (main window) and the self-view (floating window).
// Fail-safe: if MediaPipe is missing or errors, it passes the camera through
// unblurred so recording/preview never break.
//
// Uses a setTimeout loop (NOT requestAnimationFrame) so the canvas keeps
// updating while the recorder window is HIDDEN during capture
// (backgroundThrottling:false keeps timers alive; rAF would pause).
// ----------------------------------------------------------------------------

class CamPipe {
  constructor() {
    this.canvas = document.createElement('canvas')
    this.ctx = this.canvas.getContext('2d')
    // Offscreen accumulator that holds the TEMPORALLY-SMOOTHED mask. MediaPipe's
    // per-frame mask jitters at the edges → visible flicker in the background.
    // We blend each new mask into this accumulator (exponential moving average)
    // so the silhouette is stable frame-to-frame, the same trick Google Meet uses.
    this.maskCanvas = document.createElement('canvas')
    this.maskCtx = this.maskCanvas.getContext('2d')
    this.maskReady = false
    this.video = document.createElement('video')
    this.video.muted = true
    this.video.playsInline = true
    this.blur = false
    this.blurAmount = 0.5   // 0..1 background blur intensity (UI slider)
    this.smoothing = 0.5    // EMA weight of the NEW mask (lower = steadier, more lag)
    this.running = false
    this.seg = null
    this.segReady = false
    this.timer = null
    this._out = null
    this.fps = 30
  }

  async start(stream, { blur = false, blurAmount } = {}) {
    this.input = stream
    this.blur = blur
    if (typeof blurAmount === 'number') this.blurAmount = Math.max(0, Math.min(1, blurAmount))
    this.video.srcObject = stream
    try { await this.video.play() } catch { /* autoplay */ }
    this.canvas.width = this.video.videoWidth || 1280
    this.canvas.height = this.video.videoHeight || 720
    this.maskCanvas.width = this.canvas.width
    this.maskCanvas.height = this.canvas.height
    this.maskReady = false
    if (blur) this._initSeg()
    this.running = true
    this._loop()
    this._out = this.canvas.captureStream(this.fps)
    const audio = stream.getAudioTracks()[0]
    if (audio) this._out.addTrack(audio)
    return this._out
  }

  _initSeg() {
    if (this.seg || !window.SelfieSegmentation) return
    try {
      this.seg = new window.SelfieSegmentation({ locateFile: (f) => `vendor/mediapipe/${f}` })
      // modelSelection 0 = general 256×256 model → finer mask than the 256×144 landscape one.
      this.seg.setOptions({ modelSelection: 0, selfieMode: false })
      this.seg.onResults((r) => this._composite(r))
      this.segReady = true
    } catch {
      this.seg = null
      this.segReady = false
    }
  }

  setBlur(on) {
    this.blur = !!on
    this.maskReady = false  // reseed the smoothed mask when toggled
    if (on) this._initSeg()
  }

  // 0..1 → background blur strength in px, scaled to the frame height so it
  // looks the same at any resolution.
  setBlurAmount(v) {
    this.blurAmount = Math.max(0, Math.min(1, Number(v)))
  }

  _bgBlurPx() {
    const h = this.canvas.height || 720
    return Math.max(2, Math.round(h / 120 + this.blurAmount * (h / 22)))
  }

  async _loop() {
    if (!this.running) return
    try {
      if (this.blur && this.segReady && this.seg && this.video.readyState >= 2) {
        await this.seg.send({ image: this.video })
      } else {
        this._drawPlain()
      }
    } catch {
      this._drawPlain()
    }
    if (this.running) this.timer = setTimeout(() => this._loop(), 1000 / this.fps)
  }

  _drawPlain() {
    if (this.video.readyState >= 2) {
      this.ctx.filter = 'none'
      this.ctx.globalCompositeOperation = 'source-over'
      this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height)
    }
  }

  // Fold the new MediaPipe mask into the persistent accumulator as an
  // exponential moving average on the ALPHA channel:
  //   smoothed = (1 - a) * smoothed + a * current
  // This is what removes the per-frame edge jitter (the "flicker").
  _accumulateMask(maskImage) {
    const m = this.maskCtx
    const w = this.maskCanvas.width
    const h = this.maskCanvas.height
    if (!this.maskReady) {
      // Seed the first frame fully so the person isn't transparent on startup.
      m.globalCompositeOperation = 'source-over'
      m.globalAlpha = 1
      m.clearRect(0, 0, w, h)
      m.drawImage(maskImage, 0, 0, w, h)
      this.maskReady = true
    } else {
      const a = this.smoothing
      // 1) decay the accumulated alpha by (1 - a): dst_a *= (1 - a)
      m.globalCompositeOperation = 'destination-in'
      m.globalAlpha = 1
      m.fillStyle = `rgba(0,0,0,${1 - a})`
      m.fillRect(0, 0, w, h)
      // 2) add a * current mask:  dst_a += src_a * a
      m.globalCompositeOperation = 'lighter'
      m.globalAlpha = a
      m.drawImage(maskImage, 0, 0, w, h)
    }
    m.globalAlpha = 1
    m.globalCompositeOperation = 'source-over'
  }

  // Person sharp, background blurred — using the TEMPORALLY-SMOOTHED mask and
  // FEATHERED edges so the cutout is stable and soft, not a hard/flickery line.
  _composite(results) {
    const { ctx, canvas } = this
    const w = canvas.width
    const h = canvas.height
    const feather = Math.max(2, Math.round(h / 200)) // soft edge, scales with size
    const bgBlur = this._bgBlurPx()

    this._accumulateMask(results.segmentationMask)

    ctx.save()
    ctx.clearRect(0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'
    // Feather the SMOOTHED mask so the alpha edge is a soft gradient.
    ctx.filter = `blur(${feather}px)`
    ctx.drawImage(this.maskCanvas, 0, 0, w, h)
    ctx.filter = 'none'
    // Keep the person only where the (smoothed, softened) mask is opaque.
    ctx.globalCompositeOperation = 'source-in'
    ctx.drawImage(results.image, 0, 0, w, h)
    // Blurred background behind, scaled up slightly so the blur doesn't darken
    // the frame edges, and a touch desaturated for a natural look.
    ctx.globalCompositeOperation = 'destination-over'
    ctx.filter = `blur(${bgBlur}px) saturate(0.9) brightness(0.96)`
    ctx.drawImage(results.image, -w * 0.04, -h * 0.04, w * 1.08, h * 1.08)
    ctx.filter = 'none'
    ctx.restore()
  }

  stop() {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try { if (this.seg && this.seg.close) this.seg.close() } catch { /* ignore */ }
    this.seg = null
    this.segReady = false
    if (this._out) for (const t of this._out.getVideoTracks()) t.stop()
    this._out = null
  }

  get outputStream() { return this._out }
}

window.CamPipe = CamPipe
