<script setup lang="ts">
/**
 * 通道墙 —— 总览页的 1 / 2 / 4 / 8 分屏通道展示（产品要求：「总览中的通道墙应该支持
 * 1、2、4、8 通道，支持用户设置显示不同的图形，如声压线、频谱图、时谱图这些。
 * 如果没有通道在线就可以默认收起。」）。
 *
 * 这一格墙要回答的问题只有一个：**现在哪些通道是好的、哪些不是**，以及**这一屏按
 * 操作员选的那一种图形在画什么**。全部已注册设备的所有通道摊平成格子，一屏看不同的
 * 路数，和 iVMS-4200 一类安防客户端的“分割画面”是同一个交互。格子的排布与分页全部
 * 由 `lib/channelWall.ts` 计算，本文件只负责画和取数。
 *
 * 四种图形的数据都来自**设备真实推送的载荷**，没有一种由本文件生成
 *   - 声纹图：相机 `/voiceprintData` 的 JPEG（`stores/fa371Stream.ts`）；
 *   - 声压线：盒子 `features` 流的 `spl`（`stores/monitor.ts` 的实时会话缓冲）；
 *   - 频谱图：盒子 `spectrum` 流，或相机 `/fftData` 的 1024 条谱线；
 *   - 时谱图：盒子 `spectrogram` 流的 JPEG（`SpectrogramViewer.vue` 用的是同一份数据）。
 * 哪一种画不出来，就在那一格里**说出是哪一种原因**（没有这种载荷 / 一帧都没有 /
 * 已经停了 / 这一路报错 / 未监测），八种状态在 `lib/channelWall.ts` 里定义、由
 * `channelGraphState()` 唯一判定。绝不补一条零线，也绝不用
 * `composables/useSimulatedRealtime.ts` 造一条曲线。
 *
 * 这一轮：每一格还多回答一件事 —— 「这一路通道**此刻的状态**，以及它**最近一次告警**」
 *   - 状态（已启用 / 未启用 / 状态未知）来自已读回的通道表，判定仍然只走
 *     `channelState()`：缺 `enabled` 一律 `unknown`，绝不读成「已启用」；
 *   - 最近告警来自本地告警库 `window.api.alarms.query({ deviceId, channelId, limit: 1 })`，
 *     显示告警类型、时间与是否已确认；一条都没有就写「无告警记录」。
 *
 * **为什么写「最近告警」而不是「正在告警」**：契约里没有任何「这一路此刻正在告警」的
 * 推送。`PushChannels` 全体只有两条与告警沾边 —— `DEVICE_STATUS`（设备在线状态）与
 * `LINKAGE_PENDING`（本机联动引擎的待处理列表）—— 两条都是**设备级**且都不带通道号
 * （`DeviceStatusEvent` 只有 `deviceId`/`status`/`lastSeen`，`PendingAlarmRecord` 只有
 * `deviceId`/`at`/`metrics`）。所以这一格能如实说的是「**最近一条告警记录**是什么」；
 * 「此刻正在告警」在这个契约里**没有数据来源**，写出来就是编的。真机是否另外推过
 * 每通道的告警状态，由 `scripts/video-proof.cjs --route /` 那一次实测回答（本轮报告里
 * 写了结论与证据）。
 *
 * **档位按设备真实的通道数裁剪**：分段控件渲染的集合来自 `channelWallLayouts(tiles)`
 * （纯函数、有单元测试）—— 2 路设备只给 1 / 2，8 路设备给 1 / 2 / 4 / 8，通道表还没
 * 读到时不裁剪。模板里没有这个判断；持久化下来的旧档位超出集合时由
 * `resolveChannelWallLayout()` 在渲染层回退，**不写回 store**（理由见那个函数）。
 *
 * 三条“不许撒谎”的规矩（与 `lib/channelState.ts`、相机面板一致）
 *   1. 没有实时数据流时，格子写「未监测」，**绝不显示 0 dB**。0 dB 是一个测量
 *      结果，而这里根本没有测量；把两者画成一样，值班的人就会以为环境很安静。
 *   2. 未启用（`disabled`）的通道整块压暗并标注「未启用」，与通道配置表、监测页
 *      用同一套 `channelState*` helper 判定 —— 这一路的实时数据流也不会被启动。
 *   3. 声压读数后面那个 `dB` 是**本仓库的标注**，不是设备给的：设备推上来的字段名是
 *      `sound_pressure_level`（见 `mappers.spl`），而它的**单位没有任何来源** ——
 *      本仓库里唯一一处 dB 定义（20 µPa 基准）来自相机的 FA371 手册，盒子的手册
 *      本仓库没有。文本因此进了目录（`channelWall.graph.splUnit`），出处进了元素的
 *      `title`（`channelWall.graph.splUnitNote`）与本文件里那段代码注释；
 *      **数值照常显示**（所有者要的是那个数）。
 *
 * 为什么总览页上大多数格子会是「未监测」
 * 实时会话（`stores/monitor.ts`）的所有者是监测页：它一挂载就建流、一卸载就停流
 * （见 `MonitorView.onUnmounted`），而且设备一条 WebSocket 只推**一路**通道。
 * 所以通道墙的做法是如实反映：会话在哪一路，哪一路就显示数值；其余显示状态与
 * 「未监测」。这样它既是有用的状态总览，也不会为了让格子好看而假装在采集。
 * 本组件因此**绝不**调用 `monitor.start()` / `fa371Stream.start()`：那是硬件操作
 * （主进程里还有管理员守卫），发起者只能是监测页上那个按钮。
 *
 * 收起的默认值由数据决定（产品要求「如果没有通道在线就可以默认收起」）
 * 判定是 `defaultChannelWallCollapsed()`（纯函数、有单元测试），操作员点过之后由他
 * 的选择说了算（`channelWallCollapsed()`）。收起时只留标题行，并且用真正的
 * `<button aria-expanded>`，键盘与读屏用户都能看出它是收起的、也能把它展开。
 *
 * 这一轮的通道墙上**没有**“添加”用的 `+`
 * 画面格中间那个 `+` 属于相机墙：它把一台相机放进一个**由操作员摆放**的槽位。通道墙
 * 的格子不是摆出来的，是 `buildTiles()` 从“已注册设备 + 已读回的通道表”推出来的，
 * 没有任何一格是空的、也没有“往这一格放一路通道”这个动作（通道由设备端决定，只能去
 * 设备管理里加设备）。所以这里没有第二种“空白格”可供居中，也不该凭空造一个入口。
 *
 * 空状态只有一处：一台设备都没有时本组件整块不渲染，因为这一页的「设备状态」卡片
 * 已经在说「尚未添加设备」；有设备但通道表还没回来时，才由本组件说明原因。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { AlarmEvent } from '@shared/domain/models'
import type { StreamKind } from '@shared/domain/monitoring'
import type { Fa371StreamKind } from '@shared/domain/fa371-stream'
import {
  channelActivityLabelKey,
  channelReceivesData,
  channelStateClass,
  channelStateHintKey,
  channelStateLabelKey,
  type ChannelState
} from '@renderer/lib/channelState'
import {
  CHANNEL_GRAPH_KINDS,
  buildTiles,
  channelGraphState,
  channelWallCollapsed,
  channelWallLayouts,
  channelTileCount,
  clampPage,
  hasOnlineChannel,
  layoutColumns,
  resolveChannelWallLayout,
  tilelessDevices,
  totalPages,
  visibleTiles,
  type ChannelGraphFacts,
  type ChannelGraphKind,
  type ChannelGraphState,
  type ChannelWallLayout,
  type ChannelWallTile
} from '@renderer/lib/channelWall'
import { formatBytes, formatDateTime, formatHz, formatNumber } from '@renderer/lib/format'
import { describeAlarmMask } from '@renderer/lib/labels'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { spectrumMaxHz, spectrumRangeLabel } from '@renderer/lib/spectrum'
import { useChannelWallStore } from '@renderer/stores/channelWall'
import { useDevicesStore } from '@renderer/stores/devices'
import { useFa371StreamStore } from '@renderer/stores/fa371Stream'
import { useMonitorStore } from '@renderer/stores/monitor'
import ChannelGraph from '@renderer/components/ChannelGraph.vue'
import ChannelGraphIcon from '@renderer/components/ChannelGraphIcon.vue'
import EmptyState from '@renderer/components/EmptyState.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'
import LayoutGridIcon from '@renderer/components/LayoutGridIcon.vue'

const { t, locale } = useI18n()
const router = useRouter()
const devices = useDevicesStore()
const monitor = useMonitorStore()
const camera = useFa371StreamStore()
const wall = useChannelWallStore()

// ---------------------------------------------------------------------------
// 格子数据
// ---------------------------------------------------------------------------

/** 设备 + 已加载到的通道表 -> 全部格子（排序规则见 `buildTiles()` 的注释）。 */
const tiles = computed(() =>
  buildTiles({ devices: devices.devices, channels: devices.channels })
)

