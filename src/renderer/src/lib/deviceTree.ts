/**
 * 左侧栏设备树的**模型**（纯函数，零 Vue、零副作用、零 I/O）。
 *
 * 一棵能用的操作台树要回答四个问题，而它们全都是计算而不是渲染：
 *   1. 屏幕上现在应当**从上到下**看到哪些行（展开状态 + 筛选的合力）；
 *   2. 按一下方向键之后焦点去哪一行（键盘导航不是「能 Tab 就行」）；
 *   3. 每个节点各自的状态是什么（设备在线/离线、通道启用/未启用/未知）；
 *   4. 选中一个节点要跳到哪个地址（与路由双向同步的那一半）。
 * 把这些写进 `<template>` 之后它们就只能靠鼠标与肉眼验证，而本模块可以被
 * `tests/device-tree.test.ts` 直接断言。
 *
 * 依赖纪律（与 `lib/channelState.ts` / `lib/cameraWall.ts` 同一条）
 * 只依赖 `@shared/domain/*` 与同目录的 `./channelState`：`@renderer/*` 别名不会被
 * `scripts/rewrite-aliases.cjs` 重写，引了它本模块就无法在测试进程里被加载。
 *
 * 「通道状态」**只**走 `channelState()` 一处
 * 「未启用」和「状态未知」必须可区分（见 `lib/channelState.ts` 的文件头），
 * 树上再实现一遍是这条规矩最容易被破坏的地方，所以这里直接调用它。
 */

import type { Channel, Device, DeviceKind, DeviceStatus } from '@shared/domain/models'
import { channelState, type ChannelState } from './channelState'

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

/**
 * 节点的种类。
 *
 * `root` 只是一个标题行（「设备拓扑」），它不可选中、不可导航到任何页面，
 * 存在的意义是让树的层级与「设备总数」有一个归属。
 */
export const DEVICE_TREE_NODE_KINDS = ['root', 'device', 'channel', 'stream'] as const
export type DeviceTreeNodeKind = (typeof DEVICE_TREE_NODE_KINDS)[number]

/** 设备树上的一行。 */
export interface DeviceTreeNode {
  /** 稳定且唯一的 id，同时是展开状态的键（`root` / `device:<id>` / …）。 */
  id: string
  kind: DeviceTreeNodeKind
  /** 树上的层级，0 是根。缩进与键盘导航都用它。 */
  depth: number
  /** 主显示文字：设备名，或通道名（设备上报，可能为空）。 */
  label: string
  /**
   * 通道节点的固定标签（`CH1` …）。
   *
   * 与 `label` 分开而不是二选一：设备上报的通道名可能是「1 号风机」这种完全
   * 覆盖 `CH3` 的名字，而现场核对接线时需要的是**通道号**，两者都要显示。
   */
  channelLabel?: string
  /** 子节点。`root` 与设备是分支，通道与相机流节点是叶子。 */
  children: DeviceTreeNode[]
  /** 分支节点当前是否展开。叶子恒为 `false`。 */
  expanded: boolean
  /** `channel` 节点专属：这一路通道的状态（由 `channelState()` 判定）。 */
  channelState?: ChannelState
  /** `device` 节点专属。 */
  deviceStatus?: DeviceStatus
  /** `device` 节点专属：设备家族，决定图标与「能不能进视频墙」。 */
  deviceKind?: DeviceKind
  /** `device` 节点专属：设备家族，决定图标与「能不能进视频墙」。 */
  deviceId?: string
  /** `channel` 节点专属。 */
  channelIndex?: number
  /**
   * 这一行是不是「设备」—— 只有设备行可以被选中并导航。
   * 单独给出布尔值而不是让模板写 `node.kind === 'device'`：树上的可选中规则
   * 是一件事，散进模板就会有第二份。
   */
  selectable: boolean
}

/** 构树需要的输入：设备列表 + 已加载的通道表 + 展开状态。 */
export interface DeviceTreeSource {
  devices: readonly Device[]
  /** 按设备 id 索引的通道表；没有条目表示「这台设备的通道表还没读到」。 */
  channels: Readonly<Record<string, readonly Channel[]>>
  /** 已展开的节点 id 集合。 */
  expanded: ReadonlySet<string>
  /** 筛选关键字；空串表示不过滤。 */
  filter?: string
}

/** 根节点的 id。 */
export const DEVICE_TREE_ROOT_ID = 'root'

/** 设备节点的 id。 */
export function deviceNodeId(deviceId: string): string {
  return `device:${deviceId}`
}

