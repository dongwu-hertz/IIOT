<script setup lang="ts">
/**
 * Shared real-time acoustic visualisation for HZ-FA-371.
 *
 * Design goal:
 * - Reuse the visual grammar of Insight Studio offline AnalysisWorkspacePage.
 * - Build Time Domain / FFT / STFT from ONE 200 kHz PCM source.
 * - Never fall back to device-rendered /fftData or /voiceprintData for these charts.
 *
 * IMPORTANT RAW-PCM CONTRACT
 * The current fa371Stream store historically exposed a 512-point decimated preview
 * in `pcm.waveform`. That preview is NOT sufficient for a 0-65 kHz FFT/STFT.
 * This component therefore consumes one of these raw fields when available:
 *   pcm.rawSamples | pcm.raw | pcm.values | pcm.data | pcm.pcm
 * or `pcm.waveform` only when `pcm.samples === pcm.waveform.length`.
 *
 * Recommended upstream change: retain the full Float32 frame as `pcm.rawSamples`
 * while keeping the decimated `pcm.waveform` for legacy UI/audio preview.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { EChartsCoreOption } from 'echarts/core'
import { useFa371StreamStore } from '@renderer/stores/fa371Stream'
import EChart from '@renderer/components/EChart.vue'

export type RealtimeAcousticSection = 'time' | 'frequency' | 'spectrogram'

const props = withDefaults(
  defineProps<{
    sections?: readonly RealtimeAcousticSection[]
    sampleRate?: number
    fftLen?: number
    maxFrequencyKHz?: number
    timeWindowSeconds?: number
    spectrogramSeconds?: number
    spectrogramPreloadMs?: number
    compact?: boolean
    /** Render inside an existing card (CameraAcousticPanel compatibility path). */
    embedded?: boolean
  }>(),
  {
    sampleRate: 200_000,
    fftLen: 4096,
    maxFrequencyKHz: 65,
    timeWindowSeconds: 1,
    spectrogramSeconds: 6,
    spectrogramPreloadMs: 800,
    compact: false,
    embedded: false,
  },
)

const ALL_SECTIONS: readonly RealtimeAcousticSection[] = ['time', 'frequency', 'spectrogram']
const camera = useFa371StreamStore()
const activeSections = computed(() => props.sections ?? ALL_SECTIONS)
const wants = (section: RealtimeAcousticSection) => activeSections.value.includes(section)

const SAMPLE_RATE_FALLBACK = computed(() => Math.max(1, Math.round(props.sampleRate)))
const FFT_LEN = computed(() => {
  const requested = Math.max(256, Math.round(props.fftLen))
  // radix-2 only
  return 2 ** Math.round(Math.log2(requested))
})
const MAX_DISPLAY_POINTS = 2048
const SPECTROGRAM_ROWS = 224
const RAW_FIELDS = ['rawSamples', 'raw', 'values', 'data', 'pcm'] as const

let sampleRate = SAMPLE_RATE_FALLBACK.value
let ring = new Float32Array(Math.max(sampleRate, 1))
let ringWrite = 0
let ringCount = 0
let spectrogramColumns: number[][] = []

const revision = ref(0)
const rawAvailable = ref(false)
const rawMessage = ref('Waiting for PCM data…')
const latestFrequency = ref<Array<[number, number]>>([])
const spectrogramReady = ref(false)
let spectrogramStartedAt = 0

function normaliseRawSamples(value: unknown): Float32Array | null {
  if (!value) return null
  if (value instanceof Float32Array) return value
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    if (view.byteLength < 4) return null
    if (view instanceof Float64Array) return Float32Array.from(view)
    if (view instanceof Int16Array || view instanceof Int32Array || view instanceof Uint16Array || view instanceof Uint32Array) {
      return Float32Array.from(view as any, (v: number) => Number(v))
    }
    return new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength % 4 !== 0) return null
    return new Float32Array(value.slice(0))
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    return Float32Array.from(value.map((v) => Number(v) || 0))
  }
  return null
}

