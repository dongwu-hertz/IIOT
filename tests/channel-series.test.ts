/**
 * ⑨ 多通道同时显示的回归测试（`lib/channelSeries.ts`，业主 2026-09-24）。
 *
 * WHY THIS FILE EXISTS
 * 这张功能最容易犯的错，全都不是"画不出来"，而是**画出一张看起来很对的假图**：
 *   - 某一路根本没收到帧，却把上一路的值搬过来（或者补 0）—— 数字会被当成实测值；
 *   - 有帧但已经停了十分钟，仍然标"实时"；
 *   - 每一路各自缩放 Y 轴，安静的一路与最响的一路画成同样高的波浪（比较失效）；
 *   - 通道色随机分配，同一条通道两次打开颜色不同，图例与线对不上号。
 * 所以这里逐条钉住：**点数只来自这一路自己的帧**、状态随新鲜度降级、
 * 颜色按通道号稳定、勾选集合去重/封顶/只认整数通道号。
 *
 * 目录 key 也在这里对着六种语言断言：`realtimeUi.*` 的新 key 缺失时界面会直接
 * 渲染出裸 key（`realtimeUi.multiChannelTitle`），比没有这段文字更糟。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  CHANNEL_SERIES_STALE_AFTER_MS,
  buildChannelSeries,
  channelSeriesLabel,
  normalizeWatchedChannels,
  seriesSparkPath,
  toggleWatchedChannel
} from '../src/renderer/src/lib/channelSeries'
import {
  MAX_CHANNEL_INDEX,
  channelFeatureLiveness
} from '../src/renderer/src/lib/channelFeatures'
import { MAX_FEATURE_CHANNELS } from '../src/shared/domain/monitoring'
import { TREND_CHANNEL_COLORS, trendChannelColor } from '../src/shared/domain/trend'
import type { ChannelFeatureHistoryMap } from '../src/renderer/src/lib/channelFeatures'
import type { RealtimeFeature } from '../src/shared/domain/models'
import { LOCALES } from '../src/shared/i18n/locales'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'
import { ru } from '../src/shared/i18n/messages/ru'
import { zhTW } from '../src/shared/i18n/messages/zh-TW'

const CATALOGUES: Record<string, Record<string, unknown>> = {
  'zh-CN': zhCN as unknown as Record<string, unknown>,
  'zh-TW': zhTW as unknown as Record<string, unknown>,
  en: en as unknown as Record<string, unknown>,
  es: es as unknown as Record<string, unknown>,
  tr: tr as unknown as Record<string, unknown>,
  ru: ru as unknown as Record<string, unknown>
}

function messageAt(locale: string, key: string): unknown {
  let cursor: unknown = CATALOGUES[locale]
  for (const part of key.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

function frame(channelId: number, timestamp: number, spl = 42): RealtimeFeature {
  return {
    deviceId: 'dev-1',
    channelId,
    timestamp,
    spl,
    mainFrequency: 100 + channelId,
    smoothness: 1.5,
    bandEnergyRatio: 0.03
  }
}

const NOW = 1_700_000_000_000

function history(entries: Record<number, RealtimeFeature[]>): ChannelFeatureHistoryMap {
  return entries
}

describe('多通道：勾选集合的规范化', () => {
  it('去重、升序、只留合法通道号', () => {
    assert.deepEqual(normalizeWatchedChannels([3, 0, 3, 1]), [0, 1, 3])
    // 字符串、负数、小数、越界一律丢掉（它们只可能来自坏掉的调用方）。
    assert.deepEqual(
      normalizeWatchedChannels([-1, 1.5, MAX_CHANNEL_INDEX + 1, Number.NaN] as number[]),
      []
    )
    assert.deepEqual(normalizeWatchedChannels([MAX_CHANNEL_INDEX]), [MAX_CHANNEL_INDEX])
  })

  it('封顶在 MAX_FEATURE_CHANNELS：一条勾选就是一条连接', () => {
    const many = Array.from({ length: 20 }, (_, index) => index)
    const result = normalizeWatchedChannels(many)
    assert.equal(result.length, MAX_FEATURE_CHANNELS)
    assert.deepEqual(result, many.slice(0, MAX_FEATURE_CHANNELS))
  })

  it('toggle 只动那一路，并返回新数组', () => {
    const before = [0, 2]
    const added = toggleWatchedChannel(before, 1)
    assert.deepEqual(added, [0, 1, 2])
    // 原数组不被原地改（调用方要把它赋回 ref 才会触发刷新）。
    assert.deepEqual(before, [0, 2])
    assert.deepEqual(toggleWatchedChannel(added, 1), [0, 2])
  })

  it('toggle 一个非法通道号 = 只做规范化，不会塞进垃圾键', () => {
    assert.deepEqual(toggleWatchedChannel([0], -3), [0])
    assert.deepEqual(toggleWatchedChannel([0], 1e9), [0])
  })
})

describe('多通道：每一路只用自己的帧', () => {
  it('没收到帧的那一路是 unread，且不画任何点（不补 0、不搬别的通道）', () => {
    const series = buildChannelSeries({
      watchedChannels: [0, 1],
      history: history({ 0: [frame(0, NOW - 1_000), frame(0, NOW - 500)] }),
      metric: 'spl',
      now: NOW,
      windowMs: 60_000,
      activeChannel: 0,
      sessionRunning: true,
    })
    const [, second] = series
    assert.equal(second?.state, 'unread')
    assert.deepEqual(second?.points, [])
    assert.equal(second?.latest, null)
    assert.equal(second?.lastAt, null)
    assert.equal(second?.ageMs, null)
  })

  it('只留窗口内的点，但"最后一次读数"保留窗口外的旧帧（带时刻）', () => {
    const series = buildChannelSeries({
      watchedChannels: [1],
      history: history({ 1: [frame(1, NOW - 120_000, 30), frame(1, NOW - 1_000, 55)] }),
      metric: 'spl',
      now: NOW,
      windowMs: 60_000,
      activeChannel: 1,
      sessionRunning: true,
    })
    const first = series[0]
    assert.equal(first?.points.length, 1, '两分钟前的点不该进 60 秒窗口')
    assert.equal(first?.points[0]?.y, 55)
    /*
     * 旧帧仍然作为"最后读数"留着：卡片要能写"更新于 12:03"。
     * 注意"窗口"与"新鲜度"是两件事：窗口是 60 秒（图上画多长），新鲜度是 5 秒
     * （这读数还算不算实时）。这一帧是 1 秒前到的 —— 不在窗口内的那条是 2 分钟前的，
     * 所以状态仍是 live，别把两者混成一个阈值。
     */
    assert.equal(first?.state, 'live')
    assert.equal(first?.lastAt, NOW - 1_000)
  })

  it('画的是所选的量，不是固定的 SPL', () => {
    const series = buildChannelSeries({
      watchedChannels: [0],
      history: history({ 0: [frame(0, NOW - 500)] }),
      metric: 'mainFrequency',
      now: NOW,
      windowMs: 60_000,
      activeChannel: 0,
      sessionRunning: true,
    })
    assert.equal(series[0]?.points[0]?.y, 100)
  })

  it('该量缺值（undefined）不画点，也不会画成 0', () => {
    const bare = {
      ...frame(0, NOW - 500),
      bandEnergyRatio: undefined
    } as unknown as RealtimeFeature
    const series = buildChannelSeries({
      watchedChannels: [0],
      history: history({ 0: [bare] }),
      metric: 'bandEnergyRatio',
      now: NOW,
      windowMs: 60_000,
      activeChannel: 0,
      sessionRunning: true,
    })
    assert.deepEqual(series[0]?.points, [])
    // 帧本身是收到了的 —— 这与"没收到"是两件事，状态不许混。
    assert.equal(series[0]?.state, 'live')
  })
})