/** 通道节点的 id。 */
export function channelNodeId(deviceId: string, channelIndex: number): string {
  return `channel:${deviceId}:${channelIndex}`
}

/** 相机流节点的 id。 */
export function streamNodeId(deviceId: string): string {
  return `stream:${deviceId}`
}

/** 通道在树上的显示名（`CH1` …），与监控页的 `channelLabel()` 同规则（0 基）。 */
export function treeChannelLabel(channelIndex: number): string {
  return `CH${channelIndex + 1}`
}

/** 通道行的完整文字（`CH3 风机 A`）；只有通道号时就是通道号。 */
export function treeChannelText(channelLabel?: string, channelName?: string): string {
  return [channelLabel ?? '', channelName ?? '']
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ')
}

/**
 * 设备行在树上的显示名。
 *
 * **声学相机的地址不进树**（产品要求）。相机的 uid 是从 `ip:port` 铸出来的
 * （`main/services/device/camera-identity.ts` 解释了原因：FA371 的开放接口里
 * 没有任何一个返回设备身份），操作员不给名字时 `device-service` 会兜出一个
 * **以地址为名**的标签（`Acoustic Camera 192.168.110.235`）。那个地址因此不是
 * 「用户起的名字」，而是一份缺失身份的补丁 —— 把它画在树上就是拿地址冒充名字。
 *
 * 判定是纯的，而且**只看「名字是不是由这台设备的地址推出来的」**：
 *   1. 名字与地址完全相同（`192.168.110.235`）；
 *   2. 名字以地址结尾（`Acoustic Camera 192.168.110.235`）。
 * 操作员自己起过名字（哪怕是「3 号塔相机」）两条都不成立，原样显示；`
 * 因此这里不靠「名字里有没有点」这种猜测，也不会误伤一个合法的名字。
 *
 * `fallback` 是本地语言里对这种设备的称呼（`deviceTreeUi.kindCamera`），由调用方
 * 传入：本模块是纯函数，不碰目录。
 */
export function treeDeviceLabel(
  device: Pick<Device, 'name' | 'kind' | 'ip'>,
  fallback: string
): string {
  const name = device.name.trim()
  if (name === '') return fallback
  const ip = (device.ip ?? '').trim()
  if (ip === '') return name
  if (name === ip || name.endsWith(ip)) return fallback
  return name
}

// ---------------------------------------------------------------------------
// 构树
// ---------------------------------------------------------------------------

/**
 * 构建整棵树（**不受筛选影响**：筛选只改「哪些行可见」，不改变拓扑）。
 *
 * 设备内部的通道按 `channelIndex` 升序，与通道配置表、监控页的通道标签一致；
 * 通道表尚未读到的设备**不产出通道节点**，而是给一个「尚未读取到通道表」的
 * 说明节点 —— 凭空补出 CH1…CH8 会造出设备从没上报过的通道（与
 * `lib/channelState.ts` 拒绝把「没读到」当成「已启用」是同一条规矩）。
 */
export function buildDeviceTree(source: DeviceTreeSource): DeviceTreeNode {
  const deviceNodes = source.devices.map((device) => deviceNodeOf(device, source))
  // 设备之间保持设备列表自身的顺序：健康监测每几秒会翻转在线状态，按状态排序
  // 会让树在操作员手底下重新洗牌。
  return {
    id: DEVICE_TREE_ROOT_ID,
    kind: 'root',
    depth: 0,
    label: '',
    children: deviceNodes,
    expanded: source.expanded.has(DEVICE_TREE_ROOT_ID),
    selectable: false
  }
}

