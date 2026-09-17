/**
 * 通道墙 —— 分屏档位（含按设备通道数裁剪）、分页、“格子模型”与通道数归因的
 * 唯一计算处（纯函数，无 Vue、无副作用）。
 *
 * 为什么这些计算必须离开模板
 * “第几页、这一页显示哪几格、删除设备后页码要不要回退”是四则运算，不是渲染。
 * 一旦把它们写进 `<template>` 里的 `slice()` 与三元表达式，这段逻辑就再也无法
 * 被单元测试直接调用（模板只能在浏览器里跑），而它恰好是最容易出错的部分：
 * 设备被删除后停留在最后一页，界面会显示“第 3 / 1 页”并且一个字都渲染不出来。
 * 所以模板只负责画，本文件负责算。
 *
 * 依赖纪律（与 `lib/channelState.ts` 同样的理由）
 * 本模块运行时不导入任何东西，只导入 `./channelState`（它自身也没有导入）。
 * 也就是说这里**不能**调用 `lib/format.channelLabel()`：`format.ts` 依赖
 * `@renderer/i18n`，会把 vue-i18n 拖进本模块的依赖图，而 `@renderer/*` 别名不会
 * 被 `scripts/rewrite-aliases.cjs` 重写，测试进程将无法加载它。通道标签（`CH3`）
 * 本身与语言无关，因此在这里就地实现，规则与 `format.channelLabel()` 完全一致
 * （协议里的通道号是 0 基的），并由单元测试钉死。
 */

import { CHANNEL_COUNT } from '@shared/domain/models'
import type { Channel, Device, DeviceKind, DeviceStatus } from '@shared/domain/models'
import { channelState, type ChannelState } from './channelState'

// ---------------------------------------------------------------------------
// 分屏档位
// ---------------------------------------------------------------------------

/**
 * 支持的档位，也是分段控件的渲染顺序。
 *
 * 声明成 `as const` 的元组而不是普通数组：模板 `v-for` 的顺序、持久化读回时的
 * 合法性校验、以及测试遍历的集合，三者因此来自同一处声明。
 *
 * 这一轮的档位是 **1 / 2 / 4 / 8**（产品要求「通道墙应该支持 1、2、4、8 通道」）。
 * 它仍然是**通道数**的档位，与相机墙（1 / 4 / 9 / 16：一格 = 一台相机，9 是安防
 * 标准的 3×3）**故意不同**：8 对应 AE08 的 8 路通道，1/2/4 是它的一半、四分之一
 * 与八分之一，每种档位下的格子都排得满（8 是 4 的整倍数、4 是 2 的、2 是 1 的）。
 */
export const CHANNEL_WALL_LAYOUTS = [1, 2, 4, 8] as const

/** 1 分屏 / 2 分屏（2×1）/ 4 分屏（2×2）/ 8 分屏（4×2）。 */
export type ChannelWallLayout = (typeof CHANNEL_WALL_LAYOUTS)[number]

/**
 * 首次打开时的默认档位。
 *
 * 选 4 而不是 1：总览页的第一诉求是“一眼看见哪些通道有问题”，2×2 在 1366×768 上
 * 仍然放得下，而 1 分屏一次只看得到一路，8 分屏的字又太小。可随时切换，并会被记住。
 */
export const DEFAULT_CHANNEL_WALL_LAYOUT: ChannelWallLayout = 4

/** 校验一个来路不明的值（localStorage、旧版本、手工改过的键）是不是合法档位。 */
export function isChannelWallLayout(value: unknown): value is ChannelWallLayout {
  return (CHANNEL_WALL_LAYOUTS as readonly unknown[]).includes(value)
}

/**
 * 一个档位能容纳多少格 —— 也就是“每页槽位数”。
 *
 * 名字容易读成“总共多少格”，所以这里写清楚：它只取决于档位，与当前有几路通道无关。
 * `8` 档真的给出 8 个槽位，剩不满一页的槽位由 `visibleTiles()` 原样少给几个，
 * 而不是补空格子：留空会让操作员以为那几路通道丢了。
 */
