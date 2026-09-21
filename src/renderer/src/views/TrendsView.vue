<script setup lang="ts">
/**
 * Historical trend page (Phase 11, spec §12.2).
 *
 * THE THREE RULES THIS PAGE IS BUILT AROUND
 *
 * 1. THE RENDERER NEVER TOUCHES THE OUTSIDE WORLD. Every value here comes from
 *    `window.api.trends.*` through the store; there is no fetch, no XHR, no
 *    socket (the renderer's CSP has `connect-src 'none'` anyway). The page also
 *    never sees the on-disk storage identity: it sends the local `deviceId` it
 *    already holds and the main process resolves the identity, so the storage
 *    layout stays in the main process where it belongs.
 *
 * 2. DOWNSAMPLING HAPPENS IN THE MAIN PROCESS, EXACTLY ONCE. The backend picks a
 *    bucket size from the requested span (`chooseBucketSeconds`) and aggregates
 *    in SQL, so a month of history arrives as ~500 rows instead of 2.6 million.
 *    There is deliberately NO second decimation layer in this file — no `lttb`
 *    sampling, no manual thinning. Do not "optimise" it back in: it would hide
 *    the buckets the diagnostics line exists to prove.
 *
 * 3. A MISSING VALUE IS A GAP, NEVER A ZERO. `TrendPoint.value` is `NaN` when
 *    the device did not report that metric in a bucket. It is mapped to `null`
 *    for ECharts with `connectNulls: false`, because a zero on an acoustic chart
 *    reads as "measured silence" — a lie about a device that may simply have
 *    dropped frames.
 *
 * The chart itself is the shared `EChart.vue` wrapper; this file only builds the
 * option object.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type { EChartsCoreOption } from 'echarts/core'
import type { TrendMetric } from '@shared/ipc/contract'
import { CHANNEL_COUNT, type AlarmEvent } from '@shared/domain/models'
import { trendAxisRange, trendAxisRangeText, trendDataZoom, trendZoomBurstExceeded, trendZoomIndexRange, trendZoomIsIdentity, trendZoomShouldRecord, trendZoomWindow } from '@shared/domain/trend'
import { TREND_GRANULARITY_OPTIONS, granularityKeyForSeconds } from '@shared/domain/trend-granularity'
import {
  buildTrendCsv,
  trendCsvFileName,
  type TrendExportRow
} from '@shared/domain/trend-export'
import {
  CHANNEL_NAME_MAX_LENGTH,
  CHANNEL_NAME_PROBLEM_KEYS,
  normaliseChannelName
} from '@shared/domain/channel-name'
import {
  TREND_METRIC_MAX_SELECTED,
  TREND_RANGE_OPTIONS,
  useTrendsStore
} from '@renderer/stores/trends'
import { useUiRefreshStore } from '@renderer/stores/uiRefresh'
import { useDevicesStore } from '@renderer/stores/devices'
import { useDeviceConfigStore } from '@renderer/stores/deviceConfig'
import { channelState, type ChannelState } from '@renderer/lib/channelState'
import {
  EMPTY_VALUE,
  channelLabel,
  formatBytes,
  formatDateTime,
  formatTrendTick,
  fromDateTimeLocalValue,
  toDateTimeLocalValue
} from '@renderer/lib/format'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import {
  TREND_METRIC_META,
  TREND_METRIC_OPTIONS,
  formatBucketSeconds,
  trendAggregationLabel,
  trendAxisName,
  trendChannelColor,
  trendMetricLabel,
  trendValueText
} from '@renderer/lib/trendMetrics'
import { describeAlarmMask, eventSeverityLabel } from '@renderer/lib/labels'
import EmptyState from '@renderer/components/EmptyState.vue'
import EChart from '@renderer/components/EChart.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const devices = useDevicesStore()
const trends = useTrendsStore()
const uiRefresh = useUiRefreshStore()
const deviceConfig = useDeviceConfigStore()

const selectedDeviceId = ref('')
/** Local text mirrors of the custom bounds, so typing is never fought by a re-render. */
const customFromText = ref('')
const customToText = ref('')
const notice = ref('')

// ---------------------------------------------------------------------------
// Toolbar bindings
// ---------------------------------------------------------------------------

/**
 * Selects are bound through string computeds because a `<select>` always hands
 * back a string: the setter looks the option up instead of casting, so an
 * unknown value can never enter the store as a fake union member.
 *
 * Each setter schedules a query through the store's debounce. The query is
 * triggered by the USER ACTION rather than by a store watcher, which keeps a
 * device switch (where coverage can seed the custom bounds) from firing the same
 * query twice.
 */
/**
 * 量可以**多选**（业主 2026-09-18 追加要求：「这些数值的趋势变化的同时显示」）。
 *
 * 每个选中的量各画**一张图**，而不是把它们叠进一张图：四个量里只有声压级是 dB，另外三个
 * 是无量纲比值；共用一根 Y 轴时，一条 62 dB 的线与一条 0.31 的比值线之间的高低关系是
 * **刻度造出来的**，不是数据说的。并排多图让每一根轴各自有意义（见文件头）。
 */
function toggleMetric(targetMetric: TrendMetric): void {
  trends.toggleMetric(targetMetric)
}

// ---------------------------------------------------------------------------
// 指标顺序（业主 20260921：指标 chips 支持拖拽排序）
// ---------------------------------------------------------------------------

/**
 * chips（与图表）的显示顺序。**只活在本次会话**：排序是个人看盘习惯，不写进
 * localStorage —— 持久化会让"清一次缓存 / 换一台机器"之后的顺序变得说不准。
 * 默认 = `TREND_METRIC` 顺序；新增选中一个顺序表之外的量时 append 在尾部
 * （`orderedSelectedMetrics` 里的兜底分支），已有的相对顺序不被那一次点击打乱。
 */
const metricOrder = ref<TrendMetric[]>(TREND_METRIC_OPTIONS.map((option) => option.key))

/** 正在被拖的那个量。`dragover` 阶段读不到 `dataTransfer` 的数据，另存一份在这里。 */
const draggingMetric = ref<TrendMetric | null>(null)

/**
 * 选中的量按 `metricOrder` 排成图：chips 的视觉顺序与图表的上下顺序是**同一个来源**，
 * 拖一下 chips，图跟着换位。拖的是"显示顺序"，选中集合与查询都不变（不重新查库）。
 */
const orderedSelectedMetrics = computed<TrendMetric[]>(() => [
  ...metricOrder.value.filter((key) => trends.metrics.includes(key)),
  ...trends.metrics.filter((key) => !metricOrder.value.includes(key))
])

