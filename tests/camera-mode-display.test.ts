/**
 * 相机检测模式的「直接显示」源码守卫（业主 2026-11-11）。
 *
 * 现象：相机模式切换后，软件上好像没有直接显示。根因不是没读 `work_mode`，而是：
 *   - 实时布局里模式下拉藏在「相机控制设置」弹窗里，页面上没有一处直接写当前模式；
 *   - `work_mode` 只在进入设备时读一次（为防止轮询读回把 PRPD 卡片闪没），
 *     相机 Web 界面改了模式，软件永远不知道。
 *
 * 修法：设备头直接显示「检测模式: X」徽标；控制面板每 10 秒 + 窗口聚焦时重读
 * `work_mode`；不一致弹窗增加「使用相机当前模式」一键同步。轮询只更新设备事实，
 * 不直接切换分析卡（原有稳定性设计保留）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { zhTW } from '../src/shared/i18n/messages/zh-TW'
import { en } from '../src/shared/i18n/messages/en'
import { ru } from '../src/shared/i18n/messages/ru'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const projectRoot = path.resolve(__dirname, '..', '..')
function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

const panel = read('src/renderer/src/components/CameraControlPanel.vue')
const monitor = read('src/renderer/src/views/MonitorView.vue')

describe('相机检测模式：直接显示与外部切换的发现', () => {
  it('实时监测页设备头直接显示相机当前模式徽标', () => {
    assert.match(monitor, /data-camera-work-mode-badge/)
    assert.match(monitor, /const cameraActualWorkMode = computed/)
    // 徽标文案来自检测模式词条 + 模式译名，不是只靠分析卡标题暗示。
    assert.match(monitor, /cameraControlUi\.detectionModeLabel/)
    assert.match(monitor, /cameraDetectionModeText\(cameraActualWorkMode\)/)
  })

  it('模式不一致弹窗可以一键采用相机当前模式', () => {
    assert.match(monitor, /function adoptCameraWorkMode\(\): void/)
    assert.match(monitor, /modeMismatchAdopt/)
    assert.match(monitor, /dismissedCameraMismatchKey/)
    // 关掉后同一条不一致不得每 10 秒重新弹窗。
    assert.match(monitor, /cameraModeMismatchKey\(/)
  })

  it('控制面板每 10 秒 / 窗口重新聚焦时重读 work_mode，刷新按钮也强制重读', () => {
    assert.match(panel, /const WORK_MODE_POLL_MS = 10_000/)
    assert.match(
      panel,
      /window\.setInterval\(\(\)\s*=>\s*\{[\s\S]{0,160}refreshWorkMode\(props\.deviceId,\s*true\)/
    )
    assert.match(panel, /window\.addEventListener\('focus',\s*onWindowFocus\)/)
    assert.match(panel, /@click="reload"/)
    assert.match(
      panel,
      /async function reload\(\): Promise<void> \{[\s\S]{0,160}refreshWorkMode\(props\.deviceId,\s*true\)/
    )
  })

  it('普通 load() 仍不读 work_mode（保住「轮询不闪分析卡」的原设计）', () => {
    const start = panel.indexOf('async function load(): Promise<void> {')
    const end = panel.indexOf('onMounted(async () => {', start)
    assert.ok(start >= 0 && end > start, 'load() 与 onMounted 必须都能找到')
    assert.ok(
      !panel.slice(start, end).includes('readWorkMode'),
      'load() 不得偷偷重读 work_mode；只有 refreshWorkMode(force) 与 reload() 可以'
    )
  })

  it('六语言都有「使用相机当前模式」词条', () => {
    const catalogues = { 'zh-CN': zhCN, 'zh-TW': zhTW, en, ru, es, tr }
    for (const [name, catalogue] of Object.entries(catalogues)) {
      const value = (catalogue as { cameraControlUi?: { modeMismatchAdopt?: unknown } })
        .cameraControlUi?.modeMismatchAdopt
      assert.equal(typeof value, 'string', `${name} 缺 cameraControlUi.modeMismatchAdopt`)
      assert.ok(String(value).trim().length > 0, `${name} 的 modeMismatchAdopt 不能为空`)
    }
  })
})