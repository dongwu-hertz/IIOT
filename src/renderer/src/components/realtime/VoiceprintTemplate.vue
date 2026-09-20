<script setup lang="ts">
/**
 * FA8 声纹引擎模板（规格 §13–§17）。
 *
 * 左：8 通道列表（主值 + 状态点，选中整行切换）；
 * 中：Trend / Spectrum / Voiceprint 三个 Tab（默认 Trend）；
 * 右：固定顺序的 7 项特征 + 通道异常点名的特征（§17：不能只显示一个 "Abnormal"）。
 *
 * 频谱的频率轴：设备能给出 `binHz` 时按 Hz 画；给不出时按"第 N 根谱线"画，
 * 并明说频率轴未知（规格 §11：一个编造的 Hz 轴比没有轴更糟）。
 */

import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RealtimeFeature } from '@shared/domain/models'
import type { RealtimeFrame, RealtimeTabId } from '@shared/domain/realtime-monitor'
import { realtimeTemplate } from '@shared/domain/realtime-monitor'
import type { TrendMetric } from '@shared/domain/trend'
import { TREND_METRIC_META } from '@renderer/lib/trendMetrics'
import RealtimeChannelList from './RealtimeChannelList.vue'
import RealtimeLineChart from './RealtimeLineChart.vue'
import RealtimeMetric from './RealtimeMetric.vue'

const props = defineProps<{
  frame: RealtimeFrame
  featureHistory: RealtimeFeature[]
  spectrumMagnitudes: number[]
  spectrumBinHz: number
  selectedChannel: number
  activeTab: RealtimeTabId
  /** 走时（store.now），把趋势窗口钉在最近 60 秒（规格 §30）。 */
  now: number
}>()

const emit = defineEmits<{
  (event: 'selectChannel', channelIndex: number): void
  (event: 'setTab', tab: RealtimeTabId): void
}>()

const { t } = useI18n()

const tabs = realtimeTemplate('voiceprint').tabs
const trendMetric = ref<TrendMetric>('spl')
const trendOptions = computed(() =>
  Object.values(TREND_METRIC_META).sort((left, right) => left.order - right.order)
)

const TREND_WINDOW_MS = 60_000

