<script setup lang="ts">
/**
 * Realtime monitoring (spec section 9.1) — REAL device data.
 *
 * Every value on this page comes from the monitor store, which is fed by the
 * main-process WebSocket bridges (`window.events.onMonitor*`). There is no
 * simulator, no direct HTTP call, and no device URL anywhere in this file: the
 * renderer is structurally incapable of reaching a device (CSP `connect-src 'none'`).
 *
 * TWO MEASURED FACTS THAT SHAPE THIS PAGE
 *   1. The device streams ONE channel per WebSocket connection, so switching
 *      channel is a stop/start of the whole session, not a re-render. See
 *      `selectChannel()` and PROTOCOL-FINDINGS 4.3.
 *   2. The spectrogram stream is a rendered JPEG image, not a numeric matrix,
 *      so that panel is an `<img>` sequence (SpectrogramViewer) — never ECharts.
 *
 * LIFECYCLE: this view is the only owner of the session while it is mounted, and
 * it releases BOTH halves on unmount — `stop()` closes the sockets in the main
 * process, `unsubscribe()` releases the IPC listeners and clears the buffers.
 * See the comment on `onUnmounted` below; forgetting either half is the classic
 * leak in this architecture.
 *
 * THREE DEVICE FAMILIES, THREE PANELS (业主 2026-09-17 第 5 条)
 * For an `acousticCamera` this page renders the LIVE VIDEO panel instead: the camera
 * has no channels and no `/features_stream`, so the WebSocket monitor must not be
 * pointed at it at all. The camera panel's source is a loopback HTTP URL produced by
 * the main process (`window.api.cameraLive.*`), which is the ONE network address the
 * renderer is ever allowed to load — see the CSP note in `src/renderer/index.html`.
 * For an `auscultationBox` (2023 听诊盒子 or SN-16 空气声呐) it renders the PULL panel
 * instead: its protocol is plain HTTP (`/system`, `/workmode`, the alarm log) with no
 * realtime stream we have wired up, so that branch shows the device's own parameters,
 * the alarm sync and the local recordings — and says out loud that there is no live
 * stream. Every camera/sonar branch is additive; the box behaviour is unchanged.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type { EChartsCoreOption } from 'echarts/core'
import type { Channel, Device, RealtimeFeature } from '@shared/domain/models'
import { CHANNEL_COUNT } from '@shared/domain/models'
import type { CameraLiveState, CameraLiveStatus } from '@shared/domain/camera-live'
import {
  buildCameraNvrMenu,
  cameraCaptureReadiness,
  type CameraNvrAction,
  type CameraNvrEnvironment,
  type CameraNvrMenuItem
} from '@shared/domain/camera-nvr'
import { useDevicesStore } from '@renderer/stores/devices'
import { useCameraLiveStore } from '@renderer/stores/cameraLive'
import { useSettingsStore } from '@renderer/stores/settings'
import { ALL_STREAM_KINDS, useMonitorStore } from '@renderer/stores/monitor'
import { streamKindLabel } from '@renderer/lib/labels'
import {
  channelActivityLabelKey,
  channelReceivesData,
  channelState,
  channelStateClass,
  channelStateHintKey,
  channelStateLabelKey,
  type ChannelState
} from '@renderer/lib/channelState'
import { channelLabel, formatBytes, formatDuration, formatNumber } from '@renderer/lib/format'
import {
  channelFeatureState,
  channelFeatureStateLabelKey,
  type ChannelFeatureState
} from '@renderer/lib/channelFeatures'
import { DEFAULT_VOLUME_PERCENT } from '@renderer/lib/audioPreview'
import { EnvelopePlayer } from '@renderer/lib/envelopePlayer'
import {
  formatHzTick,
  spectrumMaxHz,
  spectrumPoints,
  spectrumRangeLabel
} from '@renderer/lib/spectrum'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import {
  CAMERA_DEFAULT_VOLUME,
  CAMERA_FLIP_NONE,
  cameraFlipTransform,
  loadCameraVolume,
  sanitiseCameraVolume,
  saveCameraVolume,
  type CameraFlip
} from '@renderer/lib/cameraLivePrefs'
import EmptyState from '@renderer/components/EmptyState.vue'
import MetricCard from '@renderer/components/MetricCard.vue'
import EChart from '@renderer/components/EChart.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'
import SpectrogramViewer from '@renderer/components/SpectrogramViewer.vue'
import AudioLevelMeter from '@renderer/components/AudioLevelMeter.vue'
import CameraAcousticPanel from '@renderer/components/CameraAcousticPanel.vue'
import CameraControlPanel from '@renderer/components/CameraControlPanel.vue'
import VideoContextMenu from '@renderer/components/VideoContextMenu.vue'
import CameraAlarmDialog from '@renderer/components/CameraAlarmDialog.vue'
import CameraRecordingPlaybackDialog from '@renderer/components/CameraRecordingPlaybackDialog.vue'
import CameraDetectDownloadDialog from '@renderer/components/CameraDetectDownloadDialog.vue'
import MonitorRecordingTimeline from '@renderer/components/MonitorRecordingTimeline.vue'
import AuscultationPanel from '@renderer/components/AuscultationPanel.vue'
import DeviceInstallationCard from '@renderer/components/DeviceInstallationCard.vue'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const devices = useDevicesStore()
const monitor = useMonitorStore()
const cameraLiveStore = useCameraLiveStore()
const settings = useSettingsStore()

const selectedDeviceId = ref('')
const activeChannelIndex = ref(0)
/** Real sample rate, read through the config API (never guessed locally). */
const sampleRate = ref<number | null>(null)

const selectedDevice = computed(() => devices.byId(selectedDeviceId.value))

/**
 * 当前选中的那台在不在线（业主 2026-09-18 第 19 条：选设备时用绿点/灰点说这件事）。
 *
 * `UNKNOWN` 归到**灰**点：我们只知道"没读到"，而绿点会被读成"它在工作" ——
 * 那是界面在说一件没被证实的事（与 `channelState()` 拒绝把"没读到"当"已启用"同一条规矩）。
 */
const selectedDeviceOnline = computed(() => selectedDevice.value?.status === 'ONLINE')

/** 下拉里每一项前面的那个字符（原生 `<option>` 画不出颜色，颜色由旁边的点负责）。 */
function deviceStatusDot(status: Device['status']): string {
  return status === 'ONLINE' ? '●' : '○'
}

/** Channels reported by the device; falls back to the fixed 0-7 index range. */
const channels = computed<Channel[]>(() => devices.channelsOf(selectedDeviceId.value))

interface ChannelTab {
  index: number
  label: string
  name: string
  /** 通道状态：未启用的通道要变灰且不可选，未知状态不能被当成已启用。 */
  state: ChannelState
}

const channelTabs = computed<ChannelTab[]>(() => {
  if (channels.value.length > 0) {
    return [...channels.value]
      .sort((a, b) => a.channelIndex - b.channelIndex)
      .map((channel) => ({
        index: channel.channelIndex,
        label: channelLabel(channel.channelIndex),
        name: channel.channelName || '',
        state: channelState(channel)
      }))
  }
  // 设备还没返回通道表：这一路的状态是“未知”而不是“已启用”，
  // 否则一台从未查询成功的设备会看起来一切正常（见 lib/channelState.ts）。
  return Array.from({ length: CHANNEL_COUNT }, (_, index) => ({
    index,
    label: channelLabel(index),
    name: '',
    state: 'unknown'
  }))
})

/**
 * 未开启的通道不参与选择：按钮本身禁用，处理器里再守一次。
 *
 * 参数故意只要求 `state`：通道页签与 ② 的通道卡片是同一件事的两种粒度，
 * 两者都走这一个判定（多写一份"什么算禁用"迟早会不一致）。
 */
function isTabDisabled(tab: { state: ChannelState }): boolean {
  return tab.state === 'disabled'
}

/** 灰色通道的悬停/读屏解释；已启用时返回空串，模板用 `|| undefined` 去掉 title。 */
function tabHint(tab: { state: ChannelState }): string {
  const key = channelStateHintKey(tab.state)
  return key ? t(key) : ''
}

/**
 * 通道按钮的读屏名称。
 *
 * 光念“CH3”无法告诉屏幕阅读器这一路是关掉的，所以状态必须进入无障碍名称；
 * 状态文本来自目录，本文件不持有任何语言的字面量。
 */
function tabAriaLabel(tab: ChannelTab): string {
  const parts = [tab.label]
  if (tab.name) parts.push(tab.name)
  parts.push(t(channelStateLabelKey(tab.state)))
  return parts.join(' ')
}

/**
 * 该通道此刻是否真的在产出数据 —— 与 `enabled` 无关的第二个事实。
 *
 * 只看运行中的会话：帧计数属于当前订阅的那一路，所以还要比对 `channelId`，
 * 否则切换通道的瞬间会把上一路的帧数算到新通道头上。
 */
function tabReceivesData(tab: ChannelTab): boolean {
  return channelReceivesData({
    isActiveChannel: tab.index === activeChannelIndex.value && tab.index === monitor.channelId,
    sessionRunning: monitor.state === 'running',
    frameCount: monitor.frameCountOf('features')
  })
}

/** 实时数据指示灯的文案（目录 key 由 channelState 模块给出）。 */
function tabActivityLabel(tab: ChannelTab): string {
  return t(channelActivityLabelKey(tabReceivesData(tab)))
}

/**
 * 初始通道：优先第一路“没有被明确关闭”的通道。
 *
 * 设备把通道表交回来之后就应当避开关闭的通道，否则一进页面就会给一路没启用的
 * 传感器建数据流。全部关闭时保持 0 —— 是否真的建立连接由主进程决定，UI 不替它下结论。
 */
function preferredChannelIndex(deviceId: string): number {
  const first = [...devices.channelsOf(deviceId)]
    .sort((a, b) => a.channelIndex - b.channelIndex)
    .find((channel) => channelState(channel) !== 'disabled')
  return first?.channelIndex ?? 0
}

const latest = computed(() => monitor.latest)

/** Extended metrics are optional in the domain model: render only when present. */
const extendedMetrics = computed(() => {
  const frame = latest.value
  if (!frame) return []
  const metrics: Array<{ key: string; label: string; value: number | undefined }> = [
    { key: 'oddEven', label: t('metrics.oddEvenHarmonicRatio'), value: frame.oddEvenHarmonicRatio },
    { key: 'complexity', label: t('metrics.spectralComplexity'), value: frame.spectralComplexity },
    { key: 'variation', label: t('metrics.fingerprintVariation'), value: frame.fingerprintVariation }
  ]
  return metrics.filter((metric) => metric.value !== undefined)
})

const isLive = computed(() => monitor.state === 'running' || monitor.state === 'starting')

/** 实时数据指示灯只画在正在监测的那一路上，且会话已经启动。 */
function showActivity(tab: ChannelTab): boolean {
  return tab.index === activeChannelIndex.value && isLive.value
}

// ---------------------------------------------------------------------------
// ② 每通道声纹特性卡片 + 音频回放（业主 2026-09-17）
// ---------------------------------------------------------------------------

/**
 * 每通道一张卡片，显示**该路最后一次读到的**声纹特性。
 *
 * 为什么是"最后一次"而不是"此刻"：设备一次只在一路通道上开流（PROTOCOL-FINDINGS 4.3），
 * 切到别的通道之后这一路就没有帧了。三种状态在卡片上是分开写的（`channelFeatures.ts`）：
 * 实时 / 最后一次读数（带时间）/ 未读取 —— 把"旧读数"画成"实时"比不显示更糟。
 *
 * 这个 computed 只做**取数**，状态判定全部走 `channelFeatureState()`（可单测的纯函数）。
 */
interface ChannelFeatureCardView {
  index: number
  label: string
  name: string
  /** 通道配置状态（开启/关闭/未知）——与上面的"读数状态"是两件事。 */
  state: ChannelState
  feature: RealtimeFeature | null
  featureState: ChannelFeatureState
}

const channelFeatureCards = computed<ChannelFeatureCardView[]>(() =>
  channelTabs.value.map((tab) => {
    const feature = monitor.channelFeatureOf(tab.index)
    return {
      index: tab.index,
      label: tab.label,
      name: tab.name,
      state: tab.state,
      feature,
      featureState: channelFeatureState({
        isActiveChannel: tab.index === activeChannelIndex.value,
        sessionRunning: monitor.state === 'running',
        // 帧计数属于**当前订阅的那一路**：别的通道拿 0，否则切通道的一瞬间会把
        // 上一路的帧数算成"这一路正在实时"。
        frameCount: tab.index === monitor.channelId ? monitor.frameCountOf('features') : 0,
        hasFeature: feature !== null
      })
    }
  })
)

/** 读数状态的样式类：实时=绿、最后一次读数=黄（提醒它不是实时值）、未读取=无色。 */
function featureStateClass(state: ChannelFeatureState): string {
  if (state === 'live') return 'badge--success'
  if (state === 'stored') return 'badge--warning'
  return ''
}

/** 读数的时间（本地时间，秒级就够：帧率是 10 Hz 量级，不是毫秒级的判断依据）。 */
function featureTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString()
}

