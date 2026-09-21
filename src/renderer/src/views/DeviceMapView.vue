<script setup lang="ts">
/**
 * **地图信息（GIS）**（原「点位图」，业主 2026-09-17 第 8 批建的页；2026-09-18 第 10 批
 * 第 12 条改名并挪到设备管理之前，第 13/14/17 条重排了这一页的版面）。
 *
 * ---------------------------------------------------------------------------
 * 版面（业主第 13、17 条；**第 11 批第 4、5 条重排了地图区与下方列表**）
 * ---------------------------------------------------------------------------
 *   ① 地图区：**16:9、占满内容宽度**，在最上面，右上角浮着一条半透明的**状态栏**
 *      （图上 N 台 / 共 M 台 / 在线 K / 离线 J / 未确认告警 P）；
 *   ② 地图**下方**：左**设备列表**（序号 / 设备名称 / 状态，每页 10 台）+
 *      右**告警列表**（高度与左边那张卡完全一致）；
 *   ③ 最后是**实时监测工作台**（Live Monitor，业主 2026-09-20 规格）：
 *      当前聚焦设备的 Header + 三栏模板 + 能力驱动的底部动作。
 *
 * 第 11 批第 4 条点名删掉了地图区上面的三样东西（「图上 N 台 / 共 M 台」那一行读数、
 * 三个色调的图例与计数、「还没有任何设备录入点位…」那一句），并把那些数字搬进了状态栏；
 * 第 5 条删掉了「未录入点位设备」那张卡、把设备列表收到三列与半幅宽、并加了翻页。
 * 冲突逐条写在 `docs/Ivms4200-UX-REFERENCE.md` §15.68/§15.69。
 *
 * 这一页**没有左栏**（第 5 条之后连设备管理都没有左栏），所以第 13 条那句"GIS 页右侧"
 * 只能读成"内容区里那一块主区域"：地图占满整宽、按 16:9 定高。**这是我们的读法**，
 * 若你要的是左栏版式，回一句就改。
 *
 * ---------------------------------------------------------------------------
 * 三件必须说清楚的事
 * ---------------------------------------------------------------------------
 * 1. **底图默认是我们自己画的离线平面图**（`shared/domain/device-map.ts`）：渲染层不联网，
 *    图上只有经纬度网格与落点，没有街道与建筑。业主 2026-09-19 追加第 1 条之后，可以在
 *    「设置 → 地图」里**显式开启**在线 XYZ 底图（见 `@shared/domain/map-tiles`）：只允许
 *    https、默认关闭、按电脑时区推中心、缩放固定 2–18；关着时这一页与过去完全一样。
 * 2. **没录点位的设备画不在图上**，但它们在**设备列表里**（那份列表是设备表的全部，
 *    不是"图上的那几台"）—— 状态栏里"图上 N 台 / 共 M 台"两个数不相等时，差额就是它们。
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
 * 实时监测工作台的数据口径（业主 2026-09-20 规格 V1.0）
 * ---------------------------------------------------------------------------
 * 第三行已经从"整幅宽的实时数据表格（分贝 / 平稳度 / 方位）"改成一台**当前聚焦设备**
 * 的工作台。口径随之固定：
 *   - `selectedId` 是整页唯一的 currentFocusDeviceId（规格 §27）：点地图落点、设备行、
 *     告警行都只改它；实时工作台不自己存第二份选中状态；
 *   - SPL / 平稳度仍然取**最近一条真实告警**（与原来的表格同源），经
 *     `lib/realtimeAdapters.ts` 归一成 `RealtimeFrame`；FA8 在线时另有每秒一帧的
 *     实时特征值，优先于 last-known；
 *   - 方位角仍是**录入的安装方位**。空气声呐的**实时方向只在 Event 模式、且告警原文里
 *     确实有 horizontal/vertical 时出现**（规格 §20：Live 不显示不断变化的方向角）；
 *   - 缺失值一律 `value: null` + `quality: 'nodata'`，界面显示 `—`，绝不写 0（规格 §31）。
 *
 * **版面比例的决定（业主 2026-09-20）**：规格 V1.0 里给的 1920×1080 基准行高与
 * "1920×1080 不产生纵向滚动"验收项**不采用**。业主明确选择沿用本页既有的第 13 条口径：
 * **地图 16:9、占满内容宽度**，下方设备/告警列表与实时工作台按内容自然排布；
 * 实时工作台自己的 Default 312 / Collapsed 56 / Expanded 480 / 拖拽上限 55vh 继续保留。
 * 地图比例、SVG 画布、瓦片排布与相关测试都**不动**。
 */

import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type { AlarmEvent, Device } from '@shared/domain/models'
import type { CameraLiveStatus } from '@shared/domain/camera-live'
import type { E2AlarmSnapshotView, E2SyncOutcome } from '@shared/ipc/contract'
import {
  deviceMapLayout,
  mapGridSteps,
  mapProjector,
  type MapBounds,
  type MapDeviceInput
} from '@shared/domain/device-map'
import { isPointComplete } from '@shared/domain/device-installation'
import {
  MAX_TILE_ZOOM,
  MIN_TILE_ZOOM,
  TILE_SIZE,
  clampTileZoom,
  panMapCenter,
  projectToViewport,
  timeZoneCenter,
  viewTiles,
  type MapCenter,
  type MapTilePlacement,
  type MapTilesConfig
} from '@shared/domain/map-tiles'
import { deviceMapFocusId } from '@renderer/lib/deviceMapLink'
import {
  DEVICE_MAP_PAGE_SIZE,
  clampListPage,
  listPageCount,
  listPageSlice
} from '@renderer/lib/listPaging'
import { useDevicesStore } from '@renderer/stores/devices'
import { useSettingsStore } from '@renderer/stores/settings'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { formatDateTime, formatNumber } from '@renderer/lib/format'
import EmptyState from '@renderer/components/EmptyState.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'
import RealtimeMonitor from '@renderer/components/realtime/RealtimeMonitor.vue'
import { useRealtimeMonitorStore } from '@renderer/stores/realtimeMonitor'
import type { RealtimeActionId } from '@shared/domain/realtime-monitor'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const devices = useDevicesStore()
const settings = useSettingsStore()
const realtime = useRealtimeMonitorStore()

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

