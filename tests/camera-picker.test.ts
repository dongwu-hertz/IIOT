/**
 * 画面格上的相机选择器（业主 2026-09-18 报的 bug 的守卫）。
 *
 * WHY THIS FILE EXISTS
 * 报告的原话是「在设备总览界面点击添加视频通道，弹出请选择相机，但是好像位置被盖住了，
 * 没有显示出来」。根因不在样式，而在**选择器是原生 `<select>`、挂在墙末尾的 1×1 隐藏
 * 宿主里、用 `showPicker()` 打开**：原生下拉贴在那个 1×1 的盒子上，而那个盒子在页面
 * 左上区 —— 真窗口里量到（1440×900，`scripts/demo-shot-driver.cjs` 的 `camera picker`
 * 探针）宿主 `{left:273, top:97, width:1, height:1}`、被点的那一格
 * `{left:834, top:148}`，相距 **561px**。清单弹在操作员没在看的地方，于是「像没显示」。
 *
 * 所以修法是把「开在哪里」变成我们自己的算术 + 自己的浮层，而这两件事都能在没有浏览器
 * 的情况下被读源码钉住（本文件），也能在真窗口里被量出来（探针）。两层证据的分工与
 * `tests/camera-ui-round.test.ts` 写的是同一条：**单测过了不等于屏幕对了**。
 *
 * 中文注释是仓库约定。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  // 统一行尾（源码文件是 CRLF）：本文件的断言都是「有没有这段结构」，
  // 与行尾无关；不统一的话 `between()` 的 `\n}\n` 终点在 CRLF 文件里永远找不到。
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8').replace(/\r\n/g, '\n')
}

/**
 * 去掉 `.vue` 里的注释。
 *
 * 必须去：本组里有好几条断言是「某个东西**已经不在了**」（隐藏宿主、`showPicker()`），
 * 而源码里解释「为什么删掉它」的注释恰好写着那几个字。
 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 取出一对标记之间的源码；找不到就直接失败（改名/删除必须报出来）。 */
function between(source: string, open: string, close: string, label: string): string {
  const start = source.indexOf(open)
  assert.ok(start >= 0, `找不到 ${label} 的起点：${open}`)
  const end = source.indexOf(close, start + open.length)
  assert.ok(end > start, `找不到 ${label} 的终点：${close}`)
  return source.slice(start, end)
}

const WALL = 'src/renderer/src/components/CameraVideoWall.vue'
const PICKER = 'src/renderer/src/components/CameraCellPicker.vue'

const wall = stripComments(read(WALL))
const picker = stripComments(read(PICKER))

describe('A. 格内覆盖层：铺在被点的那一格里面、键盘与「点外面」都关得掉', () => {
  it('inline 模式：不 Teleport、不算落点、铺满整格（业主 2026-09-24）', () => {
    assert.match(picker, /<Teleport to="body" :disabled="inline">/)
    assert.match(picker, /props\.inline/)
    assert.match(picker, /picker--inline/)
    assert.match(picker, /data-camera-picker\b/)
    // 覆盖层铺整格：绝对定位 + inset: 0（相对 `position: relative` 的格子）。
    assert.match(picker, /position: absolute/)
    assert.match(picker, /inset: 0/)
  })

  it('不再依赖原生下拉：整个组件里没有 showPicker / <select> / <option>', () => {
    assert.equal(/showPicker/.test(picker), false, '又用回 showPicker() 了')
    assert.equal(/<select/.test(picker), false, '浮层里又出现了原生 <select>')
    assert.equal(/<option/.test(picker), false, '浮层里又出现了原生 <option>')
  })

  it('键盘：方向键移动、回车选中、Esc 关掉、Tab 不把焦点扔出应用', () => {
    const keydown = between(picker, "switch (event.key) {", '\n}\n', '键盘处理')
    for (const key of ["case 'Escape'", "case 'ArrowDown'", "case 'ArrowUp'", "case 'Enter'", "case 'Tab'"]) {
      assert.ok(keydown.includes(key), `键盘处理里没有 ${key}`)
    }
    // Escape 与 Tab 都必须 `close()`；方向键只移动高亮（`move()`）。
    assert.match(keydown, /case 'Escape':[\s\S]*?close\(\)/)
    assert.match(keydown, /case 'Tab':[\s\S]*?close\(\)/)
    // Teleport 到 body 之后，Tab 的默认行为会把焦点带到 `<body>` 之外的别处。
    assert.match(keydown, /case 'Tab':[\s\S]*?preventDefault\(\)/)
  })

  it('点外面 / 滚动 / 改窗口大小都会关掉，而且 mousedown 用的是捕获阶段', () => {
    assert.match(picker, /addEventListener\('mousedown', onDocumentMouseDown, true\)/)
    assert.match(picker, /addEventListener\('resize', close\)/)
    assert.match(picker, /addEventListener\('scroll', close, true\)/)
    // 触发按钮不算「外面」：否则「再点一次收起」会变成「先关再开」，看起来像没反应。
    assert.match(picker, /data-camera-picker-trigger/)
  })

  it('没得选的时候会说一句短状态词，而不是画一块空浮层', () => {
    assert.match(picker, /items\.length === 0/)
    assert.match(picker, /class="picker__empty"/)
  })
})

