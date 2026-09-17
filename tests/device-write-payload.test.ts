/**
 * 两个改名写入的**线上字节**（wire body）回归测试。
 *
 * WHY THIS FILE EXISTS
 * 这一轮修掉的是两个**请求形状**的 bug，不是逻辑 bug：
 *   - `PUT /set_devinfo`  少 `msgBody` 信封 -> 设备答 `Failed to modify device name.`
 *   - `PUT /set_passageway` 少 `msgBody` 信封，且 `chinfoArray` 发了 8 条数组
 *     -> 设备答 `Failed, Please check the integrity of the data format.`
 *
 * 形状是设备自己公布的前端源码（source map 还原的原始 React 源）加上真机值保持探针
 * 定下来的，见 `docs/PROTOCOL-FINDINGS.md` §5A.2 / §5A.10。
 *
 * `tests/config-service.test.ts` 断言的是**服务层交出去的对象**；这一份断言的是
 * **接口层真正序列化出去的 JSON**（`transport.request({ json })` 收到的那个值）。
 * 两处分开写是有理由的：`DeviceApiClient.call()` 会在认证策略需要时把凭据合并进 body
 * （`auth.body`），所以「服务层交了什么」与「线上发了什么」不是同一件事，而设备只看后者。
 * 形状一旦回退（有人把数组加回来、有人把字段挪到根上），这里会立刻红。
 *
 * 中文注释是仓库约定（见 tests/channel-state.test.ts）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { ConfigService } from '../src/main/services/device/config-service'
import { DeviceApiClient } from '../src/main/services/device/device-api-client'
import { AuthStrategyResolver } from '../src/main/services/device/auth-resolver'
import { findStrategy } from '../src/main/services/device/auth-strategy'
import type {
  HttpRequestOptions,
  HttpResponse,
  HttpTransport,
  StreamSignature
} from '../src/main/services/device/http-transport'

// ---------------------------------------------------------------------------
// 记录型假传输
// ---------------------------------------------------------------------------

/** 一条真正发出去的请求。`json` 就是序列化进 body 的那个对象。 */
interface SentRequest {
  method: string
  url: string
  json: unknown
  headers: Record<string, string>
}

function jsonResponse(json: unknown): HttpResponse {
  return {
    status: 200,
    ok: true,
    headers: {},
    contentType: 'application/json',
    json,
    latencyMs: 1
  }
}

/**
 * 只记录 `json`、按 `METHOD /path` 答固定响应的传输。
 *
 * 不模拟设备语义：这一份测试问的是「我们发了什么」，设备怎么答由
 * `tests/config-service.test.ts` 的假客户端与真机负责。但读回路径必须答得对，否则
 * 读-改-写第一步就断了 —— 所以按路径给响应，而不是按调用序号（调用序号会在
 * 「写完再读回」的路径里错位，那是一个假的失败）。
 */
function recordingTransport(respond: Record<string, unknown> = {}): {
  transport: HttpTransport
  sent: SentRequest[]
} {
  const sent: SentRequest[] = []

  const transport: HttpTransport = {
    async request(options: HttpRequestOptions): Promise<HttpResponse> {
      sent.push({
        method: options.method,
        url: options.url,
        json: options.json,
        headers: options.headers ?? {}
      })
      const key = `${options.method} ${new URL(options.url).pathname}`
      return jsonResponse(respond[key] ?? { result: 0 })
    },
    async captureStream(): Promise<StreamSignature> {
      throw new Error('本测试不涉及流式端点')
    }
  }

  return { transport, sent }
}

/**
 * 造一个**已经认证好**的客户端。
 *
 * 走 `adoptSession()` 而不是真的登录：登录是另一条被测过的路径，而这里只要保证
 * 请求真的到达传输层。策略显式取 `token-header`（真机首次尝试即命中的那一种）。
 */