function deviceNodeOf(device: Device, source: DeviceTreeSource): DeviceTreeNode {
  const children: DeviceTreeNode[] = []

  if (device.kind === 'acousticCamera') {
    // 相机没有通道，只有一路实时视频：树上一个叶子节点，双击它就等于「在视频墙
    // 里打开这台相机」。
    children.push({
      id: streamNodeId(device.id),
      kind: 'stream',
      depth: 2,
      label: '',
      children: [],
      expanded: false,
      selectable: false,
      deviceId: device.id
    })
  } else {
    const channels = source.channels[device.id]
    if (channels && channels.length > 0) {
      const ordered = [...channels].sort((a, b) => a.channelIndex - b.channelIndex)
      for (const channel of ordered) {
        children.push({
          id: channelNodeId(device.id, channel.channelIndex),
          kind: 'channel',
          depth: 2,
          // `label` 是设备上报的通道名（可能为空），`channelLabel` 是固定的 `CH3`。
          label: channel.channelName ?? '',
          channelLabel: treeChannelLabel(channel.channelIndex),
          children: [],
          expanded: false,
          // 状态判定只走 `channelState()`：'unknown' 绝不能被读成「已启用」。
          channelState: channelState(channel),
          selectable: false,
          deviceId: device.id,
          channelIndex: channel.channelIndex
        })
      }
    } else {
      // 通道表还没到手：给出一个不可选的说明行，而不是八个假通道。
      children.push({
        id: `${deviceNodeId(device.id)}:channels-unknown`,
        kind: 'channel',
        depth: 2,
        label: '',
        children: [],
        expanded: false,
        channelState: 'unknown',
        selectable: false,
        deviceId: device.id
      })
    }
  }

  return {
    id: deviceNodeId(device.id),
    kind: 'device',
    depth: 1,
    label: device.name,
    children,
    expanded: source.expanded.has(deviceNodeId(device.id)),
    deviceStatus: device.status,
    deviceKind: device.kind,
    deviceId: device.id,
    selectable: true
  }
}

// ---------------------------------------------------------------------------
// 筛选
// ---------------------------------------------------------------------------

/** 归一化筛选关键字：去空格 + 小写（大小写不敏感是操作台的默认期待）。 */
export function normaliseTreeFilter(filter: string | undefined): string {
  return (filter ?? '').trim().toLowerCase()
}

/**
 * 这台设备是否匹配关键字。
 *
 * 匹配**名称、地址、设备 id、设备家族**，以及（如果给了通道表）**通道名与通道号**：
 * 现场设备名常常是「1 号主变」这种编号，而工程师手里可能只有一个 IP 或通道名
 * （「风机 A」装在几号箱子上，他不见得记得）。几样都要能查到。
 *
 * 命中**通道**时返回的是设备行本身：先看到设备、再看到高亮的通道，比一条孤立的
 * 通道行更有用（通道行本身不带设备身份，操作员无法据此选择设备）。
 */
export function matchesDeviceFilter(
  device: Device,
  filter: string | undefined,
  channels?: readonly Channel[]
): boolean {
  const needle = normaliseTreeFilter(filter)
  if (needle === '') return true
  const haystack = [device.name, device.ip, device.deviceUid, device.id, device.kind]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()
  if (haystack.includes(needle)) return true
  if (!channels) return false
  return channels.some((channel) => {
    const name = typeof channel.channelName === 'string' ? channel.channelName : ''
    return `${name} ${treeChannelLabel(channel.channelIndex)}`.toLowerCase().includes(needle)
  })
}

// ---------------------------------------------------------------------------
// 摊平（模板就是按这个数组渲染的）
// ---------------------------------------------------------------------------

/** 摊平的结果 + 可见的节点 id 顺序（键盘导航用的就是后者）。 */
export interface FlattenedTree {
  rows: DeviceTreeNode[]
  /** 所有可见行的 id，按屏幕顺序；键盘上下就是在它上面移动。 */
  visibleIds: string[]
}

/**
 * 把树摊平成一行一行 —— **模板唯一的渲染输入**。
 *
 * 递归 `v-for` 在 Vue 里要写一个自引用组件，而树的深度在这里是固定的三层；
 * 摊平之后模板只画一个数组，键盘导航也能直接对着同一个数组算。
 *
 * 筛选生效时**所有分支都当作展开**：否则「搜到了设备但它的通道看不见」会让人
 * 以为筛选没生效。筛选不改变树的拓扑，只决定哪些行进入渲染数组。
 */
export function flattenDeviceTree(source: DeviceTreeSource): FlattenedTree {
  const tree = buildDeviceTree(source)
  const filtering = normaliseTreeFilter(source.filter) !== ''
  const rows: DeviceTreeNode[] = []

  const deviceMatches = new Map<string, boolean>()
  for (const device of source.devices) {
    deviceMatches.set(
      device.id,
      matchesDeviceFilter(device, source.filter, source.channels[device.id])
    )
  }

  const rootVisible = !filtering || [...deviceMatches.values()].some((matched) => matched)

  /**
   * 递归时把「设备不匹配」的子树整棵剪掉。
   *
   * 只在设备行上判断 `expanded` 是不够的：不剪的话筛选会把**所有**设备行都留在
   * 屏幕上（它们不是靠 expanded 进来的，是在这里 push 的），筛选等于没生效。
   */
  const walk = (node: DeviceTreeNode): void => {
    if (node.kind === 'device' && node.deviceId !== undefined) {
      if (!deviceMatches.get(node.deviceId)) return
    }
    rows.push(node)
    const open =
      node.kind === 'root' || (filtering && node.children.length > 0) || node.expanded
    if (!open) return
    for (const child of node.children) walk(child)
  }

  if (rootVisible) {
    rows.push(tree)
    if (tree.expanded || filtering) {
      for (const device of tree.children) walk(device)
    }
  }

  return { rows, visibleIds: rows.map((row) => row.id) }
}