function onMetricDragStart(key: TrendMetric, event: DragEvent): void {
  draggingMetric.value = key
  event.dataTransfer?.setData('text/plain', key)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

/** 松手的那颗 chip 是落点：把被拖的量插到它原来的位置上，其余保持相对顺序。 */
function onMetricDrop(target: TrendMetric): void {
  const from = draggingMetric.value
  draggingMetric.value = null
  if (!from || from === target) return
  const next = [...metricOrder.value]
  const fromIndex = next.indexOf(from)
  const toIndex = next.indexOf(target)
  if (fromIndex < 0 || toIndex < 0) return
  next.splice(fromIndex, 1)
  next.splice(toIndex, 0, from)
  metricOrder.value = next
}

function onMetricDragEnd(): void {
  draggingMetric.value = null
}

/**
 * 「聚合方式」那个下拉框**删掉了**（业主 2026-09-19 第 13 批第 5 条：
 * 「下方的指标删除聚合方式、直接呈现所有结果」）。
 *
 * 删的是**让操作员选**：一个时间桶里面怎么算仍然存在（后端按 `aggregation` 算，固定平均），
 * 而且 Y 轴名字里照旧写着「（平均）」—— 不写就是把"一桶的平均值"说成了"原始读数"。
 * 换个说法：桶里面的算法规格只有一种时，再多一个下拉框只是让操作员以为
 * "换一种聚合方式能得到不同的数据"，而数据是同一批。
 */
const granularitySelection = computed({
  get: () => trends.granularity,
  set: (value: string) => trends.setGranularity(value)
})

/**
 * 「自动」那一档旁边要把**主进程实际挑的桶宽**写出来。
 *
 * 不回显的话"自动"就是一个黑箱，而它恰恰决定了这张图有多细（第 5 条要的是"自定义缩放
 * 时间颗粒度"—— 要看得出自己在哪一档上）。桶宽来自后端回话（`series.bucketSeconds`）。
 */
const autoBucketText = computed(() => {
  const seconds = trends.series?.bucketSeconds
  if (seconds === undefined) return ''
  return formatBucketSeconds(seconds)
})

/**
 * 「自动」这一档时，主进程挑中的桶宽正好等于界面上的某一档 —— 就把那一档也标一下
 * （`title` 里说"自动挑的就是这一档"），让"自动"与手动那六档之间的关系看得见。
 * 挑中的桶宽不在那六档里（例如 15 秒）时给 `null`，界面上不加任何标记。
 */
const autoBucketKey = computed(() =>
  trends.granularity === 'auto' ? granularityKeyForSeconds(trends.series?.bucketSeconds) : null
)

/** 颗粒度按钮的悬停说明；自动那一档顺带把实际桶宽写进去。 */
function granularityHint(option: { key: string; seconds: number | null }): string {
  if (option.key === 'auto') {
    return autoBucketText.value
      ? t('granularity.autoHint', { bucket: autoBucketText.value })
      : t('granularity.autoLabel')
  }
  return t('granularity.fixedHint')
}

const selectedDevice = computed(() => devices.byId(selectedDeviceId.value))

/**
 * 这一页的形态（业主 20260921：**三种设备三种页面**）：
 *   · `acousticBox`（声纹）→ 多通道趋势：通道 chips + 每条可见通道一条线
 *     （按设备通道表显示 8 或 2 路；设备没给通道表时兜底 `CHANNEL_COUNT` 路）；
 *   · `acousticCamera`（声学相机）/ `auscultationBox`（空气声呐）→ 单线趋势页：
 *     没有通道 chips，走现有的 fallback 单线 option；
 *   · 其余机型（`pushDevice`）同样没有多通道概念，归到单线那一支。
 *
 * 实现成这一个 computed 而不是拆文件：两种形态共享筛选栏、图表构建与告警卡，
 * 只有"通道有没有"分叉，分叉点全在这一个判据上。
 */
const isMultiChannel = computed(() => selectedDevice.value?.kind === 'acousticBox')

/**
 * 机型标签（页头那一枚徽标）：与设备表同一个来源 —— `domain.deviceKind.*`，
 * `pushDevice` 走 `devicesUi.kindPushDevice`（DevicesView 的 `kindLabel` 同款分支）。
 */
const deviceKindLabel = computed(() => {
  const device = selectedDevice.value
  if (!device) return ''
  return device.kind === 'pushDevice'
    ? t('devicesUi.kindPushDevice')
    : t(`domain.deviceKind.${device.kind}`)
})

/** 历史查询用的通道项：带上状态，未启用/未知都要在文字里标出来。 */
interface ChannelOption {
  index: number
  name: string
  state: ChannelState
}

const channelOptions = computed<ChannelOption[]>(() => {
  /*
   * 单线形态（相机 / 声呐 / 推送设备）：这一页没有"通道"这个概念，**故意**返回空表 ——
   * store 的 `channelIds` 随之清空，查询退回"全部通道聚合"的单序列路径，图上就是
   * 那条 fallback 单线。相机的"通道"是它自己的视频路、声呐的通道表是本地编的一行，
   * 都不是能叠加的声学通道（与 `channelRenameAvailable` 不放开它们是同一条理由）。
   */
  if (!isMultiChannel.value) return []
  const list = devices.channelsOf(selectedDeviceId.value)
  if (list.length > 0) {
    return [...list]
      .sort((left, right) => left.channelIndex - right.channelIndex)
      .map((channel) => ({
        index: channel.channelIndex,
        name: channel.channelName,
        state: channelState(channel)
      }))
  }
  // 设备没返回通道表：状态是“未知”，不能当作“已启用”。
  return Array.from({ length: CHANNEL_COUNT }, (_, index) => ({
    index,
    name: '',
    state: 'unknown'
  }))
})

/**
 * 把通道表灌进 store（它不知道设备有哪些通道）。
 *
 * `immediate: true` 是为了"一进这一页就有图"：`selectedDeviceId` 可能是从地址栏来的，
 * 那时通道表已经在了，但 store 还是空的 —— 只在变化时灌会漏掉第一次。
 */
watch(
  channelOptions,
  (list) => trends.setChannels(list.map((channel) => channel.index)),
  { immediate: true }
)

/**
 * 通道那一排：**一条通道一颗 chip**（业主 2026-09-19 第 13 批第 4 条；20260921 删读数）。
 *
 * 每一行的判据都必须来自**已经取回来的数据**，不能另查一次：
 *   · `hasData` —— 这一段范围里这一路**有没有任何非空时间桶**（选了多个量时，只要有一个量
 *     有数据就算有）。它是"无数据灰显"与"有数据可勾选"的**同一个**判据：两处各算一次，
 *     迟早会出现"灰着但能勾"这种自相矛盾的行；
 *   · `visible` —— 这一路的线画不画（点勾选框切换，与图上那条线同一个颜色来源）。
 *
 * chip 上**只有颜色点 + 通道名**（业主 20260921：删掉每颗 chip 的最后一个读数与
 * 自定义名括号）——"现在哪一路高"在图上直接看得见，数字挤在 chip 上反而把名字截断。
 *
 * `hasData === false` 的行**不许被勾选**：一段范围里没有这一路的读数，勾上它只会得到一条空线，
 * 而空线看起来像"这一路这些值是 0"。
 */
interface TrendChannelRow extends ChannelOption {
  color: string
  visible: boolean
  hasData: boolean
}

const channelRows = computed<TrendChannelRow[]>(() =>
  channelOptions.value.map((channel) => ({
    ...channel,
    color: trendChannelColor(channel.index),
    visible: trends.isChannelVisible(channel.index),
    // 有数据 = 任一**已选中的量**在这一路有至少一个有限值。
    hasData: trends.metrics.some((targetMetric) =>
      (trends.seriesFor(targetMetric, channel.index)?.points ?? []).some((point) =>
        Number.isFinite(point.value)
      )
    )
  }))
)

/** 有数据的那几路（面板上一句"几路有数据"，也是"全部显示"的作用范围）。 */
const channelsWithData = computed(() => channelRows.value.filter((row) => row.hasData).length)

/**
 * 勾选框能不能用：**这一路有数据**。
 *
 * 业主原话就是"无数据灰显、**有数据**可勾选"，所以判据严格是 `hasData`。
 *
 * 想过另一种写法（"没有数据但当前勾着的那一行也保持可用"），理由是"否则会锁死"——
 * 但那是个假问题：**唯一**会变成"不可用"的情形是"这一路在这段范围里没有数据"，
 * 而那时它本来就没有线可画；范围一旦改回有数据的那一段，它自己就恢复可勾了。
 * 反过来，放宽判据会真的伤到业主点名的那条规则：一段没有数据的区间里，
 * 八个勾选框看起来全都能勾，勾上却什么也画不出来。
 */
function channelCheckboxDisabled(row: TrendChannelRow): boolean {
  return !row.hasData
}

/**
 * 这一整段范围里**所有可见通道**都没有数据 —— 只有这时才该显示"这一段没有数据"。
 *
 * 为什么不直接用 store 的 `trends.rangeIsEmpty`：那一个是按**第一条通道**（主量的
 * `series`，即 `channelIds[0]`）算的。设备的历史只落在某一条非首通道上时（真机上见过：
 * 8 路里只有一路有读数），页面会显示"这一段范围里没有数据"，而它右边那一列同时写着
 * "1 / 8 路有数据" —— 同一屏上两句话互相矛盾，且操作员一定会去猜哪一个是真的。
 *
 * 判据改成"可见通道里**没有任何一条**有数据"：与那一列的灰显用的是同一个 `hasData`。
 */
const rangeEmptyForChannels = computed(
  () => trends.rangeIsEmpty && channelsWithData.value === 0
)

// ---------------------------------------------------------------------------
// 重命名（第 13 批第 4 条）
// ---------------------------------------------------------------------------

/**
 * 正在改名的那一路；`null` = 没有在改。
 *
 * 一次只允许改一路：改名要写设备（`/set_passageway`），而设备的写法是
 * "读回全部通道 → 只在被改的行上合并 → 写回"，两路同时改会让两次读回互相覆盖。
 */
const renamingChannel = ref<number | null>(null)
const renameText = ref('')
const renameProblem = ref('')
const renameNotice = ref('')
const renameBusy = ref(false)

/**
 * 这一台能不能改名：必须是**声纹设备**（`acousticBox`）**且在线**。
 *
 * 三条理由，缺一条都不行：
 *   1. 相机的通道是它自己的五路视频，`/get_passageway` 在那台设备上不存在；
 *   2. SN-16 声呐的通道表是我们本地那一行（`refreshChannels` 不去问设备），
 *      改它等于改一个我们自己编的名字；
 *   3. 改名是**写设备**，设备不在线时必然失败 —— 与其让操作员点一次必然失败的按钮，
 *      不如把按钮置灰并说明原因（原因挂在 `title` 上）。
 */
const channelRenameAvailable = computed(
  () =>
    selectedDevice.value?.kind === 'acousticBox' && selectedDevice.value?.status === 'ONLINE'
)

/** 改名按钮的悬停说明：可用时说"改什么"，不可用时说"为什么不能改"。 */
const channelRenameHint = computed(() =>
  channelRenameAvailable.value
    ? t('trendsUi.channelRenameHint')
    : t('trendsUi.channelRenameOffline')
)

function startChannelRename(row: TrendChannelRow): void {
  if (!channelRenameAvailable.value) return
  renamingChannel.value = row.index
  renameText.value = row.name
  renameProblem.value = ''
  renameNotice.value = ''
}

function cancelChannelRename(): void {
  renamingChannel.value = null
  renameText.value = ''
  renameProblem.value = ''
}

/**
 * 提交改名：先在本地判（`normaliseChannelName`，可单测），再写设备，再刷新缓存。
 *
 * 缓存刷新是**必须**的一步：这一列的名字来自 `devices.channelsOf()`（我们库里那份，
 * 由 `refreshChannels()` 从设备读回来），而改名走的是设备配置那条路 ——
 * 不重新读一次，这一页会继续显示旧名字（"改成功了但界面上没变"）。
 */
async function submitChannelRename(): Promise<void> {
  const index = renamingChannel.value
  if (index === null) return
  const current = channelOptions.value.find((channel) => channel.index === index)?.name ?? ''
  const verdict = normaliseChannelName(renameText.value, current)
  if (!verdict.ok) {
    // `count` 只被 `channelNameError_tooLong` 用；多传一个参数对其余两条无害。
    renameProblem.value = t(CHANNEL_NAME_PROBLEM_KEYS[verdict.problem], {
      count: CHANNEL_NAME_MAX_LENGTH
    })
    return
  }

  renameProblem.value = ''
  renameBusy.value = true
  const updated = await deviceConfig.updateChannel(selectedDeviceId.value, index, {
    name: verdict.value
  })
  renameBusy.value = false
  if (!updated) {
    // 设备的原话优先（可能是它自己的长度/字符限制，我们编不出来）。
    renameProblem.value = deviceConfig.error || t('trendsUi.channelRenameFailed')
    return
  }

  renamingChannel.value = null
  renameText.value = ''
  await devices.loadChannels(selectedDeviceId.value, true)
  renameNotice.value = t('trendsUi.channelRenamed', { channel: channelLabel(index) })
}

/** 勾选框切换：只改"画哪几条线"，不重新查库（数据已经一次全取回来了）。 */
function toggleChannelRow(row: TrendChannelRow): void {
  if (channelCheckboxDisabled(row)) return
  trends.toggleChannel(row.index)
}

/** 通道 chip 的悬停说明：这一路现在画不画（点一下会变成另一句）。 */
function channelChipHint(row: TrendChannelRow): string {
  return row.visible ? t('trendsUi.channelHide') : t('trendsUi.channelShow')
}


const customRangeIncomplete = computed(
  () =>
    trends.range === 'custom' &&
    (trends.customFrom === undefined || trends.customTo === undefined)
)

/** 数据实际覆盖的范围（空态那个"查看可用范围"按钮要用它）。 */
const coverageText = computed(() => {
  const bounds = trends.coverageBounds
  if (!bounds) return ''
  return `${formatDateTime(bounds.from)} ~ ${formatDateTime(bounds.to)}`
})

// ---------------------------------------------------------------------------
// Chart data
// ---------------------------------------------------------------------------

interface TrendChartRow {
  /** 这个桶的起点（epoch ms）—— 时间轴上的 X。 */
  timestamp: number
  /** Short axis tick, chosen from the span. */
  label: string
  /** Full timestamp for the tooltip and the summary tiles. */
  fullLabel: string
  /** `null` = the device reported nothing in this bucket. Never 0. */
  value: number | null
  sampleCount: number
}

const spanMs = computed(() => {
  const from = trends.queriedFrom
  const to = trends.queriedTo
  if (from === null || to === null) return 0
  return Math.max(0, to - from)
})

const chartRows = computed<TrendChartRow[]>(() =>
  trends.points.map((point) => ({
    timestamp: point.timestamp,
    label: formatTrendTick(point.timestamp, spanMs.value),
    fullLabel: formatDateTime(point.timestamp),
    // Rule 3: NaN means "not reported here" and must become a gap.
    value: Number.isFinite(point.value) ? point.value : null,
    sampleCount: point.sampleCount
  }))
)

/**
 * 一张图的全部输入：一个量 + 这个设备的每条**可见**通道。
 *
 * 时间轴用**所有通道并集**的时间戳（`timestamps`）：各通道的桶边界由主进程按同一个
 * from/to 与同一个 `bucketSeconds` 选出，正常情况下是一致的；用并集是为了在某个通道
 * 少几个桶时，其余通道的线**不会整体错位半格**（错位会让两条线看起来差了一个采样周期）。
 */
interface TrendChartBundle {
  metric: TrendMetric
  /** 时间轴标签（与 `timestamps` 同序）。 */
  labels: string[]
  /** 完整时间戳（提示里用）。 */
  timestamps: number[]
  /** 每条可见通道一行数据（与 `labels` 同序，缺口是 `null`）。 */
  lines: { index: number; name: string; color: string; values: (number | null)[] }[]
  /** 这一张图上有没有任何非空值（没有时画布给一句空态，而不是一根空轴）。 */
  hasValue: boolean
  /** 每条可见通道在范围内报了几个时间桶（诊断与提示里用）。 */
  gapCount: number
}

function buildBundle(targetMetric: TrendMetric): TrendChartBundle {
  const seriesList = trends.visibleChannelIds.map((index) => ({
    index,
    series: trends.seriesFor(targetMetric, index)
  }))

  // 时间戳并集，升序。
  const stampSet = new Set<number>()
  for (const entry of seriesList) {
    for (const point of entry.series?.points ?? []) stampSet.add(point.timestamp)
  }
  const timestamps = [...stampSet].sort((left, right) => left - right)
  const labels = timestamps.map((stamp) => formatTrendTick(stamp, spanMs.value))

  const lines = seriesList.map((entry) => {
    const byStamp = new Map<number, number>()
    for (const point of entry.series?.points ?? []) {
      byStamp.set(point.timestamp, Number.isFinite(point.value) ? point.value : NaN)
    }
    const channel = channelOptions.value.find((item) => item.index === entry.index)
    return {
      index: entry.index,
      // 图例/提示里的名字用**通道名**（有就用，没有就用通道号），与图例那一行一致。
      name: channel?.name ? `${channelLabel(entry.index)}（${channel.name}）` : channelLabel(entry.index),
      color: trendChannelColor(entry.index),
      values: timestamps.map((stamp) => {
        const value = byStamp.get(stamp)
        // 缺口（没报这个桶）保持 null：绝不画成 0。
        return value === undefined || Number.isNaN(value) ? null : value
      })
    }
  })

  let gapCount = 0
  for (const line of lines) {
    for (const value of line.values) if (value === null) gapCount += 1
  }

  return {
    metric: targetMetric,
    labels,
    timestamps,
    lines,
    hasValue: lines.some((line) => line.values.some((value) => value !== null)),
    gapCount
  }
}

/**
 * 每个选中的量一张图（业主追加要求：多个量同时显示），**按 `metricOrder` 排**
 * （chips 拖出来的顺序就是图自上而下的顺序）。模板里 `:key="bundle.metric"`，
 * 换位只是移动 DOM，图实例与缩放窗口都跟着各自的量走。
 */
const chartBundles = computed<TrendChartBundle[]>(() =>
  orderedSelectedMetrics.value.map((item) => buildBundle(item))
)

/**
 * 每一张图的 ECharts 选项，**做成 computed**。
 *
 * 为什么不能直接在模板里调 `chartOptionFor(bundle)`：那样每次重渲染都会造一个新对象，
 * 而 `EChart.vue` 监听的是选项的**引用**（`watch(() => props.option)`）—— 一次与图无关的
 * 重渲染（勾一个通道、切一个量、诊断行刷新）都会变成一次 `setOption(option, true)`，
 * 那会**把用户刚做的缩放丢掉**，而丢掉之后又发一次 `dataZoom` 事件……第 27 轮第一版就是
 * 这样转成了一个死循环（探针整段 150 秒超时）。computed 只在真正的输入变化时重算。
 */
const chartOptions = computed<Record<string, EChartsCoreOption>>(() => {
  const map: Record<string, EChartsCoreOption> = {}
  for (const bundle of chartBundles.value) {
    map[bundle.metric] = chartOptionFor(bundle)
  }
  return map
})

/**
 * ECharts tooltip。`params` 的类型是 `unknown`，在这里就地收窄：选项对象是宽松类型的
 * `EChartsCoreOption`，而"这个桶里有几个采样点"从 bundle 里按索引读，序列数据因此可以
 * 保持成纯数字数组。
 *
 * 一个桶里**每条可见通道一行**：这正是"多条通道叠在一根轴上"之后提示要回答的问题
 * —— 同一个时刻，八条通道各是多少。
 */
interface TrendTooltipParam {
  dataIndex: number
  seriesName?: string
}

function trendTooltipFor(bundle: TrendChartBundle) {
  return (params: unknown): string => {
    const list = Array.isArray(params)
      ? (params as TrendTooltipParam[])
      : [params as TrendTooltipParam]
    const first = list[0]
    if (!first) return ''
    const stamp = bundle.timestamps[first.dataIndex]
    if (stamp === undefined) return ''

    const head = `<div style="font-weight:600">${formatDateTime(stamp)}</div>`
    const title = `${trendMetricLabel(bundle.metric)}（${trendAggregationLabel(trends.aggregation)}）`
    const rows = bundle.lines
      .filter((line) => line.values[first.dataIndex] !== undefined)
      .map((line) => {
        const value = line.values[first.dataIndex] ?? null
        const text =
          value === null
            ? t('trendsUi.noDataInBucket', { value: EMPTY_VALUE })
            : trendValueText(bundle.metric, value)
        // 色块与图上那条线同一个颜色：多通道时提示里也必须一眼对上是哪一条。
        return (
          `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;` +
          `background:${line.color};margin-right:5px"></span>${line.name}：${text}`
        )
      })
    return [head, title, ...rows].join('<br/>')
  }
}

/**
 * ECharts draws to a canvas, so it cannot read the CSS custom properties in
 * `main.css`; these four constants mirror those tokens (same approach as
 * MonitorView).
 */
const AXIS_LINE = '#E5E7EB'
const SPLIT_LINE = '#F1F1F2'
const TEXT_SECONDARY = '#6B7280'

/**
 * 一个量一张图。**每条可见通道一条线**，颜色来自 `trendChannelColor`（与图例同一个来源），
 * 全部落在**同一根坐标轴**上 —— 这正是业主那句"用不同颜色的折线将多个通道的信号显示在
 * 同一个坐标轴上"。
 *
 * 「不知道通道」时（设备没返回通道表）`visibleChannelIds` 是空的，`bundle.lines` 也就是空的；
 * 那条情况仍然由 `series` 画一条聚合线（见下面的 `fallbackOption`）。
 */
function chartOptionFor(bundle: TrendChartBundle): EChartsCoreOption {
  const meta = TREND_METRIC_META[bundle.metric]
  const axisName = trendAxisName(bundle.metric, trends.aggregation)
  const tickFormatter = meta.tickFormatter
  const pointCount = bundle.labels.length
  /*
   * Y 轴范围（业主第 5 条：「声压级 Y 轴 0–100 dB」）。
   *
   * `trendAxisRange()` 只对声压级给出 0–100，其余的量返回空对象 —— 空对象时 `scale: true`
   * 让 ECharts 按数据自适应（第 6 条要的"Y 轴弹性变化"就是这一支）。
   * **固定了 min/max 就不能再开 `scale`**：ECharts 的 `scale` 只在没给 min/max 时有意义，
   * 一起给会被读成"作者想要弹性"，而图上是 0–100 —— 那种半对的状态最难查。
   */
  const range = trendAxisRange(bundle.metric)
  const fixedRange = range.min !== undefined || range.max !== undefined

  return {
    // Real measurements, not a dashboard toy: an animated line implies the data
    // is live and makes a bucket boundary impossible to read.
    animation: false,
    // 底边留出滑块的位置（`trendDataZoom()` 里那条 `slider` 高 18、贴底 4）。
    grid: { left: 58, right: 18, top: 34, bottom: 52 },
    /*
     * 时间轴缩放（第 13 批第 6 条：「所有折线图支持时间轴放大缩小」）。
     * `filterMode: 'filter'` 同时把"Y 轴弹性变化"接到缩放上：放大之后 Y 轴按可见的那一段重算。
     * `zoomWindow.value` 也传进去 —— 重画时窗口跟着选项走，不会被 `setOption(option, true)` 丢掉。
     */
    dataZoom: trendDataZoom(zoomWindow.value ?? undefined),
    tooltip: { trigger: 'axis', formatter: trendTooltipFor(bundle) },
    // ECharts 自带的图例在这里**关掉**：图例是页面上的那一列通道（点一下切换
    // 显示/隐藏），两处各画一份的话，用户会看到两个"看起来一样但行为不同"的图例。
    legend: { show: false },
    /*
     * **X 轴是时间轴**（业主 2026-09-19 最新一条第 5 条：「曲线需要画一个坐标轴，
     * 应该是时间轴作为X轴，支持这个轴上的时间区域选择，放大，缩小的操作」）。
     *
     * 之前是 `type: 'category'`：刻度是我们把时间戳格式化成的**字符串**，于是
     * "没有数据的时段"会被挤掉（两个相邻的点永远挨在一起），区域选择也只能按"第几格"。
     * 换成 `time` 之后：数据点带上时间戳，轴按**真实时间**排布 —— 空桶占它该占的宽度，
     * `dataZoom` 报的窗口是 `startValue`/`endValue`（时间戳），这才是"时间区域选择"。
     */
    xAxis: {
      type: 'time',
      // 时间轴的刻度由 ECharts 按跨度自己排（秒/分/时/天），不再用我们的 `formatTrendTick`。
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisTick: { show: false },
      axisLabel: { color: TEXT_SECONDARY, fontSize: 10, hideOverlap: true }
    },
    yAxis: {
      // The aggregation belongs IN the axis name: the same metric aggregated as
      // 平均 and as 95分位 are two different measurements.
      name: axisName,
      type: 'value',
      scale: !fixedRange,
      ...(range.min !== undefined ? { min: range.min } : {}),
      ...(range.max !== undefined ? { max: range.max } : {}),
      nameTextStyle: { color: TEXT_SECONDARY, fontSize: 10, align: 'left' },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: TEXT_SECONDARY,
        fontSize: 10,
        ...(tickFormatter ? { formatter: tickFormatter } : {})
      },
      splitLine: { lineStyle: { color: SPLIT_LINE } }
    },
    series: bundle.lines.map((line) => ({
      name: line.name,
      type: 'line',
      // Symbols are only drawn on a series short enough that an isolated
      // bucket would otherwise be invisible; a 500-point line stays clean.
      showSymbol: pointCount <= 300,
      symbolSize: 3,
      // Gaps stay gaps: never bridge across a bucket the device did not report.
      connectNulls: false,
      // 时间轴上每一点是 `[时间戳, 值]`；`null` 仍然是缺口（不画成 0）。
      data: bundle.timestamps.map((stamp, index) => [stamp, line.values[index] ?? null]),
      lineStyle: { width: 1.6, color: line.color },
      itemStyle: { color: line.color }
    }))
  }
}