export function tileCount(layout: ChannelWallLayout): number {
  return layout
}

/** 每行几格：1 档一行一格，2 档 2×1，4 档 2×2，8 档 4×2。 */
export function layoutColumns(layout: ChannelWallLayout): number {
  if (layout === 1) return 1
  if (layout === 2) return 2
  if (layout === 4) return 2
  return 4
}

// ---------------------------------------------------------------------------
// 图形类型
// ---------------------------------------------------------------------------

/**
 * 通道墙可以显示的图形，也是图形切换器的渲染顺序。
 *
 * 产品要求「支持用户设置显示不同的图形，如声压线、频谱图、时谱图这些」。四个取值
 * 各自对应**设备端真实推送的一种载荷**，没有一种是本地造出来的替代品：
 *
 *   voiceprint   声纹图 —— 相机的 `/voiceprintData`（设备自己渲染好的 JPEG，
 *                实测 600×400，见 `shared/domain/fa371-stream.ts`）。
 *   spl          声压线 —— 声纹盒子的 `features` 流（`RealtimeFeature.spl`，dB）。
 *   spectrum     频谱图 —— 盒子的 `spectrum` 流（1024 点 + `binHz`），
 *                或相机的 `/fftData`（1024 条 int16 谱线，设备未上报采样率时横轴
 *                按谱线序号标注）。
 *   spectrogram  时谱图 —— 盒子的 `spectrogram` 流（`/time_freq_domain` 的 JPEG，
 *                设备端只保留最近 5 帧，与 `SpectrogramViewer.vue` 同一份数据）。
 *
 * **整面墙共用一种图形**，而不是逐格各选一种 —— 这是刻意取舍：格子来自同一批设备与
 * 通道，一格一种图形会让“这一屏在看什么”无法一句话说清，而且每种图形都要各自持久化
 * 一份逐格偏好，操作员下次打开时也记不住自己给哪一格选过什么。一种图形 + 一个切换器
 * 既满足「用户可以设置显示不同的图形」，又只有一条状态、一份持久化。
 */
export const CHANNEL_GRAPH_KINDS = ['voiceprint', 'spl', 'spectrum', 'spectrogram'] as const

export type ChannelGraphKind = (typeof CHANNEL_GRAPH_KINDS)[number]

/**
 * 首次打开时的图形。
 *
 * 选「声纹图」是因为它**就是这一轮之前通道墙在相机格上显示的那个东西**：默认值等于
 * 原行为，这一轮的变化因此只发生在操作员主动切换之后，而且默认档恰好是当前实测
 * 真能出图的那一种。
 */
export const DEFAULT_CHANNEL_GRAPH: ChannelGraphKind = 'voiceprint'

/** 校验一个来路不明的值（localStorage、旧版本、手工改过的键）是不是合法图形。 */
export function isChannelGraphKind(value: unknown): value is ChannelGraphKind {
  return (CHANNEL_GRAPH_KINDS as readonly unknown[]).includes(value)
}

// ---------------------------------------------------------------------------
// 格子模型
// ---------------------------------------------------------------------------

/**
 * 一格代表什么。
 *
 * 只有两种：声纹设备的一路通道，或一台声学相机。相机没有通道（见
 * `DeviceKind` 的说明与 `domain/deviceKind.*`），所以它固定占**一格**，
 * 而不是被塞进某个通道编号里 —— 那会凭空造出一个设备端并不存在的通道。
 */
export type ChannelWallTileSource = 'boxChannel' | 'cameraStream'

/**
 * 通道墙的一格。
 *
 * 刻意做成扁平结构而不是可辨识联合：模板里 `v-for` 出的每一项都要用 `v-if`
 * 分支取字段，联合类型在 Vue 模板中很难稳定收窄，扁平结构加注释反而更好维护。
 *
 * `state` 与 `channelIndex` 都是可选的，原因不是“懒得填”，而是**相机确实没有
 * 通道状态**：给它编一个 `'unknown'` 会让状态徽标显示“状态未知”，而那句话的
 * 含义是“这一路通道的启用状态还没读到”，用在相机上是假信息。相机格因此只显示
 * 设备在线状态，不显示通道状态。
 */
