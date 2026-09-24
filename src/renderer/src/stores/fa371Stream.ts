/**
 * FA371 acoustic-camera realtime stream store (manual §5.2).
 *
 * WHY THIS EXISTS SEPARATELY FROM `stores/monitor.ts`
 * `monitor.ts` owns ONE session of the acoustic BOX (`/features_stream`,
 * `/audio_stream`, `/freq_domain`, `/time_freq_domain`) with its own channel
 * concept and recording state. The camera's five channels are a different
 * protocol with different payload kinds, a different device family and a
 * different session API (`window.api.fa371Stream`). Folding them into one store
 * would put a `kind === 'acousticCamera'` branch in every action of a page that
 * otherwise never mentions cameras. The SHAPE of the two stores is deliberately
 * parallel (buffers + status map + subscribe/unsubscribe pairing) so the leak
 * discipline below is the same contract in both.
 *
 * THE MEASURED FACTS THAT SHAPE IT (2026-09-15, 192.168.110.235)
 *   - every channel pushes ~10 frames/s (energy ~30/s), not the 1-5/s the manual
 *     claims, so "history" is capped hard — see the limits below;
 *   - `/voiceprintData` is a JPEG image (~45 kB), NOT a numeric matrix, so it is
 *     kept as the latest frame only and counted in bytes, never accumulated;
 *   - `/pcmData` arrives as a 512-point envelope per 100 ms frame, not raw PCM.
 *
 * HONESTY RULES ENCODED HERE
 *   1. A channel that has delivered nothing is `undefined`, never a zeroed frame.
 *      A silent socket and a quiet room must not render the same way.
 *   2. `staleAfterMs` marks a channel that HAS delivered data but has since gone
 *      quiet, because a frozen last frame is more misleading than an empty panel.
 *   3. Nothing in this store derives signal data: the main process already
 *      decimated, and re-deriving here would display a different picture.
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  Fa371DetectFeedbackPreview,
  Fa371EnergyPreview,
  Fa371FftPreview,
  Fa371InfraredPreview,
  Fa371MonitorState,
  Fa371PcmPreview,
  Fa371PrpdPreview,
  Fa371StreamKind,
  Fa371StreamStatus,
  Fa371VoiceprintPreview
} from '@shared/domain/fa371-stream'
import { FA371_STREAM_KINDS } from '@shared/domain/fa371-stream'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'

/** Session lifecycle as the camera panel cares about it. */
export type CameraStreamSessionState = 'idle' | 'starting' | 'running' | 'error'

/**
 * How many `/pcmData` envelopes are kept for the rolling waveform.
 *
 * MEASURED: one envelope per 100 ms frame at ~10 frames/s, so 100 frames is
 * ~10 s of history — one screenful of an oscilloscope and small (512 numbers
 * each, ~50 kB total). Keeping the full session would be 36,000 arrays per hour
 * for a trace nobody scrolls back through.
 */
export const FA371_PCM_ENVELOPE_LIMIT = 100

/**
 * How many detection logs are kept.
 *
 * `/detectFeedback` pushes one package per FINISHED detection (section 5.2.3),
 * which may be minutes apart, so this is an event log rather than a stream:
 * 50 entries covers a shift's worth of detections without unbounded growth.
 */
export const FA371_DETECT_LOG_LIMIT = 50

/**
 * A channel is "stale" when it has delivered frames before but nothing for this
 * long. MEASURED cadence is ~10 frames/s; 3 s is 30 missed frames, which cannot
 * happen while a socket is healthy.
 */
export const FA371_STALE_AFTER_MS = 3_000

/** `window.api.fa371Stream.start` takes the full desired set, like `monitor.start`. */
function allKinds(): Fa371StreamKind[] {
  return [...FA371_STREAM_KINDS]
}

