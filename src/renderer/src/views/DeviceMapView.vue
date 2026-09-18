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
 * 实时数据列表里那一列「稳定度」（业主第 17 条）—— **手册未说明**
 * ---------------------------------------------------------------------------
 * 业主给的三列是 分贝 / 稳定度 / 方位。前两列与第四列有真实来源，**「稳定度」没有**：
 * `docs/reference/` 里没有这个量，本仓库里唯一的"稳定性"是告警规则里的一个**阈值设置**
 * （`device-config.ts` 的 `splStabilityThreshold`），那是"超过多少算异常"的判据，不是读数；
 * 另一个真实测量值叫**平滑度**（`AlarmEvent.smoothness`），它与"稳定度"不是同一个量，
 * 所以**不拿它顶替**。这一列因此恒为「—」，并在表下写明原因（`mapUi.stabilityNoSourceHint`）。
 */

import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { AlarmEvent, Device } from '@shared/domain/models'
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
      <section class="map-panel" data-map-panel>
        <div class="section-header">
          <!--
            面板标题用**页面名**（`app.nav.map`）而不是第二个键：第 12 条把这一页改名成
            「地图信息（GIS）」之后，同一句名字出现在顶栏、侧栏与这里，只能有一个来源。
          -->
          <h3 class="section-title">{{ t('app.nav.map') }}</h3>
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
              @keydown.enter.prevent="selectDevice(marker.id)"
              @keydown.space.prevent="selectDevice(marker.id)"
            >
              <circle r="8" class="map-marker__dot" />
              <text class="map-marker__label" x="12" y="4">{{ marker.name }}</text>
            </g>
          </svg>
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
              <th scope="col" class="map-table__num">
                <!--
                  这一列表头带一个"为什么永远是 —"的悬停说明，因为**手册未说明**这个量：
                  见文件头与 `mapUi.stabilityNoSourceHint`。
                -->
                <span :title="t('mapUi.stabilityNoSourceHint')" data-live-no-source>
                  {{ t('mapUi.colStability') }}
                </span>
              </th>
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
              <td class="map-table__num muted" :title="t('mapUi.stabilityNoSourceHint')">
                {{ t('mapUi.none') }}
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
  padding-block: var(--space-3);
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
  overflow: hidden;
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
