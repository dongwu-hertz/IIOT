/**
 * 多通道同时显示 —— "勾选的那几路，各一条趋势线 + 每路四个读数"。
 *
 * 业主 2026-09-24：声纹设备的实时检测界面要能同时看多路数据，勾选的通道都放在
 * 同一张卡片里，靠**线的颜色**区分（每条线一个颜色，图例带通道号）。
 *
 * ---------------------------------------------------------------------------
 * 为什么这张表要如实带"每一路自己的时刻"
 * ---------------------------------------------------------------------------
 * 实测（PROTOCOL-FINDINGS 4B）：`/features_stream` 的订阅 ping 里**没有**通道参数，
 * 它推的是"设备当前通道"。所以"多路同时刷新"能不能成立，取决于设备固件是否按连接
 * 绑定通道 —— 这一条**尚未在真机验证**（见 docs/PROTOCOL-FINDINGS.md §4B.4）。
 *
 * 于是这里的口径是**只用帧里自带的 `cur_ch` 说话**，一个字都不猜：
 *   - 每一路的点来自**该路自己的帧**（`cur_ch` 等于这一路），x 是该帧的到达时刻；
 *   - 某一路没收到帧就是 `unread`（画布上不画线，行里写"未收到这一路"），
 *     绝不把上一路的值搬过来、也不补 0 —— 补 0 会被读成一个真实测量值；
 *   - 有帧但已经超过 `staleAfterMs` 没再更新，就写"更新于 <时刻>"，让人一眼看出这是旧读数。
 *
 * **"实时"的判据是新鲜度，不是"我点着的那一路"**（`channelFeatureLiveness`）：
 * 多通道订阅下每一路各有一条连接，任何一路只要帧在进来就是实时的。这一条比原来那条
 * 更严 —— "我请求了它"不说明设备在推，"5 秒内到过帧"才说明。
 *
 * 换句话说：这张表**不能**证明几路是同步的（跨通道也不保证同步，见
 * `lib/channelFeatures.ts` 的口径），它只负责把每一路真实收到的东西画清楚。
 *
 * 纯逻辑放在这里（不放进 store / 组件）的理由与 `channelFeatures.ts` 相同：
 * "哪些点能画、一路处在哪种状态"是这条功能的全部内容，必须能被单测逐条钉住。
 */

import type { RealtimeFeature } from '@shared/domain/models'
import type { TrendMetric } from '@shared/domain/trend'
import { trendChannelColor } from '@shared/domain/trend'
import { MAX_FEATURE_CHANNELS } from '@shared/domain/monitoring'
import {
  channelFeatureLiveness,
  MAX_CHANNEL_INDEX,
  type ChannelFeatureHistoryMap,
  type ChannelFeatureState
} from './channelFeatures'

/** 一路在一张图里需要的全部东西。 */
export interface ChannelSeries {
  /** 0 起的通道号（与设备一致）。 */
  channelId: number
  /** 界面用的 1 起编号：`CH1`…（不是翻译文本，与其它页面同一写法）。 */
  label: string
  /** 这一路的线色；同一路两次打开之间颜色不变（`shared/domain/trend.ts`）。 */
  color: string
  /** 窗口内、且这个量有数值的点，按时间升序。 */
  points: Array<{ x: number; y: number }>
  /** 这一路最后一次读到的整帧（含窗口外的旧帧）；从未读到就是 null。 */
  latest: RealtimeFeature | null
  /** 这一路最后一次收到帧的时刻；从未收到就是 null。 */
  lastAt: number | null
  /** 距 `now` 多久没有新帧（毫秒）；从未收到就是 null。 */
  ageMs: number | null
  /** 这一路是不是操作员点着的那一路（只影响"当前"标记，不影响实时判定）。 */
  isActive: boolean
  /** `live` 实时 / `stored` 旧读数 / `unread` 从未收到。 */
  state: ChannelFeatureState
}

export interface BuildChannelSeriesInput {
  /** 勾选的通道（原样传进来即可，内部会规范化）。 */
  watchedChannels: readonly number[]
  /** 每通道时间线，来自 `stores/monitor.ts` 的 `channelFeatureHistory`。 */
  history: ChannelFeatureHistoryMap
  /** 画哪个量；只影响 `points`，`latest` 始终是整帧。 */
  metric: TrendMetric
  /** 走时的"现在"（`store.now`），用来算窗口与新鲜度。 */
  now: number
  /** 趋势窗口，例如 60_000。 */
  windowMs: number
  /** 当前订阅（点选）的那一路，只用来标"当前"；实时与否由新鲜度决定。 */
  activeChannel: number
  /** 会话是否在跑；停了就都只能是 `stored`。 */
  sessionRunning: boolean
  /** 多久没新帧就不算实时；默认 5 秒（特征帧实测约 1 Hz）。 */
  staleAfterMs?: number
}

/**
 * 特征帧的实测节奏约 1 Hz（PROTOCOL-FINDINGS 4.3），所以"5 秒没有新帧"意味着
 * 至少漏了 4 帧 —— 那时候还标"实时"就是在骗人。
 */
