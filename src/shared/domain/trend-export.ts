/**
 * 趋势数据的 CSV 导出（业主 2026-09-19 第 13 批第 6 条：「支持数据导出」）。
 *
 * 为什么是 CSV、又为什么在这个模块里拼
 *   · CSV 是**唯一**一个不需要任何依赖就能被 Excel / WPS / pandas 打开的格式；这一条要在
 *     离线机器上成立，所以不引任何新库、也不生成 xlsx。
 *   · 拼字符串是**纯函数**（可单测），写盘由主进程做（那一步要读回核对）。
 *
 * 两个刻意的选择，都会影响"导出来的东西能不能用"
 *
 *   1. **长表（一行一个点），不是宽表（一行一个时刻、一列一个量×通道）**。
 *      多通道叠加时，每条通道的桶边界由后端各自算，宽表会出现大量空格子，
 *      而"空格子"与"这个量在这个桶里没有读数"在下游根本分不开。长表每一行都是一个真实读数，
 *      没有这一路就**没有这一行**。
 *   2. **表头用稳定的英文键**（`spl` / `mainFrequency` …）而不是中文标签：这一份文件会被
 *      脚本、被别的语言的操作员打开；界面上的中文标签是**展示**，而文件里的列名是**契约**。
 *      单位另起一列（`unit`），这样同一列里不会混着 dB 与无量纲比值。
 *
 * Excel 需要 UTF-8 BOM 才认得出中文（通道名、设备名可能是中文）：没有 BOM 时它按本地代码页
 * 解码，一列中文会变成乱码 —— 而"导出的文件打开是乱码"是最容易被当成"软件坏了"的一类问题。
 */

import type { TrendMetric } from './trend'

/** 一行导出数据（**已经**按量/通道摊平的那一种）。 */
export interface TrendExportRow {
  /** 这个时间桶的起点，epoch 毫秒。 */
  timestamp: number
  metric: TrendMetric
  /** 0 基的通道号（与界面上的 CH1 = 0 一致）。 */
  channel: number
  /** 设备报的通道名，没有就是空串。 */
  channelName: string
  /** 这个桶里的值（`NaN` = 设备没有上报这一段，**不会**出现在导出里，见下）。 */
  value: number
  /** 参与这个桶的原始行数。 */
  sampleCount: number
  /** 这个量的单位（`dB` / `Hz` / 空串 = 无量纲比值）。 */
  unit: string
}

/** 表头。列的顺序就是这里的顺序（多一列少一列都会让下游脚本错位）。 */
export const TREND_CSV_HEADER = [
  'timestamp_iso',
  'timestamp_ms',
  'metric',
  'channel',
  'channel_name',
  'value',
  'unit',
  'sample_count'
] as const

/** UTF-8 BOM：Excel 靠它认出 UTF-8（见文件头）。 */
export const TREND_CSV_BOM = '\uFEFF'

/**
 * 一个 CSV 字段。
 *
 * 规则就是 RFC 4180 那一条：**含逗号、引号、换行（或首尾空白）时**用双引号包起来，
 * 内部的引号写两遍。不这么做的话，一个叫 `1#机组, 东侧` 的通道名会把整行的列数弄错
 * —— 而 Excel 不会报错，它只会把数据错位塞进后面的列里。
 */
export function csvField(value: string | number): string {
  const text = typeof value === 'number' ? String(value) : value
  const needsQuotes = /[",\r\n]/.test(text) || text !== text.trim()
  if (!needsQuotes) return text
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * 把摊平后的读数拼成一份 CSV（含 BOM）。
 *
 * `NaN` / 无穷值的行会被**跳过**：CSV 里没有"空桶"这个概念（写 `NaN` 会被 Excel 当成文本，
 * 写 0 则是撒谎）。跳过的行数由调用方在读回之后核对（导出结果里带 `rows`）。
 */
export function buildTrendCsv(rows: readonly TrendExportRow[]): string {
  const lines: string[] = [TREND_CSV_HEADER.join(',')]
  for (const row of rows) {
    if (!Number.isFinite(row.value)) continue
    lines.push(
      [
        csvField(new Date(row.timestamp).toISOString()),
        csvField(row.timestamp),
        csvField(row.metric),
        csvField(row.channel),
        csvField(row.channelName),
        csvField(row.value),
        csvField(row.unit),
        csvField(row.sampleCount)
      ].join(',')
    )
  }
  // 行尾用 `\r\n`：Excel 与 Windows 上的记事本都认它，而 `\n` 在某些 Excel 版本里
  // 会让整份文件挤成一行。
  return TREND_CSV_BOM + lines.join('\r\n') + '\r\n'
}

/**
 * 导出文件名：`trend-<设备名>-<起>-<止>.csv`。
 *
 * 文件名里放**设备与时间范围**：一份导出文件离开这个界面之后，唯一还能说明"这是什么"的东西
 * 就是它的名字。非法字符（Windows 的 `\ / : * ? " < > |` 与控制字符）替换成 `_`，
 * 连续空白收成一个 `_`，并限长（有些文件系统对单段名有 255 字节的限制，中文按 3 字节算）。
 */
export function trendCsvFileName(input: {
  deviceName: string
  from: number
  to: number
}): string {
  const safeName = sanitiseFileSegment(input.deviceName)
  const from = stampForFileName(input.from)
  const to = stampForFileName(input.to)
  return `trend-${safeName}-${from}-${to}.csv`
}

/** `2026-09-19T0730` — 文件名里用不了冒号（Windows 保留字符）。 */
export function stampForFileName(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return 'unknown'
  const date = new Date(timestamp)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}`
  )
}

/** 一段安全的文件名片段（空串时给 `device`，否则会出现 `trend--2026…` 这种名字）。 */
export function sanitiseFileSegment(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 60)
  return cleaned === '' ? 'device' : cleaned
}

// ---------------------------------------------------------------------------
// IPC 契约（渲染层 → 主进程）
// ---------------------------------------------------------------------------

/** 渲染层交出来的东西：一段**文件名**与整份 CSV 文本。 */
export interface TrendExportRequest {
  /**
   * 只允许是一段文件名（不含 `/` 或 `\`）。
   *
   * 真正的目录由主进程决定（存储根下的 `exports/trends/`）：把路径交给渲染层，
   * 就等于把"往任意位置写文件"的能力交给了一个只该显示数据的进程。
   */
  fileName: string
  /** CSV 全文（含 BOM），由 `buildTrendCsv()` 生成。 */
  csv: string
}

/** 写回的结果：**读回核对之后**的路径、字节数与数据行数。 */
export interface TrendExportResult {
  /** 绝对路径（界面上要显示出来 —— "导出到哪儿了"是这一条最常见的追问）。 */
  path: string
  /** 落盘后的字节数（读回 `stat` 得到，不是 `csv.length`）。 */
  bytes: number
  /** 数据行数（不含表头），从**读回的文件**里数出来的。 */
  rows: number
}
