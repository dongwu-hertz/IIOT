/**
 * `DetectLibraryService` —— 相机**检测库**的封装（手册 §5.1.17 / §5.1.18）。
 *
 * 它只做两件事：
 *   1. `list()`    读一批检测日志（`GET /detect_logs`），映射成领域视图；
 *   2. `download()` 把某一条日志的某一个结果文件（`GET /detect_file/...`）
 *      下载到本机、登记成录像行，使它可被播放/再次访问。
 *
 * ---------------------------------------------------------------------------
 * 这个类为什么存在（而不是让事件中心服务自己做）
 * ---------------------------------------------------------------------------
 * 「设备上有哪些检测」与「发生过哪些事件」是两个问题：前者是设备的库，
 * 后者是本软件的归一化视图。把它们分开，`EventCenterService` 才能在检测库
 * 读失败时如实降级，而 `DetectLibraryService` 也能被单独测试（注入假的客户端、
 * 假的文件系统、真实的内存 SQLite）。
 *
 * ---------------------------------------------------------------------------
 * 三条「不猜」的规则，写在代码里而不是注释里
 * ---------------------------------------------------------------------------
 * 1. **时间戳单位是假设，不是事实**。`DETECT_LIBRARY_TIME_UNIT` 固定为
 *    `'epoch_seconds'`：手册 §8.2 B5 从未声明单位（`sys_time` 示例只有 8 位），
 *    而真机实测的证据支持秒级。因此换算出的时刻一律标 `atApproximate = true`，
 *    从未换算出的日志用**读取时刻**并同样标记——绝不假装那是设备时间。
 * 2. **不做服务端分页**。手册没有为 `/detect_logs` 定义任何分页参数（§8.3 C14），
 *    所以 `list()` 只读一次、把设备自己的 `logs_count` 原样带出，并在结果里
 *    写死 `paging: 'none'`。
 * 3. **容器只由扩展名推导**。认不出来就是 `'unknown'`（`deriveRecordingContainer`），
 *    音频编码只在容器确实是 `wav` 时才是 `'wav'`，否则是 `null`——`null` 是
 *    「已知的没有」，不是「不知道」。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { AppError, ErrorCodes } from '@shared/errors'
import { deviceLog } from '../../logging/logger'
import type {
  EventDetectDownloadInput,
  EventDetectDownloadResult,
  EventDetectFile,
  EventDetectLibraryPage,
  EventDetectLogView,
  EventDownloadProgress,
  EventMetrics as EventDetectMetrics
} from '@shared/domain/event-center'
import {
  deriveRecordingContainer,
  detectRemoteRecordingId
} from '@shared/domain/event-center'
import type { Fa371DetectLog, Fa371ResultFileKind, Fa371TimestampUnit } from '@shared/domain/fa371'
import { FA371_RESULT_FILE_KINDS } from '@shared/domain/fa371'
import type { Fa371DownloadedFile, Fa371DetectLogsEnvelopeDto } from './dto'
import { detectLogFiles, detectLogsCount, mapDetectLogs } from './mappers'
import type { StorageService } from '../../storage/storage-service'
import type { RecordingRepository } from '../../database/alarm-repository'

/**
 * 日志时间戳的单位假设（§8.2 B5 + 实测）。
 *
 * 真机（192.168.110.235）的检测日志至今为空，但同族的 `start_time` 长度与
 * `detect-logs-poll-source` 的既有行为都按秒解读；把它固定成一处常量，是为了让
 * 「哪个假设被用上了」可被检索、可被替换，而不是散落在几处乘法里。
 */
export const DETECT_LIBRARY_TIME_UNIT = 'epoch_seconds' as const

/** `detect_id` 的文档默认值（§5.1.17：non-essential，默认 1）。 */
export const DEFAULT_DETECT_ID = 1

/** 检测结果的存储子目录（见 `StorageService` 的布局说明）。 */
export const DETECT_STORAGE_SUBDIR = 'detect'

/** 登记检测结果录像行时写进 `event_type` 的事件语义前缀。 */
export const DETECT_FILE_EVENT_TYPE = 'detect_file'

/** 本服务需要的相机客户端能力（`Fa371ApiClient` 结构上满足它）。 */
export interface DetectLibraryClient {
  getDetectLogs(detectId: number): Promise<Fa371DetectLogsEnvelopeDto>
  downloadDetectFile(savingPath: string, fileName: string): Promise<Fa371DownloadedFile>
}

/**
 * 文件系统操作。
 *
 * 注入而不是直接 `fs`：单元测试要能在**没有真实磁盘**的情况下断言
 * 「0 字节 / 被截断的文件绝不登记」，也要能断言「删掉的是哪一个路径」。
 */
