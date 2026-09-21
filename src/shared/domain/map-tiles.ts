/**
 * 在线底图（GIS）的**纯逻辑**：XYZ 模板、https 校验、可选 key / 子域、时区→中心、
 * Web Mercator 投影与瓦片铺排。
 *
 * ---------------------------------------------------------------------------
 * 为什么放在共享层
 * ---------------------------------------------------------------------------
 * 设置页要即时校验用户输入、地图页要按同一套规则拼瓦片 URL、主进程在落库前要拒绝坏值。
 * 三处必须共用同一份判据：复制一份的结果一定是"界面允许、主进程不认"（或者反过来），
 * 而用户看到的是自动保存失败，我们看到的是一条只在某个入口才出现的漂移。
 *
 * ---------------------------------------------------------------------------
 * 手册未说明（整节都是我们自己的取值）
 * ---------------------------------------------------------------------------
 * `docs/Ivms4200-UX-REFERENCE.md` 没有地图 / 瓦片服务这一章。本文件里的口径 ——
 * 默认关闭、只允许 https、XYZ 模板 `{z}/{x}/{y}`、可选 `{s}` 与 `{key}`、全球供应商
 * 预置、时区→中心表、缩放 2–18 —— **没有一条来自手册或设备**，是仓库按业主
 * 2026-09-19「GIS 应该支持在设置里面配置」那句话做的设计。写在这里，免得下一个人
 * 去手册里找一个不存在的出处。
 *
 * 另一条硬约束：**渲染层仍然不能发 fetch/XHR/WebSocket**（CSP `connect-src 'none'`）。
 * 瓦片只以 `<img>` 形式加载，因此这里做的是 URL 字符串与几何，不做任何网络调用。
 */

/** 缩放范围：业主与设计都要求 2–18；两端都含。 */
export const MIN_TILE_ZOOM = 2
export const MAX_TILE_ZOOM = 18
/** Web Mercator 的瓦片边长（像素）。 */
export const TILE_SIZE = 256
/** Web Mercator 能表示的纬度上下限（tan 在 ±90° 发散，这里取通用截断值）。 */
export const MAX_MERCATOR_LATITUDE = 85.05112878

/**
 * 可选的服务档位；`custom` 表示用户自己填的 XYZ。
 *
 * 全球软件不能只绑一个区域的服务：预置同时覆盖免费公开瓦片、需要自带 key 的全球商业
 * 供应商与中国区域服务。所有档位都默认关闭、都只允许 https；商业服务的模板只是按公开
 * 文档预填，最终以服务商条款与文档为准（§15.89）。
 */
export const MAP_TILE_SERVICES = [
  'custom',
  'osm',
  'opentopomap',
  'carto',
  'esri',
  'maptiler',
  'mapbox',
  'tomtom',
  'stadia',
  'tianditu'
] as const
export type MapTileServiceId = (typeof MAP_TILE_SERVICES)[number]
/** 有预置模板的那些档位（`custom` 没有预置）。 */
export type MapTilePresetId = Exclude<MapTileServiceId, 'custom'>

/** 业主 20260921 批：设备 GIS 坐标保存时由主进程写进的「地图默认中心」。 */
export interface MapDefaultCenter {
  lat: number
  lon: number
  /** 2–18（`isTileZoom` 的同一区间）。 */
  zoom: number
}

/** 落进 `settings` 表的地图配置。 */
export interface MapTilesConfig {
  /** 默认 `false`：离线优先，软件打开时绝不主动出网。 */
  enabled: boolean
  service: MapTileServiceId
  /** XYZ 模板；允许 `{z}` `{x}` `{y}`，另可选用 `{s}` `{key}`。 */
  urlTemplate: string
  /** 可选密钥；模板里出现 `{key}` 时必填。 */
  apiKey: string
  /** 必须显示在地图上的署名文本；启用时不能为空。 */
  attribution: string
  /**
   * 瓦片来源（业主 20260921 批）：`'map-cache'` = 「本地缓存地图」——渲染层优先用
   * 已下载到存储根的本地瓦片（file://），未命中再回落在线 https；缺省 = 不用本地缓存。
   * 只有这一个合法取值：这个字段是**来源开关**而不是随意路径（路径拼法见
   * `tileCacheRelativePath()`，主进程写盘与渲染层读盘共用同一份）。
   */
  cachePath?: 'map-cache'
  /**
   * 地图初始中心（业主 20260921 批）：添加/编辑设备保存 GIS 坐标时由主进程自动写入。
   * 地图页初始视野**优先用它**，其次才是 `timeZoneCenter()`（时区兜底保留）。
   * 缺省 = 还没有任何设备录过点位。
   */
  defaultCenter?: MapDefaultCenter
}

