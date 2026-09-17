/**
 * 「事件与告警中心」的领域模型（main / preload / renderer 三方共用的**唯一**一份）。
 *
 * 产品要求原文：「设置事件和告警中心。」——一个页面里按时间顺序看到软件知道的
 * **全部**事件，能确认、能跳到它的录像、能下载设备为它产出的结果文件。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要一个归一化模型，而不是三个列表拼在一起
 * ---------------------------------------------------------------------------
 * 三路来源的所有者、传输方式和真实性完全不同：
 *
 *   1. `deviceDetect` —— 相机 `GET /detect_logs`（手册 §5.1.17）。时间戳是设备
 *      给的**未声明单位**的整数（§8.3 C19），等级字段 `alarm_level` 手册有、
 *      真机从未回过（§8.3 C15）。
 *   2. `linkage`      —— 本机联动引擎的内存待处理列表（`PendingAlarmRecord`），
 *      已经带四个动作的逐项结果。
 *   3. `localAlarm`   —— 声纹设备自己的告警行（SQLite `alarms` 表）。
 *
 * 三者共有的只有「某台设备、某个时刻、发生了某件事」。所以本文件把它压成一条
 * `EventCenterEntry`，并且**把不确定的东西显式标出来**，而不是抹平：
 *
 *   - `severity` 可以是 `'unknown'`，而且对两路来源它**就是** unknown（见
 *     `deriveEventSeverity` 的注释）；
 *   - `atApproximate` 说明这个时刻是不是按假设换算出来的；
 *   - `kind` 是**稳定标识**而不是渲染好的句子，翻译在渲染层；
 *   - `detect.files` 里的容器格式由扩展名推导，认不出来就是 `'unknown'`，
 *     绝不按来源猜。
 *
 * 本文件没有一行运行时逻辑依赖环境（没有 Node、没有 Electron、没有 vue-i18n），
 * 因此主进程、渲染层与 `node --test` 共用同一份判断。
 */

import type { Fa371ResultFileKind, Fa371TimestampUnit } from './fa371'
import type { LinkageActionRecord, LinkageMetrics } from './alarm-linkage'
import type {
  AlarmPage,
  AlarmQuery,
  AlarmType,
  Recording,
  RecordingContainerFormat
} from './models'
import { isRecordingContainerFormat } from './models'

// ---------------------------------------------------------------------------
// 来源
// ---------------------------------------------------------------------------

/**
 * 事件的来源。取值**同时**是 `domain.eventSource.<value>` 的目录键，
 * 因此界面不需要任何查表。
 */
export type EventSourceKind = 'deviceDetect' | 'linkage' | 'localAlarm'

export const EVENT_SOURCE_KINDS: readonly EventSourceKind[] = [
  'deviceDetect',
  'linkage',
  'localAlarm'
]

/** 收窄来自 IPC / 数据库边界的取值。 */
export function isEventSourceKind(value: unknown): value is EventSourceKind {
  return typeof value === 'string' && (EVENT_SOURCE_KINDS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// 等级
// ---------------------------------------------------------------------------

/**
 * 事件等级。
 *
 * `'unknown'` **是合法且预期会出现**的取值，不是兜底：
 *   - 相机 `alarm_level` 读侧写 `0,1,2,3`、写侧写 `1,2,3,4`，两套枚举冲突，
 *     而且真机（192.168.110.235）从未回过这个字段（§8.3 C15/C21）；
 *   - 声纹设备的告警协议里**根本没有等级字段**（`AlarmEvent` 只有位图）。
 *
 * 所以本模型宁可让等级为空，也不把某个数字猜成「警告」。
 */
export type EventSeverity = 'info' | 'warning' | 'critical' | 'unknown'

export const EVENT_SEVERITIES: readonly EventSeverity[] = [
  'info',
  'warning',
  'critical',
  'unknown'
]

export function isEventSeverity(value: unknown): value is EventSeverity {
  return typeof value === 'string' && (EVENT_SEVERITIES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// 事件种类（稳定标识，不是文案）
// ---------------------------------------------------------------------------

/**
 * 事件的种类。取值**同时**是 `domain.eventKind.<value>` 的目录键。
 *
 * 为什么不让渲染层按 `source` 自己判断：同一种来源里，「设备明确说这是告警」与
 * 「设备完成了一次检测、没说是不是告警」对操作员是两件事，而这个区别只由领域层
 * 知道（`is_alarm` 存在与否）。
 */
export type EventKind =
  /** 相机完成一次检测，设备**没有**说明它算不算告警。 */
  | 'deviceDetect'
  /** 相机完成一次检测，且设备明确回了 `is_alarm = true`。 */
  | 'deviceDetectAlarm'
  /** 本机联动引擎判定的一次告警。 */
  | 'linkageAlarm'
  /** 声纹设备自身上报的告警位。 */
  | 'localAlarm'

// ---------------------------------------------------------------------------
// 检测结果文件
// ---------------------------------------------------------------------------

/**
 * 一条检测日志带的一个结果文件。
 *
 * `container` 由**文件名扩展名**推导（`deriveRecordingContainer`），认不出来时
 * 是 `'unknown'`：设备把文件名交给我们就等于把容器交给了我们，但一个没有扩展名
 * 或扩展名陌生的文件名不能变成任何具体格式。
 */
export interface EventDetectFile {
  kind: Fa371ResultFileKind
  fileName: string
  /**
   * 已经下载到本机并登记成录像行的 id。
   *
   * 只有当那一行**确实有本地文件**（`relative_path` 非空）时才存在：
   * 「有元数据行」与「文件在盘上」是两件事，界面上的「已下载」只认后者。
   */
  downloadedRecordingId?: string
  /** 这个文件是什么容器（由扩展名推导）。 */
  container: RecordingContainerFormat
}

/**
 * `deviceDetect` 事件独有的细节。
 *
 * `startTimeRaw` 原样保留设备给的数字；它是 `undefined` 时说明设备**没有**
 * 给时间，此时 `EventCenterEntry.at` 用的是读取时刻（`atApproximate = true`），
 * 界面必须据此说明「时间未知」而不是把它当成设备时间展示。
 */
export interface EventDetectDetail {
  logId?: number
  startTimeRaw?: number
  endTimeRaw?: number
  savingPath?: string
  /** 解读 `startTimeRaw` 所用的单位假设（设备从不声明单位）。 */
  timeUnit: Fa371TimestampUnit
  /** 设备自己的 `logs_count`（读侧批次计数），原样带上，不做分页推断。 */
  logsCount?: number
  /** 检测模式原始取值（§8.3 C16：示例 `2` 的含义手册未说明）。 */
  detectMode?: number
  status?: number
  files: EventDetectFile[]
}

/** `localAlarm` 事件独有的细节。 */
export interface EventLocalAlarmDetail {
  channelId: number
  /**
   * 原始告警位图。
   *
   * 页面**不得**对它做位运算（工程规则）：`alarmTypes` 是它在主进程里解好的
   * 结果（`AlarmEvent.alarmTypes` 由仓库读出时已经解码），渲染层只需翻译。
   */
  alarmMask: number
  /** 解码后的告警类型；与 `alarmMask` 说的是同一件事，只是已经算好了。 */
  alarmTypes: AlarmType[]
}

/** 三路来源都可能带的数值指标；没有的字段一律缺省，绝不填 0。 */
export interface EventMetrics extends LinkageMetrics {
  spl?: number
  mainFrequency?: number
  smoothness?: number
  bandEnergyRatio?: number
  /** 检测日志的泄漏成本原始值（`data_2`）。 */
  leakCost?: number
}

// ---------------------------------------------------------------------------
// 归一化事件
// ---------------------------------------------------------------------------

/**
 * 一条归一化事件。
 *
 * `id` 是**带来源前缀的稳定标识**（见下面的 `eventEntryId*` 系列函数），
 * 因为确认操作要按来源分派，而「这条 id 属于谁」不能靠渲染层记着。
 */
export interface EventCenterEntry {
  /** 稳定标识：`detect:<deviceId>:<logId>:<startTimeRaw>` / `linkage:<eventId>` / `alarm:<alarmId>`。 */
  id: string
  source: EventSourceKind
  deviceId: string
  /** 设备名（读侧快照，设备改名后旧事件不追改）。 */
  deviceName: string
  /** 事件时刻（epoch ms）。 */
  at: number
  /**
   * 这个时刻是否是**换算出来的近似值**。
   *
   * `true` 出现在两种情形：由设备时间戳按单位假设换算（相机），或设备根本没给
   * 时间、用的是读取时刻。声纹设备给的 `alarm_time` 本来就是毫秒，为 `false`。
   */
  atApproximate: boolean
  severity: EventSeverity
  /** 稳定种类标识，渲染层按 `domain.eventKind.*` 翻译。 */
  kind: EventKind
  acknowledged: boolean
  /** 本机可播放的录像行 id（联动录像 / 声纹告警录音 / 已下载的检测结果文件）。 */
  recordingId?: string
  /**
   * `recordingId` 那一行的容器。
   *
   * 存在的理由很实际：联动录像是 **MP4**，用 `<audio>` 播它只会得到一句
   * 「不是有效的 WAV」。界面据此选择视频播放器还是 `RecordingPlayer`，
   * 而不是把一个必然失败的播放器画出来。
   */
  recordingContainer?: RecordingContainerFormat
  /** 联动抓帧的存储根相对路径（有图可看，但不是可播放的录音）。 */
  frameRelativePath?: string
  metrics?: EventMetrics
  /** 联动四个动作的逐项结果，界面直接显示「录像失败：…」。 */
  linkageActions?: LinkageActionRecord[]
  /**
   * 设备回告的**原始**告警等级。
   *
   * **从不换算、从不映射成 severity**：读侧/写侧枚举冲突且真机从未回过
   * （§8.3 C21/C15）。它只作为原始证据展示。
   */
  alarmLevelRaw?: number
  /** 相机检测日志的细节（仅 `deviceDetect`）。 */
  detect?: EventDetectDetail
  /** 声纹告警的细节（仅 `localAlarm`）。 */
  localAlarm?: EventLocalAlarmDetail
}

// ---------------------------------------------------------------------------
// 标识构造
// ---------------------------------------------------------------------------

/** 三路来源的 id 前缀。取值是 `EventSourceKind` 的机器可读短名。 */
export const EVENT_ID_PREFIX: Readonly<Record<EventSourceKind, string>> = {
  deviceDetect: 'detect',
  linkage: 'linkage',
  localAlarm: 'alarm'
}

const ID_SEPARATOR = ':'

/** 缺失数值字段在 id 里的占位符（与联动的事件身份同一约定）。 */
function idSegment(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '-'
  return String(Math.trunc(value))
}

/** `detect:<deviceId>:<logId>:<startTimeRaw>`。 */
export function deviceDetectEntryId(
  deviceId: string,
  logId: number | undefined,
  startTimeRaw: number | undefined
): string {
  return [
    EVENT_ID_PREFIX.deviceDetect,
    deviceId,
    idSegment(logId),
    idSegment(startTimeRaw)
  ].join(ID_SEPARATOR)
}

/** `linkage:<eventId>`（eventId 自身是 `deviceId:logId:startTime`）。 */
export function linkageEntryId(eventId: string): string {
  return `${EVENT_ID_PREFIX.linkage}${ID_SEPARATOR}${eventId}`
}

/** `alarm:<alarmId>`。 */
export function localAlarmEntryId(alarmId: string): string {
  return `${EVENT_ID_PREFIX.localAlarm}${ID_SEPARATOR}${alarmId}`
}

/** 从一条 id 还原来源；前缀不认识时返回 `undefined`（不猜）。 */
export function eventSourceFromEntryId(id: string): EventSourceKind | undefined {
  const prefix = id.split(ID_SEPARATOR)[0]
  return EVENT_SOURCE_KINDS.find((source) => EVENT_ID_PREFIX[source] === prefix)
}

/** 取出前缀之后的部分（联动的 eventId、声纹的 alarmId、检测的其余段）。 */
export function eventEntryIdPayload(id: string): string {
  const index = id.indexOf(ID_SEPARATOR)
  return index < 0 ? '' : id.slice(index + 1)
}

/** 检测结果文件对应的录像行 `remote_recording_id`。 */
export function detectRemoteRecordingId(logId: number, kind: Fa371ResultFileKind): string {
  return `${EVENT_ID_PREFIX.deviceDetect}${ID_SEPARATOR}${Math.trunc(logId)}${ID_SEPARATOR}${kind}`
}

// ---------------------------------------------------------------------------
// 扩展名 -> 容器（纯函数）
// ---------------------------------------------------------------------------

/**
 * 扩展名到容器的映射。
 *
 * 只收录 `RecordingContainerFormat` 里确实存在的取值。`jpeg` 归到 `jpg`：这两个
 * 扩展名指的是**同一种**格式（JPEG），这不是猜测；除此之外不作任何归并
 * （例如 `.txt` 不会变成 `csv`）。
 */
const EXTENSION_CONTAINERS: Readonly<Record<string, RecordingContainerFormat>> = {
  wav: 'wav',
  wave: 'wav',
  flac: 'flac',
  mp4: 'mp4',
  m4v: 'mp4',
  jpg: 'jpg',
  jpeg: 'jpg',
  png: 'png',
  csv: 'csv',
  bin: 'bin',
  nc: 'nc'
}

/**
 * 由文件名推导容器格式。
 *
 * 认不出来（没有扩展名、扩展名陌生）时返回 `'unknown'`——设备把文件名给了我们，
 * 但一个陌生的扩展名不能变成任何具体容器。返回值一定落在
 * `RecordingContainerFormat` 内（该类型由 `isRecordingContainerFormat` 守护）。
 */
export function deriveRecordingContainer(fileName: string): RecordingContainerFormat {
  const match = /\.([A-Za-z0-9]+)\s*$/.exec(fileName.trim())
  if (!match) return 'unknown'
  const extension = match[1]?.toLowerCase() ?? ''
  const container = EXTENSION_CONTAINERS[extension]
  return container !== undefined && isRecordingContainerFormat(container) ? container : 'unknown'
}

// ---------------------------------------------------------------------------
// 等级推导（显式的、可测试的规则）
// ---------------------------------------------------------------------------

/**
 * 由来源与已有证据推导等级。
 *
 * **为什么两路来源永远是 `'unknown'`**
 *   相机：`alarm_level` 的枚举自相矛盾且从未在真机上出现过（§8.3 C21/C15），
 *         把它当等级就是把一个未验证的数字渲染成「严重」。
 *   联动：待处理记录里的 `alarmLevelRaw` 同样是上面那个字段，未验证。
 *
 * **为什么声纹告警是 `'warning'`**
 *   这不是从设备读到的等级（AE08 的告警协议里没有等级字段），而是**这条记录
 *   本身的语义**：`alarms` 表里的行只在设备上报过非零告警位时才存在
 *   （`AlarmService.ingest` 会丢弃 mask 为 0 的负载）。本函数把这件事写在一处、
 *   写在代码里，而不是让每个页面自己决定。
 *
 * 未来的设备若给出可验证的等级，只需要在这里加一个分支。
 */
export function deriveEventSeverity(
  source: EventSourceKind,
  _evidence?: { alarmLevelRaw?: number }
): EventSeverity {
  return source === 'localAlarm' ? 'warning' : 'unknown'
}

// ---------------------------------------------------------------------------
// 查询与结果
// ---------------------------------------------------------------------------

/**
 * 每页条数上限。
 *
 * `EVENT_CENTER_PER_SOURCE_HARD_CAP` 是**每路来源**在一次查询里最多取回的候选数：
 * 合并后的页必须由主进程装配（三路来源有三个所有者，见 `event-center-service.ts`），
 * 所以每一路都必须有一个显式上限，否则「一个页面的查询」可以变成「把设备十年
 * 的日志全部拉进内存」。截断时 `EventCenterPage.truncated` 为 true，绝不静默丢弃。
 */
export const EVENT_CENTER_DEFAULT_LIMIT = 50
export const EVENT_CENTER_MAX_LIMIT = 500
export const EVENT_CENTER_PER_SOURCE_HARD_CAP = 500

/** 取回一页所需的每路候选上限：至少 `limit + offset`，并封顶在硬上限。 */
export function eventCenterPerSourceCap(limit: number, offset: number): number {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : EVENT_CENTER_DEFAULT_LIMIT
  const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0
  return Math.min(
    EVENT_CENTER_PER_SOURCE_HARD_CAP,
    Math.max(1, safeLimit + safeOffset)
  )
}

export interface EventCenterQuery {
  deviceId?: string
  sources?: EventSourceKind[]
  /** 闭区间 epoch ms。 */
  from?: number
  to?: number
  acknowledged?: boolean
  severity?: EventSeverity
  limit: number
  offset: number
}

/**
 * 一路来源在一次查询里的读况。
 *
 * 存在的理由是「诚实降级」：相机离线时另外两路必须照常渲染，而失败**不得**
 * 被吞掉、也不得变成让整页为空的异常。所以失败以 per-source 状态回到界面。
 */
export interface EventSourceStatus {
  source: EventSourceKind
  ok: boolean
  /** 失败原因（原始诊断文本）。`ok` 为 true 时缺省。 */
  error?: string
  /** 本次这一路贡献的候选条数（过滤前）。 */
  items: number
  /** 因为每路上限被截掉的条数；0 表示没有截断。 */
  truncated: number
  /** 设备没给时间、只能用读取时刻排序的条数（只有检测日志会出现）。 */
  untimed: number
}

export interface EventCenterPage {
  items: EventCenterEntry[]
  /**
   * 合并 + 过滤后的候选池总条数。
   *
   * **当 `truncated` 为 true 时这是下界而不是真值**：每路来源都只取回了上限之内
   * 的候选，主进程无法在不读全量的前提下知道真实总数。与其编一个精确数字，
   * 不如把这件事写在类型里。
   */
  total: number
  /** 候选池里各来源的条数（在分页之前统计，因此各值之和等于 `total`）。 */
  countsBySource: Record<EventSourceKind, number>
  /** 是否有任何一路来源触到了上限。 */
  truncated: boolean
  /** 逐来源读况（含失败原因）。 */
  sources: EventSourceStatus[]
}

// ---------------------------------------------------------------------------
// 确认
// ---------------------------------------------------------------------------

export interface EventAcknowledgePerSource {
  source: EventSourceKind
  /** 真正被改动的条数。 */
  acknowledged: number
  /**
   * 该来源**没有**确认能力。
   *
   * 目前只有 `deviceDetect`：FA371 的 32 个开放接口里没有任何一个能确认检测日志
   * （手册 §3 总表），所以请求里的这类 id 会被明确拒绝，而不是静默忽略。
   */
  unsupported?: boolean
  /** 失败原因。 */
  error?: string
}

export interface EventAcknowledgeResult {
  /** 三路来源合计改动的条数。 */
  acknowledged: number
  perSource: EventAcknowledgePerSource[]
  /**
   * 前缀无法识别、因而**没有被处理**的 id 条数。
   *
   * 单独计数而不是静默丢弃：一个来自旧版本或伪造的 id 必须能被看见。
   */
  unrecognised: number
}

// ---------------------------------------------------------------------------
// 检测库（相机）与下载
// ---------------------------------------------------------------------------

/**
 * 设备侧一条检测日志的只读视图（`detect-library-service.list()` 的产出）。
 *
 * 它**不是** `EventCenterEntry`：库列表回答「设备上有哪些检测」，事件中心回答
 * 「发生过什么事」。两者共用同一份映射结果，但阶段不同。
 */
export interface EventDetectLogView {
  deviceId: string
  logId?: number
  startTimeRaw?: number
  /**
   * 按单位假设换算出的 epoch ms；设备没给时间、或单位未知时缺省。
   * 它永远是**近似值**（设备从不声明单位）。
   */
  startTimeMs?: number
  atApproximate: boolean
  timeUnit: Fa371TimestampUnit
  savingPath?: string
  detectMode?: number
  status?: number
  isAlarm?: boolean
  alarmLevelRaw?: number
  /** 检测日志里的数值指标（声场强度 / 泄漏量 / 泄漏成本），缺失即缺省。 */
  metrics?: EventMetrics
  files: EventDetectFile[]
}

export interface EventDetectLibraryPage {
  deviceId: string
  items: EventDetectLogView[]
  /**
   * 设备自己的 `logs_count`。
   *
   * **它不是分页信息**：手册没有给 `/detect_logs` 定义任何分页参数（§8.3 C14），
   * 真机返回的是一个整批数组。所以这里如实把设备的计数带出来，并显式声明
   * `paging: 'none'`——「本次没有做服务端分页」。
   */
  logsCount?: number
  /** 本次是否做了服务端分页。固定 `'none'`，把「我们到底做了什么」写进类型。 */
  paging: 'none'
}

export interface EventDetectDownloadInput {
  deviceId: string
  logId: number
  /** 用于在日志列表里认领正确的那一条（同编号不同时刻是两件事）。 */
  startTimeRaw?: number
  kind: Fa371ResultFileKind
}

export interface EventDetectDownloadResult {
  deviceId: string
  logId: number
  kind: Fa371ResultFileKind
  /** 登记/复用的录像行 id。 */
  recordingId: string
  /** 存储根相对路径。 */
  relativePath: string
  fileName: string
  container: RecordingContainerFormat
  /**
   * 音频编码：**只有**容器确实是 wav 时才是 `'wav'`，否则 `null`
   * （`null` 是「已知的没有」，与「不知道」不同）。
   */
  audioFormat: 'wav' | null
  bytes: number
  /** true 表示这一行与文件都已经存在，本次没有重新写盘（下载是幂等的）。 */
  reused: boolean
}

/** 下载进度阶段（稳定标识，渲染层按 `eventsUi.progress.*` 翻译）。 */
export type EventDownloadStage =
  | 'starting'
  | 'fetching'
  | 'verifying'
  | 'registering'
  | 'done'
  | 'reused'
  | 'failed'

export const EVENT_DOWNLOAD_STAGES: readonly EventDownloadStage[] = [
  'starting',
  'fetching',
  'verifying',
  'registering',
  'done',
  'reused',
  'failed'
]

/**
 * 一次下载的进度事件。
 *
 * **没有百分比**：`HttpTransport` 把响应体一次性读出来，中间层拿不到
 * `Content-Length` 与已读字节数，所以这里只报「进行到哪一步」。编一个假进度条
 * 比没有进度条更糟。
 */
export interface EventDownloadProgress {
  deviceId: string
  logId: number
  kind: Fa371ResultFileKind
  stage: EventDownloadStage
  fileName?: string
  bytes?: number
  error?: string
}

// ---------------------------------------------------------------------------
// 主进程合并时用到的原始类型（集中在一处，避免服务里散落 import）
// ---------------------------------------------------------------------------

/** 事件中心需要的本地录像读取能力（由 `RecordingRepository` 提供）。 */
export interface EventRecordingLookup {
  /** 按 id 取一行（判断容器，决定用视频还是音频播放器）。 */
  findById(id: string): Recording | undefined
  /** 一台设备已登记的录像行（有界），用于把检测结果文件跟已下载的行对上。 */
  listByDevice(deviceId: string): Recording[]
}

/** 事件中心需要的声纹告警读取能力（由 `AlarmRepository` 提供）。 */
export interface EventAlarmLookup {
  query(query: AlarmQuery): AlarmPage
  acknowledge(ids: readonly string[], acknowledged: boolean): number
}
