<script setup lang="ts">
/**
 * Alarm records (spec section 10.1) — 界面上的名字是「告警中心」
 * （业主 2026-09-19：「告警记录修改为 告警中心」）。
 *
 * Hard rule from the spec: "Vue 页面禁止直接做 bit 判断". The raw `alarmMask` is
 * never inspected here — labels come from `describeAlarmMask()`, and per-row
 * chips come from the decoded `alarmTypes` array on the domain model.
 *
 * 筛选区是**字段式表单行**（业主 20260921 第二批：参照工业软件表单，左侧 label
 * 右对齐灰字 + 右侧控件，一行一项）：设备 / 告警类型 / 时间范围 / 标题 / 内容，
 * 每行占筛选总宽 50%（<900px 回落 100%），最后一行是操作按钮
 * （重置 / 批量确认 / 取消确认 / 加入样本库）。
 *
 * The detail drawer embeds the shared `RecordingPlayer`, which loads the alarm's
 * local recording through `window.api.playback.load(recordingId)`. An alarm only
 * stores metrics and the alarm type; the audio itself lives on the device until
 * the Recordings page syncs it, so an alarm without `localRecordingId` explains
 * that and links the operator to the sync action instead of showing a dead
 * player.
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type { AlarmEvent, AlarmQuery } from '@shared/domain/models'
import { ALARM_NOTE_MAX_LENGTH, AlarmType } from '@shared/domain/models'
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
import { useDeviceDetailDialogStore } from '@renderer/stores/deviceDetailDialog'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { channelLabel, formatDateTime, formatNumber, fromDateTimeLocalValue } from '@renderer/lib/format'
import { useAlarmLinkageStore } from '@renderer/stores/alarmLinkage'
import { useAlarmCenterModeStore } from '@renderer/stores/alarmCenterMode'
import {
  linkageDetectModeText,
  linkageDischargeText,
  linkageFrequencyText,
  linkageIntensityText,
  linkageMetricsText,
  linkageSeverityOf
} from '@renderer/lib/linkageText'
import type { PendingAlarmRecord } from '@shared/ipc/contract'
import RecordingPlayer from '@renderer/components/RecordingPlayer.vue'
import DateRangePicker from '@renderer/components/DateRangePicker.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const alarms = useAlarmsStore()
const uiRefresh = useUiRefreshStore()
const devices = useDevicesStore()
const detailDialog = useDeviceDetailDialogStore()
const linkage = useAlarmLinkageStore()

/**
 * 相机告警（业主 2026-09-24：与盒子告警合并成**同一张列表**，序号自动累积）。
 *
 * 判定与记录都在相机上，事件经联动引擎进本机待处理列表——**不进** `alarms` 表
 * （那张表只有听诊盒子的告警）。合并是客户端的：相机那份本来就有 200 条上限，
 * 全在内存里；盒子那份是服务器分页——合并后的序号只对**当前页**负责
 * （它是阅读定位，不是持久 id）。
 */
const cameraAlarms = computed(() =>
  linkage.pending
    .filter((item) => filters.deviceId === '' || item.deviceId === filters.deviceId)
    .slice()
    .sort((a, b) => b.at - a.at)
)

/** 统一的行模型：盒子行与相机行共用一套字段，点开的细节走各自的实现。 */
interface UnifiedAlarmRow {
  key: string
  kind: 'box' | 'camera'
  at: number
  severity: EventSeverity
  typeText: string
  deviceId: string
  deviceName: string
  metricsText: string
  acknowledged: boolean
  box: AlarmEvent | null
  camera: PendingAlarmRecord | null
}

const mergedRows = computed<UnifiedAlarmRow[]>(() => {
  const boxRows: UnifiedAlarmRow[] = rows.value.map((alarm) => ({
    key: `box:${alarm.id}`,
    kind: 'box',
    at: alarm.timestamp,
    severity: alarm.severity,
    typeText: describeAlarmMask(alarm.alarmMask),
    deviceId: alarm.deviceId,
    deviceName: devices.nameById(alarm.deviceId),
    metricsText: [
      alarm.spl !== undefined ? `${formatNumber(alarm.spl, 1)} dB` : '',
      alarm.mainFrequency !== undefined ? `${formatNumber(alarm.mainFrequency, 0)} Hz` : '',
      // 业主 2026-09-24 声纹设备告警指标口径：告警类型/声压级/主频/频带能量比。
      // （频谱差异度不在告警记录里——它在实时特征流里；不在这里编一个值。）
      alarm.bandEnergyRatio !== undefined && Number.isFinite(alarm.bandEnergyRatio)
        ? `${t('alarmsUi.metricBandEnergyRatio')} ${formatNumber(alarm.bandEnergyRatio, 2)}`
        : ''
    ]
      .filter((part) => part !== '')
      .join(' · '),
    acknowledged: alarm.acknowledged,
    box: alarm,
    camera: null
  }))
  const cameraRows: UnifiedAlarmRow[] = cameraAlarms.value.map((alarm) => ({
    key: `camera:${alarm.eventId}`,
    kind: 'camera',
    at: alarm.at,
    severity: linkageSeverityOf(alarm),
    typeText: cameraAlarmTypeText(alarm),
    deviceId: alarm.deviceId,
    deviceName: alarm.deviceName,
    metricsText: linkageMetricsText(t, alarm),
    acknowledged: alarm.acknowledged,
    box: null,
    camera: alarm
  }))
  return [...boxRows, ...cameraRows].sort((a, b) => b.at - a.at)
})

