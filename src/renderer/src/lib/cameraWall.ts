/**
 * 多路实时视频墙的**模型**（纯函数，零 Vue、零副作用、零 I/O）
 *
 * 为什么这些判断必须离开模板
 * 「同一内容只能出现一次」「还能不能再开一路」「设备被删掉时那一格怎么办」
 * 「哪一格能出声」都**由模型决定**，不是渲染。写进 `<template>` 之后它们就再也没法
 * 被单元测试直接调用（模板只能在浏览器里跑），而它们恰好是最容易出错的部分：
 * 同一内容的播放出现在两格里会让主进程的第二路 start 把第一格顶掉；超过并发预算
 * 那一路如果只显示一个永远转的圈，操作员会以为相机坏了
 *
 * 依赖纪律（与 `lib/channelState.ts` 同一条）
 * 本模块运行时不导入 `@renderer/*`：`scripts/rewrite-aliases.cjs` 只重写
 * `@shared/` 与 `@main/`，所以引了 `@renderer/*` 的模块无法在测试进程里被加载
 * 因此这里只依赖 `@shared/domain/*`（纯类型与纯函数）
 *
 * 「同一内容最多一次」与「一次可以开多路相机」是两条不同的规则
 *   - 前者（业主 2026-09-21 批）：墙上一格的身份是 **(源 id, 视图)** —— 同一台相机的
 *     画面与时域图是**两个不同的内容**，允许各占一格；同一个 (id, view) 全墙唯一，
 *     重复放置 = 移动（`findWallItem()` / `assignCamera()` 保证），双击/拖拽/下拉
 *     三条入口走的是同一个函数。只有 `play` 视图占 RTSP 会话，所以「已经在别格」
 *     的拒绝（`already-shown`）只在目标是播放、且别格已有同 id 的播放时成立；
 *   - 后者（本机主进程能不能同时扛住 N 路） `cameraStreamLimitReached()`
 *     决定，上限来自 `AppSettings.maxConcurrentCameraStreams`
 *
 * 放不进窗口的内容进**轮询队列**（业主 2026-09-21 批「超出窗口数自动轮询」）：
 * 被替换下来的 (id, view) 不丢弃，排在 `queue` 里等 `rotateWallOnce()` 逐格轮换。
 * 队列只在内存里（与格子分配一样不持久化），`normaliseCameraWallModel()` 负责把
 * 坏输入修成合法队列。
 */

import type { Channel, Device, DeviceKind, DeviceStatus } from '@shared/domain/models'
import {
  cameraStreamLimitReached,
  isCameraLiveActive,
  type CameraLiveState
} from '@shared/domain/camera-live'
// 通道状态只 `channelState()` 一处：通道节点的「未启用/状态未知」判定与本模
// 的其他决定一样，不允许在第二处重新实现。`channelState.ts` 自身零依赖，
// 因此这不会把 `@renderer/*` 拖进本模块的依赖图（见文件头的依赖纪律）
import { channelState, type ChannelState } from './channelState'
import { createUniformDivision, validateDivision, type CameraDivision } from './cameraViewDivision'
import {
  isManualRtspId,
  normaliseManualRtspSources,
  parseManualRtspUrl,
  type ManualRtspSource
} from '@shared/domain/rtsp-source'
import {
  DEFAULT_CAMERA_CELL_VIEW,
  availableCellViews,
  isCameraCellViewMode,
  type CameraCellSourceKind,
  type CameraCellViewMode
} from '@shared/domain/camera-cell-view'

// ---------------------------------------------------------------------------
// 分屏档位
// ---------------------------------------------------------------------------

/**
 * 支持的档位，也是分段控件的渲染顺序
 *
 * 1 / 4 / 9 / 16 是安防行业的标准四档（iVMS-4200 的默认视图就是这四套，见
 * `docs/Ivms4200-UX-REFERENCE.md` §1.1），9 分屏 3×3 — 产品负责人明确要
 *  9 换掉原来 8
 *
 * 刻意自持这一份档位数组、不与其它「墙」共用：视频墙的一格是一台相机，档位
 * 只是几何排布；两处共用一个数组，会让「其中一面墙想改档位」变成对另一面墙的
 * 意外改动；`tests/camera-wall.test.ts` 会断言这套档位**各自**是什么，而不是
 * 断言它们相同
 */
export const CAMERA_WALL_LAYOUTS = [1, 4, 9, 16] as const

export type CameraWallLayout = (typeof CAMERA_WALL_LAYOUTS)[number]

/**
 * 首次打开时的默认档位
 *
 * 4 而不 1：多路视频墙存在的理由就是「一次看几路」，4 分屏在 1366×768 上
 * 仍然放得下；16 分屏在核显机器上等于同时解 16 路 H.264，作为默认值太激进
 */
export const DEFAULT_CAMERA_WALL_LAYOUT: CameraWallLayout = 4

export function isCameraWallLayout(value: unknown): value is CameraWallLayout {
  return (CAMERA_WALL_LAYOUTS as readonly unknown[]).includes(value)
}

/** 一个档位有多少 — 也就是「同时最多几路画面」
*/
export function cameraCellCount(layout: CameraWallLayout): number {
  return layout
}

/** 每行几格。1 档一行一格，4 档 2×2，9 档 3×3，16 档 4×4 */
export function cameraWallColumns(layout: CameraWallLayout): number {
  if (layout === 1) return 1
  if (layout === 4) return 2
  if (layout === 9) return 3
  return 4
}

// ---------------------------------------------------------------------------
// 墙的几何：统一档位，或自定义分
// ---------------------------------------------------------------------------

/**
 * 墙面几何的唯一描述
 *
 * `cellIds` 是这套几何里每一格的稳定 id（统一档位 `r{row}c{col}`，与
 * `lib/cameraViewDivision.ts` 同一套命名）。它存在的理由是**换几何时按 id 迁移绑定**：
 * 合并/拆分之后索引会变、id 不会，所以「哪台相机原来在哪一格」必须用 id 记账
 */
export type WallGeometry =
  | { kind: 'uniform'; layout: CameraWallLayout; columns: number; rows: number; cellIds: string[] }
  | { kind: 'custom'; division: CameraDivision; columns: number; rows: number; cellIds: string[] }

/** 把统一档位转成等价的自定义分屏（1×1 / 2×2 / 3×3 / 4×4） */
export function divisionForLayout(layout: CameraWallLayout): CameraDivision {
  const columns = cameraWallColumns(layout)
  const rows = Math.ceil(cameraCellCount(layout) / columns)
  return createUniformDivision(columns, rows)
}

function geometryOfDivision(division: CameraDivision): WallGeometry {
  return {
    kind: 'custom',
    division,
    columns: division.columns,
    rows: division.rows,
    cellIds: division.cells.map((cell) => cell.id)
  }
}

/** 当前墙的几何。自定义分屏优先：设了它就以它为准 */
export function wallGeometry(model: CameraWallModel): WallGeometry {
  const division = model.division ?? null
  if (division !== null && validateDivision(division).ok) return geometryOfDivision(division)
  const columns = cameraWallColumns(model.layout)
  const rows = Math.ceil(cameraCellCount(model.layout) / columns)
  const cellIds: string[] = []
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) cellIds.push(`r${row}c${column}`)
  }
  return { kind: 'uniform', layout: model.layout, columns, rows, cellIds }
}

/** 墙上一共有几格。自定义分屏优先 */
export function wallCellCount(model: CameraWallModel): number {
  return wallGeometry(model).cellIds.length
}

/** 每行几格（统一档位 CSS grid 用；自定义分屏给它的列数） */
export function wallColumns(model: CameraWallModel): number {
  return wallGeometry(model).columns
}

/**
 * 格子 key 里代表「几何身份」的那一段
 *
 * 换几何必须让每一格重新挂 `<video>`（旧的元素对着旧的回环地址），所以 key 里要带上
 * 几何本身。自定义分屏用它**格子 id 列表**表示：合并/拆分一定会改变这个字符串，
 * 单纯重排不会——正是我们要的粒度
 */
