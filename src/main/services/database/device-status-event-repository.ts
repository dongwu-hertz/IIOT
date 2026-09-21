/**
 * 设备状态事件（上线 / 离线）的持久化（schema v17）。
 *
 * 设备状态翻转只发生在 `DeviceService` 的两处（上线 / 连续失败判离线）；这里负责落库、
 * 查询与确认。与 `alarms` 同一条纪律：SQL 全参数化、读侧收窄、总数由 SQL 算（截断是
 * **精确**数字，不是"读到上限就算截断"）。
 *
 * `severity` 在**写入时**定死（ONLINE → info / OFFLINE → warning，与 schema CHECK 同两个值），
 * 事件中心的等级筛选因此能下推到 SQL。
 */

import { randomUUID } from 'node:crypto'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import type { EventSeverity } from '@shared/domain/event-center'

/** 设备状态事件只会有这两种翻转；`UNKNOWN` 是"还没判"，不是一次翻转。 */
export type DeviceStatus = 'ONLINE' | 'OFFLINE'

export interface DeviceStatusEventRecord {
  id: string
  deviceId: string
  /** 写入时刻的设备名快照（改名 / 删设备后旧事件不追改）。 */
  deviceName: string
  status: DeviceStatus
  severity: EventSeverity
  at: number
  acknowledged: boolean
}

export interface DeviceStatusEventInsert {
  deviceId: string
  deviceName: string
  status: DeviceStatus
  at: number
}

export interface DeviceStatusEventQuery {
  deviceId?: string
  /** 闭区间 epoch ms。 */
  from?: number
  to?: number
  acknowledged?: boolean
  severity?: EventSeverity
  limit: number
  offset?: number
}

interface Row {
  id: string
  device_id: string
  device_name: string
  status: string
  severity: string
  at: number
  acknowledged: number
}

function toRecord(row: Row): DeviceStatusEventRecord {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    status: row.status === 'ONLINE' ? 'ONLINE' : 'OFFLINE',
    severity: (row.severity === 'warning' ? 'warning' : 'info') as EventSeverity,
    at: row.at,
    acknowledged: row.acknowledged === 1
  }
}

/** ONLINE → info / OFFLINE → warning。写库前算好（等级筛选下推 SQL 的前提）。 */
export function severityForStatus(status: DeviceStatus): EventSeverity {
  return status === 'OFFLINE' ? 'warning' : 'info'
}

export class DeviceStatusEventRepository {
  constructor(private readonly db: SqliteDatabase) {}

  record(input: DeviceStatusEventInsert): DeviceStatusEventRecord {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO device_status_events (id, device_id, device_name, status, severity, at, acknowledged)
         VALUES (?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        id,
        input.deviceId,
        input.deviceName,
        input.status,
        severityForStatus(input.status),
        Math.trunc(input.at)
      )
    return {
      id,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      status: input.status,
      severity: severityForStatus(input.status),
      at: Math.trunc(input.at),
      acknowledged: false
    }
  }

  query(query: DeviceStatusEventQuery): { items: DeviceStatusEventRecord[]; total: number } {
    const limit = Number.isFinite(query.limit) && query.limit > 0 ? Math.min(Math.trunc(query.limit), 1000) : 100
    const offset = Number.isFinite(query.offset) && (query.offset ?? 0) > 0 ? Math.trunc(query.offset as number) : 0

    const conditions: string[] = []
    const params: (string | number)[] = []
    if (query.deviceId !== undefined && query.deviceId.trim() !== '') {
      conditions.push('device_id = ?')
      params.push(query.deviceId)
    }
    if (query.from !== undefined) {
      conditions.push('at >= ?')
      params.push(query.from)
    }
    if (query.to !== undefined) {
      conditions.push('at <= ?')
      params.push(query.to)
    }
    if (query.acknowledged !== undefined) {
      conditions.push('acknowledged = ?')
      params.push(query.acknowledged ? 1 : 0)
    }
    if (query.severity !== undefined) {
      conditions.push('severity = ?')
      params.push(query.severity)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = this.db
      .prepare<typeof params, Row>(
        `SELECT * FROM device_status_events ${where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset)
    const totalRow = this.db
      .prepare<typeof params, { total: number }>(`SELECT COUNT(*) AS total FROM device_status_events ${where}`)
      .get(...params)
    return { items: rows.map(toRecord), total: totalRow?.total ?? 0 }
  }

  acknowledge(ids: readonly string[], acknowledged: boolean): number {
    if (ids.length === 0) return 0
    const statement = this.db.prepare(`UPDATE device_status_events SET acknowledged = ? WHERE id = ?`)
    const apply = this.db.transaction(() => {
      let changes = 0
      for (const id of ids) changes += statement.run(acknowledged ? 1 : 0, id).changes
      return changes
    })
    return apply()
  }

  /** 保留清扫（与 alarms 同一口径：按时间窗删）。返回删掉的条数。 */
  prune(beforeMs: number): number {
    return this.db.prepare(`DELETE FROM device_status_events WHERE at < ?`).run(Math.trunc(beforeMs)).changes
  }
}
