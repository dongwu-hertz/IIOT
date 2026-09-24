/**
 * StreamManager — owns the live WebSocket subscriptions for one device.
 *
 * RESPONSIBILITIES
 *   1. Open and close the four measured WebSocket streams as a unit, so a UI
 *      toggle cannot leave an orphaned connection behind.
 *   2. Keep the PCM Ring Buffer fed at full rate, independent of how slowly the
 *      UI consumes preview frames.
 *   3. Own the manual recording session, including disk guard checks.
 *   4. Re-emit nothing itself — consumers subscribe to the individual services.
 *      Pushing to the renderer is the IPC layer's job.
 *
 * WHY ONE MANAGER PER DEVICE, NOT ONE GLOBAL
 * The device streams a SINGLE channel per connection (verified — see
 * PROTOCOL-FINDINGS 4.3), so the number of sockets scales with devices × wanted
 * streams. Keeping them grouped per device makes the teardown story obvious:
 * stop the manager, every socket for that device is gone.
 */

import { EventEmitter } from 'node:events'
import type { RecordingType } from '@shared/domain/models'
import type { StreamKind } from '@shared/domain/monitoring'
import { AppError, ErrorCodes } from '@shared/errors'
import { deviceLog } from '../logging/logger'
import { STREAM_PROFILES } from './websocket-stream'
import {
  AudioStreamService,
  FeatureStreamService,
  SpectrogramStreamService,
  SpectrumStreamService
} from './stream-services'
import { PcmRingBuffer } from '../audio/ring-buffer'
import { concatSamples } from '../audio/pcm-utils'

/**
 * A NOTE ON A DIAGNOSIS THAT TURNED OUT TO BE WRONG
 *
 * An earlier version of this file carried a confident comment claiming the
 * device "stops serving the slow streams during a recording". That conclusion
 * came from observing 0 frames from `/freq_domain` and `/time_freq_domain`
 * whenever recording was active, while the main-process event loop stayed
 * responsive (max 28 ms lag) — which looked like firmware behaviour and was
 * written up as such.
 *
 * It was OUR BUG. `startRecording` called `start(['audio','features'], ...)`,
 * and because `start()` treats its argument as the complete desired stream set,
 * that closed the spectrum and spectrogram sockets the instant a user pressed
 * record. Nothing restarted them. The symptom was perfectly consistent with a
 * device limitation, which is exactly why it survived several rounds of
 * reasoning and only fell out of a controlled experiment (all four streams,
 * recording active: the slow streams deliver their normal ~1.4 fps).
 *
 * KEPT AS A SAFETY NET: a socket that is open and delivers nothing is still
 * indistinguishable from a fault to a user, whatever the cause. So the manager
 * watches the slow streams during a recording and, if they genuinely go quiet,
 * suspends them so the UI can say "paused" instead of showing an empty chart
 * that looks broken. It has not been observed to trigger on this hardware.
 */
export interface StreamManagerOptions {
  deviceId: string
  /** e.g. `ws://192.168.1.50` — derived from the device's HTTP base URL. */
  baseWsUrl: string
  /** Auth headers; measured as `token` and `Authorization` (no Bearer prefix). */
  headers: Record<string, string>
  /** Device sample rate, read once before starting. Drives frame geometry. */
  sampleRate: number
  /** Ring Buffer depth in seconds (spec 4.3 default: 60). */
  ringBufferSeconds: number
  /** Pre-alarm capture length in seconds (spec 4.3 default: 10). */
  preAlarmSeconds: number
  /** Post-alarm capture length in seconds (spec 4.3 default: 20). */
  postAlarmSeconds: number
  /**
   * Select the device's current channel.
   *
   * REQUIRED for the channel tabs to be truthful. `/features_stream` and
   * `/freq_domain` take no channel argument: they report whichever channel the
   * DEVICE has selected, so switching tabs without this would keep showing CH1
   * under a CH2 heading.
   *
   * Optional so the mock and tests can omit it; when absent the manager logs that
   * features and spectrum follow the device rather than the requested channel.
   */
  selectChannel?: (channelId: number) => Promise<void>
  /** Asked before a recording starts; returns false below the disk floor. */
  canRecord: (recordingType: RecordingType) => Promise<boolean>
  /** Persists a finished capture and returns the new recording id. */
  persistRecording: (capture: FinishedCapture) => Promise<{ recordingId: string; relativePath: string }>
  /** Decimated points per audio preview frame. */
  waveformBuckets?: number
}

