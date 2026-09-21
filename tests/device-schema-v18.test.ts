/**
 * schema v17 → v18：`devices.kind` 的 CHECK 放宽为四值（新增 `pushDevice`，纯推送第三方设备）。
 *
 * ---------------------------------------------------------------------------
 * 为什么要单独测一条迁移
 * ---------------------------------------------------------------------------
 * 与 v10 完全同一类风险：改的是**列级 CHECK**，SQLite 改不了 CHECK —— 只能重建表，而被重建的
 * `devices` 是 channels / alarms / recordings / samples 四张表的父表（`ON DELETE CASCADE`）。
 * 外键强制打开时 `DROP TABLE devices` 会先做一次隐式 DELETE，把子行级联删光 —— 升级会静默
 * 清空现场库。
 *
 * 所以断言的重点照旧是"老数据一行都没少"；另加三件 v18 自己的事：
 *
 *   1. 新的 CHECK 收 `pushDevice`，照旧拒不认识的家系；
 *   2. 三条索引都要回来，而且 `idx_devices_uid` / `idx_devices_push_secret`
 *      **仍然是 UNIQUE**（重建时最容易写松的一格）；
 *   3. `push_secret` / `ingest_plan` 这些 v15/v16 的列在重建后逐列还在。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { MIGRATIONS, SCHEMA_VERSION, runMigrations } from '../src/main/services/database/schema'
import { DeviceRepository } from '../src/main/services/database/device-repository'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'device-v18-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

let fileCounter = 0
function tempFile(): string {
  fileCounter += 1
  return path.join(tempRoot, `v17-${fileCounter}.db`)
}

/** 只跑到 v17 的库（现场安装的形状：kind 只允许三种机型）。 */
function openV17(): InstanceType<typeof Database> {
  const db = new Database(tempFile())
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  for (const migration of MIGRATIONS) {
    if (migration.version > 17) continue
    if (migration.foreignKeysOff === true) db.pragma('foreign_keys = OFF')
    try {
      migration.up(db)
      db.pragma(`user_version = ${migration.version}`)
    } finally {
      if (migration.foreignKeysOff === true) db.pragma('foreign_keys = ON')
    }
  }
  return db
}

/** 一台设备 + 它名下的四类子行（正是"重建父表会不会级联删掉它们"要问的）。 */
function seedV17Device(db: InstanceType<typeof Database>, deviceId: string): void {
  const at = 1_700_000_000_000
  db.prepare(
    `INSERT INTO devices (
       id, device_uid, kind, name, ip_address, http_port, connection_type,
       status, created_at, updated_at, push_secret, ingest_plan
     ) VALUES (?, ?, 'acousticBox', 'AE08', '192.168.110.90', 80, 'LAN', 'ONLINE', ?, ?,
               'a1b2c3d4e5f60718293a4b5c6d7e8f90', '{"protocol":"http"}')`
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

describe('schema v18 —— 第四种机型（pushDevice）与父表重建', () => {
  it('版本常量与迁移表的最高版本一致', () => {
    const highest = Math.max(...MIGRATIONS.map((migration) => migration.version))
    assert.equal(SCHEMA_VERSION, highest)
    assert.ok(SCHEMA_VERSION >= 18)
  })

  it('**重建父表不会级联删掉子行**（这是这一条迁移最危险的地方）', () => {
    const db = openV17()
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 17)
      seedV17Device(db, 'dev-1')
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
      // 设备行本身的内容（含 v15/v16 的列）没变。
      const device = new DeviceRepository(db).findById('dev-1')
      assert.equal(device?.name, 'AE08')
      assert.equal(device?.kind, 'acousticBox')
      assert.equal(device?.ingest?.protocol, 'http')
    } finally {
      db.close()
    }
  })

  it('新的 CHECK 收 pushDevice；不认识的家系照旧被拒', () => {
    const db = openV17()
    try {
      runMigrations(db)
      const insert = (id: string, kind: string): void => {
        db.prepare(
          `INSERT INTO devices (id, device_uid, kind, name, connection_type, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'LAN', 1, 1)`
        ).run(id, `uid-${id}`, kind, id)
      }
      insert('dev-push', 'pushDevice')
      assert.throws(() => insert('dev-bad', 'mysteryBox'), /CHECK/)
      // 老的三种照旧能写。
      insert('dev-box', 'acousticBox')
      insert('dev-cam', 'acousticCamera')
      insert('dev-e2', 'auscultationBox')
    } finally {
      db.close()
    }
  })

  it('身份索引与秘钥索引**仍然是 UNIQUE**（重建时最容易写松的一格）', () => {
    const db = openV17()
    try {
      runMigrations(db)
      const indexes = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index'`).all() as Array<{
        name: string
        sql: string | null
      }>
      const byName = new Map(indexes.map((index) => [index.name, String(index.sql)]))
      assert.match(byName.get('idx_devices_uid') ?? '', /CREATE UNIQUE INDEX/i)
      assert.match(byName.get('idx_devices_push_secret') ?? '', /CREATE UNIQUE INDEX/i)
      assert.match(byName.get('idx_devices_status') ?? '', /CREATE INDEX/i)
    } finally {
      db.close()
    }
  })

  it('v15/v16 的列逐列还在（重建照抄列定义，一条不许丢）', () => {
    const db = openV17()
    try {
      runMigrations(db)
      const columns = db
        .prepare(`SELECT name FROM pragma_table_info('devices')`)
        .all() as Array<{ name: string }>
      const names = columns.map((column) => column.name)
      for (const column of ['push_secret', 'ingest_plan', 'e2_variant', 'gis_latitude', 'auth_strategy']) {
        assert.ok(names.includes(column), `devices 缺列 ${column}`)
      }
    } finally {
      db.close()
    }
  })

  it('迁移可重复执行（第二次是空操作）', () => {
    const db = openV17()
    try {
      assert.equal(runMigrations(db), SCHEMA_VERSION)
      assert.equal(runMigrations(db), SCHEMA_VERSION)
      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })
})
