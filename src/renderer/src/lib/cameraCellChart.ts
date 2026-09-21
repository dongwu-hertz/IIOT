/**
 * 画面格里那三种图的**纯计算**（业主 2026-09-18 第 10 批第 2 条；2026-09-21 第 5 批
 * 按分析工作台的设计稿升级三种图的画法）。
 *
 * 为什么单独一个文件：这一层的全部内容都是"一串数进、一串数出"（保留多少帧、怎么抽稀、
 * 怎么归一化、色标怎么映射、刻度怎么选），而它恰好是**唯一可以在单测里真正验证**的部分 ——
 * 现场的相机是离线的、探针里收不到任何一帧真实数据，所以"画得对不对"这件事
 * 只能靠"喂进去一串已知的数、断言吐出来的轨迹"来钉。
 *
 * 三条口径（都在 `@shared/domain/camera-cell-view.ts` 的文件头里写了理由）：
 *   · 频率轴**不编 Hz**：主进程给不出 `binHz` 时只按"第 N 根谱线"画；
 *   · 色标**不代表绝对声压级**：它只表示同一帧内谱线的相对强弱；
 *   · 时域图拼的是**固定 1 秒**（实测一帧 100 ms ⇒ 10 帧），不是"拼到满为止"。
 *
 * 第 5 批新增的一条：频率轴的**上限**。业主原话「Y轴是频率上限，最大是 100kHz」——
 * 有 `binHz` 时频域图/时频谱图都只画到 `min(binHz × binCount, SPECTRUM_MAX_HZ)`，
 * 时频谱图只保留 ≤100kHz 的那些 bin 参与抽稀。
 */

import {
  CAMERA_CELL_SPECTROGRAM_COLUMNS,
  CAMERA_CELL_SPECTRUM_BARS,
  CAMERA_CELL_SPECTRUM_ROWS,
  CAMERA_CELL_WAVEFORM_FRAMES
} from '@shared/domain/camera-cell-view'

/**
 * 频率轴的上限（业主 2026-09-21 第 5 条：「Y轴是频率上限，最大是 100kHz」）。
 *
 * 有 `binHz` 时，频域图与时频谱图的频率上限 = `min(binHz × binCount, SPECTRUM_MAX_HZ)`；
 * 设备报告的频宽超过 100kHz 也只画到 100kHz。
 */
export const SPECTRUM_MAX_HZ = 100_000

/** 把一帧压进数组并保留最后 `limit` 个（环形缓冲的最简形式）。 */
export function pushCapped<T>(list: T[], item: T, limit: number): T[] {
  const next = list.length >= limit ? list.slice(list.length - limit + 1) : [...list]
  next.push(item)
  return next
}

/**
 * 时域图的一串采样点。
 *
 * 输入是若干帧「抽稀后的有符号包络」（`Fa371PcmPreview.waveform`，主进程已经保留极值），
 * 输出把它们按时间顺序接起来。**接起来**而不是叠加：1 秒时域图要的是连续波形，
 * 叠起来会得到一个谁都不认识的图。
 */
export function concatWaveform(envelopes: readonly (readonly number[])[]): number[] {
  const out: number[] = []
  for (const envelope of envelopes) for (const value of envelope) out.push(value)
  return out
}

/**
 * 把一串采样点压成 `columns` 根**竖线**（每根一个 [min, max]）。
 *
 * 为什么不是"每列取一个点"：时域波形在这种宽度下（一格里几百像素、几千个采样点）
 * 逐点连线会丢掉峰值，而看波形的人要的正是"有没有毛刺/削顶"。取每列的极值是这个
 * 尺度下唯一诚实的画法（与示波器的做法一致）。升级成折线 + 填充后，上下两条极值线
 * 仍然是"这一列真实到达过的范围"，不丢峰。
 */
