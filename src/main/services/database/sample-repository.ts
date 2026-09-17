/**
 * 本地异常声纹样本库的持久化（schema v7 的 `samples` 表）。
 *
 * ---------------------------------------------------------------------------
 * 这一层只做存取与**形状**，判断在 `@shared/domain/sample-library.ts` 里
 * ---------------------------------------------------------------------------
 * 同本仓库一贯的分工：`isTrainable()` / `featureVector()` / 归一化都在纯函数里（有单测），
 * 这里负责把行读出来、写回去，并**在边界上收窄**（数据库是别人可能动过的文件）。
 *
 * ---------------------------------------------------------------------------
 * 两件这一层必须守住的事
 * ---------------------------------------------------------------------------
 * 1. **标签与来源同生同灭**：v7 有一条 `CHECK ((label IS NULL) = (label_source IS NULL))`。
 *    这一层的 `setLabel()` 是唯一改标签的入口，它把两者一起写 —— 所谓的"只改标签、来源忘了改"
 *    在类型上就不可能发生（`SampleLabel` 两者必须都有）。
 * 2. **特征以 JSON 存**：读回来时逐维校验，认不出的维度**丢掉而不是变成 0**。缺失必须保持
 *    缺失，否则一条"没测到主频"的样本会以主频 0 的身份进训练集，那是一个编造出来的测量值。
 */

import type { Database as SqliteDatabase } from 'better-sqlite3'
import {
  SAMPLE_FEATURE_METRICS,
  isSampleLabelSource as isLabelSource,
  isSampleSource,
  type SampleLabel,
  type SampleLabelDimension,
  type SampleLabelSource,
  type SampleMetrics,
  type SampleSource
} from '@shared/domain/sample-library'
import { SAMPLE_LABEL_MAX_LENGTH } from '@shared/domain/sample-library'
import { newSampleId, now } from '@shared/utils/id'

/** 标签超长就拒绝写入：一个变成句子的"标签"会让聚类与统计失去意义（上限是我们定的）。 */
function assertLabelFits(label: SampleLabel | undefined): void {
  if (label === undefined) return
  if (label.text.length > SAMPLE_LABEL_MAX_LENGTH) {
    throw new Error(
      `sample label too long: ${label.text.length} > ${SAMPLE_LABEL_MAX_LENGTH} characters`
    )
  }
}

/** `samples` 表的一行（schema v8：两个标签维度）。 */
interface SampleRow {
  id: string
  recording_id: string | null
  device_id: string
  channel_id: number
  source: string
  captured_at: number
  duration_ms: number | null
  sample_rate: number | null
  relative_path: string | null
  sha256: string | null
  fault_label: string | null
  fault_label_source: string | null
  equipment_label: string | null
  equipment_label_source: string | null
  features: string | null
  created_at: number
}

export interface Sample {
  id: string
  /** 来源录音；`undefined` 表示这是一条导入的样本（音频路径在 `relativePath` 里）。 */
  recordingId?: string
  deviceId: string
  channelId: number
  source: SampleSource
  capturedAt: number
  durationMs?: number
  sampleRate?: number
  relativePath?: string
  sha256?: string
  /**
   * **故障类型**（v7 里那个 `label`）。只有 `human` 才算真值；`device` 是位图给的弱标签，
   * `ai` 是候选（见域层文件头）。
   */
  faultLabel?: SampleLabel
  /** **设备类型**（v8 新增）：样本装在什么设备上。设备从不告诉我们，所以只可能是人工或 AI。 */
  equipmentLabel?: SampleLabel
  metrics: SampleMetrics
  createdAt: number
}

/** 按维度取标签：两个维度的读写逻辑完全一样，只是列名不同 —— 这里把列名映射收在一处。 */
const LABEL_COLUMNS: Record<SampleLabelDimension, { text: string; source: string }> = {
  fault: { text: 'fault_label', source: 'fault_label_source' },
  equipment: { text: 'equipment_label', source: 'equipment_label_source' }
}

