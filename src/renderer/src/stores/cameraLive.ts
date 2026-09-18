/**
 * 相机实时视频会话（渲染层）。
 *
 * WHY A STORE AND NOT TWO COPIES OF `ref`s
 * 会话的所有者是**主进程**（`RtspStreamService` 里一台相机一条会话），而渲染层有
 * 两个页面会用到它：监测页的相机分支（自己持有一份局部状态，本次改动不动它）和总览
 * 页新增的「实时画面」。总览页这一侧需要的东西不止一个地址——自动起播的一次性守卫、
 * 手动停止的记录、RTSP 可用性的事实、另一个页面是否正在占用——这些必须住在**一个**
 * 地方，否则「手动停止后又被自动播放拉起来」这类缺陷只会出现在某一个页面上。
 *
 * 三条被刻意写进状态机的规矩
 *   1. **一次启动最多一次自动尝试。** `attempted` 集合在模块作用域里，应用重启即
 *      清空（这正是产品要的「每次打开软件一次」），而且它记录的是「尝试过」而不是
 *      「成功过」：失败也不重试，绝不进入循环。
 *   2. **手动停止优先。** 操作员按下停止后，本进程内任何自动路径都不会再起来；
 *      只有操作员再按一次「开始视频」才会清掉这一位，且那一次会算作手动操作。
 *   3. **另一个页面拿着画面时不抢。** `CameraLiveSession` 对同一台相机只有**一个**
 *      观看者，第二个请求会把第一个替换掉（对方的 `<video>` 当场断开）。所以本
 *      store 只在没有任何会话时才自动起播；已有会话时只「接管」（adopt）。若接管
 *      会踩到另一个页面正在播的画面，就如实告诉操作员，让他自己决定。
 *
 * 一条**不是**限制的限制
 *   多路**不同**相机是可以同时直播的，上限是本机预算
 *   `AppSettings.maxConcurrentCameraStreams`（默认 4 路，见
 *   `@shared/domain/camera-live`），超出的那一路从主进程拿到 `limit-exceeded`
 *   这个如实的状态，这一块画面照原样说明。它和相机的 `rtsp_client_limit` 不是
 *   同一件事，也不要用它去限制界面上的按钮。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { isCameraLiveActive, type CameraLiveState, type CameraLiveStatus } from '@shared/domain/camera-live'
import {
  cameraLiveViewModel,
  decideCameraAutoPlay,
  isSessionActive,
  rtspAvailabilityFromState,
  type CameraAutoPlayDecision,
  type CameraAutoPlayReason,
  type CameraLiveViewModel,
  type CameraRtspAvailability
} from '@shared/domain/camera-autoplay'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'

/**
 * 本次**应用启动**里已经为哪几台相机尝试过自动起播。
 *
 * 模块作用域而非 store 状态：它的语义是「这一个进程里」，而 Pinia store 可能被
 * 重新创建（热更新、未来的多窗口），把它放进 store 会让「一次启动一次」变成
 * 「一次 store 一次」。测试通过 `resetAutoPlayGuards()` 显式模拟一次新的启动。
 */
const autoPlayAttempted = new Set<string>()

/**
 * 被操作员手动停止过的相机。
 *
 * 与 `autoPlayAttempted` 分开：那个回答「试过了吗」，这个回答「他不要」。合并成
 * 一位会出现一个真实缺陷——操作员先手动停止，再手动开始，再切走页面，自动路径就
 * 会因为「试过了」而永远不再接手，可实际上他刚刚明确要过。
 */
const manualStopped = new Set<string>()

/**
 * 正在起播中的相机，用来挡住并发调用。
 *
 * 不是防抖：自动起播与操作员点按钮可能在同一帧里都判定为 `start`，两个 start
 * 会让主进程把第一条会话替换掉。
 */
const starting = new Set<string>()

/** 模拟/重置「一次应用启动」：清空全部一次性守卫。测试与将来的重新登录都会用到。 */
export function resetAutoPlayGuards(): void {
  autoPlayAttempted.clear()
  manualStopped.clear()
  starting.clear()
}

