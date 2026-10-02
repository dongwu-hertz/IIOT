/**
 * 触发源 3（**相机主动 HTTP 推送**，手册 V7.0「Alarm push」）。
 *
 * ---------------------------------------------------------------------------
 * 它是什么
 * ---------------------------------------------------------------------------
 * 相机配置了 `/push_config`（`push_enable` + `push_url`）之后，告警记录产生时
 * 设备**主动**把记录 JSON POST 过来——这是手册推荐的无人值守接收方式，
 * 「相机判定、软件接收」这条产品原则的最直接实现：判定结论（is_alarm、
 * alarm_level、detect_mode、放电类型）都是设备写好的，这里只负责收。
 *
 * 与另外两个源的关系不变：同一个事件身份（`deviceId:logId:startTime`），
 * 去重在引擎层。设备**也**会被轮询源看到同一条记录，谁先到谁触发。
 *
 * ---------------------------------------------------------------------------
 * 安全边界
 * ---------------------------------------------------------------------------
 * 这个源**自己**起 HTTP 监听（不经 IoT 接入服务）：
 *   - 只在设置页的「相机告警推送」打开时监听（默认关：默认开端口是缺陷）；
 *   - 路径里带每台相机的推流秘钥（`/fa371-alarm/<secret>`），秘钥不对 = 404，
 *     与 IoT 接入同一套"形状不对连 401 都不是"的口径；
 *   - 只收 POST + JSON，正文上限 64 KB（一条检测记录的字段远小于它）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Device } from '@shared/domain/models'
import { leakMetricsForMode, linkAgeEventIdentity, type LinkageTriggerSourceKind } from '@shared/domain/alarm-linkage'
import { mapDetectLog } from '../device/fa371/mappers'
import { resolveDischargeTypeKey } from '@shared/domain/fa371'
import { deviceLog } from '../logging/logger'
import type { LinkageCandidate, LinkageTriggerSource } from './alarm-linkage-engine'

/** 推送正文上限：一条检测记录的全部字段加起来远在 64 KB 以内。 */
const MAX_BODY_BYTES = 64 * 1024

export interface CameraPushSourceOptions {
  /** 参与接收的相机（每次请求重新读，设备增删立即生效）。 */
  devices: () => Array<Pick<Device, 'id' | 'name' | 'kind'>>
  /** 秘钥 → 设备（`DeviceRepository.findByPushSecret` 那一套）。 */
  resolveDeviceBySecret: (secret: string) => Device | undefined
  /** 监听端口（设置里改了就重启监听）。 */
  port: () => number
  /**
   * 「相机告警推送」开关（引擎总开关开、这个关着时**也不监听**——引擎只认总开关，
   * 而开不开端口是另一道独立的门：默认不在局域网开端口）。
   */
  enabled: () => boolean
  /** 时间源（测试用）。 */
  now?: () => number
}

export class CameraPushAlarmSource implements LinkageTriggerSource {
  readonly kind: LinkageTriggerSourceKind = 'push'

  private readonly options: CameraPushSourceOptions
  private readonly listeners = new Set<(candidate: LinkageCandidate) => void>()
  private server: Server | undefined
  private running = false
  private listeningPort = 0
  private triggers = 0
  private frames = 0
  private lastError: string | undefined

  constructor(options: CameraPushSourceOptions) {
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
    // 两道门：引擎总开关（谁调用 start）+「相机告警推送」开关（这里）。
    if (!this.options.enabled()) return
    const port = this.options.port()
    // 已经在听同一个端口：幂等早退。端口变了就重启监听。
    if (this.running && this.listeningPort === port) return
    this.stop()
    this.running = true
    this.lastError = undefined

    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    this.server = server
    server.on('error', (error: NodeJS.ErrnoException) => {
      this.lastError = error.message
      deviceLog().warn('FA371 告警推送：监听失败', { port, reason: error.message })
    })
    server.listen(port, () => {
      this.listeningPort = port
      deviceLog().info('FA371 告警推送：监听中', { port })
    })
  }

  stop(): void {
    this.running = false
    const server = this.server
    this.server = undefined
    if (!server) return
    server.closeAllConnections?.()
    server.close()
  }

