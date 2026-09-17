/**
 * Tests for the RIFF/WAVE parser.
 *
 * WHY THIS FILE EXISTS
 * A misparsed audio buffer does not fail — it produces NOISE. Every failure mode
 * here (wrong data offset, wrong sample width, wrong encoding) yields a buffer
 * that plays, looks plausible in a waveform view, and is completely wrong. On an
 * acoustic monitoring tool that is worse than a crash, because an operator would
 * draw conclusions from it.
 *
 * The fixtures below mirror the REAL device output, verified by download:
 *   RIFF/WAVE, audioFormat=3 (IEEE Float), channels=1, sampleRate=96000,
 *   bits=32, with `fact` and `PEAK` chunks BETWEEN `fmt ` and `data`.
 *
 * That last detail is the one that matters most: a parser that assumes a
 * 44-byte header reads metadata as audio, and the test below catches exactly
 * that by placing the data chunk at a non-standard offset.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  decodeWaveToFloat32,
  describeWave,
  looksLikeWave,
  parseWave,
  parseWavePayload,
  WAVE_FORMAT
} from '../src/main/services/audio/wave-parser'

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

interface Chunk {
  id: string
  payload: Uint8Array
}

function buildWave(chunks: Chunk[], formatTag = WAVE_FORMAT.IEEE_FLOAT): Uint8Array {
  const parts: Uint8Array[] = []
  for (const chunk of chunks) {
    const header = new Uint8Array(8)
    const view = new DataView(header.buffer)
    for (let index = 0; index < 4; index += 1) {
      header[index] = chunk.id.charCodeAt(index)
    }
    view.setUint32(4, chunk.payload.length, true)
    parts.push(header, chunk.payload)
    // Word alignment: an odd-sized chunk gets a pad byte.
    if (chunk.payload.length % 2 === 1) parts.push(new Uint8Array(1))
  }

  const bodyLength = parts.reduce((sum, part) => sum + part.length, 0)
  const total = 12 + bodyLength
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)

  for (let index = 0; index < 4; index += 1) out[index] = 'RIFF'.charCodeAt(index)
  view.setUint32(4, total - 8, true)
  for (let index = 0; index < 4; index += 1) out[8 + index] = 'WAVE'.charCodeAt(index)

  let offset = 12
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }

  void formatTag
  return out
}

function fmtChunk(options: {
  audioFormat: number
  channels: number
  sampleRate: number
  bitsPerSample: number
}): Chunk {
  const payload = new Uint8Array(16)
  const view = new DataView(payload.buffer)
  const bytesPerSample = options.bitsPerSample / 8
  view.setUint16(0, options.audioFormat, true)
  view.setUint16(2, options.channels, true)
  view.setUint32(4, options.sampleRate, true)
  view.setUint32(8, options.sampleRate * options.channels * bytesPerSample, true)
  view.setUint16(12, options.channels * bytesPerSample, true)
  view.setUint16(14, options.bitsPerSample, true)
  return { id: 'fmt ', payload }
}

function float32Data(samples: readonly number[]): Chunk {
  const payload = new Uint8Array(samples.length * 4)
  const view = new DataView(payload.buffer)
  samples.forEach((sample, index) => view.setFloat32(index * 4, sample, true))
  return { id: 'data', payload }
}

function int16Data(samples: readonly number[]): Chunk {
  const payload = new Uint8Array(samples.length * 2)
  const view = new DataView(payload.buffer)
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true))
  return { id: 'data', payload }
}

/**
 * The real device layout: 96 kHz mono 32-bit float, with `fact` and `PEAK`
 * chunks inserted before `data`.
 */
function deviceLikeWave(samples = 9600): Uint8Array {
  const values = Array.from({ length: samples }, (_unused, index) =>
    Math.sin((index / samples) * Math.PI * 8) * 0.5
  )
  return buildWave([
    fmtChunk({ audioFormat: WAVE_FORMAT.IEEE_FLOAT, channels: 1, sampleRate: 96000, bitsPerSample: 32 }),
    { id: 'fact', payload: new Uint8Array([0, 0, 0, 0]) },
    { id: 'PEAK', payload: new Uint8Array(16) },
    float32Data(values)
  ])
}

// ---------------------------------------------------------------------------

