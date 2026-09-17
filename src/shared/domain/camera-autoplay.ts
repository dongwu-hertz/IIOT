/**
 * 「打开软件时，如果相机确实在工作，就自动播放视频」——判定与呈现的唯一住处。
 *
 * 为什么这两件事必须放在 shared/domain（纯函数、零依赖）
 *   1. **判定只能有一份。** 「现在该不该自动起播」这个问题会被两条路径问到：
 *      应用启动后的那一次自动尝试，和操作员按「开始视频」时的按钮逻辑。如果各写
 *      一遍，两者一定会漂移（典型后果：按钮点了没反应，或者关掉设置后它还是自己
 *      播了）。所以判定做成一个纯粹的函数，输入是「这一刻的世界」，输出是一个
 *      可判定的动作，两边都调它、并且可以被测试直接钉死。
 *   2. **界面状态的文案只能是 key。** 模板拿到的必须是目录 key 加插值参数，
 *      渲染时才查目录，这样切换语言立即生效，也避免任何一条中文写死进代码。
 *      本文件因此不 import vue-i18n，甚至不 import 任何运行时模块——它只描述
 *      「该显示哪一种事实」，翻译交给界面。
 *
 * 诚实的底线（与 `camera-live.ts` 同一条规矩）
 *   启动时相机没在工作，就**什么都不做**，让页面上原本就有的状态说明留在原处：
 *   不循环重试，也不弹错误框。RTSP 在设备端关掉是设备的现状，不是本软件的故障，
 *   把它做成启动弹窗只会让操作员每次开机都要先关掉一个对话框。
 */

import { isCameraLiveActive, type CameraLiveState, type CameraLiveStatus } from './camera-live'

// ---------------------------------------------------------------------------
// 自动起播的判定
// ---------------------------------------------------------------------------

/**
 * 自动起播的结论。
 *
 * `adopt` 与 `start` 是两件不同的事，所以它们不是同一个布尔值：
 *   - `start` —— 主进程里还没有会话，需要真的开一条（会占用相机的一条 RTSP 连接）；
 *   - `adopt` —— 会话已经在了（例如操作员刚从监测页切过来，或在别处起过），
 *     只需要接管它的回环地址去播放，**绝不能再 start 一次**：那会把正在播放的
 *     会话换掉（`RtspStreamService.start` 对同一台相机是「替换」语义），对方页面
 *     的画面会当场断掉。
 */
export type CameraAutoPlayAction = 'start' | 'adopt' | 'skip'

/**
 * `skip` 的原因，全部是**事实**而不是失败：
 *
 *   disabled          操作员在设置里关掉了「开机自动播放」
 *   no-camera         一台声学相机都没有注册
 *   offline           相机已注册但设备状态是离线/未知——连不上，起播只会得到超时
 *   rtsp-disabled     设备自己报告 RTSP 关闭（`rtsp_enabled = 0`），或视频地址拼不出来
 *   ffmpeg-missing    内置转封装组件缺失，起播必然失败
 *   manual-stop       操作员在本次启动中手动停止过这台相机：手动停止优先
 *   already-attempted 本次应用启动里已经为这台相机尝试过一次，绝不重试
 *   session-active    会话已存在，走 `adopt` 而不是 `skip`（保留在联合类型里，
 *                     方便调用方区分「已采用」与「什么都不用做」两条分支）
 */
export type CameraAutoPlayReason =
  | 'disabled'
  | 'no-camera'
  | 'offline'
  | 'rtsp-disabled'
  | 'ffmpeg-missing'
  | 'manual-stop'
  | 'already-attempted'
  | 'session-active'

export interface CameraAutoPlayDecision {
  action: CameraAutoPlayAction
  /** `action === 'skip'` 时一定有值，其余情况为 `null`（不是 `undefined`，便于断言）。 */
  reason: CameraAutoPlayReason | null
}

