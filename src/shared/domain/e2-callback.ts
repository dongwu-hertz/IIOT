/**
 * SN-16 空气声呐的**回调报文**解析（设备主动 POST 到 `notify_url`）。
 *
 * 依据是那一份 Air Sonar API 文档（见 `e2.ts` 的 `E2_CALLBACK_MESSAGE_TYPES` 与
 * `docs/Ivms4200-UX-REFERENCE.md` §15.28.2 的两代表格）：
 *
 *   `message_type`        | 内容
 *   ----------------------|--------------------------------------------------------
 *   `alarm_msg`           | 一条告警（Air Sonar 带 `horizontal` / `vertical`）
 *   `alarm_files_save_report`（示例叫 `wav_save_report`） | 告警文件保存完成
 *   `realtime_value`      | **每秒一次**：`max_db_chn` / `max_db_value` / `max_fdr_value` / `max_tdr_value`
 *   `heart_beat_message`  | 心跳
 *
 * ---------------------------------------------------------------------------
 * 为什么这里只解析 `realtime_value`，而且字段名两种都收
 * ---------------------------------------------------------------------------
 * 1. **告警与文件回调不在这一轮**：告警已经有「拉」通道（`alarm_log_all` 同步）在跑，
 *    文件保存通知也只是提醒"可以去拉了"；在没有真机确认之前，不把两条写路径同时打开。
 * 2. 字段名在文档里有两处写法：本项目 `e2.ts` 的注释写 `max_tddr_value`，而业主手册
 *    表格写 `max_tdr_value`（少一个 d）。**两种都收**，因为拼错一个字母的后果是
 *    "设备在推、界面永远没有值"，比多写一个别名危险得多。
 * 3. 数字可能是 number，也可能是数字字符串（现场设备的 JSON 常见两种都有）；
 *    非数字、非整数通道一律**丢掉这一项**，而不是 `Number(...)` 之后把 NaN 当成值。
 *
 * 这个文件是纯函数、零依赖：主进程与单测都直接 import，不碰 http / electron。
 */

/** 设备每秒推来的一组实时值；缺哪一项就是这一秒设备没给哪一项。 */
export interface E2RealtimeValue {
  /** `max_db_chn`：这一秒最大声压所在的通道（设备编号 1 起）。 */
  maxDbChannel?: number
  /** `max_db_value`：最大声压级（dB）。 */
  maxDbValue?: number
  /** `max_fdr_value`：频域能量比（文档写法）。 */
  maxFdrValue?: number
  /** `max_tdr_value` / `max_tddr_value`：时域能量比（两种文档写法）。 */
  maxTdrValue?: number
}

/** 主进程推给渲染层的一帧；`deviceId` 由监听端按秘钥解析出来。 */
export interface E2RealtimeValueEvent {
  deviceId: string
  /** 到达主进程的时刻（设备报文里没有时间戳）。 */
  at: number
  value: E2RealtimeValue
}

/** 实时音频一帧（SN-16 `/audio_stream`：16-bit 小端 PCM，解码后归一化到 ±1）。 */
export interface E2AudioFrameEvent {
  deviceId: string
  at: number
  sampleRate: number
  samples: number[]
}
export type E2CallbackParseResult =
  | { kind: 'realtimeValue'; value: E2RealtimeValue }
  | { kind: 'alarm' }
  | { kind: 'filesSaved' }
  | { kind: 'heartbeat' }
  | { kind: 'unknown'; messageType?: string }
  | { kind: 'invalid'; reason: string }

/**
 * 解析一包 JSON 已经是对象、但形状来路不明的回调载荷。
 *
 * 缺失 `message_type` 时的兜底：只要出现任一 `max_*` 实时键，就按 `realtime_value` 处理。
 * 真机厂商的 `notify_url` 回调实现有时不把类型字段带上；"有值却不认"比"多认一种形状"更糟。
 */
export function parseE2CallbackPayload(payload: unknown): E2CallbackParseResult {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { kind: 'invalid', reason: 'not-an-object' }
  }
  const record = payload as Record<string, unknown>
  const messageType = readString(record.message_type)

  if (messageType === 'heart_beat_message') return { kind: 'heartbeat' }
  if (messageType === 'alarm_msg') return { kind: 'alarm' }
  if (messageType === 'alarm_files_save_report' || messageType === 'wav_save_report') {
    return { kind: 'filesSaved' }
  }

  const hasRealtimeKeys =
    record.max_db_chn !== undefined ||
    record.max_db_value !== undefined ||
    record.max_fdr_value !== undefined ||
    record.max_tdr_value !== undefined ||
    record.max_tddr_value !== undefined

  if (messageType === 'realtime_value' || (messageType === undefined && hasRealtimeKeys)) {
    const value = parseRealtimeValue(record)
    if (value === undefined) return { kind: 'invalid', reason: 'no-realtime-values' }
    return { kind: 'realtimeValue', value }
  }

  if (messageType === 'fft_data') {
    // 2023 版听诊盒子的每秒计算结果，字段与 Air Sonar 的 realtime_value **不是一回事**
    // （它带定长 `fft_array`）。这一轮不把它当实时值解释。
    return { kind: 'unknown', messageType }
  }

  return { kind: 'unknown', ...(messageType !== undefined ? { messageType } : {}) }
}