export interface ChannelWallTile {
  /** `v-for` 的 key：由设备 id + 来源 + 通道号组成，跨刷新保持稳定。 */
  key: string
  deviceId: string
  /** 设备名称，直接来自设备列表（用户可改）。 */
  deviceName: string
  /** 设备在线状态 —— 每一格都要能回答“这台设备现在通不通”。 */
  deviceStatus: DeviceStatus
  /** 设备家族，决定这一格画哪些内容。 */
  kind: DeviceKind
  source: ChannelWallTileSource
  /** 0 基通道号；相机格为 `undefined`（相机没有通道）。 */
  channelIndex?: number
  /** 通道标签（`CH3`）；相机格为空串。 */
  label: string
  /** 设备端上报的通道名，可能为空（设备没给名字，或这一格是相机）。 */
  channelName: string
  /** 通道启用状态；相机格为 `undefined`。 */
  state?: ChannelState
}

/** 构造器的输入：设备列表 + 已经加载到的通道表（与 `stores/devices.ts` 的形状一致）。 */
export interface ChannelWallSource {
  devices: readonly Device[]
  /** 按设备 id 索引的通道表；没有条目表示“这台设备的通道表还没读到”。 */
  channels: Readonly<Record<string, readonly Channel[]>>
}

/**
 * 通道标签（`CH1` … `CH8`）。
 *
 * 与 `format.channelLabel()` 同规则、同样 0 基。见文件头的“依赖纪律”：
 * 这里不能 import `lib/format`，否则本模块无法在测试进程里被加载。
 */
export function channelTileLabel(channelIndex: number): string {
  return `CH${channelIndex + 1}`
}

/**
 * 把设备与通道摊平成格子。
 *
 * 排序规则（稳定，且刻意不按状态排）
 *   1. **先按 `devices` 数组自身的顺序**。绝不把故障设备提前：设备在线/离线由健康
 *      监测每几秒翻转一次，若按状态排序，整面墙会在每次刷新时重新洗牌，操作员刚
 *      记住的“左上角那一路”就换了位置。通道墙是要挂在屏幕上看一整班的页面，
 *      “位置不变”比“故障排前面”更有价值 —— 故障靠徽标颜色表达，不靠位置。
 *   2. **设备内部按 `channelIndex` 升序**，与通道配置表、监测页的通道顺序一致。
 *   3. **相机没有通道，固定占一格**，位置就是它在设备列表里的位置。
 *
 *   结论：同一份设备/通道数据必然产出同一个数组，分页因此也是稳定的；
 *   设备列表的顺序不变时，同一个通道永远落在同一格上。
 *
 * 通道表尚未读到的设备**不产出任何格子**：凭空补出 CH1…CH8 会造出设备从没上报过的
 * 通道（与 `lib/channelState.ts` 拒绝把“没读到”当成“已启用”是同一条规矩）。
 * 这类设备由 `tilelessDevices()` 单独报出来，界面据此提示，而不是画假格子。
 */
export function buildTiles(source: ChannelWallSource): ChannelWallTile[] {
  const tiles: ChannelWallTile[] = []

  for (const device of source.devices) {
    if (device.kind === 'acousticCamera') {
      // 相机无通道：一台相机 = 一格。
      tiles.push({
        key: `camera:${device.id}`,
        deviceId: device.id,
        deviceName: device.name,
        deviceStatus: device.status,
        kind: device.kind,
        source: 'cameraStream',
        label: '',
        channelName: ''
      })
      continue
    }

    const channels = source.channels[device.id]
    if (!channels || channels.length === 0) continue

    // `[...channels]` 先复制再排序：`channels` 可能是 store 里的响应式数组，
    // 就地 `sort()` 会改动 store 的数据，属于在纯函数里制造副作用。
    const ordered = [...channels].sort((a, b) => a.channelIndex - b.channelIndex)
    for (const channel of ordered) {
      tiles.push({
        key: `box:${device.id}:${channel.channelIndex}`,
        deviceId: device.id,
        deviceName: device.name,
        deviceStatus: device.status,
        kind: device.kind,
        source: 'boxChannel',
        channelIndex: channel.channelIndex,
        label: channelTileLabel(channel.channelIndex),
        channelName: channel.channelName ?? '',
        // 状态判定只走 `channelState()` 一处：'unknown' 绝不能被读成“已启用”。
        state: channelState(channel)
      })
    }
  }

  return tiles
}

