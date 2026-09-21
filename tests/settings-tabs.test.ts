/**
 * ③ 系统设置拆页签（业主 2026-09-17）的源码守卫。
 *
 * WHY THIS FILE EXISTS
 * 这一条改动**只有版式**，所以它最容易悄悄退化：页签拿掉之后页面照样能看（只是又变回
 * 一条长列），"每张卡片都写名字"再长回来也没有任何报错。三类守卫：
 *
 *   1. **页签**：6 个页签（业主 20260921 批合并：常规 / 集成 / GIS 服务 / 告警 / 账号 / 关于），
 *      每一页都被 `activeTab` 门住；
 *   2. **不重复标题**：`SettingsView` 里**不许**再出现 `section-title` ——
 *      页签已经写着这一页叫什么，卡片再写一遍就是业主说的"每张卡片都写名字"；
 *   3. **设备探测与缓冲合成一组**（业主 ④）：六个数在**同一组**里，而且旧的两张卡片
 *      标题（`probeSection` / `ringSection`）与它们的目录键一起删掉（留键 = 留一个
 *      随时会被加回来的入口）。
 *
 * 另外两条与"单一实现"有关：账号页签的改密对话框必须与侧栏账户菜单**共用组件**，
 * 否则密码校验会在两处慢慢分叉。
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

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

const CATALOGUES: Record<string, Record<string, unknown>> = {
  'zh-CN': zhCN as unknown as Record<string, unknown>,
  en: en as unknown as Record<string, unknown>,
  es: es as unknown as Record<string, unknown>,
  tr: tr as unknown as Record<string, unknown>
}

function messageAt(locale: string, key: string): unknown {
  let cursor: unknown = CATALOGUES[locale]
  for (const part of key.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

const settings = stripComments(read('src/renderer/src/views/SettingsView.vue'))

/**
 * 页签 id 与它的目录键（顺序就是业主 20260921 批定的那一串）。
 *
 * 2026-09-19 第 13 批第 1 条把**第八个页签「数据接入」删掉了**（业主：
 * 「系统设置里面的数据接入，应该是在设备管理的添加设备功能里面」）：监听设置与收数统计
 * 搬进「添加设备 → 协议接入方式」下面那一块「本机接入」，`settingsUi.tabIot` 四语言一起删。
 *
 * 业主 20260921 批又把它并成 **6 个页签**：语言/存储/视频/缓存合成「常规」（小卡排布），
 * 邮箱/地图/AI 合成「集成」，地图页签里那套「GIS 服务」单列一页；原来的「地图」「AI 服务」
 * 两个页签与 `tabMap`/`tabAi` 等键随这次合并删掉。
 *
 * 守卫的价值不变：这张表**就是**我们商定的那一串，多一个少一个都要在这里改一次。
 */
const TABS: ReadonlyArray<[string, string]> = [
  ['general', 'tabGeneral'],
  ['integration', 'tabIntegration'],
  ['gis', 'tabGisServices'],
  ['alarm', 'tabAlarm'],
  ['account', 'tabAccount'],
  ['about', 'tabAbout']
]

