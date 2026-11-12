<script setup lang="ts">
/**
 * 多路实时视频墙（产品要求「如果我添加多个设备，则需要支持多路的视频显示」）。
 *
 * 每一格 = **一台相机的一路直播**。这个组件只做四件事：
 *   1. 把 `stores/liveWall` 的模型画成画面格；
 *   2. 把控制条/双击/拖拽翻译成对 store 的调用；
 *   3. 调 `window.api.cameraLive.*`（本组件是唯一发这些 IPC 的地方）；
 *   4. 把主进程的 `CameraLiveState` 写回 store。
 * 所有「同一内容（同 id 同视图）只能出现一次」「超过并发上限」「设备被删掉怎么办」
 * 的判断都在 `lib/cameraWall.ts` 的纯函数里，模板里没有一条业务规则。
 *
 * 一格里的动作只有**底部一条控制条**（产品要求）
 * 原来动作在顶部叠加条上（停止 / 关闭声音 / 全屏 / 关闭）。顶部那条现在只说事实：
 * 哪台相机、什么状态、是不是正在出声；一格里的**操作**全部集中到底部那一条 ——
 * 播放/停止、全屏、音量图标、音量滑块，与常规播放器一致，而且「这一格能怎么操作」
 * 只有一处说得出来，不会出现同一件事在两个地方各说一遍。
 *
 * 为什么每一格的状态必须**具体**，而且必须**短**
 * 一个永远转的加载圈、或者一块没有任何解释的黑矩形，在值班台上等于「不知道」。
 * 所以每一种「没有画面」都有自己的短状态词：未开始 / 正在启动 / RTSP 未启用 /
 * 找不到 ffmpeg / 流错误 / 超过并发上限 / 该相机已在另一格 / 设备已删除 / 设备离线。
 * 长句子不进来：只有**设备亲口说的话**（ffmpeg 的 stderr 尾行、`rtsp_enabled=0`、
 * 上限说明）才原样显示，因为那是实际发生的那件事；「该怎么办」是解释而不是状态，
 * 画面格里不写。
 *
 * 音频独占
 * 至多一格出声，`wall.audioSlot` 是模型里那唯一的出声格。界面这边还有两件必须做对的
 * 事：
 *   - `<video>` 的真实 `muted` / `volume` 属性要跟着模型走（浏览器读的是元素属性，
 *     只改自己的状态不改属性，就会出现「徽标说没声音、耳朵听到有声音」）；
 *   - 没有画面的格子**不可能**出声，所以那一格的音量控件是禁用的，而且禁用时它的
 *     无障碍名字直接说出这件事（`cameraWallUi.volumeNoPicture`）—— 一个按下去什么
 *     都不会发生、也不说为什么的按钮，比一个说明了自己不能按的按钮更糟。
 *
 * 空白格只有中间一个大 `+`
 * **这一条推翻了上一轮的决定**：上一轮把 `+` 靠在格子右侧（产品当时的要求是「做成
 * 一个大的+号放在右侧」）。产品负责人这一轮改主意了 ——「添加新视频或者声纹图的加号
 * 应该在窗口中心」—— 所以 `+` 现在在格子的正中（横向、纵向都居中）。
 * 仍然没有文字、没有可见的下拉框（产品要求）。`+` 也仍然是真正的入口：点它（或用键盘
 * 回车）就打开这一格的相机选择器。
 *
 * 选择器**不再是原生 `<select>`**（业主 2026-09-18 报的 bug）
 * 上一版把它做成藏在墙末尾 `1×1` 宿主里的原生下拉、用 `showPicker()` 打开，结果原生
 * 下拉贴在页面左上区那个 1×1 的盒子上：真窗口里量到它离操作员点的那一格 **561px**
 * （见 `CameraCellPicker.vue` 文件头里的数字），操作员看到的是「弹了一下 / 位置被盖住 /
 * 根本没显示出来」。现在换成自己画的浮层（`CameraCellPicker.vue`），位置由
 * `placeCameraPicker()` 这个纯函数算出来（贴在这一格旁边、放不下翻到上面、最后夹进
 * 视口，有单测也有 GUI 探针断言）。选项仍然只来自 `optionsForCell()`，
 * 「哪几台相机可选」没有第二份实现。
 *
 * 生命周期
 * 进入页面时按模型恢复（只对已经在墙上的相机重新拉流），离开页面时停止**所有**会话并
 * 清空格子里的状态：主进程里每一个会话都是一个 ffmpeg 与一条 RTSP 连接，导航不会
 * 释放它们。
 *
 * 两个页面共用这一个组件，自动起播是**总览页独有**的一件事
 * `/monitor` 的用法不变（不传 `auto-play`）。总览页传 `auto-play`，由本组件在它的
 * 输入真的变化时反复**评估**「相机在工作就自动播放」——判定本身仍然只有
 * `cameraLive.autoPlayIfWorking()`（内部是 `decideCameraAutoPlay()`）一份，
 * 本组件既不重写规则，也不新增第二条自动起播路径（见 `requestAutoPlay()`）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  DEFAULT_MAX_CONCURRENT_CAMERA_STREAMS,
  type CameraLiveState
} from '@shared/domain/camera-live'
import type { Device } from '@shared/domain/models'
import { isManualRtspId } from '@shared/domain/rtsp-source'
import type { CameraCellViewMode } from '@shared/domain/camera-cell-view'
import { useCameraCellChartsStore } from '@renderer/stores/cameraCellCharts'
import CameraCellChart from '@renderer/components/CameraCellChart.vue'
import {
  buildCameraNvrMenu,
  cameraCaptureReadiness,
  type CameraNvrAction,
  type CameraNvrEnvironment,
  type CameraNvrMenuItem
} from '@shared/domain/camera-nvr'
import {
  CAMERA_CELL_VIEW_KEYS,
  CAMERA_CELL_VIEW_MODES
} from '@shared/domain/camera-cell-view'
import {
  CAMERA_WALL_LAYOUTS,
  cameraWallColumns,
  findWallItem,
  isCameraCellLive,
  type CameraCellView,
  type CameraWallLayout
} from '@renderer/lib/cameraWall'
import { formatBytes, formatDuration } from '@renderer/lib/format'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { EnvelopePlayer } from '@renderer/lib/envelopePlayer'
import { resetAutoPlayAttempts, useCameraLiveStore } from '@renderer/stores/cameraLive'
import { useDevicesStore } from '@renderer/stores/devices'
import { useCameraWallStore } from '@renderer/stores/liveWall'
import { useSettingsStore } from '@renderer/stores/settings'
import CameraCellPicker, {
  type CameraPickerItem,
  type CameraPickerViewOption
} from '@renderer/components/CameraCellPicker.vue'
import CameraDetectDownloadDialog from '@renderer/components/CameraDetectDownloadDialog.vue'
import CameraRecordingPlaybackDialog from '@renderer/components/CameraRecordingPlaybackDialog.vue'
import LayoutGridIcon from '@renderer/components/LayoutGridIcon.vue'
import VideoContextMenu from '@renderer/components/VideoContextMenu.vue'

const props = defineProps<{
  /** 设备树当前选中的设备 id：它的那一格会被标成「当前格」。 */
  activeDeviceId?: string
  /**
   * 输入变化时持续评估「相机在工作就直接出画面」。
   *
   * 只有总览页传 `true`：总览是应用启动后第一个渲染的页面，产品要求「打开软件时
   * 相机在工作就直接出画面」。监测页有自己的入口（`MonitorView.autoPlayCameraIfWorking`），
   * 两边调用的都是同一个 `cameraLive.autoPlayIfWorking()`，所以「一台相机一次进程一次
   * 尝试」与「手动停止优先」对两条入口都成立。默认 `false` 让 `/monitor` 的既有行为
   * 一点都不变。
   */
  autoPlay?: boolean
}>()

const { t } = useI18n()
const devices = useDevicesStore()
const wall = useCameraWallStore()
/** 图表格的数据来源（每台设备一份订阅，多条图表格共享；见那个 store 的文件头）。 */
const charts = useCameraCellChartsStore()
const cameraLive = useCameraLiveStore()
const settings = useSettingsStore()

/** 正在忙的格子（按钮防重入），按格号索引。 */
const busy = ref<Record<number, boolean>>({})
const fullscreenSlot = ref<number | null>(null)
const cellEls = ref<Record<number, HTMLElement | null>>({})
const videoEls = ref<Record<number, HTMLVideoElement | null>>({})
/**
 * 每一格上一次设定的音量（0–1），没有记录过就是满音量。
 *
 * **逐格记忆**（而不是全局一个值）是刻意的：滑块属于某一格，把 A 格调到 30% 之后
 * 切到 B 格再切回来，A 不应该自己变回 100%。这个表只是记忆，真正的音量写在
 * `<video>.volume` 上（见 `applyAudioOutput()`）。
 */
const volumes = ref<Record<number, number>>({})

const cells = computed<CameraCellView[]>(() => wall.cells)
const layout = computed(() => wall.layout)
const columns = computed(() => cameraWallColumns(layout.value))
const columnStyle = computed(() => ({ gridTemplateColumns: `repeat(${columns.value}, minmax(0, 1fr))` }))

/** 只有声学相机能进画面格：声纹设备没有 RTSP 视频。 */
const cameraDevices = computed<Device[]>(() =>
  devices.devices.filter((device) => device.kind === 'acousticCamera')
)

/**
 * 第一步的设备清单：墙上有这一格**自己**那一台在除外。
 *
 * 业主 2026-09-21 批：相机**不再因"已上墙"被过滤** —— 一台相机可以占多格
 * （画面一格、时域图一格……），哪几个 (相机, 视图) 组合还空着，由第二步的
 * 视图按钮自己说（禁用的那几个）。这一格自己的那一台也不再列出：选择器是
 * 「放哪一台进来」，把已经在这一格的那台再列一次，只会让操作员点出一个空操作。
 */
function optionsForCell(cell: CameraCellView): Device[] {
  return cameraDevices.value.filter((device) => device.id !== cell.deviceId)
}

const noticeText = computed(() => {
  const notice = wall.notice
  if (!notice) return ''
  if (notice.kind === 'layout-shrunk') {
    return t('cameraWallUi.layoutShrunk', { count: notice.count ?? 0 })
  }
  if (notice.kind === 'limit-exceeded') {
    return t('cameraWallUi.limitNotice', {
      max: notice.max ?? wall.maxStreams,
      active: notice.active ?? wall.estimatedActive()
    })
  }
  // 视图切换被拒：同 (id, 视图) 已在别格（业主 2026-09-21 批「相同内容只允许一次」）。
  if (notice.kind === 'already-shown') {
    return t('cameraWallUi.viewAlreadyShown')
  }
  // 被替换下来的内容进了轮询队列：如实报出它的位置（1 起）。
  if (notice.kind === 'queued') {
    return t('cameraWallUi.queuedNotice', { position: notice.position ?? 0 })
  }
  // 设备删除/离线：界面只知道「有设备没了」，具体是哪一台由那一格自己说明
  // （格子状态就是 device-removed / device-offline）。
  return t(
    notice.kind === 'device-removed'
      ? 'cameraWallUi.statusDeviceRemoved'
      : 'cameraWallUi.statusDeviceOffline'
  )
})

/**
 * 标题右侧的「同时直播」摘要与墙的标题已按业主 2026-09-23 要求删除
 * （连同 `summaryText` 这个 computed 一起）：上限用量只在真的到顶时以提示条出现，
 * 不做常驻摘要。
 */

/**
 * 暂停/继续轮换那颗按钮的名字：说的是**按下去会发生什么**，不是现在的状态。
 *
 * 轮换指示器本身只在 `wall.queue.length > 0` 时渲染（没有队在等位，就没有什么
 * 可暂停的），文案键 `cameraWallUi.rotationIndicator` 带 `{shown}`（非空格数）与
 * `{total}`（非空格数 + 队列长度）两个参数。
 */
const rotationToggleLabel = computed(() =>
  rotationPaused.value ? t('cameraWallUi.rotationResumeTitle') : t('cameraWallUi.rotationPauseTitle')
)

// ---------------------------------------------------------------------------
// 主进程状态
// ---------------------------------------------------------------------------

/**
 * 读回本机并发预算。
 *
 * 优先问主进程（`camera-live:limits`，它才知道真实用量）；拿不到时退回设置里的
 * 上限，再拿不到就用与主进程同一个默认常量 —— 界面**绝不自己发明**一个上限。
 */
async function refreshLimits(): Promise<void> {
  const result = await callApi(() => window.api.cameraLive.limits())
  if (result.success) {
    const limits = unwrap(result)
    if (limits) {
      wall.setLimits(limits.max, limits.active)
      return
    }
  }
  const settings = await callApi(() => window.api.settings.get())
  const max = settings.success
    ? (unwrap(settings)?.maxConcurrentCameraStreams ?? DEFAULT_MAX_CONCURRENT_CAMERA_STREAMS)
    : DEFAULT_MAX_CONCURRENT_CAMERA_STREAMS
  wall.setLimits(max, wall.reportedActive ?? wall.estimatedActive())
}

/** 主进程是会话状态的权威：把某一台设备的最新状态读回来。 */
async function refreshState(deviceId: string): Promise<void> {
  const result = await callApi(() => window.api.cameraLive.state(deviceId))
  if (!result.success) return
  const list = unwrap(result) ?? []
  if (list.length === 0) {
    wall.forgetState(deviceId)
    return
  }
  wall.applyStates(list)
}

/** 把墙上所有相机的状态都刷新一遍（进入页面、开始/停止之后）。 */
async function refreshAllStates(): Promise<void> {
  const ids = wall.model.slots.filter((slot): slot is string => slot !== null)
  if (ids.length === 0) return
  const result = await callApi(() => window.api.cameraLive.state())
  if (result.success) wall.applyStates(unwrap(result) ?? [])
  await refreshLimits()
}

// ---------------------------------------------------------------------------
// 开始 / 停止
// ---------------------------------------------------------------------------

function setBusy(slot: number, value: boolean): void {
  busy.value = { ...busy.value, [slot]: value }
}

function isBusy(slot: number): boolean {
  return busy.value[slot] === true
}

/**
 * 这一格此刻**能不能开始拉流**。
 *
 * 三种状态下按下去一定什么都不会发生（不是失败，是做不到）：
 *   - `device-offline` —— 设备不在线，主进程只会得到一次超时；
 *   - `device-removed` —— 设备已经从列表里删掉了，没有任何可连的地址；
 *   - `already-shown`  —— 同一内容（同 id 的播放）已经在另一格，再开一路会把
 *     那一格顶掉（chart 视图不占会话，不在此列）。
 * 这时按钮是禁用的，而且它的无障碍名字就是那一格的短状态词，也就是禁用的原因。
 * 其余状态（尤其是 `error` 与 `limit-exceeded`）都允许再按一次：流失败了要能重试，
 * 预算满了要能在别的格停掉之后再试 —— 把重试按钮禁掉等于让操作员无法恢复。
 */
function canStartCell(cell: CameraCellView): boolean {
  return (
    cell.status !== 'device-offline' &&
    cell.status !== 'device-removed' &&
    cell.status !== 'already-shown'
  )
}

/**
 * 开始某一格的直播。
 *
 * 三道守卫按顺序：
 *   1. 设备离线/被删除 -> 直接给出格子状态，不发 IPC；
 *   2. 同一内容的播放已在别格 -> `already-shown`（两路同 id 的 ffmpeg 会互顶）；
 *   3. 超过并发预算 -> `limit-exceeded`（**在发起之前**就说清楚，而不是先起一路
 *      再收到一个失败）。
 * 只有三道都过了才真的调主进程，避免无意义的 IPC 往返与设备侧连接尝试。
 */
