/**
 * Tests for the PCM numerical primitives.
 *
 * WHY THESE MATTER DISPROPORTIONATELY
 * Every downstream audio feature — the level meter, the oscilloscope trace, the
 * Ring Buffer, the recorder, the WAV encoder — is built on these four
 * functions. A bug here does not throw; it produces plausible-looking audio
 * data. An operator investigating a transformer fault would then be reading a
 * chart that is subtly lying about what the device heard.
 *
 * The decimation test is the important one: `extractWaveform` must preserve
 * transients, because a partial-discharge click lasts a handful of samples and
 * would disappear into a bucket mean.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  computeFrameStats,
  concatSamples,
  extractWaveform,
  isSilent,
  readFloat32Le
} from '../src/main/services/audio/pcm-utils'

/**
 * Compare a Float32 value against a decimal literal.
 *
 * 0.1 is not exactly representable in binary floating point, so a Float32
 * round-trip yields 0.10000000149011612 and a strict comparison fails. Asserting
 * exact equality on float data is a test bug, not a code bug.
 */
function approx(actual: number, expected: number, epsilon = 1e-9): boolean {
  return Math.abs(actual - expected) <= epsilon
}

/** Build a byte buffer of Float32 LE samples. */
function toBytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setFloat32(index * 4, value, true))
  return bytes
}

/** Build a view of `values` that starts at a NON-ZERO offset in a larger buffer. */
function toOffsetBytes(values: readonly number[], offset: number): Uint8Array {
  const inner = toBytes(values)
  const padded = new Uint8Array(inner.length + offset)
  // Fill the padding with a recognisable decoy so a wrong read is detectable
  // rather than accidentally correct.
  padded.fill(0xaa, 0, offset)
  padded.set(inner, offset)
  return padded.subarray(offset)
}

describe('readFloat32Le', () => {
  it('reads little-endian float samples', () => {
    const samples = readFloat32Le(toBytes([0, 0.5, -0.5, 1, -1]))
    assert.equal(samples.length, 5)
    // 0.5 and -0.5 are exact in binary; 0 and +/-1 likewise.
    assert.equal(samples[0], 0)
    assert.equal(samples[1], 0.5)
    assert.equal(samples[2], -0.5)
    assert.equal(samples[3], 1)
    assert.equal(samples[4], -1)
  })

  it('reads correctly from a non-zero byteOffset', () => {
    // THE ALIGNMENT TRAP. A Uint8Array coming from a WebSocket frame can be a
    // view into a larger ArrayBuffer at a non-zero offset. Constructing
    // `new Float32Array(bytes.buffer)` would read the decoy padding instead,
    // and the result would still be valid floats.
    for (const offset of [1, 2, 3, 5, 7, 64]) {
      // All three values are exact binary fractions, so equality is safe here.
      const view = toOffsetBytes([0.25, -0.75, 1.5], offset)
      const samples = readFloat32Le(view)
      assert.equal(samples.length, 3, `offset ${offset}`)
      assert.equal(samples[0], 0.25, `offset ${offset}: first sample`)
      assert.equal(samples[1], -0.75, `offset ${offset}: second sample`)
      assert.equal(samples[2], 1.5, `offset ${offset}: third sample`)
    }
  })

  it('drops a trailing partial sample instead of throwing', () => {
    // A connection dropped mid-frame is normal, not exceptional.
    const bytes = toBytes([0.5, 0.25])
    const truncated = bytes.subarray(0, 6) // 1.5 samples
    const samples = readFloat32Le(truncated)
    assert.equal(samples.length, 1)
    assert.equal(samples[0], 0.5)
  })

  it('returns an empty array for input shorter than one sample', () => {
    assert.equal(readFloat32Le(new Uint8Array(0)).length, 0)
    assert.equal(readFloat32Le(new Uint8Array(3)).length, 0)
  })

  it('handles the real 38400-byte frame geometry', () => {
    // The verified frame size: 9600 Float32 samples = 100 ms at 96 kHz.
    const bytes = new Uint8Array(38_400)
    const samples = readFloat32Le(bytes)
    assert.equal(samples.length, 9600)
  })

  it('preserves special float values rather than mangling them', () => {
    const bytes = new Uint8Array(12)
    const view = new DataView(bytes.buffer)
    view.setFloat32(0, Number.POSITIVE_INFINITY, true)
    view.setFloat32(4, Number.NEGATIVE_INFINITY, true)
    view.setFloat32(8, Number.NaN, true)
    const samples = readFloat32Le(bytes)
    assert.equal(samples[0], Number.POSITIVE_INFINITY)
    assert.equal(samples[1], Number.NEGATIVE_INFINITY)
    assert.ok(Number.isNaN(samples[2]))
  })
})

