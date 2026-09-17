/**
 * 应用模式预设（局部放电 / 气体泄漏 / 机械异响）的测试。
 *
 * 这些用例守的是这个功能**最容易骗人的四个地方**，每一个都有手册依据或真机先例：
 *
 *   1. **频带必须逐字等于手册的起点值**（20–40 / 25–45 / 2–50 kHz）。
 *      厂家自己的 Quick Start 把「切换模式」写成写成像参数
 *      （`docs/reference/api-workflow.txt` 第 55–64 行），定义性参数就是这条频带。
 *   2. **绝不写 `energy_threshold`**。三个模式的推荐值都是同一句话
 *      「Set after observing ambient energy.」（`practical-guide.txt` 第 366 行等），
 *      所以预设里没有这个字段，写请求里也不能出现它 —— 一个凭空写进去的阈值
 *      会让操作员在现场看到一个他自己没设过的判定边界。
 *   3. **成功码不是证据**。本设备实测过 `PUT /alarm_strategy {Switch:1}` 应答
 *      `ret:200` 而字段纹丝不动，所以「设备忽略了这次写」必须被断言成
 *      `applied: false` 且 `after` 仍是旧值。
 *   4. **还原走的是同一条判定**。撤销要把**写之前读到的设备事实**放回去，
 *      读不到的字段不补默认值。
 *
 * 假客户端是结构化类型注入的（`CameraControlOperations`），所以不需要真机、
 * 不需要 Electron、不需要 SQLite。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { AppError, ErrorCodes } from '../src/shared/errors'
import {
  CAMERA_BAND_MAX_UPPER_KHZ,
  CAMERA_BAND_MAX_WIDTH_KHZ,
  CAMERA_MODE_PRESETS,
  CAMERA_MODE_PRESET_FIELD_KEYS,
  CAMERA_MODE_PRESET_IDS,
  CAMERA_MODE_RESTORE_ONLY_FIELD_KEYS,
  CAMERA_PRESETS_REJECTED_BY_DEVICE,
  cameraModeMatchesPreset,
  cameraModePreset,
  cameraModeMatchedPresetIds,
  type CameraModeDeviceView,
  type CameraModePresetId
} from '../src/shared/domain/camera-mode-preset'
import {
  CAMERA_CONTROL_ADMIN_REQUIRED,
  CameraControlService,
  cameraControlRequiresAdministrator,
  type CameraControlOperations
} from '../src/main/services/device/fa371/camera-control-service'
import { Fa371ApiClient } from '../src/main/services/device/fa371/fa371-api-client'
import type { HttpResponse, HttpTransport } from '../src/main/services/device/http-transport'

// ---------------------------------------------------------------------------
// 假客户端
// ---------------------------------------------------------------------------

interface RawAcoustic {
  freq_down_limit?: number
  freq_up_limit?: number
  samplerate?: number
}

interface RawImaging {
  energy_threshold?: number
  target_number?: number
  imaging_sensitivity?: number
  imaging_enhance?: number
}

interface FakeOptions {
  /** 每次读数按顺序取出；用完后回落到最后一个（用最后一个复现"写没生效")。 */
  acousticReads?: RawAcoustic[]
  imagingReads?: RawImaging[]
}

interface Fake {
  operations: CameraControlOperations
  /** 每一次 `PUT` 的真实请求体，按调用顺序。 */
  acousticWrites: RawAcoustic[]
  imagingWrites: RawImaging[]
  /** `setImagingConfig` 的 `targetCount` 选项（目标数量的键名由客户端决定）。 */
  imagingTargetCounts: Array<number | undefined>
}