/**
 * 声学预览回放（② 的「音频播放按钮 + 音量」）。
 *
 * 播放的是**包络预览**而不是原声：跨 IPC 过来的是 100 ms 一帧的降采样波形
 * （`AudioFrameEvent.waveform`），详见 `lib/audioPreview.ts` 的文件头。页面上那句话
 * （`monitorUi.audioPreviewHint`）就是照这个说的。
 *
 * 播放器按组件创建（不是模块级）：离开页面时 `close()` 会真的释放 AudioContext，
 * 模块级实例会让它活到窗口关闭为止。
 */
const audioPlayer = new EnvelopePlayer()
const audioEnabled = ref(false)
const audioError = ref('')
const volumePercent = ref(DEFAULT_VOLUME_PERCENT)

/** 有预览帧才能按：按下去什么都不会发生的按钮比禁用更糟。 */
const canPlayAudio = computed(() => monitor.audio !== null)

function onVolumeInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value)
  const next = Number.isFinite(raw)
    ? Math.min(100, Math.max(0, Math.round(raw)))
    : DEFAULT_VOLUME_PERCENT
  volumePercent.value = next
  audioPlayer.setVolume(next)
}

async function toggleAudio(): Promise<void> {
  audioError.value = ''
  if (audioEnabled.value) {
    audioEnabled.value = false
    await audioPlayer.suspend()
    return
  }
  try {
    // 先把音量推给播放器再起播：否则"先调音量、再按播放"会被回退成默认音量。
    audioPlayer.setVolume(volumePercent.value)
    await audioPlayer.resume()
    audioEnabled.value = true
  } catch (cause) {
    // 自动播放策略或没有输出设备：说实话，不要显示成"正在播放"。
    audioEnabled.value = false
    audioError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

/** 切到相机分支时收声：那一支的画面与这一支的音频不该同时在响。 */
async function stopBoxAudio(): Promise<void> {
  if (!audioEnabled.value) return
  audioEnabled.value = false
  await audioPlayer.suspend()
}

watch(
  () => monitor.audio?.timestamp,
  () => {
    const frame = monitor.audio
    if (audioEnabled.value && frame) audioPlayer.push(frame.waveform, frame.frameMs)
  }
)

// ---------------------------------------------------------------------------
// 流失败的一句话（原来的「数据流状态」卡片被删了，失败不能因此变哑）
// ---------------------------------------------------------------------------

/**
 * 有哪一路坏了、最近一条错误是什么；没有失败就返回空串。
 *
 * 那四路各自的指示灯（"哪一路坏了"）是原来那张卡片**真正的价值** —— 所以卡片删掉之后
 * 这个信息必须留下来，只是压成一句话：全局状态说"断开"，而现实里常见的是特征流好着、
 * 时频图那一路一直在失败（或者反过来）。
 */
const streamFailure = computed(() => {
  for (const kind of ALL_STREAM_KINDS) {
    const status = monitor.statusOf(kind)
    if (!status || status.state !== 'ERROR') continue
    const detail = status.lastError ? `：${status.lastError}` : ''
    return `${t('monitorUi.streamFailure', { name: streamKindLabel(kind) })}${detail}`
  }
  return ''
})

// ---------------------------------------------------------------------------
// Chart options
// ---------------------------------------------------------------------------

const AXIS_LINE = '#E5E7EB'
const SPLIT_LINE = '#F1F1F2'
const TEXT_SECONDARY = '#6B7280'

/**
 * Chart metric definitions.
 *
 * `labelKey` rather than a rendered label: ECharts options are rebuilt whenever
 * this computed re-evaluates, so storing the KEY is what makes the axis name and
 * tooltip follow a language change.
 */
const TREND_METRICS = [
  { key: 'spl', labelKey: 'metrics.spl', unit: 'dB', color: '#FF6A1A' },
  { key: 'mainFrequency', labelKey: 'metrics.mainFrequency', unit: 'Hz', color: '#0F766E' },
  { key: 'smoothness', labelKey: 'metrics.smoothness', unit: '', color: '#6B7280' },
  { key: 'bandEnergyRatio', labelKey: 'metrics.bandEnergyRatio', unit: '', color: '#4338CA' }
] as const

type TrendMetricKey = (typeof TREND_METRICS)[number]['key']

const trendMetric = ref<TrendMetricKey>('spl')
const activeTrendMetric = computed(
  () => TREND_METRICS.find((metric) => metric.key === trendMetric.value) ?? TREND_METRICS[0]
)

function timeLabel(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (value: number): string => value.toString().padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const trendOption = computed<EChartsCoreOption>(() => {
  const frames = monitor.features
  const metric = activeTrendMetric.value
  return {
    animation: false,
    grid: { left: 46, right: 16, top: 24, bottom: 28 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: frames.map((frame) => timeLabel(frame.timestamp)),
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisLabel: { color: TEXT_SECONDARY, fontSize: 10, hideOverlap: true }
    },
    yAxis: {
      type: 'value',
      name: metric.unit,
      scale: true,
      nameTextStyle: { color: TEXT_SECONDARY, fontSize: 10 },
      axisLine: { show: false },
      axisLabel: { color: TEXT_SECONDARY, fontSize: 10 },
      splitLine: { lineStyle: { color: SPLIT_LINE } }
    },
    series: [
      {
        name: t(metric.labelKey),
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: frames.map((frame) => frame[metric.key]),
        lineStyle: { width: 1.6, color: metric.color },
        itemStyle: { color: metric.color },
        areaStyle: { color: metric.color, opacity: 0.08 }
      }
    ]
  }
})

/**
 * Frequency axis from `binHz`.
 *
 * THE POINT OF THIS CHART: `/freq_domain` carries 1024 magnitudes and NO
 * frequency axis, so plotting by array index would label a real 1.5 kHz peak as
 * "bin 16" — wrong by the bin width (~94 Hz at 96 kHz). Every x value here is
 * `index * binHz`, taken from the payload the main process derived from the
 * device sample rate.
 */
const spectrumAxisMax = computed(() =>
  spectrumMaxHz(monitor.spectrumMagnitudes, monitor.spectrum?.binHz ?? 0)
)

const spectrumHint = computed(() => {
  const binHz = monitor.spectrum?.binHz ?? 0
  // Reading `locale.value` keeps this computed subscribed to language changes;
  // the label itself is locale-independent (Hz), but the number formatting is not
  // (Spanish writes `94,5`).
  void locale.value
  if (binHz <= 0) return t('monitorUi.waitingSpectrumData')
  return `${spectrumRangeLabel(spectrumAxisMax.value)} · ${t('monitorUi.spectrumPerBin', {
    hz: formatNumber(binHz, 2)
  })}`
})

const spectrumOption = computed<EChartsCoreOption>(() => {
  const magnitudes = monitor.spectrumMagnitudes
  const binHz = monitor.spectrum?.binHz ?? 0
  return {
    animation: false,
    grid: { left: 46, right: 16, top: 24, bottom: 28 },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (value: unknown) =>
        formatNumber(typeof value === 'number' ? value : Number(value), 3)
    },
    xAxis: {
      type: 'value',
      min: 0,
      max: spectrumAxisMax.value > 0 ? spectrumAxisMax.value : undefined,
      name: 'Hz',
      nameTextStyle: { color: TEXT_SECONDARY, fontSize: 10 },
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisLabel: { color: TEXT_SECONDARY, fontSize: 10, formatter: formatHzTick }
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 1,
      name: t('monitorUi.chartNormalizedEnergy'),
      nameTextStyle: { color: TEXT_SECONDARY, fontSize: 10 },
      axisLine: { show: false },
      axisLabel: { color: TEXT_SECONDARY, fontSize: 10 },
      splitLine: { lineStyle: { color: SPLIT_LINE } }
    },
    series: [
      {
        name: t('monitorUi.chartBandEnergy'),
        type: 'line',
        showSymbol: false,
        // 1024 points per sweep at ~1.4 sweeps/s: LTTB keeps the rendered line
        // faithful while cutting the points the canvas has to touch.
        sampling: 'lttb',
        data: spectrumPoints(magnitudes, binHz),
        lineStyle: { width: 1.2, color: '#FF6A1A' },
        itemStyle: { color: '#FF6A1A' },
        areaStyle: { color: '#FF6A1A', opacity: 0.12 }
      }
    ]
  }
})

// ---------------------------------------------------------------------------
// ③b 声学波形（四张图谱卡片里的第三张）
// ---------------------------------------------------------------------------

/**
 * 一帧声学波形（示波器式）。
 *
 * 画的是**跨 IPC 过来的那一份降采样包络本身**（`AudioFrameEvent.waveform`，每帧 100 ms），
 * 而不是原始采样 —— 与「播放」按钮听到的是同一份数据、同一个形状。所以横轴是
 * **这一帧内的毫秒**（0..frameMs），不是绝对时间：一帧画一屏，下一帧覆盖上一帧。
 */
const waveformOption = computed<EChartsCoreOption>(() => {
  const frame = monitor.audio
  const points = frame?.waveform ?? []
  const frameMs = frame?.frameMs ?? 100
  const last = Math.max(points.length - 1, 1)
  return {
    animation: false,
    grid: { left: 46, right: 16, top: 24, bottom: 28 },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (value: unknown) =>
        formatNumber(typeof value === 'number' ? value : Number(value), 3)
    },
    xAxis: {
      type: 'value',
      min: 0,
      max: frameMs,
      name: 'ms',
      nameTextStyle: { color: TEXT_SECONDARY, fontSize: 10 },
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisLabel: { color: TEXT_SECONDARY, fontSize: 10 }
    },
    yAxis: {
      type: 'value',
      // 波形是归一化幅度（±1 满量程），固定量程才能在帧与帧之间比较响度；
      // `scale: true` 会让安静的帧看起来和响的帧一样高。
      min: -1,
      max: 1,
      name: t('monitorUi.waveformAmplitude'),
      nameTextStyle: { color: TEXT_SECONDARY, fontSize: 10 },
      axisLine: { show: false },
      axisLabel: { color: TEXT_SECONDARY, fontSize: 10 },
      splitLine: { lineStyle: { color: SPLIT_LINE } }
    },
    series: [
      {
        name: t('monitorUi.waveformSection'),
        type: 'line',
        showSymbol: false,
        data: points.map((value, index) => [(index / last) * frameMs, value]),
        lineStyle: { width: 1.2, color: '#0F766E' },
        itemStyle: { color: '#0F766E' }
      }
    ]
  }
})

// ---------------------------------------------------------------------------
// Device / channel wiring
// ---------------------------------------------------------------------------

/**
 * 采样率是**声纹设备**的事实（`GET /get_sample_rate`）。相机与声呐都没有这个端点，
 * 所以只在这一支上读它 —— 对着别的机型读只会得到一次必然失败的请求，而主进程会把那次失败
 * 记到设备状态上，一台好设备就此显示成"离线"。
 */
async function loadSampleRateIfVoiceprint(deviceId: string): Promise<void> {
  if (!isVoiceprint.value) {
    sampleRate.value = null
    return
  }
  await loadSampleRate(deviceId)
}

async function loadSampleRate(deviceId: string): Promise<void> {
  const result = await callApi(() => window.api.config.getSampleRate(deviceId))
  sampleRate.value = result.success ? (unwrap(result) ?? null) : null
}

function syncFromRoute(): void {
  const queryDevice = typeof route.query.device === 'string' ? route.query.device : ''
  const candidate = queryDevice || devices.selectedDeviceId || devices.devices[0]?.id || ''
  selectedDeviceId.value = candidate
  if (candidate) {
    devices.select(candidate)
    monitor.selectDevice(candidate)
  }
}

/** Start the session for whatever device/channel is currently selected. */
async function startSession(): Promise<void> {
  await monitor.start(ALL_STREAM_KINDS, activeChannelIndex.value)
}

async function toggleSession(): Promise<void> {
  if (isLive.value) {
    await monitor.stop()
    return
  }
  await startSession()
}

/**
 * Switching channel RESTARTS the streams.
 *
 * MEASURED (PROTOCOL-FINDINGS 4.3): the device streams ONE channel per
 * WebSocket connection. There is no "subscribe to another channel" message, so
 * the old connections are closed and new ones opened with the new channel id.
 * Reusing a connection here would silently keep plotting the previous sensor.
 */
async function selectChannel(index: number): Promise<void> {
  if (index === activeChannelIndex.value) return
  // 未开启的通道不参与实时监测：按钮上已挂 `disabled`，这里再守一次，
  // 免得程序化调用（键盘、未来的快捷方式）绕过它去点一路关闭的通道。
  if (channelTabs.value.find((tab) => tab.index === index)?.state === 'disabled') return
  activeChannelIndex.value = index
  if (isLive.value) await startSession()
}

async function toggleRecording(): Promise<void> {
  if (monitor.recording.active) await monitor.stopRecording()
  else await monitor.startRecording()
}

// ---------------------------------------------------------------------------
// Camera live video (FA371) — a different device family, a different panel
// ---------------------------------------------------------------------------

/**
 * An acoustic camera has no box channels and no `/features_stream`, so pointing the
 * WebSocket monitor at it would open sockets at paths that do not exist and report a
 * healthy device as broken. `kind` is the discriminator the rest of the app uses
 * (`DeviceService.cameraClientFor`).
 */
const isCamera = computed(() => selectedDevice.value?.kind === 'acousticCamera')

/**
 * **三种机型，三种实时检测内容**（业主 2026-09-17 第 5 条）。
 *
 * 「查看」把操作员带到这一页，而这一页要看的东西按机型完全不同：
 *
 * | 机型 | 这一屏的内容 | 数据从哪来 |
 * |---|---|---|
 * | 声纹设备（AE08 / FA8） | 通道页签 + 趋势 + 四张图谱 + 每通道声纹特性 + 音频条 | 主进程的四条 WebSocket（`monitor` store） |
 * | 声学相机（FA371） | 单路直播 + 五张声学图 + 检测启停 | 主进程回环 HTTP（`cameraLive`）+ 相机 REST |
 * | SN-16 空气声呐（`auscultationBox`） | 参数与告警同步（`AuscultationPanel`）+ 本机录音回放 | 设备的「拉」通道（HTTP），**没有**实时流 |
 *
 * 第三支是**新增的**：在那之前一台听诊盒子/声呐落到的是声纹那一支，而那一支会去开
 * `/features_stream` —— 这台设备上没有那个端点，于是"健康的设备"被显示成"实时监测起不来"。
 * 这与相机那一支的理由是同一个：**不能把不属于这一族的协议指向这台设备**。
 *
 * 声呐这一支现在**没有实时图**，因为这一族的实时音频/时频流是 WebSocket
 * （手册给了 `/audio_stream`、`/stft_stream`，SN-16 另有 `/all_chns_stream`），我们还没有接入，
 * 也没有在真机上验过帧格式。宁可这一屏少一块，也不画一张假的实时图 —— 界面上那句话
 * 就是这件事的说明（`monitorUi.sonarLiveUnwired`）。
 */
const isSonar = computed(() => selectedDevice.value?.kind === 'auscultationBox')

/** 声纹设备那一支（也是"没有选中设备"时的默认支，与改造前一致）。 */
const isVoiceprint = computed(() => !isCamera.value && !isSonar.value)

const cameraLive = ref<CameraLiveState | null>(null)
const cameraBusy = ref(false)
const videoEl = ref<HTMLVideoElement | null>(null)

/**
 * Status -> catalogue KEY.
 *
 * A key rather than rendered text, so the label follows a language change instead of
 * freezing at the language active when this module was evaluated — the same reason
 * the chart metrics store `labelKey`.
 */
const CAMERA_STATUS_KEYS: Record<CameraLiveStatus, string> = {
  idle: 'cameraLiveUi.statusIdle',
  starting: 'cameraLiveUi.statusStarting',
  playing: 'cameraLiveUi.statusPlaying',
  'rtsp-disabled': 'cameraLiveUi.statusRtspDisabled',
  'ffmpeg-missing': 'cameraLiveUi.statusFfmpegMissing',
  error: 'cameraLiveUi.statusError',
  // 本机的并发预算满了 —— 不是设备故障，也不是流故障（见共享域模型的说明）。
  'limit-exceeded': 'cameraLiveUi.statusLimitExceeded'
}

const cameraStatus = computed<CameraLiveStatus>(() => cameraLive.value?.status ?? 'idle')
const cameraStatusLabel = computed(() => t(CAMERA_STATUS_KEYS[cameraStatus.value]))
/** Only these two states own a URL worth handing to a <video> element. */
const cameraActive = computed(
  () => cameraStatus.value === 'starting' || cameraStatus.value === 'playing'
)
const cameraLiveUrl = computed(() =>
  cameraActive.value ? (cameraLive.value?.url ?? '') : ''
)
const cameraTone = computed(() => {
  if (cameraStatus.value === 'error' || cameraStatus.value === 'ffmpeg-missing') return 'danger'
  if (cameraStatus.value === 'rtsp-disabled' || cameraStatus.value === 'limit-exceeded') return 'warn'
  return cameraActive.value ? 'ok' : 'idle'
})

/**
 * The tone above mapped onto the classes that actually exist in `main.css`.
 *
 * `badge--ok` / `alert--warn` are NOT styles in this app (the vocabulary is
 * accent/success/warning/danger), and inventing a class in a scoped block would give
 * the badge no colour at all rather than a wrong one.
 */
const cameraBadgeClass = computed(() => {
  if (cameraTone.value === 'danger') return 'badge badge--danger'
  if (cameraTone.value === 'warn') return 'badge badge--warning'
  if (cameraTone.value === 'ok') return 'badge badge--success'
  return 'badge'
})

const cameraAlertClass = computed(() => {
  if (cameraTone.value === 'danger') return 'alert alert--danger'
  if (cameraTone.value === 'warn') return 'alert alert--warning'
  if (cameraTone.value === 'ok') return 'alert alert--success'
  return 'alert'
})

/**
 * The honest explanation under the player.
 *
 * The main process's own text wins when it has one: it either names the device fact
 * (`rtsp_enabled=0`) or quotes ffmpeg's stderr tail, both of which are more useful
 * than a generic sentence. The catalogue supplies the next step only when there is
 * nothing better to say.
 */
const cameraMessage = computed(() => {
  const state = cameraLive.value
  if (state?.error) return state.error
  if (cameraStatus.value === 'rtsp-disabled') return t('cameraLiveUi.rtspDisabledHint')
  if (cameraStatus.value === 'ffmpeg-missing') return t('cameraLiveUi.ffmpegMissingHint')
  if (cameraStatus.value === 'limit-exceeded') return t('cameraLiveUi.limitExceededHint')
  if (cameraStatus.value === 'error') return t('cameraLiveUi.errorHint')
  return ''
})

const cameraModeLabel = computed(() =>
  cameraLive.value?.mode === 'transcode'
    ? t('cameraLiveUi.modeTranscode')
    : t('cameraLiveUi.modeRemux')
)

/** Bytes actually forwarded, and which RTSP address candidate is in use. */
const cameraMeta = computed(() => {
  const state = cameraLive.value
  if (!state) return ''
  const parts: string[] = []
  if (state.bytesSent !== undefined) {
    parts.push(t('cameraLiveUi.dataForwarded', { count: state.bytesSent }))
  }
  if (state.attempt !== undefined) {
    parts.push(t('cameraLiveUi.attemptInfo', { index: state.attempt, id: state.attemptId ?? '' }))
  }
  return parts.join(' · ')
})

/** Read the main process's authoritative session state (an unguarded read). */
async function refreshCameraState(): Promise<void> {
  const id = selectedDeviceId.value
  if (!id) return
  const result = await callApi(() => window.api.cameraLive.state(id))
  cameraLive.value = result.success ? (unwrap(result)?.[0] ?? null) : null
}

async function startCameraLive(): Promise<void> {
  const id = selectedDeviceId.value
  if (!id || cameraBusy.value) return
  cameraBusy.value = true
  try {
    const result = await callApi(() => window.api.cameraLive.start({ deviceId: id }))
    if (!result.success) {
      // An IPC failure is still a STATE this panel can render, so the operator gets
      // the reason instead of an empty black box.
      cameraLive.value = { deviceId: id, status: 'error', error: resultMessage(result) }
      return
    }
    cameraLive.value = unwrap(result) ?? null
  } finally {
    cameraBusy.value = false
  }
}

async function stopCameraLive(): Promise<void> {
  // Release the element FIRST: it is what holds the loopback request open, and
  // stopping the main process under a live request would leave the <video> retrying.
  const video = videoEl.value
  if (video) {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
  cameraLive.value = null
  // 停流之后"暂停画面"这个状态不再有意义：下一次起播必须是活的画面。
  picturePaused.value = false
  const id = selectedDeviceId.value
  if (!id) return
  await callApi(() => window.api.cameraLive.stop(id))
}

/**
 * The stream ended or failed. Ask the main process WHY rather than guessing: a
 * crashed ffmpeg is reported there as an `error` state carrying its stderr tail, and
 * that is what the panel must show instead of a silently frozen last frame.
 */
function onVideoProblem(): void {
  void refreshCameraState()
}

/**
 * 第一帧到了（或播放真的开始了）。
 *
 * `start` 交回来的是 `starting`——ffmpeg 已经起来、回环地址已经存在，而状态变成
 * `playing` 是**随后**在主进程里发生的，没有任何推送会告诉渲染层。所以不在这里重读
 * 一次，面板就会一直挂着「正在启动…」，并且 录像/抓图 在**画面已经在播**的情况下
 * 仍然是灰的（原因还写着「正在启动」）。
 *
 * 这个洞先在视频墙上被测出来并修掉，监测页这里是同一个洞：`@error`/`@ended` 已经走
 * `refreshCameraState()`，成功的这条路以前没有对应的一步。
 */
function onVideoReady(): void {
  void refreshCameraState()
  // 一有画面就把记住的音量写上去（元素是这一刻才存在的，之前写不了）。
  applyAudioOutput()
}

/** Start/stop for the panel's single button. */
async function toggleCameraLive(): Promise<void> {
  if (cameraActive.value) await stopCameraLive()
  else await startCameraLive()
}

// ---------------------------------------------------------------------------
// 第 21 条：画面冻结、音量记忆、翻转
// ---------------------------------------------------------------------------

/**
 * 「暂停画面」不是「暂停设备」。
 *
 * 这一路是主进程用 ffmpeg 转封装出来的**实时**流：渲染层没有、也不该有"暂停设备推流"这件事
 * （ffmpeg 与 RTSP 会话都在主进程，暂停它等于停流，那就不是暂停而是停止了）。所以这个按钮
 * 做的是 `video.pause()` —— **冻住眼前这一帧**，再按一下从实时位置继续。
 * 名字里带「画面」两个字就是为了不让它读成"设备停了"（与 §15.13 那条口径一致：
 * 界面不能替设备说一句它没做过的事）。
 */
const picturePaused = ref(false)

function togglePicturePause(): void {
  const video = videoEl.value
  if (!video) return
  if (picturePaused.value) {
    picturePaused.value = false
    void video.play().catch(() => {
      // 播放被拒（自动播放策略）：把状态放回"暂停"，按钮与画面才不会互相矛盾。
      picturePaused.value = true
    })
  } else {
    video.pause()
    picturePaused.value = true
  }
}

/**
 * 音量（第 21 条「音量可调并**记住**」）。
 *
 * 三条判断，每一条都有理由：
 *   1. **默认静音起播**：第 21 条要求"选中即自动播放"，而浏览器的自动播放策略不允许
 *      带声音自动播 —— 所以自动起播那一次必须是 muted，音量滑杆是**用户手势**，
 *      拖动它才算"他要求出声"。`audioUnlocked` 就是这件事的状态；
 *   2. **记住的是音量值，不是"要不要出声"**：下次进来仍然静音起播（策略不变），
 *      但滑杆位置与一拖动之后的响度都是上次那个数；
 *   3. **写到元素属性上**：`<video>` 读的是元素自己的 `volume` / `muted`，
 *      改了响应式变量而不写元素，界面上滑杆动了而声音没变。
 */
const liveVolume = ref(CAMERA_DEFAULT_VOLUME)
const audioUnlocked = ref(false)

const liveVolumePercent = computed(() => Math.round(liveVolume.value * 100))

const liveVolumeLabel = computed(() =>
  !cameraActive.value
    ? t('cameraLiveUi.volumeNoPicture')
    : liveVolume.value === 0
      ? t('cameraLiveUi.volumeMuted')
      : t('cameraLiveUi.volumeValue', { percent: liveVolumePercent.value })
)

function applyAudioOutput(): void {
  const video = videoEl.value
  if (!video) return
  // 顺序有意义：先写 volume 再解除 muted —— 反过来的话，解除静音的那一瞬间会以旧音量
  // 响一下（滑杆在 0 时那一瞬间是满音量）。
  video.volume = sanitiseCameraVolume(liveVolume.value)
  video.muted = !audioUnlocked.value || video.volume === 0
}

function onLiveVolumeInput(event: Event): void {
  const value = (event.target as HTMLInputElement | null)?.value
  liveVolume.value = sanitiseCameraVolume(value)
  // 拖动滑杆 = 用户手势：这一下之后才允许出声。
  audioUnlocked.value = true
  applyAudioOutput()
  saveCameraVolume(selectedDeviceId.value, liveVolume.value)
}

/** 画面翻转（第 21 条）：左右 / 上下 / 90°，三个独立开关。 */
const flip = ref<CameraFlip>({ ...CAMERA_FLIP_NONE })

function toggleFlip(axis: keyof CameraFlip): void {
  flip.value = { ...flip.value, [axis]: !flip.value[axis] }
}

const videoTransform = computed(() => cameraFlipTransform(flip.value))

const flipActive = computed(
  () => flip.value.horizontal || flip.value.vertical || flip.value.quarter
)

// ---------------------------------------------------------------------------
// Camera NVR interactions: context menu, manual recording, snapshot, full screen
// ---------------------------------------------------------------------------

/**
 * 这些是**不属于相机状态**的界面事实，用来喂给纯函数 `buildCameraNvrMenu()`。
 * 菜单项的可用性判断只发生在那个函数里——面板按钮读的是同一个 `captureReadiness`，
 * 所以「菜单亮着但按钮灰着」这种漂移在结构上不可能发生。
 */
const overlayVisible = ref(true)
const stageEl = ref<HTMLElement | null>(null)
const fullscreen = ref(false)
const recording = ref(false)
const recordingStartedAt = ref(0)
const recordingElapsed = ref(0)
const recordingId = ref('')
const nvrBusy = ref(false)
const nvrError = ref('')
const nvrNotice = ref('')
/** 最近一次抓图的路径：提示条上的「打开所在文件夹」用它。 */
const lastSnapshotAbsolute = ref('')
const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
/**
 * 被右键的那一格所属的设备。
 *
 * 菜单是对**画面格**打开的，不是对整页打开的：动作必须作用在右键的那一格上。
 * 因此这里记住打开时的设备 id，而不是每次都读「当前所选设备」——两者今天相同
 * （相机页只有一格），但通道墙上会有多格，那时读所选设备就是错的。
 */
const menuDeviceId = ref('')
const alarmDialogOpen = ref(false)
/**
 * ⑤ 本机回放 / 检测记录下载两块弹窗的状态。
 *
 * 目标设备直接用 `nvrTargetId`（被右键的那一格，退回当前所选设备）：这一页只有
 * 一路画面，所以不需要画面墙那种"每格各记一份设备"的结构。
 */
const playbackOpen = ref(false)
/** 从「下载检测记录」接过来的那一段录像（下载 → 回放的真实闭环）。 */
const playbackPresetId = ref('')
const downloadOpen = ref(false)

function openPlaybackDialog(presetId = ''): void {
  playbackPresetId.value = presetId
  playbackOpen.value = true
}

/**
 * 下载完成后回放刚拿到的那一段。
 *
 * 下载下来的检测录像会被登记进**同一张录像表**，所以这不是一句客套话：关掉下载弹窗、
 * 带着这个录像 id 打开回放弹窗，操作员立刻能看到刚下载的画面（与画面墙同一条闭环）。
 */
function onDownloadedPlay(recordingId: string): void {
  downloadOpen.value = false
  if (recordingId === '') return
  openPlaybackDialog(recordingId)
}

/** NVR 动作的目标设备：优先用被右键的那一格，其次退回当前所选设备。 */
const nvrTargetId = computed(() => menuDeviceId.value || selectedDeviceId.value)

/** 录制计时器：只在录制中走，卸载/停止时一定清掉（否则会是一个静默泄漏）。 */
let recordingTimer: ReturnType<typeof setInterval> | undefined

function stopRecordingTimer(): void {
  if (recordingTimer !== undefined) {
    clearInterval(recordingTimer)
    recordingTimer = undefined
  }
}

function startRecordingTimer(startedAt: number): void {
  stopRecordingTimer()
  recordingStartedAt.value = startedAt
  recordingElapsed.value = Math.max(0, Date.now() - startedAt)
  recordingTimer = setInterval(() => {
    recordingElapsed.value = Math.max(0, Date.now() - recordingStartedAt.value)
  }, 500)
}

const readiness = computed(() => cameraCaptureReadiness(cameraLive.value))

const nvrEnvironment = computed<CameraNvrEnvironment>(() => ({
  deviceName: selectedDevice.value?.name ?? '',
  recording: recording.value,
  fullscreen: fullscreen.value,
  overlay: overlayVisible.value,
  hasUsableSource: cameraActive.value,
  /**
   * 设备族能力：决定菜单项的**存在**，而不是是否可点。
   *
   * 声学相机有实时视频与「告警策略 + 告警条件」模型；声纹设备两者都没有
   * （它的告警档位走的是另一套接口）。所以在这台设备上，抓图/录像/RTSP 相关项
   * 与告警配置要么出现、要么根本不出现——不会出现一整屏永远点不动的灰项。
   */
  capabilities: {
    liveVideo: isCamera.value,
    alarmModel: isCamera.value,
    /*
     * ⑤ 与总览右键功能一致：本机录像回放与检测记录下载在这一页也真的实现了
     * （同一对弹窗组件），所以两项都声明为"有"。
     *
     * `tileClose` **故意不声明**：那是画面墙的"清空这一格"，而这一页只有一路画面，
     * 没有格可清 —— 停止这一路是页头那颗「停止」按钮的事。声明它只会多出一项
     * 语义重叠的菜单项（做不到就不出现，见 `camera-nvr.ts` 的规则一）。
     */
    localPlayback: true,
    detectDownload: true
  }
}))

const menuItems = computed<CameraNvrMenuItem[]>(() =>
  buildCameraNvrMenu(cameraLive.value, nvrEnvironment.value)
)

const recordingClock = computed(() => formatDuration(recordingElapsed.value))

/**
 * 抓图提示里的路径：优先显示存储根相对路径的尾部（绝对路径太长），
 * 「打开所在文件夹」用绝对路径。
 */
const snapshotLabel = computed(() => {
  const path = lastSnapshotAbsolute.value
  if (path === '') return ''
  const parts = path.split(/[\\/]/)
  return parts.slice(-3).join('/')
})

function onCameraContextMenu(event: MouseEvent): void {
  // 浏览器原生菜单在监控软件里没有意义，而且会把我们的菜单顶掉。
  event.preventDefault()
  menuX.value = event.clientX
  menuY.value = event.clientY
  // 菜单记住**是哪一个画面格**被右键的。今天相机页只有一个画面格，但通道墙
  // 那边会有多个：如果动作只认「当前所选设备」，右键 B 格却对 A 格录像就只是
  // 时间问题。事件来自哪一格，动作就作用于哪一格。
  menuDeviceId.value = selectedDeviceId.value
  menuOpen.value = true
}

async function refreshRecordingState(): Promise<void> {
  const id = nvrTargetId.value
  if (!id) return
  const result = await callApi(() => window.api.cameraNvr.recordingState(id))
  const state = result.success ? unwrap(result)?.[0] : undefined
  if (state?.recording === true) {
    recording.value = true
    if (state.startedAt !== undefined) startRecordingTimer(state.startedAt)
    recordingId.value = ''
  } else if (!nvrBusy.value) {
    recording.value = false
    stopRecordingTimer()
  }
}

async function toggleManualRecording(): Promise<void> {
  const id = nvrTargetId.value
  if (!id || nvrBusy.value) return
  nvrBusy.value = true
  nvrError.value = ''
  nvrNotice.value = ''
  try {
    if (recording.value) {
      const result = await callApi(() => window.api.cameraNvr.stopRecording(id))
      recording.value = false
      stopRecordingTimer()
      if (!result.success) {
        nvrError.value = resultMessage(result)
        return
      }
      const saved = unwrap(result)
      if (saved) {
        recordingId.value = saved.recordingId ?? ''
        nvrNotice.value = t('cameraNvrUi.recordSaved', {
          duration: formatDuration(saved.durationMs),
          size: formatBytes(saved.fileSize),
          path: saved.relativePath
        })
        // 码流中途断掉时主进程会给出诊断；文件已保留，但必须让操作员看见。
        if (saved.warning) {
          nvrError.value = t('cameraNvrUi.recordWarning', { reason: saved.warning })
        }
      }
      return
    }

    const result = await callApi(() => window.api.cameraNvr.startRecording(id))
    if (!result.success) {
      nvrError.value = resultMessage(result)
      return
    }
    recording.value = true
    startRecordingTimer(unwrap(result)?.startedAt ?? Date.now())
  } finally {
    nvrBusy.value = false
  }
}

async function takeSnapshot(): Promise<void> {
  const id = nvrTargetId.value
  if (!id || nvrBusy.value) return
  nvrBusy.value = true
  nvrError.value = ''
  nvrNotice.value = ''
  try {
    const result = await callApi(() => window.api.cameraNvr.snapshot(id))
    if (!result.success) {
      nvrError.value = resultMessage(result)
      return
    }
    const captured = unwrap(result)
    if (!captured) return
    lastSnapshotAbsolute.value = captured.absolutePath
    nvrNotice.value = t('cameraNvrUi.snapshotSaved', { path: snapshotLabel.value })
  } finally {
    nvrBusy.value = false
  }
}

/** 「打开所在文件夹」：主进程只接受存储根内的路径（`StorageService.resolve`）。 */
async function revealSnapshot(): Promise<void> {
  if (lastSnapshotAbsolute.value === '') return
  const result = await callApi(() => window.api.app.revealFile(lastSnapshotAbsolute.value))
  if (!result.success) nvrError.value = resultMessage(result)
}

async function toggleFullscreen(): Promise<void> {
  const stage = stageEl.value
  if (!stage) return
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else {
      await stage.requestFullscreen()
    }
  } catch {
    // 浏览器/Electron 都可能拒绝（窗口未聚焦、权限策略）；如实说明，不要静默。
    nvrError.value = t('cameraNvrUi.fullscreenFailed')
  }
}

function onFullscreenChange(): void {
  fullscreen.value = document.fullscreenElement === stageEl.value
}

/**
 * 复制 RTSP 地址。
 *
 * 先向主进程要**可用**的地址（含口令，管理员通道）：打码地址贴进播放器是打不开的。
 * 拿不到就退回状态里那个打码地址，并且**明说**它是打码的——两种结果都用不同的
 * 提示语，让操作员知道剪贴板里到底是什么。
 */
async function copyRtspAddress(): Promise<void> {
  const id = nvrTargetId.value
  if (!id) return
  nvrError.value = ''
  const sourceResult = await callApi(() => window.api.cameraLive.source(id))
  const source = sourceResult.success ? unwrap(sourceResult) : undefined
  const text = source?.url ?? cameraLive.value?.rtspUrl ?? ''
  if (text === '') {
    nvrError.value = t('cameraNvrUi.reasonNoAddress')
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    nvrNotice.value = source ? t('cameraNvrUi.copyDone') : t('cameraNvrUi.copyMaskedDone')
  } catch {
    nvrError.value = t('cameraNvrUi.copyFailed')
  }
}

async function openInExternalPlayer(): Promise<void> {
  const id = nvrTargetId.value
  if (!id) return
  nvrError.value = ''
  const result = await callApi(() => window.api.cameraLive.source(id))
  const source = result.success ? unwrap(result) : undefined
  if (!source) {
    nvrError.value = t('cameraNvrUi.reasonNoSource')
    return
  }
  const opened = await callApi(() => window.api.app.openExternal(source.url))
  if (!opened.success) nvrError.value = resultMessage(opened)
}

/**
 * 菜单派发：所有动作都在这里落地，视图里不再有第二份可用性判断。
 *
 * 菜单本身在执行完一个动作后会关闭（组件负责），这里只管做事。
 */
async function onMenuSelect(action: CameraNvrAction): Promise<void> {
  switch (action) {
    case 'toggle-recording':
      await toggleManualRecording()
      return
    case 'snapshot':
      await takeSnapshot()
      return
    case 'alarm-config':
      alarmDialogOpen.value = true
      return
    case 'toggle-fullscreen':
      await toggleFullscreen()
      return
    case 'copy-rtsp':
      await copyRtspAddress()
      return
    case 'open-external':
      await openInExternalPlayer()
      return
    case 'toggle-overlay':
      overlayVisible.value = !overlayVisible.value
      return
    /*
     * ⑤：这两项与总览的画面墙是同一对弹窗组件，所以这里的实现只有"打开哪一个"。
     * 列表、下载、回放的逻辑都在组件里，两处不会分叉。
     */
    case 'playback':
      openPlaybackDialog()
      return
    case 'download-detect':
      downloadOpen.value = true
      return
    default:
      return
  }
}

/**
 * 离开画面时把正在进行的录像正式收尾。
 *
 * 「切换设备 / 离开页面」不是「丢掉这段录像」：停止动作会走完整的收尾校验并把
 * 文件登记进录像表，因此这段素材仍然出现在录像列表里。反过来，如果什么都不做，
 * 主进程里就会留下一个没人看得见的 ffmpeg 在写文件。
 */
async function finaliseRecordingIfAny(): Promise<void> {
  if (!recording.value || nvrTargetId.value === '') return
  await toggleManualRecording()
}

onMounted(async () => {
  document.addEventListener('fullscreenchange', onFullscreenChange)
  if (devices.devices.length === 0) await devices.load()
  syncFromRoute()
  if (selectedDeviceId.value) {
    // 通道表要先到手，初始通道才能避开被明确关闭的那几路。
    await devices.loadChannels(selectedDeviceId.value)
    activeChannelIndex.value = preferredChannelIndex(selectedDeviceId.value)
    await loadSampleRateIfVoiceprint(selectedDeviceId.value)
    // A camera gets the live-video panel, not a WebSocket monitor session: its
    // channels are empty and its stream paths do not exist on the device.
    if (isCamera.value) {
      await refreshCameraState()
      // 主进程才是录像状态的权威：刷新页面后录制指示器必须能自己恢复，
      // 而不是显示成「没在录」。
      await refreshRecordingState()
      // 第 21 条：音量**记住**（每台设备一份）；这一路画面还没拿到用户手势，
      // 所以起播是静音的，出声要由滑杆那一次手势决定。
      liveVolume.value = loadCameraVolume(selectedDeviceId.value)
      audioUnlocked.value = false
      await autoPlayCameraIfWorking()
    } else if (isVoiceprint.value) {
      await startSession()
    }
    // 声呐那一支什么都不开：它的协议里没有我们要订的实时流（见 `isSonar` 的注释），
    // 而对着它开一条 `/features_stream` 只会让一台健康的设备显示成"监测起不来"。
  }
})

/**
 * 这一页也要参与「相机在工作就自动起播」。
 *
 * 产品原话是「软件打开如果是相机有在工作就自动播放视频」，而设备树的「实时视频」
 * 打开的正是本页（`/monitor?device=<id>`）。此前自动起播只写在总览页当时的单路播放器
 * （`CameraLiveSection.vue`，现已删除）里，于是同一个需求在两条入口上表现不同：
 * **总览页自动出画面，实时监测页停在「视频未启动」等操作员按按钮**。同一个产品需求不应该有两条答案。
 *
 * 判定仍然只走共享的 `decideCameraAutoPlay()`（`autoPlayIfWorking` 内部就是它），
 * 所以这一页**不会**绕开「一次进程一次尝试」「手动停止优先」这些既有约束，也不会
 * 另写一套「有在工作」的标准。
 *
 * `start` 与 `adopt` 之后必须重读一次会话状态：本页的 `cameraLive` 是本组件自己的
 * IPC 快照，不是 store 里的那一份，地址不会自己出现。
 */
async function autoPlayCameraIfWorking(): Promise<void> {
  if (!settings.loaded) await settings.load()
  const decision = await cameraLiveStore.autoPlayIfWorking({
    autoPlayEnabled: settings.settings?.autoPlayCameraLive !== false,
    cameraRegistered: devices.devices.some((device) => device.kind === 'acousticCamera'),
    deviceId: selectedDeviceId.value,
    deviceStatus: selectedDevice.value?.status ?? 'UNKNOWN'
  })
  if (decision.action === 'start' || decision.action === 'adopt') await refreshCameraState()
}

// Keep the store's notion of "current device" in sync when the user switches.
watch(selectedDeviceId, async (id) => {
  if (!id) return
  const live = isLive.value
  devices.select(id)
  await devices.loadChannels(id)
  void loadSampleRateIfVoiceprint(id)
  activeChannelIndex.value = preferredChannelIndex(id)
  monitor.selectDevice(id)
  if (isCamera.value) {
    // Leaving the box session running while a camera is displayed would keep four
    // sockets open on a device nobody is looking at.
    if (live) await monitor.stop()
    // ② 的预览声音也要停：切到相机之后还在响，操作员会以为是相机那一路的声音。
    await stopBoxAudio()
    // 正在录像时必须先收尾：录像子进程是主进程的，切设备不会自己停，
    // 而一个没有界面的录像等于一个看不见的 ffmpeg。
    await finaliseRecordingIfAny()
    await stopCameraLive()
    // 音量是**每台设备各记一份**的（同一间机房里两台相机的拾音电平可以差很多）。
    liveVolume.value = loadCameraVolume(id)
    // 新的一路画面：还没拿到用户手势，出声这件事要重新由滑杆决定。
    audioUnlocked.value = false
    await refreshCameraState()
    await refreshRecordingState()
    // 第 21 条：**选中即自动播放**。挂在换设备这条路径上，与挂载那条走同一个
    // `autoPlayCameraIfWorking()` —— 两条入口读的是同一份判定，不会一个自动一个不自动。
    await autoPlayCameraIfWorking()
  } else if (isSonar.value) {
    /*
     * 切到声呐：**把声纹设备那一套全部收干净**，然后什么都不开。
     * 这一支不订阅任何流，所以最容易出错的地方正好相反 —— 上一台设备的四条 WebSocket
     * 与预览声音如果留着，操作员会以为屏幕上那块正在播的就是眼前这台声呐。
     */
    await stopCameraLive()
    if (live) await monitor.stop()
    await stopBoxAudio()
    await finaliseRecordingIfAny()
  } else {
    // ...and the other way round: a live camera stream must not keep an ffmpeg
    // process running once the operator has switched to a box.
    await stopCameraLive()
    if (live) await startSession()
  }
  void router.replace({ path: '/monitor', query: { ...route.query, device: id } })
})

/**
 * RELEASE EVERYTHING.
 *
 * Both halves are required and they are not the same thing:
 *   - `stop()` closes the four WebSocket connections in the main process and
 *     releases its Ring Buffer, so the device stops streaming to nobody;
 *   - `unsubscribe()` calls the six unsubscribe functions returned by
 *     `window.events.on*` and clears the buffers. Those listeners live in the
 *     preload bridge, NOT in this component: skipping this call would keep the
 *     callback closures (and the JPEG/feature buffers) alive and decoding for
 *     the rest of the window's life, silently.
 *
 * `stop()` already releases the listeners internally; the explicit second call
 * is idempotent and documents the contract at the call site.
 */
onUnmounted(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  // 菜单是 Teleport 到 body 的浮层，卸载时它不会跟着组件消失，必须显式关闭。
  menuOpen.value = false
  void monitor.stop()
  monitor.unsubscribe()
  // ② 的预览播放器：AudioContext 不会随组件卸载自己消失，必须显式关掉。
  void audioPlayer.close()
  // 录音计时器必须在卸载时清掉：它持有一个闭包，留着就是一个静默的泄漏。
  stopRecordingTimer()
  // 正在进行的录像正式收尾（登记进录像表），而不是丢下一个隐藏的 ffmpeg。
  void finaliseRecordingIfAny()
  // The camera session owns an ffmpeg child process and a bound loopback port in the
  // main process; neither is released by navigation, so leaving the page must stop
  // it explicitly. `stopCameraLive` is a no-op when no session was started.
  void stopCameraLive()
})

