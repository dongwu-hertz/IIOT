export class PcmStreamPlayer {
  private context: AudioContext | null = null
  private gain: GainNode | null = null
  private nextStartTime = 0
  private volume = 0.8
  private peakTrack = 0

  async resume(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext()
      this.gain = this.context.createGain()
      this.gain.gain.value = this.volume
      this.gain.connect(this.context.destination)
    }
    if (this.context.state === 'suspended') await this.context.resume()
    this.nextStartTime = this.context.currentTime
  }

  async suspend(): Promise<void> {
    if (this.context && this.context.state === 'running') await this.context.suspend()
  }

  async close(): Promise<void> {
    const context = this.context
    this.context = null
    this.gain = null
    this.nextStartTime = 0
    if (context) await context.close()
  }

  setVolume(percent: number): void {
    this.volume = Math.min(100, Math.max(0, percent)) / 100
    if (this.gain) this.gain.gain.value = this.volume
  }

  push(samples: readonly number[], sampleRate: number): void {
    const context = this.context
    const gain = this.gain
    if (!context || !gain || context.state !== 'running' || samples.length === 0) return
    const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 20_000
    const buffer = context.createBuffer(1, samples.length, rate)
    const channel = buffer.getChannelData(0)

    let peak = 0
    for (let index = 0; index < samples.length; index += 1) {
      const value = samples[index] ?? 0
      channel[index] = value
      peak = Math.max(peak, Math.abs(value))
    }
    this.peakTrack = Math.max(peak, this.peakTrack * 0.985)
    const scale = this.peakTrack > 1e-7 ? Math.min(20, Math.max(0.5, 0.5 / this.peakTrack)) : 1
    if (scale !== 1) {
      for (let index = 0; index < channel.length; index += 1) channel[index] = (channel[index] ?? 0) * scale
    }

    const now = context.currentTime
    if (this.nextStartTime < now - 0.25) this.nextStartTime = now
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(gain)
    source.start(this.nextStartTime)
    this.nextStartTime += buffer.duration
  }
}