function createFake(options: FakeOptions = {}): Fake {
  const acousticReads = options.acousticReads ?? [{}]
  const imagingReads = options.imagingReads ?? [{}]

  const acousticWrites: RawAcoustic[] = []
  const imagingWrites: RawImaging[] = []
  const imagingTargetCounts: Array<number | undefined> = []

  /**
   * 读数按**每个端点的读取次数**取出，而不是按"写了几次"推。
   *
   * 一次设备真的改了配置要同时改声学与成像两份，所以两个端点在整段流程里的
   * 读取次数天然一致（读→写→重读 = 各 2 次）。用次数索引最不容易出错：
   * 写请求不参与索引计算，`acceptWrite: false` 时状态不变，重读自然还是旧值。
   */
  let acousticReadsDone = 0
  let imagingReadsDone = 0

  const operations: CameraControlOperations = {
    async getAcousticConfig() {
      const state = acousticReads[Math.min(acousticReadsDone, acousticReads.length - 1)]
      acousticReadsDone += 1
      return { ...state } as never
    },
    async setAcousticConfig(body) {
      acousticWrites.push({ ...body })
      return { ret: 200, msg: 'SUCCESS' }
    },
    async getImagingConfig() {
      const state = imagingReads[Math.min(imagingReadsDone, imagingReads.length - 1)]
      imagingReadsDone += 1
      return { ...state } as never
    },
    async setImagingConfig(body, opts) {
      imagingWrites.push({ ...body })
      imagingTargetCounts.push(opts?.targetCount)
      return { ret: 200, msg: 'SUCCESS' }
    },
    async getRunMode() {
      return { run_mode: 1, ret: 200, msg: 'SUCCESS' }
    },
    async setRunMode() {
      return { ret: 200, msg: 'SUCCESS' }
    },
    async getDetectStatus() {
      return { detect_status: 0 } as never
    },
    async startDetection() {
      return { detect_id: 1, ret: 200, msg: 'SUCCESS' }
    },
    async stopDetection() {
      return undefined
    },
    async getEnabledAlarmStrategies() {
      return { alarm_strategy_list: [], ret: 200, msg: 'SUCCESS' }
    },
    async setAlarmStrategyEnabled() {
      return { ret: 200, msg: 'SUCCESS' }
    },
    async getVersionInfo() {
      return { ret: 200, msg: 'SUCCESS' }
    },
    async getBasicInfo() {
      return { ret: 200, msg: 'SUCCESS' }
    },
    // 应用模式（`GET`/`PUT /system`，端点未文档化）有专门的用例文件
    // （`camera-work-mode.test.ts`），而且**故意**不被预设路径调用：本文件守的正是
    // "写成像参数不碰 work_mode" 这条边界，所以这两个方法在这里只补齐形状。
    async getWorkMode() {
      return { work_mode: 1, ret: 200, msg: 'SUCCESS' }
    },
    async setWorkMode() {
      return { ret: 200, msg: 'SUCCESS' }
    }
  }

  return { operations, acousticWrites, imagingWrites, imagingTargetCounts }
}

function serviceWith(fake: Fake): CameraControlService {
  return new CameraControlService({ clientFor: () => fake.operations })
}

/** 一条"现在就是这个预设"的读数。 */
function readingFor(presetId: CameraModePresetId): { acoustic: RawAcoustic; imaging: RawImaging } {
  const preset = cameraModePreset(presetId)
  assert.ok(preset, `预设 ${presetId} 必须存在`)
  return {
    acoustic: {
      freq_down_limit: preset.values.band.lowerKhz,
      freq_up_limit: preset.values.band.upperKhz
    },
    imaging: { target_number: preset.values.targetCount, imaging_enhance: 0 }
  }
}

// ---------------------------------------------------------------------------
// 预设数据：逐字对照手册
// ---------------------------------------------------------------------------

