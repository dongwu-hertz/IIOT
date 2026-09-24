<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { EChartsCoreOption } from 'echarts/core'
import type { CameraCellViewMode } from '@shared/domain/camera-cell-view'
import { CAMERA_CELL_VIEW_KEYS, CAMERA_CELL_VIEW_STREAM } from '@shared/domain/camera-cell-view'
import type { Fa371PcmPreview } from '@shared/domain/fa371-stream'
import { useCameraCellChartsStore } from '@renderer/stores/cameraCellCharts'
import EChart from '@renderer/components/EChart.vue'

const props = defineProps<{
  deviceId: string
  mode: CameraCellViewMode
}>()

const { t } = useI18n()
const charts = useCameraCellChartsStore()
const entry = computed(() => charts.devices[props.deviceId])

const SAMPLE_RATE_FALLBACK = 200_000
const FFT_LEN = 4096
const MAX_KHZ = 100
const TIME_WINDOW_SECONDS = 1
const MAX_TIME_POINTS = 2048
const SPECTROGRAM_ROWS = 128
const SPECTROGRAM_COLUMNS = 10
const SPECTROGRAM_PRELOAD_COLUMNS = 8

const frequencySeries = ref<Array<[number, number]>>([])
const spectrogramColumns = ref<number[][]>([])
const spectrogramReady = ref(false)
const revision = ref(0)
let lastProcessedTimestamp = 0

function normaliseRawSamples(value: unknown): Float32Array | null {
  if (!value) return null
  if (value instanceof Float32Array) return value
  if (value instanceof Float64Array) return Float32Array.from(value)
  if (value instanceof Int16Array || value instanceof Int32Array || value instanceof Uint16Array || value instanceof Uint32Array) {
    return Float32Array.from(value as ArrayLike<number>)
  }
  if (Array.isArray(value)) return Float32Array.from(value.map((item) => Number(item) || 0))
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    if (view.byteLength % 4 !== 0) return null
    return new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength % 4 !== 0) return null
    return new Float32Array(value.slice(0))
  }
  return null
}

function frameSamples(frame: Fa371PcmPreview): Float32Array | null {
  const raw = normaliseRawSamples(frame.rawSamples)
  if (raw && raw.length > 0) return raw
  const waveform = normaliseRawSamples(frame.waveform)
  return waveform && waveform.length > 0 ? waveform : null
}

function currentSampleRate(): number {
  const frames = entry.value?.pcm ?? []
  const latest = frames[frames.length - 1]
  const rate = Number(latest?.sampleRate)
  return Number.isFinite(rate) && rate > 0 ? rate : SAMPLE_RATE_FALLBACK
}

function collectLatestSamples(count: number): Float32Array {
  const frames = entry.value?.pcm ?? []
  if (frames.length === 0 || count <= 0) return new Float32Array(0)

  const chunks: Float32Array[] = []
  let collected = 0
  for (let index = frames.length - 1; index >= 0 && collected < count; index -= 1) {
    const samples = frameSamples(frames[index]!)
    if (!samples) continue
    chunks.unshift(samples)
    collected += samples.length
  }
  if (chunks.length === 0) return new Float32Array(0)

  const outCount = Math.min(count, collected)
  const out = new Float32Array(outCount)
  let write = outCount
  for (let index = chunks.length - 1; index >= 0 && write > 0; index -= 1) {
    const chunk = chunks[index]!
    const take = Math.min(write, chunk.length)
    write -= take
    out.set(chunk.subarray(chunk.length - take), write)
  }
  return out
}

function bitReverse(index: number, bits: number): number {
  let reversed = 0
  for (let i = 0; i < bits; i += 1) {
    reversed = (reversed << 1) | (index & 1)
    index >>>= 1
  }
  return reversed
}

