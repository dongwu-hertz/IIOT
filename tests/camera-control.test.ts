/**
 * 相机控制与维护服务测试（检测模式 / 检测启停 / 启用中的策略 / 维护能力）。
 *
 * 这些用例守的是**这个功能最容易骗人的三个地方**，每一个都有真机先例：
 *
 *   1. `ret:200` 不等于生效。本设备实测过 `PUT /alarm_strategy {Switch:1}` 返回
 *      `{"msg":"SUCCESS","ret":200}` 而读回来仍是 `switch:0`。所以每个写方法的
 *      返回值必须是**重读值** + 一个 `applied`，而 `applied === false` 的场景
 *      必须被断言，不能只测"顺利改好"的那条路。
 *   2. `run_mode` 不是 `1`/`-1` 时**不猜**。手册只定义了两个取值，mapper 只保留
 *      原始值；`applied` 因此也是 `false`。
 *   3. 没有启用策略时 `POST /turn_on_detect` 回 `ret:-1`（新手册
 *      `docs/reference/api-workflow.txt` 第 203 行）。那是一条**设备业务失败**，
 *      必须带着设备的 `msg` 原文冒到界面，而不是被吞掉或改写成通用错误。
 *
 * 假客户端是**结构化类型**注入的（`CameraControlOperations`），所以不需要真机、
 * 不需要 Electron、不需要 SQLite。最后两个用例额外走一次真实的 `Fa371ApiClient`
 * （只换掉 HTTP 传输层），把 `ret:-1` 从"线上字段"到"AppError"那一段也钉住。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { AppError, ErrorCodes } from '../src/shared/errors'
import { Fa371RunMode } from '../src/shared/domain/fa371'
import {
  cameraMaintenanceFeatures,
  maintenanceFeature
} from '../src/shared/domain/camera-control'
import {
  CAMERA_CONTROL_ADMIN_REQUIRED,
  CameraControlService,
  cameraControlRequiresAdministrator,
  type CameraControlAction,
  type CameraControlOperations
} from '../src/main/services/device/fa371/camera-control-service'
import { Fa371ApiClient } from '../src/main/services/device/fa371/fa371-api-client'
import type { HttpResponse, HttpTransport } from '../src/main/services/device/http-transport'

// ---------------------------------------------------------------------------
// 假客户端
// ---------------------------------------------------------------------------

interface FakeOptions {
  runMode?: number | string
  /** 依次返回的读数；用完后回落到最后一个。用来复现"写进去了"与"没写进去"。 */
  runModeReads?: Array<number | string>
  detectStatus?: unknown
  /** `startDetection` 的行为；抛错用来复现 `ret:-1`。 */
  startDetection?: () => Promise<never>
  /** 启用集合，按调用顺序依次返回；用完后回落到最后一个。 */
  enabledReads?: Array<Array<Record<string, unknown>>>
  versionInfo?: () => Promise<unknown>
  basicInfo?: () => Promise<unknown>
}

interface Fake {
  operations: CameraControlOperations
  runModeWrites: number[]
  strategyWrites: Array<{ switch: number; id: number }>
}