/** Everything the persistence layer needs to store a finished capture. */
export interface FinishedCapture {
  deviceId: string
  channelIndex: number
  recordingType: RecordingType
  startedAt: number
  endedAt: number
  samples: Float32Array
  sampleRate: number
  channelCount: number
  eventType?: string
}

interface ActiveRecording {
  id: string
  channelIndex: number
  startedAt: number
  blocks: Float32Array[]
  sampleCount: number
  /** Elapsed timer handle, for pushing state to the UI. */
  ticker?: NodeJS.Timeout
}

/** Hard ceiling on a single manual recording, so a forgotten session cannot
 *  consume the disk. At 96 kHz mono float this is ~138 MB. */
const MAX_MANUAL_RECORDING_MS = 6 * 60 * 60 * 1000

/**
 * How long to wait, after a recording starts, before concluding that the device
 * has stopped serving the slow streams.
 *
 * Two seconds is comfortably longer than the ~1.4 fps cadence of
 * `/freq_domain`, so a healthy device always delivers at least one frame inside
 * the window and is never suspended unnecessarily.
 */
const SLOW_STREAM_GRACE_MS = 2000

export class StreamManager extends EventEmitter {
  private readonly options: StreamManagerOptions
  private readonly ringBuffer: PcmRingBuffer

  private features?: FeatureStreamService
  private audio?: AudioStreamService
  private spectrum?: SpectrumStreamService
  private spectrogram?: SpectrogramStreamService

  private recording?: ActiveRecording
  private disposed = false
  /** Slow streams closed because a recording is in progress, in restore order. */
  private suspendedByRecording: StreamKind[] = []
  /** Grace-period timer that decides whether the slow streams need suspending. */
  private slowStreamWatchdog?: NodeJS.Timeout
  /**
   * Streams that were running when the recording began.
   *
   * Restoring from this snapshot (rather than from the list of streams we chose
   * to suspend) is what makes the recovery robust against a device that goes
   * quiet without the watchdog noticing.
   */
  private kindsBeforeRecording: StreamKind[] = []

  /** Which streams the caller asked for, so `state()` can report accurately. */
  private requestedKinds: StreamKind[] = []
  /**
   * Channel index the audio subscriptions are bound to.
   *
   * Mutable because the device fixes the channel per WebSocket connection
   * (verified — PROTOCOL-FINDINGS 4.3): changing it means reopening the socket,
   * which `start()` detects and handles.
   */
  private channelId = 0

  constructor(options: StreamManagerOptions) {
    super()
    this.options = options
    // A fixed-size backing store: the buffer runs for hours, so it must not
    // allocate per frame (see ring-buffer.ts).
    this.ringBuffer = new PcmRingBuffer({
      sampleRate: options.sampleRate,
      channelCount: 1,
      capacitySeconds: options.ringBufferSeconds
    })
  }

  get deviceId(): string {
    return this.options.deviceId
  }

  /** Channel the audio subscriptions are currently bound to. */
  get currentChannelId(): number {
    return this.channelId
  }

  get isRunning(): boolean {
    return this.features !== undefined || this.audio !== undefined
  }

  get isRecording(): boolean {
    return this.recording !== undefined
  }

  /** The live services, so the IPC layer can attach push forwarding. */
  get services(): {
    features?: FeatureStreamService
    audio?: AudioStreamService
    spectrum?: SpectrumStreamService
    spectrogram?: SpectrogramStreamService
  } {
    return {
      ...(this.features ? { features: this.features } : {}),
      ...(this.audio ? { audio: this.audio } : {}),
      ...(this.spectrum ? { spectrum: this.spectrum } : {}),
      ...(this.spectrogram ? { spectrogram: this.spectrogram } : {})
    }
  }

