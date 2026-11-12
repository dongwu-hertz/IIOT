<script setup lang="ts">
/**
 * **地图信息（GIS）**（原「点位图」，业主 2026-09-17 第 8 批建的页；2026-09-18 第 10 批
 *
 * 2026-09-21 UI 收敛：本页现在只承担 GIS Monitoring Console。地图是唯一主工作区；
 * 设备列表、完整告警工作台和 RealtimeMonitor 不再常驻页面，选中落点后只显示轻量详情与跳转入口。
 * 2026-09-22：地图控件统一改用 Lucide 图标；地图设置入口从本页移除；GIS 页始终渲染系统设置选定的底图。
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

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import type { AlarmEvent, Device } from '@shared/domain/models'
import type { E2SyncOutcome } from '@shared/ipc/contract'
import {
  deviceMapLayout,
  mapBounds,
  mapGridSteps,
  mapProjector,
  type MapBounds,
  type MapDeviceInput
} from '@shared/domain/device-map'
import { isPointComplete } from '@shared/domain/device-installation'
import {
  MAX_TILE_ZOOM,
  MIN_TILE_ZOOM,
  latToWorldY,
  lonToWorldX,
  defaultMapTilesConfig,
  TILE_SIZE,
  clampTileZoom,
  panMapCenter,
  projectToViewport,
  tileCacheRelativePath,
  timeZoneCenter,
  viewTiles,
  type MapCenter,
  type MapTilePlacement,
  type MapTilesConfig
} from '@shared/domain/map-tiles'
import { toFileUrl } from '@renderer/lib/fileUrl'
import { deviceMapFocusId } from '@renderer/lib/deviceMapLink'
import { useDevicesStore } from '@renderer/stores/devices'
import {
  clearFloorPlan,
  loadFloorPlan,
  saveFloorPlan,
  type FloorPlanRecord
} from '@renderer/lib/floorPlanStore'
import { useSettingsStore } from '@renderer/stores/settings'
import { useDeviceDetailDialogStore } from '@renderer/stores/deviceDetailDialog'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { formatDateTime, formatNumber } from '@renderer/lib/format'
import EmptyState from '@renderer/components/EmptyState.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'
import {
  Search,
  MapPin,
  Monitor,
  BellRing,
  Wifi,
  WifiOff,
  Crosshair,
  ZoomIn,
  ZoomOut,
  LocateFixed,
  TriangleAlert,
  X,
  ImagePlus,
  Trash2,
  Maximize
} from 'lucide-vue-next'

const { t } = useI18n()
const route = useRoute()
const devices = useDevicesStore()
const settings = useSettingsStore()
const detailDialog = useDeviceDetailDialogStore()

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

const selectedId = ref('')
const alarms = ref<AlarmEvent[]>([])
const alarmsLoading = ref(false)
const syncing = ref(false)
const syncOutcome = ref<E2SyncOutcome | null>(null)
const actionError = ref('')

// ---------------------------------------------------------------------------
// 平面图底图与设备部署（业主 2026-11-12）
// ---------------------------------------------------------------------------
/**
 * 导入的平面图保存在 IndexedDB（见 floorPlanStore.ts）。设备位置不放在图片里：
 * 每台设备的 installation.floorX/floorY 是相对图片的归一化坐标，换图后仍按比例复用。
 */
const floorPlan = ref<FloorPlanRecord | null>(null)
const floorPlanMode = ref(false)
const floorPlanBusy = ref(false)
const floorPlanNotice = ref('')
const floorPlanInput = ref<HTMLInputElement | null>(null)
const floorDraft = ref<Record<string, { x: number; y: number }>>({})
const floorDrag = {
  active: false,
  id: '',
  pointerId: -1,
  moved: false,
  element: null as Element | null
}

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
  const center = homeView.value
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
 * GIS Console 始终需要一个真实底图。地图服务、API key、缓存来源等仍只在
 * System Settings -> Integrations -> Maps & GIS 中维护；本页只消费配置，不再提供设置入口。
 *
 * 旧实现把 `mapTiles.enabled === false` 解释成“完全不画底图”，因此默认设置下只剩经纬度网格，
 * 很容易被理解为“地图没有加载”。现在将 `enabled` 仅视为旧版本兼容字段：GIS 页面始终渲染
 * 当前选择的地图源；设置尚未加载时使用共享层的默认 OpenStreetMap 配置作为运行时兜底。
 * 这里不会回写设置。
 */
