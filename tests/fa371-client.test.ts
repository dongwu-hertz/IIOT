/**
 * Fa371ApiClient 单元测试。
 *
 * 用**假的 transport**（实现 `HttpTransport` 接口）而不是真 socket：
 * 这个客户端要验的是"发对了什么、怎么解读包络、401 时怎么办"，
 * 全部都能在请求记录上断言。唯一的"设备行为"由 `createDevice()` 模拟，
 * 它复现手册里三条已知怪癖：
 *   1. 登录响应只有 `{token}`，**没有** `ret`/`msg`（§2.1）；
 *   2. 有些接口（`/system/detect_status`、`/system_time`）也**没有** `ret`/`msg`（§5.1.16/§5.1.20）；
 *   3. `ret: -1` 是业务失败（§5.1.14/§5.1.25/§5.1.29/§5.1.32）。
 *
 * 认证部分按规格 §8.1 A1 的**最高风险项**设计：假设备只接受某一种携带方式，
 * 其余一律 401——和 `tests/auth-resolver.test.ts` 的思路一致，
 * 因为"猜错了 Token 怎么带"是本设备族最容易整晚调不出来的问题。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { createHash } from 'node:crypto'

import {
  FA371_AUTH_CANDIDATES,
  Fa371ApiClient,
  type Fa371ApiClientOptions
} from '../src/main/services/device/fa371/fa371-api-client'
import { AppError } from '../src/shared/errors'
import { mapDetectLogs } from '../src/main/services/device/fa371/mappers'
import type {
  HttpRequestOptions,
  HttpResponse,
  HttpTransport
} from '../src/main/services/device/http-transport'

// ---------------------------------------------------------------------------
// 假 transport
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
  json: unknown
  rawBody: unknown
  binary: boolean
  timeoutMs: number | undefined
  hasSignal: boolean
}

type Handler = (request: RecordedRequest) => HttpResponse

class FakeTransport implements HttpTransport {
  readonly requests: RecordedRequest[] = []

  constructor(private readonly handler: Handler) {}

  async request(options: HttpRequestOptions & { binary?: boolean }): Promise<HttpResponse> {
    const request: RecordedRequest = {
      method: options.method,
      url: options.url,
      headers: { ...(options.headers ?? {}) },
      json: options.json,
      rawBody: options.rawBody,
      binary: options.binary === true,
      timeoutMs: options.timeoutMs,
      hasSignal: options.signal !== undefined
    }
    this.requests.push(request)
    return this.handler(request)
  }

  /** FA371 的 HTTP 接口没有流式响应，用到就是测试写错了。 */
  async captureStream(): Promise<never> {
    throw new Error('FA371 HTTP 接口不使用 captureStream')
  }
}

function jsonResponse(payload: unknown, status = 200): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {},
    contentType: 'application/json',
    json: payload,
    text: JSON.stringify(payload),
    latencyMs: 1
  }
}

function binaryResponse(bytes: Uint8Array, contentType = 'image/jpeg', status = 200): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {},
    contentType,
    bytes,
    latencyMs: 1
  }
}

function statusResponse(status: number): HttpResponse {
  return {
    status,
    ok: false,
    headers: {},
    contentType: 'application/json',
    text: `{"code":${status}}`,
    latencyMs: 1
  }
}

// ---------------------------------------------------------------------------
// 假设备
// ---------------------------------------------------------------------------

const TOKEN = 'FA371-TEST-TOKEN'
/** 手册 §2.1：password = md5(明文 + 'lfxs')，32 位小写。 */
const PASSWORD_HASH = createHash('md5').update('123456lfxs', 'utf8').digest('hex')

interface DeviceOptions {
  /** 判定请求是否已认证。默认只接受裸 `Authorization: <token>`（§2.2 字面读法）。 */
  acceptAuth?: (headers: Record<string, string>) => boolean
  /** 覆盖端点响应，键形如 `"PUT /system/leakage"`。 */
  respond?: Record<string, unknown | (() => HttpResponse)>
  /**
   * 覆盖端点响应为一个完整 `HttpResponse`。
   *
   * `respond` 只能给 JSON 正文，而真机上有一种响应根本不是 JSON：未定义路径返回
   * SPA 的 `index.html`（HTTP 200）。要复现它就必须能造出"text 有值、json 没有"
   * 的响应。
   */
  respondRaw?: Record<string, HttpResponse>
  /** 让第 n 个受保护请求返回 401（0 基），用来驱动 401 -> 重登 -> 重试。 */
  unauthorizedProtectedIndexes?: number[]
}

