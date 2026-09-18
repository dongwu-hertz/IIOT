/**
 * 事件中心「告警视图模型」与筛选/聚合的**纯函数**（规格 §16.2 / §16.3）。
 *
 * 为什么要有这一层（而不是让 `EventCenterView.vue` 直接读 `EventCenterEntry`）：
 *
 *   1. **规格 §16.2 把 `AlertViewModel` 定成了界面契约**。五级等级、状态机、证据摘要
 *      都挂在它身上；后面的抽屉（Phase 4）、状态机（Phase 5）、聚合（Phase 6）都吃这一个
 *      模型。先把适配器立起来，后面几段就不必回头改一遍渲染层。
 *   2. **我们的四级 ≠ 规格的五级**。`EventSeverity` 是**领域**取值（`'unknown'` 是
 *      合法且预期的：相机 `alarm_level` 从未在真机上出现过，声纹协议里根本没有等级
 *      字段），而规格 §2.3 的五级是**界面**词汇。两者之间的换算只写在
 *      `alertSeverityOf()` 一个函数里 —— 这是 Phase 5 做等级迁移时唯一要改的地方。
 *   3. **纯函数可单测**。渲染层拿不到 `@shared/*` 之外的东西（测试只重写 `@shared` /
 *      `@main` 两个别名），所以筛选匹配、计数、KPI 这些"算错了没人看得出来"的东西
 *      必须住在 shared 里。
 *
 * 这里**没有 i18n**：只产出目录键（`labelKey` / `titleKey`），翻译由渲染层做。
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import type {
  EventCenterEntry,
  EventKind,
  EventSeverity,
  EventSourceKind
} from './event-center'
import { EVENT_SOURCE_KINDS } from './event-center'
import type { DeviceKind } from './models'

// ---------------------------------------------------------------------------
// 等级：规格 §2.3 的五级
// ---------------------------------------------------------------------------

/** 规格 §2.3 的五档等级（界面词汇）。 */
export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export const ALERT_SEVERITIES: readonly AlertSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info'
]

export function isAlertSeverity(value: unknown): value is AlertSeverity {
  return typeof value === 'string' && (ALERT_SEVERITIES as readonly string[]).includes(value)
}

/**
 * 界面上**真的会出现**的等级。
 *
 * 规格写了五档，但 `medium` / `low` 在当前的领域层里没有任何代码路径能产生
 * （`deriveEventSeverity()` 只会给出 `'warning'` 或 `'unknown'`，见
 * `event-center.ts`）。所以这两个取值**不渲染**：一个永远为 0 的筛选项、一条永远
 * 为空的色带，都是"画出来的能力"（工程规则：不存在的能力不渲染）。
 *
 * `critical` 留着：数据库的 CHECK 里有它，规则将来一旦能从证据推出严重等级，
 * 它就会开始出现。
 */
export const VISIBLE_ALERT_SEVERITIES: readonly AlertSeverity[] = ['critical', 'high', 'info']

/**
 * 我们的四级 → 规格的五级的**展示层**换算。
 *
 * | 领域（`EventSeverity`） | 界面（`AlertSeverity`） | 为什么 |
 * |------------------------|------------------------|--------|
 * | `critical`             | `critical`             | 同义 |
 * | `warning`              | `high`                 | 见下 |
 * | `info`                 | `info`                 | 同义 |
 * | `unknown`              | `info` + `severityUnknown` | 不许把"不知道"装成"提示" |
 *
 * `warning` 落在 `high` 而不是 `medium`：`deriveEventSeverity()` 的注释写明了
 * `'warning'` 不是从设备读到的等级，而是**这条记录本身的语义** —— `alarms` 表里的行
 * 只在设备上报过非零告警位时才存在。它是我们唯一站得住的等级信号；把它压到 `medium`
 * 只会让"永远为 0 的 Critical/High 占着最高两档"，而真正需要人处理的那条反而更低。
 */
export function alertSeverityOf(severity: EventSeverity): AlertSeverity {
  if (severity === 'critical') return 'critical'
  if (severity === 'warning') return 'high'
  if (severity === 'info') return 'info'
  return 'info'
}

/** `true` 表示这条事件的等级**认不出来**（界面必须显示「未知」而不是某个等级）。 */
export function isSeverityUnknown(severity: EventSeverity): boolean {
  return severity === 'unknown'
}

/** 界面等级 → 中文（四语言）标签的目录键。 */
export function alertSeverityLabelKey(severity: AlertSeverity): string {
  return `eventsUi.alertSeverity.${severity}`
}

// ---------------------------------------------------------------------------
// 状态：规格 §2.2 的状态机
// ---------------------------------------------------------------------------

