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
 * 启动阶段同样需要防抖。数据库中的设备可能在应用启动后的第一轮探测时遇到网卡初始化、
 * 登录握手或相机服务短暂未就绪；如果第一次失败就翻成 OFFLINE，会造成“打包后所有设备都离线”
 * 的假象。因此无论本进程是否已经观察到过 ONLINE，都统一达到 `offlineFailureThreshold` 后再翻牌。
 * 任意一次成功仍立即恢复 ONLINE。
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
  // Startup must not turn every saved device OFFLINE because the very first probe
  // races network/auth/service initialization. Use the configured debounce threshold
  // for both newly observed and previously observed devices; any successful probe
  // still recovers the device to ONLINE immediately.
  const threshold = Math.max(1, Math.floor(input.threshold))
  return input.consecutiveFailures >= threshold
}

/**
 * 推送设备（`pushDevice`）的离线判据（业主 20260921 第 12 条）。
 *
 * 与上面那条是**两种设备、两种证据**：
 *
 *   - 主动连的设备（声纹/相机/听诊）：证据是"我们问、它答"，离线 = 连续探测失败够多次；
 *   - 推送设备：我们**从不问它**（没有地址、没有凭据），证据只剩"它上次推数据是什么时候" ——
 *     所以离线 = `last_seen` 距今超过 `offlineFailureThreshold × healthCheckIntervalMs` 没有遥测。
 *
 * 这样一台停推的推送设备会在"阈值 × 轮询间隔"之后如实显示离线，而健康检查对推送设备
 * 不发任何 HTTP 请求（`DeviceService.checkOne()` 里的轻分支）。
 *
 * `lastSeen` 缺席（从未推过 —— 例如刚添加）按**离线**处理：与"本进程从未见它在线的设备
 * 第一次失败就报离线"是同一条产品口径（「离线的设备直接显示离线」），而一次成功的遥测
 * 会立刻把它翻回在线。间隔与阈值都按至少 1 处理：配成 0 或负数不会出现"永不离线"。
 */
export interface PushOfflineVerdictInput {
  /** 最近一次收到遥测的时间（`devices.last_seen`）；缺席 = 从未收到过。 */
  lastSeen: number | undefined
  /** 当前时间（epoch ms）。 */
  now: number
  /** 健康检查轮询间隔（`healthCheckIntervalMs`）。 */
  healthCheckIntervalMs: number
  /** 失败次数阈值（`offlineFailureThreshold`，出厂 3）。 */
  offlineFailureThreshold: number
}

export function shouldMarkPushDeviceOffline(input: PushOfflineVerdictInput): boolean {
  if (input.lastSeen === undefined) return true
  const intervalMs = Math.max(1, Math.floor(input.healthCheckIntervalMs))
  const threshold = Math.max(1, Math.floor(input.offlineFailureThreshold))
  return input.now - input.lastSeen > intervalMs * threshold
}
