/**
 * 触发源 1（**主源**）：轮询 `GET /detect_logs`（手册 §5.1.17）。
 *
 * ---------------------------------------------------------------------------
 * 为什么这是主源而不是 WebSocket
 * ---------------------------------------------------------------------------
 * `/detectFeedback` 是事件流，而真机上从未观察到它的帧（见
 * `shared/domain/fa371-stream.ts` 的实测列：6 秒 0 帧；2026-09-15 又用 9 秒窗口
 * 复测，仍然 0 帧——那次探测还证实了一件事：**握手无需认证即成功**，
 * 所以「连不上」不是原因，「设备根本不推」才是）。
 * 轮询 `/detect_logs` 是**实测存在**的接口，今天就能产生事件，所以它是主源。
 *
 * ---------------------------------------------------------------------------
 * 游标：它到底是什么，以及三种边界情况怎么处理
 * ---------------------------------------------------------------------------
 * 游标 = 「我已经处理过的最大日志编号」以及「那个编号对应的检测开始时刻」。
 * 身份（`deviceId:logId:startTime`）由这个游标与每条日志拼出来，
 * 因此**轮询与 WebSocket 报同一个检测结果时得到同一个身份**，引擎那一层去重。
 *
 * 三种边界情况，每一种都有明确的、写在代码里的行为：
 *
 *   1. **首次运行（没有游标）。** 不产生任何触发，只把当前日志里的最大编号
 *      记成基线，并写一条日志说明。理由：设备上可能已经存着最近 100 次检测
 *      （§8.5 E11），在第一次启动时对全部历史记录各发一封邮件、各录一段像，
 *      是这套功能能犯的最严重的错误。
 *
 *   2. **重启（有游标）。** 只报比游标新的。游标还存在应用数据目录里，
 *      因此「同一个事件在重启后被重放」不会发生——这同时是引擎去重表之外
 *      的第二道保险（去重表在内存里，重启就没了）。
 *
 *   3. **日志轮转造成的空洞。** 设备只保留最近 100 条，超出就删最早的。
 *      如果游标编号已经不在这一批日志里，说明中间有检测记录被设备删掉了：
 *      这一批里的所有日志都按新事件处理（宁可多报，不可漏报），
 *      但**在日志里明确写出这是一个空洞**，带上游标编号与本批最大编号。
 *      `PollTickResult.gap` 把这个事实交给调用方，测试直接断言它。
 *
 * 第三条里「宁可多报」的代价由引擎的冷却与频率上限吸收：一个 200 条的突发
 * 不会变成 200 封邮件，而是会被限流并逐条记日志。
 */

import type { Device } from '@shared/domain/models'
import type { Fa371DetectLog } from '@shared/domain/fa371'
import { linkAgeEventIdentity, type LinkageTriggerSourceKind } from '@shared/domain/alarm-linkage'
import { resolveDischargeTypeKey } from '@shared/domain/fa371'
import type { Fa371ApiClient } from '../device/fa371/fa371-api-client'
import { appLog, deviceLog } from '../logging/logger'
import type { LinkageCandidate, LinkageTriggerSource } from './alarm-linkage-engine'

// ---------------------------------------------------------------------------
// 游标
// ---------------------------------------------------------------------------

/** 一台设备的轮询游标。 */
export interface PollCursor {
  /** 已处理过的最大日志编号；`undefined` = 还没建立基线。 */
  logId?: number
  /** 那个编号对应的检测开始时刻（原始未换算）。 */
  startTime?: number
  /** 建立/推进游标的时刻（诊断用）。 */
  updatedAt: number
}

/** 游标的持久化接口；实现由组合根提供（写应用数据目录里的一个 JSON）。 */
export interface PollCursorStore {
  load(deviceId: string): PollCursor | undefined
  save(deviceId: string, cursor: PollCursor): void
}

/** 内存实现：测试与「宁可重放也不要坏文件」的场景用。 */
export class MemoryPollCursorStore implements PollCursorStore {
  private readonly cursors = new Map<string, PollCursor>()

  load(deviceId: string): PollCursor | undefined {
    const cursor = this.cursors.get(deviceId)
    return cursor ? { ...cursor } : undefined
  }

  save(deviceId: string, cursor: PollCursor): void {
    this.cursors.set(deviceId, { ...cursor })
  }
}

// ---------------------------------------------------------------------------
// 轮询结果（纯数据，测试直接断言）
// ---------------------------------------------------------------------------

/** 一次轮询的结论。 */
export interface PollTickResult {
  /** 本次要报出去的候选事件（已按编号升序）。 */
  candidates: LinkageCandidate[]
  /** 本次是否检测到日志轮转造成的空洞。 */
  gap: boolean
  /** 本次是不是「首次建立基线」（没有产生候选）。 */
  baselineEstablished: boolean
  /** 设备返回的日志条数（诊断用）。 */
  fetched: number
  /** 更新后的游标。 */
  cursor: PollCursor
}

