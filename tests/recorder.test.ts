/**
 * ⑩ 连续录像（RTSP 取流存储）纯规则的回归测试（`shared/domain/recorder.ts`）。
 *
 * WHY THIS FILE EXISTS
 * 连续录像最危险的失败不是"录不上"，而是**库里写着录上了**：
 *   - 正在写的那个片段被当完整片段登记（时长、大小都是谎）；
 *   - 0 字节文件（相机没出流）被登记成一段录像；
 *   - 进程还活着但码流早断了，看门狗只看"进程在不在"就永远不会重启；
 *   - 中间停了两小时，时间轴画成连续。
 * 这里逐条钉住这些判据，主进程的录像器只是它们的执行者。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  RECORDER_BACKOFF_MS,
  RECORDER_CLOSED_GRACE_MS,
  RECORDER_SEGMENT_SECONDS_DEFAULT,
  RECORDER_SEGMENT_SECONDS_MAX,
  RECORDER_SEGMENT_SECONDS_MIN,
  RECORDER_STALL_MS,
  RECORDER_STRFTIME_PATTERN,
  normalizeSegmentSeconds,
  parseRecorderSegmentName,
  planRecorderRegistrations,
  recorderBackoffMs,
  recorderDayKey,
  recorderGapToleranceMs,
  recorderGapWindows,
  recorderGrowthObserved,
  recorderNeedsDayRollover,
  recorderSegmentName,
  recorderStalled
} from '../src/shared/domain/recorder'

/** 构造一个"某个整秒"的时刻（本地时间），与片段名的精度一致。 */
function at(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime()
}

describe('连续录像：切片长度', () => {
  it('非法值回落到默认，合法值被夹在 [min, max]', () => {
    assert.equal(normalizeSegmentSeconds(undefined), RECORDER_SEGMENT_SECONDS_DEFAULT)
    assert.equal(normalizeSegmentSeconds(Number.NaN), RECORDER_SEGMENT_SECONDS_DEFAULT)
    assert.equal(normalizeSegmentSeconds('600'), 600)
    assert.equal(normalizeSegmentSeconds(1), RECORDER_SEGMENT_SECONDS_MIN)
    assert.equal(normalizeSegmentSeconds(999_999), RECORDER_SEGMENT_SECONDS_MAX)
  })

  it('缺口容忍随切片长度走，且有下限（切片边界本来就有几十毫秒）', () => {
    assert.equal(recorderGapToleranceMs(300), 3_000)
    assert.equal(recorderGapToleranceMs(1), 2_000, '切片被夹到最短 10 秒后仍取 2 秒下限')
    // 容忍必须远小于切片，否则"断了 2 分钟"会被藏进容忍里。
    assert.ok(recorderGapToleranceMs(300) < 300 * 1_000 * 0.05)
  })
})

describe('连续录像：片段命名', () => {
  it('文件名与 ffmpeg 的 -strftime 模式是一对（往返必须相等）', () => {
    const stamp = at(2026, 9, 26, 8, 15, 30)
    assert.equal(recorderSegmentName(stamp), '2026-09-26_08-15-30.mp4')
    assert.equal(parseRecorderSegmentName(recorderSegmentName(stamp)), stamp)
    // 模式里的字段顺序与文件名一致：谁改了一边，这条就会红。
    assert.equal(RECORDER_STRFTIME_PATTERN, '%Y-%m-%d_%H-%M-%S')
  })

  it('字典序 == 时间序（与既有硬规则一致）', () => {
    const names = [
      recorderSegmentName(at(2026, 9, 26, 8, 15, 30)),
      recorderSegmentName(at(2026, 9, 26, 8, 5, 0)),
      recorderSegmentName(at(2026, 10, 1, 0, 0, 0))
    ]
    assert.deepEqual([...names].sort(), [
      '2026-09-26_08-05-00.mp4',
      '2026-09-26_08-15-30.mp4',
      '2026-10-01_00-00-00.mp4'
    ])
  })

  it('不是本录像器的命名 / 非法日期 -> undefined（不编时间）', () => {
    assert.equal(parseRecorderSegmentName('2026-09-26_08-15-30-123.mp4'), undefined, '带毫秒的是手动录像')
    assert.equal(parseRecorderSegmentName('random.mp4'), undefined)
    assert.equal(parseRecorderSegmentName('2026-13-40_99-99-99.mp4'), undefined)
    assert.equal(parseRecorderSegmentName('2026-02-30_10-00-00.mp4'), undefined, '2 月 30 日不存在')
  })

  it('跨天要重启（片段目录按天分层，不重启就会落进昨天的目录）', () => {
    const beforeMidnight = at(2026, 9, 26, 23, 59, 0)
    const afterMidnight = at(2026, 9, 27, 0, 1, 0)
    assert.equal(recorderDayKey(beforeMidnight), '2026-09-26')
    assert.equal(recorderNeedsDayRollover(beforeMidnight, afterMidnight), true)
    // 还在同一天内（23:59:00 -> 23:59:30）不该重启。
    assert.equal(recorderNeedsDayRollover(beforeMidnight, beforeMidnight + 30_000), false)
  })
})

