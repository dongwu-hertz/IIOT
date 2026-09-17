/**
 * RIFF/WAVE parsing for downloaded alarm recordings.
 *
 * WHY THIS IS NOT JUST A CAST
 * The device serves recordings as `application/octet-stream`, so the client
 * cannot learn anything from the content type. The ONLY way to know what
 * arrived is to inspect the bytes — and getting it wrong is silent: a
 * misinterpreted buffer is still a valid buffer, it just produces noise.
 *
 * VERIFIED against real hardware: an alarm recording is
 *   RIFF/WAVE, `fmt ` chunk with audioFormat = 3 (IEEE Float),
 *   channels = 1, sampleRate = 96000, bits = 32,
 *   `data` chunk of 3,840,000 bytes = exactly 10.00 s.
 *
 * Note the payload is **32-bit float**, not 16-bit PCM, and it matches the live
 * `/audio_stream` encoding (Float32 LE) exactly. Feeding it to a 16-bit player
 * would render noise rather than fail, which is why this parser reports the
 * format instead of assuming it.
 *
 * Chunks are walked properly rather than assuming a 44-byte header: the tested
 * file contains `fact` and `PEAK` chunks between `fmt ` and `data`, so a
 * hard-coded offset would read metadata as audio.
 */

import type { DownloadedRecording } from '../device/protocol/dto'

/** Audio format tags from the WAVE specification. */
export const WAVE_FORMAT = {
  PCM: 1,
  IEEE_FLOAT: 3,
  ALAW: 6,
  MULAW: 7,
  EXTENSIBLE: 0xfffe
} as const

export interface WaveInfo {
  audioFormat: number
  channels: number
  sampleRate: number
  bitsPerSample: number
  byteRate: number
  blockAlign: number
  dataOffset: number
  dataBytes: number
  durationSeconds: number
}

const RIFF = 0x52494646 // "RIFF"
const WAVE = 0x57415645 // "WAVE"

/** Cheap check used to reject an HTML error page that arrived with HTTP 200. */
export function looksLikeWave(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getUint32(0, false) === RIFF && view.getUint32(8, false) === WAVE
}

/**
 * Parse the RIFF structure of a WAVE buffer.
 * Returns undefined when the payload is not a WAVE file at all.
 */