/**
 * 一台相机当前的 RTSP 可用性。
 *
 * `unknown` 不是「大概可以」，而是「本进程还没有拿到设备自己说过的那句话」：
 * 相机的 `video_port` / `video_url` 只在 `GET /system/video` 里，而本应用为渲染层
 * 提供的通道没有一次是「只读视频配置」的。于是规则是：
 *   - `disabled` / `unavailable` 是**已经知道的事实**，这种情况下绝不 start；
 *   - `unknown` 只允许尝试**一次**（`alreadyAttempted` 会挡住第二次），
 *     这一次尝试由主进程去做权威判定，并把设备的话（`rtsp_enabled=0`）或
 *     视频地址缺失的原因作为状态回给界面——界面照着显示，它不是错误弹窗。
 */
export type CameraRtspAvailability = 'unknown' | 'enabled' | 'disabled' | 'unavailable'

/**
 * 「现在该不该自动起播」的完整输入。
 *
 * 全部是调用方**已经读到**的事实：本函数不做 I/O、不看时钟、不读存储，
 * 因此同一个输入必然得到同一个结论。
 */
export interface CameraAutoPlayInput {
  /** 设置项「开机自动播放相机实时视频」。默认开启，操作员可关。 */
  autoPlayEnabled: boolean
  /** 是否已经注册了至少一台声学相机。 */
  cameraRegistered: boolean
  /** 被选中的那台相机（没有相机时给空串）。 */
  deviceId: string
  /** 设备状态：ONLINE 之外的任何值都不算「有在工作」。 */
  deviceStatus: string
  /** 本进程已经知道的 RTSP 可用性，见 `CameraRtspAvailability`。 */
  rtspAvailability: CameraRtspAvailability
  /** 主进程里这台相机当前的会话状态；没有会话给 `null`。 */
  sessionStatus: CameraLiveStatus | null
  /** 操作员在本次启动中手动停止过这台相机。手动停止优先于一切自动行为。 */
  manualStopped: boolean
  /** 本次应用启动里已经为这台相机尝试起播过一次。 */
  alreadyAttempted: boolean
}

/** 会话还在（`starting` / `playing`）就意味着主进程已经持有它，只能接管。 */
export function isSessionActive(status: CameraLiveStatus | null): boolean {
  return status !== null && isCameraLiveActive(status)
}

/**
 * 该不该自动起播 / 该不该接管已有会话。
 *
 * 判定顺序就是这个函数的全部内容，且每一步都对应一个可复现的事实；顺序本身也是
 * 刻意的：
 *   1. **开关**最先——操作员关掉了，后面的事都不该发生；
 *   2. **没有相机**——无事可做，也不必显示任何错误；
 *   3. **设备离线/未知**——连不上就不去占用相机的一条连接；
 *   4. **RTSP 已知不可用**（设备说关了 / 视频地址拼不出来 / ffmpeg 缺失）——
 *      这是最容易被做错的一条：起播在这些情况下必然失败，而失败信息只会是
 *      「超时」，那会把设备的现状说成网络故障；
 *   5. **手动停止**——操作员明确不要它，任何自动路径都不得越过这一条；
 *   6. **已尝试过**——一次启动最多一次，绝不进入重试循环。它排在手动停止之后，
 *      因为两条守卫在真实会话里常常同时为真，而「他自己停的」才是准确的原因；
 *   7. **会话已在**——接管，而不是重新开始；
 *   8. 否则**开始**。
 */
export function decideCameraAutoPlay(input: CameraAutoPlayInput): CameraAutoPlayDecision {
  // 1. 设置关掉：什么都不做。
  if (!input.autoPlayEnabled) return { action: 'skip', reason: 'disabled' }

  // 2. 没有注册相机：页面自己会显示「尚未添加声学相机」。
  if (!input.cameraRegistered || input.deviceId === '') {
    return { action: 'skip', reason: 'no-camera' }
  }

  // 3. 设备不在线：起播只会得到一次超时，而且白占相机一条 RTSP 连接。
  if (input.deviceStatus !== 'ONLINE') return { action: 'skip', reason: 'offline' }

  // 4. RTSP 这一侧已知不可用：把设备的现状如实显示，而不是去撞一次失败。
  if (input.rtspAvailability === 'disabled' || input.rtspAvailability === 'unavailable') {
    return { action: 'skip', reason: 'rtsp-disabled' }
  }
  if (input.sessionStatus === 'ffmpeg-missing') {
    return { action: 'skip', reason: 'ffmpeg-missing' }
  }

  // 5. 手动停止优先：操作员明确不要它，本进程内不得自行恢复。
  //
  //    排在「已尝试」**前面**是要紧的：两条守卫在真实会话里几乎总是一起为真（自动
  //    起播先尝试一次，操作员随后按下停止），如果先报 `already-attempted`，界面就
  //    会把「他自己停的」说成「本次已经试过了」——同一个结果、错误的理由。
  if (input.manualStopped) return { action: 'skip', reason: 'manual-stop' }

  // 6. 本次启动已经尝试过一次：不再重试。
  if (input.alreadyAttempted) return { action: 'skip', reason: 'already-attempted' }

  // 7. 会话已经在了：接管它的地址，绝不 start（见 `CameraAutoPlayAction`）。
  if (isSessionActive(input.sessionStatus)) {
    return { action: 'adopt', reason: 'session-active' }
  }

  return { action: 'start', reason: null }
}