/**
 * 有设备、却没有格子的设备（当前只有一种：通道表还没读到的声纹设备）。
 *
 * 单独报出来是为了让界面能说一句实话：“这几台设备还没返回通道表”，而不是让
 * 这面墙在设备确实存在的情况下显示“暂无通道”。
 */
export function tilelessDevices(source: ChannelWallSource): Device[] {
  return source.devices.filter((device) => {
    if (device.kind === 'acousticCamera') return false
    const channels = source.channels[device.id]
    return !channels || channels.length === 0
  })
}

// ---------------------------------------------------------------------------
// 通道数：通道表是权威，设备回报只是兜底
// ---------------------------------------------------------------------------

/**
 * 一个「通道数」到底是怎么来的。
 *
 * 四态而不是一个数字，因为**数字相等不等于来源相同**：
 *   channelTable  已读回的通道表行数（`GET /get_passageway`）—— 权威来源；
 *   deviceReport  `GET /get_devinfo` 给的数字，而且它**不可能**是协议常量；
 *   noChannels    这台设备的家族根本没有通道（声学相机）—— `0` 是关于产品的**事实**，
 *                 不是「没读到」；
 *   unreported    没有可信的数字（什么都没读到，或者读到的正好是那个协议常量）。
 *
 * 为什么「正好等于协议常量」不算设备上报
 * 真机实测 `/get_devinfo` 的响应里**根本没有** `channel_num` 这类字段
 * （`docs/PROTOCOL-FINDINGS.md` §3.1：「也没有 `channel_num` 字段 —— 通道数需从
 * `/get_passageway` 的数组长度推导」），而 `mapDeviceInfo()` 在设备没给这个字段时会把
 * `CHANNEL_COUNT`(8) 填进 `DeviceInfo.channelCount`
 * （`src/main/services/device/protocol/mappers.ts`，那个函数自己的注释也这么写）。
 * 于是「设备上报了 8」与「设备什么都没上报」在渲染层看来是同一个 8，无法区分 ——
 * 把无法归因于设备的数字说成「设备上报的 8」，就是编造一个我们没有收到的数字。
 * 反过来，一个**不等于**协议常量的值不可能是那个兜底写出来的，它可以归因于设备。
 */
export type ChannelCountSource = 'channelTable' | 'deviceReport' | 'noChannels' | 'unreported'

export interface ChannelCountInput {
  /** 已读回的通道表行数；`null` / `0` / 负数表示这张表还没到手。 */
  channelTableCount?: number | null
  /** `GET /get_devinfo` 的 `channelCount`；`null` 表示这一次根本没读到设备信息。 */
  deviceReportedCount?: number | null
  /**
   * 设备家族。
   *
   * 声学相机**没有**通道这个概念（`DeviceKind` 的说明、`syntheticCameraInfo()` 里那个
   * `channelCount: 0`），所以它的 `0` 必须与声纹设备那条「8 只是协议兜底」的路分开：
   * 前者是产品事实，后者是缺失。
   */
  deviceKind?: DeviceKind
}

export interface ChannelCountResolution {
  /** 可以显示的通道数；`null` = 此刻没有可信的数字（界面据 `source` 说明原因）。 */
  count: number | null
  source: ChannelCountSource
}

/** 只接受真正的正整数；`0`、小数、`NaN` 一律当作「没有这个数」。 */
function positiveCount(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
  return value
}

/**
 * 界面该显示的通道数（纯函数，判定只有这一处）。
 *
 * 优先级就是权威性：通道表 > 相机（没有通道，0 是事实）> 设备回报 > 没有。
 * 第一档是**通道表**，因为只有 `/get_passageway` 真的列出了通道；第三档是设备回报，
 * 但只在它不可能来自协议兜底时才算（见 `ChannelCountSource`）。
 */
