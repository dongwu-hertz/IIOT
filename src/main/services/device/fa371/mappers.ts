/**
 * FA371 —— DTO -> Domain 映射。
 *
 *   Protocol DTO  ->  [本文件]  ->  Domain Model  ->  Store  ->  UI
 *
 * 本文件与 `./dto.ts` 是**仅有的两个**允许出现手册线上键名的地方。
 *
 * ---------------------------------------------------------------------------
 * 三条设计规则
 * ---------------------------------------------------------------------------
 * 1) **缺字段就是缺字段**：手册的示例 JSON 普遍缺字段（示例损坏、字段表与示例
 *    互相矛盾），所以每个 mapper 都必须容忍**键不存在**。缺失产出 `undefined`
 *    或空数组，绝不产出 `NaN`/`0`/`''`——一个静默的 0 会被渲染成真实读数。
 *
 * 2) **不猜手册没写的东西**：规格 §8 标注为未定义的地方（采样率单位、
 *    时间戳单位、坐标系、运算符配对），本文件用**具名候选集**表达，
 *    默认值一律取"未知"，只有调用方明确给出假设时才换算。
 *
 * 3) **矛盾要显式暴露**：`leakage_unit: 1` 配 `"l/min"`（§8.3 C7）这类
 *    自相矛盾的响应，映射结果里带一个 `codeMatchesLabel: false` 之类的标记，
 *    而不是替设备"选一个看起来对的"。
 */

import { toNumber } from '@shared/utils/id'
import {
  enabledStrategyIds,
  type CameraEnabledStrategyView,
  type CameraVersionInfo
} from '@shared/domain/camera-control'
import {
  FA371_ALARM_LEVEL_KEYS,
  FA371_ARITHMETIC_OPERATOR_KEYS,
  FA371_CENTER_FOCUS_KEYS,
  FA371_DISCHARGE_TYPE_KEYS,
  FA371_DRAW_STATUS_KEYS,
  FA371_FILE_STATUS_KEYS,
  FA371_LEAKAGE_UNIT_KEYS,
  FA371_LOGICAL_OPERATOR_KEYS,
  FA371_MONETARY_UNIT_KEYS,
  FA371_NC_ARITHMETIC_OPERATOR_KEYS,
  FA371_RESULT_FILE_KINDS,
  FA371_RUN_MODE_KEYS,
  FA371_VIDEO_FLIP_KEYS,
  FA371_WORK_MODE_KEYS,
  FA371_WORK_MODES,
  Fa371RunMode,
  type Fa371AcousticConfig,
  type Fa371AlarmCondition,
  type Fa371AlarmConditionPage,
  type Fa371AlarmStrategy,
  type Fa371AlarmStrategyPage,
  type Fa371DetectLog,
  type Fa371DetectStatus,
  type Fa371DetectionResult,
  type Fa371ImagingConfig,
  type Fa371ImagingTargetKeyUsed,
  type Fa371LeakageConfig,
  type Fa371LeakageUnitView,
  type Fa371NcFile,
  type Fa371NcFilePage,
  type Fa371ResultFileKind,
  type Fa371RunModeConfig,
  type Fa371RunModeValue,
  type Fa371RtspUrlCandidate,
  type Fa371SampleRateUnit,
  type Fa371ScanArea,
  type Fa371ScanAreaCoordinateSpace,
  type Fa371ScanRect,
  type Fa371SystemTime,
  type Fa371TimestampUnit,
  type Fa371VideoConfig,
  type Fa371WorkModeConfig
} from '@shared/domain/fa371'
import { FA371_RET_SUCCESS } from './dto'
import type {
  Fa371AcousticDto,
  Fa371AlarmConditionDto,
  Fa371AlarmConditionPageDto,
  Fa371AlarmStrategyDto,
  Fa371AlarmStrategyPageDto,
  Fa371BasicInfoDto,
  Fa371DetectStatusDto,
  Fa371ImagingDto,
  Fa371LeakageDto,
  Fa371NcFileDto,
  Fa371NcFilePageDto,
  Fa371RunModeDto,
  Fa371ScanAreaDto,
  Fa371SystemDto,
  Fa371SystemTimeDto,
  Fa371TurnOnDetectDto,
  Fa371VersionInfoDto,
  Fa371VideoDto
} from './dto'

// ---------------------------------------------------------------------------
// 包络判定（规格 §1）
// ---------------------------------------------------------------------------

/**
 * 规格 §1：`ret === 200` 成功；`-1` 是业务失败（§5.1.14/§5.1.25/§5.1.29/§5.1.32）。
 *
 * `ret` **缺失时视为成功**，因为手册明确有三个接口不带 `ret`/`msg`：
 * §5.1.15（无响应内容）、§5.1.16（只有 `detect_status`）、§5.1.20（只有 `sys_time`）。
 * §8.2 B3 说其余失败码未定义，所以除了 200 之外的任何数值都按失败处理——
 * 保守方向是安全的方向：把失败当成功会写坏设备配置。
 */
export function isFa371Success(payload: unknown): boolean {
  if (payload === null || payload === undefined) return true
  if (typeof payload !== 'object' || Array.isArray(payload)) return true

  const ret = (payload as Record<string, unknown>).ret
  if (ret === undefined || ret === null) return true

  const parsed = toNumber(ret)
  // `ret` 存在但不是数字（例如嵌套对象）→ 无法判定，保守视为失败。
  if (parsed === undefined) return false
  return parsed === FA371_RET_SUCCESS
}

/** 从响应里取错误文案：`msg`，其次 `message`（不同固件可能改写）。 */
export function fa371ErrorMessage(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const source = payload as Record<string, unknown>
  const msg = source.msg ?? source.message
  return typeof msg === 'string' && msg.trim().length > 0 ? msg.trim() : undefined
}

// ---------------------------------------------------------------------------
// 取值辅助
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** 第一个既非 undefined 也非 null、且不是空字符串的值。 */
function pick(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function pickNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const parsed = toNumber(source[key])
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function pickString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const value = pick(source, keys)
  if (value === undefined) return undefined
  const text = String(value).trim()
  return text.length > 0 ? text : undefined
}

/**
 * 归一化 0/1、true/false、'on'/'off' 之类的开关量。
 * 无法识别时返回 `undefined`（**不是** false），否则"设备没回"和"设备说关"
 * 会变成同一个值。
 */
function pickBoolean(source: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  const value = pick(source, keys)
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'on', 'yes', 'enable', 'enabled'].includes(text)) return true
  if (['0', 'false', 'off', 'no', 'disable', 'disabled'].includes(text)) return false
  return undefined
}

