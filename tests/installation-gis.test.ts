/**
 * 「地址信息支持 GIS 显示」（业主 2026-09-18 第 10 批第 7 条后半）。
 *
 * WHY THIS FILE EXISTS
 * 这一条在**离线优先**的架构里有一个必须说清的口径：**默认**不联网取瓦片，所以"GIS 显示"
 * 的基础仍是本机画的那张图；在线底图是后来的可选层（默认关闭，见 `map-tiles.ts`），
 * 不是这一条的替代品。这一条要钉的是三件事：
 *   1. 录进去的点位**真的画到「地图信息」页上**（那是第 5 轮就有的落图）；
 *   2. 地址信息卡片上能**一键定位到这一台**（`/map?device=<id>`，地图页认这个参数）；
 *   3. 坐标能**复制走**（十进制度、逗号分隔，粘进任何 GIS 工具都能用）。
 *
 * 三条边界也是这一份要钉住的：
 *   · **只有点位成对**才给那两个入口（半截坐标落不了图）；
 *   · `?device=` 只认字符串，重复参数/别的类型一律当"没给"（否则地图页会去查一台叫
 *     "undefined" 的设备）；
 *   · 地图页只在**真有这一台、且它有点位**时才采用那个参数（过期的书签不该把选中项换成
 *     一台图上没有的设备 —— 那时右边三张表会一起变空，看起来像页面坏了）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  DEVICE_MAP_ROUTE,
  deviceMapFocusId,
  deviceMapLink,
  isMappable
} from '../src/renderer/src/lib/deviceMapLink'
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
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('*'))
    })
    .join('\n')
}

const CATALOGUES: Record<string, { installUi: Record<string, unknown> }> = {
  'zh-CN': zhCN as unknown as { installUi: Record<string, unknown> },
  en: en as unknown as { installUi: Record<string, unknown> },
  es: es as unknown as { installUi: Record<string, unknown> },
  tr: tr as unknown as { installUi: Record<string, unknown> }
}

// ---------------------------------------------------------------------------
// 1. 纯函数：什么时候给入口、链接长什么样、参数怎么读
// ---------------------------------------------------------------------------

describe('地图入口的判据与形状', () => {
  it('只有经纬度**成对**才算能落图（半截坐标不给入口）', () => {
    assert.equal(isMappable({ gisLatitude: 31.2304, gisLongitude: 121.4737 }), true)
    // 只录一半：落不了图。
    assert.equal(isMappable({ gisLatitude: 31.2304 }), false)
    assert.equal(isMappable({ gisLongitude: 121.4737 }), false)
    // 只录了方位角：也没有点位。
    assert.equal(isMappable({ azimuthDeg: 45 }), false)
    assert.equal(isMappable({}), false)
    assert.equal(isMappable(undefined), false)
    // `0` 是真实坐标（几内亚湾），不是"没录"。
    assert.equal(isMappable({ gisLatitude: 0, gisLongitude: 0 }), true)
    // 非有限数（NaN / Infinity）不算。
    assert.equal(isMappable({ gisLatitude: Number.NaN, gisLongitude: 1 }), false)
    assert.equal(isMappable({ gisLatitude: Number.POSITIVE_INFINITY, gisLongitude: 1 }), false)
  })

  it('链接形状只有一处：`/map?device=<id>`', () => {
    assert.equal(DEVICE_MAP_ROUTE, '/map')
    assert.deepEqual(deviceMapLink('dev-1'), { path: '/map', query: { device: 'dev-1' } })
  })

  it('参数解析只认字符串；缺失/数组/别的类型一律当"没给"', () => {
    assert.equal(deviceMapFocusId({ device: 'dev-1' }), 'dev-1')
    assert.equal(deviceMapFocusId({ device: '  dev-1  ' }), 'dev-1')
    assert.equal(deviceMapFocusId({}), '')
    assert.equal(deviceMapFocusId({ device: ['a', 'b'] }), '', '重复参数不当成"第一个"')
    assert.equal(deviceMapFocusId({ device: 7 }), '')
    assert.equal(deviceMapFocusId({ device: null }), '')
    assert.equal(deviceMapFocusId(undefined), '')
    assert.equal(deviceMapFocusId('dev-1'), '')
  })
})

// ---------------------------------------------------------------------------
// 2. 卡片与地图页的接线（源码守卫）
// ---------------------------------------------------------------------------

describe('接线（源码守卫）', () => {
  const card = stripComments(read('src/renderer/src/components/DeviceInstallationCard.vue'))
  const map = stripComments(read('src/renderer/src/views/DeviceMapView.vue'))

  it('卡片上有「在地图信息里查看」与「复制坐标」，而且**都**被点位完整那一条门住', () => {
    assert.ok(card.includes('data-action="open-device-on-map"'), '没有跳地图的入口')
    assert.ok(card.includes('data-action="copy-device-point"'), '没有复制坐标的入口')
    assert.match(card, /v-if="canShowOnMap"/, '两个 GIS 入口没有被"点位成对"门住')
    assert.match(card, /const canShowOnMap = computed\(/, '没有那个判据')
    assert.match(card, /isMappable\(props\.installation\)/, '判据没有走共享层那条')
    assert.match(card, /deviceMapLink\(props\.deviceId \?\? ''\)/, '链接不是用共享层那一个函数拼的')
    assert.match(card, /navigator\.clipboard\.writeText\(pointText\.value\)/, '复制的是别的东西')
  })

  it('两个调用点都把设备 id 传了进去（否则那两个入口永远不出现）', () => {
    for (const file of [
      'src/renderer/src/views/DeviceDetailView.vue',
      'src/renderer/src/views/MonitorView.vue'
    ]) {
      const source = read(file)
      const tags = [...source.matchAll(/<DeviceInstallationCard[^>]*>/g)].map((match) => match[0])
      assert.ok(tags.length > 0, `${file} 没有用这张卡片`)
      for (const tag of tags) {
        assert.ok(tag.includes(':device-id='), `${file} 没有把设备 id 传进地址信息卡片：\n${tag}`)
      }
    }
  })

  it('地图页认 `?device=`，而且只在**真有这一台**时才采用', () => {
    assert.match(map, /const route = useRoute\(\)/, '地图页没有读路由')
    assert.match(map, /deviceMapFocusId\(route\.query\)/, '地图页没有解析 ?device=')
    assert.match(
      map,
      /layout\.value\.markers\.find\(\(marker\) => marker\.id === focusId\)/,
      '没有在"有点位的标记"里找这一台（过期的 id 会被当成选中项）'
    )
    /*
     * 2026-09-20 的实时工作台规格 §35 明确要求：**没有 ?device= 时不要默认选第一台**，
     * 实时区显示 "Select a device to view live data"。默认选一台会让操作员把眼前的
     * 实时读数误认成自己关心的设备；地图页是多设备场景，这个误读代价更大。
     * 因此这里断言"回落到第一台"已经删除，并且只选中 `focused`。
     */
    assert.equal(
      /const first = focused \?\?/.test(map),
      false,
      '又回落到第一台了（规格 §35：没有选中设备时应显示 Empty State）'
    )
    assert.match(map, /realtime\.clearSelection\(\)/, '进入页面时没有清掉上一个会话的选中状态')
    assert.match(map, /if \(focused\) \{[\s\S]{0,120}selectDevice\(focused\.id\)/, '没有只选中 ?device= 指向的那一台')
  })

  it('四条新文案四语言齐全', () => {
    for (const locale of Object.keys(CATALOGUES)) {
      for (const key of ['gisLabel', 'viewOnMap', 'copyPoint', 'pointCopied']) {
        const value = CATALOGUES[locale]!.installUi[key]
        assert.equal(typeof value, 'string', `${locale} 缺 installUi.${key}`)
        assert.ok(String(value).trim() !== '', `${locale} 的 ${key} 是空的`)
      }
    }
    assert.equal(CATALOGUES['zh-CN']!.installUi.viewOnMap, '在地图信息里查看')
    assert.equal(CATALOGUES['zh-CN']!.installUi.copyPoint, '复制坐标')
  })
})