function createDevice(options: DeviceOptions = {}): {
  transport: FakeTransport
  loginCount: () => number
} {
  const accept = options.acceptAuth ?? ((headers) => headers.Authorization === TOKEN)
  let logins = 0
  let protectedCount = 0

  const transport = new FakeTransport((request) => {
    const url = new URL(request.url)

    // §2.1：登录响应只有 token，没有 ret/msg。
    if (url.pathname === '/login') {
      logins += 1
      return jsonResponse({ token: TOKEN })
    }

    const protectedIndex = protectedCount
    protectedCount += 1
    if (options.unauthorizedProtectedIndexes?.includes(protectedIndex)) return statusResponse(401)
    if (!accept(request.headers)) return statusResponse(401)

    const override = options.respond?.[`${request.method} ${url.pathname}`]
    if (override !== undefined) {
      return typeof override === 'function' ? (override as () => HttpResponse)() : jsonResponse(override)
    }

    const raw = options.respondRaw?.[`${request.method} ${url.pathname}`]
    if (raw !== undefined) return raw

    // 默认响应：复现手册里"没有 ret/msg"的两个接口（§5.1.16 / §5.1.20），
    // 以及一个正常的配置读取（§5.1.2）。
    if (url.pathname === '/system/detect_status') return jsonResponse({ detect_status: 0 })
    if (url.pathname === '/system_time') return jsonResponse({ sys_time: 17220332 })
    if (url.pathname === '/system/acoustic') {
      return jsonResponse({ freq_up_limit: 25, freq_down_limit: 20, samplerate: 96000, ret: 200, msg: 'SUCCESS' })
    }
    return jsonResponse({ ret: 200, msg: 'SUCCESS' })
  })

  return { transport, loginCount: () => logins }
}

interface SetupOptions {
  device?: DeviceOptions
  client?: Partial<
    Pick<
      Fa371ApiClientOptions,
      | 'loginEnvelope'
      | 'imagingTargetKey'
      | 'strategyDiagnosisKey'
      | 'idListBody'
      | 'alarmConditionUpdateId'
      | 'detectLogsQueryStyle'
      | 'preferredStrategyId'
      | 'timeoutMs'
    >
  >
}

function setup(options: SetupOptions = {}): {
  client: Fa371ApiClient
  requests: RecordedRequest[]
  loginCount: () => number
  established: string[]
} {
  const device = createDevice(options.device)
  const established: string[] = []
  const client = new Fa371ApiClient({
    transport: device.transport,
    baseUrl: '192.168.2.168',
    credential: { username: 'admin', password: '123456' },
    onSessionEstablished: (strategyId) => established.push(strategyId),
    ...options.client
  })
  return {
    client,
    requests: device.transport.requests,
    loginCount: device.loginCount,
    established
  }
}

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

function last(requests: RecordedRequest[]): RecordedRequest {
  const request = requests.at(-1)
  assert.ok(request, '没有发出任何请求')
  return request
}

function assertLast(
  requests: RecordedRequest[],
  expected: { method: string; url: string; json?: unknown }
): RecordedRequest {
  const request = last(requests)
  assert.equal(request.method, expected.method, `上一个请求应为 ${expected.method}`)
  assert.equal(request.url, expected.url)
  if ('json' in expected) assert.deepEqual(request.json, expected.json)
  return request
}

function countPath(requests: RecordedRequest[], path: string): number {
  return requests.filter((request) => new URL(request.url).pathname === path).length
}

function rejectsWithCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AppError, `期望 AppError，实际是 ${String(error)}`)
    assert.equal(error.code, code)
    return true
  }
}

// ---------------------------------------------------------------------------
// 夹具（手册 §5.1.23 / §5.1.27 的字段表）
// ---------------------------------------------------------------------------

const BASE = 'http://192.168.2.168'

const STRATEGY_BODY = {
  name: 'Strategy One',
  alias: 'nick',
  alarm_id: 2,
  level: 2,
  interval_time: 60,
  times: 3,
  timeout_duration: 10,
  sensitivity: 0.8,
  diagosisn: 'note'
}

const CONDITION_BODY = {
  name: 'Condition 1',
  decibel_thr: 90,
  db_arithmetic_operator: 3,
  db_switch: 1,
  dominant_freq_thr: 1200,
  df_arithmetic_operator: 0,
  df_switch: 1,
  df_logical_operator: 1,
  noise_comparison_file_id: 5,
  noise_comparison_thr: 0.85,
  nc_switch: 0,
  nc_logical_operator: 0,
  nc_arithmetic_operator: 1,
  discharge_switch: '1',
  discharge_logical_operator: 1,
  discharge_type: 4,
  notes: 'x'
}

// ---------------------------------------------------------------------------
// 认证与会话（规格 §2）
// ---------------------------------------------------------------------------