/**
 * 「设备没返回通道表」时那一条线（原来的单序列行为）。
 *
 * 保留它是因为那种设备上**没有可叠加的通道**，而"一条聚合线"仍然回答了"这段时间怎么样"。
 */
const fallbackOption = computed<EChartsCoreOption>(() => {
  const rows = chartRows.value
  const meta = TREND_METRIC_META[trends.metric]
  const axisName = trendAxisName(trends.metric, trends.aggregation)
  const tickFormatter = meta.tickFormatter
  // 与多通道那几张图**同一把尺子**：声压级固定 0–100，其余的量交给 ECharts 自适应。
  const range = trendAxisRange(trends.metric)
  const fixedRange = range.min !== undefined || range.max !== undefined

  return {
    animation: false,
    grid: { left: 58, right: 18, top: 34, bottom: 52 },
    // 回退那条单序列图**同样**能缩放（"所有折线图"这句话不该有例外）。
    dataZoom: trendDataZoom(zoomWindow.value ?? undefined),
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown): string => {
        const list = Array.isArray(params)
          ? (params as TrendTooltipParam[])
          : [params as TrendTooltipParam]
        const first = list[0]
        if (!first) return ''
        const row = rows[first.dataIndex]
        if (!row) return ''
        const valueText =
          row.value === null
            ? t('trendsUi.noDataInBucket', { value: EMPTY_VALUE })
            : trendValueText(trends.metric, row.value)
        return [
          `<div style="font-weight:600">${row.fullLabel}</div>`,
          `${trendMetricLabel(trends.metric)}（${trendAggregationLabel(trends.aggregation)}）：${valueText}`,
          t('trendsUi.sampleCount', { count: row.sampleCount })
        ].join('<br/>')
      }
    },
    legend: { show: false },
    // 回退那张单序列图**同样**是时间轴（"所有折线图"这句话不该有例外）。
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisTick: { show: false },
      axisLabel: { color: TEXT_SECONDARY, fontSize: 10, hideOverlap: true }
    },
    yAxis: {
      name: axisName,
      type: 'value',
      scale: !fixedRange,
      ...(range.min !== undefined ? { min: range.min } : {}),
      ...(range.max !== undefined ? { max: range.max } : {}),
      nameTextStyle: { color: TEXT_SECONDARY, fontSize: 10, align: 'left' },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: TEXT_SECONDARY,
        fontSize: 10,
        ...(tickFormatter ? { formatter: tickFormatter } : {})
      },
      splitLine: { lineStyle: { color: SPLIT_LINE } }
    },
    series: [
      {
        name: axisName,
        type: 'line',
        showSymbol: rows.length <= 300,
        symbolSize: 3,
        connectNulls: false,
        // 时间轴：`[时间戳, 值]`（缺口仍然是 null）。
        data: rows.map((row) => [row.timestamp, row.value]),
        lineStyle: { width: 1.6, color: trendChannelColor(0) },
        itemStyle: { color: trendChannelColor(0) }
      }
    ]
  }
})

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * 「上面那四张时间桶卡片删掉了」（业主 2026-09-19 第 13 批第 5 条：
 * 「声压级那四张卡片删除；只显示趋势曲线」）。
