/**
 * Alarm severity and notes — the half of the v6 upgrade that lives outside the UI.
 *
 * The schema test (`alarm-schema-v6.test.ts`) proves the COLUMNS and their CHECKs exist.
 * This file proves the columns are actually USED, which is a different claim: v6 could
 * have been added and left unwired, and every schema test would still pass.
 *
 * Three things are pinned here:
 *   1. `deriveAlarmSeverity()` — the classification table is OUR design (iVMS-4200 has no
 *      severity concept at all, and the device reports no usable level: the box's alarm
 *      protocol carries only a bit mask, and the camera's `alarm_level` has conflicting
 *      read/write enums and has never been observed on real hardware). The test therefore
 *      checks the table is TOTAL over the 14 defined bits and that multi-bit masks resolve
 *      to the HIGHEST level rather than the lowest.
 *   2. The snapshot semantics — severity is written once at insert and is NOT re-derived on
 *      read. This is the whole reason the migration stores it in a column, so it is tested
 *      by corrupting the mask afterwards and observing that the stored level does not move.
 *   3. Notes — written, cleared, length-capped, and distinguished from "row not found".
 *
 * PROVENANCE: every threshold and grouping below is this repository's own decision. The
 * manual states none of it; see `docs/Ivms4200-UX-REFERENCE.md` §15.5 and §15.6.
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { AlarmRepository, ALARM_NOTE_MAX_LENGTH } from '../src/main/services/database/alarm-repository'
import { openDatabase } from '../src/main/services/database/schema'
import {
  ALARM_BIT_MASKS,
  ALARM_MASK_BITS,
  ALARM_SEVERITY_BY_TYPE,
  deriveAlarmSeverity
} from '../src/shared/domain/alarm-mask'
import { AlarmType } from '../src/shared/domain/models'
import { EVENT_SEVERITIES, isEventSeverity } from '../src/shared/domain/event-center'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-severity-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

let fileCounter = 0
function freshDb(): InstanceType<typeof Database> {
  fileCounter += 1
  const db = openDatabase({ file: path.join(tempRoot, `db-${fileCounter}.db`) })
  db.prepare(
    `INSERT INTO devices (id, device_uid, name, status, created_at, updated_at)
     VALUES ('dev-1', 'uid-dev-1', 'dev-1', 'ONLINE', 1, 1)`
  ).run()
  return db
}

/** Every defined alarm bit, as the mask that carries only that bit. */
const ALL_TYPES: readonly AlarmType[] = Object.values(AlarmType).filter(
  (value): value is AlarmType => typeof value === 'number'
)