export function waveformColumns(
  samples: readonly number[],
  columns: number
): Array<{ min: number; max: number }> {
  if (columns <= 0) return []
  if (samples.length === 0) return Array.from({ length: columns }, () => ({ min: 0, max: 0 }))
  const out: Array<{ min: number; max: number }> = []
  for (let column = 0; column < columns; column += 1) {
    const from = Math.floor((column * samples.length) / columns)
    const to = Math.max(from + 1, Math.floor(((column + 1) * samples.length) / columns))
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (let index = from; index < to && index < samples.length; index += 1) {
      const value = samples[index] ?? 0
      if (value < min) min = value
      if (value > max) max = value
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0
      max = 0
    }
    out.push({ min, max })
  }
  return out
}

/**
 * 一次时域图要画的帧：**恰好 1 秒**那么多帧（不够就有多少画多少）。
 *
 * 不够 1 秒时**不重复填充**：把不足的一秒画成"不足的一秒"，比把同一段波形复制十遍
 * 假装满一秒诚实得多。
 */
export function waveformFrames<T>(frames: readonly T[]): T[] {
  return frames.slice(Math.max(0, frames.length - CAMERA_CELL_WAVEFORM_FRAMES))
}

/**
 * 把一帧谱线抽稀成 `bars` 根柱子。
 *
 * `bins` 的长度由设备决定（实测 512/1024 都见过），而一格只有几十像素宽 —— 抽稀取
 * **每段的最大值**：谱线的意义在峰值，取平均会把一根尖峰抹平。频域图升级成折线后
 * 仍走这里：折线的每个点还是"这一段里最高的那根谱线"。
 */
export function spectrumBars(
  bins: readonly number[],
  bars: number = CAMERA_CELL_SPECTRUM_BARS
): number[] {
  if (bars <= 0) return []
  if (bins.length === 0) return Array.from({ length: bars }, () => 0)
  const out: number[] = []
  for (let bar = 0; bar < bars; bar += 1) {
    const from = Math.floor((bar * bins.length) / bars)
    const to = Math.max(from + 1, Math.floor(((bar + 1) * bins.length) / bars))
    let peak = Number.NEGATIVE_INFINITY
    for (let index = from; index < to && index < bins.length; index += 1) {
      const value = bins[index]
      if (typeof value === 'number' && value > peak) peak = value
    }
    out.push(Number.isFinite(peak) ? peak : 0)
  }
  return out
}

/**
 * 归一化到 0..1。
 *
 * `floor` 是"最弱的那一档"：把最小值当 0 会让每一帧看起来都是满谱（因为帧内的相对差
 * 总在）。业界常用的做法是给一个**绝对下界**（这里是 0，谱线是 int16 计数），
 * 而"帧内最大值"这个上界意味着**同一帧内**的相对强弱 —— 这正是我们写进界面说明的那句话。
 */
export function normalise(values: readonly number[], floor = 0): number[] {
  let max = Number.NEGATIVE_INFINITY
  for (const value of values) if (Number.isFinite(value) && value > max) max = value
  if (!Number.isFinite(max) || max <= floor) return values.map(() => 0)
  return values.map((value) => {
    if (!Number.isFinite(value)) return 0
    const ratio = (value - floor) / (max - floor)
    return ratio < 0 ? 0 : ratio > 1 ? 1 : ratio
  })
}

/**
 * 频域图/时频谱图的频率上限（Hz）。
 *
 * 有 `binHz` 时 = `min(binHz × binCount, SPECTRUM_MAX_HZ)`；设备不报告采样率
 * （`binHz` 缺失/非法）时返回 `null` —— 调用方必须退回"第 N 根谱线"的画法，
 * **绝不编一个 Hz 轴**。
 */
export function spectrumMaxHz(binCount: number, binHz: number | undefined): number | null {
  if (typeof binHz !== 'number' || !Number.isFinite(binHz) || binHz <= 0) return null
  return Math.min(binCount * binHz, SPECTRUM_MAX_HZ)
}

/**
 * 一根频率刻度文案（kHz 为主；1 kHz 以下退回 Hz，0 只写 "0"）。
 *
 * 量级规则（业主 2026-09-21 第 5 批）：≥10kHz 取整到 kHz，否则保留 1 位小数。
 */
export function formatFrequencyTick(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '0'
  if (hz >= 10_000) return `${Math.round(hz / 1000)} kHz`
  if (hz >= 1_000) return `${(hz / 1000).toFixed(1)} kHz`
  return `${Math.round(hz)} Hz`
}