function clientWith(transport: HttpTransport): DeviceApiClient {
  const strategy = findStrategy('token-header')
  assert.ok(strategy, 'token-header 策略不存在：认证策略表被改过了')

  const client = new DeviceApiClient({
    transport,
    resolver: new AuthStrategyResolver(transport),
    baseUrl: 'http://192.168.110.90:80',
    credential: { username: 'admin', password: '123456' }
  })
  client.adoptSession({ strategyId: strategy.id, createdAt: Date.now(), token: 'T' }, strategy)
  return client
}

/** 真机（AE08）通道表的一行，与 `config-service.test.ts` 用的是同一份实测载荷。 */
const CHANNEL_ROWS = [
  { dchAlarmPara: 2, dchEn: 1, dchId: 0, dchName: 'name1', dchSensorType: 0 },
  { dchAlarmPara: 1, dchEn: 1, dchId: 1, dchName: 'name2', dchSensorType: 1 },
  { dchAlarmPara: 1, dchEn: 0, dchId: 2, dchName: 'name3', dchSensorType: 0 },
  { dchAlarmPara: 1, dchEn: 0, dchId: 3, dchName: 'name4', dchSensorType: 0 },
  { dchAlarmPara: 1, dchEn: 0, dchId: 4, dchName: 'name5', dchSensorType: 0 },
  { dchAlarmPara: 1, dchEn: 0, dchId: 5, dchName: 'name6', dchSensorType: 0 },
  { dchAlarmPara: 1, dchEn: 0, dchId: 6, dchName: 'name7', dchSensorType: 0 },
  { dchAlarmPara: 1, dchEn: 0, dchId: 7, dchName: 'name8', dchSensorType: 0 }
]

// ---------------------------------------------------------------------------