const tileConfig = computed<MapTilesConfig>(() => {
  const configured = settings.settings?.mapTiles ?? defaultMapTilesConfig()
  return { ...configured, enabled: true }
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
 * 「家」中心：设置里 `mapTiles.defaultCenter` 优先，其次时区中心（业主 20260921 批）。
 *
 * `defaultCenter` 是添加/编辑设备保存 GIS 坐标时主进程自动写入的 —— 操作员最近
 * 录点位的位置就是他想看的地图。时区中心逻辑保留作兜底（还没有任何设备录点位时）。
 */
const homeView = computed<MapCenter>(() => {
  const center = settings.settings?.mapTiles?.defaultCenter
  if (
    center &&
    Number.isFinite(center.lat) &&
    Number.isFinite(center.lon) &&
    Math.abs(center.lat) <= 90 &&
    Math.abs(center.lon) <= 180
  ) {
    return { latitude: center.lat, longitude: center.lon, zoom: clampTileZoom(center.zoom) }
  }
  return timeZoneView
})

/**
 * 当前视野。
 *
 * **普通 ref + 普通事件处理器**：绝不在 patch 期间写它（第 36 轮那条硬规矩）。
 * 开关打开时从时区中心起；设备可能不在中心附近，操作员用缩放/拖拽自己找。
 */
const mapView = ref<MapCenter | null>(null)
const tileErrors = ref<string[]>([])
watch(
  homeView,
  (center) => {
    mapView.value = { ...center }
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

/**
 * 本地缓存来源（业主 20260921 批「本地缓存地图」）：瓦片优先走 file:// 已下载缓存，
 * 未命中再回落在线 https（tile.url 本来就是 https，session 放行名单里两类都在）。
 */
const useTileCache = computed(() => tileConfig.value?.cachePath === 'map-cache')

/** 存储根（appInfo 里带；渲染层没有文件系统，只能拼 file:// 让 `<img>` 自己读）。 */
const mapStorageRoot = computed(() => settings.appInfo?.storageRoot ?? '')

/** 一块瓦片的本地缓存地址；存储根还没读到时返回空串（调用方回落在线 URL）。 */
function tileCacheUrl(tile: MapTilePlacement): string {
  const config = tileConfig.value
  const root = mapStorageRoot.value
  if (!config || root === '') return ''
  const relative = tileCacheRelativePath(config.service, tile.z, tile.x, tile.y)
  return toFileUrl(`${root.replace(new RegExp(String.fromCharCode(92), 'g'), '/')}/${relative}`)
}

/**
 * 每块瓦片当前走哪条路：缺省 = 本地缓存（仅本地来源时）；`'online'` = 缓存未命中
 * 后的在线兜底；`'failed'` = 两条路都不通。与 `tileErrors` 一样按 `tile.key` 记录，
 * 重铺瓦片时旧键被清掉（避免异步 error 串台）。
 */
const tileModes = ref<Record<string, 'online' | 'failed'>>({})

/** 瓦片 `<img>` 的地址：本地来源先给 file:// 缓存，否则/未命中给在线 URL。 */
function tileSrc(tile: MapTilePlacement): string {
  if (useTileCache.value && tileModes.value[tile.key] !== 'online') {
    const cached = tileCacheUrl(tile)
    if (cached !== '') return cached
  }
  return tile.url
}

function onTileError(tile: MapTilePlacement): void {
  // 本地缓存未命中、且在线模板可用：回落 https 原样加载一次。
  if (useTileCache.value && tileModes.value[tile.key] !== 'online' && tile.url !== '') {
    tileModes.value = { ...tileModes.value, [tile.key]: 'online' }
    return
  }
  tileModes.value = { ...tileModes.value, [tile.key]: 'failed' }
  if (!tileErrors.value.includes(tile.key)) tileErrors.value = [...tileErrors.value, tile.key]
}

/** 失败瓦片用**键**记录：重新铺瓦片后旧键不再参与计数（避免异步 error 串台）。 */
const tileFailureCount = computed(
  () => tilePlacements.value.filter((tile) => tileErrors.value.includes(tile.key)).length
)

// 只留**当前这批瓦片**的键：老键留着没有任何用处（对应的 <img> 已经销毁），
// 一张图拖一整天，这个数组会变成一份只进不出的失败日志（G3 修复）。
// tileModes 同一条纪律：来源状态跟着键走，铺新瓦片时旧键一起清。
watch(tilePlacements, (placements) => {
  const live = new Set(placements.map((tile) => tile.key))
  if (tileErrors.value.length > 0) {
    tileErrors.value = tileErrors.value.filter((key) => live.has(key))
  }
  const modes = tileModes.value
  const modeKeys = Object.keys(modes)
  if (modeKeys.some((key) => !live.has(key))) {
    tileModes.value = Object.fromEntries(modeKeys.filter((key) => live.has(key)).map((key) => [key, modes[key] as 'online' | 'failed']))
  }
})

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
  if (floorPlanMode.value) return
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
  if (floorPlanMode.value) return
  if (!tileConfig.value || event.button !== 0) return
  drag.active = true
  drag.startX = event.clientX
  drag.startY = event.clientY
  drag.center = { ...activeCenter.value }
  const target = event.currentTarget as HTMLElement | null
  target?.setPointerCapture?.(event.pointerId)
}

function onMapPointerMove(event: PointerEvent): void {
  if (floorPlanMode.value || !drag.active || !drag.center) return
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
  if (floorPlanMode.value || !drag.active) return
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

/** 回到家中心（defaultCenter 优先、时区兜底；与放大/缩小共用的入口）。 */
function resetMapView(): void {
  mapView.value = { ...homeView.value }
}

/**
 * 把全部有 GIS 点位的设备装进当前视野（业主 2026-11-12：地图界面默认显示最多设备）。
 *
 * 用 Web Mercator 的世界像素宽度反推缩放级别：在 zoom 0 下算一次世界宽高，再找
 * 能容纳画布可用区域的最大 2 的幂。这是地图页的默认视角；`?device=` 指向单台时
 * 仍由 `centerOnDevice()` 覆盖为单台居中。
 */
function fitAllDevices(): void {
  const bounds = mapBounds(mapInputs.value)
  if (!bounds) {
    resetMapView()
    return
  }
  const centerLatitude = (bounds.minLat + bounds.maxLat) / 2
  const centerLongitude = (bounds.minLon + bounds.maxLon) / 2
  const worldWidth = Math.abs(lonToWorldX(bounds.maxLon, 0) - lonToWorldX(bounds.minLon, 0))
  const worldHeight = Math.abs(latToWorldY(bounds.maxLat, 0) - latToWorldY(bounds.minLat, 0))
  const usableWidth = Math.max(1, CANVAS.width - MAP_PADDING * 2)
  const usableHeight = Math.max(1, CANVAS.height - MAP_PADDING * 2)
  const ratio = Math.min(
    usableWidth / Math.max(worldWidth, 1e-9),
    usableHeight / Math.max(worldHeight, 1e-9)
  )
  const zoom = clampTileZoom(Math.floor(Math.log2(Math.max(ratio, 1))))
  mapView.value = { latitude: centerLatitude, longitude: centerLongitude, zoom }
}
/**
 * 显示用落点：离线模式沿用原来的"按设备范围铺满"；在线模式用 Web Mercator 投影。
 * 两种模式共用同一套 SVG 标记与色调，只是坐标来源不同。
 */
const displayMarkers = computed(() => {
  const config = tileConfig.value
  if (!config) return layout.value.markers.map((marker) => ({ ...marker, floorPlaced: true }))
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
        longitude: device.longitude,
        floorPlaced: true
      }
    })
})

/**
 * 平面图模式下的落点：有 floorX/floorY 的设备按归一化位置画；没有部署的先在底部
 * 按网格排一个临时位置，保证默认能看到最多设备。拖动后调用 devices.update
 * 把归一化坐标写回 installation，下一次打开就在真实位置。
 */
const floorMarkers = computed(() => {
  const unplaced = devices.devices.filter((device) => {
    const installation = device.installation
    return (
      installation?.floorX === undefined ||
      installation?.floorY === undefined ||
      !Number.isFinite(installation.floorX) ||
      !Number.isFinite(installation.floorY)
    )
  })
  const autoIndex = new Map<string, number>()
  unplaced.forEach((device, index) => autoIndex.set(device.id, index))
  const columns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, unplaced.length))))
  const rows = Math.max(1, Math.ceil(Math.max(1, unplaced.length) / columns))

  return devices.devices.map((device) => {
    const draft = floorDraft.value[device.id]
    const fx = draft?.x ?? device.installation?.floorX
    const fy = draft?.y ?? device.installation?.floorY
    const placed =
      fx !== undefined && fy !== undefined && Number.isFinite(fx) && Number.isFinite(fy)
    let x: number
    let y: number
    if (placed) {
      x = Math.max(0, Math.min(CANVAS.width, fx * CANVAS.width))
      y = Math.max(0, Math.min(CANVAS.height, fy * CANVAS.height))
    } else {
      const index = autoIndex.get(device.id) ?? 0
      const column = index % columns
      const row = Math.floor(index / columns)
      x = ((column + 0.5) / columns) * CANVAS.width
      y = CANVAS.height - 42 - (rows - 1 - row) * 40
    }
    return {
      id: device.id,
      name: device.name,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      latitude: device.installation?.gisLatitude,
      longitude: device.installation?.gisLongitude,
      floorPlaced: placed
    }
  })
})
const activeDisplayMarkers = computed(() =>
  floorPlanMode.value && floorPlan.value ? floorMarkers.value : displayMarkers.value
)

