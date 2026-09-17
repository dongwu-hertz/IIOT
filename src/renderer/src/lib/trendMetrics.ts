/**
 * Presentation metadata for historical trend metrics (Phase 11).
 *
 * WHY THE TYPES COME FROM THE SHARED CONTRACT
 * `TrendMetric` / `TrendAggregation` are declared in `src/shared/domain/trend.ts`
 * and re-exported by `@shared/ipc/contract`, which is also what types
 * `window.api.trends.query`. Keying the tables below off those exact unions means
 * a metric added to the backend breaks this file at compile time until a
 * translation key and a unit exist for it — and the renderer never has to import
 * anything from `src/main/`.
 *
 * LABELS ARE KEYS, NOT STRINGS
 * The tables below hold `labelKey`/`hintKey` rather than rendered labels, and the
 * exported helpers resolve them through i18n. The tables are built once at module
 * evaluation, so a rendered string would freeze at whatever language was active
 * at startup and the metric selector would not follow a language change.
 *
 * UNITS ARE NOT DECORATION
 * `mainFrequency` is documented in Hz but a real device reports 93000, which is
 * unreadable on an axis; it therefore formats as kHz above 1000. The remaining
 * metrics are unitless ratios, and pretending otherwise would imply a precision
 * the firmware does not provide.
 */

import type { TrendAggregation, TrendMetric } from '@shared/ipc/contract'
import { i18n } from '@renderer/i18n'
import { EMPTY_VALUE, formatHz, formatNumber } from '@renderer/lib/format'
import { formatHzTick } from '@renderer/lib/spectrum'

export interface TrendMetricMeta {
  key: TrendMetric
  /** Display order in the metric selector; lower comes first. */
  order: number
  /** Chinese label for selectors, legends and tooltips. */
  labelKey: string
  /**
   * Short prefix for the Y axis. "SPL" fits next to the axis without stealing
   * plot width the way the full Chinese label does.
   */
  axisLabelKey: string
  /** Unit appended to values, or '' for a unitless ratio. */
  unit: string
  /** Fixed decimals, or undefined for the adaptive default. */
  precision?: number
  /** Value text WITHOUT the unit; EMPTY_VALUE (never 0) when missing. */
  format: (value: number | null | undefined) => string
  /** Optional short tick formatter, e.g. `1.5k` for a frequency axis. */
  tickFormatter?: (value: number) => string
}

/** Ratio metrics share one formatting rule: three decimals, no unit. */
const RATIO_PRECISION = 3

/**
 * THE single source of truth for metric presentation: completeness is enforced
 * by the `Record<TrendMetric, …>` type (a missing metric is a compile error, an
 * unknown one too) and the display order rides along in `order`. There is
 * deliberately no second array of keys to fall out of sync with this one.
 */
export const TREND_METRIC_META: Record<TrendMetric, TrendMetricMeta> = {
  spl: {
    key: 'spl',
    order: 1,
    labelKey: 'metrics.spl',
    // "SPL" is the international abbreviation, identical in every language, so
    // it is a literal rather than a catalogue entry.
    axisLabelKey: 'metrics.spl',
    unit: 'dB',
    precision: 2,
    format: (value) => formatNumber(value, 2)
  },
  mainFrequency: {
    key: 'mainFrequency',
    order: 2,
    labelKey: 'metrics.mainFrequency',
    axisLabelKey: 'metrics.mainFrequency',
    unit: 'Hz',
    format: (value) => formatHz(value),
    // Axis ticks stay short ("1.5k"); the unit is carried by the axis name.
    tickFormatter: formatHzTick
  },
  smoothness: {
    key: 'smoothness',
    order: 3,
    labelKey: 'metrics.smoothness',
    axisLabelKey: 'metrics.smoothness',
    unit: '',
    precision: RATIO_PRECISION,
    format: (value) => formatNumber(value, RATIO_PRECISION)
  },
  bandEnergyRatio: {
    key: 'bandEnergyRatio',
    order: 4,
    labelKey: 'metrics.bandEnergyRatio',
    axisLabelKey: 'metrics.bandEnergyRatio',
    unit: '',
    precision: RATIO_PRECISION,
    format: (value) => formatNumber(value, RATIO_PRECISION)
  },
  oddEvenHarmonicRatio: {
    key: 'oddEvenHarmonicRatio',
    order: 5,
    labelKey: 'metrics.oddEvenHarmonicRatio',
    axisLabelKey: 'metrics.oddEvenHarmonicRatio',
    unit: '',
    precision: RATIO_PRECISION,
    format: (value) => formatNumber(value, RATIO_PRECISION)
  },
  spectralComplexity: {
    key: 'spectralComplexity',
    order: 6,
    labelKey: 'metrics.spectralComplexity',
    axisLabelKey: 'metrics.spectralComplexity',
    unit: '',
    precision: RATIO_PRECISION,
    format: (value) => formatNumber(value, RATIO_PRECISION)
  },
  fingerprintVariation: {
    key: 'fingerprintVariation',
    order: 7,
    labelKey: 'metrics.fingerprintVariation',
    axisLabelKey: 'metrics.fingerprintVariation',
    unit: '',
    precision: RATIO_PRECISION,
    format: (value) => formatNumber(value, RATIO_PRECISION)
  }
}

