/**
 * Historical-trend view models (Phase 11) — the presentation contract.
 *
 * WHY THESE LIVE IN `shared/`
 * Same reason as `device-config.ts`: `RendererApi['trends']` names them, and a
 * type-only import across the process boundary drags the source file's runtime
 * imports with it. Declaring the shapes here keeps the renderer's TypeScript
 * project free of main-process code.
 *
 * The metric ladder itself (`TREND_METRICS`) deliberately stays in the main
 * process: it is a runtime value derived from the Parquet column list, and the
 * renderer learns the available metrics from the query API rather than from a
 * duplicated constant.
 */

/** Aggregation applied inside each time bucket. */
export type TrendAggregation = 'avg' | 'min' | 'max' | 'p95'

/**
 * Metric identifiers.
 *
 * Mirror of the main process's `TREND_METRICS`. Kept as a union rather than an
 * enum so the renderer can key label/unit tables off it exhaustively.
 */
export type TrendMetric =
  | 'spl'
  | 'mainFrequency'
  | 'smoothness'
  | 'bandEnergyRatio'
  | 'oddEvenHarmonicRatio'
  | 'spectralComplexity'
  | 'fingerprintVariation'

/**
 * What the renderer sends.
 *
 * Carries `deviceId` (the local row id) NOT `deviceUid`: the uid is the on-disk
 * directory identity, and handing it to the presentation layer would leak the
 * storage layout. The main process resolves it.
 */
export interface TrendQueryBody {
  deviceId: string
  channelId?: number
  metric: TrendMetric
  from: number
  to: number
  aggregation?: TrendAggregation
  bucketSeconds?: number
  maxPoints?: number
}

/** One downsampled point. */
export interface TrendPoint {
  timestamp: number
  /** `NaN` when the device reported nothing in this bucket. Render as a gap. */
  value: number
  /** Raw rows aggregated into this bucket. */
  sampleCount: number
}

export interface TrendSeries {
  metric: TrendMetric
  aggregation: TrendAggregation
  /** Bucket width chosen by the main process from the requested span. */
  bucketSeconds: number
  points: TrendPoint[]
  /** Raw rows the query considered, before bucketing. */
  totalRows: number
  /** Parquet files the query touched. */
  filesScanned: number
  /** True when the result hit the point cap. */
  truncated: boolean
  durationMs: number
}

/** Time range actually covered by stored data. */
export interface TrendCoverage {
  from?: number
  to?: number
  files: number
}

/** Buffered/written counters for the diagnostics line. */
export interface TrendStorageStats {
  bufferedRows: number
  filesWritten: number
  rowsWritten: number
  lastFlushAt?: number
  lastError?: string
}

// ---------------------------------------------------------------------------
// 多通道叠加（业主 2026-09-18 的追加要求）
// ---------------------------------------------------------------------------

/**
 * 同时显示的量最多几个。
 *
 * 4 是业主点名的数量（声压级 / 平稳度 / 频带能量比 / 奇偶次谐波能量比），也是**查询次数**
 * 的上限：一次筛选变更会打出 `量 × 通道` 条 IPC，16 通道的设备上 4 个量就是 64 条。
 * 允许再往上加只会让一次筛选变更打出上百条 DuckDB 扫描。
 *
 * **放在 `shared/` 而不是渲染层**（与这个文件里其它契约同一条理由）：它是纯值、没有依赖，
 * 而且单测跑在 `src/shared/**` + `tests/**` 上、编译不到 `src/renderer/**` ——
 * 放在渲染层就只能靠"读源码字符串"来断言，放在这里可以真的 import 进来断言。
 */
export const TREND_METRIC_MAX_SELECTED = 4

