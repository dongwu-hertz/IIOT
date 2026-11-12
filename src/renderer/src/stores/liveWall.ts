/**
 * 多路实时视频墙的会话状态：档位、格子分配、出声格、当前格。
 *
 * 为什么是 Pinia store + localStorage
 *   1. 产品要求「档位、格子分配与声音选择在**会话内**保持，档位至少活过导航」。
 *      组件里的 `ref` 会随路由卸载消失，所以状态必须住在组件之外（store）。
 *   2. 档位额外写进 localStorage，沿用本仓库既有的 `hertzinno.` 前缀与
 *      `try/catch` 写法（`composables/useLocale.ts`、`lib/cameraLivePrefs.ts`）。
 *      格子分配**只在内存里**：它指的是「哪台相机在哪一格」，而设备 id 是数据库
 *      主键，重启后可能对应另一台设备 —— 把一个可能过期的 id 从磁盘上恢复出来，
 *      会在启动时静默拉一路谁也没要求的视频。
 *   3. 所有**决定**都在 `lib/cameraWall.ts` 的纯函数里，本文件只做三件事：
 *      保存状态、调用纯函数、把结果交给视图去发 IPC / 写 localStorage。
 *
 * 状态与设备列表的关系
 *   `syncDevices()` 是设备列表（可能来自健康监测推送、删除、刷新）与墙之间的
 *   唯一同步点：设备被删掉就清空它占的格并记下原因，设备离线就把它那一路标成
 *   「设备离线」并交给视图去停。绝不留一个指向已删设备的死 `<video>`。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Device } from '@shared/domain/models'
import {
  DEFAULT_MAX_CONCURRENT_CAMERA_STREAMS,
  normaliseMaxConcurrentStreams,
  type CameraLiveState
} from '@shared/domain/camera-live'
import {
  DEFAULT_CAMERA_WALL_LAYOUT,
  addManualSource as addManualSourceToModel,
  assignCamera,
  buildCameraCells,
  cameraCellCount,
  cameraCellStartPermission,
  cameraWallSummary,
  cellViewSwitchPermission,
  clearCameraCell,
  clearCameraWallCells,
  createCameraWallModel,
  enqueueWallItem,
  focusSlotForDevice,
  isCameraWallLayout,
  isWallCapableDevice,
  manualSourceById,
  manualSourcesOf,
  removeDeviceFromWall,
  removeIdFromQueue,
  removeManualSource as removeManualSourceFromModel,
  rotateWallOnce,
  setActiveSlot,
  setAudioSlot,
  setCameraCellView,
  setCameraWallLayout,
  toggleAudioSlot,
  updateManualSource as updateManualSourceInModel,
  type CameraCellStatus,
  type CameraWallLayout,
  type CameraWallModel,
  type WallQueueItem
} from '@renderer/lib/cameraWall'
import { isManualRtspId, type ManualRtspSource } from '@shared/domain/rtsp-source'
import type { CameraCellViewMode } from '@shared/domain/camera-cell-view'
import {
  MAX_CUSTOM_VIEWS,
  bindViewToDevices,
  normaliseViews,
  validateDivision,
  type BoundView,
  type CameraDivision,
  type CameraView
} from '@renderer/lib/cameraViewDivision'

/** 档位偏好的 localStorage 键（格子分配刻意不持久化，见文件头）。 */
export const CAMERA_WALL_LAYOUT_STORAGE_KEY = 'hertzinno.cameraWall.layout'

function readStoredLayout(): CameraWallLayout {
  try {
    const raw = window.localStorage.getItem(CAMERA_WALL_LAYOUT_STORAGE_KEY)
    const parsed = raw === null ? NaN : Number(raw)
    return isCameraWallLayout(parsed) ? parsed : DEFAULT_CAMERA_WALL_LAYOUT
  } catch {
    return DEFAULT_CAMERA_WALL_LAYOUT
  }
}

function writeStoredLayout(layout: CameraWallLayout): void {
  try {
    window.localStorage.setItem(CAMERA_WALL_LAYOUT_STORAGE_KEY, String(layout))
  } catch {
    // 记不住偏好不应该让切换偏好本身失败。
  }
}