function extractRawFrame(): { samples: Float32Array; rate: number } | null {
  const frame = camera.pcm as unknown as Record<string, unknown> | null | undefined
  if (!frame) return null

  for (const key of RAW_FIELDS) {
    const samples = normaliseRawSamples(frame[key])
    if (samples && samples.length >= 256) {
      const rate = Number(frame.sampleRate)
      return { samples, rate: Number.isFinite(rate) && rate > 0 ? rate : SAMPLE_RATE_FALLBACK.value }
    }
  }

  // Compatibility: some parsers may decide to keep the full raw frame in waveform.
  const waveform = normaliseRawSamples(frame.waveform)
  const declaredCount = Number(frame.samples)
  if (waveform && waveform.length >= FFT_LEN.value && (!Number.isFinite(declaredCount) || declaredCount === waveform.length)) {
    const rate = Number(frame.sampleRate)
    return { samples: waveform, rate: Number.isFinite(rate) && rate > 0 ? rate : SAMPLE_RATE_FALLBACK.value }
  }

  return null
}

function resetRing(nextRate: number): void {
  sampleRate = Math.max(1, Math.round(nextRate))
  const capacity = Math.max(
    Math.round(sampleRate * Math.max(1, props.timeWindowSeconds)),
    FFT_LEN.value * 4,
  )
  ring = new Float32Array(capacity)
  ringWrite = 0
  ringCount = 0
  spectrogramColumns = []
  latestFrequency.value = []
  spectrogramReady.value = false
  spectrogramStartedAt = 0
}

function appendSamples(samples: Float32Array): void {
  for (let i = 0; i < samples.length; i += 1) {
    ring[ringWrite] = samples[i] ?? 0
    ringWrite = (ringWrite + 1) % ring.length
    ringCount = Math.min(ring.length, ringCount + 1)
  }
}

function latestSamples(count: number): Float32Array {
  const size = Math.min(Math.max(0, count), ringCount)
  const out = new Float32Array(size)
  const start = (ringWrite - size + ring.length) % ring.length
  for (let i = 0; i < size; i += 1) out[i] = ring[(start + i) % ring.length] ?? 0
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

/** Iterative radix-2 FFT, dependency-free for the renderer/worker shared path. */
function fftMagnitude(input: Float32Array): Float64Array {
  const n = input.length
  const bits = Math.log2(n)
  const real = new Float64Array(n)
  const imag = new Float64Array(n)

  for (let i = 0; i < n; i += 1) {
    // Hann window: same default window family used by the offline workspace.
    const w = n > 1 ? 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))) : 1
    real[bitReverse(i, bits)] = (input[i] ?? 0) * w
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

function updateFftAndSpectrogram(): void {
  const fftLen = FFT_LEN.value
  if (ringCount < fftLen) return

  const window = latestSamples(fftLen)
  const magnitudes = fftMagnitude(window)
  const effectiveMaxKHz = Math.min(props.maxFrequencyKHz, sampleRate / 2000)
  const maxBin = Math.min(
    magnitudes.length - 1,
    Math.floor((effectiveMaxKHz * 1000 * fftLen) / sampleRate),
  )
  let peak = 1e-12
  for (let i = 0; i <= maxBin; i += 1) {
    if ((magnitudes[i] ?? 0) > peak) {
      peak = magnitudes[i] ?? 0
    }
  }

  const frequency: Array<[number, number]> = []
  const stride = Math.max(1, Math.ceil((maxBin + 1) / 1024))
  for (let i = 0; i <= maxBin; i += stride) {
    frequency.push([
      Number(((i * sampleRate) / fftLen / 1000).toFixed(4)),
      Math.max(0, Math.min(1, (magnitudes[i] ?? 0) / peak)),
    ])
  }
  latestFrequency.value = frequency

  // One STFT column per incoming PCM frame. Energy is relative dB mapped to 0..100,
  // matching the offline workspace's heat-map semantics without pretending it is SPL.
  const column = new Array<number>(SPECTROGRAM_ROWS)
  for (let row = 0; row < SPECTROGRAM_ROWS; row += 1) {
    const targetHz = (row / Math.max(1, SPECTROGRAM_ROWS - 1)) * effectiveMaxKHz * 1000
    const bin = Math.min(maxBin, Math.max(0, Math.round((targetHz * fftLen) / sampleRate)))
    const db = 20 * Math.log10(Math.max(1e-12, (magnitudes[bin] ?? 0) / peak))
    column[row] = Math.max(0, Math.min(100, ((db + 80) / 80) * 100))
  }
  spectrogramColumns.push(column)
  if (spectrogramStartedAt === 0) spectrogramStartedAt = Date.now()
  const preloadColumns = Math.max(4, Math.ceil((props.spectrogramPreloadMs / 1000) * 10))
  if (!spectrogramReady.value && spectrogramColumns.length >= preloadColumns && Date.now() - spectrogramStartedAt >= props.spectrogramPreloadMs * 0.7) {
    spectrogramReady.value = true
  }
  const maxColumns = Math.max(10, Math.round(props.spectrogramSeconds * 10))
  if (spectrogramColumns.length > maxColumns) {
    spectrogramColumns.splice(0, spectrogramColumns.length - maxColumns)
  }
}

