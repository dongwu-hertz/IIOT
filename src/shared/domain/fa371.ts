/**
 * FA371 在线声学相机 —— 领域模型（Domain Model）。
 *
 * 契约链（spec section 7 / appendix C rule 2）：
 *   协议 DTO  ->  Mapper  ->  [本文件]  ->  Store  ->  UI
 *
 * 硬规则：**本文件不得出现任何固件/手册的线上键名**。
 * 手册写 `freq_up_limit`、`target_numbe`、`diagosisn`、`Switch` 的地方，
 * DTO 保留原样，mapper 产出这里的 camelCase 字段。固件改名只影响 DTO + mapper。
 *
 * 第二条硬规则：**本层不放人类可读文案**。枚举只暴露稳定的 label KEY
 * （`FA371_*_KEYS` / `*_KEY` 值），渲染层用 `domain.fa371.*` 之类的键去翻译。
 * 这条规则由 `tests/i18n.test.ts` 守护：这里的键必须是纯标识符，
 * 一旦有人塞进中文/英文句子就会失败。
 *
 * 手册未定义处（规格 §8）在本层体现为**显式的不确定性字段**，
 * 例如 `sampleRateUnit` / `timeUnit` / `coordinateSpace`：调用方永远看得到
 * "这个值是按什么假设解读的"，而不是拿到一个装作确定的数字。
 */

// ---------------------------------------------------------------------------
// 不确定性枚举（规格 §8）
// ---------------------------------------------------------------------------

/**
 * 时间戳单位。规格 §8.2 B5 / §8.3 C19：`sys_time`/`time`/`start_time`/`end_time`
 * 的**单位与时区全部未说明**，`sys_time: 17220332` 只有 8 位，既不像秒级也不像
 * 毫秒级。因此领域模型不允许默认按秒解读，只能带着"假设"出场。
 */
export type Fa371TimestampUnit = 'epoch_seconds' | 'epoch_milliseconds' | 'unknown'

export const FA371_TIMESTAMP_UNITS: readonly Fa371TimestampUnit[] = [
  'epoch_seconds',
  'epoch_milliseconds',
  'unknown'
]

/**
 * `samplerate` 的单位。规格 §8.3 C1（P0）：字段说明写 KHz，取值却是
 * 96000 / 132000（示例又写 13200），量纲自相矛盾 → 未实测前只能是 `unknown`。
 */
export type Fa371SampleRateUnit = 'hz' | 'khz' | 'unknown'

export const FA371_SAMPLE_RATE_UNITS: readonly Fa371SampleRateUnit[] = ['hz', 'khz', 'unknown']

/**
 * `/system/scan_area` 的坐标系。规格 §8.3 C9/C10（P0）：坐标单位与参考系未知，
 * GET 示例横轴到 1232（暗示基准约 1920）、纵轴到 872（与 1080 不吻合）。
 */
export type Fa371ScanAreaCoordinateSpace = 'pixel_video_frame' | 'unverified'

export const FA371_SCAN_AREA_COORDINATE_SPACES: readonly Fa371ScanAreaCoordinateSpace[] = [
  'pixel_video_frame',
  'unverified'
]

// ---------------------------------------------------------------------------
// 通用枚举
// ---------------------------------------------------------------------------

/**
 * 运行模式（规格 §5.1.8）：`1` 单次检测模式；`-1` 智能巡航模式。
 * 取值不连续，所以用 const 对象而非常规 enum，键映射保持 total。
 */
export const Fa371RunMode = {
  SingleDetection: 1,
  IntelligentCruise: -1
} as const

export type Fa371RunModeValue = (typeof Fa371RunMode)[keyof typeof Fa371RunMode]

/** 稳定 label KEY，渲染层按 `domain.fa371.runMode.<key>` 翻译。 */
export const FA371_RUN_MODE_KEYS: Record<Fa371RunModeValue, string> = {
  [Fa371RunMode.SingleDetection]: 'single_detection',
  [Fa371RunMode.IntelligentCruise]: 'intelligent_cruise'
}

