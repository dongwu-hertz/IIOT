/**
 * 连续录像器（RTSP 取流存储）—— 主进程里的那一层执行者。
 *
 * 一句话：**把相机的一路 RTSP 按时间切片、持续录成分片 MP4，并如实登记进录像表。**
 *
 * WHY THIS SHAPE（进程形状的边界，而不是"一堆内联在 MonitorView 里的逻辑"）
 * 业主 2026-09-26 要求"PC 存储池要和管理软件解耦"，而 7×24 连续录像最终应当由
 * **独立服务**承担（关掉管理软件就不该断录，见 `docs/STORAGE-DESIGN.md` §9.3）。
 * 所以这一层的全部状态与生命周期都收在**这一个类**里，外部只通过
 * `start/stop/status/tick` 四个动作与它打交道，依赖（子进程、时钟、目录、入库）
 * 全部从构造函数注入 —— 将来把它整体搬进独立进程时，**搬的是这个文件**，
 * 而不是在界面代码里找散落的 ffmpeg 调用。
 *
 * 三条容易写错、这里都按"宁可少登记也不撒谎"处理：
 *   1. **看门狗判的是"文件在长"**，不是"进程还在"：相机掉线时 ffmpeg 可以挂着不退，
 *      只判进程存活就永远不会重启（`recorderStalled()`）。
 *   2. **正在写的片段不登记**：时长与大小都还在变，登记它等于写一行假数据
 *      （`planRecorderRegistrations()` 的 `open`）。
 *   3. **重启后补登记**：断电/崩溃会留下已经写完但没入库的片段 —— 启动时扫目录补上，
 *      否则那些文件在盘上、界面里却看不到。
 *
 * 只读原则：本服务**只写** `video/<DEVICE_UID>/<YYYY>/<MM>/<DD>/` 下自己产出的片段，
 * 不删任何文件（删由存储服务的保留策略负责）。
 */

import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { FfmpegProcess } from '../media/ffmpeg'
import { deviceLog } from '../logging/logger'
import {
  normalizeSegmentSeconds,
  parseRecorderSegmentName,
  planRecorderRegistrations,
  recorderBackoffMs,
  recorderGrowthObserved,
  recorderNeedsDayRollover,
  recorderStalled,
  recorderDayKey,
  type RecorderFileSnapshot,
  type RecorderRegistration
} from '@shared/domain/recorder'
import {
  CAMERA_MEDIA_RECORDER_NAME_PATTERN,
  cameraMediaRelativeDirectory
} from '@shared/domain/camera-nvr'

/** 监督周期：看门狗与登记都按它走。2 秒既够灵敏，又不至于天天扫盘。 */
export const RECORDER_TICK_MS = 2_000

/** 一个设备的状态，推给界面用（界面只说这些事实，不自己猜）。 */
export interface RecorderStatus {
  deviceId: string
  deviceUid: string
  /** 是否被要求录制（配置位）。 */
  enabled: boolean
  /** `starting`（刚拉起） / `recording`（文件在长） / `waiting`（进程在但没数据） /
   *  `backoff`（断流后等待重连） / `stopped`。 */
  state: 'starting' | 'recording' | 'waiting' | 'backoff' | 'stopped'
  segmentSeconds: number
  /** 当前这一轮开始录的时刻。 */
  runStartedAt?: number
  /** 最近一次"文件变大"的时刻（`recording` 与 `waiting` 的差别就在它）。 */
  lastGrowthAt?: number
  /** 上一个已经写完并登记的片段。 */
  lastSegment?: { name: string; startMs: number; endMs: number; bytes: number }
  /** 已经登记的片段数（本次运行期间）。 */
  registeredCount: number
  /** 连续失败的次数（退避档位）。 */
  attempt: number
  /** 最近一次失败原因原话（给排障用，不修饰）。 */
  lastError?: string
}

export interface RecorderDeviceTarget {
  deviceId: string
  /** 稳定设备 UID（目录用它，和音频/手动录像同一套）。 */
  deviceUid: string
  rtspUrl: string
}

export interface RecorderSegmentRecord extends RecorderRegistration {
  deviceId: string
  deviceUid: string
  /** 相对存储根的路径（`video/<uid>/<YYYY>/<MM>/<DD>/<name>`）。 */
  relativePath: string
}

