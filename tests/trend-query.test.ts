/**
 * Tests for the trend query layer.
 *
 * WHY THE BUCKET LADDER IS WORTH TESTING
 * Spec 12.2 requires downsampling so the UI never loads millions of points. The
 * bucket size is chosen arithmetically from the requested span, and getting it
 * wrong is the difference between a chart that renders instantly and one that
 * freezes the window: too small and a month-long range returns 2.6 million rows,
 * too large and a one-hour range returns a single useless point.
 *
 * FILE DISCOVERY IS TESTED SEPARATELY FROM THE QUERY ENGINE
 * Deciding which Parquet files a range covers is pure path arithmetic and is
 * pinned down on its own so a failure there can never be mistaken for a query
 * engine problem. The engine path is now exercised for real as well: the DuckDB
 * binding is a Node-API prebuilt (`@duckdb/node-api`), so unlike the previous
 * V8-ABI addon it loads under a plain Node test runner AND under Electron. That
 * is what makes the end-to-end test below possible at all.
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  chooseBucketSeconds,
  TrendQueryService
} from '../src/main/services/trend/trend-query-service'
import type { StorageService } from '../src/main/services/storage/storage-service'

let root: string
let service: TrendQueryService

/** Minimal StorageService stand-in: the query layer only reads `.root`. */
const storageStub = (): StorageService => ({ root }) as unknown as StorageService

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hz-trend-test-'))
  service = new TrendQueryService({ storage: storageStub() })
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** Create an empty file at a metrics path, creating directories as needed. */
async function touchMetricsFile(uid: string, isoDate: string): Promise<string> {
  const [year] = isoDate.split('-')
  const dir = path.join(root, 'metrics', uid, year as string)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${isoDate}.parquet`)
  await fs.writeFile(file, '')
  return file
}

describe('chooseBucketSeconds', () => {
  it('uses the smallest bucket for a short span', () => {
    assert.equal(chooseBucketSeconds(60_000), 1)
  })

  it('keeps the point count near the target across a wide range of spans', () => {
    // The contract is "roughly 500 points", not an exact count: the ladder is
    // discrete, so the achievable count varies by up to one rung.
    const spans = [
      60_000, // 1 minute
      3_600_000, // 1 hour
      6 * 3_600_000, // 6 hours
      86_400_000, // 1 day
      7 * 86_400_000, // 1 week
      30 * 86_400_000, // 30 days
      365 * 86_400_000 // 1 year
    ]

    for (const span of spans) {
      const buckets = chooseBucketSeconds(span)
      const points = span / 1000 / buckets
      assert.ok(
        points <= 600,
        `span ${span}ms produced ${points.toFixed(0)} points with ${buckets}s buckets`
      )
      assert.ok(
        points >= 15,
        `span ${span}ms produced only ${points.toFixed(0)} points with ${buckets}s buckets`
      )
    }
  })

  it('never shrinks the bucket as the span grows', () => {
    // Monotonicity matters: a larger range must not produce more points than a
    // smaller one, or zooming out would get slower instead of faster.
    let previous = 0
    for (let hours = 1; hours <= 24 * 400; hours *= 2) {
      const buckets = chooseBucketSeconds(hours * 3_600_000)
      assert.ok(buckets >= previous, `bucket shrank at ${hours}h: ${buckets} < ${previous}`)
      previous = buckets
    }
  })

  it('picks round, human-readable bucket sizes', () => {
    // A bucket of 7 seconds would produce an axis nobody can read.
    const acceptable = new Set([1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86_400, 172_800, 604_800])
    for (const span of [1_000, 60_000, 3_600_000, 86_400_000, 2_592_000_000]) {
      assert.ok(acceptable.has(chooseBucketSeconds(span)), `odd bucket for ${span}`)
    }
  })

  it('handles degenerate input without throwing', () => {
    assert.equal(chooseBucketSeconds(0), 1)
    assert.equal(chooseBucketSeconds(-1), 1)
    assert.equal(chooseBucketSeconds(Number.NaN), 1)
  })

  it('caps at the largest rung for an absurd span', () => {
    const buckets = chooseBucketSeconds(100 * 365 * 86_400_000)
    assert.ok(buckets <= 604_800, `expected the ladder ceiling, got ${buckets}`)
  })
})

describe('TrendQueryService.findFilesForRange', () => {
  const UID = 'mac_aa_bb_cc_dd_ee_ff'

  it('returns nothing for an unknown device', async () => {
    const files = await service.findFilesForRange('nobody', 0, Date.now())
    assert.deepEqual(files, [])
  })

  it('finds a file whose day overlaps the range', async () => {
    await touchMetricsFile(UID, '2026-03-10')
    const day = Date.UTC(2026, 2, 10, 12, 0, 0)

    const files = await service.findFilesForRange(UID, day, day + 3_600_000)
    assert.equal(files.length, 1)
    assert.ok(files[0]?.endsWith('2026-03-10.parquet'))
  })

  it('excludes a file whose day does not overlap', async () => {
    const nextDay = Date.UTC(2026, 2, 11, 12, 0, 0)
    const files = await service.findFilesForRange(UID, nextDay, nextDay + 3_600_000)
    assert.deepEqual(files, [])
  })

  it('includes the boundary day when the range starts mid-day', async () => {
    // A range that begins at 23:00 must still see that day's file: the rows
    // between 23:00 and midnight live in it.
    await touchMetricsFile(UID, '2026-03-12')
    const lateEvening = Date.UTC(2026, 2, 12, 23, 0, 0)
    const files = await service.findFilesForRange(UID, lateEvening, lateEvening + 600_000)
    assert.equal(files.length, 1)
  })

  it('spans multiple days and years, sorted', async () => {
    await touchMetricsFile(UID, '2025-12-31')
    await touchMetricsFile(UID, '2026-01-01')
    await touchMetricsFile(UID, '2026-01-02')

    const from = Date.UTC(2025, 11, 31, 0, 0, 0)
    const to = Date.UTC(2026, 0, 2, 23, 59, 59)
    const files = await service.findFilesForRange(UID, from, to)

    assert.equal(files.length, 3)
    const names = files.map((file) => path.basename(file))
    assert.deepEqual(names, ['2025-12-31.parquet', '2026-01-01.parquet', '2026-01-02.parquet'])
  })

  it('ignores files that are not day-named Parquet', async () => {
    const dir = path.join(root, 'metrics', UID, '2026')
    await fs.writeFile(path.join(dir, 'README.txt'), '')
    await fs.writeFile(path.join(dir, 'backup.parquet'), '')

    const day = Date.UTC(2026, 2, 10, 12, 0, 0)
    const files = await service.findFilesForRange(UID, day, day + 3_600_000)
    // Still only the one well-formed day file created earlier.
    assert.equal(files.length, 1)
  })

  it('does not read another device directory', async () => {
    await touchMetricsFile('mac_11_22_33_44_55_66', '2026-03-10')

    const day = Date.UTC(2026, 2, 10, 12, 0, 0)
    const files = await service.findFilesForRange(UID, day, day + 3_600_000)
    assert.ok(
      files.every((file) => file.includes(UID)),
      'a file from another device leaked into the result'
    )
  })

  it('tolerates a uid needing sanitisation', async () => {
    // The storage layer replaces unsafe characters; discovery must apply the
    // SAME rule or it looks in a directory that does not exist. That mismatch is
    // exactly the bug that made every trend query return zero points.
    await touchMetricsFile('mac_aa_bb_cc_dd_ee_ff', '2026-04-01')
    const files = await service.findFilesForRange('mac:aa:bb:cc:dd:ee:ff', Date.UTC(2026, 3, 1), Date.UTC(2026, 3, 1, 23, 59))
    assert.equal(files.length, 1, 'sanitisation mismatch between writer and reader')
  })
})

/**
 * End-to-end trend queries against a REAL Parquet file.
 *
 * This is the test that would have caught the DuckDB binding being absent or
 * unloadable: it writes a Parquet file with the exact column layout the trend
 * writer produces, then runs the same SQL the UI triggers and checks the points
 * that come back. `time_bucket()` is the specific hazard — DuckDB refuses it on
 * a BIGINT or DOUBLE timestamp, so the column type here is load-bearing.
 */
describe('trend query end-to-end', () => {
  const E2E_UID = 'mac_66_66_66_66_66_66'
  const BASE = Date.UTC(2026, 5, 1, 12, 0, 0)
  const DAY_ISO = '2026-06-01'

  before(async () => {
    const { DuckDBInstance } = await import('@duckdb/node-api')
    const instance = await DuckDBInstance.create(':memory:')
    const connection = await instance.connect()

    // `findFiles` looks under metrics/<uid>/<YYYY>/ — take the YEAR (index 0),
    // not the month, or the file lands in a directory discovery never reads and
    // every assertion below passes vacuously against an empty result set.
    const [year] = DAY_ISO.split('-')
    const dir = path.join(root, 'metrics', E2E_UID, year as string)
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${DAY_ISO}.parquet`).split(path.sep).join('/')

    // `timestamp` must be TIMESTAMP (built from a millisecond epoch via
    // epoch_ms), mirroring what trend-storage-service writes.
    await connection.run(`
      COPY (
        SELECT
          epoch_ms(CAST(ts_ms AS BIGINT)) AS timestamp,
          0 AS channel_id,
          CAST(spl AS DOUBLE) AS spl,
          100.0 AS main_frequency,
          0.5 AS smoothness,
          0.25 AS band_energy_ratio,
          0.1 AS hr_f,
          0.2 AS sc_f,
          0.3 AS sv_f
        FROM (VALUES
          (${BASE},       60.0),
          (${BASE + 10_000}, 62.0),
          (${BASE + 70_000}, 70.0),
          (${BASE + 80_000}, 72.0)
        ) AS t(ts_ms, spl)
      ) TO '${file}' (FORMAT PARQUET)
    `)
    instance.closeSync()
  })

  it('buckets a real Parquet file into averaged points', async () => {
    const series = await service.query({
      deviceUid: E2E_UID,
      metric: 'spl',
      from: BASE,
      to: BASE + 120_000,
      bucketSeconds: 60
    })

    assert.equal(series.filesScanned, 1)
    // 60 s buckets: rows at +0s/+10s land together (avg 61), +70s/+80s together (avg 71).
    assert.equal(series.points.length, 2, 'expected two 60-second buckets')
    assert.equal(series.points[0]?.value, 61)
    assert.equal(series.points[0]?.sampleCount, 2)
    assert.equal(series.points[1]?.value, 71)
    assert.equal(series.totalRows, 4)

    // The timestamp must be a real epoch-ms NUMBER. A BigInt leaking through
    // would either serialise as `{}` over IPC or throw on JSON.stringify.
    const ts = series.points[0]?.timestamp
    assert.equal(typeof ts, 'number', 'timestamp must be a number, not a bigint')
    assert.ok(Number.isFinite(ts), 'timestamp must be finite')
    assert.equal(ts, BASE)
  })

  it('applies min/max aggregation', async () => {
    const series = await service.query({
      deviceUid: E2E_UID,
      metric: 'spl',
      from: BASE,
      to: BASE + 120_000,
      bucketSeconds: 60,
      aggregation: 'max'
    })
    assert.equal(series.points[0]?.value, 62)
    assert.equal(series.points[1]?.value, 72)
  })

  it('filters by channel', async () => {
    // The fixture carries channel 0. Asserting only the empty case would pass
    // even if the whole query returned nothing, so both sides are pinned: the
    // matching channel must actually produce points.
    const matching = await service.query({
      deviceUid: E2E_UID,
      metric: 'spl',
      from: BASE,
      to: BASE + 120_000,
      bucketSeconds: 60,
      channelId: 0
    })
    assert.equal(matching.points.length, 2, 'channel 0 rows were not returned')

    const other = await service.query({
      deviceUid: E2E_UID,
      metric: 'spl',
      from: BASE,
      to: BASE + 120_000,
      bucketSeconds: 60,
      channelId: 5 // no rows carry this channel
    })
    assert.equal(other.points.length, 0)
    assert.equal(other.totalRows, 0)
  })

  it('reports coverage from the real file', async () => {
    const coverage = await service.getCoverage(E2E_UID)
    assert.equal(coverage.files, 1)
    assert.equal(coverage.from, BASE)
    assert.equal(coverage.to, BASE + 80_000)
  })

  it('returns an empty series rather than throwing when no file covers the range', async () => {
    const series = await service.query({
      deviceUid: E2E_UID,
      metric: 'spl',
      from: BASE + 86_400_000 * 30,
      to: BASE + 86_400_000 * 31
    })
    assert.deepEqual(series.points, [])
    assert.equal(series.filesScanned, 0)
  })
})

