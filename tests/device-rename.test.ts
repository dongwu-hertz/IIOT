/**
 * 设备改名的**落点**：本机那份名字是从设备读回来的，不是先写本地再写设备。
 *
 * WHY THIS FILE EXISTS
 * 这个文件的前身（`tests/rename-rollback.test.ts`）守的是另一条路径：
 * 设备管理页的右键菜单改名**先写本机数据库、再写设备**，设备侧失败时要用同名的那次写入
 * 把本机改回原名。业主 2026-09-18 第 5 条把整棵拓扑树（连同那个右键菜单与重命名对话框）
 * 下架之后，那条路径**不存在了**：改名只剩设备详情页一处，而它是
 *
 *      `config.setDeviceName()`  →  主进程写完设备后 `getInfo()` 刷新缓存名  →  `devices.load()`
 *
 * 也就是「设备侧是唯一真相，本机只是读回来」。这一版守的正是这条新性质：
 *   · 本机名**不能**在设备确认之前被改（一旦分叉，界面会替设备说一句它没说过的话 ——
 *     这是这个仓库最不能出的那类错）；
 *   · 失败时**什么都不写**，只把设备的原文显示出来；
 *   · 成功之后必须把设备列表读回来，否则顶栏/侧栏还停在旧名字上。
 *
 * 这一份是**源码结构**层面的回归闸门。真正的行为证据来自一次真实 Electron 窗口 + 真实
 * 设备的运行：`scripts/video-proof-driver.cjs` 走「设备详情 → 改设备名称 → 保存」，
 * 在设备离线时故意让它失败，然后读回本机数据库证明名字**没有**变。那一次的记录在轮次报告里。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

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

/** `renameDevice()` 的函数体（从签名到 `webUiAddress` 那一段之前）。 */
function renameDeviceBody(view: string): string {
  const start = view.indexOf('async function renameDevice')
  assert.ok(start >= 0, 'DeviceDetailView.vue 里没有 renameDevice()')
  const end = view.indexOf('const webUiAddress', start)
  return view.slice(start, end > start ? end : undefined)
}

describe('设备改名的落点（设备详情页）', () => {
  const body = renameDeviceBody(code('src/renderer/src/views/DeviceDetailView.vue'))

  it('只写设备，不写本机数据库（本机名是读回来的）', () => {
    // 本机那条写入是 `devices.update({ id, name })`。它一旦回来，就说明本机名能在设备
    // 拒绝之后留在新名字上 —— 那正是这个文件存在的理由。
    assert.equal(
      /devices\.update\(/.test(body),
      false,
      'DeviceDetailView 往本地数据库写名字了：本机名会与设备的真实名字分叉'
    )
    assert.ok(body.includes('config.setDeviceName'), '设备改名没有写到设备上')
  })

  it('空名字在写设备之前就被拦下（不把空串发给设备）', () => {
    const guard = body.indexOf('nameRequired')
    const write = body.indexOf('config.setDeviceName')
    assert.ok(guard >= 0, '没有拦空名字的提示')
    assert.ok(write > guard, '空名字的判断排在写设备之后：空名字会被发到设备上')
  })

  it('失败时只把设备的原文显示出来，不做任何写入', () => {
    assert.match(
      body,
      /if \(!saved\) \{[\s\S]*actionError\.value = config\.error \|\| t\(/,
      '设备侧失败之后没有把设备的原文显示出来'
    )
    // 失败分支里必须**直接**结束：任何写回都属于"替设备说了一句它没说过的话"。
    const failure = body.slice(body.indexOf('if (!saved)'), body.indexOf('devices.load()'))
    assert.equal(
      /devices\.update\(|config\.setDeviceName/.test(failure),
      false,
      '失败分支里又发生了一次写入'
    )
  })

  it('成功之后把设备列表读回来（顶栏/侧栏不能停在旧名字上）', () => {
    const saved = body.indexOf('if (!saved)')
    const load = body.indexOf('devices.load()')
    assert.ok(load > saved, '成功之后没有重新读取设备列表')
  })

  it('成功提示走目录键，不是硬编码的界面文字', () => {
    assert.match(body, /nameNotice\.value = t\('deviceDetailUi\.nameSaved'\)/, '成功提示不是目录键')
    assert.match(body, /t\('deviceDetailUi\.nameSaveFailed'\)/, '失败提示不是目录键')
  })
})
