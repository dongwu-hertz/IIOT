/**
 * 告警联动的**四个动作**的具体实现，以及引擎依赖的接口。
 *
 *   录像 `LinkageRecorder`   —— 用既有媒体机制录一段定长 MP4
 *   弹窗 `LinkagePopupSink`  —— 置顶、不抢焦点、可关闭、有叠加上限
 *   提示（写入 `PendingAlarmStore`，由引擎负责，见 `alarm-linkage-engine.ts`）
 *   邮件 `LinkageEmailSender`—— SMTP + 抓帧附件
 *
 * ---------------------------------------------------------------------------
 * 为什么这些实现都藏在接口后面
 * ---------------------------------------------------------------------------
 * 引擎本身必须能在**没有 Electron、没有 ffmpeg、没有相机、没有网络**的
 * `node --test` 里被断言：一次触发只跑一次、冷却生效、失败互不牵连、
 * 两个源报同一个事件只动作一次。把「怎么录」「怎么弹」抽出来之后，
 * 引擎只剩这三件事，测试就能用假实现精确地驱动它。
 *
 * 生产实现的失败**一律以 `ActionOutcome` 返回，不抛异常**：任务要求
 * 「失败的邮件不能中断录像或弹窗」，靠 `try/catch` 在引擎里兜住是可以的，
 * 但让每个动作自己把失败说清楚更可靠——引擎不必猜某个异常属于哪个动作。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { BrowserWindow, protocol, screen } from 'electron'
import type {
  LinkageActionKind,
  LinkageActionOutcome,
  LinkageEmailMessage,
  LinkageEmailSendResult,
  LinkageSmtpSecurity,
  LinkageTrigger
} from '@shared/domain/alarm-linkage'
import { parseRecipientList } from '@shared/domain/alarm-linkage'
import type { StorageService } from '../storage/storage-service'
import type { RecordingRepository } from '../database/alarm-repository'
import { probeMp4File, probeJpegFile } from '../media/camera-capture'
import { spawnFfmpeg, type FfmpegProcess } from '../media/ffmpeg'
import { deviceLog } from '../logging/logger'
import { SmtpClient } from './smtp-client'

/** 命中哪条规则 = 这台设备。`ruleId` 进审计日志，冷却也按它分桶。 */
export function linkageRuleId(trigger: LinkageTrigger): string {
  return trigger.identity.deviceId
}

// ---------------------------------------------------------------------------
// 录像
// ---------------------------------------------------------------------------

/** 录像请求；引擎只描述「录谁、录多久」，不关心怎么录。 */
export interface LinkageRecordingRequest {
  trigger: LinkageTrigger
  durationSeconds: number
}

export interface LinkageRecorder {
  /** 当前是否已经有一路联动录像在跑。 */
  isBusy(): boolean
  /**
   * 录一段。实现必须在 `durationSeconds` 之后自行收尾并登记录像行。
   * 失败以 `ActionOutcome` 返回，**不抛异常**。
   */
  record(request: LinkageRecordingRequest): Promise<LinkageActionOutcome>
  /** 应用退出时收尾。 */
  dispose(): void
}

/** 可用 RTSP 源；由 `RtspStreamService.currentSource()` 提供。 */
export interface LinkageRecorderSource {
  url: string
  candidateId?: string
  mode?: string
}

export interface FfmpegAlarmRecorderOptions {
  storage: StorageService
  recordings: RecordingRepository
  /** 取当前可用 RTSP 源；`undefined` = 现在没有画面可录（如实失败）。 */
  resolveSource: (deviceId: string) => LinkageRecorderSource | undefined
  resolveDevice: (deviceId: string) => { deviceUid: string; name: string }
  /** 可注入的 ffmpeg 启动器（测试用假实现，生产用真实实现）。 */
  spawnImpl?: typeof spawnFfmpeg
  exists?: (absolutePath: string) => Promise<boolean>
  now?: () => number
  /** 等待 ffmpeg 自然退出的上限 = 时长 + 这个余量。 */
  exitGraceMs?: number
}

/** 告警联动录像行的自由文本标记（`recordings.event_type`）。 */
export const LINKAGE_ALARM_VIDEO_EVENT_TYPE = 'alarm_linked_mp4'

