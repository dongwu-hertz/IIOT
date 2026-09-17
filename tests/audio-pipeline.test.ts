/**
 * End-to-end tests for the audio pipeline: decode -> buffer -> record -> save.
 *
 * WHY THIS FILE EXISTS
 * Every failure mode in this pipeline is SILENT. A misaligned Float32 decode
 * yields noise that looks like audio; a decimation bug deletes exactly the
 * transient an investigator is looking for; a ring buffer with an off-by-one
 * write head returns the oldest data while claiming to return the newest; a WAV
 * with a wrong size still plays in a tolerant player while being structurally
 * invalid; a saved row with an absolute path breaks the day the storage root
 * moves. None of those throw. All of them are asserted below.
 *
 * The fixture geometry mirrors the measured device (docs/PROTOCOL-FINDINGS 4.3):
 * raw Float32 little-endian frames, MONO, 100 ms each, 38400 bytes at 96 kHz.
 *
 * The storage-backed tests use a real temporary directory and a real in-memory
 * SQLite database rather than mocks: the rules under test (atomic write,
 * root-relative path, SHA-256 of the bytes on disk, disk-floor guard) live in
 * the interaction between those layers, so mocking them would test nothing.
 */

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { Database as SqliteDatabase } from 'better-sqlite3'

import {
  decodePcmFrame,
  expectedFrameBytes,
  extractWaveform,
  isSilent
} from '../src/main/services/audio/pcm-decoder'
import { PcmRingBuffer } from '../src/main/services/audio/ring-buffer'
import { AudioRecorder } from '../src/main/services/audio/audio-recorder'
import {
  encodeFloat32Wav,
  encodeInt16Wav,
  float32WavByteLength,
  int16WavByteLength
} from '../src/main/services/audio/wav-writer'
import {
  decodeWaveToFloat32,
  parseWave,
  WAVE_FORMAT
} from '../src/main/services/audio/wave-parser'
import {
  AudioRecordingService,
  DEFAULT_POST_ALARM_SECONDS,
  DEFAULT_PRE_ALARM_SECONDS
} from '../src/main/services/audio/recording-service'
import { openDatabase } from '../src/main/services/database/schema'
import { RecordingRepository } from '../src/main/services/database/alarm-repository'
import { DeviceRepository } from '../src/main/services/database/device-repository'
import { StorageService } from '../src/main/services/storage/storage-service'
import { AppError, ErrorCodes } from '../src/shared/errors'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Compare two float values with a tolerance, since Float32 is not decimal. */
function approx(actual: number, expected: number, epsilon = 1e-9): boolean {
  return Math.abs(actual - expected) <= epsilon
}

/**
 * Build a Float32 LE byte buffer, optionally preceded by padding bytes so the
 * resulting view can be deliberately misaligned.
 */
function float32Bytes(values: readonly number[], leadingPadding = 0): Uint8Array {
  const bytes = new Uint8Array(leadingPadding + values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setFloat32(leadingPadding + index * 4, value, true))
  return bytes
}

/** A block whose every sample encodes its own global index — an order probe. */
function rampBlock(start: number, length: number): Float32Array {
  const block = new Float32Array(length)
  for (let index = 0; index < length; index += 1) block[index] = start + index
  return block
}

/** Walk the RIFF chunk list and return the chunk ids in order. */
function chunkIds(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ids: string[] = []
  let offset = 12

  while (offset + 8 <= bytes.byteLength) {
    let id = ''
    for (let index = 0; index < 4; index += 1) {
      id += String.fromCharCode(view.getUint8(offset + index))
    }
    const size = view.getUint32(offset + 4, true)
    ids.push(id)
    // Chunks are word-aligned: an odd payload is followed by a pad byte.
    offset += 8 + size + (size % 2)
  }

  return ids
}

// ---------------------------------------------------------------------------
// PCM decoding
// ---------------------------------------------------------------------------