describe('FA371 client: 认证与会话', () => {
  it('登录体是手册 §2.1 的裸对象，密码是 md5(明文 + lfxs)', async () => {
    const { client, requests, established } = setup()

    const acoustic = await client.getAcousticConfig()
    assert.equal(acoustic.samplerate, 96000)

    const login = requests[0]
    assert.ok(login)
    assert.equal(login.method, 'POST')
    assert.equal(login.url, `${BASE}/login`)
    assert.deepEqual(login.json, { username: 'admin', password: PASSWORD_HASH })
    // 手册的密码派生必须真的接上 auth-strategy，而不是另写一份。
    assert.equal(PASSWORD_HASH.length, 32)
    assert.equal(PASSWORD_HASH, PASSWORD_HASH.toLowerCase())

    // 登录 -> 验证 -> 业务请求
    assert.equal(requests.length, 3)
    const verify = requests[1]
    assert.ok(verify)
    assert.equal(verify.url, `${BASE}/system/detect_status`)
    assert.equal(verify.headers.Authorization, TOKEN)
    assert.equal(verify.json, undefined, '只读请求不应带请求体')

    assertLast(requests, { method: 'GET', url: `${BASE}/system/acoustic`, json: undefined })
    assert.equal(client.resolvedStrategyId, 'raw-auth-header')
    assert.deepEqual(established, ['raw-auth-header'])
  })

  it('裸 token 被拒时按 §9.1 顺序回落到 Bearer，并只保留胜出的方式', async () => {
    const { client, requests, established } = setup({
      device: { acceptAuth: (headers) => headers.Authorization === `Bearer ${TOKEN}` }
    })

    await client.getDetectStatus()

    assert.equal(client.resolvedStrategyId, 'bearer-header')
    assert.deepEqual(established, ['bearer-header'])
    // 每个候选各登录一次：裸 token 失败、Bearer 成功。
    assert.equal(countPath(requests, '/login'), 2)
    assert.equal(FA371_AUTH_CANDIDATES[0]?.id, 'raw-auth-header')
    assert.equal(FA371_AUTH_CANDIDATES[1]?.id, 'bearer-header')
    assert.equal(FA371_AUTH_CANDIDATES[2]?.id, 'token-header')
  })

  it('自定义头 token: 也被尝试（§8.1 A2）', async () => {
    const { client, requests } = setup({
      device: { acceptAuth: (headers) => headers.token === TOKEN }
    })

    await client.getDetectStatus()

    assert.equal(client.resolvedStrategyId, 'token-header')
    assert.equal(countPath(requests, '/login'), 3, '前两个候选应各失败一次')
  })

  it('首选候选（已持久化的 strategy id）排在最前，只登录一次', async () => {
    const { client, requests } = setup({
      client: { preferredStrategyId: 'bearer-header' },
      device: { acceptAuth: (headers) => headers.Authorization === `Bearer ${TOKEN}` }
    })

    await client.getDetectStatus()

    assert.equal(client.resolvedStrategyId, 'bearer-header')
    assert.equal(countPath(requests, '/login'), 1)
  })

  it('所有携带方式都被拒时抛 AUTH_FAILED，并列出尝试记录', async () => {
    const { client, established } = setup({ device: { acceptAuth: () => false } })

    await assert.rejects(
      () => client.getDetectStatus(),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'AUTH_FAILED')
        assert.match(error.detail ?? '', /raw-auth-header/)
        assert.match(error.detail ?? '', /token-header/)
        return true
      }
    )
    assert.deepEqual(established, [], '失败的解析不能触发持久化回调')
  })

  it('429/500 这类非 401 失败不触发登录探测（网络层失败直接上抛）', async () => {
    const { client, requests } = setup({
      device: {
        respond: {
          'GET /system/acoustic': () => statusResponse(500)
        }
      }
    })

    await assert.rejects(() => client.getAcousticConfig(), rejectsWithCode('DEVICE_ERROR'))
    assert.equal(countPath(requests, '/login'), 1, '不应为了 500 重新登录')
  })

  it('登录本身被拒时报 AUTH_FAILED', async () => {
    const client = new Fa371ApiClient({
      transport: {
        request: async () => statusResponse(401),
        captureStream: async () => {
          throw new Error('unused')
        }
      } as unknown as HttpTransport,
      baseUrl: '192.168.2.168',
      credential: { username: 'admin', password: 'wrong' }
    })

    await assert.rejects(() => client.getDetectStatus(), rejectsWithCode('AUTH_FAILED'))
  })

  it('authHeaders() 暴露已解析的携带方式（供 §8.4 D1 的 WebSocket 握手复用）', async () => {
    const { client } = setup()
    assert.deepEqual(client.authHeaders(), {}, '未登录时不应凭空造头')

    await client.getDetectStatus()
    assert.deepEqual(client.authHeaders(), { Authorization: TOKEN })
  })

  it('ping() 不抛异常', async () => {
    const ok = setup()
    assert.equal(await ok.client.ping(), true)

    const broken = setup({ device: { acceptAuth: () => false } })
    assert.equal(await broken.client.ping(), false)
  })

  it('setBaseUrl / invalidateSession 会改变后续请求', async () => {
    const { client, requests } = setup()
    await client.getDetectStatus()
    client.setBaseUrl('192.168.2.169:8080')
    await client.getDetectStatus()

    assert.ok(requests.some((request) => request.url.startsWith('http://192.168.2.169:8080')))
  })

  it('login() 强制重新认证', async () => {
    const { client, requests, loginCount } = setup()
    await client.getDetectStatus()
    assert.equal(loginCount(), 1)

    await client.login()
    assert.equal(loginCount(), 2)
    // 第一次调用 3 个请求（login/verify/call），强制登录再加 2 个（login/verify）。
    assert.equal(requests.length, 5)
  })
})

