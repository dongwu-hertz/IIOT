/**
 * 本地异常声纹样本库的服务层（schema v7）。
 *
 * ---------------------------------------------------------------------------
 * 这一层是"样本从哪来"的唯一入口
 * ---------------------------------------------------------------------------
 * 样本有两个现实来源，它们各自知道的东西完全不同：
 *
 *   - **告警**（`alarms` 行）：带 `spl`/`main_frequency`/`smoothness`/`band_energy_ratio`
 *     四个特征，还带**位图**（`alarm_mask`）—— 所以它能同时给出特征与一个**弱标签**；
 *   - **录音**（`recordings` 行）：只有时间、通道、时长、采样率，**一个特征值都没有**。
 *
 * 于是 `addFromAlarm()` 与 `addFromRecording()` 的产出不一样，而这个差别**必须如实传出去**
 * （`SampleAddOutcome.metricsStored`）：手动录音加进库是"先把素材收进来"，它暂时训不了，
 * 界面要说"已入库，但没有特征值，暂时不能参与训练"，而不是让人以为它已经能用了。
 *
 * ---------------------------------------------------------------------------
 * 为什么特征不在这里"从音频里算"
 * ---------------------------------------------------------------------------
 * 从 wav 算 7 维特征需要按设备的口径复刻它的特征提取（分帧、加权、频带划分、HPSS…）。
 * 我们自己算一套**注定与设备不一致**的数，然后把它和设备的数混在同一个数据集里训练 ——
 * 那是把两种不同定义的特征当成同一种。所以这一层只搬运**设备给过的**数；手动录音的特征
 * 要么来自趋势库（设备当时推的），要么就是"没有"。这件事写在这里，免得下一轮有人"顺手"补上。
 */

import type { AlarmRepository, RecordingRepository } from '../database/alarm-repository'
import type { SampleRepository, Sample, SampleQuery as RepositorySampleQuery } from '../database/sample-repository'
import {
  type SampleLabel,
  type SampleLabelDimension,
  type SampleLabelSource,
  type SampleMetrics,
  featureVector,
  isTrainable,
  normaliseSampleLabel,
  weakLabelFromAlarmTypes
} from '@shared/domain/sample-library'
import { evaluateLeaveOneOut, type LabeledVector } from '@shared/domain/sample-classifier'
import type { SampleLabelService } from './sample-label-service'
import type {
  SampleAddOutcome,
  SampleBulkAddOutcome,
  SamplePage,
  SampleQuery,
  SampleStats,
  SampleTrainingReport,
  SampleView
} from '@shared/ipc/contract'
import type { TrendMetric } from '@shared/domain/trend'

export interface SampleLibraryServiceOptions {
  samples: SampleRepository
  alarms: AlarmRepository
  recordings: RecordingRepository
  /**
   * 标签库（两个维度的词表）。**必填**：打标签时"或新建"那一半要靠它，
   * 而一个可选依赖会让"忘了接"表现为"新建的类型没进库"这种很难查的现象。
   */
  labels: SampleLabelService
}

/** 训练集一次最多取多少条（不静默截断：超了会在报告里说 `truncated`）。 */
const TRAINING_MAX_ITEMS = 5000

export class SampleLibraryService {
  private readonly samples: SampleRepository
  private readonly alarms: AlarmRepository
  private readonly recordings: RecordingRepository
  private readonly labelLibrary: SampleLabelService

  constructor(options: SampleLibraryServiceOptions) {
    this.samples = options.samples
    this.alarms = options.alarms
    this.recordings = options.recordings
    this.labelLibrary = options.labels
  }

  /** 仓库行 → IPC 形状：把域层的 `SampleLabel` 拆成两个字段，并附上"能不能训练"。 */
  private toView(sample: Sample): SampleView {
    const view: SampleView = {
      id: sample.id,
      deviceId: sample.deviceId,
      channelId: sample.channelId,
      source: sample.source,
      capturedAt: sample.capturedAt,
      metrics: compactMetrics(sample.metrics),
      createdAt: sample.createdAt,
      trainable: isTrainable({ label: sample.faultLabel, metrics: sample.metrics })
    }
    if (sample.recordingId !== undefined) view.recordingId = sample.recordingId
    if (sample.durationMs !== undefined) view.durationMs = sample.durationMs
    if (sample.sampleRate !== undefined) view.sampleRate = sample.sampleRate
    if (sample.relativePath !== undefined) view.relativePath = sample.relativePath
    if (sample.faultLabel !== undefined) {
      view.faultLabel = sample.faultLabel.text
      view.faultLabelSource = sample.faultLabel.source
    }
    if (sample.equipmentLabel !== undefined) {
      view.equipmentLabel = sample.equipmentLabel.text
      view.equipmentLabelSource = sample.equipmentLabel.source
    }
    return view
  }

