/**
 * Live video from an FA371 acoustic camera, as the RENDERER sees it.
 *
 * WHY THIS IS A SHARED DOMAIN FILE
 * The renderer has to name these states (`starting` / `playing` / `rtsp-disabled` /
 * `ffmpeg-missing` / `error`) and it must not import from `src/main/` to do it: the
 * renderer's tsconfig does not include the main process, and the whole architecture
 * rests on that boundary. Declaring the shape here keeps the dependency direction
 * one-way — renderer -> shared -> (type-only) main.
 *
 * WHAT THE STATES MEAN, AND WHY THEY ARE NOT A BOOLEAN
 * "Is the live view up?" has five honest answers and a boolean cannot carry them:
 *
 *   idle           nothing was ever started for this camera
 *   starting       the loopback server is up; ffmpeg has not produced a byte yet
 *   playing        MP4 bytes are flowing to the renderer
 *   rtsp-disabled  the DEVICE says its RTSP service is off (`rtsp_enabled = 0`,
 *                  measured on the real camera). Nothing is wrong with this app, and
 *                  nothing will work until somebody enables RTSP on the camera.
 *   ffmpeg-missing the bundled transcoder is absent or will not run. Must never be
 *                  shown as a black rectangle.
 *   error          ffmpeg ran and failed, or every RTSP URL candidate was rejected.
 *   limit-exceeded the app's OWN concurrency budget is full: N other cameras are
 *                  already streaming and this process refuses to open one more.
 *                  This is not a device fault and not a stream fault — the camera is
 *                  fine, the app is deliberately capping itself (one ffmpeg child,
 *                  one loopback socket and one buffer per live stream). Stopping
 *                  another stream makes this one start, and the UI must say exactly
 *                  that instead of showing a stream that never appears.
 *
 * The point of the distinction is that each one tells the operator to do something
 * different (enable RTSP on the camera / reinstall the app / open the log / stop
 * another live view).
 */

/** Every state the live view can be in. */
export const CAMERA_LIVE_STATUSES = [
  'idle',
  'starting',
  'playing',
  'rtsp-disabled',
  'ffmpeg-missing',
  'error',
  'limit-exceeded'
] as const

export type CameraLiveStatus = (typeof CAMERA_LIVE_STATUSES)[number]

/**
 * `remux` copies the camera's H.264 into fragmented MP4 (`-c:v copy`) and is the
 * primary path. `transcode` re-encodes with libx264 and is only ever used as an
 * explicit, logged fallback — see `buildRtspTranscodeArgs`.
 */
export type CameraLiveMode = 'remux' | 'transcode'

/**
 * 一次「开始直播」请求。
 *
 * 两种来源**二选一**（业主 2026-09-19 第 3 条把第 10 批第 2 条的 RTSP 那一半钉成
 * "手填地址给第三方相机"）：
 *   · `deviceId` —— 已登记的相机，地址由 `GET /system/video` 推出来（含 `rtsp_enabled` 这类
 *     设备事实可以问）；
 *   · `url` + `sourceId` —— 手填的第三方地址，本机除了这串字符串什么都不知道。
 *
 * `deviceId` 因此由必填变成可选，但**两者必须恰好给一个**：两个都给是调用方在猜，
 * 两个都不给没有可拉的源。这条判据在 IPC 处理器里（`camera-live:start`）显式检查。
 */
export interface CameraLiveStartInput {
  deviceId?: string
  /** 手填的 RTSP 地址（`rtsp://` 或 `rtsps://`）。 */
  url?: string
  /** 手填源在墙上的稳定 id（`rtsp:<32 位十六进制>`）；给了 `url` 就必须给它。 */
  sourceId?: string
  /** Defaults to `remux`. */
  mode?: CameraLiveMode
}

/** Snapshot of one camera's live session. */
export interface CameraLiveState {
  deviceId: string
  status: CameraLiveStatus
  /**
   * The loopback URL the `<video>` element must use, e.g.
   * `http://127.0.0.1:51321/<token>/stream.mp4`. Present whenever a server is up.
   */
  url?: string
  /**
   * The RTSP address that was actually handed to ffmpeg, with any password masked.
   * Shown in the UI for reference — an operator diagnosing a camera needs to see
   * which address the app is using, and a masked password is not a secret leak.
   */
  rtspUrl?: string
  /** Which of the two ffmpeg paths is in use. */
  mode?: CameraLiveMode
  /** ffmpeg's own diagnostic tail, or the reason RTSP is unavailable. */
  error?: string
  startedAt?: number
  /** Bytes forwarded to the renderer so far — the honest "is it actually moving". */
  bytesSent?: number
  /** How many RTSP URL candidates have been tried, and which one is current. */
  attempt?: number
  /** Stable candidate id (`rtsp_without_credentials`, …), for the log and the UI. */
  attemptId?: string
}