/** 在数字键映射里查稳定 KEY；未命中返回 `undefined`（不就近取整）。 */
function lookupKey(
  table: Readonly<Record<number, string>>,
  value: number | undefined
): string | undefined {
  if (value === undefined) return undefined
  return table[value]
}

// ---------------------------------------------------------------------------
// 未定义行为的具名候选集（规格 §8）
// ---------------------------------------------------------------------------

/**
 * `samplerate` 单位候选（§8.3 C1，P0）。
 *
 * 手册字段说明写 KHz，取值却给 96000 / 132000（响应示例又写 13200）——
 * 量纲自相矛盾，**默认只能是 unknown**：把 96000 当 Hz 或 96 kHz 都是猜。
 */
export interface Fa371SampleRateUnitCandidate {
  id: Fa371SampleRateUnit
  description: string
}

export const FA371_SAMPLE_RATE_UNIT_CANDIDATES: readonly Fa371SampleRateUnitCandidate[] = [
  {
    id: 'unknown',
    description: '单位未确定（默认；§8.3 C1 量纲矛盾，必须实测）'
  },
  {
    id: 'hz',
    description: '按 Hz 解读（96000 / 132000 是标准采样率数值，支持这种读法）'
  },
  {
    id: 'khz',
    description: '按 kHz 解读（手册字段说明的字面读法，但与数值不自洽）'
  }
]

export const DEFAULT_FA371_SAMPLE_RATE_UNIT: Fa371SampleRateUnit = 'unknown'

/**
 * 时间戳单位候选（§8.2 B5 / §8.3 C19，P0）。
 *
 * 手册对 `sys_time` / `time` / `start_time` / `end_time` 的**单位与时区全部未说明**，
 * 且 `sys_time` 的示例只有 8 位（`17220332`），既不是秒级也不是毫秒级。
 * 所以默认 `unknown`：mapper 保留原始数值但**不产出** `epochMs`，
 * 调用方要用时间就必须显式选一个单位假设。
 */
export interface Fa371TimestampUnitCandidate {
  id: Fa371TimestampUnit
  description: string
  toEpochMs(value: number): number | undefined
}

export const FA371_TIMESTAMP_UNIT_CANDIDATES: readonly Fa371TimestampUnitCandidate[] = [
  {
    id: 'unknown',
    description: '单位未确定（默认；不产出 epochMs，避免把 8 位示例当成真实时间）',
    toEpochMs: () => undefined
  },
  {
    id: 'epoch_seconds',
    description: '10 位秒级 Unix 时间戳（§5.1.17 示例 1561033839 的长度支持这种读法）',
    toEpochMs: (value) => Math.round(value * 1000)
  },
  {
    id: 'epoch_milliseconds',
    description: '13 位毫秒级 Unix 时间戳（§5.1.20 示例只有 8 位，明显不匹配）',
    toEpochMs: (value) => Math.round(value)
  }
]

export const DEFAULT_FA371_TIMESTAMP_UNIT: Fa371TimestampUnit = 'unknown'

/** 按给定单位假设换算时间戳；单位未知时返回 `undefined`。 */
export function interpretFa371Timestamp(
  value: number | undefined,
  unit: Fa371TimestampUnit = DEFAULT_FA371_TIMESTAMP_UNIT
): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const candidate = FA371_TIMESTAMP_UNIT_CANDIDATES.find((entry) => entry.id === unit)
  return candidate?.toEpochMs(value)
}

/**
 * `/system/scan_area` 坐标系候选（§8.3 C9/C10，P0）。
 *
 * 手册从未给出单位与参考系。唯一的线索是 GET 示例：横轴最大 992+240=1232
 * （暗示基准约 1920），纵轴 704+168=872（与 1080 不吻合）。
 * 默认 `unverified`——把坐标当 1920×1080 像素写回设备是会让检测区错位的猜测。
 */
export interface Fa371ScanAreaCoordinateSpaceCandidate {
  id: Fa371ScanAreaCoordinateSpace
  description: string
  /** 已知参考分辨率；未验证时为 undefined。 */
  referenceWidth?: number
  referenceHeight?: number
}

export const FA371_SCAN_AREA_COORDINATE_SPACE_CANDIDATES: readonly Fa371ScanAreaCoordinateSpaceCandidate[] =
  [
    {
      id: 'unverified',
      description: '坐标系未验证（默认；坐标只作原样透传，不做换算/裁剪）'
    },
    {
      id: 'pixel_video_frame',
      description:
        '按视频帧像素坐标解读（§5.1.12 示例横轴上限 1232 暗示基准 1920；纵轴 872 与 1080 不吻合，仍需实测）',
      referenceWidth: 1920,
      referenceHeight: 1080
    }
  ]

export const DEFAULT_FA371_SCAN_AREA_COORDINATE_SPACE: Fa371ScanAreaCoordinateSpace = 'unverified'

/**
 * 算术运算符配对候选（§8.3 C28，P1）。
 *
 * §5.1.26/§5.1.27 把 `(0-4)` 与 `>, <, =, >=, <=` 按顺序并列给出，
 * **没有逐项配对**；只有 `nc_arithmetic_operator` 在写入侧明确 `0` = `>`、`1` = `<`。
 * 所以"0=>,1=<,2==,3=>=,4=<="是一份**具名假设**，不是手册结论。
 */
export interface Fa371ArithmeticOperatorCandidate {
  id: string
  description: string
  keys: Readonly<Record<number, string>>
}

export const FA371_ARITHMETIC_OPERATOR_CANDIDATES: readonly Fa371ArithmeticOperatorCandidate[] = [
  {
    id: 'ordered_table',
    description:
      '按 §5.1.26 表格顺序 0=>,1=<,2==,3=>=,4=<=（默认；nc_arithmetic_operator 的 0/1 与之一致，是唯一旁证）',
    keys: FA371_ARITHMETIC_OPERATOR_KEYS
  }
]

export const DEFAULT_FA371_ARITHMETIC_OPERATOR_CANDIDATE = 'ordered_table'

function arithmeticOperatorTable(candidateId?: string): Readonly<Record<number, string>> {
  const found = FA371_ARITHMETIC_OPERATOR_CANDIDATES.find((entry) => entry.id === candidateId)
  return found?.keys ?? FA371_ARITHMETIC_OPERATOR_KEYS
}

/** mapper 的公共选项：把所有"手册未说明"的假设集中在显式参数里。 */
export interface Fa371MapOptions {
  /** 时间戳单位假设（§8.2 B5）。默认 `unknown`。 */
  timeUnit?: Fa371TimestampUnit
  /** 坐标系假设（§8.3 C9）。默认 `unverified`。 */
  coordinateSpace?: Fa371ScanAreaCoordinateSpace
  /** 算术运算符配对假设（§8.3 C28）。默认 `ordered_table`。 */
  arithmeticOperatorCandidate?: string
}

