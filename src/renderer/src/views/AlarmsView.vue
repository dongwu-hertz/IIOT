<script setup lang="ts">
/**
 * Alarm records (spec section 10.1).
 *
 * Hard rule from the spec: "Vue 页面禁止直接做 bit 判断". The raw `alarmMask` is
 * never inspected here — labels come from `describeAlarmMask()`, and per-row
 * chips come from the decoded `alarmTypes` array on the domain model.
 *
 * The detail drawer embeds the shared `RecordingPlayer`, which loads the alarm's
 * local recording through `window.api.playback.load(recordingId)`. An alarm only
 * stores metrics and the alarm type; the audio itself lives on the device until
 * the Recordings page syncs it, so an alarm without `localRecordingId` explains
 * that and links the operator to the sync action instead of showing a dead
 * player.
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { AlarmEvent, AlarmQuery } from '@shared/domain/models'
import { AlarmType, ALARM_NOTE_MAX_LENGTH, CHANNEL_COUNT } from '@shared/domain/models'
import type { EventSeverity } from '@shared/domain/event-center'
/**
 * Labels come from the RENDERER's `lib/labels`, not from
 * `@shared/domain/alarm-mask`: the shared module must stay environment-free (the
 * main process and plain-Node tests import it), so it returns stable keys and the
 * renderer translates them. It still owns the decoding, so the "no bit
 * arithmetic in the UI" rule from the spec is untouched.
 */
import { alarmTypeLabel, describeAlarmMask, eventSeverityLabel } from '@renderer/lib/labels'
import { channelState, channelStateLabelKey, type ChannelState } from '@renderer/lib/channelState'
import { ALARM_PAGE_SIZE, useAlarmsStore } from '@renderer/stores/alarms'
import { useSamplesStore } from '@renderer/stores/samples'
import { useDevicesStore } from '@renderer/stores/devices'
import {
  channelLabel,
  formatDateTime,
  formatNumber,
  fromDateTimeLocalValue
} from '@renderer/lib/format'
import RecordingPlayer from '@renderer/components/RecordingPlayer.vue'

const { t } = useI18n()
const router = useRouter()
const alarms = useAlarmsStore()
const devices = useDevicesStore()

const ALARM_TYPE_OPTIONS: AlarmType[] = Object.values(AlarmType).filter(
  (value): value is AlarmType => typeof value === 'number'
)

type AckFilter = 'all' | 'true' | 'false'

interface FilterState {
  deviceId: string
  channelId: string
  alarmType: string
  /** `''` = 全部等级。取值是 `EventSeverity`，不是任意字符串。 */
  severity: '' | EventSeverity
  from: string
  to: string
  ack: AckFilter
}

const filters = reactive<FilterState>({
  deviceId: '',
  channelId: '',
  alarmType: '',
  severity: '',
  from: '',
  to: '',
  ack: 'all'
})

/**
 * 等级选项。
 *
 * 顺序刻意是「严重 → 不严重 → 未知」而不是 `EVENT_SEVERITIES` 的定义顺序：这是**筛选器**，
 * 操作员找的是"最要紧的那些"，所以最严重的排第一。`unknown` 放在最后，因为它不是"最轻"，
 * 而是"我们没判"（理由见 `event-center.ts` 的等级说明）。
 */
const SEVERITY_FILTER_OPTIONS: readonly EventSeverity[] = ['critical', 'warning', 'info', 'unknown']

const selectedIds = ref<string[]>([])
const detail = ref<AlarmEvent | null>(null)
const bulkBusy = ref(false)
const notice = ref('')

/** 样本入库的独立状态：批量在顶部提示，单条在抽屉里提示（见 `addDetailToSamples()`）。 */
const samples = useSamplesStore()
const sampleBusy = ref(false)
const detailSampleNotice = ref('')

/**
 * 详情抽屉里的编辑态。
 *
 * 拆成两个独立的 busy 与独立的错误，而不是一个共用的 `editing`：备注与等级是两个
 * 动作，一个失败不该让另一个看起来也在转圈。
 */
