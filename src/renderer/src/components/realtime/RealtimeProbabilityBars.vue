<script setup lang="ts">
/**
 * 概率横条（规格 §9）。
 *
 * 明确不用饼图：用户真正关心"哪一种最高"。每一类一条独立概率，
 * 不做归一化、不把剩余量塞进 "Others" —— 设备给什么就画什么，
 * 全部缺数据时显示空态，不画四条 0% 的假条。
 */

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatNumber } from '@renderer/lib/format'

const props = withDefaults(
  defineProps<{
    /** 稳定标识 -> 概率/比例；null 表示这一类没读到。 */
    values: Record<string, number | string | null>
    /** i18n 前缀，例如 `realtimeUi.pdClass`。 */
    labelKeyPrefix: string
    emptyText: string
    /** 固定顺序（规格 §16 同一条精神：不按大小重排）。 */
    order?: string[]
  }>(),
  { order: () => [] }
)

const { t } = useI18n()

interface Bar {
  key: string
  label: string
  percent: number
  text: string
  highest: boolean
}

const bars = computed<Bar[]>(() => {
  const keys = props.order.length > 0 ? props.order : Object.keys(props.values)
  const numeric: Array<{ key: string; percent: number }> = []
  for (const key of keys) {
    const raw = props.values[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      numeric.push({ key, percent: raw <= 1 ? raw * 100 : raw })
    }
  }
  if (numeric.length === 0) return []
  const max = Math.max(...numeric.map((entry) => entry.percent))
  return numeric.map((entry) => ({
    key: entry.key,
    label: t(`${props.labelKeyPrefix}.${entry.key}`),
    percent: entry.percent,
    text: `${formatNumber(entry.percent, 1)}%`,
    highest: entry.percent === max
  }))
})
</script>

<template>
  <div class="rt-bars" data-realtime-bars>
    <template v-if="bars.length > 0">
      <div v-for="bar in bars" :key="bar.key" class="rt-bars__row" :data-realtime-bar="bar.key">
        <span class="rt-bars__label">{{ bar.label }}</span>
        <span class="rt-bars__track">
          <span
            class="rt-bars__fill"
            :class="{ 'rt-bars__fill--highest': bar.highest }"
            :style="{ width: `${Math.min(100, Math.max(0, bar.percent))}%` }"
          ></span>
        </span>
        <span class="rt-bars__value">{{ bar.text }}</span>
      </div>
    </template>
    <p v-else class="rt-bars__empty">{{ emptyText }}</p>
  </div>
</template>

<style scoped>
.rt-bars {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rt-bars__row {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr) 52px;
  align-items: center;
  gap: 8px;
}

.rt-bars__label {
  font-size: 12px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rt-bars__track {
  height: 8px;
  border-radius: var(--radius-pill);
  background: var(--color-bg-muted);
  overflow: hidden;
}

.rt-bars__fill {
  display: block;
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--color-neutral);
}

/* 最高的一类用品牌橙的浅色而不是高饱和橙：它是"当前最可能"，不是按钮。 */
.rt-bars__fill--highest {
  background: var(--color-accent);
}

.rt-bars__value {
  font-size: 12px;
  text-align: right;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}

.rt-bars__empty {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-tertiary);
}
</style>