export function wallGeometryToken(model: CameraWallModel): string {
  const geometry = wallGeometry(model)
  return geometry.kind === 'uniform' ? `layout:${geometry.layout}` : `custom:${geometry.cellIds.join(',')}`
}

/**
 * 按**格子 id** 把绑定从旧几何搬到新几何，并交出被挤掉的设备
 *
 * 三条规矩
 *   1. 旧格子的设备只在「新几何里存在同 id」时才留 — 合并会让两格变一格，
 *      被并掉的那一台因此**必须**回报给调用方去停流（与 `changeLayout` 同一个契约）
 *   2. 出声格与当前格按 **id** 迁移，不按索引 — 合并之后索引会变，声音标记留
 *      一个已经指向别处的索引上，就会出现「徽标说在出声、声音却来自别格」；
 *   3. 迁移后不再成立的标记一律回落（出声格变 `null`、当前格 `0`），不留悬空索引
 */
function remapByCellId(
  model: CameraWallModel,
  from: WallGeometry,
  to: WallGeometry,
  patch: Partial<CameraWallModel>
): { model: CameraWallModel; evictedDeviceIds: string[] } {
  const deviceByCellId = new Map<string, string>()
  from.cellIds.forEach((id, index) => {
    const deviceId = model.slots[index]
    if (deviceId !== null && deviceId !== undefined) deviceByCellId.set(id, deviceId)
  })

  const slots: (string | null)[] = to.cellIds.map((id) => deviceByCellId.get(id) ?? null)
  const kept = new Set(slots.filter((slot): slot is string => slot !== null))
  const evictedDeviceIds = model.slots.filter(
    (slot): slot is string => slot !== null && !kept.has(slot)
  )

  const toIndexOfId = new Map(to.cellIds.map((id, index) => [id, index]))
  const movedIndex = (index: number | null): number | null => {
    if (index === null) return null
    const id = from.cellIds[index]
    if (id === undefined) return null
    return toIndexOfId.get(id) ?? null
  }

  const movedAudio = movedIndex(model.audioSlot)
  const audioSlot = movedAudio !== null && slots[movedAudio] !== null ? movedAudio : null
  const activeSlot = movedIndex(model.activeSlot) ?? 0

  return { model: { ...model, ...patch, slots, audioSlot, activeSlot }, evictedDeviceIds }
}

/**
 * 应用一套自定义分屏
 *
 * 几何不合法时**原样返回**（`evictedDeviceIds` 为空）：把一个坏几何装上去会让墙画不出来
 * 而调用方还以为成功了。合法性只 `validateDivision()` 判一次
 *
 * 注意**不改 `layout`**：那是用户上次选的统一档位偏好，切回统一档位时要恢复它
 */
export function setCustomDivision(
  model: CameraWallModel,
  division: CameraDivision
): { model: CameraWallModel; evictedDeviceIds: string[] } {
  if (!validateDivision(division).ok) return { model, evictedDeviceIds: [] }
  return remapByCellId(model, wallGeometry(model), geometryOfDivision(division), { division })
}

/** 回到统一档位（`model.layout`），并交出被挤掉的设备
*/
export function clearCustomDivision(
  model: CameraWallModel
): { model: CameraWallModel; evictedDeviceIds: string[] } {
  if ((model.division ?? null) === null) return { model, evictedDeviceIds: [] }
  const layout = isCameraWallLayout(model.layout) ? model.layout : DEFAULT_CAMERA_WALL_LAYOUT
  const to: WallGeometry = {
    kind: 'uniform',
    layout,
    columns: cameraWallColumns(layout),
    rows: Math.ceil(cameraCellCount(layout) / cameraWallColumns(layout)),
    cellIds: []
  }
  for (let row = 0; row < to.rows; row += 1) {
    for (let column = 0; column < to.columns; column += 1) to.cellIds.push(`r${row}c${column}`)
  }
  return remapByCellId(model, wallGeometry(model), to, { division: null })
}

// ---------------------------------------------------------------------------
// 画面格的状
// ---------------------------------------------------------------------------

/**
 * 一格可能处于的状态
 *
 * 前七种与主进程的 `CameraLiveStatus` 一一对应（`idle` 表示「这一格还没有开
 * 拉流」），后面三种是**只存在于界面**的事实：
 *   - `already-shown`  — 同一内容（同 id 同播放视图）已经在另一格里：两路同 id 的
 *     ffmpeg 回环会互相顶掉，这一格再开没有意义（业主 2026-09-21 批把这条限制从
 *     「一台相机最多一格」放宽成「同一内容最多一次」，chart 视图互不争用）；
 *   - `device-removed` — 设备被删除了，这一格已经清空；
 *   - `device-offline` — 设备离线，画面已停止
 *
 * 之所以不折进 `error`：它们的**处置方式**完全不同（换一格 / 重新添加设备 /
 * 等设备恢复），而状态是给操作员看的指令，不是日志分类
 */
export const CAMERA_CELL_STATUSES = [
  'empty',
  'idle',
  'starting',
  'playing',
  'rtsp-disabled',
  'ffmpeg-missing',
  'error',
  'limit-exceeded',
  'already-shown',
  'device-removed',
  'device-offline'
] as const

export type CameraCellStatus = (typeof CAMERA_CELL_STATUSES)[number]

/** 有短状态词的那几种状态（`empty` 不在其中，理由见下）
*/
export type CameraCellTextStatus = Exclude<CameraCellStatus, 'empty'>

/**
 * 状 -> 目录 key。模板只认 key，本模块不持有任何语言的字面量
 *
 * `empty` **刻意不在表里**：空白格上只有一个 `+`，一个字都不写（产品要求
 * 「不要任何文字说明」），所以「空格子」这句话没有任何渲染出来的地方。留在目录里
 * 就等于留了一条永远念不到的词条 — 那正是「用不到的文案」的定义
 */
export const CAMERA_CELL_STATUS_KEYS: Record<CameraCellTextStatus, string> = {
  idle: 'cameraWallUi.statusIdle',
  starting: 'cameraWallUi.statusStarting',
  playing: 'cameraWallUi.statusPlaying',
  'rtsp-disabled': 'cameraWallUi.statusRtspDisabled',
  'ffmpeg-missing': 'cameraWallUi.statusFfmpegMissing',
  error: 'cameraWallUi.statusError',
  'limit-exceeded': 'cameraWallUi.statusLimitExceeded',
  'already-shown': 'cameraWallUi.statusAlreadyShown',
  'device-removed': 'cameraWallUi.statusDeviceRemoved',
  'device-offline': 'cameraWallUi.statusDeviceOffline'
}

/** 这一格的画面**应当**是活的（ url、可以画 `<video>`）
*/
export function isCameraCellLive(status: CameraCellStatus): boolean {
  return status === 'starting' || status === 'playing'
}

/** 这一格此刻算不算占用了本机的并发预算（与主进 `isActive()` 同一条规则）
*/
export function isCameraCellActive(status: CameraCellStatus): boolean {
  return status === 'starting' || status === 'playing'
}

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

/**
 * 视频墙的可序列化状态
 *
 * `slots` 恒为长度 `wallCellCount(model)` 的数组，元素是设备 id 或 `null`
 * 「第 3 格是哪台相机」是一个可以逐位比较的事实，比一个 `Map` 更容易持久化
 * 更容易在测试里断言，也不会因为对象键顺序而行为不同
 */
