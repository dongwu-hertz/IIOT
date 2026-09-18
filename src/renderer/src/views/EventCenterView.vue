<script setup lang="ts">
/**
 * 事件与告警中心（`/events`）。
 *
 * 产品要求：「设置事件和告警中心。」——一个页面里按时间顺序看到软件知道的
 * **全部**事件，能确认、能跳到它的录像、能下载设备为它产出的结果文件。
 *
 * ---------------------------------------------------------------------------
 * 这个页面的三条硬规则（都是刻意的，不要"优化"掉）
 * ---------------------------------------------------------------------------
 * 1. **不编造**。三路来源都为空时显示「没有任何事件上报」，而不是塞几条示例；
 *    等级该是「未知」时就显示未知（相机 `alarm_level` 从未在真机上出现过），
 *    时间按假设换算出来时显示「近似时间」。
 * 2. **能力决定渲染**。不存在的动作**不渲染**（一条相机检测日志没有确认接口，
 *    所以它没有确认按钮；已下载的文件没有下载按钮，只有播放/打开）；可能存在
 *    但此刻不能用的动作渲染成**禁用并给出原因**（设备离线、非管理员）。
 * 3. **空 src 不变式**。`<video>` 只在拿到回环地址时存在（`v-if="videoUrl"`），
 *    任何非播放状态都不留一个黑框；拿不到地址时说的是「无法播放」而不是转圈。
 *
 * 与 `AlarmsView.vue` 的关系：那一页只有声纹设备自己的告警行，这一页合并三路
 * 来源，并且复用同一个 `RecordingPlayer`（音频）与同一套 `cameraNvr.videoUrl`
 * 视频路径，不存在第二份播放实现。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type {
  EventCenterEntry,
  EventCenterQuery,
  EventDetectDownloadInput,
  EventDownloadProgress
} from '@shared/ipc/contract'
import { eventCenterPerSourceCap } from '@shared/domain/event-center'
import {
  DRAWER_WIDTH_STORAGE_KEY,
  EVENT_FILTER_STORAGE_KEY,
  EVENT_SAVED_VIEWS,
  EVENT_VIEW_MODES,
  EVENT_VIEW_MODE_STORAGE_KEY,
  GROUP_WINDOW_CHOICES,
  ackFilterToQuery,
  activityRows,
  alertOverviewFields,
  alertStatusLabelKey,
  alertTimeline,
  clampDrawerWidth,
  drawerWidthForViewport,
  emptyEventFilter,
  eventFilterCounts,
  eventFilterFromQuery,
  eventFilterToQuery,
  eventKpis,
  evidenceImageSource,
  groupWindowMsFor,
  hasEventFilterQuery,
  isEventFilterActive,
  matchEventSearch,
  parseDrawerWidth,
  parseEventFilter,
  parseEventViewMode,
  querySeverityFor,
  relatedGroups,
  savedViewFromMs,
  serializeEventFilter,
  toAlertViewModels
} from '@shared/domain/event-view'
import type {
  AlertViewModel,
  EventActivityView,
  EventDetailTab,
  EventQueueFilter,
  EventSavedView,
  EventStatusAction,
  EventViewMode
} from '@shared/domain/event-view'
import type { Fa371ResultFileKind } from '@shared/domain/fa371'
import type { E2AlarmSnapshotView } from '@shared/ipc/contract'
import AlertQueue from '@renderer/components/event-center/AlertQueue.vue'
import EventDetailDrawer from '@renderer/components/event-center/EventDetailDrawer.vue'
import EventFilterPanel from '@renderer/components/event-center/EventFilterPanel.vue'
import EventKpiStrip from '@renderer/components/event-center/EventKpiStrip.vue'
import RecordingPlayer from '@renderer/components/RecordingPlayer.vue'
import {
  alarmTypeLabel,
  describeAlarmMask,
  detectFileKindLabel,
  eventDownloadStageLabel,
  eventKindLabel,
  eventSourceLabel
} from '@renderer/lib/labels'
import {
  channelLabel,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  fromDateTimeLocalValue,
  toDateTimeLocalValue
} from '@renderer/lib/format'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { EVENT_PAGE_SIZE, eventDownloadKey, useEventCenterStore } from '@renderer/stores/eventCenter'
import { useDevicesStore } from '@renderer/stores/devices'
import { useSessionStore } from '@renderer/stores/session'
import { useAlarmLinkageStore } from '@renderer/stores/alarmLinkage'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useEventCenterStore()
const devices = useDevicesStore()
const session = useSessionStore()
const linkage = useAlarmLinkageStore()

// ---------------------------------------------------------------------------
// 筛选状态（规格 §9）：URL > localStorage > 默认
// ---------------------------------------------------------------------------

/**
 * 初始筛选。
 *
 * 优先级是 **URL > localStorage**：分享出去的一条链接必须把对方带到同一个视图上，
 * 而"上次看到哪儿"只是本机的舒适度。这里用 `hasEventFilterQuery` 区分"地址里没写筛选"
 * 与"地址里明确写了空筛选"—— 后者（清空后刷新）不该被 localStorage 里的旧条件顶回来。
 */
function readInitialFilter(): EventQueueFilter {
  const query = route.query as Record<string, unknown>
  if (hasEventFilterQuery(query)) return eventFilterFromQuery(query)
  try {
    return parseEventFilter(window.localStorage.getItem(EVENT_FILTER_STORAGE_KEY))
  } catch {
    // 读不到偏好不是错误：`parseEventFilter` 对坏值退回默认（它自己的注释写了原因）。
    return parseEventFilter(null)
  }
}

const filters = reactive<EventQueueFilter>(readInitialFilter())

/** 视图模式（规格 §10.2）：紧凑 / 标准 / 证据，记住上次选的。 */
function readInitialViewMode(): EventViewMode {
  try {
    return parseEventViewMode(window.localStorage.getItem(EVENT_VIEW_MODE_STORAGE_KEY))
  } catch {
    return 'standard'
  }
}

const viewMode = ref<EventViewMode>(readInitialViewMode())
/** 左侧筛选面板是否展开。**不持久化**：这是本次操作的临时状态，不是偏好（规格 §16.3 只要求视图模式）。 */
const filterPanelOpen = ref(true)
/** 最近一次点过的内置视图；手动改任何一项筛选就清空（不给一个假的"当前视图"高亮）。 */
const activeSavedViewId = ref<string | null>(null)

/**
 * 抽屉里的那一条（规格 §16.2 的 `eventSelection`）。
 *
 * 存的是**视图模型**而不是原始行：头部要等级/标题键、页签要聚合字段，都要它；
 * 需要原始字段的动作（下载、播放、检测细节）通过 `detail.entry` 拿 —— 一条数据一条路径。
 */
const detail = ref<AlertViewModel | null>(null)
/** 队列里当前选中的告警 id（↑/↓ 与详情抽屉都看它）。 */
const selectedId = ref<string | null>(null)
/** 抽屉里正在播放的音频录像行（deviceDetect 的结果文件按需切换）。 */
const playerRecordingId = ref<string | null>(null)
/** 抽屉里的视频地址；**非播放状态恒为空串**（空 src 不变式）。 */
const videoUrl = ref('')
const videoError = ref('')
const videoBusy = ref(false)

// ---------------------------------------------------------------------------
// 抽屉的宽度与页签（规格 §11.1 / §11.3）
// ---------------------------------------------------------------------------