function fftMagnitude(input: Float32Array): Float64Array {
  const n = input.length
  const bits = Math.log2(n)
  const real = new Float64Array(n)
  const imag = new Float64Array(n)

  for (let i = 0; i < n; i += 1) {
    const window = n > 1 ? 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))) : 1
    real[bitReverse(i, bits)] = (input[i] ?? 0) * window
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >>> 1
    const phaseStep = (-2 * Math.PI) / size
    for (let start = 0; start < n; start += size) {
      for (let offset = 0; offset < half; offset += 1) {
        const angle = phaseStep * offset
        const wr = Math.cos(angle)
        const wi = Math.sin(angle)
        const even = start + offset
        const odd = even + half
        const tr = wr * (real[odd] ?? 0) - wi * (imag[odd] ?? 0)
        const ti = wr * (imag[odd] ?? 0) + wi * (real[odd] ?? 0)
        const er = real[even] ?? 0
        const ei = imag[even] ?? 0
        real[even] = er + tr
        imag[even] = ei + ti
        real[odd] = er - tr
        imag[odd] = ei - ti
      }
    }
  }

  const bins = new Float64Array(n >>> 1)
  for (let i = 0; i < bins.length; i += 1) bins[i] = Math.hypot(real[i] ?? 0, imag[i] ?? 0)
  return bins
}

function processLatestPcm(): void {
  if (props.mode === 'timedomain' || props.mode === 'play') return
  const frames = entry.value?.pcm ?? []
  const latest = frames[frames.length - 1]
  if (!latest || latest.timestamp === lastProcessedTimestamp) return
  lastProcessedTimestamp = latest.timestamp

  const input = collectLatestSamples(FFT_LEN)
  if (input.length < FFT_LEN) return

  const rate = currentSampleRate()
  const magnitudes = fftMagnitude(input)
  const nyquistKHz = rate / 2000
  const effectiveMaxKHz = Math.min(MAX_KHZ, nyquistKHz)
  const maxBin = Math.min(
    magnitudes.length - 1,
    Math.floor((effectiveMaxKHz * 1000 * FFT_LEN) / rate)
  )

  let peak = 1e-12
  for (let index = 0; index <= maxBin; index += 1) peak = Math.max(peak, magnitudes[index] ?? 0)

  const spectrum: Array<[number, number]> = []
  const stride = Math.max(1, Math.ceil((maxBin + 1) / 1024))
  for (let index = 0; index <= maxBin; index += stride) {
    spectrum.push([
      Number(((index * rate) / FFT_LEN / 1000).toFixed(4)),
      Math.max(0, Math.min(1, (magnitudes[index] ?? 0) / peak))
    ])
  }
  frequencySeries.value = spectrum

  if (props.mode === 'spectrogram') {
    const column = new Array<number>(SPECTROGRAM_ROWS)
    for (let row = 0; row < SPECTROGRAM_ROWS; row += 1) {
      const targetHz = (row / Math.max(1, SPECTROGRAM_ROWS - 1)) * effectiveMaxKHz * 1000
      const bin = Math.min(maxBin, Math.max(0, Math.round((targetHz * FFT_LEN) / rate)))
      const db = 20 * Math.log10(Math.max(1e-12, (magnitudes[bin] ?? 0) / peak))
      column[row] = Math.max(0, Math.min(100, ((db + 80) / 80) * 100))
    }
    const next = [...spectrogramColumns.value, column]
    if (next.length > SPECTROGRAM_COLUMNS) next.splice(0, next.length - SPECTROGRAM_COLUMNS)
    spectrogramColumns.value = next
    spectrogramReady.value = next.length >= SPECTROGRAM_PRELOAD_COLUMNS
  }

  revision.value += 1
}

const timeSeries = computed<Array<[number, number]>>(() => {
  const rate = currentSampleRate()
  const raw = collectLatestSamples(Math.max(1, Math.round(rate * TIME_WINDOW_SECONDS)))
  if (raw.length === 0) return []
  const stride = Math.max(1, Math.ceil(raw.length / MAX_TIME_POINTS))
  const result: Array<[number, number]> = []
  for (let index = 0; index < raw.length; index += stride) {
    result.push([
      Math.min(TIME_WINDOW_SECONDS, index / rate),
      raw[index] ?? 0
    ])
  }
  return result
})

const title = computed(() => t(CAMERA_CELL_VIEW_KEYS[props.mode]))