export interface CameraWallModel {
  layout: CameraWallLayout
  slots: readonly (string | null)[]
  /** 出声的那一格；`null` 表示静音。全局至多一个
*/
  audioSlot: number | null
  /** 「当前格」：设备树双 拖拽的落点，也是键盘/新建画面的默认格
*/
  activeSlot: number
  /**
   * 自定义分屏（iVMS  `Joint` 合并，见 `lib/cameraViewDivision.ts`）
   *
   * `null` / 缺省 = 用统一档位；**设了它就以它为准**，`layout` 此时只是用户上次选的
   * 统一档位偏好（切回统一档位时用得上）
   *
   * 为什么是可选的：这个字段是后加的，而模型字面量在既有代码与 60 条测试里被大量构造；
   * 做成必填会迫使每一处都写一个 `division: null`，收益只是「显式」，代价是这
   * 大测试覆盖的文件全都要动一遍。缺省即「统一档位」是它真正的语义
   */
  division?: CameraDivision | null
  /**
   * 手填的第三方 RTSP 源（业主 2026-09-19 第 3 条：「能手填一个 RTSP 地址给第三方相机」）。
   *
   * 与 `slots` 的关系和"设备"完全一样：`slots` 里存的是**源 id**，设备 id 与
   * `rtsp:<32 位十六进制>` 两种都在同一个数组里 —— 「这一格到底是什么」由 id 的形状
   * （`isManualRtspId()`）判断，所以 `buildCameraCells()` 不需要把设备表也传进来。
   *
   * 可选（`undefined` = 一条都没有）：既有代码与六十多条测试大量构造模型字面量，
   * 做成必填会迫使每一处都写一个空数组，收益只是"显式"。
   */
  manualSources?: readonly ManualRtspSource[]
  /**
   * 每一格的**视图**（业主 2026-09-18 第 10 批第 2 条：播放 / 1 秒时域图 / 频域图 / 时频谱图）。
   *
   * 与 `slots` 一样是"逐格"的数组：`null` = 默认（播放）。做成可选（缺席 = 全部播放）的
   * 理由与 `manualSources` 相同：既有代码与测试大量构造模型字面量。
   */
  views?: readonly (CameraCellViewMode | null)[]
  /**
   * 轮询队列（业主 2026-09-21 批「超出窗口数自动轮询」）：放不进窗口的 (源, 视图)
   * 按先入先出排在这里，等 `rotateWallOnce()` 逐格轮换上墙。
   *
   * **只在内存里**，与格子分配一样不持久化（文件头说明了理由：数据库主键重启后可能
   * 对应另一台设备，恢复出来只会静默拉一路谁也没要求的流）。做成可选的理由与
   * `views` 相同：既有代码与测试大量构造模型字面量。
   */
  queue?: readonly WallQueueItem[]
  /**
   * 轮换游标：下一次 `rotateWallOnce()` 从哪一格开始轮（`% 格数` 取格）。
   * 内存-only，同 `queue`。
   */
  rotateCursor?: number
}

/** 轮询队列里的一项：一个 (源 id, 视图) 组合。 */
export interface WallQueueItem {
  id: string
  view: CameraCellViewMode
}

/** 一格的渲染模型（`buildCameraCells()` 的产物）
*/
export interface CameraCellView {
  /** `v-for`  key：档位变化后同一格必须重新挂 `<video>`，所以带上档位
*/
  key: string
  index: number
  /** 这一格绑定的相机 id；空格为 `null`
*/
  deviceId: string | null
  deviceName: string
  kind: DeviceKind | null
  deviceStatus: DeviceStatus | null
  status: CameraCellStatus
  /**
   * 这一格那个短状态词的目标 key
   *
   * **空白格没有 key**（`undefined`）：它整格只有右侧一个大 `+`，没有任何文字
   * 用「没 key」而不是空字符串，是因为空字符串会让模板看起来像「词条忘了写」，
   * 而这一个字都不写是产品明确要求的
   */
  messageKey?: string
  /** 主进 设备的原文诊断，存在时优先于通用文案显示
*/
  messageText?: string
  /** 可以交给 `<video>` 的回环地址；只 `starting` / `playing` 才有
*/
  url?: string
  /** 这一格此刻是不是**真的在出声**（不只是「被标成出声格」，见 `audibleAt()`） */
  audio: boolean
  /**
   * 这一格此刻的**视图**（播放 / 1 秒时域图 / 频域图 / 时频谱图）。
   *
   * 由模型逐格给出（缺席 = 播放）；界面的按钮与"画什么"都只看它。
   */
  view: CameraCellViewMode
  /** 这一格**支持**哪些视图（手填 RTSP 只有画面 —— 界面据此把那三个按钮藏起来并说明原因）。 */
  availableViews: readonly CameraCellViewMode[]
  /** 这一格的源是什么（`empty` / `camera` / `manual-rtsp`），按钮与提示共用。 */
  sourceKind: CameraCellSourceKind
}

export function createCameraWallModel(layout: CameraWallLayout = DEFAULT_CAMERA_WALL_LAYOUT): CameraWallModel {
  return {
    layout,
    slots: Array.from({ length: cameraCellCount(layout) }, () => null),
    audioSlot: null,
    activeSlot: 0,
    manualSources: []
  }
}

/**
 * 清空所有格子，但**保住手填的第三方 RTSP 源**。
 *
 * 为什么单独一个函数：离开画面墙时要释放的是**会话**（每格一条 ffmpeg + 一个回环端口），
 * 而不是"操作员刚才手填的那些地址"。手填源是**配置**（业主 2026-09-19 第 11 批第 2 条把它们
 * 的入口挪到了实时监测页，那一页与画面墙不同时挂载），而它们只在内存里、没有第二份 ——
 * 用 `createCameraWallModel()` 直接重建会把它们**当场删光**：从监测页回到总览，
 * 墙上就再也选不到那条源了，而界面不会说任何话。
 *
 * 档位（`layout`）、格子（`slots`）、出声格与当前格都归 `createCameraWallModel()` 的默认值；
 * 交出去的 `assigned` 是"清空之前占着格的那些 id"，调用方据此去停会话。
 */
export function clearCameraWallCells(
  model: CameraWallModel,
  layout: CameraWallLayout = model.layout
): { model: CameraWallModel; assigned: string[] } {
  const assigned = model.slots.filter((slot): slot is string => slot !== null)
  const cleared = createCameraWallModel(layout)
  return {
    // 数组也复制一份：调用方后续的变换都返回新对象，共享同一个数组会让"改一处、两处都变"。
    model: { ...cleared, manualSources: manualSourcesOf(model).slice() },
    assigned
  }
}

/** 把一段来路不明的槽位数组补齐/截断到当前档位（localStorage、旧版本、手工改坏）
*/
function normaliseSlots(
  slots: readonly (string | null)[] | undefined,
  layout: CameraWallLayout
): (string | null)[] {
  const size = cameraCellCount(layout)
  const source = Array.isArray(slots) ? slots : []
  const out: (string | null)[] = []
  for (let index = 0; index < size; index += 1) {
    const value = source[index]
    out.push(typeof value === 'string' && value !== '' ? value : null)
  }
  return out
}