const mappedCount = computed(() =>
  floorPlanMode.value && floorPlan.value ? floorMarkers.value.length : layout.value.markers.length
)
const selectedDevice = computed<Device | undefined>(() =>
  selectedId.value === '' ? undefined : devices.byId(selectedId.value)
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

type MapDeviceFilter = 'all' | 'alarm' | 'online' | 'offline'
const mapSearch = ref('')
const mapDeviceFilter = ref<MapDeviceFilter>('all')

function matchesMapFilter(device: Device): boolean {
  if (mapDeviceFilter.value === 'alarm') return (alarmFacts.value[device.id]?.pending ?? 0) > 0
  if (mapDeviceFilter.value === 'online') return device.status === 'ONLINE'
  if (mapDeviceFilter.value === 'offline') return device.status !== 'ONLINE'
  return true
}

const filteredDisplayMarkers = computed(() => {
  const term = mapSearch.value.trim().toLocaleLowerCase()
  return activeDisplayMarkers.value.filter((marker) => {
    const device = devices.byId(marker.id)
    if (!device || !matchesMapFilter(device)) return false
    return term === '' || device.name.toLocaleLowerCase().includes(term) || (device.ip ?? '').toLocaleLowerCase().includes(term)
  })
})

const mapSearchResults = computed(() => {
  const term = mapSearch.value.trim().toLocaleLowerCase()
  if (term === '') return []
  return filteredDisplayMarkers.value.slice(0, 8)
})

function chooseSearchResult(deviceId: string): void {
  selectDevice(deviceId)
  centerOnDevice(deviceId)
  mapSearch.value = ''
}

const selectedFacts = computed<DeviceAlarmFacts | undefined>(() =>
  selectedDevice.value ? alarmFacts.value[selectedDevice.value.id] : undefined
)
const selectedLatestAlarm = computed<AlarmEvent | undefined>(() => alarms.value[0])

/** 图上每一个标记的色调（按 id 查一次，模板里不用重复算）。 */
const markerTones = computed<Record<string, 'alarm' | 'online' | 'offline'>>(() => {
  const out: Record<string, 'alarm' | 'online' | 'offline'> = {}
  for (const marker of activeDisplayMarkers.value) {
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
  syncOutcome.value = null
  void loadAlarms(deviceId)
}

function clearSelectedDevice(): void {
  selectedId.value = ''
  alarms.value = []
  syncOutcome.value = null
}

/** 双击一行设备 / 点设备名 = 打开这一台的详情**弹窗**（业主 20260921；声纹设备与相机都走这一条）。 */
function openDeviceDetail(deviceId: string): void {
  detailDialog.show(deviceId, devices.byId(deviceId)?.name ?? '')
}

// ---------------------------------------------------------------------------
// 悬停浮层（业主第 15、16 条）
// ---------------------------------------------------------------------------

const hoveredId = ref('')

const hoveredDevice = computed<Device | undefined>(() =>
  hoveredId.value === '' ? undefined : devices.byId(hoveredId.value)
)

/** 地图悬停只保留现场判断最需要的信息：设备、连接状态、告警和最近 SPL。 */
function openHover(deviceId: string): void {
  hoveredId.value = deviceId
}

function closeHover(): void {
  hoveredId.value = ''
}

/**
 * 浮层的位置：百分比，不量盒子。标记坐标与 1280×720 SVG 使用同一套逻辑坐标。
 */
const hoverStyle = computed(() => {
  const device = hoveredDevice.value
  if (!device) return {}
  const marker = activeDisplayMarkers.value.find((item) => item.id === device.id)
  if (!marker) return {}
  return {
    left: `${((marker.x / CANVAS.width) * 100).toFixed(3)}%`,
    top: `${((marker.y / CANVAS.height) * 100).toFixed(3)}%`
  }
})

const hoverSplText = computed(() => {
  const device = hoveredDevice.value
  if (!device) return '—'
  const spl = alarmFacts.value[device.id]?.latestSpl
  return spl === undefined ? '—' : `${formatNumber(spl, 1)} dB`
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

// ---------------------------------------------------------------------------
// 平面图导入 / 设备部署
// ---------------------------------------------------------------------------
function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('image decode failed'))
    image.src = dataUrl
  })
}

function selectFloorPlanFile(): void {
  floorPlanInput.value?.click()
}

async function onFloorPlanSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    floorPlanNotice.value = t('floorPlanUi.importFailed')
    return
  }
  floorPlanBusy.value = true
  floorPlanNotice.value = ''
  try {
    const dataUrl = await fileAsDataUrl(file)
    const size = await imageSize(dataUrl)
    const record: FloorPlanRecord = {
      name: file.name,
      dataUrl,
      width: size.width,
      height: size.height,
      importedAt: Date.now()
    }
    if (!(await saveFloorPlan(record))) {
      floorPlanNotice.value = t('floorPlanUi.storageFailed')
      return
    }
    floorPlan.value = record
    floorPlanMode.value = true
    floorDraft.value = {}
    floorPlanNotice.value = t('floorPlanUi.imported', { name: file.name })
  } catch {
    floorPlanNotice.value = t('floorPlanUi.importFailed')
  } finally {
    floorPlanBusy.value = false
  }
}

