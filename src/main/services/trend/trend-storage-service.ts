/**
 * Trend storage — long-term feature history in Parquet (Phase 11, spec §12).
 *
 * WHY PARQUET, AND WHY NOT SQLITE
 * Spec section 4.1 assigns each kind of data a home: SQLite for metadata, NTFS
 * for audio, and Parquet for long-term feature trends. Realtime features arrive
 * at ~1 Hz per channel, which is 86,400 rows per channel per day — trivial for
 * Parquet's columnar compression and ruinous for a metadata database that must
 * stay small enough to open instantly after years of operation.
 *
 * THE WRITE PATTERN IS THE WHOLE POINT
 * Spec section 12.1: "内存 Buffer + Batch Flush，例如 60 秒或 1000 条记录一次，
 * 禁止每秒反复打开/关闭文件" — buffer in memory and flush in batches; never
 * open and close a file every second. So this service accumulates rows and only
 * touches the filesystem when a batch completes, which also means the Parquet
 * footer is written once per batch instead of once per sample.
 *
 * VERIFIED COLUMN TYPES
 * `timestamp` MUST be INT64 milliseconds written with the TIMESTAMP logical type,
 * because that is the only representation DuckDB will accept in `time_bucket()`
 * for the downsampling the spec requires. Measured on DuckDB 1.4.4:
 *
 *   TIMESTAMP + BigInt  -> DuckDB type TIMESTAMP  -> time_bucket works
 *   INT64     + BigInt  -> DuckDB type BIGINT     -> "Unimplemented type for cast"
 *   DOUBLE    + Number  -> DuckDB type DOUBLE     -> "Unimplemented type for cast"
 *
 * So the timestamps are converted to BigInt on the way out. That is not
 * cosmetic: with any other choice the Phase 11 downsampling feature silently
 * cannot work.
 *
 * NO NATIVE COMPILATION
 * Writing uses a pure-JavaScript Parquet writer. Reading uses DuckDB's
 * prebuilt native binding. Neither needs node-gyp, which keeps the build working
 * from a path containing spaces — a constraint that already bit the
 * better-sqlite3 install (see BUILD.md).
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RealtimeFeature } from '@shared/domain/models'
import { storageLog } from '../logging/logger'
import type { StorageService } from '../storage/storage-service'
import type { TrendStorageStats } from '@shared/domain/trend'

/** One row as it will be written. Mirrors the spec's Parquet schema (§12.1). */
export interface TrendRow {
  /** Epoch milliseconds. */
  timestamp: number
  deviceId: string
  channelId: number
  spl: number
  mainFrequency: number
  smoothness: number
  bandEnergyRatio: number
  oddEvenHarmonicRatio: number
  spectralComplexity: number
  fingerprintVariation: number
}

/** Spec §12.1: flush every 60 s or every 1000 rows, whichever comes first. */
export const DEFAULT_FLUSH_INTERVAL_MS = 60_000
export const DEFAULT_FLUSH_ROW_COUNT = 1000

export interface TrendStorageOptions {
  storage: StorageService
  flushIntervalMs?: number
  flushRowCount?: number
  /** Disable the timer (tests drive flushes explicitly). */
  autoFlush?: boolean
  /**
   * Disable the row-count flush trigger.
   *
   * Off in production: a burst of channels must not grow memory unbounded. On in
   * tests and batch imports, where a caller deliberately accumulates a known
   * volume before flushing and an automatic mid-way flush would split the batch.
   */
  autoFlushOnSize?: boolean
}

/** Statistics for the Settings page. Declared in `shared` so the renderer can
 *  name it without importing main-process code. */
export type { TrendStorageStats } from '@shared/domain/trend'

/**
 * Buffered Parquet trend writer.
 *
 * One instance serves all devices: rows are buffered together and grouped by
 * `device + day` at flush time, because that is the file granularity the spec
 * asks for ("建议每天每设备一个 Parquet 文件").
 */
