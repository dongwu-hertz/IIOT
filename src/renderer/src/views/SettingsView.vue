<script setup lang="ts">
/**
 * System settings (spec section 14.4)。
 *
 * The view edits a local DRAFT and only writes it through
 * `settings.update(patch)` when the user saves. That keeps the store honest
 * (it never claims the main process accepted something it did not) and makes it
 * possible to cancel an edit — including a freshly picked storage directory.
 *
 * "最小剩余空间" is edited in GB but stored in bytes; 1 GB = 1073741824 bytes.
 * The conversion lives in `lib/format.ts` so no component does the arithmetic.
 *
 * ---------------------------------------------------------------------------
 * 页签（业主 20260921 批大改）
 * ---------------------------------------------------------------------------
 *   常规   = 语言 / 存储 / 视频 / 缓存 四块合并的一页（紧凑双列小卡）
 *   集成   = 邮箱(SMTP) / 地图 / AI 三张卡（地图卡含瓦片服务选择与缓存下载）
 *   GIS 服务 = 命名 GIS 服务库（从地图卡里拆出来的自己的页签）
 *   告警联动 / 账户 / 关于 暂留原位。
 * 合并前 9 页 → 合并后 6 页（tests/settings-tabs.test.ts 的守卫在统一测试轮改）。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AppSettingsPatch, MapTileCacheProgress } from '@shared/ipc/contract'
import {
  MAP_TILE_PRESETS,
  MAX_MAP_SERVICES,
  MAX_TILE_ZOOM,
  MIN_TILE_ZOOM,
  defaultMapTilesConfig,
  mapServiceProblem,
  mapTilesProblem,
  newMapServiceId,
  tileUrl,
  timeZoneCenter,
  type MapServiceEntry,
  type MapTilesConfig,
  type MapTilesProblem
} from '@shared/domain/map-tiles'
import {
  AI_SERVICE_PRESETS,
  isAiServicePreset,
  type AiServicePresetId
} from '@shared/domain/sample-ai'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiRefreshStore } from '@renderer/stores/uiRefresh'
import { RELEASE, formatVersion, parsePlainDate } from '@shared/release'

/**
 * Logo resolved by the bundler, so it is emitted with a content hash and survives
 * packaging into the asar archive.
 */
import logoUrl from '@renderer/assets/branding/hertzinno-logo.png'
import { useTrendsStore } from '@renderer/stores/trends'
/*
 * `useIngestStore` 与 `iot-ingest` 那几个判据（`isBindAddress` / `isPort` / `telemetryPath` /
 * `MQTT_TELEMETRY_TOPIC`）**随「数据接入」页签一起搬走了** —— 它们现在在
 * `AddDeviceDialog.vue` 的「本机接入」那一块里（第 13 批第 1 条）。
 */
import {
  bytesToGb,
  formatBytes,
  formatDate,
  formatDateTime,
  formatGb,
  gbToBytes
} from '@renderer/lib/format'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import EmptyState from '@renderer/components/EmptyState.vue'
import LanguageSelect from '@renderer/components/LanguageSelect.vue'
import LinkageSettingsSection from '@renderer/components/LinkageSettingsSection.vue'
import AccountManagementSection from '@renderer/components/AccountManagementSection.vue'
import AlarmSoundBindingSection from '@renderer/components/AlarmSoundBindingSection.vue'
import EmailSettingsSection from '@renderer/components/EmailSettingsSection.vue'
import AppModal from '@renderer/components/AppModal.vue'
import ChangePasswordDialog from '@renderer/components/ChangePasswordDialog.vue'
import { useSessionStore } from '@renderer/stores/session'
import { useSamplesStore } from '@renderer/stores/samples'

const { t } = useI18n()
const settings = useSettingsStore()
const uiRefresh = useUiRefreshStore()
/** Trend buffering counters live in the trends store, shared with the trend page. */
const trends = useTrendsStore()
/**
/** 当前登录的账号：设置页「账号」页签要显示它，并提供改密与退出登录（业主 ③）。 */
const session = useSessionStore()

/**
 * 页签（业主 20260921 批：合并紧凑化）。
 *
 * 三个决定，都写在代码旁边免得下次被"优化"回去：
 *   1. 「常规」把原 语言 / 存储 / 视频 / 缓存 四页合成一页 —— 它们都是"装完调一次"
 *      的系统项，各占一页时每一页都大半空白；
 *   2. 「集成」收 邮箱(SMTP) / 地图 / AI —— 三块都是"本机对外接什么服务"；
 *   3. 页签**不持久化**：设置页是一个"进来改一项就走"的地方，记住上次停在哪一页
 *      反而会让下次进来看到一页与预期无关的内容（默认永远落在「常规」）。
 * `tests/settings-tabs.test.ts` 钉着这张表：改页签同样要改那条守卫。
 */
const TABS = [
  { id: 'general', labelKey: 'settingsUi.tabGeneral' },
  { id: 'integration', labelKey: 'settingsUi.tabIntegration' },
  /*
   * GIS 服务库自己的页签（业主 20260921 批：地图卡里不再展示服务库细节，
   * 库挪到这一页；「应用」仍 = 抄进 mapTiles 并打开开关）。
   */
  { id: 'gis', labelKey: 'settingsUi.tabGisServices' },
  { id: 'alarm', labelKey: 'settingsUi.tabAlarm' },
  { id: 'account', labelKey: 'settingsUi.tabAccount' },
  { id: 'about', labelKey: 'settingsUi.tabAbout' }
] as const
type SettingsTab = (typeof TABS)[number]['id']
const activeTab = ref<SettingsTab>('general')

/** 账号页签里的改密对话框（与侧栏账户菜单是同一个组件）。 */
const changePasswordOpen = ref(false)

function signOut(): void {
  void session.logout()
}

interface Draft {
  storageRoot: string
  retentionDays: number
  minFreeGb: number
  healthCheckIntervalMs: number
  offlineFailureThreshold: number
  requestTimeoutMs: number
  preAlarmSeconds: number
  postAlarmSeconds: number
  ringBufferSeconds: number
  /**
   * 开机自动播放相机实时视频。
   *
   * 与上面那些数值型草稿字段一样走「编辑草稿 -> 保存」的流程：勾选框只是草稿，
   * 点击保存才会写进主进程的设置表。
   */
  autoPlayCameraLive: boolean
  /**
   * 在线地图底图（GIS）。
   *
   * 扁平字段容易在 patch/回流两处各写一遍；这里直接拿 shared 层的完整形状，
   * patchFromDraft() 只做一次浅拷贝，字段名不可能漂移。**默认关闭**。
   */
  mapTiles: MapTilesConfig
  /** 命名的 GIS 服务库（业主追加）：与 mapTiles 同走草稿 → 补丁 → 自动保存。 */
  mapServices: MapServiceEntry[]
}

const draft = reactive<Draft>({
  storageRoot: '',
  retentionDays: 30,
  minFreeGb: 10,
  healthCheckIntervalMs: 5000,
  offlineFailureThreshold: 3,
  requestTimeoutMs: 5000,
  preAlarmSeconds: 10,
  postAlarmSeconds: 20,
  ringBufferSeconds: 60,
  autoPlayCameraLive: true,
  mapTiles: defaultMapTilesConfig(),
  mapServices: []
})

const formError = ref('')
const notice = ref('')
const copiedKey = ref('')
const picking = ref(false)
/** Trend panel: '立即落盘' progress and its result. */
const flushingTrends = ref(false)
const trendNotice = ref('')

/** Re-seed the draft whenever the store receives a fresh authoritative copy. */
function seedFromStore(): void {
  const current = settings.settings
  if (!current) return
  draft.storageRoot = current.storageRoot
  draft.retentionDays = current.retentionDays
  draft.minFreeGb = bytesToGb(current.minFreeBytes)
  draft.healthCheckIntervalMs = current.healthCheckIntervalMs
  draft.offlineFailureThreshold = current.offlineFailureThreshold
  draft.requestTimeoutMs = current.requestTimeoutMs
  draft.preAlarmSeconds = current.preAlarmSeconds
  draft.postAlarmSeconds = current.postAlarmSeconds
  draft.ringBufferSeconds = current.ringBufferSeconds
  draft.autoPlayCameraLive = current.autoPlayCameraLive
  draft.mapTiles = { ...current.mapTiles }
  draft.mapServices = current.mapServices.map((service) => ({ ...service }))
}

/** 瓦片缓存下载进度推送的退订函数（卸载时必须释放）。 */
let cacheProgressUnsubscribe: (() => void) | null = null

onMounted(async () => {
  await settings.load()
  seedFromStore()
  await settings.loadDiskUsage()
  // Read-only diagnostics; the trend writer lives in the main process and this
  // panel never configures it, it only reports what it is doing.
  void trends.loadStats()
  // 缓存下载进度由主进程推送（业主 20260921 批）：这里订阅一次，卸载时退订。
  cacheProgressUnsubscribe = window.events.onMapTileCacheProgress((progress) => {
    cacheProgress.value = progress
  })
})

onUnmounted(() => {
  if (autosaveTimer) window.clearTimeout(autosaveTimer)
  autosaveTimer = 0
  cacheProgressUnsubscribe?.()
  cacheProgressUnsubscribe = null
})

watch(() => settings.settings, seedFromStore)

/**
 * 顶栏那颗唯一的刷新（业主 2026-09-19 更正第 4 条）：这一页里那两颗「刷新」
 * （磁盘占用 / 趋势存储）都删掉了，重读这两个诊断读数由它触发。
 */
watch(
  () => uiRefresh.tick,
  () => {
    void settings.loadDiskUsage()
    void trends.loadStats()
  }
)

/**
 * 切到「常规」页签时**重读一次**两个诊断读数。
 *
 * 为什么需要它：那两个数（磁盘占用、趋势落盘计数）会随时间变，而它们原来各有一颗
 * 「刷新」按钮。按钮删掉之后，如果只在挂载时读一次，操作员在这一页上切换页签再回来
 * 会看到一个永远不会变的数字 —— 那比没有这个数更糟。
 */
watch(activeTab, (tab) => {
  if (tab !== 'general') return
  void settings.loadDiskUsage()
  void trends.loadStats()
})

/**
 * 地图页签的全球供应商预置（顺序就是界面上单选的顺序）。
 *
 * 模板与署名来自共享层（`MAP_TILE_PRESETS`）；授权边界正文来自四语言目录 ——
 * 它是给人读的，不能写死在组件里。OSM 排第一且是默认项（业主 20260921 批），
 * 需要自带 key 的预置在单选旁标「需 key」。
 */
