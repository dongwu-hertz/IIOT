<script setup lang="ts">
/**
 * Single statistic tile (overview counters, realtime metrics).
 *
 * IMPORTANT: a missing metric renders "—", never "0". The backend deliberately
 * returns NaN/undefined for values the firmware did not report, and showing a
 * fake zero would read as "measured, and it is zero" — a dangerous lie on an
 * acoustic monitoring screen (spec 9.2).
 */
import { computed } from 'vue'
import { EMPTY_VALUE, formatNumber, isMissingNumber } from '@renderer/lib/format'

const props = withDefaults(
  defineProps<{
    label: string
    value: number | string | null | undefined
    unit?: string
    hint?: string
    trend?: 'up' | 'down' | 'flat'
    /** Fixed decimals for live-updating values; omit for adaptive formatting. */
    precision?: number
  }>(),
  { unit: '', hint: '', precision: undefined }
)

const display = computed(() => {
  if (typeof props.value === 'string') return props.value.trim() === '' ? EMPTY_VALUE : props.value
  if (isMissingNumber(props.value)) return EMPTY_VALUE
  return formatNumber(props.value as number, props.precision)
})

const isPlaceholder = computed(() => display.value === EMPTY_VALUE)

const trendGlyph = computed(() => {
  if (props.trend === 'up') return '↑'
  if (props.trend === 'down') return '↓'
  if (props.trend === 'flat') return '→'
  return ''
})
</script>

<template>
  <div class="metric">
    <div class="metric__label">{{ label }}</div>
    <div class="metric__value-row">
      <span class="metric__value" :class="{ 'metric__value--empty': isPlaceholder }">
        {{ display }}
      </span>
      <span v-if="unit && !isPlaceholder" class="metric__unit">{{ unit }}</span>
      <span v-if="trendGlyph" class="metric__trend" :class="`metric__trend--${trend}`">
        {{ trendGlyph }}
      </span>
    </div>
    <div v-if="hint" class="metric__hint">{{ hint }}</div>
  </div>
</template>

<style scoped>
.metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.metric__label {
  font-size: 11.5px;
  color: var(--color-text-secondary);
}

.metric__value-row {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
}

.metric__value {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.metric__value--empty {
  color: var(--color-text-secondary);
  font-weight: 500;
}

.metric__unit {
  font-size: 11.5px;
  color: var(--color-text-secondary);
}

.metric__trend {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.metric__trend--up {
  color: var(--color-danger);
}

.metric__trend--down {
  color: var(--color-success);
}

.metric__hint {
  font-size: 11.5px;
  color: var(--color-text-secondary);
}
</style>
