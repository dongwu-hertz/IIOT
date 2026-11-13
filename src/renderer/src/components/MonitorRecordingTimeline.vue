<script setup lang="ts">
/**
 * ③b 时间轴回放（业主 2026-09-17）—— 实时监测页上"这台设备本机录了什么"的一条时间轴。
 *
 * 为什么这一块是**本机**录像
 * FA8 这一族没有设备侧连续录像存储：能回放的只有本机文件（操作员手动录的片段、
 * 以及从设备下载下来的检测录像，它们登记在同一张录像表里）。所以卡片上必须把
 * "只回放本机文件"写出来 —— 写成"回放设备录像"就是一句假话。
 *
 * 几何全部来自 `lib/playbackTimeline.ts`（时刻↔像素、刻度、缩放/平移、命中测试），
 * 数据全部来自 `lib/recordingTimeline.ts`（录像 → 段、初始窗口、可拖范围）。
 * 本组件只做三件事：**量宽度**、**接鼠标**、**把选中的那一段交给 `RecordingPlayer`**。
 *
 * 三处"手册没说、我们自己定"的交互（与 `lib/playbackTimeline.ts` 文件头一致）
 *   1. 滚轮缩放**以光标下的时刻为锚点**（光标下的时刻不动）；
 *   2. 拖动平移**夹在数据范围内**（拖到头就是没有更多数据，而不是一片空白）；
 *   3. 上一段/下一段按**录像起点**跳（同一时刻的多段去重）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Recording, RecordingPage } from '@shared/domain/models'
import { recordingTypeLabel } from '@renderer/lib/labels'
import { formatDuration } from '@renderer/lib/format'
import {
  clampWindow,
  panWindow,
  placeSegments,
  segmentAt,
  stepEvent,
  ticksFor,
  timeToX,
  xToTime,
  zoomWindow,
  type PlacedSegment,
  type TimeWindow
} from '@renderer/lib/playbackTimeline'
import {
  recordingSegments,
  timelineLimits,
} from '@renderer/lib/recordingTimeline'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import RecordingPlayer from '@renderer/components/RecordingPlayer.vue'

const props = defineProps<{
  /** 只显示这台设备的录像（这一页永远是"一台设备"的视角）。 */
  deviceId: string
}>()

const { t } = useI18n()

/**
 * 一次最多拉多少条。
 *
 * 200 是**页面级**的上限而不是数据上限：时间轴上看不出 200 段与 2000 段的区别
 * （像素只有一千多个），而一次拉 2000 条会把 IPC 和渲染都拖慢。更早的录像去录像页看。
 */
const TIMELINE_LIMIT = 200
/** 时间轴默认显示 1 小时（产品要求 2026-11-13）。 */
const DEFAULT_WINDOW_MS = 3_600_000

const recordings = ref<Recording[]>([])
const loading = ref(false)
const error = ref('')
const viewWindow = ref<TimeWindow>({ startMs: 0, endMs: 0 })
const selectedId = ref('')
const trackEl = ref<HTMLElement | null>(null)
const trackWidth = ref(0)

/** 拖动平移的状态。`null` = 没有在拖。 */
let drag: { startX: number; startWindow: TimeWindow } | null = null

const segments = computed(() => recordingSegments(recordings.value))
const limits = computed(() => {
  const now = Date.now()
  const base = timelineLimits(segments.value, now)
  return {
    ...base,
    minMs: Math.min(base.minMs, now - DEFAULT_WINDOW_MS),
    maxMs: Math.max(base.maxMs, now)
  }
})

function initialWindow(): TimeWindow {
  const now = Date.now()
  const latestEnd = segments.value.reduce((latest, segment) => Math.max(latest, segment.endMs), 0)
  const endMs = Math.max(now, latestEnd)
  return { startMs: endMs - DEFAULT_WINDOW_MS, endMs }
}
const placed = computed<PlacedSegment[]>(() =>
  placeSegments(viewWindow.value, trackWidth.value, segments.value)
)
const ticks = computed(() => ticksFor(viewWindow.value, trackWidth.value).ticks)
const spanMs = computed(() => viewWindow.value.endMs - viewWindow.value.startMs)

/** 段类型 → 类名（颜色由 CSS 决定，这里只给一个有语义的名字）。 */
function segmentClass(segment: PlacedSegment): string {
  return `mtl__segment mtl__segment--${segment.kind}${segment.id === selectedId.value ? ' mtl__segment--selected' : ''}`
}