describe('decodePcmFrame', () => {
  it('decodes raw Float32 little-endian samples', () => {
    const values = [0, 0.5, -0.5, 1, -1, 0.125]
    const frame = decodePcmFrame(float32Bytes(values))
    assert.equal(frame.samples.length, values.length)
    values.forEach((expected, index) => {
      assert.ok(approx(frame.samples[index] ?? NaN, expected, 1e-9), `sample ${index}`)
    })
  })

  it('decodes a misaligned view instead of reading the wrong bytes', () => {
    // THE ALIGNMENT TRAP. A WebSocket hands over a Uint8Array that may be a view
    // into a larger ArrayBuffer at a byteOffset that is not a multiple of 4.
    // `new Float32Array(bytes.buffer)` would ignore the offset entirely and
    // decode the padding as audio — plausible-looking noise, not an error.
    const values = [0.25, -0.75, 0.5]
    const backing = float32Bytes(values, 3)
    const misaligned = new Uint8Array(backing.buffer, 3, values.length * 4)

    // Prove the fixture really carries the trap.
    assert.equal(misaligned.byteOffset % 4, 3)
    assert.ok(misaligned.buffer.byteLength > misaligned.byteLength)

    const frame = decodePcmFrame(misaligned)
    assert.equal(frame.samples.length, values.length)
    values.forEach((expected, index) => {
      assert.ok(approx(frame.samples[index] ?? NaN, expected, 1e-9), `sample ${index}`)
    })
  })

  it('drops a truncated tail instead of throwing', () => {
    // A dropped connection leaves a final frame that is not a whole number of
    // samples. Throwing would lose the frame; treating the tail as audio would
    // invent 3 bytes of sound.
    const bytes = new Uint8Array(5 * 4 + 3)
    const view = new DataView(bytes.buffer)
    for (let index = 0; index < 5; index += 1) view.setFloat32(index * 4, 0.1 * (index + 1), true)
    bytes.set([0xaa, 0xbb, 0xcc], 20)

    const frame = decodePcmFrame(bytes)
    assert.equal(frame.samples.length, 5)
    assert.equal(frame.frameCount, 5)
    assert.equal(frame.trailingBytes, 3)
    assert.equal(frame.truncated, true)
  })

  it('reports peak as a magnitude and rms from the mean square', () => {
    const frame = decodePcmFrame(float32Bytes([0.5, -0.25, 0, 1]))
    assert.equal(frame.peak, 1)
    assert.ok(approx(frame.rms, Math.sqrt((0.25 + 0.0625 + 0 + 1) / 4), 1e-9))

    // Peak is unsigned: an all-negative frame still reports a positive level,
    // otherwise a level meter would read zero on a phase-inverted signal.
    const negative = decodePcmFrame(float32Bytes([-0.75, -0.5]))
    assert.equal(negative.peak, 0.75)
  })

  it('reports silence as zero peak and zero rms, not NaN', () => {
    const frame = decodePcmFrame(new Uint8Array(9600 * 4))
    assert.equal(frame.peak, 0)
    assert.equal(frame.rms, 0)
  })

  it('handles an empty buffer', () => {
    const frame = decodePcmFrame(new Uint8Array(0))
    assert.equal(frame.samples.length, 0)
    assert.equal(frame.peak, 0)
    assert.equal(frame.rms, 0)
    assert.equal(frame.frameCount, 0)
    assert.equal(frame.trailingBytes, 0)
    assert.equal(frame.truncated, false)
  })

  it('counts whole frames without discarding partial ones', () => {
    // 10 samples across 4 channels is 2 whole frames plus 2 samples. Those two
    // samples are still returned: the decoder reports geometry, it does not
    // silently throw audio away.
    const frame = decodePcmFrame(float32Bytes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 4)
    assert.equal(frame.samples.length, 10)
    assert.equal(frame.frameCount, 2)
  })

  it('matches the measured 38400-byte frame geometry', () => {
    // The verified formula: frameBytes = sampleRate x 0.1 x 4 x channels.
    assert.equal(expectedFrameBytes(96000), 38400)
    assert.equal(expectedFrameBytes(48000), 19200)
    assert.equal(expectedFrameBytes(192000), 76800)
  })
})

// ---------------------------------------------------------------------------
// Waveform decimation
// ---------------------------------------------------------------------------

describe('extractWaveform', () => {
  it('keeps a single-sample transient that a bucket mean would erase', () => {
    // This is the entire reason the function exists. A partial-discharge click
    // occupies a handful of samples; averaging its bucket replaces it with the
    // noise floor and deletes the evidence from the display.
    const samples = new Float32Array(1000).fill(0.005)
    samples[512] = 0.9
    samples[700] = -0.95

    const waveform = extractWaveform(samples, 50)
    assert.equal(waveform.length, 50)
    // 1000 samples / 50 buckets = 20 samples per bucket. The spike survives as
    // the bucket's extreme, to Float32 precision.
    assert.ok(approx(waveform[25] ?? NaN, 0.9, 1e-6), `bucket 25 = ${waveform[25]}`)
    // Sign is preserved, so the trace reads as a waveform rather than a
    // rectified envelope.
    assert.ok(approx(waveform[35] ?? NaN, -0.95, 1e-6), `bucket 35 = ${waveform[35]}`)

    waveform.forEach((value, bucket) => {
      if (bucket === 25 || bucket === 35) return
      assert.ok(Math.abs(value) < 0.01, `bucket ${bucket} was inflated to ${value}`)
    })
  })

  it('returns one point per sample when asked for more buckets than samples', () => {
    const samples = new Float32Array([0.1, -0.9, 0.2])
    const waveform = extractWaveform(samples, 10)
    // No zero padding: padding would render as a spurious drop to silence.
    assert.equal(waveform.length, 3)
    const expected = [0.1, -0.9, 0.2]
    expected.forEach((value, index) => {
      assert.ok(approx(waveform[index] ?? NaN, value, 1e-6), `sample ${index}`)
    })
  })

  it('returns exactly the requested bucket count, including non-divisors', () => {
    assert.equal(extractWaveform(new Float32Array(1000), 10).length, 10)
    assert.equal(extractWaveform(new Float32Array(1000), 7).length, 7)
    assert.equal(extractWaveform(new Float32Array(1000), 1).length, 1)
  })

  it('returns nothing for empty input or a non-positive bucket count', () => {
    assert.deepEqual(extractWaveform(new Float32Array(0), 10), [])
    assert.deepEqual(extractWaveform(new Float32Array(100), 0), [])
    assert.deepEqual(extractWaveform(new Float32Array(100), -5), [])
  })
})

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

