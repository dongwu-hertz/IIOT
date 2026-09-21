<script setup lang="ts">
/**
 * Alarm records (spec section 10.1) — 界面上的名字是「告警中心」
 * （业主 2026-09-19：「告警记录修改为 告警中心」）。
 *
 * Hard rule from the spec: "Vue 页面禁止直接做 bit 判断". The raw `alarmMask` is
 * never inspected here — labels come from `describeAlarmMask()`, and per-row
 * chips come from the decoded `alarmTypes` array on the domain model.
 *
 * 筛选分两档（业主 2026-09-19 同一条）：
 *   · **简单筛选**一直显示（设备 / 等级 / 确认状态）—— 值守时最常用的三个；
 *   · **更多筛选**默认收起（时间起止 / 通道 / 告警类型）—— 偶尔才用一次。
 *   收起的那些**仍然在起作用**，所以按钮上带着生效项数（否则列表变短没人解释得了）。
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
import { useRoute, useRouter } from 'vue-router'
import type { AlarmEvent, AlarmQuery } from '@shared/domain/models'
import { ALARM_NOTE_MAX_LENGTH } from '@shared/domain/models'
import type { EventSeverity } from '@shared/domain/event-center'
/**
 * Labels come from the RENDERER's `lib/labels`, not from
 * `@shared/domain/alarm-mask`: the shared module must stay environment-free (the
 * main process and plain-Node tests import it), so it returns stable keys and the
 * renderer translates them. It still owns the decoding, so the "no bit
 * arithmetic in the UI" rule from the spec is untouched.
 */
import { alarmTypeLabel, describeAlarmMask, eventSeverityLabel } from '@renderer/lib/labels'
import { ALARM_PAGE_SIZE, useAlarmsStore } from '@renderer/stores/alarms'
import { useSamplesStore } from '@renderer/stores/samples'
import { useDevicesStore } from '@renderer/stores/devices'
import { useUiRefreshStore } from '@renderer/stores/uiRefresh'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { channelLabel, formatDateTime, formatNumber, fromDateTimeLocalValue } from '@renderer/lib/format'
import RecordingPlayer from '@renderer/components/RecordingPlayer.vue'
import DateRangePicker from '@renderer/components/DateRangePicker.vue'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const alarms = useAlarmsStore()
const uiRefresh = useUiRefreshStore()
const devices = useDevicesStore()

/**
 * 筛选（业主重构 2026：只留「标题 + 内容 + 时间范围」，同一行；更多筛选整个删掉）。
 *   · 标题 = 设备名关键字（哪台设备的）；
 *   · 内容 = 备注 / 设备告警原因文本关键字（记录里写了什么的）；
 *   · 时间范围 = 一个日历（DateRangePicker，开始与结束在同一个日历里选）。
 * `deviceId` 不在界面上 —— 它是「设备详情 → 查看告警记录」带进来的隐藏条件。
 */
interface FilterState {
  title: string
  content: string
  from: string
  to: string
  deviceId: string
}

const filters = reactive<FilterState>({
  title: '',
  content: '',
  from: '',
  to: '',
  deviceId: ''
})

/**
 * 等级选项（详情抽屉里人工改判用）。
 *
 * 顺序刻意是「严重 → 不严重 → 未知」：操作员找的是"最要紧的那些"，所以最严重的排第一。
 * `unknown` 放在最后，因为它不是"最轻"，而是"我们没判"。
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

/**
 * 把界面上的筛选变成一次查询。
 *
 * ⚠ **每一格都必须显式给出**（清空时给 `undefined`），不能"有值才带上"。
 *
 * 原因在 store 那边：`alarms.applyQuery(patch)` 做的是
 * `query.value = { ...query.value, ...patch, offset: 0 }` —— 一个**合并补丁**。
 * 于是"把某一格清空"这件事在补丁里表现为**那个键根本不在**，合并之后**上一次的值原样留着**。
 *
 * 这个缺陷是 2026-09-19 第 15 轮的 GUI 探针抓到的（把「开始时间」设成 2099 年 → 0 条，
 * 再清空 → **仍然是 0 条**）。这里每一格都照此办理，新增的 `title`/`content` 也一样。
 */
function buildQuery(): Partial<AlarmQuery> {
  return {
    title: filters.title.trim() || undefined,
    content: filters.content.trim() || undefined,
    from: fromDateTimeLocalValue(filters.from),
    to: fromDateTimeLocalValue(filters.to),
    deviceId: filters.deviceId || undefined,
    limit: ALARM_PAGE_SIZE,
    offset: 0
  }
}

/** 日历范围选择器（一个日历）选完：两个格一起进筛选状态，由 watcher 自动查询。 */
function applyDateRange(value: { from: string; to: string }): void {
  filters.from = value.from
  filters.to = value.to
}