// 时间轴缩放（第 13 批第 6 条）
// ---------------------------------------------------------------------------

/**
 * 当前的时间轴缩放窗口（百分比）。
 *
 * `null` = 没有缩放（整段）。它是**每一张图各自**的事件，但这一页上只有一个"当前窗口"：
 * 多张图的分桶完全相同（同一次查询、同一批时间戳），所以任何一张图上的缩放对整页都成立
 * —— 分别记的话，两张图会显示出两个不同的时间窗口，而它们画的是同一批数据。
 */
const zoomWindow = ref<{
  start: number
  end: number
  startValue: number | null
  endValue: number | null
} | null>(null)

/** 正在缩放的是哪一张图（重置时只需要重置这一张：其余的窗口本来就是同一段）。 */
const zoomedChart = ref<string | null>(null)

/**
 * **上一次把缩放窗口写进选项的时刻**（`Date.now()`；不放进 `ref` —— 它不参与渲染）。
 *
 * 用途只有一个：`dataZoom` 事件里分辨"用户缩放"与"我们写选项的回声"。
 * 判据与理由写在 `trendZoomShouldRecord()`（`@shared/domain/trend`）的注释里。
 */
let zoomWrittenAt = 0

/** 我们**最后一次写进选项**的那个窗口（`null` = 写的是"整段"）。见 `trendZoomShouldRecord()`。 */
let zoomWriteTarget: { start: number; end: number } | null = null

/** 最近接受过缩放的时刻（安全阀：2 秒内太多次就停手，见 `trendZoomBurstExceeded()`）。 */
let zoomAcceptedAt: number[] = []

/**
 * 每张图的实例（`resetZoom` 用）。
 *
 * ⚠ **故意不是 `ref`**（2026-09-20 定位到的那条死循环的**根治**）。
 *
 * 模板里是 `:ref="(instance) => setChartRef(bundle.metric, instance)"` —— 这个内联箭头
 * **每次渲染都是一个新的函数**，于是 Vue 在**每次 patch** 时都会先拿 `null` 调一次旧箭头、
 * 再拿实例调一次新箭头。原来这里写的是 `chartRefs.value = { ...chartRefs.value, … }`：
 * 一次 `ref` 的**读 + 写**，而 patch 发生在组件自己的更新里 —— 于是这条更新**又把自己排进队列**，
 * 生产构建里 Vue 没有"递归更新"的保护，`flushJobs` 的队列因此永远清不空：
 * 一个核心占满、页面里的定时器被饿死、`executeJavaScript` 再也不 settle
 * （探针看到的就是"渲染进程不响应"，第 28–35 轮全栽在这上面）。
 *
 * 第 36 轮的二分把这一条钉死了：**去掉这个 `:ref` 回调、其他一切不变**（ECharts 照旧挂载、
 * 图照旧画出来 `chartCanvas = 1127x320`），卡死消失、七支探针全部跑完（心跳 204 条）。
 *
 * 所以实例放在一个**普通对象**里：`resetZoom()` 读它（事件处理器，不参与渲染追踪），
 * 而 patch 期间写一个普通对象**不会触发任何 effect**。图表的 ref 本来也不需要是响应式的
 * —— 它唯一的用途就是"重置缩放时把实例找出来"。
 */
const chartInstances: Record<string, { resetZoom: () => void } | null> = {}

function setChartRef(metric: string, instance: unknown): void {
  chartInstances[metric] = instance as { resetZoom: () => void } | null
}

/** 回退那张单序列图的实例（同一个重置动作要能收上它）。同样**不是 `ref`**（理由同上）。 */
let fallbackChartInstance: { resetZoom: () => void } | null = null

function setFallbackChartRef(instance: unknown): void {
  fallbackChartInstance = instance as { resetZoom: () => void } | null
}

/**
 * 缩放之后可见的时间桶区间。
 *
 * **优先用时间戳**（`startValue`/`endValue`）：时间轴上 ECharts 报的就是时间，
 * 换算成下标只为了一句"第 a–b 个点"。拿不到时间戳时退回百分比（类目轴/旧版本）。
 */
const zoomRange = computed(() => {
  const window = zoomWindow.value
  if (!window) return null
  const primary = chartBundles.value[0]
  if (!primary) return null
  if (window.startValue !== null && window.endValue !== null) {
    return trendZoomIndexRange(primary.timestamps, window.startValue, window.endValue)
  }
  return trendZoomWindow(primary.timestamps.length, window.start, window.end)
})

/** 缩放之后那一段的时间范围（提示里要写出来：只写"第几个点"没人看得懂）。 */
const zoomRangeText = computed(() => {
  const range = zoomRange.value
  const primary = chartBundles.value[0]
  if (!range || !primary) return ''
  const from = primary.timestamps[range.fromIndex]
  const to = primary.timestamps[range.toIndex]
  if (from === undefined || to === undefined) return ''
  return `${formatDateTime(from)} ~ ${formatDateTime(to)}`
})

/** 显示"当前显示 a–b / 共 n 点"；没有缩放时是空串（不多说一句废话）。 */
const zoomHint = computed(() => {
  const range = zoomRange.value
  const primary = chartBundles.value[0]
  if (!range || !primary) return ''
  return t('trendsUi.zoomHint', {
    from: range.fromIndex + 1,
    to: range.toIndex + 1,
    total: primary.timestamps.length,
    range: zoomRangeText.value
  })
})

