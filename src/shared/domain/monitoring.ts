/**
 * Realtime monitoring domain models — what the renderer receives from the
 * device's four WebSocket streams.
 *
 * MEASURED against real AE08 hardware. See docs/PROTOCOL-FINDINGS.md section 4.
 *
 * A NOTE ON WHAT CROSSES IPC
 * The raw streams are far too heavy to forward verbatim:
 *   /audio_stream        ~10 frames/s x 38400 bytes  = ~3.8 MB/s
 *   /time_freq_domain    ~1.5 frames/s x ~40 KB      = ~60 KB/s (already JPEG)
 *   /freq_domain         ~1.4 frames/s x 4096 bytes  = ~5.7 KB/s
 *   /features_stream     ~1 frame/s x 140 bytes      = negligible
 *
 * So the main process decimates and derives before pushing. The renderer gets
 * display-ready payloads, never raw PCM. This keeps the IPC bridge from
 * becoming the bottleneck and keeps the UI responsive on a modest PC.
 *
 * Audio frames are the important case: 3.8 MB/s over IPC would saturate the
 * bridge, so the renderer receives a decimated waveform preview plus a level
 * meter, while the full-rate PCM stays in the main process where the Ring
 * Buffer and the recorder live.
 */

// Imported rather than redefined: `StreamState` already exists on the
// connection model in `models.ts`, and duplicating the union would let the two
// drift apart silently.
import type { StreamState } from './models'

// ---------------------------------------------------------------------------
// Feature stream (Phase 4) — /features_stream
// ---------------------------------------------------------------------------

/**
 * One realtime feature push.
 *
 * Frames arrive roughly once per second and carry NO timestamp, so `timestamp`
 * is stamped on arrival by the main process.
 */
export interface FeatureStreamEvent {
  deviceId: string
  feature: {
    channelId: number
    timestamp: number
    spl: number
    mainFrequency: number
    smoothness: number
    bandEnergyRatio: number
    oddEvenHarmonicRatio?: number
    spectralComplexity?: number
    fingerprintVariation?: number
  }
}

// ---------------------------------------------------------------------------
// Spectrum (Phase 6) — /freq_domain
// ---------------------------------------------------------------------------

/**
 * One spectrum sweep.
 *
 * MEASURED: frames are 4096 bytes = 1024 Float32 magnitude bins, delivered in
 * the range 0..1. There is no frequency axis in the payload, so `binHz` is
 * derived from the device sample rate.
 */
export interface SpectrumFrameEvent {
  deviceId: string
  channelId: number
  timestamp: number
  /** Magnitude per bin, ascending frequency. Length 1024 on measured hardware. */
  magnitudes: number[]
  /** Frequency of bin 0, always 0 Hz. Present for clarity at the call site. */
  startHz: number
  /** Width of one bin in Hz, derived from sampleRate / binCount. */
  binHz: number
}

// ---------------------------------------------------------------------------
// Spectrogram (Phase 7) — /time_freq_domain
// ---------------------------------------------------------------------------

/**
 * One spectrogram image.
 *
 * MEASURED, and the single biggest surprise of the whole investigation: the
 * device does NOT send a numeric matrix. It sends a rendered **JPEG image**
 * (verified magic `FF D8 FF E0 ... JFIF`, ~40 KB per frame) and its own web UI
 * simply assigns it to an `<img>`.
 *
 * CONSEQUENCE: the Manager must display the image sequence. Computing an STFT
 * locally would duplicate work the device already did, and driving a chart
 * library would produce a different picture from the one the firmware intends.
 */
export interface SpectrogramFrameEvent {
  deviceId: string
  channelId: number
  timestamp: number
  /**
   * Base64-encoded JPEG, ready to use as an `<img src="data:image/jpeg;base64,...">`.
   *
   * Base64 inflates the payload by ~33%, and a structured-clone of a
   * `Uint8Array` would avoid that. Base64 is chosen anyway because it survives
   * every IPC path unchanged and drops straight into an `<img>` without an
   * object-URL lifecycle to leak. At ~1.5 frames/s the cost is acceptable;
   * if it ever is not, this is the first thing to convert.
   */
  jpegBase64: string
  /** Size of the decoded JPEG in bytes, for diagnostics. */
  byteLength: number
}

// ---------------------------------------------------------------------------
// Audio (Phase 5) — /audio_stream, decimated for display
// ---------------------------------------------------------------------------

