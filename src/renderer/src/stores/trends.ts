/**
 * Historical trend store (Phase 11, spec §12.2).
 *
 * REQUEST/RESPONSE ONLY — NO PUSH SUBSCRIPTION
 * Unlike `monitor.ts`, this store deliberately does NOT touch `window.events`.
 * History is stored data, not a live feed: nothing in the main process can
 * change a completed query's answer, so there is no push channel to subscribe
 * to, no unsubscriber to leak, and therefore no unmount contract on the page
 * that renders it. Every value here arrives as the answer to a
 * `window.api.trends.*` call.
 *
 * WHY THE DEBOUNCE IS MANDATORY
 * A date picker emits an `input` event per keystroke, and each keystroke maps to
 * a real DuckDB scan over Parquet files. Without a debounce, dragging a date
 * field would launch a dozen concurrent queries and the last one to finish —
 * not the last one sent — would win. So filter changes are coalesced over
 * `TREND_QUERY_DEBOUNCE_MS`, and every run carries a monotonic token
 * (`querySeq`, the same pattern as `monitor.ts`'s `sessionSeq`) so a response
 * that arrives after a newer request is DISCARDED instead of overwriting fresh
 * data with stale data.
 *
 * WHY THE BUCKET SIZE IS NOT CHOSEN HERE
 * `chooseBucketSeconds()` lives in the main-process query service and is applied
 * in SQL. A month of one channel at 1 Hz is 2.6 million rows; the renderer must
 * never receive them, so this store sends `from`/`to` and renders whatever
 * bucketed series comes back. It does not downsample again.
 *
 * House style (same as `monitor.ts` / `devices.ts`): no action ever throws.
 * Every IPC failure is funnelled through `callApi` + `resultMessage` into a
 * human-readable Chinese `error` string (spec 14.2), so the view renders without
 * defensive try/catch.
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  TrendAggregation,
  TrendCoverage,
  TrendMetric,
  TrendPoint,
  TrendQueryBody,
  TrendSeries,
  TrendStorageStats
} from '@shared/ipc/contract'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { i18n } from '@renderer/i18n'
import { TREND_METRIC_OPTIONS } from '@renderer/lib/trendMetrics'
import { TREND_METRIC_MAX_SELECTED } from '@shared/domain/trend'
import {
  TREND_GRANULARITY_DEFAULT_KEY,
  granularityBucketSeconds,
  granularityOption
} from '@shared/domain/trend-granularity'

/**
 * 量的稳定顺序（与下拉/图例的排列同一个来源，不另抄一份）。
 *
 * `TREND_METRIC_MAX_SELECTED` 来自 `shared/domain/trend.ts`：它是纯值，放在那边单测
 * 才 import 得到（单测编译不到 `src/renderer/**`，见那个常量的注释）。
 */
const TREND_METRIC_ORDER: readonly TrendMetric[] = TREND_METRIC_OPTIONS.map((item) => item.key)

export { TREND_METRIC_MAX_SELECTED }

/**
 * Range presets. The KEY is stored, and `from`/`to` are resolved at QUERY time:
 * "最近 1 小时" must mean the last hour from the moment the query runs, not the
 * hour that ended when the user opened the page.
 */
export type TrendRangePreset = '1h' | '24h' | '7d' | '30d' | 'custom'

