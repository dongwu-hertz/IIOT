/**
 * Fixed-capacity PCM ring buffer — the pre-alarm capture window.
 *
 * WHY A FIXED BACKING STORE
 * This buffer runs continuously for hours at ~10 frames/s. An implementation
 * built from an array of chunks would allocate on every push and eventually
 * hand the garbage collector a multi-megabyte compaction on a timer, which shows
 * up as periodic UI stutter. A single pre-allocated `Float32Array` with a write
 * head makes each push O(1) with zero allocation.
 *
 * MEMORY MODEL — spec 4.2 and 4.3
 * Audio is memory-first by design; nothing here is persisted. At the spec's
 * default of 60 s and the tested device's 96 kHz single channel that is
 * 60 × 96000 × 4 B ≈ 22 MB. The quadratic cost of buffering MANY channels is
 * exactly why the specification limits the Ring Buffer to the active channel:
 * 8 channels at 192 kHz for 60 s would be ~3.7 GB.
 *
 * CONCURRENCY
 * Used only from the Electron main process event loop, which is single
 * threaded, so no locking is needed. This is stated explicitly because the
 * class would NOT be safe to share with a worker thread as written — the write
 * head is not atomic.
 */

export interface RingBufferOptions {
  sampleRate: number
  /** Verified as 1 for the device's audio stream; kept explicit for other firmware. */
  channelCount: number
  /** Depth in seconds. Data older than this is discarded. */
  capacitySeconds: number
}

/** Everything currently held, oldest first. */
export interface RingBufferSnapshot {
  samples: Float32Array
  /** Wall-clock time of the first retained sample. */
  startTime: number
  /** Wall-clock time of the last retained sample. */
  endTime: number
}

export class PcmRingBuffer {
  private readonly store: Float32Array
  private readonly sampleRate: number
  private readonly channelCount: number
  private readonly capacitySamples: number

  /** Index of the next slot to write. */
  private writeIndex = 0
  /** Total samples written since construction, including overwritten ones. */
  private totalWritten = 0

  /** Wall-clock timestamps bounding the retained window. */
  private firstSampleTime = 0
  private lastSampleTime = 0

  constructor(options: RingBufferOptions) {
    const sampleRate = Math.max(1, Math.floor(options.sampleRate))
    const channelCount = Math.max(1, Math.floor(options.channelCount))
    const capacitySeconds = Math.max(0, options.capacitySeconds)

    this.sampleRate = sampleRate
    this.channelCount = channelCount
    // `capacitySeconds` is a DURATION, so the sample count must scale with the
    // channel count: for an interleaved stereo feed, one second is
    // `sampleRate x 2` samples. Leaving it out would silently give a stereo
    // buffer half the window it advertises (`durationSeconds` below divides by
    // the channel count, so the two must agree).
    this.capacitySamples = Math.max(1, Math.floor(sampleRate * capacitySeconds * channelCount))
    this.store = new Float32Array(this.capacitySamples)
  }

  /** Capacity in samples (not frames). */
  get capacity(): number {
    return this.capacitySamples
  }

  /** How many samples are currently retained. */
  get sampleCount(): number {
    return Math.min(this.totalWritten, this.capacitySamples)
  }

  /** Retained duration in seconds. */
  get durationSeconds(): number {
    return this.sampleCount / (this.sampleRate * this.channelCount)
  }

  get startTime(): number {
    return this.firstSampleTime
  }

  get endTime(): number {
    return this.lastSampleTime
  }