describe('PcmRingBuffer', () => {
  it('retains the NEWEST window once it wraps', () => {
    // An off-by-one write head would return stale audio while claiming to hold
    // the last second, and an alarm clip would then contain the wrong 10 s.
    // 20 blocks x 100 samples = twice the 1 s capacity, so the first half has
    // been overwritten by the time the snapshot is taken.
    const buffer = new PcmRingBuffer({ sampleRate: 1000, channelCount: 1, capacitySeconds: 1 })
    for (let block = 0; block < 20; block += 1) {
      buffer.push(rampBlock(block * 100, 100), 1000 + block * 100)
    }

    const snapshot = buffer.snapshot()
    assert.equal(snapshot.samples.length, 1000)
    assert.equal(snapshot.samples[0], 1000)
    assert.equal(snapshot.samples[999], 1999)
    assert.equal(buffer.sampleCount, 1000)
    assert.equal(buffer.durationSeconds, 1)
  })

  it('does not grow when fed many times its capacity', () => {
    // This buffer runs for hours at 10 frames/s. Anything that grows per push
    // would turn a long monitoring session into an out-of-memory crash.
    const buffer = new PcmRingBuffer({ sampleRate: 1000, channelCount: 1, capacitySeconds: 1 })
    const capacity = buffer.capacity

    for (let block = 0; block < 100; block += 1) {
      buffer.push(rampBlock(block * 100, 100), 10_000 + block * 100)
    }

    assert.equal(buffer.capacity, capacity, 'the backing allocation must be fixed')
    assert.equal(buffer.sampleCount, capacity, 'the window must be full, not larger')
    assert.equal(buffer.snapshot().samples.length, capacity)
    assert.equal(buffer.durationSeconds, 1)
  })

  it('snapshots the most recent seconds and slides the start time with them', () => {
    const start = 1_700_000_000_000
    const buffer = new PcmRingBuffer({ sampleRate: 1000, channelCount: 1, capacitySeconds: 1 })
    // 5 blocks x 200 samples of 1 kHz audio = 1.00 s, dated 200 ms apart.
    for (let block = 0; block < 5; block += 1) {
      buffer.push(rampBlock(block * 200, 200), start + block * 200)
    }

    const full = buffer.snapshot()
    assert.equal(full.startTime, start)
    assert.equal(full.endTime, start + 1000)

    const recent = buffer.snapshotSeconds(0.4)
    assert.equal(recent.samples.length, 400)
    assert.equal(recent.samples[0], 600)
    assert.equal(recent.samples[399], 999)
    assert.equal(recent.startTime, start + 600)
    assert.equal(recent.endTime, start + 1000)
  })

  it('clamps a request longer than the retained window instead of padding', () => {
    const buffer = new PcmRingBuffer({ sampleRate: 1000, channelCount: 1, capacitySeconds: 1 })
    buffer.push(rampBlock(0, 500), 5000)

    const snapshot = buffer.snapshotSeconds(60)
    assert.equal(snapshot.samples.length, 500)
    assert.equal(snapshot.samples[0], 0)
    assert.equal(snapshot.samples[499], 499)
  })

  it('treats a non-positive duration as "nothing", not as "everything"', () => {
    const buffer = new PcmRingBuffer({ sampleRate: 1000, channelCount: 1, capacitySeconds: 1 })
    buffer.push(rampBlock(0, 500), 5000)
    assert.equal(buffer.snapshotSeconds(0).samples.length, 0)
    assert.equal(buffer.snapshotSeconds(-1).samples.length, 0)
  })

  it('keeps only the tail of a block larger than the whole window', () => {
    const buffer = new PcmRingBuffer({ sampleRate: 1000, channelCount: 1, capacitySeconds: 0.1 })
    buffer.push(rampBlock(0, 250), 5000)

    const snapshot = buffer.snapshot()
    assert.equal(snapshot.samples.length, 100)
    assert.equal(snapshot.samples[0], 150)
    assert.equal(snapshot.samples[99], 249)
  })

  it('returns a copy, so a consumer cannot be rewritten by the next push', () => {
    const buffer = new PcmRingBuffer({ sampleRate: 1000, channelCount: 1, capacitySeconds: 1 })
    buffer.push(rampBlock(0, 100), 1000)

    const snapshot = buffer.snapshot()
    snapshot.samples[0] = 12345
    // A live view would have corrupted the buffer here — and a WAV written from
    // it later would not match its declared length.
    assert.equal(buffer.snapshot().samples[0], 0)
    assert.equal(buffer.snapshotSeconds(0.1).samples[0], 0)
  })

  it('honours the declared depth in SECONDS for a multi-channel buffer', () => {
    // capacitySeconds is a duration: a stereo 1 s window is 2 x sampleRate
    // samples, not sampleRate. Getting this wrong halves the pre-alarm window
    // without any visible failure.
    const buffer = new PcmRingBuffer({ sampleRate: 1000, channelCount: 2, capacitySeconds: 1 })
    assert.equal(buffer.capacity, 2000)
    assert.equal(buffer.durationSeconds, 0)
    buffer.push(new Float32Array(2000), 1000)
    assert.equal(buffer.sampleCount, 2000)
    assert.equal(buffer.durationSeconds, 1)
  })

  it('forgets its window and its timestamps when cleared', () => {
    const buffer = new PcmRingBuffer({ sampleRate: 1000, channelCount: 1, capacitySeconds: 1 })
    buffer.push(rampBlock(0, 500), 5000)

    buffer.clear()
    const snapshot = buffer.snapshot()
    assert.equal(snapshot.samples.length, 0)
    assert.equal(snapshot.startTime, 0)
    assert.equal(snapshot.endTime, 0)
    assert.equal(buffer.sampleCount, 0)
    assert.equal(buffer.durationSeconds, 0)
  })
})

