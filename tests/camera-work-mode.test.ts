/**
 * 相机「应用模式」测试（局部放电 / 气体泄漏 / 机械异响）。
 *
 * ---------------------------------------------------------------------------
 * 为什么单独一个文件
 * ---------------------------------------------------------------------------
 * 这条通道与 `camera-control.test.ts` 守的是**同一个**设备，但风险不同：
 *
 *   1. **端点未文档化。** `GET` / `PUT /system` 不在任何一份手册里，是从设备自带
 *      Web 界面的 bundle 里读出来的（设备自家 UI 连切换控件都没有）。真机实测
 *      1/2/3 三个值都读得到、写得动，但"实测存在"不等于"受支持"—— 所以这里的
 *      用例必须同时钉住"读不到时怎么办"（`available: false`，界面不渲染控件），
 *      而不是只测顺利路径。
 *
 *   2. **未知取值不得被就近映射。** 设备自己的前端把"非 1 非 2"一律显示成机械异响，
 *      照抄那个兜底在界面上看起来"与设备一致"，但机型名会直接影响操作员判断。
 *      所以 `mapWorkMode` 只认 1/2/3，其余只留 `raw`。设备前端代码位置见
 *      `dto.ts` 的 `Fa371SystemDto`。
 *
 *   3. **成功码不是证据。** 本设备实测过 `PUT /alarm_strategy {Switch:1}` 应答
 *      `ret:200` 却完全不生效（`docs/FA371-API-DELTA.md` §1）。所以 `writeWorkMode`
 *      必须在写完之后**重读**，`applied` 由重读值比对得出 —— 而"设备应答 200 但读回来
 *      没变"这条路径必须被断言，不能只测"顺利改好"。
 *
 *   4. **不与成像参数耦合。** 切换应用模式只写 `work_mode`，不碰
 *      `/system/acoustic` 与 `/system/image`。最后两个用例用真实 `Fa371ApiClient`
 *      抓请求体，把这条边界钉死。
 *
 * 假客户端是**结构化类型**注入的（`CameraControlOperations`），所以不需要真机、
 * 不需要 Electron、不需要 SQLite。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { AppError, ErrorCodes } from '../src/shared/errors'
import {
  FA371_WORK_MODE_KEYS,
  FA371_WORK_MODES,
  Fa371WorkMode
} from '../src/shared/domain/fa371'
import {
  CAMERA_CONTROL_ADMIN_REQUIRED,
  CameraControlService,
  cameraControlRequiresAdministrator,
  type CameraControlOperations
} from '../src/main/services/device/fa371/camera-control-service'
import { mapWorkMode } from '../src/main/services/device/fa371/mappers'
import { Fa371ApiClient } from '../src/main/services/device/fa371/fa371-api-client'
import type {
  Fa371AckDto,
  Fa371SystemDto,
  Fa371WorkModeWriteDto
} from '../src/main/services/device/fa371/dto'
import type { HttpResponse, HttpTransport } from '../src/main/services/device/http-transport'

// ---------------------------------------------------------------------------
// 假客户端
// ---------------------------------------------------------------------------

interface FakeOptions {
  /** 依次返回的应用模式读数；用完后回落到最后一个。用来复现"写进去了"与"没写进去"。 */
  workModeReads?: Array<number | string | undefined>
  /** 让读通道直接失败，复现"未文档化端点在这版固件上没了"。 */
  getWorkMode?: () => Promise<never>
}

interface Fake {
  operations: CameraControlOperations
  /** 每次 `setWorkMode` 收到的请求体，按调用顺序。 */
  workModeWrites: Fa371WorkModeWriteDto[]
}

/**
 * 本文件只测应用模式那两个接口，其余方法被调用到就是用例写错了。
 *
 * 返回值写成 `Promise<never>`：每个方法的返回类型都不同（`Fa371RunModeDto`、
 * `void`、`Fa371AckDto`…），而 `Promise<never>` 可以赋给它们**全部**（`never` 是
 * 每个类型的子类型），所以这一份实现不需要为每个方法各写一个假实现、也不需要
 * 用 `as` 把它按到接口上。
 */
