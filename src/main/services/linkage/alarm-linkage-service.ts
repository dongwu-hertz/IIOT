/**
 * `AlarmLinkageService` —— 告警联动的**组合根**（进程内的门面）。
 *
 * 它做四件事，每一件都只在一处：
 *   1. 把设置表里的配置、DPAPI 凭据库里的 SMTP 口令、四个动作的实现、
 *      两个触发源拼成一个 `AlarmLinkageEngine`；
 *   2. 订阅设备列表变化，让触发源跟着设备增删走；
 *   3. 给 IPC 层提供 `status / pending / acknowledge / testEmail` 四个能力；
 *   4. 在待处理列表变化时把快照推给渲染层（「提示」能在导航后仍然可见的实现点）。
 *
 * 引擎**默认开启**（业主 2026-09-23：相机告警默认弹窗 + 提示音），四个本地动作
 * （录像/弹窗/提示）随之默认可用；**邮件仍然默认关闭**——装完就往外发邮件是缺陷。
 * 用户在设置页关掉总开关后，保存的值优先于出厂默认。
 */

import { EventEmitter } from 'node:events'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { BrowserWindow } from 'electron'
import type {
  LinkageEngineStatus,
  LinkageTestEmailInput,
  LinkageTestEmailResult,
  PendingAlarmSnapshot
} from '@shared/domain/alarm-linkage'
import { parseRecipientList } from '@shared/domain/alarm-linkage'
import { AppError, ErrorCodes } from '@shared/errors'
import { appLog, deviceLog } from '../logging/logger'
import { AlarmLinkageEngine, type LinkageTriggerSource } from './alarm-linkage-engine'
import { DetectLogsPollSource, type PollCursorStore, type DetectLogsPollSourceOptions } from './detect-logs-poll-source'
import { DetectFeedbackTriggerSource, type DetectFeedbackEventSource, type DetectFeedbackSourceOptions } from './detect-feedback-source'
import { PendingAlarmStore } from './pending-alarm-store'
import { CameraPushAlarmSource } from './camera-push-source'
import { listLocalAddresses } from '../ingest/local-addresses'
import { FilePollCursorStore } from './poll-cursor-store'
import { SmtpClient, explainSmtpFailure } from './smtp-client'
import {
  ElectronPopupSink,
  FfmpegAlarmRecorder,
  FfmpegFrameCapture,
  SmtpLinkageEmailSender,
  renderPopupHtml,
  type LinkageEmailSender,
  type LinkageFrameCapture,
  type LinkagePopupSink,
  type LinkageRecorder,
  type LinkageRecorderSource
} from './linkage-actions'
import type { CameraCaptureSource } from '../media/camera-capture'
import type { StorageService } from '../storage/storage-service'
import type { RecordingRepository } from '../database/alarm-repository'
import type { DeviceService } from '../device/device-service'
import type { SettingsService } from '../settings/settings-service'

/** 设置表里存 SMTP 口令的凭据项 id（与设备口令共用同一个 DPAPI 存储）。 */
export const SMTP_SECRET_ID = 'smtp'

/** 与 `CredentialStore` 形状兼容的最小接口；只用到 get/set/delete。 */
export interface LinkageSecretStore {
  set(key: string, value: { username: string; password: string }): void
  get(key: string): { username: string; password: string } | undefined
  delete(key: string): void
}

export interface AlarmLinkageServiceOptions {
  settings: SettingsService
  secrets: LinkageSecretStore
  /** 应用数据目录（游标与待处理列表写在 `<dir>/linkage/` 下）。 */
  userDataDir: string
  storage: StorageService
  recordings: RecordingRepository
  devices: DeviceService
  /** 当前可用的 RTSP 源（含口令），由 `RtspStreamService.currentSource()` 提供。 */
  resolveSource: (deviceId: string) => CameraCaptureSource | undefined
  /** 相机数据流服务；`/detectFeedback` 加速器挂在它上面。 */
  streamEvents: DetectFeedbackEventSource
  /**
   * 弹窗文案解析器：目录键 + 参数 -> 当前界面语言的文本。
   *
   * 语言是渲染层的状态，主进程不该猜，所以这里由组合根注入；
   * 注入不了的时候退化为一段中性文本（弹窗仍然出现，只是不翻译）。
   */
  text?: (key: string, params: Record<string, string>) => string
  /** 触发源可注入（测试用假实现）。 */
  createPollSource?: (options: DetectLogsPollSourceOptions) => LinkageTriggerSource
  createFeedbackSource?: (options: DetectFeedbackSourceOptions) => LinkageTriggerSource
  /** 动作实现可注入（测试用假实现）。 */
  recorder?: LinkageRecorder
  popup?: LinkagePopupSink
  email?: LinkageEmailSender
  frameCapture?: LinkageFrameCapture
}