/**
 * 一根频率轴上的刻度值（Hz）：1/2/5×10^n 的"好看步长"，最多 `maxTicks` 个，
 * **首尾固定是 0 与上限**（上限本身不一定是好看数，比如 96kHz —— 末尾那根就标 96）。
 *
 * 只看相对位置的人需要的是"中间还有一道杠"，而不是被四舍五入的上限。
 */
export function frequencyTicks(maxHz: number, maxTicks = 4): number[] {
  if (!Number.isFinite(maxHz) || maxHz <= 0) return [0]
  const top = Math.min(maxHz, SPECTRUM_MAX_HZ)
  if (top <= 0) return [0]
  // 步长目标：让 0..top 恰好落进 maxTicks 个刻度里；取不小于目标的最小 1/2/5×10^n。
  const target = top / Math.max(1, maxTicks - 1)
  const power = 10 ** Math.floor(Math.log10(target))
  let step = power * 10
  for (const mantissa of [1, 2, 5, 10]) {
    const candidate = mantissa * power
    if (candidate + 1e-9 >= target) {
      step = candidate
      break
    }
  }
  const ticks: number[] = [0]
  for (let hz = step; hz < top - 1e-9; hz += step) {
    ticks.push(Math.round(hz))
    if (ticks.length >= 64) break
  }
  const roundedTop = Math.round(top)
  if (ticks[ticks.length - 1] !== roundedTop) ticks.push(roundedTop)
  return ticks
}

/** 一根频率轴刻度：`frac` 是它在轴上的位置（0 = 下端/左端，1 = 上端/右端）。 */
export interface FrequencyTick {
  frac: number
  label: string
}

/**
 * 频率轴刻度（带位置与文案）。
 *
 * `maxHz` 为 `null`（没有 `binHz`）时返回 `null`：调用方退回"第 N 根"的画法，
 * 这个函数**不替它编频率**。
 */
export function frequencyAxisTicks(maxHz: number | null, maxTicks = 4): FrequencyTick[] | null {
  if (maxHz === null) return null
  const top = Math.min(maxHz, SPECTRUM_MAX_HZ)
  return frequencyTicks(top, maxTicks).map((hz) => ({ frac: top > 0 ? hz / top : 0, label: formatFrequencyTick(hz) }))
}

/**
 * 时频谱图没有 `binHz` 时的 Y 轴刻度（诚实降级）：**行号**。
 *
 * 第 0 行是低频（画在最下面），所以 0 在下、`rows - 1` 在上。
 */
export function spectrogramRowTicks(rows: number, maxTicks = 4): FrequencyTick[] {
  if (rows <= 0) return []
  const count = Math.min(maxTicks, rows)
  const out: FrequencyTick[] = []
  for (let index = 0; index < count; index += 1) {
    const row = Math.round((index * (rows - 1)) / Math.max(1, count - 1))
    out.push({ frac: rows > 1 ? row / (rows - 1) : 0, label: `#${row}` })
  }
  return out
}

/**
 * 只保留频率 ≤ `SPECTRUM_MAX_HZ` 的那些 bin（业主：频率上限最大 100kHz）。
 *
 * 没有合法 `binHz` 时原样返回（无从取舍）；`binHz > 100kHz` 这种极端情形至少留 1 根，
 * 画面上还有东西可画。
 */
export function binsWithinMaxHz(bins: readonly number[], binHz: number | undefined): readonly number[] {
  if (typeof binHz !== 'number' || !Number.isFinite(binHz) || binHz <= 0) return bins
  const count = Math.max(1, Math.min(bins.length, Math.floor(SPECTRUM_MAX_HZ / binHz) + 1))
  return bins.slice(0, count)
}

/**
 * 时频谱图的一列：把一帧谱线抽稀成 `rows` 行并归一化。
 *
 * 第 0 行是**低频**（画的时候从下往上，与频谱图的惯例一致：低频在下）。
 */
