/**
 * Alarm and recording repositories.
 *
 * Both store METADATA only. Audio bytes live on the filesystem and are
 * referenced by a root-relative path (spec 4.1, appendix C rules 1 & 7).
 *
 * Alarm decoding happens here rather than in SQL: the bit taxonomy lives in
 * `@shared/domain/alarm-mask` so that the same function serves the DB layer,
 * the IPC layer and the UI (spec appendix B: "Vue 页面禁止直接做 bit 判断").
 */

import type { Database as SqliteDatabase } from 'better-sqlite3'
import {
  type AlarmEvent,
  type AlarmPage,
  type AlarmQuery,
  type AlarmSource,
  type AlarmType,
  type AudioFormat,
  type Recording,
  type RecordingContainerFormat,
  type RecordingPage,
  type RecordingQuery,
  type RecordingType,
  ALARM_NOTE_MAX_LENGTH,
  CHANNEL_COUNT,
  isAlarmSource
} from '@shared/domain/models'
import { decodeAlarmMask, deriveAlarmSeverity, primaryAlarmType } from '@shared/domain/alarm-mask'
import { isEventSeverity, type EventSeverity } from '@shared/domain/event-center'
import { newAlarmId, newRecordingId, now } from '@shared/utils/id'

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

interface AlarmRow {
  id: string
  device_id: string
  channel_id: number
  alarm_type: number | null
  alarm_mask: number
  alarm_time: number
  spl: number | null
  main_frequency: number | null
  smoothness: number | null
  band_energy_ratio: number | null
  remote_audio_path: string | null
  recording_id: string | null
  severity: string
  note: string | null
  acknowledged: number
  created_at: number
  // ---- v9：第二套协议（听诊盒子族）的载荷 ----
  source: string | null
  device_alarm_value: number | null
  device_reason: string | null
  files_status: number | null
  device_raw: string | null
  /** v12：本机存这条告警抓图的目录（存储根相对）。 */
  snapshot_dir: string | null
  /**
   * LEFT JOIN `recordings` 带来的容器（回放据此选音频/视频播放器）。
   * 查询语句用 `alarms.*` + 别名投影，列序不与 recordings 的列混淆。
   */
  local_recording_container?: string | null
}

/**
 * `note` 的长度上限来自域模型（`@shared/domain/models`），供渲染层与主进程共用同一个数字。
 *
 * 与 `schema.ts` v6 的 CHECK 是刻意的重复：CHECK 是最后一道防线（防止别的写入路径绕过
 * 代码），这里是**能给调用方一个可读错误**的那一道。SQLite 违反 CHECK 时抛的是通用
 * `SQLITE_CONSTRAINT`，界面拿不到"太长了"这个信息。
 */
export { ALARM_NOTE_MAX_LENGTH } from '@shared/domain/models'

