/**
 * E2 / 听诊盒子族的「拉」通道（`E2Client` + `shared/domain/e2.ts`）。
 *
 * 网络这一层用**真的**本地 HTTP 服务跑（`node:http`，不 mock `HttpTransport`）：
 * 这样"口令到底是不是 MD5""401 之后有没有重新登录""`file_path` 有没有带上 `saving_path`"
 * 这些**跨进程线上**的事实才是真的走了一遍。真机不在手上，所以设备那一侧是假的，
 * 但协议这一侧是真的。
 *
 * 断言对准的是四类最容易出错的地方：
 *   1. **认证**：口令必须是 32 位 MD5；token 失效（401）要**自己**重新登录一次再重试；
 *   2. **路径与查询串**：`/alarm_log_all` 要显式带分页（手册默认值自相矛盾）、
 *      `/alarm_files` 的 `file_path` 必须含 `saving_path`；
 *   3. **收窄**：认不出的 `work_mode` 保留原文、`alarm_value` 的**未知位**如实列出；
 *   4. **失败的分寸**：404 = 文件被保留策略清掉（预期状态，消息要说得清），
 *      400 = 我们参数错了，两者不能混成一个"下载失败"。
 */

import { strict as assert } from 'node:assert'
import http from 'node:http'
import { after, describe, it } from 'node:test'

import { E2Client, e2PasswordDigest, normaliseE2BaseUrl } from '../src/main/services/device/e2/e2-client'
import { FetchHttpTransport } from '../src/main/services/device/http-transport'
import {
  E2_ALARM_BITS,
  E2_AIR_SONAR_AUDIO_NAME,
  E2_AIR_SONAR_PARAMS,
  E2_COMMON_PARAMS,
  E2_ENDPOINTS_BY_VARIANT,
  E2_PARAM_GROUPS,
  E2_SENSITIVE_PARAMS,
  E2_SPECTROGRAM_COUNT,
  decodeE2AlarmValue,
  detectE2Variant,
  e2AirSonarSnapshotNames,
  e2ChannelCountFromModel,
  e2FilePath,
  e2ParamKeys,
  e2SpectrogramNames,
  isE2CallbackType,
  isE2WorkMode,
  parseE2Timestamp
} from '../src/shared/domain/e2'

// ---------------------------------------------------------------------------
// 假的设备
// ---------------------------------------------------------------------------

interface Recorded {
  method: string
  path: string
  query: URLSearchParams
  headers: http.IncomingHttpHeaders
  body: Record<string, unknown>
}

interface FakeDevice {
  baseUrl: string
  requests: Recorded[]
  /** 下一次登录是否回 401（用来验"口令不对"这条）。 */
  failNextLogin: boolean
  /** 让下一次带 token 的请求回 401（模拟设备重启后 token 失效）。 */
  expireTokenOnce: boolean
  /** 带 token 的请求**永远**回 401（模拟设备一直拒绝：不能无限重试）。 */
  alwaysExpire: boolean
  /** 已经登录成功过几次。 */
  logins: number
  close(): Promise<void>
}

interface FakeOptions {
  workMode?: unknown
  system?: unknown
  logs?: unknown
  file?: { status: number; bytes: Buffer; contentType?: string }
  basic?: unknown
  /** `/login` 的成功响应体（默认 `{token}`）。用来测"响应里没有 token"。 */
  loginBody?: unknown
  /**
   * `/login` 认哪一种口令摘要（`undefined` = 任何摘要都收）。
   * 用来测"两份手册的摘要不一致，先加盐、401 再不加盐"这条路径。
   */
  acceptDigest?: string
}