const channelHint = computed(() => t('monitorUi.channelHint', { count: channelTabs.value.length }))

/**
 * 已启用通道数，与通道总数并排显示。
 *
 * 通道表还没到手时返回空串：此时“0 路已启用”会是撒谎，真正的情况是“不知道”。
 */
const enabledChannelSummary = computed(() => {
  const list = channels.value
  if (list.length === 0) return ''
  const enabled = list.filter((channel) => channelState(channel) === 'enabled').length
  return t('channelState.enabledSummary', { enabled, total: list.length })
})

const sessionLabel = computed(() => {
  if (monitor.state === 'running') return t('monitorUi.sessionRunning')
  if (monitor.state === 'starting') return t('monitorUi.sessionStarting')
  if (monitor.state === 'error') return t('monitorUi.sessionError')
  return t('monitorUi.sessionStopped')
})
</script>

<template>
  <div class="page">
    <EmptyState
      v-if="devices.devices.length === 0"
      :title="t('monitorUi.noDeviceTitle')"
    >
      <RouterLink class="btn btn--primary" to="/devices">{{ t('monitorUi.goToDevices') }}</RouterLink>
    </EmptyState>

    <template v-else>
      <div class="camera-board">
      <!--
        相机页的排布
        ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
        原来是**一根竖列**：设备头 -> 单路直播 -> 声学图 -> 相机控制 -> 视频墙。
        在 1440px 以上的窗口里，每一张卡都占满整幅宽度、而右侧常常是空的；同时
        「声学图」和「相机控制」这两块互相独立的内容被强行排成上下两行。

        现在整页放进 `.camera-board`（`auto-fit` + 最小列宽的自适应板子），
        并且**保持文档顺序不变**（顺序本身就是可访问性与 Tab 顺序）：

          设备头 / 通道选择       整幅宽（`camera-board__wide`）
          单路直播               整幅宽（画面越宽越有用，也是右键菜单的来源）
          相机五路图谱           整幅宽（⑧：一排五张，占满整幅才排得开）
          相机控制 + 告警入口    `span 1`：宽窗口上并排，窄到放不下就各占一整行

        板子只有两档：能并排就并排，不能就落回一列 —— 而"并排单元"就是下面那两块
        面板（`span 1`，在整个板子的可用宽度 < 2×360px 时退化成整幅宽）。所以声学箱
        那一支（没有这两块面板）的每一个子项就都是整幅宽，与加板子之前逐像素一致。
        具名类 `camera-board__wide` 只写在"无论几列都必须整幅宽"的三块上，没有依赖
        任何 `:not()` 之类花活。

        没有断点、没有定宽列、没有居中，所以 `.page` 那边刚做完的「左对齐、流式」
        不会被这次重排抵消。
      -->
      <section class="card monitor-head camera-board__wide">
        <div class="monitor-head__row">
          <!--
            设备下拉**不在这里**：它被投到顶栏那一格（`#topbar-page-slot`，顶栏的 50% 宽）。
            理由（业主 2026-09-17）：「设备下拉移到顶栏，宽度 50%，删掉右侧状态字样」；
            第 6 条又把下拉收到那一格的 50% 并推到右边，紧挨着「设备数量」指示器
            （见下面 `.topbar-device` 的样式注释）——设备选择是**这一屏在看哪台设备**，
            与顶栏的设备总数/在线数/告警是同一件事，放在页头卡片里会让它和"状态"混成一块。
          -->
          <Teleport to="#topbar-page-slot">
            <!--
              设备下拉 + **在线状态点**（业主 2026-09-18 第 19 条：「设备是否在线直接在选择设备时，
              通过绿点和灰点表示」）。
              原生 `<option>` 里画不出颜色，所以在**下拉旁边**给当前选中的那台一个真正的圆点：
              名字后面跟一个 `●`/`○` 让"哪几台在线"在下拉展开时也能一眼看出来，
              颜色由旁边那个点负责说清楚（绿=在线、灰=离线/未知）。
            -->
            <label class="field topbar-device">
              <select
                v-model="selectedDeviceId"
                class="select"
                :aria-label="t('monitorUi.deviceLabel')"
                :title="t('monitorUi.deviceLabel')"
              >
                <option v-for="device in devices.devices" :key="device.id" :value="device.id">
                  {{ deviceStatusDot(device.status) }} {{ device.name }}（{{ device.ip || t('monitorUi.noAddress') }}）
                </option>
              </select>
              <span
                class="dot topbar-device__dot"
                :class="selectedDeviceOnline ? 'dot--online' : 'dot--offline'"
                data-device-status-dot
                :title="selectedDeviceOnline ? t('devices.status.online') : t('devices.status.offline')"
                :aria-hidden="true"
              ></span>
            </label>
          </Teleport>

          <div v-if="selectedDevice" class="monitor-head__status">
            <StatusBadge
              :status="selectedDevice.status"
              :connection-type="selectedDevice.connectionType"
            />
            <!--
              Box-only readouts. A camera has no channels and no WebSocket monitor
              session, so showing "0 channels" and "monitor stopped" next to it would
              describe the wrong device family.
            -->
            <template v-if="isVoiceprint">
              <span class="muted">{{ channelHint }}</span>
              <span v-if="enabledChannelSummary" class="muted">{{ enabledChannelSummary }}</span>
              <span class="badge" :class="monitor.isRunning ? 'badge--accent' : ''">
                {{ sessionLabel }}
              </span>
            </template>
            <!--
              声呐（SN-16 空气声呐）：这一族**有**通道（16 路），但没有我们已经接入的实时流，
              所以这里给通道数 + 一句"实时流未接入"，而不是一个永远停在"监测已停止"的按钮。
            -->
            <template v-else-if="isSonar">
              <span class="muted">{{ channelHint }}</span>
              <span v-if="enabledChannelSummary" class="muted">{{ enabledChannelSummary }}</span>
              <!--
                这里原来把那一长句（"实时音频/时频流尚未接入…"）挂在 `title` 上，同时页面顶上
                还有同一条横幅。业主 2026-09-18 第 19 条要求删掉那句话 —— 提示不再解释
                "这一屏为什么没有实时图"，在线与否由设备下拉旁边的绿点/灰点回答。
              -->
              <span class="badge">{{ t('monitorUi.sonarFamilyBadge') }}</span>
            </template>
            <span v-else :class="cameraBadgeClass">
              {{ cameraStatusLabel }}
            </span>
          </div>

          <div class="spacer"></div>

          <!-- 会话启停只属于声纹设备：相机走自己的直播按钮，声呐没有要订的流。 -->
          <div v-if="isVoiceprint" class="btn-row">
            <button
              type="button"
              class="btn btn--sm"
              :disabled="monitor.state === 'starting'"
              @click="toggleSession"
            >
              {{ monitor.isRunning ? t('monitorUi.stop') : t('monitorUi.start') }}
            </button>
          </div>
        </div>

        <!-- 通道页签也是声纹设备专有的：相机的"通道"不存在，声呐的通道没有实时数据可切。 -->
        <nav v-if="isVoiceprint" class="channel-tabs" :aria-label="t('monitorUi.channelSelect')">
          <!-- 未启用的通道整块变灰且不可选；状态未知用另一种样式，两者不得混同。 -->
          <button
            v-for="tab in channelTabs"
            :key="tab.index"
            type="button"
            class="channel-tab"
            :class="[
              channelStateClass(tab.state),
              { 'channel-tab--active': tab.index === activeChannelIndex }
            ]"
            :disabled="isTabDisabled(tab)"
            :aria-disabled="isTabDisabled(tab)"
            :aria-label="tabAriaLabel(tab)"
            :title="tabHint(tab) || undefined"
            @click="selectChannel(tab.index)"
          >
            <span class="channel-tab__label">{{ tab.label }}</span>
            <span v-if="tab.name" class="channel-tab__name">{{ tab.name }}</span>
            <!-- 实时数据指示灯：开着却没有数据，和“被关掉”是两件事。 -->
            <span
              v-if="showActivity(tab)"
              class="channel-tab__live"
              :class="{ 'channel-tab__live--on': tabReceivesData(tab) }"
              :title="tabActivityLabel(tab)"
            >
              <span class="visually-hidden">{{ tabActivityLabel(tab) }}</span>
            </span>
          </button>
        </nav>
      </section>

      <!--
        覆盖层（右键菜单、告警对话框）在网格里用 `display: contents` 抵消掉 ——
        它们本身不画东西，但会多出一个"网格项"的占位，见 `.camera-board__overlay`。
      -->
      <!-- ------------------------------------------------------------------
           CAMERA LIVE VIDEO

           The camera publishes H.264 over RTSP, which Chromium cannot demux, so the
           main process re-muxes it with the bundled ffmpeg and serves it from a
           loopback-only HTTP server. This element loads that URL — the single network
           address the renderer is ever given, and the only reason the CSP carries
           `media-src http://127.0.0.1:*`.

           Every state below is reported honestly: "RTSP disabled" is a device fact,
           "ffmpeg missing" is an installation fact, and neither is ever shown as a
           black rectangle.
      ------------------------------------------------------------------ -->
      <section v-if="isCamera" class="card camera-live">
        <div class="section-header">
          <h3 class="section-title">{{ t('cameraLiveUi.title') }}</h3>
          <!--
            播放信息（已转发字节数 / 正在用哪个地址候选）**从页面上删掉了**（第 21 条），
            但它没有丢：它就是这枚状态徽标的悬停说明。删的是"页面上永久占一行的一段诊断"，
            不是这条诊断本身 —— 出问题时它仍是第一条线索。
          -->
          <span :class="cameraBadgeClass" :title="cameraMeta || undefined" data-camera-status>
            {{ cameraStatusLabel }}
          </span>
        </div>

        <!--
          * 单通道 NVR 画面：视频填满面板，叠加信息浮在画面之上。
          * 右键菜单挂在这一层上，因为它是「视频表面」，而不是整个页面。
        -->
        <div
          ref="stageEl"
          class="camera-live__stage"
          :class="{ 'camera-live__stage--fullscreen': fullscreen }"
          @contextmenu="onCameraContextMenu"
        >
          <video
            v-if="cameraLiveUrl"
            ref="videoEl"
            class="camera-live__video"
            :src="cameraLiveUrl"
            :style="{ transform: videoTransform }"
            :class="{
              'camera-live__video--paused': picturePaused,
              'camera-live__video--flipped': flipActive
            }"
            autoplay
            muted
            playsinline
            @error="onVideoProblem"
            @ended="onVideoProblem"
            @loadeddata="onVideoReady"
            @playing="onVideoReady"
          ></video>
          <p v-else class="camera-live__placeholder">{{ cameraStatusLabel }}</p>

          <div v-if="overlayVisible" class="camera-live__overlay">
            <span class="camera-live__overlay-line">{{ t('cameraNvrUi.overlayDevice', { name: selectedDevice?.name ?? '' }) }}</span>
            <span class="camera-live__overlay-line">{{ t('cameraNvrUi.overlayStatus', { status: cameraStatusLabel }) }}</span>
            <span class="camera-live__overlay-line">
              {{ t('cameraNvrUi.overlayStream', { mode: cameraModeLabel, address: cameraLive?.rtspUrl || t('cameraLiveUi.rtspAddressUnknown') }) }}
            </span>
          </div>

          <div v-if="recording" class="camera-live__rec" role="status">
            <span class="camera-live__rec-dot" aria-hidden="true"></span>
            {{ t('cameraNvrUi.recordingBadge', { time: recordingClock }) }}
          </div>
        </div>

        <p v-if="nvrError" class="alert alert--danger" role="alert">{{ nvrError }}</p>
        <p v-else-if="nvrNotice" class="alert alert--success" role="status">
          {{ nvrNotice }}
          <button
            v-if="lastSnapshotAbsolute"
            type="button"
            class="btn btn--sm"
            @click="revealSnapshot"
          >
            {{ t('cameraNvrUi.openFolder') }}
          </button>
        </p>

        <p v-if="cameraMessage" :class="cameraAlertClass" role="status">
          {{ cameraMessage }}
        </p>

        <!--
          视频窗口下方的**通用播放器式控制条**（业主 2026-09-18 第 10 批第 22 条）：
          暂停 / 播放 · 录制 · 查看（抓图）· 回放 · 告警配置，外加音量与三个翻转开关。

          两件事与原来不同：
            · 动作**不再画在画面上方**（原来那排按钮在视频上面）；控制条在画面**下方**，
              与任何播放器的位置一致；
            · **原生 `controls` 关掉了**：它自带一条控制条，而业主要的那几个动作它一个都
              没有（录制、抓图、回放、告警配置）—— 两条控制条并排只会互相抢注意力。

          每一项的可用性都读**同一个 `readiness`**（右键菜单用的也是它），所以"菜单亮着但
          按钮灰着"这种漂移在结构上不可能发生；不可用时把原因写在 `title` 里。
        -->
        <div class="camera-controls" data-camera-controlbar>
          <button
            type="button"
            class="btn btn--sm"
            :disabled="!cameraActive"
            :title="cameraActive ? '' : t('cameraLiveUi.volumeNoPicture')"
            data-action="camera-pause"
            @click="togglePicturePause"
          >
            {{ picturePaused ? t('cameraLiveUi.playPicture') : t('cameraLiveUi.pausePicture') }}
          </button>

          <button
            type="button"
            class="btn btn--sm"
            :class="{ 'btn--primary': !cameraActive }"
            :disabled="cameraBusy"
            data-action="camera-power"
            @click="toggleCameraLive"
          >
            {{
              cameraActive
                ? t('cameraLiveUi.stop')
                : cameraStatus === 'error'
                  ? t('cameraLiveUi.retry')
                  : t('cameraLiveUi.start')
            }}
          </button>

          <button
            type="button"
            class="btn btn--sm"
            :class="{ 'btn--danger': recording }"
            :disabled="nvrBusy || !(recording || readiness.ready)"
            :title="recording || readiness.ready ? '' : readiness.reasonText || t(readiness.reasonKey)"
            data-action="camera-record"
            @click="toggleManualRecording"
          >
            {{
              recording
                ? t('cameraNvrUi.menuStopRecording')
                : t('cameraNvrUi.menuStartRecording')
            }}
          </button>

          <button
            type="button"
            class="btn btn--sm"
            :disabled="nvrBusy || !readiness.ready"
            :title="readiness.ready ? '' : readiness.reasonText || t(readiness.reasonKey)"
            data-action="camera-snapshot"
            @click="takeSnapshot"
          >
            {{ t('cameraLiveUi.lookSnapshot') }}
          </button>

          <button
            type="button"
            class="btn btn--sm"
            data-action="camera-playback"
            @click="playbackOpen = true"
          >
            {{ t('cameraLiveUi.lookPlayback') }}
          </button>

          <button
            type="button"
            class="btn btn--sm"
            data-action="camera-alarm-config"
            @click="alarmDialogOpen = true"
          >
            {{ t('cameraNvrUi.menuAlarmConfig') }}
          </button>

          <!--
            音量（第 21 条「音量可调并**记住**」）。没有画面时禁用并把原因说清楚 ——
            一个按下去什么都不会发生的音量滑杆比没有它更糟（与画面墙同一条口径）。
          -->
          <label class="camera-controls__volume">
            <span class="muted">{{ t('cameraLiveUi.volume') }}</span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              class="camera-controls__slider"
              data-action="camera-volume"
              :value="liveVolumePercent"
              :disabled="!cameraActive"
              :aria-label="liveVolumeLabel"
              :title="liveVolumeLabel"
              @input="onLiveVolumeInput"
            />
            <span class="muted camera-controls__percent">{{ liveVolumePercent }}%</span>
          </label>

          <!-- 翻转：左右 / 上下 / 90°，三个独立开关（第 21 条）。 -->
          <div class="camera-controls__flip" role="group" :aria-label="t('cameraLiveUi.flipGroup')">
            <button
              type="button"
              class="btn btn--sm"
              :class="{ 'btn--primary': flip.horizontal }"
              :aria-pressed="flip.horizontal"
              data-action="camera-flip-horizontal"
              @click="toggleFlip('horizontal')"
            >
              {{ t('cameraLiveUi.flipHorizontal') }}
            </button>
            <button
              type="button"
              class="btn btn--sm"
              :class="{ 'btn--primary': flip.vertical }"
              :aria-pressed="flip.vertical"
              data-action="camera-flip-vertical"
              @click="toggleFlip('vertical')"
            >
              {{ t('cameraLiveUi.flipVertical') }}
            </button>
            <button
              type="button"
              class="btn btn--sm"
              :class="{ 'btn--primary': flip.quarter }"
              :aria-pressed="flip.quarter"
              data-action="camera-flip-quarter"
              @click="toggleFlip('quarter')"
            >
              {{ t('cameraLiveUi.flipQuarter') }}
            </button>
          </div>
        </div>
      </section>

      <!-- ------------------------------------------------------------------
           相机五路实时图谱（⑧）：**排成一排**的那五张卡。

           ⑦ 删掉的是它**旧的那一版式**（竖排/自动换行的五张卡），⑧ 定的是新版式（一排五张）。
           所以这块回来了，但版式不是原来的 —— `CameraAcousticPanel` 里的 `.acam__row`
           现在是 `repeat(auto-fit, minmax(200px, 1fr))`。

           它**必须整幅宽**（`camera-board__wide`）：只占排布板一格时，按板子的列宽规则
           算下来是 (1166 − 2×20)/3 ≈ 375px —— 五张图分 375px，每张 ~60px，表头和
           坐标轴都放不下。实测：整幅宽之后这一排是 1166px，五张各 220px，顶边都是 767。
      ------------------------------------------------------------------ -->
      <CameraAcousticPanel
        v-if="isCamera"
        class="camera-board__wide"
        :device-id="selectedDeviceId"
      />

      <!--
        相机控制：这里**只留实时要看/要按的两块** ——「检测启停」与「应用场景」。
        「检测模式 / 应用模式 / 告警策略 / 维护 / 升级」按业主 2026-09-17（⑨）搬去了
        **设备管理的配置界面**（`DeviceDetailView` 的相机页签），同一份实现按 `sections` 取用。
      -->
      <CameraControlPanel
        v-if="isCamera"
        :device-id="selectedDeviceId"
        :sections="['detect', 'preset']"
      />

      <section v-if="isCamera" class="card camera-alarm-entry">
        <div class="section-header">
          <h3 class="section-title">{{ t('cameraNvrUi.menuAlarmConfig') }}</h3>
        </div>
        <p class="muted alarm-entry__hint">{{ t('cameraAlarmUi.entryHint') }}</p>
        <div class="btn-row">
          <button type="button" class="btn btn--primary btn--sm" @click="alarmDialogOpen = true">
            {{ t('cameraNvrUi.menuAlarmConfig') }}
          </button>
          <RouterLink class="btn btn--sm" to="/alarms">{{ t('cameraAlarmUi.goAlarmList') }}</RouterLink>
        </div>
      </section>

      <!--
        * 右键菜单、告警配置、本机回放、检测记录下载四个弹窗。
        *
        * 菜单的位置/键盘/关闭行为全部封在 `VideoContextMenu` 里（含「不越出窗口
        * 边缘」），这里只提供菜单项（来自纯函数）和动作派发。
        *
        * 后两个弹窗（⑤）与总览的画面墙用的是**同一对组件**，所以"与总览右键功能一致"
        * 不是两套实现的相似，而是同一套实现：列表、下载、回放行为不会分叉。
      -->
      <VideoContextMenu
        class="camera-board__overlay"
        :open="menuOpen"
        :x="menuX"
        :y="menuY"
        :title="t('cameraNvrUi.menuTitle', { name: selectedDevice?.name ?? '' })"
        :items="menuItems"
        @select="onMenuSelect"
        @close="menuOpen = false"
      />

      <CameraAlarmDialog
        class="camera-board__overlay"
        v-model="alarmDialogOpen"
        :device-id="selectedDeviceId"
        :device-name="selectedDevice?.name ?? ''"
      />

      <!-- 本机录像回放：这一页只有一台设备，所以目标就是被右键/所选的那一台。 -->
      <CameraRecordingPlaybackDialog
        class="camera-board__overlay"
        v-model="playbackOpen"
        :device-id="nvrTargetId"
        :device-name="selectedDevice?.name ?? ''"
        :preset-recording-id="playbackPresetId"
      />

      <!-- 设备检测记录下载：下载完成的那一段可以直接接着回放（与画面墙同一条闭环）。 -->
      <CameraDetectDownloadDialog
        class="camera-board__overlay"
        v-model="downloadOpen"
        :device-id="nvrTargetId"
        :device-name="selectedDevice?.name ?? ''"
        @play="onDownloadedPlay"
      />

      <!-- ------------------------------------------------------------------
           实时视频墙在这里**已被删除**（业主 2026-09-17：⑦「删实时视频墙」）。

           为什么删的是这一处而不是组件：多路视频墙在**总览**页仍然是主视图
           （`OverviewView` 用它做整页的相机格子），而实时监测页的职责是"看一台设备"。
           两个页面各挂一次同一块墙，等于同一批视频流有两份起播逻辑与两份音量状态。
      ------------------------------------------------------------------ -->
      </div>

      <!-- ---- acoustic box / 声纹设备（改造后逐像素不变） ----------------- -->
      <template v-if="isVoiceprint">
      <p v-if="monitor.error" class="alert alert--danger" role="alert">{{ monitor.error }}</p>

      <!--
        「数据流状态」那张卡片（`monitorUi.streamSection` 的 stream strip）按业主
        2026-09-17 的要求删掉了（③）。但**失败不能因此变哑**：原来那张卡片的真正价值是
        "哪一路坏了"，所以这里保留**一句话**：有流进入 ERROR 就把它连同最近一条错误写出来。
      -->
      <p v-else-if="streamFailure" class="alert alert--warning" role="alert">
        {{ streamFailure }}
      </p>

      <!--
        ③b 实时趋势**挪到最上面**（业主 2026-09-17：「把实时趋势挪到视频墙的位置」）。

        为什么它在最上面：这一支页面上最该一直盯着的东西就是趋势曲线（当前通道的哪个指标
        在怎么变），而改造前它被统计卡与音频条压在下面 —— 一进页面要滚动才看得到。
        原来占这个位置的是多路视频墙，它按 ⑦ 删掉了。
      -->
      <section class="chart-panel card trend-panel">
        <div class="section-header">
          <h3 class="section-title">{{ t('monitorUi.trendSection') }}</h3>
          <div class="chip-row">
            <button
              v-for="metric in TREND_METRICS"
              :key="metric.key"
              type="button"
              class="chip chip--selectable"
              :class="{ 'chip--accent': trendMetric === metric.key }"
              @click="trendMetric = metric.key"
            >
              {{ t(metric.labelKey) }}
            </button>
          </div>
        </div>
        <EChart
          :option="trendOption"
          height="240px"
          :placeholder="monitor.features.length === 0 ? t('monitorUi.waitingFeatures') : ''"
        />
      </section>

      <!--
        ③b 其下四张图谱卡片（业主确认的四张）：频谱 / 时频图 / 声学波形 / 每通道声纹特性。

        四张都是这一族**真实存在**的数据：频谱来自 /freq_domain（1024 个 bin + binHz），
        时频图是设备自己推的 JPEG，声学波形是跨 IPC 过来的降采样包络（与「播放」按钮听到的
        是同一份数据），每通道声纹特性是每一路最后一次读数。没有为了凑满四张而造数据源。

        列数由这一块自己的宽度决定（auto-fit + 最小 420px），与 §15.31 的图谱排同一套理由：
        媒体查询问的是窗口，不是这一块。
      -->
      <div class="graph-grid">
        <section class="chart-panel card">
          <div class="section-header">
            <h3 class="section-title">{{ t('monitorUi.spectrumSection') }}</h3>
            <span class="muted chart-hint">{{ spectrumHint }}</span>
          </div>
          <EChart
            :option="spectrumOption"
            height="240px"
            :placeholder="monitor.spectrumMagnitudes.length === 0 ? t('monitorUi.waitingSpectrum') : ''"
          />
        </section>

        <section class="chart-panel card">
          <div class="section-header">
            <h3 class="section-title">{{ t('monitorUi.spectrogramSection') }}</h3>
          </div>
          <SpectrogramViewer :frames="monitor.spectrogramFrames" height="240px" />
        </section>

        <section class="chart-panel card">
          <div class="section-header">
            <h3 class="section-title">{{ t('monitorUi.waveformSection') }}</h3>
            <span class="muted chart-hint">{{ t('monitorUi.waveformHint') }}</span>
          </div>
          <EChart
            :option="waveformOption"
            height="240px"
            :placeholder="monitor.audio === null ? t('monitorUi.waitingAudio') : ''"
          />
        </section>

        <!--
          ② 每通道声纹特性卡片（业主 2026-09-17）；
          ③b 把它并入这四张卡片里 —— 它本来就是一张"图谱卡片"。
        -->
        <section class="card chart-panel channel-features">
          <div class="section-header">
            <h3 class="section-title">{{ t('monitorUi.channelFeaturesSection') }}</h3>
            <span class="muted channel-features__hint">
              {{ t('monitorUi.channelFeaturesHint', { count: channelFeatureCards.length }) }}
            </span>
          </div>
          <ul class="channel-features__grid">
            <li v-for="card in channelFeatureCards" :key="card.index">
              <button
                type="button"
                class="channel-card"
                :class="[
                  channelStateClass(card.state),
                  { 'channel-card--active': card.index === activeChannelIndex }
                ]"
                :disabled="isTabDisabled(card)"
                :aria-pressed="card.index === activeChannelIndex"
                :title="tabHint(card) || undefined"
                @click="selectChannel(card.index)"
              >
                <span class="channel-card__head">
                  <span class="channel-card__label">{{ card.label }}</span>
                  <span v-if="card.name" class="channel-card__name">{{ card.name }}</span>
                  <span :class="channelStateClass(card.state)">
                    {{ t(channelStateLabelKey(card.state)) }}
                  </span>
                </span>

                <dl v-if="card.feature" class="channel-card__values">
                  <div class="channel-card__row">
                    <dt>{{ t('metrics.spl') }}</dt>
                    <dd>{{ formatNumber(card.feature.spl, 2) }} dB</dd>
                  </div>
                  <div class="channel-card__row">
                    <dt>{{ t('metrics.mainFrequency') }}</dt>
                    <dd>{{ formatNumber(card.feature.mainFrequency, 2) }} Hz</dd>
                  </div>
                  <div class="channel-card__row">
                    <dt>{{ t('metrics.smoothness') }}</dt>
                    <dd>{{ formatNumber(card.feature.smoothness, 3) }}</dd>
                  </div>
                  <div class="channel-card__row">
                    <dt>{{ t('metrics.bandEnergyRatio') }}</dt>
                    <dd>{{ formatNumber(card.feature.bandEnergyRatio, 3) }}</dd>
                  </div>
                </dl>
                <p v-else class="channel-card__empty">{{ t('monitorUi.channelFeatureUnread') }}</p>

                <span class="channel-card__foot">
                  <span class="badge" :class="featureStateClass(card.featureState)">
                    {{ t(channelFeatureStateLabelKey(card.featureState)) }}
                  </span>
                  <!--
                    读数的时间**必须**画出来：`stored` 那张卡片上的数字是上一次读到的，
                    没有时间的话它和"实时"在视觉上没有区别（这正是这张卡片最容易骗人的地方）。
                  -->
                  <span v-if="card.feature" class="muted channel-card__time">
                    {{ t('monitorUi.channelFeatureUpdated', { time: featureTime(card.feature.timestamp) }) }}
                  </span>
                </span>
              </button>
            </li>
          </ul>
        </section>
      </div>

      <!--
        ③b 时间轴回放：这台设备**本机**录了些什么。
        本机录像（手动录的 + 从设备下载的检测录像）登记在同一张录像表里，时间轴把它们
        按类型画成不同颜色的段，点一段就用共享的 RecordingPlayer 播它。
      -->
      <MonitorRecordingTimeline :device-id="selectedDeviceId" />

      <section class="card-grid card-grid--stats">
        <div class="card">
          <MetricCard
            :label="t('metrics.spl')"
            :value="latest?.spl"
            unit="dB"
            :hint="t('monitorUi.currentValue', { channel: channelLabel(activeChannelIndex) })"
            :precision="2"
          />
        </div>
        <div class="card">
          <MetricCard :label="t('metrics.mainFrequency')" :value="latest?.mainFrequency" unit="Hz" :precision="2" />
        </div>
        <div class="card">
          <MetricCard :label="t('metrics.smoothness')" :value="latest?.smoothness" :precision="3" />
        </div>
        <div class="card">
          <MetricCard :label="t('metrics.bandEnergyRatio')" :value="latest?.bandEnergyRatio" :precision="3" />
        </div>
        <div v-for="metric in extendedMetrics" :key="metric.key" class="card">
          <MetricCard :label="metric.label" :value="metric.value" :precision="3" />
        </div>
      </section>

      <section class="card audio-bar">
        <div class="section-header">
          <h3 class="section-title">{{ t('monitorUi.audioSection') }}</h3>
          <div class="btn-row">
            <!--
              ② 的「音频播放按钮」：播放的是**包络预览**（100 ms 一帧的降采样波形），
              不是原声 —— 下面那行说明与 `lib/audioPreview.ts` 的文件头是同一句话。
              `audio-bar__play` 是**给探针用的**标记类（不带任何样式）。
            -->
            <button
              type="button"
              class="btn btn--sm audio-bar__play"
              :class="{ 'btn--danger': audioEnabled }"
              :disabled="!canPlayAudio"
              @click="toggleAudio"
            >
              {{ audioEnabled ? t('monitorUi.audioStop') : t('monitorUi.audioPlay') }}
            </button>
            <label class="audio-bar__volume">
              <span class="audio-bar__volume-label">{{ t('monitorUi.audioVolume') }}</span>
              <input
                class="audio-bar__slider"
                type="range"
                min="0"
                max="100"
                step="1"
                :value="volumePercent"
                :aria-label="t('monitorUi.audioVolume')"
                @input="onVolumeInput"
              />
              <span class="muted audio-bar__volume-value">{{ volumePercent }}%</span>
            </label>
            <button
              type="button"
              class="btn btn--sm"
              :class="{ 'btn--danger': monitor.recording.active }"
              :disabled="!monitor.isRunning"
              @click="toggleRecording"
            >
              {{ monitor.recording.active ? t('monitorUi.stopRecording') : t('monitorUi.startRecording') }}
            </button>
          </div>
        </div>
        <AudioLevelMeter
          :peak="monitor.audio?.peak"
          :rms="monitor.audio?.rms"
          :recording="monitor.recording.active"
          :elapsed-ms="monitor.recording.elapsedMs"
          :disabled="monitor.audio === null"
          :sample-rate="monitor.audio?.sampleRate ?? sampleRate ?? undefined"
          :frame-ms="monitor.audio?.frameMs"
        />
        <p class="muted audio-bar__hint">{{ t('monitorUi.audioPreviewHint') }}</p>
        <p v-if="audioError" class="alert alert--danger" role="alert">{{ audioError }}</p>
      </section>

      <!--
        「当前帧」那张卡片（`monitorUi.currentFrameSection`）同样按 ③ 删掉了。
        它显示的四项里，采样率与当前通道**已经在页头的通道页签与音频条上**，
        数据来源与谱图缓存是排查用的内部状态 —— 需要时由协议实验室回答，
        不该占实时监测页的一整张卡片。
      -->
      </template>

      <!--
        ---- 声呐（SN-16 空气声呐 / 2023 版听诊盒子）-----------------------------

        第 5 条要求的"三种机型三种内容"里的第三支。这一支**没有实时图**，理由见 `isSonar`
        的注释：这一族的实时音频/时频流是 WebSocket，手册给了路径（`/audio_stream`、
        `/stft_stream`，SN-16 另有 `/all_chns_stream`），但我们没有接入、也没有在真机上验过
        帧格式。宁可少一块，也不画一张假的实时图。

        这一屏放的是**这一族真实存在、我们已经实现**的东西，三块都来自既有设计：
          ① 地址信息（`DeviceInstallationCard`）：业主第 1 条新增的数据，与设备详情页共用；
          ② 参数与告警同步（`AuscultationPanel`）：设备详情页那个"听诊盒子"页签的同一份实现；
          ③ 本机录音回放（`MonitorRecordingTimeline`）：同步拉下来的告警录音都在本机库，
             与声纹设备那一支用的是同一条时间轴。

        **那一长句说明按业主 2026-09-18 第 19 条删掉了**（原来在页面顶上，也在机型号徽标的
        悬停提示里）：设备在不在线由设备下拉旁边的绿点/灰点回答，不再用一句话解释这一屏
        为什么没有实时图。口径记在 `docs/Ivms4200-UX-REFERENCE.md` §15.49。
      -->
      <template v-else-if="isSonar">
        <DeviceInstallationCard :installation="selectedDevice?.installation" />

        <AuscultationPanel :device-id="selectedDeviceId" />

        <MonitorRecordingTimeline :device-id="selectedDeviceId" />
      </template>
    </template>
  </div>