function createFake(options: FakeOptions = {}): Fake {
  const runModeReads = options.runModeReads ?? [options.runMode ?? Fa371RunMode.SingleDetection]
  let readIndex = 0
  const enabledReads = options.enabledReads ?? [[]]
  let enabledIndex = 0

  const runModeWrites: number[] = []
  const strategyWrites: Array<{ switch: number; id: number }> = []

  const operations: CameraControlOperations = {
    async getRunMode() {
      const value = runModeReads[Math.min(readIndex, runModeReads.length - 1)]
      readIndex += 1
      return { run_mode: value, ret: 200, msg: 'SUCCESS' }
    },
    async setRunMode(body) {
      runModeWrites.push(body.run_mode)
      return { ret: 200, msg: 'SUCCESS' }
    },
    async getDetectStatus() {
      return (options.detectStatus ?? { detect_status: 0 }) as never
    },
    async startDetection() {
      if (options.startDetection) return options.startDetection()
      return { detect_id: 7, ret: 200, msg: 'SUCCESS' }
    },
    async stopDetection() {
      return undefined
    },
    async getEnabledAlarmStrategies() {
      const list = enabledReads[Math.min(enabledIndex, enabledReads.length - 1)] ?? []
      enabledIndex += 1
      return { alarm_strategy_list: list, ret: 200, msg: 'SUCCESS' }
    },
    async setAlarmStrategyEnabled(body) {
      strategyWrites.push({ switch: body.switch, id: body.id })
      return { ret: 200, msg: 'SUCCESS' }
    },
    async getVersionInfo() {
      if (options.versionInfo) return (await options.versionInfo()) as never
      return { device_version: 'V0.5.1.6_251219', sdk_version: 'v8.1.0', ret: 200, msg: 'SUCCESS' }
    },
    async getBasicInfo() {
      if (options.basicInfo) return (await options.basicInfo()) as never
      return {
        web_version: 'WEBV10.2.5',
        upgrade_time: '2026-09-14_06:56:47',
        ret: 200,
        msg: 'SUCCESS'
      }
    },
    // 应用模式预设走的是 `/system/acoustic` + `/system/image`，本文件不测它
    // （专门的用例在 `camera-mode-preset.test.ts`）；这里只把形状补齐，
    // 让这个假客户端仍然满足 `CameraControlOperations`。
    async getAcousticConfig() {
      return {} as never
    },
    async setAcousticConfig() {
      return { ret: 200, msg: 'SUCCESS' }
    },
    async getImagingConfig() {
      return {} as never
    },
    async setImagingConfig() {
      return { ret: 200, msg: 'SUCCESS' }
    },
    // 应用模式（`GET`/`PUT /system`，端点未文档化）的用例在
    // `camera-work-mode.test.ts`；这里只把形状补齐，让假客户端仍然满足
    // `CameraControlOperations`。
    async getWorkMode() {
      return { work_mode: 1, ret: 200, msg: 'SUCCESS' }
    },
    async setWorkMode() {
      return { ret: 200, msg: 'SUCCESS' }
    }
  }

  return { operations, runModeWrites, strategyWrites }
}

function serviceWith(fake: Fake, deviceOnline = true): CameraControlService {
  return new CameraControlService({ clientFor: () => fake.operations, isOnline: () => deviceOnline })
}

/** 一条启用中的策略（字段形状取自真机响应）。 */
function enabledEntry(id: number, enabled = true): Record<string, unknown> {
  return { id, name: `策略${id}`, switch: enabled ? 1 : 0 }
}

// ---------------------------------------------------------------------------
// 检测模式映射（不猜）
// ---------------------------------------------------------------------------

describe('camera control: 检测模式映射', () => {
  it('把 1 映射成单次检测', async () => {
    const fake = createFake({ runMode: 1 })
    const mode = await serviceWith(fake).readRunMode('cam-1')
    assert.equal(mode.raw, 1)
    assert.equal(mode.mode, Fa371RunMode.SingleDetection)
    assert.equal(mode.key, 'single_detection')
  })

  it('把 -1 映射成智能巡航', async () => {
    const fake = createFake({ runMode: -1 })
    const mode = await serviceWith(fake).readRunMode('cam-1')
    assert.equal(mode.raw, -1)
    assert.equal(mode.mode, Fa371RunMode.IntelligentCruise)
    assert.equal(mode.key, 'intelligent_cruise')
  })

  it('既不是 1 也不是 -1 时只保留原始值，不就近猜一个模式', async () => {
    const fake = createFake({ runMode: 2 })
    const mode = await serviceWith(fake).readRunMode('cam-1')
    assert.equal(mode.raw, 2)
    assert.equal(mode.mode, undefined, '未知取值不得被强制成某个枚举')
    assert.equal(mode.key, undefined)
  })

  it('设备没回 run_mode 时不产出任何值', async () => {
    // `runModeReads: [undefined]` 复现"字段整个缺席"。
    const fake = createFake({ runModeReads: [undefined as never] })
    const mode = await serviceWith(fake).readRunMode('cam-1')
    assert.equal(mode.raw, undefined)
    assert.equal(mode.mode, undefined)
    assert.equal(mode.key, undefined)
  })
})

