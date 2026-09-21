/**
 * schema v16 —— 设备的**接入方案**（业主 2026-09-19 第 13 批第 3、4 条）。
 *
 * WHY THIS FILE EXISTS
 * 这一条迁移只加一列（`devices.ingest_plan TEXT NOT NULL DEFAULT ''`），风险全在**读出**那一侧：
 *
 *   1. **旧库里的行没有这一列**（迁移加上去之后是空串）—— 读出来必须是"出厂方案"，
 *      而不是 `undefined`（界面要拿它回答"这台设备走哪种协议"，`none` 是一个有意义的答案）；
 *   2. **列里存的是不可信输入**（手改过的 JSON、写到一半的进程）：坏 JSON **不能抛** ——
 *      `devices.list()` 是每一页都要走的，为了一台设备的配置让整张表读不出来代价完全不成比例；
 *   3. **写回要读回核对**，而且"省略 = 不动这一项"（重新添加一台已知设备只是刷新地址，
 *      不该把操作员配好的协议与遥测键抹回出厂值）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { MIGRATIONS, SCHEMA_VERSION, openDatabase, runMigrations } from '../src/main/services/database/schema'
import { DeviceRepository } from '../src/main/services/database/device-repository'
import { defaultIngestMetricKeys, normaliseDeviceIngestPlan } from '../src/shared/domain/iot-ingest'

let db: Database.Database

before(() => {
  db = openDatabase({ file: ':memory:' })
})

after(() => {
  db.close()
})

function seedDevice(repository: DeviceRepository, ip: string): string {
  const { device } = repository.upsertCamera(
    { ip, httpPort: 80, username: 'admin', password: 'x' },
    { deviceUid: `cam-${ip}`, name: `相机 ${ip}` }
  )
  return device.id
}

describe('schema v16 —— 设备的接入方案', () => {
  it('版本常量与迁移表的最高版本一致', () => {
    const highest = Math.max(...MIGRATIONS.map((migration) => migration.version))
    assert.equal(SCHEMA_VERSION, highest)
    // v17（device_status_events）之后这里跟着涨；它断的是"加了迁移忘了抬版本号"的那种错。
    assert.equal(SCHEMA_VERSION, 17)
  })

  it('这一列有默认值：旧行读出来就是**出厂方案**（none + 四个规范键 + video_url）', () => {
    const device = new DeviceRepository(db).findById(seedDevice(new DeviceRepository(db), '10.0.0.1'))
    assert.ok(device, '设备没有读回来')
    assert.deepEqual(device.ingest, normaliseDeviceIngestPlan(undefined))
    assert.equal(device.ingest?.protocol, 'none')
    assert.deepEqual(device.ingest?.metricKeys, defaultIngestMetricKeys())
  })

  it('写回读回：协议与遥测键逐项相等（写设备的操作必须读回验证）', () => {
    const repository = new DeviceRepository(db)
    const id = seedDevice(repository, '10.0.0.2')
    const plan = {
      protocol: 'mqtt' as const,
      metricKeys: [
        { metric: 'spl' as const, key: 'my_spl' },
        { metric: 'mainFrequency' as const, key: 'f0' }
      ],
      videoKey: 'cam_url'
    }
    const readBack = repository.setIngestPlan(id, plan)
    assert.ok(readBack, '写回之后读不回来')
    assert.equal(readBack.protocol, 'mqtt')
    assert.deepEqual(readBack.metricKeys, plan.metricKeys)
    assert.equal(readBack.videoKey, 'cam_url')
    // 再读一次（新的一次查询）：库里存的就是这一份。
    assert.deepEqual(repository.getIngestPlan(id), readBack)
  })

  it('坏 JSON 不抛：读成出厂方案（一台设备的配置不该让整张表读不出来）', () => {
    const repository = new DeviceRepository(db)
    const id = seedDevice(repository, '10.0.0.3')
    db.prepare(`UPDATE devices SET ingest_plan = ? WHERE id = ?`).run('{not json', id)
    const device = repository.findById(id)
    assert.equal(device?.ingest?.protocol, 'none', '坏 JSON 没有回落到出厂方案')
    // 坏**值**（合法 JSON、但不合法的方案）同样被规范化。
    db.prepare(`UPDATE devices SET ingest_plan = ? WHERE id = ?`).run(
      JSON.stringify({ protocol: 'MQTT', metricKeys: [{ metric: 'nope', key: 'x' }] }),
      id
    )
    const second = repository.findById(id)
    assert.equal(second?.ingest?.protocol, 'none')
    assert.deepEqual(second?.ingest?.metricKeys, defaultIngestMetricKeys())
  })

  it('`update()` 省略 plan 就**不动**它（重新添加/改名不该抹掉配好的接入方式）', () => {
    const repository = new DeviceRepository(db)
    const id = seedDevice(repository, '10.0.0.4')
    repository.setIngestPlan(id, { protocol: 'http', videoKey: 'v_url' })
    repository.update({ id, name: '改了个名字' })
    const afterRename = repository.findById(id)
    assert.equal(afterRename?.name, '改了个名字')
    assert.equal(afterRename?.ingest?.protocol, 'http', '改名字把接入方式抹掉了')
    assert.equal(afterRename?.ingest?.videoKey, 'v_url')
    // 给了 plan 就按它写。
    repository.update({ id, ingest: { protocol: 'none' } as never })
    assert.equal(repository.findById(id)?.ingest?.protocol, 'none')
  })

  it('`listIngestProtocols()` 只回协议（监听开关的判据最多一条 SQL）', () => {
    const repository = new DeviceRepository(db)
    const id = seedDevice(repository, '10.0.0.5')
    const before = repository.listIngestProtocols()
    assert.equal(before.includes('http'), false, '这一条不该被别的用例带出来')
    repository.setIngestPlan(id, { protocol: 'http' })
    assert.equal(repository.listIngestProtocols().includes('http'), true)
    repository.setIngestPlan(id, { protocol: 'none' })
    assert.equal(repository.listIngestProtocols().includes('http'), false)
  })

  it('迁移可重复执行（第二次是空操作）', () => {
    const fresh = openDatabase({ file: ':memory:' })
    try {
      assert.equal(runMigrations(fresh), SCHEMA_VERSION)
      assert.equal(runMigrations(fresh), SCHEMA_VERSION)
      // 列在，而且有默认值。
      const columns = fresh.prepare(`SELECT name FROM pragma_table_info('devices')`).all() as Array<{
        name: string
      }>
      assert.ok(columns.some((column) => column.name === 'ingest_plan'), 'ingest_plan 列不在')
    } finally {
      fresh.close()
    }
  })
})