const noteDraft = ref('')
const noteBusy = ref(false)
const severityBusy = ref(false)

/**
 * 「跳到本机录像」要回退多少毫秒。
 *
 * **归因要说准**：30 秒这个**数字**取自 iVMS-4200 手册 §15.11 —— 手册 p60–66 的「按标签下载」
 * 范围是**标签点前后各 30 秒**。但手册**没有**规定「从告警跳到回放要回退多少秒」，
 * 所以「告警回放也回退 30 秒」是**我们自己的选择**（借用同一个量级），不是手册的要求。
 *
 * 还有一件必须如实说明的事：本机的环形缓冲区**预录时长是可配置的**
 * （`ringBufferPreSeconds`，出厂默认 **10 秒**），所以「告警前 30 秒」经常拿不到——那时只能
 * 从录音开头播，并且由播放器把**实际拿到**的秒数说出来（`playerUi.leadShort`），而不是
 * 假装满足了 30 秒。
 */
const ALARM_JUMP_BACK_MS = 30_000

/** 当前详情在**当前筛选结果**里的位置；`-1` 表示它不在这批里（例如翻页后）。 */
const detailIndex = computed(() => {
  const current = detail.value
  if (!current) return -1
  return rows.value.findIndex((row) => row.id === current.id)
})

const canPrevEvent = computed(() => detailIndex.value > 0)
const canNextEvent = computed(
  () => detailIndex.value >= 0 && detailIndex.value < rows.value.length - 1
)

/**
 * 上/下一事件。
 *
 * 只在**当前这一页**里前后移动，到边界就禁用——刻度是诚实的：跨页跳需要再发一次查询
 * （还要处理"新一页的第一条/最后一条"），而按钮禁用比"点了没反应"更不含糊。位置由
 * `eventPosition` 说出来，所以操作员知道自己在哪。
 */
function stepEvent(delta: -1 | 1): void {
  const next = detailIndex.value + delta
  const target = rows.value[next]
  if (!target) return
  openDetail(target)
}

const rows = computed(() => alarms.items)
const page = computed(() => alarms.page)
const canPrev = computed(() => page.value.offset > 0)
const canNext = computed(() => page.value.offset + rows.value.length < alarms.total)

/** 历史筛选用的通道项：带上状态，未启用/未知都要在文字里标出来。 */
interface ChannelOption {
  index: number
  name: string
  state: ChannelState
}

const channelOptions = computed<ChannelOption[]>(() => {
  if (filters.deviceId) {
    const list = devices.channelsOf(filters.deviceId)
    if (list.length > 0) {
      return [...list]
        .sort((a, b) => a.channelIndex - b.channelIndex)
        .map((channel) => ({
          index: channel.channelIndex,
          name: channel.channelName,
          state: channelState(channel)
        }))
    }
  }
  // 设备没返回通道表：状态是“未知”，不能当作“已启用”。
  return Array.from({ length: CHANNEL_COUNT }, (_, index) => ({
    index,
    name: '',
    state: 'unknown'
  }))
})

function buildQuery(): Partial<AlarmQuery> {
  const query: Partial<AlarmQuery> = {
    deviceId: filters.deviceId || undefined,
    limit: ALARM_PAGE_SIZE,
    offset: 0
  }
  if (filters.channelId !== '') query.channelId = Number(filters.channelId)
  if (filters.alarmType !== '') query.alarmType = Number(filters.alarmType) as AlarmType
  if (filters.severity !== '') query.severity = filters.severity
  const from = fromDateTimeLocalValue(filters.from)
  if (from !== undefined) query.from = from
  const to = fromDateTimeLocalValue(filters.to)
  if (to !== undefined) query.to = to
  if (filters.ack !== 'all') query.acknowledged = filters.ack === 'true'
  return query
}

async function reload(): Promise<void> {
  selectedIds.value = []
  await alarms.applyQuery(buildQuery())
}