/**
 * `-t <seconds>` 定长录制，`-c:v copy` 不重新编码。
 *
 * 两个与 `camera-capture.ts` 共有的实测约束在这里同样成立，抄在这里免得
 * 下一个人把它删掉：
 *   1. **不要给 RTSP 输入加任何 timeout 参数**：本机这台 FA371
 *      （`rtsp://192.168.110.235:443/live`，服务端 ZLMediaKit）在 ffmpeg 的这份
 *      构建里会把 `-timeout` 当成 RTSP listen 模式，直接 `Unable to open RTSP
 *      for listening`。所以这里只有 `-rtsp_transport tcp`。
 *   2. **分片 MP4**：`moov` 写在开头，任意时刻被杀掉文件都还能播。
 *      `-t` 让 ffmpeg 自己收尾，但应用退出/断流时仍然可能是被强杀的，
 *      分片是那种情况下唯一能保住可播放性的写法。
 */
export function buildAlarmRecordArgs(
  rtspUrl: string,
  filePath: string,
  durationSeconds: number
): string[] {
  return [
    '-rtsp_transport',
    'tcp',
    '-i',
    rtspUrl,
    '-t',
    String(Math.max(1, Math.round(durationSeconds))),
    // 本文件是视频录像：与手动录像同一条规则，音频轨不在本路径的承诺里。
    '-an',
    '-c:v',
    'copy',
    '-f',
    'mp4',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    filePath
  ]
}

/**
 * 联动录像的真实实现。
 *
 * 与既有 `CameraCaptureService` **并存而不是替换**：那个服务拥有「操作员手动
 * 开始/停止」的语义，并且把 `recording_type` 固定成 `manual`——而告警联动录像
 * 必须落成 `alarm`，否则 14.4 的保留策略不会清理它，报警录像会永久占盘。
 * 两者共用同一条 `spawnFfmpeg` 出口与同一套产物校验，不存在第二份 ffmpeg 封装。
 */
export class FfmpegAlarmRecorder implements LinkageRecorder {
  private readonly options: FfmpegAlarmRecorderOptions
  private readonly spawnImpl: typeof spawnFfmpeg
  private readonly existsImpl: (absolutePath: string) => Promise<boolean>
  private readonly now: () => number
  private active: { deviceId: string; child: FfmpegProcess; absolutePath: string; relativePath: string } | undefined
  private disposed = false

  constructor(options: FfmpegAlarmRecorderOptions) {
    this.options = options
    this.spawnImpl = options.spawnImpl ?? spawnFfmpeg
    this.existsImpl = options.exists ?? defaultExists
    this.now = options.now ?? (() => Date.now())
  }

  isBusy(): boolean {
    return this.active !== undefined
  }

