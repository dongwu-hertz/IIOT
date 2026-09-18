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
  EventSourceKind,
  EventStatus
} from './event-center'
import { EVENT_SOURCE_KINDS, EVENT_STATUSES, isEventStatus } from './event-center'
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
 * 七个取值全部来自规格的状态图：主线 New → Acknowledged → Investigating → Resolved →
 * Closed，加上分叉上的 **Muted** 与 **Reopened**。
 *
 * 两处读完规格之后的判断（都写在这里，免得后面有人按自己的理解改）：
 *   1. **Reassigned 不是状态**。状态图上它是 Acknowledged 的一个分叉，但"指派给谁"是
 *      `assignee` 字段，不是状态 —— 把它做成状态会出现"已指派的已确认"这种没有意义的组合。
 *      所以它落成一条 **Activity**（`kind: 'assign'`）。
 *   2. **`'acknowledged'` 与来源自己的 `acknowledged` 标志是两件事**（见 §3.12）：
 *      前者是我们自己的工作流状态，后者是来源侧的事实（联动待处理记录 / 声纹告警行）。
 *      两者一致时最好，不一致时以工作流状态为准（`AlertViewModel.status`）。
 */
export type AlertStatus = EventStatus

export const ALERT_STATUSES: readonly AlertStatus[] = EVENT_STATUSES

export function isAlertStatus(value: unknown): value is AlertStatus {
  return isEventStatus(value)
}

/**
 * 允许的状态迁移（规格 §2.2 的状态图）。
 *
 * 图上是主线 + 两条分叉，这里逐条落成表。**两处比图更宽**，都是刻意的：
 *   - `new → investigating`：操作员常常是"打开就直接查"，逼他先点一下确认只会多一次点击；
 *   - `acknowledged → resolved`：一条一看就明白的告警（例如测试触发）不必先"调查中"。
 * 反过来**比图更严**的地方也有一处：`closed` 只能回到 `reopened`（不能直接回
 * `investigating`）—— 已关闭的东西要动，必须留下"重新开启"这条记录（规格要求记原因）。
 *
 * `muted` 的分支：规格说"静默期间事件仍然记录"，所以静默不是终点，要能回到工作状态。
 */
export const ALERT_STATUS_TRANSITIONS: Readonly<Record<AlertStatus, readonly AlertStatus[]>> = {
  new: ['acknowledged', 'investigating', 'muted'],
  acknowledged: ['investigating', 'resolved', 'muted'],
  investigating: ['resolved', 'muted'],
  resolved: ['closed', 'reopened'],
  closed: ['reopened'],
  muted: ['new', 'acknowledged', 'investigating'],
  reopened: ['investigating', 'resolved']
}

export function allowedStatusTargets(from: AlertStatus): readonly AlertStatus[] {
  return ALERT_STATUS_TRANSITIONS[from]
}

export function canTransitionStatus(from: AlertStatus, to: AlertStatus): boolean {
  if (from === to) return false
  return ALERT_STATUS_TRANSITIONS[from].includes(to)
}

/** 状态标签的目录键。 */
export function alertStatusLabelKey(status: AlertStatus): string {
  return `eventsUi.alertStatus.${status}`
}

// ---------------------------------------------------------------------------
// 处置动作（规格 §11.2 的头部动作 + §2.2 的状态迁移）
// ---------------------------------------------------------------------------

/**
 * 一个处置动作。
 *
 * `assign` **不改状态**（它写 `assignee` 并留一条 Activity），其余动作各自对应一个目标状态。
 */
export type EventStatusAction =
  | 'acknowledge'
  | 'investigate'
  | 'resolve'
  | 'close'
  | 'reopen'
  | 'mute'
  | 'unmute'
  | 'assign'

export interface StatusActionDescriptor {
  id: EventStatusAction
  /** 目标状态；`assign` 没有（它只改指派人）。 */
  to?: AlertStatus
  labelKey: string
  /** 必须填原因才允许提交（规格 §2.2：Reopened 要记录重新开启的原因）。 */
  requiresNote?: boolean
  /** 头部的主 CTA（规格 §11.2：一次只有一个）。 */
  primary?: boolean
}

const ACTION_LABEL_KEYS: Readonly<Record<EventStatusAction, string>> = {
  acknowledge: 'eventsUi.detailAck',
  investigate: 'eventsUi.actionInvestigate',
  resolve: 'eventsUi.actionResolve',
  close: 'eventsUi.actionClose',
  reopen: 'eventsUi.actionReopen',
  mute: 'eventsUi.actionMute',
  unmute: 'eventsUi.actionUnmute',
  assign: 'eventsUi.actionAssign'
}

