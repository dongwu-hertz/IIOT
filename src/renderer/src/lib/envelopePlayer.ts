/**
 * 包络回放器 —— WebAudio 那一层适配（实时监测页与相机声学面板共用）。
 *
 * 为什么与 `audioPreview.ts` 分成两个文件
 * `audioPreview.ts` 里是**纯函数**（重采样与"浅队列"的时刻计算）和它们的常量，
 * 那个文件不碰任何浏览器对象，所以单测可以在 node 里直接跑。
 * 这个文件碰 `AudioContext`，node 里造不出来 —— 分开之后，"能测的"与"只能靠人听的"
 * 有一道明确的边界，而不是混在一个文件里让单测只能测一半。
 *
 * 一个实例对应一块面板：`close()` 之后必须重新 `resume()` 才能再用。
 */
import {
  DEFAULT_VOLUME_PERCENT,
  resampleEnvelope,
  scheduleStartTime
} from '@renderer/lib/audioPreview'

export class EnvelopePlayer {
  private context: AudioContext | null = null
  private gain: GainNode | null = null
  private nextStartTime = 0
  /** 0..1；`setVolume()` 之前排进队列的声音也会被它改。 */
  private volume = DEFAULT_VOLUME_PERCENT / 100
  /**
   * 自动增益的滚动峰值（2026-09-23「播放没声音」修复）。
   *
   * 实测：AE08 `/audio_stream` 的 float32 是**物理量级**的小数（±1e-4 上下，
   * 约 −80 dBFS），不是归一化满量程——照原值播就是事实上的静音。这里按滚动峰值
   * 把信号抬到约 −6 dBFS（0.5）：峰值本身慢衰减（×0.98/帧），增益不会随单个
   * 瞬态上下泵。只影响"听到的响度"，不改变波形的相对形状；波形图显示的仍是
   * 原始值，两件事不混。
   */
  private peakTrack = 0

  /** 在当前手势里创建/唤醒 AudioContext。创建失败（没有输出设备）由调用方报告。 */
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

  /** 暂停（保留 context 与增益设置，再次 `resume()` 不必重建）。 */
  async suspend(): Promise<void> {
    if (this.context && this.context.state === 'running') await this.context.suspend()
  }

  /** 彻底释放；之后这个实例不可再用。 */
  async close(): Promise<void> {
    const context = this.context
    this.context = null
    this.gain = null
    this.nextStartTime = 0
    if (context) await context.close()
  }

  get isRunning(): boolean {
    return this.context !== null && this.context.state === 'running'
  }

  /**
   * 设置音量（百分比，0..100）。
   *
   * 允许在未 `resume()` 时调用：值会记住，`resume()` 建增益节点时用上 ——
   * 否则"先调音量再按播放"会被回退成默认音量。
   */
  setVolume(percent: number): void {
    const clamped = Math.min(100, Math.max(0, percent))
    this.volume = clamped / 100
    if (this.gain) this.gain.gain.value = this.volume
  }

  /** 当前音量（百分比），供界面回显。 */
  get volumePercent(): number {
    return Math.round(this.volume * 100)
  }

  /**
   * 排一帧包络。
   *
   * 未运行时**直接丢弃**（不缓存）：这是"实时预览"，攒着等以后再放没有意义，
   * 而且会让"按下播放"之后先听到几秒钟前的声音。
   */
  push(waveform: readonly number[], frameMs: number): void {
    const context = this.context
    const gain = this.gain
    if (!context || !gain || context.state !== 'running' || waveform.length === 0) return

    const duration = Math.max(0.02, frameMs / 1000)
    const length = Math.max(2, Math.round(context.sampleRate * duration))
    const buffer = context.createBuffer(1, length, context.sampleRate)
    const resampled = resampleEnvelope(waveform, length)

    // 自动增益（见 `peakTrack` 的注释）：物理量级的小幅值信号不抬就是静音。
    let framePeak = 0
    for (const value of resampled) {
      const magnitude = Math.abs(value)
      if (magnitude > framePeak) framePeak = magnitude
    }
    this.peakTrack = Math.max(framePeak, this.peakTrack * 0.98)
    const scale = this.peakTrack > 1e-9 ? Math.min(1000, Math.max(0.1, 0.5 / this.peakTrack)) : 1
    if (scale !== 1) {
      for (let index = 0; index < resampled.length; index += 1) resampled[index] = (resampled[index] ?? 0) * scale
    }
    buffer.copyToChannel(resampled, 0)

    const now = context.currentTime
    const start = scheduleStartTime(this.nextStartTime, now)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(gain)
    source.start(start)
    this.nextStartTime = start + duration
  }
}