/** 可见的行里能被选中的那些（设备行）。 */
export function selectableIds(rows: readonly DeviceTreeNode[]): string[] {
  return rows.filter((row) => row.selectable).map((row) => row.id)
}

/** 从「设备节点 id」里取回设备 id；不是设备节点时返回 `null`。 */
export function deviceIdOfNodeId(nodeId: string | undefined): string | null {
  if (!nodeId || !nodeId.startsWith('device:')) return null
  const rest = nodeId.slice('device:'.length)
  return rest === '' ? null : rest
}

// ---------------------------------------------------------------------------
// 键盘导航
// ---------------------------------------------------------------------------

/**
 * 按键 -> 动作。模板只负责把 `event.key` 交进来。
 *
 * 动作的语义与所有成熟的操作台树一致（Windows 资源管理器 / VSCode 侧栏）：
 *   ArrowDown / ArrowUp     移动到下一行 / 上一行
 *   ArrowRight              收起时展开；已展开时进入第一个子行
 *   ArrowLeft               展开时收起；已收起时回到父行
 *   Enter / Space           选中当前设备行（导航到它的监控页）
 *   Home / End              第一行 / 最后一行
 */
export type TreeKey = 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight' | 'Enter' | ' ' | 'Home' | 'End'

export function isTreeKey(key: string): key is TreeKey {
  return (
    key === 'ArrowDown' ||
    key === 'ArrowUp' ||
    key === 'ArrowLeft' ||
    key === 'ArrowRight' ||
    key === 'Enter' ||
    key === ' ' ||
    key === 'Home' ||
    key === 'End'
  )
}

/** 导航的结果：新的焦点行，以及要执行的动作。 */
export interface TreeNavigation {
  /** 新的焦点节点 id（可能是 `null`：树是空的）。 */
  focusId: string | null
  /** `'toggle'` 是展开/收起当前行，`'select'` 是打开它，`'none'` 只移动焦点。 */
  action: 'none' | 'toggle' | 'select'
}

/**
 * 这一行是**可折叠的分支**吗。
 *
 * 「有子节点」不等于「是分支」：一台相机的唯一子节点是它的实时视频叶子，
 * 而那不是一个可折叠的分组 —— 把相机当分支处理会让「右键展开、回车打开」
 * 全部失效（回车会被当成展开/收起，设备永远打不开）。所以分支只认两种：
 * 根，以及**有通道子节点**的设备。
 */
function isBranch(row: DeviceTreeNode): boolean {
  if (row.kind === 'root') return true
  if (row.kind !== 'device') return false
  return row.children.some((child) => child.kind === 'channel')
}

/** 找到 `id` 的父行（按 depth 往回找最近的一个更浅的行）。 */
function parentIndexOf(rows: readonly DeviceTreeNode[], index: number): number {
  const depth = rows[index]?.depth ?? 0
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if ((rows[cursor]?.depth ?? 0) < depth) return cursor
  }
  return -1
}

/**
 * 方向键的计算。
 *
 * `focusId` 是当前焦点行；`null` 表示还没有焦点（第一次按方向键时落在第一行）。
 * 返回值**一定是可见行里的一个 id**，所以调用方可以放心地把它交给模板。
 */
