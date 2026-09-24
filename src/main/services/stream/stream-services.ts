/**
 * Realtime stream services.
 *
 * MEASURED CONTEXT (docs/PROTOCOL-FINDINGS.md section 4)
 * All four realtime endpoints are **WebSocket**, not HTTP — the specification
 * lists them as `GET` and they return 404 over HTTP.
 *
 *   /features_stream     ~1 Hz     binary frame containing JSON text
 *   /audio_stream        ~10 Hz    38400-byte binary frames of Float32 PCM
 *   /freq_domain         ~1.4 Hz   4096-byte binary frames, 1024 Float32 bins
 *   /time_freq_domain    ~1.5 Hz   ~40 KB binary frames containing a JPEG
 *
 * WHY EACH SERVICE IS THIN
 * Framing, subscription cadence, reconnection and teardown all live in
 * `WebSocketStream`. These services only translate bytes into domain events.
 * That separation is deliberate: the transport had to be written against
 * measured behaviour, and keeping the parsing separate means a firmware change
 * to a payload shape touches one small file instead of the whole layer.
 *
 * EVERY SERVICE EMITS DISPLAY-READY DATA. The renderer never receives raw PCM:
 * at 10 frames/s and 38.4 kB each that would be ~3.8 MB/s across IPC. See
 * `shared/domain/monitoring.ts` for the reasoning.
 */

import { EventEmitter } from 'node:events'
import type { RealtimeFeature } from '@shared/domain/models'
import type {
  AudioFrameEvent,
  SpectrogramFrameEvent,
  SpectrumFrameEvent,
  StreamKind
} from '@shared/domain/monitoring'
import type { StreamStatusEvent } from '@shared/domain/monitoring'
import { deviceLog } from '../logging/logger'
import { mapFeatureFrame } from '../device/protocol/mappers'
import { WebSocketStream, type StreamFrame, type StreamProfile } from './websocket-stream'
import { computeFrameStats, extractWaveform, readFloat32Le } from '../audio/pcm-utils'

/** Shared options for every stream service. */
export interface StreamServiceOptions {
  deviceId: string
  baseWsUrl: string
  /** Auth headers; the device accepts `token` and `Authorization`. */
  headers: Record<string, string>
  /** Channel to subscribe to. The device streams one channel per connection. */
  channelId: number
  /**
   * Put `channelId` into the subscription ping even for a profile that carries
   * none — the `/features_stream` multi-channel experiment.
   *
   * Default (absent) = the measured protocol, unchanged. See
   * `WebSocketStreamOptions.channelInPing` for why the flag exists and why it is
   * only ever set for the EXTRA channels of a multi-channel view.
   */
  channelInPing?: boolean
  profile: StreamProfile
}

/**
 * Common lifecycle for the four stream services.
 *
 * Owns exactly one `WebSocketStream` and re-emits its status tagged with the
 * stream kind, so the UI can show per-stream health rather than one opaque
 * "monitoring" indicator that hides which of four feeds is broken.
 */
export abstract class BaseStreamService extends EventEmitter {
  protected readonly stream: WebSocketStream
  protected readonly deviceId: string
  protected readonly channelId: number

  /**
   * Frames successfully parsed since the stream started.
   *
   * Public because the manager's starvation watchdog reads it to decide whether
   * a device is still serving a slow stream, and because it is the number shown
   * in the UI's per-stream status strip.
   */
  frameCount = 0

  constructor(options: StreamServiceOptions) {
    super()
    this.deviceId = options.deviceId
    this.channelId = options.channelId

    this.stream = new WebSocketStream({
      baseWsUrl: options.baseWsUrl,
      profile: options.profile,
      headers: options.headers,
      channel: options.channelId,
      ...(options.channelInPing === true ? { channelInPing: true } : {}),
      onStatus: (status) => {
        const event: StreamStatusEvent = {
          deviceId: this.deviceId,
          kind: this.kind,
          state: status.state,
          retries: status.retries,
          frameCount: this.frameCount,
          ...(status.lastFrameAt !== undefined ? { lastFrameAt: status.lastFrameAt } : {}),
          ...(status.lastError !== undefined ? { lastError: status.lastError } : {})
        }
        this.emit('status', event)
      },
      onFrame: (frame) => this.consume(frame)
    })
  }

  /** Which of the four streams this instance is. */
  abstract readonly kind: StreamKind

  start(): void {
    this.stream.start()
  }

  /**
   * Stop and release everything.
   * `WebSocketStream.stop()` removes its own listeners, which also detaches the
   * closures this class passed in — no reference cycle keeps the service alive.
   */
  stop(): void {
    this.stream.stop()
    this.removeAllListeners()
  }

