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
  EVENT_FILTER_STORAGE_KEY,
  EVENT_SAVED_VIEWS,
  EVENT_VIEW_MODES,
  EVENT_VIEW_MODE_STORAGE_KEY,
  ackFilterToQuery,
  emptyEventFilter,
  eventFilterCounts,
  eventFilterFromQuery,
  eventFilterToQuery,
  eventKpis,
  hasEventFilterQuery,
  isEventFilterActive,
  matchEventSearch,
  parseEventFilter,
  parseEventViewMode,
  querySeverityFor,
  savedViewFromMs,
  serializeEventFilter,
  toAlertViewModels
} from '@shared/domain/event-view'
import type {
  AlertViewModel,
  EventQueueFilter,
  EventSavedView,
  EventViewMode
} from '@shared/domain/event-view'
import type { Fa371ResultFileKind } from '@shared/domain/fa371'
import AlertQueue from '@renderer/components/event-center/AlertQueue.vue'
import EventFilterPanel from '@renderer/components/event-center/EventFilterPanel.vue'
import EventKpiStrip from '@renderer/components/event-center/EventKpiStrip.vue'
import RecordingPlayer from '@renderer/components/RecordingPlayer.vue'
import {
  alarmTypeLabel,
  describeAlarmMask,
  detectFileKindLabel,
  eventDownloadStageLabel,
  eventKindLabel,
  eventSeverityLabel,
  eventSourceLabel
} from '@renderer/lib/labels'
import {
  channelLabel,
  formatBytes,
  formatDateTime,
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

const detail = ref<EventCenterEntry | null>(null)
/** 队列里当前选中的告警 id（↑/↓ 与详情抽屉都看它）。 */
const selectedId = ref<string | null>(null)
/** 抽屉里正在播放的音频录像行（deviceDetect 的结果文件按需切换）。 */
const playerRecordingId = ref<string | null>(null)
/** 抽屉里的视频地址；**非播放状态恒为空串**（空 src 不变式）。 */
const videoUrl = ref('')
const videoError = ref('')
const videoBusy = ref(false)

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

/**
 * Esc 关抽屉（规格 §10.3）。
 *
 * 监听在 `window` 上而不是某个元素上：抽屉是覆盖层，焦点可能在任何地方（甚至是刚点完的
 * 下载按钮）。只在抽屉确实开着时才响应，避免把其它页面的 Esc 语义吃掉。
 */
function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && detail.value) closeDetail()
}

onMounted(async () => {
  if (devices.devices.length === 0) await devices.load()
  // 联动待处理列表只有在这里读一次，才能把「已确认/未确认」与顶栏角标对齐。
  if (!linkage.loaded) void linkage.load()
  window.addEventListener('keydown', onWindowKeydown)
  unsubscribeProgress = window.events.onEventCenterDownloadProgress(
    (progress: EventDownloadProgress) => store.handleProgress(progress)
  )
  await reload()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  unsubscribeProgress?.()
  unsubscribeProgress = undefined
})

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
    filters.ack
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
  selectedId.value = alert.id
  detail.value = alert.entry
  playerRecordingId.value = defaultPlayerId(alert.entry)
  videoUrl.value = ''
  videoError.value = ''
}

