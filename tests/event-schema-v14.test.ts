/**
 * schema v13 → v14：Incident 与它的关联两张表（规格 §14.2 的 V1）。
 *
 * 与 v13 那条迁移同一套证法，但**多两条这一轮特有的性质**：
 *   1. **外键真的在管**：`incident_alerts.incident_id` 指向 `incidents(id)`。一个不存在的
 *      incidentId 必须被 SQLite 拒绝 —— 悬空的关联在界面上表现为"这个事件里有一条查不到的
 *      告警"，事后无法解释；
 *   2. **`ON DELETE CASCADE`**：删掉一个 Incident 时它的链接一起走（这一轮还没有删除入口，
 *      但允许悬空链接的表迟早会在某次删除里留下垃圾）。
 *
 * 仓储与服务的行为（幂等关联、写完读回、不碰 Alert 状态）在 `tests/event-center.test.ts`
 * 的 Incident 那一组里测，这里只管**迁移与表结构**。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { MIGRATIONS, SCHEMA_VERSION, runMigrations } from '../src/main/services/database/schema'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'event-v14-'))
after(() => {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    // 留给系统临时目录清理。
  }
})

let fileCounter = 0
function tempFile(): string {
  fileCounter += 1
  return path.join(tempRoot, `v14-${fileCounter}.db`)
}

/** 一个只跑到 v13 的库（现场安装的形状：已经有处置工作流、还没有 Incident）。 */
function openV13(): InstanceType<typeof Database> {
  const db = new Database(tempFile())
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  for (const migration of MIGRATIONS) {
    if (migration.version > 13) continue
    migration.up(db)
    db.pragma(`user_version = ${migration.version}`)
  }
  return db
}

function countRows(db: InstanceType<typeof Database>, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }
  return row.total
}

/** 一条 v13 时代就有的状态行与流水（升级前后都要在）。 */
function seedV13Workflow(db: InstanceType<typeof Database>): void {
  db.prepare(
    `INSERT INTO event_status (entry_id, status, assignee, updated_at) VALUES ('alarm:seed', 'acknowledged', 'admin', 1000)`
  ).run()
  db.prepare(
    `INSERT INTO event_activity (id, entry_id, at, actor, kind, from_status, to_status)
     VALUES ('act_seed', 'alarm:seed', 1000, 'admin', 'status', 'new', 'acknowledged')`
  ).run()
}

describe('schema v14：Incident 与关联两张表', () => {
  it('v14 那条迁移在表里，而且名字没被改过', () => {
    /**
     * 这里**不写死** `SCHEMA_VERSION === 14`：v15（设备推流秘钥，2026-09-19）加进来之后，
     * 那句断言会红 —— 而它要守的东西（v14 这条迁移存在、名字对、现场 v13 库能升上来）
     * 一条都没坏。一个因为"版本号变了"就红的断言，最后只会教人顺手改数字。
     * 常量与迁移表的最高版本一致这件事由 `alarm-schema-v6.test.ts` 与
     * `device-installation.test.ts` 那几条守着。
     */
    const v14 = MIGRATIONS.find((migration) => migration.version === 14)
    assert.ok(v14, 'MIGRATIONS 里没有 v14')
    assert.equal(v14.name, 'incidents-and-links')
    const last = MIGRATIONS[MIGRATIONS.length - 1]
    assert.ok(last)
    assert.equal(SCHEMA_VERSION, last.version)
  })

  it('升级现场的 v13 库：老数据一行不少，同时多出两张空表', () => {
    const db = openV13()
    seedV13Workflow(db)
    assert.equal(countRows(db, 'event_status'), 1)

    runMigrations(db)

    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
    assert.equal(countRows(db, 'event_status'), 1, '升级把既有状态弄丢了')
    assert.equal(countRows(db, 'event_activity'), 1, '升级把既有流水弄丢了')
    for (const table of ['incidents', 'incident_alerts']) {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table) as { name: string } | undefined
      assert.ok(row, `升级之后没有 ${table} 表`)
      assert.equal(countRows(db, table), 0)
    }
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    db.close()
  })

  it('重复升级是幂等的', () => {
    const db = openV13()
    runMigrations(db)
    runMigrations(db)
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
    db.close()
  })

  it('关联必须指向一个真实存在的 Incident（外键在管）', () => {
    const db = openV13()
    runMigrations(db)
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO incident_alerts (incident_id, entry_id, linked_at, linked_by)
             VALUES ('inc_missing', 'alarm:1', 1, 'admin')`
          )
          .run(),
      /FOREIGN KEY constraint failed/
    )
    db.close()
  })

  it('同一个 Incident 收不下同一条 Alert 两次（主键在管）', () => {
    const db = openV13()
    runMigrations(db)
    db.prepare(
      `INSERT INTO incidents (id, title, note, created_at, created_by, updated_at)
       VALUES ('inc_1', '标题', NULL, 1, 'admin', 1)`
    ).run()
    const link = (): void => {
      db.prepare(
        `INSERT INTO incident_alerts (incident_id, entry_id, linked_at, linked_by)
         VALUES ('inc_1', 'alarm:1', 1, 'admin')`
      ).run()
    }
    link()
    assert.throws(link, /UNIQUE constraint failed/)
    // 仓储用的正是 `INSERT OR IGNORE` + 这个主键来做幂等（见 incident-repository.ts）。
    db.prepare(
      `INSERT OR IGNORE INTO incident_alerts (incident_id, entry_id, linked_at, linked_by)
       VALUES ('inc_1', 'alarm:1', 2, 'admin')`
    ).run()
    assert.equal(countRows(db, 'incident_alerts'), 1)
    db.close()
  })

  it('删掉一个 Incident 时它的关联一起走（ON DELETE CASCADE）', () => {
    const db = openV13()
    runMigrations(db)
    db.prepare(
      `INSERT INTO incidents (id, title, note, created_at, created_by, updated_at)
       VALUES ('inc_1', '标题', '备注', 1, 'admin', 1)`
    ).run()
    db.prepare(
      `INSERT INTO incident_alerts (incident_id, entry_id, linked_at, linked_by)
       VALUES ('inc_1', 'alarm:1', 1, 'admin')`
    ).run()
    db.prepare(`DELETE FROM incidents WHERE id = 'inc_1'`).run()
    assert.equal(countRows(db, 'incident_alerts'), 0, '删了 Incident 却留下了悬空关联')
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    db.close()
  })

  it('`entry_id` 上有索引（详情页问的是"这一条属于哪些"）', () => {
    const db = openV13()
    runMigrations(db)
    const indexes = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'incident_alerts'`
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    assert.ok(
      indexes.includes('idx_incident_alerts_entry'),
      'incident_alerts 上没有按事件查的索引（详情抽屉会全表扫）'
    )
    db.close()
  })

  it('标题是 NOT NULL：空标题在库里也存不下来（界面那一道不是唯一一道）', () => {
    const db = openV13()
    runMigrations(db)
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO incidents (id, title, note, created_at, created_by, updated_at)
             VALUES ('inc_null', NULL, NULL, 1, 'admin', 1)`
          )
          .run(),
      /NOT NULL constraint failed/
    )
    db.close()
  })
})
