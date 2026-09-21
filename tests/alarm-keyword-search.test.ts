/**
 * 告警查询的「标题 / 内容」关键字搜索（业主：告警中心筛选只留这两项 + 时间范围）。
 *
 * WHY THIS FILE EXISTS
 * 标题匹配**设备名**（跨表子查询）、内容匹配备注与设备原因文本。要钉住的边界：
 *   1. 两路 LIKE 真的缩小结果（且 `total` 与 items 一致）；
 *   2. 关键字里的 LIKE 特殊字符（`%` / `_` / `\`）被转义——搜一个下划线不许捞全库；
 *   3. 空关键字 = 不过滤（undefined 语义在仓储层收窄）；
 *   4. `likePattern()` 的转义行为本身（导出来就是为了让这条可测）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import Database from 'better-sqlite3'
import { openDatabase } from '../src/main/services/database/schema'
import { AlarmRepository, likePattern } from '../src/main/services/database/alarm-repository'
import { DeviceRepository } from '../src/main/services/database/device-repository'

function seed(repo: AlarmRepository, devices: DeviceRepository): { first: string; second: string } {
  const a = devices.upsertCamera(
    { ip: '10.0.0.1', httpPort: 80, username: 'a', password: 'x' },
    { deviceUid: 'u-1', name: '一号变压器' }
  )
  const b = devices.upsertCamera(
    { ip: '10.0.0.2', httpPort: 80, username: 'a', password: 'x' },
    { deviceUid: 'u-2', name: '二号开关柜' }
  )
  const first = repo.insert({
    deviceId: a.device.id,
    channelId: 0,
    timestamp: 1000,
    alarmMask: 1,
    deviceReason: '时域能量比超限'
  })
  repo.setNote(first.id, '轴承温度偏高')
  const second = repo.insert({
    deviceId: b.device.id,
    channelId: 1,
    timestamp: 2000,
    alarmMask: 2,
    deviceReason: '频谱峰值异常'
  })
  repo.setNote(second.id, '现场巡检确认无误报')
  return { first: a.device.id, second: b.device.id }
}

function fresh(): {
  alarms: AlarmRepository
  devices: DeviceRepository
  db: InstanceType<typeof Database>
} {
  const db = openDatabase({ file: ':memory:' })
  return { alarms: new AlarmRepository(db), devices: new DeviceRepository(db), db }
}

describe('告警关键字搜索：likePattern 转义', () => {
  it('% / _ / \\ 先转义再包 %', () => {
    assert.equal(likePattern('a%b'), '%a\\%b%')
    assert.equal(likePattern('a_b'), '%a\\_b%')
    assert.equal(likePattern('a\\b'), '%a\\\\b%')
    assert.equal(likePattern('普通'), '%普通%')
  })
})

describe('告警关键字搜索：查询', () => {
  it('标题搜设备名、内容搜备注/原因，两路都缩小结果且 total 精确', () => {
    const { alarms, devices, db } = fresh()
    try {
      const ids = seed(alarms, devices)
      const byTitle = alarms.query({ title: '变压器', limit: 100, offset: 0 })
      assert.equal(byTitle.total, 1)
      assert.equal(byTitle.items[0]!.deviceId, ids.first)

      const byNote = alarms.query({ content: '巡检', limit: 100, offset: 0 })
      assert.equal(byNote.total, 1)
      assert.equal(byNote.items[0]!.deviceId, ids.second)

      const byReason = alarms.query({ content: '能量比', limit: 100, offset: 0 })
      assert.equal(byReason.total, 1)
      assert.equal(byReason.items[0]!.deviceId, ids.first)
    } finally {
      db.close()
    }
  })

  it('LIKE 特殊字符被转义：搜一个下划线不会捞全库', () => {
    const { alarms, devices, db } = fresh()
    try {
      seed(alarms, devices)
      // 库里没有任何设备名/备注带下划线：转义后的字面搜索必须是 0 条；
      // 若转义缺失，`_%` 会匹配一切。
      assert.equal(alarms.query({ title: '_', limit: 100, offset: 0 }).total, 0)
      assert.equal(alarms.query({ content: '%', limit: 100, offset: 0 }).total, 0)
    } finally {
      db.close()
    }
  })

  it('空白关键字 = 不过滤；两路同搜取交集', () => {
    const { alarms, devices, db } = fresh()
    try {
      seed(alarms, devices)
      assert.equal(alarms.query({ title: '   ', limit: 100, offset: 0 }).total, 2)
      assert.equal(alarms.query({ title: '变压器', content: '能量比', limit: 100, offset: 0 }).total, 1)
      // 交集为空时就是 0：两路条件是 AND。
      assert.equal(alarms.query({ title: '变压器', content: '巡检', limit: 100, offset: 0 }).total, 0)
    } finally {
      db.close()
    }
  })

  it('时间范围与关键字可以叠加', () => {
    const { alarms, devices, db } = fresh()
    try {
      seed(alarms, devices)
      assert.equal(alarms.query({ content: '巡检', from: 1500, limit: 100, offset: 0 }).total, 1)
      assert.equal(alarms.query({ content: '能量比', from: 1500, limit: 100, offset: 0 }).total, 0)
    } finally {
      db.close()
    }
  })
})