/** 把一段来路不明的档位/槽位/索引修补成一个**永远合法**的模型 */
export function normaliseCameraWallModel(input: unknown): CameraWallModel {
  const raw = (input ?? {}) as Partial<CameraWallModel>
  const layout = isCameraWallLayout(raw.layout) ? raw.layout : DEFAULT_CAMERA_WALL_LAYOUT
  const slots = normaliseSlots(raw.slots, layout)
  const size = slots.length

  const audioCandidate = typeof raw.audioSlot === 'number' ? Math.floor(raw.audioSlot) : -1
  // 出声的那一格必须真的有相机：档位变小之后留下的悬空索引必须被清掉，
  // 否则界面上会出现「声音开着但没有任何一格在出声」
  const audioSlot =
    audioCandidate >= 0 && audioCandidate < size && slots[audioCandidate] !== null
      ? audioCandidate
      : null

  const activeCandidate = typeof raw.activeSlot === 'number' ? Math.floor(raw.activeSlot) : 0
  const activeSlot = activeCandidate >= 0 && activeCandidate < size ? activeCandidate : 0

  const manualSources = normaliseManualRtspSources(raw.manualSources)  /**
   * 槽位里那些**指向不存在的手填源**的 id 必须清掉。
   *
   * 与"设备被删掉"同一条规矩：一个指向已经不在列表里的手填源的槽位，只会在墙上得到
   * 一格永远报错的画面（`buildCameraCells()` 找不到它就只能说"源已删除"）。
   * 坏输入（旧状态、手改过的对象）在这里被修成一个**永远合法**的模型。
   */
  const knownManual = new Set(manualSources.map((source) => source.id))
  const cleanSlots = slots.map((slot) =>
    slot !== null && isManualRtspId(slot) && !knownManual.has(slot) ? null : slot
  )
  const audioSlotFinal =
    audioSlot !== null && cleanSlots[audioSlot] !== null ? audioSlot : null

  /**
   * 视图逐格规范化：只认四个取值之一，其余（旧状态、手改过的对象）当默认（`null` = 播放）。
   * 长度按当前格数补齐/截断；**空格上的视图一律清成 `null`** —— 一个没有源的格子
   * 记着"时频图"毫无意义，而且换了源之后那个模式会莫名其妙地生效。
   */
  const rawViews = Array.isArray(raw.views) ? raw.views : []
  const views: (CameraCellViewMode | null)[] = Array.from({ length: size }, (_, index) => {
    if (cleanSlots[index] === null) return null
    const value = rawViews[index]
    return isCameraCellViewMode(value) && value !== DEFAULT_CAMERA_CELL_VIEW ? value : null
  })

  /**
   * 轮询队列规范化（内存-only 字段，坏输入同样要修成**永远合法**）：
   *   - 只认 `{ id: 非空字符串, view: 四种之一 }`，其余丢弃；
   *   - 按 (id, view) 去重；
   *   - 与格子上**可见**的 (id, view) 去重 —— 已经在墙上显示的内容没有资格排队
   *     （可见项进队由 `enqueueWallItem()` 判，normalise 是最后一道闸）。
   */
  const rawQueue = Array.isArray(raw.queue) ? raw.queue : []
  const queued = new Set<string>()
  const queue: WallQueueItem[] = []
  for (const item of rawQueue) {
    const id = (item as Partial<WallQueueItem> | null | undefined)?.id
    const view = (item as Partial<WallQueueItem> | null | undefined)?.view
    if (typeof id !== 'string' || id === '' || !isCameraCellViewMode(view)) continue
    const key = `${id}${view}`
    if (queued.has(key)) continue
    const visible = cleanSlots.some(
      (slot, index) => slot === id && (views[index] ?? DEFAULT_CAMERA_CELL_VIEW) === view
    )
    if (visible) continue
    queued.add(key)
    queue.push({ id, view })
  }

  const rawCursor = typeof raw.rotateCursor === 'number' ? Math.floor(raw.rotateCursor) : 0
  const rotateCursor = rawCursor >= 0 && Number.isFinite(rawCursor) ? rawCursor : 0

  return {
    layout,
    slots: cleanSlots,
    audioSlot: audioSlotFinal,
    activeSlot,
    manualSources,
    views,
    queue,
    rotateCursor
  }
}

// ---------------------------------------------------------------------------
// 纯查
// ---------------------------------------------------------------------------

/**
 * 这台相机在第几格；`-1` 表示不在墙上
 *
 * 注意（业主 2026-09-21 批）：一格的身份是 **(id, 视图)**，同一台相机**可以**占多格
 * （画面一格、时域图一格……）。这个函数回答的是「同 id 的**第一个**格号」，给仍然
 * 按"这台设备在哪"提问的调用方（清理、双击高亮）；「同 id 同视图在哪一格」用
 * `findWallItem()`。
 */
export function findCameraSlot(model: CameraWallModel, deviceId: string): number {
  if (deviceId === '') return -1
  return model.slots.findIndex((slot) => slot === deviceId)
}

/**
 * 同 id 同**有效视图**的内容在第几格；`-1` 表示这个组合不在墙上。
 *
 * 「相同内容只允许一次」的判定：`views[i]` 不是合法值时按默认（播放）算，
 * 与 `cellViewAt()` 同一口径 —— 判重与渲染必须看同一个视图，否则会出现
 * 「模型说没重复、界面画了两份」。
 */
export function findWallItem(
  model: CameraWallModel,
  id: string,
  view: CameraCellViewMode
): number {
  if (id === '') return -1
  return model.slots.findIndex((slot, index) => slot === id && cellViewAt(model, index) === view)
}

/** 这一格绑的是哪台相机（空格返 `null`）
*/
export function cameraSlotDevice(model: CameraWallModel, index: number): string | null {
  return model.slots[index] ?? null
}

/**
 * 这一格此刻**能不能**开始拉流，以及不能时的原因
 *
 * `activeStreams` 由调用方给出（主进程 `camera-live:limits` 的 `active`，或界面
 * 自己的估计），`maxStreams` 是设置里的上限。两者都由外部传进来，这样这个函数是
 * 纯的，而「用哪个数字」这件事留在 store 里显式可见
 *
 * 判定顺序就是操作员的心智顺序：格子已经被占 -> 同一内容已在别格 -> 超预算。
 *
 * `already-shown`（业主 2026-09-21 批改为按内容判）：**只有**目标是播放、且别格
 * 已有同 id 的播放时才拒绝 —— chart 视图走 FA371 WebSocket 通道、不占 RTSP 会话，
 * 同一张图放两格互不争用；同一台相机「画面 + 时域图」同理。两路同 id 的 ffmpeg
 * 回环才会互相顶掉（`RtspSession` 的 start 会替换旧会话），那才是必须拒绝的。
 */
export function cameraCellStartPermission(
  model: CameraWallModel,
  index: number,
  deviceId: string,
  activeStreams: number,
  maxStreams: number
): { allowed: boolean; refusal: CameraCellStatus | null } {
  const size = wallCellCount(model)
  if (index < 0 || index >= size || deviceId === '') {
    return { allowed: false, refusal: null }
  }
  if (cellViewAt(model, index) === DEFAULT_CAMERA_CELL_VIEW) {
    const other = findWallItem(model, deviceId, DEFAULT_CAMERA_CELL_VIEW)
    if (other >= 0 && other !== index) return { allowed: false, refusal: 'already-shown' }
  }
  if (cameraStreamLimitReached(activeStreams, maxStreams)) {
    return { allowed: false, refusal: 'limit-exceeded' }
  }
  return { allowed: true, refusal: null }
}

/**
 * 正在占预算的格数
 *
 * 参数**逐格状态**而不是模型：模型里没有格子状态（状态属于主进程），所以
 * 这里的输入刻意是 `buildCameraCells()` 的产物。数的是 `starting` + `playing`
 * 与主进程 `activeStreamCount()` 同一条规则——一个还没出帧但已经起了 ffmpeg 
 * 回环服务的会话同样花掉了预算
 */
export function activeCameraStreams(cells: readonly { status: CameraCellStatus }[]): number {
  return cells.filter((cell) => isCameraCellActive(cell.status)).length
}

/** 队列里所有相 id，按格位顺序（用于预热给主进程的 state 查询）
*/
export function assignedCameraIds(model: CameraWallModel): string[] {
  return model.slots.filter((slot): slot is string => slot !== null)
}

// ---------------------------------------------------------------------------
// 纯变换（每一个都返回**新对象**，不就地修改）
// ---------------------------------------------------------------------------

