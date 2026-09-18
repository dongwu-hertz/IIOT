<script setup lang="ts">
/**
 * KPI 条（规格 §8）。
 *
 * 四格：严重 / 高 / 未确认 / 平均确认耗时。规格还列了「Incidents（聚合事件）」，
 * 那是 Phase 6 的事（§18.1），所以这一格**不渲染** —— 一个恒为 0 的格子会被读成
 * 「聚合了，结果是 0 条」，而事实是我们还没做聚合。
 *
 * 两个诚实的细节，别"优化"掉：
 *   1. **平均确认耗时恒为「—」**。三路来源都没有把确认时刻带进事件模型
 *      （`EventCenterEntry` 只有 `acknowledged: boolean`），算不出耗时。`MetricCard`
 *      对 `null` 显示「—」，显示 0 会被读成"确认得飞快"。
 *   2. **作用域印在下面一行**（`kpiScope`）。数字算的是**已加载的那一页**，
 *      不是全库 —— 主进程的等级过滤是按来源整路跳过的，拿不到全量等级分布。
 *
 * 严重/高/未确认三格可点（点一下把对应筛选打开/关掉）；平均确认耗时不可点 ——
 * 它没有对应的筛选，做成按钮就是画一个按不动的控件。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import MetricCard from '@renderer/components/MetricCard.vue'
import type { AckFilter, EventKpis, EventSeverityFilter } from '@shared/domain/event-view'

const props = defineProps<{
  kpis: EventKpis
  loaded: number
  total: number
  severity: EventSeverityFilter
  ack: AckFilter
}>()

const emit = defineEmits<{
  (event: 'filter', patch: { severity?: EventSeverityFilter; ack?: AckFilter }): void
}>()

const { t } = useI18n()

/** 点已选中的那一格 = 取消这个筛选（与筛选面板里的点击行为一致）。 */
function toggleSeverity(severity: Exclude<EventSeverityFilter, ''>): void {
  emit('filter', { severity: props.severity === severity ? '' : severity })
}

function toggleAck(ack: Exclude<AckFilter, 'all'>): void {
  emit('filter', { ack: props.ack === ack ? 'all' : ack })
}

const avgAckSeconds = computed(() =>
  props.kpis.avgAckMs === null ? null : props.kpis.avgAckMs / 1000
)

const scope = computed(() =>
  t('eventsUi.kpiScope', { loaded: props.loaded, total: props.total })
)
</script>

<template>
  <section class="kpi-strip">
    <button
      type="button"
      class="kpi-strip__tile severity--critical"
      :class="{ 'kpi-strip__tile--active': severity === 'critical' }"
      :aria-pressed="severity === 'critical'"
      @click="toggleSeverity('critical')"
    >
      <MetricCard :label="t('eventsUi.alertSeverity.critical')" :value="kpis.critical" />
    </button>

    <button
      type="button"
      class="kpi-strip__tile severity--high"
      :class="{ 'kpi-strip__tile--active': severity === 'high' }"
      :aria-pressed="severity === 'high'"
      @click="toggleSeverity('high')"
    >
      <MetricCard :label="t('eventsUi.alertSeverity.high')" :value="kpis.high" />
    </button>

    <button
      type="button"
      class="kpi-strip__tile"
      :class="{ 'kpi-strip__tile--active': ack === 'unacknowledged' }"
      :aria-pressed="ack === 'unacknowledged'"
      @click="toggleAck('unacknowledged')"
    >
      <MetricCard :label="t('eventsUi.kpiUnacknowledged')" :value="kpis.unacknowledged" />
    </button>

    <div class="kpi-strip__tile kpi-strip__tile--static">
      <MetricCard
        :label="t('eventsUi.kpiAvgAck')"
        :value="avgAckSeconds"
        unit="s"
        :precision="1"
      />
    </div>

    <p class="kpi-strip__scope muted">{{ scope }}</p>
  </section>
</template>

<style scoped>
.kpi-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  background: var(--color-bg);
}

.kpi-strip__tile {
  flex: 1 1 140px;
  min-width: 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  /* 左侧 4px 色条：与队列行同一套严重度 token（`.severity--*` 在 main.css 里）。 */
  border-left: 4px solid var(--severity-accent, var(--color-border-strong));
  border-radius: var(--radius-sm);
  background: var(--severity-soft, var(--color-bg));
  color: inherit;
  font: inherit;
  text-align: left;
}

button.kpi-strip__tile {
  cursor: pointer;
}

button.kpi-strip__tile:hover {
  border-color: var(--color-border-strong);
}

button.kpi-strip__tile:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.kpi-strip__tile--active {
  border-color: var(--color-accent);
  background: var(--color-accent-light);
}

.kpi-strip__tile--static {
  cursor: default;
}

.kpi-strip__scope {
  flex: 1 1 100%;
  margin: 0;
  font-size: var(--font-size-meta);
}
</style>
