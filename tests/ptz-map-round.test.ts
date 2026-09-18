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

  it('没有点位的设备**单独列出来**，不画在图上', () => {
    assert.ok(mapTemplate.includes('data-map-without-point'), '没有"未录入点位"那一块')
    assert.ok(mapCode.includes('layout.withoutPoint'), '视图没有用 withoutPoint（半点位会被画在图上）')
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

  it('页面名只有一处：面板标题用 `app.nav.map`，画布的无障碍名另说', () => {
    // 第 12 条改了名字之后，同一句名字出现在顶栏/侧栏/面板标题三处 —— 只能有一个来源。
    assert.ok(
      mapTemplate.includes("t('app.nav.map')"),
      '面板标题没有复用页面名（app.nav.map）'
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

  it('四种语言的地图文案齐全，而且名字是业主给的那一个', () => {
    for (const locale of Object.keys(CATALOGUES)) {
      for (const key of ['app.nav.map', 'mapUi.canvasLabel', 'mapUi.noPoints', 'mapUi.snapshotNotCaptured']) {
        assert.ok(messageAt(locale, key), `${locale} 缺 ${key}`)
      }
    }
    // 第 12 条：名字从「点位图」改成「地图信息（GIS）」。中文这一条逐字带上 GIS。
    assert.match(String(messageAt('zh-CN', 'app.nav.map')), /地图信息（GIS）/, '中文名不是第 12 条给的那一个')
    // 四本目录里都得是"地图 + GIS"的说法，不能只有中文改了。
    for (const locale of ['en', 'es', 'tr']) {
      assert.match(
        String(messageAt(locale, 'app.nav.map')),
        /GIS/,
        `${locale} 的名字里没有 GIS`
      )
    }
    // 点位图不能把"没有点位"写成"地图加载失败"：那不是网络问题。
    assert.equal(/加载失败|loading failed/i.test(String(messageAt('zh-CN', 'mapUi.noPoints'))), false)
  })
})
