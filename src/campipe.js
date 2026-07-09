'use strict'

// ----------------------------------------------------------------------------
// CamPipe — thin wrapper around @vpalmisano/virtual-background (vendored in
// vendor/vb/) for real-time background blur on the webcam track.
//
// The heavy lifting happens inside the library: MediaPipe ImageSegmenter
// (selfie_multiclass model) + a WebGL shader pipeline with temporal smoothing
// and smoothstep edge thresholding, delivered through MediaStreamTrack
// Insertable Streams (MediaStreamTrackProcessor). That replaces the old
// hand-rolled canvas-2D compositor + captureStream loop, which produced
// flickery edges, halos and judder in recordings.
//
// Frames are driven by the camera track itself (not page timers), so the
// pipeline keeps running while the recorder window is hidden during capture.
//
// Fail-safe: if the library is missing or errors, start() returns the raw
// stream unprocessed so recording/preview never break.
// ----------------------------------------------------------------------------

class CamPipe {
  constructor() {
    this.input = null
    this.blur = false
    this.blurAmount = 0.5   // 0..1 intensity (UI slider): blur sigma, or bokeh of the virtual bg
    this.bgImage = null     // data: URL of the virtual background image (null = blur mode)
    this._bgTimer = null    // throttle for re-rendering the bokeh while dragging the slider
    this._processed = null  // processed video track (owned by us)
    this._out = null
  }

  _applyOptions() {
    const vb = window.VirtualBackground
    if (!vb || !vb.options) return
    // The library's default asset paths are relative to the DOCUMENT (its demo
    // ships index.html next to mediapipe/). Our pages live in src/ with the
    // assets under src/vendor/vb/, so they must be absolute or segmentation
    // fails with a bare error Event (silent 404 of the wasm loader).
    const base = new URL('vendor/vb/', location.href).href
    vb.options.wasmLoaderPath = base + 'mediapipe/tasks-vision/wasm/vision_wasm_internal.js'
    vb.options.wasmBinaryPath = base + 'mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm'
    vb.options.modelPath = base + 'mediapipe/models/selfie_multiclass_256x256.tflite'
    const amt = this.blur ? this.blurAmount : 0
    if (this.bgImage) {
      // VIRTUAL BACKGROUND mode. bgBlur must be 0: its shader branch returns
      // early and would hide the background image. bgBlurRadius stays >0
      // because borderSmooth reuses it as its kernel radius — a soft border
      // blend between person and image is what sells the composite as real.
      vb.options.enabled = this.blur
      vb.options.bgBlur = 0
      vb.options.bgBlurRadius = 10
      vb.options.borderSmooth = 4
    } else {
      // BLUR mode. bgBlur = gaussian SIGMA in px (demo range 0-100) +
      // bgBlurRadius = kernel extent in px. NOT `blur`, which is a whole-image
      // filter — setting it with no backgroundUrl made the shader sample an
      // empty background texture (the solid blue frame). A sub-1 sigma weights
      // every non-center tap to ~zero → invisible blur, hence the px mapping.
      // amt=0 must fully DISABLE the effect: with bgBlur=0 but enabled=true
      // the shader falls through to virtual-background compositing and paints
      // the empty background texture (solid blue).
      vb.options.enabled = amt > 0
      vb.options.borderSmooth = 0
      vb.options.bgBlur = amt > 0 ? Math.round(6 + amt * 54) : 0
      vb.options.bgBlurRadius = amt > 0 ? Math.round(16 + amt * 74) : 0
      if (vb.options.backgroundUrl) vb.options.backgroundUrl = ''
    }
  }

  // Set (or clear) the virtual background image. The slider becomes the
  // BOKEH control: the image is pre-blurred on a canvas, which fakes camera
  // depth-of-field — the single most effective realism trick, and it also
  // hides small segmentation-edge imperfections.
  async setBackground(dataUrl) {
    this.bgImage = dataUrl || null
    await this._refreshBackground()
  }

  async _refreshBackground() {
    const vb = window.VirtualBackground
    if (!vb || !vb.options) return
    if (!this.bgImage) { this._applyOptions(); return }
    let url = this.bgImage
    const px = Math.round(this.blurAmount * 16)
    if (px > 0) {
      try { url = await this._bokeh(this.bgImage, px) } catch { /* use the sharp image */ }
    }
    this._applyOptions()
    vb.options.backgroundUrl = url
  }

  async _bokeh(src, px) {
    const img = new Image()
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src })
    const w = Math.min(img.naturalWidth || 1920, 1920)
    const h = Math.round(w * (img.naturalHeight / img.naturalWidth)) || 1080
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const x = c.getContext('2d')
    // draw scaled up slightly so the blur doesn't bleed transparent borders in
    const s = 1 + (px * 2) / Math.min(w, h)
    x.filter = `blur(${px}px)`
    x.drawImage(img, (w - w * s) / 2, (h - h * s) / 2, w * s, h * s)
    return c.toDataURL('image/jpeg', 0.92)
  }

  async start(stream, { blur = false, blurAmount, background } = {}) {
    this.input = stream
    this.blur = !!blur
    if (typeof blurAmount === 'number') this.blurAmount = Math.max(0, Math.min(1, blurAmount))
    this.bgImage = background || null
    if (!this.blur || !window.VirtualBackground) {
      this._out = stream
      return stream
    }
    try {
      await this._refreshBackground() // applies options; loads bg image if set
      const videoTrack = stream.getVideoTracks()[0]
      this._processed = await window.VirtualBackground.processVideoTrack(videoTrack)
      const out = new MediaStream()
      out.addTrack(this._processed)
      const audio = stream.getAudioTracks()[0]
      if (audio) out.addTrack(audio)
      this._out = out
      console.info('[campipe] blur activo: virtual-background (WebGL + multiclass)')
      return out
    } catch (e) {
      try {
        console.warn('[campipe] virtual-background falló, cámara sin blur:',
          (e && (e.message || e.reason || e.type)) || String(e),
          e && e.stack ? `\n${e.stack}` : '',
          e && typeof e === 'object' ? JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 500) : '')
      } catch { console.warn('[campipe] virtual-background falló (error no serializable)') }
      this._processed = null
      this._out = stream
      return stream
    }
  }

  setBlur(on) {
    this.blur = !!on
    this._applyOptions()
  }

  setBlurAmount(v) {
    this.blurAmount = Math.max(0, Math.min(1, Number(v)))
    if (this.bgImage) {
      // re-render the bokeh, throttled so dragging the slider doesn't queue
      // dozens of full-size canvas re-encodes
      if (this._bgTimer) clearTimeout(this._bgTimer)
      this._bgTimer = setTimeout(() => { this._bgTimer = null; this._refreshBackground() }, 180)
    } else {
      this._applyOptions()
    }
  }

  stop() {
    if (this._bgTimer) { clearTimeout(this._bgTimer); this._bgTimer = null }
    if (this._processed) {
      try { this._processed.stop() } catch { /* ignore */ }
      this._processed = null
    }
    this._out = null
    this.input = null
  }

  get outputStream() { return this._out }
}

window.CamPipe = CamPipe
