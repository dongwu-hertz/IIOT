/**
 * IoT 数据接入（业主 2026-09-19 第 1 条：「HTTP 推流和 MQTT 是类似于 thingsboard 平台接
 * IOT 设备的逻辑，你去调研，然后开发」）。
 *
 * WHY THIS FILE EXISTS
 * 这一条新需求有三块**不能靠读源码相信**的东西，所以每一块都用真东西验：
 *   1. **HTTP 接入**：起一个真的监听（端口 0 = 由系统分配），用真的 POST 打上去，
 *      断言状态码（200 / 401 / 404 / 400 / 405）与**落库结果**；
 *   2. **MQTT broker**：起真的 TCP 监听，用一个真的 socket 发一段真的 CONNECT / PUBLISH 字节，
 *      断言 CONNACK / PUBACK 的字节与落库结果 —— 手写的协议编解码是这一轮最容易错的地方；
 *   3. **秘钥**：库里写进去、读回来必须一致（仓库层），而且**换一条之后旧的立刻不认**。
 *
 * 纯函数的形状（秘钥规则 / 载荷三种形状 / 键对照表 / 配置归一化）也在这里逐条钉住，
 * 因为那些是界面与主进程共用的判据（`@shared/domain/iot-ingest`）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { after, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import {
  DEFAULT_INGEST_VIDEO_KEY,
  IOT_INGEST_LIMITS,
  INGEST_DISPLAY_METRICS,
  INGEST_PROTOCOLS,
  MAX_INGEST_METRIC_KEYS,
  MQTT_TELEMETRY_TOPIC,
  PUSH_SECRET_BYTES,
  PUSH_SECRET_LENGTH,
  defaultDeviceIngestPlan,
  defaultIngestMetricKeys,
  defaultIotIngestConfig,
  deviceIngestPlanProblems,
  httpPushUrl,
  interpretTelemetry,
  isBindAddress,
  isIngestKey,
  isIngestProtocol,
  isPort,
  isPushSecret,
  normaliseDeviceIngestPlan,
  normaliseIngestProtocol,
  normaliseIotIngestConfig,
  parseTelemetryPayload,
  pushSecretFromBytes,
  secretFromAttributesPath,
  secretFromTelemetryPath,
  telemetryPath,
  usesIngest
} from '../src/shared/domain/iot-ingest'
import {
  MQTT_CONNACK,
  decodeConnect,
  decodePublish,
  encodeRemainingLength,
  readFixedHeader
} from '../src/main/services/ingest/mqtt-codec'
import { TelemetryIntake } from '../src/main/services/ingest/telemetry-intake'
import { IotIngestService } from '../src/main/services/ingest/iot-ingest-service'
import { DeviceRepository } from '../src/main/services/database/device-repository'
import { AlarmRepository } from '../src/main/services/database/alarm-repository'
import { openDatabase } from '../src/main/services/database/schema'
import type { RealtimeFeature } from '../src/shared/domain/models'
import type { AlarmInsert } from '../src/main/services/database/alarm-repository'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iot-ingest-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

let counter = 0
function freshDb(): InstanceType<typeof Database> {
  counter += 1
  return openDatabase({ file: path.join(tempRoot, `db-${counter}.db`) })
}

const SECRET = 'a'.repeat(32)
const OTHER_SECRET = 'b'.repeat(32)

/** 一个假设备（不用真库也能验落库）。 */
const DEVICE = { id: 'dev-local-1', deviceUid: 'uid-dev-1', name: 'AE08' }

interface Sink {
  features: RealtimeFeature[]
  alarms: AlarmInsert[]
  intake: TelemetryIntake
}

function makeIntake(options: { existingAlarm?: boolean; channelCount?: number } = {}): Sink {
  const features: RealtimeFeature[] = []
  const alarms: AlarmInsert[] = []
  const intake = new TelemetryIntake({
    appendFeature: (_deviceUid, feature) => features.push(feature),
    insertAlarm: (input) => {
      alarms.push(input)
      // 幂等命中：模拟仓储的 (设备, 通道, 时间, 位图) 去重。
      return { id: `alarm-${alarms.length}`, created: options.existingAlarm !== true }
    },
    ...(options.channelCount !== undefined
      ? { channelCountFor: () => options.channelCount as number }
      : {})
  })
  return { features, alarms, intake }
}

/** 起一个只服务这一条测试的接入服务（两个端口都由系统分配）。 */
async function startService(sink: Sink, overrides: Partial<Record<string, unknown>> = {}) {
  const received: Array<{ secret: string; rows: number }> = []
  const service = new IotIngestService({
    getConfig: () => ({
      ...defaultIotIngestConfig(),
      enabled: true,
      httpPort: 0,
      mqttPort: 0,
      ...overrides
    }),
    resolveDevice: (secret) => {
      if (secret !== SECRET) return undefined
      received.push({ secret, rows: 0 })
      return DEVICE
    },
    intake: sink.intake
  })
  await service.applyConfig()
  const status = service.status
  assert.equal(status.http.listening, true, `HTTP 没起来：${status.http.error ?? ''}`)
  assert.equal(status.mqtt.listening, true, `MQTT 没起来：${status.mqtt.error ?? ''}`)
  // 端口 0 时 `server.address().port` 是真实端口，但服务的状态里记的是**配置里的 0**。
  const httpPort = actualPort(service, 'http')
  const mqttPort = actualPort(service, 'mqtt')
  return { service, httpPort, mqttPort, received }
}

/**
 * 取真实端口。
 *
 * `listen(0)`（系统分配）之后配置里的 0 不是可连接的端口，而**服务状态里记的是配置值** ——
 * 这是有意的（界面显示的是用户配的端口）。测试要连上去，所以从服务内部的 server 上读真实值。
 * 这里用反射而不是给服务加一个"测试用"的 getter：生产代码不该为测试长出一个字段。
 */
function actualPort(service: IotIngestService, kind: 'http' | 'mqtt'): number {
  const internal = service as unknown as Record<string, { address?: () => { port: number } }>
  const server = internal[kind === 'http' ? 'httpServer' : 'mqttServer']
  const address = server?.address?.()
  assert.ok(address, `${kind} server 没有地址`)
  return address.port
}

