/**
 * 本地异常声纹样本库（业主 2026-09-16：「将告警和手动录音建立本地异常声纹样本库，
 * 方便后续进行二次训练」）。
 *
 * ---------------------------------------------------------------------------
 * 这个模块只做**判断**，不做 I/O：类型、标签归一化、特征向量、能不能进训练集
 * ---------------------------------------------------------------------------
 * 落库在 `main/services/database/sample-repository.ts`，界面在后面一轮。判断放在纯函数里是
 * 本仓库一贯的做法（同 `alarm-mask.ts` / `device-status.ts`），因为这些判断恰好都是
 * 「一改就会让数据集变脏」的那种。
 *
 * ---------------------------------------------------------------------------
 * 最重要的一条设计：**标签必须记录它是谁给的**
 * ---------------------------------------------------------------------------
 * 一个样本库最容易出的错不是"少存了几条"，而是**把设备的猜测当成人给的答案**。
 * 三类来源的可信度完全不同，混在一起之后训练出来的模型会说谎，而且**无法事后分辨**：
 *
 *   - `device` **弱标签**：设备自己判的。FA8 给的是 `dauAbnoType` 位图（手册有逐位表），
 *     E2/听诊盒子给的是 `alarm_reasons` **文本**（如「时域能量比超限，」）。它反映的是
 *     **设备的阈值/模型当时怎么判**，不是物理事实；
 *   - `human` **人工标注**：唯一的真值（ground truth）。人工改过的标签一律记成这个；
 *   - `ai` **模型/大模型建议**：**待人工确认**的候选，不是答案。
 *
 * 所以 `labelSource` 不是装饰字段：`trainingSet()` 默认**只用 `human`**（见
 * `isUsableForTraining()`），要用弱标签必须显式选择 —— 那是"拿设备的判断去学设备的判断"，
 * 得到的指标会虚高，这件事必须由调用方自己承担，而不是由我们静默决定。
 *
 * ---------------------------------------------------------------------------
 * 标签是**数据**，不是界面文案
 * ---------------------------------------------------------------------------
 * 目录里的「电晕放电」是给操作员看的；样本库里的标签要能进数据集、能跨语言比较，所以：
 *   - 设备位图来的标签用我们的**稳定键**（`corona_discharge`，即 `alarmTypeKey()` 的结果）；
 *   - E2/听诊盒子来的标签是**设备自己的文本原样存**（我们**没有**它的完整枚举，见
 *     `docs/Ivms4200-UX-REFERENCE.md` §15.23.3，所以不翻译、不映射，免得把不认识的类别
 *     硬塞进一个我们编的槽位里）；
 *   - 人工标注是自由文本（操作员可能用一个手册里没有的说法，那是允许的）。
 * 一句话：**翻译只发生在渲染层**，落进样本库的永远是稳定标识或原文。
 */

import type { AlarmType } from './models'
import { alarmTypeKey } from './alarm-mask'
import type { TrendMetric } from './trend'

/**
 * 标签的**两个维度**（业主 2026-09-16 追加：「应该支持两个类型的标签，一个是设备类型，
 * 一个是故障类型，这样方便后续进行数据采集和分类」）。
 *
 * 为什么必须分成两列而不是拼成一个字符串：这两件事回答的是**不同的问题**，而且它们的
 * 组合才有意义 ——「局部放电」在变压器上和开关柜上不是同一种声学现象，而"轴承故障"这个
 * 故障名离开设备类型就成了一个没有外延的词。拼成 `变压器/局部放电` 之后：
 *   - 按设备类型筛样本要先做字符串切分（一种最容易写错的解析）；
 *   - 同一个设备类型的两种写法（`变压器` / `电力变压器`）会被当成两个设备类型；
 *   - 训练集统计只能按"组合"计数，看不到"某个故障类型跨了几种设备"这件要紧的事。
 *
 * `fault` 那一维就是原来那一个 `label`（设备位图给的弱标签也落在这一维：FA8 的
 * `dauAbnoType` 位描述的是**故障**）。`equipment` 是新的，设备**从来不会**告诉我们它装在
 * 什么设备上，所以这一维只可能是人工标注或 AI 候选。
 */
export type SampleLabelDimension = 'equipment' | 'fault'

export const SAMPLE_LABEL_DIMENSIONS: readonly SampleLabelDimension[] = ['equipment', 'fault']

/** 收窄来自 IPC / 数据库边界的取值。 */
export function isSampleLabelDimension(value: unknown): value is SampleLabelDimension {
  return typeof value === 'string' && (SAMPLE_LABEL_DIMENSIONS as readonly string[]).includes(value)
}

/**
 * 标签库里去重用的**键**。
 *
 * 用户看到的还是他输入的名字，但库里 `UNIQUE (dimension, name_key)`：`轴承故障` 与
 * `轴承故障 `、`Bearing` 与 `bearing` 不该变成两个类别 —— 那正是"数据集里最常见的脏"。
 * 大小写只在有必要时才抹平（中文没有大小写），折叠空白与尾随标点复用同一条归一化。
 */