// ---------------------------------------------------------------------------
// 声场配置（§5.1.2）
// ---------------------------------------------------------------------------

/**
 * 映射 `GET /system/acoustic`。
 *
 * §5.1.2 的缺口：`samplerate: 13200` 与合法值（96000/132000）量纲矛盾，
 * 示例里也没有 `imaging_*` 类字段。这里保留原始数值 + 单位不确定性。
 */
export function mapAcousticConfig(dto: Fa371AcousticDto | undefined): Fa371AcousticConfig {
  const source = asRecord(dto) ?? {}
  const sampleRateRaw = pickNumber(source, ['samplerate', 'sample_rate', 'sampleRate'])
  const freqUpLimit = pickNumber(source, ['freq_up_limit', 'freqUpLimit'])
  const freqDownLimit = pickNumber(source, ['freq_down_limit', 'freqDownLimit'])

  const config: Fa371AcousticConfig = {
    sampleRateUnit: DEFAULT_FA371_SAMPLE_RATE_UNIT
  }
  if (sampleRateRaw !== undefined) config.sampleRateRaw = sampleRateRaw
  if (freqUpLimit !== undefined) config.freqUpLimit = freqUpLimit
  if (freqDownLimit !== undefined) config.freqDownLimit = freqDownLimit
  if (freqUpLimit !== undefined && freqDownLimit !== undefined) {
    config.bandWidth = freqUpLimit - freqDownLimit
  }
  return config
}

// ---------------------------------------------------------------------------
// 成像配置（§5.1.4）
// ---------------------------------------------------------------------------

/**
 * 映射 `GET /system/image`。
 *
 * §8.3 C2（P0）：字段表键名 `target_numbe`（漏 `r`）与示例键名 `target_number`
 * 冲突，且 `imaging_sensitivity`/`imaging_enhance` 只在字段表出现。
 * 这里**两个键都读**，并用 `targetCountKeyUsed` 告诉调用方设备实际回了哪个，
 * 这样探测结果可以直接回灌到写接口的键选择上。
 */
export function mapImagingConfig(dto: Fa371ImagingDto | undefined): Fa371ImagingConfig {
  const source = asRecord(dto) ?? {}

  let targetCountKeyUsed: Fa371ImagingTargetKeyUsed = 'absent'
  let targetCount: number | undefined
  const fromExampleKey = pickNumber(source, ['target_number'])
  if (fromExampleKey !== undefined) {
    targetCount = fromExampleKey
    targetCountKeyUsed = 'target_number'
  } else {
    const fromTableKey = pickNumber(source, ['target_numbe'])
    if (fromTableKey !== undefined) {
      targetCount = fromTableKey
      targetCountKeyUsed = 'target_numbe'
    }
  }

  const config: Fa371ImagingConfig = { targetCountKeyUsed }
  const energyThreshold = pickNumber(source, ['energy_threshold'])
  if (energyThreshold !== undefined) config.energyThreshold = energyThreshold
  if (targetCount !== undefined) config.targetCount = targetCount
  const sensitivity = pickNumber(source, ['imaging_sensitivity'])
  if (sensitivity !== undefined) config.imagingSensitivity = sensitivity
  const enhance = pickNumber(source, ['imaging_enhance'])
  if (enhance !== undefined) config.imagingEnhance = enhance
  return config
}

// ---------------------------------------------------------------------------
// 视频与 RTSP 配置（§5.1.6）
// ---------------------------------------------------------------------------

/** 映射 `GET /system/video`。`video_url` 的 string/integer 矛盾在此归一化（§8.3 C4）。 */
export function mapVideoConfig(dto: Fa371VideoDto | undefined): Fa371VideoConfig {
  const source = asRecord(dto) ?? {}
  const config: Fa371VideoConfig = {}

  const bitRate = pickNumber(source, ['video_bit_rate'])
  if (bitRate !== undefined) config.bitRate = bitRate
  const fps = pickNumber(source, ['video_fps'])
  if (fps !== undefined) config.fps = fps
  const width = pickNumber(source, ['video_width'])
  if (width !== undefined) config.width = width
  const height = pickNumber(source, ['video_height'])
  if (height !== undefined) config.height = height

  const flipModel = pickNumber(source, ['video_flip_model'])
  if (flipModel !== undefined) {
    config.flipModel = flipModel
    const key = lookupKey(FA371_VIDEO_FLIP_KEYS as Readonly<Record<number, string>>, flipModel)
    if (key !== undefined) config.flipModelKey = key
  }

  const port = pickNumber(source, ['video_port'])
  if (port !== undefined) config.rtspPort = port

  // §8.3 C4：字段表标 integer，示例是字符串 "live"。数字也接受，但统一成字符串。
  const rawUrl = pick(source, ['video_url'])
  if (rawUrl !== undefined) {
    const path = String(rawUrl).trim()
    if (path.length > 0) config.rtspPath = path
  }

  const enabled = pickBoolean(source, ['rtsp_enabled'])
  if (enabled !== undefined) config.rtspEnabled = enabled
  const connected = pickNumber(source, ['rtsp_connected_num'])
  if (connected !== undefined) config.rtspConnectedCount = connected
  const limit = pickNumber(source, ['rtsp_client_limit'])
  if (limit !== undefined) config.rtspClientLimit = limit

  return config
}

/**
 * 生成 RTSP URL 候选（规格 §8.5 E2，P0）。
 *
 * 手册**没有给出**拼装规则，只散落给了 `video_port` + `video_url`；
 * 是否需用户名口令、`video_port=443` 是否意味着 TLS 都未说明（§8.5 E3）。
 * 因此不返回一个 URL，而是返回**一组具名候选**供逐条实测。
 *
 * `video_port` 缺失时返回空数组：手册唯一的端口示例是 `443`，
 * 把它当默认值会让候选集看起来像"已确认"。
 *
 * 安全提示：带凭据的候选只在调用方显式传入 credential 时生成，
 * 且返回的 URL 含明文口令，**不得写入日志**。
 */
export function buildRtspUrlCandidates(
  host: string,
  video: Fa371VideoConfig,
  credential?: { username: string; password: string }
): Fa371RtspUrlCandidate[] {
  const hostname = host.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '')
  const port = video.rtspPort
  const path = (video.rtspPath ?? '').replace(/^\/+/, '')
  if (hostname === '' || port === undefined || path === '') return []

  const candidates: Fa371RtspUrlCandidate[] = [
    {
      id: 'rtsp_without_credentials',
      url: `rtsp://${hostname}:${port}/${path}`,
      assumeCredentials: false
    }
  ]

  if (credential) {
    candidates.push({
      id: 'rtsp_with_credentials',
      url: `rtsp://${credential.username}:${credential.password}@${hostname}:${port}/${path}`,
      assumeCredentials: true
    })
  }

  // §8.5 E3：示例端口 443 是 HTTPS 惯用端口，手册没解释，也没说是否 TLS。
  if (port === 443) {
    candidates.push({
      id: 'rtsps_without_credentials',
      url: `rtsps://${hostname}:${port}/${path}`,
      assumeCredentials: false
    })
  }

  return candidates
}