</template>

<style scoped>
/*
 * 实时监测页的排布板。
 *
 * 参与并排的是**上面那条简讯以外的几块**（相机控制 / 告警入口）：板子在能放下
 * 2×360px 时是两列，放不下就是一列，所以窄窗口上它们退回上下排列，控件一个都不会
 * 被裁掉（叠放 = 每块自己占满宽度）。
 *
 * 不参与并排的三块走 `.camera-board__wide`（设备头 / 单路直播 / 相机五路图谱）：
 * 前两块本来就是整幅宽的，第三块（⑧ 的五张图）必须整幅宽才排得成一排 ——
 * 挤在 360px 的一格里，五列每张只剩 ~60px。
 *
 * `minmax(0, 1fr)` 的第一个参数是 **0** 而不是 `auto`：网格项的默认最小尺寸是
 * `auto`，内容里有一个 1024 点的 ECharts canvas 时，`auto` 会让列宽顶在内容的最小
 * 宽度上、把整页撑出横向滚动条。0 允许列真的变窄，图表按容器宽度重排。
 *
 * 板子外面没有任何 width / max-width / margin: auto，所以 `.page` 的"靠左、流式"
 * 由 `.app-content` 的内边距独家决定这件事没有被这次重排改变。
 */
.camera-board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: var(--space-5);
  /*
   * `align-items: start`：网格项的默认值是 `stretch`，同一行里最高的一块会把其余
   * 几块**拉到一样高**（实测：1920x1080 上相机控制会被拉到与声学图一样高，多出来
   * 的那一截是空卡片）。这里只说"各自按自己的内容高"，不改任何控件。
   */
  align-items: start;
}

