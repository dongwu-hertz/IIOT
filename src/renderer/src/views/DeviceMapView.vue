<script setup lang="ts">
/**
 * **地图信息（GIS）**（原「点位图」，业主 2026-09-17 第 8 批建的页；2026-09-18 第 10 批
 * 第 12 条改名并挪到设备管理之前，第 13/14/17 条重排了这一页的版面）。
 *
 * ---------------------------------------------------------------------------
 * 版面（业主第 13、17 条）
 * ---------------------------------------------------------------------------
 *   ① 地图区：**16:9、占满内容宽度**，在最上面；
 *   ② 地图**下方依次**三张列表：设备列表 → 告警列表 → 实时数据列表。
 *
 * 业主原话是「GIS 页右侧 16:9 占满宽度地图区」。这一页**没有左栏**（第 5 条之后连设备管理
 * 都没有左栏），所以"右侧"只能读成"内容区里那一块主区域"：地图占满整宽、按 16:9 定高。
 * 这与第 17 条的"地图下方依次…"是同一种版面，而"左边一列 + 右边地图"与"下方三张列表"
 * 合不到一起。**这是我们的读法**，若你要的是左栏版式，回一句就改。
 *
 * ---------------------------------------------------------------------------
 * 三件必须说清楚的事
 * ---------------------------------------------------------------------------
 * 1. **底图是我们自己画的**（`shared/domain/device-map.ts`）。渲染层不联网、仓库里也没有
 *    地图库，所以图上只有经纬度网格与落点，没有街道与建筑。业主选的就是这一条。
 * 2. **没录点位的设备不画在图上**，而是单独列出来：它们不是"在图上的某个位置"，
 *    把它们堆在角落比不画更糟（点一下会以为是别人的点位）。补录入口写在那一句下面。
 * 3. **抓图有三种状态，界面分开说**：有图 / 设备上本来就没有（`not-captured`）/
 *    库里记着但文件已不在（`files-gone`）。合成一句"没有图"会让操作员以为同步坏了。
 *
 * 抓图与相机直播一样走**主进程回环 HTTP**（图片字节不过 IPC）：`alarms.snapshot_dir` 记的是
 * 本机磁盘上的目录，渲染层读不了文件。离开这一页时会显式关掉那个端点（TTL 是兜底）。
 *
 * ---------------------------------------------------------------------------
 * 落点配色（业主第 14 条）与它的一条取舍
 * ---------------------------------------------------------------------------
 * 在线**绿** / 有告警**红** / 离线**灰**。三种颜色在**同一台设备上可能同时成立**
 * （一台离线的设备也可能有未确认的告警），所以必须定一个优先级 —— 我们定的是
 * **告警 > 在线 > 离线**：这台设备有事，比"它现在连不上"更要紧，而灰色不传达任何紧迫性。
 * `UNKNOWN`（还没探活过）算**灰**，不算绿：绿点会被读成"它在工作"，那是界面在说一件
 * 没被证实的事（与第 19 条那个设备下拉旁边的小圆点同一条口径）。
 * 三个颜色都配一句文字（图例 + 每一行的状态列），不靠颜色单独承载信息。
 *
 * ---------------------------------------------------------------------------
 * 实时数据列表里那一列「平稳度」（业主第 17 条给的三列之一）
 * ---------------------------------------------------------------------------
 * 业主给的三列是 分贝 / 稳定度 / 方位。**用词在 2026-09-19 定下来了**：他说「用**平稳度**表示」，
 * 也就是这一列取本仓库的 `smoothness`（设备随每条告警上报的一个真实测量值，
 * `AlarmEvent.smoothness`）。
 *
 * 所以这一列**不再是空的**：它与分贝取自**同一条告警**，两列永远对应同一时刻。
 * 在此之前这里恒为「—」，并写着"手册未说明这个量"—— 那段说明随这次澄清一起下架
 * （当时的判断没错，是当时的用词没定）。
 */

import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { AlarmEvent, Device } from '@shared/domain/models'
import type { CameraLiveStatus } from '@shared/domain/camera-live'
import type { E2AlarmSnapshotView, E2SyncOutcome } from '@shared/ipc/contract'
import {
  deviceMapLayout,
  mapGridSteps,
  mapProjector,
  type MapDeviceInput
} from '@shared/domain/device-map'
import { isPointComplete } from '@shared/domain/device-installation'
import { useDevicesStore } from '@renderer/stores/devices'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { formatDateTime, formatNumber } from '@renderer/lib/format'
import EmptyState from '@renderer/components/EmptyState.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'

const { t } = useI18n()
const router = useRouter()
const devices = useDevicesStore()

/**
 * 画布的逻辑尺寸：SVG 用 `viewBox` 缩放到容器宽度，所以这是一套"逻辑坐标"。
 *
 * **就是 16:9**（1280×720），与外面那个 `.map-canvas-frame` 的 `aspect-ratio` 同一个比例 ——
 * 两边不一致时 SVG 会按 `preserveAspectRatio` 留白，图上就会出现两条看不懂的边。
 */
const CANVAS = { width: 1280, height: 720 }

/**
 * 画布四周的留白（**逻辑坐标**）。
 *
 * 1280 宽的画布比原来的 760 宽得多，所以同一个 28 在屏幕上只剩一半 —— 标记有半径、
 * 名字写在旁边，贴着边画会被裁掉。`deviceMapLayout` 与 `mapProjector` **必须传同一个数**：
 * 网格线与落点用的是同一套投影，两个 padding 不一致会让网格与点错位。
 */
const MAP_PADDING = 48

