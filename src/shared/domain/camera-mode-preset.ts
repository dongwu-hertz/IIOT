/**
 * 声学相机（FA371）**应用模式预设**的领域模型。
 *
 * ---------------------------------------------------------------------------
 * 为什么单独一个模块，而不是并进 `camera-control.ts`
 * ---------------------------------------------------------------------------
 * `camera-control.ts` 管的是**控制状态**（检测模式、检测启停、启用中的策略、
 * 维护能力），它的硬规则是「不放人类可读文案、只给稳定 KEY」。
 * 本文件是**参数预设数据**：它是主进程写设备时要照抄的数值表，渲染层要按 id
 * 渲染的三个按钮，测试要逐字比对的用例表 —— 三者共用同一份事实。
 * 预设的 `citation` 又必须是一句**人话**（手册出处 + 原文数字），它与控制状态那套
 * 「原因只给 KEY」的分工不同，所以不塞进同一个文件里。
 *
 * ---------------------------------------------------------------------------
 * 这个功能到底在做什么（手册原话）
 * ---------------------------------------------------------------------------
 * 设备自身的 `work_mode`（这台机器**在做哪种应用**：局部放电 / 气体泄漏 / 机械异响）
 * 与本文件**无关**，本文件里的任何路径都不会写它。它由另一条通道负责
 * （`getWorkMode` / `setWorkMode`，端点 `GET`/`PUT /system`）。
 *
 * 更正（真机实测，`192.168.110.235`）：本文件此前写着「`work_mode` 不碰：只能通过
 * 手册未收录的 `GET /system` 读到，设备自带 Web 界面里没有任何 setter，两份手册
 * 都写着改它要联系厂家」—— 前两句仍然对（端点确实无手册、设备自家 UI 确实没有
 * 控件），但**"写不动"这一句已被证伪**：`PUT /system {"work_mode":N}` 实测有效
 * （`1`/`2`/`3` 三值都生效）。所以"切换机型"现在是本软件做得到的事，只是它在
 * **另一个通道**里，不在本文件。
 *
 * 边界仍然照旧、而且是双向的：本文件（成像参数预设）不写 `work_mode`，
 * 那条通道也不写成像参数。
 *
 * 所谓「切换应用模式」在厂家自己的 API 目录里就是**写成像参数**
 * （`docs/reference/api-workflow.txt` 第 55–64 行的 Quick Start）：
 *
 *   Login Authentication (POST /login)
 *   Enable alarm strategy ID=1 (PUT /alarm_strategy)
 *   **Adjust device imaging parameters; set the imaging frequency band to 20 kHz–40 kHz
 *     (PUT /system/acoustic)**
 *   Start detection (POST /turn_on_detect); returns the alarm-record ID.
 *   ...
 *
 * 定义性参数就是**成像频带**（`freq_down_limit` / `freq_up_limit`，单位 kHz，
 * 手册定义如此，本文件**不做任何换算**）。起点值来自
 * `docs/reference/practical-guide.txt` §4.1.2 / §4.2.2 / §4.3.2。
 *
 * ---------------------------------------------------------------------------
 * 「阈值不编」
 * ---------------------------------------------------------------------------
 * 三个模式的 **Imaging Threshold** 在手册里的推荐值都是同一句话：
 * 「Set after observing ambient energy.」（现场看环境能量再定，见
 * `practical-guide.txt` 第 366–368 / 449–451 / 523–525 行）。
 * 所以预设里**没有** `energyThreshold` 这个字段，写设备时也**绝不**碰
 * `energy_threshold` —— 一个凭空写进去的阈值会让操作员在现场看到一个
 * 他自己没设过的判定边界。
 *
 * ---------------------------------------------------------------------------
 * 灵敏度 / 成像增强：手册写的是档位词，不是数字
 * ---------------------------------------------------------------------------
 * 手册的**推荐值表**给的是 `Low` / `Off`，而接口字段是 `[0,2]` 的整数
 * （`docs/reference/FA371-api-spec.md` 第 265–266 行）。哪一个整数等于 `Low`
 * **手册没有写**，也没有在真机上验证过 —— 所以本文件不把 `Low` 翻成数字：
 *   - `enhancePreset: 0` 只在手册自己写明「`0` 表示关闭」时给出
 *     （即局部放电模式的 `Off`，见 `FA371-api-spec.md` 第 266 行）；
 *   - 其余一律缺省 → 服务只写预设声明的字段，**不猜**。
 */

