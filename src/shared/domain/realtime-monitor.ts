/**
 * GIS 实时监测工作台（Realtime Monitor）的领域模型。
 *
 * 这份规格来自业主 2026-09-20 的《GIS Realtime Data UX/UI Specification V1.0》：
 * GIS 页面第三行不再是"分贝/平稳度/方位"的表格，而是一台**当前聚焦设备**的
 * 实时监测工作台。改动只发生在展示层与适配层，因此"设备原始字段"仍然止步于
 * `AlarmEvent`、`RealtimeFeature`、FA371 流预览这些既有域模型，界面不新增任何
 * 固件键名。
 *
 * ---------------------------------------------------------------------------
 * 三条不可退让的规矩（规格 §20 / §30 / §34 的原话在这里落成类型）
 * ---------------------------------------------------------------------------
 * 1. **没有数据就说没有数据**：`RealtimeQuality` 里有 `nodata`，`MetricValue.value`
 *    可以是 `null`。绝不把"没读到"写成 0 —— 0 是一位工程师会当真值读的测量值，
 *    而"接口还没提供"与"设备真报了 0"是两件事。
 * 2. **红色只能表示真实 Alarm**（规格 §6）：`severity` 只从设备告警/事件上取，
 *    不按数值大小推断。因此没有策略阈值时，一个偏高的声压级也只是 normal。
 * 3. **方向只在有有效目标时出现**（规格 §20）：`RealtimeFrame.target` 在 Live
 *    模式恒缺席；只有点击告警进入 Event 模式、并且告警原文里确实带方向时才填，
 *    否则 Direction Radar 显示 "No Target"。
 *
 * ---------------------------------------------------------------------------
 * 为什么模板由"能力"而不是型号决定（规格 §37）
 * ---------------------------------------------------------------------------
 * 不写 `if (model === 'FA371T')`：那会把一个 UI 事实永久焊死在一个型号名上，
 * 而型号名在设备协议里并不存在（声相机是可读型号的，空气声呐只靠 `detectE2Variant()`
 * 从 `/system` 的字段形状判定）。这里用 `kind` + `e2Variant` 这两个**协议事实**
 * 解析出 `DeviceRealtimeProfile`；型号、通道数、未来固件差异都只影响这一处映射。
 *
 * 五套模板里 `gasLeakMonitor` 是**预留**的：XS-SW-15A 目前不是软件里的设备类型
 * （现有 `DeviceKind` 只有三类），而且它也没有实时数据点表。模板定义先落在这里，
 * 等接入协议/数据点表后只需要往 `resolveRealtimeProfile()` 增加一条分支，
 * 界面与 store 不需要重写。
 */

import type { E2Variant } from './e2'
import type { DeviceKind, DeviceStatus } from './models'

// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------

/**
 * 五套模板的稳定标识（四类设备，声相机的 PD 与 Leak 拆成两套 —— 规格 §43）。
 *
 * 标识是**代码事实**，不进 i18n 目录；界面上的名字从 `realtimeUi.template.*` 取。
 */
export type RealtimeTemplateId =
  | 'acousticCameraPD'
  | 'acousticCameraLeak'
  | 'voiceprint'
  | 'airSonar'
  | 'gasLeakMonitor'

/** 运行时清单。与联合类型写在一起，两者不可能漂移。 */
export const REALTIME_TEMPLATE_IDS: readonly RealtimeTemplateId[] = [
  'acousticCameraPD',
  'acousticCameraLeak',
  'voiceprint',
  'airSonar',
  'gasLeakMonitor'
]

export function isRealtimeTemplateId(value: unknown): value is RealtimeTemplateId {
  return typeof value === 'string' && (REALTIME_TEMPLATE_IDS as readonly string[]).includes(value)
}

/**
 * 设备能力。界面只消费能力：底部动作条按能力隐藏（规格 §26：
 * 「没有能力就隐藏，不要显示 Disabled Button」），不针对型号写分支。
 */