describe('TrendQueryService retention sweep', () => {
  let retentionRoot: string
  let retentionService: TrendQueryService

  before(async () => {
    retentionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hz-trend-retention-'))
    retentionService = new TrendQueryService({
      storage: { root: retentionRoot } as unknown as StorageService
    })
  })

  after(async () => {
    await fs.rm(retentionRoot, { recursive: true, force: true })
  })

  async function touchRetentionFile(uid: string, isoDate: string): Promise<string> {
    const [year] = isoDate.split('-')
    const dir = path.join(retentionRoot, 'metrics', uid, year as string)
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${isoDate}.parquet`)
    await fs.writeFile(file, '')
    return file
  }

  /** UTC day string `YYYY-MM-DD`, `daysAgo` before now. */
  function dayIso(daysAgo: number): string {
    return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  }

  async function fileExists(file: string): Promise<boolean> {
    return (await fs.stat(file).catch(() => null)) !== null
  }

  it('deletes only files older than the retention window', async () => {
    const oldFile = await touchRetentionFile('uid-a', dayIso(10))
    const recentFile = await touchRetentionFile('uid-a', dayIso(1))

    const result = await retentionService.enforceRetention('uid-a', 5)

    assert.equal(result.deleted, 1)
    assert.equal(await fileExists(oldFile), false)
    assert.equal(await fileExists(recentFile), true)
  })

  it('all-device sweep reaches directories with no current device row', async () => {
    const oldA = await touchRetentionFile('uid-a', dayIso(20))
    const oldOrphan = await touchRetentionFile('uid-orphan', dayIso(20))
    const recentOrphan = await touchRetentionFile('uid-orphan', dayIso(1))

    const result = await retentionService.enforceRetentionForAllDevices(5)

    assert.equal(result.devices, 2)
    assert.equal(result.deleted, 2)
    assert.equal(await fileExists(oldA), false)
    assert.equal(await fileExists(oldOrphan), false)
    assert.equal(await fileExists(recentOrphan), true)
  })

  it('a non-positive window disables the sweep entirely', async () => {
    const file = await touchRetentionFile('uid-b', dayIso(30))

    const result = await retentionService.enforceRetentionForAllDevices(0)

    assert.deepEqual(result, { devices: 0, deleted: 0 })
    assert.equal(await fileExists(file), true)
  })
})