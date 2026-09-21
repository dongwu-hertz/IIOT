/**
 * 纯推送第三方设备（`pushDevice`，业主 20260921 第 12 条）—— DeviceService 层的行为。
 *
 * WHY THIS FILE EXISTS
 * 这一条给"添加设备"加了第三条路：接入方式选 HTTP/MQTT 时**跳过 IP 探测**、不存凭据、
 * `ip_address` 落 NULL、按用户给的名称登记为第四种机型。另外两件配套行为也在这里钉住：
 *
 *   1. **收到遥测即上线**：接入服务收到合法遥测 → `markOnlineFromTelemetry()` 复用
 *      `markOnline()` 的完整机制（状态翻转 + lastSeen + 事件）；
 *   2. **无遥测超时判离线**：健康检查对推送设备不做 HTTP 轮询（连一次请求都不许发），
 *      只按 `last_seen` 距今是否超过 `offlineFailureThreshold × healthCheckIntervalMs` 判离线。
 *
 * 与 `tests/e2-device.test.ts` 同一套做法：真的 `DeviceService` + 真的 SQLite（临时文件），
 * 设备那一侧不存在 —— 于是一个"只要被调用就炸"的传输层替身正好充当"绝不允许探测"的断言。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { DeviceService } from '../src/main/services/device/device-service'
import { MemoryCredentialStore } from '../src/main/services/device/credential-store'
import type { HttpTransport, HttpRequestOptions, HttpResponse, StreamSignature } from '../src/main/services/device/http-transport'
import { ChannelRepository, DeviceRepository } from '../src/main/services/database/device-repository'
import { openDatabase } from '../src/main/services/database/schema'
import { TelemetryIntake } from '../src/main/services/ingest/telemetry-intake'
import type { DeviceStatusEvent } from '../src/shared/domain/models'
import { defaultIngestMetricKeys, normaliseDeviceIngestPlan } from '../src/shared/domain/iot-ingest'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'push-device-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

/**
 * 绝不允许被调用的传输层替身：推送设备的添加与"健康检查"都不许发任何 HTTP 请求，
 * 谁发了谁就是回退了"跳过探测 / 跳过轮询"这两条要求。
 */
function noRequestTransport(calls: string[]): HttpTransport {
  const fail = (): never => {
    throw new Error('push device flow must not perform HTTP requests')
  }
  return {
    request: (options: HttpRequestOptions & { binary?: boolean }): Promise<HttpResponse> => {
      calls.push(String(options.url))
      return fail()
    },
    captureStream: (options: HttpRequestOptions & { maxBytes: number }): Promise<StreamSignature> => {
      calls.push(String(options.url))
      return fail()
    }
  }
}

interface Harness {
  service: DeviceService
  devices: DeviceRepository
  channels: ChannelRepository
  credentials: MemoryCredentialStore
  db: ReturnType<typeof openDatabase>
  httpCalls: string[]
  ingestNeed: Array<{ http: boolean; mqtt: boolean }>
  statusEvents: DeviceStatusEvent[]
}

let counter = 0

function harness(): Harness {
  counter += 1
  const db = openDatabase({ file: path.join(tempRoot, `db-${counter}.db`) })
  const devices = new DeviceRepository(db)
  const channels = new ChannelRepository(db)
  const credentials = new MemoryCredentialStore()
  const httpCalls: string[] = []
  const ingestNeed: Array<{ http: boolean; mqtt: boolean }> = []
  const statusEvents: DeviceStatusEvent[] = []
  const service = new DeviceService({
    devices,
    channels,
    credentials,
    transport: noRequestTransport(httpCalls),
    settings: () => ({
      requestTimeoutMs: 3_000,
      healthCheckIntervalMs: 1_000,
      offlineFailureThreshold: 3,
      ringBufferSeconds: 10,
      preAlarmSeconds: 5,
      postAlarmSeconds: 5
    }),
    syncIngest: (need) => ingestNeed.push(need)
  })
  service.on('status', (event) => statusEvents.push(event))
  return { service, devices, channels, credentials, db, httpCalls, ingestNeed, statusEvents }
}

/** 添加一台 HTTP 推送设备的最小输入（IP/凭据栏按界面的做法留空串）。 */
const PUSH_HTTP_INPUT = {
  ip: '',
  httpPort: 80,
  username: '',
  password: '',
  name: '第三方温度仪 1',
  ingest: { protocol: 'http' as const, metricKeys: defaultIngestMetricKeys(), videoKey: 'video_url' }
}

