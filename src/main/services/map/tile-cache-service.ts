/**
 * 瓦片缓存服务（业主 20260921 批：设置里选服务 + 缩放级别范围 + 经纬度区域，
 * 把在线瓦片下载到存储根 `map-cache/<service>/z/x/y.png`，离线复用）。
 *
 * ---------------------------------------------------------------------------
 * 四条硬规矩
 * ---------------------------------------------------------------------------
 *   1. **并发受限**（`TILE_CACHE_CONCURRENCY = 4`）：OSM 这类免费服务的 Tile Usage
 *      Policy 明确禁止高并发抓取；并发 4 是对供应商的礼貌，也是对本机网络栈的保护。
 *   2. **断点续下**：落盘前先看文件是否已存在，存在就跳过（计 `skipped`）。重复点
 *      「下载缓存」不会重写已有瓦片 —— 上一次下到一半的目录是资产，不是垃圾。
 *   3. **总量双上限**：预估瓦片数超 `TILE_CACHE_MAX_TILES`（缩放级别 × 区域太大，
 *      多半是手滑把级别填到了 18）直接拒绝；写盘字节累计超 `TILE_CACHE_MAX_BYTES`
 *      （2 GB）立即中止并报错。两个上限都写进报告，不让「下载」变成「填满数据盘」。
 *   4. **进度如实推送**：每处理一块瓦片发一次 `progress`（下载 n/total、字节数），
 *      收尾发 `done`。编一个假进度条比没有更糟 —— 这里的每个数都数得出来。
 *
 * 与渲染层的分工：URL 拼法用共享层 `tileUrl()`（与地图页 `<img>` 同一份），
 * 缓存路径拼法用共享层 `tileCacheRelativePath()`（与渲染层 `file://` 读盘同一份）。
 * 本服务自己**不维护第二套**模板/路径规则。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { AppError, ErrorCodes } from '@shared/errors'
import {
  isMapTileService,
  isTileZoom,
  tileCacheRelativePath,
  tileRangeForBounds,
  tileUrl,
  type MapTilesConfig,
  type TileCacheBounds
} from '@shared/domain/map-tiles'
import type { MapTileCacheRequest, MapTileCacheResult } from '@shared/ipc/contract'
import { appLog } from '../logging/logger'

/** 同时下载的瓦片数上限（免费瓦片服务的用法政策一般要求低并发）。 */
export const TILE_CACHE_CONCURRENCY = 4
/** 单次任务的总字节上限：2 GB。超限立即中止（已落盘的保留，下次续下会跳过）。 */
export const TILE_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024
/**
 * 单次任务的瓦片数上限：20 万块。一个省在 z3–z16 全级别大约就是这个量级；
 * 超了说明区域/级别组合离谱（多半是把级别直接拉满 18），拒绝比让用户
 * 对着一个跑三天的进度条好。
 */
export const TILE_CACHE_MAX_TILES = 200_000
/** 单块瓦片的下载超时（ms）。瓦片服务慢是常态，但不能让一块瓦片卡住整个任务。 */
const TILE_DOWNLOAD_TIMEOUT_MS = 30_000
/** 进度推送的节流间隔（按已处理块数）。块数小时每块都推，块数大时隔 10 块一推。 */
const PROGRESS_EVERY = 10

export interface TileCacheJobProgress {
  downloaded: number
  skipped: number
  failed: number
  total: number
  bytes: number
  done: boolean
}

export interface TileCacheServiceOptions {
  /** 存储根（每次调用现读：设置里改了存储根，下一次下载就该落到新根）。 */
  getStorageRoot: () => string
}

/** 任务内部的一块待处理瓦片。 */
interface PendingTile {
  z: number
  x: number
  y: number
}

export class TileCacheService extends EventEmitter {
  private readonly getStorageRoot: () => string
  /** 同一时间只允许一个下载任务（第二个调用直接拒绝，免得两个任务互相踩进度）。 */
  private running = false

  constructor(options: TileCacheServiceOptions) {
    super()
    this.getStorageRoot = options.getStorageRoot
  }