  query(query: SampleQuery = {}): SamplePage {
    const limit = clampLimit(query.limit, 200, 2000)
    const offset = Math.max(0, query.offset ?? 0)
    const repositoryQuery: RepositorySampleQuery = { limit, offset }
    if (query.deviceId !== undefined) repositoryQuery.deviceId = query.deviceId
    if (query.channelId !== undefined) repositoryQuery.channelId = query.channelId
    if (query.faultLabel !== undefined) repositoryQuery.faultLabel = query.faultLabel
    if (query.faultLabelSource !== undefined) {
      repositoryQuery.faultLabelSource = query.faultLabelSource
    }
    if (query.equipmentLabel !== undefined) repositoryQuery.equipmentLabel = query.equipmentLabel
    if (query.equipmentLabelSource !== undefined) {
      repositoryQuery.equipmentLabelSource = query.equipmentLabelSource
    }
    if (query.source !== undefined) repositoryQuery.source = query.source
    if (query.from !== undefined) repositoryQuery.from = query.from
    if (query.to !== undefined) repositoryQuery.to = query.to

    const page = this.samples.query(repositoryQuery)
    return { items: page.items.map((sample) => this.toView(sample)), total: page.total, limit, offset }
  }

  /**
   * 统计。
   *
   * `trainable` 是**单独数出来的**，不是"总数减掉两个排除数"：那两个数来自两个不同的判断
   * （标签来源、必报维度齐不齐），而"能不能训练"是它们的**合取**。用减法算等于假设二者互斥，
   * 一条既没标签又缺维度的样本会被减两次 —— 那个数字会悄悄偏大。
   */
  stats(): SampleStats {
    const { items, truncated } = this.samples.trainingRows(TRAINING_MAX_ITEMS)
    let trainable = 0
    for (const sample of items) {
      if (isTrainable({ label: sample.faultLabel, metrics: sample.metrics }).usable) trainable += 1
    }
    return {
      total: this.samples.count(),
      byFaultLabel: this.samples.countByLabel('fault'),
      byEquipmentLabel: this.samples.countByLabel('equipment'),
      faultSource: this.samples.countByLabelSource('fault'),
      equipmentSource: this.samples.countByLabelSource('equipment'),
      /**
       * 被上限截断时这个数只覆盖前 N 条，所以它**偏小**。
       *
       * 选择报 0 而不是报一个偏小的数：报 0 是"这个数此刻不可信"，界面可以照实说；
       * 报一个偏小的数看起来完全正常，而用户会拿它当准确数字用。截断本身由 `train()`
       * 的 `truncated` 说明。
       */
      trainable: truncated ? 0 : trainable
    }
  }

  /**
   * 把一条**告警**加进样本库。
   *
   * 特征来自告警行自己（设备在告警时刻报的四个值），标签是**弱标签**（位图的主位）。
   * 告警没有关联录音时也能入库：那时它是一个"只有特征、没有音频"的样本 —— 能不能训练
   * 由 `isTrainable()` 说了算（特征齐就能），而界面要能看出它没有音频可播。
   */
  addFromAlarm(alarmId: string): SampleAddOutcome | undefined {
    const alarm = this.alarms.findById(alarmId)
    if (!alarm) return undefined

    const metrics: SampleMetrics = {}
    if (alarm.spl !== undefined) metrics.spl = alarm.spl
    if (alarm.mainFrequency !== undefined) metrics.mainFrequency = alarm.mainFrequency
    if (alarm.smoothness !== undefined) metrics.smoothness = alarm.smoothness
    if (alarm.bandEnergyRatio !== undefined) metrics.bandEnergyRatio = alarm.bandEnergyRatio

    // 位图直接用 `alarmTypes`（仓库已在读的时候解过一次），这里不再解第二遍。
    // 位图描述的是**故障**，所以它落在 `fault` 那一维；设备类型设备从来不说，留空。
    const label = weakLabelFromAlarmTypes(alarm.alarmTypes)
    const insert: Parameters<SampleRepository['insert']>[0] = {
      deviceId: alarm.deviceId,
      channelId: alarm.channelId,
      source: 'alarm',
      capturedAt: alarm.timestamp,
      metrics,
      ...(label !== undefined ? { faultLabel: label } : {})
    }
    if (alarm.localRecordingId !== undefined) insert.recordingId = alarm.localRecordingId

    const result = this.samples.insert(insert)
    return {
      id: result.id,
      created: result.created,
      metricsStored: Object.keys(metrics).length,
      ...(label !== undefined ? { label: label.text, labelSource: label.source } : {})
    }
  }