describe('连续录像：哪些片段可以登记', () => {
  const base = { registered: [] as string[], segmentSeconds: 300 }

  it('正在写的那个片段不许登记（时长与大小都还在变）', () => {
    const now = at(2026, 9, 26, 8, 5, 10)
    const plan = planRecorderRegistrations({
      ...base,
      nowMs: now,
      files: [
        { name: '2026-09-26_08-00-00.mp4', bytes: 1_000, mtimeMs: now - 300_000 },
        { name: '2026-09-26_08-05-00.mp4', bytes: 200, mtimeMs: now - 1_000 }
      ]
    })
    assert.deepEqual(
      plan.closed.map((entry) => entry.name),
      ['2026-09-26_08-00-00.mp4']
    )
    assert.deepEqual(plan.open, ['2026-09-26_08-05-00.mp4'])
  })

  it('结束时刻取下一段的起始（切片边界就是上一段的结束）', () => {
    const now = at(2026, 9, 26, 8, 10, 0)
    const plan = planRecorderRegistrations({
      ...base,
      nowMs: now,
      files: [
        { name: '2026-09-26_08-00-00.mp4', bytes: 1_000, mtimeMs: now - 600_000 },
        { name: '2026-09-26_08-05-00.mp4', bytes: 1_000, mtimeMs: now - 300_000 },
        { name: '2026-09-26_08-10-00.mp4', bytes: 100, mtimeMs: now }
      ]
    })
    assert.deepEqual(plan.closed, [
      {
        name: '2026-09-26_08-00-00.mp4',
        startMs: at(2026, 9, 26, 8, 0, 0),
        endMs: at(2026, 9, 26, 8, 5, 0),
        bytes: 1_000
      },
      {
        name: '2026-09-26_08-05-00.mp4',
        startMs: at(2026, 9, 26, 8, 5, 0),
        endMs: at(2026, 9, 26, 8, 10, 0),
        bytes: 1_000
      }
    ])
  })

  it('最后一个片段：安静超过宽限期就用它的最后写入时刻收尾（掉线时这是实话）', () => {
    const start = at(2026, 9, 26, 8, 0, 0)
    const lastWrite = start + 42_000
    const now = lastWrite + RECORDER_CLOSED_GRACE_MS + 1
    const plan = planRecorderRegistrations({
      ...base,
      nowMs: now,
      files: [{ name: '2026-09-26_08-00-00.mp4', bytes: 5_000, mtimeMs: lastWrite }]
    })
    assert.equal(plan.closed.length, 1)
    assert.equal(plan.closed[0]?.endMs, lastWrite, '掉线后不该声称录满整个切片')
    assert.deepEqual(plan.open, [])
  })

  it('0 字节已关闭文件进 rejected，不登记（相机没出流 ≠ 录到一段空的）', () => {
    const start = at(2026, 9, 26, 8, 0, 0)
    const now = start + 600_000
    const plan = planRecorderRegistrations({
      ...base,
      nowMs: now,
      files: [
        { name: '2026-09-26_08-00-00.mp4', bytes: 0, mtimeMs: start + 1_000 },
        { name: '2026-09-26_08-05-00.mp4', bytes: 1_000, mtimeMs: now - 400_000 }
      ]
    })
    assert.deepEqual(plan.closed.map((entry) => entry.name), ['2026-09-26_08-05-00.mp4'])
    assert.deepEqual(plan.rejected, ['2026-09-26_08-00-00.mp4'])
  })

  it('已经登记过的不再登记（重启/反复扫盘都幂等）', () => {
    const start = at(2026, 9, 26, 8, 0, 0)
    const now = start + 900_000
    const plan = planRecorderRegistrations({
      ...base,
      registered: ['2026-09-26_08-00-00.mp4'],
      nowMs: now,
      files: [
        { name: '2026-09-26_08-00-00.mp4', bytes: 1_000, mtimeMs: start + 300_000 },
        { name: '2026-09-26_08-05-00.mp4', bytes: 1_000, mtimeMs: start + 600_000 }
      ]
    })
    assert.deepEqual(plan.closed.map((entry) => entry.name), ['2026-09-26_08-05-00.mp4'])
  })

  it('名字不合规的文件进 rejected，不参与登记（不编时间）', () => {
    const now = at(2026, 9, 26, 9, 0, 0)
    const plan = planRecorderRegistrations({
      ...base,
      nowMs: now,
      files: [{ name: 'manual-2026-09-26_08-15-30-123.mp4', bytes: 1_000, mtimeMs: now - 600_000 }]
    })
    assert.equal(plan.closed.length, 0)
    assert.deepEqual(plan.rejected, ['manual-2026-09-26_08-15-30-123.mp4'])
    // 名字不合规的文件既不是"还在写"，也不该出现在 open 里（它根本不归录像器管）。
    assert.deepEqual(plan.open, [])
  })
})