/** 相机告警的详情弹窗（录像 / 抓帧 / 动作结果 + 事件中心出口）。 */
const cameraDetail = ref<PendingAlarmRecord | null>(null)

/** 详情弹窗里的抓帧图与联动录像地址：打开才取，关掉即清。 */
const cameraDetailImageUrl = ref('')
const cameraDetailVideoUrl = ref('')
const cameraDetailImageState = ref<'idle' | 'ok' | 'missing'>('idle')

watch(cameraDetail, async (alarm) => {
  cameraDetailImageUrl.value = ''
  cameraDetailVideoUrl.value = ''
  cameraDetailImageState.value = 'idle'
  if (!alarm) return
  if (alarm.frameRelativePath) {
    const result = await callApi(() =>
      window.api.eventCenter.evidenceImage({ relativePath: alarm.frameRelativePath })
    )
    const view = result.success ? unwrap(result) : undefined
    if (view?.state === 'ok' && view.url) {
      cameraDetailImageUrl.value = view.url
      cameraDetailImageState.value = 'ok'
    } else {
      cameraDetailImageState.value = 'missing'
    }
  }
  if (alarm.recordingId) {
    const result = await callApi(() => window.api.cameraNvr.videoUrl(alarm.recordingId as string))
    const url = result.success ? (unwrap(result)?.url ?? '') : ''
    if (url !== '') cameraDetailVideoUrl.value = url
  }
})

/** 详情弹窗里就地确认（与铃铛面板同一条 IPC）。 */
async function acknowledgeCameraDetail(): Promise<void> {
  const alarm = cameraDetail.value
  if (!alarm) return
  await linkage.acknowledge([alarm.eventId])
}

/** 详情弹窗的出口：去事件中心看这条事件的完整抽屉（下载检测结果文件在那边）。 */
function openCameraDetailInEventCenter(): void {
  const alarm = cameraDetail.value
  if (!alarm) return
  cameraDetail.value = null
  void router.push({ path: '/events', query: { device: alarm.deviceId } })
}

function openUnified(row: UnifiedAlarmRow): void {
  if (row.kind === 'box' && row.box) {
    /*
     * 盒子行与相机行是**同一张表**里的两种记录，点开都必须给详情 ——
     * 业主 2026-09-26 第 5 条：「点击可以查看对应的告警详情」。
     *
     * 两条分支现在渲进**同一张全宽面板**（第 4 条），所以这里额外把另一条清掉：
     * 只留一份详情，不再出现"右边一个小详情 + 下面一个大详情"两处同时说话。
     */
    cameraDetail.value = null
    openDetail(row.box)
    return
  }
  if (row.camera) {
    detail.value = null
    cameraDetail.value = row.camera
  }
}

/**
 * 打开某一条**相机告警**的详情（供 `?cameraAlarm=<eventId>` 深链与行点击共用）。
 *
 * 从待处理列表里按 `eventId` 找权威记录，找不到就返回 false —— 调用方据此决定
 * "要不要说一句"，而不是自己编一条记录出来（编出来的详情会显示不存在的字段）。
 */
function openCameraAlarmById(eventId: string): boolean {
  const found = linkage.pending.find((item) => item.eventId === eventId)
  if (!found) return false
  detail.value = null
  cameraDetail.value = found
  return true
}

/** 相机告警的类型列：放电类型 > 检测模式 > 通用「告警」。 */
function cameraAlarmTypeText(alarm: PendingAlarmRecord): string {
  return linkageDischargeText(t, alarm) || linkageDetectModeText(t, alarm) || t('alarmsUi.cameraAlarmGeneric')
}

/**
 * 筛选（业主 20260921 第二批：字段式表单行，一行一项，每行 50% 宽）。
 *   · 设备 = 下拉到某一台（「全部设备」= 不限）；`deviceId` 也被「设备详情 → 查看告警记录」
 *     的 `?device=<id>` 预置成隐藏条件；
 *   · 告警类型 = 下拉到附录 B 的某一个位（「全部类型」= 不限），直接进 `AlarmQuery.alarmType`；
 *   · 时间范围 = 一个日历（DateRangePicker，开始与结束在同一个日历里选）；
 *   · 标题 = 设备名关键字（哪台设备的）；内容 = 备注 / 设备告警原因文本关键字。
 */
interface FilterState {
  deviceId: string
  alarmType: AlarmType | ''
  from: string
  to: string
  title: string
  content: string
}

const filters = reactive<FilterState>({
  deviceId: '',
  alarmType: '',
  from: '',
  to: '',
  title: '',
  content: ''
})