// ---------------------------------------------------------------------------
// 写后重读：成功码不是证据
// ---------------------------------------------------------------------------

describe('camera control: 改检测模式要重读', () => {
  it('设备接受写入时 applied 为 true，且 after 是重读值', async () => {
    const fake = createFake({ runModeReads: [1, -1] })
    const result = await serviceWith(fake).writeRunMode('cam-1', Fa371RunMode.IntelligentCruise)

    assert.deepEqual(fake.runModeWrites, [-1])
    assert.equal(result.requested, -1)
    assert.equal(result.before.mode, 1)
    assert.equal(result.after.mode, -1)
    assert.equal(result.applied, true)
  })

  it('设备应答成功却忽略写入时，after 仍是旧值且 applied 为 false', async () => {
    // 真机先例：`PUT /alarm_strategy {Switch:1}` → `ret:200`，读回来没变。
    const fake = createFake({ runModeReads: [1, 1] })
    const result = await serviceWith(fake).writeRunMode('cam-1', Fa371RunMode.IntelligentCruise)

    assert.deepEqual(fake.runModeWrites, [-1], '请求确实发出去了')
    assert.equal(result.after.mode, 1, 'after 必须是设备说的，不是请求值')
    assert.equal(result.applied, false, '成功码不得被当成生效')
  })

  it('重读回来是未知取值时也不得判成生效', async () => {
    const fake = createFake({ runModeReads: [1, 9] })
    const result = await serviceWith(fake).writeRunMode('cam-1', Fa371RunMode.IntelligentCruise)
    assert.equal(result.after.raw, 9)
    assert.equal(result.after.mode, undefined)
    assert.equal(result.applied, false)
  })

  it('拒绝手册未定义的取值，而不是发一个猜出来的数字', async () => {
    const fake = createFake({})
    await assert.rejects(
      () => serviceWith(fake).writeRunMode('cam-1', 0 as never),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, ErrorCodes.VALIDATION_ERROR)
        return true
      }
    )
    assert.deepEqual(fake.runModeWrites, [], '非法取值不得发到设备')
  })
})

// ---------------------------------------------------------------------------
// 检测启停
// ---------------------------------------------------------------------------

