<script setup lang="ts">
/**
 * Historical trend page (Phase 11, spec §12.2).
 *
 * THE THREE RULES THIS PAGE IS BUILT AROUND
 *
 * 1. THE RENDERER NEVER TOUCHES THE OUTSIDE WORLD. Every value here comes from
 *    `window.api.trends.*` through the store; there is no fetch, no XHR, no
 *    socket (the renderer's CSP has `connect-src 'none'` anyway). The page also
 *    never sees the on-disk storage identity: it sends the local `deviceId` it
 *    already holds and the main process resolves the identity, so the storage
 *    layout stays in the main process where it belongs.
 *
 * 2. DOWNSAMPLING HAPPENS IN THE MAIN PROCESS, EXACTLY ONCE. The backend picks a
 *    bucket size from the requested span (`chooseBucketSeconds`) and aggregates
 *    in SQL, so a month of history arrives as ~500 rows instead of 2.6 million.
 *    There is deliberately NO second decimation layer in this file — no `lttb`
 *    sampling, no manual thinning. Do not "optimise" it back in: it would hide
 *    the buckets the diagnostics line exists to prove.
 *
 * 3. A MISSING VALUE IS A GAP, NEVER A ZERO. `TrendPoint.value` is `NaN` when
 *    the device did not report that metric in a bucket. It is mapped to `null`
 *    for ECharts with `connectNulls: false`, because a zero on an acoustic chart
 *    reads as "measured silence" — a lie about a device that may simply have
 *    dropped frames.
 *
 * The chart itself is the shared `EChart.vue` wrapper; this file only builds the
 * option object.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type { EChartsCoreOption } from 'echarts/core'
import { CHANNEL_COUNT } from '@shared/domain/models'
import { TREND_RANGE_OPTIONS, useTrendsStore } from '@renderer/stores/trends'
import { useDevicesStore } from '@renderer/stores/devices'
import { channelState, channelStateLabelKey, type ChannelState } from '@renderer/lib/channelState'
import {
  EMPTY_VALUE,
  channelLabel,
  formatDateTime,
  formatDuration,
  formatTrendTick,
  fromDateTimeLocalValue,
  toDateTimeLocalValue
} from '@renderer/lib/format'
import {
  TREND_AGGREGATION_OPTIONS,
  TREND_METRIC_META,
  TREND_METRIC_OPTIONS,
  formatBucketSeconds,
  trendAggregationLabel,
  trendAxisName,
  trendMetricLabel,
  trendValueText
} from '@renderer/lib/trendMetrics'
import EmptyState from '@renderer/components/EmptyState.vue'
import EChart from '@renderer/components/EChart.vue'
import MetricCard from '@renderer/components/MetricCard.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const devices = useDevicesStore()
const trends = useTrendsStore()

const selectedDeviceId = ref('')
/** Local text mirrors of the custom bounds, so typing is never fought by a re-render. */
const customFromText = ref('')
const customToText = ref('')
const flushing = ref(false)
const notice = ref('')

// ---------------------------------------------------------------------------
// Toolbar bindings
// ---------------------------------------------------------------------------

/**
 * Selects are bound through string computeds because a `<select>` always hands
 * back a string: the setter looks the option up instead of casting, so an
 * unknown value can never enter the store as a fake union member.
 *
 * Each setter schedules a query through the store's debounce. The query is
 * triggered by the USER ACTION rather than by a store watcher, which keeps a
 * device switch (where coverage can seed the custom bounds) from firing the same
 * query twice.
 */
const metricSelection = computed({
  get: () => trends.metric as string,
  set: (value: string) => {
    const option = TREND_METRIC_OPTIONS.find((item) => item.key === value)
    if (!option) return
    trends.metric = option.key
    trends.query()
  }
})

const aggregationSelection = computed({
  get: () => trends.aggregation as string,
  set: (value: string) => {
    const option = TREND_AGGREGATION_OPTIONS.find((item) => item.key === value)
    if (!option) return
    trends.aggregation = option.key
    trends.query()
  }
})

/** `''` is 全部通道: the store then omits `channelId` from the query entirely. */
const channelSelection = computed({
  get: () => (trends.channelId === undefined ? '' : String(trends.channelId)),
  set: (value: string) => {
    trends.channelId = value === '' ? undefined : Number(value)
    trends.query()
  }
})