describe('多通道：实时 / 旧读数 / 未收到', () => {
  const build = (lastAt: number, sessionRunning = true, activeChannel = 2) =>
    buildChannelSeries({
      watchedChannels: [2],
      history: history({ 2: [frame(2, lastAt)] }),
      metric: 'spl',
      now: NOW,
      windowMs: 60_000,
      activeChannel,
      sessionRunning
    })[0]

  it('帧在进来 = live（判据是新鲜度，不是"我点着这一路"）', () => {
    assert.equal(build(NOW - 1_000)?.state, 'live')
    // 这正是多通道订阅带来的变化：不是当前点着的那一路也可以是实时的，
    // 因为它有自己的一条连接，帧真的在进来。
    assert.equal(build(NOW - 1_000, true, 5)?.state, 'live')
  })

  it('超过阈值没有新帧就降级为 stored（绝不把旧值当实时）', () => {
    assert.equal(build(NOW - CHANNEL_SERIES_STALE_AFTER_MS - 1)?.state, 'stored')
    // 边界：正好等于阈值仍算实时（阈值是"超过"才算停）。
    assert.equal(build(NOW - CHANNEL_SERIES_STALE_AFTER_MS)?.state, 'live')
  })

  it('会话停了就只能是 stored（帧还在缓冲里，但它不是实时数据）', () => {
    assert.equal(build(NOW - 100, false)?.state, 'stored')
  })

  it('当前那一路仍然带 isActive 标记（只影响"当前"角标）', () => {
    assert.equal(build(NOW - 1_000, true, 2)?.isActive, true)
    assert.equal(build(NOW - 1_000, true, 5)?.isActive, false)
  })
})

describe('多通道：迷你趋势的路径', () => {
  it('少于两点不给路径（一个点连不成线，不该假装有趋势）', () => {
    assert.equal(seriesSparkPath([]), '')
    assert.equal(seriesSparkPath([{ x: 1, y: 1 }]), '')
    // 非有限值不算点：'没有数据' 与 '数据是 NaN' 不能画成同一条线。
    assert.equal(
      seriesSparkPath([
        { x: 1, y: Number.NaN },
        { x: 2, y: 3 }
      ]),
      ''
    )
  })

  it('画在 2..98 之间（贴边画会被 SVG 视口裁掉一半描边）', () => {
    const path = seriesSparkPath([
      { x: 0, y: 10 },
      { x: 10, y: 20 }
    ])
    assert.equal(path, 'M2.00,98.00 L98.00,2.00')
  })

  it('一条平线画在格子中间，而不是贴边', () => {
    const path = seriesSparkPath([
      { x: 0, y: 5 },
      { x: 10, y: 5 }
    ])
    assert.equal(path, 'M2.00,50.00 L98.00,50.00')
  })
})

