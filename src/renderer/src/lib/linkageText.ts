/**
 * 联动告警记录的展示文本（铃铛面板 / 实时监测页告警卡 / 告警中心相机区块共用）。
 *
 * 判定在相机上、软件只展示（2026-09-23/24 确立的口径）：这里只是「把设备写好的
 * 字段摆出来」，不做任何重新推导。模式取舍规则：局放（1）看声场强度/主频/放电类型，
 * 泄漏（2）看声场强度/泄漏量，机械（3）看声场强度/主频；模式未知时有什么显示什么。
 */
import type { PendingAlarmRecord } from '@shared/ipc/contract'

type Translate = (key: string, params?: Record<string, unknown>) => string

/** 保留两位小数的展示格式（原始值可能是长浮点尾巴）。 */
function shortNumber(value: number): string {
  return String(Math.round(value * 100) / 100)
}

/**
 * 设备侧指标行：声场强度 / 主频 / 泄漏量按模式取舍。
 *
 * 逐格取值的规则在 `linkageIntensityText` / `linkageFrequencyText` 里（实时监测页那张
 * **统一标题格的告警表**要的是分列的单值，而不是拼成一句话）。这里只是把它们拼起来，
 * 所以两处永远说的是同一件事。
 */
export function linkageMetricsText(t: Translate, record: PendingAlarmRecord): string {
  const parts = [
    linkageIntensityText(t, record),
    linkageFrequencyText(t, record),
    ...leakParts(t, record)
  ].filter((part) => part !== '')
  return parts.join('，')
}

/** 泄漏模式的两个额外量（只有泄漏模式或模式未知时才说）。 */
function leakParts(t: Translate, record: PendingAlarmRecord): string[] {
  const m = record.metrics
  const mode = record.detectMode
  if (mode !== undefined && mode !== 2) return []
  const parts: string[] = []
  if (m?.leakVolume !== undefined) {
    parts.push(t('linkage.metricVolume', { value: shortNumber(m.leakVolume) }))
  }
  if (m?.leakCost !== undefined) {
    parts.push(t('linkage.metricLeakCost', { value: shortNumber(m.leakCost) }))
  }
  return parts
}

/**
 * 「声场强度」那一格（相机告警表的一列）。
 *
 * 两个字段说的是同一件事的不同来源：`soundmapIntensity`（声场图强度）与
 * `alarmDb`（告警时刻声压级，2026-09-23 真机实测存在）。前者优先，与
 * `linkageMetricsText()` 完全同序 —— 同一行在表格里与在铃铛面板里必须是同一个数。
 *
 * **没有值返回空串**（调用方显示 `—`），不写 0：设备没报这个量不等于它是 0。
 */
export function linkageIntensityText(t: Translate, record: PendingAlarmRecord): string {
  const value = record.metrics?.soundmapIntensity ?? record.metrics?.alarmDb
  if (value === undefined) return ''
  return t('linkage.metricIntensity', { value: shortNumber(value) })
}

/**
 * 「主频」那一格。局放（1）与机械（3）模式才有意义；泄漏模式（2）的主频不是这台
 * 设备的判据，模式未知时有什么显示什么（与 `linkageMetricsText()` 同一条取舍）。
 */
export function linkageFrequencyText(t: Translate, record: PendingAlarmRecord): string {
  const value = record.metrics?.alarmDf
  if (value === undefined) return ''
  const mode = record.detectMode
  if (mode !== undefined && mode !== 1 && mode !== 3) return ''
  return t('linkage.metricDf', { value: Math.round(value) })
}

/** 放电类型文案；未知取值不显示（宁缺毋假）。 */
export function linkageDischargeText(t: Translate, record: PendingAlarmRecord): string {
  return record.dischargeTypeKey ? t(`linkage.dischargeType.${record.dischargeTypeKey}`) : ''
}

/** 检测模式文案（局放/泄漏/机械——与 work_mode 同一取值域）。 */
export function linkageDetectModeText(t: Translate, record: PendingAlarmRecord): string {
  if (record.detectMode === 1) return t('cameraControlUi.appModePartialDischarge')
  if (record.detectMode === 2) return t('cameraControlUi.appModeGasLeak')
  if (record.detectMode === 3) return t('cameraControlUi.appModeMechanical')
  return ''
}

/** 告警等级 → 严重度（事件中心/铃铛同一套分档：3 级及以上算「高」）。 */
export function linkageSeverityOf(record: Pick<PendingAlarmRecord, 'alarmLevelRaw'>): 'critical' | 'warning' | 'info' | 'unknown' {
  const level = record.alarmLevelRaw
  if (level === undefined) return 'unknown'
  if (level >= 3) return 'critical'
  if (level >= 2) return 'warning'
  return 'info'
}

/** 触发来源文案键。 */
export function linkageSourceLabelKey(record: Pick<PendingAlarmRecord, 'source'>): string {
  if (record.source === 'poll') return 'linkage.sourcePoll'
  if (record.source === 'push') return 'linkage.sourcePush'
  return 'linkage.sourceWebsocket'
}
