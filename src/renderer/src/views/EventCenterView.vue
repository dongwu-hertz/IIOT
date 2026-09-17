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
import { useRouter } from 'vue-router'
import type {
  EventCenterEntry,
  EventCenterQuery,
  EventDetectDownloadInput,
  EventDownloadProgress,
  EventSeverity,
  EventSourceKind
} from '@shared/ipc/contract'
import { EVENT_SEVERITIES, EVENT_SOURCE_KINDS, eventCenterPerSourceCap } from '@shared/domain/event-center'
import type { Fa371ResultFileKind } from '@shared/domain/fa371'
import EmptyState from '@renderer/components/EmptyState.vue'
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
  fromDateTimeLocalValue
} from '@renderer/lib/format'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { EVENT_PAGE_SIZE, eventDownloadKey, useEventCenterStore } from '@renderer/stores/eventCenter'
import { useDevicesStore } from '@renderer/stores/devices'
import { useSessionStore } from '@renderer/stores/session'
import { useAlarmLinkageStore } from '@renderer/stores/alarmLinkage'

const { t } = useI18n()
const router = useRouter()
const store = useEventCenterStore()
const devices = useDevicesStore()
const session = useSessionStore()
const linkage = useAlarmLinkageStore()

const SOURCE_OPTIONS: readonly EventSourceKind[] = EVENT_SOURCE_KINDS
const SEVERITY_OPTIONS: readonly EventSeverity[] = EVENT_SEVERITIES

type AckFilter = 'all' | 'true' | 'false'

interface FilterState {
  deviceId: string
  source: string
  severity: string
  from: string
  to: string
  ack: AckFilter
}

const filters = reactive<FilterState>({
  deviceId: '',
  source: '',
  severity: '',
  from: '',
  to: '',
  ack: 'all'
})

const detail = ref<EventCenterEntry | null>(null)
/** 抽屉里正在播放的音频录像行（deviceDetect 的结果文件按需切换）。 */
const playerRecordingId = ref<string | null>(null)
/** 抽屉里的视频地址；**非播放状态恒为空串**（空 src 不变式）。 */
const videoUrl = ref('')
const videoError = ref('')
const videoBusy = ref(false)

const rows = computed(() => store.items)
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

const hasActiveFilters = computed(
  () =>
    filters.deviceId !== '' ||
    filters.source !== '' ||
    filters.severity !== '' ||
    filters.from !== '' ||
    filters.to !== '' ||
    filters.ack !== 'all'
)

/** 空状态文案：区分「设备什么都没报」与「筛选把数据排除了」。 */
const emptyTitle = computed(() =>
  hasActiveFilters.value ? t('eventsUi.emptyFilteredTitle') : t('eventsUi.emptyTitle')
)

function buildQuery(): Partial<EventCenterQuery> {
  const query: Partial<EventCenterQuery> = { limit: EVENT_PAGE_SIZE, offset: 0 }
  if (filters.deviceId !== '') query.deviceId = filters.deviceId
  if (filters.source !== '') query.sources = [filters.source as EventSourceKind]
  if (filters.severity !== '') query.severity = filters.severity as EventSeverity
  const from = fromDateTimeLocalValue(filters.from)
  if (from !== undefined) query.from = from
  const to = fromDateTimeLocalValue(filters.to)
  if (to !== undefined) query.to = to
  if (filters.ack !== 'all') query.acknowledged = filters.ack === 'true'
  return query
}

async function reload(): Promise<void> {
  closeDetail()
  await store.applyQuery(buildQuery())
}

function reset(): void {
  filters.deviceId = ''
  filters.source = ''
  filters.severity = ''
  filters.from = ''
  filters.to = ''
  filters.ack = 'all'
  void reload()
}

// ---------------------------------------------------------------------------
// 下载进度订阅
// ---------------------------------------------------------------------------

let unsubscribeProgress: (() => void) | undefined

onMounted(async () => {
  if (devices.devices.length === 0) await devices.load()
  // 联动待处理列表只有在这里读一次，才能把「已确认/未确认」与顶栏角标对齐。
  if (!linkage.loaded) void linkage.load()
  unsubscribeProgress = window.events.onEventCenterDownloadProgress(
    (progress: EventDownloadProgress) => store.handleProgress(progress)
  )
  await reload()
})

onUnmounted(() => {
  unsubscribeProgress?.()
  unsubscribeProgress = undefined
})

