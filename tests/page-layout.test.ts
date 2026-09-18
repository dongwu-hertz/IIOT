/**
 * 页面内容列的对齐与流式宽度（产品要求：「软件全屏后，总览、设备管理等右侧的内容应该是
 * 左对齐，无论窗口的大小都应该是和左边和上边都保持固定的距离，现在是中间对齐了。」
 * ＋「软件应该支持不同的分辨率，自适应窗口大小和显示。」）。
 *
 * WHY THIS FILE EXISTS
 * 这两条要求最终落在一条 CSS 规则上：`.page` 曾经是
 * `max-width: var(--content-max-width); margin: 0 auto;`（1440px 的定宽居中列）。
 * 改成流式之后，**任何**把定宽或自动外边距加回来的改动都会让产品要求失效，而源码
 * 看起来仍然「有布局」—— 这正是上一轮漏掉它的原因。
 *
 * 真实窗口里四档尺寸的测量在 `scripts/video-proof-driver.cjs`（那是一次真机运行，
 * 量 `.page` 的左边距、上边距与宽度）。这里钉的是源码层面的约束：回归在一次单测里
 * 就说出来，而不是等一次浏览器运行；两层证据的分工写在这里，免得以后有人以为
 * 「单测过了就等于屏幕上对了」。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 去掉 CSS 注释：注释里会提到选择器与属性名，注释不是生效的声明。 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 去掉 `.vue` 里的**全部**注释（HTML、CSS、行注释、块注释）。
 *
 * 为什么需要它：这类"某个东西已经删掉"的断言，最容易被**解释性的注释**绊倒 ——
 * 注释里写着"这里原来挂过 `CameraAcousticPanel`，为什么删"正是给下一个人看的，
 * 而它长得和"又挂回来了"一模一样。`stripCssComments` 只去 CSS 注释，不够用。
 */