describe('camera control: 检测启停', () => {
  it('把 detect_status 的 0 / 1 归一化成布尔', async () => {
    const off = await serviceWith(createFake({ detectStatus: { detect_status: 0 } })).readDetectStatus('cam-1')
    assert.equal(off.detecting, false)

    const on = await serviceWith(createFake({ detectStatus: { detect_status: 1 } })).readDetectStatus('cam-1')
    assert.equal(on.detecting, true)
  })

  it('手册说的例外可观测：带 ret/msg 时 retPresent 为 true', async () => {
    // 旧手册说 §5.1.16 是唯一不带 ret 的接口；真机实测它带了 ret/msg。
    // 这个标记就是用来发现这种差异的，所以两种情况都要钉住。
    const withRet = await serviceWith(
      createFake({ detectStatus: { detect_status: 0, ret: 200, msg: 'SUCCESS' } })
    ).readDetectStatus('cam-1')
    assert.equal(withRet.retPresent, true)

    const withoutRet = await serviceWith(
      createFake({ detectStatus: { detect_status: 0 } })
    ).readDetectStatus('cam-1')
    assert.equal(withoutRet.retPresent, false)
  })

  it('turn_on_detect 返回 ret:-1（没有可用策略）时，带着设备的 msg 冒到上层', async () => {
    const fake = createFake({
      // `Fa371ApiClient` 在 ret !== 200 时抛的就是这个形状：DEVICE_ERROR + msg 原文。
      startDetection: async () => {
        throw new AppError(ErrorCodes.DEVICE_ERROR, '设备返回错误: 没有可用的告警策略', '/turn_on_detect ret=-1')
      }
    })

    await assert.rejects(
      () => serviceWith(fake).turnOnDetect('cam-1'),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, ErrorCodes.DEVICE_ERROR)
        assert.match(error.message, /没有可用的告警策略/, '设备的 msg 必须原样带出')
        return true
      }
    )
  })

  it('开始检测后按重读的 detect_status 判断 applied', async () => {
    const fake = createFake({ detectStatus: { detect_status: 1 } })
    const result = await serviceWith(fake).turnOnDetect('cam-1')
    assert.equal(result.action, 'turn_on')
    assert.equal(result.applied, true)
    assert.equal(result.detectId, 7)
  })

  it('设备回了 detect_id 但状态仍为 0 时，applied 如实为 false', async () => {
    const fake = createFake({ detectStatus: { detect_status: 0 } })
    const result = await serviceWith(fake).turnOnDetect('cam-1')
    assert.equal(result.applied, false)
  })

  it('停止检测后按重读值判断 applied', async () => {
    const stopped = await serviceWith(createFake({ detectStatus: { detect_status: 0 } })).turnOffDetect('cam-1')
    assert.equal(stopped.action, 'turn_off')
    assert.equal(stopped.applied, true)

    const still = await serviceWith(createFake({ detectStatus: { detect_status: 1 } })).turnOffDetect('cam-1')
    assert.equal(still.applied, false)
  })
})

// ---------------------------------------------------------------------------
// 启用中的策略
// ---------------------------------------------------------------------------

describe('camera control: 启用中的告警策略', () => {
  it('读回启用集合与 id 列表', async () => {
    const fake = createFake({ enabledReads: [[enabledEntry(1)]] })
    const view = await serviceWith(fake).readEnabledStrategy('cam-1')
    assert.deepEqual(view.ids, ['1'])
    assert.equal(view.items.length, 1)
  })

  it('启用目标时先停用当前启用的那条（手册场景 2 的顺序）', async () => {
    const fake = createFake({
      enabledReads: [[enabledEntry(1)], [enabledEntry(2)]]
    })
    const result = await serviceWith(fake).setStrategyEnabled('cam-1', 2, true)

    // 先 0/1 停用旧的，再 1/2 启用目标 —— 顺序就是手册写的那个顺序。
    assert.deepEqual(fake.strategyWrites, [
      { switch: 0, id: 1 },
      { switch: 1, id: 2 }
    ])
    assert.deepEqual(result.before, ['1'])
    assert.equal(result.disabledPrevious, 1)
    assert.deepEqual(result.after, ['2'])
    assert.equal(result.applied, true)
  })

  it('没有任何策略启用时直接启用，不产生多余的停用', async () => {
    const fake = createFake({ enabledReads: [[], [enabledEntry(1)]] })
    const result = await serviceWith(fake).setStrategyEnabled('cam-1', 1, true)
    assert.deepEqual(fake.strategyWrites, [{ switch: 1, id: 1 }])
    assert.equal(result.disabledPrevious, undefined)
    assert.equal(result.applied, true)
  })

  it('停用只发一条 switch:0，不去动别的策略', async () => {
    const fake = createFake({ enabledReads: [[enabledEntry(1)], []] })
    const result = await serviceWith(fake).setStrategyEnabled('cam-1', 1, false)
    assert.deepEqual(fake.strategyWrites, [{ switch: 0, id: 1 }])
    assert.equal(result.applied, true)
  })

  it('设备应答 ret:200 但启用集合没变时 applied 为 false', async () => {
    const fake = createFake({ enabledReads: [[], []] })
    const result = await serviceWith(fake).setStrategyEnabled('cam-1', 1, true)
    assert.equal(result.applied, false)
    assert.deepEqual(result.after, [])
  })

  it('id 不是正整数时拒绝写入', async () => {
    const fake = createFake({})
    await assert.rejects(
      () => serviceWith(fake).setStrategyEnabled('cam-1', 0, true),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, ErrorCodes.VALIDATION_ERROR)
        return true
      }
    )
    assert.deepEqual(fake.strategyWrites, [])
  })

  it('当前启用着一条无法解析成整数的策略时，如实报错而不是盲目发写', async () => {
    const fake = createFake({ enabledReads: [[{ id: 'abc', switch: 1 }]] })
    await assert.rejects(
      () => serviceWith(fake).setStrategyEnabled('cam-1', 2, true),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, ErrorCodes.VALIDATION_ERROR)
        return true
      }
    )
    assert.deepEqual(fake.strategyWrites, [], '停不掉旧策略之前不得贸然启用新策略')
  })
})

