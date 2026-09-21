<script setup lang="ts">
/**
 * 画面格里的一张图：1 秒时域图 / 频域图 / 时频谱图（业主 2026-09-18 第 10 批第 2 条；
 * 2026-09-21 第 5 批按分析工作台的设计稿升级画法：深色底上的精致科学图 —— 折线 + 微弱
 * 渐变填充、小号灰字刻度、频率轴上限 100kHz、红外热力色板）。
 *
 * ---------------------------------------------------------------------------
 * 为什么用 canvas 手画，而不是每格挂一个 ECharts
 * ---------------------------------------------------------------------------
 * 一面墙最多 16 格，而 ECharts 的实例是**每格一份 DOM + 一份布局计算**；值班机上再叠 16 路
 * 解码中的 `<video>`，图表反而会先拖慢画面。这三张图本身都很简单（一条包络带 / 一条折线 /
 * 一张小位图 + 几根刻度线），canvas 逐帧画几十行代码就够，且只在收到新帧时画
 * （`requestAnimationFrame` 合并同一帧里的多次推送）。
 *
 * ---------------------------------------------------------------------------
 * 三条口径（`@shared/domain/camera-cell-view.ts` 的文件头写了完整理由）
 * ---------------------------------------------------------------------------
 *   1. **频率轴不编 Hz**：主进程给不出采样率时（`binHz` 缺失）只标"第 N 根谱线"
 *      （频域图右下角写着；时频谱图退回**行号**刻度），有 `binHz` 才标 kHz，
 *      且上限 = `min(binHz × binCount, 100kHz)`（`SPECTRUM_MAX_HZ`，业主 2026-09-21 第 5 条）；
 *   2. **颜色不代表绝对声压级**：只表示同一帧内谱线的相对强弱，界面上有一句说明；
 *   3. **时域图拼够 1 秒**（实测一帧 100 ms ⇒ 10 帧），不够就画多少算多少。
 *
 * 数据来自 `stores/cameraCellCharts`（每台设备一份订阅，多条图表格共享）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CameraCellViewMode } from '@shared/domain/camera-cell-view'
import {
  CAMERA_CELL_SPECTRUM_BARS,
  CAMERA_CELL_SPECTROGRAM_COLUMNS,
  CAMERA_CELL_SPECTRUM_ROWS,
  CAMERA_CELL_VIEW_STREAM,
  CAMERA_CELL_WAVEFORM_SECONDS
} from '@shared/domain/camera-cell-view'
import type { Fa371FftPreview } from '@shared/domain/fa371-stream'
import { useCameraCellChartsStore } from '@renderer/stores/cameraCellCharts'
import {
  concatWaveform,
  frequencyAxisTicks,
  normalise,
  spectrogramColor,
  spectrogramMatrix,
  spectrogramRowTicks,
  spectrumAxisLabels,
  spectrumBars,
  spectrumMaxHz,
  waveformColumns,
  waveformFrames
} from '@renderer/lib/cameraCellChart'

const props = defineProps<{
  deviceId: string
  mode: CameraCellViewMode
}>()

const { t } = useI18n()
const charts = useCameraCellChartsStore()

const canvas = ref<HTMLCanvasElement | null>(null)
/** 画布内部像素尺寸：固定值 + CSS 拉伸。一格在 1440×900 下约 280×158，320×180 够用且省算力。 */
const CANVAS_WIDTH = 320
const CANVAS_HEIGHT = 180

/*
 * 设计稿（分析工作台）的深色科学图配色：小格子里一切从简，但轴线、刻度字、线色与
 * 填充透明度都按那一套来 —— 轴线 rgba(148,163,184,0.35)，刻度字 #94a3b8 10px，
 * 网格线 rgba(148,163,184,0.12)。
 */