export function resolveChannelCount(input: ChannelCountInput): ChannelCountResolution {
  const fromTable = positiveCount(input.channelTableCount)
  if (fromTable !== null) return { count: fromTable, source: 'channelTable' }

  // 相机没有通道：这个 0 不是「没读到」，也不是协议常量兜底出来的。
  if (input.deviceKind === 'acousticCamera') return { count: 0, source: 'noChannels' }

  const reported = positiveCount(input.deviceReportedCount)
  if (reported !== null && reported !== CHANNEL_COUNT) {
    return { count: reported, source: 'deviceReport' }
  }
  return { count: null, source: 'unreported' }
}

// ---------------------------------------------------------------------------
// 档位裁剪：只提供这台设备真的用得上的档位
// ---------------------------------------------------------------------------

/**
 * 这面墙上**通道最多的那台设备**有多少路通道，数的是已加载的通道表。
 *
 * 为什么取「最多的一台」而不是「格子的总数」：档位的含义是「一屏能放下几路通道」，
 * 所以它要装得下最宽的那台设备，同时不该给出这台设备根本用不到的档位
 * （产品要求：2 路设备不该出现 4 分屏）。相机格不算 —— 相机没有通道。
 *
 * 一台设备的通道表都还没读到就返回 `null`：那是**未知**，不是 0 路。
 */
export function boxChannelCapacity(tiles: readonly ChannelWallTile[]): number | null {
  const perDevice = new Map<string, number>()
  for (const tile of tiles) {
    if (tile.source !== 'boxChannel') continue
    perDevice.set(tile.deviceId, (perDevice.get(tile.deviceId) ?? 0) + 1)
  }

  let capacity: number | null = null
  for (const count of perDevice.values()) {
    if (capacity === null || count > capacity) capacity = count
  }
  return capacity
}

/**
 * 分段控件要渲染哪几个档位（纯函数，模板里不做这个判断）。
 *
 * 规则（`capacity` = 最宽那台设备的通道数）：
 *   - 比 `capacity` 小的档位全部保留 —— 它们都是「一次看一部分」的合法用法；
 *   - 再补上**最小的能一屏装下 `capacity` 的那一档**（不是 2 的幂时才有用：
 *     3 路只用 1 / 2 就得翻两页才看得全）；
 *   - `capacity` 未知（一台设备的通道表都没读到）时不裁剪：未知不是 0 路。
 *
 * 于是实测的两种设备各自得到产品要求的那一组：
 *   2 路 -> 1 / 2 ； 8 路 -> 1 / 2 / 4 / 8。
 */
export function channelWallLayouts(tiles: readonly ChannelWallTile[]): ChannelWallLayout[] {
  const capacity = boxChannelCapacity(tiles)
  if (capacity === null) return [...CHANNEL_WALL_LAYOUTS]

  const options = CHANNEL_WALL_LAYOUTS.filter((layout) => layout <= capacity)
  const covering = CHANNEL_WALL_LAYOUTS.find((layout) => layout >= capacity)
  if (covering !== undefined && !options.includes(covering)) options.push(covering)
  return [...options]
}

/**
 * 此刻真正生效的档位。
 *
 * 持久化下来的档位可能是**上一台设备**留下的（先看 8 路盒子，后来换成 2 路盒子），
 * 而裁剪后的集合里已经没有它了。这里只做渲染层回退：优先取比它小的最大档位，
 * 没有更小的就取最小的那一档。
 *
 * **不写回 store**，理由与 `channelWallCollapsed()` 的三态相同：那是操作员的选择，
 * 换回原来那台设备时它还该是它。写回会把一次数据变化变成一次偏好改写。
 */
export function resolveChannelWallLayout(
  stored: ChannelWallLayout,
  tiles: readonly ChannelWallTile[]
): ChannelWallLayout {
  const options = channelWallLayouts(tiles)
  if (options.includes(stored)) return stored
  const smaller = options.filter((layout) => layout < stored)
  if (smaller.length > 0) return smaller[smaller.length - 1] as ChannelWallLayout
  return options[0] as ChannelWallLayout
}