export class TrendStorageService {
  private readonly storage: StorageService
  private readonly flushIntervalMs: number
  private readonly flushRowCount: number
  private readonly autoFlushOnSize: boolean

  /** Rows waiting to be written, keyed by their target file. */
  private readonly buffers = new Map<string, TrendRow[]>()

  private flushTimer?: NodeJS.Timeout
  private flushing = false
  private disposed = false

  /**
   * Running count of buffered rows.
   *
   * Maintained as a counter rather than recomputed by summing every bucket on
   * each append: with several devices reporting at 1 Hz, a `for` loop over all
   * buckets per sample is a needless O(n) on the hot path, and it made the
   * size-triggered flush fire during test setup that was only generating data.
   */
  private bufferedRowCount = 0

  private filesWritten = 0
  private rowsWritten = 0
  private lastFlushAt?: number
  private lastError?: string

  constructor(options: TrendStorageOptions) {
    this.storage = options.storage
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
    this.flushRowCount = options.flushRowCount ?? DEFAULT_FLUSH_ROW_COUNT
    this.autoFlushOnSize = options.autoFlushOnSize !== false

    if (options.autoFlush !== false) {
      this.flushTimer = setInterval(() => {
        void this.flush()
      }, this.flushIntervalMs)
      // Never keep the app alive purely to write metrics.
      this.flushTimer.unref?.()
    }
  }

  get stats(): TrendStorageStats {
    return {
      bufferedRows: this.bufferedRowCount,
      filesWritten: this.filesWritten,
      rowsWritten: this.rowsWritten,
      ...(this.lastFlushAt !== undefined ? { lastFlushAt: this.lastFlushAt } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {})
    }
  }

  /**
   * Buffer one realtime feature sample.
   *
   * A feature carrying `NaN` is stored as the column's null-ish default rather
   * than rejected: the row still carries a valid timestamp and channel, and
   * dropping it would leave a gap in the trend that looks like the device
   * stopped reporting. Parquet has no NaN problem — a float column represents it
   * natively — so the value passes through untouched.
   */
  append(deviceUid: string, feature: RealtimeFeature): void {
    if (this.disposed) return

    const row: TrendRow = {
      timestamp: feature.timestamp,
      deviceId: deviceUid,
      channelId: feature.channelId,
      spl: feature.spl,
      mainFrequency: feature.mainFrequency,
      smoothness: feature.smoothness,
      bandEnergyRatio: feature.bandEnergyRatio,
      oddEvenHarmonicRatio: feature.oddEvenHarmonicRatio ?? Number.NaN,
      spectralComplexity: feature.spectralComplexity ?? Number.NaN,
      fingerprintVariation: feature.fingerprintVariation ?? Number.NaN
    }

    const key = this.bufferKey(deviceUid, feature.timestamp)
    const bucket = this.buffers.get(key)
    if (bucket) bucket.push(row)
    else this.buffers.set(key, [row])

    this.bufferedRowCount += 1

    // Size-triggered flush, checked per append so a burst of channels cannot
    // balloon memory between timer ticks.
    //
    // The flush is NOT awaited: this method is called from the feature-stream
    // hot path, and blocking it on disk I/O would delay frame processing. Any
    // rows that arrive while a flush runs stay in the buffer and are picked up by
    // the next one; the running count is decremented by exactly what was taken.
    if (this.autoFlushOnSize && this.bufferedRowCount >= this.flushRowCount) {
      void this.flush()
    }
  }

