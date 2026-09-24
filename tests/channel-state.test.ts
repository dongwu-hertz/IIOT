/**
 * 通道状态解析器的回归测试（8 通道声纹设备“这一路开着吗”）。
 *
 * WHY THIS FILE EXISTS
 * 灰色通道的价值取决于“灰色代表什么”。如果解析器把从未查询成功的通道判成
 * 已启用，界面会照常播放它，工程师也就不会去看那台设备；反过来，如果 `disabled`
 * 与 `unknown` 用同一种灰，一台没连通的设备看起来就像“通道被人关掉了”。
 * 所以三种状态、以及“非布尔标志不得被强转”的边界都在这里钉死。
 *
 * 同时断言目录 key 真的存在于四种语言里：`channelStateLabelKey()` 返回的是
 * key，key 不存在时界面会直接渲染出 `channelState.disabled` 这样的裸 key。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  channelActivityLabelKey,
  channelReceivesData,
  channelState,
  channelStateClass,
  channelStateHintKey,
  channelStateLabelKey,
  type ChannelState
} from '../src/renderer/src/lib/channelState'
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

/** 点号路径取值，用来断言 `channelState.*` 这类 key 真的存在。 */
function messageAt(locale: string, key: string): unknown {
  let cursor: unknown = CATALOGUES[locale]
  for (const segment of key.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

const ALL_STATES: ChannelState[] = ['enabled', 'disabled', 'unknown']

describe('channelState()', () => {
  it('reports an explicitly enabled channel as enabled', () => {
    assert.equal(channelState({ enabled: true }), 'enabled')
  })

  it('reports an explicitly disabled channel as disabled', () => {
    assert.equal(channelState({ enabled: false }), 'disabled')
  })

  it('treats a missing flag as unknown, never as enabled', () => {
    // 一台从未成功查询过的设备：通道行存在，但没人告诉我们它是否开启。
    assert.equal(channelState({}), 'unknown')
    assert.equal(channelState({ enabled: undefined }), 'unknown')
  })

  it('treats a null/undefined channel as unknown', () => {
    assert.equal(channelState(undefined), 'unknown')
    assert.equal(channelState(null), 'unknown')
  })

  it('does NOT coerce a non-boolean flag', () => {
    // 松散类型载荷（设备 JSON、历史数据库、IPC）可能给出这些值。
    // `0`/`''` 若被当成 false，就会把“不知道”渲染成“明确关闭”。
    const loose: unknown[] = [0, 1, 'true', 'false', '', 'yes', NaN]
    for (const value of loose) {
      assert.equal(
        channelState({ enabled: value }),
        'unknown',
        `enabled=${String(value)} must not be coerced`
      )
    }
  })

  it('keeps disabled and unknown distinct', () => {
    assert.notEqual(channelState({ enabled: false }), channelState({ enabled: undefined }))
  })
})

describe('presentation helpers', () => {
  it('gives every state its own modifier class', () => {
    const classes = ALL_STATES.map(channelStateClass)
    assert.equal(new Set(classes).size, ALL_STATES.length)
    for (const state of ALL_STATES) {
      assert.ok(channelStateClass(state).includes(`channel-state--${state}`))
    }
    // 基础类必须存在，模板才能统一处理（例如整体变灰的容器）。
    assert.ok(channelStateClass('disabled').split(' ').includes('channel-state'))
  })

  it('returns catalogue keys, never translated text', () => {
    for (const state of ALL_STATES) {
      const key = channelStateLabelKey(state)
      assert.equal(key, `channelState.${state}`)
      // key 里不允许出现任何汉字（文本只存在于目录里）。
      assert.ok(!/[\u4e00-\u9fff]/.test(key))
    }
  })

  it('only hints for the two non-working states', () => {
    assert.equal(channelStateHintKey('disabled'), 'channelState.disabledHint')
    assert.equal(channelStateHintKey('unknown'), 'channelState.unknownHint')
    // 已启用不加提示：正常工作的通道不该有噪音。
    assert.equal(channelStateHintKey('enabled'), '')
  })

  it('names every state label and hint key in all four catalogues', () => {
    const keys: string[] = [
      ...ALL_STATES.map((state) => channelStateLabelKey(state)),
      channelStateHintKey('disabled'),
      channelStateHintKey('unknown'),
      channelActivityLabelKey(true),
      channelActivityLabelKey(false),
      'channelState.enabledSummary'
    ]
    for (const locale of LOCALES) {
      for (const key of keys) {
        assert.equal(typeof messageAt(locale, key), 'string', `${locale} has no message for ${key}`)
      }
    }
  })
})

describe('channelReceivesData()', () => {
  const active = { isActiveChannel: true, sessionRunning: true, frameCount: 3 }

  it('is true only for the running session channel with frames', () => {
    assert.equal(channelReceivesData(active), true)
  })

  it('is false for a channel that is not the subscribed one', () => {
    assert.equal(channelReceivesData({ ...active, isActiveChannel: false }), false)
  })

  it('is false while the session is stopped', () => {
    assert.equal(channelReceivesData({ ...active, sessionRunning: false }), false)
  })

  it('is false when the channel is on but silent', () => {
    // 关键区别：enabled === true 但零帧 —— “开着却没有数据”，不是“被关掉”。
    assert.equal(channelReceivesData({ ...active, frameCount: 0 }), false)
    assert.equal(channelState({ enabled: true }), 'enabled')
  })
})
