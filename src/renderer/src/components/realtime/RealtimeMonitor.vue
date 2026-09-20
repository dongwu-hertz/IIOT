<script setup lang="ts">
/**
 * GIS 第三行「实时监测 / Live Monitor」外壳（规格 §1–§4、§26–§37）。
 *
 * 一个 Shell 承载五套模板。这里只做四件事：
 *   - Header（设备名 / 类型 / 状态 / 位置 / 最近更新 / LIVE 或 EVENT）
 *   - 模板选择（由 `resolveRealtimeProfile()` 得到，不按型号写分支）
 *   - 面板高度（Default 312 / Collapsed 56 / Expanded 480 / 拖拽上限 55vh）
 *   - 底部动作（按能力隐藏，不显示 Disabled）
 *
 * 实时数据来自 `useRealtimeMonitorFeed()`；离线、Stale、NoData 的视觉规矩：
 *   - Offline：保留最后值，轻灰覆盖并写"最后通信"（§34，不把值变成 0）
 *   - Stale：Header 出 DATA DELAY，数字变灰（§31）
 *   - NoData：显示 `—` 与空态说明（§35）
 *   - 首次切换：Header 立即换，数据区用 Skeleton（§33）
 */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AlarmEvent, Device } from '@shared/domain/models'
import type { AcousticCameraViewMode, RealtimeActionId, RealtimeTabId } from '@shared/domain/realtime-monitor'
import {
  realtimeActions,
  realtimeHeaderStatus,
  realtimeHeaderStatusKey,
  realtimeMetricLabelKey,
  realtimeTemplate
} from '@shared/domain/realtime-monitor'
import { useRealtimeMonitorStore } from '@renderer/stores/realtimeMonitor'
import { useRealtimeMonitorFeed } from '@renderer/composables/useRealtimeMonitorFeed'
import { EMPTY_VALUE, formatClock, formatDateTime, formatNumber } from '@renderer/lib/format'
import EmptyState from '@renderer/components/EmptyState.vue'
import AcousticCameraTemplate from './AcousticCameraTemplate.vue'
import AirSonarTemplate from './AirSonarTemplate.vue'
import GasLeakTemplate from './GasLeakTemplate.vue'
import VoiceprintTemplate from './VoiceprintTemplate.vue'

const props = withDefaults(
  defineProps<{
    device?: Device
    /** 当前设备最近 20 条告警，按时间倒序；用于 last-known 与 Event 模式。 */
    alarms?: AlarmEvent[]
    /** 未确认告警条数；-1 = 没读到。 */
    pendingAlarms?: number
  }>(),
  { alarms: () => [], pendingAlarms: -1 }
)

const emit = defineEmits<{
  (event: 'action', action: RealtimeActionId): void
  (event: 'returnToLive'): void
}>()

const { t } = useI18n()
const store = useRealtimeMonitorStore()

const deviceRef = computed(() => props.device)
const alarmsRef = computed(() => props.alarms)
const pendingRef = computed(() => props.pendingAlarms)
const feed = useRealtimeMonitorFeed({
  device: deviceRef,
  alarms: alarmsRef,
  pendingAlarms: pendingRef
})

const {
  profile,
  frame,
  starting,
  error,
  selectedChannel,
  selectChannel,
  featureHistory,
  spectrumMagnitudes,
  spectrumBinHz
} = feed

const templateTabs = computed(() => (profile.value ? realtimeTemplate(profile.value.template).tabs : []))
const activeTab = computed<RealtimeTabId>(() => {
  const stored = store.activeTab
  if (stored && templateTabs.value.includes(stored)) return stored
  const current = profile.value
  if (!current) return 'trend'
  return realtimeTemplate(current.template).defaultTab ?? templateTabs.value[0] ?? 'trend'
})

const actions = computed(() => (profile.value ? realtimeActions(profile.value) : []))

const headerStatus = computed(() =>
  realtimeHeaderStatus({
    deviceStatus: props.device?.status ?? 'UNKNOWN',
    severity: frame.value?.status.severity ?? 'normal',
    hasData: frame.value !== null && frame.value.quality !== 'nodata' && frame.value.quality !== 'invalid',
    quality: frame.value?.quality ?? 'nodata'
  })
)

const headerStatusText = computed(() => t(realtimeHeaderStatusKey(headerStatus.value)))