/* 无论并排成几列都必须占满整幅宽的三块：设备头 / 单路直播画面 / 相机五路图谱。 */
.camera-board__wide,
.camera-board > .camera-live {
  grid-column: 1 / -1;
}

/*
 * 覆盖层（右键菜单、告警对话框）不画东西，但作为网格项会占掉一格的间距，把"声学图"
 * 挤到第二行。`display: contents` 让它们不参与网格布局（它们真正渲染的内容在
 * `Teleport` 到 body 的那一层）。
 */
.camera-board__overlay {
  display: contents;
}

.monitor-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.monitor-head__row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-4);
  flex-wrap: wrap;
}

/*
 * 顶栏那一格里的设备下拉（被 `Teleport` 投进 `#topbar-page-slot`）。
 *
 * 业主 2026-09-17 第 6 条：「宽度改为现在的 50%、位置移到右侧、紧挨着右侧的设备数量标签」。
 *   - **宽度 50%** 是相对**这一格**说的（那一格本身就是顶栏的 50%），所以下拉占顶栏的 25%；
 *   - **靠右**：`margin-left: auto` 把它推到这一格的右端，而这一格的右边紧挨着的就是
 *     `.topbar__actions` 里第一个指示器（设备总数）—— 不需要改顶栏的 DOM 顺序；
 *   - `min-width: 0` 让长设备名在下拉内部截断，而不是把右侧三个指示器挤走。
 *
 * `scoped` 样式对 Teleport 出去的内容仍然生效（Vue 会给它们带上同一个 scope 属性）。
 */