// ---------------------------------------------------------------------------
// “有没有通道在线”与默认收起
// ---------------------------------------------------------------------------

/**
 * 这一格算不算“在线的一路通道”。
 *
 * 三条规矩，每条都有理由：
 *   - **相机不算**：相机没有通道（见 `ChannelWallTileSource`），而这面是**通道**墙；
 *     「没有通道在线」问的正是声纹通道。把相机算进去，一面只有相机、一路通道都没有的
 *     墙就会永远展开 —— 那恰好是产品要求收起的场景。
 *   - **设备离线的不算**：设备连不上，它那几路通道此刻不可能有数据。
 *   - **设备端明确关掉的（`disabled`）不算**：主进程不会为这一路开流。
 *     `'unknown'`（启用标志还没读回来）**算在线**：它只是还没读到，不是“不在线”；
 *     把它算成不在线，会让一面真有通道的墙在刷新的一瞬间自己收起来。
 */
export function isOnlineChannelTile(tile: ChannelWallTile): boolean {
  return (
    tile.source === 'boxChannel' &&
    tile.deviceStatus === 'ONLINE' &&
    tile.state !== 'disabled'
  )
}

/** 这面墙上有没有任何一路在线的通道。 */
export function hasOnlineChannel(tiles: readonly ChannelWallTile[]): boolean {
  return tiles.some((tile) => isOnlineChannelTile(tile))
}

/**
 * 这面墙上显示着多少路**通道**（「共 N 路通道」里的 N）。
 *
 * 只数 `boxChannel` 的格子。**相机格不是通道**（`ChannelWallTileSource` 的存在理由、
 * `buildTiles()` 让一台相机固定占一格的写法），把它的格子数进来就会让 8 路盒子 + 1 台
 * 相机显示「共 9 路通道」—— 设备上一共只有 8 路通道，这句话是假的。
 * 与 `isOnlineChannelTile()` 拒绝把相机算成「在线通道」是同一条规矩。
 *
 * 一台相机的格子仍然照常画，只是不计入通道数。
 */
export function channelTileCount(tiles: readonly ChannelWallTile[]): number {
  return tiles.filter((tile) => tile.source === 'boxChannel').length
}

/**
 * 默认要不要收起（产品要求：「如果没有通道在线就可以默认收起」）。
 *
 * 纯函数、只看格子：这个判断绝不允许写进模板 —— 它一旦住进 `<template>` 里的三元
 * 表达式，就再也无法被单元测试直接调用（文件头那段“模板只负责画，本文件负责算”）。
 */
export function defaultChannelWallCollapsed(tiles: readonly ChannelWallTile[]): boolean {
  return !hasOnlineChannel(tiles)
}

/**
 * 实际生效的收起状态：操作员显式选择过就以他的选择为准，没表过态就跟随数据。
 *
 * `override` 为 `null` 表示“他没表过态”。这个空档是必须的：收起是**视图偏好**，
 * “有没有通道在线”是**数据**。把两者压成一个布尔值存起来，就只能二选一地错一次 ——
 * 要么在数据变化时悄悄改写操作员的选择（他刚展开的墙自己收回去了），要么让
 * 「没有通道在线就收起」永不生效。分开之后：默认行为永远是产品要的那一条，
 * 操作员的每一次点按都算数。
 */
export function channelWallCollapsed(
  tiles: readonly ChannelWallTile[],
  override: boolean | null
): boolean {
  return override === null ? defaultChannelWallCollapsed(tiles) : override
}

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

/**
 * 总页数。
 *
 * 零格时返回 **1** 而不是 0：界面上“第 1 / 0 页”是一句没有意义的话，而且
 * `pageIndicator` 里的 `{total}` 会变成 0，让人以为分页坏了。空墙就是“一页，
 * 上面什么都没有”，由空状态文案解释原因。
 */
export function totalPages(tiles: readonly ChannelWallTile[], layout: ChannelWallLayout): number {
  return Math.max(1, Math.ceil(tiles.length / tileCount(layout)))
}