function reset(): void {
  filters.deviceId = ''
  filters.channelId = ''
  filters.alarmType = ''
  filters.severity = ''
  filters.from = ''
  filters.to = ''
  filters.ack = 'all'
  void reload()
}

onMounted(async () => {
  if (devices.devices.length === 0) await devices.load()
  await reload()
})

// Auto-apply on any filter change: an explicit "查询" click on top of a filter
// bar that already changed is a papercut on a monitoring console.
watch(
  () => ({ ...filters }),
  () => {
    void reload()
  }
)

// Channel list depends on the selected device, so load it lazily.
watch(
  () => filters.deviceId,
  (deviceId) => {
    if (deviceId) void devices.loadChannels(deviceId)
    filters.channelId = ''
  }
)

function toggleRow(id: string, checked: boolean): void {
  if (checked) {
    if (!selectedIds.value.includes(id)) selectedIds.value = [...selectedIds.value, id]
  } else {
    selectedIds.value = selectedIds.value.filter((item) => item !== id)
  }
}

const allSelected = computed(
  () => rows.value.length > 0 && selectedIds.value.length === rows.value.length
)

function toggleAll(checked: boolean): void {
  selectedIds.value = checked ? rows.value.map((row) => row.id) : []
}

async function bulkAcknowledge(value: boolean): Promise<void> {
  if (selectedIds.value.length === 0) return
  bulkBusy.value = true
  const affected = await alarms.acknowledge(selectedIds.value, value)
  bulkBusy.value = false
  notice.value =
    affected > 0
      ? t(value ? 'alarmsUi.notifyAcknowledged' : 'alarmsUi.notifyUnacknowledged', {
          count: affected
        })
      : alarms.error
  selectedIds.value = []
}

/**
 * 把选中的告警加入**本地样本库**（业主 2026-09-16）。
 *
 * 告警是样本库里**唯一自带特征值**的来源（`spl`/`main_frequency`/`smoothness`/
 * `band_energy_ratio` 四维，设备在告警时刻报的），所以这条路的产出比手动录音实在得多。
 *
 * 汇总文案必须把三件事分开说（新增 / 已在库 / 失败）："已在库"是**幂等命中**，
 * 报成失败会让操作员去查一个不存在的问题；而"带特征的条数"要与"条数"分开报 ——
 * 设备可能只报了其中几维。
 */
async function addSelectedToSamples(): Promise<void> {
  if (selectedIds.value.length === 0) return
  bulkBusy.value = true
  const outcome = await samples.addFromAlarms([...selectedIds.value])
  bulkBusy.value = false
  if (!outcome) {
    notice.value = samples.error
    return
  }
  selectedIds.value = []
  notice.value =
    outcome.failed > 0
      ? t('alarmsUi.sampleAddPartial', {
          created: outcome.created,
          existing: outcome.existing,
          failed: outcome.failed
        })
      : t('alarmsUi.sampleAddDone', {
          created: outcome.created,
          existing: outcome.existing,
          withMetrics: outcome.withMetrics
        })
}

/**
 * 详情抽屉里的**单条**入库，并且把结果留在抽屉里。
 *
 * 与批量那条路分开结果状态（`detailSampleNotice`）：抽屉开着的时候，顶部那条提示
 * 常常被抽屉盖住，操作员点了按钮却看不到任何反馈。
 */
async function addDetailToSamples(): Promise<void> {
  const current = detail.value
  if (!current) return
  sampleBusy.value = true
  const outcome = await samples.addFromAlarm(current.id)
  sampleBusy.value = false
  if (!outcome) {
    detailSampleNotice.value = samples.error
    return
  }
  detailSampleNotice.value = outcome.created
    ? outcome.metricsStored > 0
      ? t('alarmsUi.sampleAddedWithMetrics', {
          count: outcome.metricsStored,
          label: outcome.label ?? t('samplesUi.unlabelled')
        })
      : t('alarmsUi.sampleAddedNoMetrics')
    : t('alarmsUi.sampleAlreadyIn')
}

