/**
 * Recording playback preparation.
 *
 * WHY THE MAIN PROCESS PREPARES PLAYBACK
 * The player needs three things: the audio bytes, a waveform overview, and a
 * spectrum. The bytes must come from the main process (the renderer has no
 * filesystem access and no network access by design). The two derived views
 * could be computed in the renderer, but doing them here has a concrete benefit:
 * the renderer receives a small, ready-to-plot payload instead of a 5 MB base64
 * string it must first decode to `Float32Array`, then reduce. On a modest PC
 * that decode runs synchronously on the UI thread and drops frames.
 *
 * FORMAT
 * Device recordings are verified as WAV with `audioFormat = 3` (IEEE Float),
 * mono, 32-bit. Locally captured recordings use the identical encoding, so one
 * code path handles both.
 */

import { readFile } from 'node:fs/promises'
import type { PlaybackData } from '@shared/ipc/contract'
import type { Recording } from '@shared/domain/models'
import { AppError, ErrorCodes } from '@shared/errors'
import type { StorageService } from '../storage/storage-service'
import type { RecordingRepository } from '../database/alarm-repository'
import type { DeviceService } from '../device/device-service'
import { deviceLog, storageLog } from '../logging/logger'
import { decodeWaveToFloat32, WAVE_FORMAT } from './wave-parser'
import { extractWaveform } from './pcm-utils'

/** Points in the waveform overview strip. Enough detail for a 10 s clip, small on the wire. */
const WAVEFORM_BUCKETS = 600

/** Frequency bins returned for the spectrum panel. */
const SPECTRUM_BINS = 256

export interface PlaybackServiceOptions {
  storage: StorageService
  recordings: RecordingRepository
  devices: DeviceService
}

export class PlaybackService {
  private readonly storage: StorageService
  private readonly recordings: RecordingRepository
  private readonly devices: DeviceService

  constructor(options: PlaybackServiceOptions) {
    this.storage = options.storage
    this.recordings = options.recordings
    this.devices = options.devices
  }

