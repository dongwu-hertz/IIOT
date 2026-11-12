/**
 * AlarmService and RecordingService.
 *
 * AlarmService owns alarm persistence and bit-mask decoding (spec 5.1,
 * appendix B). RecordingService owns the device-library metadata sync
 * (spec 10.3). Neither touches audio bytes: those belong to the Ring Buffer and
 * the filesystem, and only their paths are recorded here.
 */

import { createHash } from 'node:crypto'
import { AppError, ErrorCodes } from '@shared/errors'
import type {
  AlarmEvent,
  AlarmPage,
  AlarmQuery,
  OverviewStats,
  Recording,
  RecordingPage,
  RecordingQuery
} from '@shared/domain/models'
import type { AlarmRepository, RecordingRepository } from '../database/alarm-repository'
import type { EventSeverity } from '@shared/domain/event-center'
import {
  extractAlarmAudio,
  mapAlarmMask,
  mapAlarmRecording,
  mapAlertAudioFile,
  toAlarmRecordingRow,
  type AlarmRecordingConfig
} from '../device/protocol/mappers'
import type { AudioRecordDto, AudioListResponseDto } from '../device/protocol/dto'
import type { StorageService } from '../storage/storage-service'
import type { DeviceService } from '../device/device-service'
import { deviceLog } from '../logging/logger'
import { now } from '@shared/utils/id'

/** Start and end of the current local day, for the "Today Recordings" counter. */
function todayRange(reference: Date = new Date()): { from: number; to: number } {
  const from = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate())
  const to = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() + 1)
  return { from: from.getTime(), to: to.getTime() }
}

// ---------------------------------------------------------------------------
// AlarmService
// ---------------------------------------------------------------------------

export interface AlarmServiceOptions {
  alarms: AlarmRepository
}

export class AlarmService {
  private readonly alarms: AlarmRepository

  constructor(options: AlarmServiceOptions) {
    this.alarms = options.alarms
  }

  query(query: AlarmQuery): AlarmPage {
    return this.alarms.query(query)
  }

  recent(limit = 10): AlarmEvent[] {
    return this.alarms.recent(limit)
  }

  acknowledge(ids: readonly string[], acknowledged: boolean): number {
    return this.alarms.acknowledge(ids, acknowledged)
  }

  /**
   * 写备注。服务层不再包一层校验：长度上限只在仓库层判一次（`ALARM_NOTE_MAX_LENGTH`），
   * 复制到第二处就会出现两个数字不一致的那天。
   */
  setNote(alarmId: string, note: string | null): boolean {
    return this.alarms.setNote(alarmId, note)
  }

  /** 人工改判等级（写入的是这条记录的快照，见仓库层注释）。 */
  setSeverity(alarmId: string, severity: EventSeverity): boolean {
    return this.alarms.setSeverity(alarmId, severity)
  }

  /** 列表页按等级分面计数。 */
  countBySeverity(query: AlarmQuery = {}): Record<EventSeverity, number> {
    return this.alarms.countBySeverity(query)
  }

  countUnacknowledged(): number {
    return this.alarms.countUnacknowledged()
  }

  /**
   * Ingest an alarm payload from a device event source.
   *
   * The payload shape is not contractually fixed (the alarm push format in
   * spec 15.1 differs from the /get_alarm_audio row shape), so the mask is
   * extracted defensively and an alarm with no recognisable mask is rejected
   * rather than stored as an all-zero event.
   */
  ingest(
    deviceId: string,
    channelId: number,
    payload: Record<string, unknown>,
    timestamp?: number
  ): { id: string; created: boolean } | undefined {
    const mask = mapAlarmMask(payload)
    if (mask === undefined || mask === 0) {
      deviceLog().debug('Ignoring alarm payload with no usable mask', { deviceId, channelId })
      return undefined
    }

    const record = this.alarms.insert({
      deviceId,
      channelId,
      timestamp: timestamp ?? now(),
      alarmMask: mask
    })
    return record
  }

  /** Retention sweep for alarm rows, mirroring the recording retention window. */
  pruneOlderThan(cutoff: number): number {
    return this.alarms.deleteOlderThan(cutoff)
  }
}

// ---------------------------------------------------------------------------
// RecordingService
// ---------------------------------------------------------------------------

export interface RecordingServiceOptions {
  recordings: RecordingRepository
  devices: DeviceService
  storage: StorageService
}

export class RecordingService {
  private readonly recordings: RecordingRepository
  private readonly devices: DeviceService
  private readonly storage: StorageService

  constructor(options: RecordingServiceOptions) {
    this.recordings = options.recordings
    this.devices = options.devices
    this.storage = options.storage
  }

