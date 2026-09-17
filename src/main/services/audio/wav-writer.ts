/**
 * WAV encoding for locally captured audio.
 *
 * FORMAT MATCHES THE DEVICE
 * Downloaded alarm recordings are verified as `audioFormat = 3` (IEEE Float),
 * 32-bit, mono. Captures written here use the SAME encoding, so a locally
 * recorded clip and a device clip are interchangeable in the player, in any
 * external analysis tool, and in the integrity hash the database stores.
 * Encoding to 16-bit PCM instead would silently quantise the audio and make the
 * two sources behave differently under analysis — a trap for whoever later
 * compares them.
 *
 * CHUNK LAYOUT
 * Includes a `fact` chunk, which the RIFF/WAVE specification requires for
 * non-PCM formats. The device's own files contain it, and some strict parsers
 * (including a few analysis tools) reject a float WAV without it.
 *
 * Byte-level correctness matters here more than usual: a WAV with wrong sizes
 * often still plays in tolerant players while being structurally invalid, so the
 * failure surfaces later, in someone else's tool.
 */

import { WAVE_FORMAT } from './wave-parser'

/** Format IDs used in the `fmt ` chunk. */
const BYTES_PER_FLOAT32 = 4
const BYTES_PER_INT16 = 2

export interface WavEncodeOptions {
  sampleRate: number
  channelCount: number
}

/**
 * Total byte length of a float32 WAV for the given sample count.
 *
 * Exposed separately so a caller can check free disk space BEFORE allocating:
 * 60 s of 8-channel 192 kHz float audio is ~368 MB, and discovering that by
 * running out of memory is not acceptable.
 */
export function float32WavByteLength(sampleCount: number): number {
  // RIFF(12) + fmt(8+16) + fact(8+4) + data header(8) = 56 bytes of structure.
  return 56 + sampleCount * BYTES_PER_FLOAT32
}

/** Same, for the 16-bit encoding. */
export function int16WavByteLength(sampleCount: number): number {
  return 44 + sampleCount * BYTES_PER_INT16
}

/**
 * Encode samples as a 32-bit IEEE-float WAV.
 *
 * Samples are written little-endian, matching both the device's files and the
 * live `/audio_stream` encoding.
 */
export function encodeFloat32Wav(samples: Float32Array, options: WavEncodeOptions): Uint8Array {
  const { sampleRate, channelCount } = normaliseOptions(options)
  const dataBytes = samples.length * BYTES_PER_FLOAT32
  const buffer = new ArrayBuffer(float32WavByteLength(samples.length))
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  let offset = 0

  offset = writeRiffHeader(view, bytes, offset, buffer.byteLength)
  offset = writeChunkHeader(bytes, offset, 'fmt ', 16)
  offset = writeFormatBody(view, offset, {
    audioFormat: WAVE_FORMAT.IEEE_FLOAT,
    channelCount,
    sampleRate,
    bitsPerSample: 32
  })

  // `fact` is mandatory for non-PCM formats; it records the sample-frame count.
  offset = writeChunkHeader(bytes, offset, 'fact', 4)
  view.setUint32(offset, samples.length / channelCount, true)
  offset += 4

  offset = writeChunkHeader(bytes, offset, 'data', dataBytes)
  for (let index = 0; index < samples.length; index += 1) {
    view.setFloat32(offset, samples[index] as number, true)
    offset += BYTES_PER_FLOAT32
  }

  return bytes
}

/**
 * Encode samples as 16-bit integer PCM.
 *
 * Provided for interoperability: some third-party analysis tools still cannot
 * read float WAV. Values are clamped to [-1, 1) first, because `Int16`
 * conversion of an out-of-range float wraps rather than saturates, which would
 * turn a loud transient into a burst of noise — the opposite of helpful in a
 * fault investigation.
 */
export function encodeInt16Wav(samples: Float32Array, options: WavEncodeOptions): Uint8Array {
  const { sampleRate, channelCount } = normaliseOptions(options)
  const dataBytes = samples.length * BYTES_PER_INT16
  const buffer = new ArrayBuffer(int16WavByteLength(samples.length))
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  let offset = 0
  offset = writeRiffHeader(view, bytes, offset, buffer.byteLength)
  offset = writeChunkHeader(bytes, offset, 'fmt ', 16)
  offset = writeFormatBody(view, offset, {
    audioFormat: WAVE_FORMAT.PCM,
    channelCount,
    sampleRate,
    bitsPerSample: 16
  })
  offset = writeChunkHeader(bytes, offset, 'data', dataBytes)

  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] as number
    const clamped = value > 1 ? 1 : value < -1 ? -1 : value
    // 32767 for the positive side, 32768 for the negative: using 32767 both ways
    // would make -1 unreachable and clip the loudest negative peaks.
    const scaled = clamped >= 0 ? clamped * 32767 : clamped * 32768
    view.setInt16(offset, Math.round(scaled), true)
    offset += BYTES_PER_INT16
  }

  return bytes
}

// ---------------------------------------------------------------------------
// Chunk writers
// ---------------------------------------------------------------------------

function normaliseOptions(options: WavEncodeOptions): {
  sampleRate: number
  channelCount: number
} {
  const sampleRate = Math.floor(options.sampleRate)
  const channelCount = Math.floor(options.channelCount)
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`Invalid sample rate for WAV encoding: ${options.sampleRate}`)
  }
  if (!Number.isFinite(channelCount) || channelCount <= 0) {
    throw new Error(`Invalid channel count for WAV encoding: ${options.channelCount}`)
  }
  return { sampleRate, channelCount }
}

/** `RIFF`, total size minus the first 8 bytes, then `WAVE`. */
function writeRiffHeader(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  totalBytes: number
): number {
  writeAscii(bytes, offset, 'RIFF')
  view.setUint32(offset + 4, totalBytes - 8, true)
  writeAscii(bytes, offset + 8, 'WAVE')
  return offset + 12
}

/** Four-character chunk id followed by its little-endian payload size. */
function writeChunkHeader(
  bytes: Uint8Array,
  offset: number,
  id: string,
  size: number
): number {
  writeAscii(bytes, offset, id)
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(offset + 4, size, true)
  return offset + 8
}

interface FormatBody {
  audioFormat: number
  channelCount: number
  sampleRate: number
  bitsPerSample: number
}

/** The 16-byte `fmt ` payload. */
function writeFormatBody(view: DataView, offset: number, body: FormatBody): number {
  const bytesPerSample = body.bitsPerSample / 8
  view.setUint16(offset, body.audioFormat, true)
  view.setUint16(offset + 2, body.channelCount, true)
  view.setUint32(offset + 4, body.sampleRate, true)
  view.setUint32(offset + 8, body.sampleRate * body.channelCount * bytesPerSample, true)
  view.setUint16(offset + 12, body.channelCount * bytesPerSample, true)
  view.setUint16(offset + 14, body.bitsPerSample, true)
  return offset + 16
}

/** Write a 4-character ASCII id (no terminator). */
function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < 4; index += 1) {
    bytes[offset + index] = text.charCodeAt(index) & 0xff
  }
}