describe('应用模式预设：数据与手册一致', () => {
  const DOCUMENTED: Record<CameraModePresetId, { lower: number; upper: number; citation: string }> = {
    partial_discharge: { lower: 20, upper: 40, citation: '§4.1.2' },
    gas_leak: { lower: 25, upper: 45, citation: '§4.2.2' },
    mechanical: { lower: 2, upper: 50, citation: '§4.3.2' }
  }

  it('每个预设映射到手册写的那条成像频带', () => {
    for (const id of CAMERA_MODE_PRESET_IDS) {
      const preset = cameraModePreset(id)
      assert.ok(preset, `${id} 必须在预设表里`)
      assert.equal(preset.values.band.lowerKhz, DOCUMENTED[id].lower, `${id} 下限`)
      assert.equal(preset.values.band.upperKhz, DOCUMENTED[id].upper, `${id} 上限`)
      // 单位是手册的 kHz，不做任何换算：数值只可能是手册里那几个整数。
      assert.ok(Number.isInteger(preset.values.band.lowerKhz), `${id} 下限必须是整数 kHz`)
      assert.ok(Number.isInteger(preset.values.band.upperKhz), `${id} 上限必须是整数 kHz`)
    }
  })

  it('每个预设都带上手册出处，且指向正确的章节', () => {
    for (const id of CAMERA_MODE_PRESET_IDS) {
      const preset = cameraModePreset(id)
      assert.ok(preset)
      assert.match(preset.citation, /practical-guide\.txt/, `${id} 的出处必须点名手册`)
      assert.ok(
        preset.citation.includes(DOCUMENTED[id].citation),
        `${id} 的出处必须指向 ${DOCUMENTED[id].citation}：${preset.citation}`
      )
    }
  })

  it('频带满足手册的边界，且机械异响那条按"设备会拒绝"处理', () => {
    // 手册第 172 行给的是「可调 2~65 kHz，上下限之差 ≤20 kHz」。
    // **真机实测（2026-09-15）纠正了上限、确认了宽度**：
    //   2–22 / 20–40 / 25–45 / 70–90 / 80–100（宽都是 20）全部被接受，
    //   其中 80–100 证明上限可以到 100 kHz（与 samplerate 200000 的奈奎斯特一致）；
    //   2–50（宽 48）被拒：{"msg":"[HTTP] Set acousic config error","ret":400}。
    // 所以设备强制的是**宽度 ≤20 kHz**，而上限是 100 kHz 而不是手册写的 65 kHz。
    // 机械异响的推荐频带 2–50 kHz 因此**必然被设备拒绝**：本软件仍然照抄手册的值
    // （不偷偷改数字让它"看起来合法"），但把它登记为设备不接受，界面据此禁用。
    for (const preset of CAMERA_MODE_PRESETS) {
      assert.ok(preset.values.band.lowerKhz >= 2, `${preset.id} 下限不得低于 2 kHz`)
      assert.ok(
        preset.values.band.upperKhz <= CAMERA_BAND_MAX_UPPER_KHZ,
        `${preset.id} 上限不得高于实测上限 ${CAMERA_BAND_MAX_UPPER_KHZ} kHz`
      )
      assert.ok(
        preset.values.band.upperKhz > preset.values.band.lowerKhz,
        `${preset.id} 上限必须大于下限`
      )
    }

    const widthOf = (id: string): number => {
      const band = cameraModePreset(id as CameraModePresetId)!.values.band
      return band.upperKhz - band.lowerKhz
    }

    // 每一个"设备接受"的预设都必须满足实测宽度约束；被登记的例外必须真的超宽，
    // 否则这个清单就会变成一张随便加名字的白名单。
    for (const preset of CAMERA_MODE_PRESETS) {
      const rejected = CAMERA_PRESETS_REJECTED_BY_DEVICE.includes(preset.id)
      const width = widthOf(preset.id)
      if (rejected) {
        assert.ok(
          width > CAMERA_BAND_MAX_WIDTH_KHZ,
          `${preset.id} 被登记为设备拒绝，宽度 ${width} 却没有超过 ${CAMERA_BAND_MAX_WIDTH_KHZ}`
        )
      } else {
        assert.ok(
          width <= CAMERA_BAND_MAX_WIDTH_KHZ,
          `${preset.id} 宽度 ${width} 超出设备强制上限 ${CAMERA_BAND_MAX_WIDTH_KHZ} kHz`
        )
      }
    }

    // 局部放电 20–40 与气体泄漏 25–45：宽度正好 20 kHz，在边界上，且真机接受过。
    assert.equal(cameraModePreset('partial_discharge')?.values.band.upperKhz, 40)
    assert.equal(cameraModePreset('gas_leak')?.values.band.upperKhz, 45)
    assert.deepEqual([...CAMERA_PRESETS_REJECTED_BY_DEVICE], ['mechanical'])
    assert.equal(widthOf('mechanical'), 48)
  })

  it('三个预设的目标数量都是 1', () => {
    for (const preset of CAMERA_MODE_PRESETS) {
      assert.equal(preset.values.targetCount, 1, `${preset.id} 的目标数量`)
    }
  })

  it('成像灵敏度不给数字：手册只写了档位词 Low', () => {
    // `[0,2]` 里哪个整数等于 Low，手册没写，真机也没验过 —— 不猜。
    for (const preset of CAMERA_MODE_PRESETS) {
      assert.equal(
        preset.values.imagingSensitivity,
        undefined,
        `${preset.id} 不得把 Low 翻成一个猜出来的整数`
      )
    }
  })

  it('预设可以写的字段清单里没有 energy_threshold', () => {
    assert.ok(!CAMERA_MODE_PRESET_FIELD_KEYS.includes('energy_threshold' as never))
    assert.deepEqual([...CAMERA_MODE_RESTORE_ONLY_FIELD_KEYS], ['energy_threshold'])
  })

  it('未知预设 id 取不到预设', () => {
    assert.equal(cameraModePreset('nope'), undefined)
  })
})