export type RealtimeCapability =
  | 'audio'
  | 'spectrum'
  | 'waveform'
  | 'voiceprint'
  | 'prpd'
  | 'thermal'
  | 'acousticImaging'
  | 'leakEstimation'
  | 'multiChannel'
  | 'directionFinding'
  | 'ptz'
  | 'aiClassification'
  | 'realtimeVideo'
  | 'lte'

export const REALTIME_CAPABILITIES: readonly RealtimeCapability[] = [
  'audio',
  'spectrum',
  'waveform',
  'voiceprint',
  'prpd',
  'thermal',
  'acousticImaging',
  'leakEstimation',
  'multiChannel',
  'directionFinding',
  'ptz',
  'aiClassification',
  'realtimeVideo',
  'lte'
]

/** 底部动作（规格 §26）。`deviceDetail` 留给后续需要时再接。 */
export type RealtimeActionId = 'liveView' | 'listen' | 'ptz' | 'history' | 'analysis' | 'configuration'

/** 中央主可视化的 Tab（规格 §8/§10/§15）。Direction Radar 与 Signal Trend 不占 Tab。 */
export type RealtimeTabId = 'trend' | 'spectrum' | 'voiceprint' | 'waveform' | 'prpd'

export const REALTIME_TABS: readonly RealtimeTabId[] = [
  'trend',
  'spectrum',
  'voiceprint',
  'waveform',
  'prpd'
]

/** 声相机两套模板的显示模式。它**不是**设备事实，是操作员选的是哪一套视图。 */
export type AcousticCameraViewMode = 'pd' | 'leak'

/** Header 右侧只允许这五个状态（规格 §4）。 */
export type RealtimeHeaderStatus = 'live' | 'warning' | 'alarm' | 'offline' | 'dataDelay'

/** 状态色语义（规格 §6）：normal 绿、warning 黄、alarm 红。 */
export type RealtimeSeverity = 'normal' | 'warning' | 'alarm'

/** 通道在通道列表里的状态（规格 §14：● Normal / ● Warning / ● Alarm / ○ No Data）。 */
export type RealtimeChannelStatus = 'normal' | 'warning' | 'alarm' | 'nodata'

/** 数据质量（规格 §31：GOOD / STALE / INVALID / NO DATA）。 */
export type RealtimeQuality = 'good' | 'stale' | 'invalid' | 'nodata'

/** 超过三个正常刷新周期没更新 → STALE。实时特征流按 1 Hz 推，因此取 3.5 s（留半拍余量）。 */
export const REALTIME_STALE_AFTER_MS = 3_500

/** 左栏最多 4 个主 KPI；超过四个的进右栏 Detail（规格 §7）。 */
export const REALTIME_KPI_LIMIT = 4

// ---------------------------------------------------------------------------
// 值
// ---------------------------------------------------------------------------

/**
 * 一个实时/准实时值。
 *
 * `labelKey` 省略时界面通过 `realtimeMetricLabelKey(key)` 解析 —— 常用特征量直接
 * 复用已有 `metrics.*` 目录，不重复造一套同义词。
 */
export interface MetricValue {
  key: string
  value: number | string | null
  unit?: string
  /** 小数位；省略时交给 `formatNumber()` 的自适应规则。 */
  precision?: number
  /** 这个值自己的时刻；用于逐值判断 STALE/NO DATA。 */
  timestamp?: number
  quality: RealtimeQuality
  /** 只从真实告警/事件上取，不按数值大小推断（规格 §6）。 */
  severity?: RealtimeSeverity
  /** 0..1，用于概率横条（规格 §9）。 */
  ratio?: number
  /** true = 右栏 Detail，而不是左栏 KPI。 */
  detail?: boolean
  /** 子值说明（如 ↑ 2.4 dB 的对比文本），由调用方填完整句子。 */
  note?: string
  /** 另一种说明：i18n key（例如「超限」），由界面翻译。 */
  noteKey?: string
  /**
   * alue === null 时显示的**文本值**的 i18n key（例如 Air Sonar 的 EVENT NONE）。
   * 它不是测量值，所以不走数字格式化；有真实 alue 时本字段不生效。
   */
  textKey?: string
}

