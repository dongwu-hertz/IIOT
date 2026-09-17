/**
 * 标签库（两个维度：设备类型 / 故障类型）的维护与使用。
 *
 * 业主 2026-09-16：「应该有个专门的功能去做标签的添加和设备类型添加维护，之后在打标签时，
 * 直接选择故障类型和设备类型或新建故障类型和设备类型」。
 *
 * 这一组断言对准的全是"一个会被反复编辑的词表"最容易出的问题：
 *   - 同一个类别的两种写法（多一个空格、大小写不同）**不能变成两个类别**；
 *   - 改名要**连历史样本一起改**（否则筛选下拉与样本对不上，看起来像数据丢了）；
 *   - 还有样本在用就**不许删**，而且要说得出有多少条在用；
 *   - 两个维度各自独立：同一个名字在设备类型与故障类型里可以同时存在。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { SampleLabelRepository } from '../src/main/services/database/sample-label-repository'
import { SampleRepository } from '../src/main/services/database/sample-repository'
import { SampleLabelService } from '../src/main/services/sample/sample-label-service'
import { openDatabase } from '../src/main/services/database/schema'
import { humanLabel, labelNameKey } from '../src/shared/domain/sample-library'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-labels-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

let counter = 0
interface Harness {
  db: InstanceType<typeof Database>
  samples: SampleRepository
  labels: SampleLabelRepository
  service: SampleLabelService
}

function harness(): Harness {
  counter += 1
  const db = openDatabase({ file: path.join(tempRoot, `db-${counter}.db`) })
  db.prepare(
    `INSERT INTO devices (id, device_uid, name, status, created_at, updated_at)
     VALUES ('dev-1', 'uid-dev-1', 'AE08', 'ONLINE', 1, 1)`
  ).run()
  const samples = new SampleRepository(db)
  const labels = new SampleLabelRepository(db)
  return { db, samples, labels, service: new SampleLabelService({ labels, samples }) }
}

const METRICS = { spl: 62.5, mainFrequency: 93, smoothness: 4.88, bandEnergyRatio: 0.5 }

describe('标签库：加一条', () => {
  it('空名被拒（不是"加了个空的"）', () => {
    const { db, service } = harness()
    try {
      assert.throws(() => service.add('fault', '   '), /不能为空/)
      assert.throws(() => service.add('fault', '，，'), /不能为空/)
    } finally {
      db.close()
    }
  })

  it('不认识的维度被拒（不是默认落到故障类型）', () => {
    const { db, service } = harness()
    try {
      assert.throws(() => service.add('device_kind', '变压器'), /未知的标签维度/)
    } finally {
      db.close()
    }
  })

  it('同名幂等：多一个空格、尾随标点、大小写不同都算同一个', () => {
    const { db, service } = harness()
    try {
      const first = service.add('fault', '轴承故障')
      assert.equal(first.ok, true)
      assert.equal(first.created, true)

      const spaced = service.add('fault', '  轴承故障  ')
      assert.equal(spaced.created, false)
      assert.equal(spaced.id, first.id)

      const punctuated = service.add('fault', '轴承故障，')
      assert.equal(punctuated.created, false)
      assert.equal(punctuated.id, first.id)

      const upper = service.add('fault', 'Bearing')
      assert.equal(upper.created, true)
      const lower = service.add('fault', 'bearing')
      assert.equal(lower.created, false)
      assert.equal(lower.id, upper.id)

      // 库里存的是**第一次**那一份写法：后来的写法是同一个类别，不该新增一条。
      assert.deepEqual(
        service.list().fault.map((entry) => entry.name),
        ['Bearing', '轴承故障']
      )
    } finally {
      db.close()
    }
  })

  it('两个维度各自独立：同一个名字可以同时是设备类型和故障类型', () => {
    const { db, service } = harness()
    try {
      assert.equal(service.add('equipment', '电机').created, true)
      assert.equal(service.add('fault', '电机').created, true)
      assert.equal(service.list().equipment.length, 1)
      assert.equal(service.list().fault.length, 1)
    } finally {
      db.close()
    }
  })

  it('`labelNameKey()` 就是唯一性的键（去空白、去尾随标点、抹平大小写）', () => {
    assert.equal(labelNameKey(' 轴承故障 '), '轴承故障')
    assert.equal(labelNameKey('Bearing  Fault'), 'bearing fault')
    assert.equal(labelNameKey('轴承故障，'), '轴承故障')
    assert.equal(labelNameKey('   '), undefined)
  })

  it('`ensureLabel()` 返回**库里那一份**写法（打标签时用它写样本）', () => {
    const { db, service } = harness()
    try {
      assert.equal(service.ensureLabel('fault', '  轴承故障， '), '轴承故障')
      // 第二次用另一种写法，仍然拿回库里的那一份 —— 否则同一个类别会分裂成两个。
      assert.equal(service.ensureLabel('fault', '轴承故障'), '轴承故障')
      assert.equal(service.list().fault.length, 1)
    } finally {
      db.close()
    }
  })
})

describe('标签库：改名', () => {
  it('改名会**连样本一起改**，并报出改了几条；样本来源记成人工', () => {
    const { db, samples, service } = harness()
    try {
      const entry = service.add('fault', 'corona_discharge')
      const id = entry.id ?? ''
      for (const capturedAt of [1000, 2000]) {
        samples.insert({
          deviceId: 'dev-1',
          channelId: 0,
          source: 'alarm',
          capturedAt,
          metrics: METRICS,
          // 设备位图给的弱标签：名字就是稳定键。
          faultLabel: humanLabel('corona_discharge')
        })
      }

      const result = service.rename(id, '电晕放电')
      assert.equal(result.ok, true)
      assert.equal(result.name, '电晕放电')
      assert.equal(result.affectedSamples, 2)
      assert.equal(service.list().fault[0]?.name, '电晕放电')

      // 样本里的旧名字必须**一条都不剩**：留着它们会让"按故障类型筛选"列出 0 条。
      assert.deepEqual(samples.countByLabel('fault'), { 电晕放电: 2 })
      assert.equal(samples.query({ faultLabel: 'corona_discharge' }).total, 0)
      // 改名是人的动作，所以来源变成人工。
      const first = samples.query().items[0]
      assert.equal(first?.faultLabel?.source, 'human')
    } finally {
      db.close()
    }
  })

  it('撞上同维已有名字 ⇒ 拒绝，而且**什么都不动**', () => {
    const { db, samples, service } = harness()
    try {
      const a = service.add('fault', '局部放电')
      service.add('fault', '轴承故障')
      const id = a.id ?? ''
      samples.insert({
        deviceId: 'dev-1',
        channelId: 0,
        source: 'alarm',
        capturedAt: 1000,
        metrics: METRICS,
        faultLabel: humanLabel('局部放电')
      })

      const result = service.rename(id, '轴承故障')
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'duplicate')
      // 拒绝之后：标签库与样本都保持原样（不能出现"改了一半"）。
      assert.deepEqual(
        service.list().fault.map((entry) => entry.name),
        ['局部放电', '轴承故障']
      )
      assert.deepEqual(samples.countByLabel('fault'), { 局部放电: 1 })
    } finally {
      db.close()
    }
  })

  it('改成自己原来的名字（只是大小写/空格变了）不算冲突', () => {
    const { db, service } = harness()
    try {
      const entry = service.add('fault', 'bearing')
      const result = service.rename(entry.id ?? '', 'Bearing')
      assert.equal(result.ok, true)
      assert.equal(result.name, 'Bearing')
      assert.equal(service.list().fault.length, 1)
    } finally {
      db.close()
    }
  })

  it('改不存在的 id ⇒ not-found', () => {
    const { db, service } = harness()
    try {
      const result = service.rename('nope', 'x')
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'not-found')
    } finally {
      db.close()
    }
  })
})

describe('标签库：删除', () => {
  it('还有样本在用 ⇒ 拒绝，并说得出有多少条在用', () => {
    const { db, samples, service } = harness()
    try {
      const entry = service.add('equipment', '电力变压器')
      const id = entry.id ?? ''
      samples.insert({
        deviceId: 'dev-1',
        channelId: 0,
        source: 'alarm',
        capturedAt: 1000,
        metrics: METRICS,
        equipmentLabel: humanLabel('电力变压器')
      })

      const result = service.remove(id)
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'in-use')
      assert.equal(result.usedBy, 1)
      // 被拒之后那条标签**还在**（不然样本会指向一个不存在的类别）。
      assert.equal(service.list().equipment.length, 1)
    } finally {
      db.close()
    }
  })

  it('没人用就删掉', () => {
    const { db, service } = harness()
    try {
      const entry = service.add('fault', '没人用的类别')
      const result = service.remove(entry.id ?? '')
      assert.equal(result.ok, true)
      assert.equal(service.list().fault.length, 0)

      const missing = service.remove(entry.id ?? '')
      assert.equal(missing.ok, false)
      assert.equal(missing.reason, 'not-found')
    } finally {
      db.close()
    }
  })

  it('`usedBy` 是**现场数出来的**，样本被删掉之后立刻跟着变', () => {
    const { db, samples, service } = harness()
    try {
      const entry = service.add('equipment', '开关柜')
      const inserted = samples.insert({
        deviceId: 'dev-1',
        channelId: 0,
        source: 'alarm',
        capturedAt: 1000,
        metrics: METRICS,
        equipmentLabel: humanLabel('开关柜')
      })
      assert.equal(service.list().equipment[0]?.usedBy, 1)
      samples.delete(inserted.id)
      assert.equal(service.list().equipment[0]?.usedBy, 0)
      // 现在可以删了。
      assert.equal(service.remove(entry.id ?? '').ok, true)
    } finally {
      db.close()
    }
  })
})

describe('标签库：清单', () => {
  it('两个维度分开返回，按名字排序', () => {
    const { db, service } = harness()
    try {
      service.add('fault', '轴承故障')
      service.add('fault', '电晕放电')
      service.add('equipment', '开关柜')

      const list = service.list()
      assert.deepEqual(
        list.fault.map((entry) => entry.name),
        ['电晕放电', '轴承故障']
      )
      assert.deepEqual(
        list.equipment.map((entry) => entry.name),
        ['开关柜']
      )
      assert.deepEqual(service.names('fault'), ['电晕放电', '轴承故障'])
    } finally {
      db.close()
    }
  })

  it('一条都没有时返回两个空数组（不是 undefined）', () => {
    const { db, service } = harness()
    try {
      assert.deepEqual(service.list(), { equipment: [], fault: [] })
    } finally {
      db.close()
    }
  })
})
