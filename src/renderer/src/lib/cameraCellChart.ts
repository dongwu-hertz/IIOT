/**
 * 画面格里那三种图的**纯计算**（业主 2026-09-18 第 10 批第 2 条）。
 *
 * 为什么单独一个文件：这一层的全部内容都是"一串数进、一串数出"（保留多少帧、怎么抽稀、
 * 怎么归一化、色标怎么映射），而它恰好是**唯一可以在单测里真正验证**的部分 ——
 * 现场的相机是离线的、探针里收不到任何一帧真实数据，所以"画得对不对"这件事
 * 只能靠"喂进去一串已知的数、断言吐出来的轨迹"来钉。
 *
 * 三条口径（都在 `@shared/domain/camera-cell-view.ts` 的文件头里写了理由）：
 *   · 频率轴**不编 Hz**：主进程给不出 `binHz` 时只按"第 N 根谱线"画；
 *   · 色标**不代表绝对声压级**：它只表示同一帧内谱线的相对强弱；
 *   · 时域图拼的是**固定 1 秒**（实测一帧 100 ms ⇒ 10 帧），不是"拼到满为止"。
 */

import {
  CAMERA_CELL_SPECTROGRAM_COLUMNS,
  CAMERA_CELL_SPECTRUM_BARS,
  CAMERA_CELL_SPECTRUM_ROWS,
  CAMERA_CELL_WAVEFORM_FRAMES
} from '@shared/domain/camera-cell-view'

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
 * 尺度下唯一诚实的画法（与示波器的做法一致）。
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
 * **每段的最大值**：谱线的意义在峰值，取平均会把一根尖峰抹平。
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
 */
export function spectrogramMatrix(
  frames: readonly (readonly number[])[],
  columns: number = CAMERA_CELL_SPECTROGRAM_COLUMNS,
  rows: number = CAMERA_CELL_SPECTRUM_ROWS
): Array<number[] | null> {
  const recent = frames.slice(Math.max(0, frames.length - columns))
  const out: Array<number[] | null> = []
  for (let index = 0; index < columns - recent.length; index += 1) out.push(null)
  for (const frame of recent) out.push(spectrogramColumn(frame, rows))
  return out
}

/**
 * 色标：0..1 亮度 → `rgb(...)`。
 *
 * **不是**声压级色标（手册未说明该用什么色标），是一条固定的冷→暖映射：
 * 0 = 近黑蓝、0.5 = 青绿、1 = 暖黄白。写死在这里而不是从主题变量取 —— 它要在
 * canvas 上逐像素画，读 CSS 变量每帧算一次太贵，而且这个映射是**数据可视化**的约定，
 * 与界面主题（浅色/深色）无关。
 */
export function spectrogramColor(value: number): [number, number, number] {
  const clamped = value < 0 ? 0 : value > 1 ? 1 : value
  const stops: Array<[number, [number, number, number]]> = [
    [0, [8, 14, 32]],
    [0.5, [26, 138, 140]],
    [1, [255, 236, 186]]
  ]
  for (let index = 1; index < stops.length; index += 1) {
    const [toAt, toColor] = stops[index]!
    const [fromAt, fromColor] = stops[index - 1]!
    if (clamped <= toAt) {
      const span = toAt - fromAt || 1
      const ratio = (clamped - fromAt) / span
      return [
        Math.round(fromColor[0] + (toColor[0] - fromColor[0]) * ratio),
        Math.round(fromColor[1] + (toColor[1] - fromColor[1]) * ratio),
        Math.round(fromColor[2] + (toColor[2] - fromColor[2]) * ratio)
      ]
    }
  }
  return stops[stops.length - 1]![1]
}

/**
 * 频域图的 X 轴刻度文案。
 *
 * 有 `binHz` 才写 Hz；没有就写"第 N 根谱线"（**绝不编一个采样率**，见文件头那三条口径）。
 */
export function spectrumAxisLabels(
  binCount: number,
  binHz: number | undefined,
  bars: number = CAMERA_CELL_SPECTRUM_BARS
): { left: string; right: string; unit: 'hz' | 'bin' } {
  if (typeof binHz === 'number' && Number.isFinite(binHz) && binHz > 0) {
    const topHz = binCount * binHz
    const format = (hz: number): string => (hz >= 1000 ? `${Math.round(hz / 1000)} kHz` : `${Math.round(hz)} Hz`)
    return { left: format(0), right: format(topHz), unit: 'hz' }
  }
  return { left: '0', right: `#${Math.max(0, bars)}`, unit: 'bin' }
}