// ---------------------------------------------------------------------------
// WAV encoding
// ---------------------------------------------------------------------------

describe('encodeFloat32Wav', () => {
  it('round-trips through the project parser and decoder', () => {
    const values = [0, 0.5, -0.5, 0.25, -1, 1, 0.125]
    const samples = new Float32Array(values)
    const wav = encodeFloat32Wav(samples, { sampleRate: 96000, channelCount: 1 })

    const info = parseWave(wav)
    assert.ok(info, 'the encoded file must be a valid RIFF/WAVE')
    // audioFormat 3 = IEEE float: the same encoding the device itself produces,
    // so a local capture and a downloaded clip are interchangeable.
    assert.equal(info.audioFormat, WAVE_FORMAT.IEEE_FLOAT)
    assert.equal(info.audioFormat, 3)
    assert.equal(info.channels, 1)
    assert.equal(info.sampleRate, 96000)
    assert.equal(info.bitsPerSample, 32)
    assert.equal(info.dataBytes, values.length * 4)
    assert.ok(approx(info.durationSeconds, values.length / 96000, 1e-12))

    const decoded = decodeWaveToFloat32(wav)
    assert.equal(decoded.unsupportedReason, undefined)
    assert.equal(decoded.samples.length, values.length)
    values.forEach((expected, index) => {
      assert.ok(approx(decoded.samples[index] ?? NaN, expected, 1e-6), `sample ${index}`)
    })
  })

  it('writes correct chunk sizes and the fact chunk non-PCM formats require', () => {
    const wav = encodeFloat32Wav(new Float32Array(960), { sampleRate: 96000, channelCount: 1 })
    assert.deepEqual(chunkIds(wav), ['fmt ', 'fact', 'data'])

    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    // RIFF size counts everything after the first 8 bytes.
    assert.equal(view.getUint32(4, true), wav.byteLength - 8)
    // fmt payload: audioFormat, channels, sampleRate, byteRate, blockAlign, bits.
    assert.equal(view.getUint16(20, true), 3)
    assert.equal(view.getUint16(22, true), 1)
    assert.equal(view.getUint32(24, true), 96000)
    assert.equal(view.getUint32(28, true), 96000 * 4)
    assert.equal(view.getUint16(32, true), 4)
    assert.equal(view.getUint16(34, true), 32)
    // fact payload is the per-channel frame count.
    assert.equal(view.getUint32(40, true), 4)
    assert.equal(view.getUint32(44, true), 960)
    // data chunk size is the payload size, not the file size.
    assert.equal(view.getUint32(52, true), 960 * 4)
    assert.equal(wav.byteLength, float32WavByteLength(960))
  })

  it('declares the interleaved geometry for a stereo file', () => {
    const wav = encodeFloat32Wav(new Float32Array(100), { sampleRate: 48000, channelCount: 2 })
    const info = parseWave(wav)
    assert.ok(info)
    assert.equal(info.channels, 2)
    assert.equal(info.blockAlign, 8)
    assert.equal(info.byteRate, 48000 * 8)
    // 100 samples = 50 frames.
    const view = new DataView(wav.buffer)
    assert.equal(view.getUint32(44, true), 50)
  })

  it('sizes a 60 s stereo 192 kHz capture before allocating it', () => {
    // The brief's example: ~92 MB. Discovering that by running out of memory is
    // not acceptable, which is why the length is computable in advance.
    const sampleCount = 60 * 192_000 * 2
    const bytes = float32WavByteLength(sampleCount)
    assert.equal(bytes, sampleCount * 4 + 56)
    assert.ok(bytes > 90_000_000 && bytes < 95_000_000, `unexpected size ${bytes}`)
  })

  it('writes an empty capture as a structurally valid WAV', () => {
    const wav = encodeFloat32Wav(new Float32Array(0), { sampleRate: 96000, channelCount: 1 })
    const info = parseWave(wav)
    assert.ok(info)
    assert.equal(info.dataBytes, 0)
    assert.equal(info.durationSeconds, 0)
    assert.deepEqual(chunkIds(wav), ['fmt ', 'fact', 'data'])
  })
})