// ---------------------------------------------------------------------------
// 运行模式（§5.1.8）
// ---------------------------------------------------------------------------

/** 映射 `GET /run_mode`。既不是 1 也不是 -1 时不猜，只留原始值。 */
export function mapRunMode(dto: Fa371RunModeDto | undefined): Fa371RunModeConfig {
  const source = asRecord(dto) ?? {}
  const raw = pickNumber(source, ['run_mode'])
  const config: Fa371RunModeConfig = {}
  if (raw === undefined) return config
  config.raw = raw
  if (raw === Fa371RunMode.SingleDetection || raw === Fa371RunMode.IntelligentCruise) {
    const mode: Fa371RunModeValue = raw
    config.mode = mode
    config.key = FA371_RUN_MODE_KEYS[mode]
  }
  return config
}

// ---------------------------------------------------------------------------
// 应用模式（`GET /system`）—— 手册未收录、真机实测
// ---------------------------------------------------------------------------

/**
 * 映射 `GET /system` → 应用模式（局部放电 / 气体泄漏 / 机械异响）。
 *
 * ---------------------------------------------------------------------------
 * 为什么"认不出就只留原始值"这条在这里尤其重要
 * ---------------------------------------------------------------------------
 * 设备**自己的前端**把"非 1 非 2"一律显示成机械异响（见 `dto.ts` 里那段逐字照抄的
 * 三元表达式），所以照抄那个兜底、把任何未知取值都当机械异响，看起来是"与设备一致"。
 * 那是错的：一个本软件没见过的数字说明**固件变了**（比如以后加了 `0`），此时唯一
 * 诚实的回答是"设备返回了 N，我不认识"，而不是给操作员一个可能是错的机型名 ——
 * 机型名会直接影响他判断该用哪套参数、以及该不该照当前读数下结论。
 *
 * 因此：命中 `1`/`2`/`3` 才给 `mode` + `key`（`partial_discharge` / `gas_leak` /
 * `mechanical`），其余只留 `raw`。字段整个缺席时三个字段都不产出。
 */
export function mapWorkMode(dto: Fa371SystemDto | undefined): Fa371WorkModeConfig {
  const source = asRecord(dto) ?? {}
  const raw = pickNumber(source, ['work_mode'])
  const config: Fa371WorkModeConfig = {}
  if (raw === undefined) return config
  config.raw = raw
  const mode = FA371_WORK_MODES.find((candidate) => candidate === raw)
  if (mode !== undefined) {
    config.mode = mode
    config.key = FA371_WORK_MODE_KEYS[mode]
  }
  return config
}

// ---------------------------------------------------------------------------
// 泄漏估算配置（§5.1.10）
// ---------------------------------------------------------------------------

/**
 * 映射 `GET /system/leakage`。
 *
 * §8.3 C7（P1）：示例里 `leakage_unit: 1` 配 `"l/min"`、`monetary_unit: 1` 配 `"CNY"`，
 * 与手册枚举定义（1 = ml/s、1 = GBP）**互相矛盾**。两个值都原样保留，
 * 并用 `codeMatchesLabel` 把矛盾标出来，绝不静默"修正"。
 */
export function mapLeakageConfig(dto: Fa371LeakageDto | undefined): Fa371LeakageConfig {
  const source = asRecord(dto) ?? {}
  const config: Fa371LeakageConfig = {}

  const costDisplay = pickBoolean(source, ['cost_display'])
  if (costDisplay !== undefined) config.costDisplay = costDisplay
  const distance = pickNumber(source, ['leakage_distance'])
  if (distance !== undefined) config.distanceM = distance

  const unit = mapUnitView(
    pickNumber(source, ['leakage_unit']),
    pickString(source, ['leakage_unit_str']),
    FA371_LEAKAGE_UNIT_KEYS as Readonly<Record<number, string>>,
    ['l/min', 'ml/s']
  )
  if (unit) config.unit = unit

  const monetary = mapUnitView(
    pickNumber(source, ['monetary_unit']),
    pickString(source, ['monetary_unit_str']),
    FA371_MONETARY_UNIT_KEYS as Readonly<Record<number, string>>,
    ['CNY', 'GBP', 'USD', 'EUR', 'RUB']
  )
  if (monetary) config.monetaryUnit = monetary

  const valueOfGas = pickNumber(source, ['value_of_gas'])
  if (valueOfGas !== undefined) config.valueOfGas = valueOfGas
  const energyCost = pickNumber(source, ['energy_cost'])
  if (energyCost !== undefined) config.energyCost = energyCost
  const specificPower = pickNumber(source, ['specific_power'])
  if (specificPower !== undefined) config.specificPower = specificPower
  const workingHours = pickNumber(source, ['working_hours'])
  if (workingHours !== undefined) config.workingHours = workingHours

  return config
}

/**
 * 代码值 + 回显字符串的组合视图。
 *
 * `codeMatchesLabel` 用**枚举定义里每个代码对应的字符串**做对照
 * （`0` -> `l/min`、`1` -> `ml/s`；货币同理）。这既能发现 §8.3 C7 示例里
 * `1` 配 `"l/min"` 的矛盾，也不会对设备回显的原始字符串做任何替换。
 * 代码超出枚举表时保持 `undefined`（"无法判定"），而不是假装一致。
 */
function mapUnitView(
  code: number | undefined,
  label: string | undefined,
  table: Readonly<Record<number, string>>,
  labelsInCodeOrder: readonly string[]
): Fa371LeakageUnitView | undefined {
  if (code === undefined && label === undefined) return undefined
  const view: Fa371LeakageUnitView = {}
  if (code !== undefined) {
    view.code = code
    const key = table[code]
    if (key !== undefined) view.codeKey = key
  }
  if (label !== undefined) view.label = label
  if (code !== undefined && label !== undefined) {
    const expected = labelsInCodeOrder[code]
    if (expected !== undefined) view.codeMatchesLabel = expected === label
  }
  return view
}

// ---------------------------------------------------------------------------
// 检测区域（§5.1.12）
// ---------------------------------------------------------------------------