/** 运行模式（规格 §5.1.8）的解读结果。 */
export interface Fa371RunModeConfig {
  /** 原始取值（`1` 或 `-1`）。 */
  raw?: number
  /** 命中的枚举值；既不是 1 也不是 -1 时为 `undefined`（不猜）。 */
  mode?: Fa371RunModeValue
  /** 稳定 label KEY。 */
  key?: string
}

/**
 * 应用模式（`GET` / `PUT /system`）—— **手册未收录、真机实测**。
 *
 * ⚠ 与上面那个 `Fa371RunMode`（**检测模式**，手册 §5.1.8 的 `/run_mode`）是两件
 * 完全不同的事，名字容易被混：
 *   - `Fa371RunMode` = 检测怎么跑（单次检测 / 智能巡航），手册里有；
 *   - `Fa371WorkMode` = 这台设备在做**哪种应用**（局部放电 / 气体泄漏 / 机械异响），
 *     手册里**没有**，端点是读设备自带前端的 bundle 找到的。
 *
 * 端点与取值依据（全部来自真机实测，不是推断）：
 *   - `GET /system` 回 `{"msg":"SUCCESS","ret":200,"work_mode":1}`；
 *   - `PUT /system {"work_mode":N}` 三值都实测生效（`1`/`2`/`3` → 重读一致）；
 *   - 值到名称的映射逐字来自设备自己的前端代码：
 *     `1 == t ? PartialDischargeDetectionMode : 2 == t ? LeakDetectionMode
 *     : MechanicalNoiseDetectionMode`。
 *
 * **其它任何取值都不映射**（见 `mapWorkMode`）：设备前端把"非 1 非 2"一律渲染成
 * 机械异响，但本软件**不照抄这个兜底** —— 一个没见过的数字（比如固件以后加了
 * `0`）究竟是不是机械异响，没有任何依据，所以只保留原始值 + 让它保持未映射。
 */
export const Fa371WorkMode = {
  /** 局部放电检测模式。 */
  PartialDischarge: 1,
  /** 气体泄漏检测。 */
  GasLeak: 2,
  /** 机械异响检测模式（设备自己的前端把"非 1 非 2"都显示成它，本软件不照抄这条兜底）。 */
  MechanicalNoise: 3
} as const

export type Fa371WorkModeValue = (typeof Fa371WorkMode)[keyof typeof Fa371WorkMode]

/** 稳定 label KEY，渲染层按 `cameraControlUi.workMode*` 翻译。 */
export const FA371_WORK_MODE_KEYS: Record<Fa371WorkModeValue, string> = {
  [Fa371WorkMode.PartialDischarge]: 'partial_discharge',
  [Fa371WorkMode.GasLeak]: 'gas_leak',
  [Fa371WorkMode.MechanicalNoise]: 'mechanical'
}

/**
 * 三个可写入的应用模式（测试与界面都用这份数据，避免各写一份 `[1,2,3]`）。
 *
 * 这是一份显式数据而不是从 `FA371_WORK_MODE_KEYS` 派生：那份表的键就是这三个值，
 * 但类型在编译后消失，而"软件只写这三个值"这条规矩值得被运行时断言。
 */
export const FA371_WORK_MODES: readonly Fa371WorkModeValue[] = [
  Fa371WorkMode.PartialDischarge,
  Fa371WorkMode.GasLeak,
  Fa371WorkMode.MechanicalNoise
]

/**
 * 应用模式（`GET /system`）的解读结果。
 *
 * 与 `Fa371RunModeConfig` 同一条规矩：**认不出的取值只留 `raw`**，
 * `mode` / `key` 保持缺省，界面据此如实显示"设备返回了 N"，而不是就近猜一个模式。
 * 字段整个缺席时三个都是 `undefined`。
 */
export interface Fa371WorkModeConfig {
  /** 原始取值（实测是 `1`/`2`/`3`）。 */
  raw?: number
  /** 命中的枚举值；不是 1/2/3 时为 `undefined`（不猜）。 */
  mode?: Fa371WorkModeValue
  /** 稳定 label KEY（`partial_discharge` / `gas_leak` / `mechanical`）。 */
  key?: string
}