/** 换档位。变小的时候多余的那几格会被清空，并交出被清掉的相机 id。 */
export function setCameraWallLayout(
  model: CameraWallModel,
  layout: CameraWallLayout
): { model: CameraWallModel; evictedDeviceIds: string[] } {
  const size = cameraCellCount(layout)
  const evictedDeviceIds = model.slots
    .slice(size)
    .filter((slot): slot is string => slot !== null)
  const slots = Array.from({ length: size }, (_, index) => model.slots[index] ?? null)

  // 悬空的出 当前格索引必须一起回落：槽位没了，索引就不能再指着它
  const audioSlot =
    model.audioSlot !== null && model.audioSlot < size && slots[model.audioSlot] !== null
      ? model.audioSlot
      : null
  const activeSlot = model.activeSlot < size ? model.activeSlot : 0

  /**
   * 视图跟着格子一起裁剪/补齐（换档位时被挤掉的格子的视图必须一起消失，
   * 否则它们会在下一次放大档位时"复活"到别的格上）。
   */
  const views: (CameraCellViewMode | null)[] = Array.from({ length: size }, (_, index) =>
    slots[index] === null ? null : (model.views?.[index] ?? null)
  )

  return {
    model: {
      layout,
      slots,
      audioSlot,
      activeSlot,
      manualSources: model.manualSources,
      views,
      queue: model.queue ?? [],
      rotateCursor: model.rotateCursor ?? 0
    },
    evictedDeviceIds
  }
}

/**
 * 把一台相机放进某一格 —
 * **双击设备树、拖拽、下拉选择共用的唯一入口**
 *
 * 一格的身份是 **(id, view)**（业主 2026-09-21 批），三条规矩：
 *   1. 别格已有同 (id, targetView) -> **移动**：源格清空（视图一起回默认），
 *      出声标记跟着走。移动而不是新增，是因为两路同 id 同视图的会话在主进程里
 *      会互相顶掉（`RtspSession` 的 start 会替换旧会话）。
 *   2. 同 id 只出现在**其它视图**的格上 -> 保留那些格，本格照放：同一台相机的
 *      画面与时域图是两种内容，允许各占一格（chart 视图不占 RTSP 会话）。
 *   3. 本格原有内容被替换时如实交出 `evicted`（{ id, view }），调用方据此决定
 *      停会话 / 进轮询队列 —— 它**没有**被静默丢弃。
 *
 * `view` 缺省 = 播放（双击、拖拽、自动起播都放画面）。本格换进来的视图就是
 * `targetView`，不再是"一律回默认"：从选择器第二步选了「时域图」进来，这一格
 * 落地就是时域图。
 */
export function assignCamera(
  model: CameraWallModel,
  index: number,
  deviceId: string,
  view?: CameraCellViewMode
): {
  model: CameraWallModel
  movedFrom: number | null
  changed: boolean
  evicted: WallQueueItem | null
} {
  const size = wallCellCount(model)
  if (index < 0 || index >= size || deviceId === '') {
    return { model, movedFrom: null, changed: false, evicted: null }
  }
  const targetView: CameraCellViewMode =
    view !== undefined && isCameraCellViewMode(view) ? view : DEFAULT_CAMERA_CELL_VIEW

  const previous = findWallItem(model, deviceId, targetView)
  if (previous === index) return { model, movedFrom: null, changed: false, evicted: null }

  // 本格原来的内容（被替换时如实交出去；空格没有可交的东西）。
  const currentId = model.slots[index] ?? null
  const evicted: WallQueueItem | null =
    currentId === null ? null : { id: currentId, view: cellViewAt(model, index) }

  const slots = [...model.slots]
  const views = cellViewsOf(model)
  if (previous >= 0) {
    slots[previous] = null
    views[previous] = DEFAULT_CAMERA_CELL_VIEW
  }
  slots[index] = deviceId
  views[index] = targetView

  // 把出声标记跟着内容走：移动一格之后声音不应该留在原来那个空格上
  const audioSlot =
    model.audioSlot === previous ? index : model.audioSlot !== null && model.audioSlot < size
      ? model.audioSlot
      : null

  return {
    model: { ...model, slots, audioSlot, activeSlot: index, views },
    movedFrom: previous >= 0 ? previous : null,
    changed: true,
    evicted
  }
}

/** 清空一格：顺手清掉这一格的出声标记
*/
export function clearCameraCell(model: CameraWallModel, index: number): CameraWallModel {
  if (index < 0 || index >= model.slots.length || model.slots[index] === null) return model
  const slots = [...model.slots]
  slots[index] = null
  const audioSlot = model.audioSlot === index ? null : model.audioSlot
  // 清格时视图一起回默认：留着一个"时频图"在空格上，下次放进来一台设备会莫名其妙地生效。
  const views = resetViewAt(model.views ?? [], index, model.slots.length)
  return { ...model, slots, audioSlot, views }
}

/** 清空某一台相机出现的**所有格**（设备被删除时用；正常情况下只有一格） */
export function clearCameraDevice(model: CameraWallModel, deviceId: string): CameraWallModel {
  if (deviceId === '') return model
  let changed = false
  const slots = model.slots.map((slot) => {
    if (slot !== deviceId) return slot
    changed = true
    return null
  })
  if (!changed) return model
  // 用槽位判断而不 `findCameraSlot(model,  `：上面那一步还没生效
  const stillShown = slots.some((slot) => slot === deviceId)
  const audioSlot = stillShown ? model.audioSlot : null
  let views = model.views ?? []
  slots.forEach((slot, index) => {
    if (slot === null) views = resetViewAt(views, index, model.slots.length)
  })
  return { ...model, slots, audioSlot, views }
}

/**
 * 设备被删除时处理它占着的格子
 *
 * 返回被清空的格号（供界面把「哪一格因为什么空掉了」说出来）与新模型
 * 与 `clearCameraDevice` 分开：删除设备是一个**事件**，界面需要它的证据
 */
export function removeDeviceFromWall(
  model: CameraWallModel,
  deviceId: string
): { model: CameraWallModel; clearedSlots: number[] } {
  const clearedSlots: number[] = []
  model.slots.forEach((slot, index) => {
    if (slot === deviceId) clearedSlots.push(index)
  })
  if (clearedSlots.length === 0) return { model, clearedSlots }
  return { model: clearCameraDevice(model, deviceId), clearedSlots }
}

/**
 * 音频独占：至多一格出声
 *
 * `index` 为 `null`（或越界）就是静音。这个函数**不做**「切换是否明显」的
 * 事——那是模板的责任（徽标 + 按钮文字），这里只保证模型里永远只有一个声音源
 * 因为 N 路同时出声在值班台上是噪声而不是功能
 */
export function setAudioSlot(model: CameraWallModel, index: number | null): CameraWallModel {
  if (index === null || index < 0 || index >= model.slots.length || model.slots[index] === null) {
    return model.audioSlot === null ? model : { ...model, audioSlot: null }
  }
  return model.audioSlot === index ? model : { ...model, audioSlot: index }
}

/** 点一下声音按钮：已经是它出声就静音，否则切到它
*/
export function toggleAudioSlot(model: CameraWallModel, index: number): CameraWallModel {
  return setAudioSlot(model, model.audioSlot === index ? null : index)
}

// ---------------------------------------------------------------------------
// 每一格的视图（业主 2026-09-18 第 10 批第 2 条）
// ---------------------------------------------------------------------------

/**
 * 这一格的**有效视图**：`views[i]` 不是合法值时按默认（播放）算。
 *
 * 与 `cellViewsOf()` 同一口径，给「只问一格」的调用方（判重、轮换、覆盖）用；
 * 判重与渲染必须看同一个视图，否则会出现「模型说没重复、界面画了两份」。
 */
export function cellViewAt(model: CameraWallModel, index: number): CameraCellViewMode {
  const value = model.views?.[index]
  return isCameraCellViewMode(value) ? value : DEFAULT_CAMERA_CELL_VIEW
}

/** 每一格的视图（缺席 = 播放），长度与格数一致。 */
export function cellViewsOf(model: CameraWallModel): CameraCellViewMode[] {
  const size = wallCellCount(model)
  return Array.from({ length: size }, (_, index) => cellViewAt(model, index))
}