/** 有设备却没有格子的设备：通道表还没读回来，界面据此提示，而不是画假格子。 */
const tileless = computed(() =>
  tilelessDevices({ devices: devices.devices, channels: devices.channels })
)

/**
 * 这段墙该提供哪几个档位 —— 只保留这台设备真的用得上的（见 `channelWallLayouts()`）。
 *
 * 模板里 `v-for` 的是它，而不是 `CHANNEL_WALL_LAYOUTS`：那个常量仍然是全部合法档位的
 * 定义处（持久化校验、纯函数测试都用它），但**控件渲染哪些**由设备真实的通道数决定。
 */
const layoutOptions = computed(() => channelWallLayouts(tiles.value))

/**
 * 此刻生效的档位。
 *
 * 不直接用 `wall.layout`：持久化下来的值可能是上一台设备留下的（先看 8 路盒子、
 * 后来换成 2 路盒子），裁剪后的集合里已经没有它了。回退只在渲染层发生，
 * **不写回 store**（理由见 `resolveChannelWallLayout()`）。
 */
const layout = computed<ChannelWallLayout>(() =>
  resolveChannelWallLayout(wall.layout, tiles.value)
)
const pageCount = computed(() => totalPages(tiles.value, layout.value))
/**
 * 实际生效的页码。
 *
 * 不直接用 `wall.page`：设备被删除后它可能指向已经不存在的页，这里夹取一次，
 * 模板就不会出现“第 3 / 1 页”这种一格都画不出来的状态。
 */
const currentPage = computed(() => clampPage(wall.page, tiles.value, layout.value))
const pageTiles = computed(() => visibleTiles(tiles.value, layout.value, currentPage.value))

/** 网格的列数交给 CSS 变量，列数本身由 `layoutColumns()` 决定（纯函数、可测）。 */
const gridStyle = computed(() => `--wall-columns: ${layoutColumns(layout.value)}`)

const channelsLoading = computed(() => Object.values(devices.channelsLoading).some(Boolean))
const cameraDevices = computed(() =>
  devices.devices.filter((device) => device.kind === 'acousticCamera')
)

/**
 * 夹取后的页码写回 store。
 *
 * 这是“删掉设备后停在最后一页”的收尾：夹取发生在这里，持久化的值也必须跟着回退，
 * 否则下次回到总览页仍会从一个不存在的页码开始。
 */
watch(currentPage, (value) => {
  if (value !== wall.page) wall.setPage(value)
})

// ---------------------------------------------------------------------------
// 收起 / 展开
// ---------------------------------------------------------------------------

/**
 * 此刻是否收起。
 *
 * 判定完全交给纯函数：数据给默认值，操作员的选择优先（理由见
 * `lib/channelWall.ts` 的 `channelWallCollapsed()`）。模板里没有这个三元表达式。
 */
const collapsed = computed(() => channelWallCollapsed(tiles.value, wall.collapsedOverride))

/** 有没有一路在线通道 —— 收起时那句说明要用它（“没有通道在线”必须看得见）。 */
const anyOnlineChannel = computed(() => hasOnlineChannel(tiles.value))

/** 收起按钮的无障碍名字：说出**按下去会发生什么**，状态由 `aria-expanded` 表达。 */
const disclosureLabel = computed(() =>
  collapsed.value ? t('channelWall.expand') : t('channelWall.collapse')
)

function toggleCollapsed(): void {
  // 写回的是“操作员的选择”，不是当前状态的一份副本：此后默认行为不再接管它。
  wall.setCollapsed(!collapsed.value)
}

// ---------------------------------------------------------------------------
// 实时数据：当前会话唯一可能有数值的那一格
// ---------------------------------------------------------------------------

/**
 * 正在接收数据的格子的 key，空串表示此刻没有任何一路在推数据。
 *
 * 判定走 `channelReceivesData()`（`lib/channelState.ts`）：它只看“会话在跑 + 这一路
 * 是订阅的那一路 + 收到过帧”，从不读 `enabled` —— 「开着却没有数据」与「被关掉」
 * 是两种不同的故障，这里必须能分开。主进程一次只订阅一路通道，所以最多一个键。
 */
const liveTileKey = computed(() => {
  const running = channelReceivesData({
    // 订阅的就是这一路：`monitor.channelId` 即当前会话的通道。
    isActiveChannel: true,
    sessionRunning: monitor.state === 'running',
    frameCount: monitor.frameCountOf('features')
  })
  if (!running || !monitor.deviceId) return ''
  return `box:${monitor.deviceId}:${monitor.channelId}`
})

/** 最新特征帧，仅当确有数据在流时才对外提供（否则就是上一段会话的残留值）。 */
const liveFrame = computed(() => (liveTileKey.value ? monitor.latest : null))

/** 最新音频预览；只在它确实属于当前订阅通道时用于电平条。 */
const liveAudio = computed(() => {
  if (!liveTileKey.value) return null
  const frame = monitor.audio
  return frame && frame.channelId === monitor.channelId ? frame : null
})

/**
 * 这一格此刻是否真的有可显示的实时数值。
 *
 * 把「会话在这一路」与「真的收到了帧」合成一个判定，模板就不会出现
 * “`liveTileKey` 命中但 `liveFrame` 还是空”时既不画数值也不画说明的空格子。
 */
function hasLiveMetrics(tile: ChannelWallTile): boolean {
  return liveTileKey.value === tile.key && liveFrame.value !== null
}

/** 电平条宽度：`peak` 是 0..1 的线性幅度，越小越安静，缺失时不画条（不假造 0）。 */
const liveLevelWidth = computed(() => {
  const frame = liveAudio.value
  if (!frame) return '0%'
  return `${Math.round(Math.min(1, Math.max(0, frame.peak)) * 100)}%`
})

// ---------------------------------------------------------------------------
// 设备状态徽标 / 通道状态徽标
// ---------------------------------------------------------------------------

