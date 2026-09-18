<script setup lang="ts">
/**
 * FA371 camera acoustic streams — the five WebSocket channels, rendered.
 *
 * WHY THIS PANEL EXISTS AT ALL
 * `MonitorView` used to show only the LIVE VIDEO panel for an `acousticCamera`,
 * so the five channels the main process was already receiving had no surface
 * anywhere in the UI. On this particular camera the acoustic streams are the
 * part that actually works (MEASURED: RTSP is not reachable on any port), so
 * this is the panel that carries the information.
 *
 * WHAT IT SHOWS, AND WHAT EACH PANEL REFUSES TO DO
 *   /voiceprintData  the device's own rendered JPEG (MEASURED 2026-09-15:
 *                    600x400 JFIF, ~45 kB, 10 fps). If the payload is NOT a JPEG
 *                    (i.e. a numeric decode candidate such as the mock), it is
 *                    drawn to a canvas as a magnitude map instead. Nothing is
 *                    upscaled from an assumed geometry: a made-up matrix would
 *                    be a picture of the decoder's assumptions, not of the camera.
 *   /pcmData         512-point envelope + peak/rms/crest, plus the envelope
 *                    through WebAudio so a leak is AUDIBLE without watching the
 *                    trace. The waveform is the DECIMATED envelope, so it is a
 *                    presence and rhythm check, not a faithful reproduction —
 *                    the note under the scope says so in every language.
 *   /fftData         the 1024 spectrum lines. The frequency axis is labelled in
 *                    Hz only when the DEVICE reported a sample rate; this camera
 *                    exposes no usable sample-rate endpoint, so the axis is
 *                    labelled by line number and says the frequency scale is
 *                    unknown. An invented Hz axis would be worse than none.
 *   /energyData      the target points (energy, pixel x/y, swath/azimuth) as the
 *                    raw integers they are — the manual defines no units.
 *   /detectFeedback  the text frames. An EVENT channel: an empty list here means
 *                    "no detection finished", not "broken".
 *
 * EMPTY / ERROR / STALE STATES ARE THE POINT
 * Every panel distinguishes "not started", "no frames yet", "stream error" and
 * "stale (data stopped N seconds ago)" from real data. A silent channel and a
 * quiet room are different things, so no panel ever draws a plausible flat line
 * for missing data.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { EChartsCoreOption } from 'echarts/core'
import type { Fa371StreamKind } from '@shared/domain/fa371-stream'
import { FA371_STALE_AFTER_MS, useFa371StreamStore } from '@renderer/stores/fa371Stream'
import { useSessionStore } from '@renderer/stores/session'
import { EMPTY_VALUE, formatBytes, formatNumber } from '@renderer/lib/format'
import { EnvelopePlayer } from '@renderer/lib/envelopePlayer'
import AudioLevelMeter from '@renderer/components/AudioLevelMeter.vue'
import EChart from '@renderer/components/EChart.vue'

const props = defineProps<{
  /** Camera being watched. The panel never reaches a device itself. */
  deviceId: string
}>()

const { t } = useI18n()
const camera = useFa371StreamStore()
const session = useSessionStore()

const busy = ref(false)
const audioEnabled = ref(false)
const audioError = ref('')
const voiceprintCanvas = ref<HTMLCanvasElement | null>(null)

/**
 * Per-channel phase, translated.
 *
 * A map of catalogue KEYS rather than of rendered strings: the label must follow
 * a language change, so nothing here freezes text at module evaluation time.
 */
const PHASE_KEYS: Record<ReturnType<typeof camera.channelPhase>, string> = {
  'not-started': 'cameraStreamUi.phaseNotStarted',
  'no-frames': 'cameraStreamUi.phaseNoFrames',
  live: 'cameraStreamUi.phaseLive',
  stale: 'cameraStreamUi.phaseStale',
  error: 'cameraStreamUi.phaseError'
}

type Kind = Fa371StreamKind

function phase(kind: Kind): ReturnType<typeof camera.channelPhase> {
  return camera.channelPhase(kind)
}

function phaseLabel(kind: Kind): string {
  return t(PHASE_KEYS[phase(kind)])
}