/**
 * 格子视频出错 / 结束（业主 2026-09-22 第 7、8 条）。
 *
 * 先回主进程问这一格的会话现在到底是什么状态；如果已经是 `error`，自动重试**一次**
 * （操作员遇到的做法本来就是再点一次开始）。每台设备一次 —— 连续失败说明是真问题，
 * 必须让错误留在屏幕上，而不是进入看不见的重试循环。恢复播放（状态离开 error）后
 * 重置计数，下一次断流还能再自动救一次。
 */
const liveAutoRetried = new Set<string>()

async function onCellVideoProblem(cell: CameraCellView): Promise<void> {
  const deviceId = cell.deviceId
  if (!deviceId) return
  await refreshState(deviceId)
  const status = cameraLive.sessionOf(deviceId)?.status
  if (status === 'playing' || status === 'starting') {
    liveAutoRetried.delete(deviceId)
    return
  }
  if (status !== 'error' || liveAutoRetried.has(deviceId) || isBusy(cell.index)) return
  liveAutoRetried.add(deviceId)
  window.setTimeout(() => {
    if (cameraLive.sessionOf(deviceId)?.status === 'error') void startCell(cell)
  }, 2_000)
}

async function startCell(cell: CameraCellView): Promise<void> {
  const deviceId = cell.deviceId
  if (!deviceId || isBusy(cell.index)) return

  const permission = wall.startPermission(cell.index, deviceId)
  if (!permission.allowed) {
    if (permission.refusal !== null) {
      wall.setNotice(
        permission.refusal === 'limit-exceeded'
          ? {
              kind: 'limit-exceeded',
              max: wall.maxStreams,
              active: wall.reportedActive ?? wall.estimatedActive()
            }
          : null
      )
    }
    return
  }

  setBusy(cell.index, true)
  try {
    /*
     * 手填的第三方 RTSP 源走 `startManual` 那一支（业主 2026-09-19 第 3 条）：
     * 它没有设备可问（`GET /system/video` / `rtsp_enabled` 都无从谈起），所以给的是
     * 那串**原样的地址**。地址从 store 的列表里取，不从这里再传一份 —— 否则"界面上显示
     * 的地址"与"真的交给 ffmpeg 的地址"会成为两份可能不一致的东西。
     */
    const manual = isManualRtspId(deviceId)
      ? wall.manualSources.find((source) => source.id === deviceId)
      : undefined
    if (isManualRtspId(deviceId) && !manual) {
      wall.applyState({ deviceId, status: 'error', error: t('cameraWallUi.manualMissing') })
      return
    }
    const result = await callApi(() =>
      window.api.cameraLive.start(
        manual ? { sourceId: manual.id, url: manual.url } : { deviceId }
      )
    )
    if (!result.success) {
      // 一次 IPC 失败仍然是一条可以画出来的状态，而不是沉默的黑格。
      wall.applyState({ deviceId, status: 'error', error: resultMessage(result) })
      return
    }
    const state = unwrap(result)
    if (state) wall.applyState(state)
    // 起播之后**一次性**补读会话状态，与自动起播那条路径同一条规矩：
    // `start` 交回的是 `starting`（ffmpeg 已经起来、回环地址已经存在），而第一帧
    // 到达、状态变成 `playing` 是随后发生的。不补读一次，这一格的徽标会一直停在
    // 「正在启动…」，而模型的 `cameraCaptureReadiness()` 也会一直说「没有可录的画面」
    // —— 于是画面明明在播，右键菜单里的录像/抓图却是灰的。那不是保守，是界面在说
    // 一件没发生的事（探针实测抓到过：`readyState=3`、正在出帧，而菜单项是灰的）。
    scheduleSettleRefresh()
  } finally {
    setBusy(cell.index, false)
    await refreshLimits()
  }
}

/**
 * 停止某一格的直播。
 *
 * 元素先释放再停主进程：`<video>` 持有的那条回环请求是「谁在拉流」的证据，
 * 反过来做会让元素在整个停止过程中不断重试一个已经不存在的地址。
 *
 * **手动录像先收尾**：正在写盘的那个 ffmpeg 读的是这一格的 RTSP 源，把会话停掉
 * 之后它就再也写不出一帧；而「停止画面」不是「丢掉这段录像」。收尾会走完整的
 * 校验并把文件登记进录像表，所以素材仍然出现在「回放本机录像」里。
 */
async function stopCell(cell: CameraCellView): Promise<void> {
  const deviceId = cell.deviceId
  if (deviceId) await stopCellRecording(cell, deviceId)
  releaseVideo(cell.index)
  if (!deviceId) return
  wall.forgetState(deviceId)
  if (wall.audioSlot === cell.index) wall.setAudio(null)
  const result = await callApi(() => window.api.cameraLive.stop(deviceId))
  if (!result.success) wall.setNotice(null)
  await refreshLimits()
}

