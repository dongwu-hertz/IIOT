/**
 * 样本库 → 外部训练数据集（`SampleDatasetExporter`）。
 *
 * 这一组断言对准的是「交给外部训练之后会不会被误读」的那几件事：
 *   - **缺失维度不许变成 0**：JSONL 里是 `null`（每行键一致），CSV 里是空格；
 *   - **中文逗号必须被转义**：标签里带逗号是常态，不转义会让整张表错位；
 *   - **CSV 带 BOM**：不带的话 Excel 把中文读成乱码，而那一列正是人要看的；
 *   - **维度顺序写进 dataset-info.json**：接收方不必猜 7 维的顺序；
 *   - **音频缺失如实计数**：静默跳过会让半个数据集看起来是完整的；
 *   - **只导出已标注**时要报出被跳过的条数。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { SampleDatasetExporter } from '../src/main/services/sample/sample-dataset-export'
import { SampleRepository } from '../src/main/services/database/sample-repository'
import { AlarmRepository, RecordingRepository } from '../src/main/services/database/alarm-repository'
import { SampleLabelRepository } from '../src/main/services/database/sample-label-repository'
import { SampleLabelService } from '../src/main/services/sample/sample-label-service'
import { SampleLibraryService } from '../src/main/services/sample/sample-library-service'
import { openDatabase } from '../src/main/services/database/schema'
import { SAMPLE_FEATURE_METRICS, humanLabel } from '../src/shared/domain/sample-library'
import { AlarmType } from '../src/shared/domain/models'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-export-'))
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

/** 音频文件的"存储目录"：导出器通过 `resolveAudioPath` 回调拿绝对路径。 */
function audioRoot(name: string): string {
  const root = path.join(tempRoot, name)
  fs.mkdirSync(root, { recursive: true })
  return root
}

interface Harness {
  db: InstanceType<typeof Database>
  repo: SampleRepository
  exporter: SampleDatasetExporter
  root: string
  library: SampleLibraryService
}

function harness(name: string): Harness {
  const db = freshDb()
  const repo = new SampleRepository(db)
  const root = audioRoot(name)
  const exporter = new SampleDatasetExporter({
    samples: repo,
    resolveAudioPath: (relativePath) => path.join(root, ...relativePath.split('/')),
    describeDevice: (deviceId) => (deviceId === 'dev-1' ? { name: 'AE08', kind: 'acousticBox' } : {}),
    appVersion: '1.0.0-test'
  })
  const library = new SampleLibraryService({
    samples: repo,
    alarms: new AlarmRepository(db),
    // 用**真的**录音仓库 + 真的一行 recordings：假对象只能证明调用顺序，
    // 而这条路真正会出问题的地方是"录音行的字段映射错了"（手动录像没有特征值）。
    recordings: new RecordingRepository(db),
    // 标签库也用真的：打标签时的"或新建"要走它，用假的就测不到那一条。
    labels: new SampleLabelService({ labels: new SampleLabelRepository(db), samples: repo })
  })
  return { db, repo, exporter, root, library }
}

const FULL_METRICS = { spl: 62.5, mainFrequency: 93, smoothness: 4.88, bandEnergyRatio: 0.5 }