// ---------------------------------------------------------------------------
// 读回当前状态 / 「已经在这个模式」
// ---------------------------------------------------------------------------

describe('应用模式预设：读当前状态', () => {
  it('把设备回的频带与目标数量归一化到视图里', async () => {
    const fake = createFake({
      acousticReads: [{ freq_down_limit: 20, freq_up_limit: 40, samplerate: 96000 }],
      imagingReads: [{ target_number: 1, energy_threshold: -30, imaging_enhance: 0 }]
    })
    const read = await serviceWith(fake).readModePreset('cam-1')

    assert.equal(read.view.lowerKhz, 20)
    assert.equal(read.view.upperKhz, 40)
    assert.equal(read.view.targetCount, 1)
    assert.equal(read.view.energyThreshold, -30)
    assert.equal(read.view.imagingEnhance, 0)
    assert.equal(read.view.targetCountKeyUsed, 'target_number')
  })

  it('设备当前等于局部放电预设时，报出命中的预设', async () => {
    const reading = readingFor('partial_discharge')
    const fake = createFake({ acousticReads: [reading.acoustic], imagingReads: [reading.imaging] })
    const read = await serviceWith(fake).readModePreset('cam-1')
    assert.deepEqual(read.matchedPresetIds, ['partial_discharge'])
  })

  it('三个预设各自的读数都能被认出来', () => {
    for (const id of CAMERA_MODE_PRESET_IDS) {
      const reading = readingFor(id)
      const view: CameraModeDeviceView = {
        lowerKhz: reading.acoustic.freq_down_limit,
        upperKhz: reading.acoustic.freq_up_limit,
        targetCount: reading.imaging.target_number,
        imagingEnhance: reading.imaging.imaging_enhance,
        targetCountKeyUsed: 'target_number'
      }
      const preset = cameraModePreset(id)
      assert.ok(preset)
      assert.equal(cameraModeMatchesPreset(view, preset), true, `${id} 应判为已在此模式`)
      assert.ok(cameraModeMatchedPresetIds(view).includes(id), `${id} 应出现在命中列表里`)
    }
  })

  it('参数被现场手调过（频带不符）时不算命中任何预设', async () => {
    const fake = createFake({
      acousticReads: [{ freq_down_limit: 10, freq_up_limit: 30 }],
      imagingReads: [{ target_number: 1, imaging_enhance: 0 }]
    })
    const read = await serviceWith(fake).readModePreset('cam-1')
    assert.deepEqual(read.matchedPresetIds, [])
  })

  it('目标数量读不到时不判命中：读不到不等于匹配', () => {
    const view: CameraModeDeviceView = {
      lowerKhz: 20,
      upperKhz: 40,
      targetCountKeyUsed: 'absent'
    }
    const preset = cameraModePreset('partial_discharge')
    assert.ok(preset)
    assert.equal(cameraModeMatchesPreset(view, preset), false)
  })
})