const loading = ref(false)
const selectedId = ref('')
const alarms = ref<AlarmEvent[]>([])
const alarmsLoading = ref(false)
const selectedAlarmId = ref('')
const snapshots = ref<E2AlarmSnapshotView | null>(null)
const snapshotsLoading = ref(false)
const syncing = ref(false)
const syncOutcome = ref<E2SyncOutcome | null>(null)
const actionError = ref('')

/**
 * 每台设备的告警事实（第 14 条的落点颜色与第 17 条的设备列表都要它）。
 *
 * 两个数都必须能区分"0"与"没读到"：`-1` 表示那一次 IPC 失败。把失败当成 0 会让一台
 * **有告警**的设备在图上变成绿点 —— 界面替设备说了"它没事"。
 */
interface DeviceAlarmFacts {
  /** 本机库里这台设备的告警总条数（`-1` = 没读到）。 */
  total: number
  /** 其中**未确认**的条数（`-1` = 没读到）。红色只看这一个数。 */
  pending: number
  /** 最近一条告警上报的声压级（没有告警、或那条没有 spl 时缺席）。 */
  latestSpl?: number
  /** 同一条告警上报的平稳度（`smoothness`）；与 `latestSpl` 同源同时刻。 */
  latestSmoothness?: number
}
const alarmFacts = ref<Record<string, DeviceAlarmFacts>>({})

/**
 * 图上的输入：**只有录全了点位的设备**（经纬度成对，`isPointComplete` 与录入侧同一判据）。
 *
 * 这里刻意把"半个点位"和"没有点位"都交给 `withoutPoint`：一台只录了纬度的设备在图上是
 * 一个没有意义的点，而它出现在"未录入点位"那一列时，操作员知道该去补什么。
 */
const mapInputs = computed<MapDeviceInput[]>(() =>
  devices.devices.map((device) => {
    const installation = device.installation
    const input: MapDeviceInput = { id: device.id, name: device.name, kind: device.kind }
    if (
      installation &&
      isPointComplete(installation) &&
      installation.gisLatitude !== undefined &&
      installation.gisLongitude !== undefined
    ) {
      input.latitude = installation.gisLatitude
      input.longitude = installation.gisLongitude
    }
    return input
  })
)

const layout = computed(() =>
  deviceMapLayout(mapInputs.value, CANVAS.width, CANVAS.height, MAP_PADDING)
)
const grid = computed(() => {
  const bounds = layout.value.bounds
  return bounds ? mapGridSteps(bounds) : { lat: [], lon: [] }
})

/**
 * 网格线与设备落点用**同一个投影器**（`mapProjector`）：抄第二份算式迟早会与点错位，
 * 而错位的表现是"设备看起来不在那个刻度上"。
 */
const project = computed(() => {
  const bounds = layout.value.bounds
  return bounds ? mapProjector(bounds, CANVAS.width, CANVAS.height, MAP_PADDING) : null
})

function gridLineY(latitude: number): number {
  return project.value ? project.value.y(latitude) : 0
}

function gridLineX(longitude: number): number {
  return project.value ? project.value.x(longitude) : 0
}

const selectedDevice = computed<Device | undefined>(() =>
  selectedId.value === '' ? undefined : devices.byId(selectedId.value)
)

/** 这一台是不是**空气声呐**（只有它才有球机抓图那一套）。 */
const selectedIsSonar = computed(
  () => selectedDevice.value?.kind === 'auscultationBox' && selectedDevice.value?.e2Variant === 'airSonar'
)

const pointText = computed(() => {
  const installation = selectedDevice.value?.installation
  if (!installation || installation.gisLatitude === undefined) return t('installUi.unset')
  return `${installation.gisLatitude}, ${installation.gisLongitude}`
})

/**
 * 一台设备的**点位文字**（设备列表那一列）。
 *
 * 只有经纬度成对时才算一个点位 —— 与图上"要不要画"用的是同一个判据（`isPointComplete`），
 * 所以列表里写着点位的那几台，一定就是图上有标记的那几台。
 */
function devicePointText(device: Device): string {
  const installation = device.installation
  if (!installation || !isPointComplete(installation) || installation.gisLatitude === undefined) {
    return t('installUi.unset')
  }
  return `${installation.gisLatitude}, ${installation.gisLongitude}`
}

/**
 * 落点的三种色调（业主第 14 条）。
 *
 * 优先级 **告警 > 在线 > 离线**：一台设备可能同时"离线"且"有未确认的告警"，而灰色不传达
 * 任何紧迫性。`UNKNOWN` 归灰（还没探活过 ≠ 它在工作）。
 * 没读到告警数（`-1`）时**不**当告警处理：不能因为一次 IPC 失败就把整张图染红。
 */
function markerTone(device: Device): 'alarm' | 'online' | 'offline' {
  const facts = alarmFacts.value[device.id]
  if (facts && facts.pending > 0) return 'alarm'
  return device.status === 'ONLINE' ? 'online' : 'offline'
}

/** 图上每一个标记的色调（按 id 查一次，模板里不用重复算）。 */
const markerTones = computed<Record<string, 'alarm' | 'online' | 'offline'>>(() => {
  const out: Record<string, 'alarm' | 'online' | 'offline'> = {}
  for (const marker of layout.value.markers) {
    const device = devices.byId(marker.id)
    out[marker.id] = device ? markerTone(device) : 'offline'
  }
  return out
})

/** 图上三种色调各有多少台（图例上直接给数，比只有颜色更有用）。 */
const toneCounts = computed(() => {
  const counts = { alarm: 0, online: 0, offline: 0 }
  for (const tone of Object.values(markerTones.value)) counts[tone] += 1
  return counts
})

function alarmCell(deviceId: string): string {
  const facts = alarmFacts.value[deviceId]
  if (!facts || facts.pending < 0) return t('mapUi.notRead')
  return String(facts.pending)
}