async function toggleDetailAck(): Promise<void> {
  const current = detail.value
  if (!current) return
  const next = !current.acknowledged
  const affected = await alarms.acknowledge([current.id], next)
  if (affected > 0) {
    detail.value = { ...current, acknowledged: next }
    notice.value = next
      ? t('alarmsUi.notifyDetailAcknowledged')
      : t('alarmsUi.notifyDetailUnacknowledged')
  } else {
    notice.value = alarms.error
  }
}

function openDetail(alarm: AlarmEvent): void {
  detail.value = alarm
  // 抽屉打开时把备注装进草稿。`note` 缺失与空字符串都变成空草稿——输入框里没有区别，
  // 但"保存"时的语义有区别（见 saveNote()）。
  noteDraft.value = alarm.note ?? ''
  // 上一条的入库回执不能跟着换到这一条上：那是"另一条告警已入库"。
  detailSampleNotice.value = ''
}

function closeDetail(): void {
  detail.value = null
  noteDraft.value = ''
  detailSampleNotice.value = ''
}

/**
 * 保存备注。
 *
 * 传 `null` 而不是空字符串来"清除"：`''` 是一个写进去的值（"我写了空白"），`null` 是
 * "这条告警没有备注"。两者在界面上的表现一样，在库里是两件事，所以判据是**草稿去空白
 * 后是否为空**，清除时显式传 `null`。
 */
async function saveNote(clear = false): Promise<void> {
  const current = detail.value
  if (!current) return
  const trimmed = noteDraft.value.trim()
  if (!clear && trimmed.length > ALARM_NOTE_MAX_LENGTH) {
    notice.value = t('alarmsUi.noteTooLong', {
      max: ALARM_NOTE_MAX_LENGTH,
      length: trimmed.length
    })
    return
  }
  const cleared = clear || trimmed === ''
  const value = cleared ? null : trimmed
  noteBusy.value = true
  const outcome = await alarms.setNote(current.id, value)
  noteBusy.value = false
  if (!outcome.ok) {
    notice.value = outcome.message
    return
  }
  if (!outcome.saved) {
    // 行已经不在库里（被保留策略清掉了）。这不是失败，但必须说出来。
    notice.value = t('alarmsUi.recordMissing')
    return
  }
  const next: AlarmEvent = { ...current }
  if (value === null) delete next.note
  else next.note = value
  detail.value = next
  noteDraft.value = cleared ? '' : trimmed
  notice.value = cleared ? t('alarmsUi.noteCleared') : t('alarmsUi.noteSaved')
}

/** 人工改判等级（写入这条记录的快照，理由见 `alarm-repository.ts` 的 `setSeverity()`）。 */
async function changeSeverity(next: EventSeverity): Promise<void> {
  const current = detail.value
  if (!current || next === current.severity) return
  severityBusy.value = true
  const outcome = await alarms.setSeverity(current.id, next)
  severityBusy.value = false
  if (!outcome.ok) {
    notice.value = outcome.message
    return
  }
  if (!outcome.saved) {
    notice.value = t('alarmsUi.recordMissing')
    return
  }
  detail.value = { ...current, severity: next }
  notice.value = t('alarmsUi.severitySaved', { level: eventSeverityLabel(next) })
}

async function goToPage(offset: number): Promise<void> {
  selectedIds.value = []
  await alarms.goToPage(offset)
}

function openDevice(deviceId: string): void {
  void router.push(`/devices/${deviceId}`)
}
</script>