/**
 * 把页码夹进合法范围。
 *
 * 这是“删除设备后停在最后一页”的修复点：假设 4 分屏、共 9 格、当前第 3 页，
 * 此时删掉一台设备使总格数降到 3，第 3 页已经不存在。夹取后回到第 1 页，
 * 否则界面会显示“第 3 / 1 页”并且一格都不画（`visibleTiles()` 切出空数组）。
 *
 * 非数字、`NaN`、`0`、负数、小数一律当作第 1 页：它们只可能来自被手工改坏的
 * localStorage 或一次整数溢出，让它们变成“第一页”比抛错更符合界面逻辑。
 */
export function clampPage(
  page: number,
  tiles: readonly ChannelWallTile[],
  layout: ChannelWallLayout
): number {
  const last = totalPages(tiles, layout)
  if (!Number.isFinite(page)) return 1
  const floored = Math.floor(page)
  if (floored < 1) return 1
  return Math.min(floored, last)
}

/**
 * 当前页要画的格子。
 *
 * 页码先夹取再切片，所以调用方可以放心地把一个“可能过期”的 `page` 直接传进来：
 * 设备被删掉的那一刻，这里就已经回到了最后一页的第一格，不需要调用方自己先算一遍。
 * 不足一页时如实少给几格（不补空位，见 `tileCount()`）。
 */
export function visibleTiles<T extends ChannelWallTile>(
  tiles: readonly T[],
  layout: ChannelWallLayout,
  page: number
): T[] {
  const size = tileCount(layout)
  const start = (clampPage(page, tiles, layout) - 1) * size
  return tiles.slice(start, start + size)
}

// ---------------------------------------------------------------------------
// 一格能不能画出选中的图形
// ---------------------------------------------------------------------------

/**
 * 一格「画不出来」时的**真实原因**。
 *
 * 八种必须能分开，理由与相机面板同一条：一块空白、一个转圈，在值班台上都等于
 * 「不知道」。尤其是下面这几种，看起来一模一样而说的是完全不同的事：
 *   ready           有真实数据，画得出来
 *   no-such-data    这个设备家族根本没有这种载荷（盒子没有图像，相机没有时频通道）
 *   matrix-only     相机推的是数值矩阵而不是图像（离线 mock 的解码候选）
 *   other-session   数据流在**另一台**设备上
 *   stale           到过帧，但已经停了（画面停在最后一帧上，不能当实时值）
 *   no-frames       会话在跑，这一路却一帧都没有
 *   error           这一路自己报了错
 *   not-started     没有会话盯着这一格（未监测）
 */
export type ChannelGraphState =
  | 'ready'
  | 'no-such-data'
  | 'matrix-only'
  | 'other-session'
  | 'stale'
  | 'no-frames'
  | 'error'
  | 'not-started'

/**
 * 判定所需的**事实**，全部由调用方从 store 读出来。
 *
 * 判定函数自己不碰任何 store：它要能在没有浏览器、没有 Pinia 的进程里被直接断言
 * （这是本文件存在的全部理由）。优先级写在函数体里，而且只有那一处。
 */
export interface ChannelGraphFacts {
  /** 这一格的设备家族有没有选中的这种载荷。 */
  supported: boolean
  /** 已经拿到可画的真实数据。 */
  ready: boolean
  /** 这一路自己报了错。 */
  failed: boolean
  /** 收到的是数值矩阵，不是可显示的图像。 */
  matrixInsteadOfImage: boolean
  /** 会话在跑，但盯的是另一台设备。 */
  otherSession: boolean
  /** 到过帧，现在已经停了。 */
  stale: boolean
  /** 会话在跑，这一路却一帧都没有。 */
  awaitingFrames: boolean
  /** 有会话盯着这一格（含正在建立连接的会话）。 */
  monitored: boolean
}

/**
 * 一格此刻处于哪种状态。**顺序就是语义**：
 *   1. 设备家族没有这种载荷 —— 会话在不在、通不通都无关，这一格永远画不出这张图；
 *   2. 有真数据就画；
 *   3. 其余每一条都是“为什么没有”，按“离数据有多近”从中枢排到外围：
 *      报错 > 收到的东西不可显示 > 会话在别的设备上 > 停住了 > 一帧都没有 > 没在监测。
 */