async function removeFloorPlanImage(): Promise<void> {
  await clearFloorPlan()
  floorPlan.value = null
  floorPlanMode.value = false
  floorDraft.value = {}
  floorPlanNotice.value = t('floorPlanUi.removed')
}

function toggleFloorPlanMode(): void {
  if (!floorPlan.value) return
  floorPlanMode.value = !floorPlanMode.value
}

/**
 * 拖动平面图上的设备标记：pointerdown 先选中设备，pointermove 实时更新草稿位置，
 * pointerup 才写库（不把每一帧都过一遍 IPC 与 SQLite）。
 */
function onMarkerPointerDown(deviceId: string, event: PointerEvent): void {
  if (floorPlanMode.value) onFloorMarkerPointerDown(deviceId, event)
}

function onFloorMarkerPointerDown(deviceId: string, event: PointerEvent): void {
  if (!floorPlanMode.value || !floorPlan.value || event.button !== 0) return
  event.stopPropagation()
  event.preventDefault()
  floorDrag.active = true
  floorDrag.id = deviceId
  floorDrag.pointerId = event.pointerId
  floorDrag.moved = false
  floorDrag.element = event.currentTarget as Element
  selectDevice(deviceId)
  floorDrag.element.setPointerCapture?.(event.pointerId)
}

function onFloorPointerMove(event: PointerEvent): void {
  if (!floorDrag.active) return
  const frame = event.currentTarget as HTMLElement | null
  if (!frame) return
  const rect = frame.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
  floorDraft.value = { ...floorDraft.value, [floorDrag.id]: { x, y } }
  floorDrag.moved = true
}

async function onFloorPointerUp(event: PointerEvent): Promise<void> {
  if (!floorDrag.active) return
  const id = floorDrag.id
  const moved = floorDrag.moved
  const point = floorDraft.value[id]
  floorDrag.active = false
  floorDrag.id = ''
  floorDrag.element?.releasePointerCapture?.(event.pointerId)
  floorDrag.element = null
  if (!moved || point === undefined) return
  const updated = await devices.update({
    id,
    installation: { floorX: point.x, floorY: point.y }
  })
  if (updated) {
    const next = { ...floorDraft.value }
    delete next[id]
    floorDraft.value = next
    floorPlanNotice.value = t('floorPlanUi.saved', { name: updated.name })
  } else {
    floorPlanNotice.value = t('floorPlanUi.saveFailed')
  }
}
let unsubscribeAlarmPending: (() => void) | undefined

onMounted(async () => {
  // 地图配置与开关都在设置里；进这一页也要能自己读到（settings 是共享 store，不会重复请求）。
  if (!settings.loaded) await settings.load()
  if (devices.devices.length === 0) await devices.load()
  const storedFloorPlan = await loadFloorPlan()
  if (storedFloorPlan) {
    floorPlan.value = storedFloorPlan
    floorPlanMode.value = true
  }
  await loadDeviceAlarmFacts()
  // 气井泄漏告警落库后，主进程会推 pending 快照；地图上那台设备要立刻变红。
  unsubscribeAlarmPending = window.events.onLinkagePending(() => {
    void loadDeviceAlarmFacts()
  })
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
  if (focused) {
    selectDevice(focused.id)
    // 在线底图下，时区中心不一定看得到这一台；?device= 要把它居中。
    centerOnDevice(focused.id)
  } else if (!floorPlanMode.value) {
    // 默认把全部有 GIS 点位的设备装进视野（业主 2026-11-12：默认显示最多设备）。
    fitAllDevices()
  }
})

onBeforeUnmount(() => {
  unsubscribeAlarmPending?.()
})

</script>