/** 默认宽度：大屏 440、普通屏 400（规格 §11.1），拖过之后记住上次的。 */
function readInitialDrawerWidth(): number {
  const fallback = drawerWidthForViewport(window.innerWidth)
  try {
    return parseDrawerWidth(window.localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY), fallback)
  } catch {
    // 读不到偏好不是错误：用按屏幕算出来的默认值（与筛选/视图模式同一条取舍）。
    return fallback
  }
}

const drawerWidth = ref(readInitialDrawerWidth())
const drawerTab = ref<EventDetailTab>('overview')

function setDrawerWidth(next: number): void {
  drawerWidth.value = clampDrawerWidth(next)
  try {
    window.localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, String(drawerWidth.value))
  } catch {
    // 同上：偏好存不下不影响使用。
  }
}

/**
 * 图片证据的取回结果。
 *
 * `state` 直接来自主进程（四种）+ `error`（IPC 自己失败）。界面按 state 说人话：
 * 「设备上没有抓到图」与「图在本机但文件没了」是两件不同的事，都不该画一个空框。
 */
interface EvidenceImageState {
  state: 'ok' | 'not-captured' | 'files-gone' | 'not-image' | 'not-found' | 'error'
  url?: string
  name?: string
}

const evidenceImage = ref<EvidenceImageState | null>(null)
const evidenceImageBusy = ref(false)
/** 这一张图是从哪条路取来的（关闭时要调对应的 close，别把另一个端点关掉）。 */
const evidenceImageKind = ref<'frame' | 'alarm-snapshot' | null>(null)

const rows = computed(() => store.items)
/** 整页告警的视图模型（规格 §16.2）。 */
const allAlerts = computed(() => toAlertViewModels(store.items))
/**
 * 队列里显示的告警。
 *
 * 关键字是**在已加载的这一页里**匹配的（主进程的查询没有关键字参数，三路来源的检索
 * 是三件不同的事），所以 `searchScope` 必须把这件事说出来。
 */
const alerts = computed(() =>
  allAlerts.value.filter((alert) =>
    matchEventSearch(alert, filters.search, eventKindLabel(alert.kind))
  )
)
const kpis = computed(() => eventKpis(alerts.value))
const counts = computed(() => eventFilterCounts(alerts.value))
const page = computed(() => store.page)
const canPrev = computed(() => page.value.offset > 0)
const canNext = computed(() => page.value.offset + rows.value.length < store.total)
const isAdmin = computed(() => session.isAdmin)

/** 相机检测库这一路的读况（决定下载按钮是否可用）。 */
const detectStatus = computed(() => store.sources.find((source) => source.source === 'deviceDetect'))

/**
 * 本次查询每路来源的读取上限。
 *
 * 与主进程算的是**同一个纯函数**，所以「截断说明」里的数字不会跟实际行为分叉；
 * 在渲染层算只是为了一句诚实的文案，真正的上限仍由主进程执行。
 */
const perSourceCap = computed(() => eventCenterPerSourceCap(page.value.limit, page.value.offset))

const hasActiveFilters = computed(() => isEventFilterActive(filters))
const searchActive = computed(() => filters.search.trim() !== '')

/**
 * 「来源读况」只在**有话说**时渲染。
 *
 * 三路都读到了、也没截断时，这块卡片只是三行绿字，却占掉了队列的第一屏 —— 而来源条数
 * 已经在左侧筛选面板里逐路给出了。一旦某一路失败或被截断，它立刻出现（并且是页面级的
 * 警示，不随面板折叠而消失）。
 */
const sourcesNeedAttention = computed(() =>
  store.sources.some((source) => !source.ok || source.truncated > 0)
)

/** 空状态文案：区分「设备什么都没报」与「筛选把数据排除了」。 */
const emptyTitle = computed(() =>
  hasActiveFilters.value ? t('eventsUi.emptyFilteredTitle') : t('eventsUi.emptyTitle')
)

function buildQuery(): Partial<EventCenterQuery> {
  const query: Partial<EventCenterQuery> = { limit: EVENT_PAGE_SIZE, offset: 0 }
  if (filters.deviceId !== '') query.deviceId = filters.deviceId
  if (filters.source !== '') query.sources = [filters.source]
  const severity = querySeverityFor(filters.severity)
  if (severity !== undefined) query.severity = severity
  const from = fromDateTimeLocalValue(filters.from)
  if (from !== undefined) query.from = from
  const to = fromDateTimeLocalValue(filters.to)
  if (to !== undefined) query.to = to
  const acknowledged = ackFilterToQuery(filters.ack)
  if (acknowledged !== undefined) query.acknowledged = acknowledged
  // 聚合窗口（规格 §14.1）：0 = 不聚合。**总是带上**（包括 0），
  // 否则"关掉聚合"会被主进程的缺省值（10 分钟）顶回来。
  query.groupWindowMs = groupWindowMsFor(filters.groupWindow)
  return query
}

async function reload(): Promise<void> {
  closeDetail()
  await store.applyQuery(buildQuery())
}

/** 筛选面板 / KPI 条点一下：只改一处，其余不动（改了就会重新查询，见下面的 watch）。 */
function patchFilter(patch: Partial<EventQueueFilter>): void {
  activeSavedViewId.value = null
  Object.assign(filters, patch)
}

function clearFilters(): void {
  activeSavedViewId.value = null
  Object.assign(filters, emptyEventFilter())
}

/**
 * 应用一个内置视图（规格 §9.4）。
 *
 * 视图是**一组筛选**，不是另一份数据：它把等级/确认状态/时间窗口写进同一份筛选状态，
 * 后面走的还是同一条查询与同一份队列。
 */
function applySavedView(view: EventSavedView): void {
  activeSavedViewId.value = view.id
  const fromMs = savedViewFromMs(view, Date.now())
  const next = emptyEventFilter()
  next.severity = view.severity ?? ''
  next.ack = view.ack ?? 'all'
  // 时间窗口按本机时区换算成 `datetime-local` 的字符串 —— 那个控件要的就是本地墙上时间。
  next.from = fromMs === undefined ? '' : toDateTimeLocalValue(fromMs)
  Object.assign(filters, next)
}

function setViewMode(mode: EventViewMode): void {
  viewMode.value = mode
  try {
    window.localStorage.setItem(EVENT_VIEW_MODE_STORAGE_KEY, mode)
  } catch {
    // 偏好存不下不影响使用（与侧栏折叠同一条取舍：读写各自 try/catch）。
  }
}

// ---------------------------------------------------------------------------
// 下载进度订阅 + 生命周期
// ---------------------------------------------------------------------------

let unsubscribeProgress: (() => void) | undefined

onMounted(async () => {
  if (devices.devices.length === 0) await devices.load()
  // 联动待处理列表只有在这里读一次，才能把「已确认/未确认」与顶栏角标对齐。
  if (!linkage.loaded) void linkage.load()
  // 账户列表（「指派」要用）：读不到就不显示那个动作。
  void loadAssignees()
  unsubscribeProgress = window.events.onEventCenterDownloadProgress(
    (progress: EventDownloadProgress) => store.handleProgress(progress)
  )
  await reload()
})

onUnmounted(() => {
  unsubscribeProgress?.()
  unsubscribeProgress = undefined
  closeEvidenceImage()
})