import type { Fa371AcousticConfig, Fa371ImagingConfig } from './fa371'

/** 三个应用模式的稳定 id（渲染层用它翻译成 `cameraControlUi.preset*`）。 */
export const CAMERA_MODE_PRESET_IDS = ['partial_discharge', 'gas_leak', 'mechanical'] as const

export type CameraModePresetId = (typeof CAMERA_MODE_PRESET_IDS)[number]

/** 声学频带，单位 **kHz**（手册单位，原样保留，不做换算）。 */
export interface CameraModeAcousticBand {
  /** 频带下限（`freq_down_limit`）。 */
  lowerKhz: number
  /** 频带上限（`freq_up_limit`）。 */
  upperKhz: number
}

/**
 * 预设里**声明**的数值（没声明的字段就是不写）。
 *
 * 键名是域模型的名字，不是线上键名 —— 线上拼写只出现在 `fa371/dto.ts` 与服务里。
 */
export interface CameraModePresetValues {
  band: CameraModeAcousticBand
  /** 检测目标数量。 */
  targetCount: number
  /** 成像滤波灵敏度档位。**手册没给数字，所以一直是缺省的**。 */
  imagingSensitivity?: number
  /** 成像增强：`0` = off。 */
  imagingEnhance?: number
}

export interface CameraModePreset {
  id: CameraModePresetId
  /**
   * 手册出处与原文，逐字引用。
   *
   * 保留它是为了**可追溯**：操作员问「这个 25–45 是哪来的」，答案就在界面的
   * title 里，而不是某个人的记忆里。
   */
  citation: string
  values: CameraModePresetValues
}

/**
 * 三个应用模式的起点参数。
 *
 * 逐字对照 `docs/reference/practical-guide.txt`：
 *
 * | 模式 | 成像频带 | 目标数 | 灵敏度 | 增强 | 出处 |
 * |---|---|---|---|---|---|
 * | 局部放电 | 20–40 kHz | 1 | Low | Off | §4.1.2（第 356–380 行） |
 * | 气体泄漏 | 25–45 kHz | 1 | Low | Off | §4.2.2（第 439–463 行） |
 * | 机械异响 | 2–50 kHz | 1 | Low | Disabled | §4.3.2（第 512–537 行） |
 *
 * 手册第 172 行给出频带的合法边界（2~65 kHz，上下限之差 2~20 kHz，上限>下限）。
 *
 * **2026-09-15 真机实测（比手册的 65 kHz 更重要）：设备强制的是"宽度"，不是上限频率。**
 *
 * ```
 * 2–22   宽 20  ✅        20–40  宽 20  ✅        25–45  宽 20  ✅
 * 70–90  宽 20  ✅        80–100 宽 20  ✅   ← 100 kHz 上限是真的
 * 2–50   宽 48  ❌  {"msg":"[HTTP] Set acousic config error","ret":400}
 * ```
 *
 * 规则：`freq_up_limit − freq_down_limit ≤ 20 kHz`，频带可整体放到最高 **100 kHz**。
 * 100 kHz 与硬件自洽：设备上报 `samplerate: 200000`，奈奎斯特正好是一半。
 *
 * 所以 **机械异响的 2–50 kHz（宽 48）会被设备拒绝**。手册把它写成机械异音的推荐频带
 * （§4.3.2 第 519–520 行，第 521 行还说明摩擦噪声出现在 20–50 kHz），但设备不接受它。
 * 本软件仍然**照抄手册的值**，不偷偷把 50 改成 22 让它"看起来合法"；代价是这个预设
 * 点下去会失败，所以它被列进 {@link CAMERA_PRESETS_REJECTED_BY_DEVICE}，
 * 由界面按"设备不接受"处理，而不是发一个必然失败的请求。
 * 完整实测见 `docs/FA371-API-DELTA.md` §17.3。
 */