const MAP_PRESET_UI = [
  { id: 'osm', labelKey: 'settingsUi.mapPresetOsm', boundaryKey: 'settingsUi.mapBoundaryOsm' },
  { id: 'opentopomap', labelKey: 'settingsUi.mapPresetOpentopomap', boundaryKey: 'settingsUi.mapBoundaryOpentopomap' },
  { id: 'carto', labelKey: 'settingsUi.mapPresetCarto', boundaryKey: 'settingsUi.mapBoundaryCarto' },
  { id: 'esri', labelKey: 'settingsUi.mapPresetEsri', boundaryKey: 'settingsUi.mapBoundaryEsri' },
  { id: 'maptiler', labelKey: 'settingsUi.mapPresetMaptiler', boundaryKey: 'settingsUi.mapBoundaryKeyProvider' },
  { id: 'mapbox', labelKey: 'settingsUi.mapPresetMapbox', boundaryKey: 'settingsUi.mapBoundaryKeyProvider' },
  { id: 'tomtom', labelKey: 'settingsUi.mapPresetTomtom', boundaryKey: 'settingsUi.mapBoundaryKeyProvider' },
  { id: 'stadia', labelKey: 'settingsUi.mapPresetStadia', boundaryKey: 'settingsUi.mapBoundaryKeyProvider' },
  { id: 'tianditu', labelKey: 'settingsUi.mapPresetTianditu', boundaryKey: 'settingsUi.mapBoundaryTianditu' },
  { id: 'custom', labelKey: 'settingsUi.mapPresetCustom', boundaryKey: 'settingsUi.mapBoundaryCustom' }
] as const

/** 「本地缓存地图」单选（业主 20260921 批）：用已下载到存储根的瓦片，离线复用。 */
const MAP_SOURCE_LOCAL = 'local' as const
type MapSourceId = MapTilesConfig['service'] | typeof MAP_SOURCE_LOCAL

/**
 * 瓦片服务单选的当前值：预置/自定义读 `service`，「本地缓存地图」读 `cachePath`。
 * 选预置/自定义会清掉 `cachePath`（来源切回在线）；选本地只翻 `cachePath`，
 * 模板与服务保持当前值 —— 缓存是按服务下载的，也是本地未命中时的在线兜底。
 */
const mapSource = computed<MapSourceId>({
  get: () => (draft.mapTiles.cachePath === 'map-cache' ? 'local' : draft.mapTiles.service),
  set: (id: MapSourceId) => {
    if (id === 'local') {
      draft.mapTiles.cachePath = 'map-cache'
      return
    }
    draft.mapTiles.cachePath = undefined
    applyMapPreset(id)
  }
})

/**
 * 模板输入框的占位例子。**故意不做成消息**：{z} 这类花括号会被 vue-i18n 当成
 * 插值占位符；技术格式在所有语言里本来就是同一个字符串。
 */
const MAP_URL_PLACEHOLDER = 'https://host/{z}/{x}/{y}.png'

/** 把共享层的问题码翻成这一页能显示的一句人话。 */
function mapTilesProblemText(problem: MapTilesProblem): string {
  switch (problem) {
    case 'templateRequired':
      return t('settingsUi.mapErrTemplateRequired')
    case 'templateProtocol':
      return t('settingsUi.mapErrTemplateProtocol')
    case 'templateTokens':
      return t('settingsUi.mapErrTemplateTokens')
    case 'templateTokenUnknown':
      return t('settingsUi.mapErrTemplateTokenUnknown')
    case 'templateInvalid':
      return t('settingsUi.mapErrTemplateInvalid')
    case 'keyRequired':
      return t('settingsUi.mapErrKeyRequired')
    case 'keyInvalid':
      return t('settingsUi.mapErrKeyInvalid')
    case 'attributionRequired':
      return t('settingsUi.mapErrAttributionRequired')
  }
}

/** 点一个预置：把模板与法定署名填进草稿（key 由用户自己填，不覆盖）。 */
function applyMapPreset(id: MapTilesConfig['service']): void {
  draft.mapTiles.service = id
  if (id === 'custom') return
  const preset = MAP_TILE_PRESETS[id]
  draft.mapTiles.urlTemplate = preset.urlTemplate
  draft.mapTiles.attribution = preset.attribution
  // 不同服务商的 key 互不通用（也不该互发）：换预置就把旧的清掉，别留给下一个服务商。
  draft.mapTiles.apiKey = ''
}

// ---------------------------------------------------------------------------
// 瓦片缓存下载（业主 20260921 批：选服务 + 缩放级别范围 + 区域 → 下载到存储根）
// ---------------------------------------------------------------------------
//
// 设置页自己没有地图视野，所以区域是手输经纬度框 + 一颗「填入当前中心」
// （中心 = defaultCenter，没有则时区中心，±0.025° ≈ 2.8km 见方）。
// 进度靠 `onMapTileCacheProgress` 推送（订阅在 onMounted），结果经 IPC 返回。
const cacheMinZoom = ref(3)
const cacheMaxZoom = ref(16)
const cacheBounds = reactive({ minLat: '', minLon: '', maxLat: '', maxLon: '' })
const cacheRunning = ref(false)
const cacheProgress = ref<MapTileCacheProgress | null>(null)
const cacheError = ref('')
const cacheNotice = ref('')

const cacheProcessed = computed(() => {
  const progress = cacheProgress.value
  return progress ? progress.downloaded + progress.skipped + progress.failed : 0
})

/** 「填入当前中心」：优先设置里的 defaultCenter（设备 GIS 坐标自动写入的），其次时区中心。 */
function fillCacheBoundsFromCenter(): void {
  const center = draft.mapTiles.defaultCenter
  const lat = center?.lat ?? detectedMapCenter.value.latitude
  const lon = center?.lon ?? detectedMapCenter.value.longitude
  cacheBounds.minLat = (lat - 0.025).toFixed(4)
  cacheBounds.maxLat = (lat + 0.025).toFixed(4)
  cacheBounds.minLon = (lon - 0.025).toFixed(4)
  cacheBounds.maxLon = (lon + 0.025).toFixed(4)
}

async function startCacheDownload(): Promise<void> {
  if (cacheRunning.value) return
  cacheError.value = ''
  cacheNotice.value = ''
  cacheProgress.value = null

  const template = draft.mapTiles.urlTemplate.trim()
  if (template === '' || !/^https:\/\//i.test(template)) {
    cacheError.value = t('settingsUi.mapCacheNeedTemplate')
    return
  }
  const minZoom = Math.round(cacheMinZoom.value)
  const maxZoom = Math.round(cacheMaxZoom.value)
  if (
    !Number.isInteger(minZoom) || !Number.isInteger(maxZoom) ||
    minZoom < MIN_TILE_ZOOM || maxZoom > MAX_TILE_ZOOM || minZoom > maxZoom
  ) {
    cacheError.value = t('settingsUi.mapCacheBadZoom', { min: MIN_TILE_ZOOM, max: MAX_TILE_ZOOM })
    return
  }
  const bounds = {
    minLat: Number(cacheBounds.minLat),
    minLon: Number(cacheBounds.minLon),
    maxLat: Number(cacheBounds.maxLat),
    maxLon: Number(cacheBounds.maxLon)
  }
  if (
    !Number.isFinite(bounds.minLat) || !Number.isFinite(bounds.minLon) ||
    !Number.isFinite(bounds.maxLat) || !Number.isFinite(bounds.maxLon) ||
    bounds.minLat >= bounds.maxLat || bounds.minLon >= bounds.maxLon ||
    Math.abs(bounds.minLat) > 90 || Math.abs(bounds.maxLat) > 90 ||
    Math.abs(bounds.minLon) > 180 || Math.abs(bounds.maxLon) > 180
  ) {
    cacheError.value = t('settingsUi.mapCacheBadBounds')
    return
  }

  cacheRunning.value = true
  const result = await callApi(() =>
    window.api.mapTiles.cacheTiles({
      service: draft.mapTiles.service,
      urlTemplate: template,
      apiKey: draft.mapTiles.apiKey.trim(),
      attribution: draft.mapTiles.attribution.trim(),
      minZoom,
      maxZoom,
      bounds
    })
  )
  cacheRunning.value = false
  if (!result.success) {
    cacheError.value = resultMessage(result)
    return
  }
  const value = unwrap(result)
  if (!value) return
  cacheNotice.value = t('settingsUi.mapCacheResult', {
    downloaded: value.downloaded,
    skipped: value.skipped,
    failed: value.failed,
    size: formatBytes(value.bytes)
  })
}

// ---------------------------------------------------------------------------
// GIS 服务库（业主追加：设置里「添加 GIS 服务」；20260921 批起在自己的页签）
// ---------------------------------------------------------------------------
//
// 库本身在草稿里（`draft.mapServices`）——添加/编辑/删除都改草稿，走同一条自动保存。
// 编辑器是页内内联表单（不是弹窗）：这一页其它块都是内联展开，服务库不另起交互模式。
const mapServiceEditing = ref(false)
const mapServiceEditor = reactive({
  /** `''` = 新增；否则是更新已有条目的 id。 */
  id: '',
  name: '',
  service: 'custom' as MapTilesConfig['service'],
  urlTemplate: '',
  apiKey: '',
  attribution: ''
})
const mapServiceError = ref('')
/** 「测试瓦片」结果：'none' 未测 / 'ok' 加载成功 / 'fail' 加载失败。 */
const mapServiceTest = ref<'none' | 'ok' | 'fail'>('none')
const mapServiceTesting = ref(false)

function startAddMapService(): void {
  mapServiceEditing.value = true
  mapServiceEditor.id = ''
  mapServiceEditor.name = ''
  mapServiceEditor.service = 'custom'
  mapServiceEditor.urlTemplate = ''
  mapServiceEditor.apiKey = ''
  mapServiceEditor.attribution = ''
  mapServiceError.value = ''
  mapServiceTest.value = 'none'
}

function startEditMapService(id: string): void {
  const entry = draft.mapServices.find((service) => service.id === id)
  if (!entry) return
  mapServiceEditing.value = true
  mapServiceEditor.id = entry.id
  mapServiceEditor.name = entry.name
  mapServiceEditor.service = entry.service
  mapServiceEditor.urlTemplate = entry.urlTemplate
  mapServiceEditor.apiKey = entry.apiKey
  mapServiceEditor.attribution = entry.attribution
  mapServiceError.value = ''
  mapServiceTest.value = 'none'
}

function cancelMapServiceEdit(): void {
  mapServiceEditing.value = false
  mapServiceError.value = ''
  mapServiceTest.value = 'none'
}

/** 编辑器里点预置：填模板与署名、清 Key（与 `applyMapPreset` 同一条 G2 修复纪律）。 */
function applyMapServicePreset(id: MapTilesConfig['service']): void {
  mapServiceEditor.service = id
  applyMapPresetToEditor(id)
}

function applyMapPresetToEditor(id: MapTilesConfig['service']): void {
  if (id === 'custom') return
  const preset = MAP_TILE_PRESETS[id]
  mapServiceEditor.urlTemplate = preset.urlTemplate
  mapServiceEditor.attribution = preset.attribution
  mapServiceEditor.apiKey = ''
}

