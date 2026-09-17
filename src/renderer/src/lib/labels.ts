/**
 * Locale-aware renderers for domain enums.
 *
 * WHY THIS IS SEPARATE FROM `shared/domain/*`
 * The shared domain modules are deliberately environment-free: they are imported
 * by the main process and by unit tests that run under plain Node, so they must
 * not reach for a vue-i18n instance. Their job is to turn a device's wire format
 * into a typed domain value — including `alarmTypeKey()`, which returns a STABLE
 * snake_case key precisely so the UI can translate it.
 *
 * This module is the renderer half of that contract: key in, translated label
 * out. It keeps the "UI must not do bit arithmetic" rule intact (decoding still
 * happens in `shared/domain/alarm-mask.ts`) while letting the text be localised.
 */

import { i18n } from '@renderer/i18n'
import { alarmTypeKey, decodeAlarmMask } from '@shared/domain/alarm-mask'
import type { AlarmType } from '@shared/domain/models'

/** Translated name of one alarm type. */
export function alarmTypeLabel(type: AlarmType): string {
  const key = alarmTypeKey(type)
  const translated = i18n.global.t(`alarms.type.${key}` as never)
  // An unknown key means the taxonomy gained a member before the catalogues did.
  // Falling back to the stable key is deliberate: it is searchable in the source,
  // whereas a Chinese label in an English UI would be a silent defect.
  return typeof translated === 'string' && !translated.startsWith('alarms.type.')
    ? translated
    : key
}

/**
 * Human-readable description of an alarm bitmask.
 *
 * Composed rather than a single message because a mask can carry several alarm
 * types at once ("Sound pressure level + Main frequency"). The separator is
 * passed in by the caller so a table cell can use a narrower one than a
 * detail panel.
 */
export function describeAlarmMask(mask: number, separator = ' + '): string {
  const types = decodeAlarmMask(mask)
  if (types.length > 0) {
    return types.map(alarmTypeLabel).join(separator)
  }
  // No defined bit set. Distinguish "nothing happened" from "the device set a bit
  // this version does not know", which are very different things to an engineer.
  if (mask > 0) {
    return i18n.global.t('alarms.unknownMask', { mask: mask.toString(16) })
  }
  return i18n.global.t('alarms.none')
}

/** Translated name for a stream kind key (`features`, `audio`, …). */
export function streamKindLabel(kind: string): string {
  const translated = i18n.global.t(`domain.streamKind.${kind}` as never)
  return typeof translated === 'string' && !translated.startsWith('domain.streamKind.')
    ? translated
    : kind
}

/**
 * Translated name for a live-stream connection state.
 *
 * The state values come from the domain model (`StreamState`) and are uppercase
 * enum members, so they map straight onto catalogue keys.
 */
export function streamStateLabel(state: string): string {
  const translated = i18n.global.t(`streamState.${state}` as never)
  return typeof translated === 'string' && !translated.startsWith('streamState.')
    ? translated
    : state
}

/** Translated name for a recording type key (`alarm`, `manual`, `scheduled`). */
export function recordingTypeLabel(type: string): string {
  const translated = i18n.global.t(`domain.recordingType.${type}` as never)
  return typeof translated === 'string' && !translated.startsWith('domain.recordingType.')
    ? translated
    : type
}

// ---------------------------------------------------------------------------
// 事件与告警中心
// ---------------------------------------------------------------------------

/**
 * 目录键 + 兜底的通用翻译。
 *
 * 四组事件相关的枚举走的是同一条规则：领域层只产出稳定标识
 * （`shared/domain/event-center.ts`），渲染层在这里翻成当前语言。
 * 查不到时返回**标识本身**——它可以在源码里被搜到，而一句中文出现在英语界面上
 * 是一个不会有人报的缺陷。
 */
function domainLabel(prefix: string, key: string): string {
  const translated = i18n.global.t(`${prefix}.${key}` as never)
  return typeof translated === 'string' && !translated.startsWith(`${prefix}.`)
    ? translated
    : key
}

/** 事件来源（`deviceDetect` / `linkage` / `localAlarm`）。 */
export function eventSourceLabel(source: string): string {
  return domainLabel('domain.eventSource', source)
}

/** 事件等级（`info` / `warning` / `critical` / `unknown`）。 */
export function eventSeverityLabel(severity: string): string {
  return domainLabel('domain.eventSeverity', severity)
}

/** 事件种类（`deviceDetect` / `deviceDetectAlarm` / `linkageAlarm` / `localAlarm`）。 */
export function eventKindLabel(kind: string): string {
  return domainLabel('domain.eventKind', kind)
}

/** 检测结果文件的种类（手册 §5.1.17 的八种）。 */
export function detectFileKindLabel(kind: string): string {
  return domainLabel('domain.detectFileKind', kind)
}

/** 结果文件下载阶段（`starting` / `fetching` / …）。 */
export function eventDownloadStageLabel(stage: string): string {
  return domainLabel('domain.eventDownloadStage', stage)
}