function phaseClass(kind: Kind): string {
  switch (phase(kind)) {
    case 'live':
      return 'acam__state acam__state--ok'
    case 'error':
      return 'acam__state acam__state--error'
    case 'stale':
      return 'acam__state acam__state--warn'
    default:
      return 'acam__state'
  }
}

/** Frame counter, silence and last frame size — so "connected but mute" is visible. */
function phaseMeta(kind: Kind): string {
  const parts = [t('cameraStreamUi.framesCount', { count: camera.frameCountOf(kind) })]
  const silent = camera.silentSeconds(kind)
  if (phase(kind) === 'stale' && silent !== undefined) {
    parts.push(t('cameraStreamUi.silentFor', { seconds: formatNumber(silent, 1) }))
  }
  const bytes = camera.streams[kind]?.lastFrameBytes
  if (bytes !== undefined) parts.push(formatBytes(bytes))
  return parts.join(' · ')
}

/** Same threshold the store uses, so the operator reads the number actually applied. */
const staleSeconds = Math.round(FA371_STALE_AFTER_MS / 1000)

/** The honest empty-state text for a channel: four distinct facts, never one blur. */
function emptyHint(kind: Kind): string {
  const current = phase(kind)
  if (current === 'not-started') return t('cameraStreamUi.hintNotStarted')
  if (current === 'no-frames') return t('cameraStreamUi.hintNoFrames')
  if (current === 'stale') return t('cameraStreamUi.hintStale', { seconds: staleSeconds })
  if (current === 'error') return camera.streams[kind]?.lastError || t('cameraStreamUi.hintError')
  return ''
}

/** A decode candidate whose frame size does not match the wire: surface, never hide. */
function layoutWarning(kind: Kind): string {
  const warning = camera.layoutWarningOf(kind)
  if (!warning) return ''
  const note = camera.streams[kind]?.layoutNote ?? ''
  return note ? `${t('cameraStreamUi.layoutWarning')} (${note})` : t('cameraStreamUi.layoutWarning')
}

// ---------------------------------------------------------------------------
// Session control (ADMIN-GUARDED in the main process — see the store)
// ---------------------------------------------------------------------------

async function toggleSession(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    if (camera.isActive) await camera.stop()
    else await camera.start()
  } finally {
    busy.value = false
  }
}

/**
 * **默认实时接收**（业主 2026-09-18 第 10 批第 23 条：「删除「相机声学数据」窗口、
 * 数据默认实时接收」）。
 *
 * 这一块原来是一个"窗口"：标题 + 状态徽标 + 一颗「开始接收」+ 管理员说明 + 握手信息。
 * 第 23 条把那个窗口删掉、并要求数据默认就在收 —— 于是开启不再是一个动作，而是**选中相机
 * 就发生的事**。
 *
 * 三条不能省的判断：
 *   1. **先 `refreshState()` 再决定**：主进程可能还留着上一次访问时开的会话，
 *      不看就"再开一次"是重复订阅（两套 socket 推同一路数据）；
 *   2. **只有管理员才自动开**：主进程对 `fa371Stream.start` 有角色检查，非管理员点也没用
 *      —— 与其打出一次注定失败的调用，不如把那一句「属于管理员操作」照实显示出来；
 *   3. **失败不吞**：`camera.error` 会被 `sessionError` 渲染成页面上的一句话。
 *      自动开始的坏处正是"用户没点，所以失败了也没人知道"。
 */
async function ensureStreaming(): Promise<void> {
  if (!canStart.value || camera.isActive || busy.value) return
  busy.value = true
  try {
    await camera.start()
  } finally {
    busy.value = false
  }
}

/**
 * The admin guard is enforced by `fa371Stream.start` in the MAIN process: the
 * handler opens sockets on the hardware. Rendering the refusal is this
 * component's only job — mirroring `cameraLive.start` keeps the two device
 * families from disagreeing about who may start a stream, and a duplicated role
 * check is one that can disagree.
 */
const sessionError = computed(() => {
  if (camera.state !== 'error') return ''
  // 'no-device' is a sentinel the store uses when nothing is selected.
  return camera.error === 'no-device' ? t('cameraStreamUi.noDevice') : camera.error
})

