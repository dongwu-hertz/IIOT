/**
 * schema v9 → v10：`devices.kind` 的 CHECK 加第三种机型（听诊盒子族）。
 *
 * ---------------------------------------------------------------------------
 * 为什么要单独测一条迁移
 * ---------------------------------------------------------------------------
 * 这一条迁移改的是一个**列级 CHECK**，而 SQLite 改不了 CHECK —— 只能重建表。而被重建的
 * `devices` 表是**四张表的父表**（channels / alarms / recordings / samples，都是
 * `ON DELETE CASCADE`），于是有一个会**删掉现场数据**的坑：
 *
 * > 外键强制打开时，`DROP TABLE devices` 会先做一次**隐式 DELETE**，级联把子行全部删掉。
 *
 * 所以这一组断言的重点**不是**"新机型能写进去"，而是**"老数据一行都没少"**：
 * 一台设备 + 它的通道 / 告警 / 录音 / 样本，在升级之后必须逐条还在，且
 * `PRAGMA foreign_key_check` 是空的。少了这一条，升级会静默清空现场库。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { MIGRATIONS, SCHEMA_VERSION, runMigrations } from '../src/main/services/database/schema'
import { DeviceRepository } from '../src/main/services/database/device-repository'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'device-v10-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

let fileCounter = 0
function tempFile(): string {
  fileCounter += 1
  return path.join(tempRoot, `v9-${fileCounter}.db`)
}

/** 只跑到 v9 的库（现场安装的形状：kind 只允许两种机型）。 */
function openV9(): InstanceType<typeof Database> {
  const db = new Database(tempFile())
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  for (const migration of MIGRATIONS) {
    if (migration.version > 9) continue
    migration.up(db)
    db.pragma(`user_version = ${migration.version}`)
  }
  return db
}

/** 一台设备 + 它名下的四类子行（正是"重建父表会不会级联删掉它们"要问的）。 */
function seedV9Device(db: InstanceType<typeof Database>, deviceId: string): void {
  const at = 1_700_000_000_000
  db.prepare(
    `INSERT INTO devices (
       id, device_uid, kind, name, ip_address, http_port, connection_type,
       status, created_at, updated_at
     ) VALUES (?, ?, 'acousticBox', 'AE08', '192.168.110.90', 80, 'LAN', 'ONLINE', ?, ?)`
  ).run(deviceId, `uid-${deviceId}`, at, at)

  db.prepare(
    `INSERT INTO channels (id, device_id, channel_index, channel_name, sensor_type, enabled, created_at, updated_at)
     VALUES (?, ?, 0, 'name1', 0, 1, ?, ?)`
  ).run(`chn-${deviceId}`, deviceId, at, at)

  db.prepare(
    `INSERT INTO alarms (id, device_id, channel_id, alarm_type, alarm_mask, alarm_time, created_at)
     VALUES (?, ?, 0, 1, 4, ?, ?)`
  ).run(`alm-${deviceId}`, deviceId, at, at)

  db.prepare(
    `INSERT INTO recordings (
       id, device_id, channel_id, recording_type, start_time, sample_rate, audio_format,
       container_format, relative_path, created_at
     ) VALUES (?, ?, 0, 'alarm', ?, 96000, 'wav', 'wav', 'alarm/x.wav', ?)`
  ).run(`rec-${deviceId}`, deviceId, at, at)

  db.prepare(
    `INSERT INTO samples (
       id, recording_id, device_id, channel_id, source, captured_at, features, created_at
     ) VALUES (?, ?, ?, 0, 'alarm', ?, '{"spl":62.5}', ?)`
  ).run(`smp-${deviceId}`, `rec-${deviceId}`, deviceId, at, at)
}

function count(db: InstanceType<typeof Database>, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }
  return row.total
}

describe('schema v10 —— 第三种机型与父表重建', () => {
  it('版本常量与迁移表的最高版本一致', () => {
    const highest = Math.max(...MIGRATIONS.map((migration) => migration.version))
    assert.equal(SCHEMA_VERSION, highest)
    assert.ok(SCHEMA_VERSION >= 10)
  })

  it('**重建父表不会级联删掉子行**（这是这一条迁移最危险的地方）', () => {
    const db = openV9()
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 9)
      seedV9Device(db, 'dev-1')
      assert.equal(count(db, 'channels'), 1)

      runMigrations(db)

      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
      // 父行还在，四类子行**一条都没少**。
      assert.equal(count(db, 'devices'), 1)
      assert.equal(count(db, 'channels'), 1)
      assert.equal(count(db, 'alarms'), 1)
      assert.equal(count(db, 'recordings'), 1)
      assert.equal(count(db, 'samples'), 1)
      // 引用完整性：关着外键跑完之后必须是干净的。
      assert.deepEqual(db.pragma('foreign_key_check'), [])
      // 外键强制**恢复成开**（迁移器在事务外面切的 PRAGMA）。
      assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
      // 设备行本身的内容没变。
      const device = new DeviceRepository(db).findById('dev-1')
      assert.equal(device?.name, 'AE08')
      assert.equal(device?.kind, 'acousticBox')
    } finally {
      db.close()
    }
  })

  it('新的 CHECK 收第三种机型；老的两种照旧写不进去的照旧写不进去', () => {
    const db = openV9()
    try {
      runMigrations(db)
      const insert = (id: string, kind: string): void => {
        db.prepare(
          `INSERT INTO devices (id, device_uid, kind, name, connection_type, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'LAN', 1, 1)`
        ).run(id, `uid-${id}`, kind, id)
      }
      insert('dev-e2', 'auscultationBox')
      // 不认识的机型仍然被拒（CHECK 是最后一道防线，不是"什么都能写"）。
      assert.throws(() => insert('dev-bad', 'mysteryBox'), /CHECK/)
    } finally {
      db.close()
    }
  })

  it('`device_uid` 的唯一索引**仍然是 UNIQUE**（重建时最容易写松的一格）', () => {
    const db = openV9()
    try {
      runMigrations(db)
      const indexes = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index'`).all() as Array<{
        name: string
        sql: string | null
      }>
      const uid = indexes.find((index) => index.name === 'idx_devices_uid')
      assert.ok(uid, indexes.map((index) => index.name).join(','))
      assert.match(String(uid.sql), /CREATE UNIQUE INDEX/i)
      assert.match(String(uid.sql), /device_uid/)
    } finally {
      db.close()
    }
  })

  it('迁移可重复执行（第二次是空操作）', () => {
    const db = openV9()
    try {
      assert.equal(runMigrations(db), SCHEMA_VERSION)
      assert.equal(runMigrations(db), SCHEMA_VERSION)
      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })
})