/**
 * 视图对象的 localStorage 键。
 *
 * 与档位分开存：档位是一个数字、坏值回落到默认档；视图是一个数组、坏值要**逐项修补**
 * （`normaliseViews` 负责丢坏值、截断到 5 套、把绑定数组对齐格子数）。
 */
export const CAMERA_WALL_VIEWS_STORAGE_KEY = 'hertzinno.cameraWall.views'

/** 从磁盘读视图列表。**一律当作不可信输入**：坏值丢弃而不是让界面起不来。 */
function readStoredViews(): CameraView[] {
  try {
    const raw = window.localStorage.getItem(CAMERA_WALL_VIEWS_STORAGE_KEY)
    if (raw === null) return []
    return normaliseViews(JSON.parse(raw))
  } catch {
    return []
  }
}

/**
 * 「某台设备/内容为什么空了、排在第几位」的记录。
 *
 * 单独存一份而不是塞进格子模型：模型是纯的、可逐位比较的（见
 * `lib/cameraWall.ts`），而原因是一次性事件的说明文字，用过就该消失。
 */
export interface CameraWallNotice {
  kind:
    | 'device-removed'
    | 'device-offline'
    | 'layout-shrunk'
    | 'limit-exceeded'
    /** 切换视图被拒：同 (id, view) 已在别格。 */
    | 'already-shown'
    /** 被替换下来的内容进了轮询队列（`position` = 队列位置，1 起）。 */
    | 'queued'
  deviceName?: string
  /** `layout-shrunk` 时被停掉的路数。 */
  count?: number
  /** `limit-exceeded` 时的上限与当前路数。 */
  max?: number
  active?: number
  /** `queued` 时那一项在轮询队列里的位置（1 起）。 */
  position?: number
}

