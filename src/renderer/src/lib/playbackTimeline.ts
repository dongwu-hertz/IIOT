/**
 * 回放时间轴的**几何模型** —— 纯函数、零依赖、零 i18n。
 *
 * 为什么这一层要单独存在
 *   时间轴是三件容易同时出错的事叠在一起：**缩放要不跳动**（滚轮缩放必须以上一时刻的光标位置
 *   为锚点，否则用户一滚就丢失正在看的位置）、**平移要有边界**（不能拖到没有数据的地方还显示
 *   空白时间轴）、**刻度要稳**（刻度必须按绝对时间对齐，否则拖动时标签会来回跳）。
 *   这三件事都是纯算术，把它们放进组件里就没法直接断言；放在这里可以逐条测。
 *
 * 手册出处（iVMS-4200 UD02161B，第 5 章）
 *   - 时间轴表示文件时长，**不同录像类型以颜色区分**，点任意位置跳到该时刻，
 *     按钮 + **鼠标滚轮**缩放时间轴，拖动时间轴条跳到上一/下一时段（p60–66，1992–1997）。
 *   - 日历只标出「有录像的日期」，并**区分有计划录像与有事件录像**（p60，1981–1982）。
 *   - 事件回放有 `Previous Event` / `Next Event` 跳到上/下一个事件（p67–68，2209–2210）。
 *
 * 两处**我们自己定的**（手册没说，写在这里以免被当成抄来的）
 *   1. `TICK_STEPS_MS` 这张刻度表与「标签之间至少 `minLabelPx` 像素」的取舍规则，手册没有；
 *      刻度按**绝对时间**取整（epoch 对齐）也是我们的选择——手册只说时间轴可缩放。
 *   2. `zoomWindow` 的锚点语义（保持锚点时刻的像素位置不变）同样是我们的实现决定。
 */

/** 可见时间窗（毫秒，`endMs` 是开区间上界）。 */
export interface TimeWindow {
  startMs: number
  endMs: number
}

/**
 * 一段录像在时间轴上的位置（**已裁剪**到可见窗口内）。
 *
 * `clippedStart` / `clippedEnd` 存在的理由：一段录像可能比窗口还长（时间轴放大到秒级时很常见），
 * 界面要能把它画成「从左边一直延伸出去」而不是一段有头有尾的块——否则用户会以为录像在那里就结束了。
 */
export interface PlacedSegment {
  id: string
  /** 类型标识（例如 `manual` / `alarm`），渲染层按它选颜色。 */
  kind: string
  startMs: number
  endMs: number
  leftPx: number
  widthPx: number
  clippedStart: boolean
  clippedEnd: boolean
}

/** 可缩放范围的边界；`minSpanMs` 防止放大到无意义的宽度（例如 1 毫秒铺满 800 像素）。 */
export interface WindowLimits {
  minMs: number
  maxMs: number
  minSpanMs: number
}

/**
 * 刻度候选（毫秒）：1s / 2s / 5s / … / 1d。
 *
 * 取「人能读的整数」而不是任意等分：时间轴上的标签必须是 12:05:00 这种，
 * 而不是 12:03:47。这一点与趋势图的 `chooseBucketSeconds` 是同一条取向。
 */
export const MAX_TICK_STEP_MS = 86_400_000

export const TICK_STEPS_MS: readonly number[] = [
  1000, 2000, 5000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
  3_600_000, 7_200_000, 21_600_000, 43_200_000, MAX_TICK_STEP_MS
]

/** 默认的最小标签间距（像素）。标签挤在一起比没有标签更糟。 */
export const DEFAULT_MIN_LABEL_PX = 64

/** 默认最小窗口跨度：1 秒。 */
export const DEFAULT_MIN_SPAN_MS = 1000

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

/**
 * 把窗口修成合法值：`endMs > startMs`，且跨度不小于 `minSpanMs`。
 *
 * 坏窗口不抛错而是修补——它多半来自一次拖拽或滚轮的边界计算，让界面因此崩掉是不合理的。
 */