/** 行 → 一个维度的标签（只有一半的行按"未标注"处理：CHECK 挡住新写入，这里防旧的/被改过的库）。 */
function readLabel(
  row: SampleRow,
  dimension: SampleLabelDimension
): SampleLabel | undefined {
  const columns = LABEL_COLUMNS[dimension]
  const text = row[columns.text as keyof SampleRow]
  const source = row[columns.source as keyof SampleRow]
  if (typeof text !== 'string' || typeof source !== 'string') return undefined
  return isLabelSource(source) ? { text, source } : undefined
}


/**
 * 把 `features` 那格 JSON 解析成指标。
 *
 * 三条规矩：
 *   - 认不出的键**丢掉**（不认识的维度不该被当成一个已知特征带进训练集）；
 *   - 非有限数丢掉（`NaN`/`Infinity`/字符串都不是测量值）；
 *   - 解析失败**返回空对象**而不是抛异常：一条坏样本不该让整张列表打不开。
 */
function parseMetrics(raw: string | null): SampleMetrics {
  if (raw === null || raw === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}

  const source = parsed as Record<string, unknown>
  const metrics: SampleMetrics = {}
  for (const metric of SAMPLE_FEATURE_METRICS) {
    const value = source[metric]
    if (typeof value === 'number' && Number.isFinite(value)) metrics[metric] = value
  }
  return metrics
}

/** 写库前把指标收成 JSON：**只留有限数**，缺的键就不写（缺失保持缺失）。 */
function serialiseMetrics(metrics: SampleMetrics): string | null {
  const compact: Record<string, number> = {}
  for (const metric of SAMPLE_FEATURE_METRICS) {
    const value = metrics[metric]
    if (typeof value === 'number' && Number.isFinite(value)) compact[metric] = value
  }
  return Object.keys(compact).length === 0 ? null : JSON.stringify(compact)
}

function toSample(row: SampleRow): Sample {
  const sample: Sample = {
    id: row.id,
    deviceId: row.device_id,
    channelId: row.channel_id,
    source: isSampleSource(row.source) ? row.source : 'import',
    capturedAt: row.captured_at,
    metrics: parseMetrics(row.features),
    createdAt: row.created_at
  }
  if (row.recording_id !== null) sample.recordingId = row.recording_id
  if (row.duration_ms !== null) sample.durationMs = row.duration_ms
  if (row.sample_rate !== null) sample.sampleRate = row.sample_rate
  if (row.relative_path !== null) sample.relativePath = row.relative_path
  if (row.sha256 !== null) sample.sha256 = row.sha256
  const faultLabel = readLabel(row, 'fault')
  if (faultLabel !== undefined) sample.faultLabel = faultLabel
  const equipmentLabel = readLabel(row, 'equipment')
  if (equipmentLabel !== undefined) sample.equipmentLabel = equipmentLabel
  return sample
}

export interface SampleInsert {
  recordingId?: string
  deviceId: string
  channelId: number
  source: SampleSource
  capturedAt: number
  durationMs?: number
  sampleRate?: number
  relativePath?: string
  sha256?: string
  /** 入库时就能确定的标签（设备弱标签或人工标注）；也可以之后用 `setLabel()` 补。 */
  faultLabel?: SampleLabel
  equipmentLabel?: SampleLabel
  metrics: SampleMetrics
}

export interface SampleQuery {
  deviceId?: string
  faultLabel?: string
  faultLabelSource?: SampleLabelSource
  equipmentLabel?: string
  equipmentLabelSource?: SampleLabelSource
  source?: SampleSource
  /** 闭区间的 epoch ms。 */
  from?: number
  to?: number
  /** 只看某一台设备的某一路通道。 */
  channelId?: number
  limit?: number
  offset?: number
}

/**
 * 入库结果的三种情形。
 *
 * `created: false` 不是错误：同一条录音同一个时刻同一个来源重复入库是**常见**的
 * （"把这条告警加入样本库"点两次、或告警联动与手动各加一次），它必须幂等 —— 样本库出现
 * 完全相同的两条，训练时那一条的权重就凭空翻倍。
 */
export interface SampleInsertResult {
  id: string
  created: boolean
}

export class SampleRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(input: SampleInsert): SampleInsertResult {
    assertLabelFits(input.faultLabel)
    assertLabelFits(input.equipmentLabel)

