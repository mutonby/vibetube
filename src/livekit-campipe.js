'use strict'

// LiveKit owns segmentation, rendering and frame scheduling. This adapter only
// manages app options and the tracks/elements that belong to the effect.
class LiveKitCamPipe {
  constructor() {
    this.blur = false
    this.blurAmount = 0.5
    this.bgImage = null
    this.stopped = false
    this.stats = { frames: 0, segmentationMs: 0 }
    this.updates = Promise.resolve()
  }

  start(stream, { blur = false, blurAmount = 0.5, background = null } = {}) {
    this.blur = blur
    this.blurAmount = Math.max(0, Math.min(1, Number(blurAmount) || 0))
    this.bgImage = background
    this.setup = this.initialize(stream)
    return this.setup.catch(async error => { await this.stop(); throw error })
  }

  async initialize(stream) {
    if (!this.blur) { this.output = stream; return stream }
    const library = window.LiveKitProcessors
    if (!library?.supportsBackgroundProcessors()) throw new Error('Los efectos de fondo no están disponibles')
    const base = new URL('vendor/livekit/', document.baseURI)
    this.source = stream.getVideoTracks()[0].clone()
    this.inputVideo = this.video(new MediaStream([this.source]))
    await this.inputVideo.play()
    if (this.stopped) return stream

    let firstFrame
    const ready = new Promise(resolve => { firstFrame = resolve })
    this.processor = library.BackgroundProcessor({
      mode: this.bgImage ? 'virtual-background' : 'background-blur',
      ...(this.bgImage ? { imagePath: this.bgImage } : { blurRadius: 6 + this.blurAmount * 54 }),
      assetPaths: {
        tasksVisionFileSet: new URL('wasm', base).href,
        modelAssetPath: new URL('selfie_segmenter.tflite', base).href,
      },
      onFrameProcessed: stats => {
        this.stats.frames++
        this.stats.segmentationMs += stats.segmentationTimeMs
        firstFrame()
      },
    })
    try { await this.processor.init({ kind: 'video', track: this.source, element: this.inputVideo }) }
    catch (error) { await this.processor.transformer.destroy(); throw error }
    if (this.stopped) return stream
    await this.update()
    this.output = new MediaStream([this.processor.processedTrack, ...stream.getAudioTracks()])
    // Consume the output before publishing it: LiveKit emits an unprocessed
    // warm-up frame. Display only once a processed frame exists.
    this.outputVideo = this.video(this.output)
    await this.outputVideo.play()
    if (this.effectEnabled) {
      let timer
      try { await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('El efecto de fondo no entrega vídeo')), 10000) })]) }
      finally { clearTimeout(timer) }
    }
    console.info('[campipe] LiveKit 0.8.0 activo')
    return this.output
  }

  video(stream) {
    const video = document.createElement('video')
    video.muted = true; video.playsInline = true; video.srcObject = stream
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none'
    document.body.appendChild(video)
    return video
  }

  get effectEnabled() { return this.blur && (!!this.bgImage || this.blurAmount > 0) }
  get previewSource() { return this.effectEnabled && this.stats.frames ? this.processor?.canvas : this.outputVideo }
  get outputStream() { return this.output }

  update() {
    // Serialize image loading so an older selection cannot replace a newer one.
    const options = {
      backgroundDisabled: !this.effectEnabled,
      imagePath: this.bgImage || undefined,
      blurRadius: this.bgImage ? this.blurAmount * 16 : 6 + this.blurAmount * 54,
    }
    this.updates = this.updates.catch(() => {}).then(() => {
      if (!this.stopped) return this.processor?.updateTransformerOptions(options)
    })
    return this.updates
  }

  setBackground(image) { this.bgImage = image || null; return this.update() }
  setBlur(on) { this.blur = !!on; return this.update() }
  setBlurAmount(value) {
    this.blurAmount = Math.max(0, Math.min(1, Number(value) || 0))
    return this.update()
  }

  stop() {
    this.stopped = true
    if (!this.cleanup) this.cleanup = (async () => {
      await this.setup?.catch(() => {})
      await this.updates.catch(() => {})
      this.source?.stop()
      try { await this.processor?.destroy() }
      finally {
        for (const video of [this.inputVideo, this.outputVideo]) {
          if (video) { video.pause(); video.srcObject = null; video.remove() }
        }
        this.processor = null; this.output = null
      }
    })().catch(error => console.warn('[campipe] cierre:', error.message))
    return this.cleanup
  }
}
window.LiveKitCamPipe = LiveKitCamPipe