// ---------------------------------------------------------------------------
// 应用预设：只写声明的字段 + 写后重读
// ---------------------------------------------------------------------------

describe('应用模式预设：写什么', () => {
  it('局部放电预设只写 20–40 kHz 与目标数量 1', async () => {
    const fake = createFake({
      acousticReads: [{ freq_down_limit: 25, freq_up_limit: 45, samplerate: 96000 }],
      imagingReads: [{ target_number: 2, energy_threshold: -30, imaging_sensitivity: 2, imaging_enhance: 1 }]
    })
    const result = await serviceWith(fake).applyModePreset('cam-1', 'partial_discharge')

    assert.deepEqual(fake.acousticWrites, [{ freq_down_limit: 20, freq_up_limit: 40 }])
    assert.deepEqual(fake.imagingWrites, [{ imaging_enhance: 0 }])
    assert.deepEqual(fake.imagingTargetCounts, [1], '目标数量走客户端的候选键机制')
    assert.equal(result.kind, 'preset')
    assert.equal(result.presetId, 'partial_discharge')
  })

  it('每个预设写出去的声学字段都等于手册频带', async () => {
    const expected: Record<CameraModePresetId, RawAcoustic> = {
      partial_discharge: { freq_down_limit: 20, freq_up_limit: 40 },
      gas_leak: { freq_down_limit: 25, freq_up_limit: 45 },
      mechanical: { freq_down_limit: 2, freq_up_limit: 50 }
    }
    for (const id of CAMERA_MODE_PRESET_IDS) {
      const fake = createFake({
        acousticReads: [{ freq_down_limit: 30, freq_up_limit: 32 }],
        imagingReads: [{ target_number: 3 }]
      })
      await serviceWith(fake).applyModePreset('cam-1', id)
      assert.deepEqual(fake.acousticWrites, [expected[id]], `${id} 的声学请求体`)
    }
  })

  it('预设从不写 energy_threshold（两个请求体里都不能出现）', async () => {
    for (const id of CAMERA_MODE_PRESET_IDS) {
      const fake = createFake({
        acousticReads: [{ freq_down_limit: 30, freq_up_limit: 32 }],
        // 设备本来有一个阈值 —— 预设不得把它搬来搬去或覆盖掉。
        imagingReads: [{ target_number: 2, energy_threshold: -30 }]
      })
      const result = await serviceWith(fake).applyModePreset('cam-1', id)

      for (const body of fake.imagingWrites) {
        assert.ok(
          !('energy_threshold' in body),
          `${id} 不得写 energy_threshold，实际发了 ${JSON.stringify(body)}`
        )
      }
      assert.ok(
        !result.imagingFields.some((field) => field.field === 'energy_threshold'),
        `${id} 的结果里不得出现 energy_threshold 字段`
      )
      assert.equal(result.requested.imaging.energyThreshold, undefined, `${id} 的请求不得带阈值`)
    }
  })

  it('只写预设声明的字段：灵敏度没声明就不发', async () => {
    const fake = createFake({
      acousticReads: [{ freq_down_limit: 30, freq_up_limit: 32 }],
      imagingReads: [{ target_number: 1 }]
    })
    await serviceWith(fake).applyModePreset('cam-1', 'gas_leak')
    const body = fake.imagingWrites[0] ?? {}
    assert.ok(!('imaging_sensitivity' in body))
  })

  it('未知预设 id 拒绝写入，一个请求都不发', async () => {
    const fake = createFake({})
    await assert.rejects(
      () => serviceWith(fake).applyModePreset('cam-1', 'nope' as never),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, ErrorCodes.VALIDATION_ERROR)
        return true
      }
    )
    assert.deepEqual(fake.acousticWrites, [])
    assert.deepEqual(fake.imagingWrites, [])
  })
})