/** 通道异常时点名的**哪一个特征**异常（规格 §17）。 */
export interface RealtimeChannelIssue {
  key: string
  value: MetricValue
  /** 设备原文/策略给的说明（例如 "Above limit"），可省略。 */
  note?: string
}

/** 通道实时读数（FA8 通道列表 / 声呐通道概要）。 */
export interface ChannelRealtime {
  channelId: number
  status: RealtimeChannelStatus
  /** 列表主值：声压级。 */
  spl?: MetricValue
  /** 异常特征；空 = 没有认出来的特征异常。 */
  issues?: RealtimeChannelIssue[]
}

/** 分析块：PD 概率、AI 分类、泄漏分析都用同一种 key-value 形状。 */
export interface RealtimeAnalysis {
  type: 'pdProbability' | 'aiClassification' | 'leak' | 'signal'
  /** key 是稳定标识（corona/creepage/...），值可能是概率或文本。 */
  values: Record<string, number | string | null>
  timestamp?: number
}

/** 目标方位。`undefined` = 没有有效目标；Live 模式下整个字段缺席。 */
export interface RealtimeTarget {
  horizontal?: number
  vertical?: number
}

/** 温度块（声相机的热成像读数）。 */
export interface RealtimeTemperatures {
  max?: number
  center?: number
  min?: number
  timestamp?: number
}

/** Event 模式的事件摘要（规格 §28）。 */
export interface RealtimeEventInfo {
  id: string
  at: number
  severity: RealtimeSeverity
  /** 事件类型（Gunshot / 超限 / ...）的 i18n key。 */
  labelKey: string
  /**
   * 设备原文（听诊盒子族的 larm_reasons 一类的自由文本）。
   * 它不翻译：设备自己的措辞本身就是证据。
   */
  rawLabel?: string
  channelId?: number
  /** FA8：具体哪个特征异常，顺序固定。 */
  issueKeys?: string[]
}

/** 一帧**已经适配为平台标准模型**的数据（规格 §39/§40）。 */
export interface RealtimeFrame {
  deviceId: string
  timestamp: number
  /** 整体数据质量：所有读数里最新的那一个的时间戳决定；没有读数时是 nodata。 */
  quality: RealtimeQuality
  status: {
    online: boolean
    severity: RealtimeSeverity
  }
  primaryMetrics: MetricValue[]
  /** 右栏 Detail/Analysis 的固定顺序读数（FA8 七项、温度块等）。 */
  details?: MetricValue[]
  channels?: ChannelRealtime[]
  analysis?: RealtimeAnalysis
  target?: RealtimeTarget
  temperatures?: RealtimeTemperatures
  event?: RealtimeEventInfo
}

// ---------------------------------------------------------------------------
// 设备档案（模板 / 模式 / 通道数 / 能力）
// ---------------------------------------------------------------------------

export interface DeviceRealtimeProfile {
  deviceId: string
  template: RealtimeTemplateId
  /** 只有声相机有：操作员当前看的是 PD 还是 Leak 模板。 */
  mode?: AcousticCameraViewMode
  channelCount?: number
  capabilities: readonly RealtimeCapability[]
}

/** FA8 声纹盒固定 8 通道（`models.CHANNEL_COUNT`），但这里不复制那个常量。 */
const VOICEPRINT_CAPABILITIES: readonly RealtimeCapability[] = [
  'audio',
  'multiChannel',
  'spectrum',
  'voiceprint'
]

const AIR_SONAR_CAPABILITIES: readonly RealtimeCapability[] = [
  'audio',
  'multiChannel',
  'directionFinding',
  'ptz',
  'aiClassification'
]

