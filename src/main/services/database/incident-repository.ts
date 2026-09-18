/**
 * Incident 的仓储（schema v14）：`incidents` + `incident_alerts`。
 *
 * 与 `event-status-repository.ts` 同一条分工：这一层只做**读**与**写**，不做判断 ——
 * 「标题合不合法」是领域规则（`validateIncidentDraft()`），「这一条 Alert 该不该被建议
 * 关联」是视图层的判据。两处都判一遍的规则迟早分叉。
 *
 * 三件必须写下来的事：
 *   1. **创建 + 关联在同一个事务里**。一个创建出来却一条 Alert 都没关联上的 Incident 是
 *      一个空壳，而界面上的"创建并关联这几条"是一次动作 —— 半途失败必须什么都没发生。
 *   2. **关联是幂等的**（主键 `(incident_id, entry_id)` + `INSERT OR IGNORE`）：按钮点两次
 *      不该产生两条链接，也不该报错。
 *   3. **写完读回**（业主的硬规矩）：`create()` / `link()` 返回的都是**从库里重新读出来**的
 *      行，而不是把入参拼回去。
 */

import type { Database as SqliteDatabase } from 'better-sqlite3'

import type { IncidentLinkView } from '@shared/domain/incident'
import { newIncidentId } from '@shared/utils/id'

export interface IncidentRow {
  id: string
  title: string
  note?: string
  createdAt: number
  createdBy: string
  updatedAt: number
}

interface RawIncidentRow {
  id: string
  title: string
  note: string | null
  created_at: number
  created_by: string
  updated_at: number
}

interface RawLinkRow {
  incident_id: string
  entry_id: string
  linked_at: number
  linked_by: string
}

export interface CreateIncidentInput {
  title: string
  note?: string
  createdBy: string
  at: number
  /** 一并关联的 entry id（**可以为空**：先建一个事件、稍后再挂告警也是合法的用法）。 */
  entryIds?: readonly string[]
}

export interface LinkAlertsResult {
  incidentId: string
  /** 这一次真的新增的链接条数。 */
  linked: number
  /** 之前就已经关联过的（幂等命中，不是错误）。 */
  alreadyLinked: number
}

