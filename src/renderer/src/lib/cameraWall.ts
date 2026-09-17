/**
 * 多路实时视频墙的**模型**（纯函数，零 Vue、零副作用、零 I/O）
 *
 * 为什么这些判断必须离开模板
 * 「同一台相机只能占一格」「还能不能再开一路」「设备被删掉时那一格怎么办」
 * 「哪一格能出声」都**由模型决定**，不是渲染。写进 `<template>` 之后它们就再也没法
 * 被单元测试直接调用（模板只能在浏览器里跑），而它们恰好是最容易出错的部分：
 * 同一台相机出现在两格里会让主进程的第二路 start 把第一格顶掉；超过并发预算
 * 那一路如果只显示一个永远转的圈，操作员会以为相机坏了
 *
 * 依赖纪律（与 `lib/channelState.ts` / `lib/channelWall.ts` 同一条）
 * 本模块运行时不导入 `@renderer/*`：`scripts/rewrite-aliases.cjs` 只重写
 * `@shared/` 与 `@main/`，所以引了 `@renderer/*` 的模块无法在测试进程里被加载
 * 因此这里只依赖 `@shared/domain/*`（纯类型与纯函数）
 *
 * 「一台相机最多一格」与「一次可以开多路相机」是两条不同的规则
 *   - 前者（产品明确要求过）由 `findCameraSlot()` / `assignCamera()` 保证
 *     同一台相机不会被放进第二格，双击/拖拽/下拉三条入口走的是同一个函数；
 *   - 后者（本机主进程能不能同时扛住 N 路） `cameraStreamLimitReached()`
 *     决定，上限来自 `AppSettings.maxConcurrentCameraStreams`
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
 * **与通道墙的那一套（1 / 4 / 8 / 16）刻意不同，也刻意不 import
 * `lib/channelWall.ts`**：视频墙的一格是一台相机，档位是几何排布；通道墙的一格是
 * 声纹盒子的一路通道，9 分屏对应的是 AE08 的 8 路通道，是**通道数决定的**，
 * 换成 9 只会得到 9 个画不出通道的格子。两处共用一个数组，会让「其中一面墙想改
 * 档位」变成对另一面墙的意外改动；`tests/camera-wall.test.ts` 会断言两套档位
 * **各自**是什么，而不是断言它们相同
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
 *   - `already-shown`  — 该相机已经在另一格里（产品明确要求「一台相机最多一格」）
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
}

export function createCameraWallModel(layout: CameraWallLayout = DEFAULT_CAMERA_WALL_LAYOUT): CameraWallModel {
  return {
    layout,
    slots: Array.from({ length: cameraCellCount(layout) }, () => null),
    audioSlot: null,
    activeSlot: 0
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

  return { layout, slots, audioSlot, activeSlot }
}

// ---------------------------------------------------------------------------
// 纯查
// ---------------------------------------------------------------------------

/**
 * 这台相机在第几格；`-1` 表示不在墙上
 * 「一台相机最多一格」的判定
 */
export function findCameraSlot(model: CameraWallModel, deviceId: string): number {
  if (deviceId === '') return -1
  return model.slots.findIndex((slot) => slot === deviceId)
}

/** 这一格绑的是哪台相机（空格返 `null`）
*/
export function cameraSlotDevice(model: CameraWallModel, index: number): string | null {
  return model.slots[index] ?? null
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

/**
 * 这一格此刻**能不能**开始拉流，以及不能时的原因
 *
 * `activeStreams` 由调用方给出（主进程 `camera-live:limits`  `active`，或界面
 * 自己的估计），`maxStreams` 是设置里的上限。两者都由外部传进来，这样这个函
 * 是纯的，而「用哪个数字」这件事留在 store 里显式可见
 *
 * 判定顺序就是操作员的心智顺序：格子已经被 -> 这台相机已经在别 -> 超预算
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
  const other = findCameraSlot(model, deviceId)
  if (other >= 0 && other !== index) return { allowed: false, refusal: 'already-shown' }
  if (cameraStreamLimitReached(activeStreams, maxStreams)) {
    return { allowed: false, refusal: 'limit-exceeded' }
  }
  return { allowed: true, refusal: null }
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

  return { model: { layout, slots, audioSlot, activeSlot }, evictedDeviceIds }
}

/**
 * 把一台相机放进某一格 —
 * **双击设备树、拖拽、下拉选择共用的唯一入口**
 *
 * 「一台相机最多一格」在这里被执行：如果这台相机已经在另一格（且不是这一格）
 * 它会**移动**到目标格，源格清空。移动而不是新增，是因为同一台相机的两路会话
 * 在主进程里会互相顶掉（`RtspSession` 的 start 会替换旧会话），界面上出现两格
 * 「正在启动」而只有一格有画面，是比拒绝更糟的结果
 */
export function assignCamera(
  model: CameraWallModel,
  index: number,
  deviceId: string
): { model: CameraWallModel; movedFrom: number | null; changed: boolean } {
  const size = wallCellCount(model)
  if (index < 0 || index >= size || deviceId === '') {
    return { model, movedFrom: null, changed: false }
  }

  const previous = findCameraSlot(model, deviceId)
  if (previous === index) return { model, movedFrom: null, changed: false }

  const slots = [...model.slots]
  if (previous >= 0) slots[previous] = null
  slots[index] = deviceId

  // 把出声标记跟着相机走：移动一格之后声音不应该留在原来那个空格上
  const audioSlot =
    model.audioSlot === previous ? index : model.audioSlot !== null && model.audioSlot < size
      ? model.audioSlot
      : null

  return {
    model: { ...model, slots, audioSlot, activeSlot: index },
    movedFrom: previous >= 0 ? previous : null,
    changed: true
  }
}

/** 清空一格：顺手清掉这一格的出声标记
*/
export function clearCameraCell(model: CameraWallModel, index: number): CameraWallModel {
  if (index < 0 || index >= model.slots.length || model.slots[index] === null) return model
  const slots = [...model.slots]
  slots[index] = null
  const audioSlot = model.audioSlot === index ? null : model.audioSlot
  return { ...model, slots, audioSlot }
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
  return { ...model, slots, audioSlot }
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
 *   1. 这台相机已经在墙 -> 就是它那一格（双击 = 把这台相机切到眼前）
 *   2. 当前格是空的 -> 当前格；
 *   3. 否则第一个空格；
 *   4. 全满 -> 当前格（替换掉原来那台，等主进程 stop 旧会话）
 */
export function focusSlotForDevice(
  model: CameraWallModel,
  deviceId: string,
  deviceIds: readonly string[] = []
): number {
  const existing = findCameraSlot(model, deviceId)
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

  return Array.from({ length: size }, (_, index) => {
    const deviceId = model.slots[index] ?? null
    /** `key` / `index` 每一格都有；`audio` 要等状态定下来才算（见 `audibleAt()`）
*/
    const base = { key: `camera-cell:${wallGeometryToken(model)}:${index}`, index }

    // 空格子：这一格在界面上只有右侧一个大 `+`，一个字都不写（产品要求），
    // 所以它**没有** messageKey — 目录里也没有「空格子」这条词条。
    if (deviceId === null) {
      return {
        ...base,
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
      return {
        ...base,
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

    const other = findCameraSlot(model, deviceId)
    if (other >= 0 && other !== index) {
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