  /**
   * Open the requested streams.
   *
   * Idempotent: calling it again with the same kinds does nothing, and calling
   * it with a different set only adds or removes what changed. That matters
   * because the UI calls it on every channel switch and every page revisit.
   */
  start(kinds: readonly StreamKind[], channelId = 0): void {
    if (this.disposed) throw new AppError(ErrorCodes.UNKNOWN, '流管理器已释放')

    // Channel changes require a full restart: the subscription channel is fixed
    // per connection, so the sockets must be reopened.
    // The channel is baked into the subscription ping at construction time, so
    // a change requires rebuilding the sockets rather than mutating a field.
    const channelChanged = channelId !== this.channelId
    if (channelChanged) {
      if (this.isRunning) this.stopAll()
      this.channelId = channelId
    }
    /*
     * 2026-09-23「通道一没有读到特征帧」修复：通道选择**不再只在切换时发送**。
     *
     * 旧条件 `channelId !== this.channelId` 意味着：应用启动后第一次开流
     * （管理器初值 0 = 目标 0）时，一次 `/channel_select` 都不会发——设备就停在
     * 它自己 web 界面或上一次会话留下的通道上推流。帧里的 `cur_ch` 与渲染层的
     * 订阅通道对不上，所有帧被 `belongsToSession` 丢掉，那一通道永远显示
     * 「没有读到特征帧」。特征流与频谱跟随**设备**的当前通道（§4.3），所以
     * 每次开流（含首次）都要把设备切到目标通道； reconcile（同通道换 kinds）
     * 不重发——那是一次无意义的设备写。
     */
    if (channelChanged || !this.isRunning) {
      const select = this.options.selectChannel
      if (select) {
        void select(channelId).catch((error: unknown) => {
          deviceLog().warn('Channel selection on the device failed; features may report another channel', {
            deviceId: this.deviceId,
            requested: channelId,
            reason: error instanceof Error ? error.message : String(error)
          })
        })
      } else {
        deviceLog().debug('No channel selector wired; features and spectrum follow the device', {
          deviceId: this.deviceId
        })
      }
    }

    const wanted = new Set(kinds)

    if (wanted.has('features') && !this.features) this.startFeatures()
    if (wanted.has('audio') && !this.audio) this.startAudio()
    if (wanted.has('spectrum') && !this.spectrum) this.startSpectrum()
    if (wanted.has('spectrogram') && !this.spectrogram) this.startSpectrogram()

    if (!wanted.has('features')) this.stopFeatures()
    if (!wanted.has('audio')) this.stopAudio()
    if (!wanted.has('spectrum')) this.stopSpectrum()
    if (!wanted.has('spectrogram')) this.stopSpectrogram()

    this.requestedKinds = [...wanted]
    this.emitState()
    deviceLog().info('Monitor streams started', {
      deviceId: this.deviceId,
      kinds: this.requestedKinds,
      channelId: this.channelId
    })
  }

  /**
   * Re-emit a service's events on the manager.
   *
   * The manager is the single subscription point for the IPC bridge, so a
   * caller does not have to reach into `services` and attach to four objects —
   * and, more importantly, cannot forget to detach one of them. `stop()` on the
   * service removes its own listeners, and `removeAllListeners()` on the manager
   * clears the forwarding, so the pair always unwinds together.
   */
  private forwardFrom(
    service: EventEmitter,
    events: readonly string[]
  ): void {
    for (const event of events) {
      service.on(event, (payload: unknown) => {
        this.emit(event, payload)
      })
    }
    // Status is re-tagged so the UI can tell WHICH of the four streams changed.
    service.on('status', (payload: unknown) => this.emit('stream-status', payload))
  }

  private commonOptions() {
    return {
      deviceId: this.options.deviceId,
      baseWsUrl: this.options.baseWsUrl,
      headers: this.options.headers,
      channelId: this.channelId
    }
  }

  private startFeatures(): void {
    const service = new FeatureStreamService({
      ...this.commonOptions(),
      profile: STREAM_PROFILES.features as (typeof STREAM_PROFILES)['features']
    })
    this.forwardFrom(service, ['feature'])
    this.features = service
    service.start()
  }

