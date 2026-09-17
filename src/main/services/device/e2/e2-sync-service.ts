/**
 * 听诊盒子族「拉」通道的**同步**：把设备上的告警日志与告警录音搬到本机。
 *
 * 业主 2026-09-16：「先做"拉"（登录取 token → `/workmode` → 按模式读参数 → 查告警日志 →
 * 下载告警文件）」。客户端在 `e2-client.ts`，这里负责把拉回来的东西**落到本机库**：
 *
 * ```
 * /alarm_log_all  ──► alarms 一行（source='e2'）
 *                        └─ files_status=1 且要求下载 ──► /alarm_files ──► storage + recordings 一行
 * ```
 *
 * ---------------------------------------------------------------------------
 * 四条必须守住的规矩
 * ---------------------------------------------------------------------------
 * 1. **`alarm_value` 不写进 `alarm_mask`**。那是两套词汇：FA8 的位图我们能解、能分级；
 *    听诊盒子族的手册只列了 6 个十六进制值。写进去 `decodeAlarmMask()` 会解出设备从未报过的
 *    故障类型。所以 `alarmMask: 0`，原始值进 `deviceAlarmValue`，等级显式写 `'unknown'`
 *    （不传的话 `deriveAlarmSeverity(0)` 会给出一个由空位图推出来的等级，那是编的）。
 * 2. **幂等**。同一条告警（设备 id + 时间 + 掩码 0）重复同步只写一次 —— `insert` 的去重键就是
 *    它；录音用 `remoteRecordingId = saving_path + audio_name` 做同样的去重（`upsertRemote`）。
 *    面板上的"再同步一次"是**正常操作**，不是错误路径。
 * 3. **时间是设备给的本地时间**（没有时区）。解不出来就**跳过并计数**，不猜 0、不猜现在。
 * 4. **磁盘护栏照旧**：写文件前问 `storage.canRecord('alarm')` 与剩余空间（与
 *    `AudioRecordingService` 同一条政策）。听诊盒子的告警录音是 `'alarm'` 类型，
 *    所以在低于安全水位时**应该**被挡住 —— 那是策略，不是缺陷。
 *
 * ---------------------------------------------------------------------------
 * 时频谱图默认**不下载**
 * ---------------------------------------------------------------------------
 * 一条告警最多 10 张 jpg，也就是 10 次 HTTP 请求。一次同步几百条告警时那是几千次请求，
 * 而界面日常只需要那条录音。所以 `downloadSpectrograms` 默认关，需要时显式打开
 * （协议实验室/取证场景），并且**如实报出下载了几张**。
 */

import { createHash } from 'node:crypto'
import path from 'node:path'
import type { AlarmRepository, RecordingRepository } from '../../database/alarm-repository'
import type { StorageService } from '../../storage/storage-service'
import type { E2AlarmLogEntry, E2Client } from './e2-client'
import { parseE2Timestamp } from '@shared/domain/e2'
import { e2AirSonarSnapshotNames, e2SpectrogramNames } from '@shared/domain/e2'
import { AppError, ErrorCodes } from '@shared/errors'
import { parseWave } from '../../audio/wave-parser'
import { storageLog } from '../../logging/logger'
import type { E2SyncOutcome } from '@shared/ipc/contract'

/** 一条告警的录音最多允许多大（超过就拒绝，避免把内存撑爆）。 */
export const E2_MAX_AUDIO_BYTES = 64 * 1024 * 1024

export interface E2SyncOptions {
  client: E2Client
  alarms: AlarmRepository
  recordings: RecordingRepository
  storage: StorageService
  /** 本地设备行 id（写进 `alarms.device_id` / `recordings.device_id`）。 */
  deviceId: string
  /** 稳定 uid —— 存储目录按它分（设备换 IP 之后录音还能找到）。 */
  deviceUid: string
  /**
   * 通道号。听诊盒子族**同一时刻只有一路**在工作（手册"通道数 1"，业主口径也是"每次切换"），
   * 所以恒为 0；留着这个参数是为了不把"0"这个数字写死在四五处。
   */
  channelIndex?: number
}