/** 目标状态 → 产生它的动作（`muted` 有两个入口：进入与退出）。 */
const ACTION_FOR_TARGET: Readonly<Record<AlertStatus, EventStatusAction | undefined>> = {
  new: undefined,
  acknowledged: 'acknowledge',
  investigating: 'investigate',
  resolved: 'resolve',
  closed: 'close',
  muted: 'mute',
  reopened: 'reopen'
}

/**
 * 当前状态下**可以**做的动作（规格 §11.2：一次只给一个主 CTA）。
 *
 * @param options.locked `true` 表示这一路来源**没有确认接口**（相机检测日志）。此时
 *   「确认」这个动作不出现 —— 不是灰掉，是不画（工程规则：不存在的能力不渲染）。
 *   其余动作照旧：状态机是本机工作流，不依赖设备。
 * @param options.canAssign 有没有可指派的账户（一个账户都没有时「指派」不出现：
 *   点开只有一个空的用户列表比没有这个按钮更糟）。
 */
export function statusActionsFor(
  status: AlertStatus,
  options: { locked?: boolean; canAssign?: boolean } = {}
): StatusActionDescriptor[] {
  const actions: StatusActionDescriptor[] = []

  if (status === 'muted') {
    /**
     * 静默中：**只给一个**「取消静默」，回到「已确认」。
     *
     * 状态表里 `muted → new` 也是允许的（取消静默后回到"谁都没动过"），但它不作为一个
     * 独立的按钮出现：界面上一行两个都叫「取消静默」、只是落点不同的按钮，没人分得清。
     * 那条迁移留给程序化调用（`status` 直接给值）。
     */
    actions.push({
      id: 'unmute',
      to: 'acknowledged',
      labelKey: ACTION_LABEL_KEYS.unmute,
      primary: true
    })
    for (const target of allowedStatusTargets(status)) {
      if (target === 'acknowledged' || target === 'new') continue
      actions.push(descriptorFor(target))
    }
  } else {
    for (const target of allowedStatusTargets(status)) {
      const descriptor = descriptorFor(target)
      if (descriptor.id === 'acknowledge' && options.locked === true) continue
      actions.push(descriptor)
    }
  }

  if (options.canAssign === true) {
    actions.push({ id: 'assign', labelKey: ACTION_LABEL_KEYS.assign })
  }

  /**
   * 主 CTA 的次序：确认 → 开始调查 → 解决 → 关闭 → 重新开启（与状态图的推进方向一致）。
   * **已经有主 CTA 的（静默中的"取消静默"）不再抢** —— 规格 §11.2 只允许一个。
   */
  if (!actions.some((action) => action.primary === true)) {
    const primaryOrder: EventStatusAction[] = [
      'acknowledge',
      'investigate',
      'resolve',
      'close',
      'reopen'
    ]
    for (const id of primaryOrder) {
      const found = actions.find((action) => action.id === id)
      if (found) {
        found.primary = true
        break
      }
    }
  }
  return actions
}

function descriptorFor(target: AlertStatus): StatusActionDescriptor {
  const id = ACTION_FOR_TARGET[target]
  if (id === undefined) {
    // `new` 没有"回到新建"这个动作（它只在取消静默时作为目标出现）。
    return { id: 'unmute', to: target, labelKey: ACTION_LABEL_KEYS.unmute }
  }
  return {
    id,
    to: target,
    labelKey: ACTION_LABEL_KEYS[id],
    // 重新开启必须留下原因（规格 §2.2 明说）。
    ...(id === 'reopen' ? { requiresNote: true } : {})
  }
}

/**
 * 一个动作会把状态带到哪（`assign` 不改状态，返回 `undefined`）。
 *
 * 主进程用它把"界面点了哪个动作"翻成"要写哪个状态"，于是这条对应关系只有一处 ——
 * 界面上的动作列表与库里的状态值不会各说各话。
 */
export function statusForAction(action: EventStatusAction): AlertStatus | undefined {
  if (action === 'assign') return undefined
  if (action === 'unmute') return 'acknowledged'
  if (action === 'acknowledge') return 'acknowledged'
  if (action === 'investigate') return 'investigating'
  if (action === 'resolve') return 'resolved'
  if (action === 'close') return 'closed'
  if (action === 'reopen') return 'reopened'
  return 'muted'
}

/**
 * 一次处置写入的结果（IPC 的返回值）。
 *
 * `status` / `assignee` 来自**写完读回**的那一行，不是请求里传进去的参数 ——
 * 业主的硬规矩：写完必须读回，不能拿"请求发出去了"当成功。
 */