function toAlarm(row: AlarmRow): AlarmEvent {
  const event: AlarmEvent = {
    id: row.id,
    deviceId: row.device_id,
    channelId: row.channel_id,
    timestamp: row.alarm_time,
    /**
     * 协议来源：v9 之前的行都是 FA8 时代的，迁移里回填成 `'fa8'`；这里再兜一次底
     * （打开的是别人可能动过的文件）。`alarm_mask` 为 0 且带 `device_alarm_value` 的
     * 行绝不是 FA8 —— 但那是写侧的事，读侧只认这一列。
     */
    source: isAlarmSource(row.source) ? row.source : 'fa8',
    alarmMask: row.alarm_mask,
    // Decoded on read, so the taxonomy lives in exactly one place.
    alarmTypes: decodeAlarmMask(row.alarm_mask),
    // 等级是**快照**，不是读时派生（见 `deriveAlarmSeverity()` 的理由）。这里只做边界
    // 收窄：数据库里的值理论上受 CHECK 保护，但打开的是别人可能动过的文件。
    severity: isEventSeverity(row.severity) ? row.severity : 'unknown',
    acknowledged: row.acknowledged === 1,
    createdAt: row.created_at
  }
  if (row.spl !== null) event.spl = row.spl
  if (row.main_frequency !== null) event.mainFrequency = row.main_frequency
  if (row.smoothness !== null) event.smoothness = row.smoothness
  if (row.band_energy_ratio !== null) event.bandEnergyRatio = row.band_energy_ratio
  if (row.remote_audio_path !== null) event.remoteAudioPath = row.remote_audio_path
  if (row.recording_id !== null) event.localRecordingId = row.recording_id
  if (row.note !== null) event.note = row.note
  // v9：第二套协议的载荷。**只做存在性判断**，不解释内容（那是域层 `e2.ts` 的事）。
  if (row.device_alarm_value !== null) event.deviceAlarmValue = row.device_alarm_value
  if (row.device_reason !== null) event.deviceReason = row.device_reason
  if (row.files_status !== null) event.filesStatus = row.files_status
  if (row.device_raw !== null) event.deviceRaw = row.device_raw
  if (row.snapshot_dir !== null) event.snapshotDir = row.snapshot_dir
  if (typeof row.local_recording_container === 'string' && row.local_recording_container !== '') {
    event.localRecordingContainer = row.local_recording_container as AlarmEvent['localRecordingContainer']
  }
  return event
}

export interface AlarmInsert {
  deviceId: string
  channelId: number
  timestamp: number
  alarmMask: number
  /**
   * 等级快照。**不传就按位图算**（`deriveAlarmSeverity()`），这是绝大多数调用方要的；
   * 显式传参只用于两处：把外部已判定的等级带进来，以及测试。
   *
   * 听诊盒子族**必须显式传 `'unknown'`**：那套 `alarm_value` 只有 6 个值、没有轻重之分，
   * 而它的 `alarmMask` 恒为 0 —— 不显式传的话 `deriveAlarmSeverity(0)` 会给一个
   * 由"空位图"推出来的等级，那是**编造**的等级。
   */
  severity?: EventSeverity
  /** 哪一套协议报的。默认 `'fa8'`（这个仓库里绝大多数调用方都是 FA8 系）。 */
  source?: AlarmSource
  spl?: number
  mainFrequency?: number
  smoothness?: number
  bandEnergyRatio?: number
  remoteAudioPath?: string
  recordingId?: string
  /** 听诊盒子族原始 `alarm_value`（**不是** `alarmMask`）。 */
  deviceAlarmValue?: number
  /** 设备自己的告警原因文本。 */
  deviceReason?: string
  /** 设备上文件还在不在（1 在 / 0 已被清）。 */
  filesStatus?: number
  /** 设备原始载荷 JSON（什么都不丢的那一列）。 */
  deviceRaw?: string
  /**
   * 本机存这条告警抓图的目录（**存储根相对**路径，v12）。
   *
   * 插入时通常还没有图（图是同步的后半段才下载的），所以这条路主要给 `setSnapshotDir()` 用；
   * 放在这里是为了让"一条告警的全部事实"能在同一个形状里传完（测试与将来的批量路径）。
   */
  snapshotDir?: string
}