export interface TrendAggregationMeta {
  key: TrendAggregation
  /** Display order in the aggregation selector; lower comes first. */
  order: number
  labelKey: string
}

/**
 * Aggregation metadata — same single-list rule as the metrics above.
 */
export const TREND_AGGREGATION_META: Record<TrendAggregation, TrendAggregationMeta> = {
  avg: {
    key: 'avg',
    order: 1,
    labelKey: 'aggregation.avg'
  },
  min: {
    key: 'min',
    order: 2,
    labelKey: 'aggregation.min'
  },
  max: {
    key: 'max',
    order: 3,
    labelKey: 'aggregation.max'
  },
  p95: {
    key: 'p95',
    order: 4,
    labelKey: 'aggregation.p95'
  }
}

/**
 * Selector options, sorted by the `order` field of each entry.
 * `Object.values` gives a fresh array, so the in-place sort cannot disturb the
 * lookup table above.
 */
export const TREND_METRIC_OPTIONS: readonly TrendMetricMeta[] = Object.values(
  TREND_METRIC_META
).sort((left, right) => left.order - right.order)

export const TREND_AGGREGATION_OPTIONS: readonly TrendAggregationMeta[] = Object.values(
  TREND_AGGREGATION_META
).sort((left, right) => left.order - right.order)

export function trendMetricLabel(metric: TrendMetric): string {
  return i18n.global.t(TREND_METRIC_META[metric].labelKey as never)
}

export function trendAggregationLabel(aggregation: TrendAggregation): string {
  return i18n.global.t(TREND_AGGREGATION_META[aggregation].labelKey as never)
}

/**
 * Y-axis name, e.g. `SPL（平均）· dB` / `SPL (Average) · dB`.
 *
 * The aggregation is part of the axis title because the SAME metric plotted as
 * an average and as a 95th percentile is two different measurements; leaving it
 * out of the axis makes the chart ambiguous the moment someone screenshots it.
 *
 * The bracket punctuation comes from the catalogue rather than being hard-coded:
 * Chinese uses full-width parentheses where English, Spanish and Turkish use
 * ASCII ones.
 */
export function trendAxisName(metric: TrendMetric, aggregation: TrendAggregation): string {
  const meta = TREND_METRIC_META[metric]
  const suffix = meta.unit ? ` · ${meta.unit}` : ''
  const composite = i18n.global.t('axisTitle.composite', {
    metric: i18n.global.t(meta.axisLabelKey as never),
    aggregation: trendAggregationLabel(aggregation)
  })
  return `${composite}${suffix}`
}

/** `62.35 dB` / `1.5 kHz` / `—` — a value with its unit, never a fake zero. */
export function trendValueText(metric: TrendMetric, value: number | null | undefined): string {
  const meta = TREND_METRIC_META[metric]
  const text = meta.format(value)
  if (text === EMPTY_VALUE) return EMPTY_VALUE
  return meta.unit ? `${text} ${meta.unit}` : text
}

/**
 * Bucket size as a human span: `15 秒` / `5 min` / `1 Stunde`…
 *
 * Worth showing verbatim in the diagnostics line: the number is the whole
 * reason a month of history can be plotted at all.
 *
 * The count goes through the catalogue as a placeholder and the unit comes from
 * a per-unit key, because Turkish and Spanish do not put the numeral where
 * Chinese does — assembling the string here would force every language into
 * Chinese word order.
 */
export function formatBucketSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return EMPTY_VALUE
  if (seconds < 60) return i18n.global.t('bucket.seconds', { count: Math.round(seconds) })
  if (seconds < 3600) return i18n.global.t('bucket.minutes', { count: trimUnit(seconds / 60) })
  if (seconds < 86_400) return i18n.global.t('bucket.hours', { count: trimUnit(seconds / 3600) })
  return i18n.global.t('bucket.days', { count: trimUnit(seconds / 86_400) })
}

/** `2` instead of `2.0`, but keep one decimal when it is meaningful (1.5). */
function trimUnit(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)
}