/**
 * 重绘节流（2026-09-22 视频卡顿修复）。
 *
 * 设备每 100 ms 推一帧 PCM，而本组件同屏有**两个实例**（声纹 + 频谱）。若每帧都
 * 跑 FFT + 拼热力图数据 + 触发 ECharts 重建，就是 10 次/秒 × 2 实例的整图重建，
 * 渲染进程主线程被占满，同屏 <video> 随即卡顿掉帧。
 *
 * 做法：环形缓冲**每帧都追加**（追加是 O(n) 拷贝，丢帧会在时域图上留下缺口），
 * 但 FFT/声纹列计算与 `revision`（驱动 ECharts 重建）合并到最多每 120 ms 一次；
 * 节流窗口内到达的帧由尾部定时器补一次刷新，保证低帧率时画面仍然跟着动。
 */
const MIN_FLUSH_MS = 120
let lastFlushAt = 0
let flushTimer: ReturnType<typeof setTimeout> | undefined

function flushCharts(): void {
  flushTimer = undefined
  lastFlushAt = Date.now()
  updateFftAndSpectrogram()
  revision.value += 1
}

function scheduleFlush(): void {
  if (flushTimer !== undefined) return
  const wait = Math.max(0, MIN_FLUSH_MS - (Date.now() - lastFlushAt))
  flushTimer = setTimeout(flushCharts, wait)
}

function updateFromPcm(): void {
  const raw = extractRawFrame()
  if (!raw) {
    rawAvailable.value = false
    const frame = camera.pcm as unknown as Record<string, unknown> | null | undefined
    const preview = normaliseRawSamples(frame?.waveform)
    if (preview?.length) {
      rawMessage.value = `PCM stream connected, but only ${preview.length} preview points are available.`
    } else {
      rawMessage.value = 'Waiting for PCM data…'
    }
    return
  }

  rawAvailable.value = true
  rawMessage.value = ''
  if (raw.rate !== sampleRate) resetRing(raw.rate)
  appendSamples(raw.samples)
  if (Date.now() - lastFlushAt >= MIN_FLUSH_MS) flushCharts()
  else scheduleFlush()
}

watch(
  () => camera.pcm?.timestamp,
  () => updateFromPcm(),
  { immediate: true },
)

const timePoints = computed<Array<[number, number]>>(() => {
  void revision.value
  const wanted = Math.min(ringCount, Math.round(sampleRate * props.timeWindowSeconds))
  if (wanted <= 0) return []
  const samples = latestSamples(wanted)
  const bucket = Math.max(1, Math.ceil(samples.length / MAX_DISPLAY_POINTS))
  const out: Array<[number, number]> = []
  for (let start = 0; start < samples.length; start += bucket) {
    const end = Math.min(samples.length, start + bucket)
    let selected = samples[start] ?? 0
    for (let i = start + 1; i < end; i += 1) {
      const sample = samples[i]
      if (sample === undefined) continue
      if (Math.abs(sample) > Math.abs(selected)) selected = sample
    }
    const seconds = (start - samples.length) / sampleRate
    out.push([Number(seconds.toFixed(6)), selected])
  }
  return out
})

/** 时域图 Y 轴对称量程：0 点固定在卡片中心（业主 2026-09-23），峰值快升慢降。 */
let timeYMax = 1e-3