// ---------------------------------------------------------------------------
// 401 只重登一次（规格 §2.3）
// ---------------------------------------------------------------------------

describe('FA371 client: 401 处理', () => {
  it('业务请求 401 时重新登录一次并重试成功', async () => {
    // 受保护请求顺序：0 = 认证探测，1 = 业务请求（401），2 = 重登后的探测，3 = 重试
    const { client, requests, loginCount } = setup({
      device: { unauthorizedProtectedIndexes: [1] }
    })

    const status = await client.getDetectStatus()
    assert.equal(status.detect_status, 0)
    assert.equal(loginCount(), 2, '401 只应触发一次重新登录')
    assert.equal(countPath(requests, '/detect_status'), 0)
    assert.equal(countPath(requests, '/system/detect_status'), 4)
  })

  it('持续 401 时抛 AUTH_FAILED，不无限重试', async () => {
    const { client, loginCount } = setup({
      device: { unauthorizedProtectedIndexes: [1, 3] }
    })

    await assert.rejects(() => client.getDetectStatus(), rejectsWithCode('AUTH_FAILED'))
    assert.equal(loginCount(), 2, '第二次 401 之后不得再登录')
  })
})

// ---------------------------------------------------------------------------
// ret / msg 包络（规格 §1、§8.2 B3）
// ---------------------------------------------------------------------------

describe('FA371 client: 包络处理', () => {
  it('ret: -1 是业务失败，抛 DEVICE_ERROR 并带出 msg 与路径', async () => {
    const { client } = setup({
      device: {
        respond: {
          'PUT /system/leakage': { ret: -1, msg: '当前策略为开启状态，修改失败' }
        }
      }
    })

    await assert.rejects(
      () => client.setLeakageConfig({ leakage_unit: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'DEVICE_ERROR')
        assert.match(error.message, /当前策略为开启状态/)
        assert.match(error.detail ?? '', /system\/leakage/)
        assert.match(error.detail ?? '', /ret=-1/)
        return true
      }
    )
  })

  it('ret 缺失的接口按成功处理（§5.1.16 / §5.1.20 / §5.1.15）', async () => {
    const { client } = setup()

    const status = await client.getDetectStatus()
    assert.deepEqual(status, { detect_status: 0 })

    const time = await client.getSystemTime()
    assert.deepEqual(time, { sys_time: 17220332 })

    // §5.1.15 turn_off_detect 无响应内容。
    await client.stopDetection()
  })

  /**
   * REGRESSION GUARD, from a real device (192.168.110.235, 2026-09).
   *
   * The FA371's web UI is a single-page app whose catch-all route answers
   * `200 OK` with `index.html` for EVERY undefined path — so `GET /get_devinfo`
   * comes back looking like a perfectly successful response.
   *
   * Without an explicit guard two things go wrong at once, and neither is visible:
   * `response.json` is `undefined`, which `unwrap` would hand to the caller as a
   * success ("the read worked and returned nothing"), and the body has no `ret`,
   * which three documented endpoints legitimately use to mean success — so the
   * envelope check cannot catch it either. The client must refuse the body.
   */
  it('200 + 网页被拒绝，不当成成功响应（真机：未定义路径返回 SPA 的 index.html）', async () => {
    const html = '<!doctype html><html lang="en"><head><title>UI</title></head><body></body></html>'
    // The HTML is served for a READ, not for the session-verification call: when
    // the verify path itself answers with a web page the strategy is simply
    // rejected (AUTH_FAILED), which is a different — and already covered — path.
    // What is asserted here is that a normal authenticated read refuses the body
    // instead of reporting "success, no data".
    const { client } = setup({
      device: {
        respondRaw: {
          'GET /system/acoustic': {
            status: 200,
            ok: true,
            headers: {},
            contentType: 'text/html',
            text: html,
            latencyMs: 1
          }
        }
      }
    })

    await assert.rejects(
      () => client.getAcousticConfig(),
      rejectsWithCode('INVALID_RESPONSE')
    )
  })

  it('非 200 且非 -1 的 ret 也算失败（§8.2 B3 其余失败码未定义）', async () => {
    const { client } = setup({
      device: { respond: { 'GET /run_mode': { ret: 500, msg: 'unknown failure' } } }
    })

    await assert.rejects(() => client.getRunMode(), rejectsWithCode('DEVICE_ERROR'))
  })

  it('HTTP 非 2xx 抛 DEVICE_ERROR（且不带业务失败措辞）', async () => {
    const { client } = setup({
      device: { respond: { 'GET /system/video': () => statusResponse(503) } }
    })

    await assert.rejects(
      () => client.getVideoConfig(),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'DEVICE_ERROR')
        assert.match(error.message, /HTTP 503/)
        return true
      }
    )
  })

  it('transport 的网络错误原样传播', async () => {
    const client = new Fa371ApiClient({
      transport: {
        request: async (options: HttpRequestOptions) => {
          if (options.url.endsWith('/login')) return jsonResponse({ token: TOKEN })
          if (options.url.endsWith('/system/detect_status')) return jsonResponse({ detect_status: 0 })
          throw new AppError('NETWORK_ERROR', '无法连接到设备')
        },
        captureStream: async () => {
          throw new Error('unused')
        }
      } as unknown as HttpTransport,
      baseUrl: '192.168.2.168',
      credential: { username: 'admin', password: '123456' }
    })

    await assert.rejects(() => client.getAcousticConfig(), rejectsWithCode('NETWORK_ERROR'))
  })
})