/**
 * 声相机两套模板共用同一份设备能力（Live View / Listen / PTZ / 录像都由设备提供），
 * 区别只在模板定义的中心 Tab 与能力标注：
 *   - PD 模板需要 prpd（相位图谱）能力；
 *   - Leak 模板需要 leakEstimation（泄漏量/损失）。
 * 注意能力是"设备**可能**提供"，不是"这一次一定有值"。缺数据时界面显示
 * `nodata`，不因为有能力就把值编出来。
 */
const CAMERA_COMMON_CAPABILITIES: readonly RealtimeCapability[] = [
  'audio',
  'spectrum',
  'waveform',
  'voiceprint',
  'thermal',
  'acousticImaging',
  'ptz',
  'realtimeVideo'
]

const CAMERA_PD_CAPABILITIES: readonly RealtimeCapability[] = [
  ...CAMERA_COMMON_CAPABILITIES,
  'prpd'
]

const CAMERA_LEAK_CAPABILITIES: readonly RealtimeCapability[] = [
  ...CAMERA_COMMON_CAPABILITIES,
  'leakEstimation'
]

export const GAS_LEAK_CAPABILITIES: readonly RealtimeCapability[] = [
  'audio',
  'multiChannel',
  'lte'
]

export interface RealtimeProfileInput {
  deviceId: string
  kind: DeviceKind
  /** 听诊盒子族才有；缺席 = 还没读到过（不是 2023 版）。 */
  e2Variant?: E2Variant
  /** 声相机当前显示模式；省略 = PD。 */
  cameraMode?: AcousticCameraViewMode
}

/**
 * 协议事实 → 设备实时档案。返回 `undefined` 表示**没有对应模板**，
 * 界面应显示"此型号暂无实时监测模板"，而不是塞进一个最像的模板里。
 *
 * 2023 版听诊盒子（`e2Variant === 'auscultation'`）和"变体还没读到"
 * （`undefined`）都属于这一类：规格的五套模板里没有它们，猜一个最像的就是撒谎。
 */
export function resolveRealtimeProfile(
  input: RealtimeProfileInput
): DeviceRealtimeProfile | undefined {
  if (input.kind === 'acousticBox') {
    return {
      deviceId: input.deviceId,
      template: 'voiceprint',
      channelCount: 8,
      capabilities: VOICEPRINT_CAPABILITIES
    }
  }
  if (input.kind === 'acousticCamera') {
    const mode: AcousticCameraViewMode = input.cameraMode === 'leak' ? 'leak' : 'pd'
    return {
      deviceId: input.deviceId,
      template: mode === 'leak' ? 'acousticCameraLeak' : 'acousticCameraPD',
      mode,
      capabilities:
        mode === 'leak' ? CAMERA_LEAK_CAPABILITIES : CAMERA_PD_CAPABILITIES
    }
  }
  if (input.kind === 'auscultationBox' && input.e2Variant === 'airSonar') {
    return {
      deviceId: input.deviceId,
      template: 'airSonar',
      capabilities: AIR_SONAR_CAPABILITIES
    }
  }
  /*
   * 未来设备的接入点：XS-SW-15A 气井泄漏监测仪一旦进入 `DeviceKind`，
   * 在这里返回下面的档案即可（模板已经定义好）：
   *
   *   return {
   *     deviceId: input.deviceId,
   *     template: 'gasLeakMonitor',
   *     capabilities: GAS_LEAK_CAPABILITIES
   *   }
   *
   * `GAS_LEAK_CAPABILITIES` 与 `REALTIME_TEMPLATES.gasLeakMonitor` 已存在，
   * 因此接入时是"加一条配置"，不是"重新开发一个页面"（规格 §43 的初衷）。
   */
  return undefined
}