export interface RtspRecorderOptions {
  /** 存储根（闭包现读：换根是设置变更，不是重启）。 */
  getStorageRoot: () => string
  /** 拉起 ffmpeg（默认 `spawnFfmpeg`；探针可以换成假源）。 */
  spawn: (args: string[]) => FfmpegProcess
  /** 构造 ffmpeg 参数（默认 `buildRecorderArgs`；探针可替换为本地测试源）。 */
  buildArgs: (input: { rtspUrl: string; outputPattern: string; segmentSeconds: number }) => string[]
  /** 登记一个片段（幂等由实现负责：同一个文件名只入库一次）。 */
  registerSegment: (segment: RecorderSegmentRecord) => Promise<void> | void
  /** 已经登记过的文件名（补登记时用；同一个目录内判重）。 */
  listRegisteredNames: (deviceId: string, relativeDir: string) => Promise<readonly string[]>
  /** 时钟（注入以便单测）。 */
  now?: () => number
  /**
   * 是否自动跑监督定时器（默认 true）。
   *
   * 探针与单测把它关掉、自己调 `tick()` —— 让"什么时候检查一次"由调用方决定，
   * 测试里就不必等真实的 2 秒定时器，也不会出现定时器与断言抢跑。
   */
  autoTick?: boolean
  /** 监督周期（毫秒）。默认 `RECORDER_TICK_MS`。 */
  tickIntervalMs?: number
}

interface RecorderRun {
  target: RecorderDeviceTarget
  segmentSeconds: number
  /** 这一轮的目标目录（绝对 + 相对存储根）。 */
  absoluteDir: string
  relativeDir: string
  child?: FfmpegProcess
  startedAtMs: number
  lastBytes: number
  lastGrowthAtMs: number
  /**
   * 这一轮**有没有**观察到文件变大。
   *
   * 用来把"刚拉起、还没出数据"与"正在录"分开：只看"进程活着"就说 `recording`，
   * 正是这条功能最不能犯的错（界面显示在录，盘上什么都没有）。
   */
  growthObserved: boolean
  currentName?: string
  attempt: number
  registeredCount: number
  lastSegment?: RecorderStatus['lastSegment']
  lastError?: string
  /** 下一次允许拉起的时刻（退避）。 */
  nextAttemptAtMs: number
  timer?: NodeJS.Timeout
}

export class RtspRecorderService {
  private readonly runs = new Map<string, RecorderRun>()
  private readonly options: RtspRecorderOptions
  private readonly now: () => number
  private disposed = false

  constructor(options: RtspRecorderOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
  }

  /** 正在录的设备状态（界面的唯一事实来源）。 */
  status(): RecorderStatus[] {
    return [...this.runs.values()].map((run) => this.statusOf(run))
  }

  statusOfDevice(deviceId: string): RecorderStatus | undefined {
    const run = this.runs.get(deviceId)
    return run ? this.statusOf(run) : undefined
  }

  /**
   * 手动推进一次监督（`autoTick: false` 时由调用方驱动）。
   *
   * 公开是有意的：单测与探针需要"我说检查就检查"，而不是等真实的 2 秒定时器；
   * 定时器与断言抢跑会产生只在 CI 上偶尔出现的红。
   *
   * @returns 这个设备当前是否在录（false = 没这个设备，或已经停了）。
   */
  async tickDevice(deviceId: string): Promise<boolean> {
    const run = this.runs.get(deviceId)
    if (!run) return false
    await this.tick(run)
    return true
  }

  /**
   * 要求开始连续录制（幂等：已经在录的设备只更新地址/切片长度）。
   *
   * 拉起之前先把**已经写完但没登记的片段**补登记一次（崩溃恢复），这样即使上一次
   * 运行是被强杀的，那些片段也不会永远留在盘上没人知道。
   */
  async start(target: RecorderDeviceTarget, segmentSeconds: number): Promise<RecorderStatus> {
    if (this.disposed) throw new Error('录像器已释放')
    const seconds = normalizeSegmentSeconds(segmentSeconds)
    const existing = this.runs.get(target.deviceId)
    if (existing) {
      existing.target = target
      existing.segmentSeconds = seconds
      return this.statusOf(existing)
    }

    const startedAtMs = this.now()
    const run: RecorderRun = {
      target,
      segmentSeconds: seconds,
      absoluteDir: '',
      relativeDir: '',
      startedAtMs,
      lastBytes: 0,
      lastGrowthAtMs: startedAtMs,
      growthObserved: false,
      attempt: 0,
      registeredCount: 0,
      nextAttemptAtMs: startedAtMs
    }
    this.runs.set(target.deviceId, run)
    await this.prepareRun(run, startedAtMs)
    await this.recoverUnregistered(run)
    // 立刻拉起第一轮：等一个监督周期（最多 2 秒）才开始录，等于每次"开始录像"都丢两秒。
    this.spawnRun(run)
    this.schedule(run)
    deviceLog().info('Continuous recording requested', {
      deviceId: target.deviceId,
      segmentSeconds: seconds
    })
    return this.statusOf(run)
  }

