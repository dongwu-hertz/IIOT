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
const drawer = read('src/renderer/src/components/event-center/EventDetailDrawer.vue')
const eventView = read('src/renderer/src/views/EventCenterView.vue')
const store = read('src/renderer/src/stores/eventCenter.ts')
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

  it('筛选记在地址栏与本机，并且**取消筛选真的取消得掉**', () => {
    assert.ok(
      eventView.includes('void router.replace({ query: eventFilterToQuery(filters) })'),
      '筛选没有写回地址栏'
    )
    /*
     * `applyQuery` 必须**替换**查询，不能在旧查询上打补丁。
     *
     * 这是 2026-09-18 由 GUI 探针抓到的**真缺陷**：页面侧的 `buildQuery()` 只带上生效的筛选
     * （取消一个筛选 = 补丁里没有那个键），而 `{...query.value, ...patch}` 会把它留在 query 里
     * —— 点「清除全部」之后界面写着"没有筛选"，查询却仍然按旧的等级过滤，页面显示
     * 「本次筛选命中 0 条事件」。探针报的是"清掉筛选之后队列仍然是空的：0"。
     */
    assert.match(
      stripComments(store),
      /async function applyQuery\(patch: Partial<EventCenterQuery>\): Promise<void> \{[\s\S]{0,200}?query\.value = \{ \.\.\.emptyQuery\(\), \.\.\.patch, offset: 0 \}/,
      'applyQuery 没有从干净的一页开始（取消筛选会取消不掉）'
    )
    // `setQuery`（打补丁）本身是对的；错的是"换筛选时也打补丁"。
    assert.equal(
      /query\.value = \{ \.\.\.query\.value, \.\.\.patch, offset: 0 \}/.test(stripComments(store)),
      false,
      'applyQuery 还在旧查询上打补丁（取消筛选会留在 query 里）'
    )
  })

  it('地址栏同步：URL > localStorage，且"地址里写了空筛选"不会被旧条件顶回来', () => {
    assert.ok(eventView.includes('hasEventFilterQuery(query)'), '没有区分"地址里没写筛选"')
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
    // 确认从 Phase 5 起是**一次状态变更**（`onStatusAction`）：不再有单独的确认函数。
    assert.ok(eventView.includes('onStatusAction'), '处置逻辑不在（确认/指派/解决都走它）')
    assert.ok(eventView.includes('downloadFile('), '结果文件下载逻辑被删掉了')
  })

  it('Esc 关抽屉由抽屉组件负责（监听在 window 上，↑/↓ 只在焦点位于抽屉内时才接管）', () => {
    assert.ok(drawer.includes("if (event.key === 'Escape')"), 'Esc 没有关抽屉')
    assert.ok(
      drawer.includes("window.addEventListener('keydown', onWindowKeydown)"),
      '没有挂上键盘监听'
    )
    assert.ok(
      drawer.includes("window.removeEventListener('keydown', onWindowKeydown)"),
      '卸载时没有摘掉键盘监听'
    )
    // ↑/↓ 与队列自己的键盘入口会打架：抽屉只在焦点落到自己身上时才接管（一次按键跳两条
    // 是一个很难查的"跳着走"缺陷）。
    assert.match(
      drawer,
      /drawerRef\.value\?\.contains\(node\)[\s\S]{0,120}?return/,
      '抽屉在 window 上无条件接管了 ↑/↓（会与队列的 ↑/↓ 重复触发）'
    )
    // 页面里不该再留一份窗口监听（两份监听会让 Esc 关两次、↑/↓ 跳两条）。
    assert.equal(
      eventView.includes("window.addEventListener('keydown'"),
      false,
      '页面里还有一份窗口键盘监听'
    )
  })
})

// ---------------------------------------------------------------------------
// Phase 4：详情抽屉 / Overview / Evidence（规格 §11–§12）
// ---------------------------------------------------------------------------

