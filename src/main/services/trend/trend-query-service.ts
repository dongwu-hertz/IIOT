/**
 * Trend queries via DuckDB (Phase 11, spec §12.2).
 *
 * WHY DUCKDB, AND WHY THE SPEC INSISTS ON IT
 * Parquet files are self-describing and columnar, which makes them ideal for
 * storage and awkward for ad-hoc analysis without an engine. DuckDB queries them
 * in place — no server, no import step, no duplicated data — which is exactly why
 * the specification chose it and why it explicitly forbids running a database
 * service for a desktop application.
 *
 * THE DOWNSAMPLING RULE IS NOT OPTIONAL
 * Spec 12.2: "大时间范围优先下采样，例如 1 分钟、5 分钟、1 小时粒度，避免 UI 一次
 * 加载数百万点." A day of one channel at 1 Hz is 86,400 points; a month is 2.6
 * million; eight channels over a year is 250 million. Sending that to a chart
 * library does not merely look bad, it exhausts memory. So the bucket size is
 * chosen from the requested span and applied in SQL, which means DuckDB
 * aggregates and only the reduced rows cross into the app.
 *
 * THE TRAP THIS FILE AVOIDS
 * DuckDB will only accept `time_bucket()` on a TIMESTAMP column. Writing the
 * timestamp as INT64 or DOUBLE produces BIGINT/DOUBLE columns whose cast to
 * TIMESTAMP fails with "Unimplemented type for cast", so downsampling silently
 * cannot work. `trend-storage-service.ts` writes TIMESTAMP accordingly; this file
 * additionally casts defensively, so a file written by an older build still
 * queries instead of erroring out.
 */

import path from 'node:path'
import { promises as fs } from 'node:fs'
import { AppError, ErrorCodes } from '@shared/errors'
import { appLog } from '../logging/logger'
import type { StorageService } from '../storage/storage-service'
import type {
  TrendAggregation,
  TrendPoint,
  TrendQueryBody,
  TrendSeries
} from '@shared/domain/trend'

// `TrendQueryBody` is re-exported below for callers that import the query shapes
// from this service rather than from the shared contract.
export type { TrendQueryBody }

/** Metric identifiers exposed to the UI. Maps to a column name internally. */
export const TREND_METRICS = [
  'spl',
  'mainFrequency',
  'smoothness',
  'bandEnergyRatio',
  'oddEvenHarmonicRatio',
  'spectralComplexity',
  'fingerprintVariation'
] as const

export type TrendMetric = (typeof TREND_METRICS)[number]

/**
 * Compile-time proof that the runtime ladder and the shared union agree.
 *
 * The ladder is a runtime value (it drives SQL column selection) while
 * `TrendMetric` is a type the renderer also uses. If someone adds a metric to one
 * and not the other, this assignment fails to compile — which is far better than
 * a metric that queries fine but cannot be selected in the UI.
 */
const _metricParity: readonly import('@shared/domain/trend').TrendMetric[] = TREND_METRICS
void _metricParity

/** Metric -> Parquet column. Kept in one place so SQL is never built from user input. */
const METRIC_COLUMNS: Record<TrendMetric, string> = {
  spl: 'spl',
  mainFrequency: 'main_frequency',
  smoothness: 'smoothness',
  bandEnergyRatio: 'band_energy_ratio',
  oddEvenHarmonicRatio: 'hr_f',
  spectralComplexity: 'sc_f',
  fingerprintVariation: 'sv_f'
}

const AGGREGATION_SQL: Record<TrendAggregation, (column: string) => string> = {
  avg: (column) => `AVG(${column})`,
  min: (column) => `MIN(${column})`,
  max: (column) => `MAX(${column})`,
  // DuckDB has a native quantile function; p95 is the useful one for acoustics
  // because the mean hides the transients an investigation is looking for.
  p95: (column) => `quantile_cont(${column}, 0.95)`
}

export interface TrendQuery {
  /** Stable device identity — the directory the files live under. */
  deviceUid: string
  channelId?: number
  metric: TrendMetric
  /** Inclusive epoch ms bounds. */
  from: number
  to: number
  aggregation?: TrendAggregation
  /** Force a bucket size instead of deriving it from the span. */
  bucketSeconds?: number
  /** Cap on returned points, applied after bucketing. */
  maxPoints?: number
}



/**
 * Bucket sizes in seconds, ascending.
 *
 * Derived from the span rather than hard-coded per range so any custom range
 * gets a sensible granularity. The targets keep a chart at roughly 500 points:
 * enough to show shape, few enough to render instantly.
 */