/** 视频翻转模式（规格 §5.1.6）：0 默认 / 1 垂直 / 2 水平 / 3 180°。 */
export const Fa371VideoFlip = {
  Normal: 0,
  Vertical: 1,
  Horizontal: 2,
  Rotate180: 3
} as const

export type Fa371VideoFlipValue = (typeof Fa371VideoFlip)[keyof typeof Fa371VideoFlip]

export const FA371_VIDEO_FLIP_KEYS: Record<Fa371VideoFlipValue, string> = {
  [Fa371VideoFlip.Normal]: 'normal',
  [Fa371VideoFlip.Vertical]: 'vertical',
  [Fa371VideoFlip.Horizontal]: 'horizontal',
  [Fa371VideoFlip.Rotate180]: 'rotate_180'
}

/** 泄漏估算单位（规格 §5.1.10）：`0` = l/min，`1` = ml/s。 */
export const Fa371LeakageUnit = {
  LitrePerMinute: 0,
  MillilitrePerSecond: 1
} as const

export type Fa371LeakageUnitValue = (typeof Fa371LeakageUnit)[keyof typeof Fa371LeakageUnit]

export const FA371_LEAKAGE_UNIT_KEYS: Record<Fa371LeakageUnitValue, string> = {
  [Fa371LeakageUnit.LitrePerMinute]: 'litre_per_min',
  [Fa371LeakageUnit.MillilitrePerSecond]: 'millilitre_per_second'
}

/** 货币单位（规格 §5.1.10）：`0` ¥ / `1` £ / `2` $ / `3` € / `4` ₽。 */
export const Fa371MonetaryUnit = {
  CNY: 0,
  GBP: 1,
  USD: 2,
  EUR: 3,
  RUB: 4
} as const

export type Fa371MonetaryUnitValue = (typeof Fa371MonetaryUnit)[keyof typeof Fa371MonetaryUnit]

export const FA371_MONETARY_UNIT_KEYS: Record<Fa371MonetaryUnitValue, string> = {
  [Fa371MonetaryUnit.CNY]: 'cny',
  [Fa371MonetaryUnit.GBP]: 'gbp',
  [Fa371MonetaryUnit.USD]: 'usd',
  [Fa371MonetaryUnit.EUR]: 'eur',
  [Fa371MonetaryUnit.RUB]: 'rub'
}

/** 检测区绘制状态（规格 §5.1.12）：`0` 隐藏 / `1` 显示。 */
export const Fa371DrawStatus = {
  Hidden: 0,
  Visible: 1
} as const

export type Fa371DrawStatusValue = (typeof Fa371DrawStatus)[keyof typeof Fa371DrawStatus]

export const FA371_DRAW_STATUS_KEYS: Record<Fa371DrawStatusValue, string> = {
  [Fa371DrawStatus.Hidden]: 'hidden',
  [Fa371DrawStatus.Visible]: 'visible'
}

/** 框选模式（规格 §5.1.12）：`1` 中心聚焦 / `2` 框选。 */
export const Fa371CenterFocus = {
  Center: 1,
  Box: 2
} as const

export type Fa371CenterFocusValue = (typeof Fa371CenterFocus)[keyof typeof Fa371CenterFocus]

export const FA371_CENTER_FOCUS_KEYS: Record<Fa371CenterFocusValue, string> = {
  [Fa371CenterFocus.Center]: 'center_focus',
  [Fa371CenterFocus.Box]: 'box_select'
}

/** 结果文件保存状态（规格 §5.1.17）：`0` 已删除 / `1` 已保存。 */
export const Fa371FileStatus = {
  Deleted: 0,
  Saved: 1
} as const

export type Fa371FileStatusValue = (typeof Fa371FileStatus)[keyof typeof Fa371FileStatus]

export const FA371_FILE_STATUS_KEYS: Record<Fa371FileStatusValue, string> = {
  [Fa371FileStatus.Deleted]: 'deleted',
  [Fa371FileStatus.Saved]: 'saved'
}