  /**
   * 批量入库（操作员在告警中心勾一批）。
   *
   * 先**去重**再逐条走 `addFromAlarm()`：同一个 id 传两次时，第二次会命中幂等查询
   * 而返回 `created: false`，那是一条"本来就在库"的记录，把它算进 `existing` 会虚报
   * 一批"重复的告警"，而实际只是调用方把同一个 id 传了两遍。
   *
   * 逐条而不是一个事务：一次插入失败（比如标签超长）不该让前面 11 条一起回滚 ——
   * 操作员要的是"能进的先进去，进不去的告诉我是哪条"。`addFromAlarm()` 返回
   * `undefined`（告警不存在）就是这里唯一的失败情形。
   */
  addFromAlarms(alarmIds: string[]): SampleBulkAddOutcome {
    const unique = [...new Set(alarmIds.map((id) => String(id)))]
    let created = 0
    let existing = 0
    let failed = 0
    let withMetrics = 0
    let metricsStored = 0
    let labelled = 0

    for (const id of unique) {
      const outcome = this.addFromAlarm(id)
      if (!outcome) {
        failed += 1
        continue
      }
      if (outcome.created) created += 1
      else existing += 1
      if (outcome.metricsStored > 0) withMetrics += 1
      metricsStored += outcome.metricsStored
      if (outcome.label !== undefined) labelled += 1
    }

    return {
      requested: unique.length,
      created,
      existing,
      failed,
      withMetrics,
      metricsStored,
      labelled
    }
  }

  /**
   * 把一段**录音**加进样本库（手动录音与告警录音都走这条）。
   *
   * 特征**一维都没有**：`recordings` 表不存特征值。所以这里如实返回 `metricsStored: 0`，
   * 库里的这一条也保持"没有特征"（缺失不补 0）—— 它是有价值的素材（音频在、时间在、
   * 可以人工打标签），只是暂时不能参与训练。标签不预设：录音本身没有类别信息，
   * 预设一个等于替操作员发明了一个类别。
   */
  addFromRecording(recordingId: string): SampleAddOutcome | undefined {
    const recording = this.recordings.findById(recordingId)
    if (!recording) return undefined

    const result = this.samples.insert({
      recordingId: recording.id,
      deviceId: recording.deviceId,
      channelId: recording.channelId,
      // 录音类型是告警联动产出的就记成 alarm，其余（手动/计划）记成 manual：
      // 这个字段回答的是"这条素材是怎么来的"，而录像类型恰好就是这个答案。
      source: recording.recordingType === 'alarm' ? 'alarm' : 'manual',
      capturedAt: recording.startTime,
      durationMs: recording.durationMs ?? undefined,
      sampleRate: recording.sampleRate,
      relativePath: recording.relativePath,
      ...(recording.sha256 !== undefined ? { sha256: recording.sha256 } : {}),
      metrics: {}
    })
    return { id: result.id, created: result.created, metricsStored: 0 }
  }