  /**
   * Write every buffered row.
   *
   * Re-entrancy guarded: the timer and the size trigger can fire together, and
   * two concurrent flushes would interleave writes to the same file and produce
   * a corrupt Parquet (the footer would be written twice).
   */
  async flush(): Promise<{ rows: number; files: number }> {
    if (this.flushing || this.disposed) return { rows: 0, files: 0 }

    const pending = [...this.buffers.entries()].filter(([, rows]) => rows.length > 0)
    if (pending.length === 0) return { rows: 0, files: 0 }

    this.flushing = true
    let rowsWritten = 0
    let filesWritten = 0

    try {
      for (const [key, rows] of pending) {
        // Take the rows out of the buffer FIRST, so samples arriving during the
        // write are not lost when this batch is cleared.
        this.buffers.set(key, [])
        this.bufferedRowCount -= rows.length

        try {
          await this.writeFile(key, rows)
          rowsWritten += rows.length
          filesWritten += 1
        } catch (error) {
          // Put them back so a transient failure (disk full, permission) does
          // not silently discard the history, and surface the reason.
          const existing = this.buffers.get(key) ?? []
          this.buffers.set(key, [...rows, ...existing])
          this.bufferedRowCount += rows.length
          this.lastError = error instanceof Error ? error.message : String(error)
          storageLog().error('Trend flush failed; rows returned to the buffer', {
            key,
            rows: rows.length,
            reason: this.lastError
          })
        }
      }

      this.filesWritten += filesWritten
      this.rowsWritten += rowsWritten
      if (rowsWritten > 0) {
        this.lastFlushAt = Date.now()
        this.lastError = undefined
        storageLog().info('Trend batch written', { rows: rowsWritten, files: filesWritten })
      }
    } finally {
      this.flushing = false
    }

    return { rows: rowsWritten, files: filesWritten }
  }

  /**
   * Append one batch to a device-day Parquet file.
   *
   * The spec's "one file per device per day" is honoured by naming, and an
   * existing file for the same day is APPENDED by reading it back and rewriting
   * the union. That is not the efficient columnar-append a native writer would
   * do, but it keeps a day's history in one file as specified, and the volume
   * (86,400 rows/day/channel) makes the rewrite a sub-second operation.
   */
  private async writeFile(key: string, rows: TrendRow[]): Promise<void> {
    const target = this.storage.resolve(key)

    // A prior batch for the same day is merged in, so the file stays complete.
    const existing = await this.readRows(target)
    const combined = existing.length > 0 ? [...existing, ...rows] : rows
    // Rows can arrive slightly out of order (a stream reconnect replays a frame),
    // so the file is sorted before writing. DuckDB would still read it, but a
    // sorted file compresses far better and makes row-group pruning effective.
    combined.sort((left, right) => left.timestamp - right.timestamp)

    const { parquetWriteBuffer } = await import('hyparquet-writer')

    const buffer = parquetWriteBuffer({
      columnData: [
        // BigInt + TIMESTAMP: the only combination DuckDB accepts in
        // time_bucket(). See the note at the top of this file.
        { name: 'timestamp', data: combined.map((row) => BigInt(row.timestamp)), type: 'TIMESTAMP' },
        { name: 'device_id', data: combined.map((row) => row.deviceId), type: 'STRING' },
        { name: 'channel_id', data: combined.map((row) => row.channelId), type: 'INT32' },
        { name: 'spl', data: combined.map((row) => row.spl), type: 'DOUBLE' },
        { name: 'main_frequency', data: combined.map((row) => row.mainFrequency), type: 'DOUBLE' },
        { name: 'smoothness', data: combined.map((row) => row.smoothness), type: 'DOUBLE' },
        { name: 'band_energy_ratio', data: combined.map((row) => row.bandEnergyRatio), type: 'DOUBLE' },
        { name: 'hr_f', data: combined.map((row) => row.oddEvenHarmonicRatio), type: 'DOUBLE' },
        { name: 'sc_f', data: combined.map((row) => row.spectralComplexity), type: 'DOUBLE' },
        { name: 'sv_f', data: combined.map((row) => row.fingerprintVariation), type: 'DOUBLE' }
      ],
      // SNAPPY is the standard choice: fast enough to keep up with a flush every
      // 60 s, and universally readable.
      codec: 'SNAPPY'
    })

    await this.storage.writeFile(target, new Uint8Array(buffer))
  }

