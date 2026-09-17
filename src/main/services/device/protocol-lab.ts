/**
 * Protocol Lab — an instrument for resolving spec section 19.
 *
 * The specification lists five behaviours that are documented nowhere and
 * cannot be guessed (appendix C rule 9: "Device API implementation must follow
 * the actual FA8 protocol, not assumptions"):
 *
 *   HIGH  1. How is the /login token carried on later requests?
 *   HIGH  2. What framing does /audio_stream actually use?
 *   HIGH  3. What are the payload schemas of /freq_domain and /time_freq_domain?
 *   HIGH  4. Is there a stable device_id in the HTTP Push payloads?
 *   HIGH  5. How does the server retrieve alarm audio?
 *   MED   6. What is the general rule for the recording download URL?
 *   MED   7. What does port `0` mean in /set_network?
 *
 * This module answers 1, 2, 3, 6 by MEASURING a real device instead of
 * assuming. It is read-only: it never mutates device configuration, so it is
 * safe to run against a production box.
 *
 * Design note: the probe records the raw response SIGNATURE (content-type,
 * chunked flag, first bytes as hex+ascii, byte count) rather than trying to
 * parse streams. That signature is exactly what is needed to choose between
 * "chunked JSON lines", "WebSocket", and "raw TCP PCM".
 */

import { AppError, ErrorCodes } from '@shared/errors'
import { deviceLog } from '../logging/logger'
import { CANDIDATE_STRATEGIES } from './auth-strategy'
import { AuthStrategyResolver } from './auth-resolver'
import { DeviceApiClient, ENDPOINTS } from './device-api-client'
import type { HttpTransport } from './http-transport'
import { collectFieldNames } from './auth-strategy'
import type { CredentialStore, DeviceCredential } from './credential-store'
import type { DiagnoseReport, EndpointProbeResult } from '@shared/ipc/contract'
import type { Device } from '@shared/domain/models'

/** How many bytes of a stream response to capture as a signature. */
const SAMPLE_BYTES = 256

export interface ProtocolLabOptions {
  transport: HttpTransport
  credentials: CredentialStore
  timeoutMs: number
}

interface ProbeSpec {
  path: string
  method: 'GET' | 'POST' | 'PUT'
  /** Human note explaining what the probe is looking for. */
  purpose: string
  /** Body for endpoints that are documented as PUT/POST queries. */
  body?: unknown
  /** Cap the read: streams never end, so stop after the signature. */
  captureBytes?: number
}

export class ProtocolLab {
  private readonly transport: HttpTransport
  private readonly credentials: CredentialStore
  private readonly timeoutMs: number

  constructor(options: ProtocolLabOptions) {
    this.transport = options.transport
    this.credentials = options.credentials
    this.timeoutMs = options.timeoutMs
  }