describe('数据集导出：清单形状', () => {
  it('JSONL 一行一条，缺失的特征**键不出现**（不是 0）', async () => {
    const { db, repo, exporter } = harness('shape')
    try {
      repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        source: 'alarm',
        capturedAt: 1000,
        metrics: FULL_METRICS,
        faultLabel: humanLabel('电晕放电')
      })
      // 只报了两维：另外两维**没有测到**。
      repo.insert({
        deviceId: 'dev-1',
        channelId: 1,
        source: 'manual',
        capturedAt: 2000,
        metrics: { spl: 40, mainFrequency: 50 }
      })

      const out = path.join(tempRoot, 'shape-out')
      const result = await exporter.export({ directory: out })
      assert.equal(result.samples, 2)
      assert.equal(result.labelled, 1)

      const lines = fs
        .readFileSync(result.jsonlPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      assert.equal(lines.length, 2)

      const full = lines.find((row) => row.captured_at === 1000)
      const partial = lines.find((row) => row.captured_at === 2000)
      assert.ok(full)
      assert.ok(partial)

      assert.equal(full.spl, 62.5)
      assert.equal(full.fault_label, '电晕放电')
      assert.equal(full.fault_label_source, 'human')
      assert.equal(full.trainable, true)
      assert.equal(full.channel_index, 0)
      assert.equal(full.device_name, 'AE08')
      assert.equal(full.device_kind, 'acousticBox')

      // 关键：缺失的维度是 `null`，**不是 0**；而且每一行的键集合完全相同。
      assert.equal(partial.smoothness, null)
      assert.equal(partial.bandEnergyRatio, null)
      assert.deepEqual(Object.keys(partial).sort(), Object.keys(full).sort())
      assert.equal(partial.spl, 40)
      // 没标就没标，不是空串。
      assert.equal(partial.fault_label, null)
      assert.equal(partial.trainable, false)
      assert.equal(partial.blocked_reason, 'no-label')
    } finally {
      db.close()
    }
  })

  it('dataset-info.json 写出维度顺序与可训练口径', async () => {
    const { db, repo, exporter } = harness('info')
    try {
      repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        source: 'alarm',
        capturedAt: 1000,
        metrics: FULL_METRICS,
        faultLabel: humanLabel('a')
      })
      const result = await exporter.export({ directory: path.join(tempRoot, 'info-out') })
      const info = JSON.parse(fs.readFileSync(result.infoPath, 'utf8')) as Record<string, unknown>

      assert.deepEqual(info.feature_order, [...SAMPLE_FEATURE_METRICS])
      assert.equal(info.samples, 1)
      assert.equal(info.app_version, '1.0.0-test')
      assert.deepEqual(info.fault_label_counts, { a: 1 })
      assert.equal(info.skipped_unlabelled, 0)
      // 音频没复制时文件字段要如实说没有。
      assert.deepEqual(info.files, { jsonl: 'samples.jsonl', csv: 'samples.csv', audio: null })
    } finally {
      db.close()
    }
  })
})

describe('数据集导出：CSV', () => {
  it('带 BOM，表头顺序固定，中文逗号与引号被正确转义', async () => {
    const { db, repo, exporter } = harness('csv')
    try {
      repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        source: 'alarm',
        capturedAt: 1000,
        metrics: FULL_METRICS,
        faultLabel: humanLabel('轴承, "内外圈"')
      })
      repo.insert({
        deviceId: 'dev-1',
        channelId: 1,
        source: 'manual',
        capturedAt: 2000,
        metrics: { spl: 40 }
      })

      const result = await exporter.export({ directory: path.join(tempRoot, 'csv-out') })
      const raw = fs.readFileSync(result.csvPath, 'utf8')

      // BOM：Excel 靠它认出 UTF-8。
      assert.equal(raw.charCodeAt(0), 0xfeff)

      const lines = raw.replace(/^\ufeff/, '').split('\r\n').filter((line) => line !== '')
      assert.equal(lines.length, 3)
      // 固定列写死（它们是这一层的契约），特征列跟着域层的顺序（改顺序要在这里显形）。
      assert.equal(
        lines[0],
        [
          'id',
          'captured_at',
          'captured_at_iso',
          'device_id',
          'device_name',
          'device_kind',
          'channel_index',
          'source',
          // 两个维度**各自一对列**（业主 2026-09-16 追加）。
          'equipment_label',
          'equipment_label_source',
          'fault_label',
          'fault_label_source',
          'trainable',
          'blocked_reason',
          'duration_ms',
          'sample_rate',
          'audio_relative_path',
          'audio_file',
          'audio_missing',
          'sha256',
          ...SAMPLE_FEATURE_METRICS
        ].join(',')
      )

      // 带逗号与引号的标签必须整体被引起来、内部引号翻倍。
      assert.ok(lines[1]?.includes('"轴承, ""内外圈"""'), lines[1])

      // 缺维度在 CSV 里是**空**而不是 0：spl=40，其余 6 维全空。
      assert.ok(lines[2]?.endsWith(',40,,,,,,'), lines[2])
    } finally {
      db.close()
    }
  })
})