  /**
   * Read back an existing Parquet file, for the append path.
   *
   * Returns an empty array when the file is absent or unreadable: a corrupt
   * historical file must not block new data from being recorded, and the failure
   * is logged rather than thrown.
   */
  private async readRows(filePath: string): Promise<TrendRow[]> {
    let data: Uint8Array
    try {
      data = new Uint8Array(await fs.readFile(filePath))
    } catch {
      // Normal on the first write of a day.
      return []
    }

    try {
      // Uses the Parquet reader library rather than DuckDB for this narrow case:
      // the append path needs the rows back synchronously inside a flush, and
      // spinning up a database connection per file would cost more than the read
      // itself. DuckDB remains the engine for every user-facing query
      // (`trend-query-service.ts`), which is what spec 12.2 asks for.
      const { parquetReadObjects } = await import('hyparquet')
      const records = (await parquetReadObjects({
        file: await asyncBufferFromBytes(data)
      })) as Array<Record<string, unknown>>

      return records.map((record) => ({
        timestamp: Number(record.timestamp),
        deviceId: String(record.device_id ?? ''),
        channelId: Number(record.channel_id ?? 0),
        spl: toFinite(record.spl),
        mainFrequency: toFinite(record.main_frequency),
        smoothness: toFinite(record.smoothness),
        bandEnergyRatio: toFinite(record.band_energy_ratio),
        oddEvenHarmonicRatio: toFinite(record.hr_f),
        spectralComplexity: toFinite(record.sc_f),
        fingerprintVariation: toFinite(record.sv_f)
      }))
    } catch (error) {
      storageLog().warn('Existing Parquet file could not be read; starting a new batch', {
        filePath,
        reason: error instanceof Error ? error.message : String(error)
      })
      return []
    }
  }

  /** `metrics/<device_uid>/<YYYY>/<YYYY-MM-DD>.parquet`, per spec §4.4. */
  private bufferKey(deviceUid: string, timestamp: number): string {
    return this.storage.metricsFile(deviceUid, timestamp)
  }

  /**
   * Flush and stop.
   *
   * Called on shutdown so buffered samples are not lost when the user closes the
   * window — up to 60 seconds of history would otherwise disappear every time.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return

    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = undefined
    }

    await this.flush()
    this.disposed = true
  }
}

/**
 * Wrap in-memory bytes as the file-like object `hyparquet` expects.
 *
 * `AsyncBuffer` requires `slice()` to return an `ArrayBuffer`, and a `Uint8Array`
 * view over a larger buffer would otherwise hand back the WHOLE buffer — reading
 * bytes that belong to something else. Slicing to the exact window first is what
 * makes this correct, not merely convenient.
 */
async function asyncBufferFromBytes(bytes: Uint8Array): Promise<{
  byteLength: number
  slice: (start: number, end?: number) => ArrayBuffer
}> {
  const exact = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer

  return {
    byteLength: exact.byteLength,
    slice: (start: number, end?: number) => exact.slice(start, end ?? exact.byteLength)
  }
}

/** Coerce a possibly-null Parquet value to a number, preserving NaN. */
function toFinite(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  return Number.NaN
}

/** SHA-256 of a trend file, for the integrity record kept alongside exports. */
export async function hashTrendFile(filePath: string): Promise<string | undefined> {
  try {
    const bytes = await fs.readFile(filePath)
    return createHash('sha256').update(bytes).digest('hex')
  } catch {
    return undefined
  }
}

/** Directory a device's trend files live in, for cleanup and export. */
export function trendDirectoryFor(storage: StorageService, deviceUid: string, year: number): string {
  return path.join(storage.root, 'metrics', deviceUid.replace(/[^A-Za-z0-9._-]/g, '_'), String(year))
}
