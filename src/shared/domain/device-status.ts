/**
 * 设备在线状态的判定规则（纯函数，零依赖）。
 *
 * ---------------------------------------------------------------------------
 * 为什么这条规则要单独存在
 * ---------------------------------------------------------------------------
 * 健康检查每 `healthCheckIntervalMs`（出厂 5 秒）扫一遍所有设备，每次探测失败都会问一遍
 * 「现在能不能说它离线了」。这个判断以前写在 `DeviceService.markFailed()` 里，而它是
 * **不可测的**：要验证"第一次失败就该报离线"得先造一个真的会超时的 HTTP 传输。
 * 而这条规则恰好是那种"一改就会让界面说假话"的判断，所以它必须能单独被断言。
 *
 * ---------------------------------------------------------------------------
 * 规则本身，以及它为什么不是"单次失败就离线"
 * ---------------------------------------------------------------------------
 * spec 13.2 明确写过「A single timeout must NOT flip a device offline」，理由是**抖动**：
 * 一台刚才还在线的设备因为一次超时被写成离线、下一轮又变回在线，界面上会闪，而操作员会
 * 以为设备在反复掉线。所以对"我们亲眼见它在线的设备"保留 `offlineFailureThreshold`
 * （出厂 3）次失败才翻牌。
 *
 * 但那条理由的前提是**我们见过它在线**。一台本进程从未见它在线的设备没有可抖动的状态：
 * 它要么是刚添加的、要么上次会话就已经不在了。让它继续显示「未知」，只是把"我们还没打听到"
 * 当成一种状态 —— 而产品要求是「离线的设备直接显示离线」。
 *
 * 所以判据是**本进程是否亲眼见过它在线**（`observedOnline`），不是数据库里那个 `status`：
 * 数据库里的 `ONLINE` 可能是一次**旧会话**留下的历史，把它当成"刚才还在"会让每次重启之后
 * 每台设备都白等 3 × 5 秒才肯说离线。
 */

export interface OfflineVerdictInput {
  /** 本进程是否**亲眼**观察到过它在线（`DeviceRuntime.observedOnline`）。 */
  observedOnline: boolean
  /** 连续失败次数，含本次。 */
  consecutiveFailures: number
  /** 配置的失败次数阈值（`offlineFailureThreshold`，出厂 3）。 */
  threshold: number
}

/**
 * 现在能不能把它标成离线。
 *
 * `threshold` 小于 1 时按 1 处理：配置成 0 或负数意味着"立刻离线"，而"等 0 次失败"
 * 与"等 1 次失败"在这里是同一件事（本次失败已经数过一次），写成 1 免得出现 `0 <= 0`
 * 这种靠巧合成立的判断。
 */
export function shouldMarkOffline(input: OfflineVerdictInput): boolean {
  if (!input.observedOnline) return true
  const threshold = Math.max(1, Math.floor(input.threshold))
  return input.consecutiveFailures >= threshold
}