/**
 * 告警类型下拉的全部选项（附录 B，Bit0–Bit13）。
 * `AlarmType` 是纯数字枚举，取数值成员即得升序位序——与 `alarm-mask.ts` 里
 * `ALL_ALARM_TYPES` 同一个取法；文案走 `alarmTypeLabel()`（shared 只给稳定键，
 * 渲染层翻译），界面不做任何 bit 运算。
 */
const ALARM_TYPE_OPTIONS: readonly AlarmType[] = Object.values(AlarmType).filter(
  (value): value is AlarmType => typeof value === 'number'
)

/** 类型下拉变化：空串 = 「全部类型」，否则转回数字枚举。 */
function onAlarmTypeChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  filters.alarmType = value === '' ? '' : (Number(value) as AlarmType)
}

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
    deviceId: filters.deviceId || undefined,
    alarmType: filters.alarmType === '' ? undefined : filters.alarmType,
    title: filters.title.trim() || undefined,
    content: filters.content.trim() || undefined,
    from: fromDateTimeLocalValue(filters.from),
    to: fromDateTimeLocalValue(filters.to),
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
  filters.deviceId = ''
  filters.alarmType = ''
  filters.title = ''
  filters.content = ''
  filters.from = ''
  filters.to = ''
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

  /*
   * 深链：`?cameraAlarm=<eventId>` 直接把**这一条**相机告警的详情打开
   * （业主 2026-09-26 第 3 条：实时监测页点告警信息里的一行，要跳到告警中心看这条的详情）。
   *
   * 顺序是刻意的：`reload()` 之后、`linkage.load()` **之后**才找得到那条记录 ——
   * 相机告警只存在于联动待处理列表，而那份列表可能是这一页第一次读（例如开机直接
   * 从书签进来）。所以这里先读一次权威快照，再按 eventId 找。
   *
   * 找不到时**如实说**（`notice`）：那条告警可能已经被确认并因上限被丢弃，
   * 静默打开一个空详情会让人以为软件坏了。
   */
  const cameraAlarmId = typeof route.query.cameraAlarm === 'string' ? route.query.cameraAlarm : ''
  if (cameraAlarmId !== '') {
    await linkage.load()
    if (!openCameraAlarmById(cameraAlarmId)) {
      notice.value = t('alarmsUi.cameraAlarmNotFound')
    }
  }
})

/**
 * 这一屏就是「告警中心」：告诉 shell「告警中心正在看着」，于是**持续催办**与
 * 非告警类提示不再额外发声（业主 2026-09-26 第 5 条）。卸载即撤销 ——
 * 视图卸载是"这一屏不在了"最诚实的判据，比在路由守卫里配对可靠（守卫漏一次就永久静音）。
 */
const alarmCenter = useAlarmCenterModeStore()
onMounted(() => alarmCenter.enter())
onUnmounted(() => alarmCenter.leave())

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

/** 点设备名 = 打开设备详情**弹窗**（业主 20260921；原来是整页跳转）。 */
function openDevice(deviceId: string): void {
  detailDialog.show(deviceId, devices.byId(deviceId)?.name ?? '')
}
</script>