function onChartZoom(
  metric: string,
  window: {
    start: number
    end: number
    startValue: number | null
    endValue: number | null
    userDriven?: boolean
  }
): void {
  /*
   * ── 第一条判据：**只有用户手势引起的缩放才记**（2026-09-20 定位到的那条死循环的根治）──
   *
   * 我们写进选项的窗口，ECharts 应用之后会**再发一次** `dataZoom`（形状与用户缩放一模一样），
   * 于是"事件 → 改状态 → 重算选项 → `setOption` → 事件"会一直转：一个核心被占满、
   * 页面里的定时器被饿死、`executeJavaScript` 再也不 settle（探针里就是"渲染进程不响应"）。
   * 前两条判据（"刚写过选项"的时间窗、"与最后写进去的窗口相同"）都是**猜回声什么时候来**，
   * 30x 的实测里总差一点点（`probe-round41.log`：安全阀一次没触发，因为它恰好转在
   * 2 秒 8 次的门槛之下）。真正的判据是**来源**：`EChart.vue` 在图上捕获滚轮/按下，
   * 一次手势只让**一条**事件带上 `userDriven` —— 回声永远不可能是用户驱动的。
   */
  if (window.userDriven !== true) return
  const msSinceWrite = Date.now() - zoomWrittenAt
  if (!trendZoomShouldRecord(zoomWindow.value, window, msSinceWrite, zoomWriteTarget)) return
  /*
   * 安全阀（第 33 轮）：2 秒内接受太多次就不再接受 —— 任何残余的反馈环最多转这么多圈。
   * 触发时报一句（不静默）：这一句同时也是"环还在"的证据。
   */
  if (trendZoomBurstExceeded(zoomAcceptedAt, Date.now())) {
    // 开发/诊断用的一句（**不是界面文案**，所以不走四语言目录：i18n 扫描器只允许英文）。
    console.warn('[trends] dataZoom events too dense; ignoring further ones (feedback loop?)')
    return
  }
  const next = trendZoomIsIdentity(window.start, window.end) ? null : window
  zoomWindow.value = next
  // 记下"刚刚写过选项"的时刻与目标窗口：接下来那些 `dataZoom` 都是回声（见纯函数的注释）。
  zoomWrittenAt = Date.now()
  zoomWriteTarget = next
  zoomAcceptedAt = [...zoomAcceptedAt.filter((stamp) => Date.now() - stamp < 2_000), Date.now()]
  zoomedChart.value = next === null ? null : metric
}

/**
 * 「重置缩放」：把**所有**图的时间轴拉回整段。
 *
 * 每一张图都重置（不是只重置正在缩放的那一张）：它们的窗口本来就是同一段，
 * 只重置一张会让两张图看起来在显示不同的时间范围。
 */
function resetZoom(): void {
  for (const instance of Object.values(chartInstances)) instance?.resetZoom()
  fallbackChartInstance?.resetZoom()
  zoomWindow.value = null
  zoomedChart.value = null
  // 清窗口也是一次"我们改了选项"：接下来那几毫秒的 `dataZoom` 同样是回声。
  zoomWrittenAt = Date.now()
  zoomWriteTarget = null
}

// ---------------------------------------------------------------------------
// 数据导出（第 13 批第 6 条：「支持数据导出」）
// ---------------------------------------------------------------------------

const exporting = ref(false)
const exportNotice = ref('')
const exportError = ref('')

/**
 * 把**当前这一屏查到的**数据导成 CSV。
 *
 * 导出的是"看得见的那些通道"：显式隐藏的通道不进文件 —— 文件要能对上屏幕
 * （"我隐藏了 CH3，导出来却有它"和"屏幕上有它、文件里没有"一样糟）。
 * 每一行的单位、通道名都跟着走（见 `@shared/domain/trend-export.ts` 的文件头）。
 */
async function exportCsv(): Promise<void> {
  exportNotice.value = ''
  exportError.value = ''
  const device = selectedDevice.value
  const from = trends.queriedFrom
  const to = trends.queriedTo
  if (!device || from === null || to === null) {
    exportError.value = t('trendsUi.exportNothing')
    return
  }

  const rows = buildExportRows(from, to)
  if (rows.length === 0) {
    // 一行都没有时**不写空文件**：一个只有表头的文件看起来像"导成功了但数据是空的"。
    exportError.value = t('trendsUi.exportNothing')
    return
  }

  exporting.value = true
  const result = await callApi(() =>
    window.api.trends.exportCsv({
      fileName: trendCsvFileName({ deviceName: device.name, from, to }),
      csv: buildTrendCsv(rows)
    })
  )
  exporting.value = false
  if (!result.success) {
    exportError.value = resultMessage(result)
    return
  }
  const info = unwrap(result)
  if (!info) {
    exportError.value = t('trendsUi.exportFailed')
    return
  }
  // 报的是**读回核对过**的字节数与行数（不是"我们以为写了多少"）。
  exportNotice.value = t('trendsUi.exportDone', {
    path: info.path,
    rows: info.rows,
    bytes: formatBytes(info.bytes)
  })
}

/** 把叠加的那几组序列摊成一行一个读数（长表，见 `trend-export.ts`）。 */
function buildExportRows(from: number, to: number): TrendExportRow[] {
  const rows: TrendExportRow[] = []
  for (const targetMetric of trends.metrics) {
    const meta = TREND_METRIC_META[targetMetric]
    for (const channel of trends.visibleChannelIds) {
      const series = trends.seriesFor(targetMetric, channel)
      if (!series) continue
      const name = channelOptions.value.find((item) => item.index === channel)?.name ?? ''
      for (const point of series.points) {
        // 空桶不进文件（见 `buildTrendCsv`）：CSV 里没有"空桶"这个概念。
        if (!Number.isFinite(point.value)) continue
        if (point.timestamp < from || point.timestamp > to) continue
        rows.push({
          timestamp: point.timestamp,
          metric: targetMetric,
          channel,
          channelName: name,
          value: point.value,
          sampleCount: point.sampleCount,
          unit: meta.unit
        })
      }
    }
  }
  // 按时间、再按量、再按通道排序：一份给人看的文件不该是"按查询顺序"拼出来的。
  // 量的顺序固定用 `TREND_METRIC` 目录顺序（与文件怎么排无关，与页面上那排 chips 当前的
  // 拖拽顺序也无关 —— CSV 是一份证据，顺序要稳定、可复现）。
  const exportMetricOrder = TREND_METRIC_OPTIONS.map((option) => option.key)
  return rows.sort(
    (left, right) =>
      left.timestamp - right.timestamp ||
      exportMetricOrder.indexOf(left.metric) - exportMetricOrder.indexOf(right.metric) ||
      left.channel - right.channel
  )
}

/**
 * 打印（Chromium 的打印对话框里可以"另存为 PDF"，所以这就是"打印为 PDF"）。
 *
 * 为什么用 `window.print()` 而不是主进程的 `printToPDF`：后者需要渲染层把整页的
 * 版式交给主进程再拼一份 PDF，而 `window.print()` 用的是**操作员眼前那一页**
 * （配合 `@media print` 把导航与筛选条收起来）。它也不需要新权限、新依赖。
 */
function printCharts(): void {
  window.print()
}


const chartPlaceholder = computed(() => {
  if (trends.series !== null) return ''
  if (trends.loading) return t('trendsUi.loadingNotice')
  if (!selectedDeviceId.value) return ''
  return t('trendsUi.noDataNotice')
})

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

const hasNoDevice = computed(() => devices.devices.length === 0)
const noDeviceSelected = computed(() => !hasNoDevice.value && !selectedDeviceId.value)

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Re-read coverage (it grows while monitoring runs), then query immediately. */
async function refresh(): Promise<void> {
  if (!selectedDeviceId.value) return
  notice.value = ''
  await trends.loadCoverage()
  trends.query({ immediate: true })
}

/** Jump to the range the stored data actually covers (the empty-state action). */
function useCoverageRange(): void {
  const bounds = trends.coverageBounds
  if (!bounds) return
  notice.value = ''
  trends.setCustomRange(bounds.from, bounds.to)
}

function applyCustomRange(): void {
  trends.customFrom = fromDateTimeLocalValue(customFromText.value)
  trends.customTo = fromDateTimeLocalValue(customToText.value)
  // Debounced: a date picker emits one input event per keystroke, and every one
  // of them would otherwise become a DuckDB scan.
  trends.query()
}

// ---------------------------------------------------------------------------
// 时间段告警（业主 20260921：图表下方列出当前筛选范围内的告警）
// ---------------------------------------------------------------------------

/**
 * 「图上这一段」里报过的告警，最多 50 条，紧凑列表（时间 / 等级 / 一行标题 / 确认状态）。
 * 只挂在**这个页面自己的状态**上：不动 alarms store —— 那边的 `query` 状态属于告警中心
 * 那张表，从这里改它，两边会在同一组字段上互相覆盖。
 */
const rangeAlarms = ref<AlarmEvent[]>([])
const rangeAlarmsLoading = ref(false)
/** 查询失败时的那句原文；空串 = 没有失败（家规：失败不留哑）。 */
const rangeAlarmsError = ref('')
/** 单调递增令牌：设备 / 范围变得快时，旧响应不许覆盖新列表。 */
let rangeAlarmsSeq = 0

/**
 * 按**当前选中设备 + 上一次趋势查询真正发出去的边界**重查告警。
 *
 * from/to 用 `trends.queriedFrom/queriedTo` 而不是筛选框的当前值：告警卡要回答的是
 * "图上这一段里发生了什么"，图与告警必须是**同一段**，否则两行话说的是两个范围。
 * `alarms.query` 的 from/to 是 epoch ms、含端点（inclusive，与趋势查询同一把尺子）。
 */
async function loadRangeAlarms(): Promise<void> {
  const seq = (rangeAlarmsSeq += 1)
  const deviceId = selectedDeviceId.value
  const from = trends.queriedFrom
  const to = trends.queriedTo
  if (!deviceId || from === null || to === null) {
    rangeAlarms.value = []
    rangeAlarmsError.value = ''
    return
  }
  rangeAlarmsLoading.value = true
  const result = await callApi(() =>
    window.api.alarms.query({ deviceId, from, to, limit: 50 })
  )
  // 这次查询已经过时（设备或范围又变了）：丢弃，不许写回。
  if (seq !== rangeAlarmsSeq) return
  rangeAlarmsLoading.value = false
  if (!result.success) {
    rangeAlarms.value = []
    rangeAlarmsError.value = resultMessage(result)
    return
  }
  rangeAlarmsError.value = ''
  rangeAlarms.value = unwrap(result)?.items ?? []
}

/**
 * 随设备 / 时间范围自动重查：`queriedFrom/To` 是趋势查询**落地之后**才更新的，
 * 所以趋势每次查完（预设切换、颗粒度切换、自定义范围提交、换设备）这一张卡跟着补一次；
 * 自定义范围没填完时不触发趋势查询，`queried*` 不变，这里也不会动。
 */
watch([selectedDeviceId, () => trends.queriedFrom, () => trends.queriedTo], () => {
  void loadRangeAlarms()
})

