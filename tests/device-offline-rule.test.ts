/**
 * 设备离线的判定规则（`shared/domain/device-status.ts`）。
 *
 * 这一组断言对准的是**产品要求与 spec 规则打架的那一处**，所以每一条都写清楚它守的是哪一边：
 *
 *   - 产品要求：「离线的设备直接显示离线」——本进程从未见它在线的设备，第一次探测失败就该报离线；
 *   - spec 13.2：「A single timeout must NOT flip a device offline」——**见过它在线的**设备
 *     保留失败次数阈值，否则一次超时就会让界面闪（先是离线、下一轮又在线）。
 *
 * 两条能同时成立，靠的就是判据是 `observedOnline`（本进程亲眼见过）而不是数据库里那个
 * `status`（可能是旧会话留下的历史）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { shouldMarkOffline, shouldMarkPushDeviceOffline } from '../src/shared/domain/device-status'

const DEFAULT_THRESHOLD = 3

describe('离线判定：本进程从未见它在线的设备，第一次失败就报离线', () => {
  it('从未在线过 + 第一次失败 → 立刻离线（产品要求）', () => {
    assert.equal(
      shouldMarkOffline({ observedOnline: false, consecutiveFailures: 1, threshold: 3 }),
      true
    )
  })

  it('从未在线过时，阈值**不起作用**（否则新添加的设备要等 3 × 5 秒才显示离线）', () => {
    for (const threshold of [1, 3, 5, 99]) {
      assert.equal(
        shouldMarkOffline({ observedOnline: false, consecutiveFailures: 1, threshold }),
        true,
        `threshold=${threshold}`
      )
    }
  })

  it('见过它在线之后，阈值生效：1、2 次失败都还不算离线（spec 13.2 防抖动）', () => {
    assert.equal(
      shouldMarkOffline({ observedOnline: true, consecutiveFailures: 1, threshold: 3 }),
      false
    )
    assert.equal(
      shouldMarkOffline({ observedOnline: true, consecutiveFailures: 2, threshold: 3 }),
      false
    )
  })

  it('见过它在线时，达到阈值就离线（边界取到）', () => {
    assert.equal(
      shouldMarkOffline({ observedOnline: true, consecutiveFailures: 3, threshold: 3 }),
      true
    )
    assert.equal(
      shouldMarkOffline({ observedOnline: true, consecutiveFailures: 4, threshold: 3 }),
      true
    )
  })

  it('阈值是 1 时，见过它在线也要第一次失败就离线（配置说了算，不偷偷加保护）', () => {
    assert.equal(
      shouldMarkOffline({ observedOnline: true, consecutiveFailures: 1, threshold: 1 }),
      true
    )
  })

  it('阈值被配成 0 或负数时按 1 处理：不会出现"永远不离线"', () => {
    for (const threshold of [0, -1, -100]) {
      assert.equal(
        shouldMarkOffline({ observedOnline: true, consecutiveFailures: 1, threshold }),
        true,
        `threshold=${threshold}`
      )
    }
  })

  it('非整数阈值向下取整，不产生"要多失败半次"的怪边界', () => {
    assert.equal(
      shouldMarkOffline({ observedOnline: true, consecutiveFailures: 2, threshold: 2.9 }),
      true
    )
    assert.equal(
      shouldMarkOffline({ observedOnline: true, consecutiveFailures: 1, threshold: 2.9 }),
      false
    )
  })

  it('出厂默认（3 次）下，把两条规则并排摆一次', () => {
    const table = [
      { observedOnline: false, failures: 1, expected: true, why: '新设备：直接说离线' },
      { observedOnline: true, failures: 1, expected: false, why: '在线过：一次超时不算掉线' },
      { observedOnline: true, failures: 2, expected: false, why: '在线过：再等一轮' },
      { observedOnline: true, failures: 3, expected: true, why: '在线过：连续三次，判离线' }
    ]
    for (const row of table) {
      assert.equal(
        shouldMarkOffline({
          observedOnline: row.observedOnline,
          consecutiveFailures: row.failures,
          threshold: DEFAULT_THRESHOLD
        }),
        row.expected,
        `${row.why}（observedOnline=${row.observedOnline}, failures=${row.failures}）`
      )
    }
  })
})

describe('推送设备的离线判据：超时无遥测（业主 20260921 第 12 条）', () => {
  const INTERVAL = 1_000
  const THRESHOLD = 3
  const LIMIT = INTERVAL * THRESHOLD

  it('从未推过（last_seen 缺席）⇒ 离线 —— 与"没见过在线就直说离线"同一条口径', () => {
    assert.equal(
      shouldMarkPushDeviceOffline({ lastSeen: undefined, now: 1_000_000, healthCheckIntervalMs: INTERVAL, offlineFailureThreshold: THRESHOLD }),
      true
    )
  })

  it('时限之内（含边界）⇒ 在线：刚推过、以及正好等于 阈值×间隔 的那一刻', () => {
    const now = 1_000_000
    assert.equal(
      shouldMarkPushDeviceOffline({ lastSeen: now, now, healthCheckIntervalMs: INTERVAL, offlineFailureThreshold: THRESHOLD }),
      false,
      'last_seen = now 不该离线'
    )
    assert.equal(
      shouldMarkPushDeviceOffline({ lastSeen: now - LIMIT, now, healthCheckIntervalMs: INTERVAL, offlineFailureThreshold: THRESHOLD }),
      false,
      '恰好等于阈值×间隔 是"还在时限内"（超过才算离线）'
    )
  })

  it('超过 阈值×间隔 ⇒ 离线（超出一点就算）', () => {
    const now = 1_000_000
    assert.equal(
      shouldMarkPushDeviceOffline({ lastSeen: now - LIMIT - 1, now, healthCheckIntervalMs: INTERVAL, offlineFailureThreshold: THRESHOLD }),
      true
    )
  })

  it('间隔或阈值配成 0 / 负数时按 1 处理：不会出现"永不离线"', () => {
    const now = 1_000_000
    // 阈值 0 ⇒ 按 1 处理 ⇒ 时限 = 1000ms；1500ms 前推过 ⇒ 离线。
    assert.equal(
      shouldMarkPushDeviceOffline({ lastSeen: now - 1_500, now, healthCheckIntervalMs: INTERVAL, offlineFailureThreshold: 0 }),
      true
    )
    // 间隔 0 ⇒ 按 1ms 处理；任何过去的 last_seen 都超时。
    assert.equal(
      shouldMarkPushDeviceOffline({ lastSeen: now - 2, now, healthCheckIntervalMs: 0, offlineFailureThreshold: 1 }),
      true
    )
  })

  it('未来时间戳的 last_seen（时钟偏差）⇒ 在线，不会立刻误判离线', () => {
    assert.equal(
      shouldMarkPushDeviceOffline({ lastSeen: 2_000_000, now: 1_000_000, healthCheckIntervalMs: INTERVAL, offlineFailureThreshold: THRESHOLD }),
      false
    )
  })
})
