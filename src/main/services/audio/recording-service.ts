/**
 * AudioRecordingService — persist a finished capture (spec 4.4, 10.3, 14.4).
 *
 * THE BOUNDARY THIS FILE SITS ON
 * Audio bytes go to the filesystem; only metadata goes to SQLite. This is the
 * one place where that hand-off happens for locally captured audio, so it is the
 * place that has to get all four rules right:
 *
 *   1. the file is written ATOMICALLY, so a crash cannot leave a half-written
 *      WAV that the recordings table already advertises;
 *   2. the row keeps a ROOT-RELATIVE path, never an absolute one, so moving the
 *      storage root to a larger disk stays a settings change (spec 4.1);
 *   3. an integrity hash is stored with the row, so a file that is later
 *      truncated or swapped is detectable;
 *   4. the disk-space floor is honoured BEFORE the buffer is encoded — checking
 *      afterwards would build a 92 MB WAV only to discover it cannot be written.
 *
 * WHY THE FORMAT IS FLOAT32 WAV
 * Device alarm recordings are 32-bit IEEE float, mono. Capturing to anything
 * else would make a locally recorded clip and a downloaded one behave
 * differently under analysis, which is exactly the trap this project cannot
 * afford when both are evidence for the same event.
 *
 * WHY THE HASH IS COMPUTED FROM THE ENCODED BYTES
 * The hash describes the file on disk, not the in-memory samples. Hashing the
 * samples would silently disagree with the file the moment the encoder changes.
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import {
  RECORDING_TYPES,
  type Recording,
  type RecordingType
} from '@shared/domain/models'
import { AppError, ErrorCodes } from '@shared/errors'
import { isValidChannel, type RecordingRepository } from '../database/alarm-repository'
import { storageLog } from '../logging/logger'
import type { StorageService } from '../storage/storage-service'
import type { PcmRingBuffer } from './ring-buffer'
import { encodeFloat32Wav, float32WavByteLength } from './wav-writer'

/**
 * Spec 4.3 pre-alarm model: the clip kept around an alarm is the 10 s that led
 * up to it plus the 20 s that followed it.
 *
 * The PRE half is the part that matters operationally — a threshold alarm fires
 * after the event has already crossed it, so by the time anyone reacts, the
 * evidence is in the past.
 */
export const DEFAULT_PRE_ALARM_SECONDS = 10
export const DEFAULT_POST_ALARM_SECONDS = 20

/**
 * RIFF stores chunk and file sizes in 32-bit fields, so a single WAV cannot
 * describe more than ~4 GiB. Catching it here turns an integer-truncated file
 * (which would still "play", with a bogus length) into a clear error.
 */
const MAX_RIFF_BYTES = 0xffff_ffff

export interface AudioRecordingServiceOptions {
  storage: StorageService
  recordings: RecordingRepository
}

export interface SaveRecordingInput {
  /** Local device row id, the foreign key on the recordings table. */
  deviceId: string
  /** Stable device identity, used for the on-disk directory layout. */
  deviceUid: string
  /** 0-7, as stored in the metadata row. */
  channelIndex: number
  recordingType: RecordingType
  /** Epoch ms the capture began (the alarm instant for an alarm clip). */
  startedAt: number
  samples: Float32Array
  sampleRate: number
  channelCount: number
  /**
   * Epoch ms the capture stopped.
   *
   * Optional because `durationMs` is always derived from the samples: when a
   * connection drops mid-recording the wall-clock span is longer than the audio
   * actually captured, and the two must not be conflated. When omitted, the end
   * time is derived from the audio itself.
   */
  endedAt?: number
  /** e.g. the decoded alarm-type key, so the UI can label the clip. */
  eventType?: string
}

export interface SavePreAlarmClipInput {
  deviceId: string
  deviceUid: string
  channelIndex: number
  /**
   * Epoch ms the alarm fired — the centre of the pre/post window.
   *
   * The caller should invoke this AFTER the post-alarm window has elapsed (or
   * accept a shorter tail), so the buffer holds both halves of the clip.
   */
  alarmAt: number
  /** The rolling window. Only its `snapshot()` is used, taken synchronously. */
  buffer: PcmRingBuffer
  /** Must be the format the buffer was filled with. */
  sampleRate: number
  channelCount: number
  /** Defaults to `alarm`: this path exists for alarm evidence. */
  recordingType?: RecordingType
  preSeconds?: number
  postSeconds?: number
  eventType?: string
}

export class AudioRecordingService {
  private readonly storage: StorageService
  private readonly recordings: RecordingRepository

  constructor(options: AudioRecordingServiceOptions) {
    this.storage = options.storage
    this.recordings = options.recordings
  }