/** 编辑器当前内容拼成一条临时条目，用共享层判据校验/试瓦片 —— 与主进程同一份规则。 */
function mapServiceEditorEntry(): MapServiceEntry {
  return {
    id: mapServiceEditor.id || 'draft',
    name: mapServiceEditor.name.trim(),
    service: mapServiceEditor.service,
    urlTemplate: mapServiceEditor.urlTemplate.trim(),
    apiKey: mapServiceEditor.apiKey.trim(),
    attribution: mapServiceEditor.attribution.trim()
  }
}

function saveMapService(): void {
  const entry = mapServiceEditorEntry()
  const problem = mapServiceProblem(entry)
  if (problem) {
    mapServiceError.value = mapTilesProblemText(problem)
    return
  }
  if (entry.id === 'draft' && draft.mapServices.length >= MAX_MAP_SERVICES) {
    mapServiceError.value = t('settingsUi.mapServiceTooMany')
    return
  }
  const record: MapServiceEntry = { ...entry, id: entry.id === 'draft' ? newMapServiceId() : entry.id }
  const index = draft.mapServices.findIndex((service) => service.id === record.id)
  if (index >= 0) draft.mapServices[index] = record
  else draft.mapServices.push(record)
  mapServiceEditing.value = false
  mapServiceError.value = ''
}

function deleteMapService(id: string): void {
  const entry = draft.mapServices.find((service) => service.id === id)
  if (!entry) return
  if (!window.confirm(t('settingsUi.mapServiceDeleteConfirm', { name: entry.name }))) return
  draft.mapServices = draft.mapServices.filter((service) => service.id !== id)
}

/** 「应用」：把条目内容抄进当前底图配置并打开开关（服务库→生效只有这一条路）。 */
function applyMapService(id: string): void {
  const entry = draft.mapServices.find((service) => service.id === id)
  if (!entry) return
  draft.mapTiles.service = entry.service
  draft.mapTiles.urlTemplate = entry.urlTemplate
  draft.mapTiles.apiKey = entry.apiKey
  draft.mapTiles.attribution = entry.attribution
  draft.mapTiles.enabled = true
}

/**
 * 「把当前配置保存为服务」：打开编辑器并预填当前表单内容（名称留空让用户起），
 * 保存走 `saveMapService()` 同一条路。
 *
 * 不用 `window.prompt()`：Electron 渲染进程不支持它（静默返回 null），
 * 内联编辑器反正已经是这一页的既有交互。
 */
function saveCurrentAsMapService(): void {
  mapServiceEditing.value = true
  mapServiceEditor.id = ''
  mapServiceEditor.name = ''
  mapServiceEditor.service = draft.mapTiles.service
  mapServiceEditor.urlTemplate = draft.mapTiles.urlTemplate
  mapServiceEditor.apiKey = draft.mapTiles.apiKey
  mapServiceEditor.attribution = draft.mapTiles.attribution
  mapServiceError.value = ''
  mapServiceTest.value = 'none'
}

/**
 * 「测试瓦片」：用编辑器当前内容拼一张 z=3/x=4/y=2 的真实瓦片地址，以 `<img>` 试加载。
 *
 * 渲染层 CSP `img-src` 允许 https:（connect-src 仍 'none'，不会变成数据通道）；
 * 失败只说明"这台机器此刻拿不到这块瓦片"（没外网 / key 错 / 服务拒绝），足够排查配置。
 */
function testMapServiceTile(): void {
  const entry = mapServiceEditorEntry()
  if (entry.urlTemplate === '') {
    mapServiceError.value = t('settingsUi.mapErrTemplateRequired')
    return
  }
  const url = tileUrl({ enabled: false, ...entry }, 3, 4, 2)
  if (url === '') {
    mapServiceError.value = mapTilesProblemText(mapServiceProblem(entry) ?? 'templateInvalid')
    mapServiceTest.value = 'fail'
    return
  }
  mapServiceTesting.value = true
  mapServiceTest.value = 'none'
  mapServiceError.value = ''
  const image = new Image()
  const finish = (ok: boolean): void => {
    mapServiceTesting.value = false
    mapServiceTest.value = ok ? 'ok' : 'fail'
  }
  image.onload = () => finish(true)
  image.onerror = () => finish(false)
  image.src = url
}

// ---------------------------------------------------------------------------
// AI 服务（业主追加：设置里支持「不同 AI 服务」）
// ---------------------------------------------------------------------------
//
// 与 GIS 服务库同一交互（内联表单 + 单选启用），但数据**不走设置表**：配置本体在
// `app_meta`、密钥在 safeStorage，读写都过样本 store 的四条新通道，改完立即生效
// （没有"草稿/自动保存"这一层——服务库的写操作本身就是一次落库）。
const samples = useSamplesStore()

/** 切到「集成」页签时才读服务库（这一页不是人人都进，别让每次进设置都多一次 IPC）。 */
watch(activeTab, (tab) => {
  if (tab === 'integration') void samples.loadAiServices()
})

const aiServiceEditing = ref(false)
const aiServiceEditor = reactive({
  id: '',
  name: '',
  provider: 'custom' as AiServicePresetId,
  endpoint: '',
  model: '',
  /** 留空 = 不改动已存密钥（与样本页同一三态语义）。 */
  apiKey: ''
})
const aiServiceError = ref('')

/** 厂家预置按钮（点选填 endpoint/model；密钥永远手填，不预置）。 */
const AI_PRESET_UI = AI_SERVICE_PRESETS.map((preset) => ({
  id: preset.id,
  labelKey: `settingsUi.aiPreset_${preset.id}`
}))

function startAddAiService(): void {
  aiServiceEditing.value = true
  aiServiceEditor.id = ''
  aiServiceEditor.name = ''
  aiServiceEditor.provider = 'custom'
  aiServiceEditor.endpoint = ''
  aiServiceEditor.model = ''
  aiServiceEditor.apiKey = ''
  aiServiceError.value = ''
}

function startEditAiService(id: string): void {
  const service = samples.aiServices?.services.find((item) => item.id === id)
  if (!service) return
  aiServiceEditing.value = true
  aiServiceEditor.id = service.id
  aiServiceEditor.name = service.name
  aiServiceEditor.provider = service.provider
  aiServiceEditor.endpoint = service.endpoint
  aiServiceEditor.model = service.model
  aiServiceEditor.apiKey = ''
  aiServiceError.value = ''
}

function cancelAiServiceEdit(): void {
  aiServiceEditing.value = false
  aiServiceError.value = ''
}

/** 点厂家预置：只填地址与模型，不碰名称/密钥。 */
function applyAiPreset(id: AiServicePresetId): void {
  const preset = AI_SERVICE_PRESETS.find((item) => item.id === id)
  if (!preset) return
  aiServiceEditor.provider = id
  aiServiceEditor.endpoint = preset.endpoint
  aiServiceEditor.model = preset.model
}

async function saveAiService(): Promise<void> {
  const ok = await samples.saveAiService({
    ...(aiServiceEditor.id === '' ? {} : { id: aiServiceEditor.id }),
    name: aiServiceEditor.name.trim(),
    provider: isAiServicePreset(aiServiceEditor.provider) ? aiServiceEditor.provider : 'custom',
    endpoint: aiServiceEditor.endpoint.trim(),
    model: aiServiceEditor.model.trim(),
    ...(aiServiceEditor.apiKey === '' ? {} : { apiKey: aiServiceEditor.apiKey })
  })
  if (!ok) {
    aiServiceError.value = samples.error || t('settingsUi.aiServiceSaveFailed')
    return
  }
  aiServiceEditing.value = false
  aiServiceError.value = ''
}

async function deleteAiService(id: string): Promise<void> {
  const service = samples.aiServices?.services.find((item) => item.id === id)
  if (!service) return
  if (!window.confirm(t('settingsUi.aiServiceDeleteConfirm', { name: service.name }))) return
  await samples.deleteAiService(id)
}

/** 单选「启用」：选用该服务（radio 的 v-model 直接落 activeId）。 */
async function setActiveAiService(id: string): Promise<void> {
  await samples.setActiveAiService(id)
}

/** 当前启用服务在界面上显示的就绪态（照主进程 `servicesStatus()` 的判断说话）。 */
const aiActiveText = computed(() => {
  const status = samples.aiServices
  if (!status) return t('settingsUi.aiServiceUnknown')
  if (status.ready) return t('settingsUi.aiServiceReady')
  // blockedReason 的四语言文案复用样本页那组（同一域层判据、同一批原因）。
  switch (status.blockedReason) {
    case 'no-endpoint':
      return t('samplesUi.aiBlockedNoEndpoint')
    case 'bad-endpoint':
      return t('samplesUi.aiBlockedBadEndpoint')
    case 'no-model':
      return t('samplesUi.aiBlockedNoModel')
    default:
      return t('samplesUi.aiBlockedDisabled')
  }
})

/** 电脑时区；拿不到时退回 UTC（国际标准时区名，查表落到世界中心）。 */
const detectedTimeZone = computed(() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
})

/** 时区→中心（**手册未说明**，取值在 @shared/domain/map-tiles）。缓存下载的
 * 「填入当前中心」没有 defaultCenter 时用它兜底。 */
const detectedMapCenter = computed(() => timeZoneCenter(detectedTimeZone.value))

function validate(): string {
  if (!draft.storageRoot.trim()) return t('settingsUi.errStorageRoot')
  if (!Number.isInteger(draft.retentionDays) || draft.retentionDays < 1)
    return t('settingsUi.errRetentionDays')
  if (draft.minFreeGb < 0) return t('settingsUi.errMinFree')
  if (!Number.isInteger(draft.healthCheckIntervalMs) || draft.healthCheckIntervalMs < 1000)
    return t('settingsUi.errHealthCheck')
  if (!Number.isInteger(draft.offlineFailureThreshold) || draft.offlineFailureThreshold < 1)
    return t('settingsUi.errOfflineThreshold')
  if (!Number.isInteger(draft.requestTimeoutMs) || draft.requestTimeoutMs < 1000)
    return t('settingsUi.errRequestTimeout')
  if (draft.preAlarmSeconds < 0 || draft.postAlarmSeconds < 0) return t('settingsUi.errAlarmWindows')
  if (!Number.isInteger(draft.ringBufferSeconds) || draft.ringBufferSeconds < 1)
    return t('settingsUi.errRingBuffer')
  if (draft.ringBufferSeconds < draft.preAlarmSeconds + draft.postAlarmSeconds)
    return t('settingsUi.errRingBufferTooShort')
  /*
   * 地图底图的校验用共享层那一份（mapTilesProblem()）：界面、主进程、地图页三处
   * 的规则必须完全相同。这里只把「哪种问题」翻译成四语言文案。
   */
  const mapTiles = patchFromDraft().mapTiles
  const mapProblem = mapTiles ? mapTilesProblem(mapTiles) : null
  if (mapProblem) return mapTilesProblemText(mapProblem)
  /*
   * 数据接入的三条校验（绑定地址 / 两个端口）**跟着那一块搬走了**：
   * 现在在 `AddDeviceDialog.saveIotSettings()` 里，用的还是**共享层**那一套判据
   * （`isBindAddress` / `isPort`，与主进程归一化器同一份）。
   */
  return ''
}