/**
 * 规格 §2.2 的状态机取值。
 *
 * Phase 3 只可能产生 `'new'` / `'acknowledged'` 两个（`EventCenterEntry` 里只有
 * `acknowledged: boolean`，没有状态列也没有状态变更时刻）；`investigating` /
 * `resolved` / `closed` 属于 Phase 5 的 schema 迁移（v13）。类型先按规格写全，
 * 这样 Phase 5 加状态时渲染层不用改类型。
 */
export type AlertStatus = 'new' | 'acknowledged' | 'investigating' | 'resolved' | 'closed'

export const ALERT_STATUSES: readonly AlertStatus[] = [
  'new',
  'acknowledged',
  'investigating',
  'resolved',
  'closed'
]

export function isAlertStatus(value: unknown): value is AlertStatus {
  return typeof value === 'string' && (ALERT_STATUSES as readonly string[]).includes(value)
}

/** 状态标签的目录键。 */
export function alertStatusLabelKey(status: AlertStatus): string {
  return `eventsUi.alertStatus.${status}`
}

// ---------------------------------------------------------------------------
// 指标
// ---------------------------------------------------------------------------

/** 事件中心会展示的指标字段（都是 `EventMetrics` 的字段名）。 */
export type AlertMetricField =
  | 'spl'
  | 'mainFrequency'
  | 'smoothness'
  | 'bandEnergyRatio'
  | 'soundmapIntensity'
  | 'leakVolume'
  | 'leakCost'

export interface AlertMetricDescriptor {
  field: AlertMetricField
  /** 标签的目录键（沿用各页已有的键，避免同一件事有两个名字）。 */
  labelKey: string
  /** 单位；空串表示无量纲。 */
  unit: string
  /** 固定小数位：同一指标在队列和抽屉里必须印成同一个样子。 */
  digits: number
}

/**
 * 指标的顺序与格式。
 *
 * 顺序是**声学含义**的顺序（声压级 → 主频 → 平滑度 → 带能量比 → 声场强度 → 泄漏量 →
 * 泄漏成本），不是字典序：队列的 Standard 模式只取前几个，取到的应该是操作员最关心的。
 */
export const ALERT_METRICS: readonly AlertMetricDescriptor[] = [
  { field: 'spl', labelKey: 'metrics.spl', unit: 'dB', digits: 2 },
  { field: 'mainFrequency', labelKey: 'metrics.mainFrequency', unit: 'Hz', digits: 2 },
  { field: 'smoothness', labelKey: 'metrics.smoothness', unit: '', digits: 3 },
  { field: 'bandEnergyRatio', labelKey: 'metrics.bandEnergyRatio', unit: '', digits: 3 },
  { field: 'soundmapIntensity', labelKey: 'eventsUi.metricSoundmapIntensity', unit: '', digits: 2 },
  { field: 'leakVolume', labelKey: 'eventsUi.metricLeakVolume', unit: '', digits: 3 },
  { field: 'leakCost', labelKey: 'eventsUi.metricLeakCost', unit: '', digits: 3 }
]

export interface AlertMetric {
  field: AlertMetricField
  labelKey: string
  unit: string
  digits: number
  value: number
}

/**
 * 一条事件上**真的存在**的指标。
 *
 * 不存在的字段直接不产出（绝不补 0）：`0 dB` 与「设备没报这个数」在声学监测里是完全
 * 不同的两件事（`MetricCard.vue` 的模块注释写的是同一条规矩）。
 */
export function alertMetrics(entry: EventCenterEntry): AlertMetric[] {
  const metrics = entry.metrics
  if (!metrics) return []
  const out: AlertMetric[] = []
  for (const descriptor of ALERT_METRICS) {
    const value = metrics[descriptor.field]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    out.push({ ...descriptor, value })
  }
  return out
}

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

/**
 * 队列与抽屉消费的告警视图模型（规格 §16.2）。
 *
 * `entry` 原样带着：确认、下载结果文件、播放录像这些动作仍然按**领域**模型工作，
 * 视图模型只负责"怎么显示"。把两者绑在一起是刻意的 —— 否则抽屉点一下要按 id
 * 再去 store 里查一遍，多出一条可能与列表不一致的路径。
 */