export const CHANNEL_SERIES_STALE_AFTER_MS = 5_000

/** 界面上的通道名：设备侧 0 起，界面 1 起（与其它页面一致）。 */
export function channelSeriesLabel(channelId: number): string {
  return `CH${channelId + 1}`
}

/**
 * 勾选列表的规范化：去重、升序、只留合法通道号，并**封顶**在 `MAX_FEATURE_CHANNELS`。
 *
 * 封顶不是界面洁癖：一条勾选 = 主进程一条 `/features_stream` 连接，设备与 IPC 的
 * 代价随路数线性增长（PROTOCOL-FINDINGS 4.3）。超出的部分**丢弃而不是报错**，
 * 因为这是界面状态（勾选框），不是用户输入。
 */
export function normalizeWatchedChannels(channels: readonly number[]): number[] {
  const seen = new Set<number>()
  const result: number[] = []
  for (const channel of channels) {
    if (!Number.isInteger(channel) || channel < 0 || channel > MAX_CHANNEL_INDEX) continue
    if (seen.has(channel)) continue
    seen.add(channel)
    result.push(channel)
  }
  result.sort((left, right) => left - right)
  return result.slice(0, MAX_FEATURE_CHANNELS)
}

/** 勾选/取消一路；返回新数组（调用方赋回 ref，不原地改）。 */
export function toggleWatchedChannel(
  channels: readonly number[],
  channelId: number
): number[] {
  if (!Number.isInteger(channelId) || channelId < 0 || channelId > MAX_CHANNEL_INDEX) {
    return normalizeWatchedChannels(channels)
  }
  const current = normalizeWatchedChannels(channels)
  const next = current.includes(channelId)
    ? current.filter((channel) => channel !== channelId)
    : [...current, channelId]
  return normalizeWatchedChannels(next)
}

/**
 * 把每通道时间线切成"可画的几条线"。
 *
 * 顺序即勾选顺序（升序的通道号），所以图例与表格的行序稳定；`activeChannel`
 * 不特殊对待 —— 它只影响状态判定，不搬动行的位置（否则点一下通道，整张表会跳）。
 */
export function buildChannelSeries(input: BuildChannelSeriesInput): ChannelSeries[] {
  const staleAfter = input.staleAfterMs ?? CHANNEL_SERIES_STALE_AFTER_MS
  const from = input.now - input.windowMs
  const watched = normalizeWatchedChannels(input.watchedChannels)

  return watched.map((channelId) => {
    const frames = input.history[channelId] ?? []
    const last = frames.length > 0 ? (frames[frames.length - 1] as RealtimeFeature) : undefined
    const points = frames
      .filter((frame) => frame.timestamp >= from)
      .map((frame) => ({ x: frame.timestamp, y: Number(frame[input.metric]) }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))

    const lastAt = last ? last.timestamp : null
    const ageMs = lastAt === null ? null : input.now - lastAt
    /*
     * 实时 = 帧在进来（新鲜度），不是"我点着这一路"。多通道订阅下每一路各有一条连接，
     * 所以别的通道也可能是实时的 —— 这一条判据把这件事说对（见 `channelFeatureLiveness`）。
     */
    const state = channelFeatureLiveness({
      sessionRunning: input.sessionRunning,
      hasFeature: last !== undefined,
      ageMs,
      staleAfterMs: staleAfter
    })

    return {
      channelId,
      label: channelSeriesLabel(channelId),
      color: trendChannelColor(channelId),
      points,
      latest: last ?? null,
      lastAt,
      ageMs,
      isActive: channelId === input.activeChannel,
      state
    }
  })
}

/**
 * 迷你趋势的 SVG path（`viewBox="0 0 100 100"` + `preserveAspectRatio="none"`）。
 *
 * 画在 `2..98` 而不是 `0..100`：描边宽度算在线的中心，贴边画会被 SVG 视口裁掉一半，
 * 于是"这条线到底有没有到头"看起来像是数据被截断了。
 *
 * 少于两点返回空串 —— 一个点连不成线，画出来只是一个看不见的零长度路径，
 * 而调用方（表格）会因此以为"有趋势可看"。空串让它可以按"没有趋势"处理。
 */
export function seriesSparkPath(points: readonly { x: number; y: number }[]): string {
  const usable = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
  if (usable.length < 2) return ''
  const xs = usable.map((point) => point.x)
  const ys = usable.map((point) => point.y)
  const xMin = Math.min(...xs)
  const xMax = Math.max(...xs)
  let yMin = Math.min(...ys)
  let yMax = Math.max(...ys)
  // 一条平线（或只有一个不同的值）也要画在格子中间，而不是贴着上边或下边。
  if (yMax === yMin) {
    yMax += 1
    yMin -= 1
  }
  const xSpan = xMax === xMin ? 1 : xMax - xMin
  return usable
    .map((point, index) => {
      const px = 2 + ((point.x - xMin) / xSpan) * 96
      const py = 2 + (1 - (point.y - yMin) / (yMax - yMin)) * 96
      return `${index === 0 ? 'M' : 'L'}${px.toFixed(2)},${py.toFixed(2)}`
    })
    .join(' ')
}
