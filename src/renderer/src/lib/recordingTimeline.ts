/**
 * 把**本机录像**摆到时间轴上所需的纯计算（③b 的「时间轴回放」）。
 *
 * 与 `lib/playbackTimeline.ts` 的分工：那个模块是**几何**（时刻↔像素、刻度、缩放/平移、
 * 命中测试），这个模块是**数据**（一条录像怎么变成一段、窗口初始范围取多大）。
 * 两者都不碰 DOM，所以都能在 node 里逐条断言。
 *
 * 三处**我们自己定的**（手册没说，写在这里以免被当成抄来的）
 *   1. 没有终点也没有时长的录像，在时间轴上按 **1 秒**画（`POINT_EVENT_MS`）：
 *      0 宽度的段画不出来，也没法用鼠标点中，而"这条录像存在"这件事必须能看见。
 *   2. 初始窗口 = 所有录像的并集**左右各留 2% 余量**（`EDGE_PADDING_RATIO`）：
 *      不留给量的话第一段贴着左边缘、看起来像被裁掉了。
 *   3. 一台设备**一条录像都没有**时，窗口取"最近 1 小时"（`EMPTY_WINDOW_SPAN_MS`）：
 *      空窗口（start === end）会让刻度与缩放全部退化，页面看起来像坏了。
 */

import type { Recording } from '@shared/domain/models'
// 同目录用相对路径（仓库里 `cameraWall.ts` / `deviceTree.ts` 也是这么引 `./channelState` 的）：
// `@renderer/*` 别名只在 web 的 tsconfig 里，测试那份 tsconfig 编译这个文件时解析不到。
import type { TimeWindow, WindowLimits } from './playbackTimeline'
import { DEFAULT_MIN_SPAN_MS, normaliseWindow } from './playbackTimeline'

/** 没有终点也没有时长的录像在时间轴上的最小可见宽度（毫秒）。见文件头第 1 条。 */
export const POINT_EVENT_MS = 1000

/** 初始窗口在数据两侧各留的比例。见文件头第 2 条。 */
export const EDGE_PADDING_RATIO = 0.02

/** 一条录像都没有时的初始窗口跨度。见文件头第 3 条。 */
export const EMPTY_WINDOW_SPAN_MS = 3_600_000

/** 时间轴的一段（`playbackTimeline.placeSegments()` 的输入形状）。 */
export interface TimelineSegment {
  id: string
  /** 录像类型，渲染层按它选颜色（`manual` / `alarm` / …）。 */
  kind: string
  startMs: number
  endMs: number
}

/**
 * 一条录像的结束时刻。
 *
 * `endTime` 优先，其次 `startTime + durationMs`，两者都没有时按 `POINT_EVENT_MS` 撑开。
 * 非有限值（脏数据）一律当成"没有"，而不是让 `NaN` 传进几何计算。
 */
export function recordingEndMs(recording: Recording): number {
  const start = Number.isFinite(recording.startTime) ? recording.startTime : 0
  const end = recording.endTime
  if (typeof end === 'number' && Number.isFinite(end) && end > start) return end
  const duration = recording.durationMs
  if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
    return start + duration
  }
  return start + POINT_EVENT_MS
}

/** 把录像列表变成时间轴上的段（保持输入顺序，不排序——几何层会排序）。 */
export function recordingSegments(recordings: readonly Recording[]): TimelineSegment[] {
  return recordings.map((recording) => {
    const startMs = Number.isFinite(recording.startTime) ? recording.startTime : 0
    return {
      id: recording.id,
      kind: recording.recordingType,
      startMs,
      endMs: recordingEndMs(recording)
    }
  })
}

/** 所有录像覆盖的时间范围；没有录像时返回 `null`（调用方据此显示空态）。 */
export function recordingsExtent(
  segments: readonly TimelineSegment[]
): { startMs: number; endMs: number } | null {
  let startMs = Number.POSITIVE_INFINITY
  let endMs = Number.NEGATIVE_INFINITY
  for (const segment of segments) {
    if (!Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs)) continue
    startMs = Math.min(startMs, segment.startMs)
    endMs = Math.max(endMs, segment.endMs)
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  return { startMs, endMs }
}

/**
 * 初始可见窗口。
 *
 * @param segments 时间轴上的段（可以为空）
 * @param nowMs 现在（空态时窗口的右端）
 */
export function timelineWindow(
  segments: readonly TimelineSegment[],
  nowMs: number
): TimeWindow {
  const now = Number.isFinite(nowMs) ? nowMs : 0
  const extent = recordingsExtent(segments)
  if (!extent) {
    return normaliseWindow(now - EMPTY_WINDOW_SPAN_MS, now)
  }
  const span = Math.max(extent.endMs - extent.startMs, DEFAULT_MIN_SPAN_MS)
  const padding = span * EDGE_PADDING_RATIO
  return normaliseWindow(extent.startMs - padding, extent.endMs + padding)
}

/**
 * 可缩放/平移的范围。
 *
 * `minMs` / `maxMs` 就是数据范围（左右各留一点余量），所以拖到头就是"没有更多数据了"，
 * 而不是拖进一片空白 —— 空白时间轴会让操作员以为录像丢了。
 */
export function timelineLimits(
  segments: readonly TimelineSegment[],
  nowMs: number,
  fallbackSpanMs = EMPTY_WINDOW_SPAN_MS
): WindowLimits {
  const now = Number.isFinite(nowMs) ? nowMs : 0
  const extent = recordingsExtent(segments)
  const span = Math.max(extent ? extent.endMs - extent.startMs : fallbackSpanMs, DEFAULT_MIN_SPAN_MS)
  const padding = span * EDGE_PADDING_RATIO
  if (!extent) {
    return { minMs: now - fallbackSpanMs, maxMs: now, minSpanMs: DEFAULT_MIN_SPAN_MS }
  }
  return {
    minMs: extent.startMs - padding,
    maxMs: extent.endMs + padding,
    minSpanMs: DEFAULT_MIN_SPAN_MS
  }
}