describe('looksLikeWave', () => {
  it('accepts a WAVE buffer', () => {
    assert.equal(looksLikeWave(deviceLikeWave(4)), true)
  })

  it('rejects the SPA index.html that a wrong URL returns with HTTP 200', () => {
    // This is the exact failure the specification's `/audio_file/` path produced.
    const html = new TextEncoder().encode('<!DOCTYPE html><html><head><title>404')
    assert.equal(looksLikeWave(html), false)
  })

  it('rejects short and empty buffers', () => {
    assert.equal(looksLikeWave(new Uint8Array(0)), false)
    assert.equal(looksLikeWave(new Uint8Array(11)), false)
  })

  it('rejects a RIFF container that is not WAVE', () => {
    const avi = new Uint8Array(12)
    avi.set(new TextEncoder().encode('RIFF'), 0)
    avi.set(new TextEncoder().encode('AVI '), 8)
    assert.equal(looksLikeWave(avi), false)
  })
})

describe('parseWave', () => {
  it('parses the real device layout with extra chunks before data', () => {
    const info = parseWave(deviceLikeWave(9600))
    assert.ok(info)
    assert.equal(info.audioFormat, WAVE_FORMAT.IEEE_FLOAT)
    assert.equal(info.channels, 1)
    assert.equal(info.sampleRate, 96_000)
    assert.equal(info.bitsPerSample, 32)
    assert.equal(info.dataBytes, 9600 * 4)
    assert.equal(info.durationSeconds, 0.1)
  })

  it('finds the data chunk even when it is NOT at offset 44', () => {
    // The regression that matters: a hard-coded header length would silently
    // treat the `fact`/`PEAK` metadata as audio.
    const info = parseWave(deviceLikeWave(100))
    assert.ok(info)
    assert.ok(
      info.dataOffset > 44,
      `expected data past a bare 44-byte header, got ${info.dataOffset}`
    )
    assert.equal(info.dataBytes, 400)
  })

  it('derives duration from the data size, not the declared byte rate', () => {
    // A firmware lying about byteRate must not distort the reported duration.
    const bytes = deviceLikeWave(9600)
    const view = new DataView(bytes.buffer)
    const info = parseWave(bytes)
    assert.ok(info)
    // Zero out byteRate inside the fmt chunk to prove it is not used.
    view.setUint32(12 + 8 + 8, 0, true)
    const reparsed = parseWave(bytes)
    assert.equal(reparsed?.durationSeconds, 0.1)
  })

  it('handles 16-bit PCM', () => {
    const bytes = buildWave([
      fmtChunk({ audioFormat: WAVE_FORMAT.PCM, channels: 2, sampleRate: 48000, bitsPerSample: 16 }),
      int16Data([0, 1000, -1000, 2000])
    ])
    const info = parseWave(bytes)
    assert.ok(info)
    assert.equal(info.channels, 2)
    assert.equal(info.bitsPerSample, 16)
    assert.equal(info.dataBytes, 8)
    // 4 samples across 2 channels = 2 frames at 48 kHz.
    assert.ok(Math.abs((info.durationSeconds ?? 0) - 2 / 48000) < 1e-9)
  })

  it('returns undefined for a non-WAVE payload instead of throwing', () => {
    assert.equal(parseWave(new TextEncoder().encode('<html></html>')), undefined)
  })

  it('returns undefined when there is no data chunk', () => {
    const bytes = buildWave([
      fmtChunk({ audioFormat: WAVE_FORMAT.PCM, channels: 1, sampleRate: 8000, bitsPerSample: 16 })
    ])
    assert.equal(parseWave(bytes), undefined)
  })

  it('clamps a data size that exceeds the delivered bytes', () => {
    // A truncated download must not report a duration longer than the audio.
    const bytes = deviceLikeWave(100)
    const view = new DataView(bytes.buffer)
    // Find and corrupt the data chunk size to claim far more than was sent.
    const info = parseWave(bytes)
    assert.ok(info)
    view.setUint32(info.dataOffset - 4, 10_000_000, true)
    const reparsed = parseWave(bytes)
    assert.ok(reparsed)
    assert.equal(reparsed.dataBytes, 400)
  })
})