export interface TrendRangeOption {
  key: TrendRangePreset
  /**
   * Translation key, not the rendered label.
   *
   * The preset list is built once at module scope, so a rendered string would
   * freeze at the startup language and the range chips would not follow a
   * language change.
   */
  labelKey: string
  /** Span from "now"; absent for the custom range, which uses the date inputs. */
  spanMs?: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const TREND_RANGE_OPTIONS: readonly TrendRangeOption[] = [
  { key: '1h', labelKey: 'rangeExtra.label1h', spanMs: HOUR },
  { key: '24h', labelKey: 'rangeExtra.label24h', spanMs: DAY },
  { key: '7d', labelKey: 'rangeExtra.label7d', spanMs: 7 * DAY },
  { key: '30d', labelKey: 'rangeExtra.label30d', spanMs: 30 * DAY },
  // No span: a custom range is taken from `customFrom` / `customTo`.
  { key: 'custom', labelKey: 'rangeExtra.labelCustom' }
]

/**
 * Filter-change coalescing window.
 *
 * 300 ms is long enough that typing a date does not launch a query per
 * keystroke, and short enough that a preset click still feels immediate.
 */
export const TREND_QUERY_DEBOUNCE_MS = 300

/** Fallback span when 自定义 is selected before any coverage is known. */
const DEFAULT_CUSTOM_SPAN_MS = DAY

export const useTrendsStore = defineStore('trends', () => {
  // -------------------------------------------------------------------------
  // Query state
  // -------------------------------------------------------------------------

  const deviceId = ref('')
  /** `undefined` means 全部通道 — the query omits `channelId` entirely. */
  const channelId = ref<number | undefined>(undefined)
  const metric = ref<TrendMetric>('spl')
  /**
   * 一个时间桶**里面**怎么算。
   *
   * ⚠ 业主 2026-09-19 第 13 批第 5 条删掉了「聚合方式」那个下拉框，所以这个值**在界面上不可改**：
   * 它固定是平均。保留成 ref（而不是常量）是因为契约里它仍然是一个字段、后端也仍然按它算，
   * 而且 Y 轴名字里照旧写着「（平均）」—— 删的是"让操作员选"，不是"这件事不存在"。
   */
  const aggregation = ref<TrendAggregation>('avg')
  /**
   * X 轴的时间颗粒度（业主第 5 条：「X 轴支持自定义缩放时间颗粒度」）。
   *
   * 存的是 `TREND_GRANULARITY_OPTIONS` 的 key（默认 'auto' = 由主进程按跨度挑）。
   * 桶越窄越接近原始读数，越宽趋势越清楚 —— 它是"这张图有多细"这件事的唯一控件。
   */
  const granularity = ref<string>(TREND_GRANULARITY_DEFAULT_KEY)
  const range = ref<TrendRangePreset>('24h')
  /** Custom bounds, epoch ms. Resolved only when `range === 'custom'`. */
  const customFrom = ref<number | undefined>(undefined)
  const customTo = ref<number | undefined>(undefined)

  // -------------------------------------------------------------------------
  // 多通道叠加 + 多量并排（业主 2026-09-18 的追加要求）
  // -------------------------------------------------------------------------

  /**
   * 要**同时**显示的量，至少一个。第一个是"主量"：汇总卡片与诊断行按它渲染。
   *
   * 业主点名的四个量是 声压级 / 平稳度 / 频带能量比 / 奇偶次谐波能量比。四个都选上时
   * 是**四张图**（每张图一个量），不是一张图四条不同单位的线 —— 声压级是 dB、
   * 另外三个是无量纲比值，共用一根 Y 轴会让刻度失去意义（见 TrendsView 的文件头）。
   */
  const metrics = ref<TrendMetric[]>(['spl'])

  /**
   * 这个设备有哪些通道（视图从设备的通道表灌进来）。
   *
   * **空数组 = 还不知道通道**，那时退回原来的行为：一条聚合线（`channelId` 的语义）。
   * 有通道信息时，图上就是"每条通道一条线"。
   */
  const channelIds = ref<number[]>([])

  /**
   * 被点掉（隐藏）的通道。
   *
   * **它是纯显示状态，不触发查询**：这是业主那句"只是通过点击通道名称实现是显示这个通道
   * 还是隐藏这个通道"的字面要求 —— 点一下只改画哪几条线，不去重新扫一遍 Parquet。
   * 数据在查询时**一次把该设备的每条通道都取回来**（所以点开是瞬时的）。
   */
  const hiddenChannelIds = ref<number[]>([])

  /**
   * 叠加的每一条序列：键是 `` `${metric}:${channel}` ``。
   *
   * 键是字符串而不是嵌套对象：查起来是一处 `[]`，而且序列化、比较、日志都直观。
   */
  const channelSeries = ref<Record<string, TrendSeries | null>>({})

  /** 上一次查询实际发了几条 IPC（诊断行会显示它，见 `trendsUi.statQueries`）。 */
  const queriedCount = ref(0)

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  const series = ref<TrendSeries | null>(null)
  const coverage = ref<TrendCoverage | null>(null)
  const stats = ref<TrendStorageStats | null>(null)
  const loading = ref(false)
  const error = ref('')

  /**
   * The from/to of the most recent query.
   *
   * Kept as state rather than recomputed from the preset because a preset is
   * relative to "now": the axis and the empty-state text must describe the span
   * the user is actually looking at, not a new span computed at render time.
   */
  const queriedFrom = ref<number | null>(null)
  const queriedTo = ref<number | null>(null)

  // -------------------------------------------------------------------------
  // Request bookkeeping
  // -------------------------------------------------------------------------

  /** Monotonic token; a response from an older token must never be applied. */
  let querySeq = 0
  /**
   * The same guard for coverage.
   *
   * Coverage is device-scoped, and a fast device switch can resolve the two
   * requests out of order: without a token the older device's files/range would
   * be applied to the newer one, which would make the page claim a range the
   * device never recorded. The captured device id is a second, independent check.
   */
  let coverageSeq = 0
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * 这一轮查询里第一条失败的原文（循环结束后统一报一次）。
   *
   * 不让每条失败都直接写 `error`：叠加模式下有 N 条，"最后一条赢"会把第一条的原文
   * 顶掉，而第一条往往才是真正的原因（比如整个目录不可读）。
   */
  const lastFailure = ref('')

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  const points = computed<TrendPoint[]>(() => series.value?.points ?? [])
  const hasPoints = computed(() => points.value.length > 0)

  /** True when the device has no stored history at all (`files === 0`). */
  const deviceHasNoHistory = computed(
    () => coverage.value !== null && coverage.value.files === 0
  )

  /** True when the device has Parquet files but none in the selected range. */
  const rangeIsEmpty = computed(
    () =>
      // Coverage must be KNOWN: without it, "nothing in range" and "could not
      // read the directory" are indistinguishable, and claiming the former
      // would be a guess dressed up as a diagnosis.
      coverage.value !== null &&
      series.value !== null &&
      points.value.length === 0 &&
      !deviceHasNoHistory.value
  )

  /** The stored range, when the backend could determine one. */
  const coverageBounds = computed<{ from: number; to: number } | null>(() => {
    const current = coverage.value
    if (!current || current.from === undefined || current.to === undefined) return null
    return { from: current.from, to: current.to }
  })

  /** 当前**画在图上**的通道（`channelIds` 去掉被点掉的）。 */
  const visibleChannelIds = computed(() =>
    channelIds.value.filter((id) => !hiddenChannelIds.value.includes(id))
  )

  /** 一个量 × 一条通道的那一条序列，没查过/查失败时是 `null`。 */
  function seriesFor(targetMetric: TrendMetric, channel: number): TrendSeries | null {
    return channelSeries.value[`${targetMetric}:${channel}`] ?? null
  }

  // -------------------------------------------------------------------------
  // Range resolution
  // -------------------------------------------------------------------------

  /**
   * Turn the stored preset into concrete bounds.
   *
   * Returns undefined while a custom range is incomplete — that is a transient
   * input state, not an error, so no message is raised for it. An INVERTED range
   * is a real user mistake and is reported.
   */
  function resolveRange(): { from: number; to: number } | undefined {
    if (range.value === 'custom') {
      const from = customFrom.value
      const to = customTo.value
      if (from === undefined || to === undefined) return undefined
      if (from > to) {
        error.value = i18n.global.t('rangeExtra.errRangeOrder')
        return undefined
      }
      return { from, to }
    }

    const option = TREND_RANGE_OPTIONS.find((item) => item.key === range.value)
    const span = option?.spanMs ?? DEFAULT_CUSTOM_SPAN_MS
    const to = Date.now()
    return { from: to - span, to }
  }

  /** Seed the custom bounds so switching to 自定义 never shows an empty form. */
  function seedCustomRange(): void {
    const bounds = coverageBounds.value
    if (bounds) {
      customFrom.value = bounds.from
      customTo.value = bounds.to
      return
    }
    const to = Date.now()
    customTo.value = to
    customFrom.value = to - DEFAULT_CUSTOM_SPAN_MS
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Point the page at a device and load its coverage, then query.
   *
   * Coverage is loaded FIRST because the two empty states it distinguishes —
   * "this device has never recorded anything" versus "nothing in this range" —
   * cannot be told apart from an empty series alone.
   */
  async function load(targetDeviceId: string): Promise<void> {
    const changed = targetDeviceId !== deviceId.value
    deviceId.value = targetDeviceId

    if (changed) {
      // A different device's series must never be shown while the new one loads.
      series.value = null
      coverage.value = null
      queriedFrom.value = null
      queriedTo.value = null
      error.value = ''
    }

    if (!targetDeviceId) {
      cancelPendingQuery()
      return
    }

    await loadCoverage()
    // If another `load()` superseded this one while coverage was in flight, the
    // query belongs to that newer call — issuing it here would double the work.
    if (deviceId.value !== targetDeviceId) return
    query({ immediate: true })
  }

  /**
   * Schedule a bucketed query.
   *
   * Debounced by default; `immediate` (the 刷新 button, a coverage-range
   * shortcut) runs now and cancels any pending schedule so the user cannot end
   * up with two identical queries in flight.
   */
  function query(options: { immediate?: boolean } = {}): void {
    cancelPendingQuery()
    if (options.immediate) {
      void runQuery()
      return
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      void runQuery()
    }, TREND_QUERY_DEBOUNCE_MS)
  }

  /** Drop a scheduled (not yet started) query; used on unmount. */
  function cancelPendingQuery(): void {
    if (debounceTimer === undefined) return
    clearTimeout(debounceTimer)
    debounceTimer = undefined
  }

  /** The actual query. Never called directly by a view. */
  async function runQuery(): Promise<void> {
    const target = deviceId.value
    // No device is an empty state rendered by the page, not an error.
    if (!target) return

    const bounds = resolveRange()
    if (!bounds) return

    // A newer request invalidates every older one; the token is taken BEFORE the
    // await so two overlapping calls can never both apply their result.
    const seq = (querySeq += 1)
    loading.value = true
    queriedFrom.value = bounds.from
    queriedTo.value = bounds.to

    /**
     * 一条查询。失败时返回 `null` 并**不**立刻写 `error`：叠加模式下有 N 条，
     * 让最后一条覆盖前面的错误信息只会误导；错误在循环结束后统一报一次。
     */
    const queryOne = async (
      targetMetric: TrendMetric,
      targetChannel: number | undefined
    ): Promise<TrendSeries | null> => {
      const body: TrendQueryBody = {
        deviceId: target,
        metric: targetMetric,
        from: bounds.from,
        to: bounds.to,
        aggregation: aggregation.value,
        // 颗粒度：'auto' 时**不发这个字段**（主进程按跨度挑），否则发这一档的秒数。
        ...(granularityBucketSeconds(granularity.value) !== undefined
          ? { bucketSeconds: granularityBucketSeconds(granularity.value) }
          : {}),
        // 全部通道 omits the field: the main process then aggregates every channel
        // instead of silently defaulting to CH1.
        ...(targetChannel !== undefined ? { channelId: targetChannel } : {})
      }
      const result = await callApi(() => window.api.trends.query(body))
      if (!result.success) {
        lastFailure.value = resultMessage(result)
        return null
      }
      lastFailure.value = ''
      return unwrap(result) ?? null
    }

    let sent = 0

    /*
     * 两种情况：
     *   · **知道通道** → 每个选中的量 × **每条**通道各查一条（业主的附加要求：
     *     多条通道叠在同一根坐标轴上、用不同颜色区分）。全部通道都取回来，
     *     这样"点通道名隐藏"是纯显示操作，不需要再查一次。
     *   · **不知道通道**（设备没返回通道表）→ 退回原来的单条查询（`channelId` 的语义：
     *     某一条通道，或"全部通道"的聚合）。这时图上只有一条线，没有可叠加的东西。
     */
    const overlay: Record<string, TrendSeries | null> = {}
    if (channelIds.value.length > 0) {
      for (const targetMetric of metrics.value) {
        for (const channel of channelIds.value) {
          const one = await queryOne(targetMetric, channel)
          sent += 1
          // 新的一次查询已经接管：这一条的结果直接丢掉，不再往下发。
          if (seq !== querySeq) return
          overlay[`${targetMetric}:${channel}`] = one
        }
      }
      channelSeries.value = overlay
      // `series` 仍然指向**主量 × 第一条通道**：汇总卡片与诊断行按它渲染，
      // 页面上其它既有的空态判定（有没有历史、范围内是否为空）也认它。
      const primaryMetric = metrics.value[0] ?? metric.value
      series.value = overlay[`${primaryMetric}:${channelIds.value[0]}`] ?? null
    } else {
      // 主量一定有值（`toggleMetric` 不允许把最后一个点掉），但类型上还是要取一次。
      const primaryMetric = metrics.value[0] ?? metric.value
      const one = await queryOne(primaryMetric, channelId.value)
      sent += 1
      if (seq !== querySeq) return
      channelSeries.value = {}
      series.value = one
    }

    queriedCount.value = sent
    loading.value = false

    if (lastFailure.value !== '') {
      error.value = lastFailure.value
      if (series.value === null) channelSeries.value = {}
      return
    }
    error.value = ''
  }

  /** Select a preset. Custom bounds are seeded from coverage when missing. */
  function setRange(preset: TrendRangePreset): void {
    range.value = preset
    if (preset === 'custom' && (customFrom.value === undefined || customTo.value === undefined)) {
      seedCustomRange()
    }
    query()
  }

  /**
   * 换一档时间颗粒度（业主第 5 条：「X 轴支持自定义缩放时间颗粒度」）。
   *
   * 认不出来的 key **不写**（与 `channelState()` 拒绝把"没读到"当"已启用"同一条规矩）：
   * 一个拼错的 key 会让"点了一下什么都没发生"变成"桶宽变成了某个没人知道的数"。
   */
  function setGranularity(key: string): void {
    if (!granularityOption(key)) return
    if (granularity.value === key) return
    granularity.value = key
    query()
  }

  /**
   * 这个量在不在"同时显示"的那一组里。
   *
   * **至少留一个**：全关掉之后图上什么都没有，而"空图"看起来像"这个设备没有历史" ——
   * 那是界面在说一句错话。所以最后一个量点不掉（与通道那边同一条规矩）。
   */
  function isMetricSelected(targetMetric: TrendMetric): boolean {
    return metrics.value.includes(targetMetric)
  }

  function toggleMetric(targetMetric: TrendMetric): void {
    if (metrics.value.includes(targetMetric)) {
      if (metrics.value.length === 1) return
      metrics.value = metrics.value.filter((item) => item !== targetMetric)
    } else {
      if (metrics.value.length >= TREND_METRIC_MAX_SELECTED) return
      // 按 `TREND_METRIC_META` 的顺序插回去，而不是按点击顺序：轴与图例的排列
      // 不随点击先后变化（同一组选中项永远长成同一个样子）。
      metrics.value = TREND_METRIC_ORDER.filter(
        (item) => metrics.value.includes(item) || item === targetMetric
      )
    }
    query()
  }

  /**
   * 这个设备有哪些通道（视图从设备的通道表灌进来）。
   *
   * 换了设备或通道表变了就重新查一次：**只保留仍然存在的通道的隐藏状态**，
   * 否则"上一台设备的第 5 条通道被点掉了"会让新设备的第 5 条一进来就是灰的。
   */
  function setChannels(ids: readonly number[]): void {
    const next = [...ids]
    const same =
      next.length === channelIds.value.length &&
      next.every((id, index) => id === channelIds.value[index])
    if (same) return
    channelIds.value = next
    hiddenChannelIds.value = hiddenChannelIds.value.filter((id) => next.includes(id))
    query()
  }

  function isChannelVisible(index: number): boolean {
    return !hiddenChannelIds.value.includes(index)
  }

  /**
   * 点亮/点灭一条通道。**不查库**：数据在查询时已经把每条通道都取回来了，
   * 这里只改"画哪几条"（见 `hiddenChannelIds` 的注释）。
   * 最后一条可见的通道点不掉 —— 理由与"最后一个量点不掉"相同。
   */
  function toggleChannel(index: number): void {
    if (hiddenChannelIds.value.includes(index)) {
      hiddenChannelIds.value = hiddenChannelIds.value.filter((id) => id !== index)
      return
    }
    if (visibleChannelIds.value.length <= 1) return
    hiddenChannelIds.value = [...hiddenChannelIds.value, index]
  }

  /** 全部通道都显示（一键恢复）。 */
  function showAllChannels(): void {
    hiddenChannelIds.value = []
  }

  /**
   * Jump to an explicit span (the "use the stored range" shortcut).
   * Runs immediately: the user just clicked a concrete suggestion.
   */
  function setCustomRange(from: number, to: number): void {
    range.value = 'custom'
    customFrom.value = from
    customTo.value = to
    query({ immediate: true })
  }

  /** Time range actually covered by stored data; also the empty-state evidence. */  async function loadCoverage(): Promise<void> {
    const target = deviceId.value
    if (!target) return

    const seq = (coverageSeq += 1)
    const result = await callApi(() => window.api.trends.coverage(target))

    // Superseded by a newer coverage request or by a device switch: applying this
    // would describe the wrong device.
    if (seq !== coverageSeq || target !== deviceId.value) return

    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    coverage.value = unwrap(result) ?? null
    error.value = ''
    // Only seed an untouched custom form: never overwrite bounds the user set.
    if (range.value === 'custom' && (customFrom.value === undefined || customTo.value === undefined)) {
      seedCustomRange()
    }
  }

  /** Buffered/written counters for the Settings diagnostics panel. */
  async function loadStats(): Promise<void> {
    const result = await callApi(() => window.api.trends.stats())
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    stats.value = unwrap(result) ?? null
    error.value = ''
  }

  /**
   * Force a batch write, then refresh the counters so the panel shows the
   * effect of the click rather than the state before it.
   * @returns what was written, or undefined when the call failed.
   */
  async function flush(): Promise<{ rows: number; files: number } | undefined> {
    const result = await callApi(() => window.api.trends.flush())
    if (!result.success) {
      error.value = resultMessage(result)
      return undefined
    }
    error.value = ''
    const written = unwrap(result)
    await loadStats()
    return written
  }

  function clearError(): void {
    error.value = ''
  }

  return {
    // state
    deviceId,
    channelId,
    metric,
    aggregation,
    granularity,
    range,
    customFrom,
    customTo,
    metrics,
    channelIds,
    hiddenChannelIds,
    channelSeries,
    queriedCount,
    series,
    coverage,
    stats,
    loading,
    error,
    queriedFrom,
    queriedTo,
    // getters
    points,
    hasPoints,
    rangeIsEmpty,
    deviceHasNoHistory,
    coverageBounds,
    visibleChannelIds,
    // actions
    load,
    query,
    seriesFor,
    isMetricSelected,
    toggleMetric,
    setChannels,
    isChannelVisible,
    toggleChannel,
    showAllChannels,
    setRange,
    setGranularity,
    setCustomRange,
    loadCoverage,
    loadStats,
    flush,
    cancelPendingQuery,
    clearError
  }
})
