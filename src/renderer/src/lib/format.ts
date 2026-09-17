/**
 * Presentation-only formatting helpers.
 *
 * Kept free of any protocol knowledge: they format domain model values that
 * already arrived through window.api.*.
 *
 * `noUncheckedIndexedAccess` and "NaN is not zero" are both taken seriously
 * here — the backend deliberately returns NaN/undefined for missing metrics
 * rather than a misleading 0, so formatting must render "—" instead of "0".
 *
 * LANGUAGE-SENSITIVE HELPERS GO THROUGH i18n
 * Numbers, dates and relative times do not read the same in every language:
 * `1.234,5` versus `1,234.5`, and Spanish puts the day before the month. Those
 * are locale DATA, so they delegate to `Intl` via the i18n instance rather than
 * being hand-formatted. Which helpers are language-neutral is decided per
 * function: `formatBytes`, `formatHz` and `formatPercent` are unit maths and
 * stay as they are.
 */

import { i18n } from '@renderer/i18n'

/** Placeholder for "the value does not exist". Never render a fake zero. */
export const EMPTY_VALUE = '—'

export function isMissingNumber(value: unknown): boolean {
  return value === null || value === undefined || typeof value !== 'number' || Number.isNaN(value)
}

/** Adaptive decimal formatting: keeps small values readable, big ones compact. */
export function formatNumber(value: number | null | undefined, fractionDigits?: number): string {
  if (isMissingNumber(value)) return EMPTY_VALUE
  const numeric = value as number
  if (!Number.isFinite(numeric)) return EMPTY_VALUE
  if (fractionDigits !== undefined) {
    // `Intl` rather than `toFixed`: renders `1234,5` in Spanish and
    // `1.234,5` in Turkish, and applies the locale's own grouping rules.
    return new Intl.NumberFormat(i18n.global.locale.value, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits
    }).format(numeric)
  }
  const magnitude = Math.abs(numeric)
  if (magnitude === 0) return new Intl.NumberFormat(i18n.global.locale.value).format(0)
  if (magnitude >= 1000) return new Intl.NumberFormat(i18n.global.locale.value, { maximumFractionDigits: 0 }).format(numeric)
  if (magnitude >= 100) return new Intl.NumberFormat(i18n.global.locale.value, { maximumFractionDigits: 1 }).format(numeric)
  if (magnitude >= 1) return new Intl.NumberFormat(i18n.global.locale.value, { maximumFractionDigits: 2 }).format(numeric)
  return new Intl.NumberFormat(i18n.global.locale.value, { maximumFractionDigits: 3 }).format(numeric)
}

/** Number with an explicit unit, or "—" when missing. */
export function formatWithUnit(
  value: number | null | undefined,
  unit: string,
  fractionDigits?: number
): string {
  const text = formatNumber(value, fractionDigits)
  return text === EMPTY_VALUE ? EMPTY_VALUE : `${text} ${unit}`
}

