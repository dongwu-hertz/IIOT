/**
 * IoT 数据接入服务（业主 2026-09-19 第 1 条：「HTTP 推流和 MQTT 是类似于 thingsboard 平台
 * 接 IOT 设备的逻辑，你去调研，然后开发」）。
 *
 * ---------------------------------------------------------------------------
 * 一个服务，两个监听（HTTP + MQTT）
 * ---------------------------------------------------------------------------
 * 放一个类里而不是两个：它们共用**同一件事**——一台设备的秘钥、同一份统计、同一个总开关、
 * 同一套"收到就交给 `TelemetryIntake`"的落库路径。拆成两个服务会让"秘钥是谁的""统计怎么算"
 * 这两件事各有一份实现，而它们必须完全一致（否则设置页上 HTTP 与 MQTT 的收数对不上）。
 *
 * ---------------------------------------------------------------------------
 * 形状照抄 ThingsBoard（出处见 §15.61.3）
 * ---------------------------------------------------------------------------
 *   HTTP：`POST /api/v1/<秘钥>/telemetry`，token 无效 401、路径不对 404；
 *   MQTT：秘钥当**用户名**，发布到 `v1/devices/me/telemetry`。
 * 现场那台 FA8 声纹设备自己的 Push 配置就是这个形状（`docs/PROTOCOL-FINDINGS.md` §3.9），
 * 所以不需要为"我们自己的设备"和"第三方设备"写两套接收端。
 *
 * ---------------------------------------------------------------------------
 * 明确没做的事（写在代码旁边，免得下一轮以为漏了）
 * ---------------------------------------------------------------------------
 *   1. **QoS 2 不做**：收到 QoS 2 的 PUBLISH 就断开并记日志，不假装支持（见 `mqtt-codec.ts`）；
 *   2. **属性通道只读**：`GET /api/v1/<秘钥>/attributes` 回一个空对象。我们**没有**客户端属性
 *      存储，回 `{}` 是"我们手上一条都没有"的如实回答；这条通道**不接受写入**（POST/PUT 一律
 *      404），因为我们不会假装存下了它；
 *   3. **不下发**：本机是"平台"这一侧，订阅会被授权（SUBACK 0/1），但我们不会给设备发消息
 *      —— 没有任何一条业务需要它；
 *   4. **不转发**：设备之间不互相转发遥测（ThingsBoard 的规则链、仪表盘、告警规则都不在
 *      本轮里）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net'
import {
  IOT_INGEST_LIMITS,
  MQTT_TELEMETRY_TOPIC,
  parseTelemetryPayload,
  secretFromAttributesPath,
  secretFromTelemetryPath,
  type IotIngestConfig,
  type IotIngestStats,
  type TelemetryRow
} from '@shared/domain/iot-ingest'
import {
  MQTT_CONNACK,
  MQTT_PACKET,
  MQTT_PINGRESP,
  decodeConnect,
  decodePublish,
  decodeSubscribe,
  decodeUnsubscribe,
  encodeConnAck,
  encodePubAck,
  encodeSubAck,
  encodeUnsubAck,
  readFixedHeader
} from './mqtt-codec'
import type { IngestTargetDevice, IntakeOutcome, TelemetryIntake } from './telemetry-intake'

export interface IngestLogger {
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
}

export interface IotIngestOptions {
  /** 每次都重新读设置（改完端口不该要重启应用）。 */
  getConfig: () => IotIngestConfig
  /** 秘钥 → 设备。找不到就是"秘钥无效"，服务端回 401 / CONNACK 拒绝。 */
  resolveDevice: (secret: string) => IngestTargetDevice | undefined
  intake: TelemetryIntake
  now?: () => number
  log?: IngestLogger
}

export interface ListenerStatus {
  enabled: boolean
  listening: boolean
  address?: string
  port?: number
  /** 起不来时的原因（端口被占、地址不属于本机）。**如实回给界面**，不吞掉。 */
  error?: string
}