  /** 停止连续录制（幂等）。返回停止前的状态，便于界面显示"最后一段是什么时候"。 */
  async stop(deviceId: string): Promise<RecorderStatus | undefined> {
    const run = this.runs.get(deviceId)
    if (!run) return undefined
    if (run.timer) clearInterval(run.timer)
    run.timer = undefined
    await this.killChild(run)
    // 停之前把已经写完的片段登记掉：否则最后那几分钟"在盘上但库里没有"。
    await this.sweep(run, { closeOpen: true })
    const status = this.statusOf(run)
    this.runs.delete(deviceId)
    deviceLog().info('Continuous recording stopped', {
      deviceId,
      registeredCount: status.registeredCount
    })
    return { ...status, enabled: false, state: 'stopped' }
  }

  /** 释放：停掉全部并清掉定时器（应用退出时调用）。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const deviceId of [...this.runs.keys()]) await this.stop(deviceId)
  }

  // -------------------------------------------------------------------------
  // 内部：一轮录像的生命周期
  // -------------------------------------------------------------------------

  /** 按"今天的日期"决定这一轮的目录（跨天换目录，见 recorderNeedsDayRollover）。 */
  private async prepareRun(run: RecorderRun, atMs: number): Promise<void> {
    const relativeDir = cameraMediaRelativeDirectory('video', run.target.deviceUid, atMs)
    const absoluteDir = path.join(this.options.getStorageRoot(), ...relativeDir.split('/'))
    await fs.mkdir(absoluteDir, { recursive: true })
    run.relativeDir = relativeDir
    run.absoluteDir = absoluteDir
    run.lastBytes = 0
    run.currentName = undefined
  }

  private schedule(run: RecorderRun): void {
    if (this.options.autoTick === false) return
    if (run.timer) clearInterval(run.timer)
    run.timer = setInterval(() => {
      void this.tick(run).catch((error: unknown) => {
        deviceLog().warn('Recorder tick failed', {
          deviceId: run.target.deviceId,
          reason: error instanceof Error ? error.message : String(error)
        })
      })
    }, this.options.tickIntervalMs ?? RECORDER_TICK_MS)
    run.timer.unref?.()
  }

  /**
   * 监督一拍。
   *
   * 顺序有讲究：**先看门狗/换天，再采样文件，最后登记**。反过来的话，一个已经卡住的
   * 进程会把"上一拍的文件没长"误判成"这一拍刚写好"，看门狗就永远不触发。
   */
  async tick(run: RecorderRun): Promise<void> {
    const now = this.now()

    if (run.child && recorderNeedsDayRollover(run.startedAtMs, now)) {
      // 跨天：片段目录按天分层，不重启就会把今天的片段写进昨天的目录。
      deviceLog().info('Recorder rolling over to a new day directory', {
        deviceId: run.target.deviceId,
        from: recorderDayKey(run.startedAtMs),
        to: recorderDayKey(now)
      })
      await this.restart(run, 'day-rollover')
      return
    }

    if (run.child) {
      const files = await this.listSegments(run)
      const newest = files[files.length - 1]
      if (newest) {
        run.currentName = newest.name
        if (recorderGrowthObserved({ previousBytes: run.lastBytes, currentBytes: newest.bytes })) {
          run.lastBytes = newest.bytes
          run.lastGrowthAtMs = now
          run.growthObserved = true
          // 有数据在长 = 这一轮是健康的：退避档位归零。
          run.attempt = 0
        }
      }
      if (recorderStalled({ nowMs: now, lastGrowthAtMs: run.lastGrowthAtMs })) {
        deviceLog().warn('Recorder stalled (process alive but no new bytes); restarting', {
          deviceId: run.target.deviceId,
          quietMs: now - run.lastGrowthAtMs
        })
        await this.restart(run, 'stalled')
        return
      }
    } else if (now >= run.nextAttemptAtMs) {
      this.spawnRun(run)
    }

    await this.sweep(run)
  }