export function normaliseWindow(
  startMs: number,
  endMs: number,
  minSpanMs = DEFAULT_MIN_SPAN_MS
): TimeWindow {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { startMs: 0, endMs: Math.max(minSpanMs, DEFAULT_MIN_SPAN_MS) }
  }
  if (endMs - startMs >= minSpanMs) return { startMs, endMs }
  // 跨度不足时**保住起点**、向后撑开：拖拽过程中起点比终点更能代表用户想看的位置。
  return { startMs, endMs: startMs + Math.max(minSpanMs, DEFAULT_MIN_SPAN_MS) }
}

/** 时刻 → 像素。窗口或宽度非法时返回 0，而不是 NaN 泄进样式里。 */
export function timeToX(window: TimeWindow, width: number, ms: number): number {
  const span = window.endMs - window.startMs
  if (!isPositive(span) || !isPositive(width)) return 0
  return ((ms - window.startMs) / span) * width
}

/** 像素 → 时刻（`timeToX` 的逆）。 */
export function xToTime(window: TimeWindow, width: number, x: number): number {
  const span = window.endMs - window.startMs
  if (!isPositive(span) || !isPositive(width)) return window.startMs
  return window.startMs + (x / width) * span
}

/**
 * 把录像段摆到时间轴上：只保留与窗口相交的，并裁剪到窗口边界，按开始时间升序。
 *
 * 零长度的段会被丢弃：它画不出任何宽度，却会在命中测试里抢走一次点击。
 */
export function placeSegments(
  window: TimeWindow,
  width: number,
  segments: readonly { id: string; kind: string; startMs: number; endMs: number }[]
): PlacedSegment[] {
  const placed: PlacedSegment[] = []
  for (const segment of segments) {
    if (segment.endMs <= segment.startMs) continue
    if (segment.endMs <= window.startMs || segment.startMs >= window.endMs) continue
    const startMs = Math.max(segment.startMs, window.startMs)
    const endMs = Math.min(segment.endMs, window.endMs)
    const leftPx = timeToX(window, width, startMs)
    const rightPx = timeToX(window, width, endMs)
    placed.push({
      id: segment.id,
      kind: segment.kind,
      startMs: segment.startMs,
      endMs: segment.endMs,
      leftPx,
      widthPx: Math.max(0, rightPx - leftPx),
      clippedStart: segment.startMs < window.startMs,
      clippedEnd: segment.endMs > window.endMs
    })
  }
  return placed.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))
}

/**
 * 选刻度间隔：取「标签间距不小于 `minLabelPx`」的最小候选。
 *
 * 跨度超过候选表上限（1 天）时，按整天向上取整——**宁可标签稀疏，也不让它们重叠**；
 * 那种情况下轴上的标签就是 1 天、2 天……而不是一堆挤在一起的时刻。
 */
export function chooseTickStep(
  spanMs: number,
  width: number,
  minLabelPx: number = DEFAULT_MIN_LABEL_PX
): number {
  const gap = isPositive(minLabelPx) ? minLabelPx : DEFAULT_MIN_LABEL_PX
  // 退化输入：给最大刻度而不是 1 秒 —— 后者会在一个没有宽度的轴上排出一串重叠标签。
  if (!isPositive(spanMs) || !isPositive(width)) return MAX_TICK_STEP_MS
  const needed = (spanMs * gap) / width
  for (const step of TICK_STEPS_MS) {
    if (step >= needed) return step
  }
  // 跨度超过候选表上限（1 天）时按整天向上取整：宁可标签稀疏，也不让它们重叠。
  return Math.ceil(needed / MAX_TICK_STEP_MS) * MAX_TICK_STEP_MS
}

