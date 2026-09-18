<script setup lang="ts">
/**
 * 左侧筛选面板（规格 §9.4 / §10.2）。
 *
 * 四组：严重等级 / 来源 / 确认状态 / 设备，每组带**计数**。
 *
 * ---------------------------------------------------------------------------
 * 计数是**已加载的那一页**的计数（这一点必须一直写在面板上）
 * ---------------------------------------------------------------------------
 * 主进程的等级过滤是**按来源整路跳过**的（`event-center-service.ts`：
 * `input.severity !== deriveEventSeverity(source)` 直接返回空），所以"整个筛选结果"
 * 的等级分布在主进程里根本没被算过。面板因此不假装自己有全量分布：页脚写着
 * 「计数按已加载的 N 条」（`panelScope`）。
 *
 * 计数为 0 的选项**照样可点**：换一台设备可能就有数据了 —— 它们是筛选，不是统计。
 *
 * 组件是纯受控的：自己不查、不改，只把点击变成一次 `patch` 交给页面。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Device } from '@shared/domain/models'
import {
  VISIBLE_ALERT_SEVERITIES,
  alertSeverityLabelKey
} from '@shared/domain/event-view'
import type {
  AckFilter,
  EventFilterCounts,
  EventQueueFilter,
  EventSeverityFilter
} from '@shared/domain/event-view'
import { EVENT_SOURCE_KINDS } from '@shared/domain/event-center'
import type { EventSourceKind } from '@shared/domain/event-center'
import { eventSourceLabel } from '@renderer/lib/labels'

const props = defineProps<{
  filter: EventQueueFilter
  counts: EventFilterCounts
  devices: readonly Device[]
  loaded: number
}>()

const emit = defineEmits<{
  (event: 'patch', patch: Partial<EventQueueFilter>): void
}>()

const { t } = useI18n()

interface Option {
  value: string
  label: string
  count: number
}

/**
 * 严重等级这一组的选项。
 *
 * 只有**真的会出现**的等级（`VISIBLE_ALERT_SEVERITIES`：严重 / 高 / 提示）加一个
 * 「等级未知」。规格的五级里 `medium` / `low` 当前没有任何代码路径能产生，所以不做成
 * 选项 —— 一个永远搜不到东西的筛选项比没有更糟。
 */
const severityOptions = computed<Option[]>(() => {
  const options: Option[] = VISIBLE_ALERT_SEVERITIES.map((severity) => ({
    value: severity,
    label: t(alertSeverityLabelKey(severity)),
    count: props.counts.bySeverity[severity]
  }))
  options.push({
    value: 'unknown',
    label: t('eventsUi.severityUnknown'),
    count: props.counts.unknownSeverity
  })
  return options
})

const sourceOptions = computed<Option[]>(() =>
  EVENT_SOURCE_KINDS.map((source) => ({
    value: source,
    label: eventSourceLabel(source),
    count: props.counts.bySource[source]
  }))
)

const ackOptions = computed<Option[]>(() => [
  {
    value: 'unacknowledged',
    label: t('eventsUi.ackUnacknowledged'),
    count: props.counts.unacknowledged
  },
  {
    value: 'acknowledged',
    label: t('eventsUi.ackAcknowledged'),
    count: props.counts.acknowledged
  }
])

function patchSeverity(value: string): void {
  emit('patch', { severity: props.filter.severity === value ? '' : (value as EventSeverityFilter) })
}

function patchSource(value: string): void {
  emit('patch', { source: props.filter.source === value ? '' : (value as EventSourceKind) })
}

function patchAck(value: string): void {
  emit('patch', { ack: props.filter.ack === value ? 'all' : (value as AckFilter) })
}

function patchDevice(value: string): void {
  emit('patch', { deviceId: props.filter.deviceId === value ? '' : value })
}
</script>