/** 这一格的源是什么（决定它支持哪些视图；手填 RTSP 只有画面）。 */
export function cellSourceKind(model: CameraWallModel, index: number): CameraCellSourceKind {
  const slot = model.slots[index]
  if (slot === null || slot === undefined) return 'empty'
  if (isManualRtspId(slot)) return 'manual-rtsp'
  return 'camera'
}

/** 这一格支持哪些视图。 */
export function cellViewsFor(model: CameraWallModel, index: number): readonly CameraCellViewMode[] {
  return availableCellViews(cellSourceKind(model, index))
}

/**
 * 设置某一格的视图。
 *
 * 两条拒绝：**空格**（没有源，切了没有意义）与**这一格不支持的视图**
 * （手填 RTSP 只有画面）。静默接受会让界面显示一个永远不动的图。
 *
 * 「同 (id, view) 全墙唯一」**不在这里判**：那是带提示语的产品决定，由调用方
 * （store）先问 `cellViewSwitchPermission()` 再进来，拒绝时界面要说得出原因。
 */
export function setCameraCellView(
  model: CameraWallModel,
  index: number,
  mode: CameraCellViewMode
): CameraWallModel {
  const size = wallCellCount(model)
  if (index < 0 || index >= size) return model
  if (!isCameraCellViewMode(mode)) return model
  if (model.slots[index] === null) return model
  if (!cellViewsFor(model, index).includes(mode)) return model

  const views = cellViewsOf(model)
  views[index] = mode
  return { ...model, views }
}

/**
 * 这一格**能不能**切到某个视图；不能时给出唯一原因 `'already-shown'`。
 *
 * 业主 2026-09-21 批「相同内容只允许一次」：别格已有同 id 同 mode 时拒绝 ——
 * 同一台相机的时域图放两格，是两格一模一样的图，没有意义。返回 `null` = 可以切。
 */
export function cellViewSwitchPermission(
  model: CameraWallModel,
  index: number,
  mode: CameraCellViewMode
): 'already-shown' | null {
  const size = wallCellCount(model)
  if (index < 0 || index >= size) return null
  if (!isCameraCellViewMode(mode)) return null
  const id = model.slots[index]
  if (id === null || id === undefined || id === '') return null
  const other = findWallItem(model, id, mode)
  return other >= 0 && other !== index ? 'already-shown' : null
}

/** 把某一格的视图恢复成默认（换源 / 清格时用；`null` 表示"没设过"）。 */
function resetViewAt(
  views: readonly (CameraCellViewMode | null)[],
  index: number,
  size: number
): (CameraCellViewMode | null)[] {
  const next = Array.from({ length: size }, (_, at) => views[at] ?? null)
  if (index >= 0 && index < size) next[index] = null
  return next
}

// ---------------------------------------------------------------------------
// 轮询队列（业主 2026-09-21 批「超出窗口数自动轮询」）
// ---------------------------------------------------------------------------

/**
 * 把一个 (id, view) 排进轮询队列。
 *
 * 两条不重复：**已在墙上可见**（某一格已经是这个组合）与**已在队里** ——
 * 队列是"等位的内容"，不是收藏夹。手填 RTSP 只有 `play`，天然不会重复。
 */
export function enqueueWallItem(
  model: CameraWallModel,
  id: string,
  view: CameraCellViewMode
): CameraWallModel {
  if (id === '') return model
  if (!isCameraCellViewMode(view)) return model
  if (findWallItem(model, id, view) >= 0) return model
  const queue = model.queue ?? []
  if (queue.some((item) => item.id === id && item.view === view)) return model
  return { ...model, queue: [...queue, { id, view }] }
}

/**
 * 从队列里**清掉某个 id 的所有项**。
 *
 * 三处同步清（store 负责调用）：设备被删除、格子被手动清空、手填源被删除 ——
 * 内容已经不在墙上了，排在队里只会轮出一个指向不存在源的格子。
 */
export function removeIdFromQueue(model: CameraWallModel, id: string): CameraWallModel {
  const queue = model.queue ?? []
  if (!queue.some((item) => item.id === id)) return model
  return { ...model, queue: queue.filter((item) => item.id !== id) }
}

/**
 * 轮换一次的两种结果：队空什么都没发生 / 某一格真的换了内容。
 * 联合类型让调用方必须先判 `changed` 才能拿 `slot` / `evicted` / `incoming`。
 */
export type WallRotationResult =
  | { model: CameraWallModel; changed: false }
  | {
      model: CameraWallModel
      changed: true
      slot: number
      /** 被轮走的那一份内容（空格 = `null`）；非空时调用方决定停会话。 */
      evicted: WallQueueItem | null
      /** 这一轮上墙的内容（队列头部）。 */
      incoming: WallQueueItem
    }

/**
 * 轮一轮：队首内容进「游标指着的那一格」，被轮走的内容排到队尾等着下次。
 *
 * 规则（业主 2026-09-21 批）：
 *   1. 队空 -> 原样返回 `{ changed: false }`，游标不动；
 *   2. `slot = rotateCursor % 格数`：一格一格顺次轮，不跳格；
 *   3. 被轮走的内容（若非空）**补到队尾** —— 轮询是"都在台上轮流站"，不是淘汰；
 *   4. `views[slot]` 跟着 incoming 走（`play` 记默认 `null`）；
 *   5. 出声的那一格被轮走就静音（`audioSlot` 指着的画面没了，留着徽标就是说假话）。
 */
export function rotateWallOnce(model: CameraWallModel): WallRotationResult {
  const queue = model.queue ?? []
  if (queue.length === 0) return { model, changed: false }
  const size = wallCellCount(model)
  if (size === 0) return { model, changed: false }

  const cursor = model.rotateCursor ?? 0
  const slot = cursor % size
  const incoming = queue[0] as WallQueueItem
  const evictedId = model.slots[slot] ?? null
  const evicted: WallQueueItem | null =
    evictedId === null ? null : { id: evictedId, view: cellViewAt(model, slot) }

  const slots = [...model.slots]
  slots[slot] = incoming.id
  const views = cellViewsOf(model)
  views[slot] = incoming.view

  const rest = queue.slice(1)
  const nextQueue = evicted === null ? rest : [...rest, evicted]

  return {
    model: {
      ...model,
      slots,
      views,
      queue: nextQueue,
      rotateCursor: cursor + 1,
      audioSlot: model.audioSlot === slot ? null : model.audioSlot
    },
    changed: true,
    slot,
    evicted,
    incoming
  }
}

// ---------------------------------------------------------------------------
// 手填的第三方 RTSP 源（业主 2026-09-19 第 3 条）
// ---------------------------------------------------------------------------

/**
 * 墙上的手填源列表（缺席就是空表）。
 *
 * 所有读的地方都走这一个函数：`model.manualSources` 是可选的，直接在模板里写
 * `model.manualSources.length` 会在它缺席时炸掉 —— 而"缺席"是既有模型字面量的常态。
 */
export function manualSourcesOf(model: CameraWallModel): readonly ManualRtspSource[] {
  return model.manualSources ?? []
}

export function manualSourceById(
  model: CameraWallModel,
  id: string
): ManualRtspSource | undefined {
  return manualSourcesOf(model).find((source) => source.id === id)
}

/** 加一条手填源；id 重复时**替换**（同一条源被编辑两次不该变成两条）。 */
export function addManualSource(
  model: CameraWallModel,
  source: ManualRtspSource
): CameraWallModel {
  const existing = manualSourcesOf(model)
  const index = existing.findIndex((item) => item.id === source.id)
  const next =
    index >= 0
      ? existing.map((item, at) => (at === index ? source : item))
      : [...existing, source]
  return { ...model, manualSources: next }
}

/**
 * 编辑一条手填源。
 *
 * 地址改坏了就**整条拒绝**（返回原模型）：留在列表里的那一条仍然能用旧地址播，
 * 而"改成一个坏地址"如果生效，墙上那一格会从能播变成永远报错 —— 编辑不该是破坏性的。
 */