/** 从设备读一批日志的最小接口（注入以便测试完全不碰网络）。 */
export interface PollLogsFetcher {
  (deviceId: string): Promise<Fa371DetectLog[]>
}

export interface DetectLogsPollSourceOptions {
  /** 参与轮询的设备；每次 tick 重新读，所以设备增删立即生效。 */
  devices: () => Array<Pick<Device, 'id' | 'name' | 'kind'>>
  /** 取一批日志。 */
  fetchLogs: PollLogsFetcher
  /**
   * 轮询间隔（毫秒）。
   *
   * 是一个函数而不是数字：设置页改了间隔之后不需要重建源。
   */
  intervalMs: () => number
  cursors: PollCursorStore
  /** 时间源（测试用）。 */
  now?: () => number
  /** 定时器实现（测试用假定时器）。 */
  setIntervalImpl?: (handler: () => void, ms: number) => NodeJS.Timeout
  clearIntervalImpl?: (timer: NodeJS.Timeout) => void
  /** 每台设备的日志条数上限，防止一台设备返回异常大的数组。 */
  maxLogsPerTick?: number
  /**
   * 一次轮询的实现覆盖（测试用）。
   *
   * 入参是**设备记录**而不是设备 id：默认实现要用到 `name`（候选事件里要显示
   * 设备名）以及按设备族过滤的能力，只传 id 会逼着实现再回查一次数据库。
   */
  pollImpl?: (
    device: Pick<Device, 'id' | 'name'>,
    cursor: PollCursor | undefined,
    options: DetectLogsPollSourceOptions
  ) => Promise<PollTickResult>
}

const DEFAULT_MAX_LOGS = 500

/**
 * 轮询一个设备的 `/detect_logs`，推进游标，产出候选事件。
 *
 * 这是**纯逻辑 + 一次注入的读取**：没有定时器、没有 Electron、没有数据库，
 * 因此「新事件才报」「重启不重放」「轮转有空洞」三条都能被直接断言。
 */
export async function pollDetectLogs(
  device: Pick<Device, 'id' | 'name'>,
  cursor: PollCursor | undefined,
  options: DetectLogsPollSourceOptions
): Promise<PollTickResult> {
  const now = (options.now ?? (() => Date.now()))()
  const logs = await options.fetchLogs(device.id)
  const maxLogs = options.maxLogsPerTick ?? DEFAULT_MAX_LOGS
  const bounded = logs.slice(0, maxLogs)

  // 没有编号的日志无法参与去重（身份会退化成 `-`，多条互相撞车），
  // 所以它们被跳过并单独计数，而不是硬塞进事件流。
  const identified = bounded.filter(
    (log): log is Fa371DetectLog & { id: number } => typeof log.id === 'number' && Number.isFinite(log.id)
  )
  const skipped = bounded.length - identified.length

  const sorted = [...identified].sort((left, right) => left.id - right.id)
  const newest = sorted[sorted.length - 1]

  // 情况 1：首次运行，只建立基线。
  if (!cursor || cursor.logId === undefined) {
    const result: PollTickResult = {
      candidates: [],
      gap: false,
      baselineEstablished: true,
      fetched: bounded.length,
      cursor: {
        updatedAt: now,
        ...(newest ? { logId: newest.id, ...startTimeOfLog(newest) } : {})
      }
    }
    deviceLog().info('FA371 轮询：已建立检测日志基线（不对历史记录联动）', {
      deviceId: device.id,
      fetched: bounded.length,
      baselineLogId: newest?.id ?? null,
      skippedWithoutId: skipped
    })
    return result
  }

  const cursorId = cursor.logId

  // 情况 3：游标编号不在这一批里 -> 设备删掉了中间的记录。
  const cursorPresent = sorted.some((log) => log.id === cursorId)
  const fresh = sorted.filter((log) => log.id > cursorId)
  const gap = !cursorPresent && fresh.length > 0

  const candidates = fresh.map((log) => toCandidate(device, log, 'poll', now))

  if (gap) {
    deviceLog().warn('FA371 轮询：检测日志出现空洞（设备只保留最近 100 条），已按新事件处理', {
      deviceId: device.id,
      cursorLogId: cursorId,
      oldestInBatch: sorted[0]?.id ?? null,
      newestInBatch: newest?.id ?? null,
      recovered: candidates.length
    })
  }

  if (skipped > 0) {
    deviceLog().warn('FA371 轮询：部分检测日志没有 id，无法去重，已跳过', {
      deviceId: device.id,
      skipped
    })
  }

  return {
    candidates,
    gap,
    baselineEstablished: false,
    fetched: bounded.length,
    cursor: {
      updatedAt: now,
      ...(newest
        ? { logId: newest.id, ...startTimeOfLog(newest) }
        : { logId: cursorId, ...startTimeOfCursor(cursor) })
    }
  }
}