/**
 * 把草稿变成提交给主进程的补丁。保存与"草稿有没有变"两个判断共用它，
 * 免得两处各写一遍字段映射（漏一个字段就会出现"改了没保存"或"没改也在保存"）。
 */
function patchFromDraft(): AppSettingsPatch {
  return {
    storageRoot: draft.storageRoot.trim(),
    retentionDays: draft.retentionDays,
    minFreeBytes: gbToBytes(draft.minFreeGb),
    healthCheckIntervalMs: draft.healthCheckIntervalMs,
    offlineFailureThreshold: draft.offlineFailureThreshold,
    requestTimeoutMs: draft.requestTimeoutMs,
    preAlarmSeconds: draft.preAlarmSeconds,
    postAlarmSeconds: draft.postAlarmSeconds,
    ringBufferSeconds: draft.ringBufferSeconds,
    autoPlayCameraLive: draft.autoPlayCameraLive,
    mapTiles: {
      enabled: draft.mapTiles.enabled,
      service: draft.mapTiles.service,
      urlTemplate: draft.mapTiles.urlTemplate.trim(),
      apiKey: draft.mapTiles.apiKey.trim(),
      attribution: draft.mapTiles.attribution.trim(),
      // 两个新可选字段原样带上（归一化器只认合法值，坏值丢字段不炸整键）。
      ...(draft.mapTiles.cachePath === 'map-cache' ? { cachePath: 'map-cache' as const } : {}),
      ...(draft.mapTiles.defaultCenter
        ? { defaultCenter: { ...draft.mapTiles.defaultCenter } }
        : {})
    },
    mapServices: draft.mapServices.map((service) => ({ ...service }))
  }
}

/**
 * 草稿与**已存值**是否不同。
 *
 * 自动保存的安全阀，也是它敢做成"改了就存"的原因：`seedFromStore()` 把草稿逐字抄自 store，
 * 所以"回填之后"与"保存成功之后"这两个时刻草稿与 store 必然相同 ⇒ 那个 watcher 不会写盘。
 * 用「比较内容」而不是「一个 isSeeding 标志」是因为 watcher 默认在下一个 tick 才跑，
 * 标志在同步赋值结束时早就复位了——那是这类自动保存最经典的一个坑。
 */
function draftDiffersFromStore(): boolean {
  const current = settings.settings
  if (!current) return false
  const patch = patchFromDraft() as Record<string, unknown>
  return Object.keys(patch).some((key) => {
    const stored = (current as unknown as Record<string, unknown>)[key]
    const next = patch[key]
    /**
     * 数组（`mapServices` 服务库）**整体序列化比**：条目是嵌套对象，逐字段展开比较
     * 会被 `patchFromDraft()` 的新引用骗过（每次都"有差异"→ 每 600ms 白写一次库）。
     * 服务库最多 20 条、字段都是短字符串，JSON 比较的代价可以忽略。
     */
    if (Array.isArray(next)) {
      return JSON.stringify(stored) !== JSON.stringify(next)
    }
    if (next !== null && typeof next === 'object') {
      const before = stored as Record<string, unknown> | undefined
      if (!before) return true
      return Object.keys(next as Record<string, unknown>).some(
        (field) => before[field] !== (next as Record<string, unknown>)[field]
      )
    }
    return stored !== next
  })
}

/**
 * 自动保存（业主 2026-09-16：去掉「保存设置」按钮）。
 *
 * 防抖 600ms：一个数字输入框连续敲键时不该每敲一下就写一次库。非法值**不写**，
 * 只把错误留在 `formError` 里——把非法值写进去比不写更糟（下次打开软件就是坏的设置）。
 */
const AUTOSAVE_DEBOUNCE_MS = 600
let autosaveTimer = 0

function scheduleAutosave(): void {
  if (autosaveTimer) window.clearTimeout(autosaveTimer)
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = 0
    void persist()
  }, AUTOSAVE_DEBOUNCE_MS)
}

/**
 * 真的写下去。
 *
 * 不再有"保存成功"的横幅：自动保存每改一个字段就弹一次提示是噪音。**失败必须说话** ——
 * 静默失败的自动保存是最坏的一种：用户以为改好了，重启之后又变回去了。
 */
async function persist(): Promise<void> {
  const validation = validate()
  if (validation) {
    formError.value = validation
    return
  }
  formError.value = ''
  const saved = await settings.update(patchFromDraft())
  if (!saved) {
    formError.value = settings.error || t('settingsUi.saveFailed')
    return
  }
  // 回填一次：让草稿与 store 对齐（例如 storageRoot 被 trim 过），也顺手清掉"有差异"状态。
  seedFromStore()
  await settings.loadDiskUsage()
  /*
   * 这里原来还有一句"保存之后过一会儿再读一次接入读数"（监听状态）。
   * 第 13 批第 1 条把数据接入搬进「添加设备」之后，接入状态由那个对话框自己读
   * （`AddDeviceDialog.reloadIngest()`），这一页没有任何接入读数了。
   */
}

/** 草稿一变就排一次自动保存；回填与保存成功造成的变化会被 `draftDiffersFromStore()` 挡掉。 */
watch(draft, () => {
  if (!draftDiffersFromStore()) return
  const validation = validate()
  if (validation) {
    // 非法值先把话说清楚，但仍然排一次保存：用户把 0 改回 5 之后那一次会被排上。
    formError.value = validation
  }
  scheduleAutosave()
})

async function browse(): Promise<void> {
  picking.value = true
  const picked = await settings.pickStorageDir()
  picking.value = false
  if (picked) {
    draft.storageRoot = picked
    notice.value = t('settingsUi.browsePicked')
  } else if (settings.error) {
    formError.value = settings.error
  }
}

async function copy(text: string, key: string): Promise<void> {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = key
    window.setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = ''
    }, 1600)
  } catch {
    formError.value = t('settingsUi.copyFailed')
  }
}

// ---------------------------------------------------------------------------
// Trend storage panel (Phase 11)
// ---------------------------------------------------------------------------

/**
 * Force a trend batch write.
 *
 * Spec §12.1 buffers feature rows in memory and flushes every 60 s or 1000 rows;
 * closing the app is exactly the moment an operator wants to be sure nothing is
 * still buffered, so the button exists next to the counters it changes.
 */
async function flushTrends(): Promise<void> {
  flushingTrends.value = true
  const written = await trends.flush()
  flushingTrends.value = false
  if (!written) {
    trendNotice.value = ''
    return
  }
  trendNotice.value =
    written.rows > 0
      ? t('settingsUi.trendWrote', { rows: written.rows, files: written.files })
      : t('settingsUi.trendNothing')
}

// ---------------------------------------------------------------------------
// Disk usage derived values
// ---------------------------------------------------------------------------

const disk = computed(() => settings.diskUsage)

const usedBytes = computed(() => {
  const usage = disk.value
  if (!usage) return 0
  return Math.max(0, usage.totalBytes - usage.freeBytes)
})

const usedPercent = computed(() => {
  const usage = disk.value
  if (!usage || usage.totalBytes <= 0) return 0
  return Math.min(100, Math.round((usedBytes.value / usage.totalBytes) * 100))
})

const appPercent = computed(() => {
  const usage = disk.value
  if (!usage || usage.totalBytes <= 0) return 0
  return Math.min(100, Math.round((usage.usedByAppBytes / usage.totalBytes) * 100))
})

const info = computed(() => settings.appInfo)

const versionText = computed(() =>
  info.value?.version ? formatVersion(info.value.version) : t('app.versionFallback')
)

/**
 * Release and build dates, formatted for the active locale.
 *
 * The shared layer's old `formatReleaseDate` wrote a Chinese-style
 * `2026 年 9 月 11 日`, which is wrong in an English, Spanish or Turkish UI; it has
 * been removed. `parsePlainDate` reads `YYYY-MM-DD` as a LOCAL calendar date (a
 * bare `new Date('2026-09-11')` is UTC midnight and shows the previous day west of
 * Greenwich) and `formatDate` renders it through Intl. Both computeds re-evaluate
 * on a language change, so the About panel follows the switch without a reload.
 */
const releaseText = computed(() => {
  const parsed = parsePlainDate(info.value?.releaseDate)
  return parsed ? t('app.releasedOn', { date: formatDate(parsed.getTime()) }) : ''
})

/**
 * Build date is shown only when it differs from the release date.
 *
 * On a normal release they are equal and a second identical date is noise; on a
 * development build the difference is exactly what tells you the binary is not
 * the released artifact.
 */
const buildText = computed(() => {
  const build = info.value?.buildDate ?? ''
  const release = info.value?.releaseDate ?? ''
  if (!build || build === release) return ''
  const parsed = parsePlainDate(build)
  return parsed ? t('app.builtOn', { date: formatDate(parsed.getTime()) }) : ''
})

/** Open a link through the main process, which validates the scheme. */
async function openLink(url: string): Promise<void> {
  const result = await window.api.app.openExternal(url)
  if (!result.success) settings.setError(resultMessage(result))
}

const APP_INFO_ROWS = computed(() => [
  { key: 'version', label: t('app.appVersion'), value: info.value?.version ?? '', copyable: false },
  { key: 'releaseDate', label: t('app.releaseDate'), value: info.value?.releaseDate ?? '', copyable: false },
  { key: 'buildDate', label: t('app.buildDate'), value: info.value?.buildDate ?? '', copyable: false },
  { key: 'electron', label: 'Electron', value: info.value?.electronVersion ?? '', copyable: false },
  { key: 'chrome', label: 'Chrome', value: info.value?.chromeVersion ?? '', copyable: false },
  { key: 'node', label: 'Node', value: info.value?.nodeVersion ?? '', copyable: false },
  {
    key: 'platform',
    label: t('app.operatingSystem'),
    value: info.value ? `${info.value.platform} (${info.value.arch})` : '',
    copyable: false
  },
  { key: 'database', label: t('app.databasePath'), value: info.value?.databasePath ?? '', copyable: true },
  { key: 'storage', label: t('app.storageRootPath'), value: info.value?.storageRoot ?? '', copyable: true }
])


// ---------------------------------------------------------------------------
// 一键恢复默认值（手册 §17.2 第 5227 行）
// ---------------------------------------------------------------------------