export function updateManualSource(
  model: CameraWallModel,
  id: string,
  patch: { name?: string; url?: string }
): CameraWallModel {
  const current = manualSourceById(model, id)
  if (!current) return model
  const url = patch.url === undefined ? current.url : patch.url.trim()
  if (!parseManualRtspUrl(url).ok) return model
  const name = (patch.name ?? current.name).trim()
  return addManualSource(model, {
    id,
    name: name === '' ? current.name : name,
    url
  })
}

/**
 * 删掉一条手填源：**占用它的格子一起清空**。
 *
 * 必须一起清：留着那些槽位就是留着几格指向不存在源的画面（`normaliseCameraWallModel()`
 * 会把它们当坏输入清掉，但用户点"删除"的那一刻界面必须先自洽）。
 */
export function removeManualSource(
  model: CameraWallModel,
  id: string
): { model: CameraWallModel; clearedSlots: number[] } {
  const clearedSlots: number[] = []
  model.slots.forEach((slot, index) => {
    if (slot === id) clearedSlots.push(index)
  })
  const slots = model.slots.map((slot) => (slot === id ? null : slot))
  const audioSlot =
    model.audioSlot !== null && slots[model.audioSlot] === null ? null : model.audioSlot
  const manualSources = manualSourcesOf(model).filter((source) => source.id !== id)
  return { model: { ...model, slots, audioSlot, manualSources }, clearedSlots }
}


/** 标记「当前格」
*/
export function setActiveSlot(model: CameraWallModel, index: number): CameraWallModel {
  const size = wallCellCount(model)
  if (index < 0 || index >= size) return model
  return model.activeSlot === index ? model : { ...model, activeSlot: index }
}

/**
 * 双击设备树时落在哪一格
 *
 * 规则（可预期优先于聪明）
 *   1. 这台相机的**播放**已经在墙 -> 就是它那一格（双击 = 把这台相机的画面切到
 *      眼前；它若在别的格还有图，那些格不动）；
 *   2. 当前格是空的 -> 当前格；
 *   3. 否则第一个空格；
 *   4. 全满 -> 当前格（替换掉原来那台，等主进程 stop 旧会话）
 */
export function focusSlotForDevice(
  model: CameraWallModel,
  deviceId: string,
  deviceIds: readonly string[] = []
): number {
  const existing = findWallItem(model, deviceId, DEFAULT_CAMERA_CELL_VIEW)
  if (existing >= 0) return existing
  if (model.slots[model.activeSlot] === null) return model.activeSlot
  const empty = model.slots.findIndex((slot) => slot === null)
  if (empty >= 0) return empty
  // 全满：优先替换一台已经不在设备列表里的相机（例如刚被删掉但这一格还没来得及
  // 处理），否则落在当前格上。
  const stale = model.slots.findIndex(
    (slot) => slot !== null && deviceIds.length > 0 && !deviceIds.includes(slot)
  )
  if (stale >= 0) return stale
  return model.activeSlot
}

// ---------------------------------------------------------------------------
// 渲染模型
// ---------------------------------------------------------------------------

export interface CameraCellBuildInput {
  devices: readonly Device[]
  /** 主进程的逐会话状态，`deviceId -> CameraLiveState`
*/
  states: Readonly<Record<string, CameraLiveState | undefined>>
  /** 上限（`camera-live:limits`  `max`，或设置里的值）
*/
  maxStreams: number
}

/**
 * 把模 + 设备列表 + 主进程状态摊平成每一格要画的东西
 *
 * 状态的优先级是有顺序的，而且顺序本身就是产品规则
 *   设备被删 > 设备离线 > 主进程状 > 「已在别格 > 未开始
 * 一个被删掉的设备即便主进程还留着一个 `playing` 快照，也必须是「设备已删除」
 */
export function buildCameraCells(
  model: CameraWallModel,
  input: CameraCellBuildInput
): CameraCellView[] {
  const byId = new Map(input.devices.map((device) => [device.id, device]))
  const size = wallCellCount(model)
  const views = cellViewsOf(model)

  return Array.from({ length: size }, (_, index) => {
    const deviceId = model.slots[index] ?? null
    /** `key` / `index` 每一格都有；`audio` 要等状态定下来才算（见 `audibleAt()`）
*/
    const base = { key: `camera-cell:${wallGeometryToken(model)}:${index}`, index }
    /** 视图那三项每一格都要有（空格也要：界面靠它决定画不画那一排按钮）。 */
    const sourceKind = cellSourceKind(model, index)
    const viewBase = {
      view: views[index] ?? DEFAULT_CAMERA_CELL_VIEW,
      availableViews: availableCellViews(sourceKind),
      sourceKind
    }

    // 空格子：这一格在界面上只有右侧一个大 `+`，一个字都不写（产品要求），
    // 所以它**没有** messageKey — 目录里也没有「空格子」这条词条。
    if (deviceId === null) {
      return {
        ...base,
        ...viewBase,
        deviceId: null,
        deviceName: '',
        kind: null,
        deviceStatus: null,
        status: 'empty' as CameraCellStatus,
        audio: false
      }
    }

    const device = byId.get(deviceId)
    if (!device) {
      /**
       * 手填的第三方 RTSP 源（业主 2026-09-19 第 3 条）。
       *
       * 它**不是**"设备被删掉"那种情况，虽然它同样不在设备表里 —— 而"这一格到底是哪一类"
       * 只由 id 的形状决定（`rtsp:` 前缀）。两者的状态词与能不能播都不一样：
       * 手填源没有"设备离线"这个概念（它连设备都不是），它的状态只来自本机主进程那一路会话。
       */
      if (isManualRtspId(deviceId)) {
        const source = manualSourceById(model, deviceId)
        if (!source) {
          return {
            ...base,
            ...viewBase,
            deviceId,
            deviceName: '',
            kind: null,
            deviceStatus: null,
            status: 'device-removed' as CameraCellStatus,
            messageKey: CAMERA_CELL_STATUS_KEYS['device-removed'],
            audio: false
          }
        }
        const manualCommon = {
          ...base,
          ...viewBase,
          deviceId,
          deviceName: source.name,
          kind: null,
          deviceStatus: null
        }
        const manualState = input.states[deviceId]
        if (!manualState) {
          return {
            ...manualCommon,
            status: 'idle' as CameraCellStatus,
            messageKey: CAMERA_CELL_STATUS_KEYS.idle,
            audio: false
          }
        }
        const manualStatus = cellStatusOfLiveState(manualState)
        return {
          ...manualCommon,
          status: manualStatus,
          messageKey: CAMERA_CELL_STATUS_KEYS[manualStatus as CameraCellTextStatus],
          ...(isCameraLiveActive(manualState.status) && manualState.url !== undefined
            ? { url: manualState.url }
            : {}),
          ...(manualState.error !== undefined && manualState.error !== ''
            ? { messageText: manualState.error }
            : {}),
          audio: audibleAt(model, index, manualStatus)
        }
      }
      return {
        ...base,
        ...viewBase,
        deviceId,
        deviceName: '',
        kind: null,
        deviceStatus: null,
        status: 'device-removed' as CameraCellStatus,
        // 短状态词，不是那句「设备「X」已删除，这一格已清空。」：徽标说的就是那个状态，
        // 哪一台设备由叠加条上的名字回答，长句子是解释，画面格里不写。
        messageKey: CAMERA_CELL_STATUS_KEYS['device-removed'],
        audio: false
      }
    }

    const common = {
      ...base,
      ...viewBase,
      deviceId,
      deviceName: device.name,
      kind: device.kind,
      deviceStatus: device.status
    }

    if (device.status === 'OFFLINE') {
      return {
        ...common,
        status: 'device-offline' as CameraCellStatus,
        // 同上：徽标只说「设备离线」这个状态，「恢复在线后可以重新开始」是解释。
        messageKey: CAMERA_CELL_STATUS_KEYS['device-offline'],
        audio: false
      }
    }

    /*
     * 同一内容已在别格播放 -> `already-shown`。只按 (id, play) 判：chart 视图不占
     * RTSP 会话，同一张图放两格互不争用；只有两路同 id 的 ffmpeg 回环才会互相顶掉。
     */
    const other = findWallItem(model, deviceId, DEFAULT_CAMERA_CELL_VIEW)
    if (cellViewAt(model, index) === DEFAULT_CAMERA_CELL_VIEW && other >= 0 && other !== index) {
      return {
        ...common,
        status: 'already-shown' as CameraCellStatus,
        messageKey: CAMERA_CELL_STATUS_KEYS['already-shown'],
        audio: false
      }
    }

    const state = input.states[deviceId]
    if (!state) {
      return {
        ...common,
        status: 'idle' as CameraCellStatus,
        messageKey: CAMERA_CELL_STATUS_KEYS.idle,
        audio: false
      }
    }

    const status = cellStatusOfLiveState(state)
    if (status === 'limit-exceeded') {
      return {
        ...common,
        status,
        messageKey: CAMERA_CELL_STATUS_KEYS['limit-exceeded'],
        ...(state.error !== undefined ? { messageText: state.error } : {}),
        audio: false
      }
    }

    return {
      ...common,
      status,
      messageKey: CAMERA_CELL_STATUS_KEYS[status as CameraCellTextStatus],
      // `starting` 也带 url：回环服务已经起来了，`<video>` 挂上去就能在第一帧
      // 到达时立刻出画，不必等一次轮询把它从 `starting` 变成 `playing`。
      ...(isCameraLiveActive(state.status) && state.url !== undefined ? { url: state.url } : {}),
      ...(state.error !== undefined && state.error !== '' ? { messageText: state.error } : {}),
      audio: audibleAt(model, index, status)
    }
  })
}