function unused(): Promise<never> {
  return Promise.reject(new Error('这个假客户端不该被这条用例调用'))
}

function createFake(options: FakeOptions = {}): Fake {
  const reads = options.workModeReads ?? [Fa371WorkMode.PartialDischarge]
  let readIndex = 0
  const workModeWrites: Fa371WorkModeWriteDto[] = []

  const operations: CameraControlOperations = {
    getRunMode: unused,
    setRunMode: unused,
    getLeakageConfig: unused,
    setLeakageConfig: unused,
    getScanArea: unused,
    setScanArea: unused,
    getDetectStatus: unused,
    startDetection: unused,
    stopDetection: unused,
    getEnabledAlarmStrategies: unused,
    setAlarmStrategyEnabled: unused,
    getVersionInfo: unused,
    getBasicInfo: unused,
    getAcousticConfig: unused,
    setAcousticConfig: unused,
    getImagingConfig: unused,
    setImagingConfig: unused,
    // 假客户端**不做校验**：它模拟的是"设备怎么答"，不是"服务怎么拦"。所以
    // 非法取值能穿过假客户端是预期的，服务那一层的拒绝由专门的用例断言。
    getWorkMode(): Promise<Fa371SystemDto> {
      if (options.getWorkMode) return options.getWorkMode()
      const value = reads[Math.min(readIndex, reads.length - 1)]
      readIndex += 1
      return Promise.resolve(
        value === undefined
          ? // 复现"字段整个缺席"：只有包络，没有 work_mode。
            { ret: 200, msg: 'SUCCESS' }
          : { work_mode: value, ret: 200, msg: 'SUCCESS' }
      )
    },
    setWorkMode(body: Fa371WorkModeWriteDto): Promise<Fa371AckDto> {
      workModeWrites.push({ ...body })
      return Promise.resolve({ ret: 200, msg: 'SUCCESS' })
    }
  }

  return { operations, workModeWrites }
}

function serviceWith(fake: Fake): CameraControlService {
  return new CameraControlService({ clientFor: () => fake.operations })
}

// ---------------------------------------------------------------------------
// 取值 -> 稳定 KEY（不猜）
// ---------------------------------------------------------------------------

