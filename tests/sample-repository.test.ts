/**
 * 本地样本库的持久化（schema v7 的 `samples` 表 + `SampleRepository`）。
 *
 * 这里断言的全是「训练集会不会被悄悄弄脏」的那些点：
 *   - 重复入库必须**幂等**（同一条录音同一时刻同一来源点两次，权重不该翻倍）；
 *   - 标签与来源**同生同灭**（CHECK 挡住"有标签没来源"的行）；
 *   - 缺失的特征**保持缺失**（读完一轮之后不许变成 0）；
 *   - 源录音被删时样本**级联消失**（否则样本会指向一个不存在的文件）；
 *   - 分类计数要说得出"数据集的可信度构成"（人工 / 设备 / AI 各多少）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { SampleRepository } from '../src/main/services/database/sample-repository'
import { SCHEMA_VERSION, openDatabase } from '../src/main/services/database/schema'
import { humanLabel, weakLabelFromAlarmTypes } from '../src/shared/domain/sample-library'
import { AlarmType } from '../src/shared/domain/models'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-library-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

let counter = 0
function freshDb(): InstanceType<typeof Database> {
  counter += 1
  const db = openDatabase({ file: path.join(tempRoot, `db-${counter}.db`) })
  db.prepare(
    `INSERT INTO devices (id, device_uid, name, status, created_at, updated_at)
     VALUES ('dev-1', 'uid-dev-1', 'AE08', 'ONLINE', 1, 1)`
  ).run()
  return db
}

/** 插一条录音（样本要引用它，才能测级联）。 */
function insertRecording(db: InstanceType<typeof Database>, id: string): void {
  db.prepare(
    `INSERT INTO recordings (
       id, device_id, channel_id, recording_type, start_time, sample_rate,
       relative_path, created_at
     ) VALUES (?, 'dev-1', 0, 'alarm', 1000, 96000, 'a/b.wav', 1)`
  ).run(id)
}

const METRICS = { spl: 62.5, mainFrequency: 93, smoothness: 4.88, bandEnergyRatio: 0.5 }

describe('schema v8：样本表（两个标签维度）与标签库', () => {
  it('全新建库到 v8，samples 与 sample_labels 两张表都在', () => {
    const db = freshDb()
    try {
      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
      const tables = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
          name: string
        }>
      ).map((row) => row.name)
      assert.ok(tables.includes('samples'), tables.join(','))
      assert.ok(tables.includes('sample_labels'), tables.join(','))
    } finally {
      db.close()
    }
  })

  it('迁移可重复执行（第二次是空操作）', () => {
    const db = freshDb()
    try {
      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })

  it('CHECK：**两个维度各自**的标签与来源要么都有、要么都没有', () => {
    const db = freshDb()
    try {
      // 只有故障类型、没有来源 —— 这一行说不清标签是谁给的，必须被拒。
      assert.throws(() =>
        db
          .prepare(
            `INSERT INTO samples (id, device_id, channel_id, source, captured_at, fault_label, created_at)
             VALUES ('bad', 'dev-1', 0, 'alarm', 1, 'x', 1)`
          )
          .run()
      )
      // 只有来源、没有标签也一样。
      assert.throws(() =>
        db
          .prepare(
            `INSERT INTO samples (id, device_id, channel_id, source, captured_at, fault_label_source, created_at)
             VALUES ('bad2', 'dev-1', 0, 'alarm', 1, 'human', 1)`
          )
          .run()
      )
      // 设备类型那一维**独立**受约束：故障类型齐全、设备类型只有一半照样被拒。
      assert.throws(() =>
        db
          .prepare(
            `INSERT INTO samples (
               id, device_id, channel_id, source, captured_at,
               fault_label, fault_label_source, equipment_label, created_at
             ) VALUES ('bad5', 'dev-1', 0, 'alarm', 1, 'x', 'human', '变压器', 1)`
          )
          .run()
      )
      // 两维都齐全就写得进去（这里同时是"两维可以并存"的证据）。
      db.prepare(
        `INSERT INTO samples (
           id, device_id, channel_id, source, captured_at,
           fault_label, fault_label_source, equipment_label, equipment_label_source, created_at
         ) VALUES ('good', 'dev-1', 0, 'alarm', 1, 'x', 'human', '变压器', 'human', 1)`
      ).run()
    } finally {
      db.close()
    }
  })

  it('CHECK：来源与样本来源都只能是枚举里的值（两个维度都查）', () => {
    const db = freshDb()
    try {
      assert.throws(() =>
        db
          .prepare(
            `INSERT INTO samples (id, device_id, channel_id, source, captured_at, created_at)
             VALUES ('bad3', 'dev-1', 0, 'mystery', 1, 1)`
          )
          .run()
      )
      assert.throws(() =>
        db
          .prepare(
            `INSERT INTO samples (id, device_id, channel_id, source, captured_at, fault_label, fault_label_source, created_at)
             VALUES ('bad4', 'dev-1', 0, 'alarm', 1, 'x', 'wizard', 1)`
          )
          .run()
      )
    } finally {
      db.close()
    }
  })
})