/**
 * 只清「这一轮试过了吗」，**保留**「操作员不要它」。
 *
 * WHY THIS EXISTS（业主 2026-09-18 第 10 批第 1 条「每次打开总览界面默认开启视频流」）
 * `autoPlayAttempted` 的用途是**在一次页面停留里只尝试一次**，绝不进入重试循环。
 * 但它原来活在模块作用域里、清空时机是"一次应用启动"，于是"每次打开总览界面"这条要求
 * 落不了地：第一次进总览起播过之后，再进总览就永远是"本次已经试过了"，画面停着不动。
 *
 * 所以进入**看得见实时画面的那两页**（总览的画面墙、实时监测的相机）时清一次这一位：
 *   - 每次进页面 → 判定重新走一遍 → 「默认开启」成立；
 *   - 一次停留里仍然只有一次尝试（失败不会自转重试）；
 *   - **`manualStopped` 绝不清**：操作员按过「停止视频」的东西，不该因为他换了一次页面
 *     就自己回来。这是与 `resetAutoPlayGuards()` 的全部区别，也是这一位必须单独存在的原因。
 *   - 已知不可用的相机会被 `rtspAvailability` 记住（那一位在 store 里、按进程活着），
 *     所以"每次进页面"不会变成"每次去撞一次已经知道关着的 RTSP"。
 */
export function resetAutoPlayAttempts(): void {
  autoPlayAttempted.clear()
}

/** 主进程这台相机当前的会话状态；没有会话时是 `'idle'`。 */
export interface CameraLiveSessionSnapshot {
  status: CameraLiveStatus
  url?: string | undefined
  rtspUrl?: string | undefined
  error?: string | undefined
  mode?: CameraLiveState['mode']
  bytesSent?: number | undefined
}