/**
 * 默认视野：一台已定位设备都没有时的兜底经纬度范围（业主 20260921 批第 9 条：
 * 「地图信息里面都是空的，没有显示 GIS 信息」）。没有它，`mapBounds` 返回空、
 * 网格整个缺席，画布就是一块灰底 —— 看起来"地图坏了"。兜底视野以时区中心城市为心
 * （与在线底图的 `timeZoneCenter` 同一取值），给一个约一个省范围的网格：
 * 中国用户看到中国网格，海外用户看到自己所在的网格。
 *
 * 只在**没有落点**时生效：有落点时永远用真实范围（设备相对位置不被兜底视野扭曲）。
 */
const LAT_SPAN_FALLBACK = 24
const LON_SPAN_FALLBACK = 32

const fallbackBounds = computed<MapBounds>(() => {
  const center = timeZoneView
  const clampLat = (value: number) => Math.max(-80, Math.min(80, value))
  let minLon = center.longitude - LON_SPAN_FALLBACK / 2
  let maxLon = center.longitude + LON_SPAN_FALLBACK / 2
  // 跨 ±180° 经线时整体平移一圈：投影器只做线性插值，跨线会让网格整个错位。
  if (minLon < -180) {
    minLon += 360
    maxLon += 360
  } else if (maxLon > 180) {
    minLon -= 360
    maxLon -= 360
  }
  return {
    minLat: clampLat(center.latitude - LAT_SPAN_FALLBACK / 2),
    maxLat: clampLat(center.latitude + LAT_SPAN_FALLBACK / 2),
    minLon,
    maxLon
  }
})

/** 网格/投影真正用的视野：真实落点范围优先，没有落点用兜底视野（网格不再缺席）。 */
const effectiveBounds = computed<MapBounds>(() => layout.value.bounds ?? fallbackBounds.value)

const grid = computed(() => mapGridSteps(effectiveBounds.value))

/**
 * 网格线与设备落点用**同一个投影器**（`mapProjector`）：抄第二份算式迟早会与点错位，
 * 而错位的表现是"设备看起来不在那个刻度上"。
 */
const project = computed(() => {
  const bounds = effectiveBounds.value
  return mapProjector(bounds, CANVAS.width, CANVAS.height, MAP_PADDING)
})

/** 网格刻度文案：纬度标南/北，经度标西/东（`31.2°N` / `121.4°E` 这种读法）。 */
function latLabel(latitude: number): string {
  const hemi = latitude >= 0 ? 'N' : 'S'
  return `${Math.abs(latitude).toFixed(1)}°${hemi}`
}
function lonLabel(longitude: number): string {
  const hemi = longitude >= 0 ? 'E' : 'W'
  return `${Math.abs(longitude).toFixed(1)}°${hemi}`
}

function gridLineY(latitude: number): number {
  return project.value ? project.value.y(latitude) : 0
}

function gridLineX(longitude: number): number {
  return project.value ? project.value.x(longitude) : 0
}

// ---------------------------------------------------------------------------
// 在线底图（GIS；业主 2026-09-19 追加第 1 条）
// ---------------------------------------------------------------------------
/**
 * 设置里的地图配置。只有**显式打开**时才返回它；关着时整块在线底图不渲染，
 * 这一页与过去完全一样（本机 SVG 网格，不出网）。**默认关闭**是离线优先的硬约束。
 */
const tilesEnabled = computed(() => tileConfig.value !== null)

const tileConfig = computed<MapTilesConfig | null>(() => {
  const config = settings.settings?.mapTiles
  return config?.enabled ? config : null
})

/** 电脑时区（IANA 名）；取不到就退回 UTC（查表会落到世界中心，缩放 2）。 */
const systemTimeZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
})()

/**
 * 时区→中心表在共享层（**手册未说明**，是我们的取值：见 @shared/domain/map-tiles）。
 * 地图页只负责把结果放进取景框，不自己维护第二份城市表。
 */
const timeZoneView = timeZoneCenter(systemTimeZone)

/**
 * 当前视野。
 *
 * **普通 ref + 普通事件处理器**：绝不在 patch 期间写它（第 36 轮那条硬规矩）。
 * 开关打开时从时区中心起；设备可能不在中心附近，操作员用缩放/拖拽自己找。
 */
const mapView = ref<MapCenter | null>(null)
const tileErrors = ref<string[]>([])
watch(
  tilesEnabled,
  (enabled) => {
    mapView.value = enabled ? { ...timeZoneView } : null
    tileErrors.value = []
  },
  { immediate: true }
)
const activeCenter = computed<MapCenter>(() => mapView.value ?? timeZoneView)
const mapZoom = computed(() => activeCenter.value.zoom)

/** 当前视口需要的瓦片；配置关着时是空数组。 */
const tilePlacements = computed<MapTilePlacement[]>(() => {
  const config = tileConfig.value
  if (!config) return []
  return viewTiles(config, activeCenter.value, mapZoom.value, CANVAS.width, CANVAS.height)
})

/** 失败瓦片用**键**记录：重新铺瓦片后旧键不再参与计数（避免异步 error 串台）。 */
const tileFailureCount = computed(
  () => tilePlacements.value.filter((tile) => tileErrors.value.includes(tile.key)).length
)

// 只留**当前这批瓦片**的键：老键留着没有任何用处（对应的 <img> 已经销毁），
// 一张图拖一整天，这个数组会变成一份只进不出的失败日志（G3 修复）。
watch(tilePlacements, (placements) => {
  if (tileErrors.value.length === 0) return
  const live = new Set(placements.map((tile) => tile.key))
  tileErrors.value = tileErrors.value.filter((key) => live.has(key))
})

function onTileError(key: string): void {
  if (!tileErrors.value.includes(key)) tileErrors.value = [...tileErrors.value, key]
}