/**
 * 映射 `GET /system/scan_area`（§8.3 C9/C10，P0）。
 *
 * `areas` 缺失时产出**空数组**而不是 `undefined`：省略与"没有配置区域"
 * 在这份协议里无法区分，但 UI 两者都只需渲染"无区域"。
 * 坐标系按 `options.coordinateSpace` 标注，默认 `unverified`。
 */
export function mapScanArea(
  dto: Fa371ScanAreaDto | undefined,
  options: Fa371MapOptions = {}
): Fa371ScanArea {
  const source = asRecord(dto) ?? {}
  const rawAreas = Array.isArray(source.areas) ? source.areas : []

  const areas: Fa371ScanRect[] = rawAreas.map((item) => {
    const entry = asRecord(item) ?? {}
    const rect: Fa371ScanRect = {}
    const height = pickNumber(entry, ['area_height'])
    if (height !== undefined) rect.height = height
    const width = pickNumber(entry, ['area_width'])
    if (width !== undefined) rect.width = width
    const drawStatus = pickNumber(entry, ['detect_area_status'])
    if (drawStatus !== undefined) {
      rect.drawStatus = drawStatus
      const key = lookupKey(FA371_DRAW_STATUS_KEYS as Readonly<Record<number, string>>, drawStatus)
      if (key !== undefined) rect.drawStatusKey = key
    }
    const leftTopX = pickNumber(entry, ['left_top_x'])
    if (leftTopX !== undefined) rect.leftTopX = leftTopX
    const leftTopY = pickNumber(entry, ['left_top_y'])
    if (leftTopY !== undefined) rect.leftTopY = leftTopY
    return rect
  })

  const area: Fa371ScanArea = {
    areas,
    coordinateSpace: options.coordinateSpace ?? DEFAULT_FA371_SCAN_AREA_COORDINATE_SPACE
  }
  const centerFocus = pickNumber(source, ['center_focus'])
  if (centerFocus !== undefined) {
    area.centerFocusCode = centerFocus
    const key = lookupKey(FA371_CENTER_FOCUS_KEYS as Readonly<Record<number, string>>, centerFocus)
    if (key !== undefined) area.centerFocusKey = key
  }
  return area
}

// ---------------------------------------------------------------------------
// 检测状态与启停（§5.1.14 – §5.1.16）
// ---------------------------------------------------------------------------

/**
 * 映射 `GET /system/detect_status`（§8.3 C13，P0）。
 *
 * 字段表把 `detect_status` 标为 `boolean`，取值语义却是 `0`/`1`；
 * 并且这是全组唯一**没有 `ret`/`msg`** 的接口。两者都在这里归一化，
 * 同时用 `retPresent` 把"手册说的这个例外"变成可观测事实（供 Protocol Lab 验证）。
 */
export function mapDetectStatus(dto: Fa371DetectStatusDto | undefined): Fa371DetectStatus {
  const source = asRecord(dto) ?? {}
  const value = pick(source, ['detect_status'])
  let detecting = false
  if (typeof value === 'boolean') detecting = value
  else if (typeof value === 'number') detecting = value !== 0
  else if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    detecting = text === '1' || text === 'true'
  }

  return { detecting, retPresent: source.ret !== undefined || source.msg !== undefined }
}

/** 映射 `POST /turn_on_detect`（§5.1.14）。巡航模式下 `detect_id` 可能缺失。 */
export function mapDetectionResult(dto: Fa371TurnOnDetectDto | undefined): Fa371DetectionResult {
  const source = asRecord(dto) ?? {}
  const detectId = pickNumber(source, ['detect_id'])
  return detectId === undefined ? {} : { detectId }
}

// ---------------------------------------------------------------------------
// 维护：设备自报的版本信息（手册未收录、实测存在的只读接口）
// ---------------------------------------------------------------------------

/**
 * 映射 `GET /dev_info` + `GET /basic` 两份响应。
 *
 * 两个来源的键不重叠，所以合成一个 `CameraVersionInfo`；任一来源失败时调用方
 * 传 `undefined`，对应字段就保持缺省 —— 界面据此显示「这一项没读到」，
 * 而不是显示空字符串或 0。`upgrade_time` 的格式与时区手册都没说明，
 * 因此**原样保留字符串**，不做日期解析（§8.2 B5 的同类歧义）。
 */
export function mapCameraVersionInfo(
  version: Fa371VersionInfoDto | undefined,
  basic: Fa371BasicInfoDto | undefined
): CameraVersionInfo {
  const info: CameraVersionInfo = {}

  const versionSource = asRecord(version) ?? {}
  const firmwareVersion = pickString(versionSource, ['device_version'])
  if (firmwareVersion !== undefined) info.firmwareVersion = firmwareVersion
  const sdkVersion = pickString(versionSource, ['sdk_version'])
  if (sdkVersion !== undefined) info.sdkVersion = sdkVersion

  const basicSource = asRecord(basic) ?? {}
  const webVersion = pickString(basicSource, ['web_version'])
  if (webVersion !== undefined) info.webVersion = webVersion
  const lastUpgradeTime = pickString(basicSource, ['upgrade_time'])
  if (lastUpgradeTime !== undefined) info.lastUpgradeTime = lastUpgradeTime

  return info
}

/**
 * 映射 `GET /alarm_strategy_enable` 为「当前启用中的策略」视图。
 *
 * 返回体与 `/alarm_strategy` 同形，所以列表本身复用 `mapAlarmStrategyPage`；
 * 这里另外派生出 id 数组，让界面不必自己从 `enabled` 里筛。
 * 真机实测：没有任何策略启用时是空数组，而不是缺字段。
 */
export function mapEnabledStrategyView(dto: Fa371AlarmStrategyPageDto | undefined): CameraEnabledStrategyView {
  const items = mapAlarmStrategyPage(dto).items
  return { items, ids: enabledStrategyIds(items) }
}

// ---------------------------------------------------------------------------
// 检测日志（§5.1.17）
// ---------------------------------------------------------------------------

/** kind -> 线上文件名字段（§5.1.17 / §5.1.18）。 */
const RESULT_FILE_WIRE_KEYS: Readonly<Record<Fa371ResultFileKind, string>> = {
  power_spectrum_photo: 'power_spect_photo_name',
  power_spectrum_video: 'power_spect_video_name',
  soundmap_photo: 'soundmap_photo_name',
  soundmap_video: 'soundmap_video_name',
  voiceprint_photo: 'voiceprint_photo_name',
  voiceprint_video: 'voiceprint_video_name',
  bin_mic_data: 'bin_mic_data_name',
  wav_mic_data: 'wav_mic_data_name'
}

