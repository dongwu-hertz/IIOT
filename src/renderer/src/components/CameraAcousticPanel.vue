<script setup lang="ts">
/**
 * FA371 camera acoustic streams — the WebSocket channels, rendered.
 *
 * WHY THIS PANEL EXISTS AT ALL
 * `MonitorView` shows the camera's live video as the main surface, but the acoustic
 * streams are the part of this camera that carries the leak/PD signal, so they need
 * a surface somewhere on the same page.
 *
 * 2026-09-22 REAL-TIME ANALYSIS SOURCE
 *   voiceprint / spectrum / audio are now drawn from ONE local 200 kHz raw PCM stream.
 *   The section API stays unchanged so MonitorView_UI_Final can keep its current layout/lifecycle.
 *   /fftData and /voiceprintData remain in the store for protocol/debug compatibility only.
 *
 * LEGACY CHANNEL NOTES (kept for compatibility/debug context)
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
 *   /detectFeedback  the text frames. An EVENT channel: an empty list here means
 *                    "no detection finished", not "broken".
 *
 * 业主 2026-09-21 第三批：整块面板按 `sections` 取用、随新布局拆到多处
 * （右列 35%：声纹图 + 频谱图；视频下方：波形 + 检测结果）。会话生命周期
 * （选中即默认接收、离开即停）只有**一个**主人 —— `useFa371CameraSession()`
 * —— 本组件是纯展示，读同一份 `fa371Stream` store，多份实例不会各开各的会话。
 * 能量点子卡（旧第 4 块）按同一批要求整块删除。
 *
 * EMPTY / ERROR / STALE STATES ARE THE POINT
 * Every section distinguishes "not started", "no frames yet", "stream error" and
 * "stale (data stopped N seconds ago)" from real data. A silent channel and a
 * quiet room are different things, so no section ever draws a plausible flat line
 * for missing data.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { EChartsCoreOption } from 'echarts/core'
import type { Fa371StreamKind } from '@shared/domain/fa371-stream'
import { FA371_STALE_AFTER_MS, useFa371StreamStore } from '@renderer/stores/fa371Stream'
import { useSessionStore } from '@renderer/stores/session'
import { EMPTY_VALUE, formatBytes, formatNumber } from '@renderer/lib/format'
import { EnvelopePlayer } from '@renderer/lib/envelopePlayer'
import AudioLevelMeter from '@renderer/components/AudioLevelMeter.vue'
import EChart from '@renderer/components/EChart.vue'
import RealtimeAcousticCharts from '@renderer/components/RealtimeAcousticCharts.vue'

/**
 * 可取的子卡（业主 2026-09-21 第三批：能量点已删，不再是可选项）。
 * 不传 `sections` = 全部 —— 保持「一整块面板」的旧手感（含状态行）。
 */
export type CameraAcousticSection = 'voiceprint' | 'spectrum' | 'audio' | 'detect' | 'mode'

const ALL_SECTIONS: readonly CameraAcousticSection[] = ['voiceprint', 'spectrum', 'audio', 'detect', 'mode']

const props = withDefaults(
  defineProps<{
    /** 只渲染这几块（不传＝全部，旧手感）。见 `CameraAcousticSection`。 */
    sections?: readonly CameraAcousticSection[]
    /** 兼容旧页面。实时监测页不再显示“接收中 / 停止接收”这类传输层控件。 */
    showStatus?: boolean
    /** 1=局放，2=气体泄漏，3=机械异响。用于模式专属分析卡切换。 */
    workMode?: number
  }>(),
  { showStatus: false }
)

const emit = defineEmits<{
  /** 「检测记录库」按钮：打开检测记录下载弹窗（弹窗挂在页面上，这里只上报）。 */
  (event: 'openLibrary'): void
}>()

const { t } = useI18n()
const camera = useFa371StreamStore()
const session = useSessionStore()

