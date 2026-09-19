/**
 * 「实时监测选中设备就默认开始接收数据」（业主 2026-09-19 第 13 批第 3 条）。
 *
 * WHY THIS FILE EXISTS
 * 这一条看起来只是"删掉一个按钮 + 自动 start 一次"，其实是这一批里最容易出事的一条：
 *
 *   1. **按钮删掉之后没有退路。** 改造前会话开不起来，操作员还能按一下「开始监测」；
 *      删掉之后自动开始漏掉任何一条路径（进页面 / 换设备 / 设备刚上线），
 *      他就只剩刷新页面这一条路。
 *   2. **"已经在跑"不等于"这台设备已经在跑"。** `MonitorView` 切设备是
 *      "先 `selectDevice()` 再 `start()`"，而 store 的 `state` 直到 `start()` 内部跑起来
 *      才变成 `starting`。只看会话状态的话，从 A 切到 B 读到的还是 A 的 `running`，
 *      判定会回一句"已经在跑了"——新设备永远开不起来。所以判定必须同时看
 *      **会话对着哪台设备**（`sessionDeviceId`）。
 *   3. **不能比原来更保守。** 设备状态是本机探活的结果，可能慢一拍；如果拿"必须 ONLINE"
 *      当第一次尝试的门槛，一台其实是好的、只是状态还没刷新的设备会表现成一片空白。
 *      所以第一次永远试，只有**已经失败过**才看在线状态。
 *
 * 判定因此是纯函数（`@shared/domain/monitor-autostart.ts`，可以逐条钉死），
 * 这一份同时钉住界面那一侧的三条调用路径与"按钮真的没了"（对**去注释**的源码断言，
 * 因为这一轮的注释里点名写了那个按钮）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  decideMonitorAutoStart,
  MONITOR_AUTOSTART_MAX_ATTEMPTS,
  type MonitorAutoStartInput
} from '../src/shared/domain/monitor-autostart'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 去注释那一份源码：反向断言必须读它（注释里点名写了被删掉的按钮与词条）。 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const MONITOR_VIEW = 'src/renderer/src/views/MonitorView.vue'

const CATALOGUES: Record<string, { monitorUi: Record<string, unknown> }> = {
  'zh-CN': zhCN as unknown as { monitorUi: Record<string, unknown> },
  en: en as unknown as { monitorUi: Record<string, unknown> },
  es: es as unknown as { monitorUi: Record<string, unknown> },
  tr: tr as unknown as { monitorUi: Record<string, unknown> }
}

/** `noUncheckedIndexedAccess` 下按下标取值会是 `T | undefined`，这里收一处。 */
function monitorUi(locale: string): Record<string, unknown> {
  return (CATALOGUES[locale] as { monitorUi: Record<string, unknown> }).monitorUi
}

/** 一台**在线**的声纹设备、会话还停着、这一次页面停留里还没试过。 */
function world(overrides: Partial<MonitorAutoStartInput> = {}): MonitorAutoStartInput {
  return {
    hasLiveStream: true,
    deviceId: 'dev-1',
    deviceStatus: 'ONLINE',
    sessionState: 'idle',
    sessionDeviceId: '',
    attempts: 0,
    ...overrides
  }
}

describe('该不该自动开始接收数据', () => {
  it('进页面、设备在线、会话停着 → 开始', () => {
    assert.deepEqual(decideMonitorAutoStart(world()), { action: 'start', reason: null })
  })

  it('相机 / 声呐那一支没有这条流 → 不动（绝不硬开 /features_stream）', () => {
    const decision = decideMonitorAutoStart(world({ hasLiveStream: false }))
    assert.equal(decision.action, 'skip')
    assert.equal(decision.reason, 'no-stream')
  })

  it('没有选中设备 → 不动（页面自己会显示"请先添加设备"）', () => {
    assert.deepEqual(decideMonitorAutoStart(world({ deviceId: '' })), {
      action: 'skip',
      reason: 'no-device'
    })
  })

  it('这台设备已经在跑 → 不动（挡住重复 start，也就挡住了无谓的断流）', () => {
    for (const sessionState of ['running', 'starting'] as const) {
      assert.deepEqual(
        decideMonitorAutoStart(world({ sessionState, sessionDeviceId: 'dev-1' })),
        { action: 'skip', reason: 'already-live' }
      )
    }
  })

  it('会话在跑但对着**另一台**设备 → 还是要开始（换设备那一瞬间的真实状态）', () => {
    // 这正是第 2 条 WHY：切设备时 store 的 state 还是上一台的 `running`。
    const decision = decideMonitorAutoStart(
      world({ sessionState: 'running', sessionDeviceId: 'dev-OLD', deviceId: 'dev-NEW' })
    )
    assert.deepEqual(decision, { action: 'start', reason: null })
  })

  it('第一次永远试，不看在线状态（状态可能慢一拍，按钮已经没了）', () => {
    for (const deviceStatus of ['ONLINE', 'OFFLINE', 'UNKNOWN']) {
      assert.equal(decideMonitorAutoStart(world({ deviceStatus })).action, 'start')
    }
  })

  it('已经失败过一次 + 设备离线 → 先不开（那一次连接只会再超时一遍）', () => {
    for (const deviceStatus of ['OFFLINE', 'UNKNOWN']) {
      assert.deepEqual(decideMonitorAutoStart(world({ deviceStatus, attempts: 1 })), {
        action: 'skip',
        reason: 'device-offline'
      })
    }
  })

  it('已经失败过一次但设备在线 → 继续试（这就是"设备刚上线"那一支）', () => {
    assert.equal(decideMonitorAutoStart(world({ attempts: 1 })).action, 'start')
  })

  it('试满上限 → 不再重试（离线设备上的重试循环就是一条日志洪水）', () => {
    const decision = decideMonitorAutoStart(
      world({ attempts: MONITOR_AUTOSTART_MAX_ATTEMPTS, deviceStatus: 'ONLINE' })
    )
    assert.deepEqual(decision, { action: 'skip', reason: 'attempts-exhausted' })
    // 上限是 3：够"一次失败 + 两次状态变化带来的重试"，再多只是刷日志。
    assert.equal(MONITOR_AUTOSTART_MAX_ATTEMPTS, 3)
  })

  it('会话出错（error）也算"还没在跑"，允许再试一次', () => {
    assert.equal(
      decideMonitorAutoStart(world({ sessionState: 'error', attempts: 1 })).action,
      'start'
    )
  })
})