export const useCameraLiveStore = defineStore('cameraLive', () => {
  /**
   * 本 store 亲自起过（或接管过）的相机。
   *
   * 它存在的唯一理由是回答「这条会话是我起的，还是别的页面起的」——这个问题不能
   * 靠时间或页面前后来猜，只能记下来。
   */
  const ownSessions = new Set<string>()
  /** 会话中的所有相机，按设备 id。总览页只画选中那一台。 */
  const sessions = ref<Record<string, CameraLiveState>>({})
  /** 本进程已经知道的 RTSP 可用性，按设备 id。 */
  const rtspAvailability = ref<Record<string, CameraRtspAvailability>>({})
  /** 正在 start/stop 的相机，用于按钮的忙碌态。 */
  const busy = ref(false)
  /** 最近一次 IPC 失败的原文（已经本地化）。 */
  const error = ref('')
  /**
   * 主进程里确实在播放、且**不是本页**接管的相机。
   *
   * 目前只有监测页会调用 `cameraLive.start`，所以一条已经 `playing` 的会话而本
   * store 还没有接管过它，就意味着画面在别的页面上。
   */
  const foreignSessions = ref<string[]>([])
  /** 秒级时钟：`playing` 的字节数要能持续刷新，否则画面停了也看不出来。 */
  const now = ref(Date.now())

  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------

  /** 一台相机的会话快照；没有会话返回 `null`。 */
  function sessionOf(deviceId: string): CameraLiveSessionSnapshot | null {
    const state = sessions.value[deviceId]
    if (!state) return null
    return {
      status: state.status,
      url: state.url,
      rtspUrl: state.rtspUrl,
      error: state.error,
      mode: state.mode,
      bytesSent: state.bytesSent
    }
  }

  function availabilityOf(deviceId: string): CameraRtspAvailability {
    return rtspAvailability.value[deviceId] ?? 'unknown'
  }

  /**
   * 把主进程的会话快照读回来。**读，不起播**：这一步存在的意义是让一个在别处
   * （监测页、上一次浏览）已经存在的会话被如实显示，而不是显示成「未开始」。
   */
  async function refresh(deviceId: string): Promise<void> {
    if (deviceId === '') return
    const result = await callApi(() => window.api.cameraLive.state(deviceId))
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    error.value = ''
    const state = unwrap(result)?.[0] ?? null
    if (state) {
      sessions.value = { ...sessions.value, [deviceId]: state }
      rtspAvailability.value = {
        ...rtspAvailability.value,
        [deviceId]: rtspAvailabilityFromState(availabilityOf(deviceId), state)
      }
    }
  }

  /**
   * 标记「这台相机的画面现在属于另一个页面」。
   *
   * 判定依据只有一条：主进程里这条会话是 `starting` / `playing`，而**本 store
   * 从没有为它调过 start**（`ownSessions` 里没有它）。`RtspStreamService` 一台
   * 相机只有一条会话，所以这条会话只可能来自另一个页面。
   *
   * **刻意不查 `fa371Stream`（WebSocket 声纹预览）**：那是另一套协议、另一条连
   * 接，与 RTSP 画面互不占用；把它算进来就是编造一条并不存在的限制。真正的限制
   * 是「一条会话一个观看者」（`CameraLiveSession` 的注释），不是相机的
   * `rtsp_client_limit`。
   */
  function markForeignSession(deviceId: string, snapshot: CameraLiveSessionSnapshot | null): void {
    if (snapshot === null || !isCameraLiveActive(snapshot.status)) {
      foreignSessions.value = foreignSessions.value.filter((id) => id !== deviceId)
      return
    }
    if (!ownSessions.has(deviceId) && !foreignSessions.value.includes(deviceId)) {
      foreignSessions.value = [...foreignSessions.value, deviceId]
    }
  }

  /** 本 store 亲自起过的相机（用于区分「我接管的会话」与「别的页面的会话」）。 */
  function heldByAnotherPage(deviceId: string): boolean {
    if (ownSessions.has(deviceId)) return false
    const snapshot = sessionOf(deviceId)
    return snapshot !== null && isCameraLiveActive(snapshot.status) && foreignSessions.value.includes(deviceId)
  }

  // -------------------------------------------------------------------------
  // 写
  // -------------------------------------------------------------------------

  /**
   * 起播（或接管）一台相机的实时视频。
   *
   * `intent` 决定了两件不同的事：
   *   - `'manual'` —— 操作员按的按钮：清掉「手动停止」这一位，因为他的意思变了；
   *     并且**不算**自动起播的一次尝试（否则按完停止再按开始会把配额用光）。
   *   - `'auto'` —— 开机自动起播：先记下「已尝试」，无论成败都不再试第二次。
   */
  async function start(deviceId: string, intent: 'manual' | 'auto'): Promise<void> {
    if (deviceId === '' || starting.has(deviceId)) return
    if (intent === 'auto') autoPlayAttempted.add(deviceId)
    else manualStopped.delete(deviceId)
    starting.add(deviceId)
    busy.value = true
    try {
      const result = await callApi(() => window.api.cameraLive.start({ deviceId }))
      if (!result.success) {
        // IPC 失败也是一种状态：界面必须能显示原因，而不是留一个黑框。
        sessions.value = {
          ...sessions.value,
          [deviceId]: { deviceId, status: 'error', error: resultMessage(result) }
        }
        error.value = resultMessage(result)
        return
      }
      const state = unwrap(result) ?? null
      error.value = ''
      if (state) {
        ownSessions.add(deviceId)
        foreignSessions.value = foreignSessions.value.filter((id) => id !== deviceId)
        sessions.value = { ...sessions.value, [deviceId]: state }
        rtspAvailability.value = {
          ...rtspAvailability.value,
          [deviceId]: rtspAvailabilityFromState(availabilityOf(deviceId), state)
        }
      }
    } finally {
      starting.delete(deviceId)
      busy.value = false
    }
  }

  /**
   * 手动停止。
   *
   * 释放顺序与监测页一致：先把地址从 `<video>` 上摘掉（它是持有回环请求的那一方，
   * 先停主进程会让浏览器对着一个已经关闭的端口反复重试），再请主进程收摊。
   * 随后记下「操作员不要它」——这一位是本进程内自动路径的最终否决。
   */
  async function stop(deviceId: string): Promise<void> {
    if (deviceId === '') return
    busy.value = true
    try {
      const result = await callApi(() => window.api.cameraLive.stop(deviceId))
      if (!result.success) error.value = resultMessage(result)
      else error.value = ''
    } finally {
      busy.value = false
    }
    manualStopped.add(deviceId)
    ownSessions.delete(deviceId)
    foreignSessions.value = foreignSessions.value.filter((id) => id !== deviceId)
    const next = { ...sessions.value }
    delete next[deviceId]
    sessions.value = next
  }

  // -------------------------------------------------------------------------
  // 自动起播：唯一的调用点
  // -------------------------------------------------------------------------

  /**
   * 读一次世界，然后**只调用一次**判定函数。
   *
   * 返回判定结论，调用方据此决定要不要真的去 start——按钮逻辑与启动路径读的是
   * 同一个 `decideCameraAutoPlay()`，所以两者不可能漂移。
   */
  function decide(input: {
    autoPlayEnabled: boolean
    cameraRegistered: boolean
    deviceId: string
    deviceStatus: string
  }): CameraAutoPlayDecision {
    return decideCameraAutoPlay({
      autoPlayEnabled: input.autoPlayEnabled,
      cameraRegistered: input.cameraRegistered,
      deviceId: input.deviceId,
      deviceStatus: input.deviceStatus,
      rtspAvailability: availabilityOf(input.deviceId),
      sessionStatus: sessionOf(input.deviceId)?.status ?? null,
      manualStopped: manualStopped.has(input.deviceId),
      alreadyAttempted: autoPlayAttempted.has(input.deviceId)
    })
  }

  /**
   * 应用启动（会话建立之后）那一次自动起播。
   *
   * 「有在工作」的判定全部在 `decide()` 里，本函数只负责执行结论：
   *   - `adopt`：主进程里已经有这条会话，什么都不用做，界面会显示它；
   *   - `skip` ：**什么都不做**。不重试、不弹窗；页面上原有的状态说明留在原处，
   *     操作员看到的是「相机 RTSP 未启用」这类事实，而不是一个错误对话框。
   *   - `start`：真的起一次，且这一定是本进程的最后一次自动尝试。
   *
   * 返回结论，便于测试与排障直接断言（而不是只看副作用）。
   */
  async function autoPlayIfWorking(input: {
    autoPlayEnabled: boolean
    cameraRegistered: boolean
    deviceId: string
    deviceStatus: string
  }): Promise<CameraAutoPlayDecision> {
    const decision = decide(input)
    if (decision.action === 'start') await start(input.deviceId, 'auto')
    return decision
  }

  /** 供测试与界面断言「为什么没有自动播放」。 */
  function autoPlaySkipReason(deviceId: string): CameraAutoPlayReason | null {
    if (manualStopped.has(deviceId)) return 'manual-stop'
    if (autoPlayAttempted.has(deviceId)) return 'already-attempted'
    return null
  }

  // -------------------------------------------------------------------------
  // 交给模板
  // -------------------------------------------------------------------------

  /** 这一块画面的完整呈现模型（纯函数 `cameraLiveViewModel()` 的结果）。 */
  function viewModel(deviceId: string, cameraCount: number): CameraLiveViewModel {
    const snapshot = sessionOf(deviceId)
    return cameraLiveViewModel({
      cameraCount,
      sessionStatus: snapshot?.status ?? null,
      sessionUrl: snapshot?.url,
      diagnosis: snapshot?.error,
      rtspUrl: snapshot?.rtspUrl,
      heldByAnotherPage: heldByAnotherPage(deviceId)
    })
  }

  /** 秒级时钟。画面在跑时字节数与「是否还在动」靠它刷新。 */
  function touchClock(): void {
    now.value = Date.now()
  }

  const activeCount = computed(
    () => Object.values(sessions.value).filter((state) => isCameraLiveActive(state.status)).length
  )

  return {
    // state
    sessions,
    busy,
    error,
    now,
    foreignSessions,
    // getters
    activeCount,
    sessionOf,
    availabilityOf,
    heldByAnotherPage,
    autoPlaySkipReason,
    isSessionActive,
    // actions
    refresh,
    markForeignSession,
    start,
    stop,
    decide,
    autoPlayIfWorking,
    viewModel,
    touchClock
  }
})