  private startSpectrum(): void {
    const service = new SpectrumStreamService({
      ...this.commonOptions(),
      profile: STREAM_PROFILES.spectrum as (typeof STREAM_PROFILES)['spectrum']
    })
    // The frequency axis is derived from the device sample rate; without this
    // every chart label would be wrong by a constant factor.
    service.setSampleRate(this.options.sampleRate)
    this.forwardFrom(service, ['spectrum'])
    this.spectrum = service
    service.start()
  }

  private startSpectrogram(): void {
    const service = new SpectrogramStreamService({
      ...this.commonOptions(),
      profile: STREAM_PROFILES.spectrogram as (typeof STREAM_PROFILES)['spectrogram']
    })
    this.forwardFrom(service, ['spectrogram'])
    this.spectrogram = service
    service.start()
  }

  private startAudio(): void {
    const service = new AudioStreamService({
      ...this.commonOptions(),
      profile: STREAM_PROFILES.audio as (typeof STREAM_PROFILES)['audio'],
      sampleRate: this.options.sampleRate,
      ...(this.options.waveformBuckets !== undefined
        ? { waveformBuckets: this.options.waveformBuckets }
        : {}),
      // Full-rate samples feed the buffer and the recorder. Doing this in the
      // service's own callback (rather than by subscribing to the decimated
      // preview event) guarantees recording is never lossy, no matter how many
      // UI subscribers there are or how slowly they run.
      onSamples: (samples, frame) => this.ingestSamples(samples, frame.receivedAt)
    })
    this.forwardFrom(service, ['audio'])
    this.audio = service
    service.start()
  }

  /**
   * Every captured sample passes through here, once.
   *
   * @param arrivedAt Wall-clock arrival of the frame, which is the END of the
   *   block it carries. The Ring Buffer models `timestamp` as the START of the
   *   block, so the block's own duration is subtracted — otherwise every alarm
   *   clip would be dated up to one frame (100 ms) late. The error does not
   *   accumulate, but a consistent 100 ms offset in an alarm timeline is exactly
   *   the kind of detail that matters when correlating with other records.
   */
  private ingestSamples(samples: Float32Array, arrivedAt: number): void {
    const blockMs = (samples.length / (this.options.sampleRate * 1)) * 1000
    this.ringBuffer.push(samples, Math.round(arrivedAt - blockMs))

    const recording = this.recording
    if (!recording) return

    recording.blocks.push(samples)
    recording.sampleCount += samples.length

    const elapsed = Date.now() - recording.startedAt
    if (elapsed >= MAX_MANUAL_RECORDING_MS) {
      deviceLog().warn('Manual recording hit the maximum duration; stopping', {
        deviceId: this.deviceId,
        maxMs: MAX_MANUAL_RECORDING_MS
      })
      // Fire and forget: the caller learns through the recording-state event.
      void this.stopRecording().catch(() => undefined)
    }
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  /**
   * Begin a manual recording.
   *
   * The audio stream must already be running — recording is "capture what is
   * arriving", not "open a separate connection". Starting one implicitly keeps
   * the UI from having to know that ordering, and avoids two sockets competing
   * for the same single-channel feed.
   */
  async startRecording(channelId?: number): Promise<{ recordingId: string; startedAt: number }> {
    if (this.recording) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '已有录音正在进行')
    }
    // Recording needs the audio stream, but it must NOT change which streams are
    // otherwise running.
    //
    // A previous version called `start(['audio','features'], channelId)` here,
    // and because `start()` treats its argument as the complete desired set, that
    // SILENTLY CLOSED the spectrum and spectrogram streams the moment a user hit
    // record — and nothing ever restarted them. It looked exactly like a device
    // limitation, which is why it took a measurement to find.
    /** Current streams plus audio, preserving order and avoiding duplicates. */
    const kindsWithAudio = (): StreamKind[] => {
      const kinds = [...this.runningKinds]
      if (!kinds.includes('audio')) kinds.push('audio')
      return kinds
    }