async function reload(): Promise<void> {
  selectedIds.value = []
  await alarms.applyQuery(buildQuery())
}

function reset(): void {
  filters.title = ''
  filters.content = ''
  filters.from = ''
  filters.to = ''
  filters.deviceId = ''
  void reload()
}


/**
 * 顶栏那颗唯一的刷新（业主 2026-09-19 更正第 4 条）：这一页自己那颗「刷新」已经删掉，
 * 重读数据由它触发 —— 调用的还是原来那个函数。
 */
watch(
  () => uiRefresh.tick,
  () => {
    void reload()
  }
)

onMounted(async () => {
  if (devices.devices.length === 0) await devices.load()
  /*
   * 地址栏里的 `?device=<id>` 预置设备筛选（业主 2026-09-18 第 10 批第 24 条）。
   *
   * 为什么要有它：相机页上那条「查看告警记录」原来指向**不带任何筛选**的 /alarms ——
   * 点过去看到的是全库的告警，"这一台的记录"要靠操作员自己在下拉里再选一次。
   * 一个从"这一台相机"出发的入口，落到一个不筛这一台的列表上，是界面在答非所问。
   *
   * 预设**排在 reload 之前**：读一次库就够了（筛选变化会再触发一次，是同一份数据）。
   * 只在 id 真的存在于设备列表里时才用 —— 一个过期的书签不该把列表筛成空的。
   */
  const fromQuery = typeof route.query.device === 'string' ? route.query.device : ''
  if (fromQuery !== '' && devices.devices.some((device) => device.id === fromQuery)) {
    filters.deviceId = fromQuery
  }
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

/** 右键「回放」：打开详情并让播放器自动加载（普通点击打开则不自动播）。 */
const replayAutoload = ref(false)

function replayAlarm(alarm: AlarmEvent): void {
  replayAutoload.value = true
  openDetail(alarm)
  closeRowMenu()
}

function openDetail(alarm: AlarmEvent): void {
  detail.value = alarm
  // 抽屉打开时把备注装进草稿。`note` 缺失与空字符串都变成空草稿——输入框里没有区别，
  // 但"保存"时的语义有区别（见 saveNote()）。
  noteDraft.value = alarm.note ?? ''
  // 上一条的入库回执不能跟着换到这一条上：那是"另一条告警已入库"。
  detailSampleNotice.value = ''
  // 回放证据随抽屉打开：抓图（听诊盒子族）与视频（MP4 容器）各取各的，拿不到就如实说。
  void loadSnapshots(alarm)
  void loadVideo(alarm)
}

function closeDetail(): void {
  detail.value = null
  noteDraft.value = ''
  detailSampleNotice.value = ''
  replayAutoload.value = false
  snapshots.value = null
  if (videoUrl.value) videoUrl.value = ''
  videoError.value = ''
  if (window.api.e2?.closeSnapshots) void window.api.e2.closeSnapshots()
}

// ---------------------------------------------------------------------------
// 回放证据：抓图（听诊盒子族，SN-16 每次告警 3 张球机抓图）与视频（MP4 容器）
// ---------------------------------------------------------------------------

/** 当前告警的抓图；`null` = 不适用（非听诊盒子族）或尚未加载。 */
const snapshots = ref<{ state: string; files: { name: string; url: string }[] } | null>(null)

async function loadSnapshots(alarm: AlarmEvent): Promise<void> {
  snapshots.value = null
  const device = devices.byId(alarm.deviceId)
  if (!device || device.kind !== 'auscultationBox') return
  if (!window.api.e2?.alarmSnapshots) return
  const result = await callApi(() => window.api.e2.alarmSnapshots(alarm.deviceId, alarm.id))
  if (result.success) snapshots.value = unwrap(result) ?? null
}

const videoUrl = ref('')
const videoError = ref('')

/** MP4 容器走回环 HTTP（支持 Range），WAV 仍由 RecordingPlayer 处理。 */
async function loadVideo(alarm: AlarmEvent): Promise<void> {
  videoUrl.value = ''
  videoError.value = ''
  if (alarm.localRecordingContainer !== 'mp4' || !alarm.localRecordingId) return
  const result = await callApi(() => window.api.cameraNvr.videoUrl(alarm.localRecordingId as string))
  if (!result.success) {
    videoError.value = resultMessage(result)
    return
  }
  videoUrl.value = unwrap(result)?.url ?? ''
}

// ---------------------------------------------------------------------------
// 行右键菜单（业主：每条记录支持 查看细节 / 回放 / 下载告警 / 加入样本）
// ---------------------------------------------------------------------------

interface RowMenuState {
  x: number
  y: number
  alarm: AlarmEvent
}

const rowMenu = ref<RowMenuState | null>(null)
const menuBusy = ref(false)

function openRowMenu(event: MouseEvent, alarm: AlarmEvent): void {
  event.preventDefault()
  rowMenu.value = { x: event.clientX, y: event.clientY, alarm }
}

function closeRowMenu(): void {
  rowMenu.value = null
}

/** 下载告警录音（另存为到操作员选的位置）。无本机录音的条目在菜单里已禁用。 */
async function downloadAlarm(alarm: AlarmEvent): Promise<void> {
  if (!alarm.localRecordingId || menuBusy.value) return
  menuBusy.value = true
  const result = await callApi(() => window.api.recordings.export(alarm.localRecordingId as string))
  menuBusy.value = false
  closeRowMenu()
  if (!result.success) {
    notice.value = resultMessage(result)
    return
  }
  const saved = unwrap(result)
  if (saved) notice.value = t('alarmsUi.downloadDone', { path: saved.path })
}

/** 右键 → 加入样本（与抽屉单条入库同一条路，三种结果分开说）。 */
async function addAlarmToSamples(alarm: AlarmEvent): Promise<void> {
  if (menuBusy.value) return
  menuBusy.value = true
  const outcome = await samples.addFromAlarm(alarm.id)
  menuBusy.value = false
  closeRowMenu()
  if (!outcome) {
    notice.value = samples.error
    return
  }
  notice.value = outcome.created
    ? outcome.metricsStored > 0
      ? t('alarmsUi.sampleAddedWithMetrics', {
          count: outcome.metricsStored,
          label: outcome.label ?? t('samplesUi.unlabelled')
        })
      : t('alarmsUi.sampleAddedNoMetrics')
    : t('alarmsUi.sampleAlreadyIn')
}

/** 右键 → 确认 / 取消确认。 */
async function toggleAckFromMenu(alarm: AlarmEvent): Promise<void> {
  closeRowMenu()
  const next = !alarm.acknowledged
  const affected = await alarms.acknowledge([alarm.id], next)
  notice.value =
    affected > 0
      ? t(next ? 'alarmsUi.notifyDetailAcknowledged' : 'alarmsUi.notifyDetailUnacknowledged')
      : alarms.error
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
      筛选卡在**最上面**（业主 2026-09-19 第 2 条：筛选的卡片放在最上面的）。
      它原来在「共 N 条 / 已选 M 条 + 批量动作」那一行**下面**，所以进页面第一眼看到的是
      计数与按钮，而不是"我在看哪一批"。现在顺序是：先选范围，再看结果与动作。
    -->
    <section class="card" data-alarm-filters>
      <!--
        业主重构：筛选只留「标题 + 内容 + 时间范围」，同一行；更多筛选整个删掉。
        标题 = 设备名关键字；内容 = 备注/设备原因关键字；时间 = 一个日历（DateRangePicker）。
      -->
      <div class="filter-bar alarm-filter-row" data-alarm-simple-filters>
        <label class="field alarm-filter-row__title">
          <span class="field-label">{{ t('alarmsUi.filterTitle') }}</span>
          <input
            v-model="filters.title"
            class="input"
            type="search"
            data-filter-title
            :placeholder="t('alarmsUi.filterTitleHint')"
          />
        </label>

        <label class="field alarm-filter-row__content">
          <span class="field-label">{{ t('alarmsUi.filterContent') }}</span>
          <input
            v-model="filters.content"
            class="input"
            type="search"
            data-filter-content
            :placeholder="t('alarmsUi.filterContentHint')"
          />
        </label>

        <label class="field alarm-filter-row__range">
          <span class="field-label">{{ t('alarmsUi.filterTimeRange') }}</span>
          <DateRangePicker :from="filters.from" :to="filters.to" @apply="applyDateRange" />
        </label>

        <button
          type="button"
          class="btn filter-reset"
          data-action="reset-alarm-filters"
          @click="reset"
        >
          {{ t('common.reset') }}
        </button>
      </div>
    </section>

    <!--
      计数与批量动作。放在筛选卡**下面**：它描述的是"这一批结果"，而范围在上面已经选好了。
      没有页面标题（产品要求：外层框架已经写了「告警中心」），留下的是**副标题**
      （共 N 条 / 已选 M 条）与批量按钮。
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
      </div>
    </div>

    <p v-if="alarms.error" class="alert alert--danger" role="alert">{{ alarms.error }}</p>
    <p v-else-if="notice" class="alert alert--success" role="status">{{ notice }}</p>

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
            @contextmenu="openRowMenu($event, alarm)"
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

    <!--
      行右键菜单（业主：每条记录支持 查看细节 / 回放 / 下载告警 / 加入样本 / 确认）。
      透明遮罩兜住"点外面"和"再按右键"两种关闭路径；不可用的项禁用并写出原因。
    -->
    <div
      v-if="rowMenu"
      class="row-menu-backdrop"
      data-alarm-row-menu-backdrop
      @click="closeRowMenu"
      @contextmenu.prevent="closeRowMenu"
    >
      <div
        class="row-menu"
        :style="{ left: rowMenu.x + 'px', top: rowMenu.y + 'px' }"
        role="menu"
        data-alarm-row-menu
        @click.stop
      >
        <button type="button" role="menuitem" class="row-menu__item" @click="openDetail(rowMenu.alarm); closeRowMenu()">
          {{ t('alarmsUi.menuDetail') }}
        </button>
        <button type="button" role="menuitem" class="row-menu__item" data-menu-replay @click="replayAlarm(rowMenu.alarm)">
          {{ t('alarmsUi.menuReplay') }}
        </button>
        <button
          type="button"
          role="menuitem"
          class="row-menu__item"
          data-menu-download
          :disabled="!rowMenu.alarm.localRecordingId || menuBusy"
          :title="rowMenu.alarm.localRecordingId ? '' : t('alarmsUi.menuNoRecording')"
          @click="downloadAlarm(rowMenu.alarm)"
        >
          {{ menuBusy ? t('common.loading') : t('alarmsUi.menuDownload') }}
        </button>
        <button type="button" role="menuitem" class="row-menu__item" data-menu-sample :disabled="menuBusy" @click="addAlarmToSamples(rowMenu.alarm)">
          {{ t('alarmsUi.menuAddSample') }}
        </button>
        <button type="button" role="menuitem" class="row-menu__item" data-menu-ack @click="toggleAckFromMenu(rowMenu.alarm)">
          {{ rowMenu.alarm.acknowledged ? t('alarmsUi.menuUnack') : t('alarmsUi.menuAck') }}
        </button>
      </div>
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
              :auto-load="replayAutoload"
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

          <!-- MP4 容器走视频播放器（回环 HTTP，支持 Range）；拿不到地址时如实说。 -->
          <section v-if="detail.localRecordingContainer === 'mp4'" class="drawer__section">
            <h4 class="drawer__section-title">{{ t('alarmsUi.videoTitle') }}</h4>
            <video v-if="videoUrl" controls class="drawer__video" :src="videoUrl" data-alarm-video></video>
            <p v-else-if="videoError" class="form-error" role="alert">{{ videoError }}</p>
            <p v-else class="muted">{{ t('common.loading') }}</p>
          </section>

          <!-- 抓图（听诊盒子族）：SN-16 每次告警 3 张球机抓图。 -->
          <section v-if="snapshots" class="drawer__section">
            <h4 class="drawer__section-title">{{ t('alarmsUi.snapshotsTitle') }}</h4>
            <div v-if="snapshots.files.length > 0" class="drawer__images" data-alarm-snapshots>
              <img v-for="file in snapshots.files" :key="file.name" :src="file.url" :alt="file.name" class="drawer__image" />
            </div>
            <p v-else-if="snapshots.state === 'not-captured'" class="muted">{{ t('eventsUi.evidenceNotCaptured') }}</p>
            <p v-else class="muted">{{ t('eventsUi.evidenceFilesGone') }}</p>
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
 * 筛选行（业主重构）：标题 / 内容 / 时间范围同一行。
 * 标题与内容输入框吸收剩余宽度；时间范围选择器固定宽幅；重置贴最右。
 */
.alarm-filter-row {
  align-items: flex-end;
}

.alarm-filter-row__title {
  flex: 1 1 180px;
  min-width: 140px;
}

.alarm-filter-row__content {
  flex: 1 1 180px;
  min-width: 140px;
}

.alarm-filter-row__range {
  flex: 0 0 auto;
  width: 260px;
}

.alarm-filter-row .filter-reset {
  margin-left: auto;
}

/* 行右键菜单：透明遮罩全屏兜点击，菜单钉在光标处。 */
.row-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
}

.row-menu {
  position: fixed;
  min-width: 168px;
  padding: 4px;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.15));
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16);
  display: flex;
  flex-direction: column;
}

.row-menu__item {
  padding: 8px 12px;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  border-radius: 4px;
  font-size: 13px;
}

.row-menu__item:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.06);
}

.row-menu__item:disabled {
  color: var(--color-text-secondary, #999);
  cursor: not-allowed;
}

/* 抽屉里的回放证据。 */
.drawer__video {
  width: 100%;
  border-radius: 6px;
  background: #000;
}

.drawer__images {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.drawer__image {
  width: 100%;
  border-radius: 4px;
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.12));
}

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
