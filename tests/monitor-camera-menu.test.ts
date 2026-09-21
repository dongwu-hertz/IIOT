/**
 * ⑤ 相机那一支：16:9 视频窗口、右键与总览一致、最多两通道（2026-09-17 第二批第 6 轮）。
 *
 * WHY THIS FILE EXISTS
 * 这三件事里有两件是**结构**问题，而结构问题不会报错，只会悄悄退化：
 *
 *   1. **16:9 窗口**：如果 `aspect-ratio` 被删掉，画面会退回"跟着卡片高度变形的黑布"，
 *      页面照样能看，只是比例错了 —— 所以它必须有一条源码守卫。
 *   2. **右键一致**：两处的菜单项都来自纯函数 `buildCameraNvrMenu()`，但**能力声明**
 *      在各自组件里。少声明一项就会少一整项菜单（`visible` 决定存在），而界面上
 *      "少了一项"与"这台设备不支持"长得一样。所以这里把两处的能力**对出来**，
 *      并断言 `MonitorView` 的 `onMenuSelect()` 覆盖了模型能发出的**每一个** action。
 *
 * 第三件事（最多两通道）在手册里**查不到**：`docs/reference/FA371-manual-en.txt` 没有
 * 任何双通道/双镜头说明。所以这里没有断言，而是把它记进 `docs/UI-VERIFY.md` 的问题清单
 * （手册未说明的不编）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  buildCameraNvrMenu,
  type CameraNvrCapabilities,
  type CameraNvrEnvironment
} from '../src/shared/domain/camera-nvr'
import type { CameraLiveState } from '../src/shared/domain/camera-live'

/** 编译产物在 `.test-build/tests/`，所以要往上两级才是仓库根（与 `page-layout.test.ts` 一致）。 */
const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 去掉注释：注释里会提到选择器与类名，注释不是生效的代码。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * `MonitorView` 声明的能力。
 *
 * 刻意**不 import**：`capabilities` 写在 `.vue` 的 `<script setup>` 里，node 里 import
 * 不了 `.vue`。所以这里读它的源码，但只读**字面量**那一部分，并且逐个 key 断言它们在
 * 源码里写成什么 —— 一旦那段代码被改名/搬走，守卫会失败而不是静默跳过。
 *
 * `liveVideo` / `alarmModel` 的值是 `isCamera.value`（跟着机型走），所以它们只有在
 * 选中一台相机时才是 `true`：这正是下面构造环境时用的那一组。
 */
function assertMonitorCapabilities(source: string): CameraNvrCapabilities {
  const block = source.slice(
    source.indexOf('capabilities: {'),
    source.indexOf('}))', source.indexOf('capabilities: {'))
  )
  assert.ok(block.length > 0, '读不到 MonitorView 的能力声明')
  assert.match(block, /liveVideo:\s*isCamera\.value/, '实时视频能力没有跟着机型走')
  assert.match(block, /alarmModel:\s*isCamera\.value/, '告警模型能力没有跟着机型走')
  assert.match(block, /localPlayback:\s*true/, '没有声明本机回放能力（菜单里会少一整项）')
  assert.match(block, /detectDownload:\s*true/, '没有声明检测记录下载能力（菜单里会少一整项）')
  /*
   * `tileClose` **故意不声明**：那是画面墙的"清空这一格"，这一页只有一路画面，
   * 停止它是页头那颗按钮的事。这里断言的是"差异是刻意的"，不是"忘了写"。
   */
  assert.equal(/tileClose:/.test(block), false, '声明了 tileClose：这一页没有格可清')
  // 选中一台相机时模型看到的那一组能力。
  return { liveVideo: true, alarmModel: true, localPlayback: true, detectDownload: true }
}

const MONITOR = stripComments(read('src/renderer/src/views/MonitorView.vue'))
const WALL = stripComments(read('src/renderer/src/components/CameraVideoWall.vue'))

function playing(): CameraLiveState {
  return {
    deviceId: 'cam-1',
    status: 'playing',
    url: 'http://127.0.0.1:9/t/stream.mp4',
    rtspUrl: 'rtsp://192.168.110.235:443/live'
  }
}

function envWith(capabilities: CameraNvrCapabilities): CameraNvrEnvironment {
  return {
    deviceName: '相机 A',
    recording: false,
    fullscreen: false,
    hasUsableSource: true,
    capabilities
  }
}

