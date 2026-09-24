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
import { MAX_FEATURE_CHANNELS } from '@shared/domain/monitoring'
import type { FeatureStreamEvent, MonitorFeatureChannel } from '@shared/domain/monitoring'
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

/**
 * 规范化界面勾选的特征通道：只留合法整数通道号、去重、升序、封顶。
 *
 * `channelId`（当前通道）永远在集合里：主 socket 一直在推它，界面把它当作
 * "当前这一路"，若勾选集合里没有它，多通道卡片就少了一条本可以画的线。
 *
 * 封顶用 `MAX_FEATURE_CHANNELS`（shared）：一条勾选 = 一条连接，这个上限是
 * 设备与 IPC 的代价上限，渲染层的勾选框用的是同一个数。
 */
function normalizeFeatureChannels(
  channels: readonly number[] | undefined,
  channelId: number
): number[] {
  const seen = new Set<number>([channelId])
  for (const channel of channels ?? []) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 63) continue
    seen.add(channel)
  }
  return [...seen].sort((left, right) => left - right).slice(0, MAX_FEATURE_CHANNELS)
}

export class StreamManager extends EventEmitter {
  private readonly options: StreamManagerOptions
  private readonly ringBuffer: PcmRingBuffer

  private features?: FeatureStreamService
  private audio?: AudioStreamService
  private spectrum?: SpectrumStreamService
  private spectrogram?: SpectrogramStreamService

  /**
   * 多通道同时显示（业主 2026-09-24）：勾选的每一路额外通道 = 一条额外连接。
   *
   * 实测一条 `/features_stream` 连接只推一路（PROTOCOL-FINDINGS 4.3），而它的订阅
   * ping 里**没有**通道参数（§4B）。所以"多路同时刷新"能不能成立，取决于固件是否把
   * 通道绑在连接上 —— 未在真机验证。这一版按"能"建连，并按**帧里自带的 `cur_ch`**
   * 如实汇报每一路到底有没有来；来不了就报 `frames: 0`，界面写"未收到这一路"。
   * 详细取舍见 `docs/PROTOCOL-FINDINGS.md` §4B.4 与 `WebSocketStreamOptions.channelInPing`。
   */
  private extraFeatures = new Map<number, FeatureStreamService>()
  /** 界面勾选的通道（含当前通道）；`start()` 每次都会整体替换。 */
  private featureChannelIds: number[] = []
  /** 每条额外连接的真实表现，用于 `state()` 的如实汇报。 */
  private featureChannelReports = new Map<
    number,
    { observedChannelId?: number; frames: number; lastFrameAt?: number }
  >()
  /**
   * 正在编排（切通道 → 建连）中的额外通道。
   *
   * 存在的唯一理由是**别对设备重复写**：勾选框点得比编排快时，两轮编排会同时跑，
   * 没有这个集合就会对同一路发两次 `/channel_select`（真机上是一次无意义的设备写）。
   */
  private featureChannelPending = new Set<number>()
  /**
   * 额外连接的编排序号（切通道 / 改勾选都会 +1）。
   *
   * 编排是异步的（先 `/channel_select`，再建连），中途用户又改了一次勾选就会有两轮
   * 同时在跑；序号让旧的一轮在下一个 await 之后自行退出，不至于把已经取消的通道又打开。
   */
  private featureSyncSeq = 0

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
   *
   * @param featureChannelIds channels the renderer wants FEATURE frames for
   *   (业主 2026-09-24 multi-channel view). `channelId` is always one of them —
   *   it is what the primary socket already streams — and every other entry gets
   *   its own `/features_stream` connection. Absent/empty = exactly the previous
   *   single-channel behaviour, so a caller that does not know about this option
   *   (an older renderer, the mock, a test) is unaffected.
   */
  start(
    kinds: readonly StreamKind[],
    channelId = 0,
    featureChannelIds?: readonly number[]
  ): void {
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

    /*
     * 多通道：勾选集合整体替换（含当前通道，它由主 socket 负责）。没要 features
     * 就一条额外连接都不留 —— 否则"关掉特征流"之后，多出来的那几条还在推。
     */
    this.featureChannelIds = normalizeFeatureChannels(featureChannelIds, channelId)
    if (wanted.has('features')) this.syncExtraFeatureStreams()
    else this.stopExtraFeatureStreams()

    this.requestedKinds = [...wanted]
    this.emitState()
    deviceLog().info('Monitor streams started', {
      deviceId: this.deviceId,
      kinds: this.requestedKinds,
      channelId: this.channelId,
      featureChannels: this.featureChannelIds
    })
  }

