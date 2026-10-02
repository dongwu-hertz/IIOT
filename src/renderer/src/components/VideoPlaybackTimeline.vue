<script setup lang="ts">
/**
 * 相机本机录像的只读时间轴（S3 第一刀）。
 *
 * 画两件事：
 *   - 已登记的 MP4 片段（按录像类型上色），片段之间的空白就是**没有录像的缺口**；
 *   - 当前播放位置（父组件从 `<video>.currentTime` 换算后传进来）。
 *
 * 交互与 `MonitorRecordingTimeline` 同一套几何：滚轮以光标为锚点缩放、左键拖动平移，
 * 平移/缩放都夹在数据的起止范围内。这样 30 分钟区间不会被整天的范围压成一根线。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  panWindow,
  placeSegments,
  ticksFor,
  timeToX,
  xToTime,
  zoomWindow,
  type TimeWindow
} from '@renderer/lib/playbackTimeline'
import {
  timelineLimits,
  timelineWindow,
  type TimelineSegment
} from '@renderer/lib/recordingTimeline'

const props = defineProps<{
  segments: TimelineSegment[]
  currentId?: string
  /** 当前播放时刻（epoch ms），null/越界时不画游标。 */
  cursorMs?: number | null
  label?: string
  zoomInLabel?: string
  zoomOutLabel?: string
}>()

const emit = defineEmits<{
  (event: 'select', id: string): void
}>()

const trackEl = ref<HTMLElement | null>(null)
const trackWidth = ref(0)
const viewWindow = ref<TimeWindow>(timelineWindow(props.segments, Date.now()))
let observer: ResizeObserver | null = null
let drag: { startX: number; startWindow: TimeWindow } | null = null
let dragged = false

const limits = computed(() => timelineLimits(props.segments, Date.now()))
const placed = computed(() => placeSegments(viewWindow.value, trackWidth.value, props.segments))
const tickMarks = computed(() =>
  ticksFor(viewWindow.value, trackWidth.value).ticks.map((tick) => ({
    at: tick.at,
    x: tick.x,
    label: new Date(tick.at).toLocaleTimeString()
  }))
)
const cursorX = computed(() => {
  const cursor = props.cursorMs
  if (typeof cursor !== 'number' || !Number.isFinite(cursor)) return null
  const window = viewWindow.value
  if (cursor < window.startMs || cursor > window.endMs) return null
  return timeToX(window, trackWidth.value, cursor)
})

function resetWindow(): void {
  viewWindow.value = timelineWindow(props.segments, Date.now())
}

function segmentTitle(segment: TimelineSegment): string {
  return `${new Date(segment.startMs).toLocaleString()} – ${new Date(segment.endMs).toLocaleTimeString()}`
}

function measure(): void {
  const element = trackEl.value
  if (!element) return
  const width = Math.round(element.getBoundingClientRect().width)
  if (width > 0 && width !== trackWidth.value) trackWidth.value = width
}

function onWheel(event: WheelEvent): void {
  const element = trackEl.value
  if (!element || trackWidth.value <= 0) return
  const x = event.clientX - element.getBoundingClientRect().left
  const anchorMs = xToTime(viewWindow.value, trackWidth.value, x)
  const factor = event.deltaY < 0 ? 1.25 : 1 / 1.25
  viewWindow.value = zoomWindow(viewWindow.value, factor, anchorMs, limits.value)
}

function zoomBy(factor: number): void {
  const anchorMs = (viewWindow.value.startMs + viewWindow.value.endMs) / 2
  viewWindow.value = zoomWindow(viewWindow.value, factor, anchorMs, limits.value)
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  drag = { startX: event.clientX, startWindow: { ...viewWindow.value } }
  dragged = false
}

function onPointerMove(event: PointerEvent): void {
  if (!drag) return
  const deltaPx = event.clientX - drag.startX
  if (Math.abs(deltaPx) > 3) dragged = true
  const deltaMs = -(deltaPx / Math.max(trackWidth.value, 1)) * (drag.startWindow.endMs - drag.startWindow.startMs)
  viewWindow.value = panWindow(drag.startWindow, deltaMs, limits.value)
}