// ---------------------------------------------------------------------------
// 写接口：路径 + 方法 + 请求体（规格 §5.1 的承诺面）
// ---------------------------------------------------------------------------

describe('FA371 client: 写接口报文', () => {
  it('配置类写入逐字匹配手册路径与字段名', async () => {
    const { client, requests } = setup()

    await client.setAcousticConfig({ freq_up_limit: 25, freq_down_limit: 20, samplerate: 132000 })
    assertLast(requests, {
      method: 'PUT',
      url: `${BASE}/system/acoustic`,
      json: { freq_up_limit: 25, freq_down_limit: 20, samplerate: 132000 }
    })

    await client.setImagingConfig({ energy_threshold: 25, imaging_sensitivity: 1, imaging_enhance: 0 })
    assertLast(requests, {
      method: 'PUT',
      url: `${BASE}/system/image`,
      json: { energy_threshold: 25, imaging_sensitivity: 1, imaging_enhance: 0 }
    })

    await client.setVideoConfig({ video_bit_rate: 4096, video_fps: 30, rtsp_enabled: 1 })
    assertLast(requests, {
      method: 'PUT',
      url: `${BASE}/system/video`,
      json: { video_bit_rate: 4096, video_fps: 30, rtsp_enabled: 1 }
    })

    await client.setRunMode({ run_mode: 1 })
    assertLast(requests, { method: 'PUT', url: `${BASE}/run_mode`, json: { run_mode: 1 } })

    await client.setLeakageConfig({ cost_display: 1, leakage_unit: 1, leakage_distance: 5 })
    assertLast(requests, {
      method: 'PUT',
      url: `${BASE}/system/leakage`,
      json: { cost_display: 1, leakage_unit: 1, leakage_distance: 5 }
    })

    await client.setScanArea({
      areas: [
        {
          area_height: 432,
          area_width: 768,
          detect_area_status: 1,
          left_top_x: 576,
          left_top_y: 324
        }
      ],
      center_focus: 1
    })
    assertLast(requests, {
      method: 'PUT',
      url: `${BASE}/system/scan_area`,
      json: {
        areas: [
          { area_height: 432, area_width: 768, detect_area_status: 1, left_top_x: 576, left_top_y: 324 }
        ],
        center_focus: 1
      }
    })

    await client.setSystemTime({ time: 12345678 })
    assertLast(requests, {
      method: 'PUT',
      url: `${BASE}/time_set_manually`,
      json: { time: 12345678 }
    })
  })

  it('检测启停：POST 且无请求体', async () => {
    const { client, requests } = setup({
      device: { respond: { 'POST /turn_on_detect': { detect_id: 1, ret: 200, msg: 'SUCCESS' } } }
    })

    const started = await client.startDetection()
    assert.equal(started.detect_id, 1)
    assertLast(requests, { method: 'POST', url: `${BASE}/turn_on_detect`, json: undefined })

    await client.stopDetection()
    assertLast(requests, { method: 'POST', url: `${BASE}/turn_off_detect`, json: undefined })
  })

  it('成像目标数量的键名可切换（§8.3 C2）', async () => {
    const { client, requests } = setup()
    await client.getDetectStatus()

    await client.setImagingConfig({ energy_threshold: 25 }, { targetCount: 2 })
    assertLast(requests, {
      method: 'PUT',
      url: `${BASE}/system/image`,
      json: { energy_threshold: 25, target_number: 2 }
    })

    await client.setImagingConfig({ energy_threshold: 25 }, { targetCount: 2, targetCountKey: 'target_numbe' })
    assertLast(requests, {
      method: 'PUT',
      url: `${BASE}/system/image`,
      json: { energy_threshold: 25, target_numbe: 2 }
    })

    await client.setImagingConfig({ energy_threshold: 25 }, { targetCount: 2, targetCountKey: 'both' })
    assertLast(requests, {
      method: 'PUT',
      url: `${BASE}/system/image`,
      json: { energy_threshold: 25, target_number: 2, target_numbe: 2 }
    })
  })

  it('视频写入默认不发只读的 rtsp_connected_num（§8.3 C5）', async () => {
    const { client, requests } = setup()

    await client.setVideoConfig({ rtsp_connected_num: 1, rtsp_client_limit: 4 })
    assertLast(requests, {
      method: 'PUT',
      url: `${BASE}/system/video`,
      json: { rtsp_client_limit: 4 }
    })

    await client.setVideoConfig(
      { rtsp_connected_num: 1, rtsp_client_limit: 4 },
      { includeRtspConnectedNum: true }
    )
    assertLast(requests, {
      method: 'PUT',
      url: `${BASE}/system/video`,
      json: { rtsp_connected_num: 1, rtsp_client_limit: 4 }
    })
  })

  it('告警策略：POST 用 diagosisn，PUT 用 diagnosis（§8.3 C22）', async () => {
    const { client, requests } = setup()

    await client.createAlarmStrategy(STRATEGY_BODY)
    assertLast(requests, {
      method: 'POST',
      url: `${BASE}/alarm_strategy`,
      json: STRATEGY_BODY
    })

    await client.createAlarmStrategy(
      { ...STRATEGY_BODY, diagosisn: undefined },
      { diagnosis: 'note', diagnosisKey: 'diagnosis' }
    )
    assertLast(requests, {
      method: 'POST',
      url: `${BASE}/alarm_strategy`,
      json: { ...STRATEGY_BODY, diagosisn: undefined, diagnosis: 'note' }
    })

    await client.updateAlarmStrategy({ ...STRATEGY_BODY, id: 7, diagosisn: undefined }, {
      diagnosis: 'note',
      diagnosisKey: 'diagnosis'
    })
    assertLast(requests, {
      method: 'PUT',
      url: `${BASE}/alarm_strategy`,
      json: { ...STRATEGY_BODY, id: 7, diagosisn: undefined, diagnosis: 'note' }
    })

    await client.deleteAlarmStrategies([1, 2])
    assertLast(requests, {
      method: 'DELETE',
      url: `${BASE}/alarm_strategy`,
      json: { id: [1, 2] }
    })
  })

  it('告警条件：POST/PUT/DELETE 与 PUT 的 id 形态（§8.3 C25）', async () => {
    const { client, requests } = setup()

    await client.createAlarmCondition(CONDITION_BODY)
    assertLast(requests, {
      method: 'POST',
      url: `${BASE}/alarm_condition`,
      json: CONDITION_BODY
    })

    await client.updateAlarmCondition(CONDITION_BODY, { targetId: 3 })
    assertLast(requests, {
      method: 'PUT',
      url: `${BASE}/alarm_condition`,
      json: { ...CONDITION_BODY, id: 3 }
    })

    await client.updateAlarmCondition(CONDITION_BODY, { targetId: 3, idStyle: 'alarm_condition_id' })
    assertLast(requests, {
      method: 'PUT',
      url: `${BASE}/alarm_condition`,
      json: { ...CONDITION_BODY, alarm_condition_id: 3 }
    })

    await client.updateAlarmCondition(CONDITION_BODY, { idStyle: 'none' })
    assertLast(requests, {
      method: 'PUT',
      url: `${BASE}/alarm_condition`,
      json: CONDITION_BODY
    })

    await client.deleteAlarmConditions([1, 2])
    assertLast(requests, {
      method: 'DELETE',
      url: `${BASE}/alarm_condition`,
      json: { id: [1, 2] }
    })
  })

  it('id 数组请求体形状可切换（§8.3 C24/C29/C30）', async () => {
    const bare = setup({ client: { idListBody: 'bare_array' } })
    await bare.client.deleteNcFiles([1, 2])
    assertLast(bare.requests, { method: 'DELETE', url: `${BASE}/nc_file`, json: [1, 2] })

    const ids = setup({ client: { idListBody: 'ids_array_object' } })
    await ids.client.deleteNcFiles([1, 2])
    assertLast(ids.requests, { method: 'DELETE', url: `${BASE}/nc_file`, json: { ids: [1, 2] } })
  })

  it('空 id 列表与非整数 id 在本地就被拒绝', async () => {
    const { client, requests } = setup()
    await assert.rejects(() => client.deleteDetectLogs([]), rejectsWithCode('VALIDATION_ERROR'))
    await assert.rejects(() => client.deleteDetectLogs([1.5]), rejectsWithCode('VALIDATION_ERROR'))
    assert.equal(countPath(requests, '/detect_logs'), 0, '非法请求不得发到设备')
  })

  it('PUT /alarm_condition 默认形态缺 targetId 时本地拒绝（§8.3 C25）', async () => {
    const { client, requests } = setup()
    await assert.rejects(
      () => client.updateAlarmCondition(CONDITION_BODY),
      rejectsWithCode('VALIDATION_ERROR')
    )
    assert.equal(countPath(requests, '/alarm_condition'), 0)
  })

  it('DELETE /detect_logs 用 §5.1.19 的 {"id":[...]} 形状', async () => {
    const { client, requests } = setup()
    await client.deleteDetectLogs([2, 3])
    assertLast(requests, {
      method: 'DELETE',
      url: `${BASE}/detect_logs`,
      json: { id: [2, 3] }
    })
  })
})