const typeLine = computed(() => {
  if (!profile.value) return ''
  const template = t(`realtimeUi.template.${profile.value.template}`)
  return template
})

const locationText = computed(() => {
  const installation = props.device?.installation
  if (
    !installation ||
    installation.gisLatitude === undefined ||
    installation.gisLongitude === undefined
  ) {
    return t('installUi.unset')
  }
  return `${installation.gisLatitude.toFixed(5)}, ${installation.gisLongitude.toFixed(5)}`
})

/**
 * Header 的 Last Update。
 *
 * **没有数据时显示 `—`，不显示"刚刚"**：声相机 V1 的几个实时字段是 nodata，
 * 这时 frame.timestamp 只是"这一帧组装出来的时刻"，把它写成更新时刻等于说设备
 * 刚刚报过数。只有 good / stale 才有真实时间戳可显示（stale 显示最后那一帧的时刻，
 * 这正是操作员需要的"停了多久"的参照）。
 */
const lastUpdateText = computed(() => {
  const current = frame.value
  if (!current) return EMPTY_VALUE
  if (current.quality === 'nodata' || current.quality === 'invalid') return EMPTY_VALUE
  return formatClock(current.timestamp)
})

const eventTimeText = computed(() =>
  frame.value?.event ? formatDateTime(frame.value.event.at) : ''
)

const isEventMode = computed(() => store.monitorMode === 'event')

/** 离线覆盖上的最后有效值（优先主 KPI，其次 Detail）。 */
const lastKnownText = computed(() => {
  const candidates = [...(frame.value?.primaryMetrics ?? []), ...(frame.value?.details ?? [])]
  const metric = candidates.find((entry) => entry.value !== null && entry.value !== undefined)
  if (!metric || !frame.value) return EMPTY_VALUE
  const label = t(realtimeMetricLabelKey(metric.key))
  const value =
    typeof metric.value === 'number'
      ? formatNumber(metric.value, metric.precision)
      : String(metric.value)
  return `${label} ${value}${metric.unit ? ` ${metric.unit}` : ''}`
})

// ---------------------------------------------------------------------------
// 面板高度：Default 312 / Collapsed 56 / Expanded 480 / 拖拽上限 55vh
// ---------------------------------------------------------------------------

const DEFAULT_HEIGHT = 312
const COLLAPSED_HEIGHT = 56
const EXPANDED_HEIGHT = 480

const height = ref(DEFAULT_HEIGHT)
const resizing = ref(false)
let startY = 0
let startHeight = DEFAULT_HEIGHT

const collapsed = computed(() => height.value <= COLLAPSED_HEIGHT + 2)

function maxPanelHeight(): number {
  if (typeof window === 'undefined') return EXPANDED_HEIGHT
  return Math.max(COLLAPSED_HEIGHT + 40, Math.round(window.innerHeight * 0.55))
}

function onResizeMove(event: PointerEvent): void {
  const next = startHeight - (event.clientY - startY)
  height.value = Math.min(maxPanelHeight(), Math.max(COLLAPSED_HEIGHT, next))
}

function stopResize(): void {
  if (!resizing.value) return
  resizing.value = false
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', stopResize)
  window.removeEventListener('pointercancel', stopResize)
}

function onResizePointerDown(event: PointerEvent): void {
  if (collapsed.value) return
  resizing.value = true
  startY = event.clientY
  startHeight = height.value
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', stopResize)
  window.addEventListener('pointercancel', stopResize)
  event.preventDefault()
}

function toggleCollapse(): void {
  height.value = collapsed.value ? DEFAULT_HEIGHT : COLLAPSED_HEIGHT
}

function toggleExpand(): void {
  height.value =
    height.value >= EXPANDED_HEIGHT - 2 ? DEFAULT_HEIGHT : Math.min(EXPANDED_HEIGHT, maxPanelHeight())
}

function setCameraMode(mode: AcousticCameraViewMode): void {
  store.setCameraMode(mode)
}

onMounted(() => {
  // STALE / DATA DELAY 需要时间往前走（规格 §31）：只在工作台挂载期间走时。
  store.startClock()
})

onBeforeUnmount(() => {
  stopResize()
  store.stopClock()
})
</script>