describe('camera work mode: 取值映射', () => {
  it('把 1 映射成局部放电', async () => {
    const view = await serviceWith(
      createFake({ workModeReads: [Fa371WorkMode.PartialDischarge] })
    ).readWorkMode('cam-1').then((read) => read.view)
    assert.equal(view.raw, 1)
    assert.equal(view.mode, Fa371WorkMode.PartialDischarge)
    assert.equal(view.key, 'partial_discharge')
  })

  it('把 2 映射成气体泄漏', async () => {
    const view = await serviceWith(
      createFake({ workModeReads: [Fa371WorkMode.GasLeak] })
    ).readWorkMode('cam-1').then((read) => read.view)
    assert.equal(view.raw, 2)
    assert.equal(view.mode, Fa371WorkMode.GasLeak)
    assert.equal(view.key, 'gas_leak')
  })

  it('把 3 映射成机械异响', async () => {
    const view = await serviceWith(
      createFake({ workModeReads: [Fa371WorkMode.MechanicalNoise] })
    ).readWorkMode('cam-1').then((read) => read.view)
    assert.equal(view.raw, 3)
    assert.equal(view.mode, Fa371WorkMode.MechanicalNoise)
    assert.equal(view.key, 'mechanical')
  })

  it('未映射的取值只保留原始值，不被就近猜成某个模式', async () => {
    // 设备自己的前端把"非 1 非 2"一律显示成机械异响（`dto.ts` 里逐字照抄的那段
    // 三元表达式），本软件**不照抄**这条兜底：一个没见过的数字说明固件变了。
    const view = await serviceWith(createFake({ workModeReads: [7] })).readWorkMode('cam-1').then(
      (read) => read.view
    )
    assert.equal(view.raw, 7)
    assert.equal(view.mode, undefined, '未知取值不得被强制成某个枚举')
    assert.equal(view.key, undefined, '未知取值不得拿到一个机型名')
  })

  it('0 也不映射成机械异响（设备前端的兜底在这里不适用）', () => {
    const view = mapWorkMode({ work_mode: 0 })
    assert.equal(view.raw, 0)
    assert.equal(view.mode, undefined)
    assert.equal(view.key, undefined)
  })

  it('字段缺席时不产出任何值', async () => {
    const read = await serviceWith(createFake({ workModeReads: [undefined] })).readWorkMode('cam-1')
    assert.equal(read.view.raw, undefined)
    assert.equal(read.view.mode, undefined)
    assert.equal(read.view.key, undefined)
    // 字段缺席 = 这台设备这一版固件不提供这个读数 → 控件不该出现。
    assert.equal(read.available, false, '读不到 work_mode 时控件必须是不渲染')
  })

  it('读到取值时 available 为 true（控件才允许出现）', async () => {
    const read = await serviceWith(createFake({ workModeReads: [2] })).readWorkMode('cam-1')
    assert.equal(read.available, true)
    assert.deepEqual(read.selectable, [1, 2, 3])
  })

  it('读通道整体失败时收成 available:false，而不是抛出去', async () => {
    // 未文档化端点：换一版固件可能就没了。一个点了必然失败的按钮比没有按钮更糟，
    // 所以这里不抛异常（抛出去会让整张面板变成一条错误）。
    const fake = createFake({
      getWorkMode: () => Promise.reject(new AppError(ErrorCodes.INVALID_RESPONSE, '路径不存在'))
    })
    const read = await serviceWith(fake).readWorkMode('cam-1')
    assert.equal(read.available, false)
    assert.equal(read.view.raw, undefined)
  })

  it('三个可写的取值就是 1/2/3，且各有一个稳定 KEY', () => {
    assert.deepEqual([...FA371_WORK_MODES], [1, 2, 3])
    for (const value of FA371_WORK_MODES) {
      const key = FA371_WORK_MODE_KEYS[value]
      assert.match(key, /^[a-z_]+$/, `${value} 的 label KEY 必须是稳定标识符`)
    }
  })
})

// ---------------------------------------------------------------------------
// 写后重读：成功码不是证据
// ---------------------------------------------------------------------------

describe('camera work mode: 切换要重读', () => {
  it('设备接受写入时 applied 为 true，且 after 是重读值', async () => {
    const fake = createFake({ workModeReads: [1, 2] })
    const result = await serviceWith(fake).writeWorkMode('cam-1', Fa371WorkMode.GasLeak)

    assert.deepEqual(fake.workModeWrites, [{ work_mode: 2 }], '请求确实发出去了')
    assert.equal(result.requested, 2)
    assert.equal(result.before.raw, 1)
    assert.equal(result.after.raw, 2)
    assert.equal(result.after.key, 'gas_leak')
    assert.equal(result.applied, true)
  })

  it('设备应答 ret:200 却忽略写入时，after 仍是旧值且 applied 为 false', async () => {
    // 真机先例：`PUT /alarm_strategy {Switch:1}` → `ret:200`，读回来没变。
    const fake = createFake({ workModeReads: [1, 1] })
    const result = await serviceWith(fake).writeWorkMode('cam-1', Fa371WorkMode.MechanicalNoise)

    assert.deepEqual(fake.workModeWrites, [{ work_mode: 3 }], '请求确实发出去了')
    assert.equal(result.after.raw, 1, 'after 必须是设备说的，不是请求值')
    assert.equal(result.applied, false, '成功码不得被当成生效')
  })

  it('重读回来是未知取值时也不得判成生效', async () => {
    const fake = createFake({ workModeReads: [1, 9] })
    const result = await serviceWith(fake).writeWorkMode('cam-1', Fa371WorkMode.GasLeak)
    assert.equal(result.after.raw, 9)
    assert.equal(result.after.mode, undefined, '未知取值不得被映射')
    assert.equal(result.applied, false)
  })

  it('重读时字段缺席也不得判成生效', async () => {
    const fake = createFake({ workModeReads: [1, undefined] })
    const result = await serviceWith(fake).writeWorkMode('cam-1', Fa371WorkMode.GasLeak)
    assert.equal(result.after.raw, undefined)
    assert.equal(result.applied, false, '读不到就是没证据')
  })

  it('拒绝实测取值之外的数字，而不是发一个猜出来的模式', async () => {
    const fake = createFake({ workModeReads: [1] })
    await assert.rejects(
      () => serviceWith(fake).writeWorkMode('cam-1', 0 as never),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, ErrorCodes.VALIDATION_ERROR)
        return true
      }
    )
    assert.deepEqual(fake.workModeWrites, [], '非法取值不得发到设备')
  })

  it('三个实测取值都能写出去', async () => {
    for (const value of FA371_WORK_MODES) {
      const fake = createFake({ workModeReads: [value === 1 ? 2 : 1, value] })
      const result = await serviceWith(fake).writeWorkMode('cam-1', value)
      assert.deepEqual(fake.workModeWrites, [{ work_mode: value }])
      assert.equal(result.applied, true, `${value} 应当被读回`)
    }
  })
})