/** 丢掉这一格的画面：`<video>` 手上的回环请求必须当场放掉，不能留一个悬空地址。 */
function releaseVideo(slot: number): void {
  const video = videoEls.value[slot]
  if (video) {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
}

async function toggleCell(cell: CameraCellView): Promise<void> {
  if (isBusy(cell.index)) return
  if (isCameraCellLive(cell.status)) await stopCell(cell)
  else await startCell(cell)
}

/**
 * 相机选择器浮层的状态：打开的是哪一格、那一格的视口矩形、以及触发它的那个按钮。
 *
 * 矩形在**打开的那一刻**量一次（而不是每次渲染都量）：浮层就是对着「刚才点的那一格」
 * 开的，格子随后被 resize 或滚动改变位置时浮层会关掉（`CameraCellPicker` 的
 * scroll/resize 监听），所以不需要跟着动。
 */
const pickerSlot = ref<number | null>(null)
/** 触发浮层的按钮：关掉之后焦点要还给键盘用户，否则焦点会掉到 `<body>`。 */
let pickerTrigger: HTMLElement | null = null

/**
 * 浮层里的候选项：相机**两步**（先设备、后视图），手填源一步到位。
 *
 * 相机项带着四个视图按钮：已经在本墙出现的 (相机, 视图) 组合禁用并标出
 * 「已在窗口」（业主 2026-09-21 批「相同内容只允许一次」）——包括**这一格自己**
 * 正在显示的那一个：选它就是空操作，禁用比"点了没反应"诚实。
 * 手填的第三方 RTSP 源照旧一步选中（它只有画面，天然唯一）。
 */
const pickerItems = computed<CameraPickerItem[]>(() => {
  const slot = pickerSlot.value
  if (slot === null) return []
  const cell = cells.value.find((item) => item.index === slot)
  if (!cell) return []
  const viewInUse = t('cameraWallUi.viewInUse')
  const cameras: CameraPickerItem[] = optionsForCell(cell).map((device) => ({
    id: device.id,
    name: device.name,
    viewsTitle: t('cameraNvrUi.menuDisplay'),
    views: CAMERA_CELL_VIEW_MODES.map((mode): CameraPickerViewOption => {
      const inUse = findWallItem(wall.model, device.id, mode) >= 0
      return {
        mode,
        label: t(CAMERA_CELL_VIEW_KEYS[mode]),
        inUse,
        ...(inUse ? { inUseLabel: viewInUse } : {})
      }
    })
  }))
  /*
   * 手填的第三方 RTSP 源也在这个列表里（业主 2026-09-19 第 3 条）：它们与相机一样是
   * "可以放进这一格的东西"，所以走同一个选择器 —— 界面上不会出现两套"选一个源进来"。
   * 名字后面缀一个「手填 RTSP」，否则一个叫「大门」的手填源与一台叫「大门」的相机在列表里
   * 长得一模一样。手填源只有画面、天然一格，照旧在**别格**占着时不列出。
   */
  const taken = new Set(
    wall.model.slots.filter((item, index): item is string => item !== null && index !== cell.index)
  )
  const manual = wall.manualSources
    .filter((source) => !taken.has(source.id))
    .map((source) => ({
      id: source.id,
      name: `${source.name}（${t('cameraWallUi.manualSuffix')}）`
    }))
  return [...cameras, ...manual]
})

/**
 * 切某一格的视图。
 *
 * 两件事一起做：模型换视图（`setCellView` 会先问「同 (id, view) 是否已在别格」，
 * 拒绝时它自己写 notice），以及**收放 RTSP 会话**（业主 2026-09-21 批：只有
 * `play` 视图占会话，图表格不占）：
 *   - 切去图表格：把这一路的 ffmpeg 会话**停掉**，不留孤儿进程（切回来再重新起，
 *     `startCell` 会先问并发预算，不会硬闯）；
 *   - 切回播放：用**换完的**那一格立刻起一路，画面不用等操作员再按一次。
 * 切去图表格之前 `<video>` 已由模板的 `v-if` 摘下（元素随视图卸载），这里只停会话。
 *
 * **入口只有一个地方**：右键菜单的「显示方式」（业主 2026-09-19 第 12 批把四颗视图按钮
 * 从控制条移走了），所以这里不再有第二份"哪几颗按钮"的判断。
 */
function chooseCellView(cell: CameraCellView, view: CameraCellViewMode): void {
  if (cell.view === view) return
  if (!cell.availableViews.includes(view)) {
    wall.setNotice(null)
    return
  }
  const fromPlay = cell.view === 'play'
  wall.setCellView(cell.index, view)
  // 被拒（同 (id, view) 已在别格）时视图没动：停在原地的那一路不该被误停。
  const updated = cells.value.find((item) => item.index === cell.index)
  if (updated === undefined || updated.view === cell.view) return
  if (fromPlay) void stopCell(cell)
  else if (view === 'play') void startCell(updated)
}

/**
 * 手填源的**管理**已经不在这一页（业主 2026-09-19 第 11 批第 2 条曾把它挪到实时监测页的
 * `ManualRtspSources.vue`；2026-09-21 第二批第 23 条又从实时监测页撤掉，该组件目前没有
 * 挂载点）。于是"改完地址把那一格重启一次"和"删掉源之后停那几路会话"这两件事
 * 原本在那边由删除动作自己收尾。
 *
 * 这一页留下的只有**使用**：选择器里列出已有的源（`pickerItems`），
 * `startCell()` 把它们作为 `{ sourceId, url }` 交给主进程。
 */

/** 浮层的无障碍名字：空白格是「选择相机」，已经有一台的是「更换相机」。 */
const pickerLabel = computed(() => {
  const slot = pickerSlot.value
  const cell = slot === null ? undefined : cells.value.find((item) => item.index === slot)
  return cell && cell.deviceId ? t('cameraWallUi.replaceDevice') : t('cameraWallUi.pickDevice')
})

/**
 * 打开/收起某一格的相机选择器 —— 空白格正中那个大 `+`、以及叠加条上的设备名都指向它。
 *
 * **位置由 `placeCameraPicker()` 算**（纯函数、有单测）：浮层贴在这一格的下面，放不下
 * 就翻到上面，最后夹进视口。业主 2026-09-18 报的那个 bug 就是位置问题：上一版用的是
 * 原生 `<select>` + `showPicker()`，下拉贴在「页面左上区那个 1×1 隐藏宿主」上（实测离
 * 被点的那一格 561px），详见 `CameraCellPicker.vue` 的文件头。
 *
 * 再点一次同一个入口 = 收起：`CameraCellPicker` 会让开带
 * `data-camera-picker-trigger` 的元素，所以这里能用一个开关表达「开/关」。
 */
function togglePicker(cell: CameraCellView, event?: MouseEvent): void {
  if (pickerSlot.value === cell.index) {
    closePicker()
    return
  }
  // 选择器铺在格子里面（inline），不再需要量格子的视口矩形。
  pickerSlot.value = cell.index
  const target = event?.currentTarget
  pickerTrigger = target instanceof HTMLElement ? target : null
}

/**
 * 关掉浮层。
 *
 * `restoreFocus` 在「选中了一台相机」时为 `false`：那条路上触发它的按钮（空白格的 `+`）
 * 会被换掉，把焦点还给它没有意义 —— 选完之后焦点交给这一格新出现的设备名按钮。
 */
function closePicker(restoreFocus = true): void {
  const trigger = pickerTrigger
  pickerSlot.value = null
  pickerTrigger = null
  if (restoreFocus && trigger && document.contains(trigger)) trigger.focus()
}

/**
 * 选中一台相机（`view` 缺省 = 播放）：先收起浮层，再放进来。
 *
 * 被替换掉的旧内容**只有在本格失去它的最后一份**时才停会话（业主 2026-09-21 批）：
 * 旧 id 若还出现在**别的格**（任意视图），那一路内容仍然有人看，不动它；只有它
 * 不再出现在任何格上，才走 `stopCell()`（先收尾录像、再停主进程）。
 * 顺序刻意是**先停后放**：`stopCell` 会释放这一格的 `<video>`，放进来之后那一格
 * 重新起流，新旧两路不会在格子上叠着。
 */
async function pickDevice(deviceId: string, view?: CameraCellViewMode): Promise<void> {
  const slot = pickerSlot.value
  closePicker(false)
  if (slot === null) return
  const cell = cells.value.find((item) => item.index === slot)
  if (!cell) return
  const oldId = cell.deviceId
  if (
    oldId !== null &&
    oldId !== deviceId &&
    !wall.model.slots.some((item, index) => item === oldId && index !== cell.index)
  ) {
    await stopCell(cell)
  }
  wall.placeDevice(slot, deviceId, view)
  /*
   * 焦点跟着这一格走。
   *
   * 键盘用户按回车选完之后，那个候选项（连同整个浮层）就没了 —— 不还给这一格，
   * 焦点会掉到 `<body>` 上，下一次按 Tab 从窗口最前面重新开始。放好之后这一格里
   * 出现的设备名按钮就是同一个入口（它打开的是「更换相机」），焦点交给它。
   */
  await nextTick()
  cellEls.value[slot]?.querySelector<HTMLElement>('.camera-wall__name--action')?.focus()
}

/** 拖拽落点（HTML5 DnD，不引入任何依赖）。总是放**播放**那一格（同 pickDevice 的停会话规矩）。 */
async function onDrop(cell: CameraCellView, event: DragEvent): Promise<void> {
  event.preventDefault()
  const deviceId = event.dataTransfer?.getData('text/plain') ?? ''
  if (deviceId === '') return
  const device = devices.byId(deviceId)
  if (device?.kind !== 'acousticCamera') return
  const oldId = cell.deviceId
  if (
    oldId !== null &&
    oldId !== deviceId &&
    !wall.model.slots.some((item, index) => item === oldId && index !== cell.index)
  ) {
    await stopCell(cell)
  }
  wall.placeDevice(cell.index, deviceId)
}

function onDragOver(event: DragEvent): void {
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  event.preventDefault()
}

// ---------------------------------------------------------------------------
// 声音（全局独占 + 真实元素属性）
// ---------------------------------------------------------------------------

/** 这一格的音量（0–1）。没有记忆过就是满音量。 */
function volumeOf(slot: number): number {
  const value = volumes.value[slot]
  return typeof value === 'number' && Number.isFinite(value) ? value : 1
}

/** 滑块位置：0–100 的整数百分比。 */
function volumePercent(slot: number): number {
  return Math.round(volumeOf(slot) * 100)
}

/**
 * 把某一格的声音写进**真实的 `<video>` 元素**。
 *
 * 两个属性一起写，因为它们必须永远说同一件事：
 *   - `volume` 来自这一格自己的音量记忆；
 *   - `muted` 跟着**渲染出来的事实**（`cell.audio`），而不是只跟着 `wall.audioSlot`：
 *     `audio` 已经由模型保证「这一格真的有 `<video>`」（见 `lib/cameraWall.ts` 的
 *     `audibleAt()`），所以「徽标亮着」「音量图标是按下的」「元素没静音」三者同源。
 *
 * 直接写元素属性，而不是只靠 `:muted` 模板绑定：浏览器读的是属性本身（DOM 属性才是
 * 它真正看的东西），这个函数就是唯一写入点，元素挂载（ref 回调）与出声格变化（watch）
 * 都走它。
 */
function applyAudioOutput(slot: number, video: HTMLVideoElement | null): void {
  if (!video) return
  const cell = cells.value.find((item) => item.index === slot)
  video.volume = volumeOf(slot)
  video.muted = cell === undefined ? true : !cell.audio
}

/** 每个已经挂上去的 `<video>` 都重新对一次声音（出声格换了的时候用）。 */
function syncAudioOutput(): void {
  for (const [index, video] of Object.entries(videoEls.value)) {
    applyAudioOutput(Number(index), video)
  }
}

/** `<video>` 的 ref 回调：记下元素，并立刻把音量/静音写上去（在 autoplay 之前）。 */
function bindVideo(slot: number, element: HTMLVideoElement | null): void {
  videoEls.value[slot] = element
  applyAudioOutput(slot, element)
}

/**
 * 拖动某一格的音量滑块。
 *
 * 一条必须写下来的决定：**拖动一个当前没在出声的格子的滑块，会把出声格切到这一格。**
 * 拖滑块是一个意图很明确的动作（「我要听这一格」），而模型里出声格全局只有一个
 * （`setAudioSlot()`），所以「把它切过来」是唯一同时满足两件事的答案：独占仍然成立，
 * 界面也说得出「现在哪一格在出声」—— 切换在同一帧里同时改掉徽标、音量图标与真实元素。
 * 另一条路（只记音量、不切出声格）会让滑块在一个永远不会出声的格子上显得有效，那是在
 * 骗操作员。
 *
 * 音量本身是逐格记忆的：切走再切回来，音量还是他调过的那个。
 */
function onVolumeInput(cell: CameraCellView, event: Event): void {
  const input = event.target as HTMLInputElement
  const percent = Number(input.value)
  if (!Number.isFinite(percent)) return
  const volume = Math.min(1, Math.max(0, percent / 100))
  volumes.value = { ...volumes.value, [cell.index]: volume }
  // 没有画面的格子不可能出声（滑块此时是禁用的；这里再挡一次，因为状态可能在拖动的
  // 过程中改变）。
  if (!isCameraCellLive(cell.status)) return
  if (wall.audioSlot !== cell.index) wall.setAudio(cell.index)
  applyAudioOutput(cell.index, videoEls.value[cell.index] ?? null)
  // 相机格的声音在包络播放器里（RTSP 无音轨），音量同步给它。
  cameraAudioPlayer.setVolume(percent)
}

/** 音量图标按钮：把这一格切成出声格，或把已经在出声的这一格静音。 */
function toggleAudio(cell: CameraCellView): void {
  if (!isCameraCellLive(cell.status)) return
  wall.toggleAudio(cell.index)
}

// ---------------------------------------------------------------------------
// 相机格的声音：RTSP 没有音轨，声音走声学通道 /pcmData（2026-09-23）
// ---------------------------------------------------------------------------
//
// 实测（2026-09-23，相机实时流的 ffmpeg 协商日志）：相机的 RTSP 只有
// `Stream #0:0 Video: h264`，**没有音频轨**——所以相机格「出声」靠 `<video>`
// 元素永远是无声的，这不是音量问题，是那条流里根本没有声音。
// 相机真正在出声的数据是声学 WebSocket `/pcmData`（与实时监测页波形/播放同源）。
//
// 因此：出声格是一台声学相机时，为它开一条 pcmData 会话 + 一个包络播放器
// （与监测页同一个 `EnvelopePlayer`，含自动增益）；手填 RTSP 源与带音轨的源
// 仍走 `<video>` 元素自己的音量/静音（`applyAudioOutput` 那一条不变）。
// 出声格换走、关掉或离开页面时，订阅与播放器一起收尾。

let cameraAudioUnsubscribe: (() => void) | undefined
let cameraAudioDeviceId = ''
let cameraAudioStartedByUs = false
const cameraAudioPlayer = new EnvelopePlayer()

function stopCameraAudio(): void {
  cameraAudioUnsubscribe?.()
  cameraAudioUnsubscribe = undefined
  const deviceId = cameraAudioDeviceId
  cameraAudioDeviceId = ''
  void cameraAudioPlayer.suspend()
  // 只停**这面墙**开的会话：别的页面（实时监测）开的会话不归这里管。
  if (cameraAudioStartedByUs && deviceId !== '') {
    cameraAudioStartedByUs = false
    void callApi(() => window.api.fa371Stream.stop(deviceId))
  }
}

async function startCameraAudio(cell: CameraCellView, deviceId: string): Promise<void> {
  stopCameraAudio()
  cameraAudioDeviceId = deviceId
  cameraAudioPlayer.setVolume(Math.round(volumeOf(cell.index) * 100))
  try {
    await cameraAudioPlayer.resume()
  } catch {
    // 没有输出设备/自动播放策略拒绝：不出声，也不把这一格假装成"正在出声"。
    cameraAudioDeviceId = ''
    return
  }
  cameraAudioUnsubscribe = window.events?.onFa371Pcm?.((preview) => {
    if (preview.deviceId !== cameraAudioDeviceId) return
    cameraAudioPlayer.push(preview.waveform, preview.frameMs)
  })
  const result = await callApi(() => window.api.fa371Stream.start({ deviceId, kinds: ['pcmData'] }))
  if (result.success) {
    cameraAudioStartedByUs = true
  } else {
    stopCameraAudio()
  }
}

/**
 * 出声格变化时把「相机格的声音」对齐：出声格是声学相机就开声学音频，否则收尾。
 * 回到这一页（onMounted）也调一次——墙的模型留着出声格，但 pcmData 会话随页面离开
 * 已被收尾，不重接就会"徽标说在出声、耳朵听不到"。
 */
function syncCameraAudio(): void {
  const slot = wall.audioSlot
  const cell = slot === null ? undefined : cells.value.find((item) => item.index === slot)
  const deviceId = cell?.deviceId ?? ''
  const isCamera = deviceId !== '' && devices.byId(deviceId)?.kind === 'acousticCamera'
  if (cell && isCamera) {
    if (cameraAudioDeviceId === deviceId) return
    void startCameraAudio(cell, deviceId)
    return
  }
  stopCameraAudio()
}

watch(() => wall.audioSlot, () => {
  syncAudioOutput()
  syncCameraAudio()
})

// ---------------------------------------------------------------------------
// 相机 NVR 交互：右键菜单、手动录像、抓图、回放、下载（**逐格**）
// ---------------------------------------------------------------------------

/**
 * 为什么这里的每一样状态都是**按格**存的
 *
 * 一面墙上可能同时有几台相机。把「正在录像」「全屏哪一格」「上一次操作的结果」
 * 做成整页一份，就会得到一个操作员无法反驳的界面：右键 B 格录像，A 格的红色
 * 指示器亮起来；或者 B 格抓图成功，提示条画在 A 格下面。所以这一块全部按格号
 * 索引，动作也一律作用在**被右键的那一格**上。
 *（叠加信息已按业主 2026-09-21 批移除：非空格的叠加条永远显示，不再有开关。）
 *
 * 录像状态的权威始终是主进程：`cameraNvr.recordingState()` 是唯一的事实来源，
 * 本地这份只是它的投影（外加一个走动的计时器）。刷新页面后能自己恢复「正在录像」
 * 的指示器，靠的就是 `refreshRecordingStates()`。
 */
interface CellNvrState {
  /** 主进程是否正在为这一格的相机手动录像。 */
  recording: boolean
  /** 录像起始时刻（计时器的基准）。 */
  startedAt: number
  /** 已录时长（毫秒），由计时器更新。 */
  elapsed: number
  /** 这一格最近一次失败（主进程/设备的原文优先）。 */
  error: string
  /** 这一格最近一次成功的结果（录像已保存、抓图已保存、地址已复制…）。 */
  notice: string
}

/** 默认状态：没记录过的一格就是「没录像、没结果」。 */
const EMPTY_NVR: CellNvrState = {
  recording: false,
  startedAt: 0,
  elapsed: 0,
  error: '',
  notice: ''
}

const nvrStates = ref<Record<number, CellNvrState>>({})
/** 每一格正在跑的 NVR 动作（防重入）。与直播的 `busy` 分开：两者的生命周期不同。 */
const nvrBusy = ref<Record<number, boolean>>({})

function nvrOf(slot: number): CellNvrState {
  return nvrStates.value[slot] ?? EMPTY_NVR
}

function patchNvr(slot: number, patch: Partial<CellNvrState>): void {
  nvrStates.value = { ...nvrStates.value, [slot]: { ...nvrOf(slot), ...patch } }
}

function clearNvr(slot: number): void {
  if (!(slot in nvrStates.value)) return
  const next = { ...nvrStates.value }
  delete next[slot]
  nvrStates.value = next
}

function nvrIsBusy(slot: number): boolean {
  return nvrBusy.value[slot] === true
}

function setNvrBusy(slot: number, value: boolean): void {
  nvrBusy.value = { ...nvrBusy.value, [slot]: value }
}

/** 每一格的录像计时器。**卸载 / 停止 / 清空格子时都必须清掉**，否则就是一个静默泄漏。 */
const recordingTimers = new Map<number, ReturnType<typeof setInterval>>()

function stopRecordingTimer(slot: number): void {
  const timer = recordingTimers.get(slot)
  if (timer === undefined) return
  clearInterval(timer)
  recordingTimers.delete(slot)
}

function stopAllRecordingTimers(): void {
  for (const slot of [...recordingTimers.keys()]) stopRecordingTimer(slot)
}

function startRecordingTimer(slot: number, startedAt: number): void {
  stopRecordingTimer(slot)
  patchNvr(slot, { recording: true, startedAt, elapsed: Math.max(0, Date.now() - startedAt) })
  recordingTimers.set(
    slot,
    setInterval(() => {
      const state = nvrStates.value[slot]
      if (state === undefined) return
      patchNvr(slot, { elapsed: Math.max(0, Date.now() - state.startedAt) })
    }, 500)
  )
}

/** 这一格录制指示器上走动的时长。 */
function recordingClock(slot: number): string {
  return formatDuration(nvrOf(slot).elapsed)
}

/** 这一格要画的那一条结果（错误优先：失败必须看得见）。 */
function cellNvrMessage(cell: CameraCellView): string {
  const nvr = nvrOf(cell.index)
  return nvr.error !== '' ? nvr.error : nvr.notice
}

/** 路径尾部三段：绝对路径太长，画面格里放不下。 */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts.slice(-3).join('/')
}

/** 主进程的逐会话快照（菜单的可用性判据之一是它里面的打码地址）。 */
function liveStateOf(cell: CameraCellView): CameraLiveState | null {
  const deviceId = cell.deviceId
  if (deviceId === null) return null
  return wall.states[deviceId] ?? null
}

/**
 * 喂给纯函数 `buildCameraNvrMenu()` 的环境。
 *
 * **本组件不判断任何一条 `visible` / `enabled`**：菜单项存在与否、能不能点、
 * 为什么不能点，全部由那一个纯函数给出（`MonitorView` 的单路面板读的是同一份）。
 * 这里只负责如实回答「这一格此刻是什么情况」。
 *
 * `capabilities` 五项全开，因为画面格确实实现了全部五项动作：抓图/录像（子菜单）、
 * 全屏、复制地址、外部播放器，加上本机录像回放弹窗、检测记录下载弹窗、
 * 以及清空这一格。模型里后三项是**可选**的（缺省即不显示），界面没接上就不该声明。
 */
function cellNvrEnvironment(cell: CameraCellView): CameraNvrEnvironment {
  const nvr = nvrOf(cell.index)
  const isCamera = cell.kind === 'acousticCamera'
  return {
    deviceName: cell.deviceName,
    recording: nvr.recording,
    fullscreen: fullscreenSlot.value === cell.index,
    hasUsableSource: isCameraCellLive(cell.status),
    capabilities: {
      liveVideo: isCamera,
      alarmModel: isCamera,
      localPlayback: true,
      detectDownload: true,
      tileClose: true,
      // 四种视图（播放 / 时域 / 频域 / 时频）是**画面格**的东西，只有这一面墙声明它。
      cellViews: true
    },
    // 显示方式（第 12 批把四颗视图按钮从控制条移到了菜单里）：给的是**这一格此刻**的视图
    // 与它**支持**的视图，两者都由 `buildCameraCells()` 算好（`cell.view` / `cell.availableViews`）。
    cellView: cell.view,
    availableViews: cell.availableViews
  }
}

// --- 菜单状态 ---------------------------------------------------------------

const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
/** 被右键的那一格。`null` = 没有菜单。动作一律以它为准，而不是「当前所选设备」。 */
const menuSlot = ref<number | null>(null)

const menuCell = computed<CameraCellView | null>(() =>
  menuSlot.value === null
    ? null
    : (cells.value.find((cell) => cell.index === menuSlot.value) ?? null)
)

const menuItems = computed<CameraNvrMenuItem[]>(() => {
  const cell = menuCell.value
  // 没有相机就没有菜单项：模型会为一台不存在的相机画出一屏禁用项。
  if (!cell || cell.deviceId === null) return []
  // Alarm configuration moved to the Camera Control settings on Realtime Monitoring.
  // Keeping a second entry here would also reintroduce the second <video> viewer that can
  // replace the wall viewer in RtspStreamService.
  return buildCameraNvrMenu(liveStateOf(cell), cellNvrEnvironment(cell))
    .filter((item) => item.action !== 'alarm-config')
})

/** 菜单头部就是这一格的设备名（菜单是对**画面格**打开的）。 */
const menuTitle = computed(() => menuCell.value?.deviceName ?? '')

/**
 * 在某一格上按右键。
 *
 * 没有相机（`empty` / `device-removed`）的格子**不打开相机菜单**，而且连
 * `preventDefault()` 都不做：模型对一台不存在的相机只会输出「抓图/录像/复制地址」
 * 一屏灰项，那不是说明事实，是在编一个不存在的设备。空白格的全部界面内容就是
 * 右侧那个大 `+`（产品要求），它不需要菜单。
 */
async function onCellContextMenu(cell: CameraCellView, event: MouseEvent): Promise<void> {
  if (cell.deviceId === null || cell.kind !== 'acousticCamera') return
  event.preventDefault()
  // 先在**同一个刻度**里关掉再打开：光标换了位置时 `open` 必须真的经历一次
  // false -> true，否则菜单组件的定位 watch 不会触发，菜单会留在上一次的位置上。
  menuOpen.value = false
  menuSlot.value = cell.index
  menuX.value = event.clientX
  menuY.value = event.clientY
  await nextTick()
  // 菜单可能已经被别的东西关掉了（例如这一格在等待的那一拍里被清空）。
  if (menuSlot.value !== cell.index || menuCell.value === null) return
  menuOpen.value = true
}