    const existing = this.db
      .prepare<
        [string | null, string, number, string, number],
        { id: string }
      >(
        `SELECT id FROM samples
          WHERE recording_id IS ? AND device_id = ? AND channel_id = ? AND source = ? AND captured_at = ?`
      )
      .get(
        input.recordingId ?? null,
        input.deviceId,
        input.channelId,
        input.source,
        input.capturedAt
      )
    if (existing) return { id: existing.id, created: false }

    const id = newSampleId()
    this.db
      .prepare(
        `INSERT INTO samples (
           id, recording_id, device_id, channel_id, source, captured_at,
           duration_ms, sample_rate, relative_path, sha256,
           fault_label, fault_label_source, equipment_label, equipment_label_source,
           features, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.recordingId ?? null,
        input.deviceId,
        input.channelId,
        input.source,
        input.capturedAt,
        input.durationMs ?? null,
        input.sampleRate ?? null,
        input.relativePath ?? null,
        input.sha256 ?? null,
        input.faultLabel?.text ?? null,
        input.faultLabel?.source ?? null,
        input.equipmentLabel?.text ?? null,
        input.equipmentLabel?.source ?? null,
        serialiseMetrics(input.metrics),
        now()
      )

    return { id, created: true }
  }

  findById(id: string): Sample | undefined {
    const row = this.db.prepare<[string], SampleRow>(`SELECT * FROM samples WHERE id = ?`).get(id)
    return row ? toSample(row) : undefined
  }

  query(query: SampleQuery = {}): { items: Sample[]; total: number } {
    const limit = clampLimit(query.limit, 200, 2000)
    const offset = Math.max(0, query.offset ?? 0)
    const conditions: string[] = []
    const params: (string | number)[] = []

    if (query.deviceId) {
      conditions.push('device_id = ?')
      params.push(query.deviceId)
    }
    if (query.channelId !== undefined) {
      conditions.push('channel_id = ?')
      params.push(query.channelId)
    }
    if (query.source) {
      conditions.push('source = ?')
      params.push(query.source)
    }
    if (query.faultLabel !== undefined) {
      conditions.push('fault_label = ?')
      params.push(query.faultLabel)
    }
    if (query.faultLabelSource) {
      conditions.push('fault_label_source = ?')
      params.push(query.faultLabelSource)
    }
    if (query.equipmentLabel !== undefined) {
      conditions.push('equipment_label = ?')
      params.push(query.equipmentLabel)
    }
    if (query.equipmentLabelSource) {
      conditions.push('equipment_label_source = ?')
      params.push(query.equipmentLabelSource)
    }
    if (query.from !== undefined) {
      conditions.push('captured_at >= ?')
      params.push(query.from)
    }
    if (query.to !== undefined) {
      conditions.push('captured_at <= ?')
      params.push(query.to)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare<typeof params, SampleRow>(
        `SELECT * FROM samples ${where} ORDER BY captured_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset)
    const totalRow = this.db
      .prepare<typeof params, { total: number }>(`SELECT COUNT(*) AS total FROM samples ${where}`)
      .get(...params)