<template>
  <aside class="filter-panel" :aria-label="t('eventsUi.filterPanelTitle')">
    <h3 class="section-title filter-panel__title">{{ t('eventsUi.filterPanelTitle') }}</h3>

    <div class="filter-panel__group">
      <span class="field-label">{{ t('eventsUi.filterSeverity') }}</span>
      <button
        type="button"
        class="filter-panel__option"
        :class="{ 'filter-panel__option--active': filter.severity === '' }"
        @click="emit('patch', { severity: '' })"
      >
        <span>{{ t('eventsUi.filterAllSeverities') }}</span>
      </button>
      <button
        v-for="option in severityOptions"
        :key="option.value"
        type="button"
        class="filter-panel__option"
        :class="{ 'filter-panel__option--active': filter.severity === option.value }"
        @click="patchSeverity(option.value)"
      >
        <span>{{ option.label }}</span>
        <span class="filter-panel__count">{{ t('eventsUi.panelCount', { count: option.count }) }}</span>
      </button>
    </div>

    <div class="filter-panel__group">
      <span class="field-label">{{ t('eventsUi.filterSource') }}</span>
      <button
        type="button"
        class="filter-panel__option"
        :class="{ 'filter-panel__option--active': filter.source === '' }"
        @click="emit('patch', { source: '' })"
      >
        <span>{{ t('eventsUi.filterAllSources') }}</span>
      </button>
      <button
        v-for="option in sourceOptions"
        :key="option.value"
        type="button"
        class="filter-panel__option"
        :class="{ 'filter-panel__option--active': filter.source === option.value }"
        @click="patchSource(option.value)"
      >
        <span>{{ option.label }}</span>
        <span class="filter-panel__count">{{ t('eventsUi.panelCount', { count: option.count }) }}</span>
      </button>
    </div>

    <div class="filter-panel__group">
      <span class="field-label">{{ t('eventsUi.filterAck') }}</span>
      <button
        type="button"
        class="filter-panel__option"
        :class="{ 'filter-panel__option--active': filter.ack === 'all' }"
        @click="emit('patch', { ack: 'all' })"
      >
        <span>{{ t('eventsUi.ackAll') }}</span>
      </button>
      <button
        v-for="option in ackOptions"
        :key="option.value"
        type="button"
        class="filter-panel__option"
        :class="{ 'filter-panel__option--active': filter.ack === option.value }"
        @click="patchAck(option.value)"
      >
        <span>{{ option.label }}</span>
        <span class="filter-panel__count">{{ t('eventsUi.panelCount', { count: option.count }) }}</span>
      </button>
    </div>

    <div v-if="devices.length > 0" class="filter-panel__group">
      <span class="field-label">{{ t('eventsUi.filterDevice') }}</span>
      <button
        type="button"
        class="filter-panel__option"
        :class="{ 'filter-panel__option--active': filter.deviceId === '' }"
        @click="emit('patch', { deviceId: '' })"
      >
        <span>{{ t('eventsUi.filterAllDevices') }}</span>
      </button>
      <button
        v-for="device in devices"
        :key="device.id"
        type="button"
        class="filter-panel__option"
        :class="{ 'filter-panel__option--active': filter.deviceId === device.id }"
        @click="patchDevice(device.id)"
      >
        <span class="filter-panel__device">{{ device.name }}</span>
        <span class="filter-panel__count">
          {{ t('eventsUi.panelCount', { count: counts.byDevice[device.id] ?? 0 }) }}
        </span>
      </button>
    </div>

    <p class="filter-panel__scope muted">{{ t('eventsUi.panelScope', { loaded }) }}</p>
  </aside>
</template>

<style scoped>
.filter-panel {
  width: var(--filter-panel);
  flex: 0 0 var(--filter-panel);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  background: var(--color-bg);
  align-self: start;
}

.filter-panel__title {
  margin: 0;
  font-size: var(--font-size-panel);
}

.filter-panel__group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.filter-panel__option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: var(--control-height-sm);
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--font-size-small);
  text-align: left;
  cursor: pointer;
}

.filter-panel__option:hover {
  background: var(--color-bg-hover);
}

.filter-panel__option--active {
  background: var(--color-accent-light);
  color: var(--color-accent-strong);
  font-weight: 600;
}

.filter-panel__option:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.filter-panel__count {
  color: var(--color-text-tertiary);
  font-size: var(--font-size-meta);
  font-variant-numeric: tabular-nums;
}

.filter-panel__option--active .filter-panel__count {
  color: var(--color-accent-strong);
}

.filter-panel__device {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.filter-panel__scope {
  margin: 0;
  font-size: var(--font-size-meta);
}
</style>