function stripComments(source: string): string {
  return stripCssComments(source)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 取出一对标记之间的源码；找不到就断言失败（改名/删除必须报出来，不能静默通过）。 */
function between(source: string, open: string, close: string, label: string): string {
  const start = source.indexOf(open)
  assert.ok(start >= 0, `找不到 ${label} 的起点：${open}`)
  const end = source.indexOf(close, start + open.length)
  assert.ok(end > start, `找不到 ${label} 的终点：${close}`)
  return source.slice(start, end)
}

/**
 * 取出一条规则的花括号内容。
 *
 * 这个仓库的 CSS 没有嵌套规则（`@media` / `@keyframes` 里的规则仍然可以按选择器
 * 找到），所以按「选择器 {」到下一个 `}` 截取就够了；找不到就断言失败 —— 一条被测
 * 规则被改名/删除时，测试必须报出来，而不是静默通过。
 */
function ruleBody(css: string, selector: string): string {
  const source = stripCssComments(css)
  const start = source.indexOf(`${selector} {`)
  assert.ok(start >= 0, `没有找到规则 ${selector}`)
  const end = source.indexOf('}', start)
  assert.ok(end > start, `规则 ${selector} 没有闭合`)
  return source.slice(start, end)
}

describe('页面内容列：左对齐、流式（不是定宽居中列）', () => {
  const css = stripCssComments(read('src/renderer/src/assets/main.css'))

  it('.page 上没有 max-width，也没有自动外边距', () => {
    const page = ruleBody(css, '.page')
    // 定宽 + `margin: 0 auto` 就是「中间对齐了」的全部原因；两者都必须不在。
    assert.equal(/max-width/.test(page), false, `.page 又出现了 max-width：${page}`)
    assert.equal(
      /margin[^;]*auto/.test(page),
      false,
      `.page 又出现了自动外边距（居中列）：${page}`
    )
    assert.equal(/width\s*:\s*\d+px/.test(page), false, `.page 又写死了宽度：${page}`)
    // 它仍然是「一列」：流式不等于不再是一列。
    assert.match(page, /display:\s*flex/)
    assert.match(page, /flex-direction:\s*column/)
  })

  it('定宽 token --content-max-width 已经从 :root 里删除', () => {
    // 留着这个 token，下一个人很容易再把 `max-width: var(--content-max-width)`
    // 加回 `.page` 上；界面上没有任何地方用它了。
    assert.equal(
      css.includes('content-max-width'),
      false,
      '仍然存在 --content-max-width（声明或引用）：它就是 1440px 定宽列'
    )
  })

  it('左、上间距的唯一来源是 .app-content 的固定内边距', () => {
    const content = ruleBody(css, '.app-content')
    assert.match(content, /padding:\s*var\(--space-6\)/)
    // 间距本身是固定像素值（`--space-6: 24px`）：任何窗口尺寸下它都是同一个数，
    // 这正是「无论窗口的大小都和左边、上边保持固定的距离」的实现方式。
    const root = ruleBody(css, ':root')
    assert.match(root, /--space-6:\s*24px/)
    assert.match(root, /--space-1:\s*4px/)
  })

  it('内容区仍然是滚动容器（内容变宽变高之后要能滚动）', () => {
    const content = ruleBody(css, '.app-content')
    assert.match(content, /overflow:\s*auto/)
    assert.match(content, /min-height:\s*0/)
  })
})

describe('应用外壳：页脚的落点与顶栏指示器', () => {
  const shell = read('src/renderer/src/components/AppShell.vue')

  it('shell 仍然是 侧栏 + 内容主列（顶栏 / 内容 / 页脚）', () => {
    const shellIndex = shell.indexOf('class="app-shell"')
    const sidebar = shell.indexOf('<AppSidebar')
    const main = shell.indexOf('class="app-main"')
    const topbar = shell.indexOf('<AppTopbar')
    const content = shell.indexOf('class="app-content"')
    const footer = shell.indexOf('<AppFooter')
    assert.ok(shellIndex >= 0 && sidebar > shellIndex, '侧栏不在 .app-shell 里')
    assert.ok(main > sidebar, '.app-main 不在侧栏之后')
    assert.ok(topbar > main, '顶栏不在 .app-main 里')
    assert.ok(content > topbar, '内容区不在顶栏之后')
    assert.ok(footer > content, '页脚不在内容区之后')
  })

  it('页脚仍然在滚动容器 .app-content 之外（否则会跟着内容滚走）', () => {
    // `</main>` 与 `<AppFooter` 的相对位置就是把「页脚属于窗口」这件事写进结构里：
    // 页脚进 `.app-content` 之后会随内容一起滚走，而「页脚」的定义就是它一直在底部。
    const closeMain = shell.indexOf('</main>')
    const footer = shell.indexOf('<AppFooter')
    assert.ok(closeMain >= 0 && footer > closeMain, '页脚被放进了 .app-content 内部')
  })

  /**
   * 顶栏指示器在第二次改动之后的形态（业主 2026-09-16：待处理告警与告警图标合并）。
   *
   * 原来这里有**三个**东西：设备总数、在线设备数、以及一颗「未确认告警」铃铛（角标是
   * `alarms.query({acknowledged:false})` 的总数，点它跳 `/events`）。产品要求把待处理
   * 告警并到告警图标上，于是：
   *   - 那颗铃铛被 `AlarmLinkagePanel` 取代（同一个位置、同一个图标）；
   *   - 角标数字改成**面板里列出的待处理告警条数**（`linkage.unacknowledgedCount`）——
   *     数字与列表必须同源，否则就是"一个数字配一份别的列表"。
   * 所以这一条断言的是"设备/在线两项还在" + "告警入口是那个面板" + "角标与列表同源"，
   * 而不再是 `unacknowledgedAlarms`（那个计数器与它的 IPC 查询已经删掉了）。
   */
  it('顶栏的设备/在线指示器还在，告警入口是合并后的那颗图标', () => {
    // `stripCssComments`：样式里那段说明**故意**写着被删掉的类名（那是给下一个人看的
    // "这里原来有什么、为什么删"），而注释不是生效的声明。
    const topbar = stripCssComments(read('src/renderer/src/components/AppTopbar.vue'))
    assert.ok(topbar.includes('devices.devices.length'), '顶栏缺少设备总数')
    assert.ok(topbar.includes('devices.onlineCount'), '顶栏缺少在线设备数')
    assert.ok(topbar.includes('<AlarmLinkagePanel'), '顶栏缺少告警入口')
    // 旧的独立「待处理告警」按钮块与旧的铃铛都必须消失，否则又是两处说同一件事。
    assert.equal(
      /unacknowledgedAlarms/.test(topbar),
      false,
      '顶栏又出现了第二套告警计数（那是合并掉的东西）'
    )
    assert.equal(
      /indicator__badge/.test(topbar),
      false,
      '顶栏又出现了自己画的告警角标（角标属于 AlarmLinkagePanel）'
    )
  })

  it('告警角标数与面板里列出的条数同源（不许一个数字配一份别的列表）', () => {
    const panel = read('src/renderer/src/components/AlarmLinkagePanel.vue')
    assert.ok(
      panel.includes('linkage.unacknowledgedCount'),
      '角标必须读待处理告警的条数'
    )
    assert.ok(panel.includes('linkage.pending'), '面板必须列出待处理告警本身')
    assert.ok(
      panel.includes("t('linkage.pendingEmpty')"),
      '没有告警时必须显示空态文案（当前无告警）'
    )
  })

  /**
   * 历史趋势：刷新 / 立即落盘搬进设备选择那张卡片，设备下拉收窄（业主 2026-09-16）。
   *
   * 为什么要有源码守卫：GUI 探针用的一次性 profile 里**没有设备**，这一页会走
   * 「尚未添加设备」分支，筛选卡片根本不渲染 —— 那三条 DOM 断言在那里**量不到**。
   * 探针会如实说"跳过"，而这条守卫保证"接线本身"仍然被钉住。
   * 卡片的边界用 `templateBlock` 取那段 `<section class="card">…</section>`。
   */
  it('历史趋势：两个动作在筛选卡片里，页头不回来，设备下拉收窄了', () => {
    const source = stripCssComments(read('src/renderer/src/views/TrendsView.vue'))
    assert.equal(
      /class="page-header"/.test(source),
      false,
      '历史趋势页又出现了页头（动作已经搬进筛选卡片）'
    )
    // 卡片的边界用索引算，不引入新的辅助函数：`<section class="card">` 到它后面的第一个
    // `</section>` 之间就是筛选卡片。动作必须落在这段里面 —— 放进卡片外面时源码看起来一样"有"。
    const cardStart = source.indexOf('<section class="card">')
    assert.ok(cardStart >= 0, '找不到筛选卡片')
    const cardEnd = source.indexOf('</section>', cardStart)
    assert.ok(cardEnd > cardStart, '筛选卡片没有闭合标签')
    const card = source.slice(cardStart, cardEnd)
    assert.ok(card.includes('trend-actions'), '筛选卡片里没有 trend-actions 那一块')
    assert.ok(
      card.includes("t('common.refresh')") && card.includes("t('settingsUi.trendFlushNow')"),
      '刷新 / 立即落盘必须画在筛选卡片**里面**'
    )
    assert.ok(
      /\.field--wide\s*\{[^}]*flex:\s*0 0 auto/.test(source) &&
        /\.field--wide \.select\s*\{[^}]*width:\s*200px/.test(source),
      '设备下拉没有真正收窄（宽度必须钉在 select 上，只写 min-width 管不住按最宽选项撑开的 <select>）'
    )
  })
})

/**
 * 实时监测页的结构改造（业主 2026-09-17 第二批：③④⑦）。
 *
 * 为什么需要源码守卫：GUI 探针能验证这些（已经加了 DOM 断言），但它要跑一次 Electron、
 * 要真设备在库里；而这三条都是"删掉一个东西/搬一个东西"的改动 —— 最典型的回归是
 * **同一个组件在别处又被挂回来**（`CameraVideoWall` 在总览页仍然在用，所以"
 * 页面上看不到墙"并不等于"这一页没有墙"）。
 *
 * 探针与守卫**同时**存在的理由见 `docs/UI-VERIFY.md`：探针证明"这一刻的屏幕上没有"，
 * 守卫证明"源码里也没有"。少任何一边都会漏。
 */
describe('实时监测页：删掉的、搬走的、留下的', () => {
  const monitor = stripComments(read('src/renderer/src/views/MonitorView.vue'))
  const topbar = stripComments(read('src/renderer/src/components/AppTopbar.vue'))

  it('⑦ 视频墙不在实时监测页（组件仍在总览页用）；⑧ 五路图谱回来了但版式是新的', () => {
    assert.equal(
      /<CameraVideoWall/.test(monitor),
      false,
      '实时监测页又挂回了视频墙（⑦ 要求删掉它）'
    )
    assert.equal(
      /CameraVideoWall/.test(monitor),
      false,
      '实时监测页仍然 import 了 CameraVideoWall（没人用就删掉，留着会被下一次挂回来）'
    )
    // 总览页必须**还在**用那块墙：删的是这一页的用法，不是组件。
    const overview = stripCssComments(read('src/renderer/src/views/OverviewView.vue'))
    assert.ok(/<CameraVideoWall/.test(overview), '总览页的视频墙被误删了')

    /**
     * ⑧（业主 2026-09-17 已确认）：五张图谱＝相机那五路实时数据（fft/voiceprint/energy/pcm/
     * detectFeedback），**排成一排**。
     *
     * **2026-09-18 第 10 批第 24 条推翻了那个版式的一半**：声纹图与频谱图改为
     * **16:9 各占 50%、放在视频下方**，时域波形图在它们下面。所以这里断言的是新版式
     * （`.acam__pair` 两列 + `.acam__stage--ratio` 16:9），不是"一排五张"。
     * 旧断言按"被更新的要求覆盖"改写，不是删掉。
     */
    assert.ok(
      monitor.includes('<CameraAcousticPanel'),
      '实时监测页没有那五张图谱（第 24 条把它们重排了，不是删掉）'
    )
    /**
     * 这一块必须**整幅宽**：它在排布板里只占一格时（1440 窗口下 ~378px），
     * 两块"各占 50%"会变成各 ~180px —— 那还是并排，但坐标轴读不出来。
     */
    const panelUsage = between(monitor, '<CameraAcousticPanel', '/>', '相机五路图谱那一块')
    assert.ok(
      panelUsage.includes('camera-board__wide'),
      '相机图谱那一块没有整幅宽（camera-board__wide）—— 两块各占 50% 会挤在排布板的一格里'
    )

    const panel = stripComments(read('src/renderer/src/components/CameraAcousticPanel.vue'))
    const pair = ruleBody(panel, '.acam__pair')
    /*
     * 两列等宽（`minmax(..., 1fr)`），**不是**由窗口宽度决定。
     *
     * 这一条是从上一版继承下来的教训：第一版写的是 `repeat(5, …)` 加
     * `@media (max-width: 1500px)` 退 3 列 —— 在那台探针窗口（1440）上，
     * 列数被折叠了而**版面本身并没有变窄**：媒体查询问的是窗口，这一块的宽度由外层排布板给。
     */
    assert.match(
      pair,
      /grid-template-columns:\s*repeat\(\s*auto-fit\s*,\s*minmax\(/,
      '声纹图 + 频谱图那一行不是 auto-fit 的等宽列：' + pair
    )
    // 退化**不许**再由窗口宽度决定（那正是上一版修掉的问题）。
    assert.equal(
      /@media[^{]*\{[^@]*\.acam__(pair|row)\s*\{/.test(panel),
      false,
      '声纹图/频谱图那一行的列数又改回由窗口宽度（@media）决定了'
    )
    // 16:9 那一层必须在，而且两处（画布与空态）共用它。
    const ratio = ruleBody(panel, '.acam__stage--ratio')
    assert.match(ratio, /aspect-ratio:\s*16\s*\/\s*9/, '声纹图/频谱图那一层不是 16:9：' + ratio)
    assert.match(ratio, /min-height:\s*0/, '16:9 那一层还留着 min-height：比例会被它顶掉')
  })

  /**
   * 第 23 条：「删除「相机声学数据」窗口、数据默认实时接收」。
   *
   * 三件都要钉住，而且**每一件都能"源码里删对了但屏幕上不对"**：
   *   1. 那个窗口的标题与「开始接收」按钮真的没有了（连目录键一起删，免得被画回来）；
   *   2. 数据**默认开始接收**（`onMounted` 里就调，不是等用户点）；
   *   3. 状态**仍然看得见**：删掉窗口不等于可以不说"流没起来" —— 空了的面板与安静的房间
   *      在屏幕上长得一样，而这一页的每一张图都靠这一行区分。
   */
  it('㉓ 「相机声学数据」窗口已删，数据默认实时接收，状态仍然看得见', () => {
    const panel = stripComments(read('src/renderer/src/components/CameraAcousticPanel.vue'))

    // ① 窗口没有了：标题卡片与「开始接收」都不在。
    assert.equal(/acam__head/.test(panel), false, '「相机声学数据」那个窗口又回来了（.acam__head）')
    assert.equal(
      /cameraStreamUi\.(title|start)\b/.test(panel),
      false,
      '组件里又引用了已删除的窗口标题 / 「开始接收」文案'
    )
    assert.ok(panel.includes('data-acam-status'), '没有那一行状态（data-acam-status）')
    assert.ok(panel.includes("t('cameraStreamUi.sessionIdle')"), '状态行没有"未启动"这一档')
    assert.ok(panel.includes("t('cameraStreamUi.sessionRunning')"), '状态行没有"接收中"这一档')
    assert.ok(panel.includes('data-action="acam-stop"'), '没有「停止接收」—— 默认开始之后就没法关了')

    // ② 默认接收：挂载与换设备两条路径都要调，而且**先读一次状态**再决定。
    const mounted = panel.slice(panel.indexOf('onMounted(async () => {'))
    const mountedBody = mounted.slice(0, mounted.indexOf('})'))
    assert.match(mountedBody, /refreshState\(\)[\s\S]*ensureStreaming\(\)/,
      'onMounted 里没有"先读状态、再默认开始接收"')
    assert.match(
      panel,
      /watch\(\s*\(\) => props\.deviceId,[\s\S]*?ensureStreaming\(\)/,
      '换了一台相机之后没有默认开始接收'
    )
    // 非管理员与"已经在收"两种情况下都不许重复开（重复订阅＝两套 socket 推同一路数据）。
    const ensure = panel.slice(panel.indexOf('async function ensureStreaming('))
    const ensureBody = ensure.slice(0, ensure.indexOf('\n}'))
    assert.match(ensureBody, /canStart\.value/, 'ensureStreaming 没有管理员判断')
    assert.match(ensureBody, /camera\.isActive/, 'ensureStreaming 没有"已经在收就不重开"的判断')
  })

  it('⑦ 相机控制与告警并排（告警卡片在同一块板子里，不是对话框里的一句话）', () => {
    assert.ok(
      monitor.includes('class="card camera-alarm-entry"'),
      '找不到与相机控制并排的告警卡片（.camera-alarm-entry）'
    )
    // 告警卡片必须与相机控制同层（`.camera-board` 的网格项），否则并排不成立。
    const boardStart = monitor.indexOf('class="camera-board"')
    const boardEnd = monitor.indexOf('</div>', monitor.indexOf('<CameraAlarmDialog'))
    const alarmIndex = monitor.indexOf('camera-alarm-entry')
    assert.ok(boardStart >= 0 && boardEnd > boardStart, '找不到相机板子的边界')
    assert.ok(
      alarmIndex > boardStart && alarmIndex < boardEnd,
      '告警卡片不在相机板子里（并排要求它是同一个网格的子项）'
    )
  })

  it('③ 「数据流状态」与「当前帧」两张卡片已经删除（连键一起）', () => {
    for (const gone of ['stream-strip', 'currentFrameSection', 'monitorUi.sampleRate']) {
      // 例外说明：`monitorUi.sampleRate` 这个键**保留**（回放面板在用），但这一页不该再用它。
      if (gone === 'monitorUi.sampleRate') continue
      assert.equal(monitor.includes(gone), false, `实时监测页还有 ${gone}`)
    }
    // 失败信息**不许**跟着卡片一起消失：原来那张卡片的价值就是"哪一路坏了"。
    assert.ok(monitor.includes('streamFailure'), '删掉数据流卡片之后没有留下"哪一路坏了"那句话')
    const zh = read('src/shared/i18n/messages/zh-CN.ts')
    assert.ok(zh.includes('streamFailure'), 'zh-CN 缺少 streamFailure')
  })

  it('④ 设备下拉搬进顶栏那一格，并且那一格是 50% 宽', () => {
    // 顶栏必须真的留出那一格（有 id 才可能被 Teleport 命中）。
    assert.ok(
      topbar.includes('id="topbar-page-slot"'),
      '顶栏没有 #topbar-page-slot（页面控件没有落点）'
    )
    assert.ok(
      /\.topbar__page-slot\s*\{[^}]*flex:\s*1 1 50%/.test(topbar),
      '顶栏那一格不是 50% 宽（业主指定的一半）'
    )
    assert.ok(
      monitor.includes('<Teleport to="#topbar-page-slot">'),
      '实时监测的设备下拉没有投到顶栏'
    )
    // 页头里不许再留一份（两份下拉会让"在看哪台设备"有两个答案）。
    assert.equal(
      /monitor-head__device/.test(monitor),
      false,
      '设备下拉的旧位置（.monitor-head__device）还在'
    )
  })
})

/**
 * ⑨ 升级 / 维护 / 告警策略 / 检测模式搬到设备管理（业主 2026-09-17）。
 *
 * 做法是**同一份实现按 `sections` 取用**，不是复制组件：那两块共享同一批 IPC 与同一套
 * "读了要写回"的规矩，复制一份迟早会不一致。所以守卫要钉住三件事：
 *   1. 实时监测页只取实时相关的两块（检测启停 + 应用场景）；
 *   2. 设备管理页按机型给页签，相机的三块落在相机页签里；
 *   3. **相机不再看到 FA8 的页签** —— 那是一个既有缺陷（点开就是 404，而 404 会被读成"离线"）。
 */
describe('⑨ 相机配置搬家：同实现分块渲染 + 页签按机型', () => {
  const control = stripComments(read('src/renderer/src/components/CameraControlPanel.vue'))
  const monitor = stripComments(read('src/renderer/src/views/MonitorView.vue'))
  const detail = stripComments(read('src/renderer/src/views/DeviceDetailView.vue'))

  it('面板支持 `sections` 且默认全渲染（不传参时与改造前一致）', () => {
    assert.ok(
      control.includes('sections?: readonly CameraControlSection[]'),
      '面板没有 sections prop'
    )
    assert.ok(control.includes('props.sections ?? ALL_SECTIONS'), '不传 sections 时没有退回全部区块')
    for (const section of ['mode', 'preset', 'detect', 'strategy', 'maintenance', 'upgrade']) {
      assert.ok(control.includes(`'${section}'`), `CameraControlSection 少了 ${section}`)
    }
    // 每一块都要真的被 `wants()` 门住（只在类型里列出来不算）。
    for (const section of ['mode', 'preset', 'detect', 'strategy', 'maintenance', 'upgrade']) {
      assert.ok(
        control.includes(`wants('${section}')`),
        `${section} 这一块没有被 wants() 门住（会被无条件渲染）`
      )
    }
  })

  it('读数也跟着 `sections` 走（不渲染的块不许去读设备）', () => {
    // 七路读取里至少这几路必须条件化：否则挂三次就会把同一批数据拉三遍，
    // 而且"读的"与"画的"会不一致。
    for (const call of [
      'wants(\'mode\') ? callApi(() => window.api.cameraControl.readRunMode',
      'wants(\'detect\') ? callApi(() => window.api.cameraControl.readDetectStatus',
      'wants(\'strategy\')\n          ? callApi(() => window.api.cameraAlarms.listStrategies',
      'wants(\'preset\') ? callApi(() => window.api.cameraControl.readModePreset'
    ]) {
      assert.ok(control.includes(call), `这一路读取没有按 sections 条件化：${call}`)
    }
    /**
     * 「启用中的策略」是**跨块依赖**：检测启停按钮的可用性由它决定（没有启用策略时设备回
     * `ret:-1`）。所以它必须同时被 `strategy` 与 `detect` 触发 —— 只按前者条件化，
     * 实时监测页拿不到它，开始按钮会永久禁用（一个"只是变灰了"的功能性回归）。
     */
    assert.ok(
      control.includes("wants('strategy') || wants('detect')"),
      '「启用中的策略」没有为检测启停也读一次（开始按钮会永久禁用）'
    )
  })

  it('实时监测页只留「检测启停 + 应用场景」两块', () => {
    assert.ok(
      /<CameraControlPanel[\s\S]*?:sections="\['detect', 'preset'\]"/.test(monitor),
      '实时监测页没有限定 sections（会把四块配置也画出来）'
    )
  })

  it('设备管理页：相机三块各占一个页签，且相机**不再看到 FA8 的页签**', () => {
    for (const [id, sections] of [
      ['cameraDetect', "['mode']"],
      ['cameraAlarms', "['strategy']"],
      ['cameraMaintenance', "['maintenance', 'upgrade']"]
    ] as const) {
      const block = between(
        detail,
        `activeTab === '${id}'`,
        '</template>',
        `${id} 页签`
      )
      assert.ok(block.includes('<CameraControlPanel'), `${id} 页签里没有相机面板`)
      assert.ok(block.includes(`:sections="${sections}"`), `${id} 页签的 sections 不对`)
    }
    // 机型决定页签：相机的白名单里不能有 FA8 的那几个。
    const cameraTabs = between(detail, 'const CAMERA_TABS', ']', '相机页签白名单')
    for (const fa8 of ['channels', 'alarms', 'network', 'time', 'serial', 'push']) {
      assert.equal(
        cameraTabs.includes(`'${fa8}'`),
        false,
        `相机的页签白名单里还有 FA8 的 ${fa8}（那些端点在相机上不存在，点了就是 404）`
      )
    }
  })

  it('换设备 / 换代次之后页签不在新那一组里 ⇒ 退回这一组的第一页（否则是一片空白）', () => {
    /*
     * 监听的是**机型 + 代次**两个量（第 8 批起）：空气声呐与 2023 版听诊盒子是同一个
     * `kind`（`auscultationBox`）、两套页签，只看 `kind` 的话"代次刚读到"这件事不会触发纠正。
     */
    assert.ok(
      /watch\(\s*\(\) => \[device\.value\?\.kind, device\.value\?\.e2Variant\]/.test(detail),
      '没有监听机型/代次变化来纠正页签'
    )
    /*
     * 兜底是**这一组的第一页**而不是恒定的「概览」：空气声呐那一组里没有概览页，
     * 退回一个不存在的页签，页面还是一片空白（第 8 批改的）。
     */
    assert.ok(
      detail.includes("activeTab.value = visibleTabs.value[0]?.id ?? 'overview'"),
      '没有退回这一组第一页的兜底（写死 overview 时空气声呐会空白）'
    )
  })
})

/**
 * ② 每通道声纹特性卡片 + 音频播放按钮 + 音量（业主 2026-09-17，声纹设备那一支）。
 *
 * 三条守卫，每一条都对着一个**不报错但会骗人**的失效方式：
 *   1. 卡片必须一通道一张，且数据来自"每通道最后一次读数"，不是当前那一路的读数
 *      （否则八张卡片会显示同一路的数字）；
 *   2. 旧读数必须带时间和"最后一次读数"标记 —— 不带的话它看起来就是实时值；
 *   3. 播放按钮必须有说明它播的是什么（包络预览，不是原声），也必须真的接上音量。
 */
describe('② 每通道声纹特性卡片 + 音频回放', () => {
  const monitor = stripComments(read('src/renderer/src/views/MonitorView.vue'))
  const store = stripComments(read('src/renderer/src/stores/monitor.ts'))

  it('卡片按通道生成，取自每通道读数，点击即切到那一路', () => {
    assert.ok(
      /v-for="card in channelFeatureCards"/.test(monitor),
      '每通道卡片没有按 channelFeatureCards 渲染（会变成当前那一路的重复）'
    )
    assert.ok(
      monitor.includes('monitor.channelFeatureOf(tab.index)'),
      '卡片取数没有走每通道读数（channelFeatureOf）'
    )
    // 点击必须复用同一个通道切换入口，不许另写一套。
    assert.ok(
      /v-for="card in channelFeatureCards"[\s\S]{0,2000}?@click="selectChannel\(card.index\)"/.test(
        monitor
      ),
      '通道卡片没有走 selectChannel()'
    )
  })

  it('旧读数带时间与状态标记（否则它看起来就是实时值）', () => {
    assert.ok(
      monitor.includes('channelFeatureStateLabelKey(card.featureState)'),
      '卡片没有渲染读数状态（实时 / 最后一次读数 / 未读取）'
    )
    assert.ok(
      monitor.includes("t('monitorUi.channelFeatureUpdated', { time: featureTime(card.feature.timestamp) })"),
      '旧读数没有带更新时间'
    )
    // 三种状态必须是三种不同的视觉：stored 不许与 unread 一样是"无色"。
    const css = between(monitor, 'function featureStateClass', '}', '读数状态样式映射')
    assert.ok(css.includes("state === 'live'"), 'live 状态没有独立样式')
    assert.ok(css.includes("state === 'stored'"), 'stored 状态没有独立样式')
  })

  it('音频回放：按钮有说明、音量真的接上播放器、离开页面会收声', () => {
    assert.ok(monitor.includes("t('monitorUi.audioPreviewHint')"), '播放按钮旁边没有"播的是什么"的说明')
    assert.ok(monitor.includes('@click="toggleAudio"'), '找不到播放按钮')
    assert.ok(
      monitor.includes('audioPlayer.setVolume(volumePercent.value)'),
      '音量没有推给播放器（滑杆会是个装饰）'
    )
    assert.ok(monitor.includes('@input="onVolumeInput"'), '音量滑杆没有接处理器')
    assert.ok(monitor.includes('audioPlayer.close()'), '离开页面没有释放 AudioContext')
    // 切到相机分支时必须收声：那一支的画面与这一支的音频不该同时在响。
    assert.ok(monitor.includes('await stopBoxAudio()'), '切到相机时没有停止声学预览')
  })

  it('store：每通道读数**不随会话清理**，只随换设备清空', () => {
    /*
     * 这是 ② 里最容易写错的一处：`unsubscribe()`（切通道时会走）会清空所有显示缓冲，
     * 而"每通道卡片"的全部意义就是切走之后还留着上一路的读数。所以：
     *   - `clearBuffers()` 里**不许**出现 channelFeatures；
     *   - `selectDevice()` 里**必须**清空（换设备之后那些读数属于另一台设备）。
     */
    const clearBuffers = between(store, 'function clearBuffers', '}', '清缓冲函数')
    assert.equal(
      clearBuffers.includes('channelFeatures'),
      false,
      'clearBuffers() 清掉了每通道读数 —— 切一次通道，七张卡片就会全空'
    )
    const selectDevice = between(store, 'function selectDevice', 'function channelFeatureOf', '选设备函数')
    assert.ok(
      selectDevice.includes('channelFeatures.value = {}'),
      '换设备时没有清空每通道读数（新设备会显示上一台的数字）'
    )
    // 帧到达时必须记下来，否则卡片永远是"未读取"。
    const handleFeature = between(store, 'function handleFeature', 'function handleAudio', '特征帧处理')
    assert.ok(
      handleFeature.includes('recordChannelFeature(channelFeatures.value, frame)'),
      '特征帧没有记进每通道读数'
    )
  })
})

/**
 * ③b 实时趋势置顶 + 其下四张图谱卡片 + 时间轴回放（业主 2026-09-17）。
 *
 * 这一条改动**只有版式**，所以它最容易悄悄退化：顺序一被改回去，页面照样能看，
 * 只是"一进页面要先滚动才看得到趋势"。因此这里钉的是**文档顺序**，不是"有没有这些卡片"。
 */
describe('③b 实时趋势置顶 + 四张图谱卡片 + 时间轴回放', () => {
  const monitor = stripComments(read('src/renderer/src/views/MonitorView.vue'))

  /**
   * 卡片标题在**模板**里的位置。
   *
   * 为什么不用 `t('monitorUi.xxx')` 直接找：脚本里也会引用同一个键（例如 ECharts 的
   * `series.name`），而脚本永远在模板之前 —— 那样比出来的顺序是假的（这一条踩过）。
   */
  const titleIndex = (key: string): number =>
    monitor.indexOf(`<h3 class="section-title">{{ t('${key}') }}</h3>`)

  it('趋势在四张卡片与时间轴**之前**，四张卡片又都在时间轴之前', () => {
    const trend = titleIndex('monitorUi.trendSection')
    const grid = monitor.indexOf('<div class="graph-grid">')
    const timeline = monitor.indexOf('<MonitorRecordingTimeline')
    assert.ok(trend >= 0, '找不到实时趋势卡片')
    assert.ok(grid > trend, '四张图谱卡片不在趋势下面（③b 要求"其下"）')
    assert.ok(timeline > grid, '时间轴回放不在四张图谱卡片下面')
  })

  it('趋势卡片在最上面：页头之后、其余卡片之前', () => {
    const trend = titleIndex('monitorUi.trendSection')
    assert.ok(trend >= 0, '找不到实时趋势卡片')
    for (const after of [
      'monitorUi.channelFeaturesSection',
      'monitorUi.spectrumSection',
      'monitorUi.spectrogramSection',
      'monitorUi.audioSection',
      'monitorUi.waveformSection'
    ]) {
      const index = titleIndex(after)
      assert.ok(index > 0, `找不到 ${after} 的卡片标题`)
      assert.ok(trend < index, `${after} 排在了趋势卡片前面（趋势要求置顶）`)
    }
  })

  it('四张图谱卡片就是业主确认的那四张（频谱 / 时频图 / 声学波形 / 每通道声纹特性）', () => {
    const grid = between(monitor, '<div class="graph-grid">', '\n      </div>', '四张图谱卡片')
    for (const key of [
      'monitorUi.spectrumSection',
      'monitorUi.spectrogramSection',
      'monitorUi.waveformSection',
      'monitorUi.channelFeaturesSection'
    ]) {
      assert.ok(grid.includes(`t('${key}')`), `四张卡片里少了 ${key}`)
    }
    // 恰好四张：多一张少一张都说明版式被改了。
    assert.equal(
      (grid.match(/<section\b/g) || []).length,
      4,
      '四张图谱卡片里的 section 不是恰好四个'
    )
    /*
     * 声学波形必须画**真实存在**的数据（那一帧降采样包络），而不是一个占位图：
     * 它读的就是 `monitor.audio` 的 `waveform`，与「播放」按钮听到的是同一份数据。
     */
    const option = between(
      monitor,
      'const waveformOption',
      // 终点用**代码**而不是注释行：`stripComments()` 会把 `// …` 那一行整行删掉。
      '\nasync function loadSampleRate',
      '声学波形选项'
    )
    assert.ok(option.includes('monitor.audio'), '声学波形没有读实时音频帧')
    assert.ok(option.includes('?.waveform'), '声学波形没有画那一帧的包络')
    // 固定 ±1 量程：否则安静的帧会被自动缩放到和响的帧一样高。
    assert.match(option, /min: -1,\s*\n\s*max: 1,/, '声学波形的纵轴不是固定 ±1')
  })

  it('旧的并排规则 `.chart-columns` 连同死样式一起删掉了', () => {
    // 两块图改成四块之后，旧规则没人用；留着死样式会让下一个人以为那块还在（§15.29.4）。
    assert.equal(
      monitor.includes('chart-columns'),
      false,
      '旧的 .chart-columns 还在（模板或样式里）—— 它已经没有使用者了'
    )
    assert.ok(monitor.includes('.graph-grid {'), '找不到新的四张卡片排布规则')
  })

  it('时间轴回放只承诺本机录像（这一族没有设备侧连续录像）', () => {
    const timeline = stripComments(read('src/renderer/src/components/MonitorRecordingTimeline.vue'))
    assert.ok(
      timeline.includes("t('monitorUi.playbackLocalOnly')"),
      '时间轴回放没有写清"只回放本机文件"（写成回放设备录像就是假话）'
    )
    // 几何与数据都必须来自那两个纯模块，不许在组件里重算一遍。
    assert.ok(timeline.includes("from '@renderer/lib/playbackTimeline'"), '没有用时间轴几何模块')
    assert.ok(timeline.includes("from '@renderer/lib/recordingTimeline'"), '没有用录像数据模块')
    assert.ok(timeline.includes('placeSegments('), '没有把录像段摆到时间轴上')
    assert.ok(timeline.includes('zoomWindow('), '滚轮缩放没有走纯函数')
    assert.ok(timeline.includes('panWindow('), '拖动平移没有走纯函数')
  })
})