// ---------------------------------------------------------------------------
// 管理员校验的判定表（这一行是本轮新增的）
// ---------------------------------------------------------------------------

describe('camera work mode: 管理员校验', () => {
  it('切换应用模式要管理员，读不要', () => {
    assert.equal(cameraControlRequiresAdministrator('writeWorkMode'), true)
    assert.equal(cameraControlRequiresAdministrator('readWorkMode'), false)
  })

  it('判定表里这两行确实存在（不是靠 undefined 冒充 false）', () => {
    assert.equal(CAMERA_CONTROL_ADMIN_REQUIRED.writeWorkMode, true)
    assert.equal(CAMERA_CONTROL_ADMIN_REQUIRED.readWorkMode, false)
  })

  it('其余写操作仍然要管理员，读操作仍然不要', () => {
    const writes = [
      'writeRunMode',
      'turnOnDetect',
      'turnOffDetect',
      'setStrategyEnabled',
      'applyModePreset',
      'writeWorkMode'
    ] as const
    for (const action of writes) {
      assert.equal(cameraControlRequiresAdministrator(action), true, `${action} 必须校验管理员`)
    }
    assert.equal(cameraControlRequiresAdministrator('readWorkMode'), false)
    assert.equal(cameraControlRequiresAdministrator('readModePreset'), false)
  })
})

// ---------------------------------------------------------------------------
// 真实 Fa371ApiClient + 假 HTTP 传输层（把发包形状与"只写 work_mode"钉住）
// ---------------------------------------------------------------------------