describe('改名写入的线上字节', () => {
  it('改通道名只发一条通道，且包在 msgBody 里', async () => {
    const { transport, sent } = recordingTransport({
      'GET /get_passageway': { result: 0, msgBody: { chinfoArray: CHANNEL_ROWS, chinfoSize: 8 } }
    })
    const config = new ConfigService(clientWith(transport))

    await config.updateChannel(0, { name: '母线室' })

    const write = sent.filter((request) => request.method === 'PUT')
    assert.equal(write.length, 1, '一次通道改名必须只发一个 PUT')
    const body = write[0]?.json as Record<string, unknown>

    // 根上只有 msgBody；把字段挪到根上正是这个 bug 的形态之一。
    assert.deepEqual(Object.keys(body), ['msgBody'])
    const envelope = body.msgBody as Record<string, unknown>
    assert.deepEqual(Object.keys(envelope), ['chinfoArray'])

    // 单对象，不是数组（一元素数组同样被固件拒绝）。
    const row = envelope.chinfoArray as Record<string, unknown>
    assert.ok(!Array.isArray(row), 'chinfoArray 必须是单个通道对象')
    assert.deepEqual(row, {
      dchId: 0,
      dchName: '母线室',
      dchSensorType: 0,
      dchEn: 1,
      dchAlarmPara: 2
    })
  })

  it('改设备名发的是 {msgBody:{devname}}', async () => {
    const { transport, sent } = recordingTransport()
    const config = new ConfigService(clientWith(transport))

    await config.setDeviceName('  新名字  ')

    assert.equal(sent.length, 1)
    assert.equal(sent[0]?.method, 'PUT')
    assert.match(String(sent[0]?.url), /\/set_devinfo$/)
    // 名字已 trim，且**只在** msgBody 里面。
    assert.deepEqual(sent[0]?.json, { msgBody: { devname: '新名字' } })
  })

  it('采样率 / 对时 / RS485 / Modbus / 推送 五条写入都带 msgBody 信封', async () => {
    /**
     * 这五条是同一轮里用**值保持写探针**（把设备当前的值原样送回）逐条证明的：
     * 裸对象一律被设备答成 `Failed to set …`，加 `msgBody` 之后 `result:0`
     * 且读回与基线逐字节一致。见 `docs/PROTOCOL-FINDINGS.md` §5A.1 的矩阵。
     */
    const { transport, sent } = recordingTransport({
      'GET /get_samplingrate': { result: 0, msgBody: { samplingrate: 96000 } },
      'GET /get_timeset': {
        result: 0,
        msgBody: { cur_time: 1789104356236, dsyNTPAdder: 'cn.pool.ntp.org', dsyNTPEN: 0, dsyNTPInterval: 64 }
      },
      'GET /get_rs485': {
        result: 0,
        msgBody: { dsySeriBaud: 9600, dsySeriDateBit: 8, dsySeriMode: 0, dsySeriPortL: '', dsySeriRserAddr: '' }
      },
      'GET /get_modbus_para': {
        result: 0,
        msgBody: {
          modbus_baud: 9600,
          modbus_crc: 0,
          modbus_dbit: 8,
          modbus_post: 502,
          modbus_sbit: 1,
          modbus_slave: 200,
          modbus_type: 0
        }
      }
    })
    const client = clientWith(transport)
    const config = new ConfigService(client)

    await config.setSampleRate(96000)
    await config.syncDeviceTime()
    await config.updateRs485({})
    await config.updateModbus({})
    // 推送没有服务层方法（本仓库从不写它），直接打客户端，形状由 DTO 决定。
    await client.setDatePush({
      msgBody: {
        dsyFeatDataEN: 1,
        dsyFeatDataAdder: 'http://192.168.1.10:8080/push',
        dsyAlarmInfoEN: 1,
        dsyAlarmInfoAdder: 'http://192.168.1.10:8080/push',
        dsyGraphDataEN: 0,
        dsyGraphDataAdder: '',
        dsyHeatEN: 0,
        dsyHeatAdder: '',
        dsyHeatContent: 'HEAT',
        dsyHeatInterval: 60,
        dsyManualRecordingEN: 0,
        dsyManualRecordingAddr: ''
      }
    })

    const writes = sent.filter((request) => request.method === 'PUT')
    assert.deepEqual(
      writes.map((request) => new URL(String(request.url)).pathname),
      ['/set_samplingrate', '/set_timeset', '/set_rs485', '/set_modbus_para', '/set_date_push']
    )

    for (const request of writes) {
      const body = request.json as Record<string, unknown>
      const path = new URL(String(request.url)).pathname
      assert.deepEqual(Object.keys(body), ['msgBody'], `${path} 的 body 根上只有 msgBody`)
      assert.equal(typeof body.msgBody, 'object', `${path} 的 msgBody 不是对象`)
      assert.ok(!Array.isArray(body.msgBody), `${path} 的 msgBody 是数组`)
    }

    // 内层字段仍然是原来那些（信封只加一层，没有改名、没有搬位置）。
    assert.deepEqual(writes[0]?.json, { msgBody: { samplingrate: 96000 } })
    assert.deepEqual((writes[3]?.json as Record<string, unknown>).msgBody, {
      modbus_post: 502,
      modbus_type: 0,
      modbus_baud: 9600,
      modbus_dbit: 8,
      modbus_sbit: 1,
      modbus_slave: 200
    })
  })

  it('改通道名与被改通道同 id 的那一行，其它通道一个字节都不在 body 里', async () => {
    const { transport, sent } = recordingTransport({
      'GET /get_passageway': { result: 0, msgBody: { chinfoArray: CHANNEL_ROWS } }
    })
    const config = new ConfigService(clientWith(transport))

    await config.updateChannel(5, { name: 'CH6 新名' })

    const body = sent.filter((request) => request.method === 'PUT')[0]?.json as Record<string, unknown>
    const row = (body.msgBody as Record<string, unknown>).chinfoArray as Record<string, unknown>
    assert.equal(row.dchId, 5)
    // 未被编辑的字段仍然是设备上报的值（没有编造，也没有丢）。
    assert.equal(row.dchEn, 0)
    assert.equal(row.dchSensorType, 0)
    assert.equal(row.dchAlarmPara, 1)
    assert.ok(!JSON.stringify(body).includes('name1'), '别的通道被一起发出去了')
  })
})