export interface IotIngestStatus {
  config: IotIngestConfig
  http: ListenerStatus
  mqtt: ListenerStatus
  stats: IotIngestStats
}

/** MQTT 一条连接的全部状态。 */
interface MqttSession {
  socket: Socket
  buffer: Buffer
  device?: IngestTargetDevice
  keepAliveSeconds: number
  clientId: string
}

export class IotIngestService {
  private readonly options: IotIngestOptions
  private readonly now: () => number

  private httpServer?: Server
  private mqttServer?: NetServer
  private readonly mqttSessions = new Set<MqttSession>()

  private http: ListenerStatus = { enabled: false, listening: false }
  private mqtt: ListenerStatus = { enabled: false, listening: false }
  private stats: IotIngestStats = {
    httpRequests: 0,
    mqttMessages: 0,
    rejectedAuth: 0,
    rejectedPayload: 0,
    trendRows: 0,
    alarmRows: 0
  }

  /** 当前这份监听是按哪份配置起的（用来判断"要不要重起"）。 */
  private applied?: { config: IotIngestConfig; http: boolean; mqtt: boolean }

  /**
   * 串行化 `applyConfig()`。
   *
   * 设置页连着改两个字段会在几十毫秒里触发两次应用，而"关掉旧监听 + 起新监听"不是一个
   * 原子操作：两次交叠就会留下一个没人持有句柄的监听（端口被占，界面显示监听失败，
   * 而实际上第二次那张是对的）。用一条 Promise 链把它们排成一队。
   */
  private queue: Promise<void> = Promise.resolve()

  private disposed = false

  constructor(options: IotIngestOptions) {
    this.options = options
    this.now = options.now ?? ((): number => Date.now())
  }

  get status(): IotIngestStatus {
    return {
      config: this.options.getConfig(),
      http: { ...this.http },
      mqtt: { ...this.mqtt },
      stats: { ...this.stats }
    }
  }

  /** 按当前设置起 / 停 / 重起两个监听。幂等：配置没变就什么都不做。 */
  applyConfig(): Promise<void> {
    this.queue = this.queue.then(
      () => this.reconcile(),
      () => this.reconcile()
    )
    return this.queue
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) return
    const config = this.options.getConfig()

    if (!config.enabled) {
      await this.stopHttp()
      await this.stopMqtt()
      this.http = { enabled: false, listening: false }
      this.mqtt = { enabled: false, listening: false }
      this.applied = { config, http: false, mqtt: false }
      return
    }

    const wantHttp = config.httpEnabled
    const wantMqtt = config.mqttEnabled
    const previous = this.applied
    const bindingChanged =
      previous !== undefined &&
      (previous.config.bindAddress !== config.bindAddress ||
        previous.config.httpPort !== config.httpPort ||
        previous.config.mqttPort !== config.mqttPort)

    if (previous !== undefined && !bindingChanged && previous.http === wantHttp && previous.mqtt === wantMqtt) {
      // 只有 enabled 之外的开关变了但通道没变（例如总开关还是开着）—— 无需重起。
      this.http = { ...this.http, enabled: wantHttp }
      this.mqtt = { ...this.mqtt, enabled: wantMqtt }
      return
    }

    await this.stopHttp()
    await this.stopMqtt()
    this.http = { enabled: wantHttp, listening: false }
    this.mqtt = { enabled: wantMqtt, listening: false }

    if (wantHttp) await this.startHttp(config)
    if (wantMqtt) await this.startMqtt(config)

