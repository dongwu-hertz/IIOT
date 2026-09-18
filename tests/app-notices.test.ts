/**
 * 「系统消息」：应用级失败不住在页面顶上，而是住进顶栏那颗告警图标里。
 *
 * WHY THIS FILE EXISTS
 * 业主 2026-09-18 的原话：「认证失败，检测用户名和密码 这些告警内容，直接放在右上角的告警
 * ICON 内，而不是在软件中进行顶部添加信息。要确保整体的布局不会因为告警等内容而改变」。
 *
 * 在那之前，`devices.error`（设备列表/通道表/状态读取失败，含认证失败）被画成**顶栏下面
 * 一条浮动横幅**，而它在每一页都在 —— 一条「认证失败，请检查用户名和密码（AUTH_FAILED）」
 * 就这样挂在所有页面上；总览页还另外画了同一个字段的第二条。
 *
 * 这一份守两件事：
 *   A. store 的口径（一条问题只留一行、时间记第一次、能撤掉、有上限）—— 直接跑真 store；
 *   B. 摆放位置（进告警图标的面板、不再出现在页面顶上、面板是浮层所以不动布局）—— 源码守卫。
 *
 * 中文注释是仓库约定。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, it } from 'node:test'

import { createPinia, setActivePinia } from 'pinia'

import { MAX_APP_NOTICES, useAppNoticesStore } from '../src/renderer/src/stores/appNotices'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 去掉注释：好几条断言是"某个东西已经不在了"，而解释为什么删的注释恰好写着那几个字。 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

// ---------------------------------------------------------------------------
// A. store 的口径
// ---------------------------------------------------------------------------

describe('A. 系统消息 store：一条问题只留一行，能撤掉，有上限', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('报一条就有一条，文案原样读回', () => {
    const notices = useAppNoticesStore()
    notices.report({ id: 'devices', text: '认证失败，请检查用户名与密码（AUTH_FAILED）' })
    assert.equal(notices.count, 1)
    assert.deepEqual(
      notices.items.map((item) => item.text),
      ['认证失败，请检查用户名与密码（AUTH_FAILED）']
    )
  })

  it('同一个来源再次报到：**只更新文案**，不追加第二行，时间仍是第一次那一刻', () => {
    const notices = useAppNoticesStore()
    notices.report({ id: 'devices', text: '第一次的话', at: 1000 })
    notices.report({ id: 'devices', text: '第二次的话', at: 5000 })
    assert.equal(notices.count, 1, '同一个来源不该在面板里占两行')
    assert.equal(notices.items[0]?.text, '第二次的话', '文案要跟着最新一次')
    assert.equal(notices.items[0]?.at, 1000, '时间说的是"第一次被看到"，重复报到不该把它刷成刚刚')
  })

  it('不同来源各占一行，最新的排在最上面', () => {
    const notices = useAppNoticesStore()
    notices.report({ id: 'devices', text: '设备读不出来', at: 1000 })
    notices.report({ id: 'settings', text: '设置读不出来', at: 2000 })
    assert.equal(notices.count, 2)
    assert.deepEqual(
      notices.items.map((item) => item.id),
      ['settings', 'devices']
    )
  })

  it('问题解决了就撤掉；全部清除会清空', () => {
    const notices = useAppNoticesStore()
    notices.report({ id: 'devices', text: 'x' })
    notices.report({ id: 'settings', text: 'y' })
    notices.clear('devices')
    assert.deepEqual(
      notices.items.map((item) => item.id),
      ['settings']
    )
    notices.clearAll()
    assert.equal(notices.count, 0)
  })

  it('撤掉之后同一来源再失败：这一次是一条**新**消息（时间是新的）', () => {
    const notices = useAppNoticesStore()
    notices.report({ id: 'devices', text: 'x', at: 1000 })
    notices.clear('devices')
    notices.report({ id: 'devices', text: 'x', at: 9000 })
    assert.equal(notices.items[0]?.at, 9000)
  })

  it('空 id 或空文案一律忽略（那是调用方的 bug，不是一条消息）', () => {
    const notices = useAppNoticesStore()
    notices.report({ id: '', text: '有话说' })
    notices.report({ id: 'devices', text: '   ' })
    assert.equal(notices.count, 0)
  })

  it('条目有上限：超出时丢最早的那条，面板不会长成一张无限名单', () => {
    const notices = useAppNoticesStore()
    for (let index = 0; index < MAX_APP_NOTICES + 3; index += 1) {
      notices.report({ id: `source-${index}`, text: `第 ${index} 条`, at: 1000 + index })
    }
    assert.equal(notices.count, MAX_APP_NOTICES)
    assert.equal(
      notices.items.some((item) => item.id === 'source-0'),
      false,
      '最早的那条应当被丢掉'
    )
    assert.equal(
      notices.items.some((item) => item.id === `source-${MAX_APP_NOTICES + 2}`),
      true,
      '最新的那条必须在'
    )
  })
})

// ---------------------------------------------------------------------------
// B. 摆放位置：进告警图标的面板，不再挂在页面顶上
// ---------------------------------------------------------------------------

const TOPBAR = 'src/renderer/src/components/AppTopbar.vue'
const PANEL = 'src/renderer/src/components/AlarmLinkagePanel.vue'
const SHELL = 'src/renderer/src/components/AppShell.vue'
const OVERVIEW = 'src/renderer/src/views/OverviewView.vue'

const topbar = stripComments(read(TOPBAR))
const panel = stripComments(read(PANEL))
const panelRaw = read(PANEL)
const shell = stripComments(read(SHELL))
const overview = stripComments(read(OVERVIEW))

describe('B. 摆放位置：应用级失败在告警图标的面板里，页面上不再有它', () => {
  it('顶栏不再画 `devices.error` 那条浮动横幅（也不再有它的样式）', () => {
    assert.equal(topbar.includes('devices.error'), false, '顶栏又把 devices.error 画回来了')
    assert.equal(topbar.includes('topbar__error'), false, '顶栏又出现了那条浮动横幅')
    // CSS 注释里会解释"这里原来有什么、为什么删"，所以样式断言也要去掉注释。
    assert.equal(stripComments(panelRaw).includes('topbar__error'), false)
    assert.equal(
      /topbar__error\s*\{/.test(stripComments(read(TOPBAR))),
      false,
      '.topbar__error 的规则又回来了'
    )
  })

  it('总览页也不再画同一条（同一个失败只在一处说）', () => {
    assert.equal(overview.includes('devices.error'), false, '总览页又出现了 devices.error 横幅')
  })

  it('`devices.error` 只被这两处读：都是**点一下就地反馈**的地方（页面不许再读）', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(vue|ts)$/.test(entry.name)) files.push(full)
      }
    }
    walk(path.join(projectRoot, 'src', 'renderer', 'src'))
    const readers = files
      .filter((file) => stripComments(fs.readFileSync(file, 'utf8')).includes('devices.error'))
      .map((file) => path.relative(projectRoot, file).replace(/\\/g, '/'))
    /*
     * 剩下这两处都是**输入现场/动作现场**的话（"哪一步、哪个输入"），刻意的例外：
     *   - `AddDeviceDialog`：添加设备失败；
     *   - `DevicesView`：编辑/删除/改名的失败。
     * 任何**页面顶上**再读它都是回归 —— 那正是业主报的"每一页挂着一条认证失败"。
     * 读类失败（设备列表 / 通道表 / 状态刷新）不再走这个字段，而是由 store 直接报进
     * 系统消息（见下一条），所以它也不在这份名单里。
     */
    assert.deepEqual(readers.sort(), [
      'src/renderer/src/components/AddDeviceDialog.vue',
      'src/renderer/src/views/DevicesView.vue'
    ])
  })

  it('外壳不再读 `devices.error`：口径住在 store 里，不在外壳里', () => {
    assert.equal(shell.includes('devices.error'), false, '外壳又读起了那个字段')
  })

  it('设备侧三条**读**路径各自报一条系统消息，读通了各自撤掉', () => {
    const store = stripComments(read('src/renderer/src/stores/devices.ts'))
    // 三个独立 id：通道表读回来了不该把"设备列表读不出来"那条也撤掉。
    for (const id of ['devices-list', 'devices-channels', 'devices-status']) {
      assert.ok(store.includes(`'${id}'`), `devices.ts 少了 ${id} 这个来源`)
    }
    // 三条读路径：load / loadChannels / refreshStatus，各自 report + clear。
    assert.equal(
      (store.match(/reportReadError\(READ_ERROR_IDS\./g) ?? []).length,
      6,
      '三条读路径各要一次上报 + 一次撤销（失败时报、成功时撤）'
    )
    // 增删改**不报**：那是点一下的结果，已经在对话框/页面里就地说了。
    for (const action of ['async function add(', 'async function update(', 'async function remove(']) {
      const start = store.indexOf(action)
      assert.ok(start > 0, `找不到 ${action}`)
      const block = store.slice(start, store.indexOf('\n  }', start))
      assert.equal(
        block.includes('reportReadError'),
        false,
        `${action} 不该报系统消息（它是一次点击的结果，就地说明就够）`
      )
    }
  })

  it('面板里有「系统消息」那一段，并且逐条列出来', () => {
    assert.match(panel, /data-app-notices/)
    assert.match(panel, /v-for="problem in notices\.items"/)
    assert.match(panel, /data-app-notice\b/)
    assert.match(panel, /notices\.clearAll\(\)/)
    assert.match(panel, /notices\.clear\(problem\.id\)/)
    assert.match(panel, /notices\.count > 0/)
    // 空的时候整块不画：一条空标题会让人以为下面的告警属于它。
    assert.match(panel, /<section v-if="notices\.count > 0"/)
  })

  it('告警图标上多一个**点**（不是数字）：角标那个数仍然只是待处理告警条数', () => {
    assert.match(panel, /data-bell-problem/)
    assert.match(panel, /class="alarm-badge__count"/)
    // 角标与列表同源（`tests/page-layout.test.ts` 也钉着这一条），系统消息的条数**不许**
    // 混进那个数字里 —— 混进去就再也说不清那个数是什么。
    assert.match(panel, /linkage\.unacknowledgedCount/)
    assert.match(panel, /t\('noticesUi\.bellWithProblems', \{ count: notices\.count \}\)/)
    assert.equal(
      /unacknowledgedCount \+ notices\.count|notices\.count \+ /.test(panel),
      false,
      '系统消息的条数被加进了告警角标'
    )
  })

  it('面板仍然是浮层：它的出现与消失不参与页面布局', () => {
    // 这条是业主那句话的后半句（"布局不会因为告警等内容而改变"）在源码上的落点。
    const rule = /\.alarm-panel\s*\{[\s\S]*?\}/.exec(panelRaw)
    assert.ok(rule, '找不到 .alarm-panel 的样式规则')
    assert.match(rule[0], /position:\s*absolute/)
  })

  it('四语言都有 noticesUi 四条词条，且 {count} 占位符在', () => {
    const table: Array<[string, { title: string; clearAll: string; dismiss: string; bellWithProblems: string }]> = [
      ['zh-CN', zhCN.noticesUi],
      ['en', en.noticesUi],
      ['es', es.noticesUi],
      ['tr', tr.noticesUi]
    ]
    for (const [locale, group] of table) {
      for (const [key, value] of Object.entries(group)) {
        assert.ok(String(value).trim().length > 0, `${locale} 的 noticesUi.${key} 是空的`)
      }
      assert.ok(
        group.bellWithProblems.includes('{count}'),
        `${locale} 的 noticesUi.bellWithProblems 少了 {count} 占位符`
      )
    }
  })
})