describe('decodeWaveToFloat32', () => {
  it('round-trips IEEE float samples', () => {
    const values = [0, 0.5, -0.5, 1, -1]
    const bytes = buildWave([
      fmtChunk({ audioFormat: WAVE_FORMAT.IEEE_FLOAT, channels: 1, sampleRate: 96000, bitsPerSample: 32 }),
      float32Data(values)
    ])
    const { samples, info, unsupportedReason } = decodeWaveToFloat32(bytes)
    assert.equal(unsupportedReason, undefined)
    assert.equal(info?.audioFormat, WAVE_FORMAT.IEEE_FLOAT)
    assert.equal(samples.length, values.length)
    values.forEach((expected, index) => {
      assert.ok(Math.abs(samples[index]! - expected) < 1e-6, `sample ${index}`)
    })
  })

  it('normalises 16-bit PCM by 32768, not 32767', () => {
    // Dividing by 32767 would push the most negative sample above -1.0, which
    // clips. Dividing by 32768 maps the full two's-complement range exactly.
    const bytes = buildWave([
      fmtChunk({ audioFormat: WAVE_FORMAT.PCM, channels: 1, sampleRate: 8000, bitsPerSample: 16 }),
      int16Data([0, 16384, -16384, -32768])
    ])
    const { samples } = decodeWaveToFloat32(bytes)
    assert.equal(samples[0], 0)
    assert.equal(samples[1], 0.5)
    assert.equal(samples[2], -0.5)
    assert.equal(samples[3], -1)
  })

  it('treats 8-bit WAV as unsigned with a 128 offset', () => {
    // 8-bit PCM is the one width that is NOT two's complement in WAV.
    const payload = new Uint8Array([128, 255, 0])
    const bytes = buildWave([
      fmtChunk({ audioFormat: WAVE_FORMAT.PCM, channels: 1, sampleRate: 8000, bitsPerSample: 8 }),
      { id: 'data', payload }
    ])
    const { samples } = decodeWaveToFloat32(bytes)
    assert.equal(samples[0], 0)
    assert.ok(Math.abs(samples[1]! - 0.9921875) < 1e-6)
    assert.equal(samples[2], -1)
  })

  it('reports an unsupported encoding rather than emitting garbage', () => {
    const bytes = buildWave([
      fmtChunk({ audioFormat: WAVE_FORMAT.MULAW, channels: 1, sampleRate: 8000, bitsPerSample: 8 }),
      { id: 'data', payload: new Uint8Array(64) }
    ])
    const { samples, unsupportedReason } = decodeWaveToFloat32(bytes)
    assert.equal(samples.length, 0)
    assert.match(unsupportedReason ?? '', /AUDIO_FORMAT_7_UNSUPPORTED/)
  })

  it('rejects a float payload that is not 32-bit', () => {
    const bytes = buildWave([
      fmtChunk({ audioFormat: WAVE_FORMAT.IEEE_FLOAT, channels: 1, sampleRate: 8000, bitsPerSample: 64 }),
      { id: 'data', payload: new Uint8Array(64) }
    ])
    const { samples, unsupportedReason } = decodeWaveToFloat32(bytes)
    assert.equal(samples.length, 0)
    assert.match(unsupportedReason ?? '', /FLOAT_64BIT_UNSUPPORTED/)
  })

  it('does not silently return samples for a non-WAVE buffer', () => {
    const { samples, unsupportedReason } = decodeWaveToFloat32(
      new TextEncoder().encode('<!DOCTYPE html>')
    )
    assert.equal(samples.length, 0)
    assert.equal(unsupportedReason, 'NOT_A_WAVE_FILE')
  })
})

describe('parseWavePayload', () => {
  it('reports the format of a real download', () => {
    const result = parseWavePayload(deviceLikeWave(9600), 'application/octet-stream')
    assert.equal(result.isWave, true)
    assert.equal(result.channels, 1)
    assert.equal(result.sampleRate, 96_000)
    assert.equal(result.bitsPerSample, 32)
    assert.equal(result.audioFormat, WAVE_FORMAT.IEEE_FLOAT)
    assert.equal(result.durationSeconds, 0.1)
  })

  it('surfaces a wrong-URL HTML response as "not a wave file" rather than throwing', () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><html><head><title>404 Not Found')
    const result = parseWavePayload(html, 'text/html')
    assert.equal(result.isWave, false)
    assert.equal(result.channels, undefined)
    assert.equal(result.contentType, 'text/html')
  })
})

describe('describeWave', () => {
  it('produces a readable one-line summary', () => {
    const info = parseWave(deviceLikeWave(9600))
    assert.ok(info)
    const text = describeWave(info)
    assert.match(text, /1ch/)
    assert.match(text, /96000Hz/)
    assert.match(text, /32bit/)
    assert.match(text, /IEEE Float/)
  })
})
