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
   * 缩放窗口变化（`dataZoom` 事件）。
   *
   * 两种都要给：**百分比**（`start`/`end`，类目轴上的语义）与**时间戳**
   * （`startValue`/`endValue`，时间轴上的语义）。`xAxis.type = 'time'` 之后 ECharts
   * 报的主要是后者，而"当前显示哪一段时间"这句话只有在拿到时间戳时才说得准
   * （百分比换算回去会差一个桶）。哪一个缺就传 `null`。
   */
  (
    event: 'datazoom',
    window: {
      start: number
      end: number
      startValue: number | null
      endValue: number | null
      /**
       * 这一条事件是不是**用户手势**引起的（滚轮/按下）。见 `noteGesture()` 与 emit 处的注释：
       * 父组件只认 `true`，因为程序写入选项之后 ECharts 也会回一条形状一样的事件，
       * 而那条回声正是"改状态 → 重算选项 → setOption → 再回声"这条死循环的燃料。
       */
      userDriven: boolean
    }
  ): void
}>()

const container = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null
let observer: ResizeObserver | null = null
/** 上一次真正 `resize()` 时容器的像素尺寸（用来把"尺寸没变"的通知变成空操作）。 */
let lastSize = { width: -1, height: -1 }

/**
 * 容器尺寸**真的变了**才 `chart.resize()`。
 *
 * 为什么加这一道（2026-09-20 定位到的第二次卡死）：`ResizeObserver` 的通知与
 * `chart.resize()` 之间可以形成一条环 —— ECharts 会按容器尺寸重设画布，而画布尺寸一变，
 * 容器（没有固定宽度、由内容决定）又可能跟着变，于是"通知 → resize → 通知"一直转。
 * 它的表现与缩放回声那条环**一模一样**：一个核心占满、页面照旧出帧、进程内存一直涨，
 * 而 `executeJavaScript` 再也不 settle（探针里就是"渲染进程不响应"）。
 *
 * 判据取整到像素：亚像素抖动不触发 resize（那种抖动不会让图变得更好看，只会多画一帧）。
 */
/** 最近一次**用户手势**（滚轮 / 按下）有没有还没被某条 `dataZoom` 认领。见下面的 emit。 */
let gesturePending = false

/** 用户在图上做了动作（`@wheel.capture` / `@pointerdown.capture` 调用）。 */
function noteGesture(): void {
  gesturePending = true
}

function resize(): void {
  const element = container.value
  if (!chart || !element) return
  const rect = element.getBoundingClientRect()
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  if (width === lastSize.width && height === lastSize.height) return
  lastSize = { width, height }
  chart.resize()
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
    const payload = event as {
      batch?: Array<{ start?: number; end?: number; startValue?: unknown; endValue?: unknown }>
      start?: number
      end?: number
      startValue?: unknown
      endValue?: unknown
    }
    const first = Array.isArray(payload.batch) ? payload.batch[0] : payload
    if (!first) return
    const asNumber = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null
    /*
     * **一次用户手势只认一条 `dataZoom`。**（2026-09-20 定位到的那条死循环的根治）
     *
     * 我们没法从 ECharts 的载荷里分辨"用户缩放"与"程序写入选项之后的回声"（两者形状一样），
     * 但**回声永远跟在用户的动作之后**：`wheel` / `pointerdown` 是在渲染进程里能拿到的事实。
     * 于是：手势发生 → 置位；下一条 `dataZoom` 认领并**清掉**置位 —— 之后所有回声（不管几条、
     * 隔多久）都不再是"用户驱动"，父组件因此不会把窗口再写回选项，环就断了。
     *
     * 为什么要在**捕获阶段**监听：ECharts 的滚轮处理挂在它自己的画布上，冒泡阶段我们这句
     * 会晚于它；晚一步就会出现"真的滚了一下，置位还没来，于是这次缩放被丢掉"。
     */
    const userDriven = gesturePending
    gesturePending = false
    emit('datazoom', {
      start: Number(first.start ?? 0),
      end: Number(first.end ?? 100),
      startValue: asNumber(first.startValue),
      endValue: asNumber(first.endValue),
      userDriven
    })
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
    <div
      ref="container"
      class="chart__canvas"
      @wheel.capture="noteGesture"
      @pointerdown.capture="noteGesture"
    ></div>
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
