/**
 * Alarm bit-mask decoding (spec appendix B).
 *
 * The spec is explicit: "统一在 AlarmService 中实现；Vue 页面禁止直接做 bit 判断"
 * — decoding lives in one place, and no Vue component may test bits itself.
 * This module is the single source of truth for that decoding on both sides.
 *
 * It decodes to TYPES AND KEYS, never to text. Rendering a mask is the renderer's
 * job (`@renderer/lib/labels`), because only the renderer knows the active
 * language; a Chinese label produced here would be untranslatable everywhere.
 */

import { AlarmType, ALARM_TYPE_KEYS } from './models'
import type { EventSeverity } from './event-center'

/** Highest defined bit index in the V1 taxonomy (Bit13 = DC Bias). */
export const ALARM_MASK_BITS = 14

/** Precomputed masks for each defined alarm bit. */
export const ALARM_BIT_MASKS: Readonly<Record<AlarmType, number>> = Object.freeze(
  Object.values(AlarmType)
    .filter((value): value is AlarmType => typeof value === 'number')
    .reduce(
      (accumulator, type) => {
        accumulator[type] = 1 << type
        return accumulator
      },
      {} as Record<AlarmType, number>
    )
)

const ALL_ALARM_TYPES: readonly AlarmType[] = Object.values(AlarmType).filter(
  (value): value is AlarmType => typeof value === 'number'
)

/**
 * Decode a raw firmware alarm bit mask into domain alarm types.
 *
 * Ascending bit order is preserved, so the returned array is stable and can be
 * rendered directly without further sorting.
 *
 * @param mask Raw mask from the device. Non-integer / negative input yields [].
 */
export function decodeAlarmMask(mask: number): AlarmType[] {
  if (!Number.isFinite(mask) || mask <= 0) return []
  const normalised = Math.floor(mask)
  const decoded: AlarmType[] = []
  for (const type of ALL_ALARM_TYPES) {
    if ((normalised & ALARM_BIT_MASKS[type]) !== 0) decoded.push(type)
  }
  return decoded
}

/** True when the mask contains the given alarm bit. */
export function hasAlarmType(mask: number, type: AlarmType): boolean {
  if (!Number.isFinite(mask) || mask <= 0) return false
  return (Math.floor(mask) & ALARM_BIT_MASKS[type]) !== 0
}

/**
 * Bits set in the mask that have no defined meaning in the V1 taxonomy.
 * Surfaced in the UI as "未知告警位" rather than silently dropped, so that a
 * future firmware adding Bit14+ is visible instead of invisible.
 */
export function unknownAlarmBits(mask: number): number[] {
  if (!Number.isFinite(mask) || mask <= 0) return []
  const normalised = Math.floor(mask)
  const known = ALL_ALARM_TYPES.reduce((acc, type) => acc | ALARM_BIT_MASKS[type], 0)
  const leftover = normalised & ~known
  const bits: number[] = []
  for (let index = 0; index < 32; index += 1) {
    if ((leftover & (1 << index)) !== 0) bits.push(index)
  }
  return bits
}

/**
 * Pick the primary alarm type for list views that need a single label.
 * The first (lowest) set bit wins, matching the appendix B ordering where the
 * four acoustic fundamentals are Bit0-Bit3.
 */
export function primaryAlarmType(mask: number): AlarmType | undefined {
  return decodeAlarmMask(mask)[0]
}

/**
 * Stable, translatable identifier for an alarm type.
 *
 * The `unknown_` fallback exists so a firmware update that adds a bit produces a
 * searchable identifier rather than an empty cell. `ALARM_TYPE_KEYS` is typed as
 * a total `Record`, so the fallback only fires if the enum is widened at runtime.
 */
export function alarmTypeKey(type: AlarmType): string {
  return ALARM_TYPE_KEYS[type] ?? `unknown_${type}`
}

// ---------------------------------------------------------------------------
// 等级划分（**本仓库自己的设计，不是手册的**）
// ---------------------------------------------------------------------------