export class IncidentRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * 建一个 Incident（可选：顺手关联一批 Alert）。**一个事务**。
   *
   * 返回库里读回来的那一行；同时把这次真正新增的关联条数交回给调用方（回执要能说清楚）。
   */
  create(input: CreateIncidentInput): { row: IncidentRow; linked: number } {
    const title = input.title.trim()
    const note = input.note?.trim() === '' ? undefined : input.note?.trim()
    const createdBy = input.createdBy.trim() === '' ? 'unknown' : input.createdBy.trim()
    const at = Number.isFinite(input.at) ? input.at : Date.now()
    const entryIds = normaliseEntryIds(input.entryIds ?? [])

    const run = this.db.transaction((): { row: IncidentRow; linked: number } => {
      const id = newIncidentId()
      this.db
        .prepare(
          `INSERT INTO incidents (id, title, note, created_at, created_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, title, note ?? null, at, createdBy, at)
      const linked = this.linkWithin(id, entryIds, createdBy, at)
      return { row: this.requireRow(id), linked }
    })

    return run()
  }

  /**
   * 把一批 Alert 关联到一个已存在的 Incident（幂等）。
   *
   * Incident 不存在时**抛错**：那是调用方的 bug（界面拿到的 id 来自我们自己的库），
   * 静默成功会让界面显示一个不存在的关联。
   */
  link(input: {
    incidentId: string
    entryIds: readonly string[]
    actor: string
    at: number
  }): LinkAlertsResult {
    const incidentId = input.incidentId.trim()
    if (!this.find(incidentId)) {
      throw new Error(`Incident 不存在：${incidentId}`)
    }
    const entryIds = normaliseEntryIds(input.entryIds)
    const actor = input.actor.trim() === '' ? 'unknown' : input.actor.trim()
    const at = Number.isFinite(input.at) ? input.at : Date.now()

    const run = this.db.transaction((): LinkAlertsResult => {
      const before = this.linkCount(incidentId)
      this.linkWithin(incidentId, entryIds, actor, at)
      const after = this.linkCount(incidentId)
      const linked = after - before
      return { incidentId, linked, alreadyLinked: entryIds.length - linked }
    })

    return run()
  }

  /** 解除一条关联。返回"真的删掉了一行"（没关联过就是 `false`，不是错误）。 */
  unlink(input: { incidentId: string; entryId: string }): boolean {
    const result = this.db
      .prepare(`DELETE FROM incident_alerts WHERE incident_id = ? AND entry_id = ?`)
      .run(input.incidentId.trim(), input.entryId.trim())
    return result.changes > 0
  }

  find(id: string): IncidentRow | undefined {
    const raw = this.db
      .prepare<[string], RawIncidentRow>(
        `SELECT id, title, note, created_at, created_by, updated_at FROM incidents WHERE id = ?`
      )
      .get(id.trim())
    return raw ? toIncidentRow(raw) : undefined
  }

  /** 全部 Incident（新的在前）。上限兜住"库里攒了几年"的情况。 */
  list(limit = 200): IncidentRow[] {
    const safeLimit = Number.isFinite(limit) ? Math.min(2000, Math.max(1, Math.floor(limit))) : 200
    const rows = this.db
      .prepare<[number], RawIncidentRow>(
        `SELECT id, title, note, created_at, created_by, updated_at FROM incidents
          ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(safeLimit)
    return rows.map(toIncidentRow)
  }

  /** 一条 Alert 属于哪些 Incident（新的在前）。详情抽屉每次打开问的就是这一句。 */
  forEntry(entryId: string): IncidentRow[] {
    const id = entryId.trim()
    if (id === '') return []
    const rows = this.db
      .prepare<[string], RawIncidentRow>(
        `SELECT i.id, i.title, i.note, i.created_at, i.created_by, i.updated_at
           FROM incident_alerts a JOIN incidents i ON i.id = a.incident_id
          WHERE a.entry_id = ?
          ORDER BY i.created_at DESC, i.id DESC`
      )
      .all(id)
    return rows.map(toIncidentRow)
  }

  /** 一个 Incident 关联的 Alert（新的在前）。 */
  links(incidentId: string): IncidentLinkView[] {
    const rows = this.db
      .prepare<[string], RawLinkRow>(
        `SELECT incident_id, entry_id, linked_at, linked_by FROM incident_alerts
          WHERE incident_id = ? ORDER BY linked_at DESC, entry_id ASC`
      )
      .all(incidentId.trim())
    return rows.map((row) => ({
      incidentId: row.incident_id,
      entryId: row.entry_id,
      linkedAt: row.linked_at,
      linkedBy: row.linked_by
    }))
  }

  /**
   * 每个 Incident 关联了几条 Alert。
   *
   * 一次 `GROUP BY`，不是逐个 `COUNT`：详情抽屉一次要列出一个事件的**所有** Incident。
   */
  alertCounts(incidentIds: readonly string[]): Map<string, number> {
    const counts = new Map<string, number>()
    const unique = normaliseEntryIds(incidentIds)
    if (unique.length === 0) return counts
    const placeholders = unique.map(() => '?').join(', ')
    const rows = this.db
      .prepare<unknown[], { incident_id: string; total: number }>(
        `SELECT incident_id, COUNT(*) AS total FROM incident_alerts
          WHERE incident_id IN (${placeholders}) GROUP BY incident_id`
      )
      .all(...unique)
    for (const row of rows) counts.set(row.incident_id, row.total)
    return counts
  }

  /** 库里一共有几个 Incident（给文档/诊断用；界面上没有那一格 KPI，理由见 domain/incident.ts）。 */
  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM incidents`).get() as { total: number }
    return row.total
  }

  private linkCount(incidentId: string): number {
    const row = this.db
      .prepare<[string], { total: number }>(
        `SELECT COUNT(*) AS total FROM incident_alerts WHERE incident_id = ?`
      )
      .get(incidentId)
    return row?.total ?? 0
  }

  /** 关联一批（`INSERT OR IGNORE`：重复关联是幂等命中），返回新增条数。 */
  private linkWithin(
    incidentId: string,
    entryIds: readonly string[],
    actor: string,
    at: number
  ): number {
    if (entryIds.length === 0) return 0
    const before = this.linkCount(incidentId)
    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO incident_alerts (incident_id, entry_id, linked_at, linked_by)
       VALUES (?, ?, ?, ?)`
    )
    for (const entryId of entryIds) statement.run(incidentId, entryId, at, actor)
    return this.linkCount(incidentId) - before
  }

  private requireRow(id: string): IncidentRow {
    const row = this.find(id)
    if (!row) throw new Error(`incidents 写入之后读不回来：${id}`)
    return row
  }
}

/** 去重 + 丢弃空串（界面上勾选框漏传一个空 id 不该让整次关联失败）。 */
function normaliseEntryIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ''))]
}

function toIncidentRow(raw: RawIncidentRow): IncidentRow {
  return {
    id: raw.id,
    title: raw.title,
    ...(raw.note === null ? {} : { note: raw.note }),
    createdAt: raw.created_at,
    createdBy: raw.created_by,
    updatedAt: raw.updated_at
  }
}