/** 瓦片位置：百分比（与 SVG 的 1280×720 逻辑坐标同一套）。 */
function tileStyle(tile: MapTilePlacement): Record<string, string> {
  return {
    left: `${((tile.left / CANVAS.width) * 100).toFixed(4)}%`,
    top: `${((tile.top / CANVAS.height) * 100).toFixed(4)}%`,
    width: `${((TILE_SIZE / CANVAS.width) * 100).toFixed(4)}%`,
    height: `${((TILE_SIZE / CANVAS.height) * 100).toFixed(4)}%`
  }
}

const zoomInDisabled = computed(() => mapZoom.value >= MAX_TILE_ZOOM)
const zoomOutDisabled = computed(() => mapZoom.value <= MIN_TILE_ZOOM)

function zoomBy(delta: number): void {
  if (!tileConfig.value) return
  const current = activeCenter.value
  const zoom = clampTileZoom(current.zoom + delta)
  if (zoom === current.zoom) return
  mapView.value = { ...current, zoom }
}

function onMapWheel(event: WheelEvent): void {
  if (!tileConfig.value) return
  event.preventDefault()
  zoomBy(event.deltaY < 0 ? 1 : -1)
}

/** 拖拽状态用**普通对象**：它不需要响应式，也不是模板 ref（第 36 轮的教训）。 */
const drag = {
  active: false,
  startX: 0,
  startY: 0,
  center: null as MapCenter | null
}

function onMapPointerDown(event: PointerEvent): void {
  if (!tileConfig.value || event.button !== 0) return
  drag.active = true
  drag.startX = event.clientX
  drag.startY = event.clientY
  drag.center = { ...activeCenter.value }
  const target = event.currentTarget as HTMLElement | null
  target?.setPointerCapture?.(event.pointerId)
}

function onMapPointerMove(event: PointerEvent): void {
  if (!drag.active || !drag.center) return
  const target = event.currentTarget as HTMLElement | null
  if (!target) return
  const rect = target.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  const dx = ((event.clientX - drag.startX) * CANVAS.width) / rect.width
  const dy = ((event.clientY - drag.startY) * CANVAS.height) / rect.height
  if (dx === 0 && dy === 0) return
  mapView.value = panMapCenter(drag.center, dx, dy)
}

function onMapPointerUp(event: PointerEvent): void {
  if (!drag.active) return
  drag.active = false
  drag.center = null
  const target = event.currentTarget as HTMLElement | null
  target?.releasePointerCapture?.(event.pointerId)
}

/**
 * `?device=` 进来时把这一台放到视野中心。
 * 时区中心是默认起点，但它与设备位置是两件事：不居中的话，那个链接点过来
 * 只会"选中一台在屏幕外的设备"，操作员看不到它。
 */
function centerOnDevice(deviceId: string): void {
  if (!tileConfig.value) return
  const device = mapInputs.value.find((item) => item.id === deviceId)
  if (!device || device.latitude === undefined || device.longitude === undefined) return
  mapView.value = {
    latitude: device.latitude,
    longitude: device.longitude,
    zoom: clampTileZoom(Math.max(mapZoom.value, 8))
  }
}

/** 回到电脑时区推出来的默认中心（与放大/缩小共用的入口）。 */
function resetMapView(): void {
  mapView.value = { ...timeZoneView }
}

/**
 * 显示用落点：离线模式沿用原来的"按设备范围铺满"；在线模式用 Web Mercator 投影。
 * 两种模式共用同一套 SVG 标记与色调，只是坐标来源不同。
 */
const displayMarkers = computed(() => {
  const config = tileConfig.value
  if (!config) return layout.value.markers
  return mapInputs.value
    .filter(
      (device): device is MapDeviceInput & { latitude: number; longitude: number } =>
        device.latitude !== undefined && device.longitude !== undefined
    )
    .map((device) => {
      const point = projectToViewport(
        activeCenter.value,
        device.latitude,
        device.longitude,
        CANVAS.width,
        CANVAS.height
      )
      return {
        id: device.id,
        name: device.name,
        x: Math.round(point.x * 100) / 100,
        y: Math.round(point.y * 100) / 100,
        latitude: device.latitude,
        longitude: device.longitude
      }
    })
})

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
  for (const marker of displayMarkers.value) {
    const device = devices.byId(marker.id)
    out[marker.id] = device ? markerTone(device) : 'offline'
  }
  return out
})

/**
 * 状态栏里的**在线 / 离线台数**（业主 2026-09-19 第 11 批第 4 条）。
 *
 * 与落点颜色**故意不是同一套判据**：颜色说的是"这个点在图上报什么"（告警优先），
 * 而这里问的是"有几台设备在线"——一台离线但有未确认告警的设备不该被算进"在线"。
 * `UNKNOWN` 归离线：与设备下拉旁边那个灰点同一条口径（绿点会被读成"它在工作"）。
 */
const onlineCount = computed(() => devices.devices.filter((device) => device.status === 'ONLINE').length)
const offlineCount = computed(() => devices.devices.length - onlineCount.value)

/**
 * 状态栏里的**未确认告警合计**。
 *
 * `known: false` 有三种来源：还没读过一次（`alarmFacts` 是空的）、某一台设备的计数读失败
 * （`-1`）。两种情况都显示「—」，不显示 0 —— 一次 IPC 失败在状态栏上变成"没有告警"
 * 是最坏的那种谎（与设备表、实时数据列表同一条口径）。
 */
const alarmStatus = computed<{ known: boolean; pending: number }>(() => {
  const list = Object.values(alarmFacts.value)
  if (list.length === 0) return { known: false, pending: 0 }
  let pending = 0
  for (const facts of list) {
    if (facts.pending < 0) return { known: false, pending: 0 }
    pending += facts.pending
  }
  return { known: true, pending }
})

