/**
 * 事件中心的**处置工作流**仓储（schema v13）：`event_status` + `event_activity`。
 *
 * 为什么这两张表按 `EventCenterEntry.id` 存、而不是加列到 `alarms`：
 * 一条事件有三个所有者（声纹告警在 `alarms`、本机联动在引擎的内存/自有存储、相机检测日志
 * 在设备上），而"处置"是**我们自己的记录**，三个来源一视同仁。详细推理写在
 * `schema.ts` 的 v13 迁移里（那一处是"为什么这么建表"的权威）。
 *
 * 这一层只做两件事：**读当前状态**与**写一条状态变更/指派/留言**。
 *   - **迁移合法性**（`canTransitionStatus`）由服务层判定：那是领域规则，不是存储约束 ——
 *     仓储如果也判一遍，两处规则迟早会分叉；
 *   - **写状态与写流水在同一个事务里**：状态变了却没有记录（或者反过来）是最糟的形态，
 *     因为事后无法解释"谁在什么时候把它关掉的"。
 */

import type { Database as SqliteDatabase } from 'better-sqlite3'

import { isEventActivityKind } from '@shared/domain/event-view'
import type { EventActivityKind, EventActivityView } from '@shared/domain/event-view'
import { isEventStatus } from '@shared/domain/event-center'
import type { EventStatus } from '@shared/domain/event-center'
import { newEventActivityId } from '@shared/utils/id'

/** `event_status` 的一行。 */
export interface EventStatusRow {
  entryId: string
  status: EventStatus
  /** 指派的账户名；没有就是没人负责（`null` 在库里，这里归一成 `undefined`）。 */
  assignee?: string
  updatedAt: number
}

interface RawStatusRow {
  entry_id: string
  status: string
  assignee: string | null
  updated_at: number
}

interface RawActivityRow {
  id: string
  entry_id: string
  at: number
  actor: string
  kind: string
  from_status: string | null
  to_status: string | null
  assignee: string | null
  note: string | null
}

export interface SetEventStatusInput {
  entryId: string
  /** 目标状态；`undefined` 表示**只改指派人**（`kind: 'assign'`）。 */
  status?: EventStatus
  assignee?: string
  /**
   * 只改指派人、而这一条还没有状态行时，用它建那一行（调用方知道当前的有效状态）。
   *
   * 为什么需要它：状态行里既要放状态也要放指派人，而"没动过"与"状态是 new"是两件事。
   * 一条**来源侧已确认**的事件（`alarms.acknowledged = true`）在库里没有状态行时，
   * 界面显示的是「已确认」；如果这里硬写 `'new'`，指派一下就会把它**退回**「待处理」——
   * 一个由"指派"引起的状态回退，操作员完全无法解释。调用方（服务层，从界面拿到当前状态）
   * 传进来的 `fromStatus` 就是用来避免这件事的；没有值时按 `'new'` 建（最保守）。
   */
  fromStatus?: EventStatus
  actor: string
  note?: string
  at: number
}

export interface SetEventStatusResult {
  /** 更新之后的当前状态（`assign` 时状态不变）。 */
  row: EventStatusRow
  activity: EventActivityView
}

