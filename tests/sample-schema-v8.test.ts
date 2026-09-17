/**
 * schema v7 → v8：把样本的**单标签**变成**两个维度**，并加上标签库。
 *
 * 这一轮唯一有风险的操作是 v8 **整表重建** `samples`（SQLite 加不了新的跨列 CHECK）。
 * 重建意味着"老数据要么原样搬过去、要么丢掉"，所以这一组断言对准的正是**搬运**：
 *   - v7 里的 `label` / `label_source` 必须变成 `fault_label` / `fault_label_source`，
 *     值与来源**一个字都不变**（含义没变：设备位图给的弱标签本来就落在故障那一维）；
 *   - 新增的 `equipment_label` 是 NULL（不能凭空造出一个设备类型）；
 *   - 重建之后约束仍然生效（两条 CHECK 都要在），索引也重建了；
 *   - 标签库是新表，升级后为空（不替操作员预设词表）。
 *
 * 为什么必须测"老库"：现场安装的库都在 v7，而这个迁移是**唯一**会碰已有样本的一步 ——
 * 只在空库上跑一次 `openDatabase()` 是测不出搬运错误的。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { MIGRATIONS, SCHEMA_VERSION, runMigrations } from '../src/main/services/database/schema'
import { SampleRepository } from '../src/main/services/database/sample-repository'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-v8-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

let fileCounter = 0
function tempFile(): string {
  fileCounter += 1
  return path.join(tempRoot, `v7-${fileCounter}.db`)
}

/** 只跑到 v7 的库（现场安装的那个形状）。 */
function openV7(): InstanceType<typeof Database> {
  const db = new Database(tempFile())
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  for (const migration of MIGRATIONS) {
    if (migration.version > 7) continue
    migration.up(db)
    db.pragma(`user_version = ${migration.version}`)
  }
  return db
}

function insertDevice(db: InstanceType<typeof Database>): void {
  // OR IGNORE：这个 helper 会被调用多次，而 devices 上有 uid 唯一约束。
  db.prepare(
    `INSERT OR IGNORE INTO devices (id, device_uid, name, status, created_at, updated_at)
     VALUES ('dev-1', 'uid-dev-1', 'AE08', 'ONLINE', 1, 1)`
  ).run()
}

function insertV7Sample(
  db: InstanceType<typeof Database>,
  id: string,
  label: string | null,
  labelSource: string | null
): void {
  insertDevice(db)
  db.prepare(
    `INSERT INTO samples (
       id, device_id, channel_id, source, captured_at, label, label_source, features, created_at
     ) VALUES (?, 'dev-1', 0, 'alarm', 1000, ?, ?, ?, 1000)`
  ).run(id, label, labelSource, JSON.stringify({ spl: 62.5, mainFrequency: 93 }))
}

function columnNames(db: InstanceType<typeof Database>, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name)
}