<template>
  <div class="page map-page">
    <p v-if="actionError" class="alert alert--danger" role="alert">{{ actionError }}</p>
    <p v-if="floorPlanNotice" class="alert alert--success" role="status">{{ floorPlanNotice }}</p>

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
          :class="{ 'map-canvas-frame--tile': tileConfig && !floorPlanMode }"
          data-map-canvas-frame
          :data-map-tiles-enabled="tileConfig && !floorPlanMode ? 'yes' : 'no'"
          :data-map-floor-plan="floorPlan ? 'yes' : 'no'"
          :data-map-floor-mode="floorPlanMode ? 'yes' : 'no'"
          :data-map-zoom="tileConfig && !floorPlanMode ? mapZoom : null"
          :data-map-center="tileConfig && !floorPlanMode ? activeCenter.latitude.toFixed(5) + ',' + activeCenter.longitude.toFixed(5) : null"
          :data-map-timezone="tileConfig && !floorPlanMode ? systemTimeZone : null"
          @wheel="onMapWheel"
          @pointerdown="onMapPointerDown"
          @pointermove="floorPlanMode ? onFloorPointerMove($event) : onMapPointerMove($event)"
          @pointerup="floorPlanMode ? onFloorPointerUp($event) : onMapPointerUp($event)"
          @pointercancel="floorPlanMode ? onFloorPointerUp($event) : onMapPointerUp($event)"
        >
          <input
            ref="floorPlanInput"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/bmp"
            style="display: none"
            data-map-floor-plan-input
            @change="onFloorPlanSelected"
          />
          <div class="map-toolbar" data-map-toolbar @pointerdown.stop @wheel.stop>
            <div class="map-toolbar__search-wrap">
              <Search class="map-toolbar__search-icon" :size="15" :stroke-width="1.8" aria-hidden="true" />
              <input
                v-model="mapSearch"
                class="input map-toolbar__search"
                type="search"
                placeholder="Search mapped devices"
                aria-label="Search mapped devices"
              />
              <div v-if="mapSearchResults.length > 0" class="map-search-results">
                <button
                  v-for="result in mapSearchResults"
                  :key="result.id"
                  type="button"
                  class="map-search-results__item"
                  @click="chooseSearchResult(result.id)"
                >
                  <span>{{ result.name }}</span>
                  <span class="muted">{{ devices.byId(result.id)?.ip }}</span>
                </button>
              </div>
            </div>
            <div class="map-toolbar__filters" role="group" aria-label="Device status filter">
              <button type="button" class="btn btn--icon map-icon-btn" :class="{ 'btn--primary': mapDeviceFilter === 'all' }" title="All mapped devices" aria-label="All mapped devices" @click="mapDeviceFilter = 'all'">
                <MapPin :size="15" :stroke-width="1.8" aria-hidden="true" />
              </button>
              <button type="button" class="btn btn--icon map-icon-btn" :class="{ 'btn--primary': mapDeviceFilter === 'alarm' }" title="Devices with alarms" aria-label="Devices with alarms" @click="mapDeviceFilter = 'alarm'">
                <BellRing :size="15" :stroke-width="1.8" aria-hidden="true" />
              </button>
              <button type="button" class="btn btn--icon map-icon-btn" :class="{ 'btn--primary': mapDeviceFilter === 'online' }" title="Online devices" aria-label="Online devices" @click="mapDeviceFilter = 'online'">
                <Wifi :size="15" :stroke-width="1.8" aria-hidden="true" />
              </button>
              <button type="button" class="btn btn--icon map-icon-btn" :class="{ 'btn--primary': mapDeviceFilter === 'offline' }" title="Offline devices" aria-label="Offline devices" @click="mapDeviceFilter = 'offline'">
                <WifiOff :size="15" :stroke-width="1.8" aria-hidden="true" />
              </button>
            </div>
            <button
              type="button"
              class="btn btn--icon map-icon-btn"
              data-action="import-floor-plan"
              :title="floorPlan ? t('floorPlanUi.replaceButton') : t('floorPlanUi.importButton')"
              :aria-label="floorPlan ? t('floorPlanUi.replaceButton') : t('floorPlanUi.importButton')"
              :disabled="floorPlanBusy"
              @click="selectFloorPlanFile"
            >
              <ImagePlus :size="15" :stroke-width="1.8" aria-hidden="true" />
            </button>
            <button
              v-if="floorPlan"
              type="button"
              class="btn btn--icon map-icon-btn"
              :class="{ 'btn--primary': floorPlanMode }"
              data-action="toggle-floor-plan"
              :title="floorPlanMode ? t('floorPlanUi.modeGis') : t('floorPlanUi.modeFloor')"
              :aria-label="floorPlanMode ? t('floorPlanUi.modeGis') : t('floorPlanUi.modeFloor')"
              @click="toggleFloorPlanMode"
            >
              <ImagePlus :size="15" :stroke-width="1.8" aria-hidden="true" />
            </button>
            <button
              v-if="floorPlan"
              type="button"
              class="btn btn--icon map-icon-btn"
              data-action="remove-floor-plan"
              :title="t('floorPlanUi.removeButton')"
              :aria-label="t('floorPlanUi.removeButton')"
              @click="removeFloorPlanImage"
            >
              <Trash2 :size="15" :stroke-width="1.8" aria-hidden="true" />
            </button>
            <button
              v-if="!floorPlanMode"
              type="button"
              class="btn btn--icon map-icon-btn"
              data-action="fit-all-devices"
              :title="t('mapUi.fitAll')"
              :aria-label="t('mapUi.fitAll')"
              @click="fitAllDevices"
            >
              <Maximize :size="15" :stroke-width="1.8" aria-hidden="true" />
            </button>            <button type="button" class="btn btn--icon map-icon-btn" title="Center map" aria-label="Center map" @click="resetMapView">
              <Crosshair :size="15" :stroke-width="1.8" aria-hidden="true" />
            </button>
          </div>

          <!--
            在线底图：GIS 页始终渲染 System Settings 选定的地图源；设置尚未加载时使用默认 OSM。
            瓦片是普通 <img>（connect-src 仍是 none，因此不能变成 fetch 数据通道）；
            署名固定在地图右下角，放大/缩小/拖拽在控制条与画布手势上。
          -->
          <img
            v-if="floorPlanMode && floorPlan"
            class="map-floor-plan"
            :src="floorPlan.dataUrl"
            alt=""
            draggable="false"
            data-map-floor-plan-image
          />
          <div v-if="tileConfig && !floorPlanMode" class="map-tile-layer" data-map-tiles>
            <img
              v-for="tile in tilePlacements"
              :key="tile.key"
              class="map-tile"
              :src="tileSrc(tile)"
              :style="tileStyle(tile)"
              alt=""
              draggable="false"
              loading="eager"
              decoding="async"
              referrerpolicy="no-referrer"
              data-map-tile
              :data-tile-key="tile.key"
              :data-tile-mode="tileModes[tile.key] ?? (useTileCache ? 'cache' : 'online')"
              @error="onTileError(tile)"
            />
            <!--
              某些瓦片加载失败（没有外网、服务拒绝）时如实说一句，而不是留一块白，
              更不能把失败说成"这里没有地图"。点位与设备列表不依赖瓦片。
            -->
            <div
              v-if="tileFailureCount > 0"
              class="map-tile-error"
              data-map-tile-error
              role="status"
              :title="t('mapUi.tilesError', { failed: tileFailureCount, total: tilePlacements.length })"
              :aria-label="t('mapUi.tilesError', { failed: tileFailureCount, total: tilePlacements.length })"
            >
              <TriangleAlert :size="16" :stroke-width="1.8" aria-hidden="true" />
              <span>{{ tileFailureCount }}</span>
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
            <rect x="0" y="0" :width="CANVAS.width" :height="CANVAS.height" class="map-canvas__bg" :class="{ 'map-canvas__bg--transparent': tileConfig || floorPlanMode }" />
            <!-- 经纬度网格：视野小时步长自动变小（`mapGridSteps`）。没有落点时用兜底视野
                 （`effectiveBounds`），网格与坐标刻度始终在场 —— 这就是这一页的 GIS 信息本体。 -->
            <g v-if="!floorPlanMode" class="map-grid">
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
              v-for="marker in filteredDisplayMarkers"
              :key="marker.id"
              class="map-marker"
              :class="[
                `map-marker--${markerTones[marker.id]}`,
                {
                  'map-marker--active': marker.id === selectedId,
                  'map-marker--floor-unplaced': floorPlanMode && marker.floorPlaced === false
                }
              ]"
              :transform="`translate(${marker.x} ${marker.y})`"
              role="button"
              tabindex="0"
              :data-map-marker="marker.id"
              :data-marker-tone="markerTones[marker.id]"
              :data-marker-blink="markerTones[marker.id] === 'alarm' ? 'yes' : 'no'"
              :data-floor-placed="marker.floorPlaced === undefined ? null : String(marker.floorPlaced)"
              @pointerdown="onMarkerPointerDown(marker.id, $event)"
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

          <div v-if="floorPlanMode" class="map-floor-plan-hint" data-map-floor-plan-hint>
            {{ t('floorPlanUi.dragHint') }}
          </div>

          <!--
            署名与缩放控制放在 SVG **外面**（同一层、z-index 更高）：
            它们在瓦片层之上、可点；瓦片本身永远不会被控制条挡住。
          -->
          <div v-if="tileConfig?.attribution && !floorPlanMode" class="map-attribution" data-map-attribution>
            {{ tileConfig?.attribution }}
          </div>
          <div v-if="!floorPlanMode" class="map-zoom-controls" data-map-zoom-controls @pointerdown.stop @wheel.stop>
            <button
              type="button"
              class="btn btn--icon map-icon-btn"
              data-map-zoom-in
              :title="t('mapUi.zoomIn')"
              :aria-label="t('mapUi.zoomIn')"
              :disabled="zoomInDisabled"
              @click="zoomBy(1)"
            >
              <ZoomIn :size="16" :stroke-width="1.8" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="btn btn--icon map-icon-btn"
              data-map-zoom-out
              :title="t('mapUi.zoomOut')"
              :aria-label="t('mapUi.zoomOut')"
              :disabled="zoomOutDisabled"
              @click="zoomBy(-1)"
            >
              <ZoomOut :size="16" :stroke-width="1.8" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="btn btn--icon map-icon-btn"
              data-map-zoom-reset
              :title="t('mapUi.zoomReset')"
              :aria-label="t('mapUi.zoomReset')"
              @click="resetMapView"
            >
              <LocateFixed :size="16" :stroke-width="1.8" aria-hidden="true" />
            </button>
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
              <span class="map-table__tone" :class="`map-table__tone--${markerTone(hoveredDevice)}`" aria-hidden="true"></span>
              <strong>{{ hoveredDevice.name }}</strong>
            </div>
            <dl class="map-hover__kv">
              <div class="map-hover__item">
                <dt>{{ t('devicesUi.onlineColumn') }}</dt>
                <dd><StatusBadge :status="hoveredDevice.status" :connection-type="hoveredDevice.connectionType" /></dd>
              </div>
              <div class="map-hover__item">
                <dt>{{ t('mapUi.colAlarms') }}</dt>
                <dd>{{ hoverAlarmText }}</dd>
              </div>
              <div class="map-hover__item">
                <dt>{{ t('metrics.spl') }}</dt>
                <dd>{{ hoverSplText }}</dd>
              </div>
            </dl>
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
            <span class="map-status__item" data-map-status-mapped :title="t('mapUi.statusMapped', { count: mappedCount })">
              <MapPin :size="14" :stroke-width="1.8" aria-hidden="true" />
              <strong>{{ mappedCount }}</strong>
            </span>
            <span class="map-status__item" data-map-status-total :title="t('mapUi.statusTotal', { count: devices.devices.length })">
              <Monitor :size="14" :stroke-width="1.8" aria-hidden="true" />
              <strong>{{ devices.devices.length }}</strong>
            </span>
            <span class="map-status__item map-status__item--online" data-map-status-online :title="t('mapUi.statusOnline', { count: onlineCount })">
              <Wifi :size="14" :stroke-width="1.8" aria-hidden="true" />
              <strong>{{ onlineCount }}</strong>
            </span>
            <span class="map-status__item map-status__item--offline" data-map-status-offline :title="t('mapUi.statusOffline', { count: offlineCount })">
              <WifiOff :size="14" :stroke-width="1.8" aria-hidden="true" />
              <strong>{{ offlineCount }}</strong>
            </span>
            <span
              class="map-status__item map-status__item--alarm"
              data-map-status-alarms
              :data-map-status-alarm-known="alarmStatus.known ? 'yes' : 'no'"
              :title="t('mapUi.statusAlarms', { count: alarmStatus.known ? alarmStatus.pending : t('mapUi.notRead') })"
            >
              <BellRing :size="14" :stroke-width="1.8" aria-hidden="true" />
              <strong>{{ alarmStatus.known ? alarmStatus.pending : '—' }}</strong>
            </span>
          </div>

          <aside
            v-if="selectedDevice"
            class="map-detail-panel"
            data-map-detail-panel
            @pointerdown.stop
            @wheel.stop
          >
            <header class="map-detail-panel__header">
              <div class="map-detail-panel__title">
                <span class="map-table__tone" :class="`map-table__tone--${markerTone(selectedDevice)}`" aria-hidden="true"></span>
                <div>
                  <strong>{{ selectedDevice.name }}</strong>
                  <div class="muted mono map-detail-panel__ip">{{ selectedDevice.ip || '—' }}</div>
                </div>
              </div>
              <button type="button" class="btn btn--ghost btn--icon map-icon-btn" aria-label="Close device panel" title="Close" @click="clearSelectedDevice">
                <X :size="15" :stroke-width="1.8" aria-hidden="true" />
              </button>
            </header>

            <div class="map-detail-panel__status">
              <StatusBadge :status="selectedDevice.status" :connection-type="selectedDevice.connectionType" />
              <span v-if="(selectedFacts?.pending ?? 0) > 0" class="badge badge--danger">
                {{ selectedFacts?.pending }} {{ t('mapUi.alarmsTitle') }}
              </span>
            </div>

            <dl class="map-detail-panel__kv">
              <div>
                <dt>Position</dt>
                <dd class="mono">{{ pointText }}</dd>
              </div>
              <div>
                <dt>{{ t('installUi.azimuth') }}</dt>
                <dd>{{ liveAzimuth(selectedDevice) }}</dd>
              </div>
              <div>
                <dt>{{ t('metrics.spl') }}</dt>
                <dd>{{ selectedFacts?.latestSpl === undefined ? '—' : `${formatNumber(selectedFacts.latestSpl, 1)} dB` }}</dd>
              </div>
              <div>
                <dt>{{ t('mapUi.colAlarms') }}</dt>
                <dd>{{ selectedFacts?.pending === undefined || selectedFacts.pending < 0 ? '—' : selectedFacts.pending }}</dd>
              </div>
            </dl>

            <section class="map-detail-panel__latest">
              <div class="section-header">
                <h4 class="section-title">Latest Alarm</h4>
                <span v-if="alarmsLoading" class="muted">{{ t('common.loading') }}</span>
              </div>
              <div v-if="selectedLatestAlarm" class="map-latest-alarm">
                <div>
                  <strong>{{ formatDateTime(selectedLatestAlarm.timestamp) }}</strong>
                  <span class="muted">{{ selectedLatestAlarm.spl === undefined ? '—' : `${formatNumber(selectedLatestAlarm.spl, 1)} dB` }}</span>
                </div>
                <span class="badge" :class="selectedLatestAlarm.acknowledged ? 'badge--success' : 'badge--warning'">
                  {{ selectedLatestAlarm.acknowledged ? t('alarmsUi.ackAcknowledged') : t('alarmsUi.ackUnacknowledged') }}
                </span>
              </div>
              <p v-else-if="!alarmsLoading" class="muted map-detail-panel__empty">{{ t('mapUi.noAlarms') }}</p>
              <ul v-if="alarms.length > 0" class="map-latest-alarm__list" data-map-alarm-list>
                <li v-for="alarm in alarms.slice(0, 3)" :key="alarm.id" data-map-alarm-row>
                  <span>{{ t('alarmsUi.columnChannel') }} CH{{ alarm.channelId + 1 }}</span>
                  <span class="muted">{{ formatDateTime(alarm.timestamp) }}</span>
                </li>
              </ul>
            </section>

            <p v-if="syncOutcome" class="muted map-detail-panel__sync-result">
              {{ t('mapUi.syncOutcome', { created: syncOutcome.alarmsCreated, existing: syncOutcome.alarmsExisting, linked: syncOutcome.snapshotsLinked, missing: syncOutcome.filesMissing }) }}
            </p>

            <div class="map-detail-panel__actions">
              <RouterLink class="btn btn--primary btn--sm" :to="`/monitor?device=${selectedDevice.id}`">Live Monitor</RouterLink>
              <RouterLink class="btn btn--sm" :to="{ path: '/alarms', query: { device: selectedDevice.id } }">Alarm Center</RouterLink>
              <button type="button" class="btn btn--sm" @click="openDeviceDetail(selectedDevice.id)">{{ t('devicesUi.configure') }}</button>
              <button
                v-if="selectedDevice.kind === 'auscultationBox'"
                type="button"
                class="btn btn--sm"
                :disabled="syncing"
                @click="syncNow"
              >
                {{ syncing ? t('mapUi.syncing') : t('mapUi.sync') }}
              </button>
            </div>
          </aside>
        </div>

        <!-- 「点一个标记查看这台设备…」只在**图上有落点**时才有意义。 -->
        <p v-if="layout.markers.length > 0" class="muted map-panel__hint">{{ t('mapUi.selectHint') }}</p>
      </section>

      <!--
        GIS 页面只负责“设备在哪里、哪里有异常、如何快速进入下一步”。
        完整设备管理、告警处置与实时分析分别留在 Device Management / Alarm Center / Live Monitor，
        避免在地图页复制三套工作台。
      -->
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