/**
 * 非管理员看得到图，但开不了流 —— 那一句说明只在**这种情况**下出现。
 *
 * 用同一个 `session.isAdmin` 判断渲染，而不是等主进程拒绝：主进程那边仍然是唯一的**执行**点
 * （见上面那段注释），这里只是别让操作员对着一排空面板猜为什么。
 */
const canStart = computed(() => session.isAdmin)

/** 握手方式那一条：窗口删掉之后它是状态徽标的悬停说明（支持时要看的就是这个值）。 */
const handshakeTitle = computed(() =>
  camera.monitorState?.handshakeAuthId
    ? t('cameraStreamUi.handshake', { id: camera.monitorState.handshakeAuthId })
    : undefined
)

/** 一行状态：接收中 / 未启动 / 失败。**不**再是一个窗口（第 23 条）。 */
const statusText = computed(() => {
  if (camera.isActive) return t('cameraStreamUi.sessionRunning')
  if (camera.state === 'error') return t('cameraStreamUi.sessionError')
  return t('cameraStreamUi.sessionIdle')
})

// ---------------------------------------------------------------------------
// /fftData — spectrum
// ---------------------------------------------------------------------------

/**
 * Line chart of the integer FFT lines.
 *
 * The x axis is `index` when the device never reported a sample rate — which is
 * the case on this hardware — and `index * binHz` when it did. Labelling lines
 * as Hz without a sample rate would turn a real peak into "line 8".
 */
const fftOption = computed<EChartsCoreOption>(() => {
  const frame = camera.fft
  const bins = frame?.bins ?? []
  const binHz = frame?.binHz
  const points = bins.map((value, index) => [binHz ? index * binHz : index, value])
  return {
    animation: false,
    grid: { left: 60, right: 16, top: 20, bottom: 32 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'value',
      name: binHz ? 'Hz' : t('cameraStreamUi.fftLineAxis'),
      nameTextStyle: { color: '#6B7280', fontSize: 10 },
      axisLine: { lineStyle: { color: '#E5E7EB' } },
      axisLabel: { color: '#6B7280', fontSize: 10 }
    },
    yAxis: {
      type: 'value',
      name: t('cameraStreamUi.fftAmplitudeAxis'),
      nameTextStyle: { color: '#6B7280', fontSize: 10 },
      axisLine: { show: false },
      axisLabel: { color: '#6B7280', fontSize: 10 },
      splitLine: { lineStyle: { color: '#F1F1F2' } }
    },
    series: [
      {
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        data: points,
        lineStyle: { width: 1.1, color: '#4338CA' },
        itemStyle: { color: '#4338CA' }
      }
    ]
  }
})

const fftAxisHint = computed(() => {
  const frame = camera.fft
  if (!frame) return ''
  if (frame.binHz) {
    return t('cameraStreamUi.fftAxisFromDevice', {
      lines: frame.binCount,
      hz: formatNumber(frame.binHz, 1)
    })
  }
  return t('cameraStreamUi.fftAxisUnknown', { lines: frame.binCount })
})

// ---------------------------------------------------------------------------
// /voiceprintData — JPEG image, or a numeric magnitude matrix (numeric candidate)
// ---------------------------------------------------------------------------

const voiceprintDataUrl = computed(() => {
  const frame = camera.voiceprint
  if (!frame?.jpegBase64) return ''
  return `data:image/jpeg;base64,${frame.jpegBase64}`
})

const voiceprintIsMatrix = computed(() => {
  const frame = camera.voiceprint
  return Boolean(
    frame && !frame.jpegBase64 && frame.width > 0 && frame.height > 0 && frame.cells.length > 0
  )
})

const voiceprintMeta = computed(() => {
  const frame = camera.voiceprint
  if (!frame) return ''
  if (frame.jpegBase64) return t('cameraStreamUi.voiceprintJpegMeta', { bytes: frame.jpegBytes ?? 0 })
  if (frame.width > 0) {
    return t('cameraStreamUi.voiceprintMatrixMeta', {
      width: frame.width,
      height: frame.height,
      decimation: frame.decimation
    })
  }
  return ''
})