function segmentTitle(segment: PlacedSegment): string {
  const recording = recordings.value.find((item) => item.id === segment.id)
  if (!recording) return segment.id
  const parts = [recordingTypeLabel(recording.recordingType)]
  const end = recording.endTime ?? recording.startTime + (recording.durationMs ?? 0)
  if (end > recording.startTime) parts.push(formatDuration(end - recording.startTime))
  return parts.join(' · ')
}

/**
 * 当前时间游标的位置。
 *
 * 用 `Date.now()` 的**渲染时刻**而不是定时器：这一页已经有一条 500 ms 的录制计时器，
 * 再加一条"只为画一根线"的定时器会让整个页面每秒重排两次。游标在窗口内才画。
 */
const nowX = computed(() => {
  const at = Date.now()
  if (at < viewWindow.value.startMs || at > viewWindow.value.endMs) return null
  return timeToX(viewWindow.value, trackWidth.value, at)
})

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString()
}

async function load(): Promise<void> {
  const deviceId = props.deviceId
  if (deviceId === '') {
    recordings.value = []
    selectedId.value = ''
    error.value = ''
    viewWindow.value = clampWindow(initialWindow(), limits.value)
    return
  }
  loading.value = true
  const result = await callApi(() =>
    window.api.recordings.query({ deviceId, limit: TIMELINE_LIMIT })
  )
  loading.value = false
  if (props.deviceId !== deviceId) return
  if (!result.success) {
    error.value = resultMessage(result)
    recordings.value = []
    viewWindow.value = clampWindow(initialWindow(), limits.value)
    return
  }
  error.value = ''
  const page: RecordingPage | undefined = unwrap(result)
  recordings.value = page?.items ?? []
  selectedId.value = ''
  viewWindow.value = clampWindow(initialWindow(), limits.value)
}

/**
 * 量轨道宽度。
 *
 * 用 `ResizeObserver` 而不是 `window.resize`：这一块的宽度还会因为侧栏折叠、
 * 卡片重排而变化，而 `window.resize` 一次都不会触发（那时候量到的宽度是错的）。
 */
let observer: ResizeObserver | null = null

function measure(): void {
  const element = trackEl.value
  if (!element) return
  const width = Math.round(element.getBoundingClientRect().width)
  if (width > 0 && width !== trackWidth.value) trackWidth.value = width
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && trackEl.value) {
    observer = new ResizeObserver(measure)
    observer.observe(trackEl.value)
  }
  void load()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  drag = null
})

watch(
  () => props.deviceId,
  () => {
    void load()
  }
)

// --- 交互 -------------------------------------------------------------------

