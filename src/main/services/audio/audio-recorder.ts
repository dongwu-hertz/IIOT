/**
 * AudioRecorder — accumulates one recording session's samples.
 *
 * WHY A GROWABLE STORE HERE, WHEN THE RING BUFFER IS FIXED
 * The two have opposite requirements. The Ring Buffer runs for hours and must
 * never allocate, so it discards the oldest data. A recording is bounded by the
 * user's intent and must never discard anything, so it grows — but amortised, by
 * doubling, which keeps total copying linear in the number of samples rather
 * than quadratic.
 *
 * DEFENSIVE BY DESIGN
 * Frames arrive from a WebSocket at ~10 Hz. The user can click "stop" at any
 * moment, so a frame WILL occasionally be in flight when the session ends.
 * `appendFrame` after `stop()` is therefore a no-op rather than an error: the
 * alternative is a crash caused by a race the user cannot perceive.
 */

import { concatSamples } from './pcm-utils'
import { decodePcmFrame } from './pcm-decoder'

export interface AudioRecorderOptions {
  sampleRate: number
  /** Verified as 1 for the device's audio stream. */
  channelCount: number
  /**
   * Optional cap on captured samples, so a session left running cannot consume
   * the disk. When reached, `isFull` becomes true and further frames are
   * dropped; the caller decides what to tell the user.
   */
  maxSamples?: number
}

export interface RecordingResult {
  samples: Float32Array
  durationMs: number
  sampleRate: number
  channelCount: number
  /** True when the cap was hit and later frames were discarded. */
  truncated: boolean
}

/** Initial allocation. One 100 ms frame at 96 kHz is 9600 samples; 10 s is 96000. */
const INITIAL_CAPACITY_SAMPLES = 96_000

export class AudioRecorder {
  private readonly sampleRate: number
  private readonly channelCount: number
  private readonly maxSamples: number

  /** Committed blocks. Kept separate so growth never copies audio already written. */
  private blocks: Float32Array[] = []
  /** Active block, filled before a new one is allocated. */
  private current: Float32Array
  private currentLength = 0
  private totalSamples = 0

  private startedAt = 0
  private recording = false
  private truncated = false

  constructor(options: AudioRecorderOptions) {
    this.sampleRate = Math.max(1, Math.floor(options.sampleRate))
    this.channelCount = Math.max(1, Math.floor(options.channelCount))
    this.maxSamples = options.maxSamples ?? Number.MAX_SAFE_INTEGER
    this.current = new Float32Array(Math.min(INITIAL_CAPACITY_SAMPLES, this.maxSamples))
  }

  get isRecording(): boolean {
    return this.recording
  }

  get sampleCount(): number {
    return this.totalSamples
  }

  /** True once the sample cap has been reached. */
  get isFull(): boolean {
    return this.truncated
  }

  /** Captured duration in milliseconds. */
  get elapsedMs(): number {
    if (this.startedAt === 0) return 0
    return (this.totalSamples / (this.sampleRate * this.channelCount)) * 1000
  }

  start(): void {
    this.blocks = []
    this.current = new Float32Array(Math.min(INITIAL_CAPACITY_SAMPLES, this.maxSamples))
    this.currentLength = 0
    this.totalSamples = 0
    this.startedAt = Date.now()
    this.recording = true
    this.truncated = false
  }

