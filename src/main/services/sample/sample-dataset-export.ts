/**
 * 样本库 → **外部**训练数据集（业主 2026-09-16：「供二次训练」）。
 *
 * ---------------------------------------------------------------------------
 * 为什么导出的是"清单 + 可选音频"而不是一个压缩包
 * ---------------------------------------------------------------------------
 * `samples` 表里存的是**相对路径**（`relativePath`），音频本体在存储目录里。导出有两种
 * 现实用法，它们要的东西不一样：
 *
 *   - 训练就在这台机器上跑 → 要的是清单，音频按原路径读就行（复制一份纯属浪费几个 G）；
 *   - 要把数据集交给别人/别的机器 → 音频必须一起走。
 *
 * 所以 `copyAudio` 是**调用方的选择**，默认不复制。默认复制会让"我只想导个清单"
 * 变成一次磁盘写满，而默认不复制只会让第二种用法多勾一个框。
 *
 * ---------------------------------------------------------------------------
 * 清单里必须有的、容易被漏掉的东西
 * ---------------------------------------------------------------------------
 *   - **维度顺序**（`feature_order`）：7 维特征交出去时不带顺序，接收方只能猜。
 *     猜错顺序训练出来的模型不会报错，只会不准 —— 这种错最难查。
 *   - **标签来源**：`device` 是设备位图给的弱标签、`ai` 是候选、只有 `human` 是真值。
 *     混在一起当成同一种标签去训练，等于把设备的判断和人的判断当成了一个口径。
 *   - **缺失保持缺失**：没测到的维度在 JSONL 里是 `null`（**不是 `0`**）、在 CSV 里是空格。
 *     补 0 会凭空造出一批"主频 0 Hz"的样本。JSONL 刻意**每一行键都一样**（缺的写 `null`）
 *     而不是省掉那个键：列不一致时，读进来的表会按行给出不同的字段集合，
 *     而"这一行没有这一列"和"这一列是空的"在下游是两种不同的处理。
 *   - **`trainable` 与它的原因**：让接收方能复现我们界面上那句"这条不能进训练集"。
 *
 * 音频缺失（清单里有路径、文件没了）**如实计数**（`audioMissing`），并在该行标
 * `audio_missing: true`：静默跳过会让一个缺了一半音频的数据集看起来是完整的。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Sample, SampleRepository } from '../database/sample-repository'
import { SAMPLE_FEATURE_METRICS, isTrainable } from '@shared/domain/sample-library'
import type { SampleExportRequest, SampleExportResult } from '@shared/ipc/contract'

export interface SampleDatasetExporterOptions {
  samples: SampleRepository
  /** 相对路径 → 绝对路径（`StorageService.resolve`）。 */
  resolveAudioPath: (relativePath: string) => string
  /** 设备 id → 可读名字 + 类型；设备可能已被删掉，所以两者都可缺席。 */
  describeDevice: (deviceId: string) => { name?: string; kind?: string }
  /** 写进 `dataset-info.json` 的版本号（溯源用）。 */
  appVersion: string
}

/** 清单里的固定列（顺序即 `samples.csv` 的表头）。 */
const CSV_COLUMNS = [
  'id',
  'captured_at',
  'captured_at_iso',
  'device_id',
  'device_name',
  'device_kind',
  'channel_index',
  'source',
  // 两个维度**各自一对列**（业主 2026-09-16 追加）：设备类型 + 故障类型。
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
] as const

export class SampleDatasetExporter {
  private readonly samples: SampleRepository
  private readonly resolveAudioPath: (relativePath: string) => string
  private readonly describeDevice: (deviceId: string) => { name?: string; kind?: string }
  private readonly appVersion: string

  constructor(options: SampleDatasetExporterOptions) {
    this.samples = options.samples
    this.resolveAudioPath = options.resolveAudioPath
    this.describeDevice = options.describeDevice
    this.appVersion = options.appVersion
  }