const AXIS_COLOR = 'rgba(148, 163, 184, 0.35)'
const GRID_COLOR = 'rgba(148, 163, 184, 0.12)'
const LABEL_COLOR = '#94a3b8'
const LABEL_FONT = '10px sans-serif'
/** 时域图：亮蓝折线 + 微弱渐变填充（设计稿 areaStyle opacity ~0.08 的等效）。 */
const WAVEFORM_LINE = '#60a5fa'
/** 频域图：天蓝折线 + 更淡的填充（设计稿 frequencyDomain 系列）。 */
const SPECTRUM_LINE = '#38bdf8'

const entry = computed(() => charts.devices[props.deviceId])
const hasData = computed(() => {
  const current = entry.value
  if (!current) return false
  return props.mode === 'timedomain' ? current.pcm.length > 0 : current.fft.length > 0
})

/**
 * 频域图右下角那个轴：没有 `binHz` 时才画在图上（"0 – 第 N 根谱线"，**不编 Hz**）；
 * 有 `binHz` 时刻度直接画在 canvas 上（0 / 中点 / 上限 kHz）。
 */
const axis = computed(() => {
  const frame = entry.value?.fft[entry.value.fft.length - 1]
  return spectrumAxisLabels(frame?.binCount ?? 0, frame?.binHz, CAMERA_CELL_SPECTRUM_BARS)
})

let frameHandle: number | null = null

/** 安排一次重画（同一帧里的多次推送合并成一次）。 */
function scheduleDraw(): void {
  if (frameHandle !== null) return
  frameHandle = window.requestAnimationFrame(() => {
    frameHandle = null
    draw()
  })
}

/** 图表区（canvas 内）：四周留出刻度字的边距。 */
interface PlotRect {
  left: number
  top: number
  width: number
  height: number
}

function draw(): void {
  const element = canvas.value
  const context = element?.getContext('2d')
  if (!element || !context) return
  if (element.width !== CANVAS_WIDTH) element.width = CANVAS_WIDTH
  if (element.height !== CANVAS_HEIGHT) element.height = CANVAS_HEIGHT

  context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
  const current = entry.value
  if (!current) return

  if (props.mode === 'timedomain') {
    drawWaveform(context, current.pcm)
    return
  }
  if (props.mode === 'spectrum') {
    const frame = current.fft[current.fft.length - 1]
    if (frame) drawSpectrum(context, frame)
    return
  }
  drawSpectrogram(context, current.fft)
}

/** 一根带刻度小竖线的轴标文字。 */
function drawTickLabel(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  align: CanvasTextAlign
): void {
  context.fillStyle = LABEL_COLOR
  context.font = LABEL_FONT
  context.textAlign = align
  context.textBaseline = 'middle'
  context.fillText(text, x, y)
}

/**
 * 1 秒时域图：拼够 1 秒的包络，按像素列取极值，画**上下两条极值折线 + 之间的渐变
 * 填充带**（设计稿的 waveform：亮蓝 1.4px + areaStyle ~0.08 的等效，示波器画法不变 ——
 * 极值带仍是"这一列真实到达过的范围"，不丢尖峰）。
 *
 * Y 轴不标绝对值（幅值无单位）：只画 0 中线；X 轴是时间秒（窗长恒为
 * `CAMERA_CELL_WAVEFORM_SECONDS` 秒），标 0 与末端两个刻度。
 */
