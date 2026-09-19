/**
 * 最小 MQTT 3.1.1 报文编解码（业主 2026-09-19 第 1 条：「支持 MQTT 协议」）。
 *
 * ---------------------------------------------------------------------------
 * 为什么手写而不用现成的 broker
 * ---------------------------------------------------------------------------
 * 不新增依赖是这个仓库的硬规矩，而 `aedes` / `mosca` 这类包会把一个完整的
 * 会话 / 保留消息 / 遗嘱 / 集群存储全带进来 —— 我们只要一件事：**让设备用秘钥当用户名连上来，
 * 往 `v1/devices/me/telemetry` 发一条 JSON**。这正好是 ThingsBoard 设备侧 MQTT 的形状
 * （见 `docs/Ivms4200-UX-REFERENCE.md` §15.61.3 的调研表）。
 *
 * ---------------------------------------------------------------------------
 * 这里**只做 3.1.1**，而且明确不做 QoS 2
 * ---------------------------------------------------------------------------
 * 3.1（protocol level 3）不认：现场与第三方示例都是 3.1.1，多支持一版就是多一条没人走的路径。
 * QoS 2 也不做 —— 它要 PUBREC / PUBREL / PUBREC 四次握手与一份"已收到但未释放"的状态，
 * 而收益是零：遥测数据重复一条没有后果（趋势表按时间戳排序，重复点画在同一个位置）。
 * 设备端绝大多数遥测本来就是 QoS 0。收到 QoS 2 的 PUBLISH 时**断开连接并记日志**，
 * 而不是假装支持（回一个 PUBREC 之后不理会 PUBREL，设备会永远重发）。
 *
 * 这个文件是**纯函数**：字节进、结构出。谁读谁写由 `mqtt-broker.ts` 负责，所以协议解析
 * 可以在单测里逐字节验证，不需要起监听端口。
 */

/** 报文类型（MQTT 3.1.1 §2.2.1）。 */
export const MQTT_PACKET = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  PUBREC: 5,
  PUBREL: 6,
  PUBCOMP: 7,
  SUBSCRIBE: 8,
  SUBACK: 9,
  UNSUBSCRIBE: 10,
  UNSUBACK: 11,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14
} as const

/** CONNACK 的返回码（§3.2.2.3）。我们只用得到其中四个。 */
export const MQTT_CONNACK = {
  ACCEPTED: 0,
  UNACCEPTABLE_PROTOCOL: 1,
  IDENTIFIER_REJECTED: 2,
  SERVER_UNAVAILABLE: 3,
  BAD_CREDENTIALS: 4,
  NOT_AUTHORIZED: 5
} as const

export interface MqttFixedHeader {
  type: number
  flags: number
  remainingLength: number
  /** 固定头本身的字节数（含变长长度字段）。 */
  headerLength: number
}

/**
 * 读固定头。
 *
 * 返回 `undefined` 表示**字节还不够**（长度字段最多 4 字节，TCP 分片很正常）——
 * 调用方继续缓冲。这与"报文非法"是两件事，必须分开，否则一个分片就会被当成坏包断开。
 */
export function readFixedHeader(buffer: Buffer): MqttFixedHeader | undefined {
  if (buffer.length < 2) return undefined
  const first = buffer[0]!
  let multiplier = 1
  let remainingLength = 0
  let index = 1
  for (;;) {
    if (index >= buffer.length) return undefined
    const byte = buffer[index]!
    remainingLength += (byte & 0x7f) * multiplier
    index += 1
    if ((byte & 0x80) === 0) break
    multiplier *= 128
    if (multiplier > 128 * 128 * 128) return undefined // 超过 4 字节的长度字段 = 非法
  }
  return {
    type: (first & 0xf0) >> 4,
    flags: first & 0x0f,
    remainingLength,
    headerLength: index
  }
}

export function encodeRemainingLength(length: number): Buffer {
  const bytes: number[] = []
  let value = length
  do {
    let byte = value % 128
    value = Math.floor(value / 128)
    if (value > 0) byte |= 0x80
    bytes.push(byte)
  } while (value > 0)
  return Buffer.from(bytes)
}

interface Reader {
  buffer: Buffer
  offset: number
}

