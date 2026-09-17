/**
 * 通道状态识别 —— 8 通道声纹设备“这一路通道开着吗”的唯一判定处。
 *
 * 为什么必须只有一处
 * 同一个问题会在实时监测的通道选择器、通道配置表、设备卡片和历史筛选下拉里
 * 各出现一次。判断散进四个模板之后，早晚有一处会忘记更新，而最危险的写法是
 * 把“还没查询过”当成“已启用”：那会让一台从未连通的设备看起来一切正常。
 *
 * 状态规则（本模块是唯一定义处）
 *   enabled === true        -> 'enabled'  设备明确报告该通道已开启
 *   enabled === false       -> 'disabled' 设备明确报告该通道未开启
 *   enabled 缺失/非布尔值   -> 'unknown'  从未成功读取过该通道（绝不是“已启用”）
 *   undefined / null        -> 'unknown'  连通道行都还没有（设备端没返回通道表）
 *
 * `disabled` 与 `unknown` 必须视觉可区分：前者是“明确被关掉”，后者是“不知道”。
 * 把两者合成同一种灰，会让“设备还没查通”看起来像“通道被人关掉了”。
 *
 * 与实时数据无关（刻意的分离）
 * `enabled` 是设备端持久化的配置事实；`channelReceivesData()` 回答的是另一个
 * 问题——“这一路此刻有没有数据”。两者不能折叠成一个标志位：配置为关闭，和
 * 开着但没有数据，是工程师必须能分开的两种故障。
 */

/** 声纹设备的一路通道是开启、关闭，还是状态未知。 */
export type ChannelState = 'enabled' | 'disabled' | 'unknown'

/**
 * 解析器的输入形状，故意比 `Channel` 宽松。
 *
 * `enabled` 声明为 `unknown` 而不是 `boolean`，因为这条数据一路经过设备 JSON
 * （`GET /get_passageway`）、协议映射、本地数据库与 IPC，任何一环都可能给出
 * `0`/`'true'` 或干脆没有这个字段。宽松的输入让“接到脏数据”变成 `'unknown'`，
 * 而不是被 `=== true` 悄悄判成已启用。
 *
 * 领域模型 `Channel` 与配置视图 `ChannelConfigView` 都满足这个形状
 * （`enabled: boolean` 是 `unknown` 的子类型），所以两处共用同一个解析器。
 */
export interface ChannelStateInput {
  enabled?: unknown
}

/**
 * 判定一路通道的状态。
 *
 * 只有字面量 `true` 才算已启用：`1`、`'true'`、`undefined` 全部归入 `'unknown'`，
 * 因为“设备说它开着”和“我们猜它开着”是两件事（见文件头）。
 */
export function channelState(channel: ChannelStateInput | undefined | null): ChannelState {
  if (!channel) return 'unknown'
  if (channel.enabled === true) return 'enabled'
  if (channel.enabled === false) return 'disabled'
  return 'unknown'
}

/**
 * 模板使用的类名：一个基础类 + 一个状态修饰类。
 *
 * 所有表面复用同一个修饰类，未启用的通道才会在任何列表里都是同一种灰；
 * `unknown` 拿到另一个修饰类，禁止它与 `disabled` 共用同一种样式。
 */
export function channelStateClass(state: ChannelState): string {
  return `channel-state channel-state--${state}`
}

/** 状态标签的目录 key（模板只拿 key，绝不在这里存放任何语言的文本）。 */
export type ChannelStateLabelKey = `channelState.${ChannelState}`

/** 状态标签的目录 key：`channelState.enabled` / `.disabled` / `.unknown`。 */
export function channelStateLabelKey(state: ChannelState): ChannelStateLabelKey {
  return `channelState.${state}` as ChannelStateLabelKey
}

/** 状态提示的目录 key；已启用的通道不需要提示，所以返回空串表示“不加 title”。 */
export type ChannelStateHintKey = 'channelState.disabledHint' | 'channelState.unknownHint' | ''

/**
 * 悬停/读屏提示的目录 key。
 *
 * 已启用时返回空串而不是一句“已启用”：一个正常工作的通道加提示只会增加噪音，
 * 而调用方用 `hint || undefined` 就能同时应付 `title` 和 `aria-label`。
 */
export function channelStateHintKey(state: ChannelState): ChannelStateHintKey {
  if (state === 'disabled') return 'channelState.disabledHint'
  if (state === 'unknown') return 'channelState.unknownHint'
  return ''
}

/** 判断“此刻是否有数据”所需要的、与配置无关的事实。 */
export interface ChannelActivity {
  /** 该通道是否是当前实时会话正在订阅的那一路。 */
  isActiveChannel: boolean
  /** 实时会话是否正在运行。 */
  sessionRunning: boolean
  /** 该通道已收到的帧数（主进程计数，或渲染进程实际收到的帧数）。 */
  frameCount: number
}

/**
 * 该通道此刻是否真的在产出数据。
 *
 * 与 `channelState()` 是两件独立的事实，故意不合并：
 *  - `enabled === false` 且无数据 —— 通道被关掉，这是配置问题；
 *  - `enabled === true`  且无数据 —— 通道开着却没有数据，这是链路/传感器问题。
 * 工程师需要区分这两者，所以本函数只看运行状态与帧计数，从不读 `enabled`。
 */
export function channelReceivesData(activity: ChannelActivity): boolean {
  return activity.isActiveChannel && activity.sessionRunning && activity.frameCount > 0
}

export type ChannelActivityLabelKey = 'channelState.liveActive' | 'channelState.liveSilent'

/** 实时数据指示灯的目录 key。 */
export function channelActivityLabelKey(receiving: boolean): ChannelActivityLabelKey {
  return receiving ? 'channelState.liveActive' : 'channelState.liveSilent'
}