function closeMenu(): void {
  menuOpen.value = false
  menuSlot.value = null
}

// --- 主进程的录像状态（唯一权威） -------------------------------------------

/**
 * 把主进程的录像状态读回来，写到对应的格子上。
 *
 * 两件事都必须做对：
 *   1. 主进程说「在录」而界面不知道 -> 补上指示器与计时器（刷新页面之后
 *      红色指示器必须自己回来，而不是显示成「没在录」）；
 *   2. 主进程说「没在录」而界面还在转 -> 停掉计时器（只在这一格没有正在跑的
 *      start/stop 操作时，否则会把刚点下的那一次覆盖掉）。
 */
async function refreshRecordingStates(): Promise<void> {
  const result = await callApi(() => window.api.cameraNvr.recordingState())
  if (!result.success) return
  const list = unwrap(result) ?? []
  const byDevice = new Map(list.map((state) => [state.deviceId, state]))
  for (const cell of cells.value) {
    if (cell.deviceId === null) continue
    const state = byDevice.get(cell.deviceId)
    if (state?.recording === true) {
      if (!nvrOf(cell.index).recording) startRecordingTimer(cell.index, state.startedAt ?? Date.now())
      continue
    }
    if (nvrOf(cell.index).recording && !nvrIsBusy(cell.index)) {
      stopRecordingTimer(cell.index)
      patchNvr(cell.index, { recording: false, startedAt: 0, elapsed: 0 })
    }
  }
}

/**
 * 停止这一格的手动录像并登记文件。幂等：没在录就什么都不做。
 *
 * 「停止」在业务上等于「把这段素材收进录像表」，所以成功时这里会把结果说出来
 * （时长 / 大小 / 文件），中途断流的诊断也照原样显示。
 */
async function stopCellRecording(cell: CameraCellView, deviceId: string): Promise<void> {
  if (!nvrOf(cell.index).recording) return
  stopRecordingTimer(cell.index)
  patchNvr(cell.index, { recording: false, startedAt: 0, elapsed: 0 })
  const result = await callApi(() => window.api.cameraNvr.stopRecording(deviceId))
  if (!result.success) {
    patchNvr(cell.index, { error: resultMessage(result) })
    return
  }
  const saved = unwrap(result)
  if (!saved) return
  patchNvr(cell.index, {
    notice: t('cameraNvrUi.recordSaved', {
      duration: formatDuration(saved.durationMs),
      size: formatBytes(saved.fileSize),
      path: saved.relativePath
    })
  })
  if (saved.warning) {
    patchNvr(cell.index, { error: t('cameraNvrUi.recordWarning', { reason: saved.warning }) })
  }
}

/**
 * 开始 / 停止这一格的手动录像。
 *
 * 开始需要管理员权限，这一条由**主进程**执行；界面不复制这个判断，只把主进程
 * 的拒绝原样显示在这一格上（静默失败在这里是被禁止的）。
 */
async function toggleCellRecording(cell: CameraCellView, deviceId: string): Promise<void> {
  if (nvrIsBusy(cell.index)) return
  setNvrBusy(cell.index, true)
  patchNvr(cell.index, { error: '', notice: '' })
  try {
    if (nvrOf(cell.index).recording) {
      await stopCellRecording(cell, deviceId)
      return
    }
    const result = await callApi(() => window.api.cameraNvr.startRecording(deviceId))
    if (!result.success) {
      patchNvr(cell.index, { error: resultMessage(result) })
      return
    }
    const started = unwrap(result)
    startRecordingTimer(cell.index, started?.startedAt ?? Date.now())
    // 文件路径只有主进程知道；它没给就不编一个。
    if (started?.relativePath) {
      patchNvr(cell.index, {
        notice: t('cameraNvrUi.recordingStarted', { path: started.relativePath })
      })
    }
  } finally {
    setNvrBusy(cell.index, false)
  }
}

/** 抓图：结果路径显示在这一格上（错了就把主进程的原话显示出来）。 */
async function takeCellSnapshot(cell: CameraCellView, deviceId: string): Promise<void> {
  if (nvrIsBusy(cell.index)) return
  setNvrBusy(cell.index, true)
  patchNvr(cell.index, { error: '', notice: '' })
  try {
    const result = await callApi(() => window.api.cameraNvr.snapshot(deviceId))
    if (!result.success) {
      patchNvr(cell.index, { error: resultMessage(result) })
      return
    }
    const captured = unwrap(result)
    if (!captured) return
    patchNvr(cell.index, {
      notice: t('cameraNvrUi.snapshotSaved', { path: shortPath(captured.absolutePath) })
    })
  } finally {
    setNvrBusy(cell.index, false)
  }
}

/**
 * 复制这一格的 RTSP 地址。
 *
 * 地址**含设备口令**，所以它只进剪贴板，永远不作为文本渲染（`maskedUrl` 才是可以
 * 显示的那一个）。拿得到含口令的地址与只拿得到打码地址，提示语必须不同 —— 否则
 * 操作员不知道剪贴板里到底是什么。
 */
async function copyCellRtsp(cell: CameraCellView, deviceId: string): Promise<void> {
  patchNvr(cell.index, { error: '', notice: '' })
  const sourceResult = await callApi(() => window.api.cameraLive.source(deviceId))
  const source = sourceResult.success ? unwrap(sourceResult) : undefined
  const text = source?.url ?? liveStateOf(cell)?.rtspUrl ?? ''
  if (text === '') {
    patchNvr(cell.index, { error: t('cameraNvrUi.reasonNoAddress') })
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    patchNvr(cell.index, {
      notice: source ? t('cameraNvrUi.copyDone') : t('cameraNvrUi.copyMaskedDone')
    })
  } catch {
    patchNvr(cell.index, { error: t('cameraNvrUi.copyFailed') })
  }
}

/** 交给外部播放器。地址同样含口令，同样不渲染成文本。 */
async function openCellExternal(cell: CameraCellView, deviceId: string): Promise<void> {
  patchNvr(cell.index, { error: '', notice: '' })
  const result = await callApi(() => window.api.cameraLive.source(deviceId))
  const source = result.success ? unwrap(result) : undefined
  if (!source) {
    patchNvr(cell.index, { error: t('cameraNvrUi.reasonNoSource') })
    return
  }
  const opened = await callApi(() => window.api.app.openExternal(source.url))
  if (!opened.success) {
    patchNvr(cell.index, { error: resultMessage(opened) })
    return
  }
  patchNvr(cell.index, { notice: t('cameraNvrUi.openExternalDone') })
}

// --- 本机录像回放 / 检测记录下载 / 告警配置 ---------------------------------

/** 回放弹窗的目标设备（空 = 关闭）。它按格打开，所以设备名与 id 一起记下来。 */
const playbackOpen = ref(false)
const playbackDeviceId = ref('')
const playbackDeviceName = ref('')
/** 从「下载检测记录」直接接过来的那一段（下载 -> 回放的真实闭环）。 */
const playbackPresetId = ref('')

const downloadOpen = ref(false)
const downloadDeviceId = ref('')
const downloadDeviceName = ref('')

function openPlaybackDialog(deviceId: string, deviceName: string, presetId = ''): void {
  playbackDeviceId.value = deviceId
  playbackDeviceName.value = deviceName
  playbackPresetId.value = presetId
  playbackOpen.value = true
}

function openDownloadDialog(deviceId: string, deviceName: string): void {
  downloadDeviceId.value = deviceId
  downloadDeviceName.value = deviceName
  downloadOpen.value = true
}

/**
 * 控制条上那两颗"打开发电机"的按钮（第 12 批新增的入口）。
 *
 * 它们与右键菜单里的同名项**调的是同一段代码** —— `openPlaybackDialog` 与
 * 告警对话框的状态本来就是按格打开的，所以这里只是给它们一个更近的入口，
 * 不存在第二份实现（菜单项与按钮不会漂移）。
 */
function openCellPlayback(cell: CameraCellView): void {
  if (!cellHasDevice(cell)) return
  openPlaybackDialog(cell.deviceId as string, cell.deviceName)
}

/**
 * 控制条上那颗「手动录像 / 停止录像」。
 *
 * 单独包一层是为了**把设备 id 的判空留在脚本里**：模板里的 `@click` 表达式是 JS，
 * 写不了 `as string` 这类 TS 断言（写进去会在编译模板时炸）。判据与按钮的 `v-if` 同一份。
 */
async function onCellRecord(cell: CameraCellView): Promise<void> {
  if (!cellHasDevice(cell)) return
  await toggleCellRecording(cell, cell.deviceId as string)
}

/**
 * 下载完成后回放刚拿到的那一段。
 *
 * 下载下来的检测录像会被登记进**同一张录像表**（`recordingType: 'manual'`），
 * 所以这里不是一句客套话：关掉下载弹窗、带着这个录像 id 打开回放弹窗，操作员
 * 立刻能看到刚下载的画面。
 */
function onDownloadedPlay(recordingId: string): void {
  const deviceId = downloadDeviceId.value
  const deviceName = downloadDeviceName.value
  downloadOpen.value = false
  if (deviceId === '' || recordingId === '') return
  openPlaybackDialog(deviceId, deviceName, recordingId)
}

// --- 清空这一格 -------------------------------------------------------------

/**
 * 清空这一格。
 *
 * 走的是墙既有的清空路径（`stopCell()` 先收尾录像、再释放 `<video>`、再停主进程
 * 会话，然后 `wall.clearCell()`），所以不会留下一个孤儿流，也不会留下一个没人
 * 看得见的 ffmpeg。
 */
async function closeTile(cell: CameraCellView): Promise<void> {
  await stopCell(cell)
  stopRecordingTimer(cell.index)
  clearNvr(cell.index)
  wall.clearCell(cell.index)
}

// --- 派发 -------------------------------------------------------------------

/**
 * 菜单派发。**可用性判断不在这里**（那是 `buildCameraNvrMenu()` 的事），这里只
 * 负责把被选中的动作作用到被右键的那一格上。
 *
 * 菜单自己会在派发之后关闭，所以目标格子必须在**第一个 await 之前**取出来。
 */
async function onCellMenuSelect(action: CameraNvrAction): Promise<void> {
  const cell = menuCell.value
  if (!cell || cell.deviceId === null) return
  const deviceId = cell.deviceId
  const deviceName = cell.deviceName
  switch (action) {
    case 'toggle-recording':
      await toggleCellRecording(cell, deviceId)
      return
    case 'snapshot':
      await takeCellSnapshot(cell, deviceId)
      return
    case 'toggle-fullscreen':
      await toggleFullscreen(cell)
      return
    case 'copy-rtsp':
      await copyCellRtsp(cell, deviceId)
      return
    case 'open-external':
      await openCellExternal(cell, deviceId)
      return
    /*
     * 显示方式（业主 2026-09-19 第 12 批把四颗视图按钮从控制条移到菜单里）。
     * 派发与灰显分开：这里只调 `chooseCellView()`，它自己会拒绝"这一格不支持的视图"
     * （菜单项因此在那种情况下是灰的，两层判据来自同一份 `cell.availableViews`），
     * 同 (id, 视图) 已在别格时由 store 拒绝并给出说明。
     */
    case 'view-play':
      chooseCellView(cell, 'play')
      return
    case 'view-timedomain':
      chooseCellView(cell, 'timedomain')
      return
    case 'view-spectrum':
      chooseCellView(cell, 'spectrum')
      return
    case 'view-spectrogram':
      chooseCellView(cell, 'spectrogram')
      return
    case 'playback':
      openPlaybackDialog(deviceId, deviceName)
      return
    case 'download-detect':
      openDownloadDialog(deviceId, deviceName)
      return
    case 'close-tile':
      await closeTile(cell)
      return
    default:
      return
  }
}

// ---------------------------------------------------------------------------
// 控制条上的图标与名字
// ---------------------------------------------------------------------------

/** 播放（三角形）与停止（方块）：同一条 `<path>` 的两种画法，不依赖任何图标库。 */
const PLAY_ICON_PATH = 'M5 3.2 L13 8 L5 12.8 Z'
const STOP_ICON_PATH = 'M4 4 H12 V12 H4 Z'

/** 图标跟着这一格的**真实状态**走，不另存一个布尔值。 */
function playbackIconPath(cell: CameraCellView): string {
  return isCameraCellLive(cell.status) ? STOP_ICON_PATH : PLAY_ICON_PATH
}

/**
 * 播放/暂停按钮此刻的无障碍名字。
 *
 * 它是这一格**真实状态**的翻译，而不是一个固定的按钮标题：
 *   - 正在拉流 -> 「暂停」（业主 2026-09-19 第 12 批给这一颗的词）；
 *   - 流失败   -> 「重试」（这时候按钮真的会再起一路，说到做到）；
 *   - 其余能开始的状态 -> 「播放」；
 *   - 做不到的状态（离线 / 已删除 / 已在另一格）-> 直接用那一格的短状态词当名字，
 *     于是禁用**自带原因**，操作员不用去猜为什么按钮是灰的。
 *
 * **"暂停"在这里等于"停掉这一路直播"**（RTSP 直播没有真正的暂停：流不会等你）。
 * 这一点写在 `docs/Ivms4200-UX-REFERENCE.md` §15.74：词是业主给的，动作是原本那个
 * （`toggleCell()` -> `stopCell()`），界面不假装画面停住了而流还在跑。
 */
function playbackLabel(cell: CameraCellView): string {
  if (isCameraCellLive(cell.status)) return t('cameraWallUi.pause')
  if (!canStartCell(cell)) return cellStatusLabel(cell)
  if (cell.status === 'error') return t('cameraWallUi.retry')
  return t('cameraWallUi.play')
}

/** 全屏按钮的名字：已经在全屏就是「退出全屏」，说得出按下去会发生什么。 */
function fullscreenLabel(cell: CameraCellView): string {
  return fullscreenSlot.value === cell.index
    ? t('cameraWallUi.exitFullscreen')
    : t('cameraWallUi.fullscreen')
}

// ---------------------------------------------------------------------------
// 音量：点一下弹出来的**水平细滑条卡片**（业主 2026-09-21 批，挂在图标正上方）
// ---------------------------------------------------------------------------

/**
 * 哪一格的音量浮层开着（`null` = 都关着）。
 *
 * 全墙同时只开一个：两条浮层一起开着，操作员分不清自己在调哪一格。
 */
const volumeOpenSlot = ref<number | null>(null)

/** 点外面关掉音量浮层（`mousedown` 捕获阶段，与相机选择器、右键菜单同一条做法）。 */
function onVolumeDocumentMouseDown(event: MouseEvent): void {
  const target = event.target
  // 触发它的那颗按钮不算「外面」：算的话"再点一次收起"会变成"先关再开"。
  if (target instanceof Element && target.closest('[data-cell-volume-trigger]')) return
  if (target instanceof Element && target.closest('[data-cell-volume-pop]')) return
  volumeOpenSlot.value = null
}

watch(volumeOpenSlot, (slot) => {
  if (slot === null) {
    document.removeEventListener('mousedown', onVolumeDocumentMouseDown, true)
    return
  }
  document.addEventListener('mousedown', onVolumeDocumentMouseDown, true)
})