// ---------------------------------------------------------------------------
// 读接口：query 参数、传参风格、下载
// ---------------------------------------------------------------------------

describe('FA371 client: 读接口报文', () => {
  it('分页接口用 ?page=', async () => {
    const { client, requests } = setup()

    await client.listAlarmStrategies(2)
    assertLast(requests, { method: 'GET', url: `${BASE}/alarm_strategy?page=2`, json: undefined })

    await client.listAlarmConditions(1)
    assertLast(requests, { method: 'GET', url: `${BASE}/alarm_condition?page=1`, json: undefined })

    await client.listNcFiles(3)
    assertLast(requests, { method: 'GET', url: `${BASE}/nc_filelist?page=3`, json: undefined })
  })

  it('detect_logs 的传参风格默认 query，可切到路径段（§8.3 C14）', async () => {
    const query = setup()
    await query.client.getDetectLogs(7)
    assertLast(query.requests, {
      method: 'GET',
      url: `${BASE}/detect_logs?detect_id=7`,
      json: undefined
    })

    const path = setup({ client: { detectLogsQueryStyle: 'path_segment' } })
    await path.client.getDetectLogs(7)
    assertLast(path.requests, { method: 'GET', url: `${BASE}/detect_logs/7`, json: undefined })
  })

  it('结果文件下载路径规整尾斜杠，并请求二进制', async () => {
    const fileBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const { client, requests } = setup({
      device: {
        respond: {
          'GET /detect_file/2019_06_20_20_30_39_940/sound_2019_06_20_20_30_39_940.jpg': () =>
            binaryResponse(fileBytes)
        }
      }
    })

    const file = await client.downloadDetectFile(
      '2019_06_20_20_30_39_940/',
      'sound_2019_06_20_20_30_39_940.jpg'
    )

    assert.deepEqual(file.bytes, fileBytes)
    assert.equal(file.contentType, 'image/jpeg')
    const request = last(requests)
    assert.equal(
      request.url,
      `${BASE}/detect_file/2019_06_20_20_30_39_940/sound_2019_06_20_20_30_39_940.jpg`
    )
    assert.equal(request.binary, true)
    assert.equal(request.headers.Authorization, TOKEN, '§8.3 C17：下载鉴权未说明，仍带 token')
  })

  it('下载遇到 HTML（SPA 兜底页）时报 INVALID_RESPONSE，而不是把网页当图片', async () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><html><body>app</body></html>')
    const { client } = setup({
      device: { respond: { 'GET /detect_file/a/b.jpg': () => binaryResponse(html, 'text/html') } }
    })

    await assert.rejects(() => client.downloadDetectFile('a/', 'b.jpg'), rejectsWithCode('INVALID_RESPONSE'))
  })

  it('空文件名在本地就被拒绝', async () => {
    const { client, requests } = setup()
    await assert.rejects(() => client.downloadDetectFile('a/', '  '), rejectsWithCode('VALIDATION_ERROR'))
    assert.equal(requests.length, 0)
  })

  it('上传比对文件走 multipart 的 nc_file + notes（§5.1.30）', async () => {
    const { client, requests } = setup()
    await client.uploadNcFile('mic_data.bin', new Uint8Array([1, 2, 3]), 'sample-1')

    const request = last(requests)
    assert.equal(request.method, 'POST')
    assert.equal(request.url, `${BASE}/upload_nc`)
    assert.ok(request.rawBody instanceof FormData, '必须是 multipart，而不是 JSON')
    const form = request.rawBody as FormData
    assert.ok(form.get('nc_file') instanceof Blob)
    assert.equal(form.get('notes'), 'sample-1')
    assert.equal(request.json, undefined)
  })
})