<template>
  <section
    class="card rt"
    :class="{ 'rt--collapsed': collapsed, 'rt--resizing': resizing }"
    data-map-live
    data-realtime-monitor
    :style="{ height: `${height}px` }"
  >
    <div
      v-if="device && profile"
      class="rt__resize"
      role="separator"
      aria-orientation="horizontal"
      :aria-label="t('realtimeUi.resize')"
      data-realtime-resize
      @pointerdown="onResizePointerDown"
    ></div>

    <EmptyState
      v-if="!device"
      :title="t('realtimeUi.selectDeviceTitle')"
      :description="t('realtimeUi.selectDeviceHint')"
    />

    <EmptyState
      v-else-if="!profile"
      :title="t('realtimeUi.unsupportedTitle')"
      :description="t('realtimeUi.unsupportedHint')"
    >
      <button type="button" class="btn btn--sm" @click="emit('action', 'liveView')">
        {{ t('realtimeUi.openMonitor') }}
      </button>
    </EmptyState>

    <template v-else>
      <header class="rt__header">
        <div class="rt__identity">
          <p class="rt__eyebrow">{{ t('realtimeUi.title') }}</p>
          <div class="rt__title-row">
            <h3 class="rt__name">{{ device.name }}</h3>
            <span
              class="rt__status"
              :class="`rt__status--${headerStatus}`"
              data-realtime-status
            >
              <span class="rt__status-dot" aria-hidden="true"></span>{{ headerStatusText }}
            </span>
            <span
              v-if="!isEventMode && headerStatus !== 'offline'"
              class="rt__mode rt__mode--live"
              data-realtime-mode="live"
            >● LIVE</span>
            <span
              v-else-if="isEventMode"
              class="rt__mode rt__mode--event"
              data-realtime-mode="event"
            >EVENT · {{ eventTimeText }}</span>
            <button
              v-if="isEventMode"
              type="button"
              class="btn btn--sm"
              data-realtime-return-live
              @click="emit('returnToLive')"
            >
              {{ t('realtimeUi.returnToLive') }}
            </button>
          </div>
          <p class="rt__meta">
            <span>{{ typeLine }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ t('realtimeUi.location') }}: {{ locationText }}</span>
            <span aria-hidden="true">·</span>
            <span data-realtime-updated>{{ t('realtimeUi.updatedAt', { time: lastUpdateText }) }}</span>
            <span v-if="frame?.quality === 'stale'" class="rt__delay">
              {{ t('realtimeUi.dataDelay') }}
            </span>
          </p>
        </div>
        <div class="rt__header-actions">
          <button
            type="button"
            class="btn btn--sm"
            :title="collapsed ? t('realtimeUi.expand') : t('realtimeUi.collapse')"
            data-realtime-collapse
            @click="toggleCollapse"
          >
            {{ collapsed ? '▴' : '▾' }}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            :title="t('realtimeUi.expand')"
            data-realtime-expand
            @click="toggleExpand"
          >
            ⤢
          </button>
        </div>
      </header>

      <div v-if="!collapsed" class="rt__body" data-realtime-body>
        <p v-if="error" class="alert alert--warning rt__error" role="alert">{{ error }}</p>
        <div
          v-if="starting && (!frame || frame.quality === 'nodata')"
          class="rt__skeleton"
          data-realtime-skeleton
        >
          <span v-for="index in 3" :key="index" class="rt__skeleton-col"></span>
        </div>

        <template v-else-if="frame">
          <VoiceprintTemplate
            v-if="profile.template === 'voiceprint'"
            :frame="frame"
            :feature-history="featureHistory"
            :spectrum-magnitudes="spectrumMagnitudes"
            :spectrum-bin-hz="spectrumBinHz"

            :selected-channel="selectedChannel"
            :active-tab="activeTab"
            :now="store.now"
            @select-channel="selectChannel"
            @set-tab="store.setActiveTab"
          />

          <AcousticCameraTemplate
            v-else-if="profile.template === 'acousticCameraPD' || profile.template === 'acousticCameraLeak'"
            :frame="frame"
            :device-id="device.id"
            :active-tab="activeTab"
            :camera-mode="store.cameraMode"
            @set-tab="store.setActiveTab"
            @set-camera-mode="setCameraMode"
          />

          <AirSonarTemplate
            v-else-if="profile.template === 'airSonar'"
            :frame="frame"
          />

          <GasLeakTemplate v-else :frame="frame" />

          <div v-if="!frame.status.online" class="rt__offline" data-realtime-offline>
            <p class="rt__offline-title">{{ t('realtimeUi.offline') }}</p>
            <p class="rt__offline-line">
              {{ t('realtimeUi.lastCommunication', { time: lastUpdateText }) }}
            </p>
            <p class="rt__offline-line">
              {{ t('realtimeUi.lastKnownValue', { value: lastKnownText }) }}
            </p>
          </div>
        </template>

        <EmptyState
          v-else
          :title="t('realtimeUi.noDataTitle')"
          :description="t('realtimeUi.noDataHint')"
        />
      </div>

      <footer v-if="!collapsed" class="rt__actions" data-realtime-actions>
        <button
          v-for="action in actions"
          :key="action"
          type="button"
          class="btn btn--sm"
          :class="{ 'btn--primary': action === 'liveView' }"
          :data-realtime-action="action"
          @click="emit('action', action)"
        >
          {{ t(`realtimeUi.actions.${action}`) }}
        </button>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.rt {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 0;
  overflow: hidden;
  transition: height 160ms ease;
}