/**
 * 点「音量」按钮。
 *
 * 两件事一起做，而且顺序重要：
 *   1. 把这一格设为**唯一出声的那一格**（`toggleAudio()` 是开关，所以在开之前先判一下 ——
 *      开着的时候再点它应当是"收起浮层"，而不是把声音关掉，那正是业主不要的那种惊扰）；
 *   2. 开/收浮层。
 * 「关掉声音」这件事仍然做得到，但它在浮层里那一个按钮上（`cell-volume-mute`），
 * 不在"点音量按钮"这个动作上 —— 一个按钮只做一件事。
 */
function openVolumePopover(cell: CameraCellView): void {
  if (volumeOpenSlot.value === cell.index) {
    volumeOpenSlot.value = null
    return
  }
  volumeOpenSlot.value = cell.index
  if (!cell.audio) toggleAudio(cell)
}

/** 音量按钮的名字：没有画面的格子不可能出声，此时名字直接说出这个事实。 */
function volumeLabel(cell: CameraCellView): string {
  if (!isCameraCellLive(cell.status)) return t('cameraWallUi.volumeNoPicture')
  return t('cameraWallUi.volume')
}

/** 音量滑杆的名字（业主说的"音量大小"），禁用时说出原因。 */
function volumeSliderLabel(cell: CameraCellView): string {
  return isCameraCellLive(cell.status)
    ? t('cameraWallUi.volumeLevel')
    : t('cameraWallUi.volumeNoPicture')
}

/** 浮层里那个声音开关的名字（原来挂在音量图标上的那个开关语义搬到了这里）。 */
function volumeMuteLabel(cell: CameraCellView): string {
  if (!isCameraCellLive(cell.status)) return t('cameraWallUi.volumeNoPicture')
  return cell.audio ? t('cameraWallUi.audioOff') : t('cameraWallUi.audioOn')
}

/** 手填的第三方 RTSP 源只有画面：控制条上那三颗需要**设备**的控件因此不渲染。 */
function cellHasDevice(cell: CameraCellView): boolean {
  return cell.deviceId !== null && cell.kind === 'acousticCamera'
}

/**
 * 「手动录像」那一颗的名字与可用性。
 *
 * 判据直接用共享层的 `cameraCaptureReadiness()` —— 菜单里那一项读的是同一个函数，
 * 两处各判一次迟早会出现"菜单能点、按钮灰着"。禁用时名字就是原因（本文件的既有规矩：
 * 做不到的控件，名字直接说出为什么）。
 */
function recordLabel(cell: CameraCellView): string {
  const nvr = nvrOf(cell.index)
  if (nvr.recording) return t('cameraNvrUi.menuStopRecording')
  const readiness = cameraCaptureReadiness(liveStateOf(cell))
  if (!readiness.ready) return readiness.reasonText || t(readiness.reasonKey)
  return t('cameraNvrUi.menuStartRecording')
}

function canRecord(cell: CameraCellView): boolean {
  const nvr = nvrOf(cell.index)
  // 录像中永远可以停（录制过程中状态变成 error 也必须能收尾，与菜单同一判据）。
  return nvr.recording || cameraCaptureReadiness(liveStateOf(cell)).ready
}

// ---------------------------------------------------------------------------
// 全屏
// ---------------------------------------------------------------------------

/**
 * 全屏 = 渲染层的固定层，不是原生 Fullscreen API（2026-09-23「总览界面全屏无效」修复）。
 *
 * 与实时监测页同一个决定（见 `MonitorView.toggleFullscreen` 的注释）：Electron 里
 * 原生 `requestFullscreen()` 会被窗口焦点/权限策略挡住，实测就是"点了没反应"。
 * 固定层是确定的：同一个 `<video>` 元素、同一条 RTSP 会话原地放大到整个窗口，
 * 进出全屏不会丢画面。Esc 退出（监听器在 onMounted 里）。
 */
function toggleFullscreen(cell: CameraCellView): void {
  if (!cells.value.some((item) => item.index === cell.index)) return
  fullscreenSlot.value = fullscreenSlot.value === cell.index ? null : cell.index
}

function onFullscreenKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') fullscreenSlot.value = null
}

// ---------------------------------------------------------------------------
// 档位
// ---------------------------------------------------------------------------

/**
 * 换档位。
 *
 * 变小时被挤掉的相机必须真的停掉：`changeLayout()` 交回被清空的相机 id，
 * 这里逐个 stop。否则「从 16 分屏换到 1 分屏」会在主进程里留下 15 个 ffmpeg。
 *
 * 被挤掉的格子如果正在手动录像，也**先收尾**再停会话：那一路的 RTSP 源马上就会
 * 消失，而「这一格不在墙上了」不是「这段录像不要了」。
 */
async function changeLayout(next: CameraWallLayout): Promise<void> {
  if (next === layout.value) return
  // 先按**现在的**模型取一份录像中的格子：`changeLayout()` 之后被挤掉的相机
  // 已经不在 `cells` 里了，那时再找就找不到，录像也就没人收尾了。
  const recordingCells = cells.value.filter(
    (cell) => cell.deviceId !== null && nvrOf(cell.index).recording
  )
  const { evictedDeviceIds } = wall.changeLayout(next)
  for (const deviceId of evictedDeviceIds) {
    const cell = recordingCells.find((item) => item.deviceId === deviceId)
    if (cell) {
      await stopCellRecording(cell, deviceId)
      // 这一格已经不在墙上了：它的状态（含刚刚写下的收尾结果）不会再被渲染，
      // 留着只是一份没有读者的泄漏。
      stopRecordingTimer(cell.index)
      clearNvr(cell.index)
    }
    await callApi(() => window.api.cameraLive.stop(deviceId))
  }
  await refreshAllStates()
  await refreshRecordingStates()
}

// ---------------------------------------------------------------------------
// 轮询轮换（业主 2026-09-21 批「超出窗口数自动轮询」）
// ---------------------------------------------------------------------------

/**
 * 轮换节奏：每 10 秒轮一格。队首内容进游标指着的那一格，被轮走的内容排到队尾。
 * 固定间隔而不是"起播成功再排下一次"：轮换是**编排**，各格起播快慢不该影响节奏。
 */
const WALL_ROTATION_INTERVAL_MS = 10_000

/** 操作员暂停/继续轮换的开关（工具条那个按钮）。暂停只冻结轮换，队列保留。 */
const rotationPaused = ref(false)
let rotationTimer: number | undefined

/**
 * 轮一格：停被轮走的会话、起新进来的会话。
 *
 * 复用全功能的 `stopCell()` / `startCell()`（它们会处理录像收尾与 busy 位）：
 *   - **旧 cell** 必须用轮换**之前**的对象：里面带着旧视图，才知道这一路有没有
 *     RTSP 会话要收；
 *   - **新 cell** 用 `cells` 重算后的对象（`index === slot` 的那一格），`play` 才起流；
 *   - 被轮走的 id 若在新模型里**还有**一个 `play` 格（同一台相机可能画面 + 图各一格），
 *     那一路会话仍然有人看，不停。
 */
function rotateCellsOnce(oldCells: readonly CameraCellView[]): void {
  const result = wall.rotateOnce()
  if (!result.changed || result.slot === null) return
  const oldCell = oldCells[result.slot]
  if (
    oldCell &&
    oldCell.view === 'play' &&
    oldCell.deviceId !== null &&
    findWallItem(wall.model, oldCell.deviceId, 'play') < 0
  ) {
    void stopCell(oldCell)
  }
  const newCell = cells.value.find((item) => item.index === result.slot)
  if (newCell && newCell.view === 'play' && newCell.deviceId !== null) {
    void startCell(newCell)
  }
}

/** 每个轮换 tick：暂停或队空都什么都不做（队空不白跑一格的算术）。 */
function onRotationTick(): void {
  if (rotationPaused.value) return
  if (wall.queue.length === 0) return
  rotateCellsOnce(cells.value)
}

// ---------------------------------------------------------------------------
// 生命周期与设备变化
// ---------------------------------------------------------------------------

/** 一次性提示：用户看过就该消失，否则它会一直占着版面说一件已经过去的事。 */
function dismissNotice(): void {
  wall.setNotice(null)
}

/**
 * 设备列表变了（删除、离线、刷新、健康监测推送）。
 *
 * `syncDevices()` 会清空被删设备占的格并交出需要停止的会话；本组件负责真的停。
 * 这是产品要求里最硬的一条：**不能留下一个指向已删设备的死 `<video>`**。
 */
async function syncDevices(): Promise<void> {
  wall.bindDevices(devices.devices)
  // 先按**现在的**模型取一份录像中的格子：`syncDevices()` 会把被删设备的格子清掉，
  // 那之后 `cells` 里已经找不到它，而「设备没了」不等于「这段录像不要了」——
  // 正在写盘的 ffmpeg 必须收尾（登记进录像表），否则就是一个没人看得见的录制进程。
  const recordingCells = cells.value.filter(
    (cell) => cell.deviceId !== null && nvrOf(cell.index).recording
  )
  const { toStop } = wall.syncDevices(devices.devices)
  for (const deviceId of toStop) {
    const cell = recordingCells.find((item) => item.deviceId === deviceId)
    if (cell) await stopCellRecording(cell, deviceId)
    await callApi(() => window.api.cameraLive.stop(deviceId))
  }
  if (toStop.length > 0) await refreshLimits()
}

watch(() => devices.devices, syncDevices, { deep: false })

/**
 * 自动起播的目标相机。
 *
 * 优先设备树当前选中的那一台，其次是第一台**在线**相机，最后才退回第一台：
 * 判定函数对离线设备会给出 `offline` 这个 skip，所以先挑一台在线的才有机会真的
 * 出画面。这里**不判断**「能不能播」——RTSP 是否可用、是否手动停止过、是否已经
 * 尝试过，全部是 `decideCameraAutoPlay()` 的职责，本组件不重写任何一条。
 */
const autoPlayTarget = computed<Device | undefined>(() => {
  const list = cameraDevices.value
  if (list.length === 0) return undefined
  return (
    list.find((device) => device.id === props.activeDeviceId) ??
    list.find((device) => device.status === 'ONLINE') ??
    list[0]
  )
})

/** 起播之后**一次性**补读会话状态的句柄（随组件卸载一起清掉）。 */
let settleTimer: number | undefined

/**
 * 起播后补读一次会话状态。
 *
 * 主进程的 `start` 返回的是 `starting`（ffmpeg 已经起来、回环地址已经存在），而
 * 第一帧到达、状态变成 `playing` 是**随后**发生的，界面不会自己知道。补读一次就
 * 把格子上的「正在启动…」换成「播放中」，而不是让它一直挂着一个已经过期的状态词。
 *
 * 只补读一次，刻意不做轮询：真正的状态变化（流中断、设备离线）由 `@error` /
 * `@ended` 与设备状态推送驱动，不靠界面每秒问一遍。
 */
function scheduleSettleRefresh(): void {
  if (settleTimer !== undefined) window.clearTimeout(settleTimer)
  settleTimer = window.setTimeout(() => {
    settleTimer = undefined
    void refreshAllStates()
  }, 2000)
}

/**
 * 做一次自动起播的判定（只有总览页会走到这里）。
 *
 * 三步的顺序是刻意的，缺一步就会同时成立「判定说 start」与「界面上没有画面」：
 *   1. **目标相机先上墙，再问判定。** 顺序不能反：墙的格子分配刻意**不持久化**
 *      （见 `stores/liveWall` 的文件头），所以一台还没上墙的相机没有槽位，也就没有
 *      `<video>`；先 start 出来的那一路会在主进程里跑着，而界面上没有任何地方能画它；
 *   2. 判定与起播全部交给 `cameraLive.autoPlayIfWorking()` —— 判定只有
 *      `decideCameraAutoPlay()` 一份，本组件不新增自动起播路径；
 *   3. `start` / `adopt` 之后重读一次会话状态：本墙的状态是 IPC 快照，不会自己出现。
 *
 * `skip` 时**什么都不做**，也不渲染任何额外提示：格子上本来就有的短状态词
 * （未开始 / RTSP 未启用…）就是答案，多一句「为什么没有自动播放」只会变成第二份
 * 可能与状态行不一致的说法。
 */
async function autoPlayOnce(): Promise<void> {
  if (props.autoPlay !== true) return
  // 设置项是判定的一部分：读它之前不能下任何结论（与单路面板同一条规矩）。
  if (!settings.loaded) await settings.load()
  const target = autoPlayTarget.value
  if (!target) return
  // 自动起播放的是**画面**：只有 (id, 播放) 不在墙上才需要占位；同 id 的图表格不占会话。
  if (findWallItem(wall.model, target.id, 'play') < 0) {
    wall.placeDevice(wall.slotForDevice(target.id), target.id)
  }
  const decision = await cameraLive.autoPlayIfWorking({
    autoPlayEnabled: settings.settings?.autoPlayCameraLive !== false,
    cameraRegistered: cameraDevices.value.length > 0,
    deviceId: target.id,
    deviceStatus: target.status
  })
  if (decision.action === 'start' || decision.action === 'adopt') {
    await refreshAllStates()
    scheduleSettleRefresh()
  }
}

/**
 * 判定真正依赖的**输入签名**。
 *
 * 自动起播的输入散在三个 store 里，而且各自异步到达：设备列表可能比组件晚、设备的
 * 在线状态由健康监测随时翻转、`activeDeviceId` 由设备树驱动、设置要等一次 IPC。
 * 只在挂载时判定一次的话，恰好那一刻列表或状态还没落地，就会出现「相机其实在工作，
 * 但永远没有画面」—— 这正是产品要求里那条「自动出画面」失灵的样子。
 *
 * 所以把判定的输入压成一个字符串，**在它变化时**重新问一次判定函数。为什么是 computed
 * 而不是几个 watch 源，也不放一个定时器：computed 只在真的变了的时候通知，事件驱动、
 * 没有轮询；而判定函数本身是幂等的（真的 start 过会记下 `already-attempted`、手动停止
 * 一票否决、会话已在只会 `adopt`），所以多问几次是安全的。
 */
const autoPlaySignal = computed(() =>
  [
    settings.loaded ? 'settings' : '',
    props.activeDeviceId ?? '',
    autoPlayTarget.value?.id ?? '',
    autoPlayTarget.value?.status ?? '',
    cameraDevices.value.map((device) => `${device.id}:${device.status}`).join(','),
    cameraLive.sessionOf(autoPlayTarget.value?.id ?? '')?.status ?? ''
  ].join('|')
)

/**
 * 重新评估自动起播（可重入，但**不会**并发跑两次判定）。
 *
 * `autoPlayOnce()` 里有 `await`，而两次评估的输入可能不同（一次是设备列表刚到、
 * 一次是状态随后翻转）。这里用一个「正在跑就记一笔，跑完再补一次」的串行器，而不是
 * 简单的丢弃标志：丢弃会让最后一次变化的结论永远不落地；补一次在最坏情况下也只多跑
 * 一轮，而且一定终止 —— `autoPlayOnce()` 只会写墙的状态与相机会话，而重新触发的条件
 * 是上面那个签名变化，签名只含设备列表、设置、目标相机与会话状态。
 */
let autoPlayRun: Promise<void> | null = null
let autoPlayAgain = false

/**
 * 恢复上一页保留在模型里的每一格直播。
 *
 * 离开页面时 `resetSessions()` 只停了会话，格子分配还在；如果这里不主动恢复，
 * 操作员回到总览会看到一墙「未开始」，仍然像配置丢了。只处理 `autoPlay` 页面
 * （总览），且跳过离线相机与已经在播/正在启动的格；并发上限仍由 `startCell()` 判。
 */
