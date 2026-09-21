/**
 * `EventCenterService` —— 「事件与告警中心」的装配处。
 *
 * ---------------------------------------------------------------------------
 * 为什么合并发生在主进程，而且**不是**一条 SQL
 * ---------------------------------------------------------------------------
 * 三路来源有三个互不相干的所有者：
 *   - `deviceDetect`：设备 HTTP（`GET /detect_logs`），数据在任何本地表里都不存在；
 *   - `linkage`      ：主进程内存里的待处理列表（已落盘但只有引擎持有权威副本）；
 *   - `localAlarm`   ：本地 SQLite 的 `alarms` 表。
 *
 * 三者之中**只有本地表**能被 SQL 分页，而一个「按时间倒序的合并页」需要同时看到
 * 三路的同一段排序结果。把它写成一条 SQL 意味着把设备 HTTP 与内存列表先物化成
 * 表（或临时表），那既引入了写入时序问题（轮询设备比读表慢几个数量级），
 * 也让「设备离线」变成一条写失败而不是一种可展示的状态。
 *
 * 因此：每一路各自读一段**有上限**的候选，在这里合并、排序、过滤、分页。
 * 代价是每路的上限（`EVENT_CENTER_PER_SOURCE_HARD_CAP`）会带来截断，而截断
 * **必须说出来**：`EventCenterPage.truncated` 与每路的 `truncated` 计数就是它。
 *
 * ---------------------------------------------------------------------------
 * 诚实降级
 * ---------------------------------------------------------------------------
 * 一路来源失败（相机离线、SQLite 出错）时：
 *   - 另外两路照常渲染；
 *   - 失败以 `EventSourceStatus { ok: false, error }` 返回，**不**抛异常
 *     （抛异常会让整页空白，那是最糟的失败方式）；
 *   - 失败也**不**被吞掉：界面必须能把「这一路读不到」显示出来。
 */

import { AppError, ErrorCodes } from '@shared/errors'
import { appLog, deviceLog } from '../logging/logger'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { AlarmEvent, DeviceKind, Recording } from '@shared/domain/models'
import type { PendingAlarmRecord, PendingAlarmSnapshot } from '@shared/domain/alarm-linkage'
import type {
  EventAcknowledgePerSource,
  EventAcknowledgeResult,
  EventCenterEntry,
  EventCenterPage,
  EventCenterQuery,
  EventDetectDownloadInput,
  EventDetectDownloadResult,
  EventDetectDetail,
  EventDetectFile,
  EventDetectLibraryPage,
  EventDetectLogView,
  EventDownloadProgress,
  EventEvidenceImageInput,
  EventEvidenceImageView,
  EventMetrics,
  EventRecordingLookup,
  EventSourceKind,
  EventSourceStatus,
  EventStatus,
  EventAlarmLookup,
  EventDeviceStatusLookup,
  DeviceStatusEventLike
} from '@shared/domain/event-center'
import {
  allowedStatusTargets,
  canTransitionStatus,
  groupEvents,
  representativeOf,
  statusForAction
} from '@shared/domain/event-view'
import type {
  EventActivityView,
  EventStatusAction,
  EventStatusChangeResult
} from '@shared/domain/event-view'
import {
  INCIDENT_NOTE_MAX_LENGTH,
  INCIDENT_TITLE_MAX_LENGTH,
  type IncidentLinkView,
  type IncidentView,
  validateIncidentDraft
} from '@shared/domain/incident'
import {
  EVENT_CENTER_DEFAULT_LIMIT,
  EVENT_CENTER_MAX_GROUP_WINDOW_MS,
  EVENT_CENTER_MAX_LIMIT,
  EVENT_SOURCE_KINDS,
  deriveEventSeverity,
  deriveRecordingContainer,
  detectRemoteRecordingId,
  deviceDetectEntryId,
  deviceStatusEntryId,
  eventCenterPerSourceCap,
  eventEntryIdPayload,
  eventSourceFromEntryId,
  isEventSourceKind,
  linkageEntryId,
  localAlarmEntryId
} from '@shared/domain/event-center'

/** 事件中心需要的设备信息（只需读，不持有 `DeviceService`）。 */
export interface EventCenterDeviceRef {
  id: string
  name: string
  /** 只有 `acousticCamera` 才有检测库；非相机设备不会去读 `/detect_logs`。 */
  kind: DeviceKind
}

/** 相机检测库能力（`DetectLibraryService` 结构上满足它）。 */
export interface EventCenterDetectLibrary {
  list(deviceId: string, options?: { detectId?: number }): Promise<EventDetectLibraryPage>
  download(
    deviceId: string,
    input: EventDetectDownloadInput,
    onProgress?: (progress: EventDownloadProgress) => void
  ): Promise<EventDetectDownloadResult>
}

/** 本机联动引擎的待处理列表能力（`AlarmLinkageService` 结构上满足它）。 */
export interface EventCenterLinkageSource {
  pendingSnapshot(): PendingAlarmSnapshot
  acknowledge(ids: readonly string[]): PendingAlarmSnapshot
}

/**
 * 本机文件的回环端点能力（`VideoFileServer` 结构上满足它）。
 *
 * 接口写窄：事件中心只需要"给这一组图片开一个端点"这一件事，
 * 于是测试里给一个假实现就够（与 `E2DeviceService` 的同名接口同一条推理）。
 */
export interface EventCenterImageServer {
  serveImages(
    directory: string,
    names: readonly string[]
  ): Promise<{ files: Array<{ name: string; url: string }>; close: () => void }>
}

/** 存储根解析能力（`StorageService.resolve` 结构上满足它，内含越界保护）。 */
export interface EventCenterStorageResolver {
  resolve(storedPath: string): string
}

/**
 * 处置工作流仓储能力（`EventStatusRepository` 结构上满足它）。
 *
 * 接口写窄是刻意的：服务只需要"读当前状态 / 读流水 / 写一条变更"，
 * 测试里给一个内存假实现就够（`tests/event-center.test.ts` 就是这么做的）。
 */
export interface EventCenterStatusStore {
  statusMap(
    entryIds: readonly string[]
  ): Map<string, { entryId: string; status: EventStatus; assignee?: string; updatedAt: number }>
  activity(entryId: string, limit?: number): EventActivityView[]
  setStatus(input: {
    entryId: string
    entryIds?: readonly string[]
    status?: EventStatus
    assignee?: string
    fromStatus?: EventStatus
    actor: string
    note?: string
    at: number
  }): {
    row: { entryId: string; status: EventStatus; assignee?: string; updatedAt: number }
    activity: EventActivityView
    /** 一起被处置的条数（聚合组会大于 1）。 */
    appliedTo: number
  }
}

/**
 * Incident 仓储能力（`IncidentRepository` 结构上满足它，规格 §14.2 的 V1）。
 *
 * 与 `EventCenterStatusStore` 同一套做法：接口写窄 —— 服务只需要"建一个 / 挂几条 /
 * 摘一条 / 问一条 Alert 属于哪些"，测试里给内存假实现就够。
 */
