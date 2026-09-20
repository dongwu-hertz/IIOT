/**
 * 在线底图（GIS）的纯逻辑与界面守卫（业主 2026-09-19 追加第 1 条）。
 *
 * WHY THIS FILE EXISTS
 * 这一条把"地图"从一张自绘 SVG 变成可选的真实瓦片底图，四个位置必须说同一句话：
 *   1. **默认关闭**：离线优先是这个仓库从第一天起的约束，装完就出网是缺陷；
 *   2. **只允许 https**：http 模板、file、以及带空格的坏地址都要在落库前被拒绝；
 *   3. **XYZ 模板 + 可选 key + 署名**：模板缺 z/x/y、key 占位符留空、启用时不写署名，
 *      三种错误各自有明确原因；
 *   4. **时区推中心 + 缩放 2–18**：中心点表与"查不到落到世界中心"是**我们自己的设计**
 *      （手册未说明），所以用纯函数钉死，免得下一轮换一个人又拍一个值。
 *
 * 界面源码守卫也在这份里：设置页全球供应商预置与授权边界、地图页的瓦片钩子/控制条/署名、
 * CSP 仍然 `connect-src 'none'`、四语言键必须存在。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  MAP_TILE_PRESETS,
  MAX_TILE_ZOOM,
  MIN_TILE_ZOOM,
  clampTileZoom,
  defaultMapTilesConfig,
  isTileZoom,
  latToWorldY,
  lonToWorldX,
  mapTilesProblem,
  normaliseMapTilesConfig,
  panMapCenter,
  projectToViewport,
  tileUrl,
  timeZoneCenter,
  viewTiles,
  type MapTilesConfig
} from '../src/shared/domain/map-tiles'
import { openDatabase } from '../src/main/services/database/schema'
import {
  DEFAULT_SETTINGS,
  RESTORABLE_SETTING_KEYS,
  SettingsService
} from '../src/main/services/settings/settings-service'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'
import { LOCALES } from '../src/shared/i18n/locales'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

const OSM: MapTilesConfig = {
  enabled: true,
  service: 'osm',
  urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  apiKey: '',
  attribution: '© OpenStreetMap contributors'
}

function config(overrides: Partial<MapTilesConfig> = {}): MapTilesConfig {
  return { ...OSM, ...overrides }
}

describe('在线底图：默认与 https XYZ 校验', () => {
  it('出厂默认是关闭、custom、空模板（离线优先）', () => {
    const defaults = defaultMapTilesConfig()
    assert.equal(defaults.enabled, false)
    assert.equal(defaults.service, 'custom')
    assert.equal(defaults.urlTemplate, '')
    assert.equal(defaults.apiKey, '')
    assert.equal(defaults.attribution, '')
    assert.equal(DEFAULT_SETTINGS.mapTiles.enabled, false)
    assert.ok((RESTORABLE_SETTING_KEYS as readonly string[]).includes('mapTiles'))
  })

  it('关闭且模板为空时合法；一打开就要求 URL 与署名', () => {
    assert.equal(mapTilesProblem(defaultMapTilesConfig()), null)
    assert.equal(
      mapTilesProblem(config({ enabled: true, urlTemplate: '', attribution: '' })),
      'templateRequired'
    )
    assert.equal(
      mapTilesProblem(config({ enabled: true, attribution: '' })),
      'attributionRequired'
    )
  })

  it('只允许 https，其他协议（含大小写变体）都拒绝', () => {
    assert.equal(mapTilesProblem(config({ urlTemplate: 'http://example.com/{z}/{x}/{y}.png' })), 'templateProtocol')
    assert.equal(mapTilesProblem(config({ urlTemplate: 'file:///C:/tiles/{z}/{x}/{y}.png' })), 'templateProtocol')
    assert.equal(mapTilesProblem(config({ urlTemplate: 'ftp://example.com/{z}/{x}/{y}.png' })), 'templateProtocol')
    // HTTPS 的大小写是协议大小写，接受；但地址本身仍要能解析。
    assert.equal(mapTilesProblem(config({ urlTemplate: 'HTTPS://example.com/{z}/{x}/{y}.png' })), null)
  })

  it('模板必须恰好使用 z/x/y；缺一个或出现未知占位符都说得出原因', () => {
    assert.equal(
      mapTilesProblem(config({ urlTemplate: 'https://example.com/{z}/{x}.png' })),
      'templateTokens'
    )
    assert.equal(
      mapTilesProblem(config({ urlTemplate: 'https://example.com/{z}/{x}/{y}/{q}.png' })),
      'templateTokenUnknown'
    )
    assert.equal(
      mapTilesProblem(config({ urlTemplate: 'https://example.com/{z}/{x}/{y}.png ' })),
      null
    )
    assert.equal(
      mapTilesProblem(config({ urlTemplate: 'https://example.com/{z}/{x}/{y}.png{' })),
      'templateTokenUnknown'
    )
  })

  it('模板里有 {key} 就必填；key 本身不能带换行', () => {
    assert.equal(
      mapTilesProblem(
        config({
          service: 'tianditu',
          urlTemplate: 'https://t{s}.example.com/{z}/{x}/{y}.png?tk={key}',
          apiKey: '',
          attribution: '© map provider'
        })
      ),
      'keyRequired'
    )
    assert.equal(
      mapTilesProblem(config({ urlTemplate: 'https://example.com/{z}/{x}/{y}.png?k={key}', apiKey: 'a\nb' })),
      'keyInvalid'
    )
  })

  it('至少包含 z、x、y 是硬约束；{s} 与 {key} 是可选扩展', () => {
    const withS = config({ service: 'carto', urlTemplate: MAP_TILE_PRESETS.carto.urlTemplate })
    assert.equal(mapTilesProblem(withS), null)
    assert.ok(withS.urlTemplate.includes('{s}'))
    assert.ok(withS.urlTemplate.includes('{z}'))
  })

  it('normalise：坏输入整键拒绝，合法输入回填成完整对象', () => {
    assert.equal(normaliseMapTilesConfig(null), undefined)
    assert.equal(normaliseMapTilesConfig({ enabled: 'yes' }), undefined)
    assert.equal(normaliseMapTilesConfig({ service: 'amap' }), undefined)
    assert.equal(normaliseMapTilesConfig({ urlTemplate: 42 }), undefined)
    assert.equal(
      normaliseMapTilesConfig({ enabled: true, service: 'osm', urlTemplate: 'https://x/{z}/{x}/{y}.png' }),
      undefined,
      '启用时没有署名也必须拒绝'
    )
    const valid = normaliseMapTilesConfig({
      enabled: true,
      service: 'osm',
      urlTemplate: '  https://tile.openstreetmap.org/{z}/{x}/{y}.png  ',
      apiKey: '',
      attribution: ' © OpenStreetMap contributors '
    })
    assert.ok(valid)
    assert.equal(valid?.urlTemplate, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png')
    assert.equal(valid?.attribution, '© OpenStreetMap contributors')
  })
})

describe('XYZ 模板：拼 URL 与子域', () => {
  it('{z}/{x}/{y} 被替换；{key} 做 URL 编码', () => {
    const cfg = config({
      urlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png?token={key}',
      apiKey: 'a b+c&d'
    })
    assert.equal(
      tileUrl(cfg, 5, 10, 20),
      'https://tiles.example.com/5/10/20.png?token=a%20b%2Bc%26d'
    )
  })

  it('{s} 按 (x + y) 轮换，同一块瓦片每次拿到同一个子域', () => {
    const cfg = config({ service: 'carto', urlTemplate: 'https://{s}.example.com/{z}/{x}/{y}.png' })
    const a = tileUrl(cfg, 3, 1, 1)
    const b = tileUrl(cfg, 3, 1, 1)
    assert.equal(a, b, '同一块瓦片的子域不稳定')
    assert.match(a, /^https:\/\/[a-d]\.example\.com\/3\/1\/1\.png$/)
  })

  it('x 绕过 180° 经线回到另一侧；y 越界返回空串', () => {
    const cfg = config()
    // z=2 的世界有 4 列：x=-1 与 x=3 是同一列。
    assert.equal(tileUrl(cfg, 2, -1, 1), tileUrl(cfg, 2, 3, 1))
    assert.equal(tileUrl(cfg, 2, 1, -1), '')
    assert.equal(tileUrl(cfg, 2, 1, 4), '')
    // 缩放超界不拼 URL（渲染层会先夹）。
    assert.equal(tileUrl(cfg, 19, 1, 1), '')
    assert.equal(tileUrl(cfg, 1, 1, 1), '')
  })
})

describe('缩放 2–18', () => {
  it('常量就是 2 与 18，夹取与判定只走两个纯函数', () => {
    assert.equal(MIN_TILE_ZOOM, 2)
    assert.equal(MAX_TILE_ZOOM, 18)
    assert.equal(clampTileZoom(0), 2)
    assert.equal(clampTileZoom(1.4), 2)
    assert.equal(clampTileZoom(4.6), 5)
    assert.equal(clampTileZoom(18), 18)
    assert.equal(clampTileZoom(99), 18)
    assert.equal(clampTileZoom(Number.NaN), 2)
    assert.equal(isTileZoom(2), true)
    assert.equal(isTileZoom(18), true)
    assert.equal(isTileZoom(1), false)
    assert.equal(isTileZoom(19), false)
    assert.equal(isTileZoom(3.5), false)
  })

  it('视图铺瓦片时会把超界缩放夹回 2–18（URL 里的 z 也只在这段内）', () => {
    const cfg = config()
    const tiles = viewTiles(cfg, { latitude: 31.23, longitude: 121.47, zoom: 99 }, 99, 1280, 720)
    assert.ok(tiles.length > 0)
    assert.ok(tiles.every((tile) => tile.z === 18))
    assert.ok(tiles.every((tile) => tile.url.includes('/18/')))
  })
})

describe('时区→中心（手册未说明：这张表是本软件自己定的）', () => {
  it('中国四个时区名都落在对应的大致区域，缩放都在 2–18', () => {
    for (const zone of ['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Harbin', 'Asia/Urumqi']) {
      const center = timeZoneCenter(zone)
      assert.ok(center.latitude > 20 && center.latitude < 50, zone)
      assert.ok(center.longitude > 70 && center.longitude < 135, zone)
      assert.ok(center.zoom >= MIN_TILE_ZOOM && center.zoom <= MAX_TILE_ZOOM, zone)
    }
  })

  it('常见国际时区命中具体城市，不认识的落到世界中心缩放 2', () => {
    assert.ok(Math.abs(timeZoneCenter('Europe/London').latitude - 54) < 0.01)
    assert.ok(Math.abs(timeZoneCenter('America/New_York').longitude - -74.006) < 0.01)
    assert.deepEqual(timeZoneCenter('Mars/Olympus'), { latitude: 0, longitude: 0, zoom: 2 })
    assert.deepEqual(timeZoneCenter(undefined), { latitude: 0, longitude: 0, zoom: 2 })
  })

  it('大小写、空格与下划线都能识别', () => {
    assert.deepEqual(timeZoneCenter('asia/shanghai'), timeZoneCenter('Asia/Shanghai'))
    assert.deepEqual(timeZoneCenter(' America/New York '), timeZoneCenter('America/New_York'))
  })

  it('所有查得到的结果都在合法缩放区间内', () => {
    for (const zone of ['UTC', 'Etc/UTC', 'Asia/Tokyo', 'Asia/Ho_Chi_Minh', 'Europe/Kyiv', 'America/Argentina/Buenos_Aires', 'Africa/Nairobi', 'Australia/Brisbane', 'Pacific/Fiji', 'Australia/Sydney', 'Africa/Cairo', 'Pacific/Auckland']) {
      const center = timeZoneCenter(zone)
      assert.ok(isTileZoom(center.zoom), zone + ' 的缩放不合法：' + center.zoom)
    }
  })
})

describe('Web Mercator：中心、落点与拖拽', () => {
  it('(0,0) 在 z=2 的世界中心；北纬的 y 更小', () => {
    assert.equal(lonToWorldX(0, 2), 512)
    assert.equal(latToWorldY(0, 2), 512)
    assert.ok(latToWorldY(45, 3) < latToWorldY(0, 3))
  })

  it('projectToViewport 把中心点放在画布正中', () => {
    const center = { latitude: 31.23, longitude: 121.47, zoom: 6 }
    const point = projectToViewport(center, center.latitude, center.longitude, 1280, 720)
    assert.ok(Math.abs(point.x - 640) < 0.001)
    assert.ok(Math.abs(point.y - 360) < 0.001)
  })

  it('panMapCenter 把像素位移换成新的中心，并且在两极处不会翻过去', () => {
    const center = { latitude: 31.23, longitude: 121.47, zoom: 6 }
    const moved = panMapCenter(center, 100, 0)
    assert.ok(moved.longitude < center.longitude, '向右拖应该把视野往西移')
    assert.equal(moved.zoom, center.zoom)
    const clamped = panMapCenter({ latitude: 84, longitude: 0, zoom: 6 }, 0, -100000)
    assert.ok(clamped.latitude <= 85.06)
  })

  it('viewTiles 用 https URL 且 left/top 能铺满视口', () => {
    const cfg = config()
    const center = { latitude: 31.23, longitude: 121.47, zoom: 8 }
    const tiles = viewTiles(cfg, center, 8, 1280, 720)
    assert.ok(tiles.length > 0)
    for (const tile of tiles) {
      assert.ok(tile.url.startsWith('https://'), tile.url)
      assert.ok(tile.left < 1280 && tile.left + 256 > 0, '瓦片没有覆盖水平视口')
      assert.ok(tile.top < 720 && tile.top + 256 > 0, '瓦片没有覆盖垂直视口')
      assert.equal(tile.z, 8)
    }
  })
})

describe('地图设置落库：合法写入、坏值整键拒绝、恢复默认关掉', () => {
  function freshSettings(): SettingsService {
    const db = openDatabase({ file: ':memory:' })
    return new SettingsService({ db, defaultStorageRoot: 'C:\\hz-test-storage' })
  }

  it('写入合法配置能读回；写入 http 模板会被拒绝且不落库', () => {
    const settings = freshSettings()
    assert.equal(settings.get().mapTiles.enabled, false)
    const result = settings.update({ mapTiles: OSM })
    assert.deepEqual(result.rejected, [])
    assert.equal(settings.get().mapTiles.enabled, true)
    assert.equal(settings.get().mapTiles.urlTemplate, OSM.urlTemplate)

    const bad = settings.update({
      mapTiles: { ...OSM, urlTemplate: 'http://example.com/{z}/{x}/{y}.png' }
    })
    assert.deepEqual(bad.rejected, ['mapTiles'])
    assert.equal(settings.get().mapTiles.urlTemplate, OSM.urlTemplate, '坏值不应覆盖旧值')
  })

  it('恢复默认把底图关掉（两项都在可恢复清单里）', () => {
    const settings = freshSettings()
    settings.update({ mapTiles: OSM })
    const { settings: restored, rejected } = settings.restoreDefaults()
    assert.deepEqual(rejected, [])
    assert.equal(restored.mapTiles.enabled, false)
    assert.equal(restored.mapTiles.urlTemplate, '')
    assert.ok((RESTORABLE_SETTING_KEYS as readonly string[]).includes('mapTiles'))
  })
})

describe('界面与四语言守卫', () => {
  const settingsView = read('src/renderer/src/views/SettingsView.vue')
  const mapView = read('src/renderer/src/views/DeviceMapView.vue')
  const shell = read('src/renderer/index.html')

  it('设置页有「地图」页签、全球供应商预置、XYZ/可选 key/署名与授权边界', () => {
    assert.match(settingsView, /id: 'map', labelKey: 'settingsUi\.tabMap'/)
    for (const id of ['osm', 'opentopomap', 'carto', 'esri', 'maptiler', 'mapbox', 'tomtom', 'stadia', 'tianditu', 'custom']) {
      assert.ok(settingsView.includes("id: '" + id + "'"), id)
    }
    for (const key of [
      'mapBoundaryOsm',
      'mapBoundaryOpentopomap',
      'mapBoundaryCarto',
      'mapBoundaryEsri',
      'mapBoundaryKeyProvider',
      'mapBoundaryTianditu',
      'mapBoundaryCustom'
    ]) {
      assert.ok(settingsView.includes(key), key)
    }
    for (const hook of [
      'data-settings-map-enabled',
      'data-settings-map-url',
      'data-settings-map-key',
      'data-settings-map-attribution',
      'data-settings-map-timezone'
    ]) {
      assert.ok(settingsView.includes(hook), hook)
    }
    assert.match(settingsView, /mapTiles: \{/, '补丁里没有 mapTiles')
    assert.match(settingsView, /mapTilesProblem\(/, '设置页没有用共享校验')
  })

  it('地图页只在开关打开时渲染瓦片，并提供缩放/署名钩子', () => {
    assert.match(mapView, /v-if="tileConfig"[\s\S]{0,120}data-map-tiles/, '瓦片层没有开关')
    for (const hook of [
      'data-map-tile',
      'data-map-zoom-in',
      'data-map-zoom-out',
      'data-map-zoom-level',
      'data-map-attribution',
      'data-map-tiles-enabled',
      'data-map-timezone',
      'data-map-center'
    ]) {
      assert.ok(mapView.includes(hook), hook)
    }
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'new WebSocket']) {
      assert.equal(mapView.includes(forbidden), false, forbidden)
    }
    assert.ok(/connect-src 'none'/.test(shell), 'connect-src 不再是 none')
    assert.ok(/img-src[^;]*https:/.test(shell), 'https 图片没有放行')
  })

  it('四语言的地图设置键齐全：预置、授权边界、模板、key、时区与全部错误', () => {
    const catalogues: Record<string, Record<string, unknown>> = {
      'zh-CN': zhCN.settingsUi as unknown as Record<string, unknown>,
      en: en.settingsUi as unknown as Record<string, unknown>,
      es: es.settingsUi as unknown as Record<string, unknown>,
      tr: tr.settingsUi as unknown as Record<string, unknown>
    }
    const keys = [
      'tabMap',
      'mapGroupService',
      'mapEnable',
      'mapEnableHint',
      'mapPresetsLabel',
      'mapPresetsHint',
      'mapPresetOsm',
      'mapPresetCarto',
      'mapPresetTianditu',
      'mapPresetCustom',
      'mapPresetOpentopomap',
      'mapPresetEsri',
      'mapPresetMaptiler',
      'mapPresetMapbox',
      'mapPresetTomtom',
      'mapPresetStadia',
      'mapBoundaryOsm',
      'mapBoundaryCarto',
      'mapBoundaryTianditu',
      'mapBoundaryCustom',
      'mapBoundaryOpentopomap',
      'mapBoundaryEsri',
      'mapBoundaryKeyProvider',
      'mapGroupTemplate',
      'mapUrlTemplate',
      'mapUrlHint',
      'mapKey',
      'mapKeyHint',
      'mapAttribution',
      'mapAttributionHint',
      'mapTimezone',
      'mapTimezoneValue',
      'mapTimezoneHint',
      'mapErrTemplateRequired',
      'mapErrTemplateProtocol',
      'mapErrTemplateTokens',
      'mapErrTemplateTokenUnknown',
      'mapErrTemplateInvalid',
      'mapErrKeyRequired',
      'mapErrKeyInvalid',
      'mapErrAttributionRequired',
      'restoreItemMapTiles'
    ]
    for (const locale of LOCALES) {
      const catalogue = catalogues[locale]
      assert.ok(catalogue, locale)
      for (const key of keys) {
        const entryText: unknown = catalogue ? catalogue[key] : undefined
        assert.equal(typeof entryText, 'string', locale + ' 缺 settingsUi.' + key)
        assert.ok(String(entryText).trim().length > 0, locale + ' 的 ' + key + ' 是空的')
      }
    }
    // 授权边界必须真的说清边界，不能只是一句"免费"。
    assert.match(String(catalogues['zh-CN']?.mapBoundaryOsm), /署名|Tile Usage Policy|默认/)
    assert.match(String(catalogues['zh-CN']?.mapBoundaryCarto), /商用|高流量|待确认|确认/)
    assert.match(String(catalogues['zh-CN']?.mapBoundaryTianditu), /key|配额|授权/)
    assert.match(String(catalogues['zh-CN']?.mapBoundaryOpentopomap), /署名|CC-BY-SA|默认/)
    assert.match(String(catalogues['zh-CN']?.mapBoundaryKeyProvider), /key|授权|条款|申请/)
    assert.match(String(catalogues['zh-CN']?.mapBoundaryEsri), /Esri|待确认|确认/)
    for (const locale of ['en', 'es', 'tr']) {
      assert.notEqual(
        catalogues[locale]?.mapBoundaryOsm,
        catalogues['zh-CN']?.mapBoundaryOsm,
        locale + ' 的 OSM 授权边界照抄了中文'
      )
    }
  })

  it('地图页的缩放/署名/失败提示四语言齐全', () => {
    const groups: Array<Record<string, unknown>> = [
      zhCN.mapUi as unknown as Record<string, unknown>,
      en.mapUi as unknown as Record<string, unknown>,
      es.mapUi as unknown as Record<string, unknown>,
      tr.mapUi as unknown as Record<string, unknown>
    ]
    for (const group of groups) {
      for (const key of ['zoomIn', 'zoomOut', 'zoomReset', 'zoomLevel', 'tilesError']) {
        assert.equal(typeof group[key], 'string', key)
        assert.ok(String(group[key]).trim().length > 0, key)
      }
    }
  })

  it('预置模板全部是 https、都有非空署名；带 key 的服务标注了需自行申请', () => {
    for (const preset of Object.values(MAP_TILE_PRESETS)) {
      assert.ok(preset.urlTemplate.startsWith('https://'), preset.urlTemplate)
      assert.ok(preset.attribution.trim().length > 0)
      assert.equal(mapTilesProblem({ ...OSM, service: 'custom', urlTemplate: preset.urlTemplate, apiKey: 'test-key' }), null)
    }
    assert.equal(MAP_TILE_PRESETS.tianditu.keyRequired, true)
    assert.equal(MAP_TILE_PRESETS.osm.keyRequired, false)
    assert.equal(MAP_TILE_PRESETS.opentopomap.keyRequired, false)
    assert.equal(MAP_TILE_PRESETS.carto.keyRequired, false)
    assert.equal(MAP_TILE_PRESETS.esri.keyRequired, false)
    assert.equal(MAP_TILE_PRESETS.maptiler.keyRequired, true)
    assert.equal(MAP_TILE_PRESETS.mapbox.keyRequired, true)
    assert.equal(MAP_TILE_PRESETS.tomtom.keyRequired, true)
    assert.equal(MAP_TILE_PRESETS.stadia.keyRequired, true)
    assert.ok(MAP_TILE_PRESETS.opentopomap.urlTemplate.includes('{s}'))
    assert.ok(MAP_TILE_PRESETS.esri.urlTemplate.includes('{z}/{y}/{x}'))
  })
})