describe('encodeInt16Wav', () => {
  it('round-trips within one quantisation step and declares the right sizes', () => {
    const values = [0, 0.5, -0.5, 1, -1]
    const wav = encodeInt16Wav(new Float32Array(values), { sampleRate: 8000, channelCount: 1 })

    assert.deepEqual(chunkIds(wav), ['fmt ', 'data'])
    const info = parseWave(wav)
    assert.ok(info)
    assert.equal(info.audioFormat, WAVE_FORMAT.PCM)
    assert.equal(info.bitsPerSample, 16)
    assert.equal(info.dataBytes, values.length * 2)
    assert.equal(wav.byteLength, int16WavByteLength(values.length))

    const decoded = decodeWaveToFloat32(wav)
    values.forEach((expected, index) => {
      // One 16-bit quantisation step is 1/32768; allow two so the assertion
      // tests the encoder rather than the exact rounding of a float literal.
      assert.ok(
        approx(decoded.samples[index] ?? NaN, expected, 2 / 32768),
        `sample ${index} (${decoded.samples[index]} vs ${expected})`
      )
    })
  })

  it('clamps out-of-range floats instead of wrapping them', () => {
    // A wrapped conversion turns one loud transient into full-scale noise of the
    // opposite sign — the exact opposite of useful in a fault investigation.
    const decoded = decodeWaveToFloat32(
      encodeInt16Wav(new Float32Array([2, -2]), { sampleRate: 8000, channelCount: 1 })
    )
    assert.ok((decoded.samples[0] ?? 0) > 0.99)
    assert.equal(decoded.samples[1], -1)
  })
})

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

describe('AudioRecorder', () => {
  it('counts samples and derives duration from the AUDIO, not the wall clock', () => {
    // Three real frames: 9600 samples each at 96 kHz = 100 ms each. A dropped
    // connection pauses the frames but not the clock, so the duration that ends
    // up in the database must describe the file, not the session.
    const recorder = new AudioRecorder({ sampleRate: 96000, channelCount: 1 })
    assert.equal(recorder.isRecording, false)
    assert.equal(recorder.elapsedMs, 0)

    recorder.start()
    assert.equal(recorder.isRecording, true)
    for (let frame = 0; frame < 3; frame += 1) {
      recorder.appendFrame(new Float32Array(9600).fill(0.25))
    }
    assert.equal(recorder.sampleCount, 28800)
    assert.ok(approx(recorder.elapsedMs, 300, 1e-6))

    const result = recorder.stop()
    assert.equal(recorder.isRecording, false)
    assert.equal(result.samples.length, 28800)
    assert.ok(approx(result.durationMs, 300, 1e-6))
    assert.equal(result.sampleRate, 96000)
    assert.equal(result.channelCount, 1)
    assert.equal(result.samples[0], 0.25)
  })

  it('accepts a raw WebSocket frame in bytes', () => {
    // The live path holds the frame exactly as it arrived; decoding must happen
    // inside the recorder so no caller can forget the alignment rule.
    const recorder = new AudioRecorder({ sampleRate: 8000, channelCount: 1 })
    recorder.start()
    recorder.appendFrame(float32Bytes([0.1, -0.2, 0.3]))

    const result = recorder.stop()
    assert.equal(result.samples.length, 3)
    assert.ok(approx(result.samples[0] ?? NaN, 0.1, 1e-7))
    assert.ok(approx(result.samples[1] ?? NaN, -0.2, 1e-7))
    assert.ok(approx(result.samples[2] ?? NaN, 0.3, 1e-7))
  })

  it('ignores frames after stop, because one is always in flight', () => {
    const recorder = new AudioRecorder({ sampleRate: 96000, channelCount: 1 })
    recorder.start()
    recorder.appendFrame(new Float32Array(960))
    recorder.stop()
    const captured = recorder.sampleCount

    // Neither form may throw or accumulate: the user cannot perceive the race,
    // so it must not surface as a crash.
    recorder.appendFrame(new Float32Array(960))
    recorder.appendFrame(float32Bytes([1, 1, 1]))
    assert.equal(recorder.sampleCount, captured)
    assert.equal(recorder.isRecording, false)
    // A second stop is a no-op that reports an empty capture rather than
    // re-reporting (or duplicating) the finished one.
    assert.equal(recorder.stop().samples.length, 0)
  })

  it('grows without losing the beginning of the recording', () => {
    // Unlike the ring buffer, a recording must never discard its oldest data.
    const recorder = new AudioRecorder({ sampleRate: 1000, channelCount: 1 })
    recorder.start()
    for (let block = 0; block < 100; block += 1) {
      recorder.appendFrame(rampBlock(block * 1000, 1000))
    }

    const result = recorder.stop()
    assert.equal(result.samples.length, 100_000)
    assert.equal(result.samples[0], 0)
    assert.equal(result.samples[99_999], 99_999)
  })

  it('stops accumulating at the configured sample cap', () => {
    const recorder = new AudioRecorder({ sampleRate: 1000, channelCount: 1, maxSamples: 2500 })
    recorder.start()
    for (let block = 0; block < 3; block += 1) recorder.appendFrame(new Float32Array(1000))

    assert.equal(recorder.isFull, true)
    assert.equal(recorder.sampleCount, 2500)
    const result = recorder.stop()
    assert.equal(result.samples.length, 2500)
    assert.equal(result.truncated, true)
  })

  it('peeks at recent audio without ending the session', () => {
    const recorder = new AudioRecorder({ sampleRate: 1000, channelCount: 1 })
    recorder.start()
    recorder.appendFrame(rampBlock(0, 1000))
    recorder.appendFrame(rampBlock(1000, 1000))

    const peek = recorder.peekSeconds(0.5)
    assert.equal(peek.length, 500)
    assert.equal(peek[0], 1500)
    assert.equal(recorder.isRecording, true)
    assert.equal(recorder.sampleCount, 2000)
  })
})