async function postJson(
  port: number,
  urlPath: string,
  body: string,
  method = 'POST'
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? body : undefined
  })
  const text = await response.text()
  return { status: response.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

// ---------------------------------------------------------------------------
// 纯函数：秘钥
// ---------------------------------------------------------------------------

describe('秘钥的形状与拼装（我们自己的设计，手册未说明）', () => {
  it('16 字节 → 32 位小写十六进制，而且长度常量与之一致', () => {
    const secret = pushSecretFromBytes(Buffer.alloc(PUSH_SECRET_BYTES, 0xab))
    assert.equal(secret, 'ab'.repeat(16))
    assert.equal(secret.length, PUSH_SECRET_LENGTH)
    assert.equal(PUSH_SECRET_LENGTH, 32)
    assert.ok(isPushSecret(secret))
  })

  it('只认小写十六进制：大写、短一位、带非十六进制字符都不认', () => {
    assert.equal(isPushSecret('a'.repeat(32)), true)
    assert.equal(isPushSecret('A'.repeat(32)), false, '大写不该被当成合法秘钥')
    assert.equal(isPushSecret('a'.repeat(31)), false)
    assert.equal(isPushSecret('a'.repeat(33)), false)
    assert.equal(isPushSecret(`${'a'.repeat(31)}z`), false)
    assert.equal(isPushSecret(undefined), false)
    assert.equal(isPushSecret(123), false)
  })

  it('URL 路径就是 ThingsBoard 的形状：/api/v1/<秘钥>/telemetry', () => {
    assert.equal(telemetryPath(SECRET), `/api/v1/${SECRET}/telemetry`)
    assert.equal(
      httpPushUrl('192.168.110.12', 8080, SECRET),
      `http://192.168.110.12:8080/api/v1/${SECRET}/telemetry`
    )
  })

  it('从路径里取秘钥：路径不对回 undefined，秘钥空回空串（401 与 404 必须分得开）', () => {
    assert.equal(secretFromTelemetryPath(`/api/v1/${SECRET}/telemetry`), SECRET)
    // 结尾多一个斜杠容忍（有些客户端会带）。
    assert.equal(secretFromTelemetryPath(`/api/v1/${SECRET}/telemetry/`), SECRET)
    assert.equal(secretFromTelemetryPath(`/api/v1/${SECRET}`), undefined, '少一段不是遥测路径')
    assert.equal(secretFromTelemetryPath(`/api/v1/${SECRET}/attributes`), undefined)
    // 秘钥里多一段 = 路径不对（404），不是秘钥不对（401）。
    assert.equal(secretFromTelemetryPath('/api/v1/a/b/telemetry'), undefined)
    assert.equal(secretFromAttributesPath(`/api/v1/${SECRET}/attributes`), SECRET)
    assert.equal(secretFromAttributesPath(`/api/v1/${SECRET}/telemetry`), undefined)
  })
})

// ---------------------------------------------------------------------------
// 纯函数：载荷
// ---------------------------------------------------------------------------

describe('遥测载荷的三种形状（ThingsBoard 设备侧 HTTP API）', () => {
  const now = 1_700_000_000_000

  it('形状一：{"key": "value"} —— 一行，时间戳用服务端时间', () => {
    const result = parseTelemetryPayload({ spl: 62.5, smoothness: '4.88' }, now)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.rows.length, 1)
    assert.equal(result.rows[0]?.ts, now)
    assert.deepEqual(result.rows[0]?.values, { spl: 62.5, smoothness: '4.88' })
  })

  it('形状二：[{"k":"v"}, …] —— 多行', () => {
    const result = parseTelemetryPayload([{ spl: 1 }, { spl: 2 }], now)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.rows.length, 2)
    assert.deepEqual(
      result.rows.map((row) => row.values.spl),
      [1, 2]
    )
  })

  it('形状三：{"ts": …, "values": {…}} —— 设备自己的时间（毫秒）', () => {
    const result = parseTelemetryPayload({ ts: 1_651_649_600_512, values: { spl: 60 } }, now)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.rows[0]?.ts, 1_651_649_600_512)
  })

  it('数组里两种形状可以混着来（现场第一条带 ts、后面不带）', () => {
    const result = parseTelemetryPayload(
      [{ ts: 1_651_649_600_512, values: { spl: 1 } }, { spl: 2 }],
      now
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(
      result.rows.map((row) => row.ts),
      [1_651_649_600_512, now]
    )
  })

  it('秒级时间戳按秒理解（只有一种解释方式），越界的拒收', () => {
    const seconds = parseTelemetryPayload({ ts: 1_651_649_600, values: { spl: 1 } }, now)
    assert.equal(seconds.ok, true)
    if (seconds.ok) assert.equal(seconds.rows[0]?.ts, 1_651_649_600_000)

    const absurd = parseTelemetryPayload({ ts: 12, values: { spl: 1 } }, now)
    assert.equal(absurd.ok, false)
    if (!absurd.ok) assert.equal(absurd.reason, 'bad-ts')
  })

  it('嵌套对象不是标量：丢掉并**计数**，不当成字符串塞进去', () => {
    const result = parseTelemetryPayload({ spl: 60, extra: { a: 1 }, list: [1, 2] }, now)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.rows[0]?.values, { spl: 60 })
    assert.equal(result.ignoredValues, 2)
  })

  it('行数上限：超过 200 行明确拒收（不是悄悄丢掉一半）', () => {
    const tooMany = Array.from({ length: IOT_INGEST_LIMITS.maxRowsPerRequest + 1 }, () => ({ spl: 1 }))
    const result = parseTelemetryPayload(tooMany, now)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'too-many-rows')
  })

  it('空载荷 / 非对象明确拒收', () => {
    for (const bad of [{}, [], 'text', 42, null]) {
      const result = parseTelemetryPayload(bad, now)
      assert.equal(result.ok, false, `${JSON.stringify(bad)} 不该被接受`)
    }
  })
})

