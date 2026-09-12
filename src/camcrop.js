'use strict'

// ----------------------------------------------------------------------------
// CamCrop — crop the webcam to an arbitrary rectangle before it is recorded.
//
// It takes a MediaStream (already blurred/composited by CamPipe, or the raw
// camera) and returns a NEW stream whose video is just the chosen sub-rectangle
// (audio is passed through untouched). The crop rect is normalised [0..1] over
// the source frame, so it's resolution-independent.
//
// Primary path = Insertable Streams with a rasterized crop: frame-driven,
// so it keeps producing frames while the recorder
// window is hidden during capture — the same reason CamPipe uses this API.
// Fallback path = a <canvas> + requestVideoFrameCallback compositor for engines
// without Insertable Streams.
//
// The crop only runs while recording (the main preview always shows the FULL
// frame with a draggable box on top), so there's no contention with the preview.
// ----------------------------------------------------------------------------

class CamCrop {
  constructor() {
    this.rect = { x: 0, y: 0, w: 1, h: 1 }
    this.srcW = 1280
    this.srcH = 720
    this.fps = 30
    this.outDims = null
    this._proc = null
    this._gen = null
    this._vid = null
    this._canvas = null
    this._rvfc = 0
    this._audio = null
  }

  // rect: { x, y, w, h } normalised in [0..1]. Returns the cropped MediaStream.
  start(inputStream, rect) {
    this.setRect(rect)
    const vtrack = inputStream.getVideoTracks()[0]
    if (!vtrack) return inputStream
    const s = vtrack.getSettings ? vtrack.getSettings() : {}
    this.srcW = s.width || this.srcW
    this.srcH = s.height || this.srcH
    this.fps = s.frameRate || this.fps
    this._audio = inputStream.getAudioTracks()[0] || null
    this.outDims = this._dims()

    if (window.MediaStreamTrackProcessor && window.MediaStreamTrackGenerator) {
      try { return this._startInsertable(vtrack) } catch (e) { console.warn('[camcrop] insertable streams falló, uso canvas:', e && e.message) }
    }
    return this._startCanvas(vtrack)
  }

  setRect(rect) {
    if (!rect) return
    const x = clamp01(rect.x), y = clamp01(rect.y)
    const w = clamp(rect.w, 0.02, 1 - x), h = clamp(rect.h, 0.02, 1 - y)
    this.rect = { x, y, w, h }
    this.outDims = this._dims()
  }

  _dims() {
    return { width: Math.max(2, Math.round(this.rect.w * this.srcW)), height: Math.max(2, Math.round(this.rect.h * this.srcH)) }
  }

  _startInsertable(track) {
    const proc = new MediaStreamTrackProcessor({ track })
    const gen = new MediaStreamTrackGenerator({ kind: 'video' })
    const canvas = new OffscreenCanvas(this.outDims.width, this.outDims.height)
    const ctx = canvas.getContext('2d', { alpha: false })
    this._canvas = canvas
    const self = this
    const ts = new TransformStream({
      transform(frame, ctrl) {
        const W = frame.displayWidth
        const H = frame.displayHeight
        const r = self.rect
        let x = Math.round(r.x * W), y = Math.round(r.y * H)
        let w = Math.round(r.w * W), h = Math.round(r.h * H)
        x = clamp(x, 0, W - 2); y = clamp(y, 0, H - 2)
        w = (clamp(w, 2, W - x)) & ~1; h = (clamp(h, 2, H - y)) & ~1
        try {
          // Materialize the pixels. Passing an RGBA texture with only a
          // visibleRect crop to MediaRecorder produced black VP9 frames.
          if (canvas.width !== w) canvas.width = w
          if (canvas.height !== h) canvas.height = h
          ctx.drawImage(frame, x, y, w, h, 0, 0, w, h)
          const cropped = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined })
          self.outDims = { width: w, height: h }
          ctrl.enqueue(cropped)
        } catch (e) {
          ctrl.error(e)
          window.dispatchEvent(new CustomEvent('camera-effect-error', { detail: 'Falló el recorte de cámara: ' + e.message }))
        } finally { frame.close() }
      },
    })
    this._abort = new AbortController()
    proc.readable.pipeThrough(ts, { signal: this._abort.signal }).pipeTo(gen.writable, { signal: this._abort.signal }).catch(() => {})
    this._proc = proc
    this._gen = gen
    const out = new MediaStream([gen])
    if (this._audio) out.addTrack(this._audio)
    return out
  }

  _startCanvas(track) {
    const v = document.createElement('video')
    v.muted = true; v.autoplay = true; v.playsInline = true
    v.srcObject = new MediaStream([track])
    v.play().catch(() => {})
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const self = this
    const draw = () => {
      const W = v.videoWidth || self.srcW
      const H = v.videoHeight || self.srcH
      const r = self.rect
      const w = Math.max(2, Math.round(r.w * W))
      const h = Math.max(2, Math.round(r.h * H))
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      try { ctx.drawImage(v, r.x * W, r.y * H, r.w * W, r.h * H, 0, 0, w, h) } catch { /* not ready */ }
      self.outDims = { width: w, height: h }
      self._rvfc = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(draw) : requestAnimationFrame(draw)
    }
    this._rvfc = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(draw) : requestAnimationFrame(draw)
    this._vid = v
    this._canvas = canvas
    const out = canvas.captureStream(this.fps || 30)
    if (this._audio) out.addTrack(this._audio)
    return out
  }

  stop() {
    // The readable is locked by the pipe: abort the pipe (cancel() would throw).
    if (this._abort) { try { this._abort.abort() } catch { /* ignore */ } this._abort = null }
    this._proc = null
    if (this._gen) { try { this._gen.stop() } catch { /* ignore */ } this._gen = null }
    if (this._vid) {
      if (this._rvfc && this._vid.cancelVideoFrameCallback) { try { this._vid.cancelVideoFrameCallback(this._rvfc) } catch { /* ignore */ } }
      else if (this._rvfc) { try { cancelAnimationFrame(this._rvfc) } catch { /* ignore */ } }
      this._vid.srcObject = null
      this._vid = null
    }
    this._canvas = null
    this._rvfc = 0
    this._audio = null
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
function clamp01(v) { return clamp(v, 0, 1) }

window.CamCrop = CamCrop