describe('添加推送设备：跳过探测、免地址、免凭据', () => {
  it('HTTP 接入：一次请求都不发，登记为 pushDevice（NULL IP、给定名称、方案入库）', async () => {
    const env = harness()
    try {
      const device = await env.service.add(PUSH_HTTP_INPUT)

      assert.equal(env.httpCalls.length, 0, '添加推送设备居然发了 HTTP 请求（探测没有跳过）')
      assert.equal(device.kind, 'pushDevice')
      assert.equal(device.name, '第三方温度仪 1')
      assert.equal(device.ip, undefined, '推送设备的 ip 必须是 NULL（undefined）')
      assert.equal(device.httpPort, undefined)
      assert.equal(device.status, 'UNKNOWN', '刚添加还没有"它活着"的证据，不许直接写 ONLINE')
      assert.equal(device.lastSeen, undefined)
      // uid 是 mint 的，带 push: 前缀（写明这条身份是我们编的）。
      assert.match(device.deviceUid, /^push:/)
      // 接入方案原样入库（规范化后）：协议 + 四个规范键 + video_url。
      assert.equal(device.ingest?.protocol, 'http')
      assert.deepEqual(device.ingest, normaliseDeviceIngestPlan(PUSH_HTTP_INPUT.ingest))
      // 凭据不存：推送设备没有"设备登录凭据"这个概念。
      assert.equal(env.credentials.get(device.id), undefined, '推送设备不该存设备凭据')
      assert.equal(env.credentials.keys().length, 0)
      // 设备声明驱动本机监听：http ⇒ { http: true, mqtt: false }。
      assert.deepEqual(env.ingestNeed[env.ingestNeed.length - 1], { http: true, mqtt: false })
      // 不种子任何通道行（推哪些通道由遥测里的 channel_id 决定）。
      assert.equal(env.channels.listByDevice(device.id).length, 0)
      // 读回来再核一遍（业主的硬规矩：写后读回）。
      const readBack = env.devices.findById(device.id)
      assert.equal(readBack?.kind, 'pushDevice')
      assert.equal(readBack?.ip, undefined)
    } finally {
      env.db.close()
    }
  })

  it('MQTT 接入：监听需求是 { http: false, mqtt: true }，方案协议 mqtt', async () => {
    const env = harness()
    try {
      const device = await env.service.add({
        ...PUSH_HTTP_INPUT,
        name: 'MQTT 盒子',
        ingest: { protocol: 'mqtt', metricKeys: defaultIngestMetricKeys(), videoKey: '' }
      })
      assert.equal(env.httpCalls.length, 0)
      assert.equal(device.kind, 'pushDevice')
      assert.equal(device.ingest?.protocol, 'mqtt')
      assert.equal(device.ingest?.videoKey, '', '空 videoKey（不推视频）原样保留')
      assert.deepEqual(env.ingestNeed[env.ingestNeed.length - 1], { http: false, mqtt: true })
    } finally {
      env.db.close()
    }
  })

  it('名称必填：空名称（含纯空白）被拒，而且不写库', async () => {
    const env = harness()
    try {
      await assert.rejects(
        () => env.service.add({ ...PUSH_HTTP_INPUT, name: '   ' }),
        /名称/
      )
      assert.equal(env.devices.list().length, 0, '被拒绝的添加不该留下任何行')
      assert.equal(env.httpCalls.length, 0)
    } finally {
      env.db.close()
    }
  })

  it('接入方案写库前过共享层判据：乱方案被**规范化**（同一指标后写的赢，库里只存一种写法）', async () => {
    const env = harness()
    try {
      const device = await env.service.add({
        ...PUSH_HTTP_INPUT,
        ingest: {
          protocol: 'http',
          // 同一个指标两行：规范化只留后一条（界面上的即时校验负责"说不对"，
          // 主进程这一层负责"写进去的一定合法"）。
          metricKeys: [
            { metric: 'spl', key: 'a' },
            { metric: 'spl', key: 'b' },
            { metric: 'mainFrequency', key: 'f0' }
          ],
          videoKey: 'not a valid key!!'
        }
      })
      assert.equal(env.httpCalls.length, 0)
      const spl = device.ingest?.metricKeys.find((row) => row.metric === 'spl')
      assert.equal(spl?.key, 'b', '同一指标没有"后写的赢"')
      // 非法 videoKey 回落出厂值（不是原样进库）。
      assert.equal(device.ingest?.videoKey, 'video_url')
      // 读回来仍是这一份（写后读回）。
      assert.deepEqual(env.devices.getIngestPlan(device.id), device.ingest)
    } finally {
      env.db.close()
    }
  })

  it('IP 地址模式（不给方案）照旧走探测 —— 探测失败照报错，不会变成推送设备', async () => {
    const env = harness()
    try {
      await assert.rejects(() =>
        env.service.add({ ip: '127.0.0.1', httpPort: 1, username: 'admin', password: 'x' })
      )
      assert.equal(env.devices.list().length, 0)
      // 探测确实发生了（打到了占位端口）——证明 IP 模式没有被推送分支吞掉。
      assert.ok(env.httpCalls.length > 0, 'IP 模式的探测请求没有发出去')
    } finally {
      env.db.close()
    }
  })
})

describe('收到遥测即上线（markOnlineFromTelemetry）', () => {
  it('第一次遥测把 UNKNOWN 翻成 ONLINE 并发事件；重复遥测静默刷新 lastSeen', async () => {
    const env = harness()
    try {
      const device = await env.service.add(PUSH_HTTP_INPUT)
      assert.equal(device.status, 'UNKNOWN')

      env.service.markOnlineFromTelemetry(device.id)
      const online = env.devices.findById(device.id)
      assert.equal(online?.status, 'ONLINE')
      assert.ok(online?.lastSeen !== undefined && online.lastSeen > 0, 'lastSeen 没有刷新')
      assert.deepEqual(
        env.statusEvents.map((event) => [event.deviceId, event.status]),
        [[device.id, 'ONLINE']]
      )

      // 再来一批遥测：仍是 ONLINE，只刷新 lastSeen，不再发事件（没有翻转）。
      env.service.markOnlineFromTelemetry(device.id)
      assert.equal(env.devices.findById(device.id)?.status, 'ONLINE')
      assert.equal(env.statusEvents.length, 1, '没翻转不该重复发事件')

      // 设备已被删：无事发生、不炸。
      env.service.markOnlineFromTelemetry('no-such-device')
    } finally {
      env.db.close()
    }
  })

  it('TelemetryIntake 每批合法遥测只报一次 onTelemetry（哪怕键全不认识）', () => {
    const reported: string[] = []
    const intake = new TelemetryIntake({
      appendFeature: () => {},
      insertAlarm: () => ({ id: 'a', created: true }),
      onTelemetry: (deviceId) => reported.push(deviceId)
    })
    intake.ingest(
      { id: 'dev-1', deviceUid: 'uid-1', name: 'x' },
      [
        { ts: 1, values: { sound_pressure_level: 61 } },
        { ts: 2, values: { totally_unknown: 1 } }
      ]
    )
    assert.deepEqual(reported, ['dev-1'], '一批遥测该只触发一次"收到遥测"')
    // 空批不报。
    intake.ingest({ id: 'dev-1', deviceUid: 'uid-1', name: 'x' }, [])
    assert.deepEqual(reported, ['dev-1'])
  })
})

describe('无遥测超时判离线（健康检查跳过 HTTP 轮询）', () => {
  it('刚添加（从未推过）→ 一次健康检查即离线；推过且在时限内 → 保持在线', async () => {
    const env = harness()
    try {
      const device = await env.service.add(PUSH_HTTP_INPUT)

      // last_seen 为空 = 从未推过：按"离线的设备直接显示离线"口径，第一次检查就判离线。
      await env.service.runHealthCheck()
      assert.equal(env.devices.findById(device.id)?.status, 'OFFLINE')
      assert.deepEqual(env.statusEvents.map((event) => event.status), ['OFFLINE'])
      assert.equal(env.httpCalls.length, 0, '判离线的过程中不该发任何 HTTP 请求')

      // 遥测来了 → 翻回在线。
      env.service.markOnlineFromTelemetry(device.id)
      assert.equal(env.devices.findById(device.id)?.status, 'ONLINE')

      // 时限 = offlineFailureThreshold(3) × healthCheckIntervalMs(1000) = 3000ms；
      // last_seen 是"刚才" → 仍在时限内，健康检查不动它。
      await env.service.runHealthCheck()
      assert.equal(env.devices.findById(device.id)?.status, 'ONLINE')
      assert.equal(env.httpCalls.length, 0)
    } finally {
      env.db.close()
    }
  })

  it('last_seen 超过 阈值×间隔 无遥测 → 判离线（边界取到）', async () => {
    const env = harness()
    try {
      const device = await env.service.add(PUSH_HTTP_INPUT)
      env.service.markOnlineFromTelemetry(device.id)

      // 把 last_seen 拨回 4 秒前（时限 3000ms）：超时 → 离线。
      const stale = Date.now() - 4_000
      env.devices.setStatus(device.id, 'ONLINE', stale)
      await env.service.runHealthCheck()
      const after = env.devices.findById(device.id)
      assert.equal(after?.status, 'OFFLINE')
      // 判离线不把 last_seen 抹掉（COALESCE 保留旧值，恢复时才是新的证据）。
      assert.equal(after?.lastSeen, stale)
      assert.equal(env.httpCalls.length, 0)
    } finally {
      env.db.close()
    }
  })
})
