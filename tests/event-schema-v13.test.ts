/**
 * schema v12 → v13：事件中心的**处置工作流**两张表（`event_status` + `event_activity`）。
 *
 * ---------------------------------------------------------------------------
 * 为什么单独测一条迁移
 * ---------------------------------------------------------------------------
 * 这一条迁移只**新增**两张表，不动任何既有表 —— 风险不在"改坏老数据"，而在三件别的事：
 *
 *   1. **升级之后老的现场库仍然是可用的**（v12 的库升到 v13，既有数据一行不少）；
 *   2. **CHECK 真的在管**：状态只允许规格的七个取值，`kind` 只允许三种 —— 一条写错的
 *      字符串插进去必须被 SQLite 拒绝，而不是悄悄存下"谁也没见过的状态"；
 *   3. **`event_status` 的主键是 entry_id**：同一事件只能有一行（UPSERT 的前提），
 *      这一点如果错了，界面会读到"两个状态"。
 *
 * 仓储层的行为（写完读回、流水顺序、指派不改状态）在 `tests/event-status.test.ts` 里测，
 * 这里只管**迁移与表结构**。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { MIGRATIONS, SCHEMA_VERSION, runMigrations } from '../src/main/services/database/schema'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'event-v13-'))
after(() => {
  /*
   * Windows 上删不掉"还开着的"文件（EPERM）。测试正常情况下都会 `close()`，
   * 但一条断言失败就会让 close 来不及跑 —— 那时清理失败不该盖住真正的失败原因。
   */
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    // 留给系统临时目录清理。
  }
})

let fileCounter = 0
function tempFile(): string {
  fileCounter += 1
  return path.join(tempRoot, `v13-${fileCounter}.db`)
}

/** 一个只跑到 v12 的库（现场安装的形状：还没有这两张表）。 */
function openV12(): InstanceType<typeof Database> {
  const db = new Database(tempFile())
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  for (const migration of MIGRATIONS) {
    if (migration.version > 12) continue
    migration.up(db)
    db.pragma(`user_version = ${migration.version}`)
  }
  return db
}

/** 一条真实的告警行（升级前后都要在）。 */
function seedV12Alarm(db: InstanceType<typeof Database>): void {
  const at = 1_700_000_000_000
  db.prepare(
    `INSERT INTO devices (
       id, device_uid, kind, name, ip_address, http_port, connection_type,
       status, created_at, updated_at
     ) VALUES ('dev-v13', 'uid-v13', 'acousticBox', 'AE08', '192.168.110.90', 80, 'LAN', 'ONLINE', ?, ?)`
  ).run(at, at)
  db.prepare(
    `INSERT INTO alarms (id, device_id, channel_id, alarm_time, alarm_mask, acknowledged, created_at)
     VALUES ('alm-v13', 'dev-v13', 1, ?, 1, 0, ?)`
  ).run(at, at)
}

/** 数一张表的行数（better-sqlite3 的 `get()` 返回 `unknown`，这里收窄一次）。 */
function countRows(db: InstanceType<typeof Database>, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }
  return row.total
}

describe('schema v13：处置工作流两张表', () => {
  it('版本号与迁移表是一起的（改了其中一处就会在这里报）', () => {
    /*
     * 这一条**不写死版本号**：v13 之后每加一条迁移（v14 是 Incident）都会走到这里，
     * 而 v13 自己的位置在迁移表里是固定的。写死 13 会让下一条迁移一来就把这条测试打红，
     * 而它真正要守的是"版本号 = 迁移表最后一条的版本"。
     */
    const v13 = MIGRATIONS.find((migration) => migration.version === 13)
    assert.ok(v13, '迁移表里没有 v13')
    assert.equal(v13.name, 'event-status-and-activity')
    const last = MIGRATIONS[MIGRATIONS.length - 1]
    assert.ok(last)
    assert.equal(SCHEMA_VERSION, last.version)
    assert.equal(last.version, Math.max(...MIGRATIONS.map((migration) => migration.version)))
  })

  it('升级现场的 v12 库：老数据一行不少，同时多出两张空表', () => {
    const db = openV12()
    seedV12Alarm(db)
    assert.equal(countRows(db, 'alarms'), 1, '升级前就该有一条告警')

    runMigrations(db)

    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
    assert.equal(countRows(db, 'alarms'), 1, '升级把既有告警弄丢了')
    for (const table of ['event_status', 'event_activity']) {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table) as { name: string } | undefined
      assert.ok(row, `升级之后没有 ${table} 表`)
      assert.equal(countRows(db, table), 0)
    }
    // 外键完整性：新表没有外键，但升级整体不能留下悬空引用。
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    db.close()
  })

  it('重复升级是幂等的（每次启动都会跑一次，不能第二次就炸）', () => {
    const db = openV12()
    runMigrations(db)
    runMigrations(db)
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
    db.close()
  })

  it('状态取值被 CHECK 管住：只允许规格的七个', () => {
    const db = openV12()
    runMigrations(db)
    const insert = (status: string): void => {
      db.prepare(
        `INSERT INTO event_status (entry_id, status, assignee, updated_at) VALUES (?, ?, NULL, ?)`
      ).run(`alarm:${status}`, status, 1)
    }
    for (const status of ['new', 'acknowledged', 'investigating', 'resolved', 'closed', 'muted', 'reopened']) {
      insert(status)
    }
    assert.equal(countRows(db, 'event_status'), 7)
    // 写错的取值必须被拒绝 —— 悄悄存下一个"谁也没见过的状态"是最糟的结果。
    assert.throws(() => insert('acknowledged-ish'), /CHECK constraint failed/)
    assert.throws(() => insert(''), /CHECK constraint failed/)
    db.close()
  })

  it('Activity 的 kind 被 CHECK 管住，且 entry_id 上建了索引', () => {
    const db = openV12()
    runMigrations(db)
    const insert = (kind: string): void => {
      db.prepare(
        `INSERT INTO event_activity (id, entry_id, at, actor, kind) VALUES (?, 'alarm:1', 1, 'admin', ?)`
      ).run(`act_${kind}`, kind)
    }
    for (const kind of ['status', 'assign', 'note']) insert(kind)
    assert.equal(countRows(db, 'event_activity'), 3)
    assert.throws(() => insert('approve'), /CHECK constraint failed/)

    const indexes = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event_activity'`)
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    assert.ok(
      indexes.includes('idx_event_activity_entry'),
      'event_activity 上没有按事件查的索引（时间线会全表扫）'
    )
    db.close()
  })

  it('一条事件只有一行状态（UPSERT 的前提）', () => {
    const db = openV12()
    runMigrations(db)
    const upsert = (status: string, at: number): void => {
      db.prepare(
        `INSERT INTO event_status (entry_id, status, assignee, updated_at) VALUES ('alarm:1', ?, NULL, ?)
         ON CONFLICT(entry_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`
      ).run(status, at)
    }
    upsert('new', 1)
    upsert('investigating', 2)
    const rows = db
      .prepare(`SELECT status, updated_at FROM event_status`)
      .all() as Array<{ status: string; updated_at: number }>
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.status, 'investigating')
    assert.equal(rows[0]?.updated_at, 2)
    db.close()
  })
})