/**
 * 每个告警位归到哪一档等级。
 *
 * ## 出处必须说清楚：这是**我们**定的，不是 iVMS-4200 手册里的
 *
 * 手册（UD02161B）**全书没有告警等级这个概念**——13 张告警配置表与 6.14 三个小节里
 * 一个等级/优先级字段都没有，唯一近似物是弹窗排序策略 `Prioritize Display of Latest
 * Alarm`，那是显示策略（见 `docs/Ivms4200-UX-REFERENCE.md` §15.5、§15.6）。设备侧同样
 * 不给：声纹设备的告警协议里**没有任何等级字段**（`AlarmEvent` 只有位图），相机的
 * `alarm_level` 读侧写 `0..3`、写侧写 `1..4`、枚举自相矛盾且真机从未回过（§8.3
 * C15/C21）。所以「等级」只能由我们按**告警位的物理含义**自己划。
 *
 * ## 划分依据（三条，按位分组，不做逐位调参）
 *
 *   - `critical`：**会动手损坏设备**的电气故障。短路冲击与过载的特点是"不需要看趋势，
 *     看到就要处理"，这也是全部 14 个位里仅有的两个。
 *   - `warning`：**已经命名的物理缺陷**（夹具松动、冷却器异常、四类放电、直流偏磁）。
 *     它们都指向一个具体的、需要安排检修的对象，而不是"某个量偏了"。
 *   - `info`：**四项声学基础量越限**（Bit0–Bit3）。它们是"测量值过了阈值"，本身还不是
 *     缺陷判定——附录 B 的位序把这四个放在最前，正是因为它们是输入量而不是结论。
 *
 * 阈值化的东西一律不进 `critical`：把「声压超标」和「短路冲击」并列，会让真正的紧急
 * 告警被淹掉。反过来，把放电类降成 `info` 则等于告诉值班员"不用管"。
 *
 * ## 一个位图带多个位时取**最高**档
 *
 * 真实报文会同时置多个位（例如声压越限 + 短路冲击）。按最低档取会把一条紧急告警记成
 * `info`，所以 `deriveAlarmSeverity()` 取最高档。
 */
export const ALARM_SEVERITY_BY_TYPE: Readonly<Record<AlarmType, EventSeverity>> = Object.freeze({
  [AlarmType.SPL]: 'info',
  [AlarmType.MainFrequency]: 'info',
  [AlarmType.BandEnergyRatio]: 'info',
  [AlarmType.Smoothness]: 'info',
  [AlarmType.ClampLooseness]: 'warning',
  [AlarmType.CoolerAnomalyA]: 'warning',
  [AlarmType.CoolerAnomalyB]: 'warning',
  [AlarmType.Overload]: 'critical',
  [AlarmType.ShortCircuitSurge]: 'critical',
  [AlarmType.SurfaceDischarge]: 'warning',
  [AlarmType.CoronaDischarge]: 'warning',
  [AlarmType.GapDischarge]: 'warning',
  [AlarmType.FloatingDischarge]: 'warning',
  [AlarmType.DCBias]: 'warning'
})

/** 排序用权重。`unknown` 最低——它表示"我们没判"，不表示"没事"。 */
const SEVERITY_RANK: Readonly<Record<EventSeverity, number>> = Object.freeze({
  unknown: 0,
  info: 1,
  warning: 2,
  critical: 3
})

/**
 * 按位图给出这条告警的等级。**入库时算一次并快照**，不在读的时候现算。
 *
 * 快照的理由：等级表是我们可以改的设计（见上），而历史告警记录的是"当时我们怎么判的"。
 * 若改成读时派生，改一次表就会把历史记录的等级一起改写——那是篡改记录，不是升级。
 * 所以 `alarms.severity` 是列（`schema.ts` v6 迁移），旧行留在建表默认值 `'unknown'`，
 * **刻意不回填**：v6 之前入库时我们确实没有判过等级，回填等于伪造一个当时不存在的判断。
 *
 * 返回 `'unknown'` 的两种情形都要如实保留：
 *   - 位图里没有任何已知位（只有 Bit14+ 的未知位，或 mask ≤ 0）；
 *   - 已知位存在但映射表缺项（只有枚举被运行时拓宽时才可能）。
 */
export function deriveAlarmSeverity(mask: number): EventSeverity {
  const decoded = decodeAlarmMask(mask)
  let best: EventSeverity = 'unknown'
  for (const type of decoded) {
    const severity = ALARM_SEVERITY_BY_TYPE[type]
    if (severity !== undefined && SEVERITY_RANK[severity] > SEVERITY_RANK[best]) best = severity
  }
  return best
}

