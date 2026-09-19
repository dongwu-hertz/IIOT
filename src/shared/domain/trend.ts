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

// ---------------------------------------------------------------------------
// 时间轴缩放（第 13 批第 6 条）
// ---------------------------------------------------------------------------

/**
 * 每张折线图的时间轴都能放大缩小（业主原话：「所有折线图支持时间轴放大缩小」）。
 *
 * 两条通道一起给，是因为它们解决的是两种不同的操作：
 *   · `inside` —— 滚轮/双指在图上缩放（快，手不离鼠标）；
 *   · `slider` —— 图下方那条可以拖的范围条（能看见"现在看的是哪一段"，也能拖回去）。
 * 只给 `inside` 的话，操作员一旦缩进去就**看不出来**自己在哪一段（滑块把这件事画出来了）。
 *
 * `filterMode: 'filter'` 是要紧的一行：它让 Y 轴按**当前可见的那一段**重算范围
 * （也就是第 6 条要的"Y 轴弹性变化"）。默认的 `'filter'` 本来就是它，这里**写明**
 * 是因为"放大之后 Y 轴不跟着变"正是这个字段被改成 `'none'` 时的表现，而那种图看起来
 * 只是"线条变得很平"。
 *
 * `moveOnMouseMove: false`：ECharts 在 `inside` 上的默认值是 `true`，意思是**鼠标划过就把
 * 图平移**。在一个监控台页面上，那等于"鼠标从图上走过，时间窗口自己跑了"——操作员会以为
 * 图坏了。所以平移只留给下面那条范围条（拖动它），滚轮仍然只负责缩放。
 */
export function trendDataZoom(window?: { start: number; end: number }): unknown[] {
  /*
   * 窗口**写进选项里**（而不是留给 ECharts 自己记）：
   *
   * `EChart.vue` 用的是 `setOption(option, true)`（notMerge），它的好处是"序列条数变了会
   * 整张换掉"，代价是**任何一次重画都会把用户的缩放丢掉** —— 而这一页会因为通道勾选、
   * 量多选、诊断行更新而重画。把窗口写进选项，重画就只是把同一段窗口画一遍。
   */
  const start = window ? Math.min(100, Math.max(0, window.start)) : 0
  const end = window ? Math.min(100, Math.max(0, window.end)) : 100
  return [
    {
      type: 'inside',
      filterMode: 'filter',
      zoomOnMouseWheel: true,
      moveOnMouseMove: false,
      moveOnMouseWheel: false,
      start,
      end
    },
    {
      type: 'slider',
      filterMode: 'filter',
      height: 18,
      bottom: 4,
      start,
      end,
      // 滑块自己不需要额外的数据阴影（八条通道会在它上面叠成一片糊）。
      showDataShadow: false,
      brushSelect: false
    }
  ]
}

/**
 * 缩放百分比 → 可见的时间桶下标区间（闭区间）。
 *
 * ECharts 的 `dataZoom` 事件给的是百分比（`start` / `end`，0–100），而界面上要说的是
 * "现在看的是第几个到第几个时间桶、从几点到几点" —— 这句话必须由**百分比**算出来，
 * 而不是再猜一次数据。`pointCount` 是这张图的桶数。
 *
 * 边界：桶数 < 2 时给 `null`（没有"一段"可选）；百分比超出 0–100 时收进范围（ECharts 在
 * 拖到两端时会给出带小数的值）。
 */
export function trendZoomWindow(
  pointCount: number,
  startPercent: number,
  endPercent: number
): { fromIndex: number; toIndex: number } | null {
  if (!Number.isFinite(pointCount) || pointCount < 2) return null
  const clamp = (value: number): number =>
    !Number.isFinite(value) ? 0 : Math.min(100, Math.max(0, value))
  const last = pointCount - 1
  const fromIndex = Math.min(last, Math.max(0, Math.round((clamp(startPercent) / 100) * last)))
  const toIndex = Math.min(last, Math.max(fromIndex, Math.round((clamp(endPercent) / 100) * last)))
  return { fromIndex, toIndex }
}