/**
 * 多条通道叠在一根轴上时，每条通道的线色。
 *
 * 三条规矩，都是**我们自己定的**（业主只说了"不同颜色"）：
 *   1. **不用状态色**：红/绿在这套界面里已经表示"告警/在线"，拿来区分通道会让一条红色的线
 *      看起来像"这条通道有故障"；
 *   2. **第一色是品牌橙**（`#FF6A1A`），与单条曲线时的颜色一致 —— 只看一条通道的图上，
 *      颜色不该因为"多了几条通道可选"就变；
 *   3. **顺序固定**（按通道号取模），所以同一条通道在两次打开之间颜色不变；8 色之后循环，
 *      但图例里每一条都带通道号，16 通道的 SN-16 仍然分得清哪条是哪条。
 *
 * 这八个值在浅色底上都过得了对比度，且两两之间在灰度下也能区分（不能只靠色相）。
 */
export const TREND_CHANNEL_COLORS: readonly string[] = [
  '#FF6A1A', // 品牌橙
  '#2563EB', // 蓝
  '#7C3AED', // 紫
  '#0891B2', // 青
  '#B45309', // 琥珀
  '#DB2777', // 品红
  '#4D7C0F', // 橄榄
  '#475569' // 石板灰
]

/**
 * 第 `index` 条通道的线色（超出调色板时循环）。
 *
 * 负数与小数都收敛到一个合法下标：ECharts 拿到 `undefined` 时那条线会用默认色，
 * 于是"第 9 条通道"看起来像是"第 1 条"，而没有任何地方会报错。
 */
export function trendChannelColor(index: number): string {
  const safe = Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0
  return TREND_CHANNEL_COLORS[safe % TREND_CHANNEL_COLORS.length] as string
}

// ---------------------------------------------------------------------------
// Y 轴的取值范围（第 13 批第 5 条）
// ---------------------------------------------------------------------------

/**
 * 声压级 Y 轴的固定上限/下限（业主原话：「声压级 Y 轴 0–100 dB」）。
 *
 * 为什么声压级要固定、别的量不固定：声压级**有物理边界**（这一族设备的量程就是
 * 0–100 dB），固定之后两次查询、两台设备的图可以直接对比（"这条线在 70 dB 上下"
 * 这句话在两张图之间才有意义）；而平稳度、频带能量比是无量纲比值，范围随数据走，
 * 写死一根轴只会把变化压成一条直线（第 6 条要的"Y 轴弹性变化"正是为它们准备的）。
 *
 * **手册未说明**：手册没有规定趋势图的纵轴范围（这一族设备的量程上限见设备参数一节，
 * 但"图上怎么画"是我们的设计）。100 这个数就是这台设备的量程上限，不是我们挑的。
 */
export const SPL_AXIS_MIN = 0
export const SPL_AXIS_MAX = 100

/** 一根 Y 轴的范围；两个字段都不给 = **弹性**（ECharts 按数据自适应）。 */
export interface TrendAxisRange {
  min?: number
  max?: number
}

/**
 * 这个量的 Y 轴范围。
 *
 * 只有声压级是固定的；其余的量返回空对象（= 交给 ECharts 自适应）。做成纯函数是为了
 * 能在没有浏览器的情况下断言"声压级确实是 0–100"—— 探针只能看到画布，看不到坐标轴配置。
 */
export function trendAxisRange(metric: TrendMetric): TrendAxisRange {
  if (metric === 'spl') return { min: SPL_AXIS_MIN, max: SPL_AXIS_MAX }
  return {}
}

/**
 * Y 轴范围给探针看的文本（`0-100` / `auto`）。
 *
 * 单独一个函数而不是在模板里拼：探针断言的字符串与图里那根轴**同一个来源**，
 * 两处各写一遍的话，"图上固定 0–100"与"探针读到 0-100"可以同时成立而其实不相关。
 */
export function trendAxisRangeText(metric: TrendMetric): string {
  const range = trendAxisRange(metric)
  if (range.min === undefined && range.max === undefined) return 'auto'
  return `${range.min ?? 'auto'}-${range.max ?? 'auto'}`
}
