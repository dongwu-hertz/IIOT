<script setup lang="ts">
/**
 * 一个实时读数（规格 §7 KPI / §16 Detail 共用）。
 *
 * 无边框、无卡片：工业软件的实时区不是"一堆彩色卡片"，左栏最多四个主 KPI。
 * 颜色只表达状态含义：
 *   - `severity` 只从真实告警来（红色 = 真实 Alarm，橙/黄 = Warning）；
 *   - `quality = 'stale'` 时数字保留最后值但变灰（规格 §31：不要突然变成 0）；
 *   - `quality = 'nodata' / 'invalid'` 显示 `—`。
 */

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MetricValue } from '@shared/domain/realtime-monitor'
import { realtimeMetricLabelKey } from '@shared/domain/realtime-monitor'
import { EMPTY_VALUE, formatNumber } from '@renderer/lib/format'

const props = withDefaults(
  defineProps<{
    metric: MetricValue
    /** detail 比 kpi 小一档，用于右栏固定顺序表。 */
    variant?: 'kpi' | 'detail'
  }>(),
  { variant: 'kpi' }
)

const { t } = useI18n()

const label = computed(() => t(realtimeMetricLabelKey(props.metric.key)))

const valueText = computed(() => {
  const metric = props.metric
  if (metric.value === null || metric.value === undefined) {
    return metric.textKey ? t(metric.textKey) : EMPTY_VALUE
  }
  if (typeof metric.value === 'number') {
    return formatNumber(metric.value, metric.precision)
  }
  return metric.value
})

const unitText = computed(() => (props.metric.value !== null && props.metric.unit ? props.metric.unit : ''))

const noteText = computed(() => {
  const metric = props.metric
  if (metric.noteKey) return t(metric.noteKey)
  return metric.note ?? ''
})

type Tone = 'normal' | 'warning' | 'alarm' | 'muted'

const tone = computed<Tone>(() => {
  if (props.metric.severity === 'alarm') return 'alarm'
  if (props.metric.severity === 'warning') return 'warning'
  if (props.metric.quality === 'stale') return 'muted'
  if (props.metric.quality === 'nodata' || props.metric.quality === 'invalid') return 'muted'
  return 'normal'
})
</script>

<template>
  <div
    class="rt-metric"
    :class="[`rt-metric--${variant}`, `rt-metric--${tone}`]"
    :data-realtime-metric="metric.key"
    :data-metric-quality="metric.quality"
    :data-metric-tone="tone"
  >
    <p class="rt-metric__label">{{ label }}</p>
    <p class="rt-metric__value">
      <span class="rt-metric__number">{{ valueText }}</span>
      <span v-if="unitText" class="rt-metric__unit">{{ unitText }}</span>
    </p>
    <p v-if="noteText" class="rt-metric__note">{{ noteText }}</p>
    <p v-if="metric.quality === 'stale'" class="rt-metric__quality">{{ t('realtimeUi.quality.stale') }}</p>
  </div>
</template>

<style scoped>
.rt-metric {
  min-width: 0;
}

.rt-metric__label {
  margin: 0;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
}

.rt-metric__value {
  margin: 2px 0 0;
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
}

.rt-metric__number {
  font-size: 26px;
  font-weight: 600;
  line-height: 1.15;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.rt-metric--detail .rt-metric__number {
  font-size: 15px;
  font-weight: 600;
}

.rt-metric__unit {
  font-size: 13px;
  color: var(--color-text-secondary);
}

.rt-metric--detail .rt-metric__unit {
  font-size: 12px;
}

.rt-metric__note {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: var(--color-text-tertiary);
}

.rt-metric__quality {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--color-text-disabled);
}

/* 真实告警 / 警告：只改数字，不整块铺底色（规格 §32：不要整块图变红）。 */
.rt-metric--alarm .rt-metric__number {
  color: var(--color-danger);
}

.rt-metric--warning .rt-metric__number {
  color: var(--color-severity-medium);
}

/* stale / nodata：保留最后值但变灰。 */
.rt-metric--muted .rt-metric__number,
.rt-metric--muted .rt-metric__unit {
  color: var(--color-text-disabled);
}
</style>