  query(query: RecordingQuery): RecordingPage {
    return this.recordings.query(query)
  }

  findById(id: string) {
    return this.recordings.findById(id)
  }

  /**
   * Sync device alarm recordings (spec 10.3).
   *
   * MEASURED, and materially different from the specification:
   *   - `PUT /get_alarm_audio` requires `{ msgBody: { page_start, page_size } }`;
   *     an empty body answers `{"message":"Failed to obtain audio record.","result":1}`,
   *     which reads as "no recordings" but means "malformed request";
   *   - `PUT /get_audio`, which the specification also lists, returns an nginx
   *     404 on this firmware — it is tried second and its failure is expected;
   *   - the response array is `audioArray` and the total is `allSize`.
   *
   * Metadata first, audio on demand: a 10000-record library is normal on a
   * device that has been running for a while, so eager download is not an option.
   *
   * @returns how many NEW metadata rows were created.
   */
  async syncDeviceRecordings(deviceId: string): Promise<number> {
    const device = this.devices.get(deviceId)
    const client = this.requireClient(deviceId, device.name)

    // The device's own UI pages at 12; larger pages were rejected during
    // probing, so the sync walks pages at that size.
    const PAGE_SIZE = 12
    const MAX_PAGES = 40 // Bounded so a huge library cannot stall startup.

    const seen = new Set<string>()
    const configs: AlarmRecordingConfig[] = []

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await client.queryAlarmAudio({
        pageStart: page * PAGE_SIZE,
        pageSize: PAGE_SIZE
      })

      const rows = extractAlarmAudio(response)
      if (rows.length === 0) break

      for (const row of rows) {
        const mapped = mapAlarmRecording(row)
        if (!mapped) continue
        /*
         * AO01 的 `alertArray` 行只有告警 id，没有文件名；播放键在
         * `GET /audio?alert_id=<dalId>` 的 audioArray[0] 里。这里按需把
         * 相对路径（`mic/2026_11_06/xxx.wav`）取回来，`downloadRecording()`
         * 会把它编码成 `/download_audio/mic%2F...`（真机实测 200 + RIFF/WAVE）。
         * 取不到就保留无播放文件的告警行，不因为一次附件失败丢掉告警本身。
         */
        const alertId = Number((row as Record<string, unknown>).dalId)
        if (Number.isFinite(alertId)) {
          try {
            const audioFile = mapAlertAudioFile(await client.getAudioByAlert(alertId))
            if (audioFile.fileName) mapped.fileName = audioFile.fileName
            if (audioFile.durationMs !== undefined && mapped.durationMs === 0) {
              mapped.durationMs = audioFile.durationMs
            }
            if (audioFile.sampleRate !== undefined) mapped.sampleRate = audioFile.sampleRate
          } catch (error) {
            deviceLog().warn('AO01 alert audio lookup failed; recording stays metadata-only', {
              deviceId,
              alertId,
              reason: error instanceof Error ? error.message : String(error)
            })
          }
        }
        // De-duplicate within this sync pass; the repository also de-duplicates
        // against existing rows by remote id.
        const key = mapped.remoteId !== undefined ? String(mapped.remoteId) : mapped.fileName
        if (!key || seen.has(key)) continue
        seen.add(key)
        configs.push(mapped)
      }

      if (rows.length < PAGE_SIZE) break
    }

    let created = 0
    const timestamp = now()
    for (const config of configs) {
      const row = toAlarmRecordingRow(deviceId, config, timestamp)
      const remoteRecordingId = row.remoteRecordingId
      if (!remoteRecordingId) continue

      const result = this.recordings.upsertRemote({
        deviceId,
        channelId: row.channelId,
        recordingType: row.recordingType,
        startTime: row.startTime,
        sampleRate: row.sampleRate,
        audioFormat: row.audioFormat,
        relativePath: '',
        remoteRecordingId,
        ...(row.eventType ? { eventType: row.eventType } : {}),
        ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
        ...(row.endTime !== undefined ? { endTime: row.endTime } : {})
      })
      if (result.created) created += 1
    }

    deviceLog().info('Device alarm recordings synced', {
      deviceId,
      device: device.name,
      found: configs.length,
      created
    })