  /**
   * 让"额外通道连接"与勾选集合对齐：不想要的关掉，缺的补上（编排见下）。
   *
   * 与四个主流一样是增量的：勾第 3 路不该把已经跑着的第 2 路关掉重开。
   */
  private syncExtraFeatureStreams(): void {
    const wanted = this.featureChannelIds.filter((id) => id !== this.channelId)

    for (const [channelId, service] of [...this.extraFeatures]) {
      if (wanted.includes(channelId)) continue
      service.stop()
      this.extraFeatures.delete(channelId)
      this.featureChannelReports.delete(channelId)
      this.featureChannelPending.delete(channelId)
      deviceLog().info('Extra feature stream closed', { deviceId: this.deviceId, channelId })
    }

    /*
     * 需要建的 = 勾选里**还没有连接**的通道，包括"上一轮正在编排、还没建好"的那些。
     *
     * 不能把正在编排的排除在外：编排是异步的（`PUT /channel_select` → 建连），
     * 新一轮会把旧一轮的序号作废（旧一轮在下一个 await 就退出），所以旧一轮没建完的活
     * 必须由新一轮接手 —— 排除它们就会**漏建一条连接**（实测：连点两个勾选框，
     * 第二路永远没有帧）。
     */
    const alreadyPending = new Set(this.featureChannelPending)
    const missing = wanted.filter((channelId) => !this.extraFeatures.has(channelId))
    if (missing.length === 0) return

    for (const channelId of missing) this.featureChannelPending.add(channelId)
    // 取消上一轮还没走完的编排（用户在编排途中又改了勾选）。
    const seq = (this.featureSyncSeq += 1)
    void this.openExtraFeatureStreams(missing, seq, alreadyPending)
  }

  /**
   * 打开额外通道的连接：**先在设备上切到这一路，再建连，最后把设备切回当前通道**。
   *
   * 为什么要有"切过去再建连"这一步：`/features_stream` 的订阅没有通道参数，
   * 唯一的通道线索是设备的"当前通道"。若固件是在**握手时**把当前通道绑到这条连接上
   * （`/audio_stream` 已证实可以按连接分通道），那么"切过去 → 建连"就能让这条连接
   * 停在这一路上。若固件是"跟随设备当前通道"，那么复位之后所有连接都会回到当前通道，
   * 其结果就是**只有当前那一路实时、其余几路 0 帧** —— 界面会照实写"未收到这一路"，
   * 不会拿旧值冒充实时（业主 2026-09-24 选定的口径）。
   *
   * 复位是必须的：频谱 `/freq_domain` 跟随设备当前通道（§4B），不复位就会把频谱
   * 留在最后勾选的那一路上，而操作员看的明明是另一路。
   *
   * @param skipSelect 已经由**上一轮**编排切过去的通道：那一轮已经把它切好了，这一轮
   *   再切一次就是对设备的重复写（真机上会落 flash）。设备当前通道在两次调用之间
   *   只会被这套编排自己改动，所以"别人刚切过"等于"现在还在那一路"。
   */
  private async openExtraFeatureStreams(
    channels: readonly number[],
    seq: number,
    skipSelect: ReadonlySet<number> = new Set<number>()
  ): Promise<void> {
    const select = this.options.selectChannel

    try {
      for (const channelId of channels) {
        if (seq !== this.featureSyncSeq || this.disposed) return
        if (this.extraFeatures.has(channelId)) continue
        if (select && !skipSelect.has(channelId)) {
          try {
            await select(channelId)
          } catch (error) {
            /*
             * 切不过去（通道未启用、设备拒绝）仍然建连：这条连接的帧里带着 `cur_ch`，
             * 界面会看到"没收到这一路"。直接放弃建连反而少了一条诊断线索。
             */
            deviceLog().warn('Could not select a channel before opening its feature stream', {
              deviceId: this.deviceId,
              channelId,
              reason: error instanceof Error ? error.message : String(error)
            })
          }
        }
        if (seq !== this.featureSyncSeq || this.disposed) return
        this.startExtraFeatureStream(channelId)
      }

      if (select && seq === this.featureSyncSeq && !this.disposed) {
        try {
          await select(this.channelId)
        } catch (error) {
          deviceLog().warn('Failed to restore the device channel after the multi-channel setup', {
            deviceId: this.deviceId,
            channelId: this.channelId,
            reason: error instanceof Error ? error.message : String(error)
          })
        }
      }
      this.emitState()
    } finally {
      /*
       * 出队：这条通道**已经有连接**，或者**已经不再被勾选**，才叫"不在编排中"。
       * 不能一律清掉 —— 旧的一轮被新的一轮取代时（seq 变了），它退出时如果无条件清空，
       * 新一轮正在建的那条就会被看成"没人管"，第三轮又会为它再切一次设备通道。
       */
      for (const channelId of channels) {
        if (this.extraFeatures.has(channelId) || !this.featureChannelIds.includes(channelId)) {
          this.featureChannelPending.delete(channelId)
        }
      }
    }
  }

