<script setup lang="ts">
/**
 * Thin ECharts wrapper.
 *
 * Owns the three things that are easy to get wrong and expensive to leak:
 *   1. init on mount, `dispose()` in `onUnmounted`;
 *   2. `resize()` on window resize AND on container resize (the sidebar/chart
 *      panel can change width without a window resize);
 *   3. `setOption(option, true)` so a chart with a different series count
 *      (e.g. extended metrics appearing/disappearing) is replaced, not merged.
 *
 * The chart only ever renders values handed to it by a store or the simulated
 * realtime composable — it has no data source of its own.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
// Tree-shaken ECharts build: only the chart types and components this app
// actually renders are registered, which keeps the renderer bundle small.
// `EChartsCoreOption` is the runtime-agnostic option type of the core build.
import * as echarts from 'echarts/core'
import { BarChart, HeatmapChart, LineChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GridComponent,
  TooltipComponent,
  VisualMapComponent
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'

echarts.use([
  LineChart,
  BarChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  VisualMapComponent,
  // 第 13 批第 6 条：「所有折线图支持时间轴放大缩小」。`dataZoom` 是一个**组件**，
  // 不在核心构建里 —— 不注册它，选项里的 `dataZoom` 会被静默忽略（图照画，就是不能缩放）。
  DataZoomComponent,
  CanvasRenderer
])

const props = withDefaults(
  defineProps<{
    option: EChartsCoreOption
    height?: string
    /** Shown as an overlay when there is nothing to plot yet. */
    placeholder?: string
  }>(),
  { height: '220px', placeholder: '' }
)

const emit = defineEmits<{
  /**
   * 缩放窗口变化（`dataZoom` 事件）。给的是**百分比**（0–100），与 ECharts 的语义一致；
   * 换算成"第几个时间桶 / 哪一段时间"由调用方按自己的数据做（它才知道桶在哪）。
   *
   * 为什么要把这件事暴露出来：缩进去之后图上**看不出来**自己在哪一段 ——
   * 一张只画了三分钟数据的图与一张画了三十天的图长得一模一样。调用方拿这个值在图上写明
   * "当前显示 a–b / 共 n 点"，操作员才不会把放大后的图当成全部。
   */
  (event: 'datazoom', window: { start: number; end: number }): void
}>()

const container = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null
let observer: ResizeObserver | null = null

function resize(): void {
  chart?.resize()
}

/**
 * 把时间轴缩回整段（界面上的「重置缩放」）。
 *
 * `dispatchAction` 而不是改选项：改选项会重画整张图（`setOption(option, true)` 连数据一起换），
 * 而这里只是把观察窗口拉回 0–100% —— 数据一点没变。
 */
function resetZoom(): void {
  chart?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })
}

defineExpose({ resetZoom })

onMounted(() => {
  if (!container.value) return
  chart = echarts.init(container.value, undefined, { renderer: 'canvas' })
  chart.setOption(props.option, true)
  chart.on('dataZoom', (event) => {
    // ECharts 的载荷有两种形状（`batch` 与平铺），两者都要认；认不出来的就不发事件。
    const payload = event as { batch?: Array<{ start?: number; end?: number }>; start?: number; end?: number }
    const first = Array.isArray(payload.batch) ? payload.batch[0] : payload
    if (!first) return
    const start = first.start ?? 0
    const end = first.end ?? 100
    emit('datazoom', { start: Number(start), end: Number(end) })
  })
  window.addEventListener('resize', resize)
  // jsdom-less runtime: ResizeObserver exists in Electron/Chromium.
  if (typeof ResizeObserver !== 'undefined' && container.value) {
    observer = new ResizeObserver(() => resize())
    observer.observe(container.value)
  }
})

watch(
  () => props.option,
  (option) => {
    chart?.setOption(option, true)
  },
  { deep: false }
)

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize)
  observer?.disconnect()
  observer = null
  chart?.dispose()
  chart = null
})
</script>

<template>
  <div class="chart" :style="{ height }">
    <div ref="container" class="chart__canvas"></div>
    <div v-if="placeholder" class="chart__placeholder">{{ placeholder }}</div>
  </div>
</template>

<style scoped>
.chart {
  position: relative;
  width: 100%;
  min-width: 0;
}

.chart__canvas {
  width: 100%;
  height: 100%;
}

.chart__placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.72);
  color: var(--color-text-secondary);
  font-size: 12px;
  pointer-events: none;
}
</style>