/** 一个服务预置：模板、法定署名与可选子域。 */
export interface MapTilePreset {
  urlTemplate: string
  attribution: string
  subdomains?: readonly string[]
  /** 这一档是否必须业主自己申请 key；界面据此显示提示，真正的校验只看模板里的 `{key}`。 */
  keyRequired: boolean
}

/**
 * 全球主要供应商的预置模板与法定署名。
 *
 * 授权边界的**正文**在四语言目录里（`settingsUi.mapBoundary*`），因为它是给人读的；
 * 这里存的是服务本身规定的**署名文本**与模板。所有档位都默认关闭；商业服务的模板只是
 * 按公开文档预填，服务商改路径或条款时以对方文档为准（用户仍可用自定义 XYZ 改）。
 */
export const MAP_TILE_PRESETS: Record<MapTilePresetId, MapTilePreset> = {
  osm: {
    urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    keyRequired: false
  },
  opentopomap: {
    urlTemplate: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: 'Map data © OpenStreetMap contributors, SRTM | Map style © OpenTopoMap (CC-BY-SA)',
    subdomains: ['a', 'b', 'c'],
    keyRequired: false
  },
  carto: {
    urlTemplate: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    attribution: '© CARTO © OpenStreetMap contributors',
    subdomains: ['a', 'b', 'c', 'd'],
    keyRequired: false
  },
  esri: {
    urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Tiles © Esri — Source: Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS User Community',
    keyRequired: false
  },
  maptiler: {
    urlTemplate: 'https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key={key}',
    attribution: '© MapTiler © OpenStreetMap contributors',
    keyRequired: true
  },
  mapbox: {
    urlTemplate:
      'https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/{z}/{x}/{y}?access_token={key}',
    attribution: '© Mapbox © OpenStreetMap contributors',
    keyRequired: true
  },
  tomtom: {
    urlTemplate: 'https://api.tomtom.com/map/1/tile/basic/main/{z}/{x}/{y}.png?key={key}',
    attribution: '© TomTom',
    keyRequired: true
  },
  stadia: {
    urlTemplate: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}.png?api_key={key}',
    attribution: '© Stadia Maps © OpenMapTiles © OpenStreetMap contributors',
    keyRequired: true
  },
  tianditu: {
    urlTemplate:
      'https://t{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={key}',
    attribution: '© 天地图',
    subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
    keyRequired: true
  }
}

/**
 * 出厂默认：关闭（离线优先不变）、**OpenStreetMap**（业主 20260921 批：OSM 是默认项，
 * 预置列表里排第一且默认选中）。模板与署名直接引用预置表，不抄第二份 ——
 * 服务商改地址时只改 `MAP_TILE_PRESETS` 一处。
 */
export function defaultMapTilesConfig(): MapTilesConfig {
  return {
    enabled: false,
    service: 'osm',
    urlTemplate: MAP_TILE_PRESETS.osm.urlTemplate,
    apiKey: '',
    attribution: MAP_TILE_PRESETS.osm.attribution
  }
}

export function isMapTileService(value: unknown): value is MapTileServiceId {
  return typeof value === 'string' && (MAP_TILE_SERVICES as readonly string[]).includes(value)
}

/** 校验失败的具体原因；界面把它翻译成四语言错误文案。 */
export type MapTilesProblem =
  | 'templateRequired'
  | 'templateProtocol'
  | 'templateTokens'
  | 'templateTokenUnknown'
  | 'templateInvalid'
  | 'keyRequired'
  | 'keyInvalid'
  | 'attributionRequired'

const ALLOWED_TEMPLATE_TOKENS = new Set(['z', 'x', 'y', 's', 'key'])

function templateTokens(template: string): string[] {
  return [...template.matchAll(/\{([^}]*)\}/g)].map((match) => match[1] ?? '')
}

function sampleTileUrl(template: string): string {
  return template
    .replace(/\{z\}/g, '3')
    .replace(/\{x\}/g, '4')
    .replace(/\{y\}/g, '2')
    .replace(/\{s\}/g, 'a')
    .replace(/\{key\}/g, 'sample-key')
}

/**
 * 校验一份地图配置。
 *
 * 规则（任何一条不满足都返回一个**具体原因**，而不是笼统的"不合法"）：
 *   · 关闭或留空模板：合法（这是出厂状态）；
 *   · 非空模板：必须以 `https://` 开头、只能出现上面五个占位符、必须有 `z/x/y`；
 *   · 模板含 `{key}` 时 key 必填；启用时署名必填；
 *   · URL 去掉占位符后必须真的能被 `new URL()` 读成一个带主机的地址。
 */