/**
 * 将被重置的项，**逐项列出来**给用户确认。
 *
 * 为什么是硬编码的一张清单而不是从主进程读：主进程那边是
 * `SettingsService.RESTORABLE_SETTING_KEYS`（十六个键），而这里要显示的是
 * **人能读懂的每一项名称**。两者的对应关系由 `tests/account-settings.test.ts`
 * 钉住（它断言这张清单的键集合与主进程那份**完全相同**），所以「加了新设置项却
 * 忘了写进确认对话框」会是一条失败的测试，而不是一次静默的重置。
 *
 * `settingsUi.restoreItems` 里的每一条按这个顺序显示。
 */
const RESTORE_ITEMS = computed(() => [
  t('settingsUi.restoreItemStorage'),
  t('settingsUi.restoreItemRetention'),
  t('settingsUi.restoreItemMinFree'),
  t('settingsUi.restoreItemHealthCheck'),
  t('settingsUi.restoreItemOfflineThreshold'),
  t('settingsUi.restoreItemRequestTimeout'),
  t('settingsUi.restoreItemPreAlarm'),
  t('settingsUi.restoreItemPostAlarm'),
  t('settingsUi.restoreItemRingBuffer'),
  t('settingsUi.restoreItemAutoPlay'),
  t('settingsUi.restoreItemMaxStreams'),
  t('settingsUi.restoreItemAlarmLinkage'),
  t('settingsUi.restoreItemAlarmSounds'),
  /** 数据接入（业主 2026-09-19 第 1 条）：恢复默认会把监听**关掉**，所以必须列出来。 */
  t('settingsUi.restoreItemIotIngest'),
  /** 在线地图底图（GIS）：恢复默认会把底图关掉，必须列出来。 */
  t('settingsUi.restoreItemMapTiles'),
  /** GIS 服务库：恢复默认会清空已保存的命名服务，也要列出来。 */
  t('settingsUi.restoreItemMapServices')
])

const restoreOpen = ref(false)
const restoring = ref(false)
const restoreError = ref('')
const restoreNotice = ref('')

function openRestore(): void {
  restoreError.value = ''
  restoreNotice.value = ''
  restoreOpen.value = true
}

/**
 * 恢复默认值。
 *
 * 写入**只**走 `settings.restoreDefaults()`：它不接受参数，被重置的键由主进程
 * 定义。所以这个对话框是「确认一次」而不是「描述一次要写什么」—— 界面无法通过
 * 这个按钮多写一个键。
 */
async function confirmRestore(): Promise<void> {
  restoring.value = true
  restoreError.value = ''
  const ok = await settings.restoreDefaults()
  restoring.value = false
  if (!ok) {
    restoreError.value = settings.error || t('settingsUi.saveFailed')
    return
  }
  // 主进程回的是**读回来**的那一份，所以这里重新播种草稿就够，不必自己填默认值。
  seedFromStore()
  await settings.loadDiskUsage()
  restoreOpen.value = false
  restoreNotice.value = t('settingsUi.restoreNotice')
}
</script>

