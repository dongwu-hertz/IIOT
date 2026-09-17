/**
 * Shared low-level primitives.
 *
 * NOTE: deliberately dependency-free (no `crypto.randomUUID`, no node builtins)
 * because this module is bundled into BOTH the Electron main process and the
 * Vue renderer. Keeping it environment-agnostic avoids bundler shims.
 */

/**
 * Monotonic, sortable, collision-resistant local id.
 *
 * Format: `<prefix>_<base36 ms timestamp><base36 counter><random suffix>`
 * Sorting lexicographically orders by creation time, which keeps SQLite
 * primary-key inserts append-only (good for B-tree locality).
 */
let counter = 0

export function createId(prefix: string): string {
  counter = (counter + 1) % 0xffff
  const time = Date.now().toString(36).padStart(9, '0')
  const seq = counter.toString(36).padStart(3, '0')
  const rand = Math.floor(Math.random() * 0x7fffffff).toString(36)
  return `${prefix}_${time}${seq}${rand}`
}

export const newDeviceId = (): string => createId('dev')
export const newChannelId = (): string => createId('chn')
export const newAlarmProfileId = (): string => createId('alp')
export const newAlarmId = (): string => createId('alm')
export const newRecordingId = (): string => createId('rec')
/** 本地样本库的一条样本（`samples` 表，schema v7）。 */
export const newSampleId = (): string => createId('smp')
/** 标签库里的一条（`sample_labels` 表，schema v8）。 */
export const newSampleLabelId = (): string => createId('slb')

/** Current epoch milliseconds. Wrapped so tests can stub it. */
export const now = (): number => Date.now()

/** Clamp helper used by protocol mappers to defend against out-of-range device values. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** Type guard for "is a usable finite number". Device firmware sends nulls and "NaN" strings. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Coerce an arbitrary device payload value into a number.
 * Returns `undefined` rather than NaN so domain models stay honest about gaps.
 */
export function toNumber(value: unknown): number | undefined {
  if (isFiniteNumber(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}