/** 滚轮缩放：锚点是光标下的时刻（缩放前后它待在同一个像素上）。 */
function onWheel(event: WheelEvent): void {
  event.preventDefault()
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
  const element = trackEl.value
  if (!element || trackWidth.value <= 0) return
  drag = { startX: event.clientX, startWindow: { ...viewWindow.value } }
  element.setPointerCapture?.(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  const element = trackEl.value
  if (!drag || !element || trackWidth.value <= 0) return
  const deltaPx = event.clientX - drag.startX
  const deltaMs = -(deltaPx / trackWidth.value) * spanMs.value
  viewWindow.value = panWindow(drag.startWindow, deltaMs, limits.value)
}

function onPointerUp(event: PointerEvent): void {
  const element = trackEl.value
  const moved = drag ? Math.abs(event.clientX - drag.startX) : 0
  drag = null
  element?.releasePointerCapture?.(event.pointerId)
  // 拖动超过 3 像素算"平移"，不当作点击：否则拖完时间轴会顺带播放一段录音。
  if (moved <= 3) onTrackClick(event);
}

function onTrackClick(event: MouseEvent | PointerEvent): void {
  const element = trackEl.value
  if (!element || trackWidth.value <= 0) return
  const x = event.clientX - element.getBoundingClientRect().left
  const hit = segmentAt(placed.value, x)
  if (!hit) return
  selectedId.value = selectedId.value === hit.id ? '' : hit.id
}

/** 跳到上一/下一段录像的**起点**；没有更远的一段就什么都不做（按钮同时是禁用的）。 */
function stepTo(direction: 'next' | 'previous'): void {
  const starts = segments.value.map((segment) => segment.startMs)
  const current = direction === 'next' ? viewWindow.value.endMs : viewWindow.value.startMs
  const target = stepEvent(starts, current, direction)
  if (target === undefined) return
  const span = spanMs.value
  // 目标落在窗口中间，而不是贴边：贴边的话再点一次会立刻没有"下一段"。
  viewWindow.value = clampWindow(
    { startMs: target - span / 2, endMs: target + span / 2 },
    limits.value
  )
}

const canStepPrevious = computed(
  () => stepEvent(segments.value.map((segment) => segment.startMs), viewWindow.value.startMs, 'previous') !== undefined
)
const canStepNext = computed(
  () => stepEvent(segments.value.map((segment) => segment.startMs), viewWindow.value.endMs, 'next') !== undefined
)
</script>

<template>
  <section class="card mtl">
    <div class="section-header mtl__header">
      <h3 class="section-title">{{ t('monitorUi.playbackSection') }}</h3>
      <div class="btn-row mtl__controls">      <button
        type="button"
        class="btn btn--sm"
        :disabled="!canStepPrevious"
        @click="stepTo('previous')"
      >
        {{ t('monitorUi.playbackPrevious') }}
      </button>
      <button type="button" class="btn btn--sm" :disabled="!canStepNext" @click="stepTo('next')">
        {{ t('monitorUi.playbackNext') }}
      </button>
      <button type="button" class="btn btn--sm" @click="zoomBy(2)">
        {{ t('monitorUi.playbackZoomIn') }}
      </button>
      <button type="button" class="btn btn--sm" @click="zoomBy(0.5)">
        {{ t('monitorUi.playbackZoomOut') }}
      </button>
      <span class="muted mtl__window">
        {{ t('monitorUi.playbackWindow', { from: timeLabel(viewWindow.startMs), to: timeLabel(viewWindow.endMs) }) }}
      </span>      </div>
    </div>

    <p v-if="error" class="alert alert--danger" role="alert">{{ error }}</p>

    <!--
      轨道：滚轮缩放、拖动平移、点段落选中并播放。
      `ref="trackEl"` 是用来**量宽度**的（几何计算需要像素宽度），不是画布。
    -->
    <div
      ref="trackEl"
      class="mtl__track"
      :class="{ 'mtl__track--empty': segments.length === 0 }"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <div
        v-for="segment in placed"
        :key="segment.id"
        :class="segmentClass(segment)"
        :style="{ left: segment.leftPx + 'px', width: Math.max(2, segment.widthPx) + 'px' }"
        :title="segmentTitle(segment)"
        role="button"
        tabindex="0"
        @keydown.enter="selectedId = selectedId === segment.id ? '' : segment.id"
      ></div>
      <div
        v-if="nowX !== null"
        class="mtl__now"
        :style="{ left: nowX + 'px' }"
        :title="t('monitorUi.playbackNow')"
      ></div>
    </div>

    <div class="mtl__ticks">
      <span
        v-for="tick in ticks"
        :key="tick.at"
        class="mtl__tick"
        :style="{ left: tick.x + 'px' }"
      >
        {{ timeLabel(tick.at) }}
      </span>
    </div>

    <p v-if="loading" class="muted mtl__state">{{ t('monitorUi.playbackLoading') }}</p>
    <p v-else-if="segments.length === 0" class="muted mtl__state">
      {{ t('monitorUi.playbackEmpty') }}
    </p>

    <RecordingPlayer v-if="selectedId" :recording-id="selectedId" auto-load />
  </section>
</template>

<style scoped>
.mtl {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.mtl__hint,
.mtl__window,
.mtl__state {
  font-size: 11.5px;
}

/*
 * 轨道是**一根**固定的高度条：段落画在它里面，刻度画在它下面。
 * 段落的颜色按录像类型区分（手册 p60：不同录像类型以颜色区分），
 * 三种颜色都在 `--color-*` token 里取，没有新引入色值。
 */
.mtl__track {
  position: relative;
  height: 44px;
  background: var(--color-bg-subtle);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: grab;
  /* 段落用绝对定位，超出轨道的部分（拖动窗口时）必须被裁掉，否则会画到卡片外面。 */
  overflow: hidden;
  touch-action: none;
}

.mtl__track--empty {
  cursor: default;
}

.mtl__segment {
  position: absolute;
  top: 6px;
  bottom: 6px;
  background: var(--color-accent);
  border-radius: 3px;
  cursor: pointer;
}

.mtl__segment--alarm {
  background: var(--color-danger);
}

.mtl__segment--manual {
  background: var(--color-accent);
}

.mtl__segment--event {
  background: var(--color-warning);
}

.mtl__segment--selected {
  box-shadow: inset 0 0 0 2px #fff, 0 0 0 2px var(--color-accent-hover);
}

.mtl__now {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--color-text-secondary);
}

.mtl__ticks {
  position: relative;
  height: 16px;
  font-size: 10.5px;
  color: var(--color-text-secondary);
}

.mtl__tick {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.mtl__header {
  flex-wrap: nowrap;
  align-items: center;
}

.mtl__controls {
  margin-left: auto;
  justify-content: flex-end;
  flex-wrap: nowrap;
}
</style>