/** 实时数据那一行：分贝取最近一条告警上报的声压级。 */
function liveDb(deviceId: string): string {
  const facts = alarmFacts.value[deviceId]
  if (!facts || facts.total < 0) return t('mapUi.notRead')
  return facts.latestSpl === undefined ? t('mapUi.none') : `${formatNumber(facts.latestSpl, 1)} dB`
}

/**
 * 实时数据那一行的**平稳度**：最近一条告警上报的 `smoothness`。
 *
 * 业主 2026-09-19 澄清「用平稳度表示」之后，这一列**不再是恒为「—」的空列** ——
 * 他说的「稳定度」就是本仓库的 `smoothness`（设备随每条告警上报的一个真实测量值）。
 * 它与分贝取自**同一条告警**，所以两列永远对应同一时刻（这也是把它们放在同一行、
 * 同一句 `mapUi.liveHint` 里的原因）。
 */
function liveSmoothness(deviceId: string): string {
  const facts = alarmFacts.value[deviceId]
  if (!facts || facts.total < 0) return t('mapUi.notRead')
  return facts.latestSmoothness === undefined
    ? t('mapUi.none')
    : formatNumber(facts.latestSmoothness, 3)
}

/**
 * 实时数据那一行的方位角：**录入的方位角**（`installation.azimuthDeg`）。
 *
 * 空气声呐的实时帧里还有一个 `energyAzimuth`（当前帧声源的方位），那是"此刻朝哪"，
 * 与"这台设备装成什么朝向"是两件事 —— 这里给的是后者（有录入就有值），
 * 前者属于实时监测页的能量点表。
 */
function liveAzimuth(device: Device): string {
  const azimuth = device.installation?.azimuthDeg
  return azimuth === undefined ? t('installUi.unset') : `${azimuth}°`
}

async function loadDeviceAlarmFacts(): Promise<void> {
  const next: Record<string, DeviceAlarmFacts> = {}
  for (const device of devices.devices) {
    // 两条查询：一条要"最近那条"（分贝），一条要"还没确认的有几条"（红点）。
    const all = await callApi(() => window.api.alarms.query({ deviceId: device.id, limit: 1 }))
    const pending = await callApi(() =>
      window.api.alarms.query({ deviceId: device.id, acknowledged: false, limit: 1 })
    )
    const latest = all.success ? unwrap(all)?.items?.[0] : undefined
    const facts: DeviceAlarmFacts = {
      total: all.success ? (unwrap(all)?.total ?? 0) : -1,
      pending: pending.success ? (unwrap(pending)?.total ?? 0) : -1
    }
    if (latest?.spl !== undefined) facts.latestSpl = latest.spl
    if (latest?.smoothness !== undefined) facts.latestSmoothness = latest.smoothness
    next[device.id] = facts
  }
  alarmFacts.value = next
}

function selectDevice(deviceId: string): void {
  selectedId.value = deviceId
  selectedAlarmId.value = ''
  snapshots.value = null
  void loadAlarms(deviceId)
  void closeSnapshots()
}

/** 双击一行设备 = 进这一台的详情页（业主第 16 条；声纹设备与相机都走这一条）。 */
function openDeviceDetail(deviceId: string): void {
  void router.push({ path: `/devices/${deviceId}` })
}

// ---------------------------------------------------------------------------
// 悬停浮层（业主第 15、16 条）
// ---------------------------------------------------------------------------

const hoveredId = ref('')

const hoveredDevice = computed<Device | undefined>(() =>
  hoveredId.value === '' ? undefined : devices.byId(hoveredId.value)
)

/**
 * 悬停那一台**当前的视频流状态**（只有相机有）。
 *
 * 为什么悬停要去问一次主进程：视频流的状态是主进程的事实（会话在不在、是不是
 * `rtsp-disabled`），渲染层没有第二份。一次 IPC 换一行准确的话，比在浮层里写一句
 * "未知"好。
 *
 * **浮层里不放 `<video>`**：主进程对一台相机只有一条会话、一条会话只有一个观看者，
 * 悬停去接管它会把正在看这一路的人的画面当场换掉。所以这里给状态，不给画面 ——
 * 理由写在模板那段注释里。
 */
const hoverLiveStatus = ref<CameraLiveStatus | null>(null)
const hoverLiveDiagnosis = ref('')

async function loadHoverStream(deviceId: string): Promise<void> {
  hoverLiveStatus.value = null
  hoverLiveDiagnosis.value = ''
  const result = await callApi(() => window.api.cameraLive.state(deviceId))
  // 悬停已经移走了：这一条结果不该写进另一个设备的浮层。
  if (hoveredId.value !== deviceId) return
  if (!result.success) return
  const state = unwrap(result)?.[0] ?? null
  hoverLiveStatus.value = state?.status ?? 'idle'
  hoverLiveDiagnosis.value = state?.error ?? ''
}

function openHover(deviceId: string): void {
  hoveredId.value = deviceId
  const device = devices.byId(deviceId)
  if (device?.kind === 'acousticCamera') void loadHoverStream(deviceId)
}

function closeHover(): void {
  hoveredId.value = ''
  hoverLiveStatus.value = null
  hoverLiveDiagnosis.value = ''
}

/**
 * 浮层的位置：**百分比**，不量盒子。
 *
 * 标记坐标在画布的逻辑坐标系里（`CANVAS` 1280×720），而定比例那一层
 * （`.map-canvas-frame`）与画布**恰好同比例**，所以 `x / 1280`、`y / 720` 就是它在浮层
 * 坐标系里的位置。量 `getBoundingClientRect()` 要等一帧、而且缩放或滚动时会晚一拍。
 */