export const useCameraWallStore = defineStore('cameraWall', () => {
  /**
   * 模型本身。
   *
   * 用 `ref` 包一个普通对象而不是 `reactive`：`lib/cameraWall.ts` 的每个变换都
   * 返回**新对象**，整体替换比深层响应式代理更容易推理，也避免把响应式代理传进
   * 纯函数（那会让「就地修改 store」这种毛病变得可能）。
   */
  const model = ref<CameraWallModel>(createCameraWallModel(readStoredLayout()))

  /** 设备列表。由 `bindDevices()` 注入，见文件头。 */
  const deviceList = ref<readonly Device[]>([])

  /** 主进程的逐会话状态。界面只读，它由 `cameraLive:state` 与 `start` 的返回填充。 */
  const states = ref<Record<string, CameraLiveState>>({})

  /** 本机并发上限（`camera-live:limits` 的 `max`）。拿不到时用同一个默认常量。 */
  const maxStreams = ref<number>(DEFAULT_MAX_CONCURRENT_CAMERA_STREAMS)
  /**
   * 主进程报的当前路数。
   *
   * `null` 表示**还没问到**，此时 `startPermission()` 用界面的估计值兜底。
   * 与「主进程说是 0 路」严格区分：把 0 当成「没问到」会让判断在有会话停止后
   * 一直高估占用，从而误报超出上限。
   */
  const reportedActive = ref<number | null>(null)

  /** 最近一次「因为什么空掉了」的说明，供界面提示条使用。 */
  const notice = ref<CameraWallNotice | null>(null)

  /** 一次拒绝：格子状态，用来把「为什么没能开始」画在那一格上。 */
  const refusal = ref<{ slot: number; status: CameraCellStatus } | null>(null)

  const layout = computed(() => model.value.layout)
  const cellCount = computed(() => cameraCellCount(model.value.layout))
  const audioSlot = computed(() => model.value.audioSlot)
  const activeSlot = computed(() => model.value.activeSlot)

  const cells = computed(() =>
    buildCameraCells(model.value, {
      devices: deviceList.value,
      states: states.value,
      maxStreams: maxStreams.value
    })
  )

  const summary = computed(() => cameraWallSummary(model.value, cells.value, maxStreams.value))

  // -------------------------------------------------------------------------
  // 依赖注入与主进程状态的写入点
  // -------------------------------------------------------------------------

  function bindDevices(list: readonly Device[]): void {
    deviceList.value = list
  }

  /** 用一批主进程快照覆盖状态（`cameraLive:state`）。 */
  function applyStates(list: readonly CameraLiveState[]): void {
    const next: Record<string, CameraLiveState> = { ...states.value }
    for (const state of list) next[state.deviceId] = state
    states.value = next
  }

  /** 用一次 start 的结果覆盖一台设备的状态。 */
  function applyState(state: CameraLiveState): void {
    states.value = { ...states.value, [state.deviceId]: state }
  }

  /** 丢掉一台设备的状态（停止之后，这一格要回到「未开始」）。 */
  function forgetState(deviceId: string): void {
    if (!(deviceId in states.value)) return
    const next = { ...states.value }
    delete next[deviceId]
    states.value = next
  }

  function setLimits(max: number, active: number): void {
    maxStreams.value = normaliseMaxConcurrentStreams(max)
    reportedActive.value = Number.isFinite(active) ? Math.max(0, Math.floor(active)) : null
  }

  function setNotice(next: CameraWallNotice | null): void {
    notice.value = next
  }

  function clearRefusal(): void {
    refusal.value = null
  }

  // -------------------------------------------------------------------------
  // 格子的操作
  // -------------------------------------------------------------------------

  /**
   * 把一台相机放进某一格（可带视图；缺省 = 播放）。
   *
   * 三条入口（设备树双击、拖拽、选择器两步选择）都走这里，所以「同一 (id, view)
   * 全墙唯一」只有一份实现：别格已有同组合时会**移动**过来，同 id 只出现在别的
   * **视图**上时则两格共存。
   *
   * 被替换下来的内容（`evicted`）**进轮询队列**：格子满了再放 = 覆盖，而覆盖不
   * 等于丢弃（业主 2026-09-21 批「超出窗口数自动轮询」），它排队等着下一轮轮换。
   */
  function placeDevice(
    slot: number,
    deviceId: string,
    view?: CameraCellViewMode
  ): { ok: boolean; movedFrom: number | null; evicted: WallQueueItem | null } {
    const device = deviceList.value.find((item) => item.id === deviceId)
    /**
     * 手填的第三方 RTSP 源（业主 2026-09-19 第 3 条）不在设备表里，所以它必须**先**判：
     * `isWallCapableDevice(undefined)` 会把它当成"不是相机"拒掉，而它明明是一条可用的源。
     */
    if (!isManualRtspId(deviceId) && !isWallCapableDevice(device)) {
      return { ok: false, movedFrom: null, evicted: null }
    }
    if (isManualRtspId(deviceId) && !manualSourceById(model.value, deviceId)) {
      return { ok: false, movedFrom: null, evicted: null }
    }
    const result = assignCamera(model.value, slot, deviceId, view)
    model.value = result.model
    if (result.evicted !== null) {
      model.value = enqueueWallItem(model.value, result.evicted.id, result.evicted.view)
      const queue = model.value.queue ?? []
      const at = queue.findIndex(
        (item) => item.id === result.evicted?.id && item.view === result.evicted?.view
      )
      if (at >= 0) notice.value = { kind: 'queued', position: at + 1 }
    }
    clearRefusal()
    return { ok: result.changed, movedFrom: result.movedFrom, evicted: result.evicted }
  }

  /**
   * 放进第一个空格；墙满了就进轮询队列，**不覆盖任何一格**（业主 2026-09-24：
   * 「打开预览看到视频时，应该能直接添加进视频墙」——监测页的入口调它）。
   *
   * 已经在墙上（任意视图）时不重复放：`slotForDevice` 先查一遍。
   */
  function placeDeviceAuto(deviceId: string): { ok: boolean; queued: boolean; already: boolean } {
    if (slotForDevice(deviceId) >= 0) return { ok: true, queued: false, already: true }
    const emptyIndex = model.value.slots.findIndex((slot) => slot === null)
    if (emptyIndex >= 0) {
      const result = placeDevice(emptyIndex, deviceId)
      return { ok: result.ok, queued: false, already: false }
    }
    const next = enqueueWallItem(model.value, deviceId, 'play')
    const queued = next !== model.value
    model.value = next
    return { ok: queued, queued, already: false }
  }

  // -------------------------------------------------------------------------
  // 手填的第三方 RTSP 源（业主 2026-09-19 第 3 条）
  // -------------------------------------------------------------------------

  /**
   * 手填源列表（模板直接读它）。
   *
   * **不写盘**：手填地址里常常带设备口令（`rtsp://user:pass@host/...`），把它落到
   * localStorage 就是一份明文凭据 —— 而设备凭据走的是操作系统加密的凭据库
   * （spec 14.1）。为了一面墙的便利去开第二套明文凭据，代价与收益完全不成比例。
   * 于是它与格子分配一样只在内存里（见文件头"格子分配只在内存里"那一段）。
   */
  const manualSources = computed(() => manualSourcesOf(model.value))

  function addManualSource(source: ManualRtspSource): void {
    model.value = addManualSourceToModel(model.value, source)
  }

  function updateManualSource(id: string, patch: { name?: string; url?: string }): boolean {
    const next = updateManualSourceInModel(model.value, id, patch)
    if (next === model.value) return false
    model.value = next
    return true
  }

  /** 删掉一条手填源：占用它的格子一起清空，把它从轮询队列里清掉，并交出需要停掉的会话 id。 */
  function removeManualSource(id: string): { toStop: string[]; clearedSlots: number[] } {
    const result = removeManualSourceFromModel(model.value, id)
    model.value = removeIdFromQueue(result.model, id)
    if (result.clearedSlots.length === 0) return { toStop: [], clearedSlots: [] }
    forgetState(id)
    if (model.value.audioSlot === null && audioSlot.value !== null) setAudio(null)
    return { toStop: [id], clearedSlots: result.clearedSlots }
  }

  /** 双击设备树的落点：已经在墙上就回到它那一格，否则空格 / 当前格。 */
  function slotForDevice(deviceId: string): number {
    return focusSlotForDevice(
      model.value,
      deviceId,
      deviceList.value.map((device) => device.id)
    )
  }

  function clearCell(slot: number): void {
    const id = model.value.slots[slot] ?? null
    let next = clearCameraCell(model.value, slot)
    // 手动清空 = 操作员明确说"这一格的东西我不要了"：它同时**退出轮询队列**，
    // 否则下一轮轮换会把它又轮回来。
    if (id !== null) next = removeIdFromQueue(next, id)
    model.value = next
    clearRefusal()
  }

  /**
   * 设置某一格的视图（播放 / 1 秒时域图 / 频域图 / 时频谱图，业主 2026-09-18 第 10 批第 2 条）。
   *
   * 先问 `cellViewSwitchPermission()`：同 (id, view) 已在别格时**拒绝并说明**
   * （业主 2026-09-21 批「相同内容只允许一次」），而不是静默切成两格一样的图。
   * 空格与「这一格不支持的视图」仍由纯函数拒掉，所以这里不再判第二次。
   */
  function setCellView(slot: number, view: CameraCellViewMode): void {
    if (cellViewSwitchPermission(model.value, slot, view) === 'already-shown') {
      notice.value = { kind: 'already-shown' }
      return
    }
    model.value = setCameraCellView(model.value, slot, view)
  }

  /**
   * 轮询队列（业主 2026-09-21 批「超出窗口数自动轮询」）。
   *
   * 只读投影：模型里的 `queue` 是可选字段（缺席 = 空队），模板与组件靠这个
   * computed 取值，不用每次写 `?? []`。
   */
  const queue = computed<readonly WallQueueItem[]>(() => model.value.queue ?? [])

  /**
   * 轮一轮（界面每 `WALL_ROTATION_INTERVAL_MS` 调一次）。
   *
   * 把纯函数的结果落到模型上，并如实交出「哪一格、轮走了什么、轮进了什么」，
   * 调用方据此停被轮走的会话、起新进来的会话。队空时 `{ changed: false }`，
   * 调用方什么都不用做。
   */
  function rotateOnce(): {
    changed: boolean
    slot: number | null
    evicted: WallQueueItem | null
    incoming: WallQueueItem | null
  } {
    const result = rotateWallOnce(model.value)
    model.value = result.model
    if (!result.changed) return { changed: false, slot: null, evicted: null, incoming: null }
    return {
      changed: true,
      slot: result.slot,
      evicted: result.evicted,
      incoming: result.incoming
    }
  }

  function setActive(slot: number): void {
    model.value = setActiveSlot(model.value, slot)
  }

  /** 切换某一格的声音（全局至多一格出声）。 */
  function toggleAudio(slot: number): void {
    model.value = toggleAudioSlot(model.value, slot)
  }

  function setAudio(slot: number | null): void {
    model.value = setAudioSlot(model.value, slot)
  }

  /**
   * 换档位。
   *
   * 变小时被挤掉的相机必须**先停止**（调用方据 `evictedDeviceIds` 去 stop），
   * 否则主进程里会留下没人看的 ffmpeg —— 「档位从 16 换到 1」不该变成一次
   * 十五条 RTSP 连接的静默泄漏。
   */
  function changeLayout(next: CameraWallLayout): { evictedDeviceIds: string[] } {
    if (!isCameraWallLayout(next)) return { evictedDeviceIds: [] }
    const result = setCameraWallLayout(model.value, next)
    model.value = result.model
    for (const deviceId of result.evictedDeviceIds) forgetState(deviceId)
    writeStoredLayout(next)
    if (result.evictedDeviceIds.length > 0) {
      notice.value = { kind: 'layout-shrunk', count: result.evictedDeviceIds.length }
    }
    return { evictedDeviceIds: result.evictedDeviceIds }
  }

  /** 界面自己估计的占用路数（主进程还没回答时用）。 */
  function estimatedActive(): number {
    return summary.value.active
  }

  /**
   * 这一格现在能不能开始拉流。
   *
   * 占用路数优先用**主进程报的数**：只有它知道所有会话（包括别的页面开的，
   * 以及已经从这一格被移走但还没释放的）。界面估计只在没问到的时候兜底。
   */
  function startPermission(
    slot: number,
    deviceId: string
  ): { allowed: boolean; refusal: CameraCellStatus | null } {
    // 手填源没有"设备离线"这个概念（它连设备都不是）：可达性只能由 ffmpeg 连一次回答。
    if (!isManualRtspId(deviceId)) {
      const device = deviceList.value.find((item) => item.id === deviceId)
      if (device?.status === 'OFFLINE') return { allowed: false, refusal: 'device-offline' }
    }

    const active = reportedActive.value ?? estimatedActive()
    const permission = cameraCellStartPermission(
      model.value,
      slot,
      deviceId,
      active,
      maxStreams.value
    )
    if (!permission.allowed && permission.refusal === 'limit-exceeded') {
      notice.value = { kind: 'limit-exceeded', max: maxStreams.value, active }
    }
    if (!permission.allowed && permission.refusal !== null) {
      refusal.value = { slot, status: permission.refusal }
    }
    return permission
  }

  /**
   * 设备列表变了：删除与离线都要**显式**处理。
   *
   * 返回需要调用方停止的设备 id（本 store 不发 IPC：它不持有设备服务，而且
   * 「谁去调主进程」应当是视图的显式决定 —— 这也让这个函数在测试里可断言）。
   */
  function syncDevices(list: readonly Device[]): {
    toStop: string[]
    removedSlots: number[]
    offlineSlots: number[]
  } {
    deviceList.value = list
    const toStop = new Set<string>()
    const removedSlots: number[] = []
    const offlineSlots: number[] = []

    // 先按快照遍历：下面的修补会替换 `model`，不能一边遍历一边改。
    const snapshot = [...model.value.slots]
    for (const deviceId of snapshot) {
      if (deviceId === null) continue
      /**
       * 手填的 RTSP 源不在设备表里，而"不在设备表里"在这里**恰好**是"设备被删了"的判据。
       * 不先跳过它，一次设备列表刷新就会把墙上所有手填源当成已删设备清掉 ——
       * 而它们与设备列表毫无关系（业主 2026-09-19 第 3 条）。
       */
      if (isManualRtspId(deviceId)) continue
      const device = list.find((item) => item.id === deviceId)
      if (!device) {
        const result = removeDeviceFromWall(model.value, deviceId)
        // 设备没了，它的排号也作废：留在队里只会轮出一个指向不存在源的格子。
        model.value = removeIdFromQueue(result.model, deviceId)
        removedSlots.push(...result.clearedSlots)
        forgetState(deviceId)
        toStop.add(deviceId)
        continue
      }
      if (device.status === 'OFFLINE') {
        const index = model.value.slots.indexOf(deviceId)
        if (index >= 0) offlineSlots.push(index)
        // 会话必须真的停掉：一个离线设备的 ffmpeg 会一直重试到超时为止。
        toStop.add(deviceId)
      }
    }

    if (removedSlots.length > 0) {
      notice.value = { kind: 'device-removed' }
    } else if (offlineSlots.length > 0) {
      notice.value = { kind: 'device-offline' }
    }

    return { toStop: [...toStop], removedSlots, offlineSlots }
  }

  /**
   * 清空所有格子，保留档位。
   *
   * 退出页面时用：主进程里的每一个会话都必须被停掉（否则就是若干个没人看的
   * ffmpeg 占着相机那有限的 `rtsp_client_limit`），但档位是用户的偏好，留下。
   *
   * **手填的第三方 RTSP 源也留下**（业主 2026-09-19 第 11 批第 2 条）：它们的入口现在在
   * 实时监测页，而那一页与画面墙不同时挂载 —— 离开画面墙就把源删光，等于"配置只在
   * 站在这面墙前面时才存在"。清空的是会话，不是配置（见 `clearCameraWallCells`）。
   */
  function clearAll(layoutToKeep: CameraWallLayout = model.value.layout): string[] {
    const cleared = clearCameraWallCells(model.value, layoutToKeep)
    model.value = cleared.model
    states.value = {}
    refusal.value = null
    // 队列与游标随格子一起没了：`clearCameraWallCells()` 重建的模型不带它们
    // （业主 2026-09-21 批：离开页面 = 连"等位的内容"一起清掉）。
    return cleared.assigned
  }

  /**
   * 离开页面：只放掉**会话**，保留格子分配与视图。
   *
   * 业主 2026-11-12：「overview 界面中，如果离开后再进入，之前的配置不应该变」。
   * 原实现调用 `clearAll()`，把每格放了哪台相机一起清掉；回来只剩 auto-play 挑中的
   * 那一台，配置看起来被重置了。这里返回需要停流的 id，由视图停止 IPC 会话，但
   * `model.slots` / `audioSlot` / `activeSlot` / 具名视图全部留下。
   */
  function resetSessions(): string[] {
    const assigned = model.value.slots.filter((slot): slot is string => slot !== null)
    states.value = {}
    refusal.value = null
    notice.value = null
    return assigned
  }

  // -------------------------------------------------------------------------
  // 视图对象（iVMS 的 View = 档位 + 每格绑谁，可命名保存）
  // -------------------------------------------------------------------------

  /**
   * 视图列表。
   *
   * 与格子分配**不同**：格子分配刻意不持久化（文件头说明了理由：数据库主键重启后可能
   * 对应另一台设备），而视图里存的是**稳定的 `deviceUid`**（相机 `fa371:<ip>:<port>`、
   * 盒子 `mac:…`），所以它可以落盘——前提是恢复时**重新解析**，解析不到就留空。
   */
  const views = ref<CameraView[]>(readStoredViews())

  /** 主动保存/另存的结果，供界面说明为什么没存成（例如已到 5 套上限）。 */
  type SaveViewResult = { ok: true; view: CameraView } | { ok: false; reason: 'limit-reached' | 'invalid-division' }

  function persistViews(): void {
    try {
      window.localStorage.setItem(CAMERA_WALL_VIEWS_STORAGE_KEY, JSON.stringify(views.value))
    } catch {
      // 记不住偏好不应该让保存动作本身失败。
    }
  }

  /** 另存当前分屏为一套具名视图。超过上限时**如实拒绝**，不悄悄丢掉最旧的一套。 */
  function saveViewAs(name: string, division: CameraDivision): SaveViewResult {
    if (!validateDivision(division).ok) return { ok: false, reason: 'invalid-division' }
    if (views.value.length >= MAX_CUSTOM_VIEWS) return { ok: false, reason: 'limit-reached' }
    const view: CameraView = {
      id: `view-${Date.now().toString(36)}-${views.value.length + 1}`,
      name,
      division,
      bindings: division.cells.map(() => null)
    }
    views.value = [...views.value, view]
    persistViews()
    return { ok: true, view }
  }

  function renameView(id: string, name: string): void {
    views.value = views.value.map((view) => (view.id === id ? { ...view, name } : view))
    persistViews()
  }

  function deleteView(id: string): void {
    views.value = views.value.filter((view) => view.id !== id)
    persistViews()
  }

  /** 把某一格绑到某台设备（按 `deviceUid` 存，不存数据库主键）。 */
  function bindViewSlot(id: string, index: number, deviceUid: string | null): void {
    views.value = views.value.map((view) => {
      if (view.id !== id) return view
      const bindings = [...view.bindings]
      if (index < 0 || index >= view.division.cells.length) return view
      bindings[index] = deviceUid
      return { ...view, bindings }
    })
    persistViews()
  }

  /**
   * 解析一套视图：每格该放哪台设备、哪几格解析不到。
   *
   * **它不改模型、更不起流。** 两个理由：
   *   1. 「是否拉流」是另一个决定（`decideCameraAutoPlay()`，一次进程一次尝试）。让恢复
   *      顺手起流会绕过「操作员手动停止过就不再自动起」这条规则；
   *   2. 现在的 `CameraWallModel` **还表达不了自定义分屏**：它的档位是固定的
   *      `1 | 4 | 9 | 16`（N 个等大槽位），而 `Joint` 合并后的格子数可能是 8 这种既不是
   *      平方数也不在档位表里的值。把绑定写进去需要先把这个模型泛化成「一组矩形格子」，
   *      那是第 ⑤ 轮剩下的工作。所以这里只产出**决定**，由那一轮负责落到模型上。
   */
  function resolveView(id: string, resolveUid: (uid: string) => string | undefined): BoundView | undefined {
    const view = views.value.find((candidate) => candidate.id === id)
    if (!view) return undefined
    return bindViewToDevices(view, resolveUid)
  }

  return {
    // state
    model,
    states,
    maxStreams,
    reportedActive,
    notice,
    refusal,
    deviceList,
    views,
    // getters
    layout,
    cellCount,
    audioSlot,
    activeSlot,
    cells,
    summary,
    /** 手填的第三方 RTSP 源（业主 2026-09-19 第 3 条）。 */
    manualSources,
    /** 轮询队列（业主 2026-09-21 批「超出窗口数自动轮询」）。 */
    queue,
    // actions
    bindDevices,
    applyStates,
    applyState,
    forgetState,
    setLimits,
    setNotice,
    clearRefusal,
    placeDevice,
    placeDeviceAuto,
    addManualSource,
    updateManualSource,
    removeManualSource,
    slotForDevice,
    clearCell,
    setCellView,
    rotateOnce,
    setActive,
    toggleAudio,
    setAudio,
    changeLayout,
    estimatedActive,
    startPermission,
    syncDevices,
    clearAll,
    resetSessions,
    saveViewAs,
    renameView,
    deleteView,
    bindViewSlot,
    resolveView
  }
})