/**
 * 已被真机证实会被设备拒绝的预设 id。
 *
 * 存在这个清单是因为"手册推荐"与"设备接受"是两件事：机械异响的推荐频带宽度 48 kHz，
 * 而设备强制宽度 ≤20 kHz。界面据此禁用该预设并写出原因，而不是让操作员点一个必然失败的按钮。
 */
export const CAMERA_PRESETS_REJECTED_BY_DEVICE: readonly string[] = ['mechanical']

/** 设备实测强制约束：频带宽度上限（kHz）与频带上限（kHz）。 */
export const CAMERA_BAND_MAX_WIDTH_KHZ = 20
export const CAMERA_BAND_MAX_UPPER_KHZ = 100
export const CAMERA_MODE_PRESETS: readonly CameraModePreset[] = [
  {
    id: 'partial_discharge',
    citation:
      'practical-guide.txt §4.1.2 局部放电：Imaging Frequency Band 20–40 kHz；Number of Detection Targets 1；Imaging Sensitivity Low；Imaging Enhancement Off',
    values: {
      band: { lowerKhz: 20, upperKhz: 40 },
      targetCount: 1,
      // 灵敏度只写手册给的档位词「Low」，不翻成 [0,2] 里的某个整数。
      // 增强 Off 可以写：`FA371-api-spec.md` 第 266 行明写「[0,2]，0 表示关闭」。
      imagingEnhance: 0
    }
  },
  {
    id: 'gas_leak',
    citation:
      'practical-guide.txt §4.2.2 气体泄漏：Imaging Frequency Band 25–45 kHz；Number of Detection Targets 1；Imaging Sensitivity Low；Imaging Enhancement Off',
    values: {
      band: { lowerKhz: 25, upperKhz: 45 },
      targetCount: 1,
      // 同上：灵敏度是档位词，不猜数字。§4.2.2 的 Imaging Enhancement 写 Off
      // （说明列另有一句「Can be enabled for tiny-leak detection」，那是可选项，
      // 起点值仍是 Off），所以这里给 0 不给出别的档位。
      imagingEnhance: 0
    }
  },
  {
    id: 'mechanical',
    citation:
      'practical-guide.txt §4.3.2 机械异响：Imaging Frequency Band 2–50 kHz；Number of Detection Targets 1；Imaging Sensitivity Low；Imaging Enhancement Disabled',
    values: {
      band: { lowerKhz: 2, upperKhz: 50 },
      targetCount: 1,
      // 「Disabled」→ 0（同一个键、同一个含义，手册自己在 §5.1.4 字段表里
      // 把 0 写成 off）。灵敏度同上：不猜。
      imagingEnhance: 0
    }
  }
]

/** 按 id 取预设；未知 id 返回 `undefined`（调用方据此拒绝写入）。 */
export function cameraModePreset(id: string): CameraModePreset | undefined {
  return CAMERA_MODE_PRESETS.find((preset) => preset.id === id)
}

// ---------------------------------------------------------------------------
// 写请求 / 读回事实
// ---------------------------------------------------------------------------

/**
 * 一次写入**要发出去**的声学数值（域模型名，线上键名在服务层落）。
 *
 * 全部字段可选：预设没声明的、以及调用方想还原但当时没读到的那一项，
 * 都必须**不发**，而不是补一个默认值。
 */
export interface CameraModeAcousticValues {
  lowerKhz?: number
  upperKhz?: number
  /** 采样率原样回写（§8.3 C1：单位不可推断，所以只搬数字，不解释）。 */
  sampleRateRaw?: number
}

export interface CameraModeImagingValues {
  targetCount?: number
  imagingSensitivity?: number
  imagingEnhance?: number
  /**
   * 成像阈值。
   *
   * 存在的唯一目的是**还原**：它只可能来自「写之前读到的设备事实」。
   * 三个预设**都不带它**（手册说「Set after observing ambient energy」），
   * 所以预设路径永远不会写这个字段。
   */
  energyThreshold?: number
}

/**
 * 「我现在是什么样」——一次读到的声学 + 成像事实。
 *
 * 渲染层直接读 `band` 显示当前频带；`matchesPreset` 用来判断
 * 「已经在这个模式了」。`targetCountKeyUsed` 透传设备实际回的键名
 * （§8.3 C2：`target_number` vs `target_numbe` 仍未定论）。
 */
