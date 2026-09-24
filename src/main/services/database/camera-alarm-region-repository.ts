/**
 * Local metadata for FA371 alarm regions.
 *
 * The camera stores only scan-area geometry. Stable ids and operator-facing names
 * belong to the desktop application, because later alarm/event records need a
 * durable label even if the camera is rebooted or the UI is reopened.
 */

import { randomUUID } from 'node:crypto'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import type {
  CameraAlarmRegionMetadata,
  CameraAlarmRegionMetadataInput
} from '@shared/domain/camera-control'

interface RegionRow {
  id: string
  device_id: string
  area_index: number
  name: string
  left_top_x: number
  left_top_y: number
  width: number
  height: number
  created_at: number
  updated_at: number
}

function mapRow(row: RegionRow): CameraAlarmRegionMetadata {
  return {
    id: row.id,
    deviceId: row.device_id,
    areaIndex: row.area_index,
    name: row.name,
    leftTopX: row.left_top_x,
    leftTopY: row.left_top_y,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function cleanName(value: string): string {
  return value.trim().slice(0, 64)
}

function intGeometry(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value))
}

export class CameraAlarmRegionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  list(deviceId: string): CameraAlarmRegionMetadata[] {
    const rows = this.db
      .prepare<[string], RegionRow>(
        `SELECT id, device_id, area_index, name, left_top_x, left_top_y, width, height,
                created_at, updated_at
           FROM camera_alarm_regions
          WHERE device_id = ?
          ORDER BY area_index ASC, created_at ASC`
      )
      .all(deviceId)
    return rows.map(mapRow)
  }

  /**
   * Replace one camera's complete metadata snapshot in one transaction.
   *
   * This mirrors `/system/scan_area`: the device endpoint itself writes the whole
   * array, not one rectangle at a time. Existing ids keep their original
   * `created_at`; new rectangles receive a UUID in the main process.
   */
  replace(
    deviceId: string,
    regions: readonly CameraAlarmRegionMetadataInput[]
  ): CameraAlarmRegionMetadata[] {
    const existing = new Map(this.list(deviceId).map((region) => [region.id, region]))
    const now = Date.now()
    const normalised = regions.map((region, index) => {
      const id = region.id?.trim() || randomUUID()
      const old = existing.get(id)
      return {
        id,
        deviceId,
        areaIndex: index,
        name: cleanName(region.name),
        leftTopX: intGeometry(region.leftTopX),
        leftTopY: intGeometry(region.leftTopY),
        width: intGeometry(region.width),
        height: intGeometry(region.height),
        createdAt: old?.createdAt ?? now,
        updatedAt: now
      } satisfies CameraAlarmRegionMetadata
    })

    const replace = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM camera_alarm_regions WHERE device_id = ?`).run(deviceId)
      const insert = this.db.prepare(
        `INSERT INTO camera_alarm_regions (
           id, device_id, area_index, name, left_top_x, left_top_y, width, height,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const region of normalised) {
        insert.run(
          region.id,
          region.deviceId,
          region.areaIndex,
          region.name,
          region.leftTopX,
          region.leftTopY,
          region.width,
          region.height,
          region.createdAt,
          region.updatedAt
        )
      }
    })
    replace()
    return this.list(deviceId)
  }
}