export interface EventCenterIncidentStore {
  /** 建一个 Incident 并**一并**关联这几条 Alert（一个事务）。 */
  create(input: {
    title: string
    note?: string
    createdBy: string
    at: number
    entryIds?: readonly string[]
  }): { row: EventIncidentRecord; linked: number }
  /** 往一个已存在的 Incident 上挂几条（幂等）。Incident 不存在时抛。 */
  link(input: {
    incidentId: string
    entryIds: readonly string[]
    actor: string
    at: number
  }): { incidentId: string; linked: number; alreadyLinked: number }
  unlink(input: { incidentId: string; entryId: string }): boolean
  find(id: string): EventIncidentRecord | undefined
  list(limit?: number): EventIncidentRecord[]
  forEntry(entryId: string): EventIncidentRecord[]
  links(incidentId: string): IncidentLinkView[]
  alertCounts(incidentIds: readonly string[]): Map<string, number>
}

/** 一条 Incident 的库行（只列服务用得上的字段）。 */
export interface EventIncidentRecord {
  id: string
  title: string
  note?: string
  createdAt: number
  createdBy: string
  updatedAt: number
}

export interface EventCenterServiceOptions {
  listDevices(): EventCenterDeviceRef[]
  detectLibrary: EventCenterDetectLibrary
  linkage: EventCenterLinkageSource
  alarms: EventAlarmLookup
  /**
   * 设备上线 / 离线事件（业主追加的第四路来源，schema v17）。
   *
   * 可选注入：缺省是**空实现**（永远 0 条、确认 0 条）——事件中心照常工作，只是这一路
   * 没有数据。这样不接线存储的测试不必先造一张表（与 `detectLogLimit` 同一模式）。
   */
  deviceStatus?: EventDeviceStatusLookup
  recordings: EventRecordingLookup
  /** 图片证据的回环端点（详情抽屉的 Evidence 页签）。 */
  images: EventCenterImageServer
  /** 存储根解析（把库里的相对路径变回绝对路径，越界会抛）。 */
  storage: EventCenterStorageResolver
  /** 处置工作流（状态 + Activity，schema v13）。 */
  statuses: EventCenterStatusStore
  /** Incident 与它的关联（schema v14，规格 §14.2 的 V1）。 */
  incidents: EventCenterIncidentStore
  /**
   * 一台相机最多取回多少条检测日志。
   *
   * 手册没有给 `/detect_logs` 定义分页（§8.3 C14），所以设备可能一次返回很多条；
   * 这个上限保证一次页面查询不会把设备的整库拉进内存，超出部分计入截断。
   */
  detectLogLimit?: number
  now?: () => number
}

/** 默认的单台设备检测日志上限。 */
export const DEFAULT_DETECT_LOG_LIMIT = 200

export class EventCenterService {
  private readonly options: EventCenterServiceOptions
  private readonly now: () => number
  private readonly detectLogLimit: number
  /**
   * 当前打开的图片端点。
   *
   * 一次只留一个：抽屉同时只显示一条事件的证据，留着上一个端点只是让一个端口白挂
   * 到 TTL（30 分钟）。与 `E2DeviceService.snapshotHandle` 同一条做法。
   */
  private evidenceHandle: { close: () => void } | null = null

  constructor(options: EventCenterServiceOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
    this.detectLogLimit = options.detectLogLimit ?? DEFAULT_DETECT_LOG_LIMIT
  }

  // -------------------------------------------------------------------------
  // 图片证据（规格 §12.1 的 Visual）
  // -------------------------------------------------------------------------

  /**
   * 把一个存储根相对路径（或一条录像行）变成回环图片地址。
   *
   * 四道关，每一道都有它存在的理由：
   *   1. **路径从哪来**：优先 `recordingId`（库里的行是权威），否则用调用方给的相对路径。
   *      绝对路径不受理 —— 交给 `storage.resolve()` 的话它会被当成"根之下的绝对路径"，
   *      虽然也安全，但语义上是界面在猜本机布局，不该发生。
   *   2. **越界**：`storage.resolve()` 会拒绝 `..` 逃出存储根的路径并抛错。这里**接住**它
   *      并记一条 warn：路径越界是一次攻击尝试或者一次数据损坏，值得在设备日志里留痕，
   *      但界面上只需要知道"这张图取不到"。
   *   3. **文件在不在**：不在磁盘上就是 `files-gone`（换过存储根、被手工删掉），
   *      与"不是图片"是两件不同的事实。
   *   4. **是不是图片**：交给端点自己判断（`serveImages` 的白名单），
   *      免得这里有第二份扩展名表 —— 两份表迟早会分叉。
   */
  async evidenceImage(input: EventEvidenceImageInput): Promise<EventEvidenceImageView> {
    const relativePath = this.resolveEvidencePath(input)
    if (relativePath === undefined || relativePath.trim() === '') return { state: 'not-found' }

    let absolute: string
    try {
      absolute = this.options.storage.resolve(relativePath)
    } catch (error) {
      deviceLog().warn('事件中心：拒绝了一份取不到的证据路径', {
        relativePath,
        reason: describeError(error)
      })
      return { state: 'not-found' }
    }

    if (!existsSync(absolute) || !statSync(absolute).isFile()) return { state: 'files-gone' }

    // 上一组先关掉：端口与定时器都只该有一个。
    this.closeEvidenceImage()

    const directory = path.dirname(absolute)
    const name = path.basename(absolute)
    let handle: { files: Array<{ name: string; url: string }>; close: () => void }
    try {
      handle = await this.options.images.serveImages(directory, [name])
    } catch (error) {
      // 端点只服务图片扩展名；`serveImages` 在没有可用文件时抛 STORAGE_ERROR。
      deviceLog().info('事件中心：这一份证据不是能渲染的图片', {
        relativePath,
        reason: describeError(error)
      })
      return { state: 'not-image' }
    }

    this.evidenceHandle = handle
    const file = handle.files[0]
    if (!file) return { state: 'not-image' }
    return { state: 'ok', url: file.url, name: file.name }
  }

  /** 关掉当前图片端点（界面离开这条事件时调用；TTL 兜底）。 */
  closeEvidenceImage(): void {
    this.evidenceHandle?.close()
    this.evidenceHandle = null
  }