export interface DetectLibraryFs {
  exists(absolutePath: string): Promise<boolean>
  /** 文件字节数；读不到（不存在）时返回 `undefined`。 */
  size(absolutePath: string): Promise<number | undefined>
  remove(absolutePath: string): Promise<void>
}

const DEFAULT_FS: DetectLibraryFs = {
  async exists(absolutePath) {
    try {
      await fs.access(absolutePath)
      return true
    } catch {
      return false
    }
  },
  async size(absolutePath) {
    try {
      const stat = await fs.stat(absolutePath)
      return stat.size
    } catch {
      return undefined
    }
  },
  async remove(absolutePath) {
    await fs.unlink(absolutePath).catch(() => undefined)
  }
}

export interface DetectLibraryServiceOptions {
  /** 取相机客户端（由 `DeviceService` 提供，复用同一个会话与认证结论）。 */
  clientFor: (deviceId: string) => DetectLibraryClient
  storage: StorageService
  recordings: RecordingRepository
  /**
   * 时间戳单位假设，默认为 `DETECT_LIBRARY_TIME_UNIT`（实测依据：秒级）。
   *
   * 之所以可注入：真机上还没有一条检测日志（`{"detect_logs":[],"logs_count":0}`），
   * 所以这个假设一旦被实测推翻，只需要在组合根换一个取值，不必改本文件。
   */
  timeUnit?: Fa371TimestampUnit
  fs?: DetectLibraryFs
  now?: () => number
}

export class DetectLibraryService {
  private readonly options: DetectLibraryServiceOptions
  private readonly fs: DetectLibraryFs
  private readonly now: () => number
  private readonly timeUnit: Fa371TimestampUnit

  constructor(options: DetectLibraryServiceOptions) {
    this.options = options
    this.fs = options.fs ?? DEFAULT_FS
    this.now = options.now ?? (() => Date.now())
    this.timeUnit = options.timeUnit ?? DETECT_LIBRARY_TIME_UNIT
  }

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  /**
   * 读检测日志。
   *
   * **没有服务端分页**：`detectId` 是手册里唯一的（non-essential）查询参数，
   * 真机返回的是整批数组。所以这里只读一次，并把设备自己的计数原样带出。
   */
  async list(deviceId: string, options: { detectId?: number } = {}): Promise<EventDetectLibraryPage> {
    const detectId = normaliseDetectId(options.detectId)
    const client = this.options.clientFor(deviceId)

    const raw = await client.getDetectLogs(detectId)
    const logs = mapDetectLogs(raw, { timeUnit: this.timeUnit })
    const logsCount = detectLogsCount(raw)

    const items = logs.map((log) => this.toView(deviceId, log))

    deviceLog().info('FA371 检测库已读取', {
      deviceId,
      detectId,
      logs: items.length,
      logsCount: logsCount ?? null,
      paging: 'none'
    })

    const page: EventDetectLibraryPage = { deviceId, items, paging: 'none' }
    if (logsCount !== undefined) page.logsCount = logsCount
    return page
  }

  /** 一条映射后的日志 -> 只读视图（把「谁下载过」留给调用方按需补充）。 */
  private toView(deviceId: string, log: Fa371DetectLog): EventDetectLogView {
    const view: EventDetectLogView = {
      deviceId,
      atApproximate: true,
      timeUnit: this.timeUnit,
      files: detectLogFiles(log).map((file) => ({
        kind: file.kind,
        fileName: file.fileName,
        container: deriveRecordingContainer(file.fileName)
      }))
    }
    if (log.id !== undefined) view.logId = log.id
    if (log.startTimeRaw !== undefined) view.startTimeRaw = log.startTimeRaw
    if (log.startTime !== undefined) view.startTimeMs = log.startTime
    if (log.savingPath !== undefined) view.savingPath = log.savingPath
    if (log.detectMode !== undefined) view.detectMode = log.detectMode
    if (log.status !== undefined) view.status = log.status
    if (log.isAlarm !== undefined) view.isAlarm = log.isAlarm
    if (log.alarmLevelRaw !== undefined) view.alarmLevelRaw = log.alarmLevelRaw

    // 指标逐项拷贝：缺字段就是缺字段，绝不填 0（0 会被渲染成一个真实读数）。
    const metrics: EventDetectMetrics = {}
    if (log.soundmapIntensity !== undefined) metrics.soundmapIntensity = log.soundmapIntensity
    if (log.leakVolume !== undefined) metrics.leakVolume = log.leakVolume
    if (log.leakCost !== undefined) metrics.leakCost = log.leakCost
    if (Object.keys(metrics).length > 0) view.metrics = metrics

    return view
  }

  // -------------------------------------------------------------------------
  // 下载
  // -------------------------------------------------------------------------