  async record(request: LinkageRecordingRequest): Promise<LinkageActionOutcome> {
    if (this.disposed) {
      return { action: 'record', status: 'skipped', reason: '服务已释放', counted: true }
    }
    if (this.active) {
      // 相机侧的 RTSP 连接数是有限的（实测 `rtsp_client_limit: 10`），
      // 再开一路会把操作员自己的直播画面挤掉。
      return { action: 'record', status: 'skipped', reason: '已有一路联动录像在进行', counted: true }
    }

    const deviceId = request.trigger.identity.deviceId
    const source = this.options.resolveSource(deviceId)
    if (!source) {
      return {
        action: 'record',
        status: 'failed',
        reason: '当前没有可用的视频源（相机画面未在播放或 RTSP 未启用）',
        counted: true
      }
    }

    const canRecord = await this.options.storage.canRecord('alarm')
    if (!canRecord) {
      return {
        action: 'record',
        status: 'failed',
        reason: `磁盘剩余空间低于安全下限，已拒绝联动录像（${this.options.storage.root}）`,
        counted: true
      }
    }

    const device = this.options.resolveDevice(deviceId)
    const startedAt = this.now()
    const target = await this.pickFreePath(device.deviceUid || device.name, startedAt, device.name)
    await fs.mkdir(path.dirname(target.absolutePath), { recursive: true })

    let child: FfmpegProcess
    try {
      child = this.spawnImpl(
        buildAlarmRecordArgs(source.url, target.absolutePath, request.durationSeconds),
        { label: `alarm-record:${deviceId}` }
      )
    } catch (error) {
      // `spawnFfmpeg` 在 ffmpeg 缺失时抛 AppError——照原样带出，因为
      // 「内置转码组件不可用」是一句必须能被操作员看见的诊断。
      return {
        action: 'record',
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        counted: true
      }
    }

    const active = { deviceId, child, absolutePath: target.absolutePath, relativePath: target.relativePath }
    this.active = active

    const graceMs = (Math.max(1, request.durationSeconds) + 20) * 1000 + (this.options.exitGraceMs ?? 0)
    const exit = await waitForExit(child, graceMs)
    if (this.active === active) this.active = undefined

    if (exit.timedOut) {
      child.kill()
      await waitForExit(child, 5_000)
    }

    const probe = await probeMp4File(active.absolutePath)
    const endedAt = this.now()
    if (probe.size === 0 || !probe.playable) {
      // 0 字节或没有 `moov` 的文件绝不能被登记成录像：宁可少一条记录，
      // 也不要让操作员在列表里点开一个打不开的文件。
      await fs.unlink(active.absolutePath).catch(() => undefined)
      const tail = lastLine(child.stderrTail())
      return {
        action: 'record',
        status: 'failed',
        reason: probe.size === 0 ? '录像文件为空（0 字节），已删除' : `录像文件不完整（${probe.size} 字节），已删除`,
        detail: { stderr: tail, relativePath: active.relativePath },
        counted: true
      }
    }

    const recording = this.options.recordings.insertAlarmVideo({
      deviceId,
      startTime: startedAt,
      endTime: endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      relativePath: active.relativePath,
      fileSize: probe.size,
      eventType: LINKAGE_ALARM_VIDEO_EVENT_TYPE
    })

    deviceLog().info('联动录像已完成', {
      deviceId,
      eventId: request.trigger.identity.eventId,
      recordingId: recording.id,
      requestedSeconds: request.durationSeconds,
      durationMs: Math.max(0, endedAt - startedAt),
      fileSize: probe.size,
      ffmpegExit: exit.code
    })

    return {
      action: 'record',
      status: 'success',
      detail: {
        recordingId: recording.id,
        relativePath: recording.relativePath,
        durationMs: Math.max(0, endedAt - startedAt),
        fileSize: probe.size,
        requestedSeconds: request.durationSeconds
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const active = this.active
    this.active = undefined
    if (active) {
      // 与 `CameraCaptureService.abortAll` 同一个判断：一次没有正常收尾的
      // 录像，其时长与完整性都是未知的，登记它等于声称它是完整的。
      active.child.kill()
      void fs.unlink(active.absolutePath).catch(() => undefined)
      deviceLog().warn('联动录像在应用退出时被中止', { relativePath: active.relativePath })
    }
  }

  /** 同一毫秒内的第二次录像不覆盖第一次。 */
  private async pickFreePath(
    uid: string,
    timestamp: number,
    label: string
  ): Promise<{ absolutePath: string; relativePath: string }> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const candidate = this.options.storage.cameraMediaPaths({
        deviceUid: uid,
        kind: 'video',
        timestamp,
        label,
        attempt
      })
      if (!(await this.existsImpl(candidate.absolutePath))) return candidate
    }
    throw new Error('同一毫秒内同名文件过多，无法生成唯一的联动录像文件名')
  }
}

// ---------------------------------------------------------------------------
// 弹窗
// ---------------------------------------------------------------------------

/** 弹窗要显示的内容；文案由调用方（引擎）按目录键准备好。 */
export interface LinkagePopupRequest {
  /** 稳定 id，用于「关掉同一个事件的弹窗」与叠加上限。 */
  popupId: string
  /** 目录键 + 参数，**不是渲染好的文字**：弹窗窗口自己按当前语言渲染。 */
  messageKey: string
  params: Record<string, string>
  level: 'info' | 'warning' | 'critical'
  autoDismissSeconds: number
}

export interface LinkagePopupSink {
  /** 当前打开的弹窗数（诊断与测试用）。 */
  openCount(): number
  show(request: LinkagePopupRequest): Promise<LinkageActionOutcome>
  closeAll(): void
}

/** 什么都不做的实现；在没有 Electron 的环境（测试、headless）里用它。 */
export class NullPopupSink implements LinkagePopupSink {
  openCount(): number {
    return 0
  }
  async show(): Promise<LinkageActionOutcome> {
    return { action: 'popup', status: 'skipped', reason: '当前环境没有窗口实现', counted: false }
  }
  closeAll(): void {
    // 无窗口可关。
  }
}

/**
 * 弹窗页面。
 *
 * 刻意写成一段字符串而不是一个 Vue 组件：弹窗窗口不加载应用 shell
 * （那会带来第二个渲染进程、预加载脚本与一整套状态），而它要显示的东西只有
 * 一行标题、一台设备、一行说明。
 *
 * 脚本能力（2026-09-23 更新）：为右上角的 × 关闭钮开了一行内联脚本
 * （`window.close()`）。窗口仍然是 `sandbox: true` + 无 Node、无网络、内容
 * 是本地拼的静态字符串——放开的只是"点 × 能关上"这一件事。手动关闭的语义
 * 见 sink 的 `onManualClose`（关掉 = 这条告警算处理过）。
 *
 * `params.title` / `params.body` 由调用方按当前界面语言渲染好后传入——
 * 本函数不认识任何一份文案目录。
 */