<template>
  <div class="page">
    <!--
      这一页**没有页头**：外层框架的标题栏已经写了「系统设置」，而「恢复默认值」按产品要求
      挪到了页面最底部（见文件末尾那张卡片）。
    -->

    <p v-if="formError" class="alert alert--danger" role="alert">{{ formError }}</p>
    <p v-else-if="notice" class="alert alert--success" role="status">{{ notice }}</p>
    <p v-if="restoreNotice" class="alert alert--success" role="status">{{ restoreNotice }}</p>
    <p v-if="settings.error && !formError" class="alert alert--danger" role="alert">
      {{ settings.error }}
    </p>

    <EmptyState
      v-if="!settings.loaded && !settings.loading"
      :title="t('settingsUi.loadFailedTitle')"
    >
      <button type="button" class="btn" @click="settings.load()">{{ t('settingsUi.reload') }}</button>
    </EmptyState>

    <template v-else>
      <!--
        页签（业主 20260921 批：6 个）。`role="tablist"` + `role="tab"` + `aria-selected`
        不是装饰：屏幕阅读器要能说出"这是几个页签中的第几个、当前选中哪个"。
        读屏名称用**这一页的标题**（`app.nav.settings`，与路由 meta 同一个键）。
      -->
      <nav class="settings-tabs" role="tablist" :aria-label="t('app.nav.settings')">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          type="button"
          role="tab"
          class="settings-tab"
          :class="{ 'settings-tab--active': activeTab === tab.id }"
          :aria-selected="activeTab === tab.id"
          :data-tab="tab.id"
          @click="activeTab = tab.id"
        >
          {{ t(tab.labelKey) }}
        </button>
      </nav>

      <!--
        常规（业主 20260921 批）：原 语言 / 存储 / 视频 / 缓存 四页合并成一页，
        紧凑双列小卡（每张 = 标题 + 控件，gap 8–12px），删掉各块原有的大留白。
      -->
      <section v-if="activeTab === 'general'" class="card settings-panel" role="tabpanel" data-tab-panel="general">
        <div class="mini-grid">
          <!-- 语言：唯一一条改了立刻生效、而且不需要保存的设置 -->
          <div class="mini-card" data-mini-card="language">
            <span class="mini-card__title">{{ t('settingsUi.tabLanguage') }}</span>
            <div class="settings-language">
              <LanguageSelect />
            </div>
          </div>

          <!-- 存储：位置 / 保留 / 最小剩余 + 磁盘占用读数 -->
          <div class="mini-card" data-mini-card="storage">
            <span class="mini-card__title">{{ t('settingsUi.tabStorage') }}</span>
            <div class="field">
              <span class="field-label">{{ t('settingsUi.storagePath') }}</span>
              <div class="path-row">
                <input v-model="draft.storageRoot" class="input mono" type="text" spellcheck="false" />
                <button type="button" class="btn" :disabled="picking" @click="browse">
                  {{ picking ? t('settingsUi.picking') : t('settingsUi.browse') }}
                </button>
              </div>
            </div>
            <div class="form-grid settings-grid">
              <label class="field">
                <span class="field-label">{{ t('settingsUi.retentionDays') }}</span>
                <input v-model.number="draft.retentionDays" class="input" type="number" min="1" />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.minFreeGb') }}</span>
                <input v-model.number="draft.minFreeGb" class="input" type="number" min="0" step="0.5" />
              </label>
            </div>
            <div class="mini-card__sub">
              <span class="mini-card__subtitle">{{ t('settingsUi.diskSection') }}</span>
              <p v-if="disk?.belowSafetyFloor" class="alert alert--danger" role="alert">
                {{ t('settingsUi.diskBelowFloor') }}
              </p>
              <div v-if="!disk" class="muted">{{ t('settingsUi.diskUnavailable') }}</div>
              <template v-else>
                <div class="bar" role="img" :aria-label="t('settingsUi.diskBarLabel', { percent: usedPercent })">
                  <div
                    class="bar__fill"
                    :class="{ 'bar__fill--danger': disk.belowSafetyFloor }"
                    :style="{ width: `${usedPercent}%` }"
                  ></div>
                </div>
                <dl class="kv disk-kv">
                  <div class="kv__item">
                    <dt class="kv__label">{{ t('settingsUi.diskUsedOfTotal') }}</dt>
                    <dd class="kv__value">
                      {{
                        t('settingsUi.diskUsedValue', {
                          used: formatBytes(usedBytes),
                          total: formatBytes(disk.totalBytes),
                          percent: usedPercent
                        })
                      }}
                    </dd>
                  </div>
                  <div class="kv__item">
                    <dt class="kv__label">{{ t('settingsUi.diskFree') }}</dt>
                    <dd class="kv__value">
                      {{ t('settingsUi.diskFreeValue', { bytes: formatBytes(disk.freeBytes), gb: formatGb(disk.freeBytes) }) }}
                    </dd>
                  </div>
                  <div class="kv__item">
                    <dt class="kv__label">{{ t('settingsUi.diskAppUsage') }}</dt>
                    <dd class="kv__value">
                      {{ t('settingsUi.diskAppUsageValue', { bytes: formatBytes(disk.usedByAppBytes), percent: appPercent }) }}
                    </dd>
                  </div>
                </dl>
              </template>
            </div>
          </div>

          <!-- 视频：开机自动起播 -->
          <div class="mini-card" data-mini-card="video">
            <span class="mini-card__title">{{ t('settingsUi.tabVideo') }}</span>
            <div class="field">
              <span class="field-label">{{ t('settingsUi.liveSection') }}</span>
              <!--
                勾选框只是草稿，自动保存（600ms 防抖）之后才会写进主进程。
                文案说明它**只在相机确实在工作时**才会起播，也说明手动停止优先——
                否则操作员会以为关掉它才是唯一能让它不自动播的办法。
              -->
              <label class="toggle">
                <input v-model="draft.autoPlayCameraLive" type="checkbox" />
                <span>
                  {{
                    draft.autoPlayCameraLive
                      ? t('settingsUi.autoPlayOn')
                      : t('settingsUi.autoPlayOff')
                  }}
                </span>
              </label>
            </div>
          </div>

          <!--
            缓存：设备探测与缓冲（六个数）+ 趋势存储。
            合成一组不是排版偏好：这六个数服务的是同一条实时链路 —— 探测决定
            "多久问一次设备、几次不通算离线、一次请求等多久"，缓冲决定"告警前后各留
            多久、环形缓冲开多大"（缓冲必须不小于 告警前 + 告警后，校验在 `validate()`）。
          -->
          <div class="mini-card" data-mini-card="cache">
            <span class="mini-card__title">{{ t('settingsUi.cacheCardTitle') }}</span>
            <div class="form-grid">
              <label class="field">
                <span class="field-label">{{ t('settingsUi.healthCheckMs') }}</span>
                <input
                  v-model.number="draft.healthCheckIntervalMs"
                  class="input"
                  type="number"
                  min="1000"
                  step="500"
                />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.offlineThreshold') }}</span>
                <input
                  v-model.number="draft.offlineFailureThreshold"
                  class="input"
                  type="number"
                  min="1"
                />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.requestTimeoutMs') }}</span>
                <input
                  v-model.number="draft.requestTimeoutMs"
                  class="input"
                  type="number"
                  min="1000"
                  step="500"
                />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.preAlarmSeconds') }}</span>
                <input v-model.number="draft.preAlarmSeconds" class="input" type="number" min="0" />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.postAlarmSeconds') }}</span>
                <input v-model.number="draft.postAlarmSeconds" class="input" type="number" min="0" />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.ringBufferSeconds') }}</span>
                <input v-model.number="draft.ringBufferSeconds" class="input" type="number" min="1" />
              </label>
            </div>
            <div class="mini-card__sub">
              <div class="mini-card__subtitle-row">
                <span class="mini-card__subtitle">{{ t('settingsUi.trendSection') }}</span>
                <!-- 「立即落盘」不是刷新，是让主进程把缓冲写进库，所以留在这一页。 -->
                <button
                  type="button"
                  class="btn btn--sm"
                  :disabled="flushingTrends"
                  @click="flushTrends"
                >
                  {{ flushingTrends ? t('settingsUi.trendFlushing') : t('settingsUi.trendFlushNow') }}
                </button>
              </div>
              <p v-if="trends.error && !trendNotice" class="alert alert--danger" role="alert">
                {{ trends.error }}
              </p>
              <p v-else-if="trendNotice" class="alert alert--success" role="status">{{ trendNotice }}</p>
              <div v-if="!trends.stats" class="muted">{{ t('settingsUi.trendUnavailable') }}</div>
              <dl v-else class="kv">
                <div class="kv__item">
                  <dt class="kv__label">{{ t('settingsUi.trendBuffered') }}</dt>
                  <dd class="kv__value">{{ t('settingsUi.rows', { count: trends.stats.bufferedRows }) }}</dd>
                </div>
                <div class="kv__item">
                  <dt class="kv__label">{{ t('settingsUi.trendFilesWritten') }}</dt>
                  <dd class="kv__value">{{ t('settingsUi.files', { count: trends.stats.filesWritten }) }}</dd>
                </div>
                <div class="kv__item">
                  <dt class="kv__label">{{ t('settingsUi.trendRowsWritten') }}</dt>
                  <dd class="kv__value">{{ t('settingsUi.rows', { count: trends.stats.rowsWritten }) }}</dd>
                </div>
                <div class="kv__item">
                  <dt class="kv__label">{{ t('settingsUi.trendLastFlush') }}</dt>
                  <dd class="kv__value">
                    {{ trends.stats.lastFlushAt ? formatDateTime(trends.stats.lastFlushAt) : t('settingsUi.trendNeverFlushed') }}
                  </dd>
                </div>
                <div class="kv__item">
                  <dt class="kv__label">{{ t('settingsUi.trendLastError') }}</dt>
                  <dd class="kv__value" :class="{ 'text-danger': !!trends.stats.lastError }">
                    {{ trends.stats.lastError || t('common.none') }}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      </section>

      <!--
        集成（业主 20260921 批）：邮箱(SMTP) / 地图 / AI 三张卡同一页。
        三块都是"本机对外接什么服务"，合成一页之后不必在多个页签之间来回跳。
      -->
      <template v-if="activeTab === 'integration'">
        <!-- 邮箱卡：完整 SMTP 配置（服务器/端口/SSL/账号/密码/发件人/测试发送）。
             组件自带紧凑表单与「发送测试邮件」，版式随组件走；数据仍只发 alarmLinkage 一个键。 -->
        <EmailSettingsSection />

        <!--
          地图卡：瓦片服务选择（预置单选，OSM 默认排第一；自定义 API；本地缓存地图）
          + 缓存下载（缩放级别范围 + 经纬度区域 → 下载到存储根 map-cache/）。
          GIS 服务库细节与中心点参数**不在这一页**（服务库在「GIS 服务」页签；
          中心点由设备 GIS 坐标自动写入）。
        -->
        <section class="card settings-panel" role="tabpanel" data-tab-panel="map" data-map-card>
          <div class="settings-group">
            <span class="settings-group__title">{{ t('settingsUi.mapGroupService') }}</span>
            <label class="toggle">
              <input
                v-model="draft.mapTiles.enabled"
                type="checkbox"
                data-settings-map-enabled
              />
              <span>{{ t('settingsUi.mapEnable') }}</span>
            </label>
            <p class="muted settings-hint">{{ t('settingsUi.mapEnableHint') }}</p>
            <span class="field-label">{{ t('settingsUi.mapSourceLabel') }}</span>
            <!--
              瓦片服务单选（业主 20260921 批）：预置服务 + 自定义 API + 本地缓存地图。
              预置注明「默认」（OSM）与「需 key」（商业服务）；选中即写草稿，走自动保存。
            -->
            <div class="map-source-list" data-settings-map-sources>
              <label
                v-for="preset in MAP_PRESET_UI"
                :key="preset.id"
                class="map-source"
                :class="{ 'map-source--active': mapSource === preset.id }"
                :data-map-source="preset.id"
              >
                <input
                  v-model="mapSource"
                  type="radio"
                  name="map-source"
                  class="map-source__radio"
                  :value="preset.id"
                  :data-map-source-radio="preset.id"
                />
                <span class="map-source__name">{{ t(preset.labelKey) }}</span>
                <span v-if="preset.id === 'osm'" class="badge badge--success" data-map-source-default>
                  {{ t('settingsUi.mapDefaultBadge') }}
                </span>
                <span
                  v-if="preset.id !== 'custom' && MAP_TILE_PRESETS[preset.id].keyRequired"
                  class="badge"
                  data-map-source-key-required
                >
                  {{ t('settingsUi.mapKeyRequired') }}
                </span>
              </label>
              <label
                class="map-source"
                :class="{ 'map-source--active': mapSource === 'local' }"
                data-map-source="local"
              >
                <input
                  v-model="mapSource"
                  type="radio"
                  name="map-source"
                  class="map-source__radio"
                  :value="'local'"
                  data-map-source-radio="local"
                />
                <span class="map-source__name">{{ t('settingsUi.mapSourceLocal') }}</span>
              </label>
            </div>
            <ul class="map-licences" data-settings-map-boundaries>
              <li v-for="preset in MAP_PRESET_UI" :key="preset.id" :data-map-boundary="preset.id">
                <strong>{{ t(preset.labelKey) }}</strong>：{{ t(preset.boundaryKey, { service: t(preset.labelKey) }) }}
              </li>
            </ul>
          </div>

          <!-- 自定义 API：只有选中「自定义 XYZ」才展开的模板/key/署名输入。 -->
          <div v-if="mapSource === 'custom'" class="settings-group">
            <span class="settings-group__title">{{ t('settingsUi.mapGroupTemplate') }}</span>
            <div class="form-grid settings-map-form">
              <label class="field settings-map-form__wide">
                <span class="field-label">{{ t('settingsUi.mapUrlTemplate') }}</span>
                <input
                  v-model="draft.mapTiles.urlTemplate"
                  class="input mono"
                  type="text"
                  spellcheck="false"
                  :placeholder="MAP_URL_PLACEHOLDER"
                  data-settings-map-url
                />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.mapKey') }}</span>
                <input
                  v-model="draft.mapTiles.apiKey"
                  class="input mono"
                  type="text"
                  spellcheck="false"
                  data-settings-map-key
                />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.mapAttribution') }}</span>
                <input
                  v-model="draft.mapTiles.attribution"
                  class="input"
                  type="text"
                  data-settings-map-attribution
                />
              </label>
            </div>
            <p class="muted settings-hint">{{ t('settingsUi.mapUrlHint') }}</p>
            <p class="muted settings-hint">{{ t('settingsUi.mapKeyHint') }}</p>
            <p class="muted settings-hint">{{ t('settingsUi.mapAttributionHint') }}</p>
          </div>

          <!-- 本地缓存地图：使用已下载的缓存；没下载过就先跑下面的「缓存下载」。 -->
          <p v-if="mapSource === 'local'" class="muted settings-hint" data-map-local-hint>
            {{ t('settingsUi.mapSourceLocalHint') }}
          </p>

          <!--
            缓存下载（业主 20260921 批）：缩放级别范围 + 经纬度区域 → 主进程下载到
            存储根 `map-cache/<service>/z/x/y.png`。进度经 `map:cache-progress` 推送，
            断点续下（已存在的瓦片跳过）。
          -->
          <div class="settings-group" data-map-cache-group>
            <span class="settings-group__title">{{ t('settingsUi.mapCacheGroup') }}</span>
            <div class="form-grid cache-form">
              <label class="field">
                <span class="field-label">{{ t('settingsUi.mapCacheZoomMin') }}</span>
                <input
                  v-model.number="cacheMinZoom"
                  class="input"
                  type="number"
                  :min="MIN_TILE_ZOOM"
                  :max="MAX_TILE_ZOOM"
                  data-map-cache-min-zoom
                />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.mapCacheZoomMax') }}</span>
                <input
                  v-model.number="cacheMaxZoom"
                  class="input"
                  type="number"
                  :min="MIN_TILE_ZOOM"
                  :max="MAX_TILE_ZOOM"
                  data-map-cache-max-zoom
                />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.mapCacheSouth') }}</span>
                <input v-model="cacheBounds.minLat" class="input" type="number" step="0.0001" data-map-cache-min-lat />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.mapCacheWest') }}</span>
                <input v-model="cacheBounds.minLon" class="input" type="number" step="0.0001" data-map-cache-min-lon />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.mapCacheNorth') }}</span>
                <input v-model="cacheBounds.maxLat" class="input" type="number" step="0.0001" data-map-cache-max-lat />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.mapCacheEast') }}</span>
                <input v-model="cacheBounds.maxLon" class="input" type="number" step="0.0001" data-map-cache-max-lon />
              </label>
            </div>
            <div class="btn-row">
              <button type="button" class="btn btn--sm" data-map-cache-fill-center @click="fillCacheBoundsFromCenter">
                {{ t('settingsUi.mapCacheUseCenter') }}
              </button>
              <button
                type="button"
                class="btn btn--sm btn--primary"
                :disabled="cacheRunning"
                data-map-cache-start
                @click="startCacheDownload"
              >
                {{ cacheRunning ? t('settingsUi.mapCacheRunning') : t('settingsUi.mapCacheStart') }}
              </button>
            </div>
            <p v-if="cacheError" class="form-error" role="alert" data-map-cache-error>{{ cacheError }}</p>
            <p v-else-if="cacheNotice" class="alert alert--success" role="status" data-map-cache-notice>{{ cacheNotice }}</p>
            <div v-if="cacheProgress" class="cache-progress" data-map-cache-progress>
              <div class="cache-progress__bar">
                <div
                  class="cache-progress__fill"
                  :style="{ width: `${cacheProgress.total > 0 ? Math.round((cacheProcessed / cacheProgress.total) * 100) : 0}%` }"
                ></div>
              </div>
              <span class="muted settings-hint">
                {{
                  t('settingsUi.mapCacheProgressText', {
                    done: cacheProcessed,
                    total: cacheProgress.total,
                    failed: cacheProgress.failed
                  })
                }}
              </span>
            </div>
          </div>
        </section>

        <!--
          AI 卡：厂家预置按钮 + 命名服务列表（单选启用）+ 内联添加/编辑。
          密钥输入框留空 = 不改动已存密钥；只显示"已保存/未保存"，永不回显。
        -->
        <section class="card settings-panel" role="tabpanel" data-tab-panel="ai">
          <div class="settings-group">
            <span class="settings-group__title" data-ai-service-group>{{ t('settingsUi.aiServiceGroup') }}</span>
            <p class="muted settings-hint">{{ t('settingsUi.aiServiceHint') }}</p>
            <p class="muted settings-hint" data-ai-active-status>
              {{ aiActiveText }}
            </p>

            <ul v-if="samples.aiServices && samples.aiServices.services.length > 0" class="map-service-list" data-ai-services>
              <li v-for="service in samples.aiServices.services" :key="service.id" class="map-service-row">
                <label class="ai-service-row__active">
                  <input
                    type="radio"
                    name="active-ai-service"
                    :checked="samples.aiServices?.activeId === service.id"
                    :data-ai-service-active="service.id"
                    @change="setActiveAiService(service.id)"
                  />
                  <span class="map-service-row__name">{{ service.name }}</span>
                </label>
                <span class="map-service-row__template mono">{{ service.endpoint }}</span>
                <span class="muted">{{ service.apiKeyStored ? t('settingsUi.aiServiceKeyStored') : t('settingsUi.aiServiceKeyNone') }}</span>
                <span class="btn-row">
                  <button
                    type="button"
                    class="btn btn--sm"
                    data-ai-service-edit
                    @click="startEditAiService(service.id)"
                  >
                    {{ t('settingsUi.mapServiceEdit') }}
                  </button>
                  <button
                    type="button"
                    class="btn btn--sm btn--danger"
                    data-ai-service-delete
                    @click="deleteAiService(service.id)"
                  >
                    {{ t('settingsUi.mapServiceDelete') }}
                  </button>
                </span>
              </li>
            </ul>
            <p v-else class="muted settings-hint">{{ t('settingsUi.aiServiceEmpty') }}</p>

            <div class="btn-row">
              <button
                type="button"
                class="btn btn--sm"
                data-ai-service-add
                @click="startAddAiService()"
              >
                {{ t('settingsUi.aiServiceAdd') }}
              </button>
            </div>

            <div v-if="aiServiceEditing" class="map-service-editor" data-ai-service-editor>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.aiServiceName') }}</span>
                <input v-model="aiServiceEditor.name" class="input" type="text" data-ai-service-name />
              </label>
              <span class="field-label">{{ t('settingsUi.aiPresetLabel') }}</span>
              <div class="map-presets">
                <button
                  v-for="preset in AI_PRESET_UI"
                  :key="preset.id"
                  type="button"
                  class="btn"
                  :class="{ 'btn--primary': aiServiceEditor.provider === preset.id }"
                  :data-ai-preset="preset.id"
                  @click="applyAiPreset(preset.id)"
                >
                  {{ t(preset.labelKey) }}
                </button>
              </div>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.aiServiceEndpoint') }}</span>
                <input
                  v-model="aiServiceEditor.endpoint"
                  class="input mono"
                  type="text"
                  spellcheck="false"
                  placeholder="https://host/v1/chat/completions"
                  data-ai-service-endpoint
                />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.aiServiceModel') }}</span>
                <input v-model="aiServiceEditor.model" class="input mono" type="text" data-ai-service-model />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settingsUi.aiServiceKey') }}</span>
                <input
                  v-model="aiServiceEditor.apiKey"
                  class="input mono"
                  type="password"
                  spellcheck="false"
                  :placeholder="t('settingsUi.aiServiceKeyPlaceholder')"
                  data-ai-service-key
                />
              </label>
              <p v-if="aiServiceError" class="form-error" data-ai-service-error role="alert">
                {{ aiServiceError }}
              </p>
              <div class="btn-row">
                <button type="button" class="btn btn--sm btn--primary" data-ai-service-save @click="saveAiService()">
                  {{ t('settingsUi.mapServiceSave') }}
                </button>
                <button type="button" class="btn btn--sm" data-ai-service-cancel @click="cancelAiServiceEdit()">
                  {{ t('settingsUi.mapServiceCancel') }}
                </button>
              </div>
            </div>
          </div>
        </section>
      </template>

      <!--
        GIS 服务库（业主追加：设置里「添加 GIS 服务」；20260921 批起在自己的页签）。
        命名保存多份服务、一键应用；「应用」= 抄进「集成 → 地图」的当前配置并打开开关。
      -->
      <section v-if="activeTab === 'gis'" class="card settings-panel" role="tabpanel" data-tab-panel="gis">
        <div class="settings-group">
          <span class="settings-group__title" data-map-service-group>{{ t('settingsUi.mapServiceGroup') }}</span>
          <p class="muted settings-hint">{{ t('settingsUi.mapServiceHint') }}</p>

          <ul v-if="draft.mapServices.length > 0" class="map-service-list" data-map-services>
            <li v-for="service in draft.mapServices" :key="service.id" class="map-service-row">
              <span class="map-service-row__name">{{ service.name }}</span>
              <span class="map-service-row__template mono">{{ service.urlTemplate }}</span>
              <span class="btn-row">
                <button
                  type="button"
                  class="btn btn--sm"
                  data-map-service-apply
                  @click="applyMapService(service.id)"
                >
                  {{ t('settingsUi.mapServiceApply') }}
                </button>
                <button
                  type="button"
                  class="btn btn--sm"
                  data-map-service-edit
                  @click="startEditMapService(service.id)"
                >
                  {{ t('settingsUi.mapServiceEdit') }}
                </button>
                <button
                  type="button"
                  class="btn btn--sm btn--danger"
                  data-map-service-delete
                  @click="deleteMapService(service.id)"
                >
                  {{ t('settingsUi.mapServiceDelete') }}
                </button>
              </span>
            </li>
          </ul>
          <p v-else class="muted settings-hint">{{ t('settingsUi.mapServiceEmpty') }}</p>

          <div class="btn-row">
            <button
              type="button"
              class="btn btn--sm"
              data-map-service-add
              @click="startAddMapService()"
            >
              {{ t('settingsUi.mapServiceAdd') }}
            </button>
            <button
              type="button"
              class="btn btn--sm"
              data-map-service-save-current
              @click="saveCurrentAsMapService()"
            >
              {{ t('settingsUi.mapServiceSaveCurrent') }}
            </button>
          </div>

          <div v-if="mapServiceEditing" class="map-service-editor" data-map-service-editor>
            <label class="field">
              <span class="field-label">{{ t('settingsUi.mapServiceName') }}</span>
              <input v-model="mapServiceEditor.name" class="input" type="text" data-map-service-name />
            </label>
            <span class="field-label">{{ t('settingsUi.mapPresetsLabel') }}</span>
            <div class="map-presets">
              <button
                v-for="preset in MAP_PRESET_UI"
                :key="preset.id"
                type="button"
                class="btn"
                :class="{ 'btn--primary': mapServiceEditor.service === preset.id }"
                :data-map-service-preset="preset.id"
                @click="applyMapServicePreset(preset.id)"
              >
                {{ t(preset.labelKey) }}
              </button>
            </div>
            <label class="field">
              <span class="field-label">{{ t('settingsUi.mapUrlTemplate') }}</span>
              <input
                v-model="mapServiceEditor.urlTemplate"
                class="input mono"
                type="text"
                spellcheck="false"
                :placeholder="MAP_URL_PLACEHOLDER"
                data-map-service-url
              />
            </label>
            <label class="field">
              <span class="field-label">{{ t('settingsUi.mapKey') }}</span>
              <input
                v-model="mapServiceEditor.apiKey"
                class="input mono"
                type="text"
                spellcheck="false"
                data-map-service-key
              />
            </label>
            <label class="field">
              <span class="field-label">{{ t('settingsUi.mapAttribution') }}</span>
              <input v-model="mapServiceEditor.attribution" class="input" type="text" data-map-service-attribution />
            </label>
            <p v-if="mapServiceError" class="form-error" data-map-service-error role="alert">
              {{ mapServiceError }}
            </p>
            <p
              v-else-if="mapServiceTest === 'ok'"
              class="settings-hint map-service-test--ok"
              data-map-service-test-ok
            >
              {{ t('settingsUi.mapServiceTestOk') }}
            </p>
            <p
              v-else-if="mapServiceTest === 'fail'"
              class="form-error"
              data-map-service-test-fail
              role="alert"
            >
              {{ t('settingsUi.mapServiceTestFail') }}
            </p>
            <div class="btn-row">
              <button
                type="button"
                class="btn btn--sm"
                :disabled="mapServiceTesting"
                data-map-service-test
                @click="testMapServiceTile()"
              >
                {{ mapServiceTesting ? t('settingsUi.mapServiceTesting') : t('settingsUi.mapServiceTest') }}
              </button>
              <button type="button" class="btn btn--sm btn--primary" data-map-service-save @click="saveMapService()">
                {{ t('settingsUi.mapServiceSave') }}
              </button>
              <button type="button" class="btn btn--sm" data-map-service-cancel @click="cancelMapServiceEdit()">
                {{ t('settingsUi.mapServiceCancel') }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <!--
        告警联动（录像 / 弹窗 / 提示 / 邮件）。

        两块各自独立组件：联动配置（标题行带总开关 + 五个动作小卡）与告警声音
        （两个绑定 + 声音库）。它们保存时各发一个键（`alarmLinkage` / `alarmSounds`），
        互不覆盖。
      -->
      <template v-if="activeTab === 'alarm'">
        <LinkageSettingsSection />
        <AlarmSoundBindingSection />
      </template>

      <!--
        账号管理（手册 §17.1）。

        它落在设置页里，因为手册第 5173–5174 行把它列在同一个工具菜单下
        （Tool -> Account Management），而这一页就是那个菜单在软件里的落点。
      -->
      <!--
        账号页签（业主 ③：「账号页签承接退出登录」）。

        上：账号管理（手册 §17.1：Tool -> Account Management，本页就是那个菜单的落点）。
        下：**当前会话** —— 谁在登录、改密码、退出登录。这两个动作原来只在侧栏底部那个
        账户菜单里；搬进来之后「账号」这一页就是账号相关动作的**唯一**去处。
        改密对话框与侧栏那个是**同一个组件**（`ChangePasswordDialog`），密码校验只有一处。
      -->
      <template v-if="activeTab === 'account'">
        <AccountManagementSection />

        <section class="card settings-panel" role="tabpanel">
          <div class="settings-group">
            <span class="settings-group__title">{{ t('settingsUi.accountSessionGroup') }}</span>
            <dl class="kv">
              <div class="kv__item">
                <dt class="kv__label">{{ t('authUi.signedInAs') }}</dt>
                <dd class="kv__value">
                  {{ session.displayName }} ·
                  {{ t(`domain.userRole.${session.session?.user.role ?? 'operator'}`) }}
                </dd>
              </div>
            </dl>
            <div class="btn-row">
              <button
                type="button"
                class="btn btn--sm"
                data-action="change-password"
                @click="changePasswordOpen = true"
              >
                {{ t('authUi.changeTitle') }}
              </button>
              <!-- 退出登录用危险色：它是这一页唯一的"会把你踢出去"的动作。 -->
              <button
                type="button"
                class="btn btn--sm btn--danger"
                data-action="sign-out"
                @click="signOut"
              >
                {{ t('authUi.signOut') }}
              </button>
            </div>
          </div>
        </section>
      </template>

      <ChangePasswordDialog v-model="changePasswordOpen" />

      <section v-if="activeTab === 'about'" class="card settings-panel" role="tabpanel">
        <!--
          关于页签：这一张卡片**没有标题**（页签已经写着「关于与维护」了）。
          Brand block. The logo fills the card width rather than sitting at its
          intrinsic 224 px: the wordmark is the recognisable part and reads better
          larger, and `object-fit: contain` keeps the aspect ratio honest.
        -->
        <div class="about-brand">
          <img class="about-brand__logo" :src="logoUrl" alt="HAIS" />
          <div class="about-brand__meta">
            <div class="about-brand__name">HAIS</div>
            <div class="about-brand__version">
              {{ versionText }}
              <template v-if="releaseText">
                <span class="about-brand__sep">·</span>
                <span>{{ releaseText }}</span>
              </template>
            </div>
            <div v-if="buildText" class="about-brand__build">{{ buildText }}</div>
          </div>
        </div>

        <!-- Contact: same reasoning as the sidebar — routed through the main
             process because the renderer's CSP forbids external navigation. -->
        <div class="about-contact">
          <button type="button" class="btn btn--sm" @click="openLink(RELEASE.homepage)">
            www.hertzinno.com
          </button>
          <button
            type="button"
            class="btn btn--sm"
            @click="openLink(`mailto:${RELEASE.supportEmail}`)"
          >
            {{ RELEASE.supportEmail }}
          </button>
        </div>

        <dl class="kv">
          <div v-for="row in APP_INFO_ROWS" :key="row.key" class="kv__item">
            <dt class="kv__label">{{ row.label }}</dt>
            <dd class="kv__value">
              <span class="mono">{{ row.value || '—' }}</span>
              <button
                v-if="row.copyable && row.value"
                type="button"
                class="btn btn--sm btn--ghost copy-btn"
                @click="copy(row.value, row.key)"
              >
                {{ copiedKey === row.key ? t('app.copiedPath') : t('app.copyPath') }}
              </button>
            </dd>
          </div>
        </dl>
      </section>

      <!--
        维护组（「恢复默认值」）落在**关于页签**里（业主 ③ 把这一页叫「关于与维护」）。

        它原来在整页最底部（业主 2026-09-16：「应该放在最底部，避免影响排版」）。
        拆页签之后"最底部"的语义变成"关于这一页的最后"：它仍然是**读完整页之后**才做的决定，
        而不再与语言/存储这些**编辑项**混在一条长列里。
        确认对话框仍然逐项列出 16 项范围（见下面 `AppModal`），这一条没有变。
      -->
      <section v-if="activeTab === 'about'" class="card settings-panel" role="tabpanel">
        <div class="danger-action">
          <!--
            这里**故意不写那句"会重置哪些、不会动哪些"的说明**：确认对话框已经逐项列出 16 项
            范围、并明确写了哪些东西不会被动（见下面 `AppModal`）。同一件事写两遍，改一处就会
            不一致——而这一页刚刚才因为"每张卡片都写名字"被要求去掉重复。
          -->
          <span class="danger-action__title">{{ t('settingsUi.restoreDefaults') }}</span>
          <button
            type="button"
            class="btn"
            data-action="restore-defaults"
            :disabled="settings.loading || settings.saving"
            @click="openRestore"
          >
            {{ t('settingsUi.restoreDefaults') }}
          </button>
        </div>
      </section>
    </template>

    <!--
      一键恢复默认值的确认对话框（手册 §17.2 的 Default Value）。

      它**必须**存在，而且必须逐项列出范围：这个按钮会覆盖整页系统设置，
      而「范围只包括系统设置项」这件事只有写在用户看得见的地方才算数。
      对话框还显式说明哪些东西**不会**被动（设备列表、通道、录像/录音文件、
      告警记录、账号），因为那才是用户真正担心的问题。
    -->
    <AppModal v-model="restoreOpen" :title="t('settingsUi.restoreTitle')" width="560px">
      <p>{{ t('settingsUi.restoreIntro') }}</p>
      <ul class="restore-list" data-restore-items>
        <li v-for="item in RESTORE_ITEMS" :key="item">{{ item }}</li>
      </ul>
      <p class="alert alert--warning" role="note">{{ t('settingsUi.restoreWarnStorage') }}</p>
      <p>{{ t('settingsUi.restoreKeeps') }}</p>
      <p v-if="restoreError" class="alert alert--danger" role="alert">{{ restoreError }}</p>

      <template #footer>
        <button type="button" class="btn" :disabled="restoring" @click="restoreOpen = false">
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="btn btn--danger"
          data-action="confirm-restore-defaults"
          :disabled="restoring"
          @click="confirmRestore"
        >
          {{ restoring ? t('common.saving') : t('settingsUi.restoreConfirm') }}
        </button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
/*
 * 页签（业主 ③）。
 *
 * 为什么不复用全局的 `.chip` / 页签样式：那些是**筛选器**（可多选、可取消），
 * 而这里是**互斥的页面切换**，必须带 `role="tab"` / `aria-selected`。
 * 下划线式而不是按钮式：一排七个按钮看起来像工具栏，页签要看起来像"一个页面的几页"。
 */
.settings-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding-bottom: 2px;
  border-bottom: 1px solid var(--color-border);
}