  /**
   * 下载一个检测结果文件并登记成录像行。
   *
   * 幂等：`remote_recording_id` 是 `detect:<logId>:<kind>`，所以同一条日志的同一个
   * 文件第二次下载**不会**覆盖已存在的文件：行已经存在且文件还在盘上时直接复用。
   * 行存在但文件不在（例如被人工删掉）时才重新下载。
   *
   * 失败绝不留下半截文件：字节先缓冲完、校验非空，写盘后再 `stat` 一次确认大小，
   * 不一致就删掉并且**不登记**——宁可少一条记录，也不要让操作员点开一个打不开的文件。
   */
  async download(
    deviceId: string,
    input: EventDetectDownloadInput,
    onProgress?: (progress: EventDownloadProgress) => void
  ): Promise<EventDetectDownloadResult> {
    const logId = Math.trunc(input.logId)
    const kind = input.kind
    if (!Number.isFinite(logId)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '检测日志编号必须是整数', String(input.logId))
    }
    if (!(FA371_RESULT_FILE_KINDS as readonly string[]).includes(kind)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '未知的检测结果文件种类', String(kind))
    }

    const report = (progress: Omit<EventDownloadProgress, 'deviceId' | 'logId' | 'kind'>): void => {
      onProgress?.({ deviceId, logId, kind, ...progress })
    }

    report({ stage: 'starting' })
    deviceLog().info('检测结果文件下载开始', { deviceId, logId, kind })

    // 重新读一次日志列表：`saving_path` 与文件名是设备侧的事实，不能靠界面传过来
    // （否则渲染层就成了「文件从哪来」的权威，一个改过的 id 就能让它去取任意文件）。
    const page = await this.list(deviceId, {})
    const log = pickLog(page.items, logId, input.startTimeRaw)
    if (!log) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        '设备当前的检测日志里找不到这条记录（可能已被设备回收，设备只保留最近若干条）',
        `logId=${logId}`
      )
    }

    const file = log.files.find((entry) => entry.kind === kind)
    if (!file) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        '这条检测日志没有该种类的结果文件',
        `logId=${logId} kind=${kind}`
      )
    }

    const savingPath = log.savingPath
    if (savingPath === undefined || savingPath.trim() === '') {
      throw new AppError(
        ErrorCodes.DEVICE_ERROR,
        '设备没有给出这条检测日志的目录（saving_path），无法拼出下载地址',
        `logId=${logId}`
      )
    }

    const relativePath = detectFileRelativePath(deviceId, logId, kind, file.fileName)
    const absolutePath = this.options.storage.resolve(relativePath)
    const container = deriveRecordingContainer(file.fileName)

    /**
     * 先登记元数据（幂等），再决定是否需要真正下载。
     *
     * `recordingType: 'manual'`：这是操作员**显式请求**的下载，14.4 的保留策略
     * 只自动删除 `'alarm'` 行，把它记成 `'alarm'` 会在用户没要求的情况下被清掉。
     * `sampleRate: 0`：相机从不告诉我们结果文件的采样率，写 0 而不是编一个 48000。
     */
    const upsert = this.options.recordings.upsertRemote({
      deviceId,
      channelId: 0,
      recordingType: 'manual',
      startTime: log.startTimeMs ?? this.now(),
      sampleRate: 0,
      audioFormat: container === 'wav' ? 'wav' : null,
      containerFormat: container,
      // 元数据先行：文件存在与否由 relative_path 表达（与设备录像同步同一约定）。
      relativePath: '',
      remoteRecordingId: detectRemoteRecordingId(logId, kind),
      eventType: `${DETECT_FILE_EVENT_TYPE}_${kind}`
    })

    const existing = this.options.recordings.findById(upsert.id)
    if (
      existing &&
      existing.relativePath.trim() !== '' &&
      (await this.fs.exists(this.options.storage.resolve(existing.relativePath)))
    ) {
      report({
        stage: 'reused',
        fileName: file.fileName,
        bytes: existing.fileSize ?? 0
      })
      deviceLog().info('检测结果文件已存在，直接复用', {
        deviceId,
        logId,
        kind,
        recordingId: existing.id,
        relativePath: existing.relativePath
      })
      return {
        deviceId,
        logId,
        kind,
        recordingId: existing.id,
        relativePath: existing.relativePath,
        fileName: file.fileName,
        container: existing.containerFormat ?? container,
        // 检测结果文件里的音频只可能是 WAV；存量行若写着别的编码，
        // 如实降级成 null 而不是把它当成可播放的音频。
        audioFormat: existing.audioFormat === 'wav' ? 'wav' : null,
        bytes: existing.fileSize ?? 0,
        reused: true
      }
    }

    report({ stage: 'fetching', fileName: file.fileName })
    const downloaded = await this.options.clientFor(deviceId).downloadDetectFile(savingPath, file.fileName)
    const bytes = downloaded.bytes
    report({ stage: 'verifying', fileName: file.fileName, bytes: bytes.length })

    if (bytes.length === 0) {
      // 0 字节的「成功」在别处也见过（设备对不存在的路径回 200 + 网页），
      // 因此这里显式拒绝：不写盘、不登记、留下可查的日志。
      deviceLog().warn('检测结果文件下载得到 0 字节，已丢弃', {
        deviceId,
        logId,
        kind,
        fileName: file.fileName,
        contentType: downloaded.contentType
      })
      throw new AppError(
        ErrorCodes.STORAGE_ERROR,
        '设备返回了 0 字节的检测结果文件，已丢弃且未登记',
        `${file.fileName} (${downloaded.contentType})`
      )
    }

    await this.options.storage.writeFile(absolutePath, bytes)

    // 写盘之后再核对一次：`writeFile` 已经用临时文件 + 原子改名规避了半截文件，
    // 但「落到盘上的字节数」是唯一能证明文件可用的证据。
    const size = await this.fs.size(absolutePath)
    if (size === undefined || size === 0 || size !== bytes.length) {
      await this.fs.remove(absolutePath)
      deviceLog().warn('检测结果文件写入不完整，已删除且未登记', {
        deviceId,
        logId,
        kind,
        expectedBytes: bytes.length,
        actualBytes: size ?? null,
        relativePath
      })
      throw new AppError(
        ErrorCodes.STORAGE_ERROR,
        `检测结果文件写入不完整（期望 ${bytes.length} 字节，实际 ${size ?? 0} 字节），已删除且未登记`,
        relativePath
      )
    }

    report({ stage: 'registering', fileName: file.fileName, bytes: size })
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    this.options.recordings.attachFile(upsert.id, {
      relativePath,
      fileSize: size,
      sha256
    })

    report({ stage: 'done', fileName: file.fileName, bytes: size })
    deviceLog().info('检测结果文件已下载并登记', {
      deviceId,
      logId,
      kind,
      recordingId: upsert.id,
      relativePath,
      bytes: size,
      container,
      audioFormat: container === 'wav' ? 'wav' : null
    })

    return {
      deviceId,
      logId,
      kind,
      recordingId: upsert.id,
      relativePath,
      fileName: file.fileName,
      container,
      audioFormat: container === 'wav' ? 'wav' : null,
      bytes: size,
      reused: false
    }
  }
}