  /**
   * Encode one finished capture to WAV, write it under the storage root and
   * insert its metadata row.
   *
   * @throws AppError DISK_FULL when the safety floor blocks a non-essential
   *   recording, or when the file simply cannot fit; VALIDATION_ERROR when the
   *   capture or its format is unusable.
   */
  async saveRecording(input: SaveRecordingInput): Promise<Recording> {
    const { sampleRate, channelCount, recordingType } = input

    assertIdentity(input.deviceId, input.deviceUid)
    assertRecordingType(recordingType)
    if (!isValidChannel(input.channelIndex)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `通道序号越界: ${input.channelIndex}`)
    }
    if (!Number.isFinite(input.startedAt) || input.startedAt <= 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `录音开始时间无效: ${input.startedAt}`)
    }
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `采样率无效: ${sampleRate}`)
    }
    if (!Number.isInteger(channelCount) || channelCount <= 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `声道数无效: ${channelCount}`)
    }

    // A partial trailing frame cannot be declared in the WAV header, so it is
    // dropped rather than written as a truncated block. With the measured
    // single-channel stream this is unreachable; it costs at most one frame
    // (< 1 ms) if a firmware ever packs channels differently.
    const usableSamples = trimToWholeFrames(input.samples, channelCount)
    const frames = usableSamples.length / channelCount
    if (frames === 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '没有音频数据可保存')
    }

    const durationMs = Math.round((frames / sampleRate) * 1000)
    const expectedBytes = float32WavByteLength(usableSamples.length)
    if (expectedBytes > MAX_RIFF_BYTES) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `单次录音超出 WAV 文件上限（约 4 GB），请缩短录音时长`,
        `samples=${usableSamples.length} bytes=${expectedBytes}`
      )
    }

    // ---- Disk guards, BEFORE encoding -------------------------------------
    // Spec 14.4: below the floor, non-essential (alarm/scheduled) recording
    // stops. Manual recordings are never blocked by the floor — that is the
    // documented policy, not an oversight.
    if (!(await this.storage.canRecord(recordingType))) {
      storageLog().warn('Recording refused: below the disk safety floor', {
        deviceId: input.deviceId,
        channelIndex: input.channelIndex,
        recordingType,
        requiredBytes: expectedBytes
      })
      throw new AppError(
        ErrorCodes.DISK_FULL,
        `录音已停止：磁盘剩余空间低于安全阈值（type=${recordingType}）`,
        `need=${expectedBytes}`
      )
    }

    const usage = await this.storage.diskUsage()
    if (usage.freeBytes < expectedBytes) {
      // The floor is policy; running out of bytes is physics. Even a manual
      // recording, which the floor never blocks, cannot be written if the file
      // does not fit — failing here is far better than a truncated file whose
      // metadata claims otherwise.
      storageLog().warn('Recording refused: not enough free space for the file', {
        deviceId: input.deviceId,
        requiredBytes: expectedBytes,
        freeBytes: usage.freeBytes
      })
      throw new AppError(
        ErrorCodes.DISK_FULL,
        '磁盘剩余空间不足，无法写入本次录音',
        `need=${expectedBytes} free=${usage.freeBytes}`
      )
    }

    // ---- Encode, write, record -------------------------------------------
    const bytes = encodeFloat32Wav(usableSamples, { sampleRate, channelCount })
    const { absolutePath, relativePath } = this.storage.buildClipPaths({
      deviceUid: input.deviceUid,
      channelIndex: input.channelIndex,
      kind: recordingType,
      startTime: input.startedAt,
      extension: 'wav'
    })

    // Hash the bytes that are about to hit the disk, so the stored digest
    // describes the actual file rather than an intermediate representation.
    const sha256 = createHash('sha256').update(bytes).digest('hex')

    await this.storage.writeFile(absolutePath, bytes)

    const endedAt =
      input.endedAt !== undefined && Number.isFinite(input.endedAt) && input.endedAt >= input.startedAt
        ? input.endedAt
        : input.startedAt + durationMs

    let recording: Recording
    try {
      recording = this.recordings.insert({
        deviceId: input.deviceId,
        channelId: input.channelIndex,
        recordingType,
        startTime: input.startedAt,
        endTime: endedAt,
        durationMs,
        sampleRate,
        audioFormat: 'wav',
        relativePath,
        fileSize: bytes.byteLength,
        sha256,
        ...(input.eventType ? { eventType: input.eventType } : {})
      })
    } catch (error) {
      // Compensate: a metadata row pointing at a file that was never recorded is
      // worse than orphaned bytes, because the UI would offer to play it. The
      // atomic rename in `writeFile` protects the reverse ordering, and this
      // protects this one.
      await fs.unlink(absolutePath).catch(() => undefined)
      throw AppError.from(error, ErrorCodes.STORAGE_ERROR)
    }

    storageLog().info('Recording saved', {
      deviceId: input.deviceId,
      deviceUid: input.deviceUid,
      channelIndex: input.channelIndex,
      recordingType,
      relativePath,
      fileSize: bytes.byteLength,
      durationMs,
      sampleRate,
      sha256
    })

    return recording
  }

  /**
   * Save the pre-alarm + post-alarm clip for an alarm (spec 4.3 model: 10 s
   * before, 20 s after).
   *
   * The window is sliced out of the ring buffer around `alarmAt` using the
   * buffer's own wall-clock bounds, so the caller does not have to track sample
   * offsets and cannot accidentally save the wrong half. The snapshot is taken
   * synchronously before the first `await`, so the file contents are decided at
   * the instant of the call rather than at the speed of the disk.
   *
   * The boundary is frame-accurate at best (+-1 frame, i.e. 100 ms on the tested
   * device): frames carry no timestamp of their own, so the buffer dates them by
   * arrival.
   */
  async savePreAlarmClip(input: SavePreAlarmClipInput): Promise<Recording> {
    const preSeconds = input.preSeconds ?? DEFAULT_PRE_ALARM_SECONDS
    const postSeconds = input.postSeconds ?? DEFAULT_POST_ALARM_SECONDS
    const sampleRate = input.sampleRate
    const channelCount = input.channelCount

    if (!Number.isFinite(preSeconds) || preSeconds < 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `预录时长无效: ${preSeconds}`)
    }
    if (!Number.isFinite(postSeconds) || postSeconds < 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `后录时长无效: ${postSeconds}`)
    }
    if (!Number.isFinite(input.alarmAt) || input.alarmAt <= 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `告警时间无效: ${input.alarmAt}`)
    }
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `采样率无效: ${sampleRate}`)
    }
    if (!Number.isInteger(channelCount) || channelCount <= 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `声道数无效: ${channelCount}`)
    }

    // Taken synchronously and deliberately: everything below may await.
    const snapshot = input.buffer.snapshot()
    const totalFrames = Math.floor(snapshot.samples.length / channelCount)
    if (totalFrames === 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        '环形缓冲区中没有可用的音频数据：请确认实时音频流已启动，且缓冲时长覆盖预录窗口'
      )
    }

    const from = input.alarmAt - preSeconds * 1000
    const to = input.alarmAt + postSeconds * 1000
    const framesToMs = 1000 / sampleRate

    // Clamp both ends into the retained window: when the buffer has not been
    // running long enough, saving LESS than the requested window is correct —
    // padding with silence would render as the channel going quiet just before
    // the alarm, which is a false reading of the evidence.
    const firstFrame = clampIndex(Math.floor((from - snapshot.startTime) / framesToMs), totalFrames)
    const lastFrame = Math.max(
      firstFrame,
      clampIndex(Math.ceil((to - snapshot.startTime) / framesToMs), totalFrames)
    )
    if (lastFrame <= firstFrame) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '预录窗口内没有音频数据，可能缓冲深度不足')
    }

    const samples = snapshot.samples.slice(firstFrame * channelCount, lastFrame * channelCount)
    // Date the clip from the audio actually captured, not from the requested
    // window: after a reconnect the buffer may start later than `from`.
    const startedAt = Math.round(snapshot.startTime + firstFrame * framesToMs)
    const capturedMs = Math.round((lastFrame - firstFrame) * framesToMs)

    storageLog().debug('Pre-alarm window captured', {
      deviceId: input.deviceId,
      channelIndex: input.channelIndex,
      requestedMs: (preSeconds + postSeconds) * 1000,
      capturedMs,
      bufferedMs: Math.round(totalFrames * framesToMs)
    })

    return this.saveRecording({
      deviceId: input.deviceId,
      deviceUid: input.deviceUid,
      channelIndex: input.channelIndex,
      recordingType: input.recordingType ?? 'alarm',
      startedAt,
      samples,
      sampleRate,
      channelCount,
      endedAt: startedAt + capturedMs,
      ...(input.eventType ? { eventType: input.eventType } : {})
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamp an index into [0, total]. */
function clampIndex(index: number, total: number): number {
  if (!Number.isFinite(index)) return 0
  return Math.max(0, Math.min(Math.floor(index), total))
}

/**
 * Drop the trailing partial frame, if any.
 *
 * Returns the input unchanged in the normal case, so no copy is made for the
 * measured single-channel stream.
 */
function trimToWholeFrames(samples: Float32Array, channelCount: number): Float32Array {
  const usable = samples.length - (samples.length % channelCount)
  return usable === samples.length ? samples : samples.subarray(0, usable)
}

function assertIdentity(deviceId: string, deviceUid: string): void {
  if (typeof deviceId !== 'string' || deviceId.trim() === '') {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, '设备 ID 缺失，无法保存录音')
  }
  if (typeof deviceUid !== 'string' || deviceUid.trim() === '') {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, '设备唯一标识缺失，无法确定录音存放目录')
  }
}

/** A runtime check, because this value can arrive from IPC or the scheduler. */
function assertRecordingType(recordingType: RecordingType): void {
  if (!RECORDING_TYPES.includes(recordingType)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `录音类型无效: ${String(recordingType)}`)
  }
}