export function mapTilesProblem(config: MapTilesConfig): MapTilesProblem | null {
  if (!config || typeof config !== 'object') return 'templateInvalid'
  if (typeof config.enabled !== 'boolean') return 'templateInvalid'
  if (!isMapTileService(config.service)) return 'templateInvalid'
  const rawTemplate = typeof config.urlTemplate === 'string' ? config.urlTemplate : ''
  const rawKey = typeof config.apiKey === 'string' ? config.apiKey : ''
  const rawAttribution = typeof config.attribution === 'string' ? config.attribution : ''
  const template = rawTemplate.trim()
  const key = rawKey.trim()
  const attribution = rawAttribution.trim()

  if (rawTemplate.length > 2048 || rawAttribution.length > 512 || rawKey.length > 512) {
    return rawAttribution.length > 512 ? 'attributionRequired' : rawKey.length > 512 ? 'keyInvalid' : 'templateInvalid'
  }
  if (key.includes('\n') || key.includes('\r') || key.includes('\t')) return 'keyInvalid'

  if (template === '') return config.enabled ? 'templateRequired' : null

  if (!/^https:\/\//i.test(template)) return 'templateProtocol'
  if (/\s/.test(template)) return 'templateInvalid'

  const tokens = templateTokens(template)
  if (tokens.some((token) => !ALLOWED_TEMPLATE_TOKENS.has(token))) return 'templateTokenUnknown'
  // 不配对的花括号既不是合法占位符，也可能让 URL 在运行时变成一个奇怪的空格/编码；
  // 先按'未知占位符'退回，别把坏模板存进设置库。
  const withoutTokens = template.replace(/\{(z|x|y|s|key)\}/g, '')
  if (withoutTokens.includes('{') || withoutTokens.includes('}')) return 'templateTokenUnknown'
  for (const required of ['z', 'x', 'y']) {
    if (!tokens.includes(required)) return 'templateTokens'
  }
  if (tokens.includes('key') && key === '') return 'keyRequired'

  try {
    const sample = new URL(sampleTileUrl(template))
    if (!sample.hostname) return 'templateInvalid'
  } catch {
    return 'templateInvalid'
  }

  if (config.enabled && attribution === '') return 'attributionRequired'
  return null
}

/**
 * 把任意输入归一化成合法的 `MapTilesConfig`；不合法时返回 `undefined`（整键拒绝）。
 *
 * 与 `mapTilesProblem()` 的分工：这里接收的是**磁盘 / IPC 来的 unknown**，所以先做
 * 形状检查、再做语义检查；界面调用 `mapTilesProblem()` 拿具体原因，主进程调用这里
 * 决定"这一笔写不写"。
 */
export function normaliseMapTilesConfig(value: unknown): MapTilesConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return undefined
  if (raw.service !== undefined && !isMapTileService(raw.service)) return undefined
  for (const field of ['urlTemplate', 'apiKey', 'attribution'] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') return undefined
  }

  const config: MapTilesConfig = {
    enabled: raw.enabled === true,
    service: isMapTileService(raw.service) ? raw.service : 'custom',
    urlTemplate: typeof raw.urlTemplate === 'string' ? raw.urlTemplate.trim() : '',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    attribution: typeof raw.attribution === 'string' ? raw.attribution.trim() : ''
  }
  /*
   * 两个新可选字段（业主 20260921 批）**只认合法值，坏值丢掉而不是整键拒绝**：
   * 旧版本数据里没有它们，一份带坏 `defaultCenter` 的磁盘数据不该让整份地图配置
   * （用户配好的模板/署名）作废 —— 与上面那些互相约束的必填字段是两种性质。
   */
  if (raw.cachePath === 'map-cache') config.cachePath = 'map-cache'
  if (
    raw.defaultCenter !== undefined &&
    raw.defaultCenter !== null &&
    typeof raw.defaultCenter === 'object'
  ) {
    const center = raw.defaultCenter as Record<string, unknown>
    const lat = center.lat
    const lon = center.lon
    const zoom = center.zoom
    if (
      typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90 &&
      typeof lon === 'number' && Number.isFinite(lon) && Math.abs(lon) <= 180 &&
      typeof zoom === 'number' && isTileZoom(zoom)
    ) {
      config.defaultCenter = { lat, lon, zoom }
    }
  }
  return mapTilesProblem(config) === null ? config : undefined
}

/** 缩放级别夹到 2–18 的整数；坏输入回落到最小值。 */
export function clampTileZoom(value: number): number {
  if (!Number.isFinite(value)) return MIN_TILE_ZOOM
  return Math.min(MAX_TILE_ZOOM, Math.max(MIN_TILE_ZOOM, Math.round(value)))
}

export function isTileZoom(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_TILE_ZOOM && value <= MAX_TILE_ZOOM
}

function tileSubdomains(service: MapTileServiceId): readonly string[] {
  if (service === 'osm') return ['a']
  if (service === 'opentopomap') return MAP_TILE_PRESETS.opentopomap.subdomains ?? ['a']
  if (service === 'tianditu') return MAP_TILE_PRESETS.tianditu.subdomains ?? ['0']
  if (service === 'carto') return MAP_TILE_PRESETS.carto.subdomains ?? ['a']
  return ['a', 'b', 'c', 'd']
}