describe('连续录像：看门狗与退避', () => {
  it('进程活着但文件不长了 = 卡住（这条才是真正要抓的）', () => {
    const now = 1_000_000
    assert.equal(recorderStalled({ nowMs: now, lastGrowthAtMs: now - RECORDER_STALL_MS + 1 }), false)
    assert.equal(recorderStalled({ nowMs: now, lastGrowthAtMs: now - RECORDER_STALL_MS }), true)
  })

  it('时间倒退（时钟被校正）不算卡住，避免反复重启', () => {
    assert.equal(recorderStalled({ nowMs: 1_000, lastGrowthAtMs: 5_000 }), false)
  })

  it('"文件在长"的判据是字节变多，不是 mtime 变新', () => {
    assert.equal(recorderGrowthObserved({ previousBytes: 100, currentBytes: 101 }), true)
    assert.equal(recorderGrowthObserved({ previousBytes: 100, currentBytes: 100 }), false)
    // 变小只可能来自截断/替换：不算"在长"（下一轮采样会把它当新文件处理）。
    assert.equal(recorderGrowthObserved({ previousBytes: 100, currentBytes: 10 }), false)
  })

  it('退避逐档上升并封顶', () => {
    assert.equal(recorderBackoffMs(0), RECORDER_BACKOFF_MS[0])
    assert.equal(recorderBackoffMs(1), RECORDER_BACKOFF_MS[1])
    assert.equal(recorderBackoffMs(99), RECORDER_BACKOFF_MS[RECORDER_BACKOFF_MS.length - 1])
  })
})

describe('连续录像：缺口（回放必须如实呈现）', () => {
  const window = { fromMs: 0, toMs: 600_000 }

  it('片段覆盖不到的地方就是缺口', () => {
    const gaps = recorderGapWindows(
      [
        { startMs: 0, endMs: 100_000 },
        { startMs: 100_000, endMs: 200_000 },
        { startMs: 400_000, endMs: 600_000 }
      ],
      window,
      2_000
    )
    assert.deepEqual(gaps, [{ fromMs: 200_000, toMs: 400_000 }])
  })

  it('起止两端没录像也算缺口（不是"从第一段开始"）', () => {
    const gaps = recorderGapWindows([{ startMs: 200_000, endMs: 300_000 }], window, 2_000)
    assert.deepEqual(gaps, [
      { fromMs: 0, toMs: 200_000 },
      { fromMs: 300_000, toMs: 600_000 }
    ])
  })

  it('小于容忍的缝不算缺口（切片边界本来就有几十毫秒）', () => {
    const gaps = recorderGapWindows(
      [
        { startMs: 0, endMs: 100_000 },
        { startMs: 100_500, endMs: 200_000 }
      ],
      window,
      2_000
    )
    assert.deepEqual(gaps, [{ fromMs: 200_000, toMs: 600_000 }])
  })

  it('没有任何片段 = 整窗都是缺口（不许画成"有录像"）', () => {
    assert.deepEqual(recorderGapWindows([], window, 2_000), [{ fromMs: 0, toMs: 600_000 }])
  })
})