function alarmCell(deviceId: string): string {
  const facts = alarmFacts.value[deviceId]
  if (!facts || facts.pending < 0) return t('mapUi.notRead')
  return String(facts.pending)
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

/**
 * 设备列表的**翻页**（业主 2026-09-19 第 11 批第 5 条：默认最多 10 台，超过就翻页）。
 *
 * 页码不直接信：`devicePageClamped` 每次都夹进合法区间。设备从 23 台删到 3 台之后，
 * 原来存的第 5 页必须落回第 1 页 —— 否则屏幕上是一张空表，而数据一条不少。
 * `pageStart` 是"这一页第一台在总表里的序号"，序号列要的是**总表里的序号**（不是 1..10）。
 */
const devicePage = ref(1)
const devicePageClamped = computed(() =>
  clampListPage(devicePage.value, devices.devices.length, DEVICE_MAP_PAGE_SIZE)
)
const devicePages = computed(() => listPageCount(devices.devices.length, DEVICE_MAP_PAGE_SIZE))
const pagedDevices = computed(() =>
  listPageSlice(devices.devices, devicePage.value, DEVICE_MAP_PAGE_SIZE)
)
const devicePageStart = computed(() => (devicePageClamped.value - 1) * DEVICE_MAP_PAGE_SIZE)

/** 设备表变短（删设备）时把页码拉回合法区间：`clampListPage` 是唯一的判据。 */
watch(
  () => devices.devices.length,
  (total) => {
    const clamped = clampListPage(devicePage.value, total, DEVICE_MAP_PAGE_SIZE)
    if (clamped !== devicePage.value) devicePage.value = clamped
  }
)

function goToDevicePage(page: number): void {
  devicePage.value = clampListPage(page, devices.devices.length, DEVICE_MAP_PAGE_SIZE)
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
  // 规格 §27：整页只有一个 currentFocusDeviceId；实时工作台与设备列表都由它驱动。
  realtime.selectDevice(deviceId)
  void loadAlarms(deviceId)
  void closeSnapshots()
}

/** 实时工作台的底部动作：没有能力就不显示，显示的都有去处。 */
function onRealtimeAction(action: RealtimeActionId): void {
  const device = selectedDevice.value
  if (!device) return
  switch (action) {
    case 'liveView':
    case 'listen':
      void router.push({ path: '/monitor', query: { device: device.id } })
      return
    case 'history':
    case 'analysis':
      void router.push({ path: '/trends', query: { device: device.id } })
      return
    case 'ptz':
    case 'configuration':
      void router.push({ path: `/devices/${device.id}` })
      return
  }
}

/** Event -> Live（规格 §28）：告警选中与快照都收掉，回到当前设备的实时数据。 */
function onRealtimeReturnToLive(): void {
  selectedAlarmId.value = ''
  snapshots.value = null
  void closeSnapshots()
  realtime.returnToLive()
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
 * 悬停浮层里"设备类型"那一格：三种主动连接机型走 `domain.deviceKind.*`；
 * `pushDevice`（业主 20260921 第 12 条）的标签在 `devicesUi.kindPushDevice`
 * （与设备管理页同一条分支，见 `DevicesView.kindLabel`）。
 */
function hoverKindLabel(device: Device): string {
  return device.kind === 'pushDevice'
    ? t('devicesUi.kindPushDevice')
    : t(`domain.deviceKind.${device.kind}`)
}

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
  const marker = displayMarkers.value.find((item) => item.id === device.id)
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
  // 点告警 = 进入 Event 模式（规格 §27/§28）；实时工作台切到这条告警的上下文。
  realtime.selectEvent(alarm.id, device.id)
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
  // 地图配置与开关都在设置里；进这一页也要能自己读到（settings 是共享 store，不会重复请求）。
  if (!settings.loaded) await settings.load()
  if (devices.devices.length === 0) await devices.load()
  await loadDeviceAlarmFacts()
  /*
   * `?device=<id>` 的定位（业主第 10 批第 7 条后半：地址信息要「支持 GIS 显示」）。
   *
   * 地址信息卡片上那句「在地图信息里查看」带的就是这个参数，所以这一页必须认它：
   * 不认的话，那个链接点过来只是"打开了地图页"，而操作员要的是"打开**这一台**在地图上的位置"。
   * 只在真的有这一台、而且它**有完整点位**时才采用 —— 一个过了期的书签不该把选中的那一台
   * 换成一台图上没有的设备（那时右边三张表会跟着变成空的，看起来像页面坏了）。
   */
  const focusId = deviceMapFocusId(route.query)
  const focused = focusId === '' ? undefined : layout.value.markers.find((marker) => marker.id === focusId)
  /*
   * 规格 §35：**没有选中任何设备时不要默认选第一台**（"Select a device to view live data"）。
   * 默认选一台会让操作员以为眼前这块实时数据就是自己关心的那台 —— 地图页又是多设备场景，
   * 误读的代价比"一开始空着"大得多。只有 `?device=` 指向一台图上有的设备时才自动选中。
   * 上一次进入这一页留下的选中状态也要清掉（它是上一个会话的上下文）。
   */
  realtime.clearSelection()
  if (focused) {
    selectDevice(focused.id)
    // 在线底图下，时区中心不一定看得到这一台；?device= 要把它居中。
    centerOnDevice(focused.id)
  }
  loading.value = false
})

onUnmounted(() => {
  void closeSnapshots()
})
</script>