export class EventStatusRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /** 一批事件的当前状态（只有真有行的那些；调用方对缺席的按来源标志推）。 */
  statusMap(entryIds: readonly string[]): Map<string, EventStatusRow> {
    const result = new Map<string, EventStatusRow>()
    const unique = [...new Set(entryIds.filter((id) => typeof id === 'string' && id !== ''))]
    if (unique.length === 0) return result

    /**
     * 分批查：SQLite 的变量上限是 999（老版本），而一页可以装 500 条事件 ×
     * 未来的聚合展开 —— 一次拼一个巨大的 `IN (...)` 会在数据变多时突然失败。
     */
    const chunkSize = 400
    for (let index = 0; index < unique.length; index += chunkSize) {
      const chunk = unique.slice(index, index + chunkSize)
      const placeholders = chunk.map(() => '?').join(', ')
      const rows = this.db
        .prepare<unknown[], RawStatusRow>(
          `SELECT entry_id, status, assignee, updated_at FROM event_status WHERE entry_id IN (${placeholders})`
        )
        .all(...chunk)
      for (const raw of rows) {
        const row = toStatusRow(raw)
        if (row) result.set(row.entryId, row)
      }
    }
    return result
  }

  find(entryId: string): EventStatusRow | undefined {
    const raw = this.db
      .prepare<[string], RawStatusRow>(
        `SELECT entry_id, status, assignee, updated_at FROM event_status WHERE entry_id = ?`
      )
      .get(entryId)
    return raw ? toStatusRow(raw) : undefined
  }

  /**
   * 写状态与/或指派人，并记一条 Activity（**一个事务**）。
   *
   * 返回更新之后的行：调用方要拿它**读回核对**（业主的硬规矩：写完读回），
   * 而不是假设写成功了。
   */
  setStatus(input: SetEventStatusInput): SetEventStatusResult {
    const entryId = input.entryId.trim()
    const actor = input.actor.trim() === '' ? 'unknown' : input.actor.trim()
    const note = input.note?.trim() === '' ? undefined : input.note?.trim()
    const assignee = input.assignee?.trim() === '' ? undefined : input.assignee?.trim()
    const at = Number.isFinite(input.at) ? input.at : Date.now()
    const current = this.find(entryId)
    const fromStatus = current?.status ?? 'new'
    const isAssignOnly = input.status === undefined
    const toStatus: EventStatus = isAssignOnly ? fromStatus : (input.status as EventStatus)

    const run = this.db.transaction((): SetEventStatusResult => {
      if (isAssignOnly) {
        // 只改指派人：状态行不存在时**用调用方给的当前状态**建一行（见 `fromStatus` 的注释：
        // 硬写 'new' 会让"指派"顺手把一条已确认的事件退回「待处理」）。
        if (!current) {
          this.db
            .prepare(
              `INSERT INTO event_status (entry_id, status, assignee, updated_at) VALUES (?, ?, ?, ?)`
            )
            .run(entryId, input.fromStatus ?? fromStatus, assignee ?? null, at)
        } else {
          this.db
            .prepare(`UPDATE event_status SET assignee = ?, updated_at = ? WHERE entry_id = ?`)
            .run(assignee ?? null, at, entryId)
        }
      } else {
        this.db
          .prepare(
            `INSERT INTO event_status (entry_id, status, assignee, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(entry_id) DO UPDATE SET
               status = excluded.status,
               assignee = COALESCE(excluded.assignee, event_status.assignee),
               updated_at = excluded.updated_at`
          )
          .run(entryId, toStatus, assignee ?? null, at)
      }

      const kind: EventActivityKind = isAssignOnly ? 'assign' : 'status'
      const activity: EventActivityView = {
        id: newEventActivityId(),
        entryId,
        at,
        actor,
        kind,
        ...(isAssignOnly ? {} : { fromStatus, toStatus }),
        ...(isAssignOnly && assignee !== undefined ? { assignee } : {}),
        ...(note !== undefined ? { note } : {})
      }
      this.db
        .prepare(
          `INSERT INTO event_activity (id, entry_id, at, actor, kind, from_status, to_status, assignee, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          activity.id,
          activity.entryId,
          activity.at,
          activity.actor,
          activity.kind,
          activity.fromStatus ?? null,
          activity.toStatus ?? null,
          activity.assignee ?? null,
          activity.note ?? null
        )
      return { row: this.requireRow(entryId), activity }
    })

    return run()
  }

  /** 一条事件的 Activity（**新的在前**），最多 `limit` 条。 */
  activity(entryId: string, limit = 200): EventActivityView[] {
    const safeLimit = Number.isFinite(limit) ? Math.min(1000, Math.max(1, Math.floor(limit))) : 200
    const rows = this.db
      .prepare<[string, number], RawActivityRow>(
        `SELECT id, entry_id, at, actor, kind, from_status, to_status, assignee, note
           FROM event_activity WHERE entry_id = ? ORDER BY at DESC, id DESC LIMIT ?`
      )
      .all(entryId, safeLimit)
    return rows.map(toActivityView).filter((view): view is EventActivityView => view !== undefined)
  }

  /**
   * 每一条事件的 Activity 条数（列表上显示"有 N 条记录"）。
   *
   * 用一条 `GROUP BY` 而不是逐条查：一页 50 行逐条查就是 50 次往返，
   * 而这里只需要一个数字。
   */
  activityCounts(entryIds: readonly string[]): Map<string, number> {
    const counts = new Map<string, number>()
    const unique = [...new Set(entryIds.filter((id) => typeof id === 'string' && id !== ''))]
    if (unique.length === 0) return counts
    const chunkSize = 400
    for (let index = 0; index < unique.length; index += chunkSize) {
      const chunk = unique.slice(index, index + chunkSize)
      const placeholders = chunk.map(() => '?').join(', ')
      const rows = this.db
        .prepare<unknown[], { entry_id: string; total: number }>(
          `SELECT entry_id, COUNT(*) AS total FROM event_activity
            WHERE entry_id IN (${placeholders}) GROUP BY entry_id`
        )
        .all(...chunk)
      for (const row of rows) counts.set(row.entry_id, row.total)
    }
    return counts
  }

  private requireRow(entryId: string): EventStatusRow {
    const row = this.find(entryId)
    if (!row) throw new Error(`event_status 写入之后读不回来：${entryId}`)
    return row
  }
}

function toStatusRow(raw: RawStatusRow): EventStatusRow | undefined {
  if (!isEventStatus(raw.status)) return undefined
  return {
    entryId: raw.entry_id,
    status: raw.status,
    ...(raw.assignee === null ? {} : { assignee: raw.assignee }),
    updatedAt: raw.updated_at
  }
}

function toActivityView(raw: RawActivityRow): EventActivityView | undefined {
  if (!isEventActivityKind(raw.kind)) return undefined
  return {
    id: raw.id,
    entryId: raw.entry_id,
    at: raw.at,
    actor: raw.actor,
    kind: raw.kind,
    ...(isEventStatus(raw.from_status) ? { fromStatus: raw.from_status } : {}),
    ...(isEventStatus(raw.to_status) ? { toStatus: raw.to_status } : {}),
    ...(raw.assignee === null ? {} : { assignee: raw.assignee }),
    ...(raw.note === null ? {} : { note: raw.note })
  }
}