/**
 * 窗口内的刻度。
 *
 * 刻度按**绝对时间**（相对 epoch）对齐，而不是从窗口起点开始铺：这样拖动时间轴时标签
 * 不会跟着漂移，`12:05:00` 永远在同一处。
 */
export function ticksFor(
  window: TimeWindow,
  width: number,
  minLabelPx: number = DEFAULT_MIN_LABEL_PX
): { stepMs: number; ticks: Array<{ at: number; x: number }> } {
  const stepMs = chooseTickStep(window.endMs - window.startMs, width, minLabelPx)
  // 没有可见跨度或还没有宽度时，**一个刻度都不画**：此时所有刻度的 x 都会叠在同一个位置上，
  // 画出来只是一堆重叠的标签。返回一个「0 号刻度」比什么都不画更糟——它会把标签钉在一个
  // 与任何数据都无关的位置上。
  if (!(window.endMs > window.startMs) || !isPositive(width)) return { stepMs, ticks: [] }
  if (!isPositive(stepMs)) return { stepMs, ticks: [] }
  const first = Math.ceil(window.startMs / stepMs) * stepMs
  const ticks: Array<{ at: number; x: number }> = []
  for (let at = first; at <= window.endMs; at += stepMs) {
    ticks.push({ at, x: timeToX(window, width, at) })
  }
  return { stepMs, ticks }
}

/** 把窗口夹进可用范围：先保证跨度合法，再整体平移进边界。 */
export function clampWindow(window: TimeWindow, limits: WindowLimits): TimeWindow {
  const span = Math.max(window.endMs - window.startMs, limits.minSpanMs)
  const clampedSpan = Math.min(span, Math.max(limits.maxMs - limits.minMs, limits.minSpanMs))
  let startMs = window.startMs
  if (startMs < limits.minMs) startMs = limits.minMs
  if (startMs + clampedSpan > limits.maxMs) startMs = limits.maxMs - clampedSpan
  if (startMs < limits.minMs) startMs = limits.minMs
  return { startMs, endMs: startMs + clampedSpan }
}

/**
 * 以某个时刻为锚点缩放。`factor > 1` 放大（窗口变短），`< 1` 缩小。
 *
 * **锚点的意义**：滚轮缩放时，光标下的那个时刻必须留在光标原来的像素位置上。不这么做的话，
 * 用户每滚一格都会丢掉自己正在看的位置——这是时间轴最难用的一种毛病。
 */
export function zoomWindow(
  window: TimeWindow,
  factor: number,
  anchorMs: number,
  limits: WindowLimits
): TimeWindow {
  if (!isPositive(factor)) return clampWindow(window, limits)
  const span = window.endMs - window.startMs
  const nextSpan = span / factor
  // 锚点在窗口中的相对位置（0..1）；窗口退化时按中间处理。
  const ratio = isPositive(span) ? (anchorMs - window.startMs) / span : 0.5
  const startMs = anchorMs - ratio * nextSpan
  return clampWindow({ startMs, endMs: startMs + nextSpan }, limits)
}

/** 平移，带边界。正 `deltaMs` 表示把窗口向未来移动。 */
export function panWindow(window: TimeWindow, deltaMs: number, limits: WindowLimits): TimeWindow {
  if (!Number.isFinite(deltaMs)) return clampWindow(window, limits)
  return clampWindow(
    { startMs: window.startMs + deltaMs, endMs: window.endMs + deltaMs },
    limits
  )
}

/** 命中测试：某个像素落在哪一段录像上（落在空隙里返回 `undefined`）。 */
export function segmentAt(
  placed: readonly PlacedSegment[],
  x: number
): PlacedSegment | undefined {
  for (const segment of placed) {
    if (x >= segment.leftPx && x <= segment.leftPx + segment.widthPx) return segment
  }
  return undefined
}