export function navigateTree(
  rows: readonly DeviceTreeNode[],
  focusId: string | null,
  key: TreeKey
): TreeNavigation {
  if (rows.length === 0) return { focusId: null, action: 'none' }

  if (focusId === null) {
    const first = rows[0]
    return { focusId: first?.id ?? null, action: 'none' }
  }

  const index = rows.findIndex((row) => row.id === focusId)
  if (index < 0) {
    // 焦点行被筛选掉了：落到第一行，而不是让键盘彻底失去作用。
    return { focusId: rows[0]?.id ?? null, action: 'none' }
  }

  const row = rows[index] as DeviceTreeNode

  switch (key) {
    case 'ArrowDown': {
      const next = rows[Math.min(index + 1, rows.length - 1)]
      return { focusId: next?.id ?? row.id, action: 'none' }
    }
    case 'ArrowUp': {
      const previous = rows[Math.max(index - 1, 0)]
      return { focusId: previous?.id ?? row.id, action: 'none' }
    }
    case 'Home':
      return { focusId: rows[0]?.id ?? null, action: 'none' }
    case 'End':
      return { focusId: rows[rows.length - 1]?.id ?? null, action: 'none' }
    case 'ArrowRight': {
      if (!isBranch(row)) return { focusId: row.id, action: 'none' }
      if (!row.expanded) return { focusId: row.id, action: 'toggle' }
      // 已展开：进入第一个子行（它就是下一行，但这里按 id 取，避免依赖顺序）。
      const child = row.children[0]
      return { focusId: child?.id ?? row.id, action: 'none' }
    }
    case 'ArrowLeft': {
      if (isBranch(row) && row.expanded) return { focusId: row.id, action: 'toggle' }
      const parent = parentIndexOf(rows, index)
      return { focusId: parent >= 0 ? (rows[parent]?.id ?? row.id) : row.id, action: 'none' }
    }
    case 'Enter':
    case ' ': {
      // 分支行上的回车/空格 = 展开收起（与资源管理器一致）；设备行 = 打开。
      if (isBranch(row)) return { focusId: row.id, action: 'toggle' }
      if (row.selectable) return { focusId: row.id, action: 'select' }
      return { focusId: row.id, action: 'none' }
    }
    default:
      return { focusId: row.id, action: 'none' }
  }
}

// ---------------------------------------------------------------------------
// 展开状态
// ---------------------------------------------------------------------------

/** 默认展开的节点：设备（这样一进应用就能看到通道），不展开根。 */
export function defaultExpandedIds(devices: readonly Device[]): string[] {
  return devices.map((device) => deviceNodeId(device.id))
}

/** 在展开集合上加/去一个节点，返回**新数组**（Pinia/localStorage 都好存）。 */
export function toggleExpanded(expanded: readonly string[], nodeId: string): string[] {
  const set = new Set(expanded)
  if (set.has(nodeId)) set.delete(nodeId)
  else set.add(nodeId)
  return [...set]
}

/** 全部展开（根 + 所有设备）。 */
export function expandAllIds(devices: readonly Device[]): string[] {
  return [DEVICE_TREE_ROOT_ID, ...defaultExpandedIds(devices)]
}

/**
 * 从 localStorage 读回来的展开集合里剔掉已经不存在的节点 id。
 *
 * 不剔的话，删掉设备再重新添加一个同 id 的设备会「继承」上一次的展开状态，
 * 而这台设备的 id 是数据库自增的、可能被复用；更重要的是集合会无限增长。
 */
export function pruneExpandedIds(expanded: readonly string[], devices: readonly Device[]): string[] {
  const alive = new Set<string>([DEVICE_TREE_ROOT_ID, ...defaultExpandedIds(devices)])
  return expanded.filter((id) => alive.has(id))
}

// ---------------------------------------------------------------------------
// 选择 -> 路由
// ---------------------------------------------------------------------------

/**
 * 选中一台设备要跳到哪里。
 *
 * 监控页（`/monitor?device=<id>`）而不是设备详情页：产品要求的是「在左栏展开拓扑、
 * 据此选择不同的设备」，而操作员选设备是为了**看它**。详情页仍然从「设备管理」
 * 进入，路由表一个字都没改。
 */
export function monitorRouteForDevice(deviceId: string): { path: string; query: Record<string, string> } {
  return { path: '/monitor', query: { device: deviceId } }
}

/**
 * 从任意来源到达 `/monitor` 时，哪一台设备应当被高亮。
 *
 * 优先级：查询串 > store 里记住的那台 > 列表第一台。查询串优先是因为它才是
 * 「到达这个页面」这件事本身携带的信息（刷新、外链、后退都靠它）。
 */
export function selectedDeviceForRoute(
  queryDevice: unknown,
  storedDeviceId: string,
  devices: readonly Device[]
): string {
  const fromQuery = typeof queryDevice === 'string' ? queryDevice.trim() : ''
  if (fromQuery !== '' && devices.some((device) => device.id === fromQuery)) return fromQuery
  if (storedDeviceId !== '' && devices.some((device) => device.id === storedDeviceId)) {
    return storedDeviceId
  }
  return devices[0]?.id ?? ''
}
