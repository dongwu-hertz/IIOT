/**
 * 听诊盒子族**接进设备管理**这一层（`DeviceService` 的第三个分支）。
 *
 * 为什么单独一条：`E2Client`（协议）与 `E2SyncService`（落库）各自有测试，但"这台设备能不能
 * 加进来、它算几路通道、探活用哪个端点"是**第三件事**，而它恰好是最容易静默出错的一处 ——
 * 用 `/get_devinfo` 去探一台听诊盒子会 404，`markFailed()` 把它记成离线，
 * **一台完全健康的设备显示离线**（相机当初踩的就是这个坑：见 `docs/…` §15.27.6）。
 *
 * 所以这里用**真的** `DeviceService` + 真的 HTTP 服务（只有设备那一侧是假的），断言：
 *   - 探活认机型（`kind` 与 `identitySource`）；
 *   - 身份**优先用设备自己的** `equip_number`，没有才按地址编（前缀 `e2ip:` 写明是编的）；
 *   - 加进来之后通道表是 **1 行**（协议就是单通道），不是 0 行也不是 8 行；
 *   - 健康检查走 `/workmode`（**不是** `/get_devinfo`），并且真的把它标成 ONLINE；
 *   - 别的机型走 `E2DeviceService` 时得到一个明确的错误，而不是一次 404。
 */

import { strict as assert } from 'node:assert'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { DeviceService } from '../src/main/services/device/device-service'
import { E2DeviceService } from '../src/main/services/device/e2/e2-device-service'
import { FetchHttpTransport } from '../src/main/services/device/http-transport'
import { MemoryCredentialStore } from '../src/main/services/device/credential-store'
import { ChannelRepository, DeviceRepository } from '../src/main/services/database/device-repository'
import { AlarmRepository, RecordingRepository } from '../src/main/services/database/alarm-repository'
import { StorageService } from '../src/main/services/storage/storage-service'
import { openDatabase } from '../src/main/services/database/schema'
import { AUSCULTATION_CHANNEL_COUNT } from '../src/main/services/database/device-repository'
import type { ImageSetServer } from '../src/main/services/device/e2/e2-device-service'

/**
 * 抓图端点服务的替身：这两条用例只关心"是不是听诊盒子"与通道数，不碰抓图。
 *
 * 真实现会开一个回环 HTTP 端口（`VideoFileServer.serveImages`），单测里没有理由开端口 ——
 * 抓图那三条路（有图 / 设备上本来没有 / 文件已不在）在 `e2-ptz-snapshots.test.ts` 里
 * 用真的临时目录验。
 */