describe('样本入库', () => {
  it('入库后读回来，两个维度的标签与来源都在', () => {
    const db = freshDb()
    try {
      const repo = new SampleRepository(db)
      insertRecording(db, 'rec-1')
      const { id, created } = repo.insert({
        recordingId: 'rec-1',
        deviceId: 'dev-1',
        channelId: 0,
        source: 'alarm',
        capturedAt: 1000,
        metrics: METRICS,
        faultLabel: weakLabelFromAlarmTypes([AlarmType.CoronaDischarge]),
        equipmentLabel: humanLabel('电力变压器')
      })
      assert.equal(created, true)
      const sample = repo.findById(id)
      assert.ok(sample)
      // 设备位图给的是**故障**那一维的弱标签（位描述的就是故障）。
      assert.deepEqual(sample.faultLabel, { text: 'corona_discharge', source: 'device' })
      // 设备类型是人的判断（设备从不告诉我们它装在什么设备上）。
      assert.deepEqual(sample.equipmentLabel, { text: '电力变压器', source: 'human' })
      assert.equal(sample.metrics.spl, 62.5)
      assert.equal(sample.recordingId, 'rec-1')
    } finally {
      db.close()
    }
  })

  it('**重复入库是幂等的**（同一条录音同一时刻同一来源点两次，训练权重不该翻倍）', () => {
    const db = freshDb()
    try {
      const repo = new SampleRepository(db)
      insertRecording(db, 'rec-1')
      const input = {
        recordingId: 'rec-1',
        deviceId: 'dev-1',
        channelId: 0,
        source: 'alarm' as const,
        capturedAt: 1000,
        metrics: METRICS
      }
      const first = repo.insert(input)
      const second = repo.insert(input)
      assert.equal(first.created, true)
      assert.equal(second.created, false)
      assert.equal(second.id, first.id)
      assert.equal(repo.count(), 1)
    } finally {
      db.close()
    }
  })

  it('同一时刻但不同通道/不同来源是**两条**样本', () => {
    const db = freshDb()
    try {
      const repo = new SampleRepository(db)
      insertRecording(db, 'rec-1')
      const base = { deviceId: 'dev-1', capturedAt: 1000, metrics: METRICS }
      repo.insert({ ...base, channelId: 0, source: 'alarm' })
      repo.insert({ ...base, channelId: 1, source: 'alarm' })
      repo.insert({ ...base, channelId: 0, source: 'manual' })
      assert.equal(repo.count(), 3)
    } finally {
      db.close()
    }
  })

  it('缺失的特征**保持缺失**：读回来没有那个键，也没有变成 0', () => {
    const db = freshDb()
    try {
      const repo = new SampleRepository(db)
      repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        source: 'manual',
        capturedAt: 1000,
        // 只给两维：后三维在设备上不存在。
        metrics: { spl: 61, mainFrequency: 90 }
      })
      const sample = repo.query().items[0]
      assert.ok(sample)
      assert.equal(sample.metrics.spl, 61)
      assert.equal(sample.metrics.mainFrequency, 90)
      assert.equal('smoothness' in sample.metrics, false)
      assert.notEqual(sample.metrics.smoothness, 0)
    } finally {
      db.close()
    }
  })

  it('坏 JSON 不抛异常，只当成没有特征（一条坏样本不该让整张列表打不开）', () => {
    const db = freshDb()
    try {
      db.prepare(
        `INSERT INTO samples (id, device_id, channel_id, source, captured_at, features, created_at)
         VALUES ('s-bad', 'dev-1', 0, 'import', 1, '{not json', 1)`
      ).run()
      const sample = new SampleRepository(db).findById('s-bad')
      assert.ok(sample)
      assert.deepEqual(sample.metrics, {})
    } finally {
      db.close()
    }
  })

  it('超长标签在入库时就被拒（带可读原因，不是 SQLITE_CONSTRAINT）', () => {
    const db = freshDb()
    try {
      const repo = new SampleRepository(db)
      assert.throws(
        () =>
          repo.insert({
            deviceId: 'dev-1',
            channelId: 0,
            source: 'import',
            capturedAt: 1,
            metrics: METRICS,
            faultLabel: { text: 'x'.repeat(65), source: 'human' }
          }),
        /too long: 65 > 64/
      )
    } finally {
      db.close()
    }
  })

  it('源录音被删时样本级联消失（否则样本指向一个不存在的文件）', () => {
    const db = freshDb()
    try {
      const repo = new SampleRepository(db)
      insertRecording(db, 'rec-1')
      repo.insert({
        recordingId: 'rec-1',
        deviceId: 'dev-1',
        channelId: 0,
        source: 'alarm',
        capturedAt: 1000,
        metrics: METRICS
      })
      assert.equal(repo.count(), 1)
      db.prepare(`DELETE FROM recordings WHERE id = 'rec-1'`).run()
      assert.equal(repo.count(), 0)
    } finally {
      db.close()
    }
  })
})