/**
 * 这一格此刻是不是**真的在出声**的那一格
 *
 * 只比 `model.audioSlot === index` 是不够的，而且正是「界面说假话」的来源
 * 出声需要这一格真的挂着一个 `<video>`（`isCameraCellLive()`），而流失败 / 停止 /
 * 设备离线 `<video>` 会被卸载。此时若还把 `audio` 标成真，界面上就会出
 * 「正在出声」的徽标配一个一格都不出声的画面
 *
 * 因此模型层先把「被标成出声格」与「真的在出声」分开：`audioSlot` 记的是操作员
 * 选择（它刻意留在原地，会话恢复后声音跟着回来），`audio` 说的是此刻的事实
 */
function audibleAt(model: CameraWallModel, index: number, status: CameraCellStatus): boolean {
  return model.audioSlot === index && isCameraCellLive(status)
}

/** 主进程状态 -> 格子状态。`limit-exceeded` 原样透传，绝不被折进 `error`
*/
export function cellStatusOfLiveState(state: CameraLiveState): CameraCellStatus {
  return state.status
}

/** 工具栏用的一句话汇总。全部数字都由模型算出，界面不自己求和
*/
export function cameraWallSummary(
  model: CameraWallModel,
  cells: readonly CameraCellView[],
  maxStreams: number
): { assigned: number; active: number; limited: number; failed: number; max: number } {
  return {
    assigned: assignedCameraIds(model).length,
    active: cells.filter((cell) => isCameraCellActive(cell.status)).length,
    limited: cells.filter((cell) => cell.status === 'limit-exceeded').length,
    failed: cells.filter(
      (cell) => cell.status === 'error' || cell.status === 'ffmpeg-missing'
    ).length,
    max: maxStreams
  }
}

// ---------------------------------------------------------------------------
// 设备树双击的辅助判定
// ---------------------------------------------------------------------------

/**
 * 一台设备能不能进视频墙
 *
 * 只有**声学相机**走 RTSP 视频：声纹设备（box）只有 8 路音频通道，把它放进视频格
 * 会让主进程拒绝（`camera-live:start` 明确拒绝非相机设备）并显示一条与操作员
 * 所做的事无关的错误。所以「不能双击」这件事在这里就回答掉。
 */
export function isWallCapableDevice(device: Pick<Device, 'kind'> | undefined): boolean {
  return device?.kind === 'acousticCamera'
}

/** 设备树上「这一路通道开着吗」的判定 — 只走 `channelState()` 一处
*/
export function deviceChannelState(channel: Channel | undefined): ChannelState {
  return channelState(channel)
}

// ---------------------------------------------------------------------------
// 空白格上的相机选择器：那块浮层摆在哪儿
// ---------------------------------------------------------------------------

/** 一个矩形，视口坐标（`getBoundingClientRect()` 的形状，只取需要的四个边）。 */
export interface ViewportRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** 浮层落在被点那一格的哪一侧。 */
export type CameraPickerPlacement = 'below' | 'above'

/** 浮层的落点（`position: fixed` 的 `left` / `top`）。 */
export interface CameraPickerPosition {
  left: number
  top: number
  placement: CameraPickerPlacement
}

/** 浮层与那一格之间留的缝（也是它与窗口边缘留的缝）。 */
export const CAMERA_PICKER_GAP = 4

/**
 * 把相机选择器的浮层放进视口 —— **贴着被点的那一格**。
 *
 * 为什么这件事要有一个纯函数（业主 2026-09-18 报的 bug）
 * 上一版的选择器是一个原生 `<select>`，挂在整面墙末尾的 `.visually-hidden` 宿主里
 * （1×1、`clip: rect(0 0 0 0)`），由 `showPicker()` 打开。原生下拉贴在**它自己那个
 * 盒子的边上**，于是清单弹在页面左上区那个 1×1 的盒子上，而不是操作员点的那一格上 ——
 * 真窗口里量到两者相距 **561px**（宿主 `{left:273, top:97, 1×1}`，被点的那一格
 * `{left:834, top:148}`，1440×900，见 `scripts/demo-shot-driver.cjs` 的
 * `camera picker` 探针）。操作员的说法是「位置好像被盖住了，没有显示出来」。
 * 换成自己画的浮层之后，「开在哪里」变成我们自己的算术，而算术要有测试：
 * 它不会再随页面布局漂走。
 *
 * 规则（三条，按优先级）：
 *   1. **优先开在那一格下面**（与下拉框一致）；下面放不下就翻到**上面**；
 *      `placement` 把选了哪一侧如实报出来（探针据此断言，不靠猜）。
 *   2. **水平方向对齐那一格的左边缘**，然后夹进 `[gap, 视口宽 - 浮层宽 - gap]`；
 *      浮层比视口还宽时退到左边缘 `gap`（宁可窄，不可出界）。
 *   3. 上下两侧都放不下时**仍然选下面**，只把 `top` 夹进视口 —— 夹紧之后它会压住那一格，
 *      但「压住一格」比「跑到窗口外面」好：看得见的东西才能被点，这是这个 bug 的教训。
 */
export function placeCameraPicker(
  anchor: ViewportRect,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  gap: number = CAMERA_PICKER_GAP
): CameraPickerPosition {
  const menuWidth = Math.max(0, menu.width)
  const menuHeight = Math.max(0, menu.height)
  const gapPx = Math.max(0, gap)

  const belowTop = anchor.bottom + gapPx
  const aboveTop = anchor.top - gapPx - menuHeight
  const fitsBelow = belowTop + menuHeight <= viewport.height
  const fitsAbove = aboveTop >= 0
  const placement: CameraPickerPlacement = fitsBelow || !fitsAbove ? 'below' : 'above'

  const maxLeft = Math.max(gapPx, viewport.width - menuWidth - gapPx)
  const maxTop = Math.max(gapPx, viewport.height - menuHeight - gapPx)
  const clamp = (value: number, max: number): number =>
    Math.min(Math.max(gapPx, value), Math.max(gapPx, max))

  return {
    left: clamp(anchor.left, maxLeft),
    top: clamp(placement === 'below' ? belowTop : aboveTop, maxTop),
    placement
  }
}
