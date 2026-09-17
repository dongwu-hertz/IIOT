/**
 * Low-level PCM helpers.
 *
 * WHY THIS LAYER IS SEPARATE FROM THE DECODER ABOVE IT
 * `pcm-decoder.ts` owns the higher-level "decode a frame and describe it"
 * operation and may grow device-specific handling. These two functions are pure
 * numerical primitives with no protocol knowledge at all, which makes them
 * trivially testable and safe to reuse from the stream services, the recorder
 * and the playback path alike.
 *
 * THE ENCODING, MEASURED: `/audio_stream` delivers raw Float32 little-endian
 * samples with no file header and no per-frame metadata, single channel,
 * 100 ms per frame. There is nothing to detect — the format is known — so the
 * only real risks are byte alignment and destructive decimation, both of which
 * are handled below.
 */

/**
 * Statistics for one PCM frame.
 * `peak` drives the level meter's instantaneous bar; `rms` drives its average,
 * which is what correlates with perceived loudness.
 */
export interface PcmFrameStats {
  /** Largest absolute sample value. 0 for silence. */
  peak: number
  /** Root-mean-square amplitude — the perceptually meaningful level. */
  rms: number
}

/**
 * Read a byte range as Float32 little-endian samples.
 *
 * Uses `DataView` rather than `new Float32Array(bytes.buffer)` for a specific
 * reason: a `Uint8Array` produced from a WebSocket frame can be a VIEW into a
 * larger `ArrayBuffer` at a non-zero `byteOffset`. Constructing a typed array
 * from `.buffer` alone would silently read the wrong bytes, and the result
 * would still be valid floats — noise that looks like audio.
 *
 * A trailing partial sample (byte length not divisible by 4) is dropped rather
 * than throwing: a connection dropped mid-frame is normal, not exceptional.
 */
export function readFloat32Le(bytes: Uint8Array): Float32Array {
  const sampleCount = Math.floor(bytes.byteLength / 4)
  const samples = new Float32Array(sampleCount)
  if (sampleCount === 0) return samples

  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 4)
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getFloat32(index * 4, true)
  }
  return samples
}

/** Peak and RMS of a sample block, in one pass. */
export function computeFrameStats(samples: Float32Array): PcmFrameStats {
  if (samples.length === 0) return { peak: 0, rms: 0 }

  let peak = 0
  let sumSquares = 0

  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] as number
    const magnitude = value < 0 ? -value : value
    if (magnitude > peak) peak = magnitude
    sumSquares += value * value
  }

  return { peak, rms: Math.sqrt(sumSquares / samples.length) }
}

/**
 * Downsample to `buckets` points for oscilloscope display.
 *
 * EACH BUCKET RETURNS THE SAMPLE OF LARGEST MAGNITUDE, NOT THE MEAN.
 *
 * This is the whole point of the function. Averaging a bucket is a low-pass
 * filter, and the transients it removes are precisely what an acoustic alarm
 * investigation is trying to see — a partial-discharge click occupies a handful
 * of samples and would vanish into a mean. Preserving the extreme keeps the
 * envelope honest at the cost of a slightly jagged trace, which is the correct
 * trade for this application.
 *
 * The sign is preserved, so the result still reads as a waveform rather than a
 * rectified envelope.
 *
 * @param samples Source samples.
 * @param buckets Desired output length. Values <= 0 yield an empty array.
 */
export function extractWaveform(samples: Float32Array, buckets: number): number[] {
  if (!Number.isFinite(buckets) || buckets <= 0) return []
  if (samples.length === 0) return []

  const target = Math.floor(buckets)

  // Fewer samples than buckets: return them as-is rather than padding with
  // zeros, which would render as a spurious drop to silence.
  if (samples.length <= target) return Array.from(samples)

  const output = new Array<number>(target)
  const bucketSize = samples.length / target

  for (let bucket = 0; bucket < target; bucket += 1) {
    const start = Math.floor(bucket * bucketSize)
    // `max(start + 1, ...)` guarantees progress even if bucketSize rounds down,
    // so a bucket is never empty and every output slot is written.
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((bucket + 1) * bucketSize)))

    let extreme = samples[start] as number
    let extremeMagnitude = extreme < 0 ? -extreme : extreme

    for (let index = start + 1; index < end; index += 1) {
      const value = samples[index] as number
      const magnitude = value < 0 ? -value : value
      if (magnitude > extremeMagnitude) {
        extreme = value
        extremeMagnitude = magnitude
      }
    }

    output[bucket] = extreme
  }

  return output
}

/** Concatenate sample blocks, used to join pre-alarm and post-alarm captures. */
export function concatSamples(blocks: readonly Float32Array[]): Float32Array {
  if (blocks.length === 0) return new Float32Array(0)
  if (blocks.length === 1) return blocks[0] as Float32Array

  let total = 0
  for (const block of blocks) total += block.length

  const merged = new Float32Array(total)
  let offset = 0
  for (const block of blocks) {
    merged.set(block, offset)
    offset += block.length
  }
  return merged
}

/** True when every sample is zero — used to label a dead channel in the UI. */
export function isSilent(samples: Float32Array, threshold = 1e-7): boolean {
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] as number
    if (value > threshold || value < -threshold) return false
  }
  return true
}