// ---------------------------------------------------------------------------
// Recording service (real filesystem + real SQLite)
// ---------------------------------------------------------------------------

interface TestStore {
  root: string
  db: SqliteDatabase
  storage: StorageService
  recordings: RecordingRepository
  service: AudioRecordingService
  deviceId: string
  deviceUid: string
  dispose: () => Promise<void>
}

/**
 * Build the real storage + database stack in a throwaway directory.
 *
 * `minFreeBytes` drives the spec 14.4 floor: passing `Number.MAX_SAFE_INTEGER`
 * simulates a disk below it without having to fill a real one.
 */
async function createStore(minFreeBytes = 0): Promise<TestStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hertzinno-audio-'))
  const db = openDatabase({ file: ':memory:' })
  const storage = new StorageService({
    db,
    getStorageRoot: () => root,
    getMinFreeBytes: () => minFreeBytes
  })
  await storage.ensureLayout(root)

  // The recordings table has a foreign key onto devices and the database is
  // opened with `foreign_keys = ON`, so the device must exist first.
  const devices = new DeviceRepository(db)
  const { device } = devices.upsertByIdentity(
    { ip: '192.168.1.50', httpPort: 80, username: 'admin', password: 'admin' },
    { deviceUid: 'AE08-TEST-0001', name: '测试声纹盒子', channelCount: 2 }
  )

  const recordings = new RecordingRepository(db)
  return {
    root,
    db,
    storage,
    recordings,
    service: new AudioRecordingService({ storage, recordings }),
    deviceId: device.id,
    deviceUid: device.deviceUid,
    dispose: async () => {
      db.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  }
}