async function resumeAssignedCells(): Promise<void> {
  if (props.autoPlay !== true) return
  for (const cell of cells.value) {
    if (!cell.deviceId) continue
    const state = cameraLive.sessionOf(cell.deviceId)
    if (state?.status === 'playing' || state?.status === 'starting') continue
    const device = devices.byId(cell.deviceId)
    if (device && device.status !== 'ONLINE') continue
    await startCell(cell)
  }
}

async function requestAutoPlay(): Promise<void> {
  if (props.autoPlay !== true) return
  if (autoPlayRun !== null) {
    autoPlayAgain = true
    return autoPlayRun
  }
  autoPlayRun = (async () => {
    try {
      do {
        autoPlayAgain = false
        await autoPlayOnce()
      } while (autoPlayAgain)
    } finally {
      autoPlayRun = null
    }
  })()
  return autoPlayRun
}

watch(autoPlaySignal, () => {
  void requestAutoPlay()
})

/** 主线：页面挂载时恢复墙上每一格的直播状态。 */
onMounted(async () => {
  document.addEventListener('keydown', onFullscreenKeydown)
  wall.bindDevices(devices.devices)
  if (devices.devices.length === 0) await devices.load()
  await syncDevices()
  // 已经在墙上的相机：把主进程里**可能还在跑**的会话状态读回来（切走再切回来
  // 时上一页**没有**停掉它们，因为离开的是页面、不是这些会话的所有者）。
  await refreshAllStates()
  // 出声格是声学相机时声音来自 /pcmData 会话（随页面离开已收尾），回来要重接一次。
  syncCameraAudio()
  // 录像状态的权威同样在主进程：不读一次，刷新页面后「正在录像」的红色指示器
  // 就会消失，而 ffmpeg 还在写盘 —— 那是界面在说假话。
  await refreshRecordingStates()
  /*
   * **每次打开总览界面都重新允许一次自动起播**（业主 2026-09-18 第 10 批第 1 条）。
   *
   * `already-attempted` 那一位原来的清空时机是"一次应用启动"，于是这条要求落不了地：
   * 第一次进总览起播过之后，再进总览就永远是"本次已经试过了"，画面停着不动。
   * `resetAutoPlayAttempts()` **只清"试过了吗"**，「操作员按过停止」那一位保留 ——
   * 他明确不要的东西不该因为换了一次页面就自己回来（见那个函数的注释）。
   * 已知不可用的相机会被 `rtspAvailability` 记住，所以这不会变成反复去撞关着的 RTSP。
   */
  resetAutoPlayAttempts()
  // 最后才是本次进页面的那一次自动起播：它要用到上面读到的设备列表与设置。
  await requestAutoPlay()
  // 上一页留下的格子分配仍然在；把每一格真正恢复起来（只受并发/离线守卫约束）。
  await resumeAssignedCells()
  // 轮询轮换（业主 2026-09-21 批）：有队才需要它，没队时 tick 自己早退，成本可忽略。
  rotationTimer = window.setInterval(onRotationTick, WALL_ROTATION_INTERVAL_MS)
})

/**
 * 离开页面之前先放掉每一格手里的回环请求。
 *
 * 必须在 `onUnmounted` 里做**不够**：子元素的 `ref` 回调在卸载过程中会先被置空，
 * 而 `onBeforeUnmount` 仍能拿到元素。每一格那个 `<video>` 手上是一条回环 HTTP
 * 请求，Vue 只是把它从 DOM 上摘下来，请求是元素释放的 —— 所以先暂停、摘掉 `src`、
 * `load()`，再让它随组件消失（与 `stopCell()` 里同一个顺序）。
 */
onBeforeUnmount(() => {
  for (const [index, video] of Object.entries(videoEls.value)) {
    if (!video) continue
    releaseVideo(Number(index))
  }
  // 音量浮层那个"点外面关掉"的监听器也要摘掉（它在 `watch(volumeOpenSlot)` 里挂上）。
  document.removeEventListener('mousedown', onVolumeDocumentMouseDown, true)
})

/**
 * 离开页面：停掉**所有**会话并清空状态。
 *
 * 档位是用户的偏好，留下；格子里的会话是资源占用，必须释放。
 * 正在录像的那几路**先正式收尾**（走完整的校验并登记进录像表）：那条 ffmpeg 是
 * 主进程的，导航不会释放它，不收尾就会留下一个没人看得见的录制进程。
 */
onUnmounted(() => {
  document.removeEventListener('keydown', onFullscreenKeydown)
  // 相机格的声学音频（订阅 + 播放器 + 这面墙开的 pcmData 会话）随页面一起收尾。
  stopCameraAudio()
  void cameraAudioPlayer.close()
  // 菜单是 Teleport 到 body 的浮层，组件卸载不会带走它。
  menuOpen.value = false
  menuSlot.value = null
  if (settleTimer !== undefined) {
    window.clearTimeout(settleTimer)
    settleTimer = undefined
  }
  // 轮询轮换的定时器一起摘掉：离开页面还每 10 秒转一格，就是没人看的会话在空转。
  if (rotationTimer !== undefined) {
    window.clearInterval(rotationTimer)
    rotationTimer = undefined
  }
  stopAllRecordingTimers()
  const recordingDeviceIds = cells.value
    .filter((cell) => cell.deviceId !== null && nvrOf(cell.index).recording)
    .map((cell) => cell.deviceId as string)
  /**
   * 图表格的声学预览订阅也要停掉（业主 2026-09-18 第 10 批第 2 条）。
   *
   * 与画面那几路同一个理由，而且更硬：`pcmData` / `fftData` 各占相机一条 WebSocket，
   * 而相机侧并发连接数只有个位数。离开画面墙还占着两条，等于替下一位使用者吃掉了预算。
   */
  charts.dispose()
  // 只停会话，保留格子分配：业主 2026-11-12「离开再进入，之前的配置不应该变」。
  const assigned = wall.resetSessions()
  for (const deviceId of assigned) {
    if (recordingDeviceIds.includes(deviceId)) {
      void window.api.cameraNvr.stopRecording(deviceId)
    }
    void window.api.cameraLive.stop(deviceId)
  }
})

/**
 * 某一格的相机换了（放进来 / 移走 / 清空 / 换档位）。
 *
 * 这一格上的 NVR 状态（录像计时器、上一次操作的结果）属于**原来
 * 那台相机**，不能跟着格子留给下一台：换一台相机之后还亮着「正在录像」，是指着
 * 一台没在录的设备说它在录。所以设备一变就清掉，并向主进程重读一次录像状态。
 */
watch(
  () => [...wall.model.slots],
  (next, previous) => {
    const before = previous ?? []
    for (let index = 0; index < next.length; index += 1) {
      if ((next[index] ?? '') === (before[index] ?? '')) continue
      stopRecordingTimer(index)
      clearNvr(index)
    }
    const changed =
      next.length !== before.length || next.some((slot, index) => slot !== before[index])
    if (changed) {
      void refreshRecordingStates()
      /*
       * 格子里的来源真的变了（放进 / 移走 / 清空）：音量浮层跟着收起 —— 它说的是上一格的事。
       *
       * **判据必须是"内容变了"而不是"watch 触发了"**：这个 getter 每次求值都返回一个新数组，
       * 所以模型上一有风吹草动（例如 `toggleAudio()` 改的是 `audioSlot`）它就会触发；
       * 按触发关浮层的话，"点音量 → 顺手把这一格设为出声格"会把刚打开的浮层当场关掉
       * （探针第一版就是这么抓到它的：`volumePopOpen: false`）。
       */
      volumeOpenSlot.value = null
    }
  }
)

/** 设备树选中的设备 → 高亮它的那一格（双击/点选之后「当前格」要跟着走）。 */
watch(
  () => props.activeDeviceId,
  (deviceId) => {
    if (!deviceId) return
    const slot = wall.model.slots.indexOf(deviceId)
    if (slot >= 0) {
      wall.setActive(slot)
      // 页面在切换设备时会停掉当前设备那一格所在的那台相机的直播（它由单路面板
      // 接管），所以这里必须把状态重新读回来，否则那一格会停留在旧的 `playing`。
      void refreshState(deviceId)
    }
    // 注意：这里**不**起流。`activeDeviceId` 变了只意味着「高亮那一格」加「重新评估
    // 一次自动起播」，而重新评估走的是 `autoPlaySignal` → `requestAutoPlay()`
    // → `autoPlayIfWorking()` 那一条路，起流只可能由那一次判定（或操作员按按钮）发起。
  }
)

/**
 * 占位区里那一行**主进程/设备的原文诊断**。
 *
 * 只有设备亲口说的话才显示（ffmpeg 的 stderr 尾行、`rtsp_enabled=0`、上限说明）：
 * 那是实际发生的那件事，不是解释。短状态词已经由叠加条上的徽标说完，同一个事实不在
 * 同一格里说第二遍；「未开始该怎么办」这类句子不再有词条，画面格里也一个字都不写。
 */
function cellMessage(cell: CameraCellView): string {
  return cell.messageText ?? ''
}

/** `<video>` 手上真的有数据了：此刻主进程一定已经写出第一帧，状态就是 `playing`。 */
function onCellVideoReady(cell: CameraCellView): void {
  if (cell.deviceId === null) return
  void refreshState(cell.deviceId)
}

/** 这一格的短状态词。空白格没有词条（整格只有一个 `+`），所以会是空串。 */
function cellStatusLabel(cell: CameraCellView): string {
  return cell.messageKey === undefined ? '' : t(cell.messageKey)
}

/** 状态徽标的色调（复用 `main.css` 里已存在的语义类）。 */
function cellBadgeClass(cell: CameraCellView): string {
  if (cell.status === 'playing') return 'badge badge--success'
  if (cell.status === 'starting') return 'badge badge--accent'
  if (cell.status === 'limit-exceeded' || cell.status === 'device-offline') {
    return 'badge badge--warning'
  }
  if (
    cell.status === 'error' ||
    cell.status === 'ffmpeg-missing' ||
    cell.status === 'device-removed' ||
    cell.status === 'already-shown'
  ) {
    return 'badge badge--danger'
  }
  return 'badge'
}
</script>

