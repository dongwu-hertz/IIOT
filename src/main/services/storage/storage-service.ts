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

export interface StorageServiceOptions {
  db: SqliteDatabase
  /** Returns the CURRENT storage root; read per call so a settings change applies live. */
  getStorageRoot: () => string
  /** Returns the current free-space safety floor in bytes. */
  getMinFreeBytes: () => number
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

  constructor(options: StorageServiceOptions) {
    this.db = options.db
    this.getStorageRoot = options.getStorageRoot
    this.getMinFreeBytes = options.getMinFreeBytes
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

  async diskUsage(): Promise<DiskUsage> {
    const root = this.root
    await this.ensureLayout(root)

    let totalBytes = 0
    let freeBytes = 0
    try {
      const stats = await fs.statfs(root)
      totalBytes = stats.blocks * stats.bsize
      freeBytes = stats.bavail * stats.bsize
    } catch {
      // statfs is unavailable on some Windows/network paths; degrade to "unknown"
      // rather than blocking recording outright.
      totalBytes = 0
      freeBytes = Number.MAX_SAFE_INTEGER
    }

    const usedByAppBytes = await this.directorySize(path.join(root, 'audio'))
    const minFree = this.getMinFreeBytes()

    return {
      storageRoot: root,
      totalBytes,
      freeBytes,
      usedByAppBytes,
      belowSafetyFloor: freeBytes < minFree
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
   * Retention sweep. Deletion order mandated by spec 14.4:
   *   1. rebuildable caches (spectrum / spectrogram)
   *   2. historical ALARM recordings past `retentionDays`
   *   3. manual recordings: never auto-deleted
   */
  async enforceRetention(retentionDays: number): Promise<{ deletedFiles: number; freedBytes: number }> {
    const root = this.root
    let deletedFiles = 0
    let freedBytes = 0

    // 1. Caches are always safe to drop when space is tight.
    for (const subdir of ['spectrum_cache', 'spectrogram_cache'] as const) {
      const result = await this.pruneDirectory(path.join(root, subdir), 0)
      deletedFiles += result.files
      freedBytes += result.bytes
    }

    // 2. Alarm recordings older than the retention window.
    if (retentionDays > 0) {
      const cutoff = now() - retentionDays * 24 * 60 * 60 * 1000
      const expired = this.db
        .prepare<[number], { id: string; relative_path: string; file_size: number | null }>(
          `SELECT id, relative_path, file_size
             FROM recordings
            WHERE recording_type = 'alarm' AND start_time < ?`
        )
        .all(cutoff)

      for (const row of expired) {
        try {
          const absolute = this.resolve(row.relative_path)
          const stat = await fs.stat(absolute).catch(() => null)
          if (stat) {
            await fs.unlink(absolute)
            deletedFiles += 1
            freedBytes += stat.size
          }
          this.db.prepare(`DELETE FROM recordings WHERE id = ?`).run(row.id)
        } catch {
          // A missing file still means the row should go; keep sweeping.
          this.db.prepare(`DELETE FROM recordings WHERE id = ?`).run(row.id)
        }
      }
    }

    return { deletedFiles, freedBytes }
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
          await fs.unlink(child).catch(() => undefined)
          files += 1
          bytes += stat.size
        }
      }
    }

    await walk(directory)
    return { files, bytes }
  }

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
          if (stat) total += stat.size
        }
      }
    }
    await walk(directory)
    return total
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