.settings-tab {
  padding: 6px 12px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
}

.settings-tab:hover {
  background: var(--color-bg-muted);
  color: var(--color-text);
}

.settings-tab--active {
  color: var(--color-accent-hover);
  border-bottom-color: var(--color-accent);
  font-weight: 600;
}

/*
 * 一页的内容：**更紧**（业主 ③：「设置页太宽松」）。
 *
 * 两条具体的收紧：卡片内边距从 `--space-5` 收到 `--space-4`，组与组之间只隔
 * `--space-4`（原来是每块一张卡、卡间距 `--space-5`）。页签之后本来就不需要
 * "每块一张卡"那种分隔方式 —— 一页里的分组用一条细线就够。
 */
.settings-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4);
}

/* 一页里的分组：小标题 + 内容，组间一条细线。 */
.settings-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.settings-group + .settings-group {
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);
}

.settings-group__title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

/*
 * 常规页签的紧凑双列小卡（业主 20260921 批）。
 *
 * 每块 = 标题 + 控件的一张小卡；minmax(300px, 1fr) 让宽窗口两列、窄窗口一列，
 * gap 10px（8–12px 档）。卡内控件与全局表单同一套类（.field / .input / .form-grid），
 * 只是间距收紧：这是「合并四页」而不是「发明第二套表单」。
 */
