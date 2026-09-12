'use strict'

// MediaRecorder stamps generated video when it arrives, even when VideoFrame
// retains the capture timestamp. Match microphone timing to measured camera
// processing latency. The input microphone/mix remains owned by the caller.
class RecordingAudioSync {
  async start(track, getLatencyMs) {
    this.context = new AudioContext({ latencyHint: 'interactive' })
    await this.context.resume()
    this.source = this.context.createMediaStreamSource(new MediaStream([track]))
    this.delay = this.context.createDelay(2)
    this.destination = this.context.createMediaStreamDestination()
    this.source.connect(this.delay).connect(this.destination)
    const seconds = () => Math.max(0, Math.min(2, (getLatencyMs() || 0) / 1000))
    this.delay.delayTime.value = seconds()
    this.delayTotalMs = 0; this.delaySamples = 0
    this.timer = setInterval(() => {
      this.delayTotalMs += this.delay.delayTime.value * 1000; this.delaySamples++
      this.delay.delayTime.setTargetAtTime(seconds(), this.context.currentTime, .5)
    }, 250)
    // Fill the delay line before MediaRecorder chooses its first audio packet.
    await new Promise(resolve => setTimeout(resolve, seconds() * 1000 + 50))
    return this.destination.stream.getAudioTracks()[0]
  }
  get delayMs() { return this.delaySamples ? this.delayTotalMs / this.delaySamples : this.delay.delayTime.value * 1000 }
  stop() {
    clearInterval(this.timer)
    this.source?.disconnect(); this.delay?.disconnect()
    this.destination?.stream.getTracks().forEach(track => track.stop())
    this.context?.close().catch(() => {})
  }
}
window.RecordingAudioSync = RecordingAudioSync