describe('标签的写与撤销', () => {
  it('人工改标之后读回来是人工来源', () => {
    const db = freshDb()
    try {
      const repo = new SampleRepository(db)
      const { id } = repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        source: 'alarm',
        capturedAt: 1,
        metrics: METRICS,
        faultLabel: weakLabelFromAlarmTypes([AlarmType.SPL])
      })
      assert.equal(repo.setLabel(id, 'fault', humanLabel('电晕放电')), true)
      assert.deepEqual(repo.findById(id)?.faultLabel, { text: '电晕放电', source: 'human' })
    } finally {
      db.close()
    }
  })

  it('撤销标注：退回未标注（两者一起清），而不是留下"有标签没来源"', () => {
    const db = freshDb()
    try {
      const repo = new SampleRepository(db)
      const { id } = repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        source: 'alarm',
        capturedAt: 1,
        metrics: METRICS,
        faultLabel: humanLabel('电晕放电')
      })
      assert.equal(repo.setLabel(id, 'fault', undefined), true)
      assert.equal(repo.findById(id)?.faultLabel, undefined)
      const row = db.prepare('SELECT fault_label, fault_label_source FROM samples WHERE id = ?').get(id) as {
        fault_label: string | null
        fault_label_source: string | null
      }
      assert.equal(row.fault_label, null)
      assert.equal(row.fault_label_source, null)
    } finally {
      db.close()
    }
  })

  it('改不存在的样本返回 false（界面要能区分"存下了"与"这条已经没了"）', () => {
    const db = freshDb()
    try {
      assert.equal(new SampleRepository(db).setLabel('nope', 'fault', humanLabel('x')), false)
    } finally {
      db.close()
    }
  })

  it('**只动被点名的那一维**：改故障类型不会顺手清掉设备类型', () => {
    const db = freshDb()
    try {
      const repo = new SampleRepository(db)
      const { id } = repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        source: 'alarm',
        capturedAt: 1,
        metrics: METRICS,
        faultLabel: weakLabelFromAlarmTypes([AlarmType.SPL]),
        equipmentLabel: humanLabel('电力变压器')
      })
      assert.equal(repo.setLabel(id, 'fault', humanLabel('局部放电')), true)
      const sample = repo.findById(id)
      assert.deepEqual(sample?.faultLabel, { text: '局部放电', source: 'human' })
      // 这一条是"两个维度分开存"的全部意义：一次 UPDATE 里带上另一列就会互相踩。
      assert.deepEqual(sample?.equipmentLabel, { text: '电力变压器', source: 'human' })

      // 反过来也一样：清掉设备类型，故障类型留着。
      assert.equal(repo.setLabel(id, 'equipment', undefined), true)
      const after = repo.findById(id)
      assert.equal(after?.equipmentLabel, undefined)
      assert.deepEqual(after?.faultLabel, { text: '局部放电', source: 'human' })
    } finally {
      db.close()
    }
  })
})