const timeOption = computed<EChartsCoreOption>(() => {
  void revision.value
  let peak = 0
  for (const point of timePoints.value) {
    const magnitude = Math.abs(point[1])
    if (magnitude > peak) peak = magnitude
  }
  const target = Math.max(peak * 1.15, 1e-3)
  timeYMax = target > timeYMax ? target : Math.max(target, timeYMax * 0.98)
  return {
  animation: false,
  grid: { left: 52, right: 16, top: 18, bottom: 34 },
  tooltip: { trigger: 'axis' },
  xAxis: {
    type: 'value',
    name: 's',
    min: -props.timeWindowSeconds,
    max: 0,
    axisLabel: { color: '#64748b', fontSize: 10 },
    axisLine: { lineStyle: { color: 'rgba(100,116,139,.35)' } },
  },
  yAxis: {
    type: 'value',
    name: 'Amp.',
    // 0 点固定在中心：对称量程（±timeYMax），不用 scale:true 的自动漂移。
    min: -timeYMax,
    max: timeYMax,
    axisLabel: { color: '#64748b', fontSize: 10 },
    splitLine: { lineStyle: { color: 'rgba(148,163,184,.12)' } },
  },
  series: [{
    name: 'Time Domain',
    type: 'line',
    showSymbol: false,
    smooth: false,
    sampling: 'lttb',
    data: timePoints.value,
    lineStyle: { color: '#1d4ed8', width: 1.35 },
    areaStyle: { opacity: 0.06 },
  }],
  }
})

const frequencyOption = computed<EChartsCoreOption>(() => ({
  animation: false,
  grid: { left: 52, right: 16, top: 18, bottom: 36 },
  tooltip: {
    trigger: 'axis',
    formatter: (params: any) => {
      const point = Array.isArray(params) ? params[0] : params
      const value = point?.value ?? []
      return `${Number(value[0] ?? 0).toFixed(3)} kHz<br/>${(Number(value[1] ?? 0) * 100).toFixed(1)}%`
    },
  },
  dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }],
  xAxis: {
    type: 'value',
    name: 'kHz',
    min: 0,
    max: Math.min(props.maxFrequencyKHz, sampleRate / 2000),
    axisLabel: { color: '#64748b', fontSize: 10 },
    axisLine: { lineStyle: { color: 'rgba(100,116,139,.35)' } },
  },
  yAxis: {
    type: 'value',
    name: 'Normalized Level',
    min: 0,
    max: 1,
    axisLabel: { color: '#64748b', fontSize: 10, formatter: (value: number) => `${Math.round(value * 100)}%` },
    splitLine: { lineStyle: { color: 'rgba(148,163,184,.12)' } },
  },
  series: [{
    name: 'FFT',
    type: 'line',
    showSymbol: false,
    smooth: false,
    sampling: 'lttb',
    data: latestFrequency.value,
    lineStyle: { width: 1.6, color: '#0369a1' },
    itemStyle: { color: '#0369a1' },
    areaStyle: { opacity: 0.05 },
  }],
}))