const fakeImageServer: ImageSetServer = {
  async serveImages() {
    return { files: [], close: () => {} }
  }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e2-device-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

// ---------------------------------------------------------------------------
// 假设备（只实现「拉」通道用到的那几个端点）
// ---------------------------------------------------------------------------

interface FakeDevice {
  baseUrl: string
  paths: string[]
  close(): Promise<void>
}

interface FakeOptions {
  basic?: Record<string, unknown>
  system?: Record<string, unknown>
  workModeStatus?: number
  /**
   * 这一台假设备**只**提供哪一代的设备信息端点。
   *
   * 为什么不写就是用"两个都答"：真机上两代各只有**自己那一个**（2023 版 `/basic`、
   * SN-16 `/get_device_basic_params`）。原来的假设备两个都答，于是一个真实的缺陷被挡住了 ——
   * 探活固定去打 `/basic`，在一台 SN-16 上 404，而那台设备**根本加不进来**
   * （2026-09-17 真机验证发现，见 `docs/Ivms4200-UX-REFERENCE.md` §15.37）。
   */
  basicPath?: 'auscultation' | 'airSonar'
}

async function startDevice(options: FakeOptions = {}): Promise<FakeDevice> {
  const paths: string[] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      paths.push(url.pathname)
      const json = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }

      if (url.pathname === '/login') return json(200, { token: 'tok' })
      if (url.pathname === '/workmode') {
        if (options.workModeStatus !== undefined && options.workModeStatus !== 200) {
          return json(options.workModeStatus, { msg: 'no' })
        }
        return json(200, { work_mode: 'rotating_equipment', samplerate: 48000 })
      }
      if (url.pathname === '/system') {
        return json(200, options.system ?? { work_mode: 'rotating_equipment', db_limit: 50 })
      }
      if (url.pathname === '/basic' || url.pathname === '/get_device_basic_params') {
        // 指定了 basicPath 就只答那一代的端点（真机就是这样），另一代回 404。
        if (options.basicPath !== undefined) {
          const served = url.pathname === '/basic' ? 'auscultation' : 'airSonar'
          if (served !== options.basicPath) return json(404, { ret: -1 })
        }
        return json(
          200,
          options.basic ?? {
            dev_name: 'E2-1',
            dev_type: 'AR02',
            dev_version: 'V2.8.0',
            equip_number: 'C864C0DF79A22067ABE5BB214F321B1E'
          }
        )
      }
      if (url.pathname === '/alarm_log_all' || url.pathname === '/get_all_alarms') {
        return json(200, { logs_count: 0, logs: [] })
      }
      return json(404, { msg: 'no such endpoint' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    paths,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

// ---------------------------------------------------------------------------
// 真的 DeviceService（只有设备那一侧是假的）
// ---------------------------------------------------------------------------

interface Harness {
  service: DeviceService
  devices: DeviceRepository
  channels: ChannelRepository
  db: ReturnType<typeof openDatabase>
}

const cleanup: Array<() => Promise<void>> = []
after(async () => {
  for (const close of cleanup) await close()
})

let counter = 0

function harness(port: number): Harness {
  counter += 1
  const db = openDatabase({ file: path.join(tempRoot, `db-${counter}.db`) })
  const devices = new DeviceRepository(db)
  const channels = new ChannelRepository(db)
  const service = new DeviceService({
    devices,
    channels,
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
  // 端口从假设备的地址里取（`probe`/`add` 都接受 ip + httpPort）。
  void port
  return { service, devices, channels, db }
}

async function setup(options: FakeOptions = {}): Promise<{
  fake: FakeDevice
  env: Harness
  addInput: { ip: string; httpPort: number; username: string; password: string; kind: 'auscultationBox' }
}> {
  const fake = await startDevice(options)
  cleanup.push(fake.close)
  const port = Number(new URL(fake.baseUrl).port)
  const env = harness(port)
  return {
    fake,
    env,
    addInput: {
      ip: '127.0.0.1',
      httpPort: port,
      username: 'admin',
      password: 'x',
      kind: 'auscultationBox'
    }
  }
}

// ---------------------------------------------------------------------------

describe('听诊盒子：探活（probe）', () => {
  it('认机型，并用**设备自己的** `equip_number` 做身份', async () => {
    const { env, addInput } = await setup()
    try {
      const probe = await env.service.probe(addInput)
      assert.equal(probe.reachable, true)
      assert.equal(probe.kind, 'auscultationBox')
      assert.equal(probe.identitySource, 'device')
      assert.equal(probe.alreadyRegistered, false)
      // uid 带 `e2:` 前缀 = 设备给的（`e2ip:` 才是按地址编的）。
      assert.match(String(probe.info?.deviceUid), /^e2:/)
      assert.equal(probe.info?.name, 'E2-1')
      assert.equal(probe.info?.channelCount, AUSCULTATION_CHANNEL_COUNT)
    } finally {
      env.db.close()
    }
  })

  it('设备没报 `equip_number` ⇒ uid 按地址编，并在结果里**说明**（前缀 `e2ip:`）', async () => {
    const { env, addInput } = await setup({
      basic: { dev_name: 'no-serial', dev_type: 'AR02' }
    })
    try {
      const probe = await env.service.probe(addInput)
      assert.equal(probe.identitySource, 'minted')
      assert.match(String(probe.info?.deviceUid), /^e2ip:/)
    } finally {
      env.db.close()
    }
  })

  it('**探活不用 `/get_devinfo`**（那台设备上不存在，用它会把健康设备判成离线）', async () => {
    const { fake, env, addInput } = await setup()
    try {
      await env.service.probe(addInput)
      assert.equal(fake.paths.includes('/get_devinfo'), false)
      assert.ok(fake.paths.includes('/login'))
      assert.ok(fake.paths.includes('/basic'))
    } finally {
      env.db.close()
    }
  })

  /**
   * 2026-09-17 真机验证发现的缺陷的回归测试。
   *
   * 探活原来登录之后**直接**读设备信息，而设备信息端点按代次不同（2023 版 `/basic`、
   * SN-16 `/get_device_basic_params`）。于是对一台真实的 SN-16，探活会去打 `/basic`、吃 404、
   * 报"设备返回 HTTP 404"—— 表现是**这台设备根本加不进来**（而登录明明是成功的，
   * 看起来像口令或权限问题）。修法是先 `ensureVariant()`（读两代都有的 `/system`）再读设备信息。
   */
  it('SN-16 空气声呐（只有 `/get_device_basic_params`）加得进来，而且先判代次再读设备信息', async () => {
    const { fake, env, addInput } = await setup({
      // 真机就是这样：2023 版的 `/basic` 它没有。
      basicPath: 'airSonar',
      system: { cam_enable: 1, cur_realtime_channel: 1, db_limit: 50, samplerate: 20000 },
      basic: {
        dev_name: 'SN-16 空气声呐',
        dev_type: 'SN-16',
        dev_version: 'V3.2.0',
        equip_number: 'SN16-0001'
      }
    })
    try {
      const probe = await env.service.probe(addInput)
      assert.equal(probe.reachable, true, 'SN-16 探活失败：' + JSON.stringify(probe))
      assert.equal(probe.identitySource, 'device')
      assert.equal(probe.info?.deviceUid, 'e2:SN16-0001')
      /*
       * 通道数取设备自己的型号串（`SN-16` ⇒ 16），不是这一族的产品默认值（1）：
       * 否则添加对话框写"通道数 1"、而同一条设备的详情页写 16 —— 同一条事实两个答案。
       */
      assert.equal(probe.info?.channelCount, 16)

      // 顺序：变体（`/system`）必须在设备信息之前 —— 端点就是由它决定的。
      const systemAt = fake.paths.indexOf('/system')
      const basicAt = fake.paths.indexOf('/get_device_basic_params')
      assert.ok(systemAt >= 0 && basicAt > systemAt, '没有先判代次：' + JSON.stringify(fake.paths))
      assert.equal(fake.paths.includes('/basic'), false, '对 SN-16 打了 2023 版的 /basic')

      // 加进来这一半也要过（这是操作员看得见的那一步）。
      const device = await env.service.add(addInput)
      assert.equal(device.kind, 'auscultationBox')
      assert.equal(device.deviceUid, 'e2:SN16-0001')
    } finally {
      env.db.close()
    }
  })

  it('同一台设备再探一次 ⇒ 认得出它已经注册过（身份不是地址）', async () => {
    const { env, addInput } = await setup()
    try {
      const first = await env.service.add(addInput)
      const probe = await env.service.probe(addInput)
      assert.equal(probe.alreadyRegistered, true)
      assert.equal(probe.existingDeviceId, first.id)
    } finally {
      env.db.close()
    }
  })
})

describe('听诊盒子：加进来', () => {
  it('落库的是 `auscultationBox`，并且通道表是 **1 行**（协议就是单通道）', async () => {
    const { env, addInput } = await setup()
    try {
      const device = await env.service.add(addInput)
      assert.equal(device.kind, 'auscultationBox')
      assert.equal(env.devices.findById(device.id)?.kind, 'auscultationBox')

      const channels = env.channels.listByDevice(device.id)
      assert.equal(channels.length, AUSCULTATION_CHANNEL_COUNT)
      assert.equal(channels[0]?.channelIndex, 0)
    } finally {
      env.db.close()
    }
  })

  it('设备信息从 `/basic` 读（真的读，不是编的）', async () => {
    const { env, addInput } = await setup()
    try {
      const device = await env.service.add(addInput)
      const info = await env.service.getInfo(device.id)
      assert.equal(info.name, 'E2-1')
      assert.equal(info.firmwareVersion, 'V2.8.0')
      assert.equal(info.channelCount, AUSCULTATION_CHANNEL_COUNT)
    } finally {
      env.db.close()
    }
  })

  it('刷新通道表不设备端点（这一族没有通道表，读回本地那一条就是对的）', async () => {
    const { fake, env, addInput } = await setup()
    try {
      const device = await env.service.add(addInput)
      const before = fake.paths.length
      const channels = await env.service.refreshChannels(device.id)
      assert.equal(channels.length, AUSCULTATION_CHANNEL_COUNT)
      // 一次请求都不该发：问了就是 404 → 会被当成离线。
      assert.equal(fake.paths.length, before)
      assert.equal(fake.paths.includes('/get_passageway'), false)
    } finally {
      env.db.close()
    }
  })

  it('同址重加不新增行（identity 去重），而且通道表不会变成 8 行', async () => {
    const { env, addInput } = await setup()
    try {
      const first = await env.service.add(addInput)
      const second = await env.service.add(addInput)
      assert.equal(second.id, first.id)
      assert.equal(env.devices.list().length, 1)
      assert.equal(env.channels.listByDevice(first.id).length, AUSCULTATION_CHANNEL_COUNT)
    } finally {
      env.db.close()
    }
  })
})

describe('听诊盒子：健康检查走 `/workmode`', () => {
  it('探活成功 ⇒ ONLINE，且用的是 `/workmode` 而不是 `/get_devinfo`', async () => {
    const { fake, env, addInput } = await setup()
    try {
      const device = await env.service.add(addInput)
      const before = fake.paths.length
      await env.service.runHealthCheck()

      const asked = fake.paths.slice(before)
      assert.ok(asked.includes('/workmode'), asked.join(','))
      assert.equal(asked.includes('/get_devinfo'), false)
      assert.equal(env.devices.findById(device.id)?.status, 'ONLINE')
    } finally {
      env.db.close()
    }
  })

  it('`/workmode` 失败 ⇒ 记一次失败（不是"成功"）', async () => {
    const { env, addInput } = await setup({ workModeStatus: 500 })
    try {
      const device = await env.service.add(addInput)
      await env.service.runHealthCheck()
      // 还没到阈值，但仍应是"没成功过"的状态：不是 ONLINE。
      assert.notEqual(env.devices.findById(device.id)?.status, 'ONLINE')
    } finally {
      env.db.close()
    }
  })
})

describe('听诊盒子：别的机型走不到这条通道', () => {
  it('声纹设备调 `E2DeviceService` ⇒ 明确的机型错误，而不是一次 404', async () => {
    const { env, addInput } = await setup()
    try {
      // 造一台"声纹设备"行（只为了验机型判断，不连它的协议）。
      const box = env.devices.upsertByIdentity(
        { ip: '10.0.0.9', httpPort: 80, username: 'admin', password: 'x' },
        { deviceUid: 'sn-box-1', name: 'AE08', channelCount: 8 }
      ).device

      const e2 = new E2DeviceService({
        devices: env.service,
        alarms: new AlarmRepository(env.db),
        recordings: new RecordingRepository(env.db),
        storage: new StorageService({
          db: env.db,
          getStorageRoot: () => path.join(tempRoot, `storage-${counter}`),
          getMinFreeBytes: () => 0
        }),
        files: fakeImageServer
      })

      await assert.rejects(() => e2.status(box.id), /不是听诊盒子/)
      await assert.rejects(() => e2.sync(box.id), /不是听诊盒子/)
      // 听诊盒子自己走得通。
      const device = await env.service.add(addInput)
      const status = await e2.status(device.id)
      assert.equal(status.variant, 'auscultation')
      assert.equal(status.mode, 'rotating_equipment')
    } finally {
      env.db.close()
    }
  })
})

describe('听诊盒子：Air Sonar 的通道数来自型号字符串', () => {
  it('`dev_type: AS16` ⇒ 状态里报 16（设备自己说的，不是我们猜的）', async () => {
    const { env, addInput } = await setup({
      basic: { dev_name: 'AS16-1', dev_type: 'AS16', dev_version: 'V2.1.0', equip_number: 'AS16-ABC' },
      system: { cam_enable: true, cur_realtime_channel: 2, db_limit: 50 }
    })
    try {
      const device = await env.service.add(addInput)
      const e2 = new E2DeviceService({
        devices: env.service,
        alarms: new AlarmRepository(env.db),
        recordings: new RecordingRepository(env.db),
        storage: new StorageService({
          db: env.db,
          getStorageRoot: () => path.join(tempRoot, `storage-air-${counter}`),
          getMinFreeBytes: () => 0
        }),
        files: fakeImageServer
      })
      const status = await e2.status(device.id)
      assert.equal(status.variant, 'airSonar')
      assert.equal(status.channelCount, 16)
      // Air Sonar 没有工作模式这一说。
      assert.equal(status.mode, undefined)
      assert.equal(status.rawWorkMode, '')
      /*
       * 本地通道表**跟着设备说的那个数**走（业主 2026-09-17 第 3 条那一批改的）。
       *
       * 改之前这里固定 1 行（`AUSCULTATION_CHANNEL_COUNT`），于是一台 16 通道的 SN-16 在
       * 设备管理页的「设备通道」列显示 1、而同一台设备的详情页显示 16 —— 同一条事实两个答案。
       * 通道行数现在是 `e2ChannelCountFromModel(dev_type)`，算不出来才是 1。
       *
       * ⚠️ 行里的 `enabled` 仍然是**本机默认值**（`seedChannels` 全给 1）：这一族没有任何
       * 按通道开关的接口，所以"已启用 16/16"只说明本机认为它开着。
       */
      assert.equal(env.channels.listByDevice(device.id).length, 16)
      assert.equal(env.channels.listByDevice(device.id)[15]?.channelIndex, 15)
    } finally {
      env.db.close()
    }
  })
})

/**
 * 机型自动识别（业主 2026-09-17 第 2 条）：**探活不带 `kind`** 也要认得出这台设备。
 *
 * 这一条与上面那些测试的区别是**入口**：上面每一条都传了 `kind: 'auscultationBox'`（旧写法，
 * 界面当时让人选机型），而这一批之后界面不再传它 —— 走的是 `AUTO_PROBE_ORDER`
 * （声纹设备 → 听诊盒子族 → 声学相机）逐个试。所以这里必须**去掉 `kind`** 再探：
 * 少了这条测试，"自动识别"这条链在单测里一次都没有被走过。
 */
describe('机型自动识别：探活不带 kind', () => {
  it('认得出听诊盒子族，并落库成 `auscultationBox`', async () => {
    const { env, addInput } = await setup()
    try {
      // 只留地址与凭据 —— 界面现在就是这么发的（`AddDeviceDialog` 不再传 kind）。
      const noKind = {
        ip: addInput.ip,
        httpPort: addInput.httpPort,
        username: addInput.username,
        password: addInput.password
      }
      const probe = await env.service.probe(noKind)
      assert.equal(probe.reachable, true)
      assert.equal(probe.kind, 'auscultationBox')
      assert.equal(probe.identitySource, 'device')

      const device = await env.service.add(noKind)
      assert.equal(device.kind, 'auscultationBox')
      // 读回：库里那一行的机型也必须是它（不是"探活认出来了但落库按别的机型"）。
      assert.equal(env.devices.findById(device.id)?.kind, 'auscultationBox')
    } finally {
      env.db.close()
    }
  })

  it('顺序是"声纹设备那一家先试、失败了才轮到这一族"（顺序写错会白打一轮端点）', async () => {
    const { fake, env, addInput } = await setup()
    try {
      const noKind = {
        ip: addInput.ip,
        httpPort: addInput.httpPort,
        username: addInput.username,
        password: addInput.password
      }
      await env.service.probe(noKind)
      /*
       * 证据是**发出去的请求顺序**：声纹设备那一家要读 `/get_devinfo`（这个假设备上 404），
       * 而这一族要读 `/system` 判代次 —— 前者必须出现在后者之前。
       */
      const deviceInfoAt = fake.paths.indexOf('/get_devinfo')
      const systemAt = fake.paths.indexOf('/system')
      assert.ok(deviceInfoAt >= 0, '自动识别没有先试声纹设备那一家：' + fake.paths.join(','))
      assert.ok(systemAt > deviceInfoAt, '先问了这一族才问声纹设备：' + fake.paths.join(','))
      // 一路 404 也不能把探活判成"设备不可达"：识别成功就是成功。
      assert.equal(fake.paths.includes('/basic') || fake.paths.includes('/get_device_basic_params'), true)
    } finally {
      env.db.close()
    }
  })
})
