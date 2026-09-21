/**
 * 相机 NVR 采集：**手动录像**（MP4）与**抓图**（JPEG）。
 *
 * ---------------------------------------------------------------------------
 * 为什么是主进程，而不是在渲染层抓 `<video>` 的画布
 * ---------------------------------------------------------------------------
 * 相机画面在渲染层是一个 `<video>` 指向本机回环 HTTP 的 MP4 字节流。用
 * `canvas.drawImage(video)` + `toDataURL()` 抓图看起来更省事，但：
 *   1. 该流没有 CORS 头（`rtsp-stream.ts` 明确不设，因为读字节本来就被禁止），
 *      画布会被标记为 tainted，`toDataURL()` 直接抛 SecurityError；
 *   2. 渲染层拿到的是**已经转封装过**的一路流，而录像需要的是原样的 H.264，
 *      再走一遍浏览器解码等于重新编码，画质与 CPU 都不划算；
 *   3. 渲染层 CSP 是 `connect-src 'none'`，它本来就不该能发起任何网络请求。
 * 所以在主进程里再起一个 ffmpeg，直接读相机 RTSP：
 *   录像 `-c:v copy`（不重新编码）→ MP4；
 *   抓图 `-frames:v 1` → JPEG。
 * 全程复用 `ffmpeg.ts` 的 `spawnFfmpeg`（唯一的子进程出口，注册表保证退出时
 * 不会被漏掉），本文件**不自己 spawn**。
 *
 * ---------------------------------------------------------------------------
 * 为什么写的是「分片 MP4」（frag_keyframe + empty_moov）
 * ---------------------------------------------------------------------------
 * `-c:v copy` 录到文件时，普通 MP4 的 `moov` 要等 ffmpeg 正常收尾才写出来；
 * 而 Windows 上 `child.kill()` 走的是 `TerminateProcess`，**没有任何办法**让
 * ffmpeg 在收到信号后从容收尾（`SIGTERM` 不是优雅退出，stdin 的 `q` 也用不上
 * ——`spawnFfmpeg` 的 stdin 是 `ignore`，这是刻意的）。
 * 于是选择：录像全程写**分片 MP4**——`moov` 在开头就写好，之后每个关键帧一个
 * `moof/mdat` 分片。这样在**任意时刻**被强杀，落盘的文件都已经是可播放的
 * MP4（含 `ftyp` + `moov`），而不是一个既没索引又自称完整的空壳。
 * 停止时仍然会：优雅尝试 → 兜底强杀 → **校验** `ftyp`/`moov`/体积，校验不过
 * 就删除文件并如实报错（见 `stop()` / `abort()`），绝不把空文件登记成录像。
 *
 * ---------------------------------------------------------------------------
 * 实测约束：**不要给 RTSP 输入加任何 timeout 参数**
 * ---------------------------------------------------------------------------
 * 本机这台 FA371（`rtsp://192.168.110.235:443/live`，服务端 ZLMediaKit）在
 * ffmpeg 的这份构建里，`-timeout` 会被当成 RTSP **listen** 模式：
 *   `-timeout 5000000 -i <url>`            -> Unable to open RTSP for listening
 *   `-rtsp_transport tcp -timeout … -i …`  -> 同上
 *   `-rtsp_transport tcp -i <url> …`       -> 正常出流
 * 所以下面的参数构造器**只有** `-rtsp_transport tcp`，谁也不要为了「让错误
 * 地址早点失败」而加超时参数。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { AppError, ErrorCodes } from '@shared/errors'
import { spawnFfmpeg, type FfmpegProcess } from './ffmpeg'
import { deviceLog } from '../logging/logger'
import type { RecordingRepository } from '../database/alarm-repository'
import type { StorageService } from '../storage/storage-service'

// ---------------------------------------------------------------------------
// 命令行（纯函数，测试直接断言）
// ---------------------------------------------------------------------------

/**
 * 手动录像：`-c:v copy` 写 MP4 文件（**不**走管道，也不重新编码）。
 *
 * `-an`：本文件是**视频**录像。相机码流里的音频轨若存在，复制它要额外处理
 * 容器/编码兼容，重新编码它又与「copy」的承诺矛盾；声音在另一条产品线上由
 * 声学通道录制，这里明确只留视频轨，行里的内容与录像内容才一致。
 */