// ---------------------------------------------------------------------------
// 缺字段 / 改名响应
// ---------------------------------------------------------------------------

describe('FA371 client: 响应缺字段或改名', () => {
  it('缺 ret/msg、只有 detect_status 时不抛异常', async () => {
    const { client } = setup()
    const status = await client.getDetectStatus()
    assert.deepEqual(status, { detect_status: 0 })
  })

  it('detect_logs 返回裸对象（§5.1.17 示例形状）时不抛异常', async () => {
    const { client } = setup({
      device: {
        respond: {
          'GET /detect_logs': {
            bin_mic_data_name: 'mic_data_2019_06_20_20_30_39_940.bin',
            id: 7,
            saving_path: '2019_06_20_20_30_39_940/',
            msg: 'SUCCESS',
            ret: 200
          }
        }
      }
    })

    // 客户端只做包络校验，形状由 mapper 解释——但整条链路必须不抛异常。
    const payload = await client.getDetectLogs(1)
    assert.equal(payload.ret, 200)
    assert.equal(payload.bin_mic_data_name, 'mic_data_2019_06_20_20_30_39_940.bin')

    const logs = mapDetectLogs(payload)
    assert.equal(logs.length, 1)
    assert.equal(logs[0]?.id, 7)
  })

  it('imaging 只回字段表拼写 target_numbe 时照常返回', async () => {
    const { client } = setup({
      device: { respond: { 'GET /system/image': { energy_threshold: 25, target_numbe: 2, ret: 200 } } }
    })

    const imaging = await client.getImagingConfig()
    assert.equal(imaging.target_numbe, 2)
    assert.equal(imaging.target_number, undefined)
  })

  it('video_url 回数字时不抛异常（§8.3 C4）', async () => {
    const { client } = setup({
      device: { respond: { 'GET /system/video': { video_url: 1, video_port: 443, ret: 200 } } }
    })

    const video = await client.getVideoConfig()
    assert.equal(video.video_url, 1)
  })

  it('响应为空对象时不抛异常', async () => {
    const { client } = setup({
      device: { respond: { 'GET /system/leakage': {} } }
    })
    assert.deepEqual(await client.getLeakageConfig(), {})
  })
})

