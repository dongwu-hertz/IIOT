/**
 * Frame-level PCM decoding for the realtime audio stream.
 *
 * A thin layer over `pcm-utils`: it exists so callers can say "decode this
 * device frame" in one call instead of composing the primitives themselves and
 * getting the channel arithmetic wrong.
 *
 * VERIFIED GEOMETRY (docs/PROTOCOL-FINDINGS 4.3): `/audio_stream` frames are raw
 * Float32 little-endian, SINGLE channel, 100 ms each. At 96 kHz that is exactly
 * 38400 bytes — the constant size observed on real hardware. Monitoring N
 * channels needs N connections, so one frame here is always one channel's audio;
 * N channels means N decoders, not one interleaved decoder.
 *
 * THE ALIGNMENT TRAP
 * A `Uint8Array` handed over by a WebSocket is a VIEW into a larger
 * `ArrayBuffer` and may start at a non-zero `byteOffset` that is not a multiple
 * of 4. `new Float32Array(bytes.buffer)` ignores `byteOffset` and decodes the
 * wrong bytes — producing plausible-looking noise rather than an error.
 * `readFloat32Le` uses a `DataView` over the correct window instead.
 *
 * Frame DURATION is deliberately NOT returned: it is a property of the stream
 * geometry (100 ms measured), not of the payload, and deriving it from a byte
 * count would report a firmware framing change as a duration change. Use
 * `expectedFrameBytes` / `checkFrameGeometry` to verify the geometry instead.
 */

import { computeFrameStats, readFloat32Le, type PcmFrameStats } from './pcm-utils'

export interface DecodedPcmFrame extends PcmFrameStats {
  /** Every complete sample in wire order. */
  samples: Float32Array
  /**
   * Complete interleaved frames present in `samples`.
   *
   * Equal to `samples.length` for the measured mono stream. It is REPORTED
   * rather than enforced so that no audio is ever silently discarded: a consumer
   * that needs whole frames can compare `samples.length` with
   * `frameCount * channelCount` and decide for itself.
   */
  frameCount: number
  /**
   * Tail bytes that did not complete a sample and were ignored.
   *
   * A dropped connection truncates the final frame, which is normal rather than
   * exceptional, so this is reported for the caller to log instead of being
   * thrown. Non-zero on a healthy connection means the stream is misframed and
   * is worth a warning.
   */
  trailingBytes: number
  /** Convenience flag for `trailingBytes > 0`. */
  truncated: boolean
}

/**
 * Decode one raw streaming frame.
 *
 * @param bytes Payload exactly as received; may be a misaligned view.
 * @param channelCount Samples per interleaved frame. Verified as 1 for the
 *   device's audio stream; explicit so a firmware change cannot silently turn
 *   interleaved audio into a burst of aliased noise.
 */
export function decodePcmFrame(bytes: Uint8Array, channelCount = 1): DecodedPcmFrame {
  const channels = normaliseChannelCount(channelCount)
  const samples = readFloat32Le(bytes)
  const stats = computeFrameStats(samples)
  const trailingBytes = bytes.byteLength - samples.length * 4

  return {
    samples,
    peak: stats.peak,
    rms: stats.rms,
    frameCount: Math.floor(samples.length / channels),
    trailingBytes,
    truncated: trailingBytes > 0
  }
}

/**
 * A bad channel count must not divide by zero or throw inside a WebSocket
 * callback; falling back to mono keeps audio flowing, and the geometry is read
 * from the device anyway.
 */
function normaliseChannelCount(channelCount: number): number {
  if (!Number.isFinite(channelCount)) return 1
  const channels = Math.floor(channelCount)
  return channels >= 1 ? channels : 1
}

/**
 * Expected byte length of one frame for a sample rate.
 *
 * Used to sanity-check an incoming frame: a mismatch means either the firmware
 * changed or the sample rate we read is stale, and either way the derived
 * frequency axis would be wrong.
 */
export function expectedFrameBytes(sampleRate: number, channelCount = 1, frameMs = 100): number {
  return Math.round((sampleRate * frameMs) / 1000) * 4 * channelCount
}

/**
 * Whether a frame matches the expected geometry.
 * Returns the deviation in bytes so a caller can log something actionable.
 */
export function checkFrameGeometry(
  byteLength: number,
  sampleRate: number,
  channelCount = 1
): { matches: boolean; expected: number; deviation: number } {
  const expected = expectedFrameBytes(sampleRate, channelCount)
  return { matches: byteLength === expected, expected, deviation: byteLength - expected }
}

// Re-exported so an audio consumer has ONE import for the frame-shaped and
// sample-shaped primitives, rather than reaching into two modules for one job.
export { readFloat32Le, computeFrameStats, extractWaveform, concatSamples, isSilent } from './pcm-utils'
export type { PcmFrameStats } from './pcm-utils'