export class AlarmLinkageService extends EventEmitter {
  private readonly options: AlarmLinkageServiceOptions
  private readonly pending: PendingAlarmStore
  private readonly engine: AlarmLinkageEngine
  private readonly pollSource: LinkageTriggerSource
  private readonly feedbackSource: LinkageTriggerSource
  private readonly pushSource: CameraPushAlarmSource
  private readonly cursors: PollCursorStore
  private readonly recorder: LinkageRecorder
  private readonly popup: LinkagePopupSink
  private readonly email: LinkageEmailSender
  private readonly frameCapture: LinkageFrameCapture
  private started = false
  private readonly unsubscribeSettings: () => void
  private readonly unsubscribeDevices: () => void
  private readonly unsubscribePending: () => void
  /** 主窗口位置的晚绑定来源（`setMainWindowProvider`；弹窗定位用，见 `anchorBounds`）。 */
  private mainWindowProvider?: () => BrowserWindow | undefined

  /** 弹窗要贴在主窗口所在那块屏（多屏工位）：主进程在窗口建好之后注入一次。 */
  setMainWindowProvider(provider: () => BrowserWindow | undefined): void {
    this.mainWindowProvider = provider
  }

  constructor(options: AlarmLinkageServiceOptions) {
    super()
    this.options = options
    this.pending = new PendingAlarmStore({
      directory: options.userDataDir,
      capacity: () => options.settings.get().alarmLinkage.notices.pendingCapacity
    })

    this.recorder =
      options.recorder ??
      new FfmpegAlarmRecorder({
        storage: options.storage,
        recordings: options.recordings,
        resolveSource: (deviceId) => toRecorderSource(options.resolveSource(deviceId)),
        resolveDevice: (deviceId) => {
          const device = options.devices.get(deviceId)
          return { deviceUid: device.deviceUid, name: device.name }
        }
      })

    this.popup =
      options.popup ??
      new ElectronPopupSink({
        maxStack: () => options.settings.get().alarmLinkage.popup.maxStack,
        renderHtml: renderPopupHtml,
        // 主窗口的位置晚绑定（弹窗弹出时才读）：服务建好的时候窗口可能还没建。
        anchorBounds: () => this.mainWindowProvider?.()?.getBounds(),
        // 用户点 × 手动关掉 = 这条告警算处理过（业主 2026-09-23：「直到用户处理，
        // 或手动关闭告警弹窗」）；确认动作会顺带把提示音循环停掉。
        onManualClose: (popupId) => {
          this.acknowledge([popupId])
        }
      })

    this.frameCapture =
      options.frameCapture ??
      new FfmpegFrameCapture({
        storage: options.storage,
        resolveSource: (deviceId) => toRecorderSource(options.resolveSource(deviceId)),
        resolveDevice: (deviceId) => {
          const device = options.devices.get(deviceId)
          return { deviceUid: device.deviceUid, name: device.name }
        }
      })

    const frameCapture = this.frameCapture
    this.email =
      options.email ??
      new SmtpLinkageEmailSender({
        readFile: async (relativePath: string) => this.readFrameBytes(relativePath)
      })

    this.cursors = new FilePollCursorStore(options.userDataDir)

    this.engine = new AlarmLinkageEngine({
      config: () => options.settings.get().alarmLinkage,
      recorder: this.recorder,
      popup: this.popup,
      email: this.email,
      pending: this.pending,
      captureFrame: async (trigger) => {
        if (!options.settings.get().alarmLinkage.actions.email) return undefined
        const outcome = await frameCapture.capture(
          trigger.identity.deviceId,
          trigger.deviceName,
          trigger.identity.eventId
        )
        if (outcome.status === 'success' && typeof outcome.detail?.frameRelativePath === 'string') {
          return outcome.detail.frameRelativePath
        }
        if (outcome.reason) {
          appLog().warn('告警联动抓帧未成功，本封邮件不带附件', {
            eventId: trigger.identity.eventId,
            reason: outcome.reason
          })
        }
        return undefined
      },
      passwordFor: () => this.smtpPassword(),
      ...(options.text ? { text: options.text } : {})
    })

    const pollOptions: DetectLogsPollSourceOptions = {
      devices: () =>
        options.devices.list().map((device) => ({ id: device.id, name: device.name, kind: device.kind })),
      fetchLogs: (deviceId: string) => options.devices.cameraDetectLogs(deviceId),
      intervalMs: () => options.settings.get().alarmLinkage.pollIntervalSeconds * 1000,
      cursors: this.cursors
    }
    this.pollSource = options.createPollSource
      ? options.createPollSource(pollOptions)
      : new DetectLogsPollSource(pollOptions)

    const feedbackOptions: DetectFeedbackSourceOptions = {
      streams: options.streamEvents,
      devices: () =>
        options.devices.list().map((device) => ({ id: device.id, name: device.name, kind: device.kind }))
    }
    this.feedbackSource = options.createFeedbackSource
      ? options.createFeedbackSource(feedbackOptions)
      : new DetectFeedbackTriggerSource(feedbackOptions)

    /**
     * 触发源 3：相机主动 HTTP 推送（手册「Alarm push」；`/push_config` 实测 2026-09-24）。
     * 监听由这个源自己持有（默认关，设置页「相机告警推送」打开才监听）；
     * 打开时 `applyCameraPush()` 把各相机的 push_url 写到本机监听地址（写后读回）。
     */
    this.pushSource = new CameraPushAlarmSource({
      devices: () =>
        options.devices.list().map((device) => ({ id: device.id, name: device.name, kind: device.kind })),
      resolveDeviceBySecret: (secret) => options.devices.deviceByPushSecret(secret),
      port: () => options.settings.get().alarmLinkage.cameraPush.port,
      enabled: () => options.settings.get().alarmLinkage.cameraPush.enabled
    })

    // 待处理列表的任何变化都推一次快照；`main/index.ts` 转发到渲染层。
    this.unsubscribePending = this.pending.onChange((snapshot) => this.emit('pending', snapshot))
    options.settings.on('changed', this.handleSettingsChanged)
    this.unsubscribeSettings = () => options.settings.off('changed', this.handleSettingsChanged)
    options.devices.on('status', this.handleDevicesChanged)
    this.unsubscribeDevices = () => options.devices.off('status', this.handleDevicesChanged)
  }