const busy = ref(false)
const audioEnabled = ref(false)
const audioError = ref('')
const voiceprintCanvas = ref<HTMLCanvasElement | null>(null)

/** Shared display range for the realtime FFT and spectrogram. */
const analysisMaxKHz = ref<30 | 50 | 65 | 100>(65)
const analysisFrequencyOptions = [30, 50, 65, 100] as const

const activeSections = computed<readonly CameraAcousticSection[]>(
  () => props.sections ?? ALL_SECTIONS
)

function wants(section: CameraAcousticSection): boolean {
  return activeSections.value.includes(section)
}

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
// Session status row (display only — the lifecycle lives in
// `useFa371CameraSession()`, owned once by the page)
// ---------------------------------------------------------------------------

/**
 * 「停止接收」只在接收中显示，所以它只会走 stop 那半边；start 留在 composable 的
 * 默认接收里（第 23 条：数据默认实时接收，页面上没有「开始接收」按钮）。
 */
async function stopSession(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await camera.stop()
  } finally {
    busy.value = false
  }
}

/**
 * 非管理员看得到图，但开不了流 —— 那一句说明只在**这种情况**下出现。
 * 角色检查的执行点仍然是主进程，这里只决定要不要显示这句提示。
 */
const canStart = computed(() => session.isAdmin)

/** 握手方式那一条：状态徽标的悬停说明（支持时要看的就是这个值）。 */
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

const sessionError = computed(() => {
  if (camera.state !== 'error') return ''
  // 'no-device' is a sentinel the store uses when nothing is selected.
  return camera.error === 'no-device' ? t('cameraStreamUi.noDevice') : camera.error
})

// ---------------------------------------------------------------------------
// /voiceprintData — JPEG image, or a numeric magnitude matrix (numeric candidate)
// ---------------------------------------------------------------------------

