/**
 * 触发源 2（**加速器**）：`/detectFeedback` 帧（手册 §5.2.3）。
 *
 * ---------------------------------------------------------------------------
 * 它是加速器，不是主源，而且这个定位是**结构性**的
 * ---------------------------------------------------------------------------
 * 真机上从未观察到这条流的帧：
 *   - `shared/domain/fa371-stream.ts` 的 `FA371_STREAM_MEASURED` 记的 6 秒窗口 0 帧；
 *   - 2026-09-15 复测（`.probe-alarm2.cjs`，9 秒窗口、握手成功 `readyState=1`）
 *     仍然是 **0 帧**——同时那次探测证实了握手本身不需要认证，
 *     所以「设备根本不推」是结论，不是猜测。
 *
 * 因此这个源的设计目标只有一句话：**帧到达之前它什么都不做；帧到达之后，
 * 它不可能压制或重复一个轮询触发的事件。**
 *
 * 怎么保证后半句：
 *   1. 它产出的候选事件带的是**同一个事件身份**
 *      （`deviceId:logId:startTime`，与轮询源共用 `linkAgeEventIdentity`）；
 *   2. 引擎那一层的去重表是**唯一**的判定点，两个源都经过它。
 *      先到的动作，后到的被 `已处理过` 挡掉并记一条日志。
 * 所以「谁先谁后」不会改变结果，只会改变谁被记成发起者。
 *
 * 还有一条：**它不会自己去开流。** 相机流的起停归渲染层（`fa371-stream:start`），
 * 这个源只挂在 `Fa371StreamService` 的 `preview` 事件上被动接收。
 * 自己去开一路 socket 会与操作员的实时画面抢相机的连接数
 * （实测 `rtsp_client_limit: 10`，且 WS 每路一条连接）。
 */

import type { Device } from '@shared/domain/models'
import type { Fa371DetectLog } from '@shared/domain/fa371'
import type { Fa371DetectFeedbackPreview } from '@shared/domain/fa371-stream'
import { linkAgeEventIdentity, type LinkageTriggerSourceKind } from '@shared/domain/alarm-linkage'
import { deviceLog } from '../logging/logger'
import type { LinkageCandidate, LinkageTriggerSource } from './alarm-linkage-engine'

/** 只依赖 `on`/`off` 的最小事件源接口，方便测试直接喂帧。 */
export interface DetectFeedbackEventSource {
  on(event: 'preview', listener: (preview: unknown) => void): unknown
  off?(event: 'preview', listener: (preview: unknown) => void): unknown
  removeListener?(event: 'preview', listener: (preview: unknown) => void): unknown
}

export interface DetectFeedbackSourceOptions {
  streams: DetectFeedbackEventSource
  /** 参与观察的设备；用于把 deviceId 解析成显示名。 */
  devices: () => Array<Pick<Device, 'id' | 'name' | 'kind'>>
  now?: () => number
}

export class DetectFeedbackTriggerSource implements LinkageTriggerSource {
  readonly kind: LinkageTriggerSourceKind = 'websocket'

  private readonly options: DetectFeedbackSourceOptions
  private readonly listeners = new Set<(candidate: LinkageCandidate) => void>()
  private bound: ((preview: unknown) => void) | undefined
  private frames = 0
  private triggers = 0
  private lastFrameAt: number | undefined
  private running = false

  constructor(options: DetectFeedbackSourceOptions) {
    this.options = options
  }

  get deviceIds(): readonly string[] {
    return this.options.devices()
      .filter((device) => device.kind === 'acousticCamera')
      .map((device) => device.id)
  }

  onCandidate(listener: (candidate: LinkageCandidate) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.bound = (preview: unknown) => this.onPreview(preview)
    this.options.streams.on('preview', this.bound)
    deviceLog().info('FA371 /detectFeedback 加速器已挂载（未收到帧之前不做任何事）')
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    if (!this.bound) return
    const source = this.options.streams
    if (typeof source.off === 'function') source.off('preview', this.bound)
    else if (typeof source.removeListener === 'function') source.removeListener('preview', this.bound)
    this.bound = undefined
  }