export function buildManualRecordArgs(rtspUrl: string, filePath: string): string[] {
  return [
    '-rtsp_transport',
    'tcp',
    '-i',
    rtspUrl,
    '-an',
    '-c:v',
    'copy',
    '-f',
    'mp4',
    // 分片 MP4：`moov` 写在最前面，任意时刻被杀掉都是可播放的文件。
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    filePath
  ]
}

/** 抓图：从同一个 RTSP 源取**一帧**，编码成 JPEG。 */
export function buildSnapshotArgs(rtspUrl: string, filePath: string): string[] {
  return [
    '-rtsp_transport',
    'tcp',
    '-i',
    rtspUrl,
    '-frames:v',
    '1',
    // 2 = 高质量 JPEG（ffmpeg 的 qscale 越小越好，2 是常用的「近无损」档）。
    '-q:v',
    '2',
    '-f',
    'image2',
    // 目标文件是我们自己按时间戳新建的，`-y` 只影响同一毫秒内的重跑。
    '-y',
    filePath
  ]
}

// ---------------------------------------------------------------------------
// 落盘产物校验（纯 I/O，可注入路径直接断言）
// ---------------------------------------------------------------------------

export interface Mp4Probe {
  size: number
  hasFtyp: boolean
  hasMoov: boolean
  /** 三个条件同时成立才算「可以登记进录像表」。 */
  playable: boolean
}

/** 只在文件头尾各读这么多字节：分片 MP4 的 `moov` 在头，普通 MP4 在尾。 */
const PROBE_WINDOW_BYTES = 512 * 1024

/** `fs.open` 的返回类型，避免为 `FileHandle` 引入第二处 import。 */
type FileHandle = Awaited<ReturnType<typeof fs.open>>

async function readWindow(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  return buffer.subarray(0, bytesRead)
}

/**
 * 判断一个文件是不是**可播放的 MP4**。
 *
 * 只认字节，不信任「ffmpeg 退出码 0」：进程被杀、磁盘写满、输出目录不可写
 * 都可能留下一个 0 字节或只有半截 `ftyp` 的文件，而录像表一旦登记了它，
 * 用户点开就是坏文件。
 */