// ---------------------------------------------------------------------------
// 纯函数（测试直接断言）
// ---------------------------------------------------------------------------

/** 规整 `detect_id`：非整数一律回落到文档默认值 1（手册说它是 non-essential）。 */
export function normaliseDetectId(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || !Number.isInteger(value)) {
    return DEFAULT_DETECT_ID
  }
  return value
}

/**
 * 检测结果文件的存储根相对路径：`detect/<deviceId>/<logId>-<kind><ext>`。
 *
 * 扩展名取自**设备给的文件名**（`detectFileExtension`），因为容器就是由它推导的；
 * 认不出扩展名时路径里就没有后缀，容器落 `'unknown'`。
 */
export function detectFileRelativePath(
  deviceId: string,
  logId: number,
  kind: Fa371ResultFileKind,
  fileName: string
): string {
  return [DETECT_STORAGE_SUBDIR, safeSegment(deviceId), `${Math.trunc(logId)}-${kind}${detectFileExtension(fileName)}`].join(
    '/'
  )
}

/** 文件名里的小写扩展名（含点）；没有扩展名时是空串。 */
export function detectFileExtension(fileName: string): string {
  const match = /(\.[A-Za-z0-9]+)\s*$/.exec(fileName.trim())
  return match ? match[1]!.toLowerCase() : ''
}

/**
 * 在日志列表里认领正确的那一条。
 *
 * `startTimeRaw` 给定时优先匹配「同编号 + 同开始时刻」——设备只保留最近若干条
 * 并在超限时**回收编号**（§8.5 E11），所以同编号不同时刻是两条不同的检测。
 * 找不到完全匹配时退回同编号的第一条，并在日志里说明用了哪一条。
 */
export function pickLog(
  logs: readonly EventDetectLogView[],
  logId: number,
  startTimeRaw?: number
): EventDetectLogView | undefined {
  const sameId = logs.filter((log) => log.logId === logId)
  if (sameId.length === 0) return undefined
  if (startTimeRaw !== undefined) {
    const exact = sameId.find((log) => log.startTimeRaw === startTimeRaw)
    if (exact) return exact
    deviceLog().warn('检测日志编号相同但开始时刻不同，退回同编号的第一条', {
      logId,
      requestedStartTime: startTimeRaw,
      candidates: sameId.map((log) => log.startTimeRaw ?? null)
    })
  }
  return sameId[0]
}

/** 路径段清洗：与 `StorageService` 的规则一致（Windows 非法字符 + 越界）。 */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown'
}

/** 供事件中心复用的文件视图类型（避免两处各写一遍）。 */
export type { EventDetectFile }
