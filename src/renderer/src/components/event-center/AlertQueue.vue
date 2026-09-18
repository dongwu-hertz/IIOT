<script setup lang="ts">
/**
 * 告警队列（规格 §10）。
 *
 * 三种视图模式共用同一份数据，只改每行画多少东西：
 *   - **Compact**：一行看完 —— 时间 / 事件 / 设备（56px，规格没给数值的那一档）；
 *   - **Standard**：加等级、来源、状态与前三个指标（88px，规格的下限）；
 *   - **Evidence**：再加证据清单（录像 / 抓帧 / 结果文件数）与最多五个指标（104px）。
 *
 * Evidence 模式**没有缩略图**：联动抓帧在我们这儿只有一条存储根相对路径
 * （`frameRelativePath`），把它变成图片需要一个新的回环图片接口，那是 Phase 4 证据页
 * 的事。这一版画的是"这条事件有哪些证据"，而不是"证据长什么样"。
 *
 * 键盘：整行是 `<button>`（可 Tab、Enter/空格打开），↑/↓ 在行间移动并同步焦点。
 * 这不是装饰 —— 一次告警风暴里操作员是连着按 ↓ 逐条看的。
 */
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import EmptyState from '@renderer/components/EmptyState.vue'
import {
  EVENT_ROW_HEIGHT,
  alertSeverityLabelKey,
  alertStatusLabelKey
} from '@shared/domain/event-view'
import type { AlertViewModel, EventViewMode } from '@shared/domain/event-view'
import { eventKindLabel, eventSourceLabel } from '@renderer/lib/labels'
import { formatDateTime, formatNumber } from '@renderer/lib/format'

const props = defineProps<{
  alerts: readonly AlertViewModel[]
  selectedId: string | null
  viewMode: EventViewMode
  /** 空态文案由调用方决定：区分「设备什么都没报」与「筛选把数据排除了」。 */
  emptyTitle: string
}>()

const emit = defineEmits<{
  (event: 'select', alert: AlertViewModel): void
}>()

const { t } = useI18n()

const listRef = ref<HTMLElement | null>(null)

/** 每种模式显示几个指标（Compact 一个都不显示，只留一行正文）。 */
const METRIC_LIMIT: Readonly<Record<EventViewMode, number>> = {
  compact: 0,
  standard: 3,
  evidence: 5
}

const rowHeight = computed(() => EVENT_ROW_HEIGHT[props.viewMode])
const metricLimit = computed(() => METRIC_LIMIT[props.viewMode])

/** 等级标签：「等级未知」是一个独立说法，不许印成「提示」。 */
function severityLabel(alert: AlertViewModel): string {
  return alert.severityUnknown
    ? t('eventsUi.severityUnknown')
    : t(alertSeverityLabelKey(alert.severity))
}

/** 行的严重度类：未知走中性的 `severity--unknown`，不是任何一档等级色。 */
function severityClass(alert: AlertViewModel): string {
  return alert.severityUnknown ? 'severity--unknown' : `severity--${alert.severity}`
}

function visibleMetrics(alert: AlertViewModel): AlertViewModel['metrics'] {
  return alert.metrics.slice(0, metricLimit.value)
}

function hiddenMetricCount(alert: AlertViewModel): number {
  return Math.max(0, alert.metrics.length - metricLimit.value)
}

/** 状态标签：没有确认能力的来源显示「—」，而不是一个谁也点不掉的"待处理"。 */
function statusText(alert: AlertViewModel): string {
  if (alert.statusLocked) return '—'
  return t(alertStatusLabelKey(alert.status))
}