  /**
   * Full read-only diagnosis of one device.
   *
   * Section order mirrors the risk list: identify the auth carrier first,
   * because every later probe depends on it.
   */
  /**
   * Full read-only diagnosis of one device.
   *
   * Section order mirrors the risk list: identify the auth carrier first,
   * because every later probe depends on it.
   *
   * @param device       Device to diagnose.
   * @param activeClient An already-authenticated client for this device.
   *   Passed in by callers that have one (DeviceService, the CLI) so the
   *   diagnosis does not re-run the auth probe and does not need to build a
   *   session of its own. Omitting it makes this method self-sufficient, which
   *   is what standalone tooling wants.
   */
  async diagnose(device: Device, activeClient?: DeviceApiClient): Promise<DiagnoseReport> {
    const startedAt = Date.now()
    const notes: string[] = []
    const endpoints: EndpointProbeResult[] = []

    if (device.connectionType !== 'LAN') {
      throw new AppError(ErrorCodes.NOT_IMPLEMENTED, '协议诊断目前仅支持局域网设备')
    }
    const credential = activeClient ? undefined : this.credentials.get(device.id)
    if (!activeClient && !credential) {
      throw new AppError(ErrorCodes.AUTH_FAILED, '未找到该设备的凭据，请重新添加设备')
    }

    const baseUrl = `${device.ip}${device.httpPort ? `:${device.httpPort}` : ''}`
    const resolver = new AuthStrategyResolver(this.transport)

    // ---- 1. Auth carrier (risk 1) ----------------------------------------
    let authStrategyDetected: string | undefined
    let loginTokenPresent = false
    let loginFieldNames: string[] = []

    let client: DeviceApiClient
    if (activeClient) {
      // Already authenticated: report the carrier the live session is using,
      // and skip a redundant login round-trip.
      client = activeClient
      authStrategyDetected = activeClient.resolvedStrategyId
      notes.push(
        `使用已建立的设备会话（策略 id: ${authStrategyDetected ?? '未知'}），未重复执行登录探测。`
      )
    } else {
      // `credential` is guaranteed non-undefined here: the guard above throws
      // when neither an active client nor a stored credential exists.
      const stored = credential as DeviceCredential
      client = new DeviceApiClient({
        transport: this.transport,
        resolver,
        baseUrl,
        credential: stored,
        timeoutMs: this.timeoutMs
      })

      try {
        // resolve() logs in and verifies; its attempt list is the evidence.
        const resolution = await resolver.resolve({
          baseUrl,
          credential: stored,
          timeoutMs: this.timeoutMs
        })
        authStrategyDetected = resolution.strategy.id
        loginFieldNames = resolution.loginFieldNames
        loginTokenPresent = resolution.session.token !== undefined
        client.adoptSession(resolution.session, resolution.strategy)

        notes.push(
          `认证方式已确认：${resolution.strategy.label}（策略 id: ${resolution.strategy.id}）。` +
            `该结论已按设备持久化，后续启动不再重复探测。`
        )
        notes.push(
          `登录响应字段：${loginFieldNames.length > 0 ? loginFieldNames.join(', ') : '（无 JSON 字段，可能是空响应或表单响应）'}`
        )
      } catch (error) {
        // A failed resolution still yields the observed payload shape; report it
        // rather than losing the only diagnostic evidence we have.
        loginFieldNames = resolver.lastLoginFieldNames
        notes.push(
          `认证探测失败：${error instanceof Error ? error.message : String(error)}。` +
            `后续需要认证的端点将无法验证，请先确认用户名密码。`
        )
        if (loginFieldNames.length > 0) {
          notes.push(
            `尽管认证失败，已捕获登录响应字段：${loginFieldNames.join(', ')}。` +
              `若其中存在疑似 Token 字段但不在已知别名内，需要扩展 auth-strategy.ts 的别名列表。`
          )
        }
      }
    }

    // ---- 2. Structured endpoints -----------------------------------------
    const structured: ProbeSpec[] = [
      { path: ENDPOINTS.getDevInfo, method: 'GET', purpose: '设备身份与版本，用于确认上报字段' },
      { path: ENDPOINTS.getNetwork, method: 'GET', purpose: '网络参数，确认端口字段语义（风险 7）' },
      { path: ENDPOINTS.getPassageway, method: 'GET', purpose: '8 通道配置结构与 sensor_type' },
      { path: ENDPOINTS.getSamplingRate, method: 'GET', purpose: '采样率数值单位（Hz 还是 kHz）' },
      { path: ENDPOINTS.getAlarmSystem, method: 'GET', purpose: '告警参数真实字段名（dalFBETThre 等）' },
      { path: ENDPOINTS.getTimeSet, method: 'GET', purpose: '时间 / NTP 字段' },
      { path: ENDPOINTS.getRs485, method: 'GET', purpose: 'RS485 配置字段' },
      { path: ENDPOINTS.getModbusPara, method: 'GET', purpose: 'Modbus 配置字段' },
      { path: ENDPOINTS.getDatePush, method: 'GET', purpose: 'Push 配置，确认 heartbeat/feature 地址字段（风险 4）' },
      { path: ENDPOINTS.getAudio, method: 'PUT', purpose: '音频库条目结构，确认 record id / audio_path', body: {} },
      { path: ENDPOINTS.getAlarmAudio, method: 'PUT', purpose: '告警录音条目结构', body: {} }
    ]

    for (const spec of structured) {
      endpoints.push(await this.probeEndpoint(client, spec))
    }

    // ---- 3. Stream framing (risks 2 and 3) --------------------------------
    // These endpoints do not terminate. The probe reads just enough to capture
    // the framing signature, then abandons the response.
    const streams: ProbeSpec[] = [
      {
        path: ENDPOINTS.featuresStream,
        method: 'GET',
        purpose: '实时特征：确认是 chunked JSON 行、SSE 还是 WebSocket 升级（风险 2）',
        captureBytes: SAMPLE_BYTES
      },
      {
        path: ENDPOINTS.audioStream,
        method: 'GET',
        purpose: '实时 PCM：确认 framing 与采样格式，决定解码器实现（风险 2，最高优先级）',
        captureBytes: SAMPLE_BYTES
      },
      {
        path: ENDPOINTS.freqDomain,
        method: 'GET',
        purpose: '频域数据：确认 payload 结构，协议文档缺失（风险 3）',
        captureBytes: SAMPLE_BYTES
      },
      {
        path: ENDPOINTS.timeFreqDomain,
        method: 'GET',
        purpose: '时频域数据：确认 payload 结构，协议文档缺失（风险 3）',
        captureBytes: SAMPLE_BYTES
      }
    ]

    for (const spec of streams) {
      endpoints.push(await this.probeEndpoint(client, spec))
    }

    // ---- 4. Recording download rule (risk 6) ------------------------------
    // Derive a filename from whatever /get_audio returned and try the
    // documented download path shape. A 200 with an audio content-type
    // confirms the rule; a 404 pinpoints that the path shape is wrong.
    const audioProbe = endpoints.find((result) => result.path === ENDPOINTS.getAudio)
    const candidateFilename = findFirstFilename(audioProbe?.json)
    if (candidateFilename) {
      endpoints.push(
        await this.probeEndpoint(client, {
          path: `/audio_file/${encodeURIComponent(candidateFilename)}`,
          method: 'GET',
          purpose: `录音下载路径规则验证（风险 6），使用库中发现的文件名 ${candidateFilename}`,
          captureBytes: 64
        })
      )
      notes.push(
        `录音下载探测使用了 /get_audio 返回的真实文件名 ${candidateFilename}。` +
          `若返回 200 且 content-type 为 audio/*，则 /audio_file/{filename} 规则成立。`
      )
    } else {
      notes.push(
        '未能从 /get_audio 响应中解析出文件名，跳过录音下载路径验证（风险 6）。' +
          '可先在设备上产生一条录音，再重新运行诊断。'
      )
    }

    // ---- 5. Interpretation ------------------------------------------------
    notes.push(...interpret(endpoints, authStrategyDetected))

    const report: DiagnoseReport = {
      deviceId: device.id,
      startedAt,
      finishedAt: Date.now(),
      loginTokenPresent,
      loginFieldNames,
      endpoints,
      notes
    }
    if (authStrategyDetected) report.authStrategyDetected = authStrategyDetected

    deviceLog().info('Protocol diagnosis complete', {
      deviceId: device.id,
      authStrategyDetected,
      endpointCount: endpoints.length
    })

    return report
  }