const selectedDevice = computed(() => devices.byId(selectedDeviceId.value))

/** 历史查询用的通道项：带上状态，未启用/未知都要在文字里标出来。 */
interface ChannelOption {
  index: number
  name: string
  state: ChannelState
}

const channelOptions = computed<ChannelOption[]>(() => {
  const list = devices.channelsOf(selectedDeviceId.value)
  if (list.length > 0) {
    return [...list]
      .sort((left, right) => left.channelIndex - right.channelIndex)
      .map((channel) => ({
        index: channel.channelIndex,
        name: channel.channelName,
        state: channelState(channel)
      }))
  }
  // 设备没返回通道表：状态是“未知”，不能当作“已启用”。
  return Array.from({ length: CHANNEL_COUNT }, (_, index) => ({
    index,
    name: '',
    state: 'unknown'
  }))
})

const customRangeIncomplete = computed(
  () =>
    trends.range === 'custom' &&
    (trends.customFrom === undefined || trends.customTo === undefined)
)

const deviceHint = computed(() => {
  const device = selectedDevice.value
  if (!device) return t('trendsUi.deviceNotSelected')
  return `${device.name}（${device.ip || t('trendsUi.noAddress')}）`
})

const channelHint = computed(() =>
  trends.channelId === undefined ? t('trendsUi.filterAllChannels') : channelLabel(trends.channelId)
)

const rangeText = computed(() => {
  const from = trends.queriedFrom
  const to = trends.queriedTo
  if (from === null || to === null) return t('trendsUi.notQueried')
  return `${formatDateTime(from)} ~ ${formatDateTime(to)}`
})

const coverageText = computed(() => {
  const bounds = trends.coverageBounds
  if (!bounds) return ''
  return `${formatDateTime(bounds.from)} ~ ${formatDateTime(bounds.to)}`
})

// ---------------------------------------------------------------------------
// Chart data
// ---------------------------------------------------------------------------

interface TrendChartRow {
  /** Short axis tick, chosen from the span. */
  label: string
  /** Full timestamp for the tooltip and the summary tiles. */
  fullLabel: string
  /** `null` = the device reported nothing in this bucket. Never 0. */
  value: number | null
  sampleCount: number
}

const spanMs = computed(() => {
  const from = trends.queriedFrom
  const to = trends.queriedTo
  if (from === null || to === null) return 0
  return Math.max(0, to - from)
})

const chartRows = computed<TrendChartRow[]>(() =>
  trends.points.map((point) => ({
    label: formatTrendTick(point.timestamp, spanMs.value),
    fullLabel: formatDateTime(point.timestamp),
    // Rule 3: NaN means "not reported here" and must become a gap.
    value: Number.isFinite(point.value) ? point.value : null,
    sampleCount: point.sampleCount
  }))
)

/**
 * ECharts tooltip. `params` is typed `unknown` and narrowed locally: the option
 * object is typed as the loosely-typed `EChartsCoreOption`, and the sample count
 * is read from `chartRows` by index so the series data can stay plain numbers.
 */
interface TrendTooltipParam {
  dataIndex: number
}

function trendTooltip(params: unknown): string {
  const list = Array.isArray(params) ? (params as TrendTooltipParam[]) : [params as TrendTooltipParam]
  const first = list[0]
  if (!first) return ''
  const row = chartRows.value[first.dataIndex]
  if (!row) return ''

  const valueText =
    row.value === null
      ? t('trendsUi.noDataInBucket', { value: EMPTY_VALUE })
      : trendValueText(trends.metric, row.value)

  return [
    `<div style="font-weight:600">${row.fullLabel}</div>`,
    `${trendMetricLabel(trends.metric)}（${trendAggregationLabel(trends.aggregation)}）：${valueText}`,
    t('trendsUi.sampleCount', { count: row.sampleCount })
  ].join('<br/>')
}

/**
 * ECharts draws to a canvas, so it cannot read the CSS custom properties in
 * `main.css`; these four constants mirror those tokens (same approach as
 * MonitorView).
 */
const AXIS_LINE = '#E5E7EB'
const SPLIT_LINE = '#F1F1F2'
const TEXT_SECONDARY = '#6B7280'
const LINE_COLOR = '#FF6A1A'

