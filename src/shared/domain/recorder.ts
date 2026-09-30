/**
 * 连续录像（RTSP 取流存储）的**纯**规则：切片命名、登记判据、看门狗、退避、缺口。
 *
 * WHY THIS MODULE EXISTS
 * 连续录像的风险全在"看起来在录、其实没录"这一类失败上：
 *   - ffmpeg 进程还在，但码流已经断了（进程活着、文件不长了）；
 *   - 断电/崩溃之后留下一堆没登记的片段（文件在盘上，界面里看不到）；
 *   - 一个**正在写**的片段被当成完整片段登记进库（时长、大小都是谎）；
 *   - 中间停了两小时，时间轴上却画成连续录像。
 * 所以这里把每条判据都做成纯函数 —— 主进程的录像器只是它的执行者，可以逐条单测。
 *
 * 命名与目录沿用仓库既有硬规则（`camera-nvr.ts` 的注释："时间戳在前，字典序 == 时间序，
 * 永不覆盖"）。差别只有一处：ffmpeg 的 `-strftime` **不支持毫秒**，所以片段名精确到秒，
 * 而切片最短 10 秒（`RECORDER_SEGMENT_SECONDS_MIN`）保证同一天内不会重名。
 */

/** 切片长度（秒）：默认 5 分钟，最短 10 秒、最长 1 小时（防止出现"一整天一个文件"）。 */
export const RECORDER_SEGMENT_SECONDS_DEFAULT = 300
export const RECORDER_SEGMENT_SECONDS_MIN = 10
export const RECORDER_SEGMENT_SECONDS_MAX = 3600

/**
 * 看门狗：多久没有新字节就认为这一路"卡住了"。
 *
 * 判据必须是**文件在长**，不能只看进程活着 —— 相机掉线/RTSP 被顶掉时 ffmpeg 可以
 * 挂着不退（实测里 RTSP 客户端超限、网络断开都出现过"进程在、没数据"）。
 */
export const RECORDER_STALL_MS = 20_000

/** 一个片段多久没被写过就当作已经关闭（ffmpeg 正在写的那个文件会一直长）。 */
export const RECORDER_CLOSED_GRACE_MS = 2_000

/** 断流重连退避（毫秒）；超出长度就停在最后一档。 */
export const RECORDER_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000]

/**
 * 缺口容忍：两段之间小于这个间隔不算缺口。
 *
 * 取切片长度的 **1%** 且不低于 2 秒 —— 切片边界的抖动只有几十毫秒、文件名精度是 1 秒，
 * 所以 2 秒足够吸收；**不能**取成半个切片（那会把"断了 2 分钟"藏进容忍里，
 * 而断流恰恰是这条功能最需要如实呈现的东西）。
 */
export function recorderGapToleranceMs(segmentSeconds: number): number {
  return Math.max(2_000, Math.round(normalizeSegmentSeconds(segmentSeconds) * 10))
}

/** 把外部给的切片长度收敛到合法范围；非数字/非法值回落到默认。 */
export function normalizeSegmentSeconds(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return RECORDER_SEGMENT_SECONDS_DEFAULT
  const rounded = Math.round(parsed)
  if (rounded < RECORDER_SEGMENT_SECONDS_MIN) return RECORDER_SEGMENT_SECONDS_MIN
  if (rounded > RECORDER_SEGMENT_SECONDS_MAX) return RECORDER_SEGMENT_SECONDS_MAX
  return rounded
}

// ---------------------------------------------------------------------------
// 命名
// ---------------------------------------------------------------------------

/**
 * 交给 ffmpeg `-strftime 1` 的文件名模式。
 *
 * 与 `cameraMediaStamp()` 同形（`2026-09-15_11-22-33`），只是没有毫秒 ——
 * **与解析函数是一对，改一个必须改另一个**（单测里对着这条做往返断言）。
 */
export const RECORDER_STRFTIME_PATTERN = '%Y-%m-%d_%H-%M-%S'

const SEGMENT_NAME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.mp4$/