<template>
  <section class="camera-wall card">
    <!--
      2026-09-23 业主要求：墙的标题（「实时视频墙」）与「同时直播」摘要行**删除**，
      分屏档位（1/4/9/16）挪到墙底部的半隐藏停靠条（鼠标移到下方才出现）。
      这一行只留下"没有相机"的提示与轮询指示器；都没有时整行不占高度。
    -->
    <div v-if="!cameraDevices.length || wall.queue.length > 0" class="section-header">
      <span v-if="!cameraDevices.length" class="muted">
        {{ t('cameraWallUi.noCamera') }}
      </span>

      <div class="spacer"></div>
      <!--
        轮询指示器（业主 2026-09-21 批「超出窗口数自动轮询」）：只在有队在等位时出现。
        `shown` = 正在显示的非空格数，`total` = shown + 队列长度；旁边那颗按钮
        暂停/继续轮换 —— 暂停冻结的是轮换动作，队列与已经显示的内容都不动。
      -->
      <template v-if="wall.queue.length > 0">
        <span class="camera-wall__rotation" role="status">
          {{
            t('cameraWallUi.rotationIndicator', {
              shown: wall.summary.assigned,
              total: wall.summary.assigned + wall.queue.length
            })
          }}
        </span>
        <button
          type="button"
          class="camera-wall__rotation-btn"
          data-action="rotation-toggle"
          :aria-pressed="rotationPaused"
          :aria-label="rotationToggleLabel"
          :title="rotationToggleLabel"
          @click="rotationPaused = !rotationPaused"
        >
          <svg class="camera-wall__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <!-- 暂停 = 两条竖杠；继续 = 三角形（正在暂停就显示"继续"那一支）。 -->
            <template v-if="!rotationPaused">
              <path d="M5.4 4 H7 V12 H5.4 Z" fill="currentColor" />
              <path d="M9 4 H10.6 V12 H9 Z" fill="currentColor" />
            </template>
            <path v-else d="M5.4 3.6 L12.4 8 L5.4 12.4 Z" fill="currentColor" />
          </svg>
        </button>
      </template>
    </div>

    <!--
      手填 RTSP 地址的**新建入口不在这里**（业主 2026-09-19 第 11 批第 2 条：曾挪到实时监测页；
      2026-09-21 第二批第 23 条又把该入口从实时监测页撤掉了 —— 管理界面随之没有挂载点，
      见批次报告里的警告）。

      这一面墙仍然**用得上**那些源：点某一格时，选择器里会列出
      「名字（手填 RTSP）」（见 `pickerItems`）。两件事因此各归各的页：
      新建/改名/改地址/删除原在实时监测页（`ManualRtspSources.vue`，现已无挂载），
      把某一条放进第几格在这一页。
    -->

    <p v-if="noticeText" class="alert alert--warning camera-wall__notice" role="status">
      {{ noticeText }}
      <button type="button" class="btn btn--sm" @click="dismissNotice">
        {{ t('common.close') }}
      </button>
    </p>

    <!--
      画面格。`--active` 是设备树当前的设备，`--audio` 是**唯一**出声的那一格：
      两个高亮同时可见，而声音的切换必须一眼可辨（徽标 + 音量图标 + 真实元素同时变）。
    -->
    <div class="camera-wall__grid" :style="columnStyle">
      <div
        v-for="cell in cells"
        :key="cell.key"
        :ref="(el) => (cellEls[cell.index] = el as HTMLElement | null)"
        class="camera-wall__cell"
        :class="{
          'camera-wall__cell--placeholder': !isCameraCellLive(cell.status),
          'camera-wall__cell--empty': cell.status === 'empty',
          'camera-wall__cell--active': cell.index === wall.activeSlot,
          'camera-wall__cell--audio': cell.audio,
          'camera-wall__cell--error':
            cell.status === 'error' || cell.status === 'ffmpeg-missing',
          'camera-wall__cell--fullscreen': fullscreenSlot === cell.index,
          'camera-wall__cell--chart': cell.view !== 'play' && !!cell.deviceId
        }"
        @dragover="onDragOver"
        @drop="onDrop(cell, $event)"
        @click="wall.setActive(cell.index)"
        @contextmenu="onCellContextMenu(cell, $event)"
      >
        <!--
          只有「有回环地址」且「这一路是活的」才画 `<video>`。其余任何状态下这里都是
          一块**有边框的占位区**：没有地址的播放器等于一块黑矩形，它既不能说明相机
          RTSP 没开，也不能说明 ffmpeg 缺失。`releaseVideo()` 还会在停止时先清掉
          `src`，所以离开播放态的元素永远不会留着一个悬空地址。

          刻意**没有** `controls`：原生控件会与下面那一条控制条同时出现，一格里有
          两套控件本身就是「两个地方说同一件事」。`muted` 只是初始值（自动播放必须从
          静音开始），之后由 `applyAudioOutput()` 写真实属性。
        -->
        <video
          v-if="cell.view === 'play' && cell.url && isCameraCellLive(cell.status)"
          :key="cell.url"
          :ref="(el) => bindVideo(cell.index, el as HTMLVideoElement | null)"
          class="camera-wall__video"
          :src="cell.url"
          autoplay
          playsinline
          muted
          @loadeddata="onCellVideoReady(cell)"
          @playing="onCellVideoReady(cell)"
          @error="onCellVideoProblem(cell)"
          @ended="onCellVideoProblem(cell)"
        ></video>

        <!--
          三种"图"的视图（业主 2026-09-18 第 10 批第 2 条）。数据来自相机自己的
          声学预览通道（`pcmData` / `fftData`），由 `stores/cameraCellCharts` 按设备订阅
          一次、同一台设备的多格共享 —— 详见那个 store 的文件头（相机的 WebSocket 路数有限）。
        -->
        <CameraCellChart
          v-else-if="cell.view !== 'play' && cell.deviceId"
          :key="cell.deviceId + ':' + cell.view"
          :device-id="cell.deviceId"
          :mode="cell.view"
        />

        <!--
          没有画面：一整块有边框的空区域。
          没有转圈、没有进度条、没有任何暗示「再等一会儿」的动画——占位区说的是
          「这一格现在没有画面」，不是一个还在加载的东西。

          空白格（还没有相机）里**只有正中一个大 `+`**（横向与纵向都居中 —— 见
          `.camera-wall__body--empty` 上记的那次产品改主意）：没有文字、没有可见的
          下拉框（产品要求）。`+` 是一个真正可聚焦的 `<button>`，回车/Space 一样打开
          这一格的相机选择器；选择器挂在墙级别的隐藏宿主里（见模板末尾），所以这一格
          真的一个字都不写 —— 那个加号是两条 SVG 线，不是文字。
          非空白格只留设备自己的原文诊断：短状态词已经在叠加条的徽标上，不再重复。
        -->
        <div
          v-else
          class="camera-wall__body"
          :class="{ 'camera-wall__body--empty': cell.status === 'empty' }"
        >
          <button
            v-if="cell.status === 'empty' && cameraDevices.length"
            type="button"
            class="camera-wall__add"
            data-camera-picker-trigger
            aria-haspopup="listbox"
            :aria-expanded="pickerSlot === cell.index"
            :aria-label="t('cameraWallUi.assignToCell')"
            :title="t('cameraWallUi.assignToCell')"
            @click.stop="togglePicker(cell, $event)"
          >
            <svg class="camera-wall__plus" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="12" y1="4" x2="12" y2="20" />
            </svg>
          </button>
          <p v-else-if="cellMessage(cell)" class="camera-wall__hint">{{ cellMessage(cell) }}</p>
        </div>

        <!--
          顶部叠加条：只**说事实**（哪台相机、什么状态、是不是正在出声、是不是当前格）。
          它不再放任何按钮 —— 一格里的动作全部在下面的控制条上。

          它**永远显示**（业主 2026-09-21 批移除了「显示/隐藏叠加信息」那一项）：
          状态必须一直在场，值班台上一条"想看才出现"的状态等于没有状态。
        -->
        <div v-if="cell.status !== 'empty'" class="camera-wall__overlay" :class="{ 'camera-wall__overlay--chart': cell.view !== 'play' }">
          <button
            v-if="cameraDevices.length"
            type="button"
            class="camera-wall__name camera-wall__name--action"
            data-camera-picker-trigger
            aria-haspopup="listbox"
            :aria-expanded="pickerSlot === cell.index"
            :aria-label="t('cameraWallUi.replaceDevice')"
            :title="t('cameraWallUi.replaceDevice')"
            @click.stop="togglePicker(cell, $event)"
          >
            {{ cell.deviceName }}
          </button>
          <span v-else class="camera-wall__name" :title="cell.deviceName">{{ cell.deviceName }}</span>
          <!-- 短状态徽标：这是**状态**，不是解释，所以它逐格保留。 -->
          <span
            :class="cellBadgeClass(cell)"
            :title="cellMessage(cell) || cellStatusLabel(cell)"
          >{{ cellStatusLabel(cell) }}</span>
          <!--
            「正在出声」文字徽标按业主 2026-09-23 要求删除：哪一格在出声由音量按钮的
            按下态（`--on`）表达，不需要再写一行字。
          -->
          <div class="spacer"></div>
          <span v-if="cell.index === wall.activeSlot" class="camera-wall__active-mark">
            {{ t('cameraWallUi.activeBadge') }}
          </span>
        </div>

        <!--
          手动录像的指示器：走动的时长 + 红点，**独立于叠加条**。
          叠加信息可以被收起来，而「这一路正在写盘」这件事不可以跟着消失。
        -->
        <div v-if="cell.view === 'play' && nvrOf(cell.index).recording" class="camera-wall__rec" role="status">
          <span class="camera-wall__rec-dot" aria-hidden="true"></span>
          {{ t('cameraNvrUi.recordingBadge', { time: recordingClock(cell.index) }) }}
        </div>

        <!--
          底部控制条（业主 2026-09-19 第 12 批）：
          **只有播放器控件** —— 全屏 / 暂停 / 切换录像 / 音量 / 手动录像，
          顺序就是业主给的那个顺序。四颗视图按钮**不在这里了**（它们搬进了右键菜单的
          「显示方式」，见 `camera-nvr.ts`）：那四颗问的是"这一格画什么"，不是播放器动作。
          音量也不再是一条常驻的横滑杆 —— 点「音量」才在图标上方弹出那张细滑条卡片
          （下面那一块）。

          每个控件的无障碍名字都来自目录（`aria-label` 与 `title` 是同一个值），做不到
          的控件一律禁用，而且禁用时它的名字就是原因（见 `playbackLabel()` /
          `recordLabel()` / `volumeLabel()`）。控制条随格子一起进入全屏。

          手填的第三方 RTSP 源**不是设备**：告警 / 切换录像 / 手动录像这三颗对它没有意义
          （它连设备 id 都没有），所以那一格只有 暂停 / 全屏 / 音量 三颗。
        -->
        <div v-if="cell.status !== 'empty' && cell.view === 'play'" class="camera-wall__bar">
          <!-- ② 全屏。 -->
          <button
            type="button"
            class="camera-wall__bar-btn"
            data-action="cell-fullscreen"
            :aria-label="fullscreenLabel(cell)"
            :title="fullscreenLabel(cell)"
            @click.stop="toggleFullscreen(cell)"
          >
            <svg class="camera-wall__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path
                d="M2 6 V2 H6 M10 2 H14 V6 M14 10 V14 H10 M6 14 H2 V10"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              />
            </svg>
          </button>

          <!--
            ③ 暂停 / 播放（`data-cell-play` 是**给探针用的**钩子：把一条源放进格子只是"分配"，
            真正起流要按这一颗 —— 相机与手填的第三方源走的是同一条路）。
          -->
          <button
            type="button"
            class="camera-wall__bar-btn"
            data-cell-play
            data-action="cell-play"
            :aria-label="playbackLabel(cell)"
            :title="playbackLabel(cell)"
            :aria-busy="isBusy(cell.index)"
            :disabled="isBusy(cell.index) || !canStartCell(cell)"
            @click.stop="toggleCell(cell)"
          >
            <svg class="camera-wall__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path :d="playbackIconPath(cell)" fill="currentColor" />
            </svg>
          </button>

          <!-- ④ 切换录像（= 右键菜单里那一项「回放本机录像」，同一个动作、同一个弹窗）。 -->
          <button
            v-if="cellHasDevice(cell)"
            type="button"
            class="camera-wall__bar-btn"
            data-action="cell-playback"
            :aria-label="t('cameraWallUi.cellPlayback')"
            :title="t('cameraWallUi.cellPlayback')"
            @click.stop="openCellPlayback(cell)"
          >
            <svg class="camera-wall__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M2.4 4.2h11.2v7.6H2.4z" fill="none" stroke="currentColor" stroke-width="1.3" />
              <path d="M6.6 6.3 10 8l-3.4 1.7z" fill="currentColor" />
              <path d="M4.6 13.8h6.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>

          <!--
            ⑤ 音量：点一下在图标上方弹出那张细滑条卡片（见下面 `data-cell-volume-pop`）。
            按钮本身也是"这一格出声"的状态指示（`--on` 就是正在出声的那一格）。
          -->
          <button
            type="button"
            class="camera-wall__bar-btn"
            :class="{ 'camera-wall__bar-btn--on': cell.audio }"
            data-cell-volume-trigger
            data-action="cell-volume"
            :aria-expanded="volumeOpenSlot === cell.index"
            :aria-label="volumeLabel(cell)"
            :title="volumeLabel(cell)"
            :disabled="!isCameraCellLive(cell.status)"
            @click.stop="openVolumePopover(cell)"
          >
            <svg class="camera-wall__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M3 6 H5.6 L9 3 V13 L5.6 10 H3 Z" fill="currentColor" />
              <path
                v-if="cell.audio"
                d="M11.2 5.4 A4.2 4.2 0 0 1 11.2 10.6"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
              />
              <path
                v-else
                d="M11 6 L14 10 M14 6 L11 10"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
              />
            </svg>
          </button>

          <!-- ⑥ 手动录像 / 停止录像（与右键菜单里那一项同一个动作）。 -->
          <button
            v-if="cellHasDevice(cell)"
            type="button"
            class="camera-wall__bar-btn"
            :class="{ 'camera-wall__bar-btn--rec': nvrOf(cell.index).recording }"
            data-action="cell-record"
            :aria-pressed="nvrOf(cell.index).recording"
            :aria-label="recordLabel(cell)"
            :title="recordLabel(cell)"
            :disabled="!canRecord(cell)"
            @click.stop="onCellRecord(cell)"
          >
            <svg class="camera-wall__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <circle cx="8" cy="8" r="4.2" :fill="nvrOf(cell.index).recording ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.3" />
            </svg>
          </button>
        </div>

        <!--
          音量浮层（业主 2026-09-21 批改）：一条**水平**细滑条卡片，出现在音量图标的
          正上方、右缘对齐这一格 —— 宽度是格宽的 20%（min 76 / max 180），贴得近、
          看得懂自己在调哪一格。卡片是白底细边 + 轻阴影，与画面上的暗色控制条区分。

          开合仍是 `volumeOpenSlot`（全墙只开一个），点外面关掉，"关掉这一格的声音"
          那个开关仍然在浮层里（原来挂在音量图标上的语义搬进来之后就没再动过）。
        -->
        <div
          v-if="volumeOpenSlot === cell.index"
          class="camera-wall__volume-pop"
          data-cell-volume-pop
        >
          <input
            class="camera-wall__volume-slider"
            data-cell-volume
            type="range"
            min="0"
            max="100"
            step="1"
            :value="volumePercent(cell.index)"
            :aria-label="volumeSliderLabel(cell)"
            :title="volumeSliderLabel(cell)"
            :disabled="!isCameraCellLive(cell.status)"
            @click.stop
            @input="onVolumeInput(cell, $event)"
          />
          <button
            type="button"
            class="camera-wall__volume-mute"
            :class="{ 'camera-wall__bar-btn--on': cell.audio }"
            data-action="cell-volume-mute"
            :aria-pressed="cell.audio"
            :aria-label="volumeMuteLabel(cell)"
            :title="volumeMuteLabel(cell)"
            :disabled="!isCameraCellLive(cell.status)"
            @click.stop="toggleAudio(cell)"
          >
            <svg class="camera-wall__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M3 6 H5.6 L9 3 V13 L5.6 10 H3 Z" fill="currentColor" />
              <path
                v-if="cell.audio"
                d="M11.2 5.4 A4.2 4.2 0 0 1 11.2 10.6"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
              />
              <path
                v-else
                d="M11 6 L14 10 M14 6 L11 10"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>

        <!--
          这一格的 NVR 结果：录像已开始 / 文件已保存 / 地址已复制 / 主进程的拒绝…
          **逐格**显示，而不是全墙共享一条提示条 —— 右键 B 格抓图成功却把提示画在
          A 格下面，等于告诉操作员一件没发生的事。空白格永远没有这一条（它没有菜单）。
        -->
        <p
          v-if="cellNvrMessage(cell)"
          class="camera-wall__nvr"
          :class="{ 'camera-wall__nvr--error': nvrOf(cell.index).error !== '' }"
          :role="nvrOf(cell.index).error !== '' ? 'alert' : 'status'"
        >
          {{ cellNvrMessage(cell) }}
        </p>

        <!--
          相机选择器（业主 2026-09-24）：**铺在被点的那一格里面**（inline 覆盖整格），
          不再是格子旁边的浮动卡片——之前在格下方弹出，操作员要挪视线，很不方便。
          组件挂在格子里（`position: relative`），内部跳过 Teleport 与锚点测量。
        -->
        <CameraCellPicker
          v-if="pickerSlot === cell.index"
          inline
          open
          :anchor="null"
          :items="pickerItems"
          :empty-label="t('cameraWallUi.pickNoOption')"
          :label="pickerLabel"
          @select="pickDevice"
          @close="closePicker()"
        />
      </div>
    </div>

    <!--
      分屏档位（1/4/9/16）停靠条（业主 2026-09-23：从标题行挪下来）。
      平时只剩一条细把手；鼠标移到墙的底部（或键盘聚焦进去）时按钮浮出。
      图标与真实网格用同一份来源：档位本身 + `cameraWallColumns()`。
    -->
    <div class="camera-wall__layout-dock" data-layout-dock>
      <span class="camera-wall__layout-handle" aria-hidden="true"></span>
      <div
        class="segment camera-wall__layout"
        role="group"
        :aria-label="t('cameraWallUi.layoutGroup')"
      >
        <button
          v-for="option in CAMERA_WALL_LAYOUTS"
          :key="option"
          type="button"
          class="segment__item"
          :class="{ 'segment__item--active': option === layout }"
          :aria-pressed="option === layout"
          :aria-label="t('cameraWallUi.layoutLabel', { count: option })"
          :title="t('cameraWallUi.layoutLabel', { count: option })"
          @click="changeLayout(option)"
        >
          <LayoutGridIcon :count="option" :columns="cameraWallColumns(option)" />
        </button>
      </div>
    </div>

    <!--
      相机选择器已搬进格子内部（业主 2026-09-24：铺满被点的那一格，见格子末尾的
      `CameraCellPicker inline`），不再是墙级别的一份 Teleport 浮层。它历史上是
      原生 `<select>` 隐藏宿主（2026-09-18 的 bug）→ 贴格浮层 → 现在的格内覆盖层。
      选项仍然只来自 `optionsForCell()`：「哪几台相机可选」没有第二份实现。
    -->
    <!--
      手填 RTSP 地址的**管理界面不在这里**（业主 2026-09-19 第 11 批第 2 条曾把它挪到实时监测页；
      2026-09-21 第二批第 23 条又从实时监测页撤掉，`ManualRtspSources.vue` 目前没有挂载点）。
      这一页只把已经存在的那些源列进选择器，并把地址交给主进程。
    -->
    <!--
      右键菜单与三个对话框：挂在**墙级别**，只画一份。

      菜单项来自纯函数 `buildCameraNvrMenu()`（存在性、顺序、灰显原因都在那里），
      本组件只负责派发。菜单头部就是被右键那一格的设备名 —— 菜单是对画面格打开的，
      不是对整页打开的。
    -->
    <VideoContextMenu
      :open="menuOpen"
      :x="menuX"
      :y="menuY"
      :title="menuTitle"
      :items="menuItems"
      @select="onCellMenuSelect"
      @close="closeMenu"
    />

    <!-- 本机录像回放：列表与播放都在弹窗里（`<video>` 吃回环地址）。 -->
    <CameraRecordingPlaybackDialog
      v-model="playbackOpen"
      :device-id="playbackDeviceId"
      :device-name="playbackDeviceName"
      :preset-recording-id="playbackPresetId"
    />

    <!-- 设备检测记录下载：下载完成的那一段可以直接接着回放。 -->
    <CameraDetectDownloadDialog
      v-model="downloadOpen"
      :device-id="downloadDeviceId"
      :device-name="downloadDeviceName"
      @play="onDownloadedPlay"
    />
  </section>
