/**
 * GIS 实时监测工作台的**适配层**（规格 §39）。
 *
 * 这一层把三种既有域模型 —— `AlarmEvent`（最近一次真实告警）、`RealtimeFeature`
 * （FA8 每秒特征帧）、听诊盒子族告警的 `deviceRaw` 原文 —— 转成 `RealtimeFrame`。
 * 界面组件只认识 `RealtimeFrame`，永远不直接读 `db_value` / `max_db_value` /
 * `hp_spl` 这些固件键名，因此以后接 FA-371、FA-8、SN-16、WL-15A 时，
 * 设备差异只影响本文件的映射函数。
 *
 * ---------------------------------------------------------------------------
 * 一条纪律：缺失值用 `quality: 'nodata'`，不用 0
 * ---------------------------------------------------------------------------
 * 规格 §31 的原话是"0 会被工程师理解成真实测量值"。因此这里所有的"这台设备这一项
 * 没有实时数据"都写成 `value: null` + `quality: 'nodata'`，界面渲染 `—`。
 * 最近一次告警里的值属于"最后一次有效值"，照规格 §34 显示，但它的时刻跟着告警走，
 * 由 `realtimeQualityAt()` 判成 `stale`（变灰），不会冒充当前读数。
 *
 * ---------------------------------------------------------------------------
 * 红色只从真实告警来
 * ---------------------------------------------------------------------------
 * `FeatureSource.severity` / `issueKeys` 只由 `AlarmEvent` 填。FA8 的 `RealtimeFeature`
 * 是一个测量值，里面没有"超限"这件事实（阈值判定在设备的告警位里），
 * 所以从实时帧来的 source 既没有 severity 也没有 issueKeys，通道状态只能是
 * normal / nodata，永远不会因为数值偏高而变红（规格 §6）。
 */

import type { AlarmEvent, Device, RealtimeFeature } from '@shared/domain/models'
import { ALARM_TYPE_KEYS } from '@shared/domain/models'
import { primaryAlarmType } from '@shared/domain/alarm-mask'
import type { EventSeverity } from '@shared/domain/event-center'
import type { E2RealtimeValue } from '@shared/domain/e2-callback'
import type { Fa371InfraredPreview } from '@shared/domain/fa371-stream'
import {
  parseAirSonarDirection,
  realtimeQualityAt,
  type ChannelRealtime,
  type DeviceRealtimeProfile,
  type MetricValue,
  type RealtimeChannelIssue,
  type RealtimeEventInfo,
  type RealtimeFrame,
  type RealtimeQuality,
  type RealtimeTemperatures,
  type RealtimeSeverity
} from '@shared/domain/realtime-monitor'

/** 实时面板的两种模式（规格 §28）。 */
export type MonitorMode = 'live' | 'event'

// ---------------------------------------------------------------------------
// FeatureSource：告警与实时特征帧的公共读数视图
// ---------------------------------------------------------------------------

export type FeatureMetricKey =
  | 'spl'
  | 'mainFrequency'
  | 'smoothness'
  | 'bandEnergyRatio'
  | 'oddEvenHarmonicRatio'
  | 'spectralComplexity'
  | 'fingerprintVariation'

/**
 * 一个通道的读数来源。
 *
 * 它故意不叫 `RealtimeFeature`：告警与实时帧**字段有交集但不全等**
 * （告警没有后三项特征，实时帧没有告警位）。两个来源先归一到这里，
 * 界面就只需要一套右栏渲染逻辑。
 */
export interface FeatureSource {
  timestamp: number
  spl?: number
  mainFrequency?: number
  smoothness?: number
  bandEnergyRatio?: number
  oddEvenHarmonicRatio?: number
  spectralComplexity?: number
  fingerprintVariation?: number
  /** 设备告警位解出的类型（只有告警来源有）。 */
  issueKeys?: string[]
  /** 真实告警等级（只有告警来源有）。 */
  severity?: RealtimeSeverity
}