/** 切换声相机的显示模式，其余字段不变。用于组件里的 PD / LEAK 切换。 */
export function withCameraMode(
  profile: DeviceRealtimeProfile,
  mode: AcousticCameraViewMode
): DeviceRealtimeProfile {
  if (profile.template !== 'acousticCameraPD' && profile.template !== 'acousticCameraLeak') {
    return profile
  }
  return {
    ...profile,
    mode,
    template: mode === 'leak' ? 'acousticCameraLeak' : 'acousticCameraPD',
    capabilities: mode === 'leak' ? CAMERA_LEAK_CAPABILITIES : CAMERA_PD_CAPABILITIES
  }
}

// ---------------------------------------------------------------------------
// 模板定义
// ---------------------------------------------------------------------------

export interface RealtimeTemplateDefinition {
  id: RealtimeTemplateId
  /** 中心区的 Tab（空 = 中心是一个固定可视化，不由 Tab 切换）。 */
  tabs: readonly RealtimeTabId[]
  defaultTab: RealtimeTabId | undefined
  /** 底部动作（未按能力过滤；实际显示见 `realtimeActions()`）。 */
  actions: readonly RealtimeActionId[]
}

export const REALTIME_TEMPLATES: Readonly<Record<RealtimeTemplateId, RealtimeTemplateDefinition>> = {
  /**
   * Acoustic Camera — PD Mode（规格 §8）。
   *
   * 默认 PRPD 是业主的验收项；但 PRPD 需要相位分辨数据，现有 FA371 接口
   * 没有这一项。因此默认选 PRPD，数据缺席时由中心区显示"接口未提供"状态，
   * 不用 Spectrum 冒充 PRPD。
   */
  acousticCameraPD: {
    id: 'acousticCameraPD',
    tabs: ['prpd', 'spectrum', 'voiceprint', 'waveform'],
    defaultTab: 'prpd',
    actions: ['liveView', 'listen', 'history', 'analysis', 'configuration']
  },
  /** Acoustic Camera — Leak Mode（规格 §10）。默认 Spectrum。 */
  acousticCameraLeak: {
    id: 'acousticCameraLeak',
    tabs: ['spectrum', 'voiceprint', 'waveform'],
    defaultTab: 'spectrum',
    actions: ['liveView', 'listen', 'history', 'analysis', 'configuration']
  },
  /** FA8 — 8 Channel Voiceprint Engine（规格 §13/§15）。 */
  voiceprint: {
    id: 'voiceprint',
    tabs: ['trend', 'spectrum', 'voiceprint'],
    defaultTab: 'trend',
    actions: ['listen', 'history', 'analysis', 'configuration']
  },
  /** Air Sonar / HZ-SN-16（规格 §18）。中心固定 Direction Radar。 */
  airSonar: {
    id: 'airSonar',
    tabs: [],
    defaultTab: undefined,
    actions: ['listen', 'ptz', 'history', 'analysis', 'configuration']
  },
  /** XS-SW-15A Gas Well Leak Monitor（规格 §24/§25）。中心固定 Signal Trend。 */
  gasLeakMonitor: {
    id: 'gasLeakMonitor',
    tabs: [],
    defaultTab: undefined,
    actions: ['listen', 'history', 'analysis', 'configuration']
  }
}

export function realtimeTemplate(template: RealtimeTemplateId): RealtimeTemplateDefinition {
  return REALTIME_TEMPLATES[template]
}

/** 一个档案实际显示的动作：模板动作 ∩ 设备能力（规格 §26）。 */
export function realtimeActions(profile: DeviceRealtimeProfile): RealtimeActionId[] {
  const template = realtimeTemplate(profile.template)
  return template.actions.filter((action) => {
    if (action === 'liveView') return profile.capabilities.includes('realtimeVideo')
    if (action === 'listen') return profile.capabilities.includes('audio')
    if (action === 'ptz') return profile.capabilities.includes('ptz')
    return true
  })
}

// ---------------------------------------------------------------------------
// Header 状态机（规格 §4）
// ---------------------------------------------------------------------------

const HEADER_STATUS_PRIORITY: Record<RealtimeHeaderStatus, number> = {
  offline: 4,
  alarm: 3,
  warning: 2,
  dataDelay: 1,
  live: 0
}