// ---------------------------------------------------------------------------
// 维护：版本可读、能力不可用要明说
// ---------------------------------------------------------------------------

describe('camera control: 维护', () => {
  it('两个来源都读到时，版本字段逐个填上', async () => {
    const info = await serviceWith(createFake({})).readMaintenance('cam-1')
    assert.equal(info.version.firmwareVersion, 'V0.5.1.6_251219')
    assert.equal(info.version.sdkVersion, 'v8.1.0')
    assert.equal(info.version.webVersion, 'WEBV10.2.5')
    assert.equal(info.version.lastUpgradeTime, '2026-09-14_06:56:47')
    assert.deepEqual(info.unreadable, [])
  })

  it('一个来源失败只影响它自己负责的字段', async () => {
    const fake = createFake({
      basicInfo: async () => {
        throw new AppError(ErrorCodes.DEVICE_ERROR, 'GET /basic 不存在')
      }
    })
    const info = await serviceWith(fake).readMaintenance('cam-1')
    assert.equal(info.version.firmwareVersion, 'V0.5.1.6_251219')
    assert.equal(info.version.webVersion, undefined, '读不到就是 undefined，不编一个值')
    assert.deepEqual(info.unreadable, ['basic'])
  })

  it('设备没回字段时保持缺省，不产出空字符串', async () => {
    const fake = createFake({
      versionInfo: async () => ({ ret: 200, msg: 'SUCCESS' }),
      basicInfo: async () => ({ ret: 200, msg: 'SUCCESS' })
    })
    const info = await serviceWith(fake).readMaintenance('cam-1')
    assert.equal(info.version.firmwareVersion, undefined)
    assert.equal(info.version.lastUpgradeTime, undefined)
    assert.deepEqual(info.unreadable, [])
  })

  /**
   * 这条用例**在升级实装的那一轮改过**，改动的理由写在这里：
   *
   * 旧断言是「升级/回滚/重启/恢复出厂在任何状态下都不可用」。升级这件事后来由
   * 负责人确认可以做 —— 它走的是设备自带 Web 界面的那条 HTTP 路
   * （`POST /upload` + `PUT /reboot`，从设备前端 bundle 里读出来的未文档化接口），
   * 所以 `firmware_upgrade` 与 `reboot` 在**设备在线时**是真实可用的。
   *
   * `rollback` 与 `factory_reset` 仍然不可用：没有任何实测或文档依据
   * （17 个候选路径真机全部 404，设备 bundle 里只有一条语义未经验证的 `/recovery`）。
   */
  it('升级/重启在设备在线时可用、离线时禁用；回滚/恢复出厂在任何状态下都不可用', () => {
    const onlineFeatures = cameraMaintenanceFeatures({ deviceOnline: true })
    for (const id of ['firmware_upgrade', 'reboot'] as const) {
      const feature = maintenanceFeature({ features: onlineFeatures }, id)
      assert.ok(feature, `${id} 必须在能力表里`)
      assert.equal(feature.available, true, `${id} 走设备自带 Web 界面的 HTTP 路，在线时可用`)
      assert.equal(feature.reasonKey, undefined)
    }

    const offlineFeatures = cameraMaintenanceFeatures({ deviceOnline: false })
    for (const id of ['firmware_upgrade', 'reboot'] as const) {
      const feature = maintenanceFeature({ features: offlineFeatures }, id)
      assert.ok(feature, `${id} 必须在能力表里`)
      assert.equal(feature.available, false, `${id} 离线时不可用`)
      assert.equal(feature.reasonKey, 'device_offline', `${id} 离线时必须说明原因`)
    }

    for (const id of ['rollback', 'factory_reset'] as const) {
      for (const features of [onlineFeatures, offlineFeatures]) {
        const feature = maintenanceFeature({ features }, id)
        assert.ok(feature, `${id} 必须在能力表里`)
        assert.equal(feature.available, false, `${id} 没有可用的接口，不得标成可用`)
        assert.equal(feature.reasonKey, 'not_in_open_interface')
      }
    }
  })

  it('设备在线时"打开设备 Web 界面"可用，离线时禁用并说明原因', async () => {
    const online = await serviceWith(createFake({}), true).readMaintenance('cam-1')
    const webOnline = maintenanceFeature(online, 'device_web_ui')
    assert.equal(webOnline?.available, true)
    assert.equal(webOnline?.reasonKey, undefined)

    const offline = await serviceWith(createFake({}), false).readMaintenance('cam-1')
    const webOffline = maintenanceFeature(offline, 'device_web_ui')
    assert.equal(webOffline?.available, false)
    assert.equal(webOffline?.reasonKey, 'device_offline')
  })
})