/** 由一条映射后的日志产出候选事件。 */
export function toCandidate(
  device: Pick<Device, 'id' | 'name'>,
  log: Fa371DetectLog,
  source: LinkageTriggerSourceKind,
  observedAt: number
): LinkageCandidate {
  const identity = linkAgeEventIdentity(device.id, log.id, log.startTimeRaw)
  const candidate: LinkageCandidate = {
    source,
    deviceId: device.id,
    deviceName: device.name,
    identity,
    // 有原始开始时刻就用它当「事件时刻」；没有就退回观察时刻（并如实如此）。
    at: log.startTime !== undefined ? log.startTime : log.startTimeRaw !== undefined ? log.startTimeRaw * 1000 : observedAt,
    observedAt
  }
  if (log.isAlarm !== undefined) candidate.alarmFlag = log.isAlarm
  if (log.alarmLevelRaw !== undefined) candidate.alarmLevelRaw = log.alarmLevelRaw
  if (log.alarmStrategyId !== undefined) candidate.strategyId = log.alarmStrategyId
  // 相机自己的判定语义（2026-09-23 真机字段实测）：模式与放电类型如实携带。
  // 放电分类的最终口径：概率字段优先于笼统的 discharge_type=4（`resolveDischargeTypeKey`）。
  // 泄漏量/泄漏价格（data_1/data_2）在局放/机械记录里只是占位零值——模式**明确不是
  // 泄漏**时不携带；模式未知（老固件可能不回 detect_mode）则保留，不丢真实数据。
  if (log.detectMode !== undefined) candidate.detectMode = log.detectMode
  const dischargeTypeKey = resolveDischargeTypeKey(log)
  if (dischargeTypeKey !== undefined) candidate.dischargeTypeKey = dischargeTypeKey

  const metrics: { soundmapIntensity?: number; leakVolume?: number; leakCost?: number; alarmDb?: number; alarmDf?: number } = {}
  if (log.soundmapIntensity !== undefined) metrics.soundmapIntensity = log.soundmapIntensity
  if (log.leakVolume !== undefined && (log.detectMode === undefined || log.detectMode === 2)) metrics.leakVolume = log.leakVolume
  if (log.leakCost !== undefined && (log.detectMode === undefined || log.detectMode === 2)) metrics.leakCost = log.leakCost
  if (log.lastAlarmDb !== undefined) metrics.alarmDb = log.lastAlarmDb
  if (log.lastAlarmDf !== undefined) metrics.alarmDf = log.lastAlarmDf
  if (Object.keys(metrics).length > 0) candidate.metrics = metrics

  return candidate
}

/**
 * 一条日志或一个游标里的「检测开始时刻」。
 *
 * 两种形状分开处理而不是用 `in` 收窄：`in` 在联合类型上会把两个分支都算进去
 * （`PollCursor` 里也有可选的 `startTime`），合并后的类型反而不认 `startTime`。
 */
function startTimeOfLog(log: Pick<Fa371DetectLog, 'startTimeRaw'>): { startTime?: number } {
  return log.startTimeRaw !== undefined ? { startTime: log.startTimeRaw } : {}
}

function startTimeOfCursor(cursor: Pick<PollCursor, 'startTime'>): { startTime?: number } {
  return cursor.startTime !== undefined ? { startTime: cursor.startTime } : {}
}

// ---------------------------------------------------------------------------
// 触发源实现
// ---------------------------------------------------------------------------

export class DetectLogsPollSource implements LinkageTriggerSource {
  readonly kind: LinkageTriggerSourceKind = 'poll'

  private readonly options: DetectLogsPollSourceOptions
  private timer: NodeJS.Timeout | undefined
  private readonly listeners = new Set<(candidate: LinkageCandidate) => void>()
  private lastPollAt: number | undefined
  /**
   * 每台设备最近一次的失败原因。
   *
   * 按设备分开记，而不是只留一个「最后一次」：一台相机持续失败、另一台一直
   * 成功时，一个共享的字段会被成功的那台**覆盖掉**，于是设置页上什么都看不到
   * ——那正好是「设备不可达」最难发现的症状。
   */
  private readonly errors = new Map<string, string>()
  private triggers = 0
  /** 上一次实际使用的间隔，用于「设置改了要重建定时器」的判断。 */
  private currentIntervalMs = 0
  private disposed = false

  constructor(options: DetectLogsPollSourceOptions) {
    this.options = options
  }

  get deviceIds(): readonly string[] {
    return this.devices().map((device) => device.id)
  }

  onCandidate(listener: (candidate: LinkageCandidate) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  start(): void {
    if (this.disposed) return
    const interval = this.clampInterval(this.options.intervalMs())
    if (this.timer && this.currentIntervalMs === interval) return
    if (this.timer) this.stopTimer()

    this.currentIntervalMs = interval
    const setIntervalImpl = this.options.setIntervalImpl ?? setInterval
    this.timer = setIntervalImpl(() => {
      void this.tickAll()
    }, interval)
    // 一个待决的定时器不该把进程留住。
    this.timer.unref?.()
    deviceLog().info('FA371 轮询触发源已启动', { intervalMs: interval, devices: this.deviceIds })
  }

  stop(): void {
    this.stopTimer()
  }

  status(): { lastPollAt?: number; lastError?: string; triggers: number; frames: number; running: boolean } {
    const status: { lastPollAt?: number; lastError?: string; triggers: number; frames: number; running: boolean } = {
      triggers: this.triggers,
      // 轮询源没有帧的概念；如实给 0 而不是省略字段。
      frames: 0,
      running: this.timer !== undefined
    }
    if (this.lastPollAt !== undefined) status.lastPollAt = this.lastPollAt
    // 只报**当前仍然失败**的设备：任何一台成功就清掉它自己的那一条。
    const failed = [...this.errors.entries()]
    if (failed.length > 0) {
      status.lastError = failed.map(([deviceId, reason]) => `${deviceId}: ${reason}`).join(' | ')
    }
    return status
  }

  /** 立刻轮询一轮（设置页的「立即检查」与测试都走这条路）。 */
  async tickAll(): Promise<PollTickResult[]> {
    if (this.disposed) return []
    const poll = this.options.pollImpl ?? pollDetectLogs
    const results: PollTickResult[] = []
    for (const device of this.devices()) {
      try {
        const cursor = this.options.cursors.load(device.id)
        const result = await poll(device, cursor, this.options)
        this.options.cursors.save(device.id, result.cursor)
        this.lastPollAt = (this.options.now ?? (() => Date.now()))()
        // 这台设备恢复了：只清它自己那一条，别的设备的失败仍然报出来。
        this.errors.delete(device.id)
        results.push(result)
        if (result.candidates.length > 0) {
          this.triggers += result.candidates.length
          for (const candidate of result.candidates) {
            for (const listener of this.listeners) listener(candidate)
          }
        }
      } catch (error) {
        /**
         * 一台相机读不到日志**不能**让其它相机停摆，也不能让这一轮变成异常。
         * 原因原样记下来（**按设备分开记**，否则一台成功就会把另一台的失败
         * 盖掉），设置页的诊断面板直接显示它。
         */
        const reason = error instanceof Error ? error.message : String(error)
        this.errors.set(device.id, reason)
        this.lastPollAt = (this.options.now ?? (() => Date.now()))()
        appLog().warn('FA371 轮询失败', { deviceId: device.id, reason })
      }
    }
    return results
  }

  dispose(): void {
    this.disposed = true
    this.stopTimer()
    this.listeners.clear()
    this.errors.clear()
  }

  private devices(): Array<Pick<Device, 'id' | 'name' | 'kind'>> {
    const all = this.options.devices()
    // 只有声学相机有 `detect_logs`；声纹设备的调用会得到一个 HTML 页面
    // （见 `Fa371ApiClient.call` 的说明），所以这里先按设备族过滤。
    return all.filter((device) => device.kind === 'acousticCamera')
  }

  private stopTimer(): void {
    if (!this.timer) return
    const clear = this.options.clearIntervalImpl ?? clearInterval
    clear(this.timer)
    this.timer = undefined
  }

  /** 间隔下限 2 秒：轮询再密也不会让设备更快地产生新记录。 */
  private clampInterval(value: number): number {
    if (!Number.isFinite(value) || value < 2_000) return 2_000
    return Math.min(value, 3_600_000)
  }
}

// ---------------------------------------------------------------------------
// 生产用的一批日志读取器
// ---------------------------------------------------------------------------

/**
 * 由 `Fa371ApiClient` 读一批检测日志。
 *
 * 映射交给 `mappers.mapDetectLogs`（本文件不碰固件键名），
 * 时间戳单位刻意**不假设**：`mapDetectLogs` 只产出 `*Raw`，
 * 因此身份里的 `startTime` 永远是设备原样的值，跨源一致。
 */
export function createDetectLogsFetcher(
  clientFor: (deviceId: string) => Fa371ApiClient | undefined,
  mapLogs: (payload: unknown) => Fa371DetectLog[]
): PollLogsFetcher {
  return async (deviceId: string): Promise<Fa371DetectLog[]> => {
    const client = clientFor(deviceId)
    if (!client) return []
    const response = await client.getDetectLogs(1)
    return mapLogs(response)
  }
}