  /**
   * 写数据集。
   *
   * 一次至多导 `MAX_EXPORT_ITEMS` 条：清单是一次性写进内存再落盘的，而一个几十万条的库
   * 会把内存顶穿。超了**抛错**而不是悄悄导出前 N 条 —— 半份数据集比一份都没有更危险。
   */
  async export(request: SampleExportRequest): Promise<SampleExportResult> {
    const directory = path.resolve(request.directory)
    if (directory === '' || directory === path.parse(directory).root) {
      throw new Error('导出目录不能是磁盘根目录')
    }

    const { items, truncated } = this.samples.trainingRows(MAX_EXPORT_ITEMS)
    if (truncated) {
      throw new Error(
        `样本库超过 ${MAX_EXPORT_ITEMS} 条，无法一次导出。请先在样本库里筛选或分批整理。`
      )
    }

    const onlyLabelled = request.onlyLabelled === true
    const selected: Sample[] = []
    let skippedUnlabelled = 0
    for (const sample of items) {
      // "已标注"指的是**故障类型**那一维：设备类型是元数据，只有它而没有故障类型的样本
      // 仍然进不了监督训练，把它算作"已标注"会让导出的数据集与"能训练"的口径对不上。
      if (onlyLabelled && sample.faultLabel === undefined) {
        skippedUnlabelled += 1
        continue
      }
      selected.push(sample)
    }

    await fs.mkdir(directory, { recursive: true })
    const audioDirectory = path.join(directory, 'audio')
    if (request.copyAudio === true) await fs.mkdir(audioDirectory, { recursive: true })

    let audioCopied = 0
    let audioMissing = 0
    let audioBytes = 0
    const jsonlLines: string[] = []
    const csvRows: string[] = [CSV_COLUMNS.join(',')]

    for (const sample of selected) {
      const record = this.describe(sample)
      let audioFile: string | null = null

      if (sample.relativePath !== undefined && sample.relativePath !== '') {
        const source = this.resolveAudioPath(sample.relativePath)
        let exists = true
        try {
          await fs.access(source)
        } catch {
          exists = false
        }
        if (!exists) {
          audioMissing += 1
          record.audio_missing = true
        } else if (request.copyAudio === true) {
          const target = path.join(audioDirectory, `${sample.id}${path.extname(source)}`)
          await fs.copyFile(source, target)
          audioCopied += 1
          audioFile = `audio/${path.basename(target)}`
          record.audio_file = audioFile
          try {
            audioBytes += (await fs.stat(target)).size
          } catch {
            // 复制成功但 stat 失败：字节数少算一个文件，不影响清单与音频本身。
          }
        }
      }

      jsonlLines.push(JSON.stringify(record))
      csvRows.push(this.toCsvRow(sample, record, audioFile))
    }

    const jsonlPath = path.join(directory, JSONL_FILE)
    const csvPath = path.join(directory, CSV_FILE)
    const infoPath = path.join(directory, INFO_FILE)

    await fs.writeFile(jsonlPath, jsonlLines.map((line) => `${line}\n`).join(''), 'utf8')
    // CSV 带 BOM：不带的话 Excel 会把中文表头与中文标签读成乱码，而这一列恰恰是人要看的。
    await fs.writeFile(csvPath, `\ufeff${csvRows.map((row) => `${row}\r\n`).join('')}`, 'utf8')
    await fs.writeFile(
      infoPath,
      `${JSON.stringify(this.buildInfo(selected, skippedUnlabelled, request), null, 2)}\n`,
      'utf8'
    )

    return {
      directory,
      jsonlPath,
      csvPath,
      infoPath,
      samples: selected.length,
      labelled: selected.filter((sample) => sample.faultLabel !== undefined).length,
      skippedUnlabelled,
      audioCopied,
      audioMissing,
      audioBytes
    }
  }

  /** 一行样本 → 清单对象。字段名 snake_case：CSV 与 JSONL 用同一套名字，少一层翻译。 */
  private describe(sample: Sample): Record<string, unknown> {
    const device = this.describeDevice(sample.deviceId)
    const verdict = isTrainable({ label: sample.faultLabel, metrics: sample.metrics })
    const record: Record<string, unknown> = {
      id: sample.id,
      captured_at: sample.capturedAt,
      captured_at_iso: new Date(sample.capturedAt).toISOString(),
      device_id: sample.deviceId,
      device_name: device.name ?? null,
      device_kind: device.kind ?? null,
      channel_index: sample.channelId,
      source: sample.source,
      // 两个维度都进清单：只有故障类型时，接收方无法回答"这个类别跨了几种设备"。
      equipment_label: sample.equipmentLabel?.text ?? null,
      equipment_label_source: sample.equipmentLabel?.source ?? null,
      fault_label: sample.faultLabel?.text ?? null,
      fault_label_source: sample.faultLabel?.source ?? null,
      trainable: verdict.usable,
      blocked_reason: verdict.usable ? null : (verdict.reason ?? null),
      duration_ms: sample.durationMs ?? null,
      sample_rate: sample.sampleRate ?? null,
      audio_relative_path: sample.relativePath ?? null,
      audio_file: null,
      audio_missing: false,
      sha256: sample.sha256 ?? null
    }
    // 缺失保持缺失：没测到的维度写 `null`（不是 0），且**每一行的键都一样**。
    for (const metric of SAMPLE_FEATURE_METRICS) {
      const value = sample.metrics[metric]
      record[metric] = typeof value === 'number' && Number.isFinite(value) ? value : null
    }
    return record
  }