/**
 * Esc 与 ↑/↓ 由抽屉组件自己处理（`EventDetailDrawer` 里的 window 监听）——
 * 那里知道"焦点在不在抽屉里"，而"↑/↓ 要不要接管"正是靠这件事判断的。
 */

/**
 * 把当前筛选写回 localStorage 与地址栏。
 *
 * 两处都写：localStorage 管"下次打开还是这个视图"，地址栏管"这条链接发给别人也是这个视图"。
 * 序列化用的是同一个函数（`serializeEventFilter`），所以两者不会分叉。
 */
function persistFilter(): void {
  try {
    window.localStorage.setItem(EVENT_FILTER_STORAGE_KEY, serializeEventFilter(filters))
  } catch {
    // 同 `setViewMode`：偏好存不下不影响使用。
  }
  void router.replace({ query: eventFilterToQuery(filters) })
}

// 与 `AlarmsView` 同一条取舍：改筛选就查，不额外要求点一次「查询」。
//
// **但关键字不重新查询**：搜索是在**已加载的这一页**里做的（`matchEventSearch`），它不改变
// 查询参数。把 `search` 也算进来，每敲一个字就会去读一次设备 —— 相机的检测日志是一次 HTTP
// 请求，那不是搜索该有的代价（而且它换不来更全的结果）。
watch(
  () => [
    filters.deviceId,
    filters.source,
    filters.severity,
    filters.from,
    filters.to,
    filters.ack,
    // 聚合窗口也是**查询参数**（主进程按它并组、并按告警数分页），所以要重新查。
    filters.groupWindow
  ],
  () => {
    void reload()
  }
)

// 关键字只影响地址栏与 localStorage（刷新或把链接发出去之后，还是同一个搜索词）。
watch(
  () => ({ ...filters }),
  () => {
    persistFilter()
  }
)

// ---------------------------------------------------------------------------
// 抽屉
// ---------------------------------------------------------------------------

/** 默认要给 `RecordingPlayer` 的录音 id：视频与图片不能交给音频播放器。 */
function defaultPlayerId(entry: EventCenterEntry): string | null {
  if (!entry.recordingId) return null
  return entry.recordingContainer === 'mp4' ? null : entry.recordingId
}

/** 队列选中一条 → 打开详情。选中态留在队列上（关掉抽屉后还能从原处继续按 ↑/↓）。 */
function openDetail(alert: AlertViewModel): void {
  if (detail.value?.id === alert.id) return
  selectedId.value = alert.id
  detail.value = alert
  // 换事件时页签回到 Overview：停在 Evidence 上看另一条事件，会让人以为这条也有图。
  drawerTab.value = 'overview'
  // 处置记录跟着换：先清空（否则会短暂显示上一条的记录）。
  activities.value = []
  playerRecordingId.value = defaultPlayerId(alert.entry)
  videoUrl.value = ''
  videoError.value = ''
  closeEvidenceImage()
  void loadEvidenceImage()
  void loadActivity(alert.id)
}

function closeDetail(): void {
  detail.value = null
  activities.value = []
  playerRecordingId.value = null
  // 先清地址再卸载 `<video>`：元素会释放回环连接（与 RecordingsView 同一顺序）。
  videoUrl.value = ''
  videoError.value = ''
  closeEvidenceImage()
}

/**
 * ↑/↓ 在抽屉里换条（规格 §11.1）。
 *
 * 顺序取**队列当前显示的**那批（`alerts`）：抽屉里走一条，队列里也跟着选中，两边一致；
 * 换到的那条如果是筛选后的最后一个，就停在原地（不做环形，环形的"跳回第一条"会让人
 * 以为自己看漏了）。
 */
function stepAlert(delta: number): void {
  const list = alerts.value
  const current = list.findIndex((alert) => alert.id === selectedId.value)
  if (current < 0 || list.length === 0) return
  const next = list[current + delta]
  if (!next) return
  openDetail(next)
}

// ---------------------------------------------------------------------------
// 图片证据（规格 §12.1 的 Visual）
// ---------------------------------------------------------------------------

/** 主进程那两路接口的返回都不一样，这里归一成一个小结构给模板用。 */
function normaliseSnapshot(view: E2AlarmSnapshotView): EvidenceImageState {
  if (view.state === 'ok') {
    const first = view.files[0]
    if (first) return { state: 'ok', url: first.url, name: first.name }
    // `ok` 却说没有文件：如实当成"设备上没有图"，而不是画一个空框。
    return { state: 'not-captured' }
  }
  return { state: view.state }
}

/**
 * 取这一条事件的图片证据。
 *
 * 两条来源（`evidenceImageSource` 里写着为什么只有两条）：联动抓帧走新的
 * `eventCenter.evidenceImage`，声纹告警的球机抓图走**已有的**
 * `devices.alarmSnapshots`（第 8 批做的，不重复造一个）。
 */
async function loadEvidenceImage(): Promise<void> {
  const alert = detail.value
  evidenceImage.value = null
  evidenceImageKind.value = null
  if (!alert) return
  // 机型也传进去：AE08 这类声纹盒子没有球机抓图，别去问一个不存在的接口
  // （问了一定失败，界面上就成了"读取图片证据失败"——那是假故障）。
  const deviceKind = devices.devices.find((device) => device.id === alert.deviceId)?.kind
  const source = evidenceImageSource(alert, deviceKind)
  if (!source) return

  evidenceImageBusy.value = true
  if (source.kind === 'frame') {
    evidenceImageKind.value = 'frame'
    const result = await callApi(() =>
      window.api.eventCenter.evidenceImage({ relativePath: source.relativePath })
    )
    evidenceImageBusy.value = false
    // 期间用户可能已经换了另一条事件：晚到的结果不许覆盖当前这一条。
    if (detail.value?.id !== alert.id) return
    evidenceImage.value = result.success
      ? (unwrap(result) as EvidenceImageState)
      : { state: 'error' }
    return
  }

  evidenceImageKind.value = 'alarm-snapshot'
  const result = await callApi(() =>
    window.api.e2.alarmSnapshots(alert.deviceId, source.alarmId)
  )
  evidenceImageBusy.value = false
  if (detail.value?.id !== alert.id) return
  const view = unwrap(result)
  evidenceImage.value = result.success && view ? normaliseSnapshot(view) : { state: 'error' }
}

/** 关掉当前图片端点（TTL 兜底，但让端口白挂半小时是一种浪费）。 */
function closeEvidenceImage(): void {
  const kind = evidenceImageKind.value
  evidenceImageKind.value = null
  evidenceImage.value = null
  if (kind === 'frame') {
    void window.api.eventCenter.closeEvidenceImage().catch(() => undefined)
  } else if (kind === 'alarm-snapshot') {
    void window.api.e2.closeSnapshots().catch(() => undefined)
  }
}

/** 图片取不到时的说明：四种 state 各有各的说法（都不许画成一个空框）。 */
function evidenceImageNote(): string {
  const state = evidenceImage.value?.state
  if (state === 'not-captured') return t('eventsUi.evidenceNotCaptured')
  if (state === 'files-gone') return t('eventsUi.evidenceFilesGone')
  if (state === 'not-image') return t('eventsUi.evidenceNotImage')
  if (state === 'not-found') return t('eventsUi.evidenceNotFound')
  if (state === 'error') return t('eventsUi.evidenceError')
  return ''
}