export interface RealtimeHeaderStatusInput {
  deviceStatus: DeviceStatus
  /** 这一帧里有没有认出来的真实告警/警告。 */
  severity: RealtimeSeverity
  /** 有没有收到过数据（哪怕已经 STALE）。 */
  hasData: boolean
  /** 当前数据质量。 */
  quality: RealtimeQuality
}

/**
 * Header 右侧只能有一个状态（规格 §4：不要同时出现太多 Badge）。
 *
 * 优先级 **Offline > Alarm > Warning > Data Delay > Live**：
 * 离线设备即便库里还留着上一次告警，也不该被读成"现在正在告警"——
 * 先告诉操作员失联，再有数据延迟。`UNKNOWN` 按离线显示（与设备列表同一条口径：
 * 还没探活过 ≠ 它在线）。
 */
export function realtimeHeaderStatus(input: RealtimeHeaderStatusInput): RealtimeHeaderStatus {
  const candidates: RealtimeHeaderStatus[] = []
  if (input.deviceStatus !== 'ONLINE') candidates.push('offline')
  if (input.severity === 'alarm') candidates.push('alarm')
  else if (input.severity === 'warning') candidates.push('warning')
  if (input.hasData && input.quality === 'stale') candidates.push('dataDelay')
  candidates.push('live')
  return candidates.reduce((best, current) =>
    HEADER_STATUS_PRIORITY[current] > HEADER_STATUS_PRIORITY[best] ? current : best
  )
}

/** Header 状态的 i18n 键。 */
export function realtimeHeaderStatusKey(status: RealtimeHeaderStatus): string {
  return `realtimeUi.status.${status}`
}

// ---------------------------------------------------------------------------
// 数据质量（规格 §31）
// ---------------------------------------------------------------------------

/**
 * 一个时间戳距离"现在"的数据质量。
 *
 * `invalid` 只给"时间在将来且超过 1 秒"的帧：设备时钟可能与本机差几毫秒，
 * 不能因为几百毫秒的偏差就把一条正常数据标成 INVALID。`undefined` 是 `nodata`，
 * 与"时间戳是 0"（1970）不是一回事。
 */
export function realtimeQualityAt(
  timestamp: number | undefined,
  now: number,
  staleAfterMs: number = REALTIME_STALE_AFTER_MS
): RealtimeQuality {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return 'nodata'
  const age = now - timestamp
  if (age < -1_000) return 'invalid'
  return age > staleAfterMs ? 'stale' : 'good'
}

/** 质量对应的 i18n 键（§31 的四个词）。 */
export function realtimeQualityKey(quality: RealtimeQuality): string {
  return `realtimeUi.quality.${quality}`
}

/** 质量是否有值可显示（nodata/invalid 显示 "—"，stale 保留最后值但变灰）。 */
export function realtimeQualityHasValue(quality: RealtimeQuality): boolean {
  return quality === 'good' || quality === 'stale'
}

// ---------------------------------------------------------------------------
// 度量标签
// ---------------------------------------------------------------------------

/**
 * 常用度量的 i18n 键。
 *
 * FA8 的七项特征已经在 `metrics.*` 里，直接复用；新增的展示量放
 * `realtimeUi.metric.*`。这张表是**刻意写死**的：让拼错的 key 在测试里被点名，
 * 而不是在界面上悄悄回退成 key 本身。
 */