const chartOption = computed<EChartsCoreOption>(() => {
  const rows = chartRows.value
  const meta = TREND_METRIC_META[trends.metric]
  const axisName = trendAxisName(trends.metric, trends.aggregation)
  const tickFormatter = meta.tickFormatter

  return {
    // Real measurements, not a dashboard toy: an animated line implies the data
    // is live and makes a bucket boundary impossible to read.
    animation: false,
    grid: { left: 58, right: 18, top: 34, bottom: 30 },
    tooltip: { trigger: 'axis', formatter: trendTooltip },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: rows.map((row) => row.label),
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisTick: { show: false },
      axisLabel: { color: TEXT_SECONDARY, fontSize: 10, hideOverlap: true }
    },
    yAxis: {
      // The aggregation belongs IN the axis name: the same metric aggregated as
      // 平均 and as 95分位 are two different measurements.
      name: axisName,
      type: 'value',
      scale: true,
      nameTextStyle: { color: TEXT_SECONDARY, fontSize: 10, align: 'left' },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: TEXT_SECONDARY,
        fontSize: 10,
        ...(tickFormatter ? { formatter: tickFormatter } : {})
      },
      splitLine: { lineStyle: { color: SPLIT_LINE } }
    },
    series: [
      {
        name: axisName,
        type: 'line',
        // Symbols are only drawn on a series short enough that an isolated
        // bucket would otherwise be invisible; a 500-point line stays clean.
        showSymbol: rows.length <= 300,
        symbolSize: 3,
        // Gaps stay gaps: never bridge across a bucket the device did not report.
        connectNulls: false,
        data: rows.map((row) => row.value),
        lineStyle: { width: 1.6, color: LINE_COLOR },
        itemStyle: { color: LINE_COLOR }
      }
    ]
  }
})

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Bucket-level summary shown above the chart.
 *
 * These are MIN/MAX OF THE AGGREGATED BUCKETS, not of the raw samples — a 15 s
 * average can never show a raw peak — so the labels say 时间桶 rather than
 * implying a raw measurement. Gaps (`null`) are skipped and counted instead of
 * being treated as zero.
 */
const latestBucket = computed<TrendChartRow | null>(() => {
  let found: TrendChartRow | null = null
  for (const row of chartRows.value) {
    if (row.value !== null) found = row
  }
  return found
})

const rangeStats = computed<{ min: number | null; max: number | null }>(() => {
  let min: number | null = null
  let max: number | null = null
  for (const row of chartRows.value) {
    if (row.value === null) continue
    min = min === null ? row.value : Math.min(min, row.value)
    max = max === null ? row.value : Math.max(max, row.value)
  }
  return { min, max }
})

/** Time buckets the device reported nothing in; rendered as gaps, never as 0. */
const gapCount = computed(() => {
  let gaps = 0
  for (const row of chartRows.value) {
    if (row.value === null) gaps += 1
  }
  return gaps
})

const reductionText = computed(() => {
  const series = trends.series
  if (!series || series.totalRows <= 0 || series.points.length === 0) return EMPTY_VALUE
  const ratio = series.totalRows / series.points.length
  return `${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)} : 1`
})

const chartPlaceholder = computed(() => {
  if (trends.series !== null) return ''
  if (trends.loading) return t('trendsUi.loadingNotice')
  if (!selectedDeviceId.value) return ''
  return t('trendsUi.noDataNotice')
})

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

const hasNoDevice = computed(() => devices.devices.length === 0)
const noDeviceSelected = computed(() => !hasNoDevice.value && !selectedDeviceId.value)

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Re-read coverage (it grows while monitoring runs), then query immediately. */
async function refresh(): Promise<void> {
  if (!selectedDeviceId.value) return
  notice.value = ''
  await trends.loadCoverage()
  trends.query({ immediate: true })
}

/** Force a batch write; used before closing the app or after a long session. */
async function flushNow(): Promise<void> {
  flushing.value = true
  const written = await trends.flush()
  flushing.value = false
  if (!written) {
    notice.value = ''
    return
  }
  notice.value =
    written.rows > 0
      ? t('trendsUi.flushedNotice', { rows: written.rows, files: written.files })
      : t('trendsUi.emptyBufferNotice')
  if (written.rows > 0) {
    // The newly written rows are queryable now.
    await trends.loadCoverage()
    trends.query({ immediate: true })
  }
}

