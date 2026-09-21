/**
 * 地图信息页的第 11 批改版（业主 2026-09-19 第 4、5 条）。
 *
 * WHY THIS FILE EXISTS
 * 这两条改的都是"看起来没问题、其实少了一块"的东西：
 *
 *   ① **第 4 条**删掉了地图区上面的三处文字（读数、图例 + 三个计数、"还没有任何设备录入点位…"），
 *      并在地图右上角加一条**半透明状态栏**。删字符串是安静的（页面照样渲染），
 *      所以这里同时钉"删干净了"与"数字真的搬到了状态栏、而且读不到告警时不是 0"。
 *   ② **第 5 条**把设备列表收到三列、半幅宽，右侧放告警列表，并且**两张卡永远一样高**。
 *      "一样高"是这一条里最容易做错的一件事（CSS 里内容会把行高撑开），
 *      所以做法（绝对定位的内容层 + 两张卡同一个 `min-height`）在这里被钉住；
 *      翻页的边界（第 0 页、超出末页、设备被删之后页码悬空）在纯函数那一组里断言。
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
import {
  DEVICE_MAP_PAGE_SIZE,
  clampListPage,
  listPageCount,
  listPageSlice
} from '../src/renderer/src/lib/listPaging'

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

const CATALOGUES: Record<string, unknown> = { 'zh-CN': zhCN, en, es, tr }

function messageAt(locale: string, key: string): string | undefined {
  let cursor: unknown = CATALOGUES[locale]
  for (const part of key.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return typeof cursor === 'string' ? cursor : undefined
}

/**
 * 视图源码的**两份**读法：
 *   · `mapSource` 原样 —— 只有"某个键是不是真的从目录里删掉了"这种要看到全文件的地方才用它；
 *   · `mapCode` 去掉注释 —— 所有"实现里有没有这个钩子/这条样式"的断言都读它。
 * 这一条是被自己咬过一次的：我在注释里写了被删掉的键名（`mapUi.counts`）与旧样式
 * （`max-height: 260px`）作为说明，于是"删干净了"那两条断言在注释上红了。
 */
const mapSource = read('src/renderer/src/views/DeviceMapView.vue')
const mapCode = stripComments(mapSource)

// ---------------------------------------------------------------------------
// 1. 翻页的纯函数（第 5 条：默认最多 10 台，超过就翻页）
// ---------------------------------------------------------------------------

