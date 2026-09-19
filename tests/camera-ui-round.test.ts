/**
 * 相机界面这一轮的三件事（告警对话框一行工具栏 / 两块屏幕重排 / 切换应用模式的确认）。
 *
 * ---------------------------------------------------------------------------
 * 为什么是一个新文件，而且断言长这样
 * ---------------------------------------------------------------------------
 * 这三件事全部落在**渲染层的排布与交互**上，而渲染层不参与 `tsconfig.tests.json`
 * 的编译（那份配置只收 `src/shared` 与 `src/main/services`）。所以这里用的是仓库里
 * 已有的做法：把 `.vue` 源码**当文本读**，钉住那些"改错了也不会有人发现"的东西
 * （见 `tests/page-layout.test.ts` 与 `tests/camera-autoplay.test.ts`）。
 *
 * 读源码的断言有个天然的上限：它**不能**证明屏幕上真的长这样。真实窗口里的几何
 * （四档尺寸下的左边距/列数/有没有横向溢出）由 `scripts/video-proof-driver.cjs`
 * 在一次真机运行里量。两层证据的分工写在这里，免得以后有人以为"单测过了就等于
 * 屏幕上对了"。
 *
 * 中文注释是仓库约定。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

function count(source: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  return [...source.matchAll(new RegExp(pattern.source, flags))].length
}

const ALARM = 'src/renderer/src/components/CameraAlarmDialog.vue'
const CONTROL = 'src/renderer/src/components/CameraControlPanel.vue'
const MONITOR = 'src/renderer/src/views/MonitorView.vue'
const DETAIL = 'src/renderer/src/views/DeviceDetailView.vue'

const alarm = read(ALARM)
const control = read(CONTROL)
const monitor = read(MONITOR)
const detail = read(DETAIL)

/** 取出一对标记之间的源码；找不到就断言失败（改名/删除必须报出来，不能静默通过）。 */
function between(source: string, open: string, close: string, label: string): string {
  const start = source.indexOf(open)
  assert.ok(start >= 0, `找不到 ${label} 的起点：${open}`)
  const end = source.indexOf(close, start + open.length)
  assert.ok(end > start, `找不到 ${label} 的终点：${close}`)
  return source.slice(start, end)
}