const voiceprintIsMatrix = computed(() => {
  const frame = camera.voiceprint
  return Boolean(
    frame && !frame.jpegBase64 && frame.width > 0 && frame.height > 0 && frame.cells.length > 0
  )
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
// /detectFeedback
// ---------------------------------------------------------------------------

/**
 * Envelope text of a detection package whose logs could not be mapped.
 *
 * `rawRet` / `rawMsg` are raw device fields, so this row is a diagnostic dump rather than
 * prose: when the device sent neither of them there is simply nothing to show, and the
 * list's own missing-value placeholder answers that. (This used to ask i18n for a
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
// Mode-specific analysis: PRPD / Leakage / Mechanical
//
// PRPD 优先显示**设备自己渲染的图**：实测（2026-09-23，局放检测开启后）
// `/prpdData` 推的是 JPEG 图像帧（约 21–25 kB、约 2 帧/s），与 `/voiceprintData`
// 同一形态。设备图在时直接 `<img>` 显示；数值候选（mock）与本地脉冲推算
// 只是设备不推图时的兜底。
// ---------------------------------------------------------------------------
const cameraDynamic = camera as unknown as Record<string, unknown>

function candidateObject(...names: string[]): Record<string, unknown> | null {
  for (const name of names) {
    const value = cameraDynamic[name]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  }
  return null
}

const PRPD_ROLLING_WINDOW_MS = 15_000
/**
 * PRPD 重绘节流间隔（2026-09-22「PRPD 不断刷新」修复）。
 *
 * 之前每收到一帧 /prpdData 就做两件事：对 15 秒滚动窗全量重算密度，并把整份 option
 * 以 notMerge 方式塞给 EChart —— 坐标轴、markLine、画布整体重建一次。设备推多快，
 * 图就整体闪着重画多快，这就是"PRPD 不断刷新"的直接来源。
 *
 * 现在：收帧照收（普通数组追加，O(1)），但**图表刷新最多每 500 ms 一次**；
 * 配合 EChart 的 mergeUpdates，刷新只做数据替换、不再推倒坐标轴与画布。
 */
const PRPD_MIN_REDRAW_MS = 500
/** 滚动窗点数硬上限：超出时从最旧的帧开始丢。脉冲检测下正常远低于它，这是保险丝。 */
const PRPD_POINT_CAP = 8_000

/** 非响应式滚动窗：只被下面的 computed 在重绘时刻读取，不参与逐帧依赖追踪。 */
interface PrpdFrameEntry {
  timestamp: number
  points: Array<[number, number]>
  /** 'device' = /prpdData 实帧；'local' = PCM 本地脉冲提取（见文件下方回退说明）。 */
  source: 'device' | 'local'
}
let prpdFrames: PrpdFrameEntry[] = []
const prpdRevision = ref(0)
let prpdRedrawTimer: ReturnType<typeof setTimeout> | undefined
let prpdLastRedrawAt = 0

/**
 * Y 轴上限的滞回值（2026-09-23「PRPD 窗口不稳定」修复的一部分）：
 * 大脉冲进来时立刻跟上（否则点被裁掉看不见），脉冲随滚动窗离开后**每次重绘 ×0.92
 * 缓慢回落**——坐标轴不随每一批点的最大值来回跳，画面才稳。
 */
let prpdYAxisMax = 1

/** 当前图谱是否在使用本地推算数据（用于如实标注，见模板里的 prpdLocalNote）。 */
const prpdLocalActive = ref(false)

/**
 * 设备渲染好的 PRPD 图（实测 2026-09-23：局放检测开启后 /prpdData 推 JPEG，
 * 约 2 帧/s）。有设备图就显示设备图——本地脉冲推算与散点图只是它不推图时的兜底。
 */
const prpdDeviceImage = computed(() => {
  const jpeg = camera.prpd?.jpegBase64
  return jpeg ? `data:image/jpeg;base64,${jpeg}` : ''
})
function prpdRedraw(): void {
  prpdRedrawTimer = undefined
  prpdLastRedrawAt = Date.now()
  const cutoff = prpdLastRedrawAt - PRPD_ROLLING_WINDOW_MS
  prpdFrames = prpdFrames.filter((entry) => entry.timestamp >= cutoff)
  // 点数保险丝：从最旧的帧开始丢，直到总数回到上限内。
  let total = 0
  for (const entry of prpdFrames) total += entry.points.length
  while (total > PRPD_POINT_CAP && prpdFrames.length > 0) {
    total -= prpdFrames.shift()?.points.length ?? 0
  }
  let maxAmplitude = 0
  for (const entry of prpdFrames) {
    for (const point of entry.points) {
      if (point[1] > maxAmplitude) maxAmplitude = point[1]
    }
  }
  const target = Math.max(maxAmplitude * 1.15, 1e-6)
  prpdYAxisMax = target > prpdYAxisMax ? target : Math.max(target, prpdYAxisMax * 0.92)
  prpdRevision.value += 1
}

function schedulePrpdRedraw(): void {
  if (prpdRedrawTimer !== undefined) return
  const wait = Math.max(0, PRPD_MIN_REDRAW_MS - (Date.now() - prpdLastRedrawAt))
  prpdRedrawTimer = setTimeout(prpdRedraw, wait)
}

watch(
  () => camera.prpd?.timestamp,
  (timestamp) => {
    const frame = camera.prpd
    if (!frame || timestamp === undefined || frame.points.length === 0) return
    // 设备真的开始推 /prpdData：立即切回设备数据，本地推算点全部丢弃，两套不混。
    if (prpdLocalActive.value) {
      prpdFrames = prpdFrames.filter((entry) => entry.source !== 'local')
      prpdLocalActive.value = false
    }
    prpdFrames.push({
      timestamp: Number(timestamp),
      points: frame.points.map((point) => [point[0], point[1]] as [number, number]),
      source: 'device'
    })
    if (Date.now() - prpdLastRedrawAt >= PRPD_MIN_REDRAW_MS) prpdRedraw()
    else schedulePrpdRedraw()
  },
  { immediate: true }
)

/**
 * 本地 PRPD 回退（业主 2026-09-22 第 3 条「PRPD 图谱还是没有显示」，
 * 2026-09-23 重做：「整个界面都铺满了、换个方式」）。
 *
 * 背景：/prpdData 在真机上**从未推过帧**（2026-09-15 两次实测窗口均 0 帧；手册只
 * 确认通道存在，不保证有数据），接收路径再怎么修也不会有图。而 /pcmData 是实测
 * 每秒 10 帧、带完整原始样本的稳定通道。
 *
 * 旧做法为什么铺满：它把每个采样点的 |幅值| 按相位均匀点画——声学信号的**噪声底
 * 是连续的**，于是 360° 的每一度都被噪声点覆盖，整张图看起来像一块实心色斑，
 * 这既不是设备数据，也不是局放图谱该有的样子。
 *
 * 新做法 = 局放检测的标准思路：**只画脉冲**。放电在物理上表现为显著高于连续噪声底
 * 的短促脉冲，且与工频相位锁定；连续泄漏/背景噪声不产生这种脉冲，图就应该是
 * 接近空的——空图在这里是如实，不是故障。
 *   - 阈值 = 噪声底（帧 rms 的慢速 EMA，时间常数约 1 s）× 3；
 *   - 只收**局部峰值**，同一脉冲的多个邻峰在 0.5 ms 合并窗内只留最高的一针；
 *   - 相位 = 本地采样时间轴按 50 Hz 工频折叠——**不是**电网过零同步，绝对相位角
 *     会随电网频偏缓慢漂移，但聚簇的相对位置（电晕/悬浮的两簇结构）不受影响；
 *   - 与设备数据**互斥**：设备一旦真的推 /prpdData，立即切回设备帧并丢弃本地点。
 */
const PRPD_LOCAL_PHASE_HZ = 50
/** 脉冲判定阈值倍数：帧内 |样本| 必须显著高于噪声底才算放电脉冲。 */
const PRPD_LOCAL_THRESHOLD_RATIO = 3
/** 同一脉冲的邻峰合并窗口（秒）：200 kHz 下 0.5 ms ≈ 100 个采样点。 */
const PRPD_LOCAL_MERGE_SECONDS = 0.0005
/** 单帧最多入图的脉冲数：超出说明阈值被击穿（强干扰），只留最前的，不让图被刷爆。 */
const PRPD_LOCAL_MAX_PULSES_PER_FRAME = 24
/** 噪声底的慢速 EMA（α=0.1）：突发不会把阈值瞬间顶高，环境变化又能跟上。 */
let localNoiseFloor = 0
let localPrpdRate = 0
let localPrpdSampleCounter = 0

watch(
  () => camera.pcm?.timestamp,
  (timestamp) => {
    const frame = camera.pcm
    if (!frame || timestamp === undefined) return
    // 设备数据在手：本地推算完全让位（数值帧进了滚动窗，或设备在推渲染好的 JPEG 图）。
    if (prpdDeviceImage.value) return
    if (prpdFrames.some((entry) => entry.source === 'device')) return
    const raw = frame.rawSamples
    if (!raw || raw.length < 256) return
    const rate = frame.sampleRate > 0 ? Math.round(frame.sampleRate) : 200_000
    if (rate !== localPrpdRate) {
      localPrpdRate = rate
      localPrpdSampleCounter = 0
    }

    const frameRms = frame.rms > 0 ? frame.rms : 0
    localNoiseFloor = localNoiseFloor === 0 ? frameRms : localNoiseFloor * 0.9 + frameRms * 0.1
    const threshold = Math.max(localNoiseFloor * PRPD_LOCAL_THRESHOLD_RATIO, 1e-9)
    const mergeGap = Math.max(4, Math.round(rate * PRPD_LOCAL_MERGE_SECONDS))

    const points: Array<[number, number]> = []
    let lastPulseIndex = -mergeGap
    const phaseOf = (index: number): number =>
      ((((localPrpdSampleCounter + index) / rate) * PRPD_LOCAL_PHASE_HZ) % 1) * 360
    for (let index = 1; index < raw.length - 1 && points.length < PRPD_LOCAL_MAX_PULSES_PER_FRAME; index += 1) {
      const amplitude = Math.abs(raw[index] ?? 0)
      if (amplitude < threshold) continue
      // 只收局部峰值：一个脉冲的上升沿/下降沿不重复计点。
      if (amplitude < Math.abs(raw[index - 1] ?? 0) || amplitude < Math.abs(raw[index + 1] ?? 0)) continue
      if (index - lastPulseIndex < mergeGap) {
        // 合并窗内更高的峰替换上一针（同一脉冲只留最高的那一针）。
        const lastPoint = points[points.length - 1]
        if (lastPoint && amplitude > lastPoint[1]) {
          lastPoint[0] = phaseOf(index)
          lastPoint[1] = amplitude
          lastPulseIndex = index
        }
        continue
      }
      points.push([phaseOf(index), amplitude])
      lastPulseIndex = index
    }
    // 全局采样计数器按整帧推进：无论这一帧有没有脉冲入图，相位轴都保持连续。
    localPrpdSampleCounter += raw.length

    if (points.length === 0) return
    prpdLocalActive.value = true
    prpdFrames.push({ timestamp: Number(timestamp), points, source: 'local' })
    if (Date.now() - prpdLastRedrawAt >= PRPD_MIN_REDRAW_MS) prpdRedraw()
    else schedulePrpdRedraw()
  }
)

/** 换相机：上一台的滚动窗/相位计数/噪声底/轴滞回都不带进下一台（store 清缓冲，这里清本地推算状态）。 */
watch(
  () => camera.deviceId,
  () => {
    prpdFrames = []
    prpdLocalActive.value = false
    localPrpdRate = 0
    localPrpdSampleCounter = 0
    localNoiseFloor = 0
    prpdYAxisMax = 1
  }
)

/**
 * PRPD 画的是**脉冲点本身**（相位 × 幅值），不再做密度分箱。
 *
 * 2026-09-23 之前这里把 15 秒滚动窗按 5°×幅值格分箱、按箱内点数决定点的大小——
 * 那是"铺满"的另一半原因：噪声点在每个格里都攒得出计数，斑点越滚越大。
 * 脉冲检测之后点数本来就可控（每帧 ≤24 针），直接画原始点才是 PRPD 的标准形态：
 * 放电聚簇会自己显现，不需要密度编码替它说话。
 *
 * 只在 `prpdRevision`（≥500 ms 一次）变化时重算，不在每帧重算。
 */
const prpdScatterData = computed<Array<[number, number]>>(() => {
  void prpdRevision.value
  return prpdFrames.flatMap((frame) => frame.points)
})

const prpdOption = computed<EChartsCoreOption>(() => ({
  animation: false,
  grid: { left: 54, right: 22, top: 22, bottom: 38 },
  tooltip: {
    trigger: 'item',
    formatter: (params: unknown) => {
      const value = (params as { value?: unknown })?.value
      if (!Array.isArray(value)) return ''
      const phase = Number(value[0])
      const amplitude = Number(value[1])
      return `${t('cameraStreamUi.prpdPhase')}: ${formatNumber(phase, 1)}°<br/>${t('cameraStreamUi.prpdAmplitude')}: ${formatNumber(amplitude, 2)}`
    }
  },
  xAxis: {
    type: 'value',
    min: 0,
    max: 360,
    interval: 90,
    name: t('cameraStreamUi.prpdPhaseAxis'),
    axisLabel: { color: '#6B7280', fontSize: 10 },
    splitLine: { lineStyle: { color: '#ECEEF1' } }
  },
  yAxis: {
    type: 'value',
    min: 0,
    // 滞回上限（`prpdYAxisMax` 在 prpdRedraw 里维护）：进来的脉冲立刻顶开，
    // 离开的脉冲缓慢回落——轴不随单批点抖动，这是"窗口稳定"的那一半。
    max: prpdYAxisMax,
    name: t('cameraStreamUi.prpdAmplitude'),
    axisLabel: { color: '#6B7280', fontSize: 10 },
    splitLine: { lineStyle: { color: '#F1F1F2' } }
  },
  series: [
    {
      type: 'scatter',
      data: prpdScatterData.value,
      symbolSize: 4,
      itemStyle: { color: 'rgba(194, 65, 12, 0.62)' },
      markLine: {
        silent: true,
        symbol: ['none', 'none'],
        lineStyle: { type: 'dashed', width: 1, opacity: 0.55 },
        label: { show: false },
        data: [{ xAxis: 90 }, { xAxis: 180 }, { xAxis: 270 }]
      }
    }
  ]
}))

function flattenFeatureRows(payload: Record<string, unknown> | null): Array<{ key: string; label: string; value: string }> {
  if (!payload) return []
  const rows: Array<{ key: string; label: string; value: string }> = []
  const skip = new Set(['timestamp', 'time', 'raw', 'deviceId'])
  for (const [key, value] of Object.entries(payload)) {
    if (skip.has(key) || value === null || value === undefined || typeof value === 'object') continue
    if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') continue
    const label = key
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^./, (char) => char.toUpperCase())
    rows.push({ key, label, value: typeof value === 'number' ? formatNumber(value, 2) : String(value) })
  }
  return rows.slice(0, 12)
}

const featureRows = computed(() => {
  const payload = candidateObject('feature', 'features', 'featureData', 'featureFrame')
  const rows = flattenFeatureRows(payload)
  if (props.workMode === 2) {
    const priority = /leak|rate|cost|distance|spl|pressure|frequency|freq/i
    return rows.slice().sort((a, b) => Number(priority.test(b.key)) - Number(priority.test(a.key)))
  }
  if (props.workMode === 3) {
    const priority = /kurt|crest|peak|spectral|frequency|freq|rms/i
    return rows.slice().sort((a, b) => Number(priority.test(b.key)) - Number(priority.test(a.key)))
  }
  return rows
})

const modeTitle = computed(() => {
  if (props.workMode === 1) return t('cameraStreamUi.modePrpdTitle')
  if (props.workMode === 2) return t('cameraStreamUi.modeLeakageTitle')
  if (props.workMode === 3) return t('cameraStreamUi.modeMechanicalTitle')
  return t('cameraStreamUi.modeAnalysisTitle')
})

// ---------------------------------------------------------------------------
// Lifecycle — playback only. The STREAM session is owned by the page through
// `useFa371CameraSession()`; this component never starts or stops it.
// ---------------------------------------------------------------------------

onBeforeUnmount(() => {
  // The envelope player's AudioContext does not die with the component: close it.
  void player.close()
  // 挂起的 PRPD 重绘定时器同样不能留给下一个页面。
  if (prpdRedrawTimer !== undefined) clearTimeout(prpdRedrawTimer)
})
</script>

<template>
  <!--
    `camera-board__panel` 是**给探针用的**标记类（不带任何样式）：`scripts/video-proof-driver.cjs`
    用它认出声学面板与相机控制那两块。多份实例（sections 拆出来的）都带这个类。
  -->
  <div class="acam camera-board__panel">
    <!--
      一行会话状态（第 23 条把那个窗口删掉之后留下的最小形态）：一枚状态徽标 +
      一颗「停止接收」+（非管理员时）一句说明。多份实例同屏时只有传了
      `show-status` 的那一份渲染它（生命周期只有**一个**主人，状态也只有一份）。
    -->
    <div v-if="showStatus" class="acam__status" data-acam-status>
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
        @click="stopSession"
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

    <!-- ---- 1. spectrogram ------------------------------------------------ -->
    <section v-if="wants('voiceprint')" class="card acam__panel acam__panel--analysis" data-analysis-source="local-stft-200khz">
      <div class="section-header acam__analysis-header">
        <h3 class="section-title">{{ t('cameraStreamUi.voiceprintTitle') }}</h3>
        <div class="acam__analysis-actions">
          <select v-model.number="analysisMaxKHz" class="select acam__range-select" aria-label="Spectrogram frequency range">
            <option v-for="value in analysisFrequencyOptions" :key="`spectrogram-${value}`" :value="value">0–{{ value }} kHz</option>
          </select>
          <span :class="phaseClass('pcmData')">{{ phaseLabel('pcmData') }}</span>
        </div>
      </div>
      <RealtimeAcousticCharts
        :sections="['spectrogram']"
        :sample-rate="200000"
        :fft-len="4096"
        :max-frequency-k-hz="analysisMaxKHz"
        :spectrogram-seconds="6"
        :spectrogram-preload-ms="800"
        embedded
        compact
      />
    </section>

    <!-- ---- 2. frequency domain ----------------------------------------- -->
    <section v-if="wants('spectrum')" class="card acam__panel acam__panel--analysis" data-analysis-source="local-fft-200khz">
      <div class="section-header acam__analysis-header">
        <h3 class="section-title">{{ t('cameraStreamUi.fftTitle') }}</h3>
        <div class="acam__analysis-actions">
          <select v-model.number="analysisMaxKHz" class="select acam__range-select" aria-label="Spectrum frequency range">
            <option v-for="value in analysisFrequencyOptions" :key="`spectrum-${value}`" :value="value">0–{{ value }} kHz</option>
          </select>
          <span :class="phaseClass('pcmData')">{{ phaseLabel('pcmData') }}</span>
        </div>
      </div>
      <RealtimeAcousticCharts
        :sections="['frequency']"
        :sample-rate="200000"
        :fft-len="4096"
        :max-frequency-k-hz="analysisMaxKHz"
        embedded
        compact
      />
    </section>

    <!-- ---- 3. live audio (时域波形图) ---------------------------------- -->
    <section v-if="wants('audio')" class="card acam__panel">
      <div class="section-header">
        <div>
          <h3 class="section-title">{{ t('cameraStreamUi.audioTitle') }}</h3>
          <span class="muted acam__meta">200 kHz PCM · Time Domain</span>
        </div>
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

      <div class="acam__time-local" data-analysis-source="local-time-200khz">
        <RealtimeAcousticCharts
          :sections="['time']"
          :sample-rate="200000"
          :fft-len="4096"
          :max-frequency-k-hz="65"
          :time-window-seconds="1"
          embedded
          compact
        />
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

    <!-- ---- 4. detection feedback -------------------------------------- -->
    <section v-if="wants('detect')" class="card acam__panel">
      <div class="section-header">
        <h3 class="section-title">{{ t('cameraControlUi.detectTitle') }}</h3>
        <span :class="phaseClass('detectFeedback')">{{ phaseLabel('detectFeedback') }}</span>
      </div>
      <span class="muted acam__meta">{{ phaseMeta('detectFeedback') }}</span>
      <p v-if="layoutWarning('detectFeedback')" class="alert alert--warning" role="status">
        {{ layoutWarning('detectFeedback') }}
      </p>
      <!--
        「检测记录库」（业主 2026-09-21 第三批）：打开检测记录下载弹窗。弹窗本体挂在
        页面上（与画面墙同一对组件），这里只发事件 —— 面板自己不持有弹窗状态。
      -->
      <div class="btn-row">
        <button
          type="button"
          class="btn btn--sm"
          data-action="acam-detect-library"
          @click="emit('openLibrary')"
        >
          {{ t('cameraNvrUi.menuDownloadDetect') }}
        </button>
      </div>
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

    <!-- ---- 5. mode-specific analysis ---------------------------------- -->
    <section v-if="wants('mode')" class="card acam__panel acam__mode-panel">
      <div class="section-header">
        <h3 class="section-title">{{ modeTitle }}</h3>
        <span v-if="workMode === 1" :class="phaseClass('prpdData')">{{ phaseLabel('prpdData') }}</span>
      </div>

      <div v-if="workMode === 1" class="acam__mode-stage acam__stage--ratio">
        <!--
          设备在推渲染好的 PRPD 图（JPEG）时直接显示它 —— 这是相机自己的图谱，
          不是我们推算的。设备不推图时回落到散点图（数值帧 / 本地脉冲检测）。
          两条路共用同一个 16:9 舞台，切换时布局不跳。
        -->
        <img
          v-if="prpdDeviceImage"
          :src="prpdDeviceImage"
          class="acam__prpd-image"
          alt="PRPD"
          data-prpd-source="device-jpeg"
        />
        <EChart v-else :option="prpdOption" height="100%" merge-updates />
      </div>

      <dl v-else-if="workMode === 2 || workMode === 3" class="acam__feature-grid">
        <template v-if="featureRows.length > 0">
          <template v-for="row in featureRows" :key="row.key">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </template>
        </template>
        <template v-else>
          <dt>{{ t('cameraStreamUi.modeDataStatus') }}</dt>
          <dd>{{ t('cameraStreamUi.modeDataWaiting') }}</dd>
        </template>
      </dl>

      <div v-else class="acam__empty acam__empty--short">
        <span>{{ t('cameraStreamUi.modeSelectHint') }}</span>
      </div>
    </section>
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
 * 16:9 的那一层（原第 24 条）。**画布与空态用同一个比例**：空面板与有数据的面板一样大，
 * 数据来了页面不会跳（这一条原来是靠 `min-height: 240px` 做的，比例一定就会失效）。
 *
 * `aspect-ratio` 让高度由宽度算出来；`min-height: 0` 允许列真的变窄时高度跟着缩 —
 * ECharts 的 canvas 会把内容最小宽度顶出去，`minmax(0, …)` 那一层在排布板上挡着。
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

/* A fixed 16:9 stage for the ratio sections, and the same shape for the short
   "no data" cases below it. */
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


.acam__mode-stage {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
  overflow: hidden;
}

/* 设备渲染好的 PRPD 图：铺满同一个 16:9 舞台，保持纵横比不变形。 */
.acam__prpd-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #0b1020;
}

