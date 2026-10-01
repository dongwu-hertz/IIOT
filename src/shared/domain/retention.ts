/**
 * 保留策略（容量优先）—— 业主 2026-09-30 的三条决策：
 *   ① 优先级是**容量**（不是天数）；② 超限时**删最旧的**；
 *   ③ 只有**严重/告警级（warning 以上）**的告警录像进"永久保存"区，该区**占配额 10%**；
 *   ④ 手动录像**不自动删**，但计入总容量；盘满时**先删连续录像**。
 *
 * 纯策略放在 `shared/`：它是"该删哪些文件"这件事的全部内容，必须能被单测逐条钉住 ——
 * 删除是不可逆的，一条判据写错就是从用户的盘上抹掉证据。
 */

export type RetentionKind = 'alarm' | 'manual' | 'scheduled'

export interface RetentionCandidate {
  id: string
  kind: RetentionKind
  bytes: number
  /** 录制起始时刻（决定"谁更旧"）。 */
  startMs: number
  /** 告警等级原文（库里的取值）；只有 `kind='alarm'` 有意义。 */
  severity?: string
}

/** 进"永久保存"区的等级（其余告警与连续录像一起滚动）。 */
export const RETENTION_PROTECTED_SEVERITIES: readonly string[] = ['warning', 'alarm', 'critical']

export function isRetentionProtected(
  candidate: RetentionCandidate,
  protectedSeverities: readonly string[] = RETENTION_PROTECTED_SEVERITIES
): boolean {
  if (candidate.kind !== 'alarm') return false
  const severity = (candidate.severity ?? '').trim().toLowerCase()
  return severity !== '' && protectedSeverities.includes(severity)
}

export interface RetentionPlanInput {
  candidates: readonly RetentionCandidate[]
  /** 容量上限（字节）。 */
  quotaBytes: number
  /** 保留区比例，默认 0.1（10%）。 */
  alarmReserveRatio?: number
  /** 当前总占用（含趋势/日志/缓存等非录像数据）；不传则用候选之和。 */
  totalBytes?: number
}

export interface RetentionPlan {
  /** 该删的（最旧优先，调用方按顺序删）。 */
  deleteIds: string[]
  freedBytes: number
  /** 保留区实际占用（永久保存的告警）。 */
  reservedBytes: number
  /** 删完之后**仍然超出**配额的部分；> 0 表示只剩永久告警与手动录像 —— 如实报，不假装清干净了。 */
  remainingOverBytes: number
  /** 保留区自身超出 10% 而被删掉的部分（用于界面解释"为什么永久告警也会少"）。 */
  reservedEvictedBytes: number
}

const DEFAULT_RESERVE_RATIO = 0.1

function normaliseQuota(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * 算出"该删哪些"。**只算不删** —— 真正删文件/删行由调用方做，且必须先删文件再删行。
 *
 * 顺序即优先级：
 *   1. 保留区（warning 以上的告警）封顶 = 配额 × 比例，超出部分按**最旧优先**进待删；
 *   2. 手动录像**永不进待删**；
 *   3. 其余（连续录像切片 + 非保护等级的告警）按**最旧优先**排成待删队列；
 *   4. 从最旧的开始删，直到总占用回到配额以内；
 *   5. 队列删空仍超（只剩保留区与手动）→ 停下来并报 `remainingOverBytes`。
 */
export function planCapacityRetention(input: RetentionPlanInput): RetentionPlan {
  const quota = normaliseQuota(input.quotaBytes)
  const ratio =
    typeof input.alarmReserveRatio === 'number' && input.alarmReserveRatio >= 0
      ? Math.min(1, input.alarmReserveRatio)
      : DEFAULT_RESERVE_RATIO
  const candidates = input.candidates.filter((entry) => Number.isFinite(entry.bytes) && entry.bytes > 0)
  const total = Number.isFinite(input.totalBytes)
    ? Math.max(0, Math.floor(input.totalBytes as number))
    : candidates.reduce((sum, entry) => sum + entry.bytes, 0)

  if (quota === 0 || total <= quota) {
    return {
      deleteIds: [],
      freedBytes: 0,
      reservedBytes: candidates
        .filter((entry) => isRetentionProtected(entry))
        .reduce((sum, entry) => sum + entry.bytes, 0),
      remainingOverBytes: 0,
      reservedEvictedBytes: 0
    }
  }

  const reserveCap = Math.floor(quota * ratio)
  const protectedOnes = candidates
    .filter((entry) => isRetentionProtected(entry))
    .sort((left, right) => right.startMs - left.startMs) // 新的先留
  const reserved: RetentionCandidate[] = []
  const reservedEvicted: RetentionCandidate[] = []
  let reservedBytes = 0
  for (const entry of protectedOnes) {
    if (reservedBytes + entry.bytes <= reserveCap) {
      reserved.push(entry)
      reservedBytes += entry.bytes
    } else {
      reservedEvicted.push(entry)
    }
  }

  const deletable = candidates
    .filter((entry) => entry.kind !== 'manual' && !reserved.includes(entry))
    .sort((left, right) => left.startMs - right.startMs) // 旧的先删

  const deleteIds: string[] = []
  let freedBytes = 0
  let projected = total
  for (const entry of deletable) {
    if (projected <= quota) break
    deleteIds.push(entry.id)
    freedBytes += entry.bytes
    projected -= entry.bytes
  }

  return {
    deleteIds,
    freedBytes,
    reservedBytes,
    remainingOverBytes: Math.max(0, projected - quota),
    reservedEvictedBytes: reservedEvicted.reduce((sum, entry) => sum + entry.bytes, 0)
  }
}