/**
 * 去掉 `.vue` 里的注释（HTML / CSS / 行注释 / 块注释）。
 *
 * 为什么必须有它：这一批断言里有好几条是"某个东西**已经不在了**"，而源码里那些
 * **解释性注释**恰恰写着"这里原来挂过 X，为什么删" —— 那是给下一个人看的，不是生效的代码。
 * 不剥注释的话，一条正确的删除会因为这些说明文字而报"还在"（本文件里就真的报过一次）。
 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

const monitorCode = stripComments(monitor)

// ---------------------------------------------------------------------------
// A. 告警配置对话框：删提示、三个控件一行、最右刷新图标
// ---------------------------------------------------------------------------

describe('A. 相机告警配置对话框：一行工具栏 + 最右刷新图标', () => {
  const toolbar = between(alarm, '<div class="toolbar">', '</div>\n\n    <p v-if="loading"', '工具栏')
  const tabs = between(toolbar, '<div class="tabs" role="tablist">', '</div>', '视图切换器')

  it('那一行提示（subtitle）已经从模板里消失', () => {
    assert.equal(
      alarm.includes('cameraAlarmUi.subtitle'),
      false,
      '模板里仍然渲染 cameraAlarmUi.subtitle：产品要求删掉这句话'
    )
    // 提示原本是这一段里唯一的 `<p class="muted">`，一起点名，免得换成别的键又回来。
    assert.equal(
      /<p class="muted">\{\{ t\('cameraAlarmUi\./.test(alarm),
      false,
      '工具栏上方又出现了一段 cameraAlarmUi 的说明文字'
    )
  })

  it('告警策略 / 告警条件 / 新建告警 在**同一行**里（切换器 + 一个新建按钮）', () => {
    const tabStrategies = toolbar.indexOf("t('cameraAlarmUi.tabStrategies')")
    const tabConditions = toolbar.indexOf("t('cameraAlarmUi.tabConditions')")
    const newStrategy = toolbar.indexOf("t('cameraAlarmUi.newStrategy')")
    const newCondition = toolbar.indexOf("t('cameraAlarmUi.newCondition')")
    assert.ok(tabStrategies >= 0, '工具栏里没有「告警策略」')
    assert.ok(tabConditions > tabStrategies, '「告警条件」不在「告警策略」之后')
    assert.ok(newStrategy > tabConditions, '「新建策略」不在两个页签之后（不在同一行）')
    assert.ok(newCondition > newStrategy, '「新建条件」不在「新建策略」之后（不在同一行）')

    // 两个页签是同一个 `role=tablist` 的两个 tab：这一行的语义就是**视图切换器**。
    assert.equal(count(tabs, /role="tab"/), 2, '视图切换器不是两个 role=tab')
    assert.equal(count(tabs, /role="tablist"/), 1, '视图切换器不是恰好一个 tablist')
    // 新建按钮是**一个**（`v-if` / `v-else` 两个分支，按当前视图取文案），不是两个并排。
    assert.equal(count(toolbar, /@click="startNewStrategy"/), 1, '工具栏里的「新建策略」不是恰好一个')
    assert.equal(count(toolbar, /@click="startNewCondition"/), 1, '工具栏里的「新建条件」不是恰好一个')
    assert.match(toolbar, /v-if="tab === 'strategies'"/, '新建按钮没有跟随当前视图')
    assert.match(toolbar, /v-else/, '新建按钮缺少另一个视图的分支')

    // 两个页签原来各自的「新建」按钮行必须已经撤销（否则一行里会出现两个新建）。
    assert.equal(
      count(alarm, /newStrategy/),
      2,
      '「新建策略」的出现次数不是 2（工具栏按钮 + 策略表单标题）'
    )
    assert.equal(
      count(alarm, /newCondition/),
      2,
      '「新建条件」的出现次数不是 2（工具栏按钮 + 条件表单标题）'
    )
    assert.equal(
      /<div class="btn-row">\s*<button[^>]*@click="startNewStrategy"/.test(alarm),
      false,
      '策略页里还留着一个独立的「新建策略」按钮行'
    )
    assert.equal(
      /<div class="btn-row">\s*<button[^>]*@click="startNewCondition"/.test(alarm),
      false,
      '条件页里还留着一个独立的「新建条件」按钮行'
    )
  })

  it('刷新是一个只有图标的按钮，名字由 aria-label 与 title 同时给出', () => {
    const refresh = toolbar.indexOf('toolbar__refresh')
    assert.ok(refresh >= 0, '工具栏里没有刷新按钮')
    const tag = between(toolbar, 'class="btn btn--sm btn--icon toolbar__refresh"', '>', '刷新按钮的开始标签')
    assert.match(tag, /:aria-label="t\('cameraAlarmUi\.refreshIcon'\)"/, '刷新按钮没有 aria-label')
    assert.match(tag, /:title="t\('cameraAlarmUi\.refreshIcon'\)"/, '刷新按钮没有 title')
    assert.equal(
      /cameraAlarmUi\.refresh'/.test(toolbar),
      false,
      '工具栏里仍然渲染文字版的 cameraAlarmUi.refresh'
    )
  })

  it('图标是内联 SVG（圆弧箭头），不引入任何图标依赖', () => {
    const svg = between(toolbar, '<svg', '</svg>', '刷新图标')
    assert.match(svg, /viewBox="0 0 24 24"/, '刷新图标缺少 viewBox')
    // 两条 path：一段圆弧 + 一个箭头。一条 `M…Z` 的实心圆不会是"箭头"。
    assert.equal(count(svg, /<path /g), 2, '刷新图标不是两条 path（圆弧 + 箭头）')
    assert.equal(count(svg, /<path[^>]*d="M[^"]*[Aa][^"]*"/g), 1, '刷新图标里没有圆弧段')
    // 形如 `<use>` / `<img>` / 图标字体都是"引入依赖"的写法。
    assert.equal(/<img|<use|xlink:href/.test(toolbar), false, '工具栏引用了外部图标资源')
  })

  it('图标刷新**真的回设备重读**（同一个 load()，而不是重新渲染内存里的旧数据）', () => {
    const refreshTag = between(
      toolbar,
      'class="btn btn--sm btn--icon toolbar__refresh"',
      '</button>',
      '刷新按钮'
    )
    assert.match(refreshTag, /@click="load"/, '刷新按钮没有调用 load()')
    const load = between(alarm, 'async function load(): Promise<void> {', '\n}\n', 'load()')
    assert.match(
      load,
      /window\.api\.cameraAlarms\.listStrategies\(deviceId\)/,
      'load() 没有重读告警策略'
    )
    assert.match(
      load,
      /window\.api\.cameraAlarms\.listConditions\(deviceId\)/,
      'load() 没有重读告警条件'
    )
    // 四个语言都要有这条名字，否则图标按钮在一部分语言里没有可访问名。
    for (const [locale, catalogue] of [
      ['zh-CN', zhCN],
      ['en', en],
      ['es', es],
      ['tr', tr]
    ] as const) {
      const value = (catalogue as { cameraAlarmUi: { refreshIcon: string } }).cameraAlarmUi.refreshIcon
      assert.ok(value.trim().length > 0, `${locale}.cameraAlarmUi.refreshIcon 为空`)
    }
  })
})

// ---------------------------------------------------------------------------
// B.「相机控制」面板与「实时监测」页：只改排布
// ---------------------------------------------------------------------------

describe('B1. 相机控制面板：分组 + 自适应列，控件一个都不少', () => {
  const boardOpen = control.indexOf('<div class="cctl__board">')
  const boardClose = control.indexOf('</div>\n    </section>', boardOpen)
  const board = between(control, '<div class="cctl__board">', '</div>\n    </section>', '排布板')

  it('四块分组都在板子里，板子本身是 auto-fit（无断点、无定宽列）', () => {
    assert.ok(boardOpen >= 0, '找不到 .cctl__board')
    assert.ok(boardClose > boardOpen, '找不到排布板的结束位置')
    assert.equal(count(board, /cctl__section-title/g), 4, '分组标题不是 4 个')
    for (const marker of [
      '<!-- ---- 检测模式',
      '<!-- ---- 应用场景',
      '<!-- ---- 检测启停',
      '<!-- ---- 启用中的告警策略',
      '<!-- ---- 维护',
      '<!-- ---- 固件升级'
    ]) {
      assert.ok(control.includes(marker), `找不到原来的一段：${marker}`)
    }
    const css = between(control, '.cctl__board {', '}', '排布板样式')
    assert.match(css, /display:\s*grid/, '.cctl__board 不是网格')
    assert.match(
      css,
      /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(\d+px,\s*1fr\)\)/,
      '.cctl__board 不是 auto-fit + 最小列宽的流式网格'
    )
  })

  it('七个控件组一个都没有丢，也没有被改名', () => {
    const once: Array<[string, RegExp, string]> = [
      ['检测模式·单次', /@click="selectMode\(1\)"/g, '检测模式「单次检测」'],
      ['检测模式·巡航', /@click="selectMode\(-1\)"/g, '检测模式「智能巡航」'],
      ['检测启停·开始', /detectAction\('turn_on'\)/g, '「开始检测」'],
      ['检测启停·停止', /detectAction\('turn_off'\)/g, '「停止检测」'],
      ['启用/停用策略', /@click="toggleStrategy"/g, '「启用 / 停用」策略'],
      ['打开 Web 界面', /@click="openWebUi"/g, '「打开相机 Web 界面」'],
      ['选择升级包', /@click="choosePackage"/g, '「选择升级包」'],
      ['上传', /openConfirm\('upload'\)/g, '「上传」'],
      ['重启', /openConfirm\('reboot'\)/g, '「重启设备」'],
      ['读设备进度', /@click="readDeviceProgress"/g, '「读取设备进度」']
    ]
    for (const [label, pattern, human] of once) {
      assert.equal(count(control, pattern), 1, `${label}：${human} 不是恰好一个`)
    }

    // 应用场景的三个预设按钮仍然由数据驱动（不是被写死成两个或四个）。
    assert.match(control, /v-for="preset in CAMERA_MODE_PRESETS"/, '应用场景的三个预设按钮不见了')
    assert.match(control, /@click="applyPreset\(preset\.id\)"/, '预设按钮没有调用 applyPreset')
    assert.match(control, /@click="restorePreset"/, '「还原」按钮不见了')
    assert.match(control, /@click="reapplyPreset"/, '「重写一遍」按钮不见了')
    // 版本 / 维护 / 升级包三块信息表都还在（第三块的选择器上还挂着确认框的类）。
    assert.equal(
      count(control, /class="cctl__info[\s"]/g),
      3,
      '信息表（版本 / 升级包 / 确认框）不是 3 个'
    )
    assert.match(control, /t\('cameraControlUi\.firmwareVersion'\)/, '维护版本信息不见了')
    assert.match(control, /feature\('rollback'\)/, '「版本回滚」不见了')
    assert.match(control, /feature\('factory_reset'\)/, '「恢复出厂」不见了')
  })

  it('板子的 CSS 没有自带居中：没有 margin auto、没有定宽列', () => {
    const css = between(control, '.cctl__board {', '}', '排布板样式')
    assert.equal(/margin[^;]*auto/.test(css), false, `.cctl__board 里出现了自动外边距：${css}`)
    assert.equal(/max-width/.test(css), false, `.cctl__board 里出现了 max-width：${css}`)
    assert.equal(/@media/.test(control), false, '这一轮不引入断点（列数应当由 auto-fit 决定）')
  })
})

describe('B2. 实时监测页：相机块并排，声学箱分支不动', () => {
  it('相机页有一个自适应板子，整幅宽的只有必须整幅宽的那两块', () => {
    const css = between(monitor, '.camera-board {', '}', '排布板样式')
    assert.match(css, /display:\s*grid/, '.camera-board 不是网格')
    assert.match(
      css,
      /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(\d+px,\s*1fr\)\)/,
      '.camera-board 不是 auto-fit + 最小列宽的流式网格'
    )
    // `minmax(0, …)` 的 0 是刻意的：`auto` 会让 1024 点的 canvas 顶出横向滚动条。
    assert.match(control + monitor, /minmax\(\d+px,\s*1fr\)/, '看不到最小列宽')
    /**
     * 整幅宽的三块：设备头与相机五路图谱写在模板的 `class` 上（⑧ 那一块见下面那条用例），
     * 单路直播靠 `.camera-board > .camera-live` 规则。
     *
     * 这里数的是**用法**（`class="…camera-board__wide"`）而不是这个类名在文件里出现的次数：
     * 注释里也会提到它，数出现次数会被注释绊倒 —— 这条断言因此被绊倒过两次了。
     */
    assert.equal(
      count(monitor, /class="[^"]*camera-board__wide"/g),
      2,
      '模板里带整幅宽标记的应当恰好两处（设备头 + 相机五路图谱）'
    )
    assert.equal(
      count(monitor, /class="card monitor-head camera-board__wide"/g),
      1,
      '设备头不是恰好一处整幅宽标记'
    )
    assert.match(monitor, /\.camera-board > \.camera-live/, '单路直播没有整幅宽规则')
    // 覆盖层不参与网格，否则会占掉一格把并排拆散。
    /*
     * 数的是**用法**：`class="camera-board__overlay"` 恰好 4 个（右键菜单 + 告警配置 +
     * 本机回放 + 检测记录下载，⑤ 之后是四个）。CSS 选择器与说明注释里也会出现这个
     * 类名，所以**不数出现次数** —— 同一个坑 `camera-board__wide` 那条已经踩过两次。
     */
    assert.equal(
      count(monitor, /class="camera-board__overlay"/g),
      4,
      '四个覆盖层（右键菜单 / 告警配置 / 本机回放 / 检测记录下载）没有都标上 camera-board__overlay'
    )
    assert.match(monitor, /\.camera-board__overlay \{/, '覆盖层的 display:contents 规则不见了')
  })

  it('相机页的四块都在板子里，且文档顺序没变（⑦ 之后：视频墙已删；⑧：五路图谱回来了）', () => {
    const boardOpen = monitor.indexOf('<div class="camera-board">')
    const boardClose = monitor.indexOf('</div>\n\n      <!-- ---- acoustic box', boardOpen)
    assert.ok(boardOpen >= 0, '找不到 .camera-board')
    assert.ok(boardClose > boardOpen, '找不到 .camera-board 的结束位置')
    const head = monitor.indexOf('<section class="card monitor-head camera-board__wide">')
    const live = monitor.indexOf('<section v-if="isCamera" class="card camera-live">')
    const acoustic = monitor.indexOf('<CameraAcousticPanel')
    const controlPanel = monitor.indexOf('<CameraControlPanel')
    const alarmCard = monitor.indexOf('class="card camera-alarm-entry"')
    for (const [label, index] of [
      ['设备头', head],
      ['单路直播', live],
      ['相机五路图谱', acoustic],
      ['相机控制', controlPanel],
      ['告警卡片', alarmCard]
    ] as const) {
      assert.ok(index > boardOpen && index < boardClose, `${label} 不在排布板里`)
    }
    assert.ok(
      head < live && live < acoustic && acoustic < controlPanel && controlPanel < alarmCard,
      '相机页几块的文档顺序被改变了（Tab 顺序也会跟着变）'
    )
    // ⑦ 删掉的视频墙：删的是**这一页的用法**，不是组件（总览页仍然是主视图）。
    assert.equal(
      monitor.includes('<CameraVideoWall'),
      false,
      '实时监测页又挂上了视频墙（⑦ 要求删掉它）'
    )
    /**
     * ⑧（业主 2026-09-17 确认）把相机声学数据按**新版式**放回来了：五路实时数据排成一排。
     *
     * 这里**不再**断言"它不在" —— ⑦ 删掉的是它的旧版式（竖排/自动换行的五张卡），
     * ⑧ 定的就是新版式。要钉住的是"它在"且"它是整幅宽的那一块"：挤在板子的一格里，
     * 五张图每张只剩 ~60px，那也"是一排"，但读不出来。
     */
    const usage = between(monitor, '<CameraAcousticPanel', '/>', '相机五路图谱那一块')
    assert.ok(
      usage.includes('camera-board__wide'),
      '相机五路图谱没有整幅宽（camera-board__wide）—— 五张图会挤在板子的一格里'
    )
  })

  it('相机页的三条既有行为一条都没有被这次重排碰到', () => {
    // `<video>` 仍然由地址守卫（没有地址时渲染的是状态占位，不是一个空播放器）。
    assert.ok(monitor.includes('<video\n            v-if="cameraLiveUrl"') ||
      /<video\s+v-if="cameraLiveUrl"/.test(monitor), '`<video>` 不再由地址守卫')
    assert.ok(monitor.includes('class="camera-live__video"'), '缺少 camera-live__video')
    assert.ok(monitor.includes('ref="stageEl"'), '全屏用的 stage ref 不见了')
    // 全屏是右键菜单里的一个动作：`toggleFullscreen()` 仍然请求 stage 本身进全屏。
    assert.ok(
      monitor.includes('async function toggleFullscreen(): Promise<void> {'),
      'toggleFullscreen() 不见了'
    )
    assert.ok(monitor.includes('requestFullscreen()'), '全屏没有作用在 stage 上')
    assert.ok(monitor.includes("case 'toggle-fullscreen':"), '菜单里的全屏分支不见了')
    assert.ok(monitor.includes('v-if="recording" class="camera-live__rec"'), '录像指示器不见了')
    assert.ok(monitor.includes('@contextmenu="onCameraContextMenu"'), '右键 NVR 菜单不见了')
    assert.ok(monitor.includes('class="camera-live__overlay"'), '叠加信息不见了')
  })

  it('声学箱（非相机）分支：③ 之后少了「数据流状态」与「当前帧」，其余保持', () => {
    const box = between(
      monitor,
      '<!-- ---- acoustic box',
      '\n      </template>\n',
      '声学箱分支'
    )
    assert.ok(box.length > 1500, '声学箱分支没有被切出来')
    // 八张卡：两张按 ③ 删掉了（数据流状态、当前帧），其余一张都不少。
    for (const key of [
      'metrics.spl',
      'metrics.mainFrequency',
      'metrics.smoothness',
      'metrics.bandEnergyRatio',
      'monitorUi.audioSection',
      'monitorUi.trendSection',
      'monitorUi.spectrumSection',
      'monitorUi.spectrogramSection'
    ]) {
      assert.ok(box.includes(`t('${key}')`), `声学箱分支少了 ${key}`)
    }
    // ③ 删掉的两张**必须真的不在**（键也不许在模板里出现）。
    for (const gone of ['monitorUi.streamSection', 'monitorUi.currentFrameSection', 'stream-strip']) {
      assert.equal(
        monitorCode.includes(gone),
        false,
        `③ 要求删掉的 ${gone} 还在实时监测页的生效代码里`
      )
    }
    assert.ok(box.includes('@click="toggleRecording"'), '录音按钮不见了')
    assert.ok(box.includes('<AudioLevelMeter'), '音量条不见了')
    assert.ok(box.includes('<SpectrogramViewer'), '时谱图不见了')
    assert.ok(box.includes('<EChart'), '图表不见了')
    /*
     * 会话启停按钮**已经不在了**（业主 2026-09-19 第 13 批第 3 条：选中设备就默认开始
     * 接收数据，不用点「开始监测」）。这一条从"恰好一个按钮"改成"**恰好零个**"：
     * 判据与三条自动开始的路径一起钉在 `tests/monitor-autostart.test.ts` 里，
     * 这里只守住"这一页不再有那个按钮"。
     */
    assert.equal(
      count(monitor, /@click="toggleSession"/g),
      0,
      '「开始 / 停止」会话按钮应该已经删掉（第 13 批第 3 条）'
    )
    /*
     * ③b 之后这一块从两块（频谱 + 时谱）变成四块（另加声学波形与每通道特性），
     * 规则也改名为 `.graph-grid`，最小列宽 420px。这一条按**新名字**断言，
     * 而不是把旧名字留在测试里（测试引用一个已经不存在的选择器 = 一条什么都不测的断言）。
     */
    const graphGrid = between(monitor, '.graph-grid {', '}', '四张图谱卡片的并排规则')
    assert.match(
      graphGrid,
      /repeat\(auto-fit,\s*minmax\(420px,\s*1fr\)\)/,
      '四张图谱卡片的最小列宽不是 420px'
    )
  })
})