  /**
   * 启动：注册两个触发源并按配置决定是否真的连出去。
   *
   * 幂等——`start()` 被调用两次不会产生第二条定时器或第二个 socket。
   */
  start(): void {
    if (this.started) return
    this.started = true
    void this.pending.load()
    this.engine.registerSource(this.pollSource)
    this.engine.registerSource(this.feedbackSource)
    this.engine.registerSource(this.pushSource)
    this.engine.applyConfig()
    void this.applyCameraPush()
    const config = this.options.settings.get().alarmLinkage
    appLog().info('告警联动服务已就绪', {
      enabled: config.enabled,
      pollIntervalSeconds: config.pollIntervalSeconds,
      actions: config.actions,
      sources: [this.pollSource.kind, this.feedbackSource.kind, this.pushSource.kind]
    })
  }

  status(): LinkageEngineStatus {
    return this.engine.status()
  }

  pendingSnapshot(): PendingAlarmSnapshot {
    return this.pending.snapshot()
  }

  /** 确认待处理告警；`ids` 为空表示全部。返回确认后的快照。 */
  acknowledge(ids: readonly string[]): PendingAlarmSnapshot {
    this.pending.acknowledge(ids, true)
    return this.pending.snapshot()
  }

  /**
   * 立刻轮询一轮。
   *
   * 存在的理由有两个：设置页的「立即检查」按钮，以及端到端验证脚本
   * （不必等一个轮询周期就能看到事件是否被识别）。
   */
  async pollNow(): Promise<void> {
    if (this.pollSource instanceof DetectLogsPollSource) await this.pollSource.tickAll()
  }