/** 一行告警的标题：设备自己给的原因文本优先，其次解码故障位图（与告警中心同一套翻译）。 */
function rangeAlarmTitle(alarm: AlarmEvent): string {
  const reason = alarm.deviceReason?.trim()
  return reason !== undefined && reason !== '' ? reason : describeAlarmMask(alarm.alarmMask)
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

onMounted(async () => {
  if (devices.devices.length === 0) await devices.load()

  const queryDevice = typeof route.query.device === 'string' ? route.query.device : ''
  const candidate = queryDevice || devices.selectedDeviceId || devices.devices[0]?.id || ''

  customFromText.value = toDateTimeLocalValue(trends.customFrom)
  customToText.value = toDateTimeLocalValue(trends.customTo)

  // Assigning the selection drives the SAME watcher a manual switch uses, so the
  // mount path and the switch path cannot drift apart — and the first load
  // happens exactly once instead of once per path.
  selectedDeviceId.value = candidate
})

watch(selectedDeviceId, (id) => {
  if (!id) return
  notice.value = ''
  devices.select(id)
  void devices.loadChannels(id)
  void trends.load(id)
  void router.replace({ path: '/trends', query: { ...route.query, device: id } })
})

// Keep the date inputs in step when the bounds change from outside them (the
// coverage shortcut, or a preset switch). Values typed by the user always parse
// back to themselves, so this cannot fight with typing.
watch(
  () => trends.customFrom,
  (value) => {
    const text = toDateTimeLocalValue(value)
    if (text !== customFromText.value) customFromText.value = text
  }
)

watch(
  () => trends.customTo,
  (value) => {
    const text = toDateTimeLocalValue(value)
    if (text !== customToText.value) customToText.value = text
  }
)

/**
 * The page owns no subscription, so there is nothing to release on unmount —
 * this is request/response only (see the store header). The one thing worth
 * cancelling is a pending debounce: it would otherwise fire a DuckDB query for a
 * page the user has already left. The loaded series is kept, so returning to the
 * page shows the last result immediately instead of an empty chart.
 */
onUnmounted(() => {
  trends.cancelPendingQuery()
})

/**
 * 顶栏那颗唯一的刷新（业主 2026-09-19 更正第 4 条）：页面里那颗「刷新」删掉之后，
 * 重查当前筛选条件这件事由它触发。`refresh()` 里做的正是原来那颗按钮做的事。
 */
watch(
  () => uiRefresh.tick,
  () => refresh()
)
</script>

<template>
  <div class="page">
    <!--
      这一页**没有页头**：外层框架的标题栏已经写了「历史趋势」。设备下拉按业主 20260921
      的要求搬进顶栏那一格（照 MonitorView 的 `Teleport` 先例，含 `.topbar-device` 样式）；
      「立即落盘」那一颗按钮同一批删掉（store 的 `flush()` 与 IPC 保留，设置页仍在用）。
    -->

    <p v-if="notice" class="alert alert--success" role="status">{{ notice }}</p>
    <p v-if="trends.error" class="alert alert--danger" role="alert">{{ trends.error }}</p>

    <EmptyState
      v-if="hasNoDevice"
      :title="t('trendsUi.noDeviceTitle')"
    >
      <RouterLink class="btn btn--primary" to="/devices">{{ t('trendsUi.goToDevices') }}</RouterLink>
    </EmptyState>

    <template v-else>
      <!--
        设备下拉**不在筛选栏里**：它被投到顶栏那一格（`#topbar-page-slot`），
        写法与样式照 MonitorView（业主 20260921：设备选择搬进标题栏）。
        `scoped` 样式对 Teleport 出去的内容仍然生效（Vue 给它们带上同一个 scope 属性）。
      -->
      <Teleport to="#topbar-page-slot">
        <label class="field topbar-device">
          <select
            v-model="selectedDeviceId"
            class="select"
            :aria-label="t('trendsUi.filterDevice')"
            :title="t('trendsUi.filterDevice')"
          >
            <option v-for="device in devices.devices" :key="device.id" :value="device.id">
              {{ device.name }}（{{ device.ip || t('trendsUi.noAddress') }}）
            </option>
          </select>
        </label>
      </Teleport>

      <section class="card">
        <div class="filter-bar">
          <!--
            通道选择：**筛选栏的第一项**（业主 2026-09-19：通道贴着设备；20260921 设备
            搬去顶栏之后它就是这一行的开头）。

            这一块原来在图右侧占掉一列（第 13 批第 4 条「右侧列出 8 或 2 个通道」），
            于是图只能拿到剩下的宽度；业主现在要的是**图占满**，所以通道回到筛选栏这一行。
            只有声纹设备（`isMultiChannel`）渲染这一块：相机 / 声呐走单线趋势页，没有通道。
            第 4 条那几件事一件没少：
              · 一颗 chip 一条通道（CH1…CH8，设备几个就是几个）；
              · **无数据灰显**、**有数据可勾选**（判据都是 `hasData`，见 `channelCheckboxDisabled`）；
              · 可**重命名**（写设备，`/set_passageway` 的 `dchName`）；
              · 每颗 chip 只带颜色点 + 通道名（色点与图上那条线同源；读数与自定义名括号
                按 20260921 删掉）。
          -->
          <div v-if="channelRows.length > 0" class="field field--channels" data-trend-channels>
            <span class="field-label">{{ t('trendsUi.channelPanelTitle') }}</span>
            <div class="chip-row channel-chip-row">
              <span
                v-for="row in channelRows"
                :key="row.index"
                class="channel-chip-wrap"
                :class="{ 'channel-chip-wrap--nodata': !row.hasData }"
                :data-trend-channel-row="row.index"
                :data-trend-channel-nodata="row.hasData ? undefined : 'true'"
              >
                <label
                  class="chip chip--selectable channel-chip"
                  :class="{ 'channel-chip--active': row.visible }"
                  :title="row.hasData ? channelChipHint(row) : t('trendsUi.channelNoData')"
                >
                  <input
                    type="checkbox"
                    :checked="row.visible"
                    :disabled="channelCheckboxDisabled(row)"
                    :data-trend-channel-check="row.index"
                    :aria-label="channelLabel(row.index)"
                    @change="toggleChannelRow(row)"
                  />
                  <span class="channel-chip__dot" :style="{ background: row.color }" aria-hidden="true"></span>
                  <span class="channel-chip__name">
                    {{ row.name ? row.name : channelLabel(row.index) }}
                  </span>
                </label>
                <button
                  type="button"
                  class="btn btn--ghost btn--icon channel-chip__rename"
                  :disabled="!channelRenameAvailable"
                  :title="channelRenameHint"
                  :data-trend-channel-rename="row.index"
                  @click="startChannelRename(row)"
                >
                  ✎
                </button>
              </span>
              <button
                type="button"
                class="chip chip--selectable"
                data-channel-show-all
                @click="trends.showAllChannels()"
              >
                {{ t('trendsUi.channelShowAll') }}
              </button>
            </div>
            <span class="field-hint" data-channel-panel-summary>
              {{ t('trendsUi.channelPanelSummary', { withData: channelsWithData, total: channelRows.length }) }}
            </span>
            <!-- 改名：一次只改一路（写设备要"读回全部通道 → 合并 → 写回"）。 -->
            <form
              v-if="renamingChannel !== null"
              class="channel-rename-form"
              data-trend-channel-rename-form
              @submit.prevent="submitChannelRename"
            >
              <input
                v-model="renameText"
                class="input channel-rename-form__input"
                type="text"
                :maxlength="CHANNEL_NAME_MAX_LENGTH"
                :placeholder="t('trendsUi.channelRenamePlaceholder')"
                data-trend-channel-rename-input
                @keydown.esc="cancelChannelRename"
              />
              <button type="submit" class="btn btn--sm btn--primary" :disabled="renameBusy">
                {{ t('common.save') }}
              </button>
              <button type="button" class="btn btn--sm" @click="cancelChannelRename">
                {{ t('common.cancel') }}
              </button>
            </form>
            <p v-if="renameProblem" class="alert alert--danger" role="alert" data-trend-rename-error>
              {{ renameProblem }}
            </p>
            <p v-if="renameNotice" class="alert alert--success" role="status" data-trend-rename-notice>
              {{ renameNotice }}
            </p>
          </div>

          <!--
            量可以**多选**：选中的量各画一张图（见 `chartBundles` 与文件头）。
            最后一个量点不掉，满 4 个之后其余的会置灰 —— 两个上限都在 store 里判，
            这里只把它画出来（第二处判断迟早与第一处不一致）。

            chips 的**视觉顺序 = `metricOrder`**，拖动一颗 chip 重排的是图自上而下的顺序
            （业主 20260921）。拖拽只是增强：它们仍然是普通按钮，Tab 聚焦、空格/回车
            切换选中都不受影响；顺序只活在本次会话（不持久化，见 `metricOrder` 的注释）。
          -->
          <div class="field field--metrics">
            <span class="field-label">{{ t('trendsUi.filterMetric') }}</span>
            <div class="chip-row" data-metric-picker>
              <button
                v-for="key in metricOrder"
                :key="key"
                type="button"
                class="chip chip--selectable metric-chip"
                :class="{
                  'chip--accent': trends.isMetricSelected(key),
                  'metric-chip--dragging': draggingMetric === key
                }"
                :data-metric-toggle="key"
                :aria-pressed="trends.isMetricSelected(key)"
                draggable="true"
                :disabled="
                  !trends.isMetricSelected(key) &&
                  trends.metrics.length >= TREND_METRIC_MAX_SELECTED
                "
                :title="
                  !trends.isMetricSelected(key) &&
                  trends.metrics.length >= TREND_METRIC_MAX_SELECTED
                    ? t('trendsUi.metricLimit', { count: TREND_METRIC_MAX_SELECTED })
                    : t('trendsUi.metricDragHint')
                "
                @click="toggleMetric(key)"
                @dragstart="onMetricDragStart(key, $event)"
                @dragover.prevent
                @drop="onMetricDrop(key)"
                @dragend="onMetricDragEnd"
              >
                {{ trendMetricLabel(key) }}
              </button>
            </div>
            <span v-if="trends.metrics.length > 1" class="field-hint">
              {{ t('trendsUi.metricMultiHint', { count: trends.metrics.length }) }}
            </span>
          </div>

          <!--
            **起始 / 结束时间**：业主 2026-09-19 最新一条要它「放在指标的右侧」——
            它和指标一样是查询条件（"查哪一段时间、哪些量"），本来就在筛选栏这一行里，
            现在只是从下面那一排挪到指标后面。只有选了「自定义」那一档才出现。
          -->
          <div v-if="trends.range === 'custom'" class="field field--range" data-trend-custom-range>
            <span class="field-label">{{ t('trendsUi.filterRangeLabel') }}</span>
            <div class="custom-range">
              <label class="field">
                <span class="field-label">{{ t('trendsUi.filterFrom') }}</span>
                <input
                  v-model="customFromText"
                  class="input"
                  type="datetime-local"
                  data-trend-range-from
                  @input="applyCustomRange"
                />
              </label>
              <label class="field">
                <span class="field-label">{{ t('trendsUi.filterTo') }}</span>
                <input
                  v-model="customToText"
                  class="input"
                  type="datetime-local"
                  data-trend-range-to
                  @input="applyCustomRange"
                />
              </label>
              <span v-if="customRangeIncomplete" class="field-hint">
                {{ t('trendsUi.incompleteRange') }}
              </span>
            </div>
          </div>

        </div>
      </section>

      <!--
        趋势曲线卡片：**整幅宽**（业主最新一条：「趋势图还是占右侧区域的 100%」）。
        原来它被 `.trends-body` 分成"图 | 通道列"两栏，图只能拿到剩下的宽度；
        通道搬回筛选栏之后这里只剩一张卡片，宽度自然就是 100%。
      -->
      <section class="chart-panel card">
        <div class="section-header">
          <h3 class="section-title">{{ t('trendsUi.chartTitle') }}</h3>
          <!--
            机型徽标（业主 20260921：页头显示机型标签）：同一台设备切过去，多通道 / 单线
            两种形态靠它一眼区分。标签复用设备表那一套键（`domain.deviceKind.*`）。
          -->
          <span v-if="deviceKindLabel" class="badge kind-badge" data-trend-kind-badge>
            {{ deviceKindLabel }}
          </span>
          <!--
            「设备IP · 通道 · 时间」那一行**删掉了**（业主 2026-09-19 最新一条：
            「把现在的趋势框中设备IP，通道，时间这个内容移除」）。
            这三样东西现在分别在：设备下拉（顶栏那一格）、通道选择（筛选栏里那一排）、
            时间范围预设（下面那一排 + 缩放的提示行）—— 同一个信息只在**能改它的那个控件**上说一次。
          -->
          <div class="btn-row chart-actions">
            <button
              type="button"
              class="btn btn--sm"
              :disabled="exporting || trends.queriedFrom === null"
              data-trend-export
              :title="t('trendsUi.exportHint')"
              @click="exportCsv"
            >
              {{ exporting ? t('trendsUi.exporting') : t('trendsUi.exportCsv') }}
            </button>
            <button
              type="button"
              class="btn btn--sm"
              data-trend-print
              :title="t('trendsUi.printHint')"
              @click="printCharts"
            >
              {{ t('trendsUi.print') }}
            </button>
          </div>
        </div>

        <!--
          **时间范围预设 + 时间颗粒度**：业主 2026-09-19 最新一条要它们
          「放在趋势曲线这个卡片中」—— 它们回答的是"这张图画的是哪一段、每一格多大"，
          与图放在一起比放在筛选栏更贴（筛选栏回答的是"看哪台设备的哪些量"）。
        -->
        <div class="chart-range-bar">
          <div class="chip-row">
            <button
              v-for="preset in TREND_RANGE_OPTIONS"
              :key="preset.key"
              type="button"
              class="chip chip--selectable"
              :class="{ 'chip--accent': trends.range === preset.key }"
              :data-trend-range-preset="preset.key"
              @click="trends.setRange(preset.key)"
            >
              {{ t(preset.labelKey) }}
            </button>
          </div>

          <div class="chip-row granularity-row" data-trend-granularity>
            <span class="field-label">{{ t('trendsUi.granularityLabel') }}</span>
            <button
              v-for="option in TREND_GRANULARITY_OPTIONS"
              :key="option.key"
              type="button"
              class="chip chip--selectable"
              :class="{
                'chip--accent': trends.granularity === option.key,
                'chip--auto-hint': autoBucketKey === option.key
              }"
              :data-trend-granularity-option="option.key"
              :aria-pressed="trends.granularity === option.key"
              :title="granularityHint(option)"
              @click="granularitySelection = option.key"
            >
              {{ t(option.labelKey) }}
              <template v-if="option.key === 'auto' && autoBucketText">
                （{{ autoBucketText }}）
              </template>
            </button>
          </div>
        </div>

        <p v-if="exportNotice" class="alert alert--success" role="status" data-trend-export-notice>
          {{ exportNotice }}
        </p>
        <p v-if="exportError" class="alert alert--danger" role="alert" data-trend-export-error>
          {{ exportError }}
        </p>

        <!--
          缩放提示（第 6 条）：放大之后图上**看不出来**自己在哪一段 —— 一张只画了三分钟的图
          与一张画了三十天的图长得一模一样。所以放大时写明"当前显示第 a–b 个点 / 共 n 点
          （某时刻 ~ 某时刻）"，并给一个「重置缩放」。
        -->
        <div v-if="zoomHint" class="zoom-bar" data-trend-zoom-bar>
          <span class="muted" data-trend-zoom-hint>{{ zoomHint }}</span>
          <button type="button" class="btn btn--sm" data-trend-zoom-reset @click="resetZoom">
            {{ t('trendsUi.zoomReset') }}
          </button>
        </div>

        <p v-if="trends.series?.truncated" class="alert alert--warning" role="status">
          {{ t('trendsUi.truncated', { count: trends.points.length }) }}
        </p>

        <EmptyState
          v-if="noDeviceSelected"
          :title="t('trendsUi.noDeviceSelectedTitle')"
        />

        <EmptyState
          v-else-if="trends.deviceHasNoHistory"
          :title="t('trendsUi.noHistoryTitle')"
        >
          <RouterLink class="btn btn--primary" to="/monitor">{{ t('trendsUi.goToMonitor') }}</RouterLink>
        </EmptyState>

        <EmptyState
          v-else-if="rangeEmptyForChannels"
          :title="t('trendsUi.emptyRangeTitle')"
        >
          <!--
            跳到"库里有数据的那个范围"（第 25 轮加的；`useCoverageRange()` 会**同时**把预设
            切成"自定义"并写进两个边界）。第 33 轮给它加了探针钩子：
            · 它是**业主真的会点**的一个按钮（"这一段没有数据、跳到有数据的那一段"）；
            · 它落到的状态（`range='custom'` + 两个边界都有值）与"手填两个时间"是**同一个状态** ——
              第 32 轮定位到的那个卡死就发生在这个状态上，所以它是那条路径的**另一个入口**；
            · 它也是探针唯一能拿到"真的有读数"的那一屏的办法（默认预设是最近 1 小时，
              而这台设备最后一次上报在几天前）—— 没有它，"声压级 Y 轴 0–100"与
              "多条通道画在同一根轴上"这两条断言永远跑不到。
          -->
          <button
            v-if="coverageText"
            type="button"
            class="btn"
            data-trend-use-coverage
            @click="useCoverageRange"
          >
            {{ t('trendsUi.coverageAvailable', { range: coverageText }) }}
          </button>
        </EmptyState>

        <!--
          一个选中的量一张图（业主追加要求："同时显示"）。每张图里是**所有可见通道**的折线，
          颜色与图例同一个来源。原来那种"一条聚合线"只在设备没返回通道表时用（`fallbackOption`）。
        -->
        <template v-else-if="trends.visibleChannelIds.length > 0">
          <div
            v-for="bundle in chartBundles"
            :key="bundle.metric"
            class="metric-chart"
            :data-metric-chart="bundle.metric"
            :data-y-range="trendAxisRangeText(bundle.metric)"
          >
            <div class="section-header">
              <h4 class="section-title">{{ trendMetricLabel(bundle.metric) }}</h4>
              <span class="muted chart-hint">
                {{ trendAxisName(bundle.metric, trends.aggregation) }} ·
                {{ t('trendsUi.channelLines', { count: bundle.lines.length }) }}
              </span>
            </div>
            <!--
              这一张图上一条非空值都没有时给一句空态，而不是画一根空轴 ——
              空轴看起来像"图上什么都没有"，而实事是"这个量在这段时间里没有读数"。
            -->
            <p v-if="!bundle.hasValue" class="muted" :data-metric-empty="bundle.metric">
              {{ t('trendsUi.metricNoData') }}
            </p>
            <!--
              `:ref` 用内联箭头是**必须**的（多张图要按量区分），但 `setChartRef` 只往一个
              **普通对象**里写（不是 `ref`）—— 理由见 `chartInstances` 那段注释：
              patch 期间写响应式 ref 会把这条更新自己排回队列，整页就永远刷不完。
            -->
            <EChart
              v-else
              :ref="(instance) => setChartRef(bundle.metric, instance)"
              :option="chartOptions[bundle.metric] ?? chartOptionFor(bundle)"
              height="320px"
              :placeholder="chartPlaceholder"
              @datazoom="(window) => onChartZoom(bundle.metric, window)"
            />
          </div>
        </template>

        <EChart
          v-else
          :ref="setFallbackChartRef"
          :option="fallbackOption"
          height="360px"
          :placeholder="chartPlaceholder"
          @datazoom="(window) => onChartZoom('fallback', window)"
        />

        <!--
          曲线下方那一行诊断（返回点数 / 原始行数 / 聚合桶大小 / 扫描文件 / 耗时 / 压缩比 /
          本次查询条数）**删掉了**（业主 2026-09-19 最新一条：「曲线下方的返回点数，这些内容移除」）。

          这一行在第 26 轮是被**特意保留**的（当时业主只说删四张卡片），现在点名要删 ——
          冲突按最新一条处理。没有因此变哑的两件事：
            · 图被截断时那张 `truncated` 提示**留着**（它是报警，不是读数）；
            · "这张图有多细"由上面的时间颗粒度那一排回答（「自动（5 分钟）」就是把桶宽写在按钮上）。
          "点一下通道不重新查库"这件事从前是靠这一行里的「本次查询条数」量的，
          现在改由**源码守卫**（`toggleChannel` 里没有 `query()`）与探针的
          「点一下之后图上的点数/刻度不变」来保证 —— 见 `tests/trend-channels.test.ts`。
        -->
      </section>

      <!--
        时间段告警（业主 20260921）：**图上这一段**里报过的告警，最多 50 条。
        点一行跳到告警中心、设备筛选已经带好（AlarmsView 认地址栏的 `?device=`）。
        范围与设备随趋势查询走（`queriedFrom/To` 变了就重查，见 `loadRangeAlarms`），
        不另设筛选；查询失败把那句原文写在卡里，不静默。
      -->
      <section class="card range-alarms" data-trend-range-alarms>
        <div class="section-header">
          <h3 class="section-title">{{ t('trendsUi.rangeAlarmsTitle') }}</h3>
          <span v-if="rangeAlarms.length > 0" class="muted chart-hint" data-trend-range-alarms-count>
            {{ t('trendsUi.rangeAlarmsCount', { count: rangeAlarms.length }) }}
          </span>
        </div>

        <p
          v-if="rangeAlarmsError"
          class="alert alert--danger"
          role="alert"
          data-trend-range-alarms-error
        >
          {{ rangeAlarmsError }}
        </p>
        <p
          v-else-if="rangeAlarmsLoading"
          class="muted"
          data-trend-range-alarms-loading
        >
          {{ t('alarmsUi.loading') }}
        </p>
        <!-- 空态复用告警中心那一句：这一段里没有告警，就是「没有符合条件的告警记录」。 -->
        <p
          v-else-if="rangeAlarms.length === 0"
          class="muted"
          data-trend-range-alarms-empty
        >
          {{ t('alarmsUi.empty') }}
        </p>

        <ul v-else class="range-alarm-list">
          <li v-for="alarm in rangeAlarms" :key="alarm.id">
            <RouterLink
              class="range-alarm-row"
              :to="{ path: '/alarms', query: { device: selectedDeviceId } }"
              :data-trend-range-alarm="alarm.id"
            >
              <span class="nowrap range-alarm-row__time">{{ formatDateTime(alarm.timestamp) }}</span>
              <span class="badge" :class="`badge--severity-${alarm.severity}`">
                {{ eventSeverityLabel(alarm.severity) }}
              </span>
              <!-- 标题一行截断，悬停看全文（`title`）。 -->
              <span class="range-alarm-row__title" :title="rangeAlarmTitle(alarm)">
                {{ rangeAlarmTitle(alarm) }}
              </span>
              <span
                class="badge"
                :class="alarm.acknowledged ? 'badge--success' : 'badge--warning'"
              >
                {{ alarm.acknowledged ? t('alarmsUi.ackAcknowledged') : t('alarmsUi.ackUnacknowledged') }}
              </span>
            </RouterLink>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
