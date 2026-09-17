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
  const aggregation = ref<TrendAggregation>('avg')
  const range = ref<TrendRangePreset>('24h')
  /** Custom bounds, epoch ms. Resolved only when `range === 'custom'`. */
  const customFrom = ref<number | undefined>(undefined)
  const customTo = ref<number | undefined>(undefined)

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

    const body: TrendQueryBody = {
      deviceId: target,
      metric: metric.value,
      from: bounds.from,
      to: bounds.to,
      aggregation: aggregation.value,
      // 全部通道 omits the field: the main process then aggregates every channel
      // instead of silently defaulting to CH1.
      ...(channelId.value !== undefined ? { channelId: channelId.value } : {})
    }

    const result = await callApi(() => window.api.trends.query(body))

    // Stale response: a newer query owns `series` and `loading` now.
    if (seq !== querySeq) return
    loading.value = false

    if (!result.success) {
      error.value = resultMessage(result)
      series.value = null
      return
    }
    series.value = unwrap(result) ?? null
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
   * Jump to an explicit span (the "use the stored range" shortcut).
   * Runs immediately: the user just clicked a concrete suggestion.
   */
  function setCustomRange(from: number, to: number): void {
    range.value = 'custom'
    customFrom.value = from
    customTo.value = to
    query({ immediate: true })
  }

  /** Time range actually covered by stored data; also the empty-state evidence. */
  async function loadCoverage(): Promise<void> {
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
    range,
    customFrom,
    customTo,
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
    // actions
    load,
    query,
    setRange,
    setCustomRange,
    loadCoverage,
    loadStats,
    flush,
    cancelPendingQuery,
    clearError
  }
})
