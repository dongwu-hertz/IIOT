<script setup lang="ts">
/**
 * 告警队列（业主 20260921 批：表格行 + 行内展开详情）。
 *
 * 每行默认只显示四列：**时间 | 级别 | 事件名称 | 状态**；最左一列勾选（给筛选卡的
 * 「确认所选」批量确认用），最右一个展开钮。点**时间**（或展开钮）在行内展开三列
 * 小卡（事件名称 / 对应设备 / 设备状态），再点一下收起 —— 那块详情是「看一眼」
 * 用的；完整处置（确认 / 指派 / 下载 / 关联 Incident）仍走详情抽屉：点行（勾选、
 * 时间与展开钮除外）打开它。
 *
 * 「设备状态」那一格：设备状态事件（上线 / 离线）说**它自己那一次翻转**；设备告警
 * 类说**这台设备此刻**的在线 / 离线态（行内 deviceId → 设备表，本机已有字段，
 * 不问设备）。
 *
 * 键盘：↑/↓ 在行间接力选中并同步焦点 —— 一次告警风暴里操作员是连着按的。
 */
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import EmptyState from '@renderer/components/EmptyState.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'
import { alertSeverityLabelKey, alertStatusLabelKey } from '@shared/domain/event-view'
import type { AlertViewModel } from '@shared/domain/event-view'
import type { DeviceStatus } from '@shared/domain/models'
import { eventKindLabel } from '@renderer/lib/labels'
import { formatDateTime } from '@renderer/lib/format'

const props = defineProps<{
  alerts: readonly AlertViewModel[]
  /** 详情抽屉当前那一条（队列里的选中高亮）。 */
  selectedId: string | null
  /** 勾选中的行 id（筛选卡「确认所选」批量确认用）。 */
  selectedIds: readonly string[]
  /** 行内展开详情的行 id；`null` = 全部收起。 */
  expandedId: string | null
  /** 空态文案由调用方决定：区分「设备什么都没报」与「筛选把数据排除了」。 */
  emptyTitle: string
  /** 设备当前状态（展开详情的「设备状态」徽标按行内 deviceId 查；查不到 = 未知）。 */
  deviceStatusOf: (deviceId: string) => DeviceStatus | undefined
}>()

const emit = defineEmits<{
  (event: 'select', alert: AlertViewModel): void
  (event: 'toggle-selected', id: string, checked: boolean): void
  (event: 'toggle-expand', alert: AlertViewModel): void
}>()

const { t } = useI18n()

const listRef = ref<HTMLElement | null>(null)

const allSelected = computed(
  () => props.alerts.length > 0 && props.selectedIds.length === props.alerts.length
)

/** 全选 / 全不选：逐行发事件，状态本身由页面持有（一处事实）。 */
function toggleAll(checked: boolean): void {
  for (const alert of props.alerts) {
    emit('toggle-selected', alert.id, checked)
  }
}

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

/** 状态标签：没有确认能力的来源显示「—」，而不是一个谁也点不掉的"待处理"。 */
function statusText(alert: AlertViewModel): string {
  if (alert.statusLocked) return '—'
  return t(alertStatusLabelKey(alert.status))
}

/** 状态徽标：等着人确认的是黄（要动作），已确认是绿，其余（调查中 / 已解决…）中性。 */
function statusBadgeClass(alert: AlertViewModel): string {
  if (alert.statusLocked) return 'badge'
  if (alert.status === 'acknowledged') return 'badge badge--success'
  if (alert.status === 'new') return 'badge badge--warning'
  return 'badge'
}

/**
 * 展开详情里「设备状态」那一格。
 *
 * 设备状态事件（上线 / 离线）取**事件自己**的翻转方向（`kind` 就在行内）；其余事件
 * 取这台设备**此刻**的状态（设备表快照）。查不到就是「未知」，不猜。
 */
function deviceState(alert: AlertViewModel): DeviceStatus {
  if (alert.kind === 'deviceOnline') return 'ONLINE'
  if (alert.kind === 'deviceOffline') return 'OFFLINE'
  return props.deviceStatusOf(alert.deviceId) ?? 'UNKNOWN'
}

