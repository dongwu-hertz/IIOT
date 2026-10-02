/**
 * Storage service — directory layout, disk protection and retention.
 *
 * Implements spec section 4.4 (recommended layout) and 14.4 (disk protection).
 *
 * Layout:
 *   <root>\audio\<DEVICE_UID>\<YYYY>\<MM>\<DD>\CH<nn>\alarm\
 *   <root>\audio\<DEVICE_UID>\<YYYY>\<MM>\<DD>\CH<nn>\manual\
 *   <root>\video\<DEVICE_UID>\<YYYY>\<MM>\<DD>\<stamp>.mp4        (相机手动录像)
 *   <root>\snapshot\<DEVICE_UID>\<YYYY>\<MM>\<DD>\<stamp>.jpg     (相机抓图)
 *   <root>\detect\<deviceId>\<logId>-<kind><ext>                 (检测库结果文件)
 *   <root>\metrics\<DEVICE_UID>\<YYYY>\<YYYY-MM-DD.parquet
 *   <root>\spectrum_cache\
 *   <root>\spectrogram_cache\
 *   <root>\export\
 *   <root>\logs\
 *
 * `relative_path` values stored in SQLite are always relative to `<root>`, so
 * moving the storage root to a larger disk is a settings change, not a
 * migration (spec 4.1 "音频不进入数据库").
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import type { DiskUsage } from '@shared/ipc/contract'
import type { RecordingType } from '@shared/domain/models'
import {
  isRetentionProtected,
  planCapacityRetention,
  type RetentionCandidate,
  type RetentionPlan
} from '@shared/domain/retention'
import {
  cameraMediaFileName,
  cameraMediaRelativeDirectory,
  cameraMediaStamp,
  type CameraMediaKind
} from '@shared/domain/camera-nvr'
import { AppError, ErrorCodes } from '@shared/errors'
import { now } from '@shared/utils/id'

export const STORAGE_SUBDIRS = [
  'audio',
  /**
   * 相机 NVR 媒体（本项目新增，见 `shared/domain/camera-nvr.ts`）。
   *
   * 与 `audio` 并列，而不是塞进音频目录里：一个是 RIFF/WAVE 证据音频，一个是
   * MP4/JPEG 的视频与画面，混在一起会让「按扩展名删/找」的运维动作出错。
   * 但两者共用同一个存储根、同一套 `<uid>/<YYYY>/<MM>/<DD>` 分层和同一套
   * 「相对路径入库、绝对路径写盘」的约定——这正是规格 4.4 要的性质。
   */
  'video',
  'snapshot',
  /**
   * 相机检测库的结果文件（事件与告警中心的手动下载，手册 §5.1.18）。
   *
   * 与 `video`/`snapshot` 并列而不是塞进它们：这些文件是**设备产出的原始
   * 证据**（声场图、声纹、麦克风 WAV/BIN），可能是图片、视频、CSV 或二进制，
   * 混进按容器分类的目录里会让「按扩展名找/清」的运维动作出错。
   * 布局固定为 `detect/<deviceId>/<logId>-<kind><ext>`。
   */
  'detect',
  'metrics',
  'spectrum_cache',
  'spectrogram_cache',
  'export',
  'logs'
] as const

export type StorageSubdir = (typeof STORAGE_SUBDIRS)[number]

/**
 * Continuous recording grows between restarts, so retention must run on a
 * cadence as well. Ten minutes is short enough that a full quota cannot grow
 * much past its limit, and long enough that a full-directory scan stays cheap.
 */
export const RETENTION_SWEEP_INTERVAL_MS = 10 * 60 * 1000

export interface StorageServiceOptions {
  db: SqliteDatabase
  /** Returns the CURRENT storage root; read per call so a settings change applies live. */
  getStorageRoot: () => string
  /** Returns the current free-space safety floor in bytes. */
  getMinFreeBytes: () => number
  /**
   * Current capacity quota in bytes; 0 means unlimited. Optional so existing
   * tests/callers that only used the other three getters keep compiling.
   */
  getStorageQuotaBytes?: () => number
  /** Current warning+ alarm reserve ratio. Defaults to 0.1 when not injected. */
  getRetentionAlarmReserveRatio?: () => number
}