  /** 拉一轮 ffmpeg。 */
  private spawnRun(run: RecorderRun): void {
    const pattern = path.join(run.absoluteDir, CAMERA_MEDIA_RECORDER_NAME_PATTERN)
    const args = this.options.buildArgs({
      rtspUrl: run.target.rtspUrl,
      outputPattern: pattern,
      segmentSeconds: run.segmentSeconds
    })
    try {
      run.child = this.options.spawn(args)
      const startedAtMs = this.now()
      run.startedAtMs = startedAtMs
      run.lastGrowthAtMs = startedAtMs
      run.lastBytes = 0
      run.growthObserved = false
      run.lastError = undefined
      deviceLog().info('Recorder started a capture process', {
        deviceId: run.target.deviceId,
        segmentSeconds: run.segmentSeconds,
        dir: run.relativeDir
      })
    } catch (error) {
      run.child = undefined
      this.fail(run, error)
    }
  }

  /** 停掉当前进程并按退避排下一轮；跨天换目录也走这里。 */
  private async restart(run: RecorderRun, reason: 'day-rollover' | 'stalled'): Promise<void> {
    await this.killChild(run)
    // 刚杀掉写入者：这一轮最后那个文件已经写完，先登记掉再换目录，否则它会被落下
    // （跨天时尤其明显：目录一换，那个文件就再也没有机会被扫到了）。
    await this.sweep(run, { closeOpen: true })
    if (reason === 'stalled') {
      run.attempt += 1
      run.nextAttemptAtMs = this.now() + recorderBackoffMs(run.attempt)
    } else {
      run.nextAttemptAtMs = this.now()
    }
    await this.prepareRun(run, this.now())
    if (reason === 'day-rollover') this.spawnRun(run)
  }

  /** 记录一次失败并按退避排下一轮（进程没起来 / 立刻退出）。 */
  private fail(run: RecorderRun, error: unknown): void {
    run.attempt += 1
    run.nextAttemptAtMs = this.now() + recorderBackoffMs(run.attempt)
    run.lastError = error instanceof Error ? error.message : String(error)
    deviceLog().warn('Recorder capture process failed; will retry', {
      deviceId: run.target.deviceId,
      attempt: run.attempt,
      retryInMs: run.nextAttemptAtMs - this.now(),
      reason: run.lastError
    })
  }

