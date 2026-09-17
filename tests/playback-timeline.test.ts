/**
 * 回放时间轴的几何模型（`lib/playbackTimeline.ts`）。
 *
 * 这些断言对准的是三种「一滚就坏」的毛病，而不是「函数有返回值」：
 *   - **缩放锚点**：滚轮缩放后，光标下的时刻必须还在原来的像素位置；
 *   - **平移边界**：不能拖到没有数据的地方，还显示一条空白时间轴；
 *   - **刻度稳定**：刻度按绝对时间对齐，拖动时标签不漂移。
 * 再加一条来自手册 p67–68 的 `Previous/Next Event` 语义（没有更远的一段时必须返回 undefined，
 * 而不是绕回第一段——绕回去会让「下一个」按钮变成一个说谎的按钮）。
 *
 * 手册出处见模块文件头；`TICK_STEPS_MS`、最小标签间距与缩放锚点语义是**我们自己定的**。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  ANCHOR_END_MARGIN_MS,
  DEFAULT_MIN_LABEL_PX,
  DEFAULT_MIN_SPAN_MS,
  anchorSeek,
  clampWindow,
  chooseTickStep,
  normaliseWindow,
  panWindow,
  placeSegments,
  segmentAt,
  stepEvent,
  ticksFor,
  timeToX,
  xToTime,
  zoomWindow,
  type WindowLimits
} from '../src/renderer/src/lib/playbackTimeline'

const WIDE: WindowLimits = { minMs: 0, maxMs: 3_600_000, minSpanMs: 1000 }

describe('时间轴：时间与像素互换', () => {
  it('往返一致', () => {
    const window = { startMs: 1000, endMs: 11_000 }
    for (const ms of [1000, 3500, 6000, 11_000]) {
      assert.ok(Math.abs(xToTime(window, 800, timeToX(window, 800, ms)) - ms) < 1e-6)
    }
  })

  it('窗口或宽度非法时返回有限值而不是 NaN', () => {
    const degenerate = { startMs: 5, endMs: 5 }
    assert.equal(timeToX(degenerate, 800, 5), 0)
    assert.equal(xToTime(degenerate, 800, 400), 5)
    assert.equal(timeToX({ startMs: 0, endMs: 100 }, 0, 50), 0)
  })
})

describe('时间轴：窗口修补', () => {
  it('终点不大于起点时向后撑开，并保住起点', () => {
    const repaired = normaliseWindow(5000, 5000)
    assert.equal(repaired.startMs, 5000)
    assert.equal(repaired.endMs, 5000 + DEFAULT_MIN_SPAN_MS)
  })

  it('跨度不足时撑到最小跨度', () => {
    const repaired = normaliseWindow(5000, 5100)
    assert.equal(repaired.endMs - repaired.startMs, DEFAULT_MIN_SPAN_MS)
  })

  it('NaN 输入不会漏出 NaN', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const repaired = normaliseWindow(bad, bad)
      assert.ok(Number.isFinite(repaired.startMs))
      assert.ok(Number.isFinite(repaired.endMs))
      assert.ok(repaired.endMs > repaired.startMs)
    }
  })

  it('合法窗口原样返回', () => {
    // 注意跨度必须**大于**最小跨度，否则「被修补」才是正确行为（下一组用例专门测那个）。
    assert.deepEqual(normaliseWindow(100, 5_000), { startMs: 100, endMs: 5_000 })
  })

  it('跨度小于最小跨度时被撑开（这里 800ms < 1000ms，属预期修补）', () => {
    const repaired = normaliseWindow(100, 900)
    assert.equal(repaired.startMs, 100)
    assert.equal(repaired.endMs, 100 + DEFAULT_MIN_SPAN_MS)
  })
})

describe('时间轴：录像段的摆放', () => {
  const window = { startMs: 10_000, endMs: 20_000 }

  it('只保留与窗口相交的段，并裁剪到窗口内', () => {
    const placed = placeSegments(window, 1000, [
      { id: 'before', kind: 'manual', startMs: 0, endMs: 5_000 },
      { id: 'overlap-left', kind: 'manual', startMs: 5_000, endMs: 12_000 },
      { id: 'inside', kind: 'alarm', startMs: 13_000, endMs: 15_000 },
      { id: 'after', kind: 'manual', startMs: 25_000, endMs: 30_000 }
    ])
    assert.deepEqual(placed.map((segment) => segment.id), ['overlap-left', 'inside'])
    const clippedLeft = placed[0]
    const inside = placed[1]
    assert.ok(clippedLeft)
    assert.ok(inside)
    assert.equal(clippedLeft.leftPx, 0, '被裁到窗口左边界')
    assert.equal(clippedLeft.clippedStart, true)
    assert.equal(clippedLeft.clippedEnd, false)
    assert.equal(inside.leftPx, 300)
    assert.equal(inside.widthPx, 200)
  })

  it('跨越整个窗口的段两端都被标记为已裁剪', () => {
    const placed = placeSegments(window, 1000, [
      { id: 'long', kind: 'manual', startMs: 0, endMs: 99_999 }
    ])
    assert.equal(placed.length, 1)
    const only = placed[0]
    assert.ok(only)
    assert.equal(only.leftPx, 0)
    assert.equal(only.widthPx, 1000)
    assert.equal(only.clippedStart, true)
    assert.equal(only.clippedEnd, true)
  })

  it('零长度段被丢弃（它画不出宽度，却会抢走一次点击）', () => {
    const placed = placeSegments(window, 1000, [
      { id: 'empty', kind: 'manual', startMs: 15_000, endMs: 15_000 }
    ])
    assert.deepEqual(placed, [])
  })

  it('按开始时间升序，同一时刻按 id 稳定排序', () => {
    const placed = placeSegments(window, 1000, [
      { id: 'b', kind: 'manual', startMs: 15_000, endMs: 16_000 },
      { id: 'a', kind: 'manual', startMs: 15_000, endMs: 17_000 },
      { id: 'c', kind: 'manual', startMs: 11_000, endMs: 12_000 }
    ])
    assert.deepEqual(placed.map((segment) => segment.id), ['c', 'a', 'b'])
  })
})

describe('时间轴：刻度', () => {
  it('标签间距不小于最小间距', () => {
    for (const span of [1000, 10_000, 60_000, 600_000, 3_600_000, 86_400_000]) {
      const window = { startMs: 0, endMs: span }
      const width = 800
      const { stepMs, ticks } = ticksFor(window, width, DEFAULT_MIN_LABEL_PX)
      const stepPx = (stepMs / span) * width
      assert.ok(stepPx >= DEFAULT_MIN_LABEL_PX, `span=${span} stepPx=${stepPx}`)
      for (let i = 1; i < ticks.length; i += 1) {
        const current = ticks[i]
        const previous = ticks[i - 1]
        assert.ok(current)
        assert.ok(previous)
        assert.ok(current.x - previous.x >= DEFAULT_MIN_LABEL_PX - 1e-9)
      }
    }
  })

  it('刻度按绝对时间对齐（拖动时标签不漂移）', () => {
    const window = { startMs: 1_234_567, endMs: 1_294_567 }
    const { stepMs, ticks } = ticksFor(window, 800)
    assert.ok(ticks.length > 0)
    for (const tick of ticks) {
      assert.equal(tick.at % stepMs, 0, `tick ${tick.at} 未对齐到 ${stepMs}`)
      assert.ok(tick.at >= window.startMs && tick.at <= window.endMs)
    }
  })

  it('选的是人能读的整数间隔', () => {
    assert.equal(chooseTickStep(60_000, 600, 64), 10_000)
    assert.equal(chooseTickStep(3_600_000, 600, 64), 600_000)
  })

  it('跨度超过候选表上限（1 天）时按整天向上取整，宁可稀疏也不重叠', () => {
    const tenDays = 10 * 86_400_000
    const step = chooseTickStep(tenDays, 100, 64)
    assert.equal(step % 86_400_000, 0, '必须是整天')
    assert.ok(step >= (tenDays * 64) / 100, '必须满足最小间距')
  })

  it('退化输入不抛错', () => {
    assert.deepEqual(ticksFor({ startMs: 0, endMs: 0 }, 0).ticks, [])
    assert.ok(Number.isFinite(chooseTickStep(0, 0)))
  })
})

describe('时间轴：缩放与平移', () => {
  it('缩放的锚点像素位置不变（这是滚轮缩放的全部意义）', () => {
    const window = { startMs: 100_000, endMs: 200_000 }
    const width = 1000
    const anchorMs = 130_000
    const before = timeToX(window, width, anchorMs)

    for (const factor of [1.25, 2, 0.5, 0.8]) {
      const next = zoomWindow(window, factor, anchorMs, WIDE)
      const after = timeToX(next, width, anchorMs)
      assert.ok(Math.abs(after - before) < 1e-6, `factor=${factor}: ${after} != ${before}`)
    }
  })

  it('放大让窗口变短，缩小让它变长', () => {
    const window = { startMs: 100_000, endMs: 200_000 }
    assert.equal(zoomWindow(window, 2, 150_000, WIDE).endMs - zoomWindow(window, 2, 150_000, WIDE).startMs, 50_000)
    assert.equal(zoomWindow(window, 0.5, 150_000, WIDE).endMs - zoomWindow(window, 0.5, 150_000, WIDE).startMs, 200_000)
  })

  it('缩放不会越过边界，也不会短于最小跨度', () => {
    const window = { startMs: 0, endMs: 2000 }
    const zoomedIn = zoomWindow(window, 100, 0, { ...WIDE, minSpanMs: 1000 })
    assert.equal(zoomedIn.endMs - zoomedIn.startMs, 1000)

    const veryWide = zoomWindow({ startMs: 1_000_000, endMs: 2_000_000 }, 0.001, 1_500_000, WIDE)
    assert.ok(veryWide.startMs >= WIDE.minMs)
    assert.ok(veryWide.endMs <= WIDE.maxMs)
  })

  it('非法缩放因子只做夹取，不抛错', () => {
    const window = { startMs: 1000, endMs: 2000 }
    assert.deepEqual(zoomWindow(window, 0, 1500, WIDE), clampWindow(window, WIDE))
    assert.deepEqual(zoomWindow(window, Number.NaN, 1500, WIDE), clampWindow(window, WIDE))
  })

  it('平移量未被边界截断时等于原样移动', () => {
    const moved = panWindow({ startMs: 100_000, endMs: 200_000 }, 50_000, WIDE)
    assert.deepEqual(moved, { startMs: 150_000, endMs: 250_000 })
  })

  it('平移被夹在可用范围内（不会拖出空白时间轴）', () => {
    const left = panWindow({ startMs: 100_000, endMs: 200_000 }, -999_999, WIDE)
    assert.equal(left.startMs, WIDE.minMs)
    const right = panWindow({ startMs: 100_000, endMs: 200_000 }, 99_999_999, WIDE)
    assert.equal(right.endMs, WIDE.maxMs)
  })
})

describe('时间轴：命中测试与事件跳转', () => {
  const window = { startMs: 10_000, endMs: 20_000 }
  const placed = placeSegments(window, 1000, [
    { id: 'a', kind: 'manual', startMs: 10_000, endMs: 12_000 },
    { id: 'b', kind: 'alarm', startMs: 16_000, endMs: 18_000 }
  ])

  it('点在段上命中，点在空隙里返回 undefined', () => {
    assert.equal(segmentAt(placed, 100)?.id, 'a')
    assert.equal(segmentAt(placed, 700)?.id, 'b')
    assert.equal(segmentAt(placed, 400), undefined, '400px 落在两段之间')
    assert.equal(segmentAt(placed, 9999), undefined)
  })

  it('下一个事件是第一个严格更晚的起点', () => {
    const starts = [10_000, 16_000, 22_000]
    assert.equal(stepEvent(starts, 0, 'next'), 10_000)
    assert.equal(stepEvent(starts, 10_000, 'next'), 16_000, '相等不算下一个')
    assert.equal(stepEvent(starts, 16_000, 'next'), 22_000)
    assert.equal(stepEvent(starts, 22_000, 'next'), undefined, '没有更远的就返回 undefined')
  })

  it('上一个事件是最后一个严格更早的起点', () => {
    const starts = [10_000, 16_000, 22_000]
    assert.equal(stepEvent(starts, 30_000, 'previous'), 22_000)
    assert.equal(stepEvent(starts, 22_000, 'previous'), 16_000)
    assert.equal(stepEvent(starts, 10_000, 'previous'), undefined)
    assert.equal(stepEvent(starts, 0, 'previous'), undefined)
  })

  it('重复起点被去重（同一时刻多个通道时「下一个」不会原地不动）', () => {
    assert.equal(stepEvent([5000, 5000, 5000], 5000, 'next'), undefined)
    assert.equal(stepEvent([5000, 5000, 9000], 5000, 'next'), 9000)
  })

  it('空集合与非有限值不会产生假事件', () => {
    assert.equal(stepEvent([], 1000, 'next'), undefined)
    assert.equal(stepEvent([Number.NaN, Number.POSITIVE_INFINITY], 1000, 'next'), undefined)
  })
})

/**
 * 「从告警前 N 秒开始播」（`anchorSeek()`）。
 *
 * 这一组断言的核心不是"跳到几"，而是**函数必须说出自己没做到**：
 * 手册说 30 秒，而本机环形缓冲区的预录时长可配置（出厂默认 10 秒），所以差额是常态。
 * 静默夹取会让操作员以为那 20 秒只是自己没听到 —— 实际是根本没录。
 */
