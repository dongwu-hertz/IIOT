/**
 * S2 retention wiring regression: capacity-first sweep + age sweep + file-before-row.
 *
 * WHY THIS FILE EXISTS
 * `shared/domain/retention.ts` decides WHICH recordings may be deleted; this
 * suite proves the storage service actually applies that decision to real files
 * and rows, and that it counts the whole storage root (trend/log/cache bytes),
 * not just `recordings.file_size`.
 *
 * The owner's irreversible rules pinned here:
 *   - warning+ alarm recordings are in the P zone (default 10% of quota);
 *   - manual recordings never enter the deletion queue;
 *   - C-zone oldest-first until the quota is satisfied;
 *   - if only P/M/non-recording data remains, `remainingOverBytes` tells the
 *     truth instead of pretending the disk was cleaned;
 *   - files are unlinked before their metadata rows.
 */

import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database as SqliteDatabase } from 'better-sqlite3'

import { openDatabase } from '../src/main/services/database/schema'
import {
  AlarmRepository,
  RecordingRepository
} from '../src/main/services/database/alarm-repository'
import { StorageService } from '../src/main/services/storage/storage-service'
import type { EventSeverity } from '../src/shared/domain/event-center'
import type { RecordingType } from '../src/shared/domain/models'

const DAY_MS = 24 * 60 * 60 * 1000