const spectrogramOption = computed<EChartsCoreOption>(() => {
  void revision.value
  const columns = spectrogramColumns
  const xLabels = columns.map((_, index) => {
    const sec = (index - Math.max(0, columns.length - 1)) / 10
    return sec.toFixed(1)
  })
  const yLabels = Array.from({ length: SPECTROGRAM_ROWS }, (_, row) =>
    ((row / Math.max(1, SPECTROGRAM_ROWS - 1)) * Math.min(props.maxFrequencyKHz, sampleRate / 2000)).toFixed(1),
  )
  const data: number[][] = []
  columns.forEach((column, x) => {
    column.forEach((value, y) => data.push([x, y, value]))
  })
  return {
    animation: false,
    tooltip: {
      trigger: 'item',
      formatter: (params: any) => {
        const value = params?.value ?? []
        return `Time: ${xLabels[Number(value[0])] ?? '--'} s<br/>Frequency: ${yLabels[Number(value[1])] ?? '--'} kHz`
      },
    },
    grid: { left: 46, right: 18, top: 18, bottom: 34 },
    xAxis: {
      type: 'category',
      name: 'Time / s',
      data: xLabels,
      axisLabel: { color: '#64748b', fontSize: 10, hideOverlap: true },
      axisLine: { lineStyle: { color: 'rgba(100,116,139,.35)' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'category',
      name: 'kHz',
      data: yLabels,
      axisLabel: {
        color: '#64748b',
        fontSize: 10,
        interval: (_index: number, value: string) => {
          const n = Number(value)
          const maxKHz = Math.min(props.maxFrequencyKHz, sampleRate / 2000)
          return Math.abs(n % 10) < 0.2 || n === 0 || Math.abs(n - maxKHz) < 0.2
        },
      },
      axisLine: { lineStyle: { color: 'rgba(100,116,139,.35)' } },
      axisTick: { show: false },
    },
    visualMap: {
      min: 0,
      max: 100,
      dimension: 2,
      show: false,
      inRange: {
        // Same thermal/infrared-style palette as the offline AnalysisWorkspacePage.
        color: ['#102a83','#0f4bd8','#0f86e8','#0fb9e8','#19d4c0','#3ee08c','#8ce84a','#e8e33f','#f5a623','#f25c19','#d6201f'],
      },
    },
    series: [{
      name: 'Spectrogram',
      type: 'heatmap',
      coordinateSystem: 'cartesian2d',
      data,
      // 2026-09-24「声纹图闪烁」修复：关掉渐进渲染。数据约 60×224≈1.3 万点，
      // 旧配置（progressive 3000 / 阈值 6000）让每次刷新**分块**上屏——一帧里
      // 先画左半再画右半，8 次/秒的刷新下看起来就是持续闪烁。同步一次画完
      // 的代价是单次十几毫秒，换来画面稳定。
      progressive: 0,
      animation: false,
      itemStyle: { borderWidth: 0, opacity: 0.98 },
      emphasis: { disabled: true },
    }],
  }
})

/**
 * 组件卸载时必须清掉挂起的节流定时器，否则它会对着已释放的响应式状态点火。
 */
onBeforeUnmount(() => {
  if (flushTimer !== undefined) clearTimeout(flushTimer)
})

</script>

<template>
  <div class="rac" :class="{ 'rac--compact': compact, 'rac--embedded': embedded }" data-acoustic-chart-version="v5-cumulative">
    <div v-if="!rawAvailable" class="rac__raw-warning" role="status">
      {{ rawMessage }}
    </div>

    <section v-if="wants('time')" :class="embedded ? 'rac__embedded' : 'card rac__card rac__card--time'">
      <div class="section-header rac__header">
        <h3 class="section-title">Time Domain</h3>
      </div>
      <div class="rac__chart"><EChart :option="timeOption" height="100%" merge-updates /></div>
    </section>

    <section v-if="wants('frequency')" :class="embedded ? 'rac__embedded' : 'card rac__card rac__card--frequency'">
      <div class="section-header rac__header">
        <h3 class="section-title">Frequency Spectrum</h3>
      </div>
      <div class="rac__chart"><EChart :option="frequencyOption" height="100%" merge-updates /></div>
    </section>

    <section v-if="wants('spectrogram')" :class="embedded ? 'rac__embedded' : 'card rac__card rac__card--spectrogram'">
      <div class="section-header rac__header">
        <h3 class="section-title">Spectrogram</h3>
      </div>
      <div class="rac__chart">
        <EChart v-if="spectrogramReady" :option="spectrogramOption" height="100%" merge-updates />
        <div v-else class="rac__preparing">Preparing signal…</div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.rac {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2, 8px);
  min-width: 0;
}

.rac--embedded {
  display: block;
}

.rac__embedded {
  min-width: 0;
}

.rac--embedded .rac__header {
  display: none;
}

.rac--embedded .rac__chart {
  min-height: 220px;
}

.rac__raw-warning {
  grid-column: 1 / -1;
  padding: 8px 10px;
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 8px;
  background: var(--color-bg-subtle, #f8fafc);
  color: var(--color-text-secondary, #64748b);
  font-size: 12px;
}

.rac__card {
  min-width: 0;
  min-height: 0;
  padding: 12px;
  display: flex;
  flex-direction: column;
}

.rac__header {
  gap: 8px;
  align-items: flex-start;
}

.rac__meta {
  margin: 3px 0 0;
  font-size: 11px;
  line-height: 1.35;
}

.rac__source {
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: 999px;
  border: 1px solid var(--color-border, #e5e7eb);
  color: var(--color-text-tertiary, #64748b);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: .05em;
}

.rac__chart {
  position: relative;
  flex: 1 1 auto;
  min-height: 210px;
  height: 240px;
}

.rac__preparing {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--color-text-secondary, #64748b);
  font-size: 12px;
  background: linear-gradient(90deg, rgba(248,250,252,.65), rgba(255,255,255,.96), rgba(248,250,252,.65));
}

.rac--compact .rac__chart {
  min-height: 180px;
  height: 210px;
}

@media (max-width: 1180px) {
  .rac { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rac__card--spectrogram { grid-column: 1 / -1; }
}

@media (max-width: 760px) {
  .rac { grid-template-columns: 1fr; }
  .rac__card--spectrogram { grid-column: auto; }
}
</style>