describe('键对照表：只解释我们认识的那些（不认识的原样报出来）', () => {
  it('固件字段名与驼峰写法都认，通道号与告警位图认', () => {
    const interpreted = interpretTelemetry({
      sound_pressure_level: 62.5,
      main_freq: 93,
      smoothness: 4.88,
      freq_band_energy_ratio: 0.5,
      hr_f: 1,
      sc_f: 2,
      sv_f: 3,
      channel_id: 3,
      alarm_mask: 4
    })
    assert.deepEqual(interpreted.features, {
      spl: 62.5,
      mainFrequency: 93,
      smoothness: 4.88,
      bandEnergyRatio: 0.5,
      oddEvenHarmonicRatio: 1,
      spectralComplexity: 2,
      fingerprintVariation: 3
    })
    assert.equal(interpreted.channelId, 3)
    assert.equal(interpreted.alarmMask, 4)
    assert.deepEqual(interpreted.unrecognised, [])
  })

  it('字符串数字能收敛成数；不是数的值进 unrecognised', () => {
    const interpreted = interpretTelemetry({ spl: '62.5', smoothness: 'abc' })
    assert.equal(interpreted.features.spl, 62.5)
    assert.equal(interpreted.features.smoothness, undefined)
    assert.deepEqual(interpreted.unrecognised, ['smoothness'])
  })

  it('通道号越界 / 位图越界都不认（当没给，而不是截断成看起来合法的值）', () => {
    const channel = interpretTelemetry({ spl: 1, channel_id: 99 })
    assert.equal(channel.channelId, undefined)
    assert.ok(channel.unrecognised.includes('channel_id'))

    const mask = interpretTelemetry({ spl: 1, alarm_mask: 1 << 14 })
    assert.equal(mask.alarmMask, undefined)
    assert.ok(mask.unrecognised.includes('alarm_mask'))
  })

  it('听诊盒子的 `alarm_value` **不**在这里解释（那是另一套词，猜不得）', () => {
    const interpreted = interpretTelemetry({ alarm_value: 0x20 })
    assert.equal(interpreted.alarmMask, undefined)
    assert.deepEqual(interpreted.unrecognised, ['alarm_value'])
  })
})

describe('接入配置的归一化（界面与主进程共用同一份判据）', () => {
  it('出厂默认：关闭、两个通道都开、8080 / 1883、绑 0.0.0.0', () => {
    const defaults = defaultIotIngestConfig()
    assert.equal(defaults.enabled, false, '默认必须是关闭的（离线优先）')
    assert.equal(defaults.httpPort, 8080)
    assert.equal(defaults.mqttPort, 1883)
    assert.equal(defaults.bindAddress, '0.0.0.0')
    /*
     * 两个通道**出厂是开的**，总开关才是那一道闸：装完软件不开端口（离线优先），
     * 但操作员一旦打开总开关，两个监听应当都在，而不是"打开了却什么都没监听"。
     *
     * 2026-09-19 加这两条断言的原因：GUI 探针里那一组"出厂默认"的断言是**量不到**的
     * （探针跑在操作员真实 profile 的副本上，读到的是**设置值**，不是出厂值）——
     * 它一直是靠"操作员恰好没动过那个开关"装绿的。出厂值只在这里钉。
     */
    assert.equal(defaults.httpEnabled, true, 'HTTP 通道出厂应当是开的')
    assert.equal(defaults.mqttEnabled, true, 'MQTT 通道出厂应当是开的')
  })

  /*
   * 接入方案（业主 2026-09-19 第 13 批第 3、4 条）。这一组纯函数是那一块界面的地基：
   * 界面下一轮才接上，但"什么算合法、坏值怎么修"必须现在就有唯一答案
   * （设计说明见 `docs/Ivrs4200-UX-REFERENCE.md` §15.77 —— 文件名是 `Ivms4200`）。
   */
  it('接入方式：三种取值，坏值一律归 none（最保守的那一档）', () => {
    assert.deepEqual([...INGEST_PROTOCOLS], ['none', 'http', 'mqtt'])
    for (const good of INGEST_PROTOCOLS) assert.equal(isIngestProtocol(good), true, good)
    for (const bad of ['HTTP', 'tcp', '', undefined, null, 7, {}]) {
      assert.equal(isIngestProtocol(bad), false, String(bad))
      assert.equal(normaliseIngestProtocol(bad), 'none', String(bad))
    }
    assert.equal(usesIngest('none'), false)
    assert.equal(usesIngest('http'), true)
    assert.equal(usesIngest('mqtt'), true)
  })

  it('键名形状：与 ThingsBoard 的遥测键同形，空白与逗号一律不收', () => {
    for (const good of ['spl', 'sound_pressure_level', 'main_freq', 'a1', 'x.y-z_1']) {
      assert.equal(isIngestKey(good), true, good)
    }
    for (const bad of ['', '1abc', 'has space', 'a,b', 'a'.repeat(65), undefined, 3]) {
      assert.equal(isIngestKey(bad), false, String(bad))
    }
  })

  it('出厂接入方案：none + 四个指标的规范键 + video_url', () => {
    const plan = defaultDeviceIngestPlan()
    assert.equal(plan.protocol, 'none')
    assert.equal(plan.videoKey, DEFAULT_INGEST_VIDEO_KEY)
    assert.deepEqual(
      plan.metricKeys.map((row) => row.metric),
      [...INGEST_DISPLAY_METRICS]
    )
    assert.deepEqual(
      plan.metricKeys.map((row) => row.key),
      ['sound_pressure_level', 'main_freq', 'smoothness', 'freq_band_energy_ratio']
    )
    assert.deepEqual(defaultIngestMetricKeys(), plan.metricKeys)
  })

  it('规范化：坏行逐条丢掉、同一指标后写的赢、全空回默认', () => {
    const normalised = normaliseDeviceIngestPlan({
      protocol: 'MQTT',
      metricKeys: [
        { metric: 'spl', key: 'my_spl' },
        { metric: 'spl', key: 'spl_again' },
        { metric: 'nope', key: 'x' },
        { metric: 'smoothness', key: 'has space' },
        { metric: 'mainFrequency', key: 'f0' }
      ],
      videoKey: 'cam_url'
    })
    // 协议坏值 → none；spl 留最后一条；两行坏行丢掉；顺序按第一次出现。
    assert.equal(normalised.protocol, 'none')
    assert.deepEqual(normalised.metricKeys, [
      { metric: 'spl', key: 'spl_again' },
      { metric: 'mainFrequency', key: 'f0' }
    ])
    assert.equal(normalised.videoKey, 'cam_url')

    // 一整行都没有 → 回默认四行（切到 http 时不必先把四个键敲一遍）。
    assert.deepEqual(normaliseDeviceIngestPlan({ protocol: 'http' }).metricKeys, defaultIngestMetricKeys())
    // 视频键：空串 = 明确不要这一路；坏值 → 回默认。
    assert.equal(normaliseDeviceIngestPlan({ videoKey: '' }).videoKey, '')
    assert.equal(normaliseDeviceIngestPlan({ videoKey: 'has space' }).videoKey, DEFAULT_INGEST_VIDEO_KEY)
    // 上限：多出来的丢掉。
    const many = {
      metricKeys: Array.from({ length: MAX_INGEST_METRIC_KEYS + 5 }, (_, index) => ({
        metric: 'spl',
        key: `k${index}`
      }))
    }
    assert.equal(normaliseDeviceIngestPlan(many).metricKeys.length, 1)
  })

  it('界面用的即时校验：合法方案零问题，重复/坏键各报各的', () => {
    assert.deepEqual(deviceIngestPlanProblems(defaultDeviceIngestPlan()), [])
    assert.deepEqual(
      deviceIngestPlanProblems({
        protocol: 'http',
        metricKeys: [
          { metric: 'spl', key: 'a' },
          { metric: 'spl', key: 'a' }
        ],
        videoKey: ''
      }),
      ['metric-duplicate', 'key-duplicate'],
      '同一个指标、同一个键各报一次'
    )
    assert.deepEqual(
      deviceIngestPlanProblems({
        protocol: 'http',
        metricKeys: [{ metric: 'spl', key: 'has space' }],
        videoKey: 'bad key'
      }),
      ['key-invalid', 'video-key-invalid']
    )
    assert.deepEqual(
      deviceIngestPlanProblems({ protocol: 'http', metricKeys: [], videoKey: '' }),
      ['metric-keys-empty']
    )
  })

  it('绑定地址只认 0.0.0.0 / 127.0.0.1 / 一个 IPv4 字面量', () => {
    for (const good of ['0.0.0.0', '127.0.0.1', '192.168.110.12']) {
      assert.equal(isBindAddress(good), true, good)
    }
    for (const bad of ['localhost', '1.2.3.4.5', '999.1.1.1', '', 7, null]) {
      assert.equal(isBindAddress(bad), false, String(bad))
    }
  })

  it('端口只认 1..65535 的整数', () => {
    assert.equal(isPort(1), true)
    assert.equal(isPort(65535), true)
    assert.equal(isPort(0), false)
    assert.equal(isPort(65536), false)
    assert.equal(isPort(80.5), false)
    assert.equal(isPort('80'), false)
  })

  it('坏字段逐项回落到默认值（一个坏端口不该把地址也清掉）', () => {
    const { config, issues } = normaliseIotIngestConfig({
      enabled: true,
      httpPort: 999999,
      bindAddress: 'nope'
    })
    assert.equal(config.enabled, true, '合法字段必须保留')
    assert.equal(config.httpPort, 8080, '坏端口回落默认值')
    assert.equal(config.bindAddress, '0.0.0.0', '坏地址回落默认值')
    assert.deepEqual(issues.sort(), ['bindAddress', 'httpPort'])
  })

  it('总开关与通道开关只接受真正的布尔值（字符串 "false" 不算）', () => {
    const { config, issues } = normaliseIotIngestConfig({ enabled: 'false' })
    assert.equal(config.enabled, false)
    assert.deepEqual(issues, ['enabled'])
  })

  it('两个通道同端口是**冲突**，归一化器不替用户改端口', () => {
    const { config, portConflict } = normaliseIotIngestConfig({ httpPort: 9000, mqttPort: 9000 })
    assert.equal(portConflict, true)
    assert.equal(config.httpPort, 9000)
    assert.equal(config.mqttPort, 9000)
  })
})

