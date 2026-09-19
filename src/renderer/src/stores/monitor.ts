/**
 * Realtime monitoring store (spec section 9.1).
 *
 * Owns ONE realtime session: which device/channel is being watched, the bounded
 * display buffers fed by the main-process pushes, and the per-stream health the
 * operator needs to tell WHICH feed is broken.
 *
 * WHY A STORE AND NOT A COMPOSABLE IN THE VIEW
 * A session outlives a single component render: the router can unmount the view
 * while the main process is still streaming, and the buffers must be released
 * deterministically. A single owner makes the subscribe/unsubscribe pairing (the
 * most likely leak in this app) a two-line contract instead of a convention
 * repeated in every view.
 *
 * House style (same as `stores/devices.ts`): no action ever throws. Every
 * failure is funnelled into `error` as a human-readable Chinese string, so views
 * can render without defensive try/catch (spec 14.2).
 *
 * WHAT ARRIVES HERE IS ALREADY DISPLAY-READY
 * The main process decimates and derives before pushing: `audio` is a preview
 * (peak/RMS/~128 waveform points), never the 3.8 MB/s PCM; `spectrogram` is the
 * device's own rendered JPEG. Nothing in this store re-derives signal data.
 */

import { computed, ref, type Ref } from 'vue'
import { defineStore } from 'pinia'
import type { DeviceStatus, RealtimeFeature } from '@shared/domain/models'
import {
  monitorSourceState,
  monitorStaleBadgeKey,
  monitorUsesLastContent,
  MONITOR_STALE_AFTER_MS,
  type MonitorSourceState
} from '@shared/domain/monitor-offline'
import {
  channelFeatureFor,
  recordChannelFeature,
  type ChannelFeatureMap
} from '@renderer/lib/channelFeatures'
import type {
  AudioFrameEvent,
  FeatureStreamEvent,
  RecordingStateEvent,
  SpectrogramFrameEvent,
  SpectrumFrameEvent,
  StreamKind,
  StreamStatusEvent
} from '@shared/domain/monitoring'
import { STREAM_KINDS } from '@shared/domain/monitoring'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { i18n } from '@renderer/i18n'

/** Session lifecycle as the UI cares about it. */
export type MonitorSessionState = 'idle' | 'starting' | 'running' | 'error'

/**
 * 「上次内容」的一份快照（业主 2026-09-18 第 10 批第 18 条）。
 *
 * 带上设备与通道：它只对**同一个来源**有意义，切通道/换设备之后它就是别人的数据
 * （把两个通道的信号画在一张图上比不画更糟）。`at` 是最后一帧的时刻，界面用它说
 * 「最后一次 {time}」。
 */
export interface MonitorContent {
  deviceId: string
  channelId: number
  at: number
  features: RealtimeFeature[]
  spectrum: SpectrumFrameEvent | null
  audio: AudioFrameEvent | null
  spectrogramFrames: SpectrogramFrameEvent[]
}

/** 界面此刻要画的那一份（`fromLastContent` = 这不是实时数据）。 */
export interface MonitorContentView {
  features: RealtimeFeature[]
  spectrum: SpectrumFrameEvent | null
  audio: AudioFrameEvent | null
  spectrogramFrames: SpectrogramFrameEvent[]
  fromLastContent: boolean
  at: number | null
}

/**
 * Every stream the device exposes; the monitor page starts all four.
 *
 * The list itself lives in the domain layer next to the `StreamKind` union, so
 * the type, the runtime list and the `domain.streamKind.*` catalogue keys all
 * come from one declaration.
 */
export const ALL_STREAM_KINDS: readonly StreamKind[] = STREAM_KINDS

/**
 * Hard caps on the display buffers.
 *
 * WHY CAPS ARE MANDATORY, NOT TIDINESS
 * A monitoring console is meant to stay open for a whole shift. At 1 Hz an
 * 8-hour session would otherwise accumulate 28,800 `RealtimeFeature` objects in
 * a reactive array; Vue has to walk that array on every dependency check, so
 * every push would get progressively slower and the renderer would grow without
 * bound. The same argument applies to the JPEG frames, where each base64 string
 * is ~55 KB.
 *
 * 600 frames = 10 minutes of trend at the measured 1 Hz feature rate, which is
 * far more than an operator reads on one screen.
 */