.rt--resizing {
  transition: none;
  user-select: none;
}

/* 顶部拖拽边界（Collapsed / Default / Expanded / 55vh）。 */
.rt__resize {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 6px;
  transform: translateY(-3px);
  cursor: row-resize;
  z-index: 6;
}

.rt__resize:hover {
  background: var(--color-accent-border);
}

.rt__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 8px var(--space-4);
  min-height: 52px;
}

.rt__identity {
  min-width: 0;
}

.rt__eyebrow {
  margin: 0 0 2px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--color-text-tertiary);
}

.rt__title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.rt__name {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}

.rt__status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.rt__status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-text-disabled);
}

.rt__status--live {
  color: var(--color-success);
}

.rt__status--live .rt__status-dot {
  background: var(--color-success);
}

.rt__status--warning {
  color: var(--color-severity-medium);
}

.rt__status--warning .rt__status-dot {
  background: var(--color-severity-medium);
}

.rt__status--alarm {
  color: var(--color-danger);
}

.rt__status--alarm .rt__status-dot {
  background: var(--color-danger);
}

.rt__status--offline,
.rt__status--dataDelay {
  color: var(--color-text-tertiary);
}

.rt__status--offline .rt__status-dot {
  background: transparent;
  border: 1.5px solid var(--color-text-disabled);
}

.rt__status--dataDelay .rt__status-dot {
  background: var(--color-text-disabled);
}

.rt__mode {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.rt__mode--live {
  color: var(--color-success);
}

.rt__mode--event {
  color: var(--color-severity-medium);
}

.rt__meta {
  margin: 3px 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px var(--space-2);
  font-size: 11.5px;
  color: var(--color-text-tertiary);
}

.rt__delay {
  color: var(--color-severity-medium);
  font-weight: 600;
}

.rt__header-actions {
  display: flex;
  gap: 4px;
  flex: none;
}

.rt__error {
  margin: 0 0 var(--space-2);
}

.rt__body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 0 var(--space-4) var(--space-3);
}

.rt__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-height: 40px;
  padding: 4px var(--space-4);
  border-top: 1px solid var(--color-border);
}

/* 首次切换：Header 立即换，数据区先占位（规格 §33）。 */
.rt__skeleton {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr) 280px;
  gap: var(--space-4);
  padding-top: var(--space-3);
}

.rt__skeleton-col {
  height: 180px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-muted);
  animation: rt-pulse 1.4s ease-in-out infinite;
}

@keyframes rt-pulse {
  0%,
  100% {
    opacity: 0.55;
  }
  50% {
    opacity: 1;
  }
}

/* 离线：轻灰覆盖 + 最后通信/最后有效值；不把值变成 0（规格 §34）。 */
.rt__offline {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: rgba(255, 255, 255, 0.78);
  background: color-mix(in srgb, var(--color-bg) 78%, transparent);
  pointer-events: none;
}

.rt__offline-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.rt__offline-line {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-tertiary);
}

/* 折叠后只剩 Header（56px）：隐去 eyebrow 与 meta，保留设备名 / 状态 / 操作。 */
.rt--collapsed .rt__header {
  min-height: 56px;
  align-items: center;
  padding-block: 4px;
}

.rt--collapsed .rt__eyebrow,
.rt--collapsed .rt__meta {
  display: none;
}
</style>