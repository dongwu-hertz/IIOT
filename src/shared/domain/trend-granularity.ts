/**
 * X 轴的**时间颗粒度**（业主 2026-09-19 第 13 批第 5 条）。
 *
 * 业主原话：「下方的指标删除聚合方式、直接呈现所有结果；声压级那四张卡片删除；
 * 只显示趋势曲线；Y 轴 0–100 dB；**X 轴支持自定义缩放时间颗粒度**」。
 *
 * 这一条与"聚合方式"的关系（两件事，别混）
 *   · **聚合方式**（avg/min/max/p95）说的是"一个时间桶**里面**怎么算"——业主把它删了，
 *     现在固定用平均，Y 轴名字里照旧写着「（平均）」（见 `TrendView` 的轴名）。
 *   · **时间颗粒度**说的是"一个桶**有多宽**"——这一个是业主**要**的：桶越窄，
 *     看到的越接近原始读数；桶越宽，同样一段时间的点越少、趋势越清楚。
 *   所以"删除聚合方式"不等于"删除时间桶"：桶是"一段时间怎么画成一条线"这件事本身，
 *   删了它，一个月的历史就是一个点。
 *
 * 为什么选项是一小把、而不是把主进程那把 20 档梯子全摆出来
 *   主进程的 `BUCKET_LADDER_SECONDS` 有 20 档（1 秒 → 1 周），那是给"按跨度自动挑"用的；
 *   摆到界面上是一排 20 个按钮，操作员要找的那三档（秒级看瞬态 / 分钟级看班次 /
 *   小时级看趋势）会淹没在里面。这里给的是**六档 + 自动**，每一档对应一句可以说清楚的用途。
 *
 * **手册未说明**：iVMS-4200 手册没有"时间颗粒度"这个控件（它的趋势报表只有固定的统计方式），
 * 所以档位怎么分、要不要给"自动"，都是本仓库的设计。
 */

/** 一档时间颗粒度。`seconds === null` = 自动（由主进程按跨度挑）。 */
export interface TrendGranularityOption {
  /** 稳定标识，存进 store、也进 `data-*` 钩子。 */
  key: string
  /** 桶宽（秒）；`null` = 自动。 */
  seconds: number | null
  /** 目录键（本模块不 import vue-i18n，与 `camera-autoplay.ts` 同一条规矩）。 */
  labelKey: string
}

/**
 * 界面上的六档 + 自动。
 *
 * 顺序就是显示顺序，也是"从细到粗"的顺序 —— 操作员想放大时间轴时会顺着往左找。
 */
export const TREND_GRANULARITY_OPTIONS: readonly TrendGranularityOption[] = [
  { key: 'auto', seconds: null, labelKey: 'granularity.auto' },
  { key: '1s', seconds: 1, labelKey: 'granularity.sec1' },
  { key: '10s', seconds: 10, labelKey: 'granularity.sec10' },
  { key: '1m', seconds: 60, labelKey: 'granularity.min1' },
  { key: '5m', seconds: 300, labelKey: 'granularity.min5' },
  { key: '1h', seconds: 3600, labelKey: 'granularity.hour1' },
  { key: '1d', seconds: 86_400, labelKey: 'granularity.day1' }
]

export const TREND_GRANULARITY_DEFAULT_KEY = 'auto'

/** 按 key 找那一档；找不到给 `undefined`（**不猜**，与 `channelState()` 同一条规矩）。 */
export function granularityOption(key: string): TrendGranularityOption | undefined {
  return TREND_GRANULARITY_OPTIONS.find((option) => option.key === key)
}

/**
 * key → 要发给主进程的 `bucketSeconds`；`undefined` = **不发这个字段**（由主进程按跨度挑）。
 *
 * 注意区分 `undefined` 与 `null`：`null` 在选项里表示"自动"，而 IPC 契约里"不会这个字段"
 * 才是自动 —— 传 `null` 会被 JSON 序列化成 `null`，主进程的 `?? chooseBucketSeconds(...)`
 * 会接住 `null`，但契约的类型是 `number | undefined`，所以这里统一收成 `undefined`。
 */
export function granularityBucketSeconds(key: string): number | undefined {
  const option = granularityOption(key)
  if (!option || option.seconds === null) return undefined
  return option.seconds
}

/**
 * 后端实际用的桶宽 → 界面上那一档（都没有对应档时返回 `null`）。
 *
 * 用途只有一个：自动模式下把"主进程挑了多宽的桶"回显到那一排按钮上
 * （`自动（15 秒）`）。不回显的话，"自动"就是一个黑箱 —— 而它决定了这张图到底有多细。
 */
export function granularityKeyForSeconds(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds)) return null
  const hit = TREND_GRANULARITY_OPTIONS.find(
    (option) => option.seconds !== null && option.seconds === seconds
  )
  return hit ? hit.key : null
}