// ---------------------------------------------------------------------------
// C. 切换应用模式：写之前必须确认
// ---------------------------------------------------------------------------

describe('C. 切换应用模式：确认之后才写', () => {
  it('三个入口都走 requestWorkMode()，并且它自己**不写设备**', () => {
    assert.equal(
      count(control, /@click="selectWorkMode\(value\)"/g),
      0,
      '还有按钮直接调用 selectWorkMode()：确认框被绕过了'
    )
    assert.equal(
      count(control, /@click="requestWorkMode\(value\)"/g),
      1,
      '应用模式的按钮没有走 requestWorkMode()'
    )
    const request = between(
      control,
      'function requestWorkMode(next: Fa371WorkModeValue): void {',
      '\n}\n',
      'requestWorkMode()'
    )
    assert.equal(
      /window\.api\./.test(request),
      false,
      'requestWorkMode() 里出现了设备调用：确认之前不许发任何请求'
    )
    assert.match(request, /pendingWorkMode\.value = next/, 'requestWorkMode() 没有记下待确认的模式')
    // `selectWorkMode()` 仍然是唯一的写入口，而且只有确认路径调用它。
    assert.equal(count(control, /selectWorkMode\(next\)/g), 1, 'selectWorkMode() 的调用点不是恰好一个')
    const confirm = between(
      control,
      'async function confirmWorkMode(): Promise<void> {',
      '\n}\n',
      'confirmWorkMode()'
    )
    assert.match(confirm, /await selectWorkMode\(next\)/, '确认之后没有真的调用写入口')
    assert.match(confirm, /if \(next === null\) return/, '确认时没有守住"没有待确认模式"这条')
  })

  it('对话框用的是破坏性确认的形状：不可点遮罩关闭 + 危险按钮', () => {
    const dialog = between(
      control,
      ':title="t(\'cameraControlUi.appModeConfirmTitle\')"',
      '</AppModal>',
      '应用模式确认框'
    )
    assert.match(dialog, /:close-on-overlay="false"/, '确认框可以被点遮罩关掉')
    assert.match(dialog, /t\('cameraControlUi\.appModeConfirmBody'\)/, '确认框没有那句提示')
    assert.match(dialog, /t\('common\.cancel'\)/, '确认框没有取消按钮')
    assert.match(dialog, /appModeConfirmAction/, '确认框没有确认按钮')
    assert.match(dialog, /btn--danger/, '确认按钮不是危险样式')
    assert.match(dialog, /:disabled="busy"/, '确认按钮没有防重复提交')
    // 取消 = 一个字节都不写。
    const cancel = between(control, 'function cancelWorkMode(): void {', '\n}\n', 'cancelWorkMode()')
    assert.match(cancel, /pendingWorkMode\.value = null/, '取消没有清掉待确认状态')
    assert.equal(/window\.api\./.test(cancel), false, '取消路径里出现了设备调用')
    // 焦点不能默认落在"继续切换"上：`AppModal` 会聚焦**第一个可聚焦元素**，而确认框
    // 的页脚是「取消」在前 —— 所以一记回车是取消。这条禁令说的是"别给确认按钮加
    // `data-autofocus`"（那会让回车直接切模式），而不是要求别处必须有这个属性。
    assert.equal(
      /data-autofocus/.test(dialog),
      false,
      '确认框里出现了 data-autofocus：焦点会被拉到确认按钮上'
    )
    const footer = between(dialog, '<template #footer>', '</template>', '确认框页脚')
    const cancelIndex = footer.indexOf("t('common.cancel')")
    const actionIndex = footer.indexOf('appModeConfirmAction')
    assert.ok(cancelIndex >= 0, '确认框页脚里没有取消按钮')
    assert.ok(actionIndex > cancelIndex, '确认按钮排在取消之前：默认焦点会落在破坏性动作上')
  })

  it('产品指定的那句话在四种语言里都在，中文逐字一致', () => {
    assert.equal(
      (zhCN as { cameraControlUi: { appModeConfirmBody: string } }).cameraControlUi.appModeConfirmBody,
      '切换模式会清空全部的存储数据，是否继续？',
      '中文确认正文不是产品指定的原话'
    )
    for (const [locale, catalogue] of [
      ['en', en],
      ['es', es],
      ['tr', tr]
    ] as const) {
      const body = (catalogue as { cameraControlUi: { appModeConfirmBody: string } }).cameraControlUi
        .appModeConfirmBody
      assert.ok(body.trim().length > 0, `${locale} 的确认正文为空`)
      assert.notEqual(body, '切换模式会清空全部的存储数据，是否继续？', `${locale} 没有翻译`)
      // 这句话里不应有占位符：四个语言必须说同一句话。
      assert.equal(/\{\w+\}/.test(body), false, `${locale} 的确认正文里混进了占位符`)
    }
  })

  it('应用场景预设（applyModePreset）**不写** work_mode，所以它不需要确认框', () => {
    // 这一条是"读出来的"而不是"猜的"：`applyModePreset()` 只构造 acoustic + imaging
    // 两份请求值，写路径只发 `/system/acoustic` 与 `/system/image`；前端这一侧也
    // 只有 `selectWorkMode()` 一个调用点（上面已经断言）。
    const preset = between(
      control,
      'async function applyPreset(id: CameraModePresetId): Promise<void> {',
      '\n}\n',
      'applyPreset()'
    )
    assert.match(preset, /window\.api\.cameraControl\.applyModePreset\(/, 'applyPreset 没有走预设通道')
    assert.equal(/writeWorkMode/.test(preset), false, 'applyPreset() 里出现了 writeWorkMode')
    assert.equal(
      /pendingWorkMode/.test(preset),
      false,
      'applyPreset() 弹了应用模式的确认框：它并不写 work_mode'
    )
    // 反过来，`selectWorkMode()` 只写 work_mode，不碰成像参数。
    const select = between(
      control,
      'async function selectWorkMode(next: Fa371WorkModeValue): Promise<void> {',
      '\n}\n',
      'selectWorkMode()'
    )
    assert.match(select, /window\.api\.cameraControl\.writeWorkMode\(/, 'selectWorkMode 没有写 work_mode')
    assert.equal(/applyModePreset/.test(select), false, 'selectWorkMode() 里出现了 applyModePreset')
  })
})

// ---------------------------------------------------------------------------
// 目录：这一轮新增/删除的键
// ---------------------------------------------------------------------------

describe('相机界面这一轮的目录条目', () => {
  const CATALOGUES = { 'zh-CN': zhCN, en, es, tr } as const

  it('删掉的两个孤儿键在四种语言里都不复存在', () => {
    for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
      const alarmUi = (catalogue as { cameraAlarmUi: Record<string, string> }).cameraAlarmUi
      assert.equal('subtitle' in alarmUi, false, `${locale}.cameraAlarmUi.subtitle 仍然存在（孤儿键）`)
      assert.equal('refresh' in alarmUi, false, `${locale}.cameraAlarmUi.refresh 仍然存在（孤儿键）`)
    }
  })

  /**
   * 第 23 条（2026-09-18 第 10 批）：「删除「相机声学数据」窗口、数据默认实时接收」。
   *
   * 两个键是被删掉的那个窗口专用的，所以它们必须一起消失 —— 留着一个没人引用的
   * `cameraStreamUi.start`，下一个人很容易顺着它把「开始接收」按钮画回来，
   * 而"默认就在收"这件事会被那颗按钮重新变成一个动作。
   */
  it('㉓ 被删掉的窗口标题与「开始接收」两个键在四种语言里都不复存在', () => {
    for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
      const streamUi = (catalogue as { cameraStreamUi: Record<string, string> }).cameraStreamUi
      assert.equal('title' in streamUi, false, `${locale}.cameraStreamUi.title 仍然存在（窗口已删）`)
      assert.equal('start' in streamUi, false, `${locale}.cameraStreamUi.start 仍然存在（不再有开始按钮）`)
      // 保留下来的那几档状态必须还在：删的是窗口，不是"能不能看出流没起来"。
      for (const key of ['sessionIdle', 'sessionRunning', 'sessionError', 'stop']) {
        assert.ok(
          typeof streamUi[key] === 'string' && streamUi[key].trim().length > 0,
          `${locale}.cameraStreamUi.${key} 丢失了（状态仍然要说得出来）`
        )
      }
    }
  })

  /**
   * 第 24 条（2026-09-18 第 10 批）：「该页（相机页）支持检测模式、告警配置、告警信息与历史告警展示」。
   *
   * 四件事各自的落点，以及**一处与既有决定的冲突**：
   *   · **检测模式**：「模式」那一段（工作模式＝局放/气体泄漏/机械）按 2026-09-17（⑨）**搬去了**
   *     设备详情页；第 24 条把它要回来了 —— 所以这里钉的是"它在这一页的 `sections` 里"，
   *     同时钉住设备详情页那几个页签**没有**被删（同一份组件、两个入口）。
   *   · **告警配置**：对话框（本来就在）。
   *   · **告警信息**：这一台最近十条告警，就地列出来。
   *   · **历史告警展示**：「查看告警记录」必须带上 `?device=`，并且告警记录页要认这个参数
   *     （一个从"这一台"出发的入口落到全库列表上是答非所问）。
   */
  it('㉔ 检测模式回到这一页，而设备详情页那几个页签没有丢（同组件两个入口）', () => {
    assert.match(
      monitor,
      /:sections="\['mode', 'detect', 'preset'\]"/,
      '相机页的控制面板没有包含「模式」（检测模式）那一段'
    )
    // 设备详情页仍然按自己的页签取用同一个组件（不是把组件搬回来）。
    const detailUsage = detail.slice(detail.indexOf('<CameraControlPanel'))
    assert.ok(
      detailUsage.includes(':sections='),
      '设备详情页不再按 sections 取用控制面板：两个入口开始分叉'
    )
    assert.ok(
      detail.includes("import CameraControlPanel from '@renderer/components/CameraControlPanel.vue'"),
      '设备详情页不再用同一个组件：会出现第二份实现'
    )
  })

  it('㉔ 告警信息就地列出来，取数与告警记录页同源', () => {
    assert.ok(monitor.includes('data-camera-alarms'), '相机页没有告警信息那一块')
    assert.ok(monitor.includes('data-camera-alarms-empty'), '没有"这台相机还没有告警"的空态')
    /*
     * 这一次查询现在**两种机型共用**（第 13 批第 3 条要给每一路通道标"是否告警"，
     * 它读的是同一份 `alarms.query`），条数也从写死的 10 改成具名常量
     * `DEVICE_ALARM_SAMPLE`（50）：采样窗口是界面上要说明的事实，不该是一个藏在
     * IPC 调用里的字面量。所以断言改成"按这台设备查 + 条数来自那个常量"。
     */
    assert.match(
      monitor,
      /window\.api\.alarms\.query\(\{ deviceId, limit: DEVICE_ALARM_SAMPLE \}\)/,
      '告警信息不是按这台设备查的（那会显示别的相机的告警）'
    )
    assert.match(
      monitor,
      /const DEVICE_ALARM_SAMPLE = \d+/,
      'DEVICE_ALARM_SAMPLE 不是一个具名常量（读它的地方会各写一个数字）'
    )
    // 换设备要重新读：否则列表还是上一台的。
    const switchBlock = monitor.slice(monitor.indexOf('watch(selectedDeviceId'))
    assert.match(
      switchBlock.slice(0, 3000),
      /await loadDeviceAlarms\(id\)/,
      '换设备之后没有重新读告警信息'
    )
    // 切走之后到达的结果不许写进另一台的列表。
    assert.match(
      monitor,
      /if \(selectedDeviceId\.value !== deviceId\) return/,
      '告警信息的回包没有做"还是不是这一台"的守卫'
    )
  })

  it('㉔ 「查看告警记录」带上这一台设备，而且告警记录页认这个参数', () => {
    assert.match(
      monitor,
      /:to="\{ path: '\/alarms', query: \{ device: selectedDeviceId \} \}"/,
      '「查看告警记录」没有带上这一台设备'
    )
    const alarms = read('src/renderer/src/views/AlarmsView.vue')
    assert.match(alarms, /const route = useRoute\(\)/, '告警记录页没有读路由')
    assert.match(
      alarms,
      /const fromQuery = typeof route\.query\.device === 'string' \? route\.query\.device : ''/,
      '告警记录页没有读 ?device='
    )
    // 预置必须**排在 reload 之前**：读一次库就够。
    const mountedBlock = alarms.slice(alarms.indexOf('onMounted(async () => {'))
    const mountedBody = mountedBlock.slice(0, mountedBlock.indexOf('\n})'))
    assert.ok(
      mountedBody.indexOf('filters.deviceId = fromQuery') < mountedBody.indexOf('await reload()'),
      '?device= 预置排在 reload 之后：那一次查询仍然是不筛设备的'
    )
    // 过期的书签（设备已经不在库里）不许把列表筛成空的。
    assert.match(
      mountedBody,
      /devices\.devices\.some\(\(device\) => device\.id === fromQuery\)/,
      '?device= 没有校验设备是否存在'
    )
  })

  it('新增的文案在四种语言里齐全', () => {
    for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
      const alarmUi = (catalogue as { cameraAlarmUi: Record<string, string> }).cameraAlarmUi
      assert.ok(
        typeof alarmUi.noAlarms === 'string' && alarmUi.noAlarms.trim().length > 0,
        `${locale}.cameraAlarmUi.noAlarms 缺失`
      )
      assert.match(alarmUi.noAlarms, /相机|camera|cámara|kamera/i,
        `${locale} 的空态没有说清是"这一台相机"`)
    }
  })

  it('新增的四个键在四种语言里都有非空译文', () => {
    const keys: Array<[string, string]> = [
      ['cameraAlarmUi', 'refreshIcon'],
      ['cameraControlUi', 'appModeConfirmTitle'],
      ['cameraControlUi', 'appModeConfirmBody'],
      ['cameraControlUi', 'appModeConfirmAction']
    ]
    for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
      for (const [group, key] of keys) {
        const value = (catalogue as unknown as Record<string, Record<string, string>>)[group]?.[key]
        assert.ok(
          typeof value === 'string' && value.trim().length > 0,
          `${locale}.${group}.${key} 缺失或为空`
        )
      }
    }
  })

  it('两个组件模板里引用的每一个 cameraAlarmUi / cameraControlUi 键都能解析', () => {
    for (const [label, source, groups] of [
      ['CameraAlarmDialog', alarm, ['cameraAlarmUi']],
      ['CameraControlPanel', control, ['cameraControlUi', 'cameraUpgradeUi']]
    ] as const) {
      const referenced = new Set<string>()
      for (const group of groups) {
        for (const match of source.matchAll(new RegExp(`t\\('(${group}\\.\\w+)'`, 'g'))) {
          referenced.add(match[1] as string)
        }
      }
      assert.ok(referenced.size > 0, `${label} 里没有解析出任何目录键`)
      for (const key of referenced) {
        const [group, name] = key.split('.') as [string, string]
        const value = (zhCN as unknown as Record<string, Record<string, string>>)[group]?.[name]
        assert.equal(typeof value, 'string', `${label} 引用了不存在的键 ${key}`)
      }
    }
  })
})
