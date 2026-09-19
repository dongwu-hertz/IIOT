/**
 * 「告警记录」改名「告警中心」+ 筛选卡置顶 + 简单/更多筛选分档（业主 2026-09-19）。
 *
 * 业主原话（三条一起给的）：
 *   1. 「告警记录修改为 告警中心」；
 *   2. 「筛选的卡片放在最上面的」；
 *   3. 「可以做一个简单筛选，和更多筛选内容的区分，更多筛选默认收起」。
 *
 * WHY THIS FILE EXISTS
 * 这三条全都**只在屏幕上成立**才算数，所以每一类都钉住具体事实，而不是"文件里有这个字符串"：
 *   · 页面名与四处引用它的文案：改成新名字，而且**四语言一致**（漏一种语言就会出现
 *     「Alarm records」这种半截改名）；
 *   · 筛选卡在最上面：用**模板顺序**判（`data-alarm-filters` 必须排在 `.page-header` 之前）——
 *     这是"最上面"在源码里唯一说得清的形式；
 *   · 两档筛选：简单那三个一直显示（没有 v-if 门），"更多"那四个被 `v-if="moreOpen"` 门住
 *     且 `moreOpen` 初值是 `false`（默认收起），开关带 `aria-expanded`；
 *   · **收起时仍然生效的筛选必须说得出来**：按钮文案在有生效项时带上数字 ——
 *     否则列表变短在屏幕上没有解释（这一条是"区分"两个字的落点）。
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
import { LOCALES } from '../src/shared/i18n/locales'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 去掉注释：断言的是代码，不是散文。 */
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

const CATALOGUES: Record<string, unknown> = { 'zh-CN': zhCN, en, es, tr }

