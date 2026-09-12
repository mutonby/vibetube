'use strict'

// Choose once per stream. Never silently change engines during a recording.
class CamPipe {
  start(stream, options = {}) {
    this.setup = this.initialize(stream, options)
    return this.setup.catch(async error => { await this.stop(); throw error })
  }
  async initialize(stream, options) {
    const native = options.blur && await window.studio?.matting?.available()
    if (this.stopped) return stream
    this.backend = native ? new window.MatAnyoneCamPipe() : new window.LiveKitCamPipe()
    this.engine = native ? 'matanyone2' : 'livekit-0.8.0'
    return this.backend.start(stream, options)
  }
  get stats() { return this.backend?.stats || { frames: 0, segmentationMs: 0 } }
  get previewSource() { return this.backend?.previewSource }
  get outputStream() { return this.backend?.outputStream }
  get effectEnabled() { return this.backend?.effectEnabled }
  get processor() { return this.backend?.processor }
  setBackground(value) { return this.backend.setBackground(value) }
  setBlur(value) { return this.backend.setBlur(value) }
  setBlurAmount(value) { return this.backend.setBlurAmount(value) }
  stop() {
    this.stopped = true
    this.backend?.stop()
    return this.cleanup ||= (async () => {
      await this.setup?.catch(() => {})
      await this.backend?.stop()
    })()
  }
}
window.CamPipe = CamPipe