/* GIS 页面只保留地图主体，因此页面本身不需要额外的纵向卡片间隔。 */
.map-page {
  gap: var(--space-2);
}

.map-toolbar {
  position: absolute;
  top: var(--space-2);
  left: var(--space-2);
  z-index: 6;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  max-width: calc(100% - 420px);
  padding: 5px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.88);
  background: color-mix(in srgb, var(--color-bg) 88%, transparent);
  backdrop-filter: blur(6px);
  box-shadow: 0 4px 14px rgba(16, 24, 40, 0.08);
}

.map-toolbar__search-wrap {
  position: relative;
}

.map-toolbar__search-icon {
  position: absolute;
  top: 50%;
  left: 9px;
  z-index: 2;
  color: var(--color-text-secondary);
  transform: translateY(-50%);
  pointer-events: none;
}

.map-toolbar__search {
  width: 210px;
  height: 30px;
  padding-left: 30px;
}

.map-icon-btn {
  width: 30px;
  min-width: 30px;
  height: 30px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.map-toolbar__filters {
  display: flex;
  align-items: center;
  gap: 4px;
}

.map-search-results {
  position: absolute;
  top: calc(100% + 5px);
  left: 0;
  z-index: 9;
  width: 280px;
  max-height: 260px;
  overflow: auto;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  box-shadow: 0 10px 28px rgba(16, 24, 40, 0.14);
}

.map-search-results__item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.map-search-results__item:hover {
  background: var(--color-bg-subtle);
}

.map-detail-panel {
  position: absolute;
  top: 54px;
  right: var(--space-2);
  z-index: 6;
  width: min(330px, calc(100% - 16px));
  max-height: calc(100% - 66px);
  overflow: auto;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.94);
  background: color-mix(in srgb, var(--color-bg) 94%, transparent);
  backdrop-filter: blur(8px);
  box-shadow: 0 10px 30px rgba(16, 24, 40, 0.14);
}