/**
 * 算术运算符（规格 §5.1.26 / §5.1.27）：`(0-4)` 对应 `>, <, =, >=, <=`。
 *
 * 注意：手册把符号**按顺序列成一张表**，并没有逐一给出数字配对。
 * 只有 `nc_arithmetic_operator` 在写入侧明确写了 `0` = `>`、`1` = `<`
 * （与这里的前两项一致，是唯一的旁证）。因此这里的配对是一份**具名假设**，
 * 见 `mappers.FA371_ARITHMETIC_OPERATOR_KEYS` 与 §8.3 C28。
 */
export const Fa371ArithmeticOperator = {
  GreaterThan: 0,
  LessThan: 1,
  Equal: 2,
  GreaterOrEqual: 3,
  LessOrEqual: 4
} as const

export type Fa371ArithmeticOperatorValue =
  (typeof Fa371ArithmeticOperator)[keyof typeof Fa371ArithmeticOperator]

export const FA371_ARITHMETIC_OPERATOR_KEYS: Record<Fa371ArithmeticOperatorValue, string> = {
  [Fa371ArithmeticOperator.GreaterThan]: 'greater_than',
  [Fa371ArithmeticOperator.LessThan]: 'less_than',
  [Fa371ArithmeticOperator.Equal]: 'equal',
  [Fa371ArithmeticOperator.GreaterOrEqual]: 'greater_or_equal',
  [Fa371ArithmeticOperator.LessOrEqual]: 'less_or_equal'
}

/** 逻辑运算符（规格 §5.1.26/§5.1.27）：`0` = `||`，`1` = `&&`。 */
export const Fa371LogicalOperator = {
  Or: 0,
  And: 1
} as const

export type Fa371LogicalOperatorValue =
  (typeof Fa371LogicalOperator)[keyof typeof Fa371LogicalOperator]

export const FA371_LOGICAL_OPERATOR_KEYS: Record<Fa371LogicalOperatorValue, string> = {
  [Fa371LogicalOperator.Or]: 'or',
  [Fa371LogicalOperator.And]: 'and'
}

/** 噪声比对算术运算符（写入侧明确 `0` = `>`、`1` = `<`）。 */
export const FA371_NC_ARITHMETIC_OPERATOR_KEYS: Record<0 | 1, string> = {
  0: 'greater_than',
  1: 'less_than'
}

/**
 * 放电类型（规格 §5.1.27）：`0` 电晕 / `1` 悬浮 / `2` 沿面 / `4` 放电。
 * 枚举**缺 `3`**（§8.3 C27），所以这里不是连续 Record，查不到的取值一律
 * 归为未知而不是就近取整。
 */
export const FA371_DISCHARGE_TYPE_KEYS: Record<0 | 1 | 2 | 4, string> = {
  0: 'corona',
  1: 'suspension',
  2: 'surface',
  4: 'discharge'
}

/**
 * 告警等级（规格 §8.3 C21，P0）：字段表读侧写 `0,1,2,3`，写侧（§5.1.23/§5.1.25）
 * 写 `1,2,3,4`。两套取值集合冲突，**不做静默偏移**：这里只给出 1..4 的键，
 * 读到的 `0` 一律是 `unknown`，由协议实测决定真实语义。
 */
export const Fa371AlarmLevel = {
  Level1: 1,
  Level2: 2,
  Level3: 3,
  Level4: 4
} as const

export type Fa371AlarmLevelValue = (typeof Fa371AlarmLevel)[keyof typeof Fa371AlarmLevel]

export const FA371_ALARM_LEVEL_KEYS: Record<Fa371AlarmLevelValue, string> = {
  [Fa371AlarmLevel.Level1]: 'level_1',
  [Fa371AlarmLevel.Level2]: 'level_2',
  [Fa371AlarmLevel.Level3]: 'level_3',
  [Fa371AlarmLevel.Level4]: 'level_4'
}

/**
 * 检测结果文件的种类。
 *
 * 每条检测日志最多带 8 个文件名（规格 §5.1.17），下载走 §5.1.18
 * `GET /detect_file/{saving_path}/{file_name}`。用固定的 kind 列表而不是
 * 8 个并列域字段，是为了让 UI 只写一次"渲染可用文件"的逻辑。
 */
