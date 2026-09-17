/**
 * Schema v6 — an alarm can carry a severity and an operator's note.
 *
 * v6 is a plain `ALTER TABLE ... ADD COLUMN` pair, so the interesting cases are the
 * ones a fresh database never reaches:
 *   - a v5 file that ALREADY has alarm rows: those rows were never classified by
 *     anything, and they must end up saying exactly that (`'unknown'`), not NULL and
 *     not silently dropped;
 *   - the two CHECKs: a typo in a severity, and a note longer than the cap, must fail
 *     at write time rather than producing a row nobody can classify.
 *
 * The test therefore builds a v5 database by hand, puts an alarm in it, and only then
 * migrates. A test that just called `openDatabase()` would create an empty table and
 * prove nothing about the upgrade path — which is the only path that matters, because
 * every installation in the field is on v5.
 *
 * NOTE ON PROVENANCE: iVMS-4200 has no severity concept at all (its manual's 13 alarm
 * tables and its alarm list carry no level field), so `severity` is this product's own
 * design. The 500-character note cap is likewise ours — the manual states no limit.
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { MIGRATIONS, SCHEMA_VERSION, openDatabase, runMigrations } from '../src/main/services/database/schema'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-schema-v6-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

let fileCounter = 0
function tempFile(): string {
  fileCounter += 1
  return path.join(tempRoot, `v5-${fileCounter}.db`)
}

/** Build a database at version 5 by applying only the first five migrations. */
function openV5(): InstanceType<typeof Database> {
  const db = new Database(tempFile())
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  for (const migration of MIGRATIONS) {
    if (migration.version > 5) continue
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

/** Insert an alarm using only the columns that exist at v5. */
function insertV5Alarm(db: InstanceType<typeof Database>, id: string, deviceId: string): void {
  db.prepare(
    `INSERT INTO alarms
       (id, device_id, channel_id, alarm_type, alarm_mask, alarm_time, spl, acknowledged, created_at)
     VALUES (?, ?, 0, 1, 4, 1000, 57.1, 0, 1000)`
  ).run(id, deviceId)
}

function columnNames(db: InstanceType<typeof Database>, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name)
}

describe('schema v6 — 告警的等级与备注', () => {
  it('版本常量与迁移表的最高版本一致（不能只改一处）', () => {
    const highest = Math.max(...MIGRATIONS.map((migration) => migration.version))
    assert.equal(SCHEMA_VERSION, highest)
    /**
     * 这里**不写死** `6`，而是断言"v6 那条迁移在表里"。
     *
     * 第一版写的是 `assert.equal(SCHEMA_VERSION, 6)`，于是加一条 v7 迁移（样本库）就让这条
     * 与下面两条一起变红 —— 而它们要守的东西（常量与表一致、v6 的两列存在）**一条都没坏**。
     * 一个因为"版本号变了"就红的断言，最后只会教人顺手改数字，而不是去看迁移有没有问题。
     */
    assert.ok(
      MIGRATIONS.some((migration) => migration.version === 6),
      'MIGRATIONS 里没有 v6'
    )
  })

  it('全新建库到最新版本，且 alarms 有 severity 与 note 两列', () => {
    const db = openDatabase({ file: tempFile() })
    try {
      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
      const columns = columnNames(db, 'alarms')
      assert.ok(columns.includes('severity'), columns.join(','))
      assert.ok(columns.includes('note'), columns.join(','))
    } finally {
      db.close()
    }
  })

  it('v5 升级：已有告警行不丢，且如实变成 unknown / 无备注', () => {
    const db = openV5()
    try {
      insertDevice(db, 'dev-1')
      insertV5Alarm(db, 'alarm-1', 'dev-1')
      insertV5Alarm(db, 'alarm-2', 'dev-1')
      assert.equal(db.pragma('user_version', { simple: true }), 5)

      runMigrations(db)

      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
      const rows = db
        .prepare('SELECT id, severity, note, spl FROM alarms ORDER BY id')
        .all() as Array<{ id: string; severity: string; note: string | null; spl: number }>
      assert.equal(rows.length, 2, '既有行必须一条不少')
      for (const row of rows) {
        // 这些行从来没有被任何东西分类过 —— `unknown` 就是对它们的如实回答。
        assert.equal(row.severity, 'unknown')
        assert.equal(row.note, null, 'NULL 表示「没有备注」，而不是空串')
        assert.equal(row.spl, 57.1, '原有列必须原样保留')
      }
    } finally {
      db.close()
    }
  })

  it('severity 的 CHECK 会在写入时拦下打字错误', () => {
    const db = openDatabase({ file: tempFile() })
    try {
      insertDevice(db, 'dev-1')
      const insert = (severity: string): void => {
        db.prepare(
          `INSERT INTO alarms
             (id, device_id, channel_id, alarm_mask, alarm_time, severity, acknowledged, created_at)
           VALUES (?, 'dev-1', 0, 1, 1000, ?, 0, 1000)`
        ).run(`alarm-${severity}`, severity)
      }
      for (const good of ['info', 'warning', 'critical', 'unknown']) {
        insert(good)
      }
      assert.throws(() => insert('warn'), /CHECK/i)
      assert.throws(() => insert(''), /CHECK/i)
    } finally {
      db.close()
    }
  })

  it('note 的 CHECK：NULL 与 500 字符可写，501 字符被拒', () => {
    const db = openDatabase({ file: tempFile() })
    try {
      insertDevice(db, 'dev-1')
      const insert = (id: string, note: string | null): void => {
        db.prepare(
          `INSERT INTO alarms
             (id, device_id, channel_id, alarm_mask, alarm_time, note, acknowledged, created_at)
           VALUES (?, 'dev-1', 0, 1, 1000, ?, 0, 1000)`
        ).run(id, note)
      }
      insert('a', null)
      insert('b', '')
      insert('c', 'x'.repeat(500))
      assert.throws(() => insert('d', 'x'.repeat(501)), /CHECK/i)
    } finally {
      db.close()
    }
  })

  it('可以显式写入等级并读回（快照语义的前提）', () => {
    const db = openDatabase({ file: tempFile() })
    try {
      insertDevice(db, 'dev-1')
      db.prepare(
        `INSERT INTO alarms
           (id, device_id, channel_id, alarm_mask, alarm_time, severity, note, acknowledged, created_at)
         VALUES ('a', 'dev-1', 3, 8, 2000, 'critical', '轴承异响，已通知', 1, 2000)`
      ).run()
      const row = db.prepare('SELECT severity, note, acknowledged FROM alarms WHERE id = ?').get('a') as {
        severity: string
        note: string
        acknowledged: number
      }
      assert.equal(row.severity, 'critical')
      assert.equal(row.note, '轴承异响，已通知')
      assert.equal(row.acknowledged, 1)
    } finally {
      db.close()
    }
  })

  it('(severity, alarm_time) 索引存在，供列表按等级筛选', () => {
    const db = openDatabase({ file: tempFile() })
    try {
      const indexes = (db.pragma('index_list(alarms)') as Array<{ name: string }>).map((row) => row.name)
      assert.ok(indexes.includes('idx_alarms_severity_time'), indexes.join(','))
    } finally {
      db.close()
    }
  })

  it('迁移可重复执行（第二次是空操作）', () => {
    const db = openV5()
    try {
      insertDevice(db, 'dev-1')
      insertV5Alarm(db, 'alarm-1', 'dev-1')
      assert.equal(runMigrations(db), SCHEMA_VERSION)
      assert.equal(runMigrations(db), SCHEMA_VERSION)
      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM alarms').get() as { n: number }).n, 1)
    } finally {
      db.close()
    }
  })
})