    return created
  }

  /**
   * Download one recording to the local audio store and attach it to its row.
   *
   * VERIFIED download path: `GET /download_audio/{dauFileName}` — NOT the
   * `/audio_file/{name}` the specification's example implied, which returns the
   * SPA's index.html with HTTP 200.
   *
   * The saved file is byte-for-byte what the device served, so the local copy
   * keeps the device's own encoding (32-bit IEEE float, mono). Re-encoding would
   * be lossy and would invalidate the integrity hash recorded alongside it.
   */
  async downloadRecording(recordingId: string): Promise<Recording | undefined> {
    const row = this.recordings.findById(recordingId)
    if (!row) return undefined
    if (!row.remoteRecordingId) {
      // A locally captured recording is already on disk.
      return row
    }

    const client = this.requireClient(row.deviceId, row.deviceId)

    // `remoteRecordingId` holds the device record id, but the download key is
    // the FILENAME. Recover it from the event type, where the sync stored it.
    const fileName = row.eventType
    if (!fileName || !fileName.toLowerCase().endsWith('.wav')) return row

    const downloaded = await client.downloadRecording(fileName)

    if (!downloaded.isWave) {
      throw new Error(
        `设备返回的不是 WAV 数据（可能命中了错误的 URL）：${downloaded.contentType}`
      )
    }

    // Persist under the storage root, mirroring the device's own day/channel
    // layout so a large library stays browsable on disk.
    const { absolutePath, relativePath } = this.storage.buildClipPaths({
      deviceUid: row.deviceId,
      channelIndex: row.channelId,
      kind: 'alarm',
      startTime: row.startTime,
      extension: 'wav',
      suffix: 'device'
    })

    await this.storage.writeFile(absolutePath, downloaded.bytes)
    const sha256 = createHash('sha256').update(downloaded.bytes).digest('hex')

    this.recordings.attachFile(recordingId, {
      relativePath,
      fileSize: downloaded.bytes.length,
      sha256,
      ...(downloaded.durationSeconds !== undefined
        ? { durationMs: Math.round(downloaded.durationSeconds * 1000) }
        : {})
    })

    deviceLog().info('Recording downloaded', {
      recordingId,
      fileName,
      bytes: downloaded.bytes.length,
      format: downloaded.audioFormat,
      durationSeconds: downloaded.durationSeconds
    })

    return this.recordings.findById(recordingId)
  }

  /**
   * Resolve a live API client, establishing a session if necessary.
   *
   * The client lives in DeviceService, so this goes through it rather than
   * constructing a second one: two clients would mean two sessions, two auth
   * probes and two sets of connection state for the same device.
   */
  private requireClient(deviceId: string, label: string) {
    const existing = this.devices.findClient(deviceId)
    if (existing) return existing

    // Triggers session establishment as a side effect.
    void this.devices.getInfo(deviceId).catch(() => undefined)
    const created = this.devices.findClient(deviceId)

    if (!created) {
      throw new AppError(
        ErrorCodes.DEVICE_OFFLINE,
        `无法建立与设备的会话：${label}`
      )
    }
    return created
  }
}

/**
 * Unwrap an audio list response.
 * The firmware may return a bare array, or wrap it under any of several keys —
 * the same defensiveness as the channel mapper, for the same reason.
 */
export function extractAudioList(payload: AudioListResponseDto | unknown): AudioRecordDto[] {
  if (Array.isArray(payload)) return payload as AudioRecordDto[]
  if (!payload || typeof payload !== 'object') return []
  const source = payload as Record<string, unknown>

  for (const key of ['data', 'list', 'audio', 'audio_list', 'records']) {
    const value = source[key]
    if (Array.isArray(value)) return value as AudioRecordDto[]
  }
  // One level of nesting, e.g. { data: { list: [...] } }
  for (const key of ['data', 'result']) {
    const nested = source[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const found = extractAudioList(nested)
      if (found.length > 0) return found
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// OverviewService (spec 8.3)
// ---------------------------------------------------------------------------

export interface OverviewServiceOptions {
  devices: DeviceService
  alarms: AlarmService
  recordings: RecordingRepository
}

export class OverviewService {
  private readonly devices: DeviceService
  private readonly alarms: AlarmService
  private readonly recordings: RecordingRepository

  constructor(options: OverviewServiceOptions) {
    this.devices = options.devices
    this.alarms = options.alarms
    this.recordings = options.recordings
  }

  /**
   * Counters for the Overview page.
   * Deliberately cheap aggregate queries — the spec says "V1 不做复杂 BI Dashboard",
   * so this must stay fast enough to poll.
   */
  stats(): OverviewStats {
    const list = this.devices.list()
    const { from, to } = todayRange()

    return {
      deviceTotal: list.length,
      deviceOnline: list.filter((device) => device.status === 'ONLINE').length,
      deviceOffline: list.filter((device) => device.status === 'OFFLINE').length,
      activeAlarms: this.alarms.countUnacknowledged(),
      todayRecordings: this.recordings.countBetween(from, to)
    }
  }
}