export const useFa371StreamStore = defineStore('fa371Stream', () => {
  // -------------------------------------------------------------------------
  // Session identity
  // -------------------------------------------------------------------------

  const deviceId = ref('')
  const state = ref<CameraStreamSessionState>('idle')
  /** Human-readable last failure (already localised by `lib/result.ts`). */
  const error = ref('')
  /** Channels the session was started with, as reported by the main process. */
  const running = ref<Fa371StreamKind[]>([])
  /** Per-channel connection health, keyed by kind. */
  const streams = ref<Partial<Record<Fa371StreamKind, Fa371StreamStatus>>>({})
  /** Authoritative state pushed by the main process, for reconciliation. */
  const monitorState = ref<Fa371MonitorState | null>(null)

  // -------------------------------------------------------------------------
  // Latest-frame buffers (all bounded — see the limits above)
  // -------------------------------------------------------------------------

  const fft = ref<Fa371FftPreview | null>(null)
  const voiceprint = ref<Fa371VoiceprintPreview | null>(null)
  const prpd = ref<Fa371PrpdPreview | null>(null)
  const energy = ref<Fa371EnergyPreview | null>(null)
  /** 声温成像仪红外温度（/inrared_data），只在明确订阅时才有值。 */
  const infrared = ref<Fa371InfraredPreview | null>(null)
  const pcm = ref<Fa371PcmPreview | null>(null)
  /** Recent envelopes, oldest first, capped at FA371_PCM_ENVELOPE_LIMIT. */
  const pcmEnvelopes = ref<Fa371PcmPreview[]>([])
  /** Detection logs, newest first, capped at FA371_DETECT_LOG_LIMIT. */
  const detectLogs = ref<Fa371DetectFeedbackPreview[]>([])

  /** Wall-clock arrival time of the newest frame per channel. */
  const lastFrameAt = ref<Partial<Record<Fa371StreamKind, number>>>({})
  /** Counts of frames this store actually received, per channel. */
  const frameCounts = ref<Record<Fa371StreamKind, number>>({
    fftData: 0,
    voiceprintData: 0,
    prpdData: 0,
    energyData: 0,
    pcmData: 0,
    detectFeedback: 0,
    infraredData: 0
  })
  /** Clock used by the stale computation; bumped by every frame so computeds re-evaluate. */
  const now = ref(Date.now())

  // -------------------------------------------------------------------------
  // Subscription handles (the pairing that must never break)
  // -------------------------------------------------------------------------

  const unsubscribers: Array<() => void> = []

  /** Monotonic token guarding the awaits in `start()`, exactly as `monitor.ts` does. */
  let sessionSeq = 0

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  const isRunning = computed(() => state.value === 'running')
  const isActive = computed(() => state.value === 'running' || state.value === 'starting')

  /**
   * Has this channel delivered ANY frame in the current session?
   *
   * The distinction the panels depend on: `undefined` means "no data yet" and
   * must never be drawn as a flat line, because a flat line is exactly what a
   * working-but-quiet channel looks like.
   */
  function hasFrames(kind: Fa371StreamKind): boolean {
    return frameCounts.value[kind] > 0
  }

  /**
   * Is this channel streaming, quiet, or broken?
   *
   *   'not-started' -> no session, or the channel is not part of it
   *   'no-frames'   -> session running, nothing ever arrived ("no frames yet")
   *   'live'        -> data arrived recently
   *   'stale'       -> data arrived, then stopped (frozen frame; say so)
   *   'error'       -> the socket reported an error
   */
  function channelPhase(kind: Fa371StreamKind): 'not-started' | 'no-frames' | 'live' | 'stale' | 'error' {
    const status = streams.value[kind]
    if (status?.state === 'ERROR') return 'error'
    if (!isActive.value || !running.value.includes(kind)) return 'not-started'
    if (!hasFrames(kind)) return 'no-frames'
    const at = lastFrameAt.value[kind]
    if (at === undefined) return 'stale'
    return now.value - at > FA371_STALE_AFTER_MS ? 'stale' : 'live'
  }

  /** Frame counter to show next to a panel: the main process's, else the local one. */
  function frameCountOf(kind: Fa371StreamKind): number {
    return streams.value[kind]?.frameCount ?? frameCounts.value[kind]
  }

  /** Layout warning for a channel, if the last frame did not match its decode candidate. */
  function layoutWarningOf(kind: Fa371StreamKind): string | undefined {
    return streams.value[kind]?.layoutWarning
  }

  /** Seconds since the last frame, or `undefined` when nothing ever arrived. */
  function silentSeconds(kind: Fa371StreamKind): number | undefined {
    const at = lastFrameAt.value[kind]
    if (at === undefined) return undefined
    return Math.max(0, (now.value - at) / 1000)
  }

  // -------------------------------------------------------------------------
  // Buffer maintenance
  // -------------------------------------------------------------------------

  function pushCapped<T>(target: { value: T[] }, frame: T, limit: number): void {
    target.value.push(frame)
    if (target.value.length > limit) target.value.splice(0, target.value.length - limit)
  }

  /**
   * 帧到达记账。
   *
   * 刻意**不**在这里 bump `now`：它驱动的是 `channelPhase` 的 stale 判定，而页面上
   * 有 1 s 的 `touchClock` 定时器在推这个时钟 —— 每帧都改 `now` 等于让 7 路 × 10 帧/s
   * 的到达事件各触发一次全局重渲染（2026-09-22 视频卡顿修复的一部分）。stale 阈值为 3 s，
   * 1 s 粒度的心跳完全跟得上"断流 → 标 stale"的时序。
   */
  function markArrival(kind: Fa371StreamKind): void {
    frameCounts.value[kind] += 1
    lastFrameAt.value[kind] = Date.now()
  }

  function clearBuffers(): void {
    fft.value = null
    voiceprint.value = null
    prpd.value = null
    energy.value = null
    infrared.value = null
    pcm.value = null
    pcmEnvelopes.value = []
    detectLogs.value = []
    streams.value = {}
    monitorState.value = null
    running.value = []
    frameCounts.value = {
      fftData: 0,
      voiceprintData: 0,
      prpdData: 0,
      energyData: 0,
      pcmData: 0,
      detectFeedback: 0,
      infraredData: 0
    }
    lastFrameAt.value = {}
  }

  // -------------------------------------------------------------------------
  // Push handlers
  // -------------------------------------------------------------------------

  /**
   * Drop frames for a device this store is no longer watching.
   *
   * A push can legitimately arrive after the operator switched device: the main
   * process closed the sockets but a decoded frame was already in flight.
   * Mixing two cameras into one panel would silently mislabel a measurement.
   */
  function belongs(eventDeviceId: string): boolean {
    return eventDeviceId === deviceId.value
  }

  function handleFft(preview: Fa371FftPreview): void {
    if (!belongs(preview.deviceId)) return
    fft.value = preview
    markArrival('fftData')
  }

  function handleVoiceprint(preview: Fa371VoiceprintPreview): void {
    if (!belongs(preview.deviceId)) return
    voiceprint.value = preview
    markArrival('voiceprintData')
  }

  function handlePrpd(preview: Fa371PrpdPreview): void {
    if (!belongs(preview.deviceId)) return
    prpd.value = preview
    markArrival('prpdData')
  }

  function handleEnergy(preview: Fa371EnergyPreview): void {
    if (!belongs(preview.deviceId)) return
    energy.value = preview
    markArrival('energyData')
  }

  function handleInfrared(preview: Fa371InfraredPreview): void {
    if (!belongs(preview.deviceId)) return
    infrared.value = preview
    markArrival('infraredData')
  }

  function handlePcm(preview: Fa371PcmPreview): void {
    if (!belongs(preview.deviceId)) return
    pcm.value = preview
    // The rolling trace is bounded: 100 envelopes x 512 numbers ≈ 10 s of scope.
    // 存进滚动缓冲前剥掉 rawSamples（整帧原始 PCM，200 kHz 下约 80 KB/帧）：
    // 缓冲的消费方只需要 512 点包络与 peak/rms 元数据，而之前 100 份带原始帧的
    // 预览 ≈ 8 MB 常驻 + 每次 push 的结构化克隆开销，是纯浪费（2026-09-22 卡顿修复）。
    pushCapped(pcmEnvelopes, { ...preview, rawSamples: new Float32Array(0) }, FA371_PCM_ENVELOPE_LIMIT)
    markArrival('pcmData')
  }

  function handleDetectFeedback(preview: Fa371DetectFeedbackPreview): void {
    if (!belongs(preview.deviceId)) return
    // Newest first: an event log is read from the top.
    detectLogs.value.unshift(preview)
    if (detectLogs.value.length > FA371_DETECT_LOG_LIMIT) {
      detectLogs.value.splice(FA371_DETECT_LOG_LIMIT)
    }
    markArrival('detectFeedback')
  }

  function handleStreamStatus(status: Fa371StreamStatus): void {
    if (status.deviceId !== deviceId.value) return
    streams.value = { ...streams.value, [status.kind]: status }
    if (status.lastError) error.value = status.lastError
    now.value = Date.now()
  }

  function handleMonitorState(next: Fa371MonitorState): void {
    if (next.deviceId !== deviceId.value) return
    monitorState.value = next
    // `running` is authoritative on the main side: without it a session that
    // ended there (device lost, every socket in ERROR) would leave the UI
    // claiming "running" while nothing can ever arrive.
    running.value = [...next.running]
    for (const status of next.streams) {
      streams.value = { ...streams.value, [status.kind]: status }
    }
  }

  // -------------------------------------------------------------------------
  // Subscribe / unsubscribe
  // -------------------------------------------------------------------------

  /** Install every push listener. Idempotent: a second call would double every frame. */
  function subscribe(): void {
    if (unsubscribers.length > 0) return
    // `window.events` is absent outside Electron (plain `vite` preview).
    if (typeof window === 'undefined' || !window.events) return
    const events = window.events
    unsubscribers.push(
      events.onFa371Fft(handleFft),
      events.onFa371Voiceprint(handleVoiceprint),
      events.onFa371Prpd(handlePrpd),
      events.onFa371Energy(handleEnergy),
      events.onFa371Infrared(handleInfrared),
      events.onFa371Pcm(handlePcm),
      events.onFa371DetectFeedback(handleDetectFeedback),
      events.onFa371StreamStatus(handleStreamStatus),
      events.onFa371StreamState(handleMonitorState)
    )
  }

  /**
   * Release every listener and clear the buffers.
   *
   * MUST be called when the camera page is left. The callbacks live in the
   * preload bridge, not in the component, so dropping the handles would keep
   * this store decoding 45 kB JPEG frames and 10 PCM envelopes per second for
   * the rest of the window's life.
   */
  function unsubscribe(): void {
    for (const release of unsubscribers) {
      try {
        release()
      } catch {
        // One failing release must not strand the others.
      }
    }
    unsubscribers.length = 0
    clearBuffers()
  }

  // -------------------------------------------------------------------------
  // Session actions
  // -------------------------------------------------------------------------

  /** Point the store at a camera without starting anything. Resets the session when it changes. */
  function selectDevice(targetDeviceId: string): void {
    if (deviceId.value === targetDeviceId) return
    deviceId.value = targetDeviceId
    clearBuffers()
    error.value = ''
    state.value = 'idle'
  }

  /**
   * Start (or restart) the five camera channels.
   *
   * ADMINISTRATOR GUARD: `fa371Stream.start` is guarded in the MAIN process —
   * it opens sockets on the hardware. The renderer calls it and renders the
   * refusal as a normal error state, exactly like `cameraLive.start` does; it
   * deliberately does not try to guess the role client-side, because the
   * authoritative check must not be duplicated (a duplicated check is one that
   * can disagree).
   */
  async function start(kinds: readonly Fa371StreamKind[] = allKinds()): Promise<void> {
    if (!deviceId.value) {
      state.value = 'error'
      error.value = 'no-device'
      return
    }
    const seq = (sessionSeq += 1)
    state.value = 'starting'
    error.value = ''

    // Stop the previous session first: the main process reconciles by rebuilding
    // the client, so leaving it running would double every push for one frame gap.
    await stopSession()
    if (seq !== sessionSeq) return

    // Subscribe BEFORE awaiting `start`: the main process begins pushing as soon
    // as its sockets open and there is no replay, so a frame that arrives before
    // the listener exists is simply lost.
    subscribe()

    const result = await callApi(() =>
      window.api.fa371Stream.start({ deviceId: deviceId.value, kinds: [...kinds] })
    )
    if (seq !== sessionSeq) return

    if (!result.success) {
      error.value = resultMessage(result)
      state.value = 'error'
      unsubscribe()
      return
    }

    const snapshot = unwrap(result)
    if (snapshot) {
      running.value = [...snapshot.running]
      streams.value = Object.fromEntries(snapshot.streams.map((status) => [status.kind, status]))
    } else {
      running.value = [...kinds]
    }
    state.value = 'running'
  }

  /** Stop the main-process session without touching `state`; returns a message or ''. */
  async function stopSession(): Promise<string> {
    unsubscribe()
    if (!deviceId.value) return ''
    const result = await callApi(() => window.api.fa371Stream.stop(deviceId.value))
    return result.success ? '' : resultMessage(result)
  }

  /** Stop the session and release every listener. Safe to call twice. */
  async function stop(): Promise<void> {
    sessionSeq += 1
    const message = await stopSession()
    state.value = message ? 'error' : 'idle'
    if (message) error.value = message
  }

  /**
   * Read the main process's authoritative state.
   *
   * Used on mount so a session started elsewhere (or left running by a previous
   * visit) is reflected instead of being reported as "not started".
   */
  async function refreshState(): Promise<void> {
    if (!deviceId.value) return
    const result = await callApi(() => window.api.fa371Stream.state(deviceId.value))
    if (!result.success) return
    const snapshot = unwrap(result)?.[0]
    if (!snapshot) {
      // The main process has no session for this device: say so rather than
      // leaving a stale "running" badge behind.
      if (!isActive.value) return
      state.value = 'idle'
      running.value = []
      return
    }
    monitorState.value = snapshot
    running.value = [...snapshot.running]
    streams.value = Object.fromEntries(snapshot.streams.map((status) => [status.kind, status]))
    if (snapshot.running.length > 0) state.value = 'running'
  }

  /** Tick the stale clock. Called by a component timer while the page is open. */
  function touchClock(): void {
    now.value = Date.now()
  }

  return {
    // session
    deviceId,
    state,
    error,
    running,
    streams,
    monitorState,
    // buffers
    fft,
    voiceprint,
    prpd,
    energy,
    infrared,
    pcm,
    pcmEnvelopes,
    detectLogs,
    frameCounts,
    lastFrameAt,
    // getters
    isRunning,
    isActive,
    hasFrames,
    channelPhase,
    frameCountOf,
    layoutWarningOf,
    silentSeconds,
    // actions
    selectDevice,
    start,
    stop,
    refreshState,
    subscribe,
    unsubscribe,
    touchClock
  }
})