.topbar-device {
  width: 50%;
  min-width: 0;
  margin-left: auto;
  /* 下拉 + 状态点同一行（点贴在下拉的右边）。 */
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.topbar-device .select {
  width: 100%;
  min-width: 0;
}

/*
 * 当前设备的在线状态点（绿=在线、灰=离线/未知）。它是**文字旁边**的一个真实元素，
 * 因为原生 `<option>` 里没有办法给一行上色（见模板里的注释）。
 * `.dot` / `.dot--online` / `.dot--offline` 是全局已有的那一对。
 */
.topbar-device__dot {
  flex: none;
}

.monitor-head__status {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.monitor-head__note {
  font-size: 11.5px;
}

.channel-tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-border);
}

.channel-tab {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  min-width: 74px;
  padding: 5px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.channel-tab:hover {
  background: var(--color-bg-subtle);
}

.channel-tab--active {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}

/* --- 通道状态：未启用 / 状态未知 --------------------------------------- */

/*
 * 未启用：整体压暗、去掉强调色、虚线边框。变灰表达的是“这一路不参与实时监测”，
 * 所以命中区域不再给出“可用”的反馈。
 */
.channel-tab.channel-state--disabled {
  opacity: 0.45;
  background: var(--color-bg-muted);
  border-style: dashed;
  cursor: not-allowed;
}

.channel-tab.channel-state--disabled:hover {
  background: var(--color-bg-muted);
  border-color: var(--color-border);
}

.channel-tab.channel-state--disabled .channel-tab__label {
  color: var(--color-text-secondary);
}

/*
 * 状态未知：同样是灰的，但用警告色虚线，读完状态之前看起来与“明确关闭”不同。
 */
.channel-tab.channel-state--unknown {
  border-style: dashed;
  border-color: var(--color-warning-border);
  color: var(--color-warning);
}

.channel-tab.channel-state--unknown:hover {
  border-color: var(--color-warning);
}

/*
 * 选中但未启用/未知：去掉橙色强调边框（强调色在过去等于“这一路能看”），
 * 但各自保留自己的状态色调，选中的未知通道仍然是警告色。
 */
.channel-tab--active.channel-state--disabled {
  border-color: var(--color-border-strong);
  background: var(--color-bg-subtle);
}

.channel-tab--active.channel-state--unknown {
  border-color: var(--color-warning);
  background: var(--color-bg-subtle);
}

.channel-tab__live {
  position: absolute;
  top: 5px;
  right: 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-neutral);
}