export function renderPopupHtml(request: LinkagePopupRequest): string {
  const palette: Record<string, { bg: string; accent: string; text: string }> = {
    info: { bg: '#0f172a', accent: '#38bdf8', text: '#e2e8f0' },
    warning: { bg: '#1f1300', accent: '#f59e0b', text: '#fde68a' },
    critical: { bg: '#2a0a0a', accent: '#ef4444', text: '#fecaca' }
  }
  const colours = palette[request.level] ?? palette.warning ?? { bg: '#1f1300', accent: '#f59e0b', text: '#fde68a' }
  const title = escapeHtml(request.params.title ?? '')
  const body = escapeHtml(request.params.body ?? '')
  const device = escapeHtml(request.params.device ?? '')
  const dismissHint = escapeHtml(
    request.autoDismissSeconds > 0
      ? `本窗口将在 ${request.autoDismissSeconds} 秒后自动关闭`
      : '本窗口在应用关闭前保持显示'
  )

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>HAIS</title>
<style>
  html,body{margin:0;height:100%;background:${colours.bg};color:${colours.text};
    font-family:"Segoe UI",system-ui,sans-serif;-webkit-user-select:none;overflow:hidden}
  .wrap{display:flex;height:100%;box-sizing:border-box;padding:12px 14px;gap:12px;
    border-left:5px solid ${colours.accent};-webkit-app-region:drag}
  .icon{width:30px;height:30px;flex:none;border-radius:50%;background:${colours.accent};
    display:flex;align-items:center;justify-content:center;color:#0b1020;font-weight:700;font-size:17px}
  .main{min-width:0;flex:1}
  .title{font-size:13.5px;font-weight:600;margin:0 0 2px}
  .device{font-size:12px;opacity:.85;margin:0 0 4px}
  .body{font-size:12px;line-height:1.45;margin:0;word-break:break-word}
  .hint{font-size:10.5px;opacity:.6;margin:6px 0 0}
  /* 手动关闭（业主 2026-09-23：「直到用户处理，或手动关闭告警弹窗」）；
     右上角的 ×，关掉 = 这条告警算处理过（见 sink 的 onManualClose 接线）。 */
  .close{position:absolute;top:6px;right:8px;width:22px;height:22px;border:none;border-radius:6px;
    background:transparent;color:${colours.text};opacity:.65;font-size:14px;line-height:1;cursor:pointer;
    -webkit-app-region:no-drag}
  .close:hover{opacity:1;background:rgba(255,255,255,.12)}
</style></head>
<body><div class="wrap">
  <div class="icon">!</div>
  <div class="main">
    <p class="title">${title}</p>
    <p class="device">${device}</p>
    <p class="body">${body}</p>
    <p class="hint">${dismissHint}</p>
  </div>
</div>
<button class="close" id="close" title="×">×</button>
<script>document.getElementById('close').addEventListener('click',function(){window.close()})</script>
</body></html>`
}

/** 弹窗页面里插入的都是设备名/时刻这类外部字符串，一律转义。 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 弹窗的页面源（自定义协议）。
 *
 * 为什么不是 `data:` URL：主窗口的会话策略会对每个请求做一次判断，
 * 而一个 `data:` 页面在 Electron 里与「渲染层自己发起了一次导航」难以区分。
 * 用一个注册过的、只读的自定义协议，加载的是一个字符串，没有文件、没有网络，
 * 边界一眼可见。
 */
export const LINKAGE_POPUP_SCHEME = 'linkage-notify'

/** 必须在 `app.whenReady()` **之前**调用一次。 */
export function registerLinkagePopupScheme(): void {
  try {
    protocol.registerSchemesAsPrivileged([
      { scheme: LINKAGE_POPUP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } }
    ])
  } catch {
    // 重复注册会抛；这不是致命问题（弹窗退化为不显示，引擎仍会记日志）。
  }
}

export interface ElectronPopupSinkOptions {
  /** 上限：超出时关掉最旧的一个，绝不堆 50 个窗口。 */
  maxStack: () => number
  /** 组装页面 HTML；注入以便测试渲染什么。 */
  renderHtml: (request: LinkagePopupRequest) => string
  /**
   * 弹窗贴哪块屏幕（2026-09-23「弹窗定位」修复）：给主窗口的 bounds，
   * 弹窗出现在**主窗口所在那块屏**的右下角，而不是主屏——多屏工位上
   * 告警弹到另一台显示器等于没弹。缺省回落到主屏。
   */
  anchorBounds?: () => { x: number; y: number; width: number; height: number } | undefined
  /**
   * 用户**手动**关掉弹窗（点 ×）时回调（popupId = 事件 id）。
   * 自动消失（到点/被上限挤掉/应用退出）不触发——那不算用户处理了这条告警。
   */
  onManualClose?: (popupId: string) => void
}

/**
 * Electron 实现。
 *
 * ---------------------------------------------------------------------------
 * 三个「必须成立」的性质，以及各自是怎么做到的
 * ---------------------------------------------------------------------------
 * 1. **不抢键盘焦点。** `focusable: false` + `showInactive()`。
 *    `alwaysOnTop` 只影响层叠顺序，`focusable: false` 才是不打断操作员录入的
 *    那一条；不用 `win.show()`（它会激活窗口）。
 * 2. **可关闭。** 窗口按 `autoDismissSeconds` 自动消失，页面上有一句如实说明；
 *    主进程也可以随时 `destroy()`（`closeAll()`）。
 * 3. **不堆栈。** `maxStack` 上限 + 同一 `popupId` 复用（同一事件的第二次通知
 *    不新建窗口，只刷新内容）。
 */
export class ElectronPopupSink implements LinkagePopupSink {
  private readonly options: ElectronPopupSinkOptions
  private readonly windows = new Map<string, BrowserWindow>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private htmlByRequest = new Map<string, string>()
  /** 由定时器/上限/应用退出主动关掉的窗口：它们的 closed 不是「用户处理了」。 */
  private readonly autoClosed = new Set<string>()

  constructor(options: ElectronPopupSinkOptions) {
    this.options = options
    // 协议回调只服务本进程内已知的弹窗内容：请求的路径就是弹窗 id。
    protocol.handle(LINKAGE_POPUP_SCHEME, async (request) => {
      const id = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''))
      const html = this.htmlByRequest.get(id)
      if (html === undefined) {
        return new Response('<!doctype html><title>gone</title>', {
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
      }
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
  }

  openCount(): number {
    return this.windows.size
  }

  async show(request: LinkagePopupRequest): Promise<LinkageActionOutcome> {
    try {
      const existing = this.windows.get(request.popupId)
      if (existing && !existing.isDestroyed()) {
        // 同一个事件的重复通知：刷新内容而不是再开一个窗口。
        this.htmlByRequest.set(request.popupId, this.options.renderHtml(request))
        existing.loadURL(this.urlFor(request.popupId))
        this.armAutoDismiss(request)
        return { action: 'popup', status: 'success', detail: { reused: true, popupId: request.popupId } }
      }

      this.enforceStackLimit()

      const window = new BrowserWindow({
        width: 420,
        height: 148,
        show: false,
        frame: false,
        resizable: false,
        movable: true,
        minimizable: false,
        maximizable: false,
        // 关键之一：不可获得键盘焦点，因此不会打断操作员正在输入的文本框。
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        // 出现在**主窗口所在那块屏**的右下角：多屏工位上弹到主屏等于没弹。
        ...this.bottomRightPosition(420, 148),
        webPreferences: {
          // 弹窗页面只有内联 CSS + 一行「× 关闭」的内联脚本（2026-09-23 起，
          // 见 renderPopupHtml 的头注释）：无 Node、无网络、无 preload 不变。
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })

      this.htmlByRequest.set(request.popupId, this.options.renderHtml(request))
      this.windows.set(request.popupId, window)

      // `showInactive` 显示但不激活——这是「不抢焦点」的另一半。
      window.once('ready-to-show', () => {
        if (!window.isDestroyed()) window.showInactive()
      })
      window.on('closed', () => {
        this.windows.delete(request.popupId)
        this.htmlByRequest.delete(request.popupId)
        const timer = this.timers.get(request.popupId)
        if (timer) clearTimeout(timer)
        this.timers.delete(request.popupId)
        // 用户点 × 关掉 = 这条告警算处理过；到点自动消失不算（见 onManualClose）。
        if (!this.autoClosed.delete(request.popupId)) this.options.onManualClose?.(request.popupId)
      })

      await window.loadURL(this.urlFor(request.popupId))
      this.armAutoDismiss(request)

      return {
        action: 'popup',
        status: 'success',
        detail: { popupId: request.popupId, openWindows: this.windows.size }
      }
    } catch (error) {
      // 弹窗失败**绝不能**影响录像或邮件：这里把原因带出去，由引擎记日志。
      return {
        action: 'popup',
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        counted: true
      }
    }
  }

  closeAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const [id, window] of this.windows) {
      this.autoClosed.add(id)
      try {
        window.destroy()
      } catch {
        // 已经关掉了。
      }
    }
    this.windows.clear()
    this.htmlByRequest.clear()
  }

  private urlFor(popupId: string): string {
    return `${LINKAGE_POPUP_SCHEME}://popup/${encodeURIComponent(popupId)}`
  }

  /** 关掉最旧的窗口直到数量低于上限。 */
  private enforceStackLimit(): void {
    const limit = Math.max(1, this.options.maxStack())
    while (this.windows.size >= limit) {
      const oldest = this.windows.keys().next()
      if (oldest.done) return
      const window = this.windows.get(oldest.value)
      this.windows.delete(oldest.value)
      this.htmlByRequest.delete(oldest.value)
      const timer = this.timers.get(oldest.value)
      if (timer) clearTimeout(timer)
      this.timers.delete(oldest.value)
      this.autoClosed.add(oldest.value)
      try {
        window?.destroy()
      } catch {
        // 已经关掉了。
      }
    }
  }

  private armAutoDismiss(request: LinkagePopupRequest): void {
    const existing = this.timers.get(request.popupId)
    if (existing) clearTimeout(existing)
    if (request.autoDismissSeconds <= 0) return
    const timer = setTimeout(() => {
      this.timers.delete(request.popupId)
      const window = this.windows.get(request.popupId)
      this.windows.delete(request.popupId)
      this.htmlByRequest.delete(request.popupId)
      this.autoClosed.add(request.popupId)
      try {
        window?.destroy()
      } catch {
        // 已经关掉了。
      }
    }, request.autoDismissSeconds * 1000)
    // 一个待决的定时器不该把进程留住。
    timer.unref?.()
    this.timers.set(request.popupId, timer)
  }

  /** 主窗口所在屏幕的右下角；拿不到屏幕信息时回落到默认位置。 */
  private bottomRightPosition(width: number, height: number): { x?: number; y?: number } {
    try {
      const anchor = this.options.anchorBounds?.()
      const display = anchor
        ? screen.getDisplayMatching(anchor).workArea
        : screen.getPrimaryDisplay().workArea
      return {
        x: Math.max(0, display.x + display.width - width - 16),
        y: Math.max(0, display.y + display.height - height - 16)
      }
    } catch {
      return {}
    }
  }
}