/**
 * 拼一块瓦片的最终 URL。
 *
 * `x` 按世界横轴取模（跨 180° 经线时回到另一侧），`y` 越界返回空串（Web Mercator 在
 * 两极之外没有瓦片）；子域按 `(x + y) % 子域数` 轮换 —— 同一个位置每次刷新拿到同一子域，
 * 便于缓存，也能让这些预置看起来像它们文档里的例子。
 */
export function tileUrl(config: MapTilesConfig, z: number, x: number, y: number): string {
  if (!isTileZoom(z) || !Number.isInteger(x) || !Number.isInteger(y)) return ''
  const world = 2 ** z
  if (y < 0 || y >= world) return ''
  const wrappedX = ((x % world) + world) % world
  const subdomains = tileSubdomains(config.service)
  const subdomain = subdomains[(wrappedX + y) % Math.max(1, subdomains.length)] ?? subdomains[0] ?? ''
  const template = config.urlTemplate.trim()
  if (template === '') return ''
  return template
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(wrappedX))
    .replace(/\{y\}/g, String(y))
    .replace(/\{s\}/g, subdomain)
    .replace(/\{key\}/g, encodeURIComponent(config.apiKey.trim()))
}

// ---------------------------------------------------------------------------
// 本地瓦片缓存（业主 20260921 批：设置里下载瓦片到存储根，离线复用）
// ---------------------------------------------------------------------------

/**
 * 缓存子目录名（存储根下）：`map-cache`。主进程下载写入与渲染层 `file://` 读取
 * 共用这一个名字，不各自拼 —— 两处拼法一漂移，"下载了却读不到"就是必然的下一步。
 */
export const MAP_CACHE_SUBDIR = 'map-cache'

/**
 * 一块瓦片在存储根里的**相对路径**（主进程落盘与渲染层拼 `file://` 是同一份）。
 * 结构：`map-cache/<service>/z/x/y.png`（业主 20260921 批给定的目录结构）。
 */
export function tileCacheRelativePath(
  service: MapTileServiceId,
  z: number,
  x: number,
  y: number
): string {
  return `${MAP_CACHE_SUBDIR}/${service}/${z}/${x}/${y}.png`
}

/** 一次缓存下载的经纬度区域（西南角 → 东北角，度数）。 */
export interface TileCacheBounds {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

/**
 * 一个经纬度区域在某个缩放级别上覆盖的瓦片行列范围（两端都含）。
 *
 * 用 Web Mercator 的世界像素坐标算（与 `viewTiles` 同一套投影）：`floor(坐标 / 256)`
 * 即瓦片索引。纬度先夹到 `±MAX_MERCATOR_LATITUDE`——Web Mercator 在两极之外没有瓦片。
 */
export function tileRangeForBounds(
  bounds: TileCacheBounds,
  z: number
): { xMin: number; xMax: number; yMin: number; yMax: number } | null {
  if (!isTileZoom(z)) return null
  const world = TILE_SIZE * 2 ** z
  const left = lonToWorldX(bounds.minLon, z)
  const right = lonToWorldX(bounds.maxLon, z)
  const top = latToWorldY(bounds.maxLat, z)
  const bottom = latToWorldY(bounds.minLat, z)
  if (![left, right, top, bottom].every(Number.isFinite)) return null
  const clampX = (value: number) => Math.max(0, Math.min(world - TILE_SIZE, value))
  const clampY = (value: number) => Math.max(0, Math.min(world - TILE_SIZE, value))
  return {
    xMin: Math.floor(clampX(left) / TILE_SIZE),
    xMax: Math.floor(clampX(right) / TILE_SIZE),
    yMin: Math.floor(clampY(top) / TILE_SIZE),
    yMax: Math.floor(clampY(bottom) / TILE_SIZE)
  }
}

// ---------------------------------------------------------------------------
// Web Mercator 与视口
// ---------------------------------------------------------------------------

export interface MapCenter {
  latitude: number
  longitude: number
  /** 2–18. */
  zoom: number
}

export function lonToWorldX(longitude: number, zoom: number): number {
  const z = clampTileZoom(zoom)
  return ((longitude + 180) / 360) * TILE_SIZE * 2 ** z
}

export function latToWorldY(latitude: number, zoom: number): number {
  const z = clampTileZoom(zoom)
  const clamped = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude))
  const radians = (clamped * Math.PI) / 180
  return (
    (0.5 - Math.log((1 + Math.sin(radians)) / (1 - Math.sin(radians))) / (4 * Math.PI)) *
    TILE_SIZE *
    2 ** z
  )
}

export function worldXToLon(x: number, zoom: number): number {
  const z = clampTileZoom(zoom)
  return (x / (TILE_SIZE * 2 ** z)) * 360 - 180
}