/** 打开一段 MP4 录像（回环 HTTP，支持 Range）。拿不到地址时明说无法播放。 */
async function openVideo(recordingId: string): Promise<void> {
  videoUrl.value = ''
  videoError.value = ''
  videoBusy.value = true
  const result = await callApi(() => window.api.cameraNvr.videoUrl(recordingId))
  videoBusy.value = false
  if (!result.success) {
    videoError.value = resultMessage(result)
    return
  }
  videoUrl.value = unwrap(result)?.url ?? ''
  if (videoUrl.value === '') videoError.value = t('eventsUi.detailRecordingVideoUnavailable')
}

function closeVideo(): void {
  videoUrl.value = ''
  videoError.value = ''
}

// ---------------------------------------------------------------------------
// 检测结果文件
// ---------------------------------------------------------------------------

function downloadKeyFor(entry: EventCenterEntry, kind: Fa371ResultFileKind): string {
  return eventDownloadKey({
    deviceId: entry.deviceId,
    logId: entry.detect?.logId ?? -1,
    kind
  })
}

function downloadState(
  entry: EventCenterEntry,
  kind: Fa371ResultFileKind
): EventDownloadProgress | undefined {
  return store.downloads[downloadKeyFor(entry, kind)]
}

/** 一个文件的下载按钮此刻能不能用；不能用时返回原因（渲染成禁用 + 说明）。 */
function downloadBlockedReason(): string {
  if (!isAdmin.value) return t('eventsUi.detailDownloadNeedAdmin')
  if (detectStatus.value && !detectStatus.value.ok) return t('eventsUi.detailSourceUnavailable')
  return ''
}

async function downloadFile(
  entry: EventCenterEntry,
  kind: Fa371ResultFileKind,
  fileName: string
): Promise<void> {
  const logId = entry.detect?.logId
  if (logId === undefined) return
  const input: EventDetectDownloadInput = { deviceId: entry.deviceId, logId, kind }
  if (entry.detect?.startTimeRaw !== undefined) input.startTimeRaw = entry.detect.startTimeRaw
  const result = await store.download(input)
  if (result) {
    // 下载完成后把新登记的录像就地接上：列表已在 store 里重读过，
    // 抽屉里的这一份也要跟着更新，否则按钮还停在「下载」。
    // 从**整页**的视图模型里找（不是过滤后的队列）：关键字筛选不该让这一份更新落空。
    const refreshed = allAlerts.value.find((item) => item.id === entry.id)
    if (refreshed && detail.value?.id === entry.id) detail.value = refreshed
    store.notice = t('eventsUi.downloadDone', {
      name: fileName,
      size: formatBytes(result.bytes)
    })
  }
}

/** 一个文件在抽屉里可用的动作（不存在的能力直接不渲染）。 */
function canPlayAudio(container: string): boolean {
  return container !== 'mp4' && container !== 'jpg' && container !== 'png'
}

async function playDetectFile(file: {
  downloadedRecordingId?: string
  container: string
}): Promise<void> {
  if (!file.downloadedRecordingId) return
  if (file.container === 'mp4') {
    await openVideo(file.downloadedRecordingId)
    return
  }
  closeVideo()
  playerRecordingId.value = file.downloadedRecordingId
}

// ---------------------------------------------------------------------------
// 确认
// ---------------------------------------------------------------------------

/** 该事件的确认能力：设备检测日志没有这个接口，所以「确认」这个动作不出现。 */
const detailCanAcknowledge = computed(() => detail.value?.source !== 'deviceDetect')

// ---------------------------------------------------------------------------
// 处置（规格 §2.2 / §11.2 / §13）
// ---------------------------------------------------------------------------

/**
 * 可以指派给谁（现有账户的账户名）。
 *
 * 用**账户名**而不是显示名：Activity 的 `actor` 也是账户名，两者要对得上；
 * 显示名可以改，账户名不能（见 `EventActivityView` 的注释）。
 */
const assignees = ref<Array<{ username: string; displayName?: string }>>([])
/** 处置动作正在提交（抽屉里的按钮据此禁用，避免连点两次状态变更）。 */
const statusBusy = ref(false)
/** 这一条事件的处置记录（新的在前）。 */
const activities = ref<EventActivityView[]>([])

/** 读一次账户列表（打不开时「指派」不出现 —— 点开只有一个空列表比没有按钮更糟）。 */
async function loadAssignees(): Promise<void> {
  const result = await callApi(() => window.api.auth.listUsers())
  if (!result.success) return
  const users = unwrap(result) ?? []
  assignees.value = users
    .filter((user) => typeof user.username === 'string' && user.username !== '')
    .map((user) => ({
      username: user.username,
      ...(user.displayName !== undefined && user.displayName !== ''
        ? { displayName: user.displayName }
        : {})
    }))
}

/** 读这一条事件的处置记录。换条之后**晚到的结果不许覆盖**当前这一条的。 */
async function loadActivity(entryId: string): Promise<void> {
  const result = await callApi(() => window.api.eventCenter.activity(entryId))
  if (detail.value?.id !== entryId) return
  activities.value = result.success ? (unwrap(result) ?? []) : []
}

const timelineNodes = computed(() =>
  detail.value
    ? alertTimeline(detail.value, activities.value, detail.value.entry.linkageActions ?? [])
    : []
)
const activityList = computed(() => activityRows(activities.value))
const related = computed(() => (detail.value ? relatedGroups(detail.value, alerts.value) : []))

/** 相关性分组里的一个按钮文字：时间 + 事件种类（够认出是哪一条）。 */
function relatedLabel(id: string): string {
  const target = allAlerts.value.find((item) => item.id === id)
  if (!target) return id
  return `${formatDateTime(target.at)} · ${eventKindLabel(target.kind)}`
}

function openRelated(id: string): void {
  const target = allAlerts.value.find((item) => item.id === id)
  if (target) openDetail(target)
}

/**
 * 提交一次处置（规格 §2.2）。
 *
 * 三件事按顺序做完，缺一不可：
 *   1. 写（`eventCenter.changeStatus`：服务端判迁移合法性、写状态 + Activity、写回读）；
 *   2. **重查**（状态由主进程合并进每一条事件，队列 / KPI / 筛选面板都要跟着变）；
 *   3. **抽屉不关**（规格 §15.1：确认后立即更新状态、写入 Activity、不关 Drawer）——
 *      所以这里不走 `reload()`（它会关抽屉），而是自己重查再按 id 重新指向那一条。
 */