  status(): { lastPollAt?: number; lastError?: string; triggers: number; frames: number; running: boolean } {
    const status: { lastPollAt?: number; lastError?: string; triggers: number; frames: number; running: boolean } = {
      triggers: this.triggers,
      // `frames: 0` 是一个**结论**而不是缺失：设置页照着它说明「该流至今没有帧」。
      frames: this.frames,
      running: this.running
    }
    if (this.lastFrameAt !== undefined) status.lastPollAt = this.lastFrameAt
    return status
  }

  /**
   * 收到一帧。
   *
   * 只有 `kind === 'detectFeedback'` 的预览会被处理；其余四路虽然也走同一个
   * `preview` 事件，但在这里被直接忽略，**不产生任何开销**（除了一个字符串比较）。
   */
  onPreview(preview: unknown): void {
    if (!isDetectFeedbackPreview(preview)) return
    this.frames += 1
    const now = (this.options.now ?? (() => Date.now()))()
    this.lastFrameAt = now
    deviceLog().info('FA371 /detectFeedback 收到帧（历史上首次出现即在此记录）', {
      deviceId: preview.deviceId,
      logs: preview.logs.length,
      rawRet: preview.rawRet ?? null
    })

    const device = this.options.devices().find((item) => item.id === preview.deviceId)
    if (!device) {
      // 一帧来自一台已经不在列表里的设备：忽略并说明，绝不拿 deviceId 当显示名。
      deviceLog().warn('FA371 /detectFeedback 帧来自未知设备，已忽略', { deviceId: preview.deviceId })
      return
    }

    for (const log of preview.logs) {
      const candidate = toWebSocketCandidate(device, log, now)
      if (!candidate) continue
      this.triggers += 1
      for (const listener of this.listeners) listener(candidate)
    }
  }
}

/**
 * 由一帧里的日志产出候选事件。
 *
 * 没有 `id` 的日志返回 `undefined`：身份会退化成 `deviceId:-:<start>`，
 * 两条同秒内没有编号的日志会撞成同一个事件（漏报一次），
 * 或者反过来在 `start_time` 也缺失时撞成完全相同的身份（漏报所有）。
 * 与其猜，不如不报——轮询源那边同样会跳过这类日志，两条路径行为一致。
 */
export function toWebSocketCandidate(
  device: Pick<Device, 'id' | 'name'>,
  log: Fa371DetectLog,
  observedAt: number
): LinkageCandidate | undefined {
  if (typeof log.id !== 'number' || !Number.isFinite(log.id)) return undefined

  const candidate: LinkageCandidate = {
    source: 'websocket',
    deviceId: device.id,
    deviceName: device.name,
    identity: linkAgeEventIdentity(device.id, log.id, log.startTimeRaw),
    at:
      log.startTime !== undefined
        ? log.startTime
        : log.startTimeRaw !== undefined
          ? log.startTimeRaw * 1000
          : observedAt,
    observedAt
  }
  if (log.isAlarm !== undefined) candidate.alarmFlag = log.isAlarm
  if (log.alarmLevelRaw !== undefined) candidate.alarmLevelRaw = log.alarmLevelRaw
  if (log.alarmStrategyId !== undefined) candidate.strategyId = log.alarmStrategyId

  const metrics: { soundmapIntensity?: number; leakVolume?: number } = {}
  if (log.soundmapIntensity !== undefined) metrics.soundmapIntensity = log.soundmapIntensity
  if (log.leakVolume !== undefined) metrics.leakVolume = log.leakVolume
  if (Object.keys(metrics).length > 0) candidate.metrics = metrics

  return candidate
}

/** 结构判据，而不是 `instanceof`：预览对象过 IPC 之后不再是同一份原型链。 */
function isDetectFeedbackPreview(value: unknown): value is Fa371DetectFeedbackPreview {
  if (value === null || typeof value !== 'object') return false
  const preview = value as Partial<Fa371DetectFeedbackPreview>
  return (
    preview.kind === 'detectFeedback' &&
    typeof preview.deviceId === 'string' &&
    Array.isArray(preview.logs)
  )
}
