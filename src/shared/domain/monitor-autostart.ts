/**
 * 「进入实时监测页、选中设备之后，默认就开始接收数据」——判定与唯一的住处。
 *
 * 业主 2026-09-19 第 13 批第 3 条（实时监测第 2 条）：
 *
 *   「实时监测里面选中哪个设备就默认开始接收数据，不用点击开始监测按钮」
 *
 * 所以这一条同时是**两件事**，少做哪一件都不算做完：
 *   1. 打开页面 / 切换设备时**自动开始**（本文将判定做成纯函数，可单测、可钉死）；
 *   2. 页头那个「开始监测 / 停止监测」按钮**删掉**（`MonitorView.vue`）。
 *
 * 为什么判定不能写在组件里
 *   自动开始会被**三条**路径问到：进页面（mount）、切换设备（`watch(deviceId)`）、
 *   设备从离线变成在线（状态推送）。三处各写一遍 `if` 一定会漂移，而漂移的后果不是
 *   界面难看，是**没有任何按钮可以补救**——按钮已经按业主的要求删了，自动开始漏掉
 *   一次，操作员就只能刷新页面。所以判定做成纯函数，三条路径调同一个它，测试直接钉死。
 *
 * 诚实的底线（与 `camera-autoplay.ts` 同一条规矩）
 *   本函数不做 I/O、不看时钟、不读存储，只回答「这一刻该不该开」。真正的连接由
 *   `monitor.start()` 去做，连接失败**不在这里**被说成成功：失败会落到会话状态
 *   （`error`）上，由页头那枚徽标如实显示。
 *
 * 为什么第一次尝试**不看在线状态**
 *   设备状态是本机探活的结果，可能比现实慢一拍（本机刚开机、设备刚上电）。如果拿它当
 *   门槛，"设备其实是好的、只是状态还没刷新"就会表现成**一片空白且没有按钮可点**——
 *   这正是业主抱怨的那类死路。所以规则是：**第一次总是试**（与改造前 `startSession()`
 *   无条件执行的行为一致），只有**已经失败过**（`attempts > 0`）才改由在线状态决定
 *   要不要再撞一次。这样既不比原来更保守，也不会对着离线设备反复开流。
 */

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/** 自动开始的结论：只有「开」和「先不开」两种，界面不需要第三态。 */
export type MonitorAutoStartAction = 'start' | 'skip'

/**
 * `skip` 的原因，全部是**事实**而不是失败：
 *
 *   no-stream            这一支没有我们要订的实时流（声学相机走自己的直播，
 *                        SN-16 空气声呐这一族还没有接入实时流）——绝不硬开一条
 *                        `/features_stream` 把好设备显示成"监测起不来"；
 *   no-device            还没选中设备（设备列表为空）；
 *   already-live         会话已经在跑（`running` / `starting`）：再 start 一次会重开
 *                        四条 WebSocket，等于把正在看的画面打断一次；
 *   device-offline       这台设备已经试过至少一次没成功，而它现在的状态是离线 ——
 *                        先等状态变成在线（那一次推送会重新问一次本函数）；
 *   attempts-exhausted   这台设备已经试满 `MONITOR_AUTOSTART_MAX_ATTEMPTS` 次：
 *                        不再进入重试循环（重试循环在离线设备上就是一条日志洪水）。
 */
export type MonitorAutoStartReason =
  | 'no-stream'
  | 'no-device'
  | 'already-live'
  | 'device-offline'
  | 'attempts-exhausted'

export interface MonitorAutoStartDecision {
  action: MonitorAutoStartAction
  /** `action === 'skip'` 时一定有值，其余情况为 `null`（不是 `undefined`，便于断言）。 */
  reason: MonitorAutoStartReason | null
}

/**
 * 同一个设备在一次页面停留里最多自动尝试几次。
 *
 * 3 次不是调出来的经验值，而是「一次失败 + 两次状态变化带来的重试」这个上限：
 * 状态推送只在**变化**时来，正常网络抖动最多给两次变化（离线→在线→离线），
 * 第 3 次之后还起不来的设备已经由页头徽标如实显示为 `error`，再试只是刷日志。
 */
export const MONITOR_AUTOSTART_MAX_ATTEMPTS = 3

export interface MonitorAutoStartInput {
  /**
   * 这一支有没有我们要订的实时流。
   *
   * 由调用方按机型算好（`MonitorView` 里就是 `isVoiceprint`）：相机与声呐都有
   * 「实时」字样，但都不是这一条 WebSocket 会话的事，把它们放进判定条件里
   * 就等于把机型知识复制一份到共享域。
   */
  hasLiveStream: boolean
  /** 当前选中的设备 id；没有选中给空串。 */
  deviceId: string
  /** 这台设备此刻的在线状态（本机探活的结果，可能慢一拍，见文件头）。 */
  deviceStatus: string
  /** 主进程里这一支的会话状态（`stores/monitor.ts` 的 `MonitorSessionState`）。 */
  sessionState: 'idle' | 'starting' | 'running' | 'error'
  /**
   * **会话此刻对着哪台设备**（`monitor.deviceId`）；没有会话给空串。
   *
   * 这一项不是可有可无的：`MonitorView` 切设备时是"先 `selectDevice()`、再
   * `start()`"，而 store 里的 `state` 直到 `start()` 内部跑起来才会变成 `starting`。
   * 只看 `sessionState` 的话，从 A 设备切到 B 设备时读到的还是 A 的 `running`，
   * 判定会回一句"已经在跑了"——**新设备的会话永远开不起来，而按钮已经删了**。
   * 所以"已经在跑"必须是"在跑**且跑的是这台设备**"。
   */
  sessionDeviceId: string
  /** **这一次页面停留里**已经为这台设备自动尝试过几次。切换设备时清零。 */
  attempts: number
}

/**
 * 该不该自动开始接收数据。
 *
 * 判定顺序就是函数的全部内容，每一步都对应一个可复现的事实：
 *   1. **没有这一族的实时流** —— 无事可做（相机/声呐那一支）；
 *   2. **没有设备** —— 页面自己会显示"请先添加设备"；
 *   3. **这台设备已经在跑** —— 什么都不做（这一条同时挡住切换通道引发的重复 start）；
 *   4. **试满次数** —— 不再重试；
 *   5. **已经失败过且状态是离线** —— 等一次状态变化，不撞必然失败的连接；
 *   6. 否则**开始**（第一次永远试，理由见文件头）。
 */
export function decideMonitorAutoStart(input: MonitorAutoStartInput): MonitorAutoStartDecision {
  if (!input.hasLiveStream) return { action: 'skip', reason: 'no-stream' }
  if (input.deviceId === '') return { action: 'skip', reason: 'no-device' }

  const live = input.sessionState === 'running' || input.sessionState === 'starting'
  if (live && input.sessionDeviceId === input.deviceId) {
    return { action: 'skip', reason: 'already-live' }
  }

  if (input.attempts >= MONITOR_AUTOSTART_MAX_ATTEMPTS) {
    return { action: 'skip', reason: 'attempts-exhausted' }
  }

  if (input.attempts > 0 && input.deviceStatus !== 'ONLINE') {
    return { action: 'skip', reason: 'device-offline' }
  }

  return { action: 'start', reason: null }
}