const hoverStyle = computed(() => {
  const device = hoveredDevice.value
  if (!device) return {}
  const marker = layout.value.markers.find((item) => item.id === device.id)
  if (!marker) return {}
  return {
    left: `${((marker.x / CANVAS.width) * 100).toFixed(3)}%`,
    top: `${((marker.y / CANVAS.height) * 100).toFixed(3)}%`
  }
})

/**
 * 「当前视频流」那一行的文字。
 *
 * 复用 `cameraLiveUi.status*` 那几条（**一件事只有一处措辞**）：浮层上写的"RTSP 未启用"
 * 与相机页徽标上那句必须是同一句，否则同一次故障会有两种说法。
 * 主进程给了原文（诊断）时优先用它 —— 它引用了设备亲口说的话。
 */
const hoverStreamText = computed(() => {
  if (hoverLiveStatus.value === null) return t('common.loading')
  if (hoverLiveDiagnosis.value !== '') return hoverLiveDiagnosis.value
  switch (hoverLiveStatus.value) {
    case 'starting':
      return t('cameraLiveUi.statusStarting')
    case 'playing':
      return t('cameraLiveUi.statusPlaying')
    case 'rtsp-disabled':
      return t('cameraLiveUi.statusRtspDisabled')
    case 'ffmpeg-missing':
      return t('cameraLiveUi.statusFfmpegMissing')
    case 'limit-exceeded':
      return t('overviewLiveUi.statusLimitExceeded')
    case 'error':
      return t('cameraLiveUi.statusError')
    default:
      return t('cameraLiveUi.statusIdle')
  }
})

/** 有未确认告警就说条数，没有就明说没有（「—」读不出"没有"还是"没读到"）。 */
const hoverAlarmText = computed(() => {
  const device = hoveredDevice.value
  if (!device) return t('mapUi.none')
  const facts = alarmFacts.value[device.id]
  if (!facts || facts.pending < 0) return t('mapUi.notRead')
  if (facts.pending === 0) return t('mapUi.hoverNoAlarm')
  return t('mapUi.hoverAlarm', { count: facts.pending })
})

async function loadAlarms(deviceId: string): Promise<void> {
  alarmsLoading.value = true
  const result = await callApi(() => window.api.alarms.query({ deviceId, limit: 20 }))
  alarmsLoading.value = false
  if (!result.success) {
    actionError.value = resultMessage(result)
    alarms.value = []
    return
  }
  actionError.value = ''
  alarms.value = unwrap(result)?.items ?? []
}

/**
 * 同步这台设备的告警与录音。
 *
 * `downloadSpectrograms: true` 是**这一页存在的理由**：抓图要在同步时下下来才有得看
 * （SN-16 是 3 张球机抓图）。代价写在面板上：一条告警最多 3 次请求。
 */
async function syncNow(): Promise<void> {
  const device = selectedDevice.value
  if (!device) return
  syncing.value = true
  syncOutcome.value = null
  actionError.value = ''
  const result = await callApi(() =>
    window.api.e2.syncAlarms(device.id, { limit: 200, downloadAudio: true, downloadSpectrograms: true })
  )
  syncing.value = false
  if (!result.success) {
    actionError.value = resultMessage(result)
    return
  }
  syncOutcome.value = unwrap(result) ?? null
  await loadAlarms(device.id)
  // 同步会往库里加告警 —— 落点颜色与设备列表那两个数必须跟着刷新。
  await loadDeviceAlarmFacts()
}

async function openSnapshots(alarm: AlarmEvent): Promise<void> {
  const device = selectedDevice.value
  if (!device) return
  selectedAlarmId.value = alarm.id
  snapshots.value = null
  snapshotsLoading.value = true
  const result = await callApi(() => window.api.e2.alarmSnapshots(device.id, alarm.id))
  snapshotsLoading.value = false
  if (!result.success) {
    actionError.value = resultMessage(result)
    return
  }
  actionError.value = ''
  snapshots.value = unwrap(result) ?? null
}

async function closeSnapshots(): Promise<void> {
  await callApi(() => window.api.e2.closeSnapshots())
}

onMounted(async () => {
  loading.value = true
  if (devices.devices.length === 0) await devices.load()
  await loadDeviceAlarmFacts()
  // 默认选第一台**有点位**的设备：一进页面就该有东西可看。
  const first = layout.value.markers[0]
  if (first) selectDevice(first.id)
  loading.value = false
})

onUnmounted(() => {
  void closeSnapshots()
})
</script>