export interface RetentionSweepOptions {
  /** Age window for non-protected alarm recordings; <= 0 disables the age pass. */
  retentionDays: number
  /** Capacity cap in bytes; 0 disables capacity deletion. */
  quotaBytes: number
  /** Overrides the ratio from getRetentionAlarmReserveRatio. */
  alarmReserveRatio?: number
}

export interface RetentionSweepResult {
  /** Files physically unlinked by all passes. */
  deletedFiles: number
  /** Bytes those files occupied. */
  freedBytes: number
  /** Metadata rows deleted (including rows whose file was already missing). */
  deletedRows: number
  cacheDeletedFiles: number
  cacheFreedBytes: number
  /** Files removed by the capacity plan (C zone + over-cap P zone). */
  capacityDeletedFiles: number
  /** Files removed by the age rule (non-protected alarm rows past retentionDays). */
  ageDeletedFiles: number
  /** Files that could not be removed (locked/permission); their rows were kept. */
  failedDeletions: number
  /** Bytes still over quota after this pass; 0 inside quota or when quota=0. */
  remainingOverBytes: number
}

interface StorageInventory {
  totalBytes: number
  /** Absolute path -> actual on-disk size. */
  files: Map<string, number>
}

interface RetentionRecordingRow extends RetentionCandidate {
  /** Root-relative DB path; '' for device-library mirrors not downloaded yet. */
  relativePath: string
}

export interface AlarmClipPaths {
  /** Absolute path to write the WAV/FLAC file to. */
  absolutePath: string
  /** Path to persist in SQLite, relative to the storage root. */
  relativePath: string
}

/**
 * 绝对路径 + 存储根相对路径。
 *
 * 与 `AlarmClipPaths` 同形，但名字不带音频语义：相机的手动录像（MP4）与抓图
 * （JPEG）也走同一套「绝对路径写盘、相对路径入库」的约定（规格 4.1/4.4）。
 */
export interface StorageFilePaths {
  absolutePath: string
  relativePath: string
}

export class StorageService {
  private readonly db: SqliteDatabase
  private readonly getStorageRoot: () => string
  private readonly getMinFreeBytes: () => number
  private readonly getStorageQuotaBytes: () => number
  private readonly getRetentionAlarmReserveRatio: () => number
  /** Coalesces overlapping timer/manual sweeps so two passes never race. */
  private sweepPromise: Promise<RetentionSweepResult> | null = null

  constructor(options: StorageServiceOptions) {
    this.db = options.db
    this.getStorageRoot = options.getStorageRoot
    this.getMinFreeBytes = options.getMinFreeBytes
    this.getStorageQuotaBytes = options.getStorageQuotaBytes ?? (() => 0)
    this.getRetentionAlarmReserveRatio =
      options.getRetentionAlarmReserveRatio ?? (() => 0.1)
  }

  get root(): string {
    return this.getStorageRoot()
  }

  /** Create the full directory skeleton. Idempotent; safe to call on every start. */
  async ensureLayout(root = this.root): Promise<void> {
    for (const subdir of STORAGE_SUBDIRS) {
      await fs.mkdir(path.join(root, subdir), { recursive: true })
    }
  }

