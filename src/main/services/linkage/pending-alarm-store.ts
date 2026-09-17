/**
 * 待处理告警（「提示」的持久化形态）。
 *
 * ---------------------------------------------------------------------------
 * 为什么它必须是主进程的一份**列表**而不是一次事件推送
 * ---------------------------------------------------------------------------
 * 产品要求「提示」要能在导航之后仍然看得见。一次事件推送做不到这一点：
 * 操作员从监控页切到录像页，组件卸载、订阅释放，那条提示就永远消失了。
 * 所以真相是一份**带确认状态的列表**，落在应用数据目录里：
 *
 *   - 界面可以在任何时刻（包括刚刷新页面）读到完整列表；
 *   - 一条告警被确认之前一直在那儿，不依赖任何一次推送是否被收到；
 *   - 进程重启后仍然在（一份「已确认」的审计痕迹也就此保住）。
 *
 * 上限与丢弃都是**明示**的：超出 `capacity` 时丢最旧的、并把丢弃条数累计到
 * `dropped` 里，界面据此显示「有 N 条更早的告警因超出上限被丢弃」。
 * 静默丢弃会让人以为没发生过——那是这套功能里最不能接受的一种失败。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type {
  PendingAlarmRecord,
  PendingAlarmSnapshot,
  LinkageMetrics,
  LinkageTriggerSourceKind,
  LinkageActionRecord
} from '@shared/domain/alarm-linkage'
import { appLog } from '../logging/logger'

/** 落盘的结构。`version` 让将来的格式变化可以被认出来而不是被误读。 */
interface PendingFile {
  version: 1
  dropped: number
  items: PendingAlarmRecord[]
}

export interface PendingAlarmStoreOptions {
  /** 应用数据目录；文件写在 `<dir>/linkage/pending-alarms.json`。 */
  directory: string
  /** 保留上限；调用方每次从设置里读，所以改设置立即生效。 */
  capacity: () => number
  now?: () => number
}

/** 新增一条告警所需的全部内容（动作结果之后会被补上）。 */
export interface PendingAlarmInput {
  eventId: string
  deviceId: string
  deviceName: string
  /** 事件发生时刻。 */
  at: number
  observedAt: number
  source: LinkageTriggerSourceKind
  alarmLevelRaw?: number
  strategyId?: number
  metrics?: LinkageMetrics
}