/*
 * 顶栏那一格里的设备下拉（被 `Teleport` 投进 `#topbar-page-slot`）。
 *
 * 与 `MonitorView.vue` 的 `.topbar-device` **同值**：那一格本身是顶栏的 50% 宽，
 * 下拉占这一格的 50% 并 `margin-left: auto` 推到右端（那一格右边挨着的就是设备数量
 * 指示器）；`min-width: 0` 让长设备名在下拉内部截断。scoped 样式对 Teleport 出去的
 * 内容仍然生效，所以这一条写在本页的 `<style scoped>` 里（第 32 轮给旧下拉钉 200px 的
 * `.field--wide` 随筛选栏里那个控件一起删掉了 —— 留着指向不存在元素的规则，会让下一个
 * 人以为那东西还在）。
 */
.topbar-device {
  width: 50%;
  min-width: 0;
  margin-left: auto;
}

.topbar-device .select {
  width: 100%;
  min-width: 0;
}

/*
 * 通道选择与量那两排都在筛选栏里（第 30 轮：通道回到**设备右侧**，图占满宽度）。
 *
 * 通道那一排可能很长（8 路 × 一个 chip + 一个改名按钮），所以它**允许换行**、并给它
 * 一个由内容决定的最小宽度；量那一排照旧占满剩余宽度。
 *
 * ⚠ 第 32 轮修正：`flex: 0 1 auto`（原来那样）+ `max-width: 100%` 会让它**换到下一行**。
 * `flex-wrap` 判断"换不换行"看的是每一项的 **base size**，而 `auto` 的 base 是内容宽度
 * （8 路实测 1126px，整行才 1127px）—— 于是它永远放不进设备右边那一段，只能另起一行，
 * 业主那条「通道的选择应该放在设备的右侧」在真窗口里**从来没成立过**（第 32 轮探针量到：
 * `panelTop=168` vs `deviceTop=120`，`panelLeft` 等于整行的左边界）。
 * 改法：base 压到 320px（一定能和设备待在同一行），`flex-grow: 1` 让它吃掉这一行的剩余宽度；
 * 里面那排 chip 自己在剩下的宽度里换行（`.channel-chip-row { flex-wrap: wrap }`）。
 */