  private async killChild(run: RecorderRun): Promise<void> {
    const child = run.child
    run.child = undefined
    if (!child) return
    try {
      // `FfmpegProcess.kill()` 是幂等的 SIGKILL（Windows 上就是 TerminateProcess）：
      // 分片 MP4 的 `moov` 写在每片开头，所以被杀掉不会留下打不开的文件。
      child.kill()
    } catch (error) {
      deviceLog().debug('Recorder process stop threw', {
        deviceId: run.target.deviceId,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  // -------------------------------------------------------------------------
  // 内部：盘上有什么、该登记什么
  // -------------------------------------------------------------------------

  /** 列出这一轮目录里本录像器产出的片段（按时间升序，带字节数与 mtime）。 */
  private async listSegments(run: RecorderRun): Promise<RecorderFileSnapshot[]> {
    let names: string[]
    try {
      names = await fs.readdir(run.absoluteDir)
    } catch {
      return []
    }
    const snapshots: RecorderFileSnapshot[] = []
    for (const name of names) {
      if (parseRecorderSegmentName(name) === undefined) continue
      try {
        const stat = await fs.stat(path.join(run.absoluteDir, name))
        if (!stat.isFile()) continue
        snapshots.push({ name, bytes: stat.size, mtimeMs: stat.mtimeMs })
      } catch {
        // 文件在扫描过程中被删/被改：跳过，下一拍再看。
      }
    }
    return snapshots.sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * 把"已经写完但没登记"的片段补进库（正常运行时是每一拍登记上一段）。
   *
   * @param closeOpen 我们**刚刚亲手杀掉了写入者**（停止 / 重启 / 跨天）时置 true：
   *   那一刻最新的那个文件已经不会再长了，如果还按"可能还在写"跳过它，最后这几分钟
   *   就会永远留在盘上、库里没有 —— 实测就是这么漏掉 stop() 前的最后一片的。
   */
  private async sweep(run: RecorderRun, options: { closeOpen?: boolean } = {}): Promise<void> {
    const files = await this.listSegments(run)
    if (files.length === 0) return
    const registered = await this.options.listRegisteredNames(run.target.deviceId, run.relativeDir)
    const plan = planRecorderRegistrations({
      files,
      registered,
      nowMs: this.now(),
      segmentSeconds: run.segmentSeconds,
      ...(options.closeOpen === true ? { closedGraceMs: 0 } : {})
    })
    for (const segment of plan.closed) {
      const record: RecorderSegmentRecord = {
        ...segment,
        deviceId: run.target.deviceId,
        deviceUid: run.target.deviceUid,
        relativePath: `${run.relativeDir}/${segment.name}`
      }
      try {
        await this.options.registerSegment(record)
        run.registeredCount += 1
        run.lastSegment = {
          name: segment.name,
          startMs: segment.startMs,
          endMs: segment.endMs,
          bytes: segment.bytes
        }
      } catch (error) {
        deviceLog().warn('Failed to register a recorder segment', {
          deviceId: run.target.deviceId,
          name: segment.name,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }
    if (plan.rejected.length > 0) {
      deviceLog().debug('Recorder segments skipped', {
        deviceId: run.target.deviceId,
        rejected: plan.rejected.slice(0, 5),
        total: plan.rejected.length
      })
    }
  }

  /**
   * 崩溃恢复：把最近两天（今天与昨天）目录里没登记的片段补上。
   *
   * 只扫两天：更早的目录按保留策略随时会被清掉，扫它们既慢又没有意义
   * （真正久远的漏登记属于运维动作，不该在启动路径上做）。
   */
  private async recoverUnregistered(run: RecorderRun): Promise<void> {
    const now = this.now()
    const candidateDays = [now, now - 24 * 60 * 60 * 1000]
    const seen = new Set<string>()
    for (const at of candidateDays) {
      const relativeDir = cameraMediaRelativeDirectory('video', run.target.deviceUid, at)
      if (seen.has(relativeDir)) continue
      seen.add(relativeDir)
      const absoluteDir = path.join(this.options.getStorageRoot(), ...relativeDir.split('/'))
      const probe: RecorderRun = { ...run, absoluteDir, relativeDir }
      const files = await this.listSegments(probe)
      if (files.length === 0) continue
      const registered = await this.options.listRegisteredNames(run.target.deviceId, relativeDir)
      const plan = planRecorderRegistrations({
        files,
        registered,
        nowMs: now,
        segmentSeconds: run.segmentSeconds,
        /*
         * 崩溃恢复时**一律按"已关闭"处理**（grace = 0）：写这些文件的进程已经不存在了
         * （上一次运行被强杀/断电，或应用刚启动），所以最后那一片也早就写完了。
         * 按"可能还在写"跳过它，它就会永远留在盘上、界面里看不到 —— 而这条功能的意义
         * 正是"录下来的东西要能被找到"。
         */
        closedGraceMs: 0
      })
      for (const segment of plan.closed) {
        try {
          await this.options.registerSegment({
            ...segment,
            deviceId: run.target.deviceId,
            deviceUid: run.target.deviceUid,
            relativePath: `${relativeDir}/${segment.name}`
          })
          run.registeredCount += 1
          deviceLog().info('Recovered an unregistered recorder segment', {
            deviceId: run.target.deviceId,
            name: segment.name,
            startMs: segment.startMs
          })
        } catch (error) {
          deviceLog().warn('Failed to recover a recorder segment', {
            deviceId: run.target.deviceId,
            name: segment.name,
            reason: error instanceof Error ? error.message : String(error)
          })
        }
      }
    }
  }

  private statusOf(run: RecorderRun): RecorderStatus {
    const now = this.now()
    const state: RecorderStatus['state'] = !run.child
      ? now < run.nextAttemptAtMs
        ? 'backoff'
        : 'starting'
      : recorderStalled({ nowMs: now, lastGrowthAtMs: run.lastGrowthAtMs })
        ? 'waiting'
        : run.growthObserved
          ? 'recording'
          : 'starting'
    return {
      deviceId: run.target.deviceId,
      deviceUid: run.target.deviceUid,
      enabled: true,
      state,
      segmentSeconds: run.segmentSeconds,
      runStartedAt: run.startedAtMs,
      lastGrowthAt: run.lastGrowthAtMs,
      registeredCount: run.registeredCount,
      attempt: run.attempt,
      ...(run.lastSegment ? { lastSegment: run.lastSegment } : {}),
      ...(run.lastError ? { lastError: run.lastError } : {})
    }
  }
}
