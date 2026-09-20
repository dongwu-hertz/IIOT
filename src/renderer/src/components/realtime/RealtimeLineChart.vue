<script setup lang="ts">
/**
 * 实时区的通用折线图（规格 §11 / §32）。
 *
 * 为什么不用 ECharts：这几张图是 60 秒 / 一条门限的稀疏小图，而 ECharts 实例的
 * 初始化与 dispose 在"设备切换 + 面板拖拽"这种高频场景里容易留下悬挂实例。
 * 仓库里大图表（趋势页）继续用 ECharts；这一层用轻量 SVG，颜色 token 与全局一致。
 *
 * 规则与规格一致：
 *   - 网格极淡、无渐变、无 3D；
 *   - 门限是虚线，不把整块图变红；
 *   - hover 显示 Time / Value / Unit / Channel；
 *   - 空数据显示一句空态，不画一条假线。
 */

import { computed, ref } from 'vue'
import { EMPTY_VALUE, formatClock, formatNumber } from '@renderer/lib/format'

export interface LinePoint {
  x: number
  y: number
}

const props = withDefaults(
  defineProps<{
    points: LinePoint[]
    emptyText: string
    /** x 轴的语义：时间戳 / 数值（频率、样本序号）。 */
    xKind?: 'time' | 'value'
    /** 数值 x 轴的单位，例如 Hz。 */
    xUnit?: string
    yUnit?: string
    valuePrecision?: number
    /** 门限；在范围外就不画（避免把坐标轴拉变形）。 */
    threshold?: number
    /** 门限的说明文字（已翻译）。 */
    thresholdLabel?: string
    channelLabel?: string
    height?: number
  }>(),
  { xKind: 'time', height: 180 }
)

const hoverIndex = ref<number | null>(null)

const geometry = computed(() => {
  const points = props.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
  if (points.length === 0) return null
  let yMin = Math.min(...points.map((point) => point.y))
  let yMax = Math.max(...points.map((point) => point.y))
  if (props.threshold !== undefined && Number.isFinite(props.threshold)) {
    if (props.threshold < yMin) yMin = props.threshold
    if (props.threshold > yMax) yMax = props.threshold
  }
  if (yMax === yMin) {
    yMax += 1
    yMin -= 1
  }
  const yPad = (yMax - yMin) * 0.08
  yMin -= yPad
  yMax += yPad

  const xValues = points.map((point) => point.x)
  let xMin = Math.min(...xValues)
  let xMax = Math.max(...xValues)
  if (xMax === xMin) xMax = xMin + 1

  const coords = points.map((point) => ({
    px: ((point.x - xMin) / (xMax - xMin)) * 100,
    py: 100 - ((point.y - yMin) / (yMax - yMin)) * 100,
    point
  }))
  const path = coords
    .map((coord, index) => `${index === 0 ? 'M' : 'L'}${coord.px.toFixed(2)},${coord.py.toFixed(2)}`)
    .join(' ')
  const thresholdY =
    props.threshold !== undefined && props.threshold >= yMin && props.threshold <= yMax
      ? 100 - ((props.threshold - yMin) / (yMax - yMin)) * 100
      : null
  return { coords, path, yMin, yMax, xMin, xMax, thresholdY }
})

const xAxisText = computed(() => {
  const geometryValue = geometry.value
  if (!geometryValue) return { start: '', end: '' }
  const format = (value: number): string => {
    if (props.xKind === 'time') return formatClock(value)
    const number = formatNumber(value, 0)
    return props.xUnit ? `${number} ${props.xUnit}` : number
  }
  return { start: format(geometryValue.xMin), end: format(geometryValue.xMax) }
})

const hovered = computed(() => {
  const index = hoverIndex.value
  const geometryValue = geometry.value
  if (index === null || !geometryValue) return null
  const coord = geometryValue.coords[index]
  if (!coord) return null
  return coord
})

const hoverTitle = computed(() => {
  const coord = hovered.value
  if (!coord) return ''
  if (props.xKind === 'time') return formatClock(coord.point.x)
  const number = formatNumber(coord.point.x, 0)
  return props.xUnit ? `${number} ${props.xUnit}` : number
})

const hoverValue = computed(() => {
  const coord = hovered.value
  if (!coord) return EMPTY_VALUE
  const text = formatNumber(coord.point.y, props.valuePrecision)
  return props.yUnit ? `${text} ${props.yUnit}` : text
})