/** FA8 每秒特征帧 -> FeatureSource（无告警含义，见文件头）。 */
export function featureSourceOfFeature(feature: RealtimeFeature): FeatureSource {
  return {
    timestamp: feature.timestamp,
    spl: feature.spl,
    mainFrequency: feature.mainFrequency,
    smoothness: feature.smoothness,
    bandEnergyRatio: feature.bandEnergyRatio,
    ...(feature.oddEvenHarmonicRatio !== undefined
      ? { oddEvenHarmonicRatio: feature.oddEvenHarmonicRatio }
      : {}),
    ...(feature.spectralComplexity !== undefined
      ? { spectralComplexity: feature.spectralComplexity }
      : {}),
    ...(feature.fingerprintVariation !== undefined
      ? { fingerprintVariation: feature.fingerprintVariation }
      : {})
  }
}

/**
 * 一条告警 -> FeatureSource。
 *
 * `alarmTypes` 来自设备位图，是"哪个特征超限"的事实；`severity` 由入库时算好的
 * 等级映射到三档状态色。两者都只在这里填，界面不再做位运算。
 */
export function featureSourceOfAlarm(alarm: AlarmEvent): FeatureSource {
  return {
    timestamp: alarm.timestamp,
    ...(alarm.spl !== undefined ? { spl: alarm.spl } : {}),
    ...(alarm.mainFrequency !== undefined ? { mainFrequency: alarm.mainFrequency } : {}),
    ...(alarm.smoothness !== undefined ? { smoothness: alarm.smoothness } : {}),
    ...(alarm.bandEnergyRatio !== undefined ? { bandEnergyRatio: alarm.bandEnergyRatio } : {}),
    issueKeys: alarm.alarmTypes.map((type) => ALARM_TYPE_KEYS[type]),
    severity: realtimeSeverityFromEventSeverity(alarm.severity)
  }
}

/** `EventSeverity` -> 面板三档状态色：critical 是 Alarm，其余真实告警至少是 Warning。 */
export function realtimeSeverityFromEventSeverity(severity: EventSeverity): RealtimeSeverity {
  return severity === 'critical' ? 'alarm' : 'warning'
}
// ---------------------------------------------------------------------------
// MetricValue 构造
// ---------------------------------------------------------------------------

function toFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 有值：质量由这个值自己的时间戳决定（规格 §31）。 */
export function valueMetric(
  key: string,
  value: number | string | null | undefined,
  options: {
    unit?: string
    precision?: number
    timestamp?: number
    now: number
    severity?: RealtimeSeverity
    ratio?: number
    detail?: boolean
    note?: string
    noteKey?: string
    quality?: RealtimeQuality
  }
): MetricValue {
  const now = options.now
  if (
    value === undefined ||
    value === null ||
    (typeof value === 'number' && !Number.isFinite(value))
  ) {
    return missingMetric(key, options)
  }
  const quality =
    options.quality ??
    (typeof value === 'number' ? realtimeQualityAt(options.timestamp, now) : 'good')
  return {
    key,
    value,
    quality,
    ...(options.unit !== undefined ? { unit: options.unit } : {}),
    ...(options.precision !== undefined ? { precision: options.precision } : {}),
    ...(options.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
    ...(options.severity !== undefined ? { severity: options.severity } : {}),
    ...(options.ratio !== undefined ? { ratio: options.ratio } : {}),
    ...(options.detail !== undefined ? { detail: options.detail } : {}),
    ...(options.note !== undefined ? { note: options.note } : {}),
    ...(options.noteKey !== undefined ? { noteKey: options.noteKey } : {})
  }
}

/** 没有值：`nodata`，界面渲染 `—`。 */
export function missingMetric(
  key: string,
  options: {
    unit?: string
    precision?: number
    detail?: boolean
    note?: string
    noteKey?: string
    textKey?: string
  } = {}
): MetricValue {
  return {
    key,
    value: null,
    quality: 'nodata',
    ...(options.unit !== undefined ? { unit: options.unit } : {}),
    ...(options.precision !== undefined ? { precision: options.precision } : {}),
    ...(options.detail !== undefined ? { detail: options.detail } : {}),
    ...(options.note !== undefined ? { note: options.note } : {}),
    ...(options.noteKey !== undefined ? { noteKey: options.noteKey } : {}),
    ...(options.textKey !== undefined ? { textKey: options.textKey } : {})
  }
}

/** 从一个 FeatureSource 取某个特征量；没有就是 nodata。 */
export function featureMetric(
  source: FeatureSource | null | undefined,
  key: FeatureMetricKey,
  unit: string,
  precision: number,
  now: number
): MetricValue {
  const value = source ? toFinite(source[key]) : undefined
  return valueMetric(key, value, {
    unit,
    precision,
    ...(source !== undefined && source !== null ? { timestamp: source.timestamp } : {}),
    now,
    ...(source?.severity !== undefined ? { severity: source.severity } : {})
  })
}

// ---------------------------------------------------------------------------
// FA8 通道
// ---------------------------------------------------------------------------

const VOICEPRINT_ISSUE_KEYS: Readonly<Record<string, FeatureMetricKey>> = {
  spl: 'spl',
  main_frequency: 'mainFrequency',
  band_energy_ratio: 'bandEnergyRatio',
  smoothness: 'smoothness'
}

const VOICEPRINT_UNITS: Readonly<Record<FeatureMetricKey, string>> = {
  spl: 'dB',
  mainFrequency: 'Hz',
  smoothness: '',
  bandEnergyRatio: '',
  oddEvenHarmonicRatio: '',
  spectralComplexity: '',
  fingerprintVariation: ''
}

const VOICEPRINT_PRECISION: Readonly<Record<FeatureMetricKey, number>> = {
  spl: 1,
  mainFrequency: 1,
  smoothness: 3,
  bandEnergyRatio: 3,
  oddEvenHarmonicRatio: 3,
  spectralComplexity: 2,
  fingerprintVariation: 3
}

/**
 * FA8 的通道异常：设备告警位点名的特征，逐项给出当前值。
 *
 * 顺序**按告警位给出**，不按数值大小重排（规格 §16：工程人员形成肌肉记忆）。
 * 找不到对应读数的项也保留，值显示 `—` —— "这个特征超限了但这一次没上报读数"
 * 本身就是值得看见的信息。
 */
function voiceprintIssues(
  source: FeatureSource | null | undefined,
  now: number
): RealtimeChannelIssue[] {
  const keys = source?.issueKeys ?? []
  if (keys.length === 0) return []
  return keys.map((key) => {
    const featureKey = VOICEPRINT_ISSUE_KEYS[key]
    const value =
      featureKey !== undefined
        ? featureMetric(
            source,
            featureKey,
            VOICEPRINT_UNITS[featureKey] ?? '',
            VOICEPRINT_PRECISION[featureKey] ?? 1,
            now
          )
        : missingMetric(key)
    return { key, value, noteKey: 'realtimeUi.aboveLimit' }
  })
}

function channelStatusOf(
  spl: MetricValue,
  source: FeatureSource | null | undefined
): ChannelRealtime['status'] {
  const issues = source?.issueKeys ?? []
  if (issues.length > 0) return source?.severity === 'alarm' ? 'alarm' : 'warning'
  return spl.quality === 'good' || spl.quality === 'stale' ? 'normal' : 'nodata'
}

/** 构造一路通道（FA8 通道列表 / 其它多通道模板共用）。 */
export function buildVoiceprintChannel(
  channelId: number,
  source: FeatureSource | null | undefined,
  now: number
): ChannelRealtime {
  const spl = featureMetric(source, 'spl', 'dB', 1, now)
  const issues = voiceprintIssues(source, now)
  return {
    channelId,
    status: channelStatusOf(spl, source),
    spl,
    ...(issues.length > 0 ? { issues } : {})
  }
}

/** 0..channelCount-1 全部通道；没有读到的通道是 `nodata`，不跳过。 */
export function buildVoiceprintChannels(
  channelCount: number,
  sources: Readonly<Record<number, FeatureSource | undefined>>,
  now: number
): ChannelRealtime[] {
  const count = Math.max(0, Math.min(64, Math.trunc(channelCount)))
  const channels: ChannelRealtime[] = []
  for (let channelId = 0; channelId < count; channelId += 1) {
    channels.push(buildVoiceprintChannel(channelId, sources[channelId], now))
  }
  return channels
}
// ---------------------------------------------------------------------------
// 帧
// ---------------------------------------------------------------------------

export interface RealtimeFrameInput {
  device: Device
  profile: DeviceRealtimeProfile
  now: number
  mode?: MonitorMode
  /** 当前设备最近的一条告警；`alarms` 列表按时间倒序，取第一条即可。 */
  latestAlarm?: AlarmEvent
  /** 未确认告警条数；`-1` / 省略 = 没读到（不当 0 用）。 */
  pendingAlarms?: number
  /** 当前选中通道的读数（实时特征优先；Live 无数据时可以是最近告警）。 */
  featureSource?: FeatureSource | null
  /** 全部通道的读数来源（FA8）。 */
  channelSources?: Readonly<Record<number, FeatureSource | undefined>>
  /** Event 模式的事件摘要。 */
  event?: RealtimeEventInfo
  /** SN-16 每秒实时值（来自 notify_url 回调）；Air Sonar Live 优先用它。 */
  e2Realtime?: E2RealtimeValue
  /** 上面那一帧到达主进程的时刻。 */
  e2RealtimeAt?: number
  /** 声温成像仪红外温度（/inrared_data）；只对相机模板有意义。 */
  infrared?: Fa371InfraredPreview
}

/**
 * 源数据的整体质量：取所有读数里最新的时间戳。
 *
 * 没有读数（连最近告警都没有）时是 `nodata`，而不是 `good` —— 界面 Header 的
 * `DATA DELAY` 只应该在"曾经有过数据、现在停了"时出现。
 */
function frameQuality(
  sources: Array<FeatureSource | null | undefined>,
  latestAlarm: AlarmEvent | undefined,
  now: number,
  extraTimestamp?: number
): RealtimeQuality {
  const timestamps = sources
    .filter((source): source is FeatureSource => source !== null && source !== undefined)
    .map((source) => source.timestamp)
    .filter((value) => Number.isFinite(value))
  if (extraTimestamp !== undefined && Number.isFinite(extraTimestamp)) timestamps.push(extraTimestamp)
  if (timestamps.length === 0) {
    return latestAlarm ? realtimeQualityAt(latestAlarm.timestamp, now) : 'nodata'
  }
  return realtimeQualityAt(Math.max(...timestamps), now)
}

/** 帧级 severity：只有**未确认的真实告警**才让 Header 变色（规格 §6）。 */
function frameSeverity(input: RealtimeFrameInput): RealtimeSeverity {
  if (input.mode === 'event' && input.event) return input.event.severity
  const pending = input.pendingAlarms ?? 0
  if (pending <= 0) return 'normal'
  return input.latestAlarm ? realtimeSeverityFromEventSeverity(input.latestAlarm.severity) : 'warning'
}

/** 从听诊盒子族告警原文里取一个数字（Air Sonar 的 tde_ratio / fde_ratio / max_db_chn）。 */
function rawAlarmNumber(alarm: AlarmEvent | undefined, key: string): number | undefined {
  if (!alarm?.deviceRaw) return undefined
  try {
    const parsed = JSON.parse(alarm.deviceRaw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return toFinite(parsed[key])
  } catch {
    return undefined
  }
}

/** `max_db_chn` -> "CH13"；值域不合法就返回 undefined（不猜通道）。 */
function rawChannelLabel(alarm: AlarmEvent | undefined): string | undefined {
  const channel = rawAlarmNumber(alarm, 'max_db_chn')
  if (channel === undefined || !Number.isInteger(channel) || channel < 1 || channel > 64) {
    return undefined
  }
  return `CH${channel}`
}

export function realtimeEventOfAlarm(alarm: AlarmEvent): RealtimeEventInfo {
  const primary = primaryAlarmType(alarm.alarmMask)
  const labelKey =
    primary !== undefined ? `alarms.type.${ALARM_TYPE_KEYS[primary]}` : 'realtimeUi.event.alarm'
  return {
    id: alarm.id,
    at: alarm.timestamp,
    severity: realtimeSeverityFromEventSeverity(alarm.severity),
    labelKey,
    ...(alarm.deviceReason !== undefined ? { rawLabel: alarm.deviceReason } : {}),
    channelId: alarm.channelId,
    ...(alarm.alarmTypes.length > 0
      ? { issueKeys: alarm.alarmTypes.map((type) => ALARM_TYPE_KEYS[type]) }
      : {})
  }
}

/**
 * 主入口：按 `profile.template` 生成一帧标准模型。
 *
 * 五套模板的**左/中/右三栏内容**不在这里决定（那是组件的布局事实），
 * 这里只负责"这一帧有哪些读数、每项的质量与出处"。
 */
export function buildRealtimeFrame(input: RealtimeFrameInput): RealtimeFrame {
  const { device, profile, now } = input
  const severity = frameSeverity(input)
  const source = input.featureSource ?? null
  const timestamp =
    input.e2RealtimeAt ?? source?.timestamp ?? input.latestAlarm?.timestamp ?? now
  const quality = frameQuality(
    [source, ...Object.values(input.channelSources ?? {})],
    input.latestAlarm,
    now,
    input.e2RealtimeAt
  )

  const base = {
    deviceId: device.id,
    timestamp,
    quality,
    status: {
      online: device.status === 'ONLINE',
      severity
    },
    // Event 模式的事件摘要对所有模板都存在（Header 要显示 EVENT · 时间与类型）；
    // 各模板只决定中心区怎么画，不决定"这是不是一个历史事件"。
    ...(input.event ? { event: input.event } : {})
  }

  switch (profile.template) {
    case 'acousticCameraPD':
      return {
        ...base,
        primaryMetrics: cameraPdMetrics(input),
        details: cameraThermalDetails(input),
        ...(input.infrared ? { temperatures: cameraTemperatures(input) } : {})
      }
    case 'acousticCameraLeak':
      return {
        ...base,
        primaryMetrics: cameraLeakMetrics(input),
        details: cameraThermalDetails(input),
        ...(input.infrared ? { temperatures: cameraTemperatures(input) } : {})
      }
    case 'voiceprint':
      return {
        ...base,
        primaryMetrics: [],
        channels: buildVoiceprintChannels(
          profile.channelCount ?? 8,
          input.channelSources ?? {},
          now
        ),
        details: voiceprintDetailMetrics(source, now)
      }
    case 'airSonar': {
      const target = input.mode === 'event' && input.latestAlarm
        ? parseAirSonarDirection(input.latestAlarm.deviceRaw)
        : undefined
      return {
        ...base,
        primaryMetrics: airSonarPrimaryMetrics(input, now),
        details: airSonarDetailMetrics(input, now),
        ...(target !== undefined ? { target } : {}),
        ...(input.mode === 'event' && input.event ? { event: input.event } : {})
      }
    }
    case 'gasLeakMonitor':
      return { ...base, primaryMetrics: gasLeakPrimaryMetrics(), details: [] }
  }
}

// ---------------------------------------------------------------------------
// 各模板的读数
// ---------------------------------------------------------------------------

/**
 * 声相机 PD 模板的四个 KPI：全部来自**尚未确认的实时字段**（PRPD / PD 概率 / 温度）。
 *
 * 为什么不填一个"大概值"：规格开头自己就写了"避免前端把尚未确认的字段写死"。
 * 因此 V1 在这里诚实地显示 `—`，中心 PRPD 区显示"接口未提供"状态；
 * 一旦 FA371 的实时解析确认这些字段，只需要在本函数里换掉 `missingMetric`。
 */
/**
 * 声相机温度读数：值来自红外 `/inrared_data`；没有就保持 `nodata`。
 *
 * **单位不在这里猜**：设备手册明确单位跟随 `ir_unit`（摄氏/华氏/开尔文），
 * 而这一路预览没有带配置；界面用一句提示说明"单位以设备红外配置为准"。
 */
function cameraTemperatureValue(
  input: RealtimeFrameInput,
  key: string,
  value: number | undefined,
  precision: number
): MetricValue {
  return valueMetric(key, value, {
    precision,
    ...(input.infrared ? { timestamp: input.infrared.timestamp } : {}),
    now: input.now,
    noteKey: 'realtimeUi.tempUnitHint'
  })
}

/** 声相机 PD 模板的四个 KPI：声音能量 / 放电类型 / 置信度 / 最高温。 */
function cameraPdMetrics(input: RealtimeFrameInput): MetricValue[] {
  return [
    missingMetric('soundEnergy', { unit: 'dB' }),
    missingMetric('pdType'),
    missingMetric('confidence', { unit: '%' }),
    cameraTemperatureValue(input, 'maxTemp', input.infrared?.maxTemp, 1)
  ]
}

/** 声相机 Leak 模板的四个 KPI：声音能量 / 泄漏速率 / 损失 / 最高温。 */
function cameraLeakMetrics(input: RealtimeFrameInput): MetricValue[] {
  return [
    missingMetric('soundEnergy', { unit: 'dB' }),
    missingMetric('leakRate', { unit: 'L/min', precision: 2 }),
    missingMetric('loss'),
    cameraTemperatureValue(input, 'maxTemp', input.infrared?.maxTemp, 1)
  ]
}

/** 右栏 Detail：中心温 / 最低温（最高温已在左栏 KPI）。 */
function cameraThermalDetails(input: RealtimeFrameInput): MetricValue[] {
  return [
    cameraTemperatureValue(input, 'centerTemp', input.infrared?.centerTemp, 1),
    cameraTemperatureValue(input, 'minTemp', input.infrared?.minTemp, 1)
  ]
}
/** 温度块（规格里的 Temperature Max / Center / Min）：只填设备真的给了的字段。 */
function cameraTemperatures(input: RealtimeFrameInput): RealtimeTemperatures {
  const infrared = input.infrared
  return {
    ...(infrared
      ? {
          timestamp: infrared.timestamp,
          ...(infrared.maxTemp !== undefined ? { max: infrared.maxTemp } : {}),
          ...(infrared.centerTemp !== undefined ? { center: infrared.centerTemp } : {}),
          ...(infrared.minTemp !== undefined ? { min: infrared.minTemp } : {})
        }
      : {})
  }
}/** Air Sonar 左栏：MAX SPL / MAX CHANNEL / EVENT / PTZ。 */
/** Air Sonar MAX CHANNEL: realtime callback first, then alarm raw max_db_chn. */
function airSonarChannelMetric(input: RealtimeFrameInput, now: number): MetricValue {
  const realtime = input.e2Realtime
  const realtimeChannel = realtime?.maxDbChannel
  if (realtimeChannel !== undefined && input.e2RealtimeAt !== undefined) {
    return valueMetric('maxChannel', 'CH' + realtimeChannel, {
      now,
      quality: realtimeQualityAt(input.e2RealtimeAt, now)
    })
  }
  const channelLabel = rawChannelLabel(input.latestAlarm)
  if (channelLabel === undefined) return missingMetric('maxChannel')
  return valueMetric('maxChannel', channelLabel, {
    now,
    quality: realtimeQualityAt(input.latestAlarm?.timestamp, now)
  })
}
function airSonarPrimaryMetrics(input: RealtimeFrameInput, now: number): MetricValue[] {
  const realtime = input.e2Realtime
  const alarm = input.latestAlarm
  const source = input.featureSource ?? (alarm ? featureSourceOfAlarm(alarm) : null)

  const realtimeSpl = realtime?.maxDbValue
  const splTimestamp =
    realtimeSpl !== undefined ? input.e2RealtimeAt : source?.timestamp
  const maxSpl = valueMetric('maxSpl', realtimeSpl ?? source?.spl, {
    unit: 'dB',
    precision: 1,
    ...(splTimestamp !== undefined ? { timestamp: splTimestamp } : {}),
    now,
    ...(realtimeSpl === undefined && source?.severity !== undefined ? { severity: source.severity } : {})
  })

  const maxChannel = airSonarChannelMetric(input, now)
  const eventValue = input.mode === 'event' && input.event ? input.event.rawLabel ?? null : null
  const event =
    eventValue !== null
      ? valueMetric('event', eventValue, { now })
      : missingMetric('event', {
          textKey: input.event ? input.event.labelKey : 'realtimeUi.event.none'
        })
  // PTZ 状态没有已确认的实时来源；Live 显示 — 比编一个待机状态诚实（规格 §20）。
  const ptz =
    input.mode === 'event' && input.event
      ? missingMetric('ptz', { textKey: 'realtimeUi.ptz.tracking' })
      : missingMetric('ptz')
  return [maxSpl, maxChannel, event, ptz]
}

/** Air Sonar 右栏：MAX CHANNEL / TDE / FDE（规格 §20 的每秒实时字段）。 */
function airSonarDetailMetrics(input: RealtimeFrameInput, now: number): MetricValue[] {
  const realtime = input.e2Realtime
  const alarm = input.latestAlarm
  const maxChannel = airSonarChannelMetric(input, now)

  const realtimeTde = realtime?.maxTdrValue
  const tde = realtimeTde ?? rawAlarmNumber(alarm, 'max_tddr_value') ?? rawAlarmNumber(alarm, 'tde_ratio')
  const tdeTimestamp = realtimeTde !== undefined ? input.e2RealtimeAt : alarm?.timestamp

  const realtimeFde = realtime?.maxFdrValue
  const fde = realtimeFde ?? rawAlarmNumber(alarm, 'max_fdr_value') ?? rawAlarmNumber(alarm, 'fde_ratio')
  const fdeTimestamp = realtimeFde !== undefined ? input.e2RealtimeAt : alarm?.timestamp

  return [
    maxChannel,
    tde !== undefined
      ? valueMetric('tdeRatio', tde, {
          precision: 5,
          now,
          ...(tdeTimestamp !== undefined ? { timestamp: tdeTimestamp } : {})
        })
      : missingMetric('tdeRatio'),
    fde !== undefined
      ? valueMetric('fdeRatio', fde, {
          precision: 2,
          now,
          ...(fdeTimestamp !== undefined ? { timestamp: fdeTimestamp } : {})
        })
      : missingMetric('fdeRatio')
  ]
}
/** FA8 右栏七项，顺序固定（规格 §16）。 */
function voiceprintDetailMetrics(source: FeatureSource | null, now: number): MetricValue[] {
  return [
    featureMetric(source, 'spl', 'dB', 1, now),
    featureMetric(source, 'mainFrequency', 'Hz', 1, now),
    featureMetric(source, 'bandEnergyRatio', '', 3, now),
    featureMetric(source, 'smoothness', '', 3, now),
    featureMetric(source, 'oddEvenHarmonicRatio', '', 3, now),
    featureMetric(source, 'spectralComplexity', '', 2, now),
    featureMetric(source, 'fingerprintVariation', '', 3, now)
  ]
}

/** WL15 V1（规格 §25）：只显示已确认的连接/边缘推理状态，泄漏量等字段留空。 */
function gasLeakPrimaryMetrics(): MetricValue[] {
  return [
    missingMetric('leakStatus', { textKey: 'realtimeUi.leakStatus.unknown' }),
    missingMetric('edgeAi'),
    missingMetric('connection'),
    missingMetric('lastAnalysis')
  ]
}