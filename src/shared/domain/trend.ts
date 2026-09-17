/**
 * Historical-trend view models (Phase 11) — the presentation contract.
 *
 * WHY THESE LIVE IN `shared/`
 * Same reason as `device-config.ts`: `RendererApi['trends']` names them, and a
 * type-only import across the process boundary drags the source file's runtime
 * imports with it. Declaring the shapes here keeps the renderer's TypeScript
 * project free of main-process code.
 *
 * The metric ladder itself (`TREND_METRICS`) deliberately stays in the main
 * process: it is a runtime value derived from the Parquet column list, and the
 * renderer learns the available metrics from the query API rather than from a
 * duplicated constant.
 */

/** Aggregation applied inside each time bucket. */
export type TrendAggregation = 'avg' | 'min' | 'max' | 'p95'

/**
 * Metric identifiers.
 *
 * Mirror of the main process's `TREND_METRICS`. Kept as a union rather than an
 * enum so the renderer can key label/unit tables off it exhaustively.
 */
export type TrendMetric =
  | 'spl'
  | 'mainFrequency'
  | 'smoothness'
  | 'bandEnergyRatio'
  | 'oddEvenHarmonicRatio'
  | 'spectralComplexity'
  | 'fingerprintVariation'

/**
 * What the renderer sends.
 *
 * Carries `deviceId` (the local row id) NOT `deviceUid`: the uid is the on-disk
 * directory identity, and handing it to the presentation layer would leak the
 * storage layout. The main process resolves it.
 */
export interface TrendQueryBody {
  deviceId: string
  channelId?: number
  metric: TrendMetric
  from: number
  to: number
  aggregation?: TrendAggregation
  bucketSeconds?: number
  maxPoints?: number
}

/** One downsampled point. */
export interface TrendPoint {
  timestamp: number
  /** `NaN` when the device reported nothing in this bucket. Render as a gap. */
  value: number
  /** Raw rows aggregated into this bucket. */
  sampleCount: number
}

export interface TrendSeries {
  metric: TrendMetric
  aggregation: TrendAggregation
  /** Bucket width chosen by the main process from the requested span. */
  bucketSeconds: number
  points: TrendPoint[]
  /** Raw rows the query considered, before bucketing. */
  totalRows: number
  /** Parquet files the query touched. */
  filesScanned: number
  /** True when the result hit the point cap. */
  truncated: boolean
  durationMs: number
}

/** Time range actually covered by stored data. */
export interface TrendCoverage {
  from?: number
  to?: number
  files: number
}

/** Buffered/written counters for the diagnostics line. */
export interface TrendStorageStats {
  bufferedRows: number
  filesWritten: number
  rowsWritten: number
  lastFlushAt?: number
  lastError?: string
}