// ---------------------------------------------------------------------------
// 管理员校验的判定表
// ---------------------------------------------------------------------------

describe('camera control: 管理员校验', () => {
  const WRITES: CameraControlAction[] = [
    'writeRunMode',
    'turnOnDetect',
    'turnOffDetect',
    'setStrategyEnabled',
    // 应用模式预设写的是设备成像参数，与告警策略的写同级。
    'applyModePreset',
    // 切换应用模式改的是"这台设备在做哪种应用"，比改成像参数更重；端点是实测的、
    // 没有文档，所以更要管理员。详细用例在 `camera-work-mode.test.ts`。
    'writeWorkMode'
  ]
  const READS: CameraControlAction[] = [
    'readRunMode',
    'readDetectStatus',
    'readEnabledStrategy',
    'readMaintenance',
    // 读当前频带/目标数量只是读设备状态。
    'readModePreset',
    // 读应用模式也只是读设备状态。
    'readWorkMode'
  ]

  it('六个写操作要管理员，六个读操作不要', () => {
    for (const action of WRITES) {
      assert.equal(cameraControlRequiresAdministrator(action), true, `${action} 必须校验管理员`)
    }
    for (const action of READS) {
      assert.equal(cameraControlRequiresAdministrator(action), false, `${action} 是读，不应拦操作员`)
    }
  })

  it('判定表覆盖了每一个动作，没有遗漏的键', () => {
    const declared = Object.keys(CAMERA_CONTROL_ADMIN_REQUIRED).sort()
    assert.deepEqual(declared, [...WRITES, ...READS].sort())
  })
})

// ---------------------------------------------------------------------------
// 真实 Fa371ApiClient + 假 HTTP 传输层（把 ret:-1 那一段也钉住）
// ---------------------------------------------------------------------------

