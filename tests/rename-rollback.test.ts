/**
 * 声纹设备改名的**回滚**：本机那一半不能停在设备不认的名字上。
 *
 * WHY THIS FILE EXISTS
 * 改名有两个落点：本机数据库（先写）与设备自身（后写）。设备侧失败时，旧实现只把设备的
 * 错误显示出来，本机那一半**留在新名字上** —— 树的显示与设备的真实名字从此不一致，而
 * 旁边的注释还写着「如实说明改到哪一半」。这一条是这个仓库最不能出的那类错：界面替设备
 * 说了一句它没说过的话。
 *
 * 现在失败时会用同名的那条写入把本机改回原名，并把「设备的原文 + 本机已恢复」一起说清。
 *
 * 分工（与 `devices-round.test.ts` 的文件头同一条规矩）
 * 这一份是**源码结构**层面的回归闸门：回滚那两步一旦被下一次改动删掉，任何单元都不会
 * 变红，所以这里把结构钉住（注释已剥掉，避免被一句正确的文档蒙过去）。
 * 真正的行为证据来自一次**真实 Electron 窗口 + 真实设备**的运行：
 * `scripts/video-proof-driver.cjs` 会走「右键 → 修改设备名称 → 保存」，并故意让设备侧
 * 写入失败，然后读回本机数据库证明名字回到了原值。那一次的记录在轮次报告里。
 *
 * 中文注释是仓库约定（见 tests/channel-state.test.ts）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'
import type { MessageSchema } from '../src/shared/i18n/schema'

const projectRoot = path.resolve(__dirname, '..', '..')

/** 去掉注释后的源码（`<!-- -->`、块注释、`//`），断言的是代码不是散文。 */
function code(relative: string): string {
  const source = fs.readFileSync(path.join(projectRoot, relative), 'utf8')
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('*'))
    })
    .join('\n')
}

/** `renameDeviceName()` 的函数体（从签名到 `renameChannelName` 之前）。 */
function renameDeviceBody(view: string): string {
  const start = view.indexOf('async function renameDeviceName')
  assert.ok(start >= 0, 'DevicesView.vue 里没有 renameDeviceName()')
  const end = view.indexOf('async function renameChannelName', start)
  return view.slice(start, end > start ? end : undefined)
}

const CATALOGUES: Record<string, MessageSchema> = { 'zh-CN': zhCN, en, es, tr }

describe('声纹设备改名的回滚', () => {
  const body = renameDeviceBody(code('src/renderer/src/views/DevicesView.vue'))

  it('写入之前先把本机原名取下来（store 一改，计算属性就是新名字了）', () => {
    // 原值必须在 `devices.update` **之前**读出来，否则回滚时拿到的是刚写进去的新名字，
    // 回滚会变成一次空操作。
    const capture = body.indexOf('previousLocalName')
    const firstUpdate = body.indexOf('devices.update')
    assert.ok(capture >= 0, '没有保存本机原名')
    assert.ok(firstUpdate > capture, '本机原名是在写入之后才取的：回滚会写回新名字')
  })

  it('设备侧失败时把本机那一条改回原名', () => {
    // 设备侧被拒的那一段：`!result.success` 之后必须再写一次本机数据库，写的是原名。
    assert.match(
      body,
      /if \(!result\.success\) \{[\s\S]*devices\.update\(\{ id: device\.id, name: previousLocalName \}\)/,
      '设备侧失败之后没有把本机名字改回去'
    )
  })

  it('回滚成功与回滚失败说的话是两条，不混成一句「失败」', () => {
    assert.match(body, /renameError\.value = t\('deviceRename\.renameBoxRestored'/)
    assert.match(body, /renameError\.value = t\('deviceRename\.renameBoxRestoreFailed'/)
    // 回滚也失败时必须**不**报成「已恢复」。
    const restored = body.indexOf("deviceRename.renameBoxRestored")
    const restoreFailed = body.indexOf("deviceRename.renameBoxRestoreFailed")
    assert.ok(restoreFailed >= 0 && restored > restoreFailed, '两条分支的顺序反了')
  })

  it('设备侧写入只在声纹设备分支里发生（相机的落点仍然只有本机）', () => {
    assert.match(body, /if \(device\.kind === 'acousticBox'\)/)
    const calls = body.match(/config\.setDeviceName/g) ?? []
    assert.equal(calls.length, 1, `config.setDeviceName 出现 ${calls.length} 次，应为 1（只在声纹设备分支里）`)
    const branch = body.indexOf("device.kind === 'acousticBox'")
    const call = body.indexOf('config.setDeviceName')
    assert.ok(call > branch, 'config.setDeviceName 出现在声纹设备判断之前')
  })

  it('四种语言都说了「本机已恢复」与「本机没能恢复」两件事', () => {
    for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
      const restored = catalogue.deviceRename.renameBoxRestored
      const failed = catalogue.deviceRename.renameBoxRestoreFailed
      assert.equal(typeof restored, 'string', `${locale} 缺少 renameBoxRestored`)
      assert.equal(typeof failed, 'string', `${locale} 缺少 renameBoxRestoreFailed`)
      // 两条都必须带上设备的原文与名字，而且不能含裸 `@`（目录规矩）。
      for (const message of [restored, failed]) {
        assert.match(message, /\{reason\}/, `${locale} 的一条回滚文案没有设备的原文`)
        assert.match(message, /\{name\}/, `${locale} 的一条回滚文案没有名字`)
        assert.equal(message.includes('@'), false, `${locale} 的回滚文案含裸 @`)
      }
    }
  })
})