export const FEATURE_HISTORY_LIMIT = 600

/**
 * The device's own web UI keeps the last 5 spectrogram images, so matching that
 * number also matches what a trained operator expects to see. 5 x ~55 KB base64
 * is ~275 KB — bounded and cheap to re-render.
 */
export const SPECTROGRAM_FRAME_LIMIT = 5

/** Elapsed-timer state for a manual recording. */
export interface MonitorRecordingState {
  active: boolean
  recordingId?: string
  startedAt?: number
  /** Milliseconds captured so far, as pushed by the main process. */
  elapsedMs?: number
}

function emptyStreamStatus(): Record<StreamKind, StreamStatusEvent | undefined> {
  return { features: undefined, audio: undefined, spectrum: undefined, spectrogram: undefined }
}

function emptyFrameCounts(): Record<StreamKind, number> {
  return { features: 0, audio: 0, spectrum: 0, spectrogram: 0 }
}

export const useMonitorStore = defineStore('monitor', () => {
  // -------------------------------------------------------------------------
  // Session identity
  // -------------------------------------------------------------------------

  const deviceId = ref('')
  const channelId = ref(0)
  const state = ref<MonitorSessionState>('idle')
  const error = ref('')
  /** Streams the current session was started with, for the header status text. */
  const runningKinds = ref<StreamKind[]>([])

  // -------------------------------------------------------------------------
  // Display buffers (all bounded — see the cap constants above)
  // -------------------------------------------------------------------------

  /** Feature frames, oldest first, capped at FEATURE_HISTORY_LIMIT. */
  const features = ref<RealtimeFeature[]>([])
  /** Latest spectrum sweep only; `binHz` is needed to build the frequency axis. */
  const spectrum = ref<SpectrumFrameEvent | null>(null)
  /** Latest decimated audio preview only. */
  const audio = ref<AudioFrameEvent | null>(null)
  /** Spectrogram images, oldest first, capped at SPECTROGRAM_FRAME_LIMIT. */
  const spectrogramFrames = ref<SpectrogramFrameEvent[]>([])
  /** Per-stream connection health, keyed by kind. */
  const streamStatus = ref<Record<StreamKind, StreamStatusEvent | undefined>>(emptyStreamStatus())
  /**
   * 每通道的**最后一次读数**（通道号 -> 特征帧），见 `lib/channelFeatures.ts`。
   *
   * 它故意**不**在 `clearBuffers()` 里清空：切通道 = 停一次会话 = `unsubscribe()` =
   * `clearBuffers()`，而"每通道特性卡片"的全部意义就是切走之后还留着上一路的读数。
   * 清空它的时机是**换了设备**（`selectDevice`）—— 那时那些读数属于另一台设备。
   */
  const channelFeatures = ref<ChannelFeatureMap>({})
  /**
   * Frames actually received by this store, per kind.
   *
   * `StreamStatusEvent.frameCount` is the authoritative counter from the main
   * process, but a status push may be missing (older main process, or a stream
   * that never transitioned). Counting locally lets the status strip still prove
   * "data is arriving" in that case.
   */
  const frameCounts = ref<Record<StreamKind, number>>(emptyFrameCounts())
  const recording = ref<MonitorRecordingState>({ active: false })

  /**
   * 走时的"现在"。
   *
   * `stale`（数据停了）只有在**时间往前走**的时候才会成立，而它必须在没有新帧的情况下
   * 也能成立 —— 所以这个 store 在看这一页的时候挂一个 1 秒的定时器（`subscribe()` 起、
   * `unsubscribe()` 停）。业主第 18 条要的是"没有活数据时说实话"，而"多久没数据了"
   * 是这句话里唯一会随时间变化的部分。
   */
  const now = ref(Date.now())

  /**
   * 「上次内容」（业主第 18 条）：最近一次**有数据**的那一份缓冲。
   *
   * 它与活缓冲分开存，而不是"停了就不清"：清了才好在切通道/切设备时区分
   * "这是上一路的数据"与"这是这一路的历史"。`selectDevice()` 会把它丢掉（那是另一台设备）。
   */
  const lastContent = ref<MonitorContent | null>(null)

  /**
   * 界面上选中的那台设备的在线状态。
   *
   * 由界面注入（`setDeviceStatus()`）：这个 store 不持有设备列表，而"这台设备现在离线吗"
   * 是设备列表的事实。`UNKNOWN`（还没探过）按"还没确认"处理，不算离线 —— 判据在
   * `@shared/domain/monitor-offline.ts`。
   */
  const deviceStatus = ref<DeviceStatus | undefined>(undefined)

  // -------------------------------------------------------------------------
  // Subscription handles
  // -------------------------------------------------------------------------

  /**
   * Unsubscribe functions returned by `window.events.on*`.
   *
   * These are STORED, never discarded. The preload bridge keeps each callback in
   * its own IPC listener list, so a dropped handle means the closure — and this
   * store — stays reachable and keeps receiving decoded frames for the whole
   * life of the window, long after the user left the page.
   */
  const unsubscribers: Array<() => void> = []

  /**
   * Monotonic session id.
   *
   * Guards the awaits in `start()`: a channel switch issues a second `start()`
   * while the first is still awaiting `monitor.stop`/`monitor.start`. Without
   * this token the older call would resume and overwrite the newer session's
   * state (or worse, unsubscribe its listeners).
   */
  let sessionSeq = 0

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  const isRunning = computed(() => state.value === 'running')

  /** Newest feature frame, or null before the first one arrives. */
  const latest = computed<RealtimeFeature | null>(
    () => content.value.features[content.value.features.length - 1] ?? null
  )

  /**
   * 图表与读数此刻应当画哪一份内容：**活的优先，没有活的就用上次内容**。
   *
   * 两个条件缺一不可：
   *   1. 上次内容必须属于**当前**的设备与通道（切通道/换设备之后它属于别人）；
   *   2. 状态必须是"没有活数据"的那几档（`monitorShowsLastContent`）——
   *      在线且正在出帧时显示旧数据就是界面在说一件没发生的事。
   * 只要有一点不成立就回活的（可能是空的），由界面的提示条负责说明原因。
   */
  const content = computed<MonitorContentView>(() => {
    const live: MonitorContentView = {
      features: features.value,
      spectrum: spectrum.value,
      audio: audio.value,
      spectrogramFrames: spectrogramFrames.value,
      fromLastContent: false,
      at: null
    }
    const last = lastContent.value
    if (
      !monitorUsesLastContent({
        snapshot: last,
        deviceId: deviceId.value,
        channelId: channelId.value,
        state: sourceState.value
      }) ||
      !last
    ) {
      return live
    }
    return {
      features: last.features,
      spectrum: last.spectrum,
      audio: last.audio,
      spectrogramFrames: last.spectrogramFrames,
      fromLastContent: true,
      at: last.at
    }
  })

  /** 最近一帧的时刻（活的没有就问上次内容），用来判"数据停了多久"。 */
  const lastFrameAt = computed<number | undefined>(() => {
    const times = [
      features.value[features.value.length - 1]?.timestamp,
      spectrum.value?.timestamp,
      audio.value?.timestamp,
      spectrogramFrames.value[spectrogramFrames.value.length - 1]?.timestamp
    ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (times.length > 0) return Math.max(...times)
    return lastContent.value?.at
  })

  /**
   * 这一页现在处于哪一档（六档，判据在 `@shared/domain/monitor-offline.ts`）。
   *
   * 设备状态由界面通过 `setDeviceStatus()` 注入 —— 这个 store 不持有设备列表
   * （与 `stores/liveWall.ts` 的 `bindDevices` 同一条做法：谁有列表谁传进来）。
   */
  const sourceState = computed<MonitorSourceState>(() =>
    monitorSourceState({
      hasDevice: deviceId.value !== '',
      ...(deviceStatus.value !== undefined ? { deviceStatus: deviceStatus.value } : {}),
      sessionState: state.value,
      ...(lastFrameAt.value !== undefined ? { lastFrameAt: lastFrameAt.value } : {}),
      now: now.value
    })
  )

  /**
   * 图表角标的目录键（`null` = 不必标"这不是实时数据"）。
   *
   * **提示条那个键（`sourceMessageKey`）在 2026-09-19 第 13 批第 1 条删掉了**：
   * 业主说那条弹窗「这个内容不用显示」，提示条整个撤掉（见 `monitor-offline.ts` 的注释）。
   * `sourceState` 留着：它是六档状态机的**唯一入口**，角标就是照它算出来的。
   */
  const staleBadgeKey = computed(() => monitorStaleBadgeKey(sourceState.value))

  /** Magnitudes of the latest sweep; empty until the spectrum stream delivers. */
  /**
   * 频谱幅度：取自**此刻该画的那一份**（content）—— 没有活数据时就是上次内容，
   * 这样图表不会在设备掉线的瞬间变成空白（业主第 18 条）。
   */
  const spectrumMagnitudes = computed<number[]>(() => content.value.spectrum?.magnitudes ?? [])

  const newestSpectrogram = computed<SpectrogramFrameEvent | null>(
    () => content.value.spectrogramFrames[content.value.spectrogramFrames.length - 1] ?? null
  )

  /** Latest status for one stream, or undefined when nothing was pushed yet. */
  const statusOf = (kind: StreamKind): StreamStatusEvent | undefined => streamStatus.value[kind]

  /**
   * Frame count for one stream: the main process's counter when it reported one,
   * otherwise the number of frames this store actually received.
   */
  const frameCountOf = (kind: StreamKind): number =>
    streamStatus.value[kind]?.frameCount ?? frameCounts.value[kind]

  // -------------------------------------------------------------------------
  // Buffer maintenance
  // -------------------------------------------------------------------------

  /**
   * Append one frame and drop the oldest ones beyond `limit`.
   *
   * Splicing from the front copies at most `limit` references, so the cost of a
   * push stays O(limit) and constant over an arbitrarily long session — the
   * buffer can never grow into the memory problem described above.
   */
  function pushCapped<T>(target: Ref<T[]>, frame: T, limit: number): void {
    target.value.push(frame)
    if (target.value.length > limit) target.value.splice(0, target.value.length - limit)
  }

  function countFrame(kind: StreamKind): void {
    frameCounts.value[kind] += 1
  }

  function clearBuffers(): void {
    /**
     * 清之前先把这一份**存成"上次内容"**（业主第 18 条：没有活数据时要显示上次内容）。
     *
     * 键是**清除那一刻**的设备与通道：`start()` 是先 `stopSession()`（清）再
     * `channelId.value = target`，所以切通道时快照带的是**旧通道**的号 ——
     * 显示那一边按 (设备, 通道) 过滤，于是切通道之后旧数据不会冒充新通道的读数
     * （把两个通道的信号画在一张图上比不画更糟）。
     */
    lastContent.value = snapshotContent()
    features.value = []
    spectrum.value = null
    audio.value = null
    spectrogramFrames.value = []
    streamStatus.value = emptyStreamStatus()
    frameCounts.value = emptyFrameCounts()
    recording.value = { active: false }
  }

  /** 现在这一份缓冲快照（没有内容可留时给 `null`）。 */
  function snapshotContent(): MonitorContent | null {
    if (
      features.value.length === 0 &&
      spectrum.value === null &&
      audio.value === null &&
      spectrogramFrames.value.length === 0
    ) {
      return null
    }
    const times = [
      features.value[features.value.length - 1]?.timestamp,
      spectrum.value?.timestamp,
      audio.value?.timestamp,
      spectrogramFrames.value[spectrogramFrames.value.length - 1]?.timestamp
    ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    return {
      deviceId: deviceId.value,
      channelId: channelId.value,
      // 一帧都没有时间戳时用当前时间：那句"最后一次 {time}"宁可说现在，也不说 1970。
      at: times.length > 0 ? Math.max(...times) : Date.now(),
      features: [...features.value],
      spectrum: spectrum.value,
      audio: audio.value,
      spectrogramFrames: [...spectrogramFrames.value]
    }
  }

  // -------------------------------------------------------------------------
  // Push handlers
  // -------------------------------------------------------------------------

  /**
   * Drop frames that do not belong to the current session.
   *
   * A push can legitimately arrive after a channel switch: the socket was closed
   * but a frame it had already decoded is still in flight. Splicing two channels
   * into one trend would silently mislabel a measurement, which is worse than
   * dropping a frame, so the filter is deliberate.
   */
  function belongsToSession(eventDeviceId: string, eventChannelId: number): boolean {
    return eventDeviceId === deviceId.value && eventChannelId === channelId.value
  }

  function handleFeature(event: FeatureStreamEvent): void {
    if (!belongsToSession(event.deviceId, event.feature.channelId)) return
    // `FeatureStreamEvent.feature` is `RealtimeFeature` minus `deviceId`, so this
    // is a rename of the envelope, not a protocol mapping.
    const frame: RealtimeFeature = { ...event.feature, deviceId: event.deviceId }
    pushCapped<RealtimeFeature>(features, frame, FEATURE_HISTORY_LIMIT)
    // 顺手记进"每通道最后一次读数"：这一路现在就是活的那一路，读数是新的。
    channelFeatures.value = recordChannelFeature(channelFeatures.value, frame)
    countFrame('features')
  }

  function handleAudio(event: AudioFrameEvent): void {
    if (!belongsToSession(event.deviceId, event.channelId)) return
    // Latest only: the level meter has no use for history, and a preview per
    // 100 ms would be 864,000 waveform arrays per day if it were kept.
    audio.value = event
    countFrame('audio')
  }

  function handleSpectrum(event: SpectrumFrameEvent): void {
    if (!belongsToSession(event.deviceId, event.channelId)) return
    // Latest sweep only. 1024 bins x ~1.4 fps is ~5.7 KB/s; a history would be
    // the second-largest buffer on the page for no operator benefit.
    spectrum.value = event
    countFrame('spectrum')
  }

  function handleSpectrogram(event: SpectrogramFrameEvent): void {
    if (!belongsToSession(event.deviceId, event.channelId)) return
    pushCapped<SpectrogramFrameEvent>(spectrogramFrames, event, SPECTROGRAM_FRAME_LIMIT)
    countFrame('spectrogram')
  }

  function handleStreamStatus(event: StreamStatusEvent): void {
    if (event.deviceId !== deviceId.value) return
    streamStatus.value = { ...streamStatus.value, [event.kind]: event }
  }

  function handleRecordingState(event: RecordingStateEvent): void {
    if (event.deviceId !== deviceId.value) return
    recording.value = {
      active: event.active,
      recordingId: event.recordingId,
      startedAt: event.startedAt,
      elapsedMs: event.elapsedMs
    }
  }

  // -------------------------------------------------------------------------
  // Subscribe / unsubscribe — the pairing that must never break
  // -------------------------------------------------------------------------

  /**
   * Register every realtime push listener and KEEP the returned unsubscribers.
   *
   * Idempotent on purpose: subscribing twice would install a second set of IPC
   * listeners and deliver every frame twice (double-counted frames, double CPU).
   */
  function subscribe(): void {
    if (unsubscribers.length > 0) return
    // 走时与订阅一起起（`stale` 只有时间往前走才会出现）。
    startClock()
    // `window.events` is absent when the renderer runs outside Electron (plain
    // `vite` preview); degrade to a silent no-op instead of crashing.
    if (typeof window === 'undefined' || !window.events) return

    const events = window.events
    unsubscribers.push(
      events.onMonitorFeature(handleFeature),
      events.onMonitorAudio(handleAudio),
      events.onMonitorSpectrum(handleSpectrum),
      events.onMonitorSpectrogram(handleSpectrogram),
      events.onMonitorStatus(handleStreamStatus),
      events.onRecordingState(handleRecordingState)
    )
  }

  /**
   * Release every push listener and clear the display state.
   *
   * MUST be called on unmount. Not calling it is the single most likely bug in
   * this feature: the listeners belong to the preload bridge, not to the
   * component, so they survive navigation and keep decoding frames (and holding
   * the buffers above) until the window closes.
   *
   * One failing release must not strand the others, hence the per-handle
   * try/catch; a freed handle is never kept for a second call.
   */
  function unsubscribe(): void {
    for (const release of unsubscribers) {
      try {
        release()
      } catch {
        // Releasing a listener must never throw into unmount; ignore and continue.
      }
    }
    unsubscribers.length = 0
    if (clockTimer !== undefined) {
      window.clearInterval(clockTimer)
      clockTimer = undefined
    }
    clearBuffers()
  }

  /**
   * 走时（`stale` 那一档要靠时间往前走才会出现）。
   *
   * 只在订阅期间跑（1 秒一次），离开这一页就停 —— 一个常年占着事件循环的定时器
   * 是这个仓库明确不要的东西（与趋势落盘那个定时器同一条规矩）。
   */
  let clockTimer: number | undefined

  function startClock(): void {
    if (clockTimer !== undefined) return
    if (typeof window === 'undefined') return
    clockTimer = window.setInterval(() => {
      now.value = Date.now()
    }, 1_000)
  }

  /** 界面把选中那台设备的在线状态告诉 store（见 `deviceStatus` 的注释）。 */
  function setDeviceStatus(status: DeviceStatus | undefined): void {
    if (deviceStatus.value === status) return
    deviceStatus.value = status
  }

  /** True while the push bridge is installed. Used by the view's status strip. */
  const isSubscribed = (): boolean => unsubscribers.length > 0

  // -------------------------------------------------------------------------
  // Session actions
  // -------------------------------------------------------------------------

  /** Point the session at a device (and reset the channel) without starting it. */
  function selectDevice(targetDeviceId: string): void {
    if (deviceId.value === targetDeviceId) return
    deviceId.value = targetDeviceId
    channelId.value = 0
    // 每通道读数属于**上一台**设备：留着它们会让新设备的通道卡片显示旧设备的数字。
    channelFeatures.value = {}
    // 上次内容同理：它是另一台设备的画面。
    lastContent.value = null
  }

  /** 某一路通道的最后读数；没有读到过就是 `null`。 */
  function channelFeatureOf(targetChannelId: number): RealtimeFeature | null {
    return channelFeatureFor(channelFeatures.value, targetChannelId)
  }

  /**
   * Tear the main-process session down without touching `state`.
   * @returns the failure message, or '' when there was nothing to stop.
   */
  async function stopSession(): Promise<string> {
    unsubscribe()
    runningKinds.value = []
    if (!deviceId.value) return ''
    const result = await callApi(() => window.api.monitor.stop(deviceId.value))
    return result.success ? '' : resultMessage(result)
  }

  /**
   * Start (or restart) the realtime session for the current device/channel.
   *
   * @param kinds streams to run; defaults to all four.
   * @param targetChannelId channel to subscribe to; defaults to the current one.
   */
  async function start(
    kinds: readonly StreamKind[] = ALL_STREAM_KINDS,
    targetChannelId?: number
  ): Promise<void> {
    const target = targetChannelId ?? channelId.value
    if (!deviceId.value) {
      error.value = i18n.global.t('monitorErrors.selectDevice')
      state.value = 'error'
      return
    }
    if (kinds.length === 0) {
      error.value = i18n.global.t('monitorErrors.selectStream')
      state.value = 'error'
      return
    }

    const seq = (sessionSeq += 1)
    state.value = 'starting'
    error.value = ''

    // Stop the previous session FIRST. MEASURED: the device streams ONE channel
    // per WebSocket connection (PROTOCOL-FINDINGS 4.3), so a channel change is a
    // new set of connections, not a re-subscription. Leaving the old sockets
    // open would double the frame rate and mix two sensors into one trend.
    await stopSession()
    if (seq !== sessionSeq) return

    channelId.value = target

    // Subscribe BEFORE awaiting `monitor.start`: the main process begins pushing
    // as soon as its sockets open, and there is no replay — a frame that arrives
    // before the IPC listener exists is simply lost. Subscribing first means the
    // very first frame is already captured.
    subscribe()

    const result = await callApi(() =>
      window.api.monitor.start({ deviceId: deviceId.value, kinds: [...kinds], channelId: target })
    )
    if (seq !== sessionSeq) return

    if (!result.success) {
      error.value = resultMessage(result)
      state.value = 'error'
      // No session exists behind these listeners, so do not keep them alive.
      unsubscribe()
      return
    }

    const snapshot = unwrap(result)
    if (snapshot) {
      channelId.value = snapshot.channelId
      runningKinds.value = [...snapshot.running]
      if (snapshot.recording) {
        recording.value = {
          active: true,
          recordingId: snapshot.recordingId,
          startedAt: snapshot.recordingStartedAt
        }
      }
    } else {
      runningKinds.value = [...kinds]
    }
    state.value = 'running'
  }

  /** Stop the session and release every listener. Safe to call twice. */
  async function stop(): Promise<void> {
    sessionSeq += 1
    const message = await stopSession()
    state.value = message ? 'error' : 'idle'
    if (message) error.value = message
  }

  /**
   * Start a manual recording on the monitored channel.
   *
   * The result is applied optimistically; the authoritative state arrives as a
   * `RecordingStateEvent` push, which is what keeps the elapsed timer honest if
   * the recording is stopped from anywhere else.
   */
  async function startRecording(): Promise<void> {
    if (!deviceId.value) {
      error.value = i18n.global.t('monitorErrors.selectDevice')
      return
    }
    if (state.value !== 'running') {
      error.value = i18n.global.t('monitorErrors.startBeforeRecording')
      return
    }
    const result = await callApi(() =>
      window.api.monitor.startRecording({ deviceId: deviceId.value, channelId: channelId.value })
    )
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    error.value = ''
    const info = unwrap(result)
    recording.value = info
      ? { active: true, recordingId: info.recordingId, startedAt: Date.now() }
      : { active: true }
  }

  /** Stop the manual recording and let the main process finalise the file. */
  async function stopRecording(): Promise<void> {
    if (!deviceId.value) return
    const result = await callApi(() => window.api.monitor.stopRecording(deviceId.value))
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    error.value = ''
    const info = unwrap(result)
    recording.value = info
      ? { active: false, recordingId: info.recordingId, elapsedMs: info.durationMs }
      : { active: false }
  }

  function clearError(): void {
    error.value = ''
  }

  return {
    // session
    deviceId,
    channelId,
    state,
    error,
    runningKinds,
    // buffers
    features,
    spectrum,
    audio,
    spectrogramFrames,
    streamStatus,
    frameCounts,
    recording,
    channelFeatures,
    /** 「上次内容」的快照（业主第 18 条），界面上只用它的时刻。 */
    lastContent,
    deviceStatus,
    now,
    // getters
    isRunning,
    latest,
    /** 此刻该画哪一份（活的优先，没有活的就用上次内容）。 */
    content,
    /** 六档状态（没有设备 / 离线 / 等待 / 实时 / 已停止更新 / 已停止）。 */
    sourceState,
    staleBadgeKey,
    lastFrameAt,
    /** 判"数据停了多久"的阈值（界面说明里要用同一个数）。 */
    staleAfterMs: MONITOR_STALE_AFTER_MS,
    spectrumMagnitudes,
    newestSpectrogram,
    statusOf,
    frameCountOf,
    isSubscribed,
    channelFeatureOf,
    // actions
    selectDevice,
    setDeviceStatus,
    start,
    stop,
    startRecording,
    stopRecording,
    subscribe,
    unsubscribe,
    clearError
  }
})