    if (channelId !== undefined && channelId !== this.channelId) {
      // A channel switch genuinely does require reopening the audio socket.
      this.start(kindsWithAudio(), channelId)
    }
    if (!this.audio) {
      // Start audio WITHOUT narrowing the existing set.
      this.start(kindsWithAudio(), this.channelId)
    }
    if (!this.audio) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        '请先启动实时音频监测，再开始录音'
      )
    }

    // Spec 14.4: below the free-space floor, non-essential recording stops.
    // Manual recordings are explicitly never blocked, but the check is still
    // routed through the storage service so the policy lives in one place.
    const allowed = await this.options.canRecord('manual')
    if (!allowed) {
      throw new AppError(ErrorCodes.DISK_FULL, '磁盘剩余空间不足，已阻止录音')
    }

    const startedAt = Date.now()
    const id = `rec_${startedAt.toString(36)}`
    this.recording = { id, channelIndex: this.channelId, startedAt, blocks: [], sampleCount: 0 }

    this.suspendSlowStreams()
    this.emitRecordingState(true, id, startedAt)
    deviceLog().info('Manual recording started', {
      deviceId: this.deviceId,
      channelId: this.channelId,
      recordingId: id
    })

    return { recordingId: id, startedAt }
  }

  /**
   * Finish the active recording and persist it.
   *
   * Returns undefined when nothing was recording, so a double-click on "stop"
   * is harmless rather than an error.
   */
  async stopRecording(): Promise<{ recordingId: string; relativePath: string; durationMs: number; sampleCount: number } | undefined> {
    const recording = this.recording
    if (!recording) return undefined

    // Clear the field FIRST: a frame arriving during persistence must not be
    // appended to a capture that has already been measured and closed.
    this.recording = undefined

    const endedAt = Date.now()
    const samples = concatSamples(recording.blocks)

    // Restore the slow streams the recording displaced (see the measured
    // device limitation on StreamManagerOptions).
    this.resumeSlowStreams()
    this.emitRecordingState(false, recording.id, recording.startedAt)

    if (samples.length === 0) {
      deviceLog().warn('Recording captured no samples; nothing to save', {
        deviceId: this.deviceId,
        recordingId: recording.id
      })
      return undefined
    }

    const saved = await this.options.persistRecording({
      deviceId: this.deviceId,
      channelIndex: recording.channelIndex,
      recordingType: 'manual',
      startedAt: recording.startedAt,
      endedAt,
      samples,
      sampleRate: this.options.sampleRate,
      channelCount: 1
    })

    deviceLog().info('Manual recording saved', {
      deviceId: this.deviceId,
      recordingId: saved.recordingId,
      samples: samples.length,
      durationMs: endedAt - recording.startedAt
    })

    return {
      recordingId: saved.recordingId,
      relativePath: saved.relativePath,
      // AUDIO-anchored, not wall clock. Measured delivery is ~1.08x real time on
      // the tested device, so a wall-clock duration would disagree with the
      // duration the saved file itself reports — and the UI and the player would
      // then contradict each other about the same recording.
      durationMs: Math.round((samples.length / (this.options.sampleRate * 1)) * 1000),
      sampleCount: samples.length
    }
  }


  /**
   * Snapshot the Ring Buffer as a pre-alarm clip.
   *
   * DELIBERATELY DOES NOT PERSIST. `AudioRecordingService.savePreAlarmClip()`
   * owns persistence because it can also capture the POST-alarm window, which
   * is impossible here — this method runs at the alarm instant, before the post
   * window has elapsed.
   *
   * Having both paths persist would produce two differently-sized clips for one
   * alarm, which is worse than a missing feature: an investigator would have to
   * guess which file is authoritative. So the alarm handler takes this snapshot
   * immediately (to secure the pre-alarm audio before the buffer overwrites it)
   * and hands it to the service once the post window has elapsed.
   *
   * @returns the buffered samples, or undefined when the buffer is empty.
   */
  capturePreAlarm(): { samples: Float32Array; startedAt: number } | undefined {
    const seconds = this.options.preAlarmSeconds
    if (seconds <= 0) return undefined

    const snapshot = this.ringBuffer.snapshotSeconds(seconds)
    if (snapshot.samples.length === 0) return undefined

    return { samples: snapshot.samples, startedAt: snapshot.startTime }
  }

  /** The Ring Buffer, for an alarm handler that needs the full window. */
  get buffer(): PcmRingBuffer {
    return this.ringBuffer
  }

  /** Post-alarm capture window, for the caller to schedule. */
  get postAlarmSeconds(): number {
    return this.options.postAlarmSeconds
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  private stopFeatures(): void {
    this.features?.stop()
    this.features = undefined
  }

  private stopAudio(): void {
    this.audio?.stop()
    this.audio = undefined
  }

  private stopSpectrum(): void {
    this.spectrum?.stop()
    this.spectrum = undefined
  }

  private stopSpectrogram(): void {
    this.spectrogram?.stop()
    this.spectrogram = undefined
  }

  private stopAll(): void {
    this.stopFeatures()
    this.stopAudio()
    this.stopSpectrum()
    this.stopSpectrogram()
  }

  /**
   * Stop everything and release resources.
   *
   * Spec appendix C rule 12 requires every stream to be cancellable and cleaned
   * up on exit. An in-flight recording is NOT silently discarded: it is stopped
   * so the caller's persistence path runs, which is why this method is async.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    if (this.recording) {
      // Best effort: persist what was captured rather than losing the user's
      // recording because they closed the window.
      await this.stopRecording().catch((error: unknown) => {
        deviceLog().warn('Failed to persist recording during shutdown', {
          deviceId: this.deviceId,
          reason: error instanceof Error ? error.message : String(error)
        })
      })
    }

    if (this.slowStreamWatchdog) {
      clearTimeout(this.slowStreamWatchdog)
      this.slowStreamWatchdog = undefined
    }

    this.stopAll()
    this.ringBuffer.clear()

    // Emit BEFORE removing listeners, so the renderer learns the session ended
    // rather than being left with a stale "running" badge.
    this.emitState()
    this.removeAllListeners()
  }

  /** Current running kinds, for `MONITOR_STATE`. */
  get runningKinds(): StreamKind[] {
    const kinds: StreamKind[] = []
    if (this.features) kinds.push('features')
    if (this.audio) kinds.push('audio')
    if (this.spectrum) kinds.push('spectrum')
    if (this.spectrogram) kinds.push('spectrogram')
    return kinds
  }

  /**
   * Push recording state to the UI, plus the authoritative session state.
   *
   * `elapsedMs` is AUDIO-anchored, matching the duration the saved file will
   * report. A wall-clock timer would drift from it (measured delivery is ~1.08x
   * real time), so the on-screen timer and the finished recording's duration
   * would disagree — a small inconsistency that erodes trust in every other
   * number on the page.
   */
  private emitRecordingState(active: boolean, recordingId: string, startedAt: number): void {
    const elapsedMs = this.recording ? this.audioElapsedMs() : undefined

    const event = {
      deviceId: this.deviceId,
      channelId: this.channelId,
      active,
      recordingId,
      startedAt,
      ...(elapsedMs !== undefined ? { elapsedMs } : {})
    }
    this.emit('recording-state', event)
    this.emitState()
  }

  /**
   * Arm the watchdog that detects a genuinely silent slow stream.
   *
   * Closing a silent stream (rather than leaving it open and idle) is
   * deliberate: an open socket delivering nothing looks like a fault, whereas a
   * stream that is not running can be reported as "paused" with confidence.
   *
   * The grace period exists so a HEALTHY device is never disturbed — at ~1.4 fps
   * a working `/freq_domain` always delivers inside two seconds.
   */
  private suspendSlowStreams(): void {
    // Give the device a grace period first: the starvation is intermittent, and
    // closing a healthy stream would blank charts the user is watching.
    // Snapshot which slow streams are running NOW. They must all be running
    // again when the recording ends, regardless of whether they had to be
    // suspended — otherwise a stream can be lost silently.
    //
    // A previous version compared a cumulative frame COUNTER captured here
    // against the counter in the watchdog. That was wrong: frames received
    // BEFORE the recording (the stream runs for a while before the user hits
    // record) made the watchdog believe the device was still pushing, so it
    // never suspended — and when the device then went quiet, the streams were
    // dropped permanently with nothing to restore them.
    this.kindsBeforeRecording = this.runningKinds

    const framesAtWatchdogStart = this.slowFrameTotal

    this.slowStreamWatchdog = setTimeout(() => {
      this.slowStreamWatchdog = undefined
      if (!this.recording || this.disposed) return

      // No frames since the WATCHDOG began (not since the recording began) ->
      // the device has stopped serving the slow streams for this recording.
      if (this.slowFrameTotal > framesAtWatchdogStart) return

      this.suspendedByRecording = []
      if (this.spectrum) {
        this.suspendedByRecording.push('spectrum')
        this.stopSpectrum()
      }
      if (this.spectrogram) {
        this.suspendedByRecording.push('spectrogram')
        this.stopSpectrogram()
      }
      if (this.suspendedByRecording.length > 0) {
        deviceLog().info('Slow streams delivered nothing while recording; suspended', {
          deviceId: this.deviceId,
          suspended: this.suspendedByRecording,
          graceMs: SLOW_STREAM_GRACE_MS
        })
        this.emitState()
      }
    }, SLOW_STREAM_GRACE_MS)
    this.slowStreamWatchdog.unref?.()
  }

  /** Frames received from the two slow streams, for the starvation watchdog. */
  private get slowFrameTotal(): number {
    return (this.spectrum?.frameCount ?? 0) + (this.spectrogram?.frameCount ?? 0)
  }

  /**
   * Reopen whatever `suspendSlowStreams` closed.
   *
   * @returns the kinds that were restored, so the caller can log or report them.
   */
  private resumeSlowStreams(): StreamKind[] {
    if (this.slowStreamWatchdog) {
      clearTimeout(this.slowStreamWatchdog)
      this.slowStreamWatchdog = undefined
    }

    this.suspendedByRecording = []

    // Guard against a stop() that raced the resume: reopening here would
    // resurrect a stream the caller had already torn down.
    if (this.disposed) return []

    /**
     * Restore everything that was running before the recording.
     *
     * Driven by the pre-recording snapshot rather than by which streams were
     * suspended, so a stream the device silently starved WITHOUT triggering the
     * watchdog is still brought back. A `!this.x` guard keeps this idempotent
     * when the stream never stopped.
     */
    const restored: StreamKind[] = []
    const wanted = this.kindsBeforeRecording
    this.kindsBeforeRecording = []

    for (const kind of wanted) {
      if (kind === 'spectrum' && !this.spectrum) {
        this.startSpectrum()
        restored.push('spectrum')
      } else if (kind === 'spectrogram' && !this.spectrogram) {
        this.startSpectrogram()
        restored.push('spectrogram')
      }
    }

    if (restored.length > 0) {
      deviceLog().info('Restored slow streams after the recording', {
        deviceId: this.deviceId,
        restored
      })
      this.emitState()
    }
    return restored
  }

  /** True while a recording has the slow streams suspended. */
  get slowStreamsSuspended(): boolean {
    return this.suspendedByRecording.length > 0
  }

  /** Audio-anchored elapsed capture time, or undefined when not recording. */
  get recordingElapsedMs(): number | undefined {
    if (!this.recording) return undefined
    return this.audioElapsedMs()
  }

  /** Milliseconds of audio captured in the active session, from sample count. */
  private audioElapsedMs(): number {
    const recording = this.recording
    if (!recording) return 0
    return Math.round((recording.sampleCount / (this.options.sampleRate * 1)) * 1000)
  }

  /**
   * Emit the authoritative session state.
   *
   * Called on every lifecycle change so the renderer never has to infer whether
   * a session is alive from the absence of data. Without this, a main-process
   * teardown (device lost, stream error, shutdown) would leave the UI showing a
   * healthy "running" badge while nothing arrives — the failure mode that looks
   * most like success.
   */
  emitState(): void {
    const elapsedMs = this.recording ? this.audioElapsedMs() : undefined
    this.emit('state', {
      deviceId: this.deviceId,
      channelId: this.channelId,
      running: this.runningKinds,
      recording: this.isRecording,
      ...(this.recording ? { recordingStartedAt: this.recording.startedAt } : {}),
      ...(this.recording ? { recordingId: this.recording.id } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {})
    })
  }
}