/**
 * A display-ready audio preview.
 *
 * Replaces the raw 38.4 kB frame at 10 Hz with a small, already-decimated
 * payload that a chart can plot directly.
 */
export interface AudioFrameEvent {
  deviceId: string
  channelId: number
  timestamp: number
  /** Peak absolute amplitude of the frame, 0..1. Drives the level meter. */
  peak: number
  /** RMS amplitude of the frame, 0..1. Drives the level meter's average bar. */
  rms: number
  /**
   * Downsampled signed waveform for oscilloscope-style display.
   * Each value is the extreme-in-magnitude sample within its bucket, so
   * transients survive decimation instead of being averaged away.
   */
  waveform: number[]
  /** Sample rate the preview was taken at. */
  sampleRate: number
  /** Duration of the source frame in milliseconds. Verified as 100. */
  frameMs: number
}

/** Recording state pushed to the UI so it can show an elapsed timer. */
export interface RecordingStateEvent {
  deviceId: string
  channelId: number
  active: boolean
  /** Recording id, present while `active`. */
  recordingId?: string
  startedAt?: number
  /** Milliseconds captured so far. */
  elapsedMs?: number
}

// ---------------------------------------------------------------------------
// Stream lifecycle
// ---------------------------------------------------------------------------

/**
 * Live stream kinds. The union members ARE the catalogue keys, so the renderer
 * resolves `domain.streamKind.<value>` directly; no label map lives here.
 */
export type StreamKind = 'features' | 'audio' | 'spectrum' | 'spectrogram'

/**
 * Runtime list of every stream kind, for validating values that arrive over IPC
 * and for iterating the catalogue keys. Declared next to the union so the two
 * cannot drift, and annotated as total so widening the union fails to compile.
 */
export const STREAM_KINDS: readonly StreamKind[] = ['features', 'audio', 'spectrum', 'spectrogram']

/**
 * 同时订阅的**特征**通道数上限（业主 2026-09-24：多通道同时显示）。
 *
 * 一条通道 = 一条 `/features_stream` 连接（实测一条连接只推一路，PROTOCOL-FINDINGS 4.3），
 * 所以这个数字直接是"设备上多开几条 socket"的代价上限。设备一共 8 路，界面上也不会
 * 有人同时读超过 8 条线；超过就**截断**（渲染层同一个函数 `normalizeWatchedChannels`）。
 *
 * 放在 `shared/` 的理由与 `TREND_METRIC_MAX_SELECTED` 相同：主进程的 IPC 校验与渲染层
 * 的勾选框必须用同一个数，否则界面允许勾 9 路而主进程静默丢掉第 9 路。
 */
export const MAX_FEATURE_CHANNELS = 8

/** Per-stream connection state, pushed on every transition. */
export interface StreamStatusEvent {
  deviceId: string
  kind: StreamKind
  state: StreamState
  retries: number
  lastFrameAt?: number
  lastError?: string
  /** Frames received since the stream started; drives a "receiving data" hint. */
  frameCount?: number
}

// ---------------------------------------------------------------------------
// Multi-channel feature view (业主 2026-09-24)
// ---------------------------------------------------------------------------

/**
 * What one watched channel's feature connection is actually doing.
 *
 * WHY THIS IS REPORTED RATHER THAN ASSUMED
 * `/features_stream`'s subscription carries no channel, so the firmware decides
 * what a given socket delivers. Two behaviours are possible and they have never
 * been distinguished on real hardware (PROTOCOL-FINDINGS §4B.4):
 *
 *   - the channel is bound per CONNECTION at handshake time → every watched
 *     channel gets its own live feed;
 *   - the stream follows the DEVICE's current channel → every extra socket
 *     delivers the same channel, and `frames` stays 0 for the rest.
 *
 * `frames`/`observedChannelId` are the measurement that tells the two apart, so
 * the UI can say "这一路没有收到" instead of drawing a stale value as if it were
 * live. `observedChannelId` is the `cur_ch` of the last frame on that socket —
 * the device's own statement of what it sent, never our assumption.
 */
export interface MonitorFeatureChannel {
  /** Channel the renderer asked for (0-based, as everywhere else). */
  channelId: number
  /** True for the operator's current channel, which the primary socket streams. */
  primary: boolean
  /** Feature frames received for this channel since the session started. */
  frames: number
  /** `cur_ch` of the last frame on this connection; absent when none arrived. */
  observedChannelId?: number
  /** Arrival time of the last frame on this connection. */
  lastFrameAt?: number
}