export function formatBytes(bytes: number | null | undefined, fractionDigits = 1): string {
  if (isMissingNumber(bytes)) return EMPTY_VALUE
  const value = bytes as number
  if (value < 0) return EMPTY_VALUE
  if (value === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const scaled = value / 1024 ** exponent
  const digits = exponent === 0 ? 0 : fractionDigits
  return `${scaled.toFixed(digits)} ${units[exponent] ?? 'B'}`
}

const GB = 1073741824

/** GB -> bytes, for the retention/free-space settings form. */
export function gbToBytes(gb: number): number {
  return Math.round(gb * GB)
}

/** bytes -> GB, rounded to 2 decimals for display in an input box. */
export function bytesToGb(bytes: number): number {
  return Math.round((bytes / GB) * 100) / 100
}

export function formatGb(bytes: number | null | undefined): string {
  if (isMissingNumber(bytes)) return EMPTY_VALUE
  return `${bytesToGb(bytes as number).toFixed(2)} GB`
}

function pad(value: number): string {
  return value.toString().padStart(2, '0')
}

/** `14:03:22` — time only, for dense axes and tooltips. */
export function formatClock(epochMs: number | null | undefined): string {
  if (isMissingNumber(epochMs)) return EMPTY_VALUE
  const date = new Date(epochMs as number)
  if (Number.isNaN(date.getTime())) return EMPTY_VALUE
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** `06/05/2024 14:03` etc. — absolute timestamp in tables, in the active locale. */
export function formatDateTime(epochMs: number | null | undefined): string {
  if (isMissingNumber(epochMs)) return EMPTY_VALUE
  const date = new Date(epochMs as number)
  if (Number.isNaN(date.getTime())) return EMPTY_VALUE
  return new Intl.DateTimeFormat(i18n.global.locale.value, {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(date)
}

/** Date only, for axis ticks on week/month ranges, in the active locale. */
export function formatDate(epochMs: number | null | undefined): string {
  if (isMissingNumber(epochMs)) return EMPTY_VALUE
  const date = new Date(epochMs as number)
  if (Number.isNaN(date.getTime())) return EMPTY_VALUE
  return new Intl.DateTimeFormat(i18n.global.locale.value, { dateStyle: 'short' }).format(date)
}

/**
 * Axis tick label for a time series, adapted to the span being plotted.
 *
 * A 30-day range labelled with seconds is ~500 unreadable labels, and a
 * 10-minute range labelled with a bare date renders every tick identically.
 * Both failure modes are avoided by choosing the format from the span, and the
 * clock part still comes from `formatClock`/`formatDate` so no component writes
 * its own date arithmetic.
 */
export function formatTrendTick(epochMs: number | null | undefined, spanMs: number): string {
  if (isMissingNumber(epochMs)) return ''
  const date = new Date(epochMs as number)
  if (Number.isNaN(date.getTime())) return ''

  const clock = formatClock(epochMs)
  const shortDate = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

  if (!Number.isFinite(spanMs) || spanMs <= 0) return clock
  if (spanMs <= 6 * HOUR) return clock
  if (spanMs <= 3 * DAY) return `${shortDate} ${clock.slice(0, 5)}`
  if (spanMs > 300 * DAY) return formatDate(epochMs)
  return shortDate
}

/** Value for `<input type="datetime-local">` (local time, no seconds). */
export function toDateTimeLocalValue(epochMs: number | null | undefined): string {
  if (isMissingNumber(epochMs)) return ''
  const date = new Date(epochMs as number)
  if (Number.isNaN(date.getTime())) return ''
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** Parse a datetime-local input value back into epoch ms, or undefined. */
export function fromDateTimeLocalValue(value: string): number | undefined {
  if (!value) return undefined
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? undefined : parsed
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function formatDuration(durationMs: number | null | undefined): string {
  if (isMissingNumber(durationMs)) return EMPTY_VALUE
  const value = Math.max(0, durationMs as number)
  if (value < SECOND) return `${Math.round(value)} ms`
  if (value < MINUTE) return `${(value / SECOND).toFixed(1)} s`
  const t = i18n.global.t
  if (value < HOUR) {
    const minutes = Math.floor(value / MINUTE)
    const seconds = Math.round((value % MINUTE) / SECOND)
    return t('duration.minutesSeconds', { minutes, seconds: pad(seconds) })
  }
  const hours = Math.floor(value / HOUR)
  const minutes = Math.round((value % HOUR) / MINUTE)
  return t('duration.hoursMinutes', { hours, minutes })
}

/**
 * Relative time, e.g. "3 minutes ago" / "hace 3 minutos" / "3 dakika önce".
 *
 * Delegated to the catalogue rather than `Intl.RelativeTimeFormat`, because the
 * product wants a compact form without the "ago"/"hace" word order differences
 * appearing mid-sentence, and because these strings already exist as whole
 * sentences in every catalogue.
 *
 * Used for "last seen" on device cards, where a relative reading is far more
 * useful than an absolute timestamp.
 */
export function formatRelativeTime(epochMs: number | null | undefined): string {
  const t = i18n.global.t
  if (isMissingNumber(epochMs)) return t('time.never')
  const delta = Date.now() - (epochMs as number)
  if (delta < 10 * SECOND) return t('time.justNow')
  if (delta < MINUTE) return t('time.secondsAgo', { count: Math.floor(delta / SECOND) })
  if (delta < HOUR) return t('time.minutesAgo', { count: Math.floor(delta / MINUTE) })
  if (delta < DAY) return t('time.hoursAgo', { count: Math.floor(delta / HOUR) })
  if (delta < 30 * DAY) return t('time.daysAgo', { count: Math.floor(delta / DAY) })
  return formatDateTime(epochMs)
}

/**
 * Hz with an automatic kHz switch, or "—" when the value does not exist.
 *
 * Used for both sample rates and frequency metrics: a main frequency of 93000
 * is unreadable on an axis, while 93 kHz is not. The rule lives in one place so
 * the two call sites cannot disagree about where the boundary is.
 */
export function formatHz(hz: number | null | undefined): string {
  if (isMissingNumber(hz)) return EMPTY_VALUE
  const value = hz as number
  if (!Number.isFinite(value)) return EMPTY_VALUE
  if (Math.abs(value) >= 1000) {
    const khz = value / 1000
    return `${Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1)} kHz`
  }
  return `${value} Hz`
}

/** Sample rate like `48 kHz`; firmware reports Hz. */
export function formatSampleRate(hz: number | null | undefined): string {
  return formatHz(hz)
}

/** `CH1` .. `CH8`; the protocol exposes 0-based channel indices (spec 11.1). */
export function channelLabel(channelIndex: number | null | undefined): string {
  if (isMissingNumber(channelIndex)) return EMPTY_VALUE
  return `CH${(channelIndex as number) + 1}`
}

export function formatPercent(ratio: number | null | undefined, fractionDigits = 1): string {
  if (isMissingNumber(ratio)) return EMPTY_VALUE
  return `${((ratio as number) * 100).toFixed(fractionDigits)}%`
}

/** Safe JSON preview for opaque payloads (`EndpointProbeResult.json`). */
export function formatJsonPreview(value: unknown, maxLength = 4000): string {
  if (value === undefined || value === null) return ''
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > maxLength
    ? i18n.global.t('widgetsUi.truncated', { text: text.slice(0, maxLength) })
    : text
}

/** Short one-line summary of arbitrary data, for tables. */
export function summarizeUnknown(value: unknown): string {
  if (value === undefined) return EMPTY_VALUE
  if (value === null) return 'null'
  if (Array.isArray(value)) return i18n.global.t('widgetsUi.arrayOf', { count: value.length })
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    return keys.length ? keys.join(', ') : i18n.global.t('widgetsUi.emptyObject')
  }
  return String(value)
}
