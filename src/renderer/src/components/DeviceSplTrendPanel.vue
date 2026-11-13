<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { EChartsCoreOption } from 'echarts/core'
import { callApi, unwrap } from '@renderer/lib/result'
import EChart from '@renderer/components/EChart.vue'

const props = defineProps<{ deviceId: string }>()
const { t } = useI18n()

interface SplPoint {
  timestamp: number
  value: number
}

const points = ref<SplPoint[]>([])
const loading = ref(false)
let refreshTimer: number | undefined
let refreshSeq = 0

const option = computed<EChartsCoreOption>(() => ({
  animation: false,
  grid: { left: 44, right: 12, top: 18, bottom: 26 },
  tooltip: { trigger: 'axis', valueFormatter: (value: unknown) => `${Number(value).toFixed(1)} dB` },
  xAxis: { type: 'time', axisLabel: { fontSize: 10 } },
  yAxis: {
    type: 'value',
    name: 'dB',
    min: 0,
    max: 100,
    axisLabel: { fontSize: 10 },
    splitLine: { lineStyle: { color: '#ECEEF1' } }
  },
  series: [
    {
      type: 'line',
      showSymbol: false,
      data: points.value.map((point) => [point.timestamp, point.value]),
      lineStyle: { width: 1.6, color: '#FF6A1A' },
      areaStyle: { color: 'rgba(255,106,26,0.10)' }
    }
  ]
}))

function mergePoints(list: SplPoint[]): SplPoint[] {
  const byTime = new Map<number, number>()
  for (const point of list) {
    if (!Number.isFinite(point.timestamp) || !Number.isFinite(point.value)) continue
    byTime.set(point.timestamp, point.value)
  }
  return [...byTime.entries()]
    .sort((left, right) => left[0] - right[0])
    .slice(-360)
    .map(([timestamp, value]) => ({ timestamp, value }))
}

async function refresh(): Promise<void> {
  if (props.deviceId === '') {
    points.value = []
    return
  }
  const seq = ++refreshSeq
  loading.value = true
  const now = Date.now()
  const from = now - 3_600_000
  try {
    const trendResult = await callApi(() =>
      window.api.trends.query({
        deviceId: props.deviceId,
        metric: 'spl',
        from,
        to: now,
        aggregation: 'avg',
        maxPoints: 300
      })
    )
    if (seq !== refreshSeq) return
    const trendPoints = trendResult.success
      ? (unwrap(trendResult)?.points ?? [])
          .filter((point) => Number.isFinite(point.value))
          .map((point) => ({ timestamp: point.timestamp, value: point.value }))
      : []
    if (trendPoints.length > 0) {
      points.value = mergePoints(trendPoints)
      return
    }

    // 相机/16 路声呐的 SPL 也可能来自设备告警记录；趋势库没有点时用告警 SPL 兜底。
    const alarmResult = await callApi(() =>
      window.api.alarms.query({ deviceId: props.deviceId, from, to: now, limit: 300 })
    )
    if (seq !== refreshSeq) return
    points.value = alarmResult.success
      ? mergePoints(
          (unwrap(alarmResult)?.items ?? [])
            .filter((alarm) => alarm.spl !== undefined && Number.isFinite(alarm.spl))
            .map((alarm) => ({ timestamp: alarm.timestamp, value: alarm.spl as number }))
        )
      : []
  } finally {
    if (seq === refreshSeq) loading.value = false
  }
}

onMounted(() => {
  void refresh()
  refreshTimer = window.setInterval(() => void refresh(), 10_000)
})

onBeforeUnmount(() => {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer)
})

watch(
  () => props.deviceId,
  () => {
    points.value = []
    void refresh()
  }
)
</script>

<template>
  <section class="card spl-trend-panel" data-spl-trend>
    <div class="section-header">
      <h3 class="section-title">{{ t('monitorUi.trendSection') }}</h3>
      <span class="muted">SPL · dB</span>
    </div>
    <EChart
      v-if="points.length > 0"
      :option="option"
      height="190px"
      data-spl-trend-chart
    />
    <p v-else class="muted spl-trend-panel__empty">
      {{ loading ? t('common.loading') : t('monitorUi.waitingFeatures') }}
    </p>
  </section>
</template>

<style scoped>
.spl-trend-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.spl-trend-panel__empty {
  min-height: 90px;
  display: grid;
  place-items: center;
  margin: 0;
}
</style>