function onPointerUp(): void {
  drag = null
  // 等 click 事件处理完再复位，否则拖动终点正好落在一段上时会误播那一段。
  window.setTimeout(() => {
    dragged = false
  }, 0)
}

function onSegmentClick(id: string): void {
  if (dragged) {
    dragged = false
    return
  }
  emit('select', id)
}

onMounted(() => {
  resetWindow()
  measure()
  if (typeof ResizeObserver !== 'undefined' && trackEl.value) {
    observer = new ResizeObserver(measure)
    observer.observe(trackEl.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  drag = null
})

watch(
  () => props.segments,
  () => {
    resetWindow()
  }
)
</script>

<template>
  <div class="vpt">
    <div class="vpt__toolbar">
      <span v-if="label" class="vpt__label">{{ label }}</span>
      <button
        type="button"
        class="btn btn--sm btn--icon"
        :title="zoomInLabel"
        :aria-label="zoomInLabel"
        @click="zoomBy(1.5)"
      >
        ＋
      </button>
      <button
        type="button"
        class="btn btn--sm btn--icon"
        :title="zoomOutLabel"
        :aria-label="zoomOutLabel"
        @click="zoomBy(1 / 1.5)"
      >
        －
      </button>
    </div>

    <div
      ref="trackEl"
      class="vpt__track"
      role="group"
      :aria-label="label"
      @wheel.prevent="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onPointerUp"
    >
      <button
        v-for="segment in placed"
        :key="segment.id"
        type="button"
        class="vpt__segment"
        :class="[
          `vpt__segment--${segment.kind}`,
          { 'vpt__segment--current': segment.id === currentId }
        ]"
        :style="{
          left: `${segment.leftPx}px`,
          width: `${Math.max(segment.widthPx, 3)}px`
        }"
        :title="segmentTitle(segment)"
        :aria-label="segmentTitle(segment)"
        @click="onSegmentClick(segment.id)"
      ></button>

      <span
        v-for="tick in tickMarks"
        :key="tick.at"
        class="vpt__tick"
        :style="{ left: `${tick.x}px` }"
        aria-hidden="true"
      >
        <span class="vpt__tick-label">{{ tick.label }}</span>
      </span>

      <span
        v-if="cursorX !== null"
        class="vpt__cursor"
        :style="{ left: `${cursorX}px` }"
        aria-hidden="true"
      ></span>
    </div>
  </div>
</template>

<style scoped>
.vpt {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.vpt__toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}

.vpt__label {
  margin-right: auto;
  color: var(--color-text-secondary);
  font-size: 11.5px;
}

.vpt__track {
  position: relative;
  width: 100%;
  height: 46px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-neutral-soft);
  cursor: grab;
  touch-action: none;
}

.vpt__track:active {
  cursor: grabbing;
}

.vpt__segment {
  position: absolute;
  top: 7px;
  bottom: 7px;
  min-width: 3px;
  padding: 0;
  border: 1px solid var(--color-accent-border);
  border-radius: 3px;
  background: var(--color-accent-soft);
  cursor: pointer;
}

.vpt__segment--scheduled {
  border-color: var(--color-success-border);
  background: var(--color-success-soft);
}

.vpt__segment--alarm {
  border-color: var(--color-danger-border);
  background: var(--color-danger-soft);
}

.vpt__segment--current {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.vpt__segment:hover {
  filter: brightness(0.96);
}

.vpt__tick {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--color-neutral-border);
  pointer-events: none;
}

.vpt__tick-label {
  position: absolute;
  top: 1px;
  left: 3px;
  color: var(--color-text-tertiary);
  font-size: 10px;
  line-height: 12px;
  white-space: nowrap;
}

.vpt__cursor {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--color-accent);
  pointer-events: none;
}
</style>