// ---------------------------------------------------------------------------
// 落库：收到的行交给已有的两条路
// ---------------------------------------------------------------------------

describe('收到的遥测写进趋势与告警（不新开第二套存储）', () => {
  it('声学量进趋势行，认不出的键进 unrecognised，通道越界不写', () => {
    const sink = makeIntake({ channelCount: 8 })
    const outcome = sink.intake.ingest(DEVICE, [
      { ts: 1000, values: { sound_pressure_level: 61, main_freq: 90, mystery: 1 } }
    ])
    assert.equal(outcome.trendRows, 1)
    assert.equal(sink.features.length, 1)
    // 趋势行里的 deviceId 是**稳定 uid**（目录键），与实时流那条路逐字一致。
    assert.equal(sink.features[0]?.deviceId, DEVICE.deviceUid)
    assert.equal(sink.features[0]?.spl, 61)
    assert.equal(sink.features[0]?.mainFrequency, 90)
    // 缺席的量是 NaN（"没有"），不是 0（0 会被画成一条实测读数）。
    assert.ok(Number.isNaN(sink.features[0]?.smoothness ?? 0))
    assert.deepEqual(outcome.unrecognised, ['mystery'])

    // 通道 9 超出这台设备的 8 路：不进趋势，而且**说出来**。
    const outOfRange = sink.intake.ingest(DEVICE, [{ ts: 1001, values: { spl: 1, channel_id: 9 } }])
    assert.equal(outOfRange.trendRows, 0)
    assert.equal(sink.features.length, 1)
    assert.ok(outOfRange.unrecognised.some((key) => key.includes('channel_id')))
  })

  it('带 alarm_mask 的行落告警表，来源记 fa8（位图就是 FA8 的词汇）', () => {
    const sink = makeIntake()
    const outcome = sink.intake.ingest(DEVICE, [
      { ts: 2000, values: { alarm_mask: 4, spl: 70, channel_id: 2 } }
    ])
    assert.equal(outcome.alarmRows, 1)
    assert.equal(sink.alarms.length, 1)
    const alarm = sink.alarms[0]
    assert.equal(alarm?.deviceId, DEVICE.id)
    assert.equal(alarm?.channelId, 2)
    assert.equal(alarm?.alarmMask, 4)
    assert.equal(alarm?.source, 'fa8')
    assert.equal(alarm?.spl, 70)
    // 原始载荷原样存一列：认不出的键也在里面，现场问题事后追得了。
    assert.match(String(alarm?.deviceRaw), /alarm_mask/)
  })

  it('一行里既有量值又有位图时**两件都做**（设备常常一条消息两件事）', () => {
    const sink = makeIntake()
    const outcome = sink.intake.ingest(DEVICE, [
      { ts: 3000, values: { alarm_mask: 8, smoothness: 3.5 } }
    ])
    assert.equal(outcome.trendRows, 1)
    assert.equal(outcome.alarmRows, 1)
  })

  it('设备重发同一条告警：幂等命中算 duplicate，不算新告警', () => {
    const sink = makeIntake({ existingAlarm: true })
    const outcome = sink.intake.ingest(DEVICE, [{ ts: 4000, values: { alarm_mask: 1 } }])
    assert.equal(outcome.alarmRows, 0)
    assert.equal(outcome.duplicateAlarms, 1)
  })

  it('一个认得出的键都没有的行：什么都不写，并计入 rowsWithoutKnownKeys', () => {
    const sink = makeIntake()
    const outcome = sink.intake.ingest(DEVICE, [{ ts: 5000, values: { temperature: 21.5 } }])
    assert.equal(outcome.trendRows, 0)
    assert.equal(outcome.alarmRows, 0)
    assert.equal(outcome.rowsWithoutKnownKeys, 1)
    assert.deepEqual(outcome.unrecognised, ['temperature'])
  })
})