export class PendingAlarmStore extends EventEmitter {
  private readonly file: string
  private readonly capacity: () => number
  private readonly now: () => number
  private items: PendingAlarmRecord[] = []
  private dropped = 0
  private loaded = false
  /** 落盘是串行的：两次并发写同一个文件会得到半截 JSON。 */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(options: PendingAlarmStoreOptions) {
    super()
    this.file = path.join(options.directory, 'linkage', 'pending-alarms.json')
    this.capacity = options.capacity
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 订阅列表变化（`main/index.ts` 据此把快照推给渲染层）。
   *
   * 每个变更点在改完之后 `emit('changed', snapshot)`，**带上快照本身**：
   * 监听者不需要再回读一次，也就不会读到两次变更之间的中间态。
   */
  onChange(listener: (snapshot: PendingAlarmSnapshot) => void): () => void {
    this.on('changed', listener)
    return () => {
      this.off('changed', listener)
    }
  }

  private notify(): void {
    this.emit('changed', this.snapshot())
  }

  /** 从磁盘恢复。失败只是「从空列表开始」，绝不阻断启动。 */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as PendingFile
      if (parsed.version === 1 && Array.isArray(parsed.items)) {
        this.items = parsed.items.filter(isPendingRecord)
        this.dropped = Number.isFinite(parsed.dropped) ? parsed.dropped : 0
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        appLog().warn('待处理告警文件读取失败，从空列表开始', {
          file: this.file,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }
    this.notify()
  }

  snapshot(): PendingAlarmSnapshot {
    return { items: this.items.map(cloneRecord), dropped: this.dropped }
  }

  /** 未确认条数，供界面角标使用。 */
  unacknowledgedCount(): number {
    return this.items.filter((item) => !item.acknowledged).length
  }

  find(eventId: string): PendingAlarmRecord | undefined {
    const found = this.items.find((item) => item.eventId === eventId)
    return found ? cloneRecord(found) : undefined
  }

  /**
   * 记入一条新告警。
   *
   * 幂等：同一个 `eventId` 已经存在时**更新**它（补上后到的动作结果），
   * 而不是插入第二条。这与引擎的事件身份去重是同一条规则的两个落点——
   * 轮询与 WebSocket 报同一个事件时，界面上只能出现一行。
   */
  upsert(input: PendingAlarmInput): PendingAlarmRecord {
    const existing = this.items.find((item) => item.eventId === input.eventId)
    if (existing) {
      // 只补空，不覆盖：后到的源不应该把先到的结论抹掉。
      if (existing.alarmLevelRaw === undefined && input.alarmLevelRaw !== undefined) {
        existing.alarmLevelRaw = input.alarmLevelRaw
      }
      if (existing.strategyId === undefined && input.strategyId !== undefined) {
        existing.strategyId = input.strategyId
      }
      if (existing.metrics === undefined && input.metrics !== undefined) {
        existing.metrics = { ...input.metrics }
      }
      void this.persist()
      this.notify()
      return cloneRecord(existing)
    }

    const record: PendingAlarmRecord = {
      eventId: input.eventId,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      at: input.at,
      observedAt: input.observedAt,
      source: input.source,
      actions: [],
      acknowledged: false
    }
    if (input.alarmLevelRaw !== undefined) record.alarmLevelRaw = input.alarmLevelRaw
    if (input.strategyId !== undefined) record.strategyId = input.strategyId
    if (input.metrics !== undefined) record.metrics = { ...input.metrics }

    this.items.push(record)
    this.trim()
    void this.persist()
    this.notify()
    return cloneRecord(record)
  }

  /** 把一条动作结果挂到对应的事件上；事件不存在时忽略（并返回 false）。 */
  recordAction(eventId: string, action: LinkageActionRecord): boolean {
    const record = this.items.find((item) => item.eventId === eventId)
    if (!record) return false
    record.actions = [
      ...record.actions.filter((item) => item.action !== action.action),
      { ...action }
    ]
    if (action.action === 'record' && action.status === 'success') {
      const recordingId = action.detail?.recordingId
      if (typeof recordingId === 'string') record.recordingId = recordingId
    }
    // 抓帧是弹窗/提示/邮件哪一路顺带产生的产物，任何一路成功都要留痕。
    const frame = action.detail?.frameRelativePath
    if (typeof frame === 'string') record.frameRelativePath = frame

    void this.persist()
    this.notify()
    return true
  }

  /**
   * 确认告警。`ids` 为空表示全部确认。
   * @returns 实际被改动的条数。
   */
  acknowledge(ids: readonly string[], acknowledged: boolean, at = this.now()): number {
    const target = ids.length === 0 ? undefined : new Set(ids)
    let changed = 0
    for (const item of this.items) {
      if (target && !target.has(item.eventId)) continue
      if (item.acknowledged === acknowledged) continue
      item.acknowledged = acknowledged
      if (acknowledged) item.acknowledgedAt = at
      else delete item.acknowledgedAt
      changed += 1
    }
    if (changed > 0) {
      void this.persist()
      this.notify()
    }
    return changed
  }

  /** 清空（测试与「全部清除」用）。 */
  clear(): void {
    this.items = []
    this.dropped = 0
    void this.persist()
    this.notify()
  }

  // -- 内部 ---------------------------------------------------------------

  /**
   * 超出上限时丢最旧的**已确认**记录，再丢最旧的未确认记录，并累计丢弃数。
   *
   * 优先丢已确认的：一条被操作员看过的告警，价值低于一条还没人看过的。
   */
  private trim(): void {
    const capacity = Math.max(1, this.capacity())
    let guard = this.items.length * 2 + 8
    while (this.items.length > capacity && guard-- > 0) {
      const index = this.items.findIndex((item) => item.acknowledged)
      const removeAt = index >= 0 ? index : 0
      this.items.splice(removeAt, 1)
      this.dropped += 1
    }
  }

  /** 原子落盘：先写临时文件再 rename，避免半个 JSON 留在盘上。 */
  private persist(): Promise<void> {
    const payload: PendingFile = { version: 1, dropped: this.dropped, items: this.items }
    this.writeChain = this.writeChain
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true })
        const temporary = `${this.file}.tmp`
        await fs.writeFile(temporary, JSON.stringify(payload), 'utf8')
        await fs.rename(temporary, this.file)
      })
      .catch((error: unknown) => {
        appLog().warn('待处理告警落盘失败', {
          file: this.file,
          reason: error instanceof Error ? error.message : String(error)
        })
      })
    return this.writeChain
  }
}

/** 从磁盘读回来的记录可能是旧版本或被手改过，这里做最小的形状校验。 */
function isPendingRecord(value: unknown): value is PendingAlarmRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Partial<PendingAlarmRecord>
  return (
    typeof record.eventId === 'string' &&
    typeof record.deviceId === 'string' &&
    typeof record.at === 'number' &&
    typeof record.observedAt === 'number' &&
    Array.isArray(record.actions)
  )
}

function cloneRecord(record: PendingAlarmRecord): PendingAlarmRecord {
  return {
    ...record,
    actions: record.actions.map((action) => ({ ...action })),
    ...(record.metrics ? { metrics: { ...record.metrics } } : {})
  }
}