describe('B. 墙上那两个入口：选择器铺在被点的那一格里面', () => {
  it('`+` 与设备名按钮都带 data-camera-picker-trigger，两处共用同一个 togglePicker()', () => {
    const triggers = wall.match(/data-camera-picker-trigger/g) ?? []
    assert.equal(triggers.length, 2, `触发按钮应当恰好两个（空白格的 + 与叠加条的设备名），实际 ${triggers.length}`)
    const handlers = wall.match(/@click\.stop="togglePicker\(cell, \$event\)"/g) ?? []
    assert.equal(handlers.length, 2, '两个入口必须走同一个 togglePicker()')
  })

  it('选择器渲染在格子内部（inline 覆盖层），不再量锚点', () => {
    assert.match(wall, /<CameraCellPicker[\s\S]{0,200}inline[\s\S]{0,200}:anchor="null"/)
    // 格内覆盖层不需要锚点矩形：togglePicker 不再量格子尺寸。
    const toggle = between(wall, 'function togglePicker(', '\n}\n', 'togglePicker')
    assert.equal(/getBoundingClientRect/.test(toggle), false, '又回去量格子矩形了')
    assert.equal(/clientX|clientY/.test(toggle), false, '锚点又变成鼠标位置了')
  })

  it('选项只有一份来源：optionsForCell()', () => {
    const items = between(wall, 'const pickerItems = computed<CameraPickerItem[]>', '\n})', 'pickerItems')
    assert.match(items, /optionsForCell\(cell\)/)
  })

  it('选中之后先收起浮层、把 (设备, 视图) 交给 store、最后读回那一格', () => {
    const pick = between(wall, 'async function pickDevice(', '\n}\n', 'pickDevice')
    assert.match(pick, /closePicker\(false\)/)
    // 被替换的旧内容只有在本格失去它的最后一份时才停会话（同 id 还显示在别格就不停）。
    assert.match(pick, /await stopCell\(cell\)/)
    assert.match(pick, /wall\.placeDevice\(slot, deviceId, view\)/)
    // 键盘用户选完之后焦点要留在这一格（否则掉到 body，下一次 Tab 从窗口开头重来）。
    assert.match(pick, /\.focus\(\)/)
  })

  it('关掉浮层时把焦点还给触发它的那个按钮', () => {
    const close = between(wall, 'function closePicker(', '\n}\n', 'closePicker')
    assert.match(close, /document\.contains\(trigger\)/)
    assert.match(close, /trigger\.focus\(\)/)
  })

  it('隐藏宿主与 showPicker() 都不在了（这个 bug 的成因）', () => {
    assert.equal(wall.includes('camera-wall__pickers'), false, '又出现了墙末尾的隐藏宿主')
    assert.equal(wall.includes('wall-pick-'), false, '又出现了隐藏的原生 <select>')
    assert.equal(wall.includes('showPicker'), false, '又用回 showPicker() 了')
    assert.equal(/<select/.test(wall), false, '画面格里又出现了原生 <select>')
  })
})

describe('C. 四语言文案', () => {
  it('「没有可选的相机」四个目录都有，而且都非空', () => {
    const table: Array<[string, string]> = [
      ['zh-CN', zhCN.cameraWallUi.pickNoOption],
      ['en', en.cameraWallUi.pickNoOption],
      ['es', es.cameraWallUi.pickNoOption],
      ['tr', tr.cameraWallUi.pickNoOption]
    ]
    for (const [locale, text] of table) {
      assert.ok(text.trim().length > 0, `${locale} 的 cameraWallUi.pickNoOption 是空的`)
    }
  })

  it('浮层的无障碍名字复用「选择相机 / 更换相机」两条既有词条', () => {
    // 空白格与「已经有一台」的那一格读起来必须是两件事：一个问「放哪台」，
    // 一个问「换成哪台」。新增第二条词条会让同一件事有两个名字。
    assert.match(wall, /pickerLabel[\s\S]*?cameraWallUi\.replaceDevice[\s\S]*?cameraWallUi\.pickDevice/)
  })
})

describe('D. 两步选择（业主 2026-09-21 批「同一相机的不同数据进不同窗口」）', () => {
  it('相机项带 views：点进第二步选内容，已在墙上的 (相机, 视图) 禁用并标出', () => {
    // 组件侧：第二步的渲染、禁用与派发（select 带视图）。
    assert.match(picker, /views\?: readonly CameraPickerViewOption\[\]/)
    assert.match(picker, /function chooseView\(/)
    assert.match(picker, /:disabled="option\.inUse"/)
    assert.match(picker, /data-camera-picker-view/)
    assert.match(picker, /emit\('select', item\.id, option\.mode\)/)
    assert.match(picker, /item\.views !== undefined/, '相机与手填源的一步/两步分支没了')
  })

  it('墙的候选项给每台相机四个视图按钮，并逐组合查重', () => {
    assert.match(wall, /cameraWallUi\.viewInUse/)
    assert.match(wall, /viewsTitle: t\('cameraNvrUi\.menuDisplay'\)/)
    assert.match(wall, /findWallItem\(wall\.model, device\.id, mode\) >= 0/)
    assert.match(wall, /CAMERA_CELL_VIEW_MODES\.map\(/)
    // 手填源照旧一步选中（它只有画面），不会长出第二步。
    assert.match(wall, /name: `\$\{source\.name\}（\$\{t\('cameraWallUi\.manualSuffix'\)\}）`/)
  })
})