    this.applied = { config: { ...config }, http: wantHttp, mqtt: wantMqtt }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const session of [...this.mqttSessions]) session.socket.destroy()
    this.mqttSessions.clear()
    await this.stopHttp()
    await this.stopMqtt()
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private startHttp(config: IotIngestConfig): Promise<void> {
    return new Promise((resolve) => {
      const server = createServer((request, response) => {
        void this.handleHttp(request, response)
      })
      this.httpServer = server

      server.on('error', (error: NodeJS.ErrnoException) => {
        this.http = {
          enabled: true,
          listening: false,
          error: describeListenError(error, config.bindAddress, config.httpPort)
        }
        this.options.log?.warn('IoT 接入：HTTP 监听失败', {
          address: config.bindAddress,
          port: config.httpPort,
          reason: error.message
        })
        resolve()
      })

      server.listen(config.httpPort, config.bindAddress, () => {
        this.http = {
          enabled: true,
          listening: true,
          address: config.bindAddress,
          port: config.httpPort
        }
        this.options.log?.info('IoT 接入：HTTP 监听中', {
          address: config.bindAddress,
          port: config.httpPort
        })
        resolve()
      })
    })
  }

  private stopHttp(): Promise<void> {
    const server = this.httpServer
    this.httpServer = undefined
    if (!server) return Promise.resolve()
    return new Promise((resolve) => {
      // 已经关掉的服务器再 close() 回调里会给一个 ERR_SERVER_NOT_RUNNING —— 忽略它，
      // 因为"要它停"这个意图已经达成了。
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.stats.httpRequests += 1
    const url = new URL(request.url ?? '/', 'http://localhost')
    const telemetrySecret = secretFromTelemetryPath(url.pathname)
    const attributesSecret =
      telemetrySecret === undefined ? secretFromAttributesPath(url.pathname) : undefined

    if (telemetrySecret === undefined && attributesSecret === undefined) {
      // 路径不对：这是**配置问题**（URL 拼错了），不是凭据问题。回 404 而不是 401，
      // 否则现场会一直在秘钥上找原因。
      respondJson(response, 404, { error: 'unknown-endpoint' })
      return
    }

    if (attributesSecret !== undefined) {
      // 属性通道**只读**：我们没有任何客户端属性存储，`{}` 是如实回答。
      if (request.method !== 'GET') {
        respondJson(response, 404, { error: 'unknown-endpoint' })
        return
      }
      const device = this.options.resolveDevice(attributesSecret)
      if (!device) {
        this.rejectAuth('http-attributes')
        respondJson(response, 401, { error: 'invalid-token' })
        return
      }
      respondJson(response, 200, {})
      return
    }

    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST')
      respondJson(response, 405, { error: 'method-not-allowed' })
      return
    }

    const device = this.options.resolveDevice(telemetrySecret as string)
    if (!device) {
      this.rejectAuth('http-telemetry')
      respondJson(response, 401, { error: 'invalid-token' })
      return
    }

    const body = await readBody(request, IOT_INGEST_LIMITS.maxBodyBytes)
    if (body === undefined) {
      this.rejectPayload('http-body-too-large')
      respondJson(response, 413, { error: 'payload-too-large' })
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      this.rejectPayload('http-invalid-json')
      respondJson(response, 400, { error: 'invalid-json' })
      return
    }

    const result = parseTelemetryPayload(parsed, this.now())
    if (!result.ok) {
      this.rejectPayload(`http-${result.reason}`)
      respondJson(response, 400, { error: result.reason })
      return
    }

    const outcome = this.record(device, result.rows, 'http', result.ignoredValues)
    respondJson(response, 200, {
      accepted: result.rows.length,
      trendRows: outcome.trendRows,
      alarmRows: outcome.alarmRows
    })
  }

  // -------------------------------------------------------------------------
  // MQTT
  // -------------------------------------------------------------------------

  private startMqtt(config: IotIngestConfig): Promise<void> {
    return new Promise((resolve) => {
      const server = createNetServer((socket) => this.acceptMqtt(socket))
      this.mqttServer = server

      server.on('error', (error: NodeJS.ErrnoException) => {
        this.mqtt = {
          enabled: true,
          listening: false,
          error: describeListenError(error, config.bindAddress, config.mqttPort)
        }
        this.options.log?.warn('IoT 接入：MQTT 监听失败', {
          address: config.bindAddress,
          port: config.mqttPort,
          reason: error.message
        })
        resolve()
      })

      server.listen(config.mqttPort, config.bindAddress, () => {
        this.mqtt = {
          enabled: true,
          listening: true,
          address: config.bindAddress,
          port: config.mqttPort
        }
        this.options.log?.info('IoT 接入：MQTT 监听中', {
          address: config.bindAddress,
          port: config.mqttPort
        })
        resolve()
      })
    })
  }

  private stopMqtt(): Promise<void> {
    const server = this.mqttServer
    this.mqttServer = undefined
    for (const session of [...this.mqttSessions]) session.socket.destroy()
    this.mqttSessions.clear()
    if (!server) return Promise.resolve()
    return new Promise((resolve) => {
      server.close(() => resolve())
    })
  }

  private acceptMqtt(socket: Socket): void {
    const session: MqttSession = { socket, buffer: Buffer.alloc(0), keepAliveSeconds: 0, clientId: '' }
    this.mqttSessions.add(session)

    socket.on('data', (chunk) => {
      session.buffer = Buffer.concat([session.buffer, chunk])
      this.consumeMqtt(session)
    })
    socket.on('error', () => {
      this.dropMqtt(session)
    })
    socket.on('close', () => {
      this.mqttSessions.delete(session)
    })
  }

  private dropMqtt(session: MqttSession): void {
    this.mqttSessions.delete(session)
    session.socket.destroy()
  }

  /** 按 TCP 分片逐条取报文；长度不够就留着等下一片。 */
  private consumeMqtt(session: MqttSession): void {
    for (;;) {
      const header = readFixedHeader(session.buffer)
      if (!header) return
      if (header.type === 0) {
        this.dropMqtt(session)
        return
      }
      const total = header.headerLength + header.remainingLength
      if (session.buffer.length < total) return
      const body = session.buffer.subarray(header.headerLength, total)
      session.buffer = session.buffer.subarray(total)
      if (!this.dispatchMqtt(session, header.type, header.flags, body)) return
    }
  }

  /** 返回 `false` 表示这条连接已经结束，别再往下读。 */
  private dispatchMqtt(session: MqttSession, type: number, flags: number, body: Buffer): boolean {
    switch (type) {
      case MQTT_PACKET.CONNECT:
        return this.handleConnect(session, body)

      case MQTT_PACKET.PUBLISH:
        return this.handlePublish(session, flags, body)

      case MQTT_PACKET.SUBSCRIBE: {
        const decoded = decodeSubscribe(body)
        if (!decoded.ok) return this.dropMqttAndReturnFalse(session, 'subscribe-malformed')
        session.socket.write(
          encodeSubAck(
            decoded.value.packetId,
            decoded.value.filters.map((filter) => filter.qos)
          )
        )
        return true
      }

      case MQTT_PACKET.UNSUBSCRIBE: {
        const decoded = decodeUnsubscribe(body)
        if (!decoded.ok) return this.dropMqttAndReturnFalse(session, 'unsubscribe-malformed')
        session.socket.write(encodeUnsubAck(decoded.value.packetId))
        return true
      }

      case MQTT_PACKET.PINGREQ:
        session.socket.write(MQTT_PINGRESP)
        return true

      case MQTT_PACKET.DISCONNECT:
        this.mqttSessions.delete(session)
        session.socket.end()
        return false

      default:
        // 客户端不该发 PUBACK/PUBREL/... 给我们（我们从不发 PUBLISH），
        // 但一条多余的控制报文不值得断开连接：记一笔、忽略。
        this.options.log?.warn('IoT 接入：忽略未预期的 MQTT 报文', { type })
        return true
    }
  }

  private dropMqttAndReturnFalse(session: MqttSession, reason: string): boolean {
    this.rejectPayload(`mqtt-${reason}`)
    this.dropMqtt(session)
    return false
  }

  private handleConnect(session: MqttSession, body: Buffer): boolean {
    const decoded = decodeConnect(body)
    if (!decoded.ok) {
      session.socket.write(encodeConnAck(MQTT_CONNACK.UNACCEPTABLE_PROTOCOL))
      this.dropMqtt(session)
      return false
    }
    const connect = decoded.value
    if (connect.protocolName !== 'MQTT' || connect.protocolLevel !== 4) {
      // 只做 3.1.1（level 4）。3.1 会在这里被明确拒绝，而不是以"连上了但不工作"的形式出现。
      session.socket.write(encodeConnAck(MQTT_CONNACK.UNACCEPTABLE_PROTOCOL))
      this.rejectAuth(`mqtt-protocol-${connect.protocolName}-${connect.protocolLevel}`)
      this.dropMqtt(session)
      return false
    }
    if (!connect.username) {
      session.socket.write(encodeConnAck(MQTT_CONNACK.BAD_CREDENTIALS))
      this.rejectAuth('mqtt-no-username')
      this.dropMqtt(session)
      return false
    }

    const device = this.options.resolveDevice(connect.username)
    if (!device) {
      session.socket.write(encodeConnAck(MQTT_CONNACK.NOT_AUTHORIZED))
      this.rejectAuth('mqtt-unknown-secret')
      this.dropMqtt(session)
      return false
    }

    session.device = device
    session.clientId = connect.clientId
    session.keepAliveSeconds = connect.keepAliveSeconds
    /**
     * keepalive 的超时判据用 MQTT 自己的规矩：**1.5 倍** keepalive 内没有任何报文就断开
     * （§3.1.2.10）。keepalive = 0 表示不使用（那时不设超时）。
     */
    if (connect.keepAliveSeconds > 0) {
      session.socket.setTimeout(Math.ceil(connect.keepAliveSeconds * 1500), () => {
        this.options.log?.warn('IoT 接入：MQTT 连接超时', { clientId: connect.clientId })
        this.dropMqtt(session)
      })
    }
    session.socket.write(encodeConnAck(MQTT_CONNACK.ACCEPTED))
    return true
  }

  private handlePublish(session: MqttSession, flags: number, body: Buffer): boolean {
    const decoded = decodePublish(flags, body)
    if (!decoded.ok) return this.dropMqttAndReturnFalse(session, decoded.reason)
    const packet = decoded.value

    if (packet.qos === 2) {
      // 明确不支持（见文件头）。断开而不是回一个 PUBREC：回 PUBREC 之后设备会等 PUBREL，
      // 而我们会一直不理会它，设备那边表现为"发了但永远没完成"——比断开更难查。
      this.rejectPayload('mqtt-qos2-unsupported')
      this.options.log?.warn('IoT 接入：设备使用了未实现的 QoS 2，断开连接', {
        topic: packet.topic
      })
      this.dropMqtt(session)
      return false
    }

    const device = session.device
    if (!device) {
      // 没 CONNECT 就发 PUBLISH：协议上不允许（§3.1）。断开。
      return this.dropMqttAndReturnFalse(session, 'publish-before-connect')
    }

    this.stats.mqttMessages += 1

    if (packet.payload.length > IOT_INGEST_LIMITS.maxMqttPayloadBytes || packet.topic !== MQTT_TELEMETRY_TOPIC) {
      this.rejectPayload(
        packet.topic !== MQTT_TELEMETRY_TOPIC ? `mqtt-topic:${packet.topic}` : 'mqtt-payload-too-large'
      )
    } else {
      let parsed: unknown
      try {
        parsed = JSON.parse(packet.payload.toString('utf8'))
      } catch {
        parsed = undefined
        this.rejectPayload('mqtt-invalid-json')
      }
      if (parsed !== undefined) {
        const result = parseTelemetryPayload(parsed, this.now())
        if (!result.ok) this.rejectPayload(`mqtt-${result.reason}`)
        else this.record(device, result.rows, 'mqtt', result.ignoredValues)
      }
    }

    if (packet.qos === 1 && packet.packetId !== undefined) {
      session.socket.write(encodePubAck(packet.packetId))
    }
    return true
  }

  // -------------------------------------------------------------------------
  // 落库 + 统计
  // -------------------------------------------------------------------------

  private record(
    device: IngestTargetDevice,
    rows: readonly TelemetryRow[],
    source: 'http' | 'mqtt',
    ignoredValues: number
  ): { trendRows: number; alarmRows: number } {
    let outcome: IntakeOutcome
    try {
      outcome = this.options.intake.ingest(device, rows)
    } catch (error) {
      // 落库失败不能把已经收到的数据变成"服务挂了"：记日志、计数、回 200 之外的错误
      // 都会让设备重发（那正是我们要的），但连接本身不该断。
      this.options.log?.warn('IoT 接入：遥测落库失败', {
        deviceId: device.id,
        reason: error instanceof Error ? error.message : String(error)
      })
      this.rejectPayload('intake-failed')
      return { trendRows: 0, alarmRows: 0 }
    }

    this.stats.trendRows += outcome.trendRows
    this.stats.alarmRows += outcome.alarmRows
    this.stats.lastAt = this.now()
    this.stats.lastDeviceId = device.id
    this.stats.lastSource = source
    const unrecognised = [...outcome.unrecognised]
    // 值不是标量被丢掉的键也要说出来 —— 否则"推上来了但界面上什么都没有"没有解释。
    if (ignoredValues > 0) unrecognised.push(`ignoredValues=${ignoredValues}`)
    if (unrecognised.length > 0) this.stats.lastUnrecognised = unrecognised
    else delete this.stats.lastUnrecognised

    this.options.log?.info('IoT 接入：收到遥测', {
      source,
      deviceId: device.id,
      rows: rows.length,
      trendRows: outcome.trendRows,
      alarmRows: outcome.alarmRows,
      ...(unrecognised.length > 0 ? { unrecognised } : {})
    })

    return { trendRows: outcome.trendRows, alarmRows: outcome.alarmRows }
  }

  private rejectAuth(reason: string): void {
    this.stats.rejectedAuth += 1
    this.options.log?.warn('IoT 接入：凭据被拒', { reason })
  }

  private rejectPayload(reason: string): void {
    this.stats.rejectedPayload += 1
    this.stats.lastUnrecognised = [reason]
    this.options.log?.warn('IoT 接入：载荷被拒', { reason })
  }
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length)
  })
  response.end(payload)
}