const timeOption = computed<EChartsCoreOption>(() => ({
  animation: false,
  grid: { left: 42, right: 14, top: 12, bottom: 28 },
  tooltip: { trigger: 'axis' },
  xAxis: {
    type: 'value',
    name: 's',
    min: 0,
    max: TIME_WINDOW_SECONDS,
    interval: 0.25,
    axisLabel: {
      color: '#64748b',
      fontSize: 9,
      formatter: (value: number) => {
        if (Math.abs(value) < 1e-9 || Math.abs(value - 1) < 1e-9) return value.toFixed(0)
        return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
      }
    },
    axisLine: { lineStyle: { color: 'rgba(100,116,139,.35)' } },
    splitLine: { lineStyle: { color: 'rgba(148,163,184,.10)' } }
  },
  yAxis: {
    type: 'value',
    scale: true,
    axisLabel: { color: '#64748b', fontSize: 9, formatter: (value: number) => Number(value).toPrecision(2) },
    axisLine: { show: true, lineStyle: { color: 'rgba(100,116,139,.35)' } },
    splitLine: { lineStyle: { color: 'rgba(148,163,184,.10)' } }
  },
  series: [{
    name: 'Time Domain',
    type: 'line',
    showSymbol: false,
    smooth: false,
    sampling: 'lttb',
    data: timeSeries.value,
    lineStyle: { width: 1.4, color: '#0369a1' },
    itemStyle: { color: '#0369a1' },
    areaStyle: { opacity: 0.045 }
  }]
}))

const frequencyOption = computed<EChartsCoreOption>(() => {
  void revision.value
  return {
    animation: false,
    grid: { left: 42, right: 14, top: 12, bottom: 28 },
    tooltip: {
      trigger: 'axis',
      formatter: (params: any) => {
        const first = Array.isArray(params) ? params[0] : params
        const value = first?.value ?? []
        return `${Number(value[0] ?? 0).toFixed(2)} kHz<br/>${(Number(value[1] ?? 0) * 100).toFixed(1)}%`
      }
    },
    xAxis: {
      type: 'value',
      name: 'kHz',
      min: 0,
      max: Math.min(MAX_KHZ, currentSampleRate() / 2000),
      axisLabel: { color: '#64748b', fontSize: 9 },
      axisLine: { lineStyle: { color: 'rgba(100,116,139,.35)' } },
      splitLine: { lineStyle: { color: 'rgba(148,163,184,.10)' } }
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 1,
      axisLabel: { color: '#64748b', fontSize: 9, formatter: (value: number) => `${Math.round(value * 100)}%` },
      axisLine: { show: true, lineStyle: { color: 'rgba(100,116,139,.35)' } },
      splitLine: { lineStyle: { color: 'rgba(148,163,184,.10)' } }
    },
    series: [{
      name: 'FFT',
      type: 'line',
      showSymbol: false,
      smooth: false,
      sampling: 'lttb',
      data: frequencySeries.value,
      lineStyle: { width: 1.5, color: '#0369a1' },
      itemStyle: { color: '#0369a1' },
      areaStyle: { opacity: 0.045 }
    }]
  }
})

const spectrogramOption = computed<EChartsCoreOption>(() => {
  void revision.value
  const columns = spectrogramColumns.value
  const rate = currentSampleRate()
  const maxKHz = Math.min(MAX_KHZ, rate / 2000)
  const xLabels = columns.map((_, index) => {
    if (columns.length <= 1) return '0.0'
    return ((index / (columns.length - 1)) * TIME_WINDOW_SECONDS).toFixed(1)
  })
  const yLabels = Array.from({ length: SPECTROGRAM_ROWS }, (_, row) =>
    ((row / Math.max(1, SPECTROGRAM_ROWS - 1)) * maxKHz).toFixed(1)
  )
  const data: number[][] = []
  columns.forEach((column, x) => column.forEach((value, y) => data.push([x, y, value])))

  return {
    animation: false,
    grid: { left: 46, right: 12, top: 10, bottom: 28 },
    tooltip: {
      trigger: 'item',
      formatter: (params: any) => {
        const value = params?.value ?? []
        return `Time: ${xLabels[Number(value[0])] ?? '--'} s<br/>Frequency: ${yLabels[Number(value[1])] ?? '--'} kHz`
      }
    },
    xAxis: {
      type: 'category',
      name: 's',
      data: xLabels,
      axisLabel: { color: '#64748b', fontSize: 9, hideOverlap: true },
      axisLine: { lineStyle: { color: 'rgba(100,116,139,.35)' } },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'category',
      name: 'kHz',
      data: yLabels,
      axisLabel: {
        color: '#64748b',
        fontSize: 9,
        interval: (_index: number, value: string) => {
          const n = Number(value)
          return n === 0 || Math.abs(n - maxKHz) < 0.5 || Math.abs(n % 20) < 0.5
        }
      },
      axisLine: { lineStyle: { color: 'rgba(100,116,139,.35)' } },
      axisTick: { show: false }
    },
    visualMap: {
      min: 0,
      max: 100,
      dimension: 2,
      show: false,
      inRange: {
        color: ['#102a83','#0f4bd8','#0f86e8','#0fb9e8','#19d4c0','#3ee08c','#8ce84a','#e8e33f','#f5a623','#f25c19','#d6201f']
      }
    },
    series: [{
      name: 'Spectrogram',
      type: 'heatmap',
      coordinateSystem: 'cartesian2d',
      data,
      progressive: 2500,
      progressiveThreshold: 5000,
      animation: false,
      itemStyle: { borderWidth: 0, opacity: 0.98 },
      emphasis: { disabled: true }
    }]
  }
})