.acam__mode-empty {
  height: 100%;
}

.acam__local-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-tertiary);
}

.acam__feature-grid {
  display: grid;
  grid-template-columns: minmax(120px, 0.8fr) minmax(0, 1.2fr);
  gap: 0;
  margin: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
  overflow: hidden;
}

.acam__feature-grid dt,
.acam__feature-grid dd {
  margin: 0;
  padding: 9px 10px;
  border-bottom: 1px solid var(--color-border);
  font-size: 11.5px;
}

.acam__feature-grid dt {
  color: var(--color-text-secondary);
  background: var(--color-bg-subtle);
}

.acam__feature-grid dd {
  font-variant-numeric: tabular-nums;
}

.acam__feature-grid > :nth-last-child(-n + 2) {
  border-bottom: 0;
}



.acam__analysis-header {
  align-items: center;
}

.acam__analysis-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}

.acam__range-select {
  width: auto;
  min-width: 104px;
  height: 28px;
  padding-top: 2px;
  padding-bottom: 2px;
  font-size: 11px;
}

/* Realtime monitoring asked for roughly twice the previous chart height. */
.acam__panel--analysis :deep(.rac__chart),
.acam__panel--analysis :deep(.rac__preparing) {
  min-height: 420px;
  height: 420px;
}


.acam__time-local {
  min-width: 0;
}

</style>
