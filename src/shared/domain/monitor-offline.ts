/**
 * 「实时监测」这一页**没有活数据时**到底在说什么（业主 2026-09-18 第 10 批第 18 条：
 * 「实时检测无设备时显示该 IP 离线并显示上次内容」）。
 *
 * ---------------------------------------------------------------------------
 * 为什么这件事要一条状态机，而不是在模板里写三个 `v-if`
 * ---------------------------------------------------------------------------
 * 这一页有**四种**"没有活数据"的样子，而它们对操作员意味着完全不同的事：
 *
 *   | 状态 | 现场事实 | 屏幕上该说什么 |
 *   |---|---|---|
 *   | `no-device` | 一台设备都没加 | 「没有设备」+ 去添加（**没有 IP 可说**） |
 *   | `device-offline` | 这台设备的地址连不上 | 「**192.168.110.90 离线**」（IP 必须写出来）+ 上次内容 |
 *   | `waiting` | 设备在线，但一帧都还没来 | 「正在等待设备推送…」 |
 *   | `live` | 有帧，而且是新的 | （不提示） |
 *   | `stale` | 曾经有帧，现在停了 | 「数据已停止更新（最后一次 {time}）」+ 上次内容 |
 *   | `stopped` | 操作员自己按了停止 | 「已停止」+ 上次内容 |
 *
 * 写成一个纯函数是因为"哪一档"必须有**唯一**判据：同一屏上三处（徽标 / 提示条 / 图表角标）
 * 各判一次，迟早会出现"提示条说离线、图表说等待数据"这种自相矛盾的界面。
 *
 * **手册未说明**这一节：手册没有"实时监测页在没有数据时显示什么"这种要求，
 * 所以上面这六档与那句"显示上次内容"的口径都来自业主，阈值（3 秒）是我们定的。
 */

import type { DeviceStatus } from './models'

/**
 * 多久没有新帧就算"停止更新"。
 *
 * 3 秒是**我们定的**：主进程推的四路实时流正常时是 1 Hz 量级（特征帧），
 * 所以 3 秒没有一帧就说明这一路真的停了；而把它定成 1 秒会在网络抖动时频繁闪提示。
 */
export const MONITOR_STALE_AFTER_MS = 3_000

export type MonitorSourceState =
  | 'no-device'
  | 'device-offline'
  | 'waiting'
  | 'live'
  | 'stale'
  | 'stopped'

export interface MonitorSourceInput {
  /** 选中的那台设备在不在（没有设备时 IP 无从谈起）。 */
  hasDevice: boolean
  /** 设备的在线状态（`UNKNOWN` 按"还没确认"处理，不算离线）。 */
  deviceStatus?: DeviceStatus
  /** 会话状态（`idle` = 没在跑；`error` 也算"没有活数据"）。 */
  sessionState: 'idle' | 'starting' | 'running' | 'error'
  /** 最后一帧的时刻（毫秒）；一帧都没收到过就是 `undefined`。 */
  lastFrameAt?: number
  now: number
  staleAfterMs?: number
}

/**
 * 这一页现在处于哪一档。
 *
 * 判定顺序就是操作员的心智顺序：**有没有设备 → 设备通不通 → 有没有数据 → 数据新不新**。
 * 例如一台离线的设备即便主进程还留着上一帧，也必须是"离线"（"数据停了"这句话会
 * 把排查方向引到推送上去，而真正的问题是地址连不上）。
 */
export function monitorSourceState(input: MonitorSourceInput): MonitorSourceState {
  if (!input.hasDevice) return 'no-device'
  if (input.deviceStatus === 'OFFLINE') return 'device-offline'

  const hasFrame = typeof input.lastFrameAt === 'number' && Number.isFinite(input.lastFrameAt)
  if (!hasFrame) {
    // 已经停了、或者起不来，但一帧都没收到过 —— 说"等待"比说"上次内容"诚实
    // （没有上次内容可显示）。
    return input.sessionState === 'running' || input.sessionState === 'starting'
      ? 'waiting'
      : 'stopped'
  }

  const threshold = input.staleAfterMs ?? MONITOR_STALE_AFTER_MS
  if (input.now - (input.lastFrameAt as number) > threshold) return 'stale'
  if (input.sessionState === 'running' || input.sessionState === 'starting') return 'live'
  // 会话停了但刚才的帧还新鲜：那仍然是"上次内容"（例如刚按下停止）。
  return 'stopped'
}

/** 这一档要不要把**上次内容**留在屏幕上（`live` 之外都要留，否则屏幕会突然变空）。 */
export function monitorShowsLastContent(state: MonitorSourceState): boolean {
  return state !== 'no-device' && state !== 'live' && state !== 'waiting'
}

/**
 * 上图表的角标文案（`live` 之外都要标"这些不是实时数据"）。
 *
 * **提示条那一组键（`MONITOR_SOURCE_MESSAGE_KEYS` / `monitorSourceMessageKey()`）在
 * 2026-09-19 第 13 批第 1 条被删掉了**：业主说「实时监测里面如果有告警弹窗
 * （192.168.110.90 离线 还没有收到过这台设备的任何数据）这个内容不用显示」——
 * 那条提示条整个撤掉，它的正文键（`offlineBanner` / `waitingBanner` / `staleBanner` /
 * `stoppedBanner`）也跟着从四本目录里删了。角标留着：它说的是另一件事
 * （"你正在看的这份数据不是实时的"），而那句话**跟着数据走**（截图发出去时还在图上）。
 */
export function monitorStaleBadgeKey(state: MonitorSourceState): string | null {
  if (state === 'device-offline' || state === 'stopped') return 'monitorUi.staleBadge'
  if (state === 'stale') return 'monitorUi.staleBadge'
  return null
}

/**
 * 此刻该画**上次内容**还是活数据。
 *
 * 两个条件缺一不可（把它们抽成纯函数，是因为这是业主第 18 条里最容易做错的一步）：
 *   1. 上次内容必须属于**当前**的设备与通道 —— 切通道之后它是上一路的数据，
 *      把两个通道的信号画在一张图上比不画更糟；
 *   2. 状态必须是那几档"没有活数据"（`monitorShowsLastContent`）——
 *      在线且正在出帧时显示旧数据就是界面在说一件没发生的事。
 */
export function monitorUsesLastContent(input: {
  snapshot: { deviceId: string; channelId: number } | null
  deviceId: string
  channelId: number
  state: MonitorSourceState
}): boolean {
  const snapshot = input.snapshot
  if (!snapshot) return false
  if (snapshot.deviceId !== input.deviceId) return false
  if (snapshot.channelId !== input.channelId) return false
  return monitorShowsLastContent(input.state)
}