describe('多通道：颜色与行序', () => {
  it('颜色按通道号稳定，且第一条是品牌橙（与单线时一致）', () => {
    const series = buildChannelSeries({
      watchedChannels: [5, 0],
      history: history({}),
      metric: 'spl',
      now: NOW,
      windowMs: 60_000,
      activeChannel: 0,
      sessionRunning: true,
    })
    // 行序 = 通道号升序，与左栏、图例一致。
    assert.deepEqual(
      series.map((entry) => entry.channelId),
      [0, 5]
    )
    assert.equal(series[0]?.color, TREND_CHANNEL_COLORS[0])
    assert.equal(series[1]?.color, trendChannelColor(5))
    // 同一条通道的颜色与历史趋势页取的色一致（两处必须是同一个函数）。
    assert.equal(series[1]?.color, trendChannelColor(5))
  })

  it('通道名是 CH1 起的编号', () => {
    assert.equal(channelSeriesLabel(0), 'CH1')
    assert.equal(channelSeriesLabel(7), 'CH8')
  })
})

describe('多通道：新鲜度判据（channelFeatureLiveness）', () => {
  const live = (input: Partial<Parameters<typeof channelFeatureLiveness>[0]>) =>
    channelFeatureLiveness({
      sessionRunning: true,
      hasFeature: true,
      ageMs: 1_000,
      ...input
    })

  it('没读数就是 unread —— 与"读到了 0"是两件事', () => {
    assert.equal(live({ hasFeature: false, ageMs: null }), 'unread')
  })

  it('会话停了就只能是 stored，哪怕帧是一秒前到的', () => {
    assert.equal(live({ sessionRunning: false }), 'stored')
  })

  it('年龄缺失或不是有限数 = stored（算不出新鲜度就不冒充实时）', () => {
    assert.equal(live({ ageMs: null }), 'stored')
    assert.equal(live({ ageMs: Number.NaN }), 'stored')
  })

  it('走时抖动（时间戳略在未来）仍算实时，明显不同步才算旧读数', () => {
    /*
     * 实测：`now` 是 1 秒一次的走时，帧的时间戳是精确到达时刻，所以"刚到的那一帧"
     * 常常比 now 晚几十到几百毫秒（第一次跑真窗口时量到 -133 ms）。第一版把负数
     * 一律判成旧读数，于是当前那一路显示成"更新于 …" —— 一个 133 ms 的抖动被写成了
     * "数据停了"。这里把两种负数分开钉住。
     */
    assert.equal(live({ ageMs: -133 }), 'live')
    assert.equal(live({ ageMs: -1_500 }), 'live')
    // 明显在未来（设备与主机时钟不同步）：不许冒充实时。
    assert.equal(live({ ageMs: -1_501 }), 'stored')
    assert.equal(live({ ageMs: -60_000 }), 'stored')
  })

  it('阈值可覆盖，且边界是"超过"才算停', () => {
    assert.equal(live({ ageMs: 5_000 }), 'live')
    assert.equal(live({ ageMs: 5_001 }), 'stored')
    assert.equal(live({ ageMs: 9_000, staleAfterMs: 10_000 }), 'live')
  })
})

describe('多通道：界面文案的目录 key', () => {
  const KEYS = [
    'realtimeUi.watchHint',
    'realtimeUi.watchChannelsLabel',
    'realtimeUi.watchChannelOn',
    'realtimeUi.watchChannelOff',
    'realtimeUi.watchChannelCurrent',
    'realtimeUi.multiChannelTitle',
    'realtimeUi.multiChannelNote',
    'realtimeUi.multiChannelNotReceived',
    'realtimeUi.multiChannelNotReceivedWhy',
    'realtimeUi.multiChannelWrongChannel',
    'realtimeUi.multiChannelStaleWhy',
    'realtimeUi.trendColumn',
    'realtimeUi.statusColumn',
    'realtimeUi.currentChannel'
  ]

  it('六种语言都有，且不是空串、不带 Markdown', () => {
    for (const code of LOCALES) {
      for (const key of KEYS) {
        const value = messageAt(code, key)
        assert.equal(typeof value, 'string', `${code} 缺 ${key}`)
        assert.notEqual((value as string).trim(), '', `${code} 的 ${key} 是空串`)
        assert.ok(!(value as string).includes('**'), `${code} 的 ${key} 带 Markdown 星号`)
      }
    }
  })

  it('{channel} 占位符在六种语言里都保留（界面要填通道名）', () => {
    for (const code of LOCALES) {
      assert.match(
        String(messageAt(code, 'realtimeUi.multiChannelWrongChannel')),
        /\{channel\}/,
        `${code} 的 multiChannelWrongChannel 丢了占位符`
      )
    }
  })
})