const METRIC_LABEL_KEYS: Readonly<Record<string, string>> = {
  spl: 'metrics.spl',
  maxSpl: 'realtimeUi.metric.maxSpl',
  mainFrequency: 'metrics.mainFrequency',
  smoothness: 'metrics.smoothness',
  bandEnergyRatio: 'metrics.bandEnergyRatio',
  oddEvenHarmonicRatio: 'metrics.oddEvenHarmonicRatio',
  spectralComplexity: 'metrics.spectralComplexity',
  fingerprintVariation: 'metrics.fingerprintVariation',
  soundEnergy: 'realtimeUi.metric.soundEnergy',
  pdType: 'realtimeUi.metric.pdType',
  confidence: 'realtimeUi.metric.confidence',
  maxTemp: 'realtimeUi.metric.maxTemp',
  leakRate: 'realtimeUi.metric.leakRate',
  loss: 'realtimeUi.metric.loss',
  frequencyBand: 'realtimeUi.metric.frequencyBand',
  detectionDistance: 'realtimeUi.metric.detectionDistance',
  centerTemp: 'realtimeUi.metric.centerTemp',
  minTemp: 'realtimeUi.metric.minTemp',
  maxChannel: 'realtimeUi.metric.maxChannel',
  event: 'realtimeUi.metric.event',
  ptz: 'realtimeUi.metric.ptz',
  azimuth: 'realtimeUi.metric.azimuth',
  tdeRatio: 'realtimeUi.metric.tdeRatio',
  fdeRatio: 'realtimeUi.metric.fdeRatio',
  horizontal: 'realtimeUi.metric.horizontal',
  vertical: 'realtimeUi.metric.vertical',
  leakStatus: 'realtimeUi.metric.leakStatus',
  edgeAi: 'realtimeUi.metric.edgeAi',
  connection: 'realtimeUi.metric.connection',
  lastAnalysis: 'realtimeUi.metric.lastAnalysis',
  channels: 'realtimeUi.metric.channels',
  target: 'realtimeUi.metric.target',
  peakSpl: 'realtimeUi.metric.peakSpl'
}

export function realtimeMetricLabelKey(key: string): string {
  return METRIC_LABEL_KEYS[key] ?? `realtimeUi.metric.${key}`
}

// ---------------------------------------------------------------------------
// Air Sonar 告警原文里的方向
// ---------------------------------------------------------------------------

/**
 * 从听诊盒子族告警的 `deviceRaw` 里取 Air Sonar 的声源方位。
 *
 * 为什么读原始 JSON 而不是新增结构化列：`horizontal`/`vertical` 是 Air Sonar
 * 告警独有的两个数字，设备文档明确给了它们；同步时整份原文已经存进 `deviceRaw`
 * （`e2-sync-service` 的选择：宁可留全文，也不为每个固件键开一列）。
 * 在渲染层解析它是**只读**的展示适配，不改变任何既有落库口径。
 *
 * 取值规则：
 *   - 只认数字（数字字符串也认）；`horizontal` 规范化为 `[0, 360)`，
 *     与 `installation.azimuthDeg` 同向才可以直接比较；
 *   - `vertical` 保持设备原值（两种机型一个用 -90..90、一个用 0..180，不做猜）；
 *   - 解析不出来就返回空对象 —— 没有方向就不显示方向。
 */
export function parseAirSonarDirection(
  deviceRaw: string | undefined
): RealtimeTarget {
  const result: RealtimeTarget = {}
  if (typeof deviceRaw !== 'string' || deviceRaw.trim() === '') return result
  let parsed: unknown
  try {
    parsed = JSON.parse(deviceRaw)
  } catch {
    return result
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result
  const record = parsed as Record<string, unknown>
  const horizontal = toFiniteNumber(record.horizontal)
  if (horizontal !== undefined) result.horizontal = normaliseAzimuth(horizontal)
  const vertical = toFiniteNumber(record.vertical)
  if (vertical !== undefined) result.vertical = vertical
  return result
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 罗盘方位角规范化到 `[0, 360)`（与 `DeviceInstallation.azimuthDeg` 同一口径）。 */
export function normaliseAzimuth(value: number): number {
  const wrapped = value % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

/** 有没有有效方向（0° 是合法方向，不能写 `if (!horizontal)`）。 */
export function hasRealtimeTarget(target: RealtimeTarget | undefined): boolean {
  return target !== undefined && (target.horizontal !== undefined || target.vertical !== undefined)
}