export function parseWave(bytes: Uint8Array): WaveInfo | undefined {
  if (!looksLikeWave(bytes)) return undefined

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12

  let format: Omit<WaveInfo, 'dataOffset' | 'dataBytes' | 'durationSeconds'> | undefined
  let dataOffset: number | undefined
  let dataBytes = 0

  // Walk the chunk list. Each chunk is [4-byte id][4-byte little-endian size][payload].
  while (offset + 8 <= bytes.length) {
    const id = view.getUint32(offset, false)
    const size = view.getUint32(offset + 4, true)
    const payload = offset + 8

    // 0x666d7420 = "fmt ", 0x64617461 = "data"
    if (id === 0x666d7420 && payload + 16 <= bytes.length) {
      format = {
        // Multi-byte numeric fields in RIFF are little-endian.
        audioFormat: view.getUint16(payload, true),
        channels: view.getUint16(payload + 2, true),
        sampleRate: view.getUint32(payload + 4, true),
        byteRate: view.getUint32(payload + 8, true),
        blockAlign: view.getUint16(payload + 12, true),
        // Guard against a short fmt chunk before reading past its end.
        bitsPerSample: size >= 16 && payload + 16 <= bytes.length ? view.getUint16(payload + 14, true) : 0
      }
    } else if (id === 0x64617461) {
      dataOffset = payload
      // A streamed or truncated file can declare more data than it delivered.
      dataBytes = Math.min(size, bytes.length - payload)
      break
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = payload + size + (size % 2)
  }

  if (!format || dataOffset === undefined) return undefined

  // Derive the frame size independently of the declared one, so a firmware that
  // reports blockAlign wrongly still yields a usable duration.
  const bytesPerSample = format.bitsPerSample > 0 ? format.bitsPerSample / 8 : 4
  const frameBytes = format.channels * bytesPerSample
  const durationSeconds =
    frameBytes > 0 ? dataBytes / (format.sampleRate * frameBytes) : 0

  return {
    ...format,
    dataOffset,
    dataBytes,
    durationSeconds
  }
}

/**
 * Turn a raw download response into a `DownloadedRecording`.
 *
 * Does NOT throw on a non-WAVE payload: the caller may be looking at the SPA's
 * index.html served with HTTP 200 (which is exactly what the specification's
 * wrong `/audio_file/` path returns), and reporting that as "downloaded, format
 * unrecognised" is far more useful than a generic parse error.
 */
export function parseWavePayload(bytes: Uint8Array, contentType: string): DownloadedRecording {
  const result: DownloadedRecording = {
    bytes,
    contentType,
    isWave: looksLikeWave(bytes)
  }

  const info = parseWave(bytes)
  if (!info) return result

  result.channels = info.channels
  result.sampleRate = info.sampleRate
  result.bitsPerSample = info.bitsPerSample
  result.audioFormat = info.audioFormat
  result.dataBytes = info.dataBytes
  result.durationSeconds = info.durationSeconds
  return result
}

/**
 * Decode a WAVE payload into normalised Float32 samples in [-1, 1].
 *
 * Handles both encodings the firmware might use, because they are not
 * interchangeable:
 *   - IEEE float (3): already normalised, used as-is;
 *   - integer PCM (1): divided by the type's full scale, with the asymmetry of
 *     two's complement accounted for (dividing by 32768 rather than 32767
 *     avoids clipping the negative extreme).
 *
 * Returns an empty array for an unsupported encoding rather than producing
 * garbage that would render as convincing-looking noise.
 */
export function decodeWaveToFloat32(bytes: Uint8Array): {
  samples: Float32Array
  info?: WaveInfo
  unsupportedReason?: string
} {
  const info = parseWave(bytes)
  if (!info) {
    return { samples: new Float32Array(0), unsupportedReason: 'NOT_A_WAVE_FILE' }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sampleCount =
    info.bitsPerSample > 0
      ? Math.floor(info.dataBytes / (info.bitsPerSample / 8))
      : Math.floor(info.dataBytes / 4)

  const samples = new Float32Array(sampleCount)
  const base = info.dataOffset

  switch (info.audioFormat) {
    case WAVE_FORMAT.IEEE_FLOAT: {
      if (info.bitsPerSample !== 32) {
        return {
          samples: new Float32Array(0),
          info,
          unsupportedReason: `FLOAT_${info.bitsPerSample}BIT_UNSUPPORTED`
        }
      }
      for (let index = 0; index < sampleCount; index += 1) {
        samples[index] = view.getFloat32(base + index * 4, true)
      }
      break
    }
    case WAVE_FORMAT.PCM: {
      if (info.bitsPerSample === 16) {
        for (let index = 0; index < sampleCount; index += 1) {
          samples[index] = view.getInt16(base + index * 2, true) / 32768
        }
      } else if (info.bitsPerSample === 32) {
        for (let index = 0; index < sampleCount; index += 1) {
          samples[index] = view.getInt32(base + index * 4, true) / 2147483648
        }
      } else if (info.bitsPerSample === 8) {
        // 8-bit WAV is UNSIGNED with a 128 offset, unlike 16/32-bit.
        for (let index = 0; index < sampleCount; index += 1) {
          samples[index] = (view.getUint8(base + index) - 128) / 128
        }
      } else {
        return {
          samples: new Float32Array(0),
          info,
          unsupportedReason: `PCM_${info.bitsPerSample}BIT_UNSUPPORTED`
        }
      }
      break
    }
    default:
      return {
        samples: new Float32Array(0),
        info,
        unsupportedReason: `AUDIO_FORMAT_${info.audioFormat}_UNSUPPORTED`
      }
  }

  return { samples, info }
}

/** Human-readable summary, used in logs and the Protocol Lab report. */
export function describeWave(info: WaveInfo): string {
  const formatName =
    info.audioFormat === WAVE_FORMAT.IEEE_FLOAT
      ? 'IEEE Float'
      : info.audioFormat === WAVE_FORMAT.PCM
        ? 'PCM'
        : `format ${info.audioFormat}`

  return (
    `WAV ${info.channels}ch ${info.sampleRate}Hz ${info.bitsPerSample}bit ${formatName}, ` +
    `${info.dataBytes} bytes, ${info.durationSeconds.toFixed(2)}s`
  )
}