// ---------------------------------------------------------------------------
// 会话复用（防止重复登录）
// ---------------------------------------------------------------------------

describe('FA371 client: 会话复用', () => {
  it('并发调用只登录一次', async () => {
    const { client, loginCount } = setup()
    await Promise.all([
      client.getAcousticConfig(),
      client.getImagingConfig(),
      client.getVideoConfig(),
      client.getRunMode()
    ])
    assert.equal(loginCount(), 1)
  })

  it('adoptSession 后不再登录', async () => {
    const { client, loginCount } = setup()
    await client.getDetectStatus()
    const loginsAfterFirst = loginCount()

    // 采用已有会话（真实调用方在"添加设备"预览之后会这么做）。
    client.adoptSession(
      { strategyId: 'raw-auth-header', token: TOKEN, createdAt: Date.now() },
      {
        id: 'raw-auth-header',
        label: 'Authorization: <token>',
        carrier: { kind: 'header', name: 'Authorization', prefix: '' },
        buildLoginBody: (credential) => ({ username: credential.username, password: 'x' }),
        tokenFields: ['token'],
        extractToken: () => TOKEN
      }
    )
    client.setBaseUrl('192.168.2.168')
    await client.getDetectStatus()

    assert.equal(loginCount(), loginsAfterFirst)
  })
})

// ---------------------------------------------------------------------------
// 选项的默认值（"不猜"的默认方向）
// ---------------------------------------------------------------------------

describe('FA371 client: 未定义行为的默认取向', () => {
  it('实例把选中的候选暴露出来，便于协议报告', () => {
    const { client } = setup()
    assert.equal(client.loginEnvelope.id, 'plain')
    assert.equal(client.imagingTargetKey.id, 'target_number')
    assert.equal(client.strategyDiagnosisKey.id, 'diagosisn')
    assert.equal(client.idListBody.id, 'id_array_object')
    assert.equal(client.alarmConditionUpdateId.id, 'id')
    assert.equal(client.detectLogsQueryStyle.id, 'query_param')
  })

  it('登录体封装可切到 msgBody（AE08 家族实测形状）', async () => {
    const { client, requests } = setup({ client: { loginEnvelope: 'msgBody' } })
    await client.getDetectStatus()

    const login = requests[0]
    assert.ok(login)
    assert.deepEqual(login.json, {
      msgBody: { username: 'admin', password: PASSWORD_HASH }
    })
  })

  it('未知的候选 id 回落到默认值而不是抛错（配置来自设备记录）', () => {
    const { client } = setup({
      client: {
        idListBody: 'no_such_candidate' as unknown as Fa371ApiClientOptions['idListBody']
      }
    })
    assert.equal(client.idListBody.id, 'id_array_object')
  })
})

// ---------------------------------------------------------------------------
// 调用选项透传
// ---------------------------------------------------------------------------

describe('FA371 client: 调用选项', () => {
  it('timeoutMs 与 signal 逐次透传到 transport', async () => {
    const { client, requests } = setup()
    const controller = new AbortController()

    await client.getDetectStatus({ timeoutMs: 1234, signal: controller.signal })

    const request = last(requests)
    assert.equal(request.timeoutMs, 1234)
    assert.equal(request.hasSignal, true)
  })

  it('不传选项时用构造时的默认超时，且不附带 signal', async () => {
    const { client, requests } = setup({ client: { timeoutMs: 4321 } })

    await client.getDetectStatus()

    const request = last(requests)
    assert.equal(request.timeoutMs, 4321)
    assert.equal(request.hasSignal, false)
  })
})