/**
 * ↑/↓ 换条（详情抽屉跟着开）。
 *
 * 顺序取**队列当前显示的**那批；换到边界就停在原地（不做环形，环形的"跳回第一条"
 * 会让人以为自己看漏了）。焦点跟着选中行走，否则视觉选中动了、键盘焦点还在原处。
 */
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
  void nextTick(() => {
    const buttons = listRef.value?.querySelectorAll<HTMLButtonElement>('.alert-table__time')
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

    <table v-else class="table alert-table">
      <thead>
        <tr>
          <th class="alert-table__check">
            <input
              type="checkbox"
              :checked="allSelected"
              :aria-label="t('alarmsUi.selectAll')"
              @change="toggleAll(($event.target as HTMLInputElement).checked)"
            />
          </th>
          <th>{{ t('alarmsUi.columnTime') }}</th>
          <th>{{ t('eventsUi.filterSeverity') }}</th>
          <th>{{ t('eventsUi.detailKind') }}</th>
          <th>{{ t('eventsUi.overviewStatus') }}</th>
          <th class="alert-table__expand-head" aria-hidden="true"></th>
        </tr>
      </thead>
      <tbody>
        <template v-for="alert in alerts" :key="alert.id">
          <tr
            class="alert-table__row is-clickable"
            :class="{ 'alert-table__row--active': alert.id === selectedId }"
            :aria-current="alert.id === selectedId ? 'true' : undefined"
            @click="emit('select', alert)"
          >
            <td class="alert-table__check" @click.stop>
              <input
                type="checkbox"
                :checked="selectedIds.includes(alert.id)"
                :aria-label="t('alarmsUi.selectRow', { id: alert.id })"
                @change="
                  emit('toggle-selected', alert.id, ($event.target as HTMLInputElement).checked)
                "
              />
            </td>
            <td class="nowrap">
              <!--
                时间是展开钮：点一下展开 / 收起行内详情（再点画行 = 打开详情抽屉）。
                caret 转 180° 表示展开态，`:aria-expanded` 把状态交给读屏。
              -->
              <button
                type="button"
                class="alert-table__time"
                :aria-expanded="expandedId === alert.id"
                data-action="row-expand"
                @click.stop="emit('toggle-expand', alert)"
              >
                <svg
                  class="alert-table__caret"
                  :class="{ 'alert-table__caret--open': expandedId === alert.id }"
                  width="10"
                  height="10"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  aria-hidden="true"
                >
                  <path d="M4 6l4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                {{ formatDateTime(alert.at) }}
                <span v-if="alert.atApproximate" class="chip chip--tiny">
                  {{ t('eventsUi.approximateBadge') }}
                </span>
              </button>
            </td>
            <td>
              <!--
                等级文字**每一档都印**：徽标里的颜色不能是唯一的信息（规格 §15.3：
                不靠颜色单独表意），所以「严重 / 高 / 提示 / 等级未知」都在。
              -->
              <span class="alert-table__severity" :class="severityClass(alert)">
                {{ severityLabel(alert) }}
              </span>
            </td>
            <td>
              <span class="alert-table__title">{{ eventKindLabel(alert.kind) }}</span>
              <!-- 聚合（规格 §14.1）：同一组触发的次数。等于 1 时**不画** —— "×1" 是噪声。 -->
              <span v-if="alert.occurrenceCount > 1" class="chip chip--tiny">
                {{ t('eventsUi.occurrenceCount', { count: alert.occurrenceCount }) }}
              </span>
            </td>
            <td>
              <span :class="statusBadgeClass(alert)">{{ statusText(alert) }}</span>
            </td>
            <td class="alert-table__expand">
              <button
                type="button"
                class="btn btn--ghost btn--icon alert-table__expand-btn"
                :aria-expanded="expandedId === alert.id"
                :aria-label="t('eventsUi.detailTitle')"
                data-action="row-expand"
                @click.stop="emit('toggle-expand', alert)"
              >
                <svg
                  class="alert-table__caret"
                  :class="{ 'alert-table__caret--open': expandedId === alert.id }"
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  aria-hidden="true"
                >
                  <path d="M4 6l4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </td>
          </tr>

          <!--
            行内详情（业主 20260921 批）：三列小卡 —— 事件名称 / 对应设备 / 设备状态。
            简单 v-if：这块内容一屏只展开一行，不需要过渡动画的重量。
          -->
          <tr v-if="expandedId === alert.id" class="alert-table__detail">
            <td colspan="6">
              <div class="alert-detail">
                <div class="alert-detail__card">
                  <div class="alert-detail__label">{{ t('eventsUi.detailKind') }}</div>
                  <div class="alert-detail__value">{{ eventKindLabel(alert.kind) }}</div>
                </div>
                <div class="alert-detail__card">
                  <div class="alert-detail__label">{{ t('eventsUi.detailDevice') }}</div>
                  <div class="alert-detail__value">{{ alert.deviceName }}</div>
                </div>
                <div class="alert-detail__card">
                  <div class="alert-detail__label">{{ t('domain.eventSource.deviceStatus') }}</div>
                  <div class="alert-detail__value">
                    <StatusBadge :status="deviceState(alert)" />
                  </div>
                </div>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.alert-queue {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  background: var(--color-bg);
  overflow: hidden;
}

.alert-table {
  width: 100%;
}

.alert-table__check {
  width: 34px;
  text-align: center;
}

.alert-table__expand-head {
  width: 36px;
}

.alert-table__expand {
  text-align: center;
}

/* 时间是展开钮：去掉按钮外观，只留 caret + 文本；hover 变深表示可点。 */
.alert-table__time {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text-tertiary);
  font: inherit;
  font-size: var(--font-size-meta);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.alert-table__time:hover {
  color: var(--color-text);
}

.alert-table__caret {
  flex: none;
  transition: transform 0.15s ease;
}

.alert-table__caret--open {
  transform: rotate(180deg);
}

/* 级别徽标：颜色与软底都来自 `.severity--*` 那对变量（main.css token），未知是中性的。 */
.alert-table__severity {
  display: inline-flex;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--severity-soft, var(--color-neutral-soft));
  color: var(--severity-accent, var(--color-text-secondary));
  font-size: 11.5px;
  line-height: 18px;
  white-space: nowrap;
}

.alert-table__title {
  font-weight: 600;
  color: var(--color-text);
}

.alert-table__row--active {
  background: var(--color-accent-soft);
}

/* 展开详情行：浅底把它与正文行分开，三列小卡键值对齐。 */
.alert-table__detail > td {
  background: var(--color-bg-subtle);
  padding: var(--space-2) var(--space-3);
}

.alert-detail {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
}

.alert-detail__card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
}

.alert-detail__label {
  font-size: var(--font-size-meta);
  color: var(--color-text-secondary);
}

.alert-detail__value {
  font-size: var(--font-size-small);
  overflow-wrap: anywhere;
}

@media (max-width: 900px) {
  .alert-detail {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