/**
 * 读请求体，超过上限返回 `undefined`（调用方回 413）。
 *
 * 超限之后**不 `destroy()`**：那会在回 413 之前把连接重置掉，设备端看到的是"连接被对端关闭"
 * （`UND_ERR_SOCKET`），而我们要它看到的是一条明确的 413 —— 它决定了现场能不能分辨
 * "推得太大了"与"网线/服务有问题"。所以超限之后把剩下的字节**读掉丢掉**（`resume()`），
 * 让这条请求正常结束。
 */
function readBody(request: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > limit) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(tooLarge ? undefined : Buffer.concat(chunks).toString('utf8')))
    request.on('error', () => resolve(undefined))
  })
}

/**
 * 监听失败的原因**翻译成人能读的一句话**。
 *
 * `EADDRINUSE`（端口被占）与 `EADDRNOTAVAIL`（这个地址不属于本机）是两种完全不同的现场
 * 问题，而 Node 只给一个 errno 字符串。界面要能直接说出是哪一种 —— 否则操作员会去改端口，
 * 而真正的问题是绑定地址写错了。
 */
function describeListenError(error: NodeJS.ErrnoException, address: string, port: number): string {
  if (error.code === 'EADDRINUSE') return `EADDRINUSE ${address}:${port}`
  if (error.code === 'EADDRNOTAVAIL') return `EADDRNOTAVAIL ${address}`
  if (error.code === 'EACCES') return `EACCES ${address}:${port}`
  return error.message
}

/** 供 `app-services` 判断"要不要把新配置应用一次"。 */
export function ingestConfigEquals(left: IotIngestConfig, right: IotIngestConfig): boolean {
  return (
    left.enabled === right.enabled &&
    left.httpEnabled === right.httpEnabled &&
    left.httpPort === right.httpPort &&
    left.mqttEnabled === right.mqttEnabled &&
    left.mqttPort === right.mqttPort &&
    left.bindAddress === right.bindAddress
  )
}