// ---------------------------------------------------------------------------
// HTTP：真的起监听、真的发请求
// ---------------------------------------------------------------------------

describe('HTTP 推流端点（真的起监听 + 真的 POST）', () => {
  it('200：认得出的数据写进趋势；响应里回报写了几行', async () => {
    const sink = makeIntake()
    const { service, httpPort } = await startService(sink)
    try {
      const response = await postJson(httpPort, telemetryPath(SECRET), JSON.stringify({ spl: 61.5 }))
      assert.equal(response.status, 200)
      assert.equal(response.json.accepted, 1)
      assert.equal(response.json.trendRows, 1)
      assert.equal(sink.features.length, 1)
      assert.equal(service.status.stats.httpRequests, 1)
      assert.equal(service.status.stats.trendRows, 1)
      assert.equal(service.status.stats.lastSource, 'http')
      assert.equal(service.status.stats.lastDeviceId, DEVICE.id)
    } finally {
      await service.dispose()
    }
  })

  it('401：秘钥不认识（路径是对的）；404：路径不对 —— 两者必须分得开', async () => {
    const sink = makeIntake()
    const { service, httpPort } = await startService(sink)
    try {
      const wrongSecret = await postJson(
        httpPort,
        `/api/v1/${OTHER_SECRET}/telemetry`,
        JSON.stringify({ spl: 1 })
      )
      assert.equal(wrongSecret.status, 401)

      const wrongPath = await postJson(httpPort, '/api/v1/telemetry', JSON.stringify({ spl: 1 }))
      assert.equal(wrongPath.status, 404)

      assert.equal(sink.features.length, 0, '被拒的请求不该落任何数据')
      assert.equal(service.status.stats.rejectedAuth, 1)
      assert.equal(service.status.stats.rejectedPayload, 0)
    } finally {
      await service.dispose()
    }
  })

  it('400：JSON 坏了或载荷形状不对', async () => {
    const sink = makeIntake()
    const { service, httpPort } = await startService(sink)
    try {
      const broken = await postJson(httpPort, telemetryPath(SECRET), '{not json')
      assert.equal(broken.status, 400)
      assert.equal(broken.json.error, 'invalid-json')

      const empty = await postJson(httpPort, telemetryPath(SECRET), JSON.stringify({}))
      assert.equal(empty.status, 400)
      assert.equal(empty.json.error, 'empty-payload')
      assert.equal(service.status.stats.rejectedPayload, 2)
    } finally {
      await service.dispose()
    }
  })

  it('405：遥测路径只接受 POST，并回 Allow 头', async () => {
    const sink = makeIntake()
    const { service, httpPort } = await startService(sink)
    try {
      const response = await fetch(`http://127.0.0.1:${httpPort}${telemetryPath(SECRET)}`)
      assert.equal(response.status, 405)
      assert.equal(response.headers.get('allow'), 'POST')
    } finally {
      await service.dispose()
    }
  })

  it('属性通道只读：GET 回空对象；POST 一律 404（我们不会假装存下了属性）', async () => {
    const sink = makeIntake()
    const { service, httpPort } = await startService(sink)
    try {
      const read = await postJson(httpPort, `/api/v1/${SECRET}/attributes`, '', 'GET')
      assert.equal(read.status, 200)
      assert.deepEqual(read.json, {})

      const write = await postJson(httpPort, `/api/v1/${SECRET}/attributes`, JSON.stringify({ a: 1 }))
      assert.equal(write.status, 404)

      const unknown = await postJson(httpPort, `/api/v1/${OTHER_SECRET}/attributes`, '', 'GET')
      assert.equal(unknown.status, 401)
    } finally {
      await service.dispose()
    }
  })

  it('请求体超过上限回 413（不是把它整个读进内存）', async () => {
    const sink = makeIntake()
    const { service, httpPort } = await startService(sink)
    try {
      const huge = JSON.stringify({ blob: 'x'.repeat(IOT_INGEST_LIMITS.maxBodyBytes + 1024) })
      const response = await postJson(httpPort, telemetryPath(SECRET), huge)
      assert.equal(response.status, 413)
      assert.equal(service.status.stats.rejectedPayload, 1)
    } finally {
      await service.dispose()
    }
  })

  it('总开关关着时**什么都不监听**（离线优先：装了软件不开端口）', async () => {
    const sink = makeIntake()
    const service = new IotIngestService({
      getConfig: () => ({ ...defaultIotIngestConfig(), enabled: false, httpPort: 0, mqttPort: 0 }),
      resolveDevice: () => DEVICE,
      intake: sink.intake
    })
    await service.applyConfig()
    const status = service.status
    assert.equal(status.http.listening, false)
    assert.equal(status.mqtt.listening, false)
    assert.equal(status.http.enabled, false)
    await service.dispose()
  })
})

// ---------------------------------------------------------------------------
// MQTT：真的 TCP 连接 + 真的字节
// ---------------------------------------------------------------------------

/** 拼一个 MQTT 3.1.1 的 CONNECT 报文（用户名 = 秘钥）。 */
function connectPacket(options: {
  clientId: string
  username?: string
  level?: number
}): Buffer {
  const parts: Buffer[] = []
  const pushString = (value: string): void => {
    const bytes = Buffer.from(value, 'utf8')
    const length = Buffer.alloc(2)
    length.writeUInt16BE(bytes.length, 0)
    parts.push(length, bytes)
  }
  pushString('MQTT')
  parts.push(Buffer.from([options.level ?? 4]))
  // flags：clean session + username（0x02 | 0x80）
  parts.push(Buffer.from([options.username === undefined ? 0x02 : 0x82]))
  const keepAlive = Buffer.alloc(2)
  keepAlive.writeUInt16BE(0, 0)
  parts.push(keepAlive)
  pushString(options.clientId)
  if (options.username !== undefined) pushString(options.username)
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([0x10]), encodeRemainingLength(body.length), body])
}

/** 拼一个 QoS 0 的 PUBLISH。 */
function publishPacket(topic: string, payload: string, qos: 0 | 1 = 0, packetId = 1): Buffer {
  const topicBytes = Buffer.from(topic, 'utf8')
  const head = Buffer.alloc(2)
  head.writeUInt16BE(topicBytes.length, 0)
  const id = Buffer.alloc(qos > 0 ? 2 : 0)
  if (qos > 0) id.writeUInt16BE(packetId, 0)
  const body = Buffer.concat([head, topicBytes, id, Buffer.from(payload, 'utf8')])
  const flags = qos << 1
  return Buffer.concat([Buffer.from([0x30 | flags]), encodeRemainingLength(body.length), body])
}