function move(delta: number): void {
  const list = props.alerts
  if (list.length === 0) return
  const current = list.findIndex((alert) => alert.id === props.selectedId)
  const next =
    current < 0
      ? delta > 0
        ? 0
        : list.length - 1
      : Math.min(list.length - 1, Math.max(0, current + delta))
  const alert = list[next]
  if (!alert) return
  emit('select', alert)
  // 焦点跟着选中行走：否则视觉选中动了、键盘焦点还在原处，下一条 Enter 会打开错的那条。
  void nextTick(() => {
    const buttons = listRef.value?.querySelectorAll<HTMLButtonElement>('.alert-row')
    buttons?.[next]?.focus()
  })
}
</script>

<template>
  <div
    ref="listRef"
    class="alert-queue"
    tabindex="-1"
    @keydown.down.prevent="move(1)"
    @keydown.up.prevent="move(-1)"
  >
    <EmptyState v-if="alerts.length === 0" :title="emptyTitle" />

    <button
      v-for="alert in alerts"
      :key="alert.id"
      type="button"
      class="alert-row"
      :class="[severityClass(alert), { 'alert-row--active': alert.id === selectedId }]"
      :style="{ '--event-row-mode-height': `${rowHeight}px` }"
      :aria-current="alert.id === selectedId ? 'true' : undefined"
      @click="emit('select', alert)"
    >
      <span class="alert-row__head">
        <!--
          等级文字**每一档都印**（含紧凑模式）：左侧色条是颜色，而颜色不能是唯一的信息
          —— 规格 §15.3 明确要求"不靠颜色单独表意"。所以紧凑模式下这一行也带着「严重 / 高 /
          提示 / 等级未知」四个字里最合适的那个。
        -->
        <span class="alert-row__severity">{{ severityLabel(alert) }}</span>
        <span class="alert-row__time">
          {{ formatDateTime(alert.at) }}
          <span v-if="alert.atApproximate" class="chip chip--tiny">
            {{ t('eventsUi.approximateBadge') }}
          </span>
        </span>
        <span class="alert-row__title">{{ eventKindLabel(alert.kind) }}</span>
        <span class="alert-row__device">{{ alert.deviceName }}</span>
      </span>

      <span v-if="viewMode !== 'compact'" class="alert-row__meta">
        <span class="muted">{{ eventSourceLabel(alert.source) }}</span>
        <span class="muted">{{ statusText(alert) }}</span>
        <span
          v-for="metric in visibleMetrics(alert)"
          :key="metric.field"
          class="chip chip--tiny"
        >
          {{ t(metric.labelKey) }}
          {{ formatNumber(metric.value, metric.digits) }}{{ metric.unit }}
        </span>
        <span v-if="hiddenMetricCount(alert) > 0" class="chip chip--tiny">
          {{ t('eventsUi.metricMore', { count: hiddenMetricCount(alert) }) }}
        </span>
        <template v-if="viewMode === 'evidence'">
          <span v-if="alert.hasRecording" class="chip chip--tiny">
            {{ t('eventsUi.evidenceRecording') }}
          </span>
          <span v-if="alert.hasFrame" class="chip chip--tiny">
            {{ t('eventsUi.evidenceFrame') }}
          </span>
          <span v-if="alert.evidenceFileCount > 0" class="chip chip--tiny">
            {{ t('eventsUi.evidenceFiles', { count: alert.evidenceFileCount }) }}
          </span>
        </template>
      </span>
    </button>
  </div>
</template>

<style scoped>
.alert-queue {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  background: var(--color-bg);
  overflow: hidden;
}

.alert-row__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.alert-row__time {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
  font-size: var(--font-size-meta);
  font-variant-numeric: tabular-nums;
}

.alert-row__title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--font-size-card);
  font-weight: 600;
  color: var(--color-text);
  overflow-wrap: anywhere;
}

.alert-row__device {
  flex: 0 1 auto;
  color: var(--color-text-secondary);
  font-size: var(--font-size-small);
}

.alert-row__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
  font-size: var(--font-size-meta);
}

.alert-row__severity {
  font-size: var(--font-size-meta);
  font-weight: 600;
  color: var(--severity-accent, var(--color-text-secondary));
}
</style>