.map-detail-panel__header,
.map-detail-panel__title,
.map-detail-panel__status,
.map-detail-panel__actions,
.map-latest-alarm,
.map-latest-alarm > div {
  display: flex;
  align-items: center;
}

.map-detail-panel__header {
  justify-content: space-between;
  gap: var(--space-2);
}

.map-detail-panel__title {
  min-width: 0;
  gap: 6px;
}

.map-detail-panel__ip {
  margin-top: 2px;
  font-size: 11px;
}

.map-detail-panel__status {
  flex-wrap: wrap;
  gap: 6px;
  margin-top: var(--space-3);
}

.map-detail-panel__kv {
  margin: var(--space-3) 0 0;
}

.map-detail-panel__kv > div {
  display: grid;
  grid-template-columns: 86px 1fr;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--color-border);
  font-size: 12px;
}

.map-detail-panel__kv dt {
  color: var(--color-text-secondary);
}

.map-detail-panel__kv dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  text-align: right;
}

.map-detail-panel__latest {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
}

.map-latest-alarm {
  justify-content: space-between;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
  font-size: 11.5px;
}

.map-latest-alarm > div {
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.map-detail-panel__empty,
.map-detail-panel__sync-result {
  margin: 6px 0 0;
  font-size: 11.5px;
}

.map-detail-panel__actions {
  flex-wrap: wrap;
  gap: 6px;
  margin-top: var(--space-3);
}

@media (max-width: 980px) {
  .map-toolbar {
    max-width: calc(100% - 16px);
  }

  .map-status {
    top: 58px;
    max-width: calc(100% - 360px);
  }

  .map-detail-panel {
    top: auto;
    bottom: var(--space-2);
    max-height: 52%;
  }
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

.map-floor-plan {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  object-fit: fill;
  pointer-events: none;
  user-select: none;
}

.map-floor-plan-hint {
  position: absolute;
  left: 50%;
  bottom: 10px;
  z-index: 3;
  transform: translateX(-50%);
  padding: 4px 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-bg) 86%, transparent);
  color: var(--color-text-secondary);
  font-size: 12px;
  pointer-events: none;
  white-space: nowrap;
}