export interface CameraModeDeviceView {
  lowerKhz?: number
  upperKhz?: number
  sampleRateRaw?: number
  energyThreshold?: number
  targetCount?: number
  imagingSensitivity?: number
  imagingEnhance?: number
  targetCountKeyUsed: Fa371ImagingConfig['targetCountKeyUsed']
}

/** 从一次设备读数派生出视图（纯函数，可测）。 */
export function cameraModeDeviceView(
  acoustic: Fa371AcousticConfig,
  imaging: Fa371ImagingConfig
): CameraModeDeviceView {
  const view: CameraModeDeviceView = { targetCountKeyUsed: imaging.targetCountKeyUsed }
  if (acoustic.freqDownLimit !== undefined) view.lowerKhz = acoustic.freqDownLimit
  if (acoustic.freqUpLimit !== undefined) view.upperKhz = acoustic.freqUpLimit
  if (acoustic.sampleRateRaw !== undefined) view.sampleRateRaw = acoustic.sampleRateRaw
  if (imaging.energyThreshold !== undefined) view.energyThreshold = imaging.energyThreshold
  if (imaging.targetCount !== undefined) view.targetCount = imaging.targetCount
  if (imaging.imagingSensitivity !== undefined) view.imagingSensitivity = imaging.imagingSensitivity
  if (imaging.imagingEnhance !== undefined) view.imagingEnhance = imaging.imagingEnhance
  return view
}

// ---------------------------------------------------------------------------
// 逐字段比对（纯函数）
// ---------------------------------------------------------------------------

/**
 * 一个字段的写入结果。
 *
 * `applied` 由**重读**得出，而不是由成功码得出：本设备实测过 `ret:200` 却
 * 完全不生效（`PUT /alarm_strategy {Switch:1}`，见 `docs/FA371-API-DELTA.md` §1），
 * 所以「设备应答了」永远不等于「设备改了」。界面显示 `after`，`applied === false`
 * 时显示「设备应答成功但没有生效」。
 */
export interface CameraModeFieldResult {
  field: CameraModeAnyFieldKey
  requested: number
  before?: number
  /** 写完之后重新读到的值 —— **权威值**。 */
  after?: number
  applied: boolean
}

/**
 * 预设可能写的字段。
 *
 * `energy_threshold` **不在其中**：三个预设都不带它（手册说「Set after observing
 * ambient energy」），所以它不该出现在「这个预设改了哪些字段」的清单上。
 * 它只会出现在**还原**路径上（把写之前读到的那个值放回去），由
 * `CAMERA_MODE_RESTORE_ONLY_FIELD_KEYS` 单独声明。
 */
export type CameraModeFieldKey =
  | 'freq_down_limit'
  | 'freq_up_limit'
  | 'target_count'
  | 'imaging_sensitivity'
  | 'imaging_enhance'

/** 还原路径**独有**、预设永不使用的字段。 */
export type CameraModeRestoreOnlyFieldKey = 'energy_threshold'

/** 一次写入结果里可能出现的字段名（比对结果用这个联合）。 */
export type CameraModeAnyFieldKey = CameraModeFieldKey | CameraModeRestoreOnlyFieldKey

/**
 * 预设**可以**写的字段清单（测试用它证明预设不会碰阈值）。
 *
 * 这是一份显式数据而不是类型：类型在编译后消失，而「阈值绝不被预设写入」这条
 * 规矩值得被运行时断言。
 */
export const CAMERA_MODE_PRESET_FIELD_KEYS: readonly CameraModeFieldKey[] = [
  'freq_down_limit',
  'freq_up_limit',
  'target_count',
  'imaging_sensitivity',
  'imaging_enhance'
]

/** 还原路径独有的字段清单。 */
export const CAMERA_MODE_RESTORE_ONLY_FIELD_KEYS: readonly CameraModeRestoreOnlyFieldKey[] = [
  'energy_threshold'
]

/**
 * 重读值是否等于请求值。
 *
 * 设备没回这个字段（`after === undefined`）时判 `false`：读不到就是**没证据**，
 * 不能把"没读到"当成"对上了"。
 */