.channel-tab__live--on {
  background: var(--color-success);
}

.channel-tab__label {
  font-size: 12.5px;
  font-weight: 600;
}

.channel-tab--active .channel-tab__label {
  color: var(--color-accent-hover);
}

.channel-tab__name {
  font-size: 11px;
  color: var(--color-text-secondary);
  max-width: 96px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* --- ② per-channel voiceprint cards ------------------------------------- */

.channel-features {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.channel-features__hint {
  font-size: 11.5px;
}

/*
 * 每通道一张卡。列数由**这一块自己的宽度**决定（与 §15.31 的图谱排同一套理由：
 * 媒体查询问的是窗口，不是这一排）。最小 200px：再窄下去四项数字会折行折到读不出来。
 */
.channel-features__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.channel-card {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  text-align: left;
  background: var(--color-bg-subtle);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.channel-card:hover:not(:disabled) {
  border-color: var(--color-border-strong);
}

.channel-card--active {
  border-color: var(--color-accent);
  box-shadow: inset 0 0 0 1px var(--color-accent);
}

.channel-card:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.channel-card__head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.channel-card__label {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.channel-card__name {
  font-size: 11.5px;
  color: var(--color-text-secondary);
  max-width: 120px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.channel-card__values {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  font-size: 12px;
}

.channel-card__row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
}

.channel-card__row dt {
  color: var(--color-text-secondary);
}

.channel-card__row dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.channel-card__empty {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.channel-card__foot {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: auto;
}

.channel-card__time {
  font-size: 11px;
}

/* --- audio panel -------------------------------------------------------- */

.audio-bar {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.audio-bar__hint {
  font-size: 11.5px;
}

.audio-bar__volume {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.audio-bar__slider {
  width: 140px;
}

.audio-bar__volume-value {
  font-variant-numeric: tabular-nums;
  min-width: 36px;
}

.chart-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/*
 * ③b 四张图谱卡片（频谱 / 时频图 / 声学波形 / 每通道声纹特性）的排布。
 *
 * 列数由**这一块自己的宽度**决定（`auto-fit` + 最小 420px）：最小 420px 是为了让两张卡
 * 并排时每张仍然放得下 ECharts 的坐标轴标签，而 420 这个数又是 1366×768 那种常见窗口
 * （内容宽 ≈1318px）能放下**两列**的下限 —— 四张卡挤在 3 列里会让每张只剩下 400px 出头。
 *
 * 这里曾经叫 `.chart-columns`（只有两块：频谱 + 时谱）。③b 之后它变成四块，
 * 名字跟着改成 `graph-grid`，**旧规则一并删掉**：留着一条没人用的 CSS 只会让下一个
 * 人以为那块还在（§15.29.4 记过同一条教训）。
 */
.graph-grid {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  /* 各自按内容高：四块的高度差很大（时频图是固定高度的 JPEG，通道卡片有八张）。 */
  align-items: start;
}

/* ③b 置顶的趋势卡片：整幅宽，图标区比另外四张高一点（它是这一页的主图）。 */
.trend-panel {
  grid-column: 1 / -1;
}

.chart-hint {
  font-size: 11.5px;
}

.chip--selectable {
  cursor: pointer;
  font-family: inherit;
}

.chip--selectable:hover {
  border-color: var(--color-border-strong);
}

/* --- camera live video -------------------------------------------------- */

.camera-live {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/*
 * 单路画面的**16:9 窗口**（业主 2026-09-17 的 ⑤）。
 *
 * 为什么不是"撑满卡片高度"：画面比例由设备决定，而窗口比例是我们能定的。把窗口固定成
 * 16:9（并让 `<video>` 用 `object-fit: contain` 在窗口内留黑边）之后，操作员看到的
 * 画面框不会随着窗口高度忽胖忽瘦 —— 那正是"视频窗口"与"一块会变形的黑布"的区别。
 *
 * `max-width: calc(72vh * 16 / 9)` 是**保持比例**的高度限制：窗口很高时如果只压高度，
 * 16:9 就被破坏了（画面会被挤扁或被黑边包住），所以改成限制宽度并把窗口居中。
 * 视频本身仍然 `width: 100%`，黑边来自 `object-fit`，不是来自拉伸。
 */
.camera-live__stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 9;
  max-width: calc(72vh * 16 / 9);
  margin-inline: auto;
  background: #000;
  border-radius: var(--radius-md);
  overflow: hidden;
}

.camera-live__video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
  /*
   * 翻转/旋转（第 21 条）走 `transform`，所以这几条不能少：
   *   · `transform-origin: center` 是默认值，写出来是为了说明转的是画面中心；
   *   · 过渡 120ms：翻转是"一眼看懂发生了什么"的动作，瞬变会让人以为画面闪了一下；
   *   · `will-change` 不加 —— 一个常驻的合成层为一台离线相机白占显存。
   */
  transform-origin: center center;
  transition: transform 0.12s ease;
}

/* 暂停（画面冻结）时给一个明确的视觉信号：静止的画面与"卡住的流"必须看得出来。 */
.camera-live__video--paused {
  filter: saturate(0.65) brightness(0.92);
}

/*
 * 控制条（第 22 条）：**画面下方**，与任何播放器的位置一致。
 *
 * 一行放不下时换行（`flex-wrap`）：这一条里从 6 个动作到 12 个控件都有，
 * 挤在一行会把音量滑杆压到几像素宽。
 */
.camera-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
}

.camera-controls__volume {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  font-size: 12px;
}

.camera-controls__slider {
  width: 140px;
}

.camera-controls__slider:disabled {
  opacity: 0.5;
}

.camera-controls__percent {
  min-width: 38px;
  font-variant-numeric: tabular-nums;
}

.camera-controls__flip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* 全屏时铺满：窗口比例这时由屏幕决定（`<video>` 仍然 contain，不拉伸）。 */
.camera-live__stage--fullscreen {
  width: 100vw;
  height: 100vh;
  max-width: none;
  aspect-ratio: auto;
  margin-inline: 0;
  border-radius: 0;
}

.camera-live__stage--fullscreen .camera-live__video {
  max-height: 100vh;
  height: 100vh;
  object-fit: contain;
}

/* 叠加信息：设备名 / 状态 / 码流，浮动在画面上，可整体隐藏。 */
.camera-live__overlay {
  position: absolute;
  top: 8px;
  left: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  font-size: 11px;
  line-height: 1.5;
  color: #f9fafb;
  background: rgba(17, 24, 39, 0.55);
  border-radius: 6px;
  pointer-events: none;
  max-width: calc(100% - 16px);
}

.camera-live__overlay-line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 录制指示器：必须一眼可辨（红色圆点 + 走动的时长），不能只是换个按钮文字。 */
.camera-live__rec {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: #fef2f2;
  background: rgba(153, 27, 27, 0.85);
  border-radius: 999px;
  pointer-events: none;
}

.camera-live__rec-dot {
  width: 8px;
  height: 8px;
  background: #ef4444;
  border-radius: 50%;
  animation: camera-rec-pulse 1.2s ease-in-out infinite;
}

@keyframes camera-rec-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.camera-live__hint {
  font-size: 12px;
}

.camera-live__placeholder {
  color: #d1d5db;
  font-size: 13px;
  padding: var(--space-4);
  text-align: center;
}
</style>