describe('schema v8 — 样本的两个标签维度与标签库', () => {
  it('版本常量与迁移表的最高版本一致（不能只改一处）', () => {
    const highest = Math.max(...MIGRATIONS.map((migration) => migration.version))
    assert.equal(SCHEMA_VERSION, highest)
    // v8 是"两个标签维度"，之后 v9 又加了听诊盒子族的告警载荷（`alarm-device-payload`）。
    // 这里只钉住"常量与迁移表不许脱节"，不钉具体数字（那是 migrations 表自己的事）。
    assert.ok(SCHEMA_VERSION >= 8)
  })

  it('v7 升级：`label` 原样变成 `fault_label`，来源不变，设备类型留空', () => {
    const db = openV7()
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 7)
      insertV7Sample(db, 'smp-1', 'corona_discharge', 'device')
      insertV7Sample(db, 'smp-2', null, null)

      const version = runMigrations(db)
      assert.equal(version, SCHEMA_VERSION)
      assert.ok(version >= 8)

      const repo = new SampleRepository(db)
      const migrated = repo.findById('smp-1')
      assert.ok(migrated)
      // 值与来源都**一个字没变**（含义没变：位图描述的就是故障）。
      assert.deepEqual(migrated.faultLabel, { text: 'corona_discharge', source: 'device' })
      // 设备类型不能凭空出现。
      assert.equal(migrated.equipmentLabel, undefined)
      // 特征也一起搬过来了。
      assert.equal(migrated.metrics.spl, 62.5)

      const unlabelled = repo.findById('smp-2')
      assert.equal(unlabelled?.faultLabel, undefined)
      assert.equal(unlabelled?.equipmentLabel, undefined)
    } finally {
      db.close()
    }
  })

  it('重建之后：列齐了、索引在、两条 CHECK 仍然生效、标签库是空表', () => {
    const db = openV7()
    try {
      runMigrations(db)

      const columns = columnNames(db, 'samples')
      for (const column of [
        'fault_label',
        'fault_label_source',
        'equipment_label',
        'equipment_label_source'
      ]) {
        assert.ok(columns.includes(column), `${column} 不在列里：${columns.join(',')}`)
      }
      // 旧的单标签列**不该**留着：留着就有两套真相。
      assert.equal(columns.includes('label'), false)
      assert.equal(columns.includes('label_source'), false)

      const indexes = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{
          name: string
        }>
      ).map((row) => row.name)
      for (const index of [
        'idx_samples_fault_label',
        'idx_samples_equipment_label',
        'idx_samples_recording',
        'idx_samples_device_time',
        'idx_samples_fault_source'
      ]) {
        assert.ok(indexes.includes(index), `${index} 不在索引里：${indexes.join(',')}`)
      }

      // 两条 CHECK 都还在（重建最容易丢的就是它们）。
      assert.throws(() =>
        db
          .prepare(
            `INSERT INTO samples (id, device_id, channel_id, source, captured_at, fault_label, created_at)
             VALUES ('bad', 'dev-1', 0, 'alarm', 1, 'x', 1)`
          )
          .run()
      )
      assert.throws(() =>
        db
          .prepare(
            `INSERT INTO samples (id, device_id, channel_id, source, captured_at, equipment_label, created_at)
             VALUES ('bad2', 'dev-1', 0, 'alarm', 1, '变压器', 1)`
          )
          .run()
      )

      // 标签库是**新表**，升级后为空：不替操作员预设一份词表（那是他的领域知识）。
      const labelCount = db
        .prepare(`SELECT COUNT(*) AS total FROM sample_labels`)
        .get() as { total: number }
      assert.equal(labelCount.total, 0)
    } finally {
      db.close()
    }
  })

  it('迁移可重复执行（第二次是空操作）', () => {
    const db = openV7()
    try {
      assert.equal(runMigrations(db), SCHEMA_VERSION)
      assert.equal(runMigrations(db), SCHEMA_VERSION)
      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })

  it('外键仍然生效：删掉源录音时样本级联消失（重建最怕丢的就是这个）', () => {
    const db = openV7()
    try {
      // `recordings.device_id` 从一开始就指向 devices（外键是 ON 的），所以设备要先在。
      insertDevice(db)
      db.prepare(
        `INSERT INTO recordings (
           id, device_id, channel_id, recording_type, start_time, sample_rate,
           relative_path, created_at
         ) VALUES ('rec-1', 'dev-1', 0, 'alarm', 1000, 96000, 'a/b.wav', 1)`
      ).run()
      db.prepare(
        `INSERT INTO samples (
           id, recording_id, device_id, channel_id, source, captured_at, features, created_at
         ) VALUES ('smp-rec', 'rec-1', 'dev-1', 0, 'alarm', 1000, NULL, 1000)`
      ).run()

      runMigrations(db)
      assert.ok(new SampleRepository(db).findById('smp-rec'))

      db.prepare(`DELETE FROM recordings WHERE id = 'rec-1'`).run()
      assert.equal(new SampleRepository(db).findById('smp-rec'), undefined)
    } finally {
      db.close()
    }
  })
})