/** 一个时刻对应的片段文件名（本地时间）。 */
export function recorderSegmentName(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (input: number): string => String(input).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.mp4`
  )
}

/**
 * 片段名 -> 起始时刻（毫秒）；不是本录像器的命名就返回 `undefined`。
 *
 * 解析用**本地时间**，与生成一致；非法日期（`2026-13-40_99-99-99.mp4`）返回 undefined
 * 而不是一个被 `Date` 悄悄纠正过的时刻 —— 后者会让一个坏文件名变成一段假录像。
 */
export function parseRecorderSegmentName(name: string): number | undefined {
  const match = SEGMENT_NAME_PATTERN.exec(name)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second] = match as unknown as string[]
  const parts = [year, month, day, hour, minute, second].map((part) => Number(part))
  const [y, mo, d, h, mi, s] = parts as [number, number, number, number, number, number]
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return undefined
  const date = new Date(y, mo - 1, d, h, mi, s, 0)
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== mo - 1 ||
    date.getDate() !== d ||
    date.getHours() !== h ||
    date.getMinutes() !== mi ||
    date.getSeconds() !== s
  ) {
    return undefined
  }
  return date.getTime()
}

/** 本地日期键 `YYYY-MM-DD`：跨天要重启 ffmpeg（片段目录按天分层）。 */
export function recorderDayKey(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (input: number): string => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 这一轮录像是否已经跨过本地零点（跨了就必须重启，否则片段会落进昨天的目录）。 */
export function recorderNeedsDayRollover(startedAtMs: number, nowMs: number): boolean {
  return recorderDayKey(startedAtMs) !== recorderDayKey(nowMs)
}

// ---------------------------------------------------------------------------
// 登记：哪些片段可以入库
// ---------------------------------------------------------------------------

export interface RecorderFileSnapshot {
  /** 文件名（只认本录像器的命名格式）。 */
  name: string
  bytes: number
  /** 最后一次写入时刻（`stat.mtimeMs`）。 */
  mtimeMs: number
}

export interface RecorderRegistration {
  name: string
  startMs: number
  endMs: number
  bytes: number
}

export interface RecorderRegisterPlan {
  /** 已经写完、可以登记的片段（按时间升序）。 */
  closed: RecorderRegistration[]
  /** 还在写的那一个（**不许登记**：时长与大小都还在变）。 */
  open: string[]
  /** 名字不合法或 0 字节 —— 记下来是为了能解释"为什么盘上有文件但库里没有"。 */
  rejected: string[]
}

export interface PlanRecorderRegistrationsInput {
  files: readonly RecorderFileSnapshot[]
  /** 已经登记过的文件名（幂等：重启后不会重复插行）。 */
  registered: readonly string[]
  nowMs: number
  segmentSeconds: number
  closedGraceMs?: number
}

/**
 * 决定这一刻该把哪些片段登记进库。
 *
 * 三条判据，缺一条都会写出假数据：
 *   1. **已关闭**：存在比它更晚的片段，或者它已经超过 `closedGraceMs` 没被写过；
 *      正在写的那个（最新的、刚写过的）只进 `open`，绝不登记。
 *   2. **非空**：0 字节文件是"什么都没录到"（相机没出流），登记它等于声称录到了。
 *   3. **名字可解析**：解析不出起始时刻的文件不是本录像器产出的（或名字被改过），
 *      宁可进 `rejected` 让人看见，也不要编一个时间。
 *
 * `endMs` 取下一段的起始时刻（切片边界就是上一段的结束），没有下一段时退到 `mtimeMs`，
 * 再不行退到 `startMs + segmentSeconds`；最终必须大于 `startMs`。
 */
export function planRecorderRegistrations(
  input: PlanRecorderRegistrationsInput
): RecorderRegisterPlan {
  const segmentSeconds = normalizeSegmentSeconds(input.segmentSeconds)
  const grace = input.closedGraceMs ?? RECORDER_CLOSED_GRACE_MS
  const known = new Set(input.registered)

  const parsed = input.files
    .map((file) => ({ file, startMs: parseRecorderSegmentName(file.name) }))
    .filter((entry): entry is { file: RecorderFileSnapshot; startMs: number } => entry.startMs !== undefined)
    .sort((left, right) => left.startMs - right.startMs)

  /** 名字不是本录像器的格式：单独列出来，不参与"已关闭/还在写"的判断。 */
  const unparsable = input.files
    .filter((file) => parseRecorderSegmentName(file.name) === undefined)
    .map((file) => file.name)

  const closed: RecorderRegistration[] = []
  const open: string[] = []
  /** 已关闭但 0 字节：什么都没录到（相机没出流），登记它就是声称录到了。 */
  const empty: string[] = []

  parsed.forEach((entry, index) => {
    const next = parsed[index + 1]
    const quiet = input.nowMs - entry.file.mtimeMs >= grace
    const isClosed = next !== undefined || quiet
    if (!isClosed) {
      if (entry.file.bytes > 0) open.push(entry.file.name)
      return
    }
    if (entry.file.bytes <= 0) {
      empty.push(entry.file.name)
      return
    }
    if (known.has(entry.file.name)) return

    const fallbackEnd = entry.startMs + segmentSeconds * 1000
    const endMs = next !== undefined ? next.startMs : Math.max(entry.file.mtimeMs, entry.startMs + 1_000)
    closed.push({
      name: entry.file.name,
      startMs: entry.startMs,
      endMs: endMs > entry.startMs ? endMs : fallbackEnd,
      bytes: entry.file.bytes
    })
  })

  return { closed, open, rejected: [...unparsable, ...empty] }
}

// ---------------------------------------------------------------------------
// 看门狗与退避
// ---------------------------------------------------------------------------

/** 这一路是否已经卡住（距上一次"文件变大"超过阈值）。 */
export function recorderStalled(input: {
  nowMs: number
  lastGrowthAtMs: number
  stallMs?: number
}): boolean {
  const stall = input.stallMs ?? RECORDER_STALL_MS
  const quiet = input.nowMs - input.lastGrowthAtMs
  // 时间倒退（时钟被校正）不算卡住：宁可晚一点重启，也不要因为一次对时而反复重启。
  if (quiet < 0) return false
  return quiet >= stall
}

/** 第 `attempt` 次重连的等待时间（0 起）；超出档位表就停在最后一档。 */
export function recorderBackoffMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) return RECORDER_BACKOFF_MS[0] as number
  const index = Math.min(Math.floor(attempt), RECORDER_BACKOFF_MS.length - 1)
  return RECORDER_BACKOFF_MS[index] as number
}

/** 这一路是否"文件在长"：与上一次采样比较，用于喂看门狗。 */
export function recorderGrowthObserved(input: {
  previousBytes: number
  currentBytes: number
}): boolean {
  return input.currentBytes > input.previousBytes
}

// ---------------------------------------------------------------------------
// 缺口（回放必须如实呈现的部分）
// ---------------------------------------------------------------------------

export interface RecorderSegmentSpan {
  startMs: number
  endMs: number
}

export interface RecorderGap {
  fromMs: number
  toMs: number
}

/**
 * 窗口内**没有被任何片段覆盖**的区间。
 *
 * 用途只有一个：时间轴上把"录像器没在录"画成空白，而不是把它画成一段不存在的录像。
 * 相机侧没有连续录像（设备事实），所以本机这些空白恰恰是最容易被误读的地方。
 */
export function recorderGapWindows(
  spans: readonly RecorderSegmentSpan[],
  window: { fromMs: number; toMs: number },
  toleranceMs?: number
): RecorderGap[] {
  const from = Math.min(window.fromMs, window.toMs)
  const to = Math.max(window.fromMs, window.toMs)
  const tolerance = toleranceMs ?? 2_000
  if (to <= from) return []

  const usable = spans
    .filter((span) => Number.isFinite(span.startMs) && Number.isFinite(span.endMs))
    .map((span) => ({
      startMs: Math.max(span.startMs, from),
      endMs: Math.min(span.endMs, to)
    }))
    .filter((span) => span.endMs > span.startMs)
    .sort((left, right) => left.startMs - right.startMs)

  const gaps: RecorderGap[] = []
  let cursor = from
  for (const span of usable) {
    if (span.startMs - cursor > tolerance) gaps.push({ fromMs: cursor, toMs: span.startMs })
    cursor = Math.max(cursor, span.endMs)
  }
  if (to - cursor > tolerance) gaps.push({ fromMs: cursor, toMs: to })
  return gaps
}