/**
 * Draw the decimated magnitude matrix with a colour ramp.
 *
 * Only reached for a NUMERIC decode candidate (the offline mock). The real
 * device sends a JPEG, which is rendered as an `<img>`: re-plotting the device's
 * own rendering would produce a different picture from the one the firmware
 * intends, and the geometry would be a guess.
 */
function drawVoiceprintMatrix(): void {
  const canvas = voiceprintCanvas.value
  const frame = camera.voiceprint
  if (!canvas || !frame || !voiceprintIsMatrix.value) return
  const { width, height, cells } = frame
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return

  let peak = 0
  for (const value of cells) {
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
  }

  const image = context.createImageData(width, height)
  for (let index = 0; index < width * height; index += 1) {
    // 0 -> dark blue, 1 -> bright yellow. A magnitude map, so only |value| matters,
    // and an all-zero matrix stays visibly black instead of looking like noise.
    const ratio = peak > 0 ? Math.min(1, Math.abs(cells[index] ?? 0) / peak) : 0
    image.data[index * 4] = Math.round(255 * Math.min(1, ratio * 2))
    image.data[index * 4 + 1] = Math.round(255 * Math.max(0, Math.min(1, ratio * 1.5 - 0.5)))
    image.data[index * 4 + 2] = Math.round(255 * Math.max(0, 1 - ratio * 3))
    image.data[index * 4 + 3] = 255
  }
  context.putImageData(image, 0, 0)
}

watch(
  () => [camera.voiceprint?.timestamp, voiceprintIsMatrix.value],
  () => {
    if (voiceprintIsMatrix.value) drawVoiceprintMatrix()
  },
  { flush: 'post' }
)

// ---------------------------------------------------------------------------
// /pcmData — envelope, level meter and audible playback
// ---------------------------------------------------------------------------

/**
 * Rolling envelope across the kept frames.
 *
 * This is the DECIMATED envelope (512 points per 100 ms frame), so it shows
 * rhythm and presence, not waveform detail. The caption says so rather than
 * implying a fidelity it does not have.
 */
const pcmOption = computed<EChartsCoreOption>(() => {
  const points: number[] = []
  for (const frame of camera.pcmEnvelopes) points.push(...frame.waveform)
  return {
    animation: false,
    grid: { left: 40, right: 12, top: 12, bottom: 18 },
    xAxis: { type: 'category', show: false, data: points.map((_, index) => index) },
    yAxis: {
      type: 'value',
      min: -1,
      max: 1,
      axisLabel: { color: '#6B7280', fontSize: 10 },
      splitLine: { lineStyle: { color: '#F1F1F2' } }
    },
    series: [
      {
        type: 'line',
        showSymbol: false,
        data: points,
        lineStyle: { width: 1, color: '#0F766E' },
        itemStyle: { color: '#0F766E' },
        areaStyle: { color: '#0F766E', opacity: 0.1 }
      }
    ]
  }
})

const pcmMeta = computed(() => {
  const frame = camera.pcm
  if (!frame) return ''
  return t('cameraStreamUi.pcmMeta', {
    samples: frame.samples,
    ms: frame.frameMs,
    rate: frame.sampleRate / 1000
  })
})

/** Crest factor is a cheap "click or hum" signal, and needs no units to be useful. */
const pcmCrest = computed(() => {
  const frame = camera.pcm
  if (!frame || frame.rms <= 0) return undefined
  return frame.peak / frame.rms
})

/**
 * 包络回放：实现搬去了 `lib/audioPreview.ts`。
 *
 * 为什么搬家（业主 2026-09-17 的 ②）：实时监测页的声纹设备那一支需要**同一个**回放
 * ——同一套"浅队列"（最多领先 300 ms）与同一句"播放的不是原声"。两份实现早晚会在
 * 音量、积压这些细节上分叉，而分叉的表现（声音延迟、切页后还在响）最难查。
 *
 * 相机这一支的行为没有变：仍然按下按钮才创建 AudioContext，仍然按 100 ms 一帧排包络。
 */
const player = new EnvelopePlayer()

watch(
  () => camera.pcm?.timestamp,
  () => {
    const frame = camera.pcm
    if (audioEnabled.value && frame) player.push(frame.waveform, frame.frameMs)
  }
)