/** 一条检测日志映射后的可用文件清单（下载键见 §5.1.18）。 */
export function detectLogFiles(
  log: Fa371DetectLog
): Array<{ kind: Fa371ResultFileKind; fileName: string }> {
  return FA371_RESULT_FILE_KINDS.flatMap((kind) => {
    const fileName = log.resultFiles[kind]
    return fileName ? [{ kind, fileName }] : []
  })
}

/**
 * 判断一个对象是不是**裸日志对象**（§8.3 C14，P0）。
 *
 * 手册字段表说返回 `detect_logs` 数组，但 §5.1.17 的示例直接是一个裸对象，
 * 键就是 `bin_mic_data_name` 那一层。所以映射前必须先认形状。
 */
function looksLikeDetectLog(source: Record<string, unknown>): boolean {
  const hints = [
    'bin_mic_data_name',
    'wav_mic_data_name',
    'saving_path',
    'soundmap_photo_name',
    'power_spect_photo_name',
    'voiceprint_photo_name'
  ]
  return hints.some((key) => source[key] !== undefined)
}

/**
 * 映射 `GET /detect_logs` 的响应，**三种已见形状都接纳**（§8.3 C14/P0 + §5.2.3）：
 *   - `{ detect_logs: [ ... ] }` —— 字段表声明的数组形状；
 *   - `{ detect_logs: { ... } }` —— 单个对象被塞进复数键；
 *   - `{ detect_log: { ... } }`  —— §5.2.3 WebSocket 的单数包装；
 *   - 裸对象 `{ bin_mic_data_name: ..., ... }` —— §5.1.17 的示例。
 * 认不出来时返回空数组，绝不抛异常（响应形状本身就是要探测的对象）。
 */
export function mapDetectLogs(
  payload: unknown,
  options: Fa371MapOptions = {}
): Fa371DetectLog[] {
  if (payload === null || payload === undefined) return []
  if (Array.isArray(payload)) return payload.map((item) => mapDetectLog(item, options))
  if (typeof payload !== 'object') return []

  const source = asRecord(payload) ?? {}
  const container = source.detect_logs ?? source.detect_log

  if (Array.isArray(container)) {
    return container.map((item) => mapDetectLog(item, options))
  }
  const asObject = asRecord(container)
  if (asObject) return [mapDetectLog(asObject, options)]

  if (looksLikeDetectLog(source)) return [mapDetectLog(source, options)]
  return []
}

/**
 * 映射单条检测日志。
 *
 * §8.3 C15/C16（P0/P1）的容忍点：
 *   - 字段表列出的 9 个告警字段在两处示例里**一个都没有** → 全部可选，缺失即 undefined；
 *   - `files_status`（示例）与 `file_status`（字段表）**两种拼写都读**；
 *   - `start_time`/`end_time` 字段表标 string、示例是整数 → 两者都能解析；
 *   - `soundmap_intensity` 字段表标 int、示例是 `20.4` → 保留小数，不取整；
 *   - 时间戳单位未说明（§8.2 B5）→ 原样保留 `*Raw`，只有给了单位假设才产出换算值。
 */
export function mapDetectLog(
  raw: unknown,
  options: Fa371MapOptions = {}
): Fa371DetectLog {
  const source = asRecord(raw) ?? {}
  const timeUnit = options.timeUnit ?? DEFAULT_FA371_TIMESTAMP_UNIT

  const log: Fa371DetectLog = { timeUnit, resultFiles: {} }

  const id = pickNumber(source, ['id'])
  if (id !== undefined) log.id = id
  const detectMode = pickNumber(source, ['detect_mode'])
  if (detectMode !== undefined) log.detectMode = detectMode
  const status = pickNumber(source, ['status'])
  if (status !== undefined) log.status = status

  const startRaw = pickNumber(source, ['start_time'])
  if (startRaw !== undefined) {
    log.startTimeRaw = startRaw
    const converted = interpretFa371Timestamp(startRaw, timeUnit)
    if (converted !== undefined) log.startTime = converted
  }
  const endRaw = pickNumber(source, ['end_time'])
  if (endRaw !== undefined) {
    log.endTimeRaw = endRaw
    const converted = interpretFa371Timestamp(endRaw, timeUnit)
    if (converted !== undefined) log.endTime = converted
  }

  const filesStatus = pickNumber(source, ['files_status', 'file_status'])
  if (filesStatus !== undefined) {
    log.filesStatusRaw = filesStatus
    const key = lookupKey(FA371_FILE_STATUS_KEYS as Readonly<Record<number, string>>, filesStatus)
    if (key !== undefined) log.filesStatusKey = key
  }

  const intensity = pickNumber(source, ['soundmap_intensity'])
  if (intensity !== undefined) log.soundmapIntensity = intensity
  const savingPath = pickString(source, ['saving_path'])
  if (savingPath !== undefined) log.savingPath = savingPath

  for (const kind of FA371_RESULT_FILE_KINDS) {
    const wireKey = RESULT_FILE_WIRE_KEYS[kind]
    const name = pickString(source, [wireKey])
    if (name !== undefined) log.resultFiles[kind] = name
  }

  const leakVolume = pickNumber(source, ['data_1'])
  if (leakVolume !== undefined) log.leakVolume = leakVolume
  const leakCost = pickNumber(source, ['data_2'])
  if (leakCost !== undefined) log.leakCost = leakCost
  const leakUnit = pickNumber(source, ['data_3'])
  if (leakUnit !== undefined) log.leakUnit = leakUnit
  const leakCostUnit = pickNumber(source, ['data_4'])
  if (leakCostUnit !== undefined) log.leakCostUnit = leakCostUnit

  const alarmStrategyId = pickNumber(source, ['alarm_strategy_id'])
  if (alarmStrategyId !== undefined) log.alarmStrategyId = alarmStrategyId
  const alarmLevelRaw = pickNumber(source, ['alarm_level'])
  if (alarmLevelRaw !== undefined) {
    log.alarmLevelRaw = alarmLevelRaw
    const key = lookupKey(FA371_ALARM_LEVEL_KEYS as Readonly<Record<number, string>>, alarmLevelRaw)
    if (key !== undefined) log.alarmLevelKey = key
  }
  const ncFile = pickString(source, ['nc_file'])
  if (ncFile !== undefined) log.ncFile = ncFile
  const lastDb = pickNumber(source, ['last_alarm_db'])
  if (lastDb !== undefined) log.lastAlarmDb = lastDb
  const lastDf = pickNumber(source, ['last_alarm_df'])
  if (lastDf !== undefined) log.lastAlarmDf = lastDf
  const lastNc = pickNumber(source, ['last_alarm_nc'])
  if (lastNc !== undefined) log.lastAlarmNc = lastNc
  const isAlarm = pickBoolean(source, ['is_alarm'])
  if (isAlarm !== undefined) log.isAlarm = isAlarm
  const ncFilePath = pickString(source, ['nc_file_path'])
  if (ncFilePath !== undefined) log.ncFilePath = ncFilePath
  const ncFft = pickString(source, ['nc_file_fft_photo_name'])
  if (ncFft !== undefined) log.ncFileFftPhotoName = ncFft

  return log
}