async function onStatusAction(payload: {
  action: EventStatusAction
  assignee?: string
  note?: string
}): Promise<void> {
  const current = detail.value
  if (!current) return
  statusBusy.value = true
  const result = await callApi(() =>
    window.api.eventCenter.changeStatus({
      entryId: current.id,
      // 聚合告警：一次处置落到组内每一条触发（服务端在同一个事务里写）。
      ...(current.members.length > 1 ? { entryIds: current.members.map((m) => m.id) } : {}),
      action: payload.action,
      ...(payload.assignee !== undefined ? { assignee: payload.assignee } : {}),
      ...(payload.note !== undefined ? { note: payload.note } : {}),
      // 指派时把"界面看到的当前状态"带下去：状态行不存在时用它建行，
      // 免得指派顺手把一条已确认的事件退回「待处理」（仓储层的注释写了完整推理）。
      currentStatus: current.status
    })
  )
  statusBusy.value = false

  if (!result.success) {
    store.error = resultMessage(result)
    return
  }

  await store.applyQuery(buildQuery())
  const refreshed = allAlerts.value.find((item) => item.id === current.id)
  if (refreshed) {
    // 只换数据、不动页签：操作员可能正停在 Activity 上看刚写进去的那一条。
    detail.value = refreshed
    playerRecordingId.value = defaultPlayerId(refreshed.entry)
  }
  await loadActivity(current.id)

  const view = unwrap(result)
  const appliedTo = view?.appliedTo ?? 1
  store.notice =
    payload.action === 'assign'
      ? t('eventsUi.assignDone', { name: payload.assignee ?? '' })
      : appliedTo > 1
        ? t('eventsUi.statusChangeDoneMany', {
            status: t(alertStatusLabelKey(view?.status ?? current.status)),
            count: appliedTo
          })
        : t('eventsUi.statusChangeDone', {
            status: t(alertStatusLabelKey(view?.status ?? current.status))
          })
}

// ---------------------------------------------------------------------------
// 跳转与展示
// ---------------------------------------------------------------------------

function openDevice(deviceId: string): void {
  void router.push(`/devices/${deviceId}`)
}

function actionLabel(action: string): string {
  return t(`linkage.action.${action}` as never)
}

function actionStateLabel(status: string): string {
  return t(`linkage.actionState.${status}` as never)
}

/**
 * 抽屉 Overview 的属性表（规格 §11.4）。
 *
 * 字段由纯函数决定（`alertOverviewFields`，有单测）：哪几格存在、持续时长在聚合之前是
 * 「—」、没有确认能力的来源状态是「—」、设备回的原始等级只有真回过才出现。
 */
const overviewFields = computed(() => (detail.value ? alertOverviewFields(detail.value) : []))

async function goToPage(offset: number): Promise<void> {
  closeDetail()
  await store.goToPage(offset)
}
</script>