</template>

<style scoped>
.camera-wall {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.camera-wall__notice {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

/* --- 分屏档位（底部半隐藏停靠条，业主 2026-09-23） ----------------------- */

/*
 * 停靠条平时只露一条细把手；鼠标移到墙的底部（悬停停靠条）或键盘聚焦进去时，
 * 档位按钮浮出。隐藏时 `pointer-events: none` —— 看不见的按钮不能被点到。
 */
.camera-wall__layout-dock {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 6px;
  min-height: 14px;
}

.camera-wall__layout-handle {
  width: 36px;
  height: 4px;
  border-radius: 999px;
  background: var(--color-border-strong);
  opacity: 0.7;
  transition: opacity 0.15s ease;
}

.camera-wall__layout-dock .camera-wall__layout {
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%) translateY(4px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease, transform 0.15s ease;
  box-shadow: var(--shadow-lg);
}

.camera-wall__layout-dock:hover .camera-wall__layout,
.camera-wall__layout-dock:focus-within .camera-wall__layout {
  opacity: 1;
  transform: translateX(-50%);
  pointer-events: auto;
}

.camera-wall__layout-dock:hover .camera-wall__layout-handle {
  opacity: 0;
}

.camera-wall__layout {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-bg-subtle);
}

.camera-wall__layout .segment__item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.camera-wall__layout .segment__item:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text);
}

.camera-wall__layout .segment__item--active,
.camera-wall__layout .segment__item--active:hover {
  border-color: var(--color-accent-border);
  background: var(--color-accent-soft);
  color: var(--color-accent-hover);
}

.camera-wall__layout .segment__item:focus-visible {
  outline: 2px solid var(--color-accent-border);
  outline-offset: 1px;
}

.camera-wall__grid {
  display: grid;
  gap: 6px;
}

/*
 * 一格的高宽比 = 16:9（产品要求：「总览界面，四个窗口默认是 16:9 的比例」）。
 *
 * 为什么写在**格子**上而不是写在 `<video>` 上：这一格的边框、占位区、叠加条、
 * 控制条全都以格子为坐标原点，只有格子的盒子是 16:9，整格看上去才是 16:9；
 * 写在 `<video>` 上只会让画面在里面居中留边，格子仍然是一个随便多高的矩形。
 *
 * 网格里没有显式的行高，所以每一行的高度就是「这一行项目的内容高度」：项目宽度由
 * 列宽（`minmax(0, 1fr)`）决定，`aspect-ratio` 再把它换算成高度。4 分屏下四个格子
 * 等宽，于是四个格子都是 16:9（真实窗口里量到的数字见
 * `scripts/video-proof-driver.cjs` 的 `wall cell ratio` 一行，四档都要 ~16:9）。
 *
 * 原来这里有一条 `min-height: 170px`。它这一轮被**删掉**了，因为它是唯一能让 16:9
 * 失效的东西：9 / 16 分屏在窄窗口里每格只有一两百像素宽，170px 的下限会把格子顶得
 * 比 16:9 更高。真机实测：删掉之后 16 分屏每格是 275.2×154.8（= 16:9），而 170px 的
 * 下限会让同一个宽度变成 275.2×170 ≈ 1.62:1 —— 声明还在，比例却不是产品要的那个。
 * 下限的本意是「别让格子塌掉」，而 `aspect-ratio` 已经保证格子不会塌：宽多少，高就是
 * 它的 9/16。取舍是明确的：16 分屏在窄窗口里格子就是小，这是 16 分屏这个档位本身的
 * 性质，而不是让**比例**去迁就它。
 */
.camera-wall__cell {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 16 / 9;
  background: #000;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

/*
 * 没有画面的格子 = 一块**有边框的空区域**（填满整格），不是一个转圈的加载态。
 *   实线边框：分配了相机，但这一路没有画面（未开始 / RTSP 未启用 / 流错误…）；
 *   虚线边框：还没有分配相机，等着放一台进来。
 * 两种都是「这一格是空的」这个事实，颜色也回到页面主题（黑底只属于真正的画面）。
 */
.camera-wall__cell--placeholder {
  background: var(--color-bg-subtle);
  border-color: var(--color-border-strong);
}

.camera-wall__cell--empty {
  border-style: dashed;
}

/* 当前格：橙色边框（与侧栏选中态同一套语义），但不覆盖错误色。 */
.camera-wall__cell--active {
  border-color: var(--color-accent);
  box-shadow: inset 0 0 0 1px var(--color-accent);
}

.camera-wall__cell--audio {
  border-color: var(--color-success);
}

.camera-wall__cell--error {
  border-color: var(--color-danger-border);
}

.camera-wall__cell--chart {
  background: #fff;
  border-color: var(--color-border);
}

/*
 * 全屏 = 渲染层固定层（不用原生 Fullscreen API：Electron 里它会被窗口焦点/权限策略
 * 挡住，实测"点了没反应"，2026-09-23）。格子原地变成覆盖整个窗口的黑色舞台，
 * 视频元素与 RTSP 会话不动；Esc 退出。
 */
.camera-wall__cell--fullscreen {
  position: fixed;
  inset: 0;
  z-index: 60;
  width: auto;
  height: auto;
  min-height: 0;
  border-radius: 0;
  background: #000;
}

/*
 * 画面填满整格，`object-fit: contain` 保证不变形。
 *
 * 这里原来还有一条 `min-height: 170px`，与格子上那条一起删掉了：格子现在由
 * `aspect-ratio: 16 / 9` 给出确定的高度，元素再给一个更高的下限只会让画面比格子还高、
 * 被 `overflow: hidden` 裁掉一条 —— 那样「整格是 16:9」照样成立，但画面会缺边。
 */
.camera-wall__video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.camera-wall__body {
  display: flex;
  /* 填满整格：占位区是这一格的**内容**，不是几个居中的字。 */
  flex: 1 1 auto;
  align-self: stretch;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: var(--space-3);
  text-align: center;
  color: var(--color-text);
}

/*
 * 空白格的内容只有一个大 `+`，它在格子的**正中**。
 *
 * 这里记一次**刻意的产品反转**：上一轮这一条是 `align-items: flex-end`（产品当时的
 * 原话是「做成一个大的+号放在右侧」），`scripts/video-proof-driver.cjs` 里也有一条
 * 「`+` 距格子右边 ≤ 24px」的断言。产品负责人这一轮改主意了 ——「添加新视频或者声纹图
 * 的加号应该在窗口中心」—— 所以这里改回 `center`，那条断言也换成了「`+` 的水平中心
 * 与格子中心之差」（见 `emptyCellProblems()`），不是删掉，而是钉住新的要求。
 *
 * `align-items` 是交叉轴（行方向的水平轴），`justify-content` 是主轴（列方向的垂直
 * 轴），两个都是 `center`，所以 `+` 在横竖两个方向上都居中。基类
 * `.camera-wall__body` 本来就写着两个 `center`；这一条保留下来是为了让「居中」这件事
 * 有一个带出处的位置，改回去的人会先看到这段说明。
 */
.camera-wall__body--empty {
  align-items: center;
}

/*
 * 「往这一格里放一台相机」的入口。它是一个真正可聚焦的 <button>：键盘 Tab 到它、
 * 回车/Space 打开相机选择器；读屏拿到的是按钮上的 aria-label（「放入这一格」）。
 * 里面那个 `+` 是两条 SVG 线，不是文字 —— 这一格因此没有任何文本节点。
 */
.camera-wall__add {
  all: unset;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  cursor: pointer;
}

.camera-wall__add:hover {
  background: var(--color-bg-muted);
  color: var(--color-accent);
}

.camera-wall__add:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.camera-wall__plus {
  display: block;
  width: 44px;
  height: 44px;
}

.camera-wall__plus line {
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
}

.camera-wall__hint {
  font-size: 11.5px;
  margin: 0;
  max-width: 90%;
  line-height: 1.5;
  color: var(--color-text-secondary);
}

/*
 * 顶部叠加条：只说事实，没有按钮。`z-index` 高于画面；控制条在下面那条，两条都在
 * `<video>` 之上，所以播放中也能读到状态、也够得着控件。
 */
.camera-wall__overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  background: rgba(17, 24, 39, 0.62);
  color: #f9fafb;
  font-size: 11px;
}

.camera-wall__overlay--chart {
  background: rgba(255, 255, 255, 0.96);
  color: var(--color-text, #111827);
  border-bottom: 1px solid var(--color-border, #e5e7eb);
}

.camera-wall__overlay--chart .camera-wall__name--action:focus-visible {
  outline-color: var(--color-accent, #ff6a1a);
}

.camera-wall__name {
  font-weight: 600;
  max-width: 40%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/*
 * 设备名同时是「换一台相机」的入口：它长得像文字，但真的是一个可聚焦按钮。
 * 只在真的有别的相机可选时才是按钮（一台相机都没有时它就是一个 <span>）。
 */
.camera-wall__name--action {
  all: unset;
  cursor: pointer;
  font-weight: 600;
  max-width: 40%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.camera-wall__name--action:hover {
  text-decoration: underline;
}

.camera-wall__name--action:focus-visible {
  outline: 2px solid #f9fafb;
  outline-offset: 1px;
}

/* 叠加条里的徽标不许被挤扁（`.badge` 来自 main.css，这里只补弹性行为）。 */
.camera-wall__overlay .badge {
  flex: 0 0 auto;
}

/* 「正在出声」文字徽标已按业主 2026-09-23 要求删除（音量按钮的按下态表达同一件事）。 */

.camera-wall__active-mark {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--color-accent);
  color: #fff;
  font-size: 10px;
}

/*
 * --- 底部控制条 ---------------------------------------------------------
 * 常规播放器的那一条：贴在这一格的底部、压在画面之上（`position: absolute`），所以
 * 它不会把画面挤变形。它不是 `fixed`：它随格子一起进入全屏，全屏之后仍然在原处。
 */
.camera-wall__bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: rgba(17, 24, 39, 0.68);
  color: #f9fafb;
}

.camera-wall__bar-btn {
  all: unset;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  border-radius: 4px;
  color: #f9fafb;
  cursor: pointer;
}

.camera-wall__bar-btn:hover:not(:disabled) {
  background: rgba(249, 250, 251, 0.24);
}

/* 正在出声：与徽标同一个绿色，一眼看得出是哪一格。 */
.camera-wall__bar-btn--on {
  background: rgba(21, 128, 61, 0.9);
}

.camera-wall__bar-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.camera-wall__bar-btn:focus-visible {
  outline: 2px solid #f9fafb;
  outline-offset: 1px;
}

.camera-wall__icon {
  display: block;
  width: 15px;
  height: 15px;
}

/* 正在录像：与叠加条上那个红点同一个危险色，一眼看得出这一路在写盘。 */
.camera-wall__bar-btn--rec {
  background: rgba(185, 28, 28, 0.9);
}

/*
 * --- 音量浮层（业主 2026-09-21 批） -----------------------------------------
 * 一条**水平**细滑条卡片，出现在音量图标正上方：`bottom` 略高于控制条那一行，
 * `right` 对齐这一格的右缘（音量图标就在右起第二颗的位置）。宽度是**格宽**的
 * 20%（offset parent 是格子容器，`%` 相对格宽），clamp 到 76–180px：16 分屏的小格
 * 里它仍有 76px 可拖，大格里也不会宽得离谱。
 *
 * 它**在格子里面**，而格子是 `overflow: hidden` —— 卡片随格宽伸缩，永远不会比格宽。
 */
/*
 * 音量浮层（业主 2026-09-23：竖排）。滑杆与静音钮**纵向**排列：滑杆在上、
 * 静音钮在下。纵向 range 用 `writing-mode: vertical-lr` + `direction: rtl`
 * （值大的一头朝上），Chromium 原生支持，不需要旋转 hack。
 */
.camera-wall__volume-pop {
  position: absolute;
  right: 8px;
  bottom: 36px;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 10px 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: #fff;
  box-shadow: var(--shadow-lg);
}

/*
 * 竖向滑杆：轨道 4px 圆条、thumb 10px 圆点。原生 range 的样式必须同时写
 * WebKit 与 Gecko 两条伪元素（Firefox 不吃 `-webkit-slider-*`）， appearance 关掉，
 * 否则浏览器那套默认皮肤会从白卡片里透出来。
 */
.camera-wall__volume-slider {
  flex: none;
  width: 14px;
  height: 96px;
  margin: 0;
  appearance: none;
  -webkit-appearance: none;
  writing-mode: vertical-lr;
  direction: rtl;
  background: transparent;
  cursor: pointer;
}

.camera-wall__volume-slider::-webkit-slider-runnable-track {
  width: 4px;
  border-radius: 999px;
  background: var(--color-bg-muted);
}

.camera-wall__volume-slider::-webkit-slider-thumb {
  appearance: none;
  -webkit-appearance: none;
  width: 10px;
  height: 10px;
  margin-left: -3px;
  border: none;
  border-radius: 50%;
  background: var(--color-accent);
}

.camera-wall__volume-slider::-moz-range-track {
  height: 4px;
  border-radius: 999px;
  background: var(--color-bg-muted);
}

.camera-wall__volume-slider::-moz-range-thumb {
  width: 10px;
  height: 10px;
  border: none;
  border-radius: 50%;
  background: var(--color-accent);
}

.camera-wall__volume-slider:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
  border-radius: 4px;
}

.camera-wall__volume-slider:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* 卡片里那个声音开关：白底上不再是暗色控制条的浅色图标，换成主题的深色次级色。 */
.camera-wall__volume-mute {
  all: unset;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 18px;
  border-radius: 4px;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.camera-wall__volume-mute:hover:not(:disabled) {
  background: var(--color-bg-muted);
  color: var(--color-text);
}

.camera-wall__volume-mute:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.camera-wall__volume-mute:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

/* --- 轮询指示器（业主 2026-09-21 批「超出窗口数自动轮询」） ---------------- */
.camera-wall__rotation {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--color-accent-soft);
  color: var(--color-accent-hover);
  font-size: 11px;
  white-space: nowrap;
}

.camera-wall__rotation-btn {
  all: unset;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 20px;
  border-radius: 4px;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.camera-wall__rotation-btn:hover {
  background: var(--color-bg-muted);
  color: var(--color-text);
}

.camera-wall__rotation-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

/*
 * --- 录制指示器与逐格结果 -------------------------------------------------
 * 指示器贴在右上角、压在画面上；它**不跟叠加条一起被隐藏**（见模板里的说明）。
 * 结果条压在控制条之上：控制条是常驻的操作入口，结果是一次性的状态。
 */
.camera-wall__rec {
  position: absolute;
  top: 4px;
  right: 6px;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: #fef2f2;
  background: rgba(153, 27, 27, 0.85);
  border-radius: 999px;
  pointer-events: none;
}

.camera-wall__rec-dot {
  width: 7px;
  height: 7px;
  background: #ef4444;
  border-radius: 50%;
  animation: camera-wall-rec-pulse 1.2s ease-in-out infinite;
}

@keyframes camera-wall-rec-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.camera-wall__nvr {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 30px;
  z-index: 4;
  margin: 0;
  padding: 4px 8px;
  font-size: 10.5px;
  line-height: 1.4;
  color: #f9fafb;
  background: rgba(21, 128, 61, 0.88);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.camera-wall__nvr--error {
  background: rgba(153, 27, 27, 0.9);
}
</style>