  /** 从 DPAPI 凭据库读 SMTP 口令。没有存过就是 undefined。 */
  smtpPassword(): string | undefined {
    const secret = this.options.secrets.get(SMTP_SECRET_ID)
    return secret && secret.password !== '' ? secret.password : undefined
  }

  /** 保存（或清除）SMTP 口令。空串 = 清除。 */
  setSmtpPassword(password: string): void {
    if (password === '') {
      this.options.secrets.delete(SMTP_SECRET_ID)
      return
    }
    this.options.secrets.set(SMTP_SECRET_ID, {
      username: this.options.settings.get().alarmLinkage.email.username,
      password
    })
  }

  smtpPasswordStored(): boolean {
    return this.smtpPassword() !== undefined
  }

  /**
   * 发一封测试邮件。
   *
   * 与真实告警走**同一个** `SmtpClient`、同一套附件编码，唯一的区别是内容来自
   * 设置页的表单。失败时把 SMTP 的原始回复与逐行 transcript 一起返回——
   * 「发送失败」这四个字对排查毫无帮助（任务明确要求不得静默丢弃失败）。
   */
  async testEmail(input: LinkageTestEmailInput): Promise<LinkageTestEmailResult> {
    const recipients = parseRecipientList(input.recipients)
    if (input.host.trim() === '') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'SMTP 服务器地址为空')
    }
    if (recipients.length === 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '收件人列表为空')
    }
    if (input.from.trim() === '') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '发件人地址为空')
    }

    const password =
      input.password !== undefined && input.password !== '' ? input.password : this.smtpPassword() ?? ''

    const attachment = await this.testAttachment(input)
    const client = new SmtpClient({
      host: input.host.trim(),
      port: input.port,
      security: input.security,
      username: input.username,
      password
    })

    const result = await client.send({
      from: input.from.trim(),
      to: recipients,
      subject: input.subject,
      text: input.body,
      ...(attachment ? { attachment } : {})
    })

    if (result.ok) {
      appLog().info('告警联动：测试邮件已发送', { host: input.host, recipients: recipients.length })
      return { ok: true, transcript: result.transcript }
    }

    appLog().warn('告警联动：测试邮件发送失败', {
      host: input.host,
      port: input.port,
      security: input.security,
      reason: result.error,
      detail: result.detail ?? '',
      transcript: result.transcript.slice(-12)
    })
    return {
      ok: false,
      error: explainSmtpFailure(result),
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
      transcript: result.transcript
    }
  }

  dispose(): void {
    this.unsubscribeSettings()
    this.unsubscribeDevices()
    this.unsubscribePending()
    this.engine.dispose()
    this.removeAllListeners()
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private readonly handleSettingsChanged = (): void => {
    this.engine.applyConfig()
    void this.applyCameraPush()
  }

  private readonly handleDevicesChanged = (): void => {
    this.engine.restartSources()
    void this.applyCameraPush()
  }

  // ---------------------------------------------------------------------------
  // 相机主动推送（「Alarm push」）的配置面：开关变化 / 设备增删时把各相机的
  // push_url 对齐到本机监听地址，写后读回验证（与其他设备写同一条规矩）。
  // ---------------------------------------------------------------------------

  /** 并发闸：设置连点两次不会有两个写流程同时在跑。 */
  private applyingCameraPush = false
  /** 我们写入过推送地址的相机（deviceId → 写进去的 URL）：关开关时只回退这些。 */
  private readonly cameraPushUrls = new Map<string, string>()

  private async applyCameraPush(): Promise<void> {
    if (this.applyingCameraPush) return
    this.applyingCameraPush = true
    try {
      const config = this.options.settings.get().alarmLinkage
      const active = config.enabled && config.cameraPush.enabled
      // 监听的开合跟开关走（source.start 幂等；stop 只在开着时有动作）。
      if (active) this.pushSource.start()
      else this.pushSource.stop()

      const cameras = this.options.devices.list().filter((device) => device.kind === 'acousticCamera')
      for (const device of cameras) {
        if (active) await this.enableCameraPush(device.id, config.cameraPush.port)
        else if (this.cameraPushUrls.has(device.id)) await this.disableCameraPush(device.id)
      }
    } finally {
      this.applyingCameraPush = false
    }
  }

  private async enableCameraPush(deviceId: string, port: number): Promise<void> {
    try {
      // 秘钥幂等（已有就返回已有的；没有就当场生成，写库+读回核对）。
      const endpoint = this.options.devices.ingestEndpoint(deviceId)
      const host = listLocalAddresses()[0]?.address
      if (!host) {
        deviceLog().warn('FA371 告警推送：本机没有可用的局域网地址，暂不写入相机', { deviceId })
        return
      }
      const url = `http://${host}:${port}/fa371-alarm/${endpoint.secret}`
      if (this.cameraPushUrls.get(deviceId) === url) return

      const client = this.options.devices.cameraAlarmOperations(deviceId)
      const current = await client.getPushConfig()
      await client.setPushConfig({
        push_enable: 1,
        push_url: url,
        // inter_* 一组语义手册未说明：原样保留设备上的值，不动它。
        inter_push_enable: current.inter_push_enable,
        inter_push_url: current.inter_push_url
      })
      // 读回验证：设备认了这个地址才记成"已配置"。
      const after = await client.getPushConfig()
      if (after.push_enable === 1 && after.push_url === url) {
        this.cameraPushUrls.set(deviceId, url)
        deviceLog().info('FA371 告警推送已指向本机', { deviceId, url })
      } else {
        deviceLog().warn('FA371 告警推送写入后读回不一致', {
          deviceId,
          wrote: url,
          readBack: after.push_url ?? null,
          readBackEnable: after.push_enable ?? null
        })
      }
    } catch (error) {
      deviceLog().warn('FA371 告警推送配置写入失败', {
        deviceId,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async disableCameraPush(deviceId: string): Promise<void> {
    this.cameraPushUrls.delete(deviceId)
    try {
      const client = this.options.devices.cameraAlarmOperations(deviceId)
      const current = await client.getPushConfig()
      await client.setPushConfig({
        push_enable: 0,
        push_url: '',
        inter_push_enable: current.inter_push_enable,
        inter_push_url: current.inter_push_url
      })
      deviceLog().info('FA371 告警推送已在相机侧关闭', { deviceId })
    } catch (error) {
      deviceLog().warn('FA371 告警推送关闭失败（相机侧可能仍指向本机）', {
        deviceId,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** 读存储根内的一帧（附件）。路径越界由 `StorageService.resolve` 拦住。 */
  private async readFrameBytes(relativePath: string): Promise<Uint8Array> {
    const absolute = this.options.storage.resolve(relativePath)
    return fs.readFile(absolute)
  }

  /** 测试邮件的附件：合成 PNG（验证编码）或取相机一帧（验证端到端）。 */
  private async testAttachment(
    input: LinkageTestEmailInput
  ): Promise<{ fileName: string; contentType: string; bytes: Uint8Array } | undefined> {
    if (input.attach === 'none') return undefined

    if (input.attach === 'synthetic') {
      return { fileName: 'linkage-test.png', contentType: 'image/png', bytes: SYNTHETIC_TEST_PNG }
    }

    if (!input.deviceId) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '选择「附带相机画面」时必须给出设备 ID')
    }
    const outcome = await this.frameCapture.capture(input.deviceId, input.deviceId, 'test-email')
    if (outcome.status !== 'success' || typeof outcome.detail?.frameRelativePath !== 'string') {
      throw new AppError(
        ErrorCodes.DEVICE_ERROR,
        outcome.reason ?? '未能抓取到画面，请先在监控页开始视频播放后重试'
      )
    }
    return {
      fileName: path.basename(outcome.detail.frameRelativePath),
      contentType: 'image/jpeg',
      bytes: await this.readFrameBytes(outcome.detail.frameRelativePath)
    }
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/**
 * 一个 1×1 的合法 PNG。
 *
 * 用途是让「测试邮件」可以在没有相机、没有实时画面的情况下**验证附件编码本身**
 * （base64 折行、Content-Disposition、multipart 边界）。它不落盘。
 */
export const SYNTHETIC_TEST_PNG: Uint8Array = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
  0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d,
  0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
])

function toRecorderSource(source: CameraCaptureSource | undefined): LinkageRecorderSource | undefined {
  if (!source) return undefined
  const result: LinkageRecorderSource = { url: source.url }
  if (source.candidateId !== undefined) result.candidateId = source.candidateId
  if (source.mode !== undefined) result.mode = source.mode
  return result
}
