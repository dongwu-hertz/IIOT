/**
 * 事件中心改造（《HERTZINNO Event & Alarm Center UX/UI Spec V1.0》）的**分阶段**守卫。
 *
 * 这一轮做的是规格 §18.1 的 **Phase 1（Design Tokens）与 Phase 2 的侧栏**，
 * 所以这个文件现在钉住的就是那两件事；Phase 3–6 每做完一段，往这里加一组断言
 * （文件名不再改，避免"守卫散成五份、谁也说不清哪一条对应规格哪一节"）。
 *
 * 为什么这两件事值得钉：
 *   1. **Tokens**：规格的验收项是"所有主要颜色/间距/圆角来自 token，禁止散落 magic number"。
 *      这条规矩最容易在下一个人手里破掉 —— 新组件里写一个 `#FF6A1A` 不会有任何报错。
 *   2. **侧栏折叠**：232 / 64 两个宽度、3px 橙色竖条、偏好本地保存，都是"改回旧值也不会
 *      报错"的东西（而产品口径已经写进规格）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 去掉注释：注释里会引用规格的取值（那是文档，不是生效的样式）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const css = read('src/renderer/src/assets/main.css')
const sidebar = read('src/renderer/src/components/AppSidebar.vue')

describe('Phase 1 · Design Tokens（规格 §17）', () => {
  it('规格要求的 token 名字都在（取值对齐，名字沿用我们的 `--color-*`）', () => {
    for (const token of [
      // 品牌
      '--color-accent:',
      '--color-accent-hover:',
      '--color-accent-active:',
      '--color-accent-light:',
      '--color-accent-strong:',
      // 面/文字/边框
      '--color-bg-page:',
      '--color-bg-hover:',
      '--color-text-tertiary:',
      '--color-text-disabled:',
      '--color-border:',
      '--color-border-strong:',
      // 严重度五级（文字 + 背景成对）
      '--color-severity-critical:',
      '--color-severity-critical-soft:',
      '--color-severity-high:',
      '--color-severity-high-soft:',
      '--color-severity-medium:',
      '--color-severity-medium-soft:',
      '--color-severity-low:',
      '--color-severity-low-soft:',
      '--color-severity-info:',
      '--color-severity-info-soft:',
      // 几何 / 控件 / 布局
      '--radius-card:',
      '--sidebar-collapsed:',
      '--sidebar-transition:',
      '--filter-panel:',
      '--detail-panel:',
      '--detail-panel-max:',
      '--control-height-sm:',
      '--control-height-md:',
      '--nav-row-height:',
      '--event-row-min-height:',
      '--focus-ring:',
      // 字号档位（§5.2）
      '--font-size-page-title:',
      '--font-size-section:',
      '--font-size-panel:',
      '--font-size-card:',
      '--font-size-body:',
      '--font-size-small:',
      '--font-size-meta:',
      '--font-size-label:'
    ]) {
      assert.ok(css.includes(token), `main.css 里没有 ${token}`)
    }
  })

  it('规格给的具体取值没有被改掉（抽最容易被"顺手调一下"的几个）', () => {
    const expect = (token: string, value: string): void => {
      assert.ok(
        new RegExp(`${token}\\s*:\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(css),
        `${token} 不是规格里的 ${value}`
      )
    }
    expect('--color-severity-critical', '#b42318')
    expect('--color-severity-high', '#f04438')
    expect('--color-severity-medium', '#f79009')
    expect('--color-severity-low', '#2e90fa')
    expect('--color-bg-page', '#f7f8fa')
    expect('--color-border', '#e4e7ec')
    expect('--radius-sm', '6px')
    expect('--radius-card', '8px')
    expect('--control-height-md', '36px')
    expect('--control-height-sm', '28px')
    expect('--sidebar-width', '232px')
    expect('--sidebar-collapsed', '64px')
    expect('--nav-row-height', '40px')
    expect('--event-row-min-height', '88px')
  })

  it('页面底色是页面 token、面板是白色（面板靠对比浮起来，不靠阴影）', () => {
    const content = css.slice(css.indexOf('.app-content {'), css.indexOf('.page {'))
    assert.ok(
      /background:\s*var\(--color-bg-page\)/.test(content),
      '内容区没有用页面底色 token'
    )
    assert.ok(/^\.card \{[\s\S]*?background:\s*var\(--color-bg\)/m.test(css), '卡片不是纯白面板')
    assert.ok(
      /^\.card \{[\s\S]*?border-radius:\s*var\(--radius-card\)/m.test(css),
      '卡片圆角不是 8px 那一档'
    )
  })

  it('按钮/输入框用控件高度 token（不是写死的 30px）', () => {
    assert.ok(/^\.btn \{[\s\S]*?height:\s*var\(--control-height-sm\)/m.test(css), '按钮高度不是 token')
    assert.ok(
      /^\.input,\n\.select,\n\.textarea \{[\s\S]*?height:\s*var\(--control-height-md\)/m.test(css),
      '输入框高度不是 token（规格 §9.1 要求 36px）'
    )
    assert.equal(
      /height:\s*30px/.test(stripComments(css)),
      false,
      '还有写死的 30px 控件高度（规格要求取自 token）'
    )
  })

  it('焦点环统一走 `--focus-ring`，而且不再用 outline 画（圆角按钮上 outline 会有方角）', () => {
    assert.ok(css.includes('box-shadow: var(--focus-ring)'), '没有用到 --focus-ring')
  })

  it('品牌字体栈把规格建议的字体排在最前，但**不引网络字体**', () => {
    const fontLine = /--font-sans:\s*([^;]+);/.exec(css)?.[1] ?? ''
    assert.match(fontLine, /^\s*Inter,/, '字体栈第一项不是 Inter')
    assert.ok(fontLine.includes("'Noto Sans SC'"), '字体栈里没有 Noto Sans SC')
    // 离线：不能出现 @import / url(...) 这类会联网取字体的写法。
    assert.equal(/@import\s+url|fonts\.googleapis|url\(https?:/.test(css), false, 'CSS 里出现了联网取字体')
    assert.equal(/@font-face/.test(css), false, 'CSS 里出现了 @font-face（我们不带字体文件）')
  })
})

describe('Phase 2 · 侧栏折叠（规格 §3.2 / §3.3）', () => {
  it('两个宽度来自 token，且折叠是改宽度不是换一套 DOM', () => {
    assert.ok(
      /^\.sidebar \{[\s\S]*?width:\s*var\(--sidebar-width\)/m.test(sidebar),
      '侧栏展开宽度不是 token'
    )
    assert.ok(
      /^\.sidebar--collapsed \{[\s\S]*?width:\s*var\(--sidebar-collapsed\)/m.test(sidebar),
      '折叠宽度不是 token'
    )
    assert.ok(sidebar.includes('transition: width var(--sidebar-transition)'), '折叠没有做宽度过渡')
    // 菜单项是同一批节点（Tab 顺序与读屏结果不随折叠改变）。
    assert.equal(
      (sidebar.match(/v-for="item in NAV_ITEMS"/g) ?? []).length,
      1,
      '菜单项渲染了两份（折叠时换了一套 DOM）'
    )
  })

  it('选中项：3px 橙色竖条 + 轻橙背景 + 深橙文字（不是整块高饱和橙）', () => {
    const active = sidebar.slice(sidebar.indexOf('.nav-item--active {'), sidebar.indexOf('.sidebar__footer {'))
    assert.match(active, /border-left-color:\s*var\(--color-accent\)/, '选中项没有橙色竖条')
    assert.match(active, /background:\s*var\(--color-accent-light\)/, '选中项没有用轻橙背景 token')
    assert.match(active, /color:\s*var\(--color-accent-strong\)/, '选中项文字没有用深橙 token')
    assert.ok(
      /\.nav-item \{[\s\S]*?border-left:\s*3px solid transparent/m.test(sidebar),
      '默认态没有预留 3px 竖条位置（选中时会跳一格）'
    )
    assert.match(sidebar, /min-height:\s*var\(--nav-row-height\)/, '菜单行高不是 40px 那一档')
  })

  it('折叠偏好记在 localStorage，且读写都不抛（偏好丢失不该让侧栏打不开）', () => {
    assert.ok(
      sidebar.includes("const SIDEBAR_COLLAPSED_STORAGE_KEY = 'hertzinno.sidebar.collapsed'"),
      '折叠偏好没有稳定的存储键'
    )
    const readers = sidebar.match(/localStorage\.getItem/g) ?? []
    const writers = sidebar.match(/localStorage\.setItem/g) ?? []
    assert.equal(readers.length, 1, 'localStorage 读取不是一处')
    assert.equal(writers.length, 1, 'localStorage 写入不是一处')
    assert.equal((sidebar.match(/try \{/g) ?? []).length >= 2, true, 'localStorage 读写没有各自的兜底')
  })

  it('折叠后仍然可用：按钮有可访问名字与 aria-expanded，菜单项有 title 提示', () => {
    assert.ok(sidebar.includes('data-action="sidebar-toggle"'), '折叠按钮没有探针标记')
    assert.ok(/:aria-expanded="!collapsed"/.test(sidebar), '折叠按钮没有 aria-expanded')
    assert.ok(
      sidebar.includes("collapsed ? t('app.expandSidebar') : t('app.collapseSidebar')"),
      '折叠按钮没有随状态切换的可访问名字'
    )
    assert.ok(
      sidebar.includes(':title="collapsed ? t(item.labelKey) : undefined"'),
      '折叠后菜单项没有 title 提示'
    )
    // 折叠只是隐藏文字，标签节点仍在（读屏仍然念得出这一项叫什么）。
    assert.equal(
      /sidebar--collapsed[\s\S]{0,200}nav-item__label[\s\S]{0,80}display:\s*none/.test(sidebar),
      true,
      '折叠后没有隐藏菜单文字'
    )
  })
})

// ---------------------------------------------------------------------------
// Phase 3：KPI 条 / 筛选面板 / 告警队列（规格 §8–§11）
// ---------------------------------------------------------------------------

const kpiStrip = read('src/renderer/src/components/event-center/EventKpiStrip.vue')
const filterPanel = read('src/renderer/src/components/event-center/EventFilterPanel.vue')
const alertQueue = read('src/renderer/src/components/event-center/AlertQueue.vue')
const eventView = read('src/renderer/src/views/EventCenterView.vue')
const eventViewDomain = read('src/shared/domain/event-view.ts')

/** 新组件里不许出现写死的颜色（工程规则：颜色只在 main.css 的 token 里）。 */
function expectNoHardcodedColor(source: string, name: string): void {
  const live = stripComments(source)
  const hits = live.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g) ?? []
  assert.deepEqual(hits, [], `${name} 里出现了写死的颜色：${hits.join(', ')}`)
}