describe('告警等级：分类表是我们自己的设计', () => {
  it('表格对 14 个已定义位是**全覆盖**的，没有一格留空', () => {
    for (const type of ALL_TYPES) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(ALARM_SEVERITY_BY_TYPE, type),
        `AlarmType ${type} 没有等级`
      )
    }
    assert.equal(ALL_TYPES.length, ALARM_MASK_BITS)
  })

  it('分类表里**不出现** unknown：unknown 是"我们没判"，不是一种判定结果', () => {
    for (const type of ALL_TYPES) {
      assert.notEqual(ALARM_SEVERITY_BY_TYPE[type], 'unknown', `AlarmType ${type}`)
    }
  })

  it('三档都真的有人，且取值都是合法的 EventSeverity', () => {
    const assigned = new Set(ALL_TYPES.map((type) => ALARM_SEVERITY_BY_TYPE[type]))
    for (const severity of assigned) assert.ok(isEventSeverity(severity), String(severity))
    assert.ok(assigned.has('info'), 'info 档为空')
    assert.ok(assigned.has('warning'), 'warning 档为空')
    assert.ok(assigned.has('critical'), 'critical 档为空')
    assert.equal(assigned.size, 3, `只应有三档：${[...assigned].join(',')}`)
  })

  it('会动手损坏设备的两个电气位是 critical，且 critical 只有它们', () => {
    assert.equal(deriveAlarmSeverity(ALARM_BIT_MASKS[AlarmType.ShortCircuitSurge]), 'critical')
    assert.equal(deriveAlarmSeverity(ALARM_BIT_MASKS[AlarmType.Overload]), 'critical')
    const critical = ALL_TYPES.filter((type) => ALARM_SEVERITY_BY_TYPE[type] === 'critical')
    assert.deepEqual(
      [...critical].sort((a, b) => a - b),
      [AlarmType.Overload, AlarmType.ShortCircuitSurge],
      'critical 档只应有短路冲击与过载；把阈值类量塞进来会淹掉真正的紧急告警'
    )
  })

  it('四项声学基础量是 info：它们是"测量值越限"，不是缺陷判定', () => {
    for (const type of [
      AlarmType.SPL,
      AlarmType.MainFrequency,
      AlarmType.BandEnergyRatio,
      AlarmType.Smoothness
    ]) {
      assert.equal(deriveAlarmSeverity(ALARM_BIT_MASKS[type]), 'info', `AlarmType ${type}`)
    }
  })

  it('已命名的物理缺陷（松动/冷却器/五类放电）是 warning', () => {
    for (const type of [
      AlarmType.ClampLooseness,
      AlarmType.CoolerAnomalyA,
      AlarmType.CoolerAnomalyB,
      AlarmType.SurfaceDischarge,
      AlarmType.CoronaDischarge,
      AlarmType.GapDischarge,
      AlarmType.FloatingDischarge,
      AlarmType.DCBias
    ]) {
      assert.equal(deriveAlarmSeverity(ALARM_BIT_MASKS[type]), 'warning', `AlarmType ${type}`)
    }
  })

  it('一个位图带多个位时取**最高**档，而不是最低档', () => {
    // 真机上同时置位是常态：声压越限（info）叠一条短路冲击（critical）。
    const mixed = ALARM_BIT_MASKS[AlarmType.SPL] | ALARM_BIT_MASKS[AlarmType.ShortCircuitSurge]
    assert.equal(deriveAlarmSeverity(mixed), 'critical', '按最低档取会把紧急告警记成 info')
    const warningPlusInfo = ALARM_BIT_MASKS[AlarmType.SPL] | ALARM_BIT_MASKS[AlarmType.CoronaDischarge]
    assert.equal(deriveAlarmSeverity(warningPlusInfo), 'warning')
    // 顺序无关：反过来组一次也是同一个答案。
    const reversed = ALARM_BIT_MASKS[AlarmType.ShortCircuitSurge] | ALARM_BIT_MASKS[AlarmType.SPL]
    assert.equal(deriveAlarmSeverity(reversed), 'critical')
  })

  it('空位图、负数、非整数与非有限值一律 unknown（不含糊成 info）', () => {
    for (const mask of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(deriveAlarmSeverity(mask), 'unknown', `mask=${String(mask)}`)
    }
  })

  it('只有未知位（Bit14+）时是 unknown：未来固件加了位，我们如实说没判', () => {
    assert.equal(deriveAlarmSeverity(1 << ALARM_MASK_BITS), 'unknown')
    assert.equal(deriveAlarmSeverity((1 << 14) | (1 << 20)), 'unknown')
  })

  it('未知位不会把已知位的等级拉低或拉高', () => {
    const withUnknown = ALARM_BIT_MASKS[AlarmType.ShortCircuitSurge] | (1 << 20)
    assert.equal(deriveAlarmSeverity(withUnknown), 'critical')
  })
})