// ---------------------------------------------------------------------------
// 写后重读：成功码不是证据（本功能的核心）
// ---------------------------------------------------------------------------

describe('应用模式预设：成功码不是证据', () => {
  it('设备接受写入时逐字段 applied 为 true，after 是重读值', async () => {
    const fake = createFake({
      acousticReads: [
        { freq_down_limit: 25, freq_up_limit: 45 },
        { freq_down_limit: 20, freq_up_limit: 40 }
      ],
      imagingReads: [{ target_number: 2 }, { target_number: 1, imaging_enhance: 0 }]
    })
    const result = await serviceWith(fake).applyModePreset('cam-1', 'partial_discharge')

    assert.equal(result.before.lowerKhz, 25)
    assert.equal(result.after.lowerKhz, 20)
    assert.equal(result.applied, true)
    assert.equal(result.matches, true)
    assert.deepEqual(
      result.acousticFields.map((field) => field.field),
      ['freq_down_limit', 'freq_up_limit']
    )
    for (const field of [...result.acousticFields, ...result.imagingFields]) {
      assert.equal(field.applied, true, `${field.field} 应判为生效`)
      assert.equal(field.after, field.requested)
    }
  })

  it('设备应答 ret:200 却忽略写入时，after 仍是旧值且 applied 为 false', async () => {
    // 真机先例：`PUT /alarm_strategy {Switch:1}` → `ret:200`，读回来没变。
    // 只给一份读数：重读拿到的还是它，正是"设备没改"。
    const fake = createFake({
      acousticReads: [{ freq_down_limit: 25, freq_up_limit: 45 }],
      imagingReads: [{ target_number: 2 }]
    })
    const result = await serviceWith(fake).applyModePreset('cam-1', 'partial_discharge')

    assert.deepEqual(fake.acousticWrites, [{ freq_down_limit: 20, freq_up_limit: 40 }], '请求确实发出去了')
    assert.equal(result.after.lowerKhz, 25, 'after 必须是设备说的，不是请求值')
    assert.equal(result.after.upperKhz, 45)
    assert.equal(result.applied, false, '成功码不得被当成生效')
    assert.equal(result.matches, false)

    const lower = result.acousticFields.find((field) => field.field === 'freq_down_limit')
    assert.ok(lower)
    assert.equal(lower.requested, 20)
    assert.equal(lower.before, 25)
    assert.equal(lower.after, 25)
    assert.equal(lower.applied, false)
  })

  it('只有一半字段生效时逐字段如实区分（不是一句笼统的成功）', async () => {
    // 声学写进去了、成像没进去：设备把频带改了却没动目标数量。
    const fake = createFake({})
    let step = 0
    fake.operations.getAcousticConfig = async () => {
      const reads = [
        { freq_down_limit: 25, freq_up_limit: 45 },
        { freq_down_limit: 20, freq_up_limit: 40 }
      ]
      return reads[Math.min(step, reads.length - 1)] as never
    }
    fake.operations.setAcousticConfig = async (body) => {
      fake.acousticWrites.push({ ...body })
      step = 1
      return { ret: 200, msg: 'SUCCESS' }
    }
    fake.operations.getImagingConfig = async () => ({ target_number: 2 }) as never
    fake.operations.setImagingConfig = async (body, opts) => {
      fake.imagingWrites.push({ ...body })
      fake.imagingTargetCounts.push(opts?.targetCount)
      return { ret: 200, msg: 'SUCCESS' }
    }

    const result = await serviceWith(fake).applyModePreset('cam-1', 'partial_discharge')
    assert.equal(result.applied, false, '有字段没生效就不能声称整体生效')
    assert.ok(result.acousticFields.every((field) => field.applied), '频带确实变了')
    assert.ok(result.imagingFields.every((field) => !field.applied), '目标数量没变')
  })

  it('已经在这个模式时仍然读得到读数（界面据此说"已在此场景"）', async () => {
    const reading = readingFor('gas_leak')
    const fake = createFake({ acousticReads: [reading.acoustic], imagingReads: [reading.imaging] })
    const read = await serviceWith(fake).readModePreset('cam-1')
    assert.deepEqual(read.matchedPresetIds, ['gas_leak'])
    assert.equal(read.view.lowerKhz, 25)
    assert.equal(read.view.upperKhz, 45)
  })
})