export interface AlertViewModel {
  id: string
  /** 界面等级（规格五级中我们会出现的那几档之一）。 */
  severity: AlertSeverity
  /** 等级认不出来时为 `true`：界面显示「未知」，KPI 不把它算进任何一档。 */
  severityUnknown: boolean
  /** 设备回的原始等级（未换算），仅作证据展示。 */
  severityRaw: EventSeverity
  status: AlertStatus
  /**
   * 这一路来源**没有确认能力**（相机检测日志没有确认接口）。
   *
   * 这样的行状态恒为 `'new'` —— 但把它算进「未确认」会让 KPI 永远挂着一堆
   * 谁也点不掉的数字，所以界面必须区分「等着人确认」与「没人能确认」。
   */
  statusLocked: boolean
  /** 标题的目录键（`domain.eventKind.<kind>`）。 */
  titleKey: string
  kind: EventKind
  source: EventSourceKind
  deviceId: string
  deviceName: string
  at: number
  atApproximate: boolean
  metrics: AlertMetric[]
  /** 本机有这段录像（可播放或可打开）。 */
  hasRecording: boolean
  /** 有联动抓帧（当前只存了相对路径，界面按路径显示）。 */
  hasFrame: boolean
  /** 设备侧的结果文件个数（相机检测日志才有）。 */
  evidenceFileCount: number
  /**
   * 同一次触发被重复上报的次数（规格 §14.3）。
   *
   * Phase 6（聚合）之前恒为 1 —— 恒为 1 是**事实**（我们确实没有做聚合），不是
   * 占位符；界面在它等于 1 时不渲染"×N"。
   */
  occurrenceCount: number
  /**
   * 首次 / 最后一次探测到（规格 §16.2 的 `firstDetectedAt` / `lastDetectedAt`）。
   *
   * 聚合（Phase 6）之前两者都等于 `at`：一条事件只有一个时刻。Phase 6 把同一次触发的
   * 连续上报并起来时，只改适配器里的这两个数，界面与抽屉不必动。
   */
  firstDetectedAt: number
  lastDetectedAt: number
  /**
   * 持续时长（ms）。聚合之前是 **0**（一条瞬时事件没有时长），
   * 抽屉据此显示「—」而不是「0 秒」。
   */
  durationMs: number
  entry: EventCenterEntry
}

/** 相机检测日志没有确认接口（`event-center-service.ts` 的 `acknowledge()` 也这么分派）。 */
function isStatusLocked(source: EventSourceKind): boolean {
  return source === 'deviceDetect'
}

export function toAlertViewModel(entry: EventCenterEntry): AlertViewModel {
  return {
    id: entry.id,
    severity: alertSeverityOf(entry.severity),
    severityUnknown: isSeverityUnknown(entry.severity),
    severityRaw: entry.severity,
    status: entry.acknowledged ? 'acknowledged' : 'new',
    statusLocked: isStatusLocked(entry.source),
    titleKey: `domain.eventKind.${entry.kind}`,
    kind: entry.kind,
    source: entry.source,
    deviceId: entry.deviceId,
    deviceName: entry.deviceName,
    at: entry.at,
    atApproximate: entry.atApproximate,
    metrics: alertMetrics(entry),
    hasRecording: entry.recordingId !== undefined,
    hasFrame: entry.frameRelativePath !== undefined,
    evidenceFileCount: entry.detect?.files.length ?? 0,
    occurrenceCount: 1,
    firstDetectedAt: entry.at,
    lastDetectedAt: entry.at,
    durationMs: 0,
    entry
  }
}

export function toAlertViewModels(entries: readonly EventCenterEntry[]): AlertViewModel[] {
  return entries.map(toAlertViewModel)
}

// ---------------------------------------------------------------------------
// KPI（规格 §8）
// ---------------------------------------------------------------------------

export interface EventKpis {
  /** 参与统计的告警条数（= 界面已加载的行数，见 `kpiScope` 说明）。 */
  total: number
  critical: number
  high: number
  /** 等级未知（`severityUnknown`）的条数：单独一档，不混进 `info`。 */
  unknownSeverity: number
  /** 等着人确认的条数（排除没有确认能力的来源）。 */
  unacknowledged: number
  /**
   * 平均确认耗时（ms）。
   *
   * **恒为 `null`**：三路来源都没有把"确认时刻"带进 `EventCenterEntry`
   * （`alarms` / 联动待处理记录里有没有这一列，本模块无从知道）。界面据此显示
   * 「—」而不是 0 —— 0 秒会被读成"确认得飞快"。
   */
  avgAckMs: number | null
  /** 聚合出的事件数（规格 §14）。Phase 6 才实现，所以恒为 `null`（界面不显示这一格）。 */
  incidents: number | null
}

/**
 * KPI 统计。
 *
 * **作用域**：`alerts` 是界面**已加载**的那一页（`EventCenterPage.items`），不是全库。
 * 主进程的 `severity` 过滤是**按来源整路跳过**的（`event-center-service.ts`：
 * `input.severity !== deriveEventSeverity(source)` 直接返回空），所以"整个筛选结果"
 * 的等级分布拿不到 —— 要拿就得在主进程再聚合一遍。界面因此把作用域印在 KPI 条上
 * （`eventsUi.kpiScope`），而不是把一页的数字说成全量。
 */
export function eventKpis(alerts: readonly AlertViewModel[]): EventKpis {
  let critical = 0
  let high = 0
  let unknownSeverity = 0
  let unacknowledged = 0
  for (const alert of alerts) {
    if (alert.severityUnknown) unknownSeverity += 1
    else if (alert.severity === 'critical') critical += 1
    else if (alert.severity === 'high') high += 1
    if (!alert.statusLocked && alert.status === 'new') unacknowledged += 1
  }
  return {
    total: alerts.length,
    critical,
    high,
    unknownSeverity,
    unacknowledged,
    avgAckMs: null,
    incidents: null
  }
}

// ---------------------------------------------------------------------------
// 筛选（规格 §9）
// ---------------------------------------------------------------------------

/** 确认状态筛选。用词而非 `'true'` / `'false'`：查询里再换成布尔。 */
export type AckFilter = 'all' | 'unacknowledged' | 'acknowledged'

/** 等级筛选取值：界面等级、`'unknown'`（等级未知）、或空（全部）。 */
export type EventSeverityFilter = '' | AlertSeverity | 'unknown'

export const EVENT_SEVERITY_FILTERS: readonly Exclude<EventSeverityFilter, ''>[] = [
  'critical',
  'high',
  'info',
  'unknown'
]

export interface EventQueueFilter {
  /** 关键字。**只在已加载的这一页里匹配**（见 `matchEventSearch` 的注释）。 */
  search: string
  deviceId: string
  source: '' | EventSourceKind
  severity: EventSeverityFilter
  /** `datetime-local` 的原始串（空串 = 不限）。 */
  from: string
  to: string
  ack: AckFilter
}

export const EMPTY_EVENT_FILTER: EventQueueFilter = {
  search: '',
  deviceId: '',
  source: '',
  severity: '',
  from: '',
  to: '',
  ack: 'all'
}

export function emptyEventFilter(): EventQueueFilter {
  return { ...EMPTY_EVENT_FILTER }
}

export function isEventFilterActive(filter: EventQueueFilter): boolean {
  return (
    filter.search.trim() !== '' ||
    filter.deviceId !== '' ||
    filter.source !== '' ||
    filter.severity !== '' ||
    filter.from !== '' ||
    filter.to !== '' ||
    filter.ack !== 'all'
  )
}

/**
 * 界面等级 → 查询参数里的领域等级。
 *
 * `'unknown'` 直接对应领域里的 `'unknown'`（那是合法取值，不是兜底）；
 * `'medium'` / `'low'` 返回 `undefined` —— 它们不可能出现在数据里，所以界面上也不该
 * 有对应的可选项（见 `VISIBLE_ALERT_SEVERITIES`）。
 */
export function querySeverityFor(value: EventSeverityFilter): EventSeverity | undefined {
  if (value === '') return undefined
  if (value === 'unknown') return 'unknown'
  if (value === 'critical') return 'critical'
  if (value === 'high') return 'warning'
  if (value === 'info') return 'info'
  return undefined
}

/** 查询回来的领域等级 → 界面选中的等级（把当前筛选显示回界面上时用）。 */
export function severityFilterFor(severity: EventSeverity): Exclude<EventSeverityFilter, ''> {
  if (severity === 'unknown') return 'unknown'
  const mapped = alertSeverityOf(severity)
  return mapped === 'medium' || mapped === 'low' ? 'info' : mapped
}

export function ackFilterToQuery(ack: AckFilter): boolean | undefined {
  if (ack === 'acknowledged') return true
  if (ack === 'unacknowledged') return false
  return undefined
}

/** 关键字匹配用的文本（**全部**来自这条事件自己，没有外部输入）。 */
function alertHaystack(alert: AlertViewModel, kindText: string): string {
  const parts = [
    alert.deviceName,
    kindText,
    alert.id,
    alert.source,
    alert.severity,
    alert.severityUnknown ? 'unknown' : '',
    alert.status
  ]
  for (const metric of alert.metrics) parts.push(`${metric.field} ${metric.value}`)
  return parts.join(' ').toLowerCase()
}

/**
 * 关键字匹配。
 *
 * **只在已加载的这一页里匹配**：主进程的查询没有关键字参数，而"给三路来源各加一个
 * 服务端搜索"是三件不同的事（相机是设备 HTTP、联动是内存、声纹是 SQLite）。界面因此
 * 必须把这件事说出来（`eventsUi.searchScope`），不能让人以为搜的是全库。
 */
export function matchEventSearch(alert: AlertViewModel, query: string, kindText: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return alertHaystack(alert, kindText).includes(needle)
}

export interface EventFilterCounts {
  bySeverity: Record<AlertSeverity, number>
  /** 等级未知的条数（不混进 `bySeverity.info`）。 */
  unknownSeverity: number
  bySource: Record<EventSourceKind, number>
  /**
   * 按设备 id 的条数。
   *
   * 键是**这一页里出现过的**设备 id（不是设备表里的全部设备）：没出现的查不到就是 0，
   * 界面按 `byDevice[id] ?? 0` 取，于是"这台设备这一页没有事件"与"这台设备不存在"
   * 在显示上不会混淆。
   */
  byDevice: Record<string, number>
  /** 已经确认过的条数。 */
  acknowledged: number
  /**
   * 等着人确认的条数。
   *
   * 与 KPI 同一口径：**排除**没有确认能力的来源（相机检测日志）。否则筛选面板上会挂着一个
   * 谁也点不掉的「未确认 37 条」。
   */
  unacknowledged: number
}

/**
 * 筛选面板上的计数。
 *
 * 口径与 KPI 相同：**已加载的这一页**。面板上因此写着当前页的条数（`panelScope` 同一句话），
 * 而不是把一页的分布当成全库分布。
 */
export function eventFilterCounts(alerts: readonly AlertViewModel[]): EventFilterCounts {
  const bySeverity: Record<AlertSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0
  }
  const bySource = {} as Record<EventSourceKind, number>
  for (const source of EVENT_SOURCE_KINDS) bySource[source] = 0
  const byDevice: Record<string, number> = {}
  let unknownSeverity = 0
  let acknowledged = 0
  let unacknowledged = 0
  for (const alert of alerts) {
    if (alert.severityUnknown) unknownSeverity += 1
    else bySeverity[alert.severity] += 1
    bySource[alert.source] += 1
    byDevice[alert.deviceId] = (byDevice[alert.deviceId] ?? 0) + 1
    if (alert.status === 'acknowledged') acknowledged += 1
    else if (!alert.statusLocked) unacknowledged += 1
  }
  return { bySeverity, unknownSeverity, bySource, byDevice, acknowledged, unacknowledged }
}

// ---------------------------------------------------------------------------
// 内置视图（规格 §9.4 Saved Views）
// ---------------------------------------------------------------------------

/**
 * 内置视图。
 *
 * 只有**查询真的支持**的筛选才做成视图（设备 / 来源 / 等级 / 时间 / 确认状态）。
 * `medium` / `low` 不做：没有代码路径能产生它们。
 *
 * 时间窗口用"从现在往前推的毫秒数"（`spanMs`）而不是"今天 00:00"：epoch 减法不涉及
 * 时区与午夜边界，测试里也就没有"跑在哪个时区"的第二种结果。界面把窗口的**语义**
 * 写进标签（「近 24 小时」），不假装它是"今天"。
 */
export interface EventSavedView {
  id: string
  labelKey: string
  severity?: Exclude<EventSeverityFilter, ''>
  ack?: AckFilter
  spanMs?: number
}

const HOUR_MS = 3_600_000

export const EVENT_SAVED_VIEWS: readonly EventSavedView[] = [
  { id: 'all', labelKey: 'eventsUi.savedView.all' },
  { id: 'critical', labelKey: 'eventsUi.savedView.critical', severity: 'critical' },
  { id: 'high', labelKey: 'eventsUi.savedView.high', severity: 'high' },
  { id: 'unacknowledged', labelKey: 'eventsUi.savedView.unacknowledged', ack: 'unacknowledged' },
  { id: 'last24h', labelKey: 'eventsUi.savedView.last24h', spanMs: 24 * HOUR_MS },
  { id: 'last7d', labelKey: 'eventsUi.savedView.last7d', spanMs: 7 * 24 * HOUR_MS }
]

/** 视图 → 起始时刻（epoch ms）。没有时间窗口的视图返回 `undefined`。 */
export function savedViewFromMs(view: EventSavedView, nowMs: number): number | undefined {
  if (view.spanMs === undefined) return undefined
  return nowMs - view.spanMs
}

// ---------------------------------------------------------------------------
// 视图偏好与筛选的存取（规格 §16.3）
// ---------------------------------------------------------------------------

export type EventViewMode = 'compact' | 'standard' | 'evidence'

export const EVENT_VIEW_MODES: readonly EventViewMode[] = ['compact', 'standard', 'evidence']

export function isEventViewMode(value: unknown): value is EventViewMode {
  return typeof value === 'string' && (EVENT_VIEW_MODES as readonly string[]).includes(value)
}

/**
 * 三种视图模式的行高（规格 §10.2：Standard 88 / Evidence 104；Compact 是规格没写数值的
 * 那一档，取 56 —— 它必须比 Standard 明显矮，否则"紧凑"没有意义）。
 */
export const EVENT_ROW_HEIGHT: Readonly<Record<EventViewMode, number>> = {
  compact: 56,
  standard: 88,
  evidence: 104
}

/** localStorage 键。与 `AppSidebar` 的 `hertzinno.sidebar.collapsed` 同一套命名。 */
export const EVENT_FILTER_STORAGE_KEY = 'hertzinno.eventCenter.filters'
export const EVENT_VIEW_MODE_STORAGE_KEY = 'hertzinno.eventCenter.viewMode'

export function parseEventViewMode(value: unknown): EventViewMode {
  return isEventViewMode(value) ? value : 'standard'
}

/** 筛选的序列化（存 localStorage / 进 URL 都用它，于是两者不会分叉）。 */
export function serializeEventFilter(filter: EventQueueFilter): string {
  return JSON.stringify({
    search: filter.search,
    deviceId: filter.deviceId,
    source: filter.source,
    severity: filter.severity,
    from: filter.from,
    to: filter.to,
    ack: filter.ack
  })
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 反序列化：**任何**认不出来的东西都退回默认值。
 *
 * 为什么不抛错：这份数据来自 localStorage 与手改过的 URL，坏值（半截 JSON、旧的
 * 等级取值、别人塞的字符串）只会让页面打不开，而"筛选条件丢了"是可以接受的后果。
 * 逐个字段收窄，而不是 `JSON.parse` 之后直接当 `EventQueueFilter` 用。
 */
export function parseEventFilter(raw: unknown): EventQueueFilter {
  let value: unknown = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') return emptyEventFilter()
    try {
      value = JSON.parse(text)
    } catch {
      return emptyEventFilter()
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return emptyEventFilter()
  }
  const record = value as Record<string, unknown>
  const filter = emptyEventFilter()
  filter.search = asString(record.search)
  filter.deviceId = asString(record.deviceId)
  const source = asString(record.source)
  filter.source = (EVENT_SOURCE_KINDS as readonly string[]).includes(source)
    ? (source as EventSourceKind)
    : ''
  const severity = asString(record.severity)
  filter.severity = (EVENT_SEVERITY_FILTERS as readonly string[]).includes(severity)
    ? (severity as EventSeverityFilter)
    : ''
  filter.from = asString(record.from)
  filter.to = asString(record.to)
  const ack = asString(record.ack)
  filter.ack = ack === 'acknowledged' || ack === 'unacknowledged' ? ack : 'all'
  return filter
}

/** 进 URL 的查询串：只写**非默认**的字段（链接短，且默认值改了不会留下旧参数）。 */
export function eventFilterToQuery(filter: EventQueueFilter): Record<string, string> {
  const query: Record<string, string> = {}
  if (filter.search.trim() !== '') query.search = filter.search
  if (filter.deviceId !== '') query.device = filter.deviceId
  if (filter.source !== '') query.source = filter.source
  if (filter.severity !== '') query.severity = filter.severity
  if (filter.from !== '') query.from = filter.from
  if (filter.to !== '') query.to = filter.to
  if (filter.ack !== 'all') query.ack = filter.ack
  return query
}

/** URL 里我们认识的筛选键（`eventFilterToQuery` 写出去的就是这些）。 */
export const EVENT_FILTER_QUERY_KEYS: readonly string[] = [
  'search',
  'device',
  'source',
  'severity',
  'from',
  'to',
  'ack'
]

/**
 * 地址栏里是否**明确写了**筛选。
 *
 * 用途是区分「地址里没写」（→ 用 localStorage 里记住的筛选）与「地址里明确写了空筛选」
 * （→ 就用空筛选）。少了这一条，清空筛选之后刷新会被本机记着的旧条件顶回来 ——
 * 那正是"我明明清了怎么又回来了"这类问题的来源。
 */
export function hasEventFilterQuery(query: Record<string, unknown> | null | undefined): boolean {
  if (!query) return false
  return EVENT_FILTER_QUERY_KEYS.some((key) => {
    const value = query[key]
    if (typeof value === 'string') return value !== ''
    if (Array.isArray(value)) return value.length > 0
    return value !== undefined && value !== null
  })
}

/** 从 URL 查询串还原筛选（未知键忽略，坏值退回默认）。 */
export function eventFilterFromQuery(query: Record<string, unknown> | null | undefined): EventQueueFilter {
  if (!query) return emptyEventFilter()
  return parseEventFilter({
    search: query.search,
    deviceId: query.device,
    source: query.source,
    severity: query.severity,
    from: query.from,
    to: query.to,
    ack: query.ack
  })
}

// ---------------------------------------------------------------------------
// 详情抽屉（规格 §11）
// ---------------------------------------------------------------------------

/** 规格 §11.3 的五个页签。 */
export type EventDetailTab = 'overview' | 'evidence' | 'timeline' | 'related' | 'activity'

export const EVENT_DETAIL_TABS: readonly EventDetailTab[] = [
  'overview',
  'evidence',
  'timeline',
  'related',
  'activity'
]

/**
 * **已经做出来**的页签。
 *
 * Phase 4 只交付 Overview 与 Evidence（规格 §18.1 把 Timeline / Related / Activity 排在
 * Phase 5，因为它们的素材是状态变更记录与聚合结果 —— 现在库里没有这两样）。所以页签条里
 * 只有这两个：画出三个永远空着的页签，比不画更糟（工程规则：不存在的能力不渲染）。
 */
export const IMPLEMENTED_DETAIL_TABS: readonly EventDetailTab[] = ['overview', 'evidence']

export function isEventDetailTab(value: unknown): value is EventDetailTab {
  return typeof value === 'string' && (EVENT_DETAIL_TABS as readonly string[]).includes(value)
}

export function detailTabLabelKey(tab: EventDetailTab): string {
  return `eventsUi.detailTab.${tab}`
}

/** 抽屉宽度：规格 §11.1 给的三档（Default 400 / Large screen 440 / Resizable 400–560）。 */
export const DETAIL_DRAWER_MIN = 400
export const DETAIL_DRAWER_MAX = 560
export const DETAIL_DRAWER_DEFAULT = 400
export const DETAIL_DRAWER_WIDE = 440
/**
 * "大屏"的断点取 1600：与规格 §4.1 的内边距规则（≥1600 用 32）同一条线，
 * 免得同一份规格里出现两个"大屏"。
 */
export const DETAIL_DRAWER_WIDE_VIEWPORT = 1600

export function clampDrawerWidth(value: number): number {
  if (!Number.isFinite(value)) return DETAIL_DRAWER_DEFAULT
  return Math.min(DETAIL_DRAWER_MAX, Math.max(DETAIL_DRAWER_MIN, Math.round(value)))
}

export function drawerWidthForViewport(viewportWidth: number): number {
  return viewportWidth >= DETAIL_DRAWER_WIDE_VIEWPORT ? DETAIL_DRAWER_WIDE : DETAIL_DRAWER_DEFAULT
}

/** localStorage 键（与其他视觉偏好同一套命名）。 */
export const DRAWER_WIDTH_STORAGE_KEY = 'hertzinno.eventCenter.drawerWidth'

/** 存下来的宽度：容错 + 夹到 400–560（坏值不能把抽屉变成 12px 或者半屏）。 */
export function parseDrawerWidth(raw: unknown, fallback: number = DETAIL_DRAWER_DEFAULT): number {
  const text = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
  if (text === '') return clampDrawerWidth(fallback)
  const value = Number(text)
  if (!Number.isFinite(value)) return clampDrawerWidth(fallback)
  return clampDrawerWidth(value)
}

// ---------------------------------------------------------------------------
// Overview 字段（规格 §11.4）
// ---------------------------------------------------------------------------

/**
 * 一个字段的值。
 *
 * 为什么把"值"做成带类型的东西而不是字符串：格式化（时间/时长/小数位）与翻译都在渲染层，
 * 而"这一格到底有没有值"必须在纯函数里定死 —— 例如持续时长在聚合之前**没有**值
 * （一条瞬时事件没有时长），显示 `0 秒` 会被读成"持续了 0 秒"。
 */
export type OverviewValue =
  | { kind: 'text'; text: string; mono?: boolean }
  | { kind: 'time'; at: number; approximate: boolean }
  | { kind: 'duration'; ms: number }
  | { kind: 'number'; value: number; digits: number; unit: string }
  /** 目录键（等级 / 状态 / 来源 / 事件种类）。 */
  | { kind: 'label'; labelKey: string; severity?: AlertSeverity; unknown?: boolean }
  /** 这一刻没有值：界面显示「—」。 */
  | { kind: 'empty' }

export interface OverviewField {
  labelKey: string
  value: OverviewValue
  /** 长字段（事件标识、设备目录等）跨两列（规格 §11.4）。 */
  wide?: boolean
}

/**
 * 抽屉 Overview 的属性表（规格 §11.4：2 列属性网格，长字段跨两列）。
 *
 * 规格列了 Severity / Status / First detected / Duration / AI Confidence / Occurrences。
 * 我们对得上的是前四个加 Occurrences；**AI Confidence 不做**：事件中心里没有任何一次
 * 推理（AI 标注是样本库那边的离线动作，见 `docs/BASELINE.md` §8），画一格永远是「—」的
 * 置信度会让人以为"系统看过但没给分"。资产的字段同理（我们没有 asset 这一层，设备就是
 * 我们的资产）。
 */
export function alertOverviewFields(alert: AlertViewModel): OverviewField[] {
  const fields: OverviewField[] = [
    {
      labelKey: 'eventsUi.detailSeverity',
      value: alert.severityUnknown
        ? { kind: 'label', labelKey: 'eventsUi.severityUnknown', unknown: true }
        : { kind: 'label', labelKey: alertSeverityLabelKey(alert.severity), severity: alert.severity }
    },
    {
      labelKey: 'eventsUi.overviewStatus',
      // 没有确认能力的来源（相机检测日志）显示「—」：一个谁也点不掉的「待处理」是假话。
      value: alert.statusLocked
        ? { kind: 'empty' }
        : { kind: 'label', labelKey: alertStatusLabelKey(alert.status) }
    },
    {
      labelKey: 'eventsUi.overviewFirstDetected',
      value: { kind: 'time', at: alert.firstDetectedAt, approximate: alert.atApproximate }
    },
    {
      labelKey: 'eventsUi.overviewLastDetected',
      value: { kind: 'time', at: alert.lastDetectedAt, approximate: alert.atApproximate }
    },
    {
      labelKey: 'eventsUi.overviewDuration',
      // 聚合之前没有时长可言（见 `OverviewValue` 的注释）。
      value: alert.occurrenceCount > 1 ? { kind: 'duration', ms: alert.durationMs } : { kind: 'empty' }
    },
    {
      labelKey: 'eventsUi.overviewOccurrences',
      value: { kind: 'number', value: alert.occurrenceCount, digits: 0, unit: '' }
    },
    {
      labelKey: 'eventsUi.detailSource',
      value: { kind: 'label', labelKey: `domain.eventSource.${alert.source}` }
    },
    {
      labelKey: 'eventsUi.detailKind',
      value: { kind: 'label', labelKey: alert.titleKey }
    },
    {
      labelKey: 'eventsUi.detailDevice',
      value: { kind: 'text', text: alert.deviceName }
    },
    { labelKey: 'eventsUi.detailEventId', value: { kind: 'text', text: alert.id, mono: true }, wide: true }
  ]

  for (const metric of alert.metrics) {
    fields.push({
      labelKey: metric.labelKey,
      value: { kind: 'number', value: metric.value, digits: metric.digits, unit: metric.unit }
    })
  }

  /**
   * 设备回的**原始**等级（未换算）：它是一条证据，不是我们的等级。
   * 只有真的回了才出现（相机从未回过这个字段）。
   */
  const rawLevel = alert.entry.alarmLevelRaw
  if (typeof rawLevel === 'number' && Number.isFinite(rawLevel)) {
    fields.push({
      labelKey: 'eventsUi.detailAlarmLevel',
      value: { kind: 'number', value: rawLevel, digits: 0, unit: '' }
    })
  }

  return fields
}

// ---------------------------------------------------------------------------
// Evidence：图片证据从哪来（规格 §12.1）
// ---------------------------------------------------------------------------

/**
 * 一条事件的**图片证据**出处。
 *
 * 三种来源我们真的有两种：
 *   - 联动告警：`frameRelativePath`（本机存储根下的抓帧）→ 需要一个新的"按相对路径取图"
 *     回环接口（`eventCenter.evidenceImage`）；
 *   - 声纹告警：`alarms.snapshot_dir`（球机抓图目录），已经有现成接口
 *     （`devices.alarmSnapshots(deviceId, alarmId)`，见第 8 批）→ 直接用，不重复造；
 *   - 相机检测日志：图是**设备侧的结果文件**，要操作员先下载到本机（下载后成为录像行），
 *     所以它走"文件列表"而不是这里 —— 这里返回 `null`。
 *
 * 返回 `null` 的含义是"这条路没有图"，界面据此显示「没有图片证据」，而不是画一个空框。
 */
export type EvidenceImageSource =
  | { kind: 'frame'; relativePath: string }
  | { kind: 'alarm-snapshot'; alarmId: string }

/**
 * @param deviceKind 这台设备的机型（可选）。声纹告警的球机抓图只有**听诊盒子/空气声呐**
 *   （`acclimationBox` 那一族的 `auscultationBox`）才有；AE08 这类声纹盒子根本没有抓图概念。
 *   传进来就能把"这台设备不提供图片证据"与"这次没抓到图"分开 —— 前者是 `null`
 *   （界面说「没有图片证据」），后者是 `not-captured`（界面说「设备上没有抓到图」）。
 *   机型还不知道时（设备列表没加载完）**照旧返回抓图那条路**：多试一次不会有副作用，
 *   而少试一次会让一张真的存在的图不显示。
 */
export function evidenceImageSource(
  alert: AlertViewModel,
  deviceKind?: DeviceKind
): EvidenceImageSource | null {
  const frame = alert.entry.frameRelativePath
  if (alert.source === 'linkage' && typeof frame === 'string' && frame.trim() !== '') {
    return { kind: 'frame', relativePath: frame }
  }
  if (alert.source === 'localAlarm') {
    if (deviceKind !== undefined && deviceKind !== 'auscultationBox') return null
    // 条目 id 是 `alarm:<alarmId>`，那一段就是告警 id（`eventEntryIdPayload` 同一套规则）。
    const alarmId = alert.id.startsWith('alarm:') ? alert.id.slice('alarm:'.length) : ''
    if (alarmId !== '') return { kind: 'alarm-snapshot', alarmId }
  }
  return null
}