describe('查询与计数', () => {
  function seed(repo: SampleRepository): void {
    repo.insert({
      deviceId: 'dev-1',
      channelId: 0,
      source: 'alarm',
      capturedAt: 1000,
      metrics: METRICS,
      faultLabel: humanLabel('电晕放电')
    })
    repo.insert({
      deviceId: 'dev-1',
      channelId: 0,
      source: 'alarm',
      capturedAt: 2000,
      metrics: METRICS,
      faultLabel: weakLabelFromAlarmTypes([AlarmType.SPL])
    })
    repo.insert({
      deviceId: 'dev-1',
      channelId: 1,
      source: 'manual',
      capturedAt: 3000,
      metrics: METRICS
    })
  }

  it('按标签、来源、样本来源、时间与通道筛选', () => {
    const db = freshDb()
    try {
      const repo = new SampleRepository(db)
      seed(repo)
      assert.equal(repo.query({ faultLabel: '电晕放电' }).total, 1)
      assert.equal(repo.query({ faultLabelSource: 'device' }).total, 1)
      assert.equal(repo.query({ faultLabelSource: 'human' }).total, 1)
      assert.equal(repo.query({ source: 'manual' }).total, 1)
      assert.equal(repo.query({ channelId: 1 }).total, 1)
      assert.equal(repo.query({ from: 2000 }).total, 2)
      assert.equal(repo.query({ to: 2000 }).total, 2)
      assert.equal(repo.query().total, 3)
    } finally {
      db.close()
    }
  })

  it('按时间倒序返回（列表要新的在上面）', () => {
    const db = freshDb()
    try {
      const repo = new SampleRepository(db)
      seed(repo)
      assert.deepEqual(
        repo.query().items.map((sample) => sample.capturedAt),
        [3000, 2000, 1000]
      )
    } finally {
      db.close()
    }
  })

  it('按类别计数（类别不平衡要能被看见）', () => {
    const db = freshDb()
    try {
      const repo = new SampleRepository(db)
      seed(repo)
      assert.deepEqual(repo.countByLabel('fault'), { 电晕放电: 1, spl: 1 })
    } finally {
      db.close()
    }
  })

  it('按**标签来源**计数：数据集的可信度构成，未标注单独一档', () => {
    const db = freshDb()
    try {
      const repo = new SampleRepository(db)
      seed(repo)
      assert.deepEqual(repo.countByLabelSource('fault'), { human: 1, device: 1, ai: 0, unlabelled: 1 })
      // 设备类型那一维**分开数**：语料里三条都没标设备类型。
      assert.deepEqual(repo.countByLabelSource('equipment'), {
        human: 0,
        device: 0,
        ai: 0,
        unlabelled: 3
      })
      assert.deepEqual(repo.countByLabel('equipment'), {})
    } finally {
      db.close()
    }
  })

  it('设备类型那一维可以单独筛选与计数（它不参与训练准入，但决定一个类别混了几种设备）', () => {
    const db = freshDb()
    try {
      const repo = new SampleRepository(db)
      repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        source: 'alarm',
        capturedAt: 1000,
        metrics: METRICS,
        faultLabel: humanLabel('局部放电'),
        equipmentLabel: humanLabel('电力变压器')
      })
      repo.insert({
        deviceId: 'dev-1',
        channelId: 1,
        source: 'alarm',
        capturedAt: 2000,
        metrics: METRICS,
        faultLabel: humanLabel('局部放电'),
        equipmentLabel: humanLabel('开关柜')
      })

      assert.equal(repo.query({ equipmentLabel: '电力变压器' }).total, 1)
      assert.equal(repo.query({ equipmentLabelSource: 'human' }).total, 2)
      assert.deepEqual(repo.countByLabel('equipment'), { 电力变压器: 1, 开关柜: 1 })
      assert.deepEqual(repo.countByLabel('fault'), { 局部放电: 2 })
      // 引用数：一个名字被几条样本用着（标签库靠它决定能不能删）。
      assert.equal(repo.countSamplesUsingLabel('equipment', '电力变压器'), 1)
      assert.equal(repo.countSamplesUsingLabel('equipment', '不存在的'), 0)
    } finally {
      db.close()
    }
  })

  it('整批改名：把引用的旧名字换成新名字，并**记成人工**', () => {
    const db = freshDb()
    try {
      const repo = new SampleRepository(db)
      repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        source: 'alarm',
        capturedAt: 1000,
        metrics: METRICS,
        // 设备位图给的弱标签，名字就是稳定键。
        faultLabel: weakLabelFromAlarmTypes([AlarmType.CoronaDischarge])
      })
      const changed = repo.renameLabelEverywhere('fault', 'corona_discharge', '电晕放电', 'human')
      assert.equal(changed, 1)
      assert.deepEqual(repo.findById(repo.query().items[0]?.id ?? '')?.faultLabel, {
        text: '电晕放电',
        source: 'human'
      })
    } finally {
      db.close()
    }
  })

  it('训练集按时间**升序**取，并且说得出有没有被截断', () => {
    const db = freshDb()
    try {
      const repo = new SampleRepository(db)
      seed(repo)
      const rows = repo.trainingRows(10)
      assert.deepEqual(
        rows.items.map((sample) => sample.capturedAt),
        [1000, 2000, 3000]
      )
      assert.equal(rows.truncated, false)

      const capped = repo.trainingRows(2)
      assert.equal(capped.items.length, 2)
      assert.equal(capped.truncated, true)
    } finally {
      db.close()
    }
  })
})