/**
 * 拼接 `GET /detect_file/{saving_path}/{file_name}` 的路径部分（§5.1.18 缺口）。
 *
 * 手册的 `saving_path` 自带结尾 `/`（示例 `"2019_06_20_20_30_39_940/"`），
 * 直接字符串相加会产生双斜杠；这里统一规整。返回**未编码**的相对路径，
 * 编码由客户端逐段处理（整体编码会把 `/` 变成 `%2F`，设备就找不到文件了）。
 */
export function joinDetectFilePath(savingPath: string, fileName: string): string {
  const folder = savingPath.trim().replace(/^\/+/, '').replace(/\/+$/, '')
  const file = fileName.trim().replace(/^\/+/, '')
  if (file === '') return folder
  return folder === '' ? file : `${folder}/${file}`
}

/**
 * 读 `GET /detect_logs` 响应里的 `logs_count`。
 *
 * 为什么它是一个**读数**而不是分页信息：手册 §8.3 C14 说明这个接口**没有任何
 * 分页参数**（同一页还给出两种互相矛盾的 `detect_id` 传参方式），真机返回的是
 * 一个整批数组加一个计数。所以这里只把设备给它的数字原样取出来，
 * 绝不据此推断「还有下一页」。
 *
 * 键名与容错都在这一层：云端/固件换个拼写只影响本函数与 DTO。
 */
export function detectLogsCount(payload: unknown): number | undefined {
  const source = asRecord(payload)
  if (!source) return undefined
  return pickNumber(source, ['logs_count', 'log_count'])
}

// ---------------------------------------------------------------------------
// 系统时间（§5.1.20）
// ---------------------------------------------------------------------------

/**
 * 映射 `GET /system_time`（§8.3 C19，P0）。
 *
 * 示例 `sys_time: 17220332` 只有 8 位，既不是秒级也不是毫秒级。
 * 默认单位 `unknown` → **不产出 `epochMs`**：把 17220332 当秒会得到 1970 年，
 * 那不是"近似正确"，是错的。
 */
export function mapSystemTime(
  dto: Fa371SystemTimeDto | undefined,
  options: Fa371MapOptions = {}
): Fa371SystemTime {
  const source = asRecord(dto) ?? {}
  const raw = pickNumber(source, ['sys_time'])
  const unit = options.timeUnit ?? DEFAULT_FA371_TIMESTAMP_UNIT
  const result: Fa371SystemTime = { unit }
  if (raw !== undefined) result.raw = raw
  const epochMs = interpretFa371Timestamp(raw, unit)
  if (epochMs !== undefined) result.epochMs = epochMs
  return result
}

// ---------------------------------------------------------------------------
// 告警策略（§5.1.22）
// ---------------------------------------------------------------------------

/**
 * 映射一条告警策略。
 *
 * §8.3 C21（P0）：读取侧 `id` 标 string、`PUT` 标 integer → id 统一归一化成字符串，
 * 并用 `rawIdType` 保留原始类型，调用方写回时才能选对形状。
 * `level` 读侧 `0,1,2,3` vs 写侧 `1,2,3,4` 冲突 → **不做偏移**，0 只会得到
 * `undefined` 的 `levelKey`（`FA371_ALARM_LEVEL_KEYS` 里没有 0）。
 */
export function mapAlarmStrategy(dto: Fa371AlarmStrategyDto | undefined): Fa371AlarmStrategy {
  const source = asRecord(dto) ?? {}
  const strategy: Fa371AlarmStrategy = {}

  const rawId = pick(source, ['id'])
  if (rawId === undefined) {
    strategy.rawIdType = 'absent'
  } else {
    strategy.id = String(rawId)
    strategy.rawIdType = typeof rawId === 'number' ? 'number' : 'string'
  }

  const name = pickString(source, ['name'])
  if (name !== undefined) strategy.name = name
  const alias = pickString(source, ['alias'])
  if (alias !== undefined) strategy.alias = alias

  const conditionId = pickNumber(source, ['alarm_condition_id', 'alarm_id'])
  if (conditionId !== undefined) strategy.alarmConditionId = conditionId
  const conditionName = pickString(source, ['alarm_condition_name'])
  if (conditionName !== undefined) strategy.alarmConditionName = conditionName

  const interval = pickNumber(source, ['interval_time'])
  if (interval !== undefined) strategy.intervalTime = interval
  // 读取侧大写 `Times`，写入侧小写 `times`（手册原文如此）。
  const times = pickNumber(source, ['Times', 'times'])
  if (times !== undefined) strategy.times = times
  const timeout = pickNumber(source, ['timeout_duration'])
  if (timeout !== undefined) strategy.timeoutDuration = timeout
  const sensitivity = pickNumber(source, ['sensitivity'])
  if (sensitivity !== undefined) strategy.sensitivity = sensitivity

  const level = pickNumber(source, ['level'])
  if (level !== undefined) {
    strategy.level = level
    const key = lookupKey(FA371_ALARM_LEVEL_KEYS as Readonly<Record<number, string>>, level)
    if (key !== undefined) strategy.levelKey = key
  }

  const diagnosis = pickString(source, ['diagnosis', 'diagosisn'])
  if (diagnosis !== undefined) strategy.diagnosis = diagnosis
  // 大写 `Switch` 是手册原文。这里读到的是**列表页的副本**；"当前启用的是哪一条"
  // 以 `GET /alarm_strategy_enable` 为准（`mapEnabledStrategyView`），
  // 启停走 `PUT /alarm_strategy_enable`。旧规格曾断言没有启停端点（缺口 C33），
  // 已被 2026-09 的新手册证伪（`docs/FA371-API-DELTA.md` §1）。
  const enabled = pickBoolean(source, ['Switch', 'switch'])
  if (enabled !== undefined) strategy.enabled = enabled

  return strategy
}

/** 映射 `GET /alarm_strategy?page=`（§5.1.22 手册无返回示例 → 列表缺失即空数组）。 */
export function mapAlarmStrategyPage(dto: Fa371AlarmStrategyPageDto | undefined): Fa371AlarmStrategyPage {
  const source = asRecord(dto) ?? {}
  const list = Array.isArray(source.alarm_strategy_list) ? source.alarm_strategy_list : []
  const page: Fa371AlarmStrategyPage = {
    items: list.map((item) => mapAlarmStrategy(item as Fa371AlarmStrategyDto))
  }
  const pageTotal = pickNumber(source, ['page_total'])
  if (pageTotal !== undefined) page.pageTotal = pageTotal
  return page
}