describe('computeFrameStats', () => {
  it('computes peak and RMS for a known signal', () => {
    // A full-scale square wave: every sample is +/- 1, so RMS is exactly 1.
    const stats = computeFrameStats(new Float32Array([1, -1, 1, -1]))
    assert.equal(stats.peak, 1)
    assert.ok(Math.abs(stats.rms - 1) < 1e-9)
  })

  it('computes RMS for a sine wave as amplitude/sqrt(2)', () => {
    const amplitude = 0.5
    const samples = new Float32Array(1000)
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = amplitude * Math.sin((index / samples.length) * Math.PI * 2)
    }
    const stats = computeFrameStats(samples)
    assert.ok(Math.abs(stats.peak - amplitude) < 0.01)
    assert.ok(Math.abs(stats.rms - amplitude / Math.SQRT2) < 0.01)
  })

  it('reports zero for silence', () => {
    const stats = computeFrameStats(new Float32Array(512))
    assert.equal(stats.peak, 0)
    assert.equal(stats.rms, 0)
  })

  it('reports zero for empty input rather than NaN', () => {
    // Math.sqrt(0/0) would be NaN, which renders as a broken meter.
    const stats = computeFrameStats(new Float32Array(0))
    assert.equal(stats.peak, 0)
    assert.equal(stats.rms, 0)
    assert.ok(!Number.isNaN(stats.rms))
  })

  it('uses magnitude, so a negative extreme counts as the peak', () => {
    const stats = computeFrameStats(new Float32Array([0.1, -0.9, 0.2]))
    // Tolerance, not equality: Float32(-0.9) is -0.8999999761581421.
    assert.ok(approx(stats.peak, 0.9, 1e-6), `peak=${stats.peak}`)
  })

  it('does not overflow on a large block', () => {
    const samples = new Float32Array(9600).fill(0.5)
    const stats = computeFrameStats(samples)
    assert.ok(Math.abs(stats.rms - 0.5) < 1e-6)
  })
})

describe('extractWaveform', () => {
  it('preserves a single-sample transient', () => {
    // THE REASON THIS FUNCTION EXISTS. A partial-discharge click occupies a few
    // samples. Averaging the bucket would erase it; taking the extreme keeps it.
    const samples = new Float32Array(1000)
    samples[500] = 0.95
    const waveform = extractWaveform(samples, 100)
    const maximum = Math.max(...waveform.map(Math.abs))
    assert.ok(maximum > 0.9, `transient was smoothed away: max=${maximum}`)
  })

  it('preserves the SIGN of the extreme sample', () => {
    // A rectified envelope would render as a symmetric blob, losing the shape
    // an operator reads.
    const samples = new Float32Array(100)
    samples[10] = -0.8
    samples[60] = 0.6
    const waveform = extractWaveform(samples, 10)
    assert.ok(waveform.some((value) => value < -0.7), 'negative transient lost')
    assert.ok(waveform.some((value) => value > 0.5), 'positive transient lost')
  })

  it('produces exactly the requested number of buckets', () => {
    for (const buckets of [1, 7, 64, 128, 1000]) {
      const waveform = extractWaveform(new Float32Array(9600), buckets)
      assert.equal(waveform.length, buckets, `buckets=${buckets}`)
    }
  })

  it('returns the samples unchanged when there are fewer than the bucket count', () => {
    // Padding with zeros would render as a spurious drop to silence.
    const samples = new Float32Array([0.1, 0.2, 0.3])
    const waveform = extractWaveform(samples, 128)
    assert.equal(waveform.length, 3)
    // Compared with tolerance: these values are not exact in binary float.
    waveform.forEach((value, index) => {
      assert.ok(approx(value, [0.1, 0.2, 0.3][index] as number, 1e-7), `bucket ${index}`)
    })
  })

  it('returns an empty array for empty input or a non-positive bucket count', () => {
    assert.deepEqual(extractWaveform(new Float32Array(0), 64), [])
    assert.deepEqual(extractWaveform(new Float32Array(10), 0), [])
    assert.deepEqual(extractWaveform(new Float32Array(10), -5), [])
    assert.deepEqual(extractWaveform(new Float32Array(10), Number.NaN), [])
  })

  it('covers the whole input range without skipping the tail', () => {
    // A transient in the LAST bucket must survive; an off-by-one in the bucket
    // boundary calculation would drop it.
    const samples = new Float32Array(1000)
    samples[999] = 0.9
    const waveform = extractWaveform(samples, 10)
    assert.ok(Math.abs(waveform[9] as number) > 0.8, 'tail sample was not covered')
  })

  it('handles a real frame size at the UI bucket count', () => {
    const samples = new Float32Array(9600)
    samples[4800] = -1
    const waveform = extractWaveform(samples, 128)
    assert.equal(waveform.length, 128)
    assert.ok(Math.min(...waveform) <= -1)
  })
})

describe('concatSamples', () => {
  it('joins blocks in order', () => {
    const merged = concatSamples([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([4, 5])])
    assert.deepEqual(Array.from(merged), [1, 2, 3, 4, 5])
  })

  it('handles the empty and single cases without copying', () => {
    assert.equal(concatSamples([]).length, 0)
    const single = new Float32Array([1, 2, 3])
    assert.equal(concatSamples([single]), single, 'a single block should not be copied')
  })

  it('preserves a pre-alarm + post-alarm join', () => {
    // The spec's alarm model is pre 10 s + post 20 s; this is how they combine.
    const pre = new Float32Array(9600).fill(0.1) // 100 ms at 96 kHz
    const post = new Float32Array(19_200).fill(0.2)
    const merged = concatSamples([pre, post])
    assert.equal(merged.length, 28_800)
    assert.ok(approx(merged[0] as number, 0.1, 1e-7))
    assert.ok(approx(merged[9599] as number, 0.1, 1e-7))
    assert.ok(approx(merged[9600] as number, 0.2, 1e-7))
    assert.ok(approx(merged[28_799] as number, 0.2, 1e-7))
  })
})

describe('isSilent', () => {
  it('detects a fully silent block', () => {
    assert.equal(isSilent(new Float32Array(512)), true)
  })

  it('detects a live block', () => {
    const samples = new Float32Array(512)
    samples[300] = 0.001
    assert.equal(isSilent(samples), false)
  })

  it('treats sub-threshold noise as silent', () => {
    const samples = new Float32Array(512).fill(1e-9)
    assert.equal(isSilent(samples), true)
  })

  it('reports an empty block as silent', () => {
    assert.equal(isSilent(new Float32Array(0)), true)
  })
})