/** Jump to the range the stored data actually covers (the empty-state action). */
function useCoverageRange(): void {
  const bounds = trends.coverageBounds
  if (!bounds) return
  notice.value = ''
  trends.setCustomRange(bounds.from, bounds.to)
}

function applyCustomRange(): void {
  trends.customFrom = fromDateTimeLocalValue(customFromText.value)
  trends.customTo = fromDateTimeLocalValue(customToText.value)
  // Debounced: a date picker emits one input event per keystroke, and every one
  // of them would otherwise become a DuckDB scan.
  trends.query()
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

onMounted(async () => {
  if (devices.devices.length === 0) await devices.load()

  const queryDevice = typeof route.query.device === 'string' ? route.query.device : ''
  const candidate = queryDevice || devices.selectedDeviceId || devices.devices[0]?.id || ''

  customFromText.value = toDateTimeLocalValue(trends.customFrom)
  customToText.value = toDateTimeLocalValue(trends.customTo)

  // Assigning the selection drives the SAME watcher a manual switch uses, so the
  // mount path and the switch path cannot drift apart — and the first load
  // happens exactly once instead of once per path.
  selectedDeviceId.value = candidate
})

watch(selectedDeviceId, (id) => {
  if (!id) return
  notice.value = ''
  devices.select(id)
  void devices.loadChannels(id)
  void trends.load(id)
  void router.replace({ path: '/trends', query: { ...route.query, device: id } })
})

// Keep the date inputs in step when the bounds change from outside them (the
// coverage shortcut, or a preset switch). Values typed by the user always parse
// back to themselves, so this cannot fight with typing.
watch(
  () => trends.customFrom,
  (value) => {
    const text = toDateTimeLocalValue(value)
    if (text !== customFromText.value) customFromText.value = text
  }
)

watch(
  () => trends.customTo,
  (value) => {
    const text = toDateTimeLocalValue(value)
    if (text !== customToText.value) customToText.value = text
  }
)

/**
 * The page owns no subscription, so there is nothing to release on unmount —
 * this is request/response only (see the store header). The one thing worth
 * cancelling is a pending debounce: it would otherwise fire a DuckDB query for a
 * page the user has already left. The loaded series is kept, so returning to the
 * page shows the last result immediately instead of an empty chart.
 */
onUnmounted(() => {
  trends.cancelPendingQuery()
})
</script>

<template>
  <div class="page">
    <!--
      这一页**没有页头**：外层框架的标题栏已经写了「历史趋势」，而「刷新 / 立即落盘」两个
      动作按产品要求搬进了下面那张卡片 —— 它们是与**这一组筛选条件**绑在一起的动作
      （刷新重查当前筛选、落盘把当前缓冲写进库），贴在筛选栏同一张卡片里比飘在页头更近。
    -->

    <p v-if="notice" class="alert alert--success" role="status">{{ notice }}</p>
    <p v-if="trends.error" class="alert alert--danger" role="alert">{{ trends.error }}</p>

    <EmptyState
      v-if="hasNoDevice"
      :title="t('trendsUi.noDeviceTitle')"
    >
      <RouterLink class="btn btn--primary" to="/devices">{{ t('trendsUi.goToDevices') }}</RouterLink>
    </EmptyState>

    <template v-else>
      <section class="card">
        <div class="filter-bar">
          <label class="field field--wide">
            <span class="field-label">{{ t('trendsUi.filterDevice') }}</span>
            <select v-model="selectedDeviceId" class="select">
              <option v-for="device in devices.devices" :key="device.id" :value="device.id">
                {{ device.name }}（{{ device.ip || t('trendsUi.noAddress') }}）
              </option>
            </select>
          </label>

          <label class="field">
            <span class="field-label">{{ t('trendsUi.filterChannel') }}</span>
            <select v-model="channelSelection" class="select">
              <option value="">{{ t('trendsUi.filterAllChannels') }}</option>
              <option v-for="channel in channelOptions" :key="channel.index" :value="String(channel.index)">
                {{ channelLabel(channel.index) }}
                <template v-if="channel.name">（{{ channel.name }}）</template>
                <!-- 未启用的通道照样可以查历史趋势（过去的数据仍在），但要看得出来它现在没开。 -->
                <template v-if="channel.state !== 'enabled'">（{{ t(channelStateLabelKey(channel.state)) }}）</template>
              </option>
            </select>
          </label>

          <label class="field">
            <span class="field-label">{{ t('trendsUi.filterMetric') }}</span>
            <select v-model="metricSelection" class="select">
              <option v-for="option in TREND_METRIC_OPTIONS" :key="option.key" :value="option.key">
                {{ trendMetricLabel(option.key) }}
              </option>
            </select>
          </label>

          <label class="field">
            <span class="field-label">{{ t('trendsUi.filterAggregation') }}</span>
            <select v-model="aggregationSelection" class="select">
              <option
                v-for="option in TREND_AGGREGATION_OPTIONS"
                :key="option.key"
                :value="option.key"
              >
                {{ trendAggregationLabel(option.key) }}
              </option>
            </select>
          </label>
        </div>

        <div class="range-bar">
          <div class="chip-row">
            <button
              v-for="preset in TREND_RANGE_OPTIONS"
              :key="preset.key"
              type="button"
              class="chip chip--selectable"
              :class="{ 'chip--accent': trends.range === preset.key }"
              @click="trends.setRange(preset.key)"
            >
              {{ t(preset.labelKey) }}
            </button>
          </div>

          <div v-if="trends.range === 'custom'" class="custom-range">
            <label class="field">
              <span class="field-label">{{ t('trendsUi.filterFrom') }}</span>
              <input
                v-model="customFromText"
                class="input"
                type="datetime-local"
                @input="applyCustomRange"
              />
            </label>
            <label class="field">
              <span class="field-label">{{ t('trendsUi.filterTo') }}</span>
              <input
                v-model="customToText"
                class="input"
                type="datetime-local"
                @input="applyCustomRange"
              />
            </label>
            <span v-if="customRangeIncomplete" class="field-hint">
              {{ t('trendsUi.incompleteRange') }}
            </span>
          </div>

          <!--
            刷新 / 立即落盘：产品要求与设备选择放在**同一张卡片**里。
            放在筛选栏末尾并推到右端（`.trend-actions`）——它们作用于整组筛选条件，
            不属于某一个下拉框。
          -->
          <div class="btn-row trend-actions">
            <button
              type="button"
              class="btn"
              :disabled="!selectedDeviceId || trends.loading"
              @click="refresh"
            >
              {{ trends.loading ? t('trendsUi.querying') : t('common.refresh') }}
            </button>
            <button type="button" class="btn" :disabled="flushing" @click="flushNow">
              {{ flushing ? t('settingsUi.trendFlushing') : t('settingsUi.trendFlushNow') }}
            </button>
          </div>
        </div>
      </section>

      <section v-if="trends.hasPoints" class="card-grid card-grid--stats">
        <div class="card">
          <MetricCard
            :label="t('trendsUi.latestBucket')"
            :value="trendValueText(trends.metric, latestBucket?.value ?? null)"
            :hint="latestBucket ? latestBucket.fullLabel : t('trendsUi.emptyBuckets')"
          />
        </div>
        <div class="card">
          <MetricCard
            :label="t('trendsUi.rangeMinBucket')"
            :value="trendValueText(trends.metric, rangeStats.min)"
            :hint="`${trendMetricLabel(trends.metric)}（${trendAggregationLabel(trends.aggregation)}）`"
          />
        </div>
        <div class="card">
          <MetricCard
            :label="t('trendsUi.rangeMaxBucket')"
            :value="trendValueText(trends.metric, rangeStats.max)"
            :hint="`${trendMetricLabel(trends.metric)}（${trendAggregationLabel(trends.aggregation)}）`"
          />
        </div>
        <!--
          The gap count is shown rather than hidden: an empty bucket means the
          device reported nothing in that window, which is a different fact from
          a reading of zero, and the chart draws it as a break for that reason.
        -->
        <div class="card">
          <MetricCard
            :label="t('trendsUi.emptyBuckets')"
            :value="String(gapCount)"
          />
        </div>
      </section>

      <section class="chart-panel card">
        <div class="section-header">
          <h3 class="section-title">{{ t('trendsUi.chartTitle') }}</h3>
          <span class="muted chart-hint">
            {{ deviceHint }} · {{ channelHint }} · {{ rangeText }}
          </span>
        </div>

        <p v-if="trends.series?.truncated" class="alert alert--warning" role="status">
          {{ t('trendsUi.truncated', { count: trends.points.length }) }}
        </p>

        <EmptyState
          v-if="noDeviceSelected"
          :title="t('trendsUi.noDeviceSelectedTitle')"
        />

        <EmptyState
          v-else-if="trends.deviceHasNoHistory"
          :title="t('trendsUi.noHistoryTitle')"
        >
          <RouterLink class="btn btn--primary" to="/monitor">{{ t('trendsUi.goToMonitor') }}</RouterLink>
        </EmptyState>

        <EmptyState
          v-else-if="trends.rangeIsEmpty"
          :title="t('trendsUi.emptyRangeTitle')"
        >
          <button v-if="coverageText" type="button" class="btn" @click="useCoverageRange">
            {{ t('trendsUi.coverageAvailable', { range: coverageText }) }}
          </button>
        </EmptyState>

        <EChart v-else :option="chartOption" height="360px" :placeholder="chartPlaceholder" />

        <dl v-if="trends.series" class="kv diagnostics">
          <div class="kv__item">
            <dt class="kv__label">{{ t('trendsUi.statPoints') }}</dt>
            <dd class="kv__value">{{ trends.points.length }}</dd>
          </div>
          <div class="kv__item">
            <dt class="kv__label">{{ t('trendsUi.statRows') }}</dt>
            <dd class="kv__value">{{ trends.series.totalRows }}</dd>
          </div>
          <div class="kv__item">
            <dt class="kv__label">{{ t('trendsUi.statBucket') }}</dt>
            <dd class="kv__value">{{ formatBucketSeconds(trends.series.bucketSeconds) }}</dd>
          </div>
          <div class="kv__item">
            <dt class="kv__label">{{ t('trendsUi.statFiles') }}</dt>
            <dd class="kv__value">{{ trends.series.filesScanned }}</dd>
          </div>
          <div class="kv__item">
            <dt class="kv__label">{{ t('trendsUi.statDuration') }}</dt>
            <dd class="kv__value">{{ formatDuration(trends.series.durationMs) }}</dd>
          </div>
          <div class="kv__item">
            <dt class="kv__label">{{ t('trendsUi.statRatio') }}</dt>
            <dd class="kv__value">{{ reductionText }}</dd>
          </div>
        </dl>
      </section>
    </template>
  </div>
</template>

<style scoped>
/*
 * 设备下拉按产品要求**收窄**。
 *
 * 只写 `min-width` 是不够的（第一次就是这么写的，实测仍然是 375px）：`<select>` 默认按
 * **最宽的选项**决定自己的宽度，而这里的选项是「设备名（IP 地址）」，于是它一个人占掉
 * 筛选栏接近一半。所以宽度要直接钉在 select 上。
 *
 * 200px：够放一个常见长度的设备名，IP 会被截断 —— 但那没关系，**展开的选项列表不受
 * 控件宽度限制**，选的时候看得全。
 */
.field--wide {
  min-width: 0;
  flex: 0 0 auto;
}

.field--wide .select {
  width: 200px;
  max-width: 200px;
}

/*
 * 刷新 / 立即落盘（产品要求与设备选择同一张卡片）。
 * `margin-left: auto` 把它们推到筛选栏右端：它们作用于**整组**筛选条件，不属于某一个
 * 下拉框，所以不跟着某个 field 走。
 */
.trend-actions {
  margin-left: auto;
  align-self: flex-end;
}

.aggregation-hint {
  margin-top: 6px;
}

.range-bar {
  display: flex;
  align-items: flex-end;
  gap: var(--space-4);
  flex-wrap: wrap;
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
}

.custom-range {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.chip--selectable {
  cursor: pointer;
  font-family: inherit;
}

.chip--selectable:hover {
  border-color: var(--color-border-strong);
}

.chart-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.chart-hint {
  font-size: 11.5px;
}

.diagnostics {
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
}

.diagnostics-note {
  font-size: 11.5px;
}
</style>