export type Fa371ResultFileKind =
  | 'power_spectrum_photo'
  | 'power_spectrum_video'
  | 'soundmap_photo'
  | 'soundmap_video'
  | 'voiceprint_photo'
  | 'voiceprint_video'
  | 'bin_mic_data'
  | 'wav_mic_data'

export const FA371_RESULT_FILE_KINDS: readonly Fa371ResultFileKind[] = [
  'power_spectrum_photo',
  'power_spectrum_video',
  'soundmap_photo',
  'soundmap_video',
  'voiceprint_photo',
  'voiceprint_video',
  'bin_mic_data',
  'wav_mic_data'
]

/** 响应字段 `target_numbe`（字段表）还是 `target_number`（示例）被用上了。 */
export type Fa371ImagingTargetKeyUsed = 'target_number' | 'target_numbe' | 'absent'

// ---------------------------------------------------------------------------
// 声场配置（§5.1.2 / §5.1.3）
// ---------------------------------------------------------------------------

export interface Fa371AcousticConfig {
  /** 原始采样率数值，**不做单位换算**（§8.3 C1）。 */
  sampleRateRaw?: number
  /** 这个数值是按什么单位解读的；未实测前是 `unknown`。 */
  sampleRateUnit: Fa371SampleRateUnit
  /** 分析频带上限，手册标 KHz。 */
  freqUpLimit?: number
  /** 分析频带下限，手册标 KHz。 */
  freqDownLimit?: number
  /** `freqUpLimit - freqDownLimit`，两侧都有值时才存在。 */
  bandWidth?: number
}

// ---------------------------------------------------------------------------
// 成像配置（§5.1.4 / §5.1.5）
// ---------------------------------------------------------------------------

export interface Fa371ImagingConfig {
  /** 成像阈值（范围/单位未说明，§8.3 C3）。 */
  energyThreshold?: number
  /**
   * 检测目标数量。字段表声明这个键存在，示例却只给 `target_number`，
   * 且 `imaging_sensitivity`/`imaging_enhance` 在示例里完全缺席（§8.3 C2）。
   */
  targetCount?: number
  /** 目标数量是从哪个键读到的；`absent` 表示设备压根没回这个字段。 */
  targetCountKeyUsed: Fa371ImagingTargetKeyUsed
  /** 成像滤波灵敏度 `[0,2]`。 */
  imagingSensitivity?: number
  /** 成像增强 `[0,2]`，`0` = off。 */
  imagingEnhance?: number
}

// ---------------------------------------------------------------------------
// 视频与 RTSP 配置（§5.1.6 / §5.1.7）
// ---------------------------------------------------------------------------

export interface Fa371VideoConfig {
  bitRate?: number
  fps?: number
  width?: number
  height?: number
  /** 原始翻转模式取值。 */
  flipModel?: number
  /** 稳定 label KEY；取值不在 0..3 时为 `undefined`（不猜）。 */
  flipModelKey?: string
  rtspPort?: number
  /**
   * RTSP 路径。手册字段表标 integer、示例却是字符串 `"live"`（§8.3 C4），
   * 归一化后始终是字符串；无法解析时才是 `undefined`。
   */
  rtspPath?: string
  rtspEnabled?: boolean
  /** 只读计数（§8.3 C5：写侧字段表未列，示例却发了它）。 */
  rtspConnectedCount?: number
  rtspClientLimit?: number
}

/**
 * 一条 RTSP URL 候选（规格 §8.5 E2，P0：手册**没有给出**完整拼装规则，
 * 只散落给了 `video_port` + `video_url`，且是否需用户名口令未说明）。
 * 由 `mappers.buildRtspUrlCandidates` 生成，调用方逐条实测。
 */
export interface Fa371RtspUrlCandidate {
  /** 候选标识，同时是稳定 label KEY。 */
  id: string
  url: string
  /** 该候选的补充假设（不含口令；仅描述形状）。 */
  assumeCredentials: boolean
}

// ---------------------------------------------------------------------------
// 泄漏估算配置（§5.1.10 / §5.1.11）
// ---------------------------------------------------------------------------