<template>
  <div class="page">
    <p v-if="actionError" class="alert alert--danger" role="alert">{{ actionError }}</p>

    <EmptyState v-if="devices.devices.length === 0" :title="t('devices.empty')" />

    <template v-else>
      <!--
        ① 地图区（业主第 13 条）：16:9、占满内容宽度。
        这一块**不是卡片**（`.card` 的内边距会让图左右各缩进 16px，"占满宽度"就只是近似）：
        它是一条上边线 + 一条下边线围出来的一段（与设备管理页那张扁平表同一种做法）。
        `.map-canvas-frame` 是**定比例的那一层**（`aspect-ratio: 16 / 9`），SVG 填满它；
        两者比例必须一致（`CANVAS` 也是 16:9），否则图上会出现两条留白边。
      -->
      <section class="map-panel" data-map-panel :aria-label="t('app.nav.map')">
        <!--
          **这一块原来还有一个 `<h3>` 写着页面名**，与顶栏那个标题重复（业主 2026-09-19 更正第 2 条：
          「地图信息出现了两个标题，可以把第一个删除掉」）。删掉的是**页内**那一个：
          外层框架的标题栏已经写了页面名（这也是全应用从 2026-09-16 起就有的口径 ——
          页面内不再画标题），所以页内这一个才是多出来的那一个。
          牌子上的读数（图上 N 台 / 共 M 台）留着：它不是标题，是这一块的内容。
          删掉标题之后这一块的无障碍名字改挂在 `<section>` 上（见上面的 `aria-label`）——
          否则读屏走到这里会只剩下一串数字。
        -->
        <div class="section-header">
          <span class="muted" data-map-counts>
            {{
              t('mapUi.counts', {
                withPoint: layout.markers.length,
                total: devices.devices.length
              })
            }}
          </span>
        </div>

        <!--
          图例（第 14 条）：三种颜色各配一句文字与一个数。
          颜色不单独承载信息 —— 色觉差异下这张图仍然读得出来。
        -->
        <ul class="map-legend" data-map-legend>
          <li class="map-legend__item" data-legend-tone="alarm">
            <span class="map-legend__dot map-legend__dot--alarm" aria-hidden="true"></span>
            {{ t('mapUi.legendAlarm') }}
            <span class="muted">{{ toneCounts.alarm }}</span>
          </li>
          <li class="map-legend__item" data-legend-tone="online">
            <span class="map-legend__dot map-legend__dot--online" aria-hidden="true"></span>
            {{ t('devices.status.online') }}
            <span class="muted">{{ toneCounts.online }}</span>
          </li>
          <li class="map-legend__item" data-legend-tone="offline">
            <span class="map-legend__dot map-legend__dot--offline" aria-hidden="true"></span>
            {{ t('devices.status.offline') }}
            <span class="muted">{{ toneCounts.offline }}</span>
          </li>
        </ul>

        <!--
          「一台点位都没有」与「有设备但都没录点位」是两件事：前者说"这一页还没有数据"，
          后者说"去设备管理补录"。所以空态用的是 `layout.markers`，不是设备表是不是空的。
        -->
        <p v-if="layout.markers.length === 0" class="alert alert--warning" data-map-empty>
          {{ t('mapUi.noPoints') }}
        </p>
        <p v-else class="muted map-panel__hint">{{ t('mapUi.selectHint') }}</p>

        <div class="map-canvas-frame" data-map-canvas-frame>
          <svg
            v-if="layout.markers.length > 0"
            class="map-canvas"
            :viewBox="`0 0 ${CANVAS.width} ${CANVAS.height}`"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            :aria-label="t('mapUi.canvasLabel')"
            data-map-canvas
          >
            <rect x="0" y="0" :width="CANVAS.width" :height="CANVAS.height" class="map-canvas__bg" />
            <!-- 经纬度网格：视野小时步长自动变小（`mapGridSteps`）。 -->
            <g class="map-grid">
              <line
                v-for="latitude in grid.lat"
                :key="`lat-${latitude}`"
                :x1="0"
                :x2="CANVAS.width"
                :y1="gridLineY(latitude)"
                :y2="gridLineY(latitude)"
              />
              <line
                v-for="longitude in grid.lon"
                :key="`lon-${longitude}`"
                :x1="gridLineX(longitude)"
                :x2="gridLineX(longitude)"
                :y1="0"
                :y2="CANVAS.height"
              />
            </g>
            <g
              v-for="marker in layout.markers"
              :key="marker.id"
              class="map-marker"
              :class="[
                `map-marker--${markerTones[marker.id]}`,
                { 'map-marker--active': marker.id === selectedId }
              ]"
              :transform="`translate(${marker.x} ${marker.y})`"
              role="button"
              tabindex="0"
              :data-map-marker="marker.id"
              :data-marker-tone="markerTones[marker.id]"
              @click="selectDevice(marker.id)"
              @mouseenter="openHover(marker.id)"
              @mouseleave="closeHover()"
              @focus="openHover(marker.id)"
              @blur="closeHover()"
              @dblclick="openDeviceDetail(marker.id)"
              @keydown.enter.prevent="selectDevice(marker.id)"
              @keydown.space.prevent="selectDevice(marker.id)"
            >
              <circle r="8" class="map-marker__dot" />
              <text class="map-marker__label" x="12" y="4">{{ marker.name }}</text>
            </g>
          </svg>

          <!--
            悬停浮层（业主第 15、16 条）：
              · **相机**：基本信息 + **当前视频流**的状态 + 有告警就显示告警；
              · **声纹设备**：基本信息；有告警也显示（第 16 条没点名，但同一张图上
                两种设备各有各的说法会更难读，所以同一条浮层，区别只在"视频流"那一行）。
              · **双击进详情**。

            三条实现上的判断：

            1. **浮层里不放 `<video>`**。主进程对**一台相机只有一条会话，而一条会话只有
               一个观看者**（`CameraLiveSession` 的 `res.write` 对象，见
               `camera-alive.ts` 的注释）。悬停就去接管那条会话，会把**正在看这一路的人**
               的画面当场换掉 —— 一个鼠标划过就能踢掉别人的画面。所以这里给的是**这一路
               视频流现在的状态**（播放中 / 未启动 / RTSP 未启用…），而不是画面本身。
            2. **位置用百分比算**，不量盒子：标记坐标在画布的逻辑坐标系里（1280×720），
               而定比例那一层与画布**恰好同比例**，所以 `x / 1280` 与 `y / 720` 就是它在
               浮层坐标系里的位置。量 `getBoundingClientRect()` 也行，但那要等一帧、
               而且会在缩放/滚动时晚一拍。
            3. **`@focus` / `@blur` 与鼠标同一套**：标记本来就有 `tabindex="0"`，
               键盘走到它上面时浮层也该出来（否则键盘用户拿不到这一条信息）。
          -->
          <div
            v-if="hoveredDevice"
            class="map-hover"
            :style="hoverStyle"
            data-map-hover
          >
            <div class="map-hover__head">
              <span class="map-table__tone" :class="`map-table__tone--${markerTone(hoveredDevice)}`"
                aria-hidden="true"></span>
              <strong>{{ hoveredDevice.name }}</strong>
            </div>
            <dl class="map-hover__kv">
              <div class="map-hover__item">
                <dt>{{ t('addDeviceUi.kindLabel') }}</dt>
                <dd>{{ t(`domain.deviceKind.${hoveredDevice.kind}`) }}</dd>
              </div>
              <div class="map-hover__item">
                <dt>{{ t('devicesUi.onlineColumn') }}</dt>
                <dd>
                  <StatusBadge :status="hoveredDevice.status" :connection-type="hoveredDevice.connectionType" />
                </dd>
              </div>
              <div class="map-hover__item">
                <dt>{{ t('devices.ip') }}</dt>
                <dd class="mono">{{ hoveredDevice.ip || t('monitorUi.noAddress') }}</dd>
              </div>
              <!-- 只有相机有"当前视频流"这一行（声纹设备没有视频流）。 -->
              <div v-if="hoveredDevice.kind === 'acousticCamera'" class="map-hover__item">
                <dt>{{ t('mapUi.hoverStream') }}</dt>
                <dd data-map-hover-stream>{{ hoverStreamText }}</dd>
              </div>
              <div class="map-hover__item">
                <dt>{{ t('mapUi.colAlarms') }}</dt>
                <dd :data-map-hover-alarm="alarmCell(hoveredDevice.id)">
                  {{ hoverAlarmText }}
                </dd>
              </div>
            </dl>
            <p class="muted map-hover__hint">{{ t('mapUi.hoverHint') }}</p>
          </div>
        </div>

        <!--
          没录点位的设备**单独列出来**：它们不在图上的任何位置，混进图里会被读成"落点在这里"。
        -->
        <div v-if="layout.withoutPoint.length > 0" class="map-missing" data-map-without-point>
          <p class="muted map-missing__title">
            {{ t('mapUi.withoutPointTitle', { count: layout.withoutPoint.length }) }}
          </p>
          <ul class="map-missing__list">
            <li v-for="device in layout.withoutPoint" :key="device.id">
              <RouterLink :to="`/devices/${device.id}`">{{ device.name }}</RouterLink>
            </li>
          </ul>
          <p class="muted map-missing__hint">{{ t('mapUi.withoutPointHint') }}</p>
        </div>
      </section>

      <!-- ② 设备列表（业主第 17 条的第一张）。点一行 = 选中，双击 = 进详情。 -->
      <section class="card map-block" data-map-devices>
        <div class="section-header">
          <h3 class="section-title">{{ t('mapUi.devicesTitle') }}</h3>
          <span class="muted">{{ t('mapUi.devicesCount', { count: devices.devices.length }) }}</span>
        </div>
        <table class="table map-table">
          <thead>
            <tr>
              <th scope="col">{{ t('devices.name') }}</th>
              <th scope="col">{{ t('addDeviceUi.kindLabel') }}</th>
              <th scope="col">{{ t('devicesUi.onlineColumn') }}</th>
              <th scope="col">{{ t('mapUi.point') }}</th>
              <th scope="col" class="map-table__num">{{ t('mapUi.colAlarms') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="device in devices.devices"
              :key="device.id"
              class="is-clickable"
              :class="{ 'map-table__row--active': device.id === selectedId }"
              :data-map-device-row="device.id"
              @click="selectDevice(device.id)"
              @dblclick="openDeviceDetail(device.id)"
            >
              <td>
                <span class="map-table__tone" :class="`map-table__tone--${markerTone(device)}`"
                  :title="t('mapUi.legendAlarm')" aria-hidden="true"></span>
                {{ device.name }}
              </td>
              <td class="muted">{{ t(`domain.deviceKind.${device.kind}`) }}</td>
              <td>
                <StatusBadge :status="device.status" :connection-type="device.connectionType" />
              </td>
              <td class="mono muted">{{ devicePointText(device) }}</td>
              <td class="map-table__num">{{ alarmCell(device.id) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="muted map-panel__hint">{{ t('mapUi.devicesHint') }}</p>
      </section>

      <!-- ③ 告警列表（第二张）。抓图与同步都挂在这一段里（它们是这一页原来的能力）。 -->
      <section class="card map-block" data-map-alarms>
        <div class="section-header">
          <h3 class="section-title">{{ t('mapUi.alarmsTitle') }}</h3>
          <span class="muted">
            {{
              selectedDevice
                ? t('mapUi.alarmsFor', { name: selectedDevice.name })
                : t('mapUi.pickOne')
            }}
          </span>
        </div>

        <template v-if="selectedDevice">
          <div class="map-selected">
            <StatusBadge :status="selectedDevice.status" :connection-type="selectedDevice.connectionType" />
            <span class="muted">{{ t('mapUi.point') }}：<span class="mono">{{ pointText }}</span></span>
            <span class="muted">{{ t('installUi.azimuth') }}：{{ liveAzimuth(selectedDevice) }}</span>
            <div class="btn-row">
              <RouterLink class="btn btn--sm" :to="`/devices/${selectedDevice.id}`">
                {{ t('devicesUi.configure') }}
              </RouterLink>
              <RouterLink class="btn btn--sm" :to="`/monitor?device=${selectedDevice.id}`">
                {{ t('devicesUi.viewColumn') }}
              </RouterLink>
              <button
                v-if="selectedDevice.kind === 'auscultationBox'"
                type="button"
                class="btn btn--primary btn--sm"
                :disabled="syncing"
                data-action="map-sync"
                @click="syncNow"
              >
                {{ syncing ? t('mapUi.syncing') : t('mapUi.sync') }}
              </button>
            </div>
          </div>

          <p v-if="syncOutcome" class="muted map-panel__hint" data-map-sync-outcome>
            {{
              t('mapUi.syncOutcome', {
                created: syncOutcome.alarmsCreated,
                existing: syncOutcome.alarmsExisting,
                linked: syncOutcome.snapshotsLinked,
                missing: syncOutcome.filesMissing
              })
            }}
          </p>

          <span v-if="alarms.length > 0" class="muted">
            {{ t('mapUi.alarmCount', { count: alarms.length }) }}
          </span>

          <p v-if="alarmsLoading" class="muted">{{ t('common.loading') }}</p>
          <p v-else-if="alarms.length === 0" class="muted" data-map-no-alarms>
            {{ t('mapUi.noAlarms') }}
          </p>
          <ul v-else class="map-alarms">
            <li v-for="alarm in alarms" :key="alarm.id">
              <button
                type="button"
                class="map-alarms__item"
                :class="{ 'map-alarms__item--active': alarm.id === selectedAlarmId }"
                :data-alarm-id="alarm.id"
                @click="openSnapshots(alarm)"
              >
                <span class="map-alarms__time">{{ formatDateTime(alarm.timestamp) }}</span>
                <span class="map-alarms__value">
                  {{ alarm.spl === undefined ? '—' : `${formatNumber(alarm.spl, 1)} dB` }}
                </span>
                <span class="badge" :class="alarm.snapshotDir ? 'badge--success' : ''">
                  {{ alarm.snapshotDir ? t('mapUi.hasSnapshot') : t('mapUi.noSnapshot') }}
                </span>
              </button>
            </li>
          </ul>

          <!--
            抓图：三种状态分开说（有图 / 设备上本来没有 / 库里记着但文件已不在）。
            `img` 的地址是主进程回环端点（含每会话令牌），CSP 只放行 `127.0.0.1`。
          -->
          <div v-if="selectedAlarmId" class="map-snapshots" data-map-snapshots>
            <div class="section-header">
              <h4 class="section-title">{{ t('mapUi.snapshotTitle') }}</h4>
              <span v-if="snapshots?.state === 'ok'" class="muted">
                {{ t('mapUi.snapshotCount', { count: snapshots.files.length }) }}
              </span>
            </div>
            <p v-if="snapshotsLoading" class="muted">{{ t('mapUi.snapshotLoading') }}</p>
            <template v-else-if="snapshots">
              <p v-if="snapshots.state === 'not-captured'" class="alert alert--warning" data-snapshot-not-captured>
                {{ t('mapUi.snapshotNotCaptured') }}
              </p>
              <p v-else-if="snapshots.state === 'files-gone'" class="alert alert--warning" data-snapshot-files-gone>
                {{ t('mapUi.snapshotFilesGone') }}
              </p>
              <div v-else class="map-snapshots__grid">
                <figure v-for="file in snapshots.files" :key="file.name">
                  <img :src="file.url" :alt="file.name" loading="lazy" />
                  <figcaption class="muted">{{ file.name }}</figcaption>
                </figure>
              </div>
            </template>
          </div>

          <p v-if="selectedIsSonar" class="muted map-panel__hint">{{ t('mapUi.sonarHint') }}</p>
        </template>

        <p v-else class="muted">{{ t('mapUi.pickOne') }}</p>
      </section>

      <!-- ④ 实时数据列表（第三张）：分贝 / 稳定度 / 方位。 -->
      <section class="card map-block" data-map-live>
        <div class="section-header">
          <h3 class="section-title">{{ t('mapUi.liveTitle') }}</h3>
        </div>
        <table class="table map-table">
          <thead>
            <tr>
              <th scope="col">{{ t('devices.name') }}</th>
              <th scope="col" class="map-table__num">{{ t('mapUi.colDb') }}</th>
              <th scope="col" class="map-table__num">{{ t('mapUi.colStability') }}</th>
              <th scope="col" class="map-table__num">{{ t('mapUi.colAzimuth') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="device in devices.devices" :key="device.id" :data-live-row="device.id">
              <td>
                <span class="map-table__tone" :class="`map-table__tone--${markerTone(device)}`"
                  :title="t('mapUi.legendAlarm')" aria-hidden="true"></span>
                {{ device.name }}
              </td>
              <td class="map-table__num">{{ liveDb(device.id) }}</td>
              <!-- 平稳度：最近一条告警上报的 `smoothness`（业主 2026-09-19 澄清「用平稳度表示」）。 -->
              <td class="map-table__num" :data-live-smoothness="liveSmoothness(device.id)">
                {{ liveSmoothness(device.id) }}
              </td>
              <td class="map-table__num">{{ liveAzimuth(device) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="muted map-panel__hint" data-live-hint>{{ t('mapUi.liveHint') }}</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
/*
 * 版面（第 13、17 条）：地图在上、三张列表在下，都是**一列流式**，没有左右分栏。
 *
 * 地图那一块是**扁平**的（上/下各一条线，没有卡片内边距）：第 13 条要的是"占满宽度"，
 * 而 `.card` 的左右内边距会让它各缩进 16px —— 那就只是"差不多占满"。
 * 下面三张列表仍然是卡片：业主点名要扁平化的只有设备管理那张表，这里不动别的既有口径。
 */
.map-panel,
.map-block {
  min-width: 0;
}

.map-panel {
  border-top: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
  /*
   * 上下内边距取**卡片那一档**（`--space-4` = 16px，加上 1px 上边线正好 17px）：
   * 业主 2026-09-19 更正第 5 条要求各页"内容距离左侧和上侧保持一致"，
   * 而这一块原来用的是 `--space-3`（12px）—— 它比别页的卡片高 5px。
   * **左右仍然是 0**：那是第 13 条（16:9 占满内容宽度）的要求，两者不冲突
   * （上下是这一段自己的留白，左右是画布要铺满的那条）。
   */
  padding-block: var(--space-4);
}

.map-block {
  margin-top: var(--space-4);
}

/*
 * 16:9 的那一层（第 13 条）。**比例只在这一处定义**：SVG 的 `viewBox` 是 1280×720，
 * 两处必须一致。用 `aspect-ratio` 而不是 padding 技巧：它让高度真的由宽度算出来，
 * 而"占满宽度"这句话就落在 `width: 100%` 上。
 *
 * 这里**故意没有 max-height**：加了它，窗口一矮这一个盒子就不再是 16:9，
 * 而业主这一条要的就是 16:9（页面因此会变长，列表在地图下面，需要滚动 —— 那是这一条的代价）。
 */
.map-canvas-frame {
  width: 100%;
  aspect-ratio: 16 / 9;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
  /*
   * 浮层要能浮到图外面一点（最右/最下那一台设备的浮层会被边裁掉）。
   * `overflow: hidden` 换成 `visible`：SVG 自己是 100%×100%，不会溢出，
   * 需要裁的只有"图"本身，而图不会超出这一层。
   */
  position: relative;
  overflow: visible;
}

/*
 * 悬停浮层（第 15、16 条）。
 *
 * `left` / `top` 是**标记的位置**（百分比），所以它压在标记上 —— 用 `translate(-50%, -100%)`
 * 把它抬到标记上方、水平居中；`pointer-events: none` 是关键：浮层压住标记之后，
 * 鼠标会"离开"标记而触发 `mouseleave`，浮层立刻消失又出现（闪烁）。
 */
.map-hover {
  position: absolute;
  transform: translate(-50%, calc(-100% - 12px));
  pointer-events: none;
  z-index: 5;
  min-width: 190px;
  max-width: 260px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  box-shadow: 0 6px 18px rgba(16, 24, 40, 0.12);
  font-size: 12px;
}

.map-hover__head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.map-hover__kv {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.map-hover__item {
  display: flex;
  gap: 6px;
}

.map-hover__item dt {
  flex: 0 0 62px;
  color: var(--color-text-secondary);
}

.map-hover__item dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.map-hover__hint {
  font-size: 11px;
  margin: 4px 0 0;
}

.map-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.map-canvas__bg {
  fill: var(--color-bg-subtle);
}

.map-grid line {
  stroke: var(--color-border);
  stroke-width: 1;
  stroke-dasharray: 3 4;
}

.map-marker {
  cursor: pointer;
}

/*
 * 落点的三种色调（第 14 条）。**颜色值本身不新造**：绿用与在线圆点同一个
 * `--color-success`，红用 `--color-danger`，灰用 `--color-text-tertiary`（这套 token 里
 * "不突出"的那一档灰；没有 `--color-text-muted` 这个名字）。
 */
.map-marker__dot {
  stroke-width: 2;
}

.map-marker--online .map-marker__dot {
  fill: var(--color-bg);
  stroke: var(--color-success);
}

.map-marker--alarm .map-marker__dot {
  fill: var(--color-danger);
  stroke: var(--color-danger);
}

.map-marker--offline .map-marker__dot {
  fill: var(--color-bg);
  stroke: var(--color-text-tertiary);
}

.map-marker--active .map-marker__dot {
  stroke-width: 4;
}

.map-marker__label {
  font-size: 13px;
  fill: var(--color-text);
}

/* 图例 */
.map-legend {
  list-style: none;
  margin: 0 0 var(--space-2);
  padding: 0;
  display: flex;
  align-items: center;
  gap: var(--space-4);
  font-size: 12px;
}

.map-legend__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.map-legend__dot,
.map-table__tone {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
  flex: none;
}

.map-legend__dot--alarm,
.map-table__tone--alarm {
  background: var(--color-danger);
}

.map-legend__dot--online,
.map-table__tone--online {
  background: var(--color-success);
}

.map-legend__dot--offline,
.map-table__tone--offline {
  background: var(--color-text-tertiary);
}

.map-table__tone {
  margin-right: 6px;
  vertical-align: middle;
}

.map-table {
  width: 100%;
}

.map-table__num {
  text-align: right;
  white-space: nowrap;
}

.map-table__row--active {
  background: var(--color-accent-soft);
}

.map-selected {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  font-size: 12.5px;
  margin-bottom: var(--space-2);
}

.map-panel__hint {
  font-size: 11.5px;
  margin: 0;
}

.map-missing {
  margin-top: var(--space-3);
  border-top: 1px solid var(--color-border);
  padding-top: var(--space-2);
}

.map-missing__title,
.map-missing__hint {
  font-size: 11.5px;
  margin: 0;
}

.map-missing__list {
  margin: 4px 0;
  padding-left: 18px;
  font-size: 12.5px;
}

.map-alarms {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 260px;
  overflow: auto;
}

.map-alarms__item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.map-alarms__item:hover {
  border-color: var(--color-border-strong);
}

.map-alarms__item--active {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}

.map-alarms__time {
  flex: 1;
  min-width: 0;
}

.map-alarms__value {
  font-variant-numeric: tabular-nums;
}

.map-snapshots {
  border-top: 1px solid var(--color-border);
  padding-top: var(--space-2);
  margin-top: var(--space-2);
}

.map-snapshots__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--space-2);
}

.map-snapshots__grid figure {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.map-snapshots__grid img {
  width: 100%;
  height: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
}

.map-snapshots__grid figcaption {
  font-size: 11px;
}
</style>