export function worldYToLat(y: number, zoom: number): number {
  const z = clampTileZoom(zoom)
  const n = Math.PI - (2 * Math.PI * y) / (TILE_SIZE * 2 ** z)
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

/** 一个经纬度点在当前视口里的像素坐标（画布左上角为原点）。 */
export function projectToViewport(
  center: MapCenter,
  latitude: number,
  longitude: number,
  width: number,
  height: number
): { x: number; y: number } {
  const z = clampTileZoom(center.zoom)
  const centerX = lonToWorldX(center.longitude, z)
  const centerY = latToWorldY(center.latitude, z)
  return {
    x: lonToWorldX(longitude, z) - centerX + width / 2,
    y: latToWorldY(latitude, z) - centerY + height / 2
  }
}

/**
 * 拖拽平移：画布向右拖 `dx` 像素 = 视野向西移（中心经度减小）。
 *
 * `dx/dy` 必须是**画布逻辑像素**；调用方按 `CANVAS.width / frame.clientWidth` 换算，
 * 否则 125% DPI 或窗口缩放时会拖得比鼠标快/慢。
 */
export function panMapCenter(center: MapCenter, dx: number, dy: number): MapCenter {
  const z = clampTileZoom(center.zoom)
  const worldSize = TILE_SIZE * 2 ** z
  const nextX = (((lonToWorldX(center.longitude, z) - dx) % worldSize) + worldSize) % worldSize
  const nextY = Math.max(0, Math.min(worldSize, latToWorldY(center.latitude, z) - dy))
  return {
    latitude: worldYToLat(nextY, z),
    longitude: worldXToLon(nextX, z),
    zoom: z
  }
}

export interface MapTilePlacement {
  /** 稳定键：缩放 / 原始列 / 行 / URL（同位置换服务也会换键，`<img>` 因而重建）。 */
  key: string
  z: number
  x: number
  y: number
  url: string
  /** 相对当前视口左上角的像素位置（逻辑坐标，可能为负）。 */
  left: number
  top: number
}

/**
 * 当前视口需要的瓦片。
 *
 * `x` 允许绕世界横轴取模（低缩放级别、超宽窗口时同一列会重复出现）；`y` 不绕：
 * 两极之外没有瓦片，那些位置由画布底色兜底。
 */
export function viewTiles(
  config: MapTilesConfig,
  center: MapCenter,
  zoom: number,
  width: number,
  height: number
): MapTilePlacement[] {
  if (config.urlTemplate.trim() === '') return []
  const z = clampTileZoom(zoom)
  const centerX = lonToWorldX(center.longitude, z)
  const centerY = latToWorldY(center.latitude, z)
  const left = centerX - width / 2
  const top = centerY - height / 2
  const world = 2 ** z

  const xStart = Math.floor(left / TILE_SIZE)
  const xEnd = Math.floor((left + width - 1e-9) / TILE_SIZE)
  const yStart = Math.floor(top / TILE_SIZE)
  const yEnd = Math.floor((top + height - 1e-9) / TILE_SIZE)

  const placements: MapTilePlacement[] = []
  for (let y = yStart; y <= yEnd; y += 1) {
    if (y < 0 || y >= world) continue
    for (let x = xStart; x <= xEnd; x += 1) {
      const wrappedX = ((x % world) + world) % world
      const url = tileUrl(config, z, wrappedX, y)
      if (url === '') continue
      placements.push({
        key: `${z}/${x}/${y}/${url}`,
        z,
        x: wrappedX,
        y,
        url,
        left: x * TILE_SIZE - left,
        top: y * TILE_SIZE - top
      })
    }
  }
  return placements
}

// ---------------------------------------------------------------------------
// 时区 → 中心
// ---------------------------------------------------------------------------

/**
 * 时区前缀表（**我们自己的取值，手册未说明**）。
 *
 * 查找顺序就是数组顺序：具体城市在前，大区兜底在后；命中规则是"完全相等或
 * `match + '/'` 前缀"。取不到（或时区名不认识）就落到世界中心 `0, 0`、缩放 2 ——
 * 这与设计文档 §15.85.2 的约定一致，不把一张看不懂的地图硬塞给用户。
 */
const TIME_ZONE_CENTERS: ReadonlyArray<{
  match: string
  latitude: number
  longitude: number
  zoom: number
}> = [
  // 中国（时区名含四个行政区；中心取该时区名对应的大致区域中心，缩放取大区级 4）。
  { match: 'asia/shanghai', latitude: 31.2304, longitude: 121.4737, zoom: 4 },
  { match: 'asia/chongqing', latitude: 29.563, longitude: 106.5516, zoom: 4 },
  { match: 'asia/harbin', latitude: 45.8038, longitude: 126.535, zoom: 4 },
  { match: 'asia/urumqi', latitude: 43.8256, longitude: 87.6168, zoom: 4 },
  { match: 'asia/hong_kong', latitude: 22.3193, longitude: 114.1694, zoom: 6 },
  { match: 'asia/macau', latitude: 22.1987, longitude: 113.5439, zoom: 6 },
  { match: 'asia/taipei', latitude: 25.033, longitude: 121.5654, zoom: 6 },
  { match: 'asia/tokyo', latitude: 36.2048, longitude: 138.2529, zoom: 5 },
  { match: 'asia/seoul', latitude: 36.5, longitude: 127.8, zoom: 6 },
  { match: 'asia/singapore', latitude: 1.3521, longitude: 103.8198, zoom: 8 },
  { match: 'asia/bangkok', latitude: 15.87, longitude: 100.9925, zoom: 5 },
  { match: 'asia/jakarta', latitude: -2.5489, longitude: 118.0149, zoom: 5 },
  { match: 'asia/kolkata', latitude: 22.5937, longitude: 78.9629, zoom: 5 },
  { match: 'asia/calcutta', latitude: 22.5937, longitude: 78.9629, zoom: 5 },
  { match: 'asia/karachi', latitude: 30.3753, longitude: 69.3451, zoom: 5 },
  { match: 'asia/dubai', latitude: 24.4667, longitude: 54.3667, zoom: 6 },
  { match: 'asia/riyadh', latitude: 23.8859, longitude: 45.0792, zoom: 5 },
  { match: 'asia/tehran', latitude: 32.4279, longitude: 53.688, zoom: 5 },
  { match: 'asia/jerusalem', latitude: 31.0461, longitude: 34.8516, zoom: 7 },
  { match: 'asia/vladivostok', latitude: 43.1332, longitude: 131.9113, zoom: 6 },
  { match: 'asia/ho_chi_minh', latitude: 16.0, longitude: 108.0, zoom: 5 },
  { match: 'asia/manila', latitude: 12.8797, longitude: 121.774, zoom: 5 },
  { match: 'asia/kuala_lumpur', latitude: 3.139, longitude: 101.6869, zoom: 6 },
  { match: 'asia/kathmandu', latitude: 27.7172, longitude: 85.324, zoom: 6 },
  { match: 'asia/dhaka', latitude: 23.685, longitude: 90.3563, zoom: 5 },
  { match: 'asia/almaty', latitude: 48.0196, longitude: 66.9237, zoom: 5 },
  { match: 'asia/tashkent', latitude: 41.2995, longitude: 69.2401, zoom: 5 },
  { match: 'asia/novosibirsk', latitude: 55.0084, longitude: 82.9357, zoom: 5 },
  { match: 'europe/london', latitude: 54.0, longitude: -2.0, zoom: 5 },
  { match: 'europe/dublin', latitude: 53.4129, longitude: -8.2439, zoom: 6 },
  { match: 'europe/paris', latitude: 46.6034, longitude: 1.8883, zoom: 5 },
  { match: 'europe/berlin', latitude: 51.1657, longitude: 10.4515, zoom: 5 },
  { match: 'europe/madrid', latitude: 40.4637, longitude: -3.7492, zoom: 6 },
  { match: 'europe/rome', latitude: 41.8719, longitude: 12.5674, zoom: 6 },
  { match: 'europe/amsterdam', latitude: 52.1326, longitude: 5.2913, zoom: 7 },
  { match: 'europe/moscow', latitude: 55.7558, longitude: 37.6173, zoom: 5 },
  { match: 'europe/istanbul', latitude: 41.0082, longitude: 28.9784, zoom: 6 },
  { match: 'europe/kyiv', latitude: 48.3794, longitude: 31.1656, zoom: 5 },
  { match: 'europe/warsaw', latitude: 52.2297, longitude: 21.0122, zoom: 5 },
  { match: 'europe/stockholm', latitude: 60.1282, longitude: 18.6435, zoom: 4 },
  { match: 'europe/oslo', latitude: 60.472, longitude: 8.4689, zoom: 5 },
  { match: 'europe/helsinki', latitude: 61.9241, longitude: 25.7482, zoom: 4 },
  { match: 'europe/athens', latitude: 39.0742, longitude: 21.8243, zoom: 6 },
  { match: 'europe/lisbon', latitude: 39.3999, longitude: -8.2245, zoom: 6 },
  { match: 'europe/zurich', latitude: 46.8182, longitude: 8.2275, zoom: 7 },
  { match: 'europe/brussels', latitude: 50.5039, longitude: 4.4699, zoom: 7 },
  { match: 'europe/vienna', latitude: 47.5162, longitude: 14.5501, zoom: 6 },
  { match: 'america/new_york', latitude: 40.7128, longitude: -74.006, zoom: 7 },
  { match: 'america/chicago', latitude: 41.8781, longitude: -87.6298, zoom: 7 },
  { match: 'america/denver', latitude: 39.7392, longitude: -104.9903, zoom: 7 },
  { match: 'america/los_angeles', latitude: 34.0522, longitude: -118.2437, zoom: 7 },
  { match: 'america/sao_paulo', latitude: -23.5505, longitude: -46.6333, zoom: 6 },
  { match: 'america/mexico_city', latitude: 23.6345, longitude: -102.5528, zoom: 5 },
  { match: 'america/toronto', latitude: 56.1304, longitude: -106.3468, zoom: 4 },
  { match: 'america/vancouver', latitude: 49.2827, longitude: -123.1207, zoom: 7 },
  { match: 'america/argentina/buenos_aires', latitude: -23.5505, longitude: -58.4155, zoom: 6 },
  { match: 'america/santiago', latitude: -33.4489, longitude: -70.6693, zoom: 5 },
  { match: 'america/bogota', latitude: 4.5709, longitude: -74.2973, zoom: 5 },
  { match: 'america/lima', latitude: -9.19, longitude: -75.0152, zoom: 5 },
  { match: 'america/havana', latitude: 23.1136, longitude: -82.3666, zoom: 6 },
  { match: 'america/panama', latitude: 8.5379, longitude: -80.7821, zoom: 6 },
  { match: 'america/halifax', latitude: 44.6488, longitude: -63.5752, zoom: 6 },
  { match: 'america/phoenix', latitude: 33.4484, longitude: -112.074, zoom: 6 },
  { match: 'america/anchorage', latitude: 61.2181, longitude: -149.9003, zoom: 4 },
  { match: 'america/honolulu', latitude: 21.3069, longitude: -157.8583, zoom: 7 },
  { match: 'australia/sydney', latitude: -33.8688, longitude: 151.2093, zoom: 7 },
  { match: 'australia/perth', latitude: -31.9505, longitude: 115.8605, zoom: 7 },
  { match: 'pacific/auckland', latitude: -36.8485, longitude: 174.7633, zoom: 6 },
  { match: 'africa/cairo', latitude: 26.8206, longitude: 30.8025, zoom: 5 },
  { match: 'africa/johannesburg', latitude: -26.2041, longitude: 28.0473, zoom: 6 },
  { match: 'africa/lagos', latitude: 6.5244, longitude: 3.3792, zoom: 6 },
  { match: 'africa/nairobi', latitude: -1.2921, longitude: 36.8219, zoom: 6 },
  { match: 'africa/accra', latitude: 5.6037, longitude: -0.187, zoom: 6 },
  { match: 'africa/casablanca', latitude: 33.5731, longitude: -7.5898, zoom: 5 },
  { match: 'africa/addis_ababa', latitude: 8.9806, longitude: 38.7578, zoom: 5 },
  { match: 'australia/brisbane', latitude: -27.4698, longitude: 153.0251, zoom: 7 },
  { match: 'australia/adelaide', latitude: -34.9285, longitude: 138.6007, zoom: 6 },
  { match: 'australia/darwin', latitude: -12.4634, longitude: 130.8456, zoom: 6 },
  { match: 'pacific/fiji', latitude: -17.7134, longitude: 178.065, zoom: 5 },
  { match: 'pacific/guam', latitude: 13.4443, longitude: 144.7937, zoom: 6 },
  { match: 'indian/mauritius', latitude: -20.3484, longitude: 57.5522, zoom: 6 },
  { match: 'indian/maldives', latitude: 3.2028, longitude: 73.2207, zoom: 6 },
  { match: 'atlantic/canary', latitude: 28.2916, longitude: -15.4311, zoom: 6 },
  // 大区兜底（城市名不认识时至少落在同一洲，而不是永远的世界中心）。
  { match: 'asia', latitude: 34.0479, longitude: 100.6197, zoom: 4 },
  { match: 'europe', latitude: 54.526, longitude: 15.2551, zoom: 4 },
  { match: 'america', latitude: 39.0, longitude: -98.0, zoom: 4 },
  { match: 'australia', latitude: -25.2744, longitude: 133.7751, zoom: 4 },
  { match: 'africa', latitude: 0.0, longitude: 20.0, zoom: 3 },
  { match: 'pacific', latitude: 0.0, longitude: -160.0, zoom: 3 },
  { match: 'indian', latitude: -20.0, longitude: 80.0, zoom: 3 },
  { match: 'atlantic', latitude: 30.0, longitude: -30.0, zoom: 3 },
  { match: 'antarctica', latitude: -80.0, longitude: 0.0, zoom: 2 },
  // UTC / GMT 家族：一张看不出地点的世界图。
  { match: 'utc', latitude: 0.0, longitude: 0.0, zoom: 2 },
  { match: 'etc/utc', latitude: 0.0, longitude: 0.0, zoom: 2 },
  { match: 'gmt', latitude: 0.0, longitude: 0.0, zoom: 2 },
  { match: 'etc/gmt', latitude: 0.0, longitude: 0.0, zoom: 2 }
]

/**
 * 由电脑时区推默认中心。
 *
 * 输入用 `Intl.DateTimeFormat().resolvedOptions().timeZone` 的 IANA 名字；大小写不敏感，
 * 下划线与空格都接受。不认识的时区回落到 `0, 0`、缩放 2。
 */
export function timeZoneCenter(timeZone: string | null | undefined): MapCenter {
  const normalized = String(timeZone ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
  for (const entry of TIME_ZONE_CENTERS) {
    if (normalized === entry.match || normalized.startsWith(`${entry.match}/`)) {
      return { latitude: entry.latitude, longitude: entry.longitude, zoom: entry.zoom }
    }
  }
  return { latitude: 0, longitude: 0, zoom: MIN_TILE_ZOOM }
}

// ---------------------------------------------------------------------------
// 命名的 GIS 服务库（业主追加：设置里「添加 GIS 服务」）
// ---------------------------------------------------------------------------

/** 库里最多存几条命名服务：设置页一个小列表，不是数据库；太多条本身就是一种混乱。 */
export const MAX_MAP_SERVICES = 20
/** 服务显示名长度上限。 */
export const MAX_MAP_SERVICE_NAME = 64

/**
 * 一条**命名的** GIS 服务（设置 → 地图 → GIS 服务库）。
 *
 * 与 `MapTilesConfig` 的关系：`MapTilesConfig` 是"**当前生效**的那一份"（带 enabled
 * 开关），`MapServiceEntry` 是可命名保存、随时一键选用的**备选库**。条目本身没有开关——
 * 「启用」发生在「应用」那一刻：把条目内容抄进 `mapTiles` 并置 enabled。
 *
 * 校验判据与 `mapTilesProblem()` **同一份**（那里注释了为什么规则只有一套）：这里只是
 * 把"模板必填、名称必填"补进去。
 */
export interface MapServiceEntry {
  id: string
  name: string
  service: MapTileServiceId
  urlTemplate: string
  apiKey: string
  attribution: string
}

/** 新条目 id。渲染层（添加）与主进程（迁移/兜底）都用它，避免两处各写一套。 */
export function newMapServiceId(): string {
  return globalThis.crypto.randomUUID()
}

/** 校验一条库条目；合法返回 null，否则返回与 `mapTilesProblem()` 同枚举的问题码。 */
export function mapServiceProblem(entry: MapServiceEntry): MapTilesProblem | null {
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (name === '') return 'templateInvalid'
  if (name.length > MAX_MAP_SERVICE_NAME || /[\u0000-\u001F]/.test(name)) return 'templateInvalid'
  // 库里存一条空模板服务没有意义：这一条比 mapTilesProblem() 多出来的唯一规则。
  if (typeof entry.urlTemplate !== 'string' || entry.urlTemplate.trim() === '') {
    return 'templateRequired'
  }
  return mapTilesProblem({ enabled: false, ...entry })
}

/**
 * 把任意输入归一化成服务库；坏条目**逐条丢弃**并记 issues（一条坏服务不该让整个库作废，
 * 与 `alarmLinkage` 逐字段回落同一哲学）。issues 里的字符串是「索引:问题码」。
 */
export function normaliseMapServices(value: unknown): { services: MapServiceEntry[]; issues: string[] } {
  const empty = { services: [] as MapServiceEntry[], issues: [] as string[] }
  if (!Array.isArray(value)) return empty
  const services: MapServiceEntry[] = []
  const issues: string[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value.entries()) {
    if (services.length >= MAX_MAP_SERVICES) {
      issues.push(`${index}:too-many`)
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push(`${index}:shape`)
      continue
    }
    const record = raw as Record<string, unknown>
    const entry: MapServiceEntry = {
      id:
        typeof record.id === 'string' && record.id.trim() !== ''
          ? record.id.trim()
          : newMapServiceId(),
      name:
        typeof record.name === 'string' ? record.name.trim().slice(0, MAX_MAP_SERVICE_NAME) : '',
      service: isMapTileService(record.service) ? record.service : 'custom',
      urlTemplate: typeof record.urlTemplate === 'string' ? record.urlTemplate.trim() : '',
      apiKey: typeof record.apiKey === 'string' ? record.apiKey.trim() : '',
      attribution: typeof record.attribution === 'string' ? record.attribution.trim() : ''
    }
    if (seen.has(entry.id)) {
      issues.push(`${index}:duplicate-id`)
      continue
    }
    const problem = mapServiceProblem(entry)
    if (problem !== null) {
      issues.push(`${index}:${problem}`)
      continue
    }
    seen.add(entry.id)
    services.push(entry)
  }
  return { services, issues }
}