/**
 * 跳到上/下一个事件（手册 p67–68 的 `Previous Event` / `Next Event`）。
 *
 * 输入是**录像段起点**的集合（在我们的数据里，一段录像就是一次事件/一条记录），
 * 输出是相对 `currentMs` 的目标时刻：
 *   - `next`：第一个严格大于 `currentMs` 的起点；
 *   - `previous`：最后一个严格小于 `currentMs` 的起点；
 *   - 没有更远的一段时返回 `undefined` —— 界面据此禁用按钮，而不是绕回第一段。
 * 去重是必需的：同一时刻可能有多段（不同通道），否则「下一个」会原地不动。
 */
export function stepEvent(
  starts: readonly number[],
  currentMs: number,
  direction: 'next' | 'previous'
): number | undefined {
  const unique = [...new Set(starts.filter((value) => Number.isFinite(value)))].sort((a, b) => a - b)
  if (direction === 'next') return unique.find((at) => at > currentMs)
  let candidate: number | undefined
  for (const at of unique) {
    if (at < currentMs) candidate = at
    else break
  }
  return candidate
}

// ---------------------------------------------------------------------------
// 「从告警前 N 秒开始播」——该跳到哪里，以及**实际**拿到了多少回退
// ---------------------------------------------------------------------------

/** `anchorSeek()` 的输入。全部是绝对或相对毫秒，不接受 Date。 */
export interface AnchorSeekInput {
  /** 锚点（通常是告警时刻）在绝对时间轴上的位置。 */
  anchorAtMs: number
  /** 这一段录音在绝对时间轴上的起点。 */
  clipStartMs: number
  /** 请求的回退量（例如手册的 30 秒）。 */
  requestedLeadMs: number
  /** 录音时长。未知时传 0（下面的夹取会退化成"从 0 开始"）。 */
  durationMs: number
}

export interface AnchorSeekResult {
  /** 应当跳到片段内的哪个位置。永远落在 `[0, max(0, durationMs - 50)]`。 */
  seekMs: number
  /** **实际**拿到的回退量（可能小于请求值，锚点落在片段之前时甚至是 0）。 */
  achievedLeadMs: number
  /** 请求值减实际值；`0` 表示请求被满足。大于 0 时界面必须把差额说出来。 */
  shortfallMs: number
}

/**
 * 计算"从锚点前 N 秒开始播"要跳到哪儿。
 *
 * 为什么这是一个独立的纯函数：它必须能**说出自己没做到**。
 * 环形缓冲区的预录时长是可配置的（`ringBufferPreSeconds`，出厂默认 10 秒），而告警详情
 * 请求的是手册里的 30 秒——于是"跳到锚点前 30 秒"经常会夹到片段开头。夹取本身是对的
 * （跳不到负时间），**但静默地夹取就是界面说假话**：操作员会以为那 20 秒只是自己没听到，
 * 而真相是那 20 秒根本没被录下来。所以这里把 `shortfallMs` 一起算出来，让它成为调用方
 * 必须处理的一个返回值，而不是一个可以被忽略的副作用。
 *
 * 末尾留 50 毫秒的余量：正好跳到 `duration` 会让元素立刻结束，看起来像"播放失败"。
 */
export function anchorSeek(input: AnchorSeekInput): AnchorSeekResult {
  const requested = Math.max(0, input.requestedLeadMs)
  const duration = Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : 0
  const upper = Math.max(0, duration - ANCHOR_END_MARGIN_MS)
  const wanted = input.anchorAtMs - input.clipStartMs - requested
  const seekMs = Math.max(0, Math.min(wanted, upper))
  const achievedLeadMs = Math.max(0, input.anchorAtMs - input.clipStartMs - seekMs)
  return {
    seekMs,
    achievedLeadMs,
    shortfallMs: Math.max(0, requested - achievedLeadMs)
  }
}

/**
 * 跳到片段末尾前留的余量。50 毫秒是"比一帧长、比人耳能分辨的间隔短"的量级。
 */
export const ANCHOR_END_MARGIN_MS = 50