describe('数据集导出：音频', () => {
  it('默认不复制；勾了 copyAudio 才复制，并把缺失的文件数报出来', async () => {
    const { db, repo, exporter, root } = harness('audio')
    try {
      // 两个有音频文件、一个只有路径（文件不在）。
      fs.mkdirSync(path.join(root, 'clips'), { recursive: true })
      fs.writeFileSync(path.join(root, 'clips', 'a.wav'), Buffer.alloc(64, 7))
      fs.writeFileSync(path.join(root, 'clips', 'b.wav'), Buffer.alloc(32, 7))

      for (const [index, relativePath] of ['clips/a.wav', 'clips/b.wav', 'clips/gone.wav'].entries()) {
        repo.insert({
          deviceId: 'dev-1',
          channelId: index,
          source: 'manual',
          capturedAt: 1000 + index,
          metrics: {},
          relativePath
        })
      }

      const plain = await exporter.export({ directory: path.join(tempRoot, 'audio-plain') })
      assert.equal(plain.audioCopied, 0)
      assert.equal(plain.audioBytes, 0)
      /**
       * 没勾复制时**照样**探测文件在不在：`audio_missing` 标记说明的是"这条样本的音频
       * 已经不在存储目录里了"，这件事与"这次要不要把音频拷走"无关 —— 收下清单的人
       * 需要知道哪几条是空壳。
       */
      assert.equal(plain.audioMissing, 1)
      assert.equal(fs.existsSync(path.join(plain.directory, 'audio')), false)

      const copied = await exporter.export({
        directory: path.join(tempRoot, 'audio-copied'),
        copyAudio: true
      })
      assert.equal(copied.audioCopied, 2)
      assert.equal(copied.audioMissing, 1)
      assert.equal(copied.audioBytes, 96)

      const rows = fs
        .readFileSync(copied.jsonlPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      const gone = rows.find((row) => row.audio_relative_path === 'clips/gone.wav')
      assert.ok(gone)
      assert.equal(gone.audio_missing, true)
      assert.equal(gone.audio_file, null)

      const copiedRow = rows.find((row) => row.audio_relative_path === 'clips/a.wav')
      assert.ok(copiedRow)
      assert.equal(typeof copiedRow.audio_file, 'string')
      const fileName = String(copiedRow.audio_file)
      assert.ok(fs.existsSync(path.join(copied.directory, ...fileName.split('/'))), fileName)
    } finally {
      db.close()
    }
  })
})

describe('数据集导出：只导出已标注', () => {
  it('跳过未标注并如实报出跳过的条数', async () => {
    const { db, repo, exporter } = harness('labelled')
    try {
      repo.insert({
        deviceId: 'dev-1',
        channelId: 0,
        source: 'alarm',
        capturedAt: 1000,
        metrics: FULL_METRICS,
        faultLabel: humanLabel('a')
      })
      repo.insert({
        deviceId: 'dev-1',
        channelId: 1,
        source: 'alarm',
        capturedAt: 2000,
        metrics: FULL_METRICS
      })

      const result = await exporter.export({
        directory: path.join(tempRoot, 'labelled-out'),
        onlyLabelled: true
      })
      assert.equal(result.samples, 1)
      assert.equal(result.skippedUnlabelled, 1)

      const info = JSON.parse(fs.readFileSync(result.infoPath, 'utf8')) as Record<string, unknown>
      assert.equal(info.skipped_unlabelled, 1)
    } finally {
      db.close()
    }
  })

  it('拒绝写到磁盘根目录（一次误点会往整块盘根上撒文件）', async () => {
    const { db, exporter } = harness('root')
    try {
      await assert.rejects(
        () => exporter.export({ directory: path.parse(tempRoot).root }),
        /根目录/
      )
    } finally {
      db.close()
    }
  })
})

describe('录音入库', () => {
  it('手动录音：如实报出 0 维特征，且**不预设标签**', () => {
    const { db, library, repo } = harness('recording-manual')
    try {
      const recordings = new RecordingRepository(db)
      const row = recordings.insert({
        deviceId: 'dev-1',
        channelId: 0,
        recordingType: 'manual',
        startTime: 5000,
        sampleRate: 96000,
        audioFormat: 'wav',
        relativePath: 'clips/manual.wav',
        durationMs: 3000
      })

      const outcome = library.addFromRecording(row.id)
      assert.ok(outcome)
      assert.equal(outcome.created, true)
      // 录音表不存特征值：这一条进库之后"有音频、没特征"，界面必须照实说。
      assert.equal(outcome.metricsStored, 0)
      // 录音本身没有类别信息，预设一个等于替操作员发明了一个类别。
      assert.equal(outcome.label, undefined)

      const sample = repo.findById(outcome.id)
      assert.ok(sample)
      assert.equal(sample.faultLabel, undefined)
      assert.equal(sample.source, 'manual')
      assert.equal(sample.relativePath, 'clips/manual.wav')
      assert.deepEqual(sample.metrics, {})
    } finally {
      db.close()
    }
  })

  it('告警录音的来源记成 alarm（这个字段回答的是"素材怎么来的"）', () => {
    const { db, library, repo } = harness('recording-alarm')
    try {
      const recordings = new RecordingRepository(db)
      const row = recordings.insert({
        deviceId: 'dev-1',
        channelId: 0,
        recordingType: 'alarm',
        startTime: 6000,
        sampleRate: 96000,
        audioFormat: 'wav',
        relativePath: 'clips/alarm.wav'
      })
      const outcome = library.addFromRecording(row.id)
      assert.ok(outcome)
      const sample = repo.findById(outcome.id)
      assert.equal(sample?.source, 'alarm')
    } finally {
      db.close()
    }
  })

  it('录音不存在时返回 undefined（界面据此报错，而不是写一条空样本）', () => {
    const { db, library } = harness('recording-missing')
    try {
      assert.equal(library.addFromRecording('nope'), undefined)
    } finally {
      db.close()
    }
  })
})

describe('批量入库', () => {
  it('分开统计新增 / 已在库 / 失败，并去重', () => {
    const { db, library } = harness('bulk')
    try {
      const alarms = new AlarmRepository(db)
      const first = alarms.insert({
        deviceId: 'dev-1',
        channelId: 0,
        timestamp: 1000,
        alarmMask: 1 << AlarmType.CoronaDischarge,
        spl: 62.5,
        mainFrequency: 93,
        smoothness: 4.88,
        bandEnergyRatio: 0.5
      })
      const second = alarms.insert({
        deviceId: 'dev-1',
        channelId: 1,
        timestamp: 2000,
        alarmMask: 1 << AlarmType.SPL
      })

      const outcome = library.addFromAlarms([
        first.id,
        second.id,
        first.id,
        'does-not-exist'
      ])

      // 去重之后是 3 条请求：两条真实 + 一条不存在的。
      assert.equal(outcome.requested, 3)
      assert.equal(outcome.created, 2)
      assert.equal(outcome.existing, 0)
      assert.equal(outcome.failed, 1)
      // 只有第一条告警带齐了四维。
      assert.equal(outcome.withMetrics, 1)
      assert.equal(outcome.metricsStored, 4)
      // 两条都从位图拿到了弱标签。
      assert.equal(outcome.labelled, 2)

      // 再点一次：全部命中幂等。
      const again = library.addFromAlarms([first.id, second.id])
      assert.equal(again.created, 0)
      assert.equal(again.existing, 2)
      assert.equal(again.failed, 0)
    } finally {
      db.close()
    }
  })

  it('空数组是合法请求（返回一排 0），不是错误', () => {
    const { db, library } = harness('bulk-empty')
    try {
      const outcome = library.addFromAlarms([])
      assert.deepEqual(outcome, {
        requested: 0,
        created: 0,
        existing: 0,
        failed: 0,
        withMetrics: 0,
        metricsStored: 0,
        labelled: 0
      })
    } finally {
      db.close()
    }
  })
})
