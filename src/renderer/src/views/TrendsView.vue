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
import type { TrendMetric } from '@shared/ipc/contract'
import { CHANNEL_COUNT } from '@shared/domain/models'
import {
  TREND_METRIC_MAX_SELECTED,
  TREND_RANGE_OPTIONS,
  useTrendsStore
} from '@renderer/stores/trends'
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
  trendChannelColor,
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
/**
 * 量可以**多选**（业主 2026-09-18 追加要求：「这些数值的趋势变化的同时显示」）。
 *
 * 每个选中的量各画**一张图**，而不是把它们叠进一张图：四个量里只有声压级是 dB，另外三个
 * 是无量纲比值；共用一根 Y 轴时，一条 62 dB 的线与一条 0.31 的比值线之间的高低关系是
 * **刻度造出来的**，不是数据说的。并排多图让每一根轴各自有意义（见文件头）。
 */
function toggleMetric(targetMetric: TrendMetric): void {
  trends.toggleMetric(targetMetric)
}

const aggregationSelection = computed({
  get: () => trends.aggregation as string,
  set: (value: string) => {
    const option = TREND_AGGREGATION_OPTIONS.find((item) => item.key === value)
    if (!option) return
    trends.aggregation = option.key
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

/**
 * 把通道表灌进 store（它不知道设备有哪些通道）。
 *
 * `immediate: true` 是为了"一进这一页就有图"：`selectedDeviceId` 可能是从地址栏来的，
 * 那时通道表已经在了，但 store 还是空的 —— 只在变化时灌会漏掉第一次。
 */
watch(
  channelOptions,
  (list) => trends.setChannels(list.map((channel) => channel.index)),
  { immediate: true }
)

/**
 * 图例：一条通道一格，颜色与图上那条线**同一个来源**（`trendChannelColor`），
 * 点一下切换"画不画它"。
 *
 * 值取**主量 × 这条通道**的最后一个非空时间桶：图例上给一个数比只给名字有用得多
 * （"哪条通道现在高"是看图时的第一个问题）。没有数据时是 `—`，不是 0。
 */
interface ChannelLegendEntry extends ChannelOption {
  color: string
  visible: boolean
  value: number | null
}

const channelLegend = computed<ChannelLegendEntry[]>(() =>
  channelOptions.value.map((channel) => {
    const series = trends.seriesFor(trends.metrics[0] ?? trends.metric, channel.index)
    let latest: number | null = null
    for (const point of series?.points ?? []) {
      if (Number.isFinite(point.value)) latest = point.value
    }
    return {
      ...channel,
      color: trendChannelColor(channel.index),
      visible: trends.isChannelVisible(channel.index),
      value: latest
    }
  })
)

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

/**
 * 筛选行上那句提示：现在说的是**几条通道在图上**，不是一个下拉框的值。
 *
 * 原来的写法是"全部通道 / 通道 N" —— 通道选择变成一排可点亮的通道名之后，
 * 「全部通道」这句话不再对应任何一个控件，留着它比删掉更糟（读者会去找那个下拉）。
 */
const channelHint = computed(() =>
  t('trendsUi.channelHintVisible', {
    shown: trends.visibleChannelIds.length,
    total: trends.channelIds.length
  })
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
 * 一张图的全部输入：一个量 + 这个设备的每条**可见**通道。
 *
 * 时间轴用**所有通道并集**的时间戳（`timestamps`）：各通道的桶边界由主进程按同一个
 * from/to 与同一个 `bucketSeconds` 选出，正常情况下是一致的；用并集是为了在某个通道
 * 少几个桶时，其余通道的线**不会整体错位半格**（错位会让两条线看起来差了一个采样周期）。
 */
interface TrendChartBundle {
  metric: TrendMetric
  /** 时间轴标签（与 `timestamps` 同序）。 */
  labels: string[]
  /** 完整时间戳（提示里用）。 */
  timestamps: number[]
  /** 每条可见通道一行数据（与 `labels` 同序，缺口是 `null`）。 */
  lines: { index: number; name: string; color: string; values: (number | null)[] }[]
  /** 这一张图上有没有任何非空值（没有时画布给一句空态，而不是一根空轴）。 */
  hasValue: boolean
  /** 每条可见通道在范围内报了几个时间桶（诊断与提示里用）。 */
  gapCount: number
}

function buildBundle(targetMetric: TrendMetric): TrendChartBundle {
  const seriesList = trends.visibleChannelIds.map((index) => ({
    index,
    series: trends.seriesFor(targetMetric, index)
  }))

  // 时间戳并集，升序。
  const stampSet = new Set<number>()
  for (const entry of seriesList) {
    for (const point of entry.series?.points ?? []) stampSet.add(point.timestamp)
  }
  const timestamps = [...stampSet].sort((left, right) => left - right)
  const labels = timestamps.map((stamp) => formatTrendTick(stamp, spanMs.value))

  const lines = seriesList.map((entry) => {
    const byStamp = new Map<number, number>()
    for (const point of entry.series?.points ?? []) {
      byStamp.set(point.timestamp, Number.isFinite(point.value) ? point.value : NaN)
    }
    const channel = channelOptions.value.find((item) => item.index === entry.index)
    return {
      index: entry.index,
      // 图例/提示里的名字用**通道名**（有就用，没有就用通道号），与图例那一行一致。
      name: channel?.name ? `${channelLabel(entry.index)}（${channel.name}）` : channelLabel(entry.index),
      color: trendChannelColor(entry.index),
      values: timestamps.map((stamp) => {
        const value = byStamp.get(stamp)
        // 缺口（没报这个桶）保持 null：绝不画成 0。
        return value === undefined || Number.isNaN(value) ? null : value
      })
    }
  })

  let gapCount = 0
  for (const line of lines) {
    for (const value of line.values) if (value === null) gapCount += 1
  }

  return {
    metric: targetMetric,
    labels,
    timestamps,
    lines,
    hasValue: lines.some((line) => line.values.some((value) => value !== null)),
    gapCount
  }
}

/** 每个选中的量一张图（业主追加要求：多个量同时显示）。 */
const chartBundles = computed<TrendChartBundle[]>(() =>
  trends.metrics.map((item) => buildBundle(item))
)

/**
 * ECharts tooltip。`params` 的类型是 `unknown`，在这里就地收窄：选项对象是宽松类型的
 * `EChartsCoreOption`，而"这个桶里有几个采样点"从 bundle 里按索引读，序列数据因此可以
 * 保持成纯数字数组。
 *
 * 一个桶里**每条可见通道一行**：这正是"多条通道叠在一根轴上"之后提示要回答的问题
 * —— 同一个时刻，八条通道各是多少。
 */
interface TrendTooltipParam {
  dataIndex: number
  seriesName?: string
}

function trendTooltipFor(bundle: TrendChartBundle) {
  return (params: unknown): string => {
    const list = Array.isArray(params)
      ? (params as TrendTooltipParam[])
      : [params as TrendTooltipParam]
    const first = list[0]
    if (!first) return ''
    const stamp = bundle.timestamps[first.dataIndex]
    if (stamp === undefined) return ''

    const head = `<div style="font-weight:600">${formatDateTime(stamp)}</div>`
    const title = `${trendMetricLabel(bundle.metric)}（${trendAggregationLabel(trends.aggregation)}）`
    const rows = bundle.lines
      .filter((line) => line.values[first.dataIndex] !== undefined)
      .map((line) => {
        const value = line.values[first.dataIndex] ?? null
        const text =
          value === null
            ? t('trendsUi.noDataInBucket', { value: EMPTY_VALUE })
            : trendValueText(bundle.metric, value)
        // 色块与图上那条线同一个颜色：多通道时提示里也必须一眼对上是哪一条。
        return (
          `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;` +
          `background:${line.color};margin-right:5px"></span>${line.name}：${text}`
        )
      })
    return [head, title, ...rows].join('<br/>')
  }
}

/**
 * ECharts draws to a canvas, so it cannot read the CSS custom properties in
 * `main.css`; these four constants mirror those tokens (same approach as
 * MonitorView).
 */
const AXIS_LINE = '#E5E7EB'
const SPLIT_LINE = '#F1F1F2'
const TEXT_SECONDARY = '#6B7280'

/**
 * 一个量一张图。**每条可见通道一条线**，颜色来自 `trendChannelColor`（与图例同一个来源），
 * 全部落在**同一根坐标轴**上 —— 这正是业主那句"用不同颜色的折线将多个通道的信号显示在
 * 同一个坐标轴上"。
 *
 * 「不知道通道」时（设备没返回通道表）`visibleChannelIds` 是空的，`bundle.lines` 也就是空的；
 * 那条情况仍然由 `series` 画一条聚合线（见下面的 `fallbackOption`）。
 */
function chartOptionFor(bundle: TrendChartBundle): EChartsCoreOption {
  const meta = TREND_METRIC_META[bundle.metric]
  const axisName = trendAxisName(bundle.metric, trends.aggregation)
  const tickFormatter = meta.tickFormatter
  const pointCount = bundle.labels.length

  return {
    // Real measurements, not a dashboard toy: an animated line implies the data
    // is live and makes a bucket boundary impossible to read.
    animation: false,
    grid: { left: 58, right: 18, top: 34, bottom: 30 },
    tooltip: { trigger: 'axis', formatter: trendTooltipFor(bundle) },
    // ECharts 自带的图例在这里**关掉**：图例是页面上的那一排通道按钮（点一下切换
    // 显示/隐藏），两处各画一份的话，用户会看到两个"看起来一样但行为不同"的图例。
    legend: { show: false },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: bundle.labels,
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
    series: bundle.lines.map((line) => ({
      name: line.name,
      type: 'line',
      // Symbols are only drawn on a series short enough that an isolated
      // bucket would otherwise be invisible; a 500-point line stays clean.
      showSymbol: pointCount <= 300,
      symbolSize: 3,
      // Gaps stay gaps: never bridge across a bucket the device did not report.
      connectNulls: false,
      data: line.values,
      lineStyle: { width: 1.6, color: line.color },
      itemStyle: { color: line.color }
    }))
  }
}

/**
 * 「设备没返回通道表」时那一条线（原来的单序列行为）。
 *
 * 保留它是因为那种设备上**没有可叠加的通道**，而"一条聚合线"仍然回答了"这段时间怎么样"。
 */
const fallbackOption = computed<EChartsCoreOption>(() => {
  const rows = chartRows.value
  const meta = TREND_METRIC_META[trends.metric]
  const axisName = trendAxisName(trends.metric, trends.aggregation)
  const tickFormatter = meta.tickFormatter

  return {
    animation: false,
    grid: { left: 58, right: 18, top: 34, bottom: 30 },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown): string => {
        const list = Array.isArray(params)
          ? (params as TrendTooltipParam[])
          : [params as TrendTooltipParam]
        const first = list[0]
        if (!first) return ''
        const row = rows[first.dataIndex]
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
    },
    legend: { show: false },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: rows.map((row) => row.label),
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisTick: { show: false },
      axisLabel: { color: TEXT_SECONDARY, fontSize: 10, hideOverlap: true }
    },
    yAxis: {
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
        showSymbol: rows.length <= 300,
        symbolSize: 3,
        connectNulls: false,
        data: rows.map((row) => row.value),
        lineStyle: { width: 1.6, color: trendChannelColor(0) },
        itemStyle: { color: trendChannelColor(0) }
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

          <!--
            通道：**不是一个下拉框，而是一排可以点亮的通道名**（业主 2026-09-18 追加要求：
            「只是通过点击通道名称实现是显示这个通道还是隐藏这个通道」）。
            点一下只改"画哪几条线"，不重新查库（数据已经一次全取回来了）。
            色点与图上那条线同一个颜色来源。
          -->
          <div class="field field--channels">
            <span class="field-label">{{ t('trendsUi.filterChannel') }}</span>
            <div class="chip-row" data-channel-legend>
              <button
                v-for="channel in channelLegend"
                :key="channel.index"
                type="button"
                class="chip chip--selectable channel-chip"
                :class="{ 'chip--accent': channel.visible, 'channel-chip--off': !channel.visible }"
                :data-channel-toggle="channel.index"
                :aria-pressed="channel.visible"
                :title="
                  channel.visible ? t('trendsUi.channelHide') : t('trendsUi.channelShow')
                "
                @click="trends.toggleChannel(channel.index)"
              >
                <span
                  class="channel-chip__dot"
                  :style="{ background: channel.color }"
                  aria-hidden="true"
                ></span>
                {{ channelLabel(channel.index) }}
                <template v-if="channel.name">（{{ channel.name }}）</template>
                <template v-if="channel.state !== 'enabled'">
                  （{{ t(channelStateLabelKey(channel.state)) }}）
                </template>
                <span class="muted channel-chip__value">
                  {{ channel.value === null ? '—' : trendValueText(trends.metric, channel.value) }}
                </span>
              </button>
              <button
                v-if="channelLegend.length > 1"
                type="button"
                class="chip chip--selectable"
                data-channel-show-all
                @click="trends.showAllChannels()"
              >
                {{ t('trendsUi.channelShowAll') }}
              </button>
            </div>
          </div>

          <!--
            量可以**多选**：选中的量各画一张图（见 `chartBundles` 与文件头）。
            最后一个量点不掉，满 4 个之后其余的会置灰 —— 两个上限都在 store 里判，
            这里只把它画出来（第二处判断迟早与第一处不一致）。
          -->
          <div class="field field--metrics">
            <span class="field-label">{{ t('trendsUi.filterMetric') }}</span>
            <div class="chip-row" data-metric-picker>
              <button
                v-for="option in TREND_METRIC_OPTIONS"
                :key="option.key"
                type="button"
                class="chip chip--selectable"
                :class="{ 'chip--accent': trends.isMetricSelected(option.key) }"
                :data-metric-toggle="option.key"
                :aria-pressed="trends.isMetricSelected(option.key)"
                :disabled="
                  !trends.isMetricSelected(option.key) &&
                  trends.metrics.length >= TREND_METRIC_MAX_SELECTED
                "
                :title="
                  !trends.isMetricSelected(option.key) &&
                  trends.metrics.length >= TREND_METRIC_MAX_SELECTED
                    ? t('trendsUi.metricLimit', { count: TREND_METRIC_MAX_SELECTED })
                    : undefined
                "
                @click="toggleMetric(option.key)"
              >
                {{ trendMetricLabel(option.key) }}
              </button>
            </div>
            <span v-if="trends.metrics.length > 1" class="field-hint">
              {{ t('trendsUi.metricMultiHint', { count: trends.metrics.length }) }}
            </span>
          </div>

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

        <!--
          一个选中的量一张图（业主追加要求："同时显示"）。每张图里是**所有可见通道**的折线，
          颜色与图例同一个来源。原来那种"一条聚合线"只在设备没返回通道表时用（`fallbackOption`）。
        -->
        <template v-else-if="trends.visibleChannelIds.length > 0">
          <div
            v-for="bundle in chartBundles"
            :key="bundle.metric"
            class="metric-chart"
            :data-metric-chart="bundle.metric"
          >
            <div class="section-header">
              <h4 class="section-title">{{ trendMetricLabel(bundle.metric) }}</h4>
              <span class="muted chart-hint">
                {{ trendAxisName(bundle.metric, trends.aggregation) }} ·
                {{ t('trendsUi.channelLines', { count: bundle.lines.length }) }}
              </span>
            </div>
            <!--
              这一张图上一条非空值都没有时给一句空态，而不是画一根空轴 ——
              空轴看起来像"图上什么都没有"，而实事是"这个量在这段时间里没有读数"。
            -->
            <p v-if="!bundle.hasValue" class="muted" :data-metric-empty="bundle.metric">
              {{ t('trendsUi.metricNoData') }}
            </p>
            <EChart
              v-else
              :option="chartOptionFor(bundle)"
              height="320px"
              :placeholder="chartPlaceholder"
            />
          </div>
        </template>

        <EChart v-else :option="fallbackOption" height="360px" :placeholder="chartPlaceholder" />

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
          <!--
            「发了几条查询」在叠加模式下是一个**必须显示**的数字：一次筛选变更会打出
            `量 × 通道` 条 IPC（4 个量 × 16 通道 = 64 条）。看不见它的话，页面变慢时
            没人知道原因在这里。
          -->
          <div class="kv__item">
            <dt class="kv__label">{{ t('trendsUi.statQueries') }}</dt>
            <dd class="kv__value">{{ trends.queriedCount }}</dd>
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

/*
 * 通道那一排（可点亮的通道名）。
 *
 * 它比一个下拉框宽得多（8 条通道 = 8 个 chip，16 通道更多），所以给一个**上限宽度**并允许
 * 换行：挤成一行会把「刷新 / 立即落盘」两个按钮推出筛选栏。
 */
.field--channels,
.field--metrics {
  min-width: 0;
  flex: 1 1 100%;
}

.field--channels .chip-row,
.field--metrics .chip-row {
  flex-wrap: wrap;
  row-gap: 6px;
}

.channel-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/*
 * 被点掉的通道：整块降到次要色。**留一个色点在外**（点仍然是有颜色的）会让"隐藏"看起来
 * 像"只是字变淡了"，而图上少了一条线是件明确的事。
 */
.channel-chip--off {
  opacity: 0.55;
}

.channel-chip__dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
}

.channel-chip__value {
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}

/* 一个量一张图：图之间用空隙分开，不画分隔线（它们本来就是独立的两张图）。 */
.metric-chart + .metric-chart {
  margin-top: var(--space-4);
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