describe('Phase 3 · 严重度五级与队列行（规格 §2.3 / §10）', () => {
  it('main.css 里五档严重度各自给出强调色与软背景两个变量', () => {
    for (const severity of ['critical', 'high', 'medium', 'low', 'info']) {
      const block = new RegExp(
        `\\.severity--${severity} \\{[\\s\\S]*?--severity-accent:\\s*var\\(--color-severity-${severity}\\)[\\s\\S]*?--severity-soft:\\s*var\\(--color-severity-${severity}-soft\\)`
      )
      assert.match(css, block, `\`.severity--${severity}\` 没有把两个变量都指到 token`)
    }
    // 「等级未知」不是一档等级色：它必须用中性色，否则会被读成"某一级"。
    assert.match(
      css,
      /\.severity--unknown \{[\s\S]*?--severity-accent:\s*var\(--color-text-disabled\)/,
      '等级未知没有用中性色（会被读成一个真实等级）'
    )
  })

  it('队列行：3px 左侧色条 + 行高变量 + 键盘焦点环', () => {
    const row = css.slice(css.indexOf('.alert-row {'), css.indexOf('.alert-row:focus-visible'))
    assert.match(row, /border-left:\s*3px solid var\(--severity-accent/, '队列行没有 3px 严重度色条')
    assert.match(
      row,
      /min-height:\s*var\(--event-row-mode-height,\s*var\(--event-row-min-height\)\)/,
      '队列行没有用行高变量（三档模式会顶不动）'
    )
    assert.match(css, /\.alert-row:focus-visible \{[\s\S]*?box-shadow:\s*var\(--focus-ring\)/, '队列行没有焦点环')
  })

  it('三档行高：标准 88 / 证据 104 来自规格，紧凑比标准矮', () => {
    assert.match(eventViewDomain, /standard:\s*88/, '标准行高不是规格给的 88')
    assert.match(eventViewDomain, /evidence:\s*104/, '证据行高不是规格给的 104')
    const compact = /compact:\s*(\d+)/.exec(eventViewDomain)?.[1] ?? ''
    assert.ok(Number(compact) > 0 && Number(compact) < 88, '紧凑行高没有比标准矮')
    assert.ok(alertQueue.includes('--event-row-mode-height'), '队列没有把行高传给行')
  })

  it('新组件里没有写死的颜色（颜色只在 main.css 的 token 里）', () => {
    expectNoHardcodedColor(kpiStrip, 'EventKpiStrip.vue')
    expectNoHardcodedColor(filterPanel, 'EventFilterPanel.vue')
    expectNoHardcodedColor(alertQueue, 'AlertQueue.vue')
  })

  it('队列的等级文案走适配器：`unknown` 显示「等级未知」，不装成「提示」', () => {
    assert.ok(
      alertQueue.includes("t('eventsUi.severityUnknown')"),
      '队列没有把"等级认不出来"单独说出来'
    )
    assert.ok(
      alertQueue.includes('alertSeverityLabelKey(alert.severity)'),
      '队列没有用等级标签键（自己拼文案就会与筛选面板分叉）'
    )
    assert.ok(
      alertQueue.includes("severityUnknown ? 'severity--unknown'"),
      '等级未知没有走中性的严重度类'
    )
  })

  it('队列的键盘：↑/↓ 移动选中并同步焦点（告警风暴里是连着按的）', () => {
    assert.ok(alertQueue.includes('@keydown.down.prevent="move(1)"'), '没有 ↓ 移动')
    assert.ok(alertQueue.includes('@keydown.up.prevent="move(-1)"'), '没有 ↑ 移动')
    assert.ok(alertQueue.includes('.focus()'), '移动选中时没有把焦点带上')
    // 整行是 button：可 Tab、Enter/空格可开（这是不用 div 的理由，注释里写了）。
    assert.match(alertQueue, /<button[\s\S]{0,400}?class="alert-row"/, '队列行不是 button')
  })

  it('等级文字每一档都印（紧凑模式也一样）：颜色不许是唯一的信息', () => {
    // 左侧色条是颜色，规格 §15.3 要求不靠颜色单独表意 —— 所以正文里必须有那两个字。
    const head = alertQueue.slice(alertQueue.indexOf('alert-row__head'), alertQueue.indexOf('alert-row__meta'))
    assert.ok(head.includes('alert-row__severity'), '紧凑模式的正文里没有等级文字（只剩颜色）')
    assert.ok(head.includes('severityLabel(alert)'), '正文里的等级不是走标签函数来的')
  })
})

describe('Phase 3 · KPI 条与筛选（规格 §8 / §9）', () => {
  it('KPI 条只画四格：严重 / 高 / 未确认 / 平均确认耗时（聚合事件是 Phase 6）', () => {
    assert.ok(kpiStrip.includes("t('eventsUi.alertSeverity.critical')"), '没有严重那一格')
    assert.ok(kpiStrip.includes("t('eventsUi.alertSeverity.high')"), '没有高那一格')
    assert.ok(kpiStrip.includes("t('eventsUi.kpiUnacknowledged')"), '没有未确认那一格')
    assert.ok(kpiStrip.includes("t('eventsUi.kpiAvgAck')"), '没有平均确认耗时那一格')
    // 聚合事件（Incidents）在 Phase 6 之前不渲染：一个恒为 0 的格子会被读成"聚合过了"。
    assert.equal(kpiStrip.includes('incidents'), false, 'KPI 条渲染了还没实现的聚合事件')
  })

  it('平均确认耗时拿不到时显示「—」而不是 0（`avgAckMs` 恒为 null）', () => {
    assert.ok(
      kpiStrip.includes('props.kpis.avgAckMs === null ? null : props.kpis.avgAckMs / 1000'),
      '没有把"没有确认时刻"当成 0 秒'
    )
    assert.ok(kpiStrip.includes(':value="avgAckSeconds"'), '那一格没有把换算结果接上')
    assert.match(
      eventViewDomain,
      /avgAckMs:\s*null,[\s\S]{0,80}incidents:\s*null/,
      '视图模型没有如实声明这两个数拿不到'
    )
  })

  it('KPI 与计数都写明作用域（只统计已加载的那一页）', () => {
    assert.ok(kpiStrip.includes("t('eventsUi.kpiScope'"), 'KPI 条没有印作用域')
    assert.ok(filterPanel.includes("t('eventsUi.panelScope'"), '筛选面板没有印作用域')
    assert.ok(kpiStrip.includes("t('eventsUi.kpiScope'"), 'KPI 条缺少作用域说明')
  })

  it('KPI 可点：严重/高/未确认三格把筛选打开或关掉', () => {
    assert.ok(kpiStrip.includes('@click="toggleSeverity(\'critical\')"'), '严重那一格不可点')
    assert.ok(kpiStrip.includes('@click="toggleSeverity(\'high\')"'), '高那一格不可点')
    assert.ok(kpiStrip.includes('@click="toggleAck(\'unacknowledged\')"'), '未确认那一格不可点')
    assert.ok(kpiStrip.includes(':aria-pressed='), '可点的 KPI 没有 aria-pressed')
    assert.ok(eventView.includes('@filter="patchFilter"'), 'KPI 与筛选没有接上')
  })

  it('筛选面板四组都带计数，且"计数为 0 也能点"（它们是筛选，不是统计）', () => {
    for (const group of [
      'eventsUi.filterSeverity',
      'eventsUi.filterSource',
      'eventsUi.filterAck',
      'eventsUi.filterDevice'
    ]) {
      assert.ok(filterPanel.includes(`t('${group}')`), `筛选面板没有「${group}」这一组`)
    }
    assert.equal(
      (filterPanel.match(/panelCount/g) ?? []).length >= 4,
      true,
      '分组计数没有逐组给出'
    )
    assert.ok(eventView.includes('@patch="patchFilter"'), '筛选面板与页面没有接上')
  })

  it('筛选面板只列**真的会出现**的等级（medium / low 没有代码路径能产生）', () => {
    assert.ok(
      filterPanel.includes('VISIBLE_ALERT_SEVERITIES'),
      '筛选面板没有用"会出现的那几档"常量（会画出永远搜不到的选项）'
    )
    assert.equal(filterPanel.includes("'medium'"), false, '筛选面板列出了 medium')
    assert.equal(filterPanel.includes("'low'"), false, '筛选面板列出了 low')
    assert.ok(filterPanel.includes("t('eventsUi.severityUnknown')"), '筛选面板没有「等级未知」')
  })

  it('五档等级与五个状态**每一档都有四语言文案**（少一个名字，Phase 5 那天就会渲染出裸 key）', () => {
    for (const locale of ['zh-CN', 'en', 'es', 'tr']) {
      const catalogue = read(`src/shared/i18n/messages/${locale}.ts`)
      const severityBlock = catalogue.slice(
        catalogue.indexOf('alertSeverity: {'),
        catalogue.indexOf('alertStatus: {')
      )
      for (const severity of ['critical', 'high', 'medium', 'low', 'info']) {
        assert.ok(
          new RegExp(`\\b${severity}:`).test(severityBlock),
          `${locale} 的 alertSeverity 里缺少 ${severity}`
        )
      }
      const statusBlock = catalogue.slice(
        catalogue.indexOf('alertStatus: {'),
        catalogue.indexOf('severityUnknown:')
      )
      for (const status of ['new', 'acknowledged', 'investigating', 'resolved', 'closed']) {
        assert.ok(
          new RegExp(`\\b${status}:`).test(statusBlock),
          `${locale} 的 alertStatus 里缺少 ${status}`
        )
      }
    }
  })

  it('筛选面板的选项数与来源数一致（来源少了就等于把数据藏了）', () => {
    assert.ok(filterPanel.includes('EVENT_SOURCE_KINDS.map'), '来源选项没有按领域常量生成')
    assert.ok(
      filterPanel.includes('devices.length > 0'),
      '设备组没有处理"一台设备都没有"的情况'
    )
  })
})

describe('Phase 3 · 记忆与作用域（规格 §9.5 / §16.3）', () => {
  it('筛选与视图模式各自一个 localStorage 键，读写都在 try/catch 里', () => {
    assert.ok(
      eventView.includes("window.localStorage.getItem(EVENT_FILTER_STORAGE_KEY)"),
      '没有读回上次的筛选'
    )
    assert.ok(
      eventView.includes('window.localStorage.setItem(EVENT_FILTER_STORAGE_KEY'),
      '没有记住本次筛选'
    )
    assert.ok(
      eventView.includes('window.localStorage.setItem(EVENT_VIEW_MODE_STORAGE_KEY, mode)'),
      '没有记住视图模式'
    )
    assert.equal(
      (eventView.match(/try \{/g) ?? []).length >= 3,
      true,
      'localStorage 的读写没有各自的兜底'
    )
  })

  it('地址栏同步：URL > localStorage，且"地址里写了空筛选"不会被旧条件顶回来', () => {
    assert.ok(eventView.includes('hasEventFilterQuery(query)'), '没有区分"地址里没写筛选"')
    assert.ok(
      eventView.includes('void router.replace({ query: eventFilterToQuery(filters) })'),
      '筛选没有写回地址栏'
    )
    assert.ok(
      eventView.indexOf('eventFilterFromQuery(query)') <
        eventView.indexOf('EVENT_FILTER_STORAGE_KEY)'),
      'URL 的优先级没有高于 localStorage'
    )
  })

  it('关键字只在已加载的那一页里搜，而且把这件事印出来', () => {
    assert.ok(
      eventView.includes('matchEventSearch(alert, filters.search, eventKindLabel(alert.kind))'),
      '关键字没有走纯函数（自己实现就会与用例分叉）'
    )
    assert.ok(eventView.includes("t('eventsUi.searchScope'"), '没有说明搜索的作用域')
  })

  it('内置视图是一组筛选，点一下写进同一份筛选状态', () => {
    assert.ok(eventView.includes('applySavedView(view)'), '内置视图没有接上')
    assert.ok(eventView.includes('savedViewFromMs(view, Date.now())'), '时间视图没有算窗口')
    assert.equal(
      /v-for="view in EVENT_SAVED_VIEWS"/.test(eventView),
      true,
      '内置视图没有按常量渲染'
    )
  })

  it('来源读况只在**有话说**时出现（三路正常时它只是三行绿字，却占掉第一屏）', () => {
    assert.ok(
      eventView.includes('v-if="sourcesNeedAttention"'),
      '来源读况没有按"是否失败/截断"条件渲染'
    )
    assert.match(
      eventView,
      /sourcesNeedAttention = computed\(\(\) =>[\s\S]{0,200}?!source\.ok \|\| source\.truncated > 0/,
      '来源读况的条件不是"某一路失败或被截断"'
    )
  })

  it('旧的表格已经拆掉（队列取代了它），但详情抽屉的确认/下载逻辑还在', () => {
    assert.equal(
      /<table class="table">/.test(stripComments(eventView)),
      false,
      '旧的事件表格还在（队列已经取代它）'
    )
    assert.ok(eventView.includes('<AlertQueue'), '页面没有挂上队列')
    assert.ok(eventView.includes('toggleAcknowledge'), '确认逻辑被删掉了')
    assert.ok(eventView.includes('downloadFile('), '结果文件下载逻辑被删掉了')
  })

  it('Esc 关抽屉（监听在 window 上，且只在抽屉开着时响应）', () => {
    assert.ok(
      eventView.includes("if (event.key === 'Escape' && detail.value) closeDetail()"),
      'Esc 没有关抽屉'
    )
    assert.ok(eventView.includes("window.addEventListener('keydown', onWindowKeydown)"), '没有挂上键盘监听')
    assert.ok(
      eventView.includes("window.removeEventListener('keydown', onWindowKeydown)"),
      '卸载时没有摘掉键盘监听'
    )
  })
})