/** 从一条已经确认是实时值的记录里取字段；一项都没有就返回 `undefined`。 */
function parseRealtimeValue(record: Record<string, unknown>): E2RealtimeValue | undefined {
  const value: E2RealtimeValue = {}
  const channel = readInteger(record.max_db_chn, 1, 64)
  if (channel !== undefined) value.maxDbChannel = channel
  const maxDb = readFiniteNumber(record.max_db_value)
  if (maxDb !== undefined) value.maxDbValue = maxDb
  const fdr = readFiniteNumber(record.max_fdr_value)
  if (fdr !== undefined) value.maxFdrValue = fdr
  const tdr = readFiniteNumber(record.max_tdr_value) ?? readFiniteNumber(record.max_tddr_value)
  if (tdr !== undefined) value.maxTdrValue = tdr
  return Object.keys(value).length > 0 ? value : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function readInteger(value: unknown, min: number, max: number): number | undefined {
  const parsed = readFiniteNumber(value)
  if (parsed === undefined || !Number.isInteger(parsed) || parsed < min || parsed > max) return undefined
  return parsed
}

/** 这一帧里有没有任何可用值（空对象就是"收到了但没有值"，界面按没有数据处理）。 */
export function hasE2RealtimeValues(value: E2RealtimeValue): boolean {
  return Object.keys(value).length > 0
}

/**
 * 回调 URL 的形状：复用本机接入的 HTTP 遥测端点。
 *
 * 设备侧 `notify_url` 只需要一个地址；本机已有的 HTTP 监听已经带每设备秘钥与收数统计，
 * 再开第二个端口只会多一套需要现场配置的东西。路径的拼法仍然只有
 * `@shared/domain/iot-ingest` 一处定义（`httpPushUrl`）。
 */
export const E2_CALLBACK_SUCCESS_BODY = { ret: 0, msg: 'ok' } as const
/**
 * 本机 HTTP 监听的运行状态（与 `IotIngestRuntimeStatus.http` 同形状）。
 *
 * 单独声明而不是从 iot-ingest import：这一层要保持零依赖，而且回调卡片只关心
 * 这四个字段，不需要把 MQTT 与统计一起拖进渲染层。
 */
export interface E2RealtimeCallbackListener {
  enabled: boolean
  listening: boolean
  address?: string
  port?: number
  error?: string
}

/** 设备详情页那张「实时值回调」卡片能看到的全部事实。 */
export interface E2RealtimeCallbackStatus {
  deviceId: string
  /** 只有 Air Sonar 有 `realtime_value`；2023 版听诊盒与其它机型为 false。 */
  supported: boolean
  /** 设备当前的 `notify_url` 原文（可能是第三方地址；为空表示未配置）。 */
  notifyUrl?: string
  /** 设备当前的 `is_send_realtime_value` 原始值（缺省 = 设备没回这个键）。 */
  isSendRealtimeValue?: number
  /** 设备指的那条地址是不是本机为这台设备生成的地址（不单独回显秘钥）。 */
  pointsToUs: boolean
  listener: E2RealtimeCallbackListener
}

/** 开启/停止回调并**读回核对**之后的结果。 */
export interface E2RealtimeCallbackOutcome {
  enabled: boolean
  /** 开启时实际写进设备的地址；停止时不返回（没改 notify_url）。 */
  callbackUrl?: string
  notifyUrl?: string
  isSendRealtimeValue?: number
  /** 读回之后每一项是否与写入一致。 */
  fields: Array<{ field: 'notifyUrl' | 'isSendRealtimeValue'; ok: boolean }>
  allApplied: boolean
}
/** Minimal shape of a local address candidate (matches `IotIngestLocalAddress`). */
export interface E2LocalAddress {
  address: string
}

/**
 * Pick the local address the device should POST to.
 *
 * Prefer an address on the same /24 as the device; a multi-NIC host otherwise often picks
 * a VPN/Docker adapter the device cannot reach, and the callback silently never arrives.
 * Falls back to the first non-loopback address, then to loopback so the caller can still
 * show a URL (and a listener error will explain the real problem).
 */
export function pickE2CallbackAddress(
  deviceIp: string | undefined,
  addresses: readonly E2LocalAddress[]
): string {
  const subnet = (value: string): string => value.split('.').slice(0, 3).join('.')
  if (deviceIp !== undefined && deviceIp.includes('.')) {
    const wanted = subnet(deviceIp)
    const same = addresses.find((entry) => subnet(entry.address) === wanted)
    if (same) return same.address
  }
  return (
    addresses.find((entry) => entry.address !== '127.0.0.1')?.address ??
    addresses[0]?.address ??
    '127.0.0.1'
  )
}