describe('回放：从锚点（告警时刻）前 N 秒开始', () => {
  /** 一段 10 秒预录 + 20 秒后录的录音，告警在第 10 秒。 */
  const clip = { clipStartMs: 1_000_000, anchorAtMs: 1_010_000, durationMs: 30_000 }

  it('预录足够时，正好跳到「锚点 - 30 秒」并报告差额为 0', () => {
    // 把预录加长到 60 秒：片段起点 950_000，告警在 1_010_000。
    const result = anchorSeek({
      anchorAtMs: 1_010_000,
      clipStartMs: 950_000,
      requestedLeadMs: 30_000,
      durationMs: 90_000
    })
    assert.equal(result.seekMs, 30_000, '跳到片段内第 30 秒')
    assert.equal(result.achievedLeadMs, 30_000)
    assert.equal(result.shortfallMs, 0, '请求被满足时不许报差额')
  })

  it('预录只有 10 秒而请求 30 秒：夹到片段开头，并如实报告差额 20 秒', () => {
    const result = anchorSeek({ ...clip, requestedLeadMs: 30_000 })
    assert.equal(result.seekMs, 0, '跳不到负时间，只能从片段开头播')
    assert.equal(result.achievedLeadMs, 10_000, '实际只拿到 10 秒告警前内容')
    assert.equal(result.shortfallMs, 20_000, '差额必须被算出来，界面才有话可说')
  })

  it('请求 0 秒就是"跳到锚点本身"', () => {
    const result = anchorSeek({ ...clip, requestedLeadMs: 0 })
    assert.equal(result.seekMs, 10_000)
    assert.equal(result.achievedLeadMs, 0)
    assert.equal(result.shortfallMs, 0)
  })

  it('锚点落在片段之前：不跳到负时间，回退量按 0 报（不许报成负数）', () => {
    const result = anchorSeek({
      anchorAtMs: 900_000, // 早于 clipStartMs
      clipStartMs: 1_000_000,
      requestedLeadMs: 30_000,
      durationMs: 30_000
    })
    assert.equal(result.seekMs, 0)
    assert.equal(result.achievedLeadMs, 0)
    assert.equal(result.shortfallMs, 30_000)
  })

  it('跳转点不许落在片段末尾：留 50 毫秒余量，否则一开播就结束', () => {
    const result = anchorSeek({
      anchorAtMs: 1_030_000,
      clipStartMs: 1_000_000,
      requestedLeadMs: 0,
      durationMs: 30_000
    })
    assert.equal(result.seekMs, 30_000 - ANCHOR_END_MARGIN_MS)
    assert.ok(result.seekMs < 30_000)
  })

  it('时长未知（0）时退化成从片段开头播，并且差额如实报满', () => {
    const result = anchorSeek({ ...clip, requestedLeadMs: 30_000, durationMs: 0 })
    assert.equal(result.seekMs, 0)
    assert.equal(result.shortfallMs, 20_000)
  })

  it('负的请求量与负数时长都被夹成 0，不会产生向后跳的怪结果', () => {
    const negative = anchorSeek({ ...clip, requestedLeadMs: -5000 })
    assert.equal(negative.seekMs, 10_000, '负请求等于"不提前"')
    assert.equal(negative.shortfallMs, 0)
    const badDuration = anchorSeek({ ...clip, requestedLeadMs: 0, durationMs: -1 })
    assert.equal(badDuration.seekMs, 0)
  })

  it('差额只会是 0 或正数，且 seek + achieved 恒等于「锚点到片段起点的距离」', () => {
    for (const requested of [0, 1_000, 10_000, 30_000, 600_000]) {
      const result = anchorSeek({ ...clip, requestedLeadMs: requested })
      assert.ok(result.shortfallMs >= 0, `requested=${requested}`)
      assert.ok(result.achievedLeadMs >= 0)
      assert.equal(
        result.seekMs + result.achievedLeadMs,
        clip.anchorAtMs - clip.clipStartMs,
        `requested=${requested}: 跳到的位置 + 实际回退量必须正好回到锚点`
      )
    }
  })
})