// ---------------------------------------------------------------------------
// 判定结果 -> 界面状态
// ---------------------------------------------------------------------------

/**
 * 「实时画面」这一块此刻该显示哪一种事实。
 *
 * 与 `CameraLiveStatus` 刻意分开：那边说的是**会话**，这边说的是**这一块画面**。
 * 多出来的 `no-camera` / `occupied` 不是会话状态，硬塞进会话状态里会逼着每个读它的
 * 地方去理解一个不存在的 ffmpeg 会话。
 */
export type CameraLiveDisplayState =
  | 'no-camera'
  | 'idle'
  | 'starting'
  | 'playing'
  | 'rtsp-disabled'
  | 'ffmpeg-missing'
  | 'error'
  | 'limit-exceeded'
  | 'occupied'

export interface CameraLiveViewModel {
  state: CameraLiveDisplayState
  /**
   * 交给 `<video src>` 的地址。
   *
   * **只有 `starting` / `playing` 会有值**，这一个不变式就是「绝不给操作员一个
   * 永远转圈的黑框」在代码里的落点：没有地址时模板渲染的是说明文字，而不是一个
   * 空的 `<video>` 元素。
   */
  videoUrl: string
  /** 状态徽标的目录 key。 */
  statusKey: string
  /** 徽标色调。 */
  tone: 'idle' | 'ok' | 'warn' | 'danger'
  /** 说明文字的目录 key；空串表示这一种状态下不需要额外说明。 */
  messageKey: string
  /** 说明文字的插值参数。 */
  messageParams: Record<string, string>
  /** 主进程给出的诊断原文（错误状态下就是 ffmpeg 的 stderr 尾行）。 */
  diagnosis: string
  /** 供参考的 RTSP 地址（打码），没有时为空串。 */
  rtspUrl: string
  /** 这一块画面现在是否持有回环地址（决定 `<video>` 是否存在）。 */
  attached: boolean
}

/**
 * 这一块画面的每一种状态 -> 状态徽标目录 key。
 *
 * **导出**出去，而不是在组件里再写一份：这个 `Record` 是全的（覆盖联合类型的每一个
 * 成员），所以给 `CameraLiveDisplayState` 加一个状态时，TypeScript 会强制这里补齐，
 * 组件也就不可能出现「某个状态下徽标是空的」。本仓库刚因为同一类问题吃过一次亏——
 * `camera-live.ts` 新增 `limit-exceeded` 之后，另外两份手写的 `Record<Status, string>`
 * 立刻漏了一个键，于是类型检查当场变红。
 *
 * 与 `MonitorView` 的 `CAMERA_STATUS_KEYS` 同义，但这里的 key 前缀是总览页自己的
 * `overviewLiveUi.*`：总览页的文案（例如「尚未开始」）和监测页的按钮文案
 * （「开始视频」）不是同一句话，共用 key 会逼着两边说同一句。
 */