  /** 入参 → 存储根相对路径。`recordingId` 优先：库里的行是权威。 */
  private resolveEvidencePath(input: EventEvidenceImageInput): string | undefined {
    const recordingId = typeof input.recordingId === 'string' ? input.recordingId.trim() : ''
    if (recordingId !== '') {
      return this.options.recordings.findById(recordingId)?.relativePath
    }
    const relativePath = typeof input.relativePath === 'string' ? input.relativePath.trim() : ''
    /**
     * 绝对路径不受理：界面只该拿到库里的相对路径（存储根可以搬家，绝对路径会随之失效）。
     * 这一类调用是缺陷而不是攻击，所以直接当"取不到"。
     */
    if (relativePath === '' || path.isAbsolute(relativePath)) return undefined
    return relativePath
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  async query(input: EventCenterQuery): Promise<EventCenterPage> {
    const limit = clampLimit(input.limit)
    const offset = clampOffset(input.offset)
    const perSourceCap = eventCenterPerSourceCap(limit, offset)
    const groupWindowMs = clampGroupWindow(input.groupWindowMs)

    const requested = new Set<EventSourceKind>(
      input.sources && input.sources.length > 0
        ? input.sources.filter(isEventSourceKind)
        : EVENT_SOURCE_KINDS
    )
    const deviceFilter =
      input.deviceId !== undefined && input.deviceId.trim() !== '' ? input.deviceId : undefined

    const statuses: EventSourceStatus[] = []
    const pool: EventCenterEntry[] = []

    // ---- 声纹设备告警（SQLite） ------------------------------------------
    if (requested.has('localAlarm')) {
      const collected = this.collectLocalAlarms(input, deviceFilter, perSourceCap)
      statuses.push(collected.status)
      pool.push(...collected.entries)
    }

    // ---- 本机联动（内存待处理列表） --------------------------------------
    if (requested.has('linkage')) {
      const collected = this.collectLinkage(input, deviceFilter, perSourceCap)
      statuses.push(collected.status)
      pool.push(...collected.entries)
    }

    // ---- 相机检测日志（设备 HTTP） ---------------------------------------
    if (requested.has('deviceDetect')) {
      const collected = await this.collectDeviceDetects(input, deviceFilter, perSourceCap)
      statuses.push(collected.status)
      pool.push(...collected.entries)
    }

    // ---- 设备上线 / 离线（本机 SQLite，schema v17） ------------------------
    if (requested.has('deviceStatus') && this.options.deviceStatus) {
      const collected = this.collectDeviceStatus(input, deviceFilter, perSourceCap)
      statuses.push(collected.status)
      pool.push(...collected.entries)
    }

    // 没被请求的来源也如实报告为「本次没有读」，界面因此不会把它当成空。
    for (const source of EVENT_SOURCE_KINDS) {
      if (requested.has(source)) continue
      statuses.push({ source, ok: true, items: 0, truncated: 0, untimed: 0 })
    }

    pool.sort(compareEntriesDesc)

    /*
     * 重复触发聚合（规格 §14.1）：**在分页之前**把候选池并成告警。
     *
     * 为什么在服务端而不是渲染层：告警是这一页所有数字的单位（KPI、筛选面板的计数、
     * 分页总数）—— 在渲染层并组会让 `total` 变成"原始事件数"，而列表里是"告警数"，
     * 两个数字对不上，翻页也会翻到半截的组。`groupWindowMs: 0` 时每条自己一组，
     * 于是下面这条路不需要分支。
     */
    const groups = groupEvents(pool, groupWindowMs)
    const pageGroups = groups.slice(offset, offset + limit)

    const countsBySource = emptyCounts()
    for (const entry of pool) countsBySource[entry.source] += 1

    const truncated = statuses.some((status) => status.truncated > 0)
    if (truncated) {
      deviceLog().warn('事件中心：有来源触及每路读取上限，结果已被截断', {
        perSourceCap,
        sources: statuses
          .filter((status) => status.truncated > 0)
          .map((status) => ({ source: status.source, truncated: status.truncated }))
      })
    }

    const items =
      groupWindowMs > 0
        ? pageGroups.map((group) => representativeOf(group))
        : // 不聚合：原样返回这一页的原始事件（**一个组字段都不填**）。
          pool.slice(offset, offset + limit)
    this.mergeStatuses(items)

    return {
      items,
      // 总数是**告警数**（聚合之后），与列表里的一行一一对应。
      total: groups.length,
      countsBySource,
      truncated,
      sources: statuses
    }
  }

  /**
   * 把处置工作流的状态与指派人并到事件行上（规格 §2.2）。
   *
   * 只对**这一页要返回的那些行**查一次（不逐行查）：一页 50 行逐行查就是 50 次往返。
   * 表里没有那一行时**不填** `status`（界面据此用来源的 `acknowledged` 推 `new` /
   * `acknowledged`）—— "没人动过"与"状态是 new"是两件事。
   */
  private mergeStatuses(items: readonly EventCenterEntry[]): void {
    if (items.length === 0) return
    /** 组内**全部**原始事件的 id：一条告警的处置状态挂在组上，不挂在代表那一条上。 */
    const memberIds = (item: EventCenterEntry): string[] =>
      item.groupMembers && item.groupMembers.length > 0
        ? item.groupMembers.map((member) => member.id)
        : [item.id]
    let stored: ReturnType<EventCenterStatusStore['statusMap']>
    try {
      stored = this.options.statuses.statusMap(items.flatMap(memberIds))
    } catch (error) {
      // 工作流表读失败**不该让整页空白**：处置状态是附加信息，事件本身仍然要显示出来。
      // 失败如实记一条 warn，界面看到的是"没有状态"（与没人动过一样）—— 这是这一处
      // 唯一能接受的降级方向：宁可少显示一个状态，也不能把三路来源一起藏掉。
      deviceLog().warn('事件中心：读处置状态失败，本次不显示状态', {
        reason: describeError(error)
      })
      return
    }
    for (const item of items) {
      /*
       * 组里"最新的一次处置"决定整组的状态：组内任何一条被处置过，那一组就算处置过。
       * 只看代表（最新那条触发）会漏掉"这条组在更早的触发上已经被确认过"。
       */
      let best: { status: EventStatus; assignee?: string; updatedAt: number } | undefined
      for (const id of memberIds(item)) {
        const row = stored.get(id)
        if (!row) continue
        if (!best || row.updatedAt >= best.updatedAt) best = row
      }
      if (!best) continue
      item.status = best.status
      if (best.assignee !== undefined) item.assignee = best.assignee
    }
  }

  /** 一条事件的一页流水（规格 §13.3）。 */
  activity(entryId: string, limit?: number): EventActivityView[] {
    const id = entryId.trim()
    if (id === '') throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少事件标识')
    return this.options.statuses.activity(id, limit)
  }

  // -------------------------------------------------------------------------
  // Incident（规格 §14.2 的 V1：人工创建 + 手动关联）
  // -------------------------------------------------------------------------

  /**
   * 这一条 Alert 属于哪些 Incident（新的在前，带关联条数）。
   *
   * 同步：它只是两次索引查询（`forEntry` + 一次 `GROUP BY`），没有设备/网络参与 ——
   * 详情抽屉打开的瞬间就要有内容。
   */
  incidentsForEntry(entryId: string): IncidentView[] {
    const id = typeof entryId === 'string' ? entryId.trim() : ''
    if (id === '') return []
    const rows = this.options.incidents.forEntry(id)
    const counts = this.options.incidents.alertCounts(rows.map((row) => row.id))
    return rows.map((row) => toIncidentView(row, counts.get(row.id) ?? 0))
  }

  /**
   * 库里已有的 Incident（给"手动关联到已有"的列表用），新的在前。
   *
   * 与 `incidentsForEntry` 分开两个方法而不是一个带参数的方法：一个回答"这一条属于谁"，
   * 一个回答"现在有哪些" —— 界面上是两件事（前者是详情，后者是选择器）。
   */
  listIncidents(limit = 100): IncidentView[] {
    const rows = this.options.incidents.list(limit)
    const counts = this.options.incidents.alertCounts(rows.map((row) => row.id))
    return rows.map((row) => toIncidentView(row, counts.get(row.id) ?? 0))
  }

  /**
   * 人工建一个 Incident，并把这几条 Alert 一起挂上去（规格 §14.2 的 `[Create Incident]`）。
   *
   * 三件事在这里定死：
   *   1. **标题是必填、有长度上限**，判据只有 `validateIncidentDraft()` 一处（对话框与这里
   *      共用），不合法就 `VALIDATION_ERROR` 拒绝并给出原因键；
   *   2. **entry id 必须认得出是哪一路来的**（与 `changeStatus` 同一条校验）：库里存的是
   *      `alarm:` / `linkage:` / `detect:` 前缀的标识，写进去一个别的东西等于造一条永远
   *      对不上的关联；
   *   3. **写完读回**：返回的 `incident` 是仓储重新读出来的那一行，`linked` 是这次真正
   *      新增的条数（界面用它写回执）。
   *
   * 规格 §13.2 明说"不自动替用户关闭/合并"：这里**只**建关联，不碰任何 Alert 的状态。
   */
  async createIncident(input: {
    title: unknown
    note?: unknown
    entryIds?: readonly string[]
    actor: string
  }): Promise<{ incident: IncidentView; linked: number }> {
    const draft = validateIncidentDraft({ title: input.title, note: input.note })
    if (!draft.ok) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        incidentDraftMessage(draft.reason),
        draft.reason
      )
    }
    const entryIds = this.normaliseEntryIds(input.entryIds ?? [])
    const created = this.options.incidents.create({
      title: draft.draft.title,
      ...(draft.draft.note === undefined ? {} : { note: draft.draft.note }),
      createdBy: input.actor,
      at: this.now(),
      entryIds
    })
    deviceLog().info('事件中心：人工创建了一个 Incident', {
      incidentId: created.row.id,
      linked: created.linked,
      actor: input.actor,
      title: draft.draft.title
    })
    return {
      incident: toIncidentView(created.row, created.linked),
      linked: created.linked
    }
  }

  /**
   * 手动把一批 Alert 关联到**已有**的 Incident（规格 §14.2 的"手动关联 Alert"）。
   *
   * 幂等：已经关联过的算 `alreadyLinked`，不是错误 —— 界面上"关联"和"已关联"是同一个
   * 按钮的两种状态，点两次不该报错。
   */
  async linkAlerts(input: {
    incidentId: string
    entryIds: readonly string[]
    actor: string
  }): Promise<{ incident: IncidentView; linked: number; alreadyLinked: number }> {
    const incidentId = typeof input.incidentId === 'string' ? input.incidentId.trim() : ''
    if (incidentId === '') throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少 Incident 标识')
    const entryIds = this.normaliseEntryIds(input.entryIds)
    if (entryIds.length === 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '至少要选一条告警')
    }
    let result: { incidentId: string; linked: number; alreadyLinked: number }
    try {
      result = this.options.incidents.link({
        incidentId,
        entryIds,
        actor: input.actor,
        at: this.now()
      })
    } catch (error) {
      // 仓储只在这一种情况下抛：Incident 不存在。那是界面拿着一个过期的 id 在做事
      // （另一个窗口删掉了？），如实说"不在了"，而不是静默成功。
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        error instanceof Error ? error.message : 'Incident 不存在'
      )
    }
    const row = this.options.incidents.find(incidentId)
    if (!row) throw new AppError(ErrorCodes.VALIDATION_ERROR, `Incident 不存在：${incidentId}`)
    const counts = this.options.incidents.alertCounts([incidentId])
    deviceLog().info('事件中心：手动关联了一批告警', {
      incidentId,
      linked: result.linked,
      alreadyLinked: result.alreadyLinked,
      actor: input.actor
    })
    return {
      incident: toIncidentView(row, counts.get(incidentId) ?? 0),
      linked: result.linked,
      alreadyLinked: result.alreadyLinked
    }
  }

  /** 摘掉一条关联（关联错了、或者这条不该在这个事件里）。 */
  async unlinkAlert(input: {
    incidentId: string
    entryId: string
  }): Promise<{ removed: boolean }> {
    const incidentId = typeof input.incidentId === 'string' ? input.incidentId.trim() : ''
    const entryId = typeof input.entryId === 'string' ? input.entryId.trim() : ''
    if (incidentId === '' || entryId === '') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少 Incident 标识或事件标识')
    }
    return { removed: this.options.incidents.unlink({ incidentId, entryId }) }
  }

  /** 一个 Incident 关联的那些 entry id（界面用它把"关联了哪几条"说清楚）。 */
  incidentEntryIds(incidentId: string): string[] {
    const id = typeof incidentId === 'string' ? incidentId.trim() : ''
    if (id === '') return []
    return this.options.incidents.links(id).map((link) => link.entryId)
  }

  /** 去重 + 丢弃空串 + 校验前缀（认不出哪一路的 id 一律拒绝，见 `createIncident`）。 */
  private normaliseEntryIds(ids: readonly string[]): string[] {
    const unique = [
      ...new Set(ids.map((id) => (typeof id === 'string' ? id.trim() : '')).filter((id) => id !== ''))
    ]
    for (const id of unique) {
      if (eventSourceFromEntryId(id) === undefined) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, `认不出这条事件来自哪一路：${id}`)
      }
    }
    return unique
  }

  /**
   * 处置一条事件：改状态、指派、或两者一起（规格 §2.2 / §11.2）。
   *
   * 这一处的规则都在这里（一处而不是两处）：
   *   1. **迁移合法性**：`canTransitionStatus(from, to)`，不合法就以
   *      `VALIDATION_ERROR` 拒绝，并把允许的目标写在消息里（界面据此提示）；
   *   2. **动作 → 目标状态**：`acknowledge` / `investigate` / `resolve` / `close` /
   *      `reopen` / `mute` 各对应一个状态，`assign` 只改指派人；
   *   3. **`acknowledge` 要同时落到来源侧**：我们的工作流状态与来源的 `acknowledged`
   *      是两件事（§3.12），但"确认"这一个动作应该让两边都前进 —— 否则会出现
   *      "界面上已确认、来源侧仍未确认"，那正是操作员最容易被骗的地方。
   *      来源明确没有这个接口（相机检测日志）时**拒绝**这次状态写入：不替设备答应它做不到的事；
   *   4. **写完读回**：返回值里的 `status` / `assignee` 来自仓储重新读出的那一行，
   *      不是我们传进去的参数。
   */
  async changeStatus(input: {
    entryId: string
    /** 一起处置的其它 entry id（聚合组：一次处置落到组内每一条触发）。 */
    entryIds?: readonly string[]
    action?: EventStatusAction
    status?: EventStatus
    assignee?: string
    note?: string
    actor: string
    /** 界面看到的当前状态（只用于"指派时把状态行建对"，见仓储的 `fromStatus`）。 */
    currentStatus?: EventStatus
  }): Promise<EventStatusChangeResult> {
    const entryId = typeof input.entryId === 'string' ? input.entryId.trim() : ''
    if (entryId === '') throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少事件标识')
    const targets = [
      entryId,
      ...(input.entryIds ?? []).map((id) => (typeof id === 'string' ? id.trim() : ''))
    ].filter((id, index, all) => id !== '' && all.indexOf(id) === index)
    for (const id of targets) {
      if (eventSourceFromEntryId(id) === undefined) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, `认不出这条事件来自哪一路：${id}`)
      }
    }
    const source = eventSourceFromEntryId(entryId) as EventSourceKind
    /** 只用来做"这一路来源有没有确认接口"的判断（组内各条的来源可以不同）。 */
    void source

    const current = this.options.statuses.statusMap([entryId]).get(entryId)
    const from: EventStatus = current?.status ?? 'new'
    const isAssign = input.action === 'assign'
    const actionTarget = input.action === undefined ? undefined : statusForAction(input.action)
    const target: EventStatus = isAssign
      ? from
      : (input.status ?? actionTarget ?? from)
    if (!isAssign && target === from && input.status === undefined && actionTarget === undefined) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '既没有给动作，也没有给目标状态')
    }
    if (!isAssign && !canTransitionStatus(from, target)) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `状态不能从 ${from} 直接变成 ${target}（允许：${allowedStatusTargets(from).join(' / ') || '无'}）`
      )
    }
    if (isAssign && (input.assignee ?? '').trim() === '') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '指派必须给出账户名')
    }

    // 确认这一个动作要同时落到来源侧（见上面第 3 条）。**组内每一条都要**：一次告警
    // 底下的 N 次触发如果只有代表那一条被来源侧确认，界面与来源就会各说各话。
    if (!isAssign && target === 'acknowledged' && input.action === 'acknowledge') {
      const acknowledged = await this.acknowledge(targets)
      for (const id of targets) {
        const idSource = eventSourceFromEntryId(id) as EventSourceKind
        const perSource = acknowledged.perSource.find((item) => item.source === idSource)
        if (perSource?.unsupported === true) {
          throw new AppError(
            ErrorCodes.VALIDATION_ERROR,
            '这一路来源没有确认接口，因此不能把它标成已确认'
          )
        }
        if (perSource?.error !== undefined) {
          throw new AppError(ErrorCodes.NETWORK_ERROR, `来源侧确认失败：${perSource.error}`)
        }
      }
      if (acknowledged.acknowledged === 0) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '来源侧没有确认这一条（标识可能已经失效）')
      }
    }

    const actor = typeof input.actor === 'string' && input.actor.trim() !== '' ? input.actor.trim() : 'unknown'
    const note = typeof input.note === 'string' ? input.note : undefined
    if (target === 'reopened' && (note ?? '').trim() === '') {
      // 规格 §2.2 明说：重新开启要记录原因。空原因的重开在事后完全无法解释。
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '重新开启必须填写原因')
    }

    const written = this.options.statuses.setStatus({
      entryId,
      ...(targets.length > 1 ? { entryIds: targets } : {}),
      ...(isAssign ? {} : { status: target }),
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      // 指派时把"界面看到的当前状态"带下去：状态行不存在时用它建行，
      // 免得指派顺手把一条已确认的事件退回「待处理」。
      ...(isAssign && input.currentStatus !== undefined ? { fromStatus: input.currentStatus } : {}),
      actor,
      ...(note !== undefined ? { note } : {}),
      at: this.now()
    })

    appLog().info('事件中心：处置状态变更', {
      entryId,
      entries: written.appliedTo,
      action: input.action ?? 'set',
      from,
      to: written.row.status,
      assignee: written.row.assignee,
      by: actor
    })

    return {
      entryId,
      status: written.row.status,
      fromStatus: from,
      appliedTo: written.appliedTo,
      ...(written.row.assignee === undefined ? {} : { assignee: written.row.assignee }),
      activity: written.activity
    }
  }

  // -------------------------------------------------------------------------
  // 确认
  // -------------------------------------------------------------------------

  /**
   * 按来源分派确认。
   *
   * | 来源           | 归属                          | 能力 |
   * |----------------|-------------------------------|------|
   * | `linkage`      | `AlarmLinkageService`         | 只能确认（引擎的 store 只暴露 acknowledge-all-true） |
   * | `localAlarm`   | `AlarmRepository`             | 确认与取消确认 |
   * | `deviceDetect` | 设备                          | **没有**：手册的 32 个开放接口里没有确认检测日志的接口 |
   *
   * 设备侧的「不支持」不是错误也不是静默忽略：它作为 `unsupported` 回到界面，
   * 由界面说明为什么这一条没有确认按钮。
   */
  async acknowledge(ids: readonly string[]): Promise<EventAcknowledgeResult> {
    const groups = new Map<EventSourceKind, string[]>()
    let unrecognised = 0
    for (const id of ids) {
      if (typeof id !== 'string' || id === '') {
        unrecognised += 1
        continue
      }
      const source = eventSourceFromEntryId(id)
      if (!source) {
        unrecognised += 1
        continue
      }
      const list = groups.get(source) ?? []
      list.push(id)
      groups.set(source, list)
    }

    const perSource: EventAcknowledgePerSource[] = []
    let acknowledged = 0

    // ---- 联动 ------------------------------------------------------------
    const linkageIds = groups.get('linkage') ?? []
    if (linkageIds.length > 0) {
      try {
        const eventIds = linkageIds.map(eventEntryIdPayload)
        // 注意：`AlarmLinkageService.acknowledge` 的空数组语义是「全部确认」，
        // 所以这里必须先判空——否则一次误传会把整个待处理列表确认掉。
        const snapshot = eventIds.length > 0 ? this.options.linkage.acknowledge(eventIds) : undefined
        const known = new Set(eventIds)
        const affected = snapshot
          ? snapshot.items.filter((item) => known.has(item.eventId) && item.acknowledged).length
          : 0
        acknowledged += affected
        perSource.push({ source: 'linkage', acknowledged: affected })
      } catch (error) {
        perSource.push({ source: 'linkage', acknowledged: 0, error: describeError(error) })
        deviceLog().warn('事件中心：联动告警确认失败', {
          count: linkageIds.length,
          reason: describeError(error)
        })
      }
    }

    // ---- 声纹告警 --------------------------------------------------------
    const alarmIds = groups.get('localAlarm') ?? []
    if (alarmIds.length > 0) {
      try {
        const affected = this.options.alarms.acknowledge(alarmIds.map(eventEntryIdPayload), true)
        acknowledged += affected
        perSource.push({ source: 'localAlarm', acknowledged: affected })
      } catch (error) {
        perSource.push({ source: 'localAlarm', acknowledged: 0, error: describeError(error) })
        deviceLog().warn('事件中心：声纹告警确认失败', {
          count: alarmIds.length,
          reason: describeError(error)
        })
      }
    }

    // ---- 设备检测日志：没有这个能力 --------------------------------------
    const detectIds = groups.get('deviceDetect') ?? []
    if (detectIds.length > 0) {
      perSource.push({ source: 'deviceDetect', acknowledged: 0, unsupported: true })
      appLog().info('事件中心：设备检测日志没有确认接口，请求已如实拒绝', {
        count: detectIds.length
      })
    }

    // ---- 设备状态事件（我们自己的表，与声纹告警同一做法） -----------------
    const statusIds = groups.get('deviceStatus') ?? []
    if (statusIds.length > 0 && this.options.deviceStatus) {
      try {
        const affected = this.options.deviceStatus.acknowledge(statusIds.map(eventEntryIdPayload), true)
        acknowledged += affected
        perSource.push({ source: 'deviceStatus', acknowledged: affected })
      } catch (error) {
        perSource.push({ source: 'deviceStatus', acknowledged: 0, error: describeError(error) })
        deviceLog().warn('事件中心：设备状态事件确认失败', {
          count: statusIds.length,
          reason: describeError(error)
        })
      }
    }

    if (unrecognised > 0) {
      appLog().warn('事件中心：确认请求里有无法识别来源的标识', { count: unrecognised })
    }

    return { acknowledged, perSource, unrecognised }
  }

  // -------------------------------------------------------------------------
  // 检测库与下载（转发）
  // -------------------------------------------------------------------------

  /** 读一台相机的检测库（透传，错误由调用方以 `DeviceResult` 呈现）。 */
  async listDetectLogs(deviceId: string, detectId?: number): Promise<EventDetectLibraryPage> {
    return this.options.detectLibrary.list(deviceId, detectId !== undefined ? { detectId } : {})
  }

  /** 下载一个结果文件；进度通过回调转成渲染层的推送，服务本身不认识窗口。 */
  async download(
    input: EventDetectDownloadInput,
    onProgress?: (progress: EventDownloadProgress) => void
  ): Promise<EventDetectDownloadResult> {
    if (typeof input.deviceId !== 'string' || input.deviceId.trim() === '') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少设备 ID')
    }
    return this.options.detectLibrary.download(input.deviceId, input, onProgress)
  }

  // -------------------------------------------------------------------------
  // 逐来源收集
  // -------------------------------------------------------------------------

  private collectLocalAlarms(
    input: EventCenterQuery,
    deviceFilter: string | undefined,
    perSourceCap: number
  ): { entries: EventCenterEntry[]; status: EventSourceStatus } {
    const source: EventSourceKind = 'localAlarm'
    // 声纹告警的等级是来源的固有语义（'warning'），所以按别的等级筛选时这一路
    // 一条都不该出现——在 SQL 前面短路，比读完再丢掉更诚实也更快。
    if (input.severity !== undefined && input.severity !== deriveEventSeverity(source)) {
      return { entries: [], status: { source, ok: true, items: 0, truncated: 0, untimed: 0 } }
    }

    try {
      const page = this.options.alarms.query({
        ...(deviceFilter !== undefined ? { deviceId: deviceFilter } : {}),
        ...(input.from !== undefined ? { from: input.from } : {}),
        ...(input.to !== undefined ? { to: input.to } : {}),
        ...(input.acknowledged !== undefined ? { acknowledged: input.acknowledged } : {}),
        limit: perSourceCap,
        offset: 0
      })
      const entries = page.items.map((alarm) => this.mapLocalAlarm(alarm))
      // SQL 知道总数，所以截断是精确的：`total` 减掉实际取回的行数。
      const truncated = Math.max(0, page.total - page.items.length)
      return { entries, status: { source, ok: true, items: entries.length, truncated, untimed: 0 } }
    } catch (error) {
      deviceLog().warn('事件中心：声纹告警读取失败', { reason: describeError(error) })
      return { entries: [], status: { source, ok: false, error: describeError(error), items: 0, truncated: 0, untimed: 0 } }
    }
  }

  private collectLinkage(
    input: EventCenterQuery,
    deviceFilter: string | undefined,
    perSourceCap: number
  ): { entries: EventCenterEntry[]; status: EventSourceStatus } {
    const source: EventSourceKind = 'linkage'
    if (input.severity !== undefined && input.severity !== deriveEventSeverity(source)) {
      return { entries: [], status: { source, ok: true, items: 0, truncated: 0, untimed: 0 } }
    }

    try {
      const snapshot = this.options.linkage.pendingSnapshot()
      const all = snapshot.items.filter((item) => this.matchesFilter(input, deviceFilter, {
        deviceId: item.deviceId,
        at: item.at,
        acknowledged: item.acknowledged
      }))
      // 待处理列表本身就是有容量上限的（超限时引擎计入 `dropped`），所以这里的
      // 截断要把 `dropped` 一起算进去，否则「被丢掉的历史告警」会凭空消失。
      const overCap = Math.max(0, all.length - perSourceCap)
      const kept = all.slice(0, perSourceCap)
      return {
        entries: kept.map((record) => this.mapLinkage(record)),
        status: {
          source,
          ok: true,
          items: kept.length,
          truncated: overCap + snapshot.dropped,
          untimed: 0
        }
      }
    } catch (error) {
      deviceLog().warn('事件中心：本机联动待处理列表读取失败', { reason: describeError(error) })
      return { entries: [], status: { source, ok: false, error: describeError(error), items: 0, truncated: 0, untimed: 0 } }
    }
  }

  private async collectDeviceDetects(
    input: EventCenterQuery,
    deviceFilter: string | undefined,
    perSourceCap: number
  ): Promise<{ entries: EventCenterEntry[]; status: EventSourceStatus }> {
    const source: EventSourceKind = 'deviceDetect'
    if (input.severity !== undefined && input.severity !== deriveEventSeverity(source)) {
      return { entries: [], status: { source, ok: true, items: 0, truncated: 0, untimed: 0 } }
    }

    const devices = this.options
      .listDevices()
      .filter((device) => device.kind === 'acousticCamera')
      .filter((device) => deviceFilter === undefined || device.id === deviceFilter)

    const entries: EventCenterEntry[] = []
    const errors: string[] = []
    let truncated = 0
    let untimed = 0

    for (const device of devices) {
      try {
        const page = await this.options.detectLibrary.list(device.id)
        const downloads = this.downloadIndex(device.id)

        // 先把这一台设备的日志按时间倒序，再套上限：上限必须留下**最新**的那些。
        // 设备给的顺序在手册里没有定义（§5.1.17 没有排序说明），所以不能拿它
        // 当"从新到旧"。截掉的条数如实计入 `truncated`。
        const mapped = page.items
          .map((log) => this.mapDeviceDetect(device, log, page.logsCount, downloads))
          .sort(compareEntriesDesc)

        const kept = mapped.length > this.detectLogLimit ? mapped.slice(0, this.detectLogLimit) : mapped
        if (mapped.length > kept.length) truncated += mapped.length - kept.length

        for (const entry of kept) {
          if (entry.detect?.startTimeRaw === undefined) untimed += 1
          if (
            this.matchesFilter(input, deviceFilter, {
              deviceId: entry.deviceId,
              at: entry.at,
              acknowledged: entry.acknowledged
            })
          ) {
            entries.push(entry)
          }
        }
      } catch (error) {
        // 一台相机失败不影响另一台，也不影响另外两路来源。
        errors.push(`${device.name}: ${describeError(error)}`)
        deviceLog().warn('事件中心：检测日志读取失败', {
          deviceId: device.id,
          deviceName: device.name,
          reason: describeError(error)
        })
      }
    }

    // 先排序再截断：截断必须留下**最新**的那些，而不是设备返回顺序靠前的那些。
    entries.sort(compareEntriesDesc)
    if (entries.length > perSourceCap) {
      truncated += entries.length - perSourceCap
      entries.length = perSourceCap
    }

    const status: EventSourceStatus = {
      source,
      ok: errors.length === 0,
      items: entries.length,
      truncated,
      untimed
    }
    if (errors.length > 0) status.error = errors.join(' | ')
    return { entries, status }
  }

  /**
   * 设备上线 / 离线事件（本机 SQLite，schema v17）。
   *
   * 与 `collectLocalAlarms` 的差别：等级**不是来源固有单值**（ONLINE → info /
   * OFFLINE → warning 是写库时算好的两档），所以等级筛选不下推短路，而是交给 SQL
   * （`severity` 列就是这么存在的理由）。截断同样是精确的：`total - items`。
   */
  private collectDeviceStatus(
    input: EventCenterQuery,
    deviceFilter: string | undefined,
    perSourceCap: number
  ): { entries: EventCenterEntry[]; status: EventSourceStatus } {
    const source: EventSourceKind = 'deviceStatus'
    // 先取到局部变量：可选属性在方法调用之间不会被 TS 收窄。
    const lookup = this.options.deviceStatus
    if (!lookup) {
      return { entries: [], status: { source, ok: true, items: 0, truncated: 0, untimed: 0 } }
    }
    try {
      const page = lookup.query({
        ...(deviceFilter !== undefined ? { deviceId: deviceFilter } : {}),
        ...(input.from !== undefined ? { from: input.from } : {}),
        ...(input.to !== undefined ? { to: input.to } : {}),
        ...(input.acknowledged !== undefined ? { acknowledged: input.acknowledged } : {}),
        ...(input.severity !== undefined ? { severity: input.severity } : {}),
        limit: perSourceCap,
        offset: 0
      })
      const entries = page.items.map((event) => this.mapDeviceStatus(event))
      const truncated = Math.max(0, page.total - page.items.length)
      return { entries, status: { source, ok: true, items: entries.length, truncated, untimed: 0 } }
    } catch (error) {
      deviceLog().warn('事件中心：设备状态事件读取失败', { reason: describeError(error) })
      return { entries: [], status: { source, ok: false, error: describeError(error), items: 0, truncated: 0, untimed: 0 } }
    }
  }

  // -------------------------------------------------------------------------
  // 映射
  // -------------------------------------------------------------------------

  /** 设备状态事件 → 事件中心条目。设备名用**写入时刻的快照**（设备可能已改名/删除）。 */
  private mapDeviceStatus(event: DeviceStatusEventLike): EventCenterEntry {
    return {
      id: deviceStatusEntryId(event.id),
      source: 'deviceStatus',
      deviceId: event.deviceId,
      deviceName: event.deviceName,
      at: event.at,
      atApproximate: false,
      severity: event.severity,
      kind: event.status === 'ONLINE' ? 'deviceOnline' : 'deviceOffline',
      acknowledged: event.acknowledged
    }
  }

  private mapLocalAlarm(alarm: AlarmEvent): EventCenterEntry {
    const entry: EventCenterEntry = {
      id: localAlarmEntryId(alarm.id),
      source: 'localAlarm',
      deviceId: alarm.deviceId,
      deviceName: this.deviceName(alarm.deviceId),
      // 声纹设备的 `alarm_time` 本来就是毫秒（协议直接给 epoch ms 并被原样入库），
      // 所以它是确定时刻，不是换算值。
      at: alarm.timestamp,
      atApproximate: false,
      severity: deriveEventSeverity('localAlarm'),
      kind: 'localAlarm',
      acknowledged: alarm.acknowledged,
      // 位图与它的解码结果一起带上：页面因此永远不需要做位运算。
      localAlarm: {
        channelId: alarm.channelId,
        alarmMask: alarm.alarmMask,
        alarmTypes: alarm.alarmTypes
      }
    }
    this.attachRecording(entry, alarm.localRecordingId)
    const metrics: EventMetrics = {}
    if (alarm.spl !== undefined) metrics.spl = alarm.spl
    if (alarm.mainFrequency !== undefined) metrics.mainFrequency = alarm.mainFrequency
    if (alarm.smoothness !== undefined) metrics.smoothness = alarm.smoothness
    if (alarm.bandEnergyRatio !== undefined) metrics.bandEnergyRatio = alarm.bandEnergyRatio
    if (Object.keys(metrics).length > 0) entry.metrics = metrics
    return entry
  }

  private mapLinkage(record: PendingAlarmRecord): EventCenterEntry {
    const entry: EventCenterEntry = {
      id: linkageEntryId(record.eventId),
      source: 'linkage',
      deviceId: record.deviceId,
      deviceName: record.deviceName || this.deviceName(record.deviceId),
      at: record.at,
      /**
       * 引擎的事件时刻有两种来源：设备给的 `start_time`（按假设换算），
       * 或**首次观察时刻**。两者相等时说明用的是本机时钟，是确定值；
       * 不等时说明用的是设备时间，那就带着这份不确定性。
       */
      atApproximate: record.at !== record.observedAt,
      severity: deriveEventSeverity('linkage'),
      kind: 'linkageAlarm',
      acknowledged: record.acknowledged,
      linkageActions: record.actions
    }
    if (record.alarmLevelRaw !== undefined) entry.alarmLevelRaw = record.alarmLevelRaw
    if (record.frameRelativePath !== undefined) entry.frameRelativePath = record.frameRelativePath
    if (record.metrics !== undefined) entry.metrics = { ...record.metrics }
    this.attachRecording(entry, record.recordingId)
    return entry
  }

  private mapDeviceDetect(
    device: EventCenterDeviceRef,
    log: EventDetectLogView,
    logsCount: number | undefined,
    downloads: Map<string, string>
  ): EventCenterEntry {
    const files: EventDetectFile[] = log.files.map((file) => {
      const downloaded =
        log.logId !== undefined ? downloads.get(detectRemoteRecordingId(log.logId, file.kind)) : undefined
      return downloaded !== undefined ? { ...file, downloadedRecordingId: downloaded } : { ...file }
    })

    /**
     * 设备没有给时间时**不编一个设备时间**：用读取时刻排序，并保持
     * `atApproximate = true` 与 `startTimeRaw === undefined`——界面据此说明
     * 「设备没有提供时间」。丢弃这条日志更糟：事件确实上报了。
     */
    const at = log.startTimeMs ?? this.now()

    const detect: EventDetectDetail = { timeUnit: log.timeUnit, files }
    if (log.logId !== undefined) detect.logId = log.logId
    if (log.startTimeRaw !== undefined) detect.startTimeRaw = log.startTimeRaw
    if (log.savingPath !== undefined) detect.savingPath = log.savingPath
    if (log.detectMode !== undefined) detect.detectMode = log.detectMode
    if (log.status !== undefined) detect.status = log.status
    if (logsCount !== undefined) detect.logsCount = logsCount

    const entry: EventCenterEntry = {
      id: deviceDetectEntryId(device.id, log.logId, log.startTimeRaw),
      source: 'deviceDetect',
      deviceId: device.id,
      deviceName: device.name,
      at,
      // 相机从不声明时间戳单位，换算出的时刻永远是近似值。
      atApproximate: true,
      severity: deriveEventSeverity('deviceDetect'),
      // 只有设备**明确**回了 `is_alarm = true` 时才是告警；字段缺席不等于告警。
      kind: log.isAlarm === true ? 'deviceDetectAlarm' : 'deviceDetect',
      acknowledged: false,
      detect
    }
    if (log.alarmLevelRaw !== undefined) entry.alarmLevelRaw = log.alarmLevelRaw
    if (log.metrics !== undefined) entry.metrics = { ...log.metrics }
    return entry
  }

  /**
   * 设备侧的检测日志**没有**确认状态：协议里没有这个字段，也没有这个接口。
   * 所以 `acknowledged` 恒为 false，界面不会为它渲染确认按钮。
   */

  /** 把本机录像行挂到事件上（同时给出容器，供界面选播放器）。 */
  private attachRecording(entry: EventCenterEntry, recordingId: string | undefined): void {
    if (recordingId === undefined || recordingId === '') return
    entry.recordingId = recordingId
    const recording = this.options.recordings.findById(recordingId)
    if (recording) entry.recordingContainer = containerOf(recording)
  }

  /**
   * 已下载的检测结果文件：`remote_recording_id -> recordingId`。
   *
   * 只认**盘上确实有文件**的行（`relative_path` 非空）：界面上「已下载」必须
   * 等价于「点得开」，否则一个只有元数据的行会把操作员带到一个打不开的播放器。
   */
  private downloadIndex(deviceId: string): Map<string, string> {
    const index = new Map<string, string>()
    for (const recording of this.options.recordings.listByDevice(deviceId)) {
      if (recording.relativePath.trim() === '') continue
      if (recording.remoteRecordingId === undefined) continue
      index.set(recording.remoteRecordingId, recording.id)
    }
    return index
  }

  private deviceName(deviceId: string): string {
    const found = this.options.listDevices().find((device) => device.id === deviceId)
    return found?.name ?? deviceId
  }

  /**
   * 统一的过滤判定。
   *
   * 声纹告警那一路的等价条件已经下推到 SQL（`AlarmRepository.query`），
   * 因此这里只对另外两路使用；谓词本身是同一套语义，写在下面。
   */
  private matchesFilter(
    input: EventCenterQuery,
    deviceFilter: string | undefined,
    value: { deviceId: string; at: number; acknowledged: boolean }
  ): boolean {
    if (deviceFilter !== undefined && value.deviceId !== deviceFilter) return false
    if (input.from !== undefined && value.at < input.from) return false
    if (input.to !== undefined && value.at > input.to) return false
    if (input.acknowledged !== undefined && value.acknowledged !== input.acknowledged) return false
    return true
  }
}

