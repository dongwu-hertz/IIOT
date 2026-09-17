/**
 * ② 音频回放的回归测试（`lib/audioPreview.ts`）。
 *
 * WHY THIS FILE EXISTS
 * 这段代码有两个"看起来能跑、其实在骗人"的失效方式，都只有单测能钉住：
 *
 *   1. **重采样写错**：包络重采样错了不会有异常，只会让听到的声音与屏幕上画的波形
 *      不是同一个形状（例如端点被吞掉、或者长度差一位导致整段音调偏高）。
 *   2. **队列无界**：每帧都往后排 —— 渲染进程卡一下之后，操作员按下"停止"声音还在响，
 *      而且是几秒钟前的旧声音。所以"什么时候丢弃积压、重新对齐到现在"被抽成了纯函数
 *      `scheduleStartTime()`，这里逐条钉死它的三条分支。
 *
 * `EnvelopePlayer` 本身依赖 `AudioContext`（浏览器对象），在 node 里造不出来 —— 所以
 * 它的全部**判断**都在这两个纯函数里，类只负责把它们接到 WebAudio 上。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  DEFAULT_VOLUME_PERCENT,
  PREVIEW_LEAD_SECONDS,
  PREVIEW_MAX_BACKLOG_SECONDS,
  resampleEnvelope,
  scheduleStartTime
} from '../src/renderer/src/lib/audioPreview'

describe('resampleEnvelope()', () => {
  it('点数相同时等价于原样（首尾与中间点都落在原值上）', () => {
    const out = resampleEnvelope([0, 0, 1, 0, 0], 5)
    assert.equal(out.length, 5)
    assert.deepEqual(Array.from(out), [0, 0, 1, 0, 0])
  })

  it('单调上升的包络重采样后仍然单调（不会出现台阶或回勾）', () => {
    const out = resampleEnvelope([0, 1, 2, 3], 7)
    for (let index = 1; index < out.length; index += 1) {
      assert.equal((out[index] ?? 0) >= (out[index - 1] ?? 0), true, `第 ${index} 点回勾了`)
    }
    assert.equal(out[0], 0)
    assert.equal(out[out.length - 1], 3)
  })

  it('中间线性插值，而不是阶梯或全部取整', () => {
    const out = resampleEnvelope([0, 1], 3)
    assert.equal(out.length, 3)
    // 0 -> 0.5 -> 1
    assert.equal(out[0], 0)
    assert.equal(out[1], 0.5)
    assert.equal(out[2], 1)
  })

  it('长度为 1 的包络是常量（整帧一个点的真实数据）', () => {
    const out = resampleEnvelope([0.5], 4)
    assert.equal(out.length, 4)
    for (const value of out) assert.equal(value, 0.5)
  })

  it('空包络是静音，不是崩溃', () => {
    const out = resampleEnvelope([], 8)
    assert.equal(out.length, 8)
    for (const value of out) assert.equal(value, 0)
  })

  it('长度被夹到至少 2（0 或负数不会造出一个长度为 0 的 buffer）', () => {
    assert.equal(resampleEnvelope([0, 1], 0).length, 2)
    assert.equal(resampleEnvelope([0, 1], -5).length, 2)
    assert.equal(resampleEnvelope([0, 1], 1).length, 2)
  })

  it('输出永远是有限数（NaN 进不了 AudioBuffer）', () => {
    const out = resampleEnvelope([0.2, -0.4, 0.9, -0.1], 64)
    for (const value of out) assert.equal(Number.isFinite(value), true)
  })
})

describe('scheduleStartTime()：浅队列的三条分支', () => {
  it('第一帧（指针落后于现在）从现在 + 领先量开始', () => {
    assert.equal(scheduleStartTime(0, 10), 10 + PREVIEW_LEAD_SECONDS)
  })

  it('正常跟得上时接着上一帧往后排（不改变节奏）', () => {
    const current = 10.5
    assert.equal(scheduleStartTime(current, 10.4), current)
  })

  it('积压超过上限时丢弃积压、重新对齐到现在 + 领先量', () => {
    const now = 10
    const current = now + PREVIEW_MAX_BACKLOG_SECONDS + 0.05
    assert.equal(scheduleStartTime(current, now), now + PREVIEW_LEAD_SECONDS)
  })

  it('恰好等于上限时不算积压（边界不抖动）', () => {
    /*
     * 这里传**二进制可精确表示**的数（0.25）而不是默认的 0.3：0.3 在双精度里是
     * 0.29999999999999998889776975374843…，`10 + 0.3 - 10 > 0.3` 成立，
     * 于是"恰好等于上限"这件事根本测不出来（测到的是浮点的舍入）。
     * 这是测试的边界，不是实现要修的缺陷：真实的积压是几十毫秒的整数倍。
     */
    assert.equal(scheduleStartTime(0.25, 0, 0.03, 0.25), 0.25)
    assert.equal(scheduleStartTime(0.5, 0, 0.03, 0.25), 0.03)
  })

  it('默认参数就是页面用的那一组，且上限远小于人能察觉的延迟', () => {
    assert.equal(PREVIEW_LEAD_SECONDS, 0.03)
    assert.equal(PREVIEW_MAX_BACKLOG_SECONDS, 0.3)
    assert.equal(scheduleStartTime(5, 0), 0 + PREVIEW_LEAD_SECONDS)
  })
})

describe('默认音量', () => {
  it('是一个 0..100 的整数（`%` 直接画在界面上）', () => {
    assert.equal(Number.isInteger(DEFAULT_VOLUME_PERCENT), true)
    assert.equal(DEFAULT_VOLUME_PERCENT > 0 && DEFAULT_VOLUME_PERCENT < 100, true)
  })
})