export interface E2SyncRequest {
  /** 一次最多处理多少条日志（分页取 `col_count`）。 */
  limit?: number
  /** 只同步这个时刻之后的（epoch ms）。不传就是全部（设备最多留 5000 条）。 */
  since?: number
  /** 下载告警录音（默认**开**：这是"拉"通道的主要价值）。 */
  downloadAudio?: boolean
  /** 下载时频谱图（默认**关**，理由见文件头）。 */
  downloadSpectrograms?: boolean
}

/**
 * 一次同步的结果。**形状定义在 `@shared/ipc/contract`**（渲染层要用同一个定义），
 * 这里只是把它再导出一次，免得调用方为了一个类型去 import 两个地方。
 */
export type { E2SyncOutcome } from '@shared/ipc/contract'

const MAX_REPORTED_ERRORS = 8

/** 一次同步的默认上限（界面把它显示出来，所以它是导出常量而不是散在代码里的 200）。 */
export const E2_SYNC_DEFAULT_LIMIT = 200

export class E2SyncService {
  private readonly client: E2Client
  private readonly alarms: AlarmRepository
  private readonly recordings: RecordingRepository
  private readonly storage: StorageService
  private readonly deviceId: string
  private readonly deviceUid: string
  private readonly channelIndex: number

  constructor(options: E2SyncOptions) {
    this.client = options.client
    this.alarms = options.alarms
    this.recordings = options.recordings
    this.storage = options.storage
    this.deviceId = options.deviceId
    this.deviceUid = options.deviceUid
    this.channelIndex = options.channelIndex ?? 0
  }

  /**
   * 拉一次。
   *
   * 分页只拉**一页**（`limit` 条）：设备最多留 5000 条，而"一次同步几千条 + 每条一个文件下载"
   * 会跑很久；界面反复点就行（幂等）。`deviceLogCount` 让界面能说"设备上还有 N 条"。
   */
  async sync(request: E2SyncRequest = {}): Promise<E2SyncOutcome> {
    const limit = clampInt(request.limit, E2_SYNC_DEFAULT_LIMIT, 1, 1000)
    const downloadAudio = request.downloadAudio !== false
    const downloadSpectrograms = request.downloadSpectrograms === true

    /**
     * **先确定变体**：日志端点与文件下载路径都按变体取（2023 版 `/alarm_log_all` +
     * `/alarm_files`，Air Sonar `/get_all_alarms` + `/saving_alarm_file`）。不先判一次，
     * 一台 Air Sonar 会拿到 404，而"设备没有日志"看起来就像一个结论。
     */
    const variant = await this.client.ensureVariant()

    const page = await this.client.listAlarmLogs({ startCol: 1, colCount: limit })

    const outcome: E2SyncOutcome = {
      logsSeen: 0,
      skippedBySince: 0,
      skippedBadTime: 0,
      alarmsCreated: 0,
      alarmsExisting: 0,
      filesMissing: 0,
      audioSaved: 0,
      audioExisting: 0,
      audioFailed: 0,
      spectrogramsSaved: 0,
      spectrogramsFailed: 0,
      snapshotsLinked: 0,
      errors: []
    }
    if (page.logsCount !== undefined) outcome.deviceLogCount = page.logsCount

    /**
     * 自己也截一刀。设备**应该**按 `col_count` 返回，但那是设备的事：一台不认这个参数的
     * 固件会一口气回 5000 条，而每一条都可能触发一次文件下载。截在这里比信任对面便宜得多。
     */
    const entries = page.logs.slice(0, limit)

    for (const entry of entries) {
      const timestamp = resolveTimestamp(entry)
      if (timestamp === undefined) {
        outcome.skippedBadTime += 1
        pushError(outcome, `设备给的时间无法解析，已跳过：${JSON.stringify(entry.time)}`)
        continue
      }
      if (request.since !== undefined && timestamp <= request.since) {
        outcome.skippedBySince += 1
        continue
      }
      outcome.logsSeen += 1

      const filesMissing = entry.filesStatus === 0
      if (filesMissing) outcome.filesMissing += 1

      const savingPath = entry.savingPath ?? ''
      const audioName = entry.audioName ?? ''
      const remoteId = savingPath !== '' && audioName !== '' ? `${savingPath}${audioName}` : undefined

      const row = this.insertAlarm(entry, timestamp, remoteId)
      if (row.created) outcome.alarmsCreated += 1
      else outcome.alarmsExisting += 1

      if (!downloadAudio || filesMissing) continue
      if (remoteId === undefined) {
        pushError(outcome, `告警 ${entry.id ?? '?'} 没有文件名，无法下载录音`)
        continue
      }

      const saved = await this.pullAudio({
        alarmId: row.id,
        remoteId,
        savingPath,
        audioName,
        timestamp
      })
      if (saved === 'saved') outcome.audioSaved += 1
      else if (saved === 'existing') outcome.audioExisting += 1
      // `files_status` 说文件在、三条下载路径却都 404 ⇒ 与"已经标明文件没了"是同一个事实。
      else if (saved === 'missing') outcome.filesMissing += 1
      else outcome.audioFailed += 1

      if (downloadSpectrograms) {
        const images = await this.pullSpectrograms({
          alarmId: row.id,
          savingPath,
          timestamp
        })
        outcome.spectrogramsSaved += images.saved
        outcome.spectrogramsFailed += images.failed
        if (images.saved > 0) outcome.snapshotsLinked += 1
      }
    }

    storageLog().info('听诊盒子同步完成', {
      deviceId: this.deviceId,
      variant: variant ?? 'unknown',
      logsSeen: outcome.logsSeen,
      alarmsCreated: outcome.alarmsCreated,
      alarmsExisting: outcome.alarmsExisting,
      audioSaved: outcome.audioSaved,
      audioFailed: outcome.audioFailed
    })
    return outcome
  }