describe('实时监测页的三条调用路径', () => {
  const code = stripComments(read(MONITOR_VIEW))

  it('有一条共用的自动开始（判定来自共享纯函数）', () => {
    assert.match(code, /async function autoStartSessionIfNeeded\(\): Promise<void>/)
    assert.match(code, /decideMonitorAutoStart\(\{/)
    // 三个输入都必须喂进去：会话状态、**会话对着哪台设备**、已经试过几次。
    assert.match(code, /sessionState: monitor\.state/)
    assert.match(code, /sessionDeviceId: monitor\.deviceId/)
    assert.match(code, /attempts: autoStartAttempts\.value/)
  })

  it('① 进页面（mount）就调它', () => {
    assert.match(code, /await autoStartSessionIfNeeded\(\)/)
  })

  it('② 换设备也调它，而且不再写成"只有上一支在跑才 start"', () => {
    // 反向断言：`if (live) await startSession()` 正是从相机切回声纹设备时不开流的原因。
    assert.ok(
      !/if \(live\) await startSession\(\)/.test(code),
      '换设备那一支不能再按"上一支在不在跑"决定要不要开流'
    )
    assert.match(code, /resetAutoStartAttempts\(\)/)
  })

  it('③ 设备刚上线会再问一次判定（尝试计数清零）', () => {
    assert.match(code, /watch\(\s*\(\) => selectedDevice\.value\?\.status/)
    assert.match(code, /status !== 'ONLINE' \|\| previous === 'ONLINE'/)
  })
})

describe('「开始监测 / 停止监测」按钮已经删掉', () => {
  const code = stripComments(read(MONITOR_VIEW))

  it('模板里没有那个按钮，也没有它的处理函数', () => {
    assert.ok(!code.includes('toggleSession'), 'toggleSession 应该连函数一起删掉')
    // 注意用带引号的键名：`t('monitorUi.startRecording')` 里也含 `monitorUi.start`。
    assert.ok(!code.includes("t('monitorUi.start')"), 'monitorUi.start 已经没有任何引用')
    assert.ok(!code.includes("t('monitorUi.stop')"), 'monitorUi.stop 已经没有任何引用')
    // `stopRecording` / `startRecording` 是**另一件事**（音频条上的录音按钮），必须还在。
    assert.ok(code.includes("t('monitorUi.startRecording')"))
    assert.ok(code.includes("t('monitorUi.stopRecording')"))
  })

  it('会话状态本身仍然显示（删的是按钮，不是状态）', () => {
    assert.match(code, /sessionLabel/)
    assert.match(code, /monitorUi\.sessionRunning/)
  })

  it('四本目录里的 start / stop 两个词条一起删掉（死键会让下一次审计读不出"没人用的"）', () => {
    for (const locale of Object.keys(CATALOGUES)) {
      const ui = monitorUi(locale)
      assert.equal(ui.start, undefined, `${locale}.monitorUi.start 应该已删除`)
      assert.equal(ui.stop, undefined, `${locale}.monitorUi.stop 应该已删除`)
      // 录音那一对是**另一件事**，不能顺手删掉。
      assert.equal(typeof ui.startRecording, 'string', `${locale} 少了 startRecording`)
      assert.equal(typeof ui.stopRecording, 'string', `${locale} 少了 stopRecording`)
    }
  })
})