describe('Phase 4 · 抽屉本体（规格 §11）', () => {
  it('抽屉是独立组件，页面只负责塞内容（结构在组件里，动作在页面里）', () => {
    assert.ok(eventView.includes('<EventDetailDrawer'), '页面没有挂上抽屉组件')
    assert.ok(
      eventView.includes("import EventDetailDrawer from '@renderer/components/event-center/EventDetailDrawer.vue'"),
      '抽屉组件的导入路径不对'
    )
    // 旧的内联抽屉必须拆干净：留着就是两份头部/两份宽度逻辑。
    assert.equal(
      /<aside class="drawer"/.test(stripComments(eventView)),
      false,
      '页面里还留着旧的内联抽屉'
    )
    for (const slot of ['overview', 'evidence', 'timeline', 'related', 'activity']) {
      assert.ok(drawer.includes(`<slot name="${slot}" />`), `抽屉没有 ${slot} 插槽`)
    }
    /*
     * 处置按钮**在抽屉里**（它要知道状态与表单），写库由页面做（`status-action` 事件）——
     * Phase 4 的 `#actions` 插槽已经拆掉了：一个槽位塞一行按钮，谁也不知道那一行是什么。
     */
    assert.equal(drawer.includes('<slot name="actions" />'), false, '旧的 actions 插槽还在')
    assert.ok(drawer.includes("(event: 'status-action'"), '抽屉没有把处置动作交给页面')
    assert.ok(eventView.includes('@status-action="onStatusAction"'), '页面没有接住处置动作')
  })

  it('宽度 400–560：常量来自纯函数层，抓手带 role=separator 与 min/max', () => {
    assert.match(eventViewDomain, /DETAIL_DRAWER_MIN = 400/, '最小宽度不是规格的 400')
    assert.match(eventViewDomain, /DETAIL_DRAWER_MAX = 560/, '最大宽度不是规格的 560')
    assert.ok(drawer.includes('role="separator"'), '拖拽抓手没有 separator 角色')
    assert.ok(drawer.includes(':aria-valuemin="DETAIL_DRAWER_MIN"'), '抓手没有报告最小值')
    assert.ok(drawer.includes(':aria-valuemax="DETAIL_DRAWER_MAX"'), '抓手没有报告最大值')
    assert.ok(drawer.includes('data-action="drawer-resize"'), '抓手没有探针标记')
    assert.ok(drawer.includes('@mousedown="onResizeStart"'), '抓手不能拖')
    // 拖的时候用 clientX 的差值：movementX 累加会漂。
    assert.ok(drawer.includes('event.clientX - dragStartX'), '拖拽算法没有用起点差值')
    assert.ok(drawer.includes('clampDrawerWidth('), '宽度没有夹到 400–560')
    /*
     * **宽度必须真的绑到元素上**。
     *
     * 这一条是探针抓到的真缺陷：第一版算了 `width`、也写进了 localStorage，
     * 但 `.drawer` 的宽度只由 CSS 的 `var(--detail-panel)` 给，于是"存了 416、
     * 看起来还是 400"—— 拖了没反应，而所有断言（含 aria）都是绿的。
     */
    assert.match(
      drawer,
      /:style="\{ width: `\$\{width\}px` \}"/,
      '抽屉没有把宽度绑到元素上（拖了/改了宽度但看起来不变）'
    )
  })

  it('宽度偏好记在 localStorage（页面侧的受控宽度 + 一个读点一个写点）', () => {
    assert.ok(
      eventView.includes('window.localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY)'),
      '没有读回上次的抽屉宽度'
    )
    assert.ok(
      eventView.includes('window.localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY'),
      '没有记住抽屉宽度'
    )
    assert.match(eventViewDomain, /DRAWER_WIDTH_STORAGE_KEY = 'hertzinno\.eventCenter\.drawerWidth'/, '存储键不对')
  })

  it('页签条只渲染**已经做出来**的页签，且选中态是 2px 橙线不是整块橙', () => {
    assert.ok(
      drawer.includes('v-for="item in IMPLEMENTED_DETAIL_TABS"'),
      '页签条没有按"已实现的页签"渲染（会画出空的页签）'
    )
    assert.ok(drawer.includes('role="tablist"'), '页签条没有 tablist 角色')
    assert.ok(drawer.includes(':aria-selected="tab === item"'), '页签没有 aria-selected')
    const tabBlock = drawer.slice(drawer.indexOf('.drawer__tab {'), drawer.indexOf('.drawer__body {'))
    assert.match(tabBlock, /height:\s*40px/, '页签高度不是规格的 40px')
    assert.match(tabBlock, /border-bottom:\s*2px solid transparent/, '页签没有预留 2px 下划线位置')
    assert.match(
      tabBlock,
      /\.drawer__tab--active \{[\s\S]*?border-bottom-color:\s*var\(--color-accent\)/,
      '选中页签的下划线不是橙色 token'
    )
    assert.match(tabBlock, /\.drawer__tab--active \{[\s\S]*?color:\s*var\(--color-text\)/, '选中页签文字没有变深')
    assert.equal(
      /\.drawer__tab--active \{[\s\S]{0,200}?background:\s*var\(--color-accent\)/.test(tabBlock),
      false,
      '选中页签被填成了整块橙色（规格明确禁止）'
    )
  })

  it('五个页签都在了（Phase 5 把 Timeline / Related / Activity 补上）', () => {
    assert.match(
      eventViewDomain,
      /IMPLEMENTED_DETAIL_TABS[\s\S]{0,200}?'overview',\s*'evidence',\s*'timeline',\s*'related',\s*'activity'/,
      '已实现的页签不是五个'
    )
    for (const slot of ['timeline', 'related', 'activity']) {
      assert.ok(eventView.includes(`<template #${slot}>`), `页面没有提供 ${slot} 页签的内容`)
    }
  })

  it('头部动作由**状态机**决定：主 CTA 恰好一个，没有确认接口的来源不出现「确认」', () => {
    assert.ok(drawer.includes('statusActionsFor(props.alert.status'), '头部动作没有走状态机纯函数')
    assert.ok(drawer.includes("locked: props.alert.statusLocked"), '没有把"没有确认接口"传进状态机')
    assert.ok(drawer.includes('data-action="status-primary"'), '主 CTA 没有探针标记')
    assert.ok(drawer.includes('data-status-action'), '次要动作没有探针标记')
    // 指派只在有可选账户时出现（点开一个空列表比没有按钮更糟）。
    assert.ok(drawer.includes("canAssign: (props.assignees?.length ?? 0) > 0"), '指派的可用性没有看账户列表')
    // 需要输入的动作（指派/重新开启）走行内表单，不是再叠一层弹窗。
    assert.ok(drawer.includes('data-action="status-form"'), '没有需要输入的动作表单')
    assert.ok(drawer.includes('data-field="assignee"'), '指派表单里没有账户选择')
    assert.ok(drawer.includes('data-field="note"'), '重新开启的表单里没有原因输入')
    assert.ok(drawer.includes("t('eventsUi.actionNoteEmpty')"), '空白原因没有提示')
  })

  it('头部有等级、标题、设备链接、首次探测时间与一个主 CTA（规格 §11.2）', () => {
    assert.ok(drawer.includes('drawer__severity'), '头部没有等级')
    assert.ok(drawer.includes('t(alert.titleKey)'), '头部标题没有走目录键')
    assert.ok(drawer.includes("emit('open-device')"), '头部的设备名不可点（进不了设备详情页）')
    assert.ok(
      drawer.includes('formatRelativeTime(props.alert.firstDetectedAt)'),
      '头部没有"首次探测到多久以前"'
    )
    assert.ok(drawer.includes('data-action="status-primary"'), '头部没有主 CTA')
    assert.ok(drawer.includes('class="btn btn--primary btn--sm"'), '主 CTA 不是 primary 按钮')
  })

  it('处置写完**重查**、且不关抽屉（规格 §15.1：确认后更新状态、写 Activity、不关 Drawer）', () => {
    assert.ok(eventView.includes('window.api.eventCenter.changeStatus('), '页面没有调用处置 IPC')
    assert.ok(eventView.includes('await store.applyQuery(buildQuery())'), '处置之后没有重查')
    assert.equal(
      /async function onStatusAction[\s\S]{0,2000}?await reload\(\)/.test(eventView),
      false,
      '处置之后走了 reload()（它会关抽屉，违反"不关 Drawer"）'
    )
    assert.ok(eventView.includes("store.notice"), '处置成功没有回执')
    assert.ok(eventView.includes('currentStatus: current.status'), '指派没有把当前状态带下去')
    // 状态变了，q队列里的状态徽标要跟着变：视图模型的 status 来自服务端合并。
    assert.ok(eventView.includes('window.api.eventCenter.activity('), '没有读处置记录')
  })

  it('三个新页签的内容来自纯函数（时间线 / 相关性 / 处置记录）', () => {
    assert.ok(eventView.includes('alertTimeline(detail.value, activities.value'), '时间线没有走纯函数')
    assert.ok(eventView.includes('activityRows(activities.value)'), '处置记录没有走纯函数')
    assert.ok(eventView.includes('relatedGroups(detail.value, alerts.value)'), '相关性没有走纯函数')
    // 相关性按钮点了要能切到那一条（"相关"必须可操作，否则就只是一堆数字）。
    assert.ok(eventView.includes('openRelated(id)'), '相关性分组不可点')
    // 相关性只在已加载的那一页里找 —— 这件事要印出来。
    assert.ok(eventView.includes("t('eventsUi.relatedScope'"), '没有说明相关性的作用域')
    // 时间线与处置记录都用同一批行（同一份事实，两种排法）。
    assert.ok(eventView.includes("t('eventsUi.activityStatusLine'"), '处置记录没有写成一句人话')
  })

  it('Overview 用属性网格（2 列，长字段跨两列），字段来自纯函数', () => {
    assert.ok(eventView.includes('alertOverviewFields(detail.value)'), 'Overview 没有用纯函数的字段表')
    assert.ok(eventView.includes('drawer__field--wide'), '没有跨两列的字段处理')
    const grid = drawer.slice(drawer.indexOf('.drawer__grid {'), drawer.indexOf('.drawer__field--wide'))
    assert.match(grid, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/, '属性网格不是 2 列')
    assert.match(
      drawer,
      /\.drawer__field--wide \{[\s\S]*?grid-column:\s*1 \/ -1/,
      '长字段没有跨两列'
    )
    // 「—」那一档必须在：持续时长在聚合之前、没有确认能力的来源状态都用它。
    assert.ok(eventView.includes('<template v-else>—</template>'), '空值没有渲染成「—」')
  })

  it('Evidence 按来源选渲染器（Acoustic 一条；DTS/DAS/DGA 不做）', () => {
    assert.ok(
      eventView.includes('evidenceImageSource(alert, deviceKind)'),
      'Evidence 没有走"图从哪来"的纯函数（也没把机型传进去）'
    )
    assert.ok(
      eventView.includes('devices.devices.find((device) => device.id === alert.deviceId)?.kind'),
      '没有把设备机型传进去（AE08 会被拿去问一个不存在的抓图接口）'
    )
    assert.ok(
      eventView.includes("window.api.eventCenter.evidenceImage("),
      '联动抓帧没有走新的回环图片接口'
    )
    assert.ok(
      eventView.includes('window.api.e2.alarmSnapshots('),
      '声纹告警的球机抓图没有复用已有接口（重复造了一份）'
    )
    assert.ok(eventView.includes('evidenceImageNote()'), '四种取不到图的情况没有各自的说法')
    assert.ok(eventView.includes('closeEvidenceImage()'), '关抽屉时没有关掉图片端点')
    // 四种 state 的文案都在目录里（缺一个就会印出裸 key）。
    for (const key of [
      'evidenceNotCaptured',
      'evidenceFilesGone',
      'evidenceNotImage',
      'evidenceNotFound',
      'evidenceError'
    ]) {
      assert.ok(eventView.includes(`eventsUi.${key}`), `缺少 ${key} 的说法`)
    }
  })

  it('抽屉与队列的 ↑/↓ 不会互相打架：抽屉只在焦点落到自己身上时接管', () => {
    assert.ok(drawer.includes("emit('prev')"), '抽屉没有 ↑ 换条')
    assert.ok(drawer.includes("emit('next')"), '抽屉没有 ↓ 换条')
    assert.ok(drawer.includes("key === 'k'"), '抽屉没有支持 J/K')
    assert.ok(eventView.includes('stepAlert(-1)'), '页面的 ↑ 换条没有接上')
    assert.ok(eventView.includes('stepAlert(1)'), '页面的 ↓ 换条没有接上')
  })

  it('新组件里没有写死的颜色', () => {
    expectNoHardcodedColor(drawer, 'EventDetailDrawer.vue')
  })
})

// ---------------------------------------------------------------------------
// Phase 6：重复触发聚合（规格 §14.1）
// ---------------------------------------------------------------------------

describe('Phase 6 · 重复触发聚合（规格 §14.1）', () => {
  it('聚合在**主进程**做，并且按告警数分页（总数与列表必须同一个单位）', () => {
    const service = read('src/main/services/events/event-center-service.ts')
    assert.ok(service.includes('groupEvents(pool, groupWindowMs)'), '服务端没有做聚合')
    assert.ok(service.includes('representativeOf(group)'), '没有取组里的代表那一条')
    assert.match(
      stripComments(service),
      /total:\s*groups\.length/,
      'total 不是告警数（会与列表里的行数对不上）'
    )
    // 窗口没给时**不聚合**：界面永远显式带上窗口，API 的行为不该被一个界面默认值绑住。
    assert.match(
      stripComments(service),
      /function clampGroupWindow\(value: number \| undefined\): number \{[\s\S]{0,200}?return 0/,
      'API 缺省变成了"聚合"（一个界面默认值的改动会悄悄改掉所有调用方）'
    )
    // 窗口有上限：太大就不是聚合，是把数据藏起来。
    assert.ok(
      service.includes('EVENT_CENTER_MAX_GROUP_WINDOW_MS'),
      '聚合窗口没有上限'
    )
  })

  it('界面：聚合窗口是查询参数（改了要重查）、四档、跟着 URL 与本机记住', () => {
    assert.ok(eventView.includes('query.groupWindowMs = groupWindowMsFor(filters.groupWindow)'), '查询没有带上聚合窗口')
    assert.ok(
      eventView.includes('filters.groupWindow'),
      '改了聚合窗口不会重新查询（它没进查询字段的 watch 列表）'
    )
    assert.match(
      stripComments(eventView),
      /watch\(\s*\(\) => \[[\s\S]{0,400}?filters\.groupWindow[\s\S]{0,200}?void reload\(\)/,
      '聚合窗口不在"改了要重查"的那一组里'
    )
    assert.ok(eventView.includes('data-field="group-window"'), '筛选栏里没有聚合窗口的下拉（探针要它）')
    assert.ok(eventView.includes('GROUP_WINDOW_CHOICES'), '下拉没有按常量渲染（四档）')
    assert.match(
      eventViewDomain,
      /id: 'off'[\s\S]{0,200}?id: '10m'[\s\S]{0,200}?id: '30m'[\s\S]{0,200}?id: '1h'/,
      '四档的取值不对'
    )
  })

  it('队列行带"×N"，但只在真的聚合了才画（×1 是噪声）', () => {
    assert.ok(
      alertQueue.includes("t('eventsUi.occurrenceCount', { count: alert.occurrenceCount })"),
      '队列没有显示触发次数'
    )
    assert.match(
      alertQueue,
      /v-if="alert\.occurrenceCount > 1"/,
      '次数没有条件渲染（每条都挂一个 ×1）'
    )
  })

  it('时间线保留原始明细：第 2..N 次触发各占一个节点', () => {
    assert.ok(eventView.includes("t('eventsUi.timelineOccurrence'"), '时间线里没有"第 N 次触发"')
    assert.ok(eventViewDomain.includes("kind: 'occurrence'"), '时间线没有 occurrence 节点')
  })

  it('一次处置落到组内每一条，回执说清改了几条', () => {
    assert.ok(
      eventView.includes('current.members.map((m) => m.id)'),
      '处置没有带上组内其它触发（只处置了代表那一条）'
    )
    assert.ok(eventView.includes("t('eventsUi.statusChangeDoneMany'"), '多条处置没有说清改了几条')
    assert.ok(eventViewDomain.includes('appliedTo: number'), '结果里没有"一起改了几条"')
  })

  it('状态合并按**组**：组里任何一条被处置过，整条告警就算处置过', () => {
    const service = read('src/main/services/events/event-center-service.ts')
    assert.match(
      stripComments(service),
      /groupMembers[\s\S]{0,200}?statusMap\(items\.flatMap\(memberIds\)\)/,
      '状态只按代表那一条查（组内更早的处置会丢）'
    )
  })
})

