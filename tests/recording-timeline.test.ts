/**
 * ③b「时间轴回放」的数据层回归测试（`lib/recordingTimeline.ts`）。
 *
 * WHY THIS FILE EXISTS
 * 这一层把"本机录像"翻译成时间轴上的段与窗口。三种输入在真实数据里都会出现，
 * 而它们错了都不会报错，只会让画面变得奇怪：
 *   - **只有起点**的录像（设备推来的检测视频、还没收尾的片段）：按 0 宽度画就点不中，
 *     操作员会以为这条录像不存在；
 *   - **脏数据**（`NaN`、`endTime < startTime`）：`NaN` 一旦进入几何计算，
 *     整条时间轴的段会全部消失，而控制台一声不响；
 *   - **一条录像都没有**：窗口退化成 `start === end`，刻度与缩放全部失效。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import type { Recording } from '../src/shared/domain/models'
import {
  EDGE_PADDING_RATIO,
  EMPTY_WINDOW_SPAN_MS,
  POINT_EVENT_MS,
  nextSegmentStep,
  recordingEndMs,
  recordingSegments,
  recordingsExtent,
  segmentForTime,
  timelineLimits,
  timelineWindow,
  type TimelineSegment
} from '../src/renderer/src/lib/recordingTimeline'
import { placeSegments, ticksFor, zoomWindow } from '../src/renderer/src/lib/playbackTimeline'

function recording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: 'rec-1',
    deviceId: 'dev-1',
    channelId: 0,
    recordingType: 'manual',
    startTime: 1_000_000,
    endTime: 1_010_000,
    sampleRate: 48000,
    audioFormat: 'wav',
    relativePath: 'recordings/rec-1.wav',
    createdAt: 1_010_000,
    ...overrides
  }
}

describe('一条录像怎么变成时间轴上的一段', () => {
  it('有终点就用终点', () => {
    assert.equal(recordingEndMs(recording({ endTime: 1_005_000 })), 1_005_000)
  })

  it('没有终点就用起点 + 时长', () => {
    const value = recordingEndMs(recording({ endTime: undefined, durationMs: 8_000 }))
    assert.equal(value, 1_008_000)
  })

  it('两者都没有：按 1 秒画（0 宽度画不出来，也点不中）', () => {
    const value = recordingEndMs(recording({ endTime: undefined, durationMs: undefined }))
    assert.equal(value, 1_000_000 + POINT_EVENT_MS)
  })

  it('终点早于起点（脏数据）当作没有终点，而不是给出负长度', () => {
    const value = recordingEndMs(
      recording({ startTime: 1_000_000, endTime: 999_000, durationMs: undefined })
    )
    assert.equal(value, 1_000_000 + POINT_EVENT_MS)
  })

  it('NaN 不进几何：起点非有限值按 0 处理，段仍然是合法区间', () => {
    const segment = recordingSegments([
      recording({ startTime: Number.NaN, endTime: undefined, durationMs: undefined })
    ])[0]
    assert.ok(segment)
    assert.equal(segment.startMs, 0)
    assert.equal(segment.endMs, POINT_EVENT_MS)
    assert.equal(Number.isFinite(segment.endMs - segment.startMs), true)
  })

  it('类型原样带过去（渲染层按它选颜色），顺序不变', () => {
    const segments = recordingSegments([
      recording({ id: 'b', recordingType: 'alarm', startTime: 2_000 }),
      recording({ id: 'a', recordingType: 'manual', startTime: 1_000 })
    ])
    assert.deepEqual(
      segments.map((segment) => [segment.id, segment.kind]),
      [
        ['b', 'alarm'],
        ['a', 'manual']
      ]
    )
  })
})

describe('初始窗口与可拖范围', () => {
  it('没有录像：窗口是"最近 1 小时"，不是 0 宽度', () => {
    const window = timelineWindow([], 10_000_000)
    assert.equal(window.endMs - window.startMs, EMPTY_WINDOW_SPAN_MS)
    assert.equal(window.endMs, 10_000_000)
    // 0 宽度的窗口会让刻度与缩放全部退化。
    assert.equal(ticksFor(window, 800).ticks.length > 0, true)
  })

  it('有录像：窗口覆盖全部数据并左右各留 2%', () => {
    const segments = recordingSegments([
      recording({ id: 'a', startTime: 1_000_000, endTime: 1_100_000 }),
      recording({ id: 'b', startTime: 2_000_000, endTime: 2_100_000 })
    ])
    const extent = recordingsExtent(segments)
    assert.deepEqual(extent, { startMs: 1_000_000, endMs: 2_100_000 })

    const window = timelineWindow(segments, 9_999_999)
    const padding = (2_100_000 - 1_000_000) * EDGE_PADDING_RATIO
    assert.equal(Math.round(window.startMs), Math.round(1_000_000 - padding))
    assert.equal(Math.round(window.endMs), Math.round(2_100_000 + padding))
    // 两段都真的落在窗口里（而且不是贴边被裁掉）。
    const placed = placeSegments(window, 800, segments)
    assert.equal(placed.length, 2)
    for (const segment of placed) {
      assert.equal(segment.clippedStart, false)
      assert.equal(segment.clippedEnd, false)
    }
  })

  it('可拖范围就是数据范围（拖到头 = 没有更多数据，而不是一片空白）', () => {
    const segments = recordingSegments([recording({ startTime: 1_000_000, endTime: 1_100_000 })])
    const limits = timelineLimits(segments, 9_999_999)
    assert.equal(limits.minMs < 1_000_000, true)
    assert.equal(limits.maxMs > 1_100_000, true)
    // 缩放到极限也不会越出数据范围。
    const zoomed = zoomWindow(timelineWindow(segments, 0), 10_000, 1_050_000, limits)
    assert.equal(zoomed.startMs >= limits.minMs, true)
    assert.equal(zoomed.endMs <= limits.maxMs, true)
    assert.equal(limits.minSpanMs > 0, true)
  })

  it('空数据的可拖范围是最近 1 小时，右端是"现在"', () => {
    const limits = timelineLimits([], 5_000_000)
    assert.deepEqual(limits, {
      minMs: 5_000_000 - EMPTY_WINDOW_SPAN_MS,
      maxMs: 5_000_000,
      minSpanMs: limits.minSpanMs
    })
  })

  it('extent 忽略非有限值；全是脏数据时返回 null（调用方看到的是空态）', () => {
    assert.equal(
      recordingsExtent([{ id: 'x', kind: 'manual', startMs: Number.NaN, endMs: Number.NaN }]),
      null
    )
  })
})

describe('跨片段续播：当前片段之后是谁', () => {
  function segment(id: string, startMs: number, endMs: number): TimelineSegment {
    return { id, kind: 'scheduled', startMs, endMs }
  }

  it('按开始时间找下一段，背靠背时 gap 为 0', () => {
    const step = nextSegmentStep([segment('b', 20_000, 30_000), segment('a', 10_000, 20_000)], 'a')
    assert.equal(step?.next?.id, 'b')
    assert.equal(step?.gapMs, 0)
  })

  it('重叠片段给负 gap：调用方可以直接续播，不算缺口', () => {
    const step = nextSegmentStep([segment('a', 10_000, 30_000), segment('b', 20_000, 40_000)], 'a')
    assert.equal(step?.next?.id, 'b')
    assert.equal(step?.gapMs, -10_000)
  })

  it('中间断录时 gap 是正数，且如实返回具体毫秒数', () => {
    const step = nextSegmentStep([segment('a', 10_000, 20_000), segment('b', 25_000, 30_000)], 'a')
    assert.equal(step?.next?.id, 'b')
    assert.equal(step?.gapMs, 5_000)
  })

  it('最后一段：没有 next，gap 是正无穷（调用方据此说「已到末尾」）', () => {
    const step = nextSegmentStep([segment('a', 10_000, 20_000), segment('b', 20_000, 30_000)], 'b')
    assert.equal(step?.next, undefined)
    assert.equal(step?.gapMs, Number.POSITIVE_INFINITY)
  })

  it('当前 id 不在列表里：返回 undefined，不猜', () => {
    assert.equal(nextSegmentStep([segment('a', 10_000, 20_000)], 'missing'), undefined)
  })
})
describe('告警跳转：时刻 → 片段', () => {
  function segment(id: string, startMs: number, endMs: number): TimelineSegment {
    return { id, kind: 'scheduled', startMs, endMs }
  }

  it('时刻落在某段里，就返回那一段', () => {
    const found = segmentForTime([segment('a', 10_000, 20_000), segment('b', 30_000, 40_000)], 15_000)
    assert.equal(found?.id, 'a')
  })

  it('时刻落在缺口里：退到之后最近的一段，由调用方决定要不要跳缺口', () => {
    const found = segmentForTime([segment('a', 10_000, 20_000), segment('b', 30_000, 40_000)], 25_000)
    assert.equal(found?.id, 'b')
  })

  it('时刻在所有段之前：返回第一段', () => {
    const found = segmentForTime([segment('b', 20_000, 30_000), segment('a', 10_000, 20_000)], 5_000)
    assert.equal(found?.id, 'a')
  })

  it('时刻在所有段之后：返回 undefined，界面不要绕回第一段', () => {
    assert.equal(segmentForTime([segment('a', 10_000, 20_000)], 30_000), undefined)
  })

  it('非有限时刻返回 undefined', () => {
    assert.equal(segmentForTime([segment('a', 10_000, 20_000)], Number.NaN), undefined)
  })
})