export function labelNameKey(text: unknown): string | undefined {
  const normalised = normaliseSampleLabel(text)
  return normalised === undefined ? undefined : normalised.toLocaleLowerCase()
}

/** 样本从哪来。 */
export type SampleSource = 'alarm' | 'manual' | 'import'

/** 标签是谁给的（见文件头：这一条是整个样本库可信度的基础）。 */
export type SampleLabelSource = 'device' | 'human' | 'ai'

export const SAMPLE_LABEL_SOURCES: readonly SampleLabelSource[] = ['device', 'human', 'ai']

/** 收窄来自 IPC / 数据库边界的取值（与 `isEventSeverity()` 同一条规矩）。 */
export function isSampleLabelSource(value: unknown): value is SampleLabelSource {
  return typeof value === 'string' && (SAMPLE_LABEL_SOURCES as readonly string[]).includes(value)
}

export const SAMPLE_SOURCES: readonly SampleSource[] = ['alarm', 'manual', 'import']

/** 同上：样本来源的收窄。 */
export function isSampleSource(value: unknown): value is SampleSource {
  return typeof value === 'string' && (SAMPLE_SOURCES as readonly string[]).includes(value)
}

/**
 * 标签长度上限。
 *
 * **我们定的**（手册未说明）：E2 的 `alarm_reasons` 是短句，人工标注也不该写成一篇文章 ——
 * 数据集里的"标签"一旦变成句子，聚类和统计就没有意义了。
 */
export const SAMPLE_LABEL_MAX_LENGTH = 64

export interface SampleLabel {
  /** 稳定标识或设备原文，**不是**界面文案。 */
  text: string
  source: SampleLabelSource
}

/**
 * 归一化一个标签。
 *
 * 返回 `undefined`（而不是空串）表示"没有标签"：`undefined` 与"标签是空字符串"在数据集里
 * 必须是两件事 —— 前者是**未标注**（不能进训练集），后者是"有人标了个空的"（同样是坏数据）。
 * 两者都不该进训练集，但原因不同，所以调用方要能分辨。
 */
export function normaliseSampleLabel(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  // 折叠内部空白：E2 的原文可能带尾随标点与空格，同一个类别因为多一个空格被当成两个类别，
  // 是数据集里最常见的一种脏。
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return undefined
  const trimmed = stripTrailingSeparators(collapsed)
  if (trimmed === '') return undefined
  return trimmed.length > SAMPLE_LABEL_MAX_LENGTH
    ? trimmed.slice(0, SAMPLE_LABEL_MAX_LENGTH)
    : trimmed
}

/**
 * 去掉**尾随**的分隔标点（`，` `,` `、` `；` `;`）。
 *
 * 为什么要做（有实测依据）：E2/听诊盒子的告警原因原文在手册示例里就是
 * `"时域能量比超限，"` —— **带一个中文逗号**。留着它，同一个类别会因为"设备这一条带了逗号、
 * 那一条没带"被切成两个标签，而每个标签只剩一两条样本，数据集直接就废了。
 *
 * 只去**尾部**、只去分隔符：类别名内部的标点（例如「谐波分量超限（HPSS超限）」的括号）是
 * 内容的一部分，动它就是改设备给的类别名。这条规则是**我们定的**，手册没有规定标签怎么归一化。
 */
function stripTrailingSeparators(text: string): string {
  return text.replace(/[，,、；;]+$/u, '').trim()
}

/**
 * 由设备的告警位图给一个**弱标签**。
 *
 * 多个位同时置位时**只取主位**（最低位，与 `primaryAlarmType()` 同一条规则）：一个样本只能
 * 有一个标签，把「SPL + 电晕放电」写成一个复合标签会让类别数爆炸，而每个类别只有一两条样本。
 * 复合信息没有丢 —— 它还在原始告警记录里，样本只记一个主标签。
 */
export function weakLabelFromAlarmTypes(types: readonly AlarmType[]): SampleLabel | undefined {
  const primary = types[0]
  if (primary === undefined) return undefined
  return { text: alarmTypeKey(primary), source: 'device' }
}

/**
 * 由设备给的**原因文本**给一个弱标签（E2/听诊盒子那一族走这条）。
 *
 * 原样保留（只做归一化），**不映射到我们自己的类别**：手册列出 8 条但其中一条重复、
 * 而且明确不是完整清单（见 §15.23.3），照着一个不全的清单去映射，会把不认识的类别
 * 悄悄归到某个错槽位里。未知就保持未知。
 */
export function weakLabelFromReason(reason: unknown): SampleLabel | undefined {
  const text = normaliseSampleLabel(reason)
  return text === undefined ? undefined : { text, source: 'device' }
}

/** 人工标注。空标签返回 `undefined`（未标注），与"标注成空"区分开。 */
export function humanLabel(text: unknown): SampleLabel | undefined {
  const normalised = normaliseSampleLabel(text)
  return normalised === undefined ? undefined : { text: normalised, source: 'human' }
}