.field--channels {
  min-width: 0;
  flex: 1 1 320px;
  max-width: 100%;
}

.field--channels .chip-row {
  flex-wrap: wrap;
  row-gap: 6px;
}

/* 一条通道 = 一个 chip（勾选框 + 色点 + 通道名）+ 一个改名按钮。 */
.channel-chip-wrap {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

/*
 * 「无数据灰显」：整块降到次要色。**勾选框自己也有 `disabled`**（不是只靠颜色）——
 * 只看颜色的话，键盘用户仍然能勾上一个没有数据的通道。
 */
.channel-chip-wrap--nodata {
  opacity: 0.55;
}

.channel-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

/* 勾上的那一路：整块用强调色（与图上那条线在画）—— 没勾的就是普通 chip。 */
.channel-chip--active {
  border-color: var(--color-accent);
}

.channel-chip__dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
}

.channel-chip__name {
  white-space: nowrap;
}

.channel-chip__rename {
  flex: none;
  padding: 2px 4px;
  line-height: 1;
}

/* 改名那一行：展开在通道那一排的下面（一次只改一路）。 */
.channel-rename-form {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1 1 100%;
  margin-top: var(--space-2);
}

.channel-rename-form__input {
  flex: 1 1 160px;
  min-width: 0;
}

/*
 * 量与通道两排的关系。
 * 旧规则 `.channel-chip*` 那一套是第 10 批的写法（在筛选栏里），第 25 轮删过一次、
 * 第 30 轮又按业主的要求把通道放回这里 —— 名字与结构都与第 10 批不同（那时只有"点一下
 * 显示/隐藏"，现在带勾选框、读数与改名），所以是**新写的规则**，不是把旧的抄回来。
 */
.field--metrics {
  min-width: 0;
  flex: 1 1 100%;
}

.field--metrics .chip-row {
  flex-wrap: wrap;
  row-gap: 6px;
}


/*
 * 时间颗粒度那一排（第 13 批第 5 条）。
 *
 * 它与时间范围那一排同一行，所以需要一个视觉分隔（`border-left` + 左内边距）：
 * 没有分隔时"最近 1 小时 / 24 小时 / …"与"自动 / 1 秒 / …"看起来是一排按钮的延续，
 * 而它们回答的是两个不同的问题（看哪一段 vs 每一格多大）。
 */
.granularity-row {
  align-items: center;
  gap: 6px;
  margin-left: var(--space-3);
  padding-left: var(--space-3);
  border-left: 1px solid var(--color-border);
}

.granularity-row .field-label {
  margin-right: 2px;
}

/*
 * 自动那一档挑中的桶宽正好等于界面上某一档时，把那一档标一下（`title` 里说明来源）。
 * 用虚线边框而不是强调色：强调色在这里表示"当前选中的那一档"，两者不是同一件事
 * （自动模式下选中的是"自动"，而这一档只是"自动挑中的值")。
 */
.chip--auto-hint {
  border-style: dashed;
}

/* 导出 / 打印两颗按钮：靠右，与卡片标题同一行。 */
.chart-actions {
  margin-left: auto;
}

/*
 * 缩放提示行：放大之后必须看得出来"现在看的是哪一段"（见模板里的注释）。
 */
.zoom-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

/*
 * 打印（第 6 条）：只留图与那一行说明。
 *
 * 视图自己的这些东西（筛选栏、按钮、缩放提示）在这里藏掉；应用外壳（侧边栏、顶栏）
 * 在 `main.css` 里统一藏 —— 打印出来的东西应当是"证据"，不是"界面截图"。
 *
 * `.channel-panel` / `.diagnostics` / `.range-bar` 三个选择器**随它们的目标一起删掉了**
 * （第 30 轮：通道搬进筛选栏、诊断行删除、时间预设搬进图卡片）—— 留着一条指向不存在元素的
 * 打印规则，会让下一个人以为那些东西还在。
 */
@media print {
  .card:not(.chart-panel),
  .filter-bar,
  .chart-actions,
  .zoom-bar {
    display: none !important;
  }
}

/* 一个量一张图：图之间用空隙分开，不画分隔线（它们本来就是独立的两张图）。 */
.metric-chart + .metric-chart {
  margin-top: var(--space-4);
}

/*
 * 趋势曲线卡片里的「时间范围 + 时间颗粒度」那一排（第 30 轮从筛选栏搬进来）。
 */
.chart-range-bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: var(--space-3);
}

.custom-range {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.chip--selectable {
  cursor: pointer;
  font-family: inherit;
}

.chip--selectable:hover {
  border-color: var(--color-border-strong);
}

.chart-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.chart-hint {
  font-size: 11.5px;
}

/*
 * 指标 chips 的拖拽手势（业主 20260921）。`grab` 只是"可以拖"的提示，
 * 点击切换选中照旧；`--dragging` 给被拖的那颗一点透明，落点看得更清楚。
 * 键盘路径完全不受影响（drag 只是增强，按钮还是那颗按钮）。
 */
.metric-chip {
  cursor: grab;
}

.metric-chip--dragging {
  opacity: 0.6;
}

/* 页头那枚机型徽标（`domain.deviceKind.*` 的标签），跟在「趋势曲线」标题后面。 */
.kind-badge {
  flex: none;
}

/*
 * 时间段告警卡（业主 20260921）：紧凑列表，一行一条 =
 * 时间 | 等级徽标 | 标题（一行截断） | 确认状态。
 */
.range-alarm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.range-alarm-row {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-2);
  border-radius: 6px;
  color: inherit;
  text-decoration: none;
}

.range-alarm-row:hover {
  background: var(--color-bg-hover);
}

.range-alarm-row__time {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* `minmax(0, 1fr)` 那列吃剩余宽度；这一格只许一行，超出省略（全文在 `title` 上）。 */
.range-alarm-row__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}

/*
 * 等级配色：与 `AlarmsView.vue` 那一套**同值**。那边的规则是 scoped 的、过不来；
 * `main.css` 里也写明旧页面各自带一份，重做时再统一 —— 所以这里按同款再写一份，
 * `unknown` 用中性灰而不是"最轻一档"的理由与那边相同（它不是"我们判了最轻"，
 * 而是"设备没给等级"）。
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
</style>