  private toCsvRow(
    sample: Sample,
    record: Record<string, unknown>,
    audioFile: string | null
  ): string {
    const cells = CSV_COLUMNS.map((column) => {
      if (SAMPLE_FEATURE_METRICS.includes(column as (typeof SAMPLE_FEATURE_METRICS)[number])) {
        const value = sample.metrics[column as (typeof SAMPLE_FEATURE_METRICS)[number]]
        // 空格 = 没测到；写 0 会被当成一次真实测量。
        return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
      }
      if (column === 'audio_file') return audioFile ?? ''
      const value = record[column]
      if (value === null || value === undefined) return ''
      if (typeof value === 'boolean') return value ? 'true' : 'false'
      return csvCell(String(value))
    })
    return cells.join(',')
  }

  private buildInfo(
    selected: Sample[],
    skippedUnlabelled: number,
    request: SampleExportRequest
  ): Record<string, unknown> {
    const faultCounts: Record<string, number> = {}
    const equipmentCounts: Record<string, number> = {}
    const faultSourceCounts: Record<string, number> = { unlabelled: 0 }
    const equipmentSourceCounts: Record<string, number> = { unlabelled: 0 }

    for (const sample of selected) {
      const fault = sample.faultLabel
      const equipment = sample.equipmentLabel
      if (fault === undefined) faultSourceCounts.unlabelled = (faultSourceCounts.unlabelled ?? 0) + 1
      else {
        faultCounts[fault.text] = (faultCounts[fault.text] ?? 0) + 1
        faultSourceCounts[fault.source] = (faultSourceCounts[fault.source] ?? 0) + 1
      }
      if (equipment === undefined) {
        equipmentSourceCounts.unlabelled = (equipmentSourceCounts.unlabelled ?? 0) + 1
      } else {
        equipmentCounts[equipment.text] = (equipmentCounts[equipment.text] ?? 0) + 1
        equipmentSourceCounts[equipment.source] = (equipmentSourceCounts[equipment.source] ?? 0) + 1
      }
    }

    return {
      exported_at: Date.now(),
      exported_at_iso: new Date().toISOString(),
      app_version: this.appVersion,
      app: 'HERTZINNO Acoustic Box Manager',
      files: { jsonl: JSONL_FILE, csv: CSV_FILE, audio: request.copyAudio === true ? 'audio/' : null },
      samples: selected.length,
      skipped_unlabelled: skippedUnlabelled,
      /**
       * 两个维度**分开**统计。合成一个"标签分布"会让接收方以为这是一个单标签数据集，
       * 而它的每条样本其实带着（设备类型，故障类型）这一对。
       */
      fault_label_counts: faultCounts,
      equipment_label_counts: equipmentCounts,
      fault_label_source_counts: faultSourceCounts,
      equipment_label_source_counts: equipmentSourceCounts,
      /**
       * 特征维度顺序。FA8 `/features_stream` 推的就是这 7 维，`spl` 等名字来自设备协议；
       * 这里给出顺序是为了让接收方**不必猜**。数值的含义与量纲以设备文档为准 ——
       * 我们没有它的特征提取实现，也没有在这里替它定义一遍。
       */
      feature_order: [...SAMPLE_FEATURE_METRICS],
      /**
       * 训练集的准入口径，原样写出来让接收方能复现："只有人工故障类型 + 必报维度齐全
       * 的样本才算真值"。设备弱标签与 AI 候选**不**默认进训练集；设备类型是**元数据**，
       * 不参与准入判断（但它决定一个故障类别是不是混了几种设备）。
       */
      trainable_rule:
        'fault_label_source == "human" && all required metrics present (equipment_label is metadata, not required)',
      notes: [
        '指标为设备上报的原始值，未做任何归一化；缺失维度在 JSONL 中为 null、在 CSV 中为空。',
        'channel_index 从 0 开始，与设备协议一致。',
        '每条样本带两个维度的标签：equipment_label（设备类型）与 fault_label（故障类型），两者各自记录来源。',
        request.copyAudio === true
          ? '音频已复制到 audio/ 目录，文件名为 <样本 id>.<扩展名>。'
          : '未复制音频：JSONL/CSV 里的 audio_relative_path 是库内相对路径，需配合存储目录使用。'
      ]
    }
  }
}

const JSONL_FILE = 'samples.jsonl'
const CSV_FILE = 'samples.csv'
const INFO_FILE = 'dataset-info.json'

/** 一次导出的硬上限（见 `export()` 的注释：超了报错，不静默截断）。 */
const MAX_EXPORT_ITEMS = 20000

/**
 * CSV 单元格转义。
 *
 * 逗号、引号、换行都要处理 —— 而中文标签里逗号是**常见**的（"时域能量比超限，轴承"）。
 * 不转义的话，一个标签就能把整张表错位，而这种错在表格软件里看起来只是"少了一列"。
 */
function csvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}