  /** 写告警行。**`source: 'e2'` + `alarmMask: 0` + `severity: 'unknown'`**（见文件头第 1 条）。 */
  private insertAlarm(
    entry: E2AlarmLogEntry,
    timestamp: number,
    remoteId: string | undefined
  ): { id: string; created: boolean } {
    const insert: Parameters<AlarmRepository['insert']>[0] = {
      deviceId: this.deviceId,
      channelId: this.channelIndex,
      timestamp,
      // 听诊盒子族**没有** FA8 那套位图。恒 0 而不是把 alarm_value 塞进来。
      alarmMask: 0,
      source: 'e2',
      // 不传的话会按空位图派生一个等级 —— 那是编的。
      severity: 'unknown',
      // 设备原始载荷整份留着（三种模式的字段集合不同）。优先用**设备原文**，
      // 拿不到时退回收窄后的视图（那样白名单之外的键就没了，但聊胜于无）。
      deviceRaw: entry.raw ?? JSON.stringify(entry)
    }
    // `db_value` 就是分贝值 → 我们的 spl；`main_frequency` 只在电力设备模式出现。
    const spl = entry.values.db_value
    if (spl !== undefined) insert.spl = spl
    const mainFrequency = entry.values.main_frequency
    if (mainFrequency !== undefined) insert.mainFrequency = mainFrequency
    if (entry.alarmValue !== undefined) insert.deviceAlarmValue = entry.alarmValue
    if (entry.alarmReasons !== undefined) insert.deviceReason = entry.alarmReasons
    if (entry.filesStatus !== undefined) insert.filesStatus = entry.filesStatus
    if (remoteId !== undefined) insert.remoteAudioPath = remoteId
    return this.alarms.insert(insert)
  }