  /**
   * Append one block of already-decoded samples.
   *
   * A block that fits in the remaining space of the current allocation is copied
   * straight in. Otherwise the current block is sealed and a new one is
   * allocated at double the size — the amortisation that keeps total copying
   * linear.
   */
  appendFrame(samples: Float32Array): void
  /**
   * Append one raw WebSocket frame (Float32 LE, no header).
   *
   * Both forms are accepted because the live path hands over the frame exactly
   * as it arrived, while the alarm path already holds decoded blocks. Decoding
   * here rather than at each call site keeps the "misaligned view, no header"
   * knowledge in one place (`pcm-decoder.ts`) and makes the recording immune to
   * a caller that forgets it.
   */
  appendFrame(bytes: Uint8Array): void
  appendFrame(frame: Float32Array | Uint8Array): void {
    // Bail out BEFORE decoding: a frame still in flight when the user clicks
    // stop is the normal case, not an error, and it must cost nothing.
    if (!this.recording || this.truncated) return

    // `Float32Array` is not a `Uint8Array` (and vice versa), so this test is
    // unambiguous — including for a Node Buffer, which is a Uint8Array subclass
    // and must therefore take the decode path.
    const samples = frame instanceof Float32Array ? frame : decodePcmFrame(frame).samples
    if (samples.length === 0) return

    const remaining = this.maxSamples - this.totalSamples
    if (remaining <= 0) {
      this.truncated = true
      return
    }

    // Clip a block that would exceed the cap, so the cap is honoured exactly
    // rather than overshot by up to one frame.
    const block = samples.length > remaining ? samples.subarray(0, remaining) : samples
    if (samples.length > remaining) this.truncated = true

    let sourceOffset = 0
    while (sourceOffset < block.length) {
      const space = this.current.length - this.currentLength
      const take = Math.min(space, block.length - sourceOffset)

      this.current.set(block.subarray(sourceOffset, sourceOffset + take), this.currentLength)
      this.currentLength += take
      this.totalSamples += take
      sourceOffset += take

      // Sealed exactly: promote the block and start a bigger one.
      if (this.currentLength === this.current.length) {
        this.blocks.push(this.current)
        this.current = new Float32Array(
          Math.min(this.current.length * 2, Math.max(1, this.maxSamples - this.totalSamples))
        )
        this.currentLength = 0
      }
    }
  }

  /** Alias for `appendFrame`, for callers that think in raw bytes. */
  appendBytes(bytes: Uint8Array, decode: (bytes: Uint8Array) => Float32Array): void {
    this.appendFrame(decode(bytes))
  }

  /**
   * Finish the session and return everything captured.
   *
   * Idempotent-safe: a second call returns an empty result rather than throwing,
   * because the stop path can be reached from a button, a timer and app shutdown
   * within the same tick.
   */
  stop(): RecordingResult {
    if (!this.recording) {
      return {
        samples: new Float32Array(0),
        durationMs: 0,
        sampleRate: this.sampleRate,
        channelCount: this.channelCount,
        truncated: false
      }
    }

    this.recording = false

    // Flush the partial active block.
    const parts: Float32Array[] = [...this.blocks]
    if (this.currentLength > 0) {
      parts.push(this.current.subarray(0, this.currentLength))
    }

    // Drop the references so a long session's memory is released promptly rather
    // than held until the recorder is garbage collected.
    this.blocks = []
    this.current = new Float32Array(0)
    this.currentLength = 0

    return {
      samples: concatSamples(parts),
      durationMs: (this.totalSamples / (this.sampleRate * this.channelCount)) * 1000,
      sampleRate: this.sampleRate,
      channelCount: this.channelCount,
      truncated: this.truncated
    }
  }

  /**
   * Most recent `seconds` of captured audio, without ending the session.
   *
   * Used for an alarm clip taken from a live recording, so an alarm mid-session
   * does not require stopping the user's recording.
   */
  peekSeconds(seconds: number): Float32Array {
    const wanted = Math.min(
      this.totalSamples,
      Math.max(0, Math.floor(seconds * this.sampleRate * this.channelCount))
    )
    if (wanted === 0) return new Float32Array(0)

    const full = this.stoplessSnapshot()
    return full.subarray(full.length - wanted)
  }

  /** Snapshot without touching session state. */
  private stoplessSnapshot(): Float32Array {
    const parts: Float32Array[] = [...this.blocks]
    if (this.currentLength > 0) parts.push(this.current.subarray(0, this.currentLength))
    return concatSamples(parts)
  }
}
