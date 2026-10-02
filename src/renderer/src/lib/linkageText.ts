/**
 * 联动告警记录的展示文本（铃铛面板 / 实时监测页告警卡 / 告警中心相机区块共用）。
 *
 * 判定在相机上、软件只展示（2026-09-23/24 确立的口径）：这里只是「把设备写好的
 * 字段摆出来」，不做任何重新推导。模式取舍规则：局放（1）看声场强度/主频/放电类型，
 * 泄漏（2）看声场强度/泄漏量，机械（3）看声场强度/主频；模式未知时只有非零的泄漏量
 * 才当读数说（数据侧的同一份规则见 `leakMetricsForMode()`）。
 */
import { leakMetricsForMode } from '@shared/domain/alarm-linkage'
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

/**
 * 泄漏模式的两个额外量。取值的唯一规则在 `leakMetricsForMode()`：模式明确不是泄漏
 * 时不说；模式未知（老固件不回 detect_mode）时只有非零值才说 —— 局放记录里的
 * `data_1=0` 是占位，印成「泄漏量 0」就是替设备编了一个读数。
 */
function leakParts(t: Translate, record: PendingAlarmRecord): string[] {
  const m = record.metrics
  const leak = leakMetricsForMode(record.detectMode, m?.leakVolume, m?.leakCost)
  const parts: string[] = []
  if (leak.leakVolume !== undefined) {
    parts.push(t('linkage.metricVolume', { value: shortNumber(leak.leakVolume) }))
  }
  if (leak.leakCost !== undefined) {
    parts.push(t('linkage.metricLeakCost', { value: shortNumber(leak.leakCost) }))
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

/**
 * 只要**数值 + 单位**，不带"声场强度"这几个字。
 *
 * 为什么单独一条：实时监测页那张告警表已经有了**表头**（列名就是「声场强度」「主频」），
 * 格子里再写一遍列名就成了"声场强度 60 dB" —— 表头与格子说同一件事，两遍。
 * 真窗口探针第一次量到的就是那个形状（`firstRowCells: ["…","…","…","声场强度 60 dB","主频 12000 Hz"]`）。
 *
 * 铃铛面板那种**没有表头**的一行说明仍然用 `linkageIntensityText()`（写明字段名才对），
 * 两者共用同一份取值规则，只是要不要带标签不同。
 */
export function linkageIntensityValue(record: PendingAlarmRecord): string {
  const value = record.metrics?.soundmapIntensity ?? record.metrics?.alarmDb
  return value === undefined ? '' : `${shortNumber(value)} dB`
}

/** 主频的数值 + 单位（模式取舍与 `linkageFrequencyText()` 完全一致）。 */
export function linkageFrequencyValue(record: PendingAlarmRecord): string {
  const value = record.metrics?.alarmDf
  if (value === undefined) return ''
  const mode = record.detectMode
  if (mode !== undefined && mode !== 1 && mode !== 3) return ''
  return `${Math.round(value)} Hz`
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

/**
 * 「这条告警为什么没有录像」——**说得出原因**的那一句（业主 2026-09-24 报的现象：
 * 告警中心的告警视频那一栏只有一句"这条告警没有本机联动录像"，看不出为什么）。
 *
 * 判据全部来自**这条告警自己的动作结果**（`actions`），不猜也不去读设置：
 *   · 有录像动作但 failed / skipped → 区分失败与跳过（原文原因由
 *     `linkageRecordingReason()` 另给，拼在后面）；
 *   · 根本没有录像动作 → 这一次联动没有跑录像那一路（动作没开，或这条记录是
 *     在动作结果补上之前就被确认/落库了）。这两种我们从这一条记录里分不出来，
 *     所以**不编**一个具体原因，只如实说"这条没有留下录像动作的结果"。
 *
 * 返回的是**目录键**，不是渲染好的句子（与这个文件里其它函数同一口径）。
 */
export function linkageNoRecordingKey(record: PendingAlarmRecord): string {
  const action = record.actions.find((entry) => entry.action === 'record')
  if (!action) return 'linkage.noRecordingNoAction'
  return action.status === 'failed' ? 'linkage.noRecordingFailed' : 'linkage.noRecordingSkipped'
}

/**
 * 那一次录像动作的**原文原因**（失败/跳过时才有）。调用方把它拼在上一句之后 ——
 * 主进程写进来的 `reason` 是诊断文本（"设备不可达"这类），比我们再翻译一遍更可信。
 */
export function linkageRecordingReason(record: PendingAlarmRecord): string {
  const action = record.actions.find((entry) => entry.action === 'record')
  return action && action.status !== 'success' && action.reason ? action.reason : ''
}