// 与 `AlarmsView` 同一条取舍：改筛选就查，不额外要求点一次「查询」。
watch(
  () => ({ ...filters }),
  () => {
    void reload()
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

function openDetail(entry: EventCenterEntry): void {
  detail.value = entry
  playerRecordingId.value = defaultPlayerId(entry)
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

    <section class="card">
      <div class="filter-bar">
        <label class="field">
          <span class="field-label">{{ t('eventsUi.filterDevice') }}</span>
          <select v-model="filters.deviceId" class="select">
            <option value="">{{ t('eventsUi.filterAllDevices') }}</option>
            <option v-for="device in devices.devices" :key="device.id" :value="device.id">
              {{ device.name }}
            </option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">{{ t('eventsUi.filterSource') }}</span>
          <select v-model="filters.source" class="select">
            <option value="">{{ t('eventsUi.filterAllSources') }}</option>
            <option v-for="source in SOURCE_OPTIONS" :key="source" :value="source">
              {{ eventSourceLabel(source) }}
            </option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">{{ t('eventsUi.filterSeverity') }}</span>
          <select v-model="filters.severity" class="select">
            <option value="">{{ t('eventsUi.filterAllSeverities') }}</option>
            <option v-for="severity in SEVERITY_OPTIONS" :key="severity" :value="severity">
              {{ eventSeverityLabel(severity) }}
            </option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">{{ t('eventsUi.filterFrom') }}</span>
          <input v-model="filters.from" class="input" type="datetime-local" />
        </label>

        <label class="field">
          <span class="field-label">{{ t('eventsUi.filterTo') }}</span>
          <input v-model="filters.to" class="input" type="datetime-local" />
        </label>

        <label class="field">
          <span class="field-label">{{ t('eventsUi.filterAck') }}</span>
          <select v-model="filters.ack" class="select">
            <option value="all">{{ t('eventsUi.ackAll') }}</option>
            <option value="false">{{ t('eventsUi.ackUnacknowledged') }}</option>
            <option value="true">{{ t('eventsUi.ackAcknowledged') }}</option>
          </select>
        </label>

        <button type="button" class="btn" @click="reset">{{ t('common.reset') }}</button>
      </div>
    </section>

    <!--
      逐来源读况。相机离线时另外两路照样渲染，而这一块把「哪一路读不到、
      为什么」写在页面上——失败既不被吞掉，也不会让整页空白。
    -->
    <section class="card sources">
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

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('eventsUi.columnTime') }}</th>
            <th>{{ t('eventsUi.columnDevice') }}</th>
            <th>{{ t('eventsUi.columnSource') }}</th>
            <th>{{ t('eventsUi.columnKind') }}</th>
            <th>{{ t('eventsUi.columnSeverity') }}</th>
            <th>{{ t('eventsUi.columnStatus') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="rows.length === 0">
            <td colspan="6" class="table-empty">
              <EmptyState :title="emptyTitle" />
            </td>
          </tr>
          <tr
            v-for="entry in rows"
            :key="entry.id"
            class="is-clickable"
            :class="{ 'row--active': detail?.id === entry.id }"
            @click="openDetail(entry)"
          >
            <td class="nowrap">
              <span>{{ formatDateTime(entry.at) }}</span>
              <span v-if="entry.atApproximate" class="chip chip--tiny">
                {{ t('eventsUi.approximateBadge') }}
              </span>
            </td>
            <td class="nowrap">
              <button type="button" class="link-btn" @click.stop="openDevice(entry.deviceId)">
                {{ devices.nameById(entry.deviceId) }}
              </button>
            </td>
            <td class="nowrap">{{ eventSourceLabel(entry.source) }}</td>
            <td>{{ eventKindLabel(entry.kind) }}</td>
            <td>
              <span class="badge" :class="`badge--severity-${entry.severity}`">
                {{ eventSeverityLabel(entry.severity) }}
              </span>
            </td>
            <td>
              <span v-if="entry.source === 'deviceDetect'" class="muted">—</span>
              <span
                v-else
                class="badge"
                :class="entry.acknowledged ? 'badge--success' : 'badge--warning'"
              >
                {{
                  entry.acknowledged
                    ? t('eventsUi.ackAcknowledged')
                    : t('eventsUi.ackUnacknowledged')
                }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager">
      <span class="muted">{{ t('eventsUi.countSummary', { total: store.total }) }}</span>
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
              <dd class="kv__value">{{ devices.nameById(detail.deviceId) }}</dd>
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

.chip--tiny {
  font-size: 10.5px;
  padding: 1px 5px;
}

.badge--severity-unknown {
  background: rgba(107, 114, 128, 0.12);
  color: #4b5563;
}

.badge--severity-info {
  background: rgba(56, 189, 248, 0.14);
  color: #0369a1;
}

.badge--severity-warning {
  background: rgba(245, 158, 11, 0.16);
  color: #92400e;
}

.badge--severity-critical {
  background: rgba(239, 68, 68, 0.16);
  color: #991b1b;
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

.row--active {
  background: var(--color-accent-soft);
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