/** 只实现 `request`：其余两个方法在这个用例里不会被调用。 */
function transportFor(handler: (path: string, method: string) => HttpResponse): HttpTransport {
  return {
    request: async (options) => {
      const path = new URL(options.url).pathname
      return handler(path, options.method)
    },
    captureStream: async () => {
      throw new Error('not used')
    }
  } as HttpTransport
}

function jsonResponse(body: unknown): HttpResponse {
  return {
    status: 200,
    ok: true,
    headers: {},
    contentType: 'application/json',
    json: body,
    latencyMs: 1
  }
}

describe('camera control: 真机响应形状（ret:-1 与 HTML 兜底）', () => {
  it('POST /turn_on_detect 回 ret:-1 时，客户端抛 DEVICE_ERROR 并带 msg', async () => {
    const transport = transportFor((path) => {
      if (path === '/login') return jsonResponse({ token: 'abc123' })
      if (path === '/system/detect_status') return jsonResponse({ detect_status: 0 })
      if (path === '/turn_on_detect') {
        return jsonResponse({ ret: -1, msg: '当前没有启用的告警策略' })
      }
      return jsonResponse({ ret: 200, msg: 'SUCCESS' })
    })

    const client = new Fa371ApiClient({
      transport,
      baseUrl: '192.168.2.168',
      credential: { username: 'admin', password: '123456' }
    })
    const service = new CameraControlService({ clientFor: () => client })

    await assert.rejects(
      () => service.turnOnDetect('cam-1'),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, ErrorCodes.DEVICE_ERROR)
        assert.match(error.message, /当前没有启用的告警策略/)
        return true
      }
    )
  })

  it('PUT /run_mode 之后的重读走的是真客户端：读回旧值时 applied 为 false', async () => {
    const transport = transportFor((path, method) => {
      if (path === '/login') return jsonResponse({ token: 'abc123' })
      if (path === '/run_mode') {
        // 写请求被"接受"（ret:200），但读回来始终是 1 —— 正是本设备有先例的那种情况。
        return method === 'PUT'
          ? jsonResponse({ ret: 200, msg: 'SUCCESS' })
          : jsonResponse({ ret: 200, msg: 'SUCCESS', run_mode: 1 })
      }
      return jsonResponse({ detect_status: 0 })
    })

    const client = new Fa371ApiClient({
      transport,
      baseUrl: '192.168.2.168',
      credential: { username: 'admin', password: '123456' }
    })
    const service = new CameraControlService({ clientFor: () => client })

    const result = await service.writeRunMode('cam-1', Fa371RunMode.IntelligentCruise)
    assert.equal(result.after.mode, 1)
    assert.equal(result.applied, false)
  })

  it('PUT /alarm_strategy_enable 的发包形状是 {switch, id}（与设备自带 Web 界面一致）', async () => {
    const writes: unknown[] = []
    const transport = transportFor((path, method) => {
      if (path === '/login') return jsonResponse({ token: 'abc123' })
      if (path === '/alarm_strategy_enable') {
        return method === 'PUT'
          ? jsonResponse({ ret: 200, msg: 'SUCCESS' })
          : jsonResponse({ alarm_strategy_list: [], ret: 200, msg: 'SUCCESS' })
      }
      return jsonResponse({ detect_status: 0 })
    })
    // 记录请求体：`request` 的第二个参数是 options，`json` 就是发出去的包。
    const recording: HttpTransport = {
      request: async (options) => {
        if (options.method === 'PUT') writes.push(options.json)
        return transport.request(options)
      },
      captureStream: async () => {
        throw new Error('not used')
      }
    } as HttpTransport

    const client = new Fa371ApiClient({
      transport: recording,
      baseUrl: '192.168.2.168',
      credential: { username: 'admin', password: '123456' }
    })
    await new CameraControlService({ clientFor: () => client }).setStrategyEnabled('cam-1', 3, true)

    assert.deepEqual(writes, [{ switch: 1, id: 3 }])
  })
})