export function spectrogramColumn(
  bins: readonly number[],
  rows: number = CAMERA_CELL_SPECTRUM_ROWS
): number[] {
  return normalise(spectrumBars(bins, rows))
}

/**
 * 时频谱图的矩阵：`columns` 列 × `rows` 行，**最后一列是最新的一帧**。
 *
 * 不够列数时**左对齐补空列**（`null` = 那一列没有数据）：把历史挤到右边会在第一帧
 * 出现时就画出一条斜线，看起来像是设备在扫频。
 *
 * `binHz` 合法时，每列先只保留 ≤ `SPECTRUM_MAX_HZ` 的 bin 再抽稀（频率上限 100kHz，
 * 见 `SPECTRUM_MAX_HZ`）；缺省/不合法时整帧参与（无从知道频率，也就无从取舍）。
 */
export function spectrogramMatrix(
  frames: readonly (readonly number[])[],
  columns: number = CAMERA_CELL_SPECTROGRAM_COLUMNS,
  rows: number = CAMERA_CELL_SPECTRUM_ROWS,
  binHz?: number
): Array<number[] | null> {
  const recent = frames.slice(Math.max(0, frames.length - columns))
  const out: Array<number[] | null> = []
  for (let index = 0; index < columns - recent.length; index += 1) out.push(null)
  for (const frame of recent) out.push(spectrogramColumn(binsWithinMaxHz(frame, binHz), rows))
  return out
}

/**
 * 时频谱图的**红外热力色板**（业主 2026-09-21 第 5 批，对齐分析工作台设计稿的
 * visualMap inRange）：蓝 → 青 → 绿 → 黄 → 橙 → 红，共 11 档。
 *
 * **不是**声压级色标（手册未说明该用什么色标）：0..1 的帧内相对亮度**逐档索引**
 * 映射到这 11 档颜色（不做档间渐变，与设计稿一致）。写死在这里而不是从主题变量取 ——
 * 它要在 canvas 上逐像素画，读 CSS 变量每帧算一次太贵，而且这个映射是**数据可视化**
 * 的约定，与界面主题（浅色/深色）无关。
 */
export const SPECTROGRAM_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [16, 42, 131], // #102a83
  [15, 75, 216], // #0f4bd8
  [15, 134, 232], // #0f86e8
  [15, 185, 232], // #0fb9e8
  [25, 212, 192], // #19d4c0
  [62, 224, 140], // #3ee08c
  [140, 232, 74], // #8ce84a
  [232, 227, 63], // #e8e33f
  [245, 166, 35], // #f5a623
  [242, 92, 25], // #f25c19
  [214, 32, 31] // #d6201f
]

/**
 * 色标：0..1 亮度 → `rgb(...)`（红外热力色板的逐档索引映射，见 `SPECTROGRAM_PALETTE`）。
 *
 * **不代表绝对声压级**，只表示同一帧内谱线的相对强弱（界面有一句说明）。
 */
export function spectrogramColor(value: number): [number, number, number] {
  const clamped = value < 0 ? 0 : value > 1 ? 1 : value
  const index = Math.round(clamped * (SPECTROGRAM_PALETTE.length - 1))
  const color = SPECTROGRAM_PALETTE[index]!
  return [color[0], color[1], color[2]]
}

/**
 * 频域图右下角那个轴的范围文案（没有 `binHz` 时画在图上，见组件）。
 *
 * 有 `binHz` 才写 Hz（上限 = `min(binHz × binCount, SPECTRUM_MAX_HZ)`，超过 100kHz
 * 也只标到 100kHz）；没有就写"第 N 根谱线"（**绝不编一个采样率**，见文件头那三条口径）。
 */
export function spectrumAxisLabels(
  binCount: number,
  binHz: number | undefined,
  bars: number = CAMERA_CELL_SPECTRUM_BARS
): { left: string; right: string; unit: 'hz' | 'bin' } {
  const topHz = spectrumMaxHz(binCount, binHz)
  if (topHz !== null) {
    return { left: '0', right: formatFrequencyTick(topHz), unit: 'hz' }
  }
  return { left: '0', right: `#${Math.max(0, bars)}`, unit: 'bin' }
}