  get status() {
    return this.stream.currentStatus
  }

  /** Parse one frame and emit a domain event. Errors are logged, never thrown. */
  protected abstract consume(frame: StreamFrame): void

  /** Wrap a parse step so a malformed frame cannot kill the subscription. */
  protected safely(action: () => void, description: string): void {
    try {
      action()
    } catch (error) {
      deviceLog().warn(`Stream frame rejected: ${description}`, {
        deviceId: this.deviceId,
        kind: this.kind,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — features
// ---------------------------------------------------------------------------

/**
 * `/features_stream` — realtime acoustic features.
 *
 * MEASURED oddity worth remembering: the frames are **binary**, but their
 * contents are **UTF-8 JSON text**. The device wraps a text payload in a binary
 * WebSocket message. A client that assumed text frames would see nothing, and a
 * client that assumed binary-only would have to guess this shape.
 *
 * Also measured: the frame carries NO timestamp, so arrival time is stamped
 * here. `mapFeatureFrame` already treats `nowMs` as the normal source rather
 * than a fallback.
 */
export class FeatureStreamService extends BaseStreamService {
  readonly kind: StreamKind = 'features'

  private readonly decoder = new TextDecoder('utf-8', { fatal: false })

  protected consume(frame: StreamFrame): void {
    this.safely(() => {
      const text = this.decoder.decode(frame.bytes)
      const trimmed = text.trim()
      if (trimmed === '') return

      let payload: unknown
      try {
        payload = JSON.parse(trimmed)
      } catch {
        // A keep-alive or a partial frame. Not an error worth surfacing.
        return
      }

      if (!payload || typeof payload !== 'object') return

      const feature = mapFeatureFrame(payload as Record<string, unknown>, {
        deviceId: this.deviceId,
        fallbackChannelId: this.channelId,
        nowMs: frame.receivedAt
      })

      // A frame with no usable metric is dropped rather than emitted as zeros:
      // a zero-filled SPL on a chart reads as "silence", which is a lie.
      if (!feature) return

      this.frameCount += 1
      this.emit('feature', { deviceId: this.deviceId, feature } satisfies {
        deviceId: string
        feature: RealtimeFeature
      })
    }, 'features JSON')
  }
}

// ---------------------------------------------------------------------------
// Phase 6 — spectrum
// ---------------------------------------------------------------------------

/** Verified frame size: 4096 bytes = 1024 Float32 bins. */
export const SPECTRUM_BIN_COUNT = 1024

/**
 * `/freq_domain` — realtime magnitude spectrum.
 *
 * The payload is a bare Float32 array with no header and no frequency axis, so
 * `binHz` is derived from the device's sample rate: `sampleRate / binCount`.
 * At 96 kHz that is ~93.75 Hz per bin across 0-48 kHz.
 */
export class SpectrumStreamService extends BaseStreamService {
  readonly kind: StreamKind = 'spectrum'

  private sampleRate = 48_000

  /** The device sample rate drives the frequency axis; set it when known. */
  setSampleRate(sampleRate: number): void {
    if (Number.isFinite(sampleRate) && sampleRate > 0) this.sampleRate = sampleRate
  }

  protected consume(frame: StreamFrame): void {
    this.safely(() => {
      if (frame.bytes.length < 4) return

      // Read via DataView rather than `new Float32Array(buffer)`: a WebSocket
      // frame can sit at a non-zero byteOffset, and the typed-array constructor
      // would then read the wrong bytes (or throw on misalignment).
      const view = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength)
      const binCount = Math.floor(frame.bytes.byteLength / 4)
      const magnitudes = new Array<number>(binCount)
      for (let index = 0; index < binCount; index += 1) {
        magnitudes[index] = view.getFloat32(index * 4, true)
      }

      this.frameCount += 1
      this.emit('spectrum', {
        deviceId: this.deviceId,
        channelId: this.channelId,
        timestamp: frame.receivedAt,
        magnitudes,
        startHz: 0,
        binHz: this.sampleRate / binCount
      } satisfies SpectrumFrameEvent)
    }, 'spectrum Float32')
  }
}

// ---------------------------------------------------------------------------
// Phase 7 — spectrogram
// ---------------------------------------------------------------------------

/**
 * `/time_freq_domain` — the spectrogram.
 *
 * THE SURPRISE: the device sends a **rendered JPEG image**, not a numeric
 * matrix. Verified magic `FF D8 FF E0 ... JFIF`, ~40 kB per frame, and the
 * device's own UI assigns it straight to an `<img>` via `readAsDataURL`.
 *
 * So this service does no signal processing at all — it verifies the payload is
 * a JPEG and base64-encodes it for transport. Computing an STFT locally would
 * duplicate the device's work and produce a different picture from the one the
 * firmware intends to show.
 */
export class SpectrogramStreamService extends BaseStreamService {
  readonly kind: StreamKind = 'spectrogram'

  protected consume(frame: StreamFrame): void {
    this.safely(() => {
      // JPEG SOI marker. Checking it means a firmware change to a raw matrix
      // fails loudly here instead of rendering a broken image in the UI.
      if (frame.bytes.length < 4 || frame.bytes[0] !== 0xff || frame.bytes[1] !== 0xd8) {
        deviceLog().debug('Spectrogram frame is not a JPEG; ignoring', {
          deviceId: this.deviceId,
          firstBytes: Array.from(frame.bytes.subarray(0, 4))
        })
        return
      }

      this.frameCount += 1
      this.emit('spectrogram', {
        deviceId: this.deviceId,
        channelId: this.channelId,
        timestamp: frame.receivedAt,
        jpegBase64: Buffer.from(frame.bytes).toString('base64'),
        byteLength: frame.bytes.length
      } satisfies SpectrogramFrameEvent)
    }, 'spectrogram JPEG')
  }
}

// ---------------------------------------------------------------------------
// Phase 5 — audio
// ---------------------------------------------------------------------------

export interface AudioStreamOptions extends StreamServiceOptions {
  /** Sample rate reported by the device; sets the frame geometry. */
  sampleRate: number
  /** Waveform points per pushed preview frame. */
  waveformBuckets?: number
  /**
   * Called with the FULL-RATE samples of every frame.
   *
   * This is the hook that feeds the Ring Buffer and any active recorder. It is
   * deliberately separate from the `audio` event, which carries the decimated
   * preview: consumers that need every sample (recording) must not be coupled to
   * consumers that need a picture (the UI).
   */
  onSamples?: (samples: Float32Array, frame: StreamFrame) => void
}

/**
 * `/audio_stream` — realtime PCM.
 *
 * MEASURED: binary Float32 little-endian frames, constant 38400 bytes =
 * 9600 samples at 96 kHz = exactly 100 ms, **single channel**. Interleaved
 * multi-channel audio was ruled out by three independent observations (see
 * PROTOCOL-FINDINGS 4.3), so `channelCount` is 1 unless a caller says otherwise.
 *
 * Emits TWO things per frame:
 *   - `audio`: a decimated preview for the UI (peak, rms, small waveform);
 *   - `onSamples`: the full-rate samples, for recording and analysis.
 */
export class AudioStreamService extends BaseStreamService {
  readonly kind: StreamKind = 'audio'

  private readonly sampleRate: number
  private readonly channelCount: number
  private readonly waveformBuckets: number
  private readonly onSamples?: (samples: Float32Array, frame: StreamFrame) => void

  /** Rolling peak for the level meter's hold indicator. */
  private peakHold = 0

  constructor(options: AudioStreamOptions) {
    super(options)
    this.sampleRate = options.sampleRate
    // Verified as 1. Kept configurable so a future firmware can differ without
    // a decoder change — guessing 8 here would produce plausible-looking noise.
    this.channelCount = 1
    this.waveformBuckets = options.waveformBuckets ?? 128
    if (options.onSamples) this.onSamples = options.onSamples
  }

  protected consume(frame: StreamFrame): void {
    this.safely(() => {
      // Decode directly from the primitives: the stream path needs no
      // device-specific handling beyond "Float32 LE, single channel", both of
      // which are measured facts rather than guesses.
      const samples = readFloat32Le(frame.bytes)
      if (samples.length === 0) return
      const { peak, rms } = computeFrameStats(samples)

      this.frameCount += 1

      // Full-rate consumers first, so a slow UI cannot delay recording by even
      // one frame.
      this.onSamples?.(samples, frame)

      // Peak-hold decay: a level meter that drops instantly is unreadable,
      // because a 100 ms frame is far shorter than human persistence.
      this.peakHold = Math.max(peak, this.peakHold * 0.85)

      this.emit('audio', {
        deviceId: this.deviceId,
        channelId: this.channelId,
        timestamp: frame.receivedAt,
        peak: this.peakHold,
        rms,
        waveform: extractWaveform(samples, this.waveformBuckets),
        sampleRate: this.sampleRate,
        frameMs: Math.round((samples.length / this.sampleRate / this.channelCount) * 1000)
      } satisfies AudioFrameEvent)
    }, 'audio PCM')
  }
}
