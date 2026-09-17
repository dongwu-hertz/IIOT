/**
 * SN-16 空气声呐的**球机联动（PTZ）**与**告警抓图**（业主 2026-09-17 第 8 批）。
 *
 * WHY THIS FILE EXISTS
 * 这一批的两件事各自都有一个"错了也不报错"的失效方式：
 *
 *   - **PTZ 写设备**：`PUT /system` 是**整份参数回写**。少写一个键 = 把设备上那一项清掉
 *     （球机口令被清成空、`db_limit` 被抹掉），而设备通常照收不误。所以这里的断言重点不是
 *     "保存成功了"，而是**没动的那几项还在**，以及**读回来的值就是设备现在的值**。
 *   - **抓图**：`alarms.snapshot_dir` 是这一批新增的列，而"有图 / 设备上本来就没有 /
 *     记了目录但文件已经不在"是**三件不同的事**，合成一句"没有图"会让操作员以为同步坏了。
 *
 * 纯函数（归一化、合并、读回比对、范围校验）与 HTTP 那一层分开测：前者是判据，
 * 后者是"真的发了什么"。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import {
  applyPtzPatch,
  buildPtzConfig,
  comparePtzPatch,
  normaliseNumber,
  normaliseSwitch,
  normaliseText,
  validatePtzPatch
} from '../src/shared/domain/e2-ptz'
import { MIGRATIONS, SCHEMA_VERSION, openDatabase, runMigrations } from '../src/main/services/database/schema'
import {
  AlarmRepository,
  RecordingRepository
} from '../src/main/services/database/alarm-repository'
import { DeviceRepository, ChannelRepository } from '../src/main/services/database/device-repository'
import { DeviceService } from '../src/main/services/device/device-service'
import { E2DeviceService } from '../src/main/services/device/e2/e2-device-service'
import type { ImageSetServer } from '../src/main/services/device/e2/e2-device-service'
import { MemoryCredentialStore } from '../src/main/services/device/credential-store'
import { FetchHttpTransport } from '../src/main/services/device/http-transport'
import { StorageService } from '../src/main/services/storage/storage-service'

import Database from 'better-sqlite3'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e2-ptz-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

let counter = 0

// ---------------------------------------------------------------------------
// 1. 纯函数：归一化 / 读 / 合并 / 读回比对 / 范围
// ---------------------------------------------------------------------------

describe('PTZ：取值归一化（设备的回话不总是我们发过去的形状）', () => {
  it('开关认 true/1/\'1\'/\'true\'，认不出来返回 undefined（不猜）', () => {
    for (const value of [true, 1, '1', 'true', 'TRUE', 'on']) {
      assert.equal(normaliseSwitch(value), true, String(value))
    }
    for (const value of [false, 0, '0', 'false', 'off']) {
      assert.equal(normaliseSwitch(value), false, String(value))
    }
    assert.equal(normaliseSwitch('yes'), undefined)
    assert.equal(normaliseSwitch(2), undefined)
    assert.equal(normaliseSwitch(undefined), undefined)
  })

  it('数字认有限数（含数字字符串），别的一律 undefined', () => {
    assert.equal(normaliseNumber(80), 80)
    assert.equal(normaliseNumber('80'), 80)
    assert.equal(normaliseNumber(' 80 '), 80)
    assert.equal(normaliseNumber('80x'), undefined)
    assert.equal(normaliseNumber(''), undefined)
    assert.equal(normaliseNumber(Number.NaN), undefined)
    assert.equal(normaliseNumber(Infinity), undefined)
  })

  it('文本去空白；空串算没填', () => {
    assert.equal(normaliseText(' 192.168.2.64 '), '192.168.2.64')
    assert.equal(normaliseText('   '), undefined)
    assert.equal(normaliseText(64), undefined)
  })
})

describe('PTZ：读设备回话', () => {
  /** 这台设备的 `/system`（真机实测过的那一台的形状）。 */
  const device = {
    cam_enable: false,
    cam_ip: '192.168.2.64',
    cam_port: 80,
    cam_user: 'admin',
    cam_pass: 'AP1_lfxs_2025',
    cur_realtime_channel: 1,
    db_limit: 60,
    is_cam_init: false,
    is_ptz_direction_same_with_sonar: false,
    is_save_snapshot: false,
    notify_url: 'http://192.168.110.91:8080/api/v1/x/telemetry',
    samplerate: 20000
  }

  it('按手册键名映射，其余键列进 otherKeys（写回时要原样带着走）', () => {
    const config = buildPtzConfig(device, 16)
    assert.equal(config.enabled, false)
    assert.equal(config.cameraIp, '192.168.2.64')
    assert.equal(config.cameraPort, 80)
    assert.equal(config.cameraUser, 'admin')
    assert.equal(config.directionSameAsSonar, false)
    assert.equal(config.saveSnapshot, false)
    assert.equal(config.realtimeChannel, 1)
    assert.equal(config.cameraInitialised, false)
    assert.equal(config.channelCount, 16)
    assert.deepEqual(config.otherKeys.sort(), ['db_limit', 'notify_url', 'samplerate'].sort())
  })

  it('**口令只回"设没设"**：内容不进这个结构（与设备口令同一条纪律）', () => {
    const config = buildPtzConfig(device)
    assert.equal(config.cameraPasswordSet, true)
    assert.equal(JSON.stringify(config).includes('AP1_lfxs_2025'), false, '口令内容漏进了视图')
    assert.equal(buildPtzConfig({ ...device, cam_pass: '' }).cameraPasswordSet, false)
    assert.equal(buildPtzConfig({ ...device, cam_pass: undefined }).cameraPasswordSet, false)
  })

  it('设备没回的键在视图里**缺席**（不填 0/false）', () => {
    const config = buildPtzConfig({ cam_ip: '10.0.0.5' })
    assert.equal(config.cameraIp, '10.0.0.5')
    assert.equal(config.enabled, undefined)
    assert.equal(config.saveSnapshot, undefined)
    assert.equal(config.realtimeChannel, undefined)
    assert.equal(config.cameraInitialised, undefined)
    // 通道数读不出来就缺席：界面那时不做上限判断，而不是拿 16 当默认值。
    assert.equal(config.channelCount, undefined)
  })
})