    return { items: rows.map(toSample), total: totalRow?.total ?? 0 }
  }

  /**
   * 建训练集用的全部样本。
   *
   * 刻意**不**在这里筛"能不能训练"：那是 `isTrainable()` 的判断（纯函数、有单测），
   * 在这里再实现一遍就会出现两个版本。这一层只把行给出去，并且带 `total` 之外没有任何
   * 聚合口径 —— 谁能进训练集由域层说了算。
   *
   * `maxItems` 是**硬上限**：训练集不该把整个库拉进内存，超了就说超了（下面那个 `truncated`），
   * 不静默截断。
   */
  trainingRows(maxItems = 5000): { items: Sample[]; truncated: boolean } {
    const rows = this.db
      .prepare<[number], SampleRow>(`SELECT * FROM samples ORDER BY captured_at ASC LIMIT ?`)
      .all(maxItems + 1)
    const truncated = rows.length > maxItems
    return { items: rows.slice(0, maxItems).map(toSample), truncated }
  }

  /**
   * 写某一维的标签（或清除）。
   *
   * `label` 为 `undefined` 就是把这一维退回**未标注**：人工改了标签之后又想撤销是正常操作，
   * 而"撤不回去"会让人不敢标。两个字段一起写，永远不会出现"有标签没来源"的行。
   *
   * **只动被点名的那一维**：改故障类型不该顺手清掉设备类型 —— 那正是把两个维度分开存
   * 的意义所在，一次 `UPDATE` 里带上另一列就会互相踩。
   */
  setLabel(id: string, dimension: SampleLabelDimension, label: SampleLabel | undefined): boolean {
    assertLabelFits(label)
    const columns = LABEL_COLUMNS[dimension]
    return (
      this.db
        .prepare(
          `UPDATE samples SET ${columns.text} = ?, ${columns.source} = ? WHERE id = ?`
        )
        .run(label?.text ?? null, label?.source ?? null, id).changes > 0
    )
  }

  /** 某一维每个类别各几条 —— 类别不平衡是"模型只在多数类上好看"的原因，界面要能看见。 */
  countByLabel(dimension: SampleLabelDimension): Record<string, number> {
    const column = LABEL_COLUMNS[dimension].text
    const rows = this.db
      .prepare<[], { label: string; total: number }>(
        `SELECT ${column} AS label, COUNT(*) AS total FROM samples
          WHERE ${column} IS NOT NULL GROUP BY ${column}`
      )
      .all()
    const counts: Record<string, number> = {}
    for (const row of rows) counts[row.label] = row.total
    return counts
  }

  /**
   * 某一维按来源（设备弱标签 / 人工 / AI）计数，外加未标注那一档。
   *
   * 两个维度**分开数**：故障类型的来源构成通常以设备为主（位图），而设备类型几乎全是人工 ——
   * 合成一个数字会看不出这件事。
   */
  countByLabelSource(
    dimension: SampleLabelDimension
  ): Record<SampleLabelSource | 'unlabelled', number> {
    const column = LABEL_COLUMNS[dimension].source
    const rows = this.db
      .prepare<[], { label_source: string | null; total: number }>(
        `SELECT ${column} AS label_source, COUNT(*) AS total FROM samples GROUP BY ${column}`
      )
      .all()
    const counts: Record<SampleLabelSource | 'unlabelled', number> = {
      device: 0,
      human: 0,
      ai: 0,
      unlabelled: 0
    }
    for (const row of rows) {
      counts[isLabelSource(row.label_source) ? row.label_source : 'unlabelled'] = row.total
    }
    return counts
  }

  /**
   * 某一维里有多少条样本用到了这个名字。
   *
   * 标签库要靠它回答两件事：删除一个正在用的标签**必须被拒绝**（否则那些样本会指向一个
   * 已经不存在的类别），重命名时要知道该改几条。
   */
  countSamplesUsingLabel(dimension: SampleLabelDimension, name: string): number {
    const column = LABEL_COLUMNS[dimension].text
    const row = this.db
      .prepare<[string], { total: number }>(
        `SELECT COUNT(*) AS total FROM samples WHERE ${column} = ?`
      )
      .get(name)
    return row?.total ?? 0
  }

  /**
   * 把某一维的旧名字**整批**改成新名字（重命名标签时用）。
   *
   * 由调用方放在一个事务里和 `sample_labels` 的更新一起提交：只改了标签库、没改样本，
   * 那些样本就会指向一个"库里没有的类别"，而界面上的筛选下拉会立刻对不上。
   */
  renameLabelEverywhere(
    dimension: SampleLabelDimension,
    from: string,
    to: string,
    source: SampleLabelSource
  ): number {
    const columns = LABEL_COLUMNS[dimension]
    return this.db
      .prepare(
        `UPDATE samples SET ${columns.text} = ?, ${columns.source} = ? WHERE ${columns.text} = ?`
      )
      .run(to, source, from).changes
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM samples WHERE id = ?`).run(id).changes > 0
  }

  count(): number {
    const row = this.db.prepare<[], { total: number }>(`SELECT COUNT(*) AS total FROM samples`).get()
    return row?.total ?? 0
  }
}

/** 与其它仓库同一条夹取规则：坏请求不该能把内存吃光。 */
function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
}