  /**
   * Append a block, overwriting the oldest data once full.
   *
   * @param timestamp Arrival time of the block's first sample. Defaults to now,
   *   which is correct for live capture but should be supplied when replaying.
   */
  push(samples: Float32Array, timestamp = Date.now()): void {
    if (samples.length === 0) return

    if (this.sampleCount === 0) {
      this.firstSampleTime = timestamp
    }

    // A block larger than the whole buffer can only be handled by keeping its
    // tail — writing it verbatim would leave stale data interleaved with new.
    if (samples.length >= this.capacitySamples) {
      this.store.set(samples.subarray(samples.length - this.capacitySamples))
      this.writeIndex = 0
      this.totalWritten += samples.length
      this.lastSampleTime = timestamp + this.blockDurationMs(samples.length)
      this.recomputeStartTime()
      return
    }

    const firstChunk = Math.min(samples.length, this.capacitySamples - this.writeIndex)
    this.store.set(samples.subarray(0, firstChunk), this.writeIndex)

    // Wrap: the remainder goes back to the start of the store.
    if (firstChunk < samples.length) {
      this.store.set(samples.subarray(firstChunk), 0)
    }

    this.writeIndex = (this.writeIndex + samples.length) % this.capacitySamples
    this.totalWritten += samples.length
    this.lastSampleTime = timestamp + this.blockDurationMs(samples.length)
    this.recomputeStartTime()
  }

  /**
   * A copy of everything retained, oldest first.
   *
   * Returns a COPY rather than a view: the caller may hand it to a WAV encoder
   * or hold it while more frames arrive, and a live view would mutate underneath
   * them — producing a file whose contents do not match its declared length.
   */
  snapshot(): RingBufferSnapshot {
    const count = this.sampleCount
    if (count === 0) {
      return { samples: new Float32Array(0), startTime: 0, endTime: 0 }
    }

    const output = new Float32Array(count)

    if (count < this.capacitySamples || this.totalWritten <= this.capacitySamples) {
      // Not yet wrapped: the retained data starts at index 0.
      output.set(this.store.subarray(0, count))
    } else {
      // Wrapped: oldest data begins at the write head.
      const tail = this.capacitySamples - this.writeIndex
      output.set(this.store.subarray(this.writeIndex), 0)
      output.set(this.store.subarray(0, this.writeIndex), tail)
    }

    return { samples: output, startTime: this.firstSampleTime, endTime: this.lastSampleTime }
  }

  /**
   * The most recent `seconds` of retained audio.
   *
   * Used for the spec's pre-alarm capture (§4.3). Asking for more than is held
   * returns everything available rather than padding with silence — silence at
   * the head of an alarm clip would look like the channel went quiet just before
   * the event, which is a false reading.
   */
  snapshotSeconds(seconds: number): RingBufferSnapshot {
    const full = this.snapshot()
    if (seconds <= 0 || full.samples.length === 0) {
      return { samples: new Float32Array(0), startTime: 0, endTime: 0 }
    }

    const wanted = Math.min(
      full.samples.length,
      Math.floor(seconds * this.sampleRate * this.channelCount)
    )
    if (wanted >= full.samples.length) return full

    const samples = full.samples.subarray(full.samples.length - wanted)
    // Slide the start time forward by however much was dropped.
    const droppedMs = this.blockDurationMs(full.samples.length - wanted)
    return { samples, startTime: full.startTime + droppedMs, endTime: full.endTime }
  }

  /** Discard everything. Frees nothing (the store is reused), which is intended. */
  clear(): void {
    this.store.fill(0)
    this.writeIndex = 0
    this.totalWritten = 0
    this.firstSampleTime = 0
    this.lastSampleTime = 0
  }

  // -------------------------------------------------------------------------

  /** Duration of `sampleCount` samples, in milliseconds. */
  private blockDurationMs(sampleCount: number): number {
    return (sampleCount / (this.sampleRate * this.channelCount)) * 1000
  }

  /**
   * Derive the start time from the write head once the buffer has wrapped.
   *
   * Recomputed after each push so `startTime` stays meaningful without keeping
   * a parallel timestamp ring — the arithmetic is trivial and this runs once per
   * 100 ms frame.
   */
  private recomputeStartTime(): void {
    if (this.totalWritten <= this.capacitySamples) {
      // Still filling: the window starts at the arrival time of sample 0, which
      // `push` recorded on the first call.
      return
    }
    const retained = this.capacitySamples
    this.firstSampleTime = this.lastSampleTime - this.blockDurationMs(retained)
  }
}