/** 状态徽标配色，与通道配置表同一套语义：未知是警告色，未启用是中性灰。 */
function stateBadgeTone(state: ChannelState): string {
  if (state === 'enabled') return 'badge--success'
  if (state === 'unknown') return 'badge--warning'
  return ''
}

/** 通道状态的悬停说明；已启用时返回空串，模板用 `|| undefined` 去掉 title。 */
function stateHint(state: ChannelState): string {
  const key = channelStateHintKey(state)
  return key ? t(key) : ''
}

// ---------------------------------------------------------------------------
// 每一路的最近一条告警（只读本地告警库，不碰设备）
// ---------------------------------------------------------------------------

/**
 * 一格的告警读数状态。
 *
 * `loading` 与 `error` 都必须能显示出来：把「还没查」或「查失败」画成「无告警记录」，
 * 值班的人就会把一次读库失败当成「这一路很干净」—— 那是这一轮最不该出的错。
 */
interface TileAlarmState {
  loading: boolean
  alarm: AlarmEvent | null
  error: string
}

/** 还没查过时的取值：说「读取中」，绝不说「无告警记录」。 */
const PENDING_ALARM: TileAlarmState = { loading: true, alarm: null, error: '' }

/**
 * 已经查过的格子，按格子 key 索引：同一路只查一次，换页、换图形都不重查。
 *
 * 查的是**本地告警库**（`window.api.alarms.query` 走主进程的 SQLite），一次只读查询，
 * 不开任何设备 socket，因此不违反「通道墙自己不开硬件会话」那条规矩。
 */
const tileAlarms = ref<Record<string, TileAlarmState>>({})

/** 声纹通道格的 key 集合；只有它变化时才重新取数（相机没有通道，不查）。 */
const alarmedTileKeys = computed(() =>
  tiles.value
    .filter((tile) => tile.source === 'boxChannel')
    .map((tile) => tile.key)
    .join(',')
)

/**
 * 取这一格的最近一条告警。
 *
 * `limit: 1` 且**不按 `acknowledged` 过滤**：已确认的那条仍然是「最近一次告警」，
 * 把确认过的记录藏起来，格子就会看起来从来没有报过警。
 *
 * 失败**不重试**：本地库查不动是持续性故障，反复重试只会让 IPC 一直响，而格子上
 * 那句失败说明已经把状态说清楚了。
 */
async function loadTileAlarm(tile: ChannelWallTile): Promise<void> {
  if (tile.channelIndex === undefined) return
  if (tileAlarms.value[tile.key]) return

  const result = await callApi(() =>
    window.api.alarms.query({
      deviceId: tile.deviceId,
      channelId: tile.channelIndex,
      limit: 1
    })
  )
  const state: TileAlarmState = result.success
    ? { loading: false, alarm: unwrap(result)?.items[0] ?? null, error: '' }
    : { loading: false, alarm: null, error: resultMessage(result) }
  // 整体替换而不是就地改字段：`ref` 里的对象就地赋值不会触发模板更新。
  tileAlarms.value = { ...tileAlarms.value, [tile.key]: state }
}

async function loadTileAlarms(): Promise<void> {
  await Promise.all(
    tiles.value.filter((tile) => tile.source === 'boxChannel').map((tile) => loadTileAlarm(tile))
  )
}

watch(alarmedTileKeys, () => void loadTileAlarms(), { immediate: true })

/** 这一格的告警读数；没查过时是「读取中」。 */
function alarmState(tile: ChannelWallTile): TileAlarmState {
  return tileAlarms.value[tile.key] ?? PENDING_ALARM
}

/**
 * 格子上那一行告警文字。
 *
 * 四种情况必须读起来是**不同的事**：还没查到 / 查失败了 / 一条都没有 / 最近一条是什么。
 * 类型交给 `describeAlarmMask()`（一次告警可能同时置了几个位），时间用本机时区的
 * `formatDateTime()`，确认状态直接复用告警页那两个词条 —— 同一件事不在两处起名字。
 *
 * 措辞只说「最近告警」，不说「正在告警」：契约里没有每通道的实时告警推送
 * （理由见文件头）。
 */
function alarmText(tile: ChannelWallTile): string {
  const state = alarmState(tile)
  if (state.loading) return t('channelWall.alarm.loading')
  if (state.error) return t('channelWall.alarm.failed')
  const alarm = state.alarm
  if (!alarm) return t('channelWall.alarm.none')
  return t('channelWall.alarm.entry', {
    type: describeAlarmMask(alarm.alarmMask),
    time: formatDateTime(alarm.timestamp),
    ack: alarm.acknowledged ? t('alarmsUi.ackAcknowledged') : t('alarmsUi.ackUnacknowledged')
  })
}

/** 悬停时把读库失败的原因原样说清楚（格子上那句只是概括）。 */
function alarmTitle(tile: ChannelWallTile): string | undefined {
  return alarmState(tile).error || undefined
}

// ---------------------------------------------------------------------------
// 图形：数据从哪来
// ---------------------------------------------------------------------------

/**
 * 相机有真实载荷的图形，以及它对应哪一路 WebSocket 通道。
 *
 * 只有两条：`/voiceprintData`（JPEG，声纹图）与 `/fftData`（1024 条 int16 谱线，
 * 频谱图）。相机**没有**声压级 —— `/pcmData` 给的是线性包络（peak/rms），它的单位
 * 在手册里就是未定义的，把它标成 dB 就是把一个猜出来的单位画成测量结果；
 * 相机也**没有**时频通道（时谱图是盒子的 `/time_freq_domain`）。这两种图形在相机格上
 * 只能如实说「该设备不提供这种数据」。
 */
const CAMERA_GRAPH_STREAMS: Partial<Record<ChannelGraphKind, Fa371StreamKind>> = {
  voiceprint: 'voiceprintData',
  spectrum: 'fftData'
}

/**
 * 声纹盒子有真实载荷的图形，以及它对应哪一路监控流。
 *
 * 三种：`features`（声压线）、`spectrum`（频谱图）、`spectrogram`（时谱图）。
 * 盒子不推图像，所以「声纹图」在盒子那一格没有数据源。
 */
const BOX_GRAPH_STREAMS: Partial<Record<ChannelGraphKind, StreamKind>> = {
  spl: 'features',
  spectrum: 'spectrum',
  spectrogram: 'spectrogram'
}

/** 一格里要画的实际东西；`null` 由 `note` 解释原因。 */
interface ChannelGraphPayload {
  kind: ChannelGraphKind
  /** 设备渲染好的 JPEG（data URL）。 */
  image?: string
  imageAlt?: string
  /** 折线的真实数值。 */
  values?: readonly number[]
  /** 折线下方那行角注（真实读数或真实量程）。 */
  caption?: string
}

/** 一格此刻的完整视图：要么是一幅真实的图，要么是一句如实的说明。 */
interface TileGraphView {
  graph: ChannelGraphPayload | null
  note: string
}

/** 这一格是不是当前会话订阅的那一路。 */
function isSessionChannel(tile: ChannelWallTile): boolean {
  if (tile.source !== 'boxChannel' || tile.channelIndex === undefined) return false
  return monitor.deviceId === tile.deviceId && monitor.channelId === tile.channelIndex
}

/** 全假的事实（就是“没有这种载荷”那一类）。 */
function emptyGraphFacts(): ChannelGraphFacts {
  return {
    supported: false,
    ready: false,
    failed: false,
    matrixInsteadOfImage: false,
    otherSession: false,
    stale: false,
    awaitingFrames: false,
    monitored: false
  }
}