/** 缩放百分比是不是"没有缩放"（两端都在整段范围上）。 */
export function trendZoomIsIdentity(startPercent: number, endPercent: number): boolean {
  return startPercent <= 0.5 && endPercent >= 99.5
}

/** 一次 `dataZoom` 事件的载荷（`EChart.vue` 转发出来的形状）。 */
export interface TrendZoomWindow {
  start: number
  end: number
  startValue?: number | null
  endValue?: number | null
}

/**
 * "刚把选项交给图表"之后，多久以内的 `dataZoom` 事件算**我们自己写选项的回声**。
 *
 * **我们自己的取值**（手册未说明；ECharts 没有 API 能区分"用户缩放"与"程序写入后的回调"）。
 * 250 毫秒是下面两件事之间的折中：
 *   · ECharts 应用 `setOption` 里的 `dataZoom` 并在**下一帧**发出 `dataZoom` 事件（≈16ms），
 *     250ms 足够宽；
 *   · 操作员连续拨两次滚轮之间通常 ≥ 200–300ms，所以真实操作**不会**被吞掉两次以上。
 * 这个值只影响"两次缩放之间要隔多久"，不影响单次缩放的正确性。
 */
export const TREND_ZOOM_ECHO_SUPPRESS_MS = 250

/**
 * 这个 `dataZoom` 事件要不要**记进状态**（返回 false = 丢掉）。
 *
 * ── 为什么需要它（2026-09-20 定位到的一个真死循环）──
 *
 * 这一页把缩放窗口**写进选项**（`trendDataZoom(zoomWindow)`），因为 `EChart.vue` 用的是
 * `setOption(option, true)`（notMerge）—— 不写进去的话，任何一次重画都会把用户的缩放丢掉。
 * 代价是：**我们写进去的窗口，ECharts 应用之后会再发一次 `dataZoom` 事件**。于是
 * "事件 → 改状态 → 重算选项 → `setOption` → 事件"这条环必须有人断开。
 *
 * 原来的断法是"窗口有没有真的变"（百分比差 < 0.01 就丢掉），它能断开"同一段重复报"，
 * 断不开**在"整段"与"非整段"之间来回跳**的那一种 —— 而时间轴 + `filterMode: 'filter'`
 * 恰好会这样：写进去的是 `1/99`，ECharts 按**过滤之后**的范围重算轴，回出来的是"整段"
 * （`0/100`），我们于是把状态清成 `null`，选项又变成 `0/100`，它再回 `1/99`……
 * 真窗口里实测到的现象：**一个核心被占满**（22 核机器上 `percentCPUUsage` 4.5%）、
 * 定时器全部被饿死（页面里的 `setInterval` 心跳停了）、页面照旧出帧、进程内存每 2 秒涨 22MB、
 * 而 JS 堆平在 20MB（分配的都在画布/光栅那一侧）。`executeJavaScript` 从此不再 settle ——
 * 探针看到的就是"渲染进程不响应"，`reload()` 也进不来。**只有杀掉渲染进程才回得来。**
 *
 * 所以判据改成三条，按顺序：
 *   1. **刚写过选项**（`msSinceProgrammaticWrite < suppressMs`）→ 一律丢掉（回声）；
 *   2. 事件本身是"整段"→ 只有在**当前处于缩放状态**时才需要记（记成 `null` = 取消缩放）；
 *   3. 与当前窗口同一段（百分比差 < 0.01）→ 丢掉。
 * 第 1 条是关键：它让"我们写 → 它回 → 我们再写"这条链在**一步之后**就断掉，
 * 无论 ECharts 回的是什么值。
 */
