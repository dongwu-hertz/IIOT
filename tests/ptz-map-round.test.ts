/**
 * 第 8 批（球机联动 PTZ 配置页 + 离线点位图 + 告警抓图）的界面与目录守卫。
 *
 * WHY THIS FILE EXISTS
 * 这一批有两处"改错了不会报错"的地方，只有钉住源码结构才能提前拦住：
 *
 *   1. **空气声呐的页签只剩一个 PTZ**。留着 2023 版那一组（工作模式/阈值参数/告警同步），
 *      界面就在承诺一些这一代产品不回答的东西 —— 而那些页签点开会**显示"读不到"**，
 *      看起来像设备坏了。判据必须是**设备自己说的代次**，不是型号名、也不是用户的选择。
 *   2. **图上不联网**。渲染层按设计不能联网（CSP `connect-src 'none'`），而"地图"这个词
 *      本身会诱导下一个人加一个瓦片请求 —— 那在机房（无外网）里表现为一张空白图。
 *      所以这里同时钉：视图里没有 `fetch`/`XHR`、瓦片地址一律不出现、底图由
 *      `shared/domain/device-map.ts` 的纯函数画。
 *
 * 抓图那三种状态也是源码守卫：`not-captured`（设备上本来没有）与 `files-gone`（本机文件
 * 不在了）合成一句"没有图"是这一块最容易犯的错，而它会让操作员去查同步。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

function templateBlock(source: string): string {
  const open = source.indexOf('<template>')
  const close = source.lastIndexOf('</template>')
  return open >= 0 && close > open ? source.slice(open, close) : ''
}

const CATALOGUES: Record<string, unknown> = { 'zh-CN': zhCN, en, es, tr }

function messageAt(locale: string, key: string): string | undefined {
  let cursor: unknown = CATALOGUES[locale]
  for (const part of key.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return typeof cursor === 'string' ? cursor : undefined
}

const detailView = read('src/renderer/src/views/DeviceDetailView.vue')
const detailTemplate = stripComments(templateBlock(detailView))
const ptzPanel = read('src/renderer/src/components/AirSonarPtzPanel.vue')
const mapView = read('src/renderer/src/views/DeviceMapView.vue')
const mapFull = stripComments(mapView)
const mapTemplate = templateBlock(mapView)
const mapCode = stripComments(mapTemplate)
const router = read('src/renderer/src/router/index.ts')
const sidebar = read('src/renderer/src/components/AppSidebar.vue')
const shell = read('src/renderer/index.html')

describe('空气声呐：配置页只留一个 PTZ 页签', () => {
  it('代次决定页签：`airSonar` ⇒ 只有 ptz', () => {
    assert.ok(
      /const AIR_SONAR_TABS: ReadonlyArray<TabId> = \['ptz'\]/.test(detailView),
      '空气声呐那一组页签不是"只有 ptz"：' + detailView.match(/AIR_SONAR_TABS[^\n]*/)?.[0]
    )
    assert.ok(
      /device\.value\?\.e2Variant === 'airSonar'/.test(detailView),
      '页签不是按设备自己说的代次选的（那样会按型号名猜）'
    )
  })

  it('2023 版听诊盒子那一组页签**没有被顺手删掉**（两代产品两套页签）', () => {
    assert.ok(
      /const AUSCULTATION_TABS: ReadonlyArray<TabId> = \['overview', 'auscultation', 'maintenance'\]/.test(
        detailView
      ),
      '2023 版那一组页签被改掉了 —— 那一代仍然要用它'
    )
  })

  it('切页签的兜底是"这一组的第一页"，不是恒定的概览（空气声呐没有概览页）', () => {
    assert.ok(
      /activeTab\.value = visibleTabs\.value\[0\]\?\.id \?\? 'overview'/.test(detailView),
      '兜底仍然指向 overview：空气声呐那一组里没有它，页面会空白'
    )
  })

  it('PTZ 那一页顶部保留设备身份与安装点位（否则没法判断配置对不对）', () => {
    const block = detailTemplate.slice(detailTemplate.indexOf("activeTab === 'ptz'"))
    assert.ok(block.includes('DeviceInstallationCard'), 'PTZ 页里没有安装点位卡片')
    assert.ok(block.includes('<AirSonarPtzPanel'), 'PTZ 页里没有配置面板')
    assert.ok(block.includes("t('deviceDetailUi.firmware')"), 'PTZ 页里没有固件版本（身份）')
  })

  it('代次读不到时只做一次只读探测，不把详情页做成错误页', () => {
    assert.ok(
      /async function resolveE2Variant\(\)/.test(detailView),
      '没有"补读代次"这一步：老库里的行永远只会显示 2023 版那一组页签'
    )
    const body = detailView.slice(detailView.indexOf('async function resolveE2Variant'))
    assert.ok(body.includes('if (!result.success) return'), '补读失败时把整页弄成了错误态')
  })
})