describe('AudioRecordingService.saveRecording', () => {
  it('writes a valid WAV, hashes the bytes on disk and stores a RELATIVE path', async () => {
    const store = await createStore()
    try {
      const sampleRate = 96000
      const samples = new Float32Array(9600)
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = Math.sin(index / 20) * 0.5
      }
      const startedAt = Date.now()

      const recording = await store.service.saveRecording({
        deviceId: store.deviceId,
        deviceUid: store.deviceUid,
        channelIndex: 0,
        recordingType: 'manual',
        startedAt,
        samples,
        sampleRate,
        channelCount: 1
      })

      // ---- metadata --------------------------------------------------------
      assert.equal(recording.recordingType, 'manual')
      assert.equal(recording.channelId, 0)
      assert.equal(recording.sampleRate, sampleRate)
      assert.equal(recording.audioFormat, 'wav')
      assert.equal(recording.startTime, startedAt)
      assert.equal(recording.durationMs, 100)
      assert.equal(recording.fileSize, samples.length * 4 + 56)

      // The hard project rule: never an absolute path, always root-relative, so
      // moving the storage root is a settings change rather than a migration.
      assert.equal(path.isAbsolute(recording.relativePath), false)
      assert.equal(recording.relativePath.includes(store.root), false)
      assert.ok(recording.relativePath.startsWith('audio/'), recording.relativePath)
      assert.ok(recording.relativePath.includes('/CH01/'), recording.relativePath)
      assert.ok(recording.relativePath.endsWith('.wav'), recording.relativePath)

      // ---- the file on disk ------------------------------------------------
      const absolute = store.storage.resolve(recording.relativePath)
      const onDisk = await fs.readFile(absolute)
      assert.equal(onDisk.byteLength, recording.fileSize)

      const info = parseWave(onDisk)
      assert.ok(info, 'the saved file must be a valid WAV')
      assert.equal(info.audioFormat, 3)
      assert.equal(info.channels, 1)
      assert.equal(info.sampleRate, sampleRate)
      assert.equal(info.dataBytes, samples.length * 4)

      const decoded = decodeWaveToFloat32(onDisk)
      assert.equal(decoded.samples.length, samples.length)
      for (let index = 0; index < samples.length; index += 1) {
        assert.ok(
          approx(decoded.samples[index] ?? NaN, samples[index] ?? NaN, 1e-6),
          `sample ${index}`
        )
      }

      // ---- integrity -------------------------------------------------------
      const expectedHash = createHash('sha256').update(onDisk).digest('hex')
      assert.equal(recording.sha256, expectedHash)
      // And the hash must describe the encoder's output, byte for byte.
      assert.equal(
        recording.sha256,
        createHash('sha256')
          .update(encodeFloat32Wav(samples, { sampleRate, channelCount: 1 }))
          .digest('hex')
      )

      // ---- the row is readable back through the repository -----------------
      const row = store.recordings.findById(recording.id)
      assert.ok(row)
      assert.equal(row.relativePath, recording.relativePath)
      assert.equal(row.sha256, expectedHash)
      assert.equal(row.durationMs, 100)
    } finally {
      await store.dispose()
    }
  })

  it('refuses a non-essential recording below the floor but still allows a manual one', async () => {
    // Spec 14.4: below the free-space floor, non-essential recording stops.
    // Manual recordings are explicitly never auto-blocked by the floor.
    const store = await createStore(Number.MAX_SAFE_INTEGER)
    try {
      const samples = new Float32Array(1000).fill(0.1)
      const base = {
        deviceId: store.deviceId,
        deviceUid: store.deviceUid,
        channelIndex: 1,
        startedAt: Date.now(),
        samples,
        sampleRate: 96000,
        channelCount: 1
      }

      await assert.rejects(
        () => store.service.saveRecording({ ...base, recordingType: 'alarm' }),
        (error: unknown) => error instanceof AppError && error.code === ErrorCodes.DISK_FULL
      )
      await assert.rejects(
        () => store.service.saveRecording({ ...base, recordingType: 'scheduled' }),
        (error: unknown) => error instanceof AppError && error.code === ErrorCodes.DISK_FULL
      )

      const manual = await store.service.saveRecording({ ...base, recordingType: 'manual' })
      assert.equal(manual.recordingType, 'manual')
      assert.ok(await fs.stat(store.storage.resolve(manual.relativePath)))
    } finally {
      await store.dispose()
    }
  })

  it('rejects an unusable capture instead of writing a stub file or a bad row', async () => {
    const store = await createStore()
    try {
      const base = {
        deviceId: store.deviceId,
        deviceUid: store.deviceUid,
        channelIndex: 0,
        recordingType: 'manual' as const,
        startedAt: Date.now(),
        sampleRate: 96000,
        channelCount: 1
      }

      await assert.rejects(
        () => store.service.saveRecording({ ...base, samples: new Float32Array(0) }),
        (error: unknown) => error instanceof AppError && error.code === ErrorCodes.VALIDATION_ERROR
      )
      await assert.rejects(
        () =>
          store.service.saveRecording({ ...base, samples: new Float32Array(10), channelIndex: 9 }),
        (error: unknown) => error instanceof AppError && error.code === ErrorCodes.VALIDATION_ERROR
      )
      await assert.rejects(
        () =>
          store.service.saveRecording({
            ...base,
            samples: new Float32Array(10),
            sampleRate: 0
          }),
        (error: unknown) => error instanceof AppError && error.code === ErrorCodes.VALIDATION_ERROR
      )

      // Nothing may have been written or inserted by the rejected attempts.
      assert.equal(store.recordings.countBetween(0, Number.MAX_SAFE_INTEGER), 0)
    } finally {
      await store.dispose()
    }
  })

  it('records the audio-anchored end time even when the caller reports a longer span', async () => {
    // A connection drop makes the wall-clock span longer than the audio that was
    // captured. Both facts are kept: end_time is when capture stopped, duration
    // describes the file.
    const store = await createStore()
    try {
      const samples = new Float32Array(1000)
      const startedAt = 1_700_000_000_000
      const recording = await store.service.saveRecording({
        deviceId: store.deviceId,
        deviceUid: store.deviceUid,
        channelIndex: 0,
        recordingType: 'manual',
        startedAt,
        endedAt: startedAt + 5000,
        samples,
        sampleRate: 1000,
        channelCount: 1
      })
      assert.equal(recording.durationMs, 1000)
      assert.equal(recording.endTime, startedAt + 5000)
    } finally {
      await store.dispose()
    }
  })
})

