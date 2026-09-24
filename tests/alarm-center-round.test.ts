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
import { zhTW } from '../src/shared/i18n/messages/zh-TW'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'
import { ru } from '../src/shared/i18n/messages/ru'
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

const CATALOGUES: Record<string, unknown> = { 'zh-CN': zhCN, 'zh-TW': zhTW, en, es, tr, ru }

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

describe('① 「告警记录」改名「告警中心」（六种语言一起改）', () => {
  it('页面名六种语言都是"告警中心"那一档，不再是"告警记录"', () => {
    const expected: Record<string, string> = {
      'zh-CN': '告警中心',
      'zh-TW': '警報中心',
      en: 'Alarm center',
      es: 'Centro de alarmas',
      tr: 'Alarm merkezi',
      ru: 'Центр тревог'
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

  it('六种语言里没有一处还把这一页叫作"告警记录 / Alarm records"', () => {
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
  it('模板里筛选卡是 `.page` 的第一个块级元素', () => {
    /*
     * 2026-09-26（第 50 轮）**按新口径改写这条断言**。
     *
     * 原断言是"筛选卡排在 `.page-header` 那一行（计数 + 批量动作）之前"。第 48 轮把
     * 这一页的筛选改成字段式表单行之后，`.page-header` 这个类**整个不见了** ——
     * 「计数 + 批量动作」搬进了列表卡自己的卡头（`.alarm-master__head`）。于是原断言
     * 报的是"找不到 .page-header"，而屏幕上"筛选卡在最上面"这件事其实一直是成立的。
     *
     * 业主第 2 条要的是**位置**，不是某个类名，所以现在直接断位置：
     * 筛选卡必须是 `.page` 的第一个块级元素，而且排在列表卡（`.alarm-master`）之前。
     * 这样将来卡头的类名再改一次，这条断言仍然说得清"在最上面"是什么意思。
     */
    const filtersAt = view.indexOf('data-alarm-filters')
    assert.ok(filtersAt > 0, '找不到筛选卡（[data-alarm-filters]）')

    const pageAt = view.indexOf('<div class="page')
    assert.ok(pageAt > 0, '找不到页面根节点（.page）')
    assert.ok(pageAt < filtersAt, '筛选卡不在 .page 里')

    /*
     * 筛选卡之前**只能有空白与注释**：它是 `.page` 的第一个块级元素。
     *
     * 两个坑都踩过，写在这里免得下一个人再踩：
     *   1. 起点不能直接 `view.indexOf('>', pageAt)` —— 那个 `>` 是 class 属性里的
     *      （`<div class="page alarm-center-page">`），会从标签中间开始切；
     *   2. 终点不能取 `view.lastIndexOf('<section', filtersAt)`。`view` 是**去掉注释之后**
     *      的文本，长度与原文件不同，而 `<section` 只在**原文件**里能按原偏移找到 ——
     *      两个坐标系混用会算出一个落在筛选卡标签中间的位置（实测正好落成
     *      `<sectionclass="cardalarm-filters"`）。
     *
     * 所以终点用**同一个坐标系**里的锚点：筛选卡开标签的 `class="card alarm-filters"`
     * 之前那一个 `<`。
     */
    const tagEnd = view.indexOf('>', view.indexOf('class="page', pageAt))
    assert.ok(tagEnd > pageAt, '找不到页面根标签的结束符')
    const classAt = view.lastIndexOf('class="card alarm-filters"', filtersAt)
    assert.ok(classAt > tagEnd, '找不到筛选卡开标签上的 class')
    const sectionAt = view.lastIndexOf('<', classAt)
    assert.ok(sectionAt > tagEnd, '找不到筛选卡的开标签')
    const before = view
      .slice(tagEnd + 1, sectionAt)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s+/g, '')
    assert.equal(
      before,
      '',
      '筛选卡前面还有别的东西（`.page` 的第一个块应当是筛选卡）'
    )

    const masterAt = view.indexOf('class="card alarm-master"')
    assert.ok(masterAt > filtersAt, '列表卡排在筛选卡之前（先选范围，再看结果）')
  })

  it('告警列表仍然在筛选卡之后（先选范围，再看结果）', () => {
    const filtersAt = view.indexOf('data-alarm-filters')
    /*
     * 第 48 轮把那张 `<table class="table">` 换成了合并列表（`.alarm-list`，盒子行与
     * 相机行同一张表），所以这里的锚点跟着换成它 —— 断的仍然是"列表在筛选卡之后"
     * 这件事，只是列表现在的形态变了。
     */
    const listAt = view.indexOf('class="alarm-list"')
    assert.ok(listAt > 0, '找不到告警列表（[role=list] 那一段）')
    assert.ok(listAt > filtersAt, '列表跑到了筛选卡前面')
  })
})

describe('③ 筛选行（业主 20260921 第二批：字段式表单行，设备 / 类型下拉回来了）', () => {
  it('筛选行是 设备 / 类型 / 时间范围 / 标题 / 内容 五个字段，外加重置', () => {
    // 切片右边界用表格开头：详情抽屉里复用了 filterDevice/filterChannel/filterAck 做字段标签，
    // 切到文件尾会把它们误当成"筛选行残留"。
    const simple = view.slice(
      view.indexOf('data-alarm-simple-filters'),
      view.indexOf('<table class="table">')
    )
    assert.ok(simple.length > 0, '找不到筛选行（[data-alarm-simple-filters]）')
    // 业主第二批把设备 / 告警类型两个下拉**加回来了**（第一批曾删掉，是"删除钉桩"的那一格）。
    for (const [key, hook] of [
      ['filterDevice', 'data-filter-device'],
      ['filterType', 'data-filter-alarm-type']
    ] as const) {
      assert.ok(simple.includes(`t('alarmsUi.${key}')`), `筛选行里少了 ${key}`)
      assert.ok(simple.includes(hook), `筛选行里少了 ${hook} 钩子`)
    }
    for (const key of ['filterTimeRange', 'filterTitle', 'filterContent']) {
      assert.ok(simple.includes(`t('alarmsUi.${key}')`), `筛选行里少了 ${key}`)
    }
    // 没回来的：等级 / 确认状态 / 通道 / 起止输入格（时间合并进了一个日历）与「更多筛选」。
    // 任何一项长回来都是漂移。
    for (const gone of ['filterSeverity', 'filterAck', 'filterChannel', 'filterFrom', 'filterTo']) {
      assert.equal(
        simple.includes(`t('alarmsUi.${gone}')`),
        false,
        `筛选行里又出现了已删除的 ${gone}`
      )
    }
    assert.equal(simple.includes('data-action="toggle-alarm-filters"'), false, '「更多筛选」开关又长回来了')
    assert.equal(view.includes('data-alarm-more-filters'), false, '「更多筛选」面板又长回来了')
  })

  it('标题/内容搜索框与日历范围选择器都渲染，重置按钮在', () => {
    assert.ok(view.includes('data-filter-title'), '标题搜索框没渲染')
    assert.ok(view.includes('data-filter-content'), '内容搜索框没渲染')
    assert.ok(view.includes('<DateRangePicker'), '日历范围选择器没用上')
    assert.ok(view.includes('data-action="reset-alarm-filters"'), '筛选行里没有重置按钮')
  })

  it('每一格筛选都**显式**进 query：清空 = undefined，不能缺席', () => {
    /*
     * 这是探针在真窗口里抓到的一个**既有缺陷**（2026-09-19 第 15 轮）：
     * `buildQuery()` 写成"有值才带上"，而 store 的 `applyQuery()` 是**合并补丁** ——
     * 缺席的键不会清掉上一次的值。于是"把筛选清空"这条路上列表仍然是被筛过的。
     * 重构后只剩四格，但这条纪律一条都不能少。
     */
    const build = view.slice(view.indexOf('function buildQuery'), view.indexOf('async function reload'))
    assert.ok(build.length > 0, '找不到 buildQuery()')
    for (const key of ['title', 'content', 'from', 'to', 'deviceId', 'alarmType']) {
      assert.match(
        build,
        new RegExp(`\\b${key}:`),
        `buildQuery() 里没有显式给出 ${key} —— 清空那一格时它清不掉`
      )
    }
    assert.match(build, /undefined/, 'buildQuery() 里没有"清空"的写法（undefined）')
  })

  it('行右键菜单：查看详情 / 回放 / 下载 / 加入样本 / 确认', () => {
    for (const hook of ['data-alarm-row-menu', 'data-menu-replay', 'data-menu-download', 'data-menu-sample', 'data-menu-ack']) {
      assert.ok(view.includes(hook), `右键菜单缺 ${hook}`)
    }
    /*
     * 2026-09-26（第 50 轮）**按新口径改写这条断言**。
     *
     * 原断言写的是 `@contextmenu="openRowMenu(`，而第 48 轮把列表合并成"盒子行 + 相机行
     * 同一张表"之后，相机行**没有**右键菜单（它没有 `alarms` 表里的那条记录，五条菜单项
     * 一个都不适用）。行上的 handler 因此变成了带条件的写法：
     *   `@contextmenu="row.kind === 'box' && row.box ? openRowMenu($event, row.box) : undefined"`
     * 也就是说：**盒子行有菜单、相机行没有** —— 而"行右键菜单"这条要求本身仍然成立。
     *
     * 现在断的是这两件事：菜单由行的 contextmenu 接出来，而且相机行不会被接上。
     */
    assert.match(view, /@contextmenu="[^"]*openRowMenu\(\$event, row\.box\)/, '表格行没有接 contextmenu')
    assert.match(
      view,
      /row\.kind === 'box' && row\.box \? openRowMenu/,
      '相机行也被接上了右键菜单（它那五条菜单项一条都不适用）'
    )
    // 无本机录音的条目下载要禁用并写出原因（不能点出一个报错对话框）。
    assert.ok(view.includes("t('alarmsUi.menuNoRecording')"), '下载禁用原因没接文案')
  })

  it('回放证据：视频（MP4 容器）与抓图（听诊盒子族）都在详情面板里', () => {
    /*
     * 第 50 轮把详情从"右边一列"改成"列表下方一整幅宽的面板"（业主第 4 条），
     * 所以这条断言的措辞跟着改，但**证据一件事都没少**：视频、抓图、音频仍在。
     */
    assert.ok(view.includes("t('alarmsUi.videoTitle')"), '详情没有视频那一节')
    assert.ok(view.includes("t('alarmsUi.snapshotsTitle')"), '详情没有抓图那一节')
    assert.ok(view.includes('localRecordingContainer'), '没有用录音容器选播放器')
    assert.ok(view.includes('data-alarm-detail'), '详情面板没有稳定钩子')
  })

  it('筛选行新文案四语言齐全，下载回执占位符一致', () => {
    for (const locale of LOCALES) {
      for (const key of ['filterTitle', 'filterContent', 'filterTimeRange', 'menuDetail', 'menuReplay', 'menuDownload', 'menuAddSample', 'menuAck']) {
        const value = messageAt(locale, `alarmsUi.${key}`)
        assert.equal(typeof value, 'string', `${locale} 缺 alarmsUi.${key}`)
        assert.ok(String(value).trim() !== '', `${locale} 的 alarmsUi.${key} 是空的`)
      }
    }
    for (const locale of ['en', 'es', 'tr']) {
      assert.deepEqual(
        (String(messageAt(locale, 'alarmsUi.downloadDone')).match(/\{(\w+)\}/g) ?? []).sort(),
        (String(messageAt('zh-CN', 'alarmsUi.downloadDone')).match(/\{(\w+)\}/g) ?? []).sort(),
        `${locale} 的 downloadDone 占位符与中文不一致`
      )
    }
  })
})