// ---------------------------------------------------------------------------
// 抓帧（邮件附件）
// ---------------------------------------------------------------------------

export interface LinkageFrameCapture {
  /**
   * 取一帧 JPEG 写到存储根，返回相对路径。
   * 失败以 `ActionOutcome` 返回，**不抛异常**。
   */
  capture(
    deviceId: string,
    deviceName: string,
    eventId: string
  ): Promise<LinkageActionOutcome>
}

export interface FfmpegFrameCaptureOptions {
  storage: StorageService
  resolveSource: (deviceId: string) => LinkageRecorderSource | undefined
  resolveDevice: (deviceId: string) => { deviceUid: string; name: string }
  spawnImpl?: typeof spawnFfmpeg
  exists?: (absolutePath: string) => Promise<boolean>
  now?: () => number
  waitMs?: number
}

/** 抓帧：从 RTSP 取一帧 JPEG。参数与手动抓图一致（`-frames:v 1 -q:v 2`）。 */
export function buildAlarmSnapshotArgs(rtspUrl: string, filePath: string): string[] {
  return ['-rtsp_transport', 'tcp', '-i', rtspUrl, '-frames:v', '1', '-q:v', '2', '-f', 'image2', '-y', filePath]
}

export class FfmpegFrameCapture implements LinkageFrameCapture {
  private readonly options: FfmpegFrameCaptureOptions
  private readonly spawnImpl: typeof spawnFfmpeg
  private readonly existsImpl: (absolutePath: string) => Promise<boolean>
  private readonly now: () => number
  /**
   * 串行化。
   *
   * 抓帧与联动录像都可能在同一时刻要一路 RTSP。相机实测 `rtsp_client_limit: 10`，
   * 而这个上限是**全局**的；把本进程自己发起的抓帧排成队列，
   * 是唯一能保证「一次告警风暴不会把相机的连接数吃光」的地方。
   */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: FfmpegFrameCaptureOptions) {
    this.options = options
    this.spawnImpl = options.spawnImpl ?? spawnFfmpeg
    this.existsImpl = options.exists ?? defaultExists
    this.now = options.now ?? (() => Date.now())
  }

  capture(deviceId: string, deviceName: string, eventId: string): Promise<LinkageActionOutcome> {
    const run = this.chain.then(() => this.captureNow(deviceId, deviceName, eventId))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async captureNow(
    deviceId: string,
    deviceName: string,
    eventId: string
  ): Promise<LinkageActionOutcome> {
    const source = this.options.resolveSource(deviceId)
    if (!source) {
      return {
        action: 'email',
        status: 'skipped',
        reason: '没有可用的视频源，本封邮件不带附件',
        counted: false
      }
    }

    const device = this.options.resolveDevice(deviceId)
    const timestamp = this.now()
    const target = await this.pickFreePath(device.deviceUid || deviceName, timestamp, deviceName)
    await fs.mkdir(path.dirname(target.absolutePath), { recursive: true })

    let child: FfmpegProcess
    try {
      child = this.spawnImpl(buildAlarmSnapshotArgs(source.url, target.absolutePath), {
        label: `alarm-frame:${deviceId}`
      })
    } catch (error) {
      return {
        action: 'email',
        status: 'skipped',
        reason: error instanceof Error ? error.message : String(error),
        counted: false
      }
    }

    const exit = await waitForExit(child, this.options.waitMs ?? 15_000)
    if (exit.timedOut) {
      child.kill()
      await waitForExit(child, 3_000)
    }

    const probe = await probeJpegFile(target.absolutePath)
    if (!probe.complete) {
      await fs.unlink(target.absolutePath).catch(() => undefined)
      return {
        action: 'email',
        status: 'skipped',
        reason: `未能抓到画面（ffmpeg ${exit.code ?? 'signal'}）：${lastLine(child.stderrTail()) || '没有图像数据'}`,
        counted: false
      }
    }

    deviceLog().info('联动抓帧已保存', { deviceId, eventId, relativePath: target.relativePath, bytes: probe.size })
    return {
      action: 'email',
      status: 'success',
      detail: { frameRelativePath: target.relativePath, frameBytes: probe.size }
    }
  }

  private async pickFreePath(
    uid: string,
    timestamp: number,
    label: string
  ): Promise<{ absolutePath: string; relativePath: string }> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const candidate = this.options.storage.cameraMediaPaths({
        deviceUid: uid,
        kind: 'snapshot',
        timestamp,
        label,
        attempt
      })
      if (!(await this.existsImpl(candidate.absolutePath))) return candidate
    }
    throw new Error('同一毫秒内同名文件过多，无法生成唯一的抓帧文件名')
  }
}