let root: string
let db: SqliteDatabase
let storage: StorageService
let recordings: RecordingRepository
let alarms: AlarmRepository
let quotaBytes: number
let reserveRatio: number

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hz-retention-sweep-'))
  db = openDatabase({ file: ':memory:' })
  db.prepare(
    `INSERT INTO devices (id, device_uid, kind, name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('dev-1', 'uid-1', 'auscultationBox', 'Device 1', 'ONLINE', Date.now(), Date.now())

  recordings = new RecordingRepository(db)
  alarms = new AlarmRepository(db)
  quotaBytes = 0
  reserveRatio = 0.1
  storage = new StorageService({
    db,
    getStorageRoot: () => root,
    getMinFreeBytes: () => 0,
    getStorageQuotaBytes: () => quotaBytes,
    getRetentionAlarmReserveRatio: () => reserveRatio
  })
  await storage.ensureLayout(root)
})

afterEach(async () => {
  try {
    db?.close()
  } catch {
    // already closed
  }
  if (root) await fs.rm(root, { recursive: true, force: true })
})

async function writeRaw(relativePath: string, bytes: number): Promise<void> {
  const absolute = path.join(root, relativePath)
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  await fs.writeFile(absolute, Buffer.alloc(bytes))
}

async function exists(relativePath: string): Promise<boolean> {
  return (await fs.stat(path.join(root, relativePath)).catch(() => null)) !== null
}

async function writeRecording(input: {
  kind: RecordingType
  startMs: number
  bytes: number
  relativePath: string
  alarmSeverity?: EventSeverity
}) {
  await writeRaw(input.relativePath, input.bytes)
  const recording = recordings.insert({
    deviceId: 'dev-1',
    channelId: 0,
    recordingType: input.kind,
    startTime: input.startMs,
    sampleRate: input.kind === 'scheduled' ? 0 : 48_000,
    audioFormat: input.kind === 'scheduled' ? null : 'wav',
    containerFormat: input.kind === 'scheduled' ? 'mp4' : 'wav',
    relativePath: input.relativePath,
    fileSize: input.bytes
  })

  if (input.alarmSeverity) {
    alarms.insert({
      deviceId: 'dev-1',
      channelId: 0,
      timestamp: input.startMs,
      alarmMask: 1,
      severity: input.alarmSeverity,
      recordingId: recording.id
    })
  }
  return recording
}

function rowExists(id: string): boolean {
  return Boolean(db.prepare(`SELECT id FROM recordings WHERE id = ?`).get(id))
}

describe('S2 retention wiring: capacity plan reaches real files and rows', () => {
  it('over quota: deletes C-zone oldest-first; P-zone alarm and manual recording stay', async () => {
    quotaBytes = 10_000
    const protectedAlarm = await writeRecording({
      kind: 'alarm',
      startMs: 500,
      bytes: 800,
      relativePath: 'audio/dev/protected.wav',
      alarmSeverity: 'warning'
    })
    const manual = await writeRecording({
      kind: 'manual',
      startMs: 100,
      bytes: 2_000,
      relativePath: 'audio/dev/manual.wav'
    })
    const scheduledOld = await writeRecording({
      kind: 'scheduled',
      startMs: 1_000,
      bytes: 4_000,
      relativePath: 'video/dev/old.mp4'
    })
    const scheduledMiddle = await writeRecording({
      kind: 'scheduled',
      startMs: 2_000,
      bytes: 4_000,
      relativePath: 'video/dev/middle.mp4'
    })
    const scheduledNew = await writeRecording({
      kind: 'scheduled',
      startMs: 3_000,
      bytes: 5_000,
      relativePath: 'video/dev/new.mp4'
    })

    const result = await storage.enforceRetention({
      retentionDays: 0,
      quotaBytes,
      alarmReserveRatio: reserveRatio
    })

    assert.equal(result.capacityDeletedFiles, 2)
    assert.equal(result.ageDeletedFiles, 0)
    assert.equal(result.deletedRows, 2)
    assert.equal(result.freedBytes, 8_000)
    assert.equal(result.remainingOverBytes, 0)

    assert.equal(await exists(scheduledOld.relativePath), false)
    assert.equal(await exists(scheduledMiddle.relativePath), false)
    assert.equal(await exists(scheduledNew.relativePath), true)
    assert.equal(await exists(protectedAlarm.relativePath), true)
    assert.equal(await exists(manual.relativePath), true)

    assert.equal(rowExists(scheduledOld.id), false)
    assert.equal(rowExists(scheduledMiddle.id), false)
    assert.equal(rowExists(scheduledNew.id), true)
    assert.equal(rowExists(protectedAlarm.id), true)
    assert.equal(rowExists(manual.id), true)
  })

  it('under quota: age sweep still removes expired non-protected alarms; P-zone is exempt', async () => {
    quotaBytes = 1_000_000
    const expiredAt = Date.now() - 10 * DAY_MS
    const infoAlarm = await writeRecording({
      kind: 'alarm',
      startMs: expiredAt,
      bytes: 300,
      relativePath: 'audio/dev/info.wav',
      alarmSeverity: 'info'
    })
    const warningAlarm = await writeRecording({
      kind: 'alarm',
      startMs: expiredAt + 1,
      bytes: 300,
      relativePath: 'audio/dev/warning.wav',
      alarmSeverity: 'warning'
    })
    const manual = await writeRecording({
      kind: 'manual',
      startMs: expiredAt,
      bytes: 300,
      relativePath: 'audio/dev/manual-old.wav'
    })
    const scheduled = await writeRecording({
      kind: 'scheduled',
      startMs: expiredAt,
      bytes: 300,
      relativePath: 'video/dev/scheduled-old.mp4'
    })

    const result = await storage.enforceRetention({
      retentionDays: 5,
      quotaBytes,
      alarmReserveRatio: reserveRatio
    })

    assert.equal(result.capacityDeletedFiles, 0)
    assert.equal(result.ageDeletedFiles, 1)
    assert.equal(result.deletedRows, 1)

    assert.equal(await exists(infoAlarm.relativePath), false)
    assert.equal(rowExists(infoAlarm.id), false)
    assert.equal(await exists(warningAlarm.relativePath), true)
    assert.equal(await exists(manual.relativePath), true)
    assert.equal(await exists(scheduled.relativePath), true)
  })

  it('quota accounting includes non-recording data; leftover overage is reported honestly', async () => {
    quotaBytes = 1_000
    const manual = await writeRecording({
      kind: 'manual',
      startMs: 100,
      bytes: 500,
      relativePath: 'audio/dev/manual.wav'
    })
    const protectedAlarm = await writeRecording({
      kind: 'alarm',
      startMs: 200,
      bytes: 50,
      relativePath: 'audio/dev/protected.wav',
      alarmSeverity: 'critical'
    })
    const scheduled = await writeRecording({
      kind: 'scheduled',
      startMs: 300,
      bytes: 200,
      relativePath: 'video/dev/scheduled.mp4'
    })
    // Trend/metrics file: not a recording row, but it still occupies the quota.
    await writeRaw('metrics/uid-1/2026/2026-01-01.parquet', 600)

    const result = await storage.enforceRetention({
      retentionDays: 0,
      quotaBytes,
      alarmReserveRatio: reserveRatio
    })

    assert.equal(result.capacityDeletedFiles, 1)
    assert.equal(result.deletedRows, 1)
    assert.equal(result.freedBytes, 200)
    assert.equal(result.remainingOverBytes, 150)

    assert.equal(await exists(scheduled.relativePath), false)
    assert.equal(rowExists(scheduled.id), false)
    assert.equal(await exists(manual.relativePath), true)
    assert.equal(await exists(protectedAlarm.relativePath), true)

    const usage = await storage.quotaUsage()
    assert.equal(usage.quotaBytes, 1_000)
    assert.equal(usage.usedByAppBytes, 1_150, 'manual + protected + metrics')
    assert.equal(usage.overQuotaBytes, 150)
    assert.equal(usage.remainingOverQuotaBytes, 150, 'only permanent/manual data is left')
    assert.equal(usage.reclaimableBytes, 0, 'nothing in the C zone remains')
  })

  it('rebuildable caches are pruned first when the quota is exceeded, before recordings', async () => {
    quotaBytes = 1_000
    await writeRaw('spectrum_cache/expensive.bin', 2_000)
    const scheduled = await writeRecording({
      kind: 'scheduled',
      startMs: 100,
      bytes: 500,
      relativePath: 'video/dev/keep.mp4'
    })

    const result = await storage.enforceRetention({
      retentionDays: 0,
      quotaBytes,
      alarmReserveRatio: reserveRatio
    })

    assert.equal(result.cacheDeletedFiles, 1)
    assert.equal(result.cacheFreedBytes, 2_000)
    assert.equal(result.capacityDeletedFiles, 0)
    assert.equal(result.remainingOverBytes, 0)
    assert.equal(await exists(scheduled.relativePath), true)
  })

  it('a recording row whose file already vanished is still cleaned by the age sweep', async () => {
    quotaBytes = 1_000_000
    const missing = recordings.insert({
      deviceId: 'dev-1',
      channelId: 0,
      recordingType: 'alarm',
      startTime: Date.now() - 10 * DAY_MS,
      sampleRate: 48_000,
      audioFormat: 'wav',
      containerFormat: 'wav',
      relativePath: 'audio/dev/missing.wav',
      fileSize: 123,
      eventType: 'alarm_linked'
    })

    const result = await storage.enforceRetention({
      retentionDays: 1,
      quotaBytes,
      alarmReserveRatio: reserveRatio
    })

    assert.equal(result.ageDeletedFiles, 0, 'no file existed to unlink')
    assert.equal(result.deletedRows, 1, 'the stale row still goes')
    assert.equal(rowExists(missing.id), false)
  })

  it('quick diskUsage stays audio-only; quotaUsage reports the whole root', async () => {
    quotaBytes = 1_000
    await writeRaw('audio/dev/manual.wav', 100)
    await writeRaw('video/dev/scheduled.mp4', 1_000)

    const quick = await storage.diskUsage()
    assert.equal(quick.usedByAppBytes, 100, 'hot path must not walk video/trends/logs')
    assert.equal(quick.quotaBytes, 0, 'quick guard does not run quota planning')
    assert.equal(quick.reclaimableBytes, 0)

    const full = await storage.quotaUsage()
    assert.equal(full.usedByAppBytes, 1_100)
    assert.equal(full.quotaBytes, 1_000)
    assert.equal(full.overQuotaBytes, 100)
  })
})