.mini-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 10px;
}

.mini-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
}

.mini-card__title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

/* 卡内的小分区（存储卡里的磁盘占用、缓存卡里的趋势存储）：一条更淡的线分隔。 */
.mini-card__sub {
  border-top: 1px dashed var(--color-border);
  padding-top: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.mini-card__subtitle {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.mini-card__subtitle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.mini-card .form-grid {
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
}

/*
 * 页面最底部的那张「恢复默认值」卡片（业主 2026-09-16）。
 * 一行：左边是动作名，右边是按钮；用 `margin-left: auto` 把按钮推到右端，
 * 与卡片里其它"标签在左、控件在右"的行保持同一套视觉语言。
 * 它没有专门的配色：这是**破坏性**动作，但破坏性由确认对话框承担（那里写着范围），
 * 把一个常年挂在页面底部的按钮涂成红色只会让它变成背景噪音。
 */
.danger-action {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.danger-action__title {
  font-weight: 600;
}

.danger-action .btn {
  margin-left: auto;
}
/*
 * 语言选择器在侧栏里是撑满一行的；搬进设置卡片后如果照旧撑满，标签与下拉框会被
 * 整张卡的宽度拉开到看起来不像一组。收在一个可读的宽度里。
 */
.settings-language {
  max-width: 320px;
}

.settings-hint {
  font-size: 11.5px;
}

/*
 * 数据接入那两个样式类（`.iot-value` / `.iot-addresses`）随那一页一起删掉了：
 * 现在在「添加设备 → 本机接入」那一块里，那边的样式跟着 `AddDeviceDialog.vue`。
 */

.about-brand {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) 0;
  margin-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-border);
}

.about-brand__logo {
  /* The asset is 224x120 with transparent padding; contain keeps it undistorted
     while the flex row decides the width. */
  width: 168px;
  height: auto;
  object-fit: contain;
  flex: none;
}

.about-brand__meta {
  min-width: 0;
}

.about-brand__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.about-brand__version {
  margin-top: 2px;
  font-size: 12.5px;
  color: var(--color-text-secondary);
}

.about-brand__sep {
  margin: 0 5px;
  color: var(--color-border-strong);
}

.about-brand__build {
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--color-text-secondary);
}

.about-contact {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.settings-grid {
  margin-top: var(--space-2);
}

.path-row {
  display: flex;
  gap: var(--space-2);
}

.path-row .input {
  flex: 1;
}

.disk-kv {
  margin-top: var(--space-3);
}

.copy-btn {
  margin-left: 8px;
}

/* 恢复默认值的范围清单。两列，一眼能数完十六项。 */
.restore-list {
  margin: var(--space-2) 0;
  padding-left: 20px;
  columns: 2;
  font-size: 12.5px;
}
/*
 * 地图卡（业主 2026-09-19 追加第 1 条；20260921 批重做为单选 + 缓存下载）。
 * 单选列表、自定义模板、缓存下载的表单都只是可读性样式。
 */
.map-source-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.map-source {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: 5px var(--space-2);
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.08));
  border-radius: 6px;
  cursor: pointer;
  font-size: 12.5px;
}

.map-source--active {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}

.map-source__radio {
  flex: none;
}

.map-source__name {
  font-weight: 600;
  flex: 1;
  min-width: 140px;
}

.map-licences {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.map-licences strong {
  color: var(--color-text);
}

/* URL 模板整行：它是这一页最长的一个值，挤在半列里会看不到完整域名。 */
.settings-map-form__wide {
  grid-column: 1 / -1;
}

/* 缓存下载的表单网格：短数字（级别）与经纬度各占半列起步。 */
.cache-form {
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
}

.cache-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cache-progress__bar {
  height: 6px;
  border-radius: 999px;
  background: var(--color-bg-subtle);
  overflow: hidden;
}

.cache-progress__fill {
  height: 100%;
  background: var(--color-accent);
  transition: width 0.2s ease;
}

/* GIS / AI 服务库共用的行与编辑器。列表行 = 名称 + 模板摘要 + 操作按钮。 */
.map-service-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.map-service-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
}

.map-service-row__name {
  font-weight: 600;
  min-width: 96px;
}

/* 模板/地址摘要：长地址截断，别把整个布局顶穿。 */
.map-service-row__template {
  flex: 1;
  min-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.ai-service-row__active {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* 编辑器：内联展开的一块表单，与上面的列表分开。 */
.map-service-editor {
  margin-top: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.map-presets {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.map-service-test--ok {
  color: var(--color-success, #2e7d32);
}

</style>