export interface Fa371LeakageUnitView {
  /** 设备回的代码值（`0`/`1`）。 */
  code?: number
  /** 代码对应的稳定 label KEY。 */
  codeKey?: string
  /** 设备回显的字符串（`l/min` / `ml/s`）。始终原样保留。 */
  label?: string
  /**
   * 代码与字符串是否自洽。§8.3 C7：示例里 `leakage_unit: 1` 配 `"l/min"`、
   * `monetary_unit: 1` 配 `"CNY"`，**示例与枚举不一致**。
   * 这里是 `false` 时，说明设备回显本身矛盾——绝不能静默按其中一个"修正"。
   */
  codeMatchesLabel?: boolean
}

export interface Fa371LeakageConfig {
  costDisplay?: boolean
  distanceM?: number
  unit?: Fa371LeakageUnitView
  monetaryUnit?: Fa371LeakageUnitView
  valueOfGas?: number
  energyCost?: number
  specificPower?: number
  workingHours?: number
}

// ---------------------------------------------------------------------------
// 检测区域（§5.1.12 / §5.1.13）
// ---------------------------------------------------------------------------

export interface Fa371ScanRect {
  height?: number
  width?: number
  /** 原始绘制状态取值。 */
  drawStatus?: number
  /** 稳定 label KEY。 */
  drawStatusKey?: string
  leftTopX?: number
  leftTopY?: number
}

export interface Fa371ScanArea {
  /** 设备没回 `areas` 时是空数组，绝不是 `undefined`（避免 UI 到处判空）。 */
  areas: Fa371ScanRect[]
  centerFocusCode?: number
  centerFocusKey?: string
  /** 这份坐标是按哪个参考系解读的（§8.3 C9/C10）。 */
  coordinateSpace: Fa371ScanAreaCoordinateSpace
}

// ---------------------------------------------------------------------------
// 检测状态与启停（§5.1.14 – §5.1.16）
// ---------------------------------------------------------------------------

export interface Fa371DetectStatus {
  /** 归一化后的布尔值（设备给 `0`/`1`，字段表却标 `boolean`，§8.3 C13）。 */
  detecting: boolean
  /** 响应里**是否**出现了 `ret`/`msg`——§5.1.16 是本组唯一没有的接口。 */
  retPresent: boolean
}

/** `POST /turn_on_detect` 的结果（§5.1.14）。 */
export interface Fa371DetectionResult {
  /** 仅单次检测模式返回；巡航模式下是缺字段还是 `0` 未说明（§8.3 C11）。 */
  detectId?: number
}

// ---------------------------------------------------------------------------
// 检测日志（§5.1.17）
// ---------------------------------------------------------------------------

export interface Fa371DetectLog {
  id?: number
  /** 检测模式原始取值；§8.3 C16 说示例 `2` 的枚举含义未说明，故不做键映射。 */
  detectMode?: number
  status?: number
  /** 原始时间戳（未做单位换算）。 */
  startTimeRaw?: number
  endTimeRaw?: number
  /** 仅在调用方给出单位假设时才存在（§8.3 C19 / §8.2 B5）。 */
  startTime?: number
  endTime?: number
  /** 解读上面两个时间戳所用的假设。 */
  timeUnit: Fa371TimestampUnit
  filesStatusRaw?: number
  filesStatusKey?: string
  soundmapIntensity?: number
  savingPath?: string
  /** 可用结果文件：kind -> 文件名（§5.1.18 的下载键）。 */
  resultFiles: Partial<Record<Fa371ResultFileKind, string>>
  /** `data_1`~`data_4`：泄漏量 / 泄漏成本 / 泄漏单位 / 成本单位。 */
  leakVolume?: number
  leakCost?: number
  leakUnit?: number
  leakCostUnit?: number
  // -- 字段表声明但示例里从没出现过的告警字段（§8.3 C15） ------------------
  alarmStrategyId?: number
  alarmLevelRaw?: number
  alarmLevelKey?: string
  ncFile?: string
  lastAlarmDb?: number
  lastAlarmDf?: number
  lastAlarmNc?: number
  isAlarm?: boolean
  ncFilePath?: string
  ncFileFftPhotoName?: string
}