describe('设备列表翻页：页码永远合法（第 11 批第 5 条）', () => {
  it('每页 10 台，页数是向上取整，0 台也算 1 页', () => {
    assert.equal(DEVICE_MAP_PAGE_SIZE, 10)
    assert.equal(listPageCount(0), 1)
    assert.equal(listPageCount(1), 1)
    assert.equal(listPageCount(10), 1)
    assert.equal(listPageCount(11), 2)
    assert.equal(listPageCount(20), 2)
    assert.equal(listPageCount(21), 3)
    // 坏输入（负数、NaN）不能变成 0 页或 NaN 页。
    assert.equal(listPageCount(-5), 1)
    assert.equal(listPageCount(Number.NaN), 1)
  })

  it('页码被夹进 1..页数（设备从 23 台删到 3 台之后不会停在空白的第 5 页）', () => {
    assert.equal(clampListPage(1, 3), 1)
    assert.equal(clampListPage(5, 3), 1)
    assert.equal(clampListPage(5, 23), 3)
    assert.equal(clampListPage(0, 23), 1)
    assert.equal(clampListPage(-2, 23), 1)
    assert.equal(clampListPage(2.7, 23), 2)
    assert.equal(clampListPage(Number.NaN, 23), 1)
    // 23 台删到 3 台：原来停在第 3 页，现在必须落回第 1 页（只有一页）。
    assert.equal(clampListPage(3, 3), 1)
  })

  it('切片：每页 10 条、最后一页不足 10 条、越界页码先夹一遍', () => {
    const items = Array.from({ length: 23 }, (_, index) => index + 1)
    assert.deepEqual(listPageSlice(items, 1), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.deepEqual(listPageSlice(items, 3), [21, 22, 23])
    assert.deepEqual(listPageSlice(items, 9), [21, 22, 23], '越界的页码没有被夹回末页')
    assert.deepEqual(listPageSlice(items, 0), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], '第 0 页应当是第 1 页')
    assert.deepEqual(listPageSlice([], 1), [])
  })

  it('视图用的是这一份实现（没有在页面里自己写一套 index 算术）', () => {
    assert.match(mapCode, /listPageSlice\(devices\.devices, devicePage\.value, DEVICE_MAP_PAGE_SIZE\)/)
    assert.match(
      mapCode,
      /clampListPage\(devicePage\.value, devices\.devices\.length, DEVICE_MAP_PAGE_SIZE\)/
    )
    assert.match(mapCode, /listPageCount\(devices\.devices\.length, DEVICE_MAP_PAGE_SIZE\)/)
    // 设备表变短时把页码拉回来（watch）。
    assert.match(mapCode, /watch\(\s*\(\) => devices\.devices\.length/)
  })
})

// ---------------------------------------------------------------------------
// 1b. 同一套纯函数的 size-4 用法（20260921 第二批第 22 条：监测页特性表每页 4 行）
// ---------------------------------------------------------------------------

describe('listPaging 的 size-4 用法（监测页每通道特性表，第 22 条）', () => {
  const CHANNEL_PAGE_SIZE = 4
  const eight = Array.from({ length: 8 }, (_, index) => index + 1)

  it('8 通道 = 2 页；页数向上取整，0 路也算 1 页', () => {
    assert.equal(listPageCount(8, CHANNEL_PAGE_SIZE), 2)
    assert.equal(listPageCount(4, CHANNEL_PAGE_SIZE), 1)
    assert.equal(listPageCount(5, CHANNEL_PAGE_SIZE), 2)
    assert.equal(listPageCount(0, CHANNEL_PAGE_SIZE), 1)
    assert.equal(listPageCount(Number.NaN, CHANNEL_PAGE_SIZE), 1)
  })

  it('页码夹取：坏值 / 越界都归到合法页（通道表从 8 路变 3 路后不停在空页）', () => {
    assert.equal(clampListPage(2, 8, CHANNEL_PAGE_SIZE), 2)
    assert.equal(clampListPage(3, 8, CHANNEL_PAGE_SIZE), 2, '8 路只有 2 页，第 3 页必须夹回末页')
    assert.equal(clampListPage(5, 3, CHANNEL_PAGE_SIZE), 1, '3 路只有 1 页，第 5 页必须落回第 1 页')
    assert.equal(clampListPage(0, 8, CHANNEL_PAGE_SIZE), 1)
    assert.equal(clampListPage(Number.NaN, 8, CHANNEL_PAGE_SIZE), 1)
  })

  it('切片：每页 4 行，第 2 页是后 4 行，越界页码先夹一遍', () => {
    assert.deepEqual(listPageSlice(eight, 1, CHANNEL_PAGE_SIZE), [1, 2, 3, 4])
    assert.deepEqual(listPageSlice(eight, 2, CHANNEL_PAGE_SIZE), [5, 6, 7, 8])
    assert.deepEqual(listPageSlice(eight, 9, CHANNEL_PAGE_SIZE), [5, 6, 7, 8], '越界页码没有被夹回末页')
    assert.deepEqual(listPageSlice(eight, 0, CHANNEL_PAGE_SIZE), [1, 2, 3, 4], '第 0 页应当是第 1 页')
    // 不满一页的设备（如 3 路）：一页放下，不硬切 4。
    assert.deepEqual(listPageSlice([1, 2, 3], 1, CHANNEL_PAGE_SIZE), [1, 2, 3])
  })

  it('监测页特性表用的是这一份实现（page size 4 + 三个纯函数入口）', () => {
    const monitorCode = stripComments(read('src/renderer/src/views/MonitorView.vue'))
    assert.match(monitorCode, /CHANNEL_FEATURE_PAGE_SIZE = 4/)
    assert.match(
      monitorCode,
      /listPageSlice\(channelFeatureRows\.value, channelFeaturePage\.value, CHANNEL_FEATURE_PAGE_SIZE\)/
    )
    assert.match(
      monitorCode,
      /clampListPage\(channelFeaturePage\.value, channelFeatureRows\.value\.length, CHANNEL_FEATURE_PAGE_SIZE\)/
    )
    assert.match(
      monitorCode,
      /listPageCount\(channelFeatureRows\.value\.length, CHANNEL_FEATURE_PAGE_SIZE\)/
    )
    // 翻页条文案用新键 monitorUi.channelPager（{start}/{end}/{total}），上一页/下一页复用告警页键。
    assert.match(monitorCode, /t\('monitorUi\.channelPager', \{/)
    assert.match(monitorCode, /t\('alarmsUi\.prevPage'\)/)
    assert.match(monitorCode, /t\('alarmsUi\.nextPage'\)/)
    // 表体仍然"能长能缩"，翻页条落底（body flex:1 + min-height:0 的约定没有被翻页破坏）。
    assert.match(monitorCode, /\.channel-features__body \{[\s\S]{0,120}flex: 1/)
    assert.match(monitorCode, /\.channel-features__pager \{/)
  })
})

// ---------------------------------------------------------------------------
// 2. 地图右上角的状态栏（第 4 条）
// ---------------------------------------------------------------------------

describe('地图右上角的半透明状态栏（第 11 批第 4 条）', () => {
  it('三处被点名的文字连文案键一起删掉了', () => {
    for (const gone of [
      'data-map-counts',
      'data-map-legend',
      'data-map-empty',
      'data-map-without-point'
    ]) {
      assert.equal(mapCode.includes(gone), false, `地图页还留着已删掉的 ${gone}`)
    }
    for (const key of [
      'mapUi.counts',
      'mapUi.noPoints',
      'mapUi.withoutPointTitle',
      'mapUi.withoutPointHint'
    ]) {
      assert.equal(mapCode.includes(key), false, `视图里还引用着已删掉的 ${key}`)
      for (const locale of Object.keys(CATALOGUES)) {
        assert.equal(messageAt(locale, key), undefined, `${locale} 目录里还留着 ${key}`)
      }
    }
  })

  it('地图卡片上下那两条线已删，上下间距收到 10%（20260921 批第 9 条；原本是 8px）', () => {
    /*
     * 原话：「地图显示卡片的上下有两个线条， 这个线条可以删除， 重新调整下地图卡片上下的间距」。
     *
     * 那两条线是 `.map-panel` 的 `border-top` / `border-bottom`（当时与设备管理页那张扁平表
     * 是同一套做法）；删掉之后内边距从 `--space-4`（16px）收到 `--space-2`（8px），
     * 20260921 批第 9 条再收到 10%（≈0.8px，与 .map-page gap、.map-split margin 同比例）。
     *
     * 反向断言必须读**去注释**的源码：这一轮的注释里点名写了 `border-top` / `border-bottom`。
     */
    const rule = mapCode.slice(mapCode.indexOf('.map-panel {'))
    const block = rule.slice(0, rule.indexOf('}'))
    assert.equal(
      /border-(top|bottom)\s*:/.test(block),
      false,
      '地图那一块又加回了上下边线（业主要求删掉）'
    )
    // 显式写 `border: none` 是允许的（去掉边线的另一种写法），但任何带宽度/颜色的边框都不行。
    const shorthand = /border\s*:\s*([^;]+);/.exec(block)
    if (shorthand) {
      assert.equal(shorthand[1]?.trim(), 'none', `地图那一块还有边框：${shorthand[1]}`)
    }
    assert.match(block, /padding-block: calc\(var\(--space-2\)\s*\*\s*0\.1\);/, '上下间距不是 10%')
    assert.match(mapCode, /data-map-panel/, '找不到地图那一块')
  })

  it('状态栏在画布**里面**的右上角，半透明、不吃鼠标事件', () => {
    // 位置：在那一层定比例的画布容器之内，而不是地图上面另起一行。
    const frame = mapCode.indexOf('data-map-canvas-frame')
    const status = mapCode.indexOf('data-map-statusbar')
    assert.ok(frame > 0 && status > frame, '状态栏不在画布那一层里面')
    assert.match(
      mapCode,
      /\.map-status \{[^}]*position: absolute;[^}]*top: var\(--space-2\);[^}]*right: var\(--space-2\);/,
      '状态栏没有绝对定位到右上角'
    )
    // 半透明：`color-mix()` 拿主题底色兑透明（前一行是老引擎兜底）。
    assert.match(
      mapCode,
      /\.map-status \{[^}]*background: rgba\([^)]*0\.\d+\);[^}]*background: color-mix\(/,
      '状态栏不是半透明（或没有兜底那一行）'
    )
    // 它压在画布右上角，而落点是可点的：不吃事件才不会挡住任何东西。
    assert.match(mapCode, /\.map-status \{[^}]*pointer-events: none;/, '状态栏会挡住画布上的点击')
    // 落点在图上是可点的（这一条是"别挡"的前提）。
    assert.ok(mapCode.includes('data-map-marker'), '图上没有落点')
  })

  it('五个读数各有钩子：图上 / 共 / 在线 / 离线 / 未确认告警', () => {
    for (const hook of [
      'data-map-status-mapped',
      'data-map-status-total',
      'data-map-status-online',
      'data-map-status-offline',
      'data-map-status-alarms'
    ]) {
      assert.ok(mapCode.includes(hook), `状态栏缺少 ${hook}`)
    }
    // 数字各有出处：图上 = 落点数，共 = 设备表全部。
    assert.match(mapCode, /statusMapped', \{ count: layout\.markers\.length \}/, '「图上 N 台」不是落点数')
    assert.match(
      mapCode,
      /statusTotal', \{ count: devices\.devices\.length \}/,
      '「共 M 台」不是设备表全部'
    )
    assert.match(mapCode, /statusOnline', \{ count: onlineCount \}/, '在线数没有来源')
    assert.match(mapCode, /statusOffline', \{ count: offlineCount \}/, '离线数没有来源')
    assert.match(
      mapCode,
      /count: alarmStatus\.known \? alarmStatus\.pending : t\('mapUi\.notRead'\)/,
      '告警数没有区分"没读到"'
    )
  })

  it('在线/离线按**设备状态**数（不是落点颜色那一套），没读到告警时显示 — 而不是 0', () => {
    // 落点颜色是"告警 > 在线 > 离线"，而状态栏问的是"有几台在线"：两者判据不同。
    assert.match(
      mapCode,
      /const onlineCount = computed\(\(\) => devices\.devices\.filter\(\(device\) => device\.status === 'ONLINE'\)\.length\)/
    )
    assert.match(
      mapCode,
      /const offlineCount = computed\(\(\) => devices\.devices\.length - onlineCount\.value\)/
    )
    // `alarmFacts` 为空（还没读过）或某一台读失败（-1）都算"没读到"。
    assert.match(mapCode, /if \(list\.length === 0\) return \{ known: false, pending: 0 \}/)
    assert.match(mapCode, /if \(facts\.pending < 0\) return \{ known: false, pending: 0 \}/)
    assert.match(
      mapCode,
      /:data-map-status-alarm-known="alarmStatus\.known \? 'yes' : 'no'"/,
      '状态栏没有把"读没读到"暴露给探针'
    )
  })

  it('「一台点位都没有」时画布照旧画出来（不再整块消失）', () => {
    // 原来 SVG 的条件是"有落点才画"（没有落点就什么都不画）。
    assert.equal(
      /<svg\s+v-if="layout\.markers\.length > 0"/.test(mapCode),
      false,
      '画布仍然在没有落点时不渲染（那看起来像页面坏了）'
    )
    /*
     * 20260921 批第 9 条：网格不再按"有没有视野"判断 —— 没有落点时用兜底视野
     * （effectiveBounds = 真实范围 ?? 时区中心 ±十几个度），网格与坐标刻度永远在场。
     * 断言从「v-if="project"」改为「无条件渲染 + 兜底视野来源在场」。
     */
    assert.match(mapCode, /<g class="map-grid">/, '网格应当无条件渲染')
    assert.match(mapSource, /effectiveBounds/, '没有兜底视野')
    assert.match(mapSource, /fallbackBounds/, '没有兜底视野的实现')
    // 坐标刻度（业主：GIS 信息要读得出数字）。
    assert.match(mapCode, /map-grid__label/, '网格没有坐标刻度')
    assert.match(mapSource, /function latLabel\(/, '纬度刻度格式化缺席')
    assert.match(mapSource, /function lonLabel\(/, '经度刻度格式化缺席')
    // 底图未启用提示。
    assert.match(mapCode, /data-map-tiles-off/, '底图未启用提示缺席')
  })
})

// ---------------------------------------------------------------------------
// 3. 左设备列表 / 右告警列表（第 5 条）
// ---------------------------------------------------------------------------

describe('设备列表在左、告警列表在右、两张卡一样高（第 11 批第 5 条）', () => {
  it('设备列表只有 序号 / 设备名称 / 状态 三列', () => {
    const block = mapCode.slice(mapCode.indexOf('data-map-devices'), mapCode.indexOf('data-map-alarms'))
    const headers = [...block.matchAll(/<th [^>]*>\{\{ t\('([^']+)'\)/g)].map((match) => match[1])
    assert.deepEqual(
      headers,
      ['devicesUi.indexColumn', 'devices.name', 'devicesUi.onlineColumn'],
      `设备列表的列不是三项：${headers.join(', ')}`
    )
    // 被删掉的列不许再出现（设备类型 / 点位 / 未确认告警）。
    for (const gone of ['addDeviceUi.kindLabel', 'mapUi.point', 'mapUi.colAlarms']) {
      assert.equal(block.includes(gone), false, `设备列表里还留着 ${gone}`)
    }
    // 序号是**总表里的序号**（第 2 页第一行是 11，不是 1）。
    assert.match(block, /\{\{ devicePageStart \+ index \+ 1 \}\}/, '序号不是总表里的序号')
  })

  it('点设备名称打开设备详情弹窗（不是只选中那一行）', () => {
    assert.match(
      mapCode,
      /data-action="map-device-detail"[\s\S]{0,200}@click\.stop="openDeviceDetail\(device\.id\)"/,
      '设备名称不是进入详情的入口'
    )
    // 业主 20260921 批：详情改为弹窗（stores/deviceDetailDialog → AppShell 全局宿主），
    // 不再是 router.push 整页跳转。
    assert.match(
      mapSource,
      /function openDeviceDetail\(deviceId: string\): void \{\s*detailDialog\.show\(deviceId,/,
      'openDeviceDetail 不再是"打开这一台的详情弹窗"'
    )
    assert.equal(
      /router\.push\(\{ path: `\/devices\/\$\{deviceId\}` \}\)/.test(mapSource),
      false,
      '地图页又在整页跳转 /devices/:id（弹窗模式下不该出现）'
    )
  })

  it('两栏并排：设备列表占半幅，告警列表在右（窄窗口自动落回上下）', () => {
    assert.match(mapCode, /<div class="map-split" data-map-split>/, '没有那两栏的容器')
    assert.match(
      mapCode,
      /\.map-split \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(340px, 1fr\)\);/,
      '两栏不是等宽（业主："宽度调整为现在的 50%"）'
    )
    // 模板顺序：设备卡在告警卡之前。
    assert.ok(
      mapCode.indexOf('data-map-devices') < mapCode.indexOf('data-map-alarms'),
      '设备列表不在告警列表左侧'
    )
    // 告警列表仍然是**选中设备**的告警（点设备切换它），不是全部告警混在一起。
    assert.match(mapCode, /data-map-alarms[\s\S]{0,900}alarmsFor/, '告警列表没有说它是哪一台的告警')
  })

  it('两张卡永远一样高：内容层绝对定位 + 两张卡同一个 min-height', () => {
    /*
     * 网格项的默认 `stretch` 会把两者拉成一样高，但**行高由内容更高的那一侧决定**：
     * 告警列表比设备列表长时，"一样高"就变成了"一起变高"。所以告警卡的内容被放进
     * `.map-block__fill`（绝对定位 → 不参与父级内容高度），行高只由设备卡决定。
     */
    assert.match(
      mapCode,
      /\.map-block--devices,\s*\n\.map-block--alarms \{[^}]*min-height: 320px;/,
      '两张卡没有同一个 min-height（只有一台设备时告警卡会被压成一条缝）'
    )
    assert.match(mapCode, /\.map-block--alarms \{[^}]*position: relative;/, '告警卡不是定位父级')
    assert.match(
      mapCode,
      /\.map-block__fill \{[^}]*position: absolute;[^}]*inset: 0;/,
      '告警卡的内容层不是绝对定位（它会把行高撑开）'
    )
    assert.match(
      mapCode,
      /class="card map-block map-block--alarms"[\s\S]{0,400}class="map-block__fill"/,
      '告警卡里没有那一层'
    )
    // 告警条目自己滚，而不是把卡片顶高。
    assert.match(
      mapCode,
      /\.map-alarms \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;[^}]*overflow: auto;/,
      '告警条目没有"占满剩余高度并自己滚"'
    )
    // 原来的固定高度必须删掉（它会在高窗口留白、在矮窗口把卡片顶高）。
    assert.equal(/max-height: 260px/.test(mapCode), false, '告警列表还留着 max-height: 260px')
  })

  it('翻页控件：超过一页才出现，首末页各禁用一头', () => {
    assert.match(mapCode, /v-if="devicePages > 1" class="map-pager" data-map-pager/, '10 台以内也在画翻页控件')
    assert.match(
      mapCode,
      /data-action="map-page-prev"[\s\S]{0,220}:disabled="devicePageClamped <= 1"/,
      '上一页没有在首页禁用'
    )
    assert.match(
      mapCode,
      /data-action="map-page-next"[\s\S]{0,220}:disabled="devicePageClamped >= devicePages"/,
      '下一页没有在末页禁用'
    )
    assert.match(mapCode, /data-map-page-status/, '没有"第 N 页 / 共 M 页"读数')
  })
})

// ---------------------------------------------------------------------------
// 4. 四语言文案
// ---------------------------------------------------------------------------

describe('第 11 批地图页的新文案四语言齐全', () => {
  it('状态栏与翻页的键都在四本目录里，而且不是照抄中文', () => {
    const KEYS = [
      'mapUi.statusLabel',
      'mapUi.statusMapped',
      'mapUi.statusTotal',
      'mapUi.statusOnline',
      'mapUi.statusOffline',
      'mapUi.statusAlarms',
      'mapUi.pagePrev',
      'mapUi.pageNext',
      'mapUi.pageStatus'
    ]
    for (const key of KEYS) {
      const reference = messageAt('zh-CN', key) as string
      assert.ok(reference && reference.trim() !== '', `zh-CN 缺 ${key}`)
      for (const locale of ['en', 'es', 'tr']) {
        const message = messageAt(locale, key)
        assert.ok(message && message.trim() !== '', `${locale} 缺 ${key}`)
        assert.notEqual(message, reference, `${locale} 的 ${key} 与中文逐字相同`)
        assert.equal(message.includes('@'), false, `${locale} 的 ${key} 含裸 @`)
      }
    }
    // 占位符四语言一致（`{count}` / `{page}` / `{pages}`）。
    for (const key of [
      'mapUi.statusMapped',
      'mapUi.statusTotal',
      'mapUi.statusOnline',
      'mapUi.statusOffline',
      'mapUi.statusAlarms'
    ]) {
      const reference = (messageAt('zh-CN', key) as string).match(/\{(\w+)\}/g)
      assert.deepEqual(reference, ['{count}'], `${key} 的占位符不是 {count}`)
      for (const locale of ['en', 'es', 'tr']) {
        assert.deepEqual(
          (messageAt(locale, key) as string).match(/\{(\w+)\}/g),
          reference,
          `${locale} 的 ${key} 占位符不一致`
        )
      }
    }
    for (const locale of Object.keys(CATALOGUES)) {
      assert.deepEqual(
        (messageAt(locale, 'mapUi.pageStatus') as string).match(/\{(\w+)\}/g),
        ['{page}', '{pages}'],
        `${locale} 的 pageStatus 占位符不一致`
      )
    }
  })

  it('设备列表那条提示说的是"点名称进详情"（与新的入口一致）', () => {
    assert.match(String(messageAt('zh-CN', 'mapUi.devicesHint')), /点设备名称进这一台的详情页/)
    for (const locale of ['en', 'es', 'tr']) {
      assert.notEqual(messageAt(locale, 'mapUi.devicesHint'), messageAt('zh-CN', 'mapUi.devicesHint'))
    }
  })
})
