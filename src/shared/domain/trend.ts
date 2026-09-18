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