function messageAt(locale: string, key: string): unknown {
  let cursor: unknown = CATALOGUES[locale]
  for (const part of key.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

const viewSource = read('src/renderer/src/views/AlarmsView.vue')
const view = stripComments(viewSource)

describe('① 「告警记录」改名「告警中心」（四种语言一起改）', () => {
  it('页面名四种语言都是"告警中心"那一档，不再是"告警记录"', () => {
    const expected: Record<string, string> = {
      'zh-CN': '告警中心',
      en: 'Alarm center',
      es: 'Centro de alarmas',
      tr: 'Alarm merkezi'
    }
    for (const locale of LOCALES) {
      assert.equal(messageAt(locale, 'app.nav.alarms'), expected[locale], `${locale} 的页面名不对`)
    }
    // 旧名字**不许**再出现在页面名里。
    assert.notEqual(messageAt('zh-CN', 'app.nav.alarms'), '告警记录')
  })

  it('四处引用这一页的文案也一起改了（半截改名比不改还糟）', () => {
    for (const locale of LOCALES) {
      // 相机页那条跳转链接（命名空间是 `cameraAlarmUi`，不是 `monitorUi`）。
      const goAlarmList = String(messageAt(locale, 'cameraAlarmUi.goAlarmList'))
      assert.ok(goAlarmList.trim() !== '', `${locale} 缺 cameraAlarmUi.goAlarmList`)
      // 告警面板那句"到…看全部"。
      const more = String(messageAt(locale, 'linkage.deviceAlarmsMore'))
      assert.ok(more.includes('{count}'), `${locale} 的 deviceAlarmsMore 丢了占位符`)
      // 权限说明里对这三个操作的描述。
      const scope = String(messageAt(locale, 'domain.permissionScope.viewAlarms'))
      assert.ok(scope.trim() !== '', `${locale} 缺 domain.permissionScope.viewAlarms`)
    }
    // 中文这三处必须已经是"告警中心"，而且一个"告警记录"都不许剩（讲数据的句子除外）。
    assert.equal(messageAt('zh-CN', 'cameraAlarmUi.goAlarmList'), '查看告警中心')
    assert.ok(String(messageAt('zh-CN', 'linkage.deviceAlarmsMore')).includes('「告警中心」'))
    assert.ok(String(messageAt('zh-CN', 'domain.permissionScope.viewAlarms')).startsWith('告警中心'))
    assert.ok(String(messageAt('zh-CN', 'samplesUi.empty')).includes('「告警中心」'))
  })

  it('四种语言里没有一处还把这一页叫作"告警记录 / Alarm records"', () => {
    for (const locale of LOCALES) {
      for (const key of ['cameraAlarmUi.goAlarmList', 'linkage.deviceAlarmsMore']) {
        const value = String(messageAt(locale, key))
        assert.equal(
          /Alarm records|Registro de alarmas|Alarm kayıtları|告警记录/.test(value),
          false,
          `${locale} 的 ${key} 还在用旧页面名：${value}`
        )
      }
    }
  })
})

describe('② 筛选卡在最上面', () => {
  it('模板里筛选卡排在「计数 + 批量动作」那一行之前', () => {
    const filtersAt = view.indexOf('data-alarm-filters')
    const headerAt = view.indexOf('class="page-header"')
    assert.ok(filtersAt > 0, '找不到筛选卡（[data-alarm-filters]）')
    assert.ok(headerAt > 0, '找不到计数/动作那一行（.page-header）')
    assert.ok(
      filtersAt < headerAt,
      '筛选卡不在最上面：它排在 .page-header 之后（业主第 2 条要求放到最上面）'
    )
    // 两者都在 `.page` 里，而且筛选卡是**第一个**块级元素。
    const pageAt = view.indexOf('<div class="page">')
    assert.ok(pageAt > 0 && pageAt < filtersAt, '筛选卡不在 .page 里')
    assert.equal(
      /<div class="page">[\s\S]{0,120}?<div class="page-header">/.test(view),
      false,
      '筛选卡前面还有别的东西（`.page` 的第一个块应当是筛选卡）'
    )
  })

  it('告警表格仍然在筛选卡之后（先选范围，再看结果）', () => {
    const filtersAt = view.indexOf('data-alarm-filters')
    const tableAt = view.indexOf('<table class="table">')
    assert.ok(tableAt > filtersAt, '表格跑到了筛选卡前面')
  })
})

describe('③ 简单筛选 / 更多筛选（更多默认收起）', () => {
  it('简单筛选那三个**一直显示**：设备 / 等级 / 确认状态', () => {
    const simple = view.slice(
      view.indexOf('data-alarm-simple-filters'),
      view.indexOf('data-alarm-more-filters')
    )
    assert.ok(simple.length > 0, '找不到简单筛选那一行')
    for (const key of ['filterDevice', 'filterSeverity', 'filterAck']) {
      assert.ok(simple.includes(`t('alarmsUi.${key}')`), `简单筛选里少了 ${key}`)
    }
    /*
     * 简单那三个字段**没有**被 v-if 门住（"一直显示"就是这句话）。
     *
     * 切片到"更多筛选开关"为止：`data-alarm-more-filters` 那一段的 `v-if="moreOpen"` 在属性顺序上
     * 排在它的 data 钩子**之前**，所以拿那个钩子当右边界会把 `v-if` 一起圈进来（第一版就是这样
     * 红的 —— 断言的是"更多筛选默认收起"那段代码，而不是简单筛选）。
     */
    const simpleFields = view.slice(
      view.indexOf('data-alarm-simple-filters'),
      view.indexOf('filter-more-toggle')
    )
    assert.equal(/v-if=/.test(simpleFields), false, '简单筛选里出现了条件渲染（它必须一直显示）')
  })

  it('更多筛选那四个被门住，而且默认收起', () => {
    const more = view.slice(view.indexOf('data-alarm-more-filters'))
    for (const key of ['filterFrom', 'filterTo', 'filterChannel', 'filterType']) {
      assert.ok(more.includes(`t('alarmsUi.${key}')`), `更多筛选里少了 ${key}`)
    }
    assert.match(
      view,
      /v-if="moreOpen"[\s\S]{0,200}data-alarm-more-filters/,
      '更多筛选没有被 moreOpen 门住'
    )
    assert.match(
      view,
      /const moreOpen = ref\(false\)/,
      'moreOpen 的初值不是 false（业主第 3 条：更多筛选默认收起）'
    )
  })

  it('开关有 aria-expanded 与稳定的探针钩子，而且真的切换', () => {
    assert.match(
      view,
      /data-action="toggle-alarm-filters"[\s\S]{0,200}:aria-expanded="moreOpen"/,
      '开关缺 aria-expanded（读屏说不出它开着还是收着）'
    )
    assert.match(view, /@click="moreOpen = !moreOpen"/, '开关没有真的切换')
    assert.match(view, /:aria-controls="'alarm-more-filters'"/, '开关没有指向它控制的那一块')
  })

  it('收起时生效的筛选项数**说得出来**（否则列表变短没人解释）', () => {
    assert.match(
      view,
      /const advancedFilterCount = computed\(/,
      '没有统计生效中的"更多筛选"'
    )
    // 四项都要计进去：两个时间 + 通道 + 类型。
    const counter = view.slice(view.indexOf('const advancedFilterCount'))
    const body = counter.slice(0, counter.indexOf('\n})'))
    for (const field of ['filters.channelId', 'filters.alarmType', 'filters.from', 'filters.to']) {
      assert.ok(body.includes(field), `生效项统计里漏了 ${field}`)
    }
    assert.match(
      view,
      /moreFiltersActive', \{ count: advancedFilterCount\.value \}/,
      '按钮没有显示生效项数'
    )
    assert.match(view, /\{\{ moreFiltersLabel \}\}/, '按钮没有用那个文案')
  })

  it('重置按钮一直在（收起"更多"之后仍然清得掉）', () => {
    const simple = view.slice(
      view.indexOf('data-alarm-simple-filters'),
      view.indexOf('data-alarm-more-filters')
    )
    assert.ok(simple.includes('data-action="reset-alarm-filters"'), '简单筛选里没有重置按钮')
  })

  it('每一格筛选都**显式**进 query：清空 = undefined，不能缺席', () => {
    /*
     * 这是探针在真窗口里抓到的一个**既有缺陷**（2026-09-19 第 15 轮）：
     * `buildQuery()` 原来写成"有值才带上"，而 store 的 `applyQuery()` 是**合并补丁** ——
     * 缺席的键不会清掉上一次的值。于是"把筛选清空"这条路上列表仍然是被筛过的：
     * 探针把「开始时间」设成 2099 年（0 条），再清空，**仍然是 0 条**。
     * `severity` / `channelId` / `alarmType` / `acknowledged` / `to` 五格当时同样清不掉。
     */
    const build = view.slice(view.indexOf('function buildQuery'), view.indexOf('async function reload'))
    assert.ok(build.length > 0, '找不到 buildQuery()')
    for (const key of [
      'deviceId',
      'channelId',
      'alarmType',
      'severity',
      'from',
      'to',
      'acknowledged'
    ]) {
      assert.match(
        build,
        new RegExp(`\\b${key}:`),
        `buildQuery() 里没有显式给出 ${key} —— 清空那一格时它清不掉`
      )
    }
    assert.match(build, /undefined/, 'buildQuery() 里没有"清空"的写法（undefined）')
  })

  it('三条新文案四语言齐全，占位符一致', () => {
    for (const locale of LOCALES) {
      for (const key of ['moreFilters', 'hideMoreFilters', 'moreFiltersActive']) {
        const value = messageAt(locale, `alarmsUi.${key}`)
        assert.equal(typeof value, 'string', `${locale} 缺 alarmsUi.${key}`)
        assert.ok(String(value).trim() !== '', `${locale} 的 alarmsUi.${key} 是空的`)
        assert.equal(String(value).includes('@'), false, `${locale} 的 ${key} 含裸 @`)
      }
    }
    for (const locale of ['en', 'es', 'tr']) {
      assert.deepEqual(
        (String(messageAt(locale, 'alarmsUi.moreFiltersActive')).match(/\{(\w+)\}/g) ?? []).sort(),
        (String(messageAt('zh-CN', 'alarmsUi.moreFiltersActive')).match(/\{(\w+)\}/g) ?? []).sort(),
        `${locale} 的 moreFiltersActive 占位符与中文不一致`
      )
    }
  })
})