  /**
   * 下载一段告警录音并落盘。
   *
   * 顺序刻意是"先登记元数据行（幂等键 = 设备文件名）→ 再下载 → 再 attach 文件"：
   * 这样一次同步在下载中途失败时，下一次会**认领**那一行而不是再插一条，
   * 而"数据库里有这一条、文件还没下来"正是 `recordings.relative_path` 为空所表达的状态
   * （与 FA8 的 `Sync Device Recordings` 同一条语义）。
   */
  private async pullAudio(input: {
    alarmId: string
    remoteId: string
    savingPath: string
    audioName: string
    timestamp: number
  }): Promise<'saved' | 'existing' | 'failed' | 'missing'> {
    const mirror = this.recordings.upsertRemote({
      deviceId: this.deviceId,
      channelId: this.channelIndex,
      recordingType: 'alarm',
      eventType: 'e2_alarm',
      startTime: input.timestamp,
      // 时长与采样率在**读完文件之后**用真实表头回填：现在还没有文件。
      sampleRate: 0,
      audioFormat: 'wav',
      relativePath: '',
      remoteRecordingId: input.remoteId
    })
    this.alarms.linkRecording(input.alarmId, mirror.id)

    const existing = this.recordings.findById(mirror.id)
    if (existing !== undefined && existing.relativePath !== '') {
      // 本地已经有了：不再下一次。这是"反复点同步"的常态。
      return 'existing'
    }

    let bytes: Uint8Array
    try {
      bytes = await this.client.downloadAlarmFile({
        savingPath: input.savingPath,
        fileName: input.audioName,
        maxBytes: E2_MAX_AUDIO_BYTES
      })
    } catch (error) {
      /*
       * 三条已文档化的下载路径**全都回了 404** ⇒ 那是"设备上没有这个文件"，不是"传输失败"。
       * 两者对操作员是两件事：前者是保留策略的预期结果（记录在、文件没了），后者要去看网络/
       * 权限/磁盘。原来一律记进 `audioFailed`，于是真机上"1001 条记录里 995 条的媒体文件
       * 已被清掉"这件事会显示成"下载失败"，看起来像我们的问题。
       * （2026-09-17 真机验证：那台 SN-16 的 6 条 `files_status=1` 的记录也全 404 —— 设备
       * 自己的网页播放器同样取不到，所以"文件没了"才是事实。）
       */
      if (error instanceof AppError && error.code === ErrorCodes.NOT_IMPLEMENTED) {
        storageLog().warn('听诊盒子告警文件在设备上已不存在', {
          remoteId: input.remoteId,
          reason: error.message
        })
        return 'missing'
      }
      return this.failAudio(input.remoteId, error)
    }

    const info = parseWave(bytes)
    if (info === undefined) {
      return this.failAudio(input.remoteId, new AppError(ErrorCodes.INVALID_RESPONSE, '下载到的不是 WAV 文件'))
    }

    // ---- 磁盘护栏（与 AudioRecordingService 同一条政策） ----
    try {
      if (!(await this.storage.canRecord('alarm'))) {
        return this.failAudio(
          input.remoteId,
          new AppError(ErrorCodes.DISK_FULL, '磁盘剩余空间低于安全阈值，已跳过告警录音下载')
        )
      }
      const usage = await this.storage.diskUsage()
      if (usage.freeBytes < bytes.byteLength) {
        return this.failAudio(
          input.remoteId,
          new AppError(ErrorCodes.DISK_FULL, '磁盘剩余空间不足，已跳过告警录音下载')
        )
      }
    } catch (error) {
      return this.failAudio(input.remoteId, error)
    }

    const { absolutePath, relativePath } = this.storage.buildClipPaths({
      deviceUid: this.deviceUid,
      channelIndex: this.channelIndex,
      kind: 'alarm',
      startTime: input.timestamp,
      extension: 'wav'
    })

    try {
      await this.storage.writeFile(absolutePath, bytes)
    } catch (error) {
      return this.failAudio(input.remoteId, error)
    }

    this.recordings.attachFile(mirror.id, {
      relativePath,
      fileSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      durationMs: Math.round(info.durationSeconds * 1000),
      // 文件自己的表头才是采样率的权威（元数据同步时我们只能先写 0）。
      sampleRate: info.sampleRate,
      audioFormat: 'wav'
    })
    return 'saved'
  }