/** 相机推的是数值矩阵而不是 JPEG（离线 mock 的解码候选）—— 只有这种情况才叫“矩阵”。 */
function cameraVoiceprintIsMatrix(): boolean {
  const frame = camera.voiceprint
  return Boolean(frame && !frame.jpegBase64 && frame.width > 0 && frame.height > 0)
}

/**
 * 相机格的图形事实。
 *
 * `channelPhase()` 只有在会话确实盯着**这一台**相机时才是关于这一格的结论；盯的是
 * 另一台时它一律回答 `not-started`，而那种情况必须由 `otherSession` 说清楚。
 * `stale` 用的是相机 store 里那个实测出来的阈值（3 秒 ≈ 30 帧没到）。
 */
function cameraGraphFacts(
  tile: ChannelWallTile,
  kind: ChannelGraphKind,
  ready: boolean
): ChannelGraphFacts {
  const facts = emptyGraphFacts()
  const stream = CAMERA_GRAPH_STREAMS[kind]
  if (!stream) return facts
  facts.supported = true
  const mine = camera.deviceId === tile.deviceId
  const phase = mine ? camera.channelPhase(stream) : 'not-started'
  facts.ready = ready
  facts.failed = phase === 'error'
  facts.matrixInsteadOfImage =
    kind === 'voiceprint' && phase === 'live' && cameraVoiceprintIsMatrix()
  facts.otherSession = !mine && camera.isActive
  facts.stale = phase === 'stale'
  facts.awaitingFrames = phase === 'no-frames'
  facts.monitored = mine && phase !== 'not-started'
  return facts
}

/**
 * 盒子格的图形事实。
 *
 * 这里**没有** `stale`：声纹盒子的会话没有“静默多久算停”这回事（主进程不上报这一路
 * 最后一次收帧过了多久），界面也不自己发明一个阈值 —— 那是没测过的数字。盒子格能
 * 分开说的是：没有这种载荷 / 这一路自己报了错 / 会话在跑却一帧都没有 / 未监测。
 * 这与监测页画同一条趋势时的规矩一致：只看“会话在跑 + 收到过帧”，不加静默判定。
 */
function boxGraphFacts(
  tile: ChannelWallTile,
  kind: ChannelGraphKind,
  ready: boolean
): ChannelGraphFacts {
  const facts = emptyGraphFacts()
  const stream = BOX_GRAPH_STREAMS[kind]
  if (!stream) return facts
  facts.supported = true
  const sessionOnTile = isSessionChannel(tile) && monitor.state === 'running'
  facts.ready = ready
  facts.monitored = sessionOnTile
  facts.failed = sessionOnTile && monitor.statusOf(stream)?.state === 'ERROR'
  facts.awaitingFrames = sessionOnTile && monitor.frameCountOf(stream) === 0
  return facts
}

/** 相机格在当前图形下能画的真实数据；`null` = 没有可画的（原因由状态说明）。 */
function cameraGraphPayload(
  tile: ChannelWallTile,
  kind: ChannelGraphKind
): ChannelGraphPayload | null {
  const stream = CAMERA_GRAPH_STREAMS[kind]
  if (!stream || camera.deviceId !== tile.deviceId) return null
  // `live` 是必要条件：静默超过阈值之后停在最后一帧上的画面**不许**再画，
  // 一张冻结的图比一块写着“数据已停止”的空白更误导（见 `stores/fa371Stream.ts`）。
  if (camera.channelPhase(stream) !== 'live') return null

  if (kind === 'voiceprint') {
    const frame = camera.voiceprint
    if (!frame?.jpegBase64) return null
    return {
      kind,
      image: `data:image/jpeg;base64,${frame.jpegBase64}`,
      imageAlt: t('cameraStreamUi.voiceprintAlt'),
      caption: frame.jpegBytes ? formatBytes(frame.jpegBytes) : ''
    }
  }

  const frame = camera.fft
  const bins = frame?.bins ?? []
  if (bins.length < 2) return null
  const binHz = frame?.binHz
  // 设备未上报采样率时（实测这台相机没有这个接口），横轴只能按谱线序号标注：
  // 编一个 Hz 轴比没有轴更糟，所以角注直接把这个事实写出来。
  return {
    kind,
    values: bins,
    caption:
      binHz && binHz > 0
        ? spectrumRangeLabel(binHz * (bins.length - 1))
        : t('channelWall.graph.lineAxis', { count: bins.length })
  }
}

/** 盒子格在当前图形下能画的真实数据；`null` = 没有可画的。 */
function boxGraphPayload(
  tile: ChannelWallTile,
  kind: ChannelGraphKind
): ChannelGraphPayload | null {
  const stream = BOX_GRAPH_STREAMS[kind]
  if (!stream || !isSessionChannel(tile) || monitor.state !== 'running') return null

  if (kind === 'spl') {
    // 非有限值在这里就丢掉：`graphGeometry()` 也会丢，但角注上的点数必须是**真的落进
    // 那条折线的点数**，两处用同一个过滤条件才不会数出两个不同的 count。
    const values = monitor.features
      .map((frame) => frame.spl)
      .filter((value) => Number.isFinite(value))
    if (values.length < 2) return null
    const last = values[values.length - 1] ?? 0
    return {
      kind,
      values,
      caption: t('channelWall.graph.splCaption', {
        value: formatNumber(last, 1),
        count: values.length
      })
    }
  }

  if (kind === 'spectrum') {
    const magnitudes = monitor.spectrumMagnitudes
    if (magnitudes.length < 2) return null
    const binHz = monitor.spectrum?.binHz ?? 0
    const maxHz = spectrumMaxHz(magnitudes, binHz)
    return {
      kind,
      values: magnitudes,
      caption:
        maxHz > 0
          ? spectrumRangeLabel(maxHz)
          : t('channelWall.graph.lineAxis', { count: magnitudes.length })
    }
  }

  if (kind === 'spectrogram') {
    const frame = monitor.newestSpectrogram
    if (!frame?.jpegBase64) return null
    return {
      kind,
      image: `data:image/jpeg;base64,${frame.jpegBase64}`,
      imageAlt: t('widgetsUi.spectrogramAlt', {
        time: new Date(frame.timestamp).toLocaleTimeString(locale.value)
      }),
      caption: formatBytes(frame.byteLength)
    }
  }

  return null
}

/**
 * 相机格画不出图时的那句话。
 *
 * 八种状态里相机能碰到的都在这里，而且必须读起来是**不同的事**（这正是 `stale` 与
 * `no-frames` 不能合成一句的原因）。错误原文优先用这一路自己报的那一句 —— 那是实际
 * 发生的那件事。
 */
function cameraGraphNote(state: ChannelGraphState): string {
  const stream = CAMERA_GRAPH_STREAMS[wall.graph]
  switch (state) {
    case 'no-such-data':
      return t('channelWall.graph.deviceHasNoData')
    case 'matrix-only':
      // 设备推的是数值矩阵（离线 mock 的解码候选）：格子墙不做二次绘图，
      // 因为那画出来的是解码器的假设，不是相机自己的图像。
      return t('channelWall.cameraMatrixOnly')
    case 'other-session':
      return t('channelWall.cameraOtherDevice')
    case 'no-frames':
      return t('cameraStreamUi.phaseNoFrames')
    case 'stale': {
      const seconds = stream ? camera.silentSeconds(stream) : undefined
      return seconds === undefined
        ? t('cameraStreamUi.phaseStale')
        : t('channelWall.cameraStale', { seconds: formatNumber(seconds, 0) })
    }
    case 'error':
      return (stream ? camera.streams[stream]?.lastError : '') || t('cameraStreamUi.phaseError')
    default:
      return t('channelWall.reason.notMonitored')
  }
}