const trendPoints = computed(() => {
  const metric = trendMetric.value
  const from = props.now - TREND_WINDOW_MS
  return props.featureHistory
    .filter((feature) => feature.timestamp >= from)
    .map((feature) => ({ x: feature.timestamp, y: Number(feature[metric]) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
})

const spectrumPoints = computed(() =>
  props.spectrumMagnitudes
    .map((value, index) => ({
      x: props.spectrumBinHz > 0 ? index * props.spectrumBinHz : index,
      y: value
    }))
    .filter((point) => Number.isFinite(point.y))
)

const spectrumUnit = computed(() => (props.spectrumBinHz > 0 ? 'Hz' : ''))


const selectedChannelData = computed(() =>
  props.frame.channels?.find((channel) => channel.channelId === props.selectedChannel)
)

const selectedChannelLabel = computed(() => `CH${props.selectedChannel + 1}`)

const currentTrendMeta = computed(
  () => trendOptions.value.find((meta) => meta.key === trendMetric.value) ?? trendOptions.value[0]
)
</script>

<template>
  <div class="vp" data-realtime-template="voiceprint">
    <section class="vp__col vp__col--left">
      <header class="vp__head">
        <h4>{{ t('realtimeUi.channels') }}</h4>
        <span class="vp__sub">{{ selectedChannelLabel }}</span>
      </header>
      <RealtimeChannelList
        :channels="frame.channels ?? []"
        :selected="selectedChannel"
        @select="emit('selectChannel', $event)"
      />
    </section>

    <section class="vp__col vp__col--center">
      <nav class="vp__tabs" role="tablist" :aria-label="t('realtimeUi.tabs.label')">
        <button
          v-for="tab in tabs"
          :key="tab"
          type="button"
          role="tab"
          class="vp__tab"
          :class="{ 'vp__tab--active': tab === activeTab }"
          :aria-selected="tab === activeTab"
          :data-realtime-tab="tab"
          @click="emit('setTab', tab)"
        >
          {{ t(`realtimeUi.tabs.${tab}`) }}
        </button>
      </nav>

      <div class="vp__canvas">
        <template v-if="activeTab === 'trend'">
          <div class="vp__chips">
            <button
              v-for="meta in trendOptions"
              :key="meta.key"
              type="button"
              class="chip chip--selectable"
              :class="{ 'chip--accent': meta.key === trendMetric }"
              @click="trendMetric = meta.key"
            >
              {{ t(meta.labelKey) }}
            </button>
          </div>
          <RealtimeLineChart
            :points="trendPoints"
            x-kind="time"
            :y-unit="currentTrendMeta?.unit ?? ''"
            :value-precision="currentTrendMeta?.precision"
            :empty-text="t('realtimeUi.emptyTrend')"
            :channel-label="selectedChannelLabel"
            :height="188"
          />
        </template>

        <template v-else-if="activeTab === 'spectrum'">
          <RealtimeLineChart
            :points="spectrumPoints"
            x-kind="value"
            :x-unit="spectrumUnit"
            :y-unit="''"
            :value-precision="3"
            :empty-text="t('realtimeUi.spectrumWaiting')"
            :channel-label="selectedChannelLabel"
            :height="188"
          />
          <p v-if="spectrumBinHz <= 0" class="vp__hint">{{ t('realtimeUi.spectrumUnknownAxis') }}</p>
        </template>

        <template v-else>
          <!-- 声纹图不是现有 FA8 特征流的数据点；特征读数在右栏，这里如实说明。 -->
          <p class="vp__nodata">{{ t('realtimeUi.voiceprintPending') }}</p>
        </template>


      </div>
    </section>

    <section class="vp__col vp__col--right">
      <header class="vp__head">
        <h4>{{ t('realtimeUi.featuresTitle', { channel: selectedChannelLabel }) }}</h4>
      </header>

      <div v-if="selectedChannelData?.issues?.length" class="vp__issues" data-realtime-channel-issues>
        <p class="vp__issues-title">{{ t('realtimeUi.channelIssue') }}</p>
        <RealtimeMetric
          v-for="issue in selectedChannelData.issues"
          :key="issue.key"
          :metric="issue.value"
          variant="detail"
        />
      </div>

      <div class="vp__details">
        <RealtimeMetric
          v-for="metric in frame.details ?? []"
          :key="metric.key"
          :metric="metric"
          variant="detail"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.vp {
  display: grid;
  grid-template-columns: 250px minmax(320px, 1fr) 290px;
  gap: var(--space-4);
  align-items: stretch;
  min-height: 240px;
}

.vp__col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.vp__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 24px;
}

.vp__head h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.vp__sub {
  font-size: 12px;
  color: var(--color-accent-strong);
  font-weight: 600;
}

.vp__tabs {
  display: flex;
  gap: var(--space-2);
  border-bottom: 1px solid var(--color-border);
}

.vp__tab {
  padding: 4px 2px 6px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.vp__tab--active {
  color: var(--color-accent-strong);
  border-bottom-color: var(--color-accent);
  font-weight: 600;
}

.vp__canvas {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.vp__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.vp__hint,
.vp__nodata {
  margin: 0;
  font-size: 11.5px;
  color: var(--color-text-tertiary);
}

.vp__nodata {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 188px;
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  text-align: center;
  padding: var(--space-3);
}

.vp__issues {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--color-danger-border);
  border-radius: var(--radius-sm);
  background: var(--color-danger-soft);
}

.vp__issues-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-danger);
}

.vp__details {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* 窄窗口落回单列；中列至少 320px，先让右栏下去。 */
@media (max-width: 1100px) {
  .vp {
    grid-template-columns: 220px minmax(0, 1fr);
  }

  .vp__col--right {
    grid-column: 1 / -1;
  }
}
</style>