describe('⑤ 右键菜单与总览一致（同一份模型 + 同一批能力）', () => {
  it('两处都用 `buildCameraNvrMenu()`，没有第二份菜单表', () => {
    for (const [label, source] of [
      ['实时监测页', MONITOR],
      ['画面墙', WALL]
    ] as const) {
      assert.ok(source.includes('buildCameraNvrMenu('), `${label} 没有再走那个纯函数`)
    }
  })

  it('MonitorView 声明了本机回放与检测记录下载（否则整项菜单会消失）', () => {
    const capabilities = assertMonitorCapabilities(MONITOR)
    assert.equal(capabilities.localPlayback, true)
    assert.equal(capabilities.detectDownload, true)
  })

  it('同一台正在播放的相机：两处的菜单只差「清空这一格」与「显示方式」', () => {
    const monitorActions = buildCameraNvrMenu(
      playing(),
      envWith(assertMonitorCapabilities(MONITOR))
    ).map((item) => item.action)
    const wallActions = buildCameraNvrMenu(
      playing(),
      envWith({
        liveVideo: true,
        alarmModel: true,
        localPlayback: true,
        detectDownload: true,
        tileClose: true,
        // 画面墙比这一页多声明的一项（见下一条断言）。
        cellViews: true
      })
    ).map((item) => item.action)

    /*
     * 两处刻意不同的两项：
     *   · `close-tile` —— 这一页只有一路画面，停止它是页头那颗按钮的事；
     *   · `display`    —— 四种视图（播放 / 时域图 / 频域图 / 时频谱图）是**画面格**的东西
     *                     （业主 2026-09-18 第 10 批第 2 条要的是"视频墙"上的四种画法），
     *                     这一页有它自己的一套声学面板，没有"这一格画什么"。第 12 批把
     *                     那四颗按钮从控制条移进这个子菜单之后，它仍然是画面墙独有的。
     */
    assert.deepEqual(
      wallActions.filter((action) => action !== 'close-tile' && action !== 'display'),
      monitorActions,
      '实时监测页的右键项与画面墙不一致（除了刻意不同的「清空这一格」与「显示方式」）'
    )
    assert.equal(wallActions.includes('display'), true, '画面墙的菜单里没有「显示方式」')
    assert.equal(
      monitorActions.includes('display'),
      false,
      '实时监测页声明了「显示方式」：这一页没有画面格，那四项点了不会有反应'
    )
    assert.equal(monitorActions.includes('playback'), true, '菜单里没有本机回放')
    assert.equal(monitorActions.includes('download-detect'), true, '菜单里没有检测记录下载')
    // 设备侧动作永远排最后（模型自己的硬规则，这里顺带钉一次调用点的结果）。
    assert.equal(monitorActions[monitorActions.length - 1], 'alarm-config')
  })

  it('模型能发出的每一个 action 都有派发分支（少一个就是一项点了没反应）', () => {
    const switchBody = MONITOR.slice(
      MONITOR.indexOf('async function onMenuSelect'),
      MONITOR.indexOf('离开画面时把正在进行的录像正式收尾')
    )
    assert.ok(switchBody.length > 0, '读不到 onMenuSelect() 的函数体')
    const actions = buildCameraNvrMenu(playing(), envWith(assertMonitorCapabilities(MONITOR)))
    for (const item of actions) {
      // `capture` 是二级菜单的父项：它自己不执行动作（模型里就没给它动作语义）。
      if (item.action === 'capture') continue
      assert.ok(
        switchBody.includes(`case '${item.action}':`),
        `${item.action} 没有派发分支（菜单项点了不会有反应）`
      )
    }
  })

  it('两块弹窗与画面墙用的是同一对组件（不是两套相似实现）', () => {
    for (const component of ['CameraRecordingPlaybackDialog', 'CameraDetectDownloadDialog']) {
      assert.ok(MONITOR.includes(`import ${component} from`), `实时监测页没有引入 ${component}`)
      assert.ok(MONITOR.includes(`<${component}`), `实时监测页没有渲染 ${component}`)
      assert.ok(WALL.includes(`<${component}`), `画面墙没有渲染 ${component}（两处应当共用）`)
    }
    // 下载完成 → 接着回放这条闭环也要在（否则"下载完还要自己去找"）。
    assert.ok(MONITOR.includes('@play="onDownloadedPlay"'), '下载弹窗没有接回放闭环')
    assert.ok(MONITOR.includes('openPlaybackDialog(recordingId)'), '闭环没有真的打开回放')
  })
})

describe('⑤ 16:9 视频窗口', () => {
  it('舞台用 aspect-ratio 16/9，而不是跟着卡片高度变形', () => {
    const stage = MONITOR.slice(
      MONITOR.indexOf('.camera-live__stage {'),
      MONITOR.indexOf('}', MONITOR.indexOf('.camera-live__stage {'))
    )
    assert.match(stage, /aspect-ratio:\s*16\s*\/\s*9/, '画面窗口不是 16:9')
    assert.equal(
      /min-height:\s*320px/.test(MONITOR),
      false,
      '旧的 min-height 320px 还在（它会让窗口比例由内容决定）'
    )
  })

  it('高度上限**只压宽度**（压高度会把 16:9 破坏掉）', () => {
    const stage = MONITOR.slice(
      MONITOR.indexOf('.camera-live__stage {'),
      MONITOR.indexOf('}', MONITOR.indexOf('.camera-live__stage {'))
    )
    assert.match(stage, /max-width:\s*calc\(72vh \* 16 \/ 9\)/, '没有按比例的高度限制')
    assert.equal(/max-height/.test(stage), false, '舞台自己用了 max-height（比例会被压坏）')
  })

  it('视频用 object-fit: contain 填满窗口（黑边来自留白，不是拉伸）', () => {
    const video = MONITOR.slice(
      MONITOR.indexOf('.camera-live__video {'),
      MONITOR.indexOf('}', MONITOR.indexOf('.camera-live__video {'))
    )
    assert.match(video, /width:\s*100%/, '视频没有填满窗口宽度')
    assert.match(video, /height:\s*100%/, '视频没有填满窗口高度')
    assert.match(video, /object-fit:\s*contain/, '视频没有 object-fit: contain')
  })

  it('全屏时比例交还给屏幕（否则全屏画面会保持 16:9 留两条黑边）', () => {
    const fullscreen = MONITOR.slice(
      MONITOR.indexOf('.camera-live__stage--fullscreen {'),
      MONITOR.indexOf('}', MONITOR.indexOf('.camera-live__stage--fullscreen {'))
    )
    assert.match(fullscreen, /width:\s*100vw/, '全屏没有铺满宽度')
    assert.match(fullscreen, /height:\s*100vh/, '全屏没有铺满高度')
    assert.match(fullscreen, /aspect-ratio:\s*auto/, '全屏没有把 16:9 交还给屏幕')
    assert.match(fullscreen, /max-width:\s*none/, '全屏还带着 16:9 的宽度上限')
  })
})