export const CAMERA_LIVE_STATUS_KEYS: Record<CameraLiveDisplayState, string> = {
  'no-camera': 'overviewLiveUi.statusNoCamera',
  idle: 'overviewLiveUi.statusIdle',
  starting: 'overviewLiveUi.statusStarting',
  playing: 'overviewLiveUi.statusPlaying',
  'rtsp-disabled': 'overviewLiveUi.statusRtspDisabled',
  'ffmpeg-missing': 'overviewLiveUi.statusFfmpegMissing',
  error: 'overviewLiveUi.statusError',
  'limit-exceeded': 'overviewLiveUi.statusLimitExceeded',
  occupied: 'overviewLiveUi.statusOccupied'
}

export interface CameraLiveViewInput {
  /** 注册过的声学相机数量；0 表示这一块只说明「没有相机」。 */
  cameraCount: number
  /** 主进程里这台相机的会话状态；没有会话给 `null`。 */
  sessionStatus: CameraLiveStatus | null
  /** 会话地址（回环 + 每会话令牌）。 */
  sessionUrl?: string | undefined
  /** 主进程的诊断原文。 */
  diagnosis?: string | undefined
  /** 打码后的 RTSP 地址，供参考。 */
  rtspUrl?: string | undefined
  /**
   * 这一条会话是**本页之外**的一方持有的（今天唯一会 `cameraLive.start` 的另一方
   * 是监测页）。
   *
   * 说清楚这里的事实，因为它很容易被写成一条并不存在的限制：主进程对**一台相机**
   * 只有一条会话，而一条会话只有一个观看者（`CameraLiveSession` 的 `res.write`
   * 对象）。所以本页不该在别人正在播放时去接管——那会把对方的画面当场换掉。
   * 与此同时，多路**不同**相机是允许的，上限是本机预算
   * （`AppSettings.maxConcurrentCameraStreams`，默认 4 路，超出得到
   * `limit-exceeded`），它与相机的 `rtsp_client_limit` 不是同一件事。
   */
  heldByAnotherPage?: boolean | undefined
}

/**
 * 把「会话状态 + 页面事实」翻译成这一块画面要显示的东西。
 *
 * 纯函数：没有任何 I/O，也没有默认值来自时钟或存储，所以它可以直接断言。
 */
export function cameraLiveViewModel(input: CameraLiveViewInput): CameraLiveViewModel {
  if (input.cameraCount <= 0) {
    return {
      state: 'no-camera',
      videoUrl: '',
      statusKey: CAMERA_LIVE_STATUS_KEYS['no-camera'],
      tone: 'idle',
      messageKey: 'overviewLiveUi.noCameraHint',
      messageParams: {},
      diagnosis: '',
      rtspUrl: '',
      attached: false
    }
  }

  const status: CameraLiveStatus = input.sessionStatus ?? 'idle'
  const active = isCameraLiveActive(status)
  const diagnosis = input.diagnosis ?? ''
  const rtspUrl = input.rtspUrl ?? ''

  // 属于另一个页面：不接管、不显示 <video>，并且**明说**画面在别处。
  if (active && input.heldByAnotherPage === true) {
    return {
      state: 'occupied',
      videoUrl: '',
      statusKey: CAMERA_LIVE_STATUS_KEYS.occupied,
      tone: 'warn',
      messageKey: 'overviewLiveUi.occupiedHint',
      messageParams: {},
      diagnosis,
      rtspUrl,
      attached: false
    }
  }

  // 只有这两种状态才交出地址，`<video>` 也只会在这两种状态下存在。
  const videoUrl = active ? (input.sessionUrl ?? '') : ''

  if (status === 'rtsp-disabled') {
    return {
      state: 'rtsp-disabled',
      videoUrl: '',
      statusKey: CAMERA_LIVE_STATUS_KEYS['rtsp-disabled'],
      tone: 'warn',
      // 主进程的原文优先：它引用了设备亲口说的 `rtsp_enabled=0`。
      messageKey: diagnosis === '' ? 'overviewLiveUi.rtspDisabledHint' : 'overviewLiveUi.diagnosis',
      messageParams: { reason: diagnosis },
      diagnosis,
      rtspUrl,
      attached: false
    }
  }

  if (status === 'limit-exceeded') {
    // 本机自己设的**同时直播预算**满了（`AppSettings.maxConcurrentCameraStreams`）。
    // 相机没有问题、RTSP 也没有问题，所以这一条既不是设备故障也不是流故障：
    // 主进程的原文（上限几路 / 当前几路 / 该怎么办）必须原样显示。
    return {
      state: 'limit-exceeded',
      videoUrl: '',
      statusKey: CAMERA_LIVE_STATUS_KEYS['limit-exceeded'],
      tone: 'warn',
      messageKey:
        diagnosis === '' ? 'overviewLiveUi.limitExceededHint' : 'overviewLiveUi.diagnosis',
      messageParams: { reason: diagnosis },
      diagnosis,
      rtspUrl,
      attached: false
    }
  }

  if (status === 'ffmpeg-missing') {
    return {
      state: 'ffmpeg-missing',
      videoUrl: '',
      statusKey: CAMERA_LIVE_STATUS_KEYS['ffmpeg-missing'],
      tone: 'danger',
      messageKey:
        diagnosis === '' ? 'overviewLiveUi.ffmpegMissingHint' : 'overviewLiveUi.diagnosis',
      messageParams: { reason: diagnosis },
      diagnosis,
      rtspUrl,
      attached: false
    }
  }

  if (status === 'error') {
    return {
      state: 'error',
      videoUrl: '',
      statusKey: CAMERA_LIVE_STATUS_KEYS.error,
      tone: 'danger',
      messageKey: diagnosis === '' ? 'overviewLiveUi.errorHint' : 'overviewLiveUi.diagnosis',
      messageParams: { reason: diagnosis },
      diagnosis,
      rtspUrl,
      attached: false
    }
  }

  if (status === 'starting' || status === 'playing') {
    return {
      state: status,
      videoUrl,
      statusKey: CAMERA_LIVE_STATUS_KEYS[status],
      tone: 'ok',
      messageKey: status === 'playing' ? '' : 'overviewLiveUi.startingHint',
      messageParams: {},
      diagnosis,
      rtspUrl,
      attached: videoUrl !== ''
    }
  }

  // `idle`：还没开始。这里**不**显示任何错误——没开始不是故障。
  return {
    state: 'idle',
    videoUrl: '',
    statusKey: CAMERA_LIVE_STATUS_KEYS.idle,
    tone: 'idle',
    messageKey: 'overviewLiveUi.idleHint',
    messageParams: {},
    diagnosis,
    rtspUrl,
    attached: false
  }
}