describe('告警等级：入库时快照，不在读时派生', () => {
  it('不传等级就按位图算，并且是**读回来**的', () => {
    const db = freshDb()
    try {
      const repo = new AlarmRepository(db)
      const mask = ALARM_BIT_MASKS[AlarmType.CoronaDischarge]
      const { id } = repo.insert({ deviceId: 'dev-1', channelId: 0, timestamp: 1000, alarmMask: mask })
      const row = db.prepare('SELECT severity FROM alarms WHERE id = ?').get(id) as {
        severity: string
      }
      assert.equal(row.severity, 'warning')

      const stored = repo.query({}).items[0]
      assert.ok(stored)
      assert.equal(stored.severity, 'warning')
    } finally {
      db.close()
    }
  })

  it('显式传入的等级优先于按位图派生', () => {
    const db = freshDb()
    try {
      const repo = new AlarmRepository(db)
      const mask = ALARM_BIT_MASKS[AlarmType.SPL]
      const { id } = repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        timestamp: 1000,
        alarmMask: mask,
        severity: 'critical'
      })
      const row = db.prepare('SELECT severity FROM alarms WHERE id = ?').get(id) as {
        severity: string
      }
      assert.equal(row.severity, 'critical')
    } finally {
      db.close()
    }
  })

  it('事后改位图**不会**改变已存的等级——这正是"列"而不是"读时算"的意义', () => {
    const db = freshDb()
    try {
      const repo = new AlarmRepository(db)
      const { id } = repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        timestamp: 1000,
        alarmMask: ALARM_BIT_MASKS[AlarmType.SPL] // 入库时判成 info
      })
      // 把位图换成会派生出 critical 的那一位。若实现是读时派生，等级会跟着变。
      db.prepare('UPDATE alarms SET alarm_mask = ? WHERE id = ?').run(
        ALARM_BIT_MASKS[AlarmType.ShortCircuitSurge],
        id
      )
      const row = db.prepare('SELECT severity FROM alarms WHERE id = ?').get(id) as {
        severity: string
      }
      assert.equal(row.severity, 'info', '等级是快照：改位图不该改写当时的判定')
    } finally {
      db.close()
    }
  })

  it('数据库里出现表外取值时收窄成 unknown，而不是原样透出', () => {
    const db = freshDb()
    try {
      const repo = new AlarmRepository(db)
      const { id } = repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        timestamp: 1000,
        alarmMask: ALARM_BIT_MASKS[AlarmType.SPL]
      })
      // 绕过 CHECK（模拟一个被外部工具改过的库文件）。
      db.pragma('ignore_check_constraints = ON')
      db.prepare('UPDATE alarms SET severity = ? WHERE id = ?').run('catastrophic', id)
      const stored = repo.query({}).items[0]
      assert.ok(stored)
      assert.equal(stored.severity, 'unknown')
    } finally {
      db.close()
    }
  })

  it('按等级筛选只返回那一档，且分档计数与筛选结果一致', () => {
    const db = freshDb()
    try {
      const repo = new AlarmRepository(db)
      repo.insert({ deviceId: 'dev-1', channelId: 0, timestamp: 1000, alarmMask: ALARM_BIT_MASKS[AlarmType.SPL] })
      repo.insert({ deviceId: 'dev-1', channelId: 0, timestamp: 2000, alarmMask: ALARM_BIT_MASKS[AlarmType.CoronaDischarge] })
      repo.insert({ deviceId: 'dev-1', channelId: 0, timestamp: 3000, alarmMask: ALARM_BIT_MASKS[AlarmType.Overload] })
      repo.insert({ deviceId: 'dev-1', channelId: 0, timestamp: 4000, alarmMask: 1 << 20 })

      const counts = repo.countBySeverity()
      assert.deepEqual(counts, { info: 1, warning: 1, critical: 1, unknown: 1 })

      for (const severity of EVENT_SEVERITIES) {
        const page = repo.query({ severity })
        assert.equal(page.total, counts[severity], `severity=${severity}`)
        for (const item of page.items) assert.equal(item.severity, severity)
      }
    } finally {
      db.close()
    }
  })

  it('分档计数把认不出来的取值计进 unknown，而不是丢掉', () => {
    const db = freshDb()
    try {
      const repo = new AlarmRepository(db)
      repo.insert({ deviceId: 'dev-1', channelId: 0, timestamp: 1000, alarmMask: ALARM_BIT_MASKS[AlarmType.SPL] })
      db.pragma('ignore_check_constraints = ON')
      db.prepare('UPDATE alarms SET severity = ? WHERE alarm_time = 1000').run('catastrophic')
      const counts = repo.countBySeverity()
      assert.equal(counts.unknown, 1)
      assert.equal(counts.info, 0)
    } finally {
      db.close()
    }
  })
})

