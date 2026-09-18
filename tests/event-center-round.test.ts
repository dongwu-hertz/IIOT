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