describe('AudioRecordingService.savePreAlarmClip', () => {
  /**
   * Fill a buffer with 1 s blocks whose samples encode their own second, so a
   * mis-sliced window is visible as a wrong VALUE rather than only a wrong
   * length.
   */
  function secondsBuffer(seconds: number, startAt: number, sampleRate = 1000): PcmRingBuffer {
    const buffer = new PcmRingBuffer({ sampleRate, channelCount: 1, capacitySeconds: seconds })
    for (let second = 0; second < seconds; second += 1) {
      const block = new Float32Array(sampleRate)
      for (let index = 0; index < block.length; index += 1) {
        block[index] = second + index / sampleRate
      }
      buffer.push(block, startAt + second * 1000)
    }
    return buffer
  }

  it('slices pre-alarm + post-alarm around the alarm instant', async () => {
    const store = await createStore()
    try {
      const start = 1_700_000_000_000
      const buffer = secondsBuffer(30, start)
      const alarmAt = start + 10_000

      const recording = await store.service.savePreAlarmClip({
        deviceId: store.deviceId,
        deviceUid: store.deviceUid,
        channelIndex: 0,
        alarmAt,
        buffer,
        sampleRate: 1000,
        channelCount: 1,
        preSeconds: 5,
        postSeconds: 10
      })

      assert.equal(recording.recordingType, 'alarm')
      assert.equal(recording.durationMs, 15_000)
      // The clip is dated from the audio it actually contains, so its start is
      // the beginning of the pre-alarm half, not the alarm instant.
      assert.equal(recording.startTime, start + 5_000)

      const decoded = decodeWaveToFloat32(
        await fs.readFile(store.storage.resolve(recording.relativePath))
      )
      assert.equal(decoded.samples.length, 15_000)
      // First sample is second 5, last is the final sample of second 19.
      assert.ok(approx(decoded.samples[0] ?? NaN, 5, 1e-6), `first=${decoded.samples[0]}`)
      assert.ok(
        approx(decoded.samples[14_999] ?? NaN, 19.999, 1e-6),
        `last=${decoded.samples[14_999]}`
      )
    } finally {
      await store.dispose()
    }
  })

  it('defaults to the spec 4.3 model: 10 s pre + 20 s post', async () => {
    assert.equal(DEFAULT_PRE_ALARM_SECONDS, 10)
    assert.equal(DEFAULT_POST_ALARM_SECONDS, 20)

    const store = await createStore()
    try {
      const start = 1_700_000_000_000
      const buffer = secondsBuffer(30, start)

      const recording = await store.service.savePreAlarmClip({
        deviceId: store.deviceId,
        deviceUid: store.deviceUid,
        channelIndex: 0,
        alarmAt: start + 10_000,
        buffer,
        sampleRate: 1000,
        channelCount: 1
      })

      assert.equal(recording.durationMs, 30_000)
      assert.equal(recording.startTime, start)
    } finally {
      await store.dispose()
    }
  })

  it('saves the audio that exists rather than padding a too-short window with silence', async () => {
    // Only 3 s had been buffered when the alarm fired. Padding the missing 27 s
    // with zeros would render as the channel going quiet just before the event —
    // a false reading of the evidence.
    const store = await createStore()
    try {
      const start = 1_700_000_000_000
      const buffer = secondsBuffer(3, start)

      const recording = await store.service.savePreAlarmClip({
        deviceId: store.deviceId,
        deviceUid: store.deviceUid,
        channelIndex: 0,
        alarmAt: start + 3000,
        buffer,
        sampleRate: 1000,
        channelCount: 1
      })

      assert.equal(recording.durationMs, 3000)
      const decoded = decodeWaveToFloat32(
        await fs.readFile(store.storage.resolve(recording.relativePath))
      )
      assert.equal(decoded.samples.length, 3000)
      assert.equal(isSilent(decoded.samples), false)
    } finally {
      await store.dispose()
    }
  })

  it('refuses to save a clip when the buffer holds nothing', async () => {
    const store = await createStore()
    try {
      const buffer = new PcmRingBuffer({ sampleRate: 1000, channelCount: 1, capacitySeconds: 30 })
      await assert.rejects(
        () =>
          store.service.savePreAlarmClip({
            deviceId: store.deviceId,
            deviceUid: store.deviceUid,
            channelIndex: 0,
            alarmAt: Date.now(),
            buffer,
            sampleRate: 1000,
            channelCount: 1
          }),
        (error: unknown) => error instanceof AppError && error.code === ErrorCodes.VALIDATION_ERROR
      )
    } finally {
      await store.dispose()
    }
  })
})