  status(): { lastPollAt?: number; lastError?: string; triggers: number; frames: number; running: boolean } {
    const status: { lastError?: string; triggers: number; frames: number; running: boolean } = {
      triggers: this.triggers,
      frames: this.frames,
      running: this.running
    }
    if (this.lastError !== undefined) status.lastError = this.lastError
    return status
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const match = /^\/fa371-alarm\/([0-9a-f]{32})$/.exec(url.pathname)
    if (!match) {
      // 路径不对 = 配置问题，回 404 而不是 401（与 IoT 接入同一条理由）。
      respondJson(response, 404, { error: 'unknown-endpoint' })
      return
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST')
      respondJson(response, 405, { error: 'method-not-allowed' })
      return
    }
    const device = this.options.resolveDeviceBySecret(match[1] as string)
    if (!device || device.kind !== 'acousticCamera') {
      respondJson(response, 404, { error: 'unknown-endpoint' })
      return
    }

    const body = await readBody(request, MAX_BODY_BYTES)
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      respondJson(response, 400, { error: 'invalid-json' })
      return
    }

    /**
     * 推送载荷的形状手册没有给样例（V7.0 只说 "record data as JSON"）。
     * 防御式接纳三种合理形状：单条记录对象 / `{detect_logs:[...]}` / 数组；
     * 每条都过与轮询源同一个映射器（`mapDetectLog`），解析不出 id 的跳过
     * （没有 id 就没有事件身份，去重会撞车——宁可记日志，不硬造事件）。
     */
    const rawLogs = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { detect_logs?: unknown })?.detect_logs)
        ? (parsed as { detect_logs: unknown[] }).detect_logs
        : [parsed]

    const now = (this.options.now ?? (() => Date.now()))()
    let accepted = 0
    for (const raw of rawLogs) {
      const log = mapDetectLog(raw)
      if (typeof log.id !== 'number' || !Number.isFinite(log.id)) {
        deviceLog().warn('FA371 告警推送：载荷里没有可用的记录 id，跳过', { deviceId: device.id })
        continue
      }
      const candidate = toPushCandidate(device, log, now)
      if (!candidate) continue
      this.triggers += 1
      accepted += 1
      for (const listener of this.listeners) listener(candidate)
    }
    this.frames += 1
    respondJson(response, 200, { ret: 200, msg: 'SUCCESS', accepted })
  }
}

/**
 * 推送记录 → 候选事件。与 `toWebSocketCandidate` 同一套口径，只是来源标记不同——
 * 三条路径（轮询 / WS / 推送）报同一条记录时身份与字段完全一致，引擎去重。
 */
export function toPushCandidate(
  device: Pick<Device, 'id' | 'name'>,
  log: ReturnType<typeof mapDetectLog>,
  observedAt: number
): LinkageCandidate | undefined {
  if (typeof log.id !== 'number' || !Number.isFinite(log.id)) return undefined

  const candidate: LinkageCandidate = {
    source: 'push',
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
  if (log.detectMode !== undefined) candidate.detectMode = log.detectMode
  const dischargeTypeKey = resolveDischargeTypeKey(log)
  if (dischargeTypeKey !== undefined) candidate.dischargeTypeKey = dischargeTypeKey

  const metrics: { soundmapIntensity?: number; leakVolume?: number; leakCost?: number; alarmDb?: number; alarmDf?: number } = {}
  if (log.soundmapIntensity !== undefined) metrics.soundmapIntensity = log.soundmapIntensity
  // 泄漏量/价格只在泄漏模式（或模式未知的非零值）下才是泄漏读数，规则见
  // `leakMetricsForMode`：局放/机械记录里的 data_1=0 是占位，不能再印成「泄漏量 0」。
  Object.assign(metrics, leakMetricsForMode(log.detectMode, log.leakVolume, log.leakCost))
  if (log.lastAlarmDb !== undefined) metrics.alarmDb = log.lastAlarmDb
  if (log.lastAlarmDf !== undefined) metrics.alarmDf = log.lastAlarmDf
  if (Object.keys(metrics).length > 0) candidate.metrics = metrics

  return candidate
}

function respondJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** 读完整正文；超限抛错（调用方不 catch —— 请求随即断开，与「超限拒绝」等价）。 */
function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    request.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('payload-too-large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}