// ---------------------------------------------------------------------------
// 告警条件（§5.1.26）
// ---------------------------------------------------------------------------

/**
 * 映射一条告警条件。
 *
 * §8.3 C26（P0）：`discharge_*` 三字段**读取侧不存在**（写读不对称），
 * 所以这里永远不产出 `discharge`；写入时由请求 DTO 携带。
 * §8.3 C28：`nc_arithmetic_operator` 读取侧手册只写符号、未给数字枚举，
 * 因此按写入侧明确的 `0` = `>`、`1` = `<` 查表，查不到就是 `undefined`。
 */
export function mapAlarmCondition(
  dto: Fa371AlarmConditionDto | undefined,
  options: Fa371MapOptions = {}
): Fa371AlarmCondition {
  const source = asRecord(dto) ?? {}
  const operators = arithmeticOperatorTable(options.arithmeticOperatorCandidate)
  const condition: Fa371AlarmCondition = {}

  const id = pickNumber(source, ['id'])
  if (id !== undefined) condition.id = id
  const name = pickString(source, ['name'])
  if (name !== undefined) condition.name = name

  const decibel = pickNumber(source, ['decibel_thr'])
  if (decibel !== undefined) condition.decibelThreshold = decibel
  const dbOperator = pickNumber(source, ['db_arithmetic_operator'])
  if (dbOperator !== undefined) condition.dbOperatorKey = operators[dbOperator]
  const dbSwitch = pickBoolean(source, ['db_switch'])
  if (dbSwitch !== undefined) condition.dbSwitch = dbSwitch

  const dominant = pickNumber(source, ['dominant_freq_thr'])
  if (dominant !== undefined) condition.dominantFreqThreshold = dominant
  const dfOperator = pickNumber(source, ['df_arithmetic_operator'])
  if (dfOperator !== undefined) condition.dfOperatorKey = operators[dfOperator]
  const dfSwitch = pickBoolean(source, ['df_switch'])
  if (dfSwitch !== undefined) condition.dfSwitch = dfSwitch
  const dfLogical = pickNumber(source, ['df_logical_operator'])
  if (dfLogical !== undefined) {
    condition.dfLogicalOperatorKey = lookupKey(
      FA371_LOGICAL_OPERATOR_KEYS as Readonly<Record<number, string>>,
      dfLogical
    )
  }

  const ncFileId = pickNumber(source, ['noise_comparison_file_id'])
  if (ncFileId !== undefined) condition.noiseComparisonFileId = ncFileId
  const ncThr = pickNumber(source, ['noise_comparison_thr'])
  if (ncThr !== undefined) condition.ncSimilarityThreshold = ncThr
  const ncSwitch = pickBoolean(source, ['nc_switch'])
  if (ncSwitch !== undefined) condition.ncSwitch = ncSwitch
  const ncLogical = pickNumber(source, ['nc_logical_operator'])
  if (ncLogical !== undefined) {
    condition.ncLogicalOperatorKey = lookupKey(
      FA371_LOGICAL_OPERATOR_KEYS as Readonly<Record<number, string>>,
      ncLogical
    )
  }
  const ncOperator = pickNumber(source, ['nc_arithmetic_operator'])
  if (ncOperator !== undefined) {
    condition.ncOperatorKey = lookupKey(
      FA371_NC_ARITHMETIC_OPERATOR_KEYS as Readonly<Record<number, string>>,
      ncOperator
    )
  }

  const notes = pickString(source, ['Notes', 'notes'])
  if (notes !== undefined) condition.notes = notes

  return condition
}

/** 映射 `GET /alarm_condition?page=`。 */
export function mapAlarmConditionPage(
  dto: Fa371AlarmConditionPageDto | undefined,
  options: Fa371MapOptions = {}
): Fa371AlarmConditionPage {
  const source = asRecord(dto) ?? {}
  const list = Array.isArray(source.alarm_condition_list) ? source.alarm_condition_list : []
  const page: Fa371AlarmConditionPage = {
    items: list.map((item) => mapAlarmCondition(item as Fa371AlarmConditionDto, options))
  }
  const pageTotal = pickNumber(source, ['page_total'])
  if (pageTotal !== undefined) page.pageTotal = pageTotal
  return page
}

/**
 * 把放电类型原始取值映射成稳定 KEY（§8.3 C27：枚举缺 `3`）。
 * 未命中（包括 `3`）返回 `undefined`，不就近取整。
 */
export function mapDischargeTypeKey(value: number | undefined): string | undefined {
  return lookupKey(FA371_DISCHARGE_TYPE_KEYS as Readonly<Record<number, string>>, value)
}

// ---------------------------------------------------------------------------
// 噪声比对文件（§5.1.31）
// ---------------------------------------------------------------------------

/**
 * 映射一条比对文件（§8.3 C32，P1：`file_size`/`samplerate`/`Duration` 的单位
 * **全部未说明**）。三个数值一律以 `*Raw` 命名原样保留，不做任何换算。
 */
export function mapNcFile(dto: Fa371NcFileDto | undefined): Fa371NcFile {
  const source = asRecord(dto) ?? {}
  const file: Fa371NcFile = {}
  const id = pickNumber(source, ['id'])
  if (id !== undefined) file.id = id
  const name = pickString(source, ['file_name'])
  if (name !== undefined) file.fileName = name
  const size = pickNumber(source, ['file_size'])
  if (size !== undefined) file.fileSizeRaw = size
  const sampleRate = pickNumber(source, ['samplerate'])
  if (sampleRate !== undefined) file.sampleRateRaw = sampleRate
  // 大写 `Duration` / `Notes` 是手册原文。
  const duration = pickNumber(source, ['Duration', 'duration'])
  if (duration !== undefined) file.durationRaw = duration
  const notes = pickString(source, ['Notes', 'notes'])
  if (notes !== undefined) file.notes = notes
  return file
}

/** 映射 `GET /nc_filelist?page=`（每页默认 10 条，§5.1.31）。 */
export function mapNcFilePage(dto: Fa371NcFilePageDto | undefined): Fa371NcFilePage {
  const source = asRecord(dto) ?? {}
  const list = Array.isArray(source.nc_file_list) ? source.nc_file_list : []
  const page: Fa371NcFilePage = { items: list.map((item) => mapNcFile(item as Fa371NcFileDto)) }
  const pageTotal = pickNumber(source, ['page_total'])
  if (pageTotal !== undefined) page.pageTotal = pageTotal
  return page
}