<template>
  <div class="page map-page">
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
          **这一块上面原来有三样东西，业主 2026-09-19 第 11 批第 4 条点名全删**：
            ① 「图上 N 台 / 共 M 台」那一行读数（`mapUi.counts`）；
            ② 三个色调的图例（有未确认告警 0 / 在线 0 / 离线 0）；
            ③ 「还没有任何设备录入点位。到「设备管理 → 编辑 → 安装信息」里填经纬度…」那一句
               （`mapUi.noPoints`）。
          他要的是「直接显示 GIS 地图的信息，在地图右上角的位置做一个半透明的状态栏，
          显示当前地图上的设备数量信息，告警信息」—— 数字没有消失，它们搬进了下面那条
          **半透明状态栏**（`.map-status`），而且是"地图上的状态"而不是"地图前面的一段文字"。

          那两句文案键也跟着从四本目录里删掉了（留着就是死键）。本条与第 10 批第 14 条
          （图例 + 计数）的冲突逐条写进 `docs/Ivms4200-UX-REFERENCE.md` §15.68。
        -->

        <!--
          「一台点位都没有」不再用一句话解释：状态栏里的「图上 0 台 / 共 N 台」说的就是这件事，
          而**画布本身照旧画出来**（空的经纬度网格）—— 地图区不该在"还没有点位"时整块消失，
          那看起来像页面坏了。所以画布的条件是"这一页有设备"，而不是"图上有落点"。
        -->
        <div
          class="map-canvas-frame"
          :class="{ 'map-canvas-frame--tile': tileConfig }"
          data-map-canvas-frame
          :data-map-tiles-enabled="tileConfig ? 'yes' : 'no'"
          :data-map-zoom="tileConfig ? mapZoom : null"
          :data-map-center="tileConfig ? activeCenter.latitude.toFixed(5) + ',' + activeCenter.longitude.toFixed(5) : null"
          :data-map-timezone="tileConfig ? systemTimeZone : null"
          @wheel="onMapWheel"
          @pointerdown="onMapPointerDown"
          @pointermove="onMapPointerMove"
          @pointerup="onMapPointerUp"
          @pointercancel="onMapPointerUp"
        >
          <!--
            在线底图（业主 2026-09-19 追加第 1 条）：只有设置里显式打开才渲染。
            瓦片是普通 <img>（connect-src 仍是 none，因此不能变成 fetch 数据通道）；
            署名固定在地图右下角，放大/缩小/拖拽在控制条与画布手势上。
          -->
          <div v-if="tileConfig" class="map-tile-layer" data-map-tiles>
            <img
              v-for="tile in tilePlacements"
              :key="tile.key"
              class="map-tile"
              :src="tile.url"
              :style="tileStyle(tile)"
              alt=""
              draggable="false"
              data-map-tile
              :data-tile-key="tile.key"
              @error="onTileError(tile.key)"
            />
            <!--
              某些瓦片加载失败（没有外网、服务拒绝）时如实说一句，而不是留一块白，
              更不能把失败说成"这里没有地图"。点位与设备列表不依赖瓦片。
            -->
            <div v-if="tileFailureCount > 0" class="map-tile-error" data-map-tile-error role="status">
              {{ t('mapUi.tilesError', { failed: tileFailureCount, total: tilePlacements.length }) }}
            </div>
          </div>
          <svg
            class="map-canvas"
            :viewBox="`0 0 ${CANVAS.width} ${CANVAS.height}`"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            :aria-label="t('mapUi.canvasLabel')"
            data-map-canvas
          >
            <rect x="0" y="0" :width="CANVAS.width" :height="CANVAS.height" class="map-canvas__bg" :class="{ 'map-canvas__bg--transparent': tileConfig }" />
            <!-- 经纬度网格：视野小时步长自动变小（`mapGridSteps`）。没有落点时用兜底视野
                 （`effectiveBounds`），网格与坐标刻度始终在场 —— 这就是这一页的 GIS 信息本体。 -->
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
              <!-- 坐标刻度：纬度贴左缘、经度贴下缘（业主 20260921 批第 9 条：网格要读出 GIS 信息）。 -->
              <text
                v-for="latitude in grid.lat"
                :key="`lat-label-${latitude}`"
                class="map-grid__label"
                x="6"
                :y="gridLineY(latitude) - 4"
              >
                {{ latLabel(latitude) }}
              </text>
              <text
                v-for="longitude in grid.lon"
                :key="`lon-label-${longitude}`"
                class="map-grid__label"
                :x="gridLineX(longitude) + 4"
                :y="CANVAS.height - 6"
              >
                {{ lonLabel(longitude) }}
              </text>
            </g>
            <g
              v-for="marker in displayMarkers"
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
            底图没开时如实说一声（业主 20260921 批第 9 条：「地图信息里面都是空的」——
            出厂默认离线优先、底图关闭，画布只剩网格，操作员需要知道去哪开）。
            点位与网格不依赖底图，开不开都在。
          -->
          <div v-if="!tileConfig" class="map-tiles-off" data-map-tiles-off role="status">
            {{ t('mapUi.tilesOffHint') }}
          </div>

          <!--
            署名与缩放控制放在 SVG **外面**（同一层、z-index 更高）：
            它们在瓦片层之上、可点；瓦片本身永远不会被控制条挡住。
          -->
          <div v-if="tileConfig?.attribution" class="map-attribution" data-map-attribution>
            {{ tileConfig?.attribution }}
          </div>
          <div v-if="tileConfig" class="map-zoom-controls" data-map-zoom-controls @pointerdown.stop @wheel.stop>
            <button
              type="button"
              class="btn"
              data-map-zoom-out
              :aria-label="t('mapUi.zoomOut')"
              :disabled="zoomOutDisabled"
              @click="zoomBy(-1)"
            >−</button>
            <span class="map-zoom-level" data-map-zoom-level>
              {{ t('mapUi.zoomLevel', { zoom: mapZoom }) }}
            </span>
            <button
              type="button"
              class="btn"
              data-map-zoom-in
              :aria-label="t('mapUi.zoomIn')"
              :disabled="zoomInDisabled"
              @click="zoomBy(1)"
            >+</button>
            <button
              type="button"
              class="btn"
              data-map-zoom-reset
              @click="resetMapView"
            >{{ t('mapUi.zoomReset') }}</button>
          </div>

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
                <dd>{{ hoveredDevice ? hoverKindLabel(hoveredDevice) : '' }}</dd>
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

          <!--
            地图**右上角**那条半透明状态栏（业主 2026-09-19 第 11 批第 4 条）。

            五个读数，两件事：**地图上的设备数量**（图上 N 台 / 共 M 台 / 在线 K / 离线 J）
            与**告警信息**（未确认 P 条）。两处口径必须说清楚：

              · 「图上 N 台」只数**落点**（经纬度成对的那几台，`layout.markers`），
                「共 M 台」数设备表全部 —— 两个数不相等时，差额就是还没录点位的设备；
              · 在线/离线按**设备自己的状态**数（`ONLINE` 才算在线，`UNKNOWN` 归离线/灰），
                与落点颜色那套（告警 > 在线 > 离线）不同：那是"这个点在图上报什么"，
                这是"有几台设备在线"；
              · 告警数读不到时显示「—」而不是 0（`mapUi.notRead`）——
                把"没读到"写成 0 会让一次 IPC 失败在状态栏上变成"没有告警"。
          -->
          <div
            class="map-status"
            role="status"
            :aria-label="t('mapUi.statusLabel')"
            data-map-statusbar
          >
            <span class="map-status__item" data-map-status-mapped>
              {{ t('mapUi.statusMapped', { count: layout.markers.length }) }}
            </span>
            <span class="map-status__item" data-map-status-total>
              {{ t('mapUi.statusTotal', { count: devices.devices.length }) }}
            </span>
            <span class="map-status__item" data-map-status-online>
              {{ t('mapUi.statusOnline', { count: onlineCount }) }}
            </span>
            <span class="map-status__item" data-map-status-offline>
              {{ t('mapUi.statusOffline', { count: offlineCount }) }}
            </span>
            <span
              class="map-status__item map-status__item--alarm"
              data-map-status-alarms
              :data-map-status-alarm-known="alarmStatus.known ? 'yes' : 'no'"
            >
              {{
                t('mapUi.statusAlarms', {
                  count: alarmStatus.known ? alarmStatus.pending : t('mapUi.notRead')
                })
              }}
            </span>
          </div>
        </div>

        <!-- 「点一个标记查看这台设备…」只在**图上有落点**时才有意义。 -->
        <p v-if="layout.markers.length > 0" class="muted map-panel__hint">{{ t('mapUi.selectHint') }}</p>
      </section>

      <!--
        ② 左：设备列表（业主第 17 条的第一张）。
        ③ 右：告警列表（第二张）。**两张卡的高度必须一致**（业主 2026-09-19 第 11 批第 5 条：
        「告警列表卡片高度应该始终与左侧设备保持一致」），做法见 `.map-split` 的样式注释。

        列表只有三列（同一条：序号 / 设备名称 / 状态 —— 原来还有 设备类型 / 点位 / 未确认告警），
        而且**点设备名称进详情**；宽度是内容区的一半（「宽度调整为现在的 50%」）。
        超过 `DEVICE_MAP_PAGE_SIZE`（10）台就翻页 —— 页码由 `lib/listPaging.ts` 的纯函数夹住。
      -->
      <div class="map-split" data-map-split>
        <section class="card map-block map-block--devices" data-map-devices>
          <div class="section-header">
            <h3 class="section-title">{{ t('mapUi.devicesTitle') }}</h3>
            <span class="muted">{{ t('mapUi.devicesCount', { count: devices.devices.length }) }}</span>
          </div>
          <table class="table map-table">
            <thead>
              <tr>
                <th scope="col" class="map-table__index">{{ t('devicesUi.indexColumn') }}</th>
                <th scope="col">{{ t('devices.name') }}</th>
                <th scope="col">{{ t('devicesUi.onlineColumn') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(device, index) in pagedDevices"
                :key="device.id"
                class="is-clickable"
                :class="{ 'map-table__row--active': device.id === selectedId }"
                :data-map-device-row="device.id"
                @click="selectDevice(device.id)"
                @dblclick="openDeviceDetail(device.id)"
              >
                <td class="map-table__index muted">{{ devicePageStart + index + 1 }}</td>
                <td>
                  <!--
                    名字是一个**入口**（业主：点设备名称进设备详情）。用 `<button>` 而不是
                    `<RouterLink>`：这一行本身也有点击（选中），链接会让"选中"与"跳走"在同一次
                    点击里打架，而按钮的 `@click.stop` 说得清这里只做跳转这一件事。
                  -->
                  <button
                    type="button"
                    class="map-table__name"
                    :title="t('devicesUi.openDetail')"
                    data-action="map-device-detail"
                    @click.stop="openDeviceDetail(device.id)"
                  >
                    {{ device.name }}
                  </button>
                </td>
                <td>
                  <StatusBadge :status="device.status" :connection-type="device.connectionType" />
                </td>
              </tr>
            </tbody>
          </table>

          <!-- 超过一页才出现：10 台以内显示它只是多一行没有用的控件。 -->
          <div v-if="devicePages > 1" class="map-pager" data-map-pager>
            <button
              type="button"
              class="btn btn--sm"
              data-action="map-page-prev"
              :disabled="devicePageClamped <= 1"
              @click="goToDevicePage(devicePageClamped - 1)"
            >
              {{ t('mapUi.pagePrev') }}
            </button>
            <span class="muted" data-map-page-status>
              {{ t('mapUi.pageStatus', { page: devicePageClamped, pages: devicePages }) }}
            </span>
            <button
              type="button"
              class="btn btn--sm"
              data-action="map-page-next"
              :disabled="devicePageClamped >= devicePages"
              @click="goToDevicePage(devicePageClamped + 1)"
            >
              {{ t('mapUi.pageNext') }}
            </button>
          </div>

          <p class="muted map-panel__hint">{{ t('mapUi.devicesHint') }}</p>
        </section>

      <!--
        ③ 告警列表（第二张）。业主 2026-09-19 第 11 批第 5 条把它放到设备列表的**右侧**，
        并要求「告警列表卡片高度应该始终与左侧设备保持一致」。抓图与同步仍挂在这一段里。
      -->
      <section class="card map-block map-block--alarms" data-map-alarms>
        <!--
          这一层是"高度与左边一致"的实现要点（见 `.map-split` 的样式注释）：它**绝对定位**
          于卡片内部，因此它的内容**不参与**这一行的高度计算 —— 行高只由左边那张设备卡决定，
          这一张被 `stretch` 拉成同样的高度，内容再多也只在卡片内部滚动。
        -->
        <div class="map-block__fill">
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
        </div>
      </section>
      </div>

      <!--
        ④ 实时监测 / Live Monitor（业主 2026-09-20《GIS Realtime Data UX/UI Spec V1.0》）。

        这一块从"整幅宽的三列表格（分贝 / 平稳度 / 方位）"改成一台**当前聚焦设备**的
        实时监测工作台：Header + 模板三栏（主数据 / 主可视化 / 分析详情）+ 能力驱动的底部动作。
        它不再一次列全部设备：设备/告警列表已经把"哪一台"选好了，工作台只回答"这一台现在
        在发生什么"（规格 §2：不要叫"实时数据列表"，它是一个工作台）。

        数据出处仍然只有一条口径：`alarms` 是选中设备最近 20 条告警（last-known 值），
        `alarmFacts[selectedId].pending` 是未确认条数（Header 的告警色只看它，不按数值猜）；
        FA8 的实时值由 `useRealtimeMonitorFeed()` 从既有 monitor 会话取。没有的字段显示
        `—`，不编 0（规格 §31）。
      -->
      <RealtimeMonitor
        data-map-live
        class="map-block"
        :device="selectedDevice"
        :alarms="alarms"
        :pending-alarms="alarmFacts[selectedId]?.pending ?? -1"
        @action="onRealtimeAction"
        @return-to-live="onRealtimeReturnToLive"
      />
    </template>
  </div>
</template>

<style scoped>
/*
 * 版面：地图在上（16:9 占满宽度），下面**左设备列表 / 右告警列表**并排，最后是整幅宽的实时数据列表。
 *
 * 地图那一块原来是**扁平**的（上/下各一条线，没有卡片内边距）：第 13 条要的是"占满宽度"，
 * 而 `.card` 的左右内边距会让它各缩进 16px —— 那就只是"差不多占满"。
 *
 * **上下那两条线已删（业主 2026-09-19 追加第 2 条：「地图显示卡片的上下有两个线条，
 * 这个线条可以删除，重新调整下地图卡片上下的间距」）**：
 *   · `border-top` / `border-bottom` 去掉 —— 它们与设备列表那张扁平表是同一套做法，
 *     但在地图这一块上看起来是"卡片被上下两条线夹住"，而不是"一块铺满宽度的画布"；
 *   · 上下内边距从 `--space-4`（16px，当时是按"线 + 16px = 卡片那一档 17px"配的）
 *     收到 `--space-2`（8px）：没有线之后 16px 就成了"画布上下各多出一段空白"。
 *     左右仍然是 0（第 13 条：画布要铺满内容宽度）。
 *
 * 左右分栏是业主 2026-09-19 第 11 批第 5 条给的：「设备列表…宽度调整为现在的 50%。
 * 右侧位置应该是告警列表。告警列表卡片高度应该始终与左侧设备保持一致。」
 */
.map-panel,
.map-block {
  min-width: 0;
}

.map-panel {
  /* 上下不再有分隔线（见上面那段注释）。 */
  border: none;
  /* 业主 20260921 批第 9 条：地图→设备列表空隙收到现在的 10%（8px → 0.8px）。 */
  padding-block: calc(var(--space-2) * 0.1);
}

/*
 * 本页纵向流间隙整体收到 10%（业主 20260921 批第 9 条）：原来 地图→列表 ≈ 44px
 * （padding 8 + .page gap 20 + .map-split margin 16）、列表→实时数据 ≈ 36px
 * （gap 20 + margin 16），现在分别 ≈ 4.4px / 3.6px。只作用本页：`.map-page` 覆盖
 * 全局 `.page` 的 gap，不动其它分支页。
 */
.map-page {
  gap: calc(var(--space-5) * 0.1);
}

.map-block {
  /* 同上：设备列表→实时数据间距 16px → 1.6px。 */
  margin-top: calc(var(--space-4) * 0.1);
}

/*
 * 左设备列表 / 右告警列表。
 *
 * **两栏等宽**（业主："宽度调整为现在的 50%"：那一列原来是整幅宽）。
 *
 * 「告警卡片高度与左侧一致」是怎么做到的（纯 CSS，没有量盒子、没有 ResizeObserver）：
 *   1. 网格项默认 `align-items: stretch`，所以两张卡在同一行里本来就被拉成同一高度；
 *   2. 问题在于**行高由谁决定** —— 内容是 `auto` 时取两者中更高的那个。告警列表可能比
 *      设备列表长得多（20 条告警 vs 3 台设备），那样行高会被告警那一侧撑开，
 *      于是"一样高"变成了"一起变高"。
 *   3. 所以告警卡的内容被放进 `.map-block__fill`：**绝对定位**的元素不参与父级的内容高度计算
 *      （`.map-block--alarms` 是 `position: relative`），行高因此只由设备卡决定，
 *      告警卡被 `stretch` 拉成完全一样的高度，内容超出就在卡片内部滚动（`.map-alarms`）。
 *   4. `min-height` 写在**两张卡上、同一个值**：只有一台设备时设备卡很矮，
 *      这一条保证两张都至少这么高（否则告警卡会被压成一条缝）。
 */
.map-split {
  /*
   * `auto-fit` + `minmax(340px, 1fr)`：宽窗口上两栏**各占一半**（业主："宽度调整为现在的 50%"，
   * 即设备列表从整幅宽收到半幅），窄到放不下两栏时自动落回上下排列 ——
   * 不写像素断点，与页面其它自适应板子同一种做法。
   */
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  align-items: stretch;
  gap: var(--space-4);
  margin-top: var(--space-4);
}

/* 分栏之后这一行自己不再叠 `margin-top`：间距由 `.map-split` 的 `gap` 管。 */
.map-split > .map-block {
  margin-top: 0;
}

.map-block--devices,
.map-block--alarms {
  min-height: 320px;
}

.map-block--alarms {
  position: relative;
  padding: 0;
  overflow: hidden;
}

.map-block__fill {
  position: absolute;
  inset: 0;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
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
 * 地图**右上角**的半透明状态栏（业主 2026-09-19 第 11 批第 4 条）。
 *
 * 三件事：
 *   1. **半透明**：`color-mix()` 拿主题里的 `--color-bg` 兑 22% 透明。写成两行是为了
 *      老引擎兜底（前一行不认识时被丢弃，后一行生效）；两种情况下**文字都压在图上**，
 *      而画布本身是浅色底，所以即使背景没生效也读得清。
 *   2. `pointer-events: none`：它压在画布右上角，而标记是可点的 —— 状态栏不该挡住任何落点
 *      （标记都在画布内部，即使有也不该因为一条读数而点不到）。
 *   3. `z-index: 4`：低于悬停浮层（5），高于画布。
 */
/*
 * 在线底图（GIS，业主 2026-09-19 追加第 1 条）。
 *
 * 层次：瓦片层 0 -> SVG（底色透明后只剩落点）1 -> 控制条/署名 3；状态栏与浮层继续用
 * 原来的 4/5。瓦片层 `pointer-events: none`，所以滚轮/拖拽落在画布框上，按钮照常可点。
 */
.map-canvas-frame--tile {
  cursor: grab;
}

.map-canvas-frame--tile:active {
  cursor: grabbing;
}

.map-tile-layer {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  border-radius: var(--radius-sm);
  pointer-events: none;
}

.map-tile {
  position: absolute;
  display: block;
  pointer-events: none;
  user-select: none;
}

/* 在线底图自带道路与地名，再叠一层经纬度网格会像一张坏掉的坐标纸。 */
.map-canvas-frame--tile .map-grid {
  display: none;
}

/* SVG 必须压住瓦片层，落点才能点到；底色矩形在 tile 模式下透明。 */
.map-canvas {
  position: relative;
  z-index: 1;
}

.map-canvas__bg--transparent {
  fill: transparent;
}

/* 法定署名固定在地图右下角；不参与点击，因此不会挡住落点。 */
.map-attribution {
  position: absolute;
  right: var(--space-2);
  bottom: var(--space-2);
  z-index: 3;
  pointer-events: none;
  max-width: 62%;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.8);
  background: color-mix(in srgb, var(--color-bg) 80%, transparent);
  font-size: 11px;
  color: var(--color-text-secondary);
}

.map-zoom-controls {
  position: absolute;
  left: var(--space-2);
  bottom: var(--space-2);
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.86);
  background: color-mix(in srgb, var(--color-bg) 86%, transparent);
}

.map-zoom-level {
  min-width: 52px;
  text-align: center;
  font-size: 11.5px;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

/* 有些瓦片失败时如实说一句；它压在画布左上角，不吃鼠标事件。 */
.map-tile-error {
  position: absolute;
  left: var(--space-2);
  top: var(--space-2);
  z-index: 3;
  max-width: 62%;
  padding: 4px 8px;
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-sm);
  background: var(--color-warning-soft);
  color: var(--color-warning);
  font-size: 11.5px;
  pointer-events: none;
}

/* 底图未启用提示：与 .map-tile-error 同款做法，位置在左下（右下角是署名位）。 */
.map-tiles-off {
  position: absolute;
  left: var(--space-2);
  bottom: var(--space-2);
  z-index: 3;
  max-width: 62%;
  padding: 4px 8px;
  border: 1px solid var(--color-border, rgba(148, 163, 184, 0.4));
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.88);
  color: var(--color-text-muted, #64748b);
  font-size: 11.5px;
  pointer-events: none;
}

/* 网格坐标刻度（业主 20260921 批第 9 条）：小字、压线角上、不抢落点的视觉权重。 */
.map-grid__label {
  fill: var(--color-text-muted, #64748b);
  font-size: 10px;
  user-select: none;
}

.map-status {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  z-index: 4;
  pointer-events: none;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px var(--space-3);
  max-width: 46%;
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.78);
  background: color-mix(in srgb, var(--color-bg) 78%, transparent);
  backdrop-filter: blur(2px);
  font-size: 12px;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

.map-status__item {
  white-space: nowrap;
}

/* 告警那一项是这条状态栏里唯一"有事"的数：有未确认告警时用危险色。 */
.map-status__item--alarm[data-map-status-alarm-known='yes'] {
  color: var(--color-danger);
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

/*
 * 落点色点在列表里的样子。
 *
 * **图例已经删掉**（业主 2026-09-19 第 11 批第 4 条：「有未确认告警0在线0离线0」那一条点名删除），
 * 所以颜色现在只剩两处：地图上的落点，以及实时数据列表每行前面那个带 `title` 的点
 * （`mapUi.legendAlarm` =「有未确认告警」）。设备列表按第 5 条只留 序号/名称/状态 三列，
 * 那里不再放色点 —— 那句话因此仍写在点自己的悬停提示里，颜色没有独自承载信息。
 */
.map-table__tone {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
  flex: none;
  margin-right: 6px;
  vertical-align: middle;
}

.map-table__tone--alarm {
  background: var(--color-danger);
}

.map-table__tone--online {
  background: var(--color-success);
}

.map-table__tone--offline {
  background: var(--color-text-tertiary);
}

.map-table {
  width: 100%;
}

/* 序号列：业主 2026-09-19 更正第 3 条（设备管理页同款）——「序号下面的数字应该是居中对齐」。 */
.map-table .map-table__index {
  text-align: center;
  white-space: nowrap;
}

.map-table__num {
  text-align: right;
  white-space: nowrap;
}

/*
 * 设备名称是一个入口（点它进设备详情）：看起来仍是一格文字，但指针与 hover 说得出它是可点的。
 * 这三条与设备管理页那一套 `.devices-table__name--action` 是同一份读法。
 */
.map-table__name {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.map-table__name:hover {
  color: var(--color-accent-hover);
  text-decoration: underline;
}

.map-table__name:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: var(--radius-sm);
}

/* 翻页（第 5 条）：上一页 / 第 N 页 / 下一页，右对齐在设备卡底部。 */
.map-pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-2);
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

/*
 * 告警条目列表。
 *
 * 与左边设备卡**同高**之后，这一列的高度是定死的（由设备卡决定），所以这里不再写
 * `max-height: 260px`：那会在高窗口上留出一段空白、在矮窗口上又把卡片顶高。
 * 改成"占满剩余高度、超出自己滚"（`flex: 1` + `min-height: 0`），配合
 * `.map-block__fill` 的 flex 列布局 —— 抓图那一块因此在它下面正常占位。
 */
.map-alarms {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 auto;
  min-height: 0;
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