<template>
  <div class="page alarm-center-page">
    <!-- Compact filters: keep the page focused on the records + evidence workspace. -->
    <section class="card alarm-filters" data-alarm-filters>
      <div class="alarm-filter-grid" data-alarm-simple-filters>
        <label class="field alarm-filter-field">
          <span class="field-label">{{ t('alarmsUi.filterDevice') }}</span>
          <select v-model="filters.deviceId" class="select" data-filter-device>
            <option value="">{{ t('alarmsUi.filterAllDevices') }}</option>
            <option v-for="device in devices.devices" :key="device.id" :value="device.id">
              {{ device.name }}
            </option>
          </select>
        </label>

        <label class="field alarm-filter-field">
          <span class="field-label">{{ t('alarmsUi.filterType') }}</span>
          <select
            class="select"
            data-filter-alarm-type
            :value="filters.alarmType"
            @change="onAlarmTypeChange"
          >
            <option value="">{{ t('alarmsUi.filterAllTypes') }}</option>
            <option v-for="type in ALARM_TYPE_OPTIONS" :key="type" :value="type">
              {{ alarmTypeLabel(type) }}
            </option>
          </select>
        </label>

        <label class="field alarm-filter-field alarm-filter-field--range">
          <span class="field-label">{{ t('alarmsUi.filterTimeRange') }}</span>
          <DateRangePicker :from="filters.from" :to="filters.to" @apply="applyDateRange" />
        </label>

        <label class="field alarm-filter-field">
          <span class="field-label">{{ t('alarmsUi.filterTitle') }}</span>
          <input
            v-model="filters.title"
            class="input"
            type="search"
            data-filter-title
            :placeholder="t('alarmsUi.filterTitleHint')"
          />
        </label>

        <label class="field alarm-filter-field">
          <span class="field-label">{{ t('alarmsUi.filterContent') }}</span>
          <input
            v-model="filters.content"
            class="input"
            type="search"
            data-filter-content
            :placeholder="t('alarmsUi.filterContentHint')"
          />
        </label>

        <div class="alarm-filter-actions">
          <button type="button" class="btn btn--sm" data-action="reset-alarm-filters" @click="reset">
            {{ t('common.reset') }}
          </button>
        </div>
      </div>
    </section>

    <p v-if="alarms.error" class="alert alert--danger" role="alert">{{ alarms.error }}</p>
    <p v-else-if="notice" class="alert alert--success" role="status">{{ notice }}</p>

    <div class="alarm-workspace" :class="{ 'alarm-workspace--detail': detail !== null }">
      <!-- Master list -->
      <section class="card alarm-master">
        <header class="alarm-master__head">
          <div>
            <h3 class="section-title">{{ t('alarmsUi.detailTitle') }}</h3>
            <p class="muted alarm-master__count">
              {{ t('alarmsUi.countSummary', { total: alarms.total, selected: selectedIds.length }) }}
            </p>
          </div>
          <label class="select-all" :title="t('alarmsUi.selectAll')">
            <input
              type="checkbox"
              :checked="allSelected"
              :aria-label="t('alarmsUi.selectAll')"
              @change="toggleAll(($event.target as HTMLInputElement).checked)"
            />
            <span class="muted">{{ t('alarmsUi.selectAll') }}</span>
          </label>
        </header>

        <div v-if="selectedIds.length > 0" class="alarm-bulk-bar">
          <span class="muted">{{ t('alarmsUi.countSummary', { total: alarms.total, selected: selectedIds.length }) }}</span>
          <div class="btn-row">
            <button
              type="button"
              class="btn btn--sm"
              :disabled="bulkBusy"
              @click="bulkAcknowledge(true)"
            >
              {{ t('alarmsUi.bulkAcknowledge') }}
            </button>
            <button
              type="button"
              class="btn btn--sm"
              :disabled="bulkBusy"
              @click="bulkAcknowledge(false)"
            >
              {{ t('alarmsUi.bulkUnacknowledge') }}
            </button>
            <button
              type="button"
              class="btn btn--sm"
              :disabled="bulkBusy"
              @click="addSelectedToSamples"
            >
              {{ t('alarmsUi.addSelectedToSamples') }}
            </button>
          </div>
        </div>

        <div class="alarm-list" role="list">
          <div v-if="mergedRows.length === 0" class="alarm-list__empty">
            {{ alarms.loading ? t('alarmsUi.loading') : t('alarmsUi.empty') }}
          </div>

          <!--
            统一列表（业主 2026-09-24）：盒子告警与相机告警同一张表，序号自动累积
            （当前显示批次内的 1..N）。点行开细节：盒子行是原来的抽屉，相机行是
            下方的证据弹窗（录像/抓帧/动作结果 + 事件中心出口）。
          -->
          <article
            v-for="(row, rowIndex) in mergedRows"
            :key="row.key"
            class="alarm-row"
            :class="{ 'alarm-row--active': row.kind === 'box' && detail?.id === row.box?.id }"
            role="listitem"
            tabindex="0"
            @click="openUnified(row)"
            @keydown.enter="openUnified(row)"
            @contextmenu="row.kind === 'box' && row.box ? openRowMenu($event, row.box) : undefined"
          >
            <div class="alarm-row__check" @click.stop>
              <input
                v-if="row.kind === 'box' && row.box"
                type="checkbox"
                :checked="selectedIds.includes(row.box.id)"
                :aria-label="t('alarmsUi.selectRow', { id: row.box.id })"
                @change="toggleRow(row.box!.id, ($event.target as HTMLInputElement).checked)"
              />
            </div>

            <div class="alarm-row__severity" :class="`alarm-row__severity--${row.severity}`" aria-hidden="true"></div>

            <div class="alarm-row__body">
              <div class="alarm-row__top">
                <span class="muted alarm-row__index">#{{ rowIndex + 1 }}</span>
                <strong class="alarm-row__type">{{ row.typeText }}</strong>
                <time class="alarm-row__time">{{ formatDateTime(row.at) }}</time>
              </div>
              <div class="alarm-row__meta">
                <button type="button" class="link-btn" @click.stop="openDevice(row.deviceId)">
                  {{ row.deviceName }}
                </button>
                <span v-if="row.kind === 'box' && row.box">· {{ channelLabel(row.box.channelId) }}</span>
                <span v-if="row.metricsText">· {{ row.metricsText }}</span>
              </div>
              <div class="alarm-row__bottom">
                <span class="badge" :class="`badge--severity-${row.severity}`">
                  {{ eventSeverityLabel(row.severity) }}
                </span>
                <span class="badge" :class="row.acknowledged ? 'badge--success' : 'badge--warning'">
                  {{ row.acknowledged ? t('alarmsUi.ackAcknowledged') : t('alarmsUi.ackUnacknowledged') }}
                </span>
                <span v-if="row.kind === 'box' && row.box && row.box.alarmTypes.length > 1" class="alarm-row__multi muted">
                  +{{ row.box.alarmTypes.length - 1 }}
                </span>
                <span v-if="row.kind === 'camera'" class="alarm-row__multi muted">{{ t('alarmsUi.cameraRowBadge') }}</span>
              </div>
            </div>
          </article>
        </div>

        <div class="pager alarm-master__pager">
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
      </section>

      <!--
        详情 / 证据面板（业主 2026-09-26 第 4 条：「告警中心的告警详情应该占全部宽度，
        右侧的一个小的告警详情页面应该删除」）。

        改法：详情不再是右侧那一列（原来 `grid-template-columns: 0.95fr 1.05fr` 的第二格），
        而是**列表下方的一整幅宽面板**。列表也只在自己那一行里滚动，整页纵向排布
        （`.alarm-workspace--detail` 把网格收成一列）。

        两条分支共用同一张全宽面板：
          · `detail`（听诊盒子告警，来自 `alarms` 表）：指标 + 录音回放 / MP4 + 抓图 + 备注；
          · `cameraDetail`（相机告警，来自联动待处理列表）：设备侧字段 + 联动录像 +
            抓帧 + 动作结果。
        证据类内容一个都没删：**音频**（`RecordingPlayer`）、**视频**（MP4 与联动录像）、
        **文件**（抓图与「在事件中心查看完整证据」）仍在这张面板里，只是横过来之后
        每一段都拿到了整幅宽。
      -->
      <section v-if="detail || cameraDetail" class="card alarm-detail" data-alarm-detail>

        <!-- ---- 相机告警（联动待处理记录）的全宽详情 ---------------------- -->
        <template v-if="!detail && cameraDetail">
          <header class="alarm-detail__head">
            <div class="alarm-detail__title-group">
              <div class="alarm-detail__eyebrow">
                <span class="badge" :class="`badge--severity-${linkageSeverityOf(cameraDetail)}`">
                  {{ eventSeverityLabel(linkageSeverityOf(cameraDetail)) }}
                </span>
                <span class="badge" :class="cameraDetail.acknowledged ? 'badge--success' : 'badge--warning'">
                  {{ cameraDetail.acknowledged ? t('alarmsUi.ackAcknowledged') : t('alarmsUi.ackUnacknowledged') }}
                </span>
                <span class="badge">{{ t('alarmsUi.cameraRowBadge') }}</span>
              </div>
              <h3 class="alarm-detail__title">{{ cameraAlarmTypeText(cameraDetail) }}</h3>
              <p class="muted alarm-detail__time">{{ formatDateTime(cameraDetail.at) }}</p>
            </div>
            <div class="alarm-detail__nav btn-row">
              <button type="button" class="btn btn--sm" data-action="alarm-detail-close" @click="cameraDetail = null">
                {{ t('common.close') }}
              </button>
            </div>
          </header>

          <div class="alarm-detail__scroll">
            <section class="alarm-summary-grid">
              <div class="summary-item">
                <span class="summary-item__label">{{ t('alarmsUi.filterDevice') }}</span>
                <button type="button" class="summary-item__value link-btn" @click="openDevice(cameraDetail.deviceId)">
                  {{ cameraDetail.deviceName }}
                </button>
              </div>
              <div class="summary-item">
                <span class="summary-item__label">{{ t('alarmsUi.columnSeverity') }}</span>
                <strong class="summary-item__value">
                  {{ cameraDetail.alarmLevelRaw === undefined ? '—' : `${t('linkage.pendingLevel')} ${cameraDetail.alarmLevelRaw}` }}
                </strong>
              </div>
              <div class="summary-item">
                <span class="summary-item__label">{{ t('cameraAlarmUi.columnIntensity') }}</span>
                <strong class="summary-item__value summary-item__metric">
                  {{ linkageIntensityText(t, cameraDetail) || '—' }}
                </strong>
              </div>
              <div class="summary-item">
                <span class="summary-item__label">{{ t('cameraAlarmUi.columnMainFrequency') }}</span>
                <strong class="summary-item__value summary-item__metric">
                  {{ linkageFrequencyText(t, cameraDetail) || '—' }}
                </strong>
              </div>
            </section>

            <!-- 证据 ①：联动录像（视频，可直接播）。 -->
            <section class="detail-section detail-section--evidence">
              <div class="detail-section__head">
                <h4 class="detail-section__title">{{ t('alarmsUi.videoTitle') }}</h4>
              </div>
              <video v-if="cameraDetailVideoUrl" :src="cameraDetailVideoUrl" controls class="alarm-detail__video"></video>
              <p v-else class="muted">{{ t('alarmsUi.cameraEvidenceNoVideo') }}</p>
            </section>

            <!-- 证据 ②：抓帧图片（文件）。 -->
            <section class="detail-section detail-section--evidence">
              <div class="detail-section__head">
                <h4 class="detail-section__title">{{ t('alarmsUi.snapshotsTitle') }}</h4>
              </div>
              <img v-if="cameraDetailImageUrl" :src="cameraDetailImageUrl" class="alarm-detail__image" alt="" />
              <p v-else-if="cameraDetailImageState === 'missing'" class="muted">{{ t('alarmsUi.cameraEvidenceMissing') }}</p>
              <p v-else class="muted">{{ t('alarmsUi.cameraEvidenceLoading') }}</p>
            </section>

            <!-- 证据 ③：联动动作结果（录像/弹窗/提示/邮件各一行，成功失败如实）。 -->
            <section v-if="cameraDetail.actions.length > 0" class="detail-section">
              <h4 class="detail-section__title">{{ t('alarmsUi.cameraActionsTitle') }}</h4>
              <ul class="camera-alarm-detail__actions">
                <li v-for="action in cameraDetail.actions" :key="`${action.action}-${action.at}`">
                  {{ t(`linkage.action.${action.action}`) }}: {{ t(`linkage.actionState.${action.status}`) }}<template v-if="action.reason"> — {{ action.reason }}</template>
                </li>
              </ul>
            </section>

            <section class="detail-section detail-actions-grid">
              <div class="detail-control detail-control--actions">
                <button
                  v-if="!cameraDetail.acknowledged"
                  type="button"
                  class="btn btn--sm"
                  data-action="camera-alarm-detail-ack"
                  @click="acknowledgeCameraDetail"
                >
                  {{ t('alarmsUi.menuAck') }}
                </button>
                <button type="button" class="btn btn--sm btn--primary" @click="openCameraDetailInEventCenter">
                  {{ t('alarmsUi.viewInEventCenter') }}
                </button>
              </div>
            </section>
          </div>
        </template>

        <template v-else-if="detail">
          <header class="alarm-detail__head">
            <div class="alarm-detail__title-group">
              <div class="alarm-detail__eyebrow">
                <span class="badge" :class="`badge--severity-${detail.severity}`">
                  {{ eventSeverityLabel(detail.severity) }}
                </span>
                <span class="badge" :class="detail.acknowledged ? 'badge--success' : 'badge--warning'">
                  {{ detail.acknowledged ? t('alarmsUi.ackAcknowledged') : t('alarmsUi.ackUnacknowledged') }}
                </span>
              </div>
              <h3 class="alarm-detail__title">{{ describeAlarmMask(detail.alarmMask) }}</h3>
              <p class="muted alarm-detail__time">{{ formatDateTime(detail.timestamp) }}</p>
            </div>
            <div class="alarm-detail__nav btn-row">
              <button type="button" class="btn btn--sm btn--icon" :disabled="!canPrevEvent" :title="t('alarmsUi.prevEvent')" @click="stepEvent(-1)">
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <button type="button" class="btn btn--sm btn--icon" :disabled="!canNextEvent" :title="t('alarmsUi.nextEvent')" @click="stepEvent(1)">
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </div>
          </header>

          <div class="alarm-detail__scroll">
            <section class="alarm-summary-grid">
              <div class="summary-item">
                <span class="summary-item__label">{{ t('alarmsUi.filterDevice') }}</span>
                <button type="button" class="summary-item__value link-btn" @click="openDevice(detail.deviceId)">
                  {{ devices.nameById(detail.deviceId) }}
                </button>
              </div>
              <div class="summary-item">
                <span class="summary-item__label">{{ t('alarmsUi.columnChannel') }}</span>
                <strong class="summary-item__value">{{ channelLabel(detail.channelId) }}</strong>
              </div>
              <div class="summary-item">
                <span class="summary-item__label">{{ t('metrics.spl') }}</span>
                <strong class="summary-item__value summary-item__metric">{{ formatNumber(detail.spl, 2) }} dB</strong>
              </div>
              <div class="summary-item">
                <span class="summary-item__label">{{ t('metrics.mainFrequency') }}</span>
                <strong class="summary-item__value summary-item__metric">{{ formatNumber(detail.mainFrequency, 2) }} Hz</strong>
              </div>
              <div class="summary-item">
                <span class="summary-item__label">{{ t('metrics.smoothness') }}</span>
                <strong class="summary-item__value">{{ formatNumber(detail.smoothness, 3) }}</strong>
              </div>
              <div class="summary-item">
                <span class="summary-item__label">{{ t('metrics.bandEnergyRatio') }}</span>
                <strong class="summary-item__value">{{ formatNumber(detail.bandEnergyRatio, 3) }}</strong>
              </div>
            </section>

            <section class="detail-section detail-section--evidence">
              <div class="detail-section__head">
                <h4 class="detail-section__title">{{ t('alarmsUi.playbackTitle') }}</h4>
                <span v-if="detailIndex >= 0" class="muted">
                  {{ t('alarmsUi.eventPosition', { index: detailIndex + 1, total: rows.length }) }}
                </span>
              </div>

              <div v-if="snapshots && snapshots.files.length > 0" class="evidence-snapshots" data-alarm-snapshots>
                <img v-for="file in snapshots.files" :key="file.name" :src="file.url" :alt="file.name" class="evidence-snapshot" />
              </div>

              <video
                v-if="detail.localRecordingContainer === 'mp4' && videoUrl"
                controls
                class="evidence-video"
                :src="videoUrl"
                data-alarm-video
              ></video>
              <p v-else-if="detail.localRecordingContainer === 'mp4' && videoError" class="form-error" role="alert">
                {{ videoError }}
              </p>

              <RecordingPlayer
                v-if="detail.localRecordingContainer !== 'mp4'"
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

              <p v-if="snapshots && snapshots.files.length === 0 && snapshots.state === 'not-captured'" class="muted">
                {{ t('eventsUi.evidenceNotCaptured') }}
              </p>
            </section>

            <section class="detail-section detail-actions-grid">
              <div class="detail-control">
                <span class="field-label">{{ t('alarmsUi.severitySectionTitle') }}</span>
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
              </div>

              <div class="detail-control detail-control--actions">
                <span class="field-label">{{ t('alarmsUi.ackSectionTitle') }}</span>
                <div class="btn-row">
                  <button type="button" class="btn btn--primary btn--sm" @click="toggleDetailAck">
                    {{ detail.acknowledged ? t('alarmsUi.bulkUnacknowledge') : t('alarmsUi.markAcknowledged') }}
                  </button>
                  <button type="button" class="btn btn--sm" :disabled="sampleBusy" @click="addDetailToSamples">
                    {{ sampleBusy ? t('common.loading') : t('alarmsUi.addToSamples') }}
                  </button>
                  <RouterLink class="btn btn--sm" to="/samples">{{ t('alarmsUi.goSamples') }}</RouterLink>
                </div>
              </div>
            </section>

            <section class="detail-section">
              <h4 class="detail-section__title">{{ t('alarmsUi.noteSectionTitle') }}</h4>
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
              <p v-if="detailSampleNotice" class="detail-notice" role="status">{{ detailSampleNotice }}</p>
            </section>
          </div>
        </template>
      </section>
    </div>

    <!-- Context menu remains available for power users. -->
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

    <!--
      相机告警的细节**不再是一个 640px 的弹窗**（业主 2026-09-26 第 4 条：右侧那个小的
      告警详情页面要删掉、详情占全部宽度）。它现在渲染在上面那张全宽 `alarm-detail`
      面板里（`v-if="!detail && cameraDetail"` 那一段），证据一项都没少。
    -->
  </div>