<template>
  <div class="page">
    <!-- 没有页面标题：外层框架已经写了「事件与告警中心」。只剩刷新动作。 -->
    <div class="page-header">
      <div class="btn-row">
        <button type="button" class="btn btn--sm" :disabled="store.loading" @click="reload">
          {{ store.loading ? t('common.loading') : t('common.refresh') }}
        </button>
      </div>
    </div>

    <p v-if="store.error" class="alert alert--danger" role="alert">{{ store.error }}</p>
    <p v-else-if="store.notice" class="alert alert--success" role="status">{{ store.notice }}</p>

    <!--
      截断说明。每路来源都有读取上限，超出的部分不会被静默丢掉——
      这一行就是「本次结果不完整」的显式声明。
    -->
    <p v-if="store.truncated" class="alert alert--warning" role="status">
      {{ t('eventsUi.truncated', { cap: perSourceCap }) }}
    </p>

    <EventKpiStrip
      :kpis="kpis"
      :loaded="alerts.length"
      :total="store.total"
      :severity="filters.severity"
      :ack="filters.ack"
      @filter="patchFilter"
    />

    <section class="card">
      <div class="filter-bar">
        <div class="field event-filters__search">
          <input
            v-model="filters.search"
            class="input"
            type="search"
            :placeholder="t('eventsUi.searchPlaceholder')"
            :aria-label="t('eventsUi.searchPlaceholder')"
          />
        </div>

        <label class="field">
          <span class="field-label">{{ t('eventsUi.filterFrom') }}</span>
          <input v-model="filters.from" class="input" type="datetime-local" />
        </label>

        <label class="field">
          <span class="field-label">{{ t('eventsUi.filterTo') }}</span>
          <input v-model="filters.to" class="input" type="datetime-local" />
        </label>

        <button
          v-if="hasActiveFilters"
          type="button"
          class="btn event-filters__clear"
          @click="clearFilters"
        >
          {{ t('eventsUi.clearFilters') }}
        </button>
      </div>

      <div class="filter-bar filter-bar--views">
        <div class="field">
          <span class="field-label">{{ t('eventsUi.savedViewTitle') }}</span>
          <div class="btn-row">
            <button
              v-for="view in EVENT_SAVED_VIEWS"
              :key="view.id"
              type="button"
              class="btn btn--sm"
              :class="{ 'btn--primary': activeSavedViewId === view.id }"
              :aria-pressed="activeSavedViewId === view.id"
              @click="applySavedView(view)"
            >
              {{ t(view.labelKey) }}
            </button>
          </div>
        </div>

        <div class="field">
          <span class="field-label">{{ t('eventsUi.groupWindowLabel') }}</span>
          <select
            v-model="filters.groupWindow"
            class="select"
            data-field="group-window"
            @change="activeSavedViewId = null"
          >
            <option v-for="choice in GROUP_WINDOW_CHOICES" :key="choice.id" :value="choice.id">
              {{ t(choice.labelKey) }}
            </option>
          </select>
        </div>

        <div class="field">
          <span class="field-label">{{ t('eventsUi.filterPanelToggle') }}</span>
          <div class="btn-row">
            <button
              type="button"
              class="btn btn--sm"
              :aria-pressed="filterPanelOpen"
              data-action="filter-panel-toggle"
              @click="filterPanelOpen = !filterPanelOpen"
            >
              {{ t('eventsUi.filterPanelTitle') }}
            </button>
            <button
              v-for="mode in EVENT_VIEW_MODES"
              :key="mode"
              type="button"
              class="btn btn--sm"
              :class="{ 'btn--primary': viewMode === mode }"
              :aria-pressed="viewMode === mode"
              :data-view-mode="mode"
              @click="setViewMode(mode)"
            >
              {{ t(`eventsUi.viewMode.${mode}`) }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <div class="event-layout">
      <EventFilterPanel
        v-if="filterPanelOpen"
        :filter="filters"
        :counts="counts"
        :devices="devices.devices"
        :loaded="alerts.length"
        @patch="patchFilter"
      />

      <div class="event-main">
        <AlertQueue
          :alerts="alerts"
          :selected-id="selectedId"
          :view-mode="viewMode"
          :empty-title="emptyTitle"
          @select="openDetail"
        />

        <div class="pager">
          <span class="muted">{{ t('eventsUi.countSummary', { total: store.total }) }}</span>
          <span v-if="searchActive" class="muted">
            {{ t('eventsUi.searchScope', { loaded: allAlerts.length }) }}
          </span>
          <div class="btn-row">
            <button
              type="button"
              class="btn btn--sm"
              :disabled="!canPrev"
              @click="goToPage(page.offset - EVENT_PAGE_SIZE)"
            >
              {{ t('alarmsUi.prevPage') }}
            </button>
            <button
              type="button"
              class="btn btn--sm"
              :disabled="!canNext"
              @click="goToPage(page.offset + EVENT_PAGE_SIZE)"
            >
              {{ t('alarmsUi.nextPage') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!--
      逐来源读况。相机离线时另外两路照样渲染，而这一块把「哪一路读不到、
      为什么」写在页面上——失败既不被吞掉，也不会让整页空白。

      只在**有话说**时出现（某一路失败 / 被截断）：三路都正常时这块卡片只是三行绿字，
      却占掉队列的第一屏；来源条数已经在左侧筛选面板里逐路给出。
    -->
    <section v-if="sourcesNeedAttention" class="card sources">
      <h3 class="section-title">{{ t('eventsUi.sourcesTitle') }}</h3>
      <div class="sources__grid">
        <div v-for="source in store.sources" :key="source.source" class="sources__item">
          <span class="sources__name">{{ eventSourceLabel(source.source) }}</span>
          <span v-if="source.ok" class="badge badge--success">
            {{ t('eventsUi.sourceOk', { count: source.items }) }}
          </span>
          <span v-else class="badge badge--danger">
            {{ t('eventsUi.sourceFailed', { reason: source.error ?? '' }) }}
          </span>
          <span v-if="source.truncated > 0" class="badge badge--warning">
            {{ t('eventsUi.sourceTruncated', { count: source.truncated }) }}
          </span>
          <span v-if="source.untimed > 0" class="badge">
            {{ t('eventsUi.sourceUntimed', { count: source.untimed }) }}
          </span>
        </div>
      </div>
    </section>

    <!--
      详情抽屉（规格 §11）。结构（几何/页签/头部/键盘）在组件里，**写库的动作在页面里** ——
      状态是页面的数据，而且写完要重查一次（队列与 KPI 都要跟着变）。
    -->
    <EventDetailDrawer
      v-if="detail"
      :alert="detail"
      :width="drawerWidth"
      :tab="drawerTab"
      :assignees="assignees"
      :busy="statusBusy"
      @close="closeDetail"
      @resize="setDrawerWidth"
      @update:tab="drawerTab = $event"
      @prev="stepAlert(-1)"
      @next="stepAlert(1)"
      @open-device="openDevice(detail.deviceId)"
      @status-action="onStatusAction"
    >
      <!-- Timeline（规格 §13.1）：从"首次探测到"开始，把我们的动作与来源的事实排成一条线。 -->
      <template #timeline>
        <section class="drawer__section drawer__section--first">
          <h4 class="drawer__section-title">{{ t('eventsUi.timelineTitle') }}</h4>
          <ol class="timeline" data-panel-list="timeline">
            <li
              v-for="(node, index) in timelineNodes"
              :key="`${node.kind}-${node.at}-${index}`"
              class="timeline__node"
            >
              <span class="timeline__dot" aria-hidden="true"></span>
              <span class="timeline__time">{{ formatDateTime(node.at) }}</span>
              <span class="timeline__text">
                <template v-if="node.kind === 'detected'">
                  {{ t('eventsUi.timelineDetected') }}
                  <span v-if="node.approximate" class="chip chip--tiny">
                    {{ t('eventsUi.approximateBadge') }}
                  </span>
                </template>
                <template v-else-if="node.kind === 'status'">
                  {{
                    t('eventsUi.activityStatusLine', {
                      actor: node.actor,
                      from: t(alertStatusLabelKey(node.from)),
                      to: t(alertStatusLabelKey(node.to))
                    })
                  }}
                  <span v-if="node.note" class="muted">· {{ node.note }}</span>
                </template>
                <template v-else-if="node.kind === 'assign'">
                  {{ t('eventsUi.activityAssignLine', { actor: node.actor, name: node.assignee }) }}
                </template>
                <template v-else-if="node.kind === 'note'">
                  {{ t('eventsUi.activityNoteLine', { actor: node.actor }) }}：{{ node.note }}
                </template>
                <template v-else-if="node.kind === 'occurrence'">
                  {{ t('eventsUi.timelineOccurrence', { index: node.index }) }}
                </template>
                <template v-else-if="node.kind === 'linkage-action'">
                  {{
                    t('eventsUi.detailActionLine', {
                      action: actionLabel(node.action),
                      status: actionStateLabel(node.status)
                    })
                  }}
                  <span v-if="node.reason" class="muted">· {{ node.reason }}</span>
                </template>
              </span>
            </li>
          </ol>
        </section>
      </template>

      <!-- Related（规格 §13.2）：三组相关性，点击切到那一条。 -->
      <template #related>
        <section class="drawer__section drawer__section--first">
          <h4 class="drawer__section-title">{{ t('eventsUi.relatedTitle') }}</h4>
          <p class="muted related__scope">
            {{ t('eventsUi.relatedScope', { loaded: allAlerts.length }) }}
          </p>
          <div v-for="group in related" :key="group.id" class="related__group">
            <div class="related__head">
              <span class="field-label">{{ t(group.labelKey) }}</span>
              <span class="muted">{{ t('eventsUi.panelCount', { count: group.ids.length }) }}</span>
            </div>
            <div v-if="group.ids.length > 0" class="chip-row">
              <button
                v-for="id in group.ids.slice(0, 8)"
                :key="id"
                type="button"
                class="chip related__chip"
                :title="t('eventsUi.relatedOpen')"
                @click="openRelated(id)"
              >
                {{ relatedLabel(id) }}
              </button>
              <span v-if="group.ids.length > 8" class="muted">
                {{ t('eventsUi.metricMore', { count: group.ids.length - 8 }) }}
              </span>
            </div>
          </div>
          <p v-if="related.every((group) => group.ids.length === 0)" class="muted">
            {{ t('eventsUi.relatedEmpty') }}
          </p>
        </section>
      </template>

      <!-- Activity（规格 §13.3）：状态变更 / 指派 / 留言，新的在前。 -->
      <template #activity>
        <section class="drawer__section drawer__section--first">
          <h4 class="drawer__section-title">{{ t('eventsUi.activityTitle') }}</h4>
          <p v-if="activityList.length === 0" class="muted">{{ t('eventsUi.activityEmpty') }}</p>
          <ul v-else class="activity" data-panel-list="activity">
            <li
              v-for="(row, index) in activityList"
              :key="`${row.kind}-${row.at}-${index}`"
              class="activity__row"
            >
              <span class="activity__time">{{ formatDateTime(row.at) }}</span>
              <span class="activity__text">
                <template v-if="row.kind === 'status'">
                  {{
                    t('eventsUi.activityStatusLine', {
                      actor: row.actor,
                      from: t(alertStatusLabelKey(row.from)),
                      to: t(alertStatusLabelKey(row.to))
                    })
                  }}
                  <span v-if="row.note" class="muted">· {{ row.note }}</span>
                </template>
                <template v-else-if="row.kind === 'assign'">
                  {{ t('eventsUi.activityAssignLine', { actor: row.actor, name: row.assignee }) }}
                </template>
                <template v-else>
                  {{ t('eventsUi.activityNoteLine', { actor: row.actor }) }}：{{ row.note }}
                </template>
              </span>
            </li>
          </ul>
        </section>
      </template>

      <template #overview>
        <p v-if="detail.atApproximate" class="alert alert--warning">
          {{
            detail.source === 'deviceDetect' && detail.entry.detect?.startTimeRaw === undefined
              ? t('eventsUi.timeUnknown')
              : t('eventsUi.approximateHint')
          }}
        </p>

        <!-- 属性网格（规格 §11.4：2 列，长字段跨两列）。 -->
        <div class="drawer__grid">
          <div
            v-for="field in overviewFields"
            :key="field.labelKey"
            class="drawer__field"
            :class="{ 'drawer__field--wide': field.wide }"
          >
            <div class="field-label">{{ t(field.labelKey) }}</div>
            <div
              class="drawer__value"
              :class="[
                field.value.kind === 'text' && field.value.mono ? 'mono' : '',
                field.value.kind === 'label' && field.value.severity
                  ? `severity--${field.value.severity}`
                  : '',
                field.value.kind === 'label' && field.value.unknown ? 'severity--unknown' : ''
              ]"
            >
              <template v-if="field.value.kind === 'label'">
                <span class="drawer__value-label">{{ t(field.value.labelKey) }}</span>
              </template>
              <template v-else-if="field.value.kind === 'time'">
                {{ formatDateTime(field.value.at) }}
                <span v-if="field.value.approximate" class="chip chip--tiny">
                  {{ t('eventsUi.approximateBadge') }}
                </span>
              </template>
              <template v-else-if="field.value.kind === 'duration'">
                {{ formatDuration(field.value.ms) }}
              </template>
              <template v-else-if="field.value.kind === 'number'">
                {{ formatNumber(field.value.value, field.value.digits) }}{{ field.value.unit }}
              </template>
              <template v-else-if="field.value.kind === 'text'">{{ field.value.text }}</template>
              <template v-else>—</template>
            </div>
          </div>
        </div>

        <!-- 声纹告警独有的细节：通道与告警类型（解码在主进程完成）。 -->
        <section v-if="detail.entry.localAlarm" class="drawer__section">
          <h4 class="drawer__section-title">{{ t('eventsUi.detailLocalAlarmTypes') }}</h4>
          <p>
            <span class="muted">{{ t('eventsUi.detailLocalAlarmChannel') }}</span>
            {{ channelLabel(detail.entry.localAlarm.channelId) }}
          </p>
          <p>{{ describeAlarmMask(detail.entry.localAlarm.alarmMask) }}</p>
          <div v-if="detail.entry.localAlarm.alarmTypes.length > 1" class="chip-row">
            <span v-for="type in detail.entry.localAlarm.alarmTypes" :key="type" class="chip">
              {{ alarmTypeLabel(type) }}
            </span>
          </div>
        </section>

        <!-- 相机检测日志独有的细节：原始时间戳、目录、日志编号（只读信息）。 -->
        <section v-if="detail.entry.detect" class="drawer__section">
          <h4 class="drawer__section-title">{{ t('eventsUi.detailDetectTitle') }}</h4>
          <dl class="kv drawer__kv">
            <div v-if="detail.entry.detect.logId !== undefined" class="kv__item">
              <dt class="kv__label">{{ t('eventsUi.detailLogId') }}</dt>
              <dd class="kv__value">{{ detail.entry.detect.logId }}</dd>
            </div>
            <div v-if="detail.entry.detect.startTimeRaw !== undefined" class="kv__item">
              <dt class="kv__label">{{ t('eventsUi.detailDeviceTime') }}</dt>
              <dd class="kv__value">{{ detail.entry.detect.startTimeRaw }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('eventsUi.detailDeviceTimeUnit') }}</dt>
              <dd class="kv__value mono">{{ detail.entry.detect.timeUnit }}</dd>
            </div>
            <div v-if="detail.entry.detect.savingPath" class="kv__item">
              <dt class="kv__label">{{ t('eventsUi.detailSavingPath') }}</dt>
              <dd class="kv__value mono">{{ detail.entry.detect.savingPath }}</dd>
            </div>
            <div v-if="detail.entry.detect.detectMode !== undefined" class="kv__item">
              <dt class="kv__label">{{ t('eventsUi.detailDetectMode') }}</dt>
              <dd class="kv__value">{{ detail.entry.detect.detectMode }}</dd>
            </div>
          </dl>
        </section>

        <!-- 没有确认接口时如实说明为什么（能力不存在 -> 不画一个灰按钮）。 -->
        <p v-if="!detailCanAcknowledge" class="muted drawer__note">
          {{ t('eventsUi.detailAckUnsupported') }}
        </p>
      </template>

      <template #evidence>
        <!--
          Evidence（规格 §12.1 的 Acoustic 那一列）：视觉 / 音频 / 频谱与测量 / 结果文件。
          DTS / DAS / DGA 三个渲染器**不做**（我们一台那类设备都不管，见
          `docs/EVENT-CENTER.md` §3.1），所以这里按来源选渲染器，而不是复制三份抽屉。
        -->
        <section class="drawer__section drawer__section--first">
          <h4 class="drawer__section-title">{{ t('eventsUi.evidenceVisualTitle') }}</h4>

          <p v-if="evidenceImageBusy" class="muted">{{ t('common.loading') }}</p>
          <template v-else-if="evidenceImage && evidenceImage.state === 'ok' && evidenceImage.url">
            <a :href="evidenceImage.url" target="_blank" rel="noreferrer">
              <img
                class="evidence__image"
                :src="evidenceImage.url"
                :alt="evidenceImage.name ?? t('eventsUi.evidenceVisualTitle')"
                data-action="evidence-image"
              />
            </a>
            <p class="muted evidence__meta">{{ evidenceImage.name }}</p>
          </template>
          <p v-else-if="evidenceImage" class="muted">
            {{ evidenceImageNote() }}
          </p>
          <p v-else class="muted">{{ t('eventsUi.evidenceNone') }}</p>

          <p v-if="detail.entry.frameRelativePath" class="muted evidence__meta">
            {{ t('eventsUi.detailFrameTitle') }}
            <span class="mono">{{ detail.entry.frameRelativePath }}</span>
          </p>
        </section>

        <!-- 播放区：音频走共享的 RecordingPlayer，视频走回环地址。 -->
        <section class="drawer__section">
          <h4 class="drawer__section-title">{{ t('eventsUi.detailRecordingTitle') }}</h4>

          <div
            v-if="detail.entry.recordingContainer === 'mp4' && detail.entry.recordingId"
            class="video-block"
          >
            <button
              v-if="videoUrl === ''"
              type="button"
              class="btn btn--primary btn--sm"
              :disabled="videoBusy"
              @click="openVideo(detail.entry.recordingId)"
            >
              {{ t('eventsUi.detailFileOpenVideo') }}
            </button>
            <!-- 空 src 不变式：地址为空时这里渲染的是说明文字，不是黑框。 -->
            <video v-if="videoUrl" class="video-player" :src="videoUrl" controls autoplay></video>
          </div>

          <p v-if="videoError" class="alert alert--danger" role="alert">{{ videoError }}</p>

          <RecordingPlayer :recording-id="playerRecordingId">
            <template #action>
              <p class="muted">
                {{
                  detail.source === 'deviceDetect'
                    ? t('eventsUi.detailRecordingPending')
                    : t('eventsUi.detailRecordingNone')
                }}
              </p>
              <RouterLink class="btn btn--sm" to="/recordings">
                {{ t('eventsUi.detailRecordingGoto') }}
              </RouterLink>
            </template>
          </RecordingPlayer>
        </section>

        <!-- 频谱与测量：只列出真的存在的指标，绝不填 0。 -->
        <section v-if="detail.metrics.length > 0" class="drawer__section">
          <h4 class="drawer__section-title">{{ t('eventsUi.detailMetricsTitle') }}</h4>
          <dl class="kv drawer__kv">
            <div v-for="metric in detail.metrics" :key="metric.field" class="kv__item">
              <dt class="kv__label">{{ t(metric.labelKey) }}</dt>
              <dd class="kv__value">
                {{ formatNumber(metric.value, metric.digits) }}{{ metric.unit }}
              </dd>
            </div>
          </dl>
        </section>

        <!-- 联动动作：四个动作各自的成功/失败/跳过与原因。 -->
        <section
          v-if="detail.entry.linkageActions && detail.entry.linkageActions.length > 0"
          class="drawer__section"
        >
          <h4 class="drawer__section-title">{{ t('eventsUi.detailActionsTitle') }}</h4>
          <ul class="actions">
            <li v-for="record in detail.entry.linkageActions" :key="`${record.action}-${record.at}`">
              <span class="badge" :class="`badge--action-${record.status}`">
                {{
                  t('eventsUi.detailActionLine', {
                    action: actionLabel(record.action),
                    status: actionStateLabel(record.status)
                  })
                }}
              </span>
              <span v-if="record.reason" class="muted">
                {{ t('eventsUi.detailActionReason', { reason: record.reason }) }}
              </span>
            </li>
          </ul>
        </section>

        <!--
          **设备侧动作放在最后**（iVMS 参考里的 R5：改设备/取设备的动作排在
          改本机/看画面的动作之后）。这里是整页唯一会去连设备、写盘、登记录像
          行的动作，因此它在抽屉的最底部——不会与「播放」「确认」抢手指。
        -->
        <section v-if="detail.entry.detect" class="drawer__section">
          <h4 class="drawer__section-title">{{ t('eventsUi.detailFilesTitle') }}</h4>

          <p v-if="detail.entry.detect.files.length === 0" class="muted">
            {{ t('eventsUi.detailFilesEmpty') }}
          </p>
          <ul v-else class="files">
            <li v-for="file in detail.entry.detect.files" :key="file.kind" class="files__row">
              <div class="files__main">
                <span class="files__kind">{{ detectFileKindLabel(file.kind) }}</span>
                <span class="files__name mono">{{ file.fileName }}</span>
                <span class="chip chip--tiny">{{ file.container }}</span>
              </div>

              <div class="files__actions">
                <!-- 已下载：只渲染真的能用的动作（音频播放 / 视频打开）。 -->
                <template v-if="file.downloadedRecordingId">
                  <span class="badge badge--success">{{ t('eventsUi.detailFileDownloaded') }}</span>
                  <button
                    v-if="file.container === 'mp4'"
                    type="button"
                    class="btn btn--sm"
                    :disabled="videoBusy"
                    @click="playDetectFile(file)"
                  >
                    {{ t('eventsUi.detailFileOpenVideo') }}
                  </button>
                  <button
                    v-else-if="canPlayAudio(file.container)"
                    type="button"
                    class="btn btn--sm"
                    @click="playDetectFile(file)"
                  >
                    {{ t('eventsUi.detailFilePlay') }}
                  </button>
                </template>

                <!-- 未下载：动作可能存在但此刻不可用 -> 禁用并给出原因。 -->
                <template v-else>
                  <span v-if="downloadBlockedReason()" class="muted files__blocked">
                    {{ downloadBlockedReason() }}
                  </span>
                  <button
                    type="button"
                    class="btn btn--sm"
                    :disabled="
                      downloadBlockedReason() !== '' ||
                      downloadState(detail.entry, file.kind)?.stage === 'fetching'
                    "
                    @click="downloadFile(detail.entry, file.kind, file.fileName)"
                  >
                    {{
                      downloadState(detail.entry, file.kind)?.stage === 'fetching'
                        ? t('eventsUi.detailFileDownloading')
                        : t('eventsUi.detailFileDownload')
                    }}
                  </button>
                  <span
                    v-if="downloadState(detail.entry, file.kind)"
                    class="muted files__blocked"
                  >
                    {{
                      eventDownloadStageLabel(downloadState(detail.entry, file.kind)?.stage ?? '')
                    }}
                  </span>
                </template>
              </div>
            </li>
          </ul>
        </section>
      </template>
    </EventDetailDrawer>
  </div>
</template>

<style scoped>
/*
 * 三栏：左侧筛选面板（216，规格 §4.1）| 告警队列 | （详情抽屉是覆盖层，不占列）。
 * 面板收起来时 `1fr` 那一列自动铺满 —— 不需要第二套布局。
 */
.event-layout {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
}

.event-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.event-filters__search {
  flex: 1 1 260px;
  max-width: 320px;
}

.event-filters__clear {
  align-self: flex-end;
}

/*
 * 时间线（规格 §13.1）：节点 8px、线 1px —— 规格明确不要大圆点或大色块。
 * 用左边一条竖线 + 每行一个点，行距靠 padding 撑开。
 */
.timeline {
  margin: 0;
  padding: 0 0 0 var(--space-2);
  list-style: none;
  border-left: 1px solid var(--color-border);
}

.timeline__node {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: 0 0 var(--space-3) var(--space-3);
  font-size: var(--font-size-small);
}

.timeline__dot {
  position: absolute;
  left: calc(-1 * var(--space-2) - 4px);
  top: 5px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-border-strong);
}