// ---------------------------------------------------------------------------
// 系统时间（§5.1.20 / §5.1.21）
// ---------------------------------------------------------------------------

export interface Fa371SystemTime {
  /** 原始 `sys_time` 数值（8 位示例见 §8.3 C19），原样保留。 */
  raw?: number
  unit: Fa371TimestampUnit
  /** 只有单位已知时才存在。 */
  epochMs?: number
}

// ---------------------------------------------------------------------------
// 告警策略与条件（§5.1.22 – §5.1.29）
// ---------------------------------------------------------------------------

export interface Fa371AlarmStrategy {
  /**
   * 策略 id，**统一归一化为字符串**（§8.3 C21：读取侧字段表标 string、
   * PUT 侧标 integer，两侧都可能是数字或字符串）。
   */
  id?: string
  /** 原始 id 的类型，供调用方决定写回时用什么形状。 */
  rawIdType?: 'string' | 'number' | 'absent'
  name?: string
  alias?: string
  /** 关联的告警条件 id（写入侧字段名是 `alarm_id`）。 */
  alarmConditionId?: number
  alarmConditionName?: string
  intervalTime?: number
  /** 手册里的"序号"（写入侧小写 `times`，读取侧大写 `Times`）。 */
  times?: number
  timeoutDuration?: number
  sensitivity?: number
  level?: number
  levelKey?: string
  diagnosis?: string
  /** 由读取侧的 `Switch` 归一化：`1` 开 / `0` 关。 */
  enabled?: boolean
}

export interface Fa371AlarmStrategyPage {
  items: Fa371AlarmStrategy[]
  pageTotal?: number
}

/**
 * 放电相关字段（规格 §8.3 C26，P0）：**只出现在写入接口**
 * `POST/PUT /alarm_condition`，§5.1.26 的读取字段表与 §4.4 的 UI 描述都没有它们
 * ——写读不对称。因此它在本模型里是**可选的写入参数**，读回来永远是 `undefined`。
 */
export interface Fa371AlarmConditionDischarge {
  /** 手册类型标 string、取值 `0`/`1`。 */
  switchRaw?: number
  logicalOperatorKey?: string
  /** 稳定 label KEY；枚举缺 `3`（§8.3 C27），未命中时为 `undefined`。 */
  typeKey?: string
}

export interface Fa371AlarmCondition {
  id?: number
  name?: string
  /** dB 告警值（合法区间未说明，§8.3 C28）。 */
  decibelThreshold?: number
  dbOperatorKey?: string
  dbSwitch?: boolean
  /** 主频告警值（Hz / kHz 未说明，§8.3 C28）。 */
  dominantFreqThreshold?: number
  dfOperatorKey?: string
  dfSwitch?: boolean
  dfLogicalOperatorKey?: string
  noiseComparisonFileId?: number
  /** 噪声相似度 `0-1`。 */
  ncSimilarityThreshold?: number
  ncSwitch?: boolean
  ncLogicalOperatorKey?: string
  /** 读取侧未给数字枚举（§8.3 C28），未命中时为 `undefined`。 */
  ncOperatorKey?: string
  notes?: string
  /** 仅写入时有意义，读取时永远缺省。 */
  discharge?: Fa371AlarmConditionDischarge
}

export interface Fa371AlarmConditionPage {
  items: Fa371AlarmCondition[]
  pageTotal?: number
}

// ---------------------------------------------------------------------------
// 噪声比对文件（§5.1.30 – §5.1.32）
// ---------------------------------------------------------------------------

export interface Fa371NcFile {
  id?: number
  fileName?: string
  /** 原始字节数。单位手册未说明（§8.3 C32）。 */
  fileSizeRaw?: number
  /** 原始采样率。单位手册未说明。 */
  sampleRateRaw?: number
  /** 原始时长。单位手册未说明（`Duration` 大写是手册原文）。 */
  durationRaw?: number
  notes?: string
}

export interface Fa371NcFilePage {
  items: Fa371NcFile[]
  pageTotal?: number
}