export interface EventStatusChangeResult {
  entryId: string
  status: AlertStatus
  assignee?: string
  /** 这次写入产生的那一条 Activity（读回来的那一条）。 */
  activity: EventActivityView
  /** 工作流之前的那个状态（界面据此显示"从 X 变成 Y"）。 */
  fromStatus: AlertStatus
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
    status: entryStatus(entry),
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

/**
 * 一条事件的**工作流状态**。
 *
 * 规则的唯一一处（`docs/EVENT-CENTER.md` §3.12）：主进程从 `event_status` 表读到的状态
 * 优先；表里没有这一条时，用来源侧的确认标志推出 `acknowledged` / `new`。
 * 两个来源（我们的工作流表、来源自己的 ack）**可能不一致** —— 以工作流为准，
 * 因为它是操作员在本机按下的那一次动作，而来源的 ack 是设备侧的历史事实。
 */
function entryStatus(entry: EventCenterEntry): AlertStatus {
  if (isEventStatus(entry.status)) return entry.status
  return entry.acknowledged ? 'acknowledged' : 'new'
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
// Activity / Timeline / Related（规格 §13）
// ---------------------------------------------------------------------------

/** Activity 的三种记录（规格 §13.3 的三类行：状态变更、指派、人工留言）。 */
export type EventActivityKind = 'status' | 'assign' | 'note'

export const EVENT_ACTIVITY_KINDS: readonly EventActivityKind[] = ['status', 'assign', 'note']

export function isEventActivityKind(value: unknown): value is EventActivityKind {
  return typeof value === 'string' && (EVENT_ACTIVITY_KINDS as readonly string[]).includes(value)
}

export function activityKindLabelKey(kind: EventActivityKind): string {
  return `eventsUi.activityKind.${kind}`
}

/**
 * 一条 Activity（规格 §2.2：状态变更必须记录时间、操作者、前后状态）。
 *
 * `actor` 是**操作者的账户名**，不是显示名：账户名唯一、可追责；显示名可以被改。
 * `assign` 那一条里 `toStatus` 无意义，`assignee` 才是内容 —— 一条记录只该有一个"形状"
 * （状态变化 / 指派 / 留言），由 `kind` 决定。
 */
export interface EventActivityView {
  id: string
  entryId: string
  at: number
  actor: string
  kind: EventActivityKind
  fromStatus?: AlertStatus
  toStatus?: AlertStatus
  assignee?: string
  note?: string
}

/** 渲染层按 kind 分支用的结构化行（不在纯函数层翻译，见 `OverviewValue` 的同一条理由）。 */
export type ActivityRow =
  | { kind: 'status'; at: number; actor: string; from: AlertStatus; to: AlertStatus; note?: string }
  | { kind: 'assign'; at: number; actor: string; assignee: string; note?: string }
  | { kind: 'note'; at: number; actor: string; note: string }

/**
 * Activity → 可渲染的行（**新的在前**：处置工作流里"刚发生的事"在最上面更实用，
 * 而每行都写全时间戳，顺序不会造成误读）。
 *
 * 不认识的取值（kind 不认识、状态字符串坏了、留言是空的）**不产出**行：宁可少一行，
 * 也不在时间线上印一个空的"→"。
 */
export function activityRows(activities: readonly EventActivityView[]): ActivityRow[] {
  const rows: ActivityRow[] = []
  for (const activity of activities) {
    // 不认识的 kind 直接跳过（而不是落进"留言"那一支：那样一条坏记录会伪装成一句留言）。
    if (!isEventActivityKind(activity.kind)) continue
    if (activity.kind === 'status') {
      if (!isAlertStatus(activity.fromStatus) || !isAlertStatus(activity.toStatus)) continue
      rows.push({
        kind: 'status',
        at: activity.at,
        actor: activity.actor,
        from: activity.fromStatus,
        to: activity.toStatus,
        ...(activity.note !== undefined ? { note: activity.note } : {})
      })
      continue
    }
    if (activity.kind === 'assign') {
      const assignee = (activity.assignee ?? '').trim()
      if (assignee === '') continue
      rows.push({
        kind: 'assign',
        at: activity.at,
        actor: activity.actor,
        assignee,
        ...(activity.note !== undefined ? { note: activity.note } : {})
      })
      continue
    }
    const note = (activity.note ?? '').trim()
    if (note === '') continue
    rows.push({ kind: 'note', at: activity.at, actor: activity.actor, note })
  }
  return rows.sort((left, right) => right.at - left.at)
}

/**
 * Timeline 的一个节点（规格 §13.1）。
 *
 * 两类来源：
 *   - **事实节点**（`detected` / `linkage-action`）：来自事件本身与来源记录；
 *   - **动作节点**（`status` / `assign` / `note`）：来自 Activity。
 * 规格举的例子里还有"AI 分类 · 置信度""阈值超限""通知已发"—— 我们没有那些数据
 * （事件中心不做推理、没有通知回执），所以**不画**：时间线上只有我们真的知道的事。
 */
export type TimelineNode =
  | { kind: 'detected'; at: number; approximate: boolean }
  | { kind: 'status'; at: number; actor: string; from: AlertStatus; to: AlertStatus; note?: string }
  | { kind: 'assign'; at: number; actor: string; assignee: string; note?: string }
  | { kind: 'note'; at: number; actor: string; note: string }
  | { kind: 'linkage-action'; at: number; action: string; status: string; reason?: string }

/**
 * 一条事件的完整时间线（**早的在前**：时间线是从上往下读的）。
 *
 * 联动动作由调用方传进来（它挂在 `entry.linkageActions` 上，不属于 Activity 表）。
 */
export function alertTimeline(
  alert: AlertViewModel,
  activities: readonly EventActivityView[],
  linkageActions: readonly { at: number; action: string; status: string; reason?: string }[] = []
): TimelineNode[] {
  const nodes: TimelineNode[] = [
    { kind: 'detected', at: alert.firstDetectedAt, approximate: alert.atApproximate },
    ...activityRows(activities),
    ...linkageActions.map((record) => ({
      kind: 'linkage-action' as const,
      at: record.at,
      action: record.action,
      status: record.status,
      ...(record.reason !== undefined ? { reason: record.reason } : {})
    }))
  ]
  return nodes.sort((left, right) => left.at - right.at)
}

// ---------------------------------------------------------------------------
// Related（规格 §13.2）
// ---------------------------------------------------------------------------

export type RelatedGroupId = 'same-device' | 'same-kind' | 'time-window'

export interface RelatedGroup {
  id: RelatedGroupId
  labelKey: string
  /** 组里的**其它**告警（不含当前这一条）。 */
  ids: string[]
}

export const RELATED_TIME_WINDOW_MS = 10 * 60 * 1000

/**
 * 相关性分组（规格 §13.2 的"同资产 / 同设备 / 同类型 / 邻近资产 / 时间窗口"）。
 *
 * **作用域是已加载的那一页**（与 KPI 同一条口径）：相关事件必须在取回的数据里找，
 * 我们没有任何"跨全库按相关性查询"的能力。界面把这一点印出来（`relatedScope`）。
 *
 * 我们有的三组：
 *   - `same-device`：同一台设备的其它告警（规格的 same device）；
 *   - `same-kind`：同一种事件种类（规格的 same event type）；
 *   - `time-window`：±10 分钟内的其它告警（规格的 time window）。
 * `same-asset` / `nearby-assets` **不做**：我们没有 asset 这一层（设备就是我们的资产），
 * 而"邻近"要靠资产树或坐标 —— 坐标是人工录的、多数设备还是空的。
 */
export function relatedGroups(
  alert: AlertViewModel,
  alerts: readonly AlertViewModel[],
  windowMs: number = RELATED_TIME_WINDOW_MS
): RelatedGroup[] {
  const others = alerts.filter((item) => item.id !== alert.id)
  const ids = (list: AlertViewModel[]): string[] => list.map((item) => item.id)
  return [
    {
      id: 'same-device',
      labelKey: 'eventsUi.relatedSameDevice',
      ids: ids(others.filter((item) => item.deviceId === alert.deviceId))
    },
    {
      id: 'same-kind',
      labelKey: 'eventsUi.relatedSameKind',
      ids: ids(others.filter((item) => item.kind === alert.kind))
    },
    {
      id: 'time-window',
      labelKey: 'eventsUi.relatedTimeWindow',
      ids: ids(others.filter((item) => Math.abs(item.at - alert.at) <= windowMs))
    }
  ]
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
 * Phase 5 起五个页签都在了（Overview / Evidence / Timeline / Related / Activity）：
 * 时间线与相关性由纯函数算（`alertTimeline` / `relatedGroups`），Activity 来自
 * `event_activity` 表。常量留着是因为**页签的可用性不该由渲染层硬编码** ——
 * 将来某一块拿不到数据时，把它从这里去掉就是"不渲染"，而不是留一个空页签。
 */
export const IMPLEMENTED_DETAIL_TABS: readonly EventDetailTab[] = [
  'overview',
  'evidence',
  'timeline',
  'related',
  'activity'
]

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