  /**
   * Produce everything the player needs for one recording.
   *
   * Downloads from the device first when the audio is not on disk yet, so the
   * caller can offer a single "play" action regardless of whether the clip has
   * been fetched.
   */
  async load(recordingId: string): Promise<PlaybackData> {
    const recording = this.recordings.findById(recordingId)
    if (!recording) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `录音不存在: ${recordingId}`)
    }

    const bytes = await this.resolveBytes(recording)
    const decoded = decodeWaveToFloat32(bytes)

    if (!decoded.info) {
      throw new AppError(
        ErrorCodes.INVALID_RESPONSE,
        '录音文件不是有效的 WAV 数据，可能下载不完整'
      )
    }
    if (decoded.samples.length === 0) {
      throw new AppError(
        ErrorCodes.NOT_IMPLEMENTED,
        `暂不支持该音频编码：${decoded.unsupportedReason ?? '未知'}`
      )
    }

    const { info, samples } = decoded

    // A simple magnitude spectrum over the whole clip. Averaged rather than
    // FFT-per-window: the panel exists to show WHERE the energy sits, and a
    // long clip's per-window detail would be unreadable at 256 bins anyway.
    const spectrum = computeMagnitudeSpectrum(samples, SPECTRUM_BINS)
    const binHz = info.sampleRate / 2 / SPECTRUM_BINS

    const result: PlaybackData = {
      recordingId,
      audioBase64: Buffer.from(bytes).toString('base64'),
      mimeType: 'audio/wav',
      sampleRate: info.sampleRate,
      channels: info.channels,
      durationMs: Math.round(info.durationSeconds * 1000),
      // 片段在绝对时间轴上的起点。调用方（告警详情）用它算「告警时刻在片段里的位置」，
      // 才能实现"从告警前 N 秒开始播"（见 `PlaybackData.startTimeMs`）。
      startTimeMs: recording.startTime,
      waveform: extractWaveform(samples, WAVEFORM_BUCKETS),
      spectrum,
      spectrumBinHz: binHz
    }

    deviceLog().info('Playback prepared', {
      recordingId,
      bytes: bytes.byteLength,
      sampleRate: info.sampleRate,
      channels: info.channels,
      format: info.audioFormat === WAVE_FORMAT.IEEE_FLOAT ? 'float32' : 'pcm',
      durationMs: result.durationMs
    })

    return result
  }

  /**
   * Locate the audio for a recording, downloading it when necessary.
   *
   * A recording whose metadata was synced but whose audio was never fetched has
   * an empty `relative_path`. Fetching on demand (rather than during sync) is a
   * deliberate choice: a device library can hold 10000 alarm clips, and pulling
   * them all would be tens of gigabytes the moment a user opened the page.
   */
  private async resolveBytes(recording: Recording): Promise<Uint8Array> {
    if (recording.relativePath) {
      try {
        const absolute = this.storage.resolve(recording.relativePath)
        const bytes = await readFile(absolute)
        return new Uint8Array(bytes)
      } catch (error) {
        // A missing local file is recoverable when the device still has it, so
        // fall through to the download path rather than failing outright.
        storageLog().warn('Local recording unreadable; will try the device', {
          recordingId: recording.id,
          relativePath: recording.relativePath,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return this.downloadFromDevice(recording)
  }

  /** Fetch a device recording and attach it to its metadata row. */
  private async downloadFromDevice(recording: Recording): Promise<Uint8Array> {
    // `remoteRecordingId` holds the device record id; the DOWNLOAD KEY is the
    // filename, which the sync stored in `eventType`. See PROTOCOL-FINDINGS 5.3
    // for why those are different fields.
    const fileName = recording.eventType
    if (!recording.remoteRecordingId || !fileName || !fileName.toLowerCase().endsWith('.wav')) {
      throw new AppError(
        ErrorCodes.NOT_IMPLEMENTED,
        '该录音既没有本地文件，也没有可下载的设备文件信息'
      )
    }

    const client = this.devices.findClient(recording.deviceId)
    if (!client) {
      throw new AppError(ErrorCodes.DEVICE_OFFLINE, '设备未连接，无法下载录音')
    }

    const downloaded = await client.downloadRecording(fileName)
    if (!downloaded.isWave) {
      throw new AppError(
        ErrorCodes.INVALID_RESPONSE,
        `设备返回的不是 WAV 数据（content-type: ${downloaded.contentType}），下载路径可能有误`
      )
    }

    // Persist so the next play is instant, and so the file is backed up with the
    // rest of the library rather than only existing in memory.
    const device = this.devices.get(recording.deviceId)
    const { absolutePath, relativePath } = this.storage.buildClipPaths({
      deviceUid: device.deviceUid,
      channelIndex: recording.channelId,
      kind: 'alarm',
      startTime: recording.startTime,
      extension: 'wav',
      suffix: 'device'
    })

    await this.storage.writeFile(absolutePath, downloaded.bytes)

    this.recordings.attachFile(recording.id, {
      relativePath,
      fileSize: downloaded.bytes.length,
      ...(downloaded.durationSeconds !== undefined
        ? { durationMs: Math.round(downloaded.durationSeconds * 1000) }
        : {})
    })

    return downloaded.bytes
  }
}

/**
 * Coarse magnitude spectrum of a clip.
 *
 * Deliberately NOT an FFT: this runs on the whole recording (hundreds of
 * thousands of samples) on the main thread, and an O(n log n) transform over
 * that would be pointless work for a 256-bin summary panel. A windowed RMS
 * sweep gives the same visual answer — where the energy sits — for a fraction of
 * the cost, and it cannot produce the spectral-leakage artefacts that make a
 * naive FFT plot of non-stationary audio look alarming.
 *
 * The returned values are normalised to 0..1.
 */
export function computeMagnitudeSpectrum(samples: Float32Array, bins: number): number[] {
  if (samples.length === 0 || bins <= 0) return new Array(Math.max(0, bins)).fill(0)

  const output = new Array<number>(bins).fill(0)
  const bucketSize = Math.floor(samples.length / bins) || 1

  let maximum = 0

  for (let bin = 0; bin < bins; bin += 1) {
    const start = bin * bucketSize
    const end = Math.min(samples.length, start + bucketSize)
    if (start >= end) break

    // RMS within the bucket. Averaging magnitudes instead would over-weight
    // isolated spikes and understate sustained tones.
    let sumSquares = 0
    for (let index = start; index < end; index += 1) {
      const value = samples[index] as number
      sumSquares += value * value
    }
    const rms = Math.sqrt(sumSquares / (end - start))
    output[bin] = rms
    if (rms > maximum) maximum = rms
  }

  if (maximum > 0) {
    for (let bin = 0; bin < bins; bin += 1) {
      // Divide by 32768-style scaling is unnecessary: normalising to the clip's
      // own peak makes the shape readable regardless of how loud the recording is.
      output[bin] = (output[bin] as number) / maximum
    }
  }

  return output
}