/** 模型/大模型的建议。它**待人工确认**，所以来源是 `ai` 而不是 `human`。 */
export function aiLabel(text: unknown): SampleLabel | undefined {
  const normalised = normaliseSampleLabel(text)
  return normalised === undefined ? undefined : { text: normalised, source: 'ai' }
}

// ---------------------------------------------------------------------------
// 特征向量
// ---------------------------------------------------------------------------

/**
 * 特征向量的维度，顺序**就是**向量下标。
 *
 * 这 7 个正是 FA8 `/features_stream` 每秒推的那 7 个（声压级、主频、平滑度、频带能量比、
 * 奇偶谐波比、频谱复杂度、声纹成分变化量），与 `metrics` 目录键、`TrendMetric` 一一对应 ——
 * 复用同一套标识，不再造第二套特征命名。
 */
export const SAMPLE_FEATURE_METRICS: readonly TrendMetric[] = [
  'spl',
  'mainFrequency',
  'smoothness',
  'bandEnergyRatio',
  'oddEvenHarmonicRatio',
  'spectralComplexity',
  'fingerprintVariation'
]

/**
 * 进训练集**至少**要有的那几维。
 *
 * 前四个是设备一定会报的（FA8 的 `/features_stream` 每帧都有、告警录音也会记进 `AlarmEvent`）；
 * 后三个（hr_f / sc_f / sv_f）不是每条路径都有。缺失值**不补零** —— 补零等于告诉模型
 * "这一维量到了 0"，那是一个**编造出来的测量值**，比缺一维更糟。所以缺后三维的样本可以
 * 入库、可以在界面上看，但**不进训练集**。
 */
export const SAMPLE_TRAINING_MIN_METRICS: readonly TrendMetric[] = [
  'spl',
  'mainFrequency',
  'smoothness',
  'bandEnergyRatio'
]

export type SampleMetrics = Partial<Record<TrendMetric, number | undefined>>

/** 一个有限数才算测到了；`NaN` / `Infinity` / 非数字都不算。 */
function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 把特征放进固定顺序的向量。
 *
 * 缺的维度用 `NaN` 占位而**不是** 0：向量长度恒定（调用方不必处理变长），而 `NaN` 在
 * 后续计算里会自然地"污染"任何用到它的距离 —— 这正是我们想要的：**缺失必须传播出去，
 * 不能被当成一个合法的 0**。`trainingVector()` 会在那之前就把这类样本挡掉。
 */
export function featureVector(metrics: SampleMetrics): number[] {
  return SAMPLE_FEATURE_METRICS.map((metric) => finiteOrUndefined(metrics[metric]) ?? Number.NaN)
}

/** 这个样本够不够进训练集：维度齐不齐、有没有标签。 */
export interface TrainableSample {
  label?: SampleLabel
  metrics: SampleMetrics
}

export interface TrainabilityVerdict {
  usable: boolean
  /** 为什么不能用 —— 界面照它说明原因，而不是只说"不可用"。 */
  reason?: 'no-label' | 'missing-metrics'
  /** 缺了哪几维（`reason === 'missing-metrics'` 时有值）。 */
  missing?: TrendMetric[]
}

/**
 * 这一个样本能不能进训练集。
 *
 * **只认人工标签**：弱标签（设备判的）与 AI 建议都不是真值。想用弱标签必须由调用方显式
 * 走另一条路（`trainableWithWeakLabels`），因为那件事的代价（指标虚高）必须由决定的人承担，
 * 不能由这里静默替他决定。
 */
export function isTrainable(sample: TrainableSample): TrainabilityVerdict {
  if (sample.label === undefined || sample.label.source !== 'human') {
    return { usable: false, reason: 'no-label' }
  }
  const missing = SAMPLE_TRAINING_MIN_METRICS.filter(
    (metric) => finiteOrUndefined(sample.metrics[metric]) === undefined
  )
  if (missing.length > 0) return { usable: false, reason: 'missing-metrics', missing: [...missing] }
  return { usable: true }
}

/** 这个样本在**显式允许弱标签**时能不能用（AI 建议仍然不算 —— 它连弱标签都不是，是候选）。 */
export function isTrainableWithWeakLabels(sample: TrainableSample): boolean {
  if (sample.label === undefined || sample.label.source === 'ai') return false
  return SAMPLE_TRAINING_MIN_METRICS.every(
    (metric) => finiteOrUndefined(sample.metrics[metric]) !== undefined
  )
}

/** 训练集里每个类别各有多少条 —— 类别极不平衡是"模型只在多数类上好看"的根源，界面要说。 */
export function countByLabel(samples: readonly TrainableSample[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const sample of samples) {
    const text = sample.label?.text
    if (text === undefined) continue
    counts[text] = (counts[text] ?? 0) + 1
  }
  return counts
}
