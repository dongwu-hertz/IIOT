<script setup lang="ts">
/**
 * 画面格里的一张图：1 秒时域图 / 频域图 / 时频谱图（业主 2026-09-18 第 10 批第 2 条）。
 *
 * ---------------------------------------------------------------------------
 * 为什么用 canvas 手画，而不是每格挂一个 ECharts
 * ---------------------------------------------------------------------------
 * 一面墙最多 16 格，而 ECharts 的实例是**每格一份 DOM + 一份布局计算**；值班机上再叠 16 路
 * 解码中的 `<video>`，图表反而会先拖慢画面。这三张图本身都很简单（一串竖线 / 一排柱子 /
 * 一张小位图），canvas 逐帧画几十行代码就够，且只在收到新帧时画（`requestAnimationFrame`
 * 合并同一帧里的多次推送）。
 *
 * ---------------------------------------------------------------------------
 * 三条口径（`@shared/domain/camera-cell-view.ts` 的文件头写了完整理由）
 * ---------------------------------------------------------------------------
 *   1. **频率轴不编 Hz**：主进程给不出采样率时只标"第 N 根谱线"（右下角那个轴上写着）；
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
  CAMERA_CELL_VIEW_STREAM
} from '@shared/domain/camera-cell-view'
import { useCameraCellChartsStore } from '@renderer/stores/cameraCellCharts'
import {
  concatWaveform,
  spectrogramColor,
  spectrogramMatrix,
  spectrumAxisLabels,
  spectrumBars,
  normalise,
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

const entry = computed(() => charts.devices[props.deviceId])
const hasData = computed(() => {
  const current = entry.value
  if (!current) return false
  return props.mode === 'timedomain' ? current.pcm.length > 0 : current.fft.length > 0
})

/** 频域图右下角那个轴：有 binHz 才写 Hz，没有就写"第 N 根谱线"。 */
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
    if (frame) drawSpectrum(context, frame.bins)
    return
  }
  drawSpectrogram(context, current.fft.map((frame) => frame.bins))
}

/** 1 秒时域图：拼够 1 秒的包络，按像素列取极值画竖线。 */
function drawWaveform(context: CanvasRenderingContext2D, frames: readonly { waveform: number[] }[]): void {
  const samples = concatWaveform(waveformFrames(frames).map((frame) => frame.waveform))
  if (samples.length === 0) return
  const columns = waveformColumns(samples, CANVAS_WIDTH)
  let peak = 0
  for (const column of columns) peak = Math.max(peak, Math.abs(column.min), Math.abs(column.max))
  const scale = peak > 0 ? (CANVAS_HEIGHT / 2 - 4) / peak : 0
  const middle = CANVAS_HEIGHT / 2

  context.strokeStyle = 'rgba(255, 255, 255, 0.18)'
  context.beginPath()
  context.moveTo(0, middle)
  context.lineTo(CANVAS_WIDTH, middle)
  context.stroke()

  context.strokeStyle = '#5fd0c5'
  context.beginPath()
  columns.forEach((column, index) => {
    context.moveTo(index + 0.5, middle - column.max * scale)
    context.lineTo(index + 0.5, middle - column.min * scale)
  })
  context.stroke()
}

/** 频域图：一帧谱线抽稀成柱子，按帧内最大值归一化。 */
function drawSpectrum(context: CanvasRenderingContext2D, bins: readonly number[]): void {
  const bars = normalise(spectrumBars(bins, CAMERA_CELL_SPECTRUM_BARS))
  if (bars.length === 0) return
  const width = CANVAS_WIDTH / bars.length
  bars.forEach((value, index) => {
    const height = Math.max(1, value * (CANVAS_HEIGHT - 12))
    context.fillStyle = `rgb(${Math.round(40 + value * 150)}, ${Math.round(200 - value * 60)}, ${Math.round(
      190 - value * 40
    )})`
    context.fillRect(index * width + 0.5, CANVAS_HEIGHT - 6 - height, Math.max(1, width - 1), height)
  })
  context.strokeStyle = 'rgba(255, 255, 255, 0.18)'
  context.beginPath()
  context.moveTo(0, CANVAS_HEIGHT - 6)
  context.lineTo(CANVAS_WIDTH, CANVAS_HEIGHT - 6)
  context.stroke()
}

/** 时频谱图：30 列 × 24 行的小位图，低频在下、最新的帧在最右。 */
function drawSpectrogram(context: CanvasRenderingContext2D, frames: readonly (readonly number[])[]): void {
  const matrix = spectrogramMatrix(frames, CAMERA_CELL_SPECTROGRAM_COLUMNS, CAMERA_CELL_SPECTRUM_ROWS)
  const columnWidth = CANVAS_WIDTH / matrix.length
  const rowHeight = CANVAS_HEIGHT / CAMERA_CELL_SPECTRUM_ROWS
  matrix.forEach((columnValues, column) => {
    if (!columnValues) return
    columnValues.forEach((value, row) => {
      const [r, g, b] = spectrogramColor(value)
      context.fillStyle = `rgb(${r}, ${g}, ${b})`
      // 第 0 行是低频 ⇒ 画在最下面。
      const y = CANVAS_HEIGHT - (row + 1) * rowHeight
      context.fillRect(column * columnWidth, y, Math.ceil(columnWidth), Math.ceil(rowHeight))
    })
  })
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
      频域图的轴：没有采样率时标"第 N 根谱线"（**不编 Hz**），有就直接标 Hz。
    -->
    <span v-if="mode !== 'timedomain'" class="cell-chart__axis" data-cell-chart-axis>
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

.cell-chart__note {
  left: 6px;
}

.cell-chart__error {
  top: 4px;
  left: 6px;
  color: var(--color-danger, #d64545);
}
</style>