describe('告警备注', () => {
  it('写入后读回；null 清除备注；空字符串是"写了空"，与"没有备注"不同', () => {
    const db = freshDb()
    try {
      const repo = new AlarmRepository(db)
      const { id } = repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        timestamp: 1000,
        alarmMask: ALARM_BIT_MASKS[AlarmType.SPL]
      })

      assert.equal(repo.query({}).items[0]?.note, undefined, '新建的告警没有备注字段')

      assert.equal(repo.setNote(id, '#3 机组，已通知检修'), true)
      assert.equal(repo.query({}).items[0]?.note, '#3 机组，已通知检修')

      assert.equal(repo.setNote(id, ''), true)
      assert.equal(repo.query({}).items[0]?.note, '', '空字符串是写进去的值，不是缺失')

      assert.equal(repo.setNote(id, null), true)
      assert.equal(repo.query({}).items[0]?.note, undefined, 'null 表示清除')
    } finally {
      db.close()
    }
  })

  it('恰好 500 字符可写，501 字符被拒且带可读原因（不是 SQLITE_CONSTRAINT）', () => {
    const db = freshDb()
    try {
      const repo = new AlarmRepository(db)
      const { id } = repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        timestamp: 1000,
        alarmMask: ALARM_BIT_MASKS[AlarmType.SPL]
      })

      assert.equal(ALARM_NOTE_MAX_LENGTH, 500)
      assert.equal(repo.setNote(id, 'x'.repeat(ALARM_NOTE_MAX_LENGTH)), true)
      assert.equal(repo.query({}).items[0]?.note?.length, ALARM_NOTE_MAX_LENGTH)

      assert.throws(
        () => repo.setNote(id, 'x'.repeat(ALARM_NOTE_MAX_LENGTH + 1)),
        /too long: 501 > 500/
      )
      // 被拒之后原值仍在（不是"改坏了一半"）。
      assert.equal(repo.query({}).items[0]?.note?.length, ALARM_NOTE_MAX_LENGTH)
    } finally {
      db.close()
    }
  })

  it('写不存在的告警返回 false，而不是抛错：界面要能区分"存下了"与"这条已经没了"', () => {
    const db = freshDb()
    try {
      const repo = new AlarmRepository(db)
      assert.equal(repo.setNote('no-such-alarm', '备注'), false)
      assert.equal(repo.setSeverity('no-such-alarm', 'warning'), false)
    } finally {
      db.close()
    }
  })
})

describe('人工改判等级', () => {
  it('改判后读回的是新等级，并且写的是同一条记录的快照', () => {
    const db = freshDb()
    try {
      const repo = new AlarmRepository(db)
      const { id } = repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        timestamp: 1000,
        alarmMask: ALARM_BIT_MASKS[AlarmType.CoolerAnomalyA] // 入库时 warning
      })
      assert.equal(repo.query({}).items[0]?.severity, 'warning')

      assert.equal(repo.setSeverity(id, 'critical'), true)
      assert.equal(repo.query({}).items[0]?.severity, 'critical')
      // 只有一条记录，没有第二套"人工等级"字段。
      const columns = (db.pragma('table_info(alarms)') as Array<{ name: string }>).map((r) => r.name)
      assert.equal(columns.filter((name) => name.includes('severity')).length, 1, columns.join(','))
    } finally {
      db.close()
    }
  })

  it('表外取值被拒（防止把界面传错的字符串写进库）', () => {
    const db = freshDb()
    try {
      const repo = new AlarmRepository(db)
      const { id } = repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        timestamp: 1000,
        alarmMask: ALARM_BIT_MASKS[AlarmType.SPL]
      })
      assert.throws(
        () => repo.setSeverity(id, 'catastrophic' as never),
        /unknown alarm severity: catastrophic/
      )
      assert.equal(repo.query({}).items[0]?.severity, 'info')
    } finally {
      db.close()
    }
  })
})