/**
 * 盒子格画不出图时的那句话。
 *
 * 优先级刻意如此：**设备端亲口报告的事实**（未启用 / 未知 / 离线）排在最前面 ——
 * “这一路被关掉了”是这个格子特有的、设备说过的原因，把它挤掉会让一整列灰格子看不出
 * 原因（与这一轮之前的写法完全一致：换一种图形不该让这些事实消失）。
 * 之后才是图形自己的原因：没有这种载荷 > 这一路报错 > 会话在跑却没有帧 > 未监测。
 */
function boxGraphNote(tile: ChannelWallTile, state: ChannelGraphState): string {
  if (tile.state === 'disabled') return t('channelState.disabledHint')
  if (tile.state === 'unknown') return t('channelState.unknownHint')
  if (tile.deviceStatus !== 'ONLINE') return t('channelWall.reason.deviceOffline')

  const stream = BOX_GRAPH_STREAMS[wall.graph]
  if (state === 'no-such-data') return t('channelWall.graph.deviceHasNoData')
  if (state === 'error') {
    return (stream ? monitor.statusOf(stream)?.lastError : '') || t('cameraStreamUi.phaseError')
  }
  if (state === 'no-frames') {
    // 会话盯的就是这一路，却一帧都没有：链路/传感器问题，不是被关掉。
    return t(channelActivityLabelKey(false))
  }
  return t('channelWall.reason.notMonitored')
}

/**
 * 算出一格此刻要画的东西。
 *
 * 数据先算、状态后判：`ready` 直接来自“有没有真的拿到载荷”，而不是另写一个容易与
 * 取数逻辑漂移的条件（那正是“画出来是空的、却报 ready”的来源）。
 */
function buildTileView(tile: ChannelWallTile): TileGraphView {
  const kind = wall.graph
  const isCamera = tile.source === 'cameraStream'
  const payload = isCamera ? cameraGraphPayload(tile, kind) : boxGraphPayload(tile, kind)
  const facts = isCamera
    ? cameraGraphFacts(tile, kind, payload !== null)
    : boxGraphFacts(tile, kind, payload !== null)
  const state = channelGraphState(facts)
  if (payload !== null && state === 'ready') return { graph: payload, note: '' }
  return {
    graph: null,
    note: isCamera ? cameraGraphNote(state) : boxGraphNote(tile, state)
  }
}

/** 没有对应格子时用的空视图（模板可以放心取值）。 */
const EMPTY_TILE_VIEW: TileGraphView = { graph: null, note: '' }

/**
 * 当前这一页每一格的视图，按格子的 key 索引。
 *
 * 刻意在这里一次算完，而不是让模板调用函数：模板里的函数会在**每一次 patch** 时对
 * 每一格重跑一遍，而声压线那一条要把最多 600 帧的 `features` 映射一次 —— 8 分屏下
 * 那就是每次 patch 4800 次映射。computed 只在输入真变了的时候算。
 */
const tileViews = computed<Record<string, TileGraphView>>(() => {
  const out: Record<string, TileGraphView> = {}
  for (const tile of pageTiles.value) out[tile.key] = buildTileView(tile)
  return out
})

function tileView(tile: ChannelWallTile): TileGraphView {
  return tileViews.value[tile.key] ?? EMPTY_TILE_VIEW
}

// ---------------------------------------------------------------------------
// 模板用的小工具
// ---------------------------------------------------------------------------

/** 分屏档位的文案 key。key 从档位推导，和 `channelState*` 的做法一致。 */
type LayoutLabelKey =
  | 'channelWall.layout1'
  | 'channelWall.layout2'
  | 'channelWall.layout4'
  | 'channelWall.layout8'
function layoutLabelKey(option: ChannelWallLayout): LayoutLabelKey {
  return `channelWall.layout${option}` as LayoutLabelKey
}

/** 图形类型的文案 key（同理，key 从图形的取值推导）。 */
type GraphLabelKey =
  | 'channelWall.graph.voiceprint'
  | 'channelWall.graph.spl'
  | 'channelWall.graph.spectrum'
  | 'channelWall.graph.spectrogram'
function graphLabelKey(kind: ChannelGraphKind): GraphLabelKey {
  return `channelWall.graph.${kind}` as GraphLabelKey
}

/** 通道标签；相机没有通道，用一句说明代替空的 `CH` 标签。 */
function tileLabel(tile: ChannelWallTile): string {
  return tile.label || t('channelWall.cameraStreamLabel')
}

/** 格子外观：未启用压暗、状态未知用警告底色，两者绝不能混同。 */
function tileClass(tile: ChannelWallTile): Record<string, boolean> {
  return {
    'wall-tile--camera': tile.source === 'cameraStream',
    'wall-tile--disabled': tile.state === 'disabled',
    'wall-tile--unknown': tile.state === 'unknown',
    'wall-tile--offline': tile.deviceStatus === 'OFFLINE',
    'wall-tile--live': liveTileKey.value === tile.key
  }
}

/** 点击进这一格的监测页：路径与监测页自己写的 query 格式一致（`?device=`）。 */
function openMonitor(tile: ChannelWallTile): void {
  devices.select(tile.deviceId)
  void router.push({ path: '/monitor', query: { device: tile.deviceId } })
}

function setLayout(option: ChannelWallLayout): void {
  wall.setLayout(option)
}

function setGraph(option: ChannelGraphKind): void {
  wall.setGraph(option)
}

function prevPage(): void {
  wall.setPage(clampPage(wall.page - 1, tiles.value, layout.value))
}