</template>

<style scoped>
.alarm-center-page {
  gap: var(--space-3);
}

.alarm-filters {
  padding: 10px 12px;
}

.alarm-filter-grid {
  display: grid;
  grid-template-columns: minmax(150px, 1fr) minmax(150px, 1fr) minmax(240px, 1.45fr) minmax(170px, 1fr) minmax(170px, 1fr) auto;
  gap: 8px;
  align-items: end;
}

.alarm-filter-field {
  min-width: 0;
  gap: 4px;
}

.alarm-filter-field .field-label {
  font-size: 11px;
}

.alarm-filter-field .select,
.alarm-filter-field .input {
  width: 100%;
  min-width: 0;
  height: var(--control-height-sm);
}

.alarm-filter-field :deep(.range-picker) {
  min-width: 0;
  width: 100%;
}

.alarm-filter-actions {
  display: flex;
  align-items: flex-end;
}

/*
 * 工作区：**一列**（业主 2026-09-26 第 4 条：详情占全部宽度、右侧那个小的详情页删掉）。
 *
 * 原来是 `minmax(430px, 0.95fr) minmax(480px, 1.05fr)` 两列 —— 左边列表、右边详情。
 * 现在列表与详情各占一整行：列表在上（自己那一行里滚动），详情在下（整幅宽）。
 * 留 `--detail` 这个修饰类只是为了在"还没选任何一条"时让列表独占一屏，
 * 不必为一个空详情预留一行。
 */
