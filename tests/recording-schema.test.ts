/**
 * Schema v5 — `recordings` stops lying about video files.
 *
 * Before v5 the only way to store a camera's MP4 clip was `audio_format = 'wav'`,
 * because the CHECK in migration 1 admits nothing else and SQLite cannot widen a
 * CHECK in place. Every reader then had to know the column lied. v5 rebuilds the
 * table: `audio_format` becomes nullable (NULL = "this file has no audio format",
 * which is true for a video or a photo) and a `container_format` column says what
 * the bytes are.
 *
 * This is a REBUILD, so the interesting cases are the ones a fresh database never
 * reaches: an existing v4 file with rows in it. The test therefore builds a v4
 * database by hand, puts both kinds of row in it, and only then migrates — a test
 * that just called `openDatabase()` would create an empty table and prove nothing
 * about the conversion.
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { MIGRATIONS, openDatabase, runMigrations } from '../src/main/services/database/schema'
import { RecordingRepository } from '../src/main/services/database/alarm-repository'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-schema-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

let fileCounter = 0
function tempFile(): string {
  fileCounter += 1
  return path.join(tempRoot, `v4-${fileCounter}.db`)
}

/** Build a database at version 4 by applying only the first four migrations. */
function openV4(): InstanceType<typeof Database> {
  const db = new Database(tempFile())
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  for (const migration of MIGRATIONS) {
    if (migration.version > 4) continue
    migration.up(db)
    db.pragma(`user_version = ${migration.version}`)
  }
  return db
}

function insertDevice(db: InstanceType<typeof Database>, id: string): void {
  db.prepare(
    `INSERT INTO devices (id, device_uid, name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'ONLINE', 1, 1)`
  ).run(id, `uid-${id}`, id)
}

function insertV4Recording(
  db: InstanceType<typeof Database>,
  row: { id: string; deviceId: string; eventType: string | null }
): void {
  db.prepare(
    `INSERT INTO recordings (
       id, device_id, channel_id, recording_type, event_type, start_time,
       sample_rate, audio_format, relative_path, created_at
     ) VALUES (?, ?, 0, 'manual', ?, 1000, 96000, 'wav', ?, 1)`
  ).run(row.id, row.deviceId, row.eventType, `${row.id}.bin`)
}

describe('schema v5 — recording container format', () => {
  it('converts a v4 video row to NULL audio_format + mp4 container', () => {
    const db = openV4()
    insertDevice(db, 'dev-1')
    insertV4Recording(db, { id: 'vid', deviceId: 'dev-1', eventType: 'video_mp4' })
    insertV4Recording(db, { id: 'vid-alarm', deviceId: 'dev-1', eventType: 'alarm_linked_mp4' })
    insertV4Recording(db, { id: 'audio', deviceId: 'dev-1', eventType: null })

    runMigrations(db)
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length)

    const rows = db
      .prepare<[], { id: string; audio_format: string | null; container_format: string | null }>(
        `SELECT id, audio_format, container_format FROM recordings ORDER BY id`
      )
      .all()
    const byId = new Map(rows.map((row) => [row.id, row]))

    // The point of the migration: the video row no longer claims to be WAV.
    for (const id of ['vid', 'vid-alarm']) {
      assert.equal(byId.get(id)?.audio_format, null, `${id} still claims an audio format`)
      assert.equal(byId.get(id)?.container_format, 'mp4', `${id} lost its container`)
    }
    // And the audio row is untouched in both columns.
    assert.equal(byId.get('audio')?.audio_format, 'wav')
    assert.equal(byId.get('audio')?.container_format, 'wav')
    db.close()
  })

  it('keeps every row and every index through the rebuild', () => {
    const db = openV4()
    insertDevice(db, 'dev-1')
    for (let i = 0; i < 5; i += 1) {
      insertV4Recording(db, { id: `row-${i}`, deviceId: 'dev-1', eventType: 'video_mp4' })
    }
    const before = db.prepare(`SELECT COUNT(*) AS n FROM recordings`).get() as { n: number }

    runMigrations(db)

    const after = db.prepare(`SELECT COUNT(*) AS n FROM recordings`).get() as { n: number }
    assert.equal(after.n, before.n)
    const indexes = db
      .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all()
      .map((row) => row.name)
    for (const name of [
      'idx_recordings_time',
      'idx_recordings_device_time',
      'idx_recordings_type',
      'idx_recordings_remote'
    ]) {
      assert.ok(indexes.includes(name), `index ${name} was lost in the rebuild`)
    }
    db.close()
  })

  it('still enforces a CHECK on the container column', () => {
    const db = openDatabase({ file: tempFile() })
    insertDevice(db, 'dev-1')
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO recordings (
               id, device_id, channel_id, recording_type, start_time, sample_rate,
               audio_format, container_format, relative_path, created_at
             ) VALUES ('x', 'dev-1', 0, 'manual', 1, 0, NULL, 'mkv', 'x.mkv', 1)`
          )
          .run(),
      /CHECK/i,
      'an unknown container must fail loudly, not be stored'
    )
    db.close()
  })

  it('lets a new video row be written without an audio format', () => {
    const db = openDatabase({ file: tempFile() })
    insertDevice(db, 'dev-1')
    const repository = new RecordingRepository(db)

    const video = repository.insertVideo({
      deviceId: 'dev-1',
      startTime: 5000,
      endTime: 8000,
      durationMs: 3000,
      relativePath: 'camera/dev-1/clip.mp4',
      fileSize: 1417832
    })

    // The behaviour the migration exists for, read back through the public API.
    assert.equal(video.audioFormat, null)
    assert.equal(video.containerFormat, 'mp4')
    assert.equal(video.sampleRate, 0)

    const audio = repository.insert({
      deviceId: 'dev-1',
      channelId: 0,
      recordingType: 'alarm',
      startTime: 1000,
      sampleRate: 96000,
      audioFormat: 'wav',
      relativePath: 'alarm/dev-1/a.wav'
    })
    assert.equal(audio.audioFormat, 'wav')
    assert.equal(audio.containerFormat, 'wav')
    db.close()
  })

  it('defaults an unspecified container to unknown rather than guessing', () => {
    const db = openDatabase({ file: tempFile() })
    insertDevice(db, 'dev-1')
    const repository = new RecordingRepository(db)

    const row = repository.insert({
      deviceId: 'dev-1',
      channelId: 0,
      recordingType: 'manual',
      startTime: 1000,
      sampleRate: 0,
      audioFormat: null,
      relativePath: 'detect/dev-1/file.dat'
    })

    assert.equal(row.audioFormat, null)
    assert.equal(row.containerFormat, 'unknown')
    db.close()
  })
})
