/**
 * ② 每通道声纹特性的回归测试（`lib/channelFeatures.ts`）。
 *
 * WHY THIS FILE EXISTS
 * 这张表是"这一路**上一次**读到什么"，它的全部风险都在**边界**上：
 *   - 一个畸形的通道号（`'3'` / `-1` / `1e9`）会让表按垃圾键一直长下去（无界内存）；
 *   - 乱序到达的旧帧（重连、切通道的尾巴）会覆盖新读数 —— 那会让卡片上的数字**倒退**；
 *   - "有读数但不是此刻在收的那一路"（stored）与"从没读到过"（unread）必须分开：
 *     合成一句"无数据"就是把旧读数当成了没有数据，或者更糟 —— 当成实时值。
 *
 * 目录 key 也在这里对着四种语言断言：`channelFeatureStateLabelKey()` 返回的是 key，
 * key 不存在时界面会直接渲染出 `monitorUi.channelFeature_live` 这样的裸 key。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  MAX_CHANNEL_INDEX,
  channelFeatureFor,
  channelFeatureState,
  channelFeatureStateLabelKey,
  isRecordableChannel,
  recordChannelFeature,
  type ChannelFeatureMap,
  type ChannelFeatureState
} from '../src/renderer/src/lib/channelFeatures'
import type { RealtimeFeature } from '../src/shared/domain/models'
import { LOCALES } from '../src/shared/i18n/locales'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const CATALOGUES: Record<string, Record<string, unknown>> = {
  'zh-CN': zhCN as unknown as Record<string, unknown>,
  en: en as unknown as Record<string, unknown>,
  es: es as unknown as Record<string, unknown>,
  tr: tr as unknown as Record<string, unknown>
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
    mainFrequency: 100,
    smoothness: 0.5,
    bandEnergyRatio: 0.25
  }
}

describe('每通道声纹特性：哪些帧可以收下', () => {
  it('只收 0..63 的整数通道号', () => {
    assert.equal(isRecordableChannel(0), true)
    assert.equal(isRecordableChannel(MAX_CHANNEL_INDEX), true)
    assert.equal(isRecordableChannel(MAX_CHANNEL_INDEX + 1), false)
    assert.equal(isRecordableChannel(-1), false)
    // 字符串的 '3' 会与数字 3 使用不同的键：留着它会得到"CH3 有两份读数"。
    assert.equal(isRecordableChannel('3'), false)
    assert.equal(isRecordableChannel(1.5), false)
    assert.equal(isRecordableChannel(Number.NaN), false)
    assert.equal(isRecordableChannel(undefined), false)
    assert.equal(isRecordableChannel(null), false)
  })

  it('收下的帧按通道号入表，被拒的帧原样返回旧表（同一个引用）', () => {
    const empty: ChannelFeatureMap = {}
    const withFrame = recordChannelFeature(empty, frame(3, 1000))
    assert.notEqual(withFrame, empty, '合法帧没有产生新表')
    assert.equal(withFrame[3]?.timestamp, 1000)

    // 同一个引用 = 不触发一次无意义的响应式更新。
    assert.equal(recordChannelFeature(withFrame, frame(999, 2000)), withFrame)
    assert.equal(recordChannelFeature(withFrame, { ...frame(1, 2000), channelId: '1' as never }), withFrame)
  })

  it('同一路的旧帧不覆盖新帧（乱序到达会让读数倒退）', () => {
    const first = recordChannelFeature({}, frame(2, 2000, 40))
    const older = recordChannelFeature(first, frame(2, 1000, 99))
    assert.equal(older, first, '旧帧覆盖了新帧')
    assert.equal(channelFeatureFor(older, 2)?.spl, 40)

    // 时间戳相同：后来的那一帧算数（同一毫秒里的重发不应当被当成倒序）。
    const same = recordChannelFeature(first, frame(2, 2000, 41))
    assert.equal(channelFeatureFor(same, 2)?.spl, 41)
  })

  it('表里没有这一路时返回 null（不是 0、不是空对象）', () => {
    assert.equal(channelFeatureFor({}, 5), null)
    assert.equal(channelFeatureFor(recordChannelFeature({}, frame(5, 1)), 4), null)
  })

  it('键域封顶：一万个畸形通道号最多只留下 64 条', () => {
    let map: ChannelFeatureMap = {}
    for (let channelId = 0; channelId < 10000; channelId += 1) {
      map = recordChannelFeature(map, frame(channelId, channelId + 1))
    }
    const keys = Object.keys(map)
    assert.equal(keys.length, MAX_CHANNEL_INDEX + 1, '畸形通道号把表撑大了')
    assert.equal(channelFeatureFor(map, 9999), null)
  })
})

describe('每通道声纹特性：一张卡片处在哪种状态', () => {
  const states: Array<[string, Parameters<typeof channelFeatureState>[0], ChannelFeatureState]> = [
    [
      '没有读数就是 unread（与"读到了 0"不同）',
      { isActiveChannel: true, sessionRunning: true, frameCount: 9, hasFeature: false },
      'unread'
    ],
    [
      '当前订阅且帧在进来 = live',
      { isActiveChannel: true, sessionRunning: true, frameCount: 9, hasFeature: true },
      'live'
    ],
    [
      '是当前那一路但会话没跑 = stored（不是 live）',
      { isActiveChannel: true, sessionRunning: false, frameCount: 9, hasFeature: true },
      'stored'
    ],
    [
      '是当前那一路、会话在跑、却一帧都没有 = stored',
      { isActiveChannel: true, sessionRunning: true, frameCount: 0, hasFeature: true },
      'stored'
    ],
    [
      '不是当前那一路 = stored',
      { isActiveChannel: false, sessionRunning: true, frameCount: 9, hasFeature: true },
      'stored'
    ]
  ]

  for (const [label, input, expected] of states) {
    it(label, () => {
      assert.equal(channelFeatureState(input), expected)
    })
  }

  it('三种状态的目录 key 在四种语言里都存在且非空', () => {
    for (const state of ['live', 'stored', 'unread'] as const) {
      const key = channelFeatureStateLabelKey(state)
      assert.equal(key, `monitorUi.channelFeature_${state}`)
      for (const locale of LOCALES) {
        const value = messageAt(locale, key)
        assert.equal(
          typeof value === 'string' && value.trim().length > 0,
          true,
          `${locale} 缺少 ${key}`
        )
      }
    }
  })
})