/** The states in which a session exists and the `<video>` element should hold its URL. */
export function isCameraLiveActive(status: CameraLiveStatus): boolean {
  return status === 'starting' || status === 'playing'
}

/**
 * 本机同时直播的预算与用量（`camera-live:limits` 的返回值）。
 *
 * 声明在域模型里而不是 IPC 契约里：主进程的 `RtspStreamService` 自己就要产出它，
 * 而契约文件的定位是「渲染层能看到的形状」，主进程不该为了一个数字反向依赖它。
 *
 * `max` 来自 `AppSettings.maxConcurrentCameraStreams`，`active` 是主进程此刻真的
 * 持有**会话**的路数（含 `starting`：它已经占了一个 ffmpeg 与一个回环端口）。
 * 两个数字都由主进程给出，渲染层不自己求和——否则界面上的「还能再开几路」会和
 * 主进程的拒绝条件漂移。
 */
export interface CameraLiveLimits {
  /** 同时直播上限，1..16。 */
  max: number
  /** 当前正在直播的路数（含 `starting`）。 */
  active: number
}

// ---------------------------------------------------------------------------
// 并发上限（多路直播的预算）
// ---------------------------------------------------------------------------

/**
 * 同时直播的默认路数。
 *
 * 上限**不是**设备给的：相机实测上报 `rtsp_client_limit: 10`，设备侧还能再开。
 * 真正的瓶颈在本机主进程——每一路都要一个 ffmpeg 子进程、一个回环 HTTP 服务、
 * 一个 socket 和一份转封装缓冲，解码与显存成本也在渲染层。所以这里给一个**明确
 * 且可配置**的预算，而不是让 N 路悄悄堆积直到整机卡死：默认 4 路（4 分屏正好一
 * 屏），设置页里可以改。
 *
 * 设备的 `rtsp_client_limit` 仍然是第二道约束（相机自己会拒绝超出的连接），
 * 只是它比本机预算宽松，因此不是这里的绑定约束。
 */
export const DEFAULT_MAX_CONCURRENT_CAMERA_STREAMS = 4

/** 上限的硬边界：`AppSettings` 的校验器与设置页都引用它，避免两处各写一个数字。 */
export const MIN_CONCURRENT_CAMERA_STREAMS = 1
export const MAX_CONCURRENT_CAMERA_STREAMS = 16

/** 把任意来路不明的上限夹进合法区间（localStorage、旧设置、IPC 入参）。 */
export function normaliseMaxConcurrentStreams(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_CONCURRENT_CAMERA_STREAMS
  }
  const floored = Math.floor(value)
  if (floored < MIN_CONCURRENT_CAMERA_STREAMS) return MIN_CONCURRENT_CAMERA_STREAMS
  if (floored > MAX_CONCURRENT_CAMERA_STREAMS) return MAX_CONCURRENT_CAMERA_STREAMS
  return floored
}

/**
 * 现在还能不能再开一路 —— **纯计算**，主进程与渲染层用的是同一份判断。
 *
 * 参数里刻意没有“设备是不是已经有会话”：那是调用方的事实。主进程在 `start()`
 * 里已经先把「这台相机已经有会话」当作“替换”而不是“新增”，所以传进来的
 * `activeStreams` 是**除本次之外**正在直播的路数。
 */
export function cameraStreamLimitReached(activeStreams: number, maxStreams: number): boolean {
  const cap = normaliseMaxConcurrentStreams(maxStreams)
  const active = Number.isFinite(activeStreams) ? Math.max(0, Math.floor(activeStreams)) : 0
  return active >= cap
}

/**
 * 超过上限时说清楚三件事：上限是几、当前几路、该怎么办。
 *
 * 主进程把这个字符串放进 `CameraLiveState.error`，界面照原样显示（与
 * `rtsp-disabled` 的说明同一个模式：界面不替主进程重新组织故障原因）。
 */
export function cameraStreamLimitMessage(activeStreams: number, maxStreams: number): string {
  const cap = normaliseMaxConcurrentStreams(maxStreams)
  const active = Number.isFinite(activeStreams) ? Math.max(0, Math.floor(activeStreams)) : 0
  return (
    `已达到同时直播上限（最多 ${cap} 路，当前 ${active} 路正在播放）。` +
    '请先停止其他画面格里的直播，再打开这一路。'
  )
}