function nextPage(): void {
  wall.setPage(clampPage(wall.page + 1, tiles.value, layout.value))
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

/**
 * 通道表还没到手、并且**值得去要**的声纹设备。
 *
 * 总览页原来从不读通道（只有设备列表/详情/监测页会读），可通道墙没有通道就只是
 * 一句“暂无通道”，所以这里要替它把通道表取回来。两个条件都必须有：
 *
 *  - **离线设备不发请求**。设备都连不上，`getChannels` 必然失败，而失败的
 *    `loadChannels()` 会把 `devices.error` 写成“设备当前离线，无法连接”，于是总览页
 *    顶部会冒出一条红色告警 —— 可“这台设备离线”在这一页已经由统计卡、设备列表和
 *    格子上的虚线边框说清楚了，再以“错误”的形式重复一次只会让人以为出了新问题。
 *    这类设备会被 `tilelessDevices()` 报成“尚未返回通道表”，一样看得见。
 *  - **已经有通道表的不再进列表**。`loadChannels()` 自带缓存，重复调用不会重复打
 *    设备；把它们排除掉是为了让这个监听源在通道到手后稳定下来，不再无谓地触发。
 *    设备从离线恢复成在线时会重新进入列表，通道表也就在那一刻补上。
 */
const pendingBoxes = computed(() =>
  devices.devices.filter(
    (device) =>
      device.kind === 'acousticBox' &&
      device.status !== 'OFFLINE' &&
      !devices.channels[device.id]
  )
)

/**
 * 监听源用“待拉取的设备 id 拼成的字符串”。
 *
 * 直接 watch `devices.devices` 会在每次心跳（在线/离线翻转、lastSeen 更新）时触发，
 * 而那些推送并不改变通道表。字符串比较只在设备真正进/出这个集合时才变化。
 */
const pendingBoxKey = computed(() => pendingBoxes.value.map((device) => device.id).join(','))

async function loadBoxChannels(): Promise<void> {
  await Promise.all(pendingBoxes.value.map((device) => devices.loadChannels(device.id)))
}

watch(pendingBoxKey, () => void loadBoxChannels(), { immediate: true })

/** 秒级时钟：相机通道的“是否还在收”由 store 依据它判定。 */
let clock: ReturnType<typeof setInterval> | undefined

/**
 * 把相机 store 指到墙上的第一台相机 —— **只在它还没有选中任何相机时**。
 *
 * 为什么不能只在 `onMounted` 里做一次（这一版实测出来的坑）：设备列表是异步读回来的
 * （`AppShell` 在会话开始时读），而总览是启动后第一个渲染的页面，所以组件挂载那一刻
 * `devices.devices` 往往还是空的。挂载时只选一次的写法会让 `camera.deviceId` 一直是
 * 空串，而 `stores/fa371Stream.ts` 的推送过滤器（`belongs()`）会把**每一帧**都丢掉：
 * 格子永远写「未监测」，可真正的原因是墙自己没选设备 —— 一句与事实不符的说明。
 *
 * 已经选中过就绝不改选：那会把监测页正在看的画面抢走。
 */
watch(
  cameraDevices,
  (list) => {
    if (camera.deviceId !== '') return
    const first = list[0]
    if (first) camera.selectDevice(first.id)
  },
  { immediate: true }
)

/**
 * 选中设备（或被别处改选）之后补读一次主进程的会话状态。
 *
 * 会话可能在挂载之前就已经在主进程里跑着（监测页留下的、或别的窗口/探针开的），而
 * store 的 `state`/`running` 只有收到推送才会变成 `running`。不补读这一下，声纹图与
 * 频谱图会卡在“主进程明明在推、界面却说未监测”的状态里。这是一次只读 IPC。
 */
watch(
  () => camera.deviceId,
  (id) => {
    if (id !== '') void camera.refreshState()
  }
)

/**
 * store 还不知道有会话、可帧已经到了：向主进程对一次账。
 *
 * 这一条是**实测**出来的（真机跑本轮探针时抓到）：`FA371_STREAM_START` 在挂上帧转发
 * **之前**就已经 emit 了一次会话状态（见 `src/main/ipc/handlers.ts` 的
 * `attachFa371StreamForwarding`），所以由**别处**发起的会话（另一个窗口、监测页留下的、
 * 探针）不会以推送的形式到达本窗口 —— store 的 `state` 停在 `idle`，`channelPhase()`
 * 于是回答 `not-started`，格子写「未监测」，而实际上帧正在一帧一帧地到。
 *
 * `refreshState()` 这个只读 IPC 正是 `stores/fa371Stream.ts` 为“会话是别处开的”准备的
 * （它自己的注释就这么写）。这里只在帧真的到了的时候叫它一次，**不是轮询**：对账一旦
 * 成功，`isActive` 为真，这个监听就再也不触发；而帧没有到的时候它根本不会触发。
 */
let reconciling = false
async function reconcileCameraSession(): Promise<void> {
  if (reconciling) return
  reconciling = true
  try {
    await camera.refreshState()
  } finally {
    reconciling = false
  }
}

watch(
  () => camera.frameCountOf('voiceprintData') + camera.frameCountOf('fftData'),
  (frames) => {
    if (frames <= 0 || camera.isActive || camera.deviceId === '') return
    void reconcileCameraSession()
  }
)

onMounted(async () => {
  // 相机数据流的启停属于监测页（`fa371Stream.start` 在主进程里还有管理员守卫）。
  // 通道墙只“看”：把主进程里可能已经存在的那条会话读回来并接上推送，
  // 绝不主动 start()，也就不可能在总览页上悄悄打开一次硬件连接。
  camera.subscribe()
  // 挂载时对一次账：会话可能在别的路由上就已经开着了（`refreshState()` 自己的注释
  // 写的就是这个用途）。设备还没选中时它什么都不做。
  if (camera.deviceId !== '') await camera.refreshState()
  clock = setInterval(() => camera.touchClock(), 1_000)
})

onBeforeUnmount(() => {
  if (clock !== undefined) clearInterval(clock)
  // 释放监听，但不调用 `camera.stop()`：会话不是通道墙启动的，它不替监测页收摊。
  // 这里可以放心地无条件释放：持有相机会话的面板只存在于监测页，两条路由不会同时
  // 挂载，所以总览页挂载期间唯一的订阅者就是本组件 —— 卸下自己装的那一副监听，
  // 不会误伤别人（而漏掉这一句，回调闭包和 45 kB/帧 的 JPEG 会跟着窗口活到最后）。
  camera.unsubscribe()
})
</script>

<template>
  <!-- 一台设备都没有时整块不渲染：本页「设备状态」卡片已经在说「尚未添加设备」。 -->
  <section v-if="devices.devices.length > 0" class="card wall">
    <div class="section-header wall__head">
      <div class="wall__titles">
        <h2 class="section-title">{{ t('channelWall.title') }}</h2>
      </div>

      <!--
        收起 / 展开：真正的 `<button>`。`aria-expanded` 说出它此刻是收起的还是展开的
        （键盘与读屏用户据此知道能不能展开），按钮名字说出按下去会发生什么 ——
        与相机墙「按钮的无障碍名字跟着真实状态走」是同一条规矩。
        位置在标题右边：它是这一块的“抽屉把手”，**最右端留给两个切换器**，
        因为同一页上相机墙的档位控件就在最右端（同一个动作必须长得一样）。
      -->
      <button
        type="button"
        class="chip wall__disclosure"
        :class="{ 'wall__disclosure--collapsed': collapsed }"
        :aria-expanded="!collapsed"
        :aria-label="disclosureLabel"
        :title="disclosureLabel"
        @click="toggleCollapsed"
      >
        <svg class="wall__chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path
            d="M6 3.5 L10.5 8 L6 12.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>

      <div class="spacer"></div>

      <span class="muted wall__summary">
        {{ t('channelWall.summary', { count: channelTileCount(tiles) }) }}
      </span>

      <!--
        图形类型：右对齐的图标分段控件，与档位控件同一套观感（同一个总览页上的同一类
        动作必须长得一样）。整面墙共用一种图形，理由见 `lib/channelWall.ts` 的
        `CHANNEL_GRAPH_KINDS`：一种图形只有一条状态、一份持久化。
        四个按钮只有图标，无障碍名字由 `aria-label` 给出，`aria-pressed` 只有一个为真。
      -->
      <div class="wall__graph" role="group" :aria-label="t('channelWall.graphLabel')">
        <button
          v-for="option in CHANNEL_GRAPH_KINDS"
          :key="option"
          type="button"
          class="chip wall__option"
          :class="{ 'chip--accent': option === wall.graph, 'wall__option--active': option === wall.graph }"
          :aria-pressed="option === wall.graph"
          :aria-label="t(graphLabelKey(option))"
          :title="t(graphLabelKey(option))"
          @click="setGraph(option)"
        >
          <ChannelGraphIcon :kind="option" />
        </button>
      </div>

      <!--
        分屏档位：右对齐的图标分段控件，与视频墙的档位控件同一套观感。
        图标由真实网格的列数算出（`layoutColumns()`）。
        渲染哪几档由 `layoutOptions` 给（`channelWallLayouts()`，纯函数）：**按设备
        真实的通道数裁剪** —— 2 路设备只给 1 / 2，8 路设备给 1 / 2 / 4 / 8，通道表还没
        读到时不裁剪。所以模板里没有"设备有几路"这个判断。
      -->
      <div class="wall__layout" role="group" :aria-label="t('channelWall.layoutLabel')">
        <button
          v-for="option in layoutOptions"
          :key="option"
          type="button"
          class="chip wall__option"
          :class="{ 'chip--accent': option === layout, 'wall__option--active': option === layout }"
          :aria-pressed="option === layout"
          :aria-label="t(layoutLabelKey(option))"
          :title="t(layoutLabelKey(option))"
          @click="setLayout(option)"
        >
          <LayoutGridIcon :count="option" :columns="layoutColumns(option)" />
        </button>
      </div>
    </div>

    <!--
      收起时的那一句：说出**为什么**是收起的，而不是让一排空白看起来像坏了
      （产品要求的那条默认收起，前提正是“没有通道在线”）。
    -->
    <p v-if="collapsed && !anyOnlineChannel" class="muted wall__collapsed-hint">
      {{ t('channelWall.collapsedNoChannel') }}
    </p>

    <template v-if="!collapsed">
      <!-- 一页装得下就不显示分页控件：没有第二页时那组按钮只是噪音。 -->
      <div v-if="pageCount > 1" class="wall__pager">
        <button type="button" class="btn btn--sm" :disabled="currentPage <= 1" @click="prevPage">
          {{ t('channelWall.prevPage') }}
        </button>
        <span class="muted wall__page-indicator">
          {{ t('channelWall.pageIndicator', { page: currentPage, total: pageCount }) }}
        </span>
        <button
          type="button"
          class="btn btn--sm"
          :disabled="currentPage >= pageCount"
          @click="nextPage"
        >
          {{ t('channelWall.nextPage') }}
        </button>
      </div>

      <!-- 有设备却没格子：说实话，而不是画一排设备端从没上报过的通道；全空时交给空状态。 -->
      <p
        v-if="tiles.length > 0 && tileless.length > 0"
        class="alert alert--warning wall__notice"
        role="note"
      >
        {{ t('channelWall.noChannelTable', { count: tileless.length }) }}
      </p>

      <div v-if="tiles.length === 0" class="wall__empty">
        <p v-if="channelsLoading" class="muted">{{ t('channelWall.loading') }}</p>
        <EmptyState
          v-else
          :title="t('channelWall.empty')"
        />
      </div>

      <div v-else class="wall__grid" :class="`wall__grid--${layout}`" :style="gridStyle">
        <button
          v-for="tile in pageTiles"
          :key="tile.key"
          type="button"
          class="wall-tile"
          :class="tileClass(tile)"
          :title="tileView(tile).note"
          @click="openMonitor(tile)"
        >
          <span class="wall-tile__head">
            <span class="wall-tile__device" :title="tile.deviceName">{{ tile.deviceName }}</span>
            <StatusBadge :status="tile.deviceStatus" dot-only />
          </span>

          <span class="wall-tile__ident">
            <span class="wall-tile__label">{{ tileLabel(tile) }}</span>
            <span v-if="tile.channelName" class="wall-tile__sub" :title="tile.channelName">
              {{ tile.channelName }}
            </span>
          </span>

          <!-- 通道状态徽标：相机没有通道，因此这一行对它不出现（不编造状态）。 -->
          <span
            v-if="tile.state"
            class="badge wall-tile__badge"
            :class="[channelStateClass(tile.state), stateBadgeTone(tile.state)]"
            :title="stateHint(tile.state) || undefined"
          >
            {{ t(channelStateLabelKey(tile.state)) }}
          </span>

          <!--
            这一路的**最近一条**告警（本地告警库里的记录，不是实时状态）。
            措辞固定为「最近告警」：契约里没有每通道的实时告警推送，写「正在告警」
            就是编造（理由见文件头）。相机没有通道，所以这一行对它不出现。
          -->
          <span
            v-if="tile.source === 'boxChannel'"
            class="wall-tile__alarm"
            :title="alarmTitle(tile)"
          >
            <span class="wall-tile__alarm-label">{{ t('channelWall.alarm.recent') }}</span>
            <span class="wall-tile__alarm-value">{{ alarmText(tile) }}</span>
          </span>

          <!-- 格子内部一律用 span：button 只允许短语内容，div/header 不是合法结构。 -->
          <!-- 声纹设备的一路通道 -->
          <span v-if="tile.source === 'boxChannel'" class="wall-tile__body">
            <!--
              选中的图形有真实数据就画它；没有则由下面那句说明**哪一种**原因
              （该设备没有这种载荷 / 一帧都没有 / 已停止 / 报错 / 未监测）。
              两个分支互斥：画得出图的时候就不再重复写一句。
            -->
            <ChannelGraph
              :kind="wall.graph"
              :image="tileView(tile).graph?.image"
              :image-alt="tileView(tile).graph?.imageAlt"
              :values="tileView(tile).graph?.values"
              :caption="tileView(tile).graph?.caption"
            />
            <span v-if="!tileView(tile).graph" class="wall-tile__note">
              {{ tileView(tile).note }}
            </span>

            <span v-if="hasLiveMetrics(tile)" class="wall-tile__metrics">
              <!--
                声压读数的单位 `dB` 是**本仓库的标注**，不是设备给的（元素上的
                `title` 与目录里的词条是它的出处）：设备推的字段名是
                `sound_pressure_level`，本仓库里没有任何盒子手册能证明它是 dB
                （唯一一处 dB 定义来自 FA371 相机手册，基准 20 µPa）。数值照常显示，
                但谁也不该把它当成一台校准过的声级计。改动这段前请先读
                `docs/PROTOCOL-FINDINGS.md` 与 `ChannelWall.vue` 文件头第 3 条规矩。
              -->
              <span class="wall-tile__metric" :title="t('channelWall.graph.splUnitNote')">
                <span class="wall-tile__metric-label">{{ t('metrics.spl') }}</span>
                <span class="wall-tile__metric-value">
                  {{ formatNumber(liveFrame!.spl, 1) }}<span
                    class="wall-tile__metric-unit"
                    :title="t('channelWall.graph.splUnitNote')"
                  >{{ t('channelWall.graph.splUnit') }}</span>
                </span>
              </span>
              <span class="wall-tile__metric">
                <span class="wall-tile__metric-label">{{ t('metrics.mainFrequency') }}</span>
                <span class="wall-tile__metric-value">{{ formatHz(liveFrame!.mainFrequency) }}</span>
              </span>
            </span>
            <!-- 有音频帧才画电平条：没有数据时留白，而不是画一根 0 的条。 -->
            <span v-if="hasLiveMetrics(tile) && liveAudio" class="bar wall-tile__level">
              <span class="bar__fill" :style="{ width: liveLevelWidth }"></span>
            </span>
          </span>

          <!-- 声学相机：没有通道，一格就代表它自己 -->
          <span v-else class="wall-tile__body wall-tile__body--camera">
            <ChannelGraph
              :kind="wall.graph"
              :image="tileView(tile).graph?.image"
              :image-alt="tileView(tile).graph?.imageAlt"
              :values="tileView(tile).graph?.values"
              :caption="tileView(tile).graph?.caption"
            />
            <span v-if="!tileView(tile).graph" class="wall-tile__note">
              {{ tileView(tile).note }}
            </span>
          </span>
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.wall {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.wall__head {
  /* 标题与三组控件在同一行上，所以按中线对齐，而不是按上沿。 */
  align-items: center;
  margin-bottom: 0;
}

.wall__titles {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.wall__summary {
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

/* --- 收起 / 展开 --------------------------------------------------------- */

/*
 * `.chip` 默认 `cursor: default`（它是标签），这里它是可点的按钮；
 * 尺寸与两个切换器的按钮同高，三者在同一行上不会一高一矮。
 */
.wall__disclosure {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  padding: 0;
  cursor: pointer;
  border-color: transparent;
  background: transparent;
  color: var(--color-text-secondary);
}

.wall__disclosure:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text);
}

.wall__disclosure:focus-visible {
  outline: 2px solid var(--color-accent-border);
  outline-offset: 1px;
}

/* 展开时箭头朝下、收起时朝右：同一个图标转 90°，状态一眼看得出来。 */
.wall__chevron {
  display: block;
  width: 14px;
  height: 14px;
  transform: rotate(90deg);
  transition: transform 0.15s ease;
}

.wall__disclosure--collapsed .wall__chevron {
  transform: rotate(0deg);
}

.wall__collapsed-hint {
  font-size: 12px;
}

/* --- 图形 / 档位分段控件（只有图标） ------------------------------------- */

.wall__graph,
.wall__layout {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-bg-subtle);
}

/*
 * 两组控件之间留一点空：它们是两件事（画什么 / 一屏几格），贴在一起会被读成一组。
 */
.wall__graph {
  margin-right: var(--space-2);
}

.wall__option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  padding: 0;
  cursor: pointer;
  border-color: transparent;
  background: transparent;
  color: var(--color-text-secondary);
}