/** 记录每一次请求（路径 + 方法 + 请求体），并按 handler 作答。 */
function recordingTransport(
  handler: (path: string, method: string, json: unknown) => HttpResponse
): { transport: HttpTransport; requests: Array<{ path: string; method: string; json: unknown }> } {
  const requests: Array<{ path: string; method: string; json: unknown }> = []
  const transport = {
    request: async (options: { url: string; method: string; json?: unknown }) => {
      const path = new URL(options.url).pathname
      requests.push({ path, method: options.method, json: options.json })
      return handler(path, options.method, options.json)
    },
    captureStream: async () => {
      throw new Error('not used')
    }
  } as unknown as HttpTransport
  return { transport, requests }
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

function clientWith(transport: HttpTransport): Fa371ApiClient {
  return new Fa371ApiClient({
    transport,
    baseUrl: '192.168.2.168',
    credential: { username: 'admin', password: '123456' }
  })
}

describe('camera work mode: 真机响应形状（未文档化端点的实际包络）', () => {
  it('GET /system 回 {"msg":"SUCCESS","ret":200,"work_mode":1} 时读到局部放电', async () => {
    const { transport } = recordingTransport((path) =>
      path === '/login'
        ? jsonResponse({ token: 'abc123' })
        : jsonResponse({ msg: 'SUCCESS', ret: 200, work_mode: 1 })
    )

    const read = await new CameraControlService({ clientFor: () => clientWith(transport) }).readWorkMode(
      'cam-1'
    )
    assert.equal(read.available, true)
    assert.equal(read.view.raw, 1)
    assert.equal(read.view.key, 'partial_discharge')
  })

  it('PUT /system 的请求体只有 work_mode 一个字段，且路径就是 /system', async () => {
    const { transport, requests } = recordingTransport((path, method) => {
      if (path === '/login') return jsonResponse({ token: 'abc123' })
      if (path === '/system') {
        // 写请求被"接受"（ret:200），随后重读回 2 —— 与真机实测一致。
        return method === 'PUT'
          ? jsonResponse({ msg: 'SUCCESS', ret: 200 })
          : jsonResponse({ msg: 'SUCCESS', ret: 200, work_mode: 2 })
      }
      return jsonResponse({ msg: 'SUCCESS', ret: 200 })
    })

    const result = await new CameraControlService({
      clientFor: () => clientWith(transport)
    }).writeWorkMode('cam-1', Fa371WorkMode.GasLeak)

    assert.equal(result.applied, true)

    const put = requests.find((request) => request.method === 'PUT')
    assert.ok(put, '必须发出一条 PUT')
    assert.equal(put.path, '/system', '未文档化端点的路径就是 /system')
    // 只发 work_mode：多发一个字段就是拿设备配置赌一次（`/system` 有没有部分字段
    // 更新语义完全没有文档）。
    assert.deepEqual(put.json, { work_mode: 2 })
  })

  it('切换应用模式不碰成像/声学配置：全程没有 /system/acoustic 或 /system/image', async () => {
    const { transport, requests } = recordingTransport((path, method) => {
      if (path === '/login') return jsonResponse({ token: 'abc123' })
      if (path === '/system') {
        return method === 'PUT'
          ? jsonResponse({ msg: 'SUCCESS', ret: 200 })
          : jsonResponse({ msg: 'SUCCESS', ret: 200, work_mode: 3 })
      }
      return jsonResponse({ msg: 'SUCCESS', ret: 200 })
    })

    await new CameraControlService({ clientFor: () => clientWith(transport) }).writeWorkMode(
      'cam-1',
      Fa371WorkMode.MechanicalNoise
    )

    // 这就是"两条通道刻意分开"的运行时证据：切换应用模式**不会**顺带重写客户
    // 现场调好的频带/目标数量/灵敏度。
    //
    // 只允许两类请求：`/login`（会话）与 `/system` 本身（读/写 work_mode）。
    // 注意 `/system/detect_status` 也会出现在这里 —— 它是**登录验证**用的只读端点
    // （`FA371_VERIFY_PATH`），不是配置写入，所以单独放行；下面那条断言把
    // "写入型端点"再单独钉一遍。
    const touched = requests.map((request) => request.path).filter((path) => path !== '/login')
    const writes = requests
      .filter((request) => request.method !== 'GET' && request.path !== '/login')
      .map((request) => request.path)
    assert.deepEqual(writes, ['/system'], '唯一的写入必须就是 /system')
    assert.deepEqual(
      touched.filter((path) => path !== '/system' && path !== '/system/detect_status'),
      [],
      '除 /system 与登录验证端点外不得出现别的请求'
    )
    for (const forbidden of ['/system/acoustic', '/system/image', '/system/video', '/system/leakage']) {
      assert.ok(!touched.includes(forbidden), `切换应用模式不得触碰 ${forbidden}`)
    }
  })

  it('设备应答 ret:200 但读回来还是旧值时 applied 为 false（真客户端的完整链路）', async () => {
    const { transport } = recordingTransport((path, method) => {
      if (path === '/login') return jsonResponse({ token: 'abc123' })
      if (path === '/system') {
        return method === 'PUT'
          ? jsonResponse({ msg: 'SUCCESS', ret: 200 })
          : jsonResponse({ msg: 'SUCCESS', ret: 200, work_mode: 1 })
      }
      return jsonResponse({ msg: 'SUCCESS', ret: 200 })
    })

    const result = await new CameraControlService({
      clientFor: () => clientWith(transport)
    }).writeWorkMode('cam-1', Fa371WorkMode.GasLeak)

    assert.equal(result.after.raw, 1)
    assert.equal(result.applied, false)
  })
})