function drawWaveform(context: CanvasRenderingContext2D, frames: readonly { waveform: number[] }[]): void {
  const samples = concatWaveform(waveformFrames(frames).map((frame) => frame.waveform))
  if (samples.length === 0) return
  const plot: PlotRect = { left: 8, top: 6, width: CANVAS_WIDTH - 16, height: CANVAS_HEIGHT - 24 }
  const columns = waveformColumns(samples, plot.width)
  let peak = 0
  for (const column of columns) peak = Math.max(peak, Math.abs(column.min), Math.abs(column.max))
  const scale = peak > 0 ? (plot.height / 2 - 2) / peak : 0
  const middle = plot.top + plot.height / 2
  const xAt = (index: number): number => plot.left + index + 0.5
  const yAt = (value: number): number => middle - value * scale

  // 0 中线（Y 轴的唯一刻度：幅值无单位，不标数）。
  context.strokeStyle = AXIS_COLOR
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(plot.left, middle)
  context.lineTo(plot.left + plot.width, middle)
  context.stroke()

  // 渐变填充带：上沿 = 各列 max，下沿 = 各列 min（按设计稿的 opacity ~0.08 取上下限）。
  const fill = context.createLinearGradient(0, plot.top, 0, plot.top + plot.height)
  fill.addColorStop(0, 'rgba(96, 165, 250, 0.10)')
  fill.addColorStop(0.5, 'rgba(96, 165, 250, 0.02)')
  fill.addColorStop(1, 'rgba(96, 165, 250, 0.10)')
  context.fillStyle = fill
  context.beginPath()
  columns.forEach((column, index) => {
    const x = xAt(index)
    const y = yAt(column.max)
    if (index === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  })
  for (let index = columns.length - 1; index >= 0; index -= 1) {
    context.lineTo(xAt(index), yAt(columns[index]!.min))
  }
  context.closePath()
  context.fill()

  // 上下两条极值折线（设计稿 lineWidth 1.4px 亮蓝）。
  context.strokeStyle = WAVEFORM_LINE
  context.lineWidth = 1.4
  for (const pick of ['max', 'min'] as const) {
    context.beginPath()
    columns.forEach((column, index) => {
      const x = xAt(index)
      const y = yAt(column[pick])
      if (index === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    })
    context.stroke()
  }

  // X 轴 = 时间秒：0 与末端两个刻度（窗长固定 1 秒）。
  drawTickLabel(context, '0', plot.left, plot.top + plot.height + 7, 'left')
  drawTickLabel(
    context,
    `${CAMERA_CELL_WAVEFORM_SECONDS.toFixed(1)} s`,
    plot.left + plot.width,
    plot.top + plot.height + 7,
    'right'
  )
}

/**
 * 频域图：一帧谱线抽稀成折线（每段取峰值），按帧内最大值归一化，画**折线 + 更淡的
 * 填充**（设计稿的 frequencyDomain：1.6px 天蓝 + areaStyle opacity 0.05）。
 *
 * Y 轴 0..100%（归一化到帧内最大）；X 轴 = 频率：有 `binHz` 时上限
 * `min(binHz × binCount, SPECTRUM_MAX_HZ)`、标 0/中点/上限三个刻度（kHz），没有就
 * 一个数也不标（"0 – 第 N 根谱线"写在右下角的轴标里，**不编 Hz**）。
 */
function drawSpectrum(context: CanvasRenderingContext2D, frame: Fa371FftPreview): void {
  const bars = normalise(spectrumBars(frame.bins, CAMERA_CELL_SPECTRUM_BARS))
  if (bars.length === 0) return
  const plot: PlotRect = { left: 36, top: 6, width: CANVAS_WIDTH - 42, height: CANVAS_HEIGHT - 24 }
  const baseline = plot.top + plot.height
  const yAt = (value: number): number => baseline - value * plot.height
  const xAt = (index: number): number =>
    bars.length > 1 ? plot.left + (index * plot.width) / (bars.length - 1) : plot.left + plot.width / 2

  // Y 轴 0/50/100% 刻度 + 水平网格线。
  context.lineWidth = 1
  for (const ratio of [0, 0.5, 1]) {
    const y = yAt(ratio)
    context.strokeStyle = ratio === 0 ? AXIS_COLOR : GRID_COLOR
    context.beginPath()
    context.moveTo(plot.left, y)
    context.lineTo(plot.left + plot.width, y)
    context.stroke()
    drawTickLabel(context, `${Math.round(ratio * 100)}%`, plot.left - 4, y, 'right')
  }

  // 折线 + 填充（填充到 0 线；opacity 比时域图更淡）。
  context.beginPath()
  bars.forEach((value, index) => {
    const x = xAt(index)
    const y = yAt(value)
    if (index === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  })
  context.strokeStyle = SPECTRUM_LINE
  context.lineWidth = 1.6
  context.stroke()
  context.lineTo(xAt(bars.length - 1), baseline)
  context.lineTo(xAt(0), baseline)
  context.closePath()
  context.fillStyle = 'rgba(56, 189, 248, 0.05)'
  context.fill()

  // X 轴 = 频率（有 binHz 才标；上限 100kHz，见 SPECTRUM_MAX_HZ）。
  const ticks = frequencyAxisTicks(spectrumMaxHz(frame.binCount, frame.binHz))
  if (ticks) {
    context.strokeStyle = AXIS_COLOR
    context.lineWidth = 1
    context.beginPath()
    context.moveTo(plot.left, baseline)
    context.lineTo(plot.left + plot.width, baseline)
    context.stroke()
    for (const tick of ticks) {
      const x = plot.left + tick.frac * plot.width
      context.beginPath()
      context.moveTo(x, baseline)
      context.lineTo(x, baseline + 3)
      context.stroke()
      drawTickLabel(context, tick.label, x, plot.top + plot.height + 7, 'center')
    }
  }
}

/**
 * 时频谱图：30 列 × 24 行的小位图，低频在下、最新的帧在最右；红外热力色板
 * （`spectrogramColor`，蓝→青→绿→黄→橙→红 11 档，不代表绝对声压级）。
 *
 * Y 轴 = 频率：有 `binHz` 时上限 `min(binHz × binCount, SPECTRUM_MAX_HZ)`、行按频率
 * 线性映射（只保留 ≤100kHz 的 bin 参与抽稀，见 `spectrogramMatrix`），没有 `binHz` 时
 * 退回**行号**刻度（诚实降级，不编 Hz）。X 轴不标时间：列与列之间的间隔取决于设备的
 * 推送节奏（手册不保证），标了秒数就是在编。
 */
function drawSpectrogram(context: CanvasRenderingContext2D, frames: readonly Fa371FftPreview[]): void {
  if (frames.length === 0) return
  const latest = frames[frames.length - 1]!
  const rows = CAMERA_CELL_SPECTRUM_ROWS
  const plot: PlotRect = { left: 44, top: 4, width: CANVAS_WIDTH - 48, height: CANVAS_HEIGHT - 8 }
  const matrix = spectrogramMatrix(
    frames.map((frame) => frame.bins),
    CAMERA_CELL_SPECTROGRAM_COLUMNS,
    rows,
    latest.binHz
  )
  const columnWidth = plot.width / matrix.length
  const rowHeight = plot.height / rows
  matrix.forEach((columnValues, column) => {
    if (!columnValues) return
    columnValues.forEach((value, row) => {
      const [r, g, b] = spectrogramColor(value)
      context.fillStyle = `rgb(${r}, ${g}, ${b})`
      // 第 0 行是低频 ⇒ 画在最下面。
      const y = plot.top + plot.height - (row + 1) * rowHeight
      context.fillRect(plot.left + column * columnWidth, y, Math.ceil(columnWidth), Math.ceil(rowHeight))
    })
  })

  // Y 轴 = 频率（或行号降级）刻度：0 在下、上限在上。
  const ticks =
    frequencyAxisTicks(spectrumMaxHz(latest.binCount, latest.binHz)) ?? spectrogramRowTicks(rows)
  const axisX = plot.left - 4
  context.strokeStyle = AXIS_COLOR
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(axisX, plot.top)
  context.lineTo(axisX, plot.top + plot.height)
  context.stroke()
  for (const tick of ticks) {
    const y = plot.top + plot.height - tick.frac * plot.height
    context.beginPath()
    context.moveTo(axisX - 3, y)
    context.lineTo(axisX, y)
    context.stroke()
    drawTickLabel(context, tick.label, axisX - 5, y, 'right')
  }
}

/** 数据一变就重画（同一帧里合并）。 */
watch(
  () => [props.deviceId, props.mode, entry.value?.lastAt, entry.value?.pcm.length, entry.value?.fft.length],
  () => scheduleDraw()
)

onMounted(() => {
  const kind = CAMERA_CELL_VIEW_STREAM[props.mode]
  if (kind) void charts.require(props.deviceId, kind)
  scheduleDraw()
})

/**
 * 视图换了：订阅跟着换。
 *
 * 「不再需要的那一路要放开」不是可选项：`pcmData` 与 `fftData` 各占相机一条 WebSocket，
 * 而相机的并发连接数只有个位数（实测约 6）。切回播放之后还占着两条，等于替操作员
 * 悄悄吃掉相机一半的连接预算。
 */
watch(
  () => props.mode,
  (next, previous) => {
    const nextKind = CAMERA_CELL_VIEW_STREAM[next]
    const previousKind = previous ? CAMERA_CELL_VIEW_STREAM[previous] : null
    if (nextKind) void charts.require(props.deviceId, nextKind)
    if (previousKind && previousKind !== nextKind) charts.release(props.deviceId, previousKind)
  }
)

onBeforeUnmount(() => {
  if (frameHandle !== null) window.cancelAnimationFrame(frameHandle)
  frameHandle = null
  const kind = CAMERA_CELL_VIEW_STREAM[props.mode]
  if (kind) charts.release(props.deviceId, kind)
})
</script>

<template>
  <div class="cell-chart" :data-cell-chart="mode">
    <canvas
      ref="canvas"
      class="cell-chart__canvas"
      :width="CANVAS_WIDTH"
      :height="CANVAS_HEIGHT"
      :aria-label="t(`cameraWallUi.view${mode === 'timedomain' ? 'Timedomain' : mode === 'spectrum' ? 'Spectrum' : 'Spectrogram'}`)"
      role="img"
    ></canvas>
    <!--
      没有数据时**必须说话**：一张空画布与"设备还没推上来"看起来一模一样
      （现场那台相机离线时就是这个状态）。
    -->
    <p v-if="!hasData" class="cell-chart__empty" data-cell-chart-empty>
      {{ t('cameraWallUi.viewWaiting') }}
    </p>
    <!--
      频域图的轴：没有采样率时标"0 – 第 N 根谱线"（**不编 Hz**）；有采样率时刻度
      画在 canvas 上（0 / 中点 / 上限 kHz，上限最大 100kHz），不再需要这一行。
    -->
    <span
      v-if="mode === 'spectrum' && axis.unit === 'bin'"
      class="cell-chart__axis"
      data-cell-chart-axis
    >
      {{ axis.left }} – {{ axis.right }}
    </span>
    <!-- 色标的说明（手册未说明色标，所以必须写清它不是声压级）。 -->
    <span v-if="mode === 'spectrogram'" class="cell-chart__note" data-cell-chart-note>
      {{ t('cameraWallUi.viewSpectrogramNote') }}
    </span>
    <span v-if="entry?.error" class="cell-chart__error" role="alert" data-cell-chart-error>
      {{ t('cameraWallUi.viewStreamError') }}
    </span>
  </div>
</template>

<style scoped>
/*
 * 图表格：与 `<video>` 占同一块地方（16:9 一带），黑底 + 细边，与画面格同一套观感。
 */
.cell-chart {
  position: relative;
  width: 100%;
  height: 100%;
  background: #0b0f16;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.cell-chart__canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.cell-chart__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  font-size: 12px;
  color: var(--color-text-muted);
}

.cell-chart__axis,
.cell-chart__note,
.cell-chart__error {
  position: absolute;
  bottom: 4px;
  font-size: 10.5px;
  color: var(--color-text-muted);
}

.cell-chart__axis {
  right: 6px;
}

/* 左下角让位给 canvas 上的 Y 轴刻度（0 / 50k / 100k 或行号）。 */
.cell-chart__note {
  right: 6px;
  top: 4px;
  bottom: auto;
}

.cell-chart__error {
  top: 4px;
  left: 6px;
  color: var(--color-danger, #d64545);
}
</style>