describe('PTZ 面板：只有保存才写设备，写完按读回结果说话', () => {
  it('写设备只发生在保存与对时这两个动作里（输入框不自动写）', () => {
    const writers = [...ptzPanel.matchAll(/window\.api\.e2\.(updatePtz|syncNvtTime|ptz)\(/g)].map(
      (match) => match[1]
    )
    assert.deepEqual(writers, ['ptz', 'updatePtz', 'syncNvtTime'], '读/写通道与预期不符')
    assert.equal(
      /watch\([^)]*window\.api\.e2\.updatePtz/.test(ptzPanel),
      false,
      '输入框变化就会写设备 —— PTZ 是现场调试动作，绝不能边打字边写'
    )
  })

  it('用**共享的**范围判据（界面与主进程同一套）', () => {
    assert.ok(ptzPanel.includes('validatePtzPatch'), '界面没有用共享的范围判据')
    assert.ok(/import \{[^}]*validatePtzPatch[^}]*\} from '@shared\/domain\/e2-ptz'/.test(ptzPanel))
  })

  it('保存之后显示**读回核对**的逐项结果（含"应为…设备现为…"）', () => {
    assert.ok(ptzPanel.includes('data-ptz-checks'), '没有读回核对那一块')
    assert.ok(ptzPanel.includes("t('ptzUi.expectedActual'"), '没写出"我要的值 vs 设备的值"')
    assert.ok(
      ptzPanel.includes('config.value = outcome.readBack'),
      '保存之后界面没有刷新成设备现在的值（显示的是我们请求的那一份）'
    )
  })

  it('口令**只写不读**：界面从不渲染口令内容', () => {
    assert.equal(
      /t\('ptzUi\.fieldCameraPassword'\)[\s\S]{0,400}\{\{\s*config\.cameraPassword/.test(ptzPanel),
      false,
      '口令内容被渲染到了界面上'
    )
    assert.ok(
      ptzPanel.includes("t('ptzUi.passwordSet')") && ptzPanel.includes("t('ptzUi.passwordUnset')"),
      '口令状态那两句话不见了'
    )
    assert.ok(
      ptzPanel.includes("t('ptzUi.passwordNotCompared')"),
      '写了新口令之后没有说明"内容未比对"'
    )
  })

  it('对时那一段明说"手册未说明请求体"（我们不假装知道它做了什么）', () => {
    assert.ok(ptzPanel.includes('data-ptz-nvt-time'), '对时结果没有显示')
    for (const locale of Object.keys(CATALOGUES)) {
      const message = messageAt(locale, 'ptzUi.timeSyncAccepted')
      assert.ok(message && /未说明|not document|no documenta|yazmıyor/.test(message), `${locale}: ${message}`)
    }
  })

  it('球机是否已初始化只读（没有把它放进可提交的补丁里）', () => {
    const patchBody = ptzPanel.slice(ptzPanel.indexOf('function buildPatch'))
    assert.equal(
      /cameraInitialised\s*:/.test(patchBody.slice(0, patchBody.indexOf('return'))),
      false,
      '把"球机已初始化"当成设置项写回设备了'
    )
  })
})

describe('点位图：不联网、点声呐看抓图', () => {
  it('视图里没有任何联网取图的手段（CSP 也仍然是 connect-src none）', () => {
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'new WebSocket', 'tile.openstreetmap', 'amap.com', 'map.baidu']) {
      assert.equal(mapView.includes(forbidden), false, `点位图里出现了联网/瓦片相关的代码：${forbidden}`)
    }
    assert.ok(/connect-src 'none'/.test(shell), 'CSP 的 connect-src 不再是 none')
    assert.ok(
      /img-src[^;]*http:\/\/127\.0\.0\.1:\*/.test(shell),
      '抓图的回环地址没有被 img-src 放行（图片会被 CSP 拦掉）'
    )
  })

  it('底图用共享的投影纯函数画（没有第二份坐标算式）', () => {
    assert.ok(mapView.includes('deviceMapLayout('), '没有用共享的落点布局')
    assert.ok(
      mapView.includes('mapProjector('),
      '网格线没有用共享的投影器 —— 两处算式迟早会错位'
    )
    assert.equal(
      /Math\.cos\(/.test(mapView),
      false,
      '视图里自己算了一遍 cos(纬度)（那是投影器的职责）'
    )
  })

  it('没点位的设备**不再单独列一张卡**（业主 2026-09-19 第 11 批第 5 条点名删除）', () => {
    /*
     * 第 8 批时它们是单独一块（`data-map-without-point`），理由是"混进图里会被读成落点在这里"。
     * 第 11 批第 5 条把那一块删了（「未录入点位设备这个卡片内容删除」），而它们并没有消失：
     * **设备列表是设备表的全部**（不是"图上的那几台"），所以没录点位的设备照样在列表里，
     * 状态栏那两个数（图上 N 台 / 共 M 台）之差就说明有几台没录。
     */
    assert.equal(
      mapTemplate.includes('data-map-without-point'),
      false,
      '「未录入点位」那张卡又回来了（第 5 条已删）'
    )
    assert.equal(
      mapCode.includes('layout.withoutPoint'),
      false,
      '视图还在读 withoutPoint（那一块已经不在模板里了）'
    )
    // 设备列表遍历的是**全部设备**，不是图上那几个落点。
    assert.match(
      mapCode,
      /v-for="\(device, index\) in pagedDevices"/,
      '设备列表不是从设备表（分页后）来的'
    )
    assert.match(mapFull, /listPageSlice\(devices\.devices, devicePage\.value/, '分页的输入不是设备表')
  })

  it('抓图三种状态分别渲染（有图 / 设备上本来没有 / 文件已不在）', () => {
    assert.ok(mapTemplate.includes('data-snapshot-not-captured'), '缺"设备上本来就没有抓图"那一句')
    assert.ok(mapTemplate.includes('data-snapshot-files-gone'), '缺"文件已不在本机"那一句')
    assert.ok(mapTemplate.includes('map-snapshots__grid'), '有图时没有渲染图片')
  })

  it('这一页有同步入口（抓图要在同步时才下得下来）', () => {
    assert.ok(mapTemplate.includes('data-action="map-sync"'), '点位图上没有同步按钮')
    assert.ok(
      /downloadSpectrograms: true/.test(mapView),
      '同步时没有打开抓图下载 —— 那这一页永远没有图可看'
    )
  })

  it('路由与侧栏都有它（`/map`；导航里在**设备管理之前、总览之后**）', () => {
    assert.ok(/path: '\/map'/.test(router), '路由里没有 /map')
    assert.ok(/titleKey: 'app\.nav\.map'/.test(router), '/map 没有标题键')
    // 侧栏那一条是多行写法，所以按 `path:` 找（`indexOf("{ path: …")` 会漏）。
    // 顺序是业主 2026-09-18 第 10 批第 12 条给的：「移到设备管理上方、总览下方」。
    const navIndex = sidebar.indexOf("path: '/map'")
    const devicesIndex = sidebar.indexOf("path: '/devices'")
    const overviewIndex = sidebar.indexOf("path: '/'")
    assert.ok(navIndex > 0, '侧栏里没有地图信息入口')
    assert.ok(
      overviewIndex < navIndex && navIndex < devicesIndex,
      '侧栏顺序不是"总览 → 地图信息（GIS） → 设备管理"'
    )
    // 路由表也按同一条顺序排（`/devices/:id` 不能插在两者之间，否则读代码的人会以为顺序反了）。
    const routeOverview = router.indexOf("path: '/'")
    const routeMap = router.indexOf("path: '/map'")
    const routeDevices = router.indexOf("path: '/devices'")
    assert.ok(
      routeOverview < routeMap && routeMap < routeDevices,
      '路由表里的 /map 不在 / 与 /devices 之间'
    )
  })

  it('页面名只在顶栏那一处：页内不再有标题，名字改挂在 `<section>` 的无障碍属性上', () => {
    /*
     * 更正第 2 条（2026-09-19）：「地图信息出现了两个标题，可以把第一个删除掉」——
     * 删掉的是**页内**那一个 `<h3 class="section-title">`，因为外层框架的标题栏
     * 已经写了页面名（这也是全应用从 2026-09-16 起就有的口径：页面内不再画标题）。
     * 名字没有丢：它成了这一块 `<section>` 的 `aria-label`，否则读屏走到这里只剩一串数字。
     */
    assert.equal(
      /<h3[^>]*class="section-title"[^>]*>\{\{\s*t\('app\.nav\.map'\)/.test(mapTemplate),
      false,
      '页内又画了一个写着页面名的标题（与顶栏重复）'
    )
    assert.ok(
      mapTemplate.includes('data-map-panel') &&
        /data-map-panel[^>]*:aria-label="t\('app\.nav\.map'\)"/.test(mapTemplate),
      '地图区没有用页面名当无障碍名字（删了标题之后这一块就没名字了）'
    )
    assert.equal(
      /mapUi\.mapTitle/.test(mapView),
      false,
      '视图里还引用着已被换掉的 mapUi.mapTitle'
    )
    // 画布的无障碍名说的是**画的是什么**，不是页面叫什么。
    assert.ok(mapTemplate.includes("t('mapUi.canvasLabel')"), '画布没有无障碍名')
  })

  it('离开这一页会关掉抓图端点（不让端口挂到 TTL 到点）', () => {
    assert.ok(/onUnmounted\(\(\) => \{\s*void closeSnapshots\(\)/.test(mapView), '离开页面没有关端点')
  })

  it('四种语言的地图文案齐全，而且名字**不带括号与 GIS**', () => {
    for (const locale of Object.keys(CATALOGUES)) {
      for (const key of [
        'app.nav.map',
        'mapUi.canvasLabel',
        // 状态栏那五个读数（第 11 批第 4 条）—— 它们顶掉了被删掉的 `mapUi.counts`。
        'mapUi.statusLabel',
        'mapUi.statusMapped',
        'mapUi.statusTotal',
        'mapUi.statusOnline',
        'mapUi.statusOffline',
        'mapUi.statusAlarms',
        'mapUi.snapshotNotCaptured'
      ]) {
        assert.ok(messageAt(locale, key), `${locale} 缺 ${key}`)
      }
      // 被业主点名删掉的三句必须**从目录里也删掉**（留着就是死键）。
      for (const key of ['mapUi.counts', 'mapUi.noPoints', 'mapUi.withoutPointTitle', 'mapUi.withoutPointHint']) {
        assert.equal(messageAt(locale, key), undefined, `${locale} 还留着已删掉的 ${key}`)
      }
    }
    /*
     * 名字改过两次，两次都是业主给的：
     *   ① 第 12 条（2026-09-18）：「点位图」→「地图信息（GIS）」；
     *   ② 更正第 1 条（2026-09-19）：**把括号和 GIS 去掉**。
     * 所以现在四种语言里都不该再有那对括号。
     */
    for (const locale of Object.keys(CATALOGUES)) {
      const name = String(messageAt(locale, 'app.nav.map'))
      assert.equal(/（GIS）|\(GIS\)/.test(name), false, `${locale} 的名字里还带着 GIS 括号：${name}`)
      assert.equal(/[（(]/.test(name), false, `${locale} 的名字里还有括号：${name}`)
    }
    assert.equal(String(messageAt('zh-CN', 'app.nav.map')), '地图信息', '中文名不是更正第 1 条给的那一个')
    // 点位图不能把"没有点位"写成"地图加载失败"：那不是网络问题。
    // （那句文案本身已按第 11 批第 4 条删掉，所以这条守的是**状态栏**那些读数。）
    assert.equal(
      /加载失败|loading failed/i.test(String(messageAt('zh-CN', 'mapUi.statusMapped'))),
      false
    )
  })
})

// ---------------------------------------------------------------------------
// 第 10 批第 13/14/17 条：版面、落点配色、地图下方三张列表
// ---------------------------------------------------------------------------

describe('地图信息（GIS）：16:9 占满宽度的地图区（第 13 条）', () => {
  it('画布是 16:9，而且外层那一层也按 16:9 定高', () => {
    // 两边比例必须一致：不一致时 SVG 会按 `preserveAspectRatio` 留白，
    // 图上就出现两条看不懂的边（而"看起来没问题"）。
    const canvas = /const CANVAS = \{ width: (\d+), height: (\d+) \}/.exec(mapView)
    assert.ok(canvas, '没有找到 CANVAS 常量')
    const [, width, height] = canvas
    assert.equal(
      Number(width) / Number(height),
      16 / 9,
      `画布不是 16:9：${width}×${height}`
    )
    assert.match(
      mapView,
      /\.map-canvas-frame \{[\s\S]*?width: 100%;[\s\S]*?aspect-ratio: 16 \/ 9;/,
      '定比例的那一层不是"占满宽度 + 16:9"'
    )
  })

  it('地图区**没有** max-height（加了它就不再是 16:9）', () => {
    const block = mapView.slice(mapView.indexOf('.map-canvas-frame {'))
    const body = block.slice(0, block.indexOf('}'))
    assert.equal(/max-height/.test(body), false, `地图区加了高度上限，比例会被破坏：${body}`)
  })

  it('地图区不是卡片：`.card` 的左右内边距会让"占满宽度"只是近似', () => {
    const panel = mapTemplate.slice(mapTemplate.indexOf('data-map-panel'))
    const tag = panel.slice(0, panel.indexOf('>'))
    assert.equal(/class="[^"]*\bcard\b/.test(tag), false, `地图区又套上了卡片：${tag.trim()}`)
  })

  it('网格线与落点用同一个 padding（两个数不一致会让网格与点错位）', () => {
    assert.match(mapView, /MAP_PADDING = (\d+)/, '没有统一的那一个留白常量')
    assert.match(
      mapView,
      /deviceMapLayout\(mapInputs\.value, CANVAS\.width, CANVAS\.height, MAP_PADDING\)/,
      '落点布局没有用统一留白'
    )
    assert.match(
      mapView,
      /mapProjector\(bounds, CANVAS\.width, CANVAS\.height, MAP_PADDING\)/,
      '投影器没有用统一留白 —— 网格会与落点错位'
    )
  })
})

describe('落点配色：在线绿 / 告警红 / 离线灰（第 14 条）', () => {
  it('三种色调各有一条 CSS 规则，而且用的是既有的语义色', () => {
    for (const [tone, token] of [
      ['online', '--color-success'],
      ['alarm', '--color-danger'],
      ['offline', '--color-text-tertiary']
    ]) {
      assert.match(
        mapView,
        new RegExp(`\\.map-marker--${tone} \\.map-marker__dot \\{[\\s\\S]*?${token}`),
        `落点缺少 ${tone} 那一档，或它没有用 ${token}`
      )
    }
    // 颜色值不许在组件里现写（这个仓库只有 assets/main.css 写颜色）。
    assert.equal(
      /#[0-9a-fA-F]{3,8}\b/.test(mapTemplate),
      false,
      '模板里出现了硬编码颜色'
    )
  })

  it('色调的判据是**未确认告警 > 在线 > 离线**，并且 UNKNOWN 不算在线', () => {
    // 判据只能有一处：`markerTone()`。
    assert.match(
      mapView,
      /function markerTone\(device: Device\): 'alarm' \| 'online' \| 'offline' \{[\s\S]*?facts\.pending > 0[\s\S]*?device\.status === 'ONLINE'/,
      'markerTone 的优先级不是"未确认告警 > 在线 > 离线"'
    )
    // 读不到告警数时不能整张图变红：`-1` 是"没读到"，不是"有告警"。
    assert.equal(
      /facts\.pending >= 0|facts\.pending !== -1/.test(mapView),
      false,
      'markerTone 里出现了把 -1 当告警的写法'
    )
  })

  it('颜色不单独承载信息：色点仍带一句说明，*计数*搬进了右上角状态栏', () => {
    /*
     * 第 10 批第 14 条要的是"图例三档各带一个数"；第 11 批第 4 条把**图例连同计数一起删了**
     * （「有未确认告警0在线0离线0」），改在地图右上角放一条半透明状态栏。
     * 所以颜色现在有两处出口，都带着文字或数字：
     *   · 地图上的落点（悬停浮层里写这一台的名字、状态、告警条数）；
     *   · 实时数据列表每行前面那个色点，`title` 是 `mapUi.legendAlarm`（「有未确认告警」）。
     * 设备列表按第 5 条只留 序号/名称/状态，那里不再放色点 —— 于是 `markerTone(device)`
     * 全页只剩**一处**（实时数据列表）。
     */
    assert.equal(mapTemplate.includes('data-map-legend'), false, '图例又回来了（第 4 条已删）')
    assert.match(
      mapTemplate,
      /class="map-table__tone" :class="`map-table__tone--\$\{markerTone\(device\)\}`"[\s\S]{0,120}:title="t\('mapUi\.legendAlarm'\)"/,
      '实时数据列表里的色点没有带那句说明'
    )
    // 列表里的色点与图上的落点用同一个 `markerTone()`：两处各判一次迟早不一致。
    assert.equal(
      (mapTemplate.match(/markerTone\(device\)/g) ?? []).length,
      1,
      '色点不止一处（或一处都没有）：设备列表按第 5 条已经不放色点了'
    )
    // 三个数在状态栏上：图上 / 共 / 在线 / 离线。
    for (const hook of [
      'data-map-status-mapped',
      'data-map-status-total',
      'data-map-status-online',
      'data-map-status-offline',
      'data-map-status-alarms'
    ]) {
      assert.ok(mapTemplate.includes(hook), `状态栏缺少 ${hook}`)
    }
  })
})

describe('地图下方依次三张列表（第 17 条）', () => {
  it('顺序是 设备列表 → 告警列表 → 实时数据列表，而且都在地图区之后', () => {
    const panel = mapTemplate.indexOf('data-map-panel')
    const devicesList = mapTemplate.indexOf('data-map-devices')
    const alarmsList = mapTemplate.indexOf('data-map-alarms')
    const liveList = mapTemplate.indexOf('data-map-live')
    assert.ok(panel >= 0 && devicesList >= 0 && alarmsList >= 0 && liveList >= 0, '三张列表没有齐')
    assert.ok(
      panel < devicesList && devicesList < alarmsList && alarmsList < liveList,
      '三张列表的顺序或位置不对（应为：地图区 → 设备列表 → 告警列表 → 实时数据列表）'
    )
  })

  it('实时数据列表的列是 分贝 / 稳定度 / 方位', () => {
    const block = mapTemplate.slice(mapTemplate.indexOf('data-map-live'))
    for (const key of ['mapUi.colDb', 'mapUi.colStability', 'mapUi.colAzimuth']) {
      assert.ok(block.includes(key), `实时数据列表缺少 ${key} 这一列`)
    }
  })

  it('「平稳度」那一列**有数据源**了：取最近一条告警上报的 smoothness（业主 2026-09-19 澄清）', () => {
    /*
     * 这一条原来是「恒为 — + 写明没有数据源」。业主 2026-09-19 说「用**平稳度**表示」之后，
     * 他说的「稳定度」就是本仓库的 `smoothness` —— 一个有真实来源的测量值。
     * 所以断言**翻了过来**：不许再有"恒为 —"的写法，而且必须真的去读那个值。
     */
    const block = mapTemplate.slice(mapTemplate.indexOf('data-map-live'))
    assert.equal(
      /stabilityNoSourceHint/.test(mapView),
      false,
      '「没有数据源」那段说明还在（业主已澄清这一列取 smoothness）'
    )
    assert.ok(block.includes('data-live-smoothness'), '平稳度那一格没有稳定的探针钩子')
    assert.match(
      mapView,
      /function liveSmoothness\([\s\S]*?facts\.latestSmoothness/,
      '平稳度不是取最近一条告警的 smoothness'
    )
    assert.match(
      mapView,
      /latest\?\.smoothness !== undefined\) facts\.latestSmoothness = latest\.smoothness/,
      'facts 里没有把 smoothness 从最近一条告警里取出来'
    )
    // 与分贝**同源同刻**：两个字段都从同一条 `latest` 上取。
    assert.match(
      mapView,
      /facts\.latestSpl = latest\.spl[\s\S]{0,200}facts\.latestSmoothness = latest\.smoothness/,
      '分贝与平稳度不是从同一条告警上取的（两列会对不上同一时刻）'
    )
    // 读不到与"没有"必须分得开（与分贝那一列同一条口径）。
    assert.match(
      mapView,
      /function liveSmoothness\([\s\S]*?facts\.total < 0[\s\S]*?mapUi\.notRead/,
      '平稳度那一列没有区分"没读到"'
    )
  })

  it('分贝取最近一条告警的声压级，方位取**录入的**方位角（各有出处）', () => {
    assert.match(mapView, /function liveDb\([\s\S]*?facts\.latestSpl/, '分贝不是取最近一条告警的 spl')
    assert.match(
      mapView,
      /function liveAzimuth\([\s\S]*?installation\?\.azimuthDeg/,
      '方位不是取录入的方位角'
    )
    // 读不到与"没有"必须分得开。
    assert.match(mapView, /facts\.total < 0[\s\S]*?mapUi\.notRead/, '分贝那一列没有区分"没读到"')
  })

  it('三张列表的文案在四种语言里齐全', () => {
    const REQUIRED = [
      'mapUi.legendAlarm',
      'mapUi.devicesTitle',
      'mapUi.devicesCount',
      'mapUi.devicesHint',
      'mapUi.colAlarms',
      'mapUi.alarmsTitle',
      'mapUi.alarmsFor',
      'mapUi.liveTitle',
      'mapUi.colDb',
      'mapUi.colStability',
      'mapUi.colAzimuth',
      'mapUi.liveHint',
      'mapUi.notRead',
      'mapUi.none'
    ]
    /**
     * 纯符号的两条**故意四种语言一样**（`—` 就是 `—`，没有可翻译的东西），所以
     * "不能与中文逐字相同"这一条对它们不适用 —— 第一次跑正是这里红了一次。
     */
    const SYMBOLS = ['mapUi.notRead', 'mapUi.none']
    for (const key of REQUIRED) {
      for (const locale of Object.keys(CATALOGUES)) {
        const message = messageAt(locale, key)
        assert.ok(message && message.trim() !== '', `${locale} 缺 ${key}`)
        assert.equal(message.includes('@'), false, `${locale} 的 ${key} 含裸 @`)
      }
      if (SYMBOLS.includes(key)) continue
      const reference = messageAt('zh-CN', key) as string
      for (const locale of ['en', 'es', 'tr']) {
        assert.notEqual(messageAt(locale, key), reference, `${locale} 的 ${key} 与中文逐字相同`)
      }
    }
    // 两条符号键在四本目录里必须是同一个符号：它们在界面上的意思是"没有值 / 没读到"，
    // 逐语言改一个破折号只会让同一件事有两种写法。
    for (const key of SYMBOLS) {
      for (const locale of Object.keys(CATALOGUES)) {
        assert.equal(
          messageAt(locale, key),
          messageAt('zh-CN', key),
          `${locale} 的 ${key} 与其它语言不是同一个符号`
        )
        assert.equal(
          /[a-zA-Z\u4e00-\u9fa5]/.test(messageAt(locale, key) as string),
          false,
          `${locale} 的 ${key} 里出现了文字：它应当是纯符号`
        )
      }
    }
    // `devicesCount` 与 `alarmsFor` 的占位符四语言一致。
    for (const key of ['mapUi.devicesCount', 'mapUi.alarmsFor']) {
      const reference = (messageAt('zh-CN', key) as string).match(/\{(\w+)\}/g)?.sort()
      for (const locale of ['en', 'es', 'tr']) {
        assert.deepEqual(
          (messageAt(locale, key) as string).match(/\{(\w+)\}/g)?.sort(),
          reference,
          `${locale} 的 ${key} 占位符不一致`
        )
      }
    }
  })

  it('旧的"告警与抓图"标题已经换成「告警列表」（不留第二种说法）', () => {
    assert.equal(
      String(messageAt('zh-CN', 'mapUi.alarmsTitle')),
      '告警列表',
      '告警列表那一张的标题不是第 17 条给的那一个'
    )
  })
})

// ---------------------------------------------------------------------------
// 第 10 批第 15、16 条：设备悬停浮层
// ---------------------------------------------------------------------------

describe('地图上的设备悬停浮层（第 15、16 条）', () => {
  it('悬停与键盘焦点走同一套（标记本来就有 tabindex，键盘用户也要拿得到这条信息）', () => {
    for (const binding of ['@mouseenter="openHover(marker.id)"', '@focus="openHover(marker.id)"']) {
      assert.ok(mapTemplate.includes(binding), `标记缺少 ${binding}`)
    }
    for (const binding of ['@mouseleave="closeHover()"', '@blur="closeHover()"']) {
      assert.ok(mapTemplate.includes(binding), `标记缺少 ${binding}`)
    }
    assert.ok(mapTemplate.includes('data-map-hover'), '没有那块浮层')
    assert.ok(
      /role="button"\s*\n\s*tabindex="0"/.test(mapTemplate),
      '标记不再是可聚焦的按钮：键盘走到它上面时浮层不会出现'
    )
  })

  it('双击标记也进详情（第 15、16 条都要求"双击进详情"）', () => {
    assert.ok(
      mapTemplate.includes('@dblclick="openDeviceDetail(marker.id)"'),
      '标记上没有双击进详情'
    )
    assert.match(
      mapView,
      /function openDeviceDetail\(deviceId: string\): void \{\s*void router\.push\(\{ path: `\/devices\/\$\{deviceId\}` \}\)/,
      'openDeviceDetail 不再是"进这一台的详情页"'
    )
  })

  it('浮层里**不放** `<video>`：一条会话只有一个观看者，悬停会踢掉正在看的人', () => {
    const hoverStart = mapTemplate.indexOf('data-map-hover')
    assert.ok(hoverStart >= 0, '找不到浮层')
    const hoverBlock = mapTemplate.slice(hoverStart, hoverStart + 2400)
    assert.equal(
      /<video/.test(hoverBlock),
      false,
      '浮层里塞了 <video>：主进程对一台相机只有一条会话、一条会话只有一个观看者（res.write），' +
        '悬停接管会把正在看这一路的人的画面当场换掉'
    )
    // 给的是**状态**：一行文字，来自主进程。
    assert.ok(hoverBlock.includes('data-map-hover-stream'), '浮层没有"当前视频流"那一行')
    assert.match(
      mapView,
      /window\.api\.cameraLive\.state\(deviceId\)/,
      '浮层没有去问主进程视频流的状态'
    )
  })

  it('只有相机有「当前视频流」那一行（声纹设备没有视频流）', () => {
    assert.match(
      mapTemplate,
      /v-if="hoveredDevice\.kind === 'acousticCamera'"[\s\S]{0,400}data-map-hover-stream/,
      '"当前视频流"那一行没有按设备类型过滤'
    )
  })

  it('位置用百分比算（画布与定比例那一层同比例，量盒子会晚一拍）', () => {
    assert.match(
      mapView,
      /left: `\$\{\(\(marker\.x \/ CANVAS\.width\) \* 100\)\.toFixed\(3\)\}%`/,
      '浮层的 left 不是按画布比例算的'
    )
    assert.match(
      mapView,
      /top: `\$\{\(\(marker\.y \/ CANVAS\.height\) \* 100\)\.toFixed\(3\)\}%`/,
      '浮层的 top 不是按画布比例算的'
    )
    // 浮层压在标记上，所以必须 `pointer-events: none`：否则鼠标"离开"标记 →
    // 浮层消失 → 又出现（闪烁）。
    const style = mapView.slice(mapView.indexOf('.map-hover {'))
    assert.match(style.slice(0, style.indexOf('}')), /pointer-events: none/, '浮层会自己引起闪烁')
  })

  it('浮层里的四句话在四种语言里齐全，占位符一致', () => {
    const REQUIRED = [
      'mapUi.hoverStream',
      'mapUi.hoverAlarm',
      'mapUi.hoverNoAlarm',
      'mapUi.hoverHint'
    ]
    for (const key of REQUIRED) {
      for (const locale of Object.keys(CATALOGUES)) {
        const message = messageAt(locale, key)
        assert.ok(message && message.trim() !== '', `${locale} 缺 ${key}`)
        assert.equal(message.includes('@'), false, `${locale} 的 ${key} 含裸 @`)
      }
      const reference = messageAt('zh-CN', key) as string
      for (const locale of ['en', 'es', 'tr']) {
        assert.notEqual(messageAt(locale, key), reference, `${locale} 的 ${key} 与中文逐字相同`)
      }
    }
    for (const locale of Object.keys(CATALOGUES)) {
      assert.deepEqual(
        (messageAt(locale, 'mapUi.hoverAlarm') as string).match(/\{(\w+)\}/g),
        ['{count}'],
        `${locale} 的 hoverAlarm 占位符不是 {count}`
      )
    }
  })

  it('「有告警就显示告警」用的是与图上同一个数（未确认告警），而且"没有"与"没读到"分得开', () => {
    assert.match(
      mapView,
      /const hoverAlarmText = computed\(\(\) => \{[\s\S]*?facts\.pending < 0[\s\S]*?facts\.pending === 0[\s\S]*?mapUi\.hoverAlarm/,
      'hoverAlarmText 没有区分"没读到"与"没有"'
    )
  })
})