.wall__option:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text);
}

.wall__option--active,
.wall__option--active:hover {
  border-color: var(--color-accent-border);
  background: var(--color-accent-soft);
  color: var(--color-accent-hover);
}

.wall__option:focus-visible {
  outline: 2px solid var(--color-accent-border);
  outline-offset: 1px;
}

/* --- 分页 ---------------------------------------------------------------- */

.wall__pager {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.wall__page-indicator {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.wall__notice {
  font-size: 12px;
}

.wall__empty {
  padding: var(--space-2);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-lg);
  background: var(--color-bg-subtle);
  text-align: center;
}

/* --- 网格 ---------------------------------------------------------------- */

/*
 * 行高用 `minmax(0, 1fr)` 等分：格子始终撑满整块区域，任何档位下都不会出现
 * 半块空白。列数由 `layoutColumns()` 通过 `--wall-columns` 给到 CSS，
 * 于是“几列”只有一个定义处。`minmax(0, ...)` 同时挡住长设备名把网格撑宽。
 */
.wall__grid {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(var(--wall-columns, 1), minmax(0, 1fr));
  grid-auto-rows: minmax(0, 1fr);
  min-width: 0;
}

/*
 * 8 分屏的格子必然很小，所以字号随档位缩小，并且始终以变量下发：
 * 名字、数值、说明三处一起变，不会出现“名字缩了、数值没缩”的错位。
 */
.wall__grid--1 {
  height: clamp(320px, 42vh, 520px);
  --wall-name-size: 15px;
  --wall-metric-size: 26px;
  --wall-note-size: 12.5px;
}

.wall__grid--2 {
  height: clamp(340px, 46vh, 560px);
  --wall-name-size: 14px;
  --wall-metric-size: 22px;
  --wall-note-size: 12px;
}

.wall__grid--4 {
  height: clamp(380px, 54vh, 620px);
  --wall-name-size: 13px;
  --wall-metric-size: 19px;
  --wall-note-size: 12px;
}

.wall__grid--8 {
  height: clamp(460px, 62vh, 720px);
  --wall-name-size: 12px;
  --wall-metric-size: 16px;
  --wall-note-size: 11px;
}

/* --- 单个格子 ------------------------------------------------------------ */

.wall-tile {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 9px 10px;
  text-align: left;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg);
  color: var(--color-text);
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.wall-tile:hover {
  border-color: var(--color-border-strong);
  box-shadow: var(--shadow-md);
}

.wall-tile:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

/*
 * 未启用：整块压暗，语义与通道配置表一致；但**不禁用点击** ——
 * 灰色表达的是“设备端这一路没开”，不是“不许去看”。
 */
.wall-tile--disabled {
  background: var(--color-bg-subtle);
  opacity: 0.55;
}

.wall-tile--disabled:hover,
.wall-tile--disabled:focus-visible {
  opacity: 1;
}

/* 状态未知：警告底色。读完状态之前，它必须与“明确关闭”的灰明显不同。 */
.wall-tile--unknown {
  background: var(--color-warning-soft);
}

/* 设备离线：虚线边框，与“通道被关掉”区分开。 */
.wall-tile--offline {
  border-style: dashed;
}

/* 正在接收数据的那一格。 */
.wall-tile--live {
  border-color: var(--color-success-border);
  background: var(--color-success-soft);
}

.wall-tile__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.wall-tile__device {
  min-width: 0;
  font-size: var(--wall-name-size, 12.5px);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wall-tile__ident {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.wall-tile__label {
  flex: none;
  font-size: var(--wall-note-size, 12px);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-secondary);
}

/* 长通道名截断，绝不把网格撑宽。 */
.wall-tile__sub {
  min-width: 0;
  font-size: var(--wall-note-size, 12px);
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wall-tile__badge {
  align-self: flex-start;
  flex: none;
  font-size: 11px;
  padding: 0 7px;
}

.wall-tile__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  min-width: 0;
  min-height: 0;
}

/*
 * 最近告警：两行以内（标签一行、值一行），字号跟着档位走。
 * `flex: none` 让它不被下面的图形区挤掉 —— 8 分屏时格子很小，先保证这一行看得见，
 * 图形区自己会被压缩（它的 `min-height` 是 0）。
 */
.wall-tile__alarm {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.wall-tile__alarm-label {
  font-size: 10.5px;
  color: var(--color-text-secondary);
}

.wall-tile__alarm-value {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: var(--wall-note-size, 12px);
  font-variant-numeric: tabular-nums;
  color: var(--color-text);
  overflow-wrap: anywhere;
}

.wall-tile__body--camera {
  align-items: stretch;
}

.wall-tile__metrics {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 14px;
  min-width: 0;
}

.wall-tile__metric {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.wall-tile__metric-label {
  font-size: 10.5px;
  color: var(--color-text-secondary);
}

.wall-tile__metric-value {
  font-size: var(--wall-metric-size, 18px);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.wall-tile__metric-unit {
  margin-left: 3px;
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-secondary);
}

.wall-tile__level {
  /* 全局 `.bar` 是给块级元素写的，这里的宿主是 span，所以补上 display。 */
  display: block;
  flex: none;
  margin-top: 2px;
}

.wall-tile__level .bar__fill {
  display: block;
}

/* 说明文字最多三行，超出即截断，8 分屏下也不会把格子撑破。 */
.wall-tile__note {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  font-size: var(--wall-note-size, 12px);
  color: var(--color-text-secondary);
}

/*
 * 图形（声纹图 / 声压线 / 频谱图 / 时谱图）的样式住在 `ChannelGraph.vue` 自己的
 * scoped 样式里：子组件内部的元素带的是子组件的作用域属性，写在这里的规则
 * 匹配不到它们（Vue 的 scoped CSS 只给子组件的**根节点**加上父作用域属性）。
 */
</style>