// ---------------------------------------------------------------------------
// 还原（撤销）
// ---------------------------------------------------------------------------

describe('应用模式预设：还原', () => {
  it('把写之前读到的设备值原样写回去', async () => {
    const fake = createFake({
      acousticReads: [
        { freq_down_limit: 25, freq_up_limit: 45, samplerate: 96000 },
        { freq_down_limit: 20, freq_up_limit: 40, samplerate: 96000 },
        { freq_down_limit: 25, freq_up_limit: 45, samplerate: 96000 }
      ],
      imagingReads: [
        { target_number: 2, energy_threshold: -30, imaging_sensitivity: 2, imaging_enhance: 1 },
        { target_number: 1, energy_threshold: -30, imaging_sensitivity: 2, imaging_enhance: 0 },
        { target_number: 2, energy_threshold: -30, imaging_sensitivity: 2, imaging_enhance: 1 }
      ]
    })
    const service = serviceWith(fake)
    const applied = await service.applyModePreset('cam-1', 'partial_discharge')
    assert.equal(applied.applied, true)

    // 还原值就是从 `before`（设备原来的事实）里取出来的那几个数字。
    const restored = await service.restoreModeValues('cam-1', {
      acoustic: {
        ...(applied.before.lowerKhz !== undefined ? { lowerKhz: applied.before.lowerKhz } : {}),
        ...(applied.before.upperKhz !== undefined ? { upperKhz: applied.before.upperKhz } : {})
      },
      imaging: {
        ...(applied.before.targetCount !== undefined
          ? { targetCount: applied.before.targetCount }
          : {}),
        ...(applied.before.imagingEnhance !== undefined
          ? { imagingEnhance: applied.before.imagingEnhance }
          : {}),
        // 阈值只可能从"写之前读到的值"来 —— 预设路径永远不会传它。
        ...(applied.before.energyThreshold !== undefined
          ? { energyThreshold: applied.before.energyThreshold }
          : {})
      }
    })

    assert.equal(restored.kind, 'restore')
    assert.deepEqual(fake.acousticWrites[1], { freq_down_limit: 25, freq_up_limit: 45 })
    assert.deepEqual(fake.imagingWrites[1], {
      energy_threshold: -30,
      imaging_enhance: 1
    })
    assert.deepEqual(fake.imagingTargetCounts, [1, 2])
    assert.equal(restored.after.lowerKhz, 25)
    assert.equal(restored.after.targetCount, 2)
    assert.equal(restored.applied, true)
    assert.equal(restored.matches, false, '还原之后不该还声称命中某个预设')
  })

  it('读不到的字段不补默认值：还原请求里就没有它', async () => {
    const fake = createFake({
      acousticReads: [{ freq_down_limit: 20, freq_up_limit: 40 }],
      imagingReads: [{ target_number: 1 }]
    })
    const service = serviceWith(fake)
    await service.restoreModeValues('cam-1', {
      acoustic: { lowerKhz: 2, upperKhz: 50 },
      // 目标数量与阈值都没读到 → 一个都不发。
      imaging: {}
    })

    assert.deepEqual(fake.acousticWrites, [{ freq_down_limit: 2, freq_up_limit: 50 }])
    assert.deepEqual(fake.imagingWrites, [], '没有成像字段可还原时不发这个 PUT')
    assert.deepEqual(fake.imagingTargetCounts, [])
  })

  it('一个数值都没有的还原请求被拒绝，不发任何请求', async () => {
    const fake = createFake({})
    await assert.rejects(
      () => serviceWith(fake).restoreModeValues('cam-1', { acoustic: {}, imaging: {} }),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, ErrorCodes.VALIDATION_ERROR)
        return true
      }
    )
    assert.deepEqual(fake.acousticWrites, [])
    assert.deepEqual(fake.imagingWrites, [])
  })

  it('还原同样写后重读：设备忽略还原时 applied 为 false', async () => {
    const fake = createFake({
      acousticReads: [{ freq_down_limit: 10, freq_up_limit: 12 }],
      imagingReads: [{}]
    })
    const result = await serviceWith(fake).restoreModeValues('cam-1', {
      acoustic: { lowerKhz: 20, upperKhz: 40 },
      imaging: {}
    })
    assert.deepEqual(fake.acousticWrites, [{ freq_down_limit: 20, freq_up_limit: 40 }])
    assert.equal(result.after.lowerKhz, 10, 'after 仍是设备说的旧值')
    assert.equal(result.applied, false)
  })
})