function closeDetail(): void {
  detail.value = null
  playerRecordingId.value = null
  // 先清地址再卸载 `<video>`：元素会释放回环连接（与 RecordingsView 同一顺序）。
  videoUrl.value = ''
  videoError.value = ''
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
    const refreshed = store.items.find((item) => item.id === entry.id)
    if (refreshed) detail.value = refreshed
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

/** 该事件的确认能力：设备检测日志没有这个接口，所以整块不渲染。 */
const detailCanAcknowledge = computed(() => detail.value?.source !== 'deviceDetect')

async function toggleAcknowledge(): Promise<void> {
  const current = detail.value
  if (!current || current.source === 'deviceDetect') return
  const payload = await store.acknowledge([current.id])
  if (!payload) return
  const perSource = payload.perSource.find((entry) => entry.source === current.source)
  if (perSource?.unsupported) {
    store.notice = t('eventsUi.detailAckUnsupported')
    return
  }
  if (perSource?.error) {
    store.notice = t('eventsUi.detailAckFailed', { reason: perSource.error })
    return
  }
  detail.value = { ...current, acknowledged: true }
  store.notice = t('eventsUi.detailAckDone', { count: payload.acknowledged })
}

/** 联动待处理记录只能「确认」，没有取消确认的接口——所以已确认时不渲染按钮。 */
const detailAckVisible = computed(() => {
  const current = detail.value
  if (!current || current.source === 'deviceDetect') return false
  if (current.source === 'linkage') return !current.acknowledged
  return true
})

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

/** 事件详情里按需展示的指标（只显示存在的，绝不填 0）。 */
const detailMetrics = computed<Array<{ label: string; value: string }>>(() => {
  const metrics = detail.value?.metrics
  if (!metrics) return []
  const out: Array<{ label: string; value: string }> = []
  if (metrics.spl !== undefined) out.push({ label: t('metrics.spl'), value: `${formatNumber(metrics.spl, 2)} dB` })
  if (metrics.mainFrequency !== undefined) {
    out.push({ label: t('metrics.mainFrequency'), value: `${formatNumber(metrics.mainFrequency, 2)} Hz` })
  }
  if (metrics.smoothness !== undefined) {
    out.push({ label: t('metrics.smoothness'), value: formatNumber(metrics.smoothness, 3) })
  }
  if (metrics.bandEnergyRatio !== undefined) {
    out.push({ label: t('metrics.bandEnergyRatio'), value: formatNumber(metrics.bandEnergyRatio, 3) })
  }
  if (metrics.soundmapIntensity !== undefined) {
    out.push({
      label: t('eventsUi.metricSoundmapIntensity'),
      value: formatNumber(metrics.soundmapIntensity, 2)
    })
  }
  if (metrics.leakVolume !== undefined) {
    out.push({ label: t('eventsUi.metricLeakVolume'), value: formatNumber(metrics.leakVolume, 3) })
  }
  if (metrics.leakCost !== undefined) {
    out.push({ label: t('eventsUi.metricLeakCost'), value: formatNumber(metrics.leakCost, 3) })
  }
  return out
})

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

    <!-- 详情抽屉 -->
    <div v-if="detail" class="drawer-overlay" @click.self="closeDetail">
      <aside class="drawer" role="dialog" aria-modal="true" :aria-label="t('eventsUi.detailTitle')">
        <header class="drawer__header">
          <div>
            <h3 class="section-title">{{ t('eventsUi.detailTitle') }}</h3>
            <p class="muted drawer__sub">
              {{ formatDateTime(detail.at) }}
              <span v-if="detail.atApproximate" class="chip chip--tiny">
                {{ t('eventsUi.approximateBadge') }}
              </span>
            </p>
          </div>
          <button
            type="button"
            class="btn btn--ghost btn--icon"
            :aria-label="t('common.close')"
            @click="closeDetail"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3 3l10 10M13 3L3 13"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </header>

        <div class="drawer__body">
          <p v-if="detail.atApproximate" class="alert alert--warning">
            {{
              detail.source === 'deviceDetect' && detail.detect?.startTimeRaw === undefined
                ? t('eventsUi.timeUnknown')
                : t('eventsUi.approximateHint')
            }}
          </p>

          <dl class="kv drawer__kv">
            <div class="kv__item">
              <dt class="kv__label">{{ t('eventsUi.detailEventId') }}</dt>
              <dd class="kv__value mono">{{ detail.id }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('eventsUi.detailDevice') }}</dt>
              <dd class="kv__value">
                <button type="button" class="link-btn" @click="openDevice(detail.deviceId)">
                  {{ devices.nameById(detail.deviceId) }}
                </button>
              </dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('eventsUi.detailSource') }}</dt>
              <dd class="kv__value">{{ eventSourceLabel(detail.source) }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('eventsUi.detailKind') }}</dt>
              <dd class="kv__value">{{ eventKindLabel(detail.kind) }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('eventsUi.detailSeverity') }}</dt>
              <dd class="kv__value">{{ eventSeverityLabel(detail.severity) }}</dd>
            </div>
            <div v-if="detail.alarmLevelRaw !== undefined" class="kv__item">
              <dt class="kv__label">{{ t('eventsUi.detailAlarmLevel') }}</dt>
              <dd class="kv__value">{{ detail.alarmLevelRaw }}</dd>
            </div>
          </dl>

          <!-- 声纹告警独有的细节：通道与告警类型（解码在主进程完成）。 -->
          <section v-if="detail.localAlarm" class="drawer__section">
            <h4 class="drawer__section-title">{{ t('eventsUi.detailLocalAlarmTypes') }}</h4>
            <p>
              <span class="muted">{{ t('eventsUi.detailLocalAlarmChannel') }}</span>
              {{ channelLabel(detail.localAlarm.channelId) }}
            </p>
            <p>{{ describeAlarmMask(detail.localAlarm.alarmMask) }}</p>
            <div v-if="detail.localAlarm.alarmTypes.length > 1" class="chip-row">
              <span
                v-for="type in detail.localAlarm.alarmTypes"
                :key="type"
                class="chip"
              >
                {{ alarmTypeLabel(type) }}
              </span>
            </div>
          </section>

          <!-- 相机检测日志独有的细节：原始时间戳、目录、日志编号（只读信息）。 -->
          <section v-if="detail.detect" class="drawer__section">
            <h4 class="drawer__section-title">{{ t('eventsUi.detailDetectTitle') }}</h4>
            <dl class="kv drawer__kv">
              <div v-if="detail.detect.logId !== undefined" class="kv__item">
                <dt class="kv__label">{{ t('eventsUi.detailLogId') }}</dt>
                <dd class="kv__value">{{ detail.detect.logId }}</dd>
              </div>
              <div v-if="detail.detect.startTimeRaw !== undefined" class="kv__item">
                <dt class="kv__label">{{ t('eventsUi.detailDeviceTime') }}</dt>
                <dd class="kv__value">{{ detail.detect.startTimeRaw }}</dd>
              </div>
              <div class="kv__item">
                <dt class="kv__label">{{ t('eventsUi.detailDeviceTimeUnit') }}</dt>
                <dd class="kv__value mono">{{ detail.detect.timeUnit }}</dd>
              </div>
              <div v-if="detail.detect.savingPath" class="kv__item">
                <dt class="kv__label">{{ t('eventsUi.detailSavingPath') }}</dt>
                <dd class="kv__value mono">{{ detail.detect.savingPath }}</dd>
              </div>
              <div v-if="detail.detect.detectMode !== undefined" class="kv__item">
                <dt class="kv__label">{{ t('eventsUi.detailDetectMode') }}</dt>
                <dd class="kv__value">{{ detail.detect.detectMode }}</dd>
              </div>
            </dl>
          </section>

          <!-- 播放区：音频走共享的 RecordingPlayer，视频走回环地址。 -->
          <section class="drawer__section">
            <h4 class="drawer__section-title">{{ t('eventsUi.detailRecordingTitle') }}</h4>

            <div v-if="detail.recordingContainer === 'mp4' && detail.recordingId" class="video-block">
              <button
                v-if="videoUrl === ''"
                type="button"
                class="btn btn--primary btn--sm"
                :disabled="videoBusy"
                @click="openVideo(detail.recordingId)"
              >
                {{ t('eventsUi.detailFileOpenVideo') }}
              </button>
              <!-- 空 src 不变式：地址为空时这里渲染的是说明文字，不是黑框。 -->
              <video
                v-if="videoUrl"
                class="video-player"
                :src="videoUrl"
                controls
                autoplay
              ></video>
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

            <p v-if="detail.frameRelativePath" class="muted">
              {{ t('eventsUi.detailFrameTitle') }}：{{ detail.frameRelativePath }}
            </p>
          </section>

          <!-- 指标：只列出存在的字段。 -->
          <section v-if="detailMetrics.length > 0" class="drawer__section">
            <h4 class="drawer__section-title">{{ t('eventsUi.detailMetricsTitle') }}</h4>
            <dl class="kv drawer__kv">
              <div v-for="metric in detailMetrics" :key="metric.label" class="kv__item">
                <dt class="kv__label">{{ metric.label }}</dt>
                <dd class="kv__value">{{ metric.value }}</dd>
              </div>
            </dl>
          </section>

          <!-- 联动动作：四个动作各自的成功/失败/跳过与原因。 -->
          <section v-if="detail.linkageActions && detail.linkageActions.length > 0" class="drawer__section">
            <h4 class="drawer__section-title">{{ t('eventsUi.detailActionsTitle') }}</h4>
            <ul class="actions">
              <li v-for="record in detail.linkageActions" :key="`${record.action}-${record.at}`">
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
            确认区。相机检测日志**没有**确认接口，所以整块不渲染，
            并如实说明为什么没有（能力不存在 -> 不画一个灰按钮）。
          -->
          <section class="drawer__section">
            <h4 class="drawer__section-title">{{ t('eventsUi.detailAckTitle') }}</h4>
            <p v-if="!detailCanAcknowledge" class="muted">
              {{ t('eventsUi.detailAckUnsupported') }}
            </p>
            <div v-else class="btn-row">
              <button
                v-if="detailAckVisible"
                type="button"
                class="btn"
                :disabled="store.ackBusy"
                @click="toggleAcknowledge"
              >
                {{
                  detail.source === 'linkage' || !detail.acknowledged
                    ? t('eventsUi.detailAck')
                    : t('eventsUi.detailUnack')
                }}
              </button>
              <span v-else class="badge badge--success">
                {{ t('eventsUi.ackAcknowledged') }}
              </span>
            </div>
          </section>

          <!--
            **设备侧动作放在最后**（iVMS 参考里的 R5：改设备/取设备的动作排在
            改本机/看画面的动作之后）。这里是整页唯一会去连设备、写盘、登记录像
            行的动作，因此它在抽屉的最底部——不会与「播放」「确认」抢手指。
          -->
          <section v-if="detail.detect" class="drawer__section">
            <h4 class="drawer__section-title">{{ t('eventsUi.detailFilesTitle') }}</h4>

            <p v-if="detail.detect.files.length === 0" class="muted">
              {{ t('eventsUi.detailFilesEmpty') }}
            </p>
            <ul v-else class="files">
              <li v-for="file in detail.detect.files" :key="file.kind" class="files__row">
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
                        downloadState(detail, file.kind)?.stage === 'fetching'
                      "
                      @click="downloadFile(detail, file.kind, file.fileName)"
                    >
                      {{
                        downloadState(detail, file.kind)?.stage === 'fetching'
                          ? t('eventsUi.detailFileDownloading')
                          : t('eventsUi.detailFileDownload')
                      }}
                    </button>
                    <span v-if="downloadState(detail, file.kind)" class="muted files__blocked">
                      {{ eventDownloadStageLabel(downloadState(detail, file.kind)?.stage ?? '') }}
                    </span>
                  </template>
                </div>
              </li>
            </ul>
          </section>
        </div>
      </aside>
    </div>
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

.link-btn {
  border: none;
  background: none;
  padding: 0;
  color: var(--color-text);
  cursor: pointer;
  font-size: 12.5px;
}

.link-btn:hover {
  color: var(--color-accent);
  text-decoration: underline;
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