<template>
  <div class="page">
    <!--
      没有页面标题（产品要求：外层框架已经写了「告警记录」）。留下的是**副标题**（共 N 条 /
      已选 M 条）与批量按钮：那不是标题，是这一屏自己的状态与动作。
    -->
    <div class="page-header">
      <p class="page-subtitle">
        {{ t('alarmsUi.countSummary', { total: alarms.total, selected: selectedIds.length }) }}
      </p>
      <div class="btn-row">
        <button
          type="button"
          class="btn btn--sm"
          :disabled="bulkBusy || selectedIds.length === 0"
          @click="bulkAcknowledge(true)"
        >
          {{ t('alarmsUi.bulkAcknowledge') }}
        </button>
        <button
          type="button"
          class="btn btn--sm"
          :disabled="bulkBusy || selectedIds.length === 0"
          @click="bulkAcknowledge(false)"
        >
          {{ t('alarmsUi.bulkUnacknowledge') }}
        </button>
        <!--
          「加入样本库」放在这里而不是只在抽屉里：一次巡检往往要挑十几条典型告警，
          逐条开抽屉太慢（业主 2026-09-16 的样本库需求）。
        -->
        <button
          type="button"
          class="btn btn--sm"
          :disabled="bulkBusy || selectedIds.length === 0"
          @click="addSelectedToSamples"
        >
          {{ t('alarmsUi.addSelectedToSamples') }}
        </button>
        <button type="button" class="btn btn--sm" :disabled="alarms.loading" @click="reload">
          {{ alarms.loading ? t('common.loading') : t('common.refresh') }}
        </button>
      </div>
    </div>

    <p v-if="alarms.error" class="alert alert--danger" role="alert">{{ alarms.error }}</p>
    <p v-else-if="notice" class="alert alert--success" role="status">{{ notice }}</p>

    <section class="card">
      <div class="filter-bar">
        <label class="field">
          <span class="field-label">{{ t('alarmsUi.filterDevice') }}</span>
          <select v-model="filters.deviceId" class="select">
            <option value="">{{ t('alarmsUi.filterAllDevices') }}</option>
            <option v-for="device in devices.devices" :key="device.id" :value="device.id">
              {{ device.name }}
            </option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">{{ t('alarmsUi.filterChannel') }}</span>
          <select v-model="filters.channelId" class="select">
            <option value="">{{ t('alarmsUi.filterAllChannels') }}</option>
            <option v-for="channel in channelOptions" :key="channel.index" :value="channel.index">
              {{ channelLabel(channel.index) }}<template v-if="channel.name">（{{ channel.name }}）</template>
              <!-- 未启用的通道照样可以查历史（过去的数据仍在），但必须看得出来它现在没开。 -->
              <template v-if="channel.state !== 'enabled'">（{{ t(channelStateLabelKey(channel.state)) }}）</template>
            </option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">{{ t('alarmsUi.filterType') }}</span>
          <select v-model="filters.alarmType" class="select">
            <option value="">{{ t('alarmsUi.filterAllTypes') }}</option>
            <option v-for="type in ALARM_TYPE_OPTIONS" :key="type" :value="type">
              {{ alarmTypeLabel(type) }}
            </option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">{{ t('alarmsUi.filterSeverity') }}</span>
          <select v-model="filters.severity" class="select">
            <option value="">{{ t('alarmsUi.filterAllSeverities') }}</option>
            <option v-for="level in SEVERITY_FILTER_OPTIONS" :key="level" :value="level">
              {{ eventSeverityLabel(level) }}
            </option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">{{ t('alarmsUi.filterFrom') }}</span>
          <input v-model="filters.from" class="input" type="datetime-local" />
        </label>

        <label class="field">
          <span class="field-label">{{ t('alarmsUi.filterTo') }}</span>
          <input v-model="filters.to" class="input" type="datetime-local" />
        </label>

        <label class="field">
          <span class="field-label">{{ t('alarmsUi.filterAck') }}</span>
          <select v-model="filters.ack" class="select">
            <option value="all">{{ t('alarmsUi.ackAll') }}</option>
            <option value="false">{{ t('alarmsUi.ackUnacknowledged') }}</option>
            <option value="true">{{ t('alarmsUi.ackAcknowledged') }}</option>
          </select>
        </label>

        <button type="button" class="btn" @click="reset">{{ t('common.reset') }}</button>
      </div>
    </section>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="col-check">
              <input
                type="checkbox"
                :checked="allSelected"
                :aria-label="t('alarmsUi.selectAll')"
                @change="toggleAll(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ t('alarmsUi.columnTime') }}</th>
            <th>{{ t('alarmsUi.columnDevice') }}</th>
            <th>{{ t('alarmsUi.columnChannel') }}</th>
            <th>{{ t('alarmsUi.columnType') }}</th>
            <th>{{ t('alarmsUi.columnSeverity') }}</th>
            <th>{{ t('alarmsUi.columnStatus') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="rows.length === 0">
            <td colspan="7" class="table-empty">
              {{ alarms.loading ? t('alarmsUi.loading') : t('alarmsUi.empty') }}
            </td>
          </tr>
          <tr
            v-for="alarm in rows"
            :key="alarm.id"
            class="is-clickable"
            :class="{ 'row--active': detail?.id === alarm.id }"
            @click="openDetail(alarm)"
          >
            <td class="col-check" @click.stop>
              <input
                type="checkbox"
                :checked="selectedIds.includes(alarm.id)"
                :aria-label="t('alarmsUi.selectRow', { id: alarm.id })"
                @change="toggleRow(alarm.id, ($event.target as HTMLInputElement).checked)"
              />
            </td>
            <td class="nowrap">{{ formatDateTime(alarm.timestamp) }}</td>
            <td class="nowrap">
              <button type="button" class="link-btn" @click.stop="openDevice(alarm.deviceId)">
                {{ devices.nameById(alarm.deviceId) }}
              </button>
            </td>
            <td class="nowrap">{{ channelLabel(alarm.channelId) }}</td>
            <td>
              <!-- Decoded label only; the mask itself is never inspected here. -->
              <span class="alarm-type">{{ describeAlarmMask(alarm.alarmMask) }}</span>
              <span v-if="alarm.alarmTypes.length > 1" class="chip-row alarm-chips">
                <span v-for="type in alarm.alarmTypes" :key="type" class="chip">
                  {{ alarmTypeLabel(type) }}
                </span>
              </span>
            </td>
            <td>
              <span class="badge" :class="`badge--severity-${alarm.severity}`">
                {{ eventSeverityLabel(alarm.severity) }}
              </span>
            </td>
            <td>
              <span class="badge" :class="alarm.acknowledged ? 'badge--success' : 'badge--warning'">
                {{ alarm.acknowledged ? t('alarmsUi.ackAcknowledged') : t('alarmsUi.ackUnacknowledged') }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager">
      <span class="muted">
        {{
          t('alarmsUi.pagerRange', {
            from: page.offset + 1,
            to: page.offset + rows.length,
            total: alarms.total
          })
        }}
      </span>
      <div class="btn-row">
        <button type="button" class="btn btn--sm" :disabled="!canPrev" @click="goToPage(page.offset - ALARM_PAGE_SIZE)">
          {{ t('alarmsUi.prevPage') }}
        </button>
        <button type="button" class="btn btn--sm" :disabled="!canNext" @click="goToPage(page.offset + ALARM_PAGE_SIZE)">
          {{ t('alarmsUi.nextPage') }}
        </button>
      </div>
    </div>

    <!-- Detail drawer -->
    <div v-if="detail" class="drawer-overlay" @click.self="closeDetail">
      <aside class="drawer" role="dialog" aria-modal="true" :aria-label="t('alarmsUi.detailTitle')">
        <header class="drawer__header">
          <div>
            <h3 class="section-title">{{ t('alarmsUi.detailTitle') }}</h3>
            <p class="muted drawer__sub">{{ formatDateTime(detail.timestamp) }}</p>
          </div>
          <div class="btn-row">
            <!--
              上/下一事件。位置用 `eventPosition` 说出来，而不是只给两个箭头：操作员要
              知道自己在这一批的第几条，否则"下一步"是按什么顺序走的是个谜。
            -->
            <button
              type="button"
              class="btn btn--sm"
              :disabled="!canPrevEvent"
              @click="stepEvent(-1)"
            >
              {{ t('alarmsUi.prevEvent') }}
            </button>
            <button
              type="button"
              class="btn btn--sm"
              :disabled="!canNextEvent"
              @click="stepEvent(1)"
            >
              {{ t('alarmsUi.nextEvent') }}
            </button>
            <button
              type="button"
              class="btn btn--ghost btn--icon"
              :aria-label="t('common.close')"
              @click="closeDetail"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        </header>

        <div class="drawer__body">
          <dl class="kv drawer__kv">
            <div class="kv__item">
              <dt class="kv__label">{{ t('alarmsUi.filterDevice') }}</dt>
              <dd class="kv__value">{{ devices.nameById(detail.deviceId) }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('alarmsUi.filterChannel') }}</dt>
              <dd class="kv__value">{{ channelLabel(detail.channelId) }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('alarmsUi.filterType') }}</dt>
              <dd class="kv__value">{{ describeAlarmMask(detail.alarmMask) }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('alarmsUi.filterAck') }}</dt>
              <dd class="kv__value">
                <span class="badge" :class="detail.acknowledged ? 'badge--success' : 'badge--warning'">
                  {{ detail.acknowledged ? t('alarmsUi.ackAcknowledged') : t('alarmsUi.ackUnacknowledged') }}
                </span>
              </dd>
            </div>
          </dl>

          <section class="drawer__section">
            <h4 class="drawer__section-title">{{ t('alarmsUi.metricsTitle') }}</h4>
            <dl class="kv">
              <div class="kv__item">
                <dt class="kv__label">{{ t('metrics.spl') }}</dt>
                <dd class="kv__value">{{ formatNumber(detail.spl, 2) }} dB</dd>
              </div>
              <div class="kv__item">
                <dt class="kv__label">{{ t('metrics.mainFrequency') }}</dt>
                <dd class="kv__value">{{ formatNumber(detail.mainFrequency, 2) }} Hz</dd>
              </div>
              <div class="kv__item">
                <dt class="kv__label">{{ t('metrics.smoothness') }}</dt>
                <dd class="kv__value">{{ formatNumber(detail.smoothness, 3) }}</dd>
              </div>
              <div class="kv__item">
                <dt class="kv__label">{{ t('metrics.bandEnergyRatio') }}</dt>
                <dd class="kv__value">{{ formatNumber(detail.bandEnergyRatio, 3) }}</dd>
              </div>
            </dl>
          </section>

          <section class="drawer__section">
            <h4 class="drawer__section-title">{{ t('alarmsUi.playbackTitle') }}</h4>
            <p v-if="detailIndex >= 0" class="muted">
              {{ t('alarmsUi.eventPosition', { index: detailIndex + 1, total: rows.length }) }}
            </p>
            <!--
              The player loads the clip on demand (playback.load), which is what
              downloads it from the device when it is not local yet. With no
              localRecordingId there is nothing to download yet, so the player
              explains that and the slot below sends the operator to the page
              that syncs the device's recording library.

              `anchorAtMs` is the alarm moment: the panel seeks to
              `alarm - 30 s` once the clip is loaded. 30 s is the manual's number
              (see ALARM_JUMP_BACK_MS); whether it can be honoured depends on the
              configured Ring Buffer pre-roll, so the player reports the lead it
              actually got instead of pretending.
            -->
            <RecordingPlayer
              :recording-id="detail.localRecordingId"
              :anchor-at-ms="detail.timestamp"
              :anchor-lead-ms="ALARM_JUMP_BACK_MS"
            >
              <template #action>
                <RouterLink class="btn btn--primary btn--sm" to="/recordings">
                  {{ t('alarmsUi.goSyncRecordings') }}
                </RouterLink>
              </template>
            </RecordingPlayer>
          </section>

          <section class="drawer__section">
            <h4 class="drawer__section-title">{{ t('alarmsUi.severitySectionTitle') }}</h4>
            <!--
              等级是**我们自己的划分**（iVMS 手册全书无此概念，设备侧也不给），所以它
              是一个可以人工改判的字段，而不是从设备读来的事实。理由见
              `shared/domain/alarm-mask.ts` 的 `ALARM_SEVERITY_BY_TYPE`。
            -->
            <select
              class="select"
              :value="detail.severity"
              :disabled="severityBusy"
              @change="changeSeverity(($event.target as HTMLSelectElement).value as EventSeverity)"
            >
              <option v-for="level in SEVERITY_FILTER_OPTIONS" :key="level" :value="level">
                {{ eventSeverityLabel(level) }}
              </option>
            </select>
          </section>

          <section class="drawer__section">
            <h4 class="drawer__section-title">{{ t('alarmsUi.noteSectionTitle') }}</h4>
            <p v-if="!detail.note && noteDraft === ''" class="muted">{{ t('alarmsUi.noteEmpty') }}</p>
            <textarea
              v-model="noteDraft"
              class="input note-box"
              rows="3"
              :maxlength="ALARM_NOTE_MAX_LENGTH"
              :placeholder="t('alarmsUi.notePlaceholder')"
            ></textarea>
            <div class="btn-row">
              <button type="button" class="btn btn--sm" :disabled="noteBusy" @click="saveNote(false)">
                {{ t('alarmsUi.noteSave') }}
              </button>
              <button type="button" class="btn btn--sm" :disabled="noteBusy" @click="saveNote(true)">
                {{ t('alarmsUi.noteClear') }}
              </button>
            </div>
          </section>

          <section class="drawer__section">
            <h4 class="drawer__section-title">{{ t('alarmsUi.sampleSectionTitle') }}</h4>
            <p class="muted drawer__sub">{{ t('alarmsUi.sampleSectionHint') }}</p>
            <div class="btn-row">
              <button
                type="button"
                class="btn btn--sm"
                :disabled="sampleBusy"
                @click="addDetailToSamples"
              >
                {{ sampleBusy ? t('common.loading') : t('alarmsUi.addToSamples') }}
              </button>
              <RouterLink class="btn btn--sm" to="/samples">{{ t('alarmsUi.goSamples') }}</RouterLink>
            </div>
            <p v-if="detailSampleNotice" class="drawer__notice" role="status">
              {{ detailSampleNotice }}
            </p>
          </section>

          <section class="drawer__section">
            <h4 class="drawer__section-title">{{ t('alarmsUi.ackSectionTitle') }}</h4>
            <button type="button" class="btn" @click="toggleDetailAck">
              {{ detail.acknowledged ? t('alarmsUi.bulkUnacknowledge') : t('alarmsUi.markAcknowledged') }}
            </button>
          </section>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/*
 * 等级配色。四档都要有，`unknown` 也**必须**有自己的样子：它不是"最轻的一档"，
 * 而是"我们没判"（设备不给等级，见 `ALARM_SEVERITY_BY_TYPE`），所以用中性灰而不是
 * 绿色——把它画成"正常"会让操作员以为这条已经被判定为无碍。
 */
.badge--severity-critical {
  background: color-mix(in srgb, var(--color-danger, #d64545) 22%, transparent);
  color: var(--color-danger, #d64545);
}

.badge--severity-warning {
  background: color-mix(in srgb, var(--color-warning, #d99a2b) 22%, transparent);
  color: var(--color-warning, #d99a2b);
}

.badge--severity-info {
  background: color-mix(in srgb, var(--color-accent, #4a8fd6) 18%, transparent);
  color: var(--color-accent, #4a8fd6);
}

.badge--severity-unknown {
  background: color-mix(in srgb, currentColor 12%, transparent);
  opacity: 0.75;
}

.note-box {
  width: 100%;
  resize: vertical;
  font: inherit;
  line-height: 1.5;
}

.col-check {
  width: 34px;
  text-align: center;
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

.alarm-type {
  display: block;
}

.alarm-chips {
  margin-top: 3px;
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

.drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  background: rgba(23, 23, 23, 0.24);
  display: flex;
  justify-content: flex-end;
}

.drawer {
  width: 440px;
  max-width: 92vw;
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

/* 入库回执：留在抽屉里（顶部那条提示会被抽屉盖住）。 */
.drawer__notice {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--color-success);
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