export function fieldApplied(requested: number, after: number | undefined): boolean {
  return after !== undefined && after === requested
}

/**
 * 设备当前是否**就是**这个预设。
 *
 * 只比较预设**声明**的字段：预设不管的字段（阈值、灵敏度、采样率）取任何值都
 * 不影响判定，否则「已经在这个模式」永远判不出来。
 *
 * 需要声学与成像两份读数：任一声明字段读不到（例如成像里没有目标数量）就
 * 返回 `false` —— 读不到不等于匹配，宁可让操作员多点一次，也不能说
 * 「已经在这个模式」而其实不知道。
 */
export function cameraModeMatchesPreset(
  view: CameraModeDeviceView,
  preset: CameraModePreset
): boolean {
  // 预设声明的必填项（频带两侧 + 目标数量）先要求全部读到。
  // 成像灵敏度三个预设都没有声明数字（手册只给档位词），所以不列入这里 ——
  // 列进来会让 `matches` 永远为 `false`。
  const required: Array<number | undefined> = [view.lowerKhz, view.upperKhz, view.targetCount]
  if (required.some((value) => value === undefined)) return false

  if (view.lowerKhz !== preset.values.band.lowerKhz) return false
  if (view.upperKhz !== preset.values.band.upperKhz) return false
  if (view.targetCount !== preset.values.targetCount) return false
  if (
    preset.values.imagingSensitivity !== undefined &&
    view.imagingSensitivity !== preset.values.imagingSensitivity
  ) {
    return false
  }
  if (
    preset.values.imagingEnhance !== undefined &&
    view.imagingEnhance !== preset.values.imagingEnhance
  ) {
    return false
  }
  return true
}

/** 设备当前命中的预设 id 列表（用于界面把该按钮置为选中态）。 */
export function cameraModeMatchedPresetIds(view: CameraModeDeviceView): CameraModePresetId[] {
  return CAMERA_MODE_PRESETS.filter((preset) => cameraModeMatchesPreset(view, preset)).map(
    (preset) => preset.id
  )
}

// ---------------------------------------------------------------------------
// 服务返回值（IPC 直接透传，渲染层只读）
// ---------------------------------------------------------------------------

/** 渲染层要的完整读数 + 命中判定。 */
export interface CameraModePresetRead {
  view: CameraModeDeviceView
  /** 当前命中的预设 id；空数组表示三个都不是（参数被现场手调过）。 */
  matchedPresetIds: CameraModePresetId[]
}

/**
 * 一次写入请求**要发出去**的数值（预设路径由预设填，还原路径由调用方填）。
 *
 * 全部字段可选是刻意的：没说到的字段就是**不发**，而不是补一个默认值。
 */
export interface CameraModeRequestedValues {
  acoustic: CameraModeAcousticValues
  imaging: CameraModeImagingValues
}

/**
 * 一次「应用模式预设」的完整结果。
 *
 * 与已有的 `CameraRunModeWriteResult` 同一条规矩（写后重读），只是多字段：
 * 逐字段给出 `{field, requested, before, after, applied}`，所以界面能说清
 * 「设备接受了频带但没接受目标数量」这种半生效的情况，而不是一句笼统的成功。
 */
export interface CameraModePresetWriteResult {
  kind: 'preset' | 'restore'
  /** `kind === 'preset'` 时是预设 id；还原时缺省。 */
  presetId?: CameraModePresetId
  requested: CameraModeRequestedValues
  /** 写之前设备的事实。 */
  before: CameraModeDeviceView
  /** 写之后重新读到的事实 —— **权威值**。 */
  after: CameraModeDeviceView
  acousticFields: CameraModeFieldResult[]
  imagingFields: CameraModeFieldResult[]
  /** 每个写出去的字段都真的变了才算 `true`。 */
  applied: boolean
  /**
   * 重读之后设备是否命中该预设。
   *
   * 与 `applied` 分开是因为两者回答不同的问题：`applied` 是「这次写有没有生效」，
   * `matches` 是「设备现在是不是这个模式」。一个字段都没写（预设与现状本来就一致）
   * 时前者是空数组（真空真，`true`），后者仍如实回答。
   */
  matches: boolean
}