// ---------------------------------------------------------------------------
// 邮件
// ---------------------------------------------------------------------------

export interface LinkageSmtpConfig {
  host: string
  port: number
  security: LinkageSmtpSecurity
  username: string
  /** 已从凭据库解出的口令；空串表示匿名投递。 */
  password: string
  from: string
  recipients: string
  subjectTemplate: string
  bodyTemplate: string
  attachFrame: boolean
}

/** 一轮动作开始时的配置快照（`null` = 引擎关闭或无收件人）。 */
export interface LinkageEmailContext {
  config: LinkageSmtpConfig
  /** 抓帧的相对路径；没有时邮件不带附件。 */
  frameRelativePath?: string
  /** SMTP 的原始失败详情（附件读取失败等），用于最终诊断。 */
  detail?: string
}

export interface LinkageEmailSender {
  /**
   * 发信。`context` 为 `null` 表示本封不该发（引擎会以 `skipped` 记之）。
   * 失败以 `ActionOutcome` 返回，**不抛异常**。
   */
  send(trigger: LinkageTrigger, context: LinkageEmailContext | null): Promise<LinkageActionOutcome>
}

/** 可注入的 SMTP 传输；生产用 `SmtpClient`，测试用 stub 或假实现。 */
export type SmtpTransportFactory = (options: {
  host: string
  port: number
  security: LinkageSmtpSecurity
  username: string
  password: string
}) => { send(message: LinkageEmailMessage): Promise<LinkageEmailSendResult> }