export async function probeMp4File(absolutePath: string): Promise<Mp4Probe> {
  let handle: FileHandle | undefined
  try {
    const stat = await fs.stat(absolutePath)
    const size = stat.size
    if (size === 0) return { size: 0, hasFtyp: false, hasMoov: false, playable: false }

    handle = await fs.open(absolutePath, 'r')
    const head = await readWindow(handle, 0, Math.min(PROBE_WINDOW_BYTES, size))
    // `ftyp` 必须出现在 MP4 的第一个 box 里（偏移 4 起），弱化匹配 "ftyp" 就够了。
    const hasFtyp = head.length >= 8 && head.subarray(4, 8).toString('ascii') === 'ftyp'
    let hasMoov = head.includes(Buffer.from('moov'))
    if (!hasMoov && size > head.length) {
      const tail = await readWindow(handle, Math.max(0, size - PROBE_WINDOW_BYTES), Math.min(PROBE_WINDOW_BYTES, size))
      hasMoov = tail.includes(Buffer.from('moov'))
    }
    return { size, hasFtyp, hasMoov, playable: hasFtyp && hasMoov }
  } catch {
    return { size: 0, hasFtyp: false, hasMoov: false, playable: false }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export interface JpegProbe {
  size: number
  hasSoi: boolean
  hasEoi: boolean
  complete: boolean
}

/** JPEG 的完整性：`FFD8` 开头、`FFD9` 结尾（后者足以证明这一帧写完了）。 */
export async function probeJpegFile(absolutePath: string): Promise<JpegProbe> {
  let handle: FileHandle | undefined
  try {
    const { size } = await fs.stat(absolutePath)
    if (size < 4) return { size, hasSoi: false, hasEoi: false, complete: false }
    handle = await fs.open(absolutePath, 'r')
    const head = await readWindow(handle, 0, 2)
    const tail = await readWindow(handle, size - 2, 2)
    const hasSoi = head[0] === 0xff && head[1] === 0xd8
    const hasEoi = tail[0] === 0xff && tail[1] === 0xd9
    return { size, hasSoi, hasEoi, complete: hasSoi && hasEoi }
  } catch {
    return { size: 0, hasSoi: false, hasEoi: false, complete: false }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

/** 当前可用的 RTSP 源；由 `RtspStreamService.currentSource()` 提供。 */
export interface CameraCaptureSource {
  /** **含口令**，只能交给 ffmpeg 或显式的管理员动作。 */
  url: string
  maskedUrl?: string
  candidateId?: string
  mode?: string
}

export interface CameraCaptureDevice {
  deviceUid: string
  name: string
}

export interface ActiveCameraRecording {
  deviceId: string
  startedAt: number
  absolutePath: string
  relativePath: string
  child: FfmpegProcess
  /** 已经走过一次收尾（stop() 或子进程自行退出），避免重复登记。 */
  finalised: boolean
  /** 子进程非预期退出时的诊断，收尾时如实上报。 */
  failureReason?: string
}

export interface CameraRecordingState {
  deviceId: string
  recording: boolean
  startedAt?: number
  relativePath?: string
}

export interface CameraRecordingResult {
  deviceId: string
  recordingId?: string
  relativePath: string
  durationMs: number
  fileSize: number
  /** 录像过程中码流断开时的诊断（此时文件仍然保留并已登记）。 */
  warning?: string
}

export interface CameraSnapshotResult {
  deviceId: string
  absolutePath: string
  relativePath: string
  bytes: number
  capturedAt: number
}

export interface CameraCaptureServiceOptions {
  storage: StorageService
  recordings: RecordingRepository
  /** 取当前可用 RTSP 源；返回 undefined 表示**现在不能录也不能抓**。 */
  resolveSource: (deviceId: string) => CameraCaptureSource | undefined
  /** 相机的稳定身份（目录名）与显示名。 */
  resolveDevice: (deviceId: string) => CameraCaptureDevice
  /** 可注入的 ffmpeg 启动器（测试用假实现，生产用真实实现）。 */
  spawn?: typeof spawnFfmpeg
  /** 可注入的存在性检查，用于「同名文件绝不覆盖」的序号选择。 */
  exists?: (absolutePath: string) => Promise<boolean>
  now?: () => number
}

/** 等待子进程退出的上限：超过就认为它不会自己退出了。 */
const EXIT_WAIT_MS = 8_000
/** 同一毫秒内的文件名冲突最多尝试这么多次。 */
const MAX_NAME_ATTEMPTS = 200

export class CameraCaptureService {
  private readonly storage: StorageService
  private readonly recordings: RecordingRepository
  private readonly resolveSource: (deviceId: string) => CameraCaptureSource | undefined
  private readonly resolveDevice: (deviceId: string) => CameraCaptureDevice
  private readonly spawnImpl: typeof spawnFfmpeg
  private readonly existsImpl: (absolutePath: string) => Promise<boolean>
  private readonly now: () => number

  /** 每台相机至多一路手动录像（相机侧的 `rtsp_client_limit` 是有限的）。 */
  private readonly active = new Map<string, ActiveCameraRecording>()
  private disposed = false

  constructor(options: CameraCaptureServiceOptions) {
    this.storage = options.storage
    this.recordings = options.recordings
    this.resolveSource = options.resolveSource
    this.resolveDevice = options.resolveDevice
    this.spawnImpl = options.spawn ?? spawnFfmpeg
    this.existsImpl = options.exists ?? defaultExists
    this.now = options.now ?? (() => Date.now())
  }

  /** 录像状态；不传 deviceId 时返回全部（供界面校准）。 */
  listState(deviceId?: string): CameraRecordingState[] {
    const ids = deviceId ? [deviceId] : [...this.active.keys()]
    return ids.map((id) => {
      const active = this.active.get(id)
      if (!active) return { deviceId: id, recording: false }
      return {
        deviceId: id,
        recording: true,
        startedAt: active.startedAt,
        relativePath: active.relativePath
      }
    })
  }

  isRecording(deviceId: string): boolean {
    return this.active.has(deviceId)
  }

  /**
   * 开始手动录像。
   *
   * 三种拒绝都是**如实**的，而不是静默失败：
   *   - 已经在录：再点一次不能变成两路（重复开始）；
   *   - 没有可用源：视频没在播放（相机未推流 / ffmpeg 未就绪）；
   *   - 磁盘写不下：`canRecord('manual')` 为 false 或剩余字节为 0。
   *     规格 14.4 说明手动录像**不因安全下限被自动删除**，但「真的没字节了」
   *     必须当场拒绝，而不是录出一个 0 字节文件再报成功。
   */
  async start(deviceId: string): Promise<CameraRecordingState> {
    if (this.disposed) throw new AppError(ErrorCodes.UNKNOWN, '相机采集服务已释放')
    if (this.active.has(deviceId)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '该相机已经在录像中，请先停止当前录像')
    }

    const source = this.resolveSource(deviceId)
    if (!source) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        '视频尚未开始播放，无法录像。请先点击「开始视频」，待画面出现后再录制。'
      )
    }

    if (!(await this.storage.canRecord('manual'))) {
      throw new AppError(
        ErrorCodes.DISK_FULL,
        '磁盘剩余空间低于安全下限，已拒绝开始手动录像',
        this.storage.root
      )
    }
    const usage = await this.storage.diskUsage()
    if (usage.freeBytes <= 0) {
      throw new AppError(ErrorCodes.DISK_FULL, '存储所在磁盘已无剩余空间，无法开始录像', usage.storageRoot)
    }

    const device = this.resolveDevice(deviceId)
    const startedAt = this.now()
    const target = await this.pickFreePath(deviceUid(device), 'video', startedAt, device.name)
    await fs.mkdir(path.dirname(target.absolutePath), { recursive: true })

    const args = buildManualRecordArgs(source.url, target.absolutePath)
    deviceLog().info('Camera NVR: manual recording started', {
      deviceId,
      candidate: source.candidateId ?? '(unknown)',
      mode: source.mode ?? '(unknown)',
      relativePath: target.relativePath
    })

    // `spawnFfmpeg` 在 ffmpeg 缺失时抛 AppError(NOT_IMPLEMENTED)——照原样向上，
    // 「内置转码组件不可用」必须是一句能被界面显示的诊断，而不是黑屏。
    const child = this.spawnImpl(args, { label: `camera-record:${deviceId}` })
    const active: ActiveCameraRecording = {
      deviceId,
      startedAt,
      absolutePath: target.absolutePath,
      relativePath: target.relativePath,
      child,
      finalised: false
    }
    this.active.set(deviceId, active)

    // 码流中途断掉时 ffmpeg 会自己退出。这时**不留下一个永远「录制中」的假状态**：
    // 立刻收尾，并把已经写下的（分片 MP4 保证可播放的）文件如实入库。
    void child.exited.then(({ code, signal }) => {
      if (active.finalised) return
      active.failureReason =
        `视频流在录像过程中结束（ffmpeg ${code === null ? `signal ${String(signal)}` : `退出码 ${code}`}）：` +
        `${lastLine(child.stderrTail()) || '无 stderr 输出'}`
      void this.finish(active).catch((error: unknown) => {
        deviceLog().error('Camera NVR: finalising an interrupted recording failed', {
          deviceId,
          reason: error instanceof Error ? error.message : String(error)
        })
      })
    })

    return this.listState(deviceId)[0] as CameraRecordingState
  }

  /**
   * 停止手动录像并登记。
   *
   * 停止顺序是刻意的：
   *   1. 杀子进程（Windows 上就是 `TerminateProcess`，所以文件靠分片 MP4 兜底）；
   *   2. **校验**产物（非空 + `ftyp` + `moov`）；
   *   3. 0 字节 → 删除文件并报错；文件可播放 → 登记录像行；
   * 绝不出现「登记了但打不开」或「空文件被当成录像」。
   */
  async stop(deviceId: string): Promise<CameraRecordingResult> {
    const active = this.active.get(deviceId)
    if (!active) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '该相机当前没有正在进行的录像')
    }
    return this.finish(active)
  }

  /** 抓图：一帧 JPEG 落盘，返回绝对路径（界面用它提示并「打开所在文件夹」）。 */
  async snapshot(deviceId: string): Promise<CameraSnapshotResult> {
    if (this.disposed) throw new AppError(ErrorCodes.UNKNOWN, '相机采集服务已释放')
    const source = this.resolveSource(deviceId)
    if (!source) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        '视频尚未开始播放，无法抓图。请先点击「开始视频」，待画面出现后再抓图。'
      )
    }

    const device = this.resolveDevice(deviceId)
    const capturedAt = this.now()
    const target = await this.pickFreePath(deviceUid(device), 'snapshot', capturedAt, device.name)
    await fs.mkdir(path.dirname(target.absolutePath), { recursive: true })

    const child = this.spawnImpl(buildSnapshotArgs(source.url, target.absolutePath), {
      label: `camera-snapshot:${deviceId}`
    })
    const { code, signal } = await withTimeout(child.exited, EXIT_WAIT_MS, () => child.kill())

    const probe = await probeJpegFile(target.absolutePath)
    if (!probe.complete) {
      // 没有画面 / 写盘失败 / 被杀在半路：删掉半截文件，然后如实说「没抓到」。
      await fs.unlink(target.absolutePath).catch(() => undefined)
      const tail = lastLine(child.stderrTail())
      throw new AppError(
        ErrorCodes.DEVICE_ERROR,
        `未能从视频流抓取到画面（ffmpeg ${
          code === null ? `signal ${String(signal)}` : `退出码 ${code}`
        }）：${tail || '没有产生任何图像数据'}`,
        target.relativePath
      )
    }

    deviceLog().info('Camera NVR: snapshot captured', {
      deviceId,
      bytes: probe.size,
      relativePath: target.relativePath
    })
    return {
      deviceId,
      absolutePath: target.absolutePath,
      relativePath: target.relativePath,
      bytes: probe.size,
      capturedAt
    }
  }

  /**
   * 应用退出：杀掉所有录像子进程，并**丢弃**没被正常停止的录像文件。
   *
   * 为什么是丢弃而不是登记：一次没有停止动作的录像，其时长/结尾状态是未知的。
   * 把它登记进录像表就等于声称「这是一段完整的录像」。宁可少一条记录，也不
   * 让用户在列表里点开一个半截文件。「不留孤儿 ffmpeg」由这里 +
   * `ffmpeg.killAllFfmpeg()` 双重保证。
   */
  abortAll(reason = '应用退出'): number {
    let aborted = 0
    for (const active of [...this.active.values()]) {
      active.finalised = true
      this.active.delete(active.deviceId)
      active.child.kill()
      aborted += 1
      // 删除是尽力而为：删不掉也不能让退出流程卡住。
      void fs.unlink(active.absolutePath).catch(() => undefined)
      deviceLog().warn('Camera NVR: recording aborted', {
        deviceId: active.deviceId,
        reason,
        discarded: active.relativePath
      })
    }
    return aborted
  }

  dispose(): void {
    if (this.disposed) return
    this.abortAll('服务释放')
    this.disposed = true
  }

  // -- 内部 ---------------------------------------------------------------

  /** 收尾：杀进程、校验、登记（或删除）。 */
  private async finish(active: ActiveCameraRecording): Promise<CameraRecordingResult> {
    const { deviceId } = active
    active.finalised = true
    this.active.delete(deviceId)

    active.child.kill()
    const { code, signal } = await withTimeout(active.child.exited, EXIT_WAIT_MS, () => active.child.kill())
    const durationMs = Math.max(0, this.now() - active.startedAt)
    const device = this.resolveDevice(deviceId)

    const probe = await probeMp4File(active.absolutePath)
    if (probe.size === 0 || !probe.playable) {
      await fs.unlink(active.absolutePath).catch(() => undefined)
      const tail = lastLine(active.child.stderrTail())
      deviceLog().error('Camera NVR: recording produced no playable file', {
        deviceId,
        bytes: probe.size,
        hasFtyp: probe.hasFtyp,
        hasMoov: probe.hasMoov,
        tail
      })
      throw new AppError(
        probe.size === 0 ? ErrorCodes.RECORDING_EMPTY : ErrorCodes.RECORDING_INCOMPLETE,
        probe.size === 0
          ? '录像文件为空（0 字节），已删除。请检查磁盘空间与相机码流后重试。'
          : `录像文件不完整（缺少 moov 索引，${probe.size} 字节），已删除。${
              tail || '视频流可能在录制过程中中断了。'
            }`,
        [active.relativePath, tail ? `ffmpeg: ${tail}` : ''].filter(Boolean).join(' · ')
      )
    }

    // 通过既有的 RecordingRepository 登记：录像列表里就会和音频录像一样出现一行。
    // `recordingType: 'manual'` 明确「人工触发」，因此 14.4 的保留策略不会自动删它。
    const recording = this.recordings.insertVideo({
      deviceId,
      channelId: 0,
      startTime: active.startedAt,
      endTime: this.now(),
      durationMs,
      relativePath: active.relativePath,
      fileSize: probe.size
    })

    deviceLog().info('Camera NVR: manual recording finished', {
      deviceId,
      recordingId: recording.id,
      deviceName: device.name,
      durationMs,
      fileSize: probe.size,
      ffmpegExit: code === null ? `signal ${String(signal)}` : code
    })

    const result: CameraRecordingResult = {
      deviceId,
      recordingId: recording.id,
      relativePath: active.relativePath,
      durationMs,
      fileSize: probe.size
    }
    if (active.failureReason !== undefined) result.warning = active.failureReason
    return result
  }

  /** 同一毫秒内的第二次录像/抓图不覆盖第一次：序号递增直到找到空位。 */
  private async pickFreePath(
    uid: string,
    kind: 'video' | 'snapshot',
    timestamp: number,
    label: string
  ): Promise<{ absolutePath: string; relativePath: string }> {
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
      const candidate = this.storage.cameraMediaPaths({
        deviceUid: uid,
        kind,
        timestamp,
        label,
        attempt
      })
      if (!(await this.existsImpl(candidate.absolutePath))) return candidate
    }
    throw new AppError(
      ErrorCodes.STORAGE_ERROR,
      '同一毫秒内同名文件过多，无法生成唯一的录像/抓图文件名',
      kind
    )
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

async function defaultExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath)
    return true
  } catch {
    return false
  }
}

function deviceUid(device: CameraCaptureDevice): string {
  // 目录身份用稳定 uid；设备还没有 uid 时退回显示名，与音频侧的做法一致。
  const uid = device.deviceUid.trim() !== '' ? device.deviceUid : device.name
  return uid
}

function lastLine(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  return lines[lines.length - 1]?.trim().slice(0, 200) ?? ''
}

/** 等一个 promise，超时就执行 `onTimeout`（用于「子进程不肯退出」的兜底）。 */
async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout()
          reject(new AppError(ErrorCodes.TIMEOUT, `相机采集子进程在 ${ms} ms 内没有退出`))
        }, ms)
        // 不能让一个待决的超时把进程留住。
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
