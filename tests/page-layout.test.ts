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

  it('左、上间距的唯一来源是 .app-content 的固定内边距（20260921 批第 10 条：收紧为原值的 10%）', () => {
    const content = ruleBody(css, '.app-content')
    // 24px × 0.1 = 2.4px：业主「左侧和上侧的空间调整为现在的 10%」，四边同收保持对称。
    // 仍是 token 的固定倍数 —— 任何窗口尺寸下量到的都是同一个数。
    assert.match(content, /padding:\s*calc\(var\(--space-6\)\s*\*\s*0\.1\)/)
    // 间距基准本身是固定像素值（`--space-6: 24px`）。
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
   * 历史趋势：页头不回来、设备下拉进顶栏、「立即落盘」已挪去设置页（业主 20260921 批）。
   *
   * 为什么要有源码守卫：GUI 探针用的一次性 profile 里**没有设备**，这一页会走
   * 「尚未添加设备」分支，筛选卡片根本不渲染 —— 那几条 DOM 断言在那里**量不到**。
   * 探针会如实说"跳过"，而这条守卫保证"接线本身"仍然被钉住。
   * 卡片的边界用 `templateBlock` 取那段 `<section class="card">…</section>`。
   */
  it('历史趋势：页头不回来，设备下拉进顶栏，「立即落盘」挪去设置页（「刷新」已按更正第 4 条删掉）', () => {
    const source = stripComments(read('src/renderer/src/views/TrendsView.vue'))
    assert.equal(
      /class="page-header"/.test(source),
      false,
      '历史趋势页又出现了页头（标题由外层框架写）'
    )
    // 「立即落盘」按业主 20260921 批从这一页删掉了：store 的 flush() 与 IPC 保留，
    // 按钮挪进设置页「常规 → 缓存」小卡。这一页不许再出现它（也不许留下空的动作块）。
    assert.equal(
      source.includes("t('settingsUi.trendFlushNow')"),
      false,
      '历史趋势页又出现了「立即落盘」按钮（业主：挪去设置页）'
    )
    assert.equal(source.includes('trend-actions'), false, 'trend-actions 动作块没有删干净')
    const settingsView = stripComments(read('src/renderer/src/views/SettingsView.vue'))
    assert.ok(
      settingsView.includes("t('settingsUi.trendFlushNow')"),
      '设置页「常规 → 缓存」小卡里没有「立即落盘」按钮（它应该挪到了那里）'
    )
    // 设备下拉照 MonitorView 的先例投去顶栏那一格（筛选栏里那个 field--wide 控件已删）。
    assert.ok(
      /<Teleport to="#topbar-page-slot">[\s\S]{0,600}?t\('trendsUi\.filterDevice'\)/.test(source),
      '设备下拉没有投进顶栏（#topbar-page-slot）'
    )
    assert.equal(
      source.includes('.field--wide'),
      false,
      '.field--wide 规则又留了回来（筛选栏里那个控件已删）'
    )
    /*
     * 更正第 4 条（2026-09-19）：「每个子页面里面的单独刷新按钮都应该删除」——
     * 这一页原来那颗「刷新」与顶栏那颗重复，已经删掉（重查由顶栏那颗触发，见
     * `stores/uiRefresh.ts`）。所以这里断言的是**它没有回来**。
     */
    assert.equal(
      /t\('common\.refresh'\)/.test(source),
      false,
      '历史趋势页又出现了自己的「刷新」按钮（业主更正第 4 条要求删掉）'
    )
    assert.ok(
      /watch\(\s*\(\) => uiRefresh\.tick/.test(source),
      '删掉刷新按钮之后没有接上顶栏那颗（否则就没有任何办法重查当前筛选了）'
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

  it('⑦ 视频墙不在实时监测页（组件仍在总览页用）；声学面板按 sections 拆用、能量点已删', () => {
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
     * 声学面板仍然是相机分支的一部分（业主 2026-09-21 第三批）：按 `sections` 拆成
     * 多份实例 —— 视频下方是检测 + 波形，右列是声纹 + 频谱。会话只有一个主人
     * （`useFa371CameraSession`，见下面那条㉓的断言），面板不再自己开/停流。
     */
    assert.ok(
      monitor.includes('<CameraAcousticPanel'),
      '实时监测页没有用声学面板（第三批按 sections 拆用，不是删掉）'
    )
    assert.ok(
      monitor.includes(":sections=\"['detect']\""),
      '视频下方没有检测结果卡（sections=[detect]）'
    )
    assert.ok(
      monitor.includes(":sections=\"['audio']\""),
      '视频下方没有声学波形卡（sections=[audio]）'
    )
    assert.ok(
      monitor.includes(":sections=\"['voiceprint', 'spectrum']\""),
      '右列没有声纹图 + 频谱图（sections=[voiceprint, spectrum]）'
    )

    /**
     * 能量点子卡整块删除（业主 2026-09-21 第三批）：模板 / 脚本 / CSS 里都不许留。
     * `cameraStreamUi.energy*` 那六个目录键已经没人渲染，由词条统一批次删除。
     */
    const panel = stripComments(read('src/renderer/src/components/CameraAcousticPanel.vue'))
    assert.equal(/energyData/.test(panel), false, '声学面板里还有 energyData 的引用')
    assert.equal(/energyTargets/.test(panel), false, '声学面板里还有 energyTargets')
    assert.equal(/acam__table/.test(panel), false, '声学面板里还有能量点表格的样式/用法')
    assert.equal(
      /cameraStreamUi\.energy/.test(panel),
      false,
      '声学面板里还有 cameraStreamUi.energy* 词条引用'
    )
  })

  /**
   * 第 23 条：「删除「相机声学数据」窗口、数据默认实时接收」—— 第三批重排后这一条
   * 落在**会话 composable** 上（面板被拆成多份实例，生命周期只有一份）：
   *
   * 三件都要钉住，而且**每一件都能"源码里删对了但屏幕上不对"**：
   *   1. 那个窗口的标题与「开始接收」按钮真的没有了（连目录键一起删，免得被画回来）；
   *   2. 数据**默认开始接收**（`onMounted` 里就调，不是等用户点）；
   *   3. 状态**仍然看得见**：删掉窗口不等于可以不说"流没起来" —— 空了的面板与安静的房间
   *      在屏幕上长得一样，而每一张图都靠这一行区分。
   */
  it('㉓ 「相机声学数据」窗口已删，数据默认实时接收，状态仍然看得见', () => {
    const panel = stripComments(read('src/renderer/src/components/CameraAcousticPanel.vue'))
    const session = stripComments(read('src/renderer/src/composables/useFa371CameraSession.ts'))

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
    // 多份实例同屏时状态行只渲染一份。
    assert.ok(panel.includes('showStatus'), '状态行没有开关（多份实例会同屏）')

    // ② 默认接收：生命周期在 composable 里 —— 挂载与换设备都走 adoptDevice()，
    // 而它**先读一次状态**再决定开不开。
    const mounted = session.slice(session.indexOf('onMounted(async () => {'))
    const mountedBody = mounted.slice(0, mounted.indexOf('})'))
    assert.match(mountedBody, /adoptDevice\(deviceId\.value\)/, 'onMounted 没有接管当前设备')
    const adopt = session.slice(session.indexOf('async function adoptDevice('))
    const adoptBody = adopt.slice(0, adopt.indexOf('\n}'))
    assert.match(adoptBody, /refreshState\(\)[\s\S]*ensureStreaming\(\)/,
      'adoptDevice 里没有"先读状态、再默认开始接收"')
    // 换设备：先停旧会话，再走 adoptDevice（里面的默认开始接收）。
    assert.match(
      session,
      /watch\(deviceId, async \(id\) => \{[\s\S]*?camera\.stop\(\)[\s\S]*?adoptDevice\(id\)/,
      '换了一台相机之后没有"停旧会话、再默认开始接收"'
    )
    // 非管理员与"已经在收"两种情况下都不许重复开（重复订阅＝两套 socket 推同一路数据）。
    const ensure = session.slice(session.indexOf('async function ensureStreaming('))
    const ensureBody = ensure.slice(0, ensure.indexOf('\n}'))
    assert.match(ensureBody, /canStart\.value/, 'ensureStreaming 没有管理员判断')
    assert.match(ensureBody, /camera\.isActive/, 'ensureStreaming 没有"已经在收就不重开"的判断')
    // 会话只有一份：监测页调用一次 composable，面板自己不 start 会话流
    // （「停止接收」按钮的 camera.stop() 是用户动作，不在此列）。
    assert.ok(
      monitor.includes('useFa371CameraSession(selectedDeviceId, isCamera)'),
      '监测页没有调用会话 composable'
    )
    assert.equal(
      /camera\.start\(/.test(panel),
      false,
      '声学面板自己 start 会话流（会与 composable 抢会话所有权）'
    )
  })

  it('告警入口卡与告警结果卡都在相机板子里（右列入口 + 视频下方的就地列表）', () => {
    assert.ok(
      monitor.includes('class="card camera-alarm-entry"'),
      '找不到告警配置入口卡（.camera-alarm-entry）'
    )
    assert.ok(
      monitor.includes('class="card camera-alarm-result"'),
      '找不到告警结果卡（.camera-alarm-result，最近几条告警的独立卡）'
    )
    // 两张卡都必须留在 `.camera-board` 里（网格边界内），否则 65/35 重排会把它们挤出相机分支。
    const boardStart = monitor.indexOf('class="camera-board"')
    const boardEnd = monitor.indexOf('</div>', monitor.indexOf('<CameraAlarmDialog'))
    const entryIndex = monitor.indexOf('camera-alarm-entry')
    const resultIndex = monitor.indexOf('camera-alarm-result')
    assert.ok(boardStart >= 0 && boardEnd > boardStart, '找不到相机板子的边界')
    assert.ok(
      entryIndex > boardStart && entryIndex < boardEnd,
      '告警入口卡不在相机板子里'
    )
    assert.ok(
      resultIndex > boardStart && resultIndex < boardEnd,
      '告警结果卡不在相机板子里'
    )
    // 「查看告警记录」链接带 ?device= 预置筛选，两张卡都要有出口（入口卡照旧、结果卡随列表迁入）。
    assert.ok(
      (monitor.match(/data-link="camera-alarm-history"/g) ?? []).length >= 2,
      '「查看告警记录」链接没有两张卡各一份'
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

  /**
   * 实时监测页的控制面板**按 `sections` 限定**：不限定就会把维护/升级那些也画出来。
   *
   * **口径在 2026-09-18 第 10 批第 24 条改过一次**：原来是 `['detect', 'preset']`
   * （⑨ 把「模式」搬去了设备详情页），第 24 条要求这一页「支持检测模式」，所以
   * `mode`（工作模式＝局放 / 气体泄漏 / 机械）回来了。这里断言的是**现在的**那一组，
   * 并且仍然**必须限定** —— 不限定会把维护与升级也画到实时页上，那是另一件事。
   */
  it('实时监测页按 sections 限定，而且第 24 条之后包含「检测模式」', () => {
    const usage = /<CameraControlPanel[\s\S]*?:sections="\[([^\]]*)\]"/.exec(monitor)
    assert.ok(usage, '实时监测页没有限定 sections（会把维护/升级那几块也画出来）')
    const sections = (usage[1] ?? '').replace(/\s/g, '')
    for (const want of ["'mode'", "'detect'", "'preset'"]) {
      assert.ok(
        sections.includes(want),
        `实时监测页的控制面板缺少 ${want}（第 24 条要求这一页支持检测模式）：${sections}`
      )
    }
    // 维护与升级**不许**回到这一页（第 24 条没有要求它，而它们在设备详情页）。
    for (const unwanted of ["'maintenance'", "'upgrade'"]) {
      assert.equal(
        sections.includes(unwanted),
        false,
        `实时监测页出现了 ${unwanted}：那是设备详情页的页签`
      )
    }
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
 *   1. 一行一通道，且数据来自"每通道最后一次读数"，不是当前那一路的读数
 *      （否则八行会显示同一路的数字）；
 *   2. 旧读数必须带时间和读数状态标记 —— 不带的话它看起来就是实时值
 *      （2026-09-21 第二批第 17 条起状态是一枚圆点 + title，文字徽标删掉了）；
 *   3. 播放/录音/音量三个动作收在声学波形卡头部（第 21 条），音量真的接上播放器，
 *      说明文字 audioPreviewHint 按第 21 条删除、不许回潮。
 *
 * 2026-09-19 第 13 批第 3 条把这张卡片改成了**一张表**（八行 × 通道/四指标/告警），
 * 所以第 1、2 条断言的标记跟着换名（`channelFeatureRows` / `row.*`），判据本身没变。
 */
describe('② 每通道声纹特性表 + 音频回放', () => {
  const monitor = stripComments(read('src/renderer/src/views/MonitorView.vue'))
  const store = stripComments(read('src/renderer/src/stores/monitor.ts'))

  it('一行一通道，取自每通道读数，点击即切到那一路', () => {
    assert.ok(
      /v-for="row in pagedChannelFeatureRows"/.test(monitor),
      '每通道表没有按 pagedChannelFeatureRows 渲染（会变成当前那一路的重复）'
    )
    assert.ok(
      monitor.includes('monitor.channelFeatureOf(tab.index)'),
      '表的取数没有走每通道读数（channelFeatureOf）'
    )
    // 点击必须复用同一个通道切换入口，不许另写一套。
    assert.ok(
      /v-for="row in pagedChannelFeatureRows"[\s\S]{0,3000}?@click="selectChannel\(row.index\)"/.test(
        monitor
      ),
      '通道行没有走 selectChannel()'
    )
    // 八路各自一行：行数由设备返回的通道表决定，不是写死 8 行；每页 4 行翻页（第 22 条）。
    assert.ok(
      monitor.includes(':data-channel-feature-row="row.index"'),
      '行上缺少通道号的探针标记'
    )
    assert.ok(
      monitor.includes('listPageSlice(channelFeatureRows.value, channelFeaturePage.value, CHANNEL_FEATURE_PAGE_SIZE)'),
      '翻页没有走 listPaging 纯函数（页码夹取会漂移）'
    )
  })

  it('旧读数带时间与状态标记（否则它看起来就是实时值）', () => {
    assert.ok(
      monitor.includes('channelFeatureStateLabelKey(row.featureState)'),
      '表没有渲染读数状态（实时 / 最后一次读数 / 未读取）'
    )
    assert.ok(
      monitor.includes("t('monitorUi.channelFeatureUpdated', { time: featureTime(row.feature.timestamp) })"),
      '旧读数没有带更新时间'
    )
    // 三种状态必须是三种不同的视觉（第 17 条起是一枚 8px 圆点，绿=有读数、红=未读取），
    // 且状态文字必须留在 title / aria-label 里（圆点本身读不出来）。
    assert.ok(monitor.includes('channel-table__feature-dot--ok'), '有读数状态没有独立的圆点样式')
    assert.ok(monitor.includes('channel-table__feature-dot--miss'), '未读取状态没有独立的圆点样式')
    assert.ok(
      /:title="t\(channelFeatureStateLabelKey\(row\.featureState\)\)"/.test(monitor),
      '读数状态圆点没有带状态文字的提示（可访问性）'
    )
    // 第 17 条：标题右侧那句解释与"已启用/未启用"文字徽标都已删掉，不许回潮。
    assert.ok(!monitor.includes("t('monitorUi.channelFeaturesHint'"), 'channelFeaturesHint 还在引用（第 17 条要求删掉）')
    assert.ok(!monitor.includes('channelStateLabelKey(row.state)'), '通道行还在渲染"已启用/未启用"文字（第 17 条要求用颜色表达）')
    assert.ok(!monitor.includes('function featureStateClass'), '读数状态的文字徽标样式映射回来了（第 17 条要求删徽标）')
  })

  it('音频回放：说明文字已按第 21 条删除，播放/录音/音量收进波形卡头部', () => {
    // 第 21 条：`monitorUi.audioPreviewHint` 说明文字与独立 `.audio-bar` 卡一起删掉了。
    assert.ok(!monitor.includes("t('monitorUi.audioPreviewHint')"), 'audioPreviewHint 的引用还在（第 21 条要求清掉）')
    assert.ok(!stripComments(monitor).includes('class="card audio-bar"'), '独立的 .audio-bar 卡片还在（第 21 条要求并入波形卡）')
    assert.ok(!monitor.includes('audio-bar__'), '.audio-bar 的死样式还在')
    // 三个动作搬进了声学波形卡的头部：播放（canPlayAudio 禁用）、录音（isRunning 禁用）、
    // 音量（点击弹迷你滑杆浮层，点外面收起 —— 与画面墙同一套做法）。
    assert.ok(monitor.includes('@click="toggleAudio"'), '找不到播放按钮')
    assert.ok(
      monitor.includes('audioPlayer.setVolume(volumePercent.value)'),
      '音量没有推给播放器（滑杆会是个装饰）'
    )
    assert.ok(monitor.includes('@input="onVolumeInput"'), '音量滑杆没有接处理器')
    assert.ok(monitor.includes('data-waveform-volume-pop'), '音量浮层不见了')
    assert.ok(
      monitor.includes("document.addEventListener('mousedown', onVolumePopoverDocMouseDown, true)"),
      '音量浮层没有 click-outside 收起逻辑'
    )
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
 * ③b 实时趋势置顶 + 其下四张图谱卡片 + 时间轴回放（业主 2026-09-17；
 * 2026-09-21 第二批第 19 条把时间轴**并入趋势卡**，第 20 条把统计卡并进趋势卡右栏）。
 *
 * 这一条改动**只有版式**，所以它最容易悄悄退化：顺序一被改回去，页面照样能看，
 * 只是"一进页面要先滚动才看得到趋势"。因此这里钉的是**文档顺序**，不是"有没有这些卡片"。
 */
describe('③b 实时趋势置顶 + 其下四张图谱卡片 + 时间轴回放', () => {
  const monitor = stripComments(read('src/renderer/src/views/MonitorView.vue'))

  /**
   * 卡片标题在**模板**里的位置。
   *
   * 为什么不用 `t('monitorUi.xxx')` 直接找：脚本里也会引用同一个键（例如 ECharts 的
   * `series.name`），而脚本永远在模板之前 —— 那样比出来的顺序是假的（这一条踩过）。
   */
  const titleIndex = (key: string): number =>
    monitor.indexOf(`<h3 class="section-title">{{ t('${key}') }}</h3>`)

  it('趋势卡在四张图谱卡**之前**；声纹趋势卡内的时间轴已删（X 轴缩放覆盖），声呐支路保留原位', () => {
    const trend = titleIndex('monitorUi.trendSection')
    assert.ok(trend >= 0, '找不到实时趋势卡片')
    /*
     * 第 19 条曾经把声纹分支的时间轴并进趋势卡；业主 20260921 批又把它从趋势卡里**删掉**：
     * 趋势图的 X 轴缩放已经覆盖回放定位，卡内时间轴成了重复入口（全页只剩声呐分支那一处，
     * 那一族没有趋势卡）。这里钉的是"它没有在趋势卡里长回来"。
     */
    const trendCard = between(
      monitor,
      '<section class="chart-panel card trend-panel">',
      '\n      </section>',
      '趋势卡'
    )
    assert.equal(
      trendCard.includes('<MonitorRecordingTimeline'),
      false,
      '趋势卡里又长出了时间轴回放（业主：X 轴缩放已覆盖，删掉）'
    )
    // 检测模式的数据源口径说明收在卡头那颗 ⓘ 的悬停提示里（业主 20260921 批）。
    assert.ok(trendCard.includes('data-trend-info'), '趋势卡头没有 ⓘ 说明钩子（data-trend-info）')
    // 四张图谱卡仍在趋势卡之下（grid 现在带视图切换的 v-show）。
    const grid = monitor.indexOf('class="graph-grid"')
    const trendEnd = monitor.indexOf('\n      </section>', trend)
    assert.ok(grid > trendEnd, '四张图谱卡片不在趋势下面（③b 要求"其下"）')
    // 声呐分支没有趋势卡，那一支的时间轴保持在原位（DeviceInstallationCard /
    // AuscultationPanel 之后）。声纹页头里也有一枚 `v-else-if="isSonar"` 的机型徽标模板，
    // 所以取**最后一处**（页面分支那一块）。
    const sonarStart = monitor.lastIndexOf('<template v-else-if="isSonar">')
    assert.ok(sonarStart > 0, '找不到声呐分支')
    const sonar = monitor.slice(sonarStart, monitor.indexOf('</template>', sonarStart))
    assert.ok(sonar.includes('<MonitorRecordingTimeline'), '声呐分支的本机录音时间轴不在原位')
    // 全页恰好一处时间轴：声呐原位（声纹趋势卡内那一处已删）。
    assert.equal(
      (monitor.match(/<MonitorRecordingTimeline/g) ?? []).length,
      1,
      '时间轴应当是"仅声呐分支一处"（声纹趋势卡内的已删）'
    )
  })

  it('趋势卡片在最上面：页头之后、其余卡片之前', () => {
    const trend = titleIndex('monitorUi.trendSection')
    assert.ok(trend >= 0, '找不到实时趋势卡片')
    for (const after of [
      'monitorUi.channelFeaturesSection',
      'monitorUi.spectrumSection',
      'monitorUi.spectrogramSection',
      // 2026-09-21 第二批第 21 条：实时音频并入声学波形卡，audioSection 不再是卡片标题
      // （它是波形卡头部按钮组的 aria-label）；排序钉 waveformSection 就够。
      'monitorUi.waveformSection'
    ]) {
      const index = titleIndex(after)
      assert.ok(index > 0, `找不到 ${after} 的卡片标题`)
      assert.ok(trend < index, `${after} 排在了趋势卡片前面（趋势要求置顶）`)
    }
    // 音频并入波形卡之后，"实时音频"只能是按钮组的无障碍名字，不许再是一张卡片的标题。
    assert.equal(
      titleIndex('monitorUi.audioSection'),
      -1,
      'monitorUi.audioSection 又变成了卡片标题（第 21 条：实时音频并入声学波形卡）'
    )
  })

  it('四张图谱卡片就是业主确认的那四张（频谱 / 时频图 / 声学波形 / 每通道声纹特性）', () => {
    const grid = between(monitor, 'class="graph-grid">', '\n      </div>', '四张图谱卡片')
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
    /*
     * 2026-09-19（第 18 轮）改判据：它原来读 `monitor.audio`，现在读
     * `monitor.content.audio` —— 那是"此刻该画的那一份"（活的优先，没有活数据时是上次内容，
     * 见业主第 18 条）。**它读的仍然是真实存在的那一帧**（与「播放」按钮听到的是同一份数据），
     * 所以这条守卫要守的东西没变，只是名字变了。
     */
    assert.ok(option.includes('monitor.content.audio'), '声学波形没有读实时音频帧（或它的上次内容）')
    assert.ok(option.includes('?.waveform'), '声学波形没有画那一帧的包络')
    // 固定 ±1 量程：否则安静的帧会被自动缩放到和响的帧一样高。
    assert.match(option, /min: -waveformYMax,\s*\n\s*max: waveformYMax,/, '声学波形的纵轴不是以 0 为中心的对称量程（2026-09-23：0 点固定在卡片中心）')
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