export function trendZoomShouldRecord(
  current: TrendZoomWindow | null,
  incoming: TrendZoomWindow,
  msSinceProgrammaticWrite: number,
  writeTarget: TrendZoomWindow | null = null,
  suppressMs: number = TREND_ZOOM_ECHO_SUPPRESS_MS
): boolean {
  if (msSinceProgrammaticWrite >= 0 && msSinceProgrammaticWrite < suppressMs) return false
  /*
   * **与"我们最后一次写进选项的那个窗口"相同 → 回声**（与时间无关的那一条）。
   *
   * 为什么除了时间窗口还要这一条：回声到达的时间不确定（ECharts 有动画/布局，
   * 实测下一次渲染可能晚于 250ms），只靠时间窗口会漏。而"回声报的就是我们写进去的那一段"
   * 这件事与时间无关：写 W → 它报 W → 丢掉；用户真的缩放 → 报 X ≠ W → 收下。
   * 于是无论 ECharts 什么时候回，这条环都只能转**一圈**。
   */
  if (
    writeTarget !== null &&
    Math.abs(writeTarget.start - incoming.start) < 0.01 &&
    Math.abs(writeTarget.end - incoming.end) < 0.01
  ) {
    return false
  }
  if (trendZoomIsIdentity(incoming.start, incoming.end)) return current !== null
  if (current === null) return true
  return (
    Math.abs(current.start - incoming.start) >= 0.01 ||
    Math.abs(current.end - incoming.end) >= 0.01
  )
}

/**
 * 「接受过多少次缩放」的安全阀：**2 秒内超过 `limit` 次就停止接受**。
 *
 * 这是**最后一道**防线（我们自己的取值，手册未说明）：上面几条判据都是"讲得通的因果"，
 * 而这一条不讲因果 —— 它只保证"任何残余的反馈环最多转 `limit` 圈就停"。
 * 为什么需要：第 28–33 轮那六轮里，这条环每次都表现为"渲染进程一个核心被占满、
 * 定时器被饿死、探针再也拿不到读数"，**代价是整整一轮**；而一个操作员在 2 秒内
 * 主动缩放 8 次以上是极其罕见的（滚轮每一格才发一次）。
 * 触发时返回 false，调用方应当**报一句**（我们把它当问题报出来，不静默）。
 */
export const TREND_ZOOM_BURST_LIMIT = 8
export const TREND_ZOOM_BURST_WINDOW_MS = 2_000

export function trendZoomBurstExceeded(
  acceptedTimestamps: readonly number[],
  now: number,
  limit: number = TREND_ZOOM_BURST_LIMIT,
  windowMs: number = TREND_ZOOM_BURST_WINDOW_MS
): boolean {
  const recent = acceptedTimestamps.filter((stamp) => now - stamp < windowMs)
  return recent.length >= limit
}

// ---------------------------------------------------------------------------
// 时间轴（业主 2026-09-19 最新一条第 5 条）
// ---------------------------------------------------------------------------

/**
 * 时间轴上的缩放窗口 → 可见的时间桶下标区间（闭区间）。
 *
 * 为什么不用百分比：`xAxis.type = 'time'` 之后，ECharts 报的 `dataZoom` 载荷里带的是
 * **时间戳**（`startValue` / `endValue`），百分比只是它的派生物。业主这一条要的正是
 * 「在这个轴上做时间区域选择」—— 那件事的单位是时间，不是"第几格"。
 *
 * 边界：桶不足两个、时间戳非法、或窗口窄到一个桶时返回 `null`（没有"一段"可选）；
 * 窗口比数据宽时收到两端。桶按时间升序，所以用二分找第一个/最后一个落在窗口里的。
 */
export function trendZoomIndexRange(
  timestamps: readonly number[],
  fromMs: number,
  toMs: number
): { fromIndex: number; toIndex: number } | null {
  if (timestamps.length < 2) return null
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return null

  /** 第一个 `>= value` 的下标。 */
  const lowerBound = (value: number): number => {
    let low = 0
    let high = timestamps.length
    while (low < high) {
      const mid = (low + high) >> 1
      if ((timestamps[mid] as number) < value) low = mid + 1
      else high = mid
    }
    return low
  }

  const first = lowerBound(fromMs)
  // 最后一个 `<= toMs`：找第一个 `> toMs` 再退一格。
  let last = lowerBound(toMs + 1) - 1
  if (last < first) last = first
  const fromIndex = Math.min(timestamps.length - 1, Math.max(0, first))
  const toIndex = Math.min(timestamps.length - 1, Math.max(fromIndex, last))
  if (toIndex - fromIndex < 1) return null
  return { fromIndex, toIndex }
}
