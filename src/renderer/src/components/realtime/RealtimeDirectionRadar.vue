<script setup lang="ts">
/**
 * 极简方向雷达（规格 §22）。
 *
 * 不做复杂军事雷达：十字 + 四方位 + 45° 细虚线；有有效目标时画一条
 * 中心到目标的线和一枚点，再给水平/垂直读数。
 *
 * **Live 模式不画不断变化的方向角**（规格 §20）。方向只在 Event 模式、
 * 且 `parseAirSonarDirection()` 从告警原文里真的读到数字时才存在；
 * 没有就是 No Target，不是 0°。
 */

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RealtimeTarget } from '@shared/domain/realtime-monitor'
import { hasRealtimeTarget } from '@shared/domain/realtime-monitor'
import { formatNumber } from '@renderer/lib/format'

const props = defineProps<{
  target?: RealtimeTarget
  emptyText: string
}>()

const { t } = useI18n()

const hasTarget = computed(() => hasRealtimeTarget(props.target))
const horizontal = computed(() => props.target?.horizontal)
const vertical = computed(() => props.target?.vertical)

const ariaLabel = computed(() => {
  if (!hasTarget.value) return props.emptyText
  const parts: string[] = []
  if (horizontal.value !== undefined) {
    parts.push(t('realtimeUi.metric.horizontal') + ' ' + formatNumber(horizontal.value, 0) + '°')
  }
  if (vertical.value !== undefined) {
    parts.push(t('realtimeUi.metric.vertical') + ' ' + formatNumber(vertical.value, 0) + '°')
  }
  return parts.join(', ') || props.emptyText
})

const targetPoint = computed(() => {
  const angle = horizontal.value
  if (angle === undefined) return null
  const rad = (angle * Math.PI) / 180
  const radius = 34
  return {
    x: 50 + radius * Math.sin(rad),
    y: 50 - radius * Math.cos(rad)
  }
})
</script>

<template>
  <div class="rt-radar" data-realtime-radar :data-radar-target="hasTarget ? 'yes' : 'no'">
    <svg class="rt-radar__svg" viewBox="0 0 100 100" role="img" :aria-label="ariaLabel">
      <circle class="rt-radar__ring" cx="50" cy="50" r="38" />
      <circle class="rt-radar__ring rt-radar__ring--inner" cx="50" cy="50" r="19" />
      <line class="rt-radar__axis" x1="50" y1="6" x2="50" y2="94" />
      <line class="rt-radar__axis" x1="6" y1="50" x2="94" y2="50" />
      <line class="rt-radar__diagonal" x1="23.1" y1="23.1" x2="76.9" y2="76.9" />
      <line class="rt-radar__diagonal" x1="76.9" y1="23.1" x2="23.1" y2="76.9" />
      <text class="rt-radar__letter" x="50" y="5" text-anchor="middle">N</text>
      <text class="rt-radar__letter" x="97" y="53" text-anchor="middle">E</text>
      <text class="rt-radar__letter" x="50" y="99" text-anchor="middle">S</text>
      <text class="rt-radar__letter" x="3" y="53" text-anchor="middle">W</text>
      <template v-if="targetPoint && hasTarget">
        <line class="rt-radar__beam" x1="50" y1="50" :x2="targetPoint.x" :y2="targetPoint.y" />
        <circle class="rt-radar__target" :cx="targetPoint.x" :cy="targetPoint.y" r="4" />
      </template>
    </svg>
    <p v-if="!hasTarget" class="rt-radar__none">{{ emptyText }}</p>
    <dl v-else class="rt-radar__readout">
      <div v-if="horizontal !== undefined">
        <dt>{{ t('realtimeUi.metric.horizontal') }}</dt>
        <dd>{{ formatNumber(horizontal, 0) }}°</dd>
      </div>
      <div v-if="vertical !== undefined">
        <dt>{{ t('realtimeUi.metric.vertical') }}</dt>
        <dd>{{ formatNumber(vertical, 0) }}°</dd>
      </div>
    </dl>
  </div>
</template>

<style scoped>
.rt-radar {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 180px;
  height: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  padding: var(--space-2);
}

.rt-radar__svg {
  width: min(100%, 260px);
  height: auto;
  max-height: 240px;
}

.rt-radar__ring {
  fill: none;
  stroke: var(--color-border);
  stroke-width: 0.8;
}

.rt-radar__ring--inner {
  stroke-dasharray: 2 3;
}

.rt-radar__axis {
  stroke: var(--color-border-strong);
  stroke-width: 0.8;
}

.rt-radar__diagonal {
  stroke: var(--color-border);
  stroke-width: 0.6;
  stroke-dasharray: 1.5 3;
}

.rt-radar__letter {
  font-size: 7px;
  fill: var(--color-text-tertiary);
}

.rt-radar__beam {
  stroke: var(--color-accent);
  stroke-width: 1.6;
}

.rt-radar__target {
  fill: var(--color-accent);
}

.rt-radar__none {
  position: absolute;
  inset: 0;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  pointer-events: none;
}

.rt-radar__readout {
  display: flex;
  gap: var(--space-5);
  margin: var(--space-2) 0 0;
  padding: 0;
}

.rt-radar__readout div {
  text-align: center;
}

.rt-radar__readout dt {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.rt-radar__readout dd {
  margin: 2px 0 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}
</style>