// ---------------------------------------------------------------------------
// 管理员校核表
// ---------------------------------------------------------------------------

describe('应用模式预设：管理员校验', () => {
  it('读预设不要管理员，应用预设要', () => {
    assert.equal(cameraControlRequiresAdministrator('readModePreset'), false)
    assert.equal(cameraControlRequiresAdministrator('applyModePreset'), true)
  })

  it('判定表覆盖了新动作，没有遗漏的键', () => {
    const declared = Object.keys(CAMERA_CONTROL_ADMIN_REQUIRED).sort()
    assert.ok(declared.includes('readModePreset'))
    assert.ok(declared.includes('applyModePreset'))
  })
})

// ---------------------------------------------------------------------------
// 真实 Fa371ApiClient + 假 HTTP 传输层
// ---------------------------------------------------------------------------

function transportFor(
  handler: (path: string, method: string, body: unknown) => HttpResponse
): HttpTransport {
  return {
    request: async (options) => {
      const path = new URL(options.url).pathname
      return handler(path, options.method, options.json)
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

describe('应用模式预设：真实客户端上的请求形状', () => {
  it('PUT /system/acoustic 发的是 freq_down_limit / freq_up_limit（kHz，原样）', async () => {
    const writes: Array<{ path: string; body: unknown }> = []
    const transport = transportFor((path, method, body) => {
      if (path === '/login') return jsonResponse({ token: 'abc123' })
      if (path === '/system/detect_status') return jsonResponse({ detect_status: 0 })
      if (method === 'PUT') writes.push({ path, body })
      if (path === '/system/acoustic') {
        return jsonResponse({
          freq_down_limit: 20,
          freq_up_limit: 40,
          ret: 200,
          msg: 'SUCCESS'
        })
      }
      return jsonResponse({ target_number: 1, ret: 200, msg: 'SUCCESS' })
    })

    const client = new Fa371ApiClient({
      transport,
      baseUrl: '192.168.2.168',
      credential: { username: 'admin', password: '123456' }
    })
    await new CameraControlService({ clientFor: () => client }).applyModePreset(
      'cam-1',
      'partial_discharge'
    )

    const acoustic = writes.find((write) => write.path === '/system/acoustic')
    assert.ok(acoustic, '声学配置必须被写过')
    assert.deepEqual(acoustic.body, { freq_down_limit: 20, freq_up_limit: 40 })

    const imaging = writes.find((write) => write.path === '/system/image')
    assert.ok(imaging, '成像配置必须被写过')
    // 键名歧义（§8.3 C2）由客户端按 `DEFAULT_FA371_IMAGING_TARGET_KEY` 决定，
    // 默认是示例 JSON 里的 `target_number`。
    assert.deepEqual(imaging.body, { imaging_enhance: 0, target_number: 1 })
    assert.ok(!('energy_threshold' in (imaging.body as Record<string, unknown>)))
  })
})
