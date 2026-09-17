/**
 * 「记住密码」的 90 天有效期（`shared/domain/remembered-login.ts`）。
 *
 * 这一组断言里最重要的一条是**自动填充的登录不许续期**：如果每次登录都刷新记住时间，
 * 「每三个月重新输入一次密码」这句话就永远不会发生（登录页自动填好、用户点一下、时间被刷新）。
 * 那是"功能看起来有、其实没有"的典型，所以单独钉一条。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  REMEMBERED_PASSWORD_MAX_AGE_MS,
  isRememberedPasswordUsable,
  nextRememberedAt
} from '../src/shared/domain/remembered-login'

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_800_000_000_000

describe('记住密码：有效期与续期时机', () => {
  it('有效期就是 90 天（不是"三个自然月"）', () => {
    assert.equal(REMEMBERED_PASSWORD_MAX_AGE_MS, 90 * DAY)
  })

  it('刚记住时可用；第 90 天整仍然可用；第 90 天零 1 毫秒失效', () => {
    assert.equal(isRememberedPasswordUsable(T0, T0), true)
    assert.equal(isRememberedPasswordUsable(T0, T0 + 90 * DAY), true)
    assert.equal(isRememberedPasswordUsable(T0, T0 + 90 * DAY + 1), false)
  })

  it('中间那几天一直可用（没有"只在某几天有效"这种怪边界）', () => {
    for (const days of [1, 30, 45, 89, 90]) {
      assert.equal(isRememberedPasswordUsable(T0, T0 + days * DAY), true, `${days} 天`)
    }
  })

  it('没有记住时间时不可用（没记过）', () => {
    assert.equal(isRememberedPasswordUsable(undefined, T0), false)
  })

  it('时间戳不是有限数时不可用，而不是算出 NaN 后当成可用', () => {
    assert.equal(isRememberedPasswordUsable(Number.NaN, T0), false)
    assert.equal(isRememberedPasswordUsable(Number.POSITIVE_INFINITY, T0), false)
    assert.equal(isRememberedPasswordUsable(T0, Number.NaN), false)
  })

  it('系统时间被往回调时判为不可用：不可信的输入不延长有效期', () => {
    assert.equal(isRememberedPasswordUsable(T0, T0 - 1000), false)
  })

  it('用户亲手输入密码 ⇒ 记住时间更新为现在（开一个新的 90 天窗口）', () => {
    assert.equal(nextRememberedAt(T0, T0 + 91 * DAY, true), T0 + 91 * DAY)
  })

  it('**自动填充的登录不续期**：记住时间原样沿用', () => {
    const previous = T0
    const now = T0 + 30 * DAY
    assert.equal(
      nextRememberedAt(previous, now, false),
      previous,
      '自动填充续期会让"每三个月重新输入"永远不发生'
    )
  })

  it('自动填充 + 没有历史记住时间 ⇒ 不假装有（返回 undefined）', () => {
    assert.equal(nextRememberedAt(undefined, T0, false), undefined)
  })

  it('把一次完整的三个月周期走一遍', () => {
    // 第 0 天：用户亲手输入并勾选记住
    let rememberedAt = nextRememberedAt(undefined, T0, true)
    assert.equal(rememberedAt, T0)

    // 第 1..89 天：每天自动填充登录一次，窗口不动
    for (const days of [1, 10, 45, 89]) {
      const now = T0 + days * DAY
      assert.equal(isRememberedPasswordUsable(rememberedAt, now), true, `第 ${days} 天应当可用`)
      rememberedAt = nextRememberedAt(rememberedAt, now, false)
      assert.equal(rememberedAt, T0, `第 ${days} 天的自动填充不该改动记住时间`)
    }

    // 第 91 天：过期，必须重新输入
    const day91 = T0 + 91 * DAY
    assert.equal(isRememberedPasswordUsable(rememberedAt, day91), false)
    // 用户重新输入 ⇒ 新窗口从第 91 天开始
    rememberedAt = nextRememberedAt(rememberedAt, day91, true)
    assert.equal(rememberedAt, day91)
    assert.equal(isRememberedPasswordUsable(rememberedAt, day91 + 89 * DAY), true)
    assert.equal(isRememberedPasswordUsable(rememberedAt, day91 + 91 * DAY), false)
  })
})