  /** 一条额外通道的连接（实验性：ping 里带上 channel，见 `channelInPing`）。 */
  private startExtraFeatureStream(channelId: number): void {
    const service = new FeatureStreamService({
      ...this.commonOptions(),
      channelId,
      channelInPing: true,
      profile: STREAM_PROFILES.features as (typeof STREAM_PROFILES)['features']
    })
    const report: { observedChannelId?: number; frames: number; lastFrameAt?: number } = {
      frames: 0
    }
    this.featureChannelReports.set(channelId, report)

    service.on('feature', (payload: FeatureStreamEvent) => {
      const observed = payload.feature.channelId
      report.frames += 1
      report.lastFrameAt = payload.feature.timestamp
      if (report.observedChannelId !== observed) {
        report.observedChannelId = observed
        if (observed === channelId) {
          deviceLog().info('Extra feature stream confirmed on its own channel', {
            deviceId: this.deviceId,
            channelId
          })
        } else {
          deviceLog().warn(
            'Extra feature stream reports ANOTHER channel: this firmware does not route /features_stream per connection',
            { deviceId: this.deviceId, requested: channelId, observed }
          )
        }
        /*
         * 这一路"到底推的是哪一路"刚刚有了答案 —— 立刻把会话状态推一次。
         *
         * 不推的话界面只能等到下一次会话变化才知道（那几个状态推送很稀疏），于是
         * 悬停说明会长时间停在"未收到这一路"的通用解释上，而设备其实已经明确告诉了
         * 我们它推的是另一路 —— 那正好是排障最需要的一句话。
         */
        this.emitState()
      }
      // 只有帧里 `cur_ch` 就是这一路的帧才转发？不 —— 全部转发，让渲染层按 `cur_ch`
      // 归类。丢掉"串台"的帧等于把设备的行为藏起来，而界面本就要照实显示。
      this.emit('feature', payload)
    })
    // 额外连接的状态只进日志，不进 `stream-status`：那一栏是"四个流各自的健康"，
    // 8 条 features 连接轮流改写它只会让状态灯乱闪，什么也说明不了。
    service.on('status', (status: { state: string; retries: number }) => {
      deviceLog().debug('Extra feature stream status', {
        deviceId: this.deviceId,
        channelId,
        state: status.state,
        retries: status.retries
      })
    })

    this.extraFeatures.set(channelId, service)
    service.start()
    deviceLog().info('Extra feature stream opened', { deviceId: this.deviceId, channelId })
  }

  private stopExtraFeatureStreams(): void {
    // 先让 in-flight 的编排失效，再关连接。
    this.featureSyncSeq += 1
    for (const service of this.extraFeatures.values()) service.stop()
    this.extraFeatures.clear()
    this.featureChannelReports.clear()
    this.featureChannelPending.clear()
  }

  /** 每条额外连接的真实表现：界面据此说"这一路收到了 / 没收到"。 */
  get featureChannels(): MonitorFeatureChannel[] {
    return this.featureChannelState()
  }

  private featureChannelState(): MonitorFeatureChannel[] {
    return this.featureChannelIds.map((channelId) => {
      if (channelId === this.channelId) {
        return { channelId, primary: true, frames: this.features?.frameCount ?? 0 }
      }
      const report = this.featureChannelReports.get(channelId)
      return {
        channelId,
        primary: false,
        frames: report?.frames ?? 0,
        ...(report?.observedChannelId !== undefined
          ? { observedChannelId: report.observedChannelId }
          : {}),
        ...(report?.lastFrameAt !== undefined ? { lastFrameAt: report.lastFrameAt } : {})
      }
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

    /*
     * 这两个 `start()` 也必须带上当前的多通道勾选：否则一按录音就会把额外通道的
     * 连接当成"不再需要"而关掉 —— 与上面那条"录音顺手关掉频谱"的历史 bug 是同一个
     * 形状的坑（`start()` 的参数是**完整**的期望集合，不是增量）。
     */
    if (channelId !== undefined && channelId !== this.channelId) {
      // A channel switch genuinely does require reopening the audio socket.
      this.start(kindsWithAudio(), channelId, this.featureChannelIds)
    }
    if (!this.audio) {
      // Start audio WITHOUT narrowing the existing set.
      this.start(kindsWithAudio(), this.channelId, this.featureChannelIds)
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
    this.stopExtraFeatureStreams()
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
      // 多通道：把"每一路到底有没有帧"随会话状态一起报给界面（业主 2026-09-24）。
      featureChannels: this.featureChannelState(),
      ...(this.recording ? { recordingStartedAt: this.recording.startedAt } : {}),
      ...(this.recording ? { recordingId: this.recording.id } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {})
    })
  }
}