// ---------------------------------------------------------------------------
// 辅助纯函数
// ---------------------------------------------------------------------------

/** 时间倒序；`at` 相同时按 id 稳定排序，保证两次查询的顺序一致。 */
export function compareEntriesDesc(left: EventCenterEntry, right: EventCenterEntry): number {
  if (right.at !== left.at) return right.at - left.at
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

/** 把 `Recording` 归一化成容器：优先显式列，其次音频格式，最后扩展名。 */
export function containerOf(recording: Recording): NonNullable<EventCenterEntry['recordingContainer']> {
  if (recording.containerFormat !== undefined) return recording.containerFormat
  if (recording.audioFormat !== null) return recording.audioFormat
  // 迁移前的行没有容器列：退到相对路径的扩展名，认不出来仍是 'unknown'
  // （复用领域层那一份实现，而不是在这里写第二份扩展名表）。
  return deriveRecordingContainer(recording.relativePath)
}

function emptyCounts(): Record<EventSourceKind, number> {
  return { deviceDetect: 0, linkage: 0, localAlarm: 0, deviceStatus: 0 }
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return EVENT_CENTER_DEFAULT_LIMIT
  return Math.min(Math.trunc(value), EVENT_CENTER_MAX_LIMIT)
}

function clampOffset(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.trunc(value)
}

/**
 * 聚合窗口（规格 §14.1）：上限 24 小时、`0` 表示不聚合。
 *
 * **缺省是不聚合**（不是 10 分钟）：窗口是**调用方**的选择，界面每一查询都会显式带上它
 * （用户看到的那一档，默认 10 分钟）。把"界面默认 10 分钟"写进 API 缺省里，会让以后改一次
 * 界面默认值就悄悄改掉所有其它调用方（含测试与将来的脚本）的行为 —— 那种耦合不值得。
 *
 * 夹上限的理由写在 `EVENT_CENTER_MAX_GROUP_WINDOW_MS` 的注释里：窗口太大就不是聚合，
 * 而是把数据藏起来。
 */
function clampGroupWindow(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  if (value <= 0) return 0
  return Math.min(Math.trunc(value), EVENT_CENTER_MAX_GROUP_WINDOW_MS)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 一条 Incident 的库行 → 界面模型（`alertCount` 由调用方从一次 `GROUP BY` 里拿）。 */
function toIncidentView(row: EventIncidentRecord, alertCount: number): IncidentView {
  return {
    id: row.id,
    title: row.title,
    ...(row.note === undefined ? {} : { note: row.note }),
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    alertCount: Math.max(0, alertCount)
  }
}

/**
 * 草稿不合法的**主进程诊断文字**（中文）。
 *
 * 界面显示的是目录键（`reason`）翻出来的话，这一段只是给日志与协议实验室看的 ——
 * 主进程不渲染 UI，所以它这里的字符串不参与四语言。
 */
function incidentDraftMessage(reason: 'title-required' | 'title-too-long' | 'note-too-long'): string {
  switch (reason) {
    case 'title-required':
      return 'Incident 必须有标题'
    case 'title-too-long':
      return `Incident 标题过长（上限 ${INCIDENT_TITLE_MAX_LENGTH} 字）`
    default:
      return `Incident 备注过长（上限 ${INCIDENT_NOTE_MAX_LENGTH} 字）`
  }
}

