/**
 * 设备上线 / 离线事件（schema v17，业主：事件中心把「设备离线」纳入时间线）。
 *
 * WHY THIS FILE EXISTS
 * 这一张表与它的仓储是事件中心第四路来源的事实基础，要钉住的行为：
 *   1. 落库即带等级快照（ONLINE → info / OFFLINE → warning），读侧不再派生；
 *   2. 查询过滤（设备 / 时间窗 / 确认状态 / 等级）与**精确**总数；
 *   3. 确认 / 取消确认；保留清扫按时间窗删。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import Database from 'better-sqlite3'
import { openDatabase } from '../src/main/services/database/schema'
import {
  DeviceStatusEventRepository,
  severityForStatus
} from '../src/main/services/database/device-status-event-repository'

function freshRepo(): { repo: DeviceStatusEventRepository; db: InstanceType<typeof Database> } {
  const db = openDatabase({ file: ':memory:' })
  return { repo: new DeviceStatusEventRepository(db), db }
}

describe('设备状态事件：落库', () => {
  it('severity 在写入时定死：ONLINE → info / OFFLINE → warning', () => {
    assert.equal(severityForStatus('ONLINE'), 'info')
    assert.equal(severityForStatus('OFFLINE'), 'warning')
    const { repo, db } = freshRepo()
    try {
      const online = repo.record({ deviceId: 'd1', deviceName: '机房A', status: 'ONLINE', at: 1000 })
      const offline = repo.record({ deviceId: 'd1', deviceName: '机房A', status: 'OFFLINE', at: 2000 })
      assert.equal(online.severity, 'info')
      assert.equal(offline.severity, 'warning')
      assert.equal(online.acknowledged, false)
      // 设备名是写入时刻的快照。
      assert.equal(offline.deviceName, '机房A')
    } finally {
      db.close()
    }
  })

  it('两条翻转各是各的行，按时间倒序回来', () => {
    const { repo, db } = freshRepo()
    try {
      repo.record({ deviceId: 'd1', deviceName: 'A', status: 'ONLINE', at: 1000 })
      repo.record({ deviceId: 'd1', deviceName: 'A', status: 'OFFLINE', at: 3000 })
      repo.record({ deviceId: 'd1', deviceName: 'A', status: 'ONLINE', at: 2000 })
      const page = repo.query({ limit: 10 })
      assert.equal(page.total, 3)
      assert.deepEqual(
        page.items.map((item) => item.at),
        [3000, 2000, 1000]
      )
    } finally {
      db.close()
    }
  })
})

describe('设备状态事件：查询与确认', () => {
  it('设备 / 时间窗 / 确认状态 / 等级 过滤都生效，total 精确', () => {
    const { repo, db } = freshRepo()
    try {
      repo.record({ deviceId: 'd1', deviceName: 'A', status: 'OFFLINE', at: 1000 })
      repo.record({ deviceId: 'd2', deviceName: 'B', status: 'ONLINE', at: 2000 })
      repo.record({ deviceId: 'd1', deviceName: 'A', status: 'ONLINE', at: 3000 })

      assert.equal(repo.query({ deviceId: 'd1', limit: 10 }).total, 2)
      assert.equal(repo.query({ from: 1500, to: 2500, limit: 10 }).total, 1)
      assert.equal(repo.query({ severity: 'warning', limit: 10 }).total, 1)
      assert.equal(repo.query({ severity: 'info', limit: 10 }).total, 2)

      const unack = repo.query({ acknowledged: false, limit: 10 })
      assert.equal(unack.total, 3)
      repo.acknowledge([unack.items[0]!.id], true)
      assert.equal(repo.query({ acknowledged: true, limit: 10 }).total, 1)
      assert.equal(repo.query({ acknowledged: false, limit: 10 }).total, 2)
      // 取消确认同样走得通。
      repo.acknowledge([unack.items[0]!.id], false)
      assert.equal(repo.query({ acknowledged: false, limit: 10 }).total, 3)
    } finally {
      db.close()
    }
  })

  it('prune 按时间窗删，返回删掉的条数', () => {
    const { repo, db } = freshRepo()
    try {
      repo.record({ deviceId: 'd1', deviceName: 'A', status: 'ONLINE', at: 1000 })
      repo.record({ deviceId: 'd1', deviceName: 'A', status: 'OFFLINE', at: 2000 })
      repo.record({ deviceId: 'd1', deviceName: 'A', status: 'ONLINE', at: 3000 })
      assert.equal(repo.prune(2500), 2)
      assert.equal(repo.query({ limit: 10 }).total, 1)
    } finally {
      db.close()
    }
  })
})