export interface SmtpLinkageEmailSenderOptions {
  /** 读取文件（附件用）；注入以便测试不必真的写盘。 */
  readFile: (relativePath: string) => Promise<Uint8Array>
  /** 存储根，用于把相对路径变成绝对路径。 */
  resolveAbsolute?: (relativePath: string) => string
  transportFactory?: SmtpTransportFactory
}

/** 模板占位符展开。纯函数，测试直接断言。 */
export function expandTemplate(
  template: string,
  values: Record<string, string>
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/**
 * SMTP 实现。
 *
 * 「邮件要带抓帧附件」是 iVMS-4200 的做法，也是这封邮件有用的原因——一封
 * 只说「有告警」的邮件，操作员还得回去翻录像。抓帧读不到时**照发**，
 * 但在结果里说明「本封不带附件」，不静默降级。
 */
export class SmtpLinkageEmailSender implements LinkageEmailSender {
  private readonly options: SmtpLinkageEmailSenderOptions
  private readonly transportFactory: SmtpTransportFactory

  constructor(options: SmtpLinkageEmailSenderOptions) {
    this.options = options
    this.transportFactory =
      options.transportFactory ??
      ((transport) =>
        new SmtpClient({
          host: transport.host,
          port: transport.port,
          security: transport.security,
          username: transport.username,
          password: transport.password
        }))
  }

  async send(trigger: LinkageTrigger, context: LinkageEmailContext | null): Promise<LinkageActionOutcome> {
    if (!context) {
      return { action: 'email', status: 'skipped', reason: '未配置 SMTP 服务器或没有收件人', counted: false }
    }

    const { config } = context
    const recipients = parseRecipientList(config.recipients)
    if (recipients.length === 0) {
      return { action: 'email', status: 'skipped', reason: '收件人列表为空', counted: false }
    }

    const values: Record<string, string> = {
      device: trigger.deviceName,
      time: new Date(trigger.observedAt).toISOString(),
      count: '1',
      identity: trigger.identity.eventId
    }
    const message: LinkageEmailMessage = {
      from: config.from,
      to: recipients,
      subject: expandTemplate(config.subjectTemplate, values),
      text: expandTemplate(config.bodyTemplate, values)
    }

    let attachmentNote: string | undefined
    if (config.attachFrame && context.frameRelativePath) {
      try {
        const bytes = await this.options.readFile(context.frameRelativePath)
        message.attachment = {
          fileName: path.basename(context.frameRelativePath),
          contentType: 'image/jpeg',
          bytes
        }
      } catch (error) {
        attachmentNote = `附件读取失败：${error instanceof Error ? error.message : String(error)}`
      }
    } else if (config.attachFrame) {
      attachmentNote = '没有可用的抓帧，本封不带附件'
    }

    const transport = this.transportFactory({
      host: config.host,
      port: config.port,
      security: config.security,
      username: config.username,
      password: config.password
    })

    let result: LinkageEmailSendResult
    try {
      result = await transport.send(message)
    } catch (error) {
      return {
        action: 'email',
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        counted: true
      }
    }

    if (!result.ok) {
      // 绝不静默丢弃：原始回复与逐行 transcript 一起交给调用方写日志。
      return {
        action: 'email',
        status: 'failed',
        reason: result.error,
        detail: {
          smtpDetail: result.detail ?? '',
          transcript: result.transcript.slice(-12),
          ...(attachmentNote ? { attachment: attachmentNote } : {})
        },
        counted: true
      }
    }

    return {
      action: 'email',
      status: 'success',
      detail: {
        accepted: result.accepted,
        recipients: recipients.length,
        attached: message.attachment ? message.attachment.fileName : '',
        ...(attachmentNote ? { attachment: attachmentNote } : {})
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

async function defaultExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath)
    return true
  } catch {
    return false
  }
}

interface ExitResult {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
}

/** 等子进程退出；超时则杀并如实标记 `timedOut`。 */
async function waitForExit(child: FfmpegProcess, timeoutMs: number): Promise<ExitResult> {
  let timer: NodeJS.Timeout | undefined
  try {
    const outcome = await Promise.race([
      child.exited.then((value) => ({ ...value, timedOut: false as const })),
      new Promise<ExitResult>((resolve) => {
        timer = setTimeout(() => resolve({ code: null, signal: null, timedOut: true }), timeoutMs)
        timer.unref?.()
      })
    ])
    return outcome
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function lastLine(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  return lines[lines.length - 1]?.trim().slice(0, 200) ?? ''
}

/** 供测试与诊断：本模块导出的动作种类（防止有人加了动作忘了登记）。 */
export const LINKAGE_IMPLEMENTED_ACTIONS: readonly LinkageActionKind[] = [
  'record',
  'popup',
  'notice',
  'email'
]