const BUCKET_LADDER_SECONDS = [
  1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800,
  3600, 7200, 10800, 21600, 43200,
  86_400, 172_800, 604_800
] as const

/** Target point count used to pick a bucket size from the span. */
const TARGET_POINTS = 500

export interface TrendQueryServiceOptions {
  storage: StorageService
}

export class TrendQueryService {
  private readonly storage: StorageService

  constructor(options: TrendQueryServiceOptions) {
    this.storage = options.storage
  }

  /**
   * Query a bucketed trend series.
   *
   * Read-only and side-effect free: safe to call from a debounced UI control.
   */
  async query(request: TrendQuery): Promise<TrendSeries> {
    const started = Date.now()

    if (request.from > request.to) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '起始时间不能晚于结束时间')
    }
    const column = METRIC_COLUMNS[request.metric]
    if (!column) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `未知指标: ${String(request.metric)}`)
    }

    const aggregation = request.aggregation ?? 'avg'
    const bucketSeconds =
      request.bucketSeconds ?? chooseBucketSeconds(request.to - request.from)

    const files = await this.findFiles(request.deviceUid, request.from, request.to)
    if (files.length === 0) {
      // An empty result is a legitimate answer, not an error: a device that has
      // only just been added has no history yet.
      return {
        metric: request.metric,
        aggregation,
        bucketSeconds,
        points: [],
        totalRows: 0,
        filesScanned: 0,
        truncated: false,
        durationMs: Date.now() - started
      }
    }

    const aggregateSql = AGGREGATION_SQL[aggregation](column)
    const maxPoints = request.maxPoints ?? TARGET_POINTS * 4
    const channelFilter =
      request.channelId !== undefined ? ` AND channel_id = ${Math.trunc(request.channelId)}` : ''

    /**
     * One statement, three parts:
     *   - the file list is inlined as a literal array (DuckDB reads a list of
     *     paths natively), so there is no glob that could accidentally include
     *     another device's files;
     *   - the time filter uses the ORIGINAL column, which lets DuckDB prune row
     *     groups via the statistics written into each file;
     *   - LIMIT is applied last, after aggregation, so it caps points rather than
     *     raw rows.
     *
     * Every interpolated value is either a number or a path produced by
     * `findFiles` from our own directory layout — no caller-supplied string ever
     * reaches the SQL text.
     */
    const sql = `
      SELECT
        CAST(epoch_ms(time_bucket(INTERVAL '${bucketSeconds} seconds', CAST(timestamp AS TIMESTAMP))) AS BIGINT) AS ts,
        ${aggregateSql} AS value,
        COUNT(*) AS n
      FROM read_parquet([${files.map((file) => `'${escapeSqlString(file)}'`).join(', ')}])
      WHERE CAST(timestamp AS TIMESTAMP) >= epoch_ms(${Math.trunc(request.from)})
        AND CAST(timestamp AS TIMESTAMP) <= epoch_ms(${Math.trunc(request.to)})${channelFilter}
      GROUP BY ts
      ORDER BY ts
      LIMIT ${Math.trunc(maxPoints) + 1}
    `

    const rows = await this.runQuery(sql)
    const truncated = rows.length > maxPoints
    const capped = truncated ? rows.slice(0, maxPoints) : rows

    const points: TrendPoint[] = capped.map((row) => ({
      timestamp: Number(row.ts ?? 0),
      value: row.value === null || row.value === undefined ? Number.NaN : Number(row.value),
      sampleCount: Number(row.n ?? 0)
    }))

    // Total raw rows, for the UI to show how much was summarised. A separate
    // COUNT is cheap because DuckDB reads only the statistics for it.
    const totalRows = await this.runQuery(`
      SELECT COUNT(*) AS n
      FROM read_parquet([${files.map((file) => `'${escapeSqlString(file)}'`).join(', ')}])
      WHERE CAST(timestamp AS TIMESTAMP) >= epoch_ms(${Math.trunc(request.from)})
        AND CAST(timestamp AS TIMESTAMP) <= epoch_ms(${Math.trunc(request.to)})${channelFilter}
    `).then((result) => Number(result[0]?.n ?? 0))

    const durationMs = Date.now() - started
    appLog().debug('Trend query complete', {
      metric: request.metric,
      bucketSeconds,
      points: points.length,
      totalRows,
      files: files.length,
      durationMs
    })

    return {
      metric: request.metric,
      aggregation,
      bucketSeconds,
      points,
      totalRows,
      filesScanned: files.length,
      truncated,
      durationMs
    }
  }

  /** Available time range for a device, so the UI can bound its date pickers. */
  async getCoverage(deviceUid: string): Promise<{ from?: number; to?: number; files: number }> {
    const files = await this.findFiles(deviceUid, 0, Number.MAX_SAFE_INTEGER)
    if (files.length === 0) return { files: 0 }

    try {
      const rows = await this.runQuery(`
        SELECT
          CAST(epoch_ms(MIN(CAST(timestamp AS TIMESTAMP))) AS BIGINT) AS mn,
          CAST(epoch_ms(MAX(CAST(timestamp AS TIMESTAMP))) AS BIGINT) AS mx
        FROM read_parquet([${files.map((file) => `'${escapeSqlString(file)}'`).join(', ')}])
      `)
      const row = rows[0]
      if (!row || row.mn === null || row.mx === null) return { files: files.length }
      return { from: Number(row.mn), to: Number(row.mx), files: files.length }
    } catch (error) {
      appLog().warn('Trend coverage query failed', {
        deviceUid,
        reason: error instanceof Error ? error.message : String(error)
      })
      return { files: files.length }
    }
  }

  /**
   * Delete trend files older than a cutoff.
   *
   * Part of the retention policy in spec 14.4. Deletion is by FILE rather than by
   * row: Parquet files are immutable, so removing a day means removing that day's
   * file, and the unit of deletion matches the unit of retention.
   */
  async enforceRetention(deviceUid: string, retentionDays: number): Promise<{ deleted: number }> {
    if (retentionDays <= 0) return { deleted: 0 }

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const files = await this.findFiles(deviceUid, 0, Number.MAX_SAFE_INTEGER)
    let deleted = 0

    for (const file of files) {
      // The file NAME carries the date (`YYYY-MM-DD.parquet`), so retention needs
      // no Parquet read at all.
      const match = /(\d{4})-(\d{2})-(\d{2})\.parquet$/.exec(file)
      if (!match) continue

      const fileDate = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      if (fileDate >= cutoff) continue

      try {
        await fs.unlink(file)
        deleted += 1
      } catch (error) {
        appLog().warn('Failed to delete an expired trend file', {
          file,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }

    if (deleted > 0) {
      appLog().info('Trend retention sweep removed files', { deviceUid, deleted })
    }
    return { deleted }
  }

  /**
   * Which Parquet files a query would read.
   *
   * Public so the Settings/diagnostics surface can show what a time range
   * actually covers, and so tests can assert on file discovery without running a
   * query against possibly-malformed data.
   */
  async findFilesForRange(deviceUid: string, from: number, to: number): Promise<string[]> {
    return this.findFiles(deviceUid, from, to)
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Parquet files for a device whose day overlaps the requested range.
   *
   * The date is parsed from the file name, so the range check costs nothing —
   * no file is opened to decide whether it is relevant.
   */
  private async findFiles(deviceUid: string, from: number, to: number): Promise<string[]> {
    const root = path.join(this.storage.root, 'metrics')
    const safeUid = deviceUid.replace(/[^A-Za-z0-9._-]/g, '_')

    const fromDay = from > 0 ? startOfDay(from) : 0
    const toDay = to < Number.MAX_SAFE_INTEGER ? endOfDay(to) : Number.MAX_SAFE_INTEGER

    const found: string[] = []

    // Layout is metrics/<uid>/<YYYY>/<YYYY-MM-DD>.parquet (spec 4.4), so the
    // year directory bounds the scan to a handful of directories.
    let years: string[]
    const deviceDir = path.join(root, safeUid)
    try {
      years = await fs.readdir(deviceDir)
    } catch (error) {
      // Logged rather than swallowed: "no files" and "cannot list the directory"
      // are very different answers, and silently returning [] for the second made
      // an empty chart look like a device with no history.
      appLog().warn('Trend device directory could not be listed', {
        deviceDir,
        root,
        safeUid,
        reason: error instanceof Error ? error.message : String(error)
      })
      return []
    }

    for (const year of years) {
      if (!/^\d{4}$/.test(year)) continue
      const yearDir = path.join(root, safeUid, year)

      let entries: string[]
      try {
        entries = await fs.readdir(yearDir)
      } catch (error) {
        appLog().warn('Trend year directory could not be listed', {
          yearDir,
          reason: error instanceof Error ? error.message : String(error)
        })
        continue
      }

      for (const entry of entries) {
        const match = /^(\d{4})-(\d{2})-(\d{2})\.parquet$/.exec(entry)
        if (!match) continue

        const fileStart = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
        const fileEnd = fileStart + 24 * 60 * 60 * 1000
        // A day overlaps the range when it starts before the range ends and ends
        // after the range starts.
        if (fileEnd <= fromDay || fileStart > toDay) continue

        found.push(path.join(yearDir, entry))
      }
    }

    return found.sort()
  }

  /**
   * Run SQL through DuckDB.
   *
   * A fresh in-memory instance per query rather than a pooled handle: DuckDB
   * opens one in milliseconds, queries here are user-initiated and infrequent,
   * and a persistent handle would need explicit teardown on shutdown
   * (appendix C rule 12) for no measurable benefit. The instance is always
   * closed, so a failed query cannot leak a database handle.
   *
   * WHY `@duckdb/node-api` AND NOT `duckdb`
   * The legacy `duckdb` package ships a V8-ABI native addon, which means it must
   * be rebuilt for Electron's ABI — a source build requiring node-gyp, a C++
   * toolchain and, on this project, a pile of compiler-compatibility patches for
   * the vendored DuckDB sources (VS2026 fails on `stdext::checked_array_iterator`
   * and then on several DuckDB internal files). `@duckdb/node-api` is the
   * official Node-API binding: it ships PREBUILT per platform, is ABI-stable
   * across Node and Electron versions, and needs no compiler at all. That is the
   * same judgement the project already made for Parquet I/O ("purposely avoided
   * native compilation" — README Phase 11).
   *
   * BigInt NORMALISATION
   * DuckDB returns BIGINT columns as JavaScript `bigint`. The chart layer expects
   * numbers, and `Number(bigint)` is both lossless for the millisecond epochs
   * used here and required to avoid "Do not know how to serialize a BigInt"
   * surfacing as a mysterious chart failure. NULL is preserved as null rather
   * than coerced, because this project treats a missing metric as `NaN` in the
   * UI and showing `0 dB` for "the device never reported" would be misread as
   * "the machine is quiet" (README §8.3).
   */
  private async runQuery(sql: string): Promise<Array<Record<string, unknown>>> {
    let DuckDBInstance: typeof import('@duckdb/node-api').DuckDBInstance
    try {
      ;({ DuckDBInstance } = require('@duckdb/node-api') as typeof import('@duckdb/node-api'))
    } catch (error) {
      throw new AppError(
        ErrorCodes.NOT_IMPLEMENTED,
        'DuckDB 原生模块加载失败，历史趋势查询不可用',
        error instanceof Error ? error.message : String(error)
      )
    }

    let instance: Awaited<ReturnType<typeof DuckDBInstance.create>> | undefined
    try {
      instance = await DuckDBInstance.create(':memory:')
      const connection = await instance.connect()
      const result = await connection.runAndReadAll(sql)
      const rows = result.getRowObjects() as Array<Record<string, unknown>>
      return rows.map((row) => {
        const normalised: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(row)) {
          normalised[key] = typeof value === 'bigint' ? Number(value) : value
        }
        return normalised
      })
    } catch (error) {
      throw new AppError(
        ErrorCodes.STORAGE_ERROR,
        `趋势查询失败: ${error instanceof Error ? error.message : String(error)}`,
        sql.slice(0, 400)
      )
    } finally {
      // Release the instance even when the query threw.
      instance?.closeSync()
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick a bucket size that keeps a chart readable for the requested span.
 *
 * Exported for tests: the choice is pure arithmetic and worth pinning down,
 * because getting it wrong is the difference between a chart that loads and one
 * that freezes the UI.
 */
export function chooseBucketSeconds(spanMs: number): number {
  if (!Number.isFinite(spanMs) || spanMs <= 0) return BUCKET_LADDER_SECONDS[0]

  const spanSeconds = spanMs / 1000
  const ideal = spanSeconds / TARGET_POINTS

  for (const candidate of BUCKET_LADDER_SECONDS) {
    if (candidate >= ideal) return candidate
  }
  return BUCKET_LADDER_SECONDS[BUCKET_LADDER_SECONDS.length - 1] as number
}

/** Midnight UTC of the day containing `timestamp`. */
function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

/** Last millisecond of the day containing `timestamp`. */
function endOfDay(timestamp: number): number {
  return startOfDay(timestamp) + 24 * 60 * 60 * 1000 - 1
}

/**
 * Escape a string for a SQL literal.
 *
 * File paths are generated by our own storage layout, so this is belt-and-braces
 * — but a device uid reaches the path from the database, and a single quote there
 * would otherwise break the statement or worse.
 */
function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''")
}