/** 徽标配色类名。与 `main.css` 里真实存在的类一一对应。 */
export function cameraLiveBadgeClass(tone: CameraLiveViewModel['tone']): string {
  if (tone === 'ok') return 'badge badge--success'
  if (tone === 'warn') return 'badge badge--warning'
  if (tone === 'danger') return 'badge badge--danger'
  return 'badge'
}

/** 说明文字的外观类名。 */
export function cameraLiveMessageClass(tone: CameraLiveViewModel['tone']): string {
  if (tone === 'warn') return 'alert alert--warning'
  if (tone === 'danger') return 'alert alert--danger'
  return 'muted'
}

/**
 * 把主进程的会话快照收敛成 RTSP 可用性的**已知事实**。
 *
 * 这一次尝试的返回值就是设备对「你有没有 RTSP」的回答，所以它会被记住：
 * 下一次自动起播的判定就不会再拿同一台相机去撞一次必然失败的连接。
 * `unknown` 表示还没有任何一次会话告诉过我们。
 */
export function rtspAvailabilityFromState(
  previous: CameraRtspAvailability,
  state: CameraLiveState | null
): CameraRtspAvailability {
  if (!state) return previous
  if (state.status === 'rtsp-disabled') return 'disabled'
  if (state.status === 'ffmpeg-missing') return previous
  if (state.status === 'error') {
    // 只有「视频地址拼不出来 / 候选全失败」这一类才是 RTSP 侧的结论；一次
    // 中途断流（`playing` 之后崩掉）说明地址本来是通的，不能据此把 RTSP 判死。
    if (state.error !== undefined && state.error.includes('video_port')) return 'unavailable'
    return previous
  }
  if (state.status === 'starting' || state.status === 'playing') return 'enabled'
  // `limit-exceeded` 是本机预算满了，与 RTSP 无关：既不能把 RTSP 判死，也不能
  // 据此认为它可用（会话根本没走到连接相机那一步）。
  return previous
}