  /**
   * 写某一维的标签或撤销标注。`label` 为 `null` 就是退回未标注。
   *
   * `dimension` 来自 IPC，所以是收窄过的字符串；不认识的维度**抛错**而不是默认写故障类型 ——
   * 一个静默的默认值会让"设备类型没存上"看起来像"存上了但没显示"。
   *
   * 名字会先在标签库里 `ensureLabel()` 一次：那是业主说的"或新建"那一半。库里已有同名的
   * 另一种写法时（`轴承故障 ` vs `轴承故障`），写进样本的是**库里那一份**，否则同一个类别
   * 会因为多打一个空格而分裂成两个。
   */
  setLabel(
    sampleId: string,
    dimension: SampleLabelDimension,
    label: string | null,
    source: SampleLabelSource
  ): boolean {
    if (label === null) return this.samples.setLabel(sampleId, dimension, undefined)
    const normalised = normaliseSampleLabel(label)
    if (normalised === undefined) return this.samples.setLabel(sampleId, dimension, undefined)

    const stored = this.labelLibrary ? this.labelLibrary.ensureLabel(dimension, normalised) : normalised
    const value: SampleLabel = { text: stored, source }
    return this.samples.setLabel(sampleId, dimension, value)
  }

  /**
   * 这一条样本要写进去的两个维度（界面一次编辑两个维度时用）。
   *
   * **只动调用方点名的维度**：`equipment` 没传就是"不改设备类型"，而不是"清掉它" ——
   * 语义上两者差别很大，而默认清掉会让"只想改故障类型"顺手毁掉已有标注。
   */
  setLabels(
    sampleId: string,
    input: { fault?: string | null; equipment?: string | null },
    source: SampleLabelSource
  ): boolean {
    let changed = false
    if (input.fault !== undefined) {
      changed = this.setLabel(sampleId, 'fault', input.fault, source) || changed
    }
    if (input.equipment !== undefined) {
      changed = this.setLabel(sampleId, 'equipment', input.equipment, source) || changed
    }
    return changed
  }

  remove(sampleId: string): boolean {
    return this.samples.delete(sampleId)
  }

  /**
   * 训练 + 留一法评估。
   *
   * **只用人工标签**（`isTrainable()` 的默认口径），并把"被排除掉多少、为什么"一起报回来：
   * 一个只报准确率的界面，会让人以为库里所有的样本都参与了训练。
   */
  train(): SampleTrainingReport {
    const { items, truncated } = this.samples.trainingRows(TRAINING_MAX_ITEMS)
    const rows: LabeledVector[] = []
    let noLabel = 0
    let missingMetrics = 0
    /** 训练集按设备类型分组 —— 一个故障类别跨了多种设备时，那个中心点是几个现象的平均。 */
    const equipmentCounts: Record<string, number> = {}
    let equipmentUnassigned = 0

    for (const sample of items) {
      const verdict = isTrainable({ label: sample.faultLabel, metrics: sample.metrics })
      if (!verdict.usable) {
        if (verdict.reason === 'no-label') noLabel += 1
        else missingMetrics += 1
        continue
      }
      const text = sample.faultLabel?.text
      if (text === undefined) continue
      rows.push({ label: text, vector: featureVector(sample.metrics) })

      const equipment = sample.equipmentLabel?.text
      if (equipment === undefined) equipmentUnassigned += 1
      else equipmentCounts[equipment] = (equipmentCounts[equipment] ?? 0) + 1
    }

    const evaluation = evaluateLeaveOneOut(rows)
    const equipmentKinds = Object.keys(equipmentCounts).length

    return {
      trained: rows.length,
      total: this.samples.count(),
      excluded: { noLabel, missingMetrics },
      accuracy: evaluation.accuracy,
      labels: evaluation.labels,
      counts: evaluation.counts,
      confusion: evaluation.confusion,
      degenerate: evaluation.degenerate,
      unassessable: evaluation.unassessable,
      truncated,
      equipment: {
        counts: equipmentCounts,
        unassigned: equipmentUnassigned,
        // 只标一种设备类型、且没有未标注的，才叫"没混"。
        mixed: equipmentKinds + (equipmentUnassigned > 0 ? 1 : 0) > 1
      }
    }
  }
}

/** 只留真正有值的维度（`Partial` 里不出现 = 没测到，不是 0）。 */
function compactMetrics(metrics: SampleMetrics): Partial<Record<TrendMetric, number>> {
  const compact: Partial<Record<TrendMetric, number>> = {}
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      compact[key as TrendMetric] = value
    }
  }
  return compact
}

/** 与其它仓库同一条夹取规则。 */
function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
}