async function startDevice(options: FakeOptions = {}): Promise<FakeDevice> {
  const requests: Recorded[] = []
  let logins = 0

  const state = {
    failNextLogin: false,
    expireTokenOnce: false,
    alwaysExpire: false
  }

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: Record<string, unknown> = {}
      try {
        body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
      } catch {
        body = { __raw: raw }
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      requests.push({
        method: request.method ?? '',
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        body
      })

      const json = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }

      if (url.pathname === '/login') {
        if (state.failNextLogin) {
          state.failNextLogin = false
          json(401, { msg: 'unauthorized' })
          return
        }
        // 认摘要的假设备：用来复现"两份手册写的摘要不一样"这件事。
        if (options.acceptDigest !== undefined && body.password !== options.acceptDigest) {
          json(401, { msg: 'bad password' })
          return
        }
        logins += 1
        json(200, options.loginBody ?? { token: `tok-${logins}` })
        return
      }

      // 其它接口都要求 Bearer token。空 token / 过期标记都会得到 401。
      const auth = request.headers.authorization ?? ''
      if (!auth.startsWith('Bearer ') || auth === 'Bearer ') {
        json(401, { msg: 'unauthorized' })
        return
      }
      if (state.alwaysExpire) {
        json(401, { msg: 'token expired' })
        return
      }
      if (state.expireTokenOnce) {
        state.expireTokenOnce = false
        json(401, { msg: 'token expired' })
        return
      }

      switch (url.pathname) {
        case '/workmode':
          json(200, options.workMode ?? { work_mode: 'rotating_equipment', samplerate: 48000 })
          return
        case '/system':
          if (request.method === 'PUT') {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end('{}')
            return
          }
          json(200, options.system ?? { work_mode: 'rotating_equipment', db_limit: 50, hpss_limit: 1.1 })
          return
        case '/alarm_log_all':
          json(200, options.logs ?? { logs_count: 0, logs: [] })
          return
        case '/alarm_log':
          json(200, options.logs ?? { logs_count: 0, logs: [] })
          return
        case '/alarm_files': {
          const file = options.file ?? { status: 200, bytes: Buffer.from([1, 2, 3, 4]) }
          if (file.status !== 200) {
            response.writeHead(file.status, { 'content-type': 'text/plain' })
            response.end('nope')
            return
          }
          response.writeHead(200, {
            'content-type': file.contentType ?? 'application/octet-stream'
          })
          response.end(file.bytes)
          return
        }
        case '/basic':
          json(200, options.basic ?? { dev_name: 'E2-1', dev_type: 'AR02', dev_version: 'V2.8.0' })
          return
        case '/hb_settings':
          json(200, { is_notify_heartbeat: 0, notify_interval: 20, notify_url: 'http://a:8000' })
          return
        case '/reboot':
          json(200, {})
          return
        default:
          json(404, { msg: 'no such endpoint' })
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    get failNextLogin() {
      return state.failNextLogin
    },
    set failNextLogin(value: boolean) {
      state.failNextLogin = value
    },
    get expireTokenOnce() {
      return state.expireTokenOnce
    },
    set expireTokenOnce(value: boolean) {
      state.expireTokenOnce = value
    },
    get alwaysExpire() {
      return state.alwaysExpire
    },
    set alwaysExpire(value: boolean) {
      state.alwaysExpire = value
    },
    get logins() {
      return logins
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

function makeClient(device: FakeDevice): E2Client {
  return new E2Client({
    transport: new FetchHttpTransport(3_000),
    baseUrl: device.baseUrl,
    credentials: { username: 'admin', password: 'Admin@123' },
    timeoutMs: 3_000
  })
}

const cleanup: Array<() => Promise<void>> = []
after(async () => {
  for (const close of cleanup) await close()
})

async function device(options: FakeOptions = {}): Promise<{ fake: FakeDevice; client: E2Client }> {
  const fake = await startDevice(options)
  cleanup.push(fake.close)
  return { fake, client: makeClient(fake) }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe('E2 域层：alarm_value 的位表', () => {
  it('手册列了 6 个值，逐个都对得上', () => {
    assert.deepEqual(
      E2_ALARM_BITS.map((bit) => bit.value),
      [0x1, 0x10, 0x100, 0x1000, 0x10000, 0x100000]
    )
    // 手册示例：alarm_value = 256（0x100）配 alarm_reasons = "时域能量比超限，"
    const decoded = decodeE2AlarmValue(256)
    assert.deepEqual(decoded.keys, ['tde_ratio_limit'])
    assert.deepEqual(decoded.unknownBits, [])
  })

  it('多个位置位时按位值从小到大列出（位或查询就是这么用的）', () => {
    const decoded = decodeE2AlarmValue(0x1 | 0x100 | 0x100000)
    assert.deepEqual(decoded.keys, ['db_limit', 'tde_ratio_limit', 'sc_ratio_limit'])
  })

  it('**手册未说明的位**单独列出来，不当成 FA8 那套位图去解', () => {
    // 0x1000000 不在位表里（用户手册里的"奇偶谐波比超限"没有对应的位定义）。
    const decoded = decodeE2AlarmValue(0x1000000 | 0x1)
    assert.deepEqual(decoded.keys, ['db_limit'])
    assert.deepEqual(decoded.unknownBits, [0x1000000])
    assert.equal(decoded.raw, 0x1000001)
  })

  it('0 / 负数 / 非数字一律当成"没有任何位置位"，不抛异常', () => {
    for (const value of [0, -1, undefined, null, 'abc', Number.NaN]) {
      assert.deepEqual(decodeE2AlarmValue(value).keys, [], String(value))
    }
  })
})

describe('E2 域层：时间字符串（没有时区）', () => {
  it('认两种样式：日志的 `yyyy-MM-dd_HH-mm-SS` 与回调的 `yyyyMMdd_HHmmSS`', () => {
    const long = parseE2Timestamp('2022-04-16_07-51-33')
    assert.ok(long)
    assert.equal(long.style, 'long')
    // 按**本机本地时区**解释，并且把"不知道时区"作为事实返回。
    assert.equal(long.offsetKnown, false)
    assert.equal(long.ms, new Date(2022, 3, 16, 7, 51, 33, 0).getTime())

    const compact = parseE2Timestamp('20220418_103607')
    assert.ok(compact)
    assert.equal(compact.style, 'compact')
    assert.equal(compact.ms, new Date(2022, 3, 18, 10, 36, 7, 0).getTime())
  })

  it('解不出来就是 undefined（不当成 0、也不当成"现在"）', () => {
    for (const value of ['', '2022-04-16', '20220416', 0, null, {}, '2022-13-45_99-99-99']) {
      assert.equal(parseE2Timestamp(value), undefined, JSON.stringify(value) || String(value))
    }
  })
})

describe('E2 域层：文件路径与参数表', () => {
  it('`file_path` = `saving_path` + 文件名，尾斜杠补齐一次', () => {
    assert.equal(e2FilePath('20220416_075133/', '20220416_075133.wav'), '20220416_075133/20220416_075133.wav')
    assert.equal(e2FilePath('20220416_075133', '1.jpg'), '20220416_075133/1.jpg')
    assert.equal(e2FilePath('', '1.jpg'), undefined)
    assert.equal(e2FilePath('20220416_075133/', ''), undefined)
  })

  it('时频谱图上限 10 张（设备重启后可能更少，那是正常）', () => {
    assert.equal(E2_SPECTROGRAM_COUNT, 10)
    assert.deepEqual(e2SpectrogramNames()[0], '1.jpg')
    assert.deepEqual(e2SpectrogramNames().at(-1), '10.jpg')
  })

  it('模式的参数表按手册列（不编默认值）', () => {
    assert.deepEqual(e2ParamKeys('rotating_equipment'), [
      'db_limit',
      'hpss_limit',
      'notify_url',
      'is_send_alarm',
      'is_send_fft'
    ])
    assert.ok(e2ParamKeys('electrical_power_equipment').includes('sc_ratio_threshold'))
    // 三种模式都有的那三个参数每一份都要出现。
    for (const mode of ['burst_of_loud_sound', 'rotating_equipment', 'electrical_power_equipment'] as const) {
      for (const key of ['notify_url', 'is_send_alarm', 'is_send_fft']) {
        assert.ok(e2ParamKeys(mode).includes(key), `${mode} 缺 ${key}`)
      }
    }
  })

  it('模式与回调类型的收窄（含手册内部不一致的那个别名）', () => {
    assert.equal(isE2WorkMode('rotating_equipment'), true)
    assert.equal(isE2WorkMode('Rotational Device Monitoring'), false)
    assert.equal(isE2CallbackType('alarm_msg'), true)
    assert.equal(isE2CallbackType('alarm_files_save_report'), true)
    // 同一页的示例写的是 wav_save_report：两个都收。
    assert.equal(isE2CallbackType('wav_save_report'), true)
    assert.equal(isE2CallbackType('something_else'), false)
  })
})

describe('E2 域层：变体判定（两代协议）', () => {
  it('Air Sonar 的 PTZ 键 ⇒ airSonar；有 work_mode ⇒ auscultation', () => {
    assert.equal(detectE2Variant({ cam_enable: true, db_limit: 50 }), 'airSonar')
    assert.equal(detectE2Variant({ cur_realtime_channel: 2 }), 'airSonar')
    assert.equal(detectE2Variant({ is_save_snapshot: true }), 'airSonar')
    assert.equal(detectE2Variant({ work_mode: 'rotating_equipment', db_limit: 50 }), 'auscultation')
  })

  it('两种都没有 ⇒ undefined（"认不出"不是错误，是事实）', () => {
    assert.equal(detectE2Variant({ db_limit: 50 }), undefined)
    assert.equal(detectE2Variant({}), undefined)
    assert.equal(detectE2Variant(undefined), undefined)
  })

  it('两代的端点表不同（路径换了，不是措辞换了）', () => {
    assert.equal(E2_ENDPOINTS_BY_VARIANT.auscultation.alarmLogAll, '/alarm_log_all')
    assert.equal(E2_ENDPOINTS_BY_VARIANT.airSonar.alarmLogAll, '/get_all_alarms')
    assert.equal(E2_ENDPOINTS_BY_VARIANT.auscultation.alarmLogConditional, '/alarm_log')
    assert.equal(E2_ENDPOINTS_BY_VARIANT.airSonar.alarmLogConditional, '/get_alarm_logs_conditional')
    assert.equal(E2_ENDPOINTS_BY_VARIANT.auscultation.alarmFile, '/alarm_files')
    assert.equal(E2_ENDPOINTS_BY_VARIANT.airSonar.alarmFile, '/saving_alarm_file')
    assert.equal(E2_ENDPOINTS_BY_VARIANT.auscultation.basic, '/basic')
    assert.equal(E2_ENDPOINTS_BY_VARIANT.airSonar.basic, '/get_device_basic_params')
  })

  it('通道数从型号字符串读：AS16 / SN-16 ⇒ 16，读不出来就是 undefined（不猜）', () => {
    assert.equal(e2ChannelCountFromModel('AS16'), 16)
    assert.equal(e2ChannelCountFromModel(' as8 '), 8)
    /*
     * 业主 2026-09-17 澄清：这一代的产品名是 **SN-16 空气声呐**，而手册示例里写的是 `AS16`。
     * 设备实际报哪一种只在真机上才能确认，所以两种写法都必须认 —— 认不出时界面会显示
     * "未上报通道数"，而那看起来像"设备没回这条信息"，与"我们不认它的型号"是两件事。
     */
    assert.equal(e2ChannelCountFromModel('SN-16'), 16)
    assert.equal(e2ChannelCountFromModel('SN16'), 16)
    assert.equal(e2ChannelCountFromModel('sn-4'), 4)
    /*
     * 真机实测（固件 V3.4.0）：`dev_type` = **`AS16-auth-vertical-reverse`** —— 前缀是型号，
     * 后缀是这一台的配置。第一版的正则要求"前缀+数字+结尾"，于是这台 16 通道设备被读成
     * "读不出通道数"（界面显示"未上报通道数"）。
     */
    assert.equal(e2ChannelCountFromModel('AS16-auth-vertical-reverse'), 16)
    assert.equal(e2ChannelCountFromModel('AS16X'), 16)
    assert.equal(e2ChannelCountFromModel('AR02'), undefined)
    assert.equal(e2ChannelCountFromModel('AS999'), undefined)
    assert.equal(e2ChannelCountFromModel('AS1600'), undefined)
    assert.equal(e2ChannelCountFromModel('SN-'), undefined)
    assert.equal(e2ChannelCountFromModel('SN16A'), 16)
    assert.equal(e2ChannelCountFromModel(undefined), undefined)
  })

  it('图的张数与名字也是两代不同：10 张时频谱 vs 3 张抓图', () => {
    assert.equal(e2SpectrogramNames().length, 10)
    assert.deepEqual(e2AirSonarSnapshotNames(), ['1.jpg', '2.jpg', '3.jpg'])
    // Air Sonar 的录音名是固定的（手册写明），2023 版由设备给。
    assert.equal(E2_AIR_SONAR_AUDIO_NAME, 'alarm.wav')
  })

  it('参数分组覆盖两代的所有键（界面的分组标题靠它）', () => {
    for (const key of [...E2_AIR_SONAR_PARAMS, ...E2_COMMON_PARAMS, 'hpss_limit']) {
      assert.ok(E2_PARAM_GROUPS[key] !== undefined, `${key} 没有分组`)
    }
    // 相机口令必须被标成敏感（界面不显示它的值）。
    assert.ok(E2_SENSITIVE_PARAMS.includes('cam_pass'))
  })
})

// ---------------------------------------------------------------------------
// 线上行为
// ---------------------------------------------------------------------------

describe('E2 客户端：登录', () => {
  it('口令发出去的是 **32 位 MD5**，不是明文', async () => {
    const { fake, client } = await device()
    await client.login()

    const login = fake.requests.find((request) => request.path === '/login')
    assert.ok(login)
    assert.equal(login.method, 'POST')
    assert.equal(login.body.username, 'admin')
    assert.match(String(login.body.password), /^[0-9a-f]{32}$/)
    // 明文一个字节都不能出现在线上。
    assert.equal(JSON.stringify(fake.requests).includes('Admin@123'), false)
  })

  it('**两份手册的摘要不一致**：先试加盐（lfxs+MD5），401 再试不加盐', async () => {
    // 第一次尝试（加盐）被拒，第二次（不加盐）成功。
    const fake = await startDevice({ acceptDigest: e2PasswordDigest('Admin@123', 'plain') })
    cleanup.push(fake.close)
    const client = makeClient(fake)

    await client.login()
    const loginCalls = fake.requests.filter((request) => request.path === '/login')
    assert.equal(loginCalls.length, 2)
    // 第一次是加盐（Air Sonar 手册的写法），第二次是不加盐（2023 版手册的写法）。
    assert.equal(loginCalls[0]?.body.password, e2PasswordDigest('Admin@123', 'salted'))
    assert.equal(loginCalls[1]?.body.password, e2PasswordDigest('Admin@123', 'plain'))
    // 记住了成的那一种：后续重新登录只发一个请求。
    assert.equal(client.resolvedPasswordStyle, 'plain')
    client.invalidateToken()
    await client.login()
    assert.equal(fake.requests.filter((request) => request.path === '/login').length, 3)
  })

  it('默认（加盐就能过）只发一次登录请求', async () => {
    const { fake, client } = await device()
    await client.login()
    assert.equal(fake.requests.filter((request) => request.path === '/login').length, 1)
    assert.equal(client.resolvedPasswordStyle, 'salted')
  })

  it('两种摘要都被拒才算认证失败', async () => {
    const fake = await startDevice({ acceptDigest: 'something-else' })
    cleanup.push(fake.close)
    const client = makeClient(fake)
    await assert.rejects(() => client.login(), /设备拒绝登录/)
    assert.equal(fake.requests.filter((request) => request.path === '/login').length, 2)
  })

  it('登录成功但响应里没有 token ⇒ 如实报"响应异常"（不是认证失败）', async () => {
    const { client } = await device({ loginBody: { msg: 'SUCCESS' } })
    await assert.rejects(() => client.login(), /登录响应里没有 token/)
  })
})

describe('E2 客户端：token 失效', () => {
  it('401 ⇒ 自己重新登录一次再重试，调用方无感', async () => {
    const { fake, client } = await device()
    await client.login()
    assert.equal(fake.logins, 1)

    // 设备重启后旧 token 失效：第一次带 token 的请求回 401。
    fake.expireTokenOnce = true
    const view = await client.getWorkMode()

    assert.equal(view.mode, 'rotating_equipment')
    // 重新登录了一次，总共两次。
    assert.equal(fake.logins, 2)
    // 第二次请求带的是**新** token。
    const workModeCalls = fake.requests.filter((request) => request.path === '/workmode')
    assert.equal(workModeCalls.length, 2)
    assert.equal(workModeCalls[0]?.headers.authorization, 'Bearer tok-1')
    assert.equal(workModeCalls[1]?.headers.authorization, 'Bearer tok-2')
  })

  it('重新登录之后仍然 401 ⇒ 报认证失败，**不无限重试**', async () => {
    const { fake, client } = await device()
    fake.alwaysExpire = true
    await assert.rejects(() => client.getWorkMode(), /设备拒绝认证/)

    // 只重试了**一次**：总共两回 /workmode（第一回 401、重登后再一回），登录也只发生两次。
    const workModeCalls = fake.requests.filter((request) => request.path === '/workmode')
    assert.equal(workModeCalls.length, 2)
    assert.equal(fake.logins, 2)
  })
})

describe('E2 客户端：读参数与日志', () => {
  it('/workmode：认不出的模式**保留原文**（设备可能出了第四种模式）', async () => {
    const { client } = await device({
      workMode: { work_mode: 'brand_new_mode', samplerate: 96000 }
    })
    const view = await client.getWorkMode()
    assert.equal(view.mode, undefined)
    assert.equal(view.rawMode, 'brand_new_mode')
    assert.equal(view.samplerate, 96000)
  })

  it('/workmode：六个字段都收窄（含两个流地址与谱图尺寸）', async () => {
    const { client } = await device({
      workMode: {
        work_mode: 'electrical_power_equipment',
        samplerate: 120000,
        audio_stream_url: '/audio_stream',
        stft_pic_height: 240,
        stft_pic_width: 499,
        stft_stream_url: '/stft_stream'
      }
    })
    const view = await client.getWorkMode()
    assert.equal(view.mode, 'electrical_power_equipment')
    assert.equal(view.samplerate, 120_000)
    assert.equal(view.audioStreamUrl, '/audio_stream')
    assert.equal(view.stftStreamUrl, '/stft_stream')
    assert.equal(view.stftPicHeight, 240)
    assert.equal(view.stftPicWidth, 499)
  })

  it('/system：读回设备原样的键值对（多给的键不丢）', async () => {
    const { client } = await device({
      system: { work_mode: 'rotating_equipment', db_limit: 50, hpss_limit: 1.1, extra_thing: 'x' }
    })
    const raw = await client.getSystem()
    assert.equal(raw.db_limit, 50)
    assert.equal(raw.extra_thing, 'x')
  })

  it('PUT /system：把调用方给的对象原样发出去（读-改-写由上层负责）', async () => {
    const { fake, client } = await device()
    await client.putSystem({ work_mode: 'rotating_equipment', db_limit: 55, hpss_limit: 1.2 })
    const put = fake.requests.find((request) => request.method === 'PUT' && request.path === '/system')
    assert.ok(put)
    assert.deepEqual(put.body, { work_mode: 'rotating_equipment', db_limit: 55, hpss_limit: 1.2 })
  })

  it('/alarm_log_all：**显式**传分页（手册的默认值自相矛盾）', async () => {
    const { fake, client } = await device()
    await client.listAlarmLogs({ startCol: 1, colCount: 50 })
    const call = fake.requests.find((request) => request.path === '/alarm_log_all')
    assert.ok(call)
    assert.equal(call.query.get('start_col'), '1')
    assert.equal(call.query.get('col_count'), '50')
  })

  it('/alarm_log：时间区间与 alarm_value 位或查询', async () => {
    const { fake, client } = await device()
    await client.queryAlarmLogs({ startTime: 100, endTime: 200, alarmBits: 0x101, colCount: 5 })
    const call = fake.requests.find((request) => request.path === '/alarm_log')
    assert.ok(call)
    assert.equal(call.query.get('start_time'), '100')
    assert.equal(call.query.get('end_time'), '200')
    assert.equal(call.query.get('alarm_value'), '257')
    assert.equal(call.query.get('col_count'), '5')
  })

  it('日志收窄：告警原因、文件状态、特征值都在，时间另外解一份', async () => {
    const { client } = await device({
      logs: {
        logs_count: 3048,
        logs: [
          {
            id: 1,
            time: '2022-04-16_07-51-33',
            alarm_reasons: '时域能量比超限，',
            alarm_value: 256,
            saving_path: '20220416_075133/',
            audio_name: '20220416_075133.wav',
            files_status: 1,
            db_value: 51.569347,
            tde_ratio: 2.4,
            fde_ratio: 0.05
          },
          // 一条被保留策略清掉文件的：files_status = 0，音频名还在。
          {
            id: 2,
            time: '2022-04-16_08-00-00',
            alarm_reasons: '分贝超限，',
            alarm_value: 1,
            saving_path: '20220416_080000/',
            audio_name: '20220416_080000.wav',
            files_status: 0
          }
        ]
      }
    })
    const page = await client.listAlarmLogs()
    assert.equal(page.logsCount, 3048)
    assert.equal(page.logs.length, 2)

    const first = page.logs[0]
    assert.ok(first)
    assert.equal(first.alarmReasons, '时域能量比超限，')
    assert.equal(first.alarmValue, 256)
    assert.equal(first.savingPath, '20220416_075133/')
    assert.equal(first.audioName, '20220416_075133.wav')
    assert.equal(first.filesStatus, 1)
    assert.equal(first.values.db_value, 51.569347)
    assert.equal(first.values.tde_ratio, 2.4)
    // 时间另外解一份，原文照样留着。
    assert.equal(first.time, '2022-04-16_07-51-33')
    assert.equal(first.timeMs, new Date(2022, 3, 16, 7, 51, 33, 0).getTime())

    assert.equal(page.logs[1]?.filesStatus, 0)
  })

  it('日志里出现认不出的键不抛异常（设备多给字段是常态）', async () => {
    const { client } = await device({
      logs: { logs: [{ time: '2022-04-16_07-51-33', brand_new_field: 7 }, 'not-an-object', null] }
    })
    const page = await client.listAlarmLogs()
    // 非对象项被丢掉，对象项保留（没有 time 也照样保留，空串表示"没给"）。
    assert.equal(page.logs.length, 1)
    assert.equal(page.logs[0]?.time, '2022-04-16_07-51-33')
  })
})

describe('E2 客户端：下载告警文件', () => {
  it('`file_path` 必须含 saving_path；返回的是原始字节', async () => {
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46])
    const { fake, client } = await device({ file: { status: 200, bytes } })
    const downloaded = await client.downloadAlarmFile({
      savingPath: '20220416_075133/',
      fileName: '20220416_075133.wav'
    })
    assert.deepEqual([...downloaded], [...bytes])

    const call = fake.requests.find((request) => request.path === '/alarm_files')
    assert.ok(call)
    assert.equal(call.query.get('file_path'), '20220416_075133/20220416_075133.wav')
  })

  it('404 ⇒ 说清"文件被保留策略清掉了"，而不是笼统的下载失败', async () => {
    const { client } = await device({ file: { status: 404, bytes: Buffer.alloc(0) } })
    await assert.rejects(
      () => client.downloadAlarmFile({ savingPath: 'x/', fileName: '1.jpg' }),
      /保留策略清掉/
    )
  })

  it('缺路径或文件名 ⇒ 参数错误（不发请求）', async () => {
    const { fake, client } = await device()
    await assert.rejects(
      () => client.downloadAlarmFile({ savingPath: '', fileName: '1.jpg' }),
      /缺少告警文件路径或文件名/
    )
    assert.equal(fake.requests.some((request) => request.path === '/alarm_files'), false)
  })

  it('参数错误（400）与设备故障分开报', async () => {
    const { client } = await device({ file: { status: 400, bytes: Buffer.alloc(0) } })
    await assert.rejects(
      () => client.downloadAlarmFile({ savingPath: 'x/', fileName: '1.jpg' }),
      /下载告警文件失败 \(HTTP 400\)/
    )
  })
})

describe('E2 客户端：其它端点', () => {
  it('/basic 收窄六个字段', async () => {
    const { client } = await device()
    const info = await client.getBasic()
    assert.equal(info.devName, 'E2-1')
    assert.equal(info.devType, 'AR02')
    assert.equal(info.devVersion, 'V2.8.0')
  })

  it('/hb_settings 读回三个字段；写只发点名的字段', async () => {
    const { fake, client } = await device()
    const settings = await client.getHeartbeatSettings()
    assert.equal(settings.isNotifyHeartbeat, 0)
    assert.equal(settings.notifyInterval, 20)
    assert.equal(settings.notifyUrl, 'http://a:8000')

    await client.putHeartbeatSettings({ notifyUrl: 'http://ours:9000/alarm' })
    const put = fake.requests.find(
      (request) => request.method === 'PUT' && request.path === '/hb_settings'
    )
    assert.ok(put)
    // 只发点名的字段：不把设备原来的 notify_interval 覆盖成我们猜的值。
    assert.deepEqual(put.body, { notify_url: 'http://ours:9000/alarm' })
  })

  it('心跳设置一个字段都不给 ⇒ 参数错误', async () => {
    const { client } = await device()
    await assert.rejects(() => client.putHeartbeatSettings({}), /至少要给一个字段/)
  })

  it('保留条数是手册常量（不是从设备读的）', async () => {
    const { client } = await device()
    assert.equal(client.alarmLogRetention, 5000)
  })
})

describe('E2 客户端：地址规整', () => {
  it('裸 IP / 带协议 / 带端口 / 带尾斜杠都统一成 `协议//主机`', () => {
    assert.equal(normaliseE2BaseUrl('192.168.2.190'), 'http://192.168.2.190')
    assert.equal(normaliseE2BaseUrl('http://192.168.2.190/'), 'http://192.168.2.190')
    assert.equal(normaliseE2BaseUrl('  https://192.168.2.190:8443/api/  '), 'https://192.168.2.190:8443')
  })

  it('空地址与坏地址都拒绝', () => {
    assert.throws(() => normaliseE2BaseUrl('   '), /设备地址不能为空/)
  })
})

// ---------------------------------------------------------------------------
// 端点按**设备回话**回退（2026-09-17 真机验证）
// ---------------------------------------------------------------------------

/**
 * 一台**固件 V3.4.0 的 SN-16 空气声呐**的形状（不是手册里那台）：
 *   - `/system` 回 PTZ 参数键 ⇒ 判成第二代（`airSonar`）；
 *   - 手册给第二代写的三个路径 **全部 404**；
 *   - 它真正用的是 2023 版那一套（`/basic`、`/alarm_log_all`、`/alarm_log`）；
 *   - 录音与抓图是**静态文件**：`/static_file/<saving_path><name>`。
 */
async function startV34Sonar(options: { bytes?: Buffer } = {}): Promise<{
  baseUrl: string
  counts: Map<string, number>
  close(): Promise<void>
}> {
  const counts = new Map<string, number>()
  const bytes = options.bytes ?? Buffer.from('RIFF0000WAVE', 'ascii')
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1)
    const json = (status: number, payload: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }

    if (url.pathname === '/login') return json(200, { token: 'v34-token' })
    if ((request.headers.authorization ?? '') !== 'Bearer v34-token') return json(401, { ret: -1 })

    if (url.pathname === '/system') {
      // PTZ 键在 ⇒ 变体判定为 airSonar。
      return json(200, { cam_enable: false, cur_realtime_channel: 1, db_limit: 60, samplerate: 20000 })
    }
    if (url.pathname === '/basic') {
      return json(200, {
        dev_name: '',
        dev_type: 'AS16-auth-vertical-reverse',
        dev_version: 'V3.4.0.2024-11-27',
        web_version: 'WEBV2.3.0',
        equip_number: 'C864C0DF79A220674582107B4EE2E533'
      })
    }
    if (url.pathname === '/alarm_log_all' || url.pathname === '/alarm_log') {
      return json(200, {
        logs: [
          {
            id: 54143,
            time: '2026-07-27_10-15-19',
            db_value: 70.593475,
            tde_ratio: 39.171417,
            fde_ratio: 0.97140485,
            horizontal: 45,
            vertical: 90,
            saving_path: '20260727_101519/',
            files_status: 1
          }
        ]
      })
    }
    if (url.pathname.startsWith('/static_file/')) {
      // 只服务**这一条真实存在的**文件；别的路径 404（否则"文件被清掉"那条断言永远为真）。
      if (url.pathname === '/static_file/20260727_101519/alarm.wav') {
        response.writeHead(200, { 'content-type': 'audio/wav' })
        response.end(bytes)
        return
      }
      return json(404, { msg: 'no such file' })
    }
    return json(404, { msg: 'no such endpoint' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    counts,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

describe('E2 客户端：手册路径 404 时退到设备真正有的那条（真机 V3.4.0 形状）', () => {
  function clientFor(baseUrl: string): E2Client {
    return new E2Client({
      transport: new FetchHttpTransport(3_000),
      baseUrl,
      credentials: { username: 'admin', password: 'x' },
      timeoutMs: 3_000
    })
  }

  it('设备信息 / 全部日志 / 条件日志 / 文件下载四条都退得过去，而且只试一次', async () => {
    const device = await startV34Sonar()
    try {
      const client = clientFor(device.baseUrl)
      await client.getSystem()
      assert.equal(client.resolvedVariant, 'airSonar')

      const info = await client.getBasic()
      assert.equal(info.devType, 'AS16-auth-vertical-reverse')
      assert.equal(e2ChannelCountFromModel(info.devType), 16)

      const all = await client.listAlarmLogs({ colCount: 1 })
      assert.equal(all.logs.length, 1)
      assert.equal(all.logs[0]?.savingPath, '20260727_101519/')

      const conditional = await client.queryAlarmLogs({ colCount: 1 })
      assert.equal(conditional.logs.length, 1)

      const downloaded = await client.downloadAlarmFile({
        savingPath: '20260727_101519/',
        fileName: 'alarm.wav'
      })
      assert.equal(downloaded.byteLength, 12)

      // 再来一轮：**每一条已确认的路径都不再试 404 那条**（这是"记住赢家"的意义）。
      await client.getBasic()
      await client.listAlarmLogs({ colCount: 1 })
      await client.downloadAlarmFile({ savingPath: '20260727_101519/', fileName: 'alarm.wav' })

      const counts = device.counts
      assert.equal(counts.get('/get_device_basic_params'), 1, '手册那条只该试一次')
      assert.equal(counts.get('/basic'), 2, '确认之后每次都用 /basic')
      assert.equal(counts.get('/get_all_alarms'), 1, '手册那条只该试一次')
      assert.equal(counts.get('/alarm_log_all'), 2)
      assert.equal(counts.get('/get_alarm_logs_conditional'), 1, '手册那条只该试一次')
      assert.equal(counts.get('/alarm_log'), 1)
      assert.equal(counts.get('/saving_alarm_file'), 1, '手册那条只该试一次')
      assert.equal(counts.get('/static_file/20260727_101519/alarm.wav'), 2)
    } finally {
      await device.close()
    }
  })

  it('三条下载路径都 404 ⇒ 仍然说清"文件可能被保留策略清掉"', async () => {
    const device = await startV34Sonar()
    try {
      const client = clientFor(device.baseUrl)
      await assert.rejects(
        () => client.downloadAlarmFile({ savingPath: 'missing/', fileName: 'alarm.wav' }),
        /保留策略清掉/
      )
    } finally {
      await device.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 分端口设备（2026-09-22 真机形状：API 在 8888，nginx 在 80）
// ---------------------------------------------------------------------------

/**
 * 一台**端口分裂**的 SN-16（真机 192.168.110.234 的形状）：
 *   - **api 端口**（真机 8888）：`/login` 只在这里；`/system`、`/alarm_log_all`、`/alarm_log`
 *     正常；**不实现的端点回 501 空正文**（`/basic`、`/get_device_basic_params`、
 *     `/get_all_alarms`、`/saving_alarm_file`、`/alarm_files`、`/static_file/*`）。
 *   - **web 端口**（真机 80 的 nginx）：`/login` 回 **404 HTML**（这是当初 `INVALID_RESPONSE`
 *     的来源）；`/system` 与日志接口有反代；`/static_file/<路径>` 只有这里有文件。
 * 测试里两台假服务都监听随机端口，靠 `portPair` 告诉客户端"这一对端口相当于 80/8888"。
 */
async function startSplitPortSonar(): Promise<{
  webBase: string
  apiBase: string
  portPair: { web: number; api: number }
  counts: Map<string, number>
  fileBytes: Buffer
  close(): Promise<void>
}> {
  const counts = new Map<string, number>()
  const fileBytes = Buffer.from('RIFF0000WAVE', 'ascii')
  const SYSTEM = { cam_enable: false, cur_realtime_channel: 1, db_limit: 60, samplerate: 20000 }
  const LOGS = {
    logs_count: 1,
    logs: [
      {
        id: 55288,
        time: '2026-09-18_16-00-44',
        db_value: 65.37294,
        tde_ratio: 31.842154,
        fde_ratio: 0.9789469,
        horizontal: 96,
        vertical: 30,
        saving_path: '20260918_160044/',
        files_status: 1
      }
    ]
  }

  const listen = (handler: http.RequestListener): Promise<{ server: http.Server; port: number }> =>
    new Promise((resolve) => {
      const server = http.createServer(handler)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 })
      })
    })

  const count = (port: number, path: string): void => {
    const key = `${port}${path}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const json = (response: http.ServerResponse, status: number, payload: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  }
  const html404 = (response: http.ServerResponse): void => {
    response.writeHead(404, { 'content-type': 'text/html' })
    response.end('<html><head><title>404 Not Found</title></head></html>')
  }

  // web 端口（nginx 角色）：不反代 /login；反代 /system 与日志；静态文件只在这里。
  const web = await listen((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    count(webPort, `${request.method} ${url.pathname}`)
    if (url.pathname === '/system') return json(response, 200, SYSTEM)
    if (url.pathname === '/alarm_log_all' || url.pathname === '/alarm_log') {
      return json(response, 200, LOGS)
    }
    if (url.pathname === '/static_file/20260918_160044/alarm.wav') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(fileBytes)
      return
    }
    html404(response)
  })
  const webPort = web.port

  // api 端口（8888 角色）：登录在这里；不实现的端点一律 501 空正文。
  const api = await listen((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    count(apiPort, `${request.method} ${url.pathname}`)
    if (url.pathname === '/login') return json(response, 200, { token: 'split-token' })
    if ((request.headers.authorization ?? '') !== 'Bearer split-token') {
      return json(response, 401, { msg: 'unauthorized' })
    }
    if (url.pathname === '/system') return json(response, 200, SYSTEM)
    if (url.pathname === '/alarm_log_all' || url.pathname === '/alarm_log') {
      return json(response, 200, LOGS)
    }
    // 这台固件对不实现的端点回 501（不是 404）—— 回退链必须认得它。
    response.writeHead(501)
    response.end()
  })
  const apiPort = api.port

  return {
    webBase: `http://127.0.0.1:${webPort}`,
    apiBase: `http://127.0.0.1:${apiPort}`,
    portPair: { web: webPort, api: apiPort },
    counts,
    fileBytes,
    close: () =>
      Promise.all([
        new Promise<void>((resolve) => web.server.close(() => resolve())),
        new Promise<void>((resolve) => api.server.close(() => resolve()))
      ]).then(() => undefined)
  }
}

describe('E2 客户端：分端口设备（登录只在 API 端口，2026-09-22 真机形状）', () => {
  function clientFor(base: string, portPair: { web: number; api: number }): E2Client {
    return new E2Client({
      transport: new FetchHttpTransport(3_000),
      baseUrl: base,
      credentials: { username: 'admin', password: 'x' },
      timeoutMs: 3_000,
      portPair
    })
  }

  it('网页端口的 /login 回 404 ⇒ 自动回退到 API 端口并切换基地址（不再报 INVALID_RESPONSE）', async () => {
    const device = await startSplitPortSonar()
    try {
      const client = clientFor(device.webBase, device.portPair)
      const token = await client.login()
      assert.equal(token, 'split-token')
      assert.equal(client.currentBaseUrl, device.apiBase)
      assert.equal(device.counts.get(`${device.portPair.web}POST /login`), 1, '网页端口只试一次')
      assert.equal(device.counts.get(`${device.portPair.api}POST /login`), 1)
    } finally {
      await device.close()
    }
  })

  it('501 也触发换代回退：日志退到 /alarm_log_all；基本信息全 501 时报"没有这个端点"', async () => {
    const device = await startSplitPortSonar()
    try {
      const client = clientFor(device.webBase, device.portPair)
      await client.getSystem()
      assert.equal(client.resolvedVariant, 'airSonar')

      await assert.rejects(() => client.getBasic(), /没有这个端点/)

      const page = await client.listAlarmLogs({ colCount: 5 })
      assert.equal(page.logs.length, 1)
      assert.equal(page.logs[0]?.savingPath, '20260918_160044/')
      // 手册那条 501 过、换 2023 版那条成功；而且文件名按 Air Sonar 的固定名补上。
      assert.equal(device.counts.get(`${device.portPair.api}GET /get_all_alarms`), 1)
      assert.equal(device.counts.get(`${device.portPair.api}GET /alarm_log_all`), 1)
      assert.equal(page.logs[0]?.audioName, 'alarm.wav')
    } finally {
      await device.close()
    }
  })

  it('静态文件只在网页端口：下载跨端口成功，并记住赢家的基地址', async () => {
    const device = await startSplitPortSonar()
    try {
      const client = clientFor(device.webBase, device.portPair)
      await client.getSystem()

      const downloaded = await client.downloadAlarmFile({
        savingPath: '20260918_160044/',
        fileName: 'alarm.wav'
      })
      assert.deepEqual([...downloaded], [...device.fileBytes])

      // 第二轮：已确认静态路径 + 已确认基地址，不再挨个试 501 的那些。
      await client.downloadAlarmFile({ savingPath: '20260918_160044/', fileName: 'alarm.wav' })

      const api = device.portPair.api
      const web = device.portPair.web
      assert.equal(device.counts.get(`${api}GET /saving_alarm_file`), 1, '手册那条只该试一次')
      assert.equal(device.counts.get(`${api}GET /alarm_files`), 1, '另一代那条只该试一次')
      assert.equal(
        device.counts.get(`${api}GET /static_file/20260918_160044/alarm.wav`),
        1,
        'API 端口上的静态路径只该试一次（它是 501）'
      )
      assert.equal(device.counts.get(`${web}GET /static_file/20260918_160044/alarm.wav`), 2)
    } finally {
      await device.close()
    }
  })
})