.timeline__time,
.activity__time {
  flex: none;
  color: var(--color-text-tertiary);
  font-size: var(--font-size-meta);
  font-variant-numeric: tabular-nums;
}

.timeline__text,
.activity__text {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* 处置记录（规格 §13.3）：一行一条，时间在左。 */
.activity {
  margin: 0;
  padding: 0;
  list-style: none;
}

.activity__row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--color-border);
  font-size: var(--font-size-small);
}

.activity__row:last-child {
  border-bottom: 0;
}

/* 相关性分组（规格 §13.2）。 */
.related__scope {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-meta);
}

.related__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--color-border);
}

.related__group:last-of-type {
  border-bottom: 0;
}

.related__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.related__chip {
  cursor: pointer;
}

.related__chip:hover {
  border-color: var(--color-accent);
  color: var(--color-accent-hover);
}

.filter-note {
  margin-top: var(--space-2);
  font-size: 11.5px;
}

.sources__grid {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.sources__item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 6px 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
}

.sources__name {
  font-weight: 600;
}

.badge--action-success {
  background: rgba(34, 197, 94, 0.16);
  color: #166534;
}

.badge--action-failed {
  background: rgba(239, 68, 68, 0.16);
  color: #991b1b;
}

.badge--action-skipped {
  background: rgba(107, 114, 128, 0.14);
  color: #4b5563;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: 12px;
}

.files {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}

.files__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
}

.files__main {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.files__kind {
  font-size: 12.5px;
  font-weight: 600;
}

.files__name {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 190px;
}

.files__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.files__blocked {
  font-size: 11px;
  max-width: 190px;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.video-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.video-player {
  width: 100%;
  max-height: 240px;
  background: #000;
  border-radius: var(--radius-sm);
}

.drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  background: rgba(23, 23, 23, 0.24);
  display: flex;
  justify-content: flex-end;
}

.drawer {
  width: 480px;
  max-width: 94vw;
  height: 100%;
  background: var(--color-bg);
  border-left: 1px solid var(--color-border);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
}

.drawer__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 12px 14px;
  border-bottom: 1px solid var(--color-border);
}

.drawer__sub {
  font-size: 11.5px;
}

.drawer__body {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.drawer__kv {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.drawer__section {
  border-top: 1px solid var(--color-border);
  padding-top: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.drawer__section-title {
  font-size: 12.5px;
  font-weight: 600;
}
</style>