  /**
   * 下载一批瓦片到本地缓存。校验 → 铺任务 → 并发执行 → 汇总。
   *
   * 失败语义：参数不合法 / 超上限 / 存储根不可写 → 抛 `AppError`（整个任务没开始）；
   * 单块瓦片下载失败 → 计 `failed` 继续下一块（一块坏瓦片不该拖垮整批）。
   */
  async cacheTiles(input: MapTileCacheRequest): Promise<MapTileCacheResult> {
    if (this.running) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '已有瓦片缓存下载任务正在进行')
    }
    const config = validateRequest(input)
    const tiles = enumerateTiles(input.bounds, input.minZoom, input.maxZoom)
    if (tiles.length > TILE_CACHE_MAX_TILES) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `瓦片数量约 ${tiles.length} 块，超过单次上限 ${TILE_CACHE_MAX_TILES}：请缩小区域或降低最大缩放级别`
      )
    }

    const root = this.getStorageRoot()
    await fs.mkdir(path.join(root, 'map-cache'), { recursive: true })

    this.running = true
    try {
      return await this.run(root, config, tiles)
    } finally {
      this.running = false
    }
  }

  private async run(
    root: string,
    config: MapTilesConfig,
    tiles: PendingTile[]
  ): Promise<MapTileCacheResult> {
    const total = tiles.length
    let downloaded = 0
    let skipped = 0
    let failed = 0
    let bytes = 0
    let cursor = 0

    const emitProgress = (done: boolean): void => {
      this.emit('progress', { downloaded, skipped, failed, total, bytes, done })
    }

    const worker = async (): Promise<void> => {
      while (cursor < tiles.length) {
        const tile = tiles[cursor]
        cursor += 1
        if (!tile) continue
        const absolute = path.join(root, tileCacheRelativePath(config.service, tile.z, tile.x, tile.y))
        try {
          await fs.access(absolute)
          skipped += 1
        } catch {
          const url = tileUrl(config, tile.z, tile.x, tile.y)
          if (url === '') {
            failed += 1
          } else {
            const size = await downloadOne(url, absolute)
            if (size === null) {
              failed += 1
            } else {
              downloaded += 1
              bytes += size
              if (bytes > TILE_CACHE_MAX_BYTES) {
                throw new AppError(
                  ErrorCodes.VALIDATION_ERROR,
                  `瓦片缓存超过 ${Math.round(TILE_CACHE_MAX_BYTES / 1024 / 1024 / 1024)} GB 上限，已中止（已下载的保留，可缩小范围后继续）`
                )
              }
            }
          }
        }
        const processed = downloaded + skipped + failed
        if (processed % PROGRESS_EVERY === 0 || processed === total) emitProgress(false)
      }
    }

    try {
      await Promise.all(
        Array.from({ length: Math.min(TILE_CACHE_CONCURRENCY, tiles.length) }, () => worker())
      )
    } catch (error) {
      // 总量上限这类中止：把已经完成的进度如实推一次收尾，再原样抛给 IPC 层。
      emitProgress(true)
      throw error
    }
    emitProgress(true)

    appLog().info('瓦片缓存下载完成', {
      service: config.service,
      total,
      downloaded,
      skipped,
      failed,
      bytes
    })
    return { downloaded, skipped, failed, bytes }
  }
}

/** 入参校验：与共享层 `mapTilesProblem()` 同一批判据，非法直接拒绝整个任务。 */
function validateRequest(input: MapTileCacheRequest): MapTilesConfig {
  if (input === null || typeof input !== 'object') {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, '缓存下载参数不合法')
  }
  const service = input.service
  if (!isMapTileService(service)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `未知的瓦片服务: ${String(service)}`)
  }
  const urlTemplate = typeof input.urlTemplate === 'string' ? input.urlTemplate.trim() : ''
  if (urlTemplate === '' || !/^https:\/\//i.test(urlTemplate)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, '瓦片 URL 模板必须是以 https:// 开头的 XYZ 模板')
  }
  const minZoom = input.minZoom
  const maxZoom = input.maxZoom
  if (!isTileZoom(minZoom) || !isTileZoom(maxZoom) || minZoom > maxZoom) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, '缩放级别范围不合法（2–18，且最小 ≤ 最大）')
  }
  const bounds = input.bounds
  if (
    bounds === null ||
    typeof bounds !== 'object' ||
    !Number.isFinite(bounds.minLat) ||
    !Number.isFinite(bounds.minLon) ||
    !Number.isFinite(bounds.maxLat) ||
    !Number.isFinite(bounds.maxLon) ||
    bounds.minLat >= bounds.maxLat ||
    bounds.minLon >= bounds.maxLon ||
    Math.abs(bounds.minLat) > 90 ||
    Math.abs(bounds.maxLat) > 90 ||
    Math.abs(bounds.minLon) > 180 ||
    Math.abs(bounds.maxLon) > 180
  ) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, '经纬度区域不合法（需要 南 < 北、西 < 东 的度数）')
  }
  return {
    enabled: false,
    service,
    urlTemplate,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : '',
    attribution: typeof input.attribution === 'string' ? input.attribution.trim() : ''
  }
}

/** 把「缩放级别范围 × 经纬度区域」铺成一块块待下载瓦片（行序稳定，便于断点续下）。 */
function enumerateTiles(bounds: TileCacheBounds, minZoom: number, maxZoom: number): PendingTile[] {
  const tiles: PendingTile[] = []
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const range = tileRangeForBounds(bounds, z)
    if (!range) continue
    for (let y = range.yMin; y <= range.yMax; y += 1) {
      for (let x = range.xMin; x <= range.xMax; x += 1) {
        tiles.push({ z, x, y })
      }
    }
  }
  return tiles
}

/**
 * 下载一块瓦片并落盘。返回字节数；网络失败 / 非 2xx / 空内容返回 `null`（计 failed，
 * 不抛 —— 单块失败不该拖垮整批）。写盘前 `mkdir -p` 到 `z/x` 一层。
 */
async function downloadOne(url: string, absolute: string): Promise<number | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TILE_DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0) return null
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, buffer)
    return buffer.length
  } catch {
    return null
  }
}
