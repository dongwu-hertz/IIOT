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
import { GridComponent, TooltipComponent, VisualMapComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'

echarts.use([
  LineChart,
  BarChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  VisualMapComponent,
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

const container = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null
let observer: ResizeObserver | null = null

function resize(): void {
  chart?.resize()
}

onMounted(() => {
  if (!container.value) return
  chart = echarts.init(container.value, undefined, { renderer: 'canvas' })
  chart.setOption(props.option, true)
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