async function toggleAudio(): Promise<void> {
  audioError.value = ''
  if (audioEnabled.value) {
    audioEnabled.value = false
    await player.suspend()
    return
  }
  try {
    await player.resume()
    audioEnabled.value = true
  } catch (cause) {
    // Autoplay policy or a missing output device: say so instead of claiming "playing".
    audioEnabled.value = false
    audioError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

// ---------------------------------------------------------------------------
// /energyData and /detectFeedback
// ---------------------------------------------------------------------------

const energyTargets = computed(() => camera.energy?.targets ?? [])

/**
 * Envelope text of a detection package whose logs could not be mapped.
 *
 * `rawRet` / `rawMsg` are raw device fields, so this row is a diagnostic dump rather than
 * prose: when the device sent neither of them there is simply nothing to show, and the
 * table's own missing-value placeholder answers that. (This used to ask i18n for a
 * sentence that no catalogue ever defined, so the row rendered a bare key.)
 */
function detectEnvelope(entry: { rawMsg?: unknown; rawRet?: unknown }): string {
  const parts: string[] = []
  if (entry.rawRet !== undefined) parts.push(`ret=${String(entry.rawRet)}`)
  if (entry.rawMsg !== undefined) parts.push(String(entry.rawMsg))
  return parts.length > 0 ? parts.join(' ') : EMPTY_VALUE
}

/** Every detection entry, flattened for the list. */
const detectRows = computed(() => {
  const rows: Array<{ key: string; time: string; text: string }> = []
  for (const entry of camera.detectLogs) {
    const stamp = new Date(entry.timestamp).toLocaleTimeString()
    if (entry.logs.length === 0) {
      // A package with no recognisable log is still an EVENT: show its envelope
      // rather than dropping it silently.
      rows.push({ key: `${entry.timestamp}-envelope`, time: stamp, text: detectEnvelope(entry) })
      continue
    }
    entry.logs.forEach((log, index) => {
      const detail = log.savingPath || log.resultFiles.wav_mic_data || ''
      rows.push({
        key: `${entry.timestamp}-${log.id ?? index}`,
        time: stamp,
        text: `${t('cameraStreamUi.detectMode')} ${String(log.detectMode ?? EMPTY_VALUE)}${
          detail ? ` · ${detail}` : ''
        }`
      })
    })
  }
  return rows
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let clock: ReturnType<typeof setInterval> | undefined

onMounted(async () => {
  camera.selectDevice(props.deviceId)
  // Reflect a session the main process already has (left running by a previous
  // visit) instead of claiming "not started" for a live stream.
  await camera.refreshState()
  // 第 23 条：数据**默认实时接收**（原来要按一次「开始接收」）。
  await ensureStreaming()
  // The stale clock only exists while the page is open; the store's phases are
  // computed from it, so leaving it out would freeze every "stale" badge at "live".
  clock = setInterval(() => camera.touchClock(), 1_000)
})

onBeforeUnmount(() => {
  if (clock !== undefined) clearInterval(clock)
  // Release BOTH halves: the listeners live in the preload bridge, the sockets in
  // the main process. Neither is released by navigation alone.
  void player.close()
  void camera.stop()
  camera.unsubscribe()
})

watch(
  () => props.deviceId,
  async (id) => {
    if (!id) return
    await camera.stop()
    camera.selectDevice(id)
    await camera.refreshState()
    // 换了一台相机同样默认开始接收（第 23 条）。
    await ensureStreaming()
  }
)
</script>

<template>
  <!--
    `camera-board__panel` 是**给探针用的**标记类（不带任何样式）：`scripts/video-proof-driver.cjs`
    用它认出"声学图 + 相机控制这两块应当并排的面板"。没有它，探针只能靠组件的内部
    类名（`.acam` / `.cctl`）去猜哪两块才是那一对。
  -->
  <div class="acam camera-board__panel">
    <!--
      **这里原来是一个窗口**（标题「相机声学数据」+ 状态徽标 + 「开始接收」+ 管理员说明 +
      握手信息）。业主 2026-09-18 第 10 批第 23 条要求删掉那个窗口，并让数据**默认实时接收**，
      所以它变成了**一行状态**：

        · 状态还必须留着 —— 这一块的每张图都会区分"未启动 / 尚无数据 / 已停止"，
          没有这一行的话，"面板是空的"会被读成"环境很安静"（那是本仓库明令禁止的那种错）；
        · 「停止接收」也留着（只在接收中时出现）：默认自动开始之后，如果没有停的地方，
          操作员就没有任何办法关掉它。
    -->
    <div class="acam__status" data-acam-status>
      <span
        class="badge"
        :class="camera.isActive ? 'badge--accent' : ''"
        :title="handshakeTitle"
        data-acam-state
      >
        {{ statusText }}
      </span>
      <button
        v-if="camera.isActive"
        type="button"
        class="btn btn--sm"
        :disabled="busy"
        data-action="acam-stop"
        @click="toggleSession"
      >
        {{ t('cameraStreamUi.stop') }}
      </button>
      <span v-else-if="!canStart" class="muted acam__guard">
        {{ t('cameraStreamUi.adminOnlyHint') }}
      </span>
      <p v-if="sessionError" class="alert alert--danger acam__status-error" role="alert">
        {{ sessionError }}
      </p>
    </div>

    <!--
      视频下方（业主第 24 条）：**声纹图与频谱图 16:9 各占 50%**，并排一行。
      两块的画布都是 `aspect-ratio: 16 / 9`（`.acam__stage--ratio`），空态也用同一个比例 ——
      空面板与有数据的面板一样大，数据来了页面不会跳。
    -->
    <div class="acam__pair" data-acam-pair>
      <!-- ---- 1. voiceprint image ---------------------------------------- -->
      <section class="card acam__panel">
        <div class="section-header">
          <h3 class="section-title">{{ t('cameraStreamUi.voiceprintTitle') }}</h3>
          <span :class="phaseClass('voiceprintData')">{{ phaseLabel('voiceprintData') }}</span>
        </div>
        <span class="muted acam__meta">{{ phaseMeta('voiceprintData') }}</span>
        <p v-if="layoutWarning('voiceprintData')" class="alert alert--warning" role="status">
          {{ layoutWarning('voiceprintData') }}
        </p>

        <div
          v-if="phase('voiceprintData') === 'live' && voiceprintDataUrl"
          class="acam__stage acam__stage--ratio"
        >
          <img class="acam__image" :src="voiceprintDataUrl" :alt="t('cameraStreamUi.voiceprintAlt')" />
        </div>
        <div
          v-else-if="phase('voiceprintData') === 'live' && voiceprintIsMatrix"
          class="acam__stage acam__stage--ratio"
        >
          <canvas ref="voiceprintCanvas" class="acam__canvas"></canvas>
        </div>
        <div v-else class="acam__empty acam__stage--ratio">
          <span>{{ emptyHint('voiceprintData') }}</span>
        </div>
        <p v-if="voiceprintMeta" class="muted acam__meta">{{ voiceprintMeta }}</p>
      </section>

      <!-- ---- 2. FFT spectrum -------------------------------------------- -->
      <section class="card acam__panel">
        <div class="section-header">
          <h3 class="section-title">{{ t('cameraStreamUi.fftTitle') }}</h3>
          <span :class="phaseClass('fftData')">{{ phaseLabel('fftData') }}</span>
        </div>
        <span class="muted acam__meta">{{ phaseMeta('fftData') }}</span>
        <p v-if="layoutWarning('fftData')" class="alert alert--warning" role="status">
          {{ layoutWarning('fftData') }}
        </p>
        <div
          v-if="phase('fftData') === 'live'"
          class="acam__scope acam__stage--ratio"
        >
          <EChart :option="fftOption" height="100%" />
        </div>
        <div v-else class="acam__empty acam__stage--ratio">
          <span>{{ emptyHint('fftData') }}</span>
        </div>
        <p v-if="fftAxisHint" class="muted acam__meta">{{ fftAxisHint }}</p>
      </section>
    </div>

    <!-- ---- 3. live audio (时域波形图) ---------------------------------- -->
    <section class="card acam__panel">
      <div class="section-header">
        <h3 class="section-title">{{ t('cameraStreamUi.audioTitle') }}</h3>
        <span :class="phaseClass('pcmData')">{{ phaseLabel('pcmData') }}</span>
      </div>
      <span class="muted acam__meta">{{ phaseMeta('pcmData') }}</span>
      <p v-if="layoutWarning('pcmData')" class="alert alert--warning" role="status">
        {{ layoutWarning('pcmData') }}
      </p>

      <div class="btn-row">
        <button
          type="button"
          class="btn btn--sm"
          :class="{ 'btn--danger': audioEnabled }"
          :disabled="phase('pcmData') !== 'live'"
          @click="toggleAudio"
        >
          {{ audioEnabled ? t('cameraStreamUi.audioStop') : t('cameraStreamUi.audioPlay') }}
        </button>
        <span v-if="audioError" class="alert alert--danger acam__meta" role="alert">{{ audioError }}</span>
      </div>

      <div v-if="phase('pcmData') === 'live'" class="acam__scope acam__stage--ratio">
        <EChart :option="pcmOption" height="100%" />
      </div>
      <div v-else class="acam__empty acam__stage--ratio">
        <span>{{ emptyHint('pcmData') }}</span>
      </div>

      <AudioLevelMeter
        :peak="camera.pcm?.peak"
        :rms="camera.pcm?.rms"
        :disabled="phase('pcmData') !== 'live'"
        :sample-rate="camera.pcm?.sampleRate"
        :frame-ms="camera.pcm?.frameMs"
      />
      <p v-if="pcmMeta" class="muted acam__meta">{{ pcmMeta }}</p>
      <p v-if="pcmCrest !== undefined" class="muted acam__meta">
        {{ t('cameraStreamUi.pcmCrest', { crest: formatNumber(pcmCrest, 2) }) }}
      </p>
    </section>

    <!--
      能量点与检测结果（短块，两列）。
    -->
    <div class="acam__pair">
      <!-- ---- 4. energy points ------------------------------------------- -->
      <section class="card acam__panel">
        <div class="section-header">
          <h3 class="section-title">{{ t('cameraStreamUi.energyTitle') }}</h3>
          <span :class="phaseClass('energyData')">{{ phaseLabel('energyData') }}</span>
        </div>
        <span class="muted acam__meta">{{ phaseMeta('energyData') }}</span>
        <p v-if="layoutWarning('energyData')" class="alert alert--warning" role="status">
          {{ layoutWarning('energyData') }}
        </p>
        <table v-if="phase('energyData') === 'live' && energyTargets.length > 0" class="acam__table">
          <thead>
            <tr>
              <th scope="col">{{ t('cameraStreamUi.energyValue') }}</th>
              <th scope="col">{{ t('cameraStreamUi.energyPixelX') }}</th>
              <th scope="col">{{ t('cameraStreamUi.energyPixelY') }}</th>
              <th scope="col">{{ t('cameraStreamUi.energySwath') }}</th>
              <th scope="col">{{ t('cameraStreamUi.energyAzimuth') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(target, index) in energyTargets" :key="index">
              <td>{{ target.energy }}</td>
              <td>{{ target.pixelX }}</td>
              <td>{{ target.pixelY }}</td>
              <td>{{ target.swathAngle }}</td>
              <td>{{ target.azimuthAngle }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else-if="phase('energyData') === 'live'" class="acam__empty acam__empty--short">
          <span>{{ t('cameraStreamUi.energyNoTarget') }}</span>
        </div>
        <div v-else class="acam__empty acam__empty--short">
          <span>{{ emptyHint('energyData') }}</span>
        </div>
      </section>

      <!-- ---- 5. detection feedback -------------------------------------- -->
      <section class="card acam__panel">
        <div class="section-header">
          <h3 class="section-title">{{ t('cameraStreamUi.detectTitle') }}</h3>
          <span :class="phaseClass('detectFeedback')">{{ phaseLabel('detectFeedback') }}</span>
        </div>
        <span class="muted acam__meta">{{ phaseMeta('detectFeedback') }}</span>
        <p v-if="layoutWarning('detectFeedback')" class="alert alert--warning" role="status">
          {{ layoutWarning('detectFeedback') }}
        </p>
        <ul v-if="detectRows.length > 0" class="acam__log">
          <li v-for="row in detectRows" :key="row.key">
            <span class="acam__log-time">{{ row.time }}</span>
            <span>{{ row.text }}</span>
          </li>
        </ul>
        <div v-else class="acam__empty acam__empty--short">
          <span>{{ emptyHint('detectFeedback') }}</span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.acam {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/*
 * 一行状态（第 23 条把那个窗口删掉之后留下的最小形态）。
 * 它不是卡片、没有标题：只是一枚状态徽标 + 一颗「停止接收」+（非管理员时）一句说明。
 */
.acam__status {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.acam__status-error {
  flex: 1 1 100%;
  margin: 0;
}

/*
 * 并排两块（第 24 条：声纹图与频谱图 **16:9 各占 50%**）。
 *
 * `minmax(0, 1fr)` 里的 `0` 是必要的：ECharts 的 canvas 会把列撑到内容宽，
 * 用 `auto` 时横向滚动条就出来了（这一条在设备管理那张表上也踩过）。
 * 窄窗口折成一列 —— 两块各 50% 在 700px 以下都读不出坐标轴。
 */
.acam__pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr));
  gap: var(--space-4);
  align-items: start;
}

/*
 * 16:9 的那一层（第 24 条）。**画布与空态用同一个比例**：空面板与有数据的面板一样大，
 * 数据来了页面不会跳（这一条原来是靠 `min-height: 240px` 做的，比例一定就会失效）。
 *
 * `aspect-ratio` 让高度由宽度算出来，所以"各占 50%"与"16:9"两条同时成立。
 */
.acam__stage--ratio {
  aspect-ratio: 16 / 9;
  min-height: 0;
  width: 100%;
}

/*
 * 图表容器要能被 ECharts 填满：`height="100%"` 只有在父元素有确定高度时才成立，
 * 而这里的高度来自 `aspect-ratio`。
 */
.acam__scope.acam__stage--ratio {
  display: block;
  padding: 0;
  border-style: solid;
}

.acam__note,
.acam__meta {
  font-size: 11.5px;
}

.acam__guard {
  font-size: 11px;
}

.acam__state {
  font-size: 11.5px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  background: var(--color-bg-subtle);
}

.acam__state--ok {
  border-color: var(--color-success);
  color: var(--color-success);
}

.acam__state--warn {
  border-color: var(--color-warning);
  color: var(--color-warning);
}

.acam__state--error {
  border-color: var(--color-danger);
  color: var(--color-danger);
}

/* A fixed-height stage for all four "no data" cases, so an empty panel is the
   same size as a live one and the page does not jump when data starts. */
.acam__panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* A fixed 16:9 stage for the two ratio panels (see `.acam__stage--ratio`), and the
   same shape for the short "no data" cases below it. */
.acam__stage,
.acam__empty {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  padding: var(--space-3);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
  color: var(--color-text-secondary);
  font-size: 12px;
  text-align: center;
}

.acam__empty--short {
  min-height: 120px;
}

.acam__image,
.acam__canvas {
  max-width: 100%;
  max-height: 420px;
  object-fit: contain;
  /* The matrix path draws at source resolution and the browser scales it up;
     `pixelated` keeps a 64x32 map readable instead of blurring it into grey. */
  image-rendering: pixelated;
}

.acam__scope {
  min-width: 0;
}

/*
 * 能量点表格：五列数字在一排五图（每张 ~220px）里必须还能读。
 *
 * `table-layout: fixed` 让五列**等宽地**分这一张卡的宽度，而不是按最长的一格去撑。
 * 这是一条**预防措施**：五个表头（能量值 / 像素X / 像素Y / 扫掠角 / 方位角）估算各占
 * ~45px，5×45 = 225px 已经压着 220px 的卡宽了。
 *
 * 未验证：这台相机离线、没有实时能量点，表格不渲染，所以"没有它会不会真溢出"没有量到。
 * 探针（`scripts/demo-shot-driver.cjs`）在量不到表格时会**明确写出来**，不会当成通过。
 */
.acam__table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 12px;
}

.acam__table th,
.acam__table td {
  text-align: left;
  padding: 4px 6px;
  border-bottom: 1px solid var(--color-border);
}

.acam__log {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
  font-size: 12px;
}

.acam__log-time {
  margin-right: 6px;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}
</style>