describe('PTZ：整份回写（没动的那几项必须一个不少）', () => {
  const before = {
    cam_enable: false,
    cam_ip: '192.168.2.64',
    cam_port: 80,
    cam_pass: 'AP1_lfxs_2025',
    db_limit: 60,
    notify_url: 'http://x/telemetry',
    samplerate: 20000
  }

  it('只改要给的那几项，其余键原样保留', () => {
    const merged = applyPtzPatch(before, { enabled: true, cameraPort: 8080 })
    assert.equal(merged.cam_enable, true)
    assert.equal(merged.cam_port, 8080)
    assert.equal(merged.db_limit, 60)
    assert.equal(merged.notify_url, 'http://x/telemetry')
    assert.equal(merged.samplerate, 20000)
    assert.equal(merged.cam_ip, '192.168.2.64')
  })

  it('**没改口令就把设备刚给的原值写回去**（写空会把球机口令清掉）', () => {
    const merged = applyPtzPatch(before, { cameraIp: '10.0.0.9' })
    assert.equal(merged.cam_pass, 'AP1_lfxs_2025')
    // 明确给了新口令才覆盖。
    assert.equal(applyPtzPatch(before, { cameraPassword: 'new-pass' }).cam_pass, 'new-pass')
    // 空串不算"改口令"：保持原值，而不是写一个空口令。
    assert.equal(applyPtzPatch(before, { cameraPassword: '' }).cam_pass, 'AP1_lfxs_2025')
  })

  it('底稿对象不被就地修改（调用方可能还要用它做比较）', () => {
    const snapshot = JSON.stringify(before)
    applyPtzPatch(before, { enabled: true })
    assert.equal(JSON.stringify(before), snapshot)
  })
})

describe('PTZ：写完之后读回来逐项核对', () => {
  it('设备把 true 回成 1、把端口回成字符串，都算一致', () => {
    const checks = comparePtzPatch(
      { cam_enable: 1, cam_port: '8080', cam_ip: '10.0.0.9' },
      { enabled: true, cameraPort: 8080, cameraIp: '10.0.0.9' }
    )
    assert.deepEqual(checks.map((check) => check.ok), [true, true, true])
  })

  it('没生效的项如实报出来（带"我要的值"与"读回来的值"）', () => {
    const checks = comparePtzPatch(
      { cam_enable: false, cam_port: 80 },
      { enabled: true, cameraPort: 8080 }
    )
    assert.equal(checks.length, 2)
    assert.equal(checks[0]?.field, 'enabled')
    assert.equal(checks[0]?.ok, false)
    assert.equal(checks[0]?.expected, 'true')
    assert.equal(checks[0]?.actual, 'false')
    assert.equal(checks[1]?.ok, false)
    assert.equal(checks[1]?.actual, '80')
  })

  it('设备没回这个键（undefined）算不一致，而不是"大概没变"', () => {
    const checks = comparePtzPatch({}, { realtimeChannel: 3 })
    assert.equal(checks[0]?.ok, false)
    assert.equal(checks[0]?.actual, '')
  })

  it('口令只核对"现在是已设置"（内容根本不出主进程）', () => {
    const checks = comparePtzPatch(
      { cam_pass: 'whatever-the-device-keeps' },
      { cameraPassword: 'the-new-one' }
    )
    assert.equal(checks[0]?.field, 'cameraPassword')
    assert.equal(checks[0]?.ok, true)
    assert.equal(checks[0]?.actual, '已设置')
    assert.equal(JSON.stringify(checks).includes('whatever'), false, '口令内容出现在核对结果里')
    // 设备回空口令 = 没设上。
    assert.equal(comparePtzPatch({ cam_pass: '' }, { cameraPassword: 'x' })[0]?.ok, false)
  })
})

describe('PTZ：范围校验（界面与主进程共用）', () => {
  it('端口 1..65535', () => {
    assert.equal(validatePtzPatch({ cameraPort: 1 }).ok, true)
    assert.equal(validatePtzPatch({ cameraPort: 65535 }).ok, true)
    assert.equal(validatePtzPatch({ cameraPort: 0 }).ok, false)
    assert.equal(validatePtzPatch({ cameraPort: 65536 }).ok, false)
    assert.equal(validatePtzPatch({ cameraPort: 80.5 }).ok, false)
  })

  it('通道 1..设备说的通道数；读不出通道数时只要求正整数', () => {
    assert.equal(validatePtzPatch({ realtimeChannel: 16 }, 16).ok, true)
    assert.equal(validatePtzPatch({ realtimeChannel: 17 }, 16).ok, false)
    assert.equal(validatePtzPatch({ realtimeChannel: 17 }).ok, true)
    assert.equal(validatePtzPatch({ realtimeChannel: 0 }).ok, false)
  })

  it('球机地址：IPv4 或主机名；空串被拒（清空请关掉联动开关）', () => {
    assert.equal(validatePtzPatch({ cameraIp: '192.168.2.64' }).ok, true)
    assert.equal(validatePtzPatch({ cameraIp: 'nvr-1.local' }).ok, true)
    assert.equal(validatePtzPatch({ cameraIp: '192.168.2.999' }).ok, false)
    assert.equal(validatePtzPatch({ cameraIp: '' }).ok, false)
    assert.equal(validatePtzPatch({ cameraIp: 'http://192.168.2.64' }).ok, false)
  })

  it('账号不许是空白（写一个空账号等于把球机登录搞坏）', () => {
    assert.equal(validatePtzPatch({ cameraUser: 'admin' }).ok, true)
    assert.equal(validatePtzPatch({ cameraUser: '   ' }).ok, false)
  })
})

// ---------------------------------------------------------------------------
// 2. 假设备（`/system` 支持 PUT，真的会改）
// ---------------------------------------------------------------------------

interface FakeDevice {
  baseUrl: string
  requests: Array<{ method: string; path: string; body: unknown }>
  /** 设备当前的 `/system`（PUT 会就地改它）。 */
  params: Record<string, unknown>
  /** 让 PUT 之后**什么都不改**，用来验"读回不一致要如实报出来"。 */
  ignoreWrites: boolean
  close(): Promise<void>
}

/** 一台 SN-16：`/system` 给 PTZ 那一组，`/basic` 说 `AS16`。 */
async function startAirSonar(options: { ignoreWrites?: boolean } = {}): Promise<FakeDevice> {
  const requests: Array<{ method: string; path: string; body: unknown }> = []
  const params: Record<string, unknown> = {
    cam_enable: false,
    cam_ip: '192.168.2.64',
    cam_pass: 'AP1_lfxs_2025',
    cam_port: 80,
    cam_user: 'admin',
    cur_realtime_channel: 1,
    db_limit: 60,
    is_cam_init: false,
    is_ptz_direction_same_with_sonar: false,
    is_save_snapshot: false,
    notify_url: 'http://192.168.110.91:8080/api/v1/x/telemetry',
    samplerate: 20000
  }
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = undefined
      try {
        body = raw === '' ? undefined : JSON.parse(raw)
      } catch {
        body = raw
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      requests.push({ method: request.method ?? '', path: url.pathname, body })
      const json = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
      if (url.pathname === '/login') return json(200, { token: 'ptz-token' })
      if (url.pathname === '/basic') {
        return json(200, {
          dev_name: 'SN-16',
          dev_type: 'AS16',
          dev_version: 'V3.4.0',
          equip_number: 'PTZ-0001'
        })
      }
      if (url.pathname === '/system') {
        if (request.method === 'PUT') {
          if (!options.ignoreWrites && body !== null && typeof body === 'object') {
            Object.assign(params, body as Record<string, unknown>)
          }
          return json(200, { ret: 0 })
        }
        return json(200, params)
      }
      if (url.pathname === '/time_sync_with_nvt') {
        // 手册没写这个端点回什么；这里就回一个空对象（最保守的形状）。
        return json(200, {})
      }
      return json(404, { ret: -1 })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    params,
    ignoreWrites: options.ignoreWrites === true,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

interface Harness {
  service: E2DeviceService
  /** 设备门面（添加设备、读设备行走它）。 */
  devices: DeviceService
  repository: DeviceRepository
  alarms: AlarmRepository
  storageRoot: string
  db: ReturnType<typeof openDatabase>
  addInput: { ip: string; httpPort: number; username: string; password: string; kind: 'auscultationBox' }
}

const cleanup: Array<() => Promise<void>> = []
after(async () => {
  for (const close of cleanup) await close()
})

function harness(port: number): Harness {
  counter += 1
  const storageRoot = path.join(tempRoot, `storage-${counter}`)
  fs.mkdirSync(storageRoot, { recursive: true })
  const db = openDatabase({ file: path.join(tempRoot, `db-${counter}.db`) })
  const repository = new DeviceRepository(db)
  const alarms = new AlarmRepository(db)
  const devices = new DeviceService({
    devices: repository,
    channels: new ChannelRepository(db),
    credentials: new MemoryCredentialStore(),
    transport: new FetchHttpTransport(3_000),
    settings: () => ({
      requestTimeoutMs: 3_000,
      healthCheckIntervalMs: 60_000,
      offlineFailureThreshold: 3,
      ringBufferSeconds: 10,
      preAlarmSeconds: 5,
      postAlarmSeconds: 5
    })
  })
  const files: ImageSetServer = {
    async serveImages(_directory, names) {
      return {
        files: names.map((name) => ({ name, url: `http://127.0.0.1:1/${name}` })),
        close: () => {}
      }
    }
  }
  const service = new E2DeviceService({
    devices,
    alarms,
    recordings: new RecordingRepository(db),
    storage: new StorageService({
      db,
      getStorageRoot: () => storageRoot,
      getMinFreeBytes: () => 0
    }),
    files
  })
  return {
    service,
    devices,
    repository,
    alarms,
    storageRoot,
    db,
    addInput: { ip: '127.0.0.1', httpPort: port, username: 'admin', password: 'x', kind: 'auscultationBox' }
  }
}

async function setup(options: { ignoreWrites?: boolean } = {}): Promise<{
  fake: FakeDevice
  env: Harness
  deviceId: string
}> {
  const fake = await startAirSonar(options)
  cleanup.push(fake.close)
  const port = Number(new URL(fake.baseUrl).port)
  const env = harness(port)
  const device = await env.devices.add(env.addInput)
  return { fake, env, deviceId: device.id }
}

// ---------------------------------------------------------------------------
// 3. 服务层：读 / 写回并读回 / 对时 / 代次落库
// ---------------------------------------------------------------------------

describe('SN-16 PTZ：读设备参数', () => {
  it('健康检查**不问 `/workmode`**（那一代没有这个端点，404 会把健康设备记成失败）', async () => {
    const { fake, env, deviceId } = await setup()
    try {
      const before = fake.requests.length
      await env.devices.runHealthCheck()
      const asked = fake.requests.slice(before).map((request) => request.path)
      /*
       * 探测到这条缺陷的是 GUI 探针：假空气声呐收到了 `/workmode`（它照实回 404）。
       * 成因是健康检查直接用 `getWorkMode()`，而"这一族是不是空气声呐"只有读过 `/system`
       * 才知道 —— 新客户端（进程刚起 / 地址刚改）的 `variant` 还是 undefined，
       * 于是对一台 SN-16 发一个必然 404 的请求，三轮之后**健康的设备显示离线**。
       * 修法是先 `ensureVariant()`（它读的是两代都有的 `/system`）。
       */
      assert.equal(asked.includes('/workmode'), false, '健康检查问了 /workmode：' + asked.join(','))
      assert.ok(asked.includes('/system'), '健康检查连代次都没判：' + asked.join(','))
      assert.equal(env.repository.findById(deviceId)?.status, 'ONLINE')
    } finally {
      env.db.close()
    }
  })

  it('读回来的是设备当前的值（含"球机是否已初始化"这个只读状态）', async () => {
    const { env, deviceId } = await setup()
    try {
      const config = await env.service.ptzConfig(deviceId)
      assert.equal(config.enabled, false)
      assert.equal(config.cameraIp, '192.168.2.64')
      assert.equal(config.cameraPort, 80)
      assert.equal(config.cameraUser, 'admin')
      assert.equal(config.cameraPasswordSet, true)
      assert.equal(config.directionSameAsSonar, false)
      assert.equal(config.saveSnapshot, false)
      assert.equal(config.realtimeChannel, 1)
      assert.equal(config.cameraInitialised, false)
      // 通道数来自 `dev_type`（`AS16` ⇒ 16），用来给"实时通道"定上限。
      assert.equal(config.channelCount, 16)
    } finally {
      env.db.close()
    }
  })

  it('读状态会把代次记进设备行（界面刷新/重启之后仍然知道该给哪一组页签）', async () => {
    const { env, deviceId } = await setup()
    try {
      /*
       * **添加设备时就已经记下了**（探活本来就要读一次 `/system` 判代次，顺手落库 v12）——
       * 不这样的话，一台刚加进来的 SN-16 要等第一次读状态，界面才知道该给它 PTZ 页签。
       */
      assert.equal(env.repository.findById(deviceId)?.e2Variant, 'airSonar')
      await env.service.status(deviceId)
      assert.equal(env.repository.findById(deviceId)?.e2Variant, 'airSonar')
      // 值没变就不写：库里那一行的 `updated_at` 不该因为读一次状态而变。
      const updatedAt = env.repository.findById(deviceId)?.updatedAt
      await env.service.status(deviceId)
      assert.equal(env.repository.findById(deviceId)?.updatedAt, updatedAt)
    } finally {
      env.db.close()
    }
  })
})

describe('SN-16 PTZ：写回并读回核对', () => {
  it('改动的项真的写进了设备，读回逐项 ok', async () => {
    const { fake, env, deviceId } = await setup()
    try {
      const outcome = await env.service.updatePtzConfig(deviceId, {
        enabled: true,
        cameraIp: '192.168.2.99',
        cameraPort: 8080,
        saveSnapshot: true,
        realtimeChannel: 3
      })
      assert.equal(outcome.allApplied, true, JSON.stringify(outcome.fields))
      assert.equal(outcome.readBack.enabled, true)
      assert.equal(outcome.readBack.cameraIp, '192.168.2.99')
      assert.equal(outcome.readBack.cameraPort, 8080)
      assert.equal(outcome.readBack.saveSnapshot, true)
      assert.equal(outcome.readBack.realtimeChannel, 3)
      // 设备那一侧真的变了（不是我们只在界面里改了）。
      assert.equal(fake.params.cam_enable, true)
      assert.equal(fake.params.cam_ip, '192.168.2.99')
    } finally {
      env.db.close()
    }
  })

  it('**整份回写**：不在补丁里的参数一个都没被动过（含球机口令）', async () => {
    const { fake, env, deviceId } = await setup()
    try {
      await env.service.updatePtzConfig(deviceId, { cameraPort: 8081 })
      assert.equal(fake.params.db_limit, 60)
      assert.equal(fake.params.notify_url, 'http://192.168.110.91:8080/api/v1/x/telemetry')
      assert.equal(fake.params.samplerate, 20000)
      assert.equal(fake.params.cam_pass, 'AP1_lfxs_2025', '球机口令被写没了')
      assert.equal(fake.params.cam_user, 'admin')
      // 发出去的 PUT 体里也带着这些键（设备拿到的是整份）。
      const put = fake.requests.filter((request) => request.method === 'PUT')
      assert.equal(put.length, 1)
      const body = put[0]?.body as Record<string, unknown>
      assert.equal(body.cam_pass, 'AP1_lfxs_2025')
      assert.equal(body.db_limit, 60)
      assert.equal(body.samplerate, 20000)
      assert.equal(body.cam_port, 8081)
    } finally {
      env.db.close()
    }
  })

  it('设备不认这次写入 ⇒ 读回如实报"没生效"，而不是报成功', async () => {
    const { env, deviceId } = await setup({ ignoreWrites: true })
    try {
      const outcome = await env.service.updatePtzConfig(deviceId, { enabled: true })
      assert.equal(outcome.allApplied, false)
      assert.equal(outcome.fields.length, 1)
      assert.equal(outcome.fields[0]?.field, 'enabled')
      assert.equal(outcome.fields[0]?.ok, false)
      assert.equal(outcome.fields[0]?.expected, 'true')
      assert.equal(outcome.fields[0]?.actual, 'false')
      // 界面拿 readBack 刷新：它必须是**设备现在的值**（false），不是我们请求的 true。
      assert.equal(outcome.readBack.enabled, false)
    } finally {
      env.db.close()
    }
  })

  it('越界的补丁在**写设备之前**就被拒（不会把坏值发出去）', async () => {
    const { fake, env, deviceId } = await setup()
    try {
      await assert.rejects(() => env.service.updatePtzConfig(deviceId, { cameraPort: 70000 }), /ptzUi/)
      await assert.rejects(
        () => env.service.updatePtzConfig(deviceId, { realtimeChannel: 17 }),
        /ptzUi/
      )
      assert.equal(
        fake.requests.some((request) => request.method === 'PUT'),
        false,
        '越界的补丁仍然发了 PUT'
      )
    } finally {
      env.db.close()
    }
  })

  it('与球机对时：发的是 `PUT /time_sync_with_nvt`，结果照实回（手册未说明请求体）', async () => {
    const { fake, env, deviceId } = await setup()
    try {
      const outcome = await env.service.syncTimeWithNvt(deviceId)
      assert.equal(outcome.accepted, true)
      const call = fake.requests.find((request) => request.path === '/time_sync_with_nvt')
      assert.ok(call, '没有向 /time_sync_with_nvt 发请求：' + JSON.stringify(fake.requests.map((r) => r.path)))
      assert.equal(call?.method, 'PUT')
      // 手册没写请求体，所以我们发的是一个空对象 —— 这件事写在结论里，不假装知道它做了什么。
      assert.deepEqual(call?.body, {})
    } finally {
      env.db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. 抓图：三种状态必须分得开
// ---------------------------------------------------------------------------

describe('告警抓图：有图 / 设备上本来没有 / 文件已不在', () => {
  it('库里没有目录 ⇒ `not-captured`（设备事实：本来就没有图）', async () => {
    const { env, deviceId } = await setup()
    try {
      const alarm = env.alarms.insert({
        deviceId,
        channelId: 0,
        timestamp: 1_700_000_000_000,
        alarmMask: 0,
        source: 'e2',
        severity: 'unknown'
      })
      const view = await env.service.alarmSnapshots(deviceId, alarm.id)
      assert.equal(view.state, 'not-captured')
      assert.deepEqual(view.files, [])
      assert.equal(view.relativeDir, undefined)
    } finally {
      env.db.close()
    }
  })

  it('目录记着但文件不在了 ⇒ `files-gone`（本机事实）', async () => {
    const { env, deviceId } = await setup()
    try {
      const alarm = env.alarms.insert({
        deviceId,
        channelId: 0,
        timestamp: 1_700_000_000_001,
        alarmMask: 0,
        source: 'e2',
        severity: 'unknown'
      })
      const readBack = env.alarms.setSnapshotDir(alarm.id, 'audio/x/2026/09/17/CH01/alarm/1_stft')
      assert.equal(readBack, 'audio/x/2026/09/17/CH01/alarm/1_stft')
      const view = await env.service.alarmSnapshots(deviceId, alarm.id)
      assert.equal(view.state, 'files-gone')
      assert.equal(view.relativeDir, 'audio/x/2026/09/17/CH01/alarm/1_stft')
    } finally {
      env.db.close()
    }
  })

  it('磁盘上有图 ⇒ `ok`，按名字排序，且**只列设备命名的那些图**', async () => {
    const { env, deviceId } = await setup()
    try {
      const alarm = env.alarms.insert({
        deviceId,
        channelId: 0,
        timestamp: 1_700_000_000_002,
        alarmMask: 0,
        source: 'e2',
        severity: 'unknown'
      })
      const relativeDir = 'audio/e2_X/2026/09/17/CH01/alarm/2026-09-17_10-20-30-000_stft'
      const absoluteDir = path.join(env.storageRoot, ...relativeDir.split('/'))
      fs.mkdirSync(absoluteDir, { recursive: true })
      // 混进两个**不是抓图**的文件：目录里还有录音与用户丢进来的东西。
      fs.writeFileSync(path.join(absoluteDir, '1.jpg'), 'a')
      fs.writeFileSync(path.join(absoluteDir, '2.jpg'), 'b')
      fs.writeFileSync(path.join(absoluteDir, '3.jpg'), 'c')
      fs.writeFileSync(path.join(absoluteDir, 'notes.txt'), 'x')
      fs.writeFileSync(path.join(absoluteDir, 'alarm.wav'), 'RIFF')
      env.alarms.setSnapshotDir(alarm.id, relativeDir)

      const view = await env.service.alarmSnapshots(deviceId, alarm.id)
      assert.equal(view.state, 'ok')
      assert.deepEqual(view.files.map((file) => file.name), ['1.jpg', '2.jpg', '3.jpg'])
      assert.equal(view.files[0]?.url.includes('1.jpg'), true)
      assert.equal(view.relativeDir, relativeDir)
    } finally {
      env.db.close()
    }
  })

  it('别的设备的告警 id 走到这台设备上 ⇒ 明确报错（不是"没有图"）', async () => {
    const { env, deviceId } = await setup()
    try {
      const other = env.repository.upsertByIdentity(
        { ip: '10.0.0.7', httpPort: 80, username: 'admin', password: 'x' },
        { deviceUid: 'other-e2', name: '别的设备', channelCount: 1 }
      ).device
      const alarm = env.alarms.insert({
        deviceId: other.id,
        channelId: 0,
        timestamp: 1_700_000_000_003,
        alarmMask: 0,
        source: 'e2',
        severity: 'unknown'
      })
      await assert.rejects(() => env.service.alarmSnapshots(deviceId, alarm.id), /找不到这条告警/)
    } finally {
      env.db.close()
    }
  })

  it('`setSnapshotDir("")` 不清掉已有的目录（这次没下到图 ≠ 本机那张图没了）', async () => {
    const db = openDatabase({ file: path.join(tempRoot, 'snapshot-idempotent.db') })
    try {
      const alarms = new AlarmRepository(db)
      const devices = new DeviceRepository(db)
      const device = devices.upsertByIdentity(
        { ip: '10.0.0.8', httpPort: 80, username: 'admin', password: 'x' },
        { deviceUid: 'snap-e2', name: 'x', channelCount: 1 }
      ).device
      const alarm = alarms.insert({
        deviceId: device.id,
        channelId: 0,
        timestamp: 1_700_000_000_004,
        alarmMask: 0,
        source: 'e2',
        severity: 'unknown'
      })
      alarms.setSnapshotDir(alarm.id, 'audio/x/1_stft')
      assert.equal(alarms.setSnapshotDir(alarm.id, ''), 'audio/x/1_stft')
      assert.equal(alarms.findById(alarm.id)?.snapshotDir, 'audio/x/1_stft')
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. schema v12：两列迁移
// ---------------------------------------------------------------------------

describe('schema v12：设备代次 + 告警抓图目录', () => {
  it('版本常量与迁移表的最高版本一致', () => {
    const highest = Math.max(...MIGRATIONS.map((migration) => migration.version))
    assert.equal(SCHEMA_VERSION, highest)
    assert.ok(SCHEMA_VERSION >= 12)
  })

  it('从 v11 升级：两列被加上，老行是 NULL，数据一行不少', () => {
    const file = path.join(tempRoot, 'v11.db')
    const db = new Database(file)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    for (const migration of MIGRATIONS) {
      if (migration.version > 11) continue
      migration.up(db)
      db.pragma(`user_version = ${migration.version}`)
    }
    db.prepare(
      `INSERT INTO devices (id, device_uid, kind, name, ip_address, http_port, connection_type,
                            status, created_at, updated_at)
       VALUES ('dev-11', 'uid-11', 'auscultationBox', 'SN-16', '192.168.110.234', 80, 'LAN', 'ONLINE', 1, 1)`
    ).run()
    db.prepare(
      `INSERT INTO alarms (id, device_id, channel_id, alarm_type, alarm_mask, alarm_time, severity, acknowledged, created_at, source)
       VALUES ('alm-11', 'dev-11', 0, 0, 0, 1700000000000, 'unknown', 0, 1, 'e2')`
    ).run()

    runMigrations(db)

    const columns = db.prepare(`PRAGMA table_info(devices)`).all() as Array<{ name: string }>
    assert.ok(columns.some((column) => column.name === 'e2_variant'))
    const alarmColumns = db.prepare(`PRAGMA table_info(alarms)`).all() as Array<{ name: string }>
    assert.ok(alarmColumns.some((column) => column.name === 'snapshot_dir'))

    const row = db
      .prepare(`SELECT e2_variant FROM devices WHERE id = 'dev-11'`)
      .get() as { e2_variant: string | null }
    assert.equal(row.e2_variant, null, '老设备行的代次必须是 NULL（不是某一代）')
    const alarmRow = db
      .prepare(`SELECT snapshot_dir FROM alarms WHERE id = 'alm-11'`)
      .get() as { snapshot_dir: string | null }
    assert.equal(alarmRow.snapshot_dir, null)
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM alarms`).get() as { n: number }).n,
      1,
      '升级把老告警删掉了'
    )
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    db.close()
  })

  it('认不出的代次字符串当"还没读到过"处理（别人动过的库）', () => {
    const db = openDatabase({ file: path.join(tempRoot, 'variant-unknown.db') })
    try {
      const repository = new DeviceRepository(db)
      repository.upsertByIdentity(
        { ip: '10.0.0.9', httpPort: 80, username: 'admin', password: 'x' },
        { deviceUid: 'unknown-variant', name: 'x', channelCount: 8 }
      )
      const device = repository.findByUid('unknown-variant')
      assert.ok(device)
      db.prepare(`UPDATE devices SET e2_variant = 'thirdGeneration' WHERE id = ?`).run(device?.id)
      assert.equal(repository.findById(device?.id ?? '')?.e2Variant, undefined)
      // 两代之一照常读出来。
      repository.updateE2Variant(device?.id ?? '', 'airSonar')
      assert.equal(repository.findById(device?.id ?? '')?.e2Variant, 'airSonar')
    } finally {
      db.close()
    }
  })
})