.alarm-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-3);
  min-height: 0;
  align-items: start;
}

.alarm-master,
.alarm-detail {
  min-width: 0;
  padding: 0;
  overflow: hidden;
}

.alarm-master__head,
.alarm-detail__head {
  min-height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
}

.alarm-master__count,
.alarm-detail__time {
  margin: 2px 0 0;
  font-size: 11.5px;
}

.select-all {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  cursor: pointer;
}

.alarm-bulk-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 7px 10px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-subtle);
}

.alarm-list {
  max-height: min(65vh, 720px);
  overflow-y: auto;
}

.alarm-list__empty {
  padding: 42px 16px;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 12.5px;
}

.alarm-row {
  position: relative;
  display: grid;
  grid-template-columns: 24px 3px minmax(0, 1fr);
  gap: 9px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
  outline: none;
  transition: background 120ms ease;
}

.alarm-row:hover,
.alarm-row:focus-visible {
  background: var(--color-bg-hover);
}

.alarm-row--active {
  background: var(--color-accent-soft);
}

.alarm-row__check {
  padding-top: 2px;
}

.alarm-row__severity {
  width: 3px;
  min-height: 46px;
  border-radius: 3px;
  background: var(--color-border-strong);
}

.alarm-row__severity--critical { background: var(--color-danger, #d64545); }
.alarm-row__severity--warning { background: var(--color-warning, #d99a2b); }
.alarm-row__severity--info { background: var(--color-accent, #4a8fd6); }
.alarm-row__severity--unknown { background: var(--color-text-secondary, #8b8f97); }

.alarm-row__body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.alarm-row__top,
.alarm-row__bottom,
.alarm-row__meta {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.alarm-row__top {
  justify-content: space-between;
}

.alarm-row__type {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}

.alarm-row__time,
.alarm-row__meta {
  color: var(--color-text-secondary);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.alarm-row__time {
  flex: none;
}

.alarm-row__meta {
  overflow: hidden;
  white-space: nowrap;
}

.alarm-row__bottom {
  min-height: 20px;
}

.alarm-row__multi {
  margin-left: auto;
  font-size: 11px;
}

.alarm-master__pager {
  padding: 9px 12px;
  border-top: 1px solid var(--color-border);
}

/*
 * 详情面板现在是**列表下方的一整幅宽面板**（业主 2026-09-26 第 4 条），不再右侧那一列。
 *
 * 所以 `position: sticky` 与 `max-height: calc(100vh - 112px)` 都删掉了：那两条是
 * "右边一列跟着滚"的做法，横过来之后只会让一张全宽面板卡在半个屏幕上、
 * 里面的证据（视频 / 图片）反而看不全。现在它按内容自然排布，整页纵向滚动。
 */
.alarm-detail {
  display: flex;
  flex-direction: column;
}

/* 全宽之后证据区可以并排：左视频、右抓图（窄窗口自动落成一列）。 */
.detail-section--evidence {
  min-width: 0;
}

.alarm-detail__video,
.alarm-detail__image {
  width: 100%;
  max-height: 420px;
  border-radius: var(--radius-sm, 6px);
  background: #000;
  object-fit: contain;
}

.alarm-detail__image {
  background: var(--color-bg-subtle);
}

.alarm-detail__title-group {
  min-width: 0;
}

.alarm-detail__eyebrow {
  display: flex;
  gap: 5px;
  margin-bottom: 5px;
}

.alarm-detail__title {
  margin: 0;
  font-size: 15px;
  line-height: 1.3;
}

.alarm-detail__nav {
  flex: none;
}

.alarm-detail__scroll {
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.alarm-summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
}

.summary-item {
  min-width: 0;
  padding: 8px 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.summary-item__label {
  font-size: 10.5px;
  color: var(--color-text-secondary);
}

.summary-item__value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  text-align: left;
}

.summary-item__metric {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.detail-section {
  border-top: 1px solid var(--color-border);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.detail-section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.detail-section__title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
}

.evidence-snapshots {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.evidence-snapshot {
  width: 100%;
  aspect-ratio: 16 / 10;
  object-fit: cover;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: #111;
}

.evidence-video {
  width: 100%;
  max-height: 310px;
  border-radius: var(--radius-sm);
  background: #000;
}

.detail-actions-grid {
  display: grid;
  grid-template-columns: minmax(150px, 0.7fr) minmax(240px, 1.3fr);
  gap: 12px;
}

.detail-control {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.detail-control--actions .btn-row {
  flex-wrap: wrap;
}

.note-box {
  width: 100%;
  resize: vertical;
  font: inherit;
  line-height: 1.5;
}

.detail-notice {
  margin: 0;
  font-size: 11.5px;
  color: var(--color-success);
}

.alarm-detail__empty {
  min-height: 420px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--color-text-secondary);
  text-align: center;
}

.alarm-detail__empty-icon {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  background: var(--color-bg-subtle);
  color: var(--color-text-secondary);
  margin-bottom: 4px;
}

.link-btn {
  border: none;
  background: none;
  padding: 0;
  color: var(--color-text);
  cursor: pointer;
  font: inherit;
}

.link-btn:hover {
  color: var(--color-accent);
}

.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: 12px;
}

/* Context menu */
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

.row-menu__item:hover:not(:disabled) { background: rgba(0, 0, 0, 0.06); }
.row-menu__item:disabled { color: var(--color-text-secondary, #999); cursor: not-allowed; }

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

@media (max-width: 1280px) {
  .alarm-filter-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .alarm-workspace {
    grid-template-columns: minmax(380px, 0.9fr) minmax(440px, 1.1fr);
  }
}

@media (max-width: 980px) {
  .alarm-filter-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .alarm-workspace {
    grid-template-columns: 1fr;
  }

  .alarm-detail {
    position: static;
    max-height: none;
  }

  .alarm-list {
    max-height: 520px;
  }
}

@media (max-width: 640px) {
  .alarm-filter-grid,
  .alarm-summary-grid,
  .detail-actions-grid {
    grid-template-columns: 1fr;
  }

  .alarm-bulk-bar {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