export function channelGraphState(facts: ChannelGraphFacts): ChannelGraphState {
  if (!facts.supported) return 'no-such-data'
  if (facts.ready) return 'ready'
  if (facts.failed) return 'error'
  if (facts.matrixInsteadOfImage) return 'matrix-only'
  if (facts.otherSession) return 'other-session'
  if (facts.stale) return 'stale'
  if (facts.awaitingFrames) return 'no-frames'
  if (!facts.monitored) return 'not-started'
  // 会话在跑、也收到过帧，却没有可画的数据：最接近的说法仍然是“还没有能画出来的数据”。
  return 'no-frames'
}

// ---------------------------------------------------------------------------
// 折线几何
// ---------------------------------------------------------------------------

/**
 * 折线图的绘图区尺寸（SVG 用户坐标）。
 *
 * 固定成 100×40：格子多大由 CSS 缩放，形状因此与格子尺寸无关 —— 同一个档位下
 * 每一格的折线不会因为格子宽窄而变成另一条曲线。
 */
export const GRAPH_VIEW_WIDTH = 100
export const GRAPH_VIEW_HEIGHT = 40

/** 绘图区四周的留白：线不贴着格子边，缩放到 1 像素描边时也不会被裁掉。 */
export const GRAPH_VIEW_PADDING = 2

/** 一条折线的几何，以及它是由多少个**真实**点算出来的。 */
export interface GraphGeometry {
  /** `<polyline points>` 的值；有效点少于两个时是空串（一个点画不出线）。 */
  points: string
  /** 真的落进折线的点数（非有限值已被丢掉）。 */
  count: number
  min: number
  max: number
  /** 序列里最后一个**有效**值；一个有效值都没有时是 `null`。 */
  last: number | null
}

/** 保留两位小数：坐标只给 SVG 用，多余的精度只会让 DOM 变长（与 `layoutIcon.ts` 同规矩）。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 把一串真实数值摊成一条折线。
 *
 * 三条规矩，每条都对应一种会把“没有数据”画成“有数据”的错法：
 *   - **非有限值丢掉**，不当作 0。0 dB 是一个测量结果，而 `NaN` 根本不是测量；
 *     把坏帧画成 0，值班的人会以为环境很安静（文件头第 1 条）。
 *   - **全部相等时画在正中间**：`max - min` 为 0 会让每个点的坐标除以 0，整条线变成
 *     `NaN` 而一格都画不出来 —— 而“一直没变化”本身是有信息量的。
 *   - **点数不足两个时交回空串**：一个孤零零的点不是曲线，由调用方说明原因。
 *
 * 映射方向遵循 SVG：y 越小越靠上，所以**最大值在顶部**。
 */
export function graphGeometry(values: readonly number[]): GraphGeometry {
  const finite = values.filter((value) => Number.isFinite(value))
  const first = finite[0]
  if (first === undefined) return { points: '', count: 0, min: 0, max: 0, last: null }

  let min = first
  let max = first
  for (const value of finite) {
    if (value < min) min = value
    if (value > max) max = value
  }

  const span = max - min
  const width = GRAPH_VIEW_WIDTH - 2 * GRAPH_VIEW_PADDING
  const height = GRAPH_VIEW_HEIGHT - 2 * GRAPH_VIEW_PADDING
  const step = finite.length > 1 ? width / (finite.length - 1) : 0
  const points =
    finite.length < 2
      ? ''
      : finite
          .map((value, index) => {
            const x = GRAPH_VIEW_PADDING + index * step
            const y =
              span > 0
                ? GRAPH_VIEW_PADDING + (1 - (value - min) / span) * height
                : GRAPH_VIEW_PADDING + height / 2
            return `${round2(x)},${round2(y)}`
          })
          .join(' ')

  return {
    points,
    count: finite.length,
    min,
    max,
    last: finite[finite.length - 1] ?? null
  }
}