function onPointerMove(event: PointerEvent): void {
  const geometryValue = geometry.value
  if (!geometryValue) return
  const target = event.currentTarget as HTMLElement | null
  if (!target) return
  const rect = target.getBoundingClientRect()
  if (rect.width <= 0) return
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  hoverIndex.value = Math.round(ratio * (geometryValue.coords.length - 1))
}
</script>

<template>
  <div class="rt-chart" :style="{ height: `${height}px` }" data-realtime-chart>
    <template v-if="geometry">
      <svg class="rt-chart__svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <line v-for="level in [25, 50, 75]" :key="level" class="rt-chart__grid" x1="0" :y1="level" x2="100" :y2="level" />
        <line
          v-if="geometry.thresholdY !== null"
          class="rt-chart__threshold"
          x1="0"
          :y1="geometry.thresholdY"
          x2="100"
          :y2="geometry.thresholdY"
        />
        <path class="rt-chart__line" :d="geometry.path" vector-effect="non-scaling-stroke" />
        <circle
          v-if="hovered"
          class="rt-chart__cursor"
          :cx="hovered.px"
          :cy="hovered.py"
          r="2"
          vector-effect="non-scaling-stroke"
        />
      </svg>
      <div
        class="rt-chart__overlay"
        @pointermove="onPointerMove"
        @pointerleave="hoverIndex = null"
      ></div>
      <span class="rt-chart__axis rt-chart__axis--y-max">{{ formatNumber(geometry.yMax, valuePrecision) }}</span>
      <span class="rt-chart__axis rt-chart__axis--y-min">{{ formatNumber(geometry.yMin, valuePrecision) }}</span>
      <span class="rt-chart__axis rt-chart__axis--x-start">{{ xAxisText.start }}</span>
      <span class="rt-chart__axis rt-chart__axis--x-end">{{ xAxisText.end }}</span>
      <p v-if="geometry.thresholdY !== null && thresholdLabel" class="rt-chart__threshold-label">
        {{ thresholdLabel }}
      </p>
      <div
        v-if="hovered"
        class="rt-chart__tooltip"
        :style="{ left: `${Math.min(88, Math.max(12, hovered.px))}%`, top: `${Math.min(78, Math.max(4, hovered.py - 12))}%` }"
      >
        <span>{{ hoverTitle }}</span>
        <strong>{{ hoverValue }}</strong>
        <span v-if="channelLabel">{{ channelLabel }}</span>
      </div>
    </template>
    <p v-else class="rt-chart__empty">{{ emptyText }}</p>
  </div>
</template>

<style scoped>
.rt-chart {
  position: relative;
  width: 100%;
  min-height: 96px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  overflow: hidden;
}

.rt-chart__svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.rt-chart__grid {
  stroke: var(--color-border);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.rt-chart__threshold {
  stroke: var(--color-warning);
  stroke-width: 1;
  stroke-dasharray: 4 4;
  vector-effect: non-scaling-stroke;
}

.rt-chart__line {
  fill: none;
  stroke: var(--color-accent);
  stroke-width: 1.6;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.rt-chart__cursor {
  fill: var(--color-bg);
  stroke: var(--color-accent);
  stroke-width: 1.5;
}

.rt-chart__overlay {
  position: absolute;
  inset: 0;
  cursor: crosshair;
}

.rt-chart__axis {
  position: absolute;
  font-size: 10.5px;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

.rt-chart__axis--y-max {
  top: 2px;
  left: 4px;
}

.rt-chart__axis--y-min {
  bottom: 2px;
  left: 4px;
}

.rt-chart__axis--x-start {
  bottom: 2px;
  left: 28px;
}

.rt-chart__axis--x-end {
  bottom: 2px;
  right: 4px;
}

.rt-chart__threshold-label {
  position: absolute;
  right: 4px;
  top: 2px;
  margin: 0;
  font-size: 10px;
  color: var(--color-warning);
  pointer-events: none;
}

.rt-chart__tooltip {
  position: absolute;
  transform: translate(-50%, -100%);
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 6px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  box-shadow: var(--shadow-md);
  font-size: 11px;
  white-space: nowrap;
  pointer-events: none;
}

.rt-chart__empty {
  margin: 0;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--color-text-tertiary);
}
</style>