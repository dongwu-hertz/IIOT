<script setup lang="ts">
/**
 * 多通道设备（FA8 / 声呐）的通道列表（规格 §13/§14）。
 *
 * 8 × 7 的大表格被压成一列"通道 + 一个主值 + 状态点"：当前通道整行高亮，
 * 点通道以后中/右栏跟着切（规格 §14）。没有实时读数的那一路是空心圆
 * （○ No Data），不是 0 dB —— 0 dB 会被读成一个真实测量值。
 */

import { useI18n } from 'vue-i18n'
import type { ChannelRealtime, RealtimeChannelStatus } from '@shared/domain/realtime-monitor'
import { formatNumber } from '@renderer/lib/format'

defineProps<{
  channels: ChannelRealtime[]
  selected: number
}>()

const emit = defineEmits<{ (event: 'select', channelIndex: number): void }>()

const { t } = useI18n()

/** CH1..CH8（界面用 1 起编号，代码里通道号是 0 起）。 */
function channelLabel(channelId: number): string {
  return `CH${channelId + 1}`
}

const splText = (channel: ChannelRealtime): string => {
  const metric = channel.spl
  if (!metric || metric.value === null || metric.value === undefined) return '—'
  if (typeof metric.value !== 'number') return String(metric.value)
  return formatNumber(metric.value, metric.precision ?? 1)
}

const splValue = (channel: ChannelRealtime): number | null => {
  const value = channel.spl?.value
  return typeof value === 'number' ? value : null
}

function statusLabel(status: RealtimeChannelStatus): string {
  return t(`realtimeUi.channelStatus.${status}`)
}

const hasIssue = (channel: ChannelRealtime): boolean => (channel.issues?.length ?? 0) > 0

</script>

<template>
  <div class="rt-channels" data-realtime-channels>
    <div
      v-for="channel in channels"
      :key="channel.channelId"
      class="rt-channels__row"
      :class="{ 'rt-channels__row--active': channel.channelId === selected }"
      :data-realtime-channel="channel.channelId"
      :data-channel-status="channel.status"
      role="button"
      tabindex="0"
      @click="emit('select', channel.channelId)"
      @keydown.enter.prevent="emit('select', channel.channelId)"
      @keydown.space.prevent="emit('select', channel.channelId)"
    >
      <span class="rt-channels__label">{{ channelLabel(channel.channelId) }}</span>
      <span class="rt-channels__spl">
        {{ splText(channel) }}
        <span v-if="splValue(channel) !== null" class="rt-channels__unit">dB</span>
      </span>
      <span
        class="rt-channels__dot"
        :class="`rt-channels__dot--${channel.status}`"
        :title="statusLabel(channel.status)"
        :aria-label="statusLabel(channel.status)"
      ></span>
      <span
        v-if="hasIssue(channel)"
        class="rt-channels__issue"
        :title="t('realtimeUi.channelIssue')"
      >!</span>
    </div>
    <p class="rt-channels__hint">{{ t('realtimeUi.channelsHint') }}</p>
  </div>
</template>

<style scoped>
.rt-channels {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rt-channels__row {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) 14px 14px;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 6px 0 5px;
  border-left: 3px solid transparent;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  cursor: pointer;
}

.rt-channels__row:hover {
  background: var(--color-bg-hover);
}

/* 选中态 = 浅橙底 + 3px 橙条 + 加粗（规格 §14；不靠颜色单独表意）。 */
.rt-channels__row--active {
  background: var(--color-accent-light);
  border-left-color: var(--color-accent);
  font-weight: 600;
}

.rt-channels__label {
  color: var(--color-text-secondary);
}

.rt-channels__row--active .rt-channels__label {
  color: var(--color-accent-strong);
}

.rt-channels__spl {
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--color-text);
}

.rt-channels__unit {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.rt-channels__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  justify-self: center;
}

.rt-channels__dot--normal {
  background: var(--color-success);
}

.rt-channels__dot--warning {
  background: var(--color-severity-medium);
}

.rt-channels__dot--alarm {
  background: var(--color-danger);
}

/* 空心圆 = No Data（不是绿色）。 */
.rt-channels__dot--nodata {
  background: transparent;
  border: 1.5px solid var(--color-text-disabled);
}

.rt-channels__issue {
  color: var(--color-danger);
  font-weight: 700;
  text-align: center;
}

.rt-channels__hint {
  margin: var(--space-2) 0 0;
  font-size: 11px;
  color: var(--color-text-tertiary);
}
</style>