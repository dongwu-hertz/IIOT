/**
 * 每通道声纹特性 —— "这一路**最后一次**读到的那个特征帧"。
 *
 * 为什么需要它
 * 设备一次只在一路通道上开流（MEASURED：`PROTOCOL-FINDINGS 4.3`，见 `monitor.ts` 的
 * `start()`），所以切到 CH3 之后 CH1 就不再送帧了。于是"每通道特性卡片"只有两种可能：
 * 切走之后变空白，或者记住上一路的读数。**记住，但必须带时间戳** ——
 * 12:03 的读数和 12:31 的读数在界面上不能长得一样，否则那是在把旧值当实时值卖。
 *
 * 为什么在这里而不是在 store 里
 * 与 `channelState.ts` 同一条理由：判定(1)哪些帧可以收、(2)一张卡片处在哪种状态，
 * 是这条功能的全部内容，而它必须能被单测逐条钉住（store 里没法单测）。
 *
 * 边界（防止这张表变成无界的内存）
 * 只有 `0..MAX_CHANNEL_INDEX` 的整数通道号会被收下。设备 JSON 里一个畸形的
 * `channel_id`（`'3'`、`-1`、`1e9`）会让这张表按垃圾键一直长下去 ——
 * 键域封顶 64 个之后，它最多只有 64 条。
 */
import type { RealtimeFeature } from '@shared/domain/models'

/** 收下的最大通道号（含）。声纹设备是 8 路、E2 是 16 路，64 是封顶而不是设备事实。 */
export const MAX_CHANNEL_INDEX = 63

/** 通道号 -> 该路最后一次读到的特征帧。 */
export type ChannelFeatureMap = Readonly<Record<number, RealtimeFeature>>

/**
 * 这一帧可以记下来吗。
 *
 * 只认**整数**且在 `0..MAX_CHANNEL_INDEX` 内的通道号：`'3'` 这种字符串键会同时通过
 * `==` 比较却与 `3` 不是同一个键，留着它会得到"CH3 有两份读数"这种查不出来的怪事。
 */
export function isRecordableChannel(channelId: unknown): boolean {
  return (
    typeof channelId === 'number' &&
    Number.isInteger(channelId) &&
    channelId >= 0 &&
    channelId <= MAX_CHANNEL_INDEX
  )
}

/**
 * 把一帧记进表里。
 *
 * 被拒的帧**原样返回旧表**（同一个引用）：调用方（store）把它赋回 ref 时不会触发
 * 一次无意义的响应式更新。
 */
export function recordChannelFeature(
  map: ChannelFeatureMap,
  frame: RealtimeFeature
): ChannelFeatureMap {
  if (!isRecordableChannel(frame.channelId)) return map
  const previous = map[frame.channelId]
  // 同一路通道的旧帧不许覆盖新帧：乱序到达（重连、切通道的尾巴）在真实链路上会发生。
  if (previous && previous.timestamp > frame.timestamp) return map
  return { ...map, [frame.channelId]: frame }
}

/** 读某一路的最后读数；没有就是 `null`（不是 0、不是空对象）。 */
export function channelFeatureFor(
  map: ChannelFeatureMap,
  channelId: number
): RealtimeFeature | null {
  return map[channelId] ?? null
}

/**
 * 每通道的**时间线**（通道号 -> 该路按时间排到的帧序列），检测模式 2×2 图的来源。
 *
 * 为什么需要它（业主 2026-09-21 第二批第 24 条的数据源结论）
 * 设备一次只在一路通道上开流（PROTOCOL-FINDINGS 4.3），`features` 缓冲只装**当前订阅**
 * 的那一路。所以"8 条通道叠在一根轴上"的真实口径只能是：**每次某通道有读数到达，就在
 * 该通道的序列里追加一个点** —— 通道内部连续，跨通道并不同步（CH1 在 12:00 的点与
 * CH3 在 12:05 的点之间没有任何"同时"的保证）。谁要是把这张图画成"8 路同步实时流"，
 * 就是编造设备做不到的事。
 *
 * 与 `ChannelFeatureMap`（每路只留**最后一帧**）是两张表：那张回答"这一路现在多少"，
 * 这张回答"这一路这段时间怎么变"。
 */
export type ChannelFeatureHistoryMap = Readonly<Record<number, readonly RealtimeFeature[]>>

/**
 * 把一帧追加进该通道的时间线，超出 `limit` 时丢掉最旧的。
 *
 * 边界与 `recordChannelFeature()` 同一套：
 *   - 畸形的通道号（`'3'` / `-1` / `1e9`）不收，键域封顶在 `0..MAX_CHANNEL_INDEX`；
 *   - 乱序的旧帧（重连、切通道的尾巴）不追加 —— 序列按时间单调，倒着排会让图**倒退**；
 *   - 被拒的帧原样返回旧表（同一个引用），不触发无意义的响应式更新。
 *
 * 每次合法追加都产生新数组：帧是 1 Hz 量级，复制一个 ≤ limit 的数组是 O(limit)，
 * 与 `pushCapped()` 同一本账。
 */
export function recordChannelFeatureHistory(
  map: ChannelFeatureHistoryMap,
  frame: RealtimeFeature,
  limit: number
): ChannelFeatureHistoryMap {
  if (!isRecordableChannel(frame.channelId)) return map
  const previous = map[frame.channelId]
  if (previous && previous.length > 0) {
    const last = previous[previous.length - 1] as RealtimeFeature
    // 乱序的旧帧不追加（序列按时间单调，倒着排会让图倒退）。
    if (last.timestamp > frame.timestamp) return map
    // 时间戳相同：后来的那一帧**替换**最后一个点（与 `recordChannelFeature` 同一套口径）——
    // 同一毫秒里的重发若是再追加一个点，时间轴上同一 x 会画出一条竖直的跳变。
    if (last.timestamp === frame.timestamp) {
      const next = [...previous]
      next[next.length - 1] = frame
      return { ...map, [frame.channelId]: next }
    }
  }
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1
  const next = previous ? [...previous, frame] : [frame]
  if (next.length > cap) next.splice(0, next.length - cap)
  return { ...map, [frame.channelId]: next }
}

/**
 * 一张通道卡片处在哪种状态。
 *
 * 三种状态必须视觉可分：
 *   live   这一路就是当前订阅的那一路，且帧真的在进来（"实时"）
 *   stored 有读数，但不是此刻在订阅的那一路（"最后一次读数 + 时间"）
 *   unread 从来没有读到过（"未读取"）—— 与"读到了 0"是两件事
 */
export type ChannelFeatureState = 'live' | 'stored' | 'unread'

export interface ChannelFeatureStateInput {
  /** 该通道是否是当前实时会话订阅的那一路。 */
  isActiveChannel: boolean
  /** 会话是否在运行。 */
  sessionRunning: boolean
  /** 当前会话已收到的特征帧数（主进程计数，或渲染层实收）。 */
  frameCount: number
  /** 表里这一路有没有读数。 */
  hasFeature: boolean
}

export function channelFeatureState(input: ChannelFeatureStateInput): ChannelFeatureState {
  if (!input.hasFeature) return 'unread'
  if (input.isActiveChannel && input.sessionRunning && input.frameCount > 0) return 'live'
  return 'stored'
}

export type ChannelFeatureStateLabelKey = `monitorUi.channelFeature_${ChannelFeatureState}`

/** 状态标签的目录 key；本模块不持有任何语言的文本。 */
export function channelFeatureStateLabelKey(
  state: ChannelFeatureState
): ChannelFeatureStateLabelKey {
  return `monitorUi.channelFeature_${state}` as ChannelFeatureStateLabelKey
}
