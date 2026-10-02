/**
 * S1 界面收尾的源码守卫：连续录像开关 + 状态行。
 *
 * WHY THIS FILE EXISTS
 * 内核、IPC 和探针都已经做过；这一步补的是操作员唯一能看见的入口。它最容易
 * 在后续改版里悄悄消失或退化（比如把 waiting/backoff 又合并成一句「已开启」，
 * 或者组件还在但页面不再渲染），所以这里把两个事实钉住：
 *   - 组件读的是 `window.api.recorder.*`，且四种运行态逐条显示；
 *   - MonitorView 只在相机分支渲染它。
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

const component = read('src/renderer/src/components/CameraRecorderBar.vue')
const monitor = read('src/renderer/src/views/MonitorView.vue')

const KEYS = [
  'title',
  'enable',
  'disable',
  'working',
  'statusOff',
  'statusStarting',
  'statusRecording',
  'statusWaiting',
  'statusBackoff',
  'notRunning',
  'registered',
  'segmentLength',
  'lastError',
  'hint'
] as const

const CATALOGUES = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en,
  ru,
  es,
  tr
} as const

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort()
}

describe('S1 连续录像界面', () => {
  it('组件用 recorder IPC，且四种运行态逐条显示、不合成「已开启」', () => {
    assert.match(component, /window\.api\.recorder\.status\(\)/)
    assert.match(component, /window\.api\.recorder\.setEnabled\(/)
    assert.ok(component.includes("case 'starting'"), 'missing starting state branch')
    assert.ok(component.includes("case 'recording'"), 'missing recording state branch')
    assert.ok(component.includes("case 'waiting'"), 'missing waiting state branch')
    assert.ok(component.includes("case 'backoff'"), 'missing backoff state branch')
    assert.ok(component.includes("'not-running'"), 'missing requested-but-not-running state')
    assert.ok(component.includes('data-action="recorder-toggle"'), 'toggle is not probeable')
    assert.ok(component.includes('data-recorder-status'), 'status line is not probeable')
    assert.ok(component.includes(':data-recorder-state="uiState"'), 'state attribute is missing')
    assert.ok(component.includes('setInterval'), 'status polling is missing')
  })

  it('MonitorView 只在相机分支里渲染这个组件', () => {
    assert.ok(
      monitor.includes("import CameraRecorderBar from '@renderer/components/CameraRecorderBar.vue'"),
      'MonitorView does not import the recorder bar'
    )
    assert.ok(
      monitor.includes('<CameraRecorderBar :device-id="selectedDeviceId" />'),
      'MonitorView does not render the recorder bar'
    )
  })

  it('六语言都有 recorderUi 文案，且同名占位符集合一致', () => {
    const baseline = (CATALOGUES['zh-CN'] as { recorderUi?: Record<string, string> }).recorderUi
    assert.ok(baseline, 'zh-CN is missing recorderUi')

    for (const key of KEYS) {
      assert.equal(typeof baseline[key], 'string', `zh-CN recorderUi.${key} is missing`)
    }

    for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
      const block = (catalogue as { recorderUi: Record<string, string> }).recorderUi
      assert.ok(block, `${locale} is missing recorderUi`)
      for (const key of KEYS) {
        const value: string = block[key] ?? ''
        assert.equal(typeof value, 'string', `${locale} recorderUi.${key} is missing`)
        assert.equal(
          placeholders(value).join(','),
          placeholders(baseline[key] ?? '').join(','),
          `${locale} recorderUi.${key} placeholder mismatch`
        )
        assert.equal(value.includes('@'), false, `${locale} recorderUi.${key} contains @`)
      }
    }
  })
})