  /**
   * Probe one endpoint and capture a response signature.
   * Never throws: a failure is data too, so it is returned in the result.
   *
   * Two code paths, because the semantics genuinely differ:
   *   - `captureBytes` set  -> streaming endpoint: read a bounded prefix and
   *     abandon the response. This is the only way to characterise a feed that
   *     never terminates.
   *   - otherwise           -> ordinary request/response.
   */
  async probeEndpoint(client: DeviceApiClient, spec: ProbeSpec): Promise<EndpointProbeResult> {
    const result: EndpointProbeResult = { path: spec.path, method: spec.method, ok: false }

    let url: string
    let headers: Record<string, string>
    try {
      url = client.buildStreamUrl(spec.path)
      headers = client.authHeaderForStream()
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
      return result
    }

    // ---- Streaming path ---------------------------------------------------
    if (spec.captureBytes) {
      const signature = await this.transport.captureStream({
        method: spec.method,
        url,
        headers,
        maxBytes: spec.captureBytes,
        // Short window: we only need the first chunk to determine framing.
        timeoutMs: 3_000
      })

      result.status = signature.status || undefined
      result.latencyMs = signature.latencyMs
      result.contentType = signature.contentType
      result.chunked = signature.chunked
      result.receivedBytes = signature.bytes.length
      // A stream that was still flowing when the window closed is a SUCCESS:
      // we learned the framing, which is the entire objective.
      result.ok = signature.ok
      if (signature.error) result.error = signature.error

      if (signature.bytes.length > 0) {
        result.sampleHex = toHex(signature.bytes)
        result.sampleAscii = toAscii(signature.bytes)
        const parsed = tryParseJsonPrefix(signature.contentType, signature.bytes)
        if (parsed !== undefined) result.json = parsed
      } else if (signature.ok) {
        result.error =
          '已建立连接但在采样窗口内未收到任何字节，可能是该端点需要先通过其他接口启动推流'
      }
      return result
    }

    // ---- Ordinary request/response path -----------------------------------
    try {
      // A download probe only needs the status, the headers and a magic-number
      // prefix. Reading the whole file would buffer an entire recording.
      const isDownloadProbe = spec.path.startsWith('/audio_file/')

      const response = await this.transport.request({
        method: spec.method,
        url,
        headers,
        ...(spec.body !== undefined && spec.method !== 'GET' ? { json: spec.body } : {}),
        timeoutMs: this.timeoutMs,
        throwOnHttpError: false,
        binary: true,
        ...(isDownloadProbe ? { maxBytes: 64 } : {})
      })

      result.ok = response.ok
      result.status = response.status
      result.latencyMs = response.latencyMs
      result.contentType = response.contentType
      result.chunked =
        (response.headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked') ||
        response.headers['transfer-encoding'] === undefined

      if (response.bytes && response.bytes.length > 0) {
        result.sampleHex = toHex(response.bytes.subarray(0, SAMPLE_BYTES))
        result.sampleAscii = toAscii(response.bytes.subarray(0, SAMPLE_BYTES))
        result.receivedBytes = response.bytes.length
      }

      // Only attempt JSON parsing for responses that declare JSON. Raw PCM must
      // never be fed to JSON.parse.
      if (response.contentType.includes('json') && response.text) {
        try {
          result.json = JSON.parse(response.text)
        } catch {
          result.json = undefined
        }
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
    }

    return result
  }

  /** Ad-hoc single-endpoint probe for the Protocol Lab UI. */
  async probeCustomPath(client: DeviceApiClient, path: string, method: 'GET' | 'POST' | 'PUT'): Promise<EndpointProbeResult> {
    const normalised = path.startsWith('/') ? path : `/${path}`
    return this.probeEndpoint(client, {
      path: normalised,
      method,
      purpose: '手动探测',
      captureBytes: SAMPLE_BYTES
    })
  }

  /** Every auth candidate, for reference in the UI. */
  listStrategies(): Array<{ id: string; label: string }> {
    return CANDIDATE_STRATEGIES.map((strategy) => ({ id: strategy.id, label: strategy.label }))
  }
}

// ---------------------------------------------------------------------------
// Interpretation — turn measurements into actionable conclusions
// ---------------------------------------------------------------------------

function interpret(endpoints: EndpointProbeResult[], authStrategy?: string): string[] {
  const notes: string[] = []
  const byPath = new Map(endpoints.map((result) => [result.path, result]))

  // Risk 1 — token carrier.
  notes.push(
    authStrategy
      ? `风险 1（Token 携带方式）：已确认使用 ${authStrategy}，DeviceAuthStrategy 已按此实现并缓存。`
      : '风险 1（Token 携带方式）：未能确认，请检查凭据或设备登录接口。'
  )

  // Risk 2 — /audio_stream framing.
  const audio = byPath.get(ENDPOINTS.audioStream)
  if (audio) {
    notes.push(`风险 2（/audio_stream framing）：${describeFraming(audio)}`)
  }

  const features = byPath.get(ENDPOINTS.featuresStream)
  if (features) {
    notes.push(`风险 2（/features_stream framing）：${describeFraming(features)}`)
  }

  // Risk 3 — spectrum schemas.
  for (const path of [ENDPOINTS.freqDomain, ENDPOINTS.timeFreqDomain]) {
    const result = byPath.get(path)
    if (!result) continue
    const fieldNames = result.json ? collectFieldNames(result.json) : []
    notes.push(
      fieldNames.length > 0
        ? `风险 3（${path}）：字段为 ${fieldNames.slice(0, 16).join(', ')}${fieldNames.length > 16 ? ` …共 ${fieldNames.length} 个` : ''}`
        : `风险 3（${path}）：${describeFraming(result)}——若为二进制，需要按固定结构体解析，请补充协议文档。`
    )
  }

  // Risk 6 — download rule.
  const download = endpoints.find((result) => result.path.startsWith('/audio_file/'))
  if (download) {
    notes.push(
      download.ok && (download.contentType ?? '').includes('audio')
        ? `风险 6（录音下载路径）：/audio_file/{filename} 规则成立（content-type: ${download.contentType}）。`
        : `风险 6（录音下载路径）：/audio_file/{filename} 返回 ${download.status ?? '错误'}，` +
            `说明 URL 拼接规则或认证方式与文档样例不同，需要进一步确认。`
    )
  }

  // Risk 7 — port semantics.
  const network = byPath.get(ENDPOINTS.getNetwork)
  if (network?.json) {
    const fields = collectFieldNames(network.json)
    const portFields = fields.filter((field) => field.toLowerCase().includes('port'))
    if (portFields.length > 0) {
      notes.push(
        `风险 7（端口字段）：get_network 返回 ${portFields.join(', ')}。` +
          `若其中出现 0，需要向固件方确认 0 是"使用默认值"还是"未配置"。`
      )
    }
  }

  // Risk 4 — push payload identity.
  const push = byPath.get(ENDPOINTS.getDatePush)
  if (push?.json) {
    const fields = collectFieldNames(push.json)
    const hasDeviceId = fields.some((field) => /device_?id|sn|mac/i.test(field))
    notes.push(
      hasDeviceId
        ? '风险 4（Push 设备标识）：/get_date_push 配置中出现了设备标识相关字段。'
        : '风险 4（Push 设备标识）：未在 /get_date_push 中发现 device_id/SN/MAC 字段。' +
            '公网 Server 模式前必须由固件补充稳定 device_id（规格书 15.2）。'
    )
  }

  return notes
}

/** Turn a captured signature into a plain-language framing conclusion. */
function describeFraming(result: EndpointProbeResult): string {
  if (result.error && !result.status) return `未能取得响应（${result.error}）`

  const contentType = result.contentType ?? '(未声明)'
  const chunked = result.chunked ? 'chunked' : '非 chunked'
  const firstBytes = result.sampleAscii?.slice(0, 48).replace(/\s+/g, ' ') ?? ''

  if (contentType.includes('json')) {
    return `HTTP ${result.status}, ${contentType}, ${chunked}，正文疑似 JSON 流。起始内容：${firstBytes}`
  }
  if (contentType.includes('event-stream')) {
    return `HTTP ${result.status}, SSE (text/event-stream)，应使用 EventSource 语义逐行解析。`
  }
  if (contentType.includes('audio') || contentType.includes('octet-stream')) {
    return (
      `HTTP ${result.status}, ${contentType}, ${chunked}，正文为二进制。` +
      `前 ${result.receivedBytes ?? 0} 字节已采样，` +
      `需按已知的 Float PCM 说明（每 100 ms 推送 100 ms 数据）确定字节序与声道交织方式。`
    )
  }
  return `HTTP ${result.status}, ${contentType}, ${chunked}。起始内容：${firstBytes}`
}

// ---------------------------------------------------------------------------
// Byte formatting helpers
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
}

function toAscii(bytes: Uint8Array): string {
  return [...bytes].map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.')).join('')
}

/**
 * Best-effort JSON parse of a captured stream prefix.
 *
 * A chunked JSON-lines feed is truncated mid-object by design, so a plain
 * `JSON.parse` will fail on almost every real capture. Try a complete parse
 * first; otherwise salvage the first COMPLETE line, which is enough to show the
 * field names — and field names are what risk 2 and risk 3 actually need.
 */
function tryParseJsonPrefix(contentType: string, bytes: Uint8Array): unknown {
  if (!contentType.includes('json')) return undefined
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)

  try {
    return JSON.parse(text)
  } catch {
    // Fall through to line salvage.
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim().replace(/^data:\s*/, '')
    if (trimmed === '' || !trimmed.startsWith('{')) continue
    try {
      return JSON.parse(trimmed)
    } catch {
      continue
    }
  }
  return undefined
}

/** Find a plausible audio filename anywhere in an /get_audio payload. */
function findFirstFilename(payload: unknown, depth = 0): string | undefined {
  if (depth > 5 || payload === null || typeof payload !== 'object') return undefined

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findFirstFilename(item, depth + 1)
      if (found) return found
    }
    return undefined
  }

  const record = payload as Record<string, unknown>
  for (const key of ['file_name', 'fileName', 'audio_path', 'audioPath', 'path', 'name']) {
    const value = record[key]
    if (typeof value === 'string' && /\.(wav|flac|mp3|pcm)$/i.test(value)) {
      // Device paths may be absolute; the download URL only needs the basename.
      return value.split(/[/\\]/).pop()
    }
  }
  for (const value of Object.values(record)) {
    const found = findFirstFilename(value, depth + 1)
    if (found) return found
  }
  return undefined
}