/** 连上去、把 `packets` 依次写出去、等 `expected` 个响应字节。 */
function mqttRoundTrip(port: number, packets: Buffer[], expected: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`MQTT 响应超时，收到 ${Buffer.concat(chunks).length} 字节`))
    }, 4000)
    socket.on('connect', () => {
      for (const packet of packets) socket.write(packet)
    })
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      if (Buffer.concat(chunks).length >= expected) {
        clearTimeout(timer)
        socket.end()
        resolve(Buffer.concat(chunks))
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

describe('MQTT 3.1.1（最小 broker：秘钥当用户名）', () => {
  it('编解码：CONNECT / PUBLISH 都能解出字段，固定头跨分片也认', () => {
    const connect = decodeConnect(connectPacket({ clientId: 'c1', username: SECRET }).subarray(2))
    assert.equal(connect.ok, true)
    if (connect.ok) {
      assert.equal(connect.value.protocolName, 'MQTT')
      assert.equal(connect.value.protocolLevel, 4)
      assert.equal(connect.value.username, SECRET)
      assert.equal(connect.value.clientId, 'c1')
    }

    const publish = publishPacket(MQTT_TELEMETRY_TOPIC, '{"spl":61}', 1, 7)
    const header = readFixedHeader(publish)
    assert.ok(header)
    assert.equal(header.type, 3)
    assert.equal(header.flags & 0x06, 2, 'QoS 1 的旗标位')
    const decoded = decodePublish(header.flags, publish.subarray(header.headerLength))
    assert.equal(decoded.ok, true)
    if (decoded.ok) {
      assert.equal(decoded.value.topic, MQTT_TELEMETRY_TOPIC)
      assert.equal(decoded.value.qos, 1)
      assert.equal(decoded.value.packetId, 7)
      assert.equal(decoded.value.payload.toString('utf8'), '{"spl":61}')
    }

    // 固定头字节不够时返回 undefined（继续缓冲），而不是当成坏包。
    assert.equal(readFixedHeader(Buffer.from([0x30])), undefined)
  })

  it('CONNACK 接受 + PUBLISH 落库（QoS 1 回 PUBACK）', async () => {
    const sink = makeIntake()
    const { service, mqttPort } = await startService(sink)
    try {
      const publish = publishPacket(MQTT_TELEMETRY_TOPIC, JSON.stringify({ spl: 63.25 }), 1, 42)
      const response = await mqttRoundTrip(mqttPort, [
        connectPacket({ clientId: 'device-1', username: SECRET }),
        publish
      ], 6)
      // CONNACK: 20 02 00 00；PUBACK: 40 02 <packet id 大端>
      assert.equal(response[0], 0x20)
      assert.equal(response[3], MQTT_CONNACK.ACCEPTED)
      assert.equal(response[4], 0x40)
      assert.equal(response[5], 0x02)
      assert.equal(response.readUInt16BE(6), 42, 'PUBACK 的 packet id 要原样回')

      assert.equal(sink.features.length, 1)
      assert.equal(sink.features[0]?.spl, 63.25)
      assert.equal(service.status.stats.mqttMessages, 1)
      assert.equal(service.status.stats.trendRows, 1)
      assert.equal(service.status.stats.lastSource, 'mqtt')
    } finally {
      await service.dispose()
    }
  })

  it('秘钥不对：CONNACK 回 5（未授权），并且不落任何数据', async () => {
    const sink = makeIntake()
    const { service, mqttPort } = await startService(sink)
    try {
      const response = await mqttRoundTrip(
        mqttPort,
        [connectPacket({ clientId: 'x', username: OTHER_SECRET })],
        4
      )
      assert.equal(response[3], MQTT_CONNACK.NOT_AUTHORIZED)
      assert.equal(sink.features.length, 0)
      assert.equal(service.status.stats.rejectedAuth, 1)
    } finally {
      await service.dispose()
    }
  })

  it('没有用户名：CONNACK 回 4（凭据不合格）', async () => {
    const sink = makeIntake()
    const { service, mqttPort } = await startService(sink)
    try {
      const response = await mqttRoundTrip(mqttPort, [connectPacket({ clientId: 'x' })], 4)
      assert.equal(response[3], MQTT_CONNACK.BAD_CREDENTIALS)
    } finally {
      await service.dispose()
    }
  })

  it('MQTT 3.1（level 3）明确拒绝，而不是"连上了但不工作"', async () => {
    const sink = makeIntake()
    const { service, mqttPort } = await startService(sink)
    try {
      const response = await mqttRoundTrip(
        mqttPort,
        [connectPacket({ clientId: 'x', username: SECRET, level: 3 })],
        4
      )
      assert.equal(response[3], MQTT_CONNACK.UNACCEPTABLE_PROTOCOL)
    } finally {
      await service.dispose()
    }
  })

  it('QoS 2 明确不支持：断开连接而不是假装收到（不落数据）', async () => {
    const sink = makeIntake()
    const { service, mqttPort } = await startService(sink)
    try {
      const qos2 = publishPacket(MQTT_TELEMETRY_TOPIC, JSON.stringify({ spl: 1 }), 1, 5)
      // 手工把 QoS 位改成 2（0x34）。
      qos2[0] = 0x34

      /**
       * 期望的行为是**服务端主动断开**（不实现 QoS 2 就不假装），所以这里等这条连接被关掉：
       * `destroy()` 在客户端看来可能是 `end`，也可能是 `ECONNRESET` —— 两种都算"被断开了"。
       * 测试自己从不关这条 socket，所以 close / error 只可能来自服务端。
       *
       * 5 秒的余量（而不是 1 秒）：这一条断言的是"连接最终被关掉"，而不是"关得多快"，
       * 把等待卡得太紧只会让它在忙的机器上偶发变红。
       */
      const serverClosed = await new Promise<boolean>((resolve) => {
        const socket = net.connect(mqttPort, '127.0.0.1')
        /**
         * `resume()` 这一句是**必须的**，而且很容易被删掉：Node 的流在没有 `data` 监听器时
         * 处于暂停模式，收到的 CONNACK 会躺在缓冲区里 —— 那时 `end` / `close` 都**不会**触发，
         * 于是"服务端到底有没有断开"这件事在客户端看起来永远是否定的（这一条测试第一版就是
         * 这么红的，而服务端其实早就 `destroy()` 了）。
         */
        socket.resume()
        const timer = setTimeout(() => {
          socket.destroy()
          resolve(false)
        }, 5000)
        const done = (): void => {
          clearTimeout(timer)
          socket.destroy()
          resolve(true)
        }
        socket.on('connect', () => {
          socket.write(connectPacket({ clientId: 'x', username: SECRET }))
          socket.write(qos2)
        })
        socket.on('end', done)
        socket.on('close', done)
        socket.on('error', done)
      })

      // 服务端那一侧的证据先断言：即使连接关闭的事件在极忙的机器上晚到，
      // 「载荷没被写进去 + 被记成拒收」这两条也已经在主进程里成立了。
      assert.equal(service.status.stats.rejectedPayload, 1)
      assert.equal(sink.features.length, 0, 'QoS 2 的载荷不该被写进去')
      assert.equal(serverClosed, true, '服务端没有断开 QoS 2 的连接')
    } finally {
      await service.dispose()
    }
  })

  it('PINGREQ 回 PINGRESP；别的主题被拒但连接不断', async () => {
    const sink = makeIntake()
    const { service, mqttPort } = await startService(sink)
    try {
      const ping = Buffer.from([0xc0, 0x00])
      const response = await mqttRoundTrip(
        mqttPort,
        [connectPacket({ clientId: 'x', username: SECRET }), ping],
        6
      )
      assert.equal(response[4], 0xd0, 'PINGRESP')
    } finally {
      await service.dispose()
    }

    const other = makeIntake()
    const second = await startService(other)
    try {
      const publish = publishPacket('v1/devices/me/attributes', JSON.stringify({ a: 1 }))
      await mqttRoundTrip(
        second.mqttPort,
        [connectPacket({ clientId: 'x', username: SECRET }), publish],
        4
      )
      assert.equal(other.features.length, 0)
      assert.equal(second.service.status.stats.rejectedPayload, 1)
    } finally {
      await second.service.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 秘钥在库里的读写（写后读回）
// ---------------------------------------------------------------------------

describe('秘钥落库：写进去、读回来一致，换一条旧的立刻不认', () => {
  function seed(db: InstanceType<typeof Database>): DeviceRepository {
    db.prepare(
      `INSERT INTO devices (id, device_uid, kind, name, ip_address, http_port, status, created_at, updated_at)
       VALUES ('dev-local-1', 'uid-dev-1', 'acousticBox', 'AE08', '192.168.110.90', 80, 'ONLINE', 1, 1)`
    ).run()
    return new DeviceRepository(db)
  }

  it('新库到 v15，devices 有 push_secret 列与唯一索引', () => {
    const db = freshDb()
    try {
      const columns = (db.pragma('table_info(devices)') as Array<{ name: string }>).map(
        (row) => row.name
      )
      assert.ok(columns.includes('push_secret'), columns.join(','))
      const indexes = (db.pragma('index_list(devices)') as Array<{ name: string; unique: number }>)
      const unique = indexes.find((row) => row.name === 'idx_devices_push_secret')
      assert.ok(unique, '缺唯一索引：两台设备共用一条秘钥会让数据写进另一台')
      assert.equal(unique?.unique, 1)
    } finally {
      db.close()
    }
  })

  it('setPushSecret 返回的是**从库里读回来的**值；非法形状在写入前就被拒', () => {
    const db = freshDb()
    try {
      const devices = seed(db)
      assert.equal(devices.getPushSecret('dev-local-1'), undefined, '没生成过就是 undefined')
      assert.equal(devices.setPushSecret('dev-local-1', SECRET), SECRET)
      assert.equal(devices.getPushSecret('dev-local-1'), SECRET)
      assert.throws(() => devices.setPushSecret('dev-local-1', 'NOT-HEX'), /非法推流秘钥/)
      // 读回来的仍然是原来那一条（被拒的写入没有碰到库）。
      assert.equal(devices.getPushSecret('dev-local-1'), SECRET)
    } finally {
      db.close()
    }
  })

  it('findByPushSecret 是接入服务认设备的那一步：形状不对直接不查库', () => {
    const db = freshDb()
    try {
      const devices = seed(db)
      devices.setPushSecret('dev-local-1', SECRET)
      assert.equal(devices.findByPushSecret(SECRET)?.id, 'dev-local-1')
      assert.equal(devices.findByPushSecret(OTHER_SECRET), undefined)
      assert.equal(devices.findByPushSecret('short'), undefined)
      assert.equal(devices.countWithPushSecret(), 1)
    } finally {
      db.close()
    }
  })

  it('唯一索引真的拦得住两台设备用同一条秘钥', () => {
    const db = freshDb()
    try {
      const devices = seed(db)
      db.prepare(
        `INSERT INTO devices (id, device_uid, kind, name, status, created_at, updated_at)
         VALUES ('dev-2', 'uid-dev-2', 'acousticCamera', 'Camera', 'ONLINE', 1, 1)`
      ).run()
      devices.setPushSecret('dev-local-1', SECRET)
      assert.throws(() => devices.setPushSecret('dev-2', SECRET), /UNIQUE|constraint/i)
    } finally {
      db.close()
    }
  })

  it('轮换：换一条之后，用**新秘钥**推上来的数据落进同一台设备', async () => {
    const db = freshDb()
    try {
      const devices = seed(db)
      const alarms = new AlarmRepository(db)
      devices.setPushSecret('dev-local-1', SECRET)

      const features: RealtimeFeature[] = []
      const intake = new TelemetryIntake({
        appendFeature: (_deviceUid, feature) => features.push(feature),
        insertAlarm: (input) => alarms.insert(input)
      })

      // 轮换：写入新值并**读回核对**。
      const rotated = devices.setPushSecret('dev-local-1', OTHER_SECRET)
      assert.equal(rotated, OTHER_SECRET)
      assert.equal(devices.findByPushSecret(SECRET), undefined, '旧秘钥必须立刻失效')

      const service = new IotIngestService({
        getConfig: () => ({ ...defaultIotIngestConfig(), enabled: true, httpPort: 0, mqttPort: 0 }),
        resolveDevice: (secret) => {
          const device = devices.findByPushSecret(secret)
          return device ? { id: device.id, deviceUid: device.deviceUid, name: device.name } : undefined
        },
        intake
      })
      await service.applyConfig()
      try {
        const port = actualPort(service, 'http')
        const old = await postJson(port, telemetryPath(SECRET), JSON.stringify({ spl: 1 }))
        assert.equal(old.status, 401, '旧秘钥还能推 = 轮换没生效')

        const fresh = await postJson(port, telemetryPath(OTHER_SECRET), JSON.stringify({ spl: 64 }))
        assert.equal(fresh.status, 200)
        assert.equal(features.length, 1)
        assert.equal(features[0]?.deviceId, 'uid-dev-1')
      } finally {
        await service.dispose()
      }

      // 同一条 HTTP 请求里带位图 ⇒ 告警表真的有那一行（"设备推来的告警上角标"由此成立）。
      const withAlarm = await (async () => {
        const service2 = new IotIngestService({
          getConfig: () => ({ ...defaultIotIngestConfig(), enabled: true, httpPort: 0, mqttPort: 0 }),
          resolveDevice: (secret) => {
            const device = devices.findByPushSecret(secret)
            return device
              ? { id: device.id, deviceUid: device.deviceUid, name: device.name }
              : undefined
          },
          intake
        })
        await service2.applyConfig()
        try {
          const port = actualPort(service2, 'http')
          return await postJson(
            port,
            telemetryPath(OTHER_SECRET),
            JSON.stringify({ alarm_mask: 4, spl: 71.5, channel_id: 1 })
          )
        } finally {
          await service2.dispose()
        }
      })()
      assert.equal(withAlarm.status, 200)
      assert.equal(withAlarm.json.alarmRows, 1)
      const rows = alarms.query({ limit: 10 })
      assert.equal(rows.total, 1)
      assert.equal(rows.items[0]?.alarmMask, 4)
      assert.equal(rows.items[0]?.spl, 71.5)
    } finally {
      db.close()
    }
  })

  it('设备被删掉时秘钥一并消失（它长在 devices 行上）', () => {
    const db = freshDb()
    try {
      const devices = seed(db)
      devices.setPushSecret('dev-local-1', SECRET)
      assert.equal(devices.remove('dev-local-1'), true)
      assert.equal(devices.findByPushSecret(SECRET), undefined)
      assert.equal(devices.countWithPushSecret(), 0)
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 源码守卫：界面与文档里那些"必须成对出现"的东西
// ---------------------------------------------------------------------------

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

describe('界面接线（源码守卫）', () => {
  it('数据接入在**添加设备**里（第 13 批第 1 条），设置页那个页签已经删掉', () => {
    /*
     * 这一条在 2026-09-19 第 13 批第 1 条之后**翻了向**：原来钉的是"设置页有第八个页签
     * 数据接入"，现在业主把那一页整体搬进「设备管理 → 添加设备」，所以改钉两件事：
     *   1. 设置页**没有**那个页签了（连词条一起删）；
     *   2. 监听设置与收数读数在设备对话框里，而且判据仍然是共享层那一份
     *      （界面允许写、主进程却回落默认值是最坏的失败）。
     */
    const view = read('src/renderer/src/views/SettingsView.vue')
    assert.equal(view.includes("id: 'iot'"), false, '设置页还有数据接入页签')
    assert.equal(view.includes("t('settingsUi.tabIot')"), false, '设置页还在引用已删的页签词条')
    assert.equal(/iotIngest: \{/.test(view), false, '设置页还在提交 iotIngest（会与设备声明派生打架）')

    const dialog = read('src/renderer/src/components/AddDeviceDialog.vue')
    assert.ok(dialog.includes('data-add-iot-local'), '添加设备对话框里没有「本机接入」那一块')
    for (const hook of [
      'data-add-iot-bind',
      'data-add-iot-http-port',
      'data-add-iot-mqtt-port',
      'data-add-iot-save',
      'data-add-iot-http-status',
      'data-add-iot-stats'
    ]) {
      assert.ok(dialog.includes(hook), `「本机接入」缺探针钩子 ${hook}`)
    }
    // 判据必须是共享层那一份。
    assert.match(dialog, /isBindAddress\(/, '绑定地址没有用共享判据')
    assert.match(dialog, /isPort\(/, '端口没有用共享判据')
    // 写的是**整份** `IotIngestConfig`（契约如此），而派生的三个开关原样带回。
    assert.match(dialog, /iotIngest: \{ \.\.\.current, bindAddress: bind, httpPort, mqttPort \}/)
    // 写后读回核对。
    assert.match(dialog, /t\('iotUi\.saveMismatch'\)/, '保存之后没有核对读回来的值')
  })

  it('设备对话框有推流地址与秘钥，并且**添加成功之后**就能看到', () => {
    const dialog = read('src/renderer/src/components/AddDeviceDialog.vue')
    assert.ok(dialog.includes('DevicePushEndpoint'), '添加设备对话框里没有推流地址那一块')
    assert.match(dialog, /addedDevice\.value = device/, '添加成功之后没有留下那一台设备')
    assert.ok(dialog.includes('data-add-device-done'), '没有"添加成功"那一块')

    const devices = read('src/renderer/src/views/DevicesView.vue')
    assert.ok(devices.includes('DevicePushEndpoint'), '编辑设备对话框里没有推流地址那一块')
    assert.match(devices, /:device-id="editTarget\.id"/, '编辑对话框没把设备 id 传进去')

    const component = read('src/renderer/src/components/DevicePushEndpoint.vue')
    assert.match(component, /window\.api\.devices\.ingestEndpoint\(/, '没有真的去读端点信息')
    assert.match(component, /window\.api\.devices\.rotatePushSecret\(/, '没有接上轮换')
    assert.ok(component.includes('data-push-secret'), '秘钥没有探针钩子')
    assert.ok(component.includes('data-push-http-url'), 'HTTP 推流地址没有探针钩子')
    // 秘钥与地址必须**能复制**（业主的原话是"秘钥 + 推流地址"）。
    assert.match(component, /navigator\.clipboard\.writeText/, '没有复制按钮')
    // 轮换是凭据变更，必须有确认对话框，而且说明旧秘钥立刻失效。
    assert.ok(component.includes("t('iotUi.rotateBody')"), '轮换没有说明后果')
  })

  it('主进程：默认关闭、监听用设置里的地址与端口、设置一变就重新对账', () => {
    const services = read('src/main/services/app-services.ts')
    assert.match(services, /settings\.on\('changed'/, '设置变化没有触发重新对账')
    assert.match(services, /void iotIngest\.applyConfig\(\)/, '启动时没有应用一次配置')
    assert.match(services, /appendFeature: \(deviceUid, feature\) => trends\.append/, '趋势走的是另一条路')
    assert.match(services, /insertAlarm: \(input\) => alarmRepo\.insert/, '告警走的是另一个仓储')
    // 收到推送时**不**新开一套趋势写入器/告警表。
    assert.equal(
      /new TrendStorageService\(\{[\s\S]{0,80}ingest/.test(services),
      false,
      '接入服务自己 new 了一个趋势写入器'
    )
  })
})