function readUint16(reader: Reader): number | undefined {
  if (reader.offset + 2 > reader.buffer.length) return undefined
  const value = reader.buffer.readUInt16BE(reader.offset)
  reader.offset += 2
  return value
}

/** MQTT 的字符串是「2 字节长度 + UTF-8 字节」（§1.5.3）。 */
function readString(reader: Reader): string | undefined {
  const length = readUint16(reader)
  if (length === undefined) return undefined
  if (reader.offset + length > reader.buffer.length) return undefined
  const value = reader.buffer.toString('utf8', reader.offset, reader.offset + length)
  reader.offset += length
  return value
}

export interface MqttConnectPacket {
  protocolName: string
  protocolLevel: number
  cleanSession: boolean
  keepAliveSeconds: number
  clientId: string
  username?: string
  password?: string
  willFlag: boolean
}

export type MqttDecodeResult<T> = { ok: true; value: T } | { ok: false; reason: string }

/**
 * 解析 CONNECT 的可变头 + 载荷。
 *
 * 用户名是**必读项**：秘钥就是用户名（ThingsBoard 的 access token 认证方式）。没有用户名的
 * 连接在 `mqtt-broker.ts` 里会被 CONNACK 0x04 拒绝，但解析层不替它判断 —— 解析层只回答
 * "这条报文里有什么"。
 */
export function decodeConnect(payload: Buffer): MqttDecodeResult<MqttConnectPacket> {
  const reader: Reader = { buffer: payload, offset: 0 }
  const protocolName = readString(reader)
  if (protocolName === undefined) return { ok: false, reason: 'truncated-protocol-name' }
  const protocolLevel = payload[reader.offset]
  if (protocolLevel === undefined) return { ok: false, reason: 'truncated-protocol-level' }
  reader.offset += 1
  const flags = payload[reader.offset]
  if (flags === undefined) return { ok: false, reason: 'truncated-connect-flags' }
  reader.offset += 1
  if ((flags & 0x01) !== 0) return { ok: false, reason: 'reserved-flag-set' }
  const keepAliveSeconds = readUint16(reader)
  if (keepAliveSeconds === undefined) return { ok: false, reason: 'truncated-keepalive' }

  const cleanSession = (flags & 0x02) !== 0
  const willFlag = (flags & 0x04) !== 0
  const passwordFlag = (flags & 0x40) !== 0
  const usernameFlag = (flags & 0x80) !== 0

  const clientId = readString(reader)
  if (clientId === undefined) return { ok: false, reason: 'truncated-client-id' }

  if (willFlag) {
    // 遗嘱我们不存也不用（没有订阅者），但**必须照格式跳过**，否则后面用户名会串位。
    const willTopic = readString(reader)
    if (willTopic === undefined) return { ok: false, reason: 'truncated-will-topic' }
    const willLength = readUint16(reader)
    if (willLength === undefined || reader.offset + willLength > payload.length) {
      return { ok: false, reason: 'truncated-will-payload' }
    }
    reader.offset += willLength
  }

  let username: string | undefined
  if (usernameFlag) {
    username = readString(reader)
    if (username === undefined) return { ok: false, reason: 'truncated-username' }
  }
  let password: string | undefined
  if (passwordFlag) {
    password = readString(reader)
    if (password === undefined) return { ok: false, reason: 'truncated-password' }
  }

  const packet: MqttConnectPacket = {
    protocolName,
    protocolLevel,
    cleanSession,
    keepAliveSeconds,
    clientId,
    willFlag
  }
  if (username !== undefined) packet.username = username
  if (password !== undefined) packet.password = password
  return { ok: true, value: packet }
}

export interface MqttPublishPacket {
  topic: string
  qos: 0 | 1 | 2
  retain: boolean
  dup: boolean
  packetId?: number
  payload: Buffer
}