  /** Verify the root is writable before the UI offers to record anything. */
  async assertWritable(root = this.root): Promise<void> {
    await this.ensureLayout(root)
    const probe = path.join(root, `.write-probe-${process.pid}`)
    try {
      await fs.writeFile(probe, 'ok', 'utf8')
      await fs.unlink(probe)
    } catch (error) {
      throw new AppError(
        ErrorCodes.STORAGE_ERROR,
        `存储目录不可写: ${root}`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  // -------------------------------------------------------------------------
  // Path builders
  // -------------------------------------------------------------------------

  /**
   * Directory for one device/channel/day of audio of a given kind.
   *   audio/<DEVICE_UID>/<YYYY>/<MM>/<DD>/CH<nn>/<kind>/
   */
  audioDir(
    deviceUid: string,
    channelIndex: number,
    kind: RecordingType,
    timestamp: number = now(),
    root = this.root
  ): string {
    const date = new Date(timestamp)
    const year = String(date.getFullYear())
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const channel = `CH${String(channelIndex + 1).padStart(2, '0')}`
    return path.join(root, 'audio', safeSegment(deviceUid), year, month, day, channel, kind)
  }

  /** metrics/<DEVICE_UID>/<YYYY>/<YYYY-MM-DD>.parquet */
  metricsFile(
    deviceUid: string,
    timestamp: number = now(),
    root = this.root
  ): string {
    const date = new Date(timestamp)
    const year = String(date.getFullYear())
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return path.join(root, 'metrics', safeSegment(deviceUid), year, `${year}-${month}-${day}.parquet`)
  }

  /**
   * Build the destination for an alarm/manual clip and return both the absolute
   * path and the root-relative path that belongs in SQLite.
   */
  buildClipPaths(input: {
    deviceUid: string
    channelIndex: number
    kind: RecordingType
    startTime: number
    extension: 'wav' | 'flac'
    suffix?: string
  }): AlarmClipPaths {
    const directory = this.audioDir(input.deviceUid, input.channelIndex, input.kind, input.startTime)
    const stamp = formatFileStamp(input.startTime)
    const suffix = input.suffix ? `_${safeSegment(input.suffix)}` : ''
    const filename = `${stamp}${suffix}.${input.extension}`
    const absolutePath = path.join(directory, filename)
    return {
      absolutePath,
      relativePath: path.relative(this.root, absolutePath).split(path.sep).join('/')
    }
  }

  /**
   * 相机 NVR 媒体的目标路径（`<kind>/<DEVICE_UID>/<YYYY>/<MM>/<DD>/<stamp>.<ext>`）。
   *
   * 命名与目录段由 `shared/domain/camera-nvr.ts` 的纯函数决定，主进程与测试
   * 断言的是同一份规则；`attempt` 由调用方在文件已存在时递增，因此**不覆盖**
   * 已有的录像/抓图，同时保持字典序 == 时间序。
   */
  cameraMediaPaths(input: {
    deviceUid: string
    kind: CameraMediaKind
    timestamp: number
    label?: string
    attempt?: number
  }): StorageFilePaths {
    const relativeDirectory = cameraMediaRelativeDirectory(
      input.kind,
      input.deviceUid,
      input.timestamp
    )
    const directory = path.join(this.root, ...relativeDirectory.split('/'))
    const absolutePath = path.join(directory, cameraMediaFileName(input))
    return {
      absolutePath,
      relativePath: path.relative(this.root, absolutePath).split(path.sep).join('/')
    }
  }

  /** Turn a stored relative path back into an absolute path for playback. */
  resolve(storedPath: string): string {
    const rootResolved = path.resolve(this.root)

    /**
     * Accept BOTH a stored relative path and an already-absolute one.
     *
     * The recordings table stores root-relative paths so the storage root can be
     * moved, but several callers legitimately hold an absolute path already —
     * `metricsFile` and `buildClipPaths` both return absolute paths, and passing
     * one back here used to be silently catastrophic: the leading separator was
     * stripped and the whole path was re-joined onto the root, producing
     * `<root>/var/folders/.../<root>/metrics/...` and a file written far from
     * where anything would look for it. Reproduced end-to-end while testing the
     * trend writer.
     *
     * Normalising both forms to "absolute path inside the root" removes the
     * hazard while keeping the traversal guard intact, which is the property that
     * actually matters here.
     *
     * NOTE: the old code also rewrote `\` sequences, which on POSIX would corrupt
     * a legitimate file name. That is gone: only a genuine separator at the START
     * of a relative path is meaningful.
     */
    const candidate = path.isAbsolute(storedPath)
      ? path.normalize(storedPath)
      : path.resolve(rootResolved, storedPath)
    const absolute = path.resolve(candidate)

    // Resolve symlinks-free prefix comparison: `..` segments are already
    // normalised away by `path.resolve`, so a prefix check is sufficient to keep
    // a tampered row from escaping the root.
    if (absolute !== rootResolved && !absolute.startsWith(rootResolved + path.sep)) {
      throw new AppError(ErrorCodes.STORAGE_ERROR, `路径越界，已拒绝访问: ${storedPath}`)
    }
    return absolute
  }

  /**
   * Write bytes to a path under the storage root, creating parents as needed.
   *
   * Writes to a temporary file and renames it into place. A rename is atomic on
   * both NTFS and POSIX filesystems, so an interrupted download can never leave
   * a half-written WAV that looks playable but contains garbage — which matters
   * because the recordings table will already reference the final path.
   */
  async writeFile(absolutePath: string, bytes: Uint8Array): Promise<void> {
    const root = path.resolve(this.root)
    const target = path.resolve(absolutePath)

    // Defence in depth: the caller supplies a path built by buildClipPaths, but
    // a future one might not, and escaping the storage root would be silent.
    if (!target.startsWith(root + path.sep)) {
      throw new AppError(ErrorCodes.STORAGE_ERROR, `写入路径越界，已拒绝: ${absolutePath}`)
    }

    await fs.mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.part`

    try {
      await fs.writeFile(temporary, bytes)
      await fs.rename(temporary, target)
    } catch (error) {
      // Clean up the partial file so a failed download leaves no debris.
      await fs.unlink(temporary).catch(() => undefined)
      throw new AppError(
        ErrorCodes.STORAGE_ERROR,
        `写入文件失败: ${absolutePath}`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  // -------------------------------------------------------------------------
  // Capacity + disk protection (spec 14.4)
  // -------------------------------------------------------------------------

  /**
   * Lightweight free-space read for recording guards.
   *
   * It deliberately keeps `usedByAppBytes` as the audio directory only, as it
   * always was: this method is called while saving a recording, and walking the
   * whole storage root there would put quota bookkeeping on the hot write path.
   * The settings endpoint uses `quotaUsage()` for the full picture.
   */
  async diskUsage(): Promise<DiskUsage> {
    const root = this.root
    await this.ensureLayout(root)
    const { totalBytes, freeBytes } = await this.fileSystemCapacity()
    const usedByAppBytes = await this.directorySize(path.join(root, 'audio'))
    const minFree = this.getMinFreeBytes()

    return {
      storageRoot: root,
      totalBytes,
      freeBytes,
      usedByAppBytes,
      quotaBytes: 0,
      overQuotaBytes: 0,
      remainingOverQuotaBytes: 0,
      reclaimableBytes: 0,
      belowSafetyFloor: freeBytes < minFree
    }
  }

  /**
   * Full quota picture for the settings screen: walks the storage root
   * (recordings, trends, logs, caches, exports) and runs the pure retention
   * plan WITHOUT deleting anything. `remainingOverQuotaBytes` is therefore the
   * honest aftermath of the next sweep, and `reclaimableBytes` is what that
   * sweep would remove from the C zone.
   */
  async quotaUsage(): Promise<DiskUsage> {
    const root = this.root
    await this.ensureLayout(root)
    const { totalBytes, freeBytes } = await this.fileSystemCapacity()
    const inventory = await this.collectInventory(root)
    const quotaBytes = this.currentQuotaBytes()
    const { plan } = this.buildCapacityPlan(inventory, quotaBytes)
    const minFree = this.getMinFreeBytes()

    return {
      storageRoot: root,
      totalBytes,
      freeBytes,
      usedByAppBytes: inventory.totalBytes,
      quotaBytes,
      overQuotaBytes: quotaBytes > 0 ? Math.max(0, inventory.totalBytes - quotaBytes) : 0,
      remainingOverQuotaBytes: plan.remainingOverBytes,
      reclaimableBytes: plan.freedBytes,
      belowSafetyFloor: freeBytes < minFree
    }
  }

  private async fileSystemCapacity(): Promise<{ totalBytes: number; freeBytes: number }> {
    try {
      const stats = await fs.statfs(this.root)
      return {
        totalBytes: stats.blocks * stats.bsize,
        freeBytes: stats.bavail * stats.bsize
      }
    } catch {
      // statfs is unavailable on some Windows/network paths; degrade to "unknown"
      // rather than blocking recording outright.
      return { totalBytes: 0, freeBytes: Number.MAX_SAFE_INTEGER }
    }
  }

  /**
   * Spec 14.4: below the safety floor, stop NON-ESSENTIAL recording.
   * Manual recordings are explicitly never auto-deleted, so the caller decides
   * what "non-essential" means; this guard answers the question only.
   */
  async canRecord(recordingType: RecordingType): Promise<boolean> {
    if (recordingType === 'manual') return true
    const usage = await this.diskUsage()
    return !usage.belowSafetyFloor
  }

  /**
   * Retention sweep (owner decision 2026-09-30, spec 14.4 + docs/STORAGE-DESIGN §9.8).
   *
   * Order:
   *   1. rebuildable caches, but ONLY when the quota is already exceeded;
   *   2. capacity plan: C-zone oldest-first until inside quota; P-zone capped at
   *      `quota * reserveRatio`; M-zone never enters the deletion queue;
   *   3. age pass for non-protected alarm recordings older than `retentionDays`
   *      (the P zone is exempt, which is what "permanent" means);
   *   4. truthful `remainingOverBytes` when only P/M/non-recording data is left.
   *
   * The old `enforceRetention(retentionDays)` signature is kept: it reads quota
   * and ratio from the injected getters.
   */
  async enforceRetention(options: RetentionSweepOptions): Promise<RetentionSweepResult>
  async enforceRetention(retentionDays: number): Promise<RetentionSweepResult>
  async enforceRetention(
    options: RetentionSweepOptions | number
  ): Promise<RetentionSweepResult> {
    if (this.sweepPromise) return this.sweepPromise

    const input: RetentionSweepOptions =
      typeof options === 'number'
        ? {
            retentionDays: options,
            quotaBytes: this.currentQuotaBytes(),
            alarmReserveRatio: this.getRetentionAlarmReserveRatio()
          }
        : { ...options, quotaBytes: normaliseQuota(options.quotaBytes) }

    const run = this.runRetentionSweep(input).finally(() => {
      this.sweepPromise = null
    })
    this.sweepPromise = run
    return run
  }

  private async runRetentionSweep(
    options: RetentionSweepOptions
  ): Promise<RetentionSweepResult> {
    const root = this.root
    await this.ensureLayout(root)

    const inventory = await this.collectInventory(root)
    const quotaBytes = normaliseQuota(options.quotaBytes)
    const alarmReserveRatio =
      options.alarmReserveRatio ?? this.getRetentionAlarmReserveRatio()
    let projectedTotalBytes = inventory.totalBytes

    let cacheDeletedFiles = 0
    let cacheFreedBytes = 0
    if (quotaBytes > 0 && projectedTotalBytes > quotaBytes) {
      for (const subdir of ['spectrum_cache', 'spectrogram_cache'] as const) {
        const result = await this.pruneDirectory(path.join(root, subdir), 0)
        cacheDeletedFiles += result.files
        cacheFreedBytes += result.bytes
      }
      projectedTotalBytes = Math.max(0, projectedTotalBytes - cacheFreedBytes)
    }

    const { rows, plan } = this.buildCapacityPlan(
      inventory,
      quotaBytes,
      projectedTotalBytes,
      alarmReserveRatio
    )
    const rowsById = new Map(rows.map((row) => [row.id, row]))
    const attempted = new Set<string>()

    let capacityDeletedFiles = 0
    let ageDeletedFiles = 0
    let deletedRows = 0
    let freedBytes = 0
    let failedDeletions = 0

    for (const id of plan.deleteIds) {
      const row = rowsById.get(id)
      if (!row) continue
      attempted.add(id)
      const result = await this.deleteRecordingRow(row)
      if (result.failed) {
        failedDeletions += 1
        continue
      }
      if (result.deletedFile) capacityDeletedFiles += 1
      if (result.rowDeleted) deletedRows += 1
      freedBytes += result.bytes
      projectedTotalBytes = Math.max(0, projectedTotalBytes - result.bytes)
    }

    if (options.retentionDays > 0) {
      const cutoff = now() - options.retentionDays * 24 * 60 * 60 * 1000
      const expired = rows
        .filter(
          (row) =>
            row.kind === 'alarm' &&
            !isRetentionProtected(row) &&
            row.startMs < cutoff &&
            !attempted.has(row.id)
        )
        .sort((left, right) => left.startMs - right.startMs)

      for (const row of expired) {
        attempted.add(row.id)
        const result = await this.deleteRecordingRow(row)
        if (result.failed) {
          failedDeletions += 1
          continue
        }
        if (result.deletedFile) ageDeletedFiles += 1
        if (result.rowDeleted) deletedRows += 1
        freedBytes += result.bytes
        projectedTotalBytes = Math.max(0, projectedTotalBytes - result.bytes)
      }
    }

    return {
      deletedFiles: cacheDeletedFiles + capacityDeletedFiles + ageDeletedFiles,
      freedBytes: cacheFreedBytes + freedBytes,
      deletedRows,
      cacheDeletedFiles,
      cacheFreedBytes,
      capacityDeletedFiles,
      ageDeletedFiles,
      failedDeletions,
      remainingOverBytes: quotaBytes > 0 ? Math.max(0, projectedTotalBytes - quotaBytes) : 0
    }
  }

  /**
   * Delete a recording's file first, then its metadata row.
   *
   * Missing file = stale row, still safe to delete. Existing file that cannot
   * be unlinked (locked/permission) keeps its row: deleting the row would turn
   * a retryable failure into an orphaned file this service can never find again.
   */
  private async deleteRecordingRow(
    row: RetentionRecordingRow
  ): Promise<{ deletedFile: boolean; bytes: number; rowDeleted: boolean; failed: boolean }> {
    let deletedFile = false
    let fileBytes = 0

    if (row.relativePath !== '') {
      let absolute: string
      try {
        absolute = this.resolve(row.relativePath)
      } catch {
        return { deletedFile: false, bytes: 0, rowDeleted: false, failed: true }
      }

      const stat = await fs.stat(absolute).catch(() => null)
      if (stat?.isFile()) {
        try {
          await fs.unlink(absolute)
          deletedFile = true
          fileBytes = stat.size
        } catch {
          return { deletedFile: false, bytes: 0, rowDeleted: false, failed: true }
        }
      }
    }

    try {
      this.db.prepare(`DELETE FROM recordings WHERE id = ?`).run(row.id)
      return { deletedFile, bytes: fileBytes, rowDeleted: true, failed: false }
    } catch {
      return { deletedFile, bytes: fileBytes, rowDeleted: false, failed: true }
    }
  }

  private buildCapacityPlan(
    inventory: StorageInventory,
    quotaBytes: number = this.currentQuotaBytes(),
    totalBytes: number = inventory.totalBytes,
    alarmReserveRatio: number = this.getRetentionAlarmReserveRatio()
  ): { rows: RetentionRecordingRow[]; plan: RetentionPlan } {
    const rows = this.retentionRows(inventory)
    const plan = planCapacityRetention({
      candidates: rows,
      quotaBytes,
      alarmReserveRatio,
      totalBytes
    })
    return { rows, plan }
  }

  /**
   * JOIN recordings to alarm severity. A recording is protected when ANY alarm
   * pointing at it is warning/critical, which is the P-zone entry criterion.
   */
  private retentionRows(inventory: StorageInventory): RetentionRecordingRow[] {
    const rows = this.db
      .prepare<
        [],
        {
          id: string
          recording_type: string
          start_time: number
          relative_path: string
          protected_severity: string | null
        }
      >(
        `SELECT r.id,
                r.recording_type,
                r.start_time,
                r.relative_path,
                CASE WHEN EXISTS (
                  SELECT 1 FROM alarms a
                   WHERE a.recording_id = r.id
                     AND a.severity IN ('warning', 'critical')
                ) THEN 'warning' ELSE NULL END AS protected_severity
           FROM recordings r
          WHERE r.recording_type IN ('alarm', 'manual', 'scheduled')`
      )
      .all()

    const result: RetentionRecordingRow[] = []
    for (const row of rows) {
      const kind = row.recording_type
      if (kind !== 'alarm' && kind !== 'manual' && kind !== 'scheduled') continue
      const candidate: RetentionRecordingRow = {
        id: row.id,
        kind,
        startMs: row.start_time,
        relativePath: row.relative_path,
        bytes: this.storedFileSize(row.relative_path, inventory.files)
      }
      if (row.protected_severity !== null) candidate.severity = row.protected_severity
      result.push(candidate)
    }
    return result
  }

  /** Actual bytes on disk for a stored relative path; 0 when the file is gone. */
  private storedFileSize(relativePath: string, files: Map<string, number>): number {
    if (relativePath === '') return 0
    try {
      return files.get(this.resolve(relativePath)) ?? 0
    } catch {
      return 0
    }
  }

  private currentQuotaBytes(): number {
    return normaliseQuota(this.getStorageQuotaBytes())
  }

  /** Legacy audio-only size scan used by the hot recording guard. */
  private async directorySize(directory: string): Promise<number> {
    let total = 0
    const walk = async (current: string): Promise<void> => {
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const child = path.join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(child)
        } else {
          const stat = await fs.stat(child).catch(() => null)
          if (stat && !stat.isDirectory()) total += stat.size
        }
      }
    }
    await walk(directory)
    return total
  }

  /** One directory walk, reused by both quota accounting and the sweep. */
  private async collectInventory(root = this.root): Promise<StorageInventory> {
    const files = new Map<string, number>()
    let totalBytes = 0

    const walk = async (current: string): Promise<void> => {
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const child = path.join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(child)
          continue
        }
        const stat = await fs.stat(child).catch(() => null)
        if (!stat || stat.isDirectory()) continue
        const absolute = path.resolve(child)
        files.set(absolute, stat.size)
        totalBytes += stat.size
      }
    }

    await walk(root)
    return { totalBytes, files }
  }

  private async pruneDirectory(
    directory: string,
    olderThanMs: number
  ): Promise<{ files: number; bytes: number }> {
    let files = 0
    let bytes = 0
    const cutoff = olderThanMs > 0 ? now() - olderThanMs : Number.POSITIVE_INFINITY

    const walk = async (current: string): Promise<void> => {
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const child = path.join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(child)
        } else {
          const stat = await fs.stat(child).catch(() => null)
          if (!stat || stat.mtimeMs > cutoff) continue
          try {
            await fs.unlink(child)
            files += 1
            bytes += stat.size
          } catch {
            // Locked cache file: skip it, the next sweep will retry.
          }
        }
      }
    }

    await walk(directory)
    return { files, bytes }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 0 means unlimited; an invalid quota must never authorise deletion. */
function normaliseQuota(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Strip characters that are illegal in Windows paths or enable traversal. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown'
}

/** `2026-02-26_14-05-33-123` — filesystem-safe and lexicographically sortable. */
function formatFileStamp(timestamp: number): string {
  // 与相机媒体（`cameraMediaStamp`）共用同一个实现：两个格式一旦分叉，
  // 「按文件名排序即按时间排序」这条性质就只在一边成立。
  return cameraMediaStamp(timestamp)
}