describe('③ 设置页的页签', () => {
  it('页签表就是我们商定的那一串，顺序不变', () => {
    const table = settings.slice(
      settings.indexOf('const TABS = ['),
      settings.indexOf('] as const', settings.indexOf('const TABS = ['))
    )
    assert.ok(table.length > 0, '找不到 TABS 页签表')
    for (const [id, labelKey] of TABS) {
      assert.ok(table.includes(`id: '${id}'`), `页签表里没有 ${id}`)
      assert.ok(table.includes(`labelKey: 'settingsUi.${labelKey}'`), `页签 ${id} 的目录键不对`)
    }
    // 恰好这些：多一个少一个都说明这张清单被改了。
    assert.equal(
      (table.match(/id: '/g) || []).length,
      TABS.length,
      `页签数不是 ${TABS.length}`
    )
  })

  /**
   * 第 32 轮补的一条：**探针里那份页签期望也必须跟着改**。
   *
   * 为什么值得单独钉：这一轮第一次跑完整支 GUI 探针时，问题清单里立刻出现
   * 「设置页的页签不是 8 个：7」—— 界面是对的（第 13 批第 1 条删掉了那个页签），
   * 是**探针里那份清单没跟着改**，而它前面 4 轮都因为趋势页超时、从来没跑到打印汇总那一步，
   * 所以谁都没看见。一条断言换掉一次这样的来回。
   */
  it('GUI 探针里那份页签期望与本文件一致（6 个，且不许再出现 iot）', () => {
    const driver = read('scripts/demo-shot-driver.cjs')
    assert.ok(
      driver.includes(`settingsTabs.tabs !== ${TABS.length}`),
      `探针里的页签数期望不是 ${TABS.length}`
    )
    assert.equal(
      /settingsTabs\.tabs !== [789]/.test(driver),
      false,
      '探针里还写着 7/8/9 个页签'
    )
    assert.ok(
      driver.includes(`['general', 'integration', 'gis', 'alarm', 'account', 'about']`),
      '探针里那份页签 id 清单与这里不一致'
    )
  })

  it('每一页都被 activeTab 门住（否则六个页签的内容会同时显示）', () => {
    const panelStart = settings.indexOf('class="settings-tabs"')
    const template = settings.slice(panelStart)
    for (const [id] of TABS) {
      assert.ok(
        template.includes(`activeTab === '${id}'`),
        `没有一页被 activeTab === '${id}' 门住`
      )
    }
    // 常规与关于这两页是独立的 `<section v-if>`；集成/告警/账号三页用 template 分组。
    assert.match(template, /v-if="activeTab === 'general'"/, '常规页没有条件')
    assert.match(template, /v-if="activeTab === 'about'"/, '关于页没有条件')
  })

  it('页签有 tablist / tab 语义（读屏要能说出选中哪一个）', () => {
    assert.match(settings, /role="tablist"/, '页签条没有 role="tablist"')
    assert.match(settings, /role="tab"/, '页签没有 role="tab"')
    assert.match(settings, /:aria-selected="activeTab === tab\.id"/, '页签没有 aria-selected')
    assert.match(settings, /role="tabpanel"/, '页内容没有 role="tabpanel"')
  })

  it('六个页签名在四种语言里都存在且互不相同', () => {
    for (const locale of LOCALES) {
      const labels = TABS.map(([, key]) => messageAt(locale, `settingsUi.${key}`))
      for (const [index, label] of labels.entries()) {
        assert.equal(typeof label, 'string', `${locale} 缺少 settingsUi.${TABS[index]?.[1]}`)
        assert.ok((label as string).trim().length > 0, `${locale} 的 ${TABS[index]?.[1]} 是空的`)
      }
      assert.equal(new Set(labels).size, labels.length, `${locale} 里有两个页签名一模一样`)
    }
  })
})

describe('③ 页内不再写重复的卡片标题；版面更紧', () => {
  it('SettingsView 里没有 section-title（页签已经写着这一页叫什么）', () => {
    assert.equal(
      settings.includes('class="section-title"'),
      false,
      '设置页又出现了卡片标题（业主 ③：不要每张卡片都写名字）'
    )
  })

  it('页内的分组用小标题：常规页是小卡（mini-card），其余页是 settings-group 这一套', () => {
    // 业主 20260921 批：常规页签改成紧凑小卡排布（语言/存储/视频/缓存各一张），
    // 小卡的标题走 `mini-card__title`；集成 / GIS 服务 / 账号那几页仍是 settings-group。
    for (const key of ['tabLanguage', 'tabStorage', 'tabVideo', 'cacheCardTitle']) {
      assert.ok(
        settings.includes(`<span class="mini-card__title">{{ t('settingsUi.${key}') }}</span>`),
        `常规页的小卡标题里少了 ${key}`
      )
    }
    for (const key of ['mapGroupService', 'mapGroupTemplate', 'mapCacheGroup', 'accountSessionGroup']) {
      assert.ok(settings.includes(`t('settingsUi.${key}')`), `没有用到分组小标题 ${key}`)
    }
    assert.ok(settings.includes('class="settings-group__title"'), '分组小标题的样式类不见了')
    assert.match(settings, /\.settings-group \+ \.settings-group \{/, '分组之间没有分隔规则')
  })

  it('版面更紧：常规页的小卡网格两列起步，卡内表单网格更窄', () => {
    const miniGrid = settings.slice(
      settings.indexOf('.mini-grid {'),
      settings.indexOf('}', settings.indexOf('.mini-grid {'))
    )
    assert.ok(miniGrid.length > 0, '找不到常规页的小卡网格规则')
    assert.match(miniGrid, /repeat\(auto-fit,\s*minmax\(300px,\s*1fr\)\)/, '小卡网格不是两列起步')
    const cardGrid = settings.slice(
      settings.indexOf('.mini-card .form-grid {'),
      settings.indexOf('}', settings.indexOf('.mini-card .form-grid {'))
    )
    assert.ok(cardGrid.length > 0, '找不到小卡内的表单网格规则')
    assert.match(cardGrid, /repeat\(auto-fit,\s*minmax\(150px,\s*1fr\)\)/, '卡内网格不是窄三列起步')
    const panel = settings.slice(
      settings.indexOf('.settings-panel {'),
      settings.indexOf('}', settings.indexOf('.settings-panel {'))
    )
    assert.match(panel, /gap:\s*var\(--space-4\)/, '一页内容之间的间距没有收紧')
  })
})

describe('③ 设备探测与缓冲合成一组（业主 ④；20260921 起在常规页的「缓存」小卡里）', () => {
  it('六个数在同一个分组里', () => {
    // 页签合并之后，这一组落在常规页签的「缓存」小卡（data-mini-card="cache"）里，
    // 右边界取常规页签那一节的 </section>（小卡内部还有 mini-card__sub 子 div，
    // 不能用第一个 </div> 当边界）。
    const group = settings.slice(
      settings.indexOf('data-mini-card="cache"'),
      settings.indexOf('</section>', settings.indexOf('data-mini-card="cache"'))
    )
    assert.ok(group.length > 0, '找不到「缓存」小卡（data-mini-card="cache"）')
    for (const key of [
      'healthCheckMs',
      'offlineThreshold',
      'requestTimeoutMs',
      'preAlarmSeconds',
      'postAlarmSeconds',
      'ringBufferSeconds'
    ]) {
      assert.ok(group.includes(`t('settingsUi.${key}')`), `合并后的那一组里少了 ${key}`)
    }
    // 同一个 `.form-grid` 里：拆成两个网格就不是"一组"了。
    assert.equal((group.match(/class="form-grid"/g) || []).length, 1, '六个数被拆成了多个网格')
  })

  it('旧的两张卡片标题连同目录键一起删掉了（留键就是留一个加回来的入口）', () => {
    for (const gone of ['settingsUi.probeSection', 'settingsUi.ringSection', 'settingsUi.storageSection', 'settingsUi.languageSection', 'settingsUi.aboutSection']) {
      assert.equal(settings.includes(gone), false, `设置页还在引用 ${gone}`)
      for (const locale of LOCALES) {
        assert.equal(
          messageAt(locale, gone),
          undefined,
          `${locale} 目录里还留着已经没有引用的 ${gone}`
        )
      }
    }
  })
})

describe('③ 账号页签承接退出登录', () => {
  it('账号页签里有：账号管理、当前会话、改密码、退出登录', () => {
    const panel = settings.slice(
      settings.indexOf("activeTab === 'account'"),
      settings.indexOf("activeTab === 'about'", settings.indexOf("activeTab === 'account'"))
    )
    assert.ok(panel.length > 0, '找不到账号页签的内容')
    assert.ok(panel.includes('<AccountManagementSection />'), '账号页签里没有账号管理')
    assert.ok(panel.includes("t('settingsUi.accountSessionGroup')"), '账号页签里没有"当前会话"这一组')
    assert.ok(panel.includes("t('authUi.changeTitle')"), '账号页签里没有"修改密码"')
    assert.ok(panel.includes("t('authUi.signOut')"), '账号页签里没有"退出登录"')
    assert.ok(panel.includes('@click="signOut"'), '退出登录按钮没有接处理器')
    assert.ok(panel.includes('session.displayName'), '账号页签没有显示当前登录的账号')
  })

  it('改密对话框与侧栏账户菜单共用**同一个**组件（密码校验只允许一处）', () => {
    const menu = stripComments(read('src/renderer/src/components/UserMenu.vue'))
    for (const [label, source] of [
      ['设置页', settings],
      ['侧栏账户菜单', menu]
    ] as const) {
      assert.ok(
        source.includes("import ChangePasswordDialog from '@renderer/components/ChangePasswordDialog.vue'"),
        `${label} 没有引入共享的改密对话框`
      )
      assert.ok(source.includes('<ChangePasswordDialog'), `${label} 没有渲染共享的改密对话框`)
    }
    // 校验规则只能写在共享组件里：两处各写一遍就会分叉。
    const dialog = read('src/renderer/src/components/ChangePasswordDialog.vue')
    assert.ok(dialog.includes('passwordProblemKey('), '共享对话框没有做口令校验')
    assert.equal(
      menu.includes('passwordProblemKey('),
      false,
      '侧栏账户菜单里还留着第二份口令校验'
    )
  })

  it('侧栏那个账户菜单还在（⑩ 还没确认要删它）', () => {
    // 业主 ③ 只要求"账号页签承接退出登录"，没有说要删掉侧栏入口；⑩（删最右侧下拉）
    // 至今没有确认。所以这里断言它**还在**，免得下一轮顺手删掉一个没被要求删的东西。
    assert.ok(settings.includes('signOut'), '设置页没有退出登录')
    const sidebar = read('src/renderer/src/components/AppSidebar.vue')
    assert.ok(sidebar.includes('<UserMenu'), '侧栏账户菜单被删掉了（⑩ 还没确认）')
  })
})