export function decodePublish(flags: number, payload: Buffer): MqttDecodeResult<MqttPublishPacket> {
  const qos = ((flags & 0x06) >> 1) as 0 | 1 | 2
  const reader: Reader = { buffer: payload, offset: 0 }
  const topic = readString(reader)
  if (topic === undefined) return { ok: false, reason: 'truncated-topic' }
  if (topic.includes('+') || topic.includes('#')) {
    // 通配符只在订阅里合法（§3.3.2.1）。设备往通配符主题发消息是错的。
    return { ok: false, reason: 'wildcard-in-publish-topic' }
  }
  let packetId: number | undefined
  if (qos > 0) {
    packetId = readUint16(reader)
    if (packetId === undefined) return { ok: false, reason: 'truncated-packet-id' }
  }
  const packet: MqttPublishPacket = {
    topic,
    qos,
    retain: (flags & 0x01) !== 0,
    dup: (flags & 0x08) !== 0,
    payload: payload.subarray(reader.offset)
  }
  if (packetId !== undefined) packet.packetId = packetId
  return { ok: true, value: packet }
}

export interface MqttSubscribePacket {
  packetId: number
  filters: Array<{ topic: string; qos: number }>
}

export function decodeSubscribe(payload: Buffer): MqttDecodeResult<MqttSubscribePacket> {
  const reader: Reader = { buffer: payload, offset: 0 }
  const packetId = readUint16(reader)
  if (packetId === undefined) return { ok: false, reason: 'truncated-packet-id' }
  const filters: Array<{ topic: string; qos: number }> = []
  while (reader.offset < payload.length) {
    const topic = readString(reader)
    if (topic === undefined) return { ok: false, reason: 'truncated-topic-filter' }
    const qos = payload[reader.offset]
    if (qos === undefined) return { ok: false, reason: 'truncated-requested-qos' }
    reader.offset += 1
    filters.push({ topic, qos })
  }
  if (filters.length === 0) return { ok: false, reason: 'empty-subscription' }
  return { ok: true, value: { packetId, filters } }
}

/** UNSUBSCRIBE 只用到 packet id（我们不需要记住退订了哪些主题）。 */
export function decodeUnsubscribe(payload: Buffer): MqttDecodeResult<{ packetId: number }> {
  const reader: Reader = { buffer: payload, offset: 0 }
  const packetId = readUint16(reader)
  if (packetId === undefined) return { ok: false, reason: 'truncated-packet-id' }
  return { ok: true, value: { packetId } }
}

/** 只要 packet id 的报文（PUBACK / PUBREL / PUBREC / PUBCOMP）。 */
export function decodePacketId(payload: Buffer): number | undefined {
  const reader: Reader = { buffer: payload, offset: 0 }
  return readUint16(reader)
}

// ---------------------------------------------------------------------------
// 编码（服务端 → 设备）
// ---------------------------------------------------------------------------

function packet(type: number, flags: number, body: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([(type << 4) | flags]),
    encodeRemainingLength(body.length),
    body
  ])
}

export function encodeConnAck(returnCode: number, sessionPresent = false): Buffer {
  return packet(MQTT_PACKET.CONNACK, 0, Buffer.from([sessionPresent ? 1 : 0, returnCode]))
}

export function encodePubAck(packetId: number): Buffer {
  const body = Buffer.alloc(2)
  body.writeUInt16BE(packetId, 0)
  return packet(MQTT_PACKET.PUBACK, 0, body)
}

/**
 * SUBACK 的授权 QoS 上限是 **1**。
 *
 * 我们不发任何消息给设备（本机是"平台"这一侧，没有需要下发的遥测），所以授权什么 QoS
 * 都无所谓；写 1 而不是照抄客户端请求的 2，是为了不承诺一个我们明确没实现的等级
 * （QoS 2 的投递语义要状态机）。
 */
export function encodeSubAck(packetId: number, requested: number[]): Buffer {
  const body = Buffer.alloc(2 + requested.length)
  body.writeUInt16BE(packetId, 0)
  requested.forEach((qos, index) => {
    body[2 + index] = qos === 2 ? 1 : qos === 1 ? 1 : 0
  })
  return packet(MQTT_PACKET.SUBACK, 0, body)
}

export function encodeUnsubAck(packetId: number): Buffer {
  const body = Buffer.alloc(2)
  body.writeUInt16BE(packetId, 0)
  return packet(MQTT_PACKET.UNSUBACK, 0, body)
}

export const MQTT_PINGRESP = packet(MQTT_PACKET.PINGRESP, 0, Buffer.alloc(0))