const option = computed<EChartsCoreOption>(() => {
  if (props.mode === 'timedomain') return timeOption.value
  if (props.mode === 'spectrum') return frequencyOption.value
  return spectrogramOption.value
})

const hasData = computed(() => {
  if (props.mode === 'timedomain') return timeSeries.value.length > 0
  if (props.mode === 'spectrum') return frequencySeries.value.length > 0
  if (props.mode === 'spectrogram') return spectrogramReady.value
  return false
})

function resetAnalysis(): void {
  frequencySeries.value = []
  spectrogramColumns.value = []
  spectrogramReady.value = false
  lastProcessedTimestamp = 0
  revision.value += 1
}

watch(
  () => entry.value?.pcm[entry.value.pcm.length - 1]?.timestamp,
  () => processLatestPcm()
)

watch(
  () => [props.deviceId, props.mode] as const,
  () => {
    resetAnalysis()
    processLatestPcm()
  }
)

onMounted(() => {
  const kind = CAMERA_CELL_VIEW_STREAM[props.mode]
  if (kind) void charts.require(props.deviceId, kind)
  processLatestPcm()
})

watch(
  () => props.mode,
  (next, previous) => {
    const nextKind = CAMERA_CELL_VIEW_STREAM[next]
    const previousKind = CAMERA_CELL_VIEW_STREAM[previous]
    if (nextKind && nextKind !== previousKind) void charts.require(props.deviceId, nextKind)
    if (previousKind && previousKind !== nextKind) charts.release(props.deviceId, previousKind)
  }
)

onBeforeUnmount(() => {
  const kind = CAMERA_CELL_VIEW_STREAM[props.mode]
  if (kind) charts.release(props.deviceId, kind)
})
</script>

<template>
  <div class="cell-chart" :data-cell-chart="mode" data-cell-chart-version="v6-shared-pcm">
    <div class="cell-chart__header">
      <strong class="cell-chart__title">{{ title }}</strong>
      <span v-if="mode !== 'timedomain'" class="cell-chart__range">0-{{ Math.round(Math.min(MAX_KHZ, currentSampleRate() / 2000)) }} kHz</span>
    </div>
    <div class="cell-chart__plot">
      <EChart :option="option" height="100%" />
      <div v-if="!hasData" class="cell-chart__empty" role="status">
        {{ mode === 'spectrogram' && (entry?.pcm?.length ?? 0) > 0 ? 'Preparing signal...' : t('cameraWallUi.viewWaiting') }}
      </div>
    </div>
    <div v-if="entry?.error" class="cell-chart__error" role="alert">
      {{ t('cameraWallUi.viewStreamError') }}
    </div>
  </div>
</template>

<style scoped>
.cell-chart {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 30px 8px 6px;
  box-sizing: border-box;
  overflow: hidden;
  background: #fff;
  color: var(--color-text, #111827);
}

.cell-chart__header {
  flex: 0 0 auto;
  min-height: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px 2px;
}

.cell-chart__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0;
}

.cell-chart__range {
  margin-left: auto;
  flex: 0 0 auto;
  color: var(--color-text-secondary, #64748b);
  font-size: 10px;
}

.cell-chart__plot {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

.cell-chart__empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(255, 255, 255, 0.78);
  color: var(--color-text-secondary, #64748b);
  font-size: 11px;
  pointer-events: none;
}

.cell-chart__error {
  position: absolute;
  left: 10px;
  bottom: 8px;
  max-width: calc(100% - 20px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-danger, #d64545);
  font-size: 10px;
}
</style>