export class AlarmRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Insert an alarm, de-duplicating on (device, channel, time, mask).
   * Feature streams retry and reconnect, so the same alarm can arrive twice;
   * a duplicate alarm row would inflate every count on the Overview screen.
   */
  insert(input: AlarmInsert): { id: string; created: boolean } {
    const existing = this.db
      .prepare<[string, number, number, number], { id: string }>(
        `SELECT id FROM alarms
          WHERE device_id = ? AND channel_id = ? AND alarm_time = ? AND alarm_mask = ?`
      )
      .get(input.deviceId, input.channelId, input.timestamp, input.alarmMask)

    if (existing) return { id: existing.id, created: false }

    const id = newAlarmId()
    this.db
      .prepare(
        `INSERT INTO alarms (
           id, device_id, channel_id, alarm_type, alarm_mask, alarm_time,
           spl, main_frequency, smoothness, band_energy_ratio,
           remote_audio_path, recording_id, severity, acknowledged, created_at,
           source, device_alarm_value, device_reason, files_status, device_raw, snapshot_dir
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.deviceId,
        input.channelId,
        primaryAlarmType(input.alarmMask) ?? null,
        input.alarmMask,
        input.timestamp,
        input.spl ?? null,
        input.mainFrequency ?? null,
        input.smoothness ?? null,
        input.bandEnergyRatio ?? null,
        input.remoteAudioPath ?? null,
        input.recordingId ?? null,
        // 快照而不是留给读侧派生：见 `deriveAlarmSeverity()` 的注释。
        input.severity ?? deriveAlarmSeverity(input.alarmMask),
        now(),
        input.source ?? 'fa8',
        input.deviceAlarmValue ?? null,
        input.deviceReason ?? null,
        input.filesStatus ?? null,
        input.deviceRaw ?? null,
        input.snapshotDir ?? null
      )

    return { id, created: true }
  }

  /**
   * 记下这条告警的抓图目录（v12），**写完读回来核对**。
   *
   * 为什么单独一个方法而不是"插入时一起写"：图是同步的**后半段**才下载的（先落告警行、
   * 再下文件），而且第二次同步同一条告警时命中幂等不会重新插入 —— 那时仍然要能补上目录。
   *
   * 幂等：同一条告警反复同步时把目录写成同一个值，不产生第二行、也不清空已有的值
   * （`snapshotDir` 为空串表示"这次没下到图"，那时**不动**已有目录：设备上文件被清了不代表
   * 本机那张图没了）。
   */
  setSnapshotDir(alarmId: string, snapshotsRelativeDir: string): string | undefined {
    if (snapshotsRelativeDir !== '') {
      this.db
        .prepare(`UPDATE alarms SET snapshot_dir = ? WHERE id = ?`)
        .run(snapshotsRelativeDir, alarmId)
    }
    const row = this.db
      .prepare<[string], { snapshot_dir: string | null }>(
        `SELECT snapshot_dir FROM alarms WHERE id = ?`
      )
      .get(alarmId)
    return row?.snapshot_dir ?? undefined
  }

  query(query: AlarmQuery): AlarmPage {
    const limit = clampLimit(query.limit, 100, 1000)
    const offset = Math.max(0, query.offset ?? 0)

    const conditions: string[] = []
    const params: (string | number)[] = []

    if (query.deviceId) {
      conditions.push('alarms.device_id = ?')
      params.push(query.deviceId)
    }
    if (query.channelId !== undefined) {
      conditions.push('alarms.channel_id = ?')
      params.push(query.channelId)
    }
    if (query.from !== undefined) {
      conditions.push('alarms.alarm_time >= ?')
      params.push(query.from)
    }
    if (query.to !== undefined) {
      conditions.push('alarms.alarm_time <= ?')
      params.push(query.to)
    }
    if (query.acknowledged !== undefined) {
      conditions.push('alarms.acknowledged = ?')
      params.push(query.acknowledged ? 1 : 0)
    }
    if (query.severity !== undefined) {
      conditions.push('alarms.severity = ?')
      params.push(query.severity)
    }
    if (query.source !== undefined) {
      // 旧行的 `source` 在迁移里回填过，所以这里可以精确匹配；`'fa8'` 也要能查到它们。
      conditions.push('alarms.source = ?')
      params.push(query.source)
    }
    if (query.alarmType !== undefined) {
      // Bit test in SQL is fine here: this is an index/scan concern, not
      // business decoding. The decoded list still comes from decodeAlarmMask.
      conditions.push('(alarms.alarm_mask & ?) != 0')
      params.push(1 << query.alarmType)
    }
    /*
     * 标题 / 内容关键字（业主：告警中心筛选只留这两项 + 时间范围）。
     * 标题匹配**设备名**：名字在 `devices` 表里，用子查询而不是 JOIN——JOIN 会让
     * `SELECT *` 的列序被 devices 的列污染，`AlarmRow` 映射会错位。
     * 转义收在这一层（调用方传**原始**关键字）：`%`/`_`/`\` 先转义再两头包 `%`，
     * 否则操作员搜一个下划线就把全库捞出来了。
     */
    const title = typeof query.title === 'string' ? query.title.trim() : ''
    if (title !== '') {
      conditions.push("alarms.device_id IN (SELECT id FROM devices WHERE name LIKE ? ESCAPE '\\')")
      params.push(likePattern(title))
    }
    const content = typeof query.content === 'string' ? query.content.trim() : ''
    if (content !== '') {
      conditions.push("(COALESCE(alarms.note, '') LIKE ? ESCAPE '\\' OR COALESCE(alarms.device_reason, '') LIKE ? ESCAPE '\\')")
      params.push(likePattern(content), likePattern(content))
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // `alarms.*` 投影保住 AlarmRow 的列序；容器经别名附在末尾（回放选播放器用）。
    const rows = this.db
      .prepare<typeof params, AlarmRow>(
        `SELECT alarms.*, recordings.container_format AS local_recording_container
         FROM alarms LEFT JOIN recordings ON recordings.id = alarms.recording_id
         ${where} ORDER BY alarms.alarm_time DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset)

    const totalRow = this.db
      .prepare<typeof params, { total: number }>(`SELECT COUNT(*) AS total FROM alarms ${where}`)
      .get(...params)

    return { items: rows.map(toAlarm), total: totalRow?.total ?? 0, limit, offset }
  }

  recent(limit = 10): AlarmEvent[] {
    const rows = this.db
      .prepare<[number], AlarmRow>(
        `SELECT alarms.*, recordings.container_format AS local_recording_container
         FROM alarms LEFT JOIN recordings ON recordings.id = alarms.recording_id
         ORDER BY alarm_time DESC LIMIT ?`
      )
      .all(clampLimit(limit, 10, 200))
    return rows.map(toAlarm)
  }

  /**
   * 按 id 取一条。
   *
   * 加它是因为「把这条告警加入样本库」需要**精确**取那一条：原来那版调用方拿
   * `query({ limit: 1000 })` 再 `find`，而告警列表按时间倒序、上限又是 1000 ——
   * 一条 1000 条以前的告警会"点加入样本库没反应"，而且**看不出来为什么**。
   */
  findById(id: string): AlarmEvent | undefined {
    const row = this.db
      .prepare<[string], AlarmRow>(
        `SELECT alarms.*, recordings.container_format AS local_recording_container
         FROM alarms LEFT JOIN recordings ON recordings.id = alarms.recording_id
         WHERE alarms.id = ?`
      )
      .get(id)
    return row ? toAlarm(row) : undefined
  }

  countUnacknowledged(): number {
    const row = this.db
      .prepare<[], { total: number }>(`SELECT COUNT(*) AS total FROM alarms WHERE acknowledged = 0`)
      .get()
    return row?.total ?? 0
  }

  /** Alarms in a window; used by the Overview "today" counters. */
  countBetween(from: number, to: number): number {
    const row = this.db
      .prepare<[number, number], { total: number }>(
        `SELECT COUNT(*) AS total FROM alarms WHERE alarm_time >= ? AND alarm_time <= ?`
      )
      .get(from, to)
    return row?.total ?? 0
  }

  acknowledge(ids: readonly string[], acknowledged: boolean): number {
    if (ids.length === 0) return 0
    const statement = this.db.prepare(`UPDATE alarms SET acknowledged = ? WHERE id = ?`)
    let changes = 0
    const apply = this.db.transaction(() => {
      for (const id of ids) {
        changes += statement.run(acknowledged ? 1 : 0, id).changes
      }
    })
    apply()
    return changes
  }

  /** Link an alarm to the local recording captured from the Ring Buffer. */
  linkRecording(alarmId: string, recordingId: string): void {
    this.db.prepare(`UPDATE alarms SET recording_id = ? WHERE id = ?`).run(recordingId, alarmId)
  }

  /**
   * 写入操作员备注。`null` 表示清除备注（与"空字符串"是两件事，见 schema v6 的 CHECK：
   * 列允许 NULL，也允许长度 ≤500 的字符串）。
   *
   * 返回是否真的改到了一行，而不是"没抛异常"：界面要能区分「存下了」与「这条告警已经不
   * 在了（被保留策略清掉）」。
   */
  setNote(alarmId: string, note: string | null): boolean {
    if (note !== null && note.length > ALARM_NOTE_MAX_LENGTH) {
      throw new Error(
        `alarm note too long: ${note.length} > ${ALARM_NOTE_MAX_LENGTH} characters`
      )
    }
    return this.db.prepare(`UPDATE alarms SET note = ? WHERE id = ?`).run(note, alarmId).changes > 0
  }

  /**
   * 改判一条告警的等级。
   *
   * 允许人工改判是**刻意的**：等级由我们按位图划（`deriveAlarmSeverity()`），而位图是
   * 设备给的、我们只能按物理含义分组；现场情况比位图细（同一条"冷却器异常"在关键机组上
   * 就该当紧急处理）。改判写回 `severity` 列，也就是**修订这条记录的快照**，而不是引入
   * 第二套"人工等级"字段——两个字段并存必然出现"到底听谁的"。
   */
  setSeverity(alarmId: string, severity: EventSeverity): boolean {
    if (!isEventSeverity(severity)) {
      throw new Error(`unknown alarm severity: ${String(severity)}`)
    }
    return this.db.prepare(`UPDATE alarms SET severity = ? WHERE id = ?`).run(severity, alarmId)
      .changes > 0
  }

  /** 列表页的等级分面：每一档各有多少条。 */
  countBySeverity(query: AlarmQuery = {}): Record<EventSeverity, number> {
    const conditions: string[] = []
    const params: (string | number)[] = []
    if (query.deviceId) {
      conditions.push('alarms.device_id = ?')
      params.push(query.deviceId)
    }
    if (query.channelId !== undefined) {
      conditions.push('alarms.channel_id = ?')
      params.push(query.channelId)
    }
    if (query.from !== undefined) {
      conditions.push('alarms.alarm_time >= ?')
      params.push(query.from)
    }
    if (query.to !== undefined) {
      conditions.push('alarms.alarm_time <= ?')
      params.push(query.to)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare<typeof params, { severity: string; total: number }>(
        `SELECT severity, COUNT(*) AS total FROM alarms ${where} GROUP BY severity`
      )
      .all(...params)

    const counts: Record<EventSeverity, number> = {
      info: 0,
      warning: 0,
      critical: 0,
      unknown: 0
    }
    for (const row of rows) {
      // 分组结果里出现没见过的取值时**不静默丢弃**：它计入 `unknown`，因为"这一档我们
      // 认不出来"和"我们没有等级"对界面是同一件事——都不能当成 0。
      counts[isEventSeverity(row.severity) ? row.severity : 'unknown'] += row.total
    }
    return counts
  }

  deleteOlderThan(cutoff: number): number {
    return this.db.prepare(`DELETE FROM alarms WHERE alarm_time < ?`).run(cutoff).changes
  }
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

interface RecordingRow {
  id: string
  device_id: string
  channel_id: number
  recording_type: string
  event_type: string | null
  start_time: number
  end_time: number | null
  duration_ms: number | null
  sample_rate: number
  audio_format: string | null
  container_format: string | null
  relative_path: string
  file_size: number | null
  sha256: string | null
  remote_recording_id: string | null
  created_at: number
}

/**
 * 相机手动录像行的 `event_type` 取值。
 *
 * 真实容器现在由 `container_format` 列表达（schema v5 起）；这个自由文本标记
 * 继续保留，因为它是**事件语义**（"操作员手动录的一段视频"）而不是容器，
 * 并且历史行靠它区分。
 */
export const CAMERA_VIDEO_EVENT_TYPE = 'video_mp4'

function toRecording(row: RecordingRow): Recording {
  const recording: Recording = {
    id: row.id,
    deviceId: row.device_id,
    channelId: row.channel_id,
    recordingType: row.recording_type as RecordingType,
    startTime: row.start_time,
    sampleRate: row.sample_rate,
    // 不是音频的文件（相机 MP4、检测库图片）存 NULL，而不是借用 'wav' 骗过
    // CHECK（见 schema v5 迁移的说明）。NULL 在这里是**已知的"没有"**。
    audioFormat: row.audio_format === null ? null : (row.audio_format as AudioFormat),
    relativePath: row.relative_path,
    createdAt: row.created_at
  }
  if (row.container_format !== null) {
    recording.containerFormat = row.container_format as RecordingContainerFormat
  }
  if (row.event_type !== null) recording.eventType = row.event_type
  if (row.end_time !== null) recording.endTime = row.end_time
  if (row.duration_ms !== null) recording.durationMs = row.duration_ms
  if (row.file_size !== null) recording.fileSize = row.file_size
  if (row.sha256 !== null) recording.sha256 = row.sha256
  if (row.remote_recording_id !== null) recording.remoteRecordingId = row.remote_recording_id
  return recording
}

export interface RecordingInsert {
  deviceId: string
  channelId: number
  recordingType: RecordingType
  startTime: number
  sampleRate: number
  /** NULL 表示"这个文件不是音频"，不是"不知道"。 */
  audioFormat: AudioFormat | null
  /** 磁盘上真实的容器；不传时按 `audioFormat` 推断，两者都空则落 `unknown`。 */
  containerFormat?: RecordingContainerFormat
  relativePath: string
  eventType?: string
  endTime?: number
  durationMs?: number
  fileSize?: number
  sha256?: string
  remoteRecordingId?: string
}

export class RecordingRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(input: RecordingInsert): Recording {
    const id = newRecordingId()
    this.db
      .prepare(
        `INSERT INTO recordings (
           id, device_id, channel_id, recording_type, event_type,
           start_time, end_time, duration_ms, sample_rate, audio_format,
           container_format, relative_path, file_size, sha256, remote_recording_id,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.deviceId,
        input.channelId,
        input.recordingType,
        input.eventType ?? null,
        input.startTime,
        input.endTime ?? null,
        input.durationMs ?? null,
        input.sampleRate,
        input.audioFormat,
        // 容器默认取音频格式；没有音频又没说容器时落 `unknown`——宁可说"看不出来"
        // 也不猜一个。`unknown` 是 CHECK 允许的取值（schema v5）。
        input.containerFormat ?? input.audioFormat ?? 'unknown',
        input.relativePath,
        input.fileSize ?? null,
        input.sha256 ?? null,
        input.remoteRecordingId ?? null,
        now()
      )
    const created = this.findById(id)
    if (!created) throw new Error('Recording insert failed')
    return created
  }

  /**
   * Insert or refresh a device-library mirror.
   *
   * Spec 10.3: "Manager 应支持 Sync Device Recordings，将元数据同步到本地".
   * Metadata sync is idempotent — the device's own record id is the natural key
   * — because the audio itself is downloaded lazily and may not exist locally
   * yet (`relative_path` stays empty until then).
   */
  upsertRemote(input: RecordingInsert & { remoteRecordingId: string }): { id: string; created: boolean } {
    const existing = this.db
      .prepare<[string, string], { id: string }>(
        `SELECT id FROM recordings WHERE device_id = ? AND remote_recording_id = ?`
      )
      .get(input.deviceId, input.remoteRecordingId)

    if (existing) {
      // Refresh only the fields the device owns; never clobber a downloaded file.
      this.db
        .prepare(
          `UPDATE recordings
              SET start_time = ?, end_time = ?, duration_ms = ?, sample_rate = ?,
                  audio_format = COALESCE(?, audio_format),
                  container_format = COALESCE(?, container_format),
                  event_type = COALESCE(?, event_type)
            WHERE id = ?`
        )
        .run(
          input.startTime,
          input.endTime ?? null,
          input.durationMs ?? null,
          input.sampleRate,
          input.audioFormat,
          input.containerFormat ?? null,
          input.eventType ?? null,
          existing.id
        )
      return { id: existing.id, created: false }
    }

    const recording = this.insert(input)
    return { id: recording.id, created: true }
  }

  /**
   * 登记一段**相机视频录像**（MP4）。
   *
   * v5 之前这个方法是"列在说谎"的唯一落点：`audio_format` 的 CHECK 只允许
   * `wav`/`flac`，所以一段 MP4 只能写成 `'wav'`，真实容器藏在 `event_type`
   * 这个自由文本列里，界面再靠 `relative_path` 的扩展名兜底——三处证据、两处
   * 不一致。schema v5 重建了这张表：现在这里如实写 `audio_format = NULL`
   * （视频**没有**音频格式），容器写进 `container_format`，而 `event_type`
   * 退回它本来的含义：**事件语义**标记（手动录像 / 告警联动录像）。
   *
   * `recordingType` 让**告警联动录像**落成 `'alarm'`——这不是装饰：14.4 的保留
   * 策略只自动删除 `recording_type = 'alarm'` 的行（`expiredAlarmRecordings`），
   * 一段告警录像若被登记成 `'manual'` 就会永久占盘，而手动录像被登记成
   * `'alarm'` 则会在用户没要求的情况下被删掉。默认 `'manual'` 保持既有调用方
   * （`CameraCaptureService`）的行为不变。
   */
  insertVideo(input: {
    deviceId: string
    channelId?: number
    startTime: number
    endTime: number
    durationMs: number
    relativePath: string
    fileSize: number
    /** 默认 `'manual'`：既有调用方（操作员手动录像）的行为不变。 */
    recordingType?: RecordingType
    /** 事件语义标记；默认 `video_mp4`，告警联动用 `alarm_linked_mp4`。 */
    eventType?: string
    /** 容器，默认 `mp4`；镜像设备检测库的视频文件时可覆盖。 */
    containerFormat?: RecordingContainerFormat
  }): Recording {
    return this.insert({
      deviceId: input.deviceId,
      channelId: input.channelId ?? 0,
      recordingType: input.recordingType ?? 'manual',
      startTime: input.startTime,
      endTime: input.endTime,
      durationMs: input.durationMs,
      // 视频录像没有音频采样率可言，如实写 0 而不是编一个 48000。
      sampleRate: 0,
      // 也没有音频格式：NULL 是"已知的没有"，不是"不知道"。
      audioFormat: null,
      containerFormat: input.containerFormat ?? 'mp4',
      relativePath: input.relativePath,
      eventType: input.eventType ?? CAMERA_VIDEO_EVENT_TYPE,
      fileSize: input.fileSize
    })
  }

  /**
   * 登记一段**告警联动录像**。
   *
   * 只是一行 `insertVideo({ recordingType: 'alarm' })` 的具名封装：调用点读到
   * 的名字就说明了语义，而 `'alarm'` 这个取值与保留策略的关系在上面的注释里。
   */
  insertAlarmVideo(input: {
    deviceId: string
    channelId?: number
    startTime: number
    endTime: number
    durationMs: number
    relativePath: string
    fileSize: number
    eventType?: string
    containerFormat?: RecordingContainerFormat
  }): Recording {
    return this.insertVideo({
      ...input,
      recordingType: 'alarm',
      ...(input.eventType !== undefined ? { eventType: input.eventType } : {})
    })
  }

  findById(id: string): Recording | undefined {
    const row = this.db
      .prepare<[string], RecordingRow>(`SELECT * FROM recordings WHERE id = ?`)
      .get(id)
    return row ? toRecording(row) : undefined
  }

  /**
   * Attach the downloaded file to a metadata row (called after a download).
   *
   * `sampleRate` 也要能在这里补：元数据同步时我们还不知道它（行是设备库的镜像，
   * `sample_rate` 只能先写 0），而**文件自己的表头**才是这件事的权威 —— 一个 48 kHz 的
   * 录音行如果永远写着 0，播放器与样本库都会拿到错的信息。
   */
  attachFile(
    id: string,
    details: {
      relativePath: string
      fileSize: number
      sha256?: string
      durationMs?: number
      sampleRate?: number
      audioFormat?: AudioFormat
    }
  ): void {
    this.db
      .prepare(
        `UPDATE recordings
            SET relative_path = ?, file_size = ?, sha256 = COALESCE(?, sha256),
                duration_ms = COALESCE(?, duration_ms),
                sample_rate = COALESCE(?, sample_rate),
                audio_format = COALESCE(?, audio_format)
          WHERE id = ?`
      )
      .run(
        details.relativePath,
        details.fileSize,
        details.sha256 ?? null,
        details.durationMs ?? null,
        details.sampleRate ?? null,
        details.audioFormat ?? null,
        id
      )
  }

  query(query: RecordingQuery): RecordingPage {
    const limit = clampLimit(query.limit, 100, 1000)
    const offset = Math.max(0, query.offset ?? 0)

    const conditions: string[] = []
    const params: (string | number)[] = []

    if (query.deviceId) {
      conditions.push('device_id = ?')
      params.push(query.deviceId)
    }
    if (query.channelId !== undefined) {
      conditions.push('channel_id = ?')
      params.push(query.channelId)
    }
    if (query.recordingType) {
      conditions.push('recording_type = ?')
      params.push(query.recordingType)
    }
    if (query.from !== undefined) {
      conditions.push('start_time >= ?')
      params.push(query.from)
    }
    if (query.to !== undefined) {
      conditions.push('start_time <= ?')
      params.push(query.to)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = this.db
      .prepare<typeof params, RecordingRow>(
        `SELECT * FROM recordings ${where} ORDER BY start_time DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset)

    const totalRow = this.db
      .prepare<typeof params, { total: number }>(`SELECT COUNT(*) AS total FROM recordings ${where}`)
      .get(...params)

    return { items: rows.map(toRecording), total: totalRow?.total ?? 0, limit, offset }
  }

  countBetween(from: number, to: number): number {
    const row = this.db
      .prepare<[number, number], { total: number }>(
        `SELECT COUNT(*) AS total FROM recordings WHERE start_time >= ? AND start_time <= ?`
      )
      .get(from, to)
    return row?.total ?? 0
  }

  /** Alarm recordings past the retention window — the only auto-deletable kind. */
  expiredAlarmRecordings(cutoff: number): Recording[] {
    const rows = this.db
      .prepare<[number], RecordingRow>(
        `SELECT * FROM recordings
          WHERE recording_type = 'alarm' AND start_time < ?`
      )
      .all(cutoff)
    return rows.map(toRecording)
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM recordings WHERE id = ?`).run(id).changes > 0
  }

  /** Total bytes referenced by metadata rows, for the storage panel. */
  totalFileSize(): number {
    const row = this.db
      .prepare<[], { total: number | null }>(`SELECT SUM(file_size) AS total FROM recordings`)
      .get()
    return row?.total ?? 0
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Clamp a page size into a sane range so a bad request cannot exhaust memory. */
function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
}

/** Type-narrow a channel index coming from an untrusted source. */
export function isValidChannel(channelId: number): boolean {
  return Number.isInteger(channelId) && channelId >= 0 && channelId < CHANNEL_COUNT
}

/**
 * 把原始关键字变成安全的 LIKE 模式：转义 `%` / `_` / `\` 后两头包 `%`。
 * 与上面 query() 里的 `ESCAPE '\'` 配套；导出来是为了让单测能直接断言转义行为。
 */
export function likePattern(keyword: string): string {
  const escaped = keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)
  return `%${escaped}%`
}

export type { AlarmType }