  private failAudio(remoteId: string, error: unknown): 'failed' {
    const message = error instanceof Error ? error.message : String(error)
    storageLog().warn('听诊盒子告警录音下载失败', { remoteId, reason: message })
    return 'failed'
  }

  /**
   * 下载告警图（2023 版是 10 张**时频谱图**，Air Sonar V3.2 是 3 张 **PTZ 抓图**）。
   *
   * 张数与文件名按变体取：两代的图**不是同一种东西**（声学时频谱 vs 可见光抓图），
   * 数量也不同，所以不能共用一个常量。
   *
   * **不落 `recordings` 行**：它们不是录音，一张 jpg 混进录音库会让"录音文件"页出现
   * 无法播放的条目。存到告警录音同一个目录下的 `*_stft` 子目录，文件名沿用设备给的
   * `1.jpg`…，并**如实报出**存了几张 —— 手册说设备重启后可能不足，那是正常，不是失败。
   *
   * 存下来的**目录**会写进 `alarms.snapshot_dir`（v12）并读回核对：业主 2026-09-17 第 8 批要的
   * 「在点位图上点声呐看截图」就是要按告警找这几张图，而在此之前路径没有落进任何一列
   * （文件在磁盘上、界面永远找不到）。
   */
  private async pullSpectrograms(input: {
    alarmId: string
    savingPath: string
    timestamp: number
  }): Promise<{ saved: number; failed: number }> {
    let saved = 0
    let failed = 0
    const { absolutePath } = this.storage.buildClipPaths({
      deviceUid: this.deviceUid,
      channelIndex: this.channelIndex,
      kind: 'alarm',
      startTime: input.timestamp,
      extension: 'wav'
    })
    const directory = `${absolutePath.slice(0, Math.max(0, absolutePath.lastIndexOf('.')))}_stft`
    const names =
      this.client.resolvedVariant === 'airSonar' ? e2AirSonarSnapshotNames() : e2SpectrogramNames()
    for (const name of names) {
      try {
        const bytes = await this.client.downloadAlarmFile({
          savingPath: input.savingPath,
          fileName: name,
          maxBytes: 8 * 1024 * 1024
        })
        await this.storage.writeFile(`${directory}/${name}`, bytes)
        saved += 1
      } catch {
        // 缺图是**预期**状态（重启后可能不足、PTZ 相机没配对就没有抓图），只计数。
        failed += 1
      }
    }
    /*
     * 只有真的存下了图才写这一列：一张都没下到时写一个空目录，界面就会去打开一个不存在的
     * 目录并报"图没了"，而事实是"这台设备/这条告警没有图"（`snapshot_dir IS NULL`）。
     */
    if (saved > 0) {
      const relativeDirectory = path
        .relative(this.storage.root, directory)
        .split(path.sep)
        .join('/')
      const readBack = this.alarms.setSnapshotDir(input.alarmId, relativeDirectory)
      // 读回核对：写失败/写错列时读回来的不是这个值 —— 那时界面会永远找不到图。
      if (readBack !== relativeDirectory) {
        throw new AppError(
          ErrorCodes.STORAGE_ERROR,
          `告警抓图目录写库后读回不一致（写入 ${relativeDirectory}，读回 ${String(readBack)}）`,
          input.alarmId
        )
      }
    }
    return { saved, failed }
  }
}

/** 时间：优先用客户端解好的；客户端没解出来（老路径/手工构造）就再解一次。 */
function resolveTimestamp(entry: E2AlarmLogEntry): number | undefined {
  if (entry.timeMs !== undefined) return entry.timeMs
  return parseE2Timestamp(entry.time)?.ms
}

function pushError(outcome: E2SyncOutcome, message: string): void {
  if (outcome.errors.length < MAX_REPORTED_ERRORS) outcome.errors.push(message)
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}