.map-marker--floor-unplaced {
  opacity: 0.78;
}

.map-marker--floor-unplaced .map-marker__dot {
  stroke-dasharray: 3 2;
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


/* 有些瓦片失败时如实说一句；它压在画布左上角，不吃鼠标事件。 */
.map-tile-error {
  position: absolute;
  left: var(--space-2);
  top: var(--space-2);
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 8px;
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-sm);
  background: var(--color-warning-soft);
  color: var(--color-warning);
  font-size: 11.5px;
  pointer-events: auto;
  cursor: help;
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
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  pointer-events: auto;
}


.map-status__item svg {
  flex: 0 0 auto;
}

.map-status__item strong {
  font-size: 11.5px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.map-status__item--online {
  color: var(--color-success);
}

.map-status__item--offline {
  color: var(--color-text-secondary);
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

/*
 * Tile mode must stay transparent so the raster basemap below the SVG remains visible.
 * This intentionally has higher specificity than `.map-canvas__bg`; otherwise the base
 * rule later in this style block masks every successfully loaded map tile.
 */
.map-canvas__bg.map-canvas__bg--transparent {
  fill: transparent;
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
.map-marker--alarm .map-marker__dot {
  animation: map-alarm-blink 0.9s ease-in-out infinite;
  filter: drop-shadow(0 0 4px var(--color-danger));
}

@keyframes map-alarm-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.28; }
}

@media (prefers-reduced-motion: reduce) {
  .map-marker--alarm .map-marker__dot {
    animation: none;
  }
}

.map-latest-alarm__list {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
}

.map-latest-